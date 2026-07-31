# serialPortUI

A self-contained Python tool that gives any serial port a clean localhost web
interface. Pick a device from a drop-down, choose a baud rate, click
**Connect**, and watch the conversation stream live in your browser.

![status: stable](https://img.shields.io/badge/status-stable-brightgreen)
![python: 3.8+](https://img.shields.io/badge/python-3.8%2B-blue)


---

## Features

- **Auto-refreshing device list** — the drop-down polls every 2 seconds and
  picks up newly plugged-in USB-serial adapters, removed devices, and
  re-numbered COM ports without any user action.
- **Drop-down device picker** — every `COM*` / `/dev/tty*` port shows up with
  its description (`USB-SERIAL CH340`, `USB Serial Port (COM3)`, …) so you can
  tell identical looking devices apart.
- **Per-device message memory** — sent and received bytes are stored on the
  server, keyed by device name. Switch devices, disconnect, reconnect the
  same port — your history is still there. Clear it any time with one click.
- **ASCII or Hex input** — type text messages, or paste `AA 01 0F` style
  frames for binary protocols.
- **Live streaming** — RX and TX appear in the activity panel as they happen,
  via WebSockets. No page refresh needed.
- **Single-file backend** — `app.py` is the entire server. No databases, no
  cloud, no telemetry.

---

## Project layout

```
serialPortUI/
├─ app.py                  # Flask + SocketIO backend
├─ templates/
│  └─ index.html           # UI markup
├─ static/
│  ├─ styles.css           # UI styling
│  └─ app.js               # UI behaviour
├─ requirements.txt        # pinned dependencies
├─ setup_venv.bat          # create venv + install (Windows)
├─ setup_venv.sh           # create venv + install (macOS / Linux)
├─ run.bat                 # launch app (Windows)
├─ run.sh                  # launch app (macOS / Linux)
└─ .gitignore
```

---

## Requirements

- **Python 3.8 or newer** (`python --version` to check).
- A C compiler is **not** required — every dependency ships wheels for
  Windows, macOS, and Linux.
- A serial port (real or virtual). On Windows, `COM1..COM256`. On Linux,
  `/dev/ttyUSB0`, `/dev/ttyACM0`, etc. On macOS, `/dev/tty.usbserial-*`.

---

## Quick start

### Windows

```bat
cd serialPortUI
setup_venv.bat
run.bat
```

### macOS / Linux

```bash
cd serialPortUI
chmod +x setup_venv.sh run.sh
./setup_venv.sh
./run.sh
```

Open your browser at **http://127.0.0.1:5000** and you should see the UI.

> The launcher scripts auto-create a `venv/` directory inside the project so
> you don't have to worry about polluting your system Python.
> If you prefer doing it manually:
>
> ```bash
> python3 -m venv venv
> source venv/bin/activate          # or venv\Scripts\activate on Windows
> pip install -r requirements.txt
> python app.py
> ```

---

## Using the UI

1. **Pick a device** from the drop-down. The list auto-updates every
   two seconds; if you don't see your device, try the round-arrow button to
   refresh manually.
2. **Set the baud rate** (defaults to `9600`). Common values are `9600`,
   `19200`, `38400`, `57600`, `115200`, `230400`, `460800`, `921600`.
3. Click **Connect**. The status pill at the top changes to a green
   `connected to <device>`.
4. **Send messages** in the Send panel. Pick ASCII or Hex, type, press
   Send (or `Ctrl+Enter` / `Cmd+Enter`).
5. **Read responses** in the Activity panel. Each line is time-stamped and
   tagged `TX` (orange) or `RX` (green).
6. **History memory** — when you reconnect to the same device later, the
   previous history is restored. Use the RX/TX checkboxes to filter what's
   shown, or the **Clear history** button to wipe it.

---

## REST API

The Flask server exposes a small JSON API, which is also how the JS front-end
talks to it. All paths are relative to the server root.

| Method | Path             | Body                                                   | Returns                                                                  |
| ------ | ---------------- | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| GET    | `/api/ports`     | —                                                      | `{ "ports": [ { device, description, manufacturer, … }, … ] }`           |
| POST   | `/api/connect`   | `{ "device": "COM3", "baud": 115200 }`                 | `{ "ok": true, "device": "COM3", "baud": 115200 }`                       |
| POST   | `/api/disconnect`| —                                                      | `{ "ok": true, "device": "COM3" }`                                       |
| POST   | `/api/send`      | `{ "data": "hello", "encoding": "ascii" }`             | `{ "ok": true, "bytes_sent": 5 }`                                        |
| GET    | `/api/history?device=COM3&limit=100` | —                                  | `{ "device": "COM3", "messages": [ { direction, data_hex, … } ] }`       |
| POST   | `/api/clear`     | `{ "device": "COM3" }` (omit device to clear all)      | `{ "cleared": "COM3" }`                                                  |

`encoding` for `/api/send` is either `"ascii"` or `"hex"`. Hex inputs may
include spaces, commas, and `0x` prefixes.

---

## SocketIO events

| Event           | Direction | Payload (example)                                                                 |
| --------------- | --------- | ---------------------------------------------------------------------------------- |
| `ports_update`  | server → client | `{ "ports": [...] }`                                                        |
| `serial_status` | server → client | `{ "state": "connected" \| "disconnected" \| "error", "device": ..., "baud": ... }` |
| `serial_data`   | server → client | `{ "direction": "rx" \| "tx", "device": ..., "data_hex": "...", "data_text": "...", "timestamp": ... }` |
| `request_ports` | client → server | (no payload)                                                                      |

---

## Architecture notes

- **One connection at a time.** Only a single device can be open per server.
  This keeps the per-device history map unambiguous. If you need multiple
  ports at once, fork the backend per port or adapt the data model.
- **Read thread.** A daemon `threading.Thread` blocks on `serial.Serial.read`
  with a 100 ms timeout so the rest of the app can shut down promptly when
  you click Disconnect or kill the server.
- **History trimming.** Each device retains up to **500 messages** in RAM.
  Older entries are dropped FIFO so memory stays bounded regardless of how
  long the server runs.
- **Background poller.** A `socketio.start_background_task` runs in the
  SocketIO worker loop and broadcasts `ports_update` every 2 s. Pushing
  plug/unplug events from the OS is brittle across platforms, so polling is
  the simpler and more reliable choice.

---

## Troubleshooting

| Symptom                                              | Fix                                                                                                            |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `PermissionError` on Linux opening `/dev/ttyUSB0`     | Add yourself to the `dialout` group: `sudo usermod -aG dialout $USER` then log out / in.                       |
| Port list stays empty on Windows                     | Check that the device shows up in Device Manager (Ports & COM). Some drivers enumerate under a different class. |
| `ImportError: No module named serial`                | Activate the venv (`venv\Scripts\activate` or `source venv/bin/activate`) before running `app.py` manually.    |
| Page loads but no live data, status pill is "error"  | Click **Refresh** in the drop-down to re-list, then reconnect — the previous port may have disappeared.        |
| Nothing appears in Activity for sent messages        | Confirm the target device is listening on the same baud rate and that echo is disabled if you want one-way TX. |

---

## Author

**Eng. Fredy Osorio** — [ing.fredyosorio@gmail.com](mailto:ing.fredyosorio@gmail.com)
Rio de Janeiro - Brazil, August 2026.

---

## License

MIT — do whatever you'd like, attribution appreciated but not required.
