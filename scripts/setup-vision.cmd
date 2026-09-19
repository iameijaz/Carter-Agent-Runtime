@echo off
:: Carter Vision + OS Control Setup
:: Run once per machine — safe to re-run.
:: Installs: @nut-tree/nut-js (mouse/keyboard), jimp (image processing),
::           Python vision deps (pyautogui, mss for local fallback),
::           validates GPT-4o vision key and local VRAM.
setlocal enabledelayedexpansion

set ROOT=%~dp0..
set VISION_VENV=%ROOT%\vision-venv

echo ============================================================
echo  Carter Vision ^& OS Control Setup
echo ============================================================
echo.

:: ── 1. Node.js check ─────────────────────────────────────────
echo [1/6] Checking Node.js...
node --version >nul 2>&1
if errorlevel 1 (
  echo ERROR: node not found. Install Node.js 18+ from https://nodejs.org
  exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo     Node.js %%v — OK

:: ── 2. Install @nut-tree/nut-js ──────────────────────────────
echo.
echo [2/6] Installing @nut-tree/nut-js (mouse + keyboard control)...
cd /d "%ROOT%"
call npm install --save @nut-tree-fork/nut-js 2>&1 | findstr /v "npm warn"
if errorlevel 1 (
  echo   @nut-tree-fork/nut-js failed, trying @nut-tree/nut-js...
  call npm install --save @nut-tree/nut-js 2>&1 | findstr /v "npm warn"
  if errorlevel 1 (
    echo ERROR: nut-js install failed. You may need Visual C++ Build Tools.
    echo        Download: https://visualstudio.microsoft.com/visual-cpp-build-tools/
    echo        Then re-run this script.
    exit /b 1
  )
  echo     @nut-tree/nut-js installed
) else (
  echo     @nut-tree-fork/nut-js installed
)

:: ── 3. Install jimp (image processing / template matching) ───
echo.
echo [3/6] Installing jimp (image processing)...
call npm install --save jimp 2>&1 | findstr /v "npm warn"
if errorlevel 1 (
  echo ERROR: jimp install failed.
  exit /b 1
)
echo     jimp installed

:: ── 4. Python vision venv ─────────────────────────────────────
echo.
echo [4/6] Setting up Python vision venv...
python --version >nul 2>&1
if errorlevel 1 (
  echo   WARNING: python not found — local vision fallback will be unavailable.
  echo            Install Python 3.9+ from https://python.org to enable it.
  goto skip_python
)

if exist "%VISION_VENV%\Scripts\python.exe" (
  echo   vision-venv already exists, updating...
  "%VISION_VENV%\Scripts\pip" install --quiet --upgrade pyautogui mss pillow
  goto python_done
)

echo   Creating vision-venv...
python -m venv "%VISION_VENV%"
if errorlevel 1 (
  echo ERROR: venv creation failed.
  exit /b 1
)

echo   Installing pyautogui, mss, pillow...
"%VISION_VENV%\Scripts\pip" install --quiet pyautogui mss pillow
if errorlevel 1 (
  echo ERROR: pip install failed.
  exit /b 1
)

:python_done
"%VISION_VENV%\Scripts\python" -c "import pyautogui, mss, PIL; print('    pyautogui + mss + pillow — OK')"

:skip_python

:: ── 5. Check VRAM for local vision model ─────────────────────
echo.
echo [5/6] Checking GPU / VRAM for local vision model fallback...
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>nul
if errorlevel 1 (
  echo   No NVIDIA GPU detected — local vision model unavailable.
  echo   GPT-4o vision will be used as primary, with template matching as fallback.
) else (
  echo   GPU detected. Local vision model (moondream2 ~2GB) can be loaded via llama.cpp.
  echo   To enable: download moondream2 GGUF and set LLAMA_SERVER_URL in .env
)

:: ── 6. Write vision config to .env ───────────────────────────
echo.
echo [6/6] Checking .env for vision config...
set ENV_FILE=%ROOT%\.env
findstr /c:"VISION_VENV" "%ENV_FILE%" >nul 2>&1
if errorlevel 1 (
  echo VISION_VENV=%ROOT%\vision-venv>> "%ENV_FILE%"
  echo   Added VISION_VENV to .env
) else (
  echo   VISION_VENV already in .env
)

findstr /c:"VISION_HIL_TIMEOUT" "%ENV_FILE%" >nul 2>&1
if errorlevel 1 (
  echo VISION_HIL_TIMEOUT=30000>> "%ENV_FILE%"
  echo   Added VISION_HIL_TIMEOUT=30000 to .env
)

:: ── Summary ──────────────────────────────────────────────────
echo.
echo ============================================================
echo  Setup complete. Carter vision tools are ready.
echo.
echo  Usage:
echo    npm run web          — start Carter (vision tools auto-available)
echo    npm run browser      — start persistent browser service (optional)
echo.
echo  Vision fallback chain:
echo    1. GPT-4o vision (primary)
echo    2. Local llava/moondream2 via llama.cpp (if LLAMA_SERVER_URL set)
echo    3. Template matching via jimp (pixel comparison)
echo    4. HIL escalation (show screenshot, ask user to click)
echo ============================================================
endlocal
