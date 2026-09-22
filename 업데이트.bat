@echo off
chcp 65001 >nul
title 재고 발주 도우미 - 업데이트
cd /d "%~dp0"
set "PATH=C:\Program Files\Git\cmd;%PATH%"

echo =========================================
echo   재고 발주 도우미 업데이트를 시작할게요
echo =========================================
echo.

where git >nul 2>nul
if errorlevel 1 (
    echo Git이라는 프로그램이 먼저 필요해요. 관리자에게 문의해주세요.
    pause
    exit /b 1
)

echo 최신 버전을 받아오고 있어요...
git fetch origin
if errorlevel 1 (
    echo.
    echo 업데이트 받기에 실패했어요. 인터넷 연결을 확인해주세요.
    pause
    exit /b 1
)

git reset --hard origin/main
if errorlevel 1 (
    echo.
    echo 업데이트 적용 중 문제가 생겼어요. 이 화면을 캡처해서 보내주세요.
    pause
    exit /b 1
)

echo.
echo 필요한 부품을 업데이트하고 있어요...
call npm install
if errorlevel 1 (
    echo.
    echo 부품 설치 중 문제가 생겼어요. 이 화면을 캡처해서 보내주세요.
    pause
    exit /b 1
)

echo.
echo 업데이트가 끝났어요! 프로그램을 다시 시작할게요...
taskkill /F /IM node.exe >nul 2>nul
timeout /t 1 /nobreak >nul
start "" /min "%~dp0windows-autostart\start-server.bat"
timeout /t 3 /nobreak >nul
start http://localhost:3000

echo.
echo =========================================
echo   업데이트 완료!
echo =========================================
echo 내 설정(.env)과 저장된 데이터는 그대로 유지됩니다.
echo 이 창은 닫으셔도 됩니다.
pause
