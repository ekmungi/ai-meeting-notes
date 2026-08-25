// src/shared/transcript-render.ts
// Pure rendering of the transcript body from a log of final segments.
//
// Speaker labels are computed at render time rather than baked into the text
// when a segment arrives. That is what makes AssemblyAI's SpeakerRevision
// usable (ISS-011): a correction changes data, and the body is re-rendered.
// Baking labels into strings would leave the label attached to whichever turn
// happened to be a change point, which a revision cannot reliably unpick.

/** One finalized segment, with everything render needs to place it. */
export interface RenderSegment {
  /** Source turn_order; null when no single turn owns the text. */
  turnOrder: number | null;
  text: string;
  speaker: string | null;
  /** True when this segment begins a new paragraph block. */
  startsParagraph: boolean;
  /** Timestamp marker emitted as its own block before this segment. */
  tsMarker: string | null;
}

/** One turn correction from an AssemblyAI SpeakerRevision message. */
export interface SpeakerRevisionEntry {
  turn_order: number;
  speaker_label: string | null;
}

/**
 * Render the transcript body. Blocks (timestamp markers and paragraphs) are
 * each terminated by a blank line; a speaker label is emitted only when the
 * speaker differs from the previously labelled one, tracked across the whole
 * transcript rather than per paragraph.
 * @param segments - Final segments in arrival order.
 * @returns Markdown body, ending in a blank line, or "" when there is nothing.
 */
export function renderTranscriptBody(segments: readonly RenderSegment[]): string {
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let lastSpeaker: string | null = null;

  const closeParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push(paragraph.join(" "));
      paragraph = [];
    }
  };

  for (const seg of segments) {
    if (seg.startsParagraph) closeParagraph();
    if (seg.tsMarker) blocks.push(seg.tsMarker);
    // Show the label on change only (D043).
    if (seg.speaker && seg.speaker !== lastSpeaker) {
      paragraph.push(`**[Speaker ${seg.speaker}]** ${seg.text}`);
      lastSpeaker = seg.speaker;
    } else {
      paragraph.push(seg.text);
    }
  }
  closeParagraph();

  return blocks.map((b) => `${b}\n\n`).join("");
}

/**
 * Apply SpeakerRevision corrections to a segment log, returning a new log.
 * Segments whose turn is not revised, and segments with no turn order, are
 * carried through untouched.
 * @param segments - The current segment log.
 * @param revisions - Corrections keyed by turn_order.
 * @returns A new log; the input is never mutated.
 */
export function applySpeakerRevisions(
  segments: readonly RenderSegment[],
  revisions: readonly SpeakerRevisionEntry[],
): RenderSegment[] {
  if (revisions.length === 0) return [...segments];
  const byTurn = new Map(revisions.map((r) => [r.turn_order, r.speaker_label]));
  return segments.map((seg) =>
    seg.turnOrder !== null && byTurn.has(seg.turnOrder)
      ? { ...seg, speaker: byTurn.get(seg.turnOrder) ?? null }
      : seg,
  );
}
