// src/transcription/assemblyai-client.ts
// AssemblyAI Universal-Streaming v3 over a raw browser WebSocket.
// Replaces the Python SDK: temp-token auth, binary PCM16 frames, JSON events.
// Reconnects with a frame ring buffer so brief network blips lose no audio.

import { ENDPOINTING_PRESETS, TurnHandler } from "./turn-handler";
import type { Segment, TurnEvent } from "./turn-handler";

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 500;       // 0.5s, 1s, 2s backoff
const RING_BUFFER_FRAMES = 150;            // 15s of 100ms frames kept while disconnected
const FORCE_ENDPOINT_INTERVAL_S = 20;

/** Returns a short-lived streaming token (IO injected for tests; prod uses requestUrl). */
export type TokenProvider = () => Promise<string>;

/**
 * Build the v3 streaming URL with endpointing params baked in.
 * @param token - Short-lived streaming token from AssemblyAI.
 * @param sampleRate - Audio sample rate in Hz (e.g. 16000).
 * @param endpointing - Preset name from ENDPOINTING_PRESETS.
 * @returns Full wss:// URL ready for WebSocket construction.
 */
export function buildStreamUrl(token: string, sampleRate: number, endpointing: keyof typeof ENDPOINTING_PRESETS): string {
  const preset = ENDPOINTING_PRESETS[endpointing] ?? ENDPOINTING_PRESETS.conservative;
  const params = new URLSearchParams({
    sample_rate: String(sampleRate),
    format_turns: "true",
    end_of_turn_confidence_threshold: String(preset.end_of_turn_confidence_threshold),
    min_end_of_turn_silence_when_confident: String(preset.min_end_of_turn_silence_when_confident),
    max_turn_silence: String(preset.max_turn_silence),
    token,
  });
  return `wss://streaming.assemblyai.com/v3/ws?${params.toString()}`;
}

/** Options for constructing an AssemblyAIClient. */
export interface AssemblyAIClientOptions {
  /** Async function that returns a fresh short-lived streaming token. */
  tokenProvider: TokenProvider;
  /** Factory to create a WebSocket (injected for tests; defaults to globalThis.WebSocket in prod). */
  wsFactory: (url: string) => WebSocket;
  /** Audio sample rate in Hz. */
  sampleRate: number;
  /** Endpointing sensitivity preset. */
  endpointing: keyof typeof ENDPOINTING_PRESETS;
  /** Whether to request speaker diarization labels. */
  speakerLabels: boolean;
  /** Called with each finalized transcript segment. */
  onSegment: (segment: Segment) => void;
  /** Called with a human-readable message when the connection cannot be restored. */
  onError: (message: string) => void;
}

/**
 * Streaming client for AssemblyAI v3: start() -> sendFrame()* -> stop().
 * Auto-reconnects on unexpected close, buffering frames in a ring buffer
 * so no audio is dropped during brief network blips.
 */
export class AssemblyAIClient {
  private readonly opts: AssemblyAIClientOptions;
  private readonly turns: TurnHandler;
  private ws: WebSocket | null = null;
  private stopping = false;
  private failed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private ring: Int16Array[] = [];

  constructor(options: AssemblyAIClientOptions) {
    this.opts = options;
    this.turns = new TurnHandler({
      speakerLabels: options.speakerLabels,
      forceEndpointIntervalSeconds: FORCE_ENDPOINT_INTERVAL_S,
      onSegment: options.onSegment,
      onForceEndpoint: () => this.sendJson({ type: "ForceEndpoint" }),
    });
  }

  /**
   * Fetch a token and open the WebSocket.
   * Throws if the token fetch fails.
   */
  async start(): Promise<void> {
    this.stopping = false;
    this.failed = false;
    await this.connect();
  }

  /**
   * Queue/send one 100ms PCM16 frame.
   * Buffered in the ring while the socket is down; replayed on reconnect.
   * @param frame - Raw PCM16 audio samples as Int16Array.
   */
  sendFrame(frame: Int16Array): void {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength));
    } else if (!this.stopping) {
      this.ring = [...this.ring.slice(-(RING_BUFFER_FRAMES - 1)), frame];
    }
  }

  /**
   * Ask AssemblyAI to finalize the current turn (useful on pause).
   */
  forceEndpoint(): void { this.sendJson({ type: "ForceEndpoint" }); }

  /**
   * Graceful shutdown: flush turn, terminate session, emit buffered fragments.
   */
  async stop(): Promise<void> {
    // Cancel any pending reconnect timer before it spawns a new socket.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopping = true;
    this.sendJson({ type: "ForceEndpoint" });
    this.sendJson({ type: "Terminate" });
    this.ws?.close();
    this.ws = null;
    this.turns.flush();
  }

  /** Send a JSON control message if the socket is open. */
  private sendJson(obj: object): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  /**
   * Emit a terminal error Notice at most once per session.
   * @param message - Human-readable error message for the user.
   */
  private fail(message: string): void {
    if (this.failed || this.stopping) return;
    this.failed = true;
    this.opts.onError(message);
  }

  /**
   * Fetch a token, construct the WebSocket, and wire up event handlers.
   * Called on start() and each reconnect attempt.
   */
  private async connect(): Promise<void> {
    const token = await this.opts.tokenProvider();
    // stop() may have raced the async token fetch — do not open a new socket.
    if (this.stopping) return;
    const ws = this.opts.wsFactory(buildStreamUrl(token, this.opts.sampleRate, this.opts.endpointing));
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      // Replay frames buffered while disconnected, oldest first.
      const buffered = this.ring;
      this.ring = [];
      for (const f of buffered) this.sendFrame(f);
    };

    ws.onmessage = (e: { data: unknown }) => {
      let msg: { type?: string; error?: unknown };
      try {
        msg = JSON.parse(typeof e.data === "string" ? e.data : "");
      } catch {
        return;   // non-JSON frames are never expected; ignore
      }
      if (msg.type === "Error") {
        this.fail(`AssemblyAI error: ${String(msg.error ?? "unknown")}`);
        return;
      }
      if (msg.type === "Turn") this.turns.handleTurn(msg as unknown as TurnEvent);
    };

    ws.onerror = () => { /* onclose always follows; handled there */ };

    ws.onclose = () => {
      if (this.stopping) return;
      if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
        this.fail(
          "Transcription connection lost and could not be restored. " +
          "Recording continues; WAV audio is preserved if enabled."
        );
        return;
      }
      const delay = RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt;
      this.reconnectAttempt += 1;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.stopping) {
          this.connect().catch(() => {
            this.fail(
              "Transcription reconnect failed (token fetch). " +
              "Recording continues; WAV audio is preserved if enabled."
            );
          });
        }
      }, delay);
    };
  }
}
