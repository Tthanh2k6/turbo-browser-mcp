// opus-round5: independent outer gatekeeper suite (opus-gatekeeper-4).
//
// Outcome-based: every submit-guard assertion counts real `submit` events that reached the page's own
// (bubble-phase) listener — the same place an SPA's onSubmit handler runs. The listener calls
// preventDefault() so the page never navigates, which keeps the count deterministic and synchronous
// (requestSubmit()/implicit Enter submission fire `submit` synchronously inside the action).
//
// "R5O-BUG-*" tests reproduce concrete defects found by reading src/*.mjs line by line and confirmed
// against Chromium. "R5O-REG-*" tests independently re-verify the latest fixes (R5-BUG-07..11,
// R4G-BUG-01/03, composed Shadow DOM order, <details>/content-visibility, regex URL waits) and serve as
// positive controls proving each fixture really submits when allowSubmit=true.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, inspectCompact, resolveSafePath, smartFillForm } from '../src/dom-engine.mjs';
import { resolveChromiumExecutable } from '../src/playwright-loader.mjs';

const COUNTER = `<script>window.__submits=0;document.addEventListener('submit',function(e){e.preventDefault();window.__submits++;});</script>`;
const wrap = (body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>round5o</title></head><body>${COUNTER}${body}</body></html>`;

// Minimal stand-in for Shoelace <sl-button> / Material <md-filled-button> / Ionic <ion-button>:
// no role on the host, label slotted from light DOM, `type="submit"` on the host, internal <button>.
const XBUTTON_DEF = `<script>
customElements.define('x-button', class extends HTMLElement {
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.innerHTML = '<button part="base" style="padding:10px 24px;font:16px sans-serif"><slot></slot></button>';
    r.querySelector('button').addEventListener('click', () => {
      if ((this.getAttribute('type') || '') === 'submit') {
        const f = this.closest('form');
        if (f) f.requestSubmit();
      }
    });
  }
});
</script>`;

const PAGES = {
  blank: '<p>blank</p>',
  wcbtn: `${XBUTTON_DEF}<form action="/submit" method="post"><input name="q" value="x">
<x-button id="xb" type="submit">Submit order</x-button></form>`,
  // Encapsulated web-component form (e.g. newsletter/LWC widget) whose host delegates focus.
  dfocus: `<x-signup id="host"></x-signup><script>
customElements.define('x-signup', class extends HTMLElement {
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open', delegatesFocus: true });
    r.innerHTML = '<form action="/submit" method="post"><input name="email" value="a@b.c"><button type="submit">Subscribe</button></form>';
    r.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); window.__submits++; });
  }
});
</script>`,
  autosel: `<form action="/submit" method="post"><label>Sort <select id="s" name="s" onchange="this.form.requestSubmit()">
<option value="">--</option><option value="a">Alpha</option></select></label><button>Submit</button></form>`,
  autoup: `<form action="/submit" method="post" enctype="multipart/form-data"><label>Avatar
<input id="fi" type="file" name="f" onchange="this.form.requestSubmit()"></label><button>Submit</button></form>`,
  autochk: `<form action="/submit" method="post"><label><input id="c" type="checkbox" name="c" onchange="this.form.requestSubmit()"> Remember me</label>
<button>Submit</button></form>`,
  hostscope: `<x-card id="card"></x-card><p><input aria-label="Outside field"></p><script>
customElements.define('x-card', class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<label>Inner email <input id="ie" aria-label="Inner email"></label><button type="button">Inner action</button>'; }
});
</script>`,
  typed: `<label>Start date <input id="d" type="date"></label>
<label>Guest count <input id="n" type="number"></label>
<label>End date <input id="d2" type="date"></label>`,
  urlwait: '<p>url</p>',
  hiddenctx: `<details id="det"><summary>More options</summary><label>Hidden promo <input id="hp" name="hp"></label></details>
<div style="content-visibility:hidden"><label>CV promo <input id="cv" name="cv"></label></div>
<label>Visible promo <input id="vp" name="vp"></label>`,
  composed: `<x-pre></x-pre><input class="tgt" id="light" aria-label="light target"><script>
customElements.define('x-pre', class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<input class="tgt" id="sh" aria-label="shadow target">'; }
});
</script>`,
  pressnf: `<form action="/submit" method="post"><input id="q" name="q" value="x"><button type="submit">Submit</button></form>
<input id="dis" disabled><div inert><input id="inert"></div>`,
  plainbtn: `<form action="/submit" method="post"><input name="q" value="x">
<button id="pb" type="submit">Submit order</button><label for="pb" id="lbl" style="display:inline-block;padding:6px">Go</label></form>`,
};

function startFixture() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/page/')) {
      const name = url.pathname.slice(6);
      if (PAGES[name] !== undefined) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(wrap(PAGES[name]));
        return;
      }
    }
    req.resume();
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nf');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

describe('opus-round5: outer gatekeeper suite', { concurrency: 1 }, () => {
  let fx;
  let manager;
  let page;
  let tmpDir;
  let uploadFile;

  const open = async (name) => {
    await page.goto(`${fx.base}/page/${name}`, { waitUntil: 'load' });
    return page;
  };
  // Submit events fire synchronously inside the action; one task turn flushes any queued handler.
  const submits = async () => page.evaluate(() => new Promise((r) => setTimeout(() => r(window.__submits), 0)));
  const safe = (p) => p.catch((e) => ({ ok: false, error: String(e?.message || e).slice(0, 300) }));

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-opus-r5-'));
    uploadFile = path.join(tmpDir, 'avatar.txt');
    fs.writeFileSync(uploadFile, 'avatar-bytes');
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

  describe('R5O-BUG-01 web-component submit buttons (slotted label, type=submit on host)', () => {
    it('R5O-BUG-01-CTRL fixture really submits with allowSubmit=true, and a native submit button is blocked', async () => {
      await open('wcbtn');
      const allowed = await actFast(page, { action: 'click', selector: '#xb', allowSubmit: true });
      assert.equal(allowed.ok, true, JSON.stringify(allowed));
      assert.equal(await submits(), 1, 'x-button fixture must submit when explicitly allowed');

      await open('plainbtn');
      const blocked = await actFast(page, { action: 'click', selector: '#pb' });
      assert.equal(blocked.blocked, true, JSON.stringify(blocked));
      const viaLabel = await actFast(page, { action: 'click', selector: '#lbl' });
      assert.equal(viaLabel.blocked, true, JSON.stringify(viaLabel));
      assert.equal(await submits(), 0);
    });

    it('R5O-BUG-01a act_fast click by selector on <x-button type="submit">Submit order</x-button> must not submit', async () => {
      await open('wcbtn');
      const res = await safe(actFast(page, { action: 'click', selector: '#xb' }));
      const n = await submits();
      assert.equal(n, 0, `allowSubmit=false let a web-component submit button submit the form ${n}x; result=${JSON.stringify(res)}`);
    });

    it('R5O-BUG-01b act_fast click by visible text "Submit order" (web-component host) must not submit', async () => {
      await open('wcbtn');
      const res = await safe(actFast(page, { action: 'click', text: 'Submit order' }));
      const n = await submits();
      assert.equal(n, 0, `text-targeted click submitted the form ${n}x; result=${JSON.stringify(res)}`);
    });

    it('R5O-BUG-01c act_fast viewport {x,y} click on the web-component submit button must not submit', async () => {
      await open('wcbtn');
      const box = await page.locator('#xb').boundingBox();
      const res = await safe(actFast(page, { action: 'click', x: box.x + box.width / 2, y: box.y + box.height / 2 }));
      const n = await submits();
      assert.equal(n, 0, `coordinate click submitted the form ${n}x; result=${JSON.stringify(res)}`);
    });
  });

  describe('R5O-BUG-02 press Enter on a delegatesFocus shadow host', () => {
    it('R5O-BUG-02-CTRL fixture submits via Enter on the host when allowSubmit=true', async () => {
      await open('dfocus');
      const res = await actFast(page, { action: 'press', selector: '#host', key: 'Enter', allowSubmit: true });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(await submits(), 1, 'delegatesFocus fixture must submit when explicitly allowed');
    });

    it('R5O-BUG-02 act_fast press Enter targeting the host must not implicitly submit the shadow form it delegates focus to', async () => {
      await open('dfocus');
      const res = await safe(actFast(page, { action: 'press', selector: '#host', key: 'Enter', timeoutMs: 3000 }));
      const n = await submits();
      assert.equal(n, 0, `Enter on a delegatesFocus host reached the inner <input> and submitted ${n}x; result=${JSON.stringify(res)}`);
    });
  });

  describe('R5O-BUG-03 act_fast select/upload/check must not trigger onchange auto-submit under allowSubmit=false', () => {
    it('R5O-BUG-03a act_fast select on <select onchange="this.form.requestSubmit()"> must not submit', async () => {
      await open('autosel');
      const res = await safe(actFast(page, { action: 'select', selector: '#s', value: 'a' }));
      const n = await submits();
      assert.equal(n, 0, `act_fast select auto-submitted the form ${n}x; result=${JSON.stringify(res)}`);
    });

    it('R5O-BUG-03b act_fast upload on <input type=file onchange="this.form.requestSubmit()"> must not submit', async () => {
      await open('autoup');
      const res = await safe(actFast(page, { action: 'upload', selector: '#fi', file: uploadFile }));
      const n = await submits();
      assert.equal(n, 0, `act_fast upload auto-submitted the form ${n}x; result=${JSON.stringify(res)}`);
    });

    it('R5O-BUG-03c act_fast check on <input type=checkbox onchange="this.form.requestSubmit()"> must not submit', async () => {
      await open('autochk');
      const res = await safe(actFast(page, { action: 'check', selector: '#c', timeoutMs: 3000 }));
      const n = await submits();
      assert.equal(n, 0, `act_fast check auto-submitted the form ${n}x; result=${JSON.stringify(res)}`);
    });

    it('R5O-REG-05 control: smart_fill_form (stopBeforeSubmit default) selects the same auto-submit <select> without submitting', async () => {
      await open('autosel');
      const res = await smartFillForm(page, { fields: [{ keys: 'Sort', value: 'Alpha' }] });
      assert.equal(await page.locator('#s').inputValue(), 'a', JSON.stringify(res));
      assert.equal(await submits(), 0, JSON.stringify(res));
    });
  });

  describe('R5O-BUG-04 inspect_compact selector scoped to a shadow host', () => {
    it('R5O-BUG-04 selector "#card" (open shadow host) must list the controls inside its own shadow root', async () => {
      await open('hostscope');
      const full = await inspectCompact(page, {});
      assert.match(full.text, /Inner email/, `control: unscoped snapshot sees the shadow input\n${full.text}`);
      const scoped = await inspectCompact(page, { selector: '#card' });
      assert.match(
        scoped.text,
        /Inner email/,
        `scoping inspect_compact to a web-component host drops its whole shadow tree\n${scoped.text}`
      );
      assert.doesNotMatch(scoped.text, /Outside field/, scoped.text);
    });
  });

  describe('R5O-BUG-05 smart_fill_form must not report values the browser rejected', () => {
    it('R5O-BUG-05 date "12/25/2026" and number "abc" are reported as filled while the inputs stay empty', async () => {
      await open('typed');
      const res = await smartFillForm(page, {
        fields: [
          { keys: 'Start date', value: '12/25/2026' },
          { keys: 'Guest count', value: 'abc' },
          { keys: 'End date', value: '2026-12-31' },
        ],
      });
      const dateVal = await page.locator('#d').inputValue();
      const numVal = await page.locator('#n').inputValue();
      const ctrlVal = await page.locator('#d2').inputValue();
      assert.equal(ctrlVal, '2026-12-31', `control: ISO date fills; ${JSON.stringify(res)}`);
      assert.ok(res.filled.some((f) => f.idx === 2), `control: ISO date reported filled; ${JSON.stringify(res)}`);
      const misreported = res.filled.filter(
        (f) => (f.idx === 0 && dateVal === '') || (f.idx === 1 && numVal === '')
      );
      assert.deepEqual(
        misreported,
        [],
        `smart_fill_form reported ${misreported.length} field(s) as filled but the DOM value is empty (date="${dateVal}", number="${numVal}"); ${JSON.stringify(res)}`
      );
    });
  });

  describe('R5O-BUG-06 playwright-loader picks the newest cached Chromium revision', () => {
    it('R5O-BUG-06 chromium-1200 must win over chromium-999 (numeric, not lexicographic, revision order)', () => {
      const cache = fs.mkdtempSync(path.join(tmpDir, 'pwcache-'));
      const rel =
        process.platform === 'win32'
          ? ['chrome-win64', 'chrome.exe']
          : process.platform === 'darwin'
            ? ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']
            : ['chrome-linux', 'chrome'];
      for (const rev of ['chromium-999', 'chromium-1200']) {
        const exe = path.join(cache, rev, ...rel);
        fs.mkdirSync(path.dirname(exe), { recursive: true });
        fs.writeFileSync(exe, '');
      }
      const saved = {
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
        TURBO_BROWSER_EXECUTABLE: process.env.TURBO_BROWSER_EXECUTABLE,
      };
      let picked;
      try {
        process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
        delete process.env.TURBO_BROWSER_EXECUTABLE;
        picked = resolveChromiumExecutable({ executablePath: () => '' }, false).executablePath || '';
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
      assert.ok(picked.includes(`${path.sep}chromium-1200${path.sep}`), `picked older revision: ${picked}`);
    });
  });

  describe('regression verification of the latest fixes', () => {
    it('R5O-REG-01 wait {url} resolves regex (\\d+$) and ** glob SPA URL changes, and times out on a non-matching regex', async () => {
      await open('urlwait');
      await page.evaluate(() => setTimeout(() => history.pushState({}, '', '/done/42'), 50));
      const r1 = await actFast(page, { action: 'wait', url: '/done/\\d+$', timeoutMs: 4000 });
      assert.equal(r1.ok, true);
      assert.match(page.url(), /\/done\/42$/);
      await page.evaluate(() => setTimeout(() => history.pushState({}, '', '/files/report.pdf'), 50));
      const r2 = await actFast(page, { action: 'wait', url: '**/files/*.pdf', timeoutMs: 4000 });
      assert.equal(r2.ok, true);
      assert.match(page.url(), /report\.pdf$/);
      await assert.rejects(actFast(page, { action: 'wait', url: '/never/\\d+$', timeoutMs: 300 }));
    });

    it('R5O-REG-02 closed <details> and content-visibility:hidden fields are excluded from inspect_compact and smart_fill_form; opening <details> makes the field fillable', async () => {
      await open('hiddenctx');
      const snap = await inspectCompact(page, { mode: 'forms' });
      assert.match(snap.text, /Visible promo/, snap.text);
      assert.doesNotMatch(snap.text, /Hidden promo|CV promo/, snap.text);
      const res = await smartFillForm(page, { fields: [{ keys: 'promo', value: 'P1', all: true }] });
      assert.equal(await page.locator('#vp').inputValue(), 'P1', JSON.stringify(res));
      assert.equal(await page.locator('#hp').inputValue(), '', JSON.stringify(res));
      assert.equal(await page.locator('#cv').inputValue(), '', JSON.stringify(res));
      await page.evaluate(() => { document.getElementById('det').open = true; });
      const res2 = await smartFillForm(page, { fields: [{ keys: 'Hidden promo', value: 'P2' }] });
      assert.equal(await page.locator('#hp').inputValue(), 'P2', JSON.stringify(res2));
    });

    it('R5O-REG-03 smart_fill_form selector picks the first match in composed (Shadow + Light) document order', async () => {
      await open('composed');
      const res = await smartFillForm(page, { fields: [{ selector: 'input.tgt', value: 'V' }] });
      assert.equal(await page.locator('#sh').inputValue(), 'V', JSON.stringify(res));
      assert.equal(await page.locator('#light').inputValue(), '', JSON.stringify(res));
    });

    it('R5O-REG-04 press Enter via disabled/inert targets keeps the focused form unsubmitted; focusable input Enter blocked, allowed only with allowSubmit=true', async () => {
      for (const sel of ['#dis', '#inert']) {
        await open('pressnf');
        await page.focus('#q');
        const res = await safe(actFast(page, { action: 'press', selector: sel, key: 'Enter', timeoutMs: 2000 }));
        assert.equal(await submits(), 0, `${sel}: ${JSON.stringify(res)}`);
      }
      await open('pressnf');
      const blocked = await actFast(page, { action: 'press', selector: '#q', key: 'Enter' });
      assert.equal(blocked.blocked, true, JSON.stringify(blocked));
      assert.equal(await submits(), 0);
      const allowed = await actFast(page, { action: 'press', selector: '#q', key: 'Enter', allowSubmit: true });
      assert.equal(allowed.ok, true);
      assert.equal(await submits(), 1);
    });

    it('R5O-REG-06 resolveSafePath confines to TURBO_BROWSER_SAVE_ROOT (traversal rejected, nested new dirs allowed, case-insensitive on win32)', () => {
      const saved = process.env.TURBO_BROWSER_SAVE_ROOT;
      try {
        process.env.TURBO_BROWSER_SAVE_ROOT = tmpDir;
        const inside = resolveSafePath(path.join(tmpDir, 'new', 'deep', 'out.json'));
        assert.ok(inside.toLowerCase().endsWith(path.join('new', 'deep', 'out.json').toLowerCase()), inside);
        assert.throws(() => resolveSafePath(path.join(tmpDir, '..', 'escape.json')), /outside allowed root/);
        assert.throws(() => resolveSafePath(path.join(tmpDir, 'a', '..', '..', 'escape.json')), /outside allowed root/);
        assert.throws(() => resolveSafePath('ok\0.json'), /null byte/);
        if (process.platform === 'win32') {
          const upper = resolveSafePath(path.join(tmpDir.toUpperCase(), 'case.json'));
          assert.ok(upper.toLowerCase().endsWith('case.json'), upper);
          assert.throws(() => resolveSafePath(path.join(tmpDir, 'file.json:stream')), /alternate data stream|colon/);
        }
      } finally {
        if (saved === undefined) delete process.env.TURBO_BROWSER_SAVE_ROOT;
        else process.env.TURBO_BROWSER_SAVE_ROOT = saved;
      }
    });
  });
});
