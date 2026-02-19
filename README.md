# AI Meeting Notes

Real-time meeting transcription for Windows with a desktop UI. Captures both system audio (remote participants via Teams/Zoom/Meet) and your microphone, producing clean markdown transcripts ready for Obsidian or any markdown editor.

Supports two transcription engines:
- **Cloud** (AssemblyAI) — best accuracy, requires internet and API key
- **Local** (faster-whisper) — fully offline, runs on CPU

## Features

- **Desktop UI** — Dark-themed pywebview application for easy recording control
- **Obsidian Plugin** — Live transcription directly into your vault via WebSocket
- **FastAPI Server** — REST + WebSocket backend for plugin integration
- Dual audio capture: system audio (WASAPI loopback) + microphone
- Real-time streaming transcription (cloud) or chunked transcription (local)
- Automatic engine selection: cloud when online, local as fallback
- Markdown output with YAML frontmatter (Obsidian-compatible)
- Paragraph grouping (new paragraph every 2 minutes)
- Three timestamp modes: elapsed time, wall-clock time, or none
- Configurable endpointing sensitivity for natural sentence boundaries
- Persistent settings stored in `%APPDATA%/ai-meeting-notes/settings.json`

## Requirements

- Windows 10/11 (WASAPI loopback requires Windows)
  - Windows 11: WebView2 pre-installed
  - Windows 10: Download [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)
- Python 3.12+
- An audio output device (speakers or headphones must be active for system audio capture)

### For cloud transcription
- Internet connection
- [AssemblyAI](https://www.assemblyai.com/) API key (streaming at $0.0025/min)

### For local transcription
- `faster-whisper` package (uses ~2GB RAM with `small.en` model)
- First run downloads the model (~500MB)

### For Obsidian plugin server
- `fastapi` and `uvicorn` packages
- Obsidian desktop app (v1.0+)

## Installation

### 1. Clone and set up Python environment

```bash
git clone <repository-url>
cd ai-meeting-notes
```

Create a Python environment (3.12+). If using [uv](https://docs.astral.sh/uv/):

```bash
uv venv .venv
.venv\Scripts\activate
```

### 2. Install dependencies

Core dependencies (cloud engine + desktop UI):

```bash
cd backend
pip install -e .
pip install pywebview
```

For local offline transcription:

```bash
pip install faster-whisper
```

For Obsidian plugin server:

```bash
pip install fastapi "uvicorn[standard]" websockets
```

For development (tests + linting):

```bash
pip install -e ".[dev]"
```

### 3. Configure environment (CLI only)

For CLI usage, copy the example environment file and add your API key:

```bash
copy .env.example .env
```

Edit `.env`:

```ini
# Required for cloud transcription
ASSEMBLYAI_API_KEY=your_api_key_here

# Optional
# OUTPUT_DIR=./notes
# ENGINE=auto
# ENDPOINTING=conservative
# TIMESTAMP_MODE=elapsed
```

## Usage

### Desktop UI (Recommended)

Start the application with the graphical interface:

```bash
python -m meeting_notes --gui
```

The UI provides:
- **Record/Stop buttons** for easy control
- **Settings panel** (gear icon) to configure:
  - AssemblyAI API key
  - Output directory for transcript files
  - Timestamp mode (none / elapsed / local time)
  - Endpointing sensitivity
  - Local model size
- **Status display** showing transcription progress
- **Real-time transcript preview**

Settings persist automatically across sessions.

### Command Line Interface

For advanced users or automation:

```bash
# Auto-select engine (cloud if online, else local)
python -m meeting_notes

# Force cloud engine
python -m meeting_notes --engine cloud

# Force local engine (offline)
python -m meeting_notes --engine local

# With verbose logging
python -m meeting_notes --engine cloud -v
```

Press **Ctrl+C** to stop recording. The transcript is saved automatically.

### List audio devices

```bash
python -m meeting_notes --list-devices
```

Use the device indices with `--mic` and `--system` flags to select specific devices:

```bash
python -m meeting_notes --mic 3 --system 7
```

### Timestamp modes

```bash
# Elapsed time from start: **[00:05:00]**, **[00:10:00]**, ...
python -m meeting_notes --timestamps elapsed

# Wall-clock time: **[14:30:00]**, **[14:35:00]**, ...
python -m meeting_notes --timestamps local_time

# No timestamps
python -m meeting_notes --timestamps none
```

### Endpointing (sentence splitting)

Controls how aggressively the cloud engine splits text at pauses:

```bash
# Conservative (default) — best for meetings with natural pauses
python -m meeting_notes --endpointing conservative

# Very conservative — for speakers with long pauses
python -m meeting_notes --endpointing very_conservative

# Balanced — faster splits, more fragments
python -m meeting_notes --endpointing balanced

# Aggressive — splits at the shortest pauses
python -m meeting_notes --endpointing aggressive
```

### Obsidian Plugin

The plugin auto-launches the backend server when you click Record and kills it when you stop. No manual terminal commands needed.

**Setup:**

1. Build the server-only executable (no UI dependencies):
   ```bash
   cd backend
   pip install pyinstaller
   build.bat server
   ```
   Output: `dist/ai-meeting-notes-server/ai-meeting-notes-server.exe`

2. Install the plugin (sideload):
   ```bash
   cd obsidian-plugin
   npm install
   npm run build
   ```
   Output: `main.js` (bundled plugin code)

   Copy to your vault:
   ```
   .obsidian/plugins/ai-meeting-notes/
   ├── main.js          (from output above)
   ├── manifest.json    (from obsidian-plugin/)
   └── styles.css       (from obsidian-plugin/)
   ```

3. Enable the plugin in Obsidian settings and configure:
   - **Server executable path** — point to `ai-meeting-notes-server.exe`
   - **Server port** — default 9876
   - **Keep server running** — optionally keep the server alive between recordings
   - **AssemblyAI API key** and other transcription preferences

4. Click the microphone ribbon icon to start recording. The plugin will:
   - Spawn the server exe
   - Wait for it to become healthy (up to 15 seconds)
   - Connect WebSocket for live transcript
   - Create a new note in your vault
   - Stream transcript in real-time

5. Click again to stop. The server process is killed (unless "Keep server running" is enabled).

The plugin is an independent client — it stores its own API key and preferences in Obsidian's plugin data. The server is a stateless transcription service that receives all config per-request.

**Server API endpoints:**
- `GET /health` — Server status (status, version, recording flag)
- `GET /devices` — List audio devices (index, name, kind, sample_rate)
- `POST /session/start` — Start recording (config in request body) → StartResponse with engine + output_path
- `POST /session/stop` — Stop recording → StopResponse with output_path + duration_seconds
- `POST /session/pause` — Pause recording → PauseResponse with elapsed_seconds
- `POST /session/resume` — Resume from pause → ResumeResponse with elapsed_seconds
- `WebSocket /ws` — Live transcript stream (utf-8 transcript chunks)

**Running the server manually (advanced):**
```bash
python -m meeting_notes --server
python -m meeting_notes --server --server-port 8080
```

### All CLI options

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
  --server-host         Server bind address (default: 127.0.0.1, localhost only)
  --server-port         Server port (default: 9876)
  --list-devices        List available audio devices and exit
  --engine              Transcription engine: cloud, local, auto (default: auto)
  --output              Output directory for markdown files (default: current directory)
  --mic                 Microphone device index
  --system              System audio (loopback) device index
  --endpointing         Sentence splitting sensitivity (default: conservative)
  --timestamps          Timestamp mode (default: elapsed)
  --verbose, -v         Enable verbose logging
```

## Output Format

Each recording produces a markdown file like `2026-02-17_1430 Meeting Notes.md`:

```markdown
---
date: 2026-02-17
start_time: "14:30:00"
engine: Cloud (AssemblyAI)
timestamp_mode: elapsed
tags: [meeting-notes]
---

# Meeting Notes — 2026-02-17 14:30

## Transcript

**[00:00:00]**

Welcome everyone to today's standup. Let's start with updates from the backend team. We shipped the new API versioning last night and all integration tests are passing.

Thanks for that update. On the frontend side, we're wrapping up the dashboard redesign. Should be ready for QA by end of day tomorrow.

**[00:05:00]**

Any blockers? I know the auth migration was flagged last week. We resolved the token refresh issue yesterday. The fix is in staging now and we'll monitor it through today before promoting to production.

---

*Recording ended at 14:45:12*
*Duration: 0:15:12*
*Segments: 47*
```

## Configuration Reference

All settings can be provided via environment variables in `.env` or as CLI flags. CLI flags take precedence. The desktop UI stores settings in `%APPDATA%/ai-meeting-notes/settings.json`.

| Setting | Env Variable | CLI Flag | Default | Description |
|---------|-------------|----------|---------|-------------|
| API Key | `ASSEMBLYAI_API_KEY` | -- | -- | Required for cloud engine |
| Engine | `ENGINE` | `--engine` | `auto` | `cloud`, `local`, or `auto` |
| Output Dir | `OUTPUT_DIR` | `--output` | Current dir | Where markdown files are saved |
| Mic Device | `MIC_DEVICE_INDEX` | `--mic` | Auto-detect | Microphone device index |
| System Device | `SYSTEM_AUDIO_DEVICE_INDEX` | `--system` | Auto-detect | System audio loopback index |
| Endpointing | `ENDPOINTING` | `--endpointing` | `conservative` | Sentence splitting sensitivity |
| Timestamps | `TIMESTAMP_MODE` | `--timestamps` | `elapsed` | `none`, `local_time`, `elapsed` |
| Local Model | `LOCAL_MODEL_SIZE` | -- | `small.en` | Whisper model size: `tiny.en`, `base.en`, `distil-small.en`, `small.en`, `distil-large-v3`, `medium.en` |
| Local Precision | `LOCAL_COMPUTE_TYPE` | -- | `int8` | Model quantization type |
| Local CPU Threads | `LOCAL_CPU_THREADS` | -- | `0` (auto-detect) | Number of threads for inference; 0 = use cpu_count // 2 |
| Local Chunk Window | `LOCAL_CHUNK_SECONDS` | -- | `10` | Audio accumulation window before transcription (seconds) |

## Architecture

```
[Desktop UI (pywebview)] [CLI] [Obsidian Plugin (TypeScript)]
        |                  |           |
        |                  |    [FastAPI Server (127.0.0.1:9876)]
        |                  |      REST: /health, /devices, /session/*
        |                  |      WebSocket: /ws (transcript stream)
        |                  |           |
        +-------+----------+-----------+
                |
        [MeetingSession]  -- orchestrates everything
            +-- AudioCapture (PyAudioWPatch)
            |     +-- Microphone stream (16kHz mono PCM)
            |     +-- System audio stream (WASAPI loopback)
            |     +-- Mixed audio queue
            |
            +-- TranscriptionEngine (one of):
            |     +-- CloudEngine (AssemblyAI streaming API)
            |     |     +-- Conservative endpointing
            |     |     +-- Fragment merging (combines short utterances)
            |     |     +-- Server-side VAD
            |     +-- LocalEngine (faster-whisper)
            |           +-- 10-second chunked transcription (configurable)
            |           +-- Bounded queue (maxsize=2, drop-oldest policy)
            |           +-- Module-level model cache (persistent across sessions)
            |           +-- Thread pool executor (non-blocking audio ingestion)
            |
            +-- MarkdownWriter
                  +-- YAML frontmatter
                  +-- Paragraph grouping (2-min intervals)
                  +-- Timestamp markers (5-min intervals)
                  +-- Deduplication (handles raw/formatted finals)
```

### How engine selection works

In `auto` mode (default):
1. Check internet connectivity
2. If online and API key is set, use **cloud** engine
3. Otherwise, fall back to **local** engine

### Cloud vs Local comparison

| | Cloud (AssemblyAI) | Local (faster-whisper) |
|---|---|---|
| Accuracy | High (server-grade models) | Good (small.en model) |
| Latency | Real-time streaming | ~10s chunks (configurable, halves call overhead) |
| Internet | Required | Not needed |
| Cost | $0.0025/min (~$6/mo for 40hrs) | Free |
| Privacy | Data sent to AssemblyAI (SOC2, TLS, AES-256) | Fully on-device |
| Diarization | Available (future) | Basic mic/system split (future) |

## Project Structure

```
ai-meeting-notes/
  README.md
  .env.example          # Template for environment configuration
  .gitignore
  backend/
    pyproject.toml      # Project metadata and dependencies
    src/
      meeting_notes/
        __main__.py     # CLI entry point (--gui, --server, --engine, etc.)
        config.py       # Configuration (env vars + CLI flags)
        connectivity.py # Internet connectivity check
        session.py      # Session orchestrator
        audio/
          capture.py    # Dual-stream audio capture (WASAPI)
          devices.py    # Audio device enumeration
        engines/
          base.py       # Abstract engine interface
          cloud.py      # AssemblyAI streaming engine
          local.py      # faster-whisper local engine
          selector.py   # Engine selection logic
        output/
          markdown.py   # Incremental markdown writer
        server/                # FastAPI server for Obsidian plugin
          app.py               # Routes, lifespan, Uvicorn startup
          models.py            # Pydantic request/response models
          ws.py                # WebSocket connection manager + broadcast
          server_runner.py     # Async MeetingSession adapter
        ui/
          app.py        # pywebview window creation
          api.py        # JavaScript API bridge
          session_runner.py    # Session lifecycle management
          settings_store.py    # Settings persistence
          config_bridge.py     # Config synchronization
          web/          # HTML, CSS, JavaScript assets
    tests/
      # 130 tests covering all modules
      test_*.py
  obsidian-plugin/               # Obsidian plugin (TypeScript)
    manifest.json                # Plugin metadata
    package.json                 # Build config (esbuild)
    styles.css                   # Ribbon icon state animations
    src/
      main.ts                   # Plugin entry: 4-state machine, auto-launch
      settings.ts               # Settings tab (exe path, port, API key, etc.)
      server-launcher.ts        # Server child process lifecycle manager
      transcript-view.ts        # Note creation + live transcript updates
      ws-client.ts              # WebSocket with heartbeat + reconnection
      types.ts                  # TypeScript interfaces + settings
```

## Development

### Running tests

```bash
cd backend
pytest -v
```

132 tests should pass. Tests cover configuration, engine behavior, fragment merging, local transcription, markdown output, session orchestration, server endpoints, WebSocket broadcast, and Pydantic models.

### Linting

```bash
cd backend
ruff check src/ tests/
```

### Adding a new engine

1. Create a class extending `TranscriptionEngine` in `engines/`
2. Implement `start()`, `send_audio()`, `stop()`, and `name`
3. Add selection logic in `engines/selector.py`

### Building portable executables

Create standalone Windows executables that don't require Python:

```bash
cd backend
pip install pyinstaller

# Desktop GUI app (default)
build.bat gui
# Output: dist/AI Meeting Notes/AI Meeting Notes.exe

# Server-only (headless, for Obsidian plugin)
build.bat server
# Output: dist/ai-meeting-notes-server/ai-meeting-notes-server.exe
```

## Troubleshooting

### No system audio captured
Make sure audio is actively playing through your speakers or headphones. WASAPI loopback requires an active audio output device. Use `--list-devices` to verify loopback devices are detected.

### Cloud engine produces no output
- Verify your API key: `echo %ASSEMBLYAI_API_KEY%`
- Run with `--verbose` to see connection logs
- Check internet connectivity

### Local engine is slow
The `small.en` model with `int8` quantization should run at 4-5x real-time on a modern Intel i5. If transcription falls behind:
- Try `distil-small.en` — a distilled model roughly as accurate as `small.en` but ~2x faster
- Try `base.en` for the fastest (lower accuracy) option
- For best quality with speed, try `distil-large-v3` — significantly faster than `medium.en`
- Ensure no other CPU-intensive processes are running

### UI doesn't launch
- Verify WebView2 is installed (Windows 11 includes it; download for Windows 10)
- Check Windows Defender isn't blocking pywebview
- Run with `--verbose` to see detailed error messages

### Ctrl+C doesn't stop the recording
On Windows, if Ctrl+C doesn't respond immediately, press it again. The signal handler may take a moment to propagate through the asyncio event loop.

## Roadmap

- [x] Desktop UI (pywebview dark-themed app)
- [x] Obsidian plugin + FastAPI server + auto-launch server exe
- [ ] UI polish (better buttons, animations, keyboard shortcuts, accessibility)
- [ ] Raw audio WAV recording fallback
- [ ] Internet dropout recovery (buffer WAV, stream to AssemblyAI on reconnect)
- [ ] Speaker diarization (cloud: AssemblyAI labels, local: mic/system split)
- [x] Pause/resume recording

## License

MIT License. See [LICENSE](LICENSE) for details.
