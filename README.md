# AI Meeting Notes

Real-time meeting transcription for Windows. Captures microphone and system audio simultaneously, then produces clean markdown transcripts with YAML frontmatter — ready for Obsidian or any markdown editor.

Two transcription engines are available:

- **Cloud** (AssemblyAI Universal Streaming v3) — high accuracy, speaker labels, requires internet and API key
- **Local** (faster-whisper) — fully offline, six model sizes from `tiny.en` to `medium.en`

Two distribution modes are available:

- **Desktop application** — dark-themed pywebview GUI with session history and settings
- **Obsidian plugin** — live transcript streaming into vault notes via a local FastAPI server

## Legal Disclaimer

This software records audio from your microphone and system speakers, which may capture the voices and conversations of other meeting participants.

Recording meetings may require **explicit consent from all participants** under applicable laws. Many jurisdictions enforce two-party or all-party consent statutes. **You are solely responsible** for complying with all applicable recording consent laws. The authors and contributors accept no liability for any misuse or legal consequences arising from use of this software.

Before recording any meeting, ensure you have informed all participants and obtained any required consent.

---

## Features

### Core

- Dual audio capture: microphone and system audio (WASAPI loopback) mixed in real time
- Cloud transcription via AssemblyAI Universal Streaming v3 with streaming speaker diarization
- Local offline transcription via faster-whisper (6 model sizes, CPU inference)
- Automatic engine selection: cloud when online and an API key is configured, local otherwise
- Markdown output with YAML frontmatter, 2-minute paragraph grouping, 3 timestamp modes
- Configurable endpointing sensitivity (aggressive / balanced / conservative / very_conservative)
- WAV recording written in parallel alongside every transcript (~1.9 MB/min)
- Silence detection with rolling RMS monitor, status bar indicator, configurable auto-stop (toast at 100 s, stop at 120 s)
- Encrypted API key storage (DPAPI on Windows desktop, `electron.safeStorage` in Obsidian plugin)

### Desktop Application

- Dark-themed pywebview window with session list and live transcript preview
- Icon-only action buttons (play, pause, stop, settings) with Phosphor Icons
- Meeting type quick-selector (Meeting Notes, One to One, Standup, and custom types)
- Session list with document icons and hover actions (open in editor, delete to recycle bin)
- Delete with undo: 5-second toast with slide-out animation, send2trash for safe deletion
- Keyboard shortcuts: Space (pause/resume), Esc (close modal), Ctrl+S (settings), Enter (start)
- Loading spinners on async operations (start, stop, settings save)
- Floating recording indicator: always-on-top mini panel when app loses focus
- Settings panel: API key, output directory, timestamp mode, endpointing, local model size
- Editor launch on recording start; merge dialog on recording stop
- Recording consent checkbox for GDPR and compliance workflows
- Engine selector with privacy indicator (Cloud / Local / Auto)
- Smooth animations: backdrop blur on modals, status flash on recording start
- Settings persisted to `%APPDATA%\ai-meeting-notes\settings.json`

### Obsidian Plugin

- Auto-launches the backend server executable on record; kills it on stop
- Live transcript streamed into a new vault note in real time
- Two-file system: notes file and raw transcript file, with optional merge on stop
- Meeting type modal with custom type support
- Speaker labels rendered inline (cloud diarization)
- Silence detection with Obsidian notice warnings
- Floating recording indicator: always-on-top panel when Obsidian loses focus
- Filename sanitization for Windows-safe meeting type names
- Server port and executable path configurable in plugin settings
- GUI installer with vault auto-detection (single exe)

---

## Requirements

| Requirement | Notes |
|---|---|
| Windows 10 or 11 | WASAPI loopback requires Windows; WebView2 included on Windows 11, [downloadable](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) for Windows 10 |
| Python 3.12+ | Required for backend |
| Active audio output device | WASAPI loopback requires speakers or headphones to be active |
| AssemblyAI API key | Required for cloud engine only; streaming rate is $0.0025/min |
| Node.js 18+ | Required to build the Obsidian plugin from source |

---

## Installation

### 1. Clone the repository

```bash
git clone <repository-url>
cd ai-meeting-notes
```

### 2. Create a Python environment

Using [uv](https://docs.astral.sh/uv/) (recommended):

```bash
uv venv .venv
.venv\Scripts\activate
```

Or using the standard library:

```bash
python -m venv .venv
.venv\Scripts\activate
```

### 3. Install backend dependencies

Install the core package plus the feature sets you need:

```bash
cd backend
pip install -e .
```

| Feature | Extra | Command |
|---|---|---|
| Desktop GUI | `gui` | `pip install -e ".[gui]"` |
| Cloud transcription | (core) | Included in base install |
| Local transcription | `local` | `pip install -e ".[local]"` |
| Obsidian plugin server | `server` | `pip install -e ".[server]"` |
| Development tools | `dev` | `pip install -e ".[dev]"` |

To install all extras at once:

```bash
pip install -e ".[gui,local,server,dev]"
```

### 4. Configure environment variables (CLI only)

The desktop UI and Obsidian plugin store settings in their own persistent stores. For CLI use, create a `.env` file from the provided template:

```bash
copy .env.example .env
```

Edit `.env` and set your AssemblyAI API key:

```ini
ASSEMBLYAI_API_KEY=your_api_key_here
```

See [Configuration Reference](#configuration-reference) for all available variables.

---

## Quick Start

### Desktop application

```bash
cd backend
python -m meeting_notes --gui
```

Click the record button. Select a meeting type when prompted. The transcript streams into the preview panel. Click stop to save the markdown file and optionally open it in your editor.

### Command line

```bash
# Auto-select engine (cloud if online, local otherwise)
python -m meeting_notes

# Force a specific engine
python -m meeting_notes --engine cloud
python -m meeting_notes --engine local

# List available audio devices
python -m meeting_notes --list-devices
```

Press **Ctrl+C** to stop recording. The transcript is saved automatically.

---

## Usage

### CLI Options

```
usage: meeting_notes [-h] [--gui] [--server] [--server-host HOST] [--server-port PORT]
                     [--list-devices] [--engine {cloud,local,auto}]
                     [--output OUTPUT] [--mic MIC] [--system SYSTEM]
                     [--endpointing {aggressive,balanced,conservative,very_conservative}]
                     [--timestamps {none,local_time,elapsed}]
                     [--verbose]

Options:
  --gui                 Launch desktop UI (pywebview)
  --server              Start FastAPI server for Obsidian plugin (127.0.0.1:9876)
  --server-host         Server bind address (default: 127.0.0.1)
  --server-port         Server port (default: 9876)
  --list-devices        List available audio devices and exit
  --engine              Transcription engine: cloud, local, auto (default: auto)
  --output              Output directory for markdown files (default: current directory)
  --mic                 Microphone device index
  --system              System audio (loopback) device index
  --endpointing         Sentence splitting sensitivity (default: conservative)
  --timestamps          Timestamp mode: none, local_time, elapsed (default: elapsed)
  --verbose, -v         Enable verbose logging
```

### Selecting audio devices

```bash
# List all devices with their indices
python -m meeting_notes --list-devices

# Use specific devices
python -m meeting_notes --mic 3 --system 7
```

### Timestamp modes

| Mode | Example output |
|---|---|
| `elapsed` | `**[00:05:00]**` — time from recording start |
| `local_time` | `**[14:35:00]**` — wall-clock time |
| `none` | No timestamp markers |

### Endpointing sensitivity

Controls where the cloud engine splits transcript text at pauses:

| Value | Behaviour |
|---|---|
| `conservative` | Default; best for meetings with natural pauses |
| `very_conservative` | Suited to speakers with long pauses |
| `balanced` | Faster splits, more sentence fragments |
| `aggressive` | Splits at the shortest pauses |

---

## Output Format

Each recording produces a markdown file named `YYYYMMDD_HH-MM - Meeting Type.md`:

```markdown
---
date: 2026-02-17
start_time: "14:30:00"
meeting_type: Standup
end_time: "14:45:12"
duration: "0:15:12"
tags: [meeting-notes]
---

## Notes

(your notes here)

## Summary

### Action Items

- [ ] ...

## Transcript

**[00:00:00]**

Welcome everyone to today's standup. Let's start with updates from the backend team.
We shipped the new API versioning last night and all integration tests are passing.

**[00:05:00]**

Any blockers? The auth migration was flagged last week.
We resolved the token refresh issue yesterday — the fix is in staging now.
```

When speaker diarization is active (cloud engine), each paragraph is prefixed with `**[Speaker A]**`, `**[Speaker B]**`, etc.

---

## Obsidian Plugin Setup

The plugin requires a pre-built server executable. The executable bundles all Python dependencies and requires no Python installation on the machine where Obsidian runs.

### Step 1: Build the server executable

```bash
cd backend
pip install pyinstaller
build.bat server
```

Output: `releases/ai-meeting-notes-server/ai-meeting-notes-server.exe`

### Step 2: Build the plugin

```bash
cd obsidian-plugin
npm install
npm run build
```

Output: `main.js`

### Step 3: Install the plugin in Obsidian

Copy the following files into your vault's plugin directory:

```
<vault>/.obsidian/plugins/ai-meeting-notes/
├── main.js          (built in step 2)
├── manifest.json    (from obsidian-plugin/)
└── styles.css       (from obsidian-plugin/)
```

### Step 4: Configure and use

1. Open **Obsidian Settings > Community Plugins > AI Meeting Notes**
2. Set **Server executable path** to the `ai-meeting-notes-server.exe` from step 1
3. Set your **AssemblyAI API key** (stored encrypted via `electron.safeStorage`)
4. Click the microphone icon in the ribbon to start recording

The plugin spawns the server, polls `/health` until ready (up to 15 seconds), opens a WebSocket connection, and begins streaming the transcript into a new vault note. Clicking the icon again stops recording and kills the server process.

### Server API reference

The server listens on `127.0.0.1:9876` by default. All configuration is passed per-request; the server holds no shared state between sessions.

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Server status: `status`, `version`, recording flag |
| `GET` | `/devices` | Audio device list: index, name, kind, sample rate |
| `POST` | `/session/start` | Start a recording; config in request body |
| `POST` | `/session/stop` | Stop recording; returns `output_path` and `duration_seconds` |
| `POST` | `/session/pause` | Pause recording; returns `elapsed_seconds` |
| `POST` | `/session/resume` | Resume from pause; returns `elapsed_seconds` |
| `WebSocket` | `/ws` | Live transcript stream (UTF-8 text chunks) |

Running the server manually (without the plugin):

```bash
python -m meeting_notes --server
python -m meeting_notes --server --server-port 8080
```

---

## Configuration Reference

All settings can be provided via `.env` or as CLI flags. CLI flags take precedence over environment variables. The desktop UI stores settings separately in `%APPDATA%\ai-meeting-notes\settings.json`.

| Setting | Env variable | CLI flag | Default | Description |
|---|---|---|---|---|
| API key | `ASSEMBLYAI_API_KEY` | — | — | Required for cloud engine |
| Engine | `ENGINE` | `--engine` | `auto` | `cloud`, `local`, or `auto` |
| Output directory | `OUTPUT_DIR` | `--output` | Current directory | Where markdown files are saved |
| Microphone device | `MIC_DEVICE_INDEX` | `--mic` | Auto-detect | Device index from `--list-devices` |
| System audio device | `SYSTEM_AUDIO_DEVICE_INDEX` | `--system` | Auto-detect | WASAPI loopback device index |
| Endpointing | `ENDPOINTING` | `--endpointing` | `conservative` | Sentence splitting sensitivity |
| Timestamps | `TIMESTAMP_MODE` | `--timestamps` | `elapsed` | `none`, `local_time`, or `elapsed` |
| Local model size | `LOCAL_MODEL_SIZE` | — | `small.en` | See model comparison table below |
| Local compute type | `LOCAL_COMPUTE_TYPE` | — | `int8` | Model quantization type |
| Local CPU threads | `LOCAL_CPU_THREADS` | — | `0` (auto) | Thread count for inference; `0` = `cpu_count // 2` |
| Local chunk window | `LOCAL_CHUNK_SECONDS` | — | `10` | Audio accumulation window in seconds before transcription |

### Local model sizes

| Model | Size on disk | RAM usage | Relative speed | Notes |
|---|---|---|---|---|
| `tiny.en` | ~75 MB | ~400 MB | Fastest | Lowest accuracy |
| `base.en` | ~145 MB | ~500 MB | Very fast | Good for fast speech |
| `distil-small.en` | ~330 MB | ~800 MB | Fast | Distilled; close to `small.en` accuracy |
| `small.en` | ~460 MB | ~1 GB | Moderate | Default; good balance |
| `distil-large-v3` | ~1.5 GB | ~2 GB | Moderate | Significantly faster than `medium.en` |
| `medium.en` | ~1.5 GB | ~2 GB | Slower | Highest local accuracy |

Models are downloaded from Hugging Face on first use.

### Cloud vs local comparison

| | Cloud (AssemblyAI) | Local (faster-whisper) |
|---|---|---|
| Accuracy | High | Good (model-dependent) |
| Latency | Real-time streaming | ~10 s chunks |
| Internet required | Yes | No |
| Cost | $0.0025/min | Free |
| Data privacy | Sent to AssemblyAI (SOC 2, TLS, AES-256) | On-device only |
| Speaker diarization | Yes (streaming labels) | No |

---

## Architecture

```
[Desktop UI (pywebview)]   [CLI]   [Obsidian Plugin (TypeScript)]
         |                   |               |
         |                   |   [FastAPI Server (127.0.0.1:9876)]
         |                   |     REST: /health, /devices, /session/*
         |                   |     WebSocket: /ws (transcript stream)
         |                   |               |
         +---------+---------+---------------+
                   |
           [MeetingSession]  -- orchestrates all components
               +-- AudioCapture (PyAudioWPatch)
               |     +-- Microphone stream (16 kHz mono PCM)
               |     +-- System audio loopback (WASAPI)
               |     +-- Mixed audio queue (summed, not interleaved)
               |
               +-- TranscriptionEngine (one of):
               |     +-- CloudEngine (AssemblyAI streaming)
               |     |     +-- Endpointing configuration
               |     |     +-- Fragment merging (combines short utterances)
               |     |     +-- Streaming speaker diarization
               |     +-- LocalEngine (faster-whisper)
               |           +-- 10-second chunked transcription
               |           +-- Bounded queue (maxsize=2, drop-oldest)
               |           +-- Module-level model cache
               |           +-- Thread pool executor
               |
               +-- SilenceMonitor
               |     +-- Rolling RMS energy detection
               |     +-- Configurable threshold and auto-stop timer
               |
               +-- WavWriter
               |     +-- Parallel 16 kHz mono int16 PCM recording
               |
               +-- MarkdownWriter
                     +-- YAML frontmatter
                     +-- 2-minute paragraph grouping
                     +-- 5-minute timestamp markers
                     +-- Deduplication of raw and formatted finals
```

### Engine selection in `auto` mode

1. Check internet connectivity
2. If online and an API key is configured, use the cloud engine
3. Otherwise, fall back to the local engine

---

## Project Structure

```
ai-meeting-notes/
  README.md
  .env.example                       # Environment variable template
  backend/
    pyproject.toml                   # Package metadata and dependencies
    build.bat                        # PyInstaller build script (gui / server targets)
    src/
      meeting_notes/
        __main__.py                  # Entry point (--gui, --server, --engine, ...)
        config.py                    # Configuration from env vars and CLI flags
        connectivity.py              # Internet connectivity check
        session.py                   # Session orchestrator
        audio/
          capture.py                 # Dual-stream WASAPI audio capture
          devices.py                 # Audio device enumeration
          silence.py                 # Rolling RMS silence detection
          wav_writer.py              # Parallel WAV file recording
        engines/
          base.py                    # Abstract engine interface and TranscriptSegment
          cloud.py                   # AssemblyAI streaming engine
          local.py                   # faster-whisper local engine
          selector.py                # Engine selection logic
        output/
          markdown.py                # Incremental markdown writer
          merge.py                   # Notes + transcript merge on stop
        server/                      # FastAPI server for Obsidian plugin
          app.py                     # Routes, lifespan, Uvicorn startup
          models.py                  # Pydantic request and response models
          ws.py                      # WebSocket connection manager
          server_runner.py           # Async session adapter
        ui/                          # Desktop application
          app.py                     # pywebview window
          api.py                     # JavaScript API bridge
          session_runner.py          # Session lifecycle management
          settings_store.py          # Settings persistence (DPAPI encrypted keys)
          config_bridge.py           # Config synchronization
          floating_indicator.py      # Always-on-top recording indicator (win32)
          web/                       # HTML, CSS, JavaScript assets
    tests/                           # 207 tests (pytest)
  obsidian-plugin/
    manifest.json
    package.json                     # esbuild configuration
    styles.css
    src/
      main.ts                        # Plugin entry point, 4-state machine
      settings.ts                    # Settings tab
      server-launcher.ts             # Server process lifecycle
      transcript-view.ts             # Note creation and live transcript
      ws-client.ts                   # WebSocket with heartbeat and reconnect
      types.ts                       # TypeScript interfaces
      crypto.ts                      # API key encryption (electron.safeStorage)
      meeting-type-modal.ts          # Meeting type quick-selector modal
      floating-indicator.ts          # Always-on-top recording indicator
```

---

## Building Portable Executables

Create standalone Windows executables that do not require a Python installation:

```bash
cd backend
pip install pyinstaller

# Desktop GUI application
build.bat gui
# Output: releases/AI Meeting Notes/AI Meeting Notes.exe

# Server only (headless, for use with the Obsidian plugin)
build.bat server
# Output: releases/ai-meeting-notes-server/ai-meeting-notes-server.exe

# Plugin installer
build.bat plugin
# Output: releases/ai-meeting-notes-plugin-installer.exe

# All targets
build.bat all
```

---

## Development

### Running tests

```bash
cd backend
pytest -v
```

207 tests cover configuration, engine behaviour, fragment merging, local transcription, markdown output, session orchestration, server endpoints, WebSocket broadcast, Pydantic models, silence detection, WAV recording, speaker diarization, settings storage, UI crypto, floating indicator, filename sanitization, and session deletion.

### Linting

```bash
cd backend
ruff check src/ tests/
```

### Extending the transcription engines

1. Create a class in `backend/src/meeting_notes/engines/` that extends `TranscriptionEngine`
2. Implement `start()`, `send_audio(chunk: bytes)`, `stop()`, and the `name` property
3. Register the engine in `engines/selector.py`

---

## Troubleshooting

**No system audio captured**

WASAPI loopback requires an active audio output device. Ensure audio is playing through speakers or headphones. Run `--list-devices` to confirm loopback devices appear in the list.

**Cloud engine produces no transcript**

- Confirm the API key is set: `echo %ASSEMBLYAI_API_KEY%`
- Run with `--verbose` to inspect connection logs
- Verify internet connectivity

**Local engine is slow**

The `small.en` model with `int8` quantization runs at roughly 4-5x real-time on a modern Intel i5. If transcription falls behind the recording:

- Switch to `distil-small.en` — similar accuracy, approximately 2x faster
- Switch to `base.en` for the fastest option at lower accuracy
- Try `distil-large-v3` for best quality-to-speed ratio
- Close other CPU-intensive processes

**Desktop UI does not open**

- Verify WebView2 is installed (pre-installed on Windows 11; download for Windows 10)
- Check that Windows Defender is not blocking pywebview
- Run with `--verbose` for detailed error output

**Ctrl+C does not stop recording immediately**

On Windows, the signal handler may take a moment to propagate through the asyncio event loop. Press Ctrl+C a second time if the first does not respond.

---

## Roadmap

| Status | Feature |
|---|---|
| Done | Desktop UI (dark-themed pywebview with icon buttons and animations) |
| Done | Obsidian plugin with auto-launch server executable |
| Done | Pause and resume recording |
| Done | Encrypted API key storage (DPAPI) |
| Done | Silence detection with auto-stop |
| Done | Meeting type selector and smart note naming |
| Done | Separate notes and transcript files |
| Done | WAV recording fallback |
| Done | Cloud speaker diarization with streaming labels |
| Done | Floating recording indicator (desktop and plugin) |
| Done | Keyboard shortcuts (Space, Esc, Ctrl+S, Enter) |
| Done | Session management (open, delete with undo) |
| Done | Plugin GUI installer with vault auto-detection |
| Planned | Internet dropout recovery (buffer WAV, reconnect) |
| Planned | Local 2-speaker diarization |
| Planned | Re-transcribe from WAV with different engine |

---

## License

MIT License. See [LICENSE](LICENSE) for details.
