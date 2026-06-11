// src/settings-migration.test.ts
// Old saved data (with server/engine keys) loads cleanly into the new shape.
import { describe, expect, it } from "vitest";
import { migrateSettings } from "./settings-migration";
import { DEFAULT_SETTINGS } from "./shared/types";

describe("migrateSettings", () => {
  it("drops dead server/engine keys and keeps everything else", () => {
    const old = {
      serverExePath: "C:/x/server.exe", serverPort: 9876, keepServerRunning: true,
      engine: "local", localModelSize: "small.en",
      assemblyaiApiKey: "enc:abc", outputFolder: "Meetings", recordWav: true,
    };
    const m = migrateSettings(old);
    expect("serverExePath" in m).toBe(false);
    expect("serverPort" in m).toBe(false);
    expect("keepServerRunning" in m).toBe(false);
    expect("engine" in m).toBe(false);
    expect("localModelSize" in m).toBe(false);
    expect(m.assemblyaiApiKey).toBe("enc:abc");
    expect(m.recordWav).toBe(true);
    expect(m.micDeviceId).toBe(DEFAULT_SETTINGS.micDeviceId);   // new key defaulted
  });

  it("handles null/undefined saved data", () => {
    expect(migrateSettings(null)).toEqual(DEFAULT_SETTINGS);
  });
});
