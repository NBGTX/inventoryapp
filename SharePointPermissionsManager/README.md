# SharePoint permissions manager

A Windows desktop app for site owners. It finds every folder and file on a SharePoint site that has its own
permissions, shows exactly how each differs from its parent, and lets you reset, add, or remove access in bulk,
with a preview before anything changes and an undo afterwards.

Version: see `Directory.Build.props` (date-based, bump it on every rebuild: `YYYY.MM.DD.N`).

## Try it now (no sign-in)

```powershell
dotnet run --project src\SpPerm.App -- --demo
```

or run the built exe and select **Try demo data**. Demo mode uses an in-memory sample site, so nothing real is touched.

## One-time setup for a real site

The app signs in as the person using it (Entra ID, delegated), so it can never do more than that person's own
SharePoint rights allow. It needs an Entra **app registration**:

1. Entra admin center → App registrations → the registration for this tool → **Authentication**:
   platform **Mobile and desktop applications**, redirect URI `http://localhost`, **Allow public client flows** = Yes.
2. **API permissions** → Add a permission → **SharePoint** (not Microsoft Graph) → Delegated → **`AllSites.FullControl`**.
   Then **Grant admin consent**.
3. Put the registration's Application (client) ID in `appsettings.json` next to the exe:

```json
{ "TenantId": "<tenant id>", "ClientId": "<application (client) id>", "RedirectUri": "http://localhost" }
```

No secret is needed or used. `TenantId` is already filled in for Nucor; confirm it is right for your registration.

## Using it

1. Paste the site address (any page on the site works) and select **Connect**. First time you sign in in the browser.
2. **Cleanup** tab: summary tiles, filters (safe to reset, differs from parent, direct users, external users,
   sharing links), and a list of every item with its own permissions. Click a row to see who has access and how it
   differs from the parent. Tick rows and use the bar at the bottom to queue **Reset to inherit**, **Add people**,
   or **Remove user**.
3. **Access matrix** tab: items down the side, people and groups across the top. Click a cell to pick a level.
   Outlined cells are inherited, filled cells are set on the item, amber outline means pending. **By person** lists
   where one person or group has an entry.
4. Queued work shows as **Pending changes**. **Review and apply** shows every change plus warnings, then applies.
5. **Undo last batch** puts each touched folder back the way it was. **Open change log** shows the JSON records.
6. **Export to Excel** writes a workbook (summary, unique permissions, access detail, by person).

### What "safe to reset" means
The item has its own permissions, but they match its parent's exactly (ignoring the automatic *Limited Access*
entries). Resetting changes nobody's access. Items with sharing links are never "safe": resetting removes the links.

### Safety design
- Nothing is applied until you confirm the review dialog.
- Adding or changing access on a folder that inherits first stops inheriting **and copies the existing access**,
  so nobody loses access by accident.
- Every applied batch is saved to `%LOCALAPPDATA%\SharePointPermissionsManager\changes\*.json` with the
  before-state of each folder. Undo uses that.
- One failing folder does not stop the rest of the batch; failures are listed.
- Throttling (HTTP 429/503) is retried using the server's `Retry-After`.

## Build and test

```powershell
dotnet test tests\SpPerm.Tests        # 41 tests: diff, scan, apply/undo, REST request shapes, Excel export
.\Build.ps1                           # tests, then dist\SharePointPermissionsManager.exe (self-contained, one file)
```

Build output goes to `%LOCALAPPDATA%\SpPermManager\artifacts` (set in `Directory.Build.props`) to keep it out of OneDrive.

Developer aid: `SharePointPermissionsManager.exe --snapshot <folder>` renders the demo screens to PNG and exits.

## Layout

| Path | What |
|---|---|
| `src/SpPerm.Core` | No UI. REST client, scan + diff, change plan, apply + undo, Excel export, in-memory fake + demo data |
| `src/SpPerm.App` | WPF app: sign-in (MSAL), view models, Cleanup and Access matrix views, dialogs |
| `tests/SpPerm.Tests` | xUnit tests. The REST client is tested against a stubbed `HttpMessageHandler` |

Key files: `SharePointRestClient.cs` (every SharePoint call), `ScanService.cs` (finding unique items and their
effective parent), `ChangeExecutor.cs` (apply and undo), `MainViewModel.cs` (the workflow).

## Not yet proven against a live site

This was built and tested without a live SharePoint sign-in. The tests cover the logic and the exact REST request
shapes, but these assumptions need confirming on the first real run:

- `GET .../lists(guid'..')/items?$select=Id,FileRef,FileSystemObjectType,HasUniqueRoleAssignments` returns items from
  **all** subfolders, and `HasUniqueRoleAssignments` can be selected in bulk. Very large libraries (over 5,000 items)
  may be slow or hit list-view-threshold limits.
- The people picker response shape (`ClientPeoplePickerSearchUser`) matches `SharePointRestClient.SearchPrincipalsAsync`.
- Delegated `AllSites.FullControl` is enough for break/reset inheritance and role assignment calls.
- **By person** shows direct entries only. Access through group membership (including Entra group members) is not
  expanded.
- Sub-sites are not scanned; run against each sub-site address separately.
