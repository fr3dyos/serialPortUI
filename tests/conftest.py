"""Pytest fixtures and shared helpers for serialPortUI tests."""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# Make the project root importable so `import app` works without packaging.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


class FakePort:
    """In-memory stand-in for a `serial.Serial`.

    The reader loop calls `in_waiting` and `read()`. We let tests queue
    bytes up via `feed()` and let the reader drain them with whatever
    block size it likes.
    """

    def __init__(self, device="COM3", baud=9600):
        self.port = device
        self.baudrate = baud
        self.bytesize = 8
        self.parity = "N"
        self.stopbits = 1
        self._buf = bytearray()
        self._lock = threading.Lock()
        self._cv = threading.Condition(self._lock)
        self.closed = False
        self.write_log: list[bytes] = []
        self.fail_next_read = None  # Exception instance to raise on next read

    def feed(self, data: bytes) -> None:
        with self._cv:
            self._buf.extend(data)
            self._cv.notify_all()

    @property
    def in_waiting(self) -> int:
        with self._cv:
            return len(self._buf)

    def read(self, n=1):
        with self._cv:
            if self.fail_next_read is not None:
                exc = self.fail_next_read
                self.fail_next_read = None
                raise exc
            if not self._buf:
                # Block up to 100 ms so the read loop is responsive to
                # `close()` calls (which set the closing event and close
                # the port, which unblocks this).
                self._cv.wait(timeout=0.1)
                if not self._buf:
                    return b""
            out = bytes(self._buf[:n])
            del self._buf[:n]
            return out

    def write(self, data: bytes) -> int:
        if self.closed:
            raise RuntimeError("port closed")
        self.write_log.append(data)
        return len(data)

    def close(self) -> None:
        with self._cv:
            self.closed = True
            self._cv.notify_all()


@pytest.fixture
def fake_port():
    return FakePort()


@pytest.fixture
def app_module(monkeypatch, fake_port):
    """Import `app` with a mocked serial module and a freshly-installed
    fake port so the suite never touches real hardware."""

    # Build a mock serial module that returns `fake_port` from `Serial(...)`.
    serial_mod = MagicMock()
    serial_mod.EIGHTBITS = 8
    serial_mod.SEVENBITS = 7
    serial_mod.SIXBITS = 6
    serial_mod.FIVEBITS = 5
    serial_mod.PARITY_NONE = "N"
    serial_mod.PARITY_EVEN = "E"
    serial_mod.PARITY_ODD = "O"
    serial_mod.PARITY_MARK = "M"
    serial_mod.PARITY_SPACE = "S"
    serial_mod.STOPBITS_ONE = 1
    serial_mod.STOPBITS_ONE_POINT_FIVE = 1.5
    serial_mod.STOPBITS_TWO = 2
    serial_mod.SerialException = type("SerialException", (RuntimeError,), {})
    serial_mod.Serial = MagicMock(return_value=fake_port)

    tools_mod = MagicMock()
    tools_mod.comports = MagicMock(return_value=[])

    monkeypatch.setitem(sys.modules, "serial", serial_mod)
    monkeypatch.setitem(sys.modules, "serial.tools", tools_mod)
    monkeypatch.setitem(sys.modules, "serial.tools.list_ports", tools_mod)

    # Re-import `app` so it picks up the mocked `serial`.
    if "app" in sys.modules:
        del sys.modules["app"]
    import app  # noqa: E402

    # Clear any state from a previous test.
    with app._active_lock:
        if app._active_port is not None:
            app._active_port.close()
            app._active_port = None
    app._message_history.clear()
    app._rx_buffer.clear()

    # Make SocketIO a no-op emitter during tests.
    app.socketio.emit = MagicMock()
    app.socketio.start_background_task = MagicMock(side_effect=lambda fn, *a, **kw: fn(*a, **kw))

    return app


@pytest.fixture
def client(app_module):
    return app_module.app.test_client()
