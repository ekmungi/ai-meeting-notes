"""Integration tests for FastAPI server endpoints."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from meeting_notes import __version__
from meeting_notes.server import app as app_module
from meeting_notes.server.app import app
from meeting_notes.server.server_runner import ServerRunner
from meeting_notes.server.ws import ConnectionManager


@pytest.fixture
async def client():
    """Create an async test client with server singletons initialized."""
    # Manually initialize the module-level singletons (lifespan equivalent)
    ws_manager = ConnectionManager()
    runner = ServerRunner(ws_manager)
    app_module.app_module = None  # Reset
    # Patch the module globals
    import meeting_notes.server.app as srv
    srv._ws_manager = ws_manager
    srv._runner = runner

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c

    # Cleanup
    if runner.is_recording:
        await runner.stop()
    srv._ws_manager = None
    srv._runner = None


class TestHealth:
    async def test_health_ok(self, client):
        resp = await client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["version"] == __version__
        assert data["recording"] is False


class TestDevices:
    @patch("meeting_notes.audio.devices.list_devices")
    async def test_devices_list(self, mock_list, client):
        from meeting_notes.audio.devices import AudioDevice

        mock_list.return_value = [
            AudioDevice(index=0, name="Mic", max_input_channels=1,
                        default_sample_rate=16000.0, is_loopback=False),
            AudioDevice(index=1, name="Speakers", max_input_channels=2,
                        default_sample_rate=48000.0, is_loopback=True),
        ]
        resp = await client.get("/devices")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["devices"]) == 2
        assert data["devices"][0]["kind"] == "input"
        assert data["devices"][1]["kind"] == "loopback"


class TestSessionStart:
    async def test_start_invalid_engine(self, client):
        resp = await client.post("/session/start", json={
            "engine": "invalid_engine",
        })
        assert resp.status_code == 422  # Pydantic validation error

    async def test_start_missing_api_key_for_cloud(self, client):
        resp = await client.post("/session/start", json={
            "engine": "cloud",
            "assemblyai_api_key": "",
        })
        assert resp.status_code == 400
        data = resp.json()
        assert "ASSEMBLYAI_API_KEY" in data["error"]


class TestSessionStop:
    async def test_stop_not_recording(self, client):
        resp = await client.post("/session/stop")
        assert resp.status_code == 409
        data = resp.json()
        assert "Not recording" in data["error"]
