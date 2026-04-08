"""
Teledentistry WebRTC Signaling Server
======================================
Phase 2: Core WebSocket signal relay and room management.

Tech Stack : Python 3.x, asyncio, websockets, json
Run with   : python server.py
"""

import asyncio
import json
import random
import logging
import os
import http
import websockets
from typing import Optional, Union

# ---------------------------------------------------------------------------
# Logging setup
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("signaling")

# ---------------------------------------------------------------------------
# In-Memory State
# ---------------------------------------------------------------------------
# rooms = {
#     "<room_id>": {
#         "pin":     "1234",              # 4-digit PIN string
#         "clients": {<WebSocket>: "<peer_id>", ...}, # mapping of socket to peer ID
#     }
# }
rooms: dict[str, dict] = {}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def generate_pin() -> str:
    """Return a zero-padded random 4-digit PIN string, e.g. '0847'."""
    return str(random.randint(0, 9999)).zfill(4)


async def send_json(ws, payload: dict) -> None:
    """Serialise *payload* to JSON and send it to a single WebSocket client."""
    try:
        await ws.send(json.dumps(payload))
    except websockets.ConnectionClosed:
        pass  # client already gone; ignore silently


async def broadcast(room_id: str, message: str, exclude: websockets.WebSocketServerProtocol = None) -> None:
    """
    Forward a raw JSON *message* string to every client in *room_id*,
    optionally skipping the *exclude* socket (the original sender).

    WebRTC payloads (offer / answer / ICE candidate) are never modified —
    the raw string is forwarded byte-for-byte.
    """
    room = rooms.get(room_id)
    if not room:
        return

    targets = [c for c in room["clients"].keys() if c is not exclude]
    if targets:
        # Fan-out to all peers concurrently
        await asyncio.gather(*[ws.send(message) for ws in targets], return_exceptions=True)


# ---------------------------------------------------------------------------
# Action Handlers
# ---------------------------------------------------------------------------

async def handle_create_room(ws, data: dict) -> None:
    """
    Create a new room.

    Expected payload:
        {"action": "create_room", "room_id": "my-room"}   # room_id is optional
        {"action": "create_room"}                          # server auto-generates a room_id

    Response sent to creator:
        {"event": "room_created", "room_id": "my-room", "pin": "4821"}
    """
    room_id = data.get("room_id") or f"room-{random.randint(1000, 9999)}"

    if room_id in rooms:
        await send_json(ws, {
            "event": "error",
            "message": f"Room '{room_id}' already exists. Choose a different ID or join it.",
        })
        return

    peer_id = data.get("peer_id") or f"p-{random.randint(100, 999)}"
    pin = generate_pin()
    rooms[room_id] = {"pin": pin, "clients": {ws: peer_id}}

    log.info("Room created | id=%s  pin=%s", room_id, pin)

    await send_json(ws, {
        "event": "room_created",
        "room_id": room_id,
        "pin": pin,
        "peer_id": peer_id  # confirm their assigned ID
    })


async def handle_join_room(ws, data: dict) -> None:
    """
    Join an existing room after PIN validation.

    Expected payload:
        {"action": "join_room", "room_id": "my-room", "pin": "4821"}

    On success, the joining client receives:
        {"event": "room_joined", "room_id": "my-room", "peer_count": 2}

    All existing peers in the room receive:
        {"event": "peer_joined", "peer_count": 2}

    On failure, the client receives an error and the server closes the connection.
    """
    room_id = data.get("room_id")
    pin     = str(data.get("pin", "")).zfill(4)

    if not room_id or room_id not in rooms:
        await send_json(ws, {"event": "error", "message": "Room not found."})
        await ws.close(1008, "Room not found")
        return

    room = rooms[room_id]

    if room["pin"] != pin:
        await send_json(ws, {"event": "error", "message": "Incorrect PIN."})
        await ws.close(1008, "Incorrect PIN")
        return

    # Add the new peer to the room
    peer_id = data.get("peer_id") or f"p-{random.randint(100, 999)}"
    room["clients"][ws] = peer_id
    peer_count = len(room["clients"])

    log.info("Peer joined  | id=%s  peers=%d", room_id, peer_count)

    # Notify the joiner
    await send_json(ws, {
        "event": "room_joined",
        "room_id": room_id,
        "peer_count": peer_count,
    })

    # Notify existing peers about the new arrival
    await broadcast(room_id, json.dumps({
        "event": "peer_joined",
        "peer_count": peer_count,
        "peer_id": peer_id  # Let them know WHO joined
    }), exclude=ws)


async def handle_relay(ws, room_id: str, raw_message: str) -> None:
    """
    Relay a WebRTC signaling message (offer / answer / ice-candidate) to every
    other peer in the room WITHOUT modification.

    The *raw_message* string is forwarded as-is so WebRTC payloads are preserved
    exactly as the browser generated them.

    Expected payload examples:
        {"action": "relay", "room_id": "my-room", "type": "offer",         "sdp":  {...}}
        {"action": "relay", "room_id": "my-room", "type": "answer",        "sdp":  {...}}
        {"action": "relay", "room_id": "my-room", "type": "ice-candidate", "candidate": {...}}
    """
    if room_id not in rooms:
        await send_json(ws, {"event": "error", "message": "Room not found for relay."})
        return

    if ws not in rooms[room_id]["clients"]:
        await send_json(ws, {"event": "error", "message": "You are not in this room."})
        return

    log.info("Relay        | id=%s  from=%s", room_id, ws.remote_address)
    
    # Check for targeted relay
    try:
        data = json.loads(raw_message)
        target_id = data.get("target_id")
        
        if target_id:
            # Server-Side Filtering: find the specific WebSocket for this target_id
            target_ws = next((c for c, pid in rooms[room_id]["clients"].items() if pid == target_id), None)
            if target_ws:
                await send_json(target_ws, data)
                return
            else:
                log.warning("Target ID %s not found in room %s", target_id, room_id)
                return
    except Exception as e:
        log.error("Relay error: %s", e)

    # Fallback to broadcast (historical or for non-targeted relay)
    await broadcast(room_id, raw_message, exclude=ws)


# ---------------------------------------------------------------------------
# Disconnection Cleanup
# ---------------------------------------------------------------------------

async def cleanup(ws, room_id: Optional[str]) -> None:
    """
    Remove *ws* from its room when the connection drops.
    If the room becomes empty afterwards, delete it entirely.
    """
    if not room_id or room_id not in rooms:
        return

    room = rooms[room_id]
    peer_id = room["clients"].pop(ws, None)
    peer_count = len(room["clients"])

    log.info("Peer left    | id=%s  peer=%s  remaining=%d", room_id, peer_id, peer_count)

    if peer_count == 0:
        del rooms[room_id]
        log.info("Room removed | id=%s  (empty)", room_id)
    else:
        # Notify remaining peers
        await broadcast(room_id, json.dumps({
            "event": "peer_left",
            "peer_count": peer_count,
            "peer_id": peer_id
        }))


# ---------------------------------------------------------------------------
# Main WebSocket Handler
# ---------------------------------------------------------------------------

async def handler(ws: websockets.WebSocketServerProtocol) -> None:
    """
    Entry point called by the websockets library for every new connection.

    This coroutine lives for the entire lifetime of the connection and
    dispatches incoming messages to the correct action handler.
    """
    log.info("Connected    | %s", ws.remote_address)

    # Track which room this socket belongs to so we can clean up on disconnect
    current_room_id: Optional[str] = None

    try:
        async for raw_message in ws:
            # ---- Parse JSON ---------------------------------------------------
            try:
                data = json.loads(raw_message)
            except json.JSONDecodeError:
                await send_json(ws, {"event": "error", "message": "Invalid JSON."})
                continue

            action    = data.get("action")
            room_id   = data.get("room_id")

            # ---- Dispatch action ----------------------------------------------
            if action == "create_room":
                await handle_create_room(ws, data)
                # Record the room that this client now belongs to
                # (the room_id may have been auto-generated inside the handler,
                #  so we re-read it from the rooms dict by matching the socket)
                for rid, rdata in rooms.items():
                    if ws in rdata["clients"]:
                        current_room_id = rid
                        break

            elif action == "join_room":
                await handle_join_room(ws, data)
                # Only track the room if the join succeeded (socket is in room)
                if room_id and room_id in rooms and ws in rooms[room_id]["clients"]:
                    current_room_id = room_id

            elif action == "relay":
                # Pass the raw string so the WebRTC payload is never touched
                await handle_relay(ws, room_id, raw_message)

            else:
                await send_json(ws, {
                    "event": "error",
                    "message": f"Unknown action: '{action}'.",
                })

    except websockets.ConnectionClosedOK:
        log.info("Disconnected (clean) | %s", ws.remote_address)
    except websockets.ConnectionClosedError as exc:
        log.warning("Disconnected (error) | %s | %s", ws.remote_address, exc)
    finally:
        await cleanup(ws, current_room_id)


# ---------------------------------------------------------------------------
# Health Check (for Cloud Deployment)
# ---------------------------------------------------------------------------

async def health_check(connection, request):
    """
    Handle HTTP health check requests for cloud load balancers.
    If the path is /healthz, returns a 200 OK response.
    """
    if request.path == "/healthz":
        return connection.respond(http.HTTPStatus.OK, "OK\n")
    return None


# ---------------------------------------------------------------------------
# Entry Point
# ---------------------------------------------------------------------------

HOST = "0.0.0.0"   # accept external traffic
PORT = int(os.environ.get("PORT", 8765))

async def main() -> None:
    log.info("Signaling server starting on ws://%s:%d", HOST, PORT)
    async with websockets.serve(
        handler, 
        HOST, 
        PORT, 
        process_request=health_check
    ):
        log.info("Server ready. Waiting for connections...")
        await asyncio.Future()   # run forever


if __name__ == "__main__":
    asyncio.run(main())
