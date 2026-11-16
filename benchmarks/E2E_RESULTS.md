# Agent end-to-end results, stage 1 (16 Nov 2026)

One coding agent, three tasks on local fixture sites, four browser stacks, one trial per cell. The plan and success checks are in [E2E_PLAN.md](E2E_PLAN.md); the harness is in [e2e-agent/](e2e-agent/).

**Setup.** Host agent: Claude Code 2.1.325 with Claude Sonnet 5.5 (`--model sonnet`), run with no user settings, skills or CLAUDE.md and only the MCP server of the stack under test (`--setting-sources project --disable-slash-commands --strict-mcp-config`, `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`). Every trial gets the same task prompt plus a short instruction file for its stack ([e2e-agent/stacks/](e2e-agent/stacks/)). Windows 11, Node 24.15. Stacks: turbo-browser-mcp 0.6.1 (MCP, headless Chromium), agent-browser 0.43.0 (CLI, headless), browse 0.0.17 (MCP through its Chrome extension, headed Chrome 157 in a separate empty profile), browser-use 1.0.5 as browser-harness (`--cli-mcp`, headed Chrome 157 with a fresh profile).

**Success** is decided by the fixture server, not by the agent's answer: exactly one committed record with the right fields and uploaded file bytes, a receipt in the answer that matches that record, the draft request on the booking flow, and for the catalog all 37 in-stock rows in order with the right prices.

| Stack | Task | Success | Turns | Tokens | Output tokens | Cost (USD) | Seconds |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| turbo-browser-mcp | application | yes | 23 | 995,969 | 2,605 | 0.205 | 44.5 |
| turbo-browser-mcp | catalog | yes | 12 | 435,266 | 2,038 | 0.110 | 24.0 |
| turbo-browser-mcp | booking | yes | 7 | 288,274 | 897 | 0.080 | 17.3 |
| agent-browser | application | yes | 10 | 503,237 | 1,240 | 0.114 | 51.0 |
| agent-browser | catalog | yes | 10 | 544,208 | 2,595 | 0.184 | 57.2 |
| agent-browser | booking | yes | 13 | 665,379 | 2,023 | 0.142 | 88.6 |
| browse | application | yes | 8 | 376,136 | 827 | 0.082 | 38.0 |
| browse | catalog | yes | 5 | 235,018 | 1,849 | 0.082 | 29.1 |
| browse | booking | yes | 7 | 324,687 | 797 | 0.073 | 51.5 |
| browser-use (browser-harness) | application | yes | 10 | 470,446 | 1,609 | 0.098 | 32.0 |
| browser-use (browser-harness) | catalog | yes | 6 | 280,870 | 1,873 | 0.084 | 29.4 |
| browser-use (browser-harness) | booking | yes | 17 | 830,951 | 2,655 | 0.162 | 59.2 |

Totals over the three tasks:

| Stack | Turns | Cost (USD) | Seconds |
| --- | ---: | ---: | ---: |
| turbo-browser-mcp | 42 | 0.395 | 85.8 |
| agent-browser | 33 | 0.440 | 196.8 |
| browse | 20 | 0.237 | 118.6 |
| browser-use | 33 | 0.344 | 120.6 |

**What this does and does not show.**

- All 12 trials succeeded. With one trial per cell, no stack can be called better; a second run could reorder every column. The ten-trial randomized protocol in the plan has not been run.
- turbo-browser-mcp had the shortest wall time on catalog and booking and in total; browser-use and browse were faster on the application task. turbo-browser-mcp and agent-browser ran headless while browse and browser-use drove a visible Chrome, which is slower to render.
- browse was the cheapest in total. turbo-browser-mcp's application run took 23 turns and cost the most of any trial; the json output does not record which tool calls were made, so the cause is not known yet. The next stage should log the full transcript (`--output-format stream-json`).
- "Tokens" is input (including cache reads and cache writes) plus output for the main model, from Claude Code's `--output-format json` usage. Because cached context is counted again on every turn, it grows with the number of turns. An empty run with no MCP server already uses about 36,000 per turn for Claude Code's own system prompt and built-in tools, the same for every stack. Cost is Claude Code's `total_cost_usd` at list prices.
- Seconds is the agent's wall time; browser setup by the hook is excluded.

**Changes made during the run, applied to every trial.**

- The catalog prompt does not say that prices must be JSON numbers. The first evaluator required numbers, and two runs (browse, browser-use) returned the correct prices as strings such as `"25.75"`. The evaluator now accepts numeric strings, and all saved answers were re-scored from their stored answer and server evidence with [e2e-agent/rescore.mjs](e2e-agent/rescore.mjs), without new model calls.
- The first browse attempts failed in the harness, not in browse: a broken path in the setup hook, then the runner moved the XDG directories that hold the extension pairing token, then a relay started earlier without `OPENCODE_BROWSER_FILE_ROOTS` refused the attachment. Each was fixed and the trial was run again; the table shows the run after the fix.
- An earlier stage with Codex (GPT-6 Astra, medium) as host finished 5 of the 12 cells before the account hit its usage limit; all 5 succeeded. Those runs count tokens differently and are not merged here.

Raw records: [e2e-agent/results_claude_all.jsonl](e2e-agent/results_claude_all.jsonl). Transcripts, prompts, answers and server evidence stay in the local `results_claude*` folders, which are not committed.
