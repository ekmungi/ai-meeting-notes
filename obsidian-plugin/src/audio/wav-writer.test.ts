// src/audio/wav-writer.test.ts
// Verifies exact RIFF/WAV header bytes for 16kHz mono int16 PCM.
import { describe, expect, it } from "vitest";
import { WavWriter } from "./wav-writer";

describe("WavWriter", () => {
  it("encodes a valid RIFF header for 16kHz mono int16", () => {
    const w = new WavWriter(16000);
    w.append(new Int16Array([1, -1, 32767]));
    const buf = new DataView(w.encode());
    const tag = (o: number) => String.fromCharCode(buf.getUint8(o), buf.getUint8(o + 1), buf.getUint8(o + 2), buf.getUint8(o + 3));
    expect(tag(0)).toBe("RIFF");
    expect(buf.getUint32(4, true)).toBe(36 + 6);        // file size - 8 (3 samples * 2 bytes)
    expect(tag(8)).toBe("WAVE");
    expect(tag(12)).toBe("fmt ");
    expect(buf.getUint32(16, true)).toBe(16);           // fmt chunk size
    expect(buf.getUint16(20, true)).toBe(1);            // PCM
    expect(buf.getUint16(22, true)).toBe(1);            // mono
    expect(buf.getUint32(24, true)).toBe(16000);        // sample rate
    expect(buf.getUint32(28, true)).toBe(32000);        // byte rate
    expect(buf.getUint16(32, true)).toBe(2);            // block align
    expect(buf.getUint16(34, true)).toBe(16);           // bits per sample
    expect(tag(36)).toBe("data");
    expect(buf.getUint32(40, true)).toBe(6);            // data size
    expect(buf.getInt16(44, true)).toBe(1);             // first sample
  });

  it("tracks duration", () => {
    const w = new WavWriter(16000);
    w.append(new Int16Array(16000));
    expect(w.durationSeconds).toBe(1);
  });
});
