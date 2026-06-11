/** Pure formatting utilities shared between plugin and desktop app. */

/** Format a Date as YYYYMMDD_HH-MM for use in file names. */
export function formatFileTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}`
  );
}

/** Sanitize a filename segment; returns "" when nothing usable remains (no fallback). */
export function sanitizeSegment(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[\s-]+|[\s-]+$/g, "");
}

/** Remove characters illegal in Windows/Obsidian filenames. */
export function sanitizeFilename(name: string): string {
  return sanitizeSegment(name) || "Meeting Notes";
}

/**
 * Build the meeting base name: "{timestamp} - {description} - {type}", or
 * "{timestamp} - {type}" when the description is empty/unusable.
 */
export function buildMeetingBaseName(timestamp: string, description: string, type: string): string {
  const safeType = sanitizeFilename(type);
  const safeDesc = sanitizeSegment(description);
  return safeDesc ? `${timestamp} - ${safeDesc} - ${safeType}` : `${timestamp} - ${safeType}`;
}

/** Format a duration in seconds as H:MM:SS. */
export function formatDuration(durationSeconds: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(durationSeconds / 3600);
  const m = Math.floor((durationSeconds % 3600) / 60);
  const s = Math.floor(durationSeconds % 60);
  return `${h}:${pad(m)}:${pad(s)}`;
}

/** Format a Date as YYYY-MM-DD. */
export function formatIsoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Format a Date as HH:MM:SS. */
export function formatIsoTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
