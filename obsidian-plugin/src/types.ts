/** Plugin settings stored in Obsidian's plugin data (D024: independent client). */
export interface MeetingNotesSettings {
  serverExePath: string;
  serverPort: number;
  keepServerRunning: boolean;
  assemblyaiApiKey: string;
  engine: "cloud" | "local" | "auto";
  timestampMode: "none" | "local_time" | "elapsed";
  endpointing: "aggressive" | "balanced" | "conservative" | "very_conservative";
  outputFolder: string;
  showPartials: boolean;
  localModelSize: string;
  disclaimerAccepted: boolean;
  meetingTypes: string[];
  meetingTemplatePath: string;
  mergeTranscriptOnStop: boolean;
  silenceTimerSeconds: number;
  recordWav: boolean;
  enableDiarization: boolean;
}

export const DEFAULT_SETTINGS: MeetingNotesSettings = {
  serverExePath: "",
  serverPort: 9876,
  keepServerRunning: false,
  assemblyaiApiKey: "",
  engine: "cloud",
  timestampMode: "elapsed",
  endpointing: "conservative",
  outputFolder: "Meetings",
  showPartials: true,
  localModelSize: "small.en",
  disclaimerAccepted: false,
  meetingTypes: ["1:1", "Standup", "Weekly Sync", "Design Review", "Interview", "All Hands"],
  meetingTemplatePath: "",
  mergeTranscriptOnStop: false,
  silenceTimerSeconds: 15,
  recordWav: false,
  enableDiarization: false,
};

/** Build the server base URL from port. */
export function serverBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** WebSocket message types from server. */
export interface TranscriptMessage {
  type: "transcript";
  text: string;
  is_partial: boolean;
  timestamp_start: number;
  timestamp_end: number;
  speaker: string | null;
}

export interface StatusMessage {
  type: "status";
  state: "recording" | "stopped" | "paused";
  elapsed_seconds: number;
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

export interface PongMessage {
  type: "pong";
  timestamp: number;
}

export interface SilenceMessage {
  type: "silence";
  silent_seconds: number;
}

export type ServerMessage = TranscriptMessage | StatusMessage | ErrorMessage | PongMessage | SilenceMessage;

/** REST API response types. */
export interface StartResponse {
  status: string;
  engine: string;
  output_path: string;
}

export interface StopResponse {
  status: string;
  output_path: string;
  duration_seconds: number;
  wav_path: string | null;
}

export interface PauseResponse {
  status: string;
  elapsed_seconds: number;
}

export interface ResumeResponse {
  status: string;
  elapsed_seconds: number;
}

