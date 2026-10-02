# Prompt: build a feature request / bug board in another app

Paste everything below the line into the other app's AI session.

---

Build an in-app "Issues" board (bug reports and feature requests) in this application. Adapt it to our stack and storage, and keep these behaviors.

## Who can do what
- Anyone signed in can: file an issue, comment, vote (+1 toggle), and watch/unwatch.
- Only super admins can: change status, assign, edit, delete, and manage the e-mail subscriber list.
- After filing, the reporter cannot edit the issue. They can only comment.
- All users see all issues, across every division/tenant. One shared list.

## Data model (one JSON document per issue)
- id, type ("bug" | "feature"), title (required, max ~120 chars), detail (max ~5,000 chars)
- status, reporter {upn, name}, division {id, name}, app version, created_at, updated_at
- assignee {upn, name} or null
- votes: [upn], watchers: [upn]
- comments: [{id, by, upn, text, at, attachments:[...]}]
- history: [{at, by, action, detail}] (status changes, assignment, notifications)
- attachments: [{id, name, type, size, by, at}]. File bytes are stored separately from the JSON document, named by issue id and attachment id.

## Statuses
new -> open -> planned -> in_progress -> done, plus wont_do.
Every newly filed issue starts as "new" (never "open"). Super admins triage it from there.
Imported or legacy items start as "open" so they do not flood the "new" badge.

## List page
- Status chips with counts: Active (everything except done and won't do; the default), New, Open, Planned, In progress, Done, Won't do, All.
- Segmented radio toggle: "Everyone's" | "Mine" (issues I reported, watch, or am assigned).
- Type filter (bug/feature), text search over title and detail, sort (recently updated, newest, most votes, most comments).
- Each row: type icon, title, "opened <ago> by <name> · <division> · assigned to <name>", a status pill, a clickable vote button (thumbs-up + count, highlighted when I voted; clicking toggles and must NOT open the issue), attachment count, comment count.

## Detail page
- Full text, vote and watch buttons, comment thread, attachment gallery (images inline, other files downloadable).
- Super admin controls: status dropdown, assignee picker (directory type-ahead), delete (also deletes the attachment files).
- A comment may contain only attachments (no text); a comment with neither text nor files is rejected.

## New issue window
- Bug/Feature toggle (segmented control, vertically centered), title, details box (full width). Placeholder differs: bug asks for steps/expected/actual; feature asks for the problem and the wanted outcome.
- Attachments: choose files, drag and drop, or paste a screenshot from the clipboard. Thumbnails with a remove button.
- Submit button shows a spinner and what is happening ("Uploading 2 files..."), locks the form while waiting, unlocks on failure.

## Attachment rules (validate server side, never trust the browser)
- Allowed types only: png, jpg, jpeg, gif, webp, bmp, pdf, txt, log, csv. Reject everything else (exe, zip, scripts, no extension).
- Verify magic bytes match the extension (a ".png" that is really an exe is refused); text files must be valid text with no NUL bytes.
- Max 5 MB per file, 5 files per post, 20 per issue.
- Sanitize the file name (strip paths and odd characters).
- If any file in a post is bad, reject the whole post and upload nothing.
- Tagging stored files with metadata is best effort: a missing optional column must never fail the upload.

## Sidebar count badge (Issues menu item)
- Super admins: the number of issues still in "new" status.
- Everyone else: the number of issues they reported/watch/are assigned to that changed since they last opened the Issues page, where the last change was made by someone else (never count your own actions).
- "Last seen" time is stored per account in browser local storage and refreshed when the Issues page opens.
- Refresh on start, every ~60 seconds, on window focus, and after issue actions. A badge failure must never break the page.
- Build the badge code as a small registry (name -> function returning a number) so other menu items can get badges later.

## E-mail notifications
- A super-admin-managed subscriber list (people picked by directory type-ahead) receives new issues and status changes.
- The reporter, assignee, and watchers get updates on their issue.
- Never notify the person who made the change.
- Deliver through a configurable webhook (for example Power Automate "When an HTTP request is received") that sends the e-mail. Do NOT request a mail-send permission in the sign-in scopes: that triggers an admin-consent prompt for every user. Provide a "send test" button.
- Notifications run in a background thread so saving never waits on them.

## Concurrency and safety
- Optimistic concurrency on every issue save (revision counter). On conflict: reload and retry a few times.
- Every API method returns {ok: true, ...} or {ok: false, error}; never raise to the UI.
- Server-side permission checks on every write, independent of what the UI hides.
- Escape all user text when rendering. Limit input sizes.

## Help and tests
- One collapsible help box on the page explaining statuses, who can do what, attachments, and the badge. No explanatory paragraphs elsewhere.
- Offline unit tests for: creation defaults (status "new"), triage permissions, comment/vote/watch toggles, attachment validation (types, magic bytes, sizes, limits, reject-whole-post), delete removing files, badge counts for admin versus normal users, notification recipient rules (never the actor).

First, ask me where issues should be stored (database table, SharePoint list, files) and how users are identified, then implement.
