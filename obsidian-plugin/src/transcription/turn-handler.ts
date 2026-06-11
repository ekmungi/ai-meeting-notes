// src/transcription/turn-handler.ts
// Converts AssemblyAI v3 Turn events into transcript segments - direct port of
// the turn/fragment logic in backend engines/cloud.py. Pure: all IO injected.

/** AssemblyAI streaming endpointing presets (verbatim from cloud.py). */
export const ENDPOINTING_PRESETS = {
  aggressive:        { end_of_turn_confidence_threshold: 0.3, min_end_of_turn_silence_when_confident: 160, max_turn_silence: 800 },
  balanced:          { end_of_turn_confidence_threshold: 0.4, min_end_of_turn_silence_when_confident: 400, max_turn_silence: 1280 },
  conservative:      { end_of_turn_confidence_threshold: 0.5, min_end_of_turn_silence_when_confident: 560, max_turn_silence: 2000 },
  very_conservative: { end_of_turn_confidence_threshold: 0.7, min_end_of_turn_silence_when_confident: 700, max_turn_silence: 3000 },
} as const;

/** Subset of the AAI v3 Turn message this handler consumes. */
export interface TurnEvent {
  transcript: string;
  turn_is_formatted: boolean;
  end_of_turn: boolean;
  turn_order: number;
}

/** Emitted transcript segment (shape matches the old server TranscriptMessage). */
export interface Segment {
  text: string;
  is_partial: boolean;
  timestamp_start: number;
  timestamp_end: number;
  speaker: string | null;
}

const COMPLETE_TWO_WORD = new Set([
  "thank you", "thanks everyone", "sounds good", "i agree",
  "me too", "okay thanks", "not yet", "got it", "of course",
]);
const FRAGMENT_STARTERS = new Set(["and", "but", "or", "where", "that", "which", "who"]);

/** True if text is a short fragment that should merge with the next segment. */
export function isFragment(text: string): boolean {
  const words = text.replace(/[^\w\s]/g, "").split(/\s+/).filter(Boolean);
  if (words.length <= 1) return true;
  if (words.length === 2) {
    return !COMPLETE_TWO_WORD.has(text.toLowerCase().trim().replace(/[.!?,]+$/, ""));
  }
  if (words.length === 3 && FRAGMENT_STARTERS.has(words[0].toLowerCase())) return true;
  return false;
}

export interface TurnHandlerOptions {
  speakerLabels: boolean;
  forceEndpointIntervalSeconds: number;     // 20s in production
  onSegment: (segment: Segment) => void;
  onForceEndpoint: () => void;              // ask the client to send ForceEndpoint
  now?: () => number;                       // injectable clock (seconds)
}

/** Stateful turn processor: fragment buffering + speaker mapping + force-endpoint timing. */
export class TurnHandler {
  private readonly opts: TurnHandlerOptions;
  private readonly now: () => number;
  private readonly sessionStart: number;
  private lastTurnEndTime: number;
  private fragmentBuffer: string[] = [];
  private fragmentTimestamp = 0;

  constructor(options: TurnHandlerOptions) {
    this.opts = options;
    this.now = options.now ?? (() => performance.now() / 1000);
    this.sessionStart = this.now();
    this.lastTurnEndTime = this.sessionStart;
  }

  /** Process one Turn event from the WebSocket. */
  handleTurn(event: TurnEvent): void {
    const text = event.transcript.trim();
    if (!text) return;
    const elapsed = this.now() - this.sessionStart;

    if (event.turn_is_formatted && event.end_of_turn) {
      // Formatted final - the only event that reaches the transcript file.
      this.lastTurnEndTime = this.now();
      const speaker = this.opts.speakerLabels
        ? String.fromCharCode("A".charCodeAt(0) + (event.turn_order % 26))
        : null;
      this.handleFinal(text, elapsed, speaker);
      return;
    }

    // Live preview (partial or unformatted end-of-turn).
    this.opts.onSegment({ text, is_partial: true, timestamp_start: elapsed, timestamp_end: elapsed, speaker: null });

    // Force a clean endpoint during long monologues (genuine partials only).
    if (!event.end_of_turn && this.now() - this.lastTurnEndTime >= this.opts.forceEndpointIntervalSeconds) {
      this.lastTurnEndTime = this.now();
      this.opts.onForceEndpoint();
    }
  }

  /** Emit any buffered fragments (called on stop and pause). */
  flush(): void {
    if (this.fragmentBuffer.length === 0) return;
    const merged = this.fragmentBuffer.join(" ");
    this.fragmentBuffer = [];
    this.opts.onSegment({
      text: merged, is_partial: false, speaker: null,
      timestamp_start: this.fragmentTimestamp,
      timestamp_end: this.now() - this.sessionStart,
    });
  }

  /** Final-segment path with fragment merge (port of _handle_final_segment). */
  private handleFinal(text: string, elapsed: number, speaker: string | null): void {
    if (isFragment(text)) {
      if (this.fragmentBuffer.length === 0) this.fragmentTimestamp = elapsed;
      this.fragmentBuffer = [...this.fragmentBuffer, text.replace(/[.!?,]+$/, "")];
      return;
    }
    if (this.fragmentBuffer.length > 0) {
      const prefix = this.fragmentBuffer.join(" ");
      // Lowercase the continuation unless it starts with an acronym.
      const adjusted = text[0] === text[0].toUpperCase() && text.slice(0, 2) !== text.slice(0, 2).toUpperCase()
        ? text[0].toLowerCase() + text.slice(1) : text;
      this.fragmentBuffer = [];
      this.opts.onSegment({
        text: `${prefix} ${adjusted}`, is_partial: false, speaker,
        timestamp_start: this.fragmentTimestamp, timestamp_end: elapsed,
      });
    } else {
      this.opts.onSegment({ text, is_partial: false, speaker, timestamp_start: elapsed, timestamp_end: elapsed });
    }
  }
}
