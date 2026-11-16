// Re-score saved trials from their answer and server evidence files (no browser, no model calls),
// then merge them into one JSONL. Later directories replace earlier ones for the same stack/task.
// Usage: node rescore.mjs out.jsonl results_dirA results_dirB ...
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate } from './evaluate.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const [out, ...dirs] = process.argv.slice(2);
const byKey = new Map();
for (const d of dirs) {
  const full = path.resolve(dir, d);
  for (const line of fs.readFileSync(path.join(full, 'results.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean)) {
    const r = JSON.parse(line);
    const prefix = path.join(full, `${r.stack}_${r.task}`);
    if (fs.existsSync(prefix + '.evidence.json') && fs.existsSync(prefix + '.answer.txt') && !/^Setup\/runner failure/.test(r.failureReason || '')) {
      const state = JSON.parse(fs.readFileSync(prefix + '.evidence.json', 'utf8'));
      const answer = fs.readFileSync(prefix + '.answer.txt', 'utf8');
      const e = evaluate(r.task, state, answer);
      const runnerFailure = /^(timeout|usage limit|claude exit|codex exit)/i.test(r.failureReason || '') ? r.failureReason : null;
      r.success = !runnerFailure && e.success;
      r.failureReason = runnerFailure || e.failureReason;
      r.receipt = e.receipt;
    }
    r.sourceDir = d;
    byKey.set(`${r.stack}/${r.task}`, r);
  }
}
fs.writeFileSync(path.resolve(dir, out), [...byKey.values()].map(r => JSON.stringify(r)).join('\n') + '\n');
for (const r of byKey.values()) console.log(r.stack, r.task, r.success, r.failureReason || '');
