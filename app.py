"""
serialPortUI - Flask + SocketIO backend.

Exposes a localhost web UI for selecting a serial device, opening it at a
configurable baud rate, sending messages (ASCII or hex), and watching
incoming data stream in real time.

Features:
  * Auto-refreshed list of available serial devices (poll + on-demand).
  * Each device keeps its own in-memory sent/received history that survives
    until the server is shut down or the user clicks Clear.
  * Broadcasts a 'serial_data' event for every received line and
    'serial_status' whenever the connection state changes.
  * Configurable per-connect line settings (baud, bytesize, parity, stopbits).
  * Optional CR/LF append on outgoing messages.
  * Splits received bytes on newlines so line-based protocols stream
    one line per event.
"""

from __future__ import annotations

import os
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from flask import Flask, jsonify, render_template, request
from flask_socketio import SocketIO
import serial
from serial.tools import list_ports


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_HOST = os.environ.get("SERIAL_PORT_UI_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("SERIAL_PORT_UI_PORT", "5000"))
HISTORY_LIMIT = int(os.environ.get("SERIAL_PORT_UI_HISTORY", "500"))
# How long to wait (in ms) of silence before flushing a buffered RX group as
# a single response event. 300 ms by default matches a comfortable "quiet
# period" for most line-based protocols (AT commands, NMEA, etc.).
COLLAPSE_QUIET_MS = int(os.environ.get("SERIAL_PORT_UI_QUIET_MS", "300"))
SECRET_KEY = os.environ.get(
    "SERIAL_PORT_UI_SECRET",
    "serialPortUI-localhost-only-do-not-expose",
)


# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------

app = Flask(__name__)
app.config["SECRET_KEY"] = SECRET_KEY
# cors_allowed_origins is "*" because this is a localhost-only tool. The
# README and on-launch banner both remind the user to keep it on loopback.
socketio = SocketIO(app, async_mode="eventlet", cors_allowed_origins="*")

# Currently open connection, if any. Only one device open at a time so the
# history-per-device map stays unambiguous.
_active_port: Optional["SerialConnection"] = None
_active_lock = threading.Lock()

# Per-device history: device_id -> list[Message]  (most-recent at the end).
_message_history: Dict[str, List[dict]] = {}

# Per-device RX collator. When the device streams a multi-line response
# (e.g. an AT command reply), each line goes into `pending_lines`. A
# `threading.Timer` fires after `COLLAPSE_QUIET_MS` of silence and emits
# the buffered lines as a single response event so the UI sees one entry
# per logical reply, not one entry per line.
_rx_buffer: Dict[str, dict] = {}
_rx_buffer_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Domain
# ---------------------------------------------------------------------------


@dataclass
class SerialConnection:
    """Wraps an open pyserial.Serial and a background reader thread.

    The reader thread is a real (non-greenlet) OS thread because the
    blocking C call `serial.Serial.read` is the actual workload. eventlet
    greenlets cannot usefully block on a synchronous file descriptor here.
    """

    port: serial.Serial
    reader_thread: threading.Thread
    closing: threading.Event = field(default_factory=threading.Event)
    device: str = ""

    def close(self, join_timeout: float = 1.0) -> None:
        """Signal shutdown, close the port, and wait for the reader to exit."""
        self.closing.set()
        try:
            self.port.close()
        except Exception:
            pass
        if self.reader_thread.is_alive():
            self.reader_thread.join(timeout=join_timeout)


def _list_serial_ports() -> List[dict]:
    """Return a JSON-friendly list of currently-available serial ports."""
    ports = []
    for p in list_ports.comports():
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


# ---------------------------------------------------------------------------
# Message helpers
# ---------------------------------------------------------------------------


def _decode_for_display(data: bytes) -> str:
    """Best-effort text decoding so non-text traffic shows as '<...>'."""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return "<binary: " + data.hex(" ") + ">"


def _make_msg(direction: str, device: str, data) -> dict:
    """Build the JSON shape every event/history entry uses.

    `data` may be either:
      - a single `bytes` chunk (legacy single-line payload), or
      - a `List[bytes]` of lines that should render as one grouped response.
    A single-element list collapses to the same shape as a `bytes` chunk
    so legacy consumers (and tests) don't have to know whether collapsing
    kicked in or not.
    """
    if isinstance(data, list):
        if len(data) == 1:
            return _make_msg(direction, device, data[0])
        text_lines = [_decode_for_display(ln) for ln in data]
        joined_hex = b" ".join(data).hex(" ")
        joined_text = "\n".join(text_lines)
        return {
            "direction": direction,
            "device": device,
            "data_hex": joined_hex,
            "data_text": joined_text,
            "lines": text_lines,
            "timestamp": time.time(),
        }
    return {
        "direction": direction,
        "device": device,
        "data_hex": data.hex(" "),
        "data_text": _decode_for_display(data),
        "timestamp": time.time(),
    }


def _append_history(device: str, direction: str, data) -> None:
    """Push a new entry onto the device's history, trimming if needed.

    `data` may be a `bytes` chunk or a `List[bytes]` of grouped lines — see
    `_make_msg` for the rationale. Both shapes are stored as a single
    history entry so playback replays the original grouping.
    """
    # Normalise a single-element list down to a `bytes` chunk so history
    # rows for "ordinary" single-line traffic keep the legacy shape.
    if isinstance(data, list) and len(data) == 1:
        data = data[0]
    history = _message_history.setdefault(device, [])
    history.append(_make_msg(direction, device, data))
    if len(history) > HISTORY_LIMIT:
        del history[: len(history) - HISTORY_LIMIT]


# ---------------------------------------------------------------------------
# Hex parsing
# ---------------------------------------------------------------------------

# Per-byte 0x prefix, e.g. "0xAA0x01" or "AA 0x01" both work.
_HEX_0X_RE = re.compile(r"0x", re.IGNORECASE)


def _parse_payload(raw: str, encoding: str) -> Optional[bytes]:
    """Convert user-entered text into bytes according to the chosen encoding."""
    if encoding == "hex":
        cleaned = _HEX_0X_RE.sub("", raw)
        cleaned = cleaned.replace(" ", "").replace(",", "").replace("\t", "")
        if len(cleaned) % 2 != 0:
            return None
        try:
            return bytes.fromhex(cleaned)
        except ValueError:
            return None
    # default: ASCII
    return raw.encode("utf-8")


# ---------------------------------------------------------------------------
# Reader loop
# ---------------------------------------------------------------------------


# Splits a byte chunk on \n (and \r on line boundaries) so that line-based
# protocols (AT commands, NMEA, etc.) come out as discrete lines instead of
# a single multi-line blob. Any trailing partial line is yielded as-is.
def _split_lines(buffer: bytearray, chunk: bytes) -> List[bytes]:
    """Pull complete lines out of `buffer+chunk`, leaving the remainder in
    `buffer` for the next call."""
    buffer.extend(chunk)
    lines: List[bytes] = []
    while True:
        # Find the next newline (LF or CRLF).
        lf = buffer.find(b"\n")
        if lf < 0:
            break
        # Strip a single trailing CR if present.
        end = lf
        if end > 0 and buffer[end - 1] == ord("\r"):
            end -= 1
        lines.append(bytes(buffer[:end]))
        del buffer[: lf + 1]
    return lines


def _reader_loop(conn: SerialConnection) -> None:
    """Block reading from the serial port until the connection is closed.

    Captures `conn.device` at enqueue time so the front-end never sees
    messages attributed to a port that has since been closed and reopened.
    """
    line_buffer = bytearray()
    device = conn.device
    while not conn.closing.is_set():
        try:
            waiting = conn.port.in_waiting
            chunk = conn.port.read(max(1, waiting) if waiting else 1)
        except serial.SerialException as exc:
            socketio.emit(
                "serial_status",
                {
                    "state": "error",
                    "device": device,
                    "message": f"Serial read failed: {exc}",
                    "recoverable": True,
                },
            )
            break
        except OSError as exc:
            # USB hiccups land here on Linux (EIO etc.). Tell the user
            # the connection died and surface the reason.
            socketio.emit(
                "serial_status",
                {
                    "state": "error",
                    "device": device,
                    "message": f"OS error: {exc}",
                    "recoverable": True,
                },
            )
            break

        if not chunk:
            continue

        # Split the chunk into complete lines. The trailing partial stays
        # in `line_buffer` until either more bytes complete it, the reader
        # thread exits, or the connection closes — at which point we flush
        # whatever is left so no data is silently dropped.
        complete_lines = _split_lines(line_buffer, chunk)
        if complete_lines:
            # Group writes that happen in quick succession into a single
            # history entry + a single `serial_data` event; the timer below
            # decides when the burst has ended.
            _append_history(device, "rx", complete_lines)
            _schedule_response_flush(device, complete_lines)

    # Reader exiting: if there is a trailing partial line still in the
    # buffer, fold it into the next flush so a stream that ends mid-line
    # still appears in the activity panel.
    if line_buffer:
        tail = bytes(line_buffer)
        line_buffer.clear()
        _append_history(device, "rx", [tail])
        _schedule_response_flush(device, [tail])
    # Force-emit immediately so the user does not wait COLLAPSE_QUIET_MS
    # after disconnect to see the dangling bytes.
    _flush_response_now(device)

    global _active_port
    with _active_lock:
        if _active_port is conn:
            _active_port = None
            socketio.emit(
                "serial_status", {"state": "disconnected", "device": device}
            )


def _emit_line(device: str, direction: str, data: bytes) -> None:
    """Push one already-decoded line to every connected client."""
    socketio.emit("serial_data", _make_msg(direction, device, data))


def _schedule_response_flush(device: str, new_lines: List[bytes]) -> None:
    """Queue `new_lines` for delivery and (re)arm a 300 ms silence timer.

    While lines keep arriving within `COLLAPSE_QUIET_MS` they pile up into
    one buffered group; the moment the device goes quiet for that long the
    whole group is flushed as a single `serial_data` event shaped like a
    response block. If the buffer is non-empty and the timer hasn't fired
    yet, this just resets the timer — no double-emit.
    """
    if not new_lines:
        return
    with _rx_buffer_lock:
        entry = _rx_buffer.get(device)
        if entry is None:
            entry = {"pending": [], "timer": None}
            _rx_buffer[device] = entry
        entry["pending"].extend(new_lines)
        if entry["timer"] is not None:
            entry["timer"].cancel()
        entry["timer"] = threading.Timer(
            COLLAPSE_QUIET_MS / 1000.0,
            _flush_response,
            args=(device,),
        )
        entry["timer"].daemon = True
        entry["timer"].start()


def _flush_response(device: str) -> None:
    """Pop the device's buffered lines and emit them as one response event.

    The timer is cancelled after we hold the lock so we do not race with
    the timer thread; if the timer happens to fire after the pop it will
    simply find an empty buffer and no-op.
    """
    with _rx_buffer_lock:
        entry = _rx_buffer.pop(device, None)
        if entry is None:
            return
        timer = entry.get("timer")
        if timer is not None:
            timer.cancel()
        lines = entry["pending"]
    if not lines:
        return
    payload = _make_msg("rx", device, lines)
    socketio.emit("serial_data", payload)


def _flush_response_now(device: str) -> None:
    """Force-flush any pending RX buffer for `device` right now.

    Called from disconnect paths so the user never loses a half-arrived
    response just because they unplugged at the wrong moment.
    """
    _flush_response(device)


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------

_BYTESIZE_MAP = {
    5: serial.FIVEBITS,
    6: serial.SIXBITS,
    7: serial.SEVENBITS,
    8: serial.EIGHTBITS,
}
_PARITY_MAP = {
    "none": serial.PARITY_NONE,
    "even": serial.PARITY_EVEN,
    "odd": serial.PARITY_ODD,
    "mark": serial.PARITY_MARK,
    "space": serial.PARITY_SPACE,
}
_STOPBITS_MAP = {
    1: serial.STOPBITS_ONE,
    1.5: serial.STOPBITS_ONE_POINT_FIVE,
    2: serial.STOPBITS_TWO,
}


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
    with _active_lock:
        if _active_port is None:
            return jsonify({"ok": False, "error": "No open connection"}), 400
        device = _active_port.device
        port = _active_port.port

    payload = request.get_json(silent=True) or {}
    raw = (payload.get("data") or "").strip()
    encoding = payload.get("encoding", "ascii")
    if not raw:
        return jsonify({"ok": False, "error": "Empty payload"}), 400

    data = _parse_payload(raw, encoding)
    if data is None:
        return jsonify({"ok": False, "error": "Invalid payload"}), 400

    newline = payload.get("newline", "none")
    if newline == "lf":
        data += b"\n"
    elif newline == "crlf":
        data += b"\r\n"
    elif newline == "cr":
        data += b"\r"

    try:
        port.write(data)
    except (serial.SerialException, OSError) as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500

    _append_history(device, "tx", data)
    return jsonify({"ok": True, "bytes_sent": len(data), "device": device})


@app.route("/api/read", methods=["GET"])
def api_read():
    """Force a read from the open serial connection with a timeout.

    Waits up to `timeout_ms` for bytes to arrive and returns whatever
    is read. Useful after sending a command when you want to explicitly
    wait for a response.
    """
    with _active_lock:
        if _active_port is None:
            return jsonify({"ok": False, "error": "No open connection"}), 400
        port = _active_port.port
        device = _active_port.device

    try:
        timeout_ms = max(50, min(int(request.args.get("timeout_ms", 200)), 5000))
    except ValueError:
        timeout_ms = 200

    # Poll the port for up to timeout_ms
    end_time = time.time() + (timeout_ms / 1000.0)
    lines = []
    line_buffer = bytearray()

    while time.time() < end_time:
        remaining = end_time - time.time()
        if remaining <= 0:
            break
        try:
            waiting = port.in_waiting
            chunk = port.read(max(1, waiting) if waiting else 1)
        except (serial.SerialException, OSError):
            break

        if not chunk:
            continue

        complete = _split_lines(line_buffer, chunk)
        lines.extend(complete)

    # Flush any trailing partial
    if line_buffer:
        lines.append(bytes(line_buffer))

    if not lines:
        return jsonify({"ok": True, "lines": [], "device": device})

    # Store in history and emit via SocketIO
    _append_history(device, "rx", lines if len(lines) > 1 else lines[0])
    payload = _make_msg("rx", device, lines if len(lines) > 1 else lines[0])
    socketio.emit("serial_data", payload)

    return jsonify({"ok": True, "lines": [_decode_for_display(ln) for ln in lines], "device": device})


@app.route("/api/connect", methods=["POST"])
def api_connect():
    """Open the requested serial port at the requested settings."""
    payload = request.get_json(silent=True) or {}
    device = (payload.get("device") or "").strip()
    if not device:
        return jsonify({"ok": False, "error": "Missing device"}), 400

    try:
        baud = int(payload.get("baud", 9600))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "Invalid baud rate"}), 400
    if baud <= 0:
        return jsonify({"ok": False, "error": "Baud must be > 0"}), 400

    bytesize = _BYTESIZE_MAP.get(int(payload.get("bytesize", 8)), serial.EIGHTBITS)
    parity = _PARITY_MAP.get(
        str(payload.get("parity", "none")).lower(), serial.PARITY_NONE
    )
    stopbits = _STOPBITS_MAP.get(
        float(payload.get("stopbits", 1)), serial.STOPBITS_ONE
    )

    with _active_lock:
        global _active_port
        if _active_port is not None:
            return (
                jsonify(
                    {
                        "ok": False,
                        "error": f"{_active_port.device} already open",
                    }
                ),
                400,
            )

        try:
            port = serial.Serial(
                device,
                baudrate=baud,
                bytesize=bytesize,
                parity=parity,
                stopbits=stopbits,
                timeout=0.1,
            )
        except (serial.SerialException, OSError) as exc:
            return jsonify({"ok": False, "error": str(exc)}), 500

        conn = SerialConnection(
            port=port,
            reader_thread=None,  # set below
            device=device,
        )
        conn.reader_thread = threading.Thread(
            target=_reader_loop, args=(conn,), daemon=True, name=f"serial-rx:{device}"
        )
        conn.reader_thread.start()
        _active_port = conn

    socketio.emit(
        "serial_status",
        {
            "state": "connected",
            "device": device,
            "baud": baud,
            "bytesize": bytesize,
            "parity": payload.get("parity", "none"),
            "stopbits": float(payload.get("stopbits", 1)),
        },
    )
    return jsonify(
        {
            "ok": True,
            "device": device,
            "baud": baud,
            "bytesize": bytesize,
            "parity": payload.get("parity", "none"),
            "stopbits": float(payload.get("stopbits", 1)),
        }
    )


@app.route("/api/disconnect", methods=["POST"])
def api_disconnect():
    """Close whichever connection is currently open.

    Holds `_active_lock` for the duration so a fresh connect cannot race
    in while the old reader thread is still tearing down.
    """
    global _active_port
    with _active_lock:
        if _active_port is None:
            return jsonify({"ok": False, "error": "Not connected"}), 400
        device = _active_port.device
        _active_port.close()
        _active_port = None
    # Force-flush any in-flight RX buffer so the user never loses a
    # half-arrived response just because they unplugged at the wrong time.
    _flush_response_now(device)
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
    with _active_lock:
        if _active_port is not None:
            socketio.emit(
                "serial_status",
                {
                    "state": "connected",
                    "device": _active_port.device,
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
    socketio.run(
        app,
        host=DEFAULT_HOST,
        port=DEFAULT_PORT,
        use_reloader=False,
    )
