"""FastAPI application — server entry point for Obsidian plugin integration.

Start with: python -m meeting_notes --server
Listens on 127.0.0.1:9876 (localhost only).
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket
from fastapi.responses import JSONResponse

from meeting_notes.server.models import (
    DeviceInfo,
    DevicesResponse,
    HealthResponse,
    PauseResponse,
    ResumeResponse,
    StartRequest,
    StartResponse,
    StopResponse,
)
from meeting_notes.server.server_runner import ServerRunner
from meeting_notes.server.ws import ConnectionManager, websocket_endpoint

logger = logging.getLogger(__name__)

# Module-level singletons, initialized during lifespan
_ws_manager: ConnectionManager | None = None
_runner: ServerRunner | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize and tear down server resources."""
    global _ws_manager, _runner
    _ws_manager = ConnectionManager()
    _runner = ServerRunner(_ws_manager)
    logger.info("Server started on http://127.0.0.1:9876")
    yield
    # Shutdown: stop any active session
    if _runner and _runner.is_recording:
        await _runner.stop()
    logger.info("Server shutting down")


app = FastAPI(
    title="AI Meeting Notes Server",
    version="0.1.0",
    lifespan=lifespan,
)


@app.get("/health", response_model=HealthResponse)
async def health():
    return HealthResponse(
        recording=_runner.is_recording if _runner else False,
    )


@app.get("/devices", response_model=DevicesResponse)
async def devices():
    try:
        from meeting_notes.audio.devices import list_devices

        device_list = list_devices()
        return DevicesResponse(
            devices=[
                DeviceInfo(
                    index=d.index,
                    name=d.name,
                    kind="loopback" if d.is_loopback else "input",
                    sample_rate=int(d.default_sample_rate),
                )
                for d in device_list
            ]
        )
    except Exception:
        logger.exception("Failed to enumerate devices")
        return JSONResponse(
            status_code=500,
            content={"error": "Device enumeration failed"},
        )


@app.post("/session/start", response_model=StartResponse)
async def session_start(req: StartRequest):
    if not _runner:
        return JSONResponse(status_code=500, content={"error": "Server not initialized"})

    if _runner.is_recording:
        return JSONResponse(status_code=409, content={"error": "Already recording"})

    # Build Config from request body (stateless server, D024)
    from meeting_notes.config import Config

    config = Config(
        assemblyai_api_key=req.assemblyai_api_key,
        engine=req.engine,
        timestamp_mode=req.timestamp_mode,
        endpointing=req.endpointing,
        mic_device_index=req.mic_device_index,
        system_audio_device_index=req.system_device_index,
        local_model_size=req.local_model_size,
        silence_threshold_seconds=req.silence_threshold_seconds,
    )

    # Validate config
    require_api_key = config.engine in ("cloud", "auto")
    errors = config.validate(require_api_key=require_api_key, check_output_dir=False)
    if errors:
        return JSONResponse(status_code=400, content={"error": "; ".join(errors)})

    # Resolve device objects if indices provided
    mic_device = None
    system_device = None

    if req.mic_device_index is not None or req.system_device_index is not None:
        try:
            import pyaudiowpatch as pyaudio
            p = pyaudio.PyAudio()
            try:
                if req.mic_device_index is not None:
                    from meeting_notes.audio.devices import AudioDevice
                    info = p.get_device_info_by_index(req.mic_device_index)
                    mic_device = AudioDevice(
                        index=req.mic_device_index,
                        name=info["name"],
                        max_input_channels=info["maxInputChannels"],
                        default_sample_rate=info["defaultSampleRate"],
                    )
                if req.system_device_index is not None:
                    from meeting_notes.audio.devices import AudioDevice
                    info = p.get_device_info_by_index(req.system_device_index)
                    system_device = AudioDevice(
                        index=req.system_device_index,
                        name=info["name"],
                        max_input_channels=info["maxInputChannels"],
                        default_sample_rate=info["defaultSampleRate"],
                        is_loopback=bool(info.get("isLoopbackDevice", False)),
                    )
            finally:
                p.terminate()
        except Exception:
            logger.exception("Invalid device index")
            return JSONResponse(status_code=400, content={"error": "Invalid device index"})

    try:
        engine_name = await _runner.start(config, mic=mic_device, system=system_device)
    except RuntimeError as exc:
        return JSONResponse(status_code=409, content={"error": str(exc)})
    except Exception as exc:
        logger.exception("Failed to start session")
        return JSONResponse(status_code=500, content={"error": f"Failed to start session: {exc}"})

    return StartResponse(
        engine=engine_name,
        output_path=_runner.output_path,
    )


@app.post("/session/stop", response_model=StopResponse)
async def session_stop():
    if not _runner:
        return JSONResponse(status_code=500, content={"error": "Server not initialized"})

    if not _runner.is_recording:
        return JSONResponse(status_code=409, content={"error": "Not recording"})

    elapsed = await _runner.stop()

    return StopResponse(
        output_path=_runner.output_path,
        duration_seconds=round(elapsed, 1),
    )


@app.post("/session/pause", response_model=PauseResponse)
async def session_pause():
    if not _runner:
        return JSONResponse(status_code=500, content={"error": "Server not initialized"})

    if not _runner.is_recording:
        return JSONResponse(status_code=409, content={"error": "Not recording"})

    if _runner.is_paused:
        return JSONResponse(status_code=409, content={"error": "Already paused"})

    try:
        elapsed = await _runner.pause()
    except RuntimeError as exc:
        return JSONResponse(status_code=409, content={"error": str(exc)})
    except Exception:
        logger.exception("Failed to pause session")
        return JSONResponse(status_code=500, content={"error": "Failed to pause session"})

    return PauseResponse(elapsed_seconds=elapsed)


@app.post("/session/resume", response_model=ResumeResponse)
async def session_resume():
    if not _runner:
        return JSONResponse(status_code=500, content={"error": "Server not initialized"})

    if not _runner.is_paused:
        return JSONResponse(status_code=409, content={"error": "Not paused"})

    try:
        elapsed = await _runner.resume()
    except RuntimeError as exc:
        return JSONResponse(status_code=409, content={"error": str(exc)})
    except Exception:
        logger.exception("Failed to resume session")
        return JSONResponse(status_code=500, content={"error": "Failed to resume session"})

    return ResumeResponse(elapsed_seconds=elapsed)


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    if not _ws_manager:
        await ws.close(code=1013)  # 1013 = Try Again Later
        return
    await websocket_endpoint(ws, _ws_manager)


_ALLOWED_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})


def run_server(host: str = "127.0.0.1", port: int = 9876) -> None:
    """Start the Uvicorn server (blocking call). Localhost only."""
    import logging
    import sys
    from pathlib import Path

    if host not in _ALLOWED_HOSTS:
        raise ValueError(
            f"Server must bind to localhost only for security, got: {host!r}. "
            "Allowed: 127.0.0.1, ::1, localhost"
        )

    # PyInstaller windowed/noconsole mode sets sys.stdout and sys.stderr to None.
    # Uvicorn's DefaultFormatter calls sys.stderr.isatty() during init, which
    # crashes with AttributeError. Redirect None streams to a log file so the
    # server can start and its output is still inspectable for debugging.
    if sys.stdout is None or sys.stderr is None:
        log_path = Path.home() / "ai-meeting-notes-server.log"
        log_file = open(log_path, "a", encoding="utf-8", buffering=1)  # noqa: SIM115
        if sys.stdout is None:
            sys.stdout = log_file
        if sys.stderr is None:
            sys.stderr = log_file

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        stream=sys.stderr,
    )

    import uvicorn

    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level="info",
    )
