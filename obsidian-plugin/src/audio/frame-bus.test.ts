// src/audio/frame-bus.test.ts
// Tests for the PCM frame fan-out bus.
import { describe, expect, it } from "vitest";
import { FrameBus } from "./frame-bus";

describe("FrameBus", () => {
  it("delivers frames to all subscribers", () => {
    const bus = new FrameBus();
    const a: Int16Array[] = []; const b: Int16Array[] = [];
    bus.subscribe((f) => a.push(f));
    bus.subscribe((f) => b.push(f));
    bus.publish(new Int16Array([1, 2]));
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
  });

  it("unsubscribe stops delivery; one bad listener does not break others", () => {
    const bus = new FrameBus();
    const got: Int16Array[] = [];
    const un = bus.subscribe(() => { throw new Error("boom"); });
    bus.subscribe((f) => got.push(f));
    bus.publish(new Int16Array([1]));
    expect(got.length).toBe(1);
    un();
    bus.publish(new Int16Array([2]));
    expect(got.length).toBe(2);
  });
});
