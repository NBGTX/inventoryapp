# Build NBG Hub with PyInstaller.
#
#   powershell -ExecutionPolicy Bypass -File build.ps1            # build to dist\ (default)
#   powershell -ExecutionPolicy Bypass -File build.ps1 -OneDir   # folder build (best vs. AV false positives)
#   powershell -ExecutionPolicy Bypass -File build.ps1 -Deploy   # also copy to C:\Program Files\NBG (needs admin)
#
# Output (default):  dist\NBG Hub.exe  (+ config.json beside it) — share the dist\ folder.
#
# Defender flags many PyInstaller exes as Trojan:Win32/*!ml (an ML false positive,
# not a real detection). Hardening baked in:
#   * --version-file  stamps real Nucor/product metadata onto the exe
#   * --noupx         never UPX-pack (packers are a major AV red flag)
#   * -OneDir         optional folder build; onefile self-extracts to temp, which the
#                     ML model most often flags. Durable fix = code signing + a Defender
#                     allow-by-certificate indicator (see the Deployment guide docx).
#
# The exe writes its sign-in token cache to %LOCALAPPDATA%\NBG Hub (not next to the
# exe), so each user's tokens stay local and it also runs from a read-only install.
#
# Prereqs (already on Blake's machine): pywebview, pythonnet, clr_loader, cffi,
# msal, requests, truststore, pyinstaller. config.json is NOT bundled; it lives
# next to the exe so each site can edit settings without a rebuild.

param(
    [switch]$OneDir,
    [switch]$Deploy,
    [switch]$SkipTests,
    [string]$Python = ""
)

$ErrorActionPreference = "Stop"

# ---- find Python 3.12: -Python arg, then $env:NBG_PYTHON, then the py launcher, then the old path ----
$py = $Python
if (-not $py) { $py = $env:NBG_PYTHON }
if (-not $py) {
    try { $py = (& py -3.12 -c "import sys;print(sys.executable)").Trim() } catch { $py = "" }
}
if (-not $py -or -not (Test-Path $py)) {
    $legacy = "C:\Users\Blake.Stevenson\AppData\Local\Programs\Python\Python312\python.exe"
    if (Test-Path $legacy) { $py = $legacy }
}
if (-not $py -or -not (Test-Path $py)) {
    throw "Python 3.12 not found. Install it, or pass -Python <path-to-python.exe>, or set NBG_PYTHON."
}
Write-Host "Using Python: $py"

# ---- version files must agree (CLAUDE.md Rule 3) ----
& $py tools\bump_version.py --check
if ($LASTEXITCODE -ne 0) { throw "Version files disagree. Run: python tools\bump_version.py" }

# ---- offline tests must pass ----
if (-not $SkipTests) {
    & $py -m unittest discover -s tests -p "test_*.py"
    if ($LASTEXITCODE -ne 0) { throw "Tests failed. Fix them, or pass -SkipTests to build anyway." }
}

$mode = if ($OneDir) { "--onedir" } else { "--onefile" }
Write-Host "Building NBG Hub.exe ($mode, with version metadata, no UPX) ..."

& $py -m PyInstaller --noconfirm $mode --windowed --noupx --name "NBG Hub" `
    --version-file version.txt `
    --add-data "web;web" `
    --collect-all pythonnet --collect-all clr_loader `
    --hidden-import clr --hidden-import truststore --hidden-import cffi --hidden-import hub --hidden-import divisions --hidden-import hubstore --hidden-import securecache --hidden-import schema --hidden-import settings_catalog--hidden-import paths --hidden-import localstore --hidden-import adlookup --hidden-import sqltools --hidden-import version `
    app.py

$target = if ($OneDir) { "dist\NBG Hub" } else { "dist" }
Copy-Item -Force config.json (Join-Path $target "config.json")
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $target ".token_cache.bin")

Write-Host ""
Write-Host "Done -> $target\NBG Hub.exe (config.json beside it)."
Write-Host "Share the whole dist\ folder (exe + config.json)."

if ($Deploy) {
    $Install = "C:\Program Files\NBG"
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
             ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $admin) {
        Write-Warning "-Deploy needs an elevated (Administrator) PowerShell. Skipped; build is in $target."
        return
    }
    New-Item -ItemType Directory -Force -Path $Install | Out-Null
    if ($OneDir) { Copy-Item "$target\*" $Install -Recurse -Force }
    else { Copy-Item "dist\NBG Hub.exe" $Install -Force; Copy-Item "config.json" $Install -Force }
    Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Install ".token_cache.bin")
    Write-Host "Deployed -> $Install"
}
