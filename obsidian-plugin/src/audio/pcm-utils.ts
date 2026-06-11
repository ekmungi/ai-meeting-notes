// Pure PCM helpers: float32 [-1,1] -> int16, and accumulation of arbitrary
// Float32 blocks into fixed-size Int16Array frames for downstream consumers.

/** Convert one float sample [-1,1] to int16 with clamping. */
export function floatTo16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  if (clamped < 0) {
    return Math.round(clamped * 32768);
  }
  return Math.floor(clamped * 32767);
}

/** Accumulates Float32 blocks and emits fixed-size Int16 frames. */
export class FrameAccumulator {
  private readonly frameSamples: number;
  // Pre-allocated fill buffer: this path runs at sample rate for hours, so no
  // per-sample boxing or per-frame reallocation (GC pauses cause audio glitches).
  private readonly buffer: Int16Array;
  private fill = 0;

  /** @param frameSamples Samples per emitted frame (1600 = 100ms at 16kHz). */
  constructor(frameSamples: number) {
    this.frameSamples = frameSamples;
    this.buffer = new Int16Array(frameSamples);
  }

  /** Push a block; returns zero or more completed frames. */
  push(block: Float32Array): Int16Array[] {
    const frames: Int16Array[] = [];
    for (const s of block) {
      this.buffer[this.fill] = floatTo16(s);
      this.fill += 1;
      if (this.fill === this.frameSamples) {
        frames.push(this.buffer.slice());   // copy out; the fill buffer is reused
        this.fill = 0;
      }
    }
    return frames;
  }
}
