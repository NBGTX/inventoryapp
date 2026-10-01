/* Web-host shim: when served by webapp/NbgwHub.Web, route Backend.call to /api/call/{method}.
   Inert under pywebview (desktop) and under the Mock preview (no /api/ping). */
(function () {
  if (window.pywebview || typeof Backend === "undefined") return;
  const orig = Backend.call.bind(Backend);
  const ready = fetch("/api/ping", { credentials: "same-origin" })
    .then(r => r.ok ? r.json() : null).then(j => !!(j && j.web)).catch(() => false);
  Backend.call = async function (method, ...args) {
    if (!(await ready)) return orig(method, ...args);
    const r = await fetch("/api/call/" + encodeURIComponent(method), {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ args }),
    });
    const j = await r.json().catch(() => ({ ok: false, error: "bad response" }));
    if (r.status === 404 && j.error === "not_implemented") return orig(method, ...args);   // not ported yet -> Mock
    return j;
  };
  // Division (tenant) switcher
  ready.then(async ok => {
    if (!ok) return;
    const d = await Backend.call("get_divisions");
    if (!d || !d.ok || d.divisions.length < 2) return;
    const s = document.createElement("select");
    s.title = "Division";
    s.style.cssText = "position:fixed;top:8px;right:8px;z-index:9999;background:var(--panel,#1b1f27);color:inherit;border:1px solid #444;border-radius:6px;padding:4px 8px";
    s.innerHTML = d.divisions.map(x => `<option value="${x.id}"${x.id === d.current ? " selected" : ""}>${x.name}</option>`).join("");
    s.onchange = async () => { await Backend.call("switch_division", s.value); location.reload(); };
    document.body.appendChild(s);
  });
})();
