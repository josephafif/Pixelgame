@echo off
rem Pixelgame: starts the server manager (a control panel in your browser).
chcp 65001 >nul
title Pixelgame-servern
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

if exist "node_modules\ws\package.json" goto run
echo.
echo   Förbereder servern första gången...
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 goto npmfail

:run
node scripts\host.mjs %*
echo.
pause
exit /b 0

:nonode
echo.
echo   Node.js behövs för att köra servern, men finns inte på datorn.
echo.
where winget >nul 2>nul
if errorlevel 1 goto manual
echo   Installerar Node.js LTS med winget. Godkänn frågan som kommer upp.
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
if errorlevel 1 goto manual
echo.
echo   Klart! Stäng det här fönstret och dubbelklicka på Starta-server igen.
pause
exit /b 0

:manual
echo   Hämta Node.js LTS från https://nodejs.org, installera det och
echo   dubbelklicka sedan på Starta-server igen.
start "" https://nodejs.org/
pause
exit /b 1

:npmfail
echo.
echo   Det gick inte att förbereda servern. Kontrollera internetanslutningen och försök igen.
pause
exit /b 1
