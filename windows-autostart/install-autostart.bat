@echo off
chcp 65001 >nul
echo =========================================
echo   재고 발주 도우미 - 자동 시작 설치
echo =========================================
echo.

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "TARGET=%~dp0start-server.bat"

powershell -NoProfile -Command "$s=(New-Object -COM WScript.Shell).CreateShortcut('%STARTUP%\NaverReorderApp.lnk'); $s.TargetPath='%TARGET%'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Save()"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo 설치 중 문제가 발생했습니다. 이 창을 캡처해서 보내주세요.
    pause
    exit /b 1
)

echo.
echo 설치 완료! 이제 컴퓨터를 켜고 로그인하면 자동으로 서버가 실행됩니다.
echo (로그인할 때 검은 창이 잠깐 보였다가 작업표시줄로 최소화됩니다)
echo.
echo 지금 바로 켜보시려면 아무 키나 누르세요...
pause >nul

start "" /min "%TARGET%"

echo.
echo 몇 초 기다린 후 브라우저에서 http://localhost:3000 접속해서 확인해보세요.
pause
