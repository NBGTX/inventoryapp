/* ---- In-app help -------------------------------------------------------------
   Every page and every Settings section has ONE collapsible "How to use" box, closed by default.
   The text lives here (DOCS) so it is easy to keep in step with the app: edit the entry, nothing else.

     Help.box("dashboard")            -> HTML for the box (use inside any template string)
     <div class="help-slot" data-help="dashboard"></div>   -> filled automatically at start-up (static pages)

   Whether a box is open is remembered per box on this PC (localStorage; harmless if blocked). */

const Help = {
  DOCS: {
    /* ------------------------------------------------------------------ Dashboard */
    dashboard: {
      title: "How to use the Dashboard",
      html: `
        <p>The Dashboard is a summary of the <b>division you have selected</b> (top of the sidebar). Almost everything on it is clickable: click a tile or bar to see the devices behind the number.</p>
        <h5>The tiles</h5>
        <ul>
          <li><b>Machines in use / in stock</b>: opens the Devices page on that tab.</li>
          <li><b>Hot spares</b>: imaged, ready-to-deploy loaners. Click for the full list by site and department. A warning sign means a spare is stale or out of compliance.</li>
          <li><b>No UPN set</b>: devices with no primary user.</li>
          <li><b>Warranties ≤ 90 days</b>: warranty ends within 90 days (or already expired).</li>
          <li><b>Upgrade Forecast</b>: devices that meet the upgrade rules (a processor older than a set number of years, and/or a warranty that ended a set number of months ago; a super admin sets these under Platform → Integrations → Upgrades). Click for the list with the reason for each; the Upgrade list page queues them.</li>
          <li><b>Missing specs</b> (appears when there are any): devices with no CPU, RAM or warranty date recorded. This happens for makers whose lookup is not available yet (Dell and HP need an API key). Click it, then <b>Edit specs</b> on a row to type the values in; they count immediately toward the upgrade rules. Virtual machines are left out.</li>
          <li><b>No check-in N+ days</b>: devices that have not reported to Intune for longer than the stale limit (30 days unless a super admin changed it).</li>
          <li><b>Users without MFA</b>: people with a device but no registered multi-factor method.</li>
          <li><b>Not part of this division</b>: devices in the division's Intune category whose user is not in the division's Entra company. Usually a mis-categorized device.</li>
        </ul>
        <h5>The cards</h5>
        <ul>
          <li><b>Warranty status</b>: click a bar to list the devices in that range.</li>
          <li><b>Upgrade Forecast by site</b>: the top of the queue. <b>Open list</b> goes to the Upgrades page.</li>
          <li><b>In stock by department</b>: spare machines grouped by who they are for. <b>Configure</b> opens Settings → Model departments, where you decide which department each model belongs to.</li>
        </ul>
        <h5>Refreshing</h5>
        <p><b>Refresh</b> re-reads everything and shows a confirmation. <b>Last sync</b> (under the title) says when this division's devices were last pulled from Intune. It turns red when that was more than 36 hours ago, never happened, or had errors. Run <b>Sync now</b> on the Devices page, or a super admin can run <b>Sync all divisions</b> in Settings.</p>`
    },
    basics: {
      title: "Getting around the app",
      html: `
        <ul>
          <li><b>Division switcher</b> (top of the sidebar): choose which division you are working in. It only appears if you can see more than one. Switching reloads the app and puts you back on the same page. It is blocked while a long job (a sync, for example) is still running.</li>
          <li><b>Data: Live / Local</b> (sidebar, <b>super admins only</b>): <b>Live</b> is real production data. <b>Local</b> is a private copy on this PC: you can test freely and nothing reaches SharePoint. Click it to switch or to pull a fresh copy.</li>
          <li><b>Spinner chip above your name</b>: a long job (sync, software pull, MFA) is still running. You can move to other pages meanwhile.</li>
          <li><b>"Saving…" pill</b> at the top: a save is in progress. Wait for it to finish before closing the app.</li>
          <li><b>Number badges</b> on a menu item: something there needs attention. On <b>Issues</b>, super admins see how many issues are still <b>New</b> (not triaged); everyone else sees how many of their own or watched issues have news since they last opened the page. The badge clears when you open the page (for super admins it clears as each New issue is triaged).</li>
          <li><b>Version</b> (bottom of the sidebar): click it to see which version each person is running. A yellow or red version means an update is available or required.</li>
          <li><b>Report bug / feature</b>: opens a short form that files an issue on the shared Issues board.</li>
          <li><b>Settings</b>: what you see there depends on your role. Everyone sees General; division admins see more; super admins also see the Platform section.</li>
        </ul>`
    },

    /* ------------------------------------------------------------------ Endpoint Provisioning */
    "hub-home": {
      title: "How to use Endpoint Provisioning",
      html: `
        <p>Endpoint Provisioning walks a technician through setting up a <b>new computer</b> or a <b>new user</b>, step by step, and keeps a record of what was done. The checklists belong to the division you are in and are shared with everyone in it.</p>
        <ol>
          <li>Click <b>New Computer Setup</b> or <b>New User Setup</b>. For a computer you pick the department next: everyone gets the base build, and your pick adds that department's steps.</li>
          <li>Fill in the name / hostname and tick off the steps as you do them.</li>
          <li>Click <b>Save to shared log</b> at any time. The setup appears in the list below with its percentage, and <b>anyone can click it to resume</b> where you stopped.</li>
        </ol>
        <p><b>In progress &amp; recent setups</b> lists saved setups, newest first. Click one to open or resume it. <b>Recent program changes</b> is a history of who edited the checklists and when.</p>
        <p>To change the steps themselves use <b>Edit checklists</b> (top right).</p>`
    },
    "hub-dept": {
      title: "Choosing the department",
      html: `<p>Pick the department the computer is for. The setup then contains the <b>base build</b> steps (the same for every machine) plus that department's extra software and configuration. You can go <b>Back</b> if you picked the wrong one.</p>`
    },
    "hub-run": {
      title: "How to work through a setup",
      html: `
        <ol>
          <li><b>Name / hostname</b> is required. For a computer, the <b>primary user</b> is required too. Add your name as <b>Technician</b>; the service tag is optional.</li>
          <li><b>Reserve a computer</b> (computer setups): choose a department and then a device from New Stock to hold it for this setup. A reserved device drops out of the "In stock by department" count until you finish or cancel. Choose <i>none</i> to release it.</li>
          <li>Tick each step as you finish it. <b>+ Add note</b> under a step records anything unusual. The bar shows overall progress.</li>
          <li><b>Notes</b> at the top is for the setup as a whole.</li>
        </ol>
        <h5>Buttons</h5>
        <ul>
          <li><b>Save to shared log</b> (or the floating Save): writes the setup and an HTML record to the shared library. A setup at 100% is saved as <b>complete</b>; otherwise it is resumable by anyone. Your progress is also kept on this PC as you type, so a crash does not lose it.</li>
          <li><b>Check all</b> ticks every step. <b>Clear checks</b> unticks every step and removes the step notes.</li>
          <li><b>Open shared folder</b> opens the folder where records are kept (with the central setup there is no folder, so it opens the central SharePoint site instead).</li>
          <li><b>Cancel setup</b> removes this setup from the shared log (it asks why and records it). <b>Home</b> leaves, and warns you if you have unsaved progress.</li>
        </ul>`
    },
    "hub-admin": {
      title: "How to edit the checklists",
      html: `
        <ol>
          <li>Pick a list from the drop-down: <b>User setup</b>, the <b>computer base build</b>, or one department's extra steps.</li>
          <li>Edit the text of any step. The grey <b>Detail</b> line under a step is for paths, server names or anything the technician needs to copy. Leave it blank if not needed.</li>
          <li>Reorder with the ↑ ↓ buttons or by dragging the handle. ✕ removes a step. <b>+ Add item</b> adds a step to a section; <b>+ Add section</b> adds a new group of steps.</li>
          <li>Click <b>Save changes</b>. The change is logged under "Recent program changes" with your name.</li>
        </ol>
        <p><b>Reset this list</b> throws away your edits to the list on screen and restores it to the <b>template</b> (the starting checklists a super admin maintains in Settings → Platform → Template checklists). Only this list is reset.</p>
        <p>These edits only change <b>this division's</b> checklists. A super admin editing the template (you will see a banner) changes what <i>new</i> divisions start with.</p>`
    },
    /* ------------------------------------------------------------------ Issues */
    activity: {
      title: "How the Activity page works",
      html: `
        <p>One list of what people and syncs did, newest first. Division admins and super admins can open it; <b>Platform</b> rows (roles, super admins, master settings, sign-ins, NBT Sites, issues) are shown to super admins only.</p>
        <ul>
          <li>It merges three records: <b>Devices</b> (adds, removals, deploys, syncs, specs), <b>Division</b> changes (upgrade list, hot spares, checklists, division settings) and <b>Platform</b> changes (NBT Sites, roles, super admins, master settings, issues, sign-ins). The <b>Where</b> column says which.</li>
          <li>Pick a period (Today, 7 days, 30 days, All), then narrow by <b>area</b> or by <b>who</b> (both lists are searchable), or search for a name, serial number or word. <b>Copy list</b> copies what you see for Excel.</li>
          <li>Secret values are never recorded: a changed master setting shows only its name.</li>
          <li>A change appears here from the version that added it. Older changes that were never recorded cannot be shown.</li>
        </ul>`
    },
    issues: {
      title: "How to use Issues",
      html: `
        <p>Issues is the shared list of <b>bugs</b> and <b>feature requests</b> for NBG Hub. It is the same list for every division, so the team that maintains the app sees everything in one place.</p>
        <h5>Reporting</h5>
        <p>Click <b>+ New issue</b> (or <b>Report bug / feature</b> at the bottom of the sidebar). Choose bug or feature request, give it a short title and describe it: what you did, what you expected and what happened. Add <b>pictures or files</b> if they help: click <b>Choose files</b>, drag them into the window, or press <b>Ctrl+V</b> while typing to paste a screenshot straight from the clipboard (Windows key + Shift + S takes one). Pictures (png, jpg, gif, webp, bmp), pdf, txt, log and csv are accepted, up to 5 files and 5 MB each; other kinds are refused. Check it before you submit, because you cannot edit it afterwards (you can still add comments, with files). Everyone using the app can read it, so do not paste passwords or personal data.</p>
        <h5>Finding and following</h5>
        <ul>
          <li>The chips filter by <b>status</b> (<b>Active</b> is everything not Done or Won't do); the search box matches the title, the id (like #A3F9C1), the reporter and the division. <b>Mine</b> shows issues you reported or that are assigned to you.</li>
          <li>Click an issue to read it. Pictures show under the description and in the comments; click one to enlarge it, and click any other file to download it. A 📎 on the list means the issue has files.</li>
          <li><b>Comment</b> to add detail or ask a question; <b>Vote</b> (👍) if you hit it too, which helps decide what to fix first; <b>Watch</b> to get e-mails about it (commenting also watches it).</li>
        </ul>
        <h5>Statuses</h5>
        <ul>
          <li><b>New</b>: just filed, nobody has looked at it yet (every issue starts here). <b>Open</b>: seen and accepted as real, not scheduled yet. <b>Planned</b>: accepted, will be done. <b>In progress</b>: someone is working on it. <b>Done</b>: finished. <b>Won't do</b>: closed without a change (the comments say why).</li>
          <li>An issue is <b>read-only once it is filed</b>. Everyone follows it with <b>comments</b> (add detail, answer questions, say you are affected too), votes and watching.</li>
          <li>Only <b>super admins</b> can edit an issue's title, description or type, change its status, assign people and delete it. If you need your wording changed, comment and a super admin will edit it.</li>
        </ul>
        <h5>E-mails</h5>
        <p>People are e-mailed when an issue is created, changes status or gets a comment, but never about their own actions. Reporters, assignees and watchers hear about their issues; a super admin chooses who gets <b>everything</b> in Settings → Platform → Issue notifications.</p>`
    },

    /* ------------------------------------------------------------------ Devices */
    devices: {
      title: "How to use Devices",
      html: `
        <p>Devices is the live inventory for the division: <b>In stock</b> (new, unassigned machines), <b>In use</b> (assigned machines, kept in step with Intune), and the <b>Boneyard</b> (retired machines).</p>
        <h5>Finding things</h5>
        <ul>
          <li>Type in the search box to filter the current tab. It matches serial, hostname, user, model, OS and site.</li>
          <li>Every filter box is <b>searchable</b>: click it and type part of a name (for example a model) to narrow the list, then click or press Enter. <b>Manufacturer</b> merges names like "Dell" and "Dell Inc.".</li>
          <li><b>Site</b>, <b>manufacturer</b> and <b>warranty</b> filters work on every tab. On <b>In use</b> there are also model, CPU, RAM, last check-in and MFA filters. <b>Clear filters</b> removes them all. The line at the right shows how many rows match.</li>
          <li>Click a column heading to sort. Click anywhere on a row (or its <b>+</b>) to see its full details.</li>
          <li><b>Copy list</b> copies the rows you see (after search and filters) so you can paste them into Excel or a message.</li>
          <li>Warranty dates show <span style="color:var(--red)">red</span> when expired and <span style="color:var(--amber)">amber</span> when they end within 90 days.</li>
          <li>On <b>In use</b>, click a user's name to see everything installed for that person on the Software page.</li>
          <li><b>More</b> holds <b>Master sync</b> (heavier, rarely needed) and a link to the <b>Teammates</b> page, where MFA now lives.</li>
        </ul>
        <h5>Adding machines</h5>
        <p>Click <b>Add new machine</b>: choose the maker, paste or scan up to 10 serial numbers, then review what the maker's service lookup found and click <b>Add</b>. See the notes inside that window.</p>
        <h5>Deploy and manufacture dates</h5>
        <ul>
          <li>On <b>In stock</b>, click <b>🚀 Deploy</b> on a row to record the day it was deployed (today by default). It records the date only; the machine moves to In use when it checks in with a user.</li>
          <li><b>Automatic:</b> when a sync finds a machine that was in <b>In stock</b> or the <b>Boneyard</b> now assigned to a user and moves it to In use, today's date is filled in as its deploy date. A date you set yourself is never overwritten, and machines first seen in Intune (never in stock) get no automatic date.</li>
          <li>Open a row (click it) to type or pick a <b>Deploy date</b> or <b>Manufacture date</b> yourself; clear the box to remove it. <b>In use</b> shows a <b>Deployed</b> column, and both dates are in <b>Copy list</b> and can be searched.</li>
          <li>With rows ticked, <b>Mark deployed</b> / <b>Set deploy date</b> and <b>Set manufacture date</b> apply one date to all of them. The dates are kept per serial number, so they stay with a machine as it moves between lists.</li>
        </ul>
        <h5>Several machines at once</h5>
        <ul>
          <li>Tick the boxes at the start of rows (the box in the heading ticks every row shown). A bar appears with what you can do to the ticked rows: <b>Set site</b> and <b>Remove</b> on In stock; <b>Add to upgrade list</b>, <b>Move to In Stock</b> and <b>Remove</b> on In use; <b>Restore</b> on the Boneyard.</li>
          <li>Only rows you can see are ever acted on: filtering or searching unticks anything it hides. You confirm once, then each machine is processed in turn; failures are listed and every machine is still logged as usual. Removing more than 5 machines asks you to type the number.</li>
        </ul>
        <h5>Remembered for you</h5>
        <p>The tab, search, filters and sort order are remembered for each division, even after you close the app. <b>Clear filters</b> resets them. On <b>In stock</b>, <b>Any time in stock</b> finds machines that have sat unused for 30, 60, 90 or 180+ days.</p>
        <h5>Row buttons</h5>
        <ul>
          <li><b>Edit</b> (stock): correct a machine's details.</li>
          <li><b>Remove</b>: for a stock machine this decommissions it. For one in use you choose <i>Remove</i> or <i>Move back to New Stock</i> to reassign later. Both are written to the activity log with who and why.</li>
          <li><b>Edit specs</b> (✎ on In use rows): type the CPU, RAM, storage and warranty date by hand when no lookup supplied them. As you type a processor the window tells you whether it recognizes it and whether it will go on the Upgrade list.</li>
          <li><b>Upgrade</b>: adds the device to the Upgrade list with a priority yourself.</li>
          <li><b>Restore</b> (Boneyard): puts a retired machine back.</li>
        </ul>
        <h5>The buttons at the top</h5>
        <ul>
          <li><b>Log</b>: the activity log of every add, move and removal.</li>
          <li><b>Sync now</b>: pulls this division's devices from Intune into <i>In use</i>, adds new ones, updates the rest and removes duplicate rows. It never deletes devices, and afterwards it adds any device that meets the upgrade rules to the Upgrade list. The same sync runs by itself when the app opens, unless a super admin turned that off.</li>
          <li><b>Populate MFA</b>: fills the MFA column from each user's registered methods. It needs a role that can read authentication methods.</li>
          <li><b>Master sync</b>: a slower, deliberate full refresh that <b>overwrites</b> every device's user, specs, MFA, last check-in and OS from Intune and Entra. Use it when the stored values look wrong.</li>
        </ul>
        <h5>Boneyard</h5>
        <p>A device that is gone from Active Directory, Entra <i>and</i> Intune, and has not checked in for 30+ days, is moved to the Boneyard automatically. It is never deleted. If it comes back, a sync restores it, or use <b>Restore</b>.</p>`
    },
    wizard: {
      title: "How adding machines works",
      html: `
        <ol>
          <li><b>Pick the maker</b> (Dell, Lenovo or HP). The lookup asks that maker's service about each serial.</li>
          <li><b>Enter serials</b>, one per line (a barcode scanner types the serial and presses Enter, so scanning works). Up to 10 at a time; repeats are ignored.</li>
          <li><b>Review.</b> Each serial shows a tag:
            <ul>
              <li><b>Found</b>: the maker returned the model and warranty (Lenovo also returns CPU, RAM and storage).</li>
              <li><b>Manual</b>: no lookup result (no key configured, or the maker did not know it). Fill the fields in yourself.</li>
              <li><b>Duplicate</b>: already in New Stock or In Use. It is skipped.</li>
              <li><b>Error</b>: the lookup failed. It is skipped.</li>
            </ul>
            Edit any field, set the <b>site</b>, or remove a row with ✕, then click <b>Add</b>. New machines go to <b>New Stock</b>.</li>
        </ol>
        <p>Dell and HP lookups need a key from a super admin (Settings → Platform → Integrations). Without one those serials come back as <b>Manual</b>.</p>`
    },
    hotspares: {
      title: "How hot spares work",
      html: `
        <p>A <b>hot spare</b> is an imaged, ready-to-deploy machine kept for emergency swaps or loaners. The window groups them by site and department and shows live details from Intune (specs, OS install date, last check-in, compliance) joined by serial number.</p>
        <ul>
          <li><b>+</b> expands an entry to its full detail. A ⚠ marks a spare that is stale or non-compliant, so it may not be ready.</li>
          <li>Use the add button to register a spare (serial, site, department, notes about where it is held). Edit or remove entries with their buttons; every change is logged.</li>
          <li>The department groups are set per division in Settings → General → Inventory options.</li>
        </ul>`
    },

    /* ------------------------------------------------------------------ Upgrades */
    upgrades: {
      title: "How to use the Upgrade list",
      html: `
        <p>The Upgrade list is a prioritized queue of machines waiting for a hardware upgrade. It is shared with everyone in the division.</p>
        <h5>How devices get on the list</h5>
        <ul>
          <li><b>Automatically</b>, after every sync: a device is queued when it meets a rule a super admin has switched on (Platform → Integrations → Upgrades): its <b>processor</b> was released N or more years ago, and/or its <b>warranty</b> ended N or more months ago. The note on the entry says which rule matched, and the starting priority comes from how old it is. Entries marked <i>Auto-added</i> are yours to edit, reorder or remove.</li>
          <li><b>By hand</b>, whenever you like (below).</li>
          <li>A device you <b>complete</b> or <b>remove</b> is remembered and is <b>not queued again</b> automatically. A line at the bottom of the list shows how many are skipped, with <b>Allow them again</b> for division admins. Adding a device by hand always works.</li>
          <li>If nothing is queued for a division, its CPU or warranty data is probably missing: check <b>Missing specs</b> on the Dashboard.</li>
        </ul>
        <h5>Working the list</h5>
        <ol>
          <li><b>Add a device by hand.</b> From <b>Devices → In use</b> click the upgrade button on a row, or from the Dashboard's <b>Upgrade Forecast</b> list. Choose a <b>priority from 1 to 5</b> (5 = most urgent) and add notes.</li>
          <li>Each device lands under its <b>site tab</b>. Devices whose site does not match the division's sites go under <b>Other</b>.</li>
          <li><b>Reorder</b> by dragging, or with the ↑ ↓ buttons. The order is yours to set: priority is a label, not an automatic sort.</li>
          <li><b>▶ Begin</b> starts a New Computer Setup for that device in Endpoint Provisioning and marks the entry <b>Working</b> with your name. The setup's progress then shows on the list.</li>
          <li><b>✓ Done</b> checks it off: it leaves the queue and is added to the <b>Completed</b> tab with who finished it, when, and how many days it waited. <b>✎ Edit</b> changes priority or notes and shows the history; <b>✕ Remove</b> drops it without completing. Clicking anywhere on a row opens the same details.</li>
        </ol>
        <h5>Finding and planning</h5>
        <ul>
          <li>Search by serial, hostname, user, model or notes, and filter by <b>priority</b>, by <b>auto or by hand</b>, and <b>waiting or working</b>. <b>Clear filters</b> resets them; your tab, view and filters are remembered for each division.</li>
          <li>Rows from the automatic rules carry an <b>Auto</b> tag with the reason. The warranty end date is shown when it is known (red = ended, amber = within 90 days).</li>
          <li><b>By model</b> groups the list by model with a count and a priority breakdown, which is what you need to order parts or machines. Click a model to see its devices. <b>Copy list</b> copies whatever view is showing for Excel or a request.</li>
        </ul>
        <h5>Several at once</h5>
        <p>Tick rows (or <b>Select all shown</b>) to <b>set the priority</b>, <b>move to another site</b>, <b>mark upgraded</b> or <b>remove</b> them together. Only rows you can see are changed, and each action is one entry in the change log.</p>
        <p><b>Refresh</b> re-reads the list if someone else changed it.</p>`
    },

    /* ------------------------------------------------------------------ Software */
    people: {
      title: "How Teammates works",
      html: `
        <p>MFA (multi-factor sign-in) belongs to a <b>person</b>, not a machine. This page lists everyone who has an in-use machine in this division, once each, with the sign-in methods they have registered in Entra and the devices they hold.</p>
        <ul>
          <li>Click <b>Refresh from Entra</b> to read the registrations. It saves one small list for the division; nothing on your devices is rewritten. Do it whenever you want fresh numbers.</li>
          <li>The four boxes count everyone, people with MFA, people <b>without</b> it, and people Entra did not report. Click a box (or use the toggle) to filter.</li>
          <li>The <b>Sign-in methods</b> column shows what each person has set up; the amber one is their default. Someone with no methods and "No" needs to register.</li>
          <li>Click a device name to jump to it on the Devices page. <b>Copy list</b> copies what you see for Excel or a message.</li>
          <li>Tick people (the box in the heading ticks everyone shown) for a bar with three actions: <b>Copy selected</b>; <b>Show their devices</b>, which opens Devices limited to those people (click the &times; on its Teammates chip to undo); and <b>E-mail</b>, which opens a <b>draft</b> addressed to them. Nothing is ever sent for you.</li>
          <li>For the draft, <b>Open in Outlook</b> uses your default mail program (classic or new Outlook), and <b>Open in Outlook on the web</b> works in the browser. Very long lists do not fit in one link; the addresses are then copied so you can paste them into To.</li>
          <li>The Devices page's MFA column and filter read from this list, and the Dashboard's "Users without MFA" box opens it filtered to people without MFA.</li>
        </ul>
        <p>Reading registrations needs the <code>AuditLog.Read.All</code> permission and a reader role (Security Reader, Security Administrator or Global Reader). Without them everyone shows as Unknown.</p>`
    },
    software: {
      title: "How to use Software Inventory",
      html: `
        <p>This page lists the apps Intune detected on this division's machines and tells you who is <b>missing</b> software their department is expected to have.</p>
        <ol>
          <li>Click <b>Refresh from Intune</b> to pull the inventory. It reads every device, so it can take a few minutes; you can use other pages meanwhile. The result is cached and shared, so normal browsing never re-queries Intune. The time of the last pull is shown beside the button.</li>
          <li>Use the <b>one search box</b> for software (name or publisher) <i>or</i> a person or device. A software name lists those apps; a person or device name lists everything installed on them. If a word matches both, chips let you choose. The <b>department</b> list narrows it further; a department comes from each person's Entra profile.</li>
          <li>Each app is <b>one row</b>, whatever its version: the install count covers every version, and the <b>Versions</b> column shows how many there are and which is the latest. Click <b>N versions</b> (or the arrow) to list them; click a version to see only the people with that one.</li>
          <li>Click an app (anywhere on its row) to see <b>who has it</b>, with the version each person has. In that window, type to filter, pick a <b>Version</b> from the list to narrow it, click a column heading to sort, use <b>Copy list</b> to paste the rows into Excel, or click a user's name to see <b>everything that person has</b>.</li>
          <li><b>Mandatory</b> apps are worked out automatically as each department's <b>most-installed apps</b> (10 by default; the <b>Mandatory apps…</b> button changes that). Its <b>Department list</b> tab lets you add or remove apps for one department, copy another department's list, or <b>Clear my changes</b> to undo your additions and removals and use the automatic list again. Its <b>Automatic rule</b> tab (division admins only) sets how many apps, the minimum share of the department that must have an app, and the smallest department that gets an automatic list. You can flag or unflag an app as mandatory for a department to override that. Switch to <b>Mandatory only</b> to hide everything else: with one department chosen it shows the mandatory list of that department, with all departments it shows apps mandatory in at least one.</li>
        </ol>
        <p>"Missing" is judged against the <b>newest version</b> of an app only: someone with an old release but not the latest still counts as missing. Versions of one app are grouped under its name. The Dashboard's compliance counts use exactly the same rules.</p>`
    },

    /* ------------------------------------------------------------------ NBT Sites / Project Hub */
    sites: {
      title: "How to use NBT Sites",
      html: `
        <p>NBT Sites is a launcher for the Nucor web tools your team uses, grouped by category. Click a tile to open it.</p>
        <ul>
          <li>How a tool opens is set per tool: in your <b>default browser</b> (best for sign-in portals), <b>full window</b> inside this app with a green <b>← Back to NBG Hub</b> button, a <b>separate window</b>, or <b>embedded</b> in the page (only works for sites that allow it).</li>
          <li>While a tool is open inside the app, <b>Reload</b>, <b>Open in window</b> and <b>All sites</b> appear at the top right.</li>
          <li><b>+ Add site</b> at the end of the list adds your own shortcut (name and address) under <b>Custom</b>. <b>Custom sites are shared with everyone on the platform</b>, and removing one removes it for everyone. You can pick an icon for it.</li>
          <li>Super admins manage the categories, icons and built-in tools in Settings → Platform → NBT Sites.</li>
        </ul>`
    },
    projecthub: {
      title: "About Project Hub",
      html: `<p>Project Hub signs in with its own Microsoft login, which cannot run inside this app, so it always opens in your <b>default web browser</b> where you are already signed in. Click <b>Open Project Hub</b>. The address is set per division by a division admin in Settings → General → Project Hub (a platform default applies otherwise).</p>`
    },

    /* ------------------------------------------------------------------ BG Tools */
    bgt: {
      title: "About BG Tools",
      html: `<p>BG Tools are small admin utilities. Pick a tile: <b>Timesheet Fix</b> (unlock a timesheet week), <b>Coil Cards</b> (delete a coil card with a backup, or restore one), <b>Permissions Finder</b> (every group a person is in) and <b>Missing Groups</b> (what a person or department lacks compared with its peers). They read and write live in SQL / Entra as <b>you</b>, so you need the matching access. Searches start as you type.</p>`
    },
    "bgt-timesheet": {
      title: "How Timesheet Fix works",
      html: `
        <ol>
          <li>Start typing the employee's first or last name (2 letters or more). Matches appear as you type; click one. Pressing Enter opens a single match straight away.</li>
          <li>You see the <b>last 8 weeks</b> with fiscal year, week and whether each is <b>Locked</b> or <b>Unlocked</b>.</li>
          <li>Select a <b>locked</b> week (unlocked weeks cannot be selected), click <b>Unlock week</b>, then <b>Confirm unlock</b>.</li>
        </ol>
        <p>Unlocking only flips the week from locked to unlocked: it does not touch who modified the row or when. Every unlock is recorded in the activity log. It uses the SQL server and tables set for your division (Settings → Directory &amp; SQL), and runs with <b>your</b> Windows sign-in. If this division has no timesheet set up you will see a message saying so.</p>
        <p>Note: the employee table can contain people from other Nucor entities as well as your division.</p>`
    },
    "bgt-coilcard": {
      title: "How Coil Cards works",
      html: `
        <p><b>Delete</b> tab</p>
        <ol>
          <li>Type the coil card number (the NBSNumber) and click <b>Look up</b>. You see the card and how many tracking rows go with it. Nothing is changed yet.</li>
          <li>Click <b>Delete this card</b>, type the card number again to confirm, then <b>Delete</b>.</li>
        </ol>
        <p>The tracking rows are deleted first, then the card, in one step: if the card is not removed exactly once, everything is rolled back. Before the delete, both are saved as a JSON file named <code>coilcard-backup-&lt;card&gt;-&lt;time&gt;.json</code> in your division's folder of the <b>Inventory - Hub Files</b> library on SharePoint, and read back to check it. If that fails, nothing is deleted.</p>
        <p><b>Restore</b> tab</p>
        <ol>
          <li>Pick a backup from the list (filter by card number). The tool checks the database and shows the card and its tracking rows. Nothing is changed yet.</li>
          <li>Click <b>Restore this card</b>, type the card number, then <b>Restore</b>.</li>
        </ol>
        <p>The card and all its tracking rows go back in one step; if any row fails, everything is rolled back. A restore is refused when the card (or any of its tracking rows) already exists, so it can never overwrite or duplicate data. Values come back exactly as stored, including empty (NULL) fields; dates are restored to the millisecond.</p>
        <p>Every delete and restore is written to the change log. Both use your division's SQL server and the Windows account that started the app, and are disabled in Local data mode. Database and table names are in Settings &rarr; Platform &rarr; Master settings (Directory). The <b>(Untested)</b> label in the heading is removed with <b>Mark Coil Cards as (Untested)</b> = Off in the same place.</p>`
    },
    "bgt-perms": {
      title: "How the Permissions Finder works",
      html: `
        <ol>
          <li>Start typing a teammate's name. Matches appear as you type; click one. <b>Division</b> picks whose people are searched: the current division comes first and is selected for you. Click the box and type to find another division or BG brand.</li>
          <li>You then see <b>every group</b> the person belongs to, directly and through nested groups, from Entra.</li>
          <li>Use the <b>filter</b> box to narrow the list (for example type <i>boms</i>), and the counts above the list show how many match.</li>
        </ol>
        <p>The list of other divisions and brands you can pick is maintained by super admins in Settings → Platform → People-search scopes.</p>`
    },
    "bgt-copyperms": {
      title: "How Copy Permissions works",
      html: `
        <ol>
          <li>Search and pick the <b>source</b> person (whose access you want to copy) and the <b>destination</b> person. Search shows only people in the current division (plus admin accounts, which have no company); tick <b>Include people from other divisions</b> to widen it. Use their admin account if the access is on that account.</li>
          <li><b>Compare</b> shows on-premises AD groups in three lists: <b>Destination is missing</b> (the source has them, the destination does not: these are the ones you can copy), <b>Both have</b>, and <b>Source is missing</b> (the destination has them, the source does not). Only direct memberships are compared.</li>
          <li>Nothing is ticked for you: tick the groups to copy in the <b>Only source has</b> list (or use <i>Select all (not privileged)</i>). Groups marked <b>privileged</b> are protected admin groups.</li>
          <li><b>Preview</b> lists what would be added and changes nothing. <b>Copy now</b> asks you to confirm, then adds the destination to the groups.</li>
        </ol>
        <p>Writing uses <b>your own admin account on your YubiKey</b>: insert the key and click your account in the box (the accounts on the inserted key are found automatically; you can also type one). A separate window opens and asks for the PIN <b>once</b>, with hidden typing; the app never sees the PIN. A wrong PIN stops the run at once (no retries, to protect the key from locking). Reading works on a PC that is not joined to AD, as long as you are on the corporate network or VPN. Each copy is written to the change log. Removing groups is not supported.</p>`
    },
    "bgt-missing": {
      title: "How Missing Groups works",
      html: `
        <p>Missing Groups compares a person (or a whole department) with its <b>group baseline</b>: the groups most people in that department hold. Anything the baseline expects but the person lacks is listed as <b>missing</b>.</p>
        <ul>
          <li><b>By teammate</b>: start typing a name, click the match. You see what they are missing and what they have.</li>
          <li><b>Add to AD</b> (by teammate): tick the missing groups you want (none are ticked for you), choose your YubiKey account, then <b>Preview</b> or <b>Add</b>. A window asks for the PIN once. Groups are matched in on-premises AD by exact name; any with no match (for example cloud-only groups) are skipped and listed. Each add is written to the change log.</li>
          <li><b>By department</b>: pick a department that has a baseline and click <b>Check</b> to see everyone in it who is missing something.</li>
        </ul>
        <p>It only works for departments that have a saved baseline. Build one in <a onclick="Settings.open('perms')">Settings → Group baselines</a> (or use the <b>Analyze</b> button offered when one is missing). Only people in the current division's Entra company are searched, because department names are shared between divisions.</p>`
    },

    /* ------------------------------------------------------------------ Settings sections (tenant) */
    "set-general": {
      title: "About General settings",
      html: `
        <ul>
          <li><b>About this division</b> is read-only: name, id, Entra company, Intune device category and sites. A super admin changes these under Platform → Divisions.</li>
          <li><b>My default division</b> (only if you can see more than one division): the division NBG Hub opens in at every start. Only you see this choice. Leave it on "The last division I used" to keep the old behaviour.</li>
          <li><b>Time zone</b>: every date and time in the app for this division is shown in this zone. "Use the default" uses the platform default, or each PC's own zone if there is none. The line under the box shows what the time is right now in the zone you pick.</li>
          <li><b>Inventory options</b> (division admins): <i>Devices to sync from Intune</i> chooses between Windows computers only (the default) and every device type. <i>Hot spare departments</i> are the department groups on the Hot spares window; "Other" is always added at the end.</li>
          <li><b>Project Hub</b>: where the sidebar's Project Hub item opens for this division. Leave it blank to use the platform default. "Open this address" lets you test it first.</li>
        </ul>
        <p>Plain users see this page read-only. Changes are saved with the button on each card.</p>`
    },
    "set-access": {
      title: "How access works",
      html: `
        <p>This list controls <b>who can switch to this division</b> and what they can do in Settings.</p>
        <ul>
          <li>Search for a <b>person</b> (name or sign-in) or an <b>Entra group</b> and click a result to add them. Adding a group once and managing its members in Entra is usually easiest.</li>
          <li>The <b>Role</b> column: <b>User</b> can use the division; <b>Admin</b> can also change its settings. Which Settings sections each role sees is set by a super admin under Platform → Role access.</li>
          <li>Click ✕ to remove an entry. Nothing changes until you click <b>Save access</b>.</li>
          <li>You cannot save a list that removes your own admin rights. "Everyone" can only be granted by a super admin; if it is on, all app users can see the division.</li>
          <li>An empty list means only super admins can see the division.</li>
        </ul>
        <p>This controls what the <b>app</b> shows. People who can open the underlying SharePoint site could still read the lists directly.</p>`
    },
    "set-sites": {
      title: "How sites work",
      html: `
        <p>A site is a physical location in the division. Each has a short <b>code</b> (2 to 6 letters or digits) used on tags, tabs and the dashboard.</p>
        <ul>
          <li><b>User city starts with</b>: how a person's Entra city is turned into a site (type the start of the city and press Enter).</li>
          <li><b>Device name starts with</b>: how a device name is turned into a site, for example <i>BGTER</i>.</li>
          <li><b>A division with exactly one site</b> puts every device and person in that site, whatever the name or city says. With two or more sites, anything that matches no prefix is shown as <b>Other</b>.</li>
        </ul>
        <p>Changing a code regroups devices on the dashboard and lists. Existing records keep their old code until a sync updates them. Click <b>Save sites</b> to apply; <b>Discard changes</b> reloads the saved version.</p>`
    },
    "set-sql": {
      title: "How Directory & SQL works",
      html: `
        <p>These settings tell the BG Tools which SQL server and tables belong to this division, and which Active Directory domain to look in.</p>
        <ol>
          <li>Type the <b>SQL server</b> (host, or host\\instance) and click <b>Load databases</b>. The list is read from the server with <b>your</b> sign-in; nothing is changed.</li>
          <li>Choose the <b>timesheet database</b>, then its <b>week-lock table</b>; do the same for the <b>employee database</b> and <b>employee table</b>. The tables load when you pick a database. If loading fails you can use <b>Type names by hand</b>.</li>
          <li>Leave all four blank if the division has no timesheet tool. <b>Clear all four</b> does that for you.</li>
          <li>The <b>Active Directory domain</b> is optional (for example the domain used by the device and user lookups).</li>
        </ol>
        <p>Click <b>Save</b> to apply. Names may only contain letters, digits and underscores (a table can be written <i>schema.table</i>).</p>`
    },
    "set-models": {
      title: "How Model departments work",
      html: `
        <p>Here you say which <b>department each computer model is for</b>. The Dashboard then shows how many spare machines each department has in stock, and the Reserve-a-computer list in Endpoint Provisioning uses the same grouping.</p>
        <ol>
          <li>Add or remove <b>departments</b> with the box at the top (press Enter or <b>+ Add</b>).</li>
          <li>In the table, choose a department for each model. You can also tick several models and use <b>Assign selected to</b> + <b>Apply</b>. Use the search and filter above the table to find models.</li>
          <li>Click <b>Save</b>. Models you leave unassigned show as <b>Unassigned</b>.</li>
        </ol>
        <p>Every model currently in stock or in use is listed, plus any model already mapped.</p>`
    },
    "set-links": {
      title: "How NBT Sites settings work",
      html: `
        <ul>
          <li>This list is <b>platform-wide</b>: every division sees the same sites, and only super admins edit it here.</li>
          <li>Click the <b>Icon</b> button on a row to choose a colour icon from the built-in set (search by word) or upload your own picture, such as a tool's logo.</li>
          <li><b>Categories</b> group the tiles on the NBT Sites page. Add one with the box; ✕ removes it (its sites become Uncategorized).</li>
          <li>Each row is a tool: a <b>name</b>, its <b>web address</b> (https://…), a <b>category</b> and <b>Opens as</b>:
            <ul>
              <li><b>Web browser (SSO)</b>: your default browser, already signed in. Best for portals.</li>
              <li><b>In-app (full window)</b>: takes over the app window with a Back button. Good for sign-in pages.</li>
              <li><b>Separate window</b>: a second app window.</li>
              <li><b>Embedded</b>: inside the page, only for sites that allow being framed.</li>
            </ul></li>
          <li>Use <b>+ Add site</b> for a new row and ✕ to remove one. Click <b>Save</b>; <b>Cancel</b> discards your edits.</li>
        </ul>
        <p>Anyone can also add a shortcut from the NBT Sites page itself (shared as "Custom").</p>`
    },
    "set-perms": {
      title: "How Group baselines work",
      html: `
        <p>A baseline is the list of Entra groups most people in a department hold. <b>Missing Groups</b> (BG Tools) compares people against it. Only people in this division's Entra company are counted, because department names are shared between divisions.</p>
        <ol>
          <li><b>Add a department</b>: start typing its name in the box (suggestions appear) and press Enter or click Analyze. The app reads every member's groups from Entra, which can take a while.</li>
          <li><b>Majority threshold</b> (slider): a group counts as "expected" when at least this share of the department has it.</li>
          <li>On each department card, <b>tick or untick</b> groups to decide which really count as expected, and add a group by hand if one is missing.</li>
          <li><b>Re-analyze all</b> refreshes every saved baseline. <b>Rebuild from directory</b> finds every department in this division and rebuilds all baselines from scratch (it replaces the existing ones).</li>
        </ol>
        <p>Changes here save <b>automatically</b>; there is no Save button.</p>`
    },
    "set-storage": {
      title: "About Storage",
      html: `<p>Shows where this division's shared working data (checklists, setups, upgrade list, hot spares and so on) is stored. With the central setup it is kept as rows in the <b>NBG Hub Data</b> SharePoint site and shared by everyone in the division, so there is nothing to configure: <b>Open the central site</b> shows it. Only if the app is running from a plain shared folder (the older setup) does this page show a folder path and warn when that folder is private to one PC.</p>`
    },

    /* ------------------------------------------------------------------ Settings sections (platform) */
    "set-divisions": {
      title: "How to manage divisions",
      html: `
        <p>A division is one business unit with its own people, devices, sites and data. This list is shared by everyone; changes reach other users within about 5 minutes or on their next restart.</p>
        <ul>
          <li><b>Edit</b> opens a division. Its tabs: <b>Identity</b> (display name, Entra company, Intune category, visible or hidden), <b>Sites</b>, <b>Directory &amp; SQL</b>, <b>Access</b> and <b>Advanced</b> (old SharePoint site, only for importing old data).</li>
          <li>The <b>Entra company</b> is picked from real company names as you type, and must match exactly: people are scoped by it. The <b>Intune category</b> comes from a list of the categories Intune has. Devices are scoped by it.</li>
          <li>The <b>Access</b> table works as in "Who has access". Mark at least one person or group as <b>Admin</b> so the division can manage itself.</li>
          <li><b>Hidden</b> (untick Visible) removes a division from everyone's switcher without deleting anything.</li>
        </ul>
        <h5>Adding a division</h5>
        <p>Click <b>+ Add division</b> and pick a starting point: <b>One site</b>, <b>Several sites</b>, <b>Blank</b>, or <b>Copy an existing division</b> (reuses its SQL server, tables, AD domain and number of sites, but never its identity or access). Fill in the name, Entra company and Intune category, click <b>Save division</b>, then give it people on the Access tab. Its Endpoint Provisioning checklists start from the template.</p>`
    },
    "set-admins": {
      title: "About super admins",
      html: `<p>Super admins manage the whole platform: every division, who can see it, the Platform settings and integrations. Search for a person by name or sign-in and click to add them; click ✕ to remove one. Use the account people actually sign in with (for example the <i>adm.name.azure@…</i> account if that is the one that holds the Intune role). You cannot remove yourself, and entries marked <b>config</b> come from the app's config file and can only be removed there.</p>`
    },
    "set-issuenotify": {
      title: "How issue notifications work",
      html: `
        <p>When someone files an issue, changes its status or comments, the app tells the right people. Everyone involved in an issue (reporter, assignee, watchers) is told about status changes and comments. <b>The people listed here</b> are told about the events you tick, for <b>every</b> issue.</p>
        <ol>
          <li><b>Add a person</b>: type a name or sign-in; the list comes from Entra. Each person starts with all three events ticked: <i>New issue</i>, <i>Status change</i>, <i>New comment</i>. Untick what they do not need, then click <b>Save people</b>.</li>
          <li><b>How the e-mail leaves the app.</b> The app does not send mail itself. Create a Power Automate flow with the trigger <i>When an HTTP request is received</i> and an action that sends an e-mail (or posts to Teams) to the addresses in the request's <code>to</code> list, using its <code>subject</code> and <code>html</code> fields. Paste the flow's address into Settings → Integrations → Notifications. The badge at the top shows whether that is set.</li>
          <li>Click <b>Send a test</b> to send a sample to the people on the list (or to you if the list is empty).</li>
        </ol>
        <p>No webhook and no mail permission means nothing is sent; the issue's activity log says "not sent" so you can see it. Nothing is sent in Local data mode.</p>
        <h5>Old reports</h5>
        <p><b>Import the old lists</b> copies the earlier per-division "Report bug / feature" items onto the board once. Items already copied are skipped.</p>`
    },
    "set-scopes": {
      title: "About people-search scopes",
      html: `
        <p>The Permissions Finder (BG Tools) searches the people of the division you are in, and can also search the groups listed here.</p>
        <ul>
          <li><b>Other BG brands</b>: a name and the brand's <b>email domain</b> (for example example.com).</li>
          <li><b>Other divisions</b>: a name and the <b>exact Entra company name</b>. Every division in this app is added automatically, so list only divisions that are not set up here.</li>
          <li><b>+ Add</b> a row, ✕ removes one. Blank rows and duplicates are dropped when you save.</li>
        </ul>
        <p>Until you save, the built-in lists are shown; saving makes the lists yours.</p>`
    },
    "set-template": {
      title: "About template checklists",
      html: `
        <p>The template holds the <b>starting checklists</b> (New Computer Setup, New User Setup, department steps). A new division copies them the first time it opens Endpoint Provisioning, and a division's <b>Reset this list</b> goes back to them.</p>
        <ol>
          <li>Click <b>Edit the template checklists</b>. The normal checklist editor opens with a banner saying you are editing the template, not a division.</li>
          <li>Edit and <b>Save changes</b> as usual, then click <b>Done editing the template</b>.</li>
        </ol>
        <p>Divisions that already have checklists keep their own: editing the template never changes them. Until you customise it, the template is the built-in default, which still contains NBGW-specific steps.</p>`
    },
    "set-roles": {
      title: "How role access works",
      html: `
        <p>Tick which Settings sections each role may use. <b>General</b> is always visible to everyone (read-only for users). Super admins always have everything.</p>
        <ul>
          <li>The default is: <b>users</b> see General only; <b>division admins</b> see everything for their division.</li>
          <li>The rule is enforced when saving, not just in the menu: a role without a section cannot save changes to it.</li>
          <li>It applies to <b>every</b> division. Changing a person's role in a division is done on that division's Access list.</li>
        </ul>
        <p>Model departments and NBT Sites data is shared day-to-day information: unticking those only hides the settings page for them.</p>`
    },
    "set-sync": {
      title: "How Sync all divisions works",
      html: `
        <ol>
          <li>Click <b>Sync all divisions now</b> and confirm. It runs the normal sync for each enabled division, one after another: it reads the division's devices from Intune, adds and updates the In Use list, removes duplicate rows and fills in missing warranty and specs.</li>
          <li>A results table shows, per division, the devices seen, added, updated, duplicates removed and anything filled in. <b>Needs attention</b> shows the first error.</li>
        </ol>
        <ul>
          <li>It never deletes devices and never runs the Boneyard sweep.</li>
          <li>If Intune returns no devices for a division that already has rows, that division is skipped and left unchanged (a safety check).</li>
          <li>A division someone else is already syncing is skipped ("another sync is already running"). The lock clears itself after 30 minutes.</li>
          <li>Each division gets an entry in its activity log, and its <b>Last sync</b> record is updated.</li>
          <li>It runs as you and only while the app is open. It stops if you close the app.</li>
        </ul>
        <p><b>Last sync per division</b> below shows what last synced each division (this button or someone's app), with a warning when it is over 36 hours old.</p>`
    },
    "set-integrations": {
      title: "How integrations & options work",
      html: `
        <p>These are platform-wide settings, kept in the central Master Settings list. Each row has its own <b>Save</b> button.</p>
        <ul>
          <li><b>Vendor APIs</b>: keys for Lenovo, Dell and HP warranty and spec lookups. Secrets are stored hidden and are <b>never shown again</b>; type a new value to replace one. Dell and HP only give model and warranty date, not CPU or RAM.</li>
          <li><b>Regional</b>: the default time zone and the default Project Hub address, used by divisions that have not set their own.</li>
          <li><b>Directory</b>: the domain controller that Copy Permissions uses (for example <i>BGDALDCRW02.bg.nucorsteel.local</i>). Blank lets Windows pick one.</li>
          <li><b>Sync</b>: whether the app syncs when it opens, how many vendor lookups one sync may make, and after how many days without a check-in a device counts as stale.</li>
          <li><b>Upgrades</b>: the two rules that queue devices for an upgrade after each sync. <i>Processor older than (years)</i> (default 5) and <i>Warranty ended at least (months)</i> (default 0 = off). A device qualifies when either rule matches; set a rule to 0 to switch it off.</li>
          <li><b>Releases</b>: set <i>Latest released version</i> after handing out a new installer so people on older versions see "Update available"; raise <i>Oldest allowed version</i> to show a red "Update required".</li>
          <li><b>Other stored settings</b> are anything else in the list; the <b>Advanced</b> box adds a setting this screen does not know yet.</li>
        </ul>
        <p>Blank means "use the built-in default". Numbers are checked against their allowed range when you save.</p>`
    },
  },

  /* ---- plumbing ---- */
  _key: id => "nbg_help_" + id,
  isOpen(id) { try { return localStorage.getItem(this._key(id)) === "1"; } catch (e) { return false; } },
  box(id) {
    const d = this.DOCS[id];
    if (!d) return "";
    return `<details class="help-box" data-help="${attr(id)}"${this.isOpen(id) ? " open" : ""}><summary><span class="help-ic">?</span>${esc(d.title)}</summary><div class="help-body">${d.html}</div></details>`;
  },
  /* fill <div class="help-slot" data-help="..."> placeholders (static pages) */
  mount(root) {
    (root || document).querySelectorAll(".help-slot[data-help]").forEach(el => { el.outerHTML = this.box(el.dataset.help); });
  },
};
/* remember open/closed per box. `toggle` does not bubble, so listen in the capture phase */
document.addEventListener("toggle", e => {
  const el = e.target;
  if (el && el.classList && el.classList.contains("help-box")) {
    try { localStorage.setItem(Help._key(el.dataset.help), el.open ? "1" : "0"); } catch (err) { /* private window: just do not remember */ }
  }
}, true);
Help.mount();                        // the static pages are already in the document when this script runs
