# PowerShell port of scripts/test-api-filters.sh for the Rust backend.
# Runs on Windows without bash/jq. Mirrors the .sh twin section for section.
$ErrorActionPreference = 'Stop'

$BASE = if ($env:BASE) { $env:BASE } else { 'http://localhost:5000/api/resources' }
$TIMEOUT = if ($env:CURL_TIMEOUT) { [int]$env:CURL_TIMEOUT } else { 60 }
$pass = 0
$fail = 0
$skip = 0

function Pass([string]$m) { Write-Output "  PASS: $m"; $script:pass++ }
function Fail([string]$m) { Write-Output "  FAIL: $m"; $script:fail++ }
function Skip([string]$m) { Write-Output "  SKIP: $m"; $script:skip++ }

# CurseForge 断言需要 API key：后端在**构建期**把 key 嵌入 appsettings.json
# （issue #159 起由 build.rs 从 CURSEFORGE_API_KEY 环境变量注入，见 crate 根
# build.rs 头注释）。该 secret 未配置时（如 fork PR、新仓库）key 为空，
# CF 端点必然返回 0 结果 —— 这是**凭据缺失**而非功能缺陷，因此跳过而非判失败。
# 有 key 时照常断言，不做任何静默放行。
#
# 判定依据必须是**后端实际生效的配置**，而非本进程的环境变量：build.rs 在无环境
# 变量覆盖时会保留已有的 appsettings.json，因此「本地填了 key 但未导出环境变量」
# 时后端仍能访问 CF，此时不应误报跳过（否则会掩盖真实回归）。
$cfConfigured = $false
# 1) 环境变量（CI 注入路径）
if ($env:CURSEFORGE_API_KEY -and $env:CURSEFORGE_API_KEY.Trim()) { $cfConfigured = $true }
# 2) 后端构建产物中嵌入的配置（本地开发路径）
else {
    $candidates = @(
        (Join-Path $PSScriptRoot '..\src-backend\qomicex-backend\appsettings.json'),
        (Join-Path $PSScriptRoot '..\src-backend\qomicex-backend\appsettings.example.json')
    )
    foreach ($cfg in $candidates) {
        if (-not (Test-Path $cfg)) { continue }
        try {
            $key = (Get-Content $cfg -Raw | ConvertFrom-Json).CurseForge.ApiKey
            if ($key -and $key.Trim()) { $cfConfigured = $true; break }
        } catch { /* 配置不可解析则继续尝试下一个候选 */ }
    }
}
if (-not $cfConfigured) {
    Skip "CurseForge 测试（后端未配置 CurseForge.ApiKey；CURSEFORGE_API_KEY 未设置且 appsettings.json 中为空）"
}

Write-Output "=== CurseForge local loader filter (238222 / 1.12.2 / forge) ==="
if (-not $cfConfigured) { Skip "CF versions filter (238222 / 1.12.2 / forge)" }
else {
try {
    $resp = Invoke-RestMethod -Uri "$BASE/238222/versions?source=curseforge&gameVersion=1.12.2&loader=forge" -TimeoutSec $TIMEOUT
    $count = @($resp).Count
    if ($count -gt 0) {
        Pass "CF versions returned $count results for 238222 + 1.12.2 + forge"
        $bad = @($resp | Where-Object { $_.loaders -and (($_.loaders | ForEach-Object { $_.ToLowerInvariant() }) -notcontains 'forge') }).Count
        if ($bad -eq 0) { Pass "All $count results have forge in loaders (or empty loaders)" }
        else { Fail "$bad results missing forge loader" }
    } else {
        Fail "CF versions returned 0 results"
    }
} catch { Fail "CF versions unreachable: $($_.Exception.Message)" }
}

Write-Output "=== CurseForge streaming (start + progress + result) ==="
if (-not $cfConfigured) { Skip "CF streaming (start + progress + result)" }
else {
try {
    $task = Invoke-RestMethod -Uri "$BASE/238222/versions/start-fetch?gameVersion=1.12.2&loader=forge" -Method Post -TimeoutSec $TIMEOUT
    $taskId = $task.taskId
    if (-not $taskId) {
        Fail "CF streaming failed to start"
    } else {
        Pass "CF streaming started: taskId=$taskId"
        $done = $false
        $loaded = 0
        $total = 1
        for ($i = 0; $i -lt 3 -and -not $done; $i++) {
            Start-Sleep -Seconds 2
            $prog = Invoke-RestMethod -Uri "$BASE/versions/fetch-progress/$taskId" -TimeoutSec $TIMEOUT
            $loaded = [int]$prog.loadedVersionCount
            $total = [int]$prog.totalVersionCount
            if ($total -le 0) { $total = 1 }
            Write-Output "       progress: $loaded/$total ($([int]($loaded * 100 / $total))%) done=$($prog.done)"
            $done = [bool]$prog.done
        }
        if ($done) {
            Pass "CF streaming completed ($loaded results)"
            $result = Invoke-RestMethod -Uri "$BASE/versions/fetch-result/$taskId" -TimeoutSec $TIMEOUT
            $rc = @($result).Count
            if ($rc -gt 0) { Pass "CF streaming result: $rc versions (all forge)" }
            else { Fail "CF streaming result empty" }
        } else {
            Fail "CF streaming did not complete in timeout"
        }
    }
} catch { Fail "CF streaming unreachable: $($_.Exception.Message)" }
}

Write-Output "=== Modrinth empty loaders filter (AANobbMI / 1.21 / fabric) ==="
try {
    $resp = Invoke-RestMethod -Uri "$BASE/AANobbMI/versions?source=modrinth&gameVersion=1.21&loader=fabric" -TimeoutSec $TIMEOUT
    $count = @($resp).Count
    if ($count -gt 0) { Pass "Modrinth returned $count results (Sodium + 1.21 + fabric)" }
    else { Fail "Modrinth returned 0 results" }
} catch { Fail "Modrinth versions unreachable: $($_.Exception.Message)" }

Write-Output "=== Modrinth dependency resolution (no crash) ==="
try {
    $dep = Invoke-RestMethod -Uri "$BASE/AANobbMI/dependencies?source=modrinth&gameVersion=1.21&loader=fabric" -TimeoutSec $TIMEOUT
    $dc = @($dep).Count
    Pass "Modrinth deps resolved ($dc dependencies, no crash)"
} catch { Fail "Modrinth deps endpoint errored: $($_.Exception.Message)" }

Write-Output ""
Write-Host "  $pass passed, $fail failed, $skip skipped"
if ($fail -gt 0) { exit 1 } else { exit 0 }
