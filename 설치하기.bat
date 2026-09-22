@echo off
chcp 65001 >nul
title 재고 발주 도우미 - 설치
cd /d "%~dp0"

echo =========================================
echo   재고 발주 도우미 설치를 시작할게요
echo =========================================
echo.

REM ── 1. Node.js가 설치되어 있는지 확인 ──────────────────
where node >nul 2>nul
if errorlevel 1 (
    echo Node.js라는 프로그램이 먼저 필요해요.
    echo 잠시 후 다운로드 페이지를 열어드릴게요.
    echo.
    echo 페이지가 열리면:
    echo   1^) 초록색 큰 버튼^(LTS라고 써있는 것^)을 눌러 다운로드
    echo   2^) 다운로드된 파일을 실행해서 "다음" -^> "다음" -^> "설치" 버튼만 누르면 끝
    echo   3^) 설치가 끝나면 이 설치하기.bat 파일을 다시 더블클릭 해주세요
    echo.
    pause
    start https://nodejs.org/ko/
    exit /b 0
)

REM ── 2. 필요한 부품 설치 ────────────────────────────────
echo 필요한 부품을 준비하고 있어요. 1~2분 정도 걸릴 수 있어요...
echo.
call npm install
if errorlevel 1 (
    echo.
    echo 준비 중 문제가 생겼어요. 이 화면을 캡처해서 보내주세요.
    pause
    exit /b 1
)

REM ── 3. 설정 파일이 없으면 새로 만들기 ──────────────────
if not exist ".env" (
    copy ".env.example" ".env" >nul
)

REM ── 4. 컴퓨터 켤 때마다 자동으로 실행되도록 등록 ──────
REM (시작프로그램 폴더에 최소화 바로가기를 만듭니다 - 백신에 덜 걸리는 일반적인 방식)
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "TARGET=%~dp0windows-autostart\start-server.bat"
powershell -NoProfile -Command "$s=(New-Object -COM WScript.Shell).CreateShortcut('%STARTUP%\NaverReorderApp.lnk'); $s.TargetPath='%TARGET%'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Save()" >nul

REM ── 5. 바탕화면에 여는 아이콘 / 업데이트 아이콘 만들기 ──
set "DESKTOP=%USERPROFILE%\Desktop"
copy "재고 발주 도우미 열기.url" "%DESKTOP%\재고 발주 도우미 열기.url" >nul 2>nul
powershell -NoProfile -Command "$s=(New-Object -COM WScript.Shell).CreateShortcut('%DESKTOP%\재고 발주 도우미 업데이트.lnk'); $s.TargetPath='%~dp0업데이트.bat'; $s.WorkingDirectory='%~dp0'; $s.Save()" >nul

REM ── 6. 지금 바로 실행하고 브라우저 열기 ────────────────
echo.
echo 설치가 끝났어요! 지금 바로 실행해볼게요...
start "" /min "%TARGET%"
timeout /t 3 /nobreak >nul
start http://localhost:3000

echo.
echo =========================================
echo   설치 완료!
echo =========================================
echo 이제부터는 컴퓨터를 켤 때마다 자동으로 실행돼요.
echo (로그인할 때 검은 창이 잠깐 보였다가 작업표시줄로 최소화돼요 - 정상입니다)
echo 바탕화면에 생긴 "재고 발주 도우미 열기" 아이콘을 더블클릭하면 언제든 화면을 볼 수 있어요.
echo 나중에 업데이트하라는 연락을 받으면 "재고 발주 도우미 업데이트" 아이콘을 더블클릭하세요.
echo.
echo 이 검은 창은 이제 닫으셔도 됩니다.
pause
