// src/transcription/assemblyai-client.ts
// AssemblyAI Universal-Streaming v3 over a raw browser WebSocket.
// Replaces the Python SDK: temp-token auth, binary PCM16 frames, JSON events.
// Reconnects with a frame ring buffer so brief network blips lose no audio.

import { ENDPOINTING_PRESETS, TurnHandler } from "./turn-handler";
import type { Segment, TurnEvent } from "./turn-handler";
import type { SpeechModel } from "../shared/types";
import type { SpeakerRevisionEntry } from "../shared/transcript-render";

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 500;       // 0.5s, 1s, 2s backoff
const RING_BUFFER_FRAMES = 150;            // 15s of 100ms frames kept while disconnected
const FORCE_ENDPOINT_INTERVAL_S = 20;
// AssemblyAI's end-of-session speaker refinement adds roughly 400ms and its
// SpeakerRevision lands before Termination, so stop() waits for that handshake.
// Capped so a dead connection cannot wedge the stop path (ISS-011).
const TERMINATION_TIMEOUT_MS = 2000;
// Server-side backstop: if Obsidian crashes mid-recording nothing sends
// Terminate, and the session would otherwise bill to the 3-hour cap. Set well
// above the pause grace period so a normal pause disconnects on our terms
// first (ISS-013).
const INACTIVITY_TIMEOUT_S = 300;

/** Returns a short-lived streaming token (IO injected for tests; prod uses requestUrl). */
export type TokenProvider = () => Promise<string>;

/**
 * Models that format their finals unconditionally and do not accept the
 * `format_turns` parameter (AssemblyAI documents it as Universal Streaming
 * English/Multilingual only).
 *
 * Membership is an opt-OUT rather than an opt-in so a model added to
 * SPEECH_MODELS later gets `format_turns` by default. The two mistakes are not
 * symmetric: a redundant parameter is ignored by the server, whereas a missing
 * one silently discards the entire transcript (ISS-018).
 */
const MODELS_FORMATTING_UNCONDITIONALLY: ReadonlySet<SpeechModel> = new Set<SpeechModel>([
  "universal-3-5-pro",
]);

/**
 * Build the v3 streaming URL for the chosen model, with diarization,
 * turn-silence endpointing, and keyterm boosting baked in.
 * @param speechModel - Model to bill and transcribe against; all supported
 *   models accept speaker_labels and keyterms_prompt (DEC-068).
 */
export function buildStreamUrl(
  token: string,
  sampleRate: number,
  endpointing: keyof typeof ENDPOINTING_PRESETS,
  speakerLabels: boolean,
  keyTerms: string[],
  speechModel: SpeechModel,
): string {
  const preset = ENDPOINTING_PRESETS[endpointing] ?? ENDPOINTING_PRESETS.conservative;
  const params = new URLSearchParams({
    sample_rate: String(sampleRate),
    speech_model: speechModel,
    inactivity_timeout: String(INACTIVITY_TIMEOUT_S),
    min_turn_silence: String(preset.min_turn_silence),
    max_turn_silence: String(preset.max_turn_silence),
    token,
  });
  // Universal Streaming defaults format_turns to FALSE, and turn-handler.ts
  // commits a segment to the transcript file only when turn_is_formatted is
  // true. Omitting this means live partials render while nothing is ever
  // saved - the file keeps its header and no body (ISS-018).
  if (!MODELS_FORMATTING_UNCONDITIONALLY.has(speechModel)) params.set("format_turns", "true");
  if (speakerLabels) params.set("speaker_labels", "true");
  // AssemblyAI expects keyterms_prompt as ONE JSON-array value, not repeated
  // params (repeated params fail server validation: "invalid JSON array").
  if (keyTerms.length > 0) params.set("keyterms_prompt", JSON.stringify(keyTerms));
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
  /** Streaming model to transcribe against. */
  speechModel: SpeechModel;
  /** Whether to request speaker diarization labels. */
  speakerLabels: boolean;
  /** Key terms to boost recognition (names, jargon); may be empty. */
  keyTerms: string[];
  /** Called with each finalized transcript segment. */
  onSegment: (segment: Segment) => void;
  /** Called with corrected speaker labels when AssemblyAI revises earlier turns. */
  onSpeakerRevision: (revisions: SpeakerRevisionEntry[]) => void;
  /** Called with a human-readable message when the connection cannot be restored. */
  onError: (message: string) => void;
  /** How long stop() waits for Termination before closing anyway (default 2000ms). */
  terminationTimeoutMs?: number;
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
  /** Resolves the in-flight stop() wait when Termination arrives. */
  private terminationResolve: (() => void) | null = null;

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
    // Hold the socket open: the end-of-session SpeakerRevision arrives after
    // Terminate and before Termination. Closing here would discard it.
    await this.awaitTermination();
    this.ws?.close();
    this.ws = null;
    this.turns.flush();
  }

  /**
   * Resolve once the server confirms Termination, or after the timeout.
   * Returns immediately when there is no open socket to wait on.
   */
  private awaitTermination(): Promise<void> {
    if (!this.ws || this.ws.readyState !== 1) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = (): void => {
        this.terminationResolve = null;
        clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(done, this.opts.terminationTimeoutMs ?? TERMINATION_TIMEOUT_MS);
      this.terminationResolve = done;
    });
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
    const ws = this.opts.wsFactory(buildStreamUrl(token, this.opts.sampleRate, this.opts.endpointing, this.opts.speakerLabels, this.opts.keyTerms, this.opts.speechModel));
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
      if (msg.type === "Turn") {
        this.turns.handleTurn(msg as unknown as TurnEvent);
        return;
      }
      if (msg.type === "SpeakerRevision") {
        const revisions = (msg as { revisions?: SpeakerRevisionEntry[] }).revisions;
        if (Array.isArray(revisions) && revisions.length > 0) this.opts.onSpeakerRevision(revisions);
        return;
      }
      if (msg.type === "Termination") this.terminationResolve?.();
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
