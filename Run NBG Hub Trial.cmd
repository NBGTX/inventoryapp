@echo off
set "LOCALAPPDATA=%TEMP%\NBGHubTrial-LiveAuth"
set "NBG_HUB_TRIAL_MODE=1"
set "NBG_HUB_TRIAL_SUPER_ADMIN_DENY_UPN="
if not exist "%LOCALAPPDATA%\NBG Hub" mkdir "%LOCALAPPDATA%\NBG Hub"
>"%LOCALAPPDATA%\NBG Hub\data_mode.txt" echo live
start "" "%~dp0trial-dist-smtp\NBG Hub.exe"
