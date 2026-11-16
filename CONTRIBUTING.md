# Contributing

turbo-browser-mcp is a one-person project. Issues and pull requests are welcome, and replies are best effort.

The goal is the fastest and most token-efficient browser MCP server, with a submit guard that is on by default. Changes are judged against that goal.

## Setup

You need Node 20 or newer.

```bash
git clone https://github.com/Tthanh2k6/turbo-browser-mcp.git
cd turbo-browser-mcp
npm install
npm test
npm run doctor
npm run benchmark
```

- `npm test` runs the tests in `test/*.test.mjs`.
- `npm run doctor` prints Node, Playwright, Chromium and CDP diagnostics as JSON.
- `npm run benchmark` measures per-tool output tokens and timing, and the tool schema size.

If no browser is found, run `npx playwright-core install chromium`.

## Style

- ESM (`.mjs`), as in `src/`.
- Add no new dependency without opening a discussion first. The only runtime dependency today is `playwright-core`.
- Add a test with every behavior change or bug fix.

## Tool schema size

Every byte of tool schema is sent to the model on every turn. Before you add a tool, a parameter or a longer description, check whether an existing parameter can give the same result. If you change a tool definition, run `npm run benchmark` before and after, and put the change in compact schema tokens in the pull request. The README notes that `expect`, `submissionKey` and `allowDuplicate` are declared only on `batch_actions`, and that the network guard is switched on by environment variable, to keep the schema small.

## Safety rules

These four must not get weaker. A pull request that loosens one needs a stated reason and a test that shows what changes.

- Submit guard: final-commit buttons stay blocked unless `allowSubmit` is set.
- Network guard: when enabled, blocked requests stay blocked and are reported.
- Ledger: a repeated `submissionKey` is refused unless `allowDuplicate` is set.
- Path confinement: files are read and written only inside `TURBO_BROWSER_SAVE_ROOT` or the working directory.

## Agent benchmark

The agent benchmark runs a coding agent against local fixture sites with each browser stack. Setup, commands and rules are in [benchmarks/e2e-agent/README.md](benchmarks/e2e-agent/README.md). The plan is in [benchmarks/E2E_PLAN.md](benchmarks/E2E_PLAN.md) and the current results are in [benchmarks/E2E_RESULTS.md](benchmarks/E2E_RESULTS.md). If you publish numbers from it, keep the transcripts and server evidence.

## Pull requests

Fill in the pull request template. Keep one change per pull request.

## Security

Do not report security problems in public issues. See [SECURITY.md](SECURITY.md).
