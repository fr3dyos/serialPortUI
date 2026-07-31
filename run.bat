@echo off
REM Launch the serialPortUI Flask server.

setlocal
cd /d "%~dp0"

if not exist venv\Scripts\python.exe (
    echo [run] venv not found. Running setup_venv.bat first...
    call setup_venv.bat
    if errorlevel 1 exit /b 1
)

echo [run] Starting serialPortUI at http://127.0.0.1:5000
echo [run] Press Ctrl+C to stop.
call venv\Scripts\python.exe app.py
endlocal
