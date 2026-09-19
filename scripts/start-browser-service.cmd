@echo off
echo [Carter] Starting persistent browser service...
cd /d "%~dp0"
node src\browser\service.js
