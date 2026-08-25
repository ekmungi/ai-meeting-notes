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
  it("defaults new installs to the cheap English model with diarization on", () => {
    expect(DEFAULT_SETTINGS.speechModel).toBe("universal-streaming-english");
    expect(DEFAULT_SETTINGS.enableDiarization).toBe(true);
  });

  it("keeps a valid saved speech model", () => {
    const m = migrateSettings({ speechModel: "universal-3-5-pro" });
    expect(m.speechModel).toBe("universal-3-5-pro");
  });

  it("replaces the retired u3-rt-pro pin with the default model", () => {
    const m = migrateSettings({ speechModel: "u3-rt-pro" });
    expect(m.speechModel).toBe(DEFAULT_SETTINGS.speechModel);
  });

  // Pre-D068 installs have no speechModel key. AssemblyAI is now the only
  // speaker source and diarization costs nothing extra, so turn it on once.
  it("turns diarization on once when upgrading a pre-model install", () => {
    const m = migrateSettings({ enableDiarization: false, outputFolder: "Meetings" });
    expect(m.enableDiarization).toBe(true);
  });

  it("respects diarization turned off after the upgrade", () => {
    const m = migrateSettings({ speechModel: "universal-streaming-english", enableDiarization: false });
    expect(m.enableDiarization).toBe(false);
  });
});
