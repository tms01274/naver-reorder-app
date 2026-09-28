# 바탕화면 "재고 발주 도우미" 아이콘이 실행하는 스크립트
#   1) 새 버전이 있으면 받아서 적용 (인터넷이 안 되면 건너뜀)
#   2) 서버가 꺼져 있으면 켜기 (업데이트됐으면 재시작)
#   3) 서버가 뜰 때까지 기다렸다가 브라우저로 화면 열기
# PowerShell 은 스크립트 전체를 먼저 읽고 실행하므로, 업데이트 중에 이 파일이
# 새 버전으로 덮어써져도 지금 실행은 안전하게 끝까지 진행된다.

$AppDir = Split-Path -Parent $PSScriptRoot
$Port = 3000
$LogFile = Join-Path $AppDir "data\launcher-log.txt"

Set-Location $AppDir
New-Item -ItemType Directory -Force (Join-Path $AppDir "data") | Out-Null
$env:PATH = "C:\Program Files\Git\cmd;C:\Program Files\nodejs;$env:PATH"
# 인증 정보가 없을 때 로그인 창을 띄우며 멈추지 않게 한다
$env:GIT_TERMINAL_PROMPT = "0"
$env:GCM_INTERACTIVE = "never"

function Write-Log($msg) {
  Add-Content -Path $LogFile -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg" -Encoding UTF8
}

function Get-ServerPid {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) { return $conn.OwningProcess }
  return $null
}

function Show-Error($msg) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show($msg, "재고 발주 도우미") | Out-Null
}

# ── 1. 업데이트 확인 ─────────────────────────────────────
$updated = $false
if (Get-Command git -ErrorAction SilentlyContinue) {
  # 네트워크가 느리거나 끊겨도 20초 이상 기다리지 않는다
  $fetch = Start-Process git -ArgumentList "fetch", "origin" -WorkingDirectory $AppDir -WindowStyle Hidden -PassThru
  $null = $fetch.Handle
  if (-not $fetch.WaitForExit(20000)) {
    $fetch.Kill()
    Write-Log "업데이트 확인 시간 초과 - 건너뜀"
  } elseif ($fetch.ExitCode -ne 0) {
    Write-Log "업데이트 확인 실패 (exit $($fetch.ExitCode)) - 건너뜀"
  } else {
    $local = (git rev-parse HEAD).Trim()
    $remote = (git rev-parse origin/main).Trim()
    if ($local -ne $remote) {
      git reset --hard origin/main | Out-Null
      if ($LASTEXITCODE -eq 0) {
        $updated = $true
        Write-Log "업데이트 적용: $local -> $remote"
        git diff --quiet $local $remote -- package.json package-lock.json
        if ($LASTEXITCODE -ne 0) {
          Write-Log "부품 업데이트 (npm install)"
          npm.cmd install --no-audit --no-fund | Out-Null
        }
      } else {
        Write-Log "업데이트 적용 실패 - 기존 버전으로 계속"
      }
    }
  }
}

if (-not (Test-Path (Join-Path $AppDir "node_modules"))) {
  Write-Log "부품 설치 (npm install)"
  npm.cmd install --no-audit --no-fund | Out-Null
}

# ── 2. 서버 켜기 (업데이트됐으면 재시작) ─────────────────
$serverPid = Get-ServerPid
if ($serverPid -and $updated) {
  Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  $serverPid = $null
}
if (-not $serverPid) {
  Write-Log "서버 시작"
  # 창 없이 실행해서 실수로 닫히지 않게 한다 (로그는 data\server-log.txt)
  Start-Process cmd.exe -ArgumentList "/c", "`"$AppDir\windows-autostart\start-server.bat`"" -WindowStyle Hidden
}

# ── 3. 서버가 뜰 때까지 기다렸다가 화면 열기 ─────────────
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  if (Get-ServerPid) { $ready = $true; break }
  Start-Sleep -Milliseconds 500
}

if ($ready) {
  Start-Process "http://localhost:$Port"
} else {
  Write-Log "서버가 15초 안에 켜지지 않음"
  Show-Error "프로그램을 켜지 못했어요.`n`n프로그램 폴더의 data\server-log.txt 파일을 관리자에게 보내주세요."
}
