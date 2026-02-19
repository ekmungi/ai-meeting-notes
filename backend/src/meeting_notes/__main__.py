"""CLI entry point for ai-meeting-notes.

Usage:
    python -m meeting_notes                     # Start recording (auto engine)
    python -m meeting_notes --engine cloud      # Force cloud engine
    python -m meeting_notes --list-devices      # List audio devices
    python -m meeting_notes --output ./notes/   # Set output directory
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import signal
import sys
from pathlib import Path

from meeting_notes.config import Config


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="meeting_notes",
        description="Real-time meeting transcription with AI",
    )
    parser.add_argument(
        "--list-devices",
        action="store_true",
        help="List available audio devices and exit",
    )
    parser.add_argument(
        "--engine",
        choices=["cloud", "local", "auto"],
        default=None,
        help="Transcription engine (default: auto)",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Output directory for markdown files",
    )
    parser.add_argument(
        "--mic",
        type=int,
        default=None,
        help="Microphone device index (use --list-devices to find)",
    )
    parser.add_argument(
        "--system",
        type=int,
        default=None,
        help="System audio (loopback) device index",
    )
    parser.add_argument(
        "--endpointing",
        choices=["aggressive", "balanced", "conservative", "very_conservative"],
        default=None,
        help="How aggressively to split sentences at pauses (default: conservative)",
    )
    parser.add_argument(
        "--timestamps",
        choices=["none", "local_time", "elapsed"],
        default=None,
        help="Timestamp mode: none, local_time (HH:MM:SS), elapsed (from start)",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Enable verbose logging",
    )
    parser.add_argument(
        "--gui",
        action="store_true",
        help="Launch the desktop GUI (requires pywebview)",
    )
    parser.add_argument(
        "--server",
        action="store_true",
        help="Start the FastAPI server for Obsidian plugin (127.0.0.1:9876)",
    )
    parser.add_argument(
        "--server-host",
        type=str,
        default="127.0.0.1",
        help="Server bind address (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--server-port",
        type=int,
        default=9876,
        help="Server port (default: 9876)",
    )
    return parser.parse_args()


def cmd_list_devices() -> None:
    """List all available audio input and loopback devices."""
    from meeting_notes.audio.devices import list_devices

    devices = list_devices()
    if not devices:
        print("No audio devices found.")
        return

    print("\nAvailable audio devices:\n")
    for device in devices:
        print(f"  {device}")
    print()


async def cmd_record(args: argparse.Namespace, config: Config) -> None:
    """Start a recording session."""
    from meeting_notes.audio.devices import AudioDevice
    from meeting_notes.session import MeetingSession

    print(
        "WARNING: Ensure all meeting participants have been informed that this session\n"
        "will be recorded. You are responsible for complying with applicable recording\n"
        "consent laws in your jurisdiction.\n",
        file=sys.stderr,
    )

    # Resolve device selections
    mic_device = None
    system_device = None

    if args.mic is not None:
        import pyaudiowpatch as pyaudio

        p = pyaudio.PyAudio()
        info = p.get_device_info_by_index(args.mic)
        mic_device = AudioDevice(
            index=args.mic,
            name=info["name"],
            max_input_channels=info["maxInputChannels"],
            default_sample_rate=info["defaultSampleRate"],
        )
        p.terminate()

    if args.system is not None:
        import pyaudiowpatch as pyaudio

        p = pyaudio.PyAudio()
        info = p.get_device_info_by_index(args.system)
        system_device = AudioDevice(
            index=args.system,
            name=info["name"],
            max_input_channels=info["maxInputChannels"],
            default_sample_rate=info["defaultSampleRate"],
            is_loopback=bool(info.get("isLoopbackDevice", False)),
        )
        p.terminate()

    session = MeetingSession(
        config=config,
        mic_device=mic_device,
        system_device=system_device,
    )

    # Handle Ctrl+C gracefully
    loop = asyncio.get_event_loop()
    stop_event = asyncio.Event()

    def handle_signal():
        stop_event.set()

    # On Windows, signal handling in asyncio is limited
    if sys.platform == "win32":
        def _win_signal_handler(*_):
            loop.call_soon_threadsafe(stop_event.set)

        signal.signal(signal.SIGINT, _win_signal_handler)
    else:
        loop.add_signal_handler(signal.SIGINT, handle_signal)

    try:
        await session.start()
    except RuntimeError as e:
        print(f"\nError: {e}", file=sys.stderr)
        sys.exit(1)
    except NotImplementedError as e:
        print(f"\nError: {e}", file=sys.stderr)
        print("Hint: Use --engine cloud to use cloud transcription.", file=sys.stderr)
        sys.exit(1)

    # Wait until Ctrl+C
    await stop_event.wait()
    await session.stop()


def main() -> None:
    args = parse_args()

    # Set up logging
    level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    if args.gui:
        from meeting_notes.ui.app import main as gui_main

        gui_main()
        return

    if args.server:
        from meeting_notes.server.app import run_server

        run_server(host=args.server_host, port=args.server_port)
        return

    if args.list_devices:
        cmd_list_devices()
        return

    # Load config
    config = Config.load()

    # Apply CLI overrides
    if args.engine:
        config.engine = args.engine
    if args.output:
        config.output_dir = Path(args.output)
    if args.mic is not None:
        config.mic_device_index = args.mic
    if args.system is not None:
        config.system_audio_device_index = args.system
    if args.endpointing:
        config.endpointing = args.endpointing
    if args.timestamps:
        config.timestamp_mode = args.timestamps

    # Validate
    require_api_key = config.engine in ("cloud", "auto")
    errors = config.validate(require_api_key=require_api_key)
    if errors:
        for err in errors:
            print(f"Error: {err}", file=sys.stderr)
        sys.exit(1)

    print("AI Meeting Notes v0.1.0")
    print(f"Engine: {config.engine}")
    print(f"Output: {config.output_dir}")

    asyncio.run(cmd_record(args, config))


if __name__ == "__main__":
    main()
