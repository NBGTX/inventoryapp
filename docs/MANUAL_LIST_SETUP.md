# Create the central lists by hand (step by step)

Site: **NBG Hub Data** (https://nucor.sharepoint.com/sites/NBGTX.nbghubdata)
You need: site Owner. File needed: `docs\CentralLists_Import.xlsx` (in this repo).

You will make 7 lists from the Excel file and 1 document library by hand. Plan about 30 minutes.

## Step 1. Go to Site contents

1. Open the **NBG Hub Data** site.
2. Click the **gear icon** in the black bar at the top right (next to the question mark).
3. Click **Site contents**.

Shortcut: add `/_layouts/15/viewlsts.aspx` to the end of the site address.

## Step 2. Make a list from the Excel file (repeat 7 times)

Do these one at a time, in this order. The list name must be typed exactly as shown.

| Excel table to pick | Type this list name |
|---|---|
| T_Divisions | `Inventory - Divisions` |
| T_NewStock | `Inventory - New Stock` |
| T_InUse | `Inventory - In Use` |
| T_ModelSpecs | `Inventory - Model Specs` |
| T_ActivityLog | `Inventory - Activity Log` |
| T_HubItems | `Inventory - Hub Items` |
| T_MasterSettings | `Inventory - Master Settings` |

For each one:
1. On **Site contents**, click **+ New** > **List**.
2. Click **From Excel**.
3. Click **Upload file** and choose `CentralLists_Import.xlsx`.
4. Pick the table from the first column of the table above, then click **Next**.
5. Leave the column types alone. Type the **list name** from the table. Click **Create**.
6. When the list opens, **delete the example row** (its Title starts with `EXAMPLE-DELETE`): tick the row, click **Delete**.
   - Do **not** delete anything in `Inventory - Divisions`: its one row is the real NBGW entry.

## Step 3. Change 4 columns to "Multiple lines of text"

The import makes every column single-line text. These must hold long text:

| List | Columns to change |
|---|---|
| Inventory - Divisions | Sites JSON, Access JSON |
| Inventory - Activity Log | Details |
| Inventory - Hub Items | Payload |
| Inventory - Master Settings | Value |

For each list:
1. Open the list. Click the **gear icon** > **List settings**.
2. Under **Columns**, click the column name (for example `Sites JSON`).
3. Under **Column type**, choose **Multiple lines of text**.
4. Under **Specify the type of text to allow**, choose **Plain text**.
5. Click **OK**.

Leave `Enabled` (Divisions) and `Rev` (Hub Items) as text. Do not change any other column.

## Step 3b. Check the column types (important)

SharePoint's "From Excel" import GUESSES column types. It turned `OS Install Date`, `Last Sign In` (In Use) and
`LoggedAt` (Activity Log) into Number columns, which makes every sync write fail with `400 badArgument`.
Run the checker (read-only) and fix whatever it lists:

```powershell
python tools\check_central.py
```

Each fix: open the list > gear icon > **List settings** > click the column name > **Column type** = **Single line of text** > OK.
An empty list loses nothing; a list with data keeps it (numbers convert to text).

## Step 4. Index the Division columns

Do this on: New Stock, In Use, Activity Log, Hub Items (also index **Kind** on Hub Items).
1. Open the list. Click the **gear icon** > **List settings**.
2. Click **Indexed columns** (under Columns).
3. Click **Create a new index**.
4. Choose **Division** (or **Kind**), click **Create**.

## Step 5. Make the document library

1. **Site contents** > **+ New** > **Document library** > **Blank library**.
2. Name: `Inventory - Hub Files`. Click **Create**.
3. In the library, click **+ Add column** > **Text** > Next. Name it `Division`, click **Save**.
4. Repeat for `Kind` and `Item Id`.
5. Index **Division**: gear icon > **Library settings** > **Indexed columns** > **Create a new index**.

## Step 5b. Lock down Master Settings (important)

Only Owners may change it; everyone else may only read it.
1. Open `Inventory - Master Settings`. Click the **gear icon** > **List settings**.
2. Click **Permissions for this list**.
3. Click **Stop Inheriting Permissions**, then **OK**.
4. Tick the **Members** group (and any other non-owner group) > **Edit User Permissions** > untick Edit/Contribute, tick **Read** > **OK**.
5. Leave **Owners** with Full Control. Make sure the group of app users (for example "NBG Hub Users") has **Read**.

Settings stored here (Title = key): `lenovo_client_id` (Secret = Yes) and `super_admins` (comma-separated emails). The app does not need them yet; add them when the app update ships.

## Step 6. Check

- Site contents shows 7 lists plus the library, named exactly as above.
- `Inventory - Divisions` has one row (`nbgw`).
- The other lists are empty (example rows deleted).
- Column names are spelled exactly like the Excel headers (the app silently ignores a column it cannot find).
- Everyone who will use the app has **Contribute** on the site (gear icon > Site permissions).

Then tell Claude it is done. Next step is the app change that reads these lists.
