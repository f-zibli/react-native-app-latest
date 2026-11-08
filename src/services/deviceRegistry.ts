import AsyncStorage from '@react-native-async-storage/async-storage';

export type RegisteredDevice = {
  deviceId: string;
  ownerUserId: string;
  name: string;
  type: 'Glucometer';
  location: string;
  connectionMethod: 'BLE';
  bluetoothDeviceId: string;
  bluetoothName: string | null;
  registeredAt: string;
};

const storageKey = (userId: string) => `@health-app/registered-devices/${userId}`;

export async function getRegisteredDevices(userId: string): Promise<RegisteredDevice[]> {
  const raw = await AsyncStorage.getItem(storageKey(userId));
  if (!raw) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RegisteredDevice[]) : [];
  } catch {
    return [];
  }
}

export async function addRegisteredDevice(
  userId: string,
  device: RegisteredDevice,
): Promise<RegisteredDevice[]> {
  const existing = await getRegisteredDevices(userId);
  const alreadyRegistered = existing.some(
    (item) => item.bluetoothDeviceId === device.bluetoothDeviceId,
  );

  if (alreadyRegistered) {
    throw new Error('This Bluetooth device is already registered to this account.');
  }

  const updated = [...existing, device];
  await AsyncStorage.setItem(storageKey(userId), JSON.stringify(updated));
  return updated;
}

export async function deleteRegisteredDevice(
  userId: string,
  deviceId: string,
): Promise<RegisteredDevice[]> {
  const existing = await getRegisteredDevices(userId);
  const updated = existing.filter((item) => item.deviceId !== deviceId);
  await AsyncStorage.setItem(storageKey(userId), JSON.stringify(updated));
  return updated;
}
