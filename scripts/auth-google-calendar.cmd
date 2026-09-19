@echo off
setlocal

set CREDS=%~dp0..\gcp-oauth.keys.json

:: Resolve the npx cache path for the MCP package and copy credentials there
for /f "delims=" %%i in ('npx @cocal/google-calendar-mcp --version 2^>nul ^| findstr /r "." ^| head -1') do set _dummy=%%i
for /f "delims=" %%i in ('node -e "const p=require.resolve('@cocal/google-calendar-mcp/package.json',{paths:[require('path').join(process.env.LOCALAPPDATA,'npm-cache')]});console.log(require('path').dirname(p))" 2^>nul') do set MCP_DIR=%%i

if not defined MCP_DIR (
  :: Fallback: find it by scanning the npx cache
  for /f "delims=" %%i in ('dir /s /b "%LOCALAPPDATA%\npm-cache\_npx\*\node_modules\@cocal\google-calendar-mcp\package.json" 2^>nul ^| head -1') do set MCP_PKG=%%i
  if defined MCP_PKG (
    for %%i in ("%MCP_PKG%") do set MCP_DIR=%%~dpi
    set MCP_DIR=%MCP_DIR:~0,-1%
  )
)

if defined MCP_DIR (
  echo Copying credentials to %MCP_DIR%
  copy /y "%CREDS%" "%MCP_DIR%\gcp-oauth.keys.json" >nul
) else (
  echo Warning: could not locate npx cache dir, trying env var only
)

set GOOGLE_OAUTH_CREDENTIALS=%CREDS%
npx @cocal/google-calendar-mcp auth

endlocal
