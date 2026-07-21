from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Final

from aiohttp import WSMsgType, web


# ------------------------------------------------------------
# Configuration
# ------------------------------------------------------------

HOST: Final[str] = "0.0.0.0"
PORT: Final[int] = 8765

BASE_DIR: Final[Path] = Path(__file__).resolve().parent

INDEX_FILE: Final[Path] = BASE_DIR / "index.html"
PLAYER_FILE: Final[Path] = BASE_DIR / "player.js"

SAMPLE_RATE: Final[int] = 16_000
CHANNELS: Final[int] = 1
BITS_PER_SAMPLE: Final[int] = 16

MAX_AUDIO_MESSAGE_SIZE: Final[int] = 128 * 1024


# ------------------------------------------------------------
# Logging
# ------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
)

logger = logging.getLogger("esp32-internet-mic")


# ------------------------------------------------------------
# Connected clients
# ------------------------------------------------------------

microphone_socket: web.WebSocketResponse | None = None
listeners: set[web.WebSocketResponse] = set()

state_lock = asyncio.Lock()


# ------------------------------------------------------------
# Utility functions
# ------------------------------------------------------------

async def send_json_safe(
    socket: web.WebSocketResponse,
    payload: dict,
) -> bool:
    """
    Send JSON to a WebSocket.

    Returns False when the socket is closed or sending fails.
    """

    if socket.closed:
        return False

    try:
        await socket.send_str(json.dumps(payload))
        return True

    except (
        ConnectionResetError,
        RuntimeError,
        asyncio.CancelledError,
    ):
        return False


async def broadcast_status() -> None:
    """
    Send current server status to every browser listener.
    """

    payload = {
        "type": "status",
        "microphoneConnected": (
            microphone_socket is not None
            and not microphone_socket.closed
        ),
        "listenerCount": len(listeners),
        "sampleRate": SAMPLE_RATE,
        "channels": CHANNELS,
        "bitsPerSample": BITS_PER_SAMPLE,
    }

    disconnected: list[web.WebSocketResponse] = []

    for listener in tuple(listeners):
        sent = await send_json_safe(listener, payload)

        if not sent:
            disconnected.append(listener)

    if disconnected:
        async with state_lock:
            for listener in disconnected:
                listeners.discard(listener)


async def broadcast_audio(audio_data: bytes) -> None:
    """
    Relay one PCM16 audio packet to every connected listener.

    Slow or disconnected listeners are removed so they cannot
    permanently block the microphone stream.
    """

    if not listeners:
        return

    sockets = tuple(listeners)

    results = await asyncio.gather(
        *(
            send_audio_safe(listener, audio_data)
            for listener in sockets
        ),
        return_exceptions=True,
    )

    disconnected: list[web.WebSocketResponse] = []

    for listener, result in zip(sockets, results):
        if result is not True:
            disconnected.append(listener)

    if disconnected:
        async with state_lock:
            for listener in disconnected:
                listeners.discard(listener)

        logger.info(
            "Removed %d disconnected listener(s)",
            len(disconnected),
        )


async def send_audio_safe(
    listener: web.WebSocketResponse,
    audio_data: bytes,
) -> bool:
    """
    Send binary PCM audio to one browser listener.
    """

    if listener.closed:
        return False

    try:
        await listener.send_bytes(audio_data)
        return True

    except (
        ConnectionResetError,
        RuntimeError,
        asyncio.CancelledError,
    ):
        return False


# ------------------------------------------------------------
# HTTP routes
# ------------------------------------------------------------

async def index_handler(
    request: web.Request,
) -> web.StreamResponse:
    """
    Serve the browser interface.
    """

    if not INDEX_FILE.exists():
        raise web.HTTPNotFound(
            text=(
                "index.html has not been created yet.\n"
                "Create server/index.html first."
            )
        )

    return web.FileResponse(INDEX_FILE)


async def player_handler(
    request: web.Request,
) -> web.StreamResponse:
    """
    Serve the browser audio player JavaScript.
    """

    if not PLAYER_FILE.exists():
        raise web.HTTPNotFound(
            text=(
                "player.js has not been created yet.\n"
                "Create server/player.js first."
            )
        )

    return web.FileResponse(PLAYER_FILE)


async def health_handler(
    request: web.Request,
) -> web.Response:
    """
    Simple status endpoint for testing.
    """

    return web.json_response(
        {
            "status": "ok",
            "microphoneConnected": (
                microphone_socket is not None
                and not microphone_socket.closed
            ),
            "listenerCount": len(listeners),
            "audio": {
                "sampleRate": SAMPLE_RATE,
                "channels": CHANNELS,
                "bitsPerSample": BITS_PER_SAMPLE,
            },
        }
    )


# ------------------------------------------------------------
# ESP32 microphone WebSocket
# ------------------------------------------------------------

async def microphone_handler(
    request: web.Request,
) -> web.WebSocketResponse:
    """
    Receive PCM16 audio from the ESP32 at /mic.
    """

    global microphone_socket

    socket = web.WebSocketResponse(
        heartbeat=20,
        compress=False,
        max_msg_size=MAX_AUDIO_MESSAGE_SIZE,
    )

    await socket.prepare(request)

    async with state_lock:
        previous_microphone = microphone_socket
        microphone_socket = socket

    if (
        previous_microphone is not None
        and previous_microphone is not socket
        and not previous_microphone.closed
    ):
        logger.warning(
            "A new microphone connected. "
            "Closing the previous microphone connection."
        )

        await previous_microphone.close(
            code=1000,
            message=b"Replaced by a new microphone",
        )

    peer = request.remote or "unknown"

    logger.info(
        "ESP32 microphone connected from %s",
        peer,
    )

    await send_json_safe(
        socket,
        {
            "type": "ready",
            "message": "Microphone connection accepted",
            "sampleRate": SAMPLE_RATE,
            "channels": CHANNELS,
            "bitsPerSample": BITS_PER_SAMPLE,
        },
    )

    await broadcast_status()

    try:
        async for message in socket:
            if message.type == WSMsgType.BINARY:
                audio_data = bytes(message.data)

                if len(audio_data) % 2 != 0:
                    logger.warning(
                        "Ignored malformed audio packet "
                        "with odd byte length: %d",
                        len(audio_data),
                    )
                    continue

                await broadcast_audio(audio_data)

            elif message.type == WSMsgType.TEXT:
                logger.info(
                    "ESP32 message: %s",
                    message.data,
                )

            elif message.type == WSMsgType.ERROR:
                logger.error(
                    "ESP32 WebSocket error: %s",
                    socket.exception(),
                )

    except asyncio.CancelledError:
        raise

    except Exception:
        logger.exception(
            "Unexpected microphone connection error"
        )

    finally:
        async with state_lock:
            if microphone_socket is socket:
                microphone_socket = None

        logger.info(
            "ESP32 microphone disconnected"
        )

        await broadcast_status()

    return socket


# ------------------------------------------------------------
# Browser listener WebSocket
# ------------------------------------------------------------

async def listener_handler(
    request: web.Request,
) -> web.WebSocketResponse:
    """
    Send live PCM16 audio to browser clients at /listen.
    """

    socket = web.WebSocketResponse(
        heartbeat=20,
        compress=False,
        max_msg_size=16 * 1024,
    )

    await socket.prepare(request)

    async with state_lock:
        listeners.add(socket)

    peer = request.remote or "unknown"

    logger.info(
        "Listener connected from %s. Total listeners: %d",
        peer,
        len(listeners),
    )

    await send_json_safe(
        socket,
        {
            "type": "audio-format",
            "sampleRate": SAMPLE_RATE,
            "channels": CHANNELS,
            "bitsPerSample": BITS_PER_SAMPLE,
            "encoding": "signed-pcm-little-endian",
        },
    )

    await broadcast_status()

    try:
        async for message in socket:
            if message.type == WSMsgType.TEXT:
                try:
                    payload = json.loads(message.data)

                except json.JSONDecodeError:
                    logger.warning(
                        "Listener sent invalid JSON"
                    )
                    continue

                if payload.get("type") == "request-status":
                    await send_json_safe(
                        socket,
                        {
                            "type": "status",
                            "microphoneConnected": (
                                microphone_socket is not None
                                and not microphone_socket.closed
                            ),
                            "listenerCount": len(listeners),
                            "sampleRate": SAMPLE_RATE,
                            "channels": CHANNELS,
                            "bitsPerSample": BITS_PER_SAMPLE,
                        },
                    )

            elif message.type == WSMsgType.ERROR:
                logger.error(
                    "Listener WebSocket error: %s",
                    socket.exception(),
                )

    except asyncio.CancelledError:
        raise

    except Exception:
        logger.exception(
            "Unexpected listener connection error"
        )

    finally:
        async with state_lock:
            listeners.discard(socket)

        logger.info(
            "Listener disconnected. Total listeners: %d",
            len(listeners),
        )

        await broadcast_status()

    return socket


# ------------------------------------------------------------
# Server lifecycle
# ------------------------------------------------------------

async def shutdown_handler(
    app: web.Application,
) -> None:
    """
    Gracefully close WebSockets when the server stops.
    """

    global microphone_socket

    logger.info(
        "Closing active WebSocket connections..."
    )

    sockets: list[web.WebSocketResponse] = []

    if microphone_socket is not None:
        sockets.append(microphone_socket)

    sockets.extend(listeners)

    await asyncio.gather(
        *(
            socket.close(
                code=1001,
                message=b"Server shutting down",
            )
            for socket in sockets
            if not socket.closed
        ),
        return_exceptions=True,
    )

    microphone_socket = None
    listeners.clear()


def create_application() -> web.Application:
    """
    Create and configure the aiohttp application.
    """

    app = web.Application(
        client_max_size=MAX_AUDIO_MESSAGE_SIZE,
    )

    app.router.add_get("/", index_handler)
    app.router.add_get("/player.js", player_handler)
    app.router.add_get("/health", health_handler)

    app.router.add_get("/mic", microphone_handler)
    app.router.add_get("/listen", listener_handler)

    app.on_shutdown.append(shutdown_handler)

    return app


def main() -> None:
    app = create_application()

    logger.info(
        "Starting ESP32 Internet Mic server"
    )

    logger.info(
        "Local page: http://127.0.0.1:%d",
        PORT,
    )

    logger.info(
        "ESP32 WebSocket: ws://YOUR-PC-IP:%d/mic",
        PORT,
    )

    web.run_app(
        app,
        host=HOST,
        port=PORT,
        access_log=logger,
    )


if __name__ == "__main__":
    main()