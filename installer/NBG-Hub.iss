; Inno Setup script for NBG Hub. Built by build.ps1 (it sets NBG_VERSION and puts the offline WebView2
; runtime in installer\assets). Per-user install: no administrator rights needed.
;
; Upgrade = run the new installer over the old one (same AppId): files are replaced, the per-user data in
; %LOCALAPPDATA%\NBG Hub (sign-in cache, division choice, local snapshots, optional config override) is kept.
; Silent install for Intune/SCCM later:  NBG-Hub-Setup-<ver>.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART

#define AppName "NBG Hub"
#define AppVer GetEnv("NBG_VERSION")
#if AppVer == ""
  #error NBG_VERSION is not set - run build.ps1
#endif

[Setup]
AppId={{6F1D2C54-3B7A-4E58-9A1C-0B8E5D4F7A21}
AppName={#AppName}
AppVersion={#AppVer}
AppVerName={#AppName} {#AppVer}
AppPublisher=Nucor
DefaultDirName={localappdata}\Programs\NBG Hub
DefaultGroupName=NBG Hub
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\release
OutputBaseFilename=NBG-Hub-Setup-{#AppVer}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\NBG Hub.exe
UninstallDisplayName={#AppName}
VersionInfoVersion={#AppVer}
VersionInfoCompany=Nucor
VersionInfoDescription=NBG Hub installer
CloseApplications=yes
RestartApplications=no

[Files]
Source: "..\dist\NBG Hub\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
; Offline WebView2 runtime: unpacked to a temp folder only when this PC does not have it.
Source: "assets\MicrosoftEdgeWebView2RuntimeInstallerX64.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall; Check: NeedsWebView2

[Icons]
Name: "{autoprograms}\NBG Hub"; Filename: "{app}\NBG Hub.exe"
Name: "{autodesktop}\NBG Hub"; Filename: "{app}\NBG Hub.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Run]
Filename: "{tmp}\MicrosoftEdgeWebView2RuntimeInstallerX64.exe"; Parameters: "/silent /install"; StatusMsg: "Installing Microsoft Edge WebView2 Runtime..."; Flags: waituntilterminated; Check: NeedsWebView2
Filename: "{app}\NBG Hub.exe"; Description: "Launch NBG Hub"; Flags: nowait postinstall skipifsilent

[Code]
const
  WV2Key = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function HasWebView2(): Boolean;
var
  v: String;
begin
  Result := False;
  if RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v) then
    Result := (v <> '') and (v <> '0.0.0.0');
  if (not Result) and RegQueryStringValue(HKLM, WV2Key, 'pv', v) then
    Result := (v <> '') and (v <> '0.0.0.0');
  if (not Result) and RegQueryStringValue(HKCU, WV2Key, 'pv', v) then
    Result := (v <> '') and (v <> '0.0.0.0');
end;

function NeedsWebView2(): Boolean;
begin
  Result := not HasWebView2();
end;
