/**
 * Encrypt/decrypt strings using Electron's safeStorage (DPAPI on Windows).
 * Falls back to plaintext if safeStorage is unavailable.
 */

/** Prefix that marks an encrypted ciphertext stored in data.json. */
const ENC_PREFIX = "enc:";

/**
 * Access Electron's safeStorage API if available.
 * Tries both the remote bridge (older Electron versions) and direct require.
 * Returns null if encryption is not possible on this platform.
 */
function getSafeStorage(): {
  encryptString: (s: string) => Buffer;
  decryptString: (b: Buffer) => string;
  isEncryptionAvailable: () => boolean;
} | null {
  // Try the Electron remote bridge first (some Obsidian builds expose this).
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const remoteStorage = (window as any)?.electron?.remote?.safeStorage;
    if (remoteStorage?.isEncryptionAvailable?.()) {
      return remoteStorage;
    }
  } catch {
    // safeStorage not available via remote bridge
  }

  // Try direct require (works when running inside the Electron main process context).
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { safeStorage } = require("electron");
    if (safeStorage?.isEncryptionAvailable?.()) {
      return safeStorage;
    }
  } catch {
    // Not in an Electron context or safeStorage unavailable
  }

  return null;
}

/**
 * Encrypt a plaintext string using safeStorage.
 * Returns an "enc:"-prefixed base64 string on success.
 * Returns the original plaintext unchanged if encryption is unavailable.
 *
 * @param plaintext - The string to encrypt (e.g. an API key).
 * @returns Encrypted base64 string with "enc:" prefix, or plaintext as fallback.
 */
export function encryptValue(plaintext: string): string {
  if (!plaintext) return "";
  const ss = getSafeStorage();
  if (ss) {
    try {
      const encrypted = ss.encryptString(plaintext);
      return ENC_PREFIX + Buffer.from(encrypted).toString("base64");
    } catch (e) {
      // Log at warn level -- encryption failure is non-fatal, plaintext is stored instead.
      console.warn("AI Meeting Notes: safeStorage encryption failed, storing plaintext", e);
    }
  }
  return plaintext;
}

/**
 * Decrypt a stored value produced by encryptValue.
 * Handles both "enc:"-prefixed ciphertext and legacy plaintext transparently
 * so that existing plaintext keys continue to work after an upgrade.
 *
 * @param stored - The raw string read from data.json.
 * @returns Decrypted plaintext, or empty string if decryption fails.
 */
export function decryptValue(stored: string): string {
  if (!stored) return "";

  // Legacy plaintext -- return as-is (will be re-encrypted on next saveSettings call).
  if (!stored.startsWith(ENC_PREFIX)) {
    return stored;
  }

  const ss = getSafeStorage();
  if (ss) {
    try {
      const buf = Buffer.from(stored.slice(ENC_PREFIX.length), "base64");
      return ss.decryptString(buf);
    } catch (e) {
      console.warn("AI Meeting Notes: safeStorage decryption failed", e);
    }
  }

  console.warn("AI Meeting Notes: Cannot decrypt API key -- safeStorage unavailable");
  return "";
}

/**
 * Returns true if safeStorage encryption is available on this platform.
 * Used to show a warning in settings when encryption cannot be provided.
 */
export function isEncryptionAvailable(): boolean {
  return getSafeStorage() !== null;
}
