/* ---- Issues board: bugs and feature requests for the whole platform --------------------------------
   One shared list (all divisions). Anyone signed in reports, comments, votes and watches; super admins triage
   (status, assignee, delete). The page only displays: every rule is enforced by the Api (issues.py).
   Uses esc()/attr()/Backend/App/Tz/DirPicker/Ui/Help from app.js. */
/* Attach: pick files, drag them in, or paste a screenshot from the clipboard. Files are read here and sent to the Api as base64;
   the Api re-checks type, size and content, so this only gives early, friendly messages. */
const Attach = {
  MAX_FILES: 5, MAX_BYTES: 5 * 1024 * 1024, ALLOWED: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "pdf", "txt", "log", "csv"],
  forms: {},
  mount(key, hostId, pasteIds) {
    const st = this.forms[key] = this.forms[key] || { files: [] };
    st.files = [];
    const host = document.getElementById(hostId);
    if (!host) return;
    host.innerHTML = `<div class="att-zone" id="${hostId}-z"><span>📎 Drop files here, paste a screenshot (Ctrl+V), or</span>
        <button type="button" class="ghost" style="padding:5px 12px" onclick="document.getElementById('${hostId}-in').click()">Choose files</button>
        <input type="file" id="${hostId}-in" multiple hidden accept="${this.ALLOWED.map(e => "." + e).join(",")}">
        <span style="margin-left:auto">png, jpg, gif, webp, pdf, txt, log, csv · 5 MB each</span></div>
      <div class="att-list" id="${hostId}-l"></div>`;
    const zone = document.getElementById(hostId + "-z");
    document.getElementById(hostId + "-in").onchange = e => { this.add(key, hostId, e.target.files); e.target.value = ""; };
    zone.ondragover = e => { e.preventDefault(); zone.classList.add("drag"); };
    zone.ondragleave = () => zone.classList.remove("drag");
    zone.ondrop = e => { e.preventDefault(); zone.classList.remove("drag"); this.add(key, hostId, e.dataTransfer.files); };
    (pasteIds || []).forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener("paste", e => {
      const imgs = [...(e.clipboardData && e.clipboardData.items || [])].filter(i => i.kind === "file" && i.type.startsWith("image/")).map(i => i.getAsFile()).filter(Boolean);
      if (imgs.length) { e.preventDefault(); this.add(key, hostId, imgs.map((f, n) => new File([f], "screenshot-" + new Date().toISOString().slice(11, 19).replace(/:/g, "") + (n ? "-" + n : "") + "." + (f.type.split("/")[1] || "png").replace("jpeg", "jpg"), { type: f.type }))); }
    }); });
  },
  async add(key, hostId, fileList) {
    const st = this.forms[key];
    for (const f of [...fileList]) {
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      if (st.files.length >= this.MAX_FILES) { App.toast("At most " + this.MAX_FILES + " files at a time.", true); break; }
      if (!this.ALLOWED.includes(ext)) { App.toast("'" + f.name + "': this kind of file is not accepted.", true); continue; }
      if (f.size > this.MAX_BYTES) { App.toast("'" + f.name + "' is too big (5 MB at most).", true); continue; }
      if (f.size === 0) { App.toast("'" + f.name + "' is empty.", true); continue; }
      const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
      st.files.push({ name: f.name, data: String(url).split(",")[1] || "", preview: f.type.startsWith("image/") ? url : "", size: f.size });
    }
    this.draw(key, hostId);
  },
  draw(key, hostId) {
    const st = this.forms[key], el = document.getElementById(hostId + "-l");
    if (!el) return;
    el.innerHTML = st.files.map((f, i) => `<div class="att-item">${f.preview ? `<img src="${attr(f.preview)}" alt="">` : `<div class="att-ic">📄</div>`}
      <div class="att-name" title="${attr(f.name)}">${esc(f.name)}</div><div>${Math.max(1, Math.round(f.size / 1024))} KB</div>
      <button type="button" class="att-x" title="Remove" onclick="Attach.remove('${key}','${hostId}',${i})">&times;</button></div>`).join("");
  },
  remove(key, hostId, i) { this.forms[key].files.splice(i, 1); this.draw(key, hostId); },
  payload(key) { return (this.forms[key] ? this.forms[key].files : []).map(f => ({ name: f.name, data: f.data })); },

  /* ---- showing saved attachments ---- */
  html(issueId, list) {
    if (!list || !list.length) return "";
    return `<div class="att-list">` + list.map(a => /^image\//.test(a.type)
      ? `<div class="att-item"><img data-issue="${attr(issueId)}" data-att="${attr(a.id)}" alt="${attr(a.name)}" onclick="Attach.zoom(this)"><div class="att-name" title="${attr(a.name)}">${esc(a.name)}</div><div>${Math.max(1, Math.round(a.size / 1024))} KB</div></div>`
      : `<div class="att-item file" onclick="Attach.download('${attr(issueId)}','${attr(a.id)}')" title="Download ${attr(a.name)}"><div class="att-ic">📄</div><div class="att-name">${esc(a.name)}</div><div>${Math.max(1, Math.round(a.size / 1024))} KB ⬇</div></div>`).join("") + `</div>`;
  },
  async hydrate(root) {
    for (const img of (root || document).querySelectorAll("img[data-att]:not([src])")) {
      const r = await Backend.call("issue_attachment", img.dataset.issue, img.dataset.att);
      if (r && r.ok) img.src = "data:" + r.type + ";base64," + r.data; else img.alt = "(missing)";
    }
  },
  zoom(img) {
    if (!img.src) return;
    const d = document.createElement("div"); d.className = "att-light"; d.onclick = () => d.remove();
    d.innerHTML = `<img src="${attr(img.src)}" alt="">`; document.body.appendChild(d);
  },
  async download(issueId, attId) {
    const r = await Backend.call("issue_attachment", issueId, attId);
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not get the file.", true);
    const a = document.createElement("a"); a.href = "data:" + r.type + ";base64," + r.data; a.download = r.name; document.body.appendChild(a); a.click(); a.remove();
  },
};

const Issues = {
  list: [], meta: { triage: false, me: "", statuses: [] }, cur: null, detail: null,
  f: { status: "open", type: "", mine: false, q: "", sort: "updated" },
  STATUS_LABEL: { open: "Open", planned: "Planned", in_progress: "In progress", done: "Done", wont_do: "Won't do" },

  async load() {
    const host = document.getElementById("issuesHost");
    if (!host) return;
    if (!this.list.length && !this.cur) host.innerHTML = `<div class="empty">Loading…</div>`;
    const r = await Backend.call("issues_list");
    if (!r || !r.ok) { host.innerHTML = `<div class="empty">${esc((r && r.error) || "Could not load the issues.")}<div style="margin-top:10px"><button class="rowbtn" onclick="Issues.load()">↻ Retry</button></div></div>`; return; }
    this.list = r.issues; this.meta = { triage: !!r.triage, me: r.me || "", statuses: r.statuses || [] };
    if (this.cur) return this.open(this.cur, true);
    this.renderList();
  },
  refresh(btn) { return Ui.refreshing(btn, () => this.load(), "Issues"); },

  /* ---------------------------------------------------------------- list */
  ago(iso) {
    const t = Date.parse(iso || ""); if (isNaN(t)) return "";
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return "just now"; if (m < 60) return m + " min ago";
    const h = Math.round(m / 60); if (h < 24) return h + " h ago";
    const d = Math.round(h / 24); if (d < 31) return d + " day" + (d === 1 ? "" : "s") + " ago";
    return Tz.date(iso, { year: "numeric", month: "short", day: "numeric" });
  },
  pill(st) { return `<span class="iss-st ${attr(st)}">${esc(this.STATUS_LABEL[st] || st)}</span>`; },
  icon(t) { return t === "feature" ? "💡" : "🐞"; },
  filtered() {
    const f = this.f, q = f.q.toLowerCase().trim(), me = (this.meta.me || "").toLowerCase();
    let rows = this.list.filter(i => (f.status === "all" || i.status === f.status) && (!f.type || i.type === f.type) && (!f.mine || i.mine)
      && (!q || (i.title + " " + i.short + " " + ((i.reporter || {}).name || "") + " " + ((i.division || {}).name || "")).toLowerCase().includes(q)));
    const by = { updated: (a, b) => b.updated_at.localeCompare(a.updated_at), newest: (a, b) => b.created_at.localeCompare(a.created_at),
                 votes: (a, b) => b.votes - a.votes || b.updated_at.localeCompare(a.updated_at), comments: (a, b) => b.comments - a.comments };
    return rows.sort(by[f.sort] || by.updated);
  },
  renderList() {
    this.cur = null; this.detail = null;
    const host = document.getElementById("issuesHost");
    const count = s => s === "all" ? this.list.length : this.list.filter(i => i.status === s).length;
    const chips = ["open", "planned", "in_progress", "done", "wont_do", "all"].map(s =>
      `<button class="iss-chip${this.f.status === s ? " on" : ""}" onclick="Issues.set('status','${s}')">${s === "all" ? "All" : this.STATUS_LABEL[s]} <span>${count(s)}</span></button>`).join("");
    const rows = this.filtered();
    host.innerHTML = `
      <div class="iss-bar">${chips}</div>
      <div class="iss-tools">
        <input id="issQ" placeholder="Search title, id, person or division…" value="${attr(this.f.q)}" oninput="Issues.typed(this.value)">
        <select onchange="Issues.set('type',this.value)"><option value="">Bugs and features</option><option value="bug"${this.f.type === "bug" ? " selected" : ""}>Bugs</option><option value="feature"${this.f.type === "feature" ? " selected" : ""}>Feature requests</option></select>
        <select onchange="Issues.set('sort',this.value)">${[["updated", "Recently updated"], ["newest", "Newest"], ["votes", "Most votes"], ["comments", "Most comments"]].map(([v, l]) => `<option value="${v}"${this.f.sort === v ? " selected" : ""}>${l}</option>`).join("")}</select>
        <div class="iss-seg" role="radiogroup" aria-label="Whose issues">
          <label class="${this.f.mine ? "" : "on"}"><input type="radio" name="issWho" ${this.f.mine ? "" : "checked"} onchange="Issues.set('mine',false)">Everyone's</label>
          <label class="${this.f.mine ? "on" : ""}"><input type="radio" name="issWho" ${this.f.mine ? "checked" : ""} onchange="Issues.set('mine',true)">Mine</label>
        </div>
      </div>
      <div class="iss-list">${rows.length ? rows.map(i => `
        <div class="iss-row" onclick="Issues.open('${attr(i.id)}')">
          <div class="iss-ic">${this.icon(i.type)}</div>
          <div class="iss-main"><div class="iss-title">${esc(i.title)}</div>
            <div class="iss-meta">${esc(i.short)} · opened ${esc(this.ago(i.created_at))} by ${esc((i.reporter || {}).name || "unknown")}${(i.division || {}).name ? " · " + esc(i.division.name) : ""}${i.assignee ? " · assigned to " + esc(i.assignee.name) : ""}</div></div>
          <div class="iss-side">${this.pill(i.status)}<span title="Votes">👍 ${i.votes}</span>${i.files ? `<span title="Attachments">📎 ${i.files}</span>` : ""}<span title="Comments">💬 ${i.comments}</span></div>
        </div>`).join("") : `<div class="empty">${this.list.length ? "Nothing matches these filters." : "No issues yet. Use New issue to report the first one."}</div>`}</div>`;
  },
  set(k, v) { this.f[k] = v; this.renderList(); },
  _t: null,
  typed(v) { clearTimeout(this._t); this._t = setTimeout(() => { this.f.q = v; this.renderList(); const el = document.getElementById("issQ"); if (el) { el.focus(); el.setSelectionRange(v.length, v.length); } }, 200); },

  /* ---------------------------------------------------------------- detail */
  async open(id, quiet) {
    const host = document.getElementById("issuesHost");
    this.cur = id;
    if (!quiet) host.innerHTML = `<div class="empty">Loading…</div>`;
    const r = await Backend.call("issue_get", id);
    if (!r || !r.ok) { this.cur = null; App.toast((r && r.error) || "Could not open it.", true); return this.load(); }
    this.detail = r;
    this.renderDetail();
  },
  timeline(d) {
    const ev = [];
    (d.comments || []).forEach(c => ev.push({ at: c.at, html: `<div class="iss-cm"><div class="iss-cm-h"><b>${esc(c.by || "someone")}</b> <span>commented ${esc(this.ago(c.at))}</span></div><div class="iss-cm-b">${c.text ? esc(c.text).replace(/\n/g, "<br>") : ""}${Attach.html(d.id, c.attachments)}</div></div>` }));
    (d.history || []).filter(h => h.action !== "created").forEach(h => {
      const what = { status: "changed the status", assigned: "assigned this to", edited: "edited this", notify: "notification" }[h.action] || h.action;
      ev.push({ at: h.at, html: `<div class="iss-ev">${h.action === "notify" ? "✉ " : "● "}${h.by ? `<b>${esc(h.by)}</b> ` : ""}${esc(what)}${h.detail ? ": " + esc(h.detail) : ""} <span>${esc(this.ago(h.at))}</span></div>` });
    });
    return ev.sort((a, b) => a.at.localeCompare(b.at)).map(e => e.html).join("");
  },
  renderDetail() {
    const r = this.detail, d = r.issue, s = r.summary, host = document.getElementById("issuesHost"), tri = !!r.triage;
    const statusSel = tri ? `<select onchange="Issues.update({status:this.value})">${(this.meta.statuses.length ? this.meta.statuses : Object.entries(this.STATUS_LABEL).map(([id, label]) => ({ id, label })))
      .map(x => `<option value="${attr(x.id)}"${x.id === d.status ? " selected" : ""}>${esc(x.label)}</option>`).join("")}</select>` : this.pill(d.status);
    host.innerHTML = `
      <button class="ghost" onclick="Issues.back()">← All issues</button>
      <div class="iss-detail">
        <div class="iss-d-main">
          <h3 class="iss-d-title">${this.icon(d.type)} ${esc(d.title)} <span class="muted">${esc(s.short)}</span></h3>
          <div class="iss-d-sub">${this.pill(d.status)} <span class="muted">${esc((d.reporter || {}).name || "unknown")} opened this ${esc(this.ago(d.created_at))}</span></div>
          ${r.can_edit ? `<div style="margin:6px 0"><button class="ghost" onclick="Issues.editBox()">✎ Edit title / description</button></div><div id="issEdit"></div>` : ""}
          <div class="iss-desc">${d.detail ? esc(d.detail).replace(/\n/g, "<br>") : `<span class="muted">No description.</span>`}${Attach.html(d.id, d.attachments)}</div>
          <h4 class="blkhead" style="margin-top:18px">Activity</h4>
          <div class="iss-tl">${this.timeline(d) || `<span class="muted">Nothing yet.</span>`}</div>
          <div class="iss-newcm"><textarea id="issCm" rows="3" placeholder="Write a comment… (paste a screenshot here with Ctrl+V)"></textarea>
            <div class="att-box" id="issCmAtt"></div>
            <div style="text-align:right;margin-top:8px"><button class="primary" onclick="Issues.comment()">Comment</button></div></div>
        </div>
        <aside class="iss-d-side">
          <div class="iss-box"><label>Status</label>${statusSel}</div>
          <div class="iss-box"><label>Assigned to</label>${tri ? `<div id="issAsg"></div>` : ""}
            <div id="issAsgNow">${d.assignee ? esc(d.assignee.name) + (tri ? ` <button class="rowbtn" onclick="Issues.update({assignee:null})">Unassign</button>` : "") : `<span class="muted">Nobody yet</span>`}</div></div>
          <div class="iss-box"><label>Type</label>${this.icon(d.type)} ${d.type === "feature" ? "Feature request" : "Bug"}</div>
          <div class="iss-box"><label>Division</label>${esc((d.division || {}).name || "—")}</div>
          <div class="iss-box"><label>App version</label>${esc(d.version || "—")}</div>
          <div class="iss-box"><label>Updated</label>${esc(Tz.dt(d.updated_at))}</div>
          <div class="iss-box"><button class="ghost" onclick="Issues.vote()">👍 ${s.voted ? "Voted" : "Vote"} · ${s.votes}</button>
            <button class="ghost" onclick="Issues.watch()" title="Get e-mails about this issue">${s.watching ? "👁 Watching" : "👁 Watch"}</button></div>
          ${tri ? `<div class="iss-box"><button class="ghost" style="color:var(--red);border-color:var(--red)" onclick="Issues.del()">Delete issue</button></div>` : ""}
        </aside>
      </div>`;
    Attach.mount("comment", "issCmAtt", ["issCm"]);
    Attach.hydrate(host);
    if (tri) DirPicker.mount("issAsg", "user", it => this.update({ assignee: { upn: it.upn, name: it.name || it.upn } }), "Assign to a person…");
  },
  back() { this.cur = null; this.detail = null; this.load(); },
  editBox() {
    const d = this.detail.issue, el = document.getElementById("issEdit");
    el.innerHTML = `<div class="field"><label>Title</label><input id="issEt" value="${attr(d.title)}" maxlength="120"></div>
      <div class="field"><label>Description</label><textarea id="issEd" rows="5">${esc(d.detail || "")}</textarea></div>
      <div style="margin:6px 0 12px"><button class="primary" onclick="Issues.saveEdit()">Save</button> <button class="ghost" onclick="document.getElementById('issEdit').innerHTML=''">Cancel</button></div>`;
  },
  saveEdit() { return this.update({ title: document.getElementById("issEt").value, detail: document.getElementById("issEd").value }); },
  async update(fields) {
    const r = await Backend.call("issue_update", this.cur, fields);
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not save.", true);
    App.toast("Saved."); this.open(this.cur, true);
  },
  async comment() {
    const el = document.getElementById("issCm"), text = (el.value || "").trim(), files = Attach.payload("comment");
    if (!text && !files.length) return App.toast("Write a comment or attach a file first.", true);
    const r = await Backend.call("issue_comment", this.cur, text, files);
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not comment.", true);
    this.open(this.cur, true);
  },
  async vote() { const r = await Backend.call("issue_vote", this.cur); if (r && r.ok) this.open(this.cur, true); else App.toast((r && r.error) || "Could not vote.", true); },
  async watch() {
    const r = await Backend.call("issue_watch", this.cur);
    if (r && r.ok) { App.toast(r.watching ? "You will get e-mails about this issue." : "You stopped watching this issue."); this.open(this.cur, true); }
    else App.toast((r && r.error) || "Could not do that.", true);
  },
  async del() {
    if (!confirm("Delete this issue for everyone? This cannot be undone.")) return;
    const r = await Backend.call("issue_delete", this.cur);
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not delete.", true);
    App.toast("Issue deleted."); this.back();
  },
};

/* The sidebar's "Report bug / feature" button: a small form that files an issue on the board */
const Feedback = {
  open(type) {
    document.getElementById("modalRoot").innerHTML =
      `<div class="overlay"><div class="modal" style="width:560px;max-width:94vw;">
        <div class="modal-head"><h3>New issue</h3><button onclick="Feedback.close()">&times;</button></div>
        <div class="modal-body">
          <div class="field"><label>What is it?</label>
            <div class="iss-seg" id="mfbType" role="radiogroup">
              <label class="on"><input type="radio" name="mfbKind" value="bug" checked onchange="Feedback.kind('bug')">🐞 Bug: something is wrong</label>
              <label><input type="radio" name="mfbKind" value="feature" onchange="Feedback.kind('feature')">💡 Feature request: I would like…</label>
            </div></div>
          <div class="field"><label>Title</label><input id="mfbTitle" placeholder="" maxlength="120" autocomplete="off"></div>
          <div class="field"><label>Details</label>
            <textarea id="mfbDetail" rows="7" placeholder=""></textarea></div>
          <div class="field"><label>Pictures and files <span class="muted">(optional)</span></label><div id="mfbAtt"></div></div>
          <p class="muted" style="font-size:12px;margin:0">Everyone using NBG Hub can see and comment on this. You cannot edit it after you submit (you can add comments), so check it first. Do not paste passwords or personal data.</p>
        </div>
        <div class="modal-foot"><button class="ghost" onclick="Feedback.close()">Cancel</button><button class="primary" onclick="Feedback.submit()">Submit</button></div>
      </div></div>`;
    Attach.mount("new", "mfbAtt", ["mfbDetail", "mfbTitle"]);
    this.kind("bug");
    if (type) { const r = document.querySelector(`input[name=mfbKind][value=${type === "feature" ? "feature" : "bug"}]`); if (r) { r.checked = true; this.kind(r.value); } }
    setTimeout(() => { const t = document.getElementById("mfbTitle"); if (t) t.focus(); }, 30);
  },
  close() { document.getElementById("modalRoot").innerHTML = ""; },
  HINTS: {
    bug: { title: "Short summary, e.g. Hot spares window shows the wrong site",
           detail: `What did you do? What did you expect? What happened instead?
Which page and division were you on? Steps to repeat it help most.
Paste a screenshot of the problem with Ctrl+V.` },
    feature: { title: "Short summary, e.g. Export the Upgrade list to Excel",
               detail: `What would you like to be able to do?
Why does it matter: who needs it and how often?
How do you imagine it working? Paste a sketch or an example with Ctrl+V.` },
  },
  kind(v) {
    document.querySelectorAll("#mfbType label").forEach(l => l.classList.toggle("on", l.querySelector("input").value === v));
    const h = this.HINTS[v] || this.HINTS.bug, t = document.getElementById("mfbTitle"), d = document.getElementById("mfbDetail");
    if (t) t.placeholder = h.title;
    if (d) d.placeholder = h.detail;
  },
  async submit() {
    const title = (document.getElementById("mfbTitle").value || "").trim();
    if (!title) return App.toast("Add a short title.", true);
    const r = await Backend.call("issue_create", (document.querySelector("input[name=mfbKind]:checked") || {}).value || "bug", title, (document.getElementById("mfbDetail").value || "").trim(), Attach.payload("new"));
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not submit.", true);
    this.close();
    App.toast("Thanks: filed as " + r.issue.short + ". Find it under Issues.");
    if (document.getElementById("appview-issues").classList.contains("active")) Issues.load();
  },
};
