#!/usr/bin/env bash
# Create the virtual environment and install dependencies.
# Re-run this if you delete the venv directory.

set -e
cd "$(dirname "$0")"

if [ ! -d venv ]; then
    echo "[setup] Creating virtual environment in ./venv ..."
    python3 -m venv venv
fi

echo "[setup] Upgrading pip ..."
./venv/bin/python -m pip install --upgrade pip

echo "[setup] Installing requirements ..."
./venv/bin/python -m pip install -r requirements.txt

echo
echo "[setup] Done. Run ./run.sh to start the UI."
