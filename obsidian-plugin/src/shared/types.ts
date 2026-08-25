/** A saved combination of meeting type + template + stakeholders for one-click setup. */
export interface MeetingPreset {
  name: string;
  meetingType: string;
  templatePath: string;
  participants: string[];
}

/**
 * Streaming speech models AssemblyAI currently accepts, mapped to the label
 * shown in settings. Diarization and keyterm prompting work on ALL of these,
 * so the choice trades transcription accuracy against price only (DEC-068).
 * The retired "u3-rt-pro" alias is deliberately absent: it was withdrawn on
 * 2026-09-02 and silently redirected to the 3x-pricier universal-3-5-pro.
 */
export const SPEECH_MODELS = {
  "universal-streaming-english": "English - $0.15/hr (default)",
  "universal-streaming-multilingual": "Multilingual - $0.15/hr (EN, ES, DE, FR, PT, IT)",
  "universal-3-5-pro": "Universal-3.5 Pro - $0.45/hr (highest accuracy, 18 languages)",
} as const;

/** A speech model identifier accepted by the v3 streaming endpoint. */
export type SpeechModel = keyof typeof SPEECH_MODELS;

/** Plugin settings stored in Obsidian's plugin data (D024: independent client). */
export interface MeetingNotesSettings {
  assemblyaiApiKey: string;
  timestampMode: "none" | "local_time" | "elapsed";
  endpointing: "aggressive" | "balanced" | "conservative" | "very_conservative";
  /** Streaming model sent as `speech_model`; sets both accuracy and price. */
  speechModel: SpeechModel;
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
  /** Comma/newline-separated terms (names, jargon) to boost in transcription. */
  keyTerms: string;
}

export const DEFAULT_SETTINGS: MeetingNotesSettings = {
  assemblyaiApiKey: "",
  timestampMode: "elapsed",
  endpointing: "balanced",
  speechModel: "universal-streaming-english",
  outputFolder: "Meetings",
  transcriptFolder: "",
  showPartials: true,
  disclaimerAccepted: false,
  meetingTypes: ["One to One", "Standup", "Weekly Sync", "Design Review", "Interview", "All Hands"],
  meetingTemplatePath: "",
  mergeTranscriptOnStop: false,
  silenceTimerSeconds: 15,
  recordWav: false,
  enableDiarization: true,
  floatingIndicatorPosition: "top-right",
  stakeholdersFolder: "",
  meetingTypeTemplates: {},
  meetingPresets: [],
  micDeviceId: "default",
  micDeviceLabel: "",
  captureSystemAudio: true,
  keyTerms: "",
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
