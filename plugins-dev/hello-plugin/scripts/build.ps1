# 打包插件为 .qplugin（zip，manifest.json 在根）。
# 用法: pwsh ./scripts/build.ps1 [版本]
param([string]$Version = "0.1.0")

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Push-Location $Root

$PluginId = "hello-plugin"
$OutDir = Join-Path $Root "release"

Write-Host "==> 构建前端 (tsc + vite)"
if (Get-Command pnpm -ErrorAction SilentlyContinue) {
  pnpm build
} else {
  npm run build
}
if ($LASTEXITCODE -ne 0) { throw "build failed" }

Write-Host "==> 整理 dist"
Copy-Item "$Root/overlay.html" "$Root/dist/overlay.html" -Force
Copy-Item "$Root/theme.css" "$Root/dist/theme.css" -Force

Write-Host "==> 组装 .qplugin"
$Staging = Join-Path $Root ".staging-$PluginId"
$StagingDist = Join-Path $Staging "dist"
if (Test-Path $Staging) { Remove-Item $Staging -Recurse -Force }
if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
New-Item -ItemType Directory -Path $Staging, $StagingDist, $OutDir | Out-Null

# manifest 引用 dist/ 下相对路径，故保留 dist/ 子目录结构
Copy-Item "$Root/dist/index.html" $StagingDist
Copy-Item "$Root/dist/assets" $StagingDist -Recurse
Copy-Item "$Root/dist/overlay.html" $StagingDist
Copy-Item "$Root/dist/theme.css" $StagingDist
Copy-Item "$Root/manifest.json" $Staging

# 替换 manifest 中的版本号
$Manifest = Join-Path $Staging "manifest.json"
$Json = Get-Content $Manifest -Raw | ConvertFrom-Json
$Json.version = $Version
$Json | ConvertTo-Json -Depth 10 | Set-Content $Manifest -Encoding UTF8

$Out = Join-Path $OutDir "${PluginId}-${Version}.qplugin"
Compress-Archive -Path (Join-Path $Staging '*') -DestinationPath $Out -Force
Remove-Item $Staging -Recurse -Force
Pop-Location

Write-Host "==> 完成: $Out"
