"""Who hears about an issue event, and how the message is delivered.

Delivery, in order of preference:
  1. A webhook (Settings > Integrations > Notifications > "Notification webhook"): the app POSTs JSON
     {event, to[], subject, text, html, issue{...}} and a Power Automate flow (or similar) sends the e-mail / Teams message.
     This needs NO extra Microsoft Graph permission.
  2. Direct e-mail through Microsoft Graph (/me/sendMail) - only if the signed-in token ALREADY carries Mail.Send. The app never
     asks for that permission (it would trigger an admin-consent prompt for every user).
If neither is available nothing is sent and the issue's history says so. Failures never raise.
"""
from __future__ import annotations

import html as _html

import requests

import issues as _iss

SUBJECT = {"new": "New {kind}", "status": "{kind} updated", "comment": "New comment on {kind}"}


def subscribers_doc(doc) -> list:
    """Clean list of {upn, name, events[]} from the stored subscribers document."""
    out, seen = [], set()
    for s in ((doc or {}).get("subscribers") or []):
        upn = str((s or {}).get("upn") or "").strip().lower()
        if "@" not in upn or upn in seen:
            continue
        seen.add(upn)
        ev = [e for e in (s.get("events") or []) if e in _iss.EVENTS] or list(_iss.EVENTS)
        out.append({"upn": upn, "name": str(s.get("name") or upn)[:80], "events": ev})
    return out


def recipients(issue: dict, event: str, subs: list, actor_upn: str = "") -> list:
    """Subscribers for this event + the reporter, assignee and watchers (for status/comment), never the person who acted."""
    actor = (actor_upn or "").lower()
    out, seen = [], set()

    def add(upn, name=""):
        u = (upn or "").strip().lower()
        if u and "@" in u and u != actor and u not in seen:
            seen.add(u)
            out.append({"upn": u, "name": name or u})
    for s in subs:
        if event in s["events"]:
            add(s["upn"], s["name"])
    if event in ("status", "comment"):
        rep = issue.get("reporter") or {}
        add(rep.get("upn"), rep.get("name"))
        asg = issue.get("assignee") or {}
        add(asg.get("upn"), asg.get("name"))
        for w in issue.get("watchers") or []:
            add(w)
    return out


def render(issue: dict, event: str, actor_name: str, extra: str = "") -> tuple:
    kind = "bug" if issue.get("type") == "bug" else "feature request"
    status = dict(_iss.STATUSES).get(issue.get("status"), issue.get("status", ""))
    subject = f"[NBG Hub] {SUBJECT[event].format(kind=kind).capitalize()} {_iss.short_id(issue['id'])}: {issue.get('title', '')}"[:200]
    lines = [f"{issue.get('title', '')}", f"Type: {kind}   Status: {status}   Division: {(issue.get('division') or {}).get('name', '')}",
             f"Reported by {(issue.get('reporter') or {}).get('name', '')}"]
    if event == "comment":
        lines.append(f"{actor_name} commented: {extra}")
    elif event == "status":
        asg = (issue.get("assignee") or {}).get("name")
        lines.append(f"Updated by {actor_name}. Now: {status}" + (f", assigned to {asg}" if asg else ""))
    elif event == "new" and issue.get("detail"):
        lines.append(issue["detail"][:1500])
    lines.append("Open NBG Hub > Issues to read and reply.")
    text = "\n".join(lines)
    body = "".join(f"<p>{_html.escape(l)}</p>" for l in lines)
    return subject, text, body


def deliver(gc, to: list, subject: str, text: str, body_html: str, event: str, issue: dict) -> dict:
    """Send once to all `to`. Returns {"sent": n, "via": "webhook"|"mail"|"", "error": str}."""
    emails = [r["upn"] for r in to]
    if not emails:
        return {"sent": 0, "via": "", "error": ""}
    if getattr(gc, "data_mode", "live") == "local":
        return {"sent": 0, "via": "", "error": "Local data mode: nothing is sent."}
    try:
        import settings_catalog as sc
        url = sc.clean_url(gc.get_setting("notify_webhook_url", ""))
    except Exception:
        url = ""
    if url:
        try:
            r = requests.post(url, json={"event": event, "to": emails, "subject": subject, "text": text, "html": body_html,
                                         "issue": {"id": issue.get("id"), "short": _iss.short_id(issue.get("id", "")), "title": issue.get("title"),
                                                   "type": issue.get("type"), "status": issue.get("status")}}, timeout=15)
            if r.status_code < 300:
                return {"sent": len(emails), "via": "webhook", "error": ""}
            return {"sent": 0, "via": "webhook", "error": f"The notification webhook answered {r.status_code}."}
        except Exception as e:
            return {"sent": 0, "via": "webhook", "error": f"The notification webhook could not be reached ({type(e).__name__})."}
    try:
        if gc.can_send_mail():
            msg = {"message": {"subject": subject, "body": {"contentType": "HTML", "content": body_html},
                               "toRecipients": [{"emailAddress": {"address": e}} for e in emails]}, "saveToSentItems": False}
            from graph import GRAPH
            r = gc._req("POST", f"{GRAPH}/me/sendMail", json=msg)
            return {"sent": len(emails), "via": "mail", "error": "" if r.status_code < 300 else f"Mail answered {r.status_code}."}
    except Exception as e:
        return {"sent": 0, "via": "mail", "error": f"Mail could not be sent ({type(e).__name__})."}
    return {"sent": 0, "via": "", "error": "No way to send e-mail is set up yet (add a notification webhook in Settings > Integrations)."}
