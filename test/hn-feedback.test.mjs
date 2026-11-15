import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, batchActions } from '../src/dom-engine.mjs';
import { collectAllowPatterns, isCommitLikeRequest, readLedger } from '../src/guards.mjs';
import { dispatchToolCall, parseCliArgs } from '../src/index.mjs';

// Fixtures modelled on reader feedback (dev.to harrysong, HN vidarh) for v0.5.0.
const WIZARD_HTML = (withReceipt) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Portal wizard</title></head>
<body>
  <h1>신청서</h1>
  <label>이름 <input id="name" name="name"></label>
  <button id="next" type="button" onclick="document.getElementById('dlg').style.display='block'">다음</button>
  <div id="dlg" role="dialog" aria-modal="true" style="display:none">
    <p>제출하시겠습니까?</p>
    <button id="confirm" type="button" onclick="fetch('/commit',{method:'POST',body:'x'}).then(()=>{ ${
      withReceipt ? "location.href='/receipt'" : "document.getElementById('dlg').style.display='none'"
    } })">확인</button>
    <button id="cancel" type="button" onclick="document.getElementById('dlg').style.display='none'">취소</button>
  </div>
</body></html>`;

const RECEIPT_HTML = `<!doctype html><html><head><meta charset="utf-8"></head>
<body><h1>접수 완료</h1><p>접수번호 R-12345</p></body></html>`;

const SAVE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <button id="save" type="button" onclick="fetch('/commit',{method:'POST',body:'x'}).then(()=>{document.body.dataset.saved='1'}).catch(()=>{document.body.dataset.saved='failed'})">Save</button>
  <button id="autosave" type="button" onclick="fetch('/autosave',{method:'POST',body:'x'}).then(()=>{document.body.dataset.auto='1'})">Keep</button>
  <button id="noop" type="button" onclick="document.body.dataset.noop='1'">Toggle</button>
  <button id="korean-submit" type="button" onclick="document.body.dataset.k='1'">제출하기</button>
</body></html>`;

const EDGE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <form id="f" method="post" action="/commit"><input name="a" value="1"></form>
  <a id="js-submit" href="#" onclick="HTMLFormElement.prototype.submit.call(document.getElementById('f'));return false">Continue</a>
  <button id="dp-open" type="button" onclick="document.getElementById('dp').style.display='block'">날짜 선택</button>
  <div id="dp" role="dialog" aria-modal="true" style="display:none">
    <div class="calendar" role="grid">1 2 3</div>
    <button id="dp-ok" type="button" onclick="document.getElementById('dp').style.display='none'">확인</button>
  </div>
  <div id="tos" role="dialog" aria-modal="true">
    <p>By submitting you agree to our privacy policy and consent to processing.</p>
    <button id="tos-ok" type="button" onclick="fetch('/commit',{method:'POST'})">확인</button>
  </div>
  <div id="cookies" role="dialog" aria-label="Cookie settings">
    <p>We use cookies.</p>
    <button id="cookie-ok" type="button" onclick="this.parentNode.remove()">OK</button>
  </div>
</body></html>`;

const HUMAN_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <p id="status">Checking your browser…</p>
  <script>setTimeout(() => {
    document.getElementById('status').textContent = 'Welcome back';
    const d = document.createElement('div'); d.id = 'logged-in'; d.textContent = 'Signed in'; document.body.appendChild(d);
  }, 600);</script>
</body></html>`;

describe('v0.5.0 reader feedback: submit evidence, ledger, modal/network guard, human handoff', () => {
  let server;
  let baseUrl;
  let manager;
  let tmpDir;
  const counts = { commit: 0, autosave: 0 };

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-hn-'));
    server = http.createServer((req, res) => {
      const u = new URL(req.url || '/', 'http://127.0.0.1').pathname;
      if (req.method === 'POST' && u === '/commit') {
        counts.commit += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      if (req.method === 'POST' && u === '/autosave') {
        counts.autosave += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      const pages = {
        '/wizard': WIZARD_HTML(true),
        '/wizard-noreceipt': WIZARD_HTML(false),
        '/receipt': RECEIPT_HTML,
        '/save': SAVE_HTML,
        '/human': HUMAN_HTML,
        '/edge': EDGE_HTML,
      };
      res.writeHead(pages[u] ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pages[u] || 'not found');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    manager = new BrowserManager({ mode: 'launch', headless: true });
  });

  after(async () => {
    delete process.env.TURBO_BROWSER_LEDGER;
    await manager?.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    counts.commit = 0;
    counts.autosave = 0;
    process.env.TURBO_BROWSER_LEDGER = path.join(tmpDir, `ledger-${Date.now()}-${Math.random()}.jsonl`);
  });

  async function open(route) {
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}${route}`, waitUntil: 'load' }]);
    return (await manager.getPage()).page;
  }

  it('blocks the modal 확인 commit after a harmless 다음 step when allowSubmit=false', async () => {
    const page = await open('/wizard');
    const nextRes = await actFast(page, { action: 'click', selector: '#next' });
    assert.equal(nextRes.blocked, undefined);
    const res = await actFast(page, { action: 'click', selector: '#confirm' });
    assert.equal(res.blocked, true);
    assert.equal(res.blockedBy, 'modal');
    assert.equal(counts.commit, 0);
    const cancel = await actFast(page, { action: 'click', selector: '#cancel' });
    assert.ok(!cancel.blocked, 'cancel inside a dialog stays clickable');
  });

  it('blocks Korean submit labels such as 제출하기', async () => {
    const page = await open('/save');
    const res = await actFast(page, { action: 'click', selector: '#korean-submit' });
    assert.equal(res.blocked, true);
    assert.equal(res.blockedBy, 'label');
  });

  it('reports submitVerified=true with evidence from the next page', async () => {
    const page = await open('/wizard');
    await actFast(page, { action: 'click', selector: '#next' });
    const res = await actFast(page, {
      action: 'click',
      selector: '#confirm',
      allowSubmit: true,
      expect: { textMatches: 'R-\\d+', timeoutMs: 5000 },
    });
    assert.equal(res.submitVerified, true);
    assert.equal(res.evidence.type, 'text');
    assert.match(res.evidence.value, /R-12345/);
    assert.equal(counts.commit, 1);
  });

  it('reports submitVerified=false when the click lands but no receipt appears', async () => {
    const page = await open('/wizard-noreceipt');
    await actFast(page, { action: 'click', selector: '#next' });
    const res = await actFast(page, {
      action: 'click',
      selector: '#confirm',
      allowSubmit: true,
      expect: { textMatches: 'R-\\d+', urlMatches: '/receipt', timeoutMs: 600 },
    });
    assert.equal(res.ok, true);
    assert.equal(res.submitVerified, false);
    assert.match(res.verifyReason, /NOT confirmed/);
    assert.equal(counts.commit, 1);
  });

  it('refuses a second submit with the same submissionKey unless allowDuplicate=true', async () => {
    const run = async (extra = {}) => {
      const page = await open('/wizard');
      await actFast(page, { action: 'click', selector: '#next' });
      return actFast(page, {
        action: 'click',
        selector: '#confirm',
        allowSubmit: true,
        submissionKey: 'portal-a:2026-11-15:entry-1',
        expect: { textMatches: 'R-\\d+', timeoutMs: 5000 },
        ...extra,
      });
    };
    const first = await run();
    assert.equal(first.submitVerified, true);
    const entries = readLedger(process.env.TURBO_BROWSER_LEDGER);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].submitVerified, true);
    assert.match(entries[0].finalUrl, /\/receipt$/);

    const second = await run();
    assert.equal(second.blocked, true);
    assert.equal(second.blockedBy, 'ledger');
    assert.equal(counts.commit, 1);

    const third = await run({ allowDuplicate: true });
    assert.equal(third.submitVerified, true);
    assert.equal(counts.commit, 2);
    assert.equal(readLedger(process.env.TURBO_BROWSER_LEDGER).length, 2);
  });

  it('rejects a ledgerPath outside the allowed save root', async () => {
    const page = await open('/save');
    await assert.rejects(
      actFast(page, {
        action: 'click',
        selector: '#noop',
        allowSubmit: true,
        submissionKey: 'k',
        ledgerPath: path.join(os.tmpdir(), '..', 'tbm-outside-ledger.jsonl'),
      }),
      /outside allowed root/
    );
  });

  it('network guard blocks a same-site POST from a button with a harmless label', async () => {
    const page = await open('/save');
    const unguarded = await actFast(page, { action: 'click', selector: '#save' });
    assert.ok(!unguarded.blocked, 'label guard alone lets "Save" through');
    await page.waitForFunction(() => document.body.dataset.saved === '1');
    assert.equal(counts.commit, 1);

    counts.commit = 0;
    const guarded = await actFast(page, { action: 'click', selector: '#save', networkGuard: true });
    assert.equal(guarded.blocked, true);
    assert.equal(guarded.blockedBy, 'network');
    assert.equal(guarded.networkBlocked.length, 1);
    assert.equal(guarded.networkBlocked[0].method, 'POST');
    assert.equal(counts.commit, 0);
  });

  it('network guard honours the allowlist and leaves non-network clicks alone', async () => {
    const page = await open('/save');
    const res = await actFast(page, {
      action: 'click',
      selector: '#autosave',
      networkGuard: true,
      networkGuardAllow: ['/autosave$'],
    });
    assert.ok(!res.blocked);
    await page.waitForFunction(() => document.body.dataset.auto === '1');
    assert.equal(counts.autosave, 1);
    const toggle = await actFast(page, { action: 'click', selector: '#noop', networkGuard: true });
    assert.ok(!toggle.blocked);
  });

  it('batch_actions stops at the step whose request the network guard blocked', async () => {
    const page = await open('/save');
    const res = await batchActions(
      page,
      [
        { action: 'click', selector: '#noop' },
        { action: 'click', selector: '#save' },
        { action: 'click', selector: '#autosave' },
      ],
      { networkGuard: true }
    );
    assert.equal(res.blocked, true);
    assert.equal(res.completed, 2);
    assert.equal(res.results[1].blockedBy, 'network');
    assert.equal(counts.commit, 0);
    assert.equal(counts.autosave, 0);
  });

  it('batch_actions verifies the final state and records the ledger once', async () => {
    const page = await open('/wizard');
    const res = await batchActions(
      page,
      [
        { action: 'fill', selector: '#name', value: '홍길동' },
        { action: 'click', selector: '#next' },
        { action: 'click', selector: '#confirm' },
      ],
      { allowSubmit: true, submissionKey: 'batch-1', expect: { urlMatches: '/receipt$', timeoutMs: 5000 } }
    );
    assert.equal(res.submitVerified, true);
    assert.equal(res.evidence.type, 'url');
    assert.equal(readLedger(process.env.TURBO_BROWSER_LEDGER).length, 1);
  });

  it('wait_for_human resolves when the human-side condition appears', async () => {
    await open('/human');
    const out = await dispatchToolCall(manager, 'wait_for_human', {
      selector: '#logged-in',
      message: 'Please sign in',
      timeoutMs: 5000,
      pollMs: 100,
    });
    const res = JSON.parse(out.text);
    assert.equal(res.ok, true);
    assert.equal(res.matched, 'selector');
  });

  it('wait_for_human times out cleanly and requires a condition', async () => {
    await open('/human');
    const out = await dispatchToolCall(manager, 'wait_for_human', { selector: '#never', timeoutMs: 1000, pollMs: 100 });
    const res = JSON.parse(out.text);
    assert.equal(res.ok, false);
    assert.equal(res.timedOut, true);
    await assert.rejects(dispatchToolCall(manager, 'wait_for_human', {}), /requires at least one/);
  });

  it('reports a form.submit() it suppressed instead of returning a silent ok', async () => {
    const page = await open('/edge');
    const res = await actFast(page, { action: 'click', selector: '#js-submit' });
    assert.equal(res.ok, true);
    assert.ok(res.submitSuppressed >= 1, JSON.stringify(res));
    assert.match(res.note, /Nothing was sent/);
    assert.equal(counts.commit, 0);
    const leaked = await page.evaluate(() => Object.keys(window).filter((k) => k.startsWith('__tbm')));
    assert.deepEqual(leaked, []);
    const allowed = await actFast(page, { action: 'click', selector: '#js-submit', allowSubmit: true });
    assert.ok(!allowed.blocked);
    await page.waitForURL(/\/commit$/);
    assert.equal(counts.commit, 1);
  });

  it('still blocks a modal 확인 whose text mentions privacy/consent, but not date pickers or cookie banners', async () => {
    const page = await open('/edge');
    const tos = await actFast(page, { action: 'click', selector: '#tos-ok' });
    assert.equal(tos.blocked, true);
    assert.equal(tos.blockedBy, 'modal');
    assert.equal(counts.commit, 0);
    await page.evaluate(() => document.getElementById('tos').remove());

    const cookie = await actFast(page, { action: 'click', selector: '#cookie-ok' });
    assert.ok(!cookie.blocked, 'cookie banner OK stays clickable');

    await actFast(page, { action: 'click', selector: '#dp-open' });
    const picker = await actFast(page, { action: 'click', selector: '#dp-ok' });
    assert.ok(!picker.blocked, 'date picker 확인 stays clickable');
  });

  it('accepts allowlist regexes that are invalid under the unicode flag', () => {
    const page = 'https://portal.example.kr/apply';
    const allow = collectAllowPatterns(['/auto\\_save$']);
    assert.equal(
      isCommitLikeRequest({ method: 'POST', resourceType: 'fetch', url: 'https://portal.example.kr/auto_save', pageUrl: page }, allow),
      false
    );
  });

  it('classifies commit-like requests', () => {
    const page = 'https://portal.example.kr/apply';
    assert.equal(isCommitLikeRequest({ method: 'GET', resourceType: 'fetch', url: page, pageUrl: page }), false);
    assert.equal(isCommitLikeRequest({ method: 'POST', resourceType: 'fetch', url: 'https://api.example.kr/x', pageUrl: page }), true);
    assert.equal(isCommitLikeRequest({ method: 'POST', resourceType: 'fetch', url: 'https://www.google-analytics.com/g/collect', pageUrl: page }), false);
    assert.equal(isCommitLikeRequest({ method: 'POST', resourceType: 'document', url: 'https://other.site/form', pageUrl: page }), true);
    assert.equal(isCommitLikeRequest({ method: 'POST', resourceType: 'ping', url: page, pageUrl: page }), false);
    assert.equal(
      isCommitLikeRequest({ method: 'PUT', resourceType: 'xhr', url: 'https://portal.example.kr/draft', pageUrl: page }, [/\/draft$/]),
      false
    );
  });

  it('parses --open-profile and --url', () => {
    const parsed = parseCliArgs(['--open-profile', '--url', 'https://example.com/login']);
    assert.equal(parsed.openProfile, true);
    assert.equal(parsed.envOverrides.TURBO_BROWSER_OPEN_URL, 'https://example.com/login');
    assert.equal(parsed.unknown, null);
  });
});
