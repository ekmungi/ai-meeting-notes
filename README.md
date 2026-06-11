# AI Meeting Notes

An Obsidian plugin that transcribes meetings in real time using AssemblyAI. Audio is captured directly inside the plugin — microphone and optional system audio — and streamed to AssemblyAI's Universal-Streaming v3 API. Transcripts appear live in a dedicated file while a separate notes file holds your templates, frontmatter, and action items. No server, no executable, nothing to install beyond the plugin itself.

## Features

- **Live transcription** — streamed directly from the plugin to AssemblyAI; no intermediate server
- **Dual audio capture** — microphone (selectable input device) plus optional system loopback to pick up remote participants; falls back to mic-only with a warning if loopback is unavailable
- **Device auto-recovery** — detects when a Bluetooth device drops and reconnects without restarting the session; right-click the status bar mic icon during recording for a quick device picker
- **Two-file system** — a notes file (your template, YAML frontmatter, action items) and a separate transcript file with a bidirectional link between them
- **Meeting types and presets** — define meeting types; presets combine a type, template, and participant list for one-click setup
- **Folder-based templates** — pick a template from a configured vault folder; templates support `{{meeting_type}}`, `{{date}}`, `{{transcript_embed}}`, and `{{participants}}` variables; subfolders are shown in a picker modal
- **Participants multi-select** — select participants from a contacts/stakeholders folder (one `.md` file per person); selected names appear in the notes YAML and in `{{participants}}`
- **Speaker labels** — labels speakers A/B/C on turn change (cloud engine only; optional)
- **Silence detection** — auto-calibrating RMS energy monitor; status bar warning after a configurable threshold, an actionable notice with Extend/Dismiss/Stop buttons at 100 s, auto-stop at 120 s
- **WAV recording** — optionally saves a local WAV file alongside the transcript as a safety net; referenced in the notes frontmatter
- **Pause and resume** — pause mid-meeting without ending the session
- **Floating recording indicator** — always-on-top mini window when Obsidian loses focus; configurable position
- **Merge on stop** — optionally replaces the transcript embed in the notes file with the full transcript text and moves the transcript file to trash
- **Encrypted API key** — stored via Electron `safeStorage`; never written to disk in plaintext

## Requirements

| Requirement | Notes |
|---|---|
| Obsidian desktop | Not supported on mobile |
| Windows 10 or 11 | System audio loopback capture requires Windows; mic-only recording may work on other platforms but is untested |
| AssemblyAI API key | Required; streaming is billed at $0.0025/min |
| Internet connection | Required for transcription |

## Installation

### Via BRAT (recommended)

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs and auto-updates beta plugins straight from this repository.

1. Install the **BRAT** community plugin and enable it.
2. Run the command **BRAT: Add a beta plugin for testing**.
3. Enter `ekmungi/ai-meeting-notes` and confirm. BRAT pulls the latest release.
4. Enable **AI Meeting Notes** under **Settings > Community plugins**.

BRAT checks this repo's releases for updates, so new versions arrive automatically.

### Manual install

1. From the [latest release](https://github.com/ekmungi/ai-meeting-notes/releases/latest), download `main.js`, `manifest.json`, and `styles.css`.
2. Create the folder `<vault>/.obsidian/plugins/ai-meeting-notes/`.
3. Copy the three files into that folder.
4. In Obsidian: **Settings > Community plugins > Installed plugins**, enable **AI Meeting Notes**.

### Build from source

Requires Node.js 18+.

```bash
cd obsidian-plugin
npm install
npm run build
```

The build outputs `main.js` in the `obsidian-plugin/` directory alongside `manifest.json` and `styles.css`.

## Setup

### 1. Accept the disclaimer

Open **Settings > AI Meeting Notes**. Read and check the consent disclaimer before any recording controls become active.

### 2. Enter your AssemblyAI API key

Paste your key in the **AssemblyAI API Key** field. It is stored encrypted on your local machine via Electron `safeStorage` and never leaves the device except as part of a temporary-token exchange with AssemblyAI.

### 3. Key settings

| Setting | Description |
|---|---|
| Notes folder | Vault folder where meeting notes files are created |
| Transcript folder | Separate folder for transcript files; defaults to the notes folder if left empty |
| Microphone | Input device for recording; dropdown lists available devices |
| Capture system audio | Enable loopback capture of remote participants (Windows only) |
| Silence timer | Seconds of silence before a status-bar warning; set to 0 to disable |
| Record WAV | Save a local WAV file alongside the transcript |
| Speaker labels | Show A/B/C speaker labels on turn change |
| Endpointing | Controls how aggressively pauses split sentences (conservative / balanced / aggressive) |
| Merge transcript on stop | Replace the transcript embed with full text and trash the transcript file when recording ends |
| Contacts folder | Vault folder of `.md` files (one per person) used for the participants picker |
| Templates folder | Vault folder of meeting template files |
| Meeting types / Presets | Configure types and one-click presets (type + template + participants) in the settings tab |

## Usage

1. **Start** — click the microphone icon in the ribbon or run **AI Meeting Notes: Start recording** from the command palette.
2. **Meeting type** — a modal appears prompting you to select a meeting type (or add a new one). If a preset matches, select it for instant setup including participants and template.
3. **Participants** (optional) — if a contacts folder is configured and the chosen type has no preset, a participants picker appears next.
4. **Template** (optional) — if a templates folder is configured, a picker lets you choose a template.
5. **Recording** — a red dot appears in the status bar. The transcript streams live into the transcript file. Right-click the status bar icon to switch the microphone device mid-session.
6. **Pause / resume** — use the command palette (**Pause recording** / **Resume recording**) or the floating indicator button.
7. **Stop** — click the ribbon icon again or run **Stop recording**. If merge-on-stop is enabled, the transcript body replaces the embed in the notes file and the transcript file is moved to trash.

## Privacy

Audio captured during recording is streamed to AssemblyAI for transcription. AssemblyAI's data handling is governed by their terms of service and privacy policy. The API key is encrypted at rest on your local machine. You are solely responsible for obtaining recording consent from all meeting participants as required by applicable law.

## Development

### Running tests

```bash
cd obsidian-plugin
npx vitest run
```

51 tests covering the audio pipeline, silence monitor, WAV writer, YAML builder, AssemblyAI client, turn handler, recording session, and settings migration.

### Architecture

```
obsidian-plugin/src/
  main.ts                      Plugin entry: 5-state machine (idle/starting/recording/paused/stopping),
                               ribbon/status-bar wiring, session factory
  audio/
    capture.ts                 Electron desktop capture (loopback) + getUserMedia (mic)
    pipeline.ts                AudioWorklet pipeline; resamples to 16 kHz mono PCM
    devices.ts                 Device enumeration and change-event watcher
    silence-monitor.ts         Rolling RMS silence detection with auto-calibration
    wav-writer.ts              Local WAV file recording (16 kHz mono int16 PCM)
    frame-bus.ts               Event bus connecting audio pipeline to consumers
    pcm-utils.ts               PCM conversion utilities
  transcription/
    assemblyai-client.ts       AssemblyAI Universal-Streaming v3 WebSocket client
    turn-handler.ts            Turn/speaker-change event handling; speaker-label logic
    recording-session.ts       Session lifecycle coordinator
  shared/
    types.ts                   Shared TypeScript types
    yaml-builder.ts            YAML frontmatter generation
    merge-logic.ts             Transcript-into-notes merge on stop
    format-utils.ts            Date/filename formatting utilities
    crypto.ts                  Encryption helpers
  settings.ts                  Settings tab UI
  meeting-type-modal.ts        Meeting type / preset quick-selector
  participants-modal.ts        Multi-select participants picker
  template-picker-modal.ts     Template file picker
  floating-indicator.ts        Always-on-top recording indicator window
  transcript-view.ts           Live transcript leaf view
```

Audio path: `capture.ts` (mic + loopback) -> `pipeline.ts` (resample to PCM) -> `frame-bus.ts` -> `assemblyai-client.ts` (WebSocket) -> `turn-handler.ts` -> transcript file + live view.

## License

MIT License. See [LICENSE](LICENSE) for details.
