// src/transcription/recording-session.ts
// Orchestrates one recording: capture -> pipeline -> {AAI client, silence
// monitor, WAV writer}. Replaces server-launcher + REST + ws-client.

import { SilenceMonitor } from "../audio/silence-monitor";
import { WavWriter } from "../audio/wav-writer";
import type { Segment } from "./turn-handler";
import type { SpeakerRevisionEntry } from "../shared/transcript-render";

export type SessionState = "idle" | "recording" | "paused" | "stopping";

/** Pipeline surface the session needs (AudioPipeline satisfies this). */
export interface PipelineLike {
  bus: { subscribe(l: (f: Int16Array) => void): () => void };
  start(mic: MediaStream | null, loopback: MediaStream | null): Promise<void>;
  swapMic(stream: MediaStream): void;
  setMuted(muted: boolean): void;
  close(): Promise<void>;
}

/** Client surface the session needs (AssemblyAIClient satisfies this). */
export interface ClientLike {
  start(): Promise<void>;
  sendFrame(frame: Int16Array): void;
  forceEndpoint(): void;
  stop(): Promise<void>;
}

/** Injected IO factories - production wiring lives in main.ts. */
export interface SessionDeps {
  acquireMic(deviceId: string): Promise<MediaStream>;
  acquireLoopback(): Promise<MediaStream | null>;
  createPipeline(): PipelineLike;
  createClient(
    onSegment: (s: Segment) => void,
    onError: (m: string) => void,
    onSpeakerRevision: (revisions: SpeakerRevisionEntry[]) => void,
  ): ClientLike;
}

export interface SessionOptions {
  micDeviceId: string;
  captureSystemAudio: boolean;
  recordWav: boolean;
  silenceThresholdSeconds: number;
  sampleRate: number;
  onSegment: (segment: Segment) => void;
  /** Corrected speaker labels from AssemblyAI, keyed by turn_order. */
  onSpeakerRevision: (revisions: SpeakerRevisionEntry[]) => void;
  onSilence: (silentSeconds: number) => void;
  onWarning: (message: string) => void;
  onError: (message: string) => void;
}

export interface StopResult { durationSeconds: number; wavBuffer: ArrayBuffer | null; }

/** One recording lifecycle: start() -> [pause()/resume()/swapMic()] -> stop(). */
export class RecordingSession {
  state: SessionState = "idle";
  private readonly opts: SessionOptions;
  private readonly deps: SessionDeps;
  private pipeline: PipelineLike | null = null;
  private client: ClientLike | null = null;
  private silence: SilenceMonitor | null = null;
  private wav: WavWriter | null = null;
  private unsubscribe: (() => void) | null = null;
  private startedAt = 0;
  private elapsedBeforePause = 0;

  constructor(options: SessionOptions, deps: SessionDeps) {
    this.opts = options;
    this.deps = deps;
  }

  /** Elapsed recording time in seconds, excluding paused stretches. */
  get elapsedSeconds(): number {
    if (this.state === "recording") {
      return this.elapsedBeforePause + (performance.now() / 1000 - this.startedAt);
    }
    return this.elapsedBeforePause;
  }

  /**
   * Acquire audio streams, open the pipeline and AAI client, begin frame
   * delivery. Throws on hard failure (mic unavailable, client won't start).
   */
  async start(): Promise<void> {
    try {
      const mic = await this.deps.acquireMic(this.opts.micDeviceId);
      const loopback = this.opts.captureSystemAudio
        ? await this.deps.acquireLoopback()
        : null;

      if (this.opts.captureSystemAudio && loopback === null) {
        this.opts.onWarning("System audio capture unavailable - recording microphone only.");
      }

      this.client = this.deps.createClient(this.opts.onSegment, this.opts.onError, this.opts.onSpeakerRevision);
      await this.client.start();

      this.silence = new SilenceMonitor({
        thresholdSeconds: this.opts.silenceThresholdSeconds,
        intervalSeconds: this.opts.silenceThresholdSeconds,
        onSilence: this.opts.onSilence,
      });
      this.wav = this.opts.recordWav ? new WavWriter(this.opts.sampleRate) : null;

      this.pipeline = this.deps.createPipeline();
      this.unsubscribe = this.pipeline.bus.subscribe((frame) => {
        this.client?.sendFrame(frame);
        this.silence?.feedChunk(frame);
        this.wav?.append(frame);
      });
      await this.pipeline.start(mic, loopback);

      this.startedAt = performance.now() / 1000;
      this.elapsedBeforePause = 0;
      this.state = "recording";
    } catch (err) {
      await this.cleanup();
      this.state = "idle";
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * Mute frame delivery and commit the current turn endpoint.
   * The WebSocket connection stays open during pause.
   */
  pause(): void {
    if (this.state !== "recording") return;
    this.elapsedBeforePause = this.elapsedSeconds;
    this.pipeline?.setMuted(true);
    this.client?.forceEndpoint();
    this.state = "paused";
  }

  /** Resume frame delivery after a pause. */
  resume(): void {
    if (this.state !== "paused") return;
    this.startedAt = performance.now() / 1000;
    this.pipeline?.setMuted(false);
    this.state = "recording";
  }

  /**
   * Replace the active mic source at runtime.
   * Used for device switching or reconnect recovery.
   */
  async swapMic(deviceId: string): Promise<void> {
    const stream = await this.deps.acquireMic(deviceId);
    this.pipeline?.swapMic(stream);
  }

  /** Reset the silence timer (called when the Extend button is pressed or
   *  when a transcript segment arrives, indicating speech resumed). */
  resetSilence(): void { this.silence?.resetSilence(); }

  /**
   * Graceful stop: flushes the AAI client, encodes the WAV buffer if enabled,
   * tears down the pipeline. Returns duration and the WAV buffer (null when
   * recordWav is false or no audio was captured).
   */
  async stop(): Promise<StopResult> {
    this.state = "stopping";
    const durationSeconds = this.elapsedSeconds;
    await this.client?.stop().catch(() => undefined);
    const wavBuffer =
      this.wav && this.wav.durationSeconds > 0 ? this.wav.encode() : null;
    await this.cleanup();
    this.state = "idle";
    return { durationSeconds, wavBuffer };
  }

  /** Release all held resources without changing state (caller sets state). */
  private async cleanup(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.pipeline?.close().catch(() => undefined);
    this.pipeline = null;
    this.client = null;
    this.silence = null;
  }
}
