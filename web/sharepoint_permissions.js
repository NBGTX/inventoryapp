"use strict";

const SharePointPermissions = {
  KEY: "nbg_spm_site",
  FAVORITES_KEY: "nbg_spm_favorite_sites",
  RECENTS_KEY: "nbg_spm_recent_sites",
  SITE_CACHE_KEY: "nbg_spm_site_index_v1",
  HISTORY_KEY: "nbg_spm_scan_history_v1",
  REVIEW_KEY: "nbg_spm_review_plans_v1",
  SEARCH_KEY: "nbg_spm_saved_searches_v1",
  favoriteSites: [],
  recentSites: [],
  siteIndexCache: null,
  sitePrefsHydrated: false,
  sitePrefsSave: Promise.resolve(),
  data: null,
  previousScan: null,
  selected: -1,
  peopleMode: "people",
  matrixPage: 0,
  matrixPageSize: 12,
  matrixRowPage: 0,
  matrixRowPageSize: 100,
  scanStartedAt: 0,
  scanProgressPercent: 0,
  selectedSite: false,
  entered: false,
  tutorialShownFor: "",
  siteSearchResults: [],
  siteSearchDisplayResults: [],
  siteSearchQuery: "",
  siteSearchNext: null,
  siteSearchTimer: null,
  siteSearchRequest: 0,
  siteLibraries: [],
  folderChildren: {},
  folderExpanded: new Set(),
  folderSelected: new Set(),
  folderNodes: {},
  copySource: null,
  copyTarget: null,
  selectedSharingLinks: new Set(),

  async enter() {
    const input = document.getElementById("spmSite");
    if (input && !this.entered) {
      this.entered = true;
      input.value = "";
      try { localStorage.removeItem(this.KEY); } catch (e) {}
    }
    this.loadSavedSites();
    await this.hydrateSavedSites();
    if (this.selectedSite) {
      document.getElementById("spmBrowserPage").classList.add("hidden");
      document.getElementById("spmScanPage").classList.remove("hidden");
      if (this.data) this.render();
    } else {
      this.showBrowserPage(false);
      if (!this.siteSearchResults.length) this.searchSites();
    }
  },

  openSiteSearch() {
    this.showBrowserPage();
    if (!this.siteSearchResults.length) this.searchSites();
  },

  showBrowserPage(clearSelection = true) {
    const browser = document.getElementById("spmBrowserPage");
    const scan = document.getElementById("spmScanPage");
    const input = document.getElementById("spmSite");
    if (!browser || !scan) return;
    browser.classList.remove("hidden");
    scan.classList.add("hidden");
    if (clearSelection) {
      this.selectedSite = false;
      this.data = null;
      this.selectedSharingLinks.clear();
      this.selected = -1;
      this.folderSelected = new Set();
      this.copySource = null;
      this.copyTarget = null;
      this.siteLibraries = [];
      this.folderChildren = {};
      this.folderExpanded = new Set();
      if (input) input.value = "";
      try { localStorage.removeItem(this.KEY); } catch (e) {}
      const results = document.getElementById("spmResults");
      if (results) results.classList.add("hidden");
      const title = document.querySelector("#appview-sharepointperms .pagehead p");
      if (title) title.textContent = "Find folders and files with permissions that differ from their parent.";
    }
    this.renderSiteShortcuts(this.siteSearchQuery.toLocaleLowerCase());
  },

  showScanPage() {
    this.selectedSite = true;
    document.getElementById("spmBrowserPage").classList.add("hidden");
    document.getElementById("spmScanPage").classList.remove("hidden");
  },

  browseSites() {
    clearTimeout(this.siteSearchTimer);
    const input = document.getElementById("spmSiteSearchQuery");
    if (input) input.value = "";
    this.searchSites();
  },

  scheduleSiteFilter() {
    clearTimeout(this.siteSearchTimer);
    this.siteSearchTimer = setTimeout(() => this.searchSites(), 300);
  },

  async searchSites(loadMore = false) {
    const input = document.getElementById("spmSiteSearchQuery");
    const status = document.getElementById("spmSiteSearchStatus");
    const results = document.getElementById("spmSiteSearchResults");
    const button = document.getElementById("spmSiteSearchGo");
    const browseButton = document.getElementById("spmSiteSearchBrowse");
    if (!status || !results) return;
    clearTimeout(this.siteSearchTimer);
    const requestId = ++this.siteSearchRequest;
    const query = (input && input.value || "").trim();
    this.siteSearchQuery = query;
    const cached = !query && !loadMore ? this.readSiteIndexCache() : null;
    const start = loadMore ? this.siteSearchNext : 0;
    if (loadMore && start == null) return;
    if (!loadMore) {
      this.siteSearchResults = cached ? cached.sites : [];
      this.siteSearchNext = cached ? cached.next_start : null;
      if (cached && cached.sites.length) this.renderSiteSearchResults(cached.total || cached.sites.length);
      else results.innerHTML = "";
    }
    if (button) button.disabled = true;
    if (browseButton) browseButton.disabled = true;
    status.textContent = query ? "Filtering SharePoint’s site index…" : "Loading indexed sites…";
    const job = Busy.jobStart("sharepoint_permissions_search_sites");
    try {
      const result = await Backend.call("sharepoint_permissions_search_sites", query, start || 0);
      if (!result || !result.ok) throw new Error((result && result.error) || "Site search failed.");
      if (requestId !== this.siteSearchRequest) return;
      if (loadMore) this.siteSearchResults.push(...(result.sites || []));
      else this.siteSearchResults = result.sites || [];
      this.siteSearchNext = result.next_start;
      if (!query) this.writeSiteIndexCache({ sites: this.siteSearchResults.slice(0, 500), next_start: this.siteSearchNext, total: Number(result.total || this.siteSearchResults.length) });
      this.renderSiteSearchResults(Number(result.total || this.siteSearchResults.length));
      const total = Number(result.total || this.siteSearchResults.length);
      status.textContent = this.siteSearchNext == null && total > this.siteSearchResults.length && this.siteSearchResults.length >= 500
        ? `Showing first 500 of ${total.toLocaleString()} indexed sites. Add a search term to narrow results.`
        : `${this.siteSearchResults.length.toLocaleString()} of ${total.toLocaleString()} indexed sites shown.`;
      document.getElementById("spmSiteSearchMore").classList.toggle("hidden", this.siteSearchNext == null);
    } catch (e) {
      if (requestId === this.siteSearchRequest) {
        const error = String((e && e.message) || e);
        status.textContent = !query && this.siteSearchResults.length
          ? `Showing saved sites. Live SharePoint browse failed: ${error}`
          : error;
      }
    } finally {
      if (button) button.disabled = false;
      if (browseButton) browseButton.disabled = false;
      Busy.jobEnd(job);
    }
  },

  renderSiteSearchResults(total) {
    const host = document.getElementById("spmSiteSearchResults");
    if (!host) return;
    const current = this.currentSiteOption();
    const filter = this.siteSearchQuery.toLocaleLowerCase();
    const results = this.siteSearchResults.map(site => ({ ...site, current: false }));
    if (current && (!filter || `${current.title} ${current.url}`.toLocaleLowerCase().includes(filter))) {
      const matching = results.find(site => site.url.toLocaleLowerCase() === current.url.toLocaleLowerCase());
      if (matching) matching.current = true;
      else results.unshift(current);
    }
    results.sort((a, b) => Number(b.current) - Number(a.current) || a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }));
    this.siteSearchDisplayResults = results;
    this.renderSiteShortcuts(filter);
    if (!results.length) {
      host.innerHTML = '<div class="empty">No matching indexed sites under /sites. A new site may not appear until SharePoint indexes it.</div>';
      return;
    }
    host.innerHTML = results.map((site, index) => this.siteTile(site, `SharePointPermissions.useSiteSearchResult(${index})`)).join("");
  },

  loadSavedSites() {
    if (this.sitePrefsHydrated) return;
    const read = key => { try { const value = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(value) ? value.filter(site => site && site.url && site.title) : []; } catch (e) { return []; } };
    this.favoriteSites = read(this.FAVORITES_KEY);
    this.recentSites = read(this.RECENTS_KEY).slice(0, 8);
  },

  async hydrateSavedSites() {
    if (this.sitePrefsHydrated) return;
    try {
      const saved = await Backend.call("sharepoint_sites_preferences_get");
      if (saved && saved.ok) {
        this.favoriteSites = Array.isArray(saved.favorites) ? saved.favorites : this.favoriteSites;
        this.recentSites = Array.isArray(saved.recents) ? saved.recents : this.recentSites;
        this.siteIndexCache = saved.site_index || null;
      }
    } catch (e) {}
    this.sitePrefsHydrated = true;
    this.renderSiteShortcuts(this.siteSearchQuery.toLocaleLowerCase());
  },

  persistSitePreferences() {
    if (!this.sitePrefsHydrated) return;
    const snapshot = {
      favorites: this.favoriteSites,
      recents: this.recentSites,
      site_index: this.siteIndexCache,
    };
    this.sitePrefsSave = this.sitePrefsSave.catch(() => {}).then(() => Backend.call("sharepoint_sites_preferences_save", snapshot));
  },

  readSiteIndexCache() {
    if (this.siteIndexCache && Array.isArray(this.siteIndexCache.sites)) return this.siteIndexCache;
    try {
      const value = JSON.parse(localStorage.getItem(this.SITE_CACHE_KEY) || "null");
      return value && Array.isArray(value.sites) ? value : null;
    } catch (e) { return null; }
  },

  writeSiteIndexCache(value) {
    this.siteIndexCache = value;
    try { localStorage.setItem(this.SITE_CACHE_KEY, JSON.stringify(value)); } catch (e) {}
    this.persistSitePreferences();
  },

  siteTile(site, action) {
    const initials = (site.title || "SP").trim().split(/\s+/).slice(0, 2).map(word => word.charAt(0)).join("").toUpperCase() || "SP";
    const isFavorite = this.favoriteSites.some(item => item.url.toLowerCase() === site.url.toLowerCase());
    const encodedUrl = encodeURIComponent(site.url).replaceAll("'", "%27");
    const star = `<button class="spm-site-favorite${isFavorite ? " on" : ""}" onclick="event.stopPropagation();SharePointPermissions.toggleFavorite('${encodedUrl}')" aria-label="${isFavorite ? "Remove from" : "Add to"} favorite sites" title="${isFavorite ? "Remove favorite" : "Add favorite"}">${isFavorite ? "★" : "☆"}</button>`;
    return `<div class="spm-site-option">${star}<button class="spm-site-option-pick" onclick="${action}"><span class="spm-site-option-icon" aria-hidden="true">${esc(initials)}${site.logo ? `<img src="${esc(site.logo)}" alt="" onerror="this.remove()">` : ""}</span><span class="spm-site-option-copy"><b>${esc(site.title)}</b>${site.current ? '<i class="spm-site-current">Current site</i>' : ""}<small>${esc(site.url)}</small></span></button></div>`;
  },

  renderSiteShortcuts(filter = "") {
    const host = document.getElementById("spmSiteShortcuts");
    if (!host) return;
    this.loadSavedSites();
    const matches = site => !filter || `${site.title} ${site.url}`.toLocaleLowerCase().includes(filter);
    const section = (title, sites, collection) => {
      const shown = sites.filter(matches);
      if (!shown.length) return "";
      return `<h4 class="spm-site-shortcut-title">${title}</h4><div class="spm-site-search-results spm-site-shortcuts">${shown.map(site => {
        const index = sites.indexOf(site);
        return this.siteTile(site, `SharePointPermissions.useSavedSite('${collection}',${index})`);
      }).join("")}</div>`;
    };
    host.innerHTML = section("Favorite sites", this.favoriteSites, "favorites") + section("Recent sites", this.recentSites, "recents");
  },

  toggleFavorite(encodedUrl) {
    this.loadSavedSites();
    let url = "";
    try { url = decodeURIComponent(encodedUrl); } catch (e) { return; }
    const site = [...this.siteSearchResults, ...this.favoriteSites, ...this.recentSites, this.currentSiteOption()].filter(Boolean).find(item => item.url.toLowerCase() === url.toLowerCase());
    if (!site) return;
    const index = this.favoriteSites.findIndex(item => item.url.toLowerCase() === site.url.toLowerCase());
    if (index >= 0) this.favoriteSites.splice(index, 1);
    else this.favoriteSites.unshift({ title: site.title, url: site.url, logo: site.logo || "" });
    try { localStorage.setItem(this.FAVORITES_KEY, JSON.stringify(this.favoriteSites)); } catch (e) {}
    this.persistSitePreferences();
    this.renderSiteShortcuts(this.siteSearchQuery.toLocaleLowerCase());
    this.renderSiteSearchResults(Number(this.siteSearchNext == null ? this.siteSearchResults.length : this.siteSearchResults.length));
  },

  useSavedSite(collection, index) {
    const sites = collection === "favorites" ? this.favoriteSites : this.recentSites;
    const site = sites[Number(index)];
    if (site) this.selectSite(site);
  },

  selectSite(site) {
    const input = document.getElementById("spmSite");
    if (!site || !input) return;
    input.value = site.url;
    try { localStorage.setItem(this.KEY, site.url); } catch (e) {}
    this.addRecentSite(site);
    this.siteLibraries = [];
    this.folderChildren = {};
    this.folderExpanded = new Set();
    this.folderSelected = new Set();
    this.copySource = null;
    this.copyTarget = null;
    this.showScanPage();
    this.setStatus(`Selected ${site.title}. Browse folders, then scan chosen content.`, false, true);
    this.loadContentBrowser();
    document.getElementById("spmConnect").focus();
  },

  async loadContentBrowser() {
    const status = document.getElementById("spmFolderBrowserStatus");
    if (!status) return;
    status.textContent = "Loading document libraries…";
    try {
      const site = (document.getElementById("spmSite")?.value || "").trim();
      const result = await Backend.call("sharepoint_permissions_browse_content", site);
      if (!result || !result.ok) throw new Error((result && result.error) || "Could not load document libraries.");
      this.siteLibraries = result.libraries || [];
      status.textContent = `${this.siteLibraries.length.toLocaleString()} document libraries. Expand a library or folder to browse; select folders to scan.`;
      this.renderFolderBrowser();
    } catch (e) {
      status.textContent = String((e && e.message) || e);
    }
  },

  toggleFolderBrowser() {
    const body = document.getElementById("spmFolderBrowserBody");
    const button = document.getElementById("spmFolderBrowserToggle");
    if (!body || !button) return;
    const collapsed = !body.classList.contains("hidden");
    body.classList.toggle("hidden", collapsed);
    button.textContent = collapsed ? "Show folders" : "Collapse";
    button.setAttribute("aria-expanded", String(!collapsed));
  },

  async toggleFolderExpanded(encodedKey) {
    let key = "";
    try { key = decodeURIComponent(encodedKey); } catch (e) { return; }
    const node = this.folderNodes[key];
    if (!node) return;
    if (this.folderExpanded.has(key)) this.folderExpanded.delete(key);
    else {
      this.folderExpanded.add(key);
      if (!Object.prototype.hasOwnProperty.call(this.folderChildren, key)) {
        const status = document.getElementById("spmFolderBrowserStatus");
        if (status) status.textContent = `Loading folders in ${node.title}…`;
        try {
          const site = (document.getElementById("spmSite")?.value || "").trim();
          const result = await Backend.call("sharepoint_permissions_browse_content", site, node.path, node.list_id);
          if (!result || !result.ok) throw new Error((result && result.error) || "Could not load child folders.");
          this.folderChildren[key] = result.folders || [];
          if (status) status.textContent = `${this.siteLibraries.length.toLocaleString()} document libraries. Expand a library or folder to browse; select folders to scan.`;
        } catch (e) {
          this.folderExpanded.delete(key);
          if (status) status.textContent = String((e && e.message) || e);
        }
      }
    }
    this.renderFolderBrowser();
  },

  toggleFolderSelected(encodedKey) {
    let key = "";
    try { key = decodeURIComponent(encodedKey); } catch (e) { return; }
    const node = this.folderNodes[key];
    if (!node) return;
    const path = node.path.toLocaleLowerCase();
    const listId = node.list_id.toLocaleLowerCase();
    const selected = [...this.folderSelected];
    const existing = selected.find(item => item.list_id.toLocaleLowerCase() === listId && item.path.toLocaleLowerCase() === path);
    if (existing) this.folderSelected.delete(existing.key);
    else {
      for (const item of selected) {
        if (item.list_id.toLocaleLowerCase() !== listId) continue;
        const current = item.path.toLocaleLowerCase();
        if (path === current || path.startsWith(current + "/") || current.startsWith(path + "/")) this.folderSelected.delete(item.key);
      }
      this.folderSelected.add({ key, path: node.path, list_id: node.list_id, title: node.title, library: node.library });
    }
    this.renderFolderBrowser();
  },

  renderFolderBrowser() {
    const host = document.getElementById("spmFolderBrowserTree");
    if (!host) return;
    this.folderNodes = {};
    const renderNode = (node, listId, library, depth) => {
      const key = `${listId}|${node.path}`;
      this.folderNodes[key] = { ...node, list_id: listId, library };
      const encoded = this.encodeArgument(key);
      const selected = [...this.folderSelected].some(item => item.key === key);
      const expanded = this.folderExpanded.has(key);
      const hasChildren = !!node.isLibrary || (this.folderChildren[key] || []).length > 0 || !Object.prototype.hasOwnProperty.call(this.folderChildren, key);
      const children = expanded ? (this.folderChildren[key] || []).map(child => renderNode(child, listId, library, depth + 1)).join("") : "";
      const childRows = (this.folderChildren[key] || []).length;
      const name = node.title || node.name || "Folder";
      return `<div class="spm-folder-node" style="--folder-depth:${Math.min(depth, 12)}"><div class="spm-folder-row"><button class="spm-folder-expand" onclick="SharePointPermissions.toggleFolderExpanded('${encoded}')" aria-label="${expanded ? "Collapse" : "Expand"} ${esc(name)}">${hasChildren ? (expanded ? "▾" : "▸") : "·"}</button><input type="checkbox" ${selected ? "checked" : ""} onchange="SharePointPermissions.toggleFolderSelected('${encoded}')" aria-label="Select ${esc(name)}"><span class="spm-folder-icon" aria-hidden="true">📁</span><span class="spm-folder-name"><b>${esc(name)}</b><small>${esc(library)}${node.has_unique ? " · unique permissions" : ""}${expanded && !childRows ? " · no subfolders" : ""}</small></span></div>${children ? `<div class="spm-folder-children">${children}</div>` : ""}</div>`;
    };
    host.innerHTML = this.siteLibraries.length ? this.siteLibraries.map(lib => renderNode({
      title: lib.title, name: lib.title, path: lib.root_url, isLibrary: true, has_unique: lib.has_unique,
    }, lib.id, lib.title, 0)).join("") : '<div class="empty">No document libraries found.</div>';
    const count = document.getElementById("spmFolderSelectionCount");
    if (count) count.textContent = `${this.folderSelected.size.toLocaleString()} folders selected`;
    const scan = document.getElementById("spmConnect");
    if (scan) scan.disabled = this.folderSelected.size === 0;
    const propagate = document.getElementById("spmPropagateButton");
    if (propagate) propagate.disabled = this.folderSelected.size !== 1;
    this.renderCopySelection();
  },

  captureCopyEndpoint(which) {
    if (this.folderSelected.size !== 1) return App.toast("Select one library or folder first.", true);
    const selected = [...this.folderSelected][0];
    this[which === "source" ? "copySource" : "copyTarget"] = { ...selected };
    this.folderSelected = new Set();
    this.renderFolderBrowser();
  },

  renderCopySelection() {
    const selected = [...this.folderSelected];
    const oneSelected = selected.length === 1;
    const sourceButton = document.getElementById("spmCopySourceButton");
    const targetButton = document.getElementById("spmCopyTargetButton");
    const previewButton = document.getElementById("spmCopyPreviewButton");
    if (sourceButton) sourceButton.disabled = !oneSelected;
    if (targetButton) targetButton.disabled = !oneSelected;
    const source = this.copySource, target = this.copyTarget;
    const summary = document.getElementById("spmCopySelectionSummary");
    const describe = item => item ? `${item.library} · ${item.path}` : "Not selected";
    if (summary) summary.textContent = `Source: ${describe(source)} · Destination: ${describe(target)}`;
    const same = source && target && source.list_id.toLowerCase() === target.list_id.toLowerCase()
      && source.path.toLowerCase() === target.path.toLowerCase();
    if (previewButton) previewButton.disabled = !(source && target) || !!same;
  },

  async preparePermissionCopy(button) {
    if (!this.copySource || !this.copyTarget) return App.toast("Choose both a source and destination.", true);
    const site = (document.getElementById("spmSite")?.value || "").trim();
    const btn = button || document.getElementById("spmCopyPreviewButton");
    if (btn) { btn.disabled = true; btn.textContent = "Preparing preview…"; }
    try {
      const plan = await Backend.call("sharepoint_permissions_prepare_copy", site,
        this.copySource.list_id, this.copySource.path, this.copyTarget.list_id, this.copyTarget.path);
      if (!plan || !plan.ok) throw new Error((plan && plan.error) || "Could not prepare permission-copy preview.");
      this.showPermissionCopyPreview(plan);
    } catch (e) {
      App.toast(String((e && e.message) || e), true);
    } finally {
      if (btn) { btn.textContent = "Preview permission copy"; this.renderCopySelection(); }
    }
  },

  showPermissionCopyPreview(plan) {
    const grants = plan.source_grants || [];
    const rows = grants.map(grant => `<div class="spm-propagate-row"><span>${grant.sharing_link ? "Sharing link · not copied" : grant.operator_preserved ? "Your access · kept" : "Grant"}</span><b>${esc(grant.title)}</b><small>${esc(grant.level || "Permission")}</small></div>`).join("");
    const removed = (plan.target_grants || []).map(grant => `<div class="spm-propagate-row"><span>${grant.operator_preserved ? "Your access · kept" : "Removed"}</span><b>${esc(grant.title)}</b><small>${esc(grant.level || "Permission")}${grant.sharing_link ? " · sharing link" : ""}</small></div>`).join("");
    const descendants = (plan.descendants || []).map(item => `<div class="spm-propagate-row"><span>${esc(item.type)}</span><b>${esc(item.path)}</b><small>${Number(item.grants || 0).toLocaleString()} grants${item.sharing_links ? ` · ${Number(item.sharing_links).toLocaleString()} sharing links removed` : ""}</small></div>`).join("");
    const warnings = [];
    if (plan.source_links_not_copied) warnings.push(`${Number(plan.source_links_not_copied).toLocaleString()} source sharing-link grants will not be copied.`);
    if (plan.target_sharing_links) warnings.push(`${Number(plan.target_sharing_links).toLocaleString()} direct destination sharing-link grants will be removed.`);
    if (plan.descendant_sharing_links) warnings.push(`${Number(plan.descendant_sharing_links).toLocaleString()} destination items have sharing-link grants; propagation removes them.`);
    warnings.push("Hub preserves your direct account grant on destination to help prevent lockout; that grant may differ from source.");
    const warning = warnings.length ? `<div class="spm-warning">${warnings.map(esc).join(" ")}</div>` : "";
    document.getElementById("modalRoot").innerHTML = `<div class="overlay"><div class="modal spm-fix-modal spm-propagate-modal" role="dialog" aria-modal="true" aria-labelledby="spmCopyTitle"><div class="modal-head"><h3 id="spmCopyTitle">Review permission copy</h3><button onclick="App._closeModal()" aria-label="Close">&times;</button></div><div class="modal-body"><p><b>Copy from:</b> ${esc(plan.source_library)} · ${esc(plan.source_path)}</p><p><b>Copy to:</b> ${esc(plan.target_library)} · ${esc(plan.target_path)}</p><p>${Number(grants.filter(row => !row.sharing_link && !row.operator_preserved).length).toLocaleString()} source grants will be copied. Your direct account grant will be kept if present. ${Number(plan.target_grant_count || 0).toLocaleString()} destination grants reviewed. ${Number(plan.descendant_count || 0).toLocaleString()} uniquely permissioned descendants will inherit from destination.</p>${warning}<h4>Source access to apply</h4><div class="spm-propagate-list">${rows || '<div class="empty">No permissions to copy.</div>'}</div><h4>Current destination access</h4><div class="spm-propagate-list">${removed || '<div class="empty">No direct destination grants.</div>'}</div><h4>Descendants to reset</h4><div class="spm-propagate-list">${descendants || '<div class="empty">No descendants have unique permissions.</div>'}</div></div><div class="modal-foot"><button class="ghost" onclick="App._closeModal()">Cancel</button><button class="primary" ${grants.some(row => !row.sharing_link) ? "" : "disabled"} onclick="SharePointPermissions.applyPermissionCopy('${plan.plan_id}')">Apply reviewed copy</button></div></div></div>`;
  },

  async applyPermissionCopy(planId, button) {
    if (!window.confirm("Replace destination permissions with source grants and reset unique permissions on all listed descendants? Sharing links will not be copied.")) return;
    const btn = button || document.querySelector("#modalRoot .modal-foot .primary");
    if (btn) { btn.disabled = true; btn.textContent = "Applying…"; }
    try {
      const result = await Backend.call("sharepoint_permissions_apply_copy", planId, true);
      if (!result || !result.ok) throw new Error((result && result.error) || "Permission copy failed.");
      App._closeModal();
      const errors = result.errors || [];
      document.getElementById("modalRoot").innerHTML = `<div class="overlay"><div class="modal spm-fix-modal" role="dialog" aria-modal="true"><div class="modal-head"><h3>Permission copy result</h3><button onclick="App._closeModal()" aria-label="Close">&times;</button></div><div class="modal-body"><p>${result.target_updated ? "Destination grants updated." : "Destination grants may be partially updated."} ${Number(result.grants_added || 0).toLocaleString()} grants added. ${Number((result.descendants_reset || []).length).toLocaleString()} descendants now inherit from destination.</p>${errors.length ? `<div class="spm-warning">${errors.length.toLocaleString()} changes failed. Review these paths; some changes may already have applied.</div><div class="spm-propagate-list">${errors.slice(0, 100).map(item => `<div class="spm-propagate-row"><b>${esc(item.path)}</b><small>${esc(item.error)}</small></div>`).join("")}</div>` : ""}<p class="muted">Rescan destination to verify permissions.</p></div><div class="modal-foot"><button class="primary" onclick="App._closeModal()">Close</button></div></div></div>`;
      this.setStatus(errors.length ? "Permission copy partially applied. Review the listed paths." : "Permission copy applied. Rescan destination to verify.", false, !errors.length, !!errors.length);
    } catch (e) {
      App.toast(String((e && e.message) || e), true);
      if (btn) { btn.disabled = false; btn.textContent = "Apply reviewed copy"; }
    }
  },

  async prepareInheritance(button) {
    if (this.folderSelected.size !== 1) return App.toast("Select exactly one parent folder first.", true);
    const selected = [...this.folderSelected][0];
    const site = (document.getElementById("spmSite")?.value || "").trim();
    const btn = button || document.getElementById("spmPropagateButton");
    if (btn) { btn.disabled = true; btn.textContent = "Checking descendants…"; }
    try {
      const plan = await Backend.call("sharepoint_permissions_prepare_inheritance", site, selected.list_id, selected.path);
      if (!plan || !plan.ok) throw new Error((plan && plan.error) || "Could not prepare permission preview.");
      this.showInheritancePreview(plan);
    } catch (e) {
      App.toast(String((e && e.message) || e), true);
    } finally {
      if (btn) { btn.disabled = this.folderSelected.size !== 1; btn.textContent = "Preview permission propagation"; }
    }
  },

  showInheritancePreview(plan) {
    const targets = plan.targets || [];
    const rows = targets.map(target => `<div class="spm-propagate-row"><span>${esc(target.type)}</span><b>${esc(target.path)}</b><small>${Number(target.grants || 0).toLocaleString()} current grants${target.sharing_links ? ` · ${Number(target.sharing_links).toLocaleString()} sharing links` : ""}${(target.access || []).length ? `<br>${(target.access || []).slice(0, 4).map(esc).join(" · ")}${target.access.length > 4 ? ` · +${target.access.length - 4} more` : ""}` : ""}</small></div>`).join("");
    const sharingWarning = Number(plan.sharing_link_targets || 0)
      ? `<div class="spm-warning">${Number(plan.sharing_link_targets).toLocaleString()} items have sharing-link grants. Applying propagation removes those unique grants; review sharing needs before continuing.</div>` : "";
    document.getElementById("modalRoot").innerHTML = `<div class="overlay"><div class="modal spm-fix-modal spm-propagate-modal" role="dialog" aria-modal="true" aria-labelledby="spmPropagateTitle"><div class="modal-head"><h3 id="spmPropagateTitle">Review permission propagation</h3><button onclick="App._closeModal()" aria-label="Close">&times;</button></div><div class="modal-body"><p>Parent folder: <b>${esc(plan.parent_path)}</b></p><p>Library: ${esc(plan.library_title)} · ${Number(plan.target_count || 0).toLocaleString()} descendant items have unique permissions.</p><p>Applying this plan makes each listed item inherit from its parent. Fix the selected parent’s permissions in SharePoint before applying if its access needs to change.</p>${sharingWarning}<div class="spm-propagate-list">${rows || '<div class="empty">No descendants have unique permissions. Nothing to change.</div>'}</div></div><div class="modal-foot"><button class="ghost" onclick="App._closeModal()">Cancel</button><button class="primary" ${targets.length ? "" : "disabled"} onclick="SharePointPermissions.applyInheritance('${plan.plan_id}')">Apply reviewed change</button></div></div></div>`;
  },

  async applyInheritance(planId, button) {
    const accepted = window.confirm("Apply this reviewed permission change? Every listed descendant will inherit permissions from its parent. Unique grants and sharing links on those items will be removed.");
    if (!accepted) return;
    const btn = button || document.querySelector("#modalRoot .modal-foot .primary");
    if (btn) { btn.disabled = true; btn.textContent = "Applying…"; }
    try {
      const result = await Backend.call("sharepoint_permissions_apply_inheritance", planId, true);
      if (!result || !result.ok) throw new Error((result && result.error) || "Permission propagation failed.");
      App._closeModal();
      const errors = result.errors || [];
      document.getElementById("modalRoot").innerHTML = `<div class="overlay"><div class="modal spm-fix-modal" role="dialog" aria-modal="true"><div class="modal-head"><h3>Propagation result</h3><button onclick="App._closeModal()" aria-label="Close">&times;</button></div><div class="modal-body"><p>${Number((result.applied || []).length).toLocaleString()} items now inherit permissions from their parent. ${Number((result.skipped || []).length).toLocaleString()} already inherited.</p>${errors.length ? `<div class="spm-warning">${errors.length.toLocaleString()} items could not be updated. Some changes may have applied; review these paths before retrying.</div><div class="spm-propagate-list">${errors.slice(0, 100).map(item => `<div class="spm-propagate-row"><b>${esc(item.path)}</b><small>${esc(item.error)}</small></div>`).join("")}</div>` : ""}<p class="muted">Rescan this folder to verify current access.</p></div><div class="modal-foot"><button class="primary" onclick="App._closeModal()">Close</button></div></div></div>`;
      this.setStatus(`${(result.applied || []).length.toLocaleString()} descendants now inherit from their parent.${errors.length ? ` ${errors.length.toLocaleString()} updates failed; inspect the result.` : ""}`, false, !errors.length, !!errors.length);
    } catch (e) {
      App.toast(String((e && e.message) || e), true);
      if (btn) { btn.disabled = false; btn.textContent = "Apply reviewed change"; }
    }
  },

  addRecentSite(site) {
    this.loadSavedSites();
    this.recentSites = [site, ...this.recentSites.filter(item => item.url.toLowerCase() !== site.url.toLowerCase())]
      .slice(0, 8).map(item => ({ title: item.title, url: item.url, logo: item.logo || "" }));
    try { localStorage.setItem(this.RECENTS_KEY, JSON.stringify(this.recentSites)); } catch (e) {}
    this.persistSitePreferences();
  },

  currentSiteOption() {
    const input = document.getElementById("spmSite");
    const value = (input && input.value || "").trim();
    return this.siteOption(value);
  },

  siteOption(value) {
    value = String(value || "").trim();
    if (!value) return null;
    try {
      const url = new URL(value.includes("://") ? value : `https://${value}`);
      const path = url.pathname.replace(/\/+$/, "");
      if (url.protocol !== "https:" || !url.hostname.toLowerCase().endsWith(".sharepoint.com") || !path.toLowerCase().startsWith("/sites/")) return null;
      const leaf = decodeURIComponent(path.split("/").pop() || "SharePoint site");
      const title = leaf.replace(/[-_]+/g, " ").trim() || "SharePoint site";
      return { title, url: `${url.origin}${path}`, logo: "" };
    } catch (e) { return null; }
  },

  useManualSite() {
    const field = document.getElementById("spmManualSite");
    const site = this.siteOption(field && field.value);
    if (!site) {
      App.toast("Enter an HTTPS SharePoint site address under /sites/.", true);
      if (field) field.focus();
      return;
    }
    this.selectSite(site);
    if (field) field.value = "";
  },

  useSiteSearchResult(index) {
    const site = this.siteSearchDisplayResults[Number(index)];
    this.selectSite(site);
  },

  async openSiteInBrowser() {
    const site = this.currentSiteOption();
    if (!site) {
      this.setStatus("Enter a valid SharePoint site address first.", true);
      const input = document.getElementById("spmSite");
      if (input) input.focus();
      return;
    }
    try {
      const result = await Backend.call("open_external", site.url);
      if (!result || !result.ok) throw new Error((result && result.error) || "Could not open SharePoint site.");
      this.addRecentSite(site);
      this.setStatus(`Opened ${site.title} in your default browser.`, false, true);
    } catch (e) {
      this.setStatus(String((e && e.message) || e), true);
    }
  },

  async scan(button) {
    const input = document.getElementById("spmSite");
    const site = (input && input.value || "").trim();
    const status = document.getElementById("spmStatus");
    if (!site) {
      this.setStatus("Enter a SharePoint site address.", true);
      if (input) input.focus();
      return;
    }
    const wholeSite = !!(button && button.id === "spmScanWholeSite");
    const scopes = wholeSite ? null : [...this.folderSelected].map(item => ({ list_id: item.list_id, path: item.path }));
    if (!wholeSite && !scopes.length) {
      this.setStatus("Select one or more folders to scan, or choose Scan whole site.", true);
      return;
    }
    const buttons = [document.getElementById("spmConnect"), document.getElementById("spmScanWholeSite"), document.getElementById("spmRescan")].filter(Boolean);
    buttons.forEach(b => { b.disabled = true; });
    const oldLabels = buttons.map(b => b.innerHTML);
    buttons.forEach(b => { b.innerHTML = '<span class="busy-spin"></span> Scanning…'; });
    const scanId = window.crypto && window.crypto.randomUUID
      ? window.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.activeScanId = scanId;
    this.scanStartedAt = Date.now();
    this.scanProgressPercent = 0;
    const progress = document.getElementById("spmScanProgress");
    const cancelButton = document.getElementById("spmCancelScan");
    if (progress) progress.classList.remove("hidden");
    const liveResults = document.getElementById("spmLiveResults");
    const liveRows = document.getElementById("spmLiveRows");
    const liveCount = document.getElementById("spmLiveCount");
    if (liveResults) liveResults.classList.remove("hidden");
    if (liveRows) liveRows.innerHTML = '<div class="empty">Waiting for first SharePoint page…</div>';
    if (liveCount) liveCount.textContent = "Scan not complete";
    if (cancelButton) { cancelButton.disabled = false; cancelButton.textContent = "Cancel scan"; }
    this.updateScanProgress({ phase: "Starting scan", items_scanned: 0 });
    this.setStatus("Scan in progress. You can cancel at any time.");
    try {
      let finished = false;
      const scanPromise = Backend.call("sharepoint_permissions_scan", site, scanId, scopes);
      scanPromise.then(() => { finished = true; }, () => { finished = true; });
      while (!finished) {
        await new Promise(resolve => setTimeout(resolve, 600));
        if (finished) break;
        try {
          const statusResult = await Backend.call("sharepoint_permissions_scan_status", scanId);
          if (statusResult && statusResult.ok && this.activeScanId === scanId) {
            this.updateScanProgress(statusResult.progress || {});
            this.renderLiveScanPreview(statusResult.progress || {});
          }
        } catch (e) {}
      }
      const result = await scanPromise;
      if (result && result.cancelled) {
        this.setStatus(this.data ? "Scan cancelled. Previous results remain available." : "Scan cancelled.", false, false, true);
        return;
      }
      if (!result || !result.ok) throw new Error((result && result.error) || "SharePoint scan failed.");
      this.previousScan = this.recordScan(result);
      this.selectedSharingLinks.clear();
      this.data = result;
      this.selected = result.entries && result.entries.length ? result.entries.reduce((best, entry, index, entries) =>
        best < 0 || this.exceptionRank(entry) < this.exceptionRank(entries[best]) ? index : best, -1) : -1;
      try { localStorage.setItem(this.KEY, result.site_url || site); } catch (e) {}
      this.addRecentSite({ title: result.site_title || result.site_url || site, url: result.site_url || site, logo: "" });
      this.render();
      const count = (result.entries || []).length;
      const denied = Number(result.permission_errors || 0);
      const accessHint = result.can_manage_permissions === false
        ? " This Hub account lacks Manage Permissions on this site; a site admin must grant it."
        : "";
      const scopeLabel = result.scan_scope === "folders" ? ` in ${Number(result.selected_folders || scopes.length).toLocaleString()} selected folder${Number(result.selected_folders || scopes.length) === 1 ? "" : "s"}` : " across the site";
      this.setStatus(`Scanned ${Number(result.items_scanned || 0).toLocaleString()} items${scopeLabel}. Found ${count.toLocaleString()} items with unique permissions.${denied ? ` SharePoint denied permission reads for ${denied.toLocaleString()} securable item${denied === 1 ? "" : "s"}; inspect flagged rows.` : ""}${accessHint}`, false, !denied && !accessHint, !!denied || !!accessHint);
      const fixButton = document.getElementById("spmFixOpen");
      if (fixButton) fixButton.classList.toggle("hidden", !denied);
      if (denied && this.tutorialShownFor !== (result.site_url || site)) {
        this.tutorialShownFor = result.site_url || site;
        this.showFixTutorial(denied, result.can_manage_permissions);
      }
    } catch (e) {
      this.setStatus(String((e && e.message) || e), true);
    } finally {
      this.activeScanId = "";
      if (progress) progress.classList.add("hidden");
      document.getElementById("spmLiveResults")?.classList.add("hidden");
    buttons.forEach((b, i) => { b.disabled = b.id === "spmConnect" && this.folderSelected.size === 0; b.innerHTML = oldLabels[i]; });
    }
  },

  updateScanProgress(progress) {
    const text = document.getElementById("spmProgressText");
    const bar = document.getElementById("spmProgressBar");
    if (!text || !bar) return;
    const items = Number(progress.items_scanned || 0).toLocaleString();
    const libraries = Number(progress.libraries_total || 0);
    const done = Number(progress.libraries_done || 0);
    let percent = 2;
    let detail = `${items} items read`;
    if (progress.phase === "Scanning libraries" && libraries) {
      const currentTotal = Number(progress.current_library_total || 0);
      const currentItems = Number(progress.current_library_items || 0);
      const within = currentTotal ? Math.min(currentItems / currentTotal, 0.99) : 0;
      percent = Math.round(3 + 47 * Math.min((done + within) / libraries, 1));
      const totalLabel = currentTotal ? ` of ~${currentTotal.toLocaleString()} estimated` : "";
      detail = `Library ${Math.min(done + 1, libraries)} of ${libraries}: ${progress.current_library || "Preparing"} · ${Number(progress.current_library_items || 0).toLocaleString()}${totalLabel} · ${items} items read`;
    } else if (progress.phase === "Reading unique permissions") {
      const total = Number(progress.permissions_total || 0);
      const checked = Number(progress.permissions_done || 0);
      percent = total ? Math.round(50 + 25 * checked / total) : 50;
      detail = `Checking permissions ${checked.toLocaleString()} of ${total.toLocaleString()} targets · ${items} items read`;
    } else if (progress.phase === "Expanding SharePoint groups") {
      const total = Number(progress.groups_total || 0);
      const checked = Number(progress.groups_done || 0);
      percent = total ? Math.round(75 + 4 * checked / total) : 75;
      detail = `Resolving SharePoint group members ${checked.toLocaleString()} of ${total.toLocaleString()}`;
    } else if (progress.phase === "Expanding Entra groups") {
      const total = Number(progress.groups_total || 0);
      const checked = Number(progress.groups_done || 0);
      percent = total ? Math.round(79 + 5 * checked / total) : 79;
      detail = `Resolving Entra group members ${checked.toLocaleString()} of ${total.toLocaleString()}`;
    } else if (progress.phase === "Reading share link details") {
      const total = Number(progress.link_details_total || 0);
      const checked = Number(progress.link_details_done || 0);
      percent = total ? Math.round(84 + 15 * checked / total) : 84;
      detail = total
        ? `Reading sharing-link details ${checked.toLocaleString()} of ${total.toLocaleString()} items · ${items} files and folders scanned`
        : `Preparing sharing-link details · ${items} files and folders scanned`;
    } else if (progress.phase === "Finishing report") {
      percent = 99;
      detail = `Preparing report · ${items} items read`;
    } else if (["Connecting to SharePoint", "Opening site", "Checking site access", "Listing document libraries"].includes(progress.phase)) {
      percent = 2;
      detail = "Connecting and preparing site scan";
    } else {
      detail = `${progress.phase || "Starting scan"} · ${items} items read`;
    }
    this.scanProgressPercent = Math.max(Number(this.scanProgressPercent || 0), Math.min(percent, 99));
    const elapsed = Math.max(0, Math.floor((Date.now() - Number(this.scanStartedAt || Date.now())) / 1000));
    const elapsedText = elapsed >= 3600 ? `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m elapsed`
      : elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s elapsed` : `${elapsed}s elapsed`;
    text.textContent = `${detail} · ${elapsedText} · about ${this.scanProgressPercent}%`;
    bar.value = this.scanProgressPercent;
  },

  renderLiveScanPreview(progress) {
    const panel = document.getElementById("spmLiveResults");
    const list = document.getElementById("spmLiveRows");
    const count = document.getElementById("spmLiveCount");
    const notice = document.getElementById("spmLiveNotice");
    const rows = progress.recent_items || [];
    if (!panel || !list) return;
    panel.classList.remove("hidden");
    const scanned = Number(progress.items_scanned || 0);
    if (count) count.textContent = `${scanned.toLocaleString()} scanned so far · ${rows.length.toLocaleString()} recent paths`;
    if (notice) notice.textContent = "Partial paths only. Permission findings are not final until scan completes.";
    list.innerHTML = rows.length ? `<table class="spm-live-table"><thead><tr><th>Recently discovered path</th><th>Library</th><th>Type</th></tr></thead><tbody>${rows.slice(-24).map(row => `<tr><td>${esc(row.display_path || "Unknown path")}</td><td>${esc(row.library || "Library")}</td><td>${esc(row.type || "Item")}</td></tr>`).join("")}</tbody></table>` : '<div class="empty">Waiting for first SharePoint page…</div>';
  },

  async cancelScan() {
    const scanId = this.activeScanId;
    const button = document.getElementById("spmCancelScan");
    if (!scanId || !button || button.disabled) return;
    button.disabled = true;
    button.textContent = "Cancelling…";
    try {
      const result = await Backend.call("sharepoint_permissions_cancel_scan", scanId);
      if (!result || !result.ok) throw new Error((result && result.error) || "Could not cancel scan.");
      this.setStatus("Cancellation requested. Waiting for the current SharePoint request to finish…", false, false, true);
    } catch (e) {
      button.disabled = false;
      button.textContent = "Cancel scan";
      App.toast(String((e && e.message) || e), true);
    }
  },

  setStatus(text, error, success, warning) {
    const el = document.getElementById("spmStatus");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("error", !!error);
    el.classList.toggle("success", !!success);
    el.classList.toggle("warning", !!warning);
  },

  showFixTutorial(denied, canManage) {
    const details = canManage === false
      ? "Hub checked this site and confirmed your signed-in account does not have Manage Permissions there."
      : "Hub can list site contents, but SharePoint refused permission assignment reads. The signed-in account may lack Manage Permissions on this site.";
    document.getElementById("modalRoot").innerHTML = `<div class="overlay"><div class="modal spm-fix-modal" role="dialog" aria-modal="true" aria-labelledby="spmFixTitle">
      <div class="modal-head"><h3 id="spmFixTitle">Fix SharePoint permission access</h3><button onclick="App._closeModal()" aria-label="Close">&times;</button></div>
      <div class="modal-body">
        <p>${esc(details)}${denied ? ` Hub could not read ${Number(denied).toLocaleString()} permission target${Number(denied) === 1 ? "" : "s"}.` : ""}</p>
        <ol>
          <li>Check the signed-in account shown at the bottom of Hub’s sidebar.</li>
          <li>Ask a SharePoint site owner or admin to add that account to the target site’s <b>Owners</b> group with <b>Full Control</b> (includes <b>Manage Permissions</b>). A Site Collection Administrator also has the required access.</li>
          <li>Return here and select <b>Scan site</b>. If SharePoint still denies access, sign out of Hub, sign back in, and scan again.</li>
        </ol>
        <p class="muted">This is separate from app consent. Hub’s AllSites.FullControl consent is already approved. The scan only reads SharePoint data.</p>
      </div>
      <div class="modal-foot"><button class="primary" onclick="App._closeModal()">Got it</button></div>
    </div></div>`;
  },

  filtered() {
    if (!this.data) return [];
    const q = ((document.getElementById("spmSearch") || {}).value || "").trim().toLowerCase();
    const f = (document.getElementById("spmFilter") || {}).value || "all";
    return (this.data.entries || []).map((entry, index) => ({ entry, index })).filter(({ entry }) => {
      if (f === "differs" && !entry.differs) return false;
      if (f === "safe" && !entry.safe_to_reset) return false;
      if (f === "users" && !entry.has_direct_users) return false;
      if (f === "external" && !entry.has_external) return false;
      if (f === "broad" && !(entry.assignments || []).some(a => /everyone|all users|all authenticated users|everyone except external users/i.test(`${a.title || ""} ${a.login || ""}`))) return false;
      if (f === "links" && !entry.has_sharing_links) return false;
      if (f === "errors" && !entry.scan_error) return false;
      if (!q) return true;
      const haystack = [entry.display_path, entry.library, entry.type, entry.parent_display_path,
        ...(entry.assignments || []).flatMap(p => [p.title, p.email, p.login])].join(" ").toLowerCase();
      return haystack.includes(q);
    }).sort((a, b) => this.exceptionRank(a.entry) - this.exceptionRank(b.entry)
      || String(a.entry.library || "").localeCompare(String(b.entry.library || ""), undefined, { sensitivity: "base" })
      || String(a.entry.display_path || "").localeCompare(String(b.entry.display_path || ""), undefined, { sensitivity: "base", numeric: true }));
  },

  exceptionRank(entry) {
    if (entry.scan_error) return 0;
    if (entry.has_external) return 1;
    if (entry.has_sharing_links) return 2;
    if (entry.differs) return 3;
    return 4;
  },

  siteKey(siteUrl = this.data && this.data.site_url) { return String(siteUrl || "").replace(/\/+$/, "").toLowerCase(); },
  encodeArgument(value) { return encodeURIComponent(String(value == null ? "" : value)).replaceAll("'", "%27"); },
  readStore(key, fallback) { try { const value = JSON.parse(localStorage.getItem(key) || "null"); return value == null ? fallback : value; } catch (e) { return fallback; } },
  writeStore(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; } },

  recordScan(scan) {
    const all = this.readStore(this.HISTORY_KEY, {});
    const key = this.siteKey(scan.site_url);
    const previous = Array.isArray(all[key]) ? all[key][0] : null;
    const snapshot = {
      site_url: scan.site_url, site_title: scan.site_title, scanned_at: scan.scanned_at,
      items_scanned: scan.items_scanned, permission_errors: scan.permission_errors,
      permission_targets: scan.permission_targets, permissions_read: scan.permissions_read,
      site_groups_found: scan.site_groups_found, site_groups_expanded: scan.site_groups_expanded,
      site_group_read_errors: scan.site_group_read_errors,
      entra_groups_found: scan.entra_groups_found, entra_groups_expanded: scan.entra_groups_expanded,
      entra_group_read_errors: scan.entra_group_read_errors,
      entries: (scan.entries || []).map(entry => ({
        key: `${entry.type}|${entry.path}`.toLowerCase(), path: entry.path, display_path: entry.display_path,
        library: entry.library, type: entry.type, differs: entry.differs,
        has_external: entry.has_external, has_sharing_links: entry.has_sharing_links,
        scan_error: !!entry.scan_error,
        assignments: (entry.assignments || []).map(a => ({
          id: a.id, title: a.title, login: a.login, email: a.email, kind: a.kind,
          external: !!a.external, sharing_link: !!a.sharing_link, roles: a.roles || [], level: a.level,
        })),
      })),
    };
    this.previousScan = previous;
    all[key] = [snapshot, ...(Array.isArray(all[key]) ? all[key] : [])].slice(0, 4);
    this.writeStore(this.HISTORY_KEY, all);
    return previous;
  },

  auditMetrics() {
    const entries = (this.data && this.data.entries) || [];
    const assignments = [...((this.data && this.data.web_assignments) || []), ...entries.flatMap(e => e.assignments || [])];
    const anyEdit = assignments.some(a => a.sharing_link && /anonymous.*edit/i.test(a.login || ""));
    const anyView = assignments.some(a => a.sharing_link && /anonymous.*view/i.test(a.login || ""));
    const siteExternal = ((this.data && this.data.web_assignments) || []).some(a => a.external);
    const siteLinks = ((this.data && this.data.web_assignments) || []).some(a => a.sharing_link);
    const externalScopes = entries.filter(e => e.has_external).length + Number(siteExternal);
    const linkScopes = entries.filter(e => e.has_sharing_links).length + Number(siteLinks);
    const broadPrincipal = a => /(^|[^a-z])(everyone|all users|all authenticated users|everyone except external users)([^a-z]|$)/i.test(`${a.title || ""} ${a.login || ""}`);
    const broadScopes = entries.filter(e => (e.assignments || []).some(broadPrincipal)).length
      + Number(((this.data && this.data.web_assignments) || []).some(broadPrincipal));
    const directUsers = entries.reduce((sum, e) => sum + (e.assignments || []).filter(a => a.kind === "user").length, 0)
      + ((this.data && this.data.web_assignments) || []).filter(a => a.kind === "user").length;
    const changed = entries.filter(e => e.differs === true).length;
    const score = Math.min(100, (anyEdit ? 30 : 0) + (anyView ? 18 : 0) + Math.min(externalScopes * 6, 24)
      + Math.min(broadScopes * 6, 24) + Math.min(directUsers, 10) + Math.min(changed, 18));
    const targets = Number(this.data && this.data.permission_targets || 0);
    const read = Number(this.data && this.data.permissions_read || Math.max(0, targets - Number(this.data && this.data.permission_errors || 0)));
    const coverage = targets ? Math.round(100 * read / targets) : null;
    const siteGroups = Number(this.data && this.data.site_groups_found || 0);
    const siteGroupsRead = Number(this.data && this.data.site_groups_expanded || 0);
    const siteGroupErrors = Number(this.data && this.data.site_group_read_errors || 0);
    const entraGroups = Number(this.data && this.data.entra_groups_found || 0);
    const entraGroupsRead = Number(this.data && this.data.entra_groups_expanded || 0);
    const entraGroupErrors = Number(this.data && this.data.entra_group_read_errors || Math.max(0, entraGroups - entraGroupsRead));
    return { entries, assignments, anyEdit, anyView, externalScopes, linkScopes, broadScopes, directUsers, changed, score,
      risk: coverage == null ? "Coverage unknown" : coverage < 100 ? "Incomplete scan" : score >= 45 ? "High" : score >= 20 ? "Elevated" : "Lower",
      targets, read, coverage, siteGroups, siteGroupsRead, siteGroupErrors, entraGroups, entraGroupsRead, entraGroupErrors,
      errors: Number(this.data && this.data.permission_errors || 0) };
  },

  showAuditTab(tab) {
    const allowed = ["overview", "people", "content", "changes"];
    if (!allowed.includes(tab)) return;
    for (const name of allowed) {
      document.getElementById(`spmTab-${name}`)?.classList.toggle("hidden", name !== tab);
      const button = document.getElementById(`spmTabButton-${name}`);
      if (button) { button.classList.toggle("on", name === tab); button.setAttribute("aria-selected", name === tab ? "true" : "false"); }
    }
    if (tab === "people") { this.renderPeople(); if (this.peopleMode === "matrix") this.renderMatrix(); }
    if (tab === "changes") this.renderChanges();
  },

  render() {
    if (!this.data) return;
    const results = document.getElementById("spmResults");
    if (results) results.classList.remove("hidden");
    const entries = this.data.entries || [];
    const differs = entries.filter(e => e.differs).length;
    const comparable = entries.filter(e => e.differs !== null).length;
    const links = entries.filter(e => e.has_sharing_links).length;
    const metrics = this.auditMetrics();
    const stats = document.getElementById("spmStats");
    if (stats) {
      const card = (n, label) => `<div class="stat"><div class="n">${Number(n).toLocaleString()}</div><div class="l">${label}</div></div>`;
      stats.innerHTML = card(this.data.items_scanned, "Library items scanned") + card(entries.length, "Unique permission sets") +
        card(differs, `Differ from parent · ${comparable.toLocaleString()} comparable`) + card(links, "Have sharing links");
    }
    const title = document.querySelector("#appview-sharepointperms .pagehead p");
    if (title) title.textContent = `${this.data.site_title || this.data.site_url} · scanned ${new Date(this.data.scanned_at).toLocaleString()}`;
    this.renderOverview(metrics);
    this.renderPeople();
    this.renderChanges();
    this.renderReviewQueue();
    this.renderSavedSearches();
    this.renderRows();
    this.renderDetail();
    this.showAuditTab("overview");
  },

  renderOverview(metrics = this.auditMetrics()) {
    const host = document.getElementById("spmOverview");
    if (!host) return;
    const { entries, risk, score, coverage, read, targets, errors, externalScopes, linkScopes, broadScopes, changed, anyEdit, anyView, siteGroups, siteGroupsRead, siteGroupErrors, entraGroups, entraGroupsRead, entraGroupErrors } = metrics;
    const band = score >= 45 ? "high" : score >= 20 || errors || coverage == null ? "elevated" : "lower";
    const confidence = coverage == null ? "Coverage unknown" : `${coverage}% permission reads completed`;
    const reasons = [];
    if (anyEdit) reasons.push(["Anonymous edit links", "Anyone with these links may edit content.", "links"]);
    else if (anyView) reasons.push(["Anonymous view links", "Anyone with these links may view content.", "links"]);
    if (externalScopes) reasons.push([`${externalScopes.toLocaleString()} scopes include external users`, "Review guest access and business need.", "external"]);
    if (broadScopes) reasons.push([`${broadScopes.toLocaleString()} scopes include broad audiences`, "Review company-wide or everyone access grants.", "broad"]);
    if (linkScopes) reasons.push([`${linkScopes.toLocaleString()} scopes have sharing links`, "Review link type, audience, and expiry.", "links"]);
    if (changed) reasons.push([`${changed.toLocaleString()} scopes differ from parent`, "These are access exceptions to review.", "differs"]);
    if (errors) reasons.push([`${errors.toLocaleString()} permission reads were denied`, "Audit comparison is incomplete for affected scopes.", "errors"]);
    if (siteGroupErrors) reasons.push([`${siteGroupErrors.toLocaleString()} SharePoint groups could not be expanded`, "Some indirect member access remains unknown.", "errors"]);
    if (entraGroupErrors) reasons.push([`${entraGroupErrors.toLocaleString()} Entra groups could not be expanded`, "The current Graph token may lack Directory.Read.All, or membership read was denied.", "errors"]);
    if (!reasons.length) reasons.push(["No high-signal exceptions found", "Scan found no external users, links, or permission differences.", "all"]);
    const priorLabel = this.previousScan ? `Previous scan: ${new Date(this.previousScan.scanned_at).toLocaleString()}` : "First scan on this computer";
    host.innerHTML = `<div class="spm-overview-grid">
      <div class="panel spm-risk-card ${band}"><div class="spm-risk-top"><div><span class="spm-eyebrow">Explainable risk index</span><h3>${risk} <span>${score}/100</span></h3></div><span class="spm-risk-mark">${score >= 45 ? "!" : score >= 20 ? "◐" : "✓"}</span></div><p>Index adds points for anonymous links, external access, direct user grants, and permission differences. It is a triage aid, not a compliance verdict.</p><div class="spm-risk-meter"><i style="width:${score}%"></i></div><small>${esc(confidence)} · ${read.toLocaleString()} of ${targets.toLocaleString()} targets readable</small></div>
      <div class="panel spm-overview-metrics"><div><b>${externalScopes.toLocaleString()}</b><span>Scopes with external access</span></div><div><b>${linkScopes.toLocaleString()}</b><span>Scopes with sharing links</span></div><div><b>${broadScopes.toLocaleString()}</b><span>Scopes with broad audience</span></div><div><b>${changed.toLocaleString()}</b><span>Different from parent</span></div><div><b>${entries.length.toLocaleString()}</b><span>Unique permission scopes</span></div><div><b>${siteGroupsRead.toLocaleString()}/${siteGroups.toLocaleString()}</b><span>SharePoint groups expanded</span></div><div><b>${entraGroupsRead.toLocaleString()}/${entraGroups.toLocaleString()}</b><span>Entra groups expanded</span></div></div>
      </div>
      <div class="panel spm-findings"><div class="spm-section-head"><div><h3>What needs attention</h3><p class="muted">${esc(priorLabel)}. Select a finding to inspect affected content.</p></div><button class="rowbtn" onclick="SharePointPermissions.exportCsv()">Export report</button></div><div class="spm-finding-list">${reasons.map(([title, detail, filter]) => `<button class="spm-finding" onclick="SharePointPermissions.openFinding('${filter}')"><span class="spm-finding-dot ${filter}"></span><span><b>${esc(title)}</b><small>${esc(detail)}</small></span><span>›</span></button>`).join("")}</div></div>`;
  },

  openFinding(filter) {
    this.showAuditTab("content");
    const select = document.getElementById("spmFilter");
    if (select) select.value = filter === "all" ? "all" : filter;
    this.renderRows();
  },

  principals() {
    const map = new Map();
    const add = (principal, scope, viaGroup = "") => {
      const key = String(principal.login || principal.email || `${principal.kind}:${principal.id}:${principal.title}`).toLowerCase();
      if (!map.has(key)) map.set(key, { ...principal, scopes: [], viaGroups: [] });
      const target = map.get(key);
      target.scopes.push(viaGroup ? { ...scope, via_group: viaGroup } : scope);
      if (viaGroup && !target.viaGroups.includes(viaGroup)) target.viaGroups.push(viaGroup);
      target.external = !!(target.external || principal.external);
      target.sharing_link = !!(target.sharing_link || principal.sharing_link);
    };
    const addWithMembers = (principal, scope) => {
      add(principal, scope);
      for (const member of principal.members || []) add({ ...member, level: principal.level }, scope, principal.title || "SharePoint group");
    };
    for (const principal of this.data.web_assignments || []) addWithMembers(principal, { path: "(site)", type: "Site", level: principal.level });
    for (const entry of this.data.entries || []) for (const principal of entry.assignments || []) addWithMembers(principal, { path: entry.display_path, type: entry.type, entry_path: entry.path, level: principal.level });
    return [...map.values()].sort((a, b) => Number(b.external || b.sharing_link) - Number(a.external || a.sharing_link)
      || a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  },

  renderPeople() {
    const host = document.getElementById("spmPeople");
    if (!host || !this.data) return;
    const query = ((document.getElementById("spmPeopleSearch") || {}).value || "").trim().toLowerCase();
    const people = this.principals().filter(p => !query || [p.title, p.login, p.email, p.kind, ...p.viaGroups, ...(p.roles || []).map(r => r.name)].join(" ").toLowerCase().includes(query));
    if (!people.length) { host.innerHTML = '<div class="empty">No matching principals in readable assignments.</div>'; return; }
    host.innerHTML = `<div class="spm-people-head"><span>Person or group</span><span>Access paths</span><span>Role</span></div>${people.map((p, index) => {
      const uniqueScopes = [...new Map(p.scopes.map(scope => [`${scope.path.toLowerCase()}|${String(scope.via_group || "").toLowerCase()}`, scope])).values()];
      const roleSummary = [...new Set(uniqueScopes.map(scope => scope.level).filter(Boolean))].join(", ") || "Assigned";
      const flags = [p.external ? '<span class="spm-flag warn">External</span>' : "", p.sharing_link ? '<span class="spm-flag warn">Link</span>' : "", p.member_read_error ? '<span class="spm-flag warn">Membership unreadable</span>' : ""].join("");
      return `<details class="spm-person"><summary><span><b>${esc(p.title || p.login || "Unknown principal")}</b><small>${esc((p.kind || "other").replaceAll("_", " "))}${p.email ? ` · ${esc(p.email)}` : p.login ? ` · ${esc(p.login)}` : ""}${p.viaGroups.length ? ` · via ${esc(p.viaGroups.join(", "))}` : ""} ${flags}</small></span><b>${uniqueScopes.length.toLocaleString()}</b><span>${esc(roleSummary)}</span></summary><div class="spm-person-scopes"><b>Access map</b>${uniqueScopes.slice(0, 80).map(scope => `<button onclick="SharePointPermissions.openScope('${this.encodeArgument(scope.entry_path || "")}')"><span>${esc(scope.path)}</span><small>${esc(scope.type)}${scope.level ? ` · ${esc(scope.level)}` : ""}${scope.via_group ? ` · via ${esc(scope.via_group)}` : ""}</small></button>`).join("")}${uniqueScopes.length > 80 ? `<small class="muted">Showing first 80 of ${uniqueScopes.length} paths.</small>` : ""}</div></details>`;
    }).join("")}`;
  },

  setPeopleMode(mode) {
    this.peopleMode = mode === "matrix" ? "matrix" : "people";
    const people = document.getElementById("spmPeople");
    const matrix = document.getElementById("spmMatrixPanel");
    const peopleButton = document.getElementById("spmPeopleViewButton");
    const matrixButton = document.getElementById("spmMatrixViewButton");
    const peopleSearch = document.getElementById("spmPeopleSearch");
    people?.classList.toggle("hidden", this.peopleMode !== "people");
    matrix?.classList.toggle("hidden", this.peopleMode !== "matrix");
    peopleSearch?.classList.toggle("hidden", this.peopleMode !== "people");
    if (peopleButton) { peopleButton.classList.toggle("on", this.peopleMode === "people"); peopleButton.setAttribute("aria-pressed", String(this.peopleMode === "people")); }
    if (matrixButton) { matrixButton.classList.toggle("on", this.peopleMode === "matrix"); matrixButton.setAttribute("aria-pressed", String(this.peopleMode === "matrix")); }
    if (this.peopleMode === "matrix") { this.matrixPage = 0; this.renderMatrix(); }
  },

  pageMatrix(delta) {
    this.matrixPage = Math.max(0, this.matrixPage + Number(delta || 0));
    this.renderMatrix();
  },

  pageMatrixRows(delta) {
    this.matrixRowPage = Math.max(0, this.matrixRowPage + Number(delta || 0));
    this.renderMatrix();
  },

  matrixPrincipals() {
    const map = new Map();
    const keyFor = p => String(p.login || p.email || `${p.kind}:${p.id}:${p.title}`).toLowerCase();
    const add = (principal, viaGroup = "") => {
      const key = keyFor(principal);
      if (!map.has(key)) map.set(key, { key, title: principal.title || principal.login || "Unknown principal", login: principal.login || "", email: principal.email || "", kind: principal.kind || "other" });
      return map.get(key);
    };
    const cells = new Map();
    for (const [grantKey, assignments] of Object.entries(this.data?.matrix_grants || {})) {
      const access = new Map();
      for (const principal of assignments || []) {
        const group = add(principal);
        access.set(group.key, [{ level: principal.level || "Assigned", via: "" }]);
        for (const member of principal.members || []) {
          const person = add(member, principal.title || "Group");
          const grants = access.get(person.key) || [];
          const via = member.via_group || principal.title || "Group";
          if (!grants.some(g => g.via === via && g.level === (member.level || principal.level || "Assigned")))
            grants.push({ level: member.level || principal.level || "Assigned", via });
          access.set(person.key, grants);
        }
      }
      cells.set(grantKey, access);
    }
    return { principals: [...map.values()].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" })), cells };
  },

  renderMatrix(resetPage = false) {
    const host = document.getElementById("spmMatrix");
    if (!host || !this.data) return;
    if (resetPage) { this.matrixPage = 0; this.matrixRowPage = 0; }
    const principalQuery = (document.getElementById("spmMatrixPrincipalSearch")?.value || "").trim().toLowerCase();
    const pathQuery = (document.getElementById("spmMatrixPathSearch")?.value || "").trim().toLowerCase();
    const { principals, cells } = this.matrixPrincipals();
    const matches = principals.filter(p => !principalQuery || [p.title, p.login, p.email, p.kind].join(" ").toLowerCase().includes(principalQuery));
    const columnsPageCount = Math.max(1, Math.ceil(matches.length / this.matrixPageSize));
    this.matrixPage = Math.min(this.matrixPage, columnsPageCount - 1);
    const columnStart = this.matrixPage * this.matrixPageSize;
    const columns = matches.slice(columnStart, columnStart + this.matrixPageSize);
    const libraryFilter = document.getElementById("spmMatrixLibrary")?.value || "";
    const allRows = (this.data.matrix_scopes || []).filter(row =>
      (!libraryFilter || row.library === libraryFilter) &&
      (!pathQuery || [row.display_path, row.library, row.type].join(" ").toLowerCase().includes(pathQuery)));
    const rowPageCount = Math.max(1, Math.ceil(allRows.length / this.matrixRowPageSize));
    this.matrixRowPage = Math.min(this.matrixRowPage, rowPageCount - 1);
    const rowStart = this.matrixRowPage * this.matrixRowPageSize;
    const rows = allRows.slice(rowStart, rowStart + this.matrixRowPageSize);
    const librarySelect = document.getElementById("spmMatrixLibrary");
    if (librarySelect && librarySelect.dataset.scanAt !== String(this.data.scanned_at || "")) {
      const options = [...new Set((this.data.matrix_scopes || []).map(row => row.library).filter(name => name && name !== "(site)"))].sort((a, b) => a.localeCompare(b));
      const selected = libraryFilter;
      librarySelect.innerHTML = '<option value="">All libraries</option>' + options.map(name => `<option value="${attr(name)}">${esc(name)}</option>`).join("");
      librarySelect.dataset.scanAt = String(this.data.scanned_at || "");
      if (options.includes(selected)) librarySelect.value = selected;
    }
    const count = document.getElementById("spmMatrixCount");
    if (count) count.textContent = `${allRows.length.toLocaleString()} scopes · ${matches.length.toLocaleString()} people/groups`;
    const prev = document.getElementById("spmMatrixPrev"), next = document.getElementById("spmMatrixNext");
    if (prev) prev.disabled = this.matrixPage <= 0;
    if (next) next.disabled = this.matrixPage >= columnsPageCount - 1;
    const rowPrev = document.getElementById("spmMatrixRowsPrev"), rowNext = document.getElementById("spmMatrixRowsNext");
    if (rowPrev) rowPrev.disabled = this.matrixRowPage <= 0;
    if (rowNext) rowNext.disabled = this.matrixRowPage >= rowPageCount - 1;
    const rowPage = document.getElementById("spmMatrixRowsPage");
    if (rowPage) rowPage.textContent = allRows.length ? `Rows ${rowStart + 1}–${Math.min(rowStart + rows.length, allRows.length)} of ${allRows.length.toLocaleString()}` : "No rows";
    if (!columns.length) { host.innerHTML = '<div class="empty">No matching people or groups in readable assignments.</div>'; return; }
    const header = `<thead><tr><th>Folder or file</th>${columns.map(p => `<th title="${attr(p.email || p.login)}">${esc(p.title)}<small>${esc(p.kind.replaceAll("_", " "))}${p.email || p.login ? ` · ${esc(p.email || p.login)}` : ""}</small></th>`).join("")}</tr></thead>`;
    const body = rows.map(row => `<tr class="${row.is_unique ? "is-unique" : "is-inherited"}"><td><b>${esc(row.display_path)}</b><small>${esc(row.library)} · ${esc(row.type)} · ${row.is_unique ? "Unique" : "Inherits"}${row.scan_error ? " · Access read unavailable" : ""}</small></td>${columns.map(p => {
      if (row.scan_error) return '<td title="Access read unavailable">Unknown</td>';
      const grants = cells.get(row.grant_key)?.get(p.key) || [];
      if (!grants.length) return "<td></td>";
      return `<td class="${row.is_unique ? "spm-direct" : "spm-inherited"}" title="${attr(grants.map(g => `${g.level}${g.via ? ` via ${g.via}` : ""}`).join("; "))}">${grants.map(g => `${esc(g.level)}${g.via ? `<small>via ${esc(g.via)}</small>` : ""}`).join("")}</td>`;
    }).join("")}</tr>`).join("");
    host.innerHTML = `<table class="spm-matrix">${header}<tbody>${body || `<tr><td class="spm-matrix-empty" colspan="${columns.length + 1}">No paths match this filter.</td></tr>`}</tbody></table>`;
  },

  openScope(encodedPath) {
    let path = ""; try { path = decodeURIComponent(encodedPath); } catch (e) {}
    const index = (this.data.entries || []).findIndex(entry => entry.path === path);
    if (index >= 0) { this.showAuditTab("content"); this.select(index); }
  },

  compareScans() {
    const previous = this.previousScan;
    if (!previous) return null;
    const oldEntries = new Map((previous.entries || []).map(e => [e.key, e]));
    const nowEntries = new Map((this.data.entries || []).map(e => [`${e.type}|${e.path}`.toLowerCase(), e]));
    const added = [], removed = [], changed = [], unreadable = [];
    for (const [key, entry] of nowEntries) {
      const old = oldEntries.get(key);
      if (!old) { added.push({ path: entry.display_path, entry }); continue; }
      if (entry.scan_error || old.scan_error) { unreadable.push({ path: entry.display_path, entry, old }); continue; }
      const signature = rows => (rows || []).map(a => `${String(a.login || a.email || a.title).toLowerCase()}=${(a.roles || []).map(r => r.name).sort().join("+")}`).sort().join("|");
      const before = signature(old.assignments), after = signature(entry.assignments);
      if (before !== after) changed.push({ path: entry.display_path, entry, old, before, after });
    }
    for (const [key, entry] of oldEntries) if (!nowEntries.has(key)) removed.push({ path: entry.display_path, old: entry });
    return { previous, added, removed, changed, unreadable };
  },

  renderChanges() {
    const host = document.getElementById("spmChanges");
    if (!host || !this.data) return;
    const diff = this.compareScans();
    if (!diff) { host.innerHTML = '<div class="spm-empty-state"><h3>Build your baseline</h3><p>Run another scan of this site to compare new grants, removed scopes, and changed assignments.</p></div>'; return; }
    const cards = `<div class="spm-change-stats"><div><b>${diff.added.length}</b><span>New secured scopes</span></div><div><b>${diff.removed.length}</b><span>Scopes removed</span></div><div><b>${diff.changed.length}</b><span>Assignment changes</span></div><div><b>${diff.unreadable.length}</b><span>Incomparable scopes</span></div></div>`;
    const section = (title, list, kind) => `<section class="spm-change-section"><h4>${title} <small>${list.length}</small></h4>${list.length ? list.slice(0, 100).map(change => `<button class="spm-change-row" ${change.entry ? `onclick="SharePointPermissions.openScope('${this.encodeArgument(change.entry.path)}')"` : ""}><span><b>${esc(change.path)}</b><small>${change.entry ? esc(change.entry.library) : esc(change.old.library)}</small></span><span class="spm-state ${kind}">${kind === "added" ? "New" : kind === "removed" ? "Removed" : "Changed"}</span></button>`).join("") : '<p class="muted">None found.</p>'}</section>`;
    host.innerHTML = `<p class="muted">Compared with ${esc(new Date(diff.previous.scanned_at).toLocaleString())}. Scan coverage: current ${Number(this.data.permissions_read || 0).toLocaleString()} of ${Number(this.data.permission_targets || 0).toLocaleString()} reads; previous ${Number(diff.previous.permissions_read || 0).toLocaleString()} of ${Number(diff.previous.permission_targets || 0).toLocaleString()}. Scopes with denied reads are excluded from assignment-change claims.</p>${cards}${section("New scopes", diff.added, "added")}${section("Removed scopes", diff.removed, "removed")}${section("Changed assignments", diff.changed, "changed")}${section("Incomparable scopes", diff.unreadable, "changed")}`;
  },

  askPreset(kind) {
    const input = document.getElementById("spmAskInput");
    if (input) input.value = kind === "external" ? "Who outside Nucor has access?" : kind === "broad" ? "Show broad audiences" : kind === "links" ? "Show sharing links" : "What changed since last scan?";
    this.askScan();
  },

  askScan() {
    const input = document.getElementById("spmAskInput");
    const host = document.getElementById("spmAskAnswer");
    if (!host || !this.data) return;
    const question = (input && input.value || "").trim();
    if (!question) { host.innerHTML = '<p>Try “external access”, “sharing links”, “what changed”, or a person, group, or content name.</p>'; return; }
    const q = question.toLowerCase();
    const external = /external|outside|guest|vendor/.test(q);
    const broad = /everyone|all users|company-wide|broad audience/.test(q);
    const links = /link|anonymous|anyone|share/.test(q);
    const changes = /change|new|removed|since|previous/.test(q);
    let matches = this.data.entries.map((entry, index) => ({ entry, index }));
    let explanation = "";
    if (changes) {
      const diff = this.compareScans();
      explanation = diff ? `Since previous scan: ${diff.added.length} new secured scopes, ${diff.removed.length} removed scopes, and ${diff.changed.length} changed assignments.` : "No previous scan is saved on this computer yet.";
      matches = diff ? [...diff.added, ...diff.changed].map(change => ({ entry: change.entry, index: this.data.entries.indexOf(change.entry) })) : [];
    } else if (broad) {
      matches = matches.filter(({ entry }) => (entry.assignments || []).some(a => /everyone|all users|all authenticated users|everyone except external users/i.test(`${a.title || ""} ${a.login || ""}`)));
      explanation = `${matches.length} secured scope${matches.length === 1 ? "" : "s"} include a broad audience grant.`;
    } else if (external) {
      matches = matches.filter(({ entry }) => entry.has_external);
      if (/edit|modify|contribute|full control/.test(q)) matches = matches.filter(({ entry }) => (entry.assignments || []).some(a => (a.external || (a.members || []).some(m => m.external)) && /edit|modify|contribute|full control/i.test(a.level || "")));
      explanation = `${matches.length} secured scope${matches.length === 1 ? "" : "s"} include external principals${/edit|modify|contribute|full control/.test(q) ? " with edit-like roles" : ""}. This includes explicit external user grants; nested group membership is not expanded.`;
    } else if (links) {
      matches = matches.filter(({ entry }) => entry.has_sharing_links);
      if (/edit|modify/.test(q)) matches = matches.filter(({ entry }) => (entry.assignments || []).some(a => a.sharing_link && /edit|modify/i.test(a.level || "")));
      const anyone = matches.filter(({ entry }) => (entry.assignments || []).some(a => a.sharing_link && /anonymous/i.test(a.login || ""))).length;
      explanation = `${matches.length} secured scope${matches.length === 1 ? "" : "s"} have sharing links; ${anyone} include anonymous links.`;
    } else {
      const words = q.replace(/[^a-z0-9@._/-]+/g, " ").split(/\s+/).filter(word => word.length > 2 && !["who", "what", "show", "find", "can", "has", "have", "access", "with", "from", "this", "that", "the", "for", "and", "does", "edit", "files"].includes(word));
      if (words.length) matches = matches.filter(({ entry }) => words.some(word => [entry.display_path, entry.library, ...(entry.assignments || []).flatMap(a => [a.title, a.login, a.email])].join(" ").toLowerCase().includes(word)));
      explanation = words.length ? `${matches.length} matching secured scope${matches.length === 1 ? "" : "s"} from this scan.` : `${this.data.entries.length.toLocaleString()} unique permission scopes scanned. ${Number(this.data.permission_errors || 0).toLocaleString()} permission reads were denied.`;
    }
    host.innerHTML = `<p><b>${esc(explanation)}</b></p>${matches.length ? `<div class="spm-answer-results">${matches.slice(0, 12).map(({ entry, index }) => `<button onclick="SharePointPermissions.showAuditTab('content');SharePointPermissions.select(${index})"><b>${esc(entry.display_path)}</b><small>${esc(entry.library)} · ${esc(entry.diff_summary)}</small></button>`).join("")}${matches.length > 12 ? `<small class="muted">Showing 12 of ${matches.length} matches.</small>` : ""}</div>` : '<p class="muted">No matching secured scope in this scan.</p>'}`;
  },

  savedSearches() {
    const all = this.readStore(this.SEARCH_KEY, {});
    const searches = all[this.siteKey()] || [];
    return Array.isArray(searches) ? searches : [];
  },

  renderSavedSearches() {
    const select = document.getElementById("spmSavedSearches");
    if (!select) return;
    const selected = select.value;
    select.innerHTML = '<option value="">Saved searches</option>' + this.savedSearches().map((search, index) => `<option value="${index}">${esc(search.name)}</option>`).join("");
    if (selected && Number(selected) < this.savedSearches().length) select.value = selected;
  },

  saveSearch() {
    const query = (document.getElementById("spmSearch") || {}).value || "";
    const filter = (document.getElementById("spmFilter") || {}).value || "all";
    const name = window.prompt("Name this saved search:", query || filter.replaceAll("-", " "));
    if (!name || !name.trim()) return;
    const all = this.readStore(this.SEARCH_KEY, {});
    const key = this.siteKey();
    const searches = Array.isArray(all[key]) ? all[key] : [];
    searches.unshift({ name: name.trim().slice(0, 60), query, filter });
    all[key] = searches.slice(0, 20);
    this.writeStore(this.SEARCH_KEY, all);
    this.renderSavedSearches();
  },

  applySavedSearch(index) {
    if (index === "") return;
    const saved = this.savedSearches()[Number(index)];
    if (!saved) return;
    const query = document.getElementById("spmSearch"), filter = document.getElementById("spmFilter");
    if (query) query.value = saved.query || "";
    if (filter) filter.value = saved.filter || "all";
    this.renderRows();
  },

  reviewPlans() {
    const all = this.readStore(this.REVIEW_KEY, {});
    const plans = all[this.siteKey()] || [];
    return Array.isArray(plans) ? plans : [];
  },

  async refreshReviewPlans() {
    const site = this.data && this.data.site_url; if (!site) return;
    const key = this.siteKey();
    const r = await Backend.call("sharepoint_review_get", site);
    if (!r || !r.ok) return App.toast((r && r.error) || "Could not load shared access reviews.", true);
    const all = this.readStore(this.REVIEW_KEY, {}); all[key] = r.items || []; this.writeStore(this.REVIEW_KEY, all);
    this._reviewLoadedKey = key; this.renderReviewQueue();
  },

  stageReview(index) {
    const entry = (this.data && this.data.entries || [])[Number(index)];
    if (!entry) return;
    const recommendation = entry.scan_error ? "Ask site owner to restore permission-read access and rescan."
      : entry.has_sharing_links ? "Review link audience and expiry; remove links that are no longer needed."
      : entry.has_external ? "Confirm external user access remains required; remove grants that do not."
      : entry.differs ? "Confirm each added or changed grant with the content owner."
      : "Review whether this scope should inherit permissions from its parent.";
    const exact = entry.safe_to_reset
      ? "Access impact: scanner found same assignments as parent. Restoring inheritance should preserve current effective access at scan time."
      : entry.scan_error ? "Access impact: unknown because SharePoint denied this permission read. Do not apply changes from this finding yet."
      : entry.has_sharing_links ? "Access impact: removing links can revoke access for link holders. Link recipients may not be fully enumerable."
      : entry.has_external ? "Access impact: removing external grants will revoke those principals’ access to this scope."
      : "Access impact: compare listed grants with parent before approving a change.";
    const principals = (entry.assignments || []).map(a => a.title || a.login).filter(Boolean).slice(0, 12).join(", ") || "No assignment details available";
    document.getElementById("modalRoot").innerHTML = `<div class="overlay"><div class="modal spm-fix-modal" role="dialog" aria-modal="true" aria-labelledby="spmPlanTitle"><div class="modal-head"><h3 id="spmPlanTitle">Review recommendation</h3><button onclick="App._closeModal()" aria-label="Close">&times;</button></div><div class="modal-body"><p><b>${esc(entry.display_path)}</b></p><p>${esc(recommendation)}</p><div class="spm-impact-preview">${esc(exact)}<br><br><b>Current principals:</b> ${esc(principals)}</div><div class="field"><label>Owner or reviewer</label><input id="spmPlanOwner" placeholder="Name or email" autocomplete="off"></div><div class="field"><label>Review due date</label><input id="spmPlanDue" type="date"></div><div class="field"><label>Review note</label><textarea id="spmPlanNote" rows="3" placeholder="Reason, decision, or follow-up"></textarea></div><p class="muted">Shared with this division. Hub will not change SharePoint permissions.</p></div><div class="modal-foot"><button class="ghost" onclick="App._closeModal()">Cancel</button><button class="primary" onclick="SharePointPermissions.saveReview(${Number(index)})">Add to review plan</button></div></div></div>`;
  },

  async saveReview(index) {
    const entry = (this.data && this.data.entries || [])[Number(index)];
    if (!entry) return;
    const owner = (document.getElementById("spmPlanOwner") || {}).value || "";
    const note = (document.getElementById("spmPlanNote") || {}).value || "";
    const record = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, site_url: this.data.site_url,
      site_title: this.data.site_title, path: entry.path, display_path: entry.display_path, library: entry.library,
      type: entry.type, diff_summary: entry.diff_summary, has_external: !!entry.has_external,
      has_sharing_links: !!entry.has_sharing_links, scan_error: !!entry.scan_error,
      principals: (entry.assignments || []).map(a => ({ title: a.title, login: a.login, email: a.email, level: a.level })),
      recommendation: entry.scan_error ? "Ask site owner to restore permission-read access and rescan."
        : entry.has_sharing_links ? "Review link audience and expiry; remove links that are no longer needed."
        : entry.has_external ? "Confirm external user access remains required; remove grants that do not."
        : entry.differs ? "Confirm each added or changed grant with the content owner."
        : "Review whether this scope should inherit permissions from its parent.",
      reviewer: owner.trim(), due_date: (document.getElementById("spmPlanDue") || {}).value || "", note: note.trim(), status: "Proposed", created_at: new Date().toISOString(), decisions: [] };
    const all = this.readStore(this.REVIEW_KEY, {}), key = this.siteKey();
    const plan = Array.isArray(all[key]) ? all[key] : [];
    plan.unshift(record); all[key] = plan.slice(0, 250);
    this.writeStore(this.REVIEW_KEY, all);
    const saved = await Backend.call("sharepoint_review_save", this.data.site_url, all[key]);
    if (!saved || !saved.ok) return App.toast((saved && saved.error) || "Could not save shared review plan.", true);
    this._reviewLoadedKey = key;
    App._closeModal(); this.renderReviewQueue();
    App.toast("Added recommendation to shared division review plan.");
  },

  async decideReview(id, status) {
    const all = this.readStore(this.REVIEW_KEY, {}), key = this.siteKey(), plan = Array.isArray(all[key]) ? all[key] : [];
    const item = plan.find(row => row.id === id);
    if (!item) return;
    const account = (document.getElementById("acct") || {}).textContent || "Hub user";
    if (!["Proposed", "Approved", "Rejected", "Reviewed"].includes(status)) return;
    item.status = status;
    item.decisions = [...(item.decisions || []), { status, by: account, at: new Date().toISOString() }].slice(-20);
    all[key] = plan; this.writeStore(this.REVIEW_KEY, all);
    const saved = await Backend.call("sharepoint_review_save", this.data.site_url, plan);
    if (!saved || !saved.ok) return App.toast((saved && saved.error) || "Could not save review decision.", true);
    this.renderReviewQueue();
  },

  renderReviewQueue() {
    const host = document.getElementById("spmReviewQueue");
    if (!host || !this.data) return;
    if (this._reviewLoadedKey !== this.siteKey()) { host.innerHTML = '<div class="spm-empty-state compact">Loading shared review plan…</div>'; this.refreshReviewPlans(); return; }
    const plan = this.reviewPlans();
    if (!plan.length) { host.innerHTML = '<div class="spm-empty-state compact">No staged recommendations. Select “Add to review plan” on a finding to start.</div>'; return; }
    host.innerHTML = plan.map(item => {
      const state = ["Proposed", "Approved", "Rejected", "Reviewed"].includes(item.status) ? item.status : "Proposed";
      return `<article class="spm-review-row"><div><span class="spm-review-status ${state.toLowerCase()}">${esc(state)}</span><b>${esc(item.display_path)}</b><small>${esc(item.recommendation)}</small><small>${item.reviewer ? `Reviewer: ${esc(item.reviewer)} · ` : ""}${item.due_date ? `Due: ${esc(item.due_date)} · ` : ""}${new Date(item.created_at).toLocaleString()}${item.note ? ` · ${esc(item.note)}` : ""}</small>${item.decisions && item.decisions.length ? `<small>Last decision: ${esc(item.decisions[item.decisions.length - 1].status)} by ${esc(item.decisions[item.decisions.length - 1].by)} · ${new Date(item.decisions[item.decisions.length - 1].at).toLocaleString()}</small>` : ""}</div><div class="spm-review-actions">${state === "Proposed" ? `<button class="rowbtn" onclick="SharePointPermissions.decideReview('${item.id}','Approved')">Approve</button><button class="rowbtn" onclick="SharePointPermissions.decideReview('${item.id}','Rejected')">Decline</button>` : state === "Approved" ? `<button class="rowbtn" onclick="SharePointPermissions.decideReview('${item.id}','Reviewed')">Mark review complete</button><button class="rowbtn" onclick="SharePointPermissions.decideReview('${item.id}','Proposed')">Reopen</button>` : `<button class="rowbtn" onclick="SharePointPermissions.decideReview('${item.id}','Proposed')">Reopen</button>`}</div></article>`;
    }).join("");
  },

  exportReviewPlan() {
    const plan = { version: 1, exported_at: new Date().toISOString(), site_url: this.data && this.data.site_url,
      site_title: this.data && this.data.site_title, items: this.reviewPlans() };
    const blob = new Blob([JSON.stringify(plan, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob), anchor = document.createElement("a");
    anchor.href = href; anchor.download = `sharepoint-review-plan-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click(); setTimeout(() => URL.revokeObjectURL(href), 1000);
  },

  importReviewPlan() {
    let input = document.getElementById("spmReviewImportFile");
    if (!input) { input = document.createElement("input"); input.id = "spmReviewImportFile"; input.type = "file"; input.accept = ".json,application/json"; input.className = "hidden"; document.body.appendChild(input); }
    input.onchange = async () => {
      const file = input.files && input.files[0]; if (!file) return;
      try {
        if (file.size > 2_000_000) throw new Error("Review plan file exceeds 2 MB.");
        const parsed = JSON.parse(await file.text());
        if (parsed.version !== 1 || !Array.isArray(parsed.items)) throw new Error("Unsupported review plan file.");
        const all = this.readStore(this.REVIEW_KEY, {}), key = this.siteKey(parsed.site_url || this.data.site_url);
        const existing = Array.isArray(all[key]) ? all[key] : [];
        const known = new Set(existing.map(item => item.id));
        const incoming = parsed.items.filter(item => item && typeof item.id === "string" && /^[\w-]{1,100}$/.test(item.id)
          && typeof item.path === "string" && item.path && !known.has(item.id))
          .map(item => ({ ...item, status: ["Proposed", "Approved", "Rejected", "Reviewed"].includes(item.status) ? item.status : "Proposed" }));
        all[key] = [...incoming, ...existing].slice(0, 250);
        this.writeStore(this.REVIEW_KEY, all);
        const saved = await Backend.call("sharepoint_review_save", parsed.site_url || this.data.site_url, all[key]);
        if (!saved || !saved.ok) throw new Error((saved && saved.error) || "Could not save shared review plan.");
        this._reviewLoadedKey = key; this.renderReviewQueue(); App.toast("Review plan imported and shared with this division.");
      } catch (e) { App.toast(String(e.message || e), true); }
      input.value = "";
    };
    input.click();
  },

  shareFinding() {
    const entry = (this.data && this.data.entries || [])[this.selected];
    if (!entry) return;
    const access = (entry.assignments || []).map(a => `${a.title || a.login}: ${a.level}`).join("; ") || "No direct assignments read";
    const modified = entry.modified ? `\nLast modified: ${new Date(entry.modified).toLocaleString()}${entry.modified_by ? ` by ${entry.modified_by}` : ""}` : "";
    const text = `${this.data.site_title} — ${entry.display_path}\n${entry.diff_summary}${modified}\nParent: ${entry.parent_display_path}\nAccess: ${access}\nSite: ${this.data.site_url}`;
    const done = () => App.toast("Finding copied. Paste into email or Teams.");
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => App.toast("Could not copy finding.", true));
    else App.toast(text);
  },

  renderRows() {
    const host = document.getElementById("spmRows");
    const count = document.getElementById("spmCount");
    if (!host || !this.data) return;
    const rows = this.filtered();
    if (count) count.textContent = `${rows.length.toLocaleString()} shown · exceptions first`;
    if (!rows.length) {
      host.innerHTML = '<div class="empty">No permission entries match this filter.</div>';
      return;
    }
    host.innerHTML = rows.map(({ entry, index }) => {
      const flags = [entry.has_sharing_links ? '<span class="spm-flag warn">Sharing link</span>' : "",
        entry.has_external ? '<span class="spm-flag warn">External user</span>' : "",
        entry.safe_to_reset ? '<span class="spm-flag safe">Safe to reset</span>' : ""].join("");
      return `<button class="spm-row${index === this.selected ? " selected" : ""}" onclick="SharePointPermissions.select(${index})">
        <span class="spm-row-main"><b>${esc(entry.display_path)}</b><small>${esc(entry.library)} · ${esc(entry.type)} · parent: ${esc(entry.parent_display_path)}</small></span>
        <span class="spm-row-side"><span class="spm-diff ${entry.scan_error ? "denied" : entry.differs ? "changed" : "same"}">${esc(entry.diff_summary)}</span>${flags}</span>
      </button>`;
    }).join("");
  },

  select(index) {
    this.selected = Number(index);
    this.renderRows();
    this.renderDetail();
  },

  renderSharingLinks(entry, entryIndex) {
    const links = entry.sharing_link_details || [];
    if (links.length) {
      const audience = { anonymous: "Anyone with the link", organization: "People in organization", users: "Specific people" };
      const access = { view: "View", edit: "Edit", embed: "Embed" };
      return `<section class="spm-link-details"><div><h4>Sharing links <small>${links.length}</small></h4><p>Links can grant file access. URLs stay hidden until you reveal or copy them.</p></div>${links.map((link, index) => {
        const key = this.sharingLinkKey(entry, link);
        const expiry = link.expiration ? `Expires ${new Date(link.expiration).toLocaleString()}` : "No expiry reported";
        const urlActions = link.web_url
          ? `<div class="spm-link-actions"><button class="rowbtn" onclick="SharePointPermissions.revealSharingLink(${entryIndex},${index},this)">Reveal URL</button><button class="rowbtn" onclick="SharePointPermissions.copySharingLink(${entryIndex},${index})">Copy URL</button><button class="rowbtn danger" onclick="SharePointPermissions.removeSharingLink(${entryIndex},${index})">Remove</button><code class="spm-link-url" hidden></code></div>`
          : `<div class="spm-link-actions"><small class="muted">Graph did not return the URL.</small><button class="rowbtn danger" onclick="SharePointPermissions.removeSharingLink(${entryIndex},${index})">Remove</button></div>`;
        return `<article class="spm-link-card"><label class="spm-link-select"><input type="checkbox" ${this.selectedSharingLinks.has(key) ? "checked" : ""} onchange="SharePointPermissions.toggleSharingLink(${entryIndex},${index},this.checked)"><span><b>${esc(audience[link.scope] || "Sharing link")}</b><small>${esc(access[link.type] || link.roles?.join(", ") || "Access unknown")} · ${esc(expiry)}</small></span></label>${urlActions}</article>`;
      }).join("")}<div class="spm-link-bulk"><button class="rowbtn" onclick="SharePointPermissions.removeSelectedSharingLinks()" ${this.selectedSharingLinks.size ? "" : "disabled"}>Remove selected (${this.selectedSharingLinks.size})</button><button class="rowbtn" onclick="SharePointPermissions.removeSharingLinksForItem(${entryIndex})">Remove all on this item</button><button class="rowbtn" onclick="SharePointPermissions.removeSharingLinksForLibrary(${entryIndex})" ${this.scanCoversLibrary(entry.library) ? "" : "disabled"} title="Requires a full site scan or scan starting at this library">Remove all in library</button><button class="rowbtn" onclick="SharePointPermissions.removeSharingLinksForSite()" ${this.data.scan_scope === "site" ? "" : "disabled"} title="Requires a full site scan">Remove all in site</button></div></section>`;
    }
    if (entry.sharing_link_details_error) {
      return `<div class="spm-warning">${esc(entry.sharing_link_details_error)}</div>`;
    }
    return "";
  },

  sharingLinkKey(entry, link) { return `${entry.list_id}|${entry.item_id}|${link.permission_id || ""}`; },

  toggleSharingLink(entryIndex, linkIndex, checked) {
    const entry = this.data?.entries?.[Number(entryIndex)];
    const link = entry?.sharing_link_details?.[Number(linkIndex)];
    if (!entry || !link?.permission_id) return App.toast("This link cannot be selected. Rescan the site.", true);
    const key = this.sharingLinkKey(entry, link);
    if (checked) this.selectedSharingLinks.add(key); else this.selectedSharingLinks.delete(key);
    this.renderDetail();
  },

  scanCoversLibrary(library) {
    if (this.data?.scan_scope === "site") return true;
    const lib = (this.data?.libraries || []).find(row => row.title === library);
    const root = String(lib?.root_url || "").replace(/\/$/, "").toLocaleLowerCase();
    return !!root && (this.data?.scan_scopes || []).some(scope => String(scope.list_id).toLocaleLowerCase() === String(lib.id).toLocaleLowerCase()
      && String(scope.path || "").replace(/\/$/, "").toLocaleLowerCase() === root);
  },

  sharingLinkTargets(entries) {
    const targets = new Map();
    for (const entry of entries || []) for (const link of entry.sharing_link_details || []) {
      if (!link.permission_id) continue;
      const key = `${entry.list_id}|${entry.item_id}`;
      if (!targets.has(key)) targets.set(key, { list_id: entry.list_id, item_id: entry.item_id,
        library: entry.library, path: entry.display_path, permission_ids: [] });
      targets.get(key).permission_ids.push(link.permission_id);
    }
    return [...targets.values()];
  },

  async removeSharingLinksForItem(entryIndex) {
    const entry = this.data?.entries?.[Number(entryIndex)];
    if (!entry) return;
    if (entry.sharing_link_details_error) return App.toast("Link details were not readable for this item. Rescan after fixing access.", true);
    await this.prepareSharingLinkRemoval(this.sharingLinkTargets([entry]), "this item");
  },

  async removeSharingLink(entryIndex, linkIndex) {
    const entry = this.data?.entries?.[Number(entryIndex)];
    const link = entry?.sharing_link_details?.[Number(linkIndex)];
    if (!entry || !link?.permission_id) return App.toast("This link cannot be removed. Rescan the site.", true);
    await this.prepareSharingLinkRemoval([{ list_id: entry.list_id, item_id: entry.item_id,
      library: entry.library, path: entry.display_path, permission_ids: [link.permission_id] }], "this link");
  },

  async removeSharingLinksForLibrary(entryIndex) {
    const selected = this.data?.entries?.[Number(entryIndex)];
    if (!selected) return;
    if (!this.scanCoversLibrary(selected.library)) return App.toast("Scan the whole site or select the library root before removing all library links.", true);
    const entries = (this.data.entries || []).filter(entry => entry.library === selected.library);
    if (entries.some(entry => entry.scan_error)) return App.toast("Some permission reads in this library failed. Resolve scan errors before bulk removal.", true);
    if (entries.some(entry => entry.has_sharing_links && entry.sharing_link_details_error)) return App.toast("Some link details in this library were unreadable. Resolve scan errors before bulk removal.", true);
    await this.prepareSharingLinkRemoval(this.sharingLinkTargets(entries), `library “${selected.library}”`);
  },

  async removeSharingLinksForSite() {
    if (this.data?.scan_scope !== "site") return App.toast("Run a full site scan before removing all site links.", true);
    if (Number(this.data.permission_errors || 0)) return App.toast("Some permission reads failed. Resolve scan errors before bulk site removal.", true);
    const entries = this.data.entries || [];
    if (entries.some(entry => entry.has_sharing_links && entry.sharing_link_details_error)) return App.toast("Some link details on this site were unreadable. Resolve scan errors before bulk removal.", true);
    await this.prepareSharingLinkRemoval(this.sharingLinkTargets(entries), "the full site");
  },

  async removeSelectedSharingLinks() {
    const wanted = new Set(this.selectedSharingLinks);
    const targets = this.sharingLinkTargets(this.data?.entries || []).map(target => ({
      ...target, permission_ids: target.permission_ids.filter(id => wanted.has(`${target.list_id}|${target.item_id}|${id}`)),
    })).filter(target => target.permission_ids.length);
    await this.prepareSharingLinkRemoval(targets, "selected links");
  },

  async prepareSharingLinkRemoval(targets, label) {
    if (!targets.length) return App.toast("No removable sharing links found in this scan.", true);
    const job = Busy.jobStart("sharepoint_permissions_prepare_remove_links");
    try {
      const plan = await Backend.call("sharepoint_permissions_prepare_remove_links", this.data.site_url, targets);
      if (!plan || !plan.ok) throw new Error(plan?.error || "Could not prepare the link removal preview.");
      this.showSharingLinkRemovalReview(plan, label);
    } catch (e) { App.toast(String(e?.message || e), true); }
    finally { Busy.jobEnd(job); }
  },

  showSharingLinkRemovalReview(plan, label) {
    const rows = (plan.targets || []).map(target => `<div class="spm-propagate-row"><span>${esc(target.library)}</span><b>${esc(target.path)}</b><small>${(target.links || []).map(link => `${esc(link.scope || "audience")} · ${esc(link.type || link.roles?.join(", ") || "access")}${link.expiration ? ` · expires ${esc(new Date(link.expiration).toLocaleString())}` : " · no expiry reported"}`).join("<br>")}</small></div>`).join("");
    document.getElementById("modalRoot").innerHTML = `<div class="overlay"><div class="modal spm-fix-modal spm-propagate-modal" role="dialog" aria-modal="true" aria-labelledby="spmRemoveLinksTitle"><div class="modal-head"><h3 id="spmRemoveLinksTitle">Review sharing-link removal</h3><button onclick="App._closeModal()" aria-label="Close">&times;</button></div><div class="modal-body"><div class="spm-warning">This will revoke ${Number(plan.link_count).toLocaleString()} sharing link${plan.link_count === 1 ? "" : "s"} across ${Number(plan.item_count).toLocaleString()} item${plan.item_count === 1 ? "" : "s"} in ${esc(label)}. Anyone relying on these links may lose access. SharePoint may not identify every recipient.</div><div class="spm-propagate-list">${rows}</div></div><div class="modal-foot"><button class="ghost" onclick="App._closeModal()">Cancel</button><button class="danger" onclick="SharePointPermissions.applySharingLinkRemoval('${plan.plan_id}')">Revoke reviewed links</button></div></div></div>`;
  },

  async applySharingLinkRemoval(planId) {
    const job = Busy.jobStart("sharepoint_permissions_apply_remove_links");
    try {
      const result = await Backend.call("sharepoint_permissions_apply_remove_links", planId, true);
      if (!result || !result.ok) throw new Error(result?.error || "Could not remove sharing links.");
      this.selectedSharingLinks.clear();
      App._closeModal();
      const failed = result.failed || [];
      App.toast(`${(result.removed || []).length.toLocaleString()} links revoked${failed.length ? ` · ${failed.length.toLocaleString()} failed` : ""}. Rescan to refresh results.`, !!failed.length);
      if (failed.length) this.showSharingLinkRemovalResult(failed);
    } catch (e) { App.toast(String(e?.message || e), true); }
    finally { Busy.jobEnd(job); }
  },

  showSharingLinkRemovalResult(failed) {
    const rows = failed.slice(0, 100).map(item => `<div class="spm-propagate-row"><b>${esc(item.path)}</b><small>${esc(item.error)}</small></div>`).join("");
    document.getElementById("modalRoot").innerHTML = `<div class="overlay"><div class="modal spm-fix-modal" role="dialog" aria-modal="true"><div class="modal-head"><h3>Some links could not be revoked</h3><button onclick="App._closeModal()" aria-label="Close">&times;</button></div><div class="modal-body"><p>${failed.length.toLocaleString()} link${failed.length === 1 ? "" : "s"} failed. Successfully revoked links stay revoked.</p><div class="spm-propagate-list">${rows}</div></div><div class="modal-foot"><button class="primary" onclick="App._closeModal()">Close</button></div></div></div>`;
  },

  revealSharingLink(entryIndex, linkIndex, button) {
    const link = this.data?.entries?.[Number(entryIndex)]?.sharing_link_details?.[Number(linkIndex)];
    const output = button?.closest(".spm-link-card")?.querySelector(".spm-link-url");
    if (!link?.web_url || !output) return;
    const reveal = output.hidden;
    output.textContent = reveal ? link.web_url : "";
    output.hidden = !reveal;
    button.textContent = reveal ? "Hide URL" : "Reveal URL";
  },

  async copySharingLink(entryIndex, linkIndex) {
    const link = this.data?.entries?.[Number(entryIndex)]?.sharing_link_details?.[Number(linkIndex)];
    if (!link?.web_url) return App.toast("This link URL was not returned by Microsoft Graph.", true);
    try {
      await navigator.clipboard.writeText(link.web_url);
      App.toast("Sharing link copied. Treat it as an access credential.");
    } catch (e) {
      const area = document.createElement("textarea");
      area.value = link.web_url; document.body.appendChild(area); area.select();
      try { document.execCommand("copy"); App.toast("Sharing link copied. Treat it as an access credential."); }
      catch (err) { App.toast("Could not copy sharing link.", true); }
      area.remove();
    }
  },

  renderDetail() {
    const host = document.getElementById("spmDetail");
    if (!host || !this.data) return;
    const entry = (this.data.entries || [])[this.selected];
    if (!entry) {
      host.innerHTML = '<div class="empty">Select an item to compare its access with its parent.</div>';
      return;
    }
    const rows = entry.diff || [];
    const assignments = entry.assignments || [];
    const state = { added: "Added here", removed: "Removed here", changed: "Changed", same: "Same as parent" };
    const table = rows.length ? `<div class="spm-principals">${rows.map(row => {
      const level = row.status === "removed" ? row.parent_level : row.level;
      const extra = row.status === "changed" ? ` <small>(parent: ${esc(row.parent_level)})</small>` : "";
      return `<div class="spm-principal"><span><b>${esc(row.title)}</b><small>${esc(row.kind.replaceAll("_", " "))}${row.email ? " · " + esc(row.email) : ""}</small></span><span>${esc(level)}${extra}<small class="spm-state ${row.status}">${state[row.status] || row.status}</small></span></div>`;
    }).join("")}</div>` : entry.scan_error
      ? '<div class="empty">Assignment details unavailable for this comparison.</div>'
      : '<div class="empty">No direct role assignments.</div>';
    const accessHint = this.data.can_manage_permissions === false
      ? "The Hub signed-in account lacks Manage Permissions on this site. Ask a site admin to grant this permission or add the account as a site collection administrator."
      : "";
    const warning = entry.scan_error
      ? `<div class="spm-warning">SharePoint refused this permission read. This comparison is incomplete.${accessHint ? `<br>${esc(accessHint)}` : ""}<br><small>${esc(entry.scan_error)}</small></div>`
      : entry.has_sharing_links
      ? '<div class="spm-warning">This item has sharing links. Resetting permissions would remove them; treat this entry as unsafe to reset.</div>'
      : entry.safe_to_reset
        ? '<div class="spm-safe-note">Current permissions match parent. Reset would preserve access.</div>'
        : "";
    const sharingLinks = this.renderSharingLinks(entry, this.selected);
    const modified = entry.modified && !Number.isNaN(Date.parse(entry.modified)) ? new Date(entry.modified).toLocaleString() : "Not reported";
    host.innerHTML = `<h3>${esc(entry.display_path)}</h3><p class="spm-detail-sub">${esc(entry.type)} in ${esc(entry.library)} · compared with parent ${esc(entry.parent_display_path)}<br>Last modified ${esc(modified)}${entry.modified_by ? ` by ${esc(entry.modified_by)}` : ""}</p>
      <div class="spm-detail-summary">${esc(entry.diff_summary)}</div>${warning}${sharingLinks}<div class="spm-detail-actions"><button class="rowbtn" onclick="SharePointPermissions.shareFinding()">Share finding</button><button class="rowbtn" onclick="SharePointPermissions.stageReview(${this.selected})">Add to review plan</button></div><h4>Access map · grants on this scope</h4>${table}`;
  },

  async copy() {
    const rows = this.filtered().map(({ entry }) => [entry.library, entry.type, entry.display_path, entry.parent_display_path,
      entry.diff_summary, entry.has_external ? "External" : "", entry.has_sharing_links ? "Sharing link" : ""].join("\t"));
    const text = ["Library\tType\tPath\tParent\tDifference\tExternal\tSharing link", ...rows].join("\n");
    const done = () => App.toast(`Copied ${rows.length} permission entries.`);
    const fallback = () => {
      const area = document.createElement("textarea");
      area.value = text; document.body.appendChild(area); area.select();
      try { document.execCommand("copy"); done(); } catch (e) { App.toast("Could not copy permission list.", true); }
      area.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  },

  async exportExcel() {
    if (!this.data) return App.toast("Scan a SharePoint site before exporting.", true);
    const result = await Backend.call("sharepoint_permissions_export_excel", {
      site_url: this.data.site_url, site_title: this.data.site_title, scanned_at: this.data.scanned_at,
      items_scanned: this.data.items_scanned, permission_errors: this.data.permission_errors,
      can_manage_permissions: this.data.can_manage_permissions, permission_targets: this.data.permission_targets,
      permissions_read: this.data.permissions_read, site_groups_found: this.data.site_groups_found,
      site_groups_expanded: this.data.site_groups_expanded, site_group_read_errors: this.data.site_group_read_errors,
      entra_groups_found: this.data.entra_groups_found, entra_groups_expanded: this.data.entra_groups_expanded,
      entra_group_read_errors: this.data.entra_group_read_errors,
      web_assignments: (this.data.web_assignments || []).map(a => ({
        title: a.title, login: a.login, email: a.email, kind: a.kind, level: a.level, external: a.external,
        members: (a.members || []).map(m => ({ title: m.title, login: m.login, email: m.email,
          kind: m.kind, level: m.level, via_group: m.via_group, external: m.external })),
      })),
      entries: (this.data.entries || []).map(entry => ({
        library: entry.library, type: entry.type, display_path: entry.display_path,
        parent_display_path: entry.parent_display_path, modified: entry.modified, modified_by: entry.modified_by,
        diff_summary: entry.diff_summary, differs: entry.differs, safe_to_reset: entry.safe_to_reset,
        has_external: entry.has_external, has_sharing_links: entry.has_sharing_links, scan_error: entry.scan_error,
        assignments: (entry.assignments || []).map(a => ({
          title: a.title, login: a.login, email: a.email, kind: a.kind, level: a.level, external: a.external,
          members: (a.members || []).map(m => ({ title: m.title, login: m.login, email: m.email,
            kind: m.kind, level: m.level, via_group: m.via_group, external: m.external })),
        })),
      })),
    });
    if (!result || !result.ok) return App.toast(result?.error || "Excel export failed.", true);
    try {
      const binary = atob(result.content_base64 || "");
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const slug = String(this.data.site_title || "sharepoint-site").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "sharepoint-site";
      anchor.href = href;
      anchor.download = `sharepoint-permissions-${slug}-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
      App.toast(`Downloaded Excel workbook with ${Number(result.scope_count || 0).toLocaleString()} permission scopes.`);
    } catch (e) { App.toast("Excel workbook could not be downloaded.", true); }
  },

  exportCsv() {
    if (!this.data) return App.toast("Scan a SharePoint site before exporting.", true);
    const warningParts = [];
    if (Number(this.data.permission_errors || 0)) warningParts.push(`SharePoint denied permission reads for ${Number(this.data.permission_errors).toLocaleString()} targets; comparisons are incomplete.`);
    if (Number(this.data.site_group_read_errors || 0)) warningParts.push(`SharePoint denied membership reads for ${Number(this.data.site_group_read_errors).toLocaleString()} site groups; effective access is incomplete.`);
    if (this.data.can_manage_permissions === false) warningParts.push("The signed-in account lacks Manage Permissions on this site.");
    const scanWarning = warningParts.join(" ");
    const headers = ["Record Type", "Site", "Scanned At", "Library Items Scanned", "Unique Permission Sets", "Permission Targets", "Permission Reads Completed", "Read Coverage", "Permission Read Errors", "SharePoint Groups Found", "SharePoint Groups Expanded", "Group Read Errors", "Manage Permissions", "Scan Warning", "Library", "Item Type", "Path", "Parent Path", "Last Modified", "Modified By", "Permission Difference", "Access Assignments", "External User", "Sharing Link", "Entry Warning"];
    const cell = value => {
      let text = value == null ? "" : String(value);
      if (/^[\s\uFEFF]*[=+\-@]/.test(text)) text = "'" + text;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const row = values => values.map(cell).join(",");
    const rows = [row(headers), row([
      "Scan summary", this.data.site_title || this.data.site_url, this.data.scanned_at,
      this.data.items_scanned, (this.data.entries || []).length, this.data.permission_targets || "",
      this.data.permissions_read || "", this.data.permission_targets ? `${Math.round(100 * this.data.permissions_read / this.data.permission_targets)}%` : "",
      this.data.permission_errors || 0, this.data.site_groups_found || 0, this.data.site_groups_expanded || 0,
      this.data.site_group_read_errors || 0,
      this.data.can_manage_permissions == null ? "Unknown" : this.data.can_manage_permissions ? "Yes" : "No",
      scanWarning,
    ])];
    for (const { entry } of this.filtered()) {
      const access = (entry.assignments || []).map(a => `${a.title || a.login || "Unknown"}${a.email ? ` <${a.email}>` : ""}: ${a.level || ""}`).join("; ");
      rows.push(row([
        "Permission entry", this.data.site_title || this.data.site_url, this.data.scanned_at,
        this.data.items_scanned, "", this.data.permission_targets || "", this.data.permissions_read || "",
        this.data.permission_targets ? `${Math.round(100 * this.data.permissions_read / this.data.permission_targets)}%` : "",
        this.data.permission_errors || 0, this.data.site_groups_found || 0, this.data.site_groups_expanded || 0,
        this.data.site_group_read_errors || 0,
        this.data.can_manage_permissions == null ? "Unknown" : this.data.can_manage_permissions ? "Yes" : "No",
        scanWarning, entry.library, entry.type, entry.display_path, entry.parent_display_path, entry.modified || "", entry.modified_by || "",
        entry.diff_summary, access, entry.has_external ? "Yes" : "No", entry.has_sharing_links ? "Yes" : "No",
        entry.scan_error || "",
      ]));
    }
    const blob = new Blob(["\uFEFF" + rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const slug = String(this.data.site_title || "sharepoint-site").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "sharepoint-site";
    anchor.href = href;
    anchor.download = `sharepoint-permissions-${slug}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
    App.toast(`Exported ${this.filtered().length.toLocaleString()} permission entries with scan warnings.`);
  },
};
