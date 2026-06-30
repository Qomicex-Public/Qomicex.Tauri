param(
  [string]$Rid = "win-x64",
  [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendProj = Join-Path $RepoRoot "src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj"
$EmbedDir = Join-Path $RepoRoot "src-tauri/binaries"

Write-Host "=== Publish backend ($Rid, $Configuration, framework-dependent, single-file) ==="
dotnet publish $BackendProj `
  --configuration $Configuration `
  --runtime $Rid `
  --self-contained false `
  -p:PublishSingleFile=true `
  -p:DebugType=embedded `
  --output (Join-Path $EmbedDir "backend-tmp")

if ($LASTEXITCODE -ne 0) { throw "Backend publish failed" }

# Overwrite placeholder with real backend exe (embedded in Rust binary)
Copy-Item -Force (Join-Path $EmbedDir "backend-tmp/Qomicex.Launcher.Backend.exe") (Join-Path $EmbedDir "backend.exe")
Remove-Item -Recurse -Force (Join-Path $EmbedDir "backend-tmp")

Write-Host "=== Build Tauri app (frontend + Rust shell + embedded backend) ==="
npm run tauri build

Write-Host "=== Done ==="
Write-Host "Output: src-tauri/target/release/bundle/"
