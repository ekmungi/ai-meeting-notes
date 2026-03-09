/** Pure formatting utilities shared between plugin and desktop app. */

/** Format a Date as YYYYMMDD_HH-MM for use in file names. */
export function formatFileTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}`
  );
}

/** Remove characters illegal in Windows/Obsidian filenames. */
export function sanitizeFilename(name: string): string {
  const sanitized = name
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[- ]+|[- ]+$/g, "");
  return sanitized || "Meeting Notes";
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
