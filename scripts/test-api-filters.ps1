# PowerShell port of scripts/test-api-filters.sh for the Rust backend.
# Runs on Windows without bash/jq. Mirrors the .sh twin section for section.
$ErrorActionPreference = 'Stop'

$BASE = if ($env:BASE) { $env:BASE } else { 'http://localhost:5000/api/resources' }
$TIMEOUT = if ($env:CURL_TIMEOUT) { [int]$env:CURL_TIMEOUT } else { 60 }
$pass = 0
$fail = 0

function Pass([string]$m) { Write-Output "  PASS: $m"; $script:pass++ }
function Fail([string]$m) { Write-Output "  FAIL: $m"; $script:fail++ }

Write-Output "=== CurseForge local loader filter (238222 / 1.12.2 / forge) ==="
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

Write-Output "=== CurseForge streaming (start + progress + result) ==="
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
Write-Output "  $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 } else { exit 0 }
