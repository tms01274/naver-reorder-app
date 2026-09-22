@echo off
chcp 65001 >nul
title 재고 발주 도우미 - 다시 시작
cd /d "%~dp0"

echo 재고 발주 도우미를 다시 시작할게요...
taskkill /F /IM node.exe >nul 2>nul
timeout /t 1 /nobreak >nul

start "" /min "%~dp0windows-autostart\start-server.bat"
timeout /t 3 /nobreak >nul
start http://localhost:3000

echo.
echo 다시 시작됐어요! 이 창은 닫으셔도 됩니다.
pause
