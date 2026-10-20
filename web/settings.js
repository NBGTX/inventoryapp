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
  card(title, sub, body, foot) {          // `sub` is kept for call-site compatibility; explanations now live in help.js
    return `<div class="set-card"><div class="set-card-head"><h3>${esc(title)}</h3></div>
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
  m: null, host: "", onDirty: () => {}, allowScopeEdit: false, categories: [],
  render(hostId, m, onDirty, options = {}) {
    this.m = m; this.host = hostId; this.onDirty = onDirty || (() => {});
    this.allowScopeEdit = !!options.allowScopeEdit;
    this.categories = options.categories || [];
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
        </div>${this.allowScopeEdit ? `<div class="set-site-grid" style="margin-top:12px">
          <div class="field"><label>Entra company names</label><div id="${hostId}-co${k}"></div></div>
          <div class="field"><label>Intune device categories</label><div id="${hostId}-cat${k}"></div></div>
        </div>` : ""}</div>`).join("") || `<div class="empty" style="padding:16px">No sites yet.</div>`) +
      `<button class="ghost" type="button" style="margin-top:10px" onclick="SitesEditor.add()">+ Add site</button>`;
    m.sites.forEach((s, k) => {
      s.city_prefixes = s.city_prefixes || []; s.device_prefixes = s.device_prefixes || [];
      ChipInput.mount(`${hostId}-c${k}`, s.city_prefixes, () => this.onDirty(), "city, Enter");
      ChipInput.mount(`${hostId}-d${k}`, s.device_prefixes, () => this.onDirty(), "prefix, Enter");
      if (this.allowScopeEdit) {
        s.company_names = s.company_names || []; s.intune_categories = s.intune_categories || [];
        const coHost = document.getElementById(`${hostId}-co${k}`);
        if (coHost) {
          coHost.innerHTML = `<div class="dp-chips">${s.company_names.map((n, i) => `<span class="dp-chip">${esc(n)} <button type="button" title="Remove" onclick="SitesEditor.removeScope(${k},'company_names',${i})">&times;</button></span>`).join("")}</div><div id="${hostId}-coPick${k}"></div>`;
          DirPicker.mount(`${hostId}-coPick${k}`, "company", it => this.addCompany(k, it.name), "Search Entra company names…");
        }
        const catHost = document.getElementById(`${hostId}-cat${k}`);
        if (catHost) {
          catHost.innerHTML = `<div class="dp-chips">${s.intune_categories.map((n, i) => `<span class="dp-chip">${esc(n)} <button type="button" title="Remove" onclick="SitesEditor.removeScope(${k},'intune_categories',${i})">&times;</button></span>`).join("")}</div>
            ${this.categories.length ? SetUI.select(`${hostId}-catPick${k}`, this.categories.map(c => ({ id: c, label: c })), "", `SitesEditor.addCategory(${k},this.value);this.value=''`, "Add a category…") : `<input placeholder="Type exact Intune category" onkeydown="if(event.key==='Enter'){event.preventDefault();SitesEditor.addCategory(${k},this.value);this.value=''}">`}`;
        }
      }
    });
  },
  set(k, f, v) { this.m.sites[k][f] = v; this.onDirty(); },
  addCompany(k, name) { const a = this.m.sites[k].company_names; if (name && !a.some(x => x.toLowerCase() === name.toLowerCase())) a.push(name); this.onDirty(); this.render(this.host, this.m, this.onDirty, { allowScopeEdit: this.allowScopeEdit, categories: this.categories }); },
  addCategory(k, name) { const a = this.m.sites[k].intune_categories, v = String(name || "").trim(); if (v && !a.some(x => x.toLowerCase() === v.toLowerCase())) a.push(v); this.onDirty(); this.render(this.host, this.m, this.onDirty, { allowScopeEdit: this.allowScopeEdit, categories: this.categories }); },
  removeScope(k, field, i) { this.m.sites[k][field].splice(i, 1); this.onDirty(); this.render(this.host, this.m, this.onDirty, { allowScopeEdit: this.allowScopeEdit, categories: this.categories }); },
  add() { this.m.sites.push({ code: "", name: "", city_prefixes: [], device_prefixes: [], company_names: [], intune_categories: [] }); this.onDirty(); this.render(this.host, this.m, this.onDirty, { allowScopeEdit: this.allowScopeEdit, categories: this.categories }); },
  del(k) { this.m.sites.splice(k, 1); this.onDirty(); this.render(this.host, this.m, this.onDirty, { allowScopeEdit: this.allowScopeEdit, categories: this.categories }); },
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
  su: false, role: "user", tab: "general", dirty: false, own: null, prefs: null, searchQuery: "",
  THEME_KEY: "nbg_hub_theme",
  THEMES: [
    { id: "nbg-green", name: "NBG Green", note: "Current Hub theme" },
    { id: "dark", name: "Dark", note: "Charcoal with blue accents" },
    { id: "light", name: "Light", note: "Bright neutral surfaces" },
    { id: "high-contrast", name: "High Contrast", note: "Black, white, and bold focus" },
    { id: "catppuccin-mocha", name: "Catppuccin Mocha", note: "Soft plum and lavender" },
    { id: "dracula", name: "Dracula", note: "Purple, cyan, and pink" },
    { id: "github-dark", name: "GitHub Dark", note: "Deep charcoal with green and blue" },
  ],
  RANK: { user: 1, admin: 2, super: 3 }, allowed: [],
  currentTheme() {
    try {
      const stored = localStorage.getItem(this.THEME_KEY);
      return this.THEMES.some(theme => theme.id === stored) ? stored : "nbg-green";
    } catch (e) { return "nbg-green"; }
  },
  themeCard() {
    const selected = this.currentTheme();
    const options = this.THEMES.map(theme => `<label class="theme-option${theme.id === selected ? " selected" : ""}">
      <input type="radio" name="hubTheme" value="${theme.id}"${theme.id === selected ? " checked" : ""} onchange="Settings.setTheme(this.value)">
      <span class="theme-swatch ${theme.id}" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="theme-option-copy"><b>${theme.name}</b><small>${theme.note}</small></span></label>`).join("");
    return SetUI.card("Appearance", "", `<p class="muted theme-caption">Choose colors for your Hub on this computer. Your choice does not change other users’ screens.</p><div class="theme-options" role="radiogroup" aria-label="Hub color theme">${options}</div>`);
  },
  setTheme(theme) {
    if (!this.THEMES.some(option => option.id === theme)) return;
    try {
      if (theme === "nbg-green") localStorage.removeItem(this.THEME_KEY);
      else localStorage.setItem(this.THEME_KEY, theme);
    } catch (e) {}
    if (theme === "nbg-green") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    document.querySelectorAll(".theme-option").forEach(option => {
      const input = option.querySelector("input");
      option.classList.toggle("selected", !!input && input.value === theme);
    });
  },
  async refreshAccess() {
    const [r, ro] = await Promise.all([Backend.call("get_master_settings"), Backend.call("get_my_role")]);
    this.su = !!(r && r.ok && r.super_admin);
    this.role = (ro && ro.ok && ro.role) || "user";
    this.allowed = (ro && ro.ok && ro.sections) || [];          // sections beyond General this role may use (Platform > Role access)
    if (typeof DataMode !== "undefined") DataMode.refresh();            // the Data button is for super admins; re-check now that the account is known
    const nav = document.getElementById("navActivity"); if (nav) nav.classList.toggle("hidden", !(this.su || this.role === "super" || this.role === "admin"));   // the Activity page is for admins
    const hb = document.getElementById("dashHealth"); if (hb) hb.classList.toggle("hidden", !(this.su || this.role === "super" || this.role === "admin"));          // so is the Health check
  },
  can(min) { return (this.RANK[this.role] || 0) >= this.RANK[min]; },
  open(tab) {
    if (Nav._cur === "settings") return this.go(tab || this.tab);
    if (tab) this.tab = tab;
    Nav.go("settings");
  },
  /* every division section; General is always shown, the rest depend on Platform > Role access */
  SECTIONS: [["general", "General"], ["models", "Model departments"], ["access", "Who has access"],
             ["sites", "Sites"], ["sql", "Directory & SQL"], ["perms", "Group baselines"], ["storage", "Storage"]],
  GENERAL_SEARCH: [
    ["about", "About division", "identity company name sites division"], ["personal", "My preferences", "default division appearance theme"],
    ["timezone", "Time zone", "clock date time"], ["inventory", "Inventory", "stock device options department"],
    ["ot", "OT devices", "controller stale verification areas lines panels owners"], ["mail", "Mail delivery", "smtp relay server from address"],
    ["alerts", "Recipients & tests", "email notification recipients test messages"], ["project", "Project Hub", "project address url"],
  ],
  SEARCH_TERMS: {
    models: "model department software hardware models", access: "members roles permissions administrators", sites: "site location code city Entra company Intune category",
    sql: "directory active directory SQL server database connection", perms: "group baseline permissions security groups", storage: "data storage files folder backup",
    divisions: "division company identity sites", admins: "super admin administrators", sync: "sync refresh all divisions", issuenotify: "issue notifications email recipients",
    scopes: "people search scope directory visibility", links: "NBT Sites links", template: "checklist template provisioning", ottypes: "OT device types controllers",
    roles: "role access permissions", integrations: "integrations options settings",
  },
  groups() {
    return [
      { title: Divisions.label(), items: this.SECTIONS.filter(x => x[0] === "general" || this.allowed.includes(x[0])) },
      ...(this.su ? [{ title: "Platform (super admin)", items: [["divisions", "Divisions"], ["admins", "Super admins"], ["sync", "Sync all divisions"], ["issuenotify", "Issue notifications"], ["scopes", "People-search scopes"], ["links", "NBT Sites"], ["template", "Template checklists"], ["ottypes", "OT device types"], ["roles", "Role access"], ["integrations", "Integrations & options"]] }] : []),
    ];
  },
  async load() {
    await this.refreshAccess();
    const valid = this.groups().some(g => g.items.some(i => i[0] === this.tab));
    if (!valid) this.tab = "general";
    document.querySelectorAll(".side-config[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === "settings"));
    document.getElementById("setSub").textContent = "Settings for " + Divisions.label() + (this.su ? " and the whole platform." : ".");
    this.rail();
    await this.show(this.tab, true);
  },
  rail() {
    const query = String(this.searchQuery || "").trim().toLocaleLowerCase();
    if (query) {
      const terms = query.split(/\s+/).filter(Boolean);
      const hits = this.searchItems().filter(item => terms.every(term => item.search.toLocaleLowerCase().includes(term)));
      document.getElementById("setRail").innerHTML = hits.length
        ? `<div class="set-search-results" role="list">${hits.map(item => `<button type="button" class="set-rail-item set-search-result" role="listitem" onclick="Settings.searchGo('${item.tab}'${item.sub ? `,'${item.sub}'` : ""})"><span>${esc(item.label)}</span><small>${esc(item.breadcrumb)}</small></button>`).join("")}</div>`
        : `<p class="set-search-empty">No settings match “${esc(this.searchQuery)}”.</p>`;
      return;
    }
    document.getElementById("setRail").innerHTML = this.groups().map(g => {
      const items = g.items.map(([id, label]) =>
        `<button class="set-rail-item${id === this.tab ? " active" : ""}"${id === this.tab ? ` aria-current="page"` : ""} onclick="Settings.go('${id}')">${esc(label)}</button>`).join("");
      if (g.title.startsWith("Platform")) return `<details class="set-rail-group"${g.items.some(([id]) => id === this.tab) ? " open" : ""}><summary>${esc(g.title)}</summary><div>${items}</div></details>`;
      return `<div class="set-rail-title">${esc(g.title)}</div>${items}`;
    }).join("");
  },
  searchItems() {
    const items = [];
    for (const group of this.groups()) for (const [tab, label] of group.items) {
      items.push({ tab, label, breadcrumb: group.title, search: `${label} ${group.title} ${this.SEARCH_TERMS[tab] || ""}` });
      if (tab === "general") for (const [sub, subLabel, keywords] of this.GENERAL_SEARCH)
        items.push({ tab: "general", sub, label: subLabel, breadcrumb: `${group.title} · General`, search: `${subLabel} ${group.title} General ${keywords}` });
    }
    return items;
  },
  filterRail(value) { this.searchQuery = String(value || ""); this.rail(); },
  async searchGo(tab, subsection) {
    this.searchQuery = "";
    const input = document.getElementById("setSearch"); if (input) input.value = "";
    if (tab !== this.tab) {
      if (!this.confirmLeave()) { this.rail(); return; }
      this.tab = tab; this.dirty = false; this.rail(); await this.show(tab);
    }
    if (subsection) { this.generalSection = subsection; this.selectGeneralSection(subsection); }
    this.rail();
  },
  confirmLeave() {
    if (!this.dirty) return true;
    if (!confirm("You have unsaved settings changes. Leave and discard them?")) return false;
    this.dirty = false;
    this.catDraft = {}; this.otherDraft = {}; this.customDraft = {};
    return true;
  },
  /* "Discard changes": reload the saved version of the section and say so */
  async discard(tab) { this.dirty = false; await this.show(tab); App.toast("Changes discarded: showing the saved version."); },
  async go(tab) {
    if (tab === this.tab && !this.dirty) return;
    if (!this.confirmLeave()) return;
    this.tab = tab; this.dirty = false; this.rail();
    await this.show(tab);
  },
  markDirty(btnId) { this.dirty = true; const b = document.getElementById(btnId || "setSave"); if (b) b.disabled = false; },
  pane(owner, html, helpKey) {
    const p = document.getElementById("setPane");
    p.dataset.owner = owner;
    if (html !== undefined) p.innerHTML = (owner === "settings" ? Help.box(helpKey || "set-" + this.tab) : "") + html;
    return p;
  },
  async show(tab, force) {
    Depts._page = false;
    this.pane("settings", `<div class="empty">Loading…</div>`);
    const dep = { models: "models", links: "sites", perms: "perms", storage: "storage" }[tab];
    if (dep) { this.pane("depts"); Depts._page = true; await Depts.openPage(dep); return; }
    const fn = { general: "general", access: "accessTab", sites: "sitesTab", sql: "sqlTab", divisions: "divisions", admins: "admins", roles: "roles", template: "templateTab", scopes: "scopesTab", issuenotify: "issueNotifyTab", ottypes: "otTypesTab", sync: "syncAll", integrations: "integrations" }[tab];
    try { await this[fn](); } catch (e) { this.pane("settings", `<div class="empty">Could not open this section: ${esc(String(e && e.message || e))}</div>`); }
  },

  /* ---- General: facts + time zone ---- */
  async general() {
    const [o, p] = await Promise.all([Backend.call("get_own_division"), Backend.call("get_division_prefs")]);
    if (!o || !o.ok) return this.pane("settings", `<div class="empty">${esc((o && o.error) || "Could not read this division.")}</div>`);
    this.own = o; this.prefs = (p && p.ok) ? p : { timezone: "", default: "", effective: "", zones: [], smtp: {} };
    const zl = this.prefs.zones, zlabel = id => (zl.find(z => z.id === id) || {}).label || id;
    const def = this.prefs.default ? zlabel(this.prefs.default) : "this PC's own time zone";
    const sites = (o.sites || []).map(s => `<span class="dp-chip">${esc(s.code)} <i>${esc(s.name || "")}</i></span>`).join("") || `<span class="muted">none yet</span>`;
    const canEdit = this.can("admin");
    const mp = await Backend.call("get_my_prefs");
    this.my = (mp && mp.ok) ? mp : { divisions: [], default_division: "" };
    const fact = (k, v) => `<div class="set-fact"><span>${k}</span><b>${v || "<i class='muted'>not set</i>"}</b></div>`;
    const about = SetUI.card("About this division", "Division name and ID are managed by a super admin. Site-specific Entra company names and Intune categories are managed under <b>Sites</b>.",
        `<div class="set-facts">${fact("Name", esc(o.name))}${fact("Id", esc(o.id))}${fact("Entra companies", esc((o.company_names || [o.company_name].filter(Boolean)).join(", ")))}${fact("Intune categories", esc((o.intune_categories || [o.intune_category].filter(Boolean)).join(", ")))}</div>
         <div style="margin-top:12px"><span class="muted" style="font-size:12px">Sites</span><div class="dp-chips" style="margin-top:6px">${sites}</div></div>`);
    const personal = this.themeCard() +
      (this.my.divisions.length > 1 ? SetUI.card("My default division", "The division NBG Hub opens in each time you start it. Only you see this choice.",
        `<div class="field" style="max-width:420px"><label>Open in</label>
           ${SetUI.select("mdSel", this.my.divisions.map(d => ({ id: d.id, label: d.name })), this.my.default_division, "Settings.markDirty('mdSave')", "The last division I used")}</div>`,
        `<button class="primary" id="mdSave" onclick="Settings.saveMyDiv()" disabled>Save my default</button>`) : "");
    const timezone = SetUI.card("Time zone", "Every date and time in the app for this division is shown in this zone." + (canEdit ? "" : " Division admins can change it."),
        `<div class="field" style="max-width:420px"><label>Time zone for ${esc(Divisions.label())}</label>
           ${SetUI.select("tzSel", zl.map(z => ({ id: z.id, label: z.label })), this.prefs.timezone, "Settings.tzPreview()", "Use the default (" + def + ")", !canEdit)}</div>
         <p id="tzPrev" class="muted" style="margin:10px 0 0"></p>`,
        canEdit ? `<button class="primary" id="setSave" onclick="Settings.saveTz()" disabled>Save time zone</button>` : "");
    const inventory = (canEdit ? SetUI.card("Inventory options", "How this division's devices are synced and grouped.",
        `<div class="field" style="max-width:460px"><label>Devices to sync from Intune</label>
           ${SetUI.select("ioOs", this.prefs.device_os_options || [], this.prefs.device_os, "Settings.markDirty('ioSave')")}</div>
         <div class="field"><label>Hot spare departments <span class="muted">(Other is always added at the end)</span></label>
           <div id="ioDepts" style="max-width:560px"></div>
           <p class="muted" style="margin:6px 0 0;font-size:12px">These are the department groups on the Hot spares window. Press Enter after each name; click &times; to remove one.</p></div>
         <div class="field" style="max-width:240px"><label>Minimum hot spare stock</label><input id="ioMinimum" type="number" min="0" max="500" value="${Number(this.prefs.hot_spare_minimum || 0)}" oninput="Settings.markDirty('ioSave')"><p class="muted" style="font-size:12px">Dashboard flags stock below this number. Zero disables alert.</p></div>`,
        `<button class="primary" id="ioSave" onclick="Settings.saveInv()" disabled>Save inventory options</button>`) : "");
    const otSettings = canEdit ? SetUI.card("OT device choices and review cycle", "Maintain standard choices used when adding or editing OT devices. Existing records keep their current values.",
        `<div class="ot-settings-lists">
          <div class="field"><label>Area / location</label><div id="otAreas"></div></div>
          <div class="field"><label>Line / process</label><div id="otLines"></div></div>
          <div class="field"><label>Panel / cabinet</label><div id="otPanels"></div></div>
          <div class="field"><label>Owner / team</label><div id="otOwners"></div></div>
         </div><div class="field" style="max-width:320px;margin-top:14px"><label for="otStaleMonths">Mark device information stale after</label>
           <select id="otStaleMonths" onchange="Settings.markDirty('otListsSave')"><option value="3" ${Number(this.prefs.ot_stale_months || 6) === 3 ? "selected" : ""}>3 months</option><option value="6" ${Number(this.prefs.ot_stale_months || 6) === 6 ? "selected" : ""}>6 months</option><option value="12" ${Number(this.prefs.ot_stale_months || 6) === 12 ? "selected" : ""}>1 year</option><option value="24" ${Number(this.prefs.ot_stale_months || 6) === 24 ? "selected" : ""}>2 years</option></select>
           <p class="muted" style="font-size:12px">Records need a fresh verification within this period.</p></div>
         <p class="muted" style="font-size:12px;margin:8px 0 0">Press Enter after each choice; click &times; to remove one. Site choices come from this division's Sites settings.</p>`,
        `<button class="primary" id="otListsSave" onclick="Settings.saveOtLists()" disabled>Save OT choices</button>`) : "";
    const mail = SetUI.card("Mail delivery", "Each division can use its own mail relay. If relay is off or incomplete, delivery falls back to the platform route.",
        `<div id="smtpState" class="smtp-state ${this.prefs.smtp && this.prefs.smtp.enabled && this.prefs.smtp.server && this.prefs.smtp.from_address ? "ok" : "warn"}">${this.prefs.smtp && this.prefs.smtp.enabled && this.prefs.smtp.server && this.prefs.smtp.from_address ? "SMTP relay enabled for this division" : this.prefs.smtp && this.prefs.smtp.enabled ? "SMTP enabled, but server or From address is missing" : "SMTP relay off — platform delivery route will be used"}</div>
          <p class="muted" style="margin:0 0 12px">Anonymous relay; Hub stores no SMTP credentials. Prefer STARTTLS when server supports it; use None only for trusted internal relays.</p>
          <label class="field" style="display:flex;align-items:center;gap:9px;max-width:460px"><input id="smtpEnabled" type="checkbox" style="width:auto;padding:0;border:0;background:transparent" ${this.prefs.smtp && this.prefs.smtp.enabled ? "checked" : ""} ${canEdit ? "" : "disabled"} onchange="Settings.markDirty('smtpSave');Settings.smtpPreview()"><span>Enable this division's SMTP relay</span></label>
         <div class="fields" style="margin-top:10px">
            <div class="field" style="min-width:260px;flex:2"><label>SMTP server</label><input id="smtpServer" value="${attr((this.prefs.smtp || {}).server || "")}" placeholder="smtp.division.example" ${canEdit ? "" : "disabled"} oninput="Settings.markDirty('smtpSave');Settings.smtpPreview()"></div>
           <div class="field" style="max-width:150px"><label>Port</label><input id="smtpPort" type="number" min="1" max="65535" value="${attr((this.prefs.smtp || {}).port || 25)}" ${canEdit ? "" : "disabled"} oninput="Settings.markDirty('smtpSave')"></div>
           <div class="field" style="min-width:190px"><label>Connection security</label>${SetUI.select("smtpSecurity", [{ id: "none", label: "None (internal relay)" }, { id: "starttls", label: "STARTTLS" }, { id: "ssl", label: "SSL/TLS" }], (this.prefs.smtp || {}).security || "none", "Settings.markDirty('smtpSave')", undefined, !canEdit)}</div>
            <div class="field" style="min-width:260px;flex:2"><label>From address</label><input id="smtpFrom" type="email" value="${attr((this.prefs.smtp || {}).from_address || "")}" placeholder="hub-notifications@division.example" ${canEdit ? "" : "disabled"} oninput="Settings.markDirty('smtpSave');Settings.smtpPreview()"></div>
         </div>`,
         (canEdit ? `<button class="primary" id="smtpSave" onclick="Settings.saveSmtp()" disabled>Save SMTP settings</button>` : ""));
    const alerts = SetUI.card("Recipients and test emails", "Platform recipients receive selected issue events across divisions. This list adds recipients for this division's issue events and operational alerts.",
        `<div id="divNotifyTable"></div><div style="margin-top:12px;max-width:520px" id="divNotifyPick"></div>
          <p class="muted" style="font-size:12px;margin:8px 0 12px">Operational alerts are sent as one summary per change or sweep. Delivery uses this division's SMTP relay when enabled, otherwise the platform route.</p>
         <div class="fields" style="align-items:end">
           <div class="field" style="max-width:340px;flex:1"><label for="divNotifyTestEvent">Preview an email type</label>
             <select id="divNotifyTestEvent">${Object.entries(this.prefs.notification_events || {}).map(([id, label]) => `<option value="${attr(id)}">${esc(label)}</option>`).join("")}</select></div>
           <button class="ghost" onclick="Settings.testDivisionMail()">Send selected sample</button>
           <button class="ghost" onclick="Settings.testAllDivisionMail()">Send all ${Object.keys(this.prefs.notification_events || {}).length} samples</button>
         </div>
         <p class="muted" style="font-size:12px;margin:8px 0 0">Sends only to your signed-in account. Sample creates no issue or permission change.</p>`,
         canEdit ? `<button class="primary" id="divNotifySave" onclick="Settings.saveDivNotify()" disabled>Save division recipients</button>` : "");
    const integrations = SetUI.card("Project Hub", "Where the Project Hub item in the sidebar opens for " + esc(Divisions.label()) + (canEdit ? "." : ". Division admins can change it."),
        `<div class="field" style="max-width:560px"><label>Project Hub address</label>
           <input id="phUrl" value="${attr(this.prefs.project_hub_url || "")}" placeholder="${attr(this.prefs.project_hub_default)}" ${canEdit ? "" : "disabled"} oninput="Settings.markDirty('phSave')"></div>
         <p class="muted" style="margin:8px 0 0;font-size:12px">Leave blank to use the platform default: ${esc(this.prefs.project_hub_default)}. Must start with https://.</p>`,
        `<button class="ghost" onclick="Settings.phOpen()">Open this address</button>` + (canEdit ? `<button class="primary" id="phSave" onclick="Settings.savePh()" disabled>Save address</button>` : ""));
    const sections = [
      ["about", "About division", about],
      ["personal", "My preferences", personal],
      ["timezone", "Time zone", timezone],
      ["inventory", "Inventory", inventory],
      ["ot", "OT devices", otSettings],
      ["mail", "Mail delivery", mail],
      ["alerts", "Recipients & tests", alerts],
      ["project", "Project Hub", integrations],
    ].filter(([, , content]) => content);
    if (!sections.some(([id]) => id === this.generalSection)) this.generalSection = "about";
    this.pane("settings", `<div class="settings-general-tabs" role="tablist" aria-label="Division settings sections">${sections.map(([id, label]) => `<button type="button" role="tab" aria-selected="${id === this.generalSection}" aria-controls="generalPanel-${id}" id="generalTab-${id}" class="settings-general-tab${id === this.generalSection ? " active" : ""}" onclick="Settings.selectGeneralSection('${id}')">${label}</button>`).join("")}</div>
      ${sections.map(([id, label, content]) => `<section id="generalPanel-${id}" class="settings-general-panel${id === this.generalSection ? "" : " hidden"}" role="tabpanel" aria-labelledby="generalTab-${id}">${content}</section>`).join("")}`, "set-general-" + this.generalSection);
    document.getElementById("tzSel")?.addEventListener("change", () => this.markDirty());
    if (document.getElementById("ioDepts")) {
      this.ioDepts = ((this.prefs.hot_spare_depts || []).length ? this.prefs.hot_spare_depts : (this.prefs.hot_spare_default || [])).slice();
      ChipInput.mount("ioDepts", this.ioDepts, () => this.markDirty("ioSave"), "department, Enter");
    }
    if (document.getElementById("otAreas")) {
      const lists = this.prefs.ot_lists || {};
      this.otLists = { areas: [...(lists.areas || [])], lines: [...(lists.lines || [])], panels: [...(lists.panels || [])], owners: [...(lists.owners || [])] };
      [["otAreas", "areas", "area / location"], ["otLines", "lines", "line / process"], ["otPanels", "panels", "panel / cabinet"], ["otOwners", "owners", "owner / team"]]
        .forEach(([host, key, placeholder]) => ChipInput.mount(host, this.otLists[key], () => this.markDirty("otListsSave"), placeholder + ", Enter"));
    }
    this.divSubs = (this.prefs.issue_subscribers || []).map(s => ({ ...s, events: [...(s.events || [])] }));
    this.divEvents = this.prefs.notification_events || {};
    this.divNotifyDraw(!canEdit);
    this.tzPreview();
  },
  selectGeneralSection(id) {
    const panel = document.getElementById(`generalPanel-${id}`);
    if (!panel) return;
    this.generalSection = id;
    document.querySelectorAll(".settings-general-tab").forEach(tab => {
      const active = tab.id === `generalTab-${id}`;
      tab.classList.toggle("active", active); tab.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll(".settings-general-panel").forEach(section => section.classList.toggle("hidden", section.id !== `generalPanel-${id}`));
  },
  async saveMyDiv() {
    const r = await Backend.call("save_my_prefs", document.getElementById("mdSel").value);
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not save.", true);
    this.dirty = false;
    App.toast(r.default_division ? "Saved. NBG Hub will open in that division." : "Saved. NBG Hub will open in the last division you used.");
    this.general();
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
  async saveInv() {
    const r = await Backend.call("save_division_prefs", null, null, document.getElementById("ioOs").value, this.ioDepts, null, null, Number(document.getElementById("ioMinimum").value || 0));
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not save.", true);
    this.dirty = false;
    await Tz.load();
    App.toast("Inventory options saved.");
    this.general();
  },
  async saveOtLists() {
    const lists = this.otLists || { areas: [], lines: [], panels: [], owners: [] };
    const staleMonths = Number(document.getElementById("otStaleMonths")?.value || 6);
    const r = await Backend.call("save_division_prefs", null, null, null, null, null, null, null, lists, staleMonths);
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not save OT choices.", true);
    this.prefs.ot_lists = lists;
    this.prefs.ot_stale_months = staleMonths;
    this.dirty = false;
    App.toast("OT device choices saved.");
    this.general();
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
  async saveSmtp() {
    const smtp = {
      enabled: document.getElementById("smtpEnabled").checked,
      server: document.getElementById("smtpServer").value.trim(),
      port: document.getElementById("smtpPort").value,
      security: document.getElementById("smtpSecurity").value,
      from_address: document.getElementById("smtpFrom").value.trim()
    };
    const r = await Backend.call("save_division_prefs", null, null, null, null, smtp);
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not save SMTP settings.", true);
    this.dirty = false;
    App.toast("SMTP settings saved for " + Divisions.label() + ".");
    this.general();
  },
  smtpPreview() {
    const state = document.getElementById("smtpState"); if (!state) return;
    const enabled = !!document.getElementById("smtpEnabled")?.checked;
    const ready = enabled && !!document.getElementById("smtpServer")?.value.trim() && !!document.getElementById("smtpFrom")?.value.trim();
    state.className = `smtp-state ${ready ? "ok" : "warn"}`;
    state.textContent = ready ? "SMTP relay enabled for this division" : enabled ? "SMTP enabled, but server or From address is missing" : "SMTP relay off — platform delivery route will be used";
  },
  async testDivisionMail() {
    const event = document.getElementById("divNotifyTestEvent")?.value || "new";
    const label = (this.divEvents || {})[event] || event;
    const r = await Backend.call("division_notify_test", event);
    App.toast(r && r.ok ? `${label} sample sent to you via ${r.via}.` : ((r && r.error) || "Could not send sample email."), !(r && r.ok));
  },
  async testAllDivisionMail() {
    const events = Object.keys(this.divEvents || {});
    const results = [];
    for (const event of events) {
      const result = await Backend.call("division_notify_test", event);
      results.push({ event, ok: !!(result && result.ok), via: result && result.via, error: result && result.error });
    }
    const sent = results.filter(x => x.ok).length;
    const failed = results.filter(x => !x.ok);
    const message = failed.length
      ? `Sent ${sent} of ${events.length} samples. Failed: ${failed.map(x => (this.divEvents || {})[x.event] || x.event).join(", ")}. ${failed[0].error || "Check email settings."}`
      : `Sent all ${sent} email samples to you.`;
    App.toast(message, failed.length > 0);
  },
  divNotifyDraw(readOnly) {
    const root = document.getElementById("divNotifyTable"); if (!root) return;
    const events = Object.keys(this.divEvents || {});
    const shortLabel = { new: "New issue", status: "Status", comment: "Comments", boneyard: "Boneyard", sharepoint: "SharePoint", software: "Not allowed software", device: "Device checkout", inventory: "Inventory alerts", ot: "OT review" };
    root.innerHTML = this.divSubs.length
      ? `<div style="overflow:auto"><table class="ms-table"><thead><tr><th>Person</th>${events.map(e => `<th style="text-align:center" title="${attr(this.divEvents[e])}">${esc(shortLabel[e] || this.divEvents[e])}</th>`).join("")}<th></th></tr></thead><tbody>` +
        this.divSubs.map((s, i) => `<tr><td>${esc(s.name)} <span class="muted">${esc(s.upn)}</span></td>` +
          events.map(e => `<td style="text-align:center"><input type="checkbox" class="cb"${s.events.includes(e) ? " checked" : ""} ${readOnly ? "disabled" : ""} onchange="Settings.divNotifyEvent(${i},'${e}',this.checked)"></td>`).join("") +
          `<td style="text-align:right">${readOnly ? "" : `<button class="cfg-del" onclick="Settings.divNotifyRemove(${i})" title="Remove">&times;</button>`}</td></tr>`).join("") + `</tbody></table></div>`
      : `<p class="muted">No division-specific recipients yet.</p>`;
    if (!readOnly) DirPicker.mount("divNotifyPick", "user", it => this.divNotifyAdd(it), "Add a person to notify (name or sign-in)…");
  },
  divNotifyAdd(it) {
    const upn = (it.upn || "").trim().toLowerCase();
    if (!upn || this.divSubs.some(s => s.upn === upn)) return App.toast("Already on this division's list.");
    this.divSubs.push({ upn, name: it.name || upn, events: [] });
    this.markDirty("divNotifySave"); this.divNotifyDraw(false);
  },
  divNotifyRemove(i) { this.divSubs.splice(i, 1); this.markDirty("divNotifySave"); this.divNotifyDraw(false); },
  divNotifyEvent(i, event, enabled) {
    const events = this.divSubs[i].events, idx = events.indexOf(event);
    if (enabled && idx < 0) events.push(event); else if (!enabled && idx >= 0) events.splice(idx, 1);
    this.markDirty("divNotifySave");
  },
  async saveDivNotify() {
    const r = await Backend.call("save_division_prefs", null, null, null, null, null, this.divSubs);
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not save recipients.", true);
    this.dirty = false; App.toast("Division notification list saved."); this.general();
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
      `<button class="ghost" onclick="Settings.discard('access')">Discard changes</button><button class="primary" id="setSave" onclick="Settings.saveOwn(['access'])" disabled>Save access</button>`));
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
    this.pane("settings", SetUI.card("Sites", "Manage site codes and the matching rules used to place Entra users and Intune devices at the right site.",
      `${o.can_edit ? "" : `<div class="cfg-warn">Read-only here (Local data mode or no central site).</div>`}<div id="seSites"></div>
       <p class="muted" style="margin-top:12px;font-size:12px">Entra company names and Intune device categories are matched per site. Changes affect matching on the next sync. Changing a site code can regroup devices; existing records keep their old code until sync updates them.</p>`,
      `<button class="ghost" onclick="Settings.discard('sites')">Discard changes</button><button class="primary" id="setSave" onclick="Settings.saveOwn(['sites'])" disabled>Save sites</button>`));
    SitesEditor.render("seSites", o, () => this.markDirty(), { allowScopeEdit: true });
  },
  async sqlTab() {
    const o = await this.ownLoad(); if (!o) return;
    this.pane("settings", SetUI.card("Directory & SQL", "Where this division's timesheet and employee data live. Used by BG Tools &rarr; Timesheet and the AD lookups.",
      `${o.can_edit ? "" : `<div class="cfg-warn">Read-only here (Local data mode or no central site).</div>`}<div id="seSql"></div>`,
      `<button class="ghost" onclick="Settings.discard('sql')">Discard changes</button><button class="primary" id="setSave" onclick="Settings.saveOwn(['ad_domain','sql_server','timesheet_db','timesheet_table','employee_db','employee_table'])" disabled>Save</button>`));
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

  /* ---- platform: who is e-mailed about Issues ---- */
  async issueNotifyTab() {
    const r = await Backend.call("get_issue_notifications");
    if (!r || !r.ok || !r.super_admin) return this.pane("settings", `<div class="empty">${esc((r && r.error) || "Super admins only.")}</div>`);
    this.inf = { subs: r.subscribers.map(x => ({ ...x, events: [...x.events] })), webhook: r.webhook_set, smtp: r.smtp_ready, smtpEnabled: r.smtp_enabled, mail: r.can_mail, events: r.events };
    const how = r.smtp_ready ? SetUI.pill("ok", `SMTP ready for ${Divisions.label()}`) : r.smtp_enabled ? SetUI.pill("warn", `SMTP enabled for ${Divisions.label()} but missing server or From address`) : r.webhook_set ? SetUI.pill("ok", "Platform webhook set") : r.can_mail ? SetUI.pill("ok", "Platform direct mail available") : SetUI.pill("warn", "No platform mail route configured");
    this.pane("settings", SetUI.card("Platform issue recipients", "This list receives selected issue events across all divisions. Division-specific recipients and operational alerts are managed in the division's General > Recipients & tests tab.",
      `<p style="margin:0 0 12px">${how}${r.smtp_ready ? `<span class="muted" style="margin-left:8px">SMTP status shown for ${esc(Divisions.label())}; each division can use its own relay.</span>` : ""}
         <button class="ghost" style="margin-left:10px" onclick="Settings.open('general')">Division SMTP settings</button>
         <button class="ghost" onclick="Settings.open('integrations')">Set the webhook</button>
         <button class="ghost" onclick="Settings.inTest()">Send a test</button></p>
       <div id="inTable"></div>
       <div style="margin-top:12px;max-width:520px" id="inPick"></div>
       <h4 style="margin:22px 0 6px">Old reports</h4>
       <button class="ghost" onclick="Settings.inImport()">Import the old "Report bug / feature" lists onto the board</button>`,
      `<button class="ghost" onclick="Settings.discard('issuenotify')">Discard changes</button><button class="primary" id="setSave" onclick="Settings.inSave()" disabled>Save people</button>`));
    this.inDraw();
  },
  inDraw() {
    const t = this.inf, label = { new: "New issue", status: "Status change", comment: "New comment" };
    document.getElementById("inTable").innerHTML = t.subs.length
      ? `<table class="ms-table"><thead><tr><th>Person</th>${t.events.map(e => `<th style="text-align:center">${label[e] || e}</th>`).join("")}<th></th></tr></thead><tbody>` +
        t.subs.map((s, i) => `<tr><td>${esc(s.name)} <span class="muted">${esc(s.upn)}</span></td>` +
          t.events.map(e => `<td style="text-align:center"><input type="checkbox" class="cb"${s.events.includes(e) ? " checked" : ""} onchange="Settings.inEv(${i},'${e}',this.checked)"></td>`).join("") +
          `<td style="text-align:right"><button class="cfg-del" onclick="Settings.inDel(${i})" title="Remove">&times;</button></td></tr>`).join("") + `</tbody></table>`
      : `<p class="muted">Nobody is notified yet. Add people below.</p>`;
    DirPicker.mount("inPick", "user", it => this.inAdd(it), "Add a person to notify (name or sign-in)…");
  },
  inAdd(it) { const u = (it.upn || "").toLowerCase(); if (!u || this.inf.subs.some(s => s.upn === u)) return App.toast("Already on the list."); this.inf.subs.push({ upn: u, name: it.name || u, events: [...this.inf.events] }); this.markDirty(); this.inDraw(); },
  inDel(i) { this.inf.subs.splice(i, 1); this.markDirty(); this.inDraw(); },
  inEv(i, e, on) { const ev = this.inf.subs[i].events; const k = ev.indexOf(e); if (on && k < 0) ev.push(e); if (!on && k >= 0) ev.splice(k, 1); this.markDirty(); },
  async inSave() {
    const r = await Backend.call("save_issue_subscribers", this.inf.subs);
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not save.", true);
    this.dirty = false; App.toast("Saved."); this.issueNotifyTab();
  },
  async inTest() {
    const r = await Backend.call("issue_notify_test");
    App.toast(r && r.ok ? "Test sent to " + r.sent + " (" + r.via + ")." : ((r && r.error) || "Could not send."), !(r && r.ok));
  },
  async inImport() {
    if (!confirm("Copy every division's old bug / feature reports onto the shared board? Reports already copied are skipped.")) return;
    const r = await Backend.call("issues_import_legacy");
    App.toast(r && r.ok ? r.imported + " report(s) imported." : ((r && r.error) || "Could not import."), !(r && r.ok));
  },

  /* ---- platform: who BG Tools can search (other brands by email domain, other divisions by Entra company) ---- */
  async scopesTab() {
    const r = await Backend.call("get_search_scopes");
    if (!r || !r.ok || !r.super_admin) return this.pane("settings", `<div class="empty">${esc((r && r.error) || "Super admins only.")}</div>`);
    this.sc = { brands: r.brands.map(b => ({ ...b })), divisions: r.divisions.map(d => ({ ...d })) };
    this.pane("settings", SetUI.card("People-search scopes", "The extra groups of people the Permissions Finder can search besides the division you are in. " +
      (r.custom ? "" : "Showing the built-in lists; saving makes them yours."),
      `<h4 style="margin:0 0 6px">Other BG brands <span class="muted" style="font-weight:400">(told apart by email domain)</span></h4><div id="scBrands"></div>
       <h4 style="margin:18px 0 6px">Other divisions <span class="muted" style="font-weight:400">(told apart by Entra company name; every division in this app is added automatically)</span></h4><div id="scDivs"></div>`,
      `<button class="ghost" onclick="Settings.discard('scopes')">Discard changes</button><button class="primary" id="setSave" onclick="Settings.scSave()" disabled>Save scopes</button>`));
    this.scDraw();
  },
  scDraw() {
    const row = (kind, i, a, b, ph) => `<tr><td><input value="${attr(a)}" oninput="Settings.scSet('${kind}',${i},0,this.value)" placeholder="${attr(ph[0])}"></td>
      <td><input value="${attr(b)}" oninput="Settings.scSet('${kind}',${i},1,this.value)" placeholder="${attr(ph[1])}"></td>
      <td style="text-align:right"><button class="cfg-del" onclick="Settings.scDel('${kind}',${i})" title="Remove">&times;</button></td></tr>`;
    const table = (kind, list, f2, heads, ph) => `<table class="ms-table"><thead><tr><th>${heads[0]}</th><th>${heads[1]}</th><th></th></tr></thead><tbody>` +
      list.map((x, i) => row(kind, i, x.label, x[f2], ph)).join("") + `</tbody></table><button class="ghost" style="margin-top:8px" onclick="Settings.scAdd('${kind}')">+ Add</button>`;
    document.getElementById("scBrands").innerHTML = table("b", this.sc.brands, "domain", ["Name", "Email domain"], ["American Buildings", "example.com"]);
    document.getElementById("scDivs").innerHTML = table("d", this.sc.divisions, "company", ["Name", "Entra company name (exact)"], ["NBSIN — Waterloo", "NBSIN"]);
  },
  scSet(kind, i, col, v) {
    const list = kind === "b" ? this.sc.brands : this.sc.divisions, f2 = kind === "b" ? "domain" : "company";
    list[i][col === 0 ? "label" : f2] = v; this.markDirty();
  },
  scAdd(kind) { (kind === "b" ? this.sc.brands : this.sc.divisions).push(kind === "b" ? { label: "", domain: "" } : { label: "", company: "" }); this.markDirty(); this.scDraw(); },
  scDel(kind, i) { (kind === "b" ? this.sc.brands : this.sc.divisions).splice(i, 1); this.markDirty(); this.scDraw(); },
  async scSave() {
    const r = await Backend.call("save_search_scopes", this.sc);
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not save.", true);
    this.dirty = false; App.toast("Search scopes saved."); this.scopesTab();
  },

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
      `<button class="ghost" onclick="Settings.discard('roles')">Discard changes</button><button class="primary" id="setSave" onclick="Settings.raSave()" disabled>Save role access</button>`));
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
  async otTypesTab() {
    const r = await Backend.call("ot_device_types_get");
    if (!r || !r.ok) return this.pane("settings", `<div class="empty">${esc((r && r.error) || "Could not load OT device types.")}</div>`);
    this.otTypes = (r.types || []).slice();
    this.pane("settings", SetUI.card("OT device types", "Shared across divisions. Keep names aligned with your CSV imports and existing OT asset records. Renaming/removing a type does not delete devices already using it.",
      `<div id="otTypesList" class="ot-type-list"></div><div class="fields" style="max-width:620px;align-items:end"><div class="field" style="flex:1"><label for="otTypeNew">Add a device type</label><input id="otTypeNew" maxlength="40" placeholder="e.g. Safety relay"></div><button class="ghost" onclick="Settings.otTypeAdd()">Add type</button></div><p class="muted">Up to 40 types. Types are managed by super admins.</p>`,
      `<button class="primary" id="otTypesSave" onclick="Settings.otTypesSave()" disabled>Save device types</button>`));
    this.otTypesDraw();
  },
  otTypesDraw() {
    const root = document.getElementById("otTypesList"); if (!root) return;
    root.innerHTML = this.otTypes.map((type, i) => `<div class="ot-type-row"><input maxlength="40" value="${attr(type)}" aria-label="Device type ${i + 1}" oninput="Settings.otTypeEdit(${i},this.value)"><button class="cfg-del" title="Remove ${attr(type)}" onclick="Settings.otTypeRemove(${i})">&times;</button></div>`).join("");
  },
  otTypesDirty() { this.markDirty("otTypesSave"); },
  otTypeEdit(i, value) { this.otTypes[i] = value.slice(0, 40); this.otTypesDirty(); },
  otTypeAdd() {
    const input = document.getElementById("otTypeNew"), value = (input.value || "").trim();
    if (!value || this.otTypes.some(x => x.toLowerCase() === value.toLowerCase())) return App.toast("Enter a new, unique device type.", true);
    if (this.otTypes.length >= 40) return App.toast("Maximum 40 device types.", true);
    this.otTypes.push(value); input.value = ""; this.otTypesDraw(); this.otTypesDirty();
  },
  otTypeRemove(i) { this.otTypes.splice(i, 1); this.otTypesDraw(); this.otTypesDirty(); },
  async otTypesSave() {
    const cleaned = this.otTypes.map(x => x.trim()).filter(Boolean);
    if (!cleaned.length) return App.toast("Keep at least one device type.", true);
    const r = await Backend.call("ot_device_types_save", cleaned);
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not save device types.", true);
    this.dirty = false; this.otTypes = r.types; App.toast("OT device types saved."); this.otTypesDraw();
    const save = document.getElementById("otTypesSave"); if (save) save.disabled = true;
  },
  /* ---- platform: integrations & options (master settings as forms) ---- */
  async integrations() {
    const r = await Backend.call("get_master_settings");
    if (!r || !r.ok || !r.super_admin) return this.pane("settings", `<div class="empty">${esc((r && r.error) || "Super admins only.")}</div>`);
    this.cat = r.catalog || []; this.other = r.other || [];
    this.catDraft = this.catDraft || {}; this.otherDraft = this.otherDraft || {}; this.customDraft = this.customDraft || {};
    const order = []; this.cat.forEach(c => { if (!order.includes(c.group)) order.push(c.group); });
    const blurb = { "Vendor APIs": "Credentials for warranty and spec lookups. Secrets are stored hidden and are never shown again; type a new value to replace one.",
                    "Regional": "Platform-wide defaults.", "Sync": "How the Intune sync behaves.",
                    "Releases": "Tell techs when a newer NBG Hub build is out. Set these after you hand out a new installer.",
                    "Directory": "On-premises Active Directory options.",
                    "Upgrades": "Which devices are queued for an upgrade automatically after each sync.",
                    "Notifications": "How e-mails about Issues are sent. Choose who gets them under Issue notifications." };
    const row = (c, i) => {
      const st = c.status === "planned" ? SetUI.pill("plan", "Not used yet") : (c.kind === "secret" ? (c.is_set ? SetUI.pill("ok", "Set") : SetUI.pill("warn", "Not set")) : "");
      const draft = Object.prototype.hasOwnProperty.call(this.catDraft, c.key);
      const value = draft ? this.catDraft[c.key] : c.value || "";
      const saveId = `igSave${i}`;
      let ctl;
      const change = `Settings.integrationEdit('cat','${c.key}',this.value,'${saveId}')`;
      if (c.kind === "secret") ctl = `<input id="ig${i}" type="password" autocomplete="new-password" oninput="${change}" placeholder="${c.is_set ? "•••••• set - type to replace" : "paste the value"}">`;
      else if (c.kind === "url") ctl = `<input id="ig${i}" value="${attr(value)}" placeholder="https://projecthub.example.com/" oninput="${change}">`;
      else if (c.kind === "text") ctl = `<input id="ig${i}" value="${attr(value)}" placeholder="server.domain.local" oninput="${change}">`;
      else if (c.kind === "version") ctl = `<input id="ig${i}" value="${attr(value)}" placeholder="2026.10.15" oninput="${change}">`;
      else if (c.kind === "choice") ctl = SetUI.select("ig" + i, c.options || [], value, change);
      else ctl = `<input id="ig${i}" type="number" min="${c.min}" max="${c.max}" value="${attr(value)}" placeholder="${c.default} (default)" oninput="${change}">`;
      return `<div class="set-row" data-integration-row data-search="${attr([c.group, c.key, c.label, c.help].join(" ").toLowerCase())}"><div class="set-row-main"><b>${esc(c.label)}</b> ${st}<p>${esc(c.help)}</p></div>
        <div class="set-row-ctl">${ctl}<button class="primary" id="${saveId}" onclick="Settings.saveCat(${i})"${draft ? "" : " disabled"}>Save</button></div></div>`;
    };
    const cards = order.map((g, n) => `<details class="set-adv set-integration-group"${n === 0 ? " open" : ""}><summary>${esc(g)} <span class="muted">${esc(blurb[g] || "")}</span></summary>${this.cat.map((c, i) => c.group === g ? row(c, i) : "").join("")}</details>`).join("");
    const others = this.other.length ? SetUI.card("Other stored settings", "Present in the Master Settings list but not known to this screen.",
      this.other.map((o, i) => {
        const draft = Object.prototype.hasOwnProperty.call(this.otherDraft, o.key);
        const value = draft ? this.otherDraft[o.key] : o.value || "", saveId = `igoSave${i}`;
        const change = `Settings.integrationEdit('other','${o.key}',this.value,'${saveId}')`;
        return `<div class="set-row" data-integration-row data-search="${attr([o.key, o.description || ""].join(" ").toLowerCase())}"><div class="set-row-main"><b>${esc(o.key)}</b> ${o.secret ? SetUI.pill("warn", "secret") : ""}</div>
          <div class="set-row-ctl"><input id="igo${i}" ${o.secret ? `type="password" placeholder="${o.is_set ? "•••••• set - type to replace" : "value"}" oninput="${change}"` : `value="${attr(value)}" oninput="${change}"`}>
          <button class="primary" id="${saveId}" onclick="Settings.saveOther(${i})"${draft ? "" : " disabled"}>Save</button></div></div>`;
      }).join("")) : "";
    const custom = `<details class="set-adv"><summary>Advanced: add a setting this screen does not know yet</summary>
      <div class="set-grid2"><div class="field"><label>Key</label><input id="igcKey" value="${attr(this.customDraft.key || "")}" placeholder="e.g. new_vendor_key" oninput="Settings.integrationCustomEdit('key',this.value)"></div>
        <div class="field"><label>Value</label><input id="igcVal" value="${attr(this.customDraft.value || "")}" oninput="Settings.integrationCustomEdit('value',this.value)"></div></div>
      <label class="set-check"><input type="checkbox" id="igcSec"${this.customDraft.secret ? " checked" : ""} onchange="Settings.integrationCustomEdit('secret',this.checked)"> Secret (hide the value after saving)</label>
      <div><button class="primary" id="igCustomSave" style="margin-top:10px" onclick="Settings.saveCustom()"${Object.keys(this.customDraft).length ? "" : " disabled"}>Add setting</button></div></details>`;
    this.pane("settings", `<input class="set-integration-search" type="search" placeholder="Find a setting…" oninput="Settings.filterIntegrations(this.value)">${cards}${others}${custom}`);
  },
  integrationEdit(kind, key, value, buttonId) {
    const draft = kind === "other" ? this.otherDraft : this.catDraft;
    draft[key] = value; this.dirty = true;
    const button = document.getElementById(buttonId); if (button) button.disabled = false;
  },
  integrationCustomEdit(field, value) {
    this.customDraft = this.customDraft || {}; this.customDraft[field] = value; this.dirty = true;
    const button = document.getElementById("igCustomSave"); if (button) button.disabled = false;
  },
  integrationHasDrafts() {
    return Object.keys(this.catDraft || {}).length > 0 || Object.keys(this.otherDraft || {}).length > 0 || Object.keys(this.customDraft || {}).length > 0;
  },
  filterIntegrations(query) {
    const q = (query || "").trim().toLowerCase();
    document.querySelectorAll("[data-integration-row]").forEach(row => { row.classList.toggle("hidden", !!q && !row.dataset.search.includes(q)); });
    document.querySelectorAll(".set-integration-group").forEach(group => {
      const visible = !!group.querySelector("[data-integration-row]:not(.hidden)");
      group.classList.toggle("hidden", !!q && !visible);
      if (q && visible) group.open = true;
      else if (!q) group.open = false;
    });
  },
  async saveCat(i) {
    const c = this.cat[i], el = document.getElementById("ig" + i);
    const v = c.kind === "secret" ? (el.value || "").trim() : (el.value || "").trim();
    if (c.kind === "secret" && !v) return App.toast("Type the new value first.", true);
    const r = await Backend.call("set_master_setting", c.key, v, c.secret, c.label);
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not save.", true);
    c.value = c.kind === "secret" ? "" : v; if (c.kind === "secret") c.is_set = true;
    delete this.catDraft[c.key]; this.dirty = this.integrationHasDrafts();
    App.toast("Saved " + c.label);
    await this.integrations();
  },
  async saveOther(i) {
    const o = this.other[i], v = document.getElementById("igo" + i).value;
    if (o.secret && !v) return App.toast("Type the new value first.", true);
    const r = await Backend.call("set_master_setting", o.key, v, o.secret, o.description || "");
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not save.", true);
    if (!o.secret) o.value = v; else o.is_set = true;
    delete this.otherDraft[o.key]; this.dirty = this.integrationHasDrafts();
    App.toast("Saved " + o.key); await this.integrations();
  },
  async saveCustom() {
    const k = (document.getElementById("igcKey").value || "").trim(), v = document.getElementById("igcVal").value;
    if (!/^[a-z][a-z0-9_]{2,40}$/.test(k)) return App.toast("Key: lowercase letters, digits and underscores (3-41 characters).", true);
    const r = await Backend.call("set_master_setting", k, v, document.getElementById("igcSec").checked, "");
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not save.", true);
    this.customDraft = {}; this.dirty = this.integrationHasDrafts();
    App.toast("Added " + k); await this.integrations();
  },

  /* ---- platform: divisions (list + editor) ---- */
  rows: [], dv: null, dvTab: "identity", cats: null,
  async divisions() {
    const r = await Backend.call("get_division_admin");
    if (!r || !r.ok || !r.super_admin) return this.pane("settings", `<div class="empty">${esc((r && r.error) || "Super admins only.")}</div>`);
    this.rows = r.divisions; this.dv = null;
    const cards = this.rows.map((d, i) => `<div class="set-div">
      <div><b>${esc(d.name)}</b> <span class="muted">${esc(d.id)}</span> ${d.enabled ? "" : SetUI.pill("warn", "Hidden")}
          <p>${esc((d.company_names || [d.company_name]).join(", "))} &middot; Intune: ${esc((d.intune_categories || [d.intune_category]).join(", "))} &middot; ${(d.sites || []).length} site(s) &middot; ${(d.access || []).length ? (d.access.includes("*") ? "everyone" : d.access.length + " allowed") : "super admins only"}</p></div>
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
    const emptySite = () => ({ code: "", name: "", city_prefixes: [], device_prefixes: [], company_names: [], intune_categories: [] });
    const base = { id: "", name: "", company_name: "", intune_category: "", sharepoint_hostname: "", site_path: "", ad_domain: "", sql_server: "",
      timesheet_db: "", timesheet_table: "", employee_db: "", employee_table: "", sites: [], access: [], enabled: true, _new: true };
    if (id === "one") base.sites = [emptySite()];
    else if (id === "multi") base.sites = [emptySite(), emptySite()];
    else if (id === "copy") {
      const src = this.rows[+document.getElementById("tplCopy").value] || {};
      ["ad_domain", "sql_server", "timesheet_db", "timesheet_table", "employee_db", "employee_table"].forEach(k => base[k] = src[k] || "");
      base.sites = (src.sites || []).map(s => ({ code: "", name: "", city_prefixes: [], device_prefixes: [], company_names: [], intune_categories: [] }));    // same number of sites, none of the names
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
        <p class="muted" style="font-size:12px">Entra company names and Intune categories are assigned per site in the <b>Sites</b> tab.</p>
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
    if (this.dvTab === "sites") SitesEditor.render("dvSites", d, () => this.markDirty(), { allowScopeEdit: true, categories: this.cats || [] });
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
