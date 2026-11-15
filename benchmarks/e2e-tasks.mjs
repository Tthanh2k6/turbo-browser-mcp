#!/usr/bin/env node
/**
 * End-to-end task benchmark on local fixture pages (no internet).
 *
 * T1  Portal wizard: fill 6 fields, press 다음, confirm 확인 inside a modal, land on a receipt page.
 *     turbo-browser-mcp (1 batch_actions call with expect + submissionKey)
 *     vs a one-action-per-call baseline that returns a full ARIA snapshot after each action
 *     (the response shape of Playwright MCP's browser_* tools).
 * T2  Safety: the agent wrongly clicks a commit while it should only prefill.
 *     Counts the commit requests the server actually received.
 *
 * Other agent stacks (browser-use / browser-harness, browse, agent-browser) are not run here;
 * see benchmarks/E2E_COMPARISON.md for how to run the same fixtures with them.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, batchActions, inspectCompact } from '../src/dom-engine.mjs';

function countTokensBatch(payloadMap) {
  const keys = Object.keys(payloadMap);
  const pyScript =
    'import sys,json,tiktoken\n' +
    'enc=tiktoken.get_encoding("o200k_base")\n' +
    'data=json.load(sys.stdin)\n' +
    'print(json.dumps({k:len(enc.encode(v)) for k,v in data.items()}))\n';
  for (const pyBin of ['python', 'python3']) {
    try {
      const res = spawnSync(pyBin, ['-W', 'ignore', '-X', 'utf8', '-c', pyScript], {
        input: JSON.stringify(payloadMap),
        encoding: 'utf8',
        timeout: 8000,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (res.status === 0 && res.stdout) {
        const parsed = JSON.parse(res.stdout.trim());
        if (keys.every((k) => Number.isFinite(parsed[k]))) return { tokenizer: 'tiktoken (o200k_base)', counts: parsed };
      }
    } catch {}
  }
  const counts = {};
  for (const k of keys) counts[k] = Math.max(1, Math.ceil(String(payloadMap[k] ?? '').length / 3.8));
  return { tokenizer: 'approx-bpe', counts };
}

// Payload of turn i is re-read on every later turn by a chat agent, so cumulative cost = sum((n - i) * tokens_i).
function cumulative(list) {
  return list.reduce((acc, t, i) => acc + (list.length - i) * t, 0);
}

const FIELDS = [
  ['name', '이름', '홍길동'],
  ['birth', '생년월일', '1990-01-01'],
  ['phone', '휴대전화', '010-1234-5678'],
  ['email', '이메일', 'hong@example.kr'],
  ['title', '작품 제목', '가을 산책'],
  ['memo', '작품 설명', '단풍길을 걸으며 찍은 사진입니다.'],
];

function wizardHtml() {
  const nav = Array.from({ length: 20 }, (_, i) => `<a href="#n${i}">안내 ${i + 1}</a>`).join(' ');
  const notices = Array.from({ length: 10 }, (_, i) => `<li>공지사항 ${i + 1}: 접수 기간과 제출 서류를 확인하세요.</li>`).join('');
  const inputs = FIELDS.map(
    ([id, label]) => `<div class="row"><label for="${id}">${label}</label>${
      id === 'memo' ? `<textarea id="${id}" name="${id}"></textarea>` : `<input id="${id}" name="${id}">`
    }</div>`
  ).join('\n');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>공모전 접수</title></head><body>
<header><nav aria-label="주 메뉴">${nav}</nav></header>
<main>
  <h1>사진 공모전 참가 신청</h1>
  <ul>${notices}</ul>
  <form id="f" onsubmit="return false">${inputs}
    <button id="next" type="button" onclick="document.getElementById('dlg').style.display='block'">다음</button>
  </form>
  <div id="dlg" role="dialog" aria-modal="true" aria-label="최종 확인" style="display:none">
    <p>입력하신 내용으로 제출하시겠습니까? 제출 후에는 수정할 수 없습니다.</p>
    <button id="confirm" type="button" onclick="fetch('/commit',{method:'POST',body:new FormData(document.getElementById('f'))}).then(r=>r.json()).then(j=>{location.href='/receipt?id='+j.id})">확인</button>
    <button id="cancel" type="button" onclick="document.getElementById('dlg').style.display='none'">취소</button>
  </div>
  <button id="save" type="button" onclick="fetch('/commit',{method:'POST',body:'draft'})">Save</button>
</main></body></html>`;
}

function startServer() {
  const telemetry = { commits: 0 };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'POST' && u.pathname === '/commit') {
      telemetry.commits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `R-${10000 + telemetry.commits}` }));
      return;
    }
    if (u.pathname === '/receipt') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><meta charset="utf-8"></head><body><h1>접수 완료</h1><p>접수번호 ${u.searchParams.get('id')}</p></body></html>`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(wizardHtml());
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}`, telemetry }))
  );
}

async function openPage(manager, url) {
  await manager.tabsBatch([{ action: 'open', url, waitUntil: 'load' }]);
  return (await manager.getPage()).page;
}

async function main() {
  const { server, baseUrl, telemetry } = await startServer();
  const manager = new BrowserManager({ mode: 'launch', headless: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-e2e-'));
  process.env.TURBO_BROWSER_LEDGER = path.join(tmpDir, 'ledger.jsonl');
  const payloads = {};
  try {
    await openPage(manager, `${baseUrl}/warmup`);

    // ---- T1 baseline: one action per call, full ARIA snapshot back each time ----
    telemetry.commits = 0;
    const basePage = await openPage(manager, `${baseUrl}/wizard`);
    const baseTurns = [];
    const b0 = Date.now();
    baseTurns.push(await basePage.locator('body').ariaSnapshot());
    const baseSteps = [
      ...FIELDS.map(([id, , value]) => ({ action: 'fill', selector: `#${id}`, value })),
      { action: 'click', selector: '#next' },
      { action: 'click', selector: '#confirm', allowSubmit: true },
    ];
    for (const step of baseSteps) {
      await actFast(basePage, step);
      if (step.selector === '#confirm') await basePage.waitForURL(/\/receipt/, { timeout: 5000 });
      baseTurns.push(JSON.stringify(step) + '\n' + (await basePage.locator('body').ariaSnapshot()));
    }
    const baseMs = Date.now() - b0;
    const baseVerified = /R-\d+/.test(baseTurns[baseTurns.length - 1]);
    const baseCommits = telemetry.commits;

    // ---- T1 turbo: one batch_actions call with expect + submissionKey ----
    telemetry.commits = 0;
    const turboPage = await openPage(manager, `${baseUrl}/wizard`);
    const t0 = Date.now();
    // Same starting point as the baseline: the agent first looks at the page once.
    const firstLook = await inspectCompact(turboPage, { mode: 'interactive', maxChars: 4000 });
    const turboRes = await batchActions(
      turboPage,
      [
        { action: 'smart_fill_form', fields: FIELDS.map(([id, , value]) => ({ selector: `#${id}`, value })) },
        { action: 'click', selector: '#next' },
        { action: 'click', selector: '#confirm' },
      ],
      { allowSubmit: true, submissionKey: 'e2e-wizard-1', expect: { textMatches: '접수번호 R-\\d+', timeoutMs: 5000 } }
    );
    const turboMs = Date.now() - t0;
    const turboTurns = [firstLook.text, JSON.stringify(turboRes)];
    const turboCommits = telemetry.commits;

    // Re-run with the same key: the ledger must refuse.
    telemetry.commits = 0;
    const rerunPage = await openPage(manager, `${baseUrl}/wizard`);
    const rerun = await batchActions(
      rerunPage,
      [
        { action: 'smart_fill_form', fields: FIELDS.map(([id, , value]) => ({ selector: `#${id}`, value })) },
        { action: 'click', selector: '#next' },
        { action: 'click', selector: '#confirm' },
      ],
      { allowSubmit: true, submissionKey: 'e2e-wizard-1', expect: { textMatches: '접수번호 R-\\d+', timeoutMs: 3000 } }
    );
    const rerunCommits = telemetry.commits;

    baseTurns.forEach((t, i) => (payloads[`base_${i}`] = t));
    turboTurns.forEach((t, i) => (payloads[`turbo_${i}`] = t));
    const { tokenizer, counts } = countTokensBatch(payloads);
    const baseTok = baseTurns.map((_, i) => counts[`base_${i}`]);
    const turboTok = turboTurns.map((_, i) => counts[`turbo_${i}`]);

    // ---- T2 safety: the agent clicks a commit while it should only prefill ----
    const safety = [];
    const trial = async (label, fn) => {
      telemetry.commits = 0;
      const page = await openPage(manager, `${baseUrl}/wizard`);
      const res = await fn(page);
      await page.waitForTimeout(300);
      safety.push({ case: label, blocked: Boolean(res?.blocked), blockedBy: res?.blockedBy || null, commitsReceived: telemetry.commits });
    };
    await trial('plain Playwright click on modal 확인', async (page) => {
      await page.click('#next');
      await page.click('#confirm');
      return null;
    });
    await trial('turbo act_fast on modal 확인 (allowSubmit=false)', async (page) => {
      await actFast(page, { action: 'click', selector: '#next' });
      return actFast(page, { action: 'click', selector: '#confirm' });
    });
    await trial('turbo act_fast on "Save" that POSTs (label guard only)', async (page) =>
      actFast(page, { action: 'click', selector: '#save' })
    );
    await trial('turbo act_fast on "Save" that POSTs (networkGuard=true)', async (page) =>
      actFast(page, { action: 'click', selector: '#save', networkGuard: true })
    );

    const results = {
      tokenizer,
      t1: {
        baseline: {
          calls: baseTurns.length,
          tokensLastTurn: baseTok[baseTok.length - 1],
          tokensAllTurns: baseTok.reduce((a, b) => a + b, 0),
          tokensCumulative: cumulative(baseTok),
          ms: baseMs,
          commits: baseCommits,
          verified: baseVerified ? 'by reading the final snapshot' : 'no',
        },
        turbo: {
          calls: turboTurns.length,
          tokensAllTurns: turboTok.reduce((a, b) => a + b, 0),
          tokensCumulative: cumulative(turboTok),
          ms: turboMs,
          commits: turboCommits,
          verified: turboRes.submitVerified ? `submitVerified=true (${turboRes.evidence?.value})` : 'no',
        },
        rerunSameKey: { blocked: Boolean(rerun.blocked), blockedBy: rerun.blockedBy || rerun.results?.at(-1)?.blockedBy || null, commits: rerunCommits },
      },
      t2: safety,
    };

    const b = results.t1.baseline;
    const t = results.t1.turbo;
    console.log(`\nE2E task benchmark (tokenizer: ${tokenizer})\n`);
    console.log('T1 portal wizard: 6 fields + 다음 + modal 확인 + receipt');
    console.log('| | calls | tokens returned | cumulative context tokens | ms | commits | verified |');
    console.log('|---|---|---|---|---|---|---|');
    console.log(`| one action per call + ARIA snapshot | ${b.calls} | ${b.tokensAllTurns} | ${b.tokensCumulative} | ${b.ms} | ${b.commits} | ${b.verified} |`);
    console.log(`| turbo inspect_compact + 1 batch_actions with expect | ${t.calls} | ${t.tokensAllTurns} | ${t.tokensCumulative} | ${t.ms} | ${t.commits} | ${t.verified} |`);
    console.log(`Re-run with same submissionKey: blocked=${results.t1.rerunSameKey.blocked} (${results.t1.rerunSameKey.blockedBy}), commits=${results.t1.rerunSameKey.commits}\n`);
    console.log('T2 safety: agent clicks a commit while it should only prefill');
    console.log('| case | blocked | by | commit requests received |');
    console.log('|---|---|---|---|');
    for (const s of safety) console.log(`| ${s.case} | ${s.blocked} | ${s.blockedBy || '-'} | ${s.commitsReceived} |`);
    console.log('\nRaw JSON:\n' + JSON.stringify(results, null, 2));
  } finally {
    await manager.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
