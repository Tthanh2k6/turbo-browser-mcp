# turbo-browser-mcp

[![CI](https://github.com/Tthanh2k6/turbo-browser-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Tthanh2k6/turbo-browser-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/turbo-browser-mcp)](https://www.npmjs.com/package/turbo-browser-mcp)
![Tests](https://img.shields.io/badge/tests-437%20passing-brightgreen)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

An MCP server for browser automation, built on Playwright. It has 11 tools where `@playwright/mcp` has 25 and `chrome-devtools-mcp` has 33, and each tool does more per call:

- one `smart_fill_form` call fills a whole form, including React inputs, selects, comboboxes, rich-text editors and file uploads read from disk;
- `inspect_compact` can return only the elements that changed since the last snapshot;
- `batch_actions` runs a list of clicks, key presses and form steps as one call.

Fewer calls means fewer model turns and less page text replayed in the conversation. The numbers are in [Benchmarks](#benchmarks).

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

| Tool | Purpose | Key Parameters |
| :--- | :--- | :--- |
| `tabs_batch` | Ordered tab & browser lifecycle | `operations[]` (`list`, `open`, `open_many`, `navigate`, `activate`, `resize`, `emulate`, `reload`, `back`, `forward`, `close`, `close_browser`), `isolatedContext`, `concurrency` (1-10) |
| `inspect_compact` | Token-capped element/form/article snapshot | `mode` (`interactive`, `forms`, `article`, `all`), `onlyChanged`, `query`, `boxes`, `maxChars`, `includeFrames`, `savePath` |
| `smart_fill_form` | Batch form, editor & disk file prefill | `fields[]` (`ref`, `selector`, `value`, `option`, `values`, `check`, `not`, `keys`, `file`, `files`, `frameIdx`, `all`), `gmail`, `overwrite`, `stopBeforeSubmit`, `returnSnapshot` |
| `act_fast` | Single targeted page action | `action` (`16` actions), `ref`/`selector`/`text`/`label`/`(x, y)`, `modifiers`, `dropData`, `allowSubmit`, `observeAftermath`, `returnSnapshot` |
| `batch_actions` | Ordered actions, form steps and multi-page navigate/extract | `steps[]` (including `navigate` with `url`, `extract` with `format`, `selector`, `maxChars`), `continueOnError`, `allowSubmit`, `expect`, `submissionKey`, `allowDuplicate`, `observeAftermath`, `returnSnapshot`, `snapshotMaxChars` |
| `extract_clean_text` | Clean text or compact Markdown reader | `format` (`text`, `markdown`), `selector`, `includeFrames`, `maxChars`, `savePath` |
| `evaluate_js` | Scoped JS expression or `(el, arg)` call | `expression`, `arg`, `frameIdx`, `ref`/`selector`/`text`, `savePath` |
| `page_diagnostics` | Console, network, downloads & dialogs | `level` (`errors`, `all`), `statusFilter` (`errors`, `all`), `includeStatic`, `urlFilter`, `reqId`, `part`, `dialogPolicy`, `clear`, `savePath` |
| `capture_page` | PNG/JPEG screenshots & PDF export | `mode` (`screenshot`, `pdf`), `type`, `quality`, `fullPage`, `scale` (`css`, `device`), `ref`/`selector`/`text`, `returnImage`, `savePath` |
| `network_session` | Resource blockers, cookies & storage | `preset` (`turbo`, `no-images`, `no-media`, `clean`), `blockResources`, `blockUrls`, `cookieAction`, `storageAction`, `loadStorageStatePath`, `saveStorageStatePath` |
| `wait_for_human` | Hand a step to a person, resume in the same session | `message`, `urlMatches`, `selector`, `textMatches`, `textGone`, `timeoutMs`, `pollMs` |

The server also sends short `instructions` in the MCP initialize result (about 46 tokens): batch fields with `smart_fill_form`, chain steps with `batch_actions`, use `onlyChanged` after the first snapshot, and use refs from the latest snapshot.

With `--tools core` (or `TURBO_BROWSER_TOOLS=core`) only `tabs_batch`, `inspect_compact`, `smart_fill_form`, `act_fast`, `batch_actions` and `extract_clean_text` are listed, and calls to the other tools are refused. The default still lists all 11.

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

## What each tool does

### Connection and sessions (`tabs_batch`)
- 4 connection modes (`--mode auto|cdp|persistent|launch`):
  - `auto` (default): probes `--cdp http://127.0.0.1:9222` first so agents can reuse an existing signed-in browser session, then falls back to launching Chromium.
  - `cdp`: attach directly to a running Chromium/Chrome/Edge remote debugging port.
  - `persistent`: launch with a reusable `--user-data-dir` profile across runs.
  - `launch`: start a clean browser session (`--headless` by default, or `--headed`).
- Auto binary discovery (`src/playwright-loader.mjs`): checks `playwright-core` cache revisions across Windows, macOS, and Linux, system installs of Google Chrome, Microsoft Edge, Brave, and Chromium, or an explicit `--executable <path>`.
- Per-tab isolation (`tabs_batch`): open tabs inside named `isolatedContext` sandboxes with separate cookies and storage, batch-open up to 10 concurrent URLs (`open_many`), activate, reload, go `back`/`forward`, `resize` viewport, and emulate `colorScheme`, `media`, `reducedMotion`, `contrast`, `forcedColors`, or custom `userAgent`.

### Page snapshots (`inspect_compact`)
- Snapshot modes: `interactive`, `forms`, `article`, and `all`.
- Cross-boundary traversal: flattens main frame DOM, child iframes (`includeFrames`, `frameIdx`), and open Shadow DOM. Injects an init script hooking `Element.prototype.attachShadow` (`WeakMap` + `WeakRef`/`FinalizationRegistry` + `window.__tbmGetShadowRoot`) to keep post-init closed Shadow roots inspectable and guarded, traverses `<slot>` `assignedNodes({ flatten: true })`, and supports Form-Associated Custom Elements.
- Token controls: `onlyChanged: true` emits only elements added or changed since the prior snapshot (a `*` before a line marks a ref that is new since then, and a `Removed:` line lists refs that went away; an unchanged Submit-like button is still listed so the model knows it exists, and the submit guard still blocks it); `query` filters by regex or substring; `boxes: true` adds `[box=x,y,w,h]` only when needed; `maxChars` caps payload size; `savePath` writes full output to disk.

### Forms in one call (`smart_fill_form`)
Prefills an entire form in one MCP call while flushing microtasks and macrotasks between controlled inputs:
- Standard & framework inputs: text, email, password, number, date, textarea, `<input type="range">`, checkboxes, radio groups (`check`, `not`, `overwrite`). Triggers React-controlled state updates via native property setters and synthetic events.
- Selects & custom widgets: `<select>` and `<select multiple>` (`option` / `values`), ARIA comboboxes, ARIA switches, `contenteditable` rich editors, and Gmail compose dialogs (`gmail: { to, subject, body }`).
- Frame & wildcard targeting: target specific iframes via `frameIdx`, or set `all: true` to populate matching controls across frames.
- Direct disk uploads: pass `file` or `files` paths directly to Playwright `setInputFiles` without loading binary files or Base64 strings into LLM context.
- Atomic verification: pass `returnSnapshot: true` to inspect the updated form state in the same tool response.

### Actions and chains (`act_fast`, `batch_actions`)
- `act_fast` actions: `click`, `dblclick`, `hover`, `focus`, `clear`, `fill`, `type` (`slowly`, `delayMs`, `submit`), `select`, `check`, `uncheck`, `drag`, `drop` (`file`, `files`, or custom MIME `dropData`), `press` (`key` + `modifiers`: `Alt`, `Control`, `ControlOrMeta`, `Meta`, `Shift`), `scroll` (`dx`, `dy`), `wait` (`ms`, `state`, `loadState`, `text`, `textGone`, `url`), and `upload`.
- Targeting options: compact `[eN]` `ref`, CSS `selector`, visible `text`, `label`, or viewport `(x, y)` coordinates, with `button` (`left`, `right`, `middle`) and `frameIdx`.
- Settle step: after a click, double click or key press with `returnSnapshot` or `observeAftermath`, the server waits up to 150 ms for a navigation to start, then for `domcontentloaded` if one did, then until the DOM has been quiet for 80 ms and no request younger than 1.5 s is pending, at most 800 ms. There is no fixed sleep. The result has `outcome`: `navigated` (the URL changed), `changed` (the DOM changed) or `none`.
- Recoverable errors: a missing ref lists the 3 nearest current refs with labels; an intercepted click names the covering element; a missing `select` option lists up to 5 closest options; `fill` reads the value back and adds `mismatch` when the field holds something else (a mask or `maxlength`; a password value is not echoed).
- `batch_actions`: runs an ordered list of DOM actions, nested `smart_fill_form` steps, and `navigate`/`extract` steps for multi-page reading in one MCP call, stopping safely if blocked by the Submit guard or optionally continuing on step errors (`continueOnError`).

### Text, JavaScript and screenshots (`extract_clean_text`, `evaluate_js`, `capture_page`)
- `extract_clean_text`: extracts readable plain text or compact Markdown (`format: "text" | "markdown"`) from main/article containers and iframes, stripped of script and style noise.
- `evaluate_js`: runs JS expressions or `(el, arg)` element functions in any frame (`frameIdx`) with JSON-serialized results and optional `savePath` export.
- `capture_page`: full-page or element-scoped screenshots (`png` or `jpeg` with `quality`, `css` or `device` scale, optional `returnImage`) and PDF generation saved to a confined `savePath`.

### Network, storage and diagnostics (`network_session`, `page_diagnostics`)
- `network_session` presets: `turbo`, `no-images`, `no-media`, and `clean` (unblock all), alongside custom `blockResources` and `blockUrls` patterns.
- Session & storage management: read/write/clear browser `cookies`, `localStorage`/`sessionStorage`, and export or reload full Playwright `storageState` JSON files (`saveStorageStatePath`, `loadStorageStatePath`).
- `page_diagnostics`: defaults to errors-only (`level: "errors"`, `statusFilter: "errors"`) to surface failures cleanly without flooding context, while supporting `all`, `includeStatic`, `urlFilter`, deep request/response inspection (`reqId` + `part`), completed downloads, and dialog auto-handling (`dialogPolicy`: `accept`/`dismiss`).

## Benchmarks

### Per-tool measurements (`npm run benchmark`)

These come from [`benchmarks/benchmark.mjs`](benchmarks/benchmark.mjs) on local fixture pages in headless Chromium. Tokens are counted with `tiktoken` (`o200k_base`). They measure the size of tool output and the time spent in the browser. Model time is not included, so read them as an upper bound on what an agent gains, not as an agent result.

"Cumulative" tokens model a chat agent that re-reads every earlier tool result on each turn: over N turns, the output of turn i is read N − i + 1 times. Each call saved is also one model round-trip, which in most agent loops takes longer than the browser work itself.

### Snapshots and text extraction

| Scenario | Raw HTML | Full Playwright ARIA | `turbo-browser-mcp` Output | Saved vs ARIA | Saved vs HTML |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 140-Button SaaS Console (`inspect_compact`) | `61,010` chars (`18,654` tok) | `12,771` chars (`3,568` tok) | `3,968` chars (`1,135` tok) | `68.2%` | `93.9%` |
| Post-Click Delta (`onlyChanged: true`) | `61,010` chars (`18,654` tok) | `12,825` chars (`3,582` tok) | `168` chars (`56` tok) | `98.4%` | `99.7%` |
| Article Markdown Extraction (`extract_clean_text`) | `10,844` chars (`3,595` tok) | n/a | `641` chars (`156` tok) | n/a | `95.7%` |
| Diagnostics Filter (`32` reqs, `26` console logs) | `9,651` chars (`3,460` tok, `all`) | n/a | `1,761` chars (`601` tok, `errors`) | n/a | `82.6%` |

### Forms, multi-step flows, uploads and page loading

| Scenario | Step-by-Step Baseline | `turbo-browser-mcp` | Execution Speedup | Token Savings |
| :--- | :--- | :--- | :--- | :--- |
| 10-Field Complex Form + Verify (`smart_fill_form`) | `11` turns, `574 ms`, `12,197` direct / `72,614` cum tok | `1` turn, `82 ms`, `811` tok (`filled=10`) | `7x` faster | `93.4%` dir / `98.9%` cum |
| 48 KiB PDF Upload (`49,152` bytes via `file`) | `65,679` chars (`44,728` tok) Base64 payload | `263` chars (`85` tok) disk path (`68 ms`) | Zero LLM Base64 encode | `99.8%` |
| 6-Step UI Flow (`batch_actions`) | `6` turns, `411 ms`, `955` dir / `3,162` cum tok | `1` turn, `357 ms`, `406` tok | `1.15x` faster | `57.5%` dir / `87.2%` cum |
| Open 6 Tabs (`tabs_batch` `open_many`, `60 ms` TTFB) | `6` turns sequential (`998 ms`) | `1` turn batched (`420 ms`) | `2.38x` faster (`6 -> 1` turns) | Eliminates `5` turns |
| Heavy Media Load (`8x32 KiB` imgs + `48 KiB` font) | `252 ms`, `9` media hits (`304 KiB`) | `165 ms`, `0` media hits (`0 KiB`) | `1.53x` faster | `100%` media saved |

### Tool schema size (sent to the model on every turn)

Measured against installed MCP JSON schemas on disk (compact parameter schemas without `annotations`):

| MCP Server | Tool Count | Compact Schema Chars | Exact `o200k_base` Tokens | Savings with `turbo-browser-mcp` |
| :--- | :--- | :--- | :--- | :--- |
| `turbo-browser-mcp` | `11` (`15,144` full / `13,631` compact) | `13,631` | `3,170` (`3,541` full w/ annotations) | Baseline (`11` tools) |
| `@playwright/mcp` | `25` | `18,457` | `3,917` | `19.1%` fewer static tokens |
| `chrome-devtools-mcp` | `33` | `30,252` | `6,737` | `52.9%` fewer static tokens |

v0.7 shortened the tool descriptions: the compact schema went from `3,217` to `3,029` tokens (`3,588` to `3,400` full). `oneOf` unions were kept as they are, because some clients reject JSON Schema type arrays. `--tools core` lists 6 tools at `2,030` compact tokens. The server instructions add 46 tokens once per session.

v0.5.0 added `wait_for_human` and the commit-safety parameters for about 160 tokens per turn (v0.4.0: `3,010` compact). To keep that small, `expect` / `submissionKey` / `allowDuplicate` are declared only on `batch_actions` (a one-step batch works for a single click), and the network guard is switched on by environment variable, so it costs no schema tokens. The label lists for other languages run inside the page and are never sent to the model.

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

Every stack passed every task. turbo-browser-mcp was fastest in total and browse was cheapest. One trial per cell is not enough to rank them, and the headless and headed browsers are not equally fast. The application task cost turbo-browser-mcp 23 turns, the most of any trial; that is being looked into. Per-task numbers, how tokens are counted, and the harness fixes made during the run are in [`benchmarks/E2E_RESULTS.md`](benchmarks/E2E_RESULTS.md).

## Comparison with `@playwright/mcp` and `chrome-devtools-mcp`

| Feature | `turbo-browser-mcp` | `@playwright/mcp` | `chrome-devtools-mcp` |
| :--- | :--- | :--- | :--- |
| Number of tools | 11 | 25 granular tools | 33 granular tools |
| Delta Snapshots (`onlyChanged`) | Built-in | Full tree every snapshot | Full tree every snapshot |
| Closed Shadow DOM Hook | Post-init `attachShadow` hook + `<slot>` flattening | Open Shadow DOM | CDP / standard DOM access |
| Single-Call Smart Form + Contenteditable | Yes (React, Shadow DOM, iframe, Gmail, ranges) | Multi-turn fill + separate select calls | Basic `fill_form` |
| Disk File Upload (Zero Base64) | Native `file`/`files` path in `smart_fill_form` & `act_fast` | Dedicated `browser_file_upload` turn | Dedicated `upload_file` turn |
| Default Human-in-the-Loop Submit Guard | Yes (`allowSubmit=false`, form/iframe/Enter hooks) | No | No |
| Parallel `open_many` + `isolatedContext` | Single batched call | Separate sequential tab calls | Separate page calls |
| One-Call `turbo` Media Blocker | Built-in (`turbo`, `no-images`, `no-media`) | Manual JS / routing | Network emulation |
| Performance / Heap Profiling | Not included | Not included | Trace, Lighthouse, Heap Snapshot |

> When to keep Chrome DevTools MCP alongside `turbo-browser-mcp`: `chrome-devtools-mcp` provides Lighthouse audits, performance trace analysis, CSS computed style panels, and V8 heap snapshots. `turbo-browser-mcp` focuses on fast multi-step UI automation, forms, and scraping with minimal token overhead.

### Tool mapping

| Capability | `turbo-browser-mcp` | `@playwright/mcp` | `chrome-devtools-mcp` |
| :--- | :--- | :--- | :--- |
| Multi-tab open, list, switch, resize, emulate | `tabs_batch` | `browser_tabs`, `browser_navigate`, `browser_resize`, ... | `new_page`, `list_pages`, `select_page`, `resize_page`, ... |
| DOM / accessibility inspection | `inspect_compact` | `browser_snapshot` | `take_snapshot` |
| Multi-field form & upload | `smart_fill_form` | `browser_fill_form` + `browser_select_option` + `browser_file_upload` | `fill_form` + `upload_file` |
| Click, type, drag, press, scroll, wait | `act_fast` | `browser_click`, `browser_type`, `browser_drag`, ... | `click`, `type_text`, `drag`, `press_key`, `wait_for` |
| Multi-step sequential macro | `batch_actions` | `browser_run_code_unsafe` or N tool calls | N separate tool calls |
| Clean article extraction | `extract_clean_text` | `browser_evaluate` custom JS | `evaluate_script` custom JS |
| Frame/element JS evaluation | `evaluate_js` | `browser_evaluate` | `evaluate_script` |
| Errors, network & console triage | `page_diagnostics` | `browser_console_messages`, `browser_network_requests` | `list_console_messages`, `list_network_requests`, ... |
| Screenshots & PDF export | `capture_page` | `browser_take_screenshot` | `take_screenshot` |
| Blocking presets, cookies & storage | `network_session` | `browser_evaluate` + context config | Partial via `evaluate_script` / `emulate` |

## Safety

### Submit guard and file path limits

1. Human-in-the-loop Submit Guard (`allowSubmit=false` by default):
   - `smart_fill_form` (`stopBeforeSubmit: true`), `act_fast`, and `batch_actions` inspect matching elements, W3C AccName labels (`isSafeSubmitter`), implicit HTML form Enter submissions, key chords (`Shift+Enter`, `Enter+Shift`), `HTMLFormElement.prototype.submit`/`requestSubmit`, and same-origin iframe `contentWindow`/`contentDocument` proxies.
   - Final actions resembling `Submit`, `Publish`, `Send`, `Post`, `Apply`, `Confirm`, or payment triggers are blocked unless `allowSubmit: true` is explicitly passed or `--allow-submit` is enabled at startup.
   - Trade-off: pre-existing closed Shadow roots on already-open CDP tabs (attached before the init script ran) or strict cross-origin sandboxed frames fall back to Playwright frame handles, coordinate actions, and keyboard input.
2. Workspace Path Confinement (`TURBO_BROWSER_SAVE_ROOT`):
   - File outputs (`savePath`, `saveStorageStatePath`) and state inputs (`loadStorageStatePath`) are strictly confined to the current working directory or `TURBO_BROWSER_SAVE_ROOT`.
   - Lexical checks, `lstatSync`/`readlinkSync` symlink verification, and `realpathSync` validation block `..` traversal, UNC network paths, dangling symlinks, cyclic symlinks, and Windows junctions before reading or writing.

### Commit checks: `expect`, `submissionKey`, modal and network guards

Readers who run agents on real portals pointed out three gaps in a label-based guard. v0.5.0 adds an opt-in answer to each. `expect`, `submissionKey` and `allowDuplicate` appear in the `batch_actions` schema; `act_fast` accepts the same arguments without advertising them. The network guard is turned on with `TURBO_BROWSER_NETWORK_GUARD=true` and covers `act_fast`, `batch_actions` and `smart_fill_form`.

1. A landed click is not a confirmed submission → `expect`. After an allowed submit, pass `expect: { urlMatches?, textMatches?, selector?, timeoutMs? }`. The result carries `submitVerified` and `evidence` (the new URL, a text snippet such as a receipt number, or the matched selector). If nothing shows up in time you get `submitVerified: false` and a reason, so the agent does not report "done" on an empty submission list.
2. A re-run is a second entry, not a retry → `submissionKey`. With `submissionKey: "portal:2026-11-15:entry-42"`, every allowed submit is appended to a JSONL ledger (`~/.turbo-browser-mcp/submissions.jsonl`, or `TURBO_BROWSER_LEDGER`, or `ledgerPath` inside the save root). A later call with the same key is refused with `blockedBy: "ledger"` unless `allowDuplicate: true`.
3. Labels lie → modal rule + `networkGuard`. On many Korean portals the last step reads 다음 and the real commit is a 확인 inside a modal that opens afterwards.
   - Affirmative buttons (`확인`, `OK`, `Yes`, `Confirm`, `確認`, `确定`, `Đồng ý`, …) inside `dialog` / `[role=dialog]` / `[role=alertdialog]` / `[aria-modal=true]` now count as commits (`blockedBy: "modal"`). Cookie banners (dialog text mentions cookies) and date/time pickers (dialog contains a calendar grid or date input) are excluded; a confirmation that only mentions "privacy" or "consent" is still blocked.
   - When an action makes the page call `form.submit()` / `requestSubmit()` or fire a `submit` event and the guard stops it, the result now says so (`submitSuppressed`, `note`) instead of a bare `ok: true`. The action itself (a select, a check) still counts as done, so batches continue.
   - Common Korean, Japanese, Chinese and Vietnamese submit labels were added (`제출`, `신청`, `등록`, `결제`, `送信`, `確定`, `提交`, `Hoàn tất`, …), and `다음`, `次へ`, `下一步` are treated like `Next`.
   - `TURBO_BROWSER_NETWORK_GUARD=true` is the safety net that does not depend on labels: while submitting is not allowed, non-GET navigations and same-site `fetch`/XHR `POST`/`PUT`/`PATCH`/`DELETE` are stopped and reported (`blockedBy: "network"`, `networkBlocked[]`). Blocked navigations get a `204` so the page and the half-filled form stay put. Let harmless endpoints through with `TURBO_BROWSER_NETWORK_GUARD_ALLOW="/autosave$,/analytics"`. Per call, the undeclared arguments `networkGuard`, `networkGuardAllow` and `networkGuardSettleMs` override the env values. It is off by default because multi-step wizards often `POST` on every "Next".
   - Every blocked result now says which mechanism stopped it: `blockedBy` is `label`, `modal`, `network` or `ledger`.

Limits:
- The network guard watches the action plus `networkGuardSettleMs` (250 ms) afterwards, so a commit fired later by a timer is not caught. WebSocket messages, requests made by a service worker, and cross-site `fetch` POSTs are not inspected (cross-site *navigations* are). Patterns in `TURBO_BROWSER_NETWORK_GUARD_ALLOW` are split on commas, so a pattern cannot contain one.
- The ledger is written only when the call returns. If the call throws after the page already sent the submission (for example a navigation timeout), nothing is recorded; check the site before re-running.
- `expect.selector` that is not a valid selector never matches, so the call reports `submitVerified: false` after the timeout.

### Handing a step to a person (`wait_for_human`, `--open-profile`)

Some sites fail their bot check whenever the browser is remote-controlled, so a person has to open the same profile in a normal browser first. turbo-browser-mcp does not try to hide automation: no stealth plugins, no fingerprint or `navigator.webdriver` patching, no CAPTCHA solving. It supports two hand-off flows instead.

1. Before the session: `turbo-browser-mcp --open-profile --url https://site.example/login` opens plain Chrome (no debugging port, no automation flags) on the dedicated profile `~/.turbo-browser-mcp/chrome-profile` (or `--user-data-dir`). The human logs in or passes the check and closes the window. Then start the server with `--user-data-dir <same path>` or `--launch-chrome`, and the agent reuses those cookies. This works for sites that check at login; a site that re-checks on every request will still see an automated browser.
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

Set `observeAftermath: true` on `act_fast` or `batch_actions` (or set
`TURBO_BROWSER_OBSERVE_AFTERMATH=true`) to observe navigation and mutating
fetch/XHR requests after each click: at least 400 ms, extended while the page is still active, at most 800 ms. It is off by default.
The result includes `aftermath: { beforeUrl, afterUrl, navigated,
mutatingRequests, unexpectedSubmit }`. Requests include their method, URL,
and a `finalSubmit` classification. Main-frame origin/path changes or
commit-like requests produce a warning when `allowSubmit` is false.

This reports an action that has already occurred. It cannot prevent a commit
or prove that a submission succeeded. Wizard navigation can trigger a warning,
and opaque endpoints or requests outside the observation window can be missed.
Use the network guard for prevention and `expect` for receipt verification.
See [fixture and classification details](test/COMMUNITY_FIXTURES.md).

## CLI options and environment variables

| CLI Flag | Environment Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `--mode <auto\|cdp\|persistent\|launch>` | `TURBO_BROWSER_MODE` | `auto` | Connection strategy (`cdp` first then launch in `auto`) |
| `--cdp <url>` | `TURBO_BROWSER_CDP_URL` | `http://127.0.0.1:9222` | Chrome DevTools Protocol HTTP endpoint |
| `--user-data-dir <path>` | `TURBO_BROWSER_USER_DATA_DIR` | `""` | Persistent profile directory path |
| `--executable <path>` | - | auto-detected | Custom Chromium, Chrome, Edge, or Brave executable |
| `--timeout <ms>` | `TURBO_BROWSER_TIMEOUT_MS` | `15000` | Default Playwright action/navigation timeout in ms |
| `--tools <all|core>` | `TURBO_BROWSER_TOOLS` | `all` | `core` lists only `tabs_batch`, `inspect_compact`, `smart_fill_form`, `act_fast`, `batch_actions`, `extract_clean_text` |
| `--headless` / `--headed` | `TURBO_BROWSER_HEADLESS` | `true` (headless) | Run headless or visible browser window (`"false"` for headed) |
| `--allow-submit` | - | `false` | Disable default Submit/Publish confirmation guard |
| `--doctor` | - | - | Print Node, Playwright, Chromium, and CDP diagnostics as JSON |
| `--bridge` | `TURBO_BROWSER_BRIDGE_PORT` | `9224` | Start/verify the persistent CDP Keep-Alive Bridge daemon for Chrome 144+ `DevToolsActivePort` (approve once, reconnect unlimited times AFK) |
| `--launch-chrome` | - | `~/.turbo-browser-mcp/chrome-profile` | Launch Chrome with a dedicated profile & `--remote-debugging-port=9222` (`0` approval prompts ever) |
| `--open-profile [--url <u>]` | `TURBO_BROWSER_OPEN_URL` | `~/.turbo-browser-mcp/chrome-profile` | Open the profile in a normal, non-automated Chrome so a human can log in or pass a check first |
| - | `TURBO_BROWSER_NETWORK_GUARD` | `false` | Turn on the network commit guard by default |
| - | `TURBO_BROWSER_NETWORK_GUARD_ALLOW` | `""` | Comma-separated URL regexes the network guard lets through |
| - | `TURBO_BROWSER_OBSERVE_AFTERMATH` | `false` | Report navigation and mutating requests after each click (see [Click aftermath](#click-aftermath-reporting)) |
| - | `TURBO_BROWSER_LEDGER` | `~/.turbo-browser-mcp/submissions.jsonl` | Submission ledger used by `submissionKey` |
| `--version` / `-v` | - | - | Print server version |
| `--help` / `-h` | - | - | Print CLI usage summary |
| - | `TURBO_BROWSER_SAVE_ROOT` | `process.cwd()` | Root directory confining `savePath` and `storageState` files |
| - | `PLAYWRIGHT_CORE_PATH` | auto-resolved | Explicit path to `playwright-core/index.mjs` |

### Unattended runs and the Chrome 144+ remote-debugging prompt

In Chrome 136+/144+, enabling `chrome://inspect/#remote-debugging` on the default `User Data` directory exposes a WebSocket in `DevToolsActivePort` that displays an "Allow remote debugging?" prompt whenever a new WebSocket client connects. `turbo-browser-mcp` provides two built-in solutions so overnight AFK multi-agent runs never hang on a prompt:

1. Automatic CDP Keep-Alive Bridge Daemon (`npm run bridge` / `--bridge`, enabled automatically on `DevToolsActivePort`):
   - Spawns a detached background multiplexer (`src/cdp-bridge.mjs` on `http://127.0.0.1:9224`) that holds one persistent upstream WebSocket to Chrome open indefinitely and intercepts `Browser.close` so downstream scripts never terminate your browser.
   - You click Allow once when starting your session; afterwards, any number of MCP servers, CLI scripts, or subagents can connect and disconnect all night with 0 additional prompts.
2. Zero-Prompt Dedicated Profile Launcher (`npm run launch-chrome` / `--launch-chrome`):
   - Launches Chrome with `--remote-debugging-port=9222` and a dedicated `--user-data-dir` (`~/.turbo-browser-mcp/chrome-profile`), where Chrome exposes standard HTTP/WS CDP with 0 confirmation dialogs even on the very first connection.

## Development

```bash
npm test               # 437 tests in 87 suites (test/*.test.mjs)
npm run doctor         # Node, Playwright, Chromium and CDP check
npm run benchmark      # per-tool token and timing benchmark
npm run benchmark:e2e  # scripted wizard task and commit-safety cases
```

CI runs the tests on Ubuntu with Node 20 and 22.

## Known limits

- Portaled comboboxes (react-select, Radix, Headless UI style) have a click path and a keyboard fallback that searches up to 100 options and checks the committed value. Virtualized lists beyond the included fixtures still need testing against real apps.
- Sites with bot detection may need `wait_for_human` and a person to pass the check in the same browser. The server does not bypass those checks.
- The agent benchmark has one trial per stack and task so far; the ten-trial protocol in `benchmarks/E2E_PLAN.md` has not been run.
- The settle step ends as soon as the page is quiet. A request a script fires later than that (for example a timer of several hundred milliseconds) is outside the click aftermath window, which is 400 to 800 ms. A page that keeps mutating the DOM (a spinner or ticker) makes the step run to its 800 ms cap.
- The network guard and click aftermath only watch a short window after each action, and do not inspect WebSocket messages or service-worker requests. Details are under [commit checks](#commit-checks-expect-submissionkey-modal-and-network-guards).
- Closed Shadow roots that existed before the server attached to a tab cannot be reached through the hook. Actions there fall back to frame handles, coordinates and keyboard input.

## Credits

Several features came from readers of the Show HN post and the dev.to article: johnnylemonny and alexcodebytes (portaled and virtualized selects), eye_java_420f1faa10ae8b86 (keyboard selection and click aftermath), amintacccp (safe submit labels), snake_doc and lukevp (end-to-end comparison, level of abstraction), vidarh (human hand-off), harrysong138759 (receipt verification and duplicate submissions).

## License

[MIT](LICENSE)
