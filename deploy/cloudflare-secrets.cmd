@echo off
REM Geheime Schluessel setzen (werden interaktiv abgefragt, nie in Dateien gespeichert). Leer lassen = ueberspringen.
cd /d "%~dp0.."
for %%K in (EBAY_CLIENT_ID EBAY_CLIENT_SECRET STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PRICE_SAMMLER STRIPE_PRICE_PRO) do (
  echo.
  echo --- %%K ---
  call npx --yes wrangler@4 secret put %%K
)
pause
