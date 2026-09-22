@echo off
chcp 65001 >nul
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
del "%STARTUP%\NaverReorderApp.lnk" >nul 2>nul
echo.
echo 자동 시작이 해제됐습니다. (컴퓨터를 켜도 더 이상 자동으로 실행되지 않습니다)
pause
