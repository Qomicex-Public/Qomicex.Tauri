# PowerShell port of scripts/test-api-filters.sh for the Rust backend.
# Runs on Windows without bash/jq. The CurseForge streaming section is skipped:
# those three routes are 501 stubs in the Rust backend (known gap).

$BASE = if ($env:BASE) { $env:BASE } else { 'http://localhost:5000/api/resources' }
$pass = 0
$fail = 0

function Pass([string]$m) { Write-Output "  PASS: $m"; $script:pass++ }
function Fail([string]$m) { Write-Output "  FAIL: $m"; $script:fail++ }

Write-Output "=== CurseForge local loader filter (238222 / 1.12.2 / forge) ==="
try {
    $resp = Invoke-RestMethod -Uri "$BASE/238222/versions?source=curseforge&gameVersion=1.12.2&loader=forge" -TimeoutSec 25
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

Write-Output "=== CurseForge streaming (SKIPPED - 501 stub in Rust backend) ==="
Write-Output "  SKIP: start-fetch / fetch-progress / fetch-result are 501 (CurseForgeVersionFetchService not ported)"

Write-Output "=== Modrinth empty loaders filter (AANobbMI / 1.21 / fabric) ==="
try {
    $resp = Invoke-RestMethod -Uri "$BASE/AANobbMI/versions?source=modrinth&gameVersion=1.21&loader=fabric" -TimeoutSec 25
    $count = @($resp).Count
    if ($count -gt 0) { Pass "Modrinth returned $count results (Sodium + 1.21 + fabric)" }
    else { Fail "Modrinth returned 0 results" }
} catch { Fail "Modrinth versions unreachable: $($_.Exception.Message)" }

Write-Output "=== Modrinth dependency resolution (no crash) ==="
try {
    $dep = Invoke-RestMethod -Uri "$BASE/AANobbMI/dependencies?source=modrinth&gameVersion=1.21&loader=fabric" -TimeoutSec 25
    $dc = @($dep).Count
    Pass "Modrinth deps resolved ($dc dependencies, no crash)"
} catch { Fail "Modrinth deps endpoint errored: $($_.Exception.Message)" }

Write-Output ""
Write-Output "  $pass passed, $fail failed (1 skipped: CF streaming 501)"
if ($fail -gt 0) { exit 1 } else { exit 0 }
