@echo off
cd /d "%~dp0"
echo Deploying Quiz Arena to Cloudflare...
npx wrangler deploy
pause
