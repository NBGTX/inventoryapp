"""Single source of truth for the app version.

Bump APP_VERSION on every build you hand out. It's shown in the sidebar and
reported (with the user + machine) to the shared hub on launch, so you can see
which version each person is running from the "Versions in use" list.
Keep version.txt's FileVersion/ProductVersion in sync for the exe metadata.
"""
APP_VERSION = "2026.09.29"
