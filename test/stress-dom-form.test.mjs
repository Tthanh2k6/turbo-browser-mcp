import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import { BrowserManager } from '../src/browser-manager.mjs';
import {
  actFast,
  batchActions,
  evaluateJs,
  extractCleanText,
  inspectCompact,
  smartFillForm,
} from '../src/dom-engine.mjs';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+fX0AAAAASUVORK5CYII=',
  'base64'
);

// 1. Deeply nested iframes (2+ levels) + deeply nested open Shadow DOM (shadow inside shadow)
const DEEP_MAIN_HTML = `<!doctype html>
<html>
<head><title>Deep Nesting Stress</title></head>
<body>
  <main>
    <h1>Root Document Header</h1>
    <outer-shadow id="outer-host" aria-label="Outer Shadow Group"></outer-shadow>
    <iframe id="frame-lvl1" src="/iframe-lvl1" style="width:520px;height:260px;border:1px solid #333;"></iframe>
  </main>
  <script>
    window.__deepShadowClicked = 0;
    class InnerShadow extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = \`
          <div class="field">
            <label for="deep-input">Deep Shadow Input</label>
            <input id="deep-input" type="text" aria-label="Deep Shadow Input" />
          </div>
          <div class="field">
            <label for="deep-select">Deep Shadow Select</label>
            <select id="deep-select" aria-label="Deep Shadow Select">
              <option value="">--choose--</option>
              <option value="alpha">Alpha Tier</option>
              <option value="omega">Omega Tier</option>
            </select>
          </div>
          <article>
            <h3>Deep Inner Shadow Heading</h3>
            <p>Deep inner shadow paragraph content.</p>
          </article>
          <button id="deep-shadow-btn" type="button">Trigger Deep Shadow</button>
        \`;
        root.getElementById('deep-shadow-btn').addEventListener('click', () => {
          window.__deepShadowClicked++;
        });
      }
    }
    customElements.define('inner-shadow', InnerShadow);

    class OuterShadow extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = \`
          <section class="field">
            <h2>Outer Shadow Wrapper</h2>
            <inner-shadow id="inner-host"></inner-shadow>
          </section>
        \`;
      }
    }
    customElements.define('outer-shadow', OuterShadow);
  </script>
</body>
</html>`;

const IFRAME_LVL1_HTML = `<!doctype html>
<html>
<body>
  <div class="field">
    <label for="lvl1-input">Level 1 Frame Input</label>
    <input id="lvl1-input" type="text" aria-label="Level 1 Frame Input" />
  </div>
  <p>Level 1 iframe paragraph text.</p>
  <iframe id="frame-lvl2" src="/iframe-lvl2" style="width:460px;height:160px;border:1px solid #666;"></iframe>
</body>
</html>`;

const IFRAME_LVL2_HTML = `<!doctype html>
<html>
<body>
  <div class="field">
    <label for="lvl2-input">Level 2 Frame Input</label>
    <input id="lvl2-input" type="text" aria-label="Level 2 Frame Input" />
  </div>
  <lvl2-shadow></lvl2-shadow>
  <button id="lvl2-btn" type="button" onclick="window.__lvl2Clicked = (window.__lvl2Clicked || 0) + 1;">Level 2 Action</button>
  <p>Level 2 deeply nested iframe text.</p>
  <script>
    window.__lvl2Clicked = 0;
    class Lvl2Shadow extends HTMLElement {
      constructor() {
        super();
        const s1 = this.attachShadow({ mode: 'open' });
        const innerHost = document.createElement('div');
        s1.appendChild(innerHost);
        const s2 = innerHost.attachShadow({ mode: 'open' });
        s2.innerHTML = \`
          <div class="field">
            <input id="lvl2-shadow-input" type="text" aria-label="Level 2 Shadow Input" />
          </div>
          <p>Level 2 shadow-inside-shadow note.</p>
        \`;
      }
    }
    customElements.define('lvl2-shadow', Lvl2Shadow);
  </script>
</body>
</html>`;

// 2. Readonly / disabled inputs and display:none / aria-hidden controls
const READONLY_DISABLED_HIDDEN_HTML = `<!doctype html>
<html>
<head><title>Readonly Disabled Hidden Guards</title></head>
<body>
  <form id="guard-form">
    <div class="field">
      <label for="ro-input">Customer Code</label>
      <input id="ro-input" type="text" readonly value="RO_LOCKED_1" aria-label="Customer Code" />
    </div>
    <div class="field">
      <label for="ro-textarea">Audit Trail</label>
      <textarea id="ro-textarea" readonly aria-label="Audit Trail">RO_TEXTAREA_LOCKED</textarea>
    </div>
    <div class="field">
      <label for="aria-ro-ce">Readonly Rich Box</label>
      <div id="aria-ro-ce" contenteditable="true" role="textbox" aria-readonly="true" aria-label="Readonly Rich Box" style="width:200px;height:40px;border:1px solid #ccc;">RO_CE_LOCKED</div>
    </div>
    <div class="field">
      <label for="dis-input">Disabled Input Field</label>
      <input id="dis-input" type="text" disabled value="DIS_LOCKED_1" aria-label="Disabled Input Field" />
    </div>
    <div class="field">
      <label for="aria-dis-input">Aria Disabled Field</label>
      <input id="aria-dis-input" type="text" aria-disabled="true" value="ARIA_DIS_LOCKED" aria-label="Aria Disabled Field" />
    </div>
    <div class="field">
      <label for="dis-select">Disabled Select</label>
      <select id="dis-select" disabled aria-label="Disabled Select">
        <option value="keep" selected>Keep Default</option>
        <option value="change">Should Not Select</option>
      </select>
    </div>
    <div class="field">
      <input id="disp-none-input" type="text" style="display:none" value="DISP_NONE_LOCKED" aria-label="Display None Input" />
    </div>
    <div style="display:none">
      <input id="parent-disp-none-input" type="text" value="PARENT_DISP_NONE_LOCKED" aria-label="Parent Display None Input" />
      <div role="listitem" class="question">
        <div>Hidden Question Group</div>
        <label><input id="parent-disp-none-cb" type="checkbox" value="hidden-opt" /> Hidden Option</label>
      </div>
    </div>
    <div aria-hidden="true">
      <input id="aria-hidden-ancestor-input" type="text" value="ARIA_HIDDEN_ANCESTOR" aria-label="Aria Hidden Ancestor Input" />
      <button id="aria-hidden-btn" type="button">Ghost Aria Hidden Button</button>
      <div role="listitem" class="question">
        <div>Aria Hidden Question</div>
        <label><input id="aria-hidden-cb" type="checkbox" value="ghost" /> Ghost Option</label>
      </div>
    </div>
    <input id="aria-hidden-self-input" type="text" aria-hidden="true" value="ARIA_HIDDEN_SELF" aria-label="Aria Hidden Self Input" />

    <div role="listitem" class="question">
      <div>Subscription Tier</div>
      <label><input id="dis-radio" type="radio" name="tier" value="enterprise" disabled /> Enterprise Disabled</label>
      <label><input id="aria-dis-cb" type="checkbox" name="addon" value="vip" aria-disabled="true" /> VIP Addon Aria Disabled</label>
      <label><input id="valid-radio" type="radio" name="tier" value="starter" /> Starter Active</label>
    </div>

    <div class="field">
      <label for="valid-editable">Active Bio</label>
      <input id="valid-editable" type="text" value="Initial Bio" aria-label="Active Bio" />
    </div>
  </form>
</body>
</html>`;

// 3. Dynamic SPA re-render mid-batch
const SPA_RERENDER_HTML = `<!doctype html>
<html>
<head><title>Dynamic SPA Re-render</title></head>
<body>
  <div id="spa-root">
    <button id="step1-trigger" type="button">Mount Step 2</button>
    <input id="ephemeral-input" type="text" aria-label="Step Input" value="" />
  </div>
  <script>
    window.__spaRenderCount = 0;
    window.__spaFinished = false;
    window.__spaFinalText = '';

    document.getElementById('step1-trigger').addEventListener('click', () => {
      window.__spaRenderCount++;
      const root = document.getElementById('spa-root');
      // Full DOM replacement wiping all previous nodes and data-tbm-ref attributes
      root.innerHTML = \`
        <div class="spa-step-2">
          <input id="ephemeral-input" type="text" aria-label="Step Input" placeholder="Recreated Input" />
          <button id="finish-spa-btn" type="button">Complete Wizard</button>
        </div>
      \`;
      document.getElementById('finish-spa-btn').addEventListener('click', () => {
        window.__spaFinished = true;
        window.__spaFinalText = document.getElementById('ephemeral-input').value;
      });
    });
  </script>
</body>
</html>`;

// 4. Complex Markdown scraping
const COMPLEX_MARKDOWN_HTML = `<!doctype html>
<html>
<head><title>Complex Markdown Document</title></head>
<body>
  <nav>Ignore top nav links</nav>
  <main>
    <article id="doc-article">
      <h1>Security Architecture Report</h1>
      <p>Intro paragraph with <strong>bold</strong>, <em>italic</em>, and a <a href="https://example.com/rls">RLS Guide</a>.</p>
      <table id="audit-matrix">
        <thead>
          <tr><th>Control</th><th>Status</th><th>Details</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><p><strong>Row Level</strong><br><span>Security</span></p></td>
            <td></td>
            <td>See <a href="https://example.com/policy">Policy Spec</a> for <code>auth.uid()</code></td>
          </tr>
          <tr>
            <td>Service Key</td>
            <td><code>LOCKED</code></td>
            <td>   \n   </td>
          </tr>
        </tbody>
      </table>
      <blockquote>
        <p>Never expose <code>service_role</code> keys in client-side bundles or public repos.</p>
      </blockquote>
      <pre><code>const query = "SELECT * FROM accounts WHERE owner_id = $1 &amp;&amp; deleted_at IS NULL;";
console.log(\`Running: \${query}\`);</code></pre>
      <ul>
        <li>Layer 1 Network
          <ul>
            <li>Layer 2 API Gateway
              <ol>
                <li>Layer 3 JWT Verification</li>
                <li>Layer 3 Rate Limiter</li>
              </ol>
            </li>
            <li>Layer 2 WAF Rules</li>
          </ul>
        </li>
        <li>Layer 1 Database</li>
      </ul>
      <div style="display:none">HIDDEN_NOISE_MUST_NOT_LEAK</div>
    </article>
  </main>
</body>
</html>`;

// 5. Submit guard bypass stress tests
const SUBMIT_STRESS_HTML = `<!doctype html>
<html>
<head><title>Submit Guard Bypass Stress</title></head>
<body style="margin:0;padding:16px;">
  <form id="myform" onsubmit="event.preventDefault(); window.__submitHits = (window.__submitHits || 0) + 1;">
    <input id="inside-input" type="text" aria-label="Inside Form Input" value="hello" />
    <input id="img-submit" type="image" alt="Submit" src="/pixel.png" width="48" height="24" onclick="window.__submitHits = (window.__submitHits || 0) + 1;" />
    <button id="svg-pay-btn" type="submit" style="width:120px;height:36px;">
      <svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6"></circle></svg>
      <span id="svg-pay-span">Pay</span>
    </button>
    <button id="safe-continue-btn" type="button" onclick="window.__safeHits = (window.__safeHits || 0) + 1;">Continue</button>
  </form>

  <!-- Detached controls outside #myform associated via form="myform" -->
  <div id="detached-zone" style="margin-top:16px;">
    <input id="detached-input" form="myform" type="text" aria-label="Detached Form Input" value="detached-val" />
    <button id="detached-submit-btn" form="myform" type="submit">Submit</button>
    <button id="detached-implicit-btn" form="myform">Save &amp; Finish</button>
  </div>

  <!-- Vietnamese diacritics & variants -->
  <div id="vn-zone" style="margin-top:16px;">
    <button id="vn-gui-ngay" type="button" onclick="window.__submitHits = (window.__submitHits || 0) + 1;">Gửi ngay</button>
    <button id="vn-thanh-toan" type="button" onclick="window.__submitHits = (window.__submitHits || 0) + 1;">Thanh toán</button>
    <button id="vn-dang" type="button" onclick="window.__submitHits = (window.__submitHits || 0) + 1;">Đăng</button>
  </div>

  <script>
    window.__submitHits = 0;
    window.__safeHits = 0;
  </script>
</body>
</html>`;

function startStressServer() {
  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    const routes = {
      '/deep': DEEP_MAIN_HTML,
      '/iframe-lvl1': IFRAME_LVL1_HTML,
      '/iframe-lvl2': IFRAME_LVL2_HTML,
      '/guards': READONLY_DISABLED_HIDDEN_HTML,
      '/spa': SPA_RERENDER_HTML,
      '/markdown': COMPLEX_MARKDOWN_HTML,
      '/submit-stress': SUBMIT_STRESS_HTML,
    };
    if (urlPath === '/pixel.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(TINY_PNG);
      return;
    }
    if (routes[urlPath]) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(routes[urlPath]);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe('DOM & Form Engine Stress Suite (stress-dom-form)', () => {
  let server;
  let baseUrl;
  let manager;

  before(async () => {
    ({ server, baseUrl } = await startStressServer());
    manager = new BrowserManager({ mode: 'launch', headless: true });
  });

  after(async () => {
    await manager?.close();
    await new Promise((resolve) => server?.close(resolve));
  });

  it('1. pierces 2+ level nested iframes and nested open Shadow DOM (shadow inside shadow) across inspectCompact, smartFillForm, actFast, and extractCleanText', async () => {
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/deep` }]);
    const { page } = await manager.getPage();

    const snap = await inspectCompact(page, { mode: 'interactive', maxChars: 4000 });
    assert.equal(snap.framesScanned, 3, 'should scan main frame + lvl1 iframe + lvl2 iframe');
    assert.ok(snap.text.includes('"Deep Shadow Input" [shadow]'), 'should find input inside 2-level open Shadow DOM');
    assert.ok(snap.text.includes('"Level 1 Frame Input"'), 'should find input inside level-1 iframe');
    assert.ok(snap.text.includes('"Level 2 Frame Input"'), 'should find input inside level-2 iframe');
    assert.ok(snap.text.includes('"Level 2 Shadow Input" [shadow]'), 'should find input inside 2-level Shadow DOM inside level-2 iframe');

    const fillRes = await smartFillForm(page, {
      fields: [
        { keys: ['deep shadow input'], value: 'ShadowValue99' },
        { keys: ['deep shadow select'], value: 'Omega Tier' },
        { keys: ['level 1 frame input'], value: 'Frame1Val' },
        { keys: ['level 2 frame input'], value: 'Frame2Val' },
        { keys: ['level 2 shadow input'], value: 'Frame2ShadowVal' },
      ],
    });
    assert.equal(fillRes.filledCount, 5, 'should fill all 5 controls across nested shadow roots and 2-level iframes');

    const refreshed = await inspectCompact(page, { mode: 'interactive', maxChars: 4000 });
    const lvl2BtnMatch = /\[(f2:e\d+)\]\s+<button>\s+"Level 2 Action"/.exec(refreshed.text);
    assert.ok(lvl2BtnMatch, 'should assign ref to button in level-2 iframe');

    const clickShadow = await actFast(page, { action: 'click', selector: '#deep-shadow-btn' });
    assert.equal(clickShadow.ok, true);

    const clickLvl2 = await actFast(page, { action: 'click', ref: lvl2BtnMatch[1] });
    assert.equal(clickLvl2.ok, true);
    assert.equal(clickLvl2.frameIdx, 2);

    const mainState = await evaluateJs(page, {
      expression: `() => {
        const inner = document.getElementById('outer-host').shadowRoot.getElementById('inner-host').shadowRoot;
        return {
          input: inner.getElementById('deep-input').value,
          select: inner.getElementById('deep-select').value,
          clicked: window.__deepShadowClicked,
        };
      }`,
    });
    assert.deepEqual(mainState.result, {
      input: 'ShadowValue99',
      select: 'omega',
      clicked: 1,
    });

    const lvl2State = await evaluateJs(page, {
      frameIdx: 2,
      expression: `() => {
        const host = document.querySelector('lvl2-shadow');
        const s2 = host.shadowRoot.firstElementChild.shadowRoot;
        return {
          lvl2Input: document.getElementById('lvl2-input').value,
          lvl2ShadowInput: s2.getElementById('lvl2-shadow-input').value,
          lvl2Clicked: window.__lvl2Clicked,
        };
      }`,
    });
    assert.deepEqual(lvl2State.result, {
      lvl2Input: 'Frame2Val',
      lvl2ShadowInput: 'Frame2ShadowVal',
      lvl2Clicked: 1,
    });

    const cleanMd = await extractCleanText(page, { format: 'markdown', maxChars: 4000 });
    assert.ok(cleanMd.text.includes('### Deep Inner Shadow Heading'), 'markdown should include heading from 2-level Shadow DOM');
    assert.ok(cleanMd.text.includes('Deep inner shadow paragraph content.'), 'markdown should include paragraph from 2-level Shadow DOM');
    assert.ok(cleanMd.text.includes('[iframe f1]'), 'markdown should include level-1 iframe section');
    assert.ok(cleanMd.text.includes('[iframe f2]'), 'markdown should include level-2 iframe section');
    assert.ok(cleanMd.text.includes('Level 2 shadow-inside-shadow note.'), 'markdown should include shadow-inside-shadow text from level-2 iframe');
  });

  it('2a. inspectCompact excludes display:none and aria-hidden controls from interactive snapshot', async () => {
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/guards` }]);
    const { page } = await manager.getPage();

    const snap = await inspectCompact(page, { mode: 'interactive', maxChars: 4000 });
    assert.ok(!snap.text.includes('Display None Input'), 'display:none input must not be shown');
    assert.ok(!snap.text.includes('Parent Display None Input'), 'input inside display:none parent must not be shown');
    assert.ok(!snap.text.includes('Aria Hidden Ancestor Input'), 'input inside aria-hidden=true container must not be shown');
    assert.ok(!snap.text.includes('Ghost Aria Hidden Button'), 'button inside aria-hidden=true container must not be shown');
    assert.ok(!snap.text.includes('Aria Hidden Self Input'), 'input with aria-hidden=true must not be shown');
  });

  it('2b. smartFillForm never overwrites or falsely counts readonly, disabled, aria-disabled, display:none, or aria-hidden controls', async () => {
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/guards` }]);
    const { page } = await manager.getPage();

    const fillRes = await smartFillForm(page, {
      overwrite: true,
      fields: [
        { keys: ['customer code'], value: 'HACKED_RO' },
        { keys: ['audit trail'], value: 'HACKED_TA' },
        { keys: ['readonly rich box'], value: 'HACKED_CE' },
        { keys: ['disabled input field'], value: 'HACKED_DIS' },
        { keys: ['aria disabled field'], value: 'HACKED_ARIA_DIS' },
        { keys: ['disabled select'], value: 'Should Not Select' },
        { keys: ['display none input'], value: 'HACKED_DISP_NONE' },
        { keys: ['parent display none input'], value: 'HACKED_PARENT_NONE' },
        { keys: ['hidden question group'], check: ['Hidden Option'] },
        { keys: ['aria hidden ancestor input'], value: 'HACKED_ARIA_ANCESTOR' },
        { keys: ['aria hidden self input'], value: 'HACKED_ARIA_SELF' },
        { keys: ['aria hidden question'], check: ['Ghost Option'] },
        { keys: ['subscription tier'], check: ['Enterprise Disabled', 'VIP Addon Aria Disabled', 'Starter Active'] },
        { keys: ['active bio'], value: 'Updated Clean Bio' },
      ],
    });

    assert.equal(
      fillRes.filledCount,
      2,
      `Expected only 2 active controls (Starter Active + Active Bio) to be filled, got ${fillRes.filledCount}: ${JSON.stringify(fillRes.filled)}`
    );

    const domState = await evaluateJs(page, {
      expression: `() => ({
        roInput: document.getElementById('ro-input').value,
        roTextarea: document.getElementById('ro-textarea').value,
        ariaRoCe: document.getElementById('aria-ro-ce').innerText.trim(),
        disInput: document.getElementById('dis-input').value,
        ariaDisInput: document.getElementById('aria-dis-input').value,
        disSelect: document.getElementById('dis-select').value,
        dispNone: document.getElementById('disp-none-input').value,
        parentDispNone: document.getElementById('parent-disp-none-input').value,
        parentDispNoneCb: document.getElementById('parent-disp-none-cb').checked,
        ariaHiddenAncestor: document.getElementById('aria-hidden-ancestor-input').value,
        ariaHiddenSelf: document.getElementById('aria-hidden-self-input').value,
        ariaHiddenCb: document.getElementById('aria-hidden-cb').checked,
        disRadio: document.getElementById('dis-radio').checked,
        ariaDisCb: document.getElementById('aria-dis-cb').checked,
        validRadio: document.getElementById('valid-radio').checked,
        validEditable: document.getElementById('valid-editable').value,
      })`,
    });

    assert.deepEqual(domState.result, {
      roInput: 'RO_LOCKED_1',
      roTextarea: 'RO_TEXTAREA_LOCKED',
      ariaRoCe: 'RO_CE_LOCKED',
      disInput: 'DIS_LOCKED_1',
      ariaDisInput: 'ARIA_DIS_LOCKED',
      disSelect: 'keep',
      dispNone: 'DISP_NONE_LOCKED',
      parentDispNone: 'PARENT_DISP_NONE_LOCKED',
      parentDispNoneCb: false,
      ariaHiddenAncestor: 'ARIA_HIDDEN_ANCESTOR',
      ariaHiddenSelf: 'ARIA_HIDDEN_SELF',
      ariaHiddenCb: false,
      disRadio: false,
      ariaDisCb: false,
      validRadio: true,
      validEditable: 'Updated Clean Bio',
    });
  });

  it('3. handles dynamic SPA DOM replacement mid-batch with clear stale-ref error and selector/snapshot recovery', async () => {
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/spa` }]);
    const { page } = await manager.getPage();

    const initialSnap = await inspectCompact(page, { mode: 'interactive' });
    const triggerRef = /\[(f0:e\d+)\]\s+<button>\s+"Mount Step 2"/.exec(initialSnap.text)?.[1];
    const oldInputRef = /\[(f0:e\d+)\]\s+<input:text>\s+"Step Input"/.exec(initialSnap.text)?.[1];
    assert.ok(triggerRef && oldInputRef, 'should capture initial refs before SPA re-render');

    // Case A: default continueOnError=false halts with clear stale-ref message when DOM was replaced
    const haltBatch = await batchActions(page, [
      { action: 'click', ref: triggerRef },
      { action: 'fill', ref: oldInputRef, value: 'Stale Attempt' },
      { action: 'click', selector: '#finish-spa-btn' },
    ]);
    assert.equal(haltBatch.completed, 1, 'should complete step 0 and fail at step 1');
    assert.ok(
      haltBatch.error && haltBatch.error.includes(`Element ref "${oldInputRef}" not found`) && haltBatch.error.includes('inspect_compact'),
      `Expected explicit stale ref error, got: ${haltBatch.error}`
    );

    // Case B: continueOnError=true + selector fallback + returnSnapshot refreshes refs cleanly
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/spa` }]);
    const { page: page2 } = await manager.getPage();
    const snap2 = await inspectCompact(page2, { mode: 'interactive' });
    const triggerRef2 = /\[(f0:e\d+)\]\s+<button>\s+"Mount Step 2"/.exec(snap2.text)?.[1];
    const staleRef2 = /\[(f0:e\d+)\]\s+<input:text>\s+"Step Input"/.exec(snap2.text)?.[1];

    const recoverBatch = await batchActions(
      page2,
      [
        { action: 'click', ref: triggerRef2 },
        { action: 'fill', ref: staleRef2, value: 'Should Fail On Stale Node' },
        { action: 'fill', selector: '#ephemeral-input', value: 'Recovered After Rerender' },
        { action: 'click', text: 'Complete Wizard' },
      ],
      { continueOnError: true, returnSnapshot: true }
    );

    assert.equal(recoverBatch.completed, 4);
    assert.equal(recoverBatch.results[0].ok, true);
    assert.equal(recoverBatch.results[1].ok, false);
    assert.ok(recoverBatch.results[1].error.includes('inspect_compact'));
    assert.equal(recoverBatch.results[2].ok, true);
    assert.equal(recoverBatch.results[3].ok, true);
    assert.ok(recoverBatch.snapshot.includes('"Complete Wizard"'), 'post-batch snapshot should contain fresh refs for new SPA DOM');

    const spaState = await evaluateJs(page2, {
      expression: '({ finished: window.__spaFinished, text: window.__spaFinalText, renders: window.__spaRenderCount })',
    });
    assert.deepEqual(spaState.result, {
      finished: true,
      text: 'Recovered After Rerender',
      renders: 1,
    });
  });

  it('4. scrapes complex Markdown (multiline/inline tables, empty cells, blockquote, pre code with special chars, 3-level nested lists) and respects maxChars=200 boundary', async () => {
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/markdown` }]);
    const { page } = await manager.getPage();

    const md = await extractCleanText(page, { format: 'markdown', maxChars: 6000 });
    assert.ok(md.text.includes('# Security Architecture Report'));
    assert.ok(md.text.includes('[RLS Guide](https://example.com/rls)'));
    assert.ok(md.text.includes('| Control | Status | Details |'));
    assert.ok(md.text.includes('| --- | --- | --- |'));
    assert.ok(
      md.text.includes('| Row Level Security |  | See [Policy Spec](https://example.com/policy) for auth.uid() |'),
      `Table row with multiline <br> + empty cell + inline link/code should preserve space across <br>, got:\n${md.text}`
    );
    assert.ok(md.text.includes('| Service Key | LOCKED |  |'));
    assert.ok(md.text.includes('> Never expose service_role keys in client-side bundles or public repos.'));
    assert.ok(md.text.includes('```\nconst query = "SELECT * FROM accounts WHERE owner_id = $1 && deleted_at IS NULL;";\nconsole.log(`Running: ${query}`);\n```'));
    assert.ok(md.text.includes('- Layer 1 Network\n  - Layer 2 API Gateway\n    - Layer 3 JWT Verification\n    - Layer 3 Rate Limiter\n  - Layer 2 WAF Rules\n- Layer 1 Database'));
    assert.ok(!md.text.includes('HIDDEN_NOISE_MUST_NOT_LEAK'));

    // Tiny maxChars=200 boundary
    const tinyExtract = await extractCleanText(page, { format: 'markdown', maxChars: 200 });
    assert.equal(tinyExtract.truncated, true);
    assert.ok(tinyExtract.charCount <= 200, `Expected extractCleanText charCount <= 200, got ${tinyExtract.charCount}`);
    assert.ok(tinyExtract.text.endsWith('... [truncated]'));

    const tinyInspect = await inspectCompact(page, { mode: 'article', maxChars: 200 });
    assert.equal(tinyInspect.truncated, true);
    assert.ok(tinyInspect.charCount <= 200, `Expected inspectCompact charCount <= 200, got ${tinyInspect.charCount}`);
  });

  it('5a. Submit guard blocks <input type="image" alt="Submit"> via selector and coordinate click when allowSubmit=false', async () => {
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/submit-stress` }]);
    const { page } = await manager.getPage();

    const imgClick = await actFast(page, { action: 'click', selector: '#img-submit', allowSubmit: false });
    assert.equal(imgClick.blocked, true, 'input[type="image" alt="Submit"] selector click must be blocked');

    const imgBox = await evaluateJs(page, {
      selector: '#img-submit',
      expression: '(el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }',
    });
    const imgCoordClick = await actFast(page, {
      action: 'click',
      x: imgBox.result.x,
      y: imgBox.result.y,
      allowSubmit: false,
    });
    assert.equal(imgCoordClick.blocked, true, 'input[type="image"] coordinate click must be blocked');

    const hits = await evaluateJs(page, { expression: 'window.__submitHits' });
    assert.equal(hits.result, 0);
  });

  it('5b. Submit guard blocks <button type="submit"><svg>...</svg><span>Pay</span></button> on both button and child <span>', async () => {
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/submit-stress` }]);
    const { page } = await manager.getPage();

    const svgBtnClick = await actFast(page, { action: 'click', selector: '#svg-pay-btn', allowSubmit: false });
    assert.equal(svgBtnClick.blocked, true, 'button[type="submit"] with nested svg+span must be blocked');

    const innerSpanClick = await actFast(page, { action: 'click', selector: '#svg-pay-span', allowSubmit: false });
    assert.equal(innerSpanClick.blocked, true, 'clicking inner <span>Pay</span> inside button[type="submit"] must be blocked');

    const hits = await evaluateJs(page, { expression: 'window.__submitHits' });
    assert.equal(hits.result, 0);
  });

  it('5c. Submit guard blocks detached <button form="myform"> (explicit type="submit" and default submit type) outside <form id="myform">', async () => {
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/submit-stress` }]);
    const { page } = await manager.getPage();

    const detachedSubmitClick = await actFast(page, {
      action: 'click',
      selector: '#detached-submit-btn',
      allowSubmit: false,
    });
    assert.equal(detachedSubmitClick.blocked, true, 'detached button[form="myform"][type="submit"] must be blocked');

    const detachedImplicitClick = await actFast(page, {
      action: 'click',
      selector: '#detached-implicit-btn',
      allowSubmit: false,
    });
    assert.equal(detachedImplicitClick.blocked, true, 'detached button[form="myform"] (default submit type) must be blocked');

    const hits = await evaluateJs(page, { expression: 'window.__submitHits' });
    assert.equal(hits.result, 0);
  });

  it('5d. Submit guard blocks pressing Enter inside detached <input form="myform"> outside <form id="myform"> and Vietnamese variants ("Gửi ngay", "Thanh toán", "Đăng")', async () => {
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/submit-stress` }]);
    const { page } = await manager.getPage();

    const enterDetachedSelector = await actFast(page, {
      action: 'press',
      selector: '#detached-input',
      key: 'Enter',
      allowSubmit: false,
    });
    assert.equal(enterDetachedSelector.blocked, true, 'pressing Enter on input[form="myform"] via selector must be blocked');

    await actFast(page, { action: 'focus', selector: '#detached-input' });
    const enterDetachedFocused = await actFast(page, {
      action: 'press',
      key: 'Enter',
      allowSubmit: false,
    });
    assert.equal(enterDetachedFocused.blocked, true, 'pressing Enter while focused on input[form="myform"] must be blocked');

    for (const sel of ['#vn-gui-ngay', '#vn-thanh-toan', '#vn-dang']) {
      const vnRes = await actFast(page, { action: 'click', selector: sel, allowSubmit: false });
      assert.equal(vnRes.blocked, true, `Vietnamese submit button ${sel} must be blocked when allowSubmit=false`);
    }

    const hitsBeforeAllow = await evaluateJs(page, { expression: 'window.__submitHits' });
    assert.equal(hitsBeforeAllow.result, 0, 'no submit handler should have fired while allowSubmit=false');

    const safeRes = await actFast(page, { action: 'click', selector: '#safe-continue-btn', allowSubmit: false });
    assert.equal(safeRes.ok, true);

    const allowedRes = await actFast(page, { action: 'click', selector: '#detached-submit-btn', allowSubmit: true });
    assert.equal(allowedRes.ok, true);
    const hitsAfterAllow = await evaluateJs(page, { expression: 'window.__submitHits' });
    assert.equal(hitsAfterAllow.result, 1, 'form should submit once when allowSubmit=true');
  });
});
