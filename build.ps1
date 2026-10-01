# Build the NBG Hub release: PyInstaller folder build -> self-test -> (sign) -> installer with WebView2.
#
#   powershell -ExecutionPolicy Bypass -File build.ps1                  # full release build
#   powershell -ExecutionPolicy Bypass -File build.ps1 -NoInstaller     # app folder only (dist\NBG Hub\)
#   powershell -ExecutionPolicy Bypass -File build.ps1 -Sign            # also Authenticode-sign (needs a cert + signtool)
#   powershell -ExecutionPolicy Bypass -File build.ps1 -SkipTests       # emergencies only
#
# Output: release\NBG-Hub-Setup-<version>.exe  +  release\NBG-Hub-Setup-<version>.sha256
# Process, prerequisites, rollback: docs\BUILD_AND_DEPLOY.md
#
# Notes
#   * Keep this file ASCII only (Windows PowerShell 5.1 mangles other characters).
#   * Builds run in .venv-build with the pinned versions in requirements.lock.txt (reproducible).
#   * config.json is NOT built from git: the one on THIS machine is scrubbed of secrets and shipped.

param(
    [string]$Python = "",
    [switch]$SkipTests,
    [switch]$NoInstaller,
    [switch]$Sign
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Step($text) { Write-Host ""; Write-Host "== $text" -ForegroundColor Cyan }

# Run a native command; PyInstaller/pip write progress to stderr, so judge success by exit code only.
function Run([string]$exe, [string[]]$arguments) {
    $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    & $exe @arguments
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    if ($code -ne 0) { throw "$exe failed (exit $code): $($arguments -join ' ')" }
}

# ---- 1. Python 3.12 -------------------------------------------------------------------------
Step "Find Python 3.12"
$basePy = $Python
if (-not $basePy) { $basePy = $env:NBG_PYTHON }
if (-not $basePy) {
    try { $basePy = (& py -3.12 -c "import sys; print(sys.executable)").Trim() } catch { $basePy = "" }
}
if (-not $basePy -or -not (Test-Path $basePy)) {
    throw "Python 3.12 not found. Install it, pass -Python <path>, or set NBG_PYTHON."
}
Write-Host "Using $basePy"

# ---- 2. clean, pinned build environment -----------------------------------------------------
Step "Build environment (.venv-build, pinned)"
$venvPy = Join-Path $PSScriptRoot ".venv-build\Scripts\python.exe"
if (-not (Test-Path $venvPy)) { Run $basePy @("-m", "venv", ".venv-build") }
Run $venvPy @("-m", "pip", "install", "--quiet", "--disable-pip-version-check", "-r", "requirements.lock.txt")
$py = $venvPy

# ---- 3. gates: versions, tests, shipped config ----------------------------------------------
Step "Version files agree"
Run $py @("tools\bump_version.py", "--check")
$version = (& $py -c "import version; print(version.APP_VERSION)").Trim()
Write-Host "Version $version"

if (-not $SkipTests) {
    Step "Offline tests"
    Run $py @("-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py")
}

Step "Shipped config (scrub + secret scan)"
New-Item -ItemType Directory -Force -Path build | Out-Null
Run $py @("tools\check_release.py", "config.json", "--write", "build\config.release.json")

# ---- 4. PyInstaller (folder build: faster start, fewer antivirus false positives) ------------
Step "PyInstaller"
$hidden = @()
foreach ($m in (& $py -c "import selftest; print(' '.join(selftest.MODULES))").Trim().Split(" ")) {
    $hidden += @("--hidden-import", $m)
}
if (Test-Path "dist\NBG Hub") { Remove-Item -Recurse -Force "dist\NBG Hub" }
if (Test-Path "build\NBG Hub") { Remove-Item -Recurse -Force "build\NBG Hub" }
$pyi = @("-m", "PyInstaller", "--noconfirm", "--onedir", "--windowed", "--noupx", "--name", "NBG Hub",
         "--version-file", "version.txt", "--add-data", "web;web",
         "--collect-all", "pythonnet", "--collect-all", "clr_loader") + $hidden + @("app.py")
Run $py $pyi
$appDir = "dist\NBG Hub"
$exe = Join-Path $appDir "NBG Hub.exe"
if (-not (Test-Path $exe)) { throw "PyInstaller did not produce $exe" }
Copy-Item -Force "build\config.release.json" (Join-Path $appDir "config.json")

# ---- 5. self-test the REAL exe (catches missing modules/assets before they reach a tech) -----
Step "Self-test of the built exe"
$result = Join-Path $PSScriptRoot "build\selftest.txt"
if (Test-Path $result) { Remove-Item -Force $result }
$p = Start-Process -FilePath $exe -ArgumentList @("--selftest", "`"$result`"") -Wait -PassThru
if (Test-Path $result) { Get-Content $result }
if ($p.ExitCode -ne 0) { throw "Self-test FAILED (exit $($p.ExitCode)). Fix the FAIL lines above; do not ship this build." }
Write-Host "Self-test passed." -ForegroundColor Green

# ---- 6. signing (optional until Nucor has a certificate) ------------------------------------
function Find-SignTool {
    $c = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    $kits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
    if (Test-Path $kits) {
        $f = Get-ChildItem $kits -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
             Where-Object { $_.FullName -like "*\x64\*" } | Sort-Object FullName -Descending | Select-Object -First 1
        if ($f) { return $f.FullName }
    }
    return $null
}
function Sign-File([string]$file) {
    $st = Find-SignTool
    if (-not $st) { throw "signtool.exe not found (install the Windows SDK)." }
    Run $st @("sign", "/fd", "SHA256", "/tr", "http://timestamp.digicert.com", "/td", "SHA256", "/a", $file)
}
if ($Sign) { Step "Sign app"; Sign-File $exe }
else { Write-Warning "UNSIGNED build: expect SmartScreen / Defender warnings until a code-signing certificate is used (-Sign)." }

if ($NoInstaller) {
    Write-Host ""
    Write-Host "Done (no installer): $appDir" -ForegroundColor Green
    return
}

# ---- 7. installer with the offline WebView2 runtime -----------------------------------------
Step "WebView2 offline runtime"
$assets = Join-Path $PSScriptRoot "installer\assets"
New-Item -ItemType Directory -Force -Path $assets | Out-Null
$wv2 = Join-Path $assets "MicrosoftEdgeWebView2RuntimeInstallerX64.exe"
if (-not (Test-Path $wv2)) {
    Write-Host "Downloading the Evergreen Standalone Installer from Microsoft (about 170 MB, one time) ..."
    Invoke-WebRequest -Uri "https://go.microsoft.com/fwlink/p/?LinkId=2124701" -OutFile $wv2 -UseBasicParsing
}
$sig = Get-AuthenticodeSignature $wv2
if ($sig.Status -ne "Valid" -or $sig.SignerCertificate.Subject -notlike "*Microsoft Corporation*") {
    Remove-Item -Force $wv2
    throw "WebView2 installer failed signature check ($($sig.Status)). Deleted; re-run to download again."
}
Write-Host "WebView2 installer signature OK."

Step "Inno Setup installer"
$iscc = $null
foreach ($c in @((Get-Command ISCC.exe -ErrorAction SilentlyContinue | ForEach-Object { $_.Source }),
                 (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
                 (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe"),
                 (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe"))) {
    if ($c -and (Test-Path $c)) { $iscc = $c; break }
}
if (-not $iscc) { throw "Inno Setup 6 not found. Install it:  winget install JRSoftware.InnoSetup   (then re-run)." }
New-Item -ItemType Directory -Force -Path release | Out-Null
$env:NBG_VERSION = $version
Run $iscc @("/Qp", "installer\NBG-Hub.iss")
$setup = "release\NBG-Hub-Setup-$version.exe"
if (-not (Test-Path $setup)) { throw "Inno Setup did not produce $setup" }
if ($Sign) { Step "Sign installer"; Sign-File $setup }

$hash = (Get-FileHash -Algorithm SHA256 $setup).Hash.ToLower()
"$hash  NBG-Hub-Setup-$version.exe" | Out-File -Encoding ascii "release\NBG-Hub-Setup-$version.sha256"

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  Installer : $setup"
Write-Host "  SHA256    : $hash"
Write-Host "  Next      : docs\BUILD_AND_DEPLOY.md  (smoke test on a clean PC, hand out, then set 'Latest released version' in Settings)"
