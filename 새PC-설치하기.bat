@echo off
chcp 65001 >nul
title 재고 발주 도우미 - 새 PC 설치
REM 새 PC 에 프로그램을 설치한다. 구글 드라이브 '아틀리에말리 백업' 폴더에 자동으로 들어가 있고, 거기서 더블클릭하면 된다.
REM Git · Node.js 가 없으면 설치 → 프로그램 받기(C:\naver-reorder-app) → 설치하기.bat (아이콘 · 자동 실행 · 화면 열기)
REM 데이터 가져오기와 네이버 API 키는 프로그램 화면의 '새 PC 설정' 창에서 한다.

set "APP=C:\naver-reorder-app"
set "REPO=https://github.com/tms01274/naver-reorder-app.git"
set "PATH=%PATH%;C:\Program Files\Git\cmd;C:\Program Files\nodejs"

echo =========================================
echo   재고 발주 도우미를 이 PC에 설치할게요
echo =========================================
echo.

if exist "%APP%\server.js" (
    echo 이미 프로그램이 있어요. 설치 마무리만 할게요.
    goto finish
)

REM ── 1. Git · Node.js 준비 ─────────────────────────────
where winget >nul 2>nul
if errorlevel 1 goto manual

where git >nul 2>nul
if errorlevel 1 (
    echo [1/3] Git 을 설치하고 있어요. 확인 창이 뜨면 '예'를 눌러주세요...
    winget install --id Git.Git -e --silent --accept-source-agreements --accept-package-agreements
)
where node >nul 2>nul
if errorlevel 1 (
    echo [2/3] Node.js 를 설치하고 있어요. 확인 창이 뜨면 '예'를 눌러주세요...
    winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements
)

where git >nul 2>nul
if errorlevel 1 goto manual
where node >nul 2>nul
if errorlevel 1 goto manual

REM ── 2. 프로그램 받기 ──────────────────────────────────
echo [3/3] 프로그램을 받고 있어요...
git clone "%REPO%" "%APP%"
if errorlevel 1 (
    echo.
    echo 프로그램을 받지 못했어요. 인터넷 연결을 확인하고 다시 실행해주세요.
    echo 계속 안 되면 이 화면을 캡처해서 관리자에게 보내주세요.
    pause
    exit /b 1
)

:finish
REM ── 3. 설치 마무리 (부품 설치 · 바탕화면 아이콘 · 자동 실행 · 화면 열기) ──
call "%APP%\설치하기.bat"
exit /b 0

:manual
echo.
echo 이 PC 에서는 자동 설치가 안 돼요. 두 프로그램을 직접 설치해주세요.
echo   1^) Git       : 열리는 페이지에서 다운로드 -^> 실행 -^> '다음'만 계속 누르기
echo   2^) Node.js   : 초록색 LTS 버튼으로 다운로드 -^> 실행 -^> '다음'만 계속 누르기
echo 둘 다 설치한 뒤 이 파일을 다시 더블클릭해주세요.
echo.
pause
start https://git-scm.com/download/win
start https://nodejs.org/ko/
exit /b 0
