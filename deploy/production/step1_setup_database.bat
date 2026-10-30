@echo off
REM ============================================================
REM  IPMCS production - STEP 1 (first install only): create the empty database + tables
REM  Uses the Node runtime of ePULSE (E:ePULSE_v1.0.0); set EPULSE_NODE to use another.
REM  See deployproductionREADME.md
REM ============================================================
setlocal
if not defined EPULSE_NODE set "EPULSE_NODE=E:ePULSE_v1.0.0ackend
ode-v22.19.0-win-x64
ode.exe"
if not exist "%EPULSE_NODE%" set "EPULSE_NODE=node"
"%EPULSE_NODE%" "%~dp0setup_database.js" %*
set "RC=%ERRORLEVEL%"
pause
exit /b %RC%
