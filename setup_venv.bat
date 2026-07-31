@echo off
REM Create the virtual environment and install dependencies.
REM Re-run this if you delete the venv directory.

setlocal
cd /d "%~dp0"

if not exist venv (
    echo [setup] Creating virtual environment in .\venv ...
    py -3 -m venv venv
    if errorlevel 1 (
        echo [setup] Failed to create venv. Make sure Python 3.9+ is installed.
        exit /b 1
    )
)

echo [setup] Upgrading pip ...
call venv\Scripts\python.exe -m pip install --upgrade pip

echo [setup] Installing requirements ...
call venv\Scripts\python.exe -m pip install -r requirements.txt

echo.
echo [setup] Done. Run run.bat to start the UI.
endlocal
