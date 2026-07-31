#!/usr/bin/env bash
# Launch the serialPortUI Flask server.

set -e
cd "$(dirname "$0")"

if [ ! -x venv/bin/python ]; then
    echo "[run] venv not found. Running setup_venv.sh first..."
    bash setup_venv.sh
fi

echo "[run] Starting serialPortUI at http://127.0.0.1:5000"
echo "[run] Press Ctrl+C to stop."
exec ./venv/bin/python app.py
