// src/settings-migration.ts
// Loads legacy saved data into the serverless settings shape: dead keys from
// the server/desktop era are dropped, new keys take defaults.

import { DEFAULT_SETTINGS } from "./shared/types";
import type { MeetingNotesSettings } from "./shared/types";

const DEAD_KEYS = ["serverExePath", "serverPort", "keepServerRunning", "engine", "localModelSize"] as const;

/** Merge raw plugin data over defaults, dropping retired keys. */
export function migrateSettings(raw: unknown): MeetingNotesSettings {
  const data = (raw && typeof raw === "object") ? { ...(raw as Record<string, unknown>) } : {};
  for (const k of DEAD_KEYS) delete data[k];
  return { ...DEFAULT_SETTINGS, ...data } as MeetingNotesSettings;
}
