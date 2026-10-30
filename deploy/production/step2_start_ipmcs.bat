@echo off
REM ============================================================
REM  IPMCS production - STEP 2: start IPMCS (port from backend.env). Keep this window open; closing it stops IPMCS.
REM  Uses the Node runtime of ePULSE (E:ePULSE_v1.0.0); set EPULSE_NODE to use another.
REM  See deployproductionREADME.md
REM ============================================================
setlocal
if not defined EPULSE_NODE set "EPULSE_NODE=E:ePULSE_v1.0.0ackend
ode-v22.19.0-win-x64
ode.exe"
if not exist "%EPULSE_NODE%" set "EPULSE_NODE=node"
title IPMCS Utility v1.0.0
pushd "%~dp0....${appDir}"
"%EPULSE_NODE%" server.js
popd
pause
