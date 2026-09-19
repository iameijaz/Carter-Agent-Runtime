@echo off
:: Sets up the markitdown Python venv for Carter.
:: Run once per machine. Re-running is safe (venv already exists -> skips creation).
setlocal

set VENV=%~dp0..\markitdown-venv

if exist "%VENV%\Scripts\python.exe" (
  echo markitdown venv already exists, updating packages...
  "%VENV%\Scripts\pip" install --quiet --upgrade markitdown[all]
  goto done
)

echo Creating Python venv at %VENV%...
python -m venv "%VENV%"
if errorlevel 1 (
  echo ERROR: python not found. Install Python 3.9+ from https://python.org and re-run this script.
  exit /b 1
)

echo Installing markitdown...
"%VENV%\Scripts\pip" install --quiet markitdown[all]
if errorlevel 1 (
  echo ERROR: pip install failed.
  exit /b 1
)

:done
echo markitdown venv ready at %VENV%
"%VENV%\Scripts\python" -c "import markitdown; print('markitdown version:', markitdown.__version__)"
endlocal
