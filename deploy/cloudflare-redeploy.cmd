@echo off
REM Sammlerwert – schnelles Redeploy (Code + Frontend). Dauert ~20 Sekunden.
cd /d "%~dp0.."
call npx --yes wrangler@4 deploy
pause
