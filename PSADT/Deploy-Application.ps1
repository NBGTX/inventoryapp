<#
.SYNOPSIS
    Installs, updates, or uninstalls NBG Hub using PSAppDeployToolkit 3.9.3.

.DESCRIPTION
    Run in the signed-in user's context. NBG Hub is a per-user application.
    The package's Files folder must contain exactly one NBG-Hub-Setup-<version>.exe.
    Existing Nucor-published NBG Hub versions are removed before installing the package.
    User data under %LOCALAPPDATA%\NBG Hub is preserved by the NBG Hub uninstaller.
#>

[CmdletBinding()]
Param (
    [Parameter(Mandatory = $false)]
    [ValidateSet('Install', 'Uninstall', 'Repair')]
    [String]$DeploymentType = 'Install',
    [Parameter(Mandatory = $false)]
    [ValidateSet('Interactive', 'Silent', 'NonInteractive')]
    [String]$DeployMode = 'Silent',
    [Parameter(Mandatory = $false)]
    [switch]$AllowRebootPassThru = $false,
    [Parameter(Mandatory = $false)]
    [switch]$TerminalServerMode = $false,
    [Parameter(Mandatory = $false)]
    [switch]$DisableLogging = $false
)

Try {
    Try {
        Set-ExecutionPolicy -ExecutionPolicy 'ByPass' -Scope 'Process' -Force -ErrorAction 'Stop'
    }
    Catch { }

    [String]$appVendor = 'Nucor'
    [String]$appName = 'NBG Hub'
    [String]$appScriptVersion = '1.0.3'
    [String]$appScriptDate = '10/20/2026'
    [String]$appScriptAuthor = 'Nucor'
    [String]$installTitle = 'NBG Hub'
    [Int32]$mainExitCode = 0
    [String]$deployAppScriptFriendlyName = 'Deploy NBG Hub'
    [Version]$deployAppScriptVersion = [Version]'3.9.3'
    [String]$deployAppScriptDate = '02/05/2023'
    [Hashtable]$deployAppScriptParameters = $PsBoundParameters

    If (Test-Path -LiteralPath 'variable:HostInvocation') {
        $InvocationInfo = $HostInvocation
    }
    Else {
        $InvocationInfo = $MyInvocation
    }
    [String]$scriptDirectory = Split-Path -Path $InvocationInfo.MyCommand.Definition -Parent
    [String]$moduleAppDeployToolkitMain = Join-Path $scriptDirectory 'AppDeployToolkit\AppDeployToolkitMain.ps1'

    If (-not (Test-Path -LiteralPath $moduleAppDeployToolkitMain -PathType 'Leaf')) {
        Throw "PSAppDeployToolkit is missing: [$moduleAppDeployToolkitMain]."
    }
    If ($DisableLogging) {
        . $moduleAppDeployToolkitMain -DisableLogging
    }
    Else {
        . $moduleAppDeployToolkitMain
    }

    [String]$installerPattern = '^NBG-Hub-Setup-(\d{4}\.\d{2}\.\d{2}(?:\.\d+)?)\.exe$'
    [IO.FileInfo[]]$packageInstallers = @(Get-ChildItem -LiteralPath $dirFiles -File | Where-Object { $_.Name -match $installerPattern })
    If ($packageInstallers.Count -ne 1) {
        Throw "Expected exactly one NBG-Hub-Setup-<version>.exe under [$dirFiles]; found [$($packageInstallers.Count)]."
    }
    [String]$installerFile = $packageInstallers[0].Name
    [String]$installerPath = Join-Path $dirFiles $installerFile
    [Version]$appVersion = [Version]([regex]::Match($installerFile, $installerPattern).Groups[1].Value)

    If ($env:USERNAME -eq 'SYSTEM') {
        Throw 'NBG Hub installs per user. Configure this PSADT package to run in the signed-in user context, not SYSTEM.'
    }

    Function Uninstall-NbgHub {
        [PSObject[]]$installedApps = @(Get-InstalledApplication -Name $appName -Exact | Where-Object {
            $_.DisplayName -eq $appName -and $_.Publisher -eq $appVendor
        })

        ForEach ($installedApp in $installedApps) {
            [String]$uninstallString = [String]$installedApp.UninstallString
            [regex]$uninstallExeRegex = [regex]'^\s*"?([^"].*?\.exe)"?(?:\s|$)'
            $uninstallMatch = $uninstallExeRegex.Match($uninstallString)
            If (-not $uninstallMatch.Success) {
                Throw "Cannot safely determine uninstall executable for [$($installedApp.DisplayName)] version [$($installedApp.DisplayVersion)]."
            }

            [String]$uninstallerPath = $uninstallMatch.Groups[1].Value.Trim('"')
            If (-not (Test-Path -LiteralPath $uninstallerPath -PathType 'Leaf')) {
                Throw "Uninstaller is missing for [$($installedApp.DisplayName)] version [$($installedApp.DisplayVersion)]: [$uninstallerPath]."
            }

            Write-Log -Message "Removing existing NBG Hub version [$($installedApp.DisplayVersion)] for current user."
            Execute-Process -Path $uninstallerPath -Parameters '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /NOCANCEL' -WindowStyle Hidden -IgnoreExitCodes '3010'
        }
    }

    If ($deploymentType -ieq 'Uninstall') {
        [String]$installPhase = 'Pre-Uninstallation'
        Show-InstallationWelcome -CloseApps 'NBG Hub' -Silent
        [String]$installPhase = 'Uninstallation'
        Uninstall-NbgHub
        [String]$installPhase = 'Post-Uninstallation'
    }
    Else {
        [String]$installPhase = 'Pre-Installation'
        Show-InstallationWelcome -CloseApps 'NBG Hub' -Silent
        Uninstall-NbgHub

        [String]$installPhase = 'Installation'
        Write-Log -Message "Installing NBG Hub version [$appVersion] from [$installerFile]."
        Execute-Process -Path $installerPath -Parameters '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /NOCANCEL /SP-' -WindowStyle Hidden -IgnoreExitCodes '3010'

        [String]$installPhase = 'Post-Installation'
        [String]$installedExe = Join-Path $env:LOCALAPPDATA 'Programs\NBG Hub\NBG Hub.exe'
        If (-not (Test-Path -LiteralPath $installedExe -PathType 'Leaf')) {
            Throw "Installer exited without creating the expected app: [$installedExe]."
        }
        [Version]$installedVersion = [Version](Get-Item -LiteralPath $installedExe).VersionInfo.FileVersion
        If ($installedVersion -lt $appVersion) {
            Throw "Installed version [$installedVersion] is older than package version [$appVersion]."
        }
        Write-Log -Message "Verified installed NBG Hub version [$installedVersion]."
    }

    Exit-Script -ExitCode $mainExitCode
}
Catch {
    [Int32]$mainExitCode = 60001
    [String]$mainErrorMessage = "$(Resolve-Error)"
    Write-Log -Message $mainErrorMessage -Severity 3 -Source $deployAppScriptFriendlyName
    Show-DialogBox -Text $mainErrorMessage -Icon 'Stop'
    Exit-Script -ExitCode $mainExitCode
}

