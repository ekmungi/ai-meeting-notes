// src/audio/devices.ts
// Audio input device enumeration, preference matching, and change watching.
// chooseDevice is pure; the enumerate/watch helpers wrap navigator.mediaDevices.

/** Persisted device preference: id plus label (ids change on Bluetooth re-pair). */
export interface DevicePreference { id: string; label: string; }

/** Minimal device descriptor (subset of MediaDeviceInfo). */
export interface InputDevice { deviceId: string; label: string; }

/** Resolve which deviceId to use: exact id > label match > "default". */
export function chooseDevice(pref: DevicePreference | null, devices: InputDevice[]): string {
  if (pref) {
    if (devices.some((d) => d.deviceId === pref.id)) return pref.id;
    const byLabel = devices.find((d) => d.label === pref.label && d.label !== "");
    if (byLabel) return byLabel.deviceId;
  }
  return "default";
}

/** List audio input devices (labels require one prior getUserMedia grant). */
export async function listInputDevices(): Promise<InputDevice[]> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === "audioinput")
    .map((d) => ({ deviceId: d.deviceId, label: d.label }));
}

/** Subscribe to OS device changes; returns an unsubscribe function. */
export function watchDevices(onChange: () => void): () => void {
  navigator.mediaDevices.addEventListener("devicechange", onChange);
  return () => navigator.mediaDevices.removeEventListener("devicechange", onChange);
}
