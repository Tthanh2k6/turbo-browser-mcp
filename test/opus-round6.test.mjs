// opus-round6: independent outer gatekeeper suite (opus-gatekeeper-5).
//
// Outcome-based: every submit-guard assertion counts real `submit` events that reached the page's own
// listener (document bubble listener for light-DOM forms, or the form's own listener inside a shadow
// root, where the non-composed `submit` event never reaches `document`). Every listener calls
// preventDefault() so nothing navigates and the counters stay deterministic.
//
// "R6O-REG-*" tests independently re-verify the latest fixes (R5O-BUG-01..06, R6-BUG-01..11) with fresh
// fixtures and positive controls. "R6O-BUG-*" tests reproduce defects found by reading src/*.mjs line by
// line and confirmed against Chromium; each has a passing control proving the fixture is valid.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, extractCleanText, inspectCompact, smartFillForm } from '../src/dom-engine.mjs';
import { resolveChromiumExecutable } from '../src/playwright-loader.mjs';

const COUNTER = `<script>window.__submits=0;document.addEventListener('submit',function(e){e.preventDefault();window.__submits++;});</script>`;
const wrap = (body, withCounter = true) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>round6o</title></head><body>${withCounter ? COUNTER : ''}${body}</body></html>`;

// Web-component submit button: no role on host, slotted label, type on the host, internal <button>.
const XBUTTON_DEF = `<script>
customElements.define('x-button', class extends HTMLElement {
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.innerHTML = '<button part="base" style="padding:10px 24px;font:16px sans-serif"><slot></slot></button>';
    r.querySelector('button').addEventListener('click', () => {
      const t = (this.getAttribute('type') || '');
      const f = this.closest('form');
      if (!f) return;
      if (t === 'submit') f.requestSubmit();
      if (t === 'reset') f.reset();
    });
  }
});
</script>`;

// Shadow form whose own (non-composed) submit is counted from inside the shadow tree.
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
  wcbtn: `${XBUTTON_DEF}<form action="/submit" method="post"><input name="q" value="x">
<x-button id="xsub" type="submit">Submit order</x-button>
<x-button id="xbtn" type="button">Toggle details</x-button>
<x-button id="xrst" type="reset">Clear form</x-button></form>`,
  dfocusOpen: `<x-signup id="host"></x-signup>${shadowFormComponent(
    'x-signup',
    'open',
    true,
    '<form action="/submit" method="post"><input name="email" value="a@b.c"><button type="submit">Subscribe</button></form>'
  )}`,
  autoctl: `<form action="/submit" method="post">
<label>Sort <select id="s" name="s" onchange="this.form.requestSubmit()"><option value="">--</option><option value="a">Alpha</option></select></label>
<label><input id="c" type="checkbox" name="c" onchange="this.form.requestSubmit()"> Remember me</label>
<label>Avatar <input id="fi" type="file" name="f" onchange="this.form.requestSubmit()"></label>
<button>Place order</button></form>`,
  shadowNonComposed: `<x-wrap id="w"></x-wrap>${shadowFormComponent(
    'x-wrap',
    'open',
    false,
    '<form action="/submit" method="post"><input name="a" value="1"><button id="ib">Go</button></form>'
  )}<label>Plan <select id="plan" onchange="document.getElementById('w').shadowRoot.getElementById('ib').click()">
<option value="">--</option><option value="pro">Pro</option></select></label>`,
  face: `<script>
customElements.define('x-field', class extends HTMLElement {
  static formAssociated = true;
  constructor() {
    super();
    this.internals = this.attachInternals();
    const r = this.attachShadow({ mode: 'open' });
    r.innerHTML = '<input id="inner" aria-label="Coupon code">';
    r.querySelector('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && this.internals.form) this.internals.form.requestSubmit(); });
  }
});
</script><form action="/submit" method="post"><x-field id="xf"></x-field><button>Place order</button></form>`,
  safeVsNonButton: `<form action="/submit" method="post"><label><input id="nd" type="checkbox" name="nd" onchange="this.form.requestSubmit()"> Next day delivery</label>
<button>Place order</button></form>
<form action="/search" method="get"><input name="q" value="shoes"><button id="sb" type="submit">Search</button></form>`,
  typed: `<label>Theme <input id="col" type="color" value="#112233"></label>
<label>Volume <input id="rng" type="range" min="0" max="10" value="3"></label>
<label>Locked code <input id="ctl" value="old" oninput="this.value='old'"></label>
<label>Start date <input id="d" type="date"></label>
<label>Guest count <input id="n" type="number"></label>`,
  article: `<x-art></x-art><script>
customElements.define('x-art', class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<h2><slot name="t"></slot></h2><p>Shadow paragraph body</p><ul><li><slot name="li"></slot></li></ul>'; }
});
document.querySelector('x-art').innerHTML = '<span slot="t">Slotted headline</span><span slot="li">Slotted bullet</span>';
</script>`,
  hostscope: `<x-card id="card"><span>Light slotted note</span></x-card><p><input aria-label="Outside field"></p><script>
customElements.define('x-card', class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<div>Card header <slot></slot></div><label>Inner email <input aria-label="Inner email"></label>'; }
});
</script>`,

  // ---- defect fixtures ----
  // Auto-submit deferred by one microtask: Vue watchers / nextTick, async handlers (`await validate()`).
  microtask: `<form action="/submit" method="post">
<label>Sort <select id="ms" name="ms" onchange="Promise.resolve().then(() => this.form.requestSubmit())"><option value="">--</option><option value="a">Alpha</option></select></label>
<label>City <input id="mc" name="mc" oninput="queueMicrotask(() => this.form.requestSubmit())"></label>
<label><input id="mk" type="checkbox" name="mk" onchange="(async () => { await null; this.form.requestSubmit(); })()"> Agree to terms</label>
<button>Place order</button></form>`,
  // Kanban / upload drop zone whose drop handler auto-submits.
  drag: `<form action="/submit" method="post"><input name="q" value="x">
<div id="card" draggable="true" style="width:140px;height:40px;background:#ccc">Task card</div>
<div id="zone" style="width:220px;height:80px;margin-top:20px;background:#eef">Drop zone</div></form>
<script>
const z = document.getElementById('zone');
z.addEventListener('dragover', (e) => e.preventDefault());
z.addEventListener('drop', (e) => { e.preventDefault(); document.forms[0].requestSubmit(); });
document.getElementById('card').addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', 'c'));
</script>`,
  // Same-origin embedded widget whose button submits the host page's form.
  xframeParent: `<form action="/submit" method="post"><input name="q" value="x"></form><iframe id="f" src="/page/xframeChild" style="width:400px;height:100px"></iframe>`,
  xframeChild: `<button id="cb" type="button" style="padding:8px" onclick="parent.document.forms[0].requestSubmit()">Finish</button>`,
  closedPay: `<x-pay id="host" style="display:inline-block"></x-pay>${shadowFormComponent(
    'x-pay',
    'closed',
    false,
    '<form action="/submit" method="post" style="margin:0"><button style="padding:20px">Pay now</button></form>'
  )}`,
  openPay: `<x-pay-open id="host" style="display:inline-block"></x-pay-open>${shadowFormComponent(
    'x-pay-open',
    'open',
    false,
    '<form action="/submit" method="post" style="margin:0"><button style="padding:20px">Pay now</button></form>'
  )}`,
  closedEnter: `<x-checkout id="host"></x-checkout>${shadowFormComponent(
    'x-checkout',
    'closed',
    true,
    '<form action="/submit" method="post"><input name="email" value="a@b.c"><button>Place order</button></form>'
  )}`,
  // Two text fields and no submit button: HTML implicit submission does nothing on Enter.
  nobtnMulti: `<form action="/submit" method="post"><label>Skill <input id="skill" name="skill"></label><label>Full name <input id="fn" name="fn"></label></form>
<script>window.__chips=0;document.getElementById('skill').addEventListener('keydown',(e)=>{if(e.key==='Enter'){e.preventDefault();window.__chips++;}});</script>`,
  nobtnSingle: `<form action="/submit" method="post"><label>Message <input id="msg" name="msg" value="hi"></label></form>`,
};

function startFixture() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
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
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

describe('opus-round6: outer gatekeeper suite', { concurrency: 1 }, () => {
  let fx;
  let manager;
  let page;
  let tmpDir;
  let uploadFile;

  const open = async (name) => {
    await page.goto(`${fx.base}/page/${name}`, { waitUntil: 'load' });
    return page;
  };
  // Submit events fire synchronously (or within the same task's microtasks); one task turn flushes them.
  const submits = async () => page.evaluate(() => new Promise((r) => setTimeout(() => r(window.__submits), 0)));
  const safe = (p) => p.catch((e) => ({ ok: false, error: String(e?.message || e).slice(0, 300) }));
  const prototypesNative = () =>
    page.evaluate(() =>
      [HTMLFormElement.prototype.submit, HTMLFormElement.prototype.requestSubmit, Element.prototype.attachShadow].every(
        (fn) => Function.prototype.toString.call(fn).includes('[native code]')
      )
    );

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-opus-r6-'));
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

  describe('regression verification of R5O-BUG-01..06 and R6-BUG-01..11 fixes', () => {
    it('R6O-REG-01 <x-button type="submit"> is blocked by selector, text and {x,y}; type="button"/"reset" hosts are not over-blocked; allowSubmit=true submits', async () => {
      await open('wcbtn');
      for (const target of [{ selector: '#xsub' }, { text: 'Submit order' }]) {
        const res = await actFast(page, { action: 'click', ...target });
        assert.equal(res.blocked, true, `${JSON.stringify(target)} ${JSON.stringify(res)}`);
      }
      const box = await page.locator('#xsub').boundingBox();
      const xy = await actFast(page, { action: 'click', x: box.x + box.width / 2, y: box.y + box.height / 2 });
      assert.equal(xy.blocked, true, JSON.stringify(xy));
      assert.equal(await submits(), 0);

      const toggle = await actFast(page, { action: 'click', selector: '#xbtn' });
      assert.equal(toggle.ok, true, `type="button" host must not be blocked: ${JSON.stringify(toggle)}`);
      const reset = await actFast(page, { action: 'click', selector: '#xrst' });
      assert.equal(reset.ok, true, `type="reset" host must not be blocked: ${JSON.stringify(reset)}`);
      assert.equal(await submits(), 0);

      const allowed = await actFast(page, { action: 'click', selector: '#xsub', allowSubmit: true });
      assert.equal(allowed.ok, true);
      assert.equal(await submits(), 1);
    });

    it('R6O-REG-02 Enter and Control+Enter on an open delegatesFocus host are blocked; allowSubmit=true submits the shadow form', async () => {
      for (const key of ['Enter', 'Control+Enter']) {
        await open('dfocusOpen');
        const res = await safe(actFast(page, { action: 'press', selector: '#host', key, timeoutMs: 3000 }));
        assert.equal(await submits(), 0, `${key}: ${JSON.stringify(res)}`);
      }
      await open('dfocusOpen');
      const allowed = await actFast(page, { action: 'press', selector: '#host', key: 'Enter', allowSubmit: true });
      assert.equal(allowed.ok, true);
      assert.equal(await submits(), 1);
    });

    it('R6O-REG-03 act_fast select/check/upload block synchronous onchange requestSubmit() and restore native prototypes afterwards', async () => {
      await open('autoctl');
      await actFast(page, { action: 'select', selector: '#s', value: 'a' });
      await actFast(page, { action: 'check', selector: '#c' });
      await actFast(page, { action: 'upload', selector: '#fi', file: uploadFile });
      assert.equal(await page.locator('#s').inputValue(), 'a');
      assert.equal(await page.locator('#c').isChecked(), true);
      assert.equal(await submits(), 0);
      assert.equal(await prototypesNative(), true, 'guard must restore HTMLFormElement/Element prototypes');

      await open('autoctl');
      await actFast(page, { action: 'select', selector: '#s', value: 'a', allowSubmit: true });
      assert.equal(await submits(), 1, 'control: fixture auto-submits when allowed');
    });

    it('R6O-REG-04 non-composed submit inside an open ShadowRoot form (triggered by act_fast select onchange) is blocked; allowed when allowSubmit=true', async () => {
      await open('shadowNonComposed');
      await actFast(page, { action: 'select', selector: '#plan', value: 'pro' });
      assert.equal(await submits(), 0);
      await open('shadowNonComposed');
      await actFast(page, { action: 'select', selector: '#plan', value: 'pro', allowSubmit: true });
      assert.equal(await submits(), 1);
    });

    it('R6O-REG-05 Enter inside a form-associated custom element input (ElementInternals.form.requestSubmit) is blocked; allowSubmit=true submits', async () => {
      await open('face');
      const res = await safe(actFast(page, { action: 'press', selector: 'x-field input', key: 'Enter' }));
      assert.equal(await submits(), 0, JSON.stringify(res));
      const allowed = await actFast(page, { action: 'press', selector: 'x-field input', key: 'Enter', allowSubmit: true });
      assert.equal(allowed.ok, true);
      assert.equal(await submits(), 1);
    });

    it('R6O-REG-06 SAFE_SUBMIT_TYPE_RE: a checkbox labelled "Next day delivery" keeps the runtime guard, while a real Search submit button stays allowed', async () => {
      await open('safeVsNonButton');
      const chk = await actFast(page, { action: 'check', selector: '#nd' });
      assert.equal(chk.ok, true, JSON.stringify(chk));
      assert.equal(await page.locator('#nd').isChecked(), true);
      assert.equal(await submits(), 0, 'non-button control labelled Next must not bypass the guard');
      const search = await actFast(page, { action: 'click', selector: '#sb' });
      assert.equal(search.ok, true, JSON.stringify(search));
      assert.equal(await submits(), 1, 'explicit safe Search submit is allowed by design');
    });

    it('R6O-REG-07 smart_fill_form rejects invalid color/range/date/number values and controlled snap-back, and fills valid ones', async () => {
      await open('typed');
      const bad = await smartFillForm(page, {
        overwrite: true,
        fields: [
          { selector: '#col', value: 'red' },
          { selector: '#rng', value: 'abc' },
          { selector: '#ctl', value: 'new' },
          { keys: 'Start date', value: '12/25/2026' },
          { keys: 'Guest count', value: 'abc' },
        ],
      });
      assert.deepEqual(bad.filled, [], JSON.stringify(bad));
      assert.equal(bad.skipped.filter((s) => s.reason === 'value-rejected-by-input').length, 5, JSON.stringify(bad.skipped));
      assert.equal(await page.locator('#col').inputValue(), '#112233');
      assert.equal(await page.locator('#rng').inputValue(), '3');
      assert.equal(await page.locator('#ctl').inputValue(), 'old');

      const good = await smartFillForm(page, {
        overwrite: true,
        fields: [
          { selector: '#col', value: '#AABBCC' },
          { selector: '#rng', value: '7' },
          { keys: 'Start date', value: '2026-12-25' },
          { keys: 'Guest count', value: '4' },
        ],
      });
      assert.equal(good.filled.length, 4, JSON.stringify(good));
      assert.equal(await page.locator('#col').inputValue(), '#aabbcc');
      assert.equal(await page.locator('#rng').inputValue(), '7');
      assert.equal(await page.locator('#d').inputValue(), '2026-12-25');
      assert.equal(await page.locator('#n').inputValue(), '4');
    });

    it('R6O-REG-08 inspect_compact article mode composes <slot> text for shadow headings, paragraphs and list items', async () => {
      await open('article');
      const snap = await inspectCompact(page, { mode: 'article' });
      assert.match(snap.text, /<h2> Slotted headline/, snap.text);
      assert.match(snap.text, /<p> Shadow paragraph body/, snap.text);
      assert.match(snap.text, /<li> Slotted bullet/, snap.text);
    });

    it('R6O-REG-09 inspect_compact / extract_clean_text scoped to a shadow host see its shadow tree once, without duplicating slotted content', async () => {
      await open('hostscope');
      const scoped = await inspectCompact(page, { selector: '#card' });
      assert.match(scoped.text, /Inner email/, scoped.text);
      assert.doesNotMatch(scoped.text, /Outside field/, scoped.text);
      const txt = await extractCleanText(page, { selector: '#card', includeFrames: false });
      const body = txt.text.split('\n\n').slice(1).join('\n\n');
      assert.equal(body.split('Light slotted note').length - 1, 1, body);
      assert.match(body, /Card header/, body);
    });

    it('R6O-REG-10 resolveChromiumExecutable sorts revisions numerically and breaks ties toward chromium_headless_shell when headless', () => {
      const rel =
        process.platform === 'win32'
          ? ['chrome-win64', 'chrome.exe']
          : process.platform === 'darwin'
            ? ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']
            : ['chrome-linux', 'chrome'];
      const pick = (dirs, headless) => {
        const cache = fs.mkdtempSync(path.join(tmpDir, 'pwcache-'));
        for (const d of dirs) {
          const exe = path.join(cache, d, ...rel);
          fs.mkdirSync(path.dirname(exe), { recursive: true });
          fs.writeFileSync(exe, '');
        }
        const saved = {
          PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
          TURBO_BROWSER_EXECUTABLE: process.env.TURBO_BROWSER_EXECUTABLE,
        };
        try {
          process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
          delete process.env.TURBO_BROWSER_EXECUTABLE;
          return resolveChromiumExecutable({ executablePath: () => '' }, headless).executablePath || '';
        } finally {
          for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
          }
        }
      };
      const seg = (d) => `${path.sep}${d}${path.sep}`;
      assert.ok(pick(['chromium-999', 'chromium-1200'], false).includes(seg('chromium-1200')));
      assert.ok(pick(['chromium-1200', 'chromium_headless_shell-1200', 'chromium-999'], true).includes(seg('chromium_headless_shell-1200')));
      assert.ok(pick(['chromium-1201', 'chromium_headless_shell-1200'], true).includes(seg('chromium-1201')));
      assert.ok(pick(['chromium_headless_shell-1300', 'chromium-1200'], false).includes(seg('chromium-1200')), 'headed mode must ignore headless_shell');
    });
  });

  describe('R6O-BUG-01 smart_fill_form Pass 1 guard is torn down before microtask-deferred auto-submits run', () => {
    it('R6O-BUG-01-CTRL act_fast select on the same microtask-deferred fixture is guarded (0 submits), and the fixture submits when allowed', async () => {
      await open('microtask');
      await actFast(page, { action: 'select', selector: '#ms', value: 'a' });
      assert.equal(await submits(), 0);
      await open('microtask');
      await actFast(page, { action: 'select', selector: '#ms', value: 'a', allowSubmit: true });
      assert.equal(await submits(), 1);
    });

    it('R6O-BUG-01a smart_fill_form <select onchange="Promise.resolve().then(requestSubmit)"> must not submit', async () => {
      await open('microtask');
      const res = await smartFillForm(page, { fields: [{ keys: 'Sort', value: 'Alpha' }] });
      assert.equal(await page.locator('#ms').inputValue(), 'a', JSON.stringify(res));
      const n = await submits();
      assert.equal(n, 0, `stopBeforeSubmit=true let a microtask-deferred onchange submit the form ${n}x; ${JSON.stringify(res)}`);
    });

    it('R6O-BUG-01b smart_fill_form <input oninput="queueMicrotask(requestSubmit)"> must not submit', async () => {
      await open('microtask');
      const res = await smartFillForm(page, { fields: [{ keys: 'City', value: 'Hanoi' }] });
      assert.equal(await page.locator('#mc').inputValue(), 'Hanoi', JSON.stringify(res));
      const n = await submits();
      assert.equal(n, 0, `microtask-deferred oninput submitted ${n}x; ${JSON.stringify(res)}`);
    });

    it('R6O-BUG-01c smart_fill_form checkbox with async onchange (await; requestSubmit) must not submit', async () => {
      await open('microtask');
      const res = await smartFillForm(page, { fields: [{ keys: 'Agree to terms', value: true }] });
      assert.equal(await page.locator('#mk').isChecked(), true, JSON.stringify(res));
      const n = await submits();
      assert.equal(n, 0, `async onchange submitted ${n}x; ${JSON.stringify(res)}`);
    });
  });

  describe('R6O-BUG-02 act_fast drag has no runtime submit guard (unlike drop)', () => {
    it('R6O-BUG-02-CTRL act_fast drop on the same zone is guarded, and drag submits when allowSubmit=true', async () => {
      await open('drag');
      const dropped = await actFast(page, { action: 'drop', selector: '#zone', dropData: { 'text/plain': 'c' } });
      assert.equal(dropped.ok, true);
      assert.equal(await submits(), 0);
      await open('drag');
      const allowed = await actFast(page, { action: 'drag', selector: '#card', targetSelector: '#zone', allowSubmit: true });
      assert.equal(allowed.ok, true);
      assert.equal(await submits(), 1);
    });

    it('R6O-BUG-02 act_fast drag onto a drop zone whose drop handler calls requestSubmit() must not submit', async () => {
      await open('drag');
      const res = await safe(actFast(page, { action: 'drag', selector: '#card', targetSelector: '#zone' }));
      const n = await submits();
      assert.equal(n, 0, `allowSubmit=false drag submitted the form ${n}x; ${JSON.stringify(res)}`);
    });
  });

  describe('R6O-BUG-03 act_fast runtime guard covers only the target frame', () => {
    it('R6O-BUG-03-CTRL the same-origin iframe button submits the parent form when allowSubmit=true', async () => {
      await open('xframeParent');
      await page.frameLocator('#f').locator('#cb').waitFor();
      const res = await actFast(page, { action: 'click', selector: '#cb', allowSubmit: true });
      assert.equal(res.ok, true);
      assert.equal(await submits(), 1);
    });

    it('R6O-BUG-03 clicking a neutral iframe button that calls parent.document.forms[0].requestSubmit() must not submit', async () => {
      await open('xframeParent');
      await page.frameLocator('#f').locator('#cb').waitFor();
      const res = await safe(actFast(page, { action: 'click', selector: '#cb' }));
      const n = await submits();
      assert.equal(n, 0, `cross-frame submit escaped the frame-scoped guard ${n}x; ${JSON.stringify(res)}`);
    });
  });

  describe('R6O-BUG-04 closed Shadow DOM submit controls bypass allowSubmit=false', () => {
    it('R6O-BUG-04-CTRL open-shadow "Pay now" host is blocked; closed fixture submits when allowSubmit=true', async () => {
      await open('openPay');
      const blocked = await actFast(page, { action: 'click', selector: '#host' });
      assert.equal(blocked.blocked, true, JSON.stringify(blocked));
      assert.equal(await submits(), 0);
      await open('closedPay');
      const allowed = await actFast(page, { action: 'click', selector: '#host', allowSubmit: true });
      assert.equal(allowed.ok, true);
      assert.equal(await submits(), 1);
    });

    it('R6O-BUG-04a act_fast click on a closed-shadow host rendering a native "Pay now" submit button must not submit', async () => {
      await open('closedPay');
      const res = await safe(actFast(page, { action: 'click', selector: '#host' }));
      const n = await submits();
      assert.equal(n, 0, `closed-shadow Pay now button submitted ${n}x; ${JSON.stringify(res)}`);
    });

    it('R6O-BUG-04b act_fast press Enter on a closed delegatesFocus host must not implicitly submit its shadow form', async () => {
      await open('closedEnter');
      const res = await safe(actFast(page, { action: 'press', selector: '#host', key: 'Enter', timeoutMs: 3000 }));
      const n = await submits();
      assert.equal(n, 0, `Enter reached the closed-shadow <input> and submitted ${n}x; ${JSON.stringify(res)}`);
    });
  });

  describe('R6O-BUG-05 Enter over-blocked in a multi-field form that has no submit button', () => {
    it('R6O-BUG-05-CTRL single-field form without a submit button is blocked (Chromium does implicitly submit it), and allowSubmit=true proves the multi-field form never submits natively', async () => {
      await open('nobtnSingle');
      const single = await actFast(page, { action: 'press', selector: '#msg', key: 'Enter' });
      assert.equal(single.blocked, true, JSON.stringify(single));
      const singleAllowed = await actFast(page, { action: 'press', selector: '#msg', key: 'Enter', allowSubmit: true });
      assert.equal(singleAllowed.ok, true);
      assert.equal(await submits(), 1, 'single-field implicit submission is real');

      await open('nobtnMulti');
      await page.locator('#fn').fill('Ada');
      const multiAllowed = await actFast(page, { action: 'press', selector: '#fn', key: 'Enter', allowSubmit: true });
      assert.equal(multiAllowed.ok, true);
      assert.equal(await submits(), 0, 'HTML implicit submission must not fire with two fields and no submit button');
    });

    it('R6O-BUG-05 press Enter in a tag-input of a two-field form without submit button must not be blocked', async () => {
      await open('nobtnMulti');
      const res = await actFast(page, { action: 'press', selector: '#skill', key: 'Enter' });
      assert.equal(res.blocked, undefined, `Enter that cannot submit was blocked as implicit-form-enter: ${JSON.stringify(res)}`);
      assert.equal(await page.evaluate(() => window.__chips), 1);
      assert.equal(await submits(), 0);
    });
  });
});
