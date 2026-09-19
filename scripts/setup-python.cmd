@echo off
:: Sets up the Python venv for all Carter Python tools:
::   - markitdown (file_read)
::   - docling, marker, pdfplumber, pymupdf (document_parse)
::   - paddleocr, tesseract wrapper, pillow (ocr_extract)
:: Run once per machine. Re-running is safe.
setlocal EnableDelayedExpansion
cd /d "%~dp0.."

set VENV=%~dp0..\markitdown-venv

:: ── Check Python ────────────────────────────────────────────────────────────
where python >nul 2>&1
if errorlevel 1 (
  echo ERROR: Python not found. Install Python 3.9+ from https://python.org
  exit /b 1
)
for /f "tokens=2 delims= " %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo Python %PYVER% found.

:: ── Create or reuse venv ────────────────────────────────────────────────────
if not exist "%VENV%\Scripts\python.exe" (
  echo Creating Python venv...
  python -m venv "%VENV%"
  if errorlevel 1 ( echo ERROR: venv creation failed. & exit /b 1 )
)

set PIP=%VENV%\Scripts\pip.exe
set PY=%VENV%\Scripts\python.exe

:: ── Core: markitdown ────────────────────────────────────────────────────────
echo [1/4] Installing markitdown...
"%PIP%" install --quiet --upgrade markitdown[all]

:: ── Document parse: docling + marker + pdfplumber + pymupdf ─────────────────
echo [2/4] Installing document parse providers...
"%PIP%" install --quiet --upgrade pdfplumber pymupdf requests beautifulsoup4

:: docling — heavy but best quality; skip on error (optional tier)
"%PIP%" install --quiet docling 2>nul || echo       docling skipped (install it manually for best quality)

:: marker — layout-aware PDF to Markdown
"%PIP%" install --quiet marker-pdf 2>nul || echo       marker skipped

:: ── OCR: paddleocr + tesseract wrapper ──────────────────────────────────────
echo [3/4] Installing OCR providers...
"%PIP%" install --quiet --upgrade paddleocr pillow

:: pytesseract (needs Tesseract binary installed separately)
"%PIP%" install --quiet pytesseract
echo       Note: Tesseract binary required for tier-2 OCR.
echo             Windows: choco install tesseract  or  https://github.com/UB-Mannheim/tesseract/wiki

:: ── Research: no extra Python deps (pure HTTP in Node) ─────────────────────
echo [4/4] Research search uses Node HTTP — no Python deps needed.

:: ── Summary ─────────────────────────────────────────────────────────────────
echo.
echo Venv ready at %VENV%
"%PY%" -c "import markitdown, pdfplumber, fitz; print('Core packages OK')"
echo Run 'npm run web' or 'npm run telegram' to start Carter.
endlocal
