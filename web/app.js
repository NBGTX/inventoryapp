"use strict";

/* ---- helpers ------------------------------------------------------------- */
const esc = s => (s == null ? "" : String(s)).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const attr = s => (s == null ? "" : String(s)).replace(/&/g, "&amp;").replace(/"/g, "&quot;");


/* ---- backend bridge: real pywebview API, or a mock for browser preview ---- */
const Backend = {
  real: false,
  async call(method, ...args) {
    if (this.real && window.pywebview && window.pywebview.api && window.pywebview.api[method]) {
      return await window.pywebview.api[method](...args);
    }
    return await Mock[method](...args);
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
  async get_status() { return { ok: true, signed_in: true, account: "Demo User (mock data)" }; },
  async sign_in() { return { ok: true, account: "Demo User (mock data)" }; },
  async sign_out() { return { ok: true }; },
  async app_version() { return { ok: true, version: "2026.09.29" }; },
  async register_client() { return { ok: true, version: "2026.09.29" }; },
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
      return s.ok ? location.reload() : alert(s.error);
    }
    const snap = r.has_snapshot ? (r.snapshot.taken_at || "").replace("T", " ") : "";
    if (r.has_snapshot && confirm("Switch to the LOCAL copy taken " + snap + "?\nWrites stay on this PC; production is not touched.\n\nCancel = pull a fresh copy instead.")) {
      const s = await Backend.call("set_data_mode", "local");
      return s.ok ? location.reload() : alert(s.error);
    }
    if (!confirm("Pull a fresh READ-ONLY copy of production into this PC?\n(Replaces the existing local copy and any local changes.)")) return;
    const b = document.getElementById("dmBtn"); if (b) b.textContent = "Data: pulling…";
    const p = await Backend.call("pull_prod_snapshot");
    if (!p.ok) { alert("Pull failed: " + p.error); return this.refresh(); }
    if (confirm("Copy ready. Switch to LOCAL data now?")) {
      const s = await Backend.call("set_data_mode", "local");
      return s.ok ? location.reload() : alert(s.error);
    }
    this.refresh();
  },
};

/* ---- master settings (super admin, above divisions) ----------------------- */
const MasterSettings = {
  async refresh() {
    const r = await Backend.call("get_master_settings");
    const b = document.getElementById("msBtn");
    if (b) b.classList.toggle("hidden", !(r && r.ok && r.super_admin));
  },
  async open() {
    const r = await Backend.call("get_master_settings");
    if (!r || !r.ok || !r.super_admin) return App.toast((r && r.error) || "Super admin only.", true);
    const rows = r.settings.map((x, i) => `<tr>
        <td>${esc(x.key)}${x.secret ? " <span class='ms-tag'>secret</span>" : ""}</td>
        <td>${x.secret ? (x.is_set ? "•••••• (set)" : "(not set)") : esc(x.value)}</td>
        <td><button class="ghost" onclick="MasterSettings.edit(${i})">Change</button></td></tr>`).join("");
    this._rows = r.settings;
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal" style="width:640px;max-width:94vw;">
        <div class="modal-head"><h3>Master settings (all divisions)</h3><button onclick="MasterSettings.close()">&times;</button></div>
        <div class="modal-body">
          <p style="margin-top:0;color:var(--muted);font-size:13px;">Stored in the central Master Settings list. Secret values are never shown here. Anyone who can run the app can use them.</p>
          <table class="ms-table"><tr><th>Setting</th><th>Value</th><th></th></tr>${rows || "<tr><td colspan='3'>No settings yet.</td></tr>"}</table>
        </div>
        <div class="modal-foot"><button class="ghost" onclick="MasterSettings.edit(-1)">Add setting</button><button class="primary" onclick="MasterSettings.close()">Close</button></div>
      </div></div>`;
  },
  close() { document.getElementById("modalRoot").innerHTML = ""; },
  async edit(i) {
    const cur = i >= 0 ? this._rows[i] : { key: "", secret: false, description: "" };
    const key = i >= 0 ? cur.key : prompt("Setting key (e.g. lenovo_client_id):");
    if (!key) return;
    const secret = i >= 0 ? cur.secret : confirm("Is this a secret (value hidden in this screen)?\nOK = secret, Cancel = normal.");
    const value = prompt("New value for " + key + (secret ? " (will not be shown again)" : "") + ":", secret ? "" : (cur.value || ""));
    if (value === null) return;
    const r = await Backend.call("set_master_setting", key.trim(), value, secret, cur.description || "");
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not save.", true);
    App.toast("Saved " + key);
    this.open();
  },
};

const App = {
  state: {
    tab: "stock", stock: [], use: [], boneyard: [], account: null, siteTags: ["LTR", "BRI"],
    sort: { stock: { key: "date_added", dir: -1 }, use: { key: "serial", dir: 1 }, boneyard: { key: "moved_at", dir: -1 } },
    expanded: new Set(),
  },

  async init(real) {
    Backend.real = real;
    this.loadVersion();
    DataMode.refresh();
    MasterSettings.refresh();
    document.getElementById("tableWrap").addEventListener("click", e => {
      const b = e.target.closest("button[data-action]");
      if (!b) return;
      if (b.dataset.action === "remove") DeleteView.open(b.dataset.serial);
      else if (b.dataset.action === "expand") App.toggleExpand(b.dataset.serial);
      else if (b.dataset.action === "upgrade") Upgrade.addPrompt(b.dataset.serial);
      else if (b.dataset.action === "editstock") App.editStock(b.dataset.serial);
      else if (b.dataset.action === "restoreboneyard") App.restoreBoneyard(b.dataset.serial);
    });
    const st = await Backend.call("get_status");
    if (st && st.signed_in) {
      this.state.account = st.account;
      document.getElementById("acct").textContent = st.account || "Signed in";
      document.getElementById("signout").classList.remove("hidden");
      await this.startup();
    } else {
      document.getElementById("signinBanner").classList.remove("hidden");
      this.setBusy(true);
    }
  },

  async startup() {
    this.renderCached();       // 1) instant: show last-known data from local cache
    await this.reload();       // 2) fast: re-read the SharePoint lists and repaint
    // 3) background: Intune sync (moves + backfill). Deferred a few seconds so it
    // doesn't hammer Graph alongside the dashboard/devices reads during first paint.
    setTimeout(() => this.backgroundSync(), 4000);
  },

  renderCached() {
    try {
      const c = JSON.parse(localStorage.getItem("nbgw_inv") || "null");
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

  async signIn() {
    const r = await Backend.call("sign_in");
    if (!r.ok) return this.error(r.error || "Sign-in failed.");
    document.getElementById("signinBanner").classList.add("hidden");
    this.state.account = r.account;
    document.getElementById("acct").textContent = r.account || "Signed in";
    document.getElementById("signout").classList.remove("hidden");
    this.setBusy(false);
    await this.startup();
    try { Dashboard.load(); } catch (e) {}
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
    this.setCounts(inv.counts);
    try { localStorage.setItem("nbgw_inv", JSON.stringify(inv)); } catch (e) { /* quota */ }
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
  },
  clearFilters() {
    ["fModel", "fCpu", "fRam", "fCheckin", "fMfa"].forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
    this.render();
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
    const q = (document.getElementById("search").value || "").trim().toLowerCase();
    const isUse = this.state.tab === "use";
    ["fModel", "fCpu", "fRam", "fCheckin", "fMfa", "fClear"].forEach(id => { const el = document.getElementById(id); if (el) el.classList.toggle("hidden", !isUse); });
    const val = id => { const el = document.getElementById(id); return el ? (el.value || "") : ""; };
    const fm = isUse ? val("fModel") : "";
    const fc = isUse ? val("fCpu") : "";
    const fr = isUse ? val("fRam") : "";
    const fk = isUse ? val("fCheckin") : "";
    const fmfa = isUse ? val("fMfa") : "";
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
      r.last_checkin, r.os_install, r.date_added,
    ].map(v => (v == null ? "" : String(v)).toLowerCase()).join(" ");
    const match = r => (!q || hay(r).includes(q))
      && (!fm || (r.model || "") === fm) && (!fc || (r.cpu || "") === fc) && (!fr || (r.ram || "") === fr) && checkinOk(r) && mfaOk(r);
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
    const siteOpts = r => {
      const opts = App.state.siteTags.slice();
      if (r.site_tag && !opts.includes(r.site_tag)) opts.unshift(r.site_tag);
      return opts.map(t => `<option ${t === r.site_tag ? "selected" : ""}>${esc(t)}</option>`).join("");
    };

    if (this.state.tab === "stock") {
      const rows = sortRows(this.state.stock.filter(match));
      if (!rows.length) return void (wrap.innerHTML = `<div class="empty">No machines in stock. Click “Add new machine”.</div>`);
      const exp = this.state.expanded;
      const detail = r => `<tr><td></td><td colspan="8" class="detailcell" style="padding:0 18px 14px;">
        <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px 24px;background:var(--darker);border:1px solid var(--border);border-radius:8px;padding:14px 16px;">
          ${dl("Serial number", r.serial)}${dl("Manufacturer", r.manufacturer)}${dl("Model", r.model)}
          ${dl("CPU", r.cpu)}${dl("RAM", r.ram)}${dl("Storage", r.storage)}
          ${dl("Warranty", r.warranty)}${dl("Date added", r.date_added)}
          <div><span style="color:var(--muted);font-size:11px;display:block">Site assignment</span>
            <select onchange="App.setSite('${attr(r.serial)}', this.value)" style="background:var(--darker);border:1px solid var(--border);border-radius:6px;padding:6px 8px;color:var(--text);font-size:13px;margin-top:2px;">${siteOpts(r)}</select></div>
        </div></td></tr>`;
      wrap.innerHTML = `<table class="fit">` +
        `<colgroup><col style="width:42px"><col style="width:12%"><col style="width:12%"><col style="width:16%"><col style="width:22%"><col style="width:8%"><col style="width:11%"><col style="width:11%"><col style="width:92px"></colgroup>` +
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
          <td>${esc(r.site_tag)}</td><td>${esc(r.warranty)}</td><td>${esc(r.date_added)}</td>
          <td style="text-align:right;white-space:nowrap">${act("✎", "editstock", r.serial, false, "Edit device")} ${act("✕", "remove", r.serial, true, "Remove")}</td></tr>` +
          (open ? detail(r) : "");
        }).join("") +
        `</tbody></table>`;
    } else if (this.state.tab === "boneyard") {
      const rows = sortRows((this.state.boneyard || []).filter(match));
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
      const rows = sortRows(this.state.use.filter(match));
      if (!rows.length) return void (wrap.innerHTML = `<div class="empty">No machines in use.</div>`);
      const exp = this.state.expanded;
      const mfaCell = v => v === "Yes"
        ? '<span style="color:#3ecf8e;font-weight:600">Yes</span>'
        : v === "No"
        ? '<span style="color:#ff6b6b;font-weight:600">No</span>'
        : '<span style="color:var(--muted)" title="MFA status unavailable — needs AuditLog.Read.All consent">—</span>';
      const detail = r => `<tr><td></td><td colspan="9" class="detailcell" style="padding:0 18px 14px;">
        <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px 24px;background:var(--darker);border:1px solid var(--border);border-radius:8px;padding:14px 16px;">
          ${dl("Device name", r.device_name)}${dl("Serial number", r.serial)}${dl("Primary user", r.user)}
          ${dl("Manufacturer", r.manufacturer)}${dl("Model", r.model)}${dl("Site tag", r.site_tag)}
          ${dl("CPU", r.cpu)}${dl("RAM", r.ram)}${dl("Storage", r.storage)}
          ${dl("OS version", winOsLabel(r.os_version))}${dl("OS install date", day(r.os_install))}${dl("Warranty", r.warranty)}
          ${dl("MFA registered", r.mfa || "—")}
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px;">
          <button class="rowbtn" onclick="HotSpares.openMove('${attr(r.serial)}')" title="Move back to In Stock and log as a ready hot spare (held out of the stock count)">🔥 Hot Spare</button>
          <button class="rowbtn" onclick="App.moveToStock('${attr(r.serial)}')" title="Move back to In Stock (clears the assigned user)">📦 In Stock</button>
        </div></td></tr>`;
      wrap.innerHTML = `<table class="fit">` +
        `<colgroup><col style="width:42px"><col style="width:11%"><col style="width:12%"><col style="width:15%"><col style="width:19%"><col style="width:6%"><col style="width:7%"><col style="width:10%"><col style="width:12%"><col style="width:96px"></colgroup>` +
        `<thead><tr>` +
        `<th></th>` +
        th("Serial number", "serial") + th("Manufacturer", "manufacturer") + th("Model", "model") +
        th("Assigned user", "user") + th("MFA", "mfa") + th("Site", "site_tag") + th("Warranty", "warranty", dcol) +
        th("Last check-in", "last_checkin", dcol) +
        `<th style="text-align:right">Actions</th></tr></thead><tbody>` +
        rows.map(r => {
          const open = exp.has(r.serial);
          return `<tr>
            <td><button class="rowbtn" data-action="expand" data-serial="${attr(r.serial)}" style="padding:2px 8px;line-height:1" title="Show all specs">${open ? "−" : "+"}</button></td>
            <td class="mono" title="${attr(r.serial)}">${esc(r.serial)}</td><td class="cell-mfr" title="${attr(r.manufacturer)}">${esc(r.manufacturer)}</td><td title="${attr(r.model)}">${esc(r.model)}</td>
            <td class="cell-user" title="${attr(r.user)}">${esc(r.user)}</td><td>${mfaCell(r.mfa)}</td><td>${esc(r.site_tag)}</td><td>${esc(r.warranty)}</td>
            <td>${esc(day(r.last_checkin))}${checkinBadge(r.last_checkin)}</td>
            <td style="text-align:right;white-space:nowrap">${act("⬆", "upgrade", r.serial, false, "Add to upgrade list")} ${act("✕", "remove", r.serial, true, "Remove")}</td></tr>` +
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
        <div class="modal-body"><div class="steps"><div id="ws1"></div><div id="ws2"></div><div id="ws3"></div></div><div id="wBody"></div></div>
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

/* ---- report bug / feature request (modal, opens over any view) ----------- */
const Feedback = {
  open(type) {
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal" style="width:520px;max-width:94vw;">
        <div class="modal-head"><h3>Report a bug / request a feature</h3><button onclick="Feedback.close()">&times;</button></div>
        <div class="modal-body">
          <p style="margin-top:0;color:var(--muted);font-size:13px;">Saved to a shared file in the Systems library so the team can track it.</p>
          <div class="field"><label>Type</label>
            <select id="mfbType"><option value="bug">Bug</option><option value="feature">Feature request</option></select></div>
          <div class="field"><label>Title</label><input id="mfbTitle" placeholder="Short summary" autofocus></div>
          <div class="field"><label>Details</label>
            <textarea id="mfbDetail" rows="4" placeholder="What happened, or what would you like?"
              style="width:100%;box-sizing:border-box;background:var(--darker);border:1px solid var(--border);border-radius:8px;padding:10px 12px;color:var(--text);font-size:14px;"></textarea></div>
        </div>
        <div class="modal-foot">
          <button class="ghost" onclick="Feedback.close()">Cancel</button>
          <button class="primary" onclick="Feedback.submit()">Submit</button>
        </div></div></div>`;
    if (type) document.getElementById("mfbType").value = type;
    document.getElementById("mfbTitle").focus();
  },
  close() { document.getElementById("modalRoot").innerHTML = ""; },
  async submit() {
    const title = (document.getElementById("mfbTitle").value || "").trim();
    if (!title) return App.toast("Add a short title.", true);
    const payload = {
      type: document.getElementById("mfbType").value,
      title,
      detail: (document.getElementById("mfbDetail").value || "").trim(),
    };
    const btn = document.querySelector(".modal-foot .primary"); if (btn) btn.disabled = true;
    const r = await Backend.call("hub_add_feedback", payload);
    if (!r || !r.ok) { App.toast((r && r.error) || "Could not submit.", true); if (btn) btn.disabled = false; return; }
    this.close();
    App.toast(payload.type === "feature" ? "Feature request submitted — thanks!" : "Bug report submitted — thanks!");
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
    const fmt = w => { const d = new Date(w); return isNaN(d) ? esc(w) : d.toLocaleString(); };
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
const Nav = {
  go(view) {
    document.querySelectorAll(".appview").forEach(el => el.classList.remove("active"));
    const v = document.getElementById("appview-" + view);
    if (v) v.classList.add("active");
    document.querySelectorAll(".navitem").forEach(b => b.classList.toggle("active", b.dataset.view === view));
    window.scrollTo(0, 0);
    if (view === "dashboard") Dashboard.load();
    if (view === "inventory") App.render();
    if (view === "upgrades") Upgrade.load();
    if (view === "software") Software.load();
    if (view === "projecthub") ProjectHub.load();
    if (view === "bgtools") BGTools.load();
  },
};

/* ---- Project Hub: dedicated sidebar item -------------------------------
   Project Hub uses MSAL redirect sign-in, which refuses to run in an iframe
   (redirect_in_iframe). So it opens FULL-WINDOW in the app's own window (top
   frame → sign-in works) with an injected "← Back to NBG Hub" button, or in a
   separate window. Same mechanism the NBT Sites "fullview" mode uses. */
const ProjectHub = {
  URL: "https://projecthub-dev.nucorservices.com/",
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
      host.innerHTML = `<div class="empty">No sites yet. Add them under <b>Configuration → NBT Sites</b>.</div>`;
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

  reload() { const f = document.getElementById("siteFrame"); if (f) f.src = f.src; },

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
      ${inv ? cstat(inv.stale_checkin_count || 0, "No check-in 30+ days", "Dashboard.drillStale()", (inv.stale_checkin_count ? "warn" : "")) : stat("–", "No check-in 30+ days")}
      ${inv && (inv.no_mfa_count || (inv.no_mfa && inv.no_mfa.length)) ? cstat(inv.no_mfa_count || 0, "Users without MFA", "Dashboard.drillNoMfa()", "danger") : ""}
      ${inv && inv.not_nbgw_count ? cstat(inv.not_nbgw_count, "Not part of NBGW", "Dashboard.drillNotNbgw()") : ""}
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
        <div class="nu-grid">${nuCol("LTR")}${nuCol("BRI")}</div></div>`;

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
      const whenTxt = when ? new Date(when).toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + new Date(when).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
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
    const legend = `<div class="stack-legend">${chip("all", "All", "all")}${chip("LTR", "LTR", "ltr")}${chip("BRI", "BRI", "bri")}${hasOther ? chip("Other", "Other", "other") : ""}</div>`;
    const rows = entries.map(([k, total]) => {
      if (f === "all") {
        const s = bySite[k] || {}, ltr = s.LTR || 0, bri = s.BRI || 0, other = s.Other || 0;
        const nums = [ltr ? `LTR <b>${ltr}</b>` : "", bri ? `BRI <b>${bri}</b>` : "", other ? `Other <b>${other}</b>` : ""].filter(Boolean).join(" · ") || "0";
        const seg = (site, n, cls) => n ? `<div class="seg ${cls}" data-dept="${attr(k)}" data-site="${site}" style="width:${Math.round(n / maxSD * 100)}%" title="${site}: ${n}"></div>` : "";
        return `<div class="stack-row clickable" data-dept="${attr(k)}"><div class="bl">${esc(k)}</div>
          <div class="stack-track">${seg("LTR", ltr, "ltr")}${seg("BRI", bri, "bri")}${seg("Other", other, "other")}</div>
          <div class="stack-nums">${nums}</div></div>`;
      }
      const cls = f === "LTR" ? "ltr" : f === "BRI" ? "bri" : "other";
      return `<div class="stack-row clickable" data-dept="${attr(k)}" data-site="${f}"><div class="bl">${esc(k)}</div>
        <div class="stack-track"><div class="seg ${cls}" style="width:${Math.round(total / maxSD * 100)}%"></div></div>
        <div class="stack-nums">${f} <b>${total}</b></div></div>`;
    }).join("") || `<div class="empty" style="padding:14px">No in-stock devices for ${f}.</div>`;
    const rc = inv.reserved_count || 0;
    const reservedNote = rc ? `<p class="sub-note reserved-note" id="deptReservedNote" style="margin:6px 0 0">🔒 ${rc} reserved for an active setup — held out of these counts. <a href="#" onclick="Dashboard.drillReserved();return false;">View</a></p>` : "";
    return `<div class="chart-card" id="deptCard"><h4>In Stock By Department <button class="card-link" onclick="Depts.open()">Configure ›</button></h4>
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
  drillNeedsUpgrade() {
    Drill.open("Needs upgrade — processor 5+ years old (oldest first)", this._inv().needs_upgrade || [], [
      { label: "Serial", get: r => r.serial, mono: 1, w: "13%" }, { label: "Model", get: r => r.model, w: "17%" },
      { label: "Processor", get: r => r.cpu, w: "20%" }, { label: "User", get: r => r.user, w: "20%" },
      { label: "Released", get: r => r.year, w: "10%" }, { label: "Age", get: r => r.age + " yrs", sortGet: r => r.age, w: "8%" }],
      { empty: "No devices with a processor 5+ years old — or CPU specs aren't filled in yet (run a sync).",
        rowAction: { label: "⬆ Add to upgrade list", fn: r => Upgrade.addPrompt(r.serial) } });
  },
  // "Needs upgrade" tile: side-by-side LTR / BRI upgrade plan. Each column = top 5,
  // combining user-prioritized upgrade-list entries (priority first) with the most
  // out-of-date (oldest CPU) devices not yet queued. Links to the Upgrades tab.
  _bucket(s) { const u = (s || "").trim().toUpperCase(); return u === "LTR" ? "LTR" : u === "BRI" ? "BRI" : "Other"; },
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
        : `<span class="tag warn" title="Oldest hardware, not yet queued">${it.age ? it.age + "yr" : "aged"}</span>`;
      const stat = it.status === "working" ? ` <span class="tag ok">Working</span>` : "";
      const who = it.listed
        ? `by ${esc(it.updated_by || it.added_by || "—")} · ${esc((it.updated_at || it.added_at || "").slice(0, 10))}`
        : `CPU ${esc(it.year || "?")} · not yet queued`;
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
          <p class="sub-note" style="margin:0 0 14px">Every device meeting upgrade criteria, by site. Open the Upgrade list to set priorities, add notes, and Begin Upgrade.</p>
          <div class="up-plan-grid">${column("LTR")}${column("BRI")}</div>
        </div>
        <div class="modal-foot"><button class="ghost" onclick="Drill.close()">Close</button>
          <button class="primary" onclick="Drill.close(); Nav.go('upgrades')">Open Upgrade list →</button></div>
      </div></div>`;
  },
  async drillStale() {
    const rows = (this._inv().stale_checkin || []);
    rows.forEach(r => { if (r._living === undefined) r._living = null; });   // reset per open
    this._livingState = { entra: "…", ad_error: null, domain: "bg.nucorsteel.local" };
    Drill.open("No Intune check-in in 30+ days (stalest first)", rows, [
      { label: "Serial", get: r => r.serial, mono: 1, w: "12%" }, { label: "Device name", get: r => r.device_name, w: "13%" },
      { label: "Model", get: r => r.model, w: "13%" }, { label: "User", get: r => r.user, w: "16%" },
      { label: "Last check-in", get: r => (r.last_checkin || "").slice(0, 10), w: "11%" },
      { label: "Days ago", get: r => r.days, w: "7%" },
      { label: "Source", get: r => r.source || "—", w: "8%" },
      { label: "Living in", get: r => this._livingCell(r), html: 1, sortGet: r => this._livingRank(r), w: "18%" }],
      { empty: "No device has gone 30+ days without an Intune check-in.", width: "min(1360px, 96vw)" });
    // Async: find where each stale device still lives (on-prem AD / Entra / Intune).
    try {
      const res = await Backend.call("locate_devices",
        rows.map(r => ({ serial: r.serial, hostname: r.device_name })));
      if (res && res.ok) {
        this._livingState = { entra: res.entra_state, ad_error: res.ad_error, domain: res.ad_domain || "bg.nucorsteel.local" };
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
  drillNoMfa() {
    Drill.open("Users without MFA registered", this._inv().no_mfa || [], [
      { label: "Serial", get: r => r.serial, mono: 1, w: "18%" }, { label: "Device name", get: r => r.device_name, w: "22%" },
      { label: "Model", get: r => r.model, w: "24%" }, { label: "Primary user", get: r => r.user, w: "24%" }],
      { empty: "Every in-use device's user has MFA registered — or the MFA report isn't available yet (needs AuditLog.Read.All consent)." });
  },
  drillNotNbgw() {
    const inv = this._inv();
    Drill.open("Not part of NBGW", inv.not_nbgw || [], [
      { label: "Serial", get: r => r.serial, mono: 1 }, { label: "Model", get: r => r.model },
      { label: "Primary user", get: r => r.user }, { label: "Office location", get: r => r.office }],
      { chips: inv.not_nbgw_by_office, empty: "No devices outside NBGW (LTR/BRI) yet — fills in once directory access is granted and a sync resolves each user's location." });
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
  _siteKey(v) { v = (v || "").trim().toUpperCase(); return (v === "LTR" || v === "BRI") ? v : "Other"; },

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
          <p class="sub-note" style="margin:0 0 12px">Set a department for any device. This maps the <b>model</b>, so every in-stock device of that model moves with it.</p>
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
  DEPTS: [
    { key: "Detailing", label: "Detailing" },
    { key: "Engineering", label: "Engineering" },
    { key: "Other", label: "Estimating / PCs / Other" },
  ],
  SITES: ["LTR", "BRI"],
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
          <div class="hs-modal-bar">
            <p class="sub-note" style="margin:0">${total} ready spare${total === 1 ? "" : "s"} for emergency swaps / loaners${warn ? ` · <span class="hs-warn-txt">${warn} need attention</span>` : ""}. Click ＋ on an entry for full details.</p>
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
    return `<div class="hs-site"><div class="hs-site-h"><span class="hs-site-tag ${site.toLowerCase()}">${esc(site)}</span></div>${sections}</div>`;
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
    const site = hs ? (hs.site || "LTR") : "LTR", dept = hs ? (hs.dept || "Detailing") : "Detailing";
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
const BGTools = {
  _emp: null, _weeks: [], _sel: null, _found: [], _tool: null,
  _perm: { user: null, groups: [], found: [] },
  TOOLS: [
    { id: "timesheet", name: "Timesheet Fix", icon: "🔓", desc: "Unlock a timesheet week for an employee" },
    { id: "perms", name: "Permissions Finder", icon: "🔑", desc: "Find every group a teammate is in — direct + nested" },
    { id: "missing", name: "Missing Groups", icon: "🧩", desc: "Find groups a teammate or department is missing vs. peers" },
  ],
  _miss: { mode: "user", user: null, found: [], depts: [], company: "Nucor Buildings Group West" },
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
  },
  _renderTimesheet(p) {
    this._emp = null; this._weeks = []; this._sel = null;
    p.innerHTML =
      `<div class="chart-card" style="max-width:640px">
        <h4 style="margin:0 0 4px">Timesheet Fix</h4>
        <p class="sub-note" style="margin:0 0 14px">Search an employee to see the last 8 weeks' timesheet lock status, and unlock a week (sets it back to unlocked in NBSTimesheet).</p>
        <div style="display:flex;gap:8px;align-items:flex-end">
          <div class="field" style="flex:1;margin:0"><label>Employee — first or last name</label>
            <input id="bgtSearch" placeholder="e.g. Smith" autocomplete="off" onkeydown="if(event.key==='Enter')BGTools.search()"></div>
          <button class="primary" onclick="BGTools.search()">Search</button>
        </div>
        <div id="bgtBody" style="margin-top:16px"><p class="hint">Results appear here.</p></div>
      </div>`;
    const el = document.getElementById("bgtSearch"); if (el) el.focus();
  },
  async search() {
    const q = (document.getElementById("bgtSearch").value || "").trim();
    const body = document.getElementById("bgtBody");
    if (q.length < 2) { body.innerHTML = `<p class="hint">Type at least 2 letters.</p>`; return; }
    body.innerHTML = `<p class="hint">Searching…</p>`;
    const r = await Backend.call("ts_search", q);
    if (!r || !r.ok) { body.innerHTML = `<div class="cfg-warn">${esc((r && r.error) || "Search failed.")}</div>`; return; }
    const emps = r.employees || []; this._found = emps;
    if (!emps.length) { body.innerHTML = `<p class="hint">No employee matches “${esc(q)}”.</p>`; return; }
    if (emps.length === 1) { this.selectEmp(emps[0]); return; }
    body.innerHTML = `<div class="hint" style="margin-bottom:8px">${emps.length} matches — pick one:</div>` +
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
        <p class="sub-note" style="margin:0 0 14px">Find every group a teammate belongs to — directly and through nested groups (Entra) — then filter (e.g. type "boms"). Division narrows the search to one division (NBGW by default).</p>
        <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
          <div class="field" style="flex:2;min-width:200px;margin:0"><label>Teammate name</label>
            <input id="bgpSearch" placeholder="e.g. Alberto Padilla" autocomplete="off" onkeydown="if(event.key==='Enter')BGTools.permSearch()"></div>
          <div class="field" style="flex:1;min-width:200px;margin:0"><label>Division</label>
            <select id="bgpLoc"><option value="co:Nucor Buildings Group West">NBGW — Nucor Buildings Group West</option></select></div>
          <button class="primary" onclick="BGTools.permSearch()">Search</button>
        </div>
        <div id="bgpBody" style="margin-top:16px"><p class="hint">Results appear here.</p></div>
      </div>`;
    this._loadPermLocations();
    const el = document.getElementById("bgpSearch"); if (el) el.focus();
  },
  // Division options: divisions that share @nucor.com are told apart by Entra
  // companyName ("co:<company>"); separate BG brands by email domain ("dom:<domain>").
  async _loadPermLocations() {
    try {
      const r = await Backend.call("bg_locations");
      const sel = document.getElementById("bgpLoc");
      if (!sel || !r || !r.ok) return;
      this._perm.locations = r.locations || [];
      const divs = r.divisions || [];
      sel.innerHTML =
        `<optgroup label="Nucor divisions">` +
          divs.map(d => `<option value="co:${attr(d.company)}">${esc(d.label)}</option>`).join("") +
        `</optgroup><optgroup label="Other BG brands">` +
          this._perm.locations.map(l => `<option value="dom:${attr(l.domain)}">${esc(l.label)}</option>`).join("") +
        `</optgroup><option value="">All divisions (whole tenant)</option>`;
      sel.value = `co:${r.nbgw_company || "Nucor Buildings Group West"}`;
    } catch (e) { /* keep the NBGW default */ }
  },
  _scopeArgs(v) {
    v = v || "";
    if (v.startsWith("co:")) return ["", v.slice(3)];
    if (v.startsWith("dom:")) return [v.slice(4), ""];
    return ["", ""];
  },
  async permSearch() {
    const q = (document.getElementById("bgpSearch").value || "").trim();
    const [domain, company] = this._scopeArgs((document.getElementById("bgpLoc") || {}).value);
    const body = document.getElementById("bgpBody");
    if (q.length < 2) { body.innerHTML = `<p class="hint">Type at least 2 letters.</p>`; return; }
    body.innerHTML = `<p class="hint">Searching…</p>`;
    const r = await Backend.call("bg_user_search", q, domain, company);
    if (!r || !r.ok) { body.innerHTML = `<div class="cfg-warn">${esc((r && r.error) || "Search failed.")}</div>`; return; }
    const users = r.users || []; this._perm.found = users;
    if (!users.length) { body.innerHTML = `<p class="hint">No teammate matches “${esc(q)}”.</p>`; return; }
    if (users.length === 1) { this.permSelectUser(users[0]); return; }
    body.innerHTML = `<div class="hint" style="margin-bottom:8px">${users.length} matches — pick one:</div>` +
      `<div class="bgt-list">` + users.map((u, i) => `<div class="bgt-emp" onclick="BGTools.permPick(${i})">
        <span>${esc(u.display)}</span><span class="muted">${esc(u.dept || "")} · ${esc(u.upn)}</span></div>`).join("") + `</div>`;
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
    this._miss = { mode: "user", user: null, found: [], depts: [], company: "Nucor Buildings Group West" };
    p.innerHTML =
      `<div class="chart-card" style="max-width:860px">
        <h4 style="margin:0 0 4px">Missing Groups</h4>
        <p class="sub-note" style="margin:0 0 12px">Compare a teammate or a whole department against its <b>group baseline</b> — the groups the majority of that department holds — to find who's missing groups their peers have. Build/adjust baselines in <b>Configuration → Group baselines</b>.</p>
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
          <div class="field" style="flex:1;min-width:220px;margin:0"><label>NBGW teammate name</label>
            <input id="missSearch" placeholder="e.g. Stephen Thornton" autocomplete="off" onkeydown="if(event.key==='Enter')BGTools.missSearchUser()"></div>
          <button class="primary" onclick="BGTools.missSearchUser()">Search</button></div>
         <p class="sub-note" style="margin:8px 0 0">Searches <b>${esc(this._miss.company)}</b> (NBGW) teammates only — the same people the baselines are built from.</p>`;
      const el = document.getElementById("missSearch"); if (el) el.focus();
    } else {
      ctl.innerHTML =
        `<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
          <div class="field" style="flex:2;min-width:240px;margin:0"><label>Department (with a saved baseline)</label>
            <select id="missDept"><option value="">Loading…</option></select></div>
          <button class="primary" id="missDeptBtn" onclick="BGTools.missShowDept()">Check department</button></div>
         <p class="sub-note" style="margin:8px 0 0">Only departments analyzed in <b>Configuration → Group baselines</b> appear here.</p>`;
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
        : `<option value="">No baselines yet — analyze one in Configuration</option>`;
      const btn = document.getElementById("missDeptBtn"); if (btn) btn.disabled = !depts.length;
    } catch (e) { sel.innerHTML = `<option value="">Could not load</option>`; }
  },
  async missSearchUser() {
    const q = (document.getElementById("missSearch").value || "").trim();
    const body = document.getElementById("missBody");
    if (q.length < 2) { body.innerHTML = `<p class="hint">Type at least 2 letters.</p>`; return; }
    body.innerHTML = `<p class="hint">Searching…</p>`;
    const r = await Backend.call("bg_user_search", q, "", this._miss.company);
    if (!r || !r.ok) { body.innerHTML = `<div class="cfg-warn">${esc((r && r.error) || "Search failed.")}</div>`; return; }
    const users = r.users || []; this._miss.found = users;
    if (!users.length) { body.innerHTML = `<p class="hint">No NBGW teammate matches “${esc(q)}”.</p>`; return; }
    if (users.length === 1) { this.missShowUser(users[0]); return; }
    body.innerHTML = `<div class="hint" style="margin-bottom:8px">${users.length} matches — pick one:</div>` +
      `<div class="bgt-list">` + users.map((u, i) => `<div class="bgt-emp" onclick="BGTools.missPickUser(${i})">
        <span>${esc(u.display)}</span><span class="muted">${esc(u.dept || "")} · ${esc(u.upn)}</span></div>`).join("") + `</div>`;
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
        `<div class="cfg-warn" style="margin-top:6px"><b>${esc(u.display || "This person")}</b> is in <b>${esc(u.company || "another division")}</b>, not ${esc(r.company || "NBGW")}. Group baselines only cover NBGW teammates, so there's nothing valid to compare against.</div>`;
      return;
    }
    if (!r.has_baseline) {
      const dept = (u.dept || "").trim();
      body.innerHTML = head +
        `<div class="cfg-warn" style="margin-top:6px">No group baseline saved for <b>${esc(dept || "this department")}</b> yet, so there's nothing to compare against.` +
        (dept ? ` <button class="rowbtn" style="margin-left:8px" onclick="BGTools.missAnalyzeThenUser('${attr(dept)}','${attr(u.id)}')">Analyze “${esc(dept)}” now</button>` : "") +
        `<div class="sub-note" style="margin-top:8px">Or build it in <b>Configuration → Group baselines</b>.</div></div>`;
      return;
    }
    const total = r.total || 0;
    const cov = g => `held by ${g.count}/${total} of dept · ${Math.round((g.pct || 0) * 100)}%`;
    const missing = r.missing || [], present = r.present || [];
    const missCard = missing.length
      ? `<div class="miss-card miss-bad"><div class="miss-card-h">✗ Missing ${missing.length} expected group${missing.length === 1 ? "" : "s"}</div>` +
        missing.map(g => `<div class="miss-row"><span class="miss-name" title="${attr(g.name)}">${esc(g.name)}</span><span class="miss-cov">${esc(cov(g))}</span></div>`).join("") + `</div>`
      : `<div class="miss-card miss-good"><div class="miss-card-h">✓ Not missing any expected groups</div><div class="sub-note" style="margin:2px 0 0">Has all ${present.length} common group${present.length === 1 ? "" : "s"} for this department.</div></div>`;
    const presCard = present.length
      ? `<details class="miss-card miss-ok"><summary class="miss-card-h">Has ${present.length} of ${present.length + missing.length} expected group${(present.length + missing.length) === 1 ? "" : "s"}</summary>` +
        present.map(g => `<div class="miss-row"><span class="miss-name" title="${attr(g.name)}">${esc(g.name)}</span></div>`).join("") + `</details>`
      : "";
    body.innerHTML = head +
      `<p class="sub-note" style="margin:0 0 10px">Compared against the <b>${esc(u.dept)}</b> common-groups baseline (${total} NBGW peer${total === 1 ? "" : "s"}${r.updated ? `, analyzed ${esc(String(r.updated).slice(0, 10))}` : ""}).</p>` +
      missCard + presCard;
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
      body.innerHTML = `<div class="cfg-warn">No baseline saved for <b>${esc(r.department)}</b>. Analyze it first in <b>Configuration → BomsNet baselines</b>.</div>`;
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
      `<div class="bgt-emp-head"><b>${esc(r.department)}</b> <span class="muted">${total} NBGW member${total === 1 ? "" : "s"} · ${(r.expected || []).length} expected group${(r.expected || []).length === 1 ? "" : "s"}</span></div>
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
    this._render();
  },
  _render() {
    const cols = this._cols, act = this._action, rows = this._rows, opts = this._opts;
    const chips = opts.chips && Object.keys(opts.chips).length
      ? `<div class="office-chips">${Object.entries(opts.chips).sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `<span class="office-chip">${esc(k)}&nbsp;<b>${v}</b></span>`).join("")}</div>` : "";
    const anyW = cols.some(c => c.w);
    const colgroup = anyW ? `<colgroup>${cols.map(c => `<col${c.w ? ` style="width:${c.w}"` : ""}>`).join("")}${act ? "<col style=\"width:90px\">" : ""}</colgroup>` : "";
    const head = cols.map((c, idx) => {
      const arrow = this._sortIdx === idx ? (this._sortDir > 0 ? " ▲" : " ▼") : "";
      return `<th onclick="Drill.sort(${idx})" title="Sort by ${attr(c.label)}">${esc(c.label)}${arrow}</th>`;
    }).join("") + (act ? "<th></th>" : "");
    const body = rows.length
      ? chips + `<table class="drill-tbl">${colgroup}<thead><tr>${head}</tr></thead><tbody>` +
        rows.map((r, i) => `<tr>${cols.map(c => `<td class="${c.mono ? "mono" : ""}">${c.html ? c.get(r) : esc(c.get(r))}</td>`).join("")}` +
          (act ? `<td style="text-align:right;white-space:nowrap"><button class="rowbtn" onclick="Drill.act(${i})">${esc(act.label)}</button></td>` : "") +
          `</tr>`).join("") +
        `</tbody></table>`
      : `<div class="empty">${esc(opts.empty || "Nothing to show here.")}</div>`;
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal" style="width:${this._opts.width || "880px"};max-width:96vw;">
        <div class="modal-head"><h3>${esc(this._title)} — ${rows.length}</h3><button onclick="Drill.close()">&times;</button></div>
        <div class="modal-body" style="max-height:70vh;overflow-y:auto;overflow-x:hidden;">${body}</div>
        ${this._opts.footerHtml ? `<div class="modal-foot" style="justify-content:space-between;gap:12px">${this._opts.footerHtml}</div>` : ""}
      </div></div>`;
  },
  act(i) { const r = this._rows[i]; if (this._action && r) this._action.fn(r); },
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
  _topCache: new WeakMap(),   // apps array (identity) -> { "scope|n": [names] }

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
    const ck = scope + "|" + n;
    if (m[ck]) return m[ck];
    const inScope = new Set((users || []).filter(u => this.deptKey(u) === scope).map(u => (u.user || "").toLowerCase()));
    let out = [];
    if (inScope.size) {
      const byName = {};
      (apps || []).forEach(a => (a.installs || []).forEach(i => {
        const uk = (i.user || "").toLowerCase();
        if (inScope.has(uk)) (byName[a.name] = byName[a.name] || new Set()).add(uk);
      }));
      out = Object.keys(byName).sort((x, y) => byName[y].size - byName[x].size || x.localeCompare(y)).slice(0, n);
    }
    m[ck] = out;
    return out;
  },
  autoTop(apps, users, scope) { return this.top(apps, users, scope, AUTO_MANDATORY_TOP); },
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
    const userRaw = (document.getElementById("swUser").value || "").trim();
    const swRaw = (document.getElementById("swSoftware").value || "").trim();
    const userQ = userRaw.toLowerCase();
    const swQ = swRaw.toLowerCase();
    const mandOnly = document.getElementById("swMandOnly").checked;
    // Two filters: User (all software for that user/device) and Software (all installs
    // of that app). Both together -> that user's install of that specific software.
    let apps = this.data.apps.map(a => {
      let scoped = this._installsInScope(a, scope);
      if (userQ) scoped = scoped.filter(i => (i.user || "").toLowerCase().includes(userQ)
        || (i.device || "").toLowerCase().includes(userQ) || (i.serial || "").toLowerCase().includes(userQ));
      return { ...a, scoped };
    }).filter(a => {
      if (swQ && !((a.name || "").toLowerCase().includes(swQ) || (a.publisher || "").toLowerCase().includes(swQ))) return false;
      if (userQ && a.scoped.length === 0) return false;            // user has no install of this app
      if (scope !== "all" && a.scoped.length === 0) return false;  // dept view needs installs in that dept
      return true;
    });
    if (mandOnly && scope !== "all") apps = apps.filter(a => this.isMandatory(a.name, scope));
    apps.sort((a, b) => b.scoped.length - a.scoped.length || a.name.localeCompare(b.name));
    this._view = apps;
    const noteBits = [];
    if (userRaw) noteBits.push(`on <b>${esc(userRaw)}</b>`);
    if (swRaw) noteBits.push(`matching <b>${esc(swRaw)}</b>`);
    const deptUsers = scope === "all" ? [] : (this.data.users || []).filter(u => this.deptKeyOf(u) === scope);
    let html = "";
    if (!this.hasDept) html += `<div class="cfg-warn" style="margin-bottom:12px">Department grouping is dormant — grant <code>User.Read.All</code> and Refresh to group by department. For now apps group by site only.</div>`;
    if (noteBits.length) html += `<p class="sub-note" style="margin:0 0 12px">${apps.length} app(s) ${noteBits.join(" · ")}.</p>`;
    if (scope !== "all") html += this._complianceHtml(scope, deptUsers);
    html += `<table class="fit sw-tbl"><colgroup><col style="width:34%"><col style="width:14%"><col style="width:20%"><col style="width:9%">${scope !== "all" ? '<col style="width:9%">' : ""}<col style="width:110px"></colgroup>` +
      `<thead><tr><th>App</th><th>Version</th><th>Publisher</th><th>${scope === "all" ? "Installs" : "In scope"}</th>${scope !== "all" ? "<th>Mandatory</th>" : ""}<th></th></tr></thead><tbody>` +
      apps.map((a, i) => `<tr>
        <td title="${attr(a.name)}">${esc(a.name)}</td><td>${esc(a.version || "—")}</td><td class="muted" title="${attr(a.publisher || "")}">${esc(a.publisher || "—")}</td>
        <td>${a.scoped.length}</td>
        ${scope !== "all" ? `<td><input type="checkbox" ${this.isMandatory(a.name, scope) ? "checked" : ""} onchange="Software.toggleMandatory('${attr(a.name)}','${attr(scope)}',this.checked)"></td>` : ""}
        <td style="text-align:right;white-space:nowrap"><button class="rowbtn" onclick="Software.drill(${i})">Who has it ›</button></td></tr>`).join("") +
      `</tbody></table>`;
    host.innerHTML = html;
  },
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
      `<div class="sw-comp-note">Top ${AUTO_MANDATORY_TOP} apps here are mandatory automatically (<span class="auto-tag">auto</span>); missing is checked against the latest version. Tick/untick below to adjust.</div>${body}</div>`;
  },
  drill(i) {
    const a = (this._view || [])[i]; if (!a) return;
    const rows = a.scoped || this._installsInScope(a, this._scope());
    Drill.open(`${a.name}${a.version ? ` · ${a.version}` : ""} — installed on`, rows, [
      { label: "User", get: r => r.user || "—" }, { label: "Device", get: r => r.device || "—", mono: 1 },
      { label: "Site", get: r => r.site || "—" }, { label: "Department", get: r => r.dept || "—" }],
      { empty: "No installs in this scope." });
  },
  async refresh() {
    const btn = document.getElementById("swRefreshBtn"); const old = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "Pulling from Intune…"; }
    const r = await Backend.call("software_refresh");
    if (btn) { btn.disabled = false; btn.textContent = old; }
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
  SITES: ["LTR", "BRI", "Other"],

  siteKey(site) { const s = (site || "").trim().toUpperCase(); return s === "LTR" ? "LTR" : s === "BRI" ? "BRI" : "Other"; },

  resolveDevice(serial) {
    const s = String(serial);
    const r = (App.state.use || []).find(x => x.serial === s)
      || (App.state.stock || []).find(x => x.serial === s) || { serial: s };
    return { serial: r.serial || s, device_name: r.device_name || "", model: r.model || "",
             user: r.user || "", site: r.site_tag || "", site_tag: r.site_tag || "" };
  },

  async load() {
    try {
      const r = await Backend.call("hub_get_upgrades");
      const d = (r && r.ok && r.data) || {};
      this.items = Array.isArray(d.items) ? d.items : [];
      this.log = (r && r.ok && r.log && Array.isArray(r.log.entries)) ? r.log.entries : [];
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
    if (!["LTR", "BRI", "Other", "log"].includes(this.activeTab)) this.activeTab = "LTR";
    this.renderTabs(); this.render();
  },

  renderTabs() {
    const el = document.getElementById("upTabs"); if (!el) return;
    const tabs = [...this.SITES.map(s => ({ id: s, label: s === "Other" ? "Other" : s })), { id: "log", label: "Completed" }];
    const count = id => id === "log" ? (this.log || []).length : this.items.filter(it => this.siteKey(it.site) === id).length;
    el.innerHTML = tabs.map(t =>
      `<button class="up-tab${this.activeTab === t.id ? " active" : ""}" onclick="Upgrade.tab('${t.id}')">${esc(t.label)} <span class="up-badge">${count(t.id)}</span></button>`).join("");
  },
  tab(id) { this.activeTab = id; this.renderTabs(); this.render(); },

  render() {
    const host = document.getElementById("upHost"); if (!host) return;
    if (this.activeTab === "log") { host.innerHTML = this._logHtml(); return; }
    const list = this.items.filter(it => this.siteKey(it.site) === this.activeTab);
    if (!list.length) {
      host.innerHTML = `<div class="empty">No devices queued for ${this.activeTab === "Other" ? "non-NBGW sites" : this.activeTab}. Add one from the Devices list or the “Needs upgrade” dashboard tile.</div>`;
      return;
    }
    host.innerHTML = "";
    const wrap = document.createElement("div"); wrap.className = "up-list";
    list.forEach((it, idx) => wrap.appendChild(this._row(it, idx)));
    host.appendChild(wrap);
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
    row.innerHTML =
      `<span class="up-pos">${idx + 1}</span>` +
      `<span class="handle" title="Drag to reorder">☰</span>` +
      `<span class="up-badge2 p${p}" title="Priority ${p} (5 = highest)">P${p}</span>` +
      `<div class="up-main">` +
        `<div class="up-top"><span class="mono">${esc(it.serial)}</span> <span class="up-model">${esc(it.model || "")}</span>${it.device_name ? ` <span class="muted">· ${esc(it.device_name)}</span>` : ""}</div>` +
        `<div class="up-sub">${esc(it.user || "—")}${it.notes ? ` — <span class="up-note">${esc(it.notes)}</span>` : ""}</div>` +
        `<div class="up-meta">Added ${esc((it.added_at || "").slice(0, 10))}${it.added_by ? ` by ${esc(it.added_by)}` : ""}` +
          `${(it.updated_at && it.updated_at !== it.added_at) ? ` · edited ${esc(it.updated_at.slice(0, 10))}${it.updated_by ? ` by ${esc(it.updated_by)}` : ""}` : ""}</div>` +
        workHtml +
      `</div>` +
      `<div class="up-ctrls">` +
        (working ? "" : `<button class="iconbtn up-begin" title="Begin upgrade — starts a new computer setup and marks this Working">▶ Begin</button>`) +
        `<button class="iconbtn" title="Move up">↑</button>` +
        `<button class="iconbtn" title="Move down">↓</button>` +
        `<button class="iconbtn" title="Edit priority / notes">✎</button>` +
        `<button class="iconbtn done" title="Mark upgraded (moves to completed log)">✓</button>` +
        `<button class="iconbtn del" title="Remove (not logged)">✕</button>` +
      `</div>`;
    const beginBtn = row.querySelector(".up-begin"); if (beginBtn) beginBtn.onclick = () => this.begin(it.id);
    const openBtn = row.querySelector(".up-opensetup"); if (openBtn) openBtn.onclick = () => { if (it.setup_id) { Nav.go("hub"); Hub.resumeSetup(it.setup_id); } };
    const btns = [...row.querySelectorAll('.up-ctrls .iconbtn:not(.up-begin)')];
    btns[0].onclick = () => this.move(it.id, -1);
    btns[1].onclick = () => this.move(it.id, 1);
    btns[2].onclick = () => this.editPrompt(it.id);
    btns[3].onclick = () => this.complete(it.id);
    btns[4].onclick = () => this.remove(it.id);
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
            <div class="muted">${esc(dev.user || "no user")} · ${site === "Other" ? "No NBGW site" : site}</div>
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

  _logHtml() {
    const log = this.log || [];
    if (!log.length) return `<div class="empty">No completed upgrades yet. Check a device off to log it here.</div>`;
    return `<table class="up-logtbl"><thead><tr><th>Serial</th><th>Model</th><th>Site</th><th>Priority</th><th>User</th><th>Added</th><th>Completed</th></tr></thead><tbody>` +
      log.map(e => `<tr><td class="mono">${esc(e.serial || "")}</td><td>${esc(e.model || "")}</td><td>${esc(e.site || "")}</td><td>P${esc(e.priority || "")}</td><td>${esc(e.user || "")}</td>` +
        `<td>${esc((e.added_at || "").slice(0, 10))}${e.added_by ? ` · ${esc(e.added_by)}` : ""}</td>` +
        `<td>${esc((e.completed_at || "").slice(0, 10))}${e.completed_by ? ` · ${esc(e.completed_by)}` : ""}</td></tr>`).join("") +
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
  _unlocked: false,   // PIN gate, per app session

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
    this._reqTab = tab || "models";
    if (!Depts._unlocked) { this._renderPin(); return; }
    this._enter(this._reqTab);
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

  // ---- PIN gate --------------------------------------------------------
  _renderPin() {
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal" style="width:380px;max-width:94vw;">
        <div class="modal-head"><h3>Configuration locked</h3><button onclick="Depts.close()">&times;</button></div>
        <div class="modal-body">
          <p class="sub-note" style="margin:0 0 12px">Enter the configuration PIN to make changes.</p>
          <input id="cfgPin" type="password" inputmode="numeric" autocomplete="off" class="dept-search" placeholder="PIN"
            style="width:100%" onkeydown="if(event.key==='Enter'){event.preventDefault();Depts._checkPin();}">
          <p id="cfgPinErr" class="site-hint" style="color:var(--red);display:none;margin-top:8px">Incorrect PIN.</p>
        </div>
        <div class="modal-foot"><button class="ghost" onclick="Depts.close()">Cancel</button><button class="primary" onclick="Depts._checkPin()">Unlock</button></div>
      </div></div>`;
    setTimeout(() => { const p = document.getElementById("cfgPin"); if (p) p.focus(); }, 40);
  },

  _checkPin() {
    const v = (document.getElementById("cfgPin").value || "").trim();
    if (v === String(Sites.pin || "1700")) { Depts._unlocked = true; this._enter(this._reqTab || "models"); }
    else { const e = document.getElementById("cfgPinErr"); if (e) e.style.display = ""; }
  },

  _render() {
    const tabBar = this.TABS.map(t =>
      `<button class="ctab${t.id === this.activeTab ? " active" : ""}" onclick="Depts.tab('${t.id}')">${esc(t.label)}</button>`).join("");
    let body = "", foot = "";
    if (this.activeTab === "models") { body = this._modelsBody(); foot = this._modelsFoot(); }
    else if (this.activeTab === "sites") { body = this._sitesBody(); foot = this._sitesFoot(); }
    else if (this.activeTab === "perms") { body = this._permsBody(); foot = this._permsFoot(); }
    else if (this.activeTab === "storage") { body = this._storageBody(); foot = ""; }
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal" style="width:820px;max-width:94vw;">
        <div class="modal-head"><h3>Configuration</h3><button onclick="Depts.close()">&times;</button></div>
        <div class="config-tabs">${tabBar}</div>
        <div class="modal-body" style="max-height:68vh;overflow:auto;">${body}</div>
        ${foot}
      </div></div>`;
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
    return `<p class="sub-note" style="margin:0 0 12px">The groups the <b>majority</b> of each department holds (all Entra groups). Used by <b>BG Tools → Missing Groups</b> to flag teammates missing groups their peers have. Analyze a department, then check/uncheck which groups count as “expected”.</p>
      <div class="cfg-ok" style="margin:0 0 12px">Scope: <b>NBGW teammates only</b> — Entra company “${esc(doc.company || "Nucor Buildings Group West")}”. Department names like “Detailing Dept NBS” are shared with NBGTX (Terrell) and NBSIN (Waterloo), so members are filtered by company, not just department.</div>
      <div class="pb-controls">
        <label class="pb-thr">Majority threshold
          <input type="range" min="30" max="100" step="5" value="${thr}"
            oninput="document.getElementById('pbThrVal').textContent=this.value+'%'" onchange="Depts._pbThreshold(this.value)">
          <b id="pbThrVal">${thr}%</b></label>
        <span style="display:flex;gap:8px">
          <button class="ghost" onclick="Depts._pbAnalyzeAll()"${names.length ? "" : " disabled"}>↻ Re-analyze all</button>
          <button class="ghost" onclick="Depts._pbRebuild()" title="Find every NBGW department in Entra and rebuild all baselines from scratch">⟳ Rebuild from NBGW directory</button>
        </span>
      </div>
      <div class="pb-add">
        <div style="position:relative;flex:1">
          <input id="pbDeptInput" placeholder="Add a department to analyze… e.g. Detailing Dept Lathrop" autocomplete="off"
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
    if (!window.confirm("Rebuild ALL group baselines from the NBGW directory?\n\nThis finds every NBGW department in Entra, replaces the current baselines, and re-analyzes each one (about a minute). Any groups you unchecked by hand will be reset.")) return;
    const st = document.getElementById("pbStatus");
    if (st) st.innerHTML = `<div class="pb-run">Finding NBGW departments in Entra…</div>`;
    const d = await Backend.call("perm_discover_departments");
    if (!d || !d.ok) { if (st) st.innerHTML = `<div class="cfg-warn">${esc((d && d.error) || "Could not list NBGW departments.")}</div>`; return; }
    const todo = (d.departments || []).filter(x => x.eligible).map(x => x.dept);
    const skipped = (d.departments || []).filter(x => !x.eligible);
    const reset = { keyword: (this._pb || {}).keyword || "", threshold: (this._pb || {}).threshold || 0.7,
                    company: d.company, departments: {} };
    const s = await Backend.call("perm_save_baselines", reset, { action: "rebuild", target: "Group baselines", detail: `Rebuilding ${todo.length} NBGW department(s)` });
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
    if (st3) st3.innerHTML = `<div class="cfg-ok">Rebuilt <b>${todo.length - failed.length}</b> NBGW department baseline(s) from ${d.total_users} NBGW teammates.` +
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
    return `<p class="sub-note" style="margin:0 0 16px">Tag each model with the department that uses it. In-stock counts roll up by department on the dashboard so you can see your deployable pool per department.</p>
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
      App.toast ? App.toast("Configuration saved.") : 0;
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
    return `<p class="sub-note" style="margin:0 0 16px">Add, edit, group, or remove the tools on the <b>NBT Sites</b> tab. Sites are grouped by category. "Opens as": In-app = full window with a Back button (best for sign-in portals); Embedded = inside the page (only works for sites that allow framing).</p>
      <div class="dept-manage">
        <label>Categories</label>
        <div class="dept-chips" id="catChips"></div>
        <div class="dept-add"><input id="catNew" placeholder="Add a category…" onkeydown="if(event.key==='Enter'){event.preventDefault();Depts.addCat();}"><button class="ghost" onclick="Depts.addCat()">+ Add</button></div>
      </div>
      <table class="dept-table cfg-sites"><thead><tr>
          <th>Name</th><th>URL</th><th>Category</th><th>Opens as</th><th></th></tr></thead>
        <tbody id="siteRows">${rows}</tbody></table>
      <button class="ghost" style="margin-top:12px" onclick="Depts.addSite()">+ Add site</button>
      <div class="cfg-pin-row"><label>Configuration PIN</label>
        <input id="cfgPinSet" class="cfg-in" value="${attr(this._sPin || "")}" inputmode="numeric" oninput="Depts._sPinEdit(this)">
        <span class="site-hint">Required to open Configuration.</span></div>`;
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

  close() { document.getElementById("modalRoot").innerHTML = ""; },
};

/* ---- Endpoint Hub (setup runbooks) --------------------------------------- */
const Hub = {
  config: null,
  _setups: [],
  state: { id: null, type: null, dept: null, checks: {}, notes: {}, subject: "", tech: "", serviceTag: "", createdAt: null, resumed: false },
  who: {},
  K_DRAFT: "nbgw_hub_draft_v2",

  async boot() {
    const cm = document.getElementById("modalConfirm");
    if (cm) cm.onclick = () => { const cb = this._modalCb; this.closeModal(); if (cb) cb(); };
    const mb = document.getElementById("modalBg");
    if (mb) mb.addEventListener("click", e => { if (e.target === mb) this.closeModal(); });

    const w = await Backend.call("hub_whoami");
    if (w && w.ok) { this.who = w; }
    const r = await Backend.call("hub_get_config");
    if (r && r.ok && r.config && r.config.user && r.config.computerBase && r.config.departments) {
      this.config = r.config;
    } else {
      this.config = this.makeDefaults();
      Backend.call("hub_save_config", this.config, { action: "seed", target: "(entire config)", detail: "defaults" });
    }
    this.renderActivity();
  },

  go(v) {
    document.querySelectorAll(".hubview").forEach(el => el.classList.remove("active"));
    const el = document.getElementById("hubview-" + v);
    if (el) el.classList.add("active");
    if (v === "home") this.renderActivity();
    if (v === "admin") { this.buildAdminSelect(); this.loadAdmin(); }
    if (v === "feedback") this.renderFeedback();
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
    subj.placeholder = isUser ? (this.config.user.subjectPlaceholder || "e.g. Smith, Jane") : "e.g. NBGW-XXXXXX";
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
  openFolder() { Backend.call("hub_open_folder"); },
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
      <h1>NUCOR NBGW · ${isUser ? "New User Setup" : "New Computer Setup"}</h1>
      <div class="sub">NBGW Systems setup record</div>
      <div class="hd"><div><b>${isUser ? "Teammate:" : "Hostname:"}</b> ${esc(subj)}</div>
      <div><b>Primary user:</b> ${esc(s.primaryUser || "—")}</div>
      ${s.dept ? `<div><b>Department:</b> ${esc(s.dept)}</div>` : ""}
      <div><b>Technician:</b> ${esc(s.tech || "—")}</div>
      ${s.serviceTag ? `<div><b>Service tag / Asset #:</b> ${esc(s.serviceTag)}</div>` : ""}
      <div><b>Date:</b> ${d.toLocaleString()}</div><div><b>Status:</b> ${statusTxt}</div>
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
        const whenTxt = when ? new Date(when).toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + new Date(when).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
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
        const when = c.when ? new Date(c.when).toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + new Date(c.when).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
        const row = document.createElement("div"); row.className = "change-row";
        row.innerHTML = `<span class="act">${esc(c.action || "change")}</span>
          <span>${esc(c.target || "")}${c.detail ? " — " + esc(c.detail) : ""}</span>
          <span class="cwho">${esc(c.user || "")} · ${when}</span>`;
        chost.appendChild(row);
      });
    });
  },

  /* ---- feedback ---- */
  submitFeedback() {
    const type = document.getElementById("fbType").value;
    const title = document.getElementById("fbTitle").value.trim();
    const detail = document.getElementById("fbDetail").value.trim();
    if (!title) { document.getElementById("fbTitle").focus(); return App.toast("Add a short title.", true); }
    Backend.call("hub_add_feedback", { type, title, detail }).then(r => {
      if (!r || !r.ok) return App.toast("Could not save.", true);
      document.getElementById("fbTitle").value = ""; document.getElementById("fbDetail").value = "";
      App.toast("Thanks — saved to the shared list."); this.renderFeedback();
    });
  },
  renderFeedback() {
    const host = document.getElementById("feedbackList");
    Backend.call("hub_get_feedback").then(r => {
      const items = (r && r.ok && r.feedback) ? r.feedback : [];
      document.getElementById("fbCount").textContent = items.length;
      if (!items.length) { host.innerHTML = `<div class="empty">Nothing reported yet.</div>`; return; }
      host.innerHTML = "";
      items.slice(0, 50).forEach(f => {
        const when = f.at ? new Date(f.at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
        const row = document.createElement("div"); row.className = "fb-row";
        row.innerHTML = `<span class="ft ${f.type === "bug" ? "bug" : "feature"}">${f.type === "bug" ? "Bug" : "Feature"}</span>
          <div class="fbody"><div class="fbtitle">${esc(f.title || "")}</div>
          ${f.detail ? `<div class="fbdetail">${esc(f.detail)}</div>` : ""}
          <div class="fbwho">${esc(f.by || "")} · ${when} · ${esc(f.status || "open")}</div></div>`;
        host.appendChild(row);
      });
    });
  },

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
    Backend.call("hub_save_config", this.config, { action: "save", target: label, detail: summary });
    App.toast("Checklist saved & logged."); this.renderAdmin();
  },
  resetOne() {
    this.openModal("Reset to default?", "This restores the original items for this checklist and discards your edits.", () => {
      const d = this.makeDefaults(), label = this.adminLabel();
      if (this.adminTarget.kind === "user") this.config.user = d.user;
      else if (this.adminTarget.kind === "base") this.config.computerBase = d.computerBase;
      else if (this.config.departments[this.adminTarget.dept]) this.config.departments[this.adminTarget.dept] = d.departments[this.adminTarget.dept] || this.config.departments[this.adminTarget.dept];
      Backend.call("hub_save_config", this.config, { action: "reset", target: label, detail: "restored defaults" });
      this.loadAdmin(); App.toast("Reset to default & logged.");
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
        { text: "Format display name as Lastname, Firstname (NBGW)", detail: "Capitalized first letters" } ] },
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
  /* master settings - mirrors Api.get_master_settings / set_master_setting */
  _ms: [{ key: "lenovo_client_id", secret: true, is_set: true, value: "", description: "Lenovo warranty API key" },
        { key: "super_admins", secret: false, is_set: true, value: "demo@nucor.com", description: "Comma-separated emails" }],
  async get_master_settings() { return { ok: true, super_admin: true, settings: this._ms }; },
  async set_master_setting(key, value, secret, description) {
    const x = this._ms.find(r => r.key === key);
    if (x) { x.is_set = !!value; x.value = secret ? "" : value; }
    else this._ms.push({ key, secret: !!secret, is_set: !!value, value: secret ? "" : value, description: description || "" });
    return { ok: true };
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
  async hub_get_config() { return { ok: true, config: this._hubConfig }; },
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
  async software_save_rules(rules) { this._softwareRules = { rules: (rules && rules.rules) || [] }; return { ok: true, rules: this._softwareRules.rules }; },
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
        needs_upgrade_count: needsUp.length, needs_upgrade: needsUp,
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
function _boot(real) {
  if (_started) return; _started = true;
  Backend.real = real;
  Hub.boot();
  Sites.boot();
  Depts.load();
  Dashboard.load();
  App.init(real);
  setInterval(refreshShared, 45000);
  window.addEventListener("focus", refreshShared);
}
window.addEventListener("pywebviewready", () => _boot(true));
window.addEventListener("load", () => setTimeout(() => { if (!_started) _boot(false); }, 300));
