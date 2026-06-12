/**
 * Per-device API-key storage in localStorage so the key never travels via vault
 * sync (OneDrive / Obsidian Sync) and cannot be clobbered across machines. The
 * stored value is encrypted at rest via safeStorage (falls back to plaintext if
 * unavailable - still per-device and unsynced). Browser adapter; not unit-tested.
 */

import { encryptValue, decryptValue } from "./shared/crypto";

const LS_KEY = "ai-meeting-notes:assemblyai-key";

/**
 * Read and decrypt the per-device API key from localStorage.
 *
 * @returns The plaintext API key, or "" if none stored or undecryptable.
 */
export function getDeviceApiKey(): string {
  try {
    const v = window.localStorage.getItem(LS_KEY);
    return v ? decryptValue(v) : "";
  } catch {
    return "";
  }
}

/**
 * Encrypt and store the per-device API key in localStorage.
 * An empty value clears the stored key entirely.
 *
 * @param plaintext - The API key to store; pass "" to clear.
 */
export function setDeviceApiKey(plaintext: string): void {
  try {
    if (!plaintext) {
      window.localStorage.removeItem(LS_KEY);
      return;
    }
    window.localStorage.setItem(LS_KEY, encryptValue(plaintext));
  } catch {
    // localStorage unavailable - ignore (key simply not persisted this session).
  }
}

/**
 * Returns true if a per-device API key is stored on this machine.
 */
export function hasDeviceApiKey(): boolean {
  try {
    return window.localStorage.getItem(LS_KEY) !== null;
  } catch {
    return false;
  }
}
