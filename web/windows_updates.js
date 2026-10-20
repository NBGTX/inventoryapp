"use strict";

const WindowsUpdates = {
  data: null,
  rows: [],
  loading: false,

  async load() {
    const host = document.getElementById("wuHost");
    if (host) host.innerHTML = `<div class="empty"><span class="busy-spin"></span> Loading saved update report…</div>`;
    const r = await Backend.call("windows_updates_get");
    if (r && r.ok) this.data = r.data || null;
    if (!this.data || !this.data.generated_at) return this.refresh();
    this.render();
  },

  async refresh() {
    if (this.loading) return;
    this.loading = true;
    const btn = document.getElementById("wuRefresh");
    const old = btn && btn.innerHTML;
    if (btn) { btn.disabled = true; btn.innerHTML = `<span class="busy-spin"></span> Checking Intune…`; }
    const host = document.getElementById("wuHost");
    if (host && !this.data) host.innerHTML = `<div class="empty"><span class="busy-spin"></span> Checking Intune and Microsoft update catalog…</div>`;
    try {
      const r = await Backend.call("windows_updates_refresh");
      if (!r || !r.ok) {
        if (host) host.innerHTML = `<div class="empty wu-error">${esc((r && r.error) || "Could not refresh Windows Update Watch.")}</div>`;
        return;
      }
      this.data = r.data || null;
      this.render();
      App.toast(`Windows update report refreshed for ${this.data && this.data.device_count || 0} Windows device(s).`);
    } catch (e) {
      if (host) host.innerHTML = `<div class="empty wu-error">${esc((e && e.message) || e)}</div>`;
    } finally {
      this.loading = false;
      if (btn) { btn.disabled = false; btn.innerHTML = old || "↻ Refresh from Intune"; }
    }
  },

  _statusLabel(status) {
    return ({
      "critical-overdue": "Critical overdue", "critical-due": "Critical · 72 hours",
      behind: "Behind", "due-soon": "Due soon", pending: "Within 14 days",
      current: "Current", unknown: "Status unknown", stale: "Stale check-in",
    })[status] || "Status unknown";
  },

  _fmt(value, time = false) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(undefined, time ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" });
  },

  _displayRows() {
    const query = (document.getElementById("wuSearch")?.value || "").trim().toLowerCase();
    const status = document.getElementById("wuStatus")?.value || "";
    const site = document.getElementById("wuSite")?.value || "";
    return this.rows.filter(row => {
      if (status && row.status !== status) return false;
      if (site && row.site !== site) return false;
      if (!query) return true;
      return [row.device_name, row.serial, row.user, row.site, row.model, row.os_version,
        row.update_name, row.kb, row.status_detail].some(value => String(value || "").toLowerCase().includes(query));
    });
  },

  render() {
    this.rows = (this.data && Array.isArray(this.data.rows)) ? this.data.rows : [];
    const counts = (this.data && this.data.counts) || {};
    const set = (id, count) => { const el = document.getElementById(id); if (el) el.textContent = Number(count || 0).toLocaleString(); };
    set("wuCritical", counts["critical-overdue"]);
    set("wuBehind", counts.behind);
    set("wuDue", counts["due-soon"]);
    set("wuCurrent", counts.current);
    set("wuUnknown", Number(counts.unknown || 0) + Number(counts.stale || 0));

    const siteSelect = document.getElementById("wuSite");
    if (siteSelect) {
      const selected = siteSelect.value;
      siteSelect.innerHTML = `<option value="">All sites</option>` + [...new Set(this.rows.map(row => row.site).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b)).map(site => `<option value="${attr(site)}">${esc(site)}</option>`).join("");
      siteSelect.value = selected;
    }
    const updated = document.getElementById("wuUpdated");
    if (updated) updated.textContent = this.data && this.data.generated_at ? `Report refreshed ${this._fmt(this.data.generated_at, true)}` : "Not refreshed yet";
    const host = document.getElementById("wuHost");
    const shown = this._displayRows();
    const counter = document.getElementById("wuCount");
    if (counter) counter.textContent = `${shown.length.toLocaleString()} of ${this.rows.length.toLocaleString()} devices`;
    if (!host) return;
    if (!this.data || !this.data.generated_at) {
      host.innerHTML = `<div class="empty">No Windows Update report yet. Refresh from Intune to build this division’s first report.</div>`;
      return;
    }
    if (!shown.length) {
      host.innerHTML = `<div class="empty">${this.rows.length ? "No devices match these filters." : "No Windows PCs were found in this division’s Intune categories."}</div>`;
      return;
    }
    host.innerHTML = `<div class="table-scroll wu-table-scroll"><table class="fit wu-table"><thead><tr>
      <th>DEVICE</th><th>USER / SITE</th><th>INSTALLED BUILD</th><th>SECURITY UPDATE</th><th>SEVERITY</th><th>DEADLINE</th><th>LAST CHECK-IN</th><th>STATUS</th>
      </tr></thead><tbody>${shown.map(row => {
        const label = this._statusLabel(row.status);
        const target = row.kb_url ? `<a href="${attr(row.kb_url)}" target="_blank" rel="noopener noreferrer">${esc(row.update_name || "Security update")}${row.kb ? ` · ${esc(row.kb)}` : ""}</a>` : `${esc(row.update_name || "—")}${row.kb ? ` · ${esc(row.kb)}` : ""}`;
        const critical = row.severity === "Critical";
        return `<tr>
          <td><b>${esc(row.device_name || "Unnamed device")}</b><div class="muted wu-sub">${esc(row.serial || "")}${row.model ? ` · ${esc(row.model)}` : ""}</div></td>
          <td>${esc(row.user || "—")}<div class="muted wu-sub">${esc(row.site || "No site")}</div></td>
          <td class="mono">${esc(row.installed_build || row.os_version || "—")}</td>
          <td>${target}${row.target_build ? `<div class="muted wu-sub">Target ${esc(row.target_build)}</div>` : ""}</td>
          <td>${row.severity ? `<span class="wu-severity${critical ? " critical" : ""}">${esc(row.severity)}</span>` : "—"}</td>
          <td>${this._fmt(row.deadline)}${row.days_overdue ? `<div class="wu-overdue">${Number(row.days_overdue)} day${Number(row.days_overdue) === 1 ? "" : "s"} overdue</div>` : row.days_remaining ? `<div class="muted wu-sub">${Number(row.days_remaining)} day${Number(row.days_remaining) === 1 ? "" : "s"} left</div>` : ""}</td>
          <td>${this._fmt(row.last_checkin, true)}</td>
          <td><span class="wu-state ${attr(row.status)}" title="${attr(row.status_detail)}">${esc(label)}</span><div class="muted wu-sub">${esc(row.status_detail || "")}</div></td>
        </tr>`;
      }).join("")}</tbody></table></div>`;
  },

  setStatus(status) {
    const el = document.getElementById("wuStatus");
    if (!el) return;
    el.value = el.value === status ? "" : status;
    this.render();
  },

  _csvCell(value) { return `"${String(value == null ? "" : value).replace(/"/g, '""')}"`; },
  _exportRows(rows) {
    const columns = [
      ["Device", "device_name"], ["Serial", "serial"], ["Primary user", "user"], ["Site", "site"], ["Model", "model"],
      ["Installed OS build", "installed_build"], ["Security update", "update_name"], ["Target build", "target_build"],
      ["Severity", "severity"], ["Release date", "release_date"], ["Deadline", "deadline"], ["Last Intune check-in", "last_checkin"],
      ["Status", "status"], ["Status details", "status_detail"], ["KB", "kb"], ["Known exploited CVEs", "cves"],
    ];
    return [columns.map(([label]) => this._csvCell(label)).join(","),
      ...rows.map(row => columns.map(([, key]) => this._csvCell(Array.isArray(row[key]) ? row[key].join("; ") : row[key])).join(","))].join("\r\n");
  },

  async exportCsv() {
    const rows = this._displayRows();
    if (!rows.length) return App.toast("No Windows update rows to export.", true);
    const division = String((this.data && this.data.division) || "division").replace(/[^a-z0-9-]+/gi, "-").replace(/^-|-$/g, "");
    const filename = `Windows-Update-Watch-${division || "division"}-${new Date().toISOString().slice(0, 10)}.csv`;
    const r = await Backend.call("save_csv_file", filename, this._exportRows(rows));
    if (r && r.ok && !r.cancelled) App.toast(`Saved ${rows.length} Windows update row(s) to ${r.path}.`);
  },

  async copyList() {
    const rows = this._displayRows();
    if (!rows.length) return App.toast("No Windows update rows to copy.", true);
    const header = ["Device", "Serial", "User", "Site", "Installed build", "Target update", "Severity", "Deadline", "Last check-in", "Status"];
    const lines = rows.map(row => [row.device_name, row.serial, row.user, row.site, row.installed_build,
      `${row.update_name || ""}${row.kb ? ` ${row.kb}` : ""}`, row.severity, row.deadline,
      row.last_checkin, this._statusLabel(row.status)].map(value => String(value || "").replace(/[\t\r\n]+/g, " ")).join("\t"));
    try { await navigator.clipboard.writeText([header.join("\t"), ...lines].join("\n")); App.toast(`Copied ${rows.length} Windows update row(s).`); }
    catch (e) { App.toast("Clipboard access is unavailable here. Use Export CSV.", true); }
  },
};
