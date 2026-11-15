// opus-round4: independent gatekeeper suite (opus-gatekeeper-3).
// Outcome-based: guard tests count real server-side submissions / DOM state instead of trusting
// the tool's own flags. "R4G-BUG-*" tests target concrete defects found by reading src/*.mjs;
// "R4G-REG-*" tests are independent regression/contract checks of high-risk paths.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { BrowserManager } from '../src/browser-manager.mjs';
import {
  actFast,
  batchActions,
  evaluateJs,
  extractCleanText,
  inspectCompact,
  resolveSafePath,
  smartFillForm,
} from '../src/dom-engine.mjs';
import { createJsonRpcHandler } from '../src/index.mjs';

const wrap = (body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>round4g</title></head><body>${body}</body></html>`;

const PAGES = {
  blank: '<p>blank</p>',
  // Focus sits in a text input of a form whose only submit button is "Submit"; the press target is
  // an element that cannot take focus (disabled / hidden / display:none / inert).
  pressnf: `<form action="/submit?f=pressnf" method="post"><input id="q" name="q" value="x">
<button type="submit">Submit</button></form>
<input id="dis" disabled><input id="hid" style="visibility:hidden"><input id="none" style="display:none">
<div inert><input id="inert"></div>`,
  spacenf: `<form action="/submit?f=spacenf" method="post"><input id="q" name="q">
<button id="sb" type="submit">Submit</button></form><input id="dis" disabled>`,
  pressok: `<form action="/submit?f=pressok" method="post"><input id="q" name="q" value="x">
<button type="submit">Submit</button></form>`,
  visov: `<div style="visibility:hidden"><p>HIDDEN_PARENT_P</p>
<p style="visibility:visible">SHOWN_CHILD_P</p><span>HIDDEN_SPAN</span>
<span style="visibility:visible">SHOWN_CHILD_SPAN</span></div><p>NORMAL_P</p>`,
  selchange: `<form action="/submit?f=selchange" method="post"><label>Country
<select id="c" name="c" onchange="this.form.requestSubmit()"><option value="">--</option>
<option value="vn">Vietnam</option><option value="us">USA</option></select></label>
<button type="submit">Submit</button></form>`,
  txtchange: `<form action="/submit?f=txtchange" method="post"><label>Email
<input id="e" name="e" onchange="this.form.requestSubmit()"></label>
<button type="submit">Submit</button></form>`,
  selplain: `<form action="/submit?f=selplain" method="post"><label>Country
<select id="c" name="c"><option value="">--</option><option value="vn">Vietnam</option></select></label>
<label>Email <input id="e" name="e"></label><button type="submit">Submit</button></form>`,
  fsdis: `<form><fieldset disabled><legend>Locked</legend><label>Email <input id="e" name="e"></label>
<label><input type="checkbox" id="cb" name="cb"> Subscribe</label></fieldset>
<label>Phone <input id="p" name="p"></label></form>`,
  refs: `<div id="list"><button id="a" type="button" onclick="window.__a=(window.__a||0)+1">Alpha</button>
<button id="b" type="button" onclick="window.__b=(window.__b||0)+1">Beta</button></div>`,
  labelfor: `<form action="/submit?f=labelfor" method="post"><input name="q" value="x">
<label for="go" id="lbl" style="display:inline-block;padding:6px">Go now</label>
<button id="go" type="submit">Send</button></form>`,
  batchcap: `<form action="/submit?f=batchcap" method="post"><input name="q" value="x">
<button id="pub" type="submit">Publish</button></form>`,
  urlwait: `<p>url</p>`,
  net: `<p>net</p>`,
};

function startFixture() {
  const counts = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/submit') {
      const f = url.searchParams.get('f') || '?';
      counts.set(f, (counts.get(f) || 0) + 1);
      req.resume();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(wrap('<h1>Submitted</h1>'));
      return;
    }
    if (url.pathname === '/asset/pic.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    }
    if (url.pathname === '/asset/data.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (url.pathname.startsWith('/page/')) {
      const name = url.pathname.slice(6);
      if (PAGES[name] !== undefined) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(wrap(PAGES[name]));
        return;
      }
    }
    res.writeHead(404);
    res.end('nf');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, counts, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

describe('opus-round4: browser gatekeeper suite', () => {
  let fx;
  let manager;
  let page;

  const open = async (name) => {
    await page.goto(`${fx.base}/page/${name}`, { waitUntil: 'load' });
    return page;
  };
  // Negative assertions need a settle window for a possible navigation/POST to reach the server.
  const submissions = async (name) => {
    await page.waitForTimeout(600);
    return fx.counts.get(name) || 0;
  };

  before(async () => {
    fx = await startFixture();
    manager = new BrowserManager({ mode: 'launch', headless: true });
    await manager.tabsBatch([{ action: 'open', url: `${fx.base}/page/blank` }]);
    ({ page } = await manager.getPage());
  });

  after(async () => {
    await manager?.close();
    await new Promise((resolve) => fx.server.close(resolve));
  });

  describe('submit guard (act_fast press)', () => {
    for (const target of ['#dis', '#hid', '#none', '#inert']) {
      it(`R4G-BUG-01 press Enter on non-focusable target ${target} must not submit the form that holds focus`, async () => {
        fx.counts.delete('pressnf');
        await open('pressnf');
        await page.focus('#q');
        const res = await actFast(page, { action: 'press', selector: target, key: 'Enter', timeoutMs: 2000 }).catch(
          (e) => ({ ok: false, error: e.message })
        );
        const n = await submissions('pressnf');
        assert.equal(
          n,
          0,
          `Enter routed through ${target} reached the focused <input> and submitted the form ${n}x; result=${JSON.stringify(res)}`
        );
      });
    }

    it('R4G-BUG-02 press Space on a disabled target must not activate the focused Submit button', async () => {
      fx.counts.delete('spacenf');
      await open('spacenf');
      await page.focus('#sb');
      const res = await actFast(page, { action: 'press', selector: '#dis', key: 'Space', timeoutMs: 2000 }).catch(
        (e) => ({ ok: false, error: e.message })
      );
      const n = await submissions('spacenf');
      assert.equal(n, 0, `Space via disabled target clicked the focused Submit button; result=${JSON.stringify(res)}`);
    });

    it('R4G-REG-01 press Enter on a focusable input is blocked (0 POSTs) and allowed with allowSubmit=true', async () => {
      fx.counts.delete('pressok');
      await open('pressok');
      const blocked = await actFast(page, { action: 'press', selector: '#q', key: 'Enter' });
      assert.equal(blocked.blocked, true, JSON.stringify(blocked));
      assert.equal(await submissions('pressok'), 0);
      const nav = page.waitForURL(/\/submit\?f=pressok/, { timeout: 5000 });
      const allowed = await actFast(page, { action: 'press', selector: '#q', key: 'Enter', allowSubmit: true });
      await nav;
      assert.equal(allowed.ok, true);
      assert.equal(fx.counts.get('pressok'), 1);
    });

    it('R4G-REG-02 click on <label for> of a submit button is blocked with 0 POSTs', async () => {
      fx.counts.delete('labelfor');
      await open('labelfor');
      const res = await actFast(page, { action: 'click', selector: '#lbl' });
      assert.equal(res.blocked, true, JSON.stringify(res));
      assert.equal(await submissions('labelfor'), 0);
    });

    it('R4G-REG-03 batch_actions allowSubmit:false ceiling overrides a step-level allowSubmit:true', async () => {
      fx.counts.delete('batchcap');
      await open('batchcap');
      const res = await batchActions(
        page,
        [{ action: 'click', selector: '#pub', allowSubmit: true }],
        { allowSubmit: false }
      );
      assert.equal(res.blocked, true, JSON.stringify(res));
      assert.equal(await submissions('batchcap'), 0);
    });
  });

  describe('smart_fill_form', () => {
    it('R4G-BUG-03 stopBeforeSubmit (default) must not let a fill-triggered change -> requestSubmit() POST the form (<select>)', async () => {
      fx.counts.delete('selchange');
      await open('selchange');
      const res = await smartFillForm(page, { fields: [{ keys: 'Country', value: 'Vietnam' }] });
      const n = await submissions('selchange');
      assert.equal(
        n,
        0,
        `Form was POSTed ${n}x during fill while result claims stoppedBeforeSubmit=${res.stoppedBeforeSubmit}; filled=${JSON.stringify(res.filled)}`
      );
    });

    it('R4G-BUG-03b stopBeforeSubmit (default) must not let a fill-triggered change -> requestSubmit() POST the form (<input>)', async () => {
      fx.counts.delete('txtchange');
      await open('txtchange');
      const res = await smartFillForm(page, { fields: [{ keys: 'Email', value: 'a@b.co' }] });
      const n = await submissions('txtchange');
      assert.equal(
        n,
        0,
        `Form was POSTed ${n}x during fill while result claims stoppedBeforeSubmit=${res.stoppedBeforeSubmit}`
      );
    });

    it('R4G-REG-04 control: plain <select> + <input> are filled and nothing is submitted', async () => {
      fx.counts.delete('selplain');
      await open('selplain');
      const res = await smartFillForm(page, {
        fields: [
          { keys: 'Country', value: 'Vietnam' },
          { keys: 'Email', value: 'a@b.co' },
        ],
      });
      const st = await page.evaluate(() => ({
        c: document.querySelector('#c').value,
        e: document.querySelector('#e').value,
      }));
      assert.deepEqual(st, { c: 'vn', e: 'a@b.co' }, JSON.stringify(res));
      assert.equal(await submissions('selplain'), 0);
    });

    it('R4G-BUG-04 controls inside <fieldset disabled> are neither mutated nor reported as filled', async () => {
      await open('fsdis');
      const res = await smartFillForm(page, {
        fields: [
          { keys: 'Email', value: 'a@b.co' },
          { keys: 'Subscribe', value: true },
          { keys: 'Phone', value: '0123' },
        ],
      });
      const st = await page.evaluate(() => ({
        e: document.querySelector('#e').value,
        cb: document.querySelector('#cb').checked,
        p: document.querySelector('#p').value,
      }));
      assert.equal(st.p, '0123', `enabled control outside the disabled fieldset must still be filled: ${JSON.stringify(res)}`);
      const reportedLocked = res.filled.filter((f) => f.idx === 0 || f.idx === 1);
      assert.equal(st.e, '', `value written into a :disabled control (excluded from form data): ${JSON.stringify(st)}`);
      assert.deepEqual(
        reportedLocked,
        [],
        `:disabled controls reported as filled although they are inert/excluded from submission: ${JSON.stringify(reportedLocked)}`
      );
    });
  });

  describe('extract_clean_text', () => {
    it('R4G-BUG-05 keeps visibility:visible descendants of a visibility:hidden ancestor (not only when the override is the root)', async () => {
      await open('visov');
      for (const format of ['text', 'markdown']) {
        const { text } = await extractCleanText(page, { includeFrames: false, format });
        assert.ok(text.includes('NORMAL_P'), `${format}: ${text}`);
        assert.ok(!text.includes('HIDDEN_PARENT_P') && !text.includes('HIDDEN_SPAN'), `${format} leaked hidden text: ${text}`);
        assert.ok(
          text.includes('SHOWN_CHILD_P') && text.includes('SHOWN_CHILD_SPAN'),
          `${format} dropped rendered visibility:visible descendants: ${JSON.stringify(text)}`
        );
      }
    });
  });

  describe('inspect_compact refs', () => {
    it('R4G-REG-05 onlyChanged keeps prior refs valid, assigns a fresh ref to new nodes, and query does not reset refs', async () => {
      await open('refs');
      const st = manager.getSnapshotState(page);
      const s1 = await inspectCompact(page, {}, st);
      assert.match(s1.text, /\[f0:e1\] <button> "Alpha"/);
      assert.match(s1.text, /\[f0:e2\] <button> "Beta"/);
      await page.evaluate(() => {
        const b = document.createElement('button');
        b.textContent = 'Gamma';
        document.body.prepend(b);
      });
      const s2 = await inspectCompact(page, { onlyChanged: true }, st);
      assert.match(s2.text, /\[f0:e3\] <button> "Gamma"/);
      assert.ok(!/Alpha|Beta/.test(s2.text.split('\n').slice(3).join('\n')), s2.text);
      const q = await inspectCompact(page, { query: 'Beta' }, st);
      assert.match(q.text, /\[f0:e2\] <button> "Beta"/);
      await actFast(page, { action: 'click', ref: 'e1' });
      await actFast(page, { action: 'click', ref: 'f0:e2' });
      const hits = await page.evaluate(() => [window.__a || 0, window.__b || 0]);
      assert.deepEqual(hits, [1, 1]);
    });
  });

  describe('evaluate_js', () => {
    it('R4G-REG-06 trailing semicolon/comment lexer + expression/body/function/await forms', async () => {
      await open('blank');
      const cases = [
        ['({a:1}) // trailing', { a: 1 }],
        ['1 /* c */ ;;', 1],
        ['"a;b" ;;', 'a;b'],
        ['/;/.test("a;") ;', true],
        ['`${1+1};` ;', '2;'],
        ['await new Promise(r=>setTimeout(()=>r(5),5))', 5],
        ['x => x*2', 14],
        ['const y = 3; return y * arg', 21],
        ['a = 1\n/2/1', 0.5],
        ['[1,2].map(n => n /2 /*x*/) // c', [0.5, 1]],
        ['document.title // done;', 'round4g'],
        ['undefined', null],
      ];
      for (const [expression, expected] of cases) {
        const r = await evaluateJs(page, { expression, arg: 7 });
        assert.deepEqual(r.result, expected, `expression ${JSON.stringify(expression)}`);
      }
      await assert.rejects(evaluateJs(page, { expression: '1', frameIdx: 9 }), /Frame 9 not found/);
    });
  });

  describe('act_fast wait url', () => {
    it('R4G-REG-07 url wait accepts literal-with-query, glob and regex patterns', async () => {
      await open('urlwait');
      const cases = [
        ['/page/urlwait?step=1&x=a.b', '?step=1&x=a.b'],
        ['/page/urlwait?step=2', '**/urlwait?step=2*'],
        ['/page/urlwait?step=33', 'step=\\d{2}$'],
      ];
      for (const [target, pattern] of cases) {
        await page.evaluate((t) => setTimeout(() => history.pushState({}, '', t), 80), target);
        const r = await actFast(page, { action: 'wait', url: pattern, timeoutMs: 5000 });
        assert.equal(r.ok, true);
        assert.ok(r.url.endsWith(target), `${pattern} -> ${r.url}`);
      }
    });
  });

  describe('network_session + page_diagnostics', () => {
    it('R4G-REG-08 empty blockUrls is a no-op; glob blockUrls blocks only matching URLs and the failure is diagnosable', async () => {
      const { tabId } = await manager.getPage();
      await open('net');
      const noop = await manager.manageNetworkSession(tabId, { blockUrls: ['', '  '] });
      assert.equal(noop.blockedUrls, undefined, JSON.stringify(noop));
      const set = await manager.manageNetworkSession(tabId, { blockUrls: ['*/asset/*.png'] });
      assert.deepEqual(set.blockedUrls, ['*/asset/*.png']);
      const out = await page.evaluate(async () => {
        const r = {};
        try {
          await fetch('/asset/pic.png?v=1');
          r.png = 'loaded';
        } catch {
          r.png = 'blocked';
        }
        r.json = await fetch('/asset/data.json').then((x) => x.json()).then((j) => j.ok).catch(() => 'blocked');
        return r;
      });
      assert.deepEqual(out, { png: 'blocked', json: true });
      const diag = await manager.getDiagnostics(tabId, { urlFilter: 'pic.png' });
      assert.ok(
        diag.networkErrors.some((e) => e.url.includes('/asset/pic.png') && e.ok === false),
        JSON.stringify(diag.networkErrors)
      );
      await manager.manageNetworkSession(tabId, { preset: 'clean' });
      const after = await page.evaluate(() => fetch('/asset/pic.png?v=2').then(() => 'loaded').catch(() => 'blocked'));
      assert.equal(after, 'loaded');
    });
  });
});

describe('opus-round4: pure contracts', () => {
  it('R4G-REG-09 resolveSafePath confines to TURBO_BROWSER_SAVE_ROOT and rejects traversal / Windows tricks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-r4g-'));
    const prev = process.env.TURBO_BROWSER_SAVE_ROOT;
    process.env.TURBO_BROWSER_SAVE_ROOT = root;
    try {
      const ok = resolveSafePath(path.join(root, 'a', 'b.json'));
      assert.ok(ok.toLowerCase().endsWith(path.join('a', 'b.json').toLowerCase()), ok);
      assert.throws(() => resolveSafePath(path.join(root, '..', 'escape.txt')), /outside allowed root/);
      assert.throws(() => resolveSafePath('x\0y'), /null byte/);
      assert.throws(() => resolveSafePath('   '), /non-empty/);
      if (process.platform === 'win32') {
        assert.throws(() => resolveSafePath(path.join(root, 'f.txt:ads')), /colon/);
        assert.throws(() => resolveSafePath(path.join(root, 'CON.txt')), /reserved device/);
        assert.throws(() => resolveSafePath(path.join(root, 'trail. ', 'x.txt')), /trailing dot or space/);
        assert.throws(() => resolveSafePath('C:relative.txt'), /drive-relative/);
      }
    } finally {
      if (prev === undefined) delete process.env.TURBO_BROWSER_SAVE_ROOT;
      else process.env.TURBO_BROWSER_SAVE_ROOT = prev;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('R4G-REG-10 JSON-RPC: notifications get no reply, invalid ids/params are rejected, batches drop notification replies', async () => {
    const handle = createJsonRpcHandler({});
    assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    assert.equal(await handle([{ jsonrpc: '2.0', method: 'a' }, { jsonrpc: '2.0', method: 'b' }]), null);
    const badId = await handle({ jsonrpc: '2.0', id: { x: 1 }, method: 'ping' });
    assert.equal(badId.error.code, -32600);
    assert.equal(badId.id, null);
    const badParams = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: [1] });
    assert.equal(badParams.error.code, -32602);
    const badArgs = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'act_fast', arguments: [] } });
    assert.equal(badArgs.error.code, -32602);
    const unknownTool = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } });
    assert.equal(unknownTool.result.isError, true);
    const mixed = await handle([{ jsonrpc: '2.0', method: 'n' }, { jsonrpc: '2.0', id: 'p', method: 'ping' }, 7]);
    assert.equal(mixed.length, 2);
    assert.deepEqual(mixed[0], { jsonrpc: '2.0', id: 'p', result: {} });
    assert.equal(mixed[1].error.code, -32600);
    const init = await handle({ jsonrpc: '2.0', id: 6, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    assert.equal(init.result.protocolVersion, '2025-03-26');
  });
});
