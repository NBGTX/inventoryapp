# Manual setup of the central lists

Site: `https://nucor.sharepoint.com/sites/bg.ter.O365.TERALIT` (you need Owner / Manage Lists).

Same result as `tools\Setup-CentralLists.ps1`, done in the browser.

## Rules that matter

- **Column display names must match exactly** (spelling, spaces, capitals). The app finds columns by display name, not internal name, so you do not need to match internal names.
- `Title` already exists on every list. Leave it; the app uses it as shown below.
- Make every column **Single line of text** unless the table says otherwise. Dates stay text on purpose.
- Where it says **Index**, open List settings > Indexed columns > Create a new index and pick the column. Do this after the columns exist.
- Tip: **New > List > From Excel** can create all columns in one step. Upload a workbook with a table whose header row is the column names (the list below, left to right). SharePoint makes each one a text column; then fix the types marked below.

## 1. `Inventory - Divisions`

`Title` holds the division id (for example `nbgw`).

| Column | Type |
|---|---|
| Display Name | Single line |
| Company Name | Single line |
| Intune Category | Single line |
| SharePoint Host | Single line |
| Site Path | Single line |
| AD Domain | Single line |
| SQL Server | Single line |
| Sites JSON | Multiple lines, plain text |
| Access JSON | Multiple lines, plain text |
| Enabled | Yes/No (default Yes) |

First row to add (NBGW): Title `nbgw`, Display Name `NBGW - Nucor Buildings Group West`, Company Name `Nucor Buildings Group West`, Intune Category `NBGW`, SharePoint Host `nucor.sharepoint.com`, Site Path `/sites/NBGW/systems`, AD Domain `bg.nucorsteel.local`, SQL Server `BGBRISQL07`, Access JSON `[]`, Enabled Yes.

Sites JSON for NBGW:

```json
[{"code":"LTR","name":"Lathrop, CA","city_prefixes":["lathrop"],"device_prefixes":["BGLTR","BGCCN","BGMOD"]},{"code":"BRI","name":"Brigham City, UT","city_prefixes":["brigham"],"device_prefixes":["BGBRI"]}]
```

## 2. `Inventory - New Stock`  (Title = serial number)

Division (**Index**), Manufacturer, Model, Site Tag, CPU, Memory (RAM), Storage, Warranty Expiration, Status, Date Added

## 3. `Inventory - In Use`  (Title = serial number)

Division (**Index**), Device Name, Manufacturer, Model, Site Tag, Primary User, CPU, Memory (RAM), Storage, OS Version, OS Install Date, Last Sign In, Warranty Expiration, MFA

## 4. `Inventory - Model Specs`  (Title = model name)

CPU, Memory (RAM)

No Division column: model specs are shared by all divisions.

## 5. `Inventory - Activity Log`

Division (**Index**), Action, Serial, Model, Actor, Details (Multiple lines, plain text), LoggedAt

## 6. `Inventory - Hub Items`  (Title = `division:kind:id`)

Division (**Index**), Kind (**Index**), Item Id, Payload (Multiple lines, plain text), Rev (Number)

## 7. `Inventory - Hub Files`  (document library: New > Document library)

Division (**Index**), Kind, Item Id

## Check when done

- Seven items on the site: six lists and one library, with the exact names above (the app finds lists by display name; if you pick a different prefix, tell me and I will put it in config).
- Column names have no typos. A wrong name does not fail loudly; the app silently skips a column it cannot find.
- Division and Kind are indexed where marked.
- Everyone who will use the app has Contribute on the site.
