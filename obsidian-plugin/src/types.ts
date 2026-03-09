/** Re-export all types from shared module for backward compatibility. */
export type {
  MeetingNotesSettings,
  TranscriptMessage,
  StatusMessage,
  ErrorMessage,
  PongMessage,
  SilenceMessage,
  ServerMessage,
  StartResponse,
  StopResponse,
  PauseResponse,
  ResumeResponse,
} from "./shared/types";

export { DEFAULT_SETTINGS, serverBaseUrl } from "./shared/types";
