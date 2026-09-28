# 바탕화면에 "재고 발주 도우미" 아이콘(launch.ps1 실행)을 만들고,
# 예전 버전의 아이콘(열기 / 업데이트 따로)은 지운다.
# 설치하기.bat 과 서버 시작 시(server.js) 호출되며, 여러 번 실행해도 안전하다.

$AppDir = Split-Path -Parent $PSScriptRoot
$Desktop = [Environment]::GetFolderPath("Desktop")

$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut((Join-Path $Desktop "재고 발주 도우미.lnk"))
$s.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$AppDir\windows-autostart\launch.ps1`""
$s.WorkingDirectory = $AppDir
$s.WindowStyle = 7
$s.IconLocation = "$env:SystemRoot\System32\shell32.dll,21"
$s.Description = "재고 발주 도우미 열기 (자동 업데이트 포함)"
$s.Save()

foreach ($old in @("재고 발주 도우미 열기.url", "재고 발주 도우미 업데이트.lnk")) {
  $path = Join-Path $Desktop $old
  if (Test-Path $path) { Remove-Item $path -Force }
}
