# Changelog

## 0.7.5 (2026-11-26)

Tabs and focus
- Background tabs (`activate: false`) and `--no-focus` (`TURBO_BROWSER_NO_FOCUS`) automatically enable `Emulation.setFocusEmulationEnabled({ enabled: true })` so background pages report `document.hasFocus() === true` and keep rendering.

Redaction
- `--redact-url-params` (`TURBO_BROWSER_REDACT_URL_PARAMS`) masks sensitive URL query and hash parameters (`access_token`, `id_token`, `refresh_token`, `code`, `api_key`, `apikey`, `token`, `secret` by default, or a custom comma-separated list) as `<redacted>` across `inspect_compact`, `tabs_batch`, and `page_diagnostics`. Pass `--no-redact-url-params` or `off` to disable.

Screenshots and registry
- `capture_page` adds server-side `maxWidth` downscaling and `format: "webp" | "jpeg" | "png"` with `quality`.
- Added `mcpName` (`io.github.Tthanh2k6/turbo-browser-mcp`) in `package.json` and updated `server.json` for the Official MCP Registry.

## 0.7.4 (2026-11-26)

Schema and comboboxes
- Trimmed the 11-tool schema to 2,440 tokens and the 6-tool `--tools core` schema to 1,731 tokens (`tiktoken` `o200k_base`) while keeping critical parameter cues.
- `smart_fill_form` fills portaled and virtualized comboboxes (Radix UI / `cmdk`, MUI Autocomplete, Headless UI Combobox, `react-select`, and scrollable `role="listbox"` menus) in one call.

Extraction and pagination
- `batch_actions` `collect` supports multi-page pagination via `nextText` or `nextSelector` with `maxPages`, stopping when the next control is missing or disabled.
- `extract_clean_text` and `batch_actions` `collect` support `format: "table_json"` to parse HTML tables into JSON arrays of row objects.

Actions and connection
- `act_fast` suppresses false `possibleSubmit` warnings on reply and edit buttons that only open an inline editor form, while keeping `possibleSubmit: true` on comment submission POSTs.
- `--mode auto` probes hanging `DevToolsActivePort` WebSocket handshakes and sets `cdpPendingApproval: true` when Chrome 136+ is waiting on the "Allow remote debugging" prompt.
- Added `.gitattributes` enforcing `* text=auto eol=lf`.

## 0.7.3 (2026-11-25)

Snapshots
- `inspect_compact` displays the selected value (`val="..."`) on non-input ARIA comboboxes and `aria-haspopup="listbox"` triggers when it differs from the label, and shows attached filenames on `<input type="file">`.
- `tabs_batch` supports `returnSnapshot: true` (with `snapshotMode`, `snapshotMaxChars`, and `snapshotQuery`).
- When `returnSnapshot: true` lands on a receipt or confirmation page with zero interactive elements (or fewer than two buttons after an allowed submit), the response includes `pageText` automatically.

Actions and waiting
- `act_fast` and `batch_actions` resolve targets by `label` when `ref`, `selector`, and `text` are omitted.
- `batch_actions` `wait` with `textNew` compares against the pre-step baseline so synchronous DOM updates do not time out.
- `expect.textNew` and `wait` with `textNew` ignore text already typed inside `<input>`, `<textarea>`, and `[contenteditable]` editors.
- `batch_actions` `navigate` allows `about:blank`.

Connection
- When `--mode auto` falls back from CDP to a local browser, `"degraded": "headless-fallback"` persists across turns after the one-time `connectionNote` is consumed.

## 0.7.2 (2026-11-20)

Refs
- Cloned fields reject stale refs when swapped inside an unchanged group, and WeakMap owner IDs on enclosing groups and clone containers keep distinct sections separate across reorders (thanks to Renhua Wei / `@dafili` for the [review thread](https://dev.to/tthanh2k6/building-a-faster-playwright-mcp-server-compact-dom-deltas-1-turn-form-filling-and-submit-guards-2o2p#comment-3l9pn)).
- Live counters in field labels, placeholders, and titles stay masked, and accesskey hints appended to `title` after load (`[f]` to `[alt-f]` on Wikipedia) stay ignored in field fingerprints.
- Adding or removing a cloned row keeps refs to untouched clones valid and returns `note: "clone group for <ref> changed size (3 -> 2)"`; swaps inside an unchanged group still fail.

Snapshots
- `inspect_compact` adds `Loading frames: f1,...` to its header when an iframe has no fields yet because its document is still loading.
- Nearby label lookup skips `<script>`, `<style>`, and hidden siblings so an unlabeled input never picks up script source as its label.
- `screenshot` falls back after a short font wait and reports `fontsPending: true` when webfonts keep loading.

Actions
- `act_fast` `select` accepts `option` (matching `smart_fill_form`) and points ARIA comboboxes to `smart_fill_form` instead of failing inside Playwright.
- Actions that open a popup return the registered tab ID as `newTab`.
- Job-link tracking and editor telemetry POSTs do not trigger `possibleSubmit`, while real form submissions still report it.

Tabs and isolation
- Background tool targets keep rendering without activating or changing other tabs.
- `TURBO_BROWSER_ISOLATE_HOSTS` opens matching hosts in isolated browser contexts.
- Closing a tab in an isolated context succeeds when the default context still has one tab left.

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
