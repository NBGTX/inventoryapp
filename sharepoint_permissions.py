"""SharePoint permission browsing, auditing, and reviewed permission changes.

Scans and folder browsing are read-only. Permission changes require a server-side
preview and explicit confirmation.
"""
from __future__ import annotations

import concurrent.futures
import base64
import datetime as _dt
import hashlib
from html import escape as _xml_escape
from io import BytesIO
import json
import re
import threading
import zipfile
import time
from urllib.parse import urlencode, urlsplit

import requests


class SharePointPermissionsError(RuntimeError):
    def __init__(self, message: str, status_code: int = 0):
        super().__init__(message)
        self.status_code = status_code


class SharePointScanCancelled(RuntimeError):
    """Raised when a user cancels an in-progress read-only scan."""


def _assignment_signature(assignments: list[dict]) -> str:
    rows = []
    for assignment in assignments or []:
        roles = sorted(str(role.get("id") or role.get("name") or "") for role in assignment.get("roles", []))
        rows.append((str(assignment.get("id") or ""), str(assignment.get("login") or ""), tuple(roles)))
    payload = json.dumps(sorted(rows), ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def normalize_site_url(value: str, allowed_host: str) -> str:
    text = (value or "").strip()
    if not text:
        raise SharePointPermissionsError("Enter a SharePoint site address.")
    if "://" not in text:
        text = "https://" + text
    uri = urlsplit(text)
    if uri.scheme.lower() != "https" or not uri.hostname:
        raise SharePointPermissionsError("Use an HTTPS SharePoint site address.")
    host = uri.hostname.lower()
    if not host.endswith(".sharepoint.com"):
        raise SharePointPermissionsError("Only SharePoint Online sites are supported.")
    if allowed_host and host != allowed_host.strip().lower():
        raise SharePointPermissionsError(f"This Hub sign-in is configured for {allowed_host}.")
    parts = [p for p in uri.path.split("/") if p]
    path = "/" + "/".join(parts) if parts else ""
    return f"https://{host}{path}"


class _RestClient:
    _RETRY_STATUS = {429, 503, 504}

    def __init__(self, site_url: str, token: str, cancel_event=None):
        self.site_url = site_url.rstrip("/")
        self.token = token
        self.cancel_event = cancel_event
        self.timeout = 30 if cancel_event is not None else 120
        self._sessions = threading.local()
        self._request_digest = ""
        self._request_digest_expires = 0.0

    def _check_cancelled(self):
        if self.cancel_event is not None and self.cancel_event.is_set():
            raise SharePointScanCancelled("SharePoint scan cancelled.")

    def _session(self) -> requests.Session:
        session = getattr(self._sessions, "value", None)
        if session is None:
            session = requests.Session()
            session.headers.update({
                "Authorization": f"Bearer {self.token}",
                "Accept": "application/json;odata=nometadata",
            })
            self._sessions.value = session
        return session

    def get(self, path: str) -> dict:
        url = path if path.startswith("https://") else f"{self.site_url}/_api{path}"
        for attempt in range(6):
            self._check_cancelled()
            try:
                response = self._session().get(url, timeout=self.timeout)
            except requests.RequestException as exc:
                self._check_cancelled()
                if attempt == 5:
                    raise SharePointPermissionsError(f"SharePoint request failed: {exc}") from exc
                if self.cancel_event is not None:
                    self.cancel_event.wait(min(2 ** attempt, 30))
                    self._check_cancelled()
                else:
                    time.sleep(min(2 ** attempt, 30))
                continue
            if response.ok:
                if not response.content:
                    return {}
                try:
                    return response.json()
                except ValueError as exc:
                    raise SharePointPermissionsError("SharePoint returned an unreadable response.") from exc
            if response.status_code in self._RETRY_STATUS and attempt < 5:
                delay = response.headers.get("Retry-After", "")
                try:
                    seconds = max(float(delay), 1.0)
                except (TypeError, ValueError):
                    seconds = min(2 ** attempt, 30)
                if self.cancel_event is not None:
                    if self.cancel_event.wait(min(seconds, 60)):
                        self._check_cancelled()
                else:
                    time.sleep(min(seconds, 60))
                continue
            detail = self._friendly_error(response.status_code, response.text)
            # Include the REST endpoint: Hub's consent check proves token acquisition,
            # while SharePoint can still deny a particular site or securable object.
            # Showing the rejected endpoint makes that distinction actionable.
            raise SharePointPermissionsError(f"{detail} Request: {url}", response.status_code)
        raise SharePointPermissionsError("SharePoint kept throttling the scan. Try again shortly.")

    def post(self, path: str, data=None, headers=None) -> dict:
        """POST a SharePoint REST action using a fresh request digest."""
        self._check_cancelled()
        digest = self._request_digest if time.time() < self._request_digest_expires else ""
        if not digest:
            context_url = f"{self.site_url}/_api/contextinfo"
            try:
                context_response = self._session().post(context_url, timeout=self.timeout)
            except requests.RequestException as exc:
                raise SharePointPermissionsError(f"Could not obtain SharePoint request digest: {exc}") from exc
            if not context_response.ok:
                raise SharePointPermissionsError(self._friendly_error(context_response.status_code, context_response.text), context_response.status_code)
            try:
                info = context_response.json()
            except ValueError as exc:
                raise SharePointPermissionsError("SharePoint returned an unreadable request digest.") from exc
            digest = (((info.get("GetContextWebInformation") or {}).get("FormDigestValue"))
                      or ((info.get("d") or {}).get("GetContextWebInformation") or {}).get("FormDigestValue"))
            self._request_digest = str(digest or "")
            self._request_digest_expires = time.time() + 1500
        if not digest:
            raise SharePointPermissionsError("SharePoint did not return a request digest for the permission update.")
        url = path if path.startswith("https://") else f"{self.site_url}/_api{path}"
        request_headers = {"X-RequestDigest": digest, "Content-Type": "application/json;odata=nometadata"}
        request_headers.update(headers or {})
        try:
            response = self._session().post(url, json=data, headers=request_headers, timeout=self.timeout)
        except requests.RequestException as exc:
            raise SharePointPermissionsError(f"SharePoint permission update failed: {exc}") from exc
        if response.ok:
            if not response.content:
                return {}
            try:
                return response.json()
            except ValueError:
                return {}
        detail = self._friendly_error(response.status_code, response.text)
        raise SharePointPermissionsError(f"{detail} Request: {url}", response.status_code)

    @staticmethod
    def _friendly_error(status: int, text: str) -> str:
        message = ""
        try:
            data = json.loads(text)
            error = data.get("odata.error") or data.get("error") or {}
            detail = error.get("message") or {}
            message = detail.get("value", "") if isinstance(detail, dict) else str(detail)
        except (ValueError, TypeError):
            pass
        if status == 401:
            prefix = "Hub sign-in expired or SharePoint token unavailable. Sign in again."
        elif status == 403:
            prefix = "SharePoint refused this scan. Confirm your site access and Hub's AllSites.FullControl consent."
        elif status == 404:
            prefix = "SharePoint site or item not found. Check the site address."
        else:
            prefix = f"SharePoint returned HTTP {status}."
        return f"{prefix} {message}".strip()

    def all(self, path: str, on_page=None) -> list[dict]:
        rows = []
        next_path: str | None = path
        while next_path:
            self._check_cancelled()
            data = self.get(next_path)
            page = data.get("value") or []
            rows.extend(page)
            if on_page:
                on_page(len(rows), len(page), page)
            next_path = data.get("odata.nextLink") or data.get("@odata.nextLink")
        return rows

    @staticmethod
    def _base(ref: tuple) -> str:
        kind, list_id, item_id = ref
        if kind == "web":
            return "/web"
        if kind == "list":
            return f"/web/lists(guid'{list_id}')"
        return f"/web/lists(guid'{list_id}')/items({item_id})"

    def assignments(self, ref: tuple) -> list[dict]:
        path = self._base(ref) + "/roleassignments?$select=PrincipalId,Member/Id,Member/Title,Member/LoginName,Member/Email,Member/PrincipalType,RoleDefinitionBindings/Id,RoleDefinitionBindings/Name,RoleDefinitionBindings/RoleTypeKind&$expand=Member,RoleDefinitionBindings"
        rows = []
        for row in self.all(path):
            member = row.get("Member") or {}
            login = str(member.get("LoginName") or "")
            title = str(member.get("Title") or login or "Unknown principal")
            sharing_link = login.lower().startswith("sharinglinks.")
            if sharing_link:
                bits = login.split(".")
                sharing_type = bits[2].lower() if len(bits) >= 3 else ""
                title = {
                    "anonymousview": "Sharing link: anyone (view)",
                    "anonymousedit": "Sharing link: anyone (edit)",
                    "organizationview": "Sharing link: people in organization (view)",
                    "organizationedit": "Sharing link: people in organization (edit)",
                    "flexible": "Sharing link: specific people",
                }.get(sharing_type, "Sharing link")
            principal_type = member.get("PrincipalType", 0)
            # SharePoint sharing-link principals can also report PrincipalType 8.
            # Classify them first so we do not try to expand them as site groups.
            kind = "sharing_link" if sharing_link else "user" if principal_type == 1 else "group" if principal_type in (2, 4) else "site_group" if principal_type == 8 else "other"
            roles = []
            for role in row.get("RoleDefinitionBindings") or []:
                if role.get("RoleTypeKind") == 1:  # automatic Limited Access grant
                    continue
                roles.append({"id": role.get("Id"), "name": str(role.get("Name") or "")})
            if not roles:
                continue
            roles.sort(key=lambda x: x["name"].casefold())
            rows.append({
                "id": member.get("Id"), "principal_id": row.get("PrincipalId"), "title": title, "login": login,
                "email": member.get("Email") or "", "kind": kind,
                "external": "#ext#" in login.lower(), "sharing_link": sharing_link,
                "roles": roles, "level": ", ".join(r["name"] for r in roles),
            })
        return rows

    def site_group_members(self, group_id: int) -> list[dict]:
        """Read members of a native SharePoint site group (no membership changes)."""
        group_id = int(group_id)
        if group_id <= 0:
            raise SharePointPermissionsError("SharePoint returned an invalid site group ID.")
        return self.all(f"/web/sitegroups({group_id})/users?$select=Id,Title,LoginName,Email,PrincipalType")


def search_sites(host: str, token: str, query: str = "", start: int = 0) -> dict:
    """Search indexed site collections under the tenant's /sites path."""
    host = (host or "").strip().strip("/").lower()
    if not host.endswith(".sharepoint.com") or "/" in host:
        raise SharePointPermissionsError("Site search is only available for the configured SharePoint Online host.")
    start = max(0, min(int(start or 0), 450))
    root = f"https://{host}"
    kql = f'contentclass:STS_Site Path:"{root}/sites/*"'
    # Keep user input as a quoted phrase so it cannot alter the fixed KQL scope.
    phrase = " ".join((query or "").replace('"', " ").split())[:100]
    if phrase:
        kql += f' "{phrase}"'
    params = urlencode({
        "querytext": f"'{kql}'", "selectproperties": "'Title,Path,SiteLogo'",
        "rowlimit": "50", "startrow": str(start), "trimduplicates": "false",
    })
    client = _RestClient(root, token)
    try:
        data = client.get(f"{root}/_api/search/query?{params}")
    except SharePointPermissionsError as exc:
        # Some tenants do not expose SiteLogo as a retrievable managed property.
        if exc.status_code != 400:
            raise
        params = urlencode({
            "querytext": f"'{kql}'", "selectproperties": "'Title,Path'",
            "rowlimit": "50", "startrow": str(start), "trimduplicates": "false",
        })
        data = client.get(f"{root}/_api/search/query?{params}")
    primary = data.get("PrimaryQueryResult") or {}
    relevant = primary.get("RelevantResults") or {}
    table = relevant.get("Table") or {}
    row_box = table.get("Rows") or {}
    rows = row_box.get("results") if isinstance(row_box, dict) else row_box
    rows = rows if isinstance(rows, list) else []
    sites, seen = [], set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        cell_box = row.get("Cells") or []
        cells = cell_box.get("results") if isinstance(cell_box, dict) else cell_box
        cells = cells if isinstance(cells, list) else []
        fields = {
            str(cell.get("Key") or "").lower(): str(cell.get("Value") or "")
            for cell in cells if isinstance(cell, dict)
        }
        title, url = fields.get("title", "").strip(), fields.get("path", "").strip()
        uri = urlsplit(url)
        if uri.scheme != "https" or (uri.hostname or "").lower() != host:
            continue
        if not uri.path.lower().startswith("/sites/") or url.lower() in seen:
            continue
        seen.add(url.lower())
        logo = fields.get("sitelogo", fields.get("sitelogourl", "")).strip()
        logo_uri = urlsplit(logo) if logo else None
        if logo and logo.startswith("/"):
            logo = f"https://{host}{logo}"
        elif logo_uri and (logo_uri.scheme != "https" or (logo_uri.hostname or "").lower() != host):
            logo = ""
        sites.append({"title": title or uri.path.rstrip("/").split("/")[-1], "url": url, "logo": logo})
    total = int(relevant.get("TotalRows") or len(sites))
    return {"sites": sites, "total": total, "start": start,
            "next_start": start + len(rows) if start + len(rows) < total and start + len(rows) < 500 else None}


def browse_content(site_input: str, allowed_host: str, token: str, folder_path: str = "", list_id: str = "") -> dict:
    """List document libraries or immediate child folders without reading permissions."""
    supplied_url = normalize_site_url(site_input, allowed_host)
    parsed = urlsplit(supplied_url)
    parts = [part for part in parsed.path.split("/") if part]
    minimum = 2 if len(parts) >= 2 and parts[0].lower() in ("sites", "teams") else 0
    client = _RestClient(supplied_url, token)
    web = None
    for count in range(len(parts), minimum - 1, -1):
        candidate_path = "/" + "/".join(parts[:count]) if count else ""
        client.site_url = f"{parsed.scheme}://{parsed.netloc}{candidate_path}".rstrip("/")
        try:
            web = client.get("/web?$select=Title,Url,ServerRelativeUrl")
            break
        except SharePointPermissionsError as exc:
            if exc.status_code != 404:
                raise
    if web is None:
        raise SharePointPermissionsError("Could not find a SharePoint site at that address.")
    libraries_raw = client.all("/web/lists?$select=Id,Title,ItemCount,HasUniqueRoleAssignments,BaseTemplate,Hidden,RootFolder/ServerRelativeUrl&$expand=RootFolder&$filter=BaseTemplate eq 101 and Hidden eq false")
    libraries = []
    for lib in libraries_raw:
        title = str(lib.get("Title") or "")
        if title.casefold() in ("form templates", "style library"):
            continue
        root = str((lib.get("RootFolder") or {}).get("ServerRelativeUrl") or "")
        libraries.append({"id": str(lib.get("Id") or ""), "title": title, "root_url": root,
                          "item_count": int(lib.get("ItemCount") or 0),
                          "has_unique": bool(lib.get("HasUniqueRoleAssignments"))})
    if not folder_path:
        return {"site_url": client.site_url, "site_title": str(web.get("Title") or client.site_url),
                "libraries": libraries, "folders": [], "parent_path": ""}
    lib = next((row for row in libraries if row["id"].casefold() == str(list_id).casefold()), None)
    if not lib:
        raise SharePointPermissionsError("Choose a document library before browsing folders.")
    parent = str(folder_path).strip().rstrip("/")
    root = lib["root_url"].rstrip("/")
    if not root or (parent.casefold() != root.casefold() and not parent.casefold().startswith(root.casefold() + "/")):
        raise SharePointPermissionsError("Folder is outside the selected document library.")
    escaped_parent = parent.replace("'", "''")
    query = urlencode({
        "$select": "Id,FileRef,FileLeafRef,FileSystemObjectType,HasUniqueRoleAssignments",
        "$filter": f"FileDirRef eq '{escaped_parent}' and FileSystemObjectType eq 1",
        "$top": "2000",
    })
    items = client.all(f"/web/lists(guid'{lib['id']}')/items?{query}")
    folders = [{"id": int(item.get("Id") or 0), "name": str(item.get("FileLeafRef") or ""),
                "path": str(item.get("FileRef") or ""),
                "has_unique": bool(item.get("HasUniqueRoleAssignments"))}
               for item in items if item.get("FileRef")]
    folders.sort(key=lambda row: row["name"].casefold())
    return {"site_url": client.site_url, "site_title": str(web.get("Title") or client.site_url),
            "libraries": libraries, "folders": folders, "parent_path": parent}


def prepare_inheritance_reset(site_input: str, allowed_host: str, token: str,
                              list_id: str, parent_path: str) -> dict:
    """Build a complete preview of unique descendants that would inherit from parent_path."""
    site_url = normalize_site_url(site_input, allowed_host)
    client = _RestClient(site_url, token)
    lib_id = str(list_id or "").strip()
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", lib_id):
        raise SharePointPermissionsError("Choose a valid document library.")
    lib = client.get(f"/web/lists(guid'{lib_id}')?$select=Id,Title,BaseTemplate,RootFolder/ServerRelativeUrl&$expand=RootFolder")
    if int(lib.get("BaseTemplate") or 0) != 101:
        raise SharePointPermissionsError("Permission inheritance can only be propagated from a document library folder.")
    library_root = str((lib.get("RootFolder") or {}).get("ServerRelativeUrl") or "").rstrip("/")
    parent_path = str(parent_path or "").rstrip("/")
    if not library_root or (parent_path.casefold() != library_root.casefold() and not parent_path.casefold().startswith(library_root.casefold() + "/")):
        raise SharePointPermissionsError("Selected parent is outside the document library.")
    parent_item_id = 0
    if parent_path.casefold() != library_root.casefold():
        escaped_parent = parent_path.replace("'", "''")
        root_query = urlencode({"$select": "Id,FileRef,FileSystemObjectType", "$filter": f"FileRef eq '{escaped_parent}'"})
        root_items = client.all(f"/web/lists(guid'{lib_id}')/items?{root_query}")
        if not root_items or int(root_items[0].get("FileSystemObjectType") or 0) != 1:
            raise SharePointPermissionsError("Selected parent folder no longer exists. Browse to it again.")
        parent_item_id = int(root_items[0].get("Id") or 0)
    effective = client.get("/web/effectivebasepermissions")
    if not (int(effective.get("Low") or 0) & 0x02000000):
        raise SharePointPermissionsError("Your account lacks Manage Permissions on this site.")
    parent_ref = ("item", lib_id, parent_item_id) if parent_item_id else ("list", lib_id, 0)
    parent_assignments = client.assignments(parent_ref)
    prefix = (parent_path.rstrip("/") + "/").replace("'", "''")
    query = urlencode({
        "$select": "Id,FileRef,FileSystemObjectType,HasUniqueRoleAssignments",
        "$filter": f"startswith(FileRef,'{prefix}')",
        "$top": "2000",
    })
    rows = client.all(f"/web/lists(guid'{lib_id}')/items?{query}")
    descendants = [row for row in rows
                   if str(row.get("FileRef") or "").casefold().startswith((parent_path.rstrip("/") + "/").casefold())
                   and row.get("HasUniqueRoleAssignments")]
    if len(descendants) > 1000:
        raise SharePointPermissionsError("This folder has over 1,000 unique descendants. Choose a smaller folder so every affected item fits in the review preview.")
    descendants.sort(key=lambda row: str(row.get("FileRef") or "").casefold())
    targets = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(client.assignments, ("item", lib_id, int(row.get("Id") or 0))): row
                   for row in descendants}
        for future in concurrent.futures.as_completed(futures):
            row = futures[future]
            assignments = future.result()
            targets.append({"item_id": int(row.get("Id") or 0), "path": str(row.get("FileRef") or ""),
                            "type": "Folder" if int(row.get("FileSystemObjectType") or 0) == 1 else "File",
                            "assignments": assignments,
                            "sharing_links": sum(1 for principal in assignments if principal.get("sharing_link"))})
    targets.sort(key=lambda row: row["path"].casefold())
    return {"site_url": client.site_url, "library_id": lib_id, "library_title": str(lib.get("Title") or ""),
            "parent_path": parent_path, "parent_assignments": parent_assignments,
            "parent_signature": _assignment_signature(parent_assignments), "targets": targets,
            "sharing_link_targets": sum(1 for row in targets if row["sharing_links"]),
            "principal_grants": sum(len(row["assignments"]) for row in targets)}


def apply_inheritance_reset(site_url: str, allowed_host: str, token: str, plan: dict) -> dict:
    """Reset still-unique descendants to inherit from their immediate parent."""
    site_url = normalize_site_url(site_url, allowed_host)
    client = _RestClient(site_url, token)
    lib_id = str(plan.get("library_id") or "")
    parent_path = str(plan.get("parent_path") or "").rstrip("/")
    targets = plan.get("targets") if isinstance(plan.get("targets"), list) else []
    library = client.get(f"/web/lists(guid'{lib_id}')?$select=Id,BaseTemplate,RootFolder/ServerRelativeUrl&$expand=RootFolder")
    if int(library.get("BaseTemplate") or 0) != 101:
        raise SharePointPermissionsError("The selected document library changed. Build a fresh preview.")
    library_root = str((library.get("RootFolder") or {}).get("ServerRelativeUrl") or "").rstrip("/")
    parent_item_id = 0
    if parent_path.casefold() != library_root.casefold():
        escaped_parent = parent_path.replace("'", "''")
        parent_query = urlencode({"$select": "Id,FileRef,FileSystemObjectType", "$filter": f"FileRef eq '{escaped_parent}'"})
        parent_rows = client.all(f"/web/lists(guid'{lib_id}')/items?{parent_query}")
        if not parent_rows or int(parent_rows[0].get("FileSystemObjectType") or 0) != 1:
            raise SharePointPermissionsError("Parent folder changed since preview. Rebuild the preview.")
        parent_item_id = int(parent_rows[0].get("Id") or 0)
    effective = client.get("/web/effectivebasepermissions")
    if not (int(effective.get("Low") or 0) & 0x02000000):
        raise SharePointPermissionsError("Your account lacks Manage Permissions on this site.")
    current_parent = client.assignments(("item", lib_id, parent_item_id) if parent_item_id else ("list", lib_id, 0))
    if _assignment_signature(current_parent) != str(plan.get("parent_signature") or ""):
        raise SharePointPermissionsError("Parent permissions changed since preview. Review a fresh preview before applying.")
    applied, skipped, errors = [], [], []
    for target in targets:
        try:
            item_id = int(target.get("item_id") or 0)
            expected_path = str(target.get("path") or "")
            if item_id <= 0 or not expected_path.casefold().startswith((parent_path + "/").casefold()):
                raise SharePointPermissionsError("A planned item is outside the selected parent folder.")
            current = client.get(f"/web/lists(guid'{lib_id}')/items({item_id})?$select=Id,FileRef,HasUniqueRoleAssignments")
            if str(current.get("FileRef") or "").casefold() != expected_path.casefold():
                raise SharePointPermissionsError("Item path changed since preview. Rebuild the preview.")
            if not current.get("HasUniqueRoleAssignments"):
                skipped.append(expected_path)
                continue
            client.post(f"/web/lists(guid'{lib_id}')/items({item_id})/resetroleinheritance")
            applied.append(expected_path)
        except Exception as exc:
            errors.append({"path": str(target.get("path") or ""), "error": str(exc)})
    return {"applied": applied, "skipped": skipped, "errors": errors,
            "complete": not errors, "parent_path": parent_path}


def prepare_permission_copy(site_input: str, allowed_host: str, token: str,
                            source_list_id: str, source_path: str,
                            target_list_id: str, target_path: str) -> dict:
    """Preview copying one source ACL to a destination and inheriting its descendants."""
    site_url = normalize_site_url(site_input, allowed_host)
    client = _RestClient(site_url, token)

    def resolve(list_id: str, path: str) -> dict:
        if not re.fullmatch(r"[0-9a-fA-F-]{36}", str(list_id or "").strip()):
            raise SharePointPermissionsError("Choose a valid document library for both locations.")
        lib = client.get(f"/web/lists(guid'{list_id}')?$select=Id,Title,BaseTemplate,HasUniqueRoleAssignments,RootFolder/ServerRelativeUrl&$expand=RootFolder")
        if int(lib.get("BaseTemplate") or 0) != 101:
            raise SharePointPermissionsError("Permission copy supports document libraries only.")
        root = str((lib.get("RootFolder") or {}).get("ServerRelativeUrl") or "").rstrip("/")
        path = str(path or "").rstrip("/")
        if not root or (path.casefold() != root.casefold() and not path.casefold().startswith(root.casefold() + "/")):
            raise SharePointPermissionsError("Choose a library or folder inside that document library.")
        item_id = 0
        unique = bool(lib.get("HasUniqueRoleAssignments"))
        if path.casefold() != root.casefold():
            escaped = path.replace("'", "''")
            query = urlencode({"$select": "Id,FileRef,FileSystemObjectType,HasUniqueRoleAssignments",
                              "$filter": f"FileRef eq '{escaped}'"})
            matches = client.all(f"/web/lists(guid'{list_id}')/items?{query}")
            if not matches or int(matches[0].get("FileSystemObjectType") or 0) != 1:
                raise SharePointPermissionsError("A selected folder no longer exists. Browse to it again.")
            item_id = int(matches[0].get("Id") or 0)
            unique = bool(matches[0].get("HasUniqueRoleAssignments"))
        return {"list_id": str(list_id), "title": str(lib.get("Title") or ""), "root": root,
                "path": path, "item_id": item_id, "unique": unique,
                "ref": ("item", str(list_id), item_id) if item_id else ("list", str(list_id), 0)}

    source = resolve(source_list_id, source_path)
    target = resolve(target_list_id, target_path)
    if source["list_id"].casefold() == target["list_id"].casefold():
        sp, tp = source["path"].casefold(), target["path"].casefold()
        if sp == tp or sp.startswith(tp + "/") or tp.startswith(sp + "/"):
            raise SharePointPermissionsError("Choose separate, non-overlapping source and destination folders.")
    effective = client.get("/web/effectivebasepermissions")
    if not (int(effective.get("Low") or 0) & 0x02000000):
        raise SharePointPermissionsError("Your account lacks Manage Permissions on this site.")
    source_assignments = client.assignments(source["ref"])
    if not source_assignments:
        raise SharePointPermissionsError("Source has no copyable permission grants.")
    operator_id = int((client.get("/web/currentuser?$select=Id").get("Id") or 0))
    target_assignments = client.assignments(target["ref"])
    prefix = (target["path"].rstrip("/") + "/").replace("'", "''")
    query = urlencode({"$select": "Id,FileRef,FileSystemObjectType,HasUniqueRoleAssignments",
                       "$filter": f"startswith(FileRef,'{prefix}')", "$top": "2000"})
    rows = client.all(f"/web/lists(guid'{target['list_id']}')/items?{query}")
    descendants = [row for row in rows
                   if str(row.get("FileRef") or "").casefold().startswith((target["path"].rstrip("/") + "/").casefold())
                   and row.get("HasUniqueRoleAssignments")]
    if len(descendants) > 1000:
        raise SharePointPermissionsError("Destination has over 1,000 unique descendants. Choose a smaller folder.")
    descendant_assignments = {}
    for row in descendants:
        item_id = int(row.get("Id") or 0)
        descendant_assignments[item_id] = client.assignments(("item", target["list_id"], item_id))
    descendants.sort(key=lambda row: str(row.get("FileRef") or "").casefold())
    return {"site_url": client.site_url, "operator_id": operator_id,
            "source": {**source, "assignments": source_assignments,
                       "signature": _assignment_signature(source_assignments)},
            "target": {**target, "assignments": target_assignments,
                       "signature": _assignment_signature(target_assignments)},
            "descendants": [{"item_id": int(row.get("Id") or 0),
                             "path": str(row.get("FileRef") or ""),
                             "type": "Folder" if int(row.get("FileSystemObjectType") or 0) == 1 else "File",
                             "signature": _assignment_signature(descendant_assignments[int(row.get("Id") or 0)]),
                             "assignments": descendant_assignments[int(row.get("Id") or 0)]}
                            for row in descendants]}


def apply_permission_copy(site_url: str, allowed_host: str, token: str, plan: dict) -> dict:
    """Replace destination grants with source grants, then reset unique descendants."""
    site_url = normalize_site_url(site_url, allowed_host)
    client = _RestClient(site_url, token)
    source, target = plan["source"], plan["target"]

    def live_scope(snapshot: dict) -> dict:
        list_id, path = snapshot["list_id"], snapshot["path"]
        lib = client.get(f"/web/lists(guid'{list_id}')?$select=Id,BaseTemplate,HasUniqueRoleAssignments,RootFolder/ServerRelativeUrl&$expand=RootFolder")
        if int(lib.get("BaseTemplate") or 0) != 101:
            raise SharePointPermissionsError("A selected document library changed. Build a fresh preview.")
        root = str((lib.get("RootFolder") or {}).get("ServerRelativeUrl") or "").rstrip("/")
        if path.casefold() == root.casefold():
            return {"ref": ("list", list_id, 0), "unique": bool(lib.get("HasUniqueRoleAssignments"))}
        escaped = path.replace("'", "''")
        query = urlencode({"$select": "Id,FileRef,FileSystemObjectType,HasUniqueRoleAssignments",
                           "$filter": f"FileRef eq '{escaped}'"})
        matches = client.all(f"/web/lists(guid'{list_id}')/items?{query}")
        if not matches or int(matches[0].get("FileSystemObjectType") or 0) != 1:
            raise SharePointPermissionsError("A selected folder changed since preview. Rebuild the preview.")
        item_id = int(matches[0].get("Id") or 0)
        return {"ref": ("item", list_id, item_id), "unique": bool(matches[0].get("HasUniqueRoleAssignments")),
                "item_id": item_id}

    effective = client.get("/web/effectivebasepermissions")
    if not (int(effective.get("Low") or 0) & 0x02000000):
        raise SharePointPermissionsError("Your account lacks Manage Permissions on this site.")
    current_source = client.assignments(live_scope(source)["ref"])
    target_scope = live_scope(target)
    current_target = client.assignments(target_scope["ref"])
    if (_assignment_signature(current_source) != source["signature"]
            or _assignment_signature(current_target) != target["signature"]):
        raise SharePointPermissionsError("Source or destination permissions changed since preview. Review a fresh preview.")
    current_user = client.get("/web/currentuser?$select=Id,LoginName")
    operator_id = int(current_user.get("Id") or 0)
    for entry in plan["descendants"]:
        current = client.get(f"/web/lists(guid'{target['list_id']}')/items({int(entry['item_id'])})?$select=Id,FileRef,HasUniqueRoleAssignments")
        if (str(current.get("FileRef") or "").casefold() != str(entry["path"]).casefold()
                or not current.get("HasUniqueRoleAssignments")):
            raise SharePointPermissionsError("Destination descendants changed since preview. Review a fresh preview.")
        assignments = client.assignments(("item", target["list_id"], int(entry["item_id"])))
        if _assignment_signature(assignments) != entry["signature"]:
            raise SharePointPermissionsError("Destination descendant permissions changed since preview. Review a fresh preview.")
    prefix = (target["path"].rstrip("/") + "/").replace("'", "''")
    query = urlencode({"$select": "Id,FileRef,HasUniqueRoleAssignments",
                       "$filter": f"startswith(FileRef,'{prefix}')", "$top": "2000"})
    current_rows = client.all(f"/web/lists(guid'{target['list_id']}')/items?{query}")
    current_unique = {(int(row.get("Id") or 0), str(row.get("FileRef") or "").casefold())
                      for row in current_rows
                      if row.get("HasUniqueRoleAssignments")
                      and str(row.get("FileRef") or "").casefold().startswith((target["path"].rstrip("/") + "/").casefold())}
    planned_unique = {(int(row["item_id"]), str(row["path"]).casefold()) for row in plan["descendants"]}
    if current_unique != planned_unique:
        raise SharePointPermissionsError("Destination contents changed since preview. Review a fresh preview.")

    ref = target_scope["ref"]
    base = client._base(ref)
    result = {"target_path": target["path"], "grants_added": 0, "descendants_reset": [], "errors": []}
    try:
        if not target_scope["unique"]:
            client.post(base + "/breakroleinheritance(copyRoleAssignments=false,clearSubscopes=false)")
        existing = client.assignments(ref)
        for assignment in existing:
            principal_id = int(assignment.get("principal_id") or assignment.get("id") or 0)
            if operator_id and principal_id == operator_id:
                continue
            if principal_id > 0:
                client.post(base + f"/roleassignments/getbyprincipalid({principal_id})/deleteobject")
        for assignment in source["assignments"]:
            if assignment.get("sharing_link"):
                continue
            principal_id = int(assignment.get("principal_id") or assignment.get("id") or 0)
            if principal_id <= 0:
                continue
            if operator_id and principal_id == operator_id:
                continue
            for role in assignment.get("roles") or []:
                role_id = int(role.get("id") or 0)
                if role_id > 0:
                    client.post(base + f"/roleassignments/addroleassignment(principalid={principal_id},roledefid={role_id})")
                    result["grants_added"] += 1
    except Exception as exc:
        result["errors"].append({"path": target["path"], "error": str(exc)})
        result["complete"] = False
        result["target_updated"] = False
        return result

    for entry in plan["descendants"]:
        try:
            client.post(f"/web/lists(guid'{target['list_id']}')/items({int(entry['item_id'])})/resetroleinheritance")
            result["descendants_reset"].append(entry["path"])
        except Exception as exc:
            result["errors"].append({"path": entry["path"], "error": str(exc)})
    result["target_updated"] = True
    result["complete"] = not result["errors"]
    result["operator_access_preserved"] = True
    result["sharing_links_not_copied"] = sum(1 for item in source["assignments"] if item.get("sharing_link"))
    return result


def _diff(current: list[dict], parent: list[dict]) -> list[dict]:
    def by_id(rows):
        return {str(p["id"]): p for p in rows}

    cur, par = by_id(current), by_id(parent)
    result = []
    for pid in cur.keys() | par.keys():
        c, p = cur.get(pid), par.get(pid)
        principal = c or p
        if c and p:
            status = "same" if c["level"].casefold() == p["level"].casefold() else "changed"
        elif c:
            status = "added"
        else:
            status = "removed"
        result.append({
            "principal_id": principal.get("id"), "title": principal.get("title", ""),
            "login": principal.get("login", ""), "email": principal.get("email", ""),
            "kind": principal.get("kind", "other"),
            "external": bool(principal.get("external")), "sharing_link": bool(principal.get("sharing_link")),
            "level": c["level"] if c else "", "parent_level": p["level"] if p else "", "status": status,
        })
    result.sort(key=lambda row: row["title"].casefold())
    return result


def scan(site_input: str, allowed_host: str, token: str, progress=None, cancel_event=None,
         scopes=None, graph_group_members=None, graph_sharing_links=None) -> dict:
    def report(phase: str, **details):
        if cancel_event is not None and cancel_event.is_set():
            raise SharePointScanCancelled("SharePoint scan cancelled.")
        if progress:
            progress({"phase": phase, **details})

    report("Connecting to SharePoint")
    supplied_url = normalize_site_url(site_input, allowed_host)
    parsed = urlsplit(supplied_url)
    parts = [p for p in parsed.path.split("/") if p]
    minimum = 2 if len(parts) >= 2 and parts[0].lower() in ("sites", "teams") else 0
    client = _RestClient(supplied_url, token, cancel_event=cancel_event)
    web = None
    site_url = ""
    # Resolve pasted page/folder links to their nearest real SharePoint web. Unlike the
    # standalone tool's two-segment truncation, this preserves actual sub-sites.
    for count in range(len(parts), minimum - 1, -1):
        report("Opening site")
        candidate_path = "/" + "/".join(parts[:count]) if count else ""
        candidate = f"{parsed.scheme}://{parsed.netloc}{candidate_path}"
        client.site_url = candidate.rstrip("/")
        try:
            web = client.get("/web?$select=Title,Url,ServerRelativeUrl")
            site_url = client.site_url
            break
        except SharePointPermissionsError as exc:
            if exc.status_code != 404:
                raise
    if web is None:
        raise SharePointPermissionsError("Could not find a SharePoint site or sub-site at that address.")
    report("Checking site access")
    web_path = str(web.get("ServerRelativeUrl") or "/")
    can_manage_permissions = None
    try:
        effective = client.get("/web/effectivebasepermissions")
        low = int(effective.get("Low") or 0)
        can_manage_permissions = bool(low & 0x02000000)  # SPBasePermissions.ManagePermissions
    except (SharePointPermissionsError, TypeError, ValueError):
        pass
    report("Listing document libraries")
    roles = client.all("/web/roledefinitions?$select=Id,Name,RoleTypeKind,Hidden")
    libraries_raw = client.all("/web/lists?$select=Id,Title,ItemCount,HasUniqueRoleAssignments,BaseTemplate,Hidden,LastItemModifiedDate,RootFolder/ServerRelativeUrl&$expand=RootFolder&$filter=BaseTemplate eq 101 and Hidden eq false")
    libraries = []
    for lib in libraries_raw:
        title = str(lib.get("Title") or "")
        if title.casefold() in ("form templates", "style library"):
            continue
        root = (lib.get("RootFolder") or {}).get("ServerRelativeUrl") or ""
        libraries.append({
            "id": str(lib.get("Id") or ""), "title": title, "root_url": root,
            "has_unique": bool(lib.get("HasUniqueRoleAssignments")),
            "item_count": int(lib.get("ItemCount") or 0),
            "modified": str(lib.get("LastItemModifiedDate") or ""),
        })
    requested_scopes = [row for row in (scopes or []) if isinstance(row, dict) and row.get("path") and row.get("list_id")]
    if scopes is not None and not requested_scopes:
        raise SharePointPermissionsError("Select at least one valid document folder to scan.")
    if scopes is not None and len(requested_scopes) != len(scopes):
        raise SharePointPermissionsError("One or more selected folders are invalid. Browse and select them again.")
    scope_by_library = {}
    if requested_scopes:
        for scope in requested_scopes:
            lib = next((row for row in libraries if row["id"].casefold() == str(scope["list_id"]).casefold()), None)
            path = str(scope["path"]).rstrip("/")
            root = str(lib["root_url"] or "").rstrip("/") if lib else ""
            if not lib or not root or (path.casefold() != root.casefold() and not path.casefold().startswith(root.casefold() + "/")):
                raise SharePointPermissionsError("A selected folder is outside its document library. Choose folders again.")
            scope_by_library.setdefault(lib["id"], []).append(path)
        # Nested selections are covered by the selected ancestor; scan each path once.
        for list_key, paths in list(scope_by_library.items()):
            normalized = sorted(set(paths), key=lambda value: (value.count("/"), value.casefold()))
            roots = []
            for path in normalized:
                if not any(path.casefold() == root.casefold() or path.casefold().startswith(root.casefold() + "/") for root in roots):
                    roots.append(path)
            scope_by_library[list_key] = roots
        libraries = [lib for lib in libraries if lib["id"] in scope_by_library]
    report("Scanning libraries", libraries_done=0, libraries_total=len(libraries), items_scanned=0,
           current_library="", current_library_items=0, current_library_total=0)

    items_scanned = 0
    candidates = []
    matrix_scopes = [{"library": "(site)", "path": web_path, "display_path": "Site (default)",
                     "type": "Site", "is_unique": True, "grant_ref": ("web", "", 0)}]
    for library_index, lib in enumerate(libraries):
        report("Scanning libraries", libraries_done=library_index, libraries_total=len(libraries),
               items_scanned=items_scanned, current_library=lib["title"], current_library_items=0,
               current_library_total=0 if scope_by_library.get(lib["id"]) else lib["item_count"])
        # Smaller pages report discoveries sooner and keep the progress display lively
        # on large libraries; 2,000 balances update cadence against extra requests.
        selected_roots = scope_by_library.get(lib["id"], [])
        query_params = {"$select": "Id,FileRef,FileSystemObjectType,HasUniqueRoleAssignments,Modified,Editor/Title,Editor/EMail",
                        "$expand": "Editor", "$top": "2000"}
        if selected_roots:
            conditions = []
            for root_path in selected_roots:
                exact = root_path.replace("'", "''")
                prefix = (root_path.rstrip("/") + "/").replace("'", "''")
                conditions.append(f"(FileRef eq '{exact}' or startswith(FileRef,'{prefix}'))")
            query_params["$filter"] = " or ".join(conditions)
        path = f"/web/lists(guid'{lib['id']}')/items?{urlencode(query_params)}"
        def report_item_page(loaded, page_count, page_rows, i=library_index, library=lib):
            preview = []
            for item in page_rows[-8:]:
                item_path = str(item.get("FileRef") or "")
                display_path = item_path
                if web_path and display_path.lower().startswith(web_path.lower()):
                    display_path = display_path[len(web_path):]
                preview.append({
                    "display_path": display_path.strip("/") or library["title"],
                    "library": library["title"],
                    "type": "Folder" if int(item.get("FileSystemObjectType") or 0) == 1 else "File",
                })
            report("Scanning libraries", libraries_done=i, libraries_total=len(libraries),
                   items_scanned=items_scanned + loaded, current_library=library["title"],
                   current_library_items=loaded,
                   current_library_total=0 if scope_by_library.get(library["id"]) else library["item_count"],
                   recent_items=preview)

        items = client.all(path, on_page=report_item_page)
        items_scanned += len(items)
        by_path = {str(item.get("FileRef") or ""): item for item in items}
        # A scoped scan still compares against the nearest secured ancestor above
        # the selected folder. Read only those ancestor list rows as baselines.
        if selected_roots:
            root_path = str(lib["root_url"] or "").rstrip("/")
            ancestor_paths = set()
            for selected_path in selected_roots:
                parent_path = selected_path.rpartition("/")[0]
                while parent_path and len(parent_path) >= len(root_path) and parent_path.casefold().startswith(root_path.casefold()):
                    if parent_path.casefold() != root_path.casefold():
                        ancestor_paths.add(parent_path)
                    if parent_path.casefold() == root_path.casefold():
                        break
                    parent_path = parent_path.rpartition("/")[0]
            for ancestor_path in sorted(ancestor_paths, key=lambda value: value.count("/")):
                if ancestor_path in by_path:
                    continue
                escaped = ancestor_path.replace("'", "''")
                ancestor_query = urlencode({"$select": "Id,FileRef,FileSystemObjectType,HasUniqueRoleAssignments,Modified,Editor/Title,Editor/EMail",
                                            "$expand": "Editor", "$filter": f"FileRef eq '{escaped}'"})
                ancestor_rows = client.all(f"/web/lists(guid'{lib['id']}')/items?{ancestor_query}")
                for ancestor in ancestor_rows:
                    ancestor_ref = str(ancestor.get("FileRef") or "")
                    if ancestor_ref:
                        by_path[ancestor_ref] = ancestor
        list_ref = ("list", lib["id"], 0)
        matrix_scopes.append({"library": lib["title"], "path": lib["root_url"],
                              "display_path": lib["title"], "type": "Library",
                              "is_unique": lib["has_unique"],
                              "grant_ref": list_ref if lib["has_unique"] else ("web", "", 0)})
        if lib["has_unique"]:
            candidates.append({
                "library": lib, "path": lib["root_url"], "ref": ("list", lib["id"], 0),
                "is_folder": True, "is_library_root": True,
                "parent_ref": ("web", "", 0), "parent_path": web_path,
                "modified": lib["modified"], "modified_by": "",
            })
        for item in items:
            item_path = str(item.get("FileRef") or "")
            root = str(lib["root_url"] or "").rstrip("/")
            own_unique = bool(item.get("HasUniqueRoleAssignments"))
            grant_ref = ("item", lib["id"], int(item.get("Id") or 0)) if own_unique else None
            parent_path = item_path.rpartition("/")[0]
            while parent_path and len(parent_path) > len(root) and parent_path.lower().startswith(root.lower()):
                ancestor = by_path.get(parent_path)
                if ancestor and ancestor.get("HasUniqueRoleAssignments"):
                    if grant_ref is None:
                        grant_ref = ("item", lib["id"], int(ancestor.get("Id") or 0))
                    break
                parent_path = parent_path.rpartition("/")[0]
            if grant_ref is None:
                grant_ref = list_ref if lib["has_unique"] else ("web", "", 0)
            display_path = item_path
            if web_path and display_path.lower().startswith(web_path.lower()):
                display_path = display_path[len(web_path):]
            display_path = display_path.strip("/") or lib["title"]
            matrix_scopes.append({
                "library": lib["title"], "path": item_path, "display_path": display_path,
                "type": "Folder" if int(item.get("FileSystemObjectType") or 0) == 1 else "File",
                "is_unique": own_unique, "grant_ref": grant_ref,
            })
            if not own_unique:
                continue
            parent_path = item_path.rpartition("/")[0]
            parent_ref = None
            while parent_path and len(parent_path) > len(root) and parent_path.lower().startswith(root.lower()):
                ancestor = by_path.get(parent_path)
                if ancestor and ancestor.get("HasUniqueRoleAssignments"):
                    parent_ref = ("item", lib["id"], int(ancestor.get("Id") or 0))
                    break
                parent_path = parent_path.rpartition("/")[0]
            if parent_ref is None:
                if lib["has_unique"]:
                    parent_ref, parent_path = list_ref, lib["root_url"]
                else:
                    parent_ref, parent_path = ("web", "", 0), web_path
            candidates.append({
                "library": lib, "path": item_path,
                "ref": ("item", lib["id"], int(item.get("Id") or 0)),
                "is_folder": int(item.get("FileSystemObjectType") or 0) == 1,
                "is_library_root": False, "parent_ref": parent_ref, "parent_path": parent_path,
                "modified": str(item.get("Modified") or ""),
                "modified_by": str((item.get("Editor") or {}).get("Title") or (item.get("Editor") or {}).get("EMail") or ""),
            })
        report("Scanning libraries", libraries_done=library_index + 1, libraries_total=len(libraries),
               items_scanned=items_scanned, current_library=lib["title"],
               current_library_items=len(items), current_library_total=lib["item_count"])

    report("Reading unique permissions", libraries_done=len(libraries), libraries_total=len(libraries),
           items_scanned=items_scanned, permissions_done=0)
    refs = {("web", "", 0)}
    for entry in candidates:
        refs.add(entry["ref"])
        refs.add(entry["parent_ref"])
    assignment_map = {}
    assignment_errors = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(client.assignments, ref): ref for ref in refs}
        permissions_done = 0
        for future in concurrent.futures.as_completed(futures):
            if cancel_event is not None and cancel_event.is_set():
                for pending in futures:
                    pending.cancel()
                raise SharePointScanCancelled("SharePoint scan cancelled.")
            ref = futures[future]
            try:
                assignment_map[ref] = future.result()
            except SharePointPermissionsError as exc:
                # A single secured file/folder can refuse role-assignment reads even
                # when the rest of its site is readable. Keep the audit useful while
                # marking that comparison incomplete instead of implying no access.
                assignment_errors[ref] = str(exc)
            permissions_done += 1
            report("Reading unique permissions", libraries_done=len(libraries), libraries_total=len(libraries),
                   items_scanned=items_scanned, permissions_done=permissions_done,
                   permissions_total=len(futures))

    # Resolve native SharePoint groups and Entra security groups to show indirect
    # user access. Graph expansion uses Hub's existing Directory.Read.All grant.
    site_groups = {}
    for rows in assignment_map.values():
        for principal in rows:
            if principal.get("kind") == "site_group":
                try:
                    group_id = int(principal.get("id") or 0)
                except (TypeError, ValueError):
                    continue
                if group_id > 0:
                    site_groups[group_id] = principal
    group_member_map, group_errors = {}, {}
    if site_groups:
        report("Expanding SharePoint groups", groups_done=0, groups_total=len(site_groups))
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            futures = {pool.submit(client.site_group_members, group_id): group_id for group_id in site_groups}
            groups_done = 0
            for future in concurrent.futures.as_completed(futures):
                group_id = futures[future]
                try:
                    group_member_map[group_id] = future.result()
                except SharePointPermissionsError as exc:
                    group_errors[group_id] = str(exc)
                groups_done += 1
                report("Expanding SharePoint groups", groups_done=groups_done, groups_total=len(site_groups))
        for group_id, principal in site_groups.items():
            members = []
            for member in group_member_map.get(group_id, []):
                login = str(member.get("LoginName") or "")
                ptype = member.get("PrincipalType", 0)
                member_kind = "user" if ptype == 1 else "group" if ptype in (2, 4) else "other"
                members.append({
                    "id": member.get("Id"), "title": str(member.get("Title") or login or "Unknown principal"),
                    "login": login, "email": member.get("Email") or "", "kind": member_kind,
                    "external": "#ext#" in login.lower(), "sharing_link": False,
                    "roles": principal.get("roles", []), "level": principal.get("level", ""),
                    "via_group": principal.get("title", "SharePoint group"),
                })
            principal["members"] = members
            principal["member_read_error"] = group_errors.get(group_id, "")
        for rows in assignment_map.values():
            for principal in rows:
                if principal.get("kind") != "site_group":
                    continue
                try:
                    resolved = site_groups.get(int(principal.get("id") or 0))
                except (TypeError, ValueError):
                    resolved = None
                if resolved and principal is not resolved:
                    principal["members"] = resolved.get("members", [])
                    principal["member_read_error"] = resolved.get("member_read_error", "")

    entra_groups = {}
    for rows in assignment_map.values():
        for principal in rows:
            if principal.get("kind") != "group":
                continue
            match = re.search(r"(?i)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", str(principal.get("login") or ""))
            if match:
                entra_groups[match.group(1).lower()] = principal
    entra_member_map, entra_group_errors = {}, {}
    if entra_groups:
        report("Expanding Entra groups", groups_done=0, groups_total=len(entra_groups))
        if graph_group_members is None:
            for group_id in entra_groups:
                entra_group_errors[group_id] = "Microsoft Graph group expansion is unavailable in this Hub session."
        else:
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                futures = {pool.submit(graph_group_members, group_id): group_id for group_id in entra_groups}
                groups_done = 0
                for future in concurrent.futures.as_completed(futures):
                    group_id = futures[future]
                    try:
                        entra_member_map[group_id] = future.result()
                    except Exception as exc:
                        entra_group_errors[group_id] = str(exc)
                    groups_done += 1
                    report("Expanding Entra groups", groups_done=groups_done, groups_total=len(entra_groups))
        for group_id, principal in entra_groups.items():
            principal["members"] = [{
                "id": member.get("id"),
                "title": str(member.get("displayName") or member.get("userPrincipalName") or "Unknown user"),
                "login": str(member.get("userPrincipalName") or ""),
                "email": str(member.get("mail") or member.get("userPrincipalName") or ""),
                "kind": "user", "external": str(member.get("userType") or "").casefold() == "guest", "sharing_link": False,
                "roles": principal.get("roles", []), "level": principal.get("level", ""),
                "via_group": principal.get("title", "Entra group"),
            } for member in entra_member_map.get(group_id, [])]
            principal["member_read_error"] = entra_group_errors.get(group_id, "")
        for rows in assignment_map.values():
            for principal in rows:
                if principal.get("kind") != "group":
                    continue
                match = re.search(r"(?i)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", str(principal.get("login") or ""))
                resolved = entra_groups.get(match.group(1).lower()) if match else None
                if resolved and principal is not resolved:
                    principal["members"] = resolved.get("members", [])
                    principal["member_read_error"] = resolved.get("member_read_error", "")

    # Link URLs are bearer secrets. Read them only for scopes that already have a
    # detected sharing-link assignment, keep them in this scan response only, and
    # leave persistence/export to explicit user action.
    link_targets = {}
    for entry in candidates:
        ref = entry["ref"]
        if ref[0] != "item" or not any(p.get("sharing_link") for p in assignment_map.get(ref, [])):
            continue
        link_targets[ref] = entry
    link_details, link_detail_errors = {}, {}
    if link_targets:
        report("Reading share link details", link_details_done=0, link_details_total=len(link_targets))
        if graph_sharing_links is None:
            for ref in link_targets:
                link_detail_errors[ref] = "Microsoft Graph link details are unavailable in this Hub session."
        else:
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                futures = {
                    pool.submit(graph_sharing_links, site_url, ref[1], ref[2]): ref
                    for ref in link_targets
                }
                done = 0
                for future in concurrent.futures.as_completed(futures):
                    if cancel_event is not None and cancel_event.is_set():
                        for pending in futures:
                            pending.cancel()
                        raise SharePointScanCancelled("SharePoint scan cancelled.")
                    ref = futures[future]
                    try:
                        link_details[ref] = future.result()
                    except Exception as exc:
                        message = str(exc)
                        if "403" in message:
                            link_detail_errors[ref] = "Graph refused this link detail read (403). Check Hub's Sites.ReadWrite.All consent and your access to this item."
                        elif "401" in message:
                            link_detail_errors[ref] = "Graph sign-in expired or lacks permission. Sign in again and rescan."
                        else:
                            link_detail_errors[ref] = "Graph could not read sharing-link details for this item."
                    done += 1
                    report("Reading share link details", link_details_done=done, link_details_total=len(link_targets))

    site_root = web_path.rstrip("/")
    def grant_key(ref):
        return "|".join(str(part) for part in ref)
    matrix_grants = {}
    for scope in matrix_scopes:
        ref = scope.pop("grant_ref")
        key = grant_key(ref)
        scope["grant_key"] = key
        scope["scan_error"] = assignment_errors.get(ref, "")
        if ref in assignment_map:
            matrix_grants[key] = assignment_map[ref]
    matrix_scopes.sort(key=lambda row: (row["type"] != "Site", row["display_path"].casefold()))
    entries = []
    for entry in candidates:
        own = assignment_map.get(entry["ref"], [])
        parent = assignment_map.get(entry["parent_ref"], [])
        own_error = assignment_errors.get(entry["ref"])
        parent_error = assignment_errors.get(entry["parent_ref"])
        read_error = own_error or parent_error
        diff = _diff(own, parent) if not read_error else []
        diff_counts = {status: sum(1 for row in diff if row["status"] == status) for status in ("added", "removed", "changed")}
        identical = not read_error and not (diff_counts["added"] or diff_counts["removed"] or diff_counts["changed"])
        has_links = any(row["sharing_link"] for row in own)
        display = entry["path"]
        if site_root and display.lower().startswith(site_root.lower()):
            display = display[len(site_root):]
        display = display.strip("/") or entry["library"]["title"]
        parent_display = entry["parent_path"]
        if parent_display.lower() == web_path.lower():
            parent_display = "(site)"
        elif site_root and parent_display.lower().startswith(site_root.lower()):
            parent_display = parent_display[len(site_root):].strip("/") or entry["library"]["title"]
        entries.append({
            "library": entry["library"]["title"], "list_id": entry["library"]["id"],
            "item_id": entry["ref"][2], "kind": entry["ref"][0], "path": entry["path"],
            "display_path": display, "type": "Library" if entry["is_library_root"] else "Folder" if entry["is_folder"] else "File",
            "modified": entry.get("modified", ""), "modified_by": entry.get("modified_by", ""),
            "parent_display_path": parent_display, "assignments": own, "diff": diff, "scan_error": read_error,
            "diff_summary": "Same as parent" if identical else ("Permissions unavailable" if own_error else "Parent permissions unavailable") if read_error else ", ".join(
                f"{diff_counts[k]} {label}" for k, label in (("added", "added"), ("removed", "removed"), ("changed", "changed")) if diff_counts[k]
            ),
            "differs": None if read_error else not identical, "safe_to_reset": bool(not read_error and not entry["is_library_root"] and identical and not has_links),
            "has_direct_users": any(a["kind"] == "user" for a in own),
            "has_group_members": any(a.get("members") for a in own),
            "has_external": any(a["external"] or any(m.get("external") for m in a.get("members", [])) for a in own),
            "has_sharing_links": has_links,
            "sharing_link_details": link_details.get(entry["ref"], []),
            "sharing_link_details_error": link_detail_errors.get(entry["ref"], ""),
        })
    entries.sort(key=lambda row: row["display_path"].casefold())
    report("Finishing report", libraries_done=len(libraries), libraries_total=len(libraries),
           items_scanned=items_scanned, permissions_done=len(refs), permissions_total=len(refs))
    return {
        "site_url": site_url, "site_title": str(web.get("Title") or site_url),
        "scanned_at": _dt.datetime.now().astimezone().isoformat(), "items_scanned": items_scanned,
        "scan_scope": "folders" if requested_scopes else "site",
        "selected_folders": sum(len(paths) for paths in scope_by_library.values()),
        "scan_scopes": [{"list_id": list_id, "path": path}
                        for list_id, paths in scope_by_library.items() for path in paths],
        "permission_errors": len(assignment_errors), "can_manage_permissions": can_manage_permissions,
        "permission_targets": len(refs), "permissions_read": len(assignment_map),
        "site_groups_found": len(site_groups), "site_groups_expanded": len(group_member_map),
        "entra_groups_found": len(entra_groups), "entra_groups_expanded": len(entra_member_map),
        "entra_group_read_errors": len(entra_group_errors),
        "site_group_read_errors": len(group_errors),
        "sharing_link_details_errors": len(link_detail_errors),
        "libraries": libraries, "entries": entries, "matrix_scopes": matrix_scopes,
        "matrix_grants": matrix_grants, "web_assignments": assignment_map.get(("web", "", 0), []),
        "role_definitions": [
            {"id": role.get("Id"), "name": role.get("Name"), "role_type_kind": role.get("RoleTypeKind", 0)}
            for role in roles if not role.get("Hidden") and role.get("RoleTypeKind") != 1
        ],
    }


def export_xlsx(scan_data: dict) -> dict:
    """Build a dependency-free, four-sheet XLSX audit workbook from one scan."""
    entries = scan_data.get("entries") or []
    site = str(scan_data.get("site_title") or scan_data.get("site_url") or "SharePoint site")
    warnings = []
    if scan_data.get("permission_errors"):
        warnings.append(f"{scan_data['permission_errors']} permission reads were denied; comparisons are incomplete.")
    if scan_data.get("site_group_read_errors"):
        warnings.append(f"{scan_data['site_group_read_errors']} SharePoint group reads were denied.")
    if scan_data.get("entra_group_read_errors"):
        warnings.append(f"{scan_data['entra_group_read_errors']} Entra group reads were denied.")
    summary = [
        ["SharePoint permissions audit", site], ["Site URL", scan_data.get("site_url", "")],
        ["Scanned at", scan_data.get("scanned_at", "")], ["Library items scanned", scan_data.get("items_scanned", 0)],
        ["Unique permission scopes", len(entries)],
        ["Scopes differing from parent", sum(1 for e in entries if e.get("differs") is True)],
        ["Scopes with sharing links", sum(1 for e in entries if e.get("has_sharing_links"))],
        ["Permission targets", scan_data.get("permission_targets", 0)],
        ["Permission reads completed", scan_data.get("permissions_read", 0)],
        ["Permission read errors", scan_data.get("permission_errors", 0)],
        ["SharePoint groups expanded", f"{scan_data.get('site_groups_expanded', 0)} / {scan_data.get('site_groups_found', 0)}"],
        ["Entra groups expanded", f"{scan_data.get('entra_groups_expanded', 0)} / {scan_data.get('entra_groups_found', 0)}"],
        ["Manage Permissions", "Unknown" if scan_data.get("can_manage_permissions") is None else "Yes" if scan_data.get("can_manage_permissions") else "No"],
        ["Scan warnings", " ".join(warnings)],
        ["Link URL note", "Sharing-link URLs are intentionally excluded from this workbook."],
    ]
    unique = [["Library", "Type", "Path", "Parent path", "Last modified", "Modified by",
               "Permission difference", "Differs from parent", "Safe to reset", "External access", "Sharing links", "Read warning"]]
    access = [["Library", "Type", "Path", "Principal", "Email", "Principal type", "Access level", "Grant path", "External"]]
    by_person = [["Person or group", "Email or sign-in", "Principal type", "Library", "Type", "Path", "Access level", "Via group", "External"]]
    for entry in entries:
        path_fields = [entry.get("library", ""), entry.get("type", ""), entry.get("display_path", "")]
        unique.append([
            *path_fields, entry.get("parent_display_path", ""), entry.get("modified", ""), entry.get("modified_by", ""),
            entry.get("diff_summary", ""),
            "Yes" if entry.get("differs") is True else "No" if entry.get("differs") is False else "Unknown",
            "Yes" if entry.get("safe_to_reset") else "No", "Yes" if entry.get("has_external") else "No",
            "Yes" if entry.get("has_sharing_links") else "No", entry.get("scan_error", ""),
        ])
        for principal in entry.get("assignments") or []:
            title = principal.get("title") or principal.get("login") or "Unknown principal"
            level = principal.get("level", "")
            external = "Yes" if principal.get("external") else "No"
            access.append([*path_fields, title, principal.get("email", ""), principal.get("kind", ""), level, "Direct grant", external])
            by_person.append([title, principal.get("email") or principal.get("login", ""), principal.get("kind", ""),
                              *path_fields, level, "", external])
            for member in principal.get("members") or []:
                member_title = member.get("title") or member.get("login") or "Unknown member"
                member_level = member.get("level") or level
                via = member.get("via_group") or title
                member_external = "Yes" if member.get("external") else "No"
                access.append([*path_fields, member_title, member.get("email", ""), member.get("kind", ""),
                               member_level, f"Via {via}", member_external])
                by_person.append([member_title, member.get("email") or member.get("login", ""), member.get("kind", ""),
                                  *path_fields, member_level, via, member_external])
    site_path_fields = ["(site)", "Site", "(site)"]
    for principal in scan_data.get("web_assignments") or []:
        title = principal.get("title") or principal.get("login") or "Unknown principal"
        level = principal.get("level", "")
        external = "Yes" if principal.get("external") else "No"
        access.append([*site_path_fields, title, principal.get("email", ""), principal.get("kind", ""), level, "Site grant", external])
        by_person.append([title, principal.get("email") or principal.get("login", ""), principal.get("kind", ""),
                          *site_path_fields, level, "", external])
        for member in principal.get("members") or []:
            member_title = member.get("title") or member.get("login") or "Unknown member"
            member_level = member.get("level") or level
            via = member.get("via_group") or title
            member_external = "Yes" if member.get("external") else "No"
            access.append([*site_path_fields, member_title, member.get("email", ""), member.get("kind", ""),
                           member_level, f"Via {via}", member_external])
            by_person.append([member_title, member.get("email") or member.get("login", ""), member.get("kind", ""),
                              *site_path_fields, member_level, via, member_external])
    sheets = [("Summary", summary), ("Unique permissions", unique), ("Access detail", access), ("By person", by_person)]

    def column_name(number):
        name = ""
        while number:
            number, rem = divmod(number - 1, 26)
            name = chr(65 + rem) + name
        return name

    def cell(ref, value):
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return f'<c r="{ref}"><v>{value}</v></c>'
        text = str(value if value is not None else "")
        text = "".join(c for c in text if c in "\t\n\r" or ord(c) >= 32)
        text = text.encode("utf-8", "replace").decode("utf-8")[:32767]
        return f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{_xml_escape(text)}</t></is></c>'

    content_types = ['<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
                     '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
                     '<Default Extension="xml" ContentType="application/xml"/>',
                     '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>']
    root_rels = ('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                 '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
                 '</Relationships>')
    workbook_sheets, workbook_rels, sheet_files = [], ['<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'], []
    for index, (name, rows) in enumerate(sheets, 1):
        workbook_sheets.append(f'<sheet name="{_xml_escape(name)}" sheetId="{index}" r:id="rId{index}"/>')
        workbook_rels.append(f'<Relationship Id="rId{index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{index}.xml"/>')
        content_types.append(f'<Override PartName="/xl/worksheets/sheet{index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
        rows_xml = []
        for row_num, row in enumerate(rows, 1):
            cells = "".join(cell(f"{column_name(col_num)}{row_num}", value) for col_num, value in enumerate(row, 1))
            rows_xml.append(f'<row r="{row_num}">{cells}</row>')
        sheet_files.append((f"xl/worksheets/sheet{index}.xml",
                            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
                            + "".join(rows_xml) + "</sheetData></worksheet>"))
    content_types.append('</Types>')
    workbook_rels.append('</Relationships>')
    workbook = ('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
                + "".join(workbook_sheets) + "</sheets></workbook>")
    output = BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "".join(content_types))
        archive.writestr("_rels/.rels", root_rels)
        archive.writestr("xl/workbook.xml", workbook)
        archive.writestr("xl/_rels/workbook.xml.rels", "".join(workbook_rels))
        for path, xml in sheet_files:
            archive.writestr(path, xml)
    content = base64.b64encode(output.getvalue()).decode("ascii")
    return {"ok": True, "filename": "sharepoint-permissions.xlsx", "content_base64": content,
            "scope_count": len(entries)}
