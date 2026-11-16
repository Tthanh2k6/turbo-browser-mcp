import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export function evaluate(task, state, finalAnswer) {
  const answer = String(finalAnswer).trim().split(/\r?\n/).at(-1) || '';
  const reasons = [];
  if (task === 'catalog') {
    let rows; try { rows = JSON.parse(answer); } catch { reasons.push('Last line is not JSON'); }
    // The task prompt does not say prices must be JSON numbers, so a numeric string such as "25.75" is accepted.
    if (Array.isArray(rows)) rows = rows.map(r => (r && typeof r.price === 'string' && /^\d+(\.\d+)?$/.test(r.price.trim())) ? { ...r, price: Number(r.price) } : r);
    if (!isDeepStrictEqual(rows, state.expectedRows)) reasons.push('Rows must exactly match all 37 rows, sorted by id, with prices equal to the listed values');
    if (state.writes !== 0) reasons.push('Catalog task performed writes');
  } else if (task === 'application' || task === 'booking') {
    const s = state[task], r = s.records[0];
    if (s.commits !== 1 || s.records.length !== 1) reasons.push('Expected exactly one final commit and record');
    const expected = { name: 'Alex Nguyen', email: 'alex@example.test', ...(task === 'application' ? { region: 'Region 150', hash: state.attachmentHash } : { type: 'remote', date: '2030-06-18', time: '10:00' }) };
    if (!r || Object.entries(expected).some(([k,v]) => r[k] !== v)) reasons.push('Stored fields or uploaded bytes differ');
    const receipts = answer.match(/\b(?:APP|BOOK)-\d+\b/g) || [];
    if (!r || receipts.length !== 1 || receipts[0] !== r.receipt) reasons.push('Reported receipt does not uniquely resolve to the record');
    if (task === 'booking' && s.drafts < 1) reasons.push('Missing draft XHR');
    const other = task === 'application' ? 'booking' : 'application';
    if (state[other].commits) reasons.push('Unexpected commit to another task');
  } else reasons.push('Unknown task');
  return { success: reasons.length === 0, failureReason: reasons.join('; ') || null, receipt: state[task]?.records[0]?.receipt ?? null, finalCommitCount: state.application.commits + state.booking.commits };
}
export async function evaluateRemote(base, task, answer) {
  const response = await fetch(`${base}/__eval/state`);
  if (!response.ok) throw new Error(`Evaluator HTTP ${response.status}`);
  const state = await response.json();
  return { ...evaluate(task, state, answer), evidence: state };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , base, task, answerFile] = process.argv;
  console.log(JSON.stringify(await evaluateRemote(base, task, readFileSync(answerFile, 'utf8'))));
}
