@echo off
:: Downloads prebuilt sqlite-vec extension for Windows x64.
:: sqlite-vec adds native vector similarity search to SQLite —
:: much faster than the current JS cosine similarity loop in vectorSearch.ts.
::
:: After running this, Carter auto-detects vec0.dll and upgrades to native search.
setlocal
cd /d "%~dp0.."

set VEC_VERSION=0.1.6
set VEC_DIR=lib\sqlite-vec
set VEC_DLL=%VEC_DIR%\vec0.dll

if exist "%VEC_DLL%" (
  echo sqlite-vec already installed at %VEC_DLL%
  goto done
)

echo Installing sqlite-vec v%VEC_VERSION% for Windows x64...
if not exist "%VEC_DIR%" mkdir "%VEC_DIR%"

:: Download prebuilt DLL from GitHub releases
set DL_URL=https://github.com/asg017/sqlite-vec/releases/download/v%VEC_VERSION%/sqlite-vec-%VEC_VERSION%-loadable-windows-x86_64.zip
set ZIP=%VEC_DIR%\vec.zip

powershell -Command "Invoke-WebRequest -Uri '%DL_URL%' -OutFile '%ZIP%'" 2>nul
if errorlevel 1 (
  echo ERROR: Download failed. Check internet connection or get it manually from:
  echo   https://github.com/asg017/sqlite-vec/releases
  exit /b 1
)

powershell -Command "Expand-Archive -Path '%ZIP%' -DestinationPath '%VEC_DIR%' -Force"
del "%ZIP%"

:: The zip contains vec0.dll at the root
if not exist "%VEC_DLL%" (
  :: Some releases nest it
  for /f "delims=" %%f in ('dir /s /b "%VEC_DIR%\vec0.dll" 2^>nul') do copy "%%f" "%VEC_DLL%" >nul
)

if exist "%VEC_DLL%" (
  echo sqlite-vec installed successfully: %VEC_DLL%
) else (
  echo WARNING: vec0.dll not found after extraction. Check the zip contents in %VEC_DIR%
  exit /b 1
)

:done
:: Install better-sqlite3 (needed to load the extension)
echo Installing better-sqlite3...
call npm install better-sqlite3 @types/better-sqlite3 2>nul
if errorlevel 1 (
  echo NOTE: better-sqlite3 build failed — Carter will use sql.js fallback.
  echo       For native sqlite-vec, install Visual Studio C++ build tools first.
  exit /b 0
)

echo.
echo sqlite-vec setup complete. Restart Carter to activate native vector search.
endlocal
