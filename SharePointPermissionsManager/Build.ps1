# Builds dist\SharePointPermissionsManager.exe (self-contained, single file) after running the tests.
# Usage:  .\Build.ps1            run tests, then publish
#         .\Build.ps1 -SkipTests
param([switch]$SkipTests)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$dist = Join-Path $root 'dist'

if (-not $SkipTests) {
    dotnet test "$root\tests\SpPerm.Tests" -nologo -v q
    if ($LASTEXITCODE -ne 0) { throw 'Tests failed. Not publishing.' }
}

# Keep a Client ID someone already typed into dist\appsettings.json.
$existing = Join-Path $dist 'appsettings.json'
$kept = if (Test-Path $existing) { Get-Content $existing -Raw -Encoding UTF8 } else { $null }

dotnet publish "$root\src\SpPerm.App" -c Release -r win-x64 --self-contained true `
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true `
    -o $dist -nologo -v q
if ($LASTEXITCODE -ne 0) { throw 'Publish failed.' }

if ($kept -and ($kept -match '"ClientId"\s*:\s*"[0-9a-fA-F-]{36}"')) {
    Set-Content $existing $kept -Encoding UTF8
    Write-Host 'Kept the Client ID already in dist\appsettings.json.'
}

Get-ChildItem $dist -Exclude '*.pdb' | Select-Object Name, @{n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } } | Format-Table -AutoSize
Write-Host "Done: $dist\SharePointPermissionsManager.exe"
