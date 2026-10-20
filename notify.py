"""Who hears about an issue event, and how the message is delivered.

Delivery, in order of preference:
  1. The active division's SMTP relay (Settings > General > SMTP mail), when enabled.
  2. A webhook (Settings > Integrations > Notifications > "Notification webhook"): the app POSTs JSON
     {event, to[], subject, text, html, issue{...}} and a Power Automate flow (or similar) sends the e-mail / Teams message.
     This needs NO extra Microsoft Graph permission.
  3. Direct e-mail through Microsoft Graph (/me/sendMail) - only if the signed-in token ALREADY carries Mail.Send. The app never
     asks for that permission (it would trigger an admin-consent prompt for every user).
If neither is available nothing is sent and the issue's history says so. Failures never raise.
"""
from __future__ import annotations

import html as _html
from email.message import EmailMessage
import smtplib
import ssl

import requests

import issues as _iss

SUBJECT = {"new": "New {kind}", "status": "{kind} updated", "comment": "New comment on {kind}"}
DIVISION_EVENTS = ("new", "status", "comment", "boneyard", "sharepoint", "software", "device", "inventory", "ot")
DIVISION_EVENT_LABELS = {"new": "New issue", "status": "Issue status changes", "comment": "Issue comments",
                        "boneyard": "Boneyard device moves", "sharepoint": "SharePoint permission changes",
                        "software": "Not allowed software policy changes", "device": "Device checkout and return",
                        "inventory": "Inventory and data quality alerts", "ot": "OT asset review reminders"}


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


def division_subscribers_doc(doc) -> list:
    """Clean division-scoped recipients and event choices."""
    out, seen = [], set()
    for s in (doc or []):
        if not isinstance(s, dict):
            continue
        upn = str(s.get("upn") or "").strip().lower()
        if "@" not in upn or upn in seen:
            continue
        seen.add(upn)
        events = list(dict.fromkeys(e for e in (s.get("events") or []) if e in DIVISION_EVENTS))
        out.append({"upn": upn, "name": str(s.get("name") or upn)[:80], "events": events})
    return out


def division_recipients(subscribers: list, event: str) -> list:
    return [{"upn": s["upn"], "name": s["name"]} for s in subscribers if event in s["events"]]


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
    short = _iss.short_id(issue.get("id", ""))
    division = (issue.get("division") or {}).get("name", "")
    reporter = (issue.get("reporter") or {}).get("name", "")
    event_title = SUBJECT[event].format(kind=kind).capitalize()
    subject = f"[NBG Hub] {event_title} {short}: {issue.get('title', '')}"[:200]
    lines = [f"{issue.get('title', '')}", f"{event_title} · {short}", f"Type: {kind}   Status: {status}   Division: {division}",
             f"Reported by {reporter}"]
    if event == "comment":
        lines.append(f"{actor_name} commented:\n{extra}")
    elif event == "status":
        asg = (issue.get("assignee") or {}).get("name")
        lines.append(f"Updated by {actor_name}. Now: {status}" + (f" · Assigned to {asg}" if asg else ""))
    elif event == "new" and issue.get("detail"):
        lines.append(issue["detail"][:1500])
    lines.append(f"Open NBG Hub > Issues and search for {short} to view or reply.")
    text = "\n".join(lines)
    esc = _html.escape
    status_color = "#166534" if issue.get("status") in ("done", "closed") else "#92400e"
    status_bg = "#dcfce7" if issue.get("status") in ("done", "closed") else "#fef3c7"
    detail = ""
    if event == "new" and issue.get("detail"):
        detail = f"<div style=\"margin:20px 0;padding:16px 18px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;white-space:pre-line;line-height:1.6;color:#334155\">{esc(issue['detail'][:1500])}</div>"
    elif event == "comment" and extra:
        detail = ("<div style=\"margin:20px 0;padding:16px 18px;background:#f8fafc;border-left:4px solid #0b7a3b;border-radius:8px\">"
                  f"<div style=\"font-size:12px;color:#64748b;margin-bottom:7px\">{esc(actor_name)} commented</div>"
                  f"<div style=\"white-space:pre-line;line-height:1.6;color:#334155\">{esc(extra)}</div></div>")
    elif event == "status":
        assignee = (issue.get("assignee") or {}).get("name") or "Unassigned"
        detail = ("<div style=\"margin:20px 0;padding:14px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;line-height:1.6;color:#334155\">"
                  f"Updated by <b>{esc(actor_name)}</b><br>Current assignee: <b>{esc(assignee)}</b></div>")
    body = ("<!doctype html><html><body style=\"margin:0;padding:0;background:#eef3f1;font-family:Segoe UI,Arial,sans-serif;color:#15231f\">"
            "<div style=\"max-width:680px;margin:28px auto;padding:0 14px\"><div style=\"overflow:hidden;border:1px solid #d7e2dd;border-radius:14px;background:#fff;box-shadow:0 8px 26px rgba(15,35,29,.08)\">"
            "<div style=\"padding:22px 26px;background:#17382f;color:#fff\"><div style=\"font-size:12px;letter-spacing:1.2px;color:#a7f3d0;font-weight:700\">NBG HUB · ISSUES</div>"
            f"<div style=\"font-size:20px;font-weight:700;margin-top:8px\">{esc(event_title)}</div></div>"
            f"<div style=\"padding:26px\"><div style=\"font-size:11px;font-weight:700;letter-spacing:.7px;color:#64748b\">ISSUE {esc(short)}</div>"
            f"<h1 style=\"font-size:23px;line-height:1.3;margin:7px 0 16px;color:#10251e\">{esc(issue.get('title', ''))}</h1>"
            f"<div style=\"margin-bottom:20px\"><span style=\"display:inline-block;padding:5px 11px;border-radius:999px;background:{status_bg};color:{status_color};font-size:12px;font-weight:700\">{esc(status)}</span>"
            f"<span style=\"margin-left:8px;color:#64748b;font-size:13px\">{esc(kind.title())}</span></div>"
            "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" style=\"width:100%;border-collapse:collapse;background:#f8fafc;border:1px solid #e2e8f0;border-radius:9px\"><tr>"
            f"<td style=\"padding:12px 14px;width:50%;vertical-align:top\"><div style=\"font-size:11px;color:#64748b\">DIVISION</div><div style=\"font-size:13px;font-weight:600;margin-top:4px\">{esc(division or '—')}</div></td>"
            f"<td style=\"padding:12px 14px;width:50%;vertical-align:top;border-left:1px solid #e2e8f0\"><div style=\"font-size:11px;color:#64748b\">REPORTED BY</div><div style=\"font-size:13px;font-weight:600;margin-top:4px\">{esc(reporter or '—')}</div></td></tr></table>"
            f"{detail}<div style=\"margin-top:22px;padding-top:16px;border-top:1px solid #e2e8f0;color:#475569;font-size:13px;line-height:1.6\">Open NBG Hub &gt; Issues and search for <b>{esc(short)}</b> to view the full report and reply.</div>"
            "</div><div style=\"padding:14px 26px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#64748b;font-size:11px\">Sent by NBG Hub. Replies are not monitored; respond in the app.</div>"
            "</div></div></body></html>")
    return subject, text, body


def render_notice(division: str, title: str, detail: str, event: str) -> tuple:
    """Polished HTML + readable plain text for a division operational notice."""
    subject = f"[NBG Hub] {title} — {division}"[:200]
    text = f"{title}\nDivision: {division}\n\n{detail}\n\nOpen NBG Hub to review."
    body = ("<!doctype html><html><body style=\"margin:0;background:#f1f5f9;font-family:Segoe UI,Arial,sans-serif;color:#0f172a\">"
            "<div style=\"max-width:680px;margin:28px auto;padding:0 16px\"><div style=\"background:#12372f;color:#fff;padding:20px 24px;border-radius:12px 12px 0 0\">"
            "<div style=\"font-size:12px;letter-spacing:1px;color:#a7f3d0;font-weight:700\">NBG HUB · " + _html.escape(division) + "</div>"
            "<div style=\"font-size:20px;font-weight:700;margin-top:8px\">" + _html.escape(title) + "</div></div>"
            "<div style=\"background:#fff;padding:24px;border:1px solid #dbe5e1;border-top:0;border-radius:0 0 12px 12px\">"
            "<div style=\"white-space:pre-line;line-height:1.6;color:#334155\">" + _html.escape(detail) + "</div>"
            "<div style=\"margin-top:22px;color:#64748b;font-size:12px\">Sent by NBG Hub · " + _html.escape(DIVISION_EVENT_LABELS.get(event, event)) + "</div></div></div></body></html>")
    return subject, text, body


def _send_smtp(settings: dict, emails: list, subject: str, text: str, body_html: str) -> dict:
    msg = EmailMessage()
    msg["From"] = settings["from_address"]
    msg["To"] = ", ".join(emails)
    msg["Subject"] = subject
    msg.set_content(text)
    msg.add_alternative(body_html, subtype="html")
    try:
        security = settings["security"]
        context = ssl.create_default_context()
        if security == "ssl":
            client = smtplib.SMTP_SSL(settings["server"], settings["port"], timeout=15, context=context)
        else:
            client = smtplib.SMTP(settings["server"], settings["port"], timeout=15)
        with client as smtp:
            smtp.ehlo()
            if security == "starttls":
                smtp.starttls(context=context)
                smtp.ehlo()
            refused = smtp.send_message(msg, to_addrs=emails)
        sent = len(emails) - len(refused)
        if sent:
            return {"sent": sent, "via": "smtp", "error": "" if not refused else f"SMTP refused {len(refused)} recipient(s)."}
        return {"sent": 0, "via": "smtp", "error": "The SMTP server refused all recipients."}
    except Exception as e:
        return {"sent": 0, "via": "smtp", "error": f"SMTP could not send ({type(e).__name__}). Check server, port, security, and relay access."}


def deliver(gc, to: list, subject: str, text: str, body_html: str, event: str, issue: dict) -> dict:
    """Send once to all `to`. Returns {"sent": n, "via": "webhook"|"mail"|"", "error": str}."""
    emails = [r["upn"] for r in to]
    if not emails:
        return {"sent": 0, "via": "", "error": ""}
    if getattr(gc, "data_mode", "live") == "local":
        return {"sent": 0, "via": "", "error": "Local data mode: nothing is sent."}
    try:
        import settings_catalog as sc
        smtp_settings = sc.clean_smtp_settings(gc.division_prefs().get("smtp"))
    except ValueError as e:
        return {"sent": 0, "via": "smtp", "error": f"Invalid SMTP settings: {e}"}
    if smtp_settings["enabled"]:
        return _send_smtp(smtp_settings, emails, subject, text, body_html)
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
    return {"sent": 0, "via": "", "error": "No way to send e-mail is set up yet (configure SMTP under Settings > General, a webhook under Settings > Integrations, or grant Mail.Send)."}
