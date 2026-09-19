@echo off
:: Launches llama-server (llama.cpp) for Carter local model inference.
:: Edit the MODEL_PATH and settings below for your hardware.
::
:: Prerequisites:
::   1. Download llama.cpp release from https://github.com/ggerganov/llama.cpp/releases
::      Get the "llama-*-bin-win-cuda-cu12.2.0-x64.zip" build for NVIDIA GPU
::      or "llama-*-bin-win-noavx-x64.zip" for CPU-only.
::   2. Extract to a folder, e.g. C:\llama.cpp\
::   3. Download a GGUF model, e.g.:
::      - Qwen2.5-14B-Instruct-Q4_K_M.gguf  (good balance, 9GB VRAM)
::      - Qwen2.5-7B-Instruct-Q6_K.gguf     (fast, 6GB VRAM)
::      - Llama-3.2-3B-Instruct-Q8_0.gguf   (lightweight, 3GB VRAM)
::      from https://huggingface.co/bartowski or similar
::   4. Set LLAMA_EXE and MODEL_PATH below.
setlocal

:: ── Configuration — edit these ───────────────────────────────────────────────
set LLAMA_EXE=C:\llama.cpp\llama-server.exe
set MODEL_PATH=C:\llama.cpp\models\Qwen2.5-14B-Instruct-Q4_K_M.gguf

:: Context window (tokens). 8192 is safe for most 14B models.
set CTX_SIZE=8192

:: GPU layers to offload. Set to 999 to offload all layers to GPU (recommended).
:: Set to 0 for CPU-only. For partial GPU: set to how many layers fit in VRAM.
set GPU_LAYERS=999

:: Number of parallel request slots (one per concurrent user session)
set PARALLEL=4

:: Port — must match LLAMA_SERVER_URL in .env (default 8080)
set PORT=8080

:: Flash attention (faster, less VRAM). Disable if you see NaN outputs.
set FLASH_ATTN=--flash-attn

:: ── Validation ────────────────────────────────────────────────────────────────
if not exist "%LLAMA_EXE%" (
  echo ERROR: llama-server not found at %LLAMA_EXE%
  echo Download from: https://github.com/ggerganov/llama.cpp/releases
  exit /b 1
)
if not exist "%MODEL_PATH%" (
  echo ERROR: Model not found at %MODEL_PATH%
  echo Download a GGUF model from https://huggingface.co
  exit /b 1
)

:: ── Launch ────────────────────────────────────────────────────────────────────
echo Starting llama-server...
echo   Model:    %MODEL_PATH%
echo   GPU layers: %GPU_LAYERS%
echo   Context:  %CTX_SIZE% tokens
echo   Port:     %PORT%
echo.

"%LLAMA_EXE%" ^
  --model "%MODEL_PATH%" ^
  --ctx-size %CTX_SIZE% ^
  --n-gpu-layers %GPU_LAYERS% ^
  --parallel %PARALLEL% ^
  --port %PORT% ^
  --host 127.0.0.1 ^
  %FLASH_ATTN% ^
  --no-mmap ^
  --log-disable

endlocal
