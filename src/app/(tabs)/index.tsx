import { useCallback, useEffect, useRef, useState } from 'react';

import {
  AppState,

  Pressable,

  ScrollView,

  StatusBar,

  Text,

  View,
} from 'react-native';

import type { Permission, RecordType } from 'react-native-health-connect';

import {
  getGrantedPermissions,

  getSdkStatus,

  initialize,

  readRecords,

  requestPermission,

  SdkAvailabilityStatus,
} from 'react-native-health-connect';

import AccuChekBluetooth from '../../components/AccuCheckBluetooth';

import * as Notifications from 'expo-notifications';

import { Alert, Platform } from 'react-native';

import { auth } from '../../services/firebase';

Notifications.setNotificationHandler({

  handleNotification: async () => ({

    shouldShowBanner: true,

    shouldShowList: true,

    shouldPlaySound: true,

    shouldSetBadge: false,

  }),

});

const TYPES: RecordType[] = [

  'Steps',

  'HeartRate',

  'SleepSession',

  'OxygenSaturation',

  'ExerciseSession',

  'TotalCaloriesBurned',

  'ActiveCaloriesBurned',

  'Nutrition',

  'HeartRateVariabilityRmssd',

  'BloodGlucose',

];

const LOOKBACK_DAYS = 14;

const POLL_MS = 30_000;

type AnyRecord = Record<string, any>;

type Dataset = Record<string, AnyRecord[] | { error: string } | undefined>;

const COLORS = {

  background: '#F5F7FB',

  card: '#FFFFFF',

  text: '#172033',

  muted: '#6B7280',

  accent: '#2563EB',

  border: '#E5EAF2',

  softBlue: '#EAF1FF',

  warning: '#92400E',

};

const TITLES: Record<string, string> = {

  Steps: 'Steps',

  HeartRate: 'Heart rate',

  SleepSession: 'Sleep',

  OxygenSaturation: 'Blood oxygen',

  ExerciseSession: 'Exercise',

  TotalCaloriesBurned: 'Total calories burned',

  ActiveCaloriesBurned: 'Active calories burned',

  Nutrition: 'Food calories',

  HeartRateVariabilityRmssd: 'Heart rate variability',

  BloodGlucose: 'Blood glucose',

};

const ICONS: Record<string, string> = {

  Steps: '👣',

  HeartRate: '❤️',

  SleepSession: '🌙',

  OxygenSaturation: '🫁',

  ExerciseSession: '🏃',

  TotalCaloriesBurned: '🔥',

  ActiveCaloriesBurned: '⚡',

  Nutrition: '🍽️',

  HeartRateVariabilityRmssd: '〰️',

  BloodGlucose: '🩸',

};

// Local development: use your computer's LAN IP. For deployment, set
// EXPO_PUBLIC_API_BASE_URL to your public HTTPS backend URL.
const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://192.168.0.98:8000';

const toIsoTimestamp = (value: unknown): string | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

/**
 * Convert Health Connect records into the canonical rows expected by
 * /predict-from-records. This intentionally sends only fields currently
 * supported by the backend preprocessing pipeline.
 */
const buildPredictionRecords = (dataset: Dataset): AnyRecord[] => {
  const rows: AnyRecord[] = [];

  // Blood glucose: normalize every value to mg/dL.
  for (const record of sortedRecords(dataset.BloodGlucose)) {
    const glucose = getBloodGlucose(record);
    const timestamp = toIsoTimestamp(
      record.time ?? record.startTime ?? record.endTime,
    );
    if (!glucose || !timestamp) continue;

    rows.push({
      timestamp,
      glucose_mg_dL:
        glucose.unit === 'mmol/L' ? glucose.value * 18.0182 : glucose.value,
    });
  }

  // Heart-rate records may contain multiple timestamped samples.
  for (const record of sortedRecords(dataset.HeartRate)) {
    const samples = Array.isArray(record.samples) ? record.samples : [];
    if (samples.length > 0) {
      for (const sample of samples) {
        const timestamp = toIsoTimestamp(sample.time);
        const bpm = Number(sample.beatsPerMinute);
        if (timestamp && Number.isFinite(bpm)) {
          rows.push({ timestamp, HR: bpm });
        }
      }
    } else {
      const timestamp = toIsoTimestamp(record.time ?? record.endTime ?? record.startTime);
      const bpm = Number(record.beatsPerMinute);
      if (timestamp && Number.isFinite(bpm)) rows.push({ timestamp, HR: bpm });
    }
  }

  // Steps records are interval totals. Timestamp them at the interval end
  // when available so they are not incorrectly treated as interval starts.
  for (const record of sortedRecords(dataset.Steps)) {
    const timestamp = toIsoTimestamp(record.endTime ?? record.startTime ?? record.time);
    const steps = Number(record.count ?? record.steps ?? record.value);
    if (timestamp && Number.isFinite(steps)) rows.push({ timestamp, Steps: steps });
  }

  // Nutrition entries may provide energy and macro nutrients. Only add
  // numeric values that are actually present in the Health Connect record.
  for (const record of sortedRecords(dataset.Nutrition)) {
    const timestamp = toIsoTimestamp(record.startTime ?? record.time ?? record.endTime);
    if (!timestamp) continue;

    const row: AnyRecord = { timestamp };
    const calories = getNutritionCalories(record);
    if (calories !== null) row.Calories = calories;

    const nutrients = record.nutrients ?? record;
    const nutrientMap: Record<string, string[]> = {
      Carbs: ['totalCarbohydrate', 'carbohydrate'],
      Protein: ['protein'],
      Fat: ['totalFat', 'fat'],
      Fiber: ['dietaryFiber', 'fiber'],
      Sugar: ['sugar'],
    };

    for (const [feature, candidates] of Object.entries(nutrientMap)) {
      for (const candidate of candidates) {
        const nutrient = nutrients?.[candidate];
        const amount =
          typeof nutrient === 'number'
            ? nutrient
            : nutrient?.inGrams ?? nutrient?.inGrams?.value ?? nutrient?.value;
        if (typeof amount === 'number' && Number.isFinite(amount)) {
          row[feature] = amount;
          break;
        }
      }
    }

    if (Object.keys(row).length > 1) rows.push(row);
  }

  // Active energy is the closest Health Connect field to the model's
  // activity-calorie feature. Total calories are deliberately not mapped
  // to food Calories because they represent a different measurement.
  for (const record of sortedRecords(dataset.ActiveCaloriesBurned)) {
    const timestamp = toIsoTimestamp(record.endTime ?? record.startTime ?? record.time);
    const kcal = getNutritionCalories(record);
    if (timestamp && kcal !== null) {
      rows.push({ timestamp, 'Calories (Activity)': kcal });
    }
  }

  return rows.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
};

const calculateStressFromRmssd = (rmssdMs: number): number => {

  if (!Number.isFinite(rmssdMs) || rmssdMs <= 0) return 0;

  const lnHrv = Math.log(rmssdMs);

  const normalized = (Math.max(2.3, Math.min(5.0, lnHrv)) - 2.3) / (5.0 - 2.3);

  return Math.round((1 - normalized) * 100);

};

const formatTime = (value?: string): string => {

  if (!value) return 'Time unavailable';

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();

};

const getBloodGlucose = (record: AnyRecord): { value: number; unit: 'mg/dL' | 'mmol/L' } | null => {

  const level = record?.level;

  if (typeof level?.inMilligramsPerDeciliter === 'number' && Number.isFinite(level.inMilligramsPerDeciliter)) {

    return { value: level.inMilligramsPerDeciliter, unit: 'mg/dL' };

  }

  if (typeof level?.inMillimolesPerLiter === 'number' && Number.isFinite(level.inMillimolesPerLiter)) {

    return { value: level.inMillimolesPerLiter, unit: 'mmol/L' };

  }

  // Fallbacks accommodate alternate wrapper versions / serialized records.

  if (typeof level === 'number' && Number.isFinite(level)) return { value: level, unit: 'mg/dL' };

  if (typeof record?.glucoseMgDl === 'number') return { value: record.glucoseMgDl, unit: 'mg/dL' };

  if (typeof record?.glucoseMmolL === 'number') return { value: record.glucoseMmolL, unit: 'mmol/L' };

  return null;

};

const getNutritionCalories = (record: AnyRecord): number | null => {

  const kcal = record?.energy?.inKilocalories;

  if (typeof kcal === 'number' && Number.isFinite(kcal)) return kcal;

  const calories = record?.energy?.inCalories;

  if (typeof calories === 'number' && Number.isFinite(calories)) return calories / 1000;

  return null;

};

const getRecordTime = (record: AnyRecord): number => {

  const candidates = [

    record?.time,

    record?.startTime,

    record?.endTime,

    record?.startDateTime,

    record?.metadata?.lastModifiedTime,

  ];

  for (const candidate of candidates) {

    if (typeof candidate === 'string') {

      const parsed = new Date(candidate).getTime();

      if (Number.isFinite(parsed)) return parsed;

    }

  }

  // HeartRate records can contain individual samples with their own timestamps.

  const samples = Array.isArray(record?.samples) ? record.samples : [];

  const lastSample = samples.reduce((latest: number, sample: AnyRecord) => {

    const parsed = new Date(sample?.time ?? '').getTime();

    return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest;

  }, 0);

  return lastSample;

};

const sortedRecords = (value: Dataset[string]): AnyRecord[] =>

  Array.isArray(value)

    ? [...value].sort((a, b) => getRecordTime(b) - getRecordTime(a))

    : [];

const latestHeartRate = (record: AnyRecord): number | null => {

  if (typeof record?.beatsPerMinute === 'number') return record.beatsPerMinute;

  const samples = Array.isArray(record?.samples) ? record.samples : [];

  const latest = [...samples].sort(

    (a, b) => new Date(b?.time ?? 0).getTime() - new Date(a?.time ?? 0).getTime(),

  )[0];

  return typeof latest?.beatsPerMinute === 'number' ? latest.beatsPerMinute : null;

};

const SLEEP_STAGE_NAMES: Record<number, string> = {

  0: 'Unknown',

  1: 'Awake',

  2: 'Asleep (stage unspecified)',

  3: 'Out of bed',

  4: 'Light',

  5: 'Deep',

  6: 'REM',

  7: 'Awake in bed',

};

const getSleepStages = (record: AnyRecord): AnyRecord[] =>

  Array.isArray(record?.stages) ? record.stages : [];

const getSleepStageName = (stage: unknown): string => {

  if (typeof stage === 'number') return SLEEP_STAGE_NAMES[stage] ?? `Unrecognized stage (${stage})`;

  if (typeof stage === 'string') {

    const normalized = stage.toLowerCase();

    const names: Record<string, string> = {

      awake: 'Awake',

      sleeping: 'Asleep (stage unspecified)',

      out_of_bed: 'Out of bed',

      light: 'Light',

      deep: 'Deep',

      rem: 'REM',

      awake_in_bed: 'Awake in bed',

      unknown: 'Unknown',

    };

    return names[normalized] ?? stage;

  }

  return 'Unknown';

};

const getSleepStageDurationMinutes = (stage: AnyRecord): number | null => {

  const start = new Date(stage?.startTime ?? '').getTime();

  const end = new Date(stage?.endTime ?? '').getTime();

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

  return (end - start) / 60000;

};

const formatMinutes = (minutes: number): string =>

  `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m`;

const getSleepStageTotals = (record: AnyRecord): Record<string, number> => {

  const totals: Record<string, number> = {};

  for (const stage of getSleepStages(record)) {

    const name = getSleepStageName(stage?.stage);

    const duration = getSleepStageDurationMinutes(stage);

    if (duration !== null) totals[name] = (totals[name] ?? 0) + duration;

  }

  return totals;

};

const summaryFor = (type: RecordType, record?: AnyRecord): { value: string; detail: string } => {

  if (!record) return { value: 'No recent data', detail: 'No record found in the selected time range' };

  switch (type) {

    case 'Steps': {

      const count = record.count ?? record.steps ?? record.value;

      return { value: typeof count === 'number' ? Math.round(count).toLocaleString() : 'Recorded', detail: 'steps' };

    }

    case 'HeartRate': {

      const bpm = latestHeartRate(record);

      return { value: bpm === null ? 'Recorded' : String(Math.round(bpm)), detail: bpm === null ? 'Heart-rate record' : 'beats per minute (bpm)' };

    }

    case 'OxygenSaturation': {

      const raw = record.percentage?.value ?? record.percentage ?? record.oxygenSaturation;

      const percent = typeof raw === 'number' ? (raw <= 1 ? raw * 100 : raw) : null;

      return { value: percent === null ? 'Recorded' : `${percent.toFixed(1)}%`, detail: 'SpO₂' };

    }

    case 'HeartRateVariabilityRmssd': {

      const hrv = record.heartRateVariabilityMillis;

      const stress = typeof hrv === 'number' && hrv > 0 ? calculateStressFromRmssd(hrv) : null;

      return { value: typeof hrv === 'number' ? `${hrv.toFixed(1)} ms` : 'Recorded', detail: stress === null ? 'RMSSD · stress estimate unavailable' : `RMSSD · experimental stress estimate ${stress}/100` };

    }

    case 'BloodGlucose': {

      const glucose = getBloodGlucose(record);

      return {

        value: glucose ? `${glucose.value.toFixed(glucose.unit === 'mg/dL' ? 0 : 1)} ${glucose.unit}` : 'Recorded',

        detail: 'blood glucose',

      };

    }

    case 'Nutrition': {

      const kcal = getNutritionCalories(record);

      const food = record.name ?? record.mealName ?? 'Food entry';

      return { value: kcal === null ? String(food) : `${Math.round(kcal)} kcal`, detail: String(food) };

    }

    case 'ActiveCaloriesBurned':

    case 'TotalCaloriesBurned': {

      const kcal = getNutritionCalories(record) ?? record.energy?.inKilocalories;

      return { value: typeof kcal === 'number' ? `${Math.round(kcal)} kcal` : 'Recorded', detail: type === 'ActiveCaloriesBurned' ? 'active energy' : 'total energy' };

    }

    case 'SleepSession': {

      const start = new Date(record.startTime ?? '').getTime();

      const end = new Date(record.endTime ?? '').getTime();

      const duration = start && end && end >= start ? Math.round((end - start) / 60000) : null;

      const stages = getSleepStages(record);

      const stageCount = stages.length;

      const stageDetail = stageCount

        ? `${stageCount} sleep stages`

        : 'No stage breakdown returned';

      return {

        value: duration === null ? 'Sleep recorded' : formatMinutes(duration),

        detail: `session duration · ${stageDetail}`,

      };

    }

    case 'ExerciseSession':

      return { value: String(record.title ?? record.exerciseType ?? 'Exercise recorded'), detail: record.startTime ? formatTime(record.startTime) : 'Exercise session' };

    default:

      return { value: 'Recorded', detail: 'Health Connect record' };

  }

};

const recordDetails = (type: RecordType, record: AnyRecord): string[] => {

  const time = formatTime(record.time ?? record.startTime ?? record.startDateTime ?? record.endTime);

  const details = [`Time: ${time}`];

  const summary = summaryFor(type, record);

  details.push(`${summary.value}${summary.detail ? ` · ${summary.detail}` : ''}`);

  if (type === 'HeartRateVariabilityRmssd' && typeof record.heartRateVariabilityMillis === 'number') {

    details.push(`Experimental HRV-derived stress estimate: ${calculateStressFromRmssd(record.heartRateVariabilityMillis)}/100 (not a clinical measurement)`);

  }

  if (type === 'BloodGlucose') {

    const glucose = getBloodGlucose(record);

    if (glucose) details.push(`Glucose: ${glucose.value.toFixed(glucose.unit === 'mg/dL' ? 0 : 1)} ${glucose.unit}`);

    if (record.mealType !== undefined) details.push(`Meal type: ${String(record.mealType)}`);

    if (record.relationToMeal !== undefined) details.push(`Relation to meal: ${String(record.relationToMeal)}`);

    if (record.specimenSource !== undefined) details.push(`Specimen source: ${String(record.specimenSource)}`);

  }

  if (type === 'Nutrition') {

    if (record.mealType !== undefined) details.push(`Meal type: ${String(record.mealType)}`);

    if (record.name || record.mealName) details.push(`Food: ${record.name ?? record.mealName}`);

  }

  if (type === 'HeartRate' && Array.isArray(record.samples)) details.push(`Samples in this record: ${record.samples.length}`);

  if (type === 'SleepSession') {

    const stages = [...getSleepStages(record)].sort(

      (a, b) => new Date(a?.startTime ?? 0).getTime() - new Date(b?.startTime ?? 0).getTime(),

    );

    if (stages.length === 0) {

      details.push('Sleep stages: Health Connect returned no stage breakdown for this session.');

    } else {

      details.push(`Sleep stages returned: ${stages.length}`);

      const totals = getSleepStageTotals(record);

      for (const [name, minutes] of Object.entries(totals)) {

        details.push(`${name} total: ${formatMinutes(minutes)}`);

      }

      stages.forEach((stage, index) => {

        const name = getSleepStageName(stage?.stage);

        const duration = getSleepStageDurationMinutes(stage);

        details.push(

          `Stage ${index + 1}: ${name} · ${formatTime(stage?.startTime)} – ${formatTime(stage?.endTime)}${duration === null ? '' : ` · ${Math.round(duration)} min`}`,

        );

      });

    }

  }

  if (record.startTime && record.endTime) details.push(`Duration: ${formatTime(record.startTime)} – ${formatTime(record.endTime)}`);

  return details;

};

export default function App() {

  const [status, setStatus] = useState('Starting…');

  const [data, setData] = useState<Dataset>({});

  const [lastSync, setLastSync] = useState<string | null>(null);
  const [prediction, setPrediction] = useState<AnyRecord | null>(null);
  const [predictionError, setPredictionError] = useState<string | null>(null);

  const [granted, setGranted] = useState<Permission[]>([]);

  const [selectedType, setSelectedType] = useState<RecordType | null>(null);

  const ready = useRef(false);

  const busy = useRef(false);

  // Testing for nutrition record notification

  const seenNutritionRecords = useRef<Set<string>>(new Set());

  const nutritionInitialized = useRef(false);

  const notificationPermissionGranted = useRef(false);

    const testNotification = async () => {

    try {

      if (Platform.OS === 'android') {

        await Notifications.setNotificationChannelAsync('health-alerts', {

          name: 'Health Alerts',

          importance: Notifications.AndroidImportance.MAX,

          vibrationPattern: [0, 250, 250, 250],

          sound: 'default',

        });

      }

      const { status: existingStatus } =

        await Notifications.getPermissionsAsync();

      let finalStatus = existingStatus;

      if (existingStatus !== 'granted') {

        const { status } = await Notifications.requestPermissionsAsync();

        finalStatus = status;

      }

      if (finalStatus !== 'granted') {

        Alert.alert('Permission required', 'Please enable notifications in Android settings.');

        return;

      }

      await Notifications.scheduleNotificationAsync({

        content: {

          title: 'Health App Test',

          body: 'Your notifications are working successfully!',

          sound: 'default',

        },

        trigger: {

          type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,

          seconds: 5,

          ...(Platform.OS === 'android' && {

            channelId: 'health-alerts',

          }),

        },

      });

      Alert.alert('Test scheduled', 'Your notification should appear in 5 seconds.');

    } catch (error) {

      console.error('Notification test failed:', error);

      Alert.alert('Error', String(error));

    }

  };

  const fetchAll = useCallback(async () => {

    if (!ready.current || busy.current) return;

    busy.current = true;

    setStatus('Refreshing health data…');

    try {

      const user = auth.currentUser;

      if (!user) {

        setStatus('Please sign in before syncing health data.');

        return;

      }

      const patientId = user.uid;

      const permissions = await getGrantedPermissions();

      setGranted(permissions);

      const end = new Date();

      const start = new Date(end.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

      const results: Dataset = {};

      for (const type of TYPES) {

        const hasReadPermission = permissions.some(

          (permission) => permission.accessType === 'read' && permission.recordType === type,

        );

        if (!hasReadPermission) {

          results[type] = { error: 'Read permission not granted' };

          continue;

        }

        try {

          const { records } = await readRecords(type, {

            timeRangeFilter: {

              operator: 'between',

              startTime: start.toISOString(),

              endTime: end.toISOString(),

            },

          });

          results[type] = records as AnyRecord[];

          console.log(`[${type}] ${records.length} records`);

          if (type === 'SleepSession') {

            (records as AnyRecord[]).forEach((sleepRecord, index) => {

              const stages = getSleepStages(sleepRecord);

              console.log(`[SleepSession] record ${index + 1}: ${stages.length} stages`, stages.map((stage) => ({

                stage: getSleepStageName(stage?.stage),

                rawStage: stage?.stage,

                startTime: stage?.startTime,

                endTime: stage?.endTime,

              })));

            });

          }

        } catch (error: any) {

          results[type] = { error: error?.message ?? String(error) };

          console.error(`[${type}] read failed:`, error);

        }

      }

      // Detect newly received Nutrition records.

      const nutritionRecords = Array.isArray(results.Nutrition)

        ? results.Nutrition

        : [];

      const currentNutritionKeys = new Set<string>();

      for (const record of nutritionRecords) {

        const recordKey = String(

          record.metadata?.id ??

          [

            record.time ?? record.startTime ?? record.endTime,

            record.name ?? record.mealName ?? 'Food entry',

            getNutritionCalories(record),

          ].join('|')

        );

        currentNutritionKeys.add(recordKey);

      }

      // First successful read establishes a baseline.

      // We don't want notifications for old records already in Health Connect.

      if (!nutritionInitialized.current) {

        seenNutritionRecords.current = currentNutritionKeys;

        nutritionInitialized.current = true;

      } else if (notificationPermissionGranted.current) {

        for (const record of nutritionRecords) {

          const recordKey = String(

            record.metadata?.id ??

            [

              record.time ?? record.startTime ?? record.endTime,

              record.name ?? record.mealName ?? 'Food entry',

              getNutritionCalories(record),

            ].join('|')

          );

          if (!seenNutritionRecords.current.has(recordKey)) {

            const foodName = String(

              record.name ?? record.mealName ?? 'New food entry'

            );

            const calories = getNutritionCalories(record);

            await Notifications.scheduleNotificationAsync({

              content: {

                title: 'New Nutrition Record',

                body:

                  calories !== null

                    ? `${foodName} · ${Math.round(calories)} kcal recorded in Health Connect.`

                    : `${foodName} recorded in Health Connect.`,

                sound: 'default',

              },

              trigger: {

                type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,

                seconds: 1,

                ...(Platform.OS === 'android' && {

                  channelId: 'health-alerts',

                }),

              },

            });

            console.log('New Nutrition record detected:', foodName);

          }

        }

        // Remember all records, including newly detected ones.

        seenNutritionRecords.current = currentNutritionKeys;

      }

      // Send the newly synchronized records to the authenticated prediction API.
      // Prediction failures are isolated so Health Connect syncing still succeeds.
      try {
        const predictionRecords = buildPredictionRecords(results);
        if (predictionRecords.length === 0) {
          throw new Error('No usable glucose or wearable records were returned by Health Connect.');
        }

        // Force Firebase to refresh the ID token.
        const idToken = await user.getIdToken(true);

        console.log('Firebase user UID:', user.uid);
        console.log('Firebase ID token generated:', !!idToken);
        const timezone =
          Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Dubai';

        const response = await fetch(`${API_BASE_URL}/predict-from-records`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({
            patient_id: patientId,
            timezone,
            records: predictionRecords,
          }),
        });

        const responseBody = await response.json().catch(() => null);
        if (!response.ok) {
          const detail =
            responseBody?.detail ??
            responseBody?.message ??
            `Prediction request failed (${response.status})`;
          throw new Error(String(detail));
        }

        setPrediction(responseBody);
        setPredictionError(null);
        console.log('Glucose prediction received:', responseBody);
      } catch (error: any) {
        setPrediction(null);
        setPredictionError(error?.message ?? String(error));
        console.warn('Prediction request failed:', error);
      }

      setData(results);

      setLastSync(new Date().toLocaleTimeString());

      setStatus('Up to date');

    } catch (error: any) {

      setStatus(`Refresh failed: ${error?.message ?? String(error)}`);

      console.error('Health Connect refresh failed:', error);

    } finally {

      busy.current = false;

    }

  }, []);

  const setup = useCallback(async () => {

    ready.current = false;

    setStatus('Connecting to Health Connect…');

    try {

      const sdkStatus = await getSdkStatus();

      if (sdkStatus !== SdkAvailabilityStatus.SDK_AVAILABLE) {

        setStatus(`Health Connect unavailable (${sdkStatus})`);

        return;

      }

      const initialized = await initialize();

      if (initialized === false) {

        setStatus('Health Connect initialization failed');

        return;

      }

      // Prepare notifications.

      if (Platform.OS === 'android') {

        await Notifications.setNotificationChannelAsync('health-alerts', {

          name: 'Health Alerts',

          importance: Notifications.AndroidImportance.MAX,

          vibrationPattern: [0, 250, 250, 250],

          sound: 'default',

        });

      }

      let notificationStatus = await Notifications.getPermissionsAsync();

      if (notificationStatus.status !== 'granted') {

        notificationStatus = await Notifications.requestPermissionsAsync();

      }

      notificationPermissionGranted.current =

        notificationStatus.status === 'granted';

      console.log(

        'Notification permission:',

        notificationPermissionGranted.current

      );

      const requestedPermissions: Permission[] = TYPES.map((recordType) => ({ accessType: 'read', recordType }));

      await requestPermission(requestedPermissions);

      const currentPermissions = await getGrantedPermissions();

      setGranted(currentPermissions);

      const missing = TYPES.filter((type) => !currentPermissions.some(

        (permission) => permission.accessType === 'read' && permission.recordType === type,

      ));

      ready.current = true;

      setStatus(missing.length ? `Missing permissions: ${missing.join(', ')}` : 'Permissions granted');

      await fetchAll();

    } catch (error: any) {

      setStatus(`Setup error: ${error?.message ?? String(error)}`);

      console.error('Health Connect setup failed:', error);

    }

  }, [fetchAll]);

  useEffect(() => {

    void setup();

    return () => { ready.current = false; };

  }, [setup]);

  useEffect(() => {

    const timer = setInterval(() => {

      if (AppState.currentState === 'active') void fetchAll();

    }, POLL_MS);

    const subscription = AppState.addEventListener('change', (nextState) => {

      if (nextState === 'active') void fetchAll();

    });

    return () => { clearInterval(timer); subscription.remove(); };

  }, [fetchAll]);

  const selectedRecords = selectedType ? sortedRecords(data[selectedType]) : [];

  const selectedValue = selectedType ? data[selectedType] : undefined;

  const selectedError = selectedValue && !Array.isArray(selectedValue) ? selectedValue.error : null;

  return (

    <View style={{ flex:  1, backgroundColor: COLORS.background }}>

      <StatusBar barStyle="dark-content" backgroundColor={COLORS.background} />

      {selectedType ? (

        <>

          <View style={styles.detailHeader}>

            <Pressable onPress={() => setSelectedType(null)} style={styles.backButton}>

              <Text style={styles.backText}>‹  All metrics</Text>

            </Pressable>

            <Text style={styles.detailTitle}>{ICONS[selectedType]}  {TITLES[selectedType]}</Text>

            <Text style={styles.muted}>Recent records · last {LOOKBACK_DAYS} day(s)</Text>

          </View>

          <ScrollView contentContainerStyle={styles.detailContent}>

            {selectedError ? (

              <View style={styles.emptyCard}><Text style={styles.bodyText}>{selectedError}</Text></View>

            ) : selectedRecords.length === 0 ? (

              <View style={styles.emptyCard}>

                <Text style={styles.emptyTitle}>No recent records</Text>

                <Text style={styles.muted}>When Health Connect has data for this metric, it will appear here.</Text>

              </View>

            ) : selectedRecords.map((record, index) => {

              const summary = summaryFor(selectedType, record);

              return (

                <View key={`${record.metadata?.id ?? selectedType}-${index}`} style={styles.historyCard}>

                  <View style={styles.historyTop}>

                    <Text style={styles.historyValue}>{summary.value}</Text>

                    <Text style={styles.historyIndex}>#{index + 1}</Text>

                  </View>

                  {!!summary.detail && <Text style={styles.muted}>{summary.detail}</Text>}

                  {recordDetails(selectedType, record).map((line, lineIndex) => (

                    <Text key={lineIndex} style={styles.historyDetail}>{line}</Text>

                  ))}

                </View>

              );

            })}

          </ScrollView>

        </>

      ) : (

        <ScrollView contentContainerStyle={styles.homeContent} showsVerticalScrollIndicator={false}>

          <View style={styles.topLine}>

            <View>

              <Text style={styles.dateLabel}>{new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase()}</Text>

              <Text style={styles.heading}>Welcome back,</Text>

              <Text style={styles.userName}>Your health</Text>

            </View>

            <View style={styles.avatar}><Text style={styles.avatarText}>✦</Text></View>

          </View>

          <View style={styles.glucoseCard}>

            <View style={styles.glucoseHeader}>

              <View>

                <Text style={styles.glucoseLabel}>CURRENT GLUCOSE</Text>

                <Text style={styles.glucoseCaption}>Latest available reading</Text>

              </View>

              <View style={styles.glucoseBadge}><Text style={styles.glucoseBadgeText}>●  LIVE DATA</Text></View>

            </View>

            {(() => {

              const glucoseRecords = sortedRecords(data.BloodGlucose);

              const latestGlucose = glucoseRecords[0];

              const glucose = latestGlucose ? getBloodGlucose(latestGlucose) : null;

              return (

                <View style={styles.glucoseValueRow}>

                  <Text style={styles.glucoseValue}>{glucose ? glucose.value.toFixed(glucose.unit === 'mg/dL' ? 0 : 1) : '--'}</Text>

                  <View style={styles.glucoseUnitBlock}>

                    <Text style={styles.glucoseUnit}>{glucose?.unit ?? 'mg/dL'}</Text>

                    <Text style={styles.glucoseWhen}>{latestGlucose ? formatTime(latestGlucose.time ?? latestGlucose.startTime) : 'No reading yet'}</Text>

                  </View>

                </View>

              );

            })()}

            <View style={styles.glucoseDivider}/>

            <View style={styles.glucoseBottom}>

              <Text style={styles.glucoseTarget}>Target range varies by individual</Text>

              <Pressable onPress={() => setSelectedType('BloodGlucose')}><Text style={styles.viewHistory}>View history  ›</Text></Pressable>

            </View>

          </View>

          <View style={styles.predictionCard}>
            <View style={styles.predictionHeader}>
              <View>
                <Text style={styles.predictionTitle}>Glucose forecast</Text>
                <Text style={styles.predictionSubtitle}>
                  XGBoost model · experimental estimate
                </Text>
              </View>
              <Text style={styles.predictionIcon}>📈</Text>
            </View>

            {predictionError ? (
              <Text style={styles.predictionError}>
                Prediction unavailable: {predictionError}
              </Text>
            ) : prediction?.predictions ? (
              <>
                <View style={styles.predictionValues}>
                  {(['30_min', '60_min', '120_min'] as const).map((horizon) => {
                    const item = prediction.predictions[horizon];
                    const label =
                      horizon === '30_min'
                        ? '30 min'
                        : horizon === '60_min'
                          ? '60 min'
                          : '120 min';
                    return (
                      <View key={horizon} style={styles.predictionValueBox}>
                        <Text style={styles.predictionHorizon}>{label}</Text>
                        <Text style={styles.predictionValue}>
                          {typeof item?.predicted_glucose_mg_dL === 'number'
                            ? `${item.predicted_glucose_mg_dL.toFixed(0)}`
                            : '--'}
                        </Text>
                        <Text style={styles.predictionUnit}>mg/dL</Text>
                      </View>
                    );
                  })}
                </View>
                <Text style={styles.predictionFootnote}>
                  Current model input glucose: {typeof prediction.current_glucose_mg_dL === 'number'
                    ? `${prediction.current_glucose_mg_dL.toFixed(0)} mg/dL`
                    : 'not reported'}
                </Text>
              </>
            ) : (
              <Text style={styles.predictionEmpty}>
                A forecast will appear after a successful data sync and prediction request.
              </Text>
            )}
            <Text style={styles.predictionDisclaimer}>
              For research/testing only. Not intended for treatment decisions or medical advice.
            </Text>
          </View>

          <View style={styles.syncPanel}>

            <View style={styles.syncPanelText}>

              <Text style={styles.syncPanelTitle}>Health data</Text>

              <Text style={styles.syncStatus}>{status}</Text>

              <Text style={styles.lastSync}>Last sync: {lastSync ?? 'Not yet synced'}</Text>

            </View>

            <Pressable onPress={() => void fetchAll()} style={({ pressed }) => [styles.syncButton, pressed && styles.pressed]}>

              <Text style={styles.syncButtonText}>↻  Sync</Text>

            </Pressable>

          </View>

          <Text style={styles.sectionTitle}>Services</Text>

          <View style={styles.servicesGrid}>

            <Pressable style={styles.serviceCard} onPress={() => Alert.alert('Food scanning', 'Food scanning will be added here.')}>

              <Text style={styles.serviceIcon}>🥗</Text><Text style={styles.serviceTitle}>Scan food</Text><Text style={styles.serviceHint}>Analyse your meal</Text>

            </Pressable>

            <Pressable style={styles.serviceCard} onPress={() => void fetchAll()}>

              <Text style={styles.serviceIcon}>⌚</Text><Text style={styles.serviceTitle}>Sync wearable</Text><Text style={styles.serviceHint}>Refresh health data</Text>

            </Pressable>

            <Pressable style={styles.serviceCard} onPress={() => setSelectedType('BloodGlucose')}>

              <Text style={styles.serviceIcon}>📈</Text><Text style={styles.serviceTitle}>Glucose logs</Text><Text style={styles.serviceHint}>Review readings</Text>

            </Pressable>

          </View>

          <View style={styles.sectionHeadingRow}>

            <Text style={styles.sectionTitle}>Today’s health data</Text>

            <Text style={styles.sectionCaption}>Tap to explore</Text>

          </View>

          <AccuChekBluetooth />

          <View style={styles.grid}>

            {TYPES.filter((type) => type !== 'BloodGlucose').map((type) => {

              const value = data[type];

              const records = sortedRecords(value);

              const isError = !!value && !Array.isArray(value);

              const latest = records[0];

              const summary = summaryFor(type, latest);

              const noData = !isError && !latest;

              return (

                <Pressable key={type} onPress={() => setSelectedType(type)} style={({ pressed }) => [styles.metricCard, pressed && styles.pressed]}>

                  <View style={styles.metricTop}>

                    <View style={styles.metricIcon}><Text style={styles.metricEmoji}>{ICONS[type]}</Text></View>

                    <Text style={styles.chevron}>›</Text>

                  </View>

                  <Text style={styles.metricTitle}>{TITLES[type]}</Text>

                  <Text numberOfLines={2} style={[styles.metricValue, noData && styles.noDataValue]}>{isError ? 'Unavailable' : summary.value}</Text>

                  <Text numberOfLines={2} style={styles.metricDetail}>{isError ? (value as { error: string }).error : summary.detail}</Text>

                  <View style={styles.metricFooter}><Text style={styles.recordCount}>{isError ? 'Check access' : `${records.length} record${records.length === 1 ? '' : 's'}`}</Text></View>

                </Pressable>

              );

            })}

          </View>

          <Text style={styles.footerNote}>HRV-derived stress is an experimental estimate, not a medical measurement. Health data refreshes while the app is open.</Text>

        </ScrollView>

      )}

    </View>

  );

}

const styles = {

  hero: { backgroundColor: '#DCECE6', borderRadius: 26, padding: 22, marginBottom: 24 } as const,

  eyebrow: { color: '#52766D', fontSize: 11, fontWeight: '800' as const, letterSpacing: 1.5, marginBottom: 8 },

  heading: { color: '#23443D', fontSize: 30, fontWeight: '800' as const, letterSpacing: -0.5 },

  heroDescription: { color: '#52766D', fontSize: 14, lineHeight: 20, marginTop: 8 },

  syncRow: { flexDirection: 'row' as const, alignItems: 'center' as const, marginTop: 20 },

  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#4E8B80', marginRight: 8 },

  syncStatus: { color: '#315A51', fontSize: 13, fontWeight: '600' as const, flex: 1 },

  lastSync: { color: '#718581', fontSize: 12, marginTop: 6 },

  syncButton: { alignSelf: 'flex-start' as const, backgroundColor: '#4E8B80', paddingVertical: 11, paddingHorizontal: 15, borderRadius: 12, marginTop: 16 },

  syncButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' as const },

  sectionHeadingRow: { flexDirection: 'row' as const, alignItems: 'baseline' as const, justifyContent: 'space-between' as const, marginBottom: 13 },

  sectionTitle: { color: COLORS.text, fontSize: 19, fontWeight: '800' as const },

  sectionCaption: { color: COLORS.muted, fontSize: 11 },

  grid: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, justifyContent: 'space-between' as const },

  metricCard: { width: '48.3%' as const, minHeight: 174, backgroundColor: COLORS.card, borderRadius: 18, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: COLORS.border },

  metricTop: { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const, marginBottom: 12 },

  metricIcon: { width: 38, height: 38, borderRadius: 13, backgroundColor: COLORS.softBlue, alignItems: 'center' as const, justifyContent: 'center' as const },

  metricEmoji: { fontSize: 19 },

  chevron: { color: '#9CA3AF', fontSize: 28, lineHeight: 28 },

  metricTitle: { color: COLORS.muted, fontSize: 12, fontWeight: '700' as const, minHeight: 30 },

  metricValue: { color: COLORS.text, fontSize: 21, fontWeight: '800' as const, marginTop: 4 },

  noDataValue: { color: '#9CA3AF', fontSize: 16 },

  metricDetail: { color: COLORS.muted, fontSize: 11, marginTop: 4, minHeight: 28 },

  metricFooter: { borderTopWidth: 1, borderTopColor: '#F0F2F6', paddingTop: 8, marginTop: 10 },

  recordCount: { color: COLORS.accent, fontSize: 11, fontWeight: '700' as const },

  latestTime: { color: '#9CA3AF', fontSize: 10, marginTop: 3 },

  predictionCard: { backgroundColor: '#FFFFFF', borderRadius: 20, padding: 17, marginBottom: 18, borderWidth: 1, borderColor: '#E3ECE8' },
  predictionHeader: { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const, marginBottom: 14 },
  predictionTitle: { color: '#23443D', fontSize: 17, fontWeight: '800' as const },
  predictionSubtitle: { color: '#78918A', fontSize: 11, marginTop: 4 },
  predictionIcon: { fontSize: 24 },
  predictionValues: { flexDirection: 'row' as const, justifyContent: 'space-between' as const },
  predictionValueBox: { flex: 1, backgroundColor: '#F1F7F4', borderRadius: 13, paddingVertical: 12, paddingHorizontal: 7, alignItems: 'center' as const, marginHorizontal: 3 },
  predictionHorizon: { color: '#52766D', fontSize: 11, fontWeight: '700' as const },
  predictionValue: { color: '#23443D', fontSize: 24, fontWeight: '800' as const, marginTop: 5 },
  predictionUnit: { color: '#78918A', fontSize: 10, marginTop: 1 },
  predictionFootnote: { color: '#52766D', fontSize: 11, marginTop: 12 },
  predictionEmpty: { color: COLORS.muted, fontSize: 12, lineHeight: 18 },
  predictionError: { color: '#92400E', fontSize: 12, lineHeight: 18 },
  predictionDisclaimer: { color: '#9CA3AF', fontSize: 10, lineHeight: 15, marginTop: 12 },
  footerNote: { color: COLORS.muted, fontSize: 11, lineHeight: 16, marginTop: 8 },

  detailHeader: { backgroundColor: COLORS.card, paddingTop: 54, paddingHorizontal: 20, paddingBottom: 20, borderBottomWidth: 1, borderBottomColor: COLORS.border },

  backButton: { alignSelf: 'flex-start' as const, paddingVertical: 8, paddingRight: 12, marginBottom: 10 },

  backText: { color: COLORS.accent, fontSize: 15, fontWeight: '700' as const },

  detailTitle: { color: COLORS.text, fontSize: 25, fontWeight: '800' as const },

  muted: { color: COLORS.muted, fontSize: 12, lineHeight: 18, marginTop: 4 },

  detailContent: { padding: 18, paddingBottom: 36 },

  historyCard: { backgroundColor: COLORS.card, borderRadius: 16, borderWidth: 1, borderColor: COLORS.border, padding: 16, marginBottom: 12 },

  historyTop: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, alignItems: 'center' as const },

  historyValue: { color: COLORS.text, fontSize: 20, fontWeight: '800' as const, flex: 1 },

  historyIndex: { color: '#9CA3AF', fontSize: 11, fontWeight: '700' as const },

  historyDetail: { color: '#4B5563', fontSize: 12, lineHeight: 18, marginTop: 7 },

  emptyCard: { backgroundColor: COLORS.card, borderRadius: 16, padding: 20, borderWidth: 1, borderColor: COLORS.border },

  emptyTitle: { color: COLORS.text, fontSize: 17, fontWeight: '800' as const, marginBottom: 6 },

  bodyText: { color: COLORS.text, fontSize: 13 },

  pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },

  homeContent: { padding: 20, paddingTop: 58, paddingBottom: 42 },

  topLine: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, alignItems: 'center' as const, marginBottom: 22 },

  dateLabel: { color: '#78918A', fontSize: 10, fontWeight: '800' as const, letterSpacing: 1.2, marginBottom: 9 },

  userName: { color: '#315A51', fontSize: 25, fontWeight: '700' as const, marginTop: -2 },

  avatar: { width: 46, height: 46, borderRadius: 23, backgroundColor: '#DCECE6', alignItems: 'center' as const, justifyContent: 'center' as const },

  avatarText: { color: '#4E8B80', fontSize: 24 },

  glucoseCard: { backgroundColor: '#DCECE6', borderRadius: 24, padding: 20, marginBottom: 18 },

  glucoseHeader: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, alignItems: 'center' as const },

  glucoseLabel: { color: '#52766D', fontSize: 11, fontWeight: '800' as const, letterSpacing: 1 },

  glucoseCaption: { color: '#78918A', fontSize: 12, marginTop: 5 },

  glucoseBadge: { backgroundColor: '#C5DED4', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 7 },

  glucoseBadgeText: { color: '#35695C', fontSize: 9, fontWeight: '800' as const },

  glucoseValueRow: { flexDirection: 'row' as const, alignItems: 'center' as const, marginTop: 18, marginBottom: 16 },

  glucoseValue: { color: '#23443D', fontSize: 54, fontWeight: '700' as const, letterSpacing: -2 },

  glucoseUnitBlock: { marginLeft: 10, flex: 1 },

  glucoseUnit: { color: '#315A51', fontSize: 15, fontWeight: '700' as const },

  glucoseWhen: { color: '#78918A', fontSize: 10, marginTop: 5 },

  glucoseDivider: { height: 1, backgroundColor: '#C5DCD2' },

  glucoseBottom: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, alignItems: 'center' as const, marginTop: 13 },

  glucoseTarget: { color: '#52766D', fontSize: 10, flex: 1 },

  viewHistory: { color: '#35695C', fontSize: 11, fontWeight: '800' as const },

  syncPanel: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 16, marginBottom: 24, flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const, borderWidth: 1, borderColor: '#E3ECE8' },

  syncPanelText: { flex: 1 },

  syncPanelTitle: { color: '#315A51', fontSize: 15, fontWeight: '800' as const, marginBottom: 4 },

  servicesGrid: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, marginTop: 12, marginBottom: 25 },

  serviceCard: { width: '31.5%' as const, backgroundColor: '#FFFFFF', borderRadius: 17, borderWidth: 1, borderColor: '#E3ECE8', padding: 12, minHeight: 112 },

  serviceIcon: { fontSize: 23, marginBottom: 9 },

  serviceTitle: { color: '#315A51', fontSize: 12, fontWeight: '800' as const },

  serviceHint: { color: '#879993', fontSize: 10, marginTop: 4, lineHeight: 14 },

};
