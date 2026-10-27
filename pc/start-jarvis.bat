@echo off
rem Starts Jarvis's brain on this PC. Double-click it; the first run installs everything (all free).
setlocal
chcp 65001 >nul
title Jarvis
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set "PATH=%PATH%;%LOCALAPPDATA%\Programs\Ollama;%LOCALAPPDATA%\Microsoft\WinGet\Links"
set "WINGET=winget install -e --silent --accept-source-agreements --accept-package-agreements --id"
set INSTALLED=

rem ---- Python ----
set "PY="
py -3 --version >nul 2>nul && set "PY=py -3"
if not defined PY python --version >nul 2>nul && set "PY=python"
if not defined PY (
  echo Installing Python...
  %WINGET% Python.Python.3.12 || goto :manual
  set INSTALLED=1
)

rem ---- Ollama (runs the AI models) ----
where ollama >nul 2>nul
if errorlevel 1 (
  echo Installing Ollama...
  %WINGET% Ollama.Ollama || goto :manual
  set INSTALLED=1
)

rem ---- cloudflared (gives the PC a secure address your iPhone can open) ----
set "CF="
where cloudflared >nul 2>nul && set CF=1
if exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" set CF=1
if exist "%ProgramFiles%\cloudflared\cloudflared.exe" set CF=1
if not defined CF (
  echo Installing cloudflared...
  %WINGET% Cloudflare.cloudflared || goto :manual
)

if defined INSTALLED (
  echo.
  echo Everything is installed. Close this window and double-click start-jarvis.bat again.
  pause
  exit /b
)

rem ---- Jarvis's own Python packages ----
if not exist ".venv\Scripts\python.exe" (
  echo Setting up Jarvis, this takes a few minutes the first time...
  %PY% -m venv .venv || goto :failed
)
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r requirements.txt || goto :failed

".venv\Scripts\python.exe" jarvis_server.py
pause
exit /b

:manual
echo.
echo Couldn't install automatically. Please install these yourself (all free), then run this again:
echo   Python 3.12:  https://www.python.org/downloads/  (tick "Add python.exe to PATH")
echo   Ollama:       https://ollama.com/download
echo   cloudflared:  https://github.com/cloudflare/cloudflared/releases/latest  (cloudflared-windows-amd64.msi)
pause
exit /b

:failed
echo.
echo Something went wrong setting up Jarvis. Check your internet connection and try again.
pause
exit /b
