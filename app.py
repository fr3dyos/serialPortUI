"""
serialPortUI - Flask + SocketIO backend.

Exposes a localhost web UI for selecting a serial device, opening it at a
configurable baud rate, sending messages (ASCII or hex), and watching
incoming data stream in real time.

Features:
  * Auto-refreshed list of available serial devices (poll + on-demand).
  * Each device keeps its own in-memory sent/received history that survives
    until the server is shut down or the user clicks Clear.
  * Broadcasts a 'serial_data' event for every received byte-string and
    'serial_status' whenever the connection state changes.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from flask import Flask, jsonify, render_template, request
from flask_socketio import SocketIO
import serial
from serial.tools import list_ports


# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------

app = Flask(__name__)
app.config["SECRET_KEY"] = "serialPortUI-secret"
socketio = SocketIO(app, async_mode="eventlet", cors_allowed_origins="*")

# Currently open connection, if any. Only one device open at a time so the
# history-per-device map stays unambiguous.
_active_port: Optional["SerialConnection"] = None

# Per-device history: device_id -> list[Message]  (most-recent at the end).
# Stored as a list of dicts so it is straightforward to JSON-encode.
_message_history: Dict[str, List[dict]] = {}

# Default capacity for the history buffer per device. When exceeded, the
# oldest entries are dropped (FIFO).
HISTORY_LIMIT = 500


# ---------------------------------------------------------------------------
# Domain
# ---------------------------------------------------------------------------


@dataclass
class SerialConnection:
    """Wraps an open pyserial.Serial and a background reader thread."""

    port: serial.Serial
    reader_thread: threading.Thread
    closing: threading.Event = field(default_factory=threading.Event)

    def close(self) -> None:
        self.closing.set()
        try:
            self.port.close()
        except Exception:
            pass


def _list_serial_ports() -> List[dict]:
    """Return a JSON-friendly list of currently-available serial ports."""
    ports = []
    for p in list_ports.comports():
        # On Windows the device path is e.g. 'COM3'. On Linux/macOS it is the
        # /dev/tty* path. Both are stored as 'device' for the front-end.
        ports.append(
            {
                "device": p.device,
                "description": p.description or "",
                "manufacturer": p.manufacturer or "",
                "vid": p.vid,
                "pid": p.pid,
                "serial_number": p.serial_number or "",
            }
        )
    return ports


def _emit_receive(data: bytes) -> None:
    """Hand a freshly received byte-string off to every connected client."""
    socketio.emit(
        "serial_data",
        {
            "direction": "rx",
            "device": _active_port.port.port if _active_port else None,
            "data_hex": data.hex(" "),
            "data_text": _decode_for_display(data),
            "timestamp": time.time(),
        },
    )


def _decode_for_display(data: bytes) -> str:
    """Best-effort text decoding so non-text traffic shows as '<...>'."""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return "<binary: " + data.hex(" ") + ">"


def _reader_loop(conn: SerialConnection) -> None:
    """Block reading from the serial port until the connection is closed."""
    while not conn.closing.is_set():
        try:
            waiting = conn.port.in_waiting
            chunk = conn.port.read(max(1, waiting) if waiting else 1)
        except serial.SerialException:
            socketio.emit(
                "serial_status",
                {"state": "error", "message": "Serial read failed"},
            )
            break
        except OSError:
            break

        if chunk:
            _append_history(conn.port.port, "rx", chunk)
            socketio.start_background_task(_emit_receive, chunk)
    # If we exit the loop and we're still the active connection, mark
    # ourselves as closed so the UI reflects reality.
    global _active_port
    if _active_port is conn:
        _active_port = None
        socketio.emit("serial_status", {"state": "disconnected"})


def _append_history(device: str, direction: str, data: bytes) -> None:
    """Push a new entry onto the device's history, trimming if needed."""
    history = _message_history.setdefault(device, [])
    history.append(
        {
            "direction": direction,
            "data_hex": data.hex(" "),
            "data_text": _decode_for_display(data),
            "timestamp": time.time(),
        }
    )
    if len(history) > HISTORY_LIMIT:
        del history[: len(history) - HISTORY_LIMIT]


def _parse_payload(raw: str, encoding: str) -> Optional[bytes]:
    """Convert user-entered text into bytes according to the chosen encoding."""
    if encoding == "hex":
        cleaned = raw.replace(" ", "").replace(",", "").replace("0x", "")
        if len(cleaned) % 2 != 0:
            return None
        try:
            return bytes.fromhex(cleaned)
        except ValueError:
            return None
    # default: ASCII
    return raw.encode("utf-8")


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------


@app.route("/")
def index() -> str:
    return render_template("index.html")


@app.route("/api/ports", methods=["GET"])
def api_ports():
    """Return the current list of available serial devices."""
    return jsonify({"ports": _list_serial_ports()})


@app.route("/api/history", methods=["GET"])
def api_history():
    """Return the saved history for one device (or all devices).

    Query params:
      device - if present, filter to that device.
      limit  - max number of most-recent messages to return (default 100).
    """
    device = request.args.get("device")
    try:
        limit = max(1, min(int(request.args.get("limit", 100)), HISTORY_LIMIT))
    except ValueError:
        limit = 100

    if device:
        history = list(_message_history.get(device, []))[-limit:]
        return jsonify({"device": device, "messages": history})

    summary = {
        dev: len(_message_history.get(dev, [])) for dev in _message_history
    }
    return jsonify({"devices": summary})


@app.route("/api/clear", methods=["POST"])
def api_clear():
    """Clear the history for the named device (or for every device)."""
    payload = request.get_json(silent=True) or {}
    device = payload.get("device")

    if device:
        _message_history.pop(device, None)
        return jsonify({"cleared": device})
    _message_history.clear()
    return jsonify({"cleared": "all"})


@app.route("/api/send", methods=["POST"])
def api_send():
    """Send a message out through the open serial connection."""
    global _active_port
    if _active_port is None:
        return jsonify({"ok": False, "error": "No open connection"}), 400

    payload = request.get_json(silent=True) or {}
    raw = (payload.get("data") or "").strip()
    encoding = payload.get("encoding", "ascii")
    if not raw:
        return jsonify({"ok": False, "error": "Empty payload"}), 400

    data = _parse_payload(raw, encoding)
    if data is None:
        return jsonify({"ok": False, "error": "Invalid payload"}), 400

    try:
        _active_port.port.write(data)
    except (serial.SerialException, OSError) as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500

    _append_history(_active_port.port.port, "tx", data)
    return jsonify({"ok": True, "bytes_sent": len(data)})


@app.route("/api/connect", methods=["POST"])
def api_connect():
    """Open the requested serial port at the requested baud rate."""
    global _active_port
    if _active_port is not None:
        return (
            jsonify(
                {"ok": False, "error": f"{_active_port.port.port} already open"}
            ),
            400,
        )

    payload = request.get_json(silent=True) or {}
    device = payload.get("device")
    baud = int(payload.get("baud", 9600))
    if not device:
        return jsonify({"ok": False, "error": "Missing device"}), 400

    try:
        port = serial.Serial(
            device,
            baudrate=baud,
            bytesize=serial.EIGHTBITS,
            parity=serial.PARITY_NONE,
            stopbits=serial.STOPBITS_ONE,
            timeout=0.1,
        )
    except (serial.SerialException, OSError) as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500

    conn = SerialConnection(port=port, reader_thread=None)  # type: ignore[arg-type]
    conn.reader_thread = threading.Thread(
        target=_reader_loop, args=(conn,), daemon=True
    )
    conn.reader_thread.start()
    _active_port = conn

    socketio.emit(
        "serial_status",
        {
            "state": "connected",
            "device": device,
            "baud": baud,
        },
    )
    return jsonify({"ok": True, "device": device, "baud": baud})


@app.route("/api/disconnect", methods=["POST"])
def api_disconnect():
    """Close whichever connection is currently open."""
    global _active_port
    if _active_port is None:
        return jsonify({"ok": False, "error": "Not connected"}), 400

    device = _active_port.port.port
    _active_port.close()
    _active_port = None
    socketio.emit("serial_status", {"state": "disconnected", "device": device})
    return jsonify({"ok": True, "device": device})


# ---------------------------------------------------------------------------
# SocketIO events
# ---------------------------------------------------------------------------


@socketio.on("request_ports")
def handle_request_ports() -> None:
    """Push the current port list to a single client."""
    socketio.emit("ports_update", {"ports": _list_serial_ports()})


@socketio.on("connect")
def handle_connect_event() -> None:
    if _active_port is not None:
        socketio.emit(
            "serial_status",
            {
                "state": "connected",
                "device": _active_port.port.port,
                "baud": _active_port.port.baudrate,
            },
        )


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------


def _device_poller() -> None:
    """Background task: periodically re-emit the port list so the UI picks up
    new devices as they are plugged in (or unplugged)."""
    while True:
        socketio.sleep(2.0)
        socketio.emit("ports_update", {"ports": _list_serial_ports()})


if __name__ == "__main__":
    socketio.start_background_task(_device_poller)
    # use_reloader=False so we don't double-spawn the poller.
    socketio.run(app, host="127.0.0.1", port=5000, use_reloader=False)
