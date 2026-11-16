# Stage-one agent benchmark

This implements the three primary tasks in [E2E_PLAN.md](../E2E_PLAN.md).
The stage-one brief overrides its trial count and timeout: one trial per stack
and task (12 total), six minutes each, fixed order. No agent comparison has
been run. The prefill-only variant, randomized ten-trial study and full
provider usage instrumentation remain outside stage one.

From the repository root (Node 22+ for competing npm launchers):

```powershell
npm.cmd install
node benchmarks/e2e-agent/self-test.mjs
node benchmarks/e2e-agent/server.mjs 8080
```

The standalone server prints JSON containing base URL, absolute attachment
path and SHA-256. Bind address is loopback only. The self-test starts its own
ephemeral server, drives each route using playwright-core directly, verifies
positive and negative evaluator cases, then closes the browser and server.
It needs an installed Playwright Chromium, Chrome, or Edge. This is fixture
validation, not a measurement of any agent stack.

The PDF is exactly 49,152 bytes. Published SHA-256:
`0bc5687dd5ec4288fb1df062a7b405981801a87b857acfbb4afac77868c6afa8`.
It is also stored in `fixtures/attachment.pdf.sha256`. Running the server or
self-test reproducibly regenerates both files.

## Coordinator commands (not executed during implementation)

```powershell
.\benchmarks\e2e-agent\install-stacks.ps1
.\benchmarks\e2e-agent\run.ps1 -CodexPath 'C:\path\codex.exe' -Model 'YOUR_MODEL' -Reasoning medium -ChromiumPath 'C:\Program Files\Google\Chrome\Application\chrome.exe' -SetupHook 'D:\dev\bench-tmp\setup.ps1'
node benchmarks/e2e-agent/report.mjs
# After closing benchmark browsers and daemons:
.\benchmarks\e2e-agent\uninstall-stacks.ps1
```

Installation uses local npm and a Python 3.12 venv under `D:\dev\bench-tmp`.
Python 3.12 and Node must already exist. Optional version parameters pin
agent-browser, browse and browser-use; otherwise the resolved versions are
retained in npm's package-lock and `python-freeze.txt`. No global commands,
user skill/config registration, browser download or automatic extension
pairing are performed. This avoids the upstream browse installer's user
configuration writes. Do not run `browse install` against a personal profile.
Uninstall checks the exact absolute root and refuses reparse points before
deleting the entire tree, including trial workspaces and setup hooks.

`run.ps1` delegates process management to `runner.mjs` (Node child-process
argument arrays avoid PowerShell quoting problems). It starts/stops its own
fixture server; no separate server is required. Each trial gets a new
workspace, isolated Codex config, unique agent-browser/Browser Use session,
fresh turbo launch, and fresh submission ledger. Codex auth.json alone is
copied from the current Codex directory, then removed after the trial;
environment-based authentication is also inherited. Existing user MCP
configuration is not copied. Use a benchmark-only account/environment if
additional ambient skills or policy files are configured on this host.

The same attachment path and task text are used across stacks. The agent
gets no fixture/evaluator source in its workspace. Rules prohibit state
inspection and direct HTTP shortcuts; this is an instruction boundary, not
a hardened anti-cheating sandbox (workspace-write permits reads elsewhere).
Audit transcripts before publication.

## Fresh-profile setup hook

browse needs an installed extension and pairing; Browser Use needs a browser
connection. Those host-specific workflows cannot honestly be assumed to
work unattended on Windows. The coordinator supplies a PowerShell hook;
without one, all six affected trials are recorded as setup failures, not
silently driven through a personal browser or another stack.

The runner calls it with `-Phase setup|cleanup -Stack browse|browser-harness
-Workspace <absolute trial path> -Base <fixture URL>`. The setup invocation
must prepare a fresh, empty benchmark-only profile under the trial workspace,
connect the selected stack, and verify it can see that browser. It inherits
trial XDG paths, temp directories, BU_NAME and file roots. Configure installed
stack documentation/skills inside that workspace if needed. Keep setup and
cleanup bounded (120 seconds each); prepare extension assets beforehand.

On success its **last stdout line** must be JSON, for example this *shape*
(values must describe the browser actually verified):

```json
{"ready":true,"freshProfile":true,"browserVersion":"actual version","browserMode":"headed","env":{}}
```

`env` is an optional map of connection settings for that installed version
(for example its documented CDP endpoint). The hook is trusted coordinator
code; do not replace Codex authentication, configuration, or benchmark paths
through this map. Cleanup must stop only this trial's browser/relay/daemon,
also after partially failed setup, and return exit code zero. A failed setup
or cleanup is preserved as a failure. No invented Windows pairing command is
provided. Current Browser Use is installed deliberately; do not label these
results as a pinned legacy browser-harness revision.

## Evidence and reporting

`results/<stack>_<task>.log` holds Codex stdout, `.log.stderr` its stderr,
`.prompt.txt` the dispatched prompt, `.answer.txt` the dedicated `codex -o`
final message, and `.evidence.json` server state. The evaluator considers only
the last nonempty answer line: one receipt token or a JSON array with numeric
prices, sorted by id. Debug/transcript receipt mentions cannot earn success.
Only final commits count; draft writes are permitted for application/booking.
Catalog requires zero writes. Any extra final submission fails, even if its
fields match. HTTP reset and state endpoints are evaluator-only by protocol.

`results.jsonl` records every attempted trial, including setup errors,
timeouts, Codex errors, success, receipt/count, elapsed time and CLI tokens.
Unknown usage breakdowns and browser versions remain null. The CLI's `tokens
used` is preserved as its own metric, not misrepresented as verified provider
input + output usage. Logs include skill reads, schemas and generated helper
work; generated helper files remain in each trial workspace. Setup is outside
agent wall time. A usage-limit message kills the active process tree and
stops subsequent trials; the report shows the remaining combinations as
not run. Ctrl+C stops the active process tree and server; an interrupted
partial trial may have logs without a JSONL record. Archive `results/` before
rerunning; the runner refuses to mix trials or overwrite existing records.

Standalone evaluation and report paths can be specified explicitly:

```powershell
node benchmarks/e2e-agent/evaluate.mjs http://127.0.0.1:8080 application answer.txt
node benchmarks/e2e-agent/report.mjs path/to/results.jsonl path/to/report.md
```

Do not publish credentials, personal browser data or unsanitized transcripts.
No real E2E_RESULTS.md is generated until trial records exist.
