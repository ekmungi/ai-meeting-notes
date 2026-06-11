// src/audio/devices.test.ts
// Pure device-choice logic: id match > label match > default.
import { describe, expect, it } from "vitest";
import { chooseDevice } from "./devices";

const list = [
  { deviceId: "default", label: "Default" },
  { deviceId: "abc", label: "Headset Microphone" },
  { deviceId: "xyz", label: "Webcam Mic" },
];

describe("chooseDevice", () => {
  it("prefers exact id match", () => {
    expect(chooseDevice({ id: "abc", label: "old name" }, list)).toBe("abc");
  });
  it("falls back to label match when the id changed (Bluetooth re-pair)", () => {
    expect(chooseDevice({ id: "GONE", label: "Headset Microphone" }, list)).toBe("abc");
  });
  it("falls back to default when nothing matches or no preference", () => {
    expect(chooseDevice({ id: "GONE", label: "GONE" }, list)).toBe("default");
    expect(chooseDevice(null, list)).toBe("default");
  });
});
