import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const input = process.argv[2] || fileURLToPath(new URL('./results/results.jsonl', import.meta.url));
const output = process.argv[3] || fileURLToPath(new URL('../E2E_RESULTS.md', import.meta.url));
const records = fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const escape = value => String(value ?? 'unknown').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
const seen = new Set();
for (const r of records) { const key = `${r.stack}/${r.task}`; if (seen.has(key)) throw new Error(`Duplicate trial: ${key}`); seen.add(key); }
let report = '# Agent end-to-end results (stage 1)\n\n| Stack | Task | Success | Tokens (CLI) | Seconds | Failure |\n| --- | --- | --- | ---: | ---: | --- |\n';
for (const stack of ['turbo','agent-browser','browse','browser-harness']) for (const task of ['application','catalog','booking']) {
  const r = records.find(r => r.stack === stack && r.task === task);
  report += `| ${stack} | ${task} | ${r ? (r.success ? 'yes' : 'no') : 'not run'} | ${r?.tokens ?? 'unknown'} | ${r?.elapsedMs == null ? 'unknown' : (r.elapsedMs / 1000).toFixed(2)} | ${escape(r?.failureReason ?? (r ? '' : 'not run'))} |\n`;
}
report += '\nOne trial per stack/task; same host agent = Codex. Abstraction levels differ (CLI commands, MCP calls, generated helpers). This stage uses a six-minute timeout and fixed order, not the full randomized ten-trial protocol. No statistical winner can be inferred. Setup failures and timeouts count as failures; not-run trials are not successes.\n\nTokens are the number printed by Codex as `tokens used`; missing counts remain unknown. This is not asserted to be provider-reported input + output usage. Cached/reasoning/input/output breakdowns and turns are unavailable in this adapter. Browser versions/modes may differ; null metadata means unmeasured. browser-harness labels the current browser-use engine. Setup time is excluded from agent wall time. Instruction files, runtime schemas and CLI skill reads enter agent context. Preserve JSONL, prompts, transcripts, final answers and server evidence with this report.\n';
fs.writeFileSync(output, report);
console.log(output);
