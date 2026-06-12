// Tests for the per-device API-key migration decision.
import { describe, expect, it } from "vitest";
import { resolveApiKey } from "./api-key-migration";

describe("resolveApiKey", () => {
  it("uses the per-device key when present, no migration", () => {
    expect(resolveApiKey("dev-key", "legacy")).toEqual({ key: "dev-key", migrate: null });
  });
  it("adopts and migrates a decryptable legacy key when no device key", () => {
    expect(resolveApiKey("", "legacy")).toEqual({ key: "legacy", migrate: "legacy" });
  });
  it("returns empty when neither is present (foreign/absent legacy)", () => {
    expect(resolveApiKey("", "")).toEqual({ key: "", migrate: null });
  });
});
