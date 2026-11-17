# turbo-browser-mcp

[![CI](https://github.com/Tthanh2k6/turbo-browser-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Tthanh2k6/turbo-browser-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/turbo-browser-mcp)](https://www.npmjs.com/package/turbo-browser-mcp)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

An MCP server for browser automation, built on Playwright. It has 11 tools, and each one does more per call than the usual one-action-per-call design:

- `smart_fill_form` fills a whole form in one call, including React inputs, selects, comboboxes, rich-text editors and file uploads read from disk.
- `inspect_compact` can return only the elements that changed since the last snapshot.
- `batch_actions` runs a list of clicks, key presses, form steps and page reads as one call.

Fewer calls means fewer model turns and less page text replayed in the conversation. The numbers, and their limits, are under [Benchmarks](#benchmarks).

Buttons that look like a final commit (Submit, Send, Publish, Pay, Confirm, and their Korean, Japanese, Chinese and Vietnamese equivalents) are blocked by default, so an agent can prefill a form and leave the last click to a person. Pass `allowSubmit: true` per call or start with `--allow-submit` to turn this off.

The server does not hide that the browser is automated: no stealth patches, no fingerprint changes, no CAPTCHA solving. For sites with a bot check it can hand the tab to a person and continue afterwards ([`wait_for_human`](#handing-a-step-to-a-person-wait_for_human---open-profile)).

## Install

Needs Node 20 or newer and a Chromium-based browser (Chrome, Edge, Brave, or Playwright's Chromium).

Claude Code:

```bash
claude mcp add turbo-browser -- npx -y turbo-browser-mcp
```

Clients that read an `mcpServers` JSON config (Cursor, Claude Desktop, Antigravity and others):

```json
{
  "mcpServers": {
    "turbo-browser": {
      "command": "npx",
      "args": ["-y", "turbo-browser-mcp"],
      "env": { "TURBO_BROWSER_SAVE_ROOT": "/absolute/path/to/workspace" }
    }
  }
}
```

`TURBO_BROWSER_SAVE_ROOT` is the only folder the server may write screenshots, PDFs and storage files to, or read storage files from. Leave it out and the current working directory is used.

Check the setup, and install Chromium if no browser is found:

```bash
npx -y turbo-browser-mcp --doctor
npx playwright-core install chromium
```

By default the server first tries a Chrome that is already listening on `http://127.0.0.1:9222`, so the agent can use a browser you are signed in to, and otherwise launches its own headless Chromium. `--mode`, `--headed` and the other options are listed under [CLI options](#cli-options-and-environment-variables).

From source:

```bash
git clone https://github.com/Tthanh2k6/turbo-browser-mcp.git
cd turbo-browser-mcp
npm install
node src/index.mjs --doctor
```

## Tools

| Tool | Purpose | Key parameters |
| :--- | :--- | :--- |
| `tabs_batch` | Tab and browser lifecycle | `operations[]` (`list`, `open`, `open_many`, `navigate`, `activate`, `resize`, `emulate`, `reload`, `back`, `forward`, `close`, `close_browser`), `isolatedContext`, `concurrency` (1-10) |
| `inspect_compact` | Size-capped snapshot of elements, forms or article text | `mode` (`interactive`, `forms`, `article`, `all`), `onlyChanged`, `query`, `boxes`, `maxChars`, `includeFrames`, `savePath` |
| `smart_fill_form` | Fill a form, editors and file inputs in one call | `fields[]` (`ref`, `selector`, `value`, `option`, `values`, `check`, `not`, `keys`, `file`, `files`, `frameIdx`, `all`), `gmail`, `overwrite`, `stopBeforeSubmit`, `returnSnapshot` |
| `act_fast` | One action on the page | `action` (16 actions), `ref`/`selector`/`text`/`label`/`(x, y)`, `modifiers`, `dropData`, `allowSubmit`, `observeAftermath`, `returnSnapshot` |
| `batch_actions` | Ordered actions, form steps, and multi-page navigate/extract | `steps[]` (including `navigate` with `url`, `extract` with `format`, `selector`, `maxChars`), `continueOnError`, `allowSubmit`, `expect` (`urlMatches`, `textMatches`, `textNew`, `selector`), `submissionKey`, `allowDuplicate`, `observeAftermath`, `returnSnapshot`, `snapshotMaxChars`, `snapshotQuery` |
| `extract_clean_text` | Page text or compact Markdown | `format` (`text`, `markdown`), `selector`, `includeFrames`, `maxChars`, `savePath` |
| `evaluate_js` | JS expression, or a function called with `(el, arg)` | `expression`, `arg`, `frameIdx`, `ref`/`selector`/`text`, `savePath` |
| `page_diagnostics` | Console, network, downloads and dialogs | `level` (`errors`, `all`), `statusFilter` (`errors`, `all`), `includeStatic`, `urlFilter`, `reqId`, `part`, `dialogPolicy`, `clear`, `savePath` |
| `capture_page` | PNG/JPEG screenshot or PDF | `mode` (`screenshot`, `pdf`), `type`, `quality`, `fullPage`, `scale` (`css`, `device`), `ref`/`selector`/`text`, `returnImage`, `savePath` |
| `network_session` | Resource blocking, cookies and storage | `preset` (`turbo`, `no-images`, `no-media`, `clean`), `blockResources`, `blockUrls`, `cookieAction`, `storageAction`, `loadStorageStatePath`, `saveStorageStatePath` |
| `wait_for_human` | Hand a step to a person, resume in the same session | `message`, `urlMatches`, `selector`, `textMatches`, `textGone`, `timeoutMs`, `pollMs` |

The server also sends short `instructions` in the MCP initialize result: batch fields with `smart_fill_form`, chain steps with `batch_actions`, use `onlyChanged` after the first snapshot, and use refs from the latest snapshot.

With `--tools core` (or `TURBO_BROWSER_TOOLS=core`) only `tabs_batch`, `inspect_compact`, `smart_fill_form`, `act_fast`, `batch_actions` and `extract_clean_text` are listed, and calls to the other tools are refused. The default lists all 11.

### Examples

#### Fill a form, attach a PDF from disk, return the result in the same call

```json
{
  "name": "smart_fill_form",
  "arguments": {
    "fields": [
      { "selector": "#full_name", "value": "Alex Nguyen" },
      { "selector": "#email", "value": "alex@example.com" },
      { "selector": "#country", "option": "United States" },
      { "selector": "#skills", "values": ["TypeScript", "Playwright"] },
      { "selector": "#agree_terms", "check": true },
      { "selector": "#resume_pdf", "file": "./assets/resume.pdf" }
    ],
    "stopBeforeSubmit": true,
    "returnSnapshot": true
  }
}
```

#### Read only what changed after opening a modal

```json
{
  "name": "inspect_compact",
  "arguments": {
    "mode": "interactive",
    "onlyChanged": true,
    "maxChars": 3000
  }
}
```

#### Open tabs in parallel in separate cookie contexts

```json
{
  "name": "tabs_batch",
  "arguments": {
    "operations": [
      { "action": "open", "url": "https://example.com/app", "isolatedContext": "acct-a" },
      { "action": "open_many", "urls": ["https://example.com/docs", "https://example.com/pricing"], "concurrency": 4 }
    ]
  }
}
```

#### Allow the final click, check for a receipt, refuse a repeat

```json
{
  "name": "batch_actions",
  "arguments": {
    "steps": [
      { "action": "smart_fill_form", "fields": [{ "selector": "#name", "value": "홍길동" }] },
      { "action": "click", "text": "다음" },
      { "action": "click", "text": "확인" }
    ],
    "allowSubmit": true,
    "expect": { "textMatches": "접수번호\\s*R-\\d+", "timeoutMs": 8000 },
    "submissionKey": "photo-contest:2026-11-15:entry-1"
  }
}
```

#### Extract several pages in one call

```json
{
  "name": "batch_actions",
  "arguments": {
    "steps": [
      { "action": "navigate", "url": "https://example.com/catalog?page=2" },
      { "action": "extract", "format": "text", "selector": "main", "maxChars": 3000 },
      { "action": "navigate", "url": "https://example.com/catalog?page=3" },
      { "action": "extract", "format": "markdown", "selector": "main", "maxChars": 3000 }
    ]
  }
}
```

Navigation uses GET in the same tab and waits for `domcontentloaded`. Each extract step returns the same output as `extract_clean_text` in its step result.

## Behavior notes

- **Connection.** `--mode auto` (default) probes `--cdp http://127.0.0.1:9222` and falls back to launching Chromium. `cdp` attaches to a running browser, `persistent` reuses a `--user-data-dir` profile, `launch` starts a clean session (headless unless `--headed`). The browser is found in the Playwright cache, in system installs of Chrome, Edge, Brave and Chromium, or at `--executable <path>`.
- **Tabs.** `isolatedContext` gives a tab its own cookies and storage. `open_many` opens up to 10 URLs at once. `emulate` sets `colorScheme`, `media`, `reducedMotion`, `contrast`, `forcedColors` or a `userAgent`. In CDP mode an isolated context closes with the process that opened it (and, via the bridge, with its client); tabs another process holds in its own isolated context are listed as `isolatedContext:"other"`.
- **Snapshots.** `inspect_compact` reads the main frame, child iframes (`includeFrames`, `frameIdx`) and open Shadow DOM. With `onlyChanged: true` a `*` before a line marks a ref that is new since the last snapshot, and a `Removed:` line lists refs that went away. An unchanged Submit-like button is still listed so the model knows it exists, and the submit guard still blocks it. `query` filters by regex or substring, `boxes: true` adds `[box=x,y,w,h]`, `maxChars` caps the output, and `savePath` writes the full output to disk.
- **Forms.** `smart_fill_form` handles text-like inputs, `<input type="range">`, checkboxes, radio groups, `<select>` and `<select multiple>`, ARIA comboboxes and switches, `contenteditable` editors, and Gmail compose (`gmail: { to, subject, body }`). Set `all: true` to fill matching controls across frames. `file` and `files` paths go straight to Playwright's `setInputFiles`, so file contents never enter the model's context.
- **Actions.** `act_fast` takes `click`, `dblclick`, `hover`, `focus`, `clear`, `fill`, `type`, `select`, `check`, `uncheck`, `drag`, `drop`, `press`, `scroll`, `wait` and `upload`. A target is a `ref` from the latest snapshot, a CSS `selector`, visible `text`, a `label`, or `(x, y)` coordinates.
- **Settle step.** After a click, double click or key press with `returnSnapshot` or `observeAftermath`, the server waits up to 150 ms for a navigation to start, then for `domcontentloaded` if one did, then until the DOM has been quiet for 80 ms and no request younger than 1.5 s is pending, at most 800 ms. There is no fixed sleep. The result has `outcome`: `navigated` (the URL changed), `changed` (the DOM changed) or `none`.
- **Errors.** A missing ref lists the 3 nearest current refs with labels. An intercepted click names the covering element. A missing `select` option lists up to 5 close options. `fill` reads the value back and adds `mismatch` when the field holds something else (a mask or `maxlength`; a password value is not echoed).
- **`batch_actions`** stops when the submit guard blocks a step, unless `continueOnError` is set.
- **`page_diagnostics`** returns errors only by default. Use `level: "all"`, `statusFilter: "all"` or `includeStatic` for more, and `reqId` with `part` to read one request.
- **`network_session`** presets are `turbo`, `no-images`, `no-media` and `clean` (unblock everything), plus custom `blockResources` and `blockUrls`. It reads, writes and clears cookies and web storage, and saves or loads a Playwright `storageState` file.

## Benchmarks

### Per-tool measurements (`npm run benchmark`)

These come from [`benchmarks/benchmark.mjs`](benchmarks/benchmark.mjs) on local fixture pages in headless Chromium. Tokens are counted with `tiktoken` (`o200k_base`); if Python and `tiktoken` are missing, the script falls back to an approximate count and prints that. The figures measure the size of tool output and the time spent in the browser. Model time is not included, so read them as an upper bound on what an agent gains, not as an agent result.

"Cumulative" tokens model a chat agent that re-reads every earlier tool result on each turn: over N turns, the output of turn i is read N − i + 1 times. Each call saved is also one model round trip.

Timings change from run to run. Character counts, turn counts and token counts do not.

| Scenario | Step-by-step baseline | `turbo-browser-mcp` | Saved |
| :--- | :--- | :--- | :--- |
| 140-button console snapshot (`inspect_compact`) | 61,010 chars HTML (18,654 tok); 12,771 chars full ARIA (3,568 tok) | 3,968 chars (1,135 tok) | 68.2% vs ARIA, 93.9% vs HTML |
| Snapshot after a click (`onlyChanged`) | 12,825 chars full ARIA (3,582 tok) | 168 chars (56 tok) | 98.4% vs ARIA |
| Article to Markdown (`extract_clean_text`) | 10,844 chars HTML (3,595 tok) | 641 chars (156 tok) | 95.7% |
| Diagnostics, 32 requests and 26 console lines | 9,651 chars (3,460 tok, `all`) | 1,761 chars (601 tok, `errors`) | 82.6% |
| 10-field form and check (`smart_fill_form`) | 11 turns, 12,197 tok direct, 72,614 cumulative | 1 turn, 811 tok | 93.4% direct, 98.9% cumulative; 574 ms vs 82 ms |
| 48 KiB PDF upload via `file` | 65,679 chars (44,728 tok) as Base64 | 263 chars (85 tok) disk path | 99.8% |
| 6-step UI flow (`batch_actions`) | 6 turns, 955 tok direct, 3,162 cumulative | 1 turn, 406 tok | 57.5% direct, 87.2% cumulative |
| Open 6 tabs (`open_many`, 60 ms simulated TTFB) | 6 turns, 998 ms | 1 turn, 420 ms | 5 turns fewer |
| Page with 8 images and a font | 9 media requests (304 KiB), 252 ms | 0 media requests with the `turbo` preset, 165 ms | all media bytes |

The table is one run. On the 6-step flow, batching was about as fast as separate calls in that run (357 ms vs 411 ms) and slower in two later runs (0.43x and 0.49x speed). Its gain is in turns and tokens, not wall time.

### Tool schema size

The tool definitions are sent to the model on every turn. `npm run benchmark` prints the size of the current schema (all 11 tools, full and compact) and of the `--tools core` set, plus the server instructions. The figures move with each change to a tool description, so they are not copied here. Run it before and after a schema change; [CONTRIBUTING.md](CONTRIBUTING.md) asks for that in pull requests. `expect`, `submissionKey` and `allowDuplicate` are declared only on `batch_actions`, and the network guard is turned on by environment variable, to keep the schema small.

### Scripted end-to-end task (`npm run benchmark:e2e`)

[`benchmarks/E2E_COMPARISON.md`](benchmarks/E2E_COMPARISON.md) runs a fixed script against a Korean-language contest wizard (6 fields, a `다음` step, a `확인` inside a modal, a receipt page). One action per call with a full ARIA snapshot after each takes 9 calls and 32,942 cumulative context tokens. `inspect_compact` plus one `batch_actions` call with `expect` takes 2 calls and 1,430 tokens, and confirms the receipt number itself. The same file covers the commit-safety cases.

### Agent benchmark against other browser stacks (stage 1)

[`benchmarks/e2e-agent/`](benchmarks/e2e-agent/) gives a coding agent three tasks on local fixture sites (a job application with a file upload, a catalog search over several pages, a booking with a draft step and a confirmation) and runs it with each stack. The fixture server decides success: one committed record with the right fields and file bytes, and a receipt in the answer that matches it. Host agent: Claude Code with Claude Sonnet 5.5, one trial per cell, 16 Nov 2026.

| Stack | Tasks passed | Turns | Cost (USD) | Seconds |
| --- | :---: | ---: | ---: | ---: |
| turbo-browser-mcp 0.6.1 (headless) | 3/3 | 42 | 0.395 | 85.8 |
| agent-browser 0.43.0 (headless) | 3/3 | 33 | 0.440 | 196.8 |
| browse 0.0.17 (headed Chrome, extension) | 3/3 | 20 | 0.237 | 118.6 |
| browser-use 1.0.5 (headed Chrome) | 3/3 | 33 | 0.344 | 120.6 |

Every stack passed every task. turbo-browser-mcp had the lowest total time and browse the lowest cost. One trial per cell cannot rank them, and headless and headed browsers are not equally fast. The application task took turbo-browser-mcp 23 turns, the most of any trial. The transcript showed why: the agent filled each field with a separate `act_fast` call, and `smart_fill_form` could not pick an option that sat behind the list's own search box.

The unreleased `main` branch steers the agent to `smart_fill_form` and was run once more with the same harness: 23 turns, 0.256 USD and 61.6 s in total, down from 42 turns, 0.395 USD and 85.8 s. Still one trial per cell, and the other stacks were not run again. The search-box fix for `smart_fill_form` landed after that run and has not been measured yet. Per-task numbers, how tokens are counted, and the harness fixes made during the run are in [`benchmarks/E2E_RESULTS.md`](benchmarks/E2E_RESULTS.md).

When to keep `chrome-devtools-mcp` as well: it offers Lighthouse audits, performance traces and heap snapshots, which turbo-browser-mcp does not.

## Safety

### Submit guard and file path limits

1. Submit guard (`allowSubmit=false` by default). `smart_fill_form` (with `stopBeforeSubmit: true`), `act_fast` and `batch_actions` check the target element's role and label, Enter in a form, key chords such as `Shift+Enter`, calls to `form.submit()` and `requestSubmit()`, and the same calls made through a same-origin iframe. Final actions that look like `Submit`, `Publish`, `Send`, `Post`, `Apply`, `Confirm` or a payment trigger are blocked unless `allowSubmit: true` is passed or `--allow-submit` is set at startup. Closed Shadow roots that were attached before the server's init script ran (for example on a tab that was already open over CDP) and strict cross-origin sandboxed frames cannot be inspected this way. Actions there fall back to frame handles, coordinates and keyboard input.
2. Path confinement (`TURBO_BROWSER_SAVE_ROOT`). `savePath`, `saveStorageStatePath` and `loadStorageStatePath` work only inside the working directory or `TURBO_BROWSER_SAVE_ROOT`. The check rejects `..` traversal, UNC paths, and symlink and junction tricks before reading or writing.

### Commit checks: `expect`, `submissionKey`, modal and network guards

A label-based guard has three gaps, and each has an opt-in answer. `expect`, `submissionKey` and `allowDuplicate` appear in the `batch_actions` schema; `act_fast` accepts them without advertising them. The network guard is turned on with `TURBO_BROWSER_NETWORK_GUARD=true` and covers `act_fast`, `batch_actions` and `smart_fill_form`.

1. A click that landed is not a confirmed submission: use `expect`. After an allowed submit, pass `expect: { urlMatches?, textMatches?, textNew?, selector?, timeoutMs? }`. `textMatches` also matches text that was already on the page before the click, so prefer `textNew` for verifying a submit: it counts only elements whose text matches and did not match when the batch started. The result carries `submitVerified` and `evidence` (the new URL, a text snippet such as a receipt number, or the matched selector). If nothing shows up in time you get `submitVerified: false` and a reason, so the agent does not report "done" on an empty submission list.
2. A re-run is a second entry, not a retry: use `submissionKey`. With `submissionKey: "portal:2026-11-15:entry-42"`, every allowed submit is appended to a JSONL ledger (`~/.turbo-browser-mcp/submissions.jsonl`, or `TURBO_BROWSER_LEDGER`, or `ledgerPath` inside the save root). A later call with the same key is refused with `blockedBy: "ledger"` unless `allowDuplicate: true`.
3. Labels can be wrong. On many Korean portals the last step reads 다음 and the real commit is a 확인 inside a modal that opens afterwards.
   - Affirmative buttons (`확인`, `OK`, `Yes`, `Confirm`, `確認`, `确定`, `Đồng ý` and others) inside `dialog`, `[role=dialog]`, `[role=alertdialog]` or `[aria-modal=true]` count as commits (`blockedBy: "modal"`). Cookie banners (dialog text mentions cookies) and date or time pickers (the dialog contains a calendar grid or date input) are excluded. A confirmation that only mentions "privacy" or "consent" is still blocked.
   - When an action makes the page call `form.submit()` or `requestSubmit()`, or fire a `submit` event, and the guard stops it, the result says so (`submitSuppressed`, `note`) instead of a bare `ok: true`. The action itself (a select, a check) still counts as done, so batches continue.
   - Common Korean, Japanese, Chinese and Vietnamese submit labels are covered (`제출`, `신청`, `등록`, `결제`, `送信`, `確定`, `提交`, `Hoàn tất` and others), and `다음`, `次へ` and `下一步` are treated like `Next`.
   - `TURBO_BROWSER_NETWORK_GUARD=true` does not depend on labels. While submitting is not allowed, non-GET navigations and same-site `fetch`/XHR `POST`, `PUT`, `PATCH` and `DELETE` are stopped and reported (`blockedBy: "network"`, `networkBlocked[]`). A blocked navigation gets a `204`, so the page and the half-filled form stay put. Let harmless endpoints through with `TURBO_BROWSER_NETWORK_GUARD_ALLOW="/autosave$,/analytics"`. Per call, the undeclared arguments `networkGuard`, `networkGuardAllow` and `networkGuardSettleMs` override the environment values. It is off by default because multi-step wizards often `POST` on every "Next".

Every blocked result says which mechanism stopped it: `blockedBy` is `label`, `modal`, `network` or `ledger`.

   - Second check, report only: a click that starts a `POST`/`PUT`/`PATCH`/`DELETE` fetch or XHR (analytics and telemetry endpoints excluded) while `allowSubmit` is not true gets `possibleSubmit: true` and `request: "POST host"`, because an icon-only button outside a form passes the label and form checks. A request that starts up to 800 ms after the result is attached to the next tool result as `possibleSubmit: ...`. Nothing is blocked after the fact.

Navigation results carry `blocked: "thin"` when the page is a near-empty stub (under 40 words, no login form) that came with HTTP 403/429 or a `noindex` robots meta: a normal browser may see a full page that this one was not given. A normal tiny 200 page is not flagged.

Limits:

- The network guard watches the action plus `networkGuardSettleMs` (250 ms) afterwards, so a commit fired later by a timer is not caught. WebSocket messages, service-worker requests and cross-site `fetch` POSTs are not inspected (cross-site navigations are). Patterns in `TURBO_BROWSER_NETWORK_GUARD_ALLOW` are split on commas, so a pattern cannot contain one.
- The ledger is written only when the call returns. If the call throws after the page already sent the submission (for example a navigation timeout), nothing is recorded. Check the site before re-running.
- An `expect.selector` that is not a valid selector never matches, so the call reports `submitVerified: false` after the timeout.

### Restricting navigation

By default the server can open any URL. To limit where the browser may go, set `TURBO_BROWSER_ALLOW_HOSTS` (or `--allow-hosts a.com,b.com`; the flag wins over the variable). Each entry matches that host and its subdomains, case-insensitively, and `*.example.com` means the same as `example.com`. Spaces and empty entries are ignored. `TURBO_BROWSER_ALLOW_ORIGINS` (or `--allow-origins`) takes exact origins such as `http://localhost:3000`. When both are set, a URL must pass both. With neither set (or only empty entries) nothing changes: no listeners, no request interception and no extra fields in any result.

What is enforced:

- Every URL you pass in (`tabs_batch` `open`, `open_many` and `navigate`, and `navigate` steps in `batch_actions`) is checked before it loads. A denied URL is not requested and that operation fails with `host not allowed: evil.com (TURBO_BROWSER_ALLOW_HOSTS)`. In `open_many` only the denied URL fails.
- Main-frame navigations that no URL input started (link clicks, form submits, script redirects, server redirects, including every hop of a redirect chain) are stopped when they target a disallowed host. The server uses CDP `Fetch` limited to document requests, so the cost is one round trip per document request. The page stays where it was, and the next result for that tab carries `"blocked":"host-not-allowed"` once, with the denied address in `url` (`tabs_batch` results) or `blockedUrl` (other tools). If that result already has a boolean `blocked` from the submit guard, it gets `navBlocked` instead.
- `about:blank`, `data:`, `blob:` and `chrome-error:` are always allowed. `file:` is blocked while a policy is set, as is any scheme other than http and https.

What is not enforced by default: images, scripts, stylesheets, fetch, XHR, WebSocket and other sub-resources load from any host, and iframes are not restricted. This is a navigation allowlist, not a data-exfiltration barrier. Set `TURBO_BROWSER_ALLOW_STRICT=1` (or `--allow-strict`) to also abort sub-resource and iframe requests to disallowed hosts and to wrap `WebSocket`, `EventSource` and `navigator.sendBeacon` in the page. Strict mode is still best effort: page script can restore the original constructors, a document that was already loaded when the guard attached is not wrapped until its next navigation, WebRTC and requests made by service workers or other workers are not covered, and the first request of a popup can start before the guard attaches.

Scope: the guard is installed only on tabs the server opens or acts on. In CDP mode attached to your own Chrome, other tabs are never touched, but a tab you point a tool at (by `tabId`, or the active tab) is guarded from that point on. Treat the setting as a guard rail for an agent, not as a security boundary.

### Handing a step to a person (`wait_for_human`, `--open-profile`)

Some sites fail their bot check whenever the browser is remote-controlled, so a person has to open the same profile in a normal browser first. turbo-browser-mcp does not try to hide automation: no stealth plugins, no fingerprint or `navigator.webdriver` patching, no CAPTCHA solving. It supports two hand-off flows.

1. Before the session: `turbo-browser-mcp --open-profile --url https://site.example/login` opens plain Chrome (no debugging port, no automation flags) on the dedicated profile `~/.turbo-browser-mcp/chrome-profile` (or `--user-data-dir`). The person logs in or passes the check and closes the window. Then start the server with `--user-data-dir <same path>` or `--launch-chrome`, and the agent reuses those cookies. This works for sites that check at login. A site that re-checks on every request will still see an automated browser.
2. During the session: the agent calls `wait_for_human` with a message and a condition (`urlMatches`, `selector`, `textMatches` or `textGone`). The tool brings the tab to the front and polls until the condition holds, then the agent continues in the same tab with the same cookies. Keep `timeoutMs` below your MCP client's request timeout and call it again to keep waiting.

```json
{
  "name": "wait_for_human",
  "arguments": {
    "message": "Please sign in and finish the security check, then leave the tab open.",
    "selector": "#account-menu",
    "timeoutMs": 120000
  }
}
```

## Click aftermath reporting

Set `observeAftermath: true` on `act_fast` or `batch_actions` (or `TURBO_BROWSER_OBSERVE_AFTERMATH=true`) to watch for navigation and mutating fetch/XHR requests after each click: at least 400 ms, longer while the page is still active, at most 800 ms. It is off by default.

The result includes `aftermath: { beforeUrl, afterUrl, navigated, mutatingRequests, unexpectedSubmit }`. Each request lists its method, URL and a `finalSubmit` classification. A main-frame origin or path change, or a commit-like request, produces a warning when `allowSubmit` is false.

This reports an action that has already happened. It cannot prevent a commit or prove that a submission succeeded. Wizard navigation can trigger a warning, and opaque endpoints or requests outside the window can be missed. Use the network guard to prevent and `expect` to verify. Fixture and classification details are in [test/COMMUNITY_FIXTURES.md](test/COMMUNITY_FIXTURES.md).

## CLI options and environment variables

| CLI flag | Environment variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `--mode <auto\|cdp\|persistent\|launch>` | `TURBO_BROWSER_MODE` | `auto` | Connection strategy (`cdp` first, then launch, in `auto`) |
| `--cdp <url>` | `TURBO_BROWSER_CDP_URL` | `http://127.0.0.1:9222` | Chrome DevTools Protocol HTTP endpoint |
| `--user-data-dir <path>` | `TURBO_BROWSER_USER_DATA_DIR` | `""` | Persistent profile directory |
| `--executable <path>` | - | auto-detected | Custom Chromium, Chrome, Edge or Brave executable |
| `--timeout <ms>` | `TURBO_BROWSER_TIMEOUT_MS` | `15000` | Default Playwright action and navigation timeout |
| `--tools <all\|core>` | `TURBO_BROWSER_TOOLS` | `all` | `core` lists only `tabs_batch`, `inspect_compact`, `smart_fill_form`, `act_fast`, `batch_actions`, `extract_clean_text` |
| `--headless` / `--headed` | `TURBO_BROWSER_HEADLESS` | `true` (headless) | Headless or visible browser window (`"false"` for headed) |
| `--allow-submit` | - | `false` | Turn off the default Submit/Publish guard |
| `--allow-hosts <a,b>` | `TURBO_BROWSER_ALLOW_HOSTS` | unset | Only navigate to these hosts and their subdomains (see [Restricting navigation](#restricting-navigation)) |
| `--allow-origins <o,o>` | `TURBO_BROWSER_ALLOW_ORIGINS` | unset | Only navigate to these exact origins; combined with the hosts list when both are set |
| `--allow-strict` | `TURBO_BROWSER_ALLOW_STRICT` | `false` | With an allowlist, also block sub-resource requests to other hosts |
| `--secrets <file>` | `TURBO_BROWSER_SECRETS_FILE` | unset | dotenv file of secrets for `$secret:NAME` placeholders (see [Secrets](#secrets)) |
| `--content-boundaries` | `TURBO_BROWSER_CONTENT_BOUNDARIES` | `false` | Wrap page-sourced text in `<<page:nonce>>` markers (see [Content boundaries](#content-boundaries)) |
| `--print-skill` | - | - | Print the bundled `SKILL.md` for this version |
| `--doctor` | - | - | Print Node, Playwright, Chromium and CDP diagnostics as JSON |
| `--bridge` | `TURBO_BROWSER_BRIDGE_PORT` | `9224` | Start or verify the CDP keep-alive bridge for Chrome 144+ `DevToolsActivePort` (see below) |
| `--launch-chrome` | - | `~/.turbo-browser-mcp/chrome-profile` | Launch Chrome with a dedicated profile and `--remote-debugging-port=9222` |
| `--open-profile [--url <u>]` | `TURBO_BROWSER_OPEN_URL` | `~/.turbo-browser-mcp/chrome-profile` | Open the profile in a normal, non-automated Chrome so a person can log in or pass a check first |
| - | `TURBO_BROWSER_NETWORK_GUARD` | `false` | Turn on the network commit guard by default |
| - | `TURBO_BROWSER_NETWORK_GUARD_ALLOW` | `""` | Comma-separated URL regexes the network guard lets through |
| - | `TURBO_BROWSER_OBSERVE_AFTERMATH` | `false` | Report navigation and mutating requests after each click (see [Click aftermath](#click-aftermath-reporting)) |
| - | `TURBO_BROWSER_LEDGER` | `~/.turbo-browser-mcp/submissions.jsonl` | Submission ledger used by `submissionKey` |
| - | `TURBO_BROWSER_HOME` | `~/.turbo-browser-mcp` | State folder: bridge token files, default ledger, default Chrome profile (`npm test` points it at a temp folder) |
| `--version` / `-v` | - | - | Print the server version |
| `--help` / `-h` | - | - | Print CLI usage |
| - | `TURBO_BROWSER_SAVE_ROOT` | `process.cwd()` | Root directory for `savePath` and `storageState` files |
| - | `PLAYWRIGHT_CORE_PATH` | auto-resolved | Explicit path to `playwright-core/index.mjs` |

### Unattended runs and the Chrome 144+ remote-debugging prompt

In Chrome 136+/144+, enabling `chrome://inspect/#remote-debugging` on the default `User Data` directory makes Chrome show an "Allow remote debugging?" prompt each time a new WebSocket client connects. That stops overnight or multi-agent runs. Two ways around it:

1. `--bridge` (or `npm run bridge`, started automatically when Chrome exposes `DevToolsActivePort`) starts a background process (`src/cdp-bridge.mjs`, `http://127.0.0.1:9224`) that keeps one WebSocket to Chrome open and ignores `Browser.close`. You click Allow once. After that, any number of MCP servers, scripts or subagents can connect and disconnect without another prompt. The bridge keeps a single upstream connection (so the prompt appears once) and gives every connected client its own CDP sessions, so two MCP servers can drive the same Chrome at the same time. Each client sees the same tabs, but its events and one-time page setup are independent.
**Bridge authentication.** The bridge holds a Chrome connection you already approved, so every request must carry a token. Each bridge start generates a random token and stores it in `~/.turbo-browser-mcp/bridge-<port>.json` (mode 0600; on Windows the file inherits your profile folder's permissions, which are normally user-only). turbo clients read it from there; you do nothing. The bridge also rejects any `Host` other than localhost and any `Origin` that is a web page, so a page in your browser cannot reach it. The same bridge is available on its own, for clients that are not turbo (chrome-devtools-mcp, Playwright, Puppeteer), as [cdp-share](https://github.com/Tthanh2k6/cdp-share). A bridge from an older version that has no token is stopped and replaced on the next start, never reused. The daemon refuses to start without a token. `--bridge-insecure` (or `TURBO_BROWSER_BRIDGE_INSECURE=true`) runs it open: then any program on this machine can use your approved Chrome session, cookies included. Limits: another program running as you can read the state file, and so can read the token; the token stops other users, web pages and programs that do not run as you.

2. `--launch-chrome` (or `npm run launch-chrome`) starts Chrome with `--remote-debugging-port=9222` and its own `--user-data-dir` (`~/.turbo-browser-mcp/chrome-profile`). That port needs no confirmation dialog, even on the first connection.

## Secrets

Set `--secrets <file>` (or `TURBO_BROWSER_SECRETS_FILE`) to a dotenv-format file: `KEY=value` lines, `#` comments, optional single or double quotes. The server reads the file itself and never logs or returns its values.

In `smart_fill_form` field values, in `act_fast` `fill` and `type` values, and in `batch_actions` steps, a value that is exactly `$secret:NAME` is replaced by the value of `NAME` at the moment of typing. Anything else is typed as written. An unknown name fails with `Unknown secret: NAME` before anything is typed. Without a secrets file, `$secret:NAME` is typed literally and nothing changes.

Every tool result, every error and every file written through `savePath` has the real value replaced by its placeholder, in raw, JSON-escaped and URL-encoded form. That includes `inspect_compact` input values, `extract_clean_text`, `evaluate_js` results and `page_diagnostics`. Values shorter than 4 characters are not redacted, because that would damage ordinary output. Limits: a page that rewrites or encodes the value (a mask, base64, a hash) produces text the server cannot match, and screenshots are not redacted. The Submit guard is unchanged.

## Content boundaries

Pages can contain text written to look like instructions. With `--content-boundaries` (or `TURBO_BROWSER_CONTENT_BOUNDARIES=1`), page-sourced text is wrapped as `<<page:3f9a1c>> ... <</page:3f9a1c>>`, with a random nonce chosen per server process. This applies to `extract_clean_text`, `inspect_compact` (all modes, one pair per result), `evaluate_js` results, `extract` and `collect` steps in `batch_actions`, and `returnSnapshot` text. Marker-shaped text inside a page is altered so it cannot close the block early. The server instructions gain one sentence naming the markers. The option is off by default and changes nothing when off. On a typical result the markers add about 21 tokens (measured with tiktoken `o200k_base`), plus 39 tokens once in the server instructions. `collect` adds that cost per item.

## Skill for Claude Code

The package ships a short Agent Skill, `skills/turbo-browser/SKILL.md`, that teaches the low-token loop (one `inspect_compact`, then `onlyChanged`; whole forms with one `smart_fill_form`; chained steps; `textNew` to verify a submit). To install it for Claude Code, copy the file into `~/.claude/skills/turbo-browser/`, or run:

```bash
mkdir -p ~/.claude/skills/turbo-browser
npx -y turbo-browser-mcp --print-skill > ~/.claude/skills/turbo-browser/SKILL.md
```

`--print-skill` prints the file that matches the installed version.

## Development

```bash
npm test               # tests in test/*.test.mjs
npm run doctor         # Node, Playwright, Chromium and CDP check
npm run benchmark      # per-tool token and timing benchmark
npm run benchmark:e2e  # scripted wizard task and commit-safety cases
```

CI runs the tests on Ubuntu with Node 20 and 22.

## Known limits

- Portaled comboboxes (react-select, Radix, Headless UI style) have a click path and a keyboard fallback that searches up to 100 options and checks the committed value. Virtualized lists beyond the included fixtures still need testing against real apps.
- Sites with bot detection may need `wait_for_human` and a person to pass the check in the same browser. The server does not bypass those checks.
- The agent benchmark has one trial per stack and task so far. The ten-trial protocol in `benchmarks/E2E_PLAN.md` has not been run.
- The settle step ends as soon as the page is quiet. A request a script fires later than that (for example a timer of several hundred milliseconds) falls outside the click aftermath window of 400 to 800 ms. A page that keeps mutating the DOM (a spinner or ticker) makes the step run to its 800 ms cap.
- The network guard and click aftermath only watch a short window after each action, and do not inspect WebSocket messages or service-worker requests. Details are under [commit checks](#commit-checks-expect-submissionkey-modal-and-network-guards).
- Closed Shadow roots that existed before the server attached to a tab cannot be reached. Actions there fall back to frame handles, coordinates and keyboard input.

## Credits

Several features came from readers of the Show HN post and the dev.to article: johnnylemonny and alexcodebytes (portaled and virtualized selects), eye_java_420f1faa10ae8b86 (keyboard selection and click aftermath), amintacccp (safe submit labels), snake_doc and lukevp (end-to-end comparison, level of abstraction), vidarh (human hand-off), harrysong138759 (receipt verification and duplicate submissions).

## License

[MIT](LICENSE)
