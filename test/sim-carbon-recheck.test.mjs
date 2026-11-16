// sim-carbon-recheck: Round-3 Deep Auditor adversarial & regression suite (gemini-auditor-2).
// Strictly adheres to documented tool contracts and verifies real side effects (HTTP server
// submission counters, DOM state, frame refs, diagnostics buffers, and JSON-RPC 2.0 responses).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BrowserManager } from '../src/browser-manager.mjs';
import {
  actFast,
  evaluateJs,
  extractCleanText,
  inspectCompact,
  smartFillForm,
} from '../src/dom-engine.mjs';
import { createJsonRpcHandler } from '../src/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.resolve(__dirname, '..', 'src', 'index.mjs');

const htmlDoc = (body, title = 'round3-recheck') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const postHit = (key) => `fetch('/submit?k=${encodeURIComponent(key)}', { method: 'POST' })`;

function startRecheckServer() {
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
        res.end(htmlDoc('<h1>Submitted</h1>'));
      });
      return;
    }
    if (u.pathname === '/slow-error') {
      setTimeout(() => {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'bad_gateway_after_churn' }));
      }, 450);
      return;
    }
    if (u.pathname === '/fast-ok') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
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
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        getHits(key) {
          return hits.get(key) || 0;
        },
        resetHits() {
          hits.clear();
        },
        setPage(routePath, bodyHtml, title) {
          routes.set(routePath, (_req, res) => {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(htmlDoc(bodyHtml, title));
          });
        },
      });
    });
  });
}

describe('sim-carbon-recheck: Round-3 deep adversarial audit suite', { concurrency: 1 }, () => {
  let fx;
  let manager;
  let page;
  let tabId;

  const waitHits = async (key, waitMs = 200) => {
    await page.waitForTimeout(waitMs);
    return fx.getHits(key);
  };

  before(async () => {
    delete process.env.TURBO_BROWSER_ALLOW_SUBMIT;
    fx = await startRecheckServer();
    fx.setPage('/blank', '<p>ready</p>');
    manager = new BrowserManager({ mode: 'launch', headless: true });
    await manager.tabsBatch([{ action: 'open', url: `${fx.baseUrl}/blank` }]);
    ({ page, tabId } = await manager.getPage());
  });

  after(async () => {
    await manager?.close();
    await new Promise((resolve) => fx.server.close(resolve));
  });

  it('R3-01 smart_fill_form toggles <button role="switch"> and selects <button role="combobox"> when root-delegated click handlers check event.defaultPrevented, without submitting <form>', async () => {
    fx.resetHits();
    fx.setPage(
      '/radix-delegated',
      `<div id="react-root">
        <form action="/submit?k=radix-form" method="post">
          <span id="sw1-lbl">Email notifications</span>
          <button type="button" id="sw-typed" role="switch" aria-checked="false" aria-labelledby="sw1-lbl" style="width:70px;height:30px">Off</button>

          <span id="sw2-lbl">SMS alerts</span>
          <button id="sw-untyped" role="switch" aria-checked="false" aria-labelledby="sw2-lbl" style="width:70px;height:30px">Off</button>

          <span id="cb-lbl">Deployment region</span>
          <button id="cb-trigger" role="combobox" aria-labelledby="cb-lbl" aria-expanded="false" style="width:160px;height:32px">Select...</button>
          <div id="cb-listbox" role="listbox" hidden>
            <button id="opt-sg" role="option" style="display:block;width:140px;height:28px">Singapore</button>
            <button id="opt-tk" role="option" style="display:block;width:140px;height:28px">Tokyo</button>
          </div>

          <button type="submit">Submit</button>
        </form>
      </div>
      <script>
        // React 18 + Radix UI composeEventHandlers pattern: listener lives on #react-root
        // in bubble phase and skips component state transitions if event.defaultPrevented is true.
        document.getElementById('react-root').addEventListener('click', (ev) => {
          if (ev.defaultPrevented) return;
          const sw = ev.target.closest('[role="switch"]');
          if (sw) {
            const next = sw.getAttribute('aria-checked') !== 'true';
            sw.setAttribute('aria-checked', String(next));
            sw.textContent = next ? 'On' : 'Off';
            return;
          }
          const cb = ev.target.closest('#cb-trigger');
          if (cb) {
            const lb = document.getElementById('cb-listbox');
            lb.hidden = !lb.hidden;
            cb.setAttribute('aria-expanded', String(!lb.hidden));
            return;
          }
          const opt = ev.target.closest('[role="option"]');
          if (opt) {
            const trigger = document.getElementById('cb-trigger');
            trigger.textContent = opt.textContent.trim();
            trigger.setAttribute('data-value', opt.textContent.trim());
            document.getElementById('cb-listbox').hidden = true;
          }
        });
      </script>`
    );

    await page.goto(`${fx.baseUrl}/radix-delegated`, { waitUntil: 'load' });
    const res = await smartFillForm(page, {
      fields: [
        { keys: 'Email notifications', value: true },
        { keys: 'SMS alerts', value: true },
        { keys: 'Deployment region', value: 'Singapore' },
      ],
    });

    assert.equal(await waitHits('radix-form'), 0, 'Form must NOT be submitted during smart_fill_form');
    const domState = await page.evaluate(() => ({
      swTyped: document.getElementById('sw-typed').getAttribute('aria-checked'),
      swUntyped: document.getElementById('sw-untyped').getAttribute('aria-checked'),
      cbValue: document.getElementById('cb-trigger').getAttribute('data-value'),
    }));
    assert.equal(domState.swTyped, 'true', `Expected type="button" switch to toggle via root handler, got ${JSON.stringify({ domState, res })}`);
    assert.equal(domState.swUntyped, 'true', `Expected type-less switch in <form> to toggle without submitting, got ${JSON.stringify({ domState, res })}`);
    assert.equal(domState.cbValue, 'Singapore', `Expected combobox trigger & option to work via root handler without submitting, got ${JSON.stringify({ domState, res })}`);
  });

  it('R3-02 blocks click on <button aria-label="Send"> containing inline <svg><style>...</style></svg> or Material icon ligature text, while allowing safe "Sign in" SVG button', async () => {
    fx.resetHits();
    fx.setPage(
      '/svg-style-and-ligature',
      `<button id="svg-style-send" type="button" aria-label="Send" style="width:60px;height:40px" onclick="${postHit('svg-style')}">
        <svg width="20" height="20" viewBox="0 0 20 20"><style>.st0{fill:#111}</style><path class="st0" d="M0 0L20 10L0 20z"/></svg>
      </button>
      <button id="svg-title-send" type="button" style="width:60px;height:40px" onclick="${postHit('svg-title')}">
        <svg width="20" height="20"><style>.ic{fill:#222}</style><title>Publish</title><path class="ic" d="M0 0h10v10z"/></svg>
      </button>
      <button id="ligature-del" type="button" aria-label="Delete" style="width:60px;height:40px" onclick="${postHit('ligature')}">
        <span class="material-icons" aria-hidden="true">north_east</span>
      </button>
      <form onsubmit="window.__safeSignIn = (window.__safeSignIn || 0) + 1; return false;">
        <button id="safe-signin-svg" type="submit" aria-label="Sign in" style="width:80px;height:40px">
          <svg width="16" height="16"><style>.s{fill:#090}</style><path class="s" d="M0 0h8v8z"/></svg>
        </button>
      </form>`
    );

    await page.goto(`${fx.baseUrl}/svg-style-and-ligature`, { waitUntil: 'load' });

    const r1 = await actFast(page, { action: 'click', selector: '#svg-style-send', allowSubmit: false });
    assert.equal(await waitHits('svg-style', 150), 0, `SVG <style> hid aria-label="Send": ${JSON.stringify(r1)}`);
    assert.equal(r1.blocked, true);

    const r2 = await actFast(page, { action: 'click', selector: '#svg-title-send', allowSubmit: false });
    assert.equal(await waitHits('svg-title', 150), 0, `SVG <style> hid <svg><title>Publish</title>: ${JSON.stringify(r2)}`);
    assert.equal(r2.blocked, true);

    const r3 = await actFast(page, { action: 'click', selector: '#ligature-del', allowSubmit: false });
    assert.equal(await waitHits('ligature', 150), 0, `Icon ligature text hid aria-label="Delete": ${JSON.stringify(r3)}`);
    assert.equal(r3.blocked, true);

    const rSafe = await actFast(page, { action: 'click', selector: '#safe-signin-svg', allowSubmit: false });
    assert.equal(rSafe.ok, true, `Safe aria-label="Sign in" submit button with SVG <style> should be permitted: ${JSON.stringify(rSafe)}`);
    assert.equal(await page.evaluate(() => window.__safeSignIn || 0), 1);
  });

  it('R3-03 blocks click and press Enter/Space on <button><img alt="Send"></button> and <button aria-labelledby="..."> icon buttons', async () => {
    fx.resetHits();
    fx.setPage(
      '/img-alt-and-labelledby',
      `<button id="img-alt-send" type="button" style="width:60px;height:40px" onclick="${postHit('img-alt')}">
        <img alt="Send" width="16" height="16" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
      </button>
      <span id="ext-send-lbl">Send message</span>
      <button id="lby-send" type="button" aria-labelledby="ext-send-lbl" style="width:60px;height:40px" onclick="${postHit('lby-send')}">
        <svg width="16" height="16"><path d="M0 0L16 8L0 16z"/></svg>
      </button>`
    );

    await page.goto(`${fx.baseUrl}/img-alt-and-labelledby`, { waitUntil: 'load' });

    const cImg = await actFast(page, { action: 'click', selector: '#img-alt-send', allowSubmit: false });
    assert.equal(await waitHits('img-alt', 150), 0, `<img alt="Send"> button click fired: ${JSON.stringify(cImg)}`);
    assert.equal(cImg.blocked, true);

    const pImg = await actFast(page, { action: 'press', selector: '#img-alt-send', key: 'Enter', allowSubmit: false });
    assert.equal(await waitHits('img-alt', 150), 0, `<img alt="Send"> button Enter fired: ${JSON.stringify(pImg)}`);
    assert.equal(pImg.blocked, true);

    const pLbyEnter = await actFast(page, { action: 'press', selector: '#lby-send', key: 'Enter', allowSubmit: false });
    assert.equal(await waitHits('lby-send', 150), 0, `aria-labelledby button targeted Enter fired: ${JSON.stringify(pLbyEnter)}`);
    assert.equal(pLbyEnter.blocked, true);

    await page.focus('#lby-send');
    const pLbySpace = await actFast(page, { action: 'press', key: 'Space', allowSubmit: false });
    assert.equal(await waitHits('lby-send', 150), 0, `aria-labelledby button untargeted Space fired: ${JSON.stringify(pLbySpace)}`);
    assert.equal(pLbySpace.blocked, true);
  });

  it('R3-04 blocks modifier + literal whitespace/newline key chords ("Shift+ ", "Shift+\\n", "Shift+\\r") under allowSubmit=false', async () => {
    fx.resetHits();
    fx.setPage(
      '/mod-whitespace-keys',
      `<form action="/submit?k=mod-keys" method="post">
        <input id="q" name="q" value="test">
        <button id="sub-btn" type="submit">Submit</button>
      </form>`
    );

    await page.goto(`${fx.baseUrl}/mod-whitespace-keys`, { waitUntil: 'load' });

    const rSpace = await actFast(page, { action: 'press', selector: '#sub-btn', key: 'Shift+ ', allowSubmit: false });
    assert.equal(await waitHits('mod-keys', 150), 0, `"Shift+ " submitted form: ${JSON.stringify(rSpace)}`);
    assert.equal(rSpace.blocked, true);

    const rNl = await actFast(page, { action: 'press', selector: '#q', key: 'Shift+\n', allowSubmit: false });
    assert.equal(await waitHits('mod-keys', 150), 0, `"Shift+\\n" submitted form: ${JSON.stringify(rNl)}`);
    assert.equal(rNl.blocked, true);

    await page.focus('#sub-btn');
    const rCr = await actFast(page, { action: 'press', key: 'Shift+\r', allowSubmit: false });
    assert.equal(await waitHits('mod-keys', 150), 0, `Untargeted "Shift+\\r" submitted form: ${JSON.stringify(rCr)}`);
    assert.equal(rCr.blocked, true);
  });

  it('R3-05 blocks newline type on input wrapper <div> and targeted press Enter/Space on non-focusable container while form control is focused', async () => {
    fx.resetHits();
    fx.setPage(
      '/wrapper-type-and-nonfocus-press',
      `<form id="f-wrap" action="/submit?k=wrap-focus" method="post">
        <div id="mui-input-wrap" style="width:220px;height:40px;display:flex;align-items:center">
          <input id="inner-q" name="q" type="text" style="width:200px;height:32px">
        </div>
        <div id="nonfocus-banner">Form Banner</div>
        <button id="sub-b" type="submit">Place Order</button>
      </form>`
    );

    await page.goto(`${fx.baseUrl}/wrapper-type-and-nonfocus-press`, { waitUntil: 'load' });

    const rWrapType = await actFast(page, {
      action: 'type',
      selector: '#mui-input-wrap',
      value: 'hello\n',
      allowSubmit: false,
    });
    assert.equal(await waitHits('wrap-focus', 150), 0, `Newline type on wrapper <div> submitted form: ${JSON.stringify(rWrapType)}`);
    assert.equal(rWrapType.blocked, true);

    await page.focus('#inner-q');
    const rPressContainer = await actFast(page, {
      action: 'press',
      selector: '#nonfocus-banner',
      key: 'Enter',
      allowSubmit: false,
    });
    assert.equal(await waitHits('wrap-focus', 150), 0, `Enter on non-focusable container submitted focused form input: ${JSON.stringify(rPressContainer)}`);
    assert.equal(rPressContainer.blocked, true);

    await page.focus('#sub-b');
    const rSpaceContainer = await actFast(page, {
      action: 'press',
      selector: '#nonfocus-banner',
      key: 'Space',
      allowSubmit: false,
    });
    assert.equal(await waitHits('wrap-focus', 150), 0, `Space on non-focusable container activated focused submit button: ${JSON.stringify(rSpaceContainer)}`);
    assert.equal(rSpaceContainer.blocked, true);
  });

  it('R3-06 intermediate query/selector inspect_compact calls must not corrupt baseline refs omitted by subsequent onlyChanged snapshot', async () => {
    fx.setPage(
      '/delta-after-query',
      `<div id="toolbar">
        <button id="btn-alpha" type="button">Alpha</button>
        <button id="btn-beta" type="button">Beta</button>
      </div>
      <div id="subpanel">
        <button id="btn-panel" type="button">PanelBtn</button>
      </div>`
    );

    await page.goto(`${fx.baseUrl}/delta-after-query`, { waitUntil: 'load' });
    const snapState = new Set();

    const base = await inspectCompact(page, { mode: 'interactive', includeFrames: false }, snapState);
    const betaRef = /\[(f0:e\d+)\] <button> "Beta"/.exec(base.text)?.[1];
    assert.ok(betaRef, `Expected Beta in baseline: ${base.text}`);

    await page.evaluate(() => {
      const g = document.createElement('button');
      g.id = 'btn-gamma';
      g.type = 'button';
      g.textContent = 'Gamma';
      document.getElementById('toolbar').prepend(g);
    });

    await inspectCompact(page, { mode: 'interactive', includeFrames: false, query: 'Gamma' }, snapState);
    await inspectCompact(page, { mode: 'interactive', includeFrames: false, selector: '#subpanel' }, snapState);

    const delta = await inspectCompact(
      page,
      { mode: 'interactive', includeFrames: false, onlyChanged: true },
      snapState
    );
    assert.ok(!delta.text.includes('"Beta"'), `Unchanged Beta should be omitted in delta: ${delta.text}`);

    const resolved = await evaluateJs(page, { ref: betaRef, expression: 'el.id' });
    assert.equal(
      resolved.result,
      'btn-beta',
      `Baseline ref ${betaRef} for omitted Beta was silently hijacked to #${resolved.result}`
    );
  });

  it('R3-07 multi-frame onlyChanged snapshot preserves global uniqueness of bare eN refs across frames', async () => {
    fx.setPage('/child-ref-frame', '<button id="child-btn" type="button">ChildAction</button>');
    fx.setPage(
      '/parent-ref-frame',
      `<div id="main-zone"><button id="main-btn-1" type="button">MainOne</button></div>
       <iframe src="/child-ref-frame" style="width:300px;height:80px"></iframe>`
    );

    await page.goto(`${fx.baseUrl}/parent-ref-frame`, { waitUntil: 'load' });
    const snapState = new Set();

    const base = await inspectCompact(page, { mode: 'interactive', includeFrames: true }, snapState);
    const childBareRef = /\[f1:(e\d+)\] <button> "ChildAction"/.exec(base.text)?.[1];
    assert.ok(childBareRef, `Expected ChildAction ref in f1: ${base.text}`);

    const beforeEval = await evaluateJs(page, { ref: childBareRef, expression: 'el.id' });
    assert.equal(beforeEval.result, 'child-btn');

    await page.evaluate(() => {
      const b = document.createElement('button');
      b.id = 'main-btn-new';
      b.type = 'button';
      b.textContent = 'MainNew';
      document.getElementById('main-zone').appendChild(b);
    });

    const delta = await inspectCompact(page, { mode: 'interactive', includeFrames: true, onlyChanged: true }, snapState);
    assert.match(delta.text, /MainNew/);
    assert.ok(!delta.text.includes('ChildAction'));

    const afterEval = await evaluateJs(page, { ref: childBareRef, expression: 'el.id' });
    assert.equal(
      afterEval.result,
      'child-btn',
      `Bare ref ${childBareRef} from f1 was collided/hijacked by f0 element #${afterEval.result} during onlyChanged`
    );
  });

  it('R3-08 inspect_compact and extract_clean_text prefer visible selector/landmark matches over hidden preceding ones', async () => {
    fx.setPage(
      '/hidden-preceding-containers',
      `<main hidden>Stale hidden SPA route</main>
       <main id="active-main">
         <p>Visible active article text</p>
         <div class="dlg" style="display:none"><button id="hidden-dlg-btn" type="button">OldHidden</button></div>
         <div class="dlg"><p>Modal Copy</p><button id="vis-dlg-btn" type="button">ActiveVisibleModal</button></div>
       </main>`
    );

    await page.goto(`${fx.baseUrl}/hidden-preceding-containers`, { waitUntil: 'load' });

    const modalSnap = await inspectCompact(page, { mode: 'interactive', includeFrames: false, selector: '.dlg' });
    assert.match(modalSnap.text, /ActiveVisibleModal/, `Expected visible .dlg match in inspectCompact, got: ${modalSnap.text}`);

    const mainText = await extractCleanText(page, { format: 'text', includeFrames: false });
    assert.match(mainText.text, /Visible active article text/, `Active <main> skipped due to <main hidden>: ${mainText.text}`);
    assert.doesNotMatch(mainText.text, /Stale hidden SPA route/);

    const scopedText = await extractCleanText(page, { selector: '.dlg', format: 'text', includeFrames: false });
    assert.match(scopedText.text, /Modal Copy/, `Visible .dlg skipped due to hidden first .dlg: ${scopedText.text}`);
  });

  it('R3-09 extract_clean_text (markdown) separates block children inside <blockquote>, <li>, and <td>/<th> on minified HTML', async () => {
    fx.setPage(
      '/md-block-gluing',
      `<main>
        <blockquote><p>First quote line.</p><p>Second quote line.</p></blockquote>
        <ul><li><p>Item heading</p><p>Item detail</p></li></ul>
        <table><tr><th>Feature</th><th>Notes</th></tr><tr><td><div>CorePlan</div><div>Monthly</div></td><td>Ready</td></tr></table>
      </main>`
    );

    await page.goto(`${fx.baseUrl}/md-block-gluing`, { waitUntil: 'load' });
    const md = await extractCleanText(page, { format: 'markdown', includeFrames: false });

    assert.ok(md.text.includes('First quote line.'), md.text);
    assert.ok(!md.text.includes('First quote line.Second quote line.'), `Blockquote <p> children glued: ${md.text}`);
    assert.ok(!md.text.includes('Item headingItem detail'), `List item <p> children glued: ${md.text}`);
    assert.ok(!md.text.includes('CorePlanMonthly'), `Table cell <div> children glued: ${md.text}`);
  });

  it('R3-10 evaluate_js strips trailing semicolons/comments after member-property division (.in, .new, ?.delete, .return) and contextual "of"', async () => {
    fx.setPage('/eval-prop-div', '<div id="metric" data-in="18" data-new="20">ok</div>');
    await page.goto(`${fx.baseUrl}/eval-prop-div`, { waitUntil: 'load' });

    const rDatasetIn = await evaluateJs(page, {
      selector: '#metric',
      expression: 'el.dataset.in / 3; // dataset.in division',
    });
    assert.equal(rDatasetIn.result, 6, `el.dataset.in / 3; returned ${JSON.stringify(rDatasetIn)}`);

    const rObjNew = await evaluateJs(page, {
      expression: '({ new: 20 }).new / 4; /* member .new division */',
    });
    assert.equal(rObjNew.result, 5, `({ new: 20 }).new / 4; returned ${JSON.stringify(rObjNew)}`);

    const rOptChain = await evaluateJs(page, {
      expression: '({ delete: 14 })?.delete / 2;',
    });
    assert.equal(rOptChain.result, 7, `optional-chained ?.delete / 2; returned ${JSON.stringify(rOptChain)}`);

    const rContextualOf = await evaluateJs(page, {
      expression: '((of) => of / 2)(12); // contextual identifier of',
    });
    assert.equal(rContextualOf.result, 6);

    const rKwRegex = await evaluateJs(page, {
      expression: '(() => { return /a;b\\/c/.test("a;b/c"); })(); // keyword return + regex',
    });
    assert.equal(rKwRegex.result, true);
  });

  it('R3-11 page_diagnostics records 5xx failure of a slow in-flight request whose initial request entry was evicted by >100 fast requests', async () => {
    await page.goto(`${fx.baseUrl}/blank`, { waitUntil: 'load' });
    await manager.getDiagnostics(tabId, { clear: true });

    const slowStatus = await page.evaluate(async () => {
      const slowPromise = fetch('/slow-error').then((r) => r.status);
      await Promise.all(Array.from({ length: 108 }, (_, idx) => fetch(`/fast-ok?n=${idx}`)));
      return await slowPromise;
    });
    assert.equal(slowStatus, 502);
    await page.waitForTimeout(100);

    const diag = await manager.getDiagnostics(tabId, { statusFilter: 'all' });
    assert.ok(
      diag.networkErrors.some((r) => r.url.includes('/slow-error') && r.status === 502),
      `Expected 502 /slow-error in networkErrors after ring-buffer churn, got: ${JSON.stringify(diag.networkErrors)}`
    );
  });

  it('R3-12 tabs_batch open with activate:false on an initially empty BrowserManager does not orphan the tab or spawn a duplicate blank tab on getPage()', async () => {
    const isolatedMgr = new BrowserManager({ mode: 'launch', headless: true });
    try {
      const openOut = await isolatedMgr.tabsBatch([
        { action: 'open', url: `${fx.baseUrl}/blank`, activate: false },
      ]);
      // open no longer echoes the tab list (it returns its own tabId); list explicitly.
      const openTabs = (await isolatedMgr.tabsBatch([{ action: 'list' }])).tabs;
      assert.equal(openTabs.length, 1);
      const firstTabId = openOut.results[0].tabId;
      assert.equal(firstTabId, openTabs[0].tabId);

      const got = await isolatedMgr.getPage();
      const allTabs = await isolatedMgr.listTabs();
      assert.equal(got.tabId, firstTabId, `getPage() should use the only open tab (${firstTabId}) rather than spawning tab ${got.tabId}`);
      assert.equal(allTabs.length, 1, `Expected 1 tab total, got ${JSON.stringify(allTabs)}`);
    } finally {
      await isolatedMgr.close();
    }
  });

  it('R3-13 createJsonRpcHandler returns -32600 Invalid Request for {}, [{}], non-string method without id, and wrong jsonrpc version while keeping valid notifications silent', async () => {
    const handle = createJsonRpcHandler(manager);

    const emptyObj = await handle({});
    assert.equal(emptyObj?.error?.code, -32600, `Expected -32600 for {}, got ${JSON.stringify(emptyObj)}`);
    assert.equal(emptyObj?.id, null);

    const nonStringMethodNoId = await handle({ jsonrpc: '2.0', method: 1, params: 'bar' });
    assert.equal(
      nonStringMethodNoId?.error?.code,
      -32600,
      `Expected -32600 for {"jsonrpc":"2.0","method":1}, got ${JSON.stringify(nonStringMethodNoId)}`
    );

    const wrongVersion = await handle({ jsonrpc: '1.0', id: 9, method: 'ping' });
    assert.equal(
      wrongVersion?.error?.code,
      -32600,
      `Expected -32600 for jsonrpc:"1.0", got ${JSON.stringify(wrongVersion)}`
    );

    const invalidBatch = await handle([{}, { jsonrpc: '2.0', method: 'notifications/initialized' }]);
    assert.ok(Array.isArray(invalidBatch) && invalidBatch.length === 1, `Expected 1 error in batch reply, got ${JSON.stringify(invalidBatch)}`);
    assert.equal(invalidBatch[0]?.error?.code, -32600);

    const validNotif = await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(validNotif, null);
  });

  it('R3-14 stdio server replies -32600 to {} instead of hanging silently, and still answers subsequent ping', async () => {
    const child = spawn(process.execPath, [INDEX_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    const replies = [];
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) replies.push(JSON.parse(line));
      }
    });

    try {
      child.stdin.write('{}\n');
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 88, method: 'ping' })}\n`);
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !replies.some((r) => r && r.id === 88)) {
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.equal(replies.length, 2, `Expected 2 replies ({} error + ping), got ${JSON.stringify(replies)}`);
      assert.equal(replies[0]?.error?.code, -32600);
      assert.deepEqual(replies[1], { jsonrpc: '2.0', id: 88, result: {} });
    } finally {
      child.kill();
    }
  });

  it('R3-15 blocks inline-split labels (<u>S</u>end, <span>De</span><span>lete</span>) and visibility:hidden aria-labelledby while allowing safe <u>S</u>ign in', async () => {
    fx.resetHits();
    fx.setPage(
      '/inline-split-labels',
      `<button id="u-send" type="button" style="width:80px;height:36px" onclick="${postHit('u-send')}"><u>S</u>end</button>
       <button id="span-del" type="button" style="width:80px;height:36px" onclick="${postHit('span-del')}"><span>De</span><span>lete</span></button>
       <span id="vh-lbl" style="visibility:hidden"><span>Publish</span></span>
       <button id="vh-btn" type="button" aria-labelledby="vh-lbl" style="width:80px;height:36px" onclick="${postHit('vh-btn')}">
         <svg width="14" height="14"><path d="M0 0h10v10z"/></svg>
       </button>
       <form onsubmit="window.__safeSplitLogin = (window.__safeSplitLogin || 0) + 1; return false;">
         <button id="u-signin" type="submit" style="width:80px;height:36px"><u>S</u>ign in</button>
       </form>`
    );

    await page.goto(`${fx.baseUrl}/inline-split-labels`, { waitUntil: 'load' });

    const rSend = await actFast(page, { action: 'click', selector: '#u-send', allowSubmit: false });
    assert.equal(await waitHits('u-send', 150), 0, `<u>S</u>end bypassed Submit guard: ${JSON.stringify(rSend)}`);
    assert.equal(rSend.blocked, true);

    const rDel = await actFast(page, { action: 'click', selector: '#span-del', allowSubmit: false });
    assert.equal(await waitHits('span-del', 150), 0, `<span>De</span><span>lete</span> bypassed Submit guard: ${JSON.stringify(rDel)}`);
    assert.equal(rDel.blocked, true);

    const rPressSend = await actFast(page, { action: 'press', selector: '#u-send', key: 'Enter', allowSubmit: false });
    assert.equal(await waitHits('u-send', 150), 0, `Enter on <u>S</u>end bypassed Submit guard: ${JSON.stringify(rPressSend)}`);
    assert.equal(rPressSend.blocked, true);

    const rVh = await actFast(page, { action: 'click', selector: '#vh-btn', allowSubmit: false });
    assert.equal(await waitHits('vh-btn', 150), 0, `visibility:hidden aria-labelledby bypassed Submit guard: ${JSON.stringify(rVh)}`);
    assert.equal(rVh.blocked, true);

    const rSafe = await actFast(page, { action: 'click', selector: '#u-signin', allowSubmit: false });
    assert.equal(rSafe.ok, true, `Safe <u>S</u>ign in submit button was falsely blocked: ${JSON.stringify(rSafe)}`);
    assert.equal(await page.evaluate(() => window.__safeSplitLogin || 0), 1);
  });

  it('R3-16 smart_fill_form stops form submit handlers even when a type-less <button role="switch|combobox"> calls event.stopPropagation() on click', async () => {
    fx.resetHits();
    fx.setPage(
      '/stop-propagation-submit',
      `<form id="sp-form">
         <button id="sp-sw" role="switch" aria-checked="false" aria-label="Push alerts" style="width:80px;height:32px">Off</button>
         <button id="sp-cb" role="combobox" aria-label="Plan tier" aria-expanded="false" style="width:140px;height:32px">Select...</button>
         <div id="sp-lb" role="listbox" hidden>
           <button id="sp-opt" role="option" style="display:block;width:120px;height:28px">Enterprise</button>
         </div>
       </form>
       <script>
         document.getElementById('sp-form').addEventListener('submit', (ev) => {
           ev.preventDefault();
           fetch('/submit?k=sp-form', { method: 'POST' });
         });
         document.getElementById('sp-sw').addEventListener('click', (ev) => {
           if (ev.defaultPrevented) return;
           ev.stopPropagation();
           const next = ev.currentTarget.getAttribute('aria-checked') !== 'true';
           ev.currentTarget.setAttribute('aria-checked', String(next));
         });
         document.getElementById('sp-cb').addEventListener('click', (ev) => {
           if (ev.defaultPrevented) return;
           ev.stopPropagation();
           const lb = document.getElementById('sp-lb');
           lb.hidden = !lb.hidden;
         });
         document.getElementById('sp-opt').addEventListener('click', (ev) => {
           if (ev.defaultPrevented) return;
           ev.stopPropagation();
           const cb = document.getElementById('sp-cb');
           cb.textContent = 'Enterprise';
           cb.setAttribute('data-value', 'Enterprise');
           document.getElementById('sp-lb').hidden = true;
         });
       </script>`
    );

    await page.goto(`${fx.baseUrl}/stop-propagation-submit`, { waitUntil: 'load' });
    await smartFillForm(page, {
      fields: [
        { keys: 'Push alerts', value: true },
        { keys: 'Plan tier', value: 'Enterprise' },
      ],
    });

    assert.equal(await waitHits('sp-form', 200), 0, 'Form submit listener must NOT fire when widget click stops propagation');
    const state = await page.evaluate(() => ({
      sw: document.getElementById('sp-sw').getAttribute('aria-checked'),
      cb: document.getElementById('sp-cb').getAttribute('data-value'),
    }));
    assert.equal(state.sw, 'true');
    assert.equal(state.cb, 'Enterprise');
  });

  it('R3-17 blocks newline type targeting <label for="..."> linked to an external <input> in <form>', async () => {
    fx.resetHits();
    fx.setPage(
      '/label-for-newline-type',
      `<form action="/submit?k=lbl-for-type" method="post">
         <label id="lbl-ext" for="ext-input" style="display:inline-block;width:90px;height:30px">Search</label>
         <input id="ext-input" name="q" type="text">
         <button type="submit">Submit</button>
       </form>`
    );

    await page.goto(`${fx.baseUrl}/label-for-newline-type`, { waitUntil: 'load' });
    const res = await actFast(page, {
      action: 'type',
      selector: '#lbl-ext',
      value: 'hello\n',
      allowSubmit: false,
    });
    assert.equal(await waitHits('lbl-for-type', 150), 0, `Newline type on <label for> submitted form: ${JSON.stringify(res)}`);
    assert.equal(res.blocked, true);
  });

  it('R3-18 intermediate inspect_compact with includeFrames:false and query/selector preserves child-frame baseline refs for subsequent onlyChanged', async () => {
    fx.setPage('/child-keep-ref', '<button id="c-keep-btn" type="button">ChildKeep</button>');
    fx.setPage(
      '/parent-keep-ref',
      `<div id="m-keep"><button id="m-keep-1" type="button">MainKeep1</button></div>
       <iframe src="/child-keep-ref" style="width:240px;height:70px"></iframe>`
    );

    await page.goto(`${fx.baseUrl}/parent-keep-ref`, { waitUntil: 'load' });
    const snapState = new Set();

    const base = await inspectCompact(page, { mode: 'interactive', includeFrames: true }, snapState);
    const f1FullRef = /\[(f1:e\d+)\] <button> "ChildKeep"/.exec(base.text)?.[1];
    const f1BareRef = f1FullRef?.split(':')[1];
    assert.ok(f1FullRef && f1BareRef, `Missing ChildKeep in baseline: ${base.text}`);

    // Scoped main-frame query must NOT wipe child-frame refs while leaving snapState untouched
    await inspectCompact(page, { mode: 'interactive', includeFrames: false, query: 'MainKeep1' }, snapState);

    await page.evaluate(() => {
      const b = document.createElement('button');
      b.id = 'm-keep-2';
      b.type = 'button';
      b.textContent = 'MainKeep2';
      document.getElementById('m-keep').appendChild(b);
    });

    const delta = await inspectCompact(page, { mode: 'interactive', includeFrames: true, onlyChanged: true }, snapState);
    assert.match(delta.text, /MainKeep2/);
    assert.ok(!delta.text.includes('ChildKeep'), 'Unchanged ChildKeep is omitted from delta');

    const byFull = await evaluateJs(page, { ref: f1FullRef, expression: 'el.id' });
    assert.equal(byFull.result, 'c-keep-btn');
    const byBare = await evaluateJs(page, { ref: f1BareRef, expression: 'el.id' });
    assert.equal(byBare.result, 'c-keep-btn');
  });

  it('R3-19 createJsonRpcHandler returns -32600 Invalid Request when jsonrpc:"2.0" is missing even if id is provided', async () => {
    const handle = createJsonRpcHandler(manager);
    const missingVersion = await handle({ id: 42, method: 'ping' });
    assert.equal(
      missingVersion?.error?.code,
      -32600,
      `Expected -32600 for missing jsonrpc field, got ${JSON.stringify(missingVersion)}`
    );
    assert.equal(missingVersion?.id, 42);
  });
});
