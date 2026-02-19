"""WebSocket connection manager for broadcasting transcript segments."""

from __future__ import annotations

import asyncio
import json
import logging
import time

from fastapi import WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)


class ConnectionManager:
    """Manages active WebSocket connections and broadcasts messages."""

    def __init__(self) -> None:
        self._connections: list[WebSocket] = []
        self._lock = asyncio.Lock()

    @property
    def connection_count(self) -> int:
        return len(self._connections)

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._connections.append(ws)
        logger.info("WebSocket client connected (%d total)", len(self._connections))

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            if ws in self._connections:
                self._connections.remove(ws)
        logger.info("WebSocket client disconnected (%d remaining)", len(self._connections))

    async def broadcast(self, message: dict) -> None:
        """Send a JSON message to all connected clients."""
        if not self._connections:
            return

        # Snapshot under lock, then send outside lock to avoid stalling
        # connect/disconnect while a slow client blocks send_text.
        payload = json.dumps(message)
        async with self._lock:
            connections = list(self._connections)

        stale: list[WebSocket] = []
        for ws in connections:
            try:
                await ws.send_text(payload)
            except Exception:
                stale.append(ws)

        if stale:
            async with self._lock:
                for ws in stale:
                    if ws in self._connections:
                        self._connections.remove(ws)

    async def broadcast_transcript(
        self,
        text: str,
        is_partial: bool,
        timestamp_start: float,
        timestamp_end: float,
        speaker: str | None = None,
    ) -> None:
        await self.broadcast({
            "type": "transcript",
            "text": text,
            "is_partial": is_partial,
            "timestamp_start": timestamp_start,
            "timestamp_end": timestamp_end,
            "speaker": speaker,
        })

    async def broadcast_status(self, state: str, elapsed_seconds: float) -> None:
        await self.broadcast({
            "type": "status",
            "state": state,
            "elapsed_seconds": elapsed_seconds,
        })

    async def broadcast_error(self, message: str) -> None:
        await self.broadcast({
            "type": "error",
            "message": message,
        })


async def websocket_endpoint(ws: WebSocket, manager: ConnectionManager) -> None:
    """Handle a single WebSocket connection with heartbeat."""
    await manager.connect(ws)
    try:
        while True:
            data = await ws.receive_text()
            try:
                msg = json.loads(data)
                if msg.get("type") == "ping":
                    await ws.send_text(json.dumps({
                        "type": "pong",
                        "timestamp": time.time(),
                    }))
            except json.JSONDecodeError:
                pass
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("WebSocket error")
    finally:
        await manager.disconnect(ws)
