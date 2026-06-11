/** A saved combination of meeting type + template + stakeholders for one-click setup. */
export interface MeetingPreset {
  name: string;
  meetingType: string;
  templatePath: string;
  participants: string[];
}

/** Plugin settings stored in Obsidian's plugin data (D024: independent client). */
export interface MeetingNotesSettings {
  assemblyaiApiKey: string;
  timestampMode: "none" | "local_time" | "elapsed";
  endpointing: "aggressive" | "balanced" | "conservative" | "very_conservative";
  outputFolder: string;
  transcriptFolder: string;
  showPartials: boolean;
  disclaimerAccepted: boolean;
  meetingTypes: string[];
  meetingTemplatePath: string;
  mergeTranscriptOnStop: boolean;
  silenceTimerSeconds: number;
  recordWav: boolean;
  enableDiarization: boolean;
  floatingIndicatorPosition: "top-right" | "center-right" | "bottom-left";
  stakeholdersFolder: string;
  meetingTypeTemplates: Record<string, string>;
  meetingPresets: MeetingPreset[];
  /** Device ID of the microphone input; "default" = system default. */
  micDeviceId: string;
  /** Human-readable label stored to re-match after Bluetooth ID changes. */
  micDeviceLabel: string;
  /** Whether to capture system audio (loopback) in addition to the microphone. */
  captureSystemAudio: boolean;
}

export const DEFAULT_SETTINGS: MeetingNotesSettings = {
  assemblyaiApiKey: "",
  timestampMode: "elapsed",
  endpointing: "conservative",
  outputFolder: "Meetings",
  transcriptFolder: "",
  showPartials: true,
  disclaimerAccepted: false,
  meetingTypes: ["One to One", "Standup", "Weekly Sync", "Design Review", "Interview", "All Hands"],
  meetingTemplatePath: "",
  mergeTranscriptOnStop: false,
  silenceTimerSeconds: 15,
  recordWav: false,
  enableDiarization: false,
  floatingIndicatorPosition: "top-right",
  stakeholdersFolder: "",
  meetingTypeTemplates: {},
  meetingPresets: [],
  micDeviceId: "default",
  micDeviceLabel: "",
  captureSystemAudio: true,
};

/** WebSocket transcript message; consumed by the transcript view. */
export interface TranscriptMessage {
  type: "transcript";
  text: string;
  is_partial: boolean;
  timestamp_start: number;
  timestamp_end: number;
  speaker: string | null;
}
