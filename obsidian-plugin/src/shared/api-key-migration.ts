/**
 * Pure decision helper for resolving the effective API key and detecting
 * when a legacy synced key should be migrated to per-device storage. No IO.
 */

/**
 * Resolve which API key to use and whether to migrate a legacy synced key
 * (from data.json) into per-device localStorage storage.
 *
 * @param deviceKey       Per-device key already stored on this machine ("" if none).
 * @param legacyDecrypted data.json key decrypted on THIS device ("" if absent or
 *                        it was encrypted on another machine and won't decrypt here).
 * @returns key = the plaintext key to use; migrate = a plaintext key to write to
 *          per-device storage (non-null only on first migration), else null.
 */
export function resolveApiKey(
  deviceKey: string,
  legacyDecrypted: string,
): { key: string; migrate: string | null } {
  if (deviceKey) return { key: deviceKey, migrate: null };
  if (legacyDecrypted) return { key: legacyDecrypted, migrate: legacyDecrypted };
  return { key: "", migrate: null };
}
