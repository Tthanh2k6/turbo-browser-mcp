# Changelog

## 0.7.1 (2026-11-18)

Fixes found while using the server on real sites (Gmail, LinkedIn job pages, an ATS form).

Refs
- A ref fails with a clear error after a cross-document navigation instead of resolving on the new page.
- A ref remembers a short text fingerprint, so a virtualized list that reuses the node for another row is refused instead of clicked.
- Form fields keep an identity fingerprint (tag, type, name, id, aria-label, placeholder, role, label text). A recycled input that now belongs to another field is refused. Values never count.

Snapshots
- `inspect_compact` applies `query` inside `selector`.
- `query` matches table/grid rows (`role="row"`) by their whole text, so mail-list rows can be found.
- With a popup or modal open, a `query` still searches the page behind it and marks those lines `[behind popup]`.
- A field whose name or id is generated (UUID, long hex, `:r6:`) is labelled by the question text next to it.
- Links inside an editable area get their own text as the label.

Actions
- `check` on a visually hidden checkbox clicks its label or visible wrapper and verifies the state changed.
- `possibleSubmit` no longer fires for Gmail's background RPCs (presence, suggestions, people lookups) or its sync call. A real send is still reported.
- Page-view and analytics beacons, ping requests and ad beacons are not `possibleSubmit`.

Tabs and text
- `tabs_batch` `navigate` on another tab no longer makes it the default tab unless `activate: true`.
- `extract_clean_text`: on a small `maxChars` the URL/title header shrinks so most of the budget is content. The total still stays within `maxChars`.

## 0.7.0

See the GitHub release.
