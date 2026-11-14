# turbo-browser-mcp

Fast, token-efficient Playwright MCP server (`v0.4.0`, 10 tools) designed for AI coding agents. Built to cut MCP round-trips and context bloat through compact bounded snapshots, 1-turn batched form fills, parallel multi-tab opening (`open_many`), turbo ad/image/tracker presets, cross-iframe and open Shadow DOM support, direct disk file uploads/drops, isolated browser sessions, and a strict default `allowSubmit=false` human-in-the-loop safety guard.

## Why `turbo-browser-mcp`

- **Tiny context footprint (`inspect_compact`)**: Emits deterministic `f<frameIdx>:e<N>` refs across main frame, nested `iframe`s, and **open Shadow DOM** (`el.shadowRoot`), hard-capped at `maxChars` (default `4000`). Supports `query` filtering, `onlyChanged` delta snapshots, `[box=x,y,w,h]` geometry (`boxes: true`), and `savePath` file export.
- **1-turn action + snapshot (`returnSnapshot: true`)**: Available on `act_fast`, `batch_actions`, and `smart_fill_form` so agents act and read the updated page in a single MCP turn instead of alternating action/snapshot calls.
- **One-shot smart form fill (`smart_fill_form`)**:
  - Uses native prototype setters + React `_valueTracker` reset + `input`/`change`/`blur` events so controlled React forms stay in sync.
  - Fills `contenteditable` editors (ProseMirror, Quill, Gmail compose), single/multi `<select>` (`values`), `<input type="range">` sliders, ARIA `[role="combobox"]`, radios, and checkboxes across `iframe`s and open Shadow DOM.
  - Attaches local disk files (`file`/`files`) directly via Playwright `setInputFiles` / `filechooser` without Base64 tokens passing through the LLM.
- **Parallel tabs, isolated contexts & full input parity (`tabs_batch`, `act_fast`, `batch_actions`)**:
  - Single `open` or concurrent `open_many` (`concurrency` 1–10), named `isolatedContext` sessions (separate cookies/storage per profile), `resize`, `emulate` (`colorScheme`, `media`, `reducedMotion`, `forcedColors`, `contrast`, `viewport`, `userAgent`, plus `null` resets), and `close_browser`.
  - Full mouse/keyboard & drag/drop (`click`/`dblclick`/`hover` with `button`, `modifiers`, raw viewport `{ x, y }`, `drag`, `drop` disk files & `dropData` MIME, `type` with `slowly`/`delayMs`/`submit`, `wait` with `textGone`/`url`/`loadState`/`ms`).
- **Human-in-the-loop submit guard (`act_fast`, `batch_actions`)**: Blocks target clicks, viewport `{ x, y }` clicks, `Enter` presses, and `type` `submit: true` on `submit`/`publish`/`post`/`send`/`pay`/`delete`/`đăng bài`/`nộp đơn`/`gửi` controls unless `allowSubmit: true` (or `--allow-submit` / `TURBO_BROWSER_ALLOW_SUBMIT=true`) is explicitly enabled.
- **Turbo speed presets, diagnostics & downloads (`network_session`, `page_diagnostics`, `capture_page`, `evaluate_js`)**:
  - Built-in blocking presets (`turbo`, `no-images`, `no-media`, `clean`) alongside cookie/storage/`storageState` management and custom resource/URL blocking.
  - Console logs (`errors` | `all`), network buffer with `includeStatic: false` default filtering, `urlFilter`, `reqId` + `part` detail inspection, automatic `downloads` capture, `dialogPolicy`, element-targeted `evaluate_js` (`(el, arg)`), clean Markdown extraction, and PNG/JPEG (`scale: css|device`) or PDF capture.
  - Cross-platform browser/Playwright discovery across Windows, macOS, and Linux, plus `elapsedMs` timing telemetry on DOM/tab calls.

## Measured Benchmarks (`npm run benchmark`)

Measured locally on Chromium headless against a self-contained HTTP fixture (`node ./benchmarks/benchmark.mjs`):

| Scenario | Baseline | `turbo-browser-mcp` | Measured Savings |
| :--- | :--- | :--- | :--- |
| Dense 140-button DOM snapshot | `13,650` chars raw HTML | `3,920` chars compact / `155` chars delta | **`71.3%` fewer chars** |
| 7-field form fill + snapshot | `14` MCP turns (`169 ms`) | `1` MCP turn (`26 ms`, `filled=7`) | **`14x` fewer turns, `6.5x` faster** |
| Open 4 tabs (`domcontentloaded`) | `279 ms` sequential | `184 ms` parallel `open_many` | **`1.52x` faster** |

## Quick Start

### 1. Check your environment

```bash
node ./src/index.mjs --doctor
```

Returns JSON verifying Node version, OS/arch, `playwright-core` resolution, Chromium binary path, and local CDP (`http://127.0.0.1:9222`) availability.

### 2. Configure in any MCP Client (Claude Desktop, Claude Code, Cursor, Windsurf, Antigravity, VS Code)

Using local path:

```json
{
  "mcpServers": {
    "turbo-browser": {
      "command": "node",
      "args": ["/path/to/turbo-browser-mcp/src/index.mjs"],
      "env": {
        "TURBO_BROWSER_MODE": "auto",
        "TURBO_BROWSER_HEADLESS": "true"
      }
    }
  }
}
```

Or via `npm` / `npx`:

```json
{
  "mcpServers": {
    "turbo-browser": {
      "command": "npx",
      "args": ["-y", "turbo-browser-mcp", "--headless"]
    }
  }
}
```

## CLI Flags & Environment Variables

| CLI Flag | Environment Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `-h`, `--help` | — | — | Print usage and options |
| `-v`, `--version` | — | — | Print version (`0.4.0`) |
| `--doctor` | — | — | Inspect Node, Playwright, Chromium, and CDP reachability (JSON) |
| `--mode <mode>` | `TURBO_BROWSER_MODE` | `auto` | `auto` (tries CDP, then persistent dir, then launch), `cdp`, `persistent`, or `launch` |
| `--cdp <url>` | `TURBO_BROWSER_CDP_URL` | `http://127.0.0.1:9222` | CDP endpoint when attaching to an open Chrome/Edge session |
| `--user-data-dir <dir>` | `TURBO_BROWSER_USER_DATA_DIR` | `""` | Browser profile directory for `persistent` mode |
| `--executable <path>` | `TURBO_BROWSER_EXECUTABLE` | `""` | Override Chromium/Chrome/Edge/Brave binary path |
| `--timeout <ms>` | `TURBO_BROWSER_TIMEOUT_MS` | `15000` | Default navigation and action timeout in ms |
| `--headless` / `--headed` | `TURBO_BROWSER_HEADLESS` | `true` | Run headless or open a visible browser window |
| `--allow-submit` | `TURBO_BROWSER_ALLOW_SUBMIT` | `false` | Permit Submit/Publish clicks globally without passing `allowSubmit: true` per call |
| — | `TURBO_BROWSER_SAVE_ROOT` | `process.cwd()` | Optional `path.delimiter`-separated allow-list of root directories where `savePath`, `capture_page`, `saveStorageStatePath`, and `loadStorageStatePath` may read/write (canonicalized against traversal and symlinks/junctions) |

## Tools (10)

| Tool | Read-Only | Purpose |
| :--- | :--- | :--- |
| `tabs_batch` | No | List, `open`, parallel `open_many`, `isolatedContext`, navigate, activate, resize, emulate (with `null` reset), reload, back/forward, close tabs, or close browser |
| `inspect_compact` | Yes | Compact DOM inventory across frames + open Shadow DOM (`interactive`, `forms`, `article`, `all`, `query`, `onlyChanged`, `boxes`, `savePath`) |
| `smart_fill_form` | No | Batch prefill for React, `contenteditable`, single/multi `<select>`, `<input type="range">`, ARIA comboboxes, radios/checkboxes, Shadow DOM, Gmail, iframes, disk uploads |
| `act_fast` | No | Single action (`click`, `dblclick`, `hover`, `drag`, `drop`, `fill`, `type`, `select`, `upload`, `wait`, `press`, `button`/`modifiers`/`x`/`y`) with `allowSubmit=false` guard |
| `batch_actions` | No | Execute sequential DOM and `smart_fill_form` steps in one turn with optional post-batch snapshot |
| `extract_clean_text` | Yes | Extract readable plain text or compact Markdown across frames capped at `maxChars` with optional `savePath` |
| `evaluate_js` | No | Evaluate a JS function or expression in a frame or target element `(el, arg)` with optional `savePath` |
| `page_diagnostics` | No | Inspect console logs, filtered HTTP requests (`includeStatic`, `urlFilter`, `reqId`/`part`), captured `downloads`, dialog policy, and `savePath` |
| `capture_page` | Yes | Capture full-page or element screenshot (`png`/`jpeg`, `scale: css\|device`) or PDF export to a safe `cwd`-relative path |
| `network_session` | No | Apply presets (`turbo`, `no-images`, `no-media`, `clean`), manage cookies/`localStorage`/`sessionStorage`, save/load `storageState`, and block custom resources/URLs |

## Parity vs `@playwright/mcp`

| `@playwright/mcp` Tool | `turbo-browser-mcp` Coverage |
| :--- | :--- |
| `browser_tabs`, `browser_navigate`, `browser_navigate_back`, `browser_close`, `browser_resize`, `browser_emulate_media` | `tabs_batch` (adds parallel `open_many`, `isolatedContext` sessions, & `emulate` `forcedColors`/`contrast`/`null` resets in 1 batch) |
| `browser_snapshot`, `browser_find` | `inspect_compact` (adds `maxChars` cap, `onlyChanged` delta, open Shadow DOM, `boxes`, `savePath`) |
| `browser_fill_form`, `browser_select_option`, `browser_file_upload` | `smart_fill_form` + `act_fast` (adds React `_valueTracker`, `<select multiple>`, `<input type="range">`, ARIA comboboxes, Gmail compose, iframes, `drop` files) |
| `browser_click`, `browser_hover`, `browser_drag`, `browser_drop`, `browser_type`, `browser_press_key`, `browser_wait_for` | `act_fast` + `batch_actions` (adds `button`/`modifiers`/`{x,y}`, `dropData`, `slowly`/`submit`, `textGone`/`url`/`loadState`, `returnSnapshot`, `allowSubmit=false` guard) |
| `browser_evaluate` | `evaluate_js` (`frameIdx`, optional element `ref`/`selector`/`text` passing `(el, arg)`, `savePath`) |
| `browser_console_messages`, `browser_network_requests`, `browser_network_request`, `browser_handle_dialog` | `page_diagnostics` (`includeStatic`, `urlFilter`, `reqId`/`part`, automatic `downloads` capture, `dialogPolicy`, `savePath`) |
| `browser_take_screenshot` | `capture_page` (`scale: css\|device`, `png`/`jpeg`, `savePath`, `returnImage`, plus `mode: 'pdf'`) |
| `browser_run_code_unsafe` | Intentionally omitted to preserve `allowSubmit=false` safety; covered by `evaluate_js` + `batch_actions` + `network_session` |

## Chrome CDP Attach Tip

To drive an already signed-in desktop Chrome profile, start Chrome with remote debugging enabled:

```powershell
# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:LOCALAPPDATA\Google\Chrome\TurboProfile"
```

```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/Library/Application Support/Google/Chrome/TurboProfile"
```

When `TURBO_BROWSER_MODE=auto`, `turbo-browser-mcp` probes `http://127.0.0.1:9222/json/version` (800ms timeout) and attaches automatically if reachable, otherwise falling back to Playwright Chromium launch.

## Verification

Run the integration test suite, environment doctor, and benchmarks:

```bash
npm run doctor
npm test
npm run benchmark
```

Latest verified run: `82` passing tests (`0` failures, `0` skipped, `0` todo across 4 suites: 23 integration + 9 DOM/form stress + 8 session/protocol stress + 42 independent adversarial tests) covering React setter tracking, `contenteditable`, HTML5 inputs (`date`/`time`/`datetime-local`/`month`/`number`/`tel`/`url`/`password`/`color`), ARIA comboboxes/radios/checkboxes/switches, `not`/`ref`/`selector`/`main` & `overwrite` toggles, exact-then-word option/choice matching & `<fieldset>` scoping, multi-checkboxes, `<select multiple>` & `label` options, `<input type="range">`, 2+ level cross-`iframe` and nested open Shadow DOM piercing, real temporary single/multi-file & `filechooser` uploads via `setInputFiles`, `query` + `onlyChanged` delta + `boxes` + `savePath` snapshots, 1-turn `returnSnapshot`, `dblclick`/`focus`/`clear`/`drag`/`drop` (disk files + custom MIME `DataTransfer`), hardened `allowSubmit=false` Submit guards (nested `<span>`/`<svg>`, `<input type="image">`, `<label for>`, detached `form=` controls, iframe & Shadow DOM coordinate piercing, modified `Enter` / literal `' '` `Space` / `\r\n` `type` guards, Unicode Vietnamese labels such as `"Xoá"`/`"Đăng bài"` without blocking `"Đăng nhập"`, batch `allowSubmit: false` ceiling), `type slowly`/`press` combos, `scroll`, safe literal/regex matching for labels containing metacharacters (`C++`, `Phone (optional)`), `wait` (`text`, `selector`, `textGone`, `url`, `loadState`, `hidden`, `detached`), `batch_actions` (`continueOnError`), pagination & structured Shadow DOM / Markdown scraping (tables, `<br>` cells, nested lists, code blocks, blockquotes, links), tab `back`/`forward`/`reload`/popup auto-registration/`activate: false`/all-tab close recovery, `resize`, `emulate` dark/`forcedColors`/`contrast`/`media`/`reducedMotion`/`userAgent`/`null` resets, element-targeted `evaluate_js` (`(el, arg)`, valid `frameIdx`, single-execution error semantics, `savePath`), `includeStatic`/`urlFilter`/`reqId`/`part`/`maxBodyChars` HTTP ring-buffer eviction & `pageerror` inspection, automatic browser `downloads` capture + abort/timeout bounds + cleanup on `close()`, prompt/`confirm` `dialogPolicy`, element/`jpeg`/`fullPage`/`scale: "device"` screenshot & PDF capture, cookie/`localStorage`/`sessionStorage`/`saveStorageStatePath`/multi-origin `loadStorageStatePath` into `isolatedContext`, `TURBO_BROWSER_SAVE_ROOT` symlink/junction path confinement, concurrent `open_many` partial failure isolation, `network_session` `turbo`/`no-images`/`no-media`/`clean` presets & `*.png` globs, `elapsedMs` telemetry, CLI `--version`/`--help`/`--doctor`, `maxChars` truncation (`3951 <= 4000` on a 140-button fixture), and stdio JSON-RPC conformance (`v0.4.0`, all 10 tools, case-insensitive `Content-Length` framing across fragmented chunks, batch arrays, `-32700`/`-32600` recovery, and `protocolVersion` negotiation).

## License

[MIT](LICENSE)
