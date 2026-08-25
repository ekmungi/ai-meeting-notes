// src/settings-migration.ts
// Loads legacy saved data into the serverless settings shape: dead keys from
// the server/desktop era are dropped, new keys take defaults.

import { DEFAULT_SETTINGS, SPEECH_MODELS } from "./shared/types";
import type { MeetingNotesSettings } from "./shared/types";

const DEAD_KEYS = ["serverExePath", "serverPort", "keepServerRunning", "engine", "localModelSize"] as const;

/** Merge raw plugin data over defaults, dropping retired keys. */
export function migrateSettings(raw: unknown): MeetingNotesSettings {
  const data = (raw && typeof raw === "object") ? { ...(raw as Record<string, unknown>) } : {};
  for (const k of DEAD_KEYS) delete data[k];

  // Absence of speechModel marks a pre-DEC-068 install. Those saved
  // enableDiarization: false because that was the old default, and AssemblyAI
  // is now our only speaker source, so turn it on once during the upgrade.
  // After this the key is persisted, so a later opt-out is respected forever.
  const preModelInstall = !("speechModel" in data);
  if (preModelInstall) data.enableDiarization = true;

  // Reject anything not in the current enum - notably the retired "u3-rt-pro",
  // which would otherwise be sent verbatim and redirected to the pricier tier.
  if (!(typeof data.speechModel === "string" && data.speechModel in SPEECH_MODELS)) {
    delete data.speechModel;
  }

  return { ...DEFAULT_SETTINGS, ...data } as MeetingNotesSettings;
}
