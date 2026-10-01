/* ---- Settings page --------------------------------------------------------
   One page, left rail of sections, no pop-ups.
     THIS DIVISION (tenant)  General + time zone | Sites | Directory & SQL | Model departments | NBT Sites | Group baselines | Storage
     PLATFORM (super admin)  Divisions | Super admins | Integrations & options
   The tenant sections edit the ACTIVE division only. Role gating comes later; today every app user of the
   division can open the tenant sections and only super admins see the platform ones.
   Model departments / NBT Sites / Group baselines / Storage are rendered by Depts (page mode, see app.js).
   Loaded after app.js: it reuses esc(), attr(), Backend, App.toast, DirPicker, Divisions, Tz, Depts. */

/* ---- small shared widgets ------------------------------------------------- */
const SetUI = {
  card(title, sub, body, foot) {
    return `<div class="set-card"><div class="set-card-head"><h3>${esc(title)}</h3>${sub ? `<p>${sub}</p>` : ""}</div>
      <div class="set-card-body">${body}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ""}</div>`;
  },
  /* <select> that always contains the current value, even when it is not in the option list */
  select(id, opts, val, onchange, placeholder, disabled) {
    const list = opts.slice();
    if (val && !list.some(o => o.id === val)) list.unshift({ id: val, label: val });
    return `<select id="${id}" ${disabled ? "disabled" : ""} ${onchange ? `onchange="${onchange}"` : ""}>` +
      (placeholder !== undefined ? `<option value="">${esc(placeholder)}</option>` : "") +
      list.map(o => `<option value="${attr(o.id)}"${o.id === val ? " selected" : ""}>${esc(o.label)}</option>`).join("") + `</select>`;
  },
  aclParts(e) { const a = /^admin:/i.test(e); return { admin: a, body: a ? e.slice(6) : e }; },
  /* access list as a table: Name | Type | Role | remove. "*" (everyone) has a fixed role and only super admins see it */
  aclTable(list, onRole, onDel, showStar) {
    const rows = list.map((e, i) => {
      const p = this.aclParts(e);
      if (p.body === "*" && !showStar) return "";
      const g = /^group:/i.test(p.body), star = p.body === "*";
      const name = star ? "Everyone" : g ? (p.body.slice(6).split("|").slice(1).join("|") || p.body.slice(6).split("|")[0]) : p.body;
      const role = star ? `<span class="muted">User</span>`
        : `<select onchange="${onRole}(${i},this.value)"><option value="user"${p.admin ? "" : " selected"}>User</option><option value="admin"${p.admin ? " selected" : ""}>Admin</option></select>`;
      return `<tr><td>${esc(name)}</td><td class="muted">${star ? "All app users" : g ? "Entra group" : "Person"}</td><td>${role}</td>
        <td style="text-align:right"><button class="cfg-del" onclick="${onDel}(${i})" title="Remove">&times;</button></td></tr>`;
    }).join("");
    return rows ? `<table class="ms-table set-acl-table"><thead><tr><th>Name</th><th>Type</th><th>Role</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : "";
  },
  setRole(list, i, role) { const p = this.aclParts(list[i]); list[i] = role === "admin" ? "admin:" + p.body : p.body; },
  pill(kind, text) { return `<span class="set-pill ${kind}">${esc(text)}</span>`; },
};

/* chip list with an add box (Enter / comma / leaving the box adds) */
const ChipInput = {
  _s: {},
  mount(hostId, values, onChange, placeholder) {
    const host = document.getElementById(hostId);
    if (!host) return;
    this._s[hostId] = { values, onChange };
    const draw = () => {
      host.innerHTML = `<div class="ci"><span class="ci-chips">${values.map((v, i) =>
        `<span class="dp-chip">${esc(v)} <button type="button" data-i="${i}" title="Remove">&times;</button></span>`).join("")}</span>
        <input class="ci-in" placeholder="${attr(placeholder || "type and press Enter")}"></div>`;
      host.querySelectorAll("button[data-i]").forEach(b => b.onclick = () => { values.splice(+b.dataset.i, 1); onChange(values); draw(); });
      const inp = host.querySelector(".ci-in");
      const add = () => {
        inp.value.split(",").map(x => x.trim()).filter(Boolean).forEach(x => { if (!values.includes(x)) values.push(x); });
        if (inp.value.trim()) { inp.value = ""; onChange(values); draw(); host.querySelector(".ci-in").focus(); }
      };
      inp.onkeydown = e => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } };
      inp.onblur = add;
    };
    draw();
  },
};

/* ---- site editor (shared by the tenant tab and the platform division editor) ---------------- */
const SitesEditor = {
  m: null, host: "", onDirty: () => {},
  render(hostId, m, onDirty) {
    this.m = m; this.host = hostId; this.onDirty = onDirty || (() => {});
    const host = document.getElementById(hostId);
    if (!host) return;
    if (!m.sites) m.sites = [];
    host.innerHTML = (m.sites.map((s, k) => `<div class="set-site">
        <div class="set-site-top">
          <div class="field"><label>Code</label><input value="${attr(s.code)}" maxlength="6" placeholder="TER" style="text-transform:uppercase" oninput="SitesEditor.set(${k},'code',this.value.toUpperCase())"></div>
          <div class="field" style="flex:1"><label>Name</label><input value="${attr(s.name)}" placeholder="Terrell, TX" oninput="SitesEditor.set(${k},'name',this.value)"></div>
          <button class="ghost" type="button" title="Remove this site" onclick="SitesEditor.del(${k})">Remove</button>
        </div>
        <div class="set-site-grid">
          <div class="field"><label>User city starts with <span class="muted">(Entra city &rarr; this site)</span></label><div id="${hostId}-c${k}"></div></div>
          <div class="field"><label>Device name starts with <span class="muted">(e.g. BGTER)</span></label><div id="${hostId}-d${k}"></div></div>
        </div></div>`).join("") || `<div class="empty" style="padding:16px">No sites yet.</div>`) +
      `<button class="ghost" type="button" style="margin-top:10px" onclick="SitesEditor.add()">+ Add site</button>`;
    m.sites.forEach((s, k) => {
      s.city_prefixes = s.city_prefixes || []; s.device_prefixes = s.device_prefixes || [];
      ChipInput.mount(`${hostId}-c${k}`, s.city_prefixes, () => this.onDirty(), "city, Enter");
      ChipInput.mount(`${hostId}-d${k}`, s.device_prefixes, () => this.onDirty(), "prefix, Enter");
    });
  },
  set(k, f, v) { this.m.sites[k][f] = v; this.onDirty(); },
  add() { this.m.sites.push({ code: "", name: "", city_prefixes: [], device_prefixes: [] }); this.onDirty(); this.render(this.host, this.m, this.onDirty); },
  del(k) { this.m.sites.splice(k, 1); this.onDirty(); this.render(this.host, this.m, this.onDirty); },
};

/* ---- directory + SQL editor (shared) -------------------------------------------------------- */
const SqlEditor = {
  m: null, host: "", onDirty: () => {}, dbs: null, tables: {}, manual: false, busy: false, err: "",
  render(hostId, m, onDirty) {
    if (this.m !== m) { this.dbs = null; this.tables = {}; this.manual = false; this.err = ""; }
    this.m = m; this.host = hostId; this.onDirty = onDirty || (() => {});
    const host = document.getElementById(hostId);
    if (!host) return;
    const pick = (field, label, list, ph) => {
      const v = m[field] || "";
      return `<div class="field"><label>${label}</label>` + (this.manual
        ? `<input value="${attr(v)}" oninput="SqlEditor.set('${field}',this.value)">`
        : SetUI.select("sqe-" + field, (list || []).map(x => ({ id: x, label: x })), v, `SqlEditor.set('${field}',this.value)`, ph)) + `</div>`;
    };
    const dbOpts = this.dbs || [];
    host.innerHTML = `
      <div class="field"><label>SQL Server <span class="muted">(host or host\\instance)</span></label>
        <div style="display:flex;gap:8px"><input id="sqe-server" value="${attr(m.sql_server || "")}" oninput="SqlEditor.set('sql_server',this.value)" placeholder="BGBRISQL07">
          <button class="ghost" type="button" onclick="SqlEditor.load()" ${this.busy ? "disabled" : ""}>${this.busy ? "Loading…" : "Load databases"}</button></div>
        ${this.err ? `<p class="set-err">${esc(this.err)}</p>` : ""}
        <p class="muted" style="margin:6px 0 0;font-size:12px">Loads the list from the server (read-only) so you pick names instead of typing them.
          <a href="#" onclick="SqlEditor.toggleManual();return false">${this.manual ? "Use the pick lists" : "Type names by hand"}</a></p></div>
      <div class="set-grid2">
        ${pick("timesheet_db", "Timesheet database", dbOpts, this.dbs ? "Choose…" : "Load databases first")}
        ${pick("timesheet_table", "Week-lock table", this.tables[m.timesheet_db] || [], this.tables[m.timesheet_db] ? "Choose…" : "Pick a database first")}
        ${pick("employee_db", "Employee database", dbOpts, this.dbs ? "Choose…" : "Load databases first")}
        ${pick("employee_table", "Employee table", this.tables[m.employee_db] || [], this.tables[m.employee_db] ? "Choose…" : "Pick a database first")}
      </div>
      <p class="muted" style="margin:10px 0 0;font-size:12px">Leave all four blank if this division has no timesheet tool. <a href="#" onclick="SqlEditor.clear();return false">Clear all four</a></p>
      <div class="field"><label>Active Directory domain <span class="muted">(optional, e.g. bg.nucorsteel.local)</span></label>
        <input value="${attr(m.ad_domain || "")}" oninput="SqlEditor.set('ad_domain',this.value)"></div>`;
  },
  set(f, v) {
    this.m[f] = v.trim(); this.onDirty();
    if (f === "timesheet_db" || f === "employee_db") { this.m[f === "timesheet_db" ? "timesheet_table" : "employee_table"] = ""; this.loadTables(v); }
  },
  toggleManual() { this.manual = !this.manual; this.render(this.host, this.m, this.onDirty); },
  clear() { ["timesheet_db", "timesheet_table", "employee_db", "employee_table"].forEach(k => this.m[k] = ""); this.onDirty(); this.render(this.host, this.m, this.onDirty); },
  async load() {
    const srv = (document.getElementById("sqe-server").value || "").trim();
    if (!srv) { this.err = "Enter the SQL server first."; return this.render(this.host, this.m, this.onDirty); }
    this.busy = true; this.err = ""; this.render(this.host, this.m, this.onDirty);
    const r = await Backend.call("sql_discover", srv, "");
    this.busy = false;
    if (!r || !r.ok) this.err = (r && r.error) || "Could not read the server.";
    else if (!r.items.length) this.err = "No databases visible to your account on that server.";
    else { this.dbs = r.items; await Promise.all([this.m.timesheet_db, this.m.employee_db].filter(Boolean).map(d => this.loadTables(d, true))); }
    this.render(this.host, this.m, this.onDirty);
  },
  async loadTables(db, quiet) {
    if (!db || this.tables[db] || !this.m.sql_server) return;
    const r = await Backend.call("sql_discover", this.m.sql_server, db);
    if (r && r.ok) this.tables[db] = r.items;
    else if (!quiet) this.err = (r && r.error) || "Could not read the tables.";
    if (!quiet) this.render(this.host, this.m, this.onDirty);
  },
};

/* ---- "Last sync" line (dashboard) + per-division overview (Platform > Sync all divisions) ---- */
const SyncLine = {
  /* one-line text for a status record from synclock.status() */
  text(st) {
    if (!st || st.never) return "never synced";
    const when = Tz.dt(st.ended);
    const bits = [`${st.count || 0} devices`];
    if (st.added || st.updated) bits.push(`+${st.added || 0} ~${st.updated || 0}`);
    if (st.deduped) bits.push(`${st.deduped} duplicates removed`);
    return `${when}${st.by ? " by " + st.by : ""} · ${bits.join(", ")}${st.ok === false ? " · with errors" : ""}`;
  },
  async refresh() {
    const el = document.getElementById("syncLine");
    if (!el) return;
    try {
      const r = await Backend.call("get_sync_status");
      if (!r || !r.ok) { el.textContent = ""; return; }
      const bad = r.stale || r.ok === false;
      el.innerHTML = `<span style="color:${bad ? "var(--red)" : "var(--muted)"}">Last sync: ${esc(this.text(r))}${r.stale && !r.never ? " (over 36 hours ago)" : ""}</span>`;
      el.title = (r.errors && r.errors.length) ? r.errors.join("\n") : "";
    } catch (e) { el.textContent = ""; }
  },
};

/* ---- the page ------------------------------------------------------------------------------- */
const Settings = {
  su: false, role: "user", tab: "general", dirty: false, own: null, prefs: null,
  RANK: { user: 1, admin: 2, super: 3 }, allowed: [],
  async refreshAccess() {
    const [r, ro] = await Promise.all([Backend.call("get_master_settings"), Backend.call("get_my_role")]);
    this.su = !!(r && r.ok && r.super_admin);
    this.role = (ro && ro.ok && ro.role) || "user";
    this.allowed = (ro && ro.ok && ro.sections) || [];          // sections beyond General this role may use (Platform > Role access)
  },
  can(min) { return (this.RANK[this.role] || 0) >= this.RANK[min]; },
  open(tab) { if (tab) this.tab = tab; Nav.go("settings"); },
  /* every division section; General is always shown, the rest depend on Platform > Role access */
  SECTIONS: [["general", "General"], ["models", "Model departments"], ["links", "NBT Sites"], ["access", "Who has access"],
             ["sites", "Sites"], ["sql", "Directory & SQL"], ["perms", "Group baselines"], ["storage", "Storage"]],
  groups() {
    return [
      { title: Divisions.label(), items: this.SECTIONS.filter(x => x[0] === "general" || this.allowed.includes(x[0])) },
      ...(this.su ? [{ title: "Platform (super admin)", items: [["divisions", "Divisions"], ["admins", "Super admins"], ["sync", "Sync all divisions"], ["template", "Template checklists"], ["roles", "Role access"], ["integrations", "Integrations & options"]] }] : []),
    ];
  },
  async load() {
    await this.refreshAccess();
    const valid = this.groups().some(g => g.items.some(i => i[0] === this.tab));
    if (!valid) this.tab = "general";
    document.querySelectorAll(".side-config[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === "settings"));
    document.getElementById("setSub").textContent = "Settings for " + Divisions.label() + (this.su ? " and the whole platform." : ".");
    this.dirty = false;
    this.rail();
    await this.show(this.tab, true);
  },
  rail() {
    document.getElementById("setRail").innerHTML = this.groups().map(g =>
      `<div class="set-rail-title">${esc(g.title)}</div>` + g.items.map(([id, label]) =>
        `<button class="set-rail-item${id === this.tab ? " active" : ""}" onclick="Settings.go('${id}')">${esc(label)}</button>`).join("")).join("");
  },
  async go(tab) {
    if (tab === this.tab && !this.dirty) return;
    if (this.dirty && !confirm("You have unsaved changes on this page. Leave without saving?")) return;
    this.tab = tab; this.dirty = false; this.rail();
    await this.show(tab);
  },
  markDirty(btnId) { this.dirty = true; const b = document.getElementById(btnId || "setSave"); if (b) b.disabled = false; },
  pane(owner, html) {
    const p = document.getElementById("setPane");
    p.dataset.owner = owner;
    if (html !== undefined) p.innerHTML = html;
    return p;
  },
  async show(tab, force) {
    Depts._page = false;
    this.pane("settings", `<div class="empty">Loading…</div>`);
    const dep = { models: "models", links: "sites", perms: "perms", storage: "storage" }[tab];
    if (dep) { this.pane("depts"); Depts._page = true; await Depts.openPage(dep); return; }
    const fn = { general: "general", access: "accessTab", sites: "sitesTab", sql: "sqlTab", divisions: "divisions", admins: "admins", roles: "roles", template: "templateTab", sync: "syncAll", integrations: "integrations" }[tab];
    try { await this[fn](); } catch (e) { this.pane("settings", `<div class="empty">Could not open this section: ${esc(String(e && e.message || e))}</div>`); }
  },

  /* ---- General: facts + time zone ---- */
  async general() {
    const [o, p] = await Promise.all([Backend.call("get_own_division"), Backend.call("get_division_prefs")]);
    if (!o || !o.ok) return this.pane("settings", `<div class="empty">${esc((o && o.error) || "Could not read this division.")}</div>`);
    this.own = o; this.prefs = (p && p.ok) ? p : { timezone: "", default: "", effective: "", zones: [] };
    const zl = this.prefs.zones, zlabel = id => (zl.find(z => z.id === id) || {}).label || id;
    const def = this.prefs.default ? zlabel(this.prefs.default) : "this PC's own time zone";
    const sites = (o.sites || []).map(s => `<span class="dp-chip">${esc(s.code)} <i>${esc(s.name || "")}</i></span>`).join("") || `<span class="muted">none yet</span>`;
    const canEdit = this.can("admin");
    const fact = (k, v) => `<div class="set-fact"><span>${k}</span><b>${v || "<i class='muted'>not set</i>"}</b></div>`;
    this.pane("settings",
      SetUI.card("About this division", this.su ? "Identity is changed under <b>Platform &rarr; Divisions</b>." : "Identity (name, Entra company, Intune category) is managed by a super admin.",
        `<div class="set-facts">${fact("Name", esc(o.name))}${fact("Id", esc(o.id))}${fact("Entra company", esc(o.company_name))}${fact("Intune category", esc(o.intune_category))}</div>
         <div style="margin-top:12px"><span class="muted" style="font-size:12px">Sites</span><div class="dp-chips" style="margin-top:6px">${sites}</div></div>`) +
      SetUI.card("Time zone", "Every date and time in the app for this division is shown in this zone." + (canEdit ? "" : " Division admins can change it."),
        `<div class="field" style="max-width:420px"><label>Time zone for ${esc(Divisions.label())}</label>
           ${SetUI.select("tzSel", zl.map(z => ({ id: z.id, label: z.label })), this.prefs.timezone, "Settings.tzPreview()", "Use the default (" + def + ")", !canEdit)}</div>
         <p id="tzPrev" class="muted" style="margin:10px 0 0"></p>`,
        canEdit ? `<button class="primary" id="setSave" onclick="Settings.saveTz()" disabled>Save time zone</button>` : "") +
      SetUI.card("Project Hub", "Where the Project Hub item in the sidebar opens for " + esc(Divisions.label()) + (canEdit ? "." : ". Division admins can change it."),
        `<div class="field" style="max-width:560px"><label>Project Hub address</label>
           <input id="phUrl" value="${attr(this.prefs.project_hub_url || "")}" placeholder="${attr(this.prefs.project_hub_default)}" ${canEdit ? "" : "disabled"} oninput="Settings.markDirty('phSave')"></div>
         <p class="muted" style="margin:8px 0 0;font-size:12px">Leave blank to use the platform default: ${esc(this.prefs.project_hub_default)}. Must start with https://.</p>`,
        `<button class="ghost" onclick="Settings.phOpen()">Open this address</button>` + (canEdit ? `<button class="primary" id="phSave" onclick="Settings.savePh()" disabled>Save address</button>` : "")));
    document.getElementById("tzSel").addEventListener("change", () => this.markDirty());
    this.tzPreview();
  },
  tzPreview() {
    const v = document.getElementById("tzSel").value || this.prefs.default || "";
    const el = document.getElementById("tzPrev");
    if (!el) return;
    let t = "";
    try { t = new Date().toLocaleString(undefined, v ? { timeZone: v, dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium", timeStyle: "short" }); } catch (e) { t = ""; }
    el.textContent = "Right now that is: " + t;
  },
  phOpen() {
    const v = (document.getElementById("phUrl").value || "").trim() || this.prefs.project_hub_default;
    Backend.call("open_external", /^https?:\/\//i.test(v) ? v : "https://" + v).then(r => { if (r && !r.ok) App.toast(r.error || "Could not open it.", true); });
  },
  async savePh() {
    const r = await Backend.call("save_division_prefs", null, (document.getElementById("phUrl").value || "").trim());
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not save.", true);
    this.dirty = false;
    await Tz.load();
    App.toast("Project Hub address saved.");
    this.general();
  },
  async saveTz() {
    const r = await Backend.call("save_division_prefs", document.getElementById("tzSel").value);
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not save.", true);
    this.dirty = false;
    await Tz.load();
    App.toast("Time zone saved.");
    this.general();
  },

  /* ---- tenant: sites ---- */
  async ownLoad() {
    const o = await Backend.call("get_own_division");
    if (!o || !o.ok) { this.pane("settings", `<div class="empty">${esc((o && o.error) || "Could not read this division.")}</div>`); return null; }
    this.own = JSON.parse(JSON.stringify(o));
    return this.own;
  },
  /* ---- tenant: who can open this division ---- */
  async accessTab() {
    const o = await this.ownLoad(); if (!o) return;
    o.access = o.access || [];
    const star = o.access.includes("*");
    this.pane("settings", SetUI.card("Who has access to " + Divisions.label(),
      "People and Entra groups listed here can switch to this division. <b>Admins</b> can also change this division's settings and who has access; <b>users</b> only see the settings they need day to day. Set each person's role in the table. Super admins always have full access.",
      `${o.can_edit ? "" : `<div class="cfg-warn">Read-only here (Local data mode or no central site).</div>`}
       ${star ? `<div class="cfg-ok" style="margin-bottom:12px">Everyone who can run the app can see this division (set by a super admin).</div>` : ""}
       <div id="acChips"></div>
       <div class="set-acc"><div id="acUser"></div><div id="acGroup"></div>${o.super_admin ? `<button class="ghost" type="button" onclick="Settings.acAdd('*')">+ Everyone</button>` : ""}</div>
       <p class="muted" style="font-size:12px;margin-top:12px">Tip: add an Entra group once, then manage membership in Entra instead of here. You cannot remove your own admin rights.
       This controls what the app shows; people with access to the SharePoint site can still open the lists directly.</p>`,
      `<button class="ghost" onclick="Settings.show('access')">Discard changes</button><button class="primary" id="setSave" onclick="Settings.saveOwn(['access'])" disabled>Save access</button>`));
    this.acRender();
  },
  acRender() {
    const acc = this.own.access;
    document.getElementById("acChips").innerHTML = SetUI.aclTable(acc, "Settings.acRole", "Settings.acDel", this.own.super_admin)
      || "<span class='muted'>Nobody yet: only super admins can see this division</span>";
    DirPicker.mount("acUser", "user", it => this.acAdd(it.upn), "Add a person (name or sign-in)…");
    DirPicker.mount("acGroup", "group", it => this.acAdd("group:" + it.id + "|" + it.name), "Add an Entra group…");
  },
  acAdd(v) { if (!this.own.access.includes(v)) this.own.access.push(v); this.markDirty(); this.acRender(); },
  acRole(i, r) { SetUI.setRole(this.own.access, i, r); this.markDirty(); },
  acDel(i) { this.own.access.splice(i, 1); this.markDirty(); this.acRender(); },

  async sitesTab() {
    const o = await this.ownLoad(); if (!o) return;
    this.pane("settings", SetUI.card("Sites", "Each site has a short code. The prefixes tell the app which site a user (by Entra city) or a device (by name) belongs to.",
      `${o.can_edit ? "" : `<div class="cfg-warn">Read-only here (Local data mode or no central site).</div>`}<div id="seSites"></div>
       <p class="muted" style="margin-top:12px;font-size:12px">Changing a code regroups devices on the dashboard and lists; existing records keep their old code until a sync updates them.</p>`,
      `<button class="ghost" onclick="Settings.show('sites')">Discard changes</button><button class="primary" id="setSave" onclick="Settings.saveOwn(['sites'])" disabled>Save sites</button>`));
    SitesEditor.render("seSites", o, () => this.markDirty());
  },
  async sqlTab() {
    const o = await this.ownLoad(); if (!o) return;
    this.pane("settings", SetUI.card("Directory & SQL", "Where this division's timesheet and employee data live. Used by BG Tools &rarr; Timesheet and the AD lookups.",
      `${o.can_edit ? "" : `<div class="cfg-warn">Read-only here (Local data mode or no central site).</div>`}<div id="seSql"></div>`,
      `<button class="ghost" onclick="Settings.show('sql')">Discard changes</button><button class="primary" id="setSave" onclick="Settings.saveOwn(['ad_domain','sql_server','timesheet_db','timesheet_table','employee_db','employee_table'])" disabled>Save</button>`));
    SqlEditor.render("seSql", o, () => this.markDirty());
  },
  async saveOwn(keys) {
    const o = this.own, data = {};
    keys.forEach(k => data[k] = o[k]);
    if (data.sites) data.sites = data.sites.filter(s => s.code);
    const r = await Backend.call("save_own_division", data);
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not save.", true);
    this.dirty = false;
    await Divisions.load();
    App.toast("Saved.");
    this.show(this.tab);
  },

  /* ---- platform: super admins ---- */
  sa: { admins: [], bootstrap: [], me: "" },
  async admins() {
    const r = await Backend.call("get_super_admins");
    if (!r || !r.ok || r.super_admin === false) return this.pane("settings", `<div class="empty">Super admins only.</div>`);
    this.sa = { admins: r.admins || [], bootstrap: r.bootstrap || [], me: r.me || "" };
    this.pane("settings", SetUI.card("Super admins", "Super admins manage divisions, who can see them, and the platform settings. Use the account people actually sign in with (for example <b>adm.name.azure@nucor.onmicrosoft.com</b>).",
      `<div id="saChips" class="dp-chips"></div><div id="saPicker" style="margin-top:10px;max-width:520px"></div>
       <p class="muted" style="margin:12px 0 0;font-size:12px">You cannot remove yourself. Entries marked <i>config</i> come from config.json and can only be removed there.</p>`));
    this.saRender();
  },
  saRender() {
    const st = this.sa, all = [...new Set([...st.bootstrap, ...st.admins])];
    document.getElementById("saChips").innerHTML = all.map(a => {
      const boot = st.bootstrap.includes(a) && !st.admins.includes(a);
      const lock = boot || (a === st.me && !st.bootstrap.includes(a));
      return `<span class="dp-chip" title="${attr(boot ? "Set in config.json - edit that file to remove" : "")}">${esc(a)}${a === st.me ? " <i>(you)</i>" : ""}${boot ? " <i>config</i>" : ""}${lock ? "" : ` <button onclick="Settings.saRemove(${st.admins.indexOf(a)})" title="Remove">&times;</button>`}</span>`;
    }).join("") || "<span class='muted'>None</span>";
    DirPicker.mount("saPicker", "user", it => this.saAdd(it.upn), "Add a super admin: type a name or sign-in…");
  },
  async saPersist(list, msg) {
    const r = await Backend.call("save_super_admins", list);
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not save.", true);
    this.sa.admins = r.admins || list; this.saRender(); App.toast(msg);
  },
  saAdd(upn) {
    upn = (upn || "").toLowerCase();
    if (!upn || [...this.sa.admins, ...this.sa.bootstrap].includes(upn)) return App.toast("Already a super admin.");
    this.saPersist([...this.sa.admins, upn], "Added " + upn);
  },
  saRemove(i) { const u = this.sa.admins[i]; if (u) this.saPersist(this.sa.admins.filter((_, k) => k !== i), "Removed " + u); },

  /* ---- platform: template checklists (what a new division's Endpoint Provisioning starts from) ---- */
  async templateTab() {
    const r = await Backend.call("hub_get_template_config");
    const custom = !!(r && r.ok && r.config && r.config.user);
    this.pane("settings", SetUI.card("Template checklists", "The New Computer Setup and New User Setup checklists every new division starts with, and what a division's \"Reset this list\" goes back to.",
      `<p style="margin:0 0 10px">${custom ? SetUI.pill("ok", "Customised template") : SetUI.pill("warn", "Using the built-in defaults")}</p>
       <p class="muted" style="margin:0 0 10px">The built-in defaults still contain NBGW-specific steps (server names, account naming). Edit them once here and every division you add later starts clean.</p>
       <p class="muted" style="margin:0">Divisions that already have checklists (NBGW, Terrell) keep their own and are not changed.</p>`,
      `<button class="primary" onclick="Hub.editTemplate()">Edit the template checklists</button>`));
  },

  /* ---- platform: sync every division (manual) ---- */
  syncAll() {
    this.pane("settings", SetUI.card("Sync all divisions", "Reads each enabled division's devices from Intune, adds and updates its In Use list, removes duplicate rows, and fills in missing warranty and specs. It runs one division after another and takes a few minutes. It never deletes devices and never moves anything to the boneyard.",
      `<p class="muted" style="margin:0 0 12px">Runs as you, on live data. Each division gets one entry in its activity log. If Intune returns no devices for a division, that division is skipped and left unchanged.</p>
       <div id="syncAllOut"></div>`,
      `<button class="primary" id="syncAllBtn" onclick="Settings.syncAllRun()">Sync all divisions now</button>`)
      + SetUI.card("Last sync per division", "Whatever last synced each division: the app on someone's PC, or this button.", `<div id="syncOverview"><div class="empty" style="padding:14px">Loading…</div></div>`));
    this.syncOverview();
  },
  async syncOverview() {
    const host = document.getElementById("syncOverview");
    if (!host) return;
    const r = await Backend.call("get_sync_overview");
    if (!r || !r.ok || !r.divisions) { host.innerHTML = `<div class="muted">Could not read the sync history.</div>`; return; }
    host.innerHTML = `<table class="ms-table"><thead><tr><th>Division</th><th>Last sync</th><th>Source</th><th></th></tr></thead><tbody>` +
      r.divisions.map(d => `<tr><td>${esc(d.name)}</td><td>${esc(SyncLine.text(d))}</td><td class="muted">${esc(d.source || "")}</td>
        <td>${d.never ? SetUI.pill("warn", "Never") : d.stale ? SetUI.pill("warn", "Over 36 hours") : d.ok === false ? SetUI.pill("warn", "Errors") : SetUI.pill("ok", "OK")}</td></tr>`).join("") + `</tbody></table>`;
  },
  async syncAllRun() {
    if (!confirm("Sync every enabled division now?\n\nThis writes to the live In Use lists (adds, updates, removes duplicate rows).")) return;
    const btn = document.getElementById("syncAllBtn"), out = document.getElementById("syncAllOut");
    btn.disabled = true; btn.textContent = "Syncing… this can take a few minutes";
    out.innerHTML = `<div class="empty" style="padding:16px">Working through the divisions…</div>`;
    const r = await Backend.call("sync_all_divisions");
    btn.disabled = false; btn.textContent = "Sync all divisions now";
    if (!r || !r.ok) { out.innerHTML = `<div class="cfg-warn">${esc((r && r.error) || "Sync failed.")}</div>`; return; }
    const num = v => `<td style="text-align:right">${v}</td>`;
    const rows = r.divisions.map(d => `<tr><td>${esc(d.name)}</td><td>${d.ok ? SetUI.pill("ok", "Done") : SetUI.pill("warn", "Needs attention")}</td>
      ${num(d.count)}${num(d.added)}${num(d.updated)}${num(d.deduped)}${num(d.enriched)}
      <td class="muted">${d.errors.length ? esc(d.errors[0]) + (d.errors.length > 1 ? ` (+${d.errors.length - 1} more)` : "") : ""}</td></tr>`).join("");
    out.innerHTML = `<table class="ms-table"><thead><tr><th>Division</th><th>Result</th><th style="text-align:right">Devices seen</th><th style="text-align:right">Added</th><th style="text-align:right">Updated</th><th style="text-align:right">Duplicates removed</th><th style="text-align:right">Filled in</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table>`;
    App.toast(r.ok ? "All divisions synced." : "Sync finished with problems: see the table.", !r.ok);
    this.syncOverview(); SyncLine.refresh();
    try { Dashboard.load(); } catch (e) {}
  },

  /* ---- platform: role access (which Settings sections each division role may use) ---- */
  async roles() {
    const r = await Backend.call("get_role_access");
    if (!r || !r.ok || !r.super_admin) return this.pane("settings", `<div class="empty">${esc((r && r.error) || "Super admins only.")}</div>`);
    this.ra = { sections: r.sections, matrix: { user: [...r.matrix.user], admin: [...r.matrix.admin] } };
    const row = s => `<tr><td>${esc(s.label)}</td>` + ["user", "admin"].map(role =>
      `<td style="text-align:center"><input type="checkbox" class="cb" ${this.ra.matrix[role].includes(s.id) ? "checked" : ""} onchange="Settings.raToggle('${role}','${s.id}',this.checked)"></td>`).join("") + `</tr>`;
    this.pane("settings", SetUI.card("Role access", "Which Settings sections each division role can open and change. <b>General</b> is always visible to everyone (read-only for users). Super admins always have everything. The same rule is enforced when saving, not only in the menu.",
      `<table class="ms-table"><thead><tr><th>Section</th><th style="text-align:center">User</th><th style="text-align:center">Division admin</th></tr></thead>
        <tbody>${this.ra.sections.map(row).join("")}</tbody></table>
       <p class="muted" style="font-size:12px;margin-top:12px">Applies to every division. Changing the time zone and the General page stays with division admins.
       Model departments and NBT Sites data is shared day-to-day data: this only controls whether the settings page for it is shown.</p>`,
      `<button class="ghost" onclick="Settings.show('roles')">Discard changes</button><button class="primary" id="setSave" onclick="Settings.raSave()" disabled>Save role access</button>`));
  },
  raToggle(role, id, on) {
    const m = this.ra.matrix[role], i = m.indexOf(id);
    if (on && i < 0) m.push(id); else if (!on && i >= 0) m.splice(i, 1);
    this.markDirty();
  },
  async raSave() {
    const r = await Backend.call("save_role_access", this.ra.matrix);
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not save.", true);
    this.dirty = false;
    App.toast("Role access saved.");
    await this.refreshAccess();
    this.rail();
  },

  /* ---- platform: integrations & options (master settings as forms) ---- */
  async integrations() {
    const r = await Backend.call("get_master_settings");
    if (!r || !r.ok || !r.super_admin) return this.pane("settings", `<div class="empty">${esc((r && r.error) || "Super admins only.")}</div>`);
    this.cat = r.catalog || []; this.other = r.other || [];
    const order = []; this.cat.forEach(c => { if (!order.includes(c.group)) order.push(c.group); });
    const blurb = { "Vendor APIs": "Credentials for warranty and spec lookups. Secrets are stored hidden and are never shown again; type a new value to replace one.",
                    "Regional": "Platform-wide defaults.", "Sync": "How the Intune sync behaves.",
                    "Releases": "Tell techs when a newer NBG Hub build is out. Set these after you hand out a new installer." };
    const row = (c, i) => {
      const st = c.status === "planned" ? SetUI.pill("plan", "Not used yet") : (c.kind === "secret" ? (c.is_set ? SetUI.pill("ok", "Set") : SetUI.pill("warn", "Not set")) : "");
      let ctl;
      if (c.kind === "secret") ctl = `<input id="ig${i}" type="password" autocomplete="new-password" placeholder="${c.is_set ? "•••••• set - type to replace" : "paste the value"}">`;
      else if (c.kind === "url") ctl = `<input id="ig${i}" value="${attr(c.value || "")}" placeholder="https://projecthub.example.com/">`;
      else if (c.kind === "version") ctl = `<input id="ig${i}" value="${attr(c.value || "")}" placeholder="2026.10.15">`;
      else if (c.kind === "choice") ctl = SetUI.select("ig" + i, c.options || [], c.value, "", "(none - use each PC's own)");
      else ctl = `<input id="ig${i}" type="number" min="${c.min}" max="${c.max}" value="${attr(c.value || "")}" placeholder="${c.default} (default)">`;
      return `<div class="set-row"><div class="set-row-main"><b>${esc(c.label)}</b> ${st}<p>${esc(c.help)}</p></div>
        <div class="set-row-ctl">${ctl}<button class="primary" onclick="Settings.saveCat(${i})">Save</button></div></div>`;
    };
    const cards = order.map(g => SetUI.card(g, blurb[g] || "", this.cat.map((c, i) => c.group === g ? row(c, i) : "").join(""))).join("");
    const others = this.other.length ? SetUI.card("Other stored settings", "Present in the Master Settings list but not known to this screen.",
      this.other.map((o, i) => `<div class="set-row"><div class="set-row-main"><b>${esc(o.key)}</b> ${o.secret ? SetUI.pill("warn", "secret") : ""}</div>
        <div class="set-row-ctl"><input id="igo${i}" ${o.secret ? `type="password" placeholder="${o.is_set ? "•••••• set - type to replace" : "value"}"` : `value="${attr(o.value || "")}"`}>
        <button class="primary" onclick="Settings.saveOther(${i})">Save</button></div></div>`).join("")) : "";
    const custom = `<details class="set-adv"><summary>Advanced: add a setting this screen does not know yet</summary>
      <div class="set-grid2"><div class="field"><label>Key</label><input id="igcKey" placeholder="e.g. new_vendor_key"></div>
        <div class="field"><label>Value</label><input id="igcVal"></div></div>
      <label class="set-check"><input type="checkbox" id="igcSec"> Secret (hide the value after saving)</label>
      <div><button class="primary" style="margin-top:10px" onclick="Settings.saveCustom()">Add setting</button></div></details>`;
    this.pane("settings", cards + others + custom);
  },
  async saveCat(i) {
    const c = this.cat[i], el = document.getElementById("ig" + i);
    const v = (el.value || "").trim();
    if (c.kind === "secret" && !v) return App.toast("Type the new value first.", true);
    const r = await Backend.call("set_master_setting", c.key, v, c.secret, c.label);
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not save.", true);
    App.toast("Saved " + c.label);
    this.integrations();
  },
  async saveOther(i) {
    const o = this.other[i], v = document.getElementById("igo" + i).value;
    if (o.secret && !v) return App.toast("Type the new value first.", true);
    const r = await Backend.call("set_master_setting", o.key, v, o.secret, o.description || "");
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not save.", true);
    App.toast("Saved " + o.key); this.integrations();
  },
  async saveCustom() {
    const k = (document.getElementById("igcKey").value || "").trim(), v = document.getElementById("igcVal").value;
    if (!/^[a-z][a-z0-9_]{2,40}$/.test(k)) return App.toast("Key: lowercase letters, digits and underscores (3-41 characters).", true);
    const r = await Backend.call("set_master_setting", k, v, document.getElementById("igcSec").checked, "");
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not save.", true);
    App.toast("Added " + k); this.integrations();
  },

  /* ---- platform: divisions (list + editor) ---- */
  rows: [], dv: null, dvTab: "identity", cats: null,
  async divisions() {
    const r = await Backend.call("get_division_admin");
    if (!r || !r.ok || !r.super_admin) return this.pane("settings", `<div class="empty">${esc((r && r.error) || "Super admins only.")}</div>`);
    this.rows = r.divisions; this.dv = null;
    const cards = this.rows.map((d, i) => `<div class="set-div">
        <div><b>${esc(d.name)}</b> <span class="muted">${esc(d.id)}</span> ${d.enabled ? "" : SetUI.pill("warn", "Hidden")}
          <p>${esc(d.company_name)} &middot; Intune: ${esc(d.intune_category)} &middot; ${(d.sites || []).length} site(s) &middot; ${(d.access || []).length ? (d.access.includes("*") ? "everyone" : d.access.length + " allowed") : "super admins only"}</p></div>
        <button class="ghost" onclick="Settings.dvEdit(${i})">Edit</button></div>`).join("");
    this.pane("settings", SetUI.card("Divisions", "Each division is its own set of people, devices, sites and data. Changes reach other users within about 5 minutes (or on restart).",
      cards || `<div class="empty">No divisions yet.</div>`, `<button class="primary" onclick="Settings.dvNew()">+ Add division</button>`));
  },
  /* ---- add a division: pick a template, then fill in the editor ---- */
  TEMPLATES: [
    { id: "one", title: "One site", text: "A single location. Every device and person in the division is placed at that site automatically." },
    { id: "multi", title: "Several sites", text: "Two or more locations. Devices and people are matched to a site by name prefix and city." },
    { id: "blank", title: "Blank", text: "Start empty and set everything yourself." },
    { id: "copy", title: "Copy an existing division", text: "Reuse another division's SQL server, timesheet tables, AD domain and site layout. Identity and access are NOT copied." },
  ],
  dvNew() {
    const copyOpts = this.rows.map((d, i) => `<option value="${i}">${esc(d.name)}</option>`).join("");
    this.pane("settings", SetUI.card("Add a division", "Pick a starting point. You can change everything afterwards.",
      `<div class="set-tpls">${this.TEMPLATES.map(t => `<div class="set-tpl">
          <b>${esc(t.title)}</b><p>${esc(t.text)}</p>
          ${t.id === "copy" ? `<select id="tplCopy">${copyOpts}</select>` : ""}
          <button class="primary" onclick="Settings.dvFromTemplate('${t.id}')"${t.id === "copy" && !this.rows.length ? " disabled" : ""}>Use this</button></div>`).join("")}</div>`,
      `<button class="ghost" onclick="Settings.divisions()">Back to divisions</button>`));
  },
  dvFromTemplate(id) {
    const emptySite = () => ({ code: "", name: "", city_prefixes: [], device_prefixes: [] });
    const base = { id: "", name: "", company_name: "", intune_category: "", sharepoint_hostname: "", site_path: "", ad_domain: "", sql_server: "",
      timesheet_db: "", timesheet_table: "", employee_db: "", employee_table: "", sites: [], access: [], enabled: true, _new: true };
    if (id === "one") base.sites = [emptySite()];
    else if (id === "multi") base.sites = [emptySite(), emptySite()];
    else if (id === "copy") {
      const src = this.rows[+document.getElementById("tplCopy").value] || {};
      ["ad_domain", "sql_server", "timesheet_db", "timesheet_table", "employee_db", "employee_table"].forEach(k => base[k] = src[k] || "");
      base.sites = (src.sites || []).map(s => ({ code: "", name: "", city_prefixes: [], device_prefixes: [] }));    // same number of sites, none of the names
    }
    this.dvEdit(-2, base);
  },
  async dvEdit(i, tpl) {
    this.dv = i >= 0 ? JSON.parse(JSON.stringify(this.rows[i])) : tpl || { id: "", name: "", company_name: "", intune_category: "", sharepoint_hostname: "", site_path: "", ad_domain: "", sql_server: "",
        timesheet_db: "", timesheet_table: "", employee_db: "", employee_table: "", sites: [], access: [], enabled: true, _new: true };
    this.dvTab = "identity"; this.dirty = false;
    if (this.cats === null) { const r = await Backend.call("intune_categories"); this.cats = (r && r.ok && r.categories) || []; }
    this.dvRender();
  },
  dvRender() {
    const d = this.dv, T = [["identity", "Identity"], ["sites", "Sites"], ["sql", "Directory & SQL"], ["access", "Access"], ["adv", "Advanced"]];
    const tabs = T.map(([id, l]) => `<button class="ctab${id === this.dvTab ? " active" : ""}" onclick="Settings.dvTabTo('${id}')">${l}</button>`).join("");
    let body = "";
    if (this.dvTab === "identity") {
      body = `<div class="set-grid2">
          <div class="field"><label>Display name</label><input id="dvName" value="${attr(d.name)}" oninput="Settings.dvSet('name',this.value)" placeholder="NBGTX - NBG Terrell"></div>
          <div class="field"><label>Id ${d._new ? "<span class='muted'>(short, cannot change later)</span>" : "<span class='muted'>(fixed)</span>"}</label>
            <input id="dvId" value="${attr(d.id)}" ${d._new ? "" : "disabled"} oninput="Settings.dvId(this.value)" placeholder="nbgtx"></div></div>
        <div class="field"><label>Entra company <span class="muted">(people are scoped by this exact value)</span></label>
          ${d.company_name ? `<div class="dp-chips"><span class="dp-chip">${esc(d.company_name)} <button onclick="Settings.dvSet('company_name','');Settings.dvRender()" title="Change">&times;</button></span></div>` : ""}
          <div id="dvCo" style="max-width:520px;${d.company_name ? "display:none" : ""}"></div></div>
        <div class="field" style="max-width:420px"><label>Intune device category <span class="muted">(devices are scoped by it)</span></label>
          ${this.cats && this.cats.length ? SetUI.select("dvCat", this.cats.map(c => ({ id: c, label: c })), d.intune_category, "Settings.dvSet('intune_category',this.value)", "Choose…")
            : `<input id="dvCat" value="${attr(d.intune_category)}" oninput="Settings.dvSet('intune_category',this.value)"><p class="muted" style="font-size:12px;margin:6px 0 0">Could not load the category list from Intune; type the exact name.</p>`}</div>
        <label class="set-check"><input type="checkbox" ${d.enabled ? "checked" : ""} onchange="Settings.dvSet('enabled',this.checked)"> Visible (untick to hide this division from everyone)</label>
        <p class="muted" style="font-size:12px">Time zone is set per division on <b>Settings &rarr; General</b> while you are in that division.</p>`;
    } else if (this.dvTab === "sites") body = `<div id="dvSites"></div>`;
    else if (this.dvTab === "sql") body = `<div id="dvSql"></div>`;
    else if (this.dvTab === "access") {
      body = `<div class="field"><label>Who can see this division</label><div id="dvAccChips"></div>
          <div class="set-acc"><div id="dvAccUser"></div><div id="dvAccGroup"></div><button class="ghost" type="button" onclick="Settings.dvAcc('*')">+ Everyone</button></div>
          <p class="muted" style="font-size:12px;margin-top:8px">Empty = super admins only. Mark at least one person or group as <b>Admin</b> so the division can manage itself. This controls what the app shows; people with access to the SharePoint site can still open the lists directly.</p></div>`;
    } else body = `<p class="muted" style="margin-top:0">Only needed to import data from an older per-division SharePoint site.</p>
        <div class="set-grid2"><div class="field"><label>Old SharePoint host</label><input value="${attr(d.sharepoint_hostname)}" oninput="Settings.dvSet('sharepoint_hostname',this.value)" placeholder="nucor.sharepoint.com"></div>
        <div class="field"><label>Old site path</label><input value="${attr(d.site_path)}" oninput="Settings.dvSet('site_path',this.value)" placeholder="/sites/NBGW/systems"></div></div>`;
    this.pane("settings", `<div class="set-card"><div class="set-card-head"><h3>${d._new ? "Add division" : "Edit " + esc(d.name)}</h3></div>
      <div class="config-tabs" style="padding:0 18px">${tabs}</div><div class="set-card-body">${body}</div>
      <div class="modal-foot"><button class="ghost" onclick="Settings.dvCancel()">Back to divisions</button><button class="primary" onclick="Settings.dvSave()">Save division</button></div></div>`);
    if (this.dvTab === "identity" && !d.company_name) DirPicker.mount("dvCo", "company", it => { this.dvSet("company_name", it.name); this.dvRender(); }, "Search company names (type 2+ letters)…");
    if (this.dvTab === "sites") SitesEditor.render("dvSites", d, () => this.markDirty());
    if (this.dvTab === "sql") SqlEditor.render("dvSql", d, () => this.markDirty());
    if (this.dvTab === "access") this.dvAccRender();
  },
  dvTabTo(t) { this.dvTab = t; this.dvRender(); },
  dvSet(k, v) { this.dv[k] = typeof v === "string" ? v.trim() : v; this.markDirty(); },
  dvId(v) { this.dv.id = v.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 20); this.dv._idTouched = true; this.markDirty(); },
  dvAccRender() {
    const acc = this.dv.access || [];
    document.getElementById("dvAccChips").innerHTML = SetUI.aclTable(acc, "Settings.dvAccRole", "Settings.dvAccDel", true)
      || "<span class='muted'>Nobody yet: only super admins can see this division</span>";
    DirPicker.mount("dvAccUser", "user", it => this.dvAcc(it.upn), "Add a person (name or sign-in)…");
    DirPicker.mount("dvAccGroup", "group", it => this.dvAcc("group:" + it.id + "|" + it.name), "Add an Entra group…");
  },
  dvAcc(v) { const a = this.dv.access = this.dv.access || []; if (!a.includes(v)) a.push(v); this.markDirty(); this.dvAccRender(); },
  dvAccRole(i, r) { SetUI.setRole(this.dv.access, i, r); this.markDirty(); },
  dvAccDel(i) { this.dv.access.splice(i, 1); this.markDirty(); this.dvAccRender(); },
  dvCancel() {
    if (this.dirty && !confirm("Discard your changes to this division?")) return;
    this.dirty = false; this.divisions();
  },
  async dvSave() {
    const d = this.dv;
    if (d._new && !d._idTouched && !d.id) d.id = (d.name.split(" ")[0] || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20);
    const r = await Backend.call("save_division", { ...d, sites: (d.sites || []).filter(s => s.code) });
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not save.", true);
    this.dirty = false;
    App.toast("Saved " + d.name);
    await Divisions.load();
    this.rail();
    this.divisions();
  },
};
