"""Tests for WebSocket connection manager."""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from meeting_notes.server.ws import ConnectionManager


@pytest.fixture
def manager():
    return ConnectionManager()


def _make_ws() -> AsyncMock:
    """Create a mock WebSocket."""
    ws = AsyncMock()
    ws.accept = AsyncMock()
    ws.send_text = AsyncMock()
    return ws


class TestConnectionManager:
    async def test_connect(self, manager):
        ws = _make_ws()
        await manager.connect(ws)
        assert manager.connection_count == 1
        ws.accept.assert_awaited_once()

    async def test_disconnect(self, manager):
        ws = _make_ws()
        await manager.connect(ws)
        await manager.disconnect(ws)
        assert manager.connection_count == 0

    async def test_disconnect_unknown_ws(self, manager):
        ws = _make_ws()
        await manager.disconnect(ws)  # Should not raise
        assert manager.connection_count == 0

    async def test_broadcast_to_multiple(self, manager):
        ws1 = _make_ws()
        ws2 = _make_ws()
        await manager.connect(ws1)
        await manager.connect(ws2)

        await manager.broadcast({"type": "test", "data": "hello"})

        expected = json.dumps({"type": "test", "data": "hello"})
        ws1.send_text.assert_awaited_once_with(expected)
        ws2.send_text.assert_awaited_once_with(expected)

    async def test_broadcast_removes_stale_connections(self, manager):
        ws_good = _make_ws()
        ws_bad = _make_ws()
        ws_bad.send_text.side_effect = RuntimeError("connection closed")

        await manager.connect(ws_good)
        await manager.connect(ws_bad)
        assert manager.connection_count == 2

        await manager.broadcast({"type": "test"})

        # Stale connection should be removed
        assert manager.connection_count == 1

    async def test_broadcast_empty_no_error(self, manager):
        await manager.broadcast({"type": "test"})  # No connections, should not raise

    async def test_broadcast_transcript(self, manager):
        ws = _make_ws()
        await manager.connect(ws)

        await manager.broadcast_transcript(
            text="Hello",
            is_partial=False,
            timestamp_start=1.0,
            timestamp_end=2.0,
            speaker=None,
        )

        call_args = ws.send_text.call_args[0][0]
        msg = json.loads(call_args)
        assert msg["type"] == "transcript"
        assert msg["text"] == "Hello"
        assert msg["is_partial"] is False

    async def test_broadcast_status(self, manager):
        ws = _make_ws()
        await manager.connect(ws)

        await manager.broadcast_status("recording", 42.5)

        call_args = ws.send_text.call_args[0][0]
        msg = json.loads(call_args)
        assert msg["type"] == "status"
        assert msg["state"] == "recording"
        assert msg["elapsed_seconds"] == 42.5

    async def test_broadcast_error(self, manager):
        ws = _make_ws()
        await manager.connect(ws)

        await manager.broadcast_error("Engine crashed")

        call_args = ws.send_text.call_args[0][0]
        msg = json.loads(call_args)
        assert msg["type"] == "error"
        assert msg["message"] == "Engine crashed"
