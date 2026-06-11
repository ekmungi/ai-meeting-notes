// src/audio/silence-monitor.test.ts
// Port-fidelity tests against backend silence.py behavior.
import { describe, expect, it } from "vitest";
import { SilenceMonitor, computeRms } from "./silence-monitor";

const loud = new Int16Array(1600).fill(2000);   // rms 2000
const quiet = new Int16Array(1600).fill(10);    // rms 10, under min threshold 100

/** Build a monitor with a controllable clock; returns [monitor, tick]. */
function make(threshold = 15, interval = 15, onSilence?: (s: number) => void) {
  let now = 0;
  const m = new SilenceMonitor({ thresholdSeconds: threshold, intervalSeconds: interval,
    onSilence, now: () => now });
  return { m, advance: (s: number) => { now += s; } };
}

describe("computeRms", () => {
  it("computes RMS of int16 samples", () => {
    expect(computeRms(new Int16Array([3, 4, 3, 4]))).toBeCloseTo(Math.sqrt(12.5));
    expect(computeRms(new Int16Array(0))).toBe(0);
  });
});

describe("SilenceMonitor", () => {
  it("calibrates after 30 chunks and is not silent during calibration", () => {
    const { m } = make();
    for (let i = 0; i < 29; i++) m.feedChunk(quiet);
    expect(m.calibrated).toBe(false);
    m.feedChunk(quiet);
    expect(m.calibrated).toBe(true);
    expect(m.isSilent).toBe(false);
  });

  it("fires onSilence at threshold and then every interval", () => {
    const calls: number[] = [];
    const { m, advance } = make(15, 15, (s) => calls.push(Math.round(s)));
    for (let i = 0; i < 30; i++) m.feedChunk(loud);  // calibrate on loud ambient
    // threshold becomes max(2000*2, 100) = 4000; rms 10 counts as silence.
    m.feedChunk(quiet);            // silence starts at t=0
    advance(15); m.feedChunk(quiet);
    expect(calls).toEqual([15]);
    advance(14); m.feedChunk(quiet);
    expect(calls).toEqual([15]);   // interval not elapsed
    advance(1); m.feedChunk(quiet);
    expect(calls).toEqual([15, 30]);
    expect(m.isSilent).toBe(true);
  });

  it("speech resets tracking; resetSilence preserves calibration", () => {
    const { m, advance } = make();
    for (let i = 0; i < 30; i++) m.feedChunk(quiet);  // threshold = 100 (min)
    m.feedChunk(quiet); advance(20); m.feedChunk(quiet);
    expect(m.isSilent).toBe(true);
    m.feedChunk(loud);                 // speech
    expect(m.isSilent).toBe(false);
    expect(m.silentSeconds).toBe(0);
    m.resetSilence();
    expect(m.calibrated).toBe(true);
  });

  it("thresholdSeconds=0 disables monitoring", () => {
    const { m } = make(0);
    for (let i = 0; i < 40; i++) m.feedChunk(quiet);
    expect(m.calibrated).toBe(false);
    expect(m.isSilent).toBe(false);
  });
});
