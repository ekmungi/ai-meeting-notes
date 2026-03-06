"""Configuration management — loads from .env and environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field as dc_field
from pathlib import Path

from dotenv import load_dotenv


@dataclass
class Config:
    assemblyai_api_key: str = dc_field(default="", repr=False)
    output_dir: Path = dc_field(default_factory=lambda: Path.cwd())
    engine: str = "auto"  # "cloud", "local", "auto"
    sample_rate: int = 16000
    mic_device_index: int | None = None
    system_audio_device_index: int | None = None
    endpointing: str = "conservative"
    local_model_size: str = "small.en"
    local_compute_type: str = "int8"
    local_cpu_threads: int = 0   # 0 = auto-detect (os.cpu_count() // 2)
    local_chunk_seconds: int = 10  # Audio accumulation window before transcription
    timestamp_mode: str = "elapsed"  # "none", "local_time", "elapsed"
    silence_threshold_seconds: int = 15
    record_wav: bool = False
    speaker_labels: bool = False

    @classmethod
    def load(cls, env_path: Path | None = None) -> Config:
        """Load config from .env file and environment variables.

        Searches for .env in: explicit path > cwd > project root (parent of backend/).
        """
        if env_path:
            load_dotenv(env_path)
        else:
            # Try cwd first, then walk up to find .env
            if not load_dotenv():
                # Also check the project root (two levels up from this file)
                project_root = Path(__file__).resolve().parent.parent.parent.parent
                env_candidate = project_root / ".env"
                if env_candidate.exists():
                    load_dotenv(env_candidate)

        mic_idx = os.getenv("MIC_DEVICE_INDEX")
        sys_idx = os.getenv("SYSTEM_AUDIO_DEVICE_INDEX")

        return cls(
            assemblyai_api_key=os.getenv("ASSEMBLYAI_API_KEY", ""),
            output_dir=Path(os.getenv("OUTPUT_DIR", str(Path.cwd()))),
            engine=os.getenv("ENGINE", "auto"),
            mic_device_index=int(mic_idx) if mic_idx else None,
            system_audio_device_index=int(sys_idx) if sys_idx else None,
            endpointing=os.getenv("ENDPOINTING", "conservative"),
            local_model_size=os.getenv("LOCAL_MODEL_SIZE", "small.en"),
            local_compute_type=os.getenv("LOCAL_COMPUTE_TYPE", "int8"),
            local_cpu_threads=int(os.getenv("LOCAL_CPU_THREADS", "0")),
            local_chunk_seconds=int(os.getenv("LOCAL_CHUNK_SECONDS", "10")),
            timestamp_mode=os.getenv("TIMESTAMP_MODE", "elapsed"),
        )

    def validate(self, require_api_key: bool = True, check_output_dir: bool = True) -> list[str]:
        """Return list of validation errors, empty if config is valid."""
        errors = []
        if require_api_key and not self.assemblyai_api_key:
            errors.append("ASSEMBLYAI_API_KEY is not set. Add it to .env or environment.")
        if self.engine not in ("cloud", "local", "auto"):
            errors.append(f"ENGINE must be 'cloud', 'local', or 'auto', got '{self.engine}'")
        if self.timestamp_mode not in ("none", "local_time", "elapsed"):
            errors.append(
                f"TIMESTAMP_MODE must be 'none', 'local_time', or 'elapsed', "
                f"got '{self.timestamp_mode}'"
            )
        if check_output_dir and not self.output_dir.exists():
            errors.append(f"OUTPUT_DIR does not exist: {self.output_dir}")
        return errors
