"""Engine selection logic — choose cloud or local based on config and connectivity."""

from __future__ import annotations

import logging

from meeting_notes.config import Config
from meeting_notes.connectivity import check_connectivity
from meeting_notes.engines.base import TranscriptionEngine
from meeting_notes.engines.cloud import CloudEngine

logger = logging.getLogger(__name__)


def select_engine(config: Config, on_status=None) -> TranscriptionEngine:
    """Select the appropriate transcription engine based on config and connectivity."""
    engine_choice = config.engine

    if engine_choice == "cloud":
        return _create_cloud_engine(config)

    if engine_choice == "local":
        return _create_local_engine(config, on_status=on_status)

    # "auto" mode — try cloud first, fall back to local
    if check_connectivity() and config.assemblyai_api_key:
        logger.info("Internet available — using cloud engine")
        return _create_cloud_engine(config)

    if not check_connectivity():
        logger.warning("No internet detected")
    if not config.assemblyai_api_key:
        logger.warning("No AssemblyAI API key configured")

    logger.info("Attempting local engine fallback")
    return _create_local_engine(config, on_status=on_status)


def _create_cloud_engine(config: Config) -> CloudEngine:
    return CloudEngine(
        api_key=config.assemblyai_api_key,
        sample_rate=config.sample_rate,
        endpointing=config.endpointing,
    )


def _create_local_engine(
    config: Config,
    on_status=None,
) -> TranscriptionEngine:
    """Create local engine. Raises RuntimeError if not available."""
    try:
        from faster_whisper import WhisperModel  # noqa: F401
    except ImportError:
        raise RuntimeError(
            "Local engine requires 'faster-whisper' which is not installed.\n"
            "Install it with: uv pip install faster-whisper\n"
            "Or use --engine cloud to force cloud transcription."
        )

    from meeting_notes.engines.local import LocalEngine

    return LocalEngine(
        sample_rate=config.sample_rate,
        model_size=config.local_model_size,
        compute_type=config.local_compute_type,
        cpu_threads=config.local_cpu_threads,
        chunk_seconds=config.local_chunk_seconds,
        on_status=on_status,
    )
