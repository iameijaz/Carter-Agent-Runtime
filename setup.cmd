@echo off
:: Carter full setup script.
:: Run this once on any machine after cloning the repo. Safe to re-run.
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo ============================================================
echo  Carter Setup
echo ============================================================
echo.

:: ── 1. Node dependencies ─────────────────────────────────────────────────────
echo [1/4] Installing Node packages...
where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm not found. Install Node.js from https://nodejs.org
  exit /b 1
)
call npm install
if errorlevel 1 ( echo ERROR: npm install failed. & exit /b 1 )
echo       Done.
echo.

:: ── 2. Python venv (PDF parse, OCR, markitdown) ──────────────────────────────
echo [2/4] Setting up Python venv...
where python >nul 2>&1
if errorlevel 1 (
  echo SKIP: Python not found. Install Python 3.9+ from https://python.org
  echo       Carter works without it, but document_parse and OCR will be unavailable.
  goto skip_python
)
call scripts\setup-python.cmd
:skip_python
echo.

:: ── 3. .env file ─────────────────────────────────────────────────────────────
echo [3/5] Checking .env...
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo       Created .env from .env.example — fill in your API keys before running.
) else (
  echo       .env already exists.
)
echo.

:: ── 4. yt-dlp + ffmpeg (media downloads) ────────────────────────────────────
echo [4/5] Checking yt-dlp and ffmpeg...
where yt-dlp >nul 2>&1
if errorlevel 1 (
  echo       yt-dlp not found.
  where winget >nul 2>&1
  if not errorlevel 1 (
    echo       Installing yt-dlp via winget...
    winget install --id yt-dlp.yt-dlp -e --silent
  ) else (
    echo       Install manually: winget install yt-dlp  OR  choco install yt-dlp
  )
) else (
  echo       yt-dlp found.
  yt-dlp --update-to stable 2>nul || echo       ^(could not auto-update yt-dlp^)
)

where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo       ffmpeg not found ^(needed for audio extraction and format merging^).
  where winget >nul 2>&1
  if not errorlevel 1 (
    echo       Installing ffmpeg via winget...
    winget install --id Gyan.FFmpeg -e --silent
  ) else (
    echo       Install manually: winget install ffmpeg  OR  choco install ffmpeg
  )
) else (
  echo       ffmpeg found.
)
echo.

:: ── 5. GPU detection (informational) ─────────────────────────────────────────
echo [5/5] Checking for GPU...
where nvidia-smi >nul 2>&1
if errorlevel 1 (
  echo       No NVIDIA GPU detected ^(nvidia-smi not found^).
  echo       Local LLM inference will run on CPU via llama.cpp.
) else (
  for /f "tokens=1" %%m in ('nvidia-smi --query-gpu^=memory.total --format^=csv^,noheader^,nounits 2^>nul') do (
    set /a VRAM_GB=%%m/1024
    echo       GPU found: !VRAM_GB! GB VRAM
    echo       To use local LLM: edit scripts\start-llama-server.cmd then run it.
  )
)
echo.

:: ── Done ─────────────────────────────────────────────────────────────────────
echo ============================================================
echo  Setup complete. Next steps:
echo.
echo  1. Edit .env and fill in API keys.
echo  2. Google Calendar auth: scripts\auth-google-calendar.cmd
echo  3. Local LLM (optional): edit + run scripts\start-llama-server.cmd
echo  4. Start Carter:
echo       npm run web       - Web UI at http://127.0.0.1:3131
echo       npm run telegram  - Telegram bot
echo       npm run dev       - CLI
echo ============================================================
endlocal
