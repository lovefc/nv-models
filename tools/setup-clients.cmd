@echo off
setlocal
node "%~dp0setup-clients.mjs" %*
if "%~1"=="" pause
