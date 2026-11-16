# End-to-end comparison plan

Status: stage one has been run (16 Nov 2026), one trial per stack and task; see
[E2E_RESULTS.md](E2E_RESULTS.md). The full ten-trial protocol below has not been
run. See [e2e-agent/README.md](e2e-agent/README.md) for fixtures, evaluation,
installation and run instructions. Stage one used a six-minute timeout.
The existing `npm.cmd run benchmark:e2e` is a scripted local wizard/safety
benchmark, not an agent comparison. Its results in [E2E_COMPARISON.md](E2E_COMPARISON.md)
must not be presented as measurements of the stacks below.

snake_doc requested complete browser tasks; lukevp noted the abstraction-level
difference. Compare an agent using turbo-browser-mcp with an agent using each
other stack. Tool batching, shell commands, generated helpers, and MCP actions
are different units. Count them separately and compare task success, model
usage, and elapsed time, rather than claiming one tool call equals one command.

## Tasks and independent success checks

The shared local HTTP fixture server in `e2e-agent/server.mjs` implements these
routes. They are separate from the scripted `e2e-tasks.mjs` benchmark.
The agent sees only the task, browser and attachment path; the evaluator owns
the server state, expected rows, and submission counters.

| Task | Identical prompt for every stack | Evaluator success check |
| --- | --- | --- |
| Application | Open `{base}/application`. Enter name Alex Nguyen and email alex@example.test. Select Region 150 from the portaled, searchable 200-option list. Upload `{absoluteAttachmentPath}`. Continue to review, submit once, and report the receipt number. | Stored name/email/region match; uploaded bytes match the supplied file hash; exactly one final commit; reported receipt resolves to that stored record. |
| Search and pagination | Open `{base}/catalog`. Search for adapter, keep only in-stock items, visit every result page, and return a JSON array with id, name, and price sorted by id. | Exact equality with the server's 37 matching rows over four pages; no duplicates or missing rows; no writes. |
| Login-free wizard | Open `{base}/booking`. Choose a remote appointment on 2030-06-18 at 10:00, enter Alex Nguyen and alex@example.test, continue through the draft step, review, confirm once, and report the booking reference. | Draft XHR allowed; saved fields match; exactly one final commit and receipt; no duplicate booking. |

Use a deterministic 48 KiB attachment with a published hash. The application
list mounts at most 20 options. The booking fixture uses a safe-label Continue
XHR and a final Submit navigation. Reset data, browser profile, and any local
submission ledger before each trial. Add a prefill-only variant of task 1 to
measure unintended commits; do not mix it into the primary success rate.

## Protocol and metrics

Use the same host agent, model/version, reasoning settings, task prompts,
context limit, five-minute timeout, and browser version where supported.
Allow only the selected browser stack and necessary file access. No reading
fixture source or server state and no direct HTTP shortcuts. Include each
stack's documented skill/schema in its input-token accounting. Freeze helpers
and configuration per trial; record any helper generation during the trial.

Run ten trials per task per stack in randomized order, with a fresh session
each time. Record failures and timeouts, not only successful runs. Preserve
raw transcripts and server evidence. Report success fractions and median/p90
wall time and tokens, with failed-trial totals alongside successful-trial totals.

| Metric | Definition |
| --- | --- |
| Turns | Model response cycles from initial task to final answer, including recovery; tool calls and shell commands are separate counts. |
| Total tokens | Provider-reported input plus output tokens over all model calls, including replayed context, skills, tool schemas and helper generation; report cached input and reasoning usage separately where available. Never substitute returned DOM tokens for this total. |
| Wall time | Monotonic elapsed time from task dispatch through final answer, including model, tool and retry time. Report installation/browser startup separately. |
| Success | Independent server checks above plus correct final output, within the time budget. Also record final commit count and any unintended submission. |

Store one JSONL record per trial: stack/version/commit, model, settings, task,
seed, OS/Node/browser versions, headless/headed mode, turns, tool calls, input
tokens, cached tokens, output tokens, reasoning tokens when available, elapsed
milliseconds, success, failure reason, receipt, and final commit count. Keep
screenshots and transcripts with secrets removed. Publish all trial records.

## Installation and run entry points (from upstream READMEs, 16 Nov 2026)

The commands below are copied from each project's README. The stage-one run used the pinned versions listed in E2E_RESULTS.md and the setup in e2e-agent/. Pin versions when you repeat it. PowerShell examples
use `npm.cmd`/`npx.cmd`; upstream READMEs spell these `npm`/`npx`.

### browser-use/browser-harness

The [README](https://github.com/browser-use/browser-harness#readme) now directs
users to Browser Use, which contains the harness engine:

```powershell
uv tool install browser-use
browser-use skill install
browser-use --cli-mcp
```

Alternatively, the README shows sending Python helper calls to `browser-use`
on stdin, beginning with `new_tab(...)` and `print(page_info())`. Use its
documented skill with the common host agent and feed each task prompt above.
Connect a fresh test Chrome profile through its documented remote-debugging
setup. Record whether the run uses the current browser-use engine or a pinned
legacy browser-harness revision; do not combine their results. Windows setup,
attachment handling and model usage capture were handled by the stage-one harness (see E2E_RESULTS.md).

### anomalyco/browse

The [README](https://github.com/anomalyco/browse#readme) documents:

```powershell
npx.cmd @opencode/browse install
```

The installer configures the host agent's MCP server and pairs a Chromium
extension. Install into an isolated benchmark user/profile, finish pairing,
then restart or reload the host's MCP connection. Give that host each identical
task prompt with browse as its only browser tool. This is the documented run
workflow; no standalone task-runner command is asserted here. The npm launcher
requires Node 22+ per this README; turbo-browser-mcp retains Node >=20.
Extension pairing and the setup hook are described in e2e-agent/README.md.

### vercel-labs/agent-browser

The [README](https://github.com/vercel-labs/agent-browser#readme) documents:

```powershell
npm.cmd install -g agent-browser
agent-browser install
agent-browser open http://127.0.0.1:PORT/application
agent-browser snapshot -i
```

The URL is a substitution for the README example, not an existing fixture
command. Give the common host agent CLI access and the task prompt; it chooses
actions from snapshots and checks the result until completion. Repeat with
the catalog and booking URLs. The stage-one harness covers installation and usage capture.

## Before publishing more numbers

The stage-one `e2e-agent/server.mjs` entry point prints its base URL and
attachment path; `evaluate.mjs` independently checks outcomes. Its fixture
self-test drives all three tasks directly through Playwright. Before measuring,
configure and smoke-test each actual stack, pin versions, and run the
coordinator's `e2e-agent/run.ps1`. Extend that stage-one adapter for the full
randomized protocol and provider usage accounting above. Report
differences that cannot be controlled, such as extension-only browser modes.
Do not infer a winner from the existing per-tool measurements.
