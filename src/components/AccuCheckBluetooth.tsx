import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { BleManager, Device } from 'react-native-ble-plx';

import { useAuth } from '../contexts/AuthContext';
import {
  addRegisteredDevice,
  deleteRegisteredDevice,
  getRegisteredDevices,
  RegisteredDevice,
} from '../services/deviceRegistry';

export default function AccuChekBluetooth() {
  const { user_id } = useAuth();
  const managerRef = useRef<BleManager | null>(null);
  const scanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [devices, setDevices] = useState<Device[]>([]);
  const [registeredDevices, setRegisteredDevices] = useState<RegisteredDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [deviceName, setDeviceName] = useState('');
  const [deviceLocation, setDeviceLocation] = useState('Home');
  const [scanning, setScanning] = useState(false);
  const [loadingSaved, setLoadingSaved] = useState(true);
  const [status, setStatus] = useState('Ready to scan for glucometers.');

  useEffect(() => {
    const manager = new BleManager();
    managerRef.current = manager;

    return () => {
      if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
      manager.stopDeviceScan();
      manager.destroy();
      managerRef.current = null;
    };
  }, []);

  useEffect(() => {
    let active = true;

    async function loadDevices() {
      if (!user_id) {
        setRegisteredDevices([]);
        setLoadingSaved(false);
        return;
      }

      setLoadingSaved(true);
      try {
        const saved = await getRegisteredDevices(user_id);
        if (active) setRegisteredDevices(saved);
      } catch (error) {
        if (active) setStatus(error instanceof Error ? error.message : 'Could not load saved devices.');
      } finally {
        if (active) setLoadingSaved(false);
      }
    }

    void loadDevices();
    return () => { active = false; };
  }, [user_id]);

  async function requestBluetoothPermissions() {
    if (Platform.OS !== 'android') return true;

    if (Number(Platform.Version) >= 31) {
      const result = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      ]);

      return (
        result[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] === PermissionsAndroid.RESULTS.GRANTED &&
        result[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] === PermissionsAndroid.RESULTS.GRANTED
      );
    }

    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    );
    return result === PermissionsAndroid.RESULTS.GRANTED;
  }

  async function startScan() {
    const manager = managerRef.current;
    if (!manager || scanning) return;

    try {
      setDevices([]);
      setSelectedDevice(null);
      setStatus('Checking Bluetooth permissions...');

      const permitted = await requestBluetoothPermissions();
      if (!permitted) {
        setStatus('Bluetooth permission was not granted.');
        return;
      }

      setStatus('Scanning for nearby Bluetooth devices...');
      setScanning(true);

      manager.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
        if (error) {
          setStatus(`Scan error: ${error.message}`);
          setScanning(false);
          manager.stopDeviceScan();
          return;
        }

        if (!device) return;
        setDevices((previous) => {
          const existing = previous.find((item) => item.id === device.id);
          return existing
            ? previous.map((item) => item.id === device.id ? device : item)
            : [...previous, device];
        });
      });

      scanTimeoutRef.current = setTimeout(() => {
        manager.stopDeviceScan();
        setScanning(false);
        setStatus('Scan finished. Select a device below to register it.');
      }, 10000);
    } catch (error) {
      setScanning(false);
      setStatus(error instanceof Error ? error.message : 'Unable to start Bluetooth scan.');
    }
  }

  function stopScan() {
    if (scanTimeoutRef.current) {
      clearTimeout(scanTimeoutRef.current);
      scanTimeoutRef.current = null;
    }
    managerRef.current?.stopDeviceScan();
    setScanning(false);
    setStatus('Scan stopped.');
  }

  function chooseDevice(device: Device) {
    setSelectedDevice(device);
    setDeviceName(device.name || device.localName || 'My Glucometer');
    setDeviceLocation('Home');
  }

  async function registerSelectedDevice() {
    if (!user_id) {
      Alert.alert('Sign in required', 'Please sign in before registering a device.');
      return;
    }
    if (!selectedDevice) return;
    if (!deviceName.trim()) {
      Alert.alert('Device name required', 'Enter a name such as Home Glucometer or Work Glucometer.');
      return;
    }

    const newDevice: RegisteredDevice = {
      deviceId: `device_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
      ownerUserId: user_id,
      name: deviceName.trim(),
      type: 'Glucometer',
      location: deviceLocation.trim() || 'Unspecified',
      connectionMethod: 'BLE',
      bluetoothDeviceId: selectedDevice.id,
      bluetoothName: selectedDevice.name || selectedDevice.localName || null,
      registeredAt: new Date().toISOString(),
    };

    try {
      const updated = await addRegisteredDevice(user_id, newDevice);
      setRegisteredDevices(updated);
      setSelectedDevice(null);
      setDeviceName('');
      setDeviceLocation('Home');
      setStatus(`${newDevice.name} registered on this account.`);
      Alert.alert('Device registered', `${newDevice.name} was added to your device list.`);
    } catch (error) {
      Alert.alert('Could not register device', error instanceof Error ? error.message : String(error));
    }
  }

  function removeDevice(device: RegisteredDevice) {
    Alert.alert('Remove device?', `Remove ${device.name} from this account?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          if (!user_id) return;
          try {
            const updated = await deleteRegisteredDevice(user_id, device.deviceId);
            setRegisteredDevices(updated);
          } catch (error) {
            Alert.alert('Error', error instanceof Error ? error.message : 'Could not remove device.');
          }
        },
      },
    ]);
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={styles.headerTextWrap}>
          <Text style={styles.heading}>My Glucometers</Text>
          <Text style={styles.subheading}>Register more than one meter to your account.</Text>
        </View>
        <Text style={styles.count}>{registeredDevices.length}</Text>
      </View>

      {!user_id ? (
        <Text style={styles.status}>Sign in to manage your registered devices.</Text>
      ) : loadingSaved ? (
        <Text style={styles.status}>Loading registered devices...</Text>
      ) : registeredDevices.length === 0 ? (
        <Text style={styles.empty}>No glucometers registered yet.</Text>
      ) : (
        registeredDevices.map((device) => (
          <View key={device.deviceId} style={styles.savedDevice}>
            <View style={styles.savedDeviceText}>
              <Text style={styles.deviceName}>{device.name}</Text>
              <Text style={styles.deviceInfo}>{device.type} · {device.location}</Text>
              <Text style={styles.deviceInfo}>Registered Bluetooth device</Text>
            </View>
            <Pressable onPress={() => removeDevice(device)} hitSlop={10}>
              <Text style={styles.removeText}>Remove</Text>
            </Pressable>
          </View>
        ))
      )}

      <View style={styles.separator} />
      <Text style={styles.sectionTitle}>Add a glucometer</Text>
      <Text style={styles.status}>{status}</Text>

      <Pressable style={styles.button} onPress={scanning ? stopScan : startScan}>
        <Text style={styles.buttonText}>{scanning ? 'Stop scanning' : 'Scan for Bluetooth devices'}</Text>
      </Pressable>

      <Text style={styles.deviceInfo}>Nearby devices found: {devices.length}</Text>
      <ScrollView style={styles.deviceList} nestedScrollEnabled>
        {devices.map((device) => {
          const alreadySaved = registeredDevices.some((saved) => saved.bluetoothDeviceId === device.id);
          const selected = selectedDevice?.id === device.id;
          return (
            <Pressable
              key={device.id}
              disabled={alreadySaved}
              onPress={() => chooseDevice(device)}
              style={[styles.discoveredDevice, selected && styles.selectedDevice, alreadySaved && styles.disabledDevice]}
            >
              <Text style={styles.deviceName}>{device.name || device.localName || 'Unnamed Bluetooth device'}</Text>
              <Text style={styles.deviceInfo}>Bluetooth ID: {device.id}</Text>
              <Text style={styles.deviceInfo}>{alreadySaved ? 'Already registered' : `Signal: ${device.rssi ?? 'Unknown'} dBm · Tap to select`}</Text>
            </Pressable>
          );
        })}
        {!devices.length && <Text style={styles.empty}>No nearby devices found. Scan while close to your glucometer.</Text>}
      </ScrollView>

      {selectedDevice && (
        <View style={styles.form}>
          <Text style={styles.sectionTitle}>Device details</Text>
          <Text style={styles.fieldLabel}>Device name</Text>
          <TextInput
            style={styles.input}
            value={deviceName}
            onChangeText={setDeviceName}
            placeholder="e.g. Home Glucometer"
            placeholderTextColor="#777777"
          />
          <Text style={styles.fieldLabel}>Location label</Text>
          <TextInput
            style={styles.input}
            value={deviceLocation}
            onChangeText={setDeviceLocation}
            placeholder="e.g. Home or Work"
            placeholderTextColor="#777777"
          />
          <Pressable style={styles.saveButton} onPress={registerSelectedDevice}>
            <Text style={styles.buttonText}>Register this device</Text>
          </Pressable>
          <Text style={styles.note}>Registration saves this device to this signed-in account on this phone. It does not pair with the meter or read glucose yet.</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#FFFFFF', padding: 16, borderRadius: 14,
    marginVertical: 10, borderWidth: 1, borderColor: '#DDE5E1',
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerTextWrap: { flex: 1, paddingRight: 12 },
  heading: { color: '#315D55', fontSize: 20, fontWeight: '700' },
  subheading: { color: '#555555', fontSize: 12, marginTop: 4 },
  count: { color: '#315D55', fontSize: 18, fontWeight: '700' },
  status: { color: '#444444', fontSize: 13, marginVertical: 10 },
  empty: { color: '#666666', fontSize: 13, paddingVertical: 12 },
  savedDevice: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#E8ECEA' },
  savedDeviceText: { flex: 1, paddingRight: 8 },
  deviceName: { color: '#172033', fontWeight: '700', fontSize: 14 },
  deviceInfo: { color: '#555555', fontSize: 11, marginTop: 3 },
  removeText: { color: '#B42318', fontWeight: '600', fontSize: 12 },
  separator: { height: 1, backgroundColor: '#E5EAE7', marginVertical: 14 },
  sectionTitle: { color: '#315D55', fontSize: 15, fontWeight: '700', marginBottom: 8 },
  button: { backgroundColor: '#76A99A', padding: 12, borderRadius: 9, alignItems: 'center', marginBottom: 12 },
  saveButton: { backgroundColor: '#315D55', padding: 13, borderRadius: 9, alignItems: 'center', marginTop: 8 },
  buttonText: { color: '#FFFFFF', fontWeight: '700' },
  deviceList: { maxHeight: 190, marginTop: 6 },
  discoveredDevice: { padding: 10, borderWidth: 1, borderColor: '#E0E6E3', borderRadius: 9, marginBottom: 7 },
  selectedDevice: { borderColor: '#315D55', backgroundColor: '#EFF7F4' },
  disabledDevice: { opacity: 0.5 },
  form: { borderTopWidth: 1, borderTopColor: '#E5EAE7', paddingTop: 14, marginTop: 10 },
  fieldLabel: { color: '#333333', fontSize: 12, fontWeight: '600', marginBottom: 5 },
  input: { borderWidth: 1, borderColor: '#CDD8D2', borderRadius: 8, padding: 11, color: '#111111', marginBottom: 11 },
  note: { color: '#666666', fontSize: 11, lineHeight: 16, marginTop: 9 },
});
