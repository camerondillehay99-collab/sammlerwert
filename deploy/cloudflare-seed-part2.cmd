@echo off
REM Teil 2 des Seeds (Suchindex + Preise). Fruehestens am Tag nach Teil 1 ausfuehren (Free-Plan-Schreiblimit, Reset 00:00 UTC).
REM Nicht noetig, wenn der naechtliche GitHub-Actions-Job laeuft – der macht das automatisch.
cd /d "%~dp0.."
call npx --yes wrangler@4 d1 execute sammlerwert --remote --file=deploy\d1-seed-part2.sql --yes
pause
