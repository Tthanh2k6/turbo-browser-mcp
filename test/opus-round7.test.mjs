// opus-round7: independent outer gatekeeper suite (opus-gatekeeper-6).
//
// Outcome-based: submit assertions count real `submit` events reaching the page's own listener
// (document bubble listener, or the form's own listener inside a shadow root). Every listener calls
// preventDefault() so nothing navigates. `form.submit()` fires no submit event, so those fixtures post to
// `/hit` and the local server counts real form POSTs instead.
//
// "R7O-REG-*" tests independently re-verify the Round-6 Opus / Round-7 Carbon fixes with fresh fixtures and
// positive controls. "R7O-BUG-*" tests reproduce defects found by reading src/*.mjs line by line and
// confirmed in Chromium; each has a passing control proving the fixture is valid.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, resolveSafePath, smartFillForm } from '../src/dom-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const COUNTER = `<script>window.__submits=0;window.__by=[];document.addEventListener('submit',function(e){e.preventDefault();window.__submits++;window.__by.push(e.submitter?(e.submitter.textContent||e.submitter.value||'').trim():'');});</script>`;
const wrap = (body, withCounter = true) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>round7o</title></head><body>${withCounter ? COUNTER : ''}${body}</body></html>`;

const shadowFormComponent = (tag, mode, delegatesFocus, inner) => `<script>
customElements.define('${tag}', class extends HTMLElement {
  constructor() {
    super();
    const r = this.attachShadow({ mode: '${mode}', delegatesFocus: ${delegatesFocus} });
    r.innerHTML = ${JSON.stringify(inner)};
    r.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); window.__submits++; });
  }
});
</script>`;

const PAGES = {
  blank: '<p>blank</p>',

  // ---- regression fixtures ----
  deferred: `<form action="/submit" method="post">
<label>Sort <select id="ms" name="ms" onchange="Promise.resolve().then(() => this.form.requestSubmit())"><option value="">--</option><option value="a">Alpha</option></select></label>
<label>Region <select id="mt" name="mt" onchange="setTimeout(() => this.form.requestSubmit(), 0)"><option value="">--</option><option value="n">North</option></select></label>
<label>City <input id="mc" name="mc" oninput="queueMicrotask(() => this.form.requestSubmit())"></label>
<label><input id="mk" type="checkbox" name="mk" onchange="(async () => { await null; this.form.requestSubmit(); })()"> Agree to terms</label>
<button>Place order</button></form>`,
  xframeParent: `<form action="/submit" method="post"><input name="q" value="x"></form><iframe id="f" src="/page/xframeChild" style="width:400px;height:100px"></iframe>`,
  xframeChild: `<button id="cb" type="button" style="padding:8px" onclick="parent.document.forms[0].requestSubmit()">Finish</button>`,
  drag: `<form action="/submit" method="post"><input name="q" value="x">
<div id="card" draggable="true" style="width:140px;height:40px;background:#ccc">Task card</div>
<div id="zone" style="width:220px;height:80px;margin-top:20px;background:#eef">Drop zone</div></form>
<script>
const z = document.getElementById('zone');
z.addEventListener('dragover', (e) => e.preventDefault());
z.addEventListener('drop', (e) => { e.preventDefault(); document.forms[0].requestSubmit(); });
document.getElementById('card').addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', 'c'));
</script>`,
  closedPay: `<x-pay id="host" style="display:inline-block"></x-pay>${shadowFormComponent(
    'x-pay',
    'closed',
    false,
    '<form action="/submit" method="post" style="margin:0"><button style="padding:20px">Pay now</button></form>'
  )}`,
  closedEnter: `<x-checkout id="host"></x-checkout>${shadowFormComponent(
    'x-checkout',
    'closed',
    true,
    '<form action="/submit" method="post"><input name="email" value="a@b.c"><button>Place order</button></form>'
  )}`,
  hijack: `<form id="hf" action="/submit" method="post"><input name="q" value="x">
<button id="safeHijack" type="submit" onclick="event.preventDefault(); this.form.requestSubmit(document.getElementById('realPay'));">Search</button>
<button id="realPay" type="submit">Pay now</button></form>
<span id="lblSearch">Search</span>
<form id="sf" action="/search" method="get"><input name="q2" value="shoes"><button id="iconBtn" type="submit" aria-labelledby="lblSearch"><svg width="16" height="16"></svg></button></form>`,
  implicit: `<form id="f1" action="/s"><input id="noType" name="a" value="1"></form>
<form id="f2" action="/s"><input id="bogus" type="bogus" name="b" value="1"></form>
<form id="f3" action="/s"><input id="two1" name="c" value="1"><input id="two2" name="d" value="2"></form>`,
  search: `<form action="/search" method="get"><label>Query <input id="q" name="q"></label><button type="submit">Search</button></form>
<form action="/submit" method="post"><label>Coupon <input id="coupon" name="coupon"></label><button>Place order</button></form>`,
  hoverFocus: `<form action="/submit" method="post"><input name="q" value="x">
<div id="hv" style="width:200px;height:40px;background:#eee" onmouseenter="document.forms[0].requestSubmit()">Preview card</div>
<input id="fc" aria-label="Notes" onfocus="this.form.requestSubmit()"></form>`,
  roots: `<div id="mount"></div><script>
window.__mkRoots = (n) => {
  const m = document.getElementById('mount');
  for (let i = 0; i < n; i++) {
    const h = document.createElement('div');
    h.className = 'tmp-host';
    h.attachShadow({ mode: i % 2 ? 'closed' : 'open' }).innerHTML = '<span>tmp</span>';
    m.appendChild(h);
  }
};
window.__dropRoots = () => { document.getElementById('mount').replaceChildren(); };
</script>`,

  // ---- defect fixtures ----
  // R7O-BUG-01: native submit() captured before the guard is installed (load-time cache, or a pristine realm).
  cachedSubmit: `<script>window.__nativeSubmit = HTMLFormElement.prototype.submit;</script>
<form id="f" action="/hit" method="post"><input name="q" value="x">
<label>Sort <select id="s" name="s" onchange="window.__nativeSubmit.call(this.form)"><option value="">--</option><option value="a">Alpha</option></select></label>
<button>Place order</button></form>`,
  realmSubmit: `<form id="f" action="/hit" method="post"><input name="q" value="x">
<label>Sort <select id="s" name="s" onchange="var i=document.createElement('iframe');document.body.appendChild(i);i.contentWindow.HTMLFormElement.prototype.submit.call(this.form)"><option value="">--</option><option value="a">Alpha</option></select></label>
<button>Place order</button></form>`,
  liveSubmit: `<form id="f" action="/hit" method="post"><input name="q" value="x">
<label>Sort <select id="s" name="s" onchange="this.form.submit()"><option value="">--</option><option value="a">Alpha</option></select></label>
<button>Place order</button></form>`,
  // R7O-BUG-02: Enter only activates the form's default (first) submit button.
  draftFirst: `<form action="/submit" method="post"><label>Title <input id="t" name="t" value="Hello"></label><button>Save draft</button><button>Publish</button></form>`,
  publishFirst: `<form action="/submit" method="post"><label>Title <input id="t" name="t" value="Hello"></label><button>Publish</button><button>Save draft</button></form>`,
  // R7O-BUG-03: chord where Enter/Space is held as a "modifier" (not the last key part).
  chord: `<script>window.__deleted=0;</script>
<button id="del" type="button" onclick="window.__deleted++">Delete account</button>
<form action="/submit" method="post"><label>Coupon <input id="coupon" name="coupon" value="X"></label><button>Place order</button></form>`,
};

function startFixture() {
  const state = { hits: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/hit') {
      state.hits++;
      req.resume();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><p>submitted</p>');
      return;
    }
    if (url.pathname.startsWith('/page/')) {
      const name = url.pathname.slice(6);
      if (PAGES[name] !== undefined) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(wrap(PAGES[name], name !== 'xframeChild'));
        return;
      }
    }
    req.resume();
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nf');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

describe('opus-round7: outer gatekeeper suite', { concurrency: 1 }, () => {
  let fx;
  let manager;
  let page;
  let tmpDir;

  const open = async (name) => {
    await page.goto(`${fx.base}/page/${name}`, { waitUntil: 'load' });
    return page;
  };
  // Submit events fire synchronously or within the same task's microtasks; one task turn flushes them.
  const submits = async () => page.evaluate(() => new Promise((r) => setTimeout(() => r(window.__submits), 0)));
  const submitters = async () => page.evaluate(() => window.__by);
  const safe = (p) => p.catch((e) => ({ ok: false, error: String(e?.message || e).slice(0, 300) }));
  // A native form.submit() navigation to /hit either commits (bug) or never starts (guarded).
  const navigatedToHit = async () => {
    const reached = await page
      .waitForURL((u) => String(u).includes('/hit'), { timeout: 1500, waitUntil: 'commit' })
      .then(() => true)
      .catch(() => false);
    return reached || fx.state.hits > 0;
  };
  const guardResidue = () =>
    page.evaluate(() => {
      const nativeFns = [HTMLFormElement.prototype.submit, HTMLFormElement.prototype.requestSubmit].every((fn) =>
        Function.prototype.toString.call(fn).includes('[native code]')
      );
      const leakedForms = [...document.querySelectorAll('form')].filter((f) => f.__tbmAllowedSubmit !== undefined).length;
      return {
        nativeFns,
        leakedForms,
        guardActive: window.__tbmSubmitGuardActive || 0,
        allowSafe: Boolean(window.__tbmAllowSafeForm),
        cleanupLeft: typeof window.__tbmCleanupActGuard === 'function' || typeof window.__tbmCleanupFileGuard === 'function',
        enumerableTbm: Object.keys(window).filter((k) => k.startsWith('__tbm')),
      };
    });

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-opus-r7-'));
    fx = await startFixture();
    manager = new BrowserManager({ mode: 'launch', headless: true });
    await manager.tabsBatch([{ action: 'open', url: `${fx.base}/page/blank` }]);
    ({ page } = await manager.getPage());
  });

  after(async () => {
    await manager?.close();
    if (fx) await new Promise((resolve) => fx.server.close(resolve));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('regression verification of R6O-BUG-01..05 and R7-BUG-01..10 fixes', () => {
    it('R7O-REG-01 act_fast + smart_fill_form block microtask- and macrotask(0)-deferred auto-submits; allowSubmit=true control submits', async () => {
      await open('deferred');
      await actFast(page, { action: 'select', selector: '#ms', value: 'a' });
      await actFast(page, { action: 'select', selector: '#mt', value: 'n' });
      await actFast(page, { action: 'fill', selector: '#mc', value: 'Hue' });
      await actFast(page, { action: 'check', selector: '#mk' });
      assert.equal(await submits(), 0);
      assert.equal(await page.locator('#mk').isChecked(), true);

      await open('deferred');
      const res = await smartFillForm(page, {
        fields: [
          { keys: 'Sort', value: 'Alpha' },
          { keys: 'Region', value: 'North' },
          { keys: 'City', value: 'Hanoi' },
          { keys: 'Agree to terms', value: true },
        ],
      });
      assert.equal(await page.locator('#ms').inputValue(), 'a', JSON.stringify(res));
      assert.equal(await page.locator('#mt').inputValue(), 'n', JSON.stringify(res));
      assert.equal(await submits(), 0, JSON.stringify(res));
      assert.deepEqual((await guardResidue()).leakedForms, 0);

      await open('deferred');
      await actFast(page, { action: 'select', selector: '#mt', value: 'n', allowSubmit: true });
      assert.equal(await page.evaluate(() => new Promise((r) => setTimeout(() => setTimeout(() => r(window.__submits), 0), 0))), 1);
    });

    it('R7O-REG-02 neutral same-origin iframe button submitting parent form is blocked; allowSubmit=true submits', async () => {
      await open('xframeParent');
      await page.frameLocator('#f').locator('#cb').waitFor();
      const res = await safe(actFast(page, { action: 'click', selector: '#cb' }));
      assert.equal(await submits(), 0, JSON.stringify(res));
      const allowed = await actFast(page, { action: 'click', selector: '#cb', allowSubmit: true });
      assert.equal(allowed.ok, true);
      assert.equal(await submits(), 1);
    });

    it('R7O-REG-03 act_fast drag (dragTo) onto an auto-submitting drop zone is guarded; allowSubmit=true submits', async () => {
      await open('drag');
      const res = await safe(actFast(page, { action: 'drag', selector: '#card', targetSelector: '#zone' }));
      assert.equal(await submits(), 0, JSON.stringify(res));
      await open('drag');
      const allowed = await actFast(page, { action: 'drag', selector: '#card', targetSelector: '#zone', allowSubmit: true });
      assert.equal(allowed.ok, true);
      assert.equal(await submits(), 1);
    });

    it('R7O-REG-04 closed-shadow "Pay now" is blocked by selector and by {x,y}; closed delegatesFocus Enter is blocked; controls submit when allowed', async () => {
      await open('closedPay');
      const bySel = await safe(actFast(page, { action: 'click', selector: '#host' }));
      assert.equal(bySel.blocked, true, JSON.stringify(bySel));
      const box = await page.locator('#host').boundingBox();
      const byXY = await safe(actFast(page, { action: 'click', x: box.x + box.width / 2, y: box.y + box.height / 2 }));
      assert.equal(byXY.blocked, true, JSON.stringify(byXY));
      assert.equal(await submits(), 0);
      assert.equal(await page.evaluate(() => document.getElementById('host').shadowRoot), null, 'closed root stays closed to page code');
      const allowed = await actFast(page, { action: 'click', selector: '#host', allowSubmit: true });
      assert.equal(allowed.ok, true);
      assert.equal(await submits(), 1);

      await open('closedEnter');
      const enter = await safe(actFast(page, { action: 'press', selector: '#host', key: 'Enter', timeoutMs: 3000 }));
      assert.equal(await submits(), 0, JSON.stringify(enter));
      await open('closedEnter');
      await actFast(page, { action: 'press', selector: '#host', key: 'Enter', allowSubmit: true });
      assert.equal(await submits(), 1);
    });

    it('R7O-REG-05 safe "Search" button calling requestSubmit(dangerousSubmitter) is blocked; icon button labelled "Search" via aria-labelledby submits', async () => {
      await open('hijack');
      const res = await actFast(page, { action: 'click', selector: '#safeHijack' });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(await submits(), 0, 'requestSubmit(<Pay now>) from a safe click must be blocked');
      const icon = await actFast(page, { action: 'click', selector: '#iconBtn' });
      assert.equal(icon.ok, true, JSON.stringify(icon));
      assert.equal(await submits(), 1);
      assert.equal((await guardResidue()).leakedForms, 0);
    });

    it('R7O-REG-06 HTML implicit-submission rules: single input with no/bogus type is blocked; two blocking fields are not blocked (Chromium control: 0 submits)', async () => {
      await open('implicit');
      for (const sel of ['#noType', '#bogus']) {
        const r = await actFast(page, { action: 'press', selector: sel, key: 'Enter' });
        assert.equal(r.blocked, true, `${sel}: ${JSON.stringify(r)}`);
      }
      const two = await actFast(page, { action: 'press', selector: '#two1', key: 'Enter' });
      assert.equal(two.ok, true, JSON.stringify(two));
      assert.equal(await submits(), 0);
      await actFast(page, { action: 'press', selector: '#two1', key: 'Enter', allowSubmit: true });
      assert.equal(await submits(), 0, 'Chromium never implicitly submits a 2-field buttonless form');
      await actFast(page, { action: 'press', selector: '#noType', key: 'Enter', allowSubmit: true });
      assert.equal(await submits(), 1, 'control: single-field buttonless form does submit natively');
    });

    it('R7O-REG-07 type "shoes\\n" into a safe Search form submits once; "X\\n" into a Place-order form is blocked', async () => {
      await open('search');
      const ok = await actFast(page, { action: 'type', selector: '#q', value: 'shoes\n' });
      assert.equal(ok.ok, true, JSON.stringify(ok));
      assert.equal(await submits(), 1);
      const blocked = await actFast(page, { action: 'type', selector: '#coupon', value: 'X\n' });
      assert.equal(blocked.blocked, true, JSON.stringify(blocked));
      assert.equal(await submits(), 1);
      assert.deepEqual(await submitters(), ['Search']);
    });

    it('R7O-REG-08 hover and focus that trigger requestSubmit() are guarded; allowSubmit=true controls submit', async () => {
      await open('hoverFocus');
      await actFast(page, { action: 'hover', selector: '#hv' });
      await actFast(page, { action: 'focus', selector: '#fc' });
      assert.equal(await submits(), 0);
      await open('hoverFocus');
      await actFast(page, { action: 'hover', selector: '#hv', allowSubmit: true });
      assert.equal(await submits(), 1);
    });

    it('R7O-REG-09 guards leave no residue: native prototypes, no __tbmAllowedSubmit, counters at 0, no enumerable __tbm* globals', async () => {
      await open('search');
      await actFast(page, { action: 'type', selector: '#q', value: 'boots\n' });
      await actFast(page, { action: 'press', selector: '#coupon', key: 'Enter' });
      await smartFillForm(page, { fields: [{ keys: 'Coupon', value: 'Z' }] });
      const r = await guardResidue();
      assert.deepEqual(r, { nativeFns: true, leakedForms: 0, guardActive: 0, allowSafe: false, cleanupLeft: false, enumerableTbm: [] });
    });

    it('R7O-REG-10 __tbmGetAllShadowRoots tracks open+closed roots via WeakRef and drops them after hosts are collected', async () => {
      await open('roots');
      const baseline = await page.evaluate(() => window.__tbmGetAllShadowRoots().length);
      await page.evaluate(() => window.__mkRoots(40));
      assert.equal(await page.evaluate(() => window.__tbmGetAllShadowRoots().length), baseline + 40);
      const closedVisible = await page.evaluate(
        () => [...document.querySelectorAll('.tmp-host')].filter((h) => !h.shadowRoot && window.__tbmGetShadowRoot(h)).length
      );
      assert.equal(closedVisible, 20, 'closed roots resolvable via __tbmGetShadowRoot');
      await page.evaluate(() => window.__dropRoots());
      const cdp = await page.context().newCDPSession(page);
      try {
        for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
      } finally {
        await cdp.detach().catch(() => {});
      }
      const live = await page.evaluate(() => window.__tbmGetAllShadowRoots().length);
      assert.ok(live < baseline + 40, `detached roots were never released (live=${live}, baseline=${baseline})`);
    });

    it('R7O-REG-11 resolveSafePath rejects sibling-prefix dirs, ".." escapes and junction/symlink escapes; accepts in-root paths', () => {
      const prevRoot = process.env.TURBO_BROWSER_SAVE_ROOT;
      const root = path.join(tmpDir, 'root');
      const sibling = path.join(tmpDir, 'root-evil');
      const outside = path.join(tmpDir, 'outside');
      fs.mkdirSync(root, { recursive: true });
      fs.mkdirSync(sibling, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      const link = path.join(root, 'link');
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      process.env.TURBO_BROWSER_SAVE_ROOT = root;
      try {
        assert.equal(resolveSafePath(path.join(root, 'a', 'b.txt')).toLowerCase(), fs.realpathSync(root).toLowerCase() + path.sep + path.join('a', 'b.txt').toLowerCase());
        assert.throws(() => resolveSafePath(path.join(sibling, 'x.txt')), /outside allowed root/);
        assert.throws(() => resolveSafePath(path.join(root, '..', 'outside', 'x.txt')), /outside allowed root/);
        assert.throws(() => resolveSafePath(path.join(link, 'new', 'x.txt')), /outside allowed root/);
      } finally {
        if (prevRoot === undefined) delete process.env.TURBO_BROWSER_SAVE_ROOT;
        else process.env.TURBO_BROWSER_SAVE_ROOT = prevRoot;
      }
    });

    it('R7O-REG-12 stdio JSON-RPC: Content-Length frames split mid-UTF-8 code point and coalesced frames; notifications get no reply', async () => {
      const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.mjs')], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
      try {
        let out = Buffer.alloc(0);
        const replies = [];
        const waitReplies = (n) =>
          new Promise((resolve, reject) => {
            const onData = (chunk) => {
              out = Buffer.concat([out, chunk]);
              for (;;) {
                const sep = out.indexOf('\r\n\r\n');
                if (sep === -1) break;
                const len = Number(/Content-Length:\s*(\d+)/i.exec(out.subarray(0, sep).toString())[1]);
                if (out.length < sep + 4 + len) break;
                replies.push(JSON.parse(out.subarray(sep + 4, sep + 4 + len).toString('utf8')));
                out = out.subarray(sep + 4 + len);
              }
              if (replies.length >= n) {
                child.stdout.off('data', onData);
                resolve(replies);
              }
            };
            child.stdout.on('data', onData);
            child.once('exit', (code) => reject(new Error(`server exited early (${code})`)));
          });
        const frame = (obj) => {
          const body = Buffer.from(JSON.stringify(obj), 'utf8');
          return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
        };
        const f1 = frame({ jsonrpc: '2.0', id: 'tiếng-việt-✓', method: 'ping' });
        const note = frame({ jsonrpc: '2.0', method: 'notifications/initialized' });
        const f2 = frame({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
        const all = Buffer.concat([f1, note, f2]);
        const cut = all.indexOf(Buffer.from('✓')) + 1; // split inside the 3-byte code point
        const pending = waitReplies(2);
        child.stdin.write(all.subarray(0, cut));
        await new Promise((r) => setImmediate(r));
        child.stdin.write(all.subarray(cut));
        const got = await pending;
        assert.deepEqual(got.map((r) => r.id), ['tiếng-việt-✓', 2]);
        assert.deepEqual(got[0].result, {});
        assert.equal(got[1].result.protocolVersion, '2024-11-05');
      } finally {
        child.stdin.end();
        await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
      }
    });
  });

  describe('R7O-BUG-01 native HTMLFormElement.prototype.submit captured before the guard bypasses allowSubmit=false', () => {
    it('R7O-BUG-01-CTRL live form.submit() lookup in onchange IS blocked by the prototype patch (act_fast and smart_fill_form)', async () => {
      await open('liveSubmit');
      fx.state.hits = 0;
      await actFast(page, { action: 'select', selector: '#s', value: 'a' });
      assert.equal(await navigatedToHit(), false);
      await smartFillForm(page, { fields: [{ selector: '#s', value: 'a' }] });
      assert.equal(await navigatedToHit(), false);
      assert.equal(fx.state.hits, 0);
    });

    it('R7O-BUG-01a act_fast select whose onchange calls a load-time cached native submit must not POST the form', async () => {
      await open('cachedSubmit');
      fx.state.hits = 0;
      const res = await actFast(page, { action: 'select', selector: '#s', value: 'a' });
      const nav = await navigatedToHit();
      assert.equal(nav, false, `allowSubmit=false: cached HTMLFormElement.prototype.submit posted the form (hits=${fx.state.hits}, url=${page.url()}); ${JSON.stringify(res)}`);
    });

    it('R7O-BUG-01b smart_fill_form (stopBeforeSubmit) with the same cached native submit must not POST the form', async () => {
      await open('cachedSubmit');
      fx.state.hits = 0;
      const res = await smartFillForm(page, { fields: [{ selector: '#s', value: 'a' }] });
      const nav = await navigatedToHit();
      assert.equal(nav, false, `stopBeforeSubmit=true: cached native submit posted the form (hits=${fx.state.hits}); stoppedBeforeSubmit=${res.stoppedBeforeSubmit}`);
    });

    it('R7O-BUG-01c act_fast select whose onchange borrows submit() from a fresh same-origin iframe realm must not POST the form', async () => {
      await open('realmSubmit');
      fx.state.hits = 0;
      const res = await actFast(page, { action: 'select', selector: '#s', value: 'a' });
      const nav = await navigatedToHit();
      assert.equal(nav, false, `pristine-realm submit() posted the form (hits=${fx.state.hits}, url=${page.url()}); ${JSON.stringify(res)}`);
    });
  });

  describe('R7O-BUG-02 implicit Enter is judged by every submit button instead of the default (first) button', () => {
    it('R7O-BUG-02-CTRL Chromium submits via the default button "Save draft"; a form whose default button is "Publish" stays blocked', async () => {
      await open('draftFirst');
      await actFast(page, { action: 'press', selector: '#t', key: 'Enter', allowSubmit: true });
      assert.equal(await submits(), 1);
      assert.deepEqual(await submitters(), ['Save draft'], 'HTML: implicit submission activates the first submit button only');
      await open('publishFirst');
      const blocked = await actFast(page, { action: 'press', selector: '#t', key: 'Enter' });
      assert.equal(blocked.blocked, true, JSON.stringify(blocked));
      assert.equal(await submits(), 0);
    });

    it('R7O-BUG-02 press Enter in a form whose default button is "Save draft" must not be blocked because a later "Publish" button exists', async () => {
      await open('draftFirst');
      const res = await actFast(page, { action: 'press', selector: '#t', key: 'Enter' });
      assert.notEqual(res.blocked, true, `Enter (would activate "Save draft") was over-blocked: ${JSON.stringify(res)}`);
      assert.equal((await submitters()).includes('Publish'), false, 'Publish must never be the submitter');
    });
  });

  describe('R7O-BUG-03 press chords that hold Enter/Space before the last key skip the submit pre-check', () => {
    it('R7O-BUG-03-CTRL plain Enter/Space on a focused "Delete account" button and Enter in a Place-order form are blocked', async () => {
      await open('chord');
      await page.focus('#del');
      for (const key of ['Enter', 'Space', 'Shift+Enter']) {
        const r = await actFast(page, { action: 'press', key });
        assert.equal(r.blocked, true, `${key}: ${JSON.stringify(r)}`);
      }
      const formEnter = await actFast(page, { action: 'press', selector: '#coupon', key: 'Enter' });
      assert.equal(formEnter.blocked, true, JSON.stringify(formEnter));
      assert.equal(await page.evaluate(() => window.__deleted), 0);
      assert.equal(await submits(), 0);
    });

    it('R7O-BUG-03a press "Enter+Shift" on the focused "Delete account" button must not activate it', async () => {
      await open('chord');
      await page.focus('#del');
      const res = await safe(actFast(page, { action: 'press', key: 'Enter+Shift' }));
      const n = await page.evaluate(() => window.__deleted);
      assert.equal(n, 0, `"Enter+Shift" activated the Delete button ${n}x; ${JSON.stringify(res)}`);
    });

    it('R7O-BUG-03b press "Space+Alt" with selector on the "Delete account" button must not activate it', async () => {
      await open('chord');
      const res = await safe(actFast(page, { action: 'press', selector: '#del', key: 'Space+Alt' }));
      const n = await page.evaluate(() => window.__deleted);
      assert.equal(n, 0, `"Space+Alt" activated the Delete button ${n}x; ${JSON.stringify(res)}`);
    });
  });
});
