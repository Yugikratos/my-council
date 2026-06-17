# start-all.ps1 — launch all My Council services in separate windows.
#   1. The memory service (Python/ChromaDB)        on port 8000
#   2. The STT service    (Python/faster-whisper)  on port 8001
#   3. The My Council app (Node/Express)           on port 3000
#
# Run from the repo root:  .\start-all.ps1
# (First-time setup — venvs + deps — is in the README.)
#
# NOTE: on its FIRST run the STT service downloads the faster-whisper model once
# (~145MB for the default "base" model) into the Hugging Face cache, so give that
# window a moment the first time.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

$venvPython = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
  Write-Host "Python venv not found at $venvPython" -ForegroundColor Red
  Write-Host "Run the one-time setup first (see README: 'Memory setup')." -ForegroundColor Yellow
  exit 1
}

Write-Host "Starting memory service (ChromaDB) on http://127.0.0.1:8000 ..." -ForegroundColor Cyan
Start-Process -FilePath $venvPython -ArgumentList "app.py" `
  -WorkingDirectory (Join-Path $root "memory-service") -WindowStyle Normal

# STT runs in its own venv (.venv-stt) to keep faster-whisper's deps from
# disturbing the memory service's verified chromadb pin set. Fall back to the
# shared .venv if a dedicated one isn't present.
$sttPython = Join-Path $root ".venv-stt\Scripts\python.exe"
if (-not (Test-Path $sttPython)) { $sttPython = $venvPython }
Write-Host "Starting STT service (faster-whisper) on http://127.0.0.1:8001 ..." -ForegroundColor Cyan
Start-Process -FilePath $sttPython -ArgumentList "app.py" `
  -WorkingDirectory (Join-Path $root "stt-service") -WindowStyle Normal

Write-Host "Starting My Council app (Node) on http://localhost:3000 ..." -ForegroundColor Cyan
Start-Process -FilePath "node" -ArgumentList "server/index.js" `
  -WorkingDirectory $root -WindowStyle Normal

Write-Host ""
Write-Host "Both services launched in their own windows." -ForegroundColor Green
Write-Host "Open http://localhost:3000  (give the memory service a few seconds to load the embedding model on first run)."
Write-Host "Close those windows (or Ctrl+C in each) to stop."
