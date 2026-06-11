// src/audio/pipeline.ts
// Web Audio graph: source streams -> AudioWorklet tap -> 100ms int16 frames
// on the FrameBus. Browser-API adapter - excluded from unit coverage.

import { FrameAccumulator } from "./pcm-utils";
import { FrameBus } from "./frame-bus";

export const SAMPLE_RATE = 16000;
export const FRAME_SAMPLES = 1600;          // 100ms at 16kHz (matches silence calibration)

// Worklet runs in a separate scope; it averages channels to mono and posts
// raw Float32 blocks to the main thread, where tested pure code does the rest.
const WORKLET_SOURCE = `
class TapProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input.length > 0) {
      const ch = input;
      const mono = new Float32Array(ch[0].length);
      for (let i = 0; i < mono.length; i++) {
        let sum = 0;
        for (let c = 0; c < ch.length; c++) sum += ch[c][i];
        mono[i] = sum / ch.length;
      }
      this.port.postMessage(mono, [mono.buffer]);
    }
    return true;
  }
}
registerProcessor("tap-processor", TapProcessor);
`;

/** Owns the AudioContext graph; publishes PCM frames; supports live source swap. */
export class AudioPipeline {
  readonly bus = new FrameBus();
  private ctx: AudioContext | null = null;
  private tap: AudioWorkletNode | null = null;
  private micNode: MediaStreamAudioSourceNode | null = null;
  private loopbackNode: MediaStreamAudioSourceNode | null = null;
  private acc = new FrameAccumulator(FRAME_SAMPLES);
  private muted = false;

  /** Build the graph. Either stream may be absent (mic-only fallback). */
  async start(mic: MediaStream | null, loopback: MediaStream | null): Promise<void> {
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const blob = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    try { await this.ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }

    this.tap = new AudioWorkletNode(this.ctx, "tap-processor");
    this.tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (this.muted) return;
      for (const frame of this.acc.push(e.data)) this.bus.publish(frame);
    };
    if (mic) this.micNode = this.connectStream(mic);
    if (loopback) this.loopbackNode = this.connectStream(loopback);
  }

  /** Swap the mic source live (device switch / reconnect); old track is stopped. */
  swapMic(stream: MediaStream): void {
    if (!this.ctx || !this.tap) return;
    this.micNode?.disconnect();
    this.micNode?.mediaStream.getTracks().forEach((t) => t.stop());
    this.micNode = this.connectStream(stream);
  }

  /** Pause/resume frame emission (the WS stays open while paused). */
  setMuted(muted: boolean): void { this.muted = muted; }

  /** Tear down graph and stop all tracks. */
  async close(): Promise<void> {
    for (const node of [this.micNode, this.loopbackNode]) {
      node?.disconnect();
      node?.mediaStream.getTracks().forEach((t) => t.stop());
    }
    this.micNode = null; this.loopbackNode = null;
    this.tap?.disconnect(); this.tap = null;
    await this.ctx?.close(); this.ctx = null;
  }

  private connectStream(stream: MediaStream): MediaStreamAudioSourceNode {
    // Multiple sources connected to the same worklet input are summed by
    // Web Audio - equivalent to the Python int32-sum-then-clip mix (D019).
    const node = this.ctx!.createMediaStreamSource(stream);
    node.connect(this.tap!);
    return node;
  }
}
