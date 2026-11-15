// opus-round8: independent outer gatekeeper suite (opus-gatekeeper-7).
//
// Outcome-based and race-free:
// - `form.submit()` / un-cancelled `requestSubmit()` run the HTML "construct the entry list" step, which fires a
//   bubbling `formdata` event SYNCHRONOUSLY. Every fixture counts `formdata` (window.__fd) and real `submit` events
//   reaching the page's own bubble listener (window.__submits, which preventDefault()s). A guarded action must leave
//   both at 0 and the page URL unchanged; positive controls (allowSubmit=true / no guard) must reach the server's
//   /hit counter, awaited with waitForURL/waitForRequest (positive waits only, no fixed sleeps).
// - Second origin = a second HTTP server on 127.0.0.1 with another port (same-site, cross-origin: any access to the
//   other window's properties throws SecurityError).
//
// "R8O-REG-*" re-verify the Round-7 Opus fixes (#170, #174). "R8O-PROBE-*" are fresh adversarial probes on the
// document-start Proxy wrappers, cross-origin frames, default-button tree order and key chords.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, resolveSafePath, smartFillForm } from '../src/dom-engine.mjs';

const COUNTER = `<script>window.__submits=0;window.__fd=0;window.__by=[];window.__errs=[];
document.addEventListener('submit',function(e){e.preventDefault();window.__submits++;window.__by.push(e.submitter?(e.submitter.textContent||e.submitter.value||'').trim():'');});
document.addEventListener('formdata',function(){window.__fd++;});
window.addEventListener('error',function(e){window.__errs.push(String(e.message));});</script>`;
const wrap = (body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>round8o</title></head><body>${COUNTER}${body}</body></html>`;

const sortForm = (onchange, extra = '') => `${extra}<form id="f" action="/hit" method="post"><input name="q" value="x">
<label>Sort <select id="s" name="s" onchange="${onchange}"><option value="">--</option><option value="a">Alpha</option></select></label>
<button>Place order</button></form>`;

const PAGES = {
  blank: '<p>blank</p>',
  // ---- R7O-BUG-01 regressions + fresh realm-borrowing probes (all use form.submit()/requestSubmit from JS) ----
  cachedSubmit: sortForm('window.__nativeSubmit.call(this.form)', '<script>window.__nativeSubmit = HTMLFormElement.prototype.submit;</script>'),
  realmContentWindow: sortForm("var i=document.createElement('iframe');document.body.appendChild(i);i.contentWindow.HTMLFormElement.prototype.submit.call(this.form)"),
  realmFramesIndex: sortForm("var i=document.createElement('iframe');document.body.appendChild(i);window[window.length-1].HTMLFormElement.prototype.submit.call(this.form)"),
  realmNamed: sortForm('window.namedF.HTMLFormElement.prototype.submit.call(this.form)', '<iframe name="namedF"></iframe>'),
  realmCachedAtLoad: sortForm('window.__ns.call(this.form)', '<iframe id="pf"></iframe><script>window.__ns = frames[0].HTMLFormElement.prototype.submit;</script>'),
  realmSrcdoc: sortForm('window.__srcdocSubmit.call(this.form)', `<iframe id="sd" srcdoc="<p>x</p>"></iframe><script>document.getElementById('sd').addEventListener('load',function(){window.__srcdocSubmit=frames[0].HTMLFormElement.prototype.submit;window.__ready=1;});</script>`),
  realmNested: sortForm("var a=document.createElement('iframe');document.body.appendChild(a);var d=a.contentDocument;var b=d.createElement('iframe');d.body.appendChild(b);a.contentWindow[0].HTMLFormElement.prototype.requestSubmit.call(this.form)"),
  realmPopup: sortForm("var w=window.open('');w.HTMLFormElement.prototype.submit.call(this.form)"),
  realmDescriptor: sortForm("var i=document.createElement('iframe');document.body.appendChild(i);var g=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'contentWindow').get;var p=Object.getOwnPropertyDescriptor(g.call(i).HTMLFormElement.prototype,'submit').value;Reflect.apply(p,this.form,[])"),
  childOwnForm: sortForm("var i=document.createElement('iframe');document.body.appendChild(i);var d=i.contentDocument;d.body.innerHTML='<form action=&quot;/hit&quot; method=&quot;post&quot;><input name=z value=1></form>';d.addEventListener('formdata',function(){top.__fd++});d.forms[0].submit()"),
  // ---- unguarded controls ----
  plain: `<form id="f" action="/hit" method="post"><input name="q" value="x"><button id="go">Place order</button></form>`,
  sameChildOwn: `<iframe id="sc" src="/page/sameChildForm"></iframe>`,
  sameChildForm: `<form id="cf" action="/submit" method="post"><input name="c" value="1"><button>Search</button></form>`,
  // ---- R7O-BUG-02 + default-button tree-order probes ----
  extBefore: `<button form="f" id="pub">Publish</button><form id="f" action="/submit" method="post"><label>Title <input id="t" name="t" value="Hi"></label><button>Save draft</button></form>`,
  extAfter: `<form id="f" action="/submit" method="post"><label>Title <input id="t" name="t" value="Hi"></label><button>Save draft</button></form><button form="f">Publish</button>`,
  disabledSafeFirst: `<form id="f" action="/submit" method="post"><label>Title <input id="t" name="t" value="Hi"></label><button disabled>Save draft</button><button>Publish</button></form>`,
  disabledDangerFirst: `<form id="f" action="/submit" method="post"><label>Title <input id="t" name="t" value="Hi"></label><button disabled>Publish</button><button>Save draft</button></form>`,
  foreignOwnerFirst: `<form id="other" action="/submit" method="post"></form><form id="f" action="/submit" method="post"><label>Title <input id="t" name="t" value="Hi"></label><button form="other">Publish</button><button>Save draft</button></form>`,
  imageFirst: `<form id="f" action="/submit" method="post"><label>Title <input id="t" name="t" value="Hi"></label><input type="image" alt="Pay now" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><button>Save draft</button></form>`,
  // ---- R7O-BUG-03 chords ----
  chord: `<script>window.__deleted=0;</script>
<button id="del" type="button" onclick="window.__deleted++">Delete account</button>
<form action="/submit" method="post"><label>Coupon <input id="coupon" name="coupon" value="X"></label><button>Place order</button></form>
<label>Note <input id="note" name="note" value=""></label>`,
  // ---- cross-origin (parent on origin A, child on origin B) ----
  xoParent: '<p>parent</p><iframe id="xo" style="width:500px;height:200px"></iframe>',
};

const XO_PAGES = {
  child: sortForm('this.form.submit()') + `<button id="rq" type="button" onclick="try{document.forms[0].requestSubmit(document.querySelector('#f button'))}catch(e){window.__errs.push(String(e))}">Next</button>`,
};

function startServer(pages) {
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
      if (pages[name] !== undefined) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(wrap(pages[name]));
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

describe('opus-round8: outer gatekeeper suite', { concurrency: 1 }, () => {
  let fx;
  let xo;
  let manager;
  let page;
  let tmpDir;

  const open = async (name) => {
    fx.state.hits = 0;
    await page.goto(`${fx.base}/page/${name}`, { waitUntil: 'load' });
    return page;
  };
  const counters = (target = page) =>
    target.evaluate(() => ({ fd: window.__fd, submits: window.__submits, errs: window.__errs, url: location.pathname }));
  const submitters = () => page.evaluate(() => window.__by);
  const safe = (p) => p.catch((e) => ({ ok: false, error: String(e?.message || e).slice(0, 300) }));
  const waitHit = (target = page) => target.waitForURL((u) => String(u).includes('/hit'), { timeout: 5000, waitUntil: 'load' });
  const residue = () =>
    page.evaluate(() => ({
      guardActive: window.__tbmSubmitGuardActive || 0,
      allowSafe: Boolean(window.__tbmAllowSafeForm),
      safeSubmitterLeft: typeof window.__tbmIsSafeSubmitter === 'function',
      cleanupLeft: typeof window.__tbmCleanupActGuard === 'function' || typeof window.__tbmCleanupFileGuard === 'function',
      leakedForms: [...document.querySelectorAll('form')].filter((f) => f.__tbmAllowedSubmit !== undefined).length,
      enumerableTbm: Object.keys(window).filter((k) => k.startsWith('__tbm')),
    }));
  const CLEAN = { guardActive: 0, allowSafe: false, safeSubmitterLeft: false, cleanupLeft: false, leakedForms: 0, enumerableTbm: [] };

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-opus-r8-'));
    fx = await startServer(PAGES);
    xo = await startServer(XO_PAGES);
    manager = new BrowserManager({ mode: 'launch', headless: true });
    await manager.tabsBatch([{ action: 'open', url: `${fx.base}/page/blank` }]);
    ({ page } = await manager.getPage());
  });

  after(async () => {
    await manager?.close();
    for (const s of [fx, xo]) if (s) await new Promise((resolve) => s.server.close(resolve));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('R8O-REG R7O-BUG-01a/b/c: submit() borrowed before/outside the guard stays blocked', () => {
    // control: how the allowSubmit=true positive control is observed.
    //   nav     = form.submit() on the top form navigates the page to /hit
    //   event   = requestSubmit() fires a real submit event (the page listener cancels it, so no navigation)
    //   request = the child frame's own form POSTs /hit (the top page does not navigate)
    const REALM_FIXTURES = {
      cachedSubmit: 'nav',
      realmContentWindow: 'nav',
      realmFramesIndex: 'nav',
      realmNamed: 'nav',
      realmCachedAtLoad: 'nav',
      realmSrcdoc: 'nav',
      realmNested: 'event',
      realmPopup: 'nav',
      realmDescriptor: 'nav',
      childOwnForm: 'request',
    };
    for (const [name, control] of Object.entries(REALM_FIXTURES)) {
      it(`R8O-REG-01 [${name}] act_fast select and smart_fill_form do not POST; allowSubmit=true control POSTs`, async () => {
        await open(name);
        if (name === 'realmSrcdoc') await page.waitForFunction(() => window.__ready === 1);
        const r1 = await safe(actFast(page, { action: 'select', selector: '#s', value: 'a' }));
        assert.equal(r1.ok, true, JSON.stringify(r1));
        const c1 = await counters();
        assert.deepEqual({ fd: c1.fd, submits: c1.submits, url: c1.url, errs: c1.errs }, { fd: 0, submits: 0, url: `/page/${name}`, errs: [] }, `act_fast: ${JSON.stringify(c1)}`);

        await open(name);
        if (name === 'realmSrcdoc') await page.waitForFunction(() => window.__ready === 1);
        const r2 = await safe(smartFillForm(page, { fields: [{ selector: '#s', value: 'a' }] }));
        assert.equal(r2.filledCount, 1, JSON.stringify(r2));
        const c2 = await counters();
        assert.deepEqual({ fd: c2.fd, submits: c2.submits, url: c2.url, errs: c2.errs }, { fd: 0, submits: 0, url: `/page/${name}`, errs: [] }, `smart_fill_form: ${JSON.stringify(c2)}`);
        assert.deepEqual(await residue(), CLEAN);
        assert.equal(fx.state.hits, 0);

        await open(name);
        if (name === 'realmSrcdoc') await page.waitForFunction(() => window.__ready === 1);
        if (control === 'event') {
          await actFast(page, { action: 'select', selector: '#s', value: 'a', allowSubmit: true });
          assert.equal((await counters()).submits, 1, 'control: unguarded requestSubmit fires a submit event');
        } else {
          const hit =
            control === 'nav'
              ? waitHit()
              : page.waitForRequest((req) => req.url().endsWith('/hit') && req.method() === 'POST', { timeout: 5000 });
          await actFast(page, { action: 'select', selector: '#s', value: 'a', allowSubmit: true });
          await hit;
        }
        for (const p of page.context().pages()) if (p !== page) await p.close();
      });
    }
  });

  describe('R8O-PROBE Proxy wrappers are transparent and do not over-block outside a guard', () => {
    it('R8O-PROBE-01 descriptors, names, lengths and toString of submit/requestSubmit and frame getters look native', async () => {
      await open('plain');
      const info = await page.evaluate(() => {
        const nat = (fn) => Function.prototype.toString.call(fn).includes('[native code]');
        const out = {};
        for (const m of ['submit', 'requestSubmit']) {
          const d = Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, m);
          out[m] = { w: d.writable, e: d.enumerable, c: d.configurable, name: d.value.name, len: d.value.length, nat: nat(d.value), keys: Object.keys(d.value) };
        }
        for (const [C, p] of [[HTMLIFrameElement, 'contentWindow'], [HTMLIFrameElement, 'contentDocument'], [HTMLFrameElement, 'contentWindow'], [HTMLObjectElement, 'contentDocument']]) {
          const d = Object.getOwnPropertyDescriptor(C.prototype, p);
          out[`${C.name}.${p}`] = { e: d.enumerable, c: d.configurable, set: d.set === undefined, name: d.get.name, nat: nat(d.get) };
        }
        let illegal = '';
        try { HTMLFormElement.prototype.submit.call({}); } catch (e) { illegal = e.constructor.name; }
        let ctor = '';
        try { new HTMLFormElement.prototype.submit(); } catch (e) { ctor = e.constructor.name; }
        out.illegal = illegal;
        out.ctor = ctor;
        out.winKeys = Object.keys(window).filter((k) => k.startsWith('__tbm'));
        return out;
      });
      for (const m of ['submit', 'requestSubmit']) {
        assert.deepEqual(info[m], { w: true, e: true, c: true, name: m, len: 0, nat: true, keys: [] }, m);
      }
      assert.deepEqual(info['HTMLIFrameElement.contentWindow'], { e: true, c: true, set: true, name: 'get contentWindow', nat: true });
      assert.deepEqual(info['HTMLIFrameElement.contentDocument'], { e: true, c: true, set: true, name: 'get contentDocument', nat: true });
      assert.deepEqual(info['HTMLFrameElement.contentWindow'], { e: true, c: true, set: true, name: 'get contentWindow', nat: true });
      assert.deepEqual(info['HTMLObjectElement.contentDocument'], { e: true, c: true, set: true, name: 'get contentDocument', nat: true });
      assert.equal(info.illegal, 'TypeError', 'native brand check preserved');
      assert.equal(info.ctor, 'TypeError', 'not a constructor preserved');
      assert.deepEqual(info.winKeys, []);
    });

    it('R8O-PROBE-02 contentWindow on a cross-origin iframe returns the WindowProxy without throwing; contentDocument is null', async () => {
      await open('xoParent');
      await page.evaluate((src) => new Promise((r) => { const f = document.getElementById('xo'); f.onload = r; f.src = src; }), `${xo.base}/page/child`);
      const info = await page.evaluate(() => {
        const f = document.getElementById('xo');
        let err = '';
        let same = false;
        try { same = f.contentWindow === frames[0]; } catch (e) { err = String(e); }
        return { err, same, doc: f.contentDocument, errs: window.__errs };
      });
      assert.deepEqual(info, { err: '', same: true, doc: null, errs: [] });
    });

    it('R8O-PROBE-03 after act_fast and smart_fill_form clean up, page-driven submit()/requestSubmit() work again (no permanent over-block)', async () => {
      await open('plain');
      await actFast(page, { action: 'fill', selector: 'input[name=q]', value: 'y' });
      await smartFillForm(page, { fields: [{ selector: 'input[name=q]', value: 'z' }] });
      assert.deepEqual(await residue(), CLEAN);
      await page.evaluate(() => document.forms[0].requestSubmit(document.getElementById('go')));
      assert.deepEqual((await counters()).submits, 1);
      assert.deepEqual(await submitters(), ['Place order']);
      const nav = waitHit();
      await page.evaluate(() => document.forms[0].submit());
      await nav;
      assert.equal(fx.state.hits, 1);
    });

    it('R8O-PROBE-04 same-origin child iframe can requestSubmit its own form when no guard is active', async () => {
      await open('sameChildOwn');
      const child = page.frameLocator('#sc');
      await child.locator('#cf').waitFor({ state: 'attached' });
      const frame = page.frames().find((f) => f.url().endsWith('/page/sameChildForm'));
      await frame.evaluate(() => document.forms[0].requestSubmit());
      assert.equal((await counters(frame)).submits, 1);
      const r = await actFast(page, { action: 'click', selector: '#cf button' });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal((await counters(frame)).submits, 2, 'safe "Search" click inside a same-origin frame still submits');
    });
  });

  describe('R8O-REG cross-origin child frames (#174 SecurityError fix)', () => {
    const loadChild = async () => {
      await open('xoParent');
      await page.evaluate((src) => new Promise((r) => { const f = document.getElementById('xo'); f.onload = r; f.src = src; }), `${xo.base}/page/child`);
      xo.state.hits = 0;
      return page.frames().find((f) => f.url().startsWith(xo.base));
    };

    it('R8O-REG-02 unguarded cross-origin child form.submit() and requestSubmit(submitter) run without SecurityError', async () => {
      let child = await loadChild();
      await child.evaluate(() => document.getElementById('rq').click());
      const c = await counters(child);
      assert.deepEqual({ submits: c.submits, errs: c.errs }, { submits: 1, errs: [] });
      const nav = child.waitForURL((u) => String(u).includes('/hit'), { timeout: 5000, waitUntil: 'load' });
      const err = await child.evaluate(() => { try { document.forms[0].submit(); return ''; } catch (e) { return String(e); } });
      assert.equal(err, '');
      await nav;
      assert.equal(xo.state.hits, 1);
      child = null;
    });

    it('R8O-REG-03 act_fast select / smart_fill_form inside a cross-origin child are guarded; allowSubmit=true control POSTs', async () => {
      let child = await loadChild();
      const r1 = await safe(actFast(page, { action: 'select', selector: '#s', value: 'a' }));
      assert.equal(r1.ok, true, JSON.stringify(r1));
      const c1 = await counters(child);
      assert.deepEqual({ fd: c1.fd, url: c1.url, errs: c1.errs }, { fd: 0, url: '/page/child', errs: [] });

      child = await loadChild();
      const r2 = await safe(smartFillForm(page, { fields: [{ selector: '#s', value: 'a' }] }));
      assert.equal(r2.filledCount, 1, JSON.stringify(r2));
      const c2 = await counters(child);
      assert.deepEqual({ fd: c2.fd, url: c2.url, errs: c2.errs }, { fd: 0, url: '/page/child', errs: [] });

      child = await loadChild();
      const r3 = await safe(actFast(page, { action: 'click', selector: '#rq' }));
      const c3 = await counters(child);
      assert.deepEqual({ submits: c3.submits, errs: c3.errs }, { submits: 0, errs: [] }, `neutral "Next" -> requestSubmit(Place order) must be blocked: ${JSON.stringify(r3)}`);
      assert.equal(xo.state.hits, 0);

      child = await loadChild();
      const nav = child.waitForURL((u) => String(u).includes('/hit'), { timeout: 5000, waitUntil: 'load' });
      await actFast(page, { action: 'select', selector: '#s', value: 'a', allowSubmit: true });
      await nav;
      assert.equal(xo.state.hits, 1);
    });
  });

  describe('R8O-REG R7O-BUG-02: implicit Enter is judged by the default button in DOM tree order', () => {
    // native: submitter Chromium uses on Enter (null = Chromium does not submit, because the tree-order default button
    // is disabled). blocked: expected act_fast result. A disabled "Save draft" default with a later "Publish" is blocked
    // conservatively (same policy as sim-submit-security.test.mjs:624); either way nothing may be submitted.
    const CASES = [
      { name: 'extBefore', blocked: true, native: 'Publish' },
      { name: 'extAfter', blocked: false, native: 'Save draft' },
      { name: 'disabledSafeFirst', blocked: true, native: null },
      { name: 'disabledDangerFirst', blocked: false, native: null },
      { name: 'foreignOwnerFirst', blocked: false, native: 'Save draft' },
    ];
    for (const c of CASES) {
      it(`R8O-REG-04 [${c.name}] Enter blocked=${c.blocked}; Chromium default submitter is ${JSON.stringify(c.native)}`, async () => {
        await open(c.name);
        await actFast(page, { action: 'press', selector: '#t', key: 'Enter', allowSubmit: true });
        assert.deepEqual(await submitters(), c.native === null ? [] : [c.native], 'Chromium control: default button');
        await open(c.name);
        const r = await actFast(page, { action: 'press', selector: '#t', key: 'Enter' });
        assert.equal(Boolean(r.blocked), c.blocked, JSON.stringify(r));
        if (c.blocked || c.native === null) assert.equal((await counters()).submits, 0);
        else assert.deepEqual(await submitters(), [c.native]);
      });
    }

    it('R8O-REG-05 an <input type=image alt="Pay now"> that precedes "Save draft" is the default button and blocks Enter', async () => {
      await open('imageFirst');
      const r = await actFast(page, { action: 'press', selector: '#t', key: 'Enter' });
      assert.equal(r.blocked, true, JSON.stringify(r));
      assert.equal((await counters()).submits, 0);
    });
  });

  describe('R8O-REG R7O-BUG-03: Enter/Space anywhere in a key chord triggers the pre-check', () => {
    it('R8O-REG-06 focused "Delete account": Enter/Space chords in any position are blocked', async () => {
      await open('chord');
      for (const key of ['Enter+Shift', 'Alt+Enter', 'Shift+NumpadEnter', 'Space+Shift', 'Shift+Space', 'Alt+Space']) {
        await page.focus('#del');
        const r = await safe(actFast(page, { action: 'press', key }));
        assert.equal(r.blocked, true, `${key}: ${JSON.stringify(r)}`);
        const r2 = await safe(actFast(page, { action: 'press', selector: '#del', key }));
        assert.equal(r2.blocked, true, `selector ${key}: ${JSON.stringify(r2)}`);
      }
      const formChord = await actFast(page, { action: 'press', selector: '#coupon', key: 'Enter+Shift' });
      assert.equal(formChord.blocked, true, JSON.stringify(formChord));
      assert.equal(await page.evaluate(() => window.__deleted), 0);
      assert.equal((await counters()).submits, 0);
    });

    it('R8O-REG-07 non-Enter/Space chords are not over-blocked (Shift+KeyA types "A" into a plain input)', async () => {
      await open('chord');
      const r = await actFast(page, { action: 'press', selector: '#note', key: 'Shift+KeyA' });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(await page.locator('#note').inputValue(), 'A');
      assert.equal(await page.evaluate(() => window.__deleted), 0);
    });
  });

  describe('R8O-REG path containment', () => {
    it('R8O-REG-08 resolveSafePath rejects sibling-prefix roots, UNC/extended paths and ADS; accepts nested paths', () => {
      const prev = process.env.TURBO_BROWSER_SAVE_ROOT;
      const root = path.join(tmpDir, 'save');
      fs.mkdirSync(root, { recursive: true });
      process.env.TURBO_BROWSER_SAVE_ROOT = root;
      try {
        assert.equal(resolveSafePath(path.join(root, 'a', 'b.txt')).toLowerCase(), path.join(fs.realpathSync.native(root), 'a', 'b.txt').toLowerCase());
        assert.throws(() => resolveSafePath(path.join(tmpDir, 'save2', 'x.txt')), /outside allowed root/);
        assert.throws(() => resolveSafePath(path.join(root, 'a', '..', '..', 'x.txt')), /outside allowed root/);
        if (process.platform === 'win32') {
          assert.throws(() => resolveSafePath(`\\\\?\\${path.join(root, 'x.txt')}`), /colon|outside/);
          assert.throws(() => resolveSafePath(path.join(root, 'x.txt:secret')), /colon/);
        }
      } finally {
        if (prev === undefined) delete process.env.TURBO_BROWSER_SAVE_ROOT;
        else process.env.TURBO_BROWSER_SAVE_ROOT = prev;
      }
    });
  });

  describe('R8O-BUG-01 resolveSafePath touches the filesystem/network for out-of-root UNC paths before rejecting them', () => {
    // fs.existsSync / fs.realpathSync are stubbed for UNC arguments (recorded, answered "missing" without I/O), so the
    // test is offline and deterministic. Unstubbed, the same call made a real SMB/NetBIOS lookup (~5.6 s in this run)
    // and, for an attacker-chosen host, Windows would attempt an authenticated SMB session (NTLM hash leak).
    it('R8O-BUG-01 \\\\host\\share\\x and //host/share/x are rejected with zero filesystem calls on the UNC path', () => {
      const prev = process.env.TURBO_BROWSER_SAVE_ROOT;
      const root = path.join(tmpDir, 'save-unc');
      fs.mkdirSync(root, { recursive: true });
      process.env.TURBO_BROWSER_SAVE_ROOT = root;
      const origExists = fs.existsSync;
      const origReal = fs.realpathSync;
      const uncCalls = [];
      const isUnc = (p) => /^[\\/]{2}/.test(String(p));
      fs.existsSync = function (p, ...rest) {
        if (isUnc(p)) {
          uncCalls.push(`existsSync:${p}`);
          return false;
        }
        return origExists.call(this, p, ...rest);
      };
      const realStub = function (p, ...rest) {
        if (isUnc(p)) {
          uncCalls.push(`realpathSync:${p}`);
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return origReal.call(this, p, ...rest);
      };
      realStub.native = origReal.native;
      fs.realpathSync = realStub;
      try {
        for (const p of ['\\\\tbm-r8-attacker.invalid\\share\\loot.json', '//tbm-r8-attacker.invalid/share/loot.json']) {
          assert.throws(() => resolveSafePath(p, 'saveStorageStatePath'), /outside allowed root|rejects/, p);
        }
        assert.deepEqual(uncCalls, [], `containment check performed I/O on attacker-chosen UNC paths: ${JSON.stringify(uncCalls)}`);
      } finally {
        fs.existsSync = origExists;
        fs.realpathSync = origReal;
        if (prev === undefined) delete process.env.TURBO_BROWSER_SAVE_ROOT;
        else process.env.TURBO_BROWSER_SAVE_ROOT = prev;
      }
    });
  });
});
