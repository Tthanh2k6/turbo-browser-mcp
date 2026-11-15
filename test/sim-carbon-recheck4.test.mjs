// sim-carbon-recheck4: Round-6 Pre-Opus Independent Auditor suite (gemini-auditor-5).
// Validates all #137 fixes (R6-REG-01..06) and reproduces newly uncovered real browser defects
// (R6-BUG-01..06) across Web Component slots/shadow trees, delegatesFocus, shadow form submit
// events, act_fast fill/type/clear/drop auto-submit guards, scoped Shadow DOM inspection/prefill,
// smart_fill_form rejected overwrite/color/range values, and mixed-prefix Chromium revision sorting.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { BrowserManager } from '../src/browser-manager.mjs';
import {
  actFast,
  extractCleanText,
  inspectCompact,
  smartFillForm,
} from '../src/dom-engine.mjs';
import { resolveChromiumExecutable } from '../src/playwright-loader.mjs';

const SUBMIT_PROBE = `<script>
  window.__submits = 0;
  window.__clicks = 0;
  document.addEventListener('submit', function (e) {
    e.preventDefault();
    window.__submits++;
  });
</script>`;

const htmlDoc = (body, title = 'round6-recheck') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${SUBMIT_PROBE}${body}</body></html>`;

function startRound6Server() {
  const pages = new Map();
  const posts = new Map();

  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    if (u.pathname === '/submit') {
      const k = u.searchParams.get('k') || 'default';
      req.resume();
      req.on('end', () => {
        posts.set(k, (posts.get(k) || 0) + 1);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(htmlDoc('<h1>Submitted</h1>', 'submitted'));
      });
      return;
    }
    if (pages.has(u.pathname)) {
      const { body, title } = pages.get(u.pathname);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(htmlDoc(body, title));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(htmlDoc('<p>ready</p>', 'ready'));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        setPage(pathname, body, title = 'round6-recheck') {
          pages.set(pathname, { body, title });
        },
        getPosts(key) {
          return posts.get(key) || 0;
        },
      });
    });
  });
}

describe('sim-carbon-recheck4: Round-6 pre-Opus adversarial & regression suite', { concurrency: 1 }, () => {
  let fx;
  let manager;
  let page;
  let tmpDir;
  let uploadFile1;
  let uploadFile2;
  let prevAllowSubmit;

  const openRoute = async (pathname, body, title) => {
    if (body !== undefined) fx.setPage(pathname, body, title);
    await page.goto(`${fx.baseUrl}${pathname}`, { waitUntil: 'load' });
    return page;
  };

  const countSubmits = () =>
    page.evaluate(() => new Promise((r) => setTimeout(() => r(window.__submits || 0), 0)));

  const countClicks = () =>
    page.evaluate(() => new Promise((r) => setTimeout(() => r(window.__clicks || 0), 0)));

  const safe = (p) =>
    p.catch((err) => ({ ok: false, error: String(err?.message || err).slice(0, 300) }));

  before(async () => {
    prevAllowSubmit = process.env.TURBO_BROWSER_ALLOW_SUBMIT;
    delete process.env.TURBO_BROWSER_ALLOW_SUBMIT;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-r6-recheck4-'));
    uploadFile1 = path.join(tmpDir, 'doc-v1.txt');
    uploadFile2 = path.join(tmpDir, 'doc-v2.txt');
    fs.writeFileSync(uploadFile1, 'version-1-payload\n', 'utf8');
    fs.writeFileSync(uploadFile2, 'version-2-payload\n', 'utf8');

    fx = await startRound6Server();
    fx.setPage('/blank', '<p>ready</p>');

    manager = new BrowserManager({ mode: 'launch', headless: true, defaultTimeoutMs: 2500 });
    await manager.tabsBatch([{ action: 'open', url: `${fx.baseUrl}/blank` }]);
    ({ page } = await manager.getPage());
  });

  after(async () => {
    if (prevAllowSubmit === undefined) delete process.env.TURBO_BROWSER_ALLOW_SUBMIT;
    else process.env.TURBO_BROWSER_ALLOW_SUBMIT = prevAllowSubmit;

    await manager?.close();
    if (fx?.server) {
      await new Promise((resolve) => fx.server.close(resolve));
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('Round-6 Regression Suite for #137 Fixes (R6-REG-01 .. R6-REG-06)', () => {
    it('R6-REG-01 web-component <x-button type="submit"> (including nested <slot> forwarding) blocks under allowSubmit=false, while type="reset" / type="button" safe actions and allowSubmit=true work', async () => {
      const body = `
        <script>
          customElements.define('x-inner-btn', class extends HTMLElement {
            constructor() {
              super();
              const r = this.attachShadow({ mode: 'open' });
              r.innerHTML = '<button part="base" style="padding:8px 18px"><slot></slot></button>';
              r.querySelector('button').addEventListener('click', () => {
                const hostType = (this.getAttribute('type') || this.getRootNode()?.host?.getAttribute?.('type') || '').toLowerCase();
                const form = this.closest('form') || this.getRootNode()?.host?.closest?.('form');
                if (hostType === 'submit' && form) form.requestSubmit();
                if (hostType === 'reset' && form) form.reset();
                if (hostType === 'button') window.__clicks++;
              });
            }
          });
          customElements.define('x-outer-btn', class extends HTMLElement {
            constructor() {
              super();
              const r = this.attachShadow({ mode: 'open' });
              r.innerHTML = '<x-inner-btn><slot></slot></x-inner-btn>';
            }
          });
        </script>
        <form action="/submit" method="post">
          <input id="q" name="q" value="initial">
          <x-outer-btn id="nestedSub" type="submit">Submit order</x-outer-btn>
          <x-inner-btn id="resetBtn" type="reset">Reset</x-inner-btn>
          <x-inner-btn id="draftBtn" type="button">Save draft</x-inner-btn>
        </form>
      `;
      await openRoute('/r6-reg-01', body);

      const bySel = await safe(actFast(page, { action: 'click', selector: '#nestedSub' }));
      const byTxt = await safe(actFast(page, { action: 'click', text: 'Submit order' }));
      const box = await page.locator('#nestedSub').boundingBox();
      const byXY = await safe(actFast(page, { action: 'click', x: box.x + box.width / 2, y: box.y + box.height / 2 }));
      assert.equal(
        await countSubmits(),
        0,
        `Nested-slot <x-outer-btn type="submit"> submitted under allowSubmit=false: sel=${JSON.stringify(bySel)}, txt=${JSON.stringify(byTxt)}, xy=${JSON.stringify(byXY)}`
      );

      await actFast(page, { action: 'fill', selector: '#q', value: 'edited' });
      const resetRes = await actFast(page, { action: 'click', selector: '#resetBtn' });
      assert.equal(resetRes.ok, true);
      assert.equal(await page.locator('#q').inputValue(), 'initial');

      const draftRes = await actFast(page, { action: 'click', selector: '#draftBtn' });
      assert.equal(draftRes.ok, true);
      assert.equal(await countClicks(), 1);
      assert.equal(await countSubmits(), 0);

      const allowed = await actFast(page, { action: 'click', selector: '#nestedSub', allowSubmit: true });
      assert.equal(allowed.ok, true);
      assert.equal(await countSubmits(), 1);
    });

    it('R6-REG-02 press Enter and Control+Enter on a delegatesFocus shadow host block form submission under allowSubmit=false and permit under allowSubmit=true', async () => {
      const body = `
        <script>
          customElements.define('x-df-form', class extends HTMLElement {
            constructor() {
              super();
              const r = this.attachShadow({ mode: 'open', delegatesFocus: true });
              r.innerHTML = '<form action="/submit" method="post"><input name="email" value="a@b.co"><button type="submit">Subscribe</button></form>';
              r.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); window.__submits++; });
            }
          });
          customElements.define('x-df-editor', class extends HTMLElement {
            constructor() {
              super();
              const r = this.attachShadow({ mode: 'open', delegatesFocus: true });
              r.innerHTML = '<form action="/submit" method="post"><textarea name="msg">hello</textarea><button type="submit">Send</button></form>';
              const f = r.querySelector('form');
              f.addEventListener('submit', (e) => { e.preventDefault(); window.__submits++; });
              r.querySelector('textarea').addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') f.requestSubmit();
              });
            }
          });
        </script>
        <x-df-form id="dfForm"></x-df-form>
        <x-df-editor id="dfEditor"></x-df-editor>
      `;
      await openRoute('/r6-reg-02', body);

      const blockedEnter = await safe(actFast(page, { action: 'press', selector: '#dfForm', key: 'Enter' }));
      assert.equal(await countSubmits(), 0, `Enter on #dfForm submitted: ${JSON.stringify(blockedEnter)}`);

      const blockedCtrlEnter = await safe(actFast(page, { action: 'press', selector: '#dfEditor', key: 'Control+Enter' }));
      assert.equal(await countSubmits(), 0, `Control+Enter on #dfEditor submitted: ${JSON.stringify(blockedCtrlEnter)}`);

      const allowedEnter = await actFast(page, { action: 'press', selector: '#dfForm', key: 'Enter', allowSubmit: true });
      assert.equal(allowedEnter.ok, true);
      assert.equal(await countSubmits(), 1);
    });

    it('R6-REG-03 act_fast select, check/uncheck, and upload (input + label filechooser) block onchange requestSubmit() under allowSubmit=false and restore form prototypes cleanly', async () => {
      await openRoute(
        '/r6-reg-03',
        `<form id="f" action="/submit" method="post">
          <select id="sel" onchange="this.form.requestSubmit()"><option value="">--</option><option value="x">X</option></select>
          <input id="chk" type="checkbox" onchange="this.form.requestSubmit()">
          <input id="fi" type="file" style="display:none" onchange="this.form.requestSubmit()">
          <label id="fiLbl" for="fi" style="display:inline-block;padding:6px">Choose file</label>
          <button id="subBtn" type="submit">Submit</button>
        </form>`
      );

      const rSel = await actFast(page, { action: 'select', selector: '#sel', value: 'x' });
      assert.equal(rSel.ok, true);
      assert.equal(await page.locator('#sel').inputValue(), 'x');

      const rChk = await actFast(page, { action: 'check', selector: '#chk' });
      assert.equal(rChk.ok, true);
      assert.equal(await page.locator('#chk').isChecked(), true);

      const rUnchk = await actFast(page, { action: 'uncheck', selector: '#chk' });
      assert.equal(rUnchk.ok, true);
      assert.equal(await page.locator('#chk').isChecked(), false);

      const rUpLbl = await actFast(page, { action: 'upload', selector: '#fiLbl', file: uploadFile1 });
      assert.equal(rUpLbl.ok, true);
      assert.equal(await countSubmits(), 0);

      const protoRestored = await page.evaluate(() => ({
        leaked: Boolean(window.__tbmCleanupActGuard),
        submitNative: HTMLFormElement.prototype.submit.toString().includes('native code'),
        reqSubmitNative: HTMLFormElement.prototype.requestSubmit.toString().includes('native code'),
      }));
      assert.deepEqual(protoRestored, { leaked: false, submitNative: true, reqSubmitNative: true });

      const rAllowed = await actFast(page, { action: 'click', selector: '#subBtn', allowSubmit: true });
      assert.equal(rAllowed.ok, true);
      assert.equal(await countSubmits(), 1);
    });

    it('R6-REG-04 inspect_compact and extract_clean_text scoped to open shadow hosts handle no-<slot> and nested-<slot> trees without duplicating slotted content', async () => {
      await openRoute(
        '/r6-reg-04',
        `<x-no-slot id="noSlot"><p>UNSLOTTED_LIGHT_NOISE</p></x-no-slot>
        <x-outer-card id="outerCard"><p>SLOTTED_BODY_ONCE</p></x-outer-card>
        <input aria-label="Outside input">
        <script>
          customElements.define('x-no-slot', class extends HTMLElement {
            constructor() {
              super();
              this.attachShadow({ mode: 'open' }).innerHTML = '<h2>SHADOW_HEAD</h2><p>SHADOW_PARA</p><input aria-label="Shadow email">';
            }
          });
          customElements.define('x-inner-card', class extends HTMLElement {
            constructor() {
              super();
              this.attachShadow({ mode: 'open' }).innerHTML = '<h3>INNER_TITLE</h3><slot></slot><footer>INNER_FOOTER</footer>';
            }
          });
          customElements.define('x-outer-card', class extends HTMLElement {
            constructor() {
              super();
              this.attachShadow({ mode: 'open' }).innerHTML = '<h2>OUTER_TITLE</h2><x-inner-card><slot></slot></x-inner-card>';
            }
          });
        </script>`
      );

      const snap = await inspectCompact(page, { selector: '#noSlot' });
      assert.match(snap.text, /Shadow email/);
      assert.doesNotMatch(snap.text, /Outside input/);

      for (const format of ['text', 'markdown']) {
        const noSlotOut = await extractCleanText(page, { selector: '#noSlot', format, includeFrames: false });
        assert.match(noSlotOut.text, /SHADOW_HEAD/);
        assert.match(noSlotOut.text, /SHADOW_PARA/);
        assert.doesNotMatch(noSlotOut.text, /UNSLOTTED_LIGHT_NOISE/);

        const nestedOut = await extractCleanText(page, { selector: '#outerCard', format, includeFrames: false });
        const matches = nestedOut.text.match(/SLOTTED_BODY_ONCE/g) || [];
        assert.equal(matches.length, 1, `Expected SLOTTED_BODY_ONCE exactly once in ${format}:\n${nestedOut.text}`);
        assert.ok(
          nestedOut.text.indexOf('OUTER_TITLE') < nestedOut.text.indexOf('INNER_TITLE') &&
            nestedOut.text.indexOf('INNER_TITLE') < nestedOut.text.indexOf('SLOTTED_BODY_ONCE') &&
            nestedOut.text.indexOf('SLOTTED_BODY_ONCE') < nestedOut.text.indexOf('INNER_FOOTER'),
          `Out-of-order shadow/slot extraction in ${format}:\n${nestedOut.text}`
        );
      }
    });

    it('R6-REG-05 smart_fill_form rejects invalid HTML5 date/time/month/week/datetime-local/number values without reporting filled, while filling valid ISO values', async () => {
      await openRoute(
        '/r6-reg-05',
        `<label>Bad Date <input id="bd" type="date"></label>
        <label>Bad Time <input id="bt" type="time"></label>
        <label>Bad Month <input id="bm" type="month"></label>
        <label>Bad Week <input id="bw" type="week"></label>
        <label>Bad DT <input id="bdt" type="datetime-local"></label>
        <label>Bad Num <input id="bn" type="number" value="10"></label>
        <label>Good Date <input id="gd" type="date"></label>
        <label>Good Time <input id="gt" type="time"></label>
        <label>Good Month <input id="gm" type="month"></label>
        <label>Good Week <input id="gw" type="week"></label>
        <label>Good DT <input id="gdt" type="datetime-local"></label>
        <label>Good Email <input id="ge" type="email"></label>`
      );

      const res = await smartFillForm(page, {
        overwrite: true,
        fields: [
          { keys: 'Bad Date', value: '12/25/2026' },
          { keys: 'Bad Time', value: '25:99' },
          { keys: 'Bad Month', value: '13/2026' },
          { keys: 'Bad Week', value: 'week-99' },
          { keys: 'Bad DT', value: '12/25/2026 3pm' },
          { keys: 'Bad Num', value: 'abc' },
          { keys: 'Good Date', value: '2026-12-31' },
          { keys: 'Good Time', value: '14:30' },
          { keys: 'Good Month', value: '2026-12' },
          { keys: 'Good Week', value: '2026-W50' },
          { keys: 'Good DT', value: '2026-12-25T14:30' },
          { keys: 'Good Email', value: 'alice@example.com' },
        ],
      });

      const badFilled = res.filled.filter((f) => f.idx < 6);
      assert.deepEqual(badFilled, [], `Browser-rejected HTML5 values reported as filled: ${JSON.stringify(res)}`);
      assert.equal(res.filledCount, 6, JSON.stringify(res));
      for (let idx = 0; idx < 6; idx++) {
        assert.ok(
          res.skipped.some((s) => s.idx === idx && s.reason === 'value-rejected-by-input'),
          `Expected value-rejected-by-input for idx=${idx}: ${JSON.stringify(res.skipped)}`
        );
      }
    });

    it('R6-REG-06 resolveChromiumExecutable sorts same-prefix revisions numerically (1200 > 999)', () => {
      const cache = fs.mkdtempSync(path.join(tmpDir, 'pw-reg06-'));
      const rel =
        process.platform === 'win32'
          ? ['chrome-headless-shell-win64', 'chrome-headless-shell.exe']
          : process.platform === 'darwin'
            ? ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell']
            : ['chrome-headless-shell-linux64', 'chrome-headless-shell'];
      for (const dir of ['chromium_headless_shell-999', 'chromium_headless_shell-1200', 'ffmpeg-1010']) {
        const p = path.join(cache, dir, ...rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, '');
      }
      const saved = {
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
        TURBO_BROWSER_EXECUTABLE: process.env.TURBO_BROWSER_EXECUTABLE,
      };
      let picked = '';
      try {
        process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
        delete process.env.TURBO_BROWSER_EXECUTABLE;
        picked = resolveChromiumExecutable({ executablePath: () => '' }, true).executablePath || '';
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
      assert.ok(
        picked.includes(`${path.sep}chromium_headless_shell-1200${path.sep}`),
        `Expected chromium_headless_shell-1200, got: ${picked}`
      );
    });
  });

  describe('Newly Uncovered Round-6 Defects in src/*.mjs (R6-BUG-01 .. R6-BUG-06)', () => {
    it('R6-BUG-01a slotted elements inside Web Component buttons without host type="submit" (<x-btn><span>Delete account</span></x-btn>) must be blocked via text, child selector, and {x,y}', async () => {
      await openRoute(
        '/r6-bug-01a',
        `<script>
          customElements.define('x-action-btn', class extends HTMLElement {
            constructor() {
              super();
              const r = this.attachShadow({ mode: 'open' });
              r.innerHTML = '<button part="base" style="padding:10px 22px"><slot></slot></button>';
              r.querySelector('button').addEventListener('click', () => {
                window.__clicks++;
                const f = this.closest('form');
                if (f) f.requestSubmit();
              });
            }
          });
        </script>
        <form action="/submit" method="post">
          <x-action-btn id="delBtn"><span id="delSpan">Delete account</span></x-action-btn>
        </form>`
      );

      const byText = await safe(actFast(page, { action: 'click', text: 'Delete account' }));
      const bySpan = await safe(actFast(page, { action: 'click', selector: '#delSpan' }));
      const box = await page.locator('#delBtn').boundingBox();
      const byXY = await safe(actFast(page, { action: 'click', x: box.x + box.width / 2, y: box.y + box.height / 2 }));

      assert.equal(
        await countClicks(),
        0,
        `Slotted <span> inside <x-action-btn> bypassed submit guard: byText=${JSON.stringify(byText)}, bySpan=${JSON.stringify(bySpan)}, byXY=${JSON.stringify(byXY)}`
      );
      assert.equal(await countSubmits(), 0);

      const allowed = await actFast(page, { action: 'click', text: 'Delete account', allowSubmit: true });
      assert.equal(allowed.ok, true);
      assert.equal(await countSubmits(), 1);
    });

    it('R6-BUG-01b Web Component button whose danger/submit label spans shadow text + <slot> (<button>Delete <slot></slot></button> + "account", or <button><slot></slot> and Pay</button> + "Save draft") must be blocked', async () => {
      await openRoute(
        '/r6-bug-01b',
        `<script>
          window.__prefClicks = 0;
          window.__compClicks = 0;
          customElements.define('x-prefix-btn', class extends HTMLElement {
            constructor() {
              super();
              const r = this.attachShadow({ mode: 'open' });
              r.innerHTML = '<button style="padding:8px 16px">Delete <slot></slot></button>';
              r.querySelector('button').addEventListener('click', () => { window.__prefClicks++; });
            }
          });
          customElements.define('x-compound-btn', class extends HTMLElement {
            constructor() {
              super();
              const r = this.attachShadow({ mode: 'open' });
              r.innerHTML = '<button style="padding:8px 16px"><slot></slot> and Pay</button>';
              r.querySelector('button').addEventListener('click', () => { window.__compClicks++; });
            }
          });
        </script>
        <x-prefix-btn id="prefBtn">account</x-prefix-btn>
        <x-compound-btn id="compBtn" type="submit">Save draft</x-compound-btn>`
      );

      const r1 = await safe(actFast(page, { action: 'click', selector: '#prefBtn' }));
      const r2 = await safe(actFast(page, { action: 'click', selector: '#compBtn' }));
      const counts = await page.evaluate(() => ({
        prefClicks: window.__prefClicks,
        compClicks: window.__compClicks,
      }));
      assert.deepEqual(
        counts,
        { prefClicks: 0, compClicks: 0 },
        `Split shadow+slot button labels bypassed submit guard: r1=${JSON.stringify(r1)}, r2=${JSON.stringify(r2)}`
      );

      const ok = await actFast(page, { action: 'click', selector: '#compBtn', allowSubmit: true });
      assert.equal(ok.ok, true);
      assert.equal(await page.evaluate(() => window.__compClicks), 1);
    });

    it('R6-BUG-01c native <button> containing a Shadow DOM label child (<button type="button"><x-lbl></x-lbl></button>) and <x-submit-wrap> wrapping inner <button type="submit">Go</button> must be blocked', async () => {
      await openRoute(
        '/r6-bug-01c',
        `<script>
          customElements.define('x-danger-lbl', class extends HTMLElement {
            constructor() {
              super();
              this.attachShadow({ mode: 'open' }).innerHTML = '<span>Delete account</span>';
            }
          });
          customElements.define('x-submit-wrap', class extends HTMLElement {
            constructor() {
              super();
              const r = this.attachShadow({ mode: 'open' });
              r.innerHTML = '<button type="submit" style="padding:8px 16px"><slot></slot></button>';
              r.querySelector('button').addEventListener('click', () => {
                const f = this.closest('form');
                if (f) f.requestSubmit();
              });
            }
          });
        </script>
        <button id="nativeWithShadowChild" type="button" onclick="window.__clicks++"><x-danger-lbl></x-danger-lbl></button>
        <form action="/submit" method="post">
          <x-submit-wrap id="subWrap">Go</x-submit-wrap>
        </form>`
      );

      const rClick = await safe(actFast(page, { action: 'click', selector: '#nativeWithShadowChild' }));
      const rEnter = await safe(actFast(page, { action: 'press', selector: '#nativeWithShadowChild', key: 'Enter' }));
      const rWrap = await safe(actFast(page, { action: 'click', selector: '#subWrap' }));

      const state = {
        clicks: await countClicks(),
        submits: await countSubmits(),
      };
      assert.deepEqual(
        state,
        { clicks: 0, submits: 0 },
        `Shadow label child / inner submit button bypassed allowSubmit=false: click=${JSON.stringify(rClick)}, enter=${JSON.stringify(rEnter)}, wrap=${JSON.stringify(rWrap)}`
      );
    });

    it('R6-BUG-02a press Enter on delegatesFocus shadow host with hidden preceding control or nested delegatesFocus host must block inner <form> submission', async () => {
      const body = `<script>
          customElements.define('x-df-hidden-first', class extends HTMLElement {
            constructor() {
              super();
              const r = this.attachShadow({ mode: 'open', delegatesFocus: true });
              r.innerHTML = '<form action="/submit" method="post"><button type="button" hidden>Cancel</button><input name="e" value="a@b.c"><button type="submit">Subscribe</button></form>';
              r.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); window.__submits++; });
            }
          });
          customElements.define('x-df-leaf', class extends HTMLElement {
            constructor() {
              super();
              const r = this.attachShadow({ mode: 'open', delegatesFocus: true });
              r.innerHTML = '<form action="/submit" method="post"><input name="e" value="a@b.c"><button type="submit">Subscribe</button></form>';
              r.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); window.__submits++; });
            }
          });
          customElements.define('x-df-nested', class extends HTMLElement {
            constructor() {
              super();
              const r = this.attachShadow({ mode: 'open', delegatesFocus: true });
              r.innerHTML = '<x-df-leaf style="display:block"></x-df-leaf>';
            }
          });
        </script>
        <x-df-hidden-first id="dfHiddenFirst" style="display:block;width:220px;height:36px"></x-df-hidden-first>
        <x-df-nested id="dfNested" style="display:block;width:220px;height:36px"></x-df-nested>`;

      await openRoute('/r6-bug-02a', body);
      const rHiddenFirst = await safe(actFast(page, { action: 'press', selector: '#dfHiddenFirst', key: 'Enter', timeoutMs: 2000 }));
      const hiddenFirstSubmits = await countSubmits();

      await openRoute('/r6-bug-02a');
      const rNested = await safe(actFast(page, { action: 'press', selector: '#dfNested', key: 'Enter', timeoutMs: 2000 }));
      const nestedSubmits = await countSubmits();

      assert.deepEqual(
        { hiddenFirstSubmits, nestedSubmits },
        { hiddenFirstSubmits: 0, nestedSubmits: 0 },
        `delegatesFocus Enter guard bypassed: hiddenFirst=${JSON.stringify(rHiddenFirst)}, nested=${JSON.stringify(rNested)}`
      );
    });

    it('R6-BUG-02b press Enter targeting a delegatesFocus shadow host whose shadow controls are all hidden preserves prior light-DOM form focus and must block submission', async () => {
      await openRoute(
        '/r6-bug-02b',
        `<script>
          customElements.define('x-df-unfocusable', class extends HTMLElement {
            constructor() {
              super();
              const r = this.attachShadow({ mode: 'open', delegatesFocus: true });
              r.innerHTML = '<input hidden value="x"><span>Static label</span>';
            }
          });
        </script>
        <form action="/submit" method="post">
          <input id="lightFocusedIn" name="q" value="ready">
          <button type="submit">Submit</button>
        </form>
        <x-df-unfocusable id="dfUnfocusable" style="display:block;width:140px;height:28px"></x-df-unfocusable>`
      );

      await page.focus('#lightFocusedIn');
      const rUnfocusable = await safe(actFast(page, { action: 'press', selector: '#dfUnfocusable', key: 'Enter', timeoutMs: 2000 }));
      assert.equal(
        await countSubmits(),
        0,
        `delegatesFocus host with only hidden inner input let focused light-DOM form submit: ${JSON.stringify(rUnfocusable)}`
      );
    });

    it('R6-BUG-02c press Space on a delegatesFocus shadow host whose first focusable control is <button type="submit">Go</button> must block submission', async () => {
      await openRoute(
        '/r6-bug-02c',
        `<script>
          customElements.define('x-df-space-sub', class extends HTMLElement {
            constructor() {
              super();
              const r = this.attachShadow({ mode: 'open', delegatesFocus: true });
              r.innerHTML = '<form action="/submit" method="post"><button type="submit">Go</button></form>';
              r.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); window.__submits++; });
            }
          });
        </script>
        <x-df-space-sub id="dfSpaceSub" style="display:block;width:140px;height:36px"></x-df-space-sub>`
      );

      const rSpace = await safe(actFast(page, { action: 'press', selector: '#dfSpaceSub', key: 'Space', timeoutMs: 2000 }));
      assert.equal(
        await countSubmits(),
        0,
        `Space on delegatesFocus host activated inner <button type="submit">Go</button>: ${JSON.stringify(rSpace)}`
      );
    });

    it('R6-BUG-03a non-composed native submit events inside open ShadowRoot <form> (via inner submit button click) must be blocked during act_fast select and smart_fill_form', async () => {
      const body = `<script>
          customElements.define('x-shadow-autosub', class extends HTMLElement {
            constructor() {
              super();
              const r = this.attachShadow({ mode: 'open' });
              r.innerHTML = '<form action="/submit" method="post"><select id="shSel"><option value="">--</option><option value="a">Alpha</option></select><button id="shSub" type="submit">Apply</button></form>';
              const f = r.querySelector('form');
              f.addEventListener('submit', (e) => { e.preventDefault(); window.__submits++; });
              r.querySelector('#shSel').addEventListener('change', () => r.querySelector('#shSub').click());
            }
          });
        </script>
        <x-shadow-autosub id="shAuto"></x-shadow-autosub>`;

      await openRoute('/r6-bug-03a', body);
      await actFast(page, { action: 'select', selector: '#shSel', value: 'a' });
      const actSelectSubmits = await countSubmits();

      await openRoute('/r6-bug-03a');
      await smartFillForm(page, { fields: [{ selector: '#shSel', value: 'Alpha' }] });
      const smartFillSubmits = await countSubmits();

      assert.deepEqual(
        { actSelectSubmits, smartFillSubmits },
        { actSelectSubmits: 0, smartFillSubmits: 0 },
        'Shadow <form> native submit event (composed=false) bypassed submit guard'
      );
    });

    it('R6-BUG-03b act_fast fill, clear, type, and drop block oninput/onchange/ondrop requestSubmit() under allowSubmit=false and permit under allowSubmit=true', async () => {
      await openRoute(
        '/r6-bug-03b',
        `<form action="/submit" method="post">
          <input id="otp" maxlength="6" oninput="if (this.value.length === 6) this.form.requestSubmit()">
          <input id="searchBox" value="old" oninput="if (this.value === '') this.form.requestSubmit()">
          <div id="dropZone" style="width:100px;height:40px;border:1px solid #000" ondrop="event.preventDefault(); this.closest('form').requestSubmit()">Drop</div>
          <button type="submit">Submit</button>
        </form>`
      );

      await actFast(page, { action: 'fill', selector: '#otp', value: '123456' });
      assert.equal(await page.locator('#otp').inputValue(), '123456');
      const fillSubmits = await countSubmits();

      await page.evaluate(() => { window.__submits = 0; });
      await actFast(page, { action: 'clear', selector: '#searchBox' });
      const clearSubmits = await countSubmits();

      await page.evaluate(() => {
        window.__submits = 0;
        document.getElementById('otp').value = '';
      });
      await actFast(page, { action: 'type', selector: '#otp', value: '654321' });
      const typeSubmits = await countSubmits();

      await page.evaluate(() => { window.__submits = 0; });
      await actFast(page, { action: 'drop', selector: '#dropZone', file: uploadFile1 });
      const dropSubmits = await countSubmits();

      await page.evaluate(() => { window.__submits = 0; });
      await actFast(page, { action: 'fill', selector: '#otp', value: '999999', allowSubmit: true });
      const allowedSubmits = await countSubmits();
      assert.equal(allowedSubmits, 1);

      assert.deepEqual(
        { fillSubmits, clearSubmits, typeSubmits, dropSubmits },
        { fillSubmits: 0, clearSubmits: 0, typeSubmits: 0, dropSubmits: 0 },
        'act_fast fill/clear/type/drop allowed auto-submit under allowSubmit=false'
      );
    });

    it('R6-BUG-04a inspect_compact({ selector }) targeting an interactive control itself returns that control instead of 0 elements', async () => {
      await openRoute('/r6-bug-04a', `<input id="selfTarget" aria-label="Primary email"><input aria-label="Other">`);
      const selfSnap = await inspectCompact(page, { selector: '#selfTarget' });
      assert.equal(selfSnap.totalInteractive, 1, `Selector targeting #selfTarget itself returned 0 items:\n${selfSnap.text}`);
      assert.match(selfSnap.text, /Primary email/);
    });

    it('R6-BUG-04b inspect_compact and smart_fill_form compose <slot> assignedNodes() and child ShadowRoot text for Web Component buttons, inputs, and checkboxes', async () => {
      await openRoute(
        '/r6-bug-04b',
        `<script>
          customElements.define('x-lbl-chip', class extends HTMLElement {
            constructor() {
              super();
              this.attachShadow({ mode: 'open' }).innerHTML = '<span>Delete account</span>';
            }
          });
          customElements.define('x-wc-btn', class extends HTMLElement {
            constructor() {
              super();
              this.attachShadow({ mode: 'open' }).innerHTML = '<button style="padding:6px 12px"><slot></slot></button>';
            }
          });
          customElements.define('x-wc-input', class extends HTMLElement {
            constructor() {
              super();
              this.attachShadow({ mode: 'open' }).innerHTML = '<label for="in"><slot></slot></label><input id="in">';
            }
          });
          customElements.define('x-wc-check', class extends HTMLElement {
            constructor() {
              super();
              this.attachShadow({ mode: 'open' }).innerHTML = '<label><input id="cb" type="checkbox"><slot></slot></label>';
            }
          });
        </script>
        <button id="btnWithWcLabel" type="button"><x-lbl-chip></x-lbl-chip></button>
        <x-wc-btn id="wcBtn">Submit order</x-wc-btn>
        <x-wc-input id="wcIn">Work Email</x-wc-input>
        <x-wc-check id="wcChk">Accept terms</x-wc-check>`
      );

      const fullSnap = await inspectCompact(page, {});
      const fillWc = await smartFillForm(page, {
        fields: [
          { keys: 'Work Email', value: 'eng@company.io' },
          { keys: 'Accept terms', value: true },
        ],
      });
      const wcState = await page.evaluate(() => ({
        inVal: document.getElementById('wcIn').shadowRoot.getElementById('in').value,
        cbChecked: document.getElementById('wcChk').shadowRoot.getElementById('cb').checked,
      }));

      assert.deepEqual(
        {
          hasChildShadowLabel: /"Delete account"/.test(fullSnap.text),
          hasSlottedBtnLabel: /"Submit order"/.test(fullSnap.text),
          hasSlottedInputLabel: /"Work Email"/.test(fullSnap.text),
          hasSlottedCheckLabel: /"Accept terms"/.test(fullSnap.text),
          filledCount: fillWc.filledCount,
          wcState,
        },
        {
          hasChildShadowLabel: true,
          hasSlottedBtnLabel: true,
          hasSlottedInputLabel: true,
          hasSlottedCheckLabel: true,
          filledCount: 2,
          wcState: { inVal: 'eng@company.io', cbChecked: true },
        },
        `Missing <slot>/Shadow labels in inspect_compact / smart_fill_form:\n${fullSnap.text}\nfillWc=${JSON.stringify(fillWc)}`
      );
    });

    it('R6-BUG-04c smart_fill_form cleans up data-tbm-file-claimed inside Shadow DOM (allowing repeated uploads) and respects <slot> flat-tree order', async () => {
      await openRoute(
        '/r6-bug-04c',
        `<script>
          customElements.define('x-wc-upload', class extends HTMLElement {
            constructor() {
              super();
              this.attachShadow({ mode: 'open' }).innerHTML = '<label>Resume <input id="shFile" type="file"></label>';
            }
          });
          customElements.define('x-slot-order', class extends HTMLElement {
            constructor() {
              super();
              this.attachShadow({ mode: 'open' }).innerHTML = '<slot></slot><input class="ord" id="shadowSecond" aria-label="Shadow second">';
            }
          });
        </script>
        <x-wc-upload id="wcUp"></x-wc-upload>
        <x-slot-order id="slotOrd"><input class="ord" id="slottedFirst" aria-label="Slotted first"></x-slot-order>`
      );

      const up1 = await smartFillForm(page, { fields: [{ keys: 'Resume', file: uploadFile1 }] });
      assert.equal(up1.filledCount, 1, JSON.stringify(up1));
      const up2 = await smartFillForm(page, { fields: [{ keys: 'Resume', file: uploadFile2 }] });
      const uploadedName = await page.evaluate(
        () => document.getElementById('wcUp').shadowRoot.getElementById('shFile').files[0]?.name || ''
      );

      await smartFillForm(page, { fields: [{ selector: '#slotOrd input.ord', value: 'FIRST' }] });
      const orderState = await page.evaluate(() => ({
        slottedFirst: document.getElementById('slottedFirst').value,
        shadowSecond: document.getElementById('slotOrd').shadowRoot.getElementById('shadowSecond').value,
      }));

      assert.deepEqual(
        {
          secondUploadFilled: up2.filledCount,
          uploadedName,
          orderState,
        },
        {
          secondUploadFilled: 1,
          uploadedName: 'doc-v2.txt',
          orderState: { slottedFirst: 'FIRST', shadowSecond: '' },
        },
        `Shadow file cleanup / <slot> order defect: up2=${JSON.stringify(up2)}, order=${JSON.stringify(orderState)}`
      );
    });

    it('R6-BUG-05a smart_fill_form({ overwrite: true }) does not falsely report filled when a controlled input rejects the new value and snaps back to its previous value', async () => {
      await openRoute(
        '/r6-bug-05a',
        `<label>Digits Only <input id="digitsOnly" value="10"></label>
        <label>Accepted Digits <input id="okDigits" value="10"></label>
        <script>
          for (const id of ['digitsOnly', 'okDigits']) {
            const el = document.getElementById(id);
            let controlledVal = '10';
            el.addEventListener('input', () => {
              if (/^\\d+$/.test(el.value)) controlledVal = el.value;
              el.value = controlledVal;
            });
          }
        </script>`
      );

      const res = await smartFillForm(page, {
        overwrite: true,
        fields: [
          { keys: 'Digits Only', value: 'abc' },
          { keys: 'Accepted Digits', value: '42' },
        ],
      });

      const vals = await page.evaluate(() => ({
        rejected: document.getElementById('digitsOnly').value,
        accepted: document.getElementById('okDigits').value,
      }));
      assert.deepEqual(vals, { rejected: '10', accepted: '42' });
      assert.deepEqual(
        res.filled.map((f) => f.idx),
        [1],
        `Controlled input rejecting "abc" (staying "10") was falsely reported in filled: ${JSON.stringify(res)}`
      );
    });

    it('R6-BUG-05b smart_fill_form rejects invalid type="color" / type="range" values with value-rejected-by-input instead of clobbering existing values and reporting filled', async () => {
      await openRoute(
        '/r6-bug-05b',
        `<label>Brand Color <input id="brandColor" type="color" value="#112233"></label>
        <label>Volume <input id="volRange" type="range" min="0" max="100" value="20"></label>
        <label>Valid Color <input id="okColor" type="color" value="#112233"></label>
        <label>Valid Range <input id="okRange" type="range" min="0" max="100" value="20"></label>`
      );

      const res = await smartFillForm(page, {
        overwrite: true,
        fields: [
          { keys: 'Brand Color', value: 'not-a-color' },
          { keys: 'Volume', value: 'abc' },
          { keys: 'Valid Color', value: '#FF00AA' },
          { keys: 'Valid Range', value: 75 },
        ],
      });

      const domVals = await page.evaluate(() => ({
        brandColor: document.getElementById('brandColor').value,
        volRange: document.getElementById('volRange').value,
        okColor: document.getElementById('okColor').value,
        okRange: document.getElementById('okRange').value,
      }));

      assert.deepEqual(
        {
          domVals,
          filledIdxs: res.filled.map((f) => f.idx),
          rejectedIdxs: res.skipped.filter((s) => s.reason === 'value-rejected-by-input').map((s) => s.idx),
        },
        {
          domVals: { brandColor: '#112233', volRange: '20', okColor: '#ff00aa', okRange: '75' },
          filledIdxs: [2, 3],
          rejectedIdxs: [0, 1],
        },
        `Invalid color/range values clobbered DOM and reported filled: ${JSON.stringify(res)}`
      );
    });

    it('R6-BUG-06 resolveChromiumExecutable picks newer revision across mixed chromium_headless_shell-* and chromium-* cache directories when headless=true, breaking ties in favor of headless_shell', () => {
      const cacheMixed = fs.mkdtempSync(path.join(tmpDir, 'pw-mixed-'));
      const relHeadless =
        process.platform === 'win32'
          ? ['chrome-headless-shell-win64', 'chrome-headless-shell.exe']
          : process.platform === 'darwin'
            ? ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell']
            : ['chrome-headless-shell-linux64', 'chrome-headless-shell'];
      const relFull =
        process.platform === 'win32'
          ? ['chrome-win64', 'chrome.exe']
          : process.platform === 'darwin'
            ? ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']
            : ['chrome-linux', 'chrome'];

      const hsOld = path.join(cacheMixed, 'chromium_headless_shell-999', ...relHeadless);
      const fullNew = path.join(cacheMixed, 'chromium-1200', ...relFull);
      fs.mkdirSync(path.dirname(hsOld), { recursive: true });
      fs.writeFileSync(hsOld, '');
      fs.mkdirSync(path.dirname(fullNew), { recursive: true });
      fs.writeFileSync(fullNew, '');

      const cacheTie = fs.mkdtempSync(path.join(tmpDir, 'pw-tie-'));
      const hsTie = path.join(cacheTie, 'chromium_headless_shell-1200', ...relHeadless);
      const fullTie = path.join(cacheTie, 'chromium-1200', ...relFull);
      fs.mkdirSync(path.dirname(hsTie), { recursive: true });
      fs.writeFileSync(hsTie, '');
      fs.mkdirSync(path.dirname(fullTie), { recursive: true });
      fs.writeFileSync(fullTie, '');

      const saved = {
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
        TURBO_BROWSER_EXECUTABLE: process.env.TURBO_BROWSER_EXECUTABLE,
      };
      try {
        delete process.env.TURBO_BROWSER_EXECUTABLE;

        process.env.PLAYWRIGHT_BROWSERS_PATH = cacheMixed;
        const pickedMixed = resolveChromiumExecutable({ executablePath: () => '' }, true).executablePath || '';
        assert.ok(
          pickedMixed.includes(`${path.sep}chromium-1200${path.sep}`),
          `Picked stale chromium_headless_shell-999 over newer chromium-1200: ${pickedMixed}`
        );

        process.env.PLAYWRIGHT_BROWSERS_PATH = cacheTie;
        const pickedTieHeadless = resolveChromiumExecutable({ executablePath: () => '' }, true).executablePath || '';
        assert.ok(
          pickedTieHeadless.includes(`${path.sep}chromium_headless_shell-1200${path.sep}`),
          `Expected chromium_headless_shell-1200 tie-break when headless=true, got: ${pickedTieHeadless}`
        );
        const pickedTieHeaded = resolveChromiumExecutable({ executablePath: () => '' }, false).executablePath || '';
        assert.ok(
          pickedTieHeaded.includes(`${path.sep}chromium-1200${path.sep}`),
          `Expected chromium-1200 when headless=false, got: ${pickedTieHeaded}`
        );
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });

    it('R6-BUG-07a (#141 regression) non-submit Web Components inside <form> (host type="button", type="reset", untyped accordion, and shadow <input> Enter) must NOT be falsely blocked as type="submit" or listed in submitButtons', async () => {
      await openRoute(
        '/r6-bug-07a',
        `<script>
          window.__toggles = 0;
          window.__resets = 0;
          window.__acc = 0;
          customElements.define('x-safe-wc-btn', class extends HTMLElement {
            constructor() {
              super();
              const r = this.attachShadow({ mode: 'open' });
              r.innerHTML = '<button part="base" style="padding:8px 14px"><slot></slot></button>';
              r.querySelector('button').addEventListener('click', () => {
                const t = (this.getAttribute('type') || '').toLowerCase();
                if (t === 'button') window.__toggles++;
                if (t === 'reset') {
                  window.__resets++;
                  const f = this.closest('form');
                  if (f) f.reset();
                }
              });
            }
          });
          customElements.define('x-wc-accordion', class extends HTMLElement {
            constructor() {
              super();
              const r = this.attachShadow({ mode: 'open' });
              r.innerHTML = '<button aria-expanded="false" style="padding:8px 14px"><slot></slot></button>';
              r.querySelector('button').addEventListener('click', () => { window.__acc++; });
            }
          });
          customElements.define('x-wc-filter-input', class extends HTMLElement {
            constructor() {
              super();
              const r = this.attachShadow({ mode: 'open' });
              r.innerHTML = '<input id="shFilter" aria-label="Shadow filter" value="abc">';
              r.getElementById('shFilter').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') window.__filterEnter = true;
              });
            }
          });
        </script>
        <form action="/submit" method="post">
          <input id="pw" name="pw" value="initial">
          <x-safe-wc-btn id="togglePw" type="button" style="display:inline-block"><span>Toggle password</span></x-safe-wc-btn>
          <x-safe-wc-btn id="wipeForm" type="reset" style="display:inline-block"><span>Wipe fields</span></x-safe-wc-btn>
          <x-wc-accordion id="advAcc" style="display:inline-block"><span>Show advanced options</span></x-wc-accordion>
          <x-wc-filter-input id="filterHost" style="display:inline-block"></x-wc-filter-input>
          <button id="realSub" type="submit">Submit</button>
        </form>`
      );

      const snap = await inspectCompact(page, {});
      const findRef = (lbl) => {
        const line = snap.text.split('\n').find((l) => l.includes(`"${lbl}"`));
        const m = /^\[(f\d+:e\d+)\]/.exec(line || '');
        return m ? m[1] : null;
      };

      const toggleRef = findRef('Toggle password');
      const wipeRef = findRef('Wipe fields');
      const accRef = findRef('Show advanced options');
      const filterRef = findRef('Shadow filter');

      const rToggleRef = await actFast(page, { action: 'click', ref: toggleRef });
      const rToggleTxt = await actFast(page, { action: 'click', text: 'Toggle password' });
      const bToggle = await page.locator('#togglePw').boundingBox();
      const rToggleXY = await actFast(page, { action: 'click', x: bToggle.x + bToggle.width / 2, y: bToggle.y + bToggle.height / 2 });
      const rToggleEnter = await actFast(page, { action: 'press', ref: toggleRef, key: 'Enter' });

      await actFast(page, { action: 'fill', selector: '#pw', value: 'changed' });
      const rWipeRef = await actFast(page, { action: 'click', ref: wipeRef });

      const rAccSel = await actFast(page, { action: 'click', selector: '#advAcc' });
      const rAccRef = await actFast(page, { action: 'click', ref: accRef });

      const rFilterEnter = await actFast(page, { action: 'press', ref: filterRef, key: 'Enter' });

      const sf = await smartFillForm(page, {
        overwrite: true,
        fields: [{ selector: '#pw', value: 'updated' }],
      });

      const pageCounts = await page.evaluate(() => ({
        toggles: window.__toggles,
        resets: window.__resets,
        acc: window.__acc,
        filterEnter: Boolean(window.__filterEnter),
        submits: window.__submits || 0,
      }));

      assert.deepEqual(
        {
          rToggleRefOk: rToggleRef.ok,
          rToggleTxtOk: rToggleTxt.ok,
          rToggleXYOk: rToggleXY.ok,
          rToggleEnterOk: rToggleEnter.ok,
          rWipeRefOk: rWipeRef.ok,
          rAccSelOk: rAccSel.ok,
          rAccRefOk: rAccRef.ok,
          rFilterEnterOk: rFilterEnter.ok,
          submitButtonTexts: sf.submitButtons.map((b) => b.text),
          pageCounts,
        },
        {
          rToggleRefOk: true,
          rToggleTxtOk: true,
          rToggleXYOk: true,
          rToggleEnterOk: true,
          rWipeRefOk: true,
          rAccSelOk: true,
          rAccRefOk: true,
          rFilterEnterOk: true,
          submitButtonTexts: ['Submit'],
          pageCounts: { toggles: 4, resets: 1, acc: 2, filterEnter: true, submits: 0 },
        },
        `Safe Web Components inside <form> falsely treated as submit: toggleRef=${JSON.stringify(rToggleRef)}, wipeRef=${JSON.stringify(rWipeRef)}, accSel=${JSON.stringify(rAccSel)}, filterEnter=${JSON.stringify(rFilterEnter)}, sfSubmits=${JSON.stringify(sf.submitButtons)}`
      );
    });

    it('R6-BUG-07b multi-level nested Web Components inherit explicit type="submit" across >=2 shadow host boundaries and deep shadow <button type="submit">', async () => {
      await openRoute(
        '/r6-bug-07b',
        `<script>
          window.__outerTypeSubmits = 0;
          window.__deepBtnSubmits = 0;
          customElements.define('x-leaf-btn', class extends HTMLElement {
            constructor() {
              super();
              const r = this.attachShadow({ mode: 'open' });
              r.innerHTML = '<button part="base" style="padding:8px 14px"><slot></slot></button>';
              r.querySelector('button').addEventListener('click', () => {
                let cur = this;
                while (cur) {
                  if ((cur.getAttribute?.('type') || '').toLowerCase() === 'submit') {
                    window.__outerTypeSubmits++;
                    break;
                  }
                  cur = cur.getRootNode?.()?.host || null;
                }
              });
            }
          });
          customElements.define('x-outer-submit-host', class extends HTMLElement {
            constructor() {
              super();
              this.attachShadow({ mode: 'open' }).innerHTML = '<x-leaf-btn><slot></slot></x-leaf-btn>';
            }
          });
          customElements.define('x-deep-submit-leaf', class extends HTMLElement {
            constructor() {
              super();
              const r = this.attachShadow({ mode: 'open' });
              r.innerHTML = '<button type="submit" style="padding:8px 14px"><slot></slot></button>';
              r.querySelector('button').addEventListener('click', () => { window.__deepBtnSubmits++; });
            }
          });
          customElements.define('x-deep-submit-outer', class extends HTMLElement {
            constructor() {
              super();
              const r = this.attachShadow({ mode: 'open' });
              r.innerHTML = '<x-deep-submit-leaf><slot></slot></x-deep-submit-leaf>';
              this.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  r.querySelector('x-deep-submit-leaf').shadowRoot.querySelector('button').click();
                }
              });
            }
          });
        </script>
        <x-outer-submit-host id="outerHostSub" type="submit" style="display:inline-block"><span id="goSpan1">Go</span></x-outer-submit-host>
        <x-deep-submit-outer id="deepBtnSub" tabindex="0" style="display:inline-block"><span id="goSpan2">Run</span></x-deep-submit-outer>`
      );

      const r1Span = await safe(actFast(page, { action: 'click', selector: '#goSpan1' }));
      const b1 = await page.locator('#outerHostSub').boundingBox();
      const r1XY = await safe(actFast(page, { action: 'click', x: b1.x + b1.width / 2, y: b1.y + b1.height / 2 }));
      const r2Host = await safe(actFast(page, { action: 'click', selector: '#deepBtnSub' }));
      const r2Enter = await safe(actFast(page, { action: 'press', selector: '#deepBtnSub', key: 'Enter' }));
      const r2Space = await safe(actFast(page, { action: 'press', selector: '#deepBtnSub', key: 'Space' }));

      const counts = await page.evaluate(() => ({
        outerTypeSubmits: window.__outerTypeSubmits,
        deepBtnSubmits: window.__deepBtnSubmits,
      }));
      assert.deepEqual(
        counts,
        { outerTypeSubmits: 0, deepBtnSubmits: 0 },
        `2-level nested Web Component submit buttons bypassed guard: r1Span=${JSON.stringify(r1Span)}, r1XY=${JSON.stringify(r1XY)}, r2Host=${JSON.stringify(r2Host)}, r2Enter=${JSON.stringify(r2Enter)}, r2Space=${JSON.stringify(r2Space)}`
      );
    });

    it('R6-BUG-08a smart_fill_form Pass 1.5 (role="combobox") and Pass 2 (input[type="file"]) match slotted <slot>/Shadow labels and aria-labelledby', async () => {
      await openRoute(
        '/r6-bug-08a',
        `<script>
          customElements.define('x-slotted-upload', class extends HTMLElement {
            constructor() {
              super();
              this.attachShadow({ mode: 'open' }).innerHTML = '<label><slot></slot><input id="u1" type="file"></label>';
            }
          });
          customElements.define('x-slotted-combo', class extends HTMLElement {
            constructor() {
              super();
              const r = this.attachShadow({ mode: 'open' });
              r.innerHTML = '<label><slot></slot><div id="cb" role="combobox" tabindex="0" style="padding:6px;border:1px solid #333">Choose...</div></label><div id="lb" role="listbox" hidden><div role="option">Vietnam</div><div role="option">Japan</div></div>';
              r.getElementById('cb').addEventListener('click', () => { r.getElementById('lb').hidden = false; });
              r.querySelectorAll('[role="option"]').forEach((opt) => {
                opt.addEventListener('click', () => {
                  r.getElementById('cb').textContent = opt.textContent;
                  r.getElementById('lb').hidden = true;
                });
              });
            }
          });
        </script>
        <x-slotted-upload id="su">Resume PDF</x-slotted-upload>
        <span id="covLbl">Cover Letter</span><input id="covIn" type="file" aria-labelledby="covLbl">
        <x-slotted-combo id="sc">Country</x-slotted-combo>`
      );

      const res = await smartFillForm(page, {
        fields: [
          { keys: 'Resume PDF', file: uploadFile1 },
          { keys: 'Cover Letter', file: uploadFile2 },
          { keys: 'Country', value: 'Vietnam' },
        ],
      });

      const state = await page.evaluate(() => ({
        resumeFile: document.getElementById('su').shadowRoot.getElementById('u1').files[0]?.name || '',
        coverFile: document.getElementById('covIn').files[0]?.name || '',
        countryText: document.getElementById('sc').shadowRoot.getElementById('cb').textContent,
      }));

      assert.deepEqual(
        { filledCount: res.filledCount, state },
        {
          filledCount: 3,
          state: { resumeFile: 'doc-v1.txt', coverFile: 'doc-v2.txt', countryText: 'Vietnam' },
        },
        `smart_fill_form failed on slotted upload / aria-labelledby upload / slotted combobox: ${JSON.stringify(res)}`
      );
    });

    it('R6-BUG-08b smart_fill_form clickWidgetSafely blocks non-composed ShadowRoot <form> submit when portaled [role="option"] clicks inner submit button', async () => {
      await openRoute(
        '/r6-bug-08b',
        `<script>
          customElements.define('x-combo-portal', class extends HTMLElement {
            constructor() {
              super();
              const r = this.attachShadow({ mode: 'open' });
              r.innerHTML = '<form id="f" action="/submit" method="post"><div id="cb" role="combobox" aria-label="Role" tabindex="0" style="padding:6px;border:1px solid #333">Choose...</div><button id="shSub" type="submit">Save</button></form><div id="lb" role="listbox"><div role="option">Admin</div></div>';
              r.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); window.__submits++; });
              r.querySelector('[role="option"]').addEventListener('click', () => {
                r.getElementById('cb').textContent = 'Admin';
                r.getElementById('shSub').click();
              });
            }
          });
        </script>
        <x-combo-portal id="cp"></x-combo-portal>`
      );

      const res = await smartFillForm(page, { fields: [{ keys: 'Role', value: 'Admin' }] });
      assert.equal(res.filledCount, 1);
      assert.equal(
        await countSubmits(),
        0,
        'Portaled shadow [role="option"] bypassed clickWidgetSafely and submitted shadow <form>'
      );
    });

    it('R6-BUG-09 inspect_compact({ mode: "article" }) extracts composed <slot> and nested Shadow DOM text for headings, paragraphs, and list items', async () => {
      await openRoute(
        '/r6-bug-09',
        `<script>
          customElements.define('x-article-card', class extends HTMLElement {
            constructor() {
              super();
              this.attachShadow({ mode: 'open' }).innerHTML = '<h2><slot name="title"></slot></h2><p><slot></slot></p>';
            }
          });
        </script>
        <x-article-card><span slot="title">Quarterly Revenue</span><span>Up 42 percent year over year</span></x-article-card>`
      );

      const snap = await inspectCompact(page, { mode: 'article' });
      assert.equal(snap.totalInteractive, 2, `Expected 2 article items (h2 + p), got:\n${snap.text}`);
      assert.match(snap.text, /Quarterly Revenue/);
      assert.match(snap.text, /Up 42 percent year over year/);
    });

    it('R6-BUG-10a act_fast press Enter under allowSubmit=false blocks form-associated Web Component inputs, JS Enter-submitting inputs, and chat <textarea> composers (including untargeted iframe press)', async () => {
      await openRoute(
        '/r6-bug-10a-child',
        `<form id="cf" action="/submit" method="post">
          <textarea id="iframeChat" onkeydown="if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); this.form.requestSubmit(); }">hello</textarea>
          <button type="submit">Send</button>
        </form>
        <script>
          document.getElementById('cf').addEventListener('submit', (e) => {
            e.preventDefault();
            window.parent.__submits = (window.parent.__submits || 0) + 1;
          });
        </script>`
      );
      await openRoute(
        '/r6-bug-10a',
        `<script>
          customElements.define('x-face-input', class extends HTMLElement {
            static formAssociated = true;
            constructor() {
              super();
              this._internals = this.attachInternals();
              const r = this.attachShadow({ mode: 'open', delegatesFocus: true });
              r.innerHTML = '<input id="in" value="abc">';
              r.querySelector('input').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                  (this._internals.form || this.closest('form'))?.requestSubmit();
                }
              });
            }
          });
          customElements.define('x-js-input', class extends HTMLElement {
            constructor() {
              super();
              const r = this.attachShadow({ mode: 'open', delegatesFocus: true });
              r.innerHTML = '<input id="in2" value="xyz">';
              r.querySelector('input').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this.closest('form')?.requestSubmit();
              });
            }
          });
        </script>
        <form id="f1" action="/submit" method="post">
          <x-face-input id="faceIn"></x-face-input>
          <x-js-input id="jsIn"></x-js-input>
          <textarea id="chatBox" onkeydown="if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); this.form.requestSubmit(); }">draft</textarea>
          <button type="submit">Submit order</button>
        </form>
        <iframe id="chatFrame" src="/r6-bug-10a-child" style="width:320px;height:120px"></iframe>`
      );

      const rFace = await safe(actFast(page, { action: 'press', selector: '#faceIn', key: 'Enter' }));
      const rJs = await safe(actFast(page, { action: 'press', selector: '#jsIn', key: 'Enter' }));
      const rChat = await safe(actFast(page, { action: 'press', selector: '#chatBox', key: 'Enter' }));

      const childFrame = page.frames().find((f) => f.url().includes('/r6-bug-10a-child'));
      await childFrame.locator('#iframeChat').focus();
      const rUntargetedIframe = await safe(actFast(page, { action: 'press', key: 'Enter' }));

      assert.equal(
        await countSubmits(),
        0,
        `allowSubmit=false leaked form submit on press Enter: face=${JSON.stringify(rFace)}, js=${JSON.stringify(rJs)}, chat=${JSON.stringify(rChat)}, iframe=${JSON.stringify(rUntargetedIframe)}`
      );
      assert.equal(rFace.blocked, true, `Form-associated custom input inside <form> should report blocked=true on Enter, got: ${JSON.stringify(rFace)}`);
    });

    it('R6-BUG-10b act_fast click/coordinate-click/upload and smart_fill_form upload block onchange/onclick auto-submit while preserving explicit safe Search submit', async () => {
      await openRoute(
        '/r6-bug-10b',
        `<form id="fDanger" action="/submit" method="post">
          <label id="radLbl" style="display:inline-block;padding:6px"><input id="radPro" type="radio" name="plan" value="pro" onchange="this.form.requestSubmit()"> Pro plan</label>
          <label id="chkLbl" style="display:inline-block;padding:6px"><input id="chkAuto" type="checkbox" name="auto" onchange="this.form.requestSubmit()"> Auto renew</label>
          <button id="finishBtn" type="button" onclick="this.form.requestSubmit()">Finish</button>
          <button id="badChooserBtn" type="button" onclick="this.form.requestSubmit()">Choose file</button>
          <button type="submit">Place order</button>
        </form>
        <form id="fSafeSearch" action="/submit" method="post" onsubmit="event.preventDefault(); window.__safeSearchSubmits = (window.__safeSearchSubmits || 0) + 1;">
          <input id="sq" name="sq" value="shoes">
          <button id="safeSearchBtn" type="submit">Search</button>
        </form>`
      );

      const rRad = await safe(actFast(page, { action: 'click', selector: '#radPro' }));
      const chkBox = await page.locator('#chkLbl').boundingBox();
      const rChkXY = await safe(actFast(page, { action: 'click', x: chkBox.x + chkBox.width / 2, y: chkBox.y + chkBox.height / 2 }));
      const rFin = await safe(actFast(page, { action: 'click', selector: '#finishBtn' }));
      const rUpAct = await safe(actFast(page, { action: 'upload', selector: '#badChooserBtn', file: uploadFile1, timeoutMs: 400 }));
      const rUpSf = await safe(smartFillForm(page, { fields: [{ selector: '#badChooserBtn', file: uploadFile1 }] }));

      assert.equal(
        await countSubmits(),
        0,
        `allowSubmit=false leaked onchange/onclick auto-submit: rad=${JSON.stringify(rRad)}, chkXY=${JSON.stringify(rChkXY)}, fin=${JSON.stringify(rFin)}, upAct=${JSON.stringify(rUpAct)}, upSf=${JSON.stringify(rUpSf)}`
      );

      const state = await page.evaluate(() => ({
        radChecked: document.getElementById('radPro').checked,
        chkChecked: document.getElementById('chkAuto').checked,
      }));
      assert.deepEqual(state, { radChecked: true, chkChecked: true }, 'Radio and checkbox clicks must still toggle state');

      const rSafeSearch = await actFast(page, { action: 'click', selector: '#safeSearchBtn', allowSubmit: false });
      assert.equal(rSafeSearch.ok, true);
      const safeSearchSubmits = await page.evaluate(() => window.__safeSearchSubmits || 0);
      assert.equal(safeSearchSubmits, 1, 'Explicit safe Search submit button must still be allowed to submit its search form');
    });

    it('R6-BUG-11 non-button controls (radio/checkbox/textarea/text-input) whose labels start with Next/Continue/Search must NOT receive isSafeSubmit=true bypass', async () => {
      await openRoute(
        '/r6-bug-11',
        `<form id="fCheckout" action="/submit" method="post">
          <label id="shipNextLbl" style="display:inline-block;padding:6px"><input id="shipNext" type="radio" name="ship" value="next" onchange="this.form.requestSubmit()"> Next day delivery</label>
          <label id="chkSaveLbl" style="display:inline-block;padding:6px"><input id="chkSave" type="checkbox" name="autosave" onchange="this.form.requestSubmit()"> Save draft automatically</label>
          <textarea id="taContinue" aria-label="Continue message" onkeydown="if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); this.form.requestSubmit(); }">hello</textarea>
          <button type="submit">Place order</button>
        </form>`
      );

      const rRadio = await safe(actFast(page, { action: 'click', selector: '#shipNext' }));
      const chkBox = await page.locator('#chkSaveLbl').boundingBox();
      const rChkXY = await safe(actFast(page, { action: 'click', x: chkBox.x + chkBox.width / 2, y: chkBox.y + chkBox.height / 2 }));
      const rTaEnter = await safe(actFast(page, { action: 'press', selector: '#taContinue', key: 'Enter' }));

      assert.equal(
        await countSubmits(),
        0,
        `Non-button control with Next/Save draft/Continue label bypassed withActionSubmitGuard: radio=${JSON.stringify(rRadio)}, chkXY=${JSON.stringify(rChkXY)}, ta=${JSON.stringify(rTaEnter)}`
      );
      const state = await page.evaluate(() => ({
        shipChecked: document.getElementById('shipNext').checked,
        saveChecked: document.getElementById('chkSave').checked,
      }));
      assert.deepEqual(state, { shipChecked: true, saveChecked: true });
    });
  });
});
