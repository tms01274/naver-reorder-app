@echo off
REM 이 파일은 windows-autostart 폴더의 한 단계 위(프로그램 루트)로 이동해서 서버를 켭니다.
cd /d "%~dp0.."

if not exist "data" mkdir "data"

REM 콘솔 창이 안 보이는 상태로 실행되기 때문에, 문제가 생기면
REM data\server-log.txt 파일에서 원인을 확인할 수 있습니다.
node server.js >> "data\server-log.txt" 2>&1
