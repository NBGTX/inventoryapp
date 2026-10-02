"use strict";

/* ---- helpers ------------------------------------------------------------- */
const esc = s => (s == null ? "" : String(s)).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const attr = s => (s == null ? "" : String(s)).replace(/&/g, "&amp;").replace(/"/g, "&quot;");


/* ---- backend bridge: real pywebview API, or a mock for browser preview ---- */
/* "Saving..." indicator. Writes to SharePoint can take 3-4 seconds; without feedback the app looks frozen.
   Shown only if a save is still running after 250 ms. Long jobs (syncs, pulls) have their own progress UI and
   must NOT lock the screen, so they are excluded. */
const Busy = {
  n: 0, timer: null,
  WRITE: /^(bulk_|device_dates_set|save_|set_|add_|hub_bulk|delete_|remove_|update_|move_|restore_|hub_save|hub_add|hub_delete|hub_remove|perm_save|ts_unlock|switch_|register_|reserve_|complete_|start_|issue_(create|comment|update|delete|vote|watch|notify)|issues_import)/,
  LONG: /^(run_sync|enrich_inventory|sync_all_divisions|master_sync|populate_mfa|boneyard_sweep|software_refresh|mfa_people_refresh|pull_prod_snapshot|set_data_mode)$/,
  watches(method) { return this.WRITE.test(method) && !this.LONG.test(method); },
  /* Long jobs keep running when you move to another page (the work is in the backend); this shows them in the sidebar
     so you can see they are still going, and stops a division switch from pulling the rug out from under them. */
  JOBS: { run_sync: "Syncing with Intune", enrich_inventory: "Filling in specs", sync_all_divisions: "Syncing all divisions",
          master_sync: "Master sync", populate_mfa: "Populating MFA", boneyard_sweep: "Checking the boneyard",
          software_refresh: "Pulling software inventory", mfa_people_refresh: "Refreshing MFA", pull_prod_snapshot: "Copying production data" },
  jobs: new Map(), _jobSeq: 0,
  jobStart(method) {
    const id = ++this._jobSeq;
    this.jobs.set(id, this.JOBS[method]);
    this.drawJobs();
    return id;
  },
  jobEnd(id) { this.jobs.delete(id); this.drawJobs(); },
  running() { return [...this.jobs.values()]; },
  drawJobs() {
    let el = document.getElementById("jobChip");
    if (!el) {
      const foot = document.querySelector(".side-foot");
      if (!foot) return;
      el = document.createElement("div"); el.id = "jobChip"; el.className = "job-chip";
      foot.insertBefore(el, foot.firstChild);
    }
    const names = [...new Set(this.running())];
    el.style.display = names.length ? "flex" : "none";
    el.innerHTML = names.length ? `<span class="busy-spin"></span><span>${names.map(esc).join(" · ")}…</span>` : "";
    el.title = "Still running in the background. You can use other pages meanwhile; switching division waits until it finishes.";
  },
  start() {
    if (++this.n > 1) return;
    this.timer = setTimeout(() => {
      document.body.classList.add("is-busy");
      let el = document.getElementById("busyPill");
      if (!el) { el = document.createElement("div"); el.id = "busyPill"; el.innerHTML = '<span class="busy-spin"></span> Saving…'; document.body.appendChild(el); }
      el.style.display = "flex";
    }, 250);
  },
  end() {
    if (this.n > 0 && --this.n > 0) return;
    clearTimeout(this.timer);
    document.body.classList.remove("is-busy");
    const el = document.getElementById("busyPill");
    if (el) el.style.display = "none";
  },
};

/* Switching division (or data mode) reloads the window so every cache starts clean. Remember where the user
   was and put them back there, instead of dropping them on the dashboard. */
const Resume = {
  KEY: "nbg_resume",
  reload() {
    try {
      const a = document.querySelector(".appview.active");
      sessionStorage.setItem(this.KEY, JSON.stringify({
        view: a ? a.id.replace("appview-", "") : "dashboard",
        settingsTab: (typeof Settings !== "undefined" && Settings.tab) || "",
        devTab: (typeof App !== "undefined" && App.state && App.state.tab) || "" }));
    } catch (e) {}
    location.reload();
  },
  apply() {
    let r = null;
    try { r = JSON.parse(sessionStorage.getItem(this.KEY) || "null"); sessionStorage.removeItem(this.KEY); } catch (e) {}
    if (!r || !r.view || r.view === "dashboard" || r.view === "projecthub") return;
    if (r.settingsTab) Settings.tab = r.settingsTab;                    // Settings falls back to General if this tab does not exist in the new division
    if (r.devTab && ["stock", "use", "boneyard"].includes(r.devTab)) App.state.tab = r.devTab;
    Nav.go(r.view);
  },
};

/* Refresh-style buttons must SAY something: a re-read often returns the same numbers, which looks like "nothing happened".
   Ui.refreshing(button, work, "Upgrade list") shows a spinner, ignores a second click, then confirms with the time. */
const Ui = {
  /* A button that does something slow: spinner + a label that says what is happening, locked against a second click.
     `work` returns true on success (the button stays locked, the caller closes the window) or false to unlock it again. */
  async working(btn, label, work) {
    if (!btn || btn.dataset.busy) return false;
    btn.dataset.busy = "1";
    const old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="busy-spin"></span> ' + esc(label);
    let ok = false;
    try { ok = await work(); } catch (e) { App.toast(String((e && e.message) || e), true); }
    if (!ok || !document.body.contains(btn)) { if (document.body.contains(btn)) { btn.disabled = false; btn.innerHTML = old; delete btn.dataset.busy; } }
    return ok;
  },
  async refreshing(btn, work, what) {
    if (!btn) { await work(); return; }
    if (btn.dataset.busy) return;
    btn.dataset.busy = "1";
    const old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="busy-spin"></span> Refreshing…';
    let ok = true;
    try { await work(); } catch (e) { ok = false; App.toast("Refresh failed: " + String((e && e.message) || e), true); }
    finally { btn.disabled = false; btn.innerHTML = old; delete btn.dataset.busy; }
    if (ok) App.toast((what ? what + " " : "") + "refreshed " + new Date().toLocaleTimeString(undefined, Tz.o({ hour: "numeric", minute: "2-digit", second: "2-digit" })) + ".");
  },
};

const Backend = {
  real: false,
  async call(method, ...args) {
    const watch = Busy.watches(method);
    if (watch) Busy.start();
    const job = Busy.JOBS[method] ? Busy.jobStart(method) : 0;
    try {
      let res;
      if (this.real && window.pywebview && window.pywebview.api && window.pywebview.api[method]) {
        res = await window.pywebview.api[method](...args);
      } else {
        res = await Mock[method](...args);
      }
      if (res && res.ok === false && /sign.?in (is )?required|no cached account|sign-in failed|AADSTS|interaction_required/i.test(String(res.error || ""))
          && method !== "sign_in" && typeof App !== "undefined" && !document.body.classList.contains("signed-out")) {
        App.showSignedOut("Your sign-in expired. Sign in again to continue.");
      }
      return res;
    } finally {
      if (watch) Busy.end();
      if (job) Busy.jobEnd(job);
    }
  },
};

/* ---- mock (browser preview only) ---------------------------------------- */
const Mock = {
  _stock: [
    { serial: "C02XL1AAJTGH", manufacturer: "Dell", model: "Latitude 5540", cpu: "i7-1365U", ram: "16 GB", storage: "512 GB", site_tag: "LTR", date_added: "2026-07-15" },
    { serial: "PF3ABCD01", manufacturer: "Lenovo", model: "ThinkPad T14 G4", cpu: "i5-1345U", ram: "16 GB", storage: "256 GB", site_tag: "BRI", date_added: "2026-07-12" },
    { serial: "C02XL9ZZAA1", manufacturer: "Dell", model: "Latitude 5440", cpu: "i5-1335U", ram: "16 GB", storage: "256 GB", site_tag: "LTR", date_added: "2026-07-08", last_checkin: "2026-05-20T09:00:00Z", os_install: "2026-02-01T10:00:00Z", os_version: "10.0.22631", warranty: "2027-03-01" },
    { serial: "C02XL5540BRI", manufacturer: "Dell", model: "Latitude 5540", cpu: "i7-1365U", ram: "16 GB", storage: "512 GB", site_tag: "BRI", date_added: "2026-07-05" },
  ],
  _use: [
    { serial: "C02XL2BBQQ2", device_name: "BGLTRLT014", manufacturer: "Dell", model: "Latitude 5440", user: "j.ramirez@nucor.com", site_tag: "LTR", cpu: "Intel Core i5-1335U", ram: "16 GB", storage: "256 GB", warranty: "2027-05-01", os_version: "10.0.22631", os_install: "2026-03-10T17:42:52Z", last_checkin: "2026-07-26T08:12:00Z", mfa: "Yes" },
    { serial: "PF3AB99KK", device_name: "BGBRILT021", manufacturer: "Lenovo", model: "ThinkPad T14 G3", user: "s.bhatt@nucor.com", site_tag: "BRI", cpu: "Intel Core i7-1260P", ram: "32 GB", storage: "512 GB", warranty: "2026-11-20", os_version: "10.0.22631", os_install: "2026-01-15T09:00:00Z", last_checkin: "2026-05-02T14:03:00Z", mfa: "No" },
    { serial: "PF5NOSITE", device_name: "BGPF5NOSITE", manufacturer: "Lenovo", model: "ThinkPad X1", user: "no.city@nucor.com", site_tag: "", cpu: "Intel Core Ultra 7 258V", ram: "32 GB", storage: "512 GB", warranty: "2027-01-01", os_version: "10.0.26200", os_install: "2026-05-01T00:00:00Z", last_checkin: "2026-01-06T10:20:00Z", mfa: "Yes" },
  ],
  _log: [
    { when: "2026-07-15T14:02:00Z", action: "Added", serial: "C02XL1AAJTGH", model: "Latitude 5540", actor: "Demo User", details: "Site LTR" },
  ],
  _logIt(action, serial, model, details) {
    this._log.unshift({ when: new Date().toISOString(), action, serial, model, actor: "Demo User (mock data)", details });
  },
  async get_status() { return { ok: true, signed_in: true, account: "Demo User (mock data)", upn: "demo.user@nucor.com" }; },
  async sign_in() { return { ok: true, account: "Demo User (mock data)" }; },
  async sign_out() { return { ok: true }; },
  async app_version() { return { ok: true, version: "2026.10.01" }; },
  async register_client() { return { ok: true, version: "2026.10.01" }; },
  async get_clients() {
    return { ok: true, clients: [
      { machine: "BGPF5MDA4B", user: "blake.stevenson", version: "2026.09.29", last_seen: "2026-09-28T15:40:00Z" },
      { machine: "BGLTRHELPDK2", user: "tech.two", version: "2026.07.28", last_seen: "2026-09-20T11:02:00Z" },
    ] };
  },
  _boneyard: [
    { serial: "OLD9DEAD1", device_name: "BGLTRDEADPC01", model: "Latitude 5490", user: "former.user@nucor.com",
      cpu: "i5-8350U", ram: "8 GB", storage: "256 GB", site_tag: "LTR", warranty: "2023-05-01", status: "Boneyard",
      last_checkin: "2025-01-14T09:00:00Z", moved_at: "2026-08-30T10:00:00Z", moved_by: "auto-sync",
      reason: "Not in AD, Entra, or Intune" },
  ],
  async get_inventory() {
    const stock = this._stock.map(r => ({ ...r, status: r.status || "Stock" }));
    return { ok: true, new_stock: stock, in_use: this._use, boneyard: this._boneyard,
      counts: { new_stock: stock.length, in_use: this._use.length, boneyard: this._boneyard.length,
                total: stock.length + this._use.length } };
  },
  async boneyard_sweep() { return { ok: true, added: [], restored: [] }; },  // no-op in mock preview
  _tsEmp: [
    { employid: "40213", first: "Jane", last: "Smith", dept: "Detailing" },
    { employid: "51002", first: "John", last: "Smithson", dept: "Engineering" },
  ],
  _tsWeeks: { "40213": [
    { fiscal_year: 2026, fiscal_week: 37, locked: true }, { fiscal_year: 2026, fiscal_week: 36, locked: true },
    { fiscal_year: 2026, fiscal_week: 35, locked: false }, { fiscal_year: 2026, fiscal_week: 34, locked: true },
    { fiscal_year: 2026, fiscal_week: 33, locked: false }, { fiscal_year: 2026, fiscal_week: 32, locked: false },
    { fiscal_year: 2026, fiscal_week: 31, locked: true }, { fiscal_year: 2026, fiscal_week: 30, locked: false } ] },
  async ts_search(q) {
    q = (q || "").toLowerCase();
    return { ok: true, employees: this._tsEmp.filter(e => e.first.toLowerCase().includes(q) || e.last.toLowerCase().includes(q)) };
  },
  async ts_weeks(employid) { return { ok: true, weeks: (this._tsWeeks[employid] || []).map(w => ({ ...w })) }; },
  async ts_unlock(employid, fy, fw) {
    const wk = (this._tsWeeks[employid] || []).find(w => w.fiscal_year === fy && w.fiscal_week === fw && w.locked);
    if (wk) { wk.locked = false; return { ok: true, affected: 1 }; }
    return { ok: true, affected: 0 };
  },
  async bg_locations() {
    return { ok: true, nbgw_company: "Nucor Buildings Group West",
      divisions: [
        { label: "NBGW — Nucor Buildings Group West", company: "Nucor Buildings Group West" },
        { label: "NBGTX — NBG Terrell", company: "NBG - Terrell" },
        { label: "NBSIN — Waterloo", company: "NBSIN" },
      ],
      locations: [
        { label: "American Buildings", domain: "americanbuildings.com" },
        { label: "CBC Steel Buildings", domain: "cbcsteelbuildings.com" },
      ] };
  },
  async bg_user_search(q, domain, company) {
    q = (q || "").toLowerCase(); domain = (domain || "").toLowerCase(); company = company || "";
    let users = [
      { id: "u1", display: "Padilla, Alberto (NBGW)", upn: "alberto.padilla@nucor.com", dept: "Detailing Dept Lathrop", company: "Nucor Buildings Group West" },
      { id: "u2", display: "Padilla, David (NCSI)", upn: "david.padilla@nucor.com", dept: "IT", company: "Nucor Corporation" },
      { id: "u3", display: "Padilla, Marco (ABG)", upn: "marco.padilla@americanbuildings.com", dept: "Estimating", company: "American Buildings" },
      { id: "u4", display: "Thornton, Stephen (NBGW)", upn: "stephen.thornton@nucor.com", dept: "Detailing Dept Lathrop", company: "Nucor Buildings Group West" },
      { id: "u5", display: "Thornton, Ashley (NBSIN)", upn: "ashley.thornton@nucor.com", dept: "Detailing Dept NBS", company: "NBSIN" },
    ];
    users = users.filter(u => u.display.toLowerCase().includes(q) || q.split(" ").every(t => u.display.toLowerCase().includes(t)));
    if (domain) users = users.filter(u => u.upn.toLowerCase().endsWith("@" + domain));
    if (company) users = users.filter(u => u.company === company);
    return { ok: true, users };
  },
  async perm_discover_departments() {
    await new Promise(r => setTimeout(r, 400));
    return { ok: true, company: "Nucor Buildings Group West", total_users: 589, min_members: 5, departments: [
      { dept: "Fabrication Dept NBS", count: 132, eligible: true }, { dept: "Detailing Dept NBS", count: 80, eligible: true },
      { dept: "Detailing Dept Lathrop", count: 56, eligible: true }, { dept: "Design Dept NBS", count: 29, eligible: true },
      { dept: "Sheeting Dept NBS", count: 2, eligible: false } ] };
  },
  async bg_user_groups(id) {
    const groups = [
      { name: "BG.NBG.SA.Bomsnet.User", direct: true }, { name: "BG.NBG.SA.Bomsnet.MUDIV", direct: true },
      { name: "BG.BRI.SA.BomsNet", direct: false }, { name: "BG.NBG.SA.Bomsnet.EOP_InquiryOnly", direct: false },
      { name: "NBGW IntuneApp.BomsNet", direct: false }, { name: "BG.LTR.Detailing.Users", direct: true },
      { name: "All NBGW Staff", direct: false }, { name: "VPN.Users", direct: true },
      { name: "SharePoint.Systems.Contribute", direct: false }, { name: "Printer.LTR.Floor2", direct: true },
    ].sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, groups, direct_count: groups.filter(g => g.direct).length, total: groups.length };
  },
  _permDoc: {
    keyword: "", threshold: 0.7, company: "Nucor Buildings Group West",
    departments: {
      "Detailing Dept Lathrop": {
        updated: "2026-09-29T09:30:00", total: 56, company: "Nucor Buildings Group West",
        groups: [
          { name: "All NBGW Staff", count: 56, pct: 1, expected: true },
          { name: "BG.BRI.SA.DW.JobFile_Detailing", count: 51, pct: 0.91, expected: true },
          { name: "VPN.Users", count: 56, pct: 1, expected: true },
          { name: "BG.BRI.SA.BomsNet", count: 56, pct: 1, expected: true },
          { name: "BG.NBG.SA.Bomsnet.Detailing_SchDataReader", count: 56, pct: 1, expected: true },
          { name: "BG.NBG.SA.Bomsnet.User", count: 56, pct: 1, expected: true },
          { name: "NBGW IntuneApp.BomsNet", count: 56, pct: 1, expected: true },
          { name: "Printer.LTR.Floor2", count: 53, pct: 0.95, expected: true },
          { name: "BG.NBG.SA.Bomsnet.EOP_InquiryOnly", count: 55, pct: 0.98, expected: true },
          { name: "SharePoint.Detailing.Contribute", count: 41, pct: 0.73, expected: true },
          { name: "BG.NBG.SA.Bomsnet.MUDIV", count: 9, pct: 0.16, expected: false },
          { name: "Adobe.Acrobat.Pro", count: 6, pct: 0.11, expected: false },
        ],
      },
    },
  },
  async perm_get_baselines() { return { ok: true, data: JSON.parse(JSON.stringify(this._permDoc)) }; },
  async perm_save_baselines(data) {
    const seed = this._permDoc.departments && this._permDoc.departments["Detailing Dept Lathrop"];
    if (!this._permTpl && seed) this._permTpl = JSON.parse(JSON.stringify(seed));
    if (data) this._permDoc = JSON.parse(JSON.stringify(data));
    return { ok: true, data: JSON.parse(JSON.stringify(this._permDoc)) };
  },
  async perm_dept_suggest(prefix) {
    prefix = (prefix || "").toLowerCase();
    const all = [{ dept: "Detailing Dept Lathrop", count: 56 }, { dept: "Detailing Dept Brigham", count: 22 },
      { dept: "Engineering Dept Lathrop", count: 31 }, { dept: "Estimating Dept Lathrop", count: 14 }];
    return { ok: true, departments: all.filter(d => d.dept.toLowerCase().startsWith(prefix)) };
  },
  async perm_analyze_dept(dept) {
    await new Promise(r => setTimeout(r, 300));
    // demo template = the seeded Detailing baseline (kept even if a rebuild wiped the doc)
    this._permTpl = this._permTpl || JSON.parse(JSON.stringify(this._permDoc.departments["Detailing Dept Lathrop"]));
    const base = JSON.parse(JSON.stringify(this._permTpl));
    base.updated = new Date().toISOString().slice(0, 19);
    this._permDoc.departments[dept] = base;
    return { ok: true, data: JSON.parse(JSON.stringify(this._permDoc)), department: dept, total: base.total, found: base.groups.length };
  },
  async perm_missing_for_user(id) {
    await new Promise(r => setTimeout(r, 400));
    const CO = "Nucor Buildings Group West";
    const people = (await this.bg_user_search("", "", "")).users;
    const p = people.find(x => x.id === id) || { display: "Aguilar, Claryssa (NBGW)", upn: "claryssa.aguilar@nucor.com", dept: "Detailing Dept Lathrop", company: CO };
    if (p.company !== CO) return { ok: true, user: p, in_scope: false, has_baseline: false, company: CO, keyword: "", dept: p.dept };
    const dept = "Detailing Dept Lathrop", d = this._permDoc.departments[dept];
    const exp = d.groups.filter(g => g.expected);
    const missNames = id === "u4" ? ["BG.BRI.SA.DW.JobFile_Detailing", "SharePoint.Detailing.Contribute"] : [];
    const missing = exp.filter(g => missNames.includes(g.name));
    const present = exp.filter(g => !missNames.includes(g.name));
    return { ok: true, user: { ...p, dept }, in_scope: true, has_baseline: true, company: CO, keyword: "", dept, total: 56, updated: "2026-09-29T09:30:00", missing, present };
  },
  async perm_missing_in_dept(dept) {
    await new Promise(r => setTimeout(r, 500));
    const d = this._permDoc.departments[dept];
    if (!d) return { ok: true, department: dept, has_baseline: false, keyword: "" };
    const exp = d.groups.filter(g => g.expected).map(g => g.name);
    const users = [
      { display: "Aguilar, Claryssa (NBGW)", upn: "claryssa.aguilar@nucor.com", missing: ["BG.NBG.SA.Bomsnet.EOP_InquiryOnly"], missing_count: 1, have_count: exp.length - 1 },
      { display: "Padilla, Marco (ABG)", upn: "marco.padilla@americanbuildings.com", missing: ["SharePoint.Detailing.Contribute"], missing_count: 1, have_count: exp.length - 1 },
      { display: "Padilla, Alberto (NBGW)", upn: "alberto.padilla@nucor.com", missing: [], missing_count: 0, have_count: exp.length },
      { display: "Kungli, Max (NBGW)", upn: "max.kungli@nucor.com", missing: [], missing_count: 0, have_count: exp.length },
    ];
    const summary = exp.map(n => ({ name: n, have: n.includes("EOP") ? 55 : (n.includes("SharePoint") ? 55 : 56), missing: (n.includes("EOP") || n.includes("SharePoint")) ? 1 : 0 }))
      .sort((a, b) => b.missing - a.missing);
    return { ok: true, department: dept, has_baseline: true, keyword: "", total: 56, expected: exp, users, summary, compliant: 54 };
  },
  async restore_boneyard(serial) {
    const i = this._boneyard.findIndex(b => b.serial === serial);
    if (i >= 0) { const rec = this._boneyard.splice(i, 1)[0]; this._stock.unshift({ ...rec, status: "Stock", date_added: new Date().toISOString().slice(0, 10) }); }
    return { ok: true };
  },
  async lookup(manufacturer, serial) {
    await new Promise(r => setTimeout(r, 600));
    serial = (serial || "").trim();
    if (this._stock.some(x => x.serial.toLowerCase() === serial.toLowerCase()))
      return { ok: true, status: "duplicate", where: "New Stock", serial };
    if (this._use.some(x => x.serial.toLowerCase() === serial.toLowerCase()))
      return { ok: true, status: "duplicate", where: "In Use", serial };
    if (manufacturer === "Lenovo")
      return { ok: true, status: "found", serial, manufacturer: "Lenovo",
        model: "X1 Carbon 13th Gen ThinkPad", cpu: "Intel Core Ultra 7 258V", ram: "32 GB", storage: "512 GB",
        vendor_source: "Lenovo API", warranty_end: "2026-10-01" };
    return { ok: true, status: "manual", serial, manufacturer, model: "", cpu: "", ram: "", storage: "", warranty_end: "" };
  },
  async add_machine(p) {
    this._stock.unshift({ serial: p.serial, manufacturer: p.manufacturer, model: p.model, cpu: p.cpu, ram: p.ram,
      storage: p.storage, site_tag: p.site_tag, warranty: p.warranty || "", date_added: new Date().toISOString().slice(0, 10) });
    this._logIt("Added", p.serial, p.model, `Site ${p.site_tag || ""}`.trim());
    return { ok: true, message: `Added ${p.serial} to New Stock.` };
  },
  async assign_machine(serial, user, reason) {
    const i = this._stock.findIndex(x => x.serial === serial);
    if (i < 0) return { ok: false, error: `${serial} is not in New Stock.` };
    const rec = this._stock.splice(i, 1)[0];
    rec.user = user; rec.os_version = rec.os_version || "";
    this._use.unshift(rec);
    this._logIt("Deployed", serial, rec.model, `Assigned to ${user}.` + (reason ? ` Reason: ${reason}` : ""));
    return { ok: true, message: `${serial} deployed to ${user}.` };
  },
  async delete_machine(serial, reason) {
    let model = "", label = "";
    let i = this._stock.findIndex(x => x.serial === serial);
    if (i >= 0) { model = this._stock[i].model; label = "New Stock"; this._stock.splice(i, 1); }
    else { i = this._use.findIndex(x => x.serial === serial); if (i >= 0) { model = this._use[i].model; label = "In Use"; this._use.splice(i, 1); } else return { ok: false, error: "Not found." }; }
    this._logIt("Deleted", serial, model, `Removed from ${label}.` + (reason ? ` Reason: ${reason}` : ""));
    return { ok: true, message: `${serial} removed.` };
  },
  async return_to_stock(serial, reason) {
    const i = this._use.findIndex(x => x.serial === serial);
    if (i < 0) return { ok: false, error: `${serial} is not In Use.` };
    const rec = this._use.splice(i, 1)[0];
    delete rec.user; delete rec.os_version; delete rec.os_install; delete rec.device_name;
    rec.date_added = new Date().toISOString().slice(0, 10);
    this._stock.unshift(rec);
    this._logIt("Returned to Stock", serial, rec.model, "Moved back to New Stock." + (reason ? ` Reason: ${reason}` : ""));
    return { ok: true, message: `${serial} moved back to New Stock.` };
  },
  async open_url_window(url) { window.open(url, "_blank"); return { ok: true }; },
  async open_external(url) { window.open(url, "_blank"); return { ok: true }; },
  async site_navigate(url) { window.open(url, "_blank"); return { ok: true }; },
  async site_back() { return { ok: true }; },
  async get_log() { return { ok: true, entries: this._log }; },
  async set_site(serial, site) { const row = this._stock.find(x => x.serial === serial); if (row) row.site_tag = site; return { ok: true }; },
  async my_site() { return { ok: true, site: "LTR", city: "Lathrop" }; },
  async update_stock(serial, fields) {
    const row = this._stock.find(x => x.serial === serial);
    if (!row) return { ok: false, error: `${serial} is not in New Stock.` };
    if (fields.serial && fields.serial.toLowerCase() !== serial.toLowerCase() &&
        this._stock.concat(this._use).some(x => x.serial.toLowerCase() === fields.serial.toLowerCase()))
      return { ok: false, error: `${fields.serial} already exists.` };
    ["serial", "manufacturer", "model", "cpu", "ram", "storage", "warranty", "site_tag"].forEach(k => { if (fields[k] != null) row[k] = fields[k]; });
    return { ok: true };
  },
  async hub_add_feedback(item) { return { ok: true, id: "fb-mock" }; },
  async run_sync() { await new Promise(r => setTimeout(r, 500)); return { ok: true, moved: [], skipped: this._stock.length, errors: [], refreshed: 0, deduped: 0 }; },
  async enrich_inventory() { await new Promise(r => setTimeout(r, 200)); return { ok: true, enriched: 0, sites: 0, users: 0, remaining: 0 }; },
  async master_sync() { await new Promise(r => setTimeout(r, 300)); return { ok: true, rows: this._use.length, added: 0, updated: 0, counts: { user: 0, checkin: 1, os: 0, storage: 0, specs: 1, mfa: 1 }, errors: [] }; },
  async populate_mfa(force) {
    await new Promise(r => setTimeout(r, 300));
    let filled = 0, yes = 0, no = 0, checked = 0;
    this._use.forEach(x => {
      if (!(x.user || "").trim()) return;
      if (!force && (x.mfa || "").trim()) return;
      checked++;
      const v = /nucor\.com$/i.test(x.user) ? "Yes" : "No";  // demo heuristic
      if (v !== (x.mfa || "")) { x.mfa = v; filled++; v === "Yes" ? yes++ : no++; }
    });
    return { ok: true, checked, filled, yes, no, unresolved: 0, errors: [] };
  },
};

/* ---- app ----------------------------------------------------------------- */
/* ---- data mode: live production vs local snapshot ------------------------ */
const DataMode = {
  info: null,
  async refresh() {
    const r = await Backend.call("get_data_mode");
    const b = document.getElementById("dmBtn");
    if (!r || !r.ok || !b) return;
    this.info = r;
    const local = r.mode === "local";
    b.textContent = local ? "Data: LOCAL copy" : "Data: Live";
    b.classList.toggle("dm-local", local);
  },
  async open() {
    const r = this.info || (await Backend.call("get_data_mode"));
    if (!r || !r.ok) return alert("Could not read data mode.");
    if (r.mode === "local") {
      if (!confirm("Switch back to LIVE production data?")) return;
      const s = await Backend.call("set_data_mode", "live");
      return s.ok ? Resume.reload() : alert(s.error);
    }
    const snap = r.has_snapshot ? (r.snapshot.taken_at || "").replace("T", " ") : "";
    if (r.has_snapshot && confirm("Switch to the LOCAL copy taken " + snap + "?\nWrites stay on this PC; production is not touched.\n\nCancel = pull a fresh copy instead.")) {
      const s = await Backend.call("set_data_mode", "local");
      return s.ok ? Resume.reload() : alert(s.error);
    }
    if (!confirm("Pull a fresh READ-ONLY copy of production into this PC?\n(Replaces the existing local copy and any local changes.)")) return;
    const b = document.getElementById("dmBtn"); if (b) b.textContent = "Data: pulling…";
    const p = await Backend.call("pull_prod_snapshot");
    if (!p.ok) { alert("Pull failed: " + p.error); return this.refresh(); }
    if (confirm("Copy ready. Switch to LOCAL data now?")) {
      const s = await Backend.call("set_data_mode", "local");
      return s.ok ? Resume.reload() : alert(s.error);
    }
    this.refresh();
  },
};

/* ---- divisions (tenants): sites, labels, switcher ------------------------ */
const Divisions = {
  list: [], current: "nbgw",
  // offline/older-backend fallback = NBGW's two sites
  sites: [{ code: "LTR", name: "Lathrop, CA" }, { code: "BRI", name: "Brigham City, UT" }],
  async load() {
    try {
      const r = await Backend.call("get_divisions");
      if (r && r.ok) {
        this.list = r.divisions || []; this.current = r.current;
        const d = this.list.find(x => x.id === this.current);
        // defence in depth: a site code ends up in HTML attributes / CSS classes, so only plain tags are accepted
        if (d) this.sites = (d.sites || []).filter(s => /^[A-Za-z0-9]{2,6}$/.test(String(s.code)));
        this._err = "";
      } else if (r && r.error) {
        this._err = r.error;                     // shown by startup() once the user is signed in
      }
    } catch (e) { /* keep fallback */ }
    App.state.siteTags = this.codes();
    this.applyLabels();
    const sub = document.getElementById("divSub");
    if (sub && this.cur().name) sub.textContent = "Systems";
    this.renderSwitcher();
  },
  /* Static page text that names the division uses <span class="div-label"></span>; fill every slot with the active division. */
  applyLabels() { document.querySelectorAll(".div-label").forEach(el => { el.textContent = this.label(); }); },
  codes() { return this.sites.map(s => String(s.code).toUpperCase()); },
  invKey() { return this.current === "nbgw" ? "nbgw_inv" : "nbg_inv_" + this.current; },
  draftKey() { return this.current === "nbgw" ? "nbgw_hub_draft_v2" : "nbg_hub_draft_v2_" + this.current; },
  cur() { return this.list.find(x => x.id === this.current) || { id: this.current, name: "", company_name: "" }; },
  /* "NBGW - Nucor Buildings Group West" -> "NBGW" (short code form); "NBG - Terrell" stays whole (its first part is not the id) */
  label() {
    const c = this.cur(), n = (c.name || "").trim();
    const first = (n.split(" - ")[0] || "").trim();
    if (first && first.toLowerCase() === String(c.id || "").toLowerCase()) return first;
    return n || "this division";
  },
  /* a site code that belongs to the active division, else "Other" */
  bucket(s) { const u = String(s || "").trim().toUpperCase(); return this.codes().includes(u) ? u : "Other"; },
  /* css class for a site: first two keep the original ltr/bri colours */
  cls(code) { if (code === "Other") return "other"; const i = this.codes().indexOf(code); return i === 0 ? "ltr" : i === 1 ? "bri" : "s" + (i < 0 ? 9 : i); },
  renderSwitcher() {
    const el = document.getElementById("divSwitch");
    if (!el) return;
    const sub = document.getElementById("divSub");
    if (this.list.length < 2) {                 // one division: no dropdown, just its name
      el.classList.add("hidden");
      if (sub) sub.textContent = this.cur().name || "Systems";
      return;
    }
    if (sub) sub.textContent = "Systems";
    el.classList.remove("hidden");
    el.innerHTML = this.list.map(d => `<option value="${attr(d.id)}"${d.id === this.current ? " selected" : ""}>${esc(d.name)}</option>`).join("");
  },
  async switchTo(id) {
    if (!id || id === this.current) return;
    if (Busy.running().length) {                                   // a long job is still running in this division
      App.toast("Wait for this to finish before switching division: " + [...new Set(Busy.running())].join(", ") + ".", true);
      this.renderSwitcher();
      return;
    }
    const r = await Backend.call("switch_division", id);
    if (!r || !r.ok) { App.toast((r && r.error) || "Could not switch division.", true); this.renderSwitcher(); return; }
    Resume.reload();
  },
};

/* ---- Entra type-ahead picker (people or groups) ---------------------------- */
const DirPicker = {
  /* mount(hostId, kind, onPick, placeholder): an input that searches Entra as you type. */
  mount(hostId, kind, onPick, placeholder) {
    const host = document.getElementById(hostId);
    if (!host) return;
    host.innerHTML = `<div class="dp"><input class="dp-in" autocomplete="off" placeholder="${attr(placeholder || (kind === "group" ? "Search groups…" : "Search people (name or sign-in)…"))}"><div class="dp-list hidden"></div></div>`;
    const inp = host.querySelector(".dp-in"), list = host.querySelector(".dp-list");
    let timer = null, seq = 0, items = [];
    const hide = () => list.classList.add("hidden");
    const run = async () => {
      const q = inp.value.trim(), my = ++seq;
      if (q.length < 2) return hide();
      const r = await Backend.call("user_lookup", q, kind);
      if (my !== seq) return;                       // a newer keystroke superseded this answer
      items = (r && r.ok && r.results) || [];
      list.innerHTML = items.length
        ? items.map((x, i) => `<div class="dp-item" data-i="${i}"><b>${esc(x.name || x.upn)}</b><span>${esc(x.kind === "group" ? (x.detail || "group") : x.kind === "company" ? (x.detail || "") : ((x.upn || "") + (x.detail ? " · " + x.detail : "")))}</span></div>`).join("")
        : `<div class="dp-none">No match</div>`;
      list.classList.remove("hidden");
    };
    inp.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 250); });
    inp.addEventListener("blur", () => setTimeout(hide, 180));
    list.addEventListener("mousedown", e => {
      const el = e.target.closest(".dp-item");
      if (!el) return;
      e.preventDefault();
      const it = items[+el.dataset.i];
      inp.value = ""; hide();
      if (it) onPick(it);
    });
  },
};

/* Searchable filter dropdowns. The real <select class="filt"> stays (hidden) as the source of truth, so every existing
   `select.value = ...` and onchange keeps working; a small type-to-filter box is shown in its place. */
const Filt = {
  enhance(sel) {
    if (!sel || sel.dataset.enh) return;
    sel.dataset.enh = "1"; sel.classList.add("enh");
    const w = document.createElement("span"); w.className = "fsel";
    w.innerHTML = `<input class="fsel-in" autocomplete="off" spellcheck="false"><span class="fsel-caret">▾</span><div class="fsel-list hidden"></div>`;
    sel.after(w);
    const inp = w.querySelector("input"), list = w.querySelector(".fsel-list");
    let shown = [];
    const label = () => (sel.options[sel.selectedIndex] || {}).text || "";
    const sync = () => { inp.value = label(); w.classList.toggle("on", !!sel.value); };
    sel._sync = sync;
    const draw = q => {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      shown = [...sel.options].filter(o => words.every(x => o.text.toLowerCase().includes(x)));
      list.innerHTML = shown.length ? shown.map((o, n) => `<div class="fsel-item${o.value === sel.value ? " sel" : ""}" data-n="${n}">${esc(o.text)}</div>`).join("") : `<div class="fsel-none">No match</div>`;
      list.classList.remove("hidden");
    };
    const close = () => { list.classList.add("hidden"); sync(); };
    const pick = o => { sel.value = o.value; sel.dispatchEvent(new Event("change")); close(); inp.blur(); };
    inp.addEventListener("focus", () => { inp.select(); draw(""); });
    inp.addEventListener("input", () => draw(inp.value.trim()));
    inp.addEventListener("keydown", e => {
      if (e.key === "Enter" && shown.length && !list.classList.contains("hidden")) { e.preventDefault(); pick(shown[0]); }
      else if (e.key === "Escape") { close(); inp.blur(); }
    });
    inp.addEventListener("blur", () => setTimeout(close, 160));
    list.addEventListener("mousedown", e => { const el = e.target.closest(".fsel-item"); if (!el) return; e.preventDefault(); pick(shown[+el.dataset.n]); });
    sync();
  },
  enhanceAll() { document.querySelectorAll("select.filt").forEach(s => this.enhance(s)); },
  syncAll() { document.querySelectorAll("select.filt.enh").forEach(s => { if (s._sync) s._sync(); }); },
};

/* Deploy and manufacture dates (a small hub document per division, keyed by serial), shown as extra fields on every device row. */
const DeviceDates = {
  map: {},
  apply(...lists) {
    lists.forEach(l => (l || []).forEach(x => { const d = this.map[(x.serial || "").toLowerCase()] || {}; x.deploy_date = d.deploy || ""; x.mfg_date = d.mfg || ""; }));
  },
  async overlay(...lists) {
    try { const r = await Backend.call("device_dates_get"); this.map = (r && r.ok && r.data) || {}; } catch (e) { this.map = {}; }
    this.apply(...lists);
  },
  async set(serials, deploy, mfg) {
    const r = await Backend.call("device_dates_set", serials, deploy, mfg);
    if (r && r.ok) { this.map = r.data || {}; this.apply(App.state.stock, App.state.use, App.state.boneyard); }
    return r;
  },
};

/* Searchable pick list: type to filter (every word must appear somewhere in the option), click or Enter to pick.
   Keeps the chosen value in a hidden input with id `valueId`, so older code can read it like a <select>. */
const Combo = {
  mount(hostId, valueId, items, value, onChange) {
    const host = document.getElementById(hostId);
    if (!host) return;
    const find = v => items.find(i => i.value === v) || items[0];
    let cur = find(value), shown = [];
    host.innerHTML = `<div class="dp"><input class="dp-in" autocomplete="off" spellcheck="false"><input type="hidden" id="${attr(valueId)}"><div class="dp-list hidden"></div></div>`;
    const inp = host.querySelector(".dp-in"), hid = host.querySelector("input[type=hidden]"), list = host.querySelector(".dp-list");
    const set = it => { cur = it; hid.value = it.value; inp.value = it.label; };
    set(cur);
    const draw = q => {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      shown = items.filter(i => words.every(w => (i.label + " " + (i.group || "")).toLowerCase().includes(w)));
      let last = null;
      list.innerHTML = shown.length ? shown.map((i, n) => {
        const head = i.group && i.group !== last ? `<div class="dp-grp">${esc(i.group)}</div>` : ""; last = i.group;
        return head + `<div class="dp-item${i === cur ? " sel" : ""}" data-n="${n}"><b>${esc(i.label)}</b></div>`;
      }).join("") : `<div class="dp-none">No match</div>`;
      list.classList.remove("hidden");
    };
    const pick = it => { set(it); list.classList.add("hidden"); if (onChange) onChange(it); };
    inp.addEventListener("focus", () => { inp.select(); draw(""); });
    inp.addEventListener("input", () => draw(inp.value.trim()));
    inp.addEventListener("keydown", e => { if (e.key === "Enter" && shown.length && !list.classList.contains("hidden")) { e.preventDefault(); e.stopPropagation(); pick(shown[0]); } });
    inp.addEventListener("blur", () => setTimeout(() => { list.classList.add("hidden"); inp.value = cur.label; }, 180));
    list.addEventListener("mousedown", e => { const el = e.target.closest(".dp-item"); if (!el) return; e.preventDefault(); pick(shown[+el.dataset.n]); });
  },
};

const App = {
  state: {
    tab: "stock", stock: [], use: [], boneyard: [], account: null, siteTags: ["LTR", "BRI"],
    sort: { stock: { key: "date_added", dir: -1 }, use: { key: "serial", dir: 1 }, boneyard: { key: "moved_at", dir: -1 } },
    expanded: new Set(),
    userFilter: null,                            // Set of lower-case user names, from the Teammates page ("Show devices")
    sel: new Set(),                              // serials ticked for a bulk action (only ever the rows currently shown)
  },

  async init(real, st0) {
    Backend.real = real;
    this.loadVersion();
    if (!Divisions.list.length) await Divisions.load();
    DataMode.refresh();
    Settings.refreshAccess();
    await Tz.load();
    Filt.enhanceAll();
    document.getElementById("tableWrap").addEventListener("change", e => {
      const t = e.target;
      if (t.id === "selAll") App.selAll(t.checked);
      else if (t.classList && t.classList.contains("rowsel")) App.selToggle(t.dataset.serial, t.checked);
    });
    document.getElementById("tableWrap").addEventListener("click", e => {
      const ua = e.target.closest("a.sw-user");
      if (ua) { App.userSoftware(ua.dataset.user); return; }
      const b = e.target.closest("button[data-action]");
      if (!b) {                                   // a click on the row itself opens / closes its details
        if (e.target.closest("button,select,a,input,label,textarea,.detailcell")) return;
        const eb = e.target.closest("tr") && e.target.closest("tr").querySelector('button[data-action="expand"]');
        if (eb) App.toggleExpand(eb.dataset.serial);
        return;
      }
      if (b.dataset.action === "remove") DeleteView.open(b.dataset.serial);
      else if (b.dataset.action === "expand") App.toggleExpand(b.dataset.serial);
      else if (b.dataset.action === "upgrade") Upgrade.addPrompt(b.dataset.serial);
      else if (b.dataset.action === "editspecs") Specs.open(b.dataset.serial);
      else if (b.dataset.action === "editstock") App.editStock(b.dataset.serial);
      else if (b.dataset.action === "restoreboneyard") App.restoreBoneyard(b.dataset.serial);
      else if (b.dataset.action === "deploy") App.deployPrompt(b.dataset.serial);
    });
    const st = st0 || await Backend.call("get_status");
    if (st && st.signed_in) {
      this.state.account = st.account; this.state.upn = st.upn || "";
      document.getElementById("acct").textContent = st.account || "Signed in";
      document.getElementById("signout").classList.remove("hidden");
      await this.startup();
    } else {
      this.showSignedOut();
    }
  },

  /* Nobody signed in: hide the pages, show a clear Sign in screen and a Sign in button in the sidebar. */
  showSignedOut(why) {
    document.body.classList.add("signed-out");
    document.getElementById("signinBtn").classList.remove("hidden");
    document.getElementById("signout").classList.add("hidden");
    document.getElementById("acct").textContent = "Not signed in";
    const e = document.getElementById("gateErr"); if (e) e.textContent = why || "";
    this.setBusy(true);
  },

  async startup() {
    // The first division read can run before sign-in finished (empty list, blank name): redo it now that we are signed in.
    if (!Divisions.list.length) {
      const before = Divisions.current;
      await Divisions.load();
      if (Divisions.list.length && Divisions.current !== before) { location.reload(); return; }   // data painted for the wrong division: start over
      if (!Divisions.list.length) { await new Promise(r => setTimeout(r, 1500)); await Divisions.load(); }
      await Tz.load(); Settings.refreshAccess();
      if (!Divisions.list.length && Divisions._err) this.toast("Divisions: " + Divisions._err, true);
    }
    this.checkUpdate();
    this.renderCached();       // 1) instant: show last-known data from local cache
    await this.reload();       // 2) fast: re-read the SharePoint lists and repaint
    SyncLine.refresh();
    // 3) background: Intune sync (moves + backfill). Deferred a few seconds so it
    // doesn't hammer Graph alongside the dashboard/devices reads during first paint.
    const fl = await Backend.call("get_flags");
    if (!fl || fl.auto_sync !== false) setTimeout(() => this.backgroundSync(), 4000);
    else { const b = document.getElementById("syncBtn"); if (b) b.title = "Auto-sync is off (NBG_NO_AUTOSYNC / config auto_sync=false). Click to sync."; }
  },

  /* newer build available / current build too old (versions are set under Settings > Integrations & options) */
  async checkUpdate() {
    try {
      const r = await Backend.call("get_update_info");
      if (!r || !r.ok || !(r.update_available || r.update_required)) return;
      const el = document.getElementById("verLine");
      if (el) { el.style.color = r.update_required ? "var(--red)" : "var(--amber)"; el.title = (r.update_required ? "Update required: this build is older than " + r.min : "Update available: " + r.latest) + ". Ask your admin for the new installer."; }
      this.toast(r.update_required ? "NBG Hub update required (this build is older than " + r.min + ")." : "NBG Hub update available: " + r.latest + ".", !!r.update_required);
    } catch (e) {}
  },

  renderCached() {
    try {
      const c = JSON.parse(localStorage.getItem(Divisions.invKey()) || "null");
      if (!c) return;
      this.state.stock = c.new_stock || [];
      this.state.use = c.in_use || [];
      this.state.boneyard = c.boneyard || [];
      const cnt = c.counts || { new_stock: this.state.stock.length, in_use: this.state.use.length, total: 0 };
      this.setCounts(cnt);
      this.render();
    } catch (e) { /* ignore bad cache */ }
  },

  backgroundSync() {
    const btn = document.getElementById("syncBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Refreshing…"; }
    Backend.call("run_sync").then(async (r) => {
      if (r && r.locked) this.toast("Another sync is already running" + (r.locked.by ? " (" + r.locked.by + ")" : "") + ", so this one was skipped.");
      if (r && r.ok) {
        const changed = (r.moved || []).length || r.refreshed || r.deduped;
        await this.reload();   // show the fleet first (fast)
        if (changed) this.toast(`Synced with Intune: ${(r.moved || []).length} added, ${r.refreshed || 0} updated`
          + (r.deduped ? `, ${r.deduped} duplicate row(s) cleaned up` : "") + ".");
      }
      if (btn) btn.textContent = "Enriching…";
      return Backend.call("enrich_inventory");   // then fill Lenovo specs/warranty (bounded)
    }).then(async (e) => {
      if (e && e.ok && (e.enriched || e.sites || e.users)) {
        await this.reload();
        const parts = [];
        if (e.users) parts.push(`user on ${e.users}`);
        if (e.sites) parts.push(`site on ${e.sites}`);
        if (e.enriched) parts.push(`specs on ${e.enriched}`);
        this.toast(`Filled ${parts.join(", ")} device(s)${e.remaining ? `, ${e.remaining} specs to go` : ""}.`);
      }
    }).catch(() => {}).finally(() => {
      if (btn) { btn.disabled = false; btn.textContent = "↻ Sync now"; }
      SyncLine.refresh();
      this.boneyardSweep();   // auto-retire devices gone from AD+Entra+Intune
    });
  },

  // Auto-retire devices confirmed gone from AD + Entra + Intune into the Boneyard,
  // and self-heal any that came back. Safe no-op when off-network or a check is
  // unavailable (the backend skips). Runs quietly after each sync.
  async boneyardSweep() {
    try {
      const r = await Backend.call("boneyard_sweep");
      if (!r || !r.ok) return;
      const moved = (r.added || []).length, back = (r.restored || []).length;
      if (moved || back) {
        await this.reload();
        const bits = [];
        if (moved) bits.push(`${moved} retired to Boneyard`);
        if (back) bits.push(`${back} restored from Boneyard`);
        this.toast(bits.join(" · ") + ".");
      }
    } catch (e) { /* never block the UI on the sweep */ }
  },

  setCounts(c) {
    document.getElementById("cStock").textContent = c.new_stock;
    document.getElementById("cUse").textContent = c.in_use;
    document.getElementById("cTotal").textContent = c.total;
    document.getElementById("tStock").textContent = c.new_stock;
    document.getElementById("tUse").textContent = c.in_use;
    const tb = document.getElementById("tBone"); if (tb) tb.textContent = c.boneyard || 0;
  },

  setBusy(b) {
    const ab = document.getElementById("addBtn");   // now a tile (div), toggle a class
    if (ab) ab.classList.toggle("busy", b);
    document.getElementById("syncBtn").disabled = b;
    const ms = document.getElementById("masterSyncBtn");
    if (ms) ms.disabled = b;
    const mb = document.getElementById("mfaBtn");
    if (mb) mb.disabled = b;
  },

  async signIn(btn) {
    btn = btn || document.getElementById("gateBtn");
    const ok = await Ui.working(btn, "Waiting for the Microsoft sign-in window…", async () => {
      const r = await Backend.call("sign_in");
      if (!r || !r.ok) {
        const msg = (r && r.error) || "Sign-in did not finish.";
        const e = document.getElementById("gateErr"); if (e) e.textContent = msg;
        this.toast(msg, true);
        return false;
      }
      return true;
    });
    if (ok) Resume.reload();                 // everything starts again as the signed-in user, on the same page
  },


  async signOut() {
    await Backend.call("sign_out");
    location.reload();
  },

  // Record this machine's version to the shared hub and show it in the sidebar.
  async loadVersion() {
    try {
      const r = await Backend.call("register_client");
      const el = document.getElementById("verLine");
      if (el) el.textContent = "v" + ((r && r.version) || "?");
    } catch (e) { /* offline / no hub */ }
  },
  showClients() {
    Backend.call("get_clients").then(r => {
      const list = (r && r.ok && r.clients) || [];
      const rows = list.length
        ? list.map(c => `<tr><td class="mono">${esc(c.machine || "—")}</td><td>${esc(c.user || "—")}</td><td>${esc(c.version || "?")}</td><td>${esc((c.last_seen || "").slice(0, 16).replace("T", " "))}</td></tr>`).join("")
        : `<tr><td colspan="4" class="muted" style="padding:10px">No clients recorded yet.</td></tr>`;
      document.getElementById("modalRoot").innerHTML =
        `<div class="overlay"><div class="modal" style="width:660px;max-width:94vw;">
          <div class="modal-head"><h3>Versions in use — ${list.length} machine${list.length === 1 ? "" : "s"}</h3><button onclick="App._closeModal()">&times;</button></div>
          <div class="modal-body"><table class="drill-tbl"><colgroup><col style="width:28%"><col style="width:30%"><col style="width:16%"><col style="width:26%"></colgroup>
            <thead><tr><th>Machine</th><th>User</th><th>Version</th><th>Last seen</th></tr></thead><tbody>${rows}</tbody></table></div>
        </div></div>`;
    });
  },

  async reload() {
    const inv = await Backend.call("get_inventory");
    if (!inv || !inv.ok) return this.error((inv && inv.error) || "Could not load inventory.");
    document.getElementById("errBanner").classList.add("hidden");
    this.state.stock = inv.new_stock || [];
    this.state.use = inv.in_use || [];
    this.state.boneyard = inv.boneyard || [];
    await People.overlay(this.state.use);
    await DeviceDates.overlay(this.state.stock, this.state.use, this.state.boneyard);
    this.setCounts(inv.counts);
    try { localStorage.setItem(Divisions.invKey(), JSON.stringify(inv)); } catch (e) { /* quota */ }
    this.setBusy(false);
    this.populateFilters();
    this.render();
  },

  _closeModal() { document.getElementById("modalRoot").innerHTML = ""; },
  // Move an In Use device back to In Stock (clears its assigned user). Confirm first.
  moveToStock(serial) {
    const r = (this.state.use || []).find(x => x.serial === serial) || { serial };
    const name = r.device_name || serial;
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal" style="width:460px;max-width:94vw;">
        <div class="modal-head"><h3>Move to In Stock</h3><button onclick="App._closeModal()">&times;</button></div>
        <div class="modal-body"><p style="margin:0">Move <b>${esc(name)}</b> back to <b>In Stock</b>? This clears its assigned user in the inventory.</p></div>
        <div class="modal-foot"><button class="ghost" onclick="App._closeModal()">Cancel</button>
          <button class="primary" onclick="App._doMoveToStock('${attr(serial)}')">Move to In Stock</button></div>
      </div></div>`;
  },
  async _doMoveToStock(serial) {
    const r = await Backend.call("return_to_stock", serial, "Moved to stock from In Use");
    if (!r || !r.ok) return this.toast((r && r.error) || "Move failed.", true);
    this._closeModal();
    this.toast(r.message || "Moved to In Stock.");
    await this.reload();
  },
  restoreBoneyard(serial) {
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal" style="width:470px;max-width:94vw;">
        <div class="modal-head"><h3>Restore from Boneyard</h3><button onclick="App._closeModal()">&times;</button></div>
        <div class="modal-body"><p style="margin:0">Bring <b>${esc(serial)}</b> back to <b>In Stock</b>? Its status flips to Stock; the next sync will move it to In Use if it has a user.</p></div>
        <div class="modal-foot"><button class="ghost" onclick="App._closeModal()">Cancel</button>
          <button class="primary" onclick="App._doRestoreBoneyard('${attr(serial)}')">Restore</button></div>
      </div></div>`;
  },
  async _doRestoreBoneyard(serial) {
    const r = await Backend.call("restore_boneyard", serial);
    if (!r || !r.ok) return this.toast((r && r.error) || "Restore failed.", true);
    this._closeModal(); this.toast("Restored to Stock."); await this.reload();
  },

  showTab(t) {
    if (this.state.tab !== t) this.state.sel.clear();
    this.state.tab = t;
    document.querySelectorAll(".tab").forEach(el => el.classList.toggle("active", el.dataset.tab === t));
    if (t === "use") this.populateFilters();
    this.render();
  },

  // Model / CPU / RAM filter dropdowns for the In use tab, built from the data present.
  populateFilters() {
    const fill = (id, label, vals) => {
      const sel = document.getElementById(id); if (!sel) return;
      const cur = sel.value;
      const opts = [...new Set(vals.map(v => (v || "").trim()).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
      sel.innerHTML = `<option value="">${label}</option>` + opts.map(v => `<option>${esc(v)}</option>`).join("");
      if (cur && opts.includes(cur)) sel.value = cur;
    };
    fill("fModel", "All models", this.state.use.map(r => r.model));
    fill("fCpu", "All CPUs", this.state.use.map(r => r.cpu));
    fill("fRam", "All RAM", this.state.use.map(r => r.ram));
    setTimeout(() => this._applyPendingFilters(true), 0);   // saved dropdown choices can be applied now that the options exist
    fill("fMfr", "All manufacturers", [].concat(this.state.stock, this.state.use, this.state.boneyard || []).map(r => this.mfrName(r.manufacturer)));
    fill("fSite", "All sites", [].concat(this.state.siteTags || [], this.state.stock.map(r => r.site_tag), this.state.use.map(r => r.site_tag), (this.state.boneyard || []).map(r => r.site_tag)));
  },
  /* "Dell Inc." and "Dell" are one manufacturer for filtering */
  mfrName(m) {
    const s = String(m || "").trim(); if (!s) return "";
    const l = s.toLowerCase();
    if (/^hewlett|^hp/.test(l)) return "HP";
    if (/^dell/.test(l)) return "Dell";
    if (/^lenovo/.test(l)) return "Lenovo";
    if (/^microsoft/.test(l)) return "Microsoft";
    if (/^apple/.test(l)) return "Apple";
    const w = s.split(/[\s,]+/)[0].replace(/[.,]+$/, "");
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  },
  async setDate(serial, which, value) {
    const r = await DeviceDates.set([serial], which === "deploy" ? value : null, which === "mfg" ? value : null);
    if (!r || !r.ok) { this.toast((r && r.error) || "Could not save the date.", true); return this.render(); }
    this.toast(value ? `${which === "deploy" ? "Deploy" : "Manufacture"} date saved for ${serial}.` : "Date cleared.");
    this.render();
  },
  /* the quick "Deploy" button on the In stock list */
  deployPrompt(serial) {
    const r = (this.state.stock || []).find(x => x.serial === serial) || (this.state.use || []).find(x => x.serial === serial) || { serial };
    const today = new Date().toISOString().slice(0, 10);
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal" style="width:440px;max-width:94vw">
        <div class="modal-head"><h3>Mark as deployed</h3><button onclick="App._closeModal()">&times;</button></div>
        <div class="modal-body">
          <p style="margin:0 0 10px"><span class="mono">${esc(r.serial)}</span> ${esc(r.model || "")}</p>
          <div class="field"><label>Deploy date</label><input type="date" id="dpDate" value="${attr(r.deploy_date || today)}" max="${today}"></div>
          <p class="sub-note" style="margin:8px 0 0">This records the date only. The machine moves to In use when it checks in with a user.</p>
        </div>
        <div class="modal-foot"><button class="ghost" onclick="App._closeModal()">Cancel</button><button class="primary" id="dpGo" onclick="App._doDeploy('${attr(r.serial)}', this)">Mark deployed</button></div>
      </div></div>`;
  },
  async _doDeploy(serial, btn) {
    const d = (document.getElementById("dpDate") || {}).value || "";
    if (!d) return this.toast("Choose a date.", true);
    let r; await Ui.working(btn, "Saving…", async () => { r = await DeviceDates.set([serial], d, null); return false; });
    if (!r || !r.ok) return this.toast((r && r.error) || "Could not save.", true);
    this._closeModal(); this.toast(`${serial} marked deployed on ${d}.`); this.render();
  },
  clearUserFilter() { this.state.userFilter = null; this.render(); },
  clearFilters() {
    this.state.userFilter = null;
    ["fModel", "fCpu", "fRam", "fCheckin", "fMfa", "fSite", "fMfr", "fWarr", "fAge"].forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
    const s = document.getElementById("search"); if (s) s.value = "";
    this.render();
  },
  /* the "More" menu keeps the heavy, rarely used tools out of the way */
  toggleMore(ev) {
    if (ev) ev.stopPropagation();
    const m = document.getElementById("devMore"); if (!m) return;
    m.classList.toggle("hidden");
    if (!this._moreBound) { this._moreBound = true; document.addEventListener("click", () => this.closeMore()); }
  },
  closeMore() { const m = document.getElementById("devMore"); if (m) m.classList.add("hidden"); },
  /* from a device row: everything the assigned person has installed (Software page, people search) */
  userSoftware(user) {
    if (!user) return;
    const el = document.getElementById("swSearch"); if (el) el.value = user;
    Software._mode = "people";
    Nav.go("software");
  },
  _count(rows, total) {
    this._shown = rows;
    const el = document.getElementById("devCount");
    if (el) el.textContent = rows.length === total ? `${total} ${total === 1 ? "device" : "devices"}` : `Showing ${rows.length} of ${total}`;
    const q = (document.getElementById("search") || {}).value;
    const uf = this.state.userFilter, chip = document.getElementById("ufChip");
    if (chip) { chip.classList.toggle("hidden", !uf); chip.innerHTML = uf ? `Teammates: ${uf.size} <a onclick="App.clearUserFilter()" title="Show everyone again">&times;</a>` : ""; }
    const any = !!uf || !!(q && q.trim()) || ["fModel", "fCpu", "fRam", "fCheckin", "fMfa", "fSite", "fMfr", "fWarr", "fAge"].some(id => { const e = document.getElementById(id); return e && e.value && !e.classList.contains("hidden"); });
    const c = document.getElementById("fClear"); if (c) c.classList.toggle("hidden", !any);
  },
  /* ---- bulk select ---- */
  _decorateSel() {
    const shown = new Set((this._shown || []).map(r => r.serial));
    [...this.state.sel].forEach(s => { if (!shown.has(s)) this.state.sel.delete(s); });      // never act on rows that are filtered out
    const t = document.querySelector("#tableWrap table");
    if (t) {
      const col = t.querySelector("colgroup col"); if (col) col.style.width = "78px";
      const hth = t.querySelector("thead th");
      if (hth) hth.innerHTML = `<input type="checkbox" id="selAll" title="Select every row shown" ${shown.size && this.state.sel.size === shown.size ? "checked" : ""}>`;
      t.querySelectorAll("tbody tr").forEach(tr => {
        const eb = tr.querySelector('button[data-action="expand"]'); if (!eb) return;
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.className = "rowsel"; cb.dataset.serial = eb.dataset.serial; cb.checked = this.state.sel.has(eb.dataset.serial);
        eb.parentElement.style.whiteSpace = "nowrap"; eb.parentElement.insertBefore(cb, eb);
      });
    }
    this.updateBulk();
  },
  selToggle(serial, on) { if (on) this.state.sel.add(serial); else this.state.sel.delete(serial); this._syncSelAll(); this.updateBulk(); },
  selAll(on) {
    this.state.sel.clear();
    if (on) (this._shown || []).forEach(r => this.state.sel.add(r.serial));
    document.querySelectorAll("#tableWrap .rowsel").forEach(cb => { cb.checked = on; });
    this.updateBulk();
  },
  _syncSelAll() { const a = document.getElementById("selAll"); if (a) a.checked = !!(this._shown || []).length && this.state.sel.size === this._shown.length; },
  updateBulk() {
    const bar = document.getElementById("bulkBar"); if (!bar) return;
    const n = this.state.sel.size, tab = this.state.tab;
    if (!n) { bar.classList.add("hidden"); bar.innerHTML = ""; return; }
    const b = (kind, label, cls) => `<button class="rowbtn${cls ? " " + cls : ""}" onclick="Bulk.open('${kind}')">${label}</button>`;
    const actions = tab === "stock" ? b("deploy", "🚀 Mark deployed…") + b("mfgdate", "Set manufacture date…") + b("site", "Set site…") + b("remove", "Remove…", "danger")
      : tab === "use" ? b("deploy", "🚀 Set deploy date…") + b("mfgdate", "Set manufacture date…") + b("upgrade", "⬆ Add to upgrade list…") + b("tostock", "📦 Move to In Stock…") + b("remove", "Remove…", "danger")
      : b("restore", "↩ Restore to Stock…");
    bar.classList.remove("hidden");
    bar.innerHTML = `<b>${n} selected</b><span class="bulk-actions">${actions}</span><a class="bulk-clear" onclick="App.selAll(false)">Clear selection</a>`;
  },

  /* ---- remember the Devices view (tab, search, filters, sort) for each division ---- */
  _viewKey() { return "nbg_dev_view_" + (Divisions.current || "x"); },
  _FILTER_IDS: ["fModel", "fCpu", "fRam", "fCheckin", "fMfa", "fSite", "fMfr", "fWarr", "fAge"],
  _restoreView() {
    const key = this._viewKey();
    if (this._restored === key) return;
    this._restored = key;
    let v = null; try { v = JSON.parse(localStorage.getItem(key) || "null"); } catch (e) { v = null; }
    if (!v) return;
    if (["stock", "use", "boneyard"].includes(v.tab)) {
      this.state.tab = v.tab;
      document.querySelectorAll(".tab").forEach(el => el.classList.toggle("active", el.dataset.tab === v.tab));
    }
    const s = document.getElementById("search"); if (s && typeof v.q === "string") s.value = v.q;
    if (v.sort) ["stock", "use", "boneyard"].forEach(t => { const x = v.sort[t]; if (x && typeof x.key === "string" && (x.dir === 1 || x.dir === -1)) this.state.sort[t] = { key: x.key, dir: x.dir }; });
    this._pendingF = v.f || null;                // dropdown options may not exist yet; applied by populateFilters
    this._applyPendingFilters();
  },
  _applyPendingFilters(final) {
    const f = this._pendingF; if (!f) return;
    this._FILTER_IDS.forEach(id => { const el = document.getElementById(id); if (el && f[id] && [...el.options].some(o => o.value === f[id])) el.value = f[id]; });
    if (final) this._pendingF = null;
  },
  _saveView() {
    if (this._pendingF) return;                  // do not overwrite the saved view before it has been applied
    const f = {}; this._FILTER_IDS.forEach(id => { const el = document.getElementById(id); if (el && el.value) f[id] = el.value; });
    try { localStorage.setItem(this._viewKey(), JSON.stringify({ tab: this.state.tab, q: (document.getElementById("search") || {}).value || "", f, sort: this.state.sort })); } catch (e) { /* private window */ }
  },

  copyList() {
    const rows = this._shown || [], tab = this.state.tab, day = v => (v || "").slice(0, 10);
    const cols = {
      stock: [["Serial", r => r.serial], ["Manufacturer", r => r.manufacturer], ["Model", r => r.model], ["CPU", r => r.cpu], ["RAM", r => r.ram], ["Storage", r => r.storage], ["Site", r => r.site_tag], ["Warranty", r => day(r.warranty)], ["Added", r => day(r.date_added)], ["Deployed", r => r.deploy_date], ["Manufactured", r => r.mfg_date]],
      use: [["Serial", r => r.serial], ["Device", r => r.device_name], ["User", r => r.user], ["Manufacturer", r => r.manufacturer], ["Model", r => r.model], ["CPU", r => r.cpu], ["RAM", r => r.ram], ["Storage", r => r.storage], ["MFA", r => r.mfa], ["Site", r => r.site_tag], ["Warranty", r => day(r.warranty)], ["Deployed", r => r.deploy_date], ["Manufactured", r => r.mfg_date], ["Last check-in", r => day(r.last_checkin)], ["OS", r => winOsLabel(r.os_version)]],
      boneyard: [["Serial", r => r.serial], ["Former hostname", r => r.device_name], ["Model", r => r.model], ["Last user", r => r.user], ["Retired", r => day(r.moved_at)], ["Reason", r => r.reason]],
    }[tab] || [];
    const cell = v => String(v == null ? "" : v).replace(/[\t\r\n]+/g, " ");
    const txt = [cols.map(c => c[0]).join("\t")].concat(rows.map(r => cols.map(c => cell(c[1](r))).join("\t"))).join("\n");
    const done = () => this.toast(`Copied ${rows.length} row${rows.length === 1 ? "" : "s"}. Paste into Excel or a message.`);
    const fallback = () => { const t = document.createElement("textarea"); t.value = txt; document.body.appendChild(t); t.select(); try { document.execCommand("copy"); done(); } catch (e) { this.toast("Could not copy.", true); } t.remove(); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, fallback); else fallback();
  },

  sortBy(key) {
    const s = this.state.sort[this.state.tab];
    if (s.key === key) s.dir = -s.dir; else { s.key = key; s.dir = 1; }
    this.render();
  },

  toggleExpand(serial) {
    if (this.state.expanded.has(serial)) this.state.expanded.delete(serial);
    else this.state.expanded.add(serial);
    this.render();
  },

  async setSite(serial, site) {
    const r = await Backend.call("set_site", serial, site);
    if (!r || !r.ok) return this.error((r && r.error) || "Could not update site.");
    const row = this.state.stock.find(x => x.serial === serial);
    if (row) row.site_tag = site;
    this.toast(`${serial} site set to ${site}.`);
    this.render();
  },

  // Edit an in-stock device (fix a mistake). Opens a modal of editable fields.
  editStock(serial) {
    const r = (this.state.stock || []).find(x => x.serial === serial);
    if (!r) return this.error("Device not found — refresh.");
    const fld = (id, label, val, ph) => `<div class="field"><label>${esc(label)}</label>` +
      `<input id="${id}" value="${attr(val || "")}" placeholder="${attr(ph || "")}" autocomplete="off"></div>`;
    const opts = this.state.siteTags.slice();
    if (r.site_tag && !opts.includes(r.site_tag)) opts.unshift(r.site_tag);
    const siteOpts = opts.map(t => `<option${t === r.site_tag ? " selected" : ""}>${esc(t)}</option>`).join("");
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal" style="width:600px;max-width:94vw;">
        <div class="modal-head"><h3>Edit device</h3><button onclick="Drill.close()">&times;</button></div>
        <div class="modal-body">
          <div class="fields">${fld("es_serial", "Serial number", r.serial)}${fld("es_mfr", "Manufacturer", r.manufacturer)}</div>
          <div class="fields" style="margin-top:12px">${fld("es_model", "Model", r.model)}
            <div class="field"><label>Site</label><select id="es_site">${siteOpts}</select></div></div>
          <div class="fields" style="margin-top:12px">${fld("es_cpu", "CPU", r.cpu)}${fld("es_ram", "RAM", r.ram)}</div>
          <div class="fields" style="margin-top:12px">${fld("es_storage", "Storage", r.storage)}${fld("es_warranty", "Warranty", r.warranty, "YYYY-MM-DD")}</div>
          <div class="up-actions">
            <button class="ghost" onclick="Drill.close()">Cancel</button>
            <button class="primary" onclick="App._saveStockEdit('${attr(serial)}')">Save changes</button>
          </div>
        </div>
      </div></div>`;
    setTimeout(() => { const el = document.getElementById("es_model"); if (el) el.focus(); }, 30);
  },
  async _saveStockEdit(oldSerial) {
    const v = id => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };
    const fields = {
      serial: v("es_serial"), manufacturer: v("es_mfr"), model: v("es_model"),
      cpu: v("es_cpu"), ram: v("es_ram"), storage: v("es_storage"),
      warranty: v("es_warranty"), site_tag: document.getElementById("es_site").value,
    };
    if (!fields.serial) { const i = document.getElementById("es_serial"); if (i) i.classList.add("req-missing"); return this.error("Serial can't be blank."); }
    const r = await Backend.call("update_stock", oldSerial, fields);
    if (!r || !r.ok) return this.error((r && r.error) || "Could not save changes.");
    Drill.close();
    await this.reload();
    this.showTab("stock");
    this.toast(`${fields.serial} updated.`);
  },

  render() {
    this._restoreView();
    this._renderCore();
    this._decorateSel();
    this._saveView();
    Filt.syncAll();
  },

  _renderCore() {
    const q = (document.getElementById("search").value || "").trim().toLowerCase();
    const isUse = this.state.tab === "use";
    const isStock = this.state.tab === "stock";
    const fa = document.getElementById("fAge"); if (fa) fa.classList.toggle("hidden", !isStock);
    ["fModel", "fCpu", "fRam", "fCheckin", "fMfa"].forEach(id => { const el = document.getElementById(id); if (el) el.classList.toggle("hidden", !isUse); });
    const val = id => { const el = document.getElementById(id); return el ? (el.value || "") : ""; };
    const fm = isUse ? val("fModel") : "";
    const fc = isUse ? val("fCpu") : "";
    const fr = isUse ? val("fRam") : "";
    const fk = isUse ? val("fCheckin") : "";
    const fmfa = isUse ? val("fMfa") : "";
    const fsite = val("fSite"), fmfr = val("fMfr"), fwarr = val("fWarr"), fage = isStock ? val("fAge") : "";
    const ageOk = r => {                         // how long a machine has sat in stock (days since it was added)
      if (!fage) return true;
      const d = daysSince(r.date_added);
      return d !== null && d >= Number(fage);
    };
    const warrState = v => {                     // expired / soon (90 days) / active / unknown
      const s = (v || "").slice(0, 10); if (!s) return "unknown";
      const t = Date.parse(s); if (isNaN(t)) return "unknown";
      const d = Math.floor((t - Date.now()) / 86400000);
      return d < 0 ? "expired" : d <= 90 ? "soon" : "active";
    };
    const warrCell = v => {
      const st = warrState(v), t = (v || "").slice(0, 10);
      if (!t) return '<span class="muted">—</span>';
      return st === "expired" ? `<span class="w-exp" title="Warranty ended">${esc(t)}</span>` : st === "soon" ? `<span class="w-soon" title="Warranty ends within 90 days">${esc(t)}</span>` : esc(t);
    };
    const daysSince = v => {
      const s = (v || "").slice(0, 10); if (!s) return null;
      const t = Date.parse(s); if (isNaN(t)) return null;
      return Math.floor((Date.now() - t) / 86400000);
    };
    // staleness dot next to a check-in date: 14d mild, 25d moderate, 45d severe
    const checkinBadge = v => {
      const dd = daysSince(v); if (dd == null) return "";
      let cls, lvl;
      if (dd >= 45) { cls = "sev"; lvl = "severe"; }
      else if (dd >= 25) { cls = "mod"; lvl = "moderate"; }
      else if (dd >= 14) { cls = "mild"; lvl = "mild"; }
      else return "";
      return ` <span class="ci-dot ci-${cls}" title="No check-in for ${dd} days (${lvl})"></span>`;
    };
    const checkinOk = r => {
      if (!fk) return true;
      const ci = daysSince(r.last_checkin);
      if (fk === "never") return ci === null;
      return ci !== null && ci >= Number(fk);
    };
    const mfaOk = r => {
      if (!fmfa) return true;
      const m = r.mfa || "";
      if (fmfa === "unknown") return m === "";
      return m === fmfa;   // "Yes" | "No"
    };
    // search matches ANY detail: serial, hostname, user, model, specs, site,
    // warranty, MFA, dates, and the Windows edition ("Windows 11" etc.)
    const hay = r => [
      r.serial, r.device_name, r.manufacturer, r.model, r.user, r.site_tag,
      r.cpu, r.ram, r.storage, r.warranty, r.mfa, r.os_version, winOsLabel(r.os_version),
      r.last_checkin, r.os_install, r.date_added, r.deploy_date, r.mfg_date,
    ].map(v => (v == null ? "" : String(v)).toLowerCase()).join(" ");
    const match = r => (!q || hay(r).includes(q))
      && (!fm || (r.model || "") === fm) && (!fc || (r.cpu || "") === fc) && (!fr || (r.ram || "") === fr) && checkinOk(r) && mfaOk(r)
      && (!fsite || (r.site_tag || "") === fsite) && (!fmfr || this.mfrName(r.manufacturer) === fmfr) && (!fwarr || warrState(r.warranty) === fwarr) && ageOk(r)
      && (!this.state.userFilter || this.state.userFilter.has((r.user || "").toLowerCase()));
    const wrap = document.getElementById("tableWrap");
    const dcol = "white-space:nowrap";  // keep dates on one line
    const day = v => (v || "").slice(0, 10);  // ISO datetime -> YYYY-MM-DD

    const s = this.state.sort[this.state.tab];
    const th = (label, key, extra) => {
      const arrow = s.key === key ? (s.dir > 0 ? " ▲" : " ▼") : "";
      return `<th style="cursor:pointer;user-select:none;${extra || ""}" onclick="App.sortBy('${key}')">${label}${arrow}</th>`;
    };
    const sortRows = (list) => {
      if (!s.key) return list;
      return list.slice().sort((a, b) =>
        String(a[s.key] == null ? "" : a[s.key]).localeCompare(
          String(b[s.key] == null ? "" : b[s.key]), undefined, { numeric: true, sensitivity: "base" }) * s.dir);
    };
    const act = (label, action, serial, danger, title) =>
      `<button class="rowbtn${danger ? " danger" : ""}" data-action="${action}" data-serial="${attr(serial)}"${title ? ` title="${attr(title)}"` : ""}>${label}</button>`;

    const dl = (k, v) => `<div><span style="color:var(--muted);font-size:11px;display:block">${esc(k)}</span><span>${esc(v) || "—"}</span></div>`;
    const today = new Date().toISOString().slice(0, 10);
    const dateEd = (r, which) => `<div><span style="color:var(--muted);font-size:11px;display:block">${which === "deploy" ? "Deploy date" : "Manufacture date"}</span>` +
      `<input type="date" class="dt-in" value="${attr(which === "deploy" ? r.deploy_date || "" : r.mfg_date || "")}" max="${today}" title="Type or pick a date; clear the box to remove it" onchange="App.setDate('${attr(r.serial)}','${which}',this.value)"></div>`;
    const siteOpts = r => {
      const opts = App.state.siteTags.slice();
      if (r.site_tag && !opts.includes(r.site_tag)) opts.unshift(r.site_tag);
      return opts.map(t => `<option ${t === r.site_tag ? "selected" : ""}>${esc(t)}</option>`).join("");
    };

    if (this.state.tab === "stock") {
      const rows = sortRows(this.state.stock.filter(match)); this._count(rows, this.state.stock.length);
      if (!rows.length) return void (wrap.innerHTML = `<div class="empty">No machines in stock. Click “Add new machine”.</div>`);
      const exp = this.state.expanded;
      const detail = r => `<tr><td></td><td colspan="8" class="detailcell" style="padding:0 18px 14px;">
        <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px 24px;background:var(--darker);border:1px solid var(--border);border-radius:8px;padding:14px 16px;">
          ${dl("Serial number", r.serial)}${dl("Manufacturer", r.manufacturer)}${dl("Model", r.model)}
          ${dl("CPU", r.cpu)}${dl("RAM", r.ram)}${dl("Storage", r.storage)}
          ${dl("Warranty", day(r.warranty))}${dl("Date added", day(r.date_added))}${dateEd(r, "deploy")}${dateEd(r, "mfg")}
          <div><span style="color:var(--muted);font-size:11px;display:block">Site assignment</span>
            <select onchange="App.setSite('${attr(r.serial)}', this.value)" style="background:var(--darker);border:1px solid var(--border);border-radius:6px;padding:6px 8px;color:var(--text);font-size:13px;margin-top:2px;">${siteOpts(r)}</select></div>
        </div></td></tr>`;
      wrap.innerHTML = `<table class="fit">` +
        `<colgroup><col style="width:42px"><col style="width:12%"><col style="width:12%"><col style="width:16%"><col style="width:22%"><col style="width:8%"><col style="width:11%"><col style="width:11%"><col style="width:170px"></colgroup>` +
        `<thead><tr>` +
        `<th></th>` +
        th("Serial number", "serial") + th("Manufacturer", "manufacturer") + th("Model", "model") +
        `<th>Specs</th>` + th("Site", "site_tag") + th("Warranty", "warranty", dcol) + th("Added", "date_added", dcol) +
        `<th style="text-align:right">Actions</th></tr></thead><tbody>` +
        rows.map(r => {
          const open = exp.has(r.serial);
          return `<tr>
          <td><button class="rowbtn" data-action="expand" data-serial="${attr(r.serial)}" style="padding:2px 8px;line-height:1" title="Show all specs / assign site">${open ? "−" : "+"}</button></td>
          <td class="mono" title="${attr(r.serial)}">${esc(r.serial)}</td><td title="${attr(r.manufacturer)}">${esc(r.manufacturer)}</td><td title="${attr(r.model)}">${esc(r.model)}</td>
          <td title="${attr([r.cpu, r.ram, r.storage].filter(Boolean).join(" · "))}">${esc([r.cpu, r.ram, r.storage].filter(Boolean).join(" · "))}</td>
          <td>${esc(r.site_tag)}</td><td>${warrCell(r.warranty)}</td><td>${esc(day(r.date_added))}</td>
          <td style="text-align:right;white-space:nowrap">${act("🚀 Deploy", "deploy", r.serial, false, r.deploy_date ? "Deployed " + r.deploy_date + " - click to change" : "Record the date this machine was deployed")} ${act("✎", "editstock", r.serial, false, "Edit device")} ${act("✕", "remove", r.serial, true, "Remove")}</td></tr>` +
          (open ? detail(r) : "");
        }).join("") +
        `</tbody></table>`;
    } else if (this.state.tab === "boneyard") {
      const rows = sortRows((this.state.boneyard || []).filter(match)); this._count(rows, (this.state.boneyard || []).length);
      if (!rows.length) return void (wrap.innerHTML = `<div class="empty">Boneyard is empty. Devices gone from AD, Entra &amp; Intune are auto-retired here on sync.</div>`);
      const exp = this.state.expanded;
      const detail = r => `<tr><td></td><td colspan="6" class="detailcell" style="padding:0 18px 14px;">
        <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px 24px;background:var(--darker);border:1px solid var(--border);border-radius:8px;padding:14px 16px;">
          ${dl("Serial number", r.serial)}${dl("Former hostname", r.device_name)}${dl("Last primary user", r.user)}
          ${dl("Model", r.model)}${dl("CPU", r.cpu)}${dl("RAM", r.ram)}
          ${dl("Storage", r.storage)}${dl("Site", r.site_tag)}${dl("Warranty", r.warranty)}
          ${dl("Last check-in", day(r.last_checkin))}${dl("Retired", day(r.moved_at))}${dl("Retired by", r.moved_by)}
          ${dl("Reason", r.reason || "Not in AD, Entra, or Intune")}
        </div></td></tr>`;
      wrap.innerHTML = `<table class="fit">` +
        `<colgroup><col style="width:42px"><col style="width:14%"><col style="width:18%"><col style="width:18%"><col style="width:22%"><col style="width:13%"><col style="width:110px"></colgroup>` +
        `<thead><tr><th></th>` +
        th("Serial number", "serial") + th("Former hostname", "device_name") + th("Model", "model") +
        th("Last user", "user") + th("Retired", "moved_at", dcol) +
        `<th style="text-align:right">Actions</th></tr></thead><tbody>` +
        rows.map(r => {
          const open = exp.has(r.serial);
          return `<tr>
          <td><button class="rowbtn" data-action="expand" data-serial="${attr(r.serial)}" style="padding:2px 8px;line-height:1" title="Show details">${open ? "−" : "+"}</button></td>
          <td class="mono" title="${attr(r.serial)}">${esc(r.serial)}</td><td title="${attr(r.device_name)}">${esc(r.device_name || "—")}</td><td title="${attr(r.model)}">${esc(r.model)}</td>
          <td title="${attr(r.user)}">${esc(r.user || "—")}</td><td>${esc(day(r.moved_at))}</td>
          <td style="text-align:right;white-space:nowrap">${act("↩ Restore", "restoreboneyard", r.serial, false, "Restore to Stock")}</td></tr>` +
          (open ? detail(r) : "");
        }).join("") +
        `</tbody></table>`;
    } else {
      const rows = sortRows(this.state.use.filter(match)); this._count(rows, this.state.use.length);
      if (!rows.length) return void (wrap.innerHTML = `<div class="empty">No machines in use.</div>`);
      const exp = this.state.expanded;
      const mfaCell = v => v === "Yes"
        ? '<span style="color:#3ecf8e;font-weight:600">Yes</span>'
        : v === "No"
        ? '<span style="color:#ff6b6b;font-weight:600">No</span>'
        : '<span style="color:var(--muted)" title="MFA status unavailable — needs AuditLog.Read.All consent">—</span>';
      const detail = r => `<tr><td></td><td colspan="10" class="detailcell" style="padding:0 18px 14px;">
        <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px 24px;background:var(--darker);border:1px solid var(--border);border-radius:8px;padding:14px 16px;">
          ${dl("Device name", r.device_name)}${dl("Serial number", r.serial)}${dl("Primary user", r.user)}
          ${dl("Manufacturer", r.manufacturer)}${dl("Model", r.model)}${dl("Site tag", r.site_tag)}
          ${dl("CPU", r.cpu)}${dl("RAM", r.ram)}${dl("Storage", r.storage)}
          ${dl("OS version", winOsLabel(r.os_version))}${dl("OS install date", day(r.os_install))}${dl("Warranty", r.warranty)}
          ${dl("MFA registered", r.mfa || "—")}${dateEd(r, "deploy")}${dateEd(r, "mfg")}
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px;">
          <button class="rowbtn" onclick="HotSpares.openMove('${attr(r.serial)}')" title="Move back to In Stock and log as a ready hot spare (held out of the stock count)">🔥 Hot Spare</button>
          <button class="rowbtn" onclick="App.moveToStock('${attr(r.serial)}')" title="Move back to In Stock (clears the assigned user)">📦 In Stock</button>
        </div></td></tr>`;
      wrap.innerHTML = `<table class="fit">` +
        `<colgroup><col style="width:42px"><col style="width:10%"><col style="width:11%"><col style="width:13%"><col style="width:17%"><col style="width:6%"><col style="width:6%"><col style="width:9%"><col style="width:9%"><col style="width:11%"><col style="width:96px"></colgroup>` +
        `<thead><tr>` +
        `<th></th>` +
        th("Serial number", "serial") + th("Manufacturer", "manufacturer") + th("Model", "model") +
        th("Assigned user", "user") + th("MFA", "mfa") + th("Site", "site_tag") + th("Warranty", "warranty", dcol) + th("Deployed", "deploy_date", dcol) +
        th("Last check-in", "last_checkin", dcol) +
        `<th style="text-align:right">Actions</th></tr></thead><tbody>` +
        rows.map(r => {
          const open = exp.has(r.serial);
          return `<tr>
            <td><button class="rowbtn" data-action="expand" data-serial="${attr(r.serial)}" style="padding:2px 8px;line-height:1" title="Show all specs">${open ? "−" : "+"}</button></td>
            <td class="mono" title="${attr(r.serial)}">${esc(r.serial)}</td><td class="cell-mfr" title="${attr(r.manufacturer)}">${esc(r.manufacturer)}</td><td title="${attr(r.model)}">${esc(r.model)}</td>
            <td class="cell-user">${r.user ? `<a class="sw-user" data-user="${attr(r.user)}" title="See everything ${attr(r.user)} has installed">${esc(r.user)}</a>` : "—"}</td><td>${mfaCell(r.mfa)}</td><td>${esc(r.site_tag)}</td><td>${warrCell(r.warranty)}</td>
            <td>${r.deploy_date ? esc(r.deploy_date) : '<span class="muted">—</span>'}</td>
            <td>${esc(day(r.last_checkin))}${checkinBadge(r.last_checkin)}</td>
            <td style="text-align:right;white-space:nowrap">${act("✎", "editspecs", r.serial, false, "Edit CPU, RAM, storage and warranty")} ${act("⬆", "upgrade", r.serial, false, "Add to upgrade list")} ${act("✕", "remove", r.serial, true, "Remove")}</td></tr>` +
            (open ? detail(r) : "");
        }).join("") +
        `</tbody></table>`;
    }
  },

  async runSync() {
    const btn = document.getElementById("syncBtn");
    btn.disabled = true; btn.textContent = "Syncing…";
    const r = await Backend.call("run_sync");
    if (!r.ok) { btn.disabled = false; btn.textContent = "↻ Sync now"; return this.error(r.error || "Sync failed."); }
    if (r.locked) {
      btn.disabled = false; btn.textContent = "↻ Sync now";
      return this.toast("Another sync is already running" + (r.locked.by ? " (" + r.locked.by + ")" : "") + ". Try again in a minute.", true);
    }
    await this.reload();
    const n = (r.moved || []).length, u = r.refreshed || 0, d = r.deduped || 0;
    this.toast(n || u || d
      ? `Synced with Intune: ${n} added, ${u} updated${d ? `, ${d} duplicate row(s) cleaned up` : ""}.`
      : "In use is up to date with Intune.");
    btn.textContent = "Enriching…";
    const e = await Backend.call("enrich_inventory");
    btn.disabled = false; btn.textContent = "↻ Sync now";
    if (e && e.ok && (e.enriched || e.sites || e.users)) {
      await this.reload();
      const parts = [];
      if (e.users) parts.push(`user on ${e.users}`);
      if (e.sites) parts.push(`site on ${e.sites}`);
      if (e.enriched) parts.push(`specs on ${e.enriched}`);
      this.toast(`Filled ${parts.join(", ")} device(s)${e.remaining ? `, ${e.remaining} specs to go` : ""}.`);
    }
  },

  async populateMfa() {
    const btn = document.getElementById("mfaBtn");
    const old = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "Reading MFA…"; }
    const r = await Backend.call("populate_mfa", false);
    if (btn) { btn.disabled = false; btn.textContent = old; }
    if (!r || !r.ok) return this.error((r && r.error) || "Could not read MFA.");
    if (r.checked === 0) { this.toast("MFA already set on every device — nothing to fill."); return; }
    if (r.filled === 0 && r.unresolved) {
      return this.error(`Checked ${r.checked} device(s) but couldn't read MFA for any (${r.unresolved} unresolved). Confirm UserAuthenticationMethod.Read.All is consented and that you're signed in with your auth-admin account.`);
    }
    await this.reload();
    this.toast(`MFA filled on ${r.filled} device(s) — ${r.yes} with MFA, ${r.no} without${r.unresolved ? `, ${r.unresolved} unresolved` : ""}.`);
    if (r.errors && r.errors.length) this.toast(`${r.errors.length} write error(s) — see the Log.`, true);
  },

  async masterSync() {
    if (!confirm("Master sync force-refreshes EVERY in-use device's primary user, specs, MFA, last check-in and OS from Intune/Entra, overwriting the stored values. This can take a few minutes on a large fleet. Continue?")) return;
    const btn = document.getElementById("masterSyncBtn");
    const sync = document.getElementById("syncBtn");
    const old = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "Master syncing…"; }
    if (sync) sync.disabled = true;
    const r = await Backend.call("master_sync");
    if (btn) { btn.disabled = false; btn.textContent = old; }
    if (sync) sync.disabled = false;
    if (!r || !r.ok) return this.error((r && r.error) || "Master sync failed.");
    await this.reload();
    const c = r.counts || {};
    const parts = [];
    if (c.user) parts.push(`user ${c.user}`);
    if (c.specs) parts.push(`specs ${c.specs}`);
    if (c.mfa) parts.push(`MFA ${c.mfa}`);
    if (c.checkin) parts.push(`check-in ${c.checkin}`);
    if (c.os) parts.push(`OS ${c.os}`);
    if (c.storage) parts.push(`storage ${c.storage}`);
    const added = r.added ? `${r.added} added, ` : "";
    this.toast(parts.length
      ? `Master sync: ${added}refreshed ${parts.join(", ")} across ${r.rows} device(s).`
      : `Master sync: everything already up to date (${added}${r.rows} device(s)).`);
    if (r.errors && r.errors.length) this.toast(`${r.errors.length} error(s) during master sync — see the Log.`, true);
  },

  error(msg) {
    document.getElementById("errText").textContent = msg;
    document.getElementById("errBanner").classList.remove("hidden");
  },
  toast(msg, isErr) {
    const t = document.createElement("div");
    t.className = "toast" + (isErr ? " err" : "");
    t.textContent = msg;
    document.getElementById("toasts").appendChild(t);
    setTimeout(() => t.remove(), 4200);
  },
};

/* ---- add-machine wizard -------------------------------------------------- */
const Wizard = {
  step: 1, mfr: null, serials: [], rows: [],

  open() {
    this.step = 1; this.mfr = null; this.serials = []; this.rows = []; this._site = "";
    // default the site to the signed-in user's location (Lathrop->LTR, Brigham->BRI)
    this._defaultSite = "";
    Backend.call("my_site").then(r => { if (r && r.ok && r.site) this._defaultSite = r.site; }).catch(() => {});
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal">
        <div class="modal-head"><h3 id="wTitle">Add new machines</h3><button onclick="Wizard.close()">&times;</button></div>
        <div class="modal-body">${Help.box("wizard")}<div class="steps"><div id="ws1"></div><div id="ws2"></div><div id="ws3"></div></div><div id="wBody"></div></div>
        <div class="modal-foot" id="wFoot"></div>
      </div></div>`;
    this.render();
  },
  close() { document.getElementById("modalRoot").innerHTML = ""; },
  val(id) { const el = document.getElementById(id); return el ? el.value.trim() : ""; },

  render() {
    const modal = document.querySelector(".modal"); if (modal) modal.style.width = "";
    document.getElementById("wTitle").textContent = `Add new machines — step ${this.step} of 3`;
    ["ws1", "ws2", "ws3"].forEach((id, i) => document.getElementById(id).classList.toggle("done", i < this.step));
    const body = document.getElementById("wBody"), foot = document.getElementById("wFoot");
    if (this.step === 1) {
      body.innerHTML = `<p style="margin-top:0;color:var(--muted);font-size:13px;">Which manufacturer are these machines?</p>
        <div class="mfr-choices">
          <div class="opt ${this.mfr === "Dell" ? "sel" : ""}" onclick="Wizard.pick('Dell')">Dell</div>
          <div class="opt ${this.mfr === "Lenovo" ? "sel" : ""}" onclick="Wizard.pick('Lenovo')">Lenovo</div>
          <div class="opt ${this.mfr === "HP" ? "sel" : ""}" onclick="Wizard.pick('HP')">HP</div>
        </div>`;
      foot.innerHTML = `<button class="ghost" onclick="Wizard.close()">Cancel</button>`;
    } else if (this.step === 2) {
      body.innerHTML = `<p style="margin-top:0;color:var(--muted);font-size:13px;">Scan or type up to 10 serial numbers — one per line.</p>
        <textarea id="wSerials" rows="8" autofocus placeholder="Scan or type one serial per line…"
          style="width:100%;box-sizing:border-box;background:var(--darker);border:1px solid var(--border);border-radius:8px;padding:10px 12px;color:var(--text);font-size:14px;font-family:Consolas,monospace;">${(this.serials || []).join("\n")}</textarea>
        <div class="hint">A barcode scanner types each serial and hits Enter, so one per line works for scanning too.</div>`;
      foot.innerHTML = `<button class="ghost" onclick="Wizard.back()">Back</button>
        <button class="primary" onclick="Wizard.next()">Look up</button>`;
    }
  },

  pick(m) { this.mfr = m; this.step = 2; this.render(); },  // choosing a maker advances straight to serials
  back() { this.step = Math.max(1, this.step - 1); this.render(); },

  async next() {
    if (this.step === 2) {
      let serials = (this.val("wSerials") || "").split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
      serials = [...new Set(serials)].slice(0, 10);
      if (!serials.length) return App.toast("Enter at least one serial number.", true);
      this.serials = serials;
      this.step = 3;
      await this.runBatch();
    }
  },

  async runBatch() {
    ["ws1", "ws2", "ws3"].forEach(id => document.getElementById(id).classList.add("done"));
    document.getElementById("wTitle").textContent = "Looking up serials…";
    document.getElementById("wBody").innerHTML = `<div class="spinner"></div>
      <p style="text-align:center;color:var(--muted);font-size:13px;">Querying ${esc(this.mfr)} for ${this.serials.length} serial(s)…</p>`;
    document.getElementById("wFoot").innerHTML = "";
    this.rows = [];
    for (const s of this.serials) {
      const res = await Backend.call("lookup", this.mfr, s);
      this.rows.push({ serial: s, res: res || { ok: false, error: "no response" } });
    }
    this.renderBatch();
  },

  // pull the current input values back onto the row objects so edits (and the
  // chosen site) survive a re-render — e.g. when a row is removed from the batch.
  _capture() {
    const s = document.getElementById("b_site"); if (s) this._site = s.value;
    this.rows.forEach((x, i) => {
      const r = x.res; if (!r || !r.ok || r.status === "duplicate") return;
      const g = id => { const el = document.getElementById(id); return el ? el.value : undefined; };
      const m = g("b_model_" + i), c = g("b_cpu_" + i), ra = g("b_ram_" + i), st = g("b_storage_" + i);
      if (m !== undefined) r.model = m;
      if (c !== undefined) r.cpu = c;
      if (ra !== undefined) r.ram = ra;
      if (st !== undefined) r.storage = st;
    });
  },
  removeRow(i) { this._capture(); this.rows.splice(i, 1); this.renderBatch(); },

  renderBatch() {
    const modal = document.querySelector(".modal"); if (modal) modal.style.width = "min(1180px, 96vw)";
    document.getElementById("wTitle").textContent = `Review ${this.rows.length} serial(s)`;
    const body = document.getElementById("wBody"), foot = document.getElementById("wFoot");
    const addable = this.rows.filter(x => x.res.ok && (x.res.status === "found" || x.res.status === "manual"));
    const cell = (id, v) => `<input id="${id}" value="${attr(v)}" style="width:100%;box-sizing:border-box;">`;
    const rm = i => `<button class="rowbtn danger" onclick="Wizard.removeRow(${i})" title="Remove from this batch">✕</button>`;
    const rowsHtml = this.rows.map((x, i) => {
      const r = x.res || {};
      if (!r.ok)
        return `<tr style="opacity:.7"><td class="mono">${esc(x.serial)}</td><td><span class="tag dup">Error</span></td><td colspan="5" style="color:var(--muted)">${esc(r.error || "lookup failed")}</td><td style="text-align:center">${rm(i)}</td></tr>`;
      if (r.status === "duplicate")
        return `<tr style="opacity:.6"><td class="mono">${esc(x.serial)}</td><td><span class="tag dup">Duplicate</span></td><td colspan="5" style="color:var(--muted)">Already in ${esc(r.where)} — skipped</td><td style="text-align:center">${rm(i)}</td></tr>`;
      const st = r.status === "found" ? `<span class="tag ok">Found</span>` : `<span class="tag warn">Manual</span>`;
      return `<tr>
        <td class="mono">${esc(x.serial)}</td><td>${st}</td>
        <td>${cell("b_model_" + i, r.model)}</td>
        <td>${cell("b_cpu_" + i, r.cpu)}</td>
        <td>${cell("b_ram_" + i, r.ram)}</td>
        <td>${cell("b_storage_" + i, r.storage)}</td>
        <td>${esc(r.warranty_end)}</td>
        <td style="text-align:center">${rm(i)}</td></tr>`;
    }).join("");
    const sel = this._site || this._defaultSite || "";
    const siteOpts = App.state.siteTags.map(t =>
      `<option${t === sel ? " selected" : ""}>${esc(t)}</option>`).join("");
    body.innerHTML = `
      <div class="field" style="max-width:200px;"><label>Site tag (all)</label>
        <select id="b_site">${siteOpts}</select></div>
      <table style="table-layout:fixed;width:100%;margin-top:10px;">
        <colgroup><col style="width:12%"><col style="width:9%"><col style="width:21%"><col style="width:21%"><col style="width:9%"><col style="width:11%"><col style="width:11%"><col style="width:6%"></colgroup>
        <thead><tr>
        <th>Serial</th><th>Status</th><th>Model</th><th>CPU</th><th>RAM</th><th>Storage</th><th>Warranty</th><th></th>
      </tr></thead><tbody>${rowsHtml}</tbody></table>
      <p style="font-size:12px;color:var(--muted);margin-top:10px;">${addable.length} will be added to New Stock; duplicates and errors are skipped. Edit any field, or remove a row with ✕, before adding.</p>`;
    foot.innerHTML = `<button class="ghost" onclick="Wizard.back()">Back</button>
      <button class="primary" onclick="Wizard.saveBatch()" ${addable.length ? "" : "disabled"}>Add ${addable.length} to New Stock</button>`;
  },

  async saveBatch() {
    const site = this.val("b_site") || App.state.siteTags[0];
    const targets = this.rows.map((x, i) => ({ x, i }))
      .filter(o => o.x.res.ok && (o.x.res.status === "found" || o.x.res.status === "manual"));
    document.getElementById("wFoot").innerHTML = `<button class="primary" disabled>Adding…</button>`;
    let ok = 0, skipped = 0;
    for (const { x, i } of targets) {
      const r = x.res;
      const model = this.val("b_model_" + i);
      if (!model) { skipped++; continue; }  // needs a model
      const res = await Backend.call("add_machine", {
        serial: r.serial, manufacturer: r.manufacturer || this.mfr, model,
        cpu: this.val("b_cpu_" + i), ram: this.val("b_ram_" + i), storage: this.val("b_storage_" + i),
        site_tag: site, warranty: r.warranty_end || "",
      });
      if (res.ok) ok++; else skipped++;
    }
    this.close();
    App.toast(`Added ${ok} machine(s)` + (skipped ? `, ${skipped} skipped (no model or error)` : "") + ".");
    App.reload();
  },
};

/* ---- remove modal: decommission OR move an in-use device back to stock ---- */
const DeleteView = {
  serial: "",
  open(serial) {
    this.serial = serial;
    const inUse = (App.state.use || []).some(x => x.serial === serial);
    const actionBlock = inUse ? `
      <div class="field"><label>What do you want to do?</label>
        <label class="radio-row"><input type="radio" name="delAction" value="remove" checked onchange="DeleteView.onAction()">
          <span><b>Remove from inventory</b> — decommission this device.</span></label>
        <label class="radio-row"><input type="radio" name="delAction" value="stock" onchange="DeleteView.onAction()">
          <span><b>Move back to New Stock</b> — unassign it and keep it in inventory to reassign later.</span></label>
      </div>` : "";
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal">
        <div class="modal-head"><h3>Remove ${esc(serial)}</h3><button onclick="DeleteView.close()">&times;</button></div>
        <div class="modal-body">
          <p style="margin-top:0;color:var(--muted);font-size:13px;">${inUse
            ? "Decommission this device, or move it back to New Stock. Either way it's recorded in the activity log with who and why."
            : "This removes the machine from inventory. It stays in the activity log with who removed it and why."}</p>
          ${actionBlock}
          <div class="field"><label>Reason (optional)</label><input id="delReason" placeholder="e.g. Decommissioned, returned, reassigning" autofocus></div>
        </div>
        <div class="modal-foot">
          <button class="ghost" onclick="DeleteView.close()">Cancel</button>
          <button class="primary" id="delBtn" style="background:var(--red)" onclick="DeleteView.save()">Remove</button>
        </div></div></div>`;
  },
  onAction() {
    const stock = (document.querySelector('input[name=delAction]:checked') || {}).value === "stock";
    const b = document.getElementById("delBtn");
    if (b) { b.textContent = stock ? "Move to Stock" : "Remove"; b.style.background = stock ? "var(--med)" : "var(--red)"; }
  },
  close() { document.getElementById("modalRoot").innerHTML = ""; },
  async save() {
    const reason = (document.getElementById("delReason").value || "").trim();
    const toStock = (document.querySelector('input[name=delAction]:checked') || {}).value === "stock";
    const b = document.getElementById("delBtn"); if (b) b.disabled = true;
    const r = toStock ? await Backend.call("return_to_stock", this.serial, reason)
                      : await Backend.call("delete_machine", this.serial, reason);
    if (!r.ok) { App.toast(r.error || "Action failed.", true); if (b) b.disabled = false; return; }
    this.close(); App.toast(r.message || "Done."); App.reload();
  },
};

/* ---- bulk actions on the Devices page: one confirmation, then the same single-device calls one by one ---- */
const Bulk = {
  kind: "", serials: [], pri: 3,
  TITLE: { deploy: "Deploy date", mfgdate: "Manufacture date", site: "Set site", remove: "Remove devices", tostock: "Move to In Stock", upgrade: "Add to upgrade list", restore: "Restore to Stock" },
  open(kind) {
    this.kind = kind; this.serials = [...App.state.sel]; this.pri = 3;
    const n = this.serials.length; if (!n) return;
    const list = `<div class="bulk-list">${this.serials.slice(0, 8).map(s => `<span class="md-tag">${esc(s)}</span>`).join(" ")}${n > 8 ? ` <span class="muted">+ ${n - 8} more</span>` : ""}</div>`;
    let body = "", btn = "Run", danger = false;
    if (kind === "deploy" || kind === "mfgdate") {
      const today = new Date().toISOString().slice(0, 10);
      body = `<div class="field"><label>${kind === "deploy" ? "Deploy date" : "Manufacture date"}</label><input type="date" id="bkDate" value="${kind === "deploy" ? today : ""}" max="${today}"></div>`;
      btn = `Save on ${n}`;
    } else if (kind === "site") {
      body = `<div class="field"><label>New site</label><select id="bkSite">${App.state.siteTags.map(t => `<option>${esc(t)}</option>`).join("")}</select></div>`; btn = `Set site on ${n}`;
    } else if (kind === "remove") {
      danger = true; btn = `Remove ${n}`;
      body = `<p class="sub-note" style="margin:0 0 10px">Each device is removed from inventory and recorded in the activity log with your reason.</p>
        <div class="field"><label>Reason (optional)</label><input id="bkReason" placeholder="e.g. Decommissioned" autocomplete="off"></div>` +
        (n > 5 ? `<div class="field"><label>To confirm, type the number of devices (${n})</label><input id="bkConfirm" autocomplete="off" style="max-width:140px"></div>` : "");
    } else if (kind === "tostock") {
      btn = `Move ${n} to In Stock`;
      body = `<p class="sub-note" style="margin:0 0 10px">Clears each device's assigned user and puts it back in stock.</p><div class="field"><label>Reason (optional)</label><input id="bkReason" placeholder="e.g. Reassigning" autocomplete="off"></div>`;
    } else if (kind === "upgrade") {
      btn = `Add ${n} to the list`;
      body = `<label class="up-lbl">Priority <span class="muted">(5 = highest)</span></label><div class="up-pri" id="bkPri">${[1, 2, 3, 4, 5].map(k => `<button type="button" class="up-pri-opt p${k}${k === 3 ? " sel" : ""}" data-p="${k}" onclick="Bulk.pick(${k})">${k}</button>`).join("")}</div>
        <label class="up-lbl">Notes</label><textarea id="bkNotes" class="up-notes" rows="3" placeholder="Why / what to upgrade"></textarea>`;
    } else if (kind === "restore") {
      btn = `Restore ${n}`; body = `<p class="sub-note" style="margin:0">Each device goes back to <b>In Stock</b>. The next sync moves it to In Use if it has a user.</p>`;
    }
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal" style="width:540px;max-width:94vw">
        <div class="modal-head"><h3>${this.TITLE[kind]} <span class="drill-n">${n}</span></h3><button onclick="Bulk.close()">&times;</button></div>
        <div class="modal-body">${list}<div style="margin-top:12px">${body}</div><div id="bkProg" class="sub-note" style="margin-top:10px"></div></div>
        <div class="modal-foot"><button class="ghost" id="bkCancel" onclick="Bulk.close()">Cancel</button>
          <button class="primary" id="bkGo" ${danger ? 'style="background:var(--red)"' : ""} onclick="Bulk.run()">${btn}</button></div>
      </div></div>`;
  },
  pick(k) { this.pri = k; document.querySelectorAll("#bkPri .up-pri-opt").forEach(b => b.classList.toggle("sel", +b.dataset.p === k)); },
  close() { document.getElementById("modalRoot").innerHTML = ""; },
  async run() {
    const kind = this.kind, serials = this.serials.slice(), v = id => ((document.getElementById(id) || {}).value || "").trim();
    if (kind === "remove" && serials.length > 5 && v("bkConfirm") !== String(serials.length)) return App.toast(`Type ${serials.length} to confirm.`, true);
    if (kind === "deploy" || kind === "mfgdate") {                         // one call for all of them
      const d = v("bkDate"); if (!d) return App.toast("Choose a date.", true);
      const go0 = document.getElementById("bkGo"); go0.disabled = true;
      const r = await DeviceDates.set(serials, kind === "deploy" ? d : null, kind === "mfgdate" ? d : null);
      go0.disabled = false;
      if (!r || !r.ok) return App.toast((r && r.error) || "Could not save.", true);
      App.state.sel.clear(); this.close(); App.render(); App.toast(`${this.TITLE[kind]} saved on ${serials.length} device${serials.length === 1 ? "" : "s"}.`);
      return;
    }
    const reason = v("bkReason"), site = v("bkSite"), notes = v("bkNotes"), pri = this.pri;
    const call = {
      site: s => Backend.call("set_site", s, site),
      remove: s => Backend.call("delete_machine", s, reason || "Bulk remove"),
      tostock: s => Backend.call("return_to_stock", s, reason || "Moved to stock (bulk)"),
      upgrade: s => Backend.call("hub_add_upgrade", Upgrade.resolveDevice(s), pri, notes),
      restore: s => Backend.call("restore_boneyard", s),
    }[kind];
    const go = document.getElementById("bkGo"), cancel = document.getElementById("bkCancel"), prog = document.getElementById("bkProg");
    go.disabled = true; cancel.disabled = true;
    let ok = 0; const fails = [];
    for (let i = 0; i < serials.length; i++) {
      prog.innerHTML = `<span class="busy-spin"></span> Working… ${i + 1} of ${serials.length}`;
      let r; try { r = await call(serials[i]); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      if (r && r.ok) ok++; else fails.push(`${serials[i]}: ${(r && r.error) || "failed"}`);
    }
    Backend.call("bulk_audit", this.TITLE[kind], ok, fails.length, kind === "site" ? "Site " + site : reason || notes || "");
    App.state.sel.clear();
    await App.reload();
    if (!fails.length) { this.close(); App.toast(`${this.TITLE[kind]}: ${ok} done.`); return; }
    prog.innerHTML = `<b style="color:var(--red)">${ok} done, ${fails.length} failed.</b><div class="bulk-fails">${fails.map(f => `<div>${esc(f)}</div>`).join("")}</div>`;
    go.classList.add("hidden"); cancel.disabled = false; cancel.textContent = "Close";
  },
};

/* ---- log view ------------------------------------------------------------ */
const LogView = {
  async open() {
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal" style="width:760px;max-width:94vw;">
        <div class="modal-head"><h3>Activity log</h3><button onclick="LogView.close()">&times;</button></div>
        <div class="modal-body" id="logBody" style="max-height:70vh;overflow:auto;"><div class="spinner"></div></div>
      </div></div>`;
    const r = await Backend.call("get_log");
    const body = document.getElementById("logBody");
    if (!body) return;
    if (!r.ok) { body.innerHTML = `<p style="color:var(--red)">${esc(r.error || "Could not load log.")}</p>`; return; }
    const rows = r.entries || [];
    if (!rows.length) { body.innerHTML = `<div class="empty">No activity logged yet.</div>`; return; }
    const fmt = w => { const d = new Date(w); return isNaN(d) ? esc(w) : Tz.dt(w); };
    const tag = a => a === "Added" ? "b-instock" : a === "Deployed" ? "b-inuse" : "";
    body.innerHTML = `<table><thead><tr><th>When</th><th>Action</th><th>Serial</th><th>Model</th><th>Who</th><th>Details</th></tr></thead><tbody>` +
      rows.map(e => `<tr>
        <td style="white-space:nowrap">${fmt(e.when)}</td>
        <td><span class="badge ${tag(e.action)}">${esc(e.action)}</span></td>
        <td class="mono">${esc(e.serial)}</td><td>${esc(e.model)}</td>
        <td>${esc(e.actor)}</td><td>${esc(e.details)}</td></tr>`).join("") +
      `</tbody></table>`;
  },
  close() { document.getElementById("modalRoot").innerHTML = ""; },
};

/* ==========================================================================
   HUB SHELL: left-nav view switching, combined dashboard, and the Endpoint Hub
   (setup runbooks) ported to call window.pywebview.api.hub_* via Backend.
   ========================================================================== */

/* ---- left-nav ------------------------------------------------------------ */
/* ---- Teammates: one row per person with MFA (MFA is the person's, not the device's) ---- */
const People = {
  doc: null, f: { q: "", mfa: "all" }, sort: { key: "user", dir: 1 }, sel: new Set(),
  METHODS: { microsoftAuthenticatorPush: "Authenticator app", microsoftAuthenticatorPasswordless: "Authenticator (passwordless)", mobilePhone: "Phone", alternateMobilePhone: "Alt phone",
             officePhone: "Office phone", softwareOneTimePasscode: "Authenticator code", hardwareOneTimePasscode: "Hardware code", fido2: "Security key", windowsHelloForBusiness: "Windows Hello",
             email: "Email", temporaryAccessPass: "Temp access pass", passKeyDeviceBound: "Passkey", passKeyDeviceBoundAuthenticator: "Passkey", passKeySynced: "Passkey" },
  async load() {
    const r = await Backend.call("mfa_people_get");
    this.doc = (r && r.ok && r.data) || null;
    this.render();
  },
  /* Devices page: show each device's person MFA state from this list (read-only overlay, nothing is written to device rows) */
  async overlay(rows) {
    try {
      const r = await Backend.call("mfa_people_get");
      const d = r && r.ok && r.data; if (!d || !Array.isArray(d.people)) return;
      const m = {}; d.people.forEach(p => { if (p.mfa) m[(p.user || "").toLowerCase()] = p.mfa; });
      (rows || []).forEach(x => { const v = m[(x.user || "").toLowerCase()]; if (v) x.mfa = v; });
    } catch (e) { /* the device rows keep their stored value */ }
  },
  focus(mfa) { this.f = { q: "", mfa: mfa || "all" }; Nav.go("people"); },
  async refresh(btn) {
    let r; await Ui.working(btn, "Reading Entra…", async () => { r = await Backend.call("mfa_people_refresh"); return false; });
    if (!r || !r.ok) return App.error((r && r.error) || "Could not refresh MFA.");
    this.doc = r.data; this.render();
    const d = this.doc;
    if (d.source === "none") App.toast("Could not read MFA from Entra. It needs the AuditLog.Read.All permission and a reader role.", true);
    else App.toast(`MFA refreshed for ${d.people.length} people: ${d.yes} registered, ${d.no} not${d.unknown ? `, ${d.unknown} unknown` : ""}.`);
    App.reload();
  },
  label(m) { return this.METHODS[m] || m.replace(/([A-Z])/g, " $1").trim(); },
  setF(k, v) { this.f[k] = v; this.render(); },
  sortBy(k) { if (this.sort.key === k) this.sort.dir = -this.sort.dir; else this.sort = { key: k, dir: 1 }; this.render(); },
  rows() {
    const d = this.doc; if (!d) return [];
    const q = this.f.q.trim().toLowerCase(), f = this.f.mfa;
    let out = d.people.filter(p => (f === "all" || (f === "unknown" ? !p.mfa : p.mfa === f))
      && (!q || [p.user, p.name, ...(p.devices || []).flatMap(x => [x.serial, x.name])].some(v => (v || "").toLowerCase().includes(q))));
    const k = this.sort.key, dir = this.sort.dir;
    const val = p => k === "devices" ? (p.devices || []).length : k === "mfa" ? (p.mfa === "No" ? 0 : p.mfa === "Yes" ? 2 : 1) : String(p[k] || "").toLowerCase();
    return out.slice().sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
  },
  render() {
    const host = document.getElementById("pplHost"); if (!host) return;
    const meta = document.getElementById("pplMeta"), d = this.doc;
    if (meta) meta.textContent = d ? `Refreshed ${String(d.generated_at || "").slice(0, 16).replace("T", " ")}${d.by ? " by " + d.by : ""}` : "Not refreshed yet";
    if (!d) { host.innerHTML = `<div class="empty">No MFA list yet. Click <b>Refresh from Entra</b> to build it. This reads the sign-in method registrations of everyone who has a machine.</div>`; return; }
    const t = d.people.length, pct = t ? Math.round(100 * d.yes / t) : 0;
    const card = (n, label, f, cls) => `<div class="stat clickable ${cls || ""}" onclick="People.setF('mfa','${f}')"><div class="n">${n}</div><div class="l">${label} ›</div></div>`;
    const rows = this.rows();
    const shownKeys = new Set(rows.map(p => (p.user || "").toLowerCase()));
    [...this.sel].forEach(k => { if (!shownKeys.has(k)) this.sel.delete(k); });          // only people you can see stay ticked
    const th = (label, key) => `<th style="cursor:pointer;user-select:none" onclick="People.sortBy('${key}')">${label}${this.sort.key === key ? (this.sort.dir > 0 ? " ▲" : " ▼") : ""}</th>`;
    const seg = (v, l) => `<label class="${this.f.mfa === v ? "on" : ""}"><input type="radio" name="pplMfa" ${this.f.mfa === v ? "checked" : ""} onchange="People.setF('mfa','${v}')">${l}</label>`;
    const mfaCell = v => v === "Yes" ? '<span style="color:#3ecf8e;font-weight:600">Yes</span>' : v === "No" ? '<span style="color:#ff6b6b;font-weight:600">No</span>' : '<span class="muted" title="Entra did not report this person">Unknown</span>';
    const warn = d.source === "none" ? `<div class="cfg-warn" style="margin-bottom:12px">Entra did not return sign-in registrations, so MFA shows as unknown. Reading them needs the <code>AuditLog.Read.All</code> permission and a reader role (Security or Global Reader).</div>` : "";
    host.innerHTML = warn + `<div class="stats">
        ${card(t, "People with a machine", "all")}${card(d.yes + ` <span style="font-size:14px;color:var(--muted)">(${pct}%)</span>`, "MFA registered", "Yes", "inuse")}
        ${card(d.no, "No MFA", "No", d.no ? "ppl-bad" : "")}${card(d.unknown, "Unknown", "unknown")}</div>
      <div class="panel"><div class="tools">
        <input id="pplQ" type="search" placeholder="Search name, email, device or serial…" value="${attr(this.f.q)}" oninput="People.typed(this.value)" autocomplete="off">
        <div class="iss-seg" role="radiogroup" aria-label="MFA">${seg("all", "Everyone")}${seg("No", "No MFA")}${seg("Yes", "Registered")}${seg("unknown", "Unknown")}</div>
        <span class="dev-tools-r"><span class="muted">${rows.length === t ? t + " people" : "Showing " + rows.length + " of " + t}</span><button class="rowbtn" onclick="People.copy()">Copy list</button></span></div>
        <div id="pplBar" class="bulk-bar${this.sel.size ? "" : " hidden"}">${this._barHtml()}</div>
        ${rows.length ? `<table class="fit"><colgroup><col style="width:40px"><col style="width:28%"><col style="width:8%"><col style="width:28%"><col style="width:22%"><col style="width:8%"></colgroup>
          <thead><tr><th><input type="checkbox" id="pplAll" title="Select everyone shown" ${rows.length && this.sel.size === rows.length ? "checked" : ""} onchange="People.pickAll(this.checked)"></th>${th("Person", "user")}${th("MFA", "mfa")}<th>Sign-in methods</th>${th("Devices", "devices")}${th("Updated", "updated")}</tr></thead><tbody>` +
        rows.map(p => `<tr>
          <td><input type="checkbox" class="rowsel" data-u="${attr((p.user || "").toLowerCase())}" ${this.sel.has((p.user || "").toLowerCase()) ? "checked" : ""} onchange="People.pick(this.dataset.u,this.checked)"></td>
          <td><b>${esc(p.name || p.user)}</b>${p.name ? `<div class="muted" style="font-size:12px">${esc(p.user)}</div>` : ""}</td>
          <td>${mfaCell(p.mfa)}</td>
          <td>${(p.methods || []).length ? (p.methods || []).map(m => `<span class="md-tag${m === p.default ? " you" : ""}" title="${m === p.default ? "Default method" : ""}">${esc(this.label(m))}</span>`).join(" ") : '<span class="muted">—</span>'}</td>
          <td>${(p.devices || []).map(x => `<a class="sw-user" data-user="${attr(p.user)}" onclick="People.toDevices(this.dataset.user)">${esc(x.name || x.serial)}</a>`).join(", ")}</td>
          <td>${esc(p.updated || "—")}</td></tr>`).join("") + `</tbody></table>` : `<div class="empty">Nobody matches.</div>`}</div>`;
    const q = document.getElementById("pplQ");
    if (q && this._focusQ) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  },
  _barHtml() {
    const n = this.sel.size;
    return `<b>${n} selected</b><span class="bulk-actions">
      <button class="rowbtn" onclick="People.copy(true)">Copy selected</button>
      <button class="rowbtn" onclick="People.showDevices()">Show their devices</button>
      <button class="rowbtn" onclick="People.email()">✉ E-mail…</button></span>
      <a class="bulk-clear" onclick="People.pickAll(false)">Clear selection</a>`;
  },
  _bar() {
    const bar = document.getElementById("pplBar"); if (!bar) return;
    bar.classList.toggle("hidden", !this.sel.size);
    bar.innerHTML = this.sel.size ? this._barHtml() : "";
    const a = document.getElementById("pplAll"); if (a) a.checked = !!this.rows().length && this.sel.size === this.rows().length;
  },
  pick(u, on) { if (on) this.sel.add(u); else this.sel.delete(u); this._bar(); },
  pickAll(on) {
    this.sel.clear();
    if (on) this.rows().forEach(p => this.sel.add((p.user || "").toLowerCase()));
    document.querySelectorAll("#pplHost .rowsel").forEach(cb => { cb.checked = on; });
    this._bar();
  },
  picked() { return this.rows().filter(p => this.sel.has((p.user || "").toLowerCase())); },
  showDevices() {
    const users = this.picked().map(p => (p.user || "").toLowerCase()); if (!users.length) return;
    App.state.userFilter = new Set(users);
    const s = document.getElementById("search"); if (s) s.value = "";
    Nav.go("inventory"); App.showTab("use");
  },
  /* A draft in the PC's default mail app (classic or new Outlook). Nothing is sent from here. */
  email() {
    const ppl = this.picked(); if (!ppl.length) return;
    const noMfa = ppl.every(p => p.mfa === "No");
    this._mail = { to: ppl.map(p => p.user), subject: noMfa ? "Please set up multi-factor sign-in (MFA)" : "" };
    const body = noMfa ? "Hi,\n\nOur records show you have not set up a second sign-in method (MFA) for your Nucor account. Please register one at https://aka.ms/mysecurityinfo. It takes about five minutes.\n\nThank you,\nSystems / IT" : "";
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal" style="width:640px;max-width:96vw">
        <div class="modal-head"><h3>E-mail ${ppl.length} teammate${ppl.length === 1 ? "" : "s"}</h3><button onclick="People.mailClose()">&times;</button></div>
        <div class="modal-body">
          <p class="sub-note" style="margin:0 0 10px">This only opens a <b>draft</b>. Nothing is sent until you press Send in your mail program.</p>
          <div class="bulk-list">${ppl.slice(0, 6).map(p => `<span class="md-tag">${esc(p.name || p.user)}</span>`).join(" ")}${ppl.length > 6 ? ` <span class="muted">+ ${ppl.length - 6} more</span>` : ""}</div>
          <div class="field"><label>Subject</label><input id="mlSub" value="${attr(this._mail.subject)}" autocomplete="off"></div>
          <div class="field"><label>Message</label><textarea id="mlBody" rows="8" style="width:100%">${esc(body)}</textarea></div>
        </div>
        <div class="modal-foot" style="flex-wrap:wrap;gap:8px">
          <button class="ghost" onclick="People.mailCopy()">Copy addresses</button>
          <button class="ghost" onclick="People.mailWeb()" title="Outlook on the web (outlook.office.com), signed in with your Microsoft account">Open in Outlook on the web</button>
          <button class="primary" onclick="People.mailApp(this)" title="Your default mail program: classic Outlook or the new Outlook">Open in Outlook</button>
        </div></div></div>`;
  },
  mailClose() { document.getElementById("modalRoot").innerHTML = ""; },
  _mailParts() { return { to: this._mail.to, subject: (document.getElementById("mlSub") || {}).value || "", body: (document.getElementById("mlBody") || {}).value || "" }; },
  async mailApp(btn) {
    const m = this._mailParts();
    let r; await Ui.working(btn, "Opening…", async () => { r = await Backend.call("open_mailto", m.to, m.subject, m.body); return false; });
    if (r && r.ok) { this.mailClose(); App.toast("Draft opened. Check your mail program."); return; }
    if (r && r.too_long) { this.mailCopy(true); App.toast("Too many people for one e-mail link. The addresses are copied: open a new message and paste them into To.", true); return; }
    App.toast((r && r.error) || "Could not open the mail program.", true);
  },
  mailWeb() {
    const m = this._mailParts(), q = encodeURIComponent;
    const url = `https://outlook.office.com/mail/deeplink/compose?to=${q(m.to.join(";"))}&subject=${q(m.subject)}&body=${q(m.body)}`;
    if (url.length > 7000) { this.mailCopy(true); return App.toast("Too many people for one link. The addresses are copied: paste them into To.", true); }
    Backend.call("open_external", url).then(r => { if (r && r.ok) { this.mailClose(); App.toast("Opening Outlook on the web."); } else App.toast((r && r.error) || "Could not open it.", true); });
  },
  mailCopy(quiet) {
    const txt = this._mail.to.join("; ");
    const done = () => { if (!quiet) App.toast(`Copied ${this._mail.to.length} address${this._mail.to.length === 1 ? "" : "es"}.`); };
    const fb = () => { const t = document.createElement("textarea"); t.value = txt; document.body.appendChild(t); t.select(); try { document.execCommand("copy"); done(); } catch (e) { App.toast("Could not copy.", true); } t.remove(); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, fb); else fb();
  },
  _t: null,
  typed(v) { this.f.q = v; this._focusQ = true; clearTimeout(this._t); this._t = setTimeout(() => this.render(), 150); },
  toDevices(user) { const s = document.getElementById("search"); if (s) s.value = user; Nav.go("inventory"); App.showTab("use"); },
  copy(onlySelected) {
    const rows = onlySelected ? this.picked() : this.rows(), cell = v => String(v == null ? "" : v).replace(/[\t\r\n]+/g, " ");
    const txt = ["Person\tEmail\tMFA\tMethods\tDevices\tUpdated"].concat(rows.map(p => [p.name, p.user, p.mfa || "Unknown", (p.methods || []).map(m => this.label(m)).join("; "), (p.devices || []).map(x => x.name || x.serial).join("; "), p.updated].map(cell).join("\t"))).join("\n");
    const done = () => App.toast(`Copied ${rows.length} row${rows.length === 1 ? "" : "s"}.`);
    const fb = () => { const t = document.createElement("textarea"); t.value = txt; document.body.appendChild(t); t.select(); try { document.execCommand("copy"); done(); } catch (e) { App.toast("Could not copy.", true); } t.remove(); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, fb); else fb();
  },
};

/* ---- sidebar count badges ------------------------------------------------------------
   One place decides what each badge counts. Add an entry to Badges.SOURCES, a <span class="nav-badge" id="badge-NAME"> in the
   menu item, and the badge appears. A source returns a number (0 = hidden). Refreshed at start, every minute, on window focus,
   and after the relevant actions. */
const Badges = {
  SOURCES: {
    issues: async () => {
      const seenKey = "nbg_issues_seen_" + ((App.state && App.state.account) || "");
      let since = ""; try { since = localStorage.getItem(seenKey) || ""; } catch (e) {}
      const r = await Backend.call("issue_counts", since);
      if (!r || !r.ok) return 0;
      return r.triage ? r.new : r.updates;          // super admins: untriaged issues. Everyone else: news on their own issues.
    },
  },
  set(name, n) {
    const el = document.getElementById("badge-" + name);
    if (!el) return;
    el.textContent = n > 99 ? "99+" : String(n);
    el.classList.toggle("hidden", !(n > 0));
    el.title = n + (name === "issues" ? " issue" + (n === 1 ? "" : "s") + " need attention" : "");
  },
  async refresh() {
    if (document.body.classList.contains("signed-out")) return;
    for (const [name, fn] of Object.entries(this.SOURCES)) { try { this.set(name, await fn()); } catch (e) { /* a badge never breaks the page */ } }
  },
  /* the person has now seen what changed on Issues */
  seenIssues() {
    try { localStorage.setItem("nbg_issues_seen_" + ((App.state && App.state.account) || ""), new Date().toISOString().slice(0, 19) + "Z"); } catch (e) {}
    this.refresh();
  },
};

/* ---- division time zone: all displayed times use it (blank = this PC's own zone) ---- */
const Tz = {
  id: "", prefs: null,
  async load() {
    try {
      const r = await Backend.call("get_division_prefs");
      this.prefs = (r && r.ok) ? r : null;
      this.id = (r && r.ok && r.effective) || "";
      if (r && r.ok && r.project_hub_effective) ProjectHub.URL = r.project_hub_effective;
    } catch (e) { this.id = ""; }
  },
  o(opts) { return this.id ? { ...opts, timeZone: this.id } : opts; },
  dt(v) { const d = new Date(v); return isNaN(d) ? "" : d.toLocaleString(undefined, this.o({})); },
  date(v, opts) { const d = new Date(v); return isNaN(d) ? "" : d.toLocaleDateString(undefined, this.o(opts || {})); },
  time(v) { const d = new Date(v); return isNaN(d) ? "" : d.toLocaleTimeString(undefined, this.o({ hour: "numeric", minute: "2-digit" })); },
};

const Nav = {
  go(view) {
    if (view !== "hub" && typeof Hub !== "undefined" && Hub.templateMode) {
      Hub.templateMode = false;
      const b = document.getElementById("tplBanner"); if (b) b.classList.add("hidden");
      Hub.loadConfig();                           // back to the division's own checklists
    }
    document.querySelectorAll(".appview").forEach(el => el.classList.remove("active"));
    const v = document.getElementById("appview-" + view);
    if (v) v.classList.add("active");
    document.querySelectorAll(".navitem").forEach(b => b.classList.toggle("active", b.dataset.view === view));
    window.scrollTo(0, 0);
    if (view === "dashboard") Dashboard.load();
    if (view === "inventory") App.render();
    if (view === "upgrades") Upgrade.load();
    if (view === "software") Software.load();
    if (view === "people") People.load();
    if (view === "projecthub") ProjectHub.load();
    if (view === "bgtools") BGTools.load();
    if (view === "settings") Settings.load();
    if (view === "issues") { Issues.load(); Badges.seenIssues(); }
    if (view === "dashboard") SyncLine.refresh();
  },
};

/* ---- Project Hub: dedicated sidebar item -------------------------------
   Project Hub uses MSAL redirect sign-in, which refuses to run in an iframe
   (redirect_in_iframe). So it opens FULL-WINDOW in the app's own window (top
   frame → sign-in works) with an injected "← Back to NBG Hub" button, or in a
   separate window. Same mechanism the NBT Sites "fullview" mode uses. */
const ProjectHub = {
  URL: "https://projecthub-dev.nucorservices.com/",     // replaced per division by Tz.load() (Settings > General)
  // Sidebar click opens Project Hub in the user's DEFAULT browser (where they're
  // already SSO'd) — no embedding. Nav.go still shows a small landing card as a
  // fallback / re-open point.
  open() {
    Backend.call("open_external", this.URL)
      .then(r => { if (!r || !r.ok) window.open(this.URL, "_blank"); })
      .catch(() => window.open(this.URL, "_blank"));
  },
  load() {
    const host = document.getElementById("projectHubHost");
    if (!host) return;
    host.innerHTML =
      `<div class="site-window-msg">
        <div class="swm-ic">📋</div>
        <h3>Project Hub</h3>
        <p>Project Hub opens in your <b>default browser</b>, where you're already signed in.</p>
        <button class="primary" onclick="ProjectHub.open()">Open Project Hub</button>
      </div>`;
  },
  reload() { this.open(); },
};

/* ---- NBT Sites: embedded Nucor web tools --------------------------------
   Each entry loads inside the app (an iframe in the content area). If a portal
   refuses to be framed (X-Frame-Options / CSP), "Open in window" spawns a native
   pywebview window instead — still inside the program, not the system browser. */
const Sites = {
  // mode:"fullview" navigates the main window to the site (top-level, so sign-in
  // works — an iframe can't) with an injected "Back to Hub" button.
  // mode:"window" opens a separate native window. mode:"embed" (or none) = iframe.
  // Sites + categories are editable under Configuration → NBT Sites and stored in
  // the shared hub folder; these are the first-run defaults.
  DEFAULT_CATEGORIES: ["Endpoint Management", "Security", "Network", "Nucor Services"],
  DEFAULTS: [
    { id: "lockout", name: "Lockout Portal", url: "https://lockoutportal.nucorservices.com/", icon: "🔒", mode: "browser", category: "Nucor Services" },
    { id: "intune", name: "Intune", url: "https://intune.microsoft.com/", icon: "📱", mode: "fullview", category: "Endpoint Management" },
    { id: "entra", name: "Entra", url: "https://entra.microsoft.com/", icon: "🔑", mode: "fullview", category: "Endpoint Management" },
    { id: "ebs", name: "EBS", url: "https://ngebsprod.nucorservices.com/", icon: "🏢", mode: "browser", category: "Nucor Services" },
    { id: "logicmonitor", name: "Logic Monitor", url: "https://nucor.logicmonitor.com/santaba/uiv4/resources/resourceGroupForm/7860", icon: "📈", mode: "browser", category: "Network" },
    { id: "defender", name: "Windows Defender (Security)", url: "https://security.microsoft.com/homepage?tid=9ee0b1d3-0ba8-4efe-82d7-b61d6eae73ed", icon: "🛡️", mode: "browser", category: "Security" },
    { id: "bms", name: "BMS", url: "https://bms.nucorservices.com/_layouts/bms/", icon: "🏭", mode: "browser", category: "Nucor Services" },
    { id: "idnetsec", name: "Identity and Network Security", url: "https://nucor.sharepoint.com/sites/nbt.iamandnetworksecurityteam/SitePages/Home.aspx", icon: "🔐", mode: "browser", category: "Security" },
  ],
  categories: [],
  list: [],
  pin: "1700",
  loaded: false,
  current: null,

  async load() {
    if (this.loaded) return;
    try {
      const r = await Backend.call("hub_get_sites");
      const d = (r && r.ok && r.data) || null;
      if (d && Array.isArray(d.sites) && d.sites.length) {
        this.categories = Array.isArray(d.categories) ? d.categories.slice() : [];
        this.list = d.sites.map(s => ({ ...s }));
        this.pin = d.pin != null ? String(d.pin) : "1700";
      } else {
        this.categories = this.DEFAULT_CATEGORIES.slice();
        this.list = this.DEFAULTS.map(s => ({ ...s }));
        this.pin = "1700";
      }
    } catch (e) {
      this.categories = this.DEFAULT_CATEGORIES.slice();
      this.list = this.DEFAULTS.map(s => ({ ...s }));
      this.pin = "1700";
    }
    this.loaded = true;
  },

  boot() { this.load().then(() => this.home()); },

  _host(url) { try { return new URL(url).hostname; } catch (e) { return url || ""; } },

  _isCustom(c) { return (c || "").toLowerCase() === "custom"; },

  _card(s, removable) {
    const rm = removable
      ? `<span class="site-del" title="Remove" onclick="event.stopPropagation();Sites.removeCustom('${attr(s.id)}')">&times;</span>` : "";
    return `<button class="site-card" onclick="Sites.open('${attr(s.id)}')">
      ${rm}<div class="site-ic">${s.icon || "🌐"}</div>
      <h3>${esc(s.name)}</h3><p>${esc(this._host(s.url))}</p></button>`;
  },

  home() {
    this.current = null;
    const act = document.getElementById("siteActions"); if (act) act.style.display = "none";
    const sub = document.getElementById("sitesSub"); if (sub) sub.textContent = "Nucor web tools.";
    const host = document.getElementById("sitesHost");
    if (!host) return;
    const hasCustomCat = this.categories.some(c => this._isCustom(c));
    if (!this.list.length && !hasCustomCat) {
      host.innerHTML = `<div class="empty">No sites yet. Add them under <a onclick="Settings.open('links')">Settings → NBT Sites</a>.</div>`;
      return;
    }
    // normal categories (in order), then Other, then Custom pinned to the bottom
    const groups = [];
    this.categories.filter(c => !this._isCustom(c)).forEach(c => {
      const items = this.list.filter(s => s.category === c);
      if (items.length) groups.push([c, items]);
    });
    const known = new Set(this.categories);
    const other = this.list.filter(s => (!s.category || !known.has(s.category)) && !this._isCustom(s.category));
    if (other.length) groups.push(["Other", other]);
    let html = groups.map(([c, items]) =>
      `<div class="site-cat"><h3 class="site-cat-h">${esc(c)}</h3>
        <div class="site-grid">${items.map(s => this._card(s)).join("")}</div></div>`).join("");

    // Custom: always shown (if the category exists or any custom site exists),
    // pinned last, with a self-serve "+ Add site" card — no PIN required.
    const customItems = this.list.filter(s => this._isCustom(s.category));
    if (hasCustomCat || customItems.length) {
      const label = this.categories.find(c => this._isCustom(c)) || "Custom";
      html += `<div class="site-cat"><h3 class="site-cat-h">${esc(label)}</h3>
        <div class="site-grid">${customItems.map(s => this._card(s, true)).join("")}
          <button class="site-card site-add" onclick="Sites.quickAdd()">
            <div class="site-ic">＋</div><h3>Add site</h3><p>Add your own link</p></button>
        </div></div>`;
    }
    host.innerHTML = html;
  },

  // ---- self-serve custom sites (no PIN) --------------------------------
  quickAdd() {
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal" style="width:440px;max-width:94vw;">
        <div class="modal-head"><h3>Add a custom site</h3><button onclick="Sites.quickClose()">&times;</button></div>
        <div class="modal-body">
          <div class="field"><label>Name</label><input id="qaName" class="cfg-in" placeholder="e.g. My Tool" autocomplete="off"></div>
          <div class="field" style="margin-top:12px"><label>URL</label><input id="qaUrl" class="cfg-in" placeholder="https://…" autocomplete="off"></div>
          <div class="field" style="margin-top:12px"><label>Opens as</label>
            <select id="qaMode" class="cfg-in">
              <option value="browser">Web browser (SSO)</option>
              <option value="fullview">In-app (full window)</option>
              <option value="window">Separate window</option>
              <option value="embed">Embedded</option></select></div>
          <p id="qaErr" class="site-hint" style="color:var(--red);display:none;margin-top:10px"></p>
        </div>
        <div class="modal-foot"><button class="ghost" onclick="Sites.quickClose()">Cancel</button><button class="primary" onclick="Sites.quickAddSave()">Add site</button></div>
      </div></div>`;
    setTimeout(() => { const n = document.getElementById("qaName"); if (n) n.focus(); }, 40);
  },

  quickClose() { document.getElementById("modalRoot").innerHTML = ""; },

  async quickAddSave() {
    const name = (document.getElementById("qaName").value || "").trim();
    let url = (document.getElementById("qaUrl").value || "").trim();
    const mode = document.getElementById("qaMode").value || "browser";
    const err = document.getElementById("qaErr");
    if (!name || !url) { err.textContent = "Enter a name and a URL."; err.style.display = ""; return; }
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    const cats = this.categories.slice();
    if (!cats.some(c => this._isCustom(c))) cats.push("Custom");
    const label = cats.find(c => this._isCustom(c)) || "Custom";
    const site = { id: "site-" + Math.random().toString(36).slice(2, 8), name, url, icon: "🌐", mode, category: label };
    const list = this.list.concat([site]);
    const data = { categories: cats, sites: list, pin: this.pin };
    const r = await Backend.call("hub_save_sites", data, { action: "add", target: "Custom site", detail: name });
    if (r && r.ok) { this.categories = cats; this.list = list; this.quickClose(); App.toast && App.toast(`Added ${name}.`); this.home(); }
    else { err.textContent = (r && r.error) || "Could not save."; err.style.display = ""; }
  },

  async removeCustom(id) {
    const s = this.list.find(x => x.id === id);
    if (!s) return;
    if (!window.confirm(`Remove "${s.name}" from Custom? (this affects everyone)`)) return;
    const list = this.list.filter(x => x.id !== id);
    const data = { categories: this.categories.slice(), sites: list, pin: this.pin };
    const r = await Backend.call("hub_save_sites", data, { action: "remove", target: "Custom site", detail: s.name });
    if (r && r.ok) { this.list = list; App.toast && App.toast(`Removed ${s.name}.`); this.home(); }
    else { App.error ? App.error((r && r.error) || "Could not remove.") : alert((r && r.error) || "Could not remove."); }
  },

  open(id) {
    const s = this.list.find(x => x.id === id);
    if (!s) return;
    this.current = s;
    const act = document.getElementById("siteActions"); if (act) act.style.display = "";
    const sub = document.getElementById("sitesSub"); if (sub) sub.textContent = s.name;
    const reloadBtn = document.getElementById("siteReloadBtn");
    const host = document.getElementById("sitesHost");

    if (s.mode === "browser") {
      // open in the user's default browser (carries their Windows/Entra SSO —
      // auto-signs-in like normal web browsing), then return to the site list.
      this._openBrowser(s);
      App.toast && App.toast(`Opened ${s.name} in your browser.`);
      this.home();
      return;
    }

    if (s.mode === "window") {
      // open a separate native app window, then return to the site list.
      this._openNative(s);
      App.toast && App.toast(`Opened ${s.name} in a new window.`);
      this.home();
      return;
    }

    if (s.mode === "fullview") {
      // sign-in portals can't run in an iframe — open full-window in THIS window
      // (no pop-out); a "Back to NBG Hub" button is injected so you can return.
      if (reloadBtn) reloadBtn.style.display = "none";
      host.innerHTML =
        `<div class="site-window-msg">
          <div class="swm-ic">${s.icon || "🌐"}</div>
          <h3>Open ${esc(s.name)}</h3>
          <p>${esc(s.name)} needs a sign-in that can't run embedded, so it opens full-window right here. Use the green <b>← Back to NBG Hub</b> button (top-left) to come back.</p>
          <button class="primary" onclick="Sites.openFull()">Open ${esc(s.name)}</button>
          <button class="ghost" onclick="Sites.openWindow()" style="margin-top:2px">Open in a separate window instead</button>
        </div>`;
      return;
    }

    if (reloadBtn) reloadBtn.style.display = "";
    host.innerHTML =
      `<div class="site-embed">
        <iframe id="siteFrame" src="${attr(s.url)}" allow="clipboard-read; clipboard-write; fullscreen"
          referrerpolicy="no-referrer-when-downgrade"></iframe>
        <p class="site-hint">If the page stays blank or keeps redirecting, use <b>⧉ Open in window</b> above.</p>
      </div>`;
  },

  reload() {
    const f = document.getElementById("siteFrame");
    if (f) { f.src = f.src; App.toast("Reloading " + ((this.current && this.current.name) || "the page") + "…"); }
    else App.toast("Nothing is open to reload.");
  },

  _openNative(s) {
    Backend.call("open_url_window", s.url, s.name).then(r => {
      if (!r || !r.ok) window.open(s.url, "_blank");
    }).catch(() => window.open(s.url, "_blank"));
  },

  openWindow() { if (this.current) this._openNative(this.current); },

  _openBrowser(s) {
    Backend.call("open_external", s.url).then(r => {
      if (!r || !r.ok) window.open(s.url, "_blank");
    }).catch(() => window.open(s.url, "_blank"));
  },
  openBrowser() { if (this.current) this._openBrowser(this.current); },

  // navigate the whole app window to the site (real app); the back button is
  // injected by the Python side. In browser preview there's no host window, so
  // fall back to a new tab.
  openFull() {
    if (!this.current) return;
    Backend.call("site_navigate", this.current.url, this.current.name).then(r => {
      if (!r || !r.ok) window.open(this.current.url, "_blank");
    }).catch(() => window.open(this.current.url, "_blank"));
  },
};

/* ---- Edit specs: fill in CPU / RAM / storage / warranty by hand (for makers whose lookup is not available) ---- */
const Specs = {
  _t: null,
  _find(serial) {
    const all = [].concat(App.state.use || [], App.state.stock || [], (Dashboard._inv().missing_specs || []));
    return all.find(r => r.serial === serial) || { serial };
  },
  open(serial) {
    const r = this._find(serial), f = (id, label, val, ph, extra) => `<div class="field"><label>${label}</label><input id="${id}" value="${attr(val || "")}" placeholder="${attr(ph || "")}" autocomplete="off" ${extra || ""}></div>`;
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal" style="width:560px;max-width:94vw;">
        <div class="modal-head"><h3>Edit specs — <span class="mono">${esc(serial)}</span></h3><button onclick="Drill.close()">&times;</button></div>
        <div class="modal-body">
          <p class="muted" style="margin:0 0 10px;font-size:12.5px">${esc([r.manufacturer, r.model].filter(Boolean).join(" ") || "")}. Leave a box blank to leave it unknown. A sync never overwrites values you type here (except for Lenovo machines, which get their own lookup).</p>
          ${f("sp_cpu", "Processor", r.cpu, "e.g. Intel Core i5-8250U", 'oninput="Specs.hint()"')}
          <div id="sp_hint" class="muted" style="font-size:12px;margin:-6px 0 10px"></div>
          <div class="fields">${f("sp_ram", "RAM", r.ram, "e.g. 16 GB", 'list="sp_ramlist"')}${f("sp_storage", "Storage", r.storage, "e.g. 512 GB")}</div>
          <datalist id="sp_ramlist"><option value="4 GB"><option value="8 GB"><option value="16 GB"><option value="32 GB"><option value="64 GB"></datalist>
          <div class="field" style="max-width:240px"><label>Warranty ends</label><input id="sp_warranty" type="date" value="${attr((r.warranty || "").slice(0, 10))}"></div>
          <div class="up-actions"><button class="ghost" onclick="Drill.close()">Cancel</button>
            <button class="primary" onclick="Specs.save('${attr(serial)}')">Save</button></div>
        </div></div></div>`;
    this.hint();
    setTimeout(() => { const el = document.getElementById("sp_cpu"); if (el) el.focus(); }, 30);
  },
  /* live: what the app makes of the processor you typed (does it count as old?) */
  hint() {
    clearTimeout(this._t);
    this._t = setTimeout(async () => {
      const el = document.getElementById("sp_cpu"), h = document.getElementById("sp_hint");
      if (!el || !h) return;
      const v = el.value.trim();
      if (!v) { h.textContent = ""; return; }
      const r = await Backend.call("cpu_info", v);
      const rules = (Dashboard._inv().upgrade_rules || {}), lim = rules.cpu_years || 0;
      h.textContent = (r && r.year) ? `Recognized: released ${r.year} (${r.age} years old)${lim && r.age >= lim ? ". This will go on the Upgrade list." : "."}`
        : "Not recognized as an Intel or AMD model, so it will not count for the age rule. Check the spelling (for example i5-8250U).";
    }, 250);
  },
  async save(serial) {
    const val = id => (document.getElementById(id).value || "").trim();
    const r = await Backend.call("update_device_specs", serial, { cpu: val("sp_cpu"), ram: val("sp_ram"), storage: val("sp_storage"), warranty: val("sp_warranty") });
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not save.", true);
    Drill.close();
    App.toast("Specs saved." + (r.queued_upgrades ? " " + r.queued_upgrades + " device(s) added to the Upgrade list." : ""));
    try { await App.reload(); } catch (e) {}
    try { Dashboard.load(); } catch (e) {}
  },
};

/* ---- combined dashboard -------------------------------------------------- */
// "10.0.22631" -> "10.0.22631 · Windows 11". Win 11 = build 22000+, Win 10 = 10240+,
// anything older (major < 10) is flagged. Non-Windows / unknown -> just the number.
function winOsLabel(v) {
  const s = (v || "").trim();
  const m = s.match(/^(\d+)\.\d+\.(\d+)/);
  if (!m) return s || "—";
  const major = +m[1], build = +m[2];
  let name = "";
  if (major === 10 && build >= 22000) name = "Windows 11";
  else if (major === 10 && build >= 10240) name = "Windows 10";
  else if (major < 10) name = "Older than Windows 10";
  return name ? `${s} · ${name}` : s;
}
function warrantyDays(w) {
  w = (w || "").slice(0, 10); if (!w) return null;
  const d = new Date(w + "T00:00:00"); return isNaN(d) ? null : Math.round((d - new Date()) / 86400000);
}
// mirrors cpu.py release_year() — used only by the mock backend for browser preview
function cpuReleaseYear(cpu) {
  if (!cpu) return null;
  const c = String(cpu).toLowerCase();
  let m = c.match(/core\s+ultra\s+\d+\s+(\d)\d{2}/);
  if (m) return m[1] === "2" ? 2024 : 2023;
  m = c.match(/\bi[3579][- ]?(\d{3,5})/);
  if (m) {
    const num = m[1]; let gen = null;
    if (num.length >= 5) gen = parseInt(num.slice(0, 2), 10);
    else if (num.length === 4) gen = num[0] === "1" ? parseInt(num.slice(0, 2), 10) : parseInt(num[0], 10);
    const T = { 6: 2015, 7: 2016, 8: 2017, 9: 2018, 10: 2019, 11: 2020, 12: 2022, 13: 2023, 14: 2024 };
    if (gen) return T[gen] || (gen > 14 ? 2024 : null);
  }
  if (/ryzen\s+ai\b/.test(c) && /\d{3}/.test(c)) return 2024;
  m = c.match(/ryzen\s+\d+\s+(?:pro\s+)?(\d{4})/);
  if (m) { const T = { 1: 2017, 2: 2018, 3: 2019, 4: 2020, 5: 2021, 6: 2022, 7: 2023, 8: 2024, 9: 2024 }; return T[parseInt(m[1][0], 10)] || null; }
  return null;
}

// Reject if a promise doesn't settle in `ms` — so a stuck backend call surfaces an
// error + Retry instead of leaving a view spinning on "Loading…" forever.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(
      () => rej(new Error((label || "Request") + " timed out after " + Math.round(ms / 1000) + "s")), ms)),
  ]);
}

const Dashboard = {
  _inv() { return (this._data && this._data.inventory) || {}; },

  /* The Refresh button: re-read everything and SAY so. The numbers often do not change, so without feedback it looked dead. */
  async refresh() {
    await Ui.refreshing(document.getElementById("dashRefresh"), async () => { await this.load(); SyncLine.refresh(); }, "Dashboard");
  },


  async load() {
    const host = document.getElementById("dashHost");
    if (this._loading) return;              // a load is already in flight; don't stack
    this._loading = true;
    try {
    let d;
    try { d = await withTimeout(Backend.call("get_dashboard"), 45000, "Dashboard"); }
    catch (e) {
      host.innerHTML = `<div class="empty">Dashboard didn't load — ${esc(String((e && e.message) || e))}.<div style="margin-top:10px"><button class="rowbtn" onclick="Dashboard.load()">↻ Retry</button></div></div>`;
      return;
    }
    if (!d || !d.ok) { host.innerHTML = `<div class="empty">Could not load dashboard.<div style="margin-top:10px"><button class="rowbtn" onclick="Dashboard.load()">↻ Retry</button></div></div>`; return; }
    this._data = d;
    try { const ur = await Backend.call("hub_get_upgrades"); this._upgrades = (ur && ur.ok && ur.data && Array.isArray(ur.data.items)) ? ur.data.items : []; }
    catch (e) { this._upgrades = []; }
    try {
      const sr = await Backend.call("software_get");
      SWLogic.setCfg(sr && sr.ok && sr.rules ? sr.rules.auto : null);
      this._software = { apps: (sr && sr.ok && sr.data && sr.data.apps) || [],
                         users: (sr && sr.ok && sr.data && sr.data.users) || [],
                         rules: (sr && sr.ok && sr.rules && sr.rules.rules) || [] };
    } catch (e) { this._software = { apps: [], users: [], rules: [] }; }
    const su = d.setups || { total: 0, in_progress: 0, complete: 0, computer: 0, user: 0, recent: [], open_feedback: 0 };
    const inv = d.inventory;
    const w = inv && inv.warranty ? inv.warranty : null;

    const stat = (n, l, cls) => `<div class="stat ${cls || ""}"><div class="n">${n}</div><div class="l">${l}</div></div>`;
    const cstat = (n, l, onclick, cls) => `<div class="stat clickable ${cls || ""}" onclick="${onclick}"><div class="n">${n}</div><div class="l">${l} ›</div></div>`;

    let html = `<div class="dash-stats">
      ${inv ? cstat(inv.in_use, "Machines in use", "Dashboard.goDevices('use')") : stat("–", "Machines in use")}
      ${inv ? cstat(inv.new_stock, "Machines in stock", "Dashboard.goDevices('stock')") : stat("–", "Machines in stock")}
      ${inv ? HotSpares.tileHtml(inv) : ""}
      ${inv ? cstat(inv.no_upn_count || 0, "No UPN set", "Dashboard.drillNoUpn()", (inv.no_upn_count ? "warn" : "")) : stat("–", "No UPN set")}
      ${w ? cstat(w.expiring_90, "Warranties ≤90 days", "Dashboard.drillWarranty()", w.expired ? "danger" : (w.expiring_90 ? "warn" : "")) : stat("–", "Warranties ≤90 days")}
      ${inv ? cstat(inv.needs_upgrade_count || 0, "Upgrade Forecast", "Dashboard.upgradePlan()", (inv.needs_upgrade_count ? "danger" : "")) : stat("–", "Upgrade Forecast")}
      ${inv ? cstat(inv.stale_checkin_count || 0, "No check-in " + (inv.stale_days || 30) + "+ days", "Dashboard.drillStale()", (inv.stale_checkin_count ? "warn" : "")) : stat("–", "No check-in " + ((inv && inv.stale_days) || 30) + "+ days")}
      ${inv && (inv.no_mfa_count || (inv.no_mfa && inv.no_mfa.length)) ? cstat(inv.no_mfa_count || 0, "Users without MFA", "Dashboard.drillNoMfa()", "danger") : ""}
      ${inv && inv.missing_specs_count ? cstat(inv.missing_specs_count, "Missing specs", "Dashboard.drillMissingSpecs()", "warn") : ""}
      ${inv && inv.not_nbgw_count ? cstat(inv.not_nbgw_count, "Not part of " + Divisions.label(), "Dashboard.drillNotNbgw()") : ""}
    </div>`;

    const bar = (label, val, max, cls, drill) => `<div class="bar-row${drill ? " clickable" : ""}"${drill ? ` data-list="${attr(drill.list)}" data-key="${attr(drill.key)}"` : ""}>
      <div class="bl">${esc(label)}</div>
      <div class="bar-track"><div class="bar-fill ${cls || ""}" style="width:${Math.round(val / max * 100)}%"></div></div>
      <div class="bv">${val}</div></div>`;

    html += `<div class="dash-grid">`;

    if (inv && inv.stock_by_dept && Object.keys(inv.stock_by_dept).length) {
      html += this._deptCardHtml(inv);
    }
    // Software compliance sits to the right of In Stock By Department (same grid = same size)
    const swGaps = this._complianceGaps();
    this._compGaps = swGaps;
    if (swGaps.length) html += this._complianceCardHtml(swGaps);
    html += `</div>`;

    // Compact warranty status (left) + Needs-upgrade LTR/BRI queues (right), side by side.
    if (w) {
      const rows = [["Expired", w.expired, "red", "expired"], ["≤ 30 days", w.d0_30, "red", "d0_30"], ["31–90 days", w.d31_90, "amber", "d31_90"],
        ["91–180 days", w.d91_180, "blue", "d91_180"], ["> 180 days", w.beyond, "", "beyond"], ["No date", w.none, "gray", "none"]];
      const maxW = Math.max(1, ...rows.map(r => r[1]));
      const wbars = rows.map(([l, v, c, key]) => `<div class="bar-row clickable" data-warr="${key}"><div class="bl">${l}</div>
        <div class="bar-track"><div class="bar-fill ${c}" style="width:${Math.round(v / maxW * 100)}%"></div></div>
        <div class="bv">${v}</div></div>`).join("");
      const warrCard = `<div class="chart-card"><h4>Warranty status — click a range to drill in</h4>
        <p class="sub-note">${w.expiring_90} expiring ≤90 days${w.expired ? ` · ${w.expired} expired` : ""}.</p>
        <div class="bars">${wbars}</div></div>`;

      // Needs-upgrade queues per site (from the shared upgrade list — in sync with the Upgrades tab)
      const ups = this._upgrades || [];
      const listFor = site => ups.filter(i => this._bucket(i.site) === site)
        .sort((a, b) => (b.priority || 0) - (a.priority || 0) ||
          String(b.updated_at || b.added_at || "").localeCompare(String(a.updated_at || a.added_at || "")))
        .slice(0, 5);
      const nuRow = it => `<div class="nu-row clickable" data-upsite="${this._bucket(it.site)}" title="Open in the Upgrade list">
        <span class="up-badge2 p${it.priority || 3}">P${it.priority || 3}</span>
        <span class="nu-host mono">${esc(it.device_name || it.serial)}</span>
        <span class="nu-user">${esc(it.user || "—")}</span></div>`;
      const nuCol = site => { const l = listFor(site);
        return `<div class="nu-col"><h5>${site}</h5>${l.length ? l.map(nuRow).join("") : `<div class="empty" style="padding:12px;font-size:12px">None queued.</div>`}</div>`; };
      const nuCard = `<div class="chart-card"><h4>Upgrade Forecast — by site <button class="card-link" onclick="Nav.go('upgrades')">Open list ›</button></h4>
        <div class="nu-grid" style="grid-template-columns:repeat(${Math.max(1, Divisions.codes().length)},1fr)">${Divisions.codes().map(nuCol).join("")}</div></div>`;

      html += `<div class="dash-grid" style="margin-top:18px">${warrCard}${nuCard}</div>`;
    } else {
      html += `<div class="chart-card" style="margin-top:18px"><h4>Warranty status</h4>
        <div class="dash-signin"><span>Sign in with your Nucor account to see warranty coverage.</span>
        <button class="primary" onclick="App.signIn()">Sign in</button></div></div>`;
    }

    // recent setups (click to open/resume)
    html += `<h4 class="blkhead">Recent setups <span class="num">${su.recent.length}</span></h4>`;
    if (!su.recent.length) html += `<div class="empty">No setups yet.</div>`;
    else html += su.recent.map(l => {
      const pct = typeof l.pct === "number" ? l.pct : (l.total ? Math.round(l.done / l.total * 100) : 0);
      const done = l.status === "complete";
      const when = l.updatedAt || l.createdAt;
      const whenTxt = when ? Tz.date(when, { month: "short", day: "numeric" }) + " " + Tz.time(when) : "";
      return `<div class="h-row clickable" data-sid="${attr(l.id)}">
        <span class="htag ${l.type === "user" ? "user" : "computer"}">${l.type === "user" ? "User" : "Computer"}</span>
        <span class="who">${esc(l.subject || "(unnamed)")}</span>
        ${l.primaryUser ? `<span class="m2">· ${esc(l.primaryUser)}</span>` : ""}
        ${l.dept ? `<span class="m2">· ${esc(l.dept)}</span>` : ""}
        <span class="grow"></span>
        <span class="minibar"><span style="width:${pct}%"></span></span>
        <span class="m2">${l.done || 0}/${l.total || 0} (${pct}%)</span>
        <span class="status ${done ? "done" : "prog"}">${done ? "Complete" : "In progress"}</span>
        ${whenTxt ? `<span class="m2">${whenTxt}${l.updatedBy ? " · " + esc(l.updatedBy) : ""}</span>` : ""}</div>`;
    }).join("");

    host.innerHTML = html;

    if (!d.signed_in) {
      // Blur the placeholder dashboard and show a single centered Sign in prompt.
      const inner = host.innerHTML;
      host.innerHTML =
        `<div style="position:relative;min-height:480px;">
          <div style="filter:blur(5px);opacity:.45;pointer-events:none;user-select:none;">${inner}</div>
          <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">
            <div style="text-align:center;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:34px 44px;max-width:360px;box-shadow:0 12px 44px rgba(0,0,0,.4);">
              <div style="width:44px;height:44px;border-radius:10px;background:var(--med);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;margin:0 auto 14px;">N</div>
              <div style="font-size:20px;font-weight:600;margin-bottom:6px;">Sign in to NBG Hub</div>
              <p style="color:var(--muted);margin:0 0 20px;font-size:13.5px;">Sign in with your Nucor account to load live inventory and analytics. You only need to do this once on this PC.</p>
              <button class="primary" style="font-size:15px;padding:12px 30px;" onclick="Dashboard.signIn()">Sign in</button>
            </div>
          </div>
        </div>`;
      return;   // nothing interactive to wire while signed out
    }

    // wire up chart-bar and recent-row drill-downs
    host.querySelectorAll(".bar-row[data-list]").forEach(el => el.addEventListener("click", () => {
      if (el.dataset.list === "dept") this.drillDept(el.dataset.key);
      else this.drillSite(el.dataset.list, el.dataset.key);
    }));
    this._wireDeptCard();
    host.querySelectorAll(".bar-row[data-warr]").forEach(el => el.addEventListener("click", () => this.drillWarrantyBucket(el.dataset.warr)));
    host.querySelectorAll(".nu-row[data-upsite]").forEach(el => el.addEventListener("click", () => { Nav.go("upgrades"); Upgrade.tab(el.dataset.upsite); }));
    this._wireCompliance();
    host.querySelectorAll(".h-row[data-sid]").forEach(el => el.addEventListener("click", () => { Nav.go("hub"); Hub.resumeSetup(el.dataset.sid); }));
    } catch (e) {
      host.innerHTML = `<div class="empty">Dashboard hit an error while rendering — ${esc(String((e && e.message) || e))}.<div style="margin-top:10px"><button class="rowbtn" onclick="Dashboard.load()">↻ Retry</button></div></div>`;
    } finally {
      this._loading = false;
    }
  },

  goDevices(tab) { Nav.go("inventory"); App.showTab(tab); },

  // Software compliance for the dashboard: per department (that has mandatory apps),
  // the users missing any required app. Only departments WITH gaps are returned.
  _complianceGaps() {
    const sw = this._software || {};
    // Mandatory = top-10 apps per dept (auto) + user overrides; missing judged on the
    // latest version only. Shared with the Software page via SWLogic so counts match.
    return SWLogic.gaps(sw.apps || [], sw.users || [], sw.rules || []);
  },
  _compCollapseN: 4,
  _complianceCardHtml(gaps) {
    // Fixed compact size by default: show the first few departments; the rest live
    // behind an Expand toggle so this card never stretches the page as departments
    // pile up. Sorted worst-first, so the collapsed view is the most urgent ones.
    const n = this._compCollapseN, more = gaps.length - n;
    const expanded = !!this._compExpanded;
    const shown = expanded ? gaps : gaps.slice(0, n);
    const toggle = more > 0
      ? `<button class="cg-toggle" onclick="Dashboard.toggleCompliance()">${expanded ? "Show less ▲" : `Show all ${gaps.length} departments ▾`}</button>`
      : "";
    return `<div class="chart-card" id="compCard"><h4>Software compliance — users missing required apps <button class="card-link" onclick="Nav.go('software')">Open Software ›</button></h4>
      <div class="cg-list">` +
      shown.map(g => `<div class="cg-row clickable" data-scope="${attr(g.scope)}">
        <span class="bl">${esc(g.scope)}</span>
        <span class="cg-count">${g.count} user${g.count === 1 ? "" : "s"} missing required software ›</span></div>`).join("") +
      `</div>${toggle}</div>`;
  },
  toggleCompliance() {
    this._compExpanded = !this._compExpanded;
    const card = document.getElementById("compCard");
    if (card && this._compGaps) { card.outerHTML = this._complianceCardHtml(this._compGaps); this._wireCompliance(); }
  },
  _wireCompliance() {
    document.querySelectorAll("#compCard .cg-row[data-scope]")
      .forEach(el => el.addEventListener("click", () => this.drillCompliance(el.dataset.scope)));
  },
  drillCompliance(scope) {
    const g = (this._complianceGaps() || []).find(x => x.scope === scope);
    if (!g) return;
    Drill.open(`Missing required software — ${scope}`, g.users, [
      { label: "User", get: r => r.user || "—" },
      { label: "Missing apps", get: r => (r.apps || []).join(", ") }],
      { empty: "Everyone in this department has the required apps." });
  },

  // In Stock By Department card — legend sites are clickable to show just that
  // site's breakdown (toggle back to All).
  _deptSiteFilter: "all",
  _deptCardHtml(inv) {
    const f = this._deptSiteFilter || "all";
    const dept = inv.stock_by_dept || {}, bySite = inv.stock_by_dept_site || {};
    const countFor = k => f === "all" ? (dept[k] || 0) : ((bySite[k] || {})[f] || 0);
    let entries = Object.keys(dept).map(k => [k, countFor(k)]);
    if (f !== "all") entries = entries.filter(([, v]) => v > 0);
    entries.sort((a, b) => (a[0] === "Unassigned") - (b[0] === "Unassigned") || b[1] - a[1]);
    const maxSD = Math.max(1, ...entries.map(e => e[1]));
    const hasOther = Object.values(bySite).some(s => s.Other);
    const chip = (site, label, cls) => `<span class="lg ${cls} clickable${f === site ? " active" : ""}" data-dsite="${site}">${label}</span>`;
    const legend = `<div class="stack-legend">${chip("all", "All", "all")}${Divisions.codes().map(c => chip(c, c, Divisions.cls(c))).join("")}${hasOther ? chip("Other", "Other", "other") : ""}</div>`;
    const rows = entries.map(([k, total]) => {
      if (f === "all") {
        const s = bySite[k] || {}, codes = [...Divisions.codes(), "Other"];
        const nums = codes.filter(c => s[c]).map(c => `${c} <b>${s[c]}</b>`).join(" · ") || "0";
        const seg = (site, n, cls) => n ? `<div class="seg ${cls}" data-dept="${attr(k)}" data-site="${site}" style="width:${Math.round(n / maxSD * 100)}%" title="${site}: ${n}"></div>` : "";
        return `<div class="stack-row clickable" data-dept="${attr(k)}"><div class="bl">${esc(k)}</div>
          <div class="stack-track">${codes.map(c => seg(c, s[c] || 0, Divisions.cls(c))).join("")}</div>
          <div class="stack-nums">${nums}</div></div>`;
      }
      const cls = Divisions.cls(f);
      return `<div class="stack-row clickable" data-dept="${attr(k)}" data-site="${f}"><div class="bl">${esc(k)}</div>
        <div class="stack-track"><div class="seg ${cls}" style="width:${Math.round(total / maxSD * 100)}%"></div></div>
        <div class="stack-nums">${f} <b>${total}</b></div></div>`;
    }).join("") || `<div class="empty" style="padding:14px">No in-stock devices for ${f}.</div>`;
    const rc = inv.reserved_count || 0;
    const reservedNote = rc ? `<p class="sub-note reserved-note" id="deptReservedNote" style="margin:6px 0 0">🔒 ${rc} reserved for an active setup — held out of these counts. <a href="#" onclick="Dashboard.drillReserved();return false;">View</a></p>` : "";
    return `<div class="chart-card" id="deptCard"><h4>In Stock By Department <button class="card-link" onclick="Settings.open('models')">Configure ›</button></h4>
      ${legend}
      <div class="bars">${rows}</div>
      <p class="sub-note" style="margin:14px 0 0">Deployable pool by department${f !== "all" ? ` · ${f} only` : ", split by site"}. Click a site to filter.</p>${reservedNote}</div>`;
  },
  drillReserved() {
    const list = (this._inv().reserved) || [];
    Drill.open("Reserved for active setups", list, [
      { label: "Serial", get: r => r.serial, mono: 1 }, { label: "Model", get: r => r.model || "—" },
      { label: "Site", get: r => r.site || "—" }, { label: "Department", get: r => r.dept || "—" },
      { label: "Setup", get: r => r.subject || "—" }],
      { empty: "Nothing is reserved right now." });
  },
  _wireDeptCard() {
    const card = document.getElementById("deptCard"); if (!card) return;
    card.querySelectorAll(".lg[data-dsite]").forEach(el => el.addEventListener("click", () => this.deptSite(el.dataset.dsite)));
    card.querySelectorAll(".stack-row[data-dept]").forEach(el => el.addEventListener("click", e => {
      const seg = e.target.closest(".seg[data-site]");
      if (seg) this.drillDeptSite(el.dataset.dept, seg.dataset.site);
      else if (el.dataset.site) this.drillDeptSite(el.dataset.dept, el.dataset.site);
      else this.drillDept(el.dataset.dept);
    }));
  },
  deptSite(site) {
    this._deptSiteFilter = (site === this._deptSiteFilter) ? "all" : (site || "all");
    const card = document.getElementById("deptCard");
    if (card && this._data) { card.outerHTML = this._deptCardHtml(this._inv()); this._wireDeptCard(); }
  },

  async signIn() {
    await App.signIn();   // interactive sign-in + loads inventory + updates account label
    this.load();          // re-render the dashboard now that we're signed in
  },

  drillNoUpn() {
    Drill.open("Devices without a UPN", this._inv().no_upn || [], [
      { label: "Serial", get: r => r.serial, mono: 1, w: "20%" }, { label: "Device name", get: r => r.device_name, w: "26%" },
      { label: "Model", get: r => r.model, w: "26%" }, { label: "Site", get: r => r.site, w: "16%" }],
      { empty: "Every in-use device has a primary user." });
  },
  drillWarranty() {
    Drill.open("Warranties expiring ≤90 days (or expired)", this._inv().warranty_soon || [], [
      { label: "Serial", get: r => r.serial, mono: 1, w: "16%" }, { label: "Model", get: r => r.model, w: "22%" },
      { label: "User", get: r => r.user, w: "24%" }, { label: "Warranty", get: r => r.warranty, w: "14%" },
      { label: "When", get: r => r.days < 0 ? `expired ${-r.days}d ago` : `in ${r.days}d`, sortGet: r => r.days, w: "12%" }]);
  },
  _upgradeRulesText() {
    const r = this._inv().upgrade_rules || { cpu_years: 5, warranty_months: 0 }, bits = [];
    if (r.cpu_years) bits.push("processor " + r.cpu_years + "+ years old");
    if (r.warranty_months) bits.push("warranty ended " + r.warranty_months + "+ months ago");
    return bits.length ? bits.join(" or ") : "no rule is switched on";
  },
  drillNeedsUpgrade() {
    Drill.open("Needs upgrade — " + this._upgradeRulesText(), this._inv().needs_upgrade || [], [
      { label: "Serial", get: r => r.serial, mono: 1, w: "12%" }, { label: "Model", get: r => r.model, w: "15%" },
      { label: "User", get: r => r.user, w: "17%" }, { label: "Why", get: r => (r.reasons || []).join("; "), w: "40%" },
      { label: "Priority", get: r => "P" + (r.priority || 3), sortGet: r => r.priority || 3, w: "8%" },
      { label: "Source", get: r => r.source || "—", w: "8%" }],
      { empty: "Nothing meets the upgrade rules. If CPU or warranty data is missing, see the Missing specs tile.",
        rowAction: { label: "⬆ Add to upgrade list", fn: r => Upgrade.addPrompt(r.serial) } });
  },
  drillMissingSpecs() {
    Drill.open("Missing specs — fill in by hand", this._inv().missing_specs || [], [
      { label: "Serial", get: r => r.serial, mono: 1, w: "13%" }, { label: "Device", get: r => r.device_name, w: "14%" },
      { label: "Maker", get: r => r.manufacturer, w: "12%" }, { label: "Model", get: r => r.model, w: "18%" },
      { label: "User", get: r => r.user, w: "16%" }, { label: "Missing", get: r => (r.missing || []).join(", "), sortGet: r => (r.missing || []).length, w: "14%" },
      { label: "Source", get: r => r.source || "—", w: "8%" }],
      { empty: "Every device has its CPU, RAM and warranty recorded.",
        rowAction: { label: "✎ Edit specs", fn: r => Specs.open(r.serial) } });
  },
  // "Needs upgrade" tile: side-by-side LTR / BRI upgrade plan. Each column = top 5,
  // combining user-prioritized upgrade-list entries (priority first) with the most
  // out-of-date (oldest CPU) devices not yet queued. Links to the Upgrades tab.
  _bucket(s) { return Divisions.bucket(s); },
  async upgradePlan() {
    const aged = this._inv().needs_upgrade || [];
    let items = [];
    try { const r = await Backend.call("hub_get_upgrades"); items = (r && r.ok && r.data && r.data.items) || []; } catch (e) {}
    const onList = new Set(items.map(i => (i.serial || "").toLowerCase()));
    const col = site => {
      const listed = items.filter(i => this._bucket(i.site) === site)
        .sort((a, b) => (b.priority || 0) - (a.priority || 0) ||
          String(b.updated_at || b.added_at || "").localeCompare(String(a.updated_at || a.added_at || "")))
        .map(x => ({ ...x, listed: true }));
      const cand = aged.filter(a => this._bucket(a.site) === site && !onList.has((a.serial || "").toLowerCase()))
        .sort((a, b) => (a.year || 9999) - (b.year || 9999))
        .map(x => ({ ...x, listed: false }));
      return [...listed, ...cand];   // ALL devices meeting upgrade criteria for this site
    };
    const card = (it, i) => {
      const pr = it.priority || 3;
      const badge = it.listed
        ? `<span class="up-badge2 p${pr}" title="Priority ${pr}">P${pr}</span>`
        : `<span class="tag warn" title="${attr((it.reasons || []).join("; ") || "Meets the upgrade rules, not yet queued")}">${it.age ? it.age + "yr" : (it.months_past ? it.months_past + "mo" : "aged")}</span>`;
      const stat = it.status === "working" ? ` <span class="tag ok">Working</span>` : "";
      const who = it.listed
        ? `by ${esc(it.updated_by || it.added_by || "—")} · ${esc((it.updated_at || it.added_at || "").slice(0, 10))}`
        : `${esc((it.reasons && it.reasons[0]) || (it.year ? "CPU " + it.year : "aged"))} · not yet queued`;
      return `<div class="up-plan-item">
        <span class="up-pos">${i + 1}</span>${badge}
        <div class="up-main">
          <div class="up-top"><span class="mono">${esc(it.serial)}</span> <span class="up-model">${esc(it.model || "")}</span>${stat}</div>
          <div class="up-sub">${esc(it.user || "—")}${it.listed && it.notes ? ` — <span class="up-note">${esc(it.notes)}</span>` : ""}</div>
          <div class="up-meta">${who}</div>
        </div></div>`;
    };
    const column = (site) => {
      const rows = col(site);
      const body = rows.length ? rows.map(card).join("")
        : `<div class="empty" style="padding:24px">Nothing flagged for ${site}.</div>`;
      return `<div class="up-plan-col"><h4>${site} <span class="up-badge">${rows.length}</span></h4>${body}</div>`;
    };
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal" style="width:960px;max-width:96vw;">
        <div class="modal-head"><h3>Upgrade Forecast — by site</h3><button onclick="Drill.close()">&times;</button></div>
        <div class="modal-body" style="max-height:74vh;overflow:auto;">
          
          <div class="up-plan-grid" style="grid-template-columns:repeat(${Math.max(1, Divisions.codes().length)},1fr)">${Divisions.codes().map(column).join("")}</div>
        </div>
        <div class="modal-foot"><button class="ghost" onclick="Drill.close()">Close</button>
          <button class="primary" onclick="Drill.close(); Nav.go('upgrades')">Open Upgrade list →</button></div>
      </div></div>`;
  },
  async drillStale() {
    const rows = (this._inv().stale_checkin || []);
    rows.forEach(r => { if (r._living === undefined) r._living = null; });   // reset per open
    this._livingState = { entra: "…", ad_error: null, domain: Divisions.cur().ad_domain || "" };
    Drill.open("No Intune check-in in " + ((this._inv().stale_days) || 30) + "+ days (stalest first)", rows, [
      { label: "Serial", get: r => r.serial, mono: 1, w: "12%" }, { label: "Device name", get: r => r.device_name, w: "13%" },
      { label: "Model", get: r => r.model, w: "13%" }, { label: "User", get: r => r.user, w: "16%" },
      { label: "Last check-in", get: r => (r.last_checkin || "").slice(0, 10), w: "11%" },
      { label: "Days ago", get: r => r.days, w: "7%" },
      { label: "Source", get: r => r.source || "—", w: "8%" },
      { label: "Living in", get: r => this._livingCell(r), html: 1, sortGet: r => this._livingRank(r), w: "18%" }],
      { empty: "No device has gone " + ((this._inv().stale_days) || 30) + "+ days without an Intune check-in.", width: "min(1360px, 96vw)" });
    // Async: find where each stale device still lives (on-prem AD / Entra / Intune).
    try {
      const res = await Backend.call("locate_devices",
        rows.map(r => ({ serial: r.serial, hostname: r.device_name })));
      if (res && res.ok) {
        this._livingState = { entra: res.entra_state, ad_error: res.ad_error, domain: res.ad_domain || Divisions.cur().ad_domain || "" };
        const by = {};
        (res.devices || []).forEach(d => { by[(d.serial || "").toUpperCase() + "|" + (d.hostname || "").toLowerCase()] = d; });
        Drill._rows.forEach(r => { r._living = by[(r.serial || "").toUpperCase() + "|" + (r.device_name || "").toLowerCase()] || {}; });
        // Footer: offer to retire the fully-orphaned devices, or explain why we can't.
        const checkable = !res.ad_error && res.entra_state === "on" && res.intune_ok;
        const orphans = Drill._rows.filter(r => r._living && !r._living.in_ad && !r._living.in_entra && !r._living.in_intune);
        if (!checkable) {
          const why = res.ad_error ? "on-prem AD isn't reachable — are you on the corporate network / VPN?"
            : res.entra_state !== "on" ? "the Entra check is unavailable (needs Directory.Read.All consent)"
              : "the Intune check failed";
          Drill._opts.footerHtml = `<span class="cfg-warn" style="margin:0">Can't auto-retire right now — ${why}. Devices only move to the Boneyard when AD, Entra and Intune are all verifiable, so a live machine is never retired by mistake.</span>`;
        } else if (orphans.length) {
          Drill._opts.footerHtml = `<span class="hint" style="margin:0">${orphans.length} device(s) are gone from AD, Entra and Intune.</span>
            <button class="primary" style="background:var(--red);border-color:var(--red);white-space:nowrap" onclick="Dashboard.retireOrphans()">🪦 Retire ${orphans.length} to Boneyard</button>`;
        } else {
          Drill._opts.footerHtml = `<span class="hint" style="margin:0">Every device here still exists in at least one system.</span>`;
        }
        Drill._render();
      }
    } catch (e) { /* leave the "checking…" placeholders */ }
  },
  async retireOrphans() {
    const btn = document.querySelector("#modalRoot .modal-foot .primary");
    if (btn) { btn.disabled = true; btn.textContent = "Retiring…"; }
    let r;
    try { r = await Backend.call("boneyard_sweep"); } catch (e) { r = null; }
    if (!r || !r.ok) { App.toast((r && r.error) || "Retire failed.", true); if (btn) { btn.disabled = false; } return; }
    if (r.skipped) { App.toast("Skipped — " + r.skipped, true); if (btn) { btn.disabled = false; btn.textContent = "🪦 Retire to Boneyard"; } return; }
    const moved = (r.added || []).length, back = (r.restored || []).length;
    App.toast(moved || back ? `${moved} retired to Boneyard${back ? ` · ${back} restored` : ""}.` : "Nothing needed retiring.");
    Drill.close();
    await this.load();   // refresh the dashboard; the stale list now excludes retired devices
  },
  _livingRank(r) {           // for sorting the Living-in column: fewer systems = more orphaned = first
    const v = r._living; if (!v || r._living === null) return 99;
    return (v.in_ad ? 1 : 0) + (v.in_entra ? 1 : 0) + (v.in_intune ? 1 : 0);
  },
  _livingCell(r) {
    const v = r._living;
    if (v === null || v === undefined) return `<span class="muted">checking…</span>`;
    const st = this._livingState || {};
    const chip = (label, state, tip) => `<span class="liv liv-${state}" title="${attr(tip)}">${label}</span>`;
    // AD
    let ad;
    if (st.ad_error) ad = chip("AD", "unk", "On-prem AD unavailable: " + st.ad_error);
    else if (v.in_ad) ad = chip("AD", "ok", `In ${st.domain}${v.ad_enabled === false ? " · DISABLED" : ""}${v.ad_last_logon ? " · last logon " + v.ad_last_logon : ""}`);
    else ad = chip("AD", "no", `Not found in ${st.domain}`);
    // Entra
    let entra;
    if (st.entra === "on") entra = v.in_entra
      ? chip("Entra", "ok", `In Entra${v.entra_enabled === false ? " · DISABLED" : ""}${v.entra_last_signin ? " · last sign-in " + v.entra_last_signin : ""}`)
      : chip("Entra", "no", "Not found in Entra");
    else entra = chip("Entra", "unk", "Entra check unavailable — " + (st.entra || "off") + " (grant Directory.Read.All)");
    // Intune
    const intune = v.in_intune
      ? chip("Intune", "ok", `In Intune${v.intune_last_sync ? " · last sync " + v.intune_last_sync : ""}`)
      : chip("Intune", "no", "Not in Intune (managed object removed)");
    return `<span class="liv-set">${ad}${entra}${intune}</span>`;
  },
  drillNoMfa() { People.focus("No"); },
  drillNotNbgw() {
    const inv = this._inv();
    Drill.open("Not part of " + Divisions.label(), inv.not_nbgw || [], [
      { label: "Serial", get: r => r.serial, mono: 1 }, { label: "Model", get: r => r.model },
      { label: "Primary user", get: r => r.user }, { label: "Office location", get: r => r.office }],
      { chips: inv.not_nbgw_by_office, empty: "No devices outside " + Divisions.label() + " (" + Divisions.codes().join("/") + ") yet — fills in once directory access is granted and a sync resolves each user's location." });
  },
  drillSite(list, key) {
    // The dashboard buckets a blank site as "—"; rows store it as "". Treat both as "no site".
    const blank = !key || key === "—";
    const rows = (App.state[list] || []).filter(r =>
      blank ? !(r.site_tag || "").trim() : (r.site_tag || "") === key);
    const cols = list === "use"
      ? [{ label: "Serial", get: r => r.serial, mono: 1 }, { label: "Device name", get: r => r.device_name }, { label: "Model", get: r => r.model }, { label: "User", get: r => r.user }, { label: "Site", get: r => r.site_tag }]
      : [{ label: "Serial", get: r => r.serial, mono: 1 }, { label: "Model", get: r => r.model }, { label: "Added", get: r => r.date_added }];
    const label = blank ? "No site" : key;
    Drill.open(`${list === "use" ? "In use" : "In stock"} · ${label}`, rows, cols,
      { empty: blank ? "No devices without a site." : `No devices at ${key}.` });
  },
  _stockCols: [
    { label: "Serial", get: r => r.serial, mono: 1 }, { label: "Model", get: r => r.model },
    { label: "CPU", get: r => r.cpu }, { label: "RAM", get: r => r.ram },
    { label: "Site", get: r => r.site_tag }, { label: "Added", get: r => r.date_added }],
  _siteKey(v) { return Divisions.bucket(v); },

  drillDept(dept) { this._deptDrill(dept, null); },
  drillDeptSite(dept, siteKey) { this._deptDrill(dept, siteKey); },
  // In-stock drill for a department (optionally a site) with a per-row Department
  // dropdown so you can (re)assign a device's department right here.
  _deptDrill(dept, siteKey) {
    this._ddDept = dept; this._ddSite = siteKey;
    this._renderDeptDrill();
  },
  _renderDeptDrill() {
    const dept = this._ddDept, siteKey = this._ddSite;
    const rows = (App.state.stock || []).filter(r =>
      Depts.deptFor(r.model) === dept && (!siteKey || this._siteKey(r.site_tag) === siteKey));
    const opt = curr => `<option value=""${(!curr || curr === "Unassigned") ? " selected" : ""}>Unassigned</option>` +
      (Depts.departments || []).map(d => `<option value="${attr(d)}"${d === curr ? " selected" : ""}>${esc(d)}</option>`).join("");
    const title = `In stock · ${dept}${siteKey ? " · " + siteKey : ""}`;
    const body = rows.length ? `<table><thead><tr><th>Serial</th><th>Model</th><th>Specs</th><th>Site</th><th>Department</th></tr></thead><tbody>` +
      rows.map(r => `<tr>
        <td class="mono">${esc(r.serial)}</td><td>${esc(r.model)}</td>
        <td>${esc([r.cpu, r.ram, r.storage].filter(Boolean).join(" · "))}</td>
        <td>${esc(r.site_tag)}</td>
        <td><select class="dd-select" onchange="Dashboard.assignDept('${attr(r.model)}', this.value)">${opt(Depts.deptFor(r.model))}</select></td>
      </tr>`).join("") + `</tbody></table>`
      : `<div class="empty">No devices here.</div>`;
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal" style="width:860px;max-width:94vw;">
        <div class="modal-head"><h3>${esc(title)} — ${rows.length}</h3><button onclick="Drill.close()">&times;</button></div>
        <div class="modal-body" style="max-height:70vh;overflow:auto;">
          ${Help.box("set-models")}
          ${body}</div></div></div>`;
  },
  async assignDept(model, dept) {
    const map = { ...(Depts.map || {}) };
    if (dept && dept !== "Unassigned") map[model] = dept; else delete map[model];
    const r = await Backend.call("hub_save_departments", { departments: Depts.departments || [], map },
      { action: "assign", target: "Model departments", detail: `${model} → ${dept || "Unassigned"}` });
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not save the department.", true);
    Depts.map = map;
    App.toast(`${model} → ${dept || "Unassigned"}.`);
    this._renderDeptDrill();   // the reassigned rows drop out of this view
    this.load();               // refresh the dashboard card counts behind the modal
  },
  drillWarrantyBucket(bucket) {
    const all = (App.state.use || []).concat(App.state.stock || []);
    const inb = days => bucket === "expired" ? days < 0
      : bucket === "d0_30" ? (days >= 0 && days <= 30)
        : bucket === "d31_90" ? (days > 30 && days <= 90)
          : bucket === "d91_180" ? (days > 90 && days <= 180)
            : bucket === "beyond" ? days > 180 : false;
    const rows = all.map(r => ({ r, d: warrantyDays(r.warranty) }))
      .filter(x => bucket === "none" ? x.d === null : (x.d !== null && inb(x.d)))
      .map(x => ({ serial: x.r.serial, model: x.r.model, user: x.r.user || "", warranty: x.r.warranty || "", days: x.d }));
    const labels = { expired: "Expired warranties", d0_30: "Warranty ≤ 30 days", d31_90: "Warranty 31–90 days", d91_180: "Warranty 91–180 days", beyond: "Warranty > 180 days", none: "No warranty date" };
    Drill.open(labels[bucket] || "Warranty", rows, [
      { label: "Serial", get: r => r.serial, mono: 1 }, { label: "Model", get: r => r.model }, { label: "User", get: r => r.user },
      { label: "Warranty", get: r => r.warranty }, { label: "When", get: r => r.days == null ? "—" : (r.days < 0 ? `expired ${-r.days}d ago` : `in ${r.days}d`) }]);
  },
};

/* ---- Hot Spares --------------------------------------------------------------
   Imaged, ready-to-deploy loaner/emergency machines, grouped by site (LTR/BRI) x
   department (Detailing / Engineering / Estimating·PCs·Other). Records are logged
   in the shared hub store; live specs, OS install, last check-in and compliance are
   joined from Intune. Each entry expands (+) to full detail like the Devices tables. */
const HotSpares = {
  /* Departments are a per-division list (Settings > General > Hot spare departments); "Other" is always last.
     A division that never set its own list keeps the original three. */
  get DEPTS() {
    const own = (Tz.prefs && Tz.prefs.hot_spare_depts) || [];
    if (!own.length) return [{ key: "Detailing", label: "Detailing" }, { key: "Engineering", label: "Engineering" }, { key: "Other", label: "Estimating / PCs / Other" }];
    return own.map(n => ({ key: n, label: n })).concat([{ key: "Other", label: "Other" }]);
  },
  get SITES() { return Divisions.codes(); },
  _spares: [],
  _expanded: {},
  _modalOpen: false,

  _siteCounts() {
    const c = {}; this.SITES.forEach(s => c[s] = 0);
    (this._spares || []).forEach(hs => {
      const site = this.SITES.includes((hs.site || "").toUpperCase()) ? (hs.site || "").toUpperCase() : this.SITES[0];
      c[site]++;
    });
    return c;
  },
  // Small dashboard stat tile: total count + per-site split; click opens the window.
  tileHtml(inv) {
    this._spares = (inv && inv.hot_spares) || [];
    const total = this._spares.length;
    const warn = this._spares.filter(h => h.stale || h.noncompliant).length;
    const c = this._siteCounts();
    const sites = this.SITES.map(s => `${s} <b>${c[s]}</b>`).join(" · ");
    return `<div class="stat clickable hs-tile${warn ? " warn" : ""}" id="hotSparesTile" onclick="HotSpares.openModal()">
      <div class="n">${total}</div>
      <div class="l">Hot spares ›</div>
      <div class="hs-tile-sites">${sites}${warn ? ` · <span class="hs-warn-txt">${warn}⚠</span>` : ""}</div></div>`;
  },
  _updateTile() {
    const tile = document.getElementById("hotSparesTile");
    if (tile && Dashboard._data && Dashboard._data.inventory) {
      Dashboard._data.inventory.hot_spares = this._spares;   // keep dashboard data in sync
      tile.outerHTML = this.tileHtml(Dashboard._data.inventory);
    }
  },
  // The pop-up window: the full LTR|BRI x department breakdown with expandable entries.
  async openModal() {
    this._modalOpen = true;
    this._renderModal();                       // instant, from whatever we have
    try { const r = await Backend.call("get_hot_spares"); if (r && r.ok) { this._spares = r.spares || []; this._renderModal(); this._updateTile(); } }
    catch (e) { /* keep what we have */ }
  },
  _renderModal() {
    if (!this._modalOpen) return;
    const bySite = {}; this.SITES.forEach(s => bySite[s] = {});
    this._spares.forEach(hs => {
      const site = this.SITES.includes((hs.site || "").toUpperCase()) ? (hs.site || "").toUpperCase() : this.SITES[0];
      const dept = this.DEPTS.some(d => d.key === hs.dept) ? hs.dept : "Other";
      (bySite[site][dept] = bySite[site][dept] || []).push(hs);
    });
    const total = this._spares.length;
    const warn = this._spares.filter(h => h.stale || h.noncompliant).length;
    const cols = this.SITES.map(s => this._siteCol(s, bySite[s])).join("");
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal hs-modal" style="width:960px;max-width:96vw;">
        <div class="modal-head"><h3>Hot Spares — imaged &amp; ready to deploy</h3><button onclick="HotSpares._close()">&times;</button></div>
        <div class="modal-body">
          ${Help.box("hotspares")}
          <div class="hs-modal-bar">
            <p class="sub-note" style="margin:0">${total} ready spare${total === 1 ? "" : "s"} for emergency swaps / loaners${warn ? ` · <span class="hs-warn-txt">${warn} need attention</span>` : ""}.</p>
            <button class="primary" onclick="HotSpares.openAdd()">＋ Add hot spare</button>
          </div>
          <div class="hs-grid">${cols}</div>
        </div>
      </div></div>`;
  },
  _siteCol(site, byDept) {
    byDept = byDept || {};
    const sections = this.DEPTS.map(d => {
      const list = byDept[d.key] || [];
      const rows = list.length ? list.map(hs => this._entry(hs)).join("") : `<div class="hs-empty">No spares</div>`;
      return `<div class="hs-dept"><div class="hs-dept-h">${esc(d.label)}<span class="hs-count">${list.length}</span></div>${rows}</div>`;
    }).join("");
    return `<div class="hs-site"><div class="hs-site-h"><span class="hs-site-tag ${Divisions.cls(site)}">${esc(site)}</span></div>${sections}</div>`;
  },
  _entry(hs) {
    const open = !!this._expanded[hs.id];
    const badges = [
      hs.noncompliant ? `<span class="hs-badge bad" title="Intune compliance: ${attr(hs.compliance || "")}">out of compliance</span>` : "",
      hs.stale ? `<span class="hs-badge warn" title="Last Intune check-in ${hs.stale_days} days ago">no check-in ${hs.stale_days}d</span>` : "",
    ].filter(Boolean).join("");
    const name = hs.hostname || hs.serial || "(unnamed)";
    return `<div class="hs-entry${open ? " open" : ""}">
      <div class="hs-row">
        <button class="hs-plus" onclick="HotSpares.toggle('${attr(hs.id)}')" title="${open ? "Hide" : "Show"} details">${open ? "−" : "+"}</button>
        <span class="hs-name" title="${attr(name)}">${esc(name)}</span>
        <span class="hs-model" title="${attr(hs.model || "")}">${esc(hs.model || "—")}</span>
        <span class="hs-badges">${badges}</span>
      </div>${open ? this._detail(hs) : ""}</div>`;
  },
  _detail(hs) {
    const dd = s => (s || "").slice(0, 10) || "—";
    const f = (l, v) => `<div class="hs-f"><span class="hs-fl">${l}</span><span class="hs-fv">${esc(v == null || v === "" ? "—" : v)}</span></div>`;
    const ci = dd(hs.last_checkin) + (hs.stale_days != null ? ` (${hs.stale_days}d ago)` : "");
    return `<div class="hs-detail">
      <div class="hs-fgrid">
        ${f("Serial", hs.serial)}${f("Hostname", hs.hostname)}${f("Model", hs.model)}
        ${f("CPU", hs.cpu)}${f("RAM", hs.ram)}${f("Storage", hs.storage)}
        ${f("OS", hs.os_version)}${f("OS install", dd(hs.os_install))}
        <div class="hs-f"><span class="hs-fl">Last check-in</span><span class="hs-fv${hs.stale ? " bad" : ""}">${esc(ci)}</span></div>
        <div class="hs-f"><span class="hs-fl">Compliance</span><span class="hs-fv${hs.noncompliant ? " bad" : ""}">${esc(hs.compliance || "—")}</span></div>
        ${f("Warranty", dd(hs.warranty))}${f("Found in", hs.found_in)}
      </div>
      <div class="hs-notes"><span class="hs-fl">Notes / holding location</span><div class="hs-notes-v">${hs.notes ? esc(hs.notes) : `<span class="muted">—</span>`}</div></div>
      <div class="hs-meta">Added by ${esc(hs.added_by || "—")}${hs.added_at ? " · " + dd(hs.added_at) : ""}${hs.updated_by && hs.updated_by !== hs.added_by ? ` · updated by ${esc(hs.updated_by)}` : ""}</div>
      <div class="hs-actions"><button class="rowbtn" onclick="HotSpares.openEdit('${attr(hs.id)}')">✎ Edit</button>
        <button class="rowbtn danger" onclick="HotSpares.remove('${attr(hs.id)}')">✕ Remove</button></div>
    </div>`;
  },
  toggle(id) { this._expanded[id] = !this._expanded[id]; this._renderModal(); },
  async refresh() {
    try { const r = await Backend.call("get_hot_spares"); if (r && r.ok) this._spares = r.spares || []; }
    catch (e) { /* leave current */ }
    if (this._modalOpen) this._renderModal();
    this._updateTile();
  },

  openAdd() { this._openForm(null); },
  openEdit(id) { this._openForm(this._spares.find(s => s.id === id)); },
  // From the In Use table: move a device back to In Stock AND log it as a hot spare.
  openMove(serial) {
    const dev = (App.state.use || []).find(x => x.serial === serial) || { serial };
    const site = this.SITES.includes((dev.site_tag || "").toUpperCase()) ? dev.site_tag.toUpperCase() : this.SITES[0];
    const siteOpts = this.SITES.map(s => `<option${s === site ? " selected" : ""}>${s}</option>`).join("");
    const deptOpts = this.DEPTS.map(d => `<option value="${attr(d.key)}">${esc(d.label)}</option>`).join("");
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal" style="width:540px;max-width:94vw;">
        <div class="modal-head"><h3>Move to Hot Spare</h3><button onclick="HotSpares._close()">&times;</button></div>
        <div class="modal-body">
          <p style="margin-top:0;color:var(--muted);font-size:13px;">Moves <b>${esc(dev.device_name || dev.serial)}</b> from In Use back to In Stock and logs it as a ready hot spare — held out of the In Stock count.</p>
          <div class="fields">
            <div class="field"><label>Site</label><select id="hsSite">${siteOpts}</select></div>
            <div class="field"><label>Department</label><select id="hsDept">${deptOpts}</select></div>
          </div>
          <div class="field" style="margin-top:12px"><label>Notes / holding location</label>
            <textarea id="hsNotes" class="setup-notes" rows="3" placeholder="Where it's stored, image version, any caveats…"></textarea></div>
        </div>
        <div class="modal-foot">
          <button class="ghost" onclick="HotSpares._close()">Cancel</button>
          <button class="primary" onclick="HotSpares.saveMove('${attr(dev.serial)}','${attr(dev.device_name || "")}')">Move to Hot Spare</button>
        </div>
      </div></div>`;
  },
  async saveMove(serial, hostname) {
    const site = document.getElementById("hsSite").value;
    const dept = document.getElementById("hsDept").value;
    const notes = (document.getElementById("hsNotes").value || "").trim();
    const btn = document.querySelector("#modalRoot .modal-foot .primary"); if (btn) btn.disabled = true;
    const r1 = await Backend.call("return_to_stock", serial, "Moved to hot spare pool");
    if (!r1 || !r1.ok) { if (btn) btn.disabled = false; return App.toast((r1 && r1.error) || "Move to stock failed.", true); }
    const r2 = await Backend.call("add_hot_spare", { serial, hostname, site, dept, notes });
    this._close();
    if (!r2 || !r2.ok) { await App.reload(); return App.toast((r2 && r2.error) || "Moved to stock, but hot-spare logging failed.", true); }
    App.toast("Moved to In Stock and logged as a hot spare.");
    await App.reload();
    try { await this.refresh(); } catch (e) { /* dashboard card not mounted */ }
  },
  _openForm(hs) {
    const isEdit = !!hs;
    const site = hs ? (hs.site || Divisions.codes()[0] || "") : (Divisions.codes()[0] || ""), dept = hs ? (hs.dept || "Detailing") : "Detailing";
    const siteOpts = this.SITES.map(s => `<option${s === site ? " selected" : ""}>${s}</option>`).join("");
    const deptOpts = this.DEPTS.map(d => `<option value="${attr(d.key)}"${d.key === dept ? " selected" : ""}>${esc(d.label)}</option>`).join("");
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal" style="width:540px;max-width:94vw;">
        <div class="modal-head"><h3>${isEdit ? "Edit" : "Add"} hot spare</h3><button onclick="HotSpares._back()">&times;</button></div>
        <div class="modal-body">
          <div class="fields">
            <div class="field"><label>Site</label><select id="hsSite">${siteOpts}</select></div>
            <div class="field"><label>Department</label><select id="hsDept">${deptOpts}</select></div>
          </div>
          <div class="fields" style="margin-top:12px">
            <div class="field"><label>Serial number</label><input id="hsSerial" placeholder="Device serial (matched to Intune)" autocomplete="off" value="${attr(hs ? hs.serial : "")}"></div>
            <div class="field"><label>Hostname (optional)</label><input id="hsHost" placeholder="e.g. BGLTRSPARE01" autocomplete="off" value="${attr(hs ? hs.hostname : "")}"></div>
          </div>
          <div class="field" style="margin-top:12px"><label>Notes / holding location</label>
            <textarea id="hsNotes" class="setup-notes" rows="3" placeholder="Where it's stored, image version, any caveats…">${hs ? esc(hs.notes) : ""}</textarea></div>
          <p class="hint" style="margin-top:8px">Specs, OS install, last check-in, and compliance are pulled live from Intune by serial.</p>
        </div>
        <div class="modal-foot">
          <button class="ghost" onclick="HotSpares._back()">Cancel</button>
          <button class="primary" onclick="HotSpares.save('${isEdit ? attr(hs.id) : ""}')">${isEdit ? "Save changes" : "Add spare"}</button>
        </div>
      </div></div>`;
    setTimeout(() => { const el = document.getElementById("hsSerial"); if (el) el.focus(); }, 30);
  },
  _close() { this._modalOpen = false; document.getElementById("modalRoot").innerHTML = ""; },
  // Cancel/× on a sub-form: return to the list window if it was open, else fully close.
  _back() { if (this._modalOpen) this._renderModal(); else this._close(); },
  async save(id) {
    const entry = {
      serial: (document.getElementById("hsSerial").value || "").trim(),
      hostname: (document.getElementById("hsHost").value || "").trim(),
      site: document.getElementById("hsSite").value,
      dept: document.getElementById("hsDept").value,
      notes: (document.getElementById("hsNotes").value || "").trim(),
    };
    if (!entry.serial && !entry.hostname) return App.toast("Enter a serial or hostname first.", true);
    const r = id ? await Backend.call("update_hot_spare", id, entry) : await Backend.call("add_hot_spare", entry);
    if (!r || !r.ok) return App.toast((r && r.error) || "Save failed.", true);
    App.toast(id ? "Hot spare updated." : "Hot spare added.");
    await this.refresh();   // re-renders the list window (and the dashboard tile)
  },
  remove(id) {
    const hs = this._spares.find(s => s.id === id);
    const name = hs ? (hs.hostname || hs.serial || "this spare") : "this spare";
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal" style="width:440px;max-width:94vw;">
        <div class="modal-head"><h3>Remove hot spare</h3><button onclick="HotSpares._back()">&times;</button></div>
        <div class="modal-body"><p style="margin:0">Remove <b>${esc(name)}</b> from the hot spares list? This only takes it off the list — the device itself isn't touched.</p></div>
        <div class="modal-foot"><button class="ghost" onclick="HotSpares._back()">Cancel</button>
          <button class="primary" style="background:var(--red);border-color:var(--red)" onclick="HotSpares._doRemove('${attr(id)}')">Remove</button></div>
      </div></div>`;
  },
  async _doRemove(id) {
    const r = await Backend.call("remove_hot_spare", id, "");
    if (!r || !r.ok) return App.toast((r && r.error) || "Remove failed.", true);
    App.toast("Hot spare removed.");
    await this.refresh();
  },
};

/* ---- BG Tools ----------------------------------------------------------------
   A pop-out of database/admin utilities under Software. First tool: Timesheet Fix —
   search an employee, see the last 8 weeks' timesheet lock status, and unlock a week
   (sets NBSTimesheet.dbo.WeekLocked.Locked = 0). SQL runs as the signed-in user
   (integrated auth); every unlock is confirmed and audited. */
/* ---- BG Tools: Copy Permissions (on-prem AD groups) ---- */
/* ---- the admin account used to write to AD: found on the inserted YubiKey (shown as buttons), remembered, editable ---- */
const AdKey = {
  KEY: "nbg_ad_admin_acct",
  html(p) {
    return `<div class="field cp-acct" style="max-width:560px;margin-top:14px"><label>Your admin account for writing (YubiKey)</label>
      <input id="${p}Acct" placeholder="adm.name.pa" autocomplete="off" oninput="AdKey.mark('${p}')">
      <div class="ak-chips" id="${p}Chips"></div><div class="sub-note" id="${p}Note" style="margin:4px 0 0">Looking for your YubiKey…</div></div>`;
  },
  value(p) { return ((document.getElementById(p + "Acct") || {}).value || "").trim(); },
  remember(p) { try { localStorage.setItem(this.KEY, this.value(p)); } catch (e) {} },
  /* adm.sanderson.azure@nucor.onmicrosoft.com -> adm.sanderson.pa ; sims.anderson@nucor.com -> adm.sanderson.pa */
  guess(upn) {
    const parts = String(upn || "").split("@")[0].toLowerCase().split(".").filter(Boolean);
    if (!parts.length) return "";
    if (parts[0] === "adm") return parts.length > 2 ? "adm." + parts.slice(1, -1).join(".") + ".pa" : "";
    return parts.length > 1 ? "adm." + parts[0][0] + parts[parts.length - 1] + ".pa" : "";
  },
  async init(p) {
    const el = document.getElementById(p + "Acct"); if (!el) return;
    let saved = ""; try { saved = localStorage.getItem(this.KEY) || ""; } catch (e) {}
    const who = () => (App.state && (App.state.upn || App.state.account)) || (document.getElementById("acct") || {}).textContent || "";
    el.value = saved || this.guess(who());
    if (!el.value) Backend.call("get_status").then(st => { const g = this.guess((st && (st.upn || st.account)) || ""); if (el && !el.value && g) el.value = g; });
    await this.scan(p, !!saved);
  },
  async scan(p, haveSaved) {
    const r = await Backend.call("ad_smartcard_accounts");
    const el = document.getElementById(p + "Acct"), chips = document.getElementById(p + "Chips"), note = document.getElementById(p + "Note");
    if (!el || !chips) return;
    const list = (r && r.ok && r.accounts) || [];
    this._list = list;
    chips.innerHTML = list.map(a => `<button type="button" class="ak-chip" data-upn="${attr(a.upn)}" title="${attr(a.cn)} · expires ${attr(a.expires)}" onclick="AdKey.pick('${p}','${attr(a.upn)}')">${esc(a.upn)}</button>`).join("");
    if (!list.length) { note.innerHTML = `No YubiKey certificate found. Insert the key, or type the account. <a style="cursor:pointer;color:var(--amber)" onclick="AdKey.scan('${p}')">Look again</a>`; return; }
    note.textContent = list.length + " account" + (list.length === 1 ? "" : "s") + " on your key: click one to use it.";
    if (!haveSaved) {                                                   // better than a guess: the key's own account for this person
      const base = (el.value || "").split("@")[0].toLowerCase();
      const m = list.find(a => a.upn.split("@")[0].toLowerCase() === base) || (list.length === 1 ? list[0] : null);
      if (m) el.value = m.upn;
    }
    this.mark(p);
  },
  pick(p, upn) { const el = document.getElementById(p + "Acct"); if (el) el.value = upn; this.mark(p); },
  mark(p) { const v = this.value(p).toLowerCase(); document.querySelectorAll("#" + p + "Chips .ak-chip").forEach(b => b.classList.toggle("on", b.dataset.upn.toLowerCase() === v)); },
};
const localStorageGet = k => { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } };
const CopyPerms = {
  s: { src: null, dst: null, cmp: null, picked: {}, res: null }, _t: {},
  render(p) {
    this.s = { src: null, dst: null, cmp: null, picked: {}, res: null };
    p.innerHTML = `<div class="chart-card">
      <h4 style="margin:0 0 4px">Copy Permissions</h4>${Help.box("bgt-copyperms")}
      <label class="cp-all"><input type="checkbox" id="cpAll"> Include people from other divisions</label>
      <div class="cp-pick">${["src", "dst"].map(w => `<div class="field"><label>${w === "src" ? "Copy FROM (source)" : "Copy TO (destination)"}</label>
        <input id="cp-${w}" placeholder="Type a name or account…" autocomplete="off" oninput="CopyPerms.typed('${w}')">
        <div class="cp-hits" id="cp-hits-${w}"></div><div class="cp-chosen" id="cp-chosen-${w}"></div></div>`).join("")}</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="primary" id="cpCmp" onclick="CopyPerms.compare()" disabled>Compare</button>
        <span class="sub-note" id="cpMsg" style="margin:0"></span></div>
      <div id="cpOut"></div>
      ${AdKey.html("cp")}</div>`;
    AdKey.init("cp");
  },
  typed(w) {
    clearTimeout(this._t[w]);
    const q = document.getElementById("cp-" + w).value.trim();
    const box = document.getElementById("cp-hits-" + w);
    if (q.length < 2) { box.innerHTML = ""; return; }
    this._t[w] = setTimeout(async () => {
      box.innerHTML = `<div class="sub-note">Searching AD…</div>`;
      const r = await Backend.call("ad_user_search", q, !!(document.getElementById("cpAll") || {}).checked);
      if (!r || !r.ok) { box.innerHTML = `<div class="sub-note" style="color:var(--red)">${esc((r && r.error) || "Search failed.")}</div>`; return; }
      this._hits = this._hits || {}; this._hits[w] = r.users;
      box.innerHTML = r.users.length ? r.users.map((u, i) => `<div class="cp-hit" onclick="CopyPerms.pick('${w}',${i})"><b>${esc(u.name || u.sam)}</b>
        <span>${esc(u.sam)}${u.title ? " · " + esc(u.title) : ""}${u.dept ? " · " + esc(u.dept) : ""}${u.enabled ? "" : " · disabled"}</span></div>`).join("") : `<div class="sub-note">No one found.</div>`;
    }, 350);
  },
  pick(w, i) {
    this.s[w] = this._hits[w][i]; this.s.cmp = null; this.s.res = null;
    document.getElementById("cp-hits-" + w).innerHTML = "";
    document.getElementById("cp-" + w).value = "";
    document.getElementById("cp-chosen-" + w).innerHTML = `<span class="cp-chip">${esc(this.s[w].name || this.s[w].sam)} <i>${esc(this.s[w].sam)}</i></span>`;
    document.getElementById("cpCmp").disabled = !(this.s.src && this.s.dst);
    document.getElementById("cpOut").innerHTML = "";
  },
  async compare() {
    const { src, dst } = this.s;
    if (!src || !dst) return;
    const msg = document.getElementById("cpMsg");
    let r; await Ui.working(document.getElementById("cpCmp"), "Reading AD groups…", async () => { r = await Backend.call("ad_perm_compare", src.dn, dst.dn); return false; });   // false = always restore the button
    if (!r || !r.ok) { msg.textContent = (r && r.error) || "Compare failed."; msg.style.color = "var(--red)"; return; }
    msg.textContent = ""; this.s.cmp = r; this.s.picked = {}; this.s.res = null;
    // nothing is ticked for you: choose the groups to copy
    this.draw();
  },
  grp(g, sel) {
    const tag = (g.privileged ? ` <span class="cp-tag red">privileged</span>` : "") + (g.security === false ? ` <span class="cp-tag">distribution</span>` : "");
    return `<label class="cp-g"><input type="checkbox" ${sel ? `${this.s.picked[g.dn] ? "checked" : ""} onchange="CopyPerms.tick(this,'${attr(g.dn)}')"` : "disabled"}>
      <span><b>${esc(g.name)}</b>${tag}<small>${esc(g.desc || "")}</small></span></label>`;
  },
  tick(el, dn) { if (el.checked) this.s.picked[dn] = true; else delete this.s.picked[dn]; this.draw(); },
  tickAll(on) { this.s.cmp.only_src.forEach(g => { if (on === "safe" ? !g.privileged : on) this.s.picked[g.dn] = true; else delete this.s.picked[g.dn]; }); this.draw(); },
  draw() {
    const c = this.s.cmp, n = Object.keys(this.s.picked).length, o = document.getElementById("cpOut");
    const col = (title, list, sel, extra) => `<div class="cp-col"><h5>${title} <span>${list.length}</span></h5>${extra || ""}<div class="cp-list">${list.length ? list.map(g => this.grp(g, sel)).join("") : `<div class="sub-note">None</div>`}</div></div>`;
    o.innerHTML = `<div class="cp-cols">
      ${col("Only " + esc(this.s.src.sam) + " has", c.only_src, true, `<div class="cp-bulk"><a onclick="CopyPerms.tickAll('safe')">Select all (not privileged)</a> · <a onclick="CopyPerms.tickAll(false)">None</a></div>`)}
      ${col("Both have", c.both, false)}
      ${col("Only " + esc(this.s.dst.sam) + " has", c.only_dst, false)}</div>
      <div class="cp-actions"><button class="ghost" id="cpPrev" ${n ? "" : "disabled"} onclick="CopyPerms.go(false)">Preview (${n})</button>
        <button class="primary" id="cpGo" ${n ? "" : "disabled"} onclick="CopyPerms.go(true)">Copy ${n} group${n === 1 ? "" : "s"} to ${esc(this.s.dst.sam)}…</button></div>
      <div id="cpRes">${this.s.res || ""}</div>`;
  },
  resultHtml(r) {
    const nm = x => x.name || (x.dn || "").split(",")[0].replace(/^CN=/i, "");
    if (!r || !r.ok) return `<div class="cp-res bad">${esc((r && r.error) || "Failed.")}</div>`;
    const skip = (r.skipped || []).length ? " Skipped: " + esc(r.skipped.map(x => nm(x) + " (" + x.why + ")").join("; ")) : "";
    if (!r.committed) return `<div class="cp-res">Would add ${r.would_add.length}: ${esc(r.would_add.join(", ") || "nothing")}.${skip}</div>`;
    return `<div class="cp-res ${r.failed.length ? "bad" : "good"}">Added ${r.added.length}${r.who ? " as " + esc(r.who) : ""}${r.dc ? " on " + esc(r.dc) : ""}: ${esc(r.added.join(", ") || "none")}.${skip}
      ${r.failed.length ? "<br>Failed: " + esc(r.failed.map(f => f.name + " — " + f.error).join("; ")) : ""}${r.unverified.length ? "<br>Accepted by AD; some domain controllers may take a few minutes to show it: " + esc(r.unverified.join(", ")) : ""}</div>`;
  },
  async go(commit) {
    const { src, dst } = this.s, dns = Object.keys(this.s.picked);
    const acct = AdKey.value("cp");
    if (commit) {
      if (!acct) { App.toast("Enter your admin account (for example adm.name.pa) first.", true); return; }
      AdKey.remember("cp");
      if (!confirm(`Add ${dst.name || dst.sam} to ${dns.length} AD group(s) copied from ${src.name || src.sam}?\n\nA PIN window opens (look in the taskbar if you do not see it). You enter the PIN once, there.`)) return;
    }
    const btn = document.getElementById(commit ? "cpGo" : "cpPrev");
    let r; await Ui.working(btn, commit ? "Waiting for the PIN window…" : "Checking…", async () => { r = await Backend.call("ad_perm_copy", src.dn, dst.dn, dns, acct, commit); return false; });
    const h = this.resultHtml(r);
    this.s.res = h;
    if (commit && r && r.ok && r.committed) { await this.compare(); this.s.res = h; this.draw(); } else document.getElementById("cpRes").innerHTML = h;
  },
};

const BGTools = {
  _emp: null, _weeks: [], _sel: null, _found: [], _tool: null,
  _perm: { user: null, groups: [], found: [] },
  TOOLS: [
    { id: "timesheet", name: "Timesheet Fix", icon: "🔓", desc: "Unlock a timesheet week for an employee" },
    { id: "perms", name: "Permissions Finder", icon: "🔑", desc: "Find every group a teammate is in — direct + nested" },
    { id: "copyperms", name: "Copy Permissions", icon: "🧬", desc: "Compare two people's AD groups and copy groups from one to the other" },
    { id: "missing", name: "Missing Groups", icon: "🧩", desc: "Find groups a teammate or department is missing vs. peers" },
  ],
  _miss: { mode: "user", user: null, found: [], depts: [], company: "" },
  load() {
    const host = document.getElementById("bgtHost"); if (!host) return;
    this._tool = null;   // start on a clean launcher; a tool's panel shows only once clicked
    host.innerHTML =
      `<div class="bgt-launch">` + this.TOOLS.map(t => `<button class="bgt-tool" data-tool="${attr(t.id)}" onclick="BGTools.openTool('${attr(t.id)}')">
        <span class="bgt-tool-ic">${t.icon}</span><span class="bgt-tool-txt"><b>${esc(t.name)}</b><span>${esc(t.desc)}</span></span></button>`).join("") + `</div>
      <div id="bgtPanel" class="bgt-panel"><div class="empty">Pick a tool above to get started.</div></div>`;
  },
  openTool(id) {
    const p = document.getElementById("bgtPanel"); if (!p) return;
    if (this._tool === id) {   // clicking the open tool again hides it
      this._tool = null;
      document.querySelectorAll("#bgtHost .bgt-tool").forEach(el => el.classList.remove("active"));
      p.innerHTML = `<div class="empty">Pick a tool above to get started.</div>`;
      return;
    }
    this._tool = id;
    document.querySelectorAll("#bgtHost .bgt-tool").forEach(el => el.classList.toggle("active", el.dataset.tool === id));
    if (id === "timesheet") this._renderTimesheet(p);
    else if (id === "perms") this._renderPerms(p);
    else if (id === "missing") this._renderMissing(p);
    else if (id === "copyperms") CopyPerms.render(p);
  },
  _renderTimesheet(p) {
    this._emp = null; this._weeks = []; this._sel = null;
    p.innerHTML =
      `<div class="chart-card" style="max-width:640px">
        <h4 style="margin:0 0 4px">Timesheet Fix</h4>
        ${Help.box("bgt-timesheet")}
        <div style="display:flex;gap:8px;align-items:flex-end">
          <div class="field" style="flex:1;margin:0"><label>Employee — first or last name</label>
            <input id="bgtSearch" placeholder="Start typing a name…" autocomplete="off" oninput="BGTools.typed()" onkeydown="if(event.key==='Enter'){clearTimeout(BGTools._typeTimer);BGTools.search()}"></div>
          <button class="primary" onclick="BGTools.search()">Search</button>
        </div>
        <div id="bgtBody" style="margin-top:16px"><p class="hint">Results appear here.</p></div>
      </div>`;
    const el = document.getElementById("bgtSearch"); if (el) el.focus();
  },
  /* Live lookup: search shortly after the last keystroke. Each search starts a SQL query, so at most one runs at a
     time; if you kept typing meanwhile, only the newest text is searched next and older answers are dropped. */
  _typeTimer: null, _tsRunning: false, _tsWanted: null,
  typed() {
    clearTimeout(this._typeTimer);
    const q = (document.getElementById("bgtSearch").value || "").trim();
    if (q.length < 2) { document.getElementById("bgtBody").innerHTML = `<p class="hint">Type at least 2 letters.</p>`; this._tsWanted = null; return; }
    this._typeTimer = setTimeout(() => this.search(true), 350);
  },
  async search(live) {
    const input = document.getElementById("bgtSearch");
    if (!input) return;
    const q = (input.value || "").trim();
    const body = document.getElementById("bgtBody");
    if (q.length < 2) { body.innerHTML = `<p class="hint">Type at least 2 letters.</p>`; return; }
    if (this._tsRunning) { this._tsWanted = { q, live }; return; }       // run the newest text when the current search ends
    this._tsRunning = true;
    body.innerHTML = `<p class="hint"><span class="busy-spin" style="display:inline-block;vertical-align:middle;margin-right:6px"></span>Searching…</p>`;
    let r;
    try { r = await Backend.call("ts_search", q); } finally { this._tsRunning = false; }
    const next = this._tsWanted; this._tsWanted = null;
    const cur = (document.getElementById("bgtSearch") || {}).value;
    if (next && (cur || "").trim() !== q) { this.search(next.live); return; }   // typed more while waiting: this answer is stale
    if (!document.getElementById("bgtBody")) return;
    if (!r || !r.ok) { body.innerHTML = `<div class="cfg-warn">${esc((r && r.error) || "Search failed.")}</div>`; return; }
    const emps = r.employees || []; this._found = emps;
    if (!emps.length) { body.innerHTML = `<p class="hint">No employee matches “${esc(q)}”.</p>`; return; }
    if (emps.length === 1 && !live) { this.selectEmp(emps[0]); return; }
    body.innerHTML = `<div class="hint" style="margin-bottom:8px">${emps.length === 1 ? "1 match — click to open:" : emps.length + " matches — pick one:"}</div>` +
      `<div class="bgt-list">` + emps.map((e, i) => `<div class="bgt-emp" onclick="BGTools.pick(${i})">
        <span>${esc(e.last)}, ${esc(e.first)}</span><span class="muted">${esc(e.dept || "")} · ${esc(e.employid)}</span></div>`).join("") + `</div>`;
  },
  pick(i) { const e = this._found[i]; if (e) this.selectEmp(e); },
  async selectEmp(e) {
    this._emp = e; this._sel = null;
    const body = document.getElementById("bgtBody");
    body.innerHTML = `<p class="hint">Loading weeks for ${esc(e.first)} ${esc(e.last)}…</p>`;
    const r = await Backend.call("ts_weeks", e.employid);
    if (!r || !r.ok) { body.innerHTML = `<div class="cfg-warn">${esc((r && r.error) || "Could not load weeks.")}</div>`; return; }
    this._weeks = r.weeks || [];
    this.renderWeeks();
  },
  renderWeeks() {
    const e = this._emp, body = document.getElementById("bgtBody");
    if (!e) return;
    const rows = this._weeks.map((w, i) => `<tr>
      <td><input type="radio" name="bgtwk" ${this._sel === i ? "checked" : ""} ${w.locked ? "" : "disabled"} onchange="BGTools._sel=${i}"></td>
      <td>${w.fiscal_year}</td><td>${w.fiscal_week}</td>
      <td>${w.locked ? `<span class="bgt-pill locked">Locked</span>` : `<span class="bgt-pill open">Unlocked</span>`}</td></tr>`).join("");
    body.innerHTML =
      `<div class="bgt-emp-head"><b>${esc(e.last)}, ${esc(e.first)}</b> <span class="muted">${esc(e.dept || "")} · emp ${esc(e.employid)}</span></div>` +
      (this._weeks.length
        ? `<table class="fit bgt-tbl"><colgroup><col style="width:46px"><col style="width:72px"><col style="width:72px"><col></colgroup>
            <thead><tr><th></th><th>FY</th><th>Week</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
            <div id="bgtActionBar" style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:12px">
              <span class="hint">Select a locked week, then Unlock.</span>
              <button class="primary" style="background:var(--red);border-color:var(--red)" onclick="BGTools.unlock()">🔓 Unlock week</button></div>`
        : `<p class="hint">No week records found for this employee.</p>`);
  },
  unlock() {
    if (this._sel == null) return App.toast("Select a locked week first.", true);
    const w = this._weeks[this._sel];
    if (!w || !w.locked) return App.toast("That week isn't locked.", true);
    const bar = document.getElementById("bgtActionBar");
    if (bar) bar.innerHTML =
      `<span class="cfg-warn" style="margin:0;flex:1">Unlock <b>FY${w.fiscal_year} · Week ${w.fiscal_week}</b> for <b>${esc(this._emp.last)}, ${esc(this._emp.first)}</b>?</span>
       <span style="white-space:nowrap"><button class="ghost" onclick="BGTools.renderWeeks()">Cancel</button>
       <button class="primary" style="background:var(--red);border-color:var(--red)" onclick="BGTools.doUnlock()">Confirm unlock</button></span>`;
  },
  async doUnlock() {
    const w = this._weeks[this._sel], e = this._emp;
    const r = await Backend.call("ts_unlock", e.employid, w.fiscal_year, w.fiscal_week);
    if (!r || !r.ok) { App.toast((r && r.error) || "Unlock failed.", true); this.renderWeeks(); return; }
    App.toast(r.affected ? `Unlocked FY${w.fiscal_year} · Week ${w.fiscal_week}.` : "Already unlocked — no change.");
    await this.selectEmp(e);   // refresh the list from SQL
  },

  // ---- Boms Permissions Finder ----------------------------------------------
  _renderPerms(p) {
    this._perm = { user: null, groups: [], found: [], locations: [] };
    p.innerHTML =
      `<div class="chart-card" style="max-width:780px">
        <h4 style="margin:0 0 4px">Permissions Finder</h4>
        ${Help.box("bgt-perms")}
        <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
          <div class="field" style="flex:2;min-width:200px;margin:0"><label>Teammate name</label>
            <input id="bgpSearch" placeholder="Start typing a name…" autocomplete="off" oninput="BGTools.permTyped()" onkeydown="if(event.key==='Enter'){clearTimeout(BGTools._tt.perm);BGTools.permSearch(false)}"></div>
          <div class="field" style="flex:1;min-width:200px;margin:0"><label>Division</label>
            <div id="bgpLocHost"></div></div>
          <button class="primary" onclick="BGTools.permSearch(false)">Search</button>
        </div>
        <div id="bgpBody" style="margin-top:16px"><p class="hint">Results appear here.</p></div>
      </div>`;
    Combo.mount("bgpLocHost", "bgpLoc", [{ value: "co:" + Divisions.cur().company_name, label: Divisions.label() + " — " + Divisions.cur().company_name, group: "This division" }], "co:" + Divisions.cur().company_name);
    this._loadPermLocations();
    const el = document.getElementById("bgpSearch"); if (el) el.focus();
  },
  // Division options: divisions that share @nucor.com are told apart by Entra
  // companyName ("co:<company>"); separate BG brands by email domain ("dom:<domain>").
  async _loadPermLocations() {
    try {
      const r = await Backend.call("bg_locations");
      if (!document.getElementById("bgpLocHost") || !r || !r.ok) return;
      this._perm.locations = r.locations || [];
      const mine = "co:" + (r.nbgw_company || Divisions.cur().company_name);
      const items = [];
      (r.divisions || []).forEach(d => items.push({ value: "co:" + d.company, label: d.label, group: ("co:" + d.company) === mine ? "This division" : "Other Nucor divisions" }));
      this._perm.locations.forEach(l => items.push({ value: "dom:" + l.domain, label: l.label, group: "Other BG brands" }));
      items.push({ value: "", label: "All divisions (whole tenant)", group: "Everything" });
      if (!items.some(i => i.value === mine)) items.unshift({ value: mine, label: Divisions.label() + " — " + (r.nbgw_company || Divisions.cur().company_name), group: "This division" });
      const order = { "This division": 0, "Other Nucor divisions": 1, "Other BG brands": 2, "Everything": 3 };
      items.sort((a, b) => order[a.group] - order[b.group]);           // stable: keeps the list's own order inside each group
      Combo.mount("bgpLocHost", "bgpLoc", items, mine);
    } catch (e) { /* keep the single "this division" entry */ }
  },
  _scopeArgs(v) {
    v = v || "";
    if (v.startsWith("co:")) return ["", v.slice(3)];
    if (v.startsWith("dom:")) return [v.slice(4), ""];
    return ["", ""];
  },
  /* ---- live (as-you-type) search, shared by the Permissions Finder and Missing Groups ----
     Searches start 350 ms after the last keystroke; one search at a time; an answer for text that has since changed
     is dropped and the newest text is searched instead. Enter / the button still search at once. */
  _tt: {}, _live: {},
  _typed(key, inputId, bodyId, run) {
    clearTimeout(this._tt[key]);
    const q = ((document.getElementById(inputId) || {}).value || "").trim();
    if (q.length < 2) { const b = document.getElementById(bodyId); if (b) b.innerHTML = `<p class="hint">Type at least 2 letters.</p>`; return; }
    this._tt[key] = setTimeout(run, 350);
  },
  async _liveRun(key, inputId, bodyId, fetcher, show, live) {
    const input = document.getElementById(inputId), body = document.getElementById(bodyId);
    if (!input || !body) return;
    const q = (input.value || "").trim();
    if (q.length < 2) { body.innerHTML = `<p class="hint">Type at least 2 letters.</p>`; return; }
    const st = this._live[key] = this._live[key] || {};
    if (st.running) { st.again = true; st.live = live; return; }
    st.running = true;
    body.innerHTML = `<p class="hint"><span class="busy-spin" style="display:inline-block;vertical-align:middle;margin-right:6px"></span>Searching…</p>`;
    let r;
    try { r = await fetcher(q); } finally { st.running = false; }
    const again = st.again; st.again = false;
    const nowVal = ((document.getElementById(inputId) || {}).value || "").trim();
    if (again && nowVal !== q) return this._liveRun(key, inputId, bodyId, fetcher, show, st.live);   // typed more: answer is stale
    if (!document.getElementById(bodyId)) return;
    show(r, q, live);
  },
  permTyped() { this._typed("perm", "bgpSearch", "bgpBody", () => this.permSearch(true)); },
  missTyped() { this._typed("miss", "missSearch", "missBody", () => this.missSearchUser(true)); },
  permSearch(live) {
    const [domain, company] = this._scopeArgs((document.getElementById("bgpLoc") || {}).value);
    return this._liveRun("perm", "bgpSearch", "bgpBody", q => Backend.call("bg_user_search", q, domain, company), (r, q, lv) => {
      const body = document.getElementById("bgpBody");
      if (!r || !r.ok) { body.innerHTML = `<div class="cfg-warn">${esc((r && r.error) || "Search failed.")}</div>`; return; }
      const users = r.users || []; this._perm.found = users;
      if (!users.length) { body.innerHTML = `<p class="hint">No teammate matches “${esc(q)}”.</p>`; return; }
      if (users.length === 1 && !lv) { this.permSelectUser(users[0]); return; }
      body.innerHTML = `<div class="hint" style="margin-bottom:8px">${users.length === 1 ? "1 match — click to open:" : users.length + " matches — pick one:"}</div>` +
        `<div class="bgt-list">` + users.map((u, i) => `<div class="bgt-emp" onclick="BGTools.permPick(${i})">
          <span>${esc(u.display)}</span><span class="muted">${esc(u.dept || "")} · ${esc(u.upn)}</span></div>`).join("") + `</div>`;
    }, live);
  },
  permPick(i) { const u = this._perm.found[i]; if (u) this.permSelectUser(u); },
  async permSelectUser(u) {
    this._perm.user = u; this._perm.groups = [];
    const body = document.getElementById("bgpBody");
    body.innerHTML = `<p class="hint">Loading groups for ${esc(u.display)}…</p>`;
    const r = await Backend.call("bg_user_groups", u.id);
    if (!r || !r.ok) { body.innerHTML = `<div class="cfg-warn">${esc((r && r.error) || "Could not load groups.")}</div>`; return; }
    this._perm.groups = r.groups || [];
    this.permRenderGroups();
  },
  permRenderGroups() {
    const body = document.getElementById("bgpBody"), u = this._perm.user; if (!u) return;
    const fEl = document.getElementById("bgpFilter");
    const filt = (fEl ? fEl.value : "").trim().toLowerCase();
    const all = this._perm.groups;
    const shown = filt ? all.filter(g => (g.name || "").toLowerCase().includes(filt)) : all;
    const direct = all.filter(g => g.direct).length;
    const rows = shown.map(g => `<tr><td title="${attr(g.name)}">${esc(g.name)}</td>
      <td>${g.direct ? `<span class="bgt-pill open">Direct</span>` : `<span class="tag">Nested</span>`}</td></tr>`).join("");
    body.innerHTML =
      `<div class="bgt-emp-head"><b>${esc(u.display)}</b> <span class="muted">${esc(u.dept || "")} · ${esc(u.upn)}</span></div>
       <input id="bgpFilter" placeholder="Filter groups… e.g. boms" value="${attr(filt)}" oninput="BGTools.permRenderGroups()" autocomplete="off" style="width:100%;margin-bottom:10px">
       <p class="sub-note" style="margin:0 0 8px">${shown.length} of ${all.length} group${all.length === 1 ? "" : "s"}${filt ? ` matching “${esc(filt)}”` : ""} · ${direct} direct, ${all.length - direct} nested.</p>` +
      (all.length
        ? `<table class="fit bgt-tbl"><colgroup><col><col style="width:90px"></colgroup>
            <thead><tr><th>Group</th><th>Member</th></tr></thead><tbody>${rows || `<tr><td colspan="2" class="muted" style="padding:10px">No groups match “${esc(filt)}”.</td></tr>`}</tbody></table>`
        : `<p class="hint">This teammate isn't in any groups.</p>`);
    const f = document.getElementById("bgpFilter");
    if (f) { f.focus(); try { f.setSelectionRange(f.value.length, f.value.length); } catch (e) {} }
  },

  // ---- Missing Groups -------------------------------------------------------
  // Compare a teammate (or a whole department) against its BomsNet baseline
  // (Configuration → BomsNet baselines) to flag groups they lack that peers have.
  _renderMissing(p) {
    this._miss = { mode: "user", user: null, found: [], depts: [], company: Divisions.cur().company_name };
    p.innerHTML =
      `<div class="chart-card" style="max-width:860px">
        <h4 style="margin:0 0 4px">Missing Groups</h4>
        ${Help.box("bgt-missing")}
        <div class="miss-modes">
          <button class="miss-mode active" data-m="user" onclick="BGTools.missMode('user')">By teammate</button>
          <button class="miss-mode" data-m="dept" onclick="BGTools.missMode('dept')">By department</button>
        </div>
        <div id="missCtl"></div>
        <div id="missBody" style="margin-top:14px"><p class="hint">Search a teammate to see what they're missing.</p></div>
      </div>`;
    this._missRenderCtl();
  },
  missMode(m) {
    if (this._miss.mode === m) return;
    this._miss.mode = m; this._miss.user = null; this._miss.found = [];
    document.querySelectorAll("#bgtPanel .miss-mode").forEach(el => el.classList.toggle("active", el.dataset.m === m));
    this._missRenderCtl();
    const body = document.getElementById("missBody");
    if (body) body.innerHTML = m === "user"
      ? `<p class="hint">Search a teammate to see what they're missing.</p>`
      : `<p class="hint">Pick a department with a saved baseline, then Check.</p>`;
  },
  _missRenderCtl() {
    const ctl = document.getElementById("missCtl"); if (!ctl) return;
    if (this._miss.mode === "user") {
      ctl.innerHTML =
        `<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
          <div class="field" style="flex:1;min-width:220px;margin:0"><label>${esc(Divisions.label())} teammate name</label>
            <input id="missSearch" placeholder="Start typing a name…" autocomplete="off" oninput="BGTools.missTyped()" onkeydown="if(event.key==='Enter'){clearTimeout(BGTools._tt.miss);BGTools.missSearchUser(false)}"></div>
          <button class="primary" onclick="BGTools.missSearchUser(false)">Search</button></div>
         <p class="sub-note" style="margin:8px 0 0">Searches <b>${esc(this._miss.company || Divisions.cur().company_name)}</b> (${esc(Divisions.label())}) teammates only — the same people the baselines are built from.</p>`;
      const el = document.getElementById("missSearch"); if (el) el.focus();
    } else {
      ctl.innerHTML =
        `<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
          <div class="field" style="flex:2;min-width:240px;margin:0"><label>Department (with a saved baseline)</label>
            <select id="missDept"><option value="">Loading…</option></select></div>
          <button class="primary" id="missDeptBtn" onclick="BGTools.missShowDept()">Check department</button></div>
         <p class="sub-note" style="margin:8px 0 0">Only departments analyzed in <a onclick="Settings.open('perms')">Settings → Group baselines</a> appear here.</p>`;
      this._missLoadDepts();
    }
  },
  async _missLoadDepts() {
    const sel = document.getElementById("missDept"); if (!sel) return;
    try {
      const r = await Backend.call("perm_get_baselines");
      if (r && r.ok && r.data && r.data.company) this._miss.company = r.data.company;
      const depts = (r && r.ok && r.data && r.data.departments) ? Object.keys(r.data.departments) : [];
      depts.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      this._miss.depts = depts;
      sel.innerHTML = depts.length
        ? depts.map(d => `<option value="${attr(d)}">${esc(d)}</option>`).join("")
        : `<option value="">No baselines yet — analyze one in Settings → Group baselines</option>`;
      const btn = document.getElementById("missDeptBtn"); if (btn) btn.disabled = !depts.length;
    } catch (e) { sel.innerHTML = `<option value="">Could not load</option>`; }
  },
  missSearchUser(live) {
    return this._liveRun("miss", "missSearch", "missBody", q => Backend.call("bg_user_search", q, "", this._miss.company || Divisions.cur().company_name), (r, q, lv) => {
      const body = document.getElementById("missBody");
      if (!r || !r.ok) { body.innerHTML = `<div class="cfg-warn">${esc((r && r.error) || "Search failed.")}</div>`; return; }
      const users = r.users || []; this._miss.found = users;
      if (!users.length) { body.innerHTML = `<p class="hint">No ${esc(Divisions.label())} teammate matches “${esc(q)}”.</p>`; return; }
      if (users.length === 1 && !lv) { this.missShowUser(users[0]); return; }
      body.innerHTML = `<div class="hint" style="margin-bottom:8px">${users.length === 1 ? "1 match — click to open:" : users.length + " matches — pick one:"}</div>` +
        `<div class="bgt-list">` + users.map((u, i) => `<div class="bgt-emp" onclick="BGTools.missPickUser(${i})">
          <span>${esc(u.display)}</span><span class="muted">${esc(u.dept || "")} · ${esc(u.upn)}</span></div>`).join("") + `</div>`;
    }, live);
  },
  missPickUser(i) { const u = this._miss.found[i]; if (u) this.missShowUser(u); },
  async missShowUser(u) {
    this._miss.user = u;
    const body = document.getElementById("missBody");
    body.innerHTML = `<p class="hint">Checking ${esc(u.display)} against their department baseline…</p>`;
    const r = await Backend.call("perm_missing_for_user", u.id);
    if (!r || !r.ok) { body.innerHTML = `<div class="cfg-warn">${esc((r && r.error) || "Lookup failed.")}</div>`; return; }
    this._missRenderUser(r);
  },
  _missRenderUser(r) {
    const body = document.getElementById("missBody"); if (!body) return;
    const u = r.user || {};
    const head = `<div class="bgt-emp-head"><b>${esc(u.display || "")}</b> <span class="muted">${esc(u.dept || "(no department)")} · ${esc(u.upn || "")}</span></div>`;
    if (r.in_scope === false) {
      body.innerHTML = head +
        `<div class="cfg-warn" style="margin-top:6px"><b>${esc(u.display || "This person")}</b> is in <b>${esc(u.company || "another division")}</b>, not ${esc(r.company || Divisions.label())}. Group baselines only cover ${esc(Divisions.label())} teammates, so there's nothing valid to compare against.</div>`;
      return;
    }
    if (!r.has_baseline) {
      const dept = (u.dept || "").trim();
      body.innerHTML = head +
        `<div class="cfg-warn" style="margin-top:6px">No group baseline saved for <b>${esc(dept || "this department")}</b> yet, so there's nothing to compare against.` +
        (dept ? ` <button class="rowbtn" style="margin-left:8px" onclick="BGTools.missAnalyzeThenUser('${attr(dept)}','${attr(u.id)}')">Analyze “${esc(dept)}” now</button>` : "") +
        `<div class="sub-note" style="margin-top:8px">Or build it in <a onclick="Settings.open('perms')">Settings → Group baselines</a>.</div></div>`;
      return;
    }
    const total = r.total || 0;
    const cov = g => `held by ${g.count}/${total} of dept · ${Math.round((g.pct || 0) * 100)}%`;
    const missing = r.missing || [], present = r.present || [];
    const missCard = missing.length
      ? `<div class="miss-card miss-bad"><div class="miss-card-h">✗ Missing ${missing.length} expected group${missing.length === 1 ? "" : "s"}</div>` +
        missing.map(g => `<label class="miss-row"><span class="miss-pick"><input type="checkbox" class="miss-ck" data-g="${attr(g.name)}" onchange="BGTools.missCount()"><span class="miss-name" title="${attr(g.name)}">${esc(g.name)}</span></span><span class="miss-cov">${esc(cov(g))}</span></label>`).join("") + `</div>
        <div class="miss-ad"><div class="miss-ad-h">Add the ticked groups to ${esc(u.display || "this person")} in AD</div>${AdKey.html("ms")}
          <div class="cp-actions"><button class="ghost" id="msPrev" onclick="BGTools.missAd(false)" disabled>Preview</button><button class="primary" id="msGo" onclick="BGTools.missAd(true)" disabled>Add ticked groups…</button></div>
          <div id="msRes"></div></div>`
      : `<div class="miss-card miss-good"><div class="miss-card-h">✓ Not missing any expected groups</div><div class="sub-note" style="margin:2px 0 0">Has all ${present.length} common group${present.length === 1 ? "" : "s"} for this department.</div></div>`;
    const presCard = present.length
      ? `<details class="miss-card miss-ok"><summary class="miss-card-h">Has ${present.length} of ${present.length + missing.length} expected group${(present.length + missing.length) === 1 ? "" : "s"}</summary>` +
        present.map(g => `<div class="miss-row"><span class="miss-name" title="${attr(g.name)}">${esc(g.name)}</span></div>`).join("") + `</details>`
      : "";
    body.innerHTML = head +
      `<p class="sub-note" style="margin:0 0 10px">Compared against the <b>${esc(u.dept)}</b> common-groups baseline (${total} ${esc(Divisions.label())} peer${total === 1 ? "" : "s"}${r.updated ? `, analyzed ${esc(String(r.updated).slice(0, 10))}` : ""}).</p>` +
      missCard + presCard;
    if (missing.length) AdKey.init("ms");
  },
  missCount() {
    const n = document.querySelectorAll("#missBody .miss-ck:checked").length;
    ["msPrev", "msGo"].forEach(id => { const b = document.getElementById(id); if (b) b.disabled = !n; });
    const go = document.getElementById("msGo"); if (go && !go.dataset.busy) go.innerHTML = n ? `Add ${n} group${n === 1 ? "" : "s"}…` : "Add ticked groups…";
  },
  async missAd(commit) {
    const u = this._miss.user || {};
    const names = [...document.querySelectorAll("#missBody .miss-ck:checked")].map(e => e.dataset.g);
    if (!names.length) return;
    const acct = AdKey.value("ms");
    if (commit) {
      if (!acct) { App.toast("Enter your admin account (for example adm.name.pa) first.", true); return; }
      AdKey.remember("ms");
      if (!confirm(`Add ${u.display || u.upn} to ${names.length} AD group(s)?\n\nA PIN window opens (look in the taskbar if you do not see it). You enter the PIN once, there.`)) return;
    }
    const btn = document.getElementById(commit ? "msGo" : "msPrev");
    let r; await Ui.working(btn, commit ? "Waiting for the PIN window…" : "Checking…", async () => { r = await Backend.call("ad_add_missing", u.upn, names, acct, commit); return false; });
    document.getElementById("msRes").innerHTML = CopyPerms.resultHtml(r);
    this.missCount();
  },
  async missAnalyzeThenUser(dept, uid) {
    const body = document.getElementById("missBody");
    if (body) body.innerHTML = `<p class="hint">Analyzing <b>${esc(dept)}</b> in Entra — reading each member's groups… this can take a moment.</p>`;
    const a = await Backend.call("perm_analyze_dept", dept, "");
    if (!a || !a.ok) { if (body) body.innerHTML = `<div class="cfg-warn">${esc((a && a.error) || "Analysis failed.")}</div>`; return; }
    const u = (this._miss.found || []).find(x => x.id === uid) || this._miss.user || { id: uid };
    this.missShowUser(u);
  },
  async missShowDept() {
    const dept = (document.getElementById("missDept") || {}).value || "";
    const body = document.getElementById("missBody");
    if (!dept) { body.innerHTML = `<p class="hint">Pick a department first.</p>`; return; }
    body.innerHTML = `<p class="hint">Checking every member of <b>${esc(dept)}</b> against the baseline…</p>`;
    const r = await Backend.call("perm_missing_in_dept", dept);
    if (!r || !r.ok) { body.innerHTML = `<div class="cfg-warn">${esc((r && r.error) || "Lookup failed.")}</div>`; return; }
    this._missRenderDept(r);
  },
  _missRenderDept(r) {
    const body = document.getElementById("missBody"); if (!body) return;
    if (!r.has_baseline) {
      body.innerHTML = `<div class="cfg-warn">No baseline saved for <b>${esc(r.department)}</b>. Analyze it first in <a onclick="Settings.open('perms')">Settings → Group baselines</a>.</div>`;
      return;
    }
    const total = r.total || 0, compliant = r.compliant || 0, gap = total - compliant;
    const gaps = (r.summary || []).filter(s => s.missing > 0);
    const gapsHtml = gaps.length
      ? `<div class="miss-card miss-bad"><div class="miss-card-h">Groups with gaps</div>` +
        gaps.map(s => `<div class="miss-row"><span class="miss-name" title="${attr(s.name)}">${esc(s.name)}</span><span class="miss-cov">missing for ${s.missing} of ${total}</span></div>`).join("") + `</div>`
      : `<div class="miss-card miss-good"><div class="miss-card-h">✓ Everyone has every expected group</div></div>`;
    const bad = (r.users || []).filter(u => u.missing_count > 0);
    const rows = bad.map(u => `<tr>
        <td title="${attr(u.upn)}">${esc(u.display)}</td>
        <td>${u.missing.map(m => `<span class="miss-tag" title="${attr(m)}">${esc(m)}</span>`).join(" ")}</td></tr>`).join("");
    const badTbl = bad.length
      ? `<table class="fit bgt-tbl miss-tbl"><colgroup><col style="width:230px"><col></colgroup>
          <thead><tr><th>Teammate</th><th>Missing groups</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<p class="sub-note" style="margin:8px 0 0">No one in this department is missing an expected group. 🎉</p>`;
    body.innerHTML =
      `<div class="bgt-emp-head"><b>${esc(r.department)}</b> <span class="muted">${total} ${esc(Divisions.label())} member${total === 1 ? "" : "s"} · ${(r.expected || []).length} expected group${(r.expected || []).length === 1 ? "" : "s"}</span></div>
       <div class="miss-stats"><span class="miss-stat ok"><b>${compliant}</b> fully compliant</span><span class="miss-stat ${gap ? "bad" : ""}"><b>${gap}</b> missing one or more</span></div>` +
      gapsHtml + badTbl;
  },
};

/* ---- generic drill-down modal (a titled table, optional summary chips) ------
   Fixed-layout table (wraps long cells so the modal never side-scrolls), click-any-
   header to sort (toggles ▲/▼), and an auto "Source" column when rows carry .source
   (which system/list the device was found in). */
const Drill = {
  _rows: [], _cols: [], _opts: {}, _title: "", _action: null, _sortIdx: -1, _sortDir: 1,
  open(title, rows, cols, opts) {
    opts = opts || {};
    this._title = title; this._rows = (rows || []).slice(); this._opts = opts;
    this._action = opts.rowAction || null;
    this._sortIdx = -1; this._sortDir = 1;   // caller already sorted sensibly by default
    // If any row names a source system/list, append a Source column automatically
    // (unless the caller already supplied its own Source column).
    cols = cols.slice();
    if (this._rows.some(r => r && r.source) && !cols.some(c => c.label === "Source"))
      cols.push({ label: "Source", get: r => r.source || "—", w: "12%" });
    this._cols = cols;
    this._render();
  },
  _num(v) { const s = String(v == null ? "" : v).trim(); if (!/^-?[\d,]+(\.\d+)?$/.test(s)) return null; const n = parseFloat(s.replace(/,/g, "")); return isNaN(n) ? null : n; },
  sort(idx) {
    if (this._sortIdx === idx) this._sortDir = -this._sortDir; else { this._sortIdx = idx; this._sortDir = 1; }
    const c = this._cols[idx], g = c.sortGet || c.get, dir = this._sortDir;
    this._rows.sort((a, b) => {
      const va = g(a), vb = g(b), na = this._num(va), nb = this._num(vb);
      const cmp = (na !== null && nb !== null) ? (na - nb)
        : String(va == null ? "" : va).toLowerCase().localeCompare(String(vb == null ? "" : vb).toLowerCase());
      return cmp * dir;
    });
    this._draw();
  },
  _plain(c, r) {
    const raw = c.text ? c.text(r) : c.get(r);
    return String(raw == null ? "" : raw).replace(/<[^>]*>/g, "");
  },
  /* the window shell is built once; typing in the filter or sorting only redraws the table, so focus and scroll are kept */
  _render() {
    const rows = this._rows, opts = this._opts;
    this._q = "";
    const tools = (rows.length > 8 || opts.search)
      ? `<div class="drill-tools"><input id="drillQ" type="search" placeholder="Filter these rows…" autocomplete="off" oninput="Drill.filter(this.value)">
           <span class="muted" id="drillCount"></span><button class="ghost" style="margin-left:auto" onclick="Drill.copy()" title="Copy the rows shown, ready to paste into Excel">Copy list</button></div>` : "";
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal" style="width:${opts.width || "880px"};max-width:96vw;">
        <div class="modal-head"><h3>${esc(this._title)} <span class="drill-n">${rows.length}${opts.countLabel ? " " + esc(opts.countLabel) : ""}</span></h3><button onclick="Drill.close()">&times;</button></div>
        ${tools ? `<div style="padding:12px 22px 0">${tools}</div>` : ""}
        <div class="modal-body" id="drillBody" style="max-height:70vh;overflow-y:auto;overflow-x:hidden;"></div>
        ${opts.footerHtml ? `<div class="modal-foot" style="justify-content:space-between;gap:12px">${opts.footerHtml}</div>` : ""}
      </div></div>`;
    this._draw();
    const q = document.getElementById("drillQ"); if (q) q.focus();
  },
  filter(v) { this._q = String(v || "").trim().toLowerCase(); this._draw(); },
  _shownRows() {
    const q = this._q;
    return q ? this._rows.filter(r => this._cols.some(c => this._plain(c, r).toLowerCase().includes(q))) : this._rows;
  },
  _draw() {
    const cols = this._cols, act = this._action, opts = this._opts;
    const body = document.getElementById("drillBody"); if (!body) return;
    const rows = this._shown = this._shownRows();
    const cnt = document.getElementById("drillCount");
    if (cnt) cnt.textContent = this._q ? `${rows.length} of ${this._rows.length} shown` : "";
    const chips = opts.chips && Object.keys(opts.chips).length
      ? `<div class="office-chips">${Object.entries(opts.chips).sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `<span class="office-chip">${esc(k)}&nbsp;<b>${v}</b></span>`).join("")}</div>` : "";
    const anyW = cols.some(c => c.w);
    const colgroup = anyW ? `<colgroup>${cols.map(c => `<col${c.w ? ` style="width:${c.w}"` : ""}>`).join("")}${act ? "<col style=\"width:90px\">" : ""}</colgroup>` : "";
    const head = cols.map((c, idx) => {
      const arrow = this._sortIdx === idx ? (this._sortDir > 0 ? " ▲" : " ▼") : "";
      return `<th onclick="Drill.sort(${idx})" title="Sort by ${attr(c.label)}">${esc(c.label)}${arrow}</th>`;
    }).join("") + (act ? "<th></th>" : "");
    body.innerHTML = rows.length
      ? chips + `<table class="drill-tbl">${colgroup}<thead><tr>${head}</tr></thead><tbody>` +
        rows.map((r, i) => `<tr>${cols.map(c => `<td class="${c.mono ? "mono" : ""}">${c.html ? c.get(r) : esc(c.get(r))}</td>`).join("")}` +
          (act ? `<td style="text-align:right;white-space:nowrap"><button class="rowbtn" onclick="Drill.act(${i})">${esc(act.label)}</button></td>` : "") +
          `</tr>`).join("") +
        `</tbody></table>`
      : `<div class="empty">${esc(this._q ? "No rows match that filter." : (opts.empty || "Nothing to show here."))}</div>`;
  },
  copy() {
    const rows = this._shown || this._rows, cols = this._cols;
    const cell = v => String(v == null ? "" : v).replace(/[\t\r\n]+/g, " ");
    const txt = [cols.map(c => c.label).join("\t")].concat(rows.map(r => cols.map(c => cell(this._plain(c, r))).join("\t"))).join("\n");
    const done = () => App.toast(`Copied ${rows.length} row${rows.length === 1 ? "" : "s"}. Paste into Excel or a message.`);
    const fallback = () => { const t = document.createElement("textarea"); t.value = txt; document.body.appendChild(t); t.select(); try { document.execCommand("copy"); done(); } catch (e) { App.toast("Could not copy.", true); } t.remove(); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, fallback); else fallback();
  },
  act(i) { const r = (this._shown || this._rows)[i]; if (this._action && r) this._action.fn(r); },
  close() { document.getElementById("modalRoot").innerHTML = ""; this._rows = []; this._action = null; },
};

/* ---- Software compliance logic (shared by Software page + Dashboard) ------
   Mandatory apps are computed as: the TOP 10 most-installed apps per department
   (auto), plus/minus explicit user overrides stored as rules. "Missing" is judged
   against the LATEST version of each app only — a user who has an old release but
   not the newest still counts as missing. Versions of one app are collapsed by
   app NAME. Kept as pure functions so the page and the dashboard agree exactly. */
const AUTO_MANDATORY_TOP = 10;
const SWLogic = {
  _topCache: new WeakMap(),   // apps array (identity) -> { "scope|n|pct|people": [names] }
  cfg: { top: AUTO_MANDATORY_TOP, minPct: 0, minPeople: 1 },   // the automatic rule; stored per division beside the manual overrides
  setCfg(a) {
    a = a || {};
    const n = (v, d, lo, hi) => { v = parseInt(v, 10); return isNaN(v) ? d : Math.max(lo, Math.min(hi, v)); };
    this.cfg = { top: n(a.top, AUTO_MANDATORY_TOP, 0, 50), minPct: n(a.min_pct, 0, 0, 100), minPeople: n(a.min_people, 1, 1, 50) };
  },

  deptKey(u) {
    const d = (u.dept || "").trim(), s = (u.site || "").trim() || "—";
    return d || (s !== "—" ? `(no dept) · ${s}` : "(no dept)");
  },
  // Compare dotted version strings numerically: 26.08.11.00 > 26.07.09.00.
  cmpVer(a, b) {
    const pa = String(a || "").split(/[.\-_+]/), pb = String(b || "").split(/[.\-_+]/);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
      const x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return String(a || "").localeCompare(String(b || ""));
  },
  // The app entry with the highest version for a given name (versions collapsed by name).
  latestApp(apps, name) {
    let best = null;
    (apps || []).forEach(a => { if (a.name === name && (!best || this.cmpVer(a.version, best.version) > 0)) best = a; });
    return best;
  },
  // Users (lowercased upn) who have the LATEST version of this app name.
  haveUsers(apps, name) {
    const app = this.latestApp(apps, name);
    return new Set((app ? app.installs || [] : []).map(i => (i.user || "").toLowerCase()));
  },
  // Top-N app NAMES by distinct in-scope users who have them (any version).
  top(apps, users, scope, n) {
    let m = this._topCache.get(apps);
    if (!m) { m = {}; this._topCache.set(apps, m); }
    const ck = scope + "|" + n + "|" + this.cfg.minPct + "|" + this.cfg.minPeople;
    if (m[ck]) return m[ck];
    const inScope = new Set((users || []).filter(u => this.deptKey(u) === scope).map(u => (u.user || "").toLowerCase()));
    let out = [];
    if (n > 0 && inScope.size >= this.cfg.minPeople) {
      const byName = {};
      (apps || []).forEach(a => (a.installs || []).forEach(i => {
        const uk = (i.user || "").toLowerCase();
        if (inScope.has(uk)) (byName[a.name] = byName[a.name] || new Set()).add(uk);
      }));
      out = Object.keys(byName).filter(nm => byName[nm].size * 100 >= this.cfg.minPct * inScope.size)
        .sort((x, y) => byName[y].size - byName[x].size || x.localeCompare(y)).slice(0, n);
    }
    m[ck] = out;
    return out;
  },
  autoText() {
    const c = this.cfg;
    if (!c.top) return "Nothing is automatic (the automatic rule is off)";
    return `The ${c.top} most-installed app${c.top === 1 ? "" : "s"}` + (c.minPct ? `, each on at least ${c.minPct}% of the department` : "") + (c.minPeople > 1 ? `, in departments of ${c.minPeople}+ people` : "");
  },
  autoTop(apps, users, scope) { return this.top(apps, users, scope, this.cfg.top); },
  // Every app name in a department with how many of its people have it (any version), most first. People = all users in the department.
  counts(apps, users, scope) {
    const inScope = new Set((users || []).filter(u => this.deptKey(u) === scope).map(u => (u.user || "").toLowerCase()));
    const byName = {};
    (apps || []).forEach(a => (a.installs || []).forEach(i => {
      const uk = (i.user || "").toLowerCase();
      if (inScope.has(uk)) (byName[a.name] = byName[a.name] || new Set()).add(uk);
    }));
    return { people: inScope.size, rows: Object.keys(byName).map(nm => ({ name: nm, n: byName[nm].size })).sort((x, y) => y.n - x.n || x.name.localeCompare(y.name)) };
  },
  isAuto(apps, users, scope, name) { return this.autoTop(apps, users, scope).includes(name); },

  isMandatory(apps, users, rules, name, scope) {
    if (scope === "all") return false;
    const rule = (rules || []).find(r => r.scope === scope && r.app === name);
    if (rule) return !!rule.required;                 // explicit override (on or off)
    return this.isAuto(apps, users, scope, name);      // else auto top-10
  },
  // Full set of mandatory app names for a scope: auto top-10 minus explicit exclusions,
  // plus explicitly-added apps.
  mandatoryApps(apps, users, rules, scope) {
    if (scope === "all") return [];
    const explicit = {};
    (rules || []).forEach(r => { if (r.scope === scope) explicit[r.app] = !!r.required; });
    const set = new Set(this.autoTop(apps, users, scope).filter(nm => explicit[nm] !== false));
    Object.keys(explicit).forEach(nm => { if (explicit[nm]) set.add(nm); });
    return [...set];
  },
  // For each dept with mandatory apps, the users missing any (judged on latest version).
  gaps(apps, users, rules) {
    if (!(users || []).length) return [];
    const scopes = [...new Set(users.map(u => this.deptKey(u)))];
    const out = [];
    scopes.forEach(scope => {
      const mand = this.mandatoryApps(apps, users, rules, scope);
      if (!mand.length) return;
      const have = {};
      mand.forEach(nm => { have[nm] = this.haveUsers(apps, nm); });
      const deptUsers = users.filter(u => this.deptKey(u) === scope);
      const missing = [];
      deptUsers.forEach(u => {
        const uk = (u.user || "").toLowerCase();
        const miss = mand.filter(nm => !have[nm].has(uk));
        if (miss.length) missing.push({ user: u.user, apps: miss });
      });
      if (missing.length) out.push({ scope, count: missing.length, users: missing });
    });
    out.sort((a, b) => b.count - a.count);
    return out;
  },
};

/* ---- Software inventory --------------------------------------------------
   Apps installed across the NBGW fleet, cached from Intune (software_get/refresh).
   Browse + search, filter by "Department · Site", drill into who has each app,
   and flag apps Mandatory per department to see which users are missing them.
   Department comes from Entra (User.Read.All) — dormant until consented. */
const Software = {
  data: { apps: [], users: [] }, rules: [], hasDept: false, generatedAt: "", _view: [],

  deptKeyOf(u) {
    // Nucor's Entra 'department' already includes the location (e.g. "Design Dept
    // Lathrop"), so group by it directly; fall back to site when it's blank.
    const dept = (u.dept || "").trim(), site = (u.site || "").trim() || "—";
    return dept || (site !== "—" ? `(no dept) · ${site}` : "(no dept)");
  },

  async load() {
    try {
      const r = await Backend.call("software_get");
      const d = (r && r.ok && r.data) || {};
      this.data = { apps: Array.isArray(d.apps) ? d.apps : [], users: Array.isArray(d.users) ? d.users : [] };
      this.hasDept = !!d.has_dept;
      this.generatedAt = d.generated_at || "";
      this.rules = (r && r.ok && r.rules && Array.isArray(r.rules.rules)) ? r.rules.rules : [];
      SWLogic.setCfg(r && r.ok && r.rules ? r.rules.auto : null);
    } catch (e) { this.data = { apps: [], users: [] }; this.rules = []; }
    this.buildDeptOptions();
    this.render();
  },
  buildDeptOptions() {
    const sel = document.getElementById("swDept"); if (!sel) return;
    const keys = [...new Set((this.data.users || []).map(u => this.deptKeyOf(u)))].sort();
    const cur = sel.value;
    sel.innerHTML = `<option value="all">All departments</option>` + keys.map(k => `<option>${esc(k)}</option>`).join("");
    if (cur && (cur === "all" || keys.includes(cur))) sel.value = cur;
  },
  _scope() { const s = document.getElementById("swDept"); return s ? s.value : "all"; },
  _installsInScope(app, scope) {
    if (scope === "all") return app.installs || [];
    return (app.installs || []).filter(i => this.deptKeyOf(i) === scope);
  },
  isMandatory(appName, scope) {
    return SWLogic.isMandatory(this.data.apps, this.data.users, this.rules, appName, scope);
  },
  /* Set one app's mandatory state for a department. Only an override of the automatic result is stored. */
  _applyRule(appName, scope, on) {
    const auto = SWLogic.isAuto(this.data.apps, this.data.users, scope, appName);
    this.rules = this.rules.filter(r => !(r.scope === scope && r.app === appName));
    if (on !== auto) this.rules.push({ app: appName, scope, required: on, set_by: App.state.account || "", set_at: new Date().toISOString() });
  },
  async _saveRules() {
    const r = await Backend.call("software_save_rules", { rules: this.rules });
    if (!r || !r.ok) App.toast((r && r.error) || "Could not save.", true);
    return !!(r && r.ok);
  },
  /* ---- "Mandatory apps" window: tab 1 = one department's list, tab 2 = the automatic rule ---- */
  _md: { tab: "dept", scope: "", q: "", draft: null },
  mandatory(tab) {
    const s = this._scope();
    this._md = { tab: tab || "dept", scope: s === "all" ? "" : s, q: "", draft: null };
    this._mdRender();
  },
  _mdDepts() { return [...new Set((this.data.users || []).map(u => SWLogic.deptKey(u)))].sort(); },
  _mdRender() {
    const m = this._md;
    const tabs = [["dept", "Department list"], ["auto", "Automatic rule"]].map(([id, label]) =>
      `<button type="button" class="md-tab${m.tab === id ? " on" : ""}" onclick="Software.mdTab('${id}')">${label}</button>`).join("");
    const body = m.tab === "dept" ? this._mdDept() : this._mdAuto();
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal" style="width:780px;max-width:96vw">
        <div class="modal-head"><h3>Mandatory apps</h3><span class="md-wait hidden" id="mdWait"><span class="busy-spin"></span><span id="mdWaitTxt">Saving…</span></span><button onclick="Software.mdClose()">&times;</button></div>
        <div class="md-tabs">${tabs}</div>
        <div class="modal-body" style="max-height:66vh;overflow-y:auto">${body}</div>
        <div class="modal-foot">${m.tab === "auto"
          ? `<button class="ghost" onclick="Software.mdClose()">Cancel</button><button class="primary" onclick="Software.arSave(this)">Save rule</button>`
          : `<button class="primary" onclick="Software.mdClose()">Done</button>`}</div>
      </div></div>`;
    if (m.tab === "auto") this.arDraft();
    if (m.tab === "dept" && m.q) { const el = document.getElementById("swEdQ"); if (el) { el.focus(); el.setSelectionRange(m.q.length, m.q.length); } }
  },
  /* saving goes to SharePoint and takes a moment: show it, and ignore clicks until it is done */
  _mdBusy(on, txt) {
    const w = document.getElementById("mdWait"), b = document.querySelector(".modal-body");
    if (w) w.classList.toggle("hidden", !on);
    const t = document.getElementById("mdWaitTxt"); if (t && txt) t.textContent = txt;
    if (b) b.classList.toggle("md-busy", !!on);
  },
  async _mdSave(txt, fn) {
    this._mdBusy(true, txt);
    try { fn(); const ok = await this._saveRules(); if (!ok) await this.load(); } finally { this._mdRender(); }   // a failed save: reload what is really stored
  },
  mdTab(t) { this._md.tab = t; this._md.draft = null; this._mdRender(); },
  mdClose() { document.getElementById("modalRoot").innerHTML = ""; this.render(); },

  /* tab 1 */
  _mdDept() {
    const { scope, q } = this._md, A = this.data.apps, U = this.data.users;
    const picker = `<div class="field" style="margin:0 0 12px;max-width:420px"><label>Department</label>
      <select id="mdDept" onchange="Software.mdScope(this.value)"><option value="">Choose a department…</option>${this._mdDepts().map(k => `<option${k === scope ? " selected" : ""}>${esc(k)}</option>`).join("")}</select></div>`;
    if (!scope) return picker + `<p class="sub-note" style="margin:0">Pick a department to see and change the apps every person in it must have. These lists drive the <b>Mandatory only</b> view and the missing-software checks.</p>`;
    const cn = SWLogic.counts(A, U, scope), cnt = Object.fromEntries(cn.rows.map(r => [r.name, r.n]));
    const mand = SWLogic.mandatoryApps(A, U, this.rules, scope).sort((x, y) => (cnt[y] || 0) - (cnt[x] || 0) || x.localeCompare(y));
    const autoSet = new Set(SWLogic.autoTop(A, U, scope));
    const removed = [...autoSet].filter(n => !mand.includes(n));
    const pct = n => cn.people ? Math.round(100 * (cnt[n] || 0) / cn.people) + "%" : "";
    const row = (n, tag, btn) => `<div class="sw-ed-row"><span class="sw-ed-name" title="${attr(n)}">${esc(n)}</span><span class="muted">${cnt[n] || 0} of ${cn.people} people (${pct(n)})</span>${tag}${btn}</div>`;
    const auto = `<span class="md-tag">Automatic</span>`, added = `<span class="md-tag you">Added by you</span>`;
    const ql = q.toLowerCase();
    const cands = ql ? cn.rows.filter(r => !mand.includes(r.name) && r.name.toLowerCase().includes(ql)).slice(0, 12) : [];
    const others = this._mdDepts().filter(k => k !== scope);
    const edits = this.rules.filter(r => r.scope === scope).length;
    return picker +
      `<p class="sub-note" style="margin:0 0 12px">Every person in <b>${esc(scope)}</b> (${cn.people}) is expected to have these apps. Changes save as you click.</p>
       <div class="sw-ed-h">Must have (${mand.length})</div>
       ${mand.length ? mand.map(n => row(n, autoSet.has(n) ? auto : added, `<button class="rowbtn" onclick="Software.edSet('${attr(n)}',false)">Remove</button>`)).join("")
                     : `<div class="muted" style="padding:6px 0">Nothing yet. Add an app below.</div>`}
       ${removed.length ? `<div class="sw-ed-h" style="margin-top:14px">Taken off the automatic list (${removed.length})</div>` +
         removed.map(n => row(n, `<span class="md-tag off">Removed</span>`, `<button class="rowbtn" onclick="Software.edSet('${attr(n)}',true)">Put back</button>`)).join("") : ""}
       <div class="sw-ed-h" style="margin-top:16px">Add another app</div>
       <input id="swEdQ" type="search" placeholder="Type part of an app name…" value="${attr(q)}" oninput="Software.edSearch(this.value)" autocomplete="off" style="width:100%">
       ${ql ? (cands.length ? cands.map(r => row(r.name, "", `<button class="rowbtn" onclick="Software.edSet('${attr(r.name)}',true)">Add</button>`)).join("") : `<div class="muted" style="padding:6px 0">No other app installed in this department matches.</div>`) : ""}
       <div class="md-more"><div class="sw-ed-h">Other options</div>
         <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
           <select id="swEdCopy" style="max-width:300px"><option value="">Copy the list from…</option>${others.map(k => `<option>${esc(k)}</option>`).join("")}</select>
           <button class="ghost" onclick="Software.edCopy()">Copy list</button>
           <button class="ghost" style="margin-left:auto" onclick="Software.edReset()" ${edits ? "" : "disabled"}>Clear my changes${edits ? " (" + edits + ")" : ""}</button>
         </div>
         <p class="sub-note" style="margin:8px 0 0">${edits ? `<b>Clear my changes</b> removes the ${edits} app${edits === 1 ? "" : "s"} you added or took off, so ${esc(scope)} uses the automatic list again.` : "You have not changed the automatic list for this department."}</p></div>`;
  },
  mdScope(v) { this._md.scope = v; this._md.q = ""; this._mdRender(); },
  edSearch(v) { this._md.q = v; this._mdRender(); },
  async edSet(name, on) { await this._mdSave(on ? "Adding…" : "Removing…", () => this._applyRule(name, this._md.scope, on)); },
  async edReset() {
    if (!confirm(`Clear your changes for ${this._md.scope}? The apps you added or took off are undone and the automatic list is used again.`)) return;
    await this._mdSave("Clearing your changes…", () => { this.rules = this.rules.filter(r => r.scope !== this._md.scope); });
  },
  async edCopy() {
    const from = (document.getElementById("swEdCopy") || {}).value, scope = this._md.scope;
    if (!from) return App.toast("Choose the department to copy from.", true);
    if (!confirm(`Make ${scope} use the same list as ${from}? This replaces your changes for ${scope}.`)) return;
    const A = this.data.apps, U = this.data.users;
    const want = new Set(SWLogic.mandatoryApps(A, U, this.rules, from)), auto = new Set(SWLogic.autoTop(A, U, scope));
    const keep = this.rules.filter(r => r.scope !== scope), now = new Date().toISOString(), by = App.state.account || "";
    want.forEach(n => { if (!auto.has(n)) keep.push({ app: n, scope, required: true, set_by: by, set_at: now }); });
    auto.forEach(n => { if (!want.has(n)) keep.push({ app: n, scope, required: false, set_by: by, set_at: now }); });
    await this._mdSave("Copying the list…", () => { this.rules = keep; });
  },

  /* tab 2 */
  _mdAuto() {
    const c = SWLogic.cfg, d = this._md.draft || (this._md.draft = { top: c.top, pct: c.minPct, ppl: c.minPeople });
    return `<p class="sub-note" style="margin:0 0 14px">Each department starts with an automatic list: the apps most of its people already have. Anything you add or remove on the <b>Department list</b> tab always wins over this rule. Only division admins can change it.</p>
      <div class="md-rule"><label for="arTop">How many apps</label><input id="arTop" type="number" min="0" max="50" value="${d.top}" oninput="Software.arDraft()"><span class="muted">per department. 0 turns the automatic list off.</span></div>
      <div class="md-rule"><label for="arPct">At least</label><input id="arPct" type="number" min="0" max="100" value="${d.pct}" oninput="Software.arDraft()"><span class="muted">% of the department must have the app. 0 = no minimum. 50-60 keeps one-off apps out.</span></div>
      <div class="md-rule"><label for="arPpl">Skip departments under</label><input id="arPpl" type="number" min="1" max="50" value="${d.ppl}" oninput="Software.arDraft()"><span class="muted">people. 1 = use every department.</span></div>
      <div class="md-preview" id="mdPrev"></div>`;
  },
  arDraft() {
    const v = id => parseInt(document.getElementById(id).value, 10);
    this._md.draft = { top: isNaN(v("arTop")) ? 0 : v("arTop"), pct: isNaN(v("arPct")) ? 0 : v("arPct"), ppl: isNaN(v("arPpl")) ? 1 : v("arPpl") };
    const el = document.getElementById("mdPrev"); if (!el) return;
    const keep = SWLogic.cfg, d = this._md.draft;
    SWLogic.setCfg({ top: d.top, min_pct: d.pct, min_people: d.ppl });
    const depts = this._mdDepts(), withAuto = depts.filter(k => SWLogic.autoTop(this.data.apps, this.data.users, k).length).length;
    const sc = this._md.scope, sample = sc ? SWLogic.autoTop(this.data.apps, this.data.users, sc) : [];
    SWLogic.cfg = keep;
    el.innerHTML = `<b>With these numbers:</b> ${withAuto} of ${depts.length} departments get an automatic list.` +
      (sc ? ` <b>${esc(sc)}</b> would get ${sample.length} app${sample.length === 1 ? "" : "s"}${sample.length ? ": " + esc(sample.slice(0, 5).join(", ")) + (sample.length > 5 ? ", …" : "") : ""}.` : ` Pick a department on the first tab to see an example.`);
  },
  async arSave(btn) {
    const d = this._md.draft || {};
    const auto = { top: d.top, min_pct: d.pct, min_people: d.ppl };
    let r; await Ui.working(btn, "Saving…", async () => { r = await Backend.call("software_save_rules", { rules: this.rules, auto }); return false; });
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not save.", true);
    SWLogic.setCfg(r.auto || auto);
    this._md.draft = null;
    App.toast("Automatic rule saved.");
    this.mdTab("dept");
  },
  async toggleMandatory(appName, scope, on) {
    if (scope === "all") return;
    // Top-10 apps are mandatory automatically. Only store a rule when the choice
    // differs from that auto default: an exclusion (required:false) to drop an auto
    // app, or an addition (required:true) for one outside the top 10. Matching the
    // default just removes any prior override.
    const auto = SWLogic.isAuto(this.data.apps, this.data.users, scope, appName);
    this.rules = this.rules.filter(r => !(r.scope === scope && r.app === appName));
    if (on !== auto) this.rules.push({ app: appName, scope, required: on, set_by: App.state.account || "", set_at: new Date().toISOString() });
    await Backend.call("software_save_rules", { rules: this.rules });
    this.render();
  },

  render() {
    const host = document.getElementById("swHost"); if (!host) return;
    const meta = document.getElementById("swMeta");
    if (meta) meta.textContent = this.generatedAt ? `Synced ${this.generatedAt.slice(0, 16).replace("T", " ")} · ${this.data.apps.length} apps` : "Not synced yet";
    if (!this.data.apps.length) {
      host.innerHTML = `<div class="empty">No software inventory yet. Click <b>Refresh from Intune</b> to build it — this pulls detected apps for every device, so it can take a few minutes.</div>`;
      return;
    }
    const scope = this._scope();
    // ONE search box. It matches software (name / publisher) and people (user / device / serial).
    // If it matches software, the list is those apps ("who has it?"). If it only matches people, the list is
    // everything installed on those people/devices ("what does this person have?"). When both match, chips let you pick.
    const q = (document.getElementById("swSearch").value || "").trim();
    const ql = q.toLowerCase();
    const mandOnly = (document.querySelector("input[name=swMand]:checked") || {}).value === "mand";
    const hitsApp = a => (a.name || "").toLowerCase().includes(ql) || (a.publisher || "").toLowerCase().includes(ql);
    const hitsPerson = i => [i.user, i.device, i.serial].some(v => (v || "").toLowerCase().includes(ql));
    let appHits = 0, personHits = 0;
    if (ql) this.data.apps.forEach(a => { if (hitsApp(a)) appHits++; if ((a.installs || []).some(hitsPerson)) personHits++; });
    let mode = "none";
    if (ql) {
      mode = this._mode === "people" && personHits ? "people" : this._mode === "apps" && appHits ? "apps" : (appHits ? "apps" : "people");
    }
    let apps = this.data.apps.map(a => {
      let scoped = this._installsInScope(a, scope);
      if (mode === "people") scoped = scoped.filter(hitsPerson);
      return { ...a, scoped };
    }).filter(a => {
      if (mode === "apps" && !hitsApp(a)) return false;
      if (a.scoped.length === 0 && (mode === "people" || scope !== "all")) return false;   // nothing of it on that person / in that department
      return true;
    });
    if (mandOnly) {
      // one department: that department's mandatory apps. All departments: mandatory in at least one department.
      const scopes = scope === "all" ? [...new Set((this.data.users || []).map(u => this.deptKeyOf(u)))] : [scope];
      const mand = new Set();
      scopes.forEach(sc => SWLogic.mandatoryApps(this.data.apps, this.data.users, this.rules, sc).forEach(n => mand.add(n)));
      apps = apps.filter(a => mand.has(a.name));
    }
    apps.sort((a, b) => b.scoped.length - a.scoped.length || a.name.localeCompare(b.name));
    this._view = apps;
    const total = this.data.apps.length, cnt = document.getElementById("swCount");
    if (cnt) cnt.textContent = apps.length === total ? `${total} apps` : `Showing ${apps.length} of ${total}`;
    const st = document.getElementById("swStats");
    if (st) {
      const depts = new Set((this.data.users || []).map(u => this.deptKeyOf(u))).size;
      const when = this.generatedAt ? this.generatedAt.slice(0, 10) : "—";
      const card = (n, l) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`;
      st.innerHTML = card(total.toLocaleString(), "Apps found") + card((this.data.users || []).length.toLocaleString(), "People scanned") + card(depts, "Departments") + card(`<span style="font-size:22px">${esc(when)}</span>`, "Last synced");
    }
    const noteBits = [];
    if (ql && mode === "apps") noteBits.push(`matching <b>${esc(q)}</b>`);
    if (ql && mode === "people") noteBits.push(`installed on people or devices matching <b>${esc(q)}</b>`);
    const deptUsers = scope === "all" ? [] : (this.data.users || []).filter(u => this.deptKeyOf(u) === scope);
    let html = "";
    if (!this.hasDept) html += `<div class="cfg-warn" style="margin-bottom:12px">Department grouping is dormant — grant <code>User.Read.All</code> and Refresh to group by department. For now apps group by site only.</div>`;
    if (noteBits.length) html += `<p class="sub-note" style="margin:0 0 12px">${apps.length} app${apps.length === 1 ? "" : "s"} ${noteBits.join(" · ")}.</p>`;
    if (ql && appHits && personHits)
      html += `<div class="ak-chips" style="margin:0 0 12px"><span class="muted" style="font-size:12.5px;align-self:center">Show:</span>
        <button type="button" class="ak-chip${mode === "apps" ? " on" : ""}" onclick="Software.setMode('apps')">Software matching it (${appHits})</button>
        <button type="button" class="ak-chip${mode === "people" ? " on" : ""}" onclick="Software.setMode('people')">What people or devices matching it have (${personHits})</button></div>`;
    if (mandOnly) html += `<p class="sub-note" style="margin:0 0 12px">${scope === "all" ? "Apps that are mandatory in at least one department." : "Apps mandatory for <b>" + esc(scope) + "</b>."} Pick a department to see or change its list.</p>`;
    if (ql && !apps.length) html += `<div class="empty">Nothing matches <b>${esc(q)}</b>${scope !== "all" ? " in this department" : ""}. Try a shorter word, a user name, or a device name.</div>`;
    if (scope !== "all") html += this._complianceHtml(scope, deptUsers);
    html += `<table class="fit sw-tbl"><colgroup><col style="width:34%"><col style="width:14%"><col style="width:20%"><col style="width:9%">${scope !== "all" ? '<col style="width:9%">' : ""}<col style="width:110px"></colgroup>` +
      `<thead><tr><th>App</th><th>Version</th><th>Publisher</th><th>${scope === "all" ? "Installs" : "In scope"}</th>${scope !== "all" ? "<th>Mandatory</th>" : ""}<th></th></tr></thead><tbody>` +
      apps.map((a, i) => `<tr class="sw-row" onclick="Software.drill(${i})" title="Click to see who has it">
        <td title="${attr(a.name)}">${esc(a.name)}</td><td>${esc(a.version || "—")}</td><td class="muted" title="${attr(a.publisher || "")}">${esc(a.publisher || "—")}</td>
        <td>${a.scoped.length}</td>
        ${scope !== "all" ? `<td onclick="event.stopPropagation()"><input type="checkbox" ${this.isMandatory(a.name, scope) ? "checked" : ""} onchange="Software.toggleMandatory('${attr(a.name)}','${attr(scope)}',this.checked)"></td>` : ""}
        <td style="text-align:right;white-space:nowrap"><button class="rowbtn">Who has it ›</button></td></tr>`).join("") +
      `</tbody></table>`;
    host.innerHTML = html;
  },
  copy() {
    const rows = this._view || [], cell = v => String(v == null ? "" : v).replace(/[\t\r\n]+/g, " ");
    const txt = ["App\tVersion\tPublisher\tInstalls"].concat(rows.map(a => [a.name, a.version, a.publisher, (a.scoped || []).length].map(cell).join("\t"))).join("\n");
    const done = () => App.toast(`Copied ${rows.length} app${rows.length === 1 ? "" : "s"}.`);
    const fb = () => { const t = document.createElement("textarea"); t.value = txt; document.body.appendChild(t); t.select(); try { document.execCommand("copy"); done(); } catch (e) { App.toast("Could not copy.", true); } t.remove(); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, fb); else fb();
  },
  _mode: "", _t: null,
  typed() { this._mode = ""; clearTimeout(this._t); this._t = setTimeout(() => this.render(), 120); },
  setMand(el) { document.querySelectorAll("input[name=swMand]").forEach(i => i.parentElement.classList.toggle("on", i.checked)); this.render(); },
  setMode(m) { this._mode = m; this.render(); },
  /* from the Who-has-it window: jump to everything this person has */
  byPerson(who) { Drill.close(); const el = document.getElementById("swSearch"); if (el) el.value = who; this._mode = "people"; this.render(); window.scrollTo(0, 0); },
  _complianceHtml(scope, deptUsers) {
    const mand = SWLogic.mandatoryApps(this.data.apps, this.data.users, this.rules, scope);
    if (!mand.length) return `<div class="sw-compliance"><b>${esc(scope)}</b> — ${deptUsers.length} user(s). Tick apps below as <b>Mandatory</b> to see who's missing them.</div>`;
    // Missing is judged on the LATEST version of each app; a user with only an older
    // release still counts as missing. Sort worst-covered first.
    const rows = mand.map(name => {
      const have = SWLogic.haveUsers(this.data.apps, name);
      const latest = SWLogic.latestApp(this.data.apps, name);
      const missing = deptUsers.filter(u => !have.has((u.user || "").toLowerCase()));
      const auto = SWLogic.isAuto(this.data.apps, this.data.users, scope, name);
      return { name, ver: latest ? latest.version : "", missing, auto };
    }).sort((a, b) => b.missing.length - a.missing.length || a.name.localeCompare(b.name));
    const body = rows.map(r =>
      `<div class="sw-miss-row"><div><b>${esc(r.name)}</b>${r.ver ? ` <span class="muted">v${esc(r.ver)}</span>` : ""}${r.auto ? ` <span class="auto-tag">auto</span>` : ""} <span class="muted">— ${r.missing.length} of ${deptUsers.length} missing</span></div>` +
      (r.missing.length ? `<div class="sw-miss-users">${r.missing.map(u => esc(u.user)).join(", ")}</div>` : `<div class="muted">Everyone has it ✓</div>`) + `</div>`).join("");
    return `<div class="sw-compliance"><div class="sw-comp-h">Mandatory app compliance — ${esc(scope)}</div>` +
      `<div class="sw-comp-note">${SWLogic.autoText()} here are mandatory automatically (<span class="auto-tag">auto</span>); missing is checked against the latest version. Tick/untick below to adjust.</div>${body}</div>`;
  },
  drill(i) {
    const a = (this._view || [])[i]; if (!a) return;
    const rows = a.scoped || this._installsInScope(a, this._scope());
    Drill.open(`${a.name}${a.version ? ` · ${a.version}` : ""}`, rows, [
      { label: "User", w: "34%", html: true, text: r => r.user || "", get: r => r.user ? `<a class="sw-user" title="See everything ${attr(r.user)} has" onclick="Software.byPerson('${attr(r.user)}')">${esc(r.user)}</a>` : "—" },
      { label: "Device", w: "22%", get: r => r.device || "—", mono: 1 },
      { label: "Site", w: "8%", get: r => r.site || "—" }, { label: "Department", w: "36%", get: r => r.dept || "—" }],
      { empty: "No installs in this scope.", width: "1000px", countLabel: "installs", search: true });
  },
  async refresh() {
    const btn = document.getElementById("swRefreshBtn"); const old = btn ? btn.innerHTML : "";
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="busy-spin"></span> Pulling from Intune…'; }
    const r = await Backend.call("software_refresh");
    if (btn) { btn.disabled = false; btn.innerHTML = old; }
    if (!r || !r.ok) return App.error((r && r.error) || "Software refresh failed.");
    await this.load();
    App.toast(`Software inventory refreshed: ${r.apps} apps across ${r.devices} device(s)${r.has_dept ? "" : " — department dormant (grant User.Read.All)"}.`);
  },
};

/* ---- Upgrade list -------------------------------------------------------
   A prioritized, hand-orderable queue of devices awaiting a hardware upgrade.
   Devices are added from the Devices (In Use) list or the "Needs upgrade" aged
   list with a priority (1-5, 5 = highest) and notes; each lands under its site
   tab (LTR / BRI / Other by the device's site tag). Drag or ↑/↓ to reorder;
   ✓ checks it off (removes it and appends to the completed log with who/when).
   Stored shared + no-auth in the Endpoint Hub folder (Backend hub_*_upgrade). */
const Upgrade = {
  items: [], log: [], activeTab: "LTR", _pri: 3,
  get SITES() { return [...Divisions.codes(), "Other"]; },

  siteKey(site) { return Divisions.bucket(site); },

  resolveDevice(serial) {
    const s = String(serial);
    const r = (App.state.use || []).find(x => x.serial === s)
      || (App.state.stock || []).find(x => x.serial === s) || { serial: s };
    return { serial: r.serial || s, device_name: r.device_name || "", model: r.model || "",
             user: r.user || "", site: r.site_tag || "", site_tag: r.site_tag || "" };
  },

  refresh(btn) { return Ui.refreshing(btn, () => this.load(), "Upgrade list"); },

  async load() {
    try {
      const r = await Backend.call("hub_get_upgrades");
      const d = (r && r.ok && r.data) || {};
      this.items = Array.isArray(d.items) ? d.items : [];
      this.log = (r && r.ok && r.log && Array.isArray(r.log.entries)) ? r.log.entries : [];
      this.ignored = (r && r.ok && r.ignored) || 0;
    } catch (e) { this.items = []; this.log = []; }
    // linked setups -> live progress for "working" items
    this._setupsById = {};
    try {
      const sr = await Backend.call("hub_get_setups");
      ((sr && sr.ok && sr.setups) || []).forEach(s => {
        const pct = typeof s.pct === "number" ? s.pct : (s.total ? Math.round((s.done || 0) / s.total * 100) : 0);
        this._setupsById[s.id] = { pct, status: s.status, done: s.done || 0, total: s.total || 0 };
      });
    } catch (e) {}
    this._restoreView();
    if (![...this.SITES, "log"].includes(this.activeTab)) this.activeTab = this.SITES[0];
    this.renderTabs(); this.render();
  },

  /* ---- state of the page: filters, view, ticked rows ---- */
  f: { q: "", pri: "", reason: "", status: "" }, view: "list", sel: new Set(), _t: null,
  _isAuto(it) { return /^auto-added:/i.test(it.notes || ""); },
  _reason(it) { return (it.notes || "").replace(/^auto-added:\s*/i, ""); },
  _dev(serial) { const s = String(serial); return (App.state.use || []).find(x => x.serial === s) || (App.state.stock || []).find(x => x.serial === s) || null; },
  _siteList() { return this.items.filter(it => this.siteKey(it.site) === this.activeTab); },
  _match(it) {
    const f = this.f, q = f.q.trim().toLowerCase();
    if (f.pri && String(it.priority || 3) !== f.pri) return false;
    if (f.reason && (f.reason === "auto") !== this._isAuto(it)) return false;
    if (f.status && (f.status === "working") !== (it.status === "working")) return false;
    return !q || [it.serial, it.device_name, it.user, it.model, it.notes].some(v => (v || "").toLowerCase().includes(q));
  },
  _visible() { return this._siteList().filter(it => this._match(it)); },
  _anyFilter() { return !!(this.f.q.trim() || this.f.pri || this.f.reason || this.f.status); },
  typed(v) { this.f.q = v; clearTimeout(this._t); this._t = setTimeout(() => this.render(), 120); },
  setF(k, v) { this.f[k] = v; this.render(); },
  clearF() { this.f = { q: "", pri: "", reason: "", status: "" }; this._syncTools(); this.render(); },
  setView(v) { this.view = v; document.querySelectorAll("#upViewSeg label").forEach(l => l.classList.toggle("on", l.querySelector("input").value === v)); this.render(); },
  _syncTools() {
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
    set("upQ", this.f.q); set("upPri", this.f.pri); set("upReason", this.f.reason); set("upStatus", this.f.status);
    document.querySelectorAll("#upViewSeg label").forEach(l => { const i = l.querySelector("input"); i.checked = i.value === this.view; l.classList.toggle("on", i.checked); });
    Filt.syncAll();
  },

  /* remembered for each division: site tab, view and filters */
  _viewKey() { return "nbg_up_view_" + (Divisions.current || "x"); },
  _restoreView() {
    const key = this._viewKey(); if (this._restored === key) return; this._restored = key;
    let v = null; try { v = JSON.parse(localStorage.getItem(key) || "null"); } catch (e) { v = null; }
    if (!v) return;
    if (typeof v.tab === "string") this.activeTab = v.tab;
    if (v.view === "model" || v.view === "list") this.view = v.view;
    if (v.f && typeof v.f === "object") this.f = { q: String(v.f.q || ""), pri: String(v.f.pri || ""), reason: String(v.f.reason || ""), status: String(v.f.status || "") };
    this._syncTools();
  },
  _saveView() { if (this._restored !== this._viewKey()) return; try { localStorage.setItem(this._viewKey(), JSON.stringify({ tab: this.activeTab, view: this.view, f: this.f })); } catch (e) { /* private window */ } },

  _stats() {
    const el = document.getElementById("upStats"); if (!el) return;
    const items = this.items, high = items.filter(it => (it.priority || 3) >= 4).length, working = items.filter(it => it.status === "working").length;
    const card = (n, l) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`;
    el.innerHTML = card(items.length, "On the list") + card(high, "High priority (P4-P5)") + card(working, "Being upgraded now") + card((this.log || []).length, "Completed");
  },

  renderTabs() {
    const el = document.getElementById("upTabs"); if (!el) return;
    const tabs = [...this.SITES.map(s => ({ id: s, label: s })), { id: "log", label: "Completed" }];
    const count = id => id === "log" ? (this.log || []).length : this.items.filter(it => this.siteKey(it.site) === id).length;
    el.innerHTML = tabs.map(t => `<div class="tab${this.activeTab === t.id ? " active" : ""}" onclick="Upgrade.tab('${t.id}')">${esc(t.label)} (${count(t.id)})</div>`).join("");
  },
  tab(id) { if (this.activeTab !== id) this.sel.clear(); this.activeTab = id; this.renderTabs(); this.render(); },

  render() {
    this._restoreView();
    this._stats();
    this._renderBody();
    const host = document.getElementById("upHost");
    if (host && this.activeTab !== "log" && this.ignored) {
      const n = document.createElement("div");
      n.className = "up-ignored";
      n.innerHTML = `<span>${this.ignored} device${this.ignored === 1 ? " is" : "s are"} skipped by the automatic rules because ${this.ignored === 1 ? "it was" : "they were"} completed or removed from this list before.</span>
        <button class="ghost" onclick="Upgrade.allowAgain()">Allow them again</button>`;
      host.appendChild(n);
    }
    this._saveView();
  },
  async allowAgain() {
    if (!confirm("Let the automatic rules add these devices again if they still meet the rules?")) return;
    const r = await Backend.call("hub_clear_upgrade_ignored");
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not do that.", true);
    App.toast(r.cleared + " device(s) can be added again at the next sync.");
    this.load();
  },
  _toolbar(shown, total, isLog) {
    ["upPri", "upReason", "upStatus", "upViewSeg"].forEach(id => { const e = document.getElementById(id); if (e) e.classList.toggle("hidden", isLog); });
    const cnt = document.getElementById("upCount");
    if (cnt) cnt.textContent = shown === total ? `${total} ${total === 1 ? "device" : "devices"}` : `Showing ${shown} of ${total}`;
    const c = document.getElementById("upClear"); if (c) c.classList.toggle("hidden", !this._anyFilter());
  },
  _renderBody() {
    const host = document.getElementById("upHost"); if (!host) return;
    if (this.activeTab === "log") {
      const q = this.f.q.trim().toLowerCase();
      const rows = (this.log || []).filter(e => !q || [e.serial, e.model, e.user, e.site, e.completed_by, e.added_by].some(v => (v || "").toLowerCase().includes(q)));
      this._shownLog = rows; this._shown = []; this.sel.clear();
      host.innerHTML = this._logHtml(rows);
      this._toolbar(rows.length, (this.log || []).length, true); this.updateBulk(); return;
    }
    const all = this._siteList(), list = this._visible();
    this._shown = list; this._shownAll = all;
    const shownIds = new Set(list.map(it => it.id));
    [...this.sel].forEach(id => { if (!shownIds.has(id)) this.sel.delete(id); });         // only rows you can see stay ticked
    this._toolbar(list.length, all.length, false);
    if (!all.length) {
      host.innerHTML = `<div class="empty">No devices queued for ${this.activeTab === "Other" ? "sites outside " + Divisions.label() : this.activeTab}. Add one from the Devices list or the “Needs upgrade” dashboard tile.</div>`;
      this.updateBulk(); return;
    }
    if (!list.length) { host.innerHTML = `<div class="empty">Nothing matches these filters. <a class="sw-user" onclick="Upgrade.clearF()">Clear filters</a></div>`; this.updateBulk(); return; }
    if (this.view === "model") { host.innerHTML = this._modelHtml(list); this.updateBulk(); return; }
    host.innerHTML = "";
    const wrap = document.createElement("div"); wrap.className = "up-list";
    list.forEach(it => wrap.appendChild(this._row(it, all.indexOf(it))));
    host.appendChild(wrap);
    this.updateBulk();
  },

  /* ---- "by model": what to order, at a glance ---- */
  _byModel(list) {
    const m = {};
    list.forEach(it => { const k = (it.model || "").trim() || "(model unknown)"; const g = m[k] = m[k] || { model: k, n: 0, pri: {}, names: [] }; g.n++; const p = it.priority || 3; g.pri[p] = (g.pri[p] || 0) + 1; g.names.push(it.device_name || it.serial); });
    return Object.values(m).sort((a, b) => b.n - a.n || a.model.localeCompare(b.model));
  },
  _priText(g) { return [5, 4, 3, 2, 1].filter(p => g.pri[p]).map(p => `P${p}×${g.pri[p]}`).join("  "); },
  _modelHtml(list) {
    const rows = this._byModel(list);
    return `<table class="fit"><thead><tr><th>Model</th><th style="width:70px">Qty</th><th style="width:230px">Priorities</th><th>Devices</th></tr></thead><tbody>` +
      rows.map(g => `<tr class="up-modelrow" onclick="Upgrade.openModel(this.dataset.m)" data-m="${attr(g.model)}" title="Show these devices"><td><b>${esc(g.model)}</b></td><td>${g.n}</td><td>${esc(this._priText(g))}</td>` +
        `<td class="muted">${esc(g.names.slice(0, 6).join(", "))}${g.names.length > 6 ? ` + ${g.names.length - 6} more` : ""}</td></tr>`).join("") +
      `</tbody></table><div class="sub-note" style="margin:10px 18px">${list.length} devices, ${rows.length} model${rows.length === 1 ? "" : "s"}. Click a model to see its devices.</div>`;
  },
  openModel(m) { this.f.q = m === "(model unknown)" ? "" : m; this._syncTools(); this.setView("list"); },

  copy() {
    const cell = v => String(v == null ? "" : v).replace(/[\t\r\n]+/g, " ");
    let head, rows;
    if (this.activeTab === "log") {
      head = ["Serial", "Model", "Site", "Priority", "User", "Added", "Completed", "Completed by", "Days on list"];
      rows = (this._shownLog || []).map(e => [e.serial, e.model, e.site, "P" + (e.priority || ""), e.user, (e.added_at || "").slice(0, 10), (e.completed_at || "").slice(0, 10), e.completed_by, this._waited(e)]);
    } else if (this.view === "model") {
      head = ["Model", "Qty", "Priorities"];
      rows = this._byModel(this._shown || []).map(g => [g.model, g.n, this._priText(g)]);
    } else {
      head = ["#", "Serial", "Hostname", "Model", "User", "Priority", "Status", "Reason / notes", "Warranty", "Added"];
      rows = (this._shown || []).map(it => [(this._shownAll || []).indexOf(it) + 1, it.serial, it.device_name, it.model, it.user, "P" + (it.priority || 3), it.status === "working" ? "Working" : "Waiting", this._reason(it), this._warrDate(it), (it.added_at || "").slice(0, 10)]);
    }
    const txt = [head.join("\t")].concat(rows.map(r => r.map(cell).join("\t"))).join("\n");
    const done = () => App.toast(`Copied ${rows.length} row${rows.length === 1 ? "" : "s"}. Paste into Excel or a message.`);
    const fb = () => { const t = document.createElement("textarea"); t.value = txt; document.body.appendChild(t); t.select(); try { document.execCommand("copy"); done(); } catch (e) { App.toast("Could not copy.", true); } t.remove(); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, fb); else fb();
  },
  _warrDate(it) { const d = this._dev(it.serial); return d ? (d.warranty || "").slice(0, 10) : ""; },
  _warrHtml(it) {
    const w = this._warrDate(it); if (!w) return "";
    const t = Date.parse(w); if (isNaN(t)) return "";
    const days = Math.floor((t - Date.now()) / 86400000);
    const cls = days < 0 ? "w-exp" : days <= 90 ? "w-soon" : "";
    return ` · <span class="${cls}" title="${days < 0 ? "Warranty ended" : "Warranty ends"}">${days < 0 ? "warranty ended " : "warranty to "}${esc(w)}</span>`;
  },
  _waited(e) {
    const a = Date.parse(e.added_at || ""), b = Date.parse(e.completed_at || "");
    return isNaN(a) || isNaN(b) ? "" : Math.max(0, Math.round((b - a) / 86400000));
  },

  /* ---- tick rows, then act on all of them ---- */
  selToggle(id, on) { if (on) this.sel.add(id); else this.sel.delete(id); this.updateBulk(); },
  selAll(on) {
    this.sel.clear(); if (on) (this._shown || []).forEach(it => this.sel.add(it.id));
    document.querySelectorAll("#upHost .up-sel").forEach(cb => { cb.checked = on; });
    this.updateBulk();
  },
  updateBulk() {
    const bar = document.getElementById("upBulk"); if (!bar) return;
    const n = this.sel.size, shown = (this._shown || []).length;
    if (this.activeTab === "log" || this.view === "model" || !shown) { bar.classList.add("hidden"); bar.innerHTML = ""; return; }
    bar.classList.remove("hidden");
    const all = n === shown;
    bar.innerHTML = `<label class="bulk-all"><input type="checkbox" ${all ? "checked" : ""} onchange="Upgrade.selAll(this.checked)"> ${n ? `<b>${n} selected</b>` : "Select all shown"}</label>` +
      (n ? `<span class="bulk-actions"><button class="rowbtn" onclick="Upgrade.bulkOpen('priority')">Set priority…</button><button class="rowbtn" onclick="Upgrade.bulkOpen('site')">Move to site…</button>` +
           `<button class="rowbtn" onclick="Upgrade.bulkOpen('complete')">✓ Mark upgraded…</button><button class="rowbtn danger" onclick="Upgrade.bulkOpen('remove')">Remove…</button></span><a class="bulk-clear" onclick="Upgrade.selAll(false)">Clear selection</a>` : "");
  },
  bulkOpen(kind) {
    this._bk = kind; this._bpri = 3;
    const n = this.sel.size; if (!n) return;
    const T = { priority: "Set priority", site: "Move to site", complete: "Mark upgraded", remove: "Remove from list" }[kind];
    let body = "", btn = "Do it", danger = false;
    if (kind === "priority") { body = `<label class="up-lbl">New priority <span class="muted">(5 = highest)</span></label><div class="up-pri" id="bkUpPri">${[1, 2, 3, 4, 5].map(k => `<button type="button" class="up-pri-opt p${k}${k === 3 ? " sel" : ""}" data-p="${k}" onclick="Upgrade.bulkPick(${k})">${k}</button>`).join("")}</div>`; btn = `Set on ${n}`; }
    else if (kind === "site") { body = `<div class="field"><label>Site</label><select id="bkUpSite">${Divisions.codes().map(c => `<option>${esc(c)}</option>`).join("")}</select></div>`; btn = `Move ${n}`; }
    else if (kind === "complete") { body = `<p class="sub-note" style="margin:0">Each one leaves this list and is saved to the Completed log. The automatic rules will not queue it again.</p>`; btn = `Mark ${n} upgraded`; }
    else { danger = true; body = `<p class="sub-note" style="margin:0">Each one is removed from the list and is <b>not</b> logged as completed. The automatic rules will not queue it again.</p>`; btn = `Remove ${n}`; }
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal" style="width:500px;max-width:94vw"><div class="modal-head"><h3>${T} <span class="drill-n">${n}</span></h3><button onclick="Drill.close()">&times;</button></div>
        <div class="modal-body">${body}</div>
        <div class="modal-foot"><button class="ghost" onclick="Drill.close()">Cancel</button><button class="primary" id="bkUpGo" ${danger ? 'style="background:var(--red)"' : ""} onclick="Upgrade.bulkRun(this)">${btn}</button></div></div></div>`;
  },
  bulkPick(k) { this._bpri = k; document.querySelectorAll("#bkUpPri .up-pri-opt").forEach(b => b.classList.toggle("sel", +b.dataset.p === k)); },
  async bulkRun(btn) {
    const kind = this._bk, ids = [...this.sel], site = ((document.getElementById("bkUpSite") || {}).value || "");
    let r; await Ui.working(btn, "Working…", async () => { r = await Backend.call("hub_bulk_upgrades", kind, ids, kind === "priority" ? this._bpri : null, kind === "site" ? site : null); return false; });
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not do that.", true);
    Drill.close(); this.sel.clear();
    await this.load();
    App.toast(`${r.done} device${r.done === 1 ? "" : "s"} updated.`);
  },

  _row(it, idx) {
    const row = document.createElement("div");
    row.className = "up-row"; row.draggable = true; row.dataset.id = it.id;
    const p = it.priority || 3;
    const working = it.status === "working";
    const sp = (working && it.setup_id && this._setupsById) ? this._setupsById[it.setup_id] : null;
    const pct = sp ? sp.pct : 0;
    // "Working" banner + linked-setup progress bar when an upgrade is under way
    const workHtml = working
      ? `<div class="up-work"><span class="tag ok">Working</span>` +
          `<span class="muted">by ${esc(it.started_by || "—")}${it.started_at ? " · " + esc(it.started_at.slice(0, 10)) : ""}</span>` +
          `<span class="up-prog"><span class="up-prog-fill" style="width:${pct}%"></span></span>` +
          `<span class="up-prog-lbl">${sp ? `${sp.done}/${sp.total} (${pct}%)` : "setup linked"}</span>` +
          `<button class="rowbtn up-opensetup" title="Open the linked computer setup">Open setup</button></div>`
      : "";
    const auto = this._isAuto(it);
    row.innerHTML =
      `<input type="checkbox" class="rowsel up-sel" title="Select" ${this.sel.has(it.id) ? "checked" : ""}>` +
      `<span class="up-pos">${idx + 1}</span>` +
      `<span class="handle" title="Drag to reorder">☰</span>` +
      `<span class="up-badge2 p${p}" title="Priority ${p} (5 = highest)">P${p}</span>` +
      `<div class="up-main">` +
        `<div class="up-top"><span class="mono">${esc(it.serial)}</span> <span class="up-model">${esc(it.model || "")}</span>${it.device_name ? ` <span class="muted">· ${esc(it.device_name)}</span>` : ""}</div>` +
        `<div class="up-sub">${esc(it.user || "—")}${it.notes ? ` — ${auto ? '<span class="md-tag" title="Added by the automatic rules">Auto</span> ' : ""}<span class="up-note">${esc(auto ? this._reason(it) : it.notes)}</span>` : ""}${this._warrHtml(it)}</div>` +
        `<div class="up-meta">Added ${esc((it.added_at || "").slice(0, 10))}${auto ? " automatically" : (it.added_by ? ` by ${esc(it.added_by)}` : "")}` +
          `${(it.updated_at && it.updated_at !== it.added_at && !(auto && (it.history || []).length < 2)) ? ` · edited ${esc(it.updated_at.slice(0, 10))}${it.updated_by ? ` by ${esc(it.updated_by)}` : ""}` : ""}</div>` +
        workHtml +
      `</div>` +
      `<div class="up-ctrls">` +
        (working ? "" : `<button class="iconbtn up-begin" title="Begin upgrade — starts a new computer setup and marks this Working">▶ Begin</button>`) +
        `<button class="iconbtn" title="Move up">↑</button>` +
        `<button class="iconbtn" title="Move down">↓</button>` +
        `<button class="iconbtn txt" title="Edit priority / notes, see history">✎ Edit</button>` +
        `<button class="iconbtn done txt" title="Mark upgraded (moves to the Completed log)">✓ Done</button>` +
        `<button class="iconbtn del txt" title="Remove from the list (not logged as completed)">✕ Remove</button>` +
      `</div>`;
    const beginBtn = row.querySelector(".up-begin"); if (beginBtn) beginBtn.onclick = () => this.begin(it.id);
    const openBtn = row.querySelector(".up-opensetup"); if (openBtn) openBtn.onclick = () => { if (it.setup_id) { Nav.go("hub"); Hub.resumeSetup(it.setup_id); } };
    const btns = [...row.querySelectorAll('.up-ctrls .iconbtn:not(.up-begin)')];
    btns[0].onclick = () => this.move(it.id, -1);
    btns[1].onclick = () => this.move(it.id, 1);
    btns[2].onclick = () => this.editPrompt(it.id);
    btns[3].onclick = () => this.complete(it.id);
    btns[4].onclick = () => this.remove(it.id);
    row.querySelector(".up-sel").addEventListener("change", e => this.selToggle(it.id, e.target.checked));
    row.addEventListener("click", e => { if (!e.target.closest("button,input,a,.handle,select,textarea")) this.editPrompt(it.id); });
    row.addEventListener("dragstart", e => { row.classList.add("dragging"); e.dataTransfer.setData("text/plain", it.id); });
    row.addEventListener("dragend", () => { row.classList.remove("dragging"); document.querySelectorAll(".up-row.dragover").forEach(x => x.classList.remove("dragover")); });
    row.addEventListener("dragover", e => { e.preventDefault(); row.classList.add("dragover"); });
    row.addEventListener("dragleave", () => row.classList.remove("dragover"));
    row.addEventListener("drop", e => { e.preventDefault(); row.classList.remove("dragover"); this._drop(e.dataTransfer.getData("text/plain"), it.id); });
    return row;
  },

  move(id, dir) {
    const site = this.activeTab;
    const ids = this.items.filter(it => this.siteKey(it.site) === site).map(it => it.id);
    const i = ids.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    ids.splice(j, 0, ids.splice(i, 1)[0]);
    this._reorder(site, ids);
  },
  _drop(fromId, toId) {
    const site = this.activeTab;
    const ids = this.items.filter(it => this.siteKey(it.site) === site).map(it => it.id);
    const fi = ids.indexOf(fromId), ti0 = ids.indexOf(toId);
    if (fi < 0 || ti0 < 0 || fi === ti0) return;
    const moved = ids.splice(fi, 1)[0];
    // drop onto a target that was BELOW -> land just after it; onto one ABOVE -> before it
    const ti = ids.indexOf(toId) + (fi < ti0 ? 1 : 0);
    ids.splice(ti, 0, moved);
    this._reorder(site, ids);
  },
  _reorder(site, orderedIds) {
    const ordered = orderedIds.map(id => this.items.find(x => x.id === id)).filter(Boolean);
    let k = 0;
    this.items = this.items.map(it => this.siteKey(it.site) === site ? ordered[k++] : it);
    this.render(); this.renderTabs(); this.save();
  },
  async save() {
    const r = await Backend.call("hub_save_upgrades", { items: this.items });
    if (r && r.ok && Array.isArray(r.items)) this.items = r.items;
  },

  async complete(id) {
    const it = this.items.find(x => x.id === id);
    if (!confirm(`Mark ${it ? it.serial : "this device"} as upgraded? It will be removed from the list and saved to the completed log.`)) return;
    const r = await Backend.call("hub_complete_upgrade", id);
    if (!r || !r.ok) return App.error((r && r.error) || "Could not complete the upgrade.");
    await this.load();
    App.toast(`${it ? it.serial : "Device"} marked upgraded and logged.`);
  },
  remove(id) {
    const it = this.items.find(x => x.id === id);
    if (!confirm(`Remove ${it ? it.serial : "this device"} from the upgrade list? This is not logged.`)) return;
    Backend.call("hub_remove_upgrade", id).then(r => {
      if (r && r.ok) { this.items = Array.isArray(r.items) ? r.items : this.items; this.render(); this.renderTabs(); }
    });
  },
  // Begin Upgrade: open a NEW computer setup for this device under Endpoint
  // Provisioning, mark this entry "Working" + who, and link the setup so its
  // progress shows here.
  begin(id) {
    const it = this.items.find(x => x.id === id); if (!it) return;
    Nav.go("hub");
    Hub.beginForUpgrade(it);
  },

  addPrompt(serial) {
    const dev = this.resolveDevice(serial);
    this._pri = 3;
    const site = this.siteKey(dev.site);
    const pbtn = n => `<button type="button" class="up-pri-opt p${n}${n === 3 ? " sel" : ""}" data-p="${n}" onclick="Upgrade._pick(${n})">${n}</button>`;
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal" style="width:520px;max-width:94vw;">
        <div class="modal-head"><h3>Add to upgrade list</h3><button onclick="Drill.close()">&times;</button></div>
        <div class="modal-body">
          <div class="up-dev">
            <div class="mono" style="font-size:15px">${esc(dev.serial)}</div>
            <div>${esc(dev.model || "—")}${dev.device_name ? ` · ${esc(dev.device_name)}` : ""}</div>
            <div class="muted">${esc(dev.user || "no user")} · ${site === "Other" ? "No " + Divisions.label() + " site" : site}</div>
          </div>
          <label class="up-lbl">Priority <span class="muted">(5 = highest)</span></label>
          <div class="up-pri" id="upPri">${[1, 2, 3, 4, 5].map(pbtn).join("")}</div>
          <label class="up-lbl">Notes</label>
          <textarea id="upNotes" class="up-notes" rows="4" placeholder="Why / what to upgrade (RAM, SSD, full replacement)…"></textarea>
          <div class="up-actions">
            <button class="ghost" onclick="Drill.close()">Cancel</button>
            <button class="primary" onclick="Upgrade._submit('${attr(dev.serial)}')">Add to list</button>
          </div>
        </div>
      </div></div>`;
  },
  _pick(n) { this._pri = n; document.querySelectorAll("#upPri .up-pri-opt").forEach(b => b.classList.toggle("sel", +b.dataset.p === n)); },
  async _submit(serial) {
    const dev = this.resolveDevice(serial);
    const notes = (document.getElementById("upNotes").value || "").trim();
    const r = await Backend.call("hub_add_upgrade", dev, this._pri, notes);
    Drill.close();
    if (!r || !r.ok) return App.error((r && r.error) || "Could not add to the upgrade list.");
    if (Array.isArray(r.items)) this.items = r.items;
    App.toast(`${serial} added to the upgrade list (P${this._pri}).`);
    this.activeTab = this.siteKey(dev.site);
    this.renderTabs(); this.render();
  },

  editPrompt(id) {
    const it = this.items.find(x => x.id === id); if (!it) return;
    this._editId = id;
    this._pri = it.priority || 3;
    const hist = (it.history || []).slice().reverse().slice(0, 6);
    const histHtml = hist.length
      ? `<div class="up-lbl" style="margin-top:16px">History</div><div class="up-hist">` +
        hist.map(h => `<div class="up-hist-row"><span>${esc((h.at || "").slice(0, 10))} · ${esc(h.by || "—")}</span>` +
          `<span class="muted">${esc(h.action || "")}${h.priority ? ` P${esc(h.priority)}` : ""}${h.notes ? ` — ${esc(h.notes)}` : ""}</span></div>`).join("") + `</div>`
      : "";
    const pbtn = n => `<button type="button" class="up-pri-opt p${n}${n === (it.priority || 3) ? " sel" : ""}" data-p="${n}" onclick="Upgrade._pick(${n})">${n}</button>`;
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal" style="width:540px;max-width:94vw;">
        <div class="modal-head"><h3>Edit upgrade entry</h3><button onclick="Drill.close()">&times;</button></div>
        <div class="modal-body">
          <div class="up-dev">
            <div class="mono" style="font-size:15px">${esc(it.serial)}</div>
            <div>${esc(it.model || "—")}${it.device_name ? ` · ${esc(it.device_name)}` : ""}</div>
            <div class="muted">${esc(it.user || "no user")} · ${esc(this.siteKey(it.site))}</div>
          </div>
          <label class="up-lbl">Priority <span class="muted">(5 = highest)</span></label>
          <div class="up-pri" id="upPri">${[1, 2, 3, 4, 5].map(pbtn).join("")}</div>
          <label class="up-lbl">Notes <span class="muted">— why it's a priority (defects, failing hardware, etc.)</span></label>
          <textarea id="upNotes" class="up-notes" rows="4">${esc(it.notes || "")}</textarea>
          ${histHtml}
          <div class="up-actions">
            <button class="ghost" onclick="Drill.close()">Cancel</button>
            <button class="primary" onclick="Upgrade._submitEdit()">Save changes</button>
          </div>
        </div>
      </div></div>`;
  },
  async _submitEdit() {
    const id = this._editId;
    const notes = (document.getElementById("upNotes").value || "").trim();
    const r = await Backend.call("hub_update_upgrade", id, this._pri, notes);
    Drill.close();
    if (!r || !r.ok) return App.error((r && r.error) || "Could not save the changes.");
    if (Array.isArray(r.items)) this.items = r.items;
    App.toast("Upgrade entry updated.");
    this.renderTabs(); this.render();
  },

  _logHtml(rows) {
    const all = this.log || [];
    if (!all.length) return `<div class="empty">No completed upgrades yet. Check a device off to log it here.</div>`;
    rows = rows || all;
    if (!rows.length) return `<div class="empty">Nothing matches that search.</div>`;
    const waits = rows.map(e => this._waited(e)).filter(w => w !== "");
    const avg = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : null;
    return `<div class="sub-note" style="margin:12px 18px 0">${rows.length} completed${avg !== null ? ` · on average ${avg} day${avg === 1 ? "" : "s"} from being added to being upgraded` : ""}.</div>` +
      `<table class="up-logtbl"><thead><tr><th>Serial</th><th>Model</th><th>Site</th><th>Priority</th><th>User</th><th>Added</th><th>Completed</th><th>Days on list</th></tr></thead><tbody>` +
      rows.map(e => `<tr><td class="mono">${esc(e.serial || "")}</td><td>${esc(e.model || "")}</td><td>${esc(e.site || "")}</td><td>P${esc(e.priority || "")}</td><td>${esc(e.user || "")}</td>` +
        `<td>${esc((e.added_at || "").slice(0, 10))}${e.added_by && !/^auto/i.test(e.notes || "") ? ` · ${esc(e.added_by)}` : (/^auto/i.test(e.notes || "") ? " · auto" : "")}</td>` +
        `<td>${esc((e.completed_at || "").slice(0, 10))}${e.completed_by ? ` · ${esc(e.completed_by)}` : ""}</td><td>${esc(this._waited(e))}</td></tr>`).join("") +
      `</tbody></table>`;
  },
};

/* ---- Configuration modal (tabbed) ---------------------------------------
   A general settings dialog. First tab categorizes each MODEL by the department
   that uses it (Detailing has its own machines; Engineering, Sales, and a Shared
   pool for everyone else). Stored in the shared Endpoint Hub folder (no auth) so
   the whole team shares one mapping; the dashboard rolls up in-stock counts per
   department. More tabs (TABS array) can be added here later. */
const Depts = {
  DEFAULT: ["Detailing", "Engineering", "Sales", "Shared"],
  departments: [],
  map: {},
  loaded: false,
  TABS: [{ id: "models", label: "Model departments" }, { id: "sites", label: "NBT Sites" }, { id: "perms", label: "Group baselines" }, { id: "storage", label: "Storage" }],
  activeTab: "models",
  _sel: new Set(),
  _page: false,       // true while rendering inside the Settings page

  async load() {
    try {
      const r = await Backend.call("hub_get_departments");
      const d = (r && r.ok && r.data) || {};
      this.departments = (Array.isArray(d.departments) && d.departments.length) ? d.departments.slice() : this.DEFAULT.slice();
      this.map = d.map && typeof d.map === "object" ? { ...d.map } : {};
    } catch (e) {
      this.departments = this.DEFAULT.slice();
      this.map = {};
    }
    this.loaded = true;
  },

  deptFor(model) { return this.map[(model || "").trim()] || "Unassigned"; },

  // every model we currently hold, union any already-mapped model
  _models() {
    const counts = {};
    (App.state.stock || []).forEach(r => { const m = (r.model || "").trim(); if (m) counts[m] = (counts[m] || 0) + 1; });
    const names = new Set(Object.keys(counts));
    (App.state.use || []).forEach(r => { const m = (r.model || "").trim(); if (m) names.add(m); });
    Object.keys(this.map).forEach(m => names.add(m));
    return [...names].sort((a, b) => a.localeCompare(b)).map(m => ({ model: m, stock: counts[m] || 0 }));
  },

  async open(tab) {
    if (!this.loaded) await this.load();
    await Sites.load();
    await this._pbLoad();
    this._enter(tab || "models");          // no PIN any more: access will be gated by role later
  },

  /* Settings page: render the tab into #setPane instead of a modal */
  async openPage(tab) {
    this._page = true;
    if (!this.loaded) await this.load();
    await Sites.load();
    await this._pbLoad();
    this._enter(tab || "models");
  },

  async _pbLoad() {
    try {
      const r = await Backend.call("perm_get_baselines");
      this._pb = (r && r.ok && r.data) || { keyword: "", threshold: 0.7, departments: {} };
    } catch (e) {
      this._pb = { keyword: "", threshold: 0.7, departments: {} };
    }
    if (!this._pb.departments || typeof this._pb.departments !== "object") this._pb.departments = {};
  },

  // set up editable drafts for both tabs, then render
  _enter(tab) {
    this._draft = { ...this.map };
    this._depts = this.departments.slice();
    this._sel = new Set(); this._search = ""; this._filterDept = "";
    this._sCats = Sites.categories.slice();
    this._sList = Sites.list.map(s => ({ ...s }));
    this._sPin = Sites.pin;
    this.activeTab = tab || "models";
    this._render();
  },

  tab(name) { this.activeTab = name; this._sel = new Set(); this._search = ""; this._filterDept = ""; this._render(); },

  _render() {
    const tabBar = this.TABS.map(t =>
      `<button class="ctab${t.id === this.activeTab ? " active" : ""}" onclick="Depts.tab('${t.id}')">${esc(t.label)}</button>`).join("");
    let body = "", foot = "";
    if (this.activeTab === "models") { body = this._modelsBody(); foot = this._modelsFoot(); }
    else if (this.activeTab === "sites") { body = this._sitesBody(); foot = this._sitesFoot(); }
    else if (this.activeTab === "perms") { body = this._permsBody(); foot = this._permsFoot(); }
    else if (this.activeTab === "storage") { body = this._storageBody(); foot = ""; }
    if (this._page) {
      const pane = document.getElementById("setPane");
      if (!pane || pane.dataset.owner !== "depts") return;        // the user moved to another settings tab
      const t = this.TABS.find(x => x.id === this.activeTab);
      pane.innerHTML = Help.box({ models: "set-models", sites: "set-links", perms: "set-perms", storage: "set-storage" }[this.activeTab]) +
        `<div class="set-card"><div class="set-card-head"><h3>${esc(t ? t.label : "")}</h3></div>
        <div class="set-card-body">${body}</div>${foot}</div>`;
    } else {
      document.getElementById("modalRoot").innerHTML =
        `<div class="overlay"><div class="modal" style="width:820px;max-width:94vw;">
          <div class="modal-head"><h3>Configuration</h3><button onclick="Depts.close()">&times;</button></div>
          <div class="config-tabs">${tabBar}</div>
          <div class="modal-body" style="max-height:68vh;overflow:auto;">${body}</div>
          ${foot}
        </div></div>`;
    }
    if (this.activeTab === "models") { this._renderChips(); this._updateSelCount(); }
    else if (this.activeTab === "sites") { this._renderCatChips(); }
    else if (this.activeTab === "storage") { this._loadStorage(); }
  },

  // ---- BomsNet baselines tab -------------------------------------------
  // Per-department "expected" groups (the ones the majority of a department holds).
  // Analyze pulls each member's keyword groups from Entra; check/uncheck decides
  // which count as expected. Changes save live to the shared hub (no draft/Save).
  _permsFoot() {
    return `<div class="modal-foot"><span class="sub-note" style="margin:0;flex:1">Changes save automatically to the shared hub.</span>
      <button class="primary" onclick="Depts.close()">Done</button></div>`;
  },
  _permsBody() {
    const doc = this._pb || { keyword: "", threshold: 0.7, departments: {} };
    const thr = Math.round((doc.threshold || 0.7) * 100);
    const names = Object.keys(doc.departments || {}).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const cards = names.length ? names.map(n => this._pbCard(n, doc.departments[n])).join("")
      : `<div class="empty" style="padding:22px">No departments analyzed yet. Add one below to build its group baseline.</div>`;
    return `
      <div class="cfg-ok" style="margin:0 0 12px">Scope: <b>${esc(Divisions.label())} teammates only</b> — Entra company “${esc(doc.company || Divisions.cur().company_name)}”. Department names are shared across divisions, so members are filtered by company, not just department.</div>
      <div class="pb-controls">
        <label class="pb-thr">Majority threshold
          <input type="range" min="30" max="100" step="5" value="${thr}"
            oninput="document.getElementById('pbThrVal').textContent=this.value+'%'" onchange="Depts._pbThreshold(this.value)">
          <b id="pbThrVal">${thr}%</b></label>
        <span style="display:flex;gap:8px">
          <button class="ghost" onclick="Depts._pbAnalyzeAll()"${names.length ? "" : " disabled"}>↻ Re-analyze all</button>
          <button class="ghost" onclick="Depts._pbRebuild()" title="Find every ${esc(Divisions.label())} department in Entra and rebuild all baselines from scratch">⟳ Rebuild from ${esc(Divisions.label())} directory</button>
        </span>
      </div>
      <div class="pb-add">
        <div style="position:relative;flex:1">
          <input id="pbDeptInput" placeholder="Add a department to analyze… start typing its name" autocomplete="off"
            oninput="Depts._pbSuggest()" onkeydown="if(event.key==='Enter'){event.preventDefault();Depts._pbAnalyzeNew();}">
          <div id="pbSuggest" class="pb-suggest"></div>
        </div>
        <button class="primary" onclick="Depts._pbAnalyzeNew()">Analyze</button>
      </div>
      <div id="pbStatus"></div>
      <div class="pb-depts">${cards}</div>`;
  },
  _pbCard(name, d) {
    d = d || {}; const total = d.total || 0;
    const groups = (d.groups || []).slice().sort((a, b) => (b.count - a.count) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const expCount = groups.filter(g => g.expected).length;
    const rows = groups.map(g => {
      const pct = Math.round((g.pct || 0) * 100);
      return `<tr class="${g.expected ? "pb-on" : ""}">
        <td><input type="checkbox" ${g.expected ? "checked" : ""} onchange="Depts._pbToggle('${attr(name)}','${attr(g.name)}',this.checked)"></td>
        <td title="${attr(g.name)}">${esc(g.name)}</td>
        <td class="pb-cov"><span class="pb-bar"><span style="width:${pct}%"></span></span><span class="pb-pct">${g.count}/${total} · ${pct}%</span></td>
        <td><button class="cfg-del" title="Remove group" onclick="Depts._pbRemoveGroup('${attr(name)}','${attr(g.name)}')">&times;</button></td></tr>`;
    }).join("");
    return `<div class="pb-card">
      <div class="pb-card-head">
        <div><b>${esc(name)}</b><span class="muted"> · ${total} user${total === 1 ? "" : "s"} · ${expCount} expected${d.updated ? ` · analyzed ${esc(String(d.updated).slice(0, 10))}` : ""}</span></div>
        <div class="pb-card-act"><button class="ghost" onclick="Depts._pbAnalyzeOne('${attr(name)}')">↻ Re-analyze</button>
          <button class="cfg-del" title="Remove department" onclick="Depts._pbRemoveDept('${attr(name)}')">&times;</button></div>
      </div>
      <table class="pb-tbl"><colgroup><col style="width:32px"><col><col style="width:170px"><col style="width:28px"></colgroup>
        <thead><tr><th title="Expected?">✓</th><th>Group</th><th>Coverage</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4" class="muted" style="padding:8px">No groups found.</td></tr>`}</tbody></table>
      <div class="pb-addgrp"><input placeholder="Add a group manually…" onkeydown="if(event.key==='Enter'){event.preventDefault();Depts._pbAddGroup('${attr(name)}',this.value);this.value='';}"></div>
    </div>`;
  },
  async _pbSave() {
    try {
      const n = Object.keys((this._pb || {}).departments || {}).length;
      const r = await Backend.call("perm_save_baselines", this._pb, { action: "save", target: "Group baselines", detail: `${n} department(s)` });
      if (r && r.ok && r.data) this._pb = r.data;
    } catch (e) { }
  },
  _pbThreshold(v) {
    const thr = Math.min(Math.max(parseInt(v, 10) || 60, 0), 100) / 100;
    this._pb.threshold = thr;
    Object.values(this._pb.departments || {}).forEach(d => (d.groups || []).forEach(g => { g.expected = (g.pct || 0) >= thr; }));
    this._pbSave(); this._render();
  },
  _pbToggle(dept, name, on) {
    const d = (this._pb.departments || {})[dept]; if (!d) return;
    const g = (d.groups || []).find(x => x.name === name); if (g) g.expected = !!on;
    this._pbSave(); this._render();
  },
  _pbRemoveGroup(dept, name) {
    const d = (this._pb.departments || {})[dept]; if (!d) return;
    d.groups = (d.groups || []).filter(g => g.name !== name);
    this._pbSave(); this._render();
  },
  _pbAddGroup(dept, val) {
    const name = (val || "").trim(); if (!name) return;
    const d = (this._pb.departments || {})[dept]; if (!d) return;
    if (!(d.groups || []).some(g => g.name.toLowerCase() === name.toLowerCase())) {
      (d.groups = d.groups || []).push({ name, count: 0, pct: 0, expected: true });
      this._pbSave(); this._render();
    }
  },
  _pbRemoveDept(name) {
    if (!window.confirm(`Remove the saved baseline for “${name}”? You can rebuild it by analyzing again.`)) return;
    delete this._pb.departments[name];
    this._pbSave(); this._render();
  },
  _pbSuggest() {
    clearTimeout(this._pbSugT);
    this._pbSugT = setTimeout(async () => {
      const inp = document.getElementById("pbDeptInput"), box = document.getElementById("pbSuggest");
      if (!box) return;
      const q = (inp && inp.value || "").trim();
      if (q.length < 2) { box.innerHTML = ""; return; }
      const r = await Backend.call("perm_dept_suggest", q, "");
      if (!r || !r.ok) { box.innerHTML = ""; return; }
      const cur = (inp && inp.value || "").trim();
      if (cur.length < 2) { box.innerHTML = ""; return; }
      box.innerHTML = (r.departments || []).map(d =>
        `<div class="pb-sug" onclick="Depts._pbPickSuggest('${attr(d.dept)}')">${esc(d.dept)} <span class="muted">${d.count}</span></div>`).join("");
    }, 250);
  },
  _pbPickSuggest(name) {
    const inp = document.getElementById("pbDeptInput"); if (inp) inp.value = name;
    const box = document.getElementById("pbSuggest"); if (box) box.innerHTML = "";
  },
  async _pbAnalyzeNew() {
    const inp = document.getElementById("pbDeptInput"); const name = (inp && inp.value || "").trim();
    if (name.length < 2) { App.toast("Type a department name.", true); return; }
    const ok = await this._pbRun(name);
    if (ok) { const i2 = document.getElementById("pbDeptInput"); if (i2) i2.value = ""; const sg = document.getElementById("pbSuggest"); if (sg) sg.innerHTML = ""; }
  },
  async _pbAnalyzeOne(name) { await this._pbRun(name); },
  async _pbRun(name) {
    const st = document.getElementById("pbStatus");
    if (st) st.innerHTML = `<div class="pb-run">Analyzing <b>${esc(name)}</b> — reading each member's groups in Entra…</div>`;
    const r = await Backend.call("perm_analyze_dept", name, "");
    if (!r || !r.ok) { if (st) st.innerHTML = `<div class="cfg-warn">${esc((r && r.error) || "Analysis failed.")}</div>`; return false; }
    this._pb = r.data; this._render();
    const st2 = document.getElementById("pbStatus");
    if (st2) st2.innerHTML = `<div class="cfg-ok">Analyzed <b>${esc(r.department)}</b> — ${r.total} user${r.total === 1 ? "" : "s"}, ${r.found} distinct group${r.found === 1 ? "" : "s"} found.</div>`;
    return true;
  },
  // Discover every NBGW department (Entra companyName scope), wipe the old baselines,
  // and analyze each department big enough to have a meaningful majority.
  async _pbRebuild() {
    if (!window.confirm("Rebuild ALL group baselines from the " + Divisions.label() + " directory?\n\nThis finds every " + Divisions.label() + " department in Entra, replaces the current baselines, and re-analyzes each one (about a minute). Any groups you unchecked by hand will be reset.")) return;
    const st = document.getElementById("pbStatus");
    if (st) st.innerHTML = `<div class="pb-run">Finding ${esc(Divisions.label())} departments in Entra…</div>`;
    const d = await Backend.call("perm_discover_departments");
    if (!d || !d.ok) { if (st) st.innerHTML = `<div class="cfg-warn">${esc((d && d.error) || "Could not list " + Divisions.label() + " departments.")}</div>`; return; }
    const todo = (d.departments || []).filter(x => x.eligible).map(x => x.dept);
    const skipped = (d.departments || []).filter(x => !x.eligible);
    const reset = { keyword: (this._pb || {}).keyword || "", threshold: (this._pb || {}).threshold || 0.7,
                    company: d.company, departments: {} };
    const s = await Backend.call("perm_save_baselines", reset, { action: "rebuild", target: "Group baselines", detail: `Rebuilding ${todo.length} ${Divisions.label()} department(s)` });
    if (s && s.ok && s.data) this._pb = s.data;
    const failed = [];
    for (let i = 0; i < todo.length; i++) {
      const st2 = document.getElementById("pbStatus");
      if (st2) st2.innerHTML = `<div class="pb-run">Analyzing ${i + 1}/${todo.length}: <b>${esc(todo[i])}</b>…</div>`;
      const r = await Backend.call("perm_analyze_dept", todo[i], "");
      if (r && r.ok) this._pb = r.data; else failed.push(todo[i]);
    }
    this._render();
    const st3 = document.getElementById("pbStatus");
    if (st3) st3.innerHTML = `<div class="cfg-ok">Rebuilt <b>${todo.length - failed.length}</b> ${esc(Divisions.label())} department baseline(s) from ${d.total_users} ${esc(Divisions.label())} teammates.` +
      (skipped.length ? ` Skipped ${skipped.length} with fewer than ${d.min_members} people.` : "") +
      (failed.length ? ` <b>Failed:</b> ${esc(failed.join(", "))}.` : "") + `</div>`;
  },
  async _pbAnalyzeAll() {
    const names = Object.keys((this._pb || {}).departments || {});
    if (!names.length) return;
    const st = document.getElementById("pbStatus");
    for (let i = 0; i < names.length; i++) {
      if (st) st.innerHTML = `<div class="pb-run">Re-analyzing ${i + 1}/${names.length}: <b>${esc(names[i])}</b>…</div>`;
      const r = await Backend.call("perm_analyze_dept", names[i], "");
      if (r && r.ok) this._pb = r.data;
    }
    this._render();
    const st2 = document.getElementById("pbStatus");
    if (st2) st2.innerHTML = `<div class="cfg-ok">Re-analyzed ${names.length} department${names.length === 1 ? "" : "s"}.</div>`;
  },

  // ---- Storage tab -----------------------------------------------------
  // Read-only view of WHERE the shared team data lives + a shared/per-user
  // warning, so everyone can confirm they're pinned to the same synced folder.
  _storageBody() {
    return `<div id="cfgStorage"><div class="empty">Checking storage location…</div></div>`;
  },
  async _loadStorage() {
    const host = document.getElementById("cfgStorage"); if (!host) return;
    const r = await Backend.call("hub_storage_info");
    if (!r || !r.ok) { host.innerHTML = `<div class="empty">Could not read storage info.</div>`; return; }
    if (r.store === "sharepoint") {          // central store: nothing to configure, no folder
      host.innerHTML = `<div class="cfg-store">
          <div class="cfg-store-row"><span>Status</span><div><span class="tag ok">Shared</span></div></div>
          <div class="cfg-store-row"><span>Stored in</span><div>SharePoint: the central NBG Hub Data site (Inventory - Hub Items / Hub Files)</div></div>
          <div class="cfg-store-row"><span>Site</span><div class="mono">${esc(r.site || "")}</div></div>
          <div class="cfg-store-row"><span>This division</span><div class="mono">${esc(r.division || Divisions.current)}</div></div>
        </div>
        <div class="cfg-ok">✓ Everyone in this division reads and writes the same documents. There is no folder to share or sync.</div>
        <div class="up-actions"><button class="ghost" onclick="Backend.call('hub_open_folder')">Open the central site</button></div>`;
      return;
    }
    const badge = r.shared ? `<span class="tag ok">Shared</span>`
      : `<span class="tag warn">Per-user — NOT shared</span>`;
    const srcLabel = { config: "config.json (logs_folder)", arg: "explicit override", default: "beside the app (default)" }[r.source] || r.source;
    let note;
    if (r.shared) {
      note = `<div class="cfg-ok">✓ Data lives in the synced deployment folder (beside the app), so everyone running the app from here shares one list. If a teammate still sees different data, they're running an <b>older .exe</b> or from a <b>different folder</b> — have them use this same deployment.</div>`;
    } else {
      note = `<div class="cfg-warn">This is a <b>local, per-user</b> folder, so each machine keeps its own separate list. Run the app from the <b>synced OneDrive/SharePoint deployment folder</b> (so the data folder sits beside it), or set <code>"logs_folder"</code> in the shared <code>config.json</code> to a <code>\\\\server\\share</code> path.</div>`;
    }
    host.innerHTML = `
      <div class="cfg-store">
        <div class="cfg-store-row"><span>Status</span><div>${badge}</div></div>
        <div class="cfg-store-row"><span>Data folder</span><div class="mono">${esc(r.hub)}</div></div>
        <div class="cfg-store-row"><span>Source</span><div>${esc(srcLabel)}</div></div>
        <div class="cfg-store-row"><span>App folder</span><div class="mono">${esc(r.app_dir)}</div></div>
        <div class="cfg-store-row"><span>Exists</span><div>${r.exists ? "Yes" : "Not created yet"}</div></div>
      </div>
      ${note}
      <div class="up-actions"><button class="ghost" onclick="Backend.call('hub_open_folder')">Open data folder</button></div>`;
  },

  // ---- Model-department tab --------------------------------------------
  _optHtml(dep) {
    return `<option value=""${!dep ? " selected" : ""}>Unassigned</option>` +
      this._depts.map(d => `<option value="${attr(d)}"${d === dep ? " selected" : ""}>${esc(d)}</option>`).join("");
  },

  // models after the search box + department filter are applied
  _filteredModels() {
    const q = (this._search || "").toLowerCase();
    const f = this._filterDept || "";
    return this._models().filter(m => {
      if (q && !m.model.toLowerCase().includes(q)) return false;
      if (f && (this._draft[m.model] || "Unassigned") !== f) return false;
      return true;
    });
  },

  _rowsHtml(models) {
    if (!models.length) {
      const filtered = this._search || this._filterDept;
      return `<tr><td colspan="4"><div class="empty" style="padding:20px">${filtered
        ? "No models match your search / filter."
        : "No models yet — sign in and load Devices, then models appear here to categorize."}</div></td></tr>`;
    }
    return models.map(m => `<tr>
        <td class="dept-cbcell"><input type="checkbox" class="cb dept-check" data-model="${attr(m.model)}"${this._sel.has(m.model) ? " checked" : ""} onclick="Depts.selOne(this)"></td>
        <td>${esc(m.model)}</td>
        <td class="dept-instock">${m.stock || ""}</td>
        <td><select data-model="${attr(m.model)}" onchange="Depts._pick(this)">${this._optHtml(this._draft[m.model] || "")}</select></td>
      </tr>`).join("");
  },

  _modelsBody() {
    const bulkOpts = `<option value="">Unassigned</option>` + this._depts.map(d => `<option value="${attr(d)}">${esc(d)}</option>`).join("");
    const filterOpts = `<option value="">All departments</option>` +
      this._depts.map(d => `<option value="${attr(d)}"${this._filterDept === d ? " selected" : ""}>${esc(d)}</option>`).join("") +
      `<option value="Unassigned"${this._filterDept === "Unassigned" ? " selected" : ""}>Unassigned</option>`;
    return `
      <div class="dept-manage">
        <label>Departments</label>
        <div class="dept-chips" id="deptChips"></div>
        <div class="dept-add"><input id="deptNew" placeholder="Add a department…" onkeydown="if(event.key==='Enter'){event.preventDefault();Depts.addDept();}"><button class="ghost" onclick="Depts.addDept()">+ Add</button></div>
      </div>
      <div class="dept-toolbar">
        <input id="deptSearch" class="dept-search" placeholder="Search models…" value="${attr(this._search || "")}" oninput="Depts._applyFilter()">
        <select id="deptFilter" class="dept-filter" onchange="Depts._applyFilter()">${filterOpts}</select>
      </div>
      <div class="bulk-bar">
        <span class="bulk-count"><b id="selCount">0</b> selected</span>
        <span class="bulk-assign">Assign selected to
          <select id="bulkDept">${bulkOpts}</select>
          <button class="ghost" id="bulkApply" onclick="Depts.applyBulk()" disabled>Apply</button></span>
      </div>
      <table class="dept-table"><thead><tr>
          <th class="dept-cbcell"><input type="checkbox" class="cb" id="deptSelAll" title="Select all" onclick="Depts.selAll(this.checked)"></th>
          <th>Model</th><th>In stock</th><th>Department</th></tr></thead>
        <tbody id="deptRows">${this._rowsHtml(this._filteredModels())}</tbody></table>`;
  },

  // search / filter change: repaint only the rows (keeps the search box focused)
  _applyFilter() {
    const s = document.getElementById("deptSearch"), f = document.getElementById("deptFilter");
    this._search = s ? s.value.trim() : "";
    this._filterDept = f ? f.value : "";
    this._sel = new Set();
    const tbody = document.getElementById("deptRows");
    if (tbody) tbody.innerHTML = this._rowsHtml(this._filteredModels());
    const head = document.getElementById("deptSelAll"); if (head) head.checked = false;
    this._updateSelCount();
  },

  _modelsFoot() {
    return `<div class="modal-foot"><button class="ghost" onclick="Depts.close()">Cancel</button><button class="primary" onclick="Depts.save()">Save</button></div>`;
  },

  _renderChips() {
    const host = document.getElementById("deptChips");
    if (!host) return;
    host.innerHTML = this._depts.map(d => `<span class="dept-chip">${esc(d)}<button title="Remove ${attr(d)}" onclick="Depts.removeDept('${attr(d)}')">&times;</button></span>`).join("")
      || `<span class="sub-note">No departments yet — add one below.</span>`;
  },

  // ---- selection / bulk assign -----------------------------------------
  selAll(checked) {
    this._sel = new Set();
    document.querySelectorAll("#deptRows .dept-check").forEach(cb => {
      cb.checked = checked;
      if (checked) this._sel.add(cb.dataset.model);
    });
    this._updateSelCount();
  },

  selOne(cb) {
    if (cb.checked) this._sel.add(cb.dataset.model); else this._sel.delete(cb.dataset.model);
    const all = document.querySelectorAll("#deptRows .dept-check");
    const head = document.getElementById("deptSelAll");
    if (head) head.checked = all.length > 0 && this._sel.size === all.length;
    this._updateSelCount();
  },

  _updateSelCount() {
    const el = document.getElementById("selCount");
    if (el) el.textContent = this._sel.size;
    const btn = document.getElementById("bulkApply");
    if (btn) btn.disabled = this._sel.size === 0;
  },

  applyBulk() {
    if (!this._sel.size) return;
    const dep = document.getElementById("bulkDept").value;
    this._sel.forEach(m => { if (dep) this._draft[m] = dep; else delete this._draft[m]; });
    const n = this._sel.size;
    this._sel = new Set();
    this._render();
    App.toast && App.toast(`${n} model(s) set to ${dep || "Unassigned"} — Save to keep.`);
  },

  addDept() {
    const inp = document.getElementById("deptNew");
    const v = (inp.value || "").trim();
    if (!v) return;
    if (!this._depts.some(d => d.toLowerCase() === v.toLowerCase())) this._depts.push(v);
    inp.value = "";
    this._render();
    const ni = document.getElementById("deptNew"); if (ni) ni.focus();
  },

  removeDept(d) {
    this._depts = this._depts.filter(x => x !== d);
    // unassign any model that pointed at the removed department
    Object.keys(this._draft).forEach(m => { if (this._draft[m] === d) delete this._draft[m]; });
    this._render();
  },

  _pick(sel) {
    const m = sel.dataset.model, v = sel.value;
    if (v) this._draft[m] = v; else delete this._draft[m];
  },

  async save() {
    const data = { departments: this._depts.slice(), map: { ...this._draft } };
    const mapped = Object.keys(data.map).length;
    const r = await Backend.call("hub_save_departments", data,
      { action: "save", target: "Model departments", detail: `${data.departments.length} dept(s), ${mapped} model(s) mapped` });
    if (r && r.ok) {
      this.departments = data.departments; this.map = data.map;
      this.close();
      App.toast ? App.toast("Saved.") : 0;
      try { Dashboard.load(); } catch (e) {}
    } else {
      App.error ? App.error((r && r.error) || "Could not save.") : alert((r && r.error) || "Could not save.");
    }
  },

  // ---- NBT Sites tab ---------------------------------------------------
  _sitesBody() {
    const catSel = sel => `<option value=""${!sel ? " selected" : ""}>Uncategorized</option>` +
      this._sCats.map(c => `<option value="${attr(c)}"${c === sel ? " selected" : ""}>${esc(c)}</option>`).join("");
    const modeSel = m => [["browser", "Web browser (SSO)"], ["fullview", "In-app (full window)"], ["window", "Separate window"], ["embed", "Embedded"]]
      .map(([v, l]) => `<option value="${v}"${(m || "fullview") === v ? " selected" : ""}>${l}</option>`).join("");
    const rows = this._sList.length ? this._sList.map((s, i) => `<tr>
        <td><input class="cfg-in" data-i="${i}" data-k="name" value="${attr(s.name || "")}" placeholder="Name" oninput="Depts._sEdit(this)"></td>
        <td><input class="cfg-in" data-i="${i}" data-k="url" value="${attr(s.url || "")}" placeholder="https://…" oninput="Depts._sEdit(this)"></td>
        <td><select data-i="${i}" data-k="category" onchange="Depts._sEdit(this)">${catSel(s.category)}</select></td>
        <td><select data-i="${i}" data-k="mode" onchange="Depts._sEdit(this)">${modeSel(s.mode)}</select></td>
        <td class="dept-cbcell"><button class="cfg-del" title="Remove site" onclick="Depts._sRemove(${i})">&times;</button></td>
      </tr>`).join("")
      : `<tr><td colspan="5"><div class="empty" style="padding:16px">No sites yet — add one below.</div></td></tr>`;
    return `
      <div class="dept-manage">
        <label>Categories</label>
        <div class="dept-chips" id="catChips"></div>
        <div class="dept-add"><input id="catNew" placeholder="Add a category…" onkeydown="if(event.key==='Enter'){event.preventDefault();Depts.addCat();}"><button class="ghost" onclick="Depts.addCat()">+ Add</button></div>
      </div>
      <table class="dept-table cfg-sites"><thead><tr>
          <th>Name</th><th>URL</th><th>Category</th><th>Opens as</th><th></th></tr></thead>
        <tbody id="siteRows">${rows}</tbody></table>
      <button class="ghost" style="margin-top:12px" onclick="Depts.addSite()">+ Add site</button>
      `;
  },

  _sitesFoot() {
    return `<div class="modal-foot"><button class="ghost" onclick="Depts.close()">Cancel</button><button class="primary" onclick="Depts.saveSites()">Save</button></div>`;
  },

  _renderCatChips() {
    const host = document.getElementById("catChips");
    if (!host) return;
    host.innerHTML = this._sCats.map(c => `<span class="dept-chip">${esc(c)}<button title="Remove ${attr(c)}" onclick="Depts.removeCat('${attr(c)}')">&times;</button></span>`).join("")
      || `<span class="sub-note">No categories yet — add one below.</span>`;
  },

  _sEdit(el) { const i = +el.dataset.i; if (this._sList[i]) this._sList[i][el.dataset.k] = el.value; },
  _sPinEdit(el) { this._sPin = el.value; },
  _sRemove(i) { this._sList.splice(i, 1); this._render(); },
  addSite() {
    this._sList.push({ id: "site-" + Math.random().toString(36).slice(2, 8), name: "", url: "", icon: "🌐", mode: "fullview", category: "" });
    this._render();
    const rows = document.querySelectorAll("#siteRows input.cfg-in[data-k='name']");
    const last = rows[rows.length - 1]; if (last) last.focus();
  },
  addCat() {
    const inp = document.getElementById("catNew");
    const v = (inp.value || "").trim();
    if (!v) return;
    if (!this._sCats.some(c => c.toLowerCase() === v.toLowerCase())) this._sCats.push(v);
    inp.value = "";
    this._render();
    const ni = document.getElementById("catNew"); if (ni) ni.focus();
  },
  removeCat(c) {
    this._sCats = this._sCats.filter(x => x !== c);
    this._sList.forEach(s => { if (s.category === c) s.category = ""; });
    this._render();
  },

  _slug(s) { return (String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24)) || "site"; },

  async saveSites() {
    const sites = this._sList
      .filter(s => (s.name || "").trim() || (s.url || "").trim())
      .map(s => ({
        id: s.id || this._slug(s.name), name: (s.name || "").trim(),
        url: (s.url || "").trim(), icon: s.icon || "🌐",
        mode: s.mode || "fullview", category: (s.category || "").trim(),
      }));
    const bad = sites.find(s => !s.name || !s.url);
    if (bad) { (App.error ? App.error("Every site needs a name and a URL.") : alert("Every site needs a name and a URL.")); return; }
    const pin = (String(this._sPin || "").trim()) || "1700";
    const data = { categories: this._sCats.slice(), sites, pin };
    const r = await Backend.call("hub_save_sites", data,
      { action: "save", target: "NBT Sites", detail: `${sites.length} site(s), ${data.categories.length} categor(ies)` });
    if (r && r.ok) {
      Sites.categories = data.categories; Sites.list = data.sites; Sites.pin = data.pin;
      this.close();
      App.toast && App.toast("Sites saved.");
      try { Sites.home(); } catch (e) {}
    } else {
      App.error ? App.error((r && r.error) || "Could not save.") : alert((r && r.error) || "Could not save.");
    }
  },

  close() {
    if (this._page) { this._enter(this.activeTab); return; }       // page: Cancel/Done = reload the tab's saved state
    document.getElementById("modalRoot").innerHTML = "";
  },
};

/* ---- Endpoint Hub (setup runbooks) --------------------------------------- */
const Hub = {
  config: null,
  _setups: [],
  state: { id: null, type: null, dept: null, checks: {}, notes: {}, subject: "", tech: "", serviceTag: "", createdAt: null, resumed: false },
  who: {},
  get K_DRAFT() { return Divisions.draftKey(); },

  async boot() {
    const cm = document.getElementById("modalConfirm");
    if (cm) cm.onclick = () => { const cb = this._modalCb; this.closeModal(); if (cb) cb(); };
    const mb = document.getElementById("modalBg");
    if (mb) mb.addEventListener("click", e => { if (e.target === mb) this.closeModal(); });

    const w = await Backend.call("hub_whoami");
    if (w && w.ok) { this.who = w; }
    await this.loadConfig();
    this.renderActivity();
  },

  /* A config object is usable only if it has the three parts the app reads. */
  validCfg(c) { return !!(c && c.user && c.computerBase && c.departments); },

  /* The division's checklists. A division with none yet starts from the platform TEMPLATE (Platform > Template
     checklists), else from the built-in defaults, and saves that as its own copy. */
  async loadConfig() {
    this.templateMode = false;
    const r = await Backend.call("hub_get_config");
    if (r && r.ok && this.validCfg(r.config)) { this.config = r.config; return; }
    const fromTemplate = r && r.ok && this.validCfg(r.seed);
    this.config = fromTemplate ? this.clone(r.seed) : this.makeDefaults();
    Backend.call("hub_save_config", this.config, { action: "seed", target: "(entire config)", detail: fromTemplate ? "from the template checklists" : "defaults" });
  },

  /* Starting point for "Reset": the template if a super admin has made one, else the built-in defaults. */
  async startingPoint() {
    const t = await Backend.call("hub_get_template_config");
    return (t && t.ok && this.validCfg(t.config)) ? this.clone(t.config) : this.makeDefaults();
  },

  persistConfig(meta) {
    return Backend.call(this.templateMode ? "hub_save_template_config" : "hub_save_config", this.config, meta);
  },

  /* Super admins edit the TEMPLATE with the same checklist editor (Settings > Platform > Template checklists). */
  async editTemplate() {
    this.templateMode = true;
    this.config = await this.startingPoint();
    document.getElementById("tplBanner").classList.remove("hidden");
    Nav.go("hub");
    this.go("admin");
  },
  async exitTemplate() {
    document.getElementById("tplBanner").classList.add("hidden");
    await this.loadConfig();
    this.go("home");
    Settings.open("template");
  },

  go(v) {
    document.querySelectorAll(".hubview").forEach(el => el.classList.remove("active"));
    const el = document.getElementById("hubview-" + v);
    if (el) el.classList.add("active");
    if (v === "home") this.renderActivity();
    if (v === "admin") { this.buildAdminSelect(); this.loadAdmin(); }
  },

  genId(t) { return (t || "setup") + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7); },
  itemKey(si, ii) { return si + "_" + ii; },

  currentSections() {
    if (this.state.type === "user") return this.config.user.sections;
    let secs = this.config.computerBase.sections.slice();
    if (this.state.dept && this.config.departments[this.state.dept]) secs = secs.concat(this.config.departments[this.state.dept].sections);
    return secs;
  },

  startUser() { if (!this.config) return App.toast("Still loading…"); this.newState("user", null); this.go("run"); this.renderRun(); },
  startComputer() { if (!this.config) return App.toast("Still loading…"); this.buildDeptGrid(); this.go("dept"); },
  pickDept(d) {
    const p = this._pendingUpgrade; this._pendingUpgrade = null;
    if (p) {
      // starting a computer setup FOR an upgrade-list device: fresh state, pre-filled
      // hostname + primary user, then link it back to the upgrade entry.
      this.state = { id: this.genId("computer"), type: "computer", dept: d, checks: {}, notes: {},
        subject: p.subject || "", primaryUser: p.user || "", tech: "", serviceTag: "",
        reservedSerial: "", reservedModel: "", reservedSite: "", reservedDept: "",
        createdAt: new Date().toISOString(), resumed: false, saved: false };
      this.go("run"); this.renderRun();
      const si = document.getElementById("subjectInput"); if (si) si.value = this.state.subject;
      const pu = document.getElementById("primaryUserInput"); if (pu) pu.value = this.state.primaryUser;
      this._linkUpgrade(p.id);
    } else {
      this.newState("computer", d); this.go("run"); this.renderRun();
    }
  },
  // Begin Upgrade entry point (called from the Upgrades list): choose a department,
  // then start the linked computer setup.
  beginForUpgrade(item) {
    if (!this.config) return App.toast("Still loading — try again in a moment.", true);
    this._pendingUpgrade = { id: item.id, subject: item.device_name || item.serial || "", user: item.user || "" };
    this.startComputer();
    App.toast("Pick a department to start the upgrade setup for " + (item.device_name || item.serial) + ".");
  },
  async _linkUpgrade(upId) {
    await this._pushShared();   // register the setup (id + subject) in the shared folder
    try { await Backend.call("hub_begin_upgrade", upId, this.state.id); } catch (e) {}
    App.toast("Upgrade started — linked to this setup. Progress shows on the Upgrades list.");
  },
  buildDeptGrid() {
    const host = document.getElementById("deptGrid"); host.innerHTML = "";
    const base = document.createElement("button"); base.className = "dept-card";
    base.innerHTML = `<div class="dn">Base build only</div><div class="dd">No department software</div>`;
    base.onclick = () => this.pickDept(null); host.appendChild(base);
    Object.keys(this.config.departments).forEach(n => {
      const b = document.createElement("button"); b.className = "dept-card";
      let count = 0; this.config.departments[n].sections.forEach(s => count += s.items.length);
      b.innerHTML = `<div class="dn">${esc(n)}</div><div class="dd">${count} added steps</div>`;
      b.onclick = () => this.pickDept(n); host.appendChild(b);
    });
  },

  newState(type, dept) {
    let draft = null;
    try { const r = localStorage.getItem(this.K_DRAFT); if (r) draft = JSON.parse(r); } catch (e) {}
    if (draft && draft.type === type && (draft.dept || null) === (dept || null) && !draft.saved && draft.id) {
      this.state = draft; this.state.resumed = false;
    } else {
      this.state = { id: this.genId(type), type, dept, checks: {}, notes: {}, subject: "", primaryUser: "", setupNotes: "", tech: "", serviceTag: "", reservedSerial: "", reservedModel: "", reservedSite: "", reservedDept: "", createdAt: new Date().toISOString(), resumed: false };
    }
  },

  resumeSetup(id) {
    const e = (this._setups || []).filter(s => s.id === id)[0];
    if (!e) return App.toast("Entry not found — refresh.", true);
    this.state = { id: e.id, type: e.type, dept: e.dept || null, checks: e.checks || {}, notes: e.notes || {},
      subject: e.subject || "", primaryUser: e.primaryUser || "", setupNotes: e.setupNotes || "", tech: e.tech || "", serviceTag: e.serviceTag || "",
      reservedSerial: e.reservedSerial || "", reservedModel: e.reservedModel || "", reservedSite: e.reservedSite || "", reservedDept: e.reservedDept || "",
      createdAt: e.createdAt || new Date().toISOString(), resumed: true, saved: true };
    this.go("run"); this.renderRun(); App.toast("Resumed — continue where it was left off.");
  },

  renderRun() {
    const s = this.state, isUser = s.type === "user";
    const badge = document.getElementById("runBadge");
    badge.textContent = isUser ? "User setup" : "Computer setup";
    badge.className = "hbadge " + (isUser ? "user" : "computer");
    const db = document.getElementById("runDeptBadge");
    if (!isUser && s.dept) { db.style.display = ""; db.textContent = s.dept; } else db.style.display = "none";
    document.getElementById("runResumed").style.display = s.resumed ? "" : "none";
    document.getElementById("runTitle").textContent = isUser ? "New user setup" : ("New computer setup" + (s.dept ? " · " + s.dept : ""));
    document.getElementById("nameLabel").textContent = isUser ? (this.config.user.subjectLabel || "Teammate name") : "Computer hostname";
    const subj = document.getElementById("subjectInput");
    subj.placeholder = isUser ? (this.config.user.subjectPlaceholder || "e.g. Smith, Jane") : "e.g. " + Divisions.label() + "-XXXXXX";
    subj.value = s.subject || ""; subj.classList.remove("req-missing");
    // Primary user (required for a computer setup, optional for a user setup)
    const pu = document.getElementById("primaryUserInput");
    if (pu) { pu.value = s.primaryUser || ""; pu.classList.remove("req-missing"); }
    const puLbl = document.getElementById("primaryUserLabel");
    if (puLbl) puLbl.textContent = isUser ? "Primary user" : "Primary user (required)";
    document.getElementById("techInput").value = s.tech || (this.who && this.who.user) || "";
    document.getElementById("dateInput").value = new Date().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    document.getElementById("serviceTagField").style.display = isUser ? "none" : "";
    document.getElementById("serviceTagInput").value = s.serviceTag || "";
    const nt = document.getElementById("setupNotesInput"); if (nt) nt.value = s.setupNotes || "";
    document.getElementById("saveBanner").classList.remove("show");
    this.updateFolderStatus();
    this.loadReservation();

    const host = document.getElementById("sectionsHost"); host.innerHTML = "";
    this.currentSections().forEach((sec, si) => {
      const card = document.createElement("div"); card.className = "section";
      const done = sec.items.filter((_, ii) => s.checks[this.itemKey(si, ii)]).length;
      const head = document.createElement("div"); head.className = "section-head";
      head.innerHTML = `<span class="st">${esc(sec.title)}</span><span class="count" id="cnt_${si}">${done} / ${sec.items.length}</span>`;
      card.appendChild(head);
      if (sec.note) { const n = document.createElement("p"); n.className = "section-note"; n.textContent = sec.note; card.appendChild(n); }
      const ul = document.createElement("ul"); ul.className = "items";
      sec.items.forEach((it, ii) => {
        const key = this.itemKey(si, ii), cid = "cb_" + key, noteVal = s.notes[key] || "";
        const li = document.createElement("li"); li.className = "item" + (s.checks[key] ? " checked" : "");
        li.innerHTML = `<input type="checkbox" class="cb" id="${cid}" ${s.checks[key] ? "checked" : ""}>
          <div class="body"><label class="itxt" for="${cid}">${esc(it.text)}</label>
          ${it.detail ? `<div class="idetail">${this.fmtDetail(it.detail)}</div>` : ""}
          <button class="notebtn" type="button">${noteVal ? "✎ Edit note" : "+ Add note"}</button>
          <div class="note-in${noteVal ? " open" : ""}"><textarea placeholder="Run notes (optional)">${esc(noteVal)}</textarea></div></div>`;
        const cb = li.querySelector(".cb");
        cb.addEventListener("change", () => this.toggleCheck(key, cb.checked, li, si));
        const nb = li.querySelector(".notebtn"), box = li.querySelector(".note-in"), ta = li.querySelector("textarea");
        nb.addEventListener("click", () => { box.classList.toggle("open"); if (box.classList.contains("open")) ta.focus(); });
        ta.addEventListener("input", () => { s.notes[key] = ta.value; nb.textContent = ta.value ? "✎ Edit note" : "+ Add note"; this.autosave(); });
        ul.appendChild(li);
      });
      card.appendChild(ul); host.appendChild(card);
    });
    this.updateProgress();
  },
  toggleCheck(key, val, li, si) {
    this.state.checks[key] = val; li.classList.toggle("checked", val);
    const secs = this.currentSections(); let done = 0;
    secs[si].items.forEach((_, ii) => { if (this.state.checks[this.itemKey(si, ii)]) done++; });
    document.getElementById("cnt_" + si).textContent = done + " / " + secs[si].items.length;
    this.updateProgress(); this.autosave();
  },
  tally() {
    let total = 0, done = 0;
    this.currentSections().forEach((sec, si) => sec.items.forEach((_, ii) => { total++; if (this.state.checks[this.itemKey(si, ii)]) done++; }));
    return { done, total, pct: total ? Math.round(done / total * 100) : 0 };
  },
  updateProgress() {
    const t = this.tally();
    document.getElementById("progFill").style.width = t.pct + "%";
    document.getElementById("progText").textContent = t.done + " / " + t.total + "  ·  " + t.pct + "%";
  },
  onSubject() { this.state.subject = document.getElementById("subjectInput").value; document.getElementById("subjectInput").classList.remove("req-missing"); this.autosave(); },
  onPrimaryUser() { const el = document.getElementById("primaryUserInput"); this.state.primaryUser = el.value; el.classList.remove("req-missing"); this.autosave(); },

  // ---- reserve a stock computer for this setup -------------------------------
  // Picking a device holds it against this setup so it drops off the dashboard's
  // "In Stock By Department" tile until the setup completes or is cancelled.
  _reserveFields() {
    if (this.state.type !== "computer") return {};
    return { reservedSerial: this.state.reservedSerial || "", reservedModel: this.state.reservedModel || "",
             reservedSite: this.state.reservedSite || "", reservedDept: this.state.reservedDept || "" };
  },
  async loadReservation() {
    const block = document.getElementById("reserveBlock");
    if (!block) return;
    if (this.state.type !== "computer") { block.style.display = "none"; return; }
    block.style.display = "";
    const deptSel = document.getElementById("reserveDept"), devSel = document.getElementById("reserveDevice");
    deptSel.innerHTML = `<option value="">Loading stock…</option>`;
    devSel.innerHTML = `<option value="">—</option>`;
    let r;
    try { r = await Backend.call("reservation_options", this.state.id); } catch (e) { r = null; }
    if (!r || !r.ok) {
      deptSel.innerHTML = `<option value="">${esc((r && r.error) || "Stock unavailable")}</option>`;
      devSel.innerHTML = `<option value="">—</option>`;
      this._renderReserveStatus();   // still show any reservation already on the record
      return;
    }
    this._reserveData = r.by_dept || {};
    const depts = Object.keys(this._reserveData).sort();
    // If a device is already reserved but we don't know its dept, find it.
    if (this.state.reservedSerial && !this.state.reservedDept) {
      for (const d of depts) if ((this._reserveData[d] || []).some(x => x.serial === this.state.reservedSerial)) { this.state.reservedDept = d; break; }
    }
    deptSel.innerHTML = `<option value="">Choose a department…</option>` +
      depts.map(d => `<option value="${attr(d)}"${d === this.state.reservedDept ? " selected" : ""}>${esc(d)} (${this._reserveData[d].length})</option>`).join("");
    this._fillReserveDevices();
    this._renderReserveStatus();
  },
  _fillReserveDevices() {
    const devSel = document.getElementById("reserveDevice");
    const dept = document.getElementById("reserveDept").value;
    const list = (this._reserveData && this._reserveData[dept]) || [];
    devSel.innerHTML = `<option value="">— none (don't reserve) —</option>` +
      list.map(x => `<option value="${attr(x.serial)}" data-model="${attr(x.model || "")}" data-site="${attr(x.site || "")}"${x.serial === this.state.reservedSerial ? " selected" : ""}>${esc(x.serial)} · ${esc(x.model || "?")}${x.site ? " · " + esc(x.site) : ""}</option>`).join("");
  },
  onReserveDept() { this._fillReserveDevices(); },
  onReserveDevice() {
    const devSel = document.getElementById("reserveDevice"), serial = devSel.value;
    if (!serial) { this._clearReservation(); }
    else {
      const opt = devSel.selectedOptions[0];
      this.state.reservedSerial = serial;
      this.state.reservedModel = opt.getAttribute("data-model") || "";
      this.state.reservedSite = opt.getAttribute("data-site") || "";
      this.state.reservedDept = document.getElementById("reserveDept").value || "";
    }
    this._renderReserveStatus();
    this.autosave();
    this._pushShared();   // reflect on the dashboard tile promptly (no-op if no hostname yet)
  },
  releaseReservation() {
    this._clearReservation();
    const d = document.getElementById("reserveDevice"); if (d) d.value = "";
    this._renderReserveStatus();
    this.autosave();
    this._pushShared();
  },
  _clearReservation() { this.state.reservedSerial = ""; this.state.reservedModel = ""; this.state.reservedSite = ""; this.state.reservedDept = ""; },
  _renderReserveStatus() {
    const el = document.getElementById("reserveStatus"); if (!el) return;
    if (this.state.reservedSerial) {
      el.innerHTML = `🔒 Reserved <b>${esc(this.state.reservedSerial)}</b>${this.state.reservedModel ? " · " + esc(this.state.reservedModel) : ""}${this.state.reservedSite ? " · " + esc(this.state.reservedSite) : ""} — held out of <b>In Stock${this.state.reservedDept ? " · " + esc(this.state.reservedDept) : ""}</b> while this setup is open. <a href="#" onclick="Hub.releaseReservation();return false;">Release</a>${this.state.subject ? "" : " <span class='muted'>(enter a hostname above to save it)</span>"}`;
    } else {
      el.innerHTML = `No computer reserved. Pick a department + device to hold one from stock — it drops off the In Stock by Department tile until you finish or cancel.`;
    }
  },
  checkAll() {
    const secs = this.currentSections();
    secs.forEach((sec, si) => sec.items.forEach((_, ii) => { this.state.checks[this.itemKey(si, ii)] = true; }));
    this.renderRun(); this.autosave();
    App.toast("All items checked.");
  },
  autosave() {
    this.state.tech = document.getElementById("techInput").value;
    const pu = document.getElementById("primaryUserInput"); if (pu) this.state.primaryUser = pu.value;
    const nt = document.getElementById("setupNotesInput"); if (nt) this.state.setupNotes = nt.value;
    const st = document.getElementById("serviceTagInput"); this.state.serviceTag = st ? st.value : "";
    this.state.saved = false;
    try { localStorage.setItem(this.K_DRAFT, JSON.stringify(this.state)); } catch (e) {}
    this._scheduleShared();   // also push to the shared folder so others see in-progress work
  },
  // debounced write of the in-progress setup to the shared library (JSON only, no
  // HTML record) so teammates see it before it's finished. Fires ~8s after edits stop.
  _scheduleShared() {
    clearTimeout(this._sharedT);
    this._sharedT = setTimeout(() => this._pushShared(), 8000);
  },
  async _pushShared() {
    const subjEl = document.getElementById("subjectInput");
    const subj = (subjEl ? subjEl.value : this.state.subject || "").trim();
    if (!subj || !this.state.id) return;   // don't create blank shared records
    const t = this.tally();
    const status = (t.total > 0 && t.done >= t.total) ? "complete" : "in-progress";
    const entry = { id: this.state.id, type: this.state.type, dept: this.state.dept, subject: subj,
      primaryUser: (this.state.primaryUser || ""), setupNotes: (this.state.setupNotes || ""),
      tech: (this.state.tech || ""), serviceTag: this.state.serviceTag, checks: this.state.checks,
      notes: this.state.notes, done: t.done, total: t.total, pct: t.pct, status,
      ...this._reserveFields(),
      createdAt: this.state.createdAt || new Date().toISOString() };
    try { await Backend.call("hub_save_setup", entry, "", ""); } catch (e) {}
  },
  resetChecks() { this.state.checks = {}; this.state.notes = {}; this.renderRun(); App.toast("Checks cleared."); },
  openFolder() {
    Backend.call("hub_open_folder").then(r => { if (r && r.ok === false) App.toast(r.error || "Could not open it.", true); });
  },
  updateFolderStatus() {
    const el = document.getElementById("folderStatus"); if (!el) return;
    const p = (this.who && this.who.logsPath) || "the Systems shared folder";
    el.innerHTML = `Setups, records, and program changes save to <b>${esc(p)}</b> (OneDrive-synced Systems library). Everyone shares this log.`;
  },

  async save() {
    const subj = document.getElementById("subjectInput").value.trim();
    if (!subj) { const i = document.getElementById("subjectInput"); i.classList.add("req-missing"); i.focus();
      return App.toast(this.state.type === "user" ? "Enter the teammate name first." : "Enter the hostname first.", true); }
    const pu = (document.getElementById("primaryUserInput").value || "").trim();
    if (this.state.type === "computer" && !pu) {
      const i = document.getElementById("primaryUserInput"); i.classList.add("req-missing"); i.focus();
      return App.toast("Enter the primary user's name first.", true);
    }
    this.state.subject = subj; this.state.primaryUser = pu;
    const nt = document.getElementById("setupNotesInput"); this.state.setupNotes = nt ? nt.value.trim() : (this.state.setupNotes || "");
    this.state.tech = document.getElementById("techInput").value.trim();
    const t = this.tally();
    const status = (t.total > 0 && t.done >= t.total) ? "complete" : "in-progress";
    const built = this.buildRecordHtml(subj, this.currentSections(), t.done, t.total);
    const entry = { id: this.state.id, type: this.state.type, dept: this.state.dept, subject: subj,
      primaryUser: pu, setupNotes: this.state.setupNotes, tech: this.state.tech, serviceTag: this.state.serviceTag, checks: this.state.checks, notes: this.state.notes,
      done: t.done, total: t.total, pct: t.pct, status, ...this._reserveFields(), createdAt: this.state.createdAt || new Date().toISOString() };
    const res = await Backend.call("hub_save_setup", entry, built.html, built.fname);
    if (!res || !res.ok) return App.toast("Save failed — is the shared folder available?", true);
    this.state.saved = true; try { localStorage.setItem(this.K_DRAFT, JSON.stringify(this.state)); } catch (e) {}
    const b = document.getElementById("saveBanner");
    b.innerHTML = status === "complete"
      ? `Saved <b>${esc(subj)}</b> as <b>complete</b> (100%) to the shared library.`
      : `Saved <b>${esc(subj)}</b> at <b>${t.pct}%</b>. Anyone can resume it from Home.`;
    b.classList.add("show");
    App.toast(status === "complete" ? "Saved · complete" : "Saved · " + t.pct + "% (resumable)");
    window.scrollTo(0, 0);
  },

  buildRecordHtml(subj, secs, done, total) {
    const s = this.state, isUser = s.type === "user", d = new Date();
    const safe = subj.replace(/[^\w .\-]/g, "_");
    const idtail = (s.id || "").split("-").slice(-2).join("-");
    const fname = (isUser ? "User Setup" : "Computer Setup") + " - " + safe + " - " + idtail + ".html";
    const pct = total ? Math.round(done / total * 100) : 0;
    let rows = "";
    secs.forEach((sec, si) => {
      rows += `<tr class="sec"><td colspan="2">${esc(sec.title)}</td></tr>`;
      sec.items.forEach((it, ii) => {
        const key = this.itemKey(si, ii), ok = s.checks[key];
        const note = s.notes[key] ? `<div class="rn">${esc(s.notes[key])}</div>` : "";
        const det = it.detail ? `<div class="rd">${esc(it.detail)}</div>` : "";
        rows += `<tr><td class="mark ${ok ? "y" : "n"}">${ok ? "✔" : "✕"}</td><td>${esc(it.text)}${det}${note}</td></tr>`;
      });
    });
    const statusTxt = (total > 0 && done >= total) ? "Complete" : ("In progress — " + pct + "%");
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(fname)}</title>
      <style>body{font-family:Arial,sans-serif;color:#1b211e;max-width:780px;margin:30px auto;padding:0 20px}
      h1{color:#213B34;font-size:22px;margin:0 0 4px}.sub{color:#5c6b64;font-size:13px;margin-bottom:18px}
      .hd{background:#D9E8E2;border-radius:10px;padding:14px 16px;margin-bottom:18px;font-size:14px}
      .hd b{display:inline-block;min-width:130px;color:#213B34}table{width:100%;border-collapse:collapse;font-size:13.5px}
      td{padding:8px 10px;border-bottom:1px solid #eee;vertical-align:top}
      tr.sec td{background:#f2f5f2;font-weight:700;color:#213B34;border-top:2px solid #A1CEAD}
      .mark{width:26px;text-align:center;font-weight:700}.mark.y{color:#006325}.mark.n{color:#b3261e}
      .rd{color:#5c6b64;font-size:12px;margin-top:2px}.rn{color:#8a6d1e;font-size:12px;margin-top:3px;font-style:italic}
      .ft{margin-top:20px;color:#5c6b64;font-size:12px}</style></head><body>
      <h1>NUCOR ${esc(Divisions.label())} · ${isUser ? "New User Setup" : "New Computer Setup"}</h1>
      <div class="sub">${esc(Divisions.label())} Systems setup record</div>
      <div class="hd"><div><b>${isUser ? "Teammate:" : "Hostname:"}</b> ${esc(subj)}</div>
      <div><b>Primary user:</b> ${esc(s.primaryUser || "—")}</div>
      ${s.dept ? `<div><b>Department:</b> ${esc(s.dept)}</div>` : ""}
      <div><b>Technician:</b> ${esc(s.tech || "—")}</div>
      ${s.serviceTag ? `<div><b>Service tag / Asset #:</b> ${esc(s.serviceTag)}</div>` : ""}
      <div><b>Date:</b> ${Tz.dt(d)}</div><div><b>Status:</b> ${statusTxt}</div>
      <div><b>Completion:</b> ${done} of ${total} (${pct}%)</div>
      ${s.setupNotes ? `<div><b>Notes:</b> ${esc(s.setupNotes)}</div>` : ""}</div>
      <table>${rows}</table><div class="ft">Generated by NBG Hub</div></body></html>`;
    return { html, fname };
  },

  renderActivity() {
    const host = document.getElementById("activityList");
    Backend.call("hub_get_setups").then(r => {
      this._setups = (r && r.ok && r.setups) ? r.setups : [];
      document.getElementById("setupCount").textContent = this._setups.length;
      if (!this._setups.length) { host.innerHTML = `<div class="empty">No setups yet. Start one above — it saves to the shared library so anyone can resume it.</div>`; return; }
      host.innerHTML = "";
      this._setups.slice(0, 20).forEach(l => {
        const when = l.updatedAt || l.createdAt;
        const whenTxt = when ? Tz.date(when, { month: "short", day: "numeric" }) + " " + Tz.time(when) : "";
        const pct = typeof l.pct === "number" ? l.pct : (l.total ? Math.round(l.done / l.total * 100) : 0);
        const done = l.status === "complete";
        const row = document.createElement("div"); row.className = "h-row";
        row.innerHTML = `<span class="htag ${l.type === "user" ? "user" : "computer"}">${l.type === "user" ? "User" : "Computer"}</span>
          <span class="who">${esc(l.subject || "(unnamed)")}</span>
          ${l.primaryUser ? `<span class="m2">· ${esc(l.primaryUser)}</span>` : ""}
          ${l.dept ? `<span class="m2">· ${esc(l.dept)}</span>` : ""}
          <span class="grow"></span>
          <span class="minibar"><span style="width:${pct}%"></span></span>
          <span class="m2">${l.done || 0}/${l.total || 0} (${pct}%)</span>
          <span class="status ${done ? "done" : "prog"}">${done ? "Complete" : "In progress"}</span>
          <span class="when">${whenTxt}${l.updatedBy ? " · " + esc(l.updatedBy) : ""}</span>`;
        const btn = document.createElement("button"); btn.className = "rowbtn"; btn.textContent = done ? "Open" : "Resume";
        btn.onclick = () => this.resumeSetup(l.id); row.appendChild(btn);
        host.appendChild(row);
      });
    });
    const chost = document.getElementById("changesList");
    Backend.call("hub_get_changes").then(r => {
      const changes = (r && r.ok && r.changes) ? r.changes : [];
      document.getElementById("changeCount").textContent = changes.length;
      if (!changes.length) { chost.innerHTML = `<div class="empty">No checklist changes recorded yet.</div>`; return; }
      chost.innerHTML = "";
      changes.slice(0, 8).forEach(c => {
        const when = c.when ? Tz.date(c.when, { month: "short", day: "numeric" }) + " " + Tz.time(c.when) : "";
        const row = document.createElement("div"); row.className = "change-row";
        row.innerHTML = `<span class="act">${esc(c.action || "change")}</span>
          <span>${esc(c.target || "")}${c.detail ? " — " + esc(c.detail) : ""}</span>
          <span class="cwho">${esc(c.user || "")} · ${when}</span>`;
        chost.appendChild(row);
      });
    });
  },

  /* ---- feedback ---- */


  /* ---- exit guard + modal ---- */
  _modalCb: null,
  confirmExit() {
    const any = Object.keys(this.state.checks).some(k => this.state.checks[k]);
    if (any && !this.state.saved) this.openModal("Leave without saving?", "You have checked items not yet saved to the shared log. Save first so others can resume, or leave (this machine keeps a local draft).", () => this.go("home"));
    else this.go("home");
  },
  // Cancel an in-progress setup with a required reason; deletes the shared record,
  // logs it, and reverts any linked upgrade back to queued.
  cancelSetup() {
    const s = this.state || {};
    const label = s.type === "user" ? "user setup" : "computer setup";
    const si = document.getElementById("subjectInput");
    const subj = (si && si.value.trim()) || s.subject || "(unnamed)";
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal" style="width:480px;max-width:94vw;">
        <div class="modal-head"><h3>Cancel ${esc(label)}?</h3><button onclick="Hub._closeCancel()">&times;</button></div>
        <div class="modal-body">
          <p class="sub-note" style="margin:0 0 12px">This removes the ${esc(label)} for <b>${esc(subj)}</b> from the shared log and records why. This can't be undone.</p>
          <label class="up-lbl">Reason <span class="muted">(required)</span></label>
          <textarea id="cancelReason" class="up-notes" rows="4" placeholder="Why is this setup being cancelled? (e.g. wrong device, user left, hardware DOA)"></textarea>
          <div class="up-actions">
            <button class="ghost" onclick="Hub._closeCancel()">Keep working</button>
            <button class="primary" style="background:var(--red)" onclick="Hub._doCancel()">Cancel setup</button>
          </div>
        </div>
      </div></div>`;
    setTimeout(() => { const t = document.getElementById("cancelReason"); if (t) t.focus(); }, 30);
  },
  _closeCancel() { document.getElementById("modalRoot").innerHTML = ""; },
  async _doCancel() {
    const ta = document.getElementById("cancelReason");
    const reason = (ta ? ta.value : "").trim();
    if (!reason) { if (ta) ta.classList.add("req-missing"); return App.toast("Enter a reason to cancel.", true); }
    const id = this.state.id;
    clearTimeout(this._sharedT);   // stop the debounced autosave from re-creating the record
    const r = await Backend.call("hub_cancel_setup", id, reason);
    this._closeCancel();
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not cancel the setup.", true);
    try { localStorage.removeItem(this.K_DRAFT); } catch (e) {}
    this.state = { checks: {} };
    this.go("home");
    this.renderActivity();
    App.toast("Setup cancelled and logged" + (r.reverted ? " — upgrade returned to the queue." : "."));
  },
  openModal(title, msg, cb) { document.getElementById("modalTitle").textContent = title; document.getElementById("modalMsg").textContent = msg; this._modalCb = cb; document.getElementById("modalBg").classList.add("show"); },
  closeModal() { document.getElementById("modalBg").classList.remove("show"); this._modalCb = null; },

  /* ---- admin editor ---- */
  adminList: [], adminTarget: null,
  adminLabel() { const s = document.getElementById("adminSelect"); return s && s.options[s.selectedIndex] ? s.options[s.selectedIndex].text : ""; },
  adminSummary() { let items = 0; this.adminList.forEach(s => items += s.items.length); return this.adminList.length + " section" + (this.adminList.length === 1 ? "" : "s") + ", " + items + " item" + (items === 1 ? "" : "s"); },
  buildAdminSelect() {
    const sel = document.getElementById("adminSelect"), cur = sel.value; sel.innerHTML = "";
    const add = (v, t) => { const o = document.createElement("option"); o.value = v; o.textContent = t; sel.appendChild(o); };
    add("user", "User setup"); add("base", "Computer — base build");
    Object.keys(this.config.departments).forEach(n => add("dept:" + n, "Computer — " + n));
    if (cur) sel.value = cur;
  },
  readTarget() {
    const v = document.getElementById("adminSelect").value || "user";
    if (v === "user") { this.adminTarget = { kind: "user" }; this.adminList = this.clone(this.config.user.sections); }
    else if (v === "base") { this.adminTarget = { kind: "base" }; this.adminList = this.clone(this.config.computerBase.sections); }
    else { const n = v.slice(5); this.adminTarget = { kind: "dept", dept: n }; this.adminList = this.clone(this.config.departments[n].sections); }
  },
  loadAdmin() { this.readTarget(); this.renderAdmin(); },
  renderAdmin() {
    const host = document.getElementById("adminHost"); host.innerHTML = "";
    this.adminList.forEach((sec, si) => {
      const card = document.createElement("div"); card.className = "a-section";
      const head = document.createElement("div"); head.className = "a-section-head";
      const ti = document.createElement("input"); ti.className = "stitle"; ti.value = sec.title || ""; ti.placeholder = "Section title";
      ti.addEventListener("input", e => this.adminList[si].title = e.target.value); head.appendChild(ti);
      const ds = document.createElement("button"); ds.className = "iconbtn del"; ds.title = "Delete section"; ds.textContent = "🗑";
      ds.onclick = () => this.openModal("Delete section?", `"${sec.title || "this section"}" and its items will be removed.`, () => { this.adminList.splice(si, 1); this.renderAdmin(); });
      head.appendChild(ds); card.appendChild(head);
      const ul = document.createElement("ul"); ul.className = "a-items"; ul.dataset.si = si;
      sec.items.forEach((it, ii) => ul.appendChild(this.adminItemRow(si, ii, it))); card.appendChild(ul);
      const add = document.createElement("button"); add.className = "a-add"; add.textContent = "+ Add item";
      add.onclick = () => { this.adminList[si].items.push({ text: "", detail: "" }); this.renderAdmin(); }; card.appendChild(add);
      host.appendChild(card);
    });
  },
  adminItemRow(si, ii, it) {
    const li = document.createElement("li"); li.className = "a-item"; li.draggable = true; li.dataset.si = si; li.dataset.ii = ii;
    const handle = document.createElement("span"); handle.className = "handle"; handle.textContent = "☰";
    const ins = document.createElement("div"); ins.className = "ins";
    const txt = document.createElement("input"); txt.className = "txt"; txt.value = it.text || ""; txt.placeholder = "Checklist item";
    const det = document.createElement("input"); det.className = "det"; det.value = it.detail || ""; det.placeholder = "Detail / path / note (optional)";
    ins.appendChild(txt); ins.appendChild(det);
    const ctrls = document.createElement("div"); ctrls.className = "ctrls";
    const up = document.createElement("button"); up.className = "iconbtn"; up.textContent = "↑";
    const dn = document.createElement("button"); dn.className = "iconbtn"; dn.textContent = "↓";
    const del = document.createElement("button"); del.className = "iconbtn del"; del.textContent = "✕";
    ctrls.appendChild(up); ctrls.appendChild(dn); ctrls.appendChild(del);
    li.appendChild(handle); li.appendChild(ins); li.appendChild(ctrls);
    txt.addEventListener("input", e => this.adminList[si].items[ii].text = e.target.value);
    det.addEventListener("input", e => this.adminList[si].items[ii].detail = e.target.value);
    up.onclick = () => this.moveItem(si, ii, -1); dn.onclick = () => this.moveItem(si, ii, 1);
    del.onclick = () => { this.adminList[si].items.splice(ii, 1); this.renderAdmin(); };
    li.addEventListener("dragstart", e => { li.classList.add("dragging"); e.dataTransfer.setData("text/plain", si + ":" + ii); });
    li.addEventListener("dragend", () => { li.classList.remove("dragging"); document.querySelectorAll(".a-item.dragover").forEach(x => x.classList.remove("dragover")); });
    li.addEventListener("dragover", e => { e.preventDefault(); li.classList.add("dragover"); });
    li.addEventListener("dragleave", () => li.classList.remove("dragover"));
    li.addEventListener("drop", e => {
      e.preventDefault(); li.classList.remove("dragover");
      const from = e.dataTransfer.getData("text/plain").split(":");
      let fsi = +from[0], fii = +from[1], tsi = +li.dataset.si, tii = +li.dataset.ii;
      if (fsi === tsi && fii === tii) return;
      const moved = this.adminList[fsi].items.splice(fii, 1)[0];
      if (fsi === tsi && fii < tii) tii--;
      this.adminList[tsi].items.splice(tii, 0, moved); this.renderAdmin();
    });
    return li;
  },
  moveItem(si, ii, dir) { const arr = this.adminList[si].items, ni = ii + dir; if (ni < 0 || ni >= arr.length) return; const t = arr[ii]; arr[ii] = arr[ni]; arr[ni] = t; this.renderAdmin(); },
  addSection() { this.adminList.push({ title: "New section", note: "", items: [{ text: "", detail: "" }] }); this.renderAdmin(); },
  saveAdmin() {
    this.adminList.forEach(s => s.items = s.items.filter(x => (x.text || "").trim() !== ""));
    const label = this.adminLabel(), summary = this.adminSummary();
    if (this.adminTarget.kind === "user") this.config.user.sections = this.adminList;
    else if (this.adminTarget.kind === "base") this.config.computerBase.sections = this.adminList;
    else this.config.departments[this.adminTarget.dept].sections = this.adminList;
    this.persistConfig({ action: "save", target: label, detail: summary }).then(r => {
      if (r && r.ok === false) App.toast(r.error || "Could not save.", true);
    });
    App.toast(this.templateMode ? "Template checklist saved." : "Checklist saved & logged."); this.renderAdmin();
  },
  resetOne() {
    this.openModal("Reset to default?", this.templateMode ? "This restores the built-in items for this template checklist and discards your edits."
      : "This restores this checklist to the platform template and discards your edits.", async () => {
      const d = this.templateMode ? this.makeDefaults() : await this.startingPoint(), label = this.adminLabel();
      if (this.adminTarget.kind === "user") this.config.user = d.user;
      else if (this.adminTarget.kind === "base") this.config.computerBase = d.computerBase;
      else if (this.config.departments[this.adminTarget.dept]) this.config.departments[this.adminTarget.dept] = d.departments[this.adminTarget.dept] || this.config.departments[this.adminTarget.dept];
      this.persistConfig({ action: "reset", target: label, detail: this.templateMode ? "restored built-in defaults" : "restored the template" });
      this.loadAdmin(); App.toast("Reset & logged.");
    });
  },

  /* ---- helpers ---- */
  fmtDetail(sv) { return esc(sv).replace(/(\\\\[^\s,]+|[A-Za-z]:\\[^\s,]+|%[^%]+%|\d{1,5}@[^\s,]+|IP\s[\d.]+)/g, "<code>$1</code>"); },
  clone(o) { return JSON.parse(JSON.stringify(o)); },

  makeDefaults() { return {
    user: { label: "New User Setup", subjectLabel: "Teammate name", subjectPlaceholder: "e.g. Smith, Jane", sections: [
      { title: "Account type & branding", note: "Unbranded (@nucor.com): Finance, Detailing, Design, IT, Purchasing, Maintenance, Production. Branded: Project Coordinators, Sales.", items: [
        { text: "Confirm branded vs. unbranded based on department", detail: "" },
        { text: "If created 2+ weeks before start date, set nUEAccountType = \"Primary\"", detail: "Not set within 14 days of creation triggers an account-deletion notice" },
        { text: "If created 2+ weeks before start date, set nUECategoryID = \"10\"", detail: "" } ] },
      { title: "Create the mailbox", note: "", items: [
        { text: "Log into RMCLT.RZ.NUCORSTEEL.LOCAL with .PA account", detail: "" },
        { text: "Open Management Consoles → Exchange On-Prem Admin Center", detail: "" },
        { text: "Sign in with power admin", detail: "e.g. Bg\\adm.xxxxxxx.pa" },
        { text: "Mailboxes tab → + dropdown → Office 365 Mailbox", detail: "" },
        { text: "Enter required info and set the correct OU", detail: "" },
        { text: "Set User Logon Name to @nucor.com (all lowercase)", detail: "" },
        { text: "Format display name as Lastname, Firstname (" + (this.templateMode ? "DIVISION" : Divisions.label()) + ")", detail: "Capitalized first letters" } ] },
      { title: "AD attributes", note: "Values below are Brandenburg (CBC/BGLTR). For Utah use NBSUT / BGBRI.", items: [
        { text: "Set MAIL to @nucor.com (lowercase)", detail: "Depending on OU placement" },
        { text: "Set Primary SMTP to @nucor.com (proxy address)", detail: "" },
        { text: "Extension Attribute 3 = CBC (NBSUT for Utah)", detail: "" },
        { text: "Extension Attribute 5 = BGLTR (BGBRI for Utah)", detail: "" },
        { text: "Extension Attribute 2 = 000 + Employee ID", detail: "Get from HR or the EmployeeID attribute" } ] },
      { title: "Groups, licenses & tokens", note: "", items: [
        { text: "Copy AD groups from a peer", detail: "PowerShell: \"Copy AD Groups From User to User\"" },
        { text: "Request M365 license in NBT Service Catalog", detail: "Knowledge worker for office staff; Frontline worker for shop" },
        { text: "Request BlueBeam license in NBT Service Catalog", detail: "" },
        { text: "Coordinate with NucorNet Admin to assign a token", detail: "" } ] },
      { title: "Building access", note: "", items: [
        { text: "Add \"acre\" to 'department' under the Organization tab in AD", detail: "Required for key fob" },
        { text: "Set up user in the main Nucor.Steel Feenics instance and assign FOB", detail: "" } ] },
      { title: "Vacation Utility", note: "", items: [
        { text: "Confirm/update Vacation Utility with HR or IT admin", detail: "" },
        { text: "Open the Lathrop group (right-click) and add the user", detail: "" },
        { text: "Enter SAP # = 000 + Employee ID", detail: "" },
        { text: "Enter employee information", detail: "" },
        { text: "Enter NT User Name (first.last)", detail: "" },
        { text: "Right-click user → Reporting Chain", detail: "" },
        { text: "Set Radial button permissions to \"Not Allow\" for standard users", detail: "" } ] } ] },
    computerBase: { label: "Computer — base build", sections: [
      { title: "Prep", note: "Do NOT plug the network cable in yet — we're hybrid-joined and don't want Autopilot to take over the install.", items: [
        { text: "Get the user's login info for this machine", detail: "" }, { text: "Unbox", detail: "" },
        { text: "Confirm the BIOS and Boot Menu keys for this model", detail: "Give Copilot the model info and it will find them" },
        { text: "Plug in power (network cable stays out)", detail: "" } ] },
      { title: "BIOS & Windows install", note: "", items: [
        { text: "Power on and enter BIOS", detail: "" }, { text: "Turn off Secure Boot", detail: "" },
        { text: "Plug in the USB Windows boot media", detail: "" }, { text: "Save & exit BIOS, then enter the Boot Menu", detail: "" },
        { text: "Select the Windows boot media", detail: "" }, { text: "Custom install → delete old partitions", detail: "" },
        { text: "Create new partitions, select the main partition → Next", detail: "" },
        { text: "At the network prompt choose \"I don't have internet\"", detail: "" },
        { text: "Continue with limited setup", detail: "" }, { text: "Create a local admin for the initial install", detail: "" } ] },
      { title: "Domain join", note: "", items: [
        { text: "Logged into local admin, connect ethernet", detail: "" },
        { text: "Open properties on THIS PC → domain or workgroup join", detail: "" },
        { text: "From your PC, remote into rmclt.rz.nucorsteel.local with adm.xxxxxx.pa", detail: "" },
        { text: "Run ADPIM on the remote desktop → Computer join account → OK", detail: "" },
        { text: "Select the target domain and how long the JN account stays active", detail: "" },
        { text: "Screenshot the JN account password from the ADPIM window", detail: "Snipping tool" },
        { text: "Activate the JN account in the remote desktop", detail: "Can take a while" },
        { text: "On the new PC run the domain join wizard", detail: "Username = JN account; domain = BG.NUCORSTEEL.LOCAL" },
        { text: "Name the computer per your division's convention", detail: "" },
        { text: "Do NOT restart yet — move the PC from \"Computers\" to its correct OU in AD", detail: "Refresh the Computers group if it's not showing up" },
        { text: "Once moved to its OU, reboot", detail: "" } ] },
      { title: "Sign-in & updates", note: "", items: [
        { text: "Sign in with the user's login info", detail: "" },
        { text: "Check for updates, then run optional updates", detail: "Chipset, network, and firmware" },
        { text: "Reboot after updates", detail: "" }, { text: "Open Company Portal and select your division code", detail: "" } ] },
      { title: "BitLocker & compliance", note: "", items: [
        { text: "Windows search → Manage BitLocker → Turn on", detail: "" },
        { text: "Save the recovery key to the Azure AD account", detail: "" }, { text: "Run BitLocker", detail: "" },
        { text: "Run a Sync in Company Portal settings", detail: "" }, { text: "Confirm the device shows compliant in Company Portal", detail: "" } ] } ] },
    departments: {
      "Estimating": { sections: [ { title: "Estimating — software & config", note: "", items: [
        { text: "Office 2016", detail: "" }, { text: "Bluebeam", detail: "" }, { text: "Font folder", detail: "" }, { text: "Settings config", detail: "" }, { text: "Set home page", detail: "" }, { text: "Google Chrome", detail: "" }, { text: "SCCM client install (Run as admin)", detail: "\\\\BGCLTSCCM01" }, { text: "Shortcut to BGBRIFILE01.jobs", detail: "" }, { text: "BricsCad", detail: "" }, { text: "Vacation Utility (pushed)", detail: "" }, { text: "Printers — Estimating", detail: "" }, { text: "Bomsnet (pushed)", detail: "" }, { text: "DIGI Timesheet (pushed)", detail: "" }, { text: "E-mail", detail: "" }, { text: "Servers NBG XML", detail: "" }, { text: "Server XML", detail: "" }, { text: ".NET Framework", detail: "" } ] } ] },
      "Engineering": { sections: [ { title: "Engineering — software & config", note: "Installs share: \\\\bgbrisccm02\\Engineering System Installs\\Detailing Installs", items: [
        { text: "Bluebeam 2020", detail: "" }, { text: "SCCM client install", detail: "\\\\bgcltsccm01" }, { text: "Remote Desktop", detail: "" }, { text: "Vacation Utility", detail: "" }, { text: "Digital Timesheet", detail: "" }, { text: "MBS / MBS Explorer / Driver / Fix", detail: "c$\\MBS\\AzTech2\\IBFS32_to_C_Windows" }, { text: "MBS", detail: "bgbrifile01\\mbs master" }, { text: "Microsoft Teams", detail: "" }, { text: "BricsCad (Run as admin)", detail: "" }, { text: "BricsCad Red Print import", detail: "" }, { text: "Digi Anywhere", detail: "IP 10.9.48.119" }, { text: "Bomsnet", detail: "" }, { text: "GPEdit — Admin Tools / System / Component update", detail: "" }, { text: "Office / E-mail", detail: "" }, { text: ".NET 3.5 install", detail: "" }, { text: "Printers — Detailing Kyo / Detailing Canon / Detailing / Plotter", detail: "" }, { text: "RISA suite", detail: "license RISA01" }, { text: "InputSimulatorInstaller.msi", detail: "Swinst\\TKG Design MSI\\" }, { text: "NBS CAD tools", detail: "" }, { text: "Smath Studio", detail: "" }, { text: "NBG Bracing", detail: "" }, { text: "Light Gauge", detail: "" }, { text: "Beyond Compare 3", detail: "" }, { text: "Default programs", detail: "" }, { text: "Dell Assist driver", detail: "" }, { text: "Update latest video card driver", detail: "" }, { text: "Signatures", detail: "" }, { text: "Cisco VPN — test vpn.nucorservices.com", detail: "" }, { text: "OneDrive login / setup", detail: "" }, { text: "Trimble Connect (download & install)", detail: "" }, { text: "Engineering Librarian", detail: "" }, { text: "Fonts", detail: "" }, { text: "Settings config", detail: "" }, { text: "FrameDraw", detail: "" }, { text: "Desktop shortcuts", detail: "\\\\bgbrifile01\\Jobs, \\\\bgbrifile02\\Engineering, \\\\bgbrifile01\\DesignSpreadsheets" }, { text: "Record Service Tag, User's name, Tech", detail: "" } ] } ] },
      "Structural Supervisor": { sections: [ { title: "Structural Supervisor — software & config", note: "", items: [
        { text: "Office O365", detail: "" }, { text: "Adobe Reader", detail: "" }, { text: "Settings config", detail: "" }, { text: "Set home page", detail: "" }, { text: "Google Chrome", detail: "" }, { text: "SCCM client install (Run as admin)", detail: "\\\\BGCLTSCCM01" }, { text: "Vacation Utility (pushed)", detail: "" }, { text: "Printers — for department", detail: "" }, { text: "Bomsnet (pushed)", detail: "" }, { text: "DIGITAL Timesheet (pushed)", detail: "" }, { text: "Servers NBG XML", detail: "" }, { text: "Server XML", detail: "" }, { text: "Sicm", detail: "" }, { text: "BricsCad", detail: "" }, { text: "DW Spectrum", detail: "\\\\bgbrinas01\\swinst\\DW Spectrum — Server: BGBRICAMERA02 — Email/Zaq123edc" }, { text: "Boms", detail: "" }, { text: "Dailey Bonus", detail: "" }, { text: "Pits", detail: "" }, { text: ".NET installed", detail: "" }, { text: "Crystal Reports", detail: "" }, { text: "PCP installed", detail: "" }, { text: "Replace host file with the new one", detail: "C:\\Windows\\System32\\drivers\\etc" }, { text: "Teams", detail: "" }, { text: "Set default apps", detail: "" }, { text: "Inventory tracking", detail: "" } ] } ] },
      "Shop": { sections: [ { title: "Shop — software & config", note: "", items: [
        { text: "Office 2016", detail: "" }, { text: "Adobe Reader", detail: "" }, { text: "Settings config", detail: "" }, { text: "Set home page", detail: "" }, { text: "Google Chrome", detail: "" }, { text: "SCCM client install (Run as admin)", detail: "\\\\BGCLTSCCM01" }, { text: "Vacation Utility (pushed)", detail: "" }, { text: "Printers — for department", detail: "" }, { text: "Bomsnet (pushed)", detail: "" }, { text: "DIGI Timesheet (pushed)", detail: "" }, { text: "Servers NBG XML", detail: "" }, { text: "Server XML", detail: "" }, { text: "SCCM", detail: "" } ] } ] },
      "Project Coordinator": { sections: [ { title: "Project Coordinator — software & config", note: "Project Coordinators use branded (@nucor.com) accounts.", items: [
        { text: "Office 365", detail: "" }, { text: "Bluebeam", detail: "" }, { text: "Font folder", detail: "" }, { text: "Settings config", detail: "" }, { text: "Set home page", detail: "" }, { text: "Google Chrome", detail: "" }, { text: "SCCM client install (Run as admin)", detail: "\\\\BGCLTSCCM01" }, { text: "Shortcut to BGBRIFILE01.jobs", detail: "" }, { text: "BricsCad", detail: "" }, { text: "Vacation Utility (pushed)", detail: "" }, { text: "Printers", detail: "" }, { text: "Bomsnet (pushed)", detail: "" }, { text: "DIGI Timesheet (pushed)", detail: "" }, { text: "E-mail", detail: "" }, { text: "Signatures", detail: "%AppData%\\Roaming\\Microsoft\\Signatures" }, { text: "Servers NBG XML", detail: "" }, { text: "Server XML", detail: "" }, { text: ".NET Framework", detail: "" }, { text: "Cisco VPN — test vpn.nucorservices.com", detail: "Log in then out, select \"Franklin New\"" }, { text: "TM signoff", detail: "" } ] } ] },
      "Detailing": { sections: [
        { title: "Detailing — software & config", note: "Updated 8/23/2022. Record User / Tech / Date / Service Tag / Asset #.", items: [
          { text: "SCCM client install (Run as admin)", detail: "\\\\BGCLTSCCM01" }, { text: "Dell Assist driver updates", detail: "" }, { text: "Remote Desktop", detail: "Start > Run > AdvancedSystemSettings" }, { text: "Servers NBG XML", detail: "" }, { text: "Server XML", detail: "" }, { text: "Settings config", detail: "" }, { text: "Office 365", detail: "" }, { text: "Outlook setup and signatures", detail: "%AppData%\\Roaming\\Microsoft\\Signatures" }, { text: "BlueBeam 2020", detail: "" }, { text: "Font folder", detail: "" }, { text: "BricsCad 13", detail: "" }, { text: "BricsCad profile / Red Print button", detail: "" }, { text: "Set Bricscad.exe to run as admin", detail: "Properties > Compatibility tab" }, { text: "GPEdit and .NET Framework 3.5", detail: "" }, { text: "Detailing Startup (Tekla 20) — NonMBS", detail: "" }, { text: "Google Chrome", detail: "" }, { text: "Parts List", detail: "Via Detailing Startup, or pushed via SCCM for MBS" }, { text: "Shortcut for \\\\bgbrifile01\\jobs", detail: "" }, { text: "Frame Detailing program", detail: "" }, { text: "Vacation Utility (pushed)", detail: "" }, { text: "Printers — Detailing Canon / Eng Kyo", detail: "" }, { text: "MBS Detailing Explorer", detail: "" }, { text: "Bomsnet (pushed)", detail: "" }, { text: "Digital Timesheet (pushed)", detail: "" }, { text: "Run TeklaXMLFile.Bat", detail: "\\\\BGBRIFILE01\\Jobs - Search.Bat" }, { text: "Microsoft Teams", detail: "" }, { text: "Add to SharePoint Asset Database", detail: "" }, { text: "Activate Tekla license server", detail: "27007@bgbritekla01" }, { text: "Cisco VPN — test vpn.nucorservices.com", detail: "Log in then out, select \"Franklin New\"" }, { text: "Device manager", detail: "" }, { text: "Default programs", detail: "" }, { text: "Jabber — install, login, autostart", detail: "" }, { text: "Disable Administrator account", detail: "" }, { text: "Tekla TLS fix", detail: "" }, { text: "Copy Tekla profiles", detail: "AppData\\Local\\Trimble\\TeklaStructures\\2016i and \\Tekla Structures\\2019.1" }, { text: "Document Library admin", detail: "" }, { text: "MBS Librarian 6.30 (MBS Detailing team)", detail: "" }, { text: "CAD tools", detail: "" } ] },
        { title: "Detailing — Tekla build (per 2022 procedure)", note: "Install from \\\\bgbrisccm02\\Engineering System Installs\\Detailing Installs. The \"Install All\" button was removed.", items: [
          { text: "Install Detailing Startup, let it upgrade if needed", detail: "" }, { text: "Install Tekla Structures 2019i Service Pack 2", detail: "" }, { text: "Install Tekla Structures 2019i Service Pack 11", detail: "" }, { text: "Install NBG Manufacturing 2019.9 (or latest)", detail: "" }, { text: "Install all Microsoft redistributables from Detailing Startup", detail: "" }, { text: "Install NBG Parts List UI", detail: "" }, { text: "Install Tekla Structures License Borrow Tool 2020", detail: "" }, { text: "Install NBG Job Processor (if required at your location)", detail: "" }, { text: "MBS Detailers: install MBSTransporter", detail: "" } ] } ] },
    },
  }; },
};

/* ---- mock additions for the hub + dashboard (browser preview only) ------- */
Object.assign(Mock, {
  /* directory type-ahead + super admins - mirrors Api.user_lookup / get_super_admins / save_super_admins */
  _sa: ["demo@nucor.com"],
  async user_lookup(q, kind) {
    const people = [{ kind: "user", id: "u1", name: "Sims Anderson (Azure Admin)", upn: "adm.sanderson.azure@nucor.onmicrosoft.com", detail: "Nucor Business Technology" },
                    { kind: "user", id: "u2", name: "Joshua Udy", upn: "joshua.udy@nucor.com", detail: "NBG - Terrell" },
                    { kind: "user", id: "u3", name: "Blake Stevenson", upn: "blake.stevenson@nucor.com", detail: "Nucor Business Technology" }];
    const groups = [{ kind: "group", id: "g1", name: "NBG Hub Users", detail: "App users" }, { kind: "group", id: "g2", name: "NBGTX IT", detail: "Terrell IT" }];
    const cos = [{ kind: "company", id: "NBG - Terrell", name: "NBG - Terrell", detail: "12+ people" }, { kind: "company", id: "Nucor Buildings Group West", name: "Nucor Buildings Group West", detail: "80+ people" }, { kind: "company", id: "Nucor Business Technology", name: "Nucor Business Technology", detail: "30+ people" }];
    const t = (q || "").toLowerCase();
    return { ok: true, results: (kind === "group" ? groups : kind === "company" ? cos : people).filter(x => (x.name + (x.upn || "")).toLowerCase().includes(t)) };
  },
  async get_super_admins() { return { ok: true, super_admin: true, admins: [...this._sa], bootstrap: ["demo@nucor.com"], me: "demo@nucor.com" }; },
  async save_super_admins(list) {
    if (!list.includes("demo@nucor.com")) return { ok: false, error: "You cannot remove yourself from the super admins (you would lose access)." };
    this._sa = list; return { ok: true, admins: list };
  },
  async get_flags() { return { ok: true, auto_sync: true }; },
  /* division admin - mirrors Api.get_division_admin / save_division */
  _dv: [
    { id: "nbgw", name: "NBGW - Nucor Buildings Group West", company_name: "Nucor Buildings Group West", intune_category: "NBGW", sharepoint_hostname: "nucor.sharepoint.com", site_path: "/sites/NBGW/systems", ad_domain: "bg.nucorsteel.local", sql_server: "BGBRISQL07", enabled: true, access: [],
      sites: [{ code: "LTR", name: "Lathrop, CA", city_prefixes: ["lathrop"], device_prefixes: ["BGLTR", "BGCCN", "BGMOD"] }, { code: "BRI", name: "Brigham City, UT", city_prefixes: ["brigham"], device_prefixes: ["BGBRI"] }] },
    { id: "nbgtx", name: "NBGTX - NBG Terrell", company_name: "NBG - Terrell", intune_category: "NBGTX", sharepoint_hostname: "", site_path: "", ad_domain: "", sql_server: "", enabled: true, access: [],
      sites: [{ code: "TER", name: "Terrell, TX", city_prefixes: ["terrell"], device_prefixes: ["BGTER"] }] }],
  async get_division_admin() { return { ok: true, super_admin: true, divisions: JSON.parse(JSON.stringify(this._dv)) }; },
  async save_division(d) {
    if (!/^[a-z0-9][a-z0-9_-]{1,19}$/.test(d.id || "")) return { ok: false, error: "Division id: 2-20 characters, lowercase letters, digits, - or _." };
    if (!d.name || !d.company_name || !d.intune_category) return { ok: false, error: "Display name, Entra company name and Intune category are required." };
    const i = this._dv.findIndex(x => x.id === d.id);
    if (i >= 0) this._dv[i] = d; else this._dv.push(d);
    return { ok: true };
  },
  /* master settings - mirrors Api.get_master_settings / set_master_setting (catalog = settings_catalog.py) */
  _tzs: [["America/New_York", "Eastern (US & Canada)"], ["America/Chicago", "Central (US & Canada)"], ["America/Denver", "Mountain (US & Canada)"],
         ["America/Phoenix", "Arizona (no daylight saving)"], ["America/Los_Angeles", "Pacific (US & Canada)"], ["America/Anchorage", "Alaska"],
         ["Pacific/Honolulu", "Hawaii"], ["America/Halifax", "Atlantic (Canada)"], ["America/Mexico_City", "Central Mexico"], ["UTC", "UTC"]],
  _cat: [
    { key: "lenovo_client_id", group: "Vendor APIs", label: "Lenovo warranty API client ID", kind: "secret", secret: true, status: "active", help: "Lets the app look up Lenovo warranty dates and specs by serial number. Stored hidden; it is never shown again after you save it." },
    { key: "dell_client_id", group: "Vendor APIs", label: "Dell TechDirect client ID", kind: "secret", secret: true, status: "active", help: "Dell warranty end date and model by service tag. Get it in Dell TechDirect: register an API app and authorise it for the Warranty API. Dell gives no CPU/RAM/storage." },
    { key: "dell_client_secret", group: "Vendor APIs", label: "Dell TechDirect client secret", kind: "secret", secret: true, status: "active", help: "Pairs with the Dell client ID." },
    { key: "hp_client_id", group: "Vendor APIs", label: "HP warranty API key", kind: "secret", secret: true, status: "active", help: "HP warranty end date and model by serial number. Request the key from HP. Not yet tested against HP's live service: after saving, run python tools/vendor_probe.py hp <serial> once." },
    { key: "hp_client_secret", group: "Vendor APIs", label: "HP warranty API secret", kind: "secret", secret: true, status: "active", help: "Pairs with the HP key." },
    { key: "default_timezone", group: "Regional", label: "Default time zone", kind: "choice", secret: false, status: "active", help: "Used by every division that has not picked its own time zone. Blank = each PC's own time zone." },
    { key: "project_hub_url", group: "Regional", label: "Default Project Hub address", kind: "url", secret: false, status: "active", help: "Where the Project Hub sidebar item opens for divisions that have not set their own address (Settings > General). Blank = https://projecthub-dev.nucorservices.com/" },
    { key: "auto_sync", group: "Sync", label: "Sync automatically when the app opens", kind: "choice", secret: false, status: "active", options: [{ id: "on", label: "On (default)" }, { id: "off", label: "Off - only the Sync buttons sync" }], help: "With it on, opening the app starts a sync for the division you are in. Turn it off to stop that on every PC (the NBG_NO_AUTOSYNC setting on a single PC still wins)." },
    { key: "upgrade_cpu_years", group: "Upgrades", label: "Queue for upgrade: processor older than (years)", kind: "number", secret: false, min: 0, max: 15, default: 5, status: "active", help: "A device whose processor generation was released this many years ago or more is added to the Upgrade list. 0 turns this rule off. Needs the device's CPU to be known." },
    { key: "upgrade_warranty_months", group: "Upgrades", label: "Queue for upgrade: warranty ended at least (months)", kind: "number", secret: false, min: 0, max: 60, default: 0, status: "active", help: "A device whose warranty ended this many months ago or more is added to the Upgrade list. 0 (the default) turns this rule off. Works for any maker, because it only needs the warranty date." },
    { key: "notify_webhook_url", group: "Notifications", label: "Notification webhook (sends the e-mails)", kind: "secret", secret: true, status: "active", help: "The address of a Power Automate flow (trigger: 'When an HTTP request is received') that e-mails or Teams-messages the people the app names. Stored hidden. Without it, issue e-mails can only be sent if the signed-in user's token already has Mail.Send, which it normally does not." },
    { key: "ad_domain_controller", group: "Directory", label: "Domain controller for Copy Permissions", kind: "text", secret: false, status: "active", help: "The one on-premises AD server that BG Tools > Copy Permissions reads from and writes to, for example BGDALDCRW02.bg.nucorsteel.local. Blank = let Windows pick one." },
    { key: "intune_enrich_per_sync", group: "Sync", label: "Vendor lookups per sync run", kind: "number", secret: false, min: 0, max: 500, default: 75, status: "active", help: "How many devices get a Lenovo/Dell/HP spec lookup in one sync. Lower = gentler on vendor APIs, slower to fill in." },
    { key: "latest_version", group: "Releases", label: "Latest released version", kind: "version", secret: false, status: "active", help: "The newest NBG Hub build, for example 2026.10.15. Techs on an older build see an 'Update available' notice." },
    { key: "min_version", group: "Releases", label: "Oldest allowed version", kind: "version", secret: false, status: "active", help: "Builds older than this show a red 'Update required' notice. Raise it when a release changes how data is stored." },
    { key: "stale_checkin_days", group: "Sync", label: "Flag devices not seen for (days)", kind: "number", secret: false, min: 1, max: 365, default: 30, status: "active", help: "Intune devices with no check-in for longer than this are flagged stale." }],
  _ms: { lenovo_client_id: "SECRET", super_admins: "demo@nucor.com", legacy_thing: "old value" },
  async get_master_settings() {
    const cat = this._cat.map(c => ({ ...c, options: c.kind === "choice" ? this._tzs.map(([id, label]) => ({ id, label })) : undefined,
      is_set: !!this._ms[c.key], value: c.secret ? "" : (this._ms[c.key] || "") }));
    const known = new Set(this._cat.map(c => c.key));
    const other = Object.keys(this._ms).filter(k => !known.has(k) && k !== "super_admins").map(k => ({ key: k, secret: false, is_set: true, value: this._ms[k], description: "" }));
    return { ok: true, super_admin: true, settings: [], catalog: cat, other };
  },
  async set_master_setting(key, value, secret) {
    const c = this._cat.find(x => x.key === key);
    if (c && c.kind === "number" && value !== "") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < c.min || n > c.max) return { ok: false, error: `${c.label} must be between ${c.min} and ${c.max}.` };
    }
    this._ms[key] = value;
    return { ok: true };
  },
  /* division preferences + tenant settings - mirrors Api.get_division_prefs / save_division_prefs / get_own_division / save_own_division */
  _prefs: { timezone: "" },
  async get_my_prefs() { return { ok: true, divisions: (Divisions.list || []).map(d => ({ id: d.id, name: d.name })), default_division: localStorage.getItem("mock_def_div") || "" }; },
  async save_my_prefs(d) { try { localStorage.setItem("mock_def_div", d || ""); } catch (e) {} return { ok: true, default_division: d || "" }; },
  async get_division_prefs() {
    const d = this._ms.default_timezone || "", def = this._ms.project_hub_url || "https://projecthub-dev.nucorservices.com/", own = this._prefs.project_hub_url || "";
    return { ok: true, timezone: this._prefs.timezone, default: d, effective: this._prefs.timezone || d, zones: this._tzs.map(([id, label]) => ({ id, label })),
      project_hub_url: own, project_hub_default: def, project_hub_effective: own || def,
      device_os: this._prefs.device_os || "windows", device_os_options: [{ id: "windows", label: "Windows computers only" }, { id: "all", label: "All device types (phones, tablets, Macs too)" }],
      hot_spare_depts: this._prefs.hot_spare_depts || [], hot_spare_default: ["Detailing", "Engineering"],
      hot_spare_effective: ((this._prefs.hot_spare_depts || []).length ? this._prefs.hot_spare_depts : ["Detailing", "Engineering"]).concat(["Other"]) };
  },
  _scopes: null,
  async get_search_scopes() {
    return { ok: true, super_admin: true, custom: !!this._scopes, brands: (this._scopes || { brands: [{ label: "American Buildings", domain: "americanbuildings.com" }, { label: "CBC Steel Buildings", domain: "cbcsteelbuildings.com" }] }).brands,
      divisions: (this._scopes || { divisions: [{ label: "NBSIN — Waterloo", company: "NBSIN" }, { label: "NBGSC — NBG Swansea", company: "NBG - Swansea" }] }).divisions };
  },
  async save_search_scopes(d) {
    for (const b of d.brands || []) if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test((b.domain || "").trim())) return { ok: false, error: "Brand '" + (b.label || b.domain) + "': needs a name and an email domain such as example.com." };
    this._scopes = d; return { ok: true, ...d };
  },
  async save_division_prefs(tz, url, os, depts) {
    if (os !== undefined && os !== null) this._prefs.device_os = os;
    if (depts !== undefined && depts !== null) this._prefs.hot_spare_depts = depts.filter(x => x && x.toLowerCase() !== "other");
    if (tz !== undefined && tz !== null) this._prefs.timezone = tz || "";
    if (url !== undefined && url !== null) {
      let u = (url || "").trim();
      if (u && !/^[a-z]+:\/\//i.test(u)) u = "https://" + u;                  // like the real backend: bare host names get https://
      if (u && !/^https:\/\/[^\s/@]+\.[^\s/@]+(\/\S*)?$/i.test(u)) return { ok: false, error: "Enter a web address starting with https:// (no spaces, no user name or password)." };
      this._prefs.project_hub_url = u;
    }
    return { ok: true };
  },
  async get_own_division() {
    const d = this._dv.find(x => x.id === this._divCur) || this._dv[0];
    return { ok: true, id: d.id, name: d.name, company_name: d.company_name, intune_category: d.intune_category, super_admin: true, role: "super", can_edit: true,
      sites: JSON.parse(JSON.stringify(d.sites || [])), access: [...(d.access || [])], ad_domain: d.ad_domain || "", sql_server: d.sql_server || "",
      timesheet_db: d.timesheet_db || "", timesheet_table: d.timesheet_table || "", employee_db: d.employee_db || "", employee_table: d.employee_table || "" };
  },
  async save_own_division(data) {
    const d = this._dv.find(x => x.id === this._divCur) || this._dv[0];
    for (const c of (data.sites || [])) if (!/^[A-Za-z0-9]{2,6}$/.test(c.code || "")) return { ok: false, error: `Site code '${c.code || ""}': 2-6 letters or digits.` };
    for (const k of ["sites", "access", "ad_domain", "sql_server", "timesheet_db", "timesheet_table", "employee_db", "employee_table"]) if (k in data) d[k] = data[k];
    return { ok: true };
  },
  _ra: { user: [], admin: ["models", "links", "access", "sites", "sql", "perms", "storage"] },
  async sync_all_divisions() {
    await new Promise(r => setTimeout(r, 900));
    return { ok: true, divisions: this._dv.map(d => ({ id: d.id, name: d.name, ok: true, count: d.id === "nbgw" ? 466 : 328, added: 0, updated: d.id === "nbgw" ? 3 : 328, deduped: 0, enriched: 12, errors: [] })) };
  },
  _syncSt: { ended: "2026-10-01T12:48:00Z", by: "Demo User", source: "app", count: 466, added: 0, updated: 3, deduped: 0, enriched: 12, ok: true, errors: [], age_hours: 2, stale: false, never: false },
  async get_sync_status() { return { ok: true, ...this._syncSt }; },
  async get_sync_overview() {
    return { ok: true, super_admin: true, divisions: this._dv.map(d => d.id === "nbgw" ? { id: d.id, name: d.name, ...this._syncSt } : { id: d.id, name: d.name, never: true, stale: true }) };
  },
  async cpu_info(text) { const m = /i[3579]-(\d{1,2})\d{3}/.exec(text || ""); const yr = m ? ({ 6: 2015, 7: 2016, 8: 2017, 9: 2018, 10: 2019, 11: 2020, 12: 2022, 13: 2023, 14: 2024 })[+m[1]] : null; return { ok: true, year: yr || null, age: yr ? new Date().getFullYear() - yr : null }; },
  async update_device_specs(serial, f) {
    if (f.warranty && !/^\d{4}-\d{2}-\d{2}$/.test(f.warranty)) return { ok: false, error: "Warranty must be a date like 2027-05-31." };
    for (const list of [this._use, this._stock]) { const r = list.find(x => x.serial === serial); if (r) { ["cpu", "ram", "storage", "warranty"].forEach(k => { if (f[k] !== undefined) r[k] = f[k]; }); return { ok: true, queued_upgrades: 0 }; } }
    return { ok: false, error: serial + " was not found in inventory." };
  },
  async hub_clear_upgrade_ignored() { return { ok: true, cleared: 0 }; },
  /* issues board - mirrors Api.issue_* */
  _issues: [
    { id: "iss-demo-1", type: "bug", title: "Hot spares window shows the wrong site", detail: "Opened from the dashboard tile, the LTR column is empty.", status: "open", reporter: { upn: "demo@nucor.com", name: "Demo User" }, division: { id: "nbgw", name: "NBGW" }, version: "2026.10.01", created_at: "2026-10-01T12:00:00Z", updated_at: "2026-10-01T15:00:00Z", assignee: null, votes: ["a@x.com"], watchers: ["demo@nucor.com"], comments: [{ id: "c1", by: "Sims", upn: "s@x.com", at: "2026-10-01T15:00:00Z", text: "Reproduced. Looking." }], history: [{ at: "2026-10-01T12:00:00Z", by: "Demo User", action: "created", detail: "bug reported" }] },
    { id: "iss-demo-2", type: "feature", title: "Export the Upgrade list to Excel", detail: "", status: "planned", reporter: { upn: "a@x.com", name: "Blake" }, division: { id: "nbgtx", name: "NBG - Terrell" }, version: "2026.10.01", created_at: "2026-09-30T09:00:00Z", updated_at: "2026-09-30T09:00:00Z", assignee: { upn: "dev@x.com", name: "Dev" }, votes: [], watchers: [], comments: [], history: [{ at: "2026-09-30T09:00:00Z", by: "Blake", action: "created", detail: "feature reported" }] }],
  _sum(d) { return { id: d.id, short: "#" + d.id.slice(-6).toUpperCase(), type: d.type, title: d.title, status: d.status, reporter: d.reporter, division: d.division, created_at: d.created_at, updated_at: d.updated_at, assignee: d.assignee, votes: d.votes.length, comments: d.comments.length, files: (d.attachments || []).length + d.comments.reduce((n, c) => n + (c.attachments || []).length, 0), voted: d.votes.includes("demo@nucor.com"), watching: d.watchers.includes("demo@nucor.com"), mine: d.reporter.upn === "demo@nucor.com" }; },
  async issues_list() { return { ok: true, issues: this._issues.map(d => this._sum(d)), triage: true, me: "demo@nucor.com", statuses: [["new", "New"], ["open", "Open"], ["planned", "Planned"], ["in_progress", "In progress"], ["done", "Done"], ["wont_do", "Won't do"]].map(([id, label]) => ({ id, label })) }; },
  async issue_get(id) { const d = this._issues.find(x => x.id === id); return d ? { ok: true, issue: JSON.parse(JSON.stringify(d)), summary: this._sum(d), triage: true, can_edit: true } : { ok: false, error: "That issue no longer exists." }; },
  _files: {},
  async issue_attachment(id, att) { const f = this._files[id + "/" + att]; return f ? { ok: true, ...f } : { ok: false, error: "That file no longer exists." }; },
  _keep(id, files) {
    return (files || []).map((f, i) => { const att = "a-" + Date.now() + i; this._files[id + "/" + att] = { name: f.name, type: /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name) ? "image/" + f.name.split(".").pop().replace("jpg", "jpeg").toLowerCase() : "application/octet-stream", size: Math.round(f.data.length * 0.75), data: f.data };
      return { id: att, name: f.name, type: this._files[id + "/" + att].type, size: this._files[id + "/" + att].size, by: "Demo User", at: new Date().toISOString() }; });
  },
  async issue_create(kind, title, detail, files) {
    if (!(title || "").trim()) return { ok: false, error: "Add a short title." };
    const d = { id: "iss-" + Date.now(), type: kind, title: title.trim(), detail: detail || "", status: "new", reporter: { upn: "demo@nucor.com", name: "Demo User" }, division: { id: "nbgw", name: "NBGW" }, version: "2026.10.01", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), assignee: null, votes: [], watchers: ["demo@nucor.com"], comments: [], history: [{ at: new Date().toISOString(), by: "Demo User", action: "created", detail: kind + " reported" }] };
    if (files && files.length) d.attachments = this._keep(d.id, files);
    this._issues.unshift(d); return { ok: true, issue: this._sum(d) };
  },
  async issue_comment(id, text, files) {
    const d = this._issues.find(x => x.id === id); if (!(text || "").trim() && !(files || []).length) return { ok: false, error: "Write a comment first." };
    const c = { id: "c" + Date.now(), by: "Demo User", upn: "demo@nucor.com", at: new Date().toISOString(), text: text || "" };
    if (files && files.length) c.attachments = this._keep(id, files);
    d.comments.push(c); d.updated_at = new Date().toISOString(); return { ok: true, issue: d };
  },
  async issue_vote(id) { const d = this._issues.find(x => x.id === id), u = "demo@nucor.com", i = d.votes.indexOf(u); if (i >= 0) d.votes.splice(i, 1); else d.votes.push(u); return { ok: true, voted: i < 0, votes: d.votes.length }; },
  async issue_watch(id) { const d = this._issues.find(x => x.id === id), u = "demo@nucor.com", i = d.watchers.indexOf(u); if (i >= 0) d.watchers.splice(i, 1); else d.watchers.push(u); return { ok: true, watching: i < 0 }; },
  async issue_update(id, f) {
    const d = this._issues.find(x => x.id === id); if (f.status) d.status = f.status; if ("assignee" in f) d.assignee = f.assignee;
    if (f.title !== undefined) d.title = f.title; if (f.detail !== undefined) d.detail = f.detail; d.updated_at = new Date().toISOString(); return { ok: true, issue: d };
  },
  async issue_delete(id) { this._issues = this._issues.filter(x => x.id !== id); return { ok: true }; },
  async issues_import_legacy() { return { ok: true, imported: 0 }; },
  _subs: [{ upn: "blake@nucor.com", name: "Blake Stevenson", events: ["new", "status", "comment"] }],
  async get_issue_notifications() { return { ok: true, super_admin: true, subscribers: JSON.parse(JSON.stringify(this._subs)), events: ["new", "status", "comment"], webhook_set: false, can_mail: false }; },
  async save_issue_subscribers(list) { this._subs = list; return { ok: true, subscribers: list }; },
  async issue_notify_test() { return { ok: false, error: "No way to send e-mail is set up yet (add a notification webhook in Settings > Integrations)." }; },
  _adu: [{ dn: "CN=Anderson\\, Sims,OU=Admins,DC=bg", name: "Anderson, Sims (Admin)", sam: "adm.sanderson.pa", title: "Systems", dept: "IT", enabled: true },
         { dn: "CN=Smith\\, Pat,OU=Admins,DC=bg", name: "Smith, Pat (Admin)", sam: "adm.psmith.pa", title: "Systems", dept: "IT", enabled: true }],
  _adg: { "CN=Anderson\\, Sims,OU=Admins,DC=bg": [["IT-Intune-Admins", false], ["IT-ServerOps", false], ["Domain Admins", true], ["VPN-Users", false]], "CN=Smith\\, Pat,OU=Admins,DC=bg": [["VPN-Users", false], ["IT-HelpDesk", false]] },
  _adgl(dn) { return (this._adg[dn] || []).map(([n, p]) => ({ dn: "CN=" + n + ",OU=Groups,DC=bg", name: n, desc: p ? "Protected admin group" : "", security: true, privileged: p })); },
  async ad_smartcard_accounts() { return { ok: true, accounts: [{ upn: "adm.sanderson.pa@nucorsteel.local", cn: "adm.sanderson.pa", expires: "2027-03-03" }, { upn: "adm.sanderson.dvc@nucorsteel.local", cn: "adm.sanderson.dvc", expires: "2027-03-03" }] }; },
  async ad_add_missing(upn, names, acct, commit) {
    if (!commit) return { ok: true, committed: false, would_add: names, skipped: [] };
    return { ok: true, committed: true, would_add: names, skipped: [], added: names, failed: [], unverified: [], who: "BG\\" + (acct || "adm"), dc: "BGDALDCRW02" };
  },
  async ad_user_search(q, all) { q = (q || "").toLowerCase(); return { ok: true, users: this._adu.filter(u => (u.name + u.sam).toLowerCase().includes(q)) }; },
  async ad_perm_compare(a, b) { const s = this._adgl(a), d = this._adgl(b), dn = new Set(d.map(x => x.dn)), sn = new Set(s.map(x => x.dn));
    return { ok: true, src_count: s.length, dst_count: d.length, only_src: s.filter(x => !dn.has(x.dn)), only_dst: d.filter(x => !sn.has(x.dn)), both: s.filter(x => dn.has(x.dn)) }; },
  async ad_perm_copy(a, b, dns, acct, commit) { const names = dns.map(x => x.split(",")[0].slice(3));
    if (!commit) return { ok: true, committed: false, would_add: names, skipped: [] };
    (this._adg[b] = this._adg[b] || []).push(...names.map(n => [n, false])); return { ok: true, committed: true, would_add: names, skipped: [], added: names, failed: [], unverified: [], who: "BG\\" + (acct || "adm") }; },
  _mfaPeople: null,
  async mfa_people_get() { return { ok: true, data: this._mfaPeople }; },
  async mfa_people_refresh() {
    const by = {}; (this._use || []).forEach(r => { if (r.user) (by[r.user.toLowerCase()] = by[r.user.toLowerCase()] || { user: r.user, devices: [] }).devices.push({ serial: r.serial, name: r.device_name }); });
    const people = Object.values(by).map((p, i) => ({ ...p, name: p.user.split("@")[0].replace(/\./g, " "), mfa: i % 3 === 2 ? "No" : "Yes", capable: true, methods: i % 3 === 2 ? [] : ["microsoftAuthenticatorPush", "mobilePhone"], default: "microsoftAuthenticatorPush", updated: "2026-09-20" }));
    this._mfaPeople = { people, source: "report", yes: people.filter(p => p.mfa === "Yes").length, no: people.filter(p => p.mfa === "No").length, unknown: 0, generated_at: new Date().toISOString(), by: "Demo User" };
    return { ok: true, data: this._mfaPeople };
  },
  async bulk_audit() { return { ok: true }; },
  _deviceDates: {},
  async device_dates_get() { return { ok: true, data: this._deviceDates }; },
  async device_dates_set(serials, deploy, mfg) {
    (serials || []).forEach(s => { const k = String(s).toLowerCase(), cur = { ...(this._deviceDates[k] || {}) };
      if (deploy !== null && deploy !== undefined) { if (deploy) cur.deploy = deploy; else delete cur.deploy; }
      if (mfg !== null && mfg !== undefined) { if (mfg) cur.mfg = mfg; else delete cur.mfg; }
      this._deviceDates[k] = cur; });
    return { ok: true, data: this._deviceDates };
  },
  async open_mailto(to, subject, body) { console.log("mailto", to, subject); return { ok: true }; },
  async issue_counts() { return { ok: true, new: this._issues.filter(d => d.status === "new").length, updates: 1, triage: true }; },
  async get_update_info() { return { ok: true, current: "2026.10.01", latest: "", min: "", update_available: false, update_required: false }; },
  async get_my_role() { return { ok: true, role: "super", sections: ["models", "links", "access", "sites", "sql", "perms", "storage"] }; },
  async get_role_access() {
    return { ok: true, super_admin: true, matrix: JSON.parse(JSON.stringify(this._ra)),
      sections: [["models", "Model departments"], ["links", "NBT Sites"], ["access", "Who has access"], ["sites", "Sites"], ["sql", "Directory & SQL"], ["perms", "Group baselines"], ["storage", "Storage"]].map(([id, label]) => ({ id, label })) };
  },
  async save_role_access(m) { this._ra = { user: [...(m.user || [])], admin: [...(m.admin || [])] }; return { ok: true, matrix: this._ra }; },
  async intune_categories() { return { ok: true, categories: ["NBGTX", "NBGW", "Shared Devices"] }; },
  async sql_discover(server, db) {
    await new Promise(r => setTimeout(r, 250));
    if (!server) return { ok: false, error: "Server name has unexpected characters." };
    return { ok: true, items: db ? ["dbo.WeekLocked", "dbo.SAP_Interface", "dbo.Employees"] : ["NBSTimesheet", "NBSEmployeeInfo"] };
  },
  /* data mode - mirrors Api.get_data_mode / pull_prod_snapshot / set_data_mode */
  _dm: { mode: "live", snap: "" },
  async get_data_mode() { return { ok: true, mode: this._dm.mode, has_snapshot: !!this._dm.snap, snapshot: { taken_at: this._dm.snap, counts: {} } }; },
  async pull_prod_snapshot() { this._dm.snap = new Date().toISOString().slice(0, 19); return { ok: true, taken_at: this._dm.snap, counts: {} }; },
  async set_data_mode(m) { if (m === "local" && !this._dm.snap) return { ok: false, error: "No local snapshot yet." }; this._dm.mode = m; return { ok: true, mode: m }; },
  /* divisions (tenants) - mirrors Api.get_divisions / switch_division */
  _divCur: "nbgw",
  async get_divisions() {
    return { ok: true, current: this._divCur, divisions: [
      { id: "nbgw", name: "NBGW - Nucor Buildings Group West", company_name: "Nucor Buildings Group West", sites: [{ code: "LTR", name: "Lathrop, CA" }, { code: "BRI", name: "Brigham City, UT" }] },
      { id: "nbgtx", name: "NBGTX - NBG Terrell", company_name: "NBG - Terrell", sites: [{ code: "TER", name: "Terrell, TX" }] },
    ] };
  },
  async switch_division(id) { this._divCur = id; return { ok: true, current: id }; },
  _hubConfig: null,
  _hubSetups: [
    { id: "computer-demo-01", type: "computer", dept: "Shop", subject: "NBGW-DEMO-01", tech: "Demo User", checks: { "0_0": true, "0_1": true }, notes: {}, done: 4, total: 20, pct: 20, status: "in-progress", createdAt: "2026-07-20T15:00:00Z", updatedAt: "2026-07-21T16:00:00Z", updatedBy: "Demo User" },
    { id: "user-demo-02", type: "user", dept: null, subject: "Smith, Jane", tech: "Demo User", checks: {}, notes: {}, done: 24, total: 24, pct: 100, status: "complete", createdAt: "2026-07-19T12:00:00Z", updatedAt: "2026-07-19T13:30:00Z", updatedBy: "Demo User" },
  ],
  _hubChanges: [{ when: "2026-07-20T10:00:00Z", user: "Demo User", action: "save", target: "Shop", detail: "1 section, 13 items" }],
  _hubFeedback: [{ id: "fb-1", type: "feature", title: "Add printer presets", detail: "Prefill printers per site.", status: "open", by: "Demo User", at: "2026-07-20T09:00:00Z" }],
  async hub_whoami() { return { ok: true, user: "Demo User (mock)", logsPath: "(mock shared folder)" }; },
  _hubTemplate: null,
  async hub_get_config() { return { ok: true, config: this._hubConfig, seed: this._hubTemplate }; },
  async hub_get_template_config() { return { ok: true, config: this._hubTemplate }; },
  async hub_save_template_config(cfg) { this._hubTemplate = cfg; return { ok: true }; },
  async hub_save_config(cfg) { this._hubConfig = cfg; return { ok: true }; },
  _deptData: {
    departments: ["Detailing", "Engineering", "Sales", "Shared"],
    map: { "Latitude 5540": "Detailing", "ThinkPad T14 G4": "Engineering", "Latitude 5440": "Shared" },
  },
  async hub_get_departments() { return { ok: true, data: this._deptData }; },
  async hub_save_departments(data) { this._deptData = data; return { ok: true }; },
  _sitesData: null,   // null -> Sites uses its built-in DEFAULTS on first load
  async hub_get_sites() { return { ok: true, data: this._sitesData }; },
  async hub_save_sites(data) { this._sitesData = data; return { ok: true }; },
  async hub_get_setups() { return { ok: true, setups: this._hubSetups.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) }; },
  async hub_save_setup(entry) {
    const i = this._hubSetups.findIndex(s => s.id === entry.id);
    entry.updatedAt = new Date().toISOString(); entry.updatedBy = "Demo User"; entry.createdAt = entry.createdAt || entry.updatedAt;
    if (i >= 0) this._hubSetups[i] = entry; else this._hubSetups.unshift(entry);
    return { ok: true, where: "(mock)", id: entry.id };
  },
  _reservations() {
    const out = {};
    (this._hubSetups || []).forEach(s => {
      if (s.type !== "computer") return;
      const serial = (s.reservedSerial || "").trim();
      if (serial) out[serial] = { setup_id: s.id, subject: s.subject || "", dept: s.reservedDept || "", model: s.reservedModel || "", site: s.reservedSite || "" };
    });
    return out;
  },
  async reservation_options(excludeSetupId) {
    const reserved = this._reservations();
    const by_dept = {};
    this._stock.forEach(r => {
      const serial = (r.serial || "").trim(); if (!serial) return;
      const resv = reserved[serial];
      if (resv && resv.setup_id !== excludeSetupId) return;
      const dep = (this._deptData.map || {})[(r.model || "").trim()] || "Unassigned";
      (by_dept[dep] = by_dept[dep] || []).push({ serial, model: r.model || "", site: r.site_tag || "" });
    });
    return { ok: true, by_dept };
  },
  _hotSpares: [
    { id: "hs-1", serial: "C02XL9ZZAA1", hostname: "BGLTRSPARE01", site: "LTR", dept: "Detailing", notes: "IT closet — top shelf. Imaged 2026-05, needs re-sync.", added_by: "Demo User", added_at: "2026-08-10T09:00:00Z", updated_by: "Demo User", updated_at: "2026-08-10T09:00:00Z" },
    { id: "hs-2", serial: "PF3ABCD01", hostname: "", site: "BRI", dept: "Engineering", notes: "Loaner cart B, dock included.", added_by: "Demo User", added_at: "2026-08-12T10:00:00Z", updated_by: "Demo User", updated_at: "2026-08-12T10:00:00Z" },
    { id: "hs-3", serial: "NOEXIST123", hostname: "BGLTRSPARE09", site: "LTR", dept: "Other", notes: "Estimating spare — awaiting re-image.", added_by: "Demo User", added_at: "2026-08-14T08:00:00Z", updated_by: "Demo User", updated_at: "2026-08-14T08:00:00Z" },
  ],
  _enrichHotSpares() {
    const sp = {};
    this._use.forEach(r => { const s = (r.serial || "").toUpperCase(); if (s) sp[s] = [r, "In Use"]; });
    this._stock.forEach(r => { const s = (r.serial || "").toUpperCase(); if (s && !sp[s]) sp[s] = [r, "In Stock"]; });
    const compMap = { "C02XL9ZZAA1": "compliant", "PF3ABCD01": "noncompliant" };  // mock Intune compliance
    const today = new Date();
    return (this._hotSpares || []).map(hs => {
      const su = (hs.serial || "").toUpperCase(), pair = sp[su] || [null, null], r = pair[0] || {}, src = pair[1];
      const last_checkin = r.last_checkin || "", lc = last_checkin.slice(0, 10);
      let stale_days = null;
      if (lc) stale_days = Math.round((today - new Date(lc + "T00:00:00")) / 86400000);
      const compliance = compMap[su] || "";
      return {
        id: hs.id, serial: hs.serial, hostname: hs.hostname || r.device_name || "",
        site: (hs.site || "").toUpperCase(), dept: hs.dept || "Other", notes: hs.notes || "",
        added_by: hs.added_by || "Demo User", added_at: hs.added_at || "",
        updated_by: hs.updated_by || hs.added_by || "Demo User", updated_at: hs.updated_at || "",
        model: r.model || "", cpu: r.cpu || "", ram: r.ram || "", storage: r.storage || "",
        os_version: r.os_version || "", os_install: r.os_install || "", last_checkin, warranty: r.warranty || "",
        compliance, stale: stale_days != null && stale_days > 30, stale_days,
        noncompliant: !["", "compliant", "unknown", "configmanager"].includes(compliance.toLowerCase()),
        found_in: r.serial ? src : (compliance ? "Intune" : "Not found"),
      };
    });
  },
  async get_hot_spares() { return { ok: true, spares: this._enrichHotSpares() }; },
  async add_hot_spare(entry) {
    const id = "hs-" + Date.now();
    this._hotSpares.push({ id, ...entry, site: (entry.site || "").toUpperCase(), added_by: "Demo User", added_at: new Date().toISOString(), updated_by: "Demo User", updated_at: new Date().toISOString() });
    return { ok: true, id };
  },
  async update_hot_spare(id, fields) {
    const it = this._hotSpares.find(s => s.id === id);
    if (!it) return { ok: false, error: "Hot spare not found." };
    Object.assign(it, fields, { site: (fields.site || it.site || "").toUpperCase(), updated_by: "Demo User", updated_at: new Date().toISOString() });
    return { ok: true };
  },
  async remove_hot_spare(id) { this._hotSpares = this._hotSpares.filter(s => s.id !== id); return { ok: true }; },
  async locate_devices(devices) {
    await new Promise(r => setTimeout(r, 400));   // simulate the lookup latency
    const out = (devices || []).map((d, i) => {
      const inAd = i % 2 === 0, inEntra = i % 3 !== 0, inIntune = i % 4 !== 0;
      return { serial: d.serial, hostname: d.hostname,
        in_ad: inAd, ad_enabled: inAd, ad_last_logon: inAd ? "2026-06-01" : "",
        in_entra: inEntra, entra_enabled: inEntra, entra_last_signin: inEntra ? "2026-07-15" : "",
        in_intune: inIntune, intune_last_sync: inIntune ? "2026-07-20" : "" };
    });
    return { ok: true, devices: out, entra_state: "on", intune_ok: true, ad_error: null, ad_domain: "bg.nucorsteel.local" };
  },
  async hub_cancel_setup(setupId, reason) {
    this._hubSetups = this._hubSetups.filter(s => s.id !== setupId);
    let reverted = false;
    (this._upgrades || []).forEach(it => { if (it.setup_id === setupId) { it.status = ""; it.setup_id = ""; it.started_by = ""; it.started_at = ""; reverted = true; } });
    return { ok: true, reverted };
  },
  _upgrades: [
    { id: "up-mockA", serial: "PF3AB99KK", device_name: "BGBRILT021", model: "ThinkPad T14 G3", user: "s.bhatt@nucor.com", site: "BRI", priority: 5, notes: "RAM to 32GB + SSD", added_by: "Demo User", added_at: "2026-07-30T10:00:00Z" },
    { id: "up-mockB", serial: "C02XL2BBQQ2", device_name: "BGLTRLT014", model: "Latitude 5440", user: "j.ramirez@nucor.com", site: "LTR", priority: 3, notes: "Slow — evaluate replacement", added_by: "Demo User", added_at: "2026-08-01T09:00:00Z" },
    { id: "up-mockC", serial: "PF5NOSITE", device_name: "BGPF5NOSITE", model: "ThinkPad X1", user: "no.city@nucor.com", site: "", priority: 2, notes: "", added_by: "Demo User", added_at: "2026-08-02T09:00:00Z" },
  ],
  _upLog: [],
  async hub_get_upgrades() { return { ok: true, data: { items: this._upgrades }, log: { entries: this._upLog } }; },
  async hub_add_upgrade(device, priority, notes) {
    device = device || {};
    const serial = (device.serial || "").trim();
    let pr = parseInt(priority, 10); if (isNaN(pr)) pr = 3; pr = Math.max(1, Math.min(5, pr));
    const site = (device.site || device.site_tag || "").trim();
    const ex = this._upgrades.find(x => (x.serial || "").toLowerCase() === serial.toLowerCase());
    if (ex) { ex.priority = pr; if (notes) ex.notes = notes; if (site) ex.site = site; }
    else {
      const rec = { id: "up-" + Date.now(), serial, device_name: device.device_name || "", model: device.model || "", user: device.user || "", site, priority: pr, notes: notes || "", added_by: "Demo User", added_at: new Date().toISOString() };
      const bucket = s => { const u = (s || "").trim().toUpperCase(); return u === "LTR" ? "LTR" : u === "BRI" ? "BRI" : "Other"; };
      let at = this._upgrades.length;
      for (let i = 0; i < this._upgrades.length; i++) { if (bucket(this._upgrades[i].site) === bucket(site) && (this._upgrades[i].priority || 3) < pr) { at = i; break; } }
      this._upgrades.splice(at, 0, rec);
    }
    return { ok: true, items: this._upgrades };
  },
  async hub_save_upgrades(data) { this._upgrades = (data && data.items) || []; return { ok: true, items: this._upgrades }; },
  async hub_update_upgrade(id, priority, notes) {
    const it = this._upgrades.find(x => x.id === id);
    if (it) {
      if (priority != null) it.priority = Math.max(1, Math.min(5, parseInt(priority, 10) || it.priority));
      if (notes != null) it.notes = notes;
      it.updated_by = "Demo User"; it.updated_at = new Date().toISOString();
      (it.history = it.history || []).push({ at: it.updated_at, by: "Demo User", action: "updated", priority: it.priority, notes: it.notes });
    }
    return { ok: true, items: this._upgrades };
  },
  async hub_begin_upgrade(id, setupId) {
    const it = this._upgrades.find(x => x.id === id);
    if (it) { it.status = "working"; it.started_by = "Demo User"; it.started_at = new Date().toISOString(); it.setup_id = setupId; }
    return { ok: true, items: this._upgrades };
  },
  async hub_bulk_upgrades(action, ids, priority, site) {
    const want = new Set(ids || []); const hit = this._upgrades.filter(x => want.has(x.id));
    if (action === "priority") hit.forEach(x => { x.priority = +priority; });
    else if (action === "site") hit.forEach(x => { x.site = site; });
    else if (action === "complete" || action === "remove") this._upgrades = this._upgrades.filter(x => !want.has(x.id));
    return { ok: true, items: this._upgrades, done: hit.length };
  },
  async hub_remove_upgrade(id) { this._upgrades = this._upgrades.filter(x => x.id !== id); return { ok: true, items: this._upgrades }; },
  async hub_complete_upgrade(id) {
    const rec = this._upgrades.find(x => x.id === id);
    this._upgrades = this._upgrades.filter(x => x.id !== id);
    if (rec) this._upLog.unshift({ ...rec, completed_by: "Demo User", completed_at: new Date().toISOString() });
    return { ok: true, items: this._upgrades };
  },
  _software: {
    apps: [
      { name: "Google Chrome", version: "127.0", publisher: "Google LLC", installs: [
        { device: "BGLTRLT014", serial: "C1", user: "j.ramirez@nucor.com", site: "LTR", dept: "Detailing" },
        { device: "BGLTRDET2", serial: "C2", user: "dana.roe@nucor.com", site: "LTR", dept: "Detailing" },
        { device: "BGBRILT021", serial: "C3", user: "s.bhatt@nucor.com", site: "BRI", dept: "Engineering" }] },
      { name: "Tekla Structures 2023", version: "24.0", publisher: "Trimble", installs: [
        { device: "BGLTRLT014", serial: "C1", user: "j.ramirez@nucor.com", site: "LTR", dept: "Detailing" }] },
      { name: "Bluebeam Revu", version: "21", publisher: "Bluebeam", installs: [
        { device: "BGBRILT021", serial: "C3", user: "s.bhatt@nucor.com", site: "BRI", dept: "Engineering" }] },
      // Same app, 3 releases — latest is 26.08.11.00 (only dana.roe has it), so j.ramirez
      // counts as missing on the dashboard even though he has an older build.
      { name: "NBG Design Cost Model", version: "26.06.09.05", publisher: "Nucor Buildings Group", installs: [
        { device: "BGLTRLT014", serial: "C1", user: "j.ramirez@nucor.com", site: "LTR", dept: "Detailing" }] },
      { name: "NBG Design Cost Model", version: "26.07.09.00", publisher: "Nucor Buildings Group", installs: [
        { device: "BGLTRLT014", serial: "C1", user: "j.ramirez@nucor.com", site: "LTR", dept: "Detailing" }] },
      { name: "NBG Design Cost Model", version: "26.08.11.00", publisher: "Nucor Buildings Group", installs: [
        { device: "BGLTRDET2", serial: "C2", user: "dana.roe@nucor.com", site: "LTR", dept: "Detailing" }] },
    ],
    users: [
      { user: "j.ramirez@nucor.com", site: "LTR", dept: "Detailing" },
      { user: "dana.roe@nucor.com", site: "LTR", dept: "Detailing" },
      { user: "s.bhatt@nucor.com", site: "BRI", dept: "Engineering" }],
    devices: 3, has_dept: true, generated_at: "2026-08-07T10:00:00Z",
  },
  _softwareRules: { rules: [{ app: "Tekla Structures 2023", scope: "Detailing", required: true, set_by: "Demo User", set_at: "2026-08-12T10:00:00Z" }] },
  async software_get() { return { ok: true, data: this._software, rules: this._softwareRules }; },
  async software_refresh() { await new Promise(r => setTimeout(r, 300)); this._software.generated_at = new Date().toISOString(); return { ok: true, apps: this._software.apps.length, devices: this._software.devices, generated_at: this._software.generated_at, has_dept: true }; },
  async software_save_rules(rules) {
    const auto = rules && rules.auto ? { top: +rules.auto.top, min_pct: +rules.auto.min_pct, min_people: +rules.auto.min_people } : this._softwareRules.auto;
    this._softwareRules = { rules: (rules && rules.rules) || [], ...(auto ? { auto } : {}) };
    return { ok: true, rules: this._softwareRules.rules, auto };
  },
  async hub_get_changes() { return { ok: true, changes: this._hubChanges }; },
  async hub_get_feedback() { return { ok: true, feedback: this._hubFeedback }; },
  async hub_add_feedback(item) { this._hubFeedback.unshift({ ...item, id: "fb-" + Date.now(), status: "open", by: "Demo User", at: new Date().toISOString() }); return { ok: true }; },
  async hub_open_folder() { return { ok: true }; },
  async hub_storage_info() { return { ok: true, path: "C:\\Users\\demo\\OneDrive - Nucor\\NBG Hub\\SystemsData", hub: "C:\\Users\\demo\\OneDrive - Nucor\\NBG Hub\\SystemsData\\_EndpointHub", source: "default", app_dir: "C:\\Users\\demo\\OneDrive - Nucor\\NBG Hub", exists: true, shared: true, pinned: false }; },
  async get_dashboard() {
    const total = this._hubSetups.length, complete = this._hubSetups.filter(s => s.status === "complete").length;
    // Reserved-by-setup stock drops out of the stock rollups (mirrors app.py).
    const _resv = this._reservations();
    const _reservedSet = new Set(Object.keys(_resv));
    const _reservedDevs = this._stock.filter(r => _reservedSet.has((r.serial || "").trim()))
      .map(r => ({ serial: r.serial, model: r.model, site: r.site_tag || "", subject: (_resv[r.serial] || {}).subject || "", dept: (_resv[r.serial] || {}).dept || "" }));
    // hot spares are also held out of the deployable stock rollups (mirrors app.py)
    const _hotSet = new Set((this._hotSpares || []).map(h => (h.serial || "").trim().toUpperCase()).filter(Boolean));
    const _stock = this._stock.filter(r => !_reservedSet.has((r.serial || "").trim()) && !_hotSet.has((r.serial || "").trim().toUpperCase()));
    const machines = _stock.concat(this._use), today = new Date();
    const wb = { expired: 0, d0_30: 0, d31_90: 0, d91_180: 0, beyond: 0, none: 0 }, up = [];
    machines.forEach(m => {
      const v = (m.warranty || "").slice(0, 10), dt = v ? new Date(v + "T00:00:00") : null;
      if (!dt || isNaN(dt)) { wb.none++; return; }
      const days = Math.round((dt - today) / 86400000);
      if (days < 0) wb.expired++; else if (days <= 30) wb.d0_30++; else if (days <= 90) wb.d31_90++;
      else if (days <= 180) wb.d91_180++; else wb.beyond++;
      if (days <= 180) up.push({ serial: m.serial, model: m.model, warranty: v, days });
    });
    up.sort((a, b) => a.days - b.days);
    wb.expiring_90 = wb.d0_30 + wb.d31_90; wb.upcoming = up.slice(0, 6);
    const NBGW = new Set(["LTR", "BRI"]);
    const notNbgw = this._use.filter(r => { const s = (r.site_tag || "").trim(); return s && !NBGW.has(s.toUpperCase()); })
      .map(r => ({ serial: r.serial, model: r.model, user: r.user, office: r.site_tag }));
    const byOffice = notNbgw.reduce((m, r) => { m[r.office] = (m[r.office] || 0) + 1; return m; }, {});
    const noUpn = this._use.filter(r => !(r.user || "").trim())
      .map(r => ({ serial: r.serial, device_name: r.device_name || "", model: r.model, site: r.site_tag || "", source: "In Use" }));
    // tag each machine with the list it lives in, so drills spanning both show Source
    const tagged = _stock.map(m => ({ m, src: "In Stock" })).concat(this._use.map(m => ({ m, src: "In Use" })));
    const warrantySoon = tagged.map(t => ({ ...t, v: (t.m.warranty || "").slice(0, 10) }))
      .map(x => ({ ...x, dt: x.v ? new Date(x.v + "T00:00:00") : null }))
      .filter(x => x.dt && !isNaN(x.dt) && Math.round((x.dt - today) / 86400000) <= 90)
      .map(x => ({ serial: x.m.serial, model: x.m.model, user: x.m.user || "", warranty: x.v, days: Math.round((x.dt - today) / 86400000), source: x.src }))
      .sort((a, b) => a.days - b.days);
    const ty = today.getFullYear();
    const _missing = Mock._use.concat(Mock._stock).filter(r => !r.cpu || !r.ram).map(r => ({ serial: r.serial, device_name: r.device_name || "", model: r.model, manufacturer: r.manufacturer, user: r.user || "", missing: [!r.cpu ? "CPU" : null, !r.ram ? "RAM" : null].filter(Boolean), source: r.user ? "In Use" : "In Stock" }));
    const needsUp = tagged.map(t => ({ ...t, y: cpuReleaseYear(t.m.cpu) }))
      .filter(x => x.y && (ty - x.y) >= 5)
      .map(x => ({ serial: x.m.serial, model: x.m.model, cpu: x.m.cpu, user: x.m.user || "", year: x.y, age: ty - x.y, source: x.src }))
      .sort((a, b) => a.year - b.year || a.serial.localeCompare(b.serial));
    const staleCk = tagged.map(t => ({ ...t, d: (t.m.last_checkin || "").slice(0, 10) }))
      .filter(x => x.d)
      .map(x => ({ ...x, days: Math.round((today - new Date(x.d + "T00:00:00")) / 86400000) }))
      .filter(x => x.days > 30)
      .map(x => ({ serial: x.m.serial, device_name: x.m.device_name || "", model: x.m.model, user: x.m.user || "", last_checkin: x.d, days: x.days, source: x.src }))
      .sort((a, b) => b.days - a.days);
    const noMfa = this._use.filter(r => r.mfa === "No")
      .map(r => ({ serial: r.serial, device_name: r.device_name || "", model: r.model, user: r.user || "", source: "In Use" }));
    return { ok: true, signed_in: true, account: "Demo User (mock)",
      setups: { total, complete, in_progress: total - complete,
        computer: this._hubSetups.filter(s => s.type === "computer").length,
        user: this._hubSetups.filter(s => s.type === "user").length,
        recent: this._hubSetups.slice(0, 8), open_feedback: this._hubFeedback.length },
      inventory: { new_stock: _stock.length, in_use: this._use.length, total: _stock.length + this._use.length,
        by_site: this._use.reduce((m, r) => { const t = r.site_tag || "—"; m[t] = (m[t] || 0) + 1; return m; }, {}),
        stock_by_site: _stock.reduce((m, r) => { const t = r.site_tag || "—"; m[t] = (m[t] || 0) + 1; return m; }, {}),
        stock_by_dept: _stock.reduce((m, r) => { const d = (this._deptData.map || {})[(r.model || "").trim()] || "Unassigned"; m[d] = (m[d] || 0) + 1; return m; }, {}),
        stock_by_dept_site: _stock.reduce((m, r) => {
          const d = (this._deptData.map || {})[(r.model || "").trim()] || "Unassigned";
          const s = (r.site_tag || "").trim().toUpperCase(), k = (s === "LTR" || s === "BRI") ? s : "Other";
          (m[d] = m[d] || {})[k] = (m[d][k] || 0) + 1; return m;
        }, {}),
        warranty: wb,
        not_nbgw_count: notNbgw.length, not_nbgw: notNbgw, not_nbgw_by_office: byOffice,
        no_upn_count: noUpn.length, no_upn: noUpn, warranty_soon: warrantySoon,
        needs_upgrade_count: needsUp.length, needs_upgrade: needsUp.map(d => ({ ...d, reasons: ["processor released " + d.year + " (" + d.age + " yrs old)"], priority: Math.max(1, Math.min(5, d.age - 3)) })),
        upgrade_rules: { cpu_years: 5, warranty_months: 0 },
        missing_specs_count: _missing.length, missing_specs: _missing,
        stale_checkin_count: staleCk.length, stale_checkin: staleCk,
        no_mfa_count: noMfa.length, no_mfa: noMfa,
        reserved_count: _reservedDevs.length, reserved: _reservedDevs,
        hot_spares: this._enrichHotSpares() } };
  },
});

// mock only: spread demo warranty dates so the dashboard chart is illustrative
(function () {
  const d = n => { const x = new Date(); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
  if (Mock._stock[0]) Mock._stock[0].warranty = d(-40);   // expired
  if (Mock._stock[1]) Mock._stock[1].warranty = d(18);    // <= 30 days
  if (Mock._stock[2]) Mock._stock[2].warranty = d(60);    // 31-90 days
  if (Mock._use[0]) Mock._use[0].warranty = d(140);       // 91-180 days
  if (Mock._use[1]) Mock._use[1].warranty = d(400);       // > 180 days
  // a couple of non-NBGW users (office location instead of LTR/BRI) for the drill-down
  Mock._use.push({ serial: "9CZ2NB1", device_name: "PHXENGR07", manufacturer: "Dell", model: "Latitude 7440",
    user: "pat.lee@nucor.com", site_tag: "Charlotte, NC", cpu: "Intel Core i7-1365U", ram: "16 GB", storage: "512 GB",
    warranty: d(300), os_version: "10.0.22631", os_install: "2026-02-01T00:00:00Z" });
  Mock._use.push({ serial: "7KM4NB2", device_name: "SLCADMIN02", manufacturer: "Lenovo", model: "ThinkPad T14",
    user: "dana.roe@nbsut.com", site_tag: "Salt Lake City, UT", cpu: "AMD Ryzen 7", ram: "32 GB", storage: "1 TB",
    warranty: d(500), os_version: "10.0.26100", os_install: "2026-03-01T00:00:00Z" });
  // a couple of aging machines so "Needs upgrade" has data in preview
  Mock._use.push({ serial: "OLD8650", device_name: "BGLTROLDPC01", manufacturer: "Dell", model: "Latitude 7490",
    user: "sam.older@nucor.com", site_tag: "LTR", cpu: "Intel Core i7-8650U", ram: "16 GB", storage: "256 GB",
    warranty: d(-200), os_version: "10.0.19045", os_install: "2019-05-01T00:00:00Z" });
  Mock._use.push({ serial: "OLD4500", device_name: "BGBRIOLDPC02", manufacturer: "Lenovo", model: "ThinkPad E14 G2",
    user: "pat.older@nucor.com", site_tag: "BRI", cpu: "AMD Ryzen 5 4500U", ram: "8 GB", storage: "256 GB",
    warranty: d(-30), os_version: "10.0.19045", os_install: "2020-08-01T00:00:00Z" });
})();

/* ---- boot ---------------------------------------------------------------- */
let _started = false;
// Re-read the shared files so an already-open app picks up what OTHER users have
// saved (setups, upgrade list). Skips while a modal is open or a drag is happening
// so it never clobbers an in-progress edit. Runs on a timer + when the window regains
// focus. The devices/inventory live in SharePoint Lists; the setups & upgrade list
// live in the shared _EndpointHub folder — this keeps everyone's view in sync.
function refreshShared() {
  const mr = document.getElementById("modalRoot");
  if (mr && mr.innerHTML.trim()) return;                 // don't disturb an open dialog
  if (document.querySelector(".up-row.dragging")) return; // mid drag-reorder
  const active = (document.querySelector(".appview.active") || {}).id || "";
  try {
    if (active === "appview-dashboard") Dashboard.load();
    else if (active === "appview-upgrades") Upgrade.load();
    else if (active === "appview-hub") Hub.renderActivity();
  } catch (e) {}
}
async function _boot(real) {
  if (_started) return; _started = true;
  Backend.real = real;
  /* Nothing reads data until sign-in is settled and the division is known: the signed-in account decides
     which divisions it may see, and every list/hub read is scoped by the active division. */
  let st = null;
  try {
    st = await Backend.call("get_status");                       // silent sign-in
    if (st && st.signed_in) { await Divisions.load(); Resume.apply(); }
  } catch (e) {}
  Hub.boot();
  Sites.boot();
  Depts.load();
  Dashboard.load();
  App.init(real, st);
  setInterval(refreshShared, 45000);
  window.addEventListener("focus", refreshShared);
  setInterval(() => Badges.refresh(), 60000);
  window.addEventListener("focus", () => Badges.refresh());
  setTimeout(() => Badges.refresh(), 2500);
}
window.addEventListener("pywebviewready", () => _boot(true));
window.addEventListener("load", () => setTimeout(() => { if (!_started) _boot(false); }, 300));
