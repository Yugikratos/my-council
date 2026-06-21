@echo off
:: Set title of the launcher
title My Council Launcher

echo ==========================================
echo        Starting My Council Companion
echo ==========================================
echo.

:: Change directory to script location to support run as admin or shortcut launches
cd /d "%~dp0"

:: Resolve absolute path for Python virtual environment
set "VENV_PYTHON=%~dp0.venv\Scripts\python.exe"

if not exist "%VENV_PYTHON%" (
    echo [ERROR] Python virtual environment not found at:
    echo %VENV_PYTHON%
    echo Please make sure you have run the setup process in the README.
    echo.
    pause
    exit /b 1
)

:: Start memory service (ChromaDB) on port 8000
echo [+] Launching Memory Service (ChromaDB)...
start "My Council - Memory Service" /D "%~dp0memory-service" /min "%VENV_PYTHON%" app.py

:: Check if stt virtual environment exists, fallback to general venv if not
set "STT_PYTHON=%~dp0.venv-stt\Scripts\python.exe"
if not exist "%STT_PYTHON%" (
    set "STT_PYTHON=%VENV_PYTHON%"
)

:: Start STT service (faster-whisper) on port 8001
echo [+] Launching STT Service (faster-whisper)...
start "My Council - STT Service" /D "%~dp0stt-service" /min "%STT_PYTHON%" app.py

:: Start Electron widget asynchronously and exit CMD window immediately
echo [+] Launching Desktop Widget (Electron)...
start "" "node_modules\.bin\electron" .
exit
