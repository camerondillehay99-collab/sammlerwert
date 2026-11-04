@echo off
REM Sammlerwert – Erst-Deployment auf Cloudflare (kostenloser Plan). Einmalig. Benoetigt Node.js 20+ (https://nodejs.org).
cd /d "%~dp0.."
where node >nul 2>nul || (echo Node.js fehlt – bitte von https://nodejs.org installieren ^(LTS^) und erneut starten. & pause & exit /b 1)
echo [1/4] Bei Cloudflare anmelden (Browser oeffnet sich) ...
call npx --yes wrangler@4 login || goto :err
echo [2/4] Konto-ID (fuer GitHub Secrets CLOUDFLARE_ACCOUNT_ID notieren):
call npx --yes wrangler@4 whoami
echo [3/4] Katalog in D1 laden (Teil 1, ca. 1-2 Minuten) ...
call npx --yes wrangler@4 d1 execute sammlerwert --remote --file=deploy\d1-seed-part1.sql --yes || goto :err
echo [4/4] Worker + Frontend deployen ...
call npx --yes wrangler@4 deploy || goto :err
echo.
echo Fertig! URL siehe oben (...workers.dev).
echo Preise + Suche kommen mit dem naechsten naechtlichen GitHub-Actions-Lauf – oder MORGEN manuell: deploy\cloudflare-seed-part2.cmd
echo (D1 erlaubt im Free-Plan 100.000 geschriebene Zeilen pro Tag; Teil 1 hat heute ~41.000 verbraucht.)
pause
exit /b 0
:err
echo FEHLER – siehe Ausgabe oben.
pause
exit /b 1
