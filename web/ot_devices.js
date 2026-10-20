"use strict";

const OTDevices = {
  assets: [], canEdit: false, loaded: false, SITES: [], LISTS: { areas: [], lines: [], panels: [], owners: [] }, staleMonths: 6,
  TYPES: ["Windows PC", "Windows Server", "PLC / Controller", "HMI / Panel", "Network device", "Sensor / Instrument", "Other"],
  COLUMNS: [["device", "Device"], ["type", "Type"], ["model", "Vendor / model"], ["ip", "IP address"], ["site", "Site / area"], ["version", "Version"], ["criticality", "Criticality"], ["status", "Operational status"], ["documentation", "Documentation"], ["verified", "Last verified"], ["updated", "Last updated"], ["actions", "Actions"]],
  FIELDS: [
    ["name", "Machine / host name", true], ["type", "Device type", true], ["controller_type", "Controller type / runtime"], ["asset_tag", "Asset tag"], ["serial", "Serial number"],
    ["vendor", "Make / manufacturer"], ["model", "Model / project"], ["version", "Software / firmware version"], ["operating_system", "Operating system"], ["ad_joined", "AD-joined"],
    ["ip_address", "IP address"], ["subnet", "Subnet / prefix"],
    ["gateway", "Default gateway"], ["mac_address", "MAC address"], ["vlan", "VLAN"], ["switch_port", "Switch / port"],
    ["protocol", "Protocol / network"], ["site", "Site"], ["area", "Area / location"],
    ["line", "Line / function"], ["panel", "Panel / cabinet"], ["criticality", "Criticality"], ["status", "Operational status"],
    ["documentation_status", "Documentation status"], ["job_source", "Job source / LZ folder"], ["config_record", "Config record"],
    ["owner", "Owner / team"], ["last_verified", "Last verified"], ["dependencies", "Connected equipment / dependencies"], ["notes", "Notes"],
  ],
  async load(force) {
    const host = document.getElementById("otHost");
    if (!host) return;
    if (!this.loaded || force) host.innerHTML = '<div class="empty"><span class="busy-spin"></span> Loading OT inventory…</div>';
    const r = await Backend.call("ot_assets_get");
    if (!r || !r.ok) {
      host.innerHTML = `<div class="empty ot-error">${esc((r && r.error) || "Could not load OT device inventory.")}</div>`;
      return;
    }
    this.assets = Array.isArray(r.assets) ? r.assets : [];
    if (Array.isArray(r.types) && r.types.length) this.TYPES = r.types;
    this.SITES = Array.isArray(r.sites) ? r.sites : [];
    this.LISTS = r.lists || { areas: [], lines: [], panels: [], owners: [] };
    this.staleMonths = Number(r.stale_months) || 6;
    const staleOption = document.querySelector('#otFreshness option[value="stale"]');
    if (staleOption) staleOption.textContent = `Verification due / overdue (${this.staleMonths >= 12 ? `${this.staleMonths / 12} year${this.staleMonths === 12 ? "" : "s"}` : `${this.staleMonths} months`})`;
    this.canEdit = !!r.can_edit; this.loaded = true;
    const add = document.getElementById("otAddBtn"); if (add) add.classList.toggle("hidden", !this.canEdit);
    ["otImportBtn", "otReminderBtn"].forEach(id => { const b = document.getElementById(id); if (b) b.classList.toggle("hidden", !this.canEdit); });
    this.fillTypes(); this.drawColumns(); this.render();
  },
  fillTypes() {
    const select = document.getElementById("otType");
    if (!select) return;
    const prior = select.value;
    select.innerHTML = '<option value="">All device types</option>' + this.TYPES.map(t => `<option value="${attr(t)}">${esc(t)}</option>`).join("");
    select.value = prior;
  },
  filtered() {
    const q = (document.getElementById("otSearch")?.value || "").trim().toLowerCase();
    const type = document.getElementById("otType")?.value || "";
    const status = document.getElementById("otStatus")?.value || "";
    const criticality = document.getElementById("otCriticality")?.value || "";
    const quality = document.getElementById("otFreshness")?.value || "";
    return this.assets.filter(a => (!type || a.type === type) && (!status || a.status === status) && (!criticality || a.criticality === criticality) &&
      (!quality || (quality === "stale" ? this.isStale(a) : quality === "missing" ? this.missingFields(a).length > 0 : quality === "verify" ? this.needsVerification(a) : this.isStale(a) || this.missingFields(a).length > 0 || this.needsVerification(a))) &&
      (!q || this.FIELDS.map(([key]) => a[key]).filter(Boolean).join(" ").toLowerCase().includes(q)));
  },
  needsVerificationValue(value) {
    const v = String(value || "").trim();
    return !v || /^(?:needs? verification|to be captured|unknown(?:\s*[-–—:]\s*confirm)?|not recorded|not captured|not shown(?:\s+on\s+header)?|not listed(?:\s+on\s+ot\s+list)?|yes\s*[-–—:]\s*assumed(?:\s*,?\s*confirm)?|tbd|[-–—])$/i.test(v);
  },
  missingFields(a) {
    const required = ["vendor", "model", "site", "version", "last_verified", "controller_type", "operating_system", "ad_joined", "job_source", "config_record"].filter(k => !String(a[k] || "").trim());
    const unresolved = this.FIELDS.map(([key]) => key).filter(key => key !== "notes" && String(a[key] || "").trim() && this.needsVerificationValue(a[key]));
    return [...new Set([...required, ...unresolved])];
  },
  needsVerification(a) { return String(a.documentation_status || "").toLowerCase() === "needs verification" || this.missingFields(a).length > 0; },
  isStale(a) {
    const at = Date.parse(a.last_verified || "");
    if (!Number.isFinite(at)) return true;
    const cutoff = new Date(); cutoff.setHours(0, 0, 0, 0); cutoff.setMonth(cutoff.getMonth() - this.staleMonths);
    return at < cutoff.getTime();
  },
  dateLabel(v) { if (!v) return "—"; const d = new Date(v); return Number.isNaN(+d) ? v : d.toLocaleDateString(); },
  render() {
    const rows = this.filtered(), host = document.getElementById("otHost");
    if (!host) return;
    const windows = this.assets.filter(a => /Windows/i.test(a.type || "")).length;
    const controllers = this.assets.filter(a => /PLC|HMI|Controller/i.test(a.type || "")).length;
    const critical = this.assets.filter(a => ["High", "Critical"].includes(a.criticality)).length;
    const stats = document.getElementById("otStats");
    if (stats) stats.innerHTML = [
      [this.assets.length, "OT assets"], [windows, "Windows systems"], [controllers, "Controllers & panels"], [critical, "High / critical"],
      [this.assets.filter(a => this.isStale(a)).length, "Verification due / overdue"], [this.assets.filter(a => this.needsVerification(a)).length, "Needs verification"],
    ].map(([n, label]) => `<div class="stat"><div class="n">${n}</div><div class="l">${label}</div></div>`).join("");
    const count = document.getElementById("otCount"); if (count) count.textContent = `${rows.length} of ${this.assets.length} devices`;
    if (!rows.length) {
      host.innerHTML = `<div class="empty">${this.assets.length ? "No OT devices match these filters." : "No OT devices yet. Add a Windows system, controller, HMI, network device, or other OT asset."}</div>`;
      return;
    }
    const shown = this.visibleColumns();
    const th = (key, label) => `<th data-ot-column="${key}" title="${key === "verified" ? "A person confirmed these details on this date. The division's stale period is measured from here." : key === "updated" ? "Most recent saved change. Editing a record does not count as verifying its details." : ""}"${shown.has(key) ? "" : " class=\"ot-col-hidden\""}>${label}</th>`;
    const td = (key, content, classes = "", title = "") => `<td data-ot-column="${key}" class="${[classes, shown.has(key) ? "" : "ot-col-hidden"].filter(Boolean).join(" ")}"${title ? ` title="${title}"` : ""}>${content}</td>`;
    host.innerHTML = `<div class="table-wrap ot-table-wrap"><table class="fit ot-table"><thead><tr>${this.COLUMNS.map(([key, label]) => th(key, label)).join("")}</tr></thead><tbody>${rows.map(a => `<tr>
      ${td("device", `<b>${esc(a.name)}</b>${a.asset_tag ? `<small class="ot-sub">${esc(a.asset_tag)}</small>` : ""}`)}
      ${td("type", esc(a.type))}${td("model", esc([a.vendor, a.model].filter(Boolean).join(" · ")))}
      ${td("ip", `${esc(a.ip_address)}${a.subnet ? `<small class="ot-sub">/${esc(a.subnet)}</small>` : ""}`, "mono")}
      ${td("site", esc([a.site, a.area, a.line].filter(Boolean).join(" · ")))}${td("version", esc(a.version))}
      ${td("criticality", `<span class="ot-pill ${String(a.criticality).toLowerCase()}">${esc(a.criticality || "—")}</span>`)}
      ${td("status", esc(a.status || "Active"))}${td("documentation", esc(a.documentation_status || "Needs Verification"))}
      ${td("verified", `${esc(a.last_verified || "Not verified")}${a.last_verified && this.isStale(a) ? ` <span class="ot-pill stale" title="Verification is overdue; division threshold is ${this.staleMonths} months">Overdue</span>` : ""}`)}
      ${td("updated", `${esc(this.dateLabel(a.updated_at || a.created_at))}${this.needsVerification(a) ? ` <span class="ot-pill missing" title="Review record: ${attr(this.missingFields(a).join(", ") || a.documentation_status || "documentation status")}">Needs review</span>` : ""}`, "ot-updated-cell", `Last updated by ${attr(a.updated_by || "unknown")}`)}
      ${td("actions", this.canEdit ? `<button class="rowbtn" title="Confirm these details are still correct and set today's verified date" onclick="OTDevices.verify('${attr(a.id)}',this)">✓ Verify</button><button class="rowbtn" onclick="OTDevices.open('${attr(a.id)}')">Edit</button><button class="rowbtn danger" onclick="OTDevices.remove('${attr(a.id)}')">Remove</button>` : "", "ot-actions")}
      </tr>`).join("")}</tbody></table></div>`;
  },
  visibleColumns() {
    const key = `nbg_ot_columns_${Divisions.current || "default"}`;
    try { const saved = JSON.parse(localStorage.getItem(key) || "null"); if (Array.isArray(saved)) return new Set(saved.filter(id => this.COLUMNS.some(([column]) => column === id))); } catch (_) {}
    return new Set(this.COLUMNS.map(([id]) => id));
  },
  drawColumns() {
    const host = document.getElementById("otColumnsMenu"); if (!host) return;
    const visible = this.visibleColumns();
    host.innerHTML = `<div class="ot-column-options">${this.COLUMNS.map(([key, label]) => `<label><input type="checkbox" value="${key}"${visible.has(key) ? " checked" : ""} onchange="OTDevices.setColumn('${key}',this.checked)"> ${esc(label)}</label>`).join("")}<button type="button" class="rowbtn" onclick="OTDevices.resetColumns()">Show all columns</button></div>`;
  },
  setColumn(key, enabled) {
    const visible = this.visibleColumns();
    if (enabled) visible.add(key); else visible.delete(key);
    try { localStorage.setItem(`nbg_ot_columns_${Divisions.current || "default"}`, JSON.stringify([...visible])); } catch (_) {}
    this.render();
  },
  resetColumns() {
    try { localStorage.removeItem(`nbg_ot_columns_${Divisions.current || "default"}`); } catch (_) {}
    this.drawColumns(); this.render();
  },
  toggleMore(ev) {
    ev?.stopPropagation();
    const menu = document.getElementById("otMore"); if (!menu) return;
    menu.classList.toggle("hidden");
    document.querySelector("#otMoreWrap > button")?.setAttribute("aria-expanded", menu.classList.contains("hidden") ? "false" : "true");
    if (!this._moreBound) {
      this._moreBound = true;
      document.addEventListener("click", event => { if (!event.target.closest("#otMoreWrap")) this.closeMore(); });
      document.addEventListener("keydown", event => { if (event.key === "Escape") this.closeMore(); });
    }
  },
  closeMore() { document.getElementById("otMore")?.classList.add("hidden"); document.querySelector("#otMoreWrap > button")?.setAttribute("aria-expanded", "false"); },
  open(id) {
    if (!this.canEdit) return;
    const a = this.assets.find(x => x.id === id) || { type: this.TYPES[0] || "Other", status: "Active", criticality: "Medium" };
    const selectOptions = (key, values, fallback) => `<select name="${key}" id="ot-${key}">${values.map(v => `<option${(a[key] || fallback) === v ? " selected" : ""}>${esc(v)}</option>`).join("")}</select>`;
    const choiceSelect = (key, values, label, site = false) => {
      const current = String(a[key] || "");
      const normalized = site ? ((this.SITES.find(s => s.code === current || s.name === current) || {}).code || current) : current;
      const opts = site ? this.SITES.map(s => ({ value: s.code, label: `${s.code} · ${s.name || s.code}` })) : values.map(v => ({ value: v, label: v }));
      if (normalized && !opts.some(o => o.value === normalized)) opts.unshift({ value: normalized, label: `Existing value · ${normalized}` });
      const placeholder = opts.length ? `Select ${label.toLowerCase()}` : `No ${label.toLowerCase()} choices configured`;
      return `<select name="${key}" id="ot-${key}"><option value="">${esc(placeholder)}</option>${opts.map(o => `<option value="${attr(o.value)}"${o.value === normalized ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`;
    };
    const groups = {
      device: new Set(["name", "type", "controller_type", "asset_tag", "serial", "vendor", "model", "version", "operating_system", "ad_joined"]),
      network: new Set(["ip_address", "subnet", "gateway", "mac_address", "vlan", "switch_port", "protocol"]),
      operations: new Set(["site", "area", "line", "panel", "criticality", "status", "documentation_status", "job_source", "config_record", "owner", "last_verified", "dependencies", "notes"]),
    };
    const controls = { device: [], network: [], operations: [] };
    this.FIELDS.forEach(([key, label, required]) => {
      let control;
      if (key === "type") control = selectOptions(key, this.TYPES, this.TYPES[0] || "Other");
      else if (key === "status") control = selectOptions(key, ["Active", "Spare", "Maintenance", "Retired"], "Active");
      else if (key === "documentation_status") control = selectOptions(key, ["Needs Verification", "Documented"], "Needs Verification");
      else if (key === "ad_joined") control = selectOptions(key, ["Yes", "No", "Unknown", "Needs Verification"], "Needs Verification");
      else if (key === "criticality") control = selectOptions(key, ["Low", "Medium", "High", "Critical"], "Medium");
      else if (key === "site") control = choiceSelect(key, [], "site", true);
      else if (key === "area") control = choiceSelect(key, this.LISTS.areas || [], "area / location");
      else if (key === "line") control = choiceSelect(key, this.LISTS.lines || [], "line / process");
      else if (key === "panel") control = choiceSelect(key, this.LISTS.panels || [], "panel / cabinet");
      else if (key === "owner") control = choiceSelect(key, this.LISTS.owners || [], "owner / team");
      else if (["notes", "dependencies"].includes(key)) control = `<textarea name="${key}" id="ot-${key}" maxlength="2000" placeholder="${key === "dependencies" ? "e.g. Drives 31 auxiliary PLCs" : "Additional details, network notes, or operating context"}">${esc(a[key] || "")}</textarea>`;
      else control = `<input name="${key}" id="ot-${key}" ${key === "last_verified" ? 'type="date"' : "type=\"text\""} maxlength="${key === "last_verified" ? 10 : key === "model" ? 160 : key === "job_source" ? 500 : 120}" value="${attr(a[key] || "")}" ${required ? "required" : ""} ${key === "name" ? 'placeholder="e.g. Line 2 PLC"' : key === "job_source" ? 'placeholder="\\\\server\\share\\line\\LZ"' : ""}>`;
      const group = Object.keys(groups).find(name => groups[name].has(key));
      controls[group].push(`<div class="field ot-field ot-field-${key}"><label for="ot-${key}">${esc(label)}${required ? " *" : ""}</label>${control}</div>`);
    });
    Object.keys(controls).forEach(group => { controls[group] = controls[group].join(""); });
    document.getElementById("modalRoot").innerHTML = `<div class="overlay" onclick="if(event.target===this)OTDevices.close()"><div class="modal ot-modal" role="dialog" aria-modal="true" aria-labelledby="otModalTitle">
      <div class="modal-head"><h3 id="otModalTitle">${id ? "Edit OT device" : "Add OT device"}</h3><button onclick="OTDevices.close()" aria-label="Close">×</button></div>
      <div class="ot-tabs" role="tablist" aria-label="OT device details">
        <button type="button" class="ot-modal-tab active" id="otTab-device" role="tab" aria-selected="true" aria-controls="otPanel-device" onclick="OTDevices.switchTab('device')">Device</button>
        <button type="button" class="ot-modal-tab" id="otTab-network" role="tab" aria-selected="false" aria-controls="otPanel-network" onclick="OTDevices.switchTab('network')">Network</button>
        <button type="button" class="ot-modal-tab" id="otTab-operations" role="tab" aria-selected="false" aria-controls="otPanel-operations" onclick="OTDevices.switchTab('operations')">Operations</button>
      </div>
      <div class="modal-body"><p class="muted ot-form-intro">Save core identity first. Network and operations details are optional.</p>
      <form id="otAssetForm" class="ot-form" onsubmit="event.preventDefault();OTDevices.save(document.getElementById('otSaveBtn'))"><input type="hidden" name="id" value="${attr(a.id || "")}">
        <div class="ot-tab-panel" id="otPanel-device" role="tabpanel" aria-labelledby="otTab-device"><div class="ot-fields">${controls.device}</div></div>
        <div class="ot-tab-panel hidden" id="otPanel-network" role="tabpanel" aria-labelledby="otTab-network"><div class="ot-fields">${controls.network}</div></div>
        <div class="ot-tab-panel hidden" id="otPanel-operations" role="tabpanel" aria-labelledby="otTab-operations"><div class="ot-fields">${controls.operations}</div></div>
      </form><p class="ot-form-error" id="otFormError"></p></div>
      <div class="modal-foot"><button class="ghost" onclick="OTDevices.close()">Cancel</button><button class="primary" id="otSaveBtn" type="button" onclick="OTDevices.save(this)">Save device</button></div>
      </div></div>`;
    document.getElementById("ot-name")?.focus();
  },
  switchTab(tab) {
    if (!["device", "network", "operations"].includes(tab)) return;
    document.querySelectorAll(".ot-modal-tab").forEach(button => {
      const active = button.id === `otTab-${tab}`;
      button.classList.toggle("active", active); button.setAttribute("aria-selected", active ? "true" : "false");
      button.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll(".ot-tab-panel").forEach(panel => panel.classList.toggle("hidden", panel.id !== `otPanel-${tab}`));
    const body = document.querySelector(".ot-modal .modal-body"); if (body) body.scrollTop = 0;
  },
  close() { document.getElementById("modalRoot").innerHTML = ""; },
  async save(button) {
    const form = document.getElementById("otAssetForm");
    const name = form.elements.namedItem("name"), type = form.elements.namedItem("type");
    if (!name.value.trim() || !type.value) {
      this.switchTab("device");
      if (!name.value.trim()) { name.setCustomValidity("Enter a device name."); name.reportValidity(); name.addEventListener("input", () => name.setCustomValidity(""), { once: true }); }
      else type.reportValidity();
      return;
    }
    const value = Object.fromEntries(new FormData(form).entries());
    if (value.last_verified && !value.last_verified.trim()) value.last_verified = "";
    button.disabled = true; button.textContent = "Saving…";
    const r = await Backend.call("ot_asset_save", value);
    if (!r || !r.ok) {
      const err = document.getElementById("otFormError"); if (err) err.textContent = (r && r.error) || "Could not save OT device.";
      button.disabled = false; button.textContent = "Save device"; return;
    }
    this.assets = r.assets || this.assets; this.close(); this.render(); App.toast("OT device saved.");
  },
  async remove(id) {
    const a = this.assets.find(x => x.id === id);
    if (!a || !this.canEdit || !confirm(`Remove ${a.name} from OT inventory?`)) return;
    const r = await Backend.call("ot_asset_delete", id);
    if (!r || !r.ok) { App.toast((r && r.error) || "Could not remove OT device.", true); return; }
    this.assets = r.assets || this.assets.filter(x => x.id !== id); this.render(); App.toast("OT device removed.");
  },
  async verify(id, button) {
    if (!this.canEdit || !id) return;
    button.disabled = true; button.textContent = "Saving…";
    const r = await Backend.call("ot_asset_verify", id);
    if (!r || !r.ok) { button.disabled = false; button.textContent = "✓ Verify"; App.toast((r && r.error) || "Could not verify OT device.", true); return; }
    this.assets = r.assets || this.assets.map(a => a.id === id ? r.asset : a);
    this.render(); App.toast(`${r.asset?.name || "OT device"} verified today.`);
  },
  async exportCsv() {
    const rows = this.filtered();
    const fields = [...this.FIELDS.map(([key, label]) => [key, label]), ["updated_at", "Last info update"], ["updated_by", "Last updated by"]];
    await this.downloadCsv(fields, rows, `NBG-Hub-OT-Devices-${new Date().toISOString().slice(0, 10)}.csv`);
  },
  async sampleCsv() {
    const fields = this.FIELDS.map(([key, label]) => [key, label]);
    const example = { name: "Line 2 PLC", type: "PLC / Controller", controller_type: "Embedded", asset_tag: "OT-PLC-002", serial: "SN-12345", vendor: "Example Controls", model: "Controller X", version: "Firmware 3.2", operating_system: "Embedded", ad_joined: "No", ip_address: "10.20.4.12", subnet: "24", gateway: "10.20.4.1", mac_address: "00:11:22:33:44:55", vlan: "120", switch_port: "SW-04 / 18", protocol: "EtherNet/IP", site: "Terrell", area: "North plant", line: "Line 2", panel: "P-204", criticality: "High", status: "Active", documentation_status: "Documented", job_source: "\\\\fileserver\\shopcon\\Line2\\LZ", config_record: "CFG-001", owner: "Controls team", last_verified: "2026-10-01", dependencies: "Drives 4 auxiliary PLCs", notes: "Example only; delete this row before import." };
    await this.downloadCsv(fields, [example], "NBG-Hub-OT-Devices-Sample.csv");
  },
  async downloadCsv(fields, rows, filename) {
    const csv = [fields.map(([, label]) => label), ...rows.map(a => fields.map(([key]) => a[key] || ""))]
      .map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const content = "\uFEFF" + csv;
    if (Backend.real && window.pywebview?.api?.save_csv_file) {
      const result = await Backend.call("save_csv_file", filename, content);
      if (!result || !result.ok) return App.toast((result && result.error) || "Could not save the CSV file.", true);
      if (result.cancelled) return;
      App.toast(`Saved ${filename} to ${result.path}.`);
      return;
    }
    const blob = new Blob([content], { type: "text/csv;charset=utf-8" }), url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    App.toast(`Downloaded ${filename}.`);
  },
  parseCsv(text) {
    const rows = []; let row = [], cell = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted && c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = !quoted;
      else if (!quoted && c === ",") { row.push(cell); cell = ""; }
      else if (!quoted && (c === "\n" || c === "\r")) { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); if (row.some(x => x.trim())) rows.push(row); row = []; cell = ""; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  },
  importCsv() {
    if (!this.canEdit) return;
    this.xlsxFile = null; this.xlsxBase64 = ""; this.xlsxSheets = []; this.xlsxSheet = "";
    document.getElementById("modalRoot").innerHTML = `<div class="overlay" onclick="if(event.target===this)OTDevices.close()"><div class="modal ot-import-modal" role="dialog" aria-modal="true" aria-labelledby="otImportTitle">
      <div class="modal-head"><h3 id="otImportTitle">Import OT devices</h3><button onclick="OTDevices.close()" aria-label="Close">×</button></div>
      <div class="modal-body"><p class="muted">Choose an Excel workbook (.xlsx) or CSV file. Review column matching before import. Existing devices match by ID, serial number, or asset tag.</p>
        <div class="field"><label for="otCsvFile">Excel or CSV file</label><input id="otCsvFile" type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" onchange="OTDevices.loadImportFile(this.files[0])"></div>
        <div id="otCsvMap" class="hidden"></div><p id="otCsvError" class="ot-form-error"></p></div>
      <div class="modal-foot"><button class="ghost" onclick="OTDevices.close()">Cancel</button><button class="primary" id="otCsvImportBtn" disabled onclick="OTDevices.commitCsv()">Import rows</button></div></div></div>`;
  },
  csvRows: [], csvHeaders: [], csvMapping: {}, csvValueMatches: [], importKind: "csv", xlsxFile: null, xlsxBase64: "", xlsxSheets: [], xlsxSheet: "",
  async loadImportFile(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { document.getElementById("otCsvError").textContent = "File must be under 5 MB."; return; }
    if (/\.xlsx$/i.test(file.name)) return this.loadXlsxFile(file);
    return this.loadCsvFile(file);
  },
  async loadCsvFile(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { document.getElementById("otCsvError").textContent = "CSV must be under 5 MB."; return; }
    const rows = this.parseCsv(await file.text());
    return this.prepareImportRows(rows, "csv");
  },
  async loadXlsxFile(file) {
    if (!file) return;
    const isNewFile = this.xlsxFile !== file;
    this.xlsxFile = file;
    if (isNewFile) { this.xlsxBase64 = ""; this.xlsxSheets = []; this.xlsxSheet = ""; }
    const error = document.getElementById("otCsvError"); if (error) error.textContent = "Reading Excel workbook…";
    try {
      if (!this.xlsxBase64) {
        const bytes = new Uint8Array(await file.arrayBuffer()); let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        this.xlsxBase64 = btoa(binary);
      }
      this.importKind = "xlsx";
      await this.readXlsxSheet(this.xlsxSheet);
    } catch (e) {
      if (error) error.textContent = e?.message || "Could not read Excel workbook.";
    }
  },
  async readXlsxSheet(sheetName) {
    const error = document.getElementById("otCsvError");
    const button = document.getElementById("otCsvImportBtn"); if (button) button.disabled = true;
    const r = await Backend.call("ot_xlsx_read", this.xlsxBase64, sheetName || "");
    if (!r || !r.ok) { if (error) error.textContent = r?.error || "Could not read Excel workbook."; return; }
    this.xlsxSheets = r.sheets || []; this.xlsxSheet = r.sheet || "";
    this.prepareImportRows(r.rows || [], "xlsx");
  },
  prepareImportRows(rows, kind) {
    if (!Array.isArray(rows) || rows.length < 2) { document.getElementById("otCsvError").textContent = "File needs a header row and at least one data row."; return; }
    this.importKind = kind;
    this.csvHeaders = rows[0].map((v, i) => v.replace(/^\uFEFF/, "").trim() || `Column ${i + 1}`);
    this.csvRows = rows.slice(1).filter(r => r.some(v => v.trim())).map(r => this.csvHeaders.map((_, i) => r[i] || ""));
    this.csvValueMatches = [];
    const aliases = {
      name: ["device name", "name", "hostname", "machine / host name", "machine name", "host name"],
      type: ["device type", "type"], controller_type: ["controller type", "controller type / runtime", "controller / runtime"],
      asset_tag: ["asset tag", "asset_tag", "tag"], serial: ["serial number", "serial", "serial_number", "serial #"],
      vendor: ["vendor", "manufacturer", "vendor / manufacturer", "make", "make / manufacturer"],
      model: ["model", "model / project", "project"],
      ip_address: ["ip address", "ip", "ip_address"], subnet: ["subnet", "subnet / prefix", "prefix"],
      gateway: ["default gateway", "gateway"], mac_address: ["mac address", "mac", "mac_address"], vlan: ["vlan"],
      switch_port: ["switch / port", "switch port", "port"], protocol: ["protocol", "protocol / network"],
      version: ["version", "software version", "software / firmware version", "firmware"],
      operating_system: ["operating system", "os"], ad_joined: ["ad-joined?", "ad-joined", "ad joined", "ad joined?"],
      site: ["site"], area: ["area", "area / location", "location"],
      line: ["line", "line / process", "line / function", "function", "process"],
      panel: ["panel", "panel / cabinet", "cabinet"], criticality: ["criticality"],
      status: ["operational status", "status"], documentation_status: ["documentation status", "config status"],
      job_source: ["job source / lz folder", "job source", "lz folder", "job source folder"],
      config_record: ["config record", "configuration record"],
      owner: ["owner", "owner / team", "team"], last_verified: ["last verified", "last_verified", "verified"],
      dependencies: ["connected equipment / dependencies", "dependencies", "connected equipment"],
    };
    aliases.notes = ["notes", "comments", "description"];
    this.csvMapping = Object.fromEntries(this.FIELDS.map(([key]) => [key, this.csvHeaders.findIndex(h => (aliases[key] || [key]).includes(h.toLowerCase()))]));
    const genericStatusIndex = this.csvHeaders.findIndex(h => h.toLowerCase() === "status");
    if (genericStatusIndex >= 0) {
      const docStates = new Set(["pending", "documented", "needs verification"]);
      const stateValues = this.csvRows.map(row => String(row[genericStatusIndex] || "").trim().toLowerCase()).filter(Boolean);
      if (stateValues.length && stateValues.every(value => docStates.has(value))) {
        this.csvMapping.documentation_status = genericStatusIndex;
        this.csvMapping.status = -1;
      }
    }
    const options = `<option value="-1">(skip)</option>` + this.csvHeaders.map((h, i) => `<option value="${i}">${esc(h)}</option>`).join("");
    const details = `<details class="ot-map-details"><summary>Review column matching (${this.csvHeaders.length} columns)</summary><div class="ot-map-grid">${this.FIELDS.map(([key, label]) => `<label class="field"><span>${esc(label)}</span><select data-ot-map="${key}">${options}</select></label>`).join("")}</div></details>`;
    const map = document.getElementById("otCsvMap"); map.classList.remove("hidden");
    const sheetSelect = kind === "xlsx" && this.xlsxSheets.length > 1 ? `<div class="field ot-sheet-select"><label for="otXlsxSheet">Worksheet</label><select id="otXlsxSheet">${this.xlsxSheets.map(name => `<option value="${attr(name)}"${name === this.xlsxSheet ? " selected" : ""}>${esc(name)}</option>`).join("")}</select></div>` : "";
    map.innerHTML = `${sheetSelect}<div class="field ot-date-format"><label for="otDateFormat">Date format for Last verified</label><select id="otDateFormat">${kind === "xlsx" ? '<option value="excel">Excel date cells / ISO dates</option>' : ""}<option value="auto">ISO (YYYY-MM-DD)</option><option value="mdy">Month / day / year</option><option value="dmy">Day / month / year</option></select></div>${details}<section class="ot-value-match"><h4>Match dropdown values</h4><p class="muted">Approve fuzzy matches to use existing division choices. Unmatched Area, Line, Panel, and Owner values are added to division settings on import; unmatched Site values stay as entered.</p><div id="otCsvValueMatches"></div></section><p class="muted">${this.csvRows.length} rows found. Preview: ${esc(this.csvRows.slice(0, 3).map(r => r.slice(0, 4).join(" · ")).join(" | "))}</p>`;
    const sheet = document.getElementById("otXlsxSheet");
    if (sheet) sheet.addEventListener("change", () => { this.xlsxSheet = sheet.value; this.readXlsxSheet(sheet.value); });
    map.querySelectorAll("[data-ot-map]").forEach(el => { const idx = this.csvMapping[el.dataset.otMap]; el.value = Number.isInteger(idx) ? idx : -1; el.addEventListener("change", () => { this.csvMapping[el.dataset.otMap] = Number(el.value); this.drawCsvValueMatches(); }); });
    this.drawCsvValueMatches();
    document.getElementById("otCsvImportBtn").disabled = false;
    document.getElementById("otCsvError").textContent = "";
  },
  choiceOptions(key) {
    if (key === "site") return this.SITES.map(s => ({ value: s.code, label: `${s.code} · ${s.name || s.code}`, search: `${s.code} ${s.name || ""}` }));
    const map = { area: "areas", line: "lines", panel: "panels", owner: "owners" };
    return (this.LISTS[map[key]] || []).map(value => ({ value, label: value }));
  },
  valueSimilarity(a, b) {
    const normalize = value => String(value || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
    const left = normalize(a), right = normalize(b);
    if (!left || !right) return 0;
    if (left === right) return 1;
    const prev = Array.from({ length: right.length + 1 }, (_, i) => i);
    for (let i = 1; i <= left.length; i++) {
      let diagonal = prev[0]; prev[0] = i;
      for (let j = 1; j <= right.length; j++) {
        const above = prev[j];
        prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
        diagonal = above;
      }
    }
    const edit = 1 - prev[right.length] / Math.max(left.length, right.length);
    const aTokens = new Set(left.split(" ")), bTokens = new Set(right.split(" "));
    const overlap = [...aTokens].filter(token => bTokens.has(token)).length;
    const token = overlap / new Set([...aTokens, ...bTokens]).size;
    return Math.max(edit, token * 0.9);
  },
  drawCsvValueMatches() {
    const host = document.getElementById("otCsvValueMatches"); if (!host) return;
    const prior = new Map((this.csvValueMatches || []).map(entry => [JSON.stringify([entry.key, entry.source]), entry]));
    const fields = [["site", "Site"], ["area", "Area / location"], ["line", "Line / process"], ["panel", "Panel / cabinet"], ["owner", "Owner / team"]];
    const entries = [];
    for (const [key, label] of fields) {
      const column = this.csvMapping[key];
      if (!Number.isInteger(column) || column < 0) continue;
      const values = [...new Set(this.csvRows.map(row => String(row[column] || "").trim()).filter(Boolean))].slice(0, 250);
      const choices = this.choiceOptions(key);
      for (const source of values) {
        const ranked = choices.map(option => ({ ...option, score: Math.max(this.valueSimilarity(source, option.value), this.valueSimilarity(source, option.label), this.valueSimilarity(source, option.search)) }))
          .sort((a, b) => b.score - a.score);
        const best = ranked[0];
        const saved = prior.get(JSON.stringify([key, source]));
        const suggestion = best && best.score >= 0.42 ? best.value : "";
        entries.push({ key, label, source, choices, suggested: suggestion, candidate: saved ? saved.candidate : suggestion, score: best ? best.score : 0, approved: !!(saved && saved.approved) });
      }
    }
    this.csvValueMatches = entries;
    if (!entries.length) { host.innerHTML = `<p class="muted">Map dropdown columns above to review their values.</p>`; return; }
    const rows = entries.map((entry, index) => {
      const noChoices = !entry.choices.length;
      const selectedLabel = entry.choices.find(option => option.value === entry.candidate)?.label || entry.candidate;
      const state = entry.approved
        ? `Approved · imports as ${esc(selectedLabel)}`
        : entry.candidate
          ? entry.key === "site" ? "Suggested site · approve to use it; otherwise site text stays as entered." : "Suggested match · approve to use it; otherwise CSV value becomes a new division choice."
          : entry.key === "site" ? "No close site match · site text stays as entered." : `No close match · “${esc(entry.source)}” becomes a new ${esc(entry.label.toLowerCase())} choice on import.`;
      const optionPrompt = entry.choices.length ? (entry.key === "site" ? "Keep CSV site value" : "Keep CSV value (add as new choice)") : (entry.key === "site" ? "No matching division site" : "Will add as new choice on import");
      const button = entry.candidate
        ? `<button type="button" class="rowbtn ot-match-approve${entry.approved ? " approved" : ""}" data-ot-match-approve="${index}" aria-pressed="${entry.approved}">${entry.approved ? "✓ Approved" : "Approve match"}</button>`
        : entry.key === "site" ? `<span class="ot-match-auto-add">No site match</span>` : `<span class="ot-match-auto-add">Added on import</span>`;
      return `<tr class="${entry.approved ? "ot-match-approved" : ""}"><td>${esc(entry.label)}</td><td class="ot-match-source">${esc(entry.source)}</td><td><select data-ot-match-select="${index}"><option value="">${optionPrompt}</option>${entry.choices.map(option => `<option value="${attr(option.value)}"${option.value === entry.candidate ? " selected" : ""}>${esc(option.label)}</option>`).join("")}</select>${entry.suggested ? `<small class="ot-match-score">Suggested · ${Math.round(entry.score * 100)}% match</small>` : ""}<small class="ot-match-state">${state}</small></td><td>${button}</td></tr>`;
    }).join("");
    const approved = entries.filter(entry => entry.approved).length;
    host.innerHTML = `<div class="ot-match-scroll"><table class="ot-match-table"><thead><tr><th>Field</th><th>CSV value</th><th>Division choice</th><th></th></tr></thead><tbody>${rows}</tbody></table></div><p class="muted ot-match-count">${approved} of ${entries.length} values approved to use an existing choice. Other Area, Line, Panel, and Owner values are added to this division’s choices during import.</p>`;
    if (!host.dataset.matchEventsBound) {
      host.dataset.matchEventsBound = "true";
      host.addEventListener("change", event => {
        const select = event.target.closest("[data-ot-match-select]"); if (!select) return;
        const entry = this.csvValueMatches[Number(select.dataset.otMatchSelect)]; if (!entry) return;
        entry.candidate = select.value; entry.approved = false; this.drawCsvValueMatches();
      });
      host.addEventListener("click", event => {
        const button = event.target.closest("[data-ot-match-approve]"); if (!button) return;
        event.preventDefault();
        const entry = this.csvValueMatches[Number(button.dataset.otMatchApprove)]; if (!entry || !entry.candidate) return;
        entry.approved = !entry.approved; this.drawCsvValueMatches();
      });
    }
  },
  async commitCsv() {
    const dateFormat = document.getElementById("otDateFormat")?.value || "auto";
    const values = this.csvRows.map(row => {
      const value = {};
      for (const [key, idx] of Object.entries(this.csvMapping)) if (idx >= 0) value[key] = row[idx] || "";
      for (const entry of this.csvValueMatches) if (entry.approved && String(value[entry.key] || "").trim() === entry.source) value[entry.key] = entry.candidate;
      const rawStatus = String(value.status || "").trim().toLowerCase();
      if (["pending", "documented", "needs verification"].includes(rawStatus)) {
        value.documentation_status = rawStatus === "documented" ? "Documented" : "Needs Verification";
        value.status = "";
      }
      for (const [key, raw] of Object.entries(value)) {
        if (["notes", "dependencies", "documentation_status", "status"].includes(key)) continue;
        if (this.needsVerificationValue(raw)) value[key] = String(raw || "").trim() ? "Needs Verification" : "";
      }
      if (value.ad_joined && /^no\s*\(embedded\)$/i.test(value.ad_joined)) value.ad_joined = "No";
      else if (value.ad_joined && /^yes\s*[-–—]\s*nucorsteel\.local$/i.test(value.ad_joined)) value.ad_joined = "Yes";
      if (!value.type) value.type = value.controller_type ? "PLC / Controller" : "Other";
      if (String(value.documentation_status || "").trim().toLowerCase() === "pending") value.documentation_status = "Needs Verification";
      else if (String(value.documentation_status || "").trim().toLowerCase() === "documented") value.documentation_status = "Documented";
      if (value.last_verified) {
        const d = value.last_verified.trim();
        if (dateFormat === "excel" && /^\d+(?:\.\d+)?$/.test(d)) {
          const serial = Number(d);
          if (serial > 0 && serial < 100000) value.last_verified = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000).toISOString().slice(0, 10);
        } else if (dateFormat === "mdy" || dateFormat === "dmy") { const m = d.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/); if (m) value.last_verified = dateFormat === "mdy" ? `${m[3]}-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}` : `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`; }
      }
      return value;
    });
    const b = document.getElementById("otCsvImportBtn"); b.disabled = true; b.textContent = "Importing…";
    const r = await Backend.call("ot_assets_import", values);
    if (!r || !r.ok) { document.getElementById("otCsvError").textContent = (r && r.error) || "Import failed."; b.disabled = false; b.textContent = "Import rows"; return; }
    if (r.lists) this.LISTS = r.lists;
    this.assets = r.assets || this.assets; this.close(); this.render();
    App.toast(`Import complete: ${r.added} added, ${r.updated} updated, ${r.skipped} skipped${r.added_choices ? `; ${r.added_choices} new division choices added` : ""}${r.choice_error ? `; choices were not saved: ${r.choice_error}` : r.errors ? `; first issue: ${r.row_errors?.[0] || "review skipped rows"}` : "."}`, !!r.errors || !!r.choice_error);
  },
  async sendReminders() {
    if (!this.canEdit) return;
    const r = await Backend.call("ot_assets_send_reminders");
    App.toast(r && r.ok ? r.message : ((r && r.error) || "Could not send reminders."), !(r && r.ok));
  },
};
