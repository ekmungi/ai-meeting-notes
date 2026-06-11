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
  private pending: number[] = [];

  /** @param frameSamples Samples per emitted frame (1600 = 100ms at 16kHz). */
  constructor(frameSamples: number) {
    this.frameSamples = frameSamples;
  }

  /** Push a block; returns zero or more completed frames. */
  push(block: Float32Array): Int16Array[] {
    for (const s of block) this.pending.push(floatTo16(s));
    const frames: Int16Array[] = [];
    while (this.pending.length >= this.frameSamples) {
      frames.push(new Int16Array(this.pending.slice(0, this.frameSamples)));
      this.pending = this.pending.slice(this.frameSamples);
    }
    return frames;
  }
}
