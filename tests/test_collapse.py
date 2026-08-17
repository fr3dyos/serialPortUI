"""Tests for the RX response-collapse behaviour.

Two RX chunks arriving within COLLAPSE_QUIET_MS of each other should be
folded into a single `serial_data` event carrying a `lines` array. Two
chunks separated by more than the quiet period should produce two
distinct, single-line events.
"""

from __future__ import annotations

import time

import pytest


def _serial_data_calls(app):
    """Return the list of payloads emitted as `serial_data` so far."""
    return [
        call.args[1]
        for call in app.socketio.emit.call_args_list
        if call.args and call.args[0] == "serial_data"
    ]


def _drain_reader(app):
    """Join the reader thread if it is still alive (it usually isn't)."""
    with app._active_lock:
        conn = app._active_port
    if conn is not None and conn.reader_thread.is_alive():
        conn.reader_thread.join(timeout=2.0)


@pytest.fixture
def connected(app_module, fake_port, client):
    res = client.post(
        "/api/connect",
        json={"device": "COM3", "baud": 9600, "parity": "none", "bytesize": 8, "stopbits": 1},
    )
    assert res.status_code == 200, res.get_data(as_text=True)
    # Some background tasks may have run; reset the mock so we only see
    # the events triggered by this test.
    app_module.socketio.emit.reset_mock()
    return app_module, fake_port, client


def test_two_close_lines_collapse_into_one_event(connected):
    app, fake_port, _ = connected
    # Two LF-terminated lines back-to-back. The reader loop splits them
    # into two lines, both get queued, and a single 300 ms timer fires.
    fake_port.feed(b"HELLO\r\nWORLD\r\n")
    # Wait well past the quiet period so the timer fires.
    time.sleep((app.COLLAPSE_QUIET_MS / 1000.0) + 0.2)
    events = _serial_data_calls(app)
    assert len(events) == 1, f"expected one grouped event, got {events}"
    payload = events[0]
    assert payload["direction"] == "rx"
    assert payload["device"] == "COM3"
    assert payload["lines"] == ["HELLO", "WORLD"]
    # No explicit `test_late_feeds_emit_separate_events` for the
    # opposite case, see below.


def test_lines_separated_by_quiet_period_emit_separately(connected):
    app, fake_port, _ = connected
    fake_port.feed(b"ALPHA\r\n")
    time.sleep((app.COLLAPSE_QUIET_MS / 1000.0) + 0.1)
    fake_port.feed(b"BETA\r\n")
    time.sleep((app.COLLAPSE_QUIET_MS / 1000.0) + 0.1)
    events = _serial_data_calls(app)
    assert len(events) == 2, f"expected two events, got {events}"
    # Each event should be a single-line payload, not grouped.
    for ev in events:
        assert "lines" not in ev
        assert ev["data_text"] in ("ALPHA", "BETA")


def test_partial_then_complete_line_groups_together(connected):
    """An AT-reply streaming one byte at a time should still collapse."""
    app, fake_port, _ = connected
    for byte in b"OK\r\n":
        fake_port.feed(bytes([byte]))
        time.sleep(0.01)  # 10 ms between bytes — well under 300 ms
    time.sleep((app.COLLAPSE_QUIET_MS / 1000.0) + 0.1)
    events = _serial_data_calls(app)
    # OK\r\n is exactly one line so the payload should be either single
    # or grouped into ["OK"]; either way data_text is "OK".
    assert len(events) == 1
    assert events[0]["data_text"] == "OK"


def test_disconnect_flushes_pending_buffer(connected):
    app, fake_port, client = connected
    fake_port.feed(b"FOO\r\nBAR\r\n")
    # Give the reader thread a moment to drain the buffered bytes into
    # the response collator. In production the same window would be
    # provided by the OS delivering chunks to the reader; we just want
    # to land in the state where quiet-period group flush matters.
    time.sleep(0.05)
    res = client.post("/api/disconnect")
    assert res.status_code == 200
    events = _serial_data_calls(app)
    grouped = [ev for ev in events if ev.get("lines")]
    assert len(grouped) == 1, f"expected one grouped flush, got {events}"
    assert grouped[0]["lines"] == ["FOO", "BAR"]


def test_history_records_grouped_entry(connected):
    app, fake_port, _ = connected
    fake_port.feed(b"one\r\ntwo\r\nthree\r\n")
    time.sleep((app.COLLAPSE_QUIET_MS / 1000.0) + 0.1)
    history = app._message_history["COM3"]
    # Even though three lines arrived the history should hold ONE entry.
    assert len(history) == 1
    assert history[0]["lines"] == ["one", "two", "three"]
