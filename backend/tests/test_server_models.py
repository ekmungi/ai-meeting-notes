"""Tests for server Pydantic models."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from meeting_notes import __version__
from meeting_notes.server.models import (
    DeviceInfo,
    DevicesResponse,
    ErrorResponse,
    HealthResponse,
    StartRequest,
    StartResponse,
    StopResponse,
)


class TestHealthResponse:
    def test_defaults(self):
        resp = HealthResponse()
        assert resp.status == "ok"
        assert resp.version == __version__
        assert resp.recording is False

    def test_recording_true(self):
        resp = HealthResponse(recording=True)
        assert resp.recording is True


class TestDeviceInfo:
    def test_basic(self):
        d = DeviceInfo(index=0, name="Mic", kind="input", sample_rate=16000)
        assert d.index == 0
        assert d.kind == "input"


class TestDevicesResponse:
    def test_empty(self):
        resp = DevicesResponse(devices=[])
        assert resp.devices == []

    def test_with_devices(self):
        resp = DevicesResponse(devices=[
            DeviceInfo(index=0, name="Mic", kind="input", sample_rate=16000),
            DeviceInfo(index=1, name="Speaker", kind="loopback", sample_rate=48000),
        ])
        assert len(resp.devices) == 2


class TestStartRequest:
    def test_defaults(self):
        req = StartRequest()
        assert req.engine == "cloud"
        assert req.timestamp_mode == "elapsed"
        assert req.endpointing == "conservative"
        assert req.mic_device_index is None

    def test_full_request(self):
        req = StartRequest(
            engine="local",
            assemblyai_api_key="sk-test",
            timestamp_mode="none",
            endpointing="very_conservative",
            mic_device_index=1,
            system_device_index=2,
        )
        assert req.engine == "local"
        assert req.mic_device_index == 1

    def test_invalid_engine(self):
        with pytest.raises(ValidationError):
            StartRequest(engine="invalid")

    def test_invalid_timestamp_mode(self):
        with pytest.raises(ValidationError):
            StartRequest(timestamp_mode="bad")


class TestStartResponse:
    def test_basic(self):
        resp = StartResponse(engine="cloud", output_path="/tmp/test.md")
        assert resp.status == "recording"
        assert resp.engine == "cloud"


class TestStopResponse:
    def test_basic(self):
        resp = StopResponse(output_path="/tmp/test.md", duration_seconds=42.5)
        assert resp.status == "stopped"
        assert resp.duration_seconds == 42.5


class TestErrorResponse:
    def test_basic(self):
        resp = ErrorResponse(error="something went wrong")
        assert resp.error == "something went wrong"
