# Downloads the rclone binary and places it as the Tauri sidecar
# (src-tauri/binaries/rclone-<target-triple>.exe). Run once after cloning.
$ErrorActionPreference = "Stop"

$dir = Join-Path $PSScriptRoot "..\src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$zip = Join-Path $env:TEMP "rclone.zip"
$extract = Join-Path $env:TEMP "rclone_extract"

Write-Host "Downloading rclone..."
Invoke-WebRequest -Uri "https://downloads.rclone.org/rclone-current-windows-amd64.zip" -OutFile $zip

if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
Expand-Archive -Path $zip -DestinationPath $extract

$exe = Get-ChildItem -Recurse -Path $extract -Filter rclone.exe | Select-Object -First 1
$dest = Join-Path $dir "rclone-x86_64-pc-windows-msvc.exe"
Copy-Item $exe.FullName -Destination $dest -Force

Write-Host "rclone placed at $dest"
& $dest version | Select-Object -First 1
