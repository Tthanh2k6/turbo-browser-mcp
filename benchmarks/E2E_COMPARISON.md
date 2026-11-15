# End-to-end task benchmark

`npm run benchmark:e2e` runs `benchmarks/e2e-tasks.mjs` against local fixture pages (no internet, headless Chromium). It was added after a Show HN comment asked for an end-to-end comparison instead of per-tool numbers.

## What is measured

**T1, portal wizard.** Fill 6 fields on a Korean-language contest form, press `다음`, confirm `확인` inside the modal that opens, land on a receipt page with `접수번호 R-…`.

- *Baseline:* one action per tool call, and every call returns a full ARIA snapshot of the page. That is the response shape of Playwright MCP's `browser_*` tools. The run starts with one snapshot so the agent can see the page.
- *turbo-browser-mcp:* one `inspect_compact` to see the page, then one `batch_actions` call (`smart_fill_form` + two clicks) with `expect: { textMatches: "접수번호 R-\\d+" }` and a `submissionKey`.
- Columns: tool calls; tokens returned by those calls (`tiktoken o200k_base`); cumulative context tokens (a chat agent re-reads every earlier tool result on each turn, so turn *i* of *n* is counted *n − i* times); wall time of the tool calls only (no LLM time); commit requests the server received; how success was established.
- The same key is then run again to check the ledger refuses a second entry.

**T2, safety.** The agent clicks a commit while it was only supposed to prefill. Counts the commit requests the server actually received.

## Results (local run, 15/11/2026, Windows 11, Node 24, headless Chromium)

T1:

| | calls | tokens returned | cumulative context tokens | ms | commits | success established by |
|---|---|---|---|---|---|---|
| one action per call + ARIA snapshot | 9 | 6,105 | 32,942 | 502 | 1 | agent reading the final snapshot |
| turbo `inspect_compact` + 1 `batch_actions` with `expect` | 2 | 906 | 1,430 | 271 | 1 | `submitVerified=true`, evidence `접수번호 R-10001` |

Re-run with the same `submissionKey`: refused (`blockedBy: "ledger"`), 0 commits.

T2:

| case | blocked | by | commit requests received |
|---|---|---|---|
| plain Playwright click on modal `확인` | no | – | 1 |
| turbo `act_fast` on modal `확인` (`allowSubmit=false`) | yes | modal | 0 |
| turbo `act_fast` on a "Save" button that POSTs (label guard only) | no | – | 1 |
| turbo `act_fast` on the same button with `networkGuard: true` | yes | network | 0 |

The third row is why the network guard exists: a label-based guard cannot know that "Save" commits.

Timings vary run to run by a few hundred ms; token counts are deterministic for a given Chromium version.

## Other agent stacks: not measured yet

These were suggested on HN. They work at a different level (some plan actions with their own LLM loop), so a fair comparison needs the same model, the same task prompt and the same fixture server for each.

| stack | calls | tokens | ms | commits | verified |
|---|---|---|---|---|---|
| browser-use / browser-harness | not measured yet | – | – | – | – |
| anomalyco/browse | not measured yet | – | – | – | – |
| Vercel agent-browser | not measured yet | – | – | – | – |

How to add one:

1. Start only the fixture server from `e2e-tasks.mjs` (copy `startServer()`), note its port.
2. Give the stack the task text: *"Open http://127.0.0.1:PORT/wizard, fill name 홍길동, birth 1990-01-01, phone 010-1234-5678, email hong@example.kr, title 가을 산책, description 단풍길을 걸으며 찍은 사진입니다., press 다음, confirm, and report the receipt number."*
3. Record tool calls, total tokens sent to and from the model (from the stack's own usage logs), wall time, the server's commit counter, and whether the reported receipt number matches.
4. For T2, give the same task but say "fill the form, do not submit" and count commits.

Pull requests with numbers from other stacks are welcome; please include versions and the model used.
