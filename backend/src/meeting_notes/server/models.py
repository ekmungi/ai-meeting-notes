"""Pydantic request/response models for the server API."""

from __future__ import annotations

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: str = "ok"
    version: str = "0.1.0"
    recording: bool = False


class DeviceInfo(BaseModel):
    index: int
    name: str
    kind: str  # "input" or "loopback"
    sample_rate: int


class DevicesResponse(BaseModel):
    devices: list[DeviceInfo]


class StartRequest(BaseModel):
    engine: str = Field(default="cloud", pattern="^(cloud|local|auto)$")
    assemblyai_api_key: str = ""
    timestamp_mode: str = Field(default="elapsed", pattern="^(none|local_time|elapsed)$")
    endpointing: str = Field(
        default="conservative",
        pattern="^(aggressive|balanced|conservative|very_conservative)$",
    )
    mic_device_index: int | None = Field(default=None, ge=0, le=255)
    system_device_index: int | None = Field(default=None, ge=0, le=255)
    local_model_size: str = Field(
        default="small.en",
        pattern=r"^(tiny\.en|base\.en|distil-small\.en|small\.en|distil-large-v3|medium\.en)$",
    )


class StartResponse(BaseModel):
    status: str = "recording"
    engine: str
    output_path: str


class StopResponse(BaseModel):
    status: str = "stopped"
    output_path: str
    duration_seconds: float


class PauseResponse(BaseModel):
    status: str = "paused"
    elapsed_seconds: float


class ResumeResponse(BaseModel):
    status: str = "recording"
    elapsed_seconds: float


class ErrorResponse(BaseModel):
    error: str
