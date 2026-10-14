@echo off
set "APP_DIR=%~dp0SharePointPermissionsManager\dist"
if not exist "%APP_DIR%\SharePointPermissionsManager.exe" (
  echo SharePoint Permissions example was not found:
  echo "%APP_DIR%\SharePointPermissionsManager.exe"
  pause
  exit /b 1
)
start "" /D "%APP_DIR%" "%APP_DIR%\SharePointPermissionsManager.exe"
