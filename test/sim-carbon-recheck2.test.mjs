// sim-carbon-recheck2: Round-4 Deep Auditor adversarial & regression suite (gemini-auditor-3).
// Strictly honors documented tool contracts and asserts real side effects (HTTP server submission
// counters, DOM state, listbox option clicks, visibility states, extracted text, and JSON-RPC framing).
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

const htmlPage = (body, title = 'round4-recheck') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const postSubmit = (key) => `fetch('/submit?k=${encodeURIComponent(key)}', { method: 'POST' })`;

function startRound4Server() {
  const hits = new Map();
  const routes = new Map();

  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    if (u.pathname === '/submit') {
      const k = u.searchParams.get('k') || 'default';
      req.resume();
      req.on('end', () => {
        hits.set(k, (hits.get(k) || 0) + 1);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(htmlPage('<h1>Submitted</h1>'));
      });
      return;
    }
    if (u.pathname === '/api/ping') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const handler = routes.get(u.pathname);
    if (handler) {
      handler(req, res, u);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        getHits(key) {
          return hits.get(key) || 0;
        },
        resetHits() {
          hits.clear();
        },
        setPage(pathname, bodyHtml, title) {
          routes.set(pathname, (_req, res) => {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(htmlPage(bodyHtml, title));
          });
        },
      });
    });
  });
}

describe('sim-carbon-recheck2: Round-4 deep adversarial & regression suite', { concurrency: 1 }, () => {
  let fx;
  let manager;
  let page;
  let tabId;
  let tmpDir;
  let sampleFile;
  let savedSaveRoot;

  const waitHits = async (key, waitMs = 200) => {
    await page.waitForTimeout(waitMs);
    return fx.getHits(key);
  };

  before(async () => {
    delete process.env.TURBO_BROWSER_ALLOW_SUBMIT;
    savedSaveRoot = process.env.TURBO_BROWSER_SAVE_ROOT;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-r4-recheck-'));
    sampleFile = path.join(tmpDir, 'resume-r4.txt');
    fs.writeFileSync(sampleFile, 'round4 sample attachment\n', 'utf8');
    process.env.TURBO_BROWSER_SAVE_ROOT = [process.cwd(), tmpDir].join(path.delimiter);

    fx = await startRound4Server();
    fx.setPage('/blank', '<p>ready</p>');
    fx.setPage('/page/step2', '<p>step 2</p>');

    manager = new BrowserManager({ mode: 'launch', headless: true });
    await manager.tabsBatch([{ action: 'open', url: `${fx.baseUrl}/blank` }]);
    ({ page, tabId } = await manager.getPage());
  });

  after(async () => {
    if (savedSaveRoot === undefined) {
      delete process.env.TURBO_BROWSER_SAVE_ROOT;
    } else {
      process.env.TURBO_BROWSER_SAVE_ROOT = savedSaveRoot;
    }
    await manager?.close();
    if (fx?.server) {
      await new Promise((resolve) => fx.server.close(resolve));
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // Round-4 Concrete Bugs (R4-BUG-01 .. R4-BUG-07)
  // =========================================================================

  it('R4-BUG-01 smart_fill_form option/check respects selector/ref targets, prevents outer .form-fields wrapper from clicking sibling <fieldset> radios when <select> matches, and handles .field-item option wrappers + standalone checkboxes', async () => {
    // 1A. { selector: '#citizen', option: 'Yes' } and { ref, option: 'No' } must fill <select> without toggling unrelated radios
    fx.setPage(
      '/r4-bug01-selector',
      `<form onsubmit="return false">
         <label><input type="radio" name="smoke" value="yes"> Yes</label>
         <label><input type="radio" name="smoke" value="no"> No</label>
         <label for="citizen">Citizenship</label>
         <select id="citizen">
           <option value="">--</option>
           <option value="yes">Yes</option>
           <option value="no">No</option>
         </select>
       </form>`
    );
    await page.goto(`${fx.baseUrl}/r4-bug01-selector`, { waitUntil: 'load' });

    const r1a = await smartFillForm(page, {
      fields: [{ selector: '#citizen', option: 'Yes' }],
    });
    const st1a = await page.evaluate(() => ({
      citizen: document.getElementById('citizen').value,
      smoke: document.querySelector('[name="smoke"]:checked')?.value ?? null,
    }));
    assert.equal(st1a.citizen, 'yes', `Expected #citizen="yes", got ${JSON.stringify({ st1a, r1a })}`);
    assert.equal(st1a.smoke, null, `Unrelated smoke radio was clicked via selector+option: ${JSON.stringify({ st1a, r1a })}`);

    const snap1a = await inspectCompact(page, { mode: 'forms' });
    const citizenRef = /\[(f0:e\d+)\] <select> "Citizenship"/.exec(snap1a.text)?.[1];
    assert.ok(citizenRef, snap1a.text);
    await smartFillForm(page, {
      overwrite: true,
      fields: [{ ref: citizenRef, option: 'No' }],
    });
    assert.equal(await page.inputValue('#citizen'), 'no');
    assert.equal(await page.evaluate(() => document.querySelector('[name="smoke"]:checked')?.value ?? null), null);

    // 1B. Outer .form-fields wrapper containing a <label><select> and a sibling <fieldset> radio group
    fx.setPage(
      '/r4-bug01-wrapper',
      `<form onsubmit="return false">
         <div class="form-fields">
           <label>Are you a citizen?
             <select id="citizen">
               <option value="">--</option>
               <option value="yes">Yes</option>
               <option value="no">No</option>
             </select>
           </label>
           <fieldset>
             <legend>Do you smoke?</legend>
             <label><input type="radio" name="smoke" value="yes"> Yes</label>
             <label><input type="radio" name="smoke" value="no"> No</label>
           </fieldset>
         </div>
       </form>`
    );
    await page.goto(`${fx.baseUrl}/r4-bug01-wrapper`, { waitUntil: 'load' });

    const r1b = await smartFillForm(page, {
      fields: [{ keys: 'citizen', option: 'Yes' }],
    });
    const st1b = await page.evaluate(() => ({
      citizen: document.getElementById('citizen').value,
      smoke: document.querySelector('[name="smoke"]:checked')?.value ?? null,
    }));
    assert.equal(st1b.citizen, 'yes', `Expected #citizen="yes" inside .form-fields, got ${JSON.stringify({ st1b, r1b })}`);
    assert.equal(st1b.smoke, null, `Outer .form-fields wrapper answered sibling "Do you smoke?" fieldset: ${JSON.stringify({ st1b, r1b })}`);

    // 1C. Per-option .field-item wrappers inside <fieldset> + standalone <label><input type="checkbox"> without QUESTION_BLOCK
    fx.setPage(
      '/r4-bug01-option-wrappers',
      `<form onsubmit="return false">
         <fieldset>
           <legend>Email frequency</legend>
           <div class="field-item"><label><input type="radio" name="freq" value="daily"> Daily Email</label></div>
           <div class="field-item"><label><input type="radio" name="freq" value="never"> Never</label></div>
         </fieldset>
         <label><input id="chk-tos" type="checkbox" name="tos"> I agree to Terms</label>
         <label><input id="chk-mkt" type="checkbox" name="mkt"> Marketing updates</label>
       </form>`
    );
    await page.goto(`${fx.baseUrl}/r4-bug01-option-wrappers`, { waitUntil: 'load' });

    const r1c = await smartFillForm(page, {
      fields: [
        { keys: 'Email', option: 'Never' },
        { keys: 'Terms', check: 'agree' },
      ],
    });
    const st1c = await page.evaluate(() => ({
      freq: document.querySelector('[name="freq"]:checked')?.value ?? null,
      tos: document.getElementById('chk-tos').checked,
      mkt: document.getElementById('chk-mkt').checked,
    }));
    assert.equal(st1c.freq, 'never', `Single-option .field-item wrapper shadowed <fieldset>: ${JSON.stringify({ st1c, r1c })}`);
    assert.equal(st1c.tos, true, `Standalone checkbox without QUESTION_BLOCK failed { keys, check }: ${JSON.stringify({ st1c, r1c })}`);
    assert.equal(st1c.mkt, false);
  });

  it('R4-BUG-02 smart_fill_form [role="combobox"] targeted by ref or selector opens listbox and clicks [role="option"] instead of clobbering trigger text in Pass 1', async () => {
    fx.setPage(
      '/r4-bug02-combo-ref-sel',
      `<div class="field">
         <label id="reg-lbl">Region</label>
         <button id="cb-reg" type="button" role="combobox" aria-labelledby="reg-lbl" style="width:150px;height:30px">
           <span class="cb-text">Select...</span><span class="cb-caret">▼</span>
         </button>
       </div>
       <div class="field">
         <label id="tz-lbl">Timezone</label>
         <div id="cb-tz" role="combobox" aria-labelledby="tz-lbl" tabindex="0" style="width:150px;height:30px;border:1px solid #333">Select...</div>
       </div>
       <div id="portal-lb" role="listbox" hidden></div>
       <script>
         function mountOpts(trigger, values, stateKey) {
           const lb = document.getElementById('portal-lb');
           lb.innerHTML = '';
           lb.hidden = false;
           for (const v of values) {
             const opt = document.createElement('div');
             opt.setAttribute('role', 'option');
             opt.textContent = v;
             opt.style.padding = '4px 8px';
             opt.addEventListener('click', () => {
               window[stateKey] = v;
               trigger.setAttribute('data-value', v);
               const span = trigger.querySelector('.cb-text');
               if (span) span.textContent = v;
               else trigger.textContent = v;
               lb.hidden = true;
             });
             lb.appendChild(opt);
           }
         }
         document.getElementById('cb-reg').addEventListener('click', (e) => {
           mountOpts(e.currentTarget, ['Singapore', 'Tokyo'], '__pickedRegion');
         });
         document.getElementById('cb-tz').addEventListener('click', (e) => {
           mountOpts(e.currentTarget, ['UTC+7', 'UTC+0'], '__pickedTz');
         });
       </script>`
    );
    await page.goto(`${fx.baseUrl}/r4-bug02-combo-ref-sel`, { waitUntil: 'load' });

    const snap = await inspectCompact(page, { mode: 'forms' });
    const regRef = /\[(f0:e\d+)\] <button:combobox> "Region"/.exec(snap.text)?.[1];
    assert.ok(regRef, `Missing combobox ref in snapshot: ${snap.text}`);

    const res = await smartFillForm(page, {
      overwrite: false,
      fields: [
        { ref: regRef, value: 'Singapore' },
        { selector: '#cb-tz', value: 'UTC+7' },
      ],
    });

    const state = await page.evaluate(() => ({
      pickedRegion: window.__pickedRegion || null,
      pickedTz: window.__pickedTz || null,
      caretIntact: Boolean(document.querySelector('#cb-reg .cb-caret')),
    }));
    assert.equal(state.pickedRegion, 'Singapore', `ref-targeted combobox did not click [role="option"]: ${JSON.stringify({ state, res })}`);
    assert.equal(state.pickedTz, 'UTC+7', `selector-targeted combobox did not click [role="option"]: ${JSON.stringify({ state, res })}`);
    assert.equal(state.caretIntact, true, 'Pass 1 clobbered child elements inside <button role="combobox">');
  });

  it('R4-BUG-03 empty files:[] in smart_fill_form does not clear inputs or claim filled, and files:[] + file falls back to file in act_fast upload/drop', async () => {
    fx.setPage(
      '/r4-bug03-files',
      `<input id="full-name" value="Alice">
       <input id="cv-file" type="file">
       <div id="drop-zone" style="width:140px;height:60px;border:1px dashed #333">Drop here</div>
       <script>
         document.getElementById('drop-zone').addEventListener('drop', (e) => {
           e.preventDefault();
           window.__droppedNames = [...e.dataTransfer.files].map((f) => f.name);
         });
       </script>`
    );
    await page.goto(`${fx.baseUrl}/r4-bug03-files`, { waitUntil: 'load' });

    const fillEmpty = await smartFillForm(page, {
      overwrite: true,
      fields: [
        { selector: '#full-name', files: [] },
        { selector: '#cv-file', files: [] },
      ],
    });
    assert.equal(await page.inputValue('#full-name'), 'Alice', `files:[] cleared #full-name: ${JSON.stringify(fillEmpty)}`);
    assert.equal(fillEmpty.filledCount, 0, `files:[] falsely reported filledCount > 0: ${JSON.stringify(fillEmpty)}`);

    const upRes = await actFast(page, {
      action: 'upload',
      selector: '#cv-file',
      files: [],
      file: sampleFile,
    });
    assert.equal(upRes.ok, true);
    assert.deepEqual(upRes.files, ['resume-r4.txt']);

    const dropRes = await actFast(page, {
      action: 'drop',
      selector: '#drop-zone',
      files: [],
      file: sampleFile,
    });
    assert.equal(dropRes.ok, true);
    assert.deepEqual(await page.evaluate(() => window.__droppedNames || []), ['resume-r4.txt']);
  });

  it('R4-BUG-04 act_fast wait handles hidden preceding duplicates for state:"visible", textGone, and state:"hidden", plus glob patterns in wait { url }', async () => {
    fx.setPage(
      '/r4-bug04-wait',
      `<div class="mobile-hidden" style="display:none">
         <div class="spin">Processing...</div>
         <button class="ready-btn" type="button">ReadyNow</button>
       </div>
       <div class="desktop-visible">
         <div id="live-spin" class="spin">Processing...</div>
         <button id="live-ready" class="ready-btn" type="button">ReadyNow</button>
       </div>`
    );
    await page.goto(`${fx.baseUrl}/r4-bug04-wait`, { waitUntil: 'load' });

    // 4A. state: 'visible' must succeed when second matching element is visible despite hidden first duplicate
    const visBySel = await actFast(page, {
      action: 'wait',
      selector: '.ready-btn',
      state: 'visible',
      timeoutMs: 800,
    });
    assert.equal(visBySel.ok, true);

    const visByTxt = await actFast(page, {
      action: 'wait',
      text: 'ReadyNow',
      state: 'visible',
      timeoutMs: 800,
    });
    assert.equal(visByTxt.ok, true);

    // 4B. textGone must wait until the VISIBLE "Processing..." disappears, not resolve early on hidden duplicate
    await page.evaluate(() => {
      setTimeout(() => {
        document.getElementById('live-spin').style.display = 'none';
      }, 180);
    });
    await actFast(page, { action: 'wait', textGone: 'Processing...', timeoutMs: 2500 });
    assert.equal(
      await page.locator('#live-spin').isVisible(),
      false,
      'wait { textGone } resolved while visible #live-spin was still shown'
    );

    // 4C. state: 'hidden' must wait until visible matching element hides
    await page.evaluate(() => {
      const el = document.getElementById('live-spin');
      el.style.display = 'block';
      setTimeout(() => {
        el.style.display = 'none';
      }, 180);
    });
    await actFast(page, { action: 'wait', selector: '.spin', state: 'hidden', timeoutMs: 2500 });
    assert.equal(
      await page.locator('#live-spin').isVisible(),
      false,
      'wait { selector, state: "hidden" } resolved while visible #live-spin was still shown'
    );

    // 4D. wait { url } supports '*' glob patterns alongside literal '?' and regex
    await page.goto(`${fx.baseUrl}/page/step2?ok=1`, { waitUntil: 'load' });
    const globWait = await actFast(page, {
      action: 'wait',
      url: '**/page/step2*',
      timeoutMs: 1000,
    });
    assert.equal(globWait.ok, true);
  });

  it('R4-BUG-05 allowSubmit=false blocks press Enter/Space on icon button labelled via <label for="..."> and compound safe-prefix buttons ("Continue & Post", "Tiếp tục & Đăng bài")', async () => {
    fx.resetHits();
    fx.setPage(
      '/r4-bug05-guard',
      `<label for="icon-del">Delete record</label>
       <button id="icon-del" type="button" style="width:48px;height:32px" onclick="${postSubmit('lbl-del')}">🗑️</button>

       <form action="/submit?k=cont-post" method="post">
         <button id="btn-cont-post" type="submit">Continue &amp; Post</button>
       </form>
       <form action="/submit?k=vn-post" method="post">
         <button id="btn-vn-post" type="submit">Tiếp tục &amp; Đăng bài</button>
       </form>
       <form onsubmit="window.__safeSearchOrders = (window.__safeSearchOrders || 0) + 1; return false;">
         <button id="btn-safe-orders" type="submit">Search orders</button>
       </form>`
    );
    await page.goto(`${fx.baseUrl}/r4-bug05-guard`, { waitUntil: 'load' });

    const rEnter = await actFast(page, { action: 'press', selector: '#icon-del', key: 'Enter', allowSubmit: false });
    assert.equal(await waitHits('lbl-del', 150), 0, `Enter on <label for> icon button fired Delete: ${JSON.stringify(rEnter)}`);
    assert.equal(rEnter.blocked, true);

    await page.focus('#icon-del');
    const rSpace = await actFast(page, { action: 'press', key: 'Space', allowSubmit: false });
    assert.equal(await waitHits('lbl-del', 150), 0, `Space on focused <label for> icon button fired Delete: ${JSON.stringify(rSpace)}`);
    assert.equal(rSpace.blocked, true);

    const rContPost = await actFast(page, { action: 'click', selector: '#btn-cont-post', allowSubmit: false });
    assert.equal(await waitHits('cont-post', 150), 0, `"Continue & Post" bypassed guard: ${JSON.stringify(rContPost)}`);
    assert.equal(rContPost.blocked, true);

    const rVnPost = await actFast(page, { action: 'click', selector: '#btn-vn-post', allowSubmit: false });
    assert.equal(await waitHits('vn-post', 150), 0, `"Tiếp tục & Đăng bài" bypassed guard: ${JSON.stringify(rVnPost)}`);
    assert.equal(rVnPost.blocked, true);

    const rSafeOrders = await actFast(page, { action: 'click', selector: '#btn-safe-orders', allowSubmit: false });
    assert.equal(rSafeOrders.ok, true, `Safe "Search orders" was over-blocked: ${JSON.stringify(rSafeOrders)}`);
    assert.equal(await page.evaluate(() => window.__safeSearchOrders || 0), 1);
  });

  it('R4-BUG-06 extract_clean_text ignores <main>/<article> inside display:none or [hidden] ancestors and handles invalid CSS selectors without throwing', async () => {
    fx.setPage(
      '/r4-bug06-extract',
      `<div class="inactive-tab" style="display:none">
         <main><h2>Old Route</h2><p>STALE_DISPLAY_NONE_MAIN</p></main>
       </div>
       <div hidden>
         <article><p>STALE_HIDDEN_ATTR_ARTICLE</p></article>
       </div>
       <div class="active-tab">
         <main>
           <h2>Live Overview</h2>
           <p>ACTIVE_VISIBLE_CONTENT</p>
           <svg width="20" height="20"><text>SVG_NOISE_TEXT</text><style>.x{fill:red}</style></svg>
         </main>
       </div>`
    );
    await page.goto(`${fx.baseUrl}/r4-bug06-extract`, { waitUntil: 'load' });

    const plain = await extractCleanText(page, { format: 'text', includeFrames: false });
    assert.ok(plain.text.includes('ACTIVE_VISIBLE_CONTENT'), `Missing active <main> in plain text: ${plain.text}`);
    assert.ok(!plain.text.includes('STALE_DISPLAY_NONE_MAIN'), `Extracted display:none ancestor <main>: ${plain.text}`);
    assert.ok(!plain.text.includes('STALE_HIDDEN_ATTR_ARTICLE'), `Extracted [hidden] ancestor <article>: ${plain.text}`);
    assert.ok(!plain.text.includes('SVG_NOISE_TEXT'), `Lowercase <svg> leaked into plain text: ${plain.text}`);

    const md = await extractCleanText(page, { format: 'markdown', includeFrames: false });
    assert.ok(md.text.includes('## Live Overview') && md.text.includes('ACTIVE_VISIBLE_CONTENT'), `Missing active <main> in markdown: ${md.text}`);
    assert.ok(!md.text.includes('STALE_DISPLAY_NONE_MAIN'), `Extracted display:none ancestor <main> in markdown: ${md.text}`);
    assert.ok(!md.text.includes('SVG_NOISE_TEXT'), `Lowercase <svg> leaked into markdown: ${md.text}`);

    const badSel = await extractCleanText(page, { selector: '[unclosed', format: 'text', includeFrames: false });
    assert.equal(typeof badSel.text, 'string');
  });

  it('R4-BUG-07 network_session ignores empty/whitespace entries in blockUrls instead of blocking all requests via /(?:)/i', async () => {
    try {
      await manager.manageNetworkSession(tabId, { blockUrls: ['', '   '] });
      await page.goto(`${fx.baseUrl}/blank`, { waitUntil: 'load' });
      const pong = await page.evaluate(async () => {
        const r = await fetch('/api/ping');
        return r.json();
      });
      assert.deepEqual(pong, { ok: true });
    } finally {
      await manager.manageNetworkSession(tabId, { preset: 'clean' });
    }
  });

  it('R4-BUG-08 smart_fill_form preserves independent single-checkbox .form-group question blocks inside an outer .form-fields container', async () => {
    fx.setPage(
      '/r4-bug08-multi-chk-groups',
      `<form onsubmit="return false">
         <div class="form-fields">
           <div class="form-group">
             <span>Criminal record?</span>
             <label><input type="checkbox" id="chk-crim"> Yes</label>
           </div>
           <div class="form-group">
             <span>Willing to relocate?</span>
             <label><input type="checkbox" id="chk-reloc"> Yes</label>
           </div>
         </div>
       </form>`
    );
    await page.goto(`${fx.baseUrl}/r4-bug08-multi-chk-groups`, { waitUntil: 'load' });

    const res = await smartFillForm(page, {
      fields: [{ keys: 'relocate', check: 'Yes' }],
    });
    const st = await page.evaluate(() => ({
      crim: document.getElementById('chk-crim').checked,
      reloc: document.getElementById('chk-reloc').checked,
    }));
    assert.equal(st.reloc, true, `Expected #chk-reloc=true: ${JSON.stringify({ st, res })}`);
    assert.equal(st.crim, false, `Unrelated "Criminal record? Yes" checkbox was checked: ${JSON.stringify({ st, res })}`);
  });

  it('R4-BUG-09 extract_clean_text preserves CSS visibility:visible descendants inside visibility:hidden ancestors in text and markdown modes', async () => {
    fx.setPage(
      '/r4-bug09-vis-override',
      `<div style="visibility:hidden">
         <p>HIDDEN_PARENT_TEXT</p>
         <main style="visibility:visible">
           <h2>VISIBLE_OVERRIDE_MAIN</h2>
           <p>VISIBLE_BODY_COPY</p>
         </main>
       </div>`
    );
    await page.goto(`${fx.baseUrl}/r4-bug09-vis-override`, { waitUntil: 'load' });

    const plain = await extractCleanText(page, { format: 'text', includeFrames: false });
    assert.ok(plain.text.includes('VISIBLE_OVERRIDE_MAIN') && plain.text.includes('VISIBLE_BODY_COPY'), `Lost visibility:visible override in plain text: ${plain.text}`);
    assert.ok(!plain.text.includes('HIDDEN_PARENT_TEXT'), `Included visibility:hidden parent text: ${plain.text}`);

    const md = await extractCleanText(page, { format: 'markdown', includeFrames: false });
    assert.ok(md.text.includes('## VISIBLE_OVERRIDE_MAIN') && md.text.includes('VISIBLE_BODY_COPY'), `Lost visibility:visible override in markdown: ${md.text}`);
    assert.ok(!md.text.includes('HIDDEN_PARENT_TEXT'), `Included visibility:hidden parent text in markdown: ${md.text}`);
  });

  it('R4-BUG-10 act_fast wait textGone and state:"hidden" re-check dynamically mounted/shifted matches until zero visible matches remain and bound total timeoutMs', async () => {
    fx.setPage(
      '/r4-bug10-dynamic-wait',
      `<div id="s1" class="spin">Saving...</div>
       <div id="mount-root"></div>`
    );
    await page.goto(`${fx.baseUrl}/r4-bug10-dynamic-wait`, { waitUntil: 'load' });

    // 10A. Dynamic second spinner mounts while first spinner is hiding
    await page.evaluate(() => {
      setTimeout(() => {
        const s2 = document.createElement('div');
        s2.id = 's2';
        s2.className = 'spin';
        s2.textContent = 'Saving...';
        document.getElementById('mount-root').appendChild(s2);
      }, 40);
      setTimeout(() => {
        document.getElementById('s1').style.display = 'none';
      }, 90);
      setTimeout(() => {
        const s2 = document.getElementById('s2');
        if (s2) s2.style.display = 'none';
      }, 260);
    });
    await actFast(page, { action: 'wait', textGone: 'Saving...', timeoutMs: 2500 });
    assert.equal(await page.locator('#s2').isVisible().catch(() => false), false, 'textGone resolved while dynamically mounted #s2 was still visible');

    // 10B. Same dynamic shift/mount guarantee for selector + state:"hidden"
    await page.evaluate(() => {
      const root = document.getElementById('mount-root');
      root.innerHTML = '';
      const s1 = document.getElementById('s1');
      s1.style.display = 'block';
      setTimeout(() => {
        const s3 = document.createElement('div');
        s3.id = 's3';
        s3.className = 'spin';
        s3.textContent = 'Saving...';
        root.appendChild(s3);
      }, 40);
      setTimeout(() => {
        s1.style.display = 'none';
      }, 90);
      setTimeout(() => {
        const s3 = document.getElementById('s3');
        if (s3) s3.style.display = 'none';
      }, 260);
    });
    await actFast(page, { action: 'wait', selector: '.spin', state: 'hidden', timeoutMs: 2500 });
    assert.equal(await page.locator('#s3').isVisible().catch(() => false), false, 'state:"hidden" resolved while dynamically mounted #s3 was still visible');
  });

  // =========================================================================
  // Round-4 Regression & Contract Verification (R4-REG-01 .. R4-REG-06)
  // =========================================================================

  it('R4-REG-01 plain Enter and "\\n" typing in <textarea> remain allowed while Control+Enter / Meta+Enter in <textarea> and [contenteditable] inside <form> are blocked', async () => {
    fx.resetHits();
    fx.setPage(
      '/r4-reg01-composer',
      `<form id="comp-form" action="/submit?k=comp" method="post">
         <textarea id="ta" name="body">line1</textarea>
         <div id="ce" contenteditable="true" style="min-height:30px;border:1px solid #888">edit1</div>
         <button type="submit">Send</button>
       </form>
       <script>
         for (const id of ['ta', 'ce']) {
           document.getElementById(id).addEventListener('keydown', (e) => {
             if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
               e.preventDefault();
               document.getElementById('comp-form').requestSubmit();
             }
           });
         }
       </script>`
    );
    await page.goto(`${fx.baseUrl}/r4-reg01-composer`, { waitUntil: 'load' });

    const plainEnter = await actFast(page, { action: 'press', selector: '#ta', key: 'Enter', allowSubmit: false });
    assert.equal(plainEnter.ok, true, `Plain Enter in <textarea> should remain unblocked: ${JSON.stringify(plainEnter)}`);

    const typeNewline = await actFast(page, { action: 'type', selector: '#ta', value: 'a\nb', allowSubmit: false });
    assert.equal(typeNewline.ok, true, `Multiline type in <textarea> should remain unblocked: ${JSON.stringify(typeNewline)}`);

    const ctrlTa = await actFast(page, { action: 'press', selector: '#ta', key: 'Control+Enter', allowSubmit: false });
    assert.equal(ctrlTa.blocked, true);

    const metaCe = await actFast(page, { action: 'press', selector: '#ce', key: 'Meta+Enter', allowSubmit: false });
    assert.equal(metaCe.blocked, true);

    await page.focus('#ce');
    const untargetedCtrl = await actFast(page, { action: 'press', key: 'Control+Enter', allowSubmit: false });
    assert.equal(untargetedCtrl.blocked, true);

    assert.equal(await waitHits('comp', 200), 0);
  });

  it('R4-REG-02 role="menuitem", "menuitemcheckbox", and "menuitemradio" block destructive labels on click/coord/Enter while permitting safe items', async () => {
    fx.resetHits();
    fx.setPage(
      '/r4-reg02-menus',
      `<div role="menu">
         <div id="mi-edit" role="menuitem" tabindex="0" style="width:140px;height:28px" onclick="window.__edited = 1">Edit profile</div>
         <div id="mi-del" role="menuitem" tabindex="0" style="width:140px;height:28px" onclick="${postSubmit('mi-del')}"><span>Delete</span></div>
         <div id="mic-pub" role="menuitemcheckbox" aria-checked="false" tabindex="0" style="width:140px;height:28px" onclick="${postSubmit('mic-pub')}">Publish</div>
         <div id="mir-rem" role="menuitemradio" aria-checked="false" tabindex="0" style="width:140px;height:28px" onclick="${postSubmit('mir-rem')}">Remove</div>
       </div>`
    );
    await page.goto(`${fx.baseUrl}/r4-reg02-menus`, { waitUntil: 'load' });

    const safeClick = await actFast(page, { action: 'click', selector: '#mi-edit', allowSubmit: false });
    assert.equal(safeClick.ok, true);
    assert.equal(await page.evaluate(() => window.__edited || 0), 1);

    const box = await page.locator('#mi-del').boundingBox();
    const coordClick = await actFast(page, {
      action: 'click',
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
      allowSubmit: false,
    });
    assert.equal(coordClick.blocked, true);

    const enterMic = await actFast(page, { action: 'press', selector: '#mic-pub', key: 'Enter', allowSubmit: false });
    assert.equal(enterMic.blocked, true);

    const clickMir = await actFast(page, { action: 'click', selector: '#mir-rem', allowSubmit: false });
    assert.equal(clickMir.blocked, true);

    assert.equal(await waitHits('mi-del', 120), 0);
    assert.equal(await waitHits('mic-pub', 50), 0);
    assert.equal(await waitHits('mir-rem', 50), 0);
  });

  it('R4-REG-03 COMPOUND_DANGER_RE blocks "Continue & Pay" / "Next: Complete Purchase" while keeping "Continue" / "Next" allowed', async () => {
    fx.resetHits();
    fx.setPage(
      '/r4-reg03-compound',
      `<form action="/submit?k=compound" method="post">
         <button id="b-cont-pay" type="submit">Continue &amp; Pay</button>
         <button id="b-next-buy" type="button" onclick="${postSubmit('compound')}">Next: Complete Purchase</button>
       </form>
       <form onsubmit="window.__wizNext = (window.__wizNext || 0) + 1; return false;">
         <button id="b-safe-cont" type="submit">Continue</button>
       </form>`
    );
    await page.goto(`${fx.baseUrl}/r4-reg03-compound`, { waitUntil: 'load' });

    assert.equal((await actFast(page, { action: 'click', selector: '#b-cont-pay', allowSubmit: false })).blocked, true);
    assert.equal((await actFast(page, { action: 'click', selector: '#b-next-buy', allowSubmit: false })).blocked, true);
    assert.equal(await waitHits('compound', 150), 0);

    const safeCont = await actFast(page, { action: 'click', selector: '#b-safe-cont', allowSubmit: false });
    assert.equal(safeCont.ok, true);
    assert.equal(await page.evaluate(() => window.__wizNext || 0), 1);
  });

  it('R4-REG-04 smart_fill_form survives non-CSS selector in Pass 1 & Pass 1.5, fills <div role="textbox"> cleanly, and falls back from files:[] to file', async () => {
    fx.setPage(
      '/r4-reg04-resilience',
      `<div id="custom-tb" role="textbox" aria-label="Custom Notes" tabindex="0" style="width:200px;height:28px;border:1px solid #666"></div>
       <input id="search-cb" role="combobox" aria-label="Quick Search">
       <label>Work Email <input id="work-email" type="email"></label>
       <label>Attachment <input id="att-file" type="file"></label>`
    );
    await page.goto(`${fx.baseUrl}/r4-reg04-resilience`, { waitUntil: 'load' });

    const res = await smartFillForm(page, {
      fields: [
        { selector: 'text=NonCssSelector', value: 'ignored' },
        { keys: 'Custom Notes', value: 'aria note text' },
        { keys: 'Quick Search', value: 'playwright docs' },
        { keys: 'Work Email', value: 'team@corp.io' },
        { keys: 'Attachment', files: [], file: sampleFile },
      ],
    });
    assert.equal(await page.inputValue('#work-email'), 'team@corp.io');
    assert.equal(await page.inputValue('#search-cb'), 'playwright docs');
    assert.equal(await page.locator('#custom-tb').textContent(), 'aria note text');
    assert.equal(await page.evaluate(() => document.getElementById('att-file').files[0]?.name || ''), 'resume-r4.txt');
    assert.equal(res.filledCount, 4);
  });

  it('R4-REG-05 batch_actions enforces allowSubmit:false ceiling across steps and returns post-batch snapshot', async () => {
    fx.resetHits();
    fx.setPage(
      '/r4-reg05-batch',
      `<form action="/submit?k=batch-guard" method="post">
         <input id="b-inp" name="q">
         <button id="b-sub" type="submit">Submit</button>
       </form>`
    );
    await page.goto(`${fx.baseUrl}/r4-reg05-batch`, { waitUntil: 'load' });

    const out = await batchActions(
      page,
      [
        { action: 'fill', selector: '#b-inp', value: 'draft' },
        { action: 'click', selector: '#b-sub', allowSubmit: true },
      ],
      { allowSubmit: false, continueOnError: true, returnSnapshot: true }
    );
    assert.equal(out.results[0].ok, true);
    assert.equal(out.results[1].blocked, true);
    assert.ok(out.snapshot && out.snapshot.includes('Submit'));
    assert.equal(await waitHits('batch-guard', 150), 0);
  });

  it('R4-REG-06 JSON-RPC handler & resolveSafePath enforce strict protocol and directory confinement contracts', async () => {
    const handle = createJsonRpcHandler(manager);
    assert.equal((await handle([])).error.code, -32600);
    assert.equal((await handle({ id: 1, method: 'ping' })).error.code, -32600);
    assert.equal((await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'act_fast', arguments: [] } })).error.code, -32602);
    assert.throws(() => resolveSafePath('../escape-r4.json'));
  });
});
