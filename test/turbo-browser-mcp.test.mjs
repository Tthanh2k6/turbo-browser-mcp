import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BrowserManager } from '../src/browser-manager.mjs';
import {
  actFast,
  batchActions,
  capturePage,
  evaluateJs,
  extractCleanText,
  inspectCompact,
  smartFillForm,
} from '../src/dom-engine.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRY_PATH = path.resolve(TEST_DIR, '..', 'src', 'index.mjs');

const MAIN_HTML = `<!doctype html>
<html>
<head><title>Job Application Fixture</title></head>
<body>
  <h1>Senior Full-Stack Application</h1>
  <form id="app-form" onsubmit="event.preventDefault(); window.__submitted = (window.__submitted || 0) + 1;">
    <div class="field">
      <label for="full-name">Full Name</label>
      <input id="full-name" name="fullName" type="text" required />
    </div>
    <div class="field">
      <label for="email">Email Address</label>
      <input id="email" name="email" type="email" />
    </div>
    <div class="field">
      <label>Cover Note</label>
      <div id="cover-editor" contenteditable="true" role="textbox" aria-label="Cover Note" style="min-height:90px;width:320px;border:1px solid #999;"></div>
    </div>
    <div class="field">
      <label for="country">Country</label>
      <select id="country" name="country">
        <option value="">-- Select --</option>
        <option value="vn">Vietnam</option>
        <option value="us">United States</option>
      </select>
    </div>
    <div class="field">
      <label id="workmode-lbl">Work Mode</label>
      <div id="workmode-combo" role="combobox" aria-labelledby="workmode-lbl" aria-expanded="false" tabindex="0" style="width:200px;height:28px;border:1px solid #888;">Choose...</div>
      <div id="workmode-list" role="listbox" style="display:none;">
        <div role="option" data-val="remote">Remote Full-Time</div>
        <div role="option" data-val="hybrid">Hybrid</div>
      </div>
    </div>
    <div role="listitem" class="question">
      <div>Can you start immediately?</div>
      <label><input type="radio" name="startNow" value="yes"> Yes, immediately</label>
      <label><input type="radio" name="startNow" value="no"> Next month</label>
    </div>
    <div role="listitem" class="question">
      <div>Primary tech stack (select all that apply)</div>
      <label><input type="checkbox" name="stack" value="react"> React</label>
      <label><input type="checkbox" name="stack" value="node"> Node.js</label>
      <label><input type="checkbox" name="stack" value="go"> Go</label>
    </div>
    <div class="field">
      <label for="resume-file">Resume / CV PDF</label>
      <input id="resume-file" name="resume" type="file" accept=".pdf" style="display:none" />
      <span id="resume-name"></span>
    </div>
    <iframe id="extra-frame" src="/iframe-form" style="width:400px;height:140px;border:1px solid #ccc;"></iframe>
    <div>
      <button id="next-btn" type="button" onclick="window.__nextClicked = (window.__nextClicked || 0) + 1;">Next Step</button>
      <button id="submit-btn" type="submit">Submit Application</button>
      <button id="post-btn" type="button" onclick="window.__vnPosted = true;">Đăng bài</button>
    </div>
  </form>
  <script>
    window.__reactTracked = '';
    window.__submitted = 0;
    window.__nextClicked = 0;
    window.__vnPosted = false;

    // Simulate React controlled input by rejecting direct instance .value assignments
    // while tracking prototype-setter + input events.
    const nameEl = document.getElementById('full-name');
    const nativeDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    Object.defineProperty(nameEl, 'value', {
      configurable: true,
      get() { return nativeDesc.get.call(this); },
      set() { /* Ignored like React if caller does el.value = x instead of prototype setter */ }
    });
    nameEl.addEventListener('input', () => {
      window.__reactTracked = nativeDesc.get.call(nameEl);
    });

    document.getElementById('resume-file').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      document.getElementById('resume-name').textContent = f ? f.name + ':' + f.size : '';
    });

    const combo = document.getElementById('workmode-combo');
    const list = document.getElementById('workmode-list');
    combo.addEventListener('click', () => {
      list.style.display = list.style.display === 'none' ? 'block' : 'none';
    });
    list.querySelectorAll('[role="option"]').forEach((opt) => {
      opt.addEventListener('click', () => {
        window.__workMode = opt.getAttribute('data-val');
        combo.textContent = opt.textContent;
        list.style.display = 'none';
      });
    });
  </script>
</body>
</html>`;

const IFRAME_HTML = `<!doctype html>
<html>
<body>
  <div class="field">
    <label for="emergency">Emergency Contact</label>
    <input id="emergency" name="emergencyContact" type="text" />
  </div>
  <button id="iframe-save" type="button" onclick="window.__iframeSaved = true;">Save Draft</button>
</body>
</html>`;

const GMAIL_HTML = `<!doctype html>
<html>
<body>
  <div role="dialog" style="width:500px;height:400px;border:1px solid #333;">
    <input aria-label="To recipients" type="text" />
    <input name="subjectbox" placeholder="Subject" type="text" />
    <div aria-label="Message Body" role="textbox" contenteditable="true" style="height:120px;border:1px solid #aaa;"></div>
    <button type="button" onclick="window.__mailSent = true;">Send</button>
  </div>
</body>
</html>`;

function buildLargePageHtml() {
  const buttons = Array.from({ length: 140 }, (_, i) =>
    `<button type="button" data-idx="${i}">Action Item Number ${i} Extra Label Text Here</button>`
  ).join('\n');
  return `<!doctype html>
<html>
<head><title>Dense Page</title><style>.hidden{display:none}</style></head>
<body>
  <main>
    <h1>Performance Benchmark Article</h1>
    <p>This clean paragraph explains why compact inspection stays below strict token budgets.</p>
    <p>Second meaningful paragraph inside main.</p>
    <div>${buttons}</div>
  </main>
  <script>window.__ignoredNoise = "SHOULD_NOT_APPEAR";</script>
</body>
</html>`;
}

const DIAG_HTML = `<!doctype html>
<html>
<body>
  <h1>Diagnostics Test</h1>
  <button id="alert-btn" type="button" onclick="alert('Blocking Alert Text')">Trigger Alert</button>
  <script>
    console.error('Boom console error 123');
    console.warn('Warn message 456');
    fetch('/missing-404-endpoint').catch(() => {});
  </script>
</body>
</html>`;

const SHADOW_INTERACTION_HTML = `<!doctype html>
<html>
<head>
  <title>Shadow DOM, Drag, Delta & Session Fixture</title>
  <style>
    body { background: #ffffff; color: #111111; }
    @media (prefers-color-scheme: dark) {
      body { background: #101010; color: #f5f5f5; }
    }
  </style>
</head>
<body>
  <h1 id="page-title">v0.2 Interactive Fixture</h1>
  <div id="spinner">Loading spinner...</div>
  <shadow-card></shadow-card>
  <button id="reveal-btn" type="button" onclick="addDynamicInput()">Reveal Dynamic Field</button>
  <div id="dynamic-host"></div>
  <div id="drag-src" draggable="true" style="width:80px;height:40px;background:#ccc;">Drag Me</div>
  <div id="drag-dst" style="width:120px;height:60px;border:2px dashed #333;margin-top:8px;">Drop Here</div>
  <button id="prompt-btn" type="button" onclick="window.__promptVal = prompt('Enter code:'); console.log('Prompt answered:', window.__promptVal);">Ask Prompt</button>
  <button id="api-btn" type="button" onclick="fetch('/api/echo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ping: 42 }) }).then(r => r.json()).then(d => { window.__apiResp = d; });">Call API</button>
  <script>
    setTimeout(() => {
      const sp = document.getElementById('spinner');
      if (sp) sp.style.display = 'none';
    }, 120);

    class ShadowCard extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = \`
          <div class="field">
            <input id="shadow-secret" aria-label="Shadow Secret" type="text" />
            <button id="shadow-btn" type="button">Shadow Action</button>
          </div>
        \`;
        root.getElementById('shadow-btn').addEventListener('click', () => {
          window.__shadowClicked = true;
        });
      }
    }
    customElements.define('shadow-card', ShadowCard);

    function addDynamicInput() {
      if (document.getElementById('dyn-input')) return;
      const inp = document.createElement('input');
      inp.id = 'dyn-input';
      inp.setAttribute('aria-label', 'Newly Revealed Field');
      document.getElementById('dynamic-host').appendChild(inp);
    }

    const src = document.getElementById('drag-src');
    const dst = document.getElementById('drag-dst');
    src.addEventListener('dragstart', (e) => e.dataTransfer?.setData('text/plain', 'dragged'));
    dst.addEventListener('dragover', (e) => e.preventDefault());
    dst.addEventListener('drop', (e) => {
      e.preventDefault();
      window.__dropped = true;
      dst.textContent = 'Dropped OK';
    });
  </script>
</body>
</html>`;

const V3_HTML = `<!doctype html>
<html>
<head>
  <title>v0.3 Parity Fixture</title>
  <style>
    body { margin: 0; font-family: sans-serif; }
    #v3-drop { margin-top: 100px; width: 180px; height: 60px; border: 2px dashed #444; }
  </style>
</head>
<body>
  <button id="ctx-btn" type="button" style="position:fixed;left:40px;top:40px;width:120px;height:36px;">Context Target</button>
  <button id="coord-submit" type="submit" style="position:fixed;left:200px;top:40px;width:120px;height:36px;">Submit Now</button>
  <div id="v3-drop">File Drop Zone</div>
  <img id="static-img" src="/pixel.png" width="16" height="16" alt="px" />
  <form id="v3-form" onsubmit="event.preventDefault(); window.__searchSubmitted = true;">
    <input id="search-box" type="text" aria-label="Search Box" />
    <label for="skills">Skills</label>
    <select id="skills" multiple aria-label="Skills">
      <option value="js">JavaScript</option>
      <option value="ts">TypeScript</option>
      <option value="py">Python</option>
    </select>
    <label for="volume">Volume Slider</label>
    <input id="volume" type="range" min="0" max="100" value="20" aria-label="Volume Slider" />
  </form>
  <a id="dl-link" href="/download" download="sample.txt">Download Sample</a>
  <script>
    window.__v3Clicks = [];
    window.__v3RightClicked = false;
    window.__v3Hovered = false;
    window.__searchSubmitted = false;
    window.__v3Dropped = null;

    const ctxBtn = document.getElementById('ctx-btn');
    ctxBtn.addEventListener('click', (e) => {
      window.__v3Clicks.push({ button: e.button, shiftKey: e.shiftKey, altKey: e.altKey });
    });
    ctxBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      window.__v3RightClicked = true;
    });
    ctxBtn.addEventListener('mouseenter', () => {
      window.__v3Hovered = true;
    });

    const v3Drop = document.getElementById('v3-drop');
    v3Drop.addEventListener('dragover', (e) => e.preventDefault());
    v3Drop.addEventListener('drop', (e) => {
      e.preventDefault();
      window.__v3Dropped = {
        files: e.dataTransfer ? [...e.dataTransfer.files].map((f) => f.name + ':' + f.size) : [],
        text: e.dataTransfer ? e.dataTransfer.getData('text/plain') : '',
      };
    });
  </script>
</body>
</html>`;

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+fX0AAAAASUVORK5CYII=',
  'base64'
);

function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    if (urlPath === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(MAIN_HTML);
      return;
    }
    if (urlPath === '/iframe-form') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(IFRAME_HTML);
      return;
    }
    if (urlPath === '/gmail') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(GMAIL_HTML);
      return;
    }
    if (urlPath === '/dense') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildLargePageHtml());
      return;
    }
    if (urlPath === '/diag') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(DIAG_HTML);
      return;
    }
    if (urlPath === '/shadow') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(SHADOW_INTERACTION_HTML);
      return;
    }
    if (urlPath === '/v3') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(V3_HTML);
      return;
    }
    if (urlPath === '/download') {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="sample.txt"',
      });
      res.end('turbo-browser-v3-download');
      return;
    }
    if (urlPath === '/api/echo' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, echo: JSON.parse(body || '{}') }));
      });
      return;
    }
    if (urlPath === '/pixel.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(TINY_PNG);
      return;
    }
    if (urlPath === '/google-analytics.com/collect') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tracked: true }));
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

describe('turbo-browser-mcp integration', () => {
  let server;
  let baseUrl;
  let tmpPdf;
  let manager;

  before(async () => {
    ({ server, baseUrl } = await startFixtureServer());
    tmpPdf = path.join(os.tmpdir(), `tbm-cv-${Date.now()}.pdf`);
    fs.writeFileSync(tmpPdf, '%PDF-1.4\n%turbo-browser-mcp-test\n%%EOF\n', 'utf8');
    manager = new BrowserManager({ mode: 'launch', headless: true });
  });

  after(async () => {
    await manager?.close();
    await new Promise((resolve) => server?.close(resolve));
    if (tmpPdf && fs.existsSync(tmpPdf)) {
      fs.unlinkSync(tmpPdf);
    }
  });

  it('fills React controlled inputs, contenteditable, select, ARIA combobox, radios, checkboxes, iframe & disk PDF in one batch while stopping before Submit', async (t) => {
    const t0 = performance.now();
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/` }]);
    const { page } = await manager.getPage();

    const inspected = await inspectCompact(page, { mode: 'interactive', maxChars: 4000 });
    assert.ok(inspected.text.includes('[f0:e'), 'should include main frame refs');
    assert.ok(inspected.text.includes('iframe f1'), 'should traverse child iframe automatically');
    assert.ok(inspected.text.includes('[hidden-file]'), 'should include visually hidden file input');
    assert.ok(inspected.charCount <= 4000, 'should stay within maxChars');

    const fillRes = await smartFillForm(page, {
      fields: [
        { keys: ['full name'], value: 'Nguyen Trung Thanh' },
        { keys: ['email'], value: 'thanh@example.com' },
        { keys: ['cover note'], value: 'Built fast Playwright MCP automation.' },
        { keys: ['country'], value: 'Vietnam' },
        { keys: ['work mode'], value: 'Remote Full-Time' },
        { keys: ['start immediately'], option: 'Yes' },
        { keys: ['tech stack'], check: ['React', 'Node'] },
        { keys: ['emergency contact'], value: '0901234567' },
        { keys: ['resume'], file: tmpPdf },
      ],
    });

    const elapsedMs = Math.round(performance.now() - t0);
    t.diagnostic(`Form + iframe + disk upload batch elapsed: ${elapsedMs}ms, filledCount=${fillRes.filledCount}`);

    assert.equal(fillRes.filledCount, 10, 'should fill 9 field specs (with 2 checkboxes = 10 controls)');
    assert.equal(fillRes.stoppedBeforeSubmit, true);
    assert.ok(
      fillRes.submitButtons.some((b) => /Submit Application/i.test(b.text)),
      'should report detected submit button'
    );

    const state = await evaluateJs(page, {
      expression: `() => ({
        reactTracked: window.__reactTracked,
        email: document.getElementById('email').value,
        cover: document.getElementById('cover-editor').innerText.trim(),
        country: document.getElementById('country').value,
        workMode: window.__workMode,
        startYes: document.querySelector('input[name="startNow"][value="yes"]').checked,
        stacks: [...document.querySelectorAll('input[name="stack"]:checked')].map(el => el.value),
        resumeText: document.getElementById('resume-name').textContent,
        submitted: window.__submitted
      })`,
    });

    assert.equal(state.result.reactTracked, 'Nguyen Trung Thanh');
    assert.equal(state.result.email, 'thanh@example.com');
    assert.equal(state.result.cover, 'Built fast Playwright MCP automation.');
    assert.equal(state.result.country, 'vn');
    assert.equal(state.result.workMode, 'remote');
    assert.equal(state.result.startYes, true);
    assert.deepEqual(state.result.stacks, ['react', 'node']);
    assert.ok(state.result.resumeText.includes(path.basename(tmpPdf)), 'disk PDF attached cleanly');
    assert.equal(state.result.submitted, 0, 'form must NOT submit automatically');

    const iframeState = await evaluateJs(page, {
      frameIdx: 1,
      expression: `() => document.getElementById('emergency').value`,
    });
    assert.equal(iframeState.result, '0901234567');
  });

  it('enforces Submit guard (allowSubmit=false blocks submit buttons; allowSubmit=true permits; safe buttons work)', async () => {
    const { page } = await manager.getPage();

    // Blocked by default on English Submit button
    const blockedEn = await actFast(page, { action: 'click', selector: '#submit-btn' });
    assert.equal(blockedEn.blocked, true);

    // Blocked by default on Vietnamese Đăng bài button
    const blockedVn = await actFast(page, { action: 'click', selector: '#post-btn' });
    assert.equal(blockedVn.blocked, true);

    // Non-submit button succeeds
    const safeClick = await actFast(page, { action: 'click', selector: '#next-btn' });
    assert.equal(safeClick.ok, true);

    // Ref targeting inside child iframe works directly via batch_actions
    const inspected = await inspectCompact(page, { mode: 'interactive' });
    const matchIframeBtn = /\[(f1:e\d+)\]\s+<button>\s+"Save Draft"/.exec(inspected.text);
    assert.ok(matchIframeBtn, 'should locate Save Draft ref inside iframe f1');

    const batchRes = await batchActions(page, [
      { action: 'click', ref: matchIframeBtn[1] },
      { action: 'click', selector: '#submit-btn' },
    ]);
    assert.equal(batchRes.blocked, true, 'batch_actions stops safely when hitting submit button');
    assert.equal(batchRes.completed, 2);

    const checkIframe = await evaluateJs(page, { frameIdx: 1, expression: 'window.__iframeSaved' });
    assert.equal(checkIframe.result, true);

    // Explicit opt-in allows submit
    const allowedSubmit = await actFast(page, {
      action: 'click',
      selector: '#submit-btn',
      allowSubmit: true,
    });
    assert.equal(allowedSubmit.ok, true);
    const subCount = await evaluateJs(page, { expression: 'window.__submitted' });
    assert.equal(subCount.result, 1);
  });

  it('fills Gmail compose popup fields without sending email', async () => {
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/gmail` }]);
    const { page } = await manager.getPage();

    const res = await smartFillForm(page, {
      gmail: {
        to: 'hr@company.example',
        subject: 'Application for Backend Role',
        body: 'Hello team, please find my application attached.',
      },
    });
    assert.equal(res.filledCount, 3);
    assert.ok(res.submitButtons.some((b) => /^Send$/i.test(b.text)));

    const gmailState = await evaluateJs(page, {
      expression: `() => ({
        to: document.querySelector('input[aria-label*="To"]').value,
        subject: document.querySelector('input[name="subjectbox"]').value,
        body: document.querySelector('div[aria-label="Message Body"]').innerText.trim(),
        sent: Boolean(window.__mailSent)
      })`,
    });
    assert.deepEqual(gmailState.result, {
      to: 'hr@company.example',
      subject: 'Application for Backend Role',
      body: 'Hello team, please find my application attached.',
      sent: false,
    });
  });

  it('strictly caps compact snapshots and clean text output sizes on dense pages', async (t) => {
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/dense` }]);
    const { page } = await manager.getPage();

    const snap1200 = await inspectCompact(page, { mode: 'interactive', maxChars: 1200 });
    assert.ok(snap1200.charCount <= 1200, `Expected <= 1200 chars, got ${snap1200.charCount}`);
    assert.equal(snap1200.truncated, true);

    const snap4000 = await inspectCompact(page, { mode: 'interactive', maxChars: 4000 });
    assert.ok(snap4000.charCount <= 4000, `Expected <= 4000 chars, got ${snap4000.charCount}`);
    t.diagnostic(`Dense 140-button page default snapshot: ${snap4000.charCount} chars (truncated=${snap4000.truncated})`);

    const clean = await extractCleanText(page, { maxChars: 500 });
    assert.ok(clean.text.includes('Performance Benchmark Article'));
    assert.ok(!clean.text.includes('SHOULD_NOT_APPEAR'));
    assert.ok(clean.charCount <= 500);
  });

  it('captures console errors, HTTP 404 responses, and auto-dismisses alerts in page_diagnostics', async () => {
    const res = await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/diag`, waitUntil: 'networkidle' }]);
    const diagTabId = res.activeTabId;

    await actFast(await manager.getPage(diagTabId).then((x) => x.page), {
      action: 'click',
      selector: '#alert-btn',
    });

    const diag = await manager.getDiagnostics(diagTabId, true);
    assert.ok(diag.console.some((c) => c.level === 'error' && c.text.includes('Boom console error 123')));
    assert.ok(diag.console.some((c) => c.level === 'warning' && c.text.includes('Warn message 456')));
    assert.ok(diag.networkErrors.some((n) => n.status === 404 && n.url.includes('/missing-404-endpoint')));
    assert.ok(diag.dialogs.some((d) => d.type === 'alert' && d.message.includes('Blocking Alert Text')));

    const afterClear = await manager.getDiagnostics(diagTabId);
    assert.equal(afterClear.console.length, 0);
    assert.equal(afterClear.networkErrors.length, 0);
    assert.equal(afterClear.dialogs.length, 0);
  });

  it('pierces open Shadow DOM, supports query filter & onlyChanged delta snapshots, and returns 1-turn snapshots', async () => {
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/shadow`, waitUntil: 'networkidle' }]);
    const { page } = await manager.getPage();
    const snapState = manager.getSnapshotState(page);

    const fullSnap = await inspectCompact(page, { mode: 'interactive' }, snapState);
    assert.ok(fullSnap.text.includes('Shadow Secret'), 'should find open Shadow DOM input');
    assert.ok(fullSnap.text.includes('Shadow Action'), 'should find open Shadow DOM button');
    assert.ok(fullSnap.text.includes('[shadow]'), 'should tag Shadow DOM nodes');

    const querySnap = await inspectCompact(page, { query: 'Shadow Action' }, snapState);
    assert.ok(querySnap.text.includes('Shadow Action'));
    assert.ok(!querySnap.text.includes('Reveal Dynamic Field'));

    const fillShadow = await smartFillForm(page, {
      fields: [{ keys: ['shadow secret'], value: 'shadow-token-77' }],
      returnSnapshot: true,
    });
    assert.equal(fillShadow.filledCount, 1);
    assert.ok(fillShadow.snapshot.includes('shadow-token-77'));

    // Re-sync baseline, reveal a new dynamic input via 1-turn actFast, then inspect onlyChanged
    await inspectCompact(page, { mode: 'interactive' }, snapState);
    const shadowMatch = /\[(f0:e\d+)\]\s+<button>\s+"Shadow Action"/.exec(fullSnap.text);
    assert.ok(shadowMatch, 'should extract ref for Shadow Action button');

    const shadowClick = await actFast(page, {
      action: 'click',
      ref: shadowMatch[1],
      returnSnapshot: true,
    }, snapState);
    assert.equal(shadowClick.ok, true);
    assert.ok(shadowClick.snapshot.includes('Mode: interactive'));

    await inspectCompact(page, { mode: 'interactive' }, snapState);
    await actFast(page, { action: 'click', selector: '#reveal-btn' }, snapState);
    const deltaSnap = await inspectCompact(page, { mode: 'interactive', onlyChanged: true }, snapState);
    assert.ok(deltaSnap.text.includes('Newly Revealed Field'), 'onlyChanged should show newly added input');
    assert.ok(!deltaSnap.text.includes('Reveal Dynamic Field'), 'onlyChanged should omit unchanged controls');

    const shadowClicked = await evaluateJs(page, { expression: 'window.__shadowClicked' });
    assert.equal(shadowClicked.result, true);
  });

  it('supports drag, wait textGone, resize, emulate colorScheme dark, and markdown extraction', async () => {
    const res = await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/shadow` }]);
    const tabId = res.activeTabId;
    const { page } = await manager.getPage(tabId);

    const waitGone = await actFast(page, { action: 'wait', textGone: 'Loading spinner...', timeoutMs: 4000 });
    assert.equal(waitGone.ok, true);

    const dragRes = await actFast(page, {
      action: 'drag',
      selector: '#drag-src',
      targetSelector: '#drag-dst',
    });
    assert.equal(dragRes.ok, true);
    const dropped = await evaluateJs(page, { expression: 'window.__dropped' });
    assert.equal(dropped.result, true);

    await manager.tabsBatch([
      { action: 'resize', tabId, width: 900, height: 650 },
      { action: 'emulate', tabId, colorScheme: 'dark' },
    ]);

    const envCheck = await evaluateJs(page, {
      expression: '() => ({ w: window.innerWidth, dark: window.matchMedia("(prefers-color-scheme: dark)").matches })',
    });
    assert.equal(envCheck.result.w, 900);
    assert.equal(envCheck.result.dark, true);

    const md = await extractCleanText(page, { format: 'markdown', maxChars: 1000 });
    assert.ok(md.text.includes('# v0.2 Interactive Fixture'));
  });

  it('inspects full HTTP reqId details, all console levels, and accepts prompt dialogs per policy', async () => {
    const res = await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/shadow`, waitUntil: 'networkidle' }]);
    const tabId = res.activeTabId;
    const { page } = await manager.getPage(tabId);

    await manager.getDiagnostics(tabId, {
      dialogPolicy: { action: 'accept', promptText: 'Confirmed 123' },
    });

    await actFast(page, { action: 'click', selector: '#prompt-btn' });
    await actFast(page, { action: 'click', selector: '#api-btn' });
    await actFast(page, { action: 'wait', ms: 150 });

    const diagAll = await manager.getDiagnostics(tabId, {
      level: 'all',
      statusFilter: 'all',
    });
    assert.ok(diagAll.console.some((c) => c.level === 'log' && c.text.includes('Confirmed 123')));
    assert.ok(diagAll.dialogs.some((d) => d.type === 'prompt' && d.actionTaken === 'accepted'));

    const apiReq = diagAll.requests.find((r) => r.url.includes('/api/echo'));
    assert.ok(apiReq, 'should capture /api/echo request in ring buffer');

    const reqDetail = await manager.getDiagnostics(tabId, { reqId: apiReq.reqId });
    assert.equal(reqDetail.request.status, 200);
    assert.ok(reqDetail.request.postData.includes('42'));
    assert.ok(reqDetail.request.responseBody.includes('"ok":true'));
  });

  it('captures screenshots/PDF safely and manages cookies, storage, storageState, and resource blocking', async () => {
    const tmpShot = path.join(os.tmpdir(), `tbm-shot-${Date.now()}.png`);
    const tmpExportPdf = path.join(os.tmpdir(), `tbm-page-${Date.now()}.pdf`);
    const tmpState = path.join(os.tmpdir(), `tbm-state-${Date.now()}.json`);

    try {
      const res = await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/shadow`, waitUntil: 'networkidle' }]);
      const tabId = res.activeTabId;
      const { page } = await manager.getPage(tabId);

      const shot = await capturePage(page, { savePath: tmpShot, returnImage: true });
      assert.equal(shot.ok, true);
      assert.ok(fs.existsSync(tmpShot));
      assert.ok(shot.base64 && shot.base64.length > 100);

      const pdf = await capturePage(page, { mode: 'pdf', savePath: tmpExportPdf });
      assert.equal(pdf.ok, true);
      assert.ok(fs.existsSync(tmpExportPdf));
      assert.ok(pdf.bytes > 500);

      await manager.manageNetworkSession(tabId, {
        cookieAction: 'set',
        cookies: [{ name: 'tbm_session', value: 'abc999' }],
        storageAction: 'set',
        storageType: 'local',
        items: { draftMode: 'on' },
        saveStorageStatePath: tmpState,
        blockResources: ['image'],
        blockUrls: ['/api/echo'],
      });

      const fetched = await manager.manageNetworkSession(tabId, {
        cookieAction: 'get',
        storageAction: 'get',
        storageType: 'local',
      });
      assert.ok(fetched.cookies.some((c) => c.name === 'tbm_session' && c.value === 'abc999'));
      assert.equal(fetched.storage.local.draftMode, 'on');
      assert.ok(fs.existsSync(tmpState));

      // Verify image resourceType blocking aborts <img> load AND blockUrls aborts matching fetch
      const blockedCheck = await evaluateJs(page, {
        expression: `async () => {
          const imgRes = await new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve('loaded');
            img.onerror = () => resolve('blocked');
            img.src = '/pixel.png?t=' + Date.now();
          });
          let apiRes = 'loaded';
          try { await fetch('/api/echo', { method: 'POST', body: '{}' }); } catch { apiRes = 'blocked'; }
          return { imgRes, apiRes };
        }`,
      });
      assert.deepEqual(blockedCheck.result, { imgRes: 'blocked', apiRes: 'blocked' });

      await manager.manageNetworkSession(tabId, { unblockAll: true, cookieAction: 'clear' });
      const imgAfterUnblock = await evaluateJs(page, {
        expression: `async () => new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve('loaded');
          img.onerror = () => resolve('blocked');
          img.src = '/pixel.png?after=' + Date.now();
        })`,
      });
      assert.equal(imgAfterUnblock.result, 'loaded');
    } finally {
      for (const f of [tmpShot, tmpExportPdf, tmpState]) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    }
  });

  it('supports isolatedContext sessions, emulate forcedColors/contrast/null, boxes & savePath, and device scale screenshots', async () => {
    const tmpInspect = path.join(os.tmpdir(), `tbm-inspect-${Date.now()}.txt`);
    const tmpText = path.join(os.tmpdir(), `tbm-text-${Date.now()}.txt`);
    const tmpShotDev = path.join(os.tmpdir(), `tbm-dev-${Date.now()}.png`);

    try {
      const openDefault = await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/v3`, waitUntil: 'networkidle' }]);
      const defaultTab = openDefault.activeTabId;
      await manager.manageNetworkSession(defaultTab, {
        cookieAction: 'set',
        cookies: [{ name: 'ctx_scope', value: 'default_val' }],
      });

      const openIso = await manager.tabsBatch([
        { action: 'open', url: `${baseUrl}/v3`, isolatedContext: 'work-iso', waitUntil: 'networkidle' },
      ]);
      const isoTab = openIso.activeTabId;
      assert.ok(openIso.tabs.some((t) => t.tabId === isoTab && t.isolatedContext === 'work-iso'));

      const isoCookies = await manager.manageNetworkSession(isoTab, { cookieAction: 'get' });
      assert.equal(isoCookies.cookies.some((c) => c.name === 'ctx_scope'), false, 'isolated context must not inherit default cookies');

      await manager.manageNetworkSession(isoTab, {
        cookieAction: 'set',
        cookies: [{ name: 'iso_only', value: 'yes' }],
      });
      const defCookiesAfter = await manager.manageNetworkSession(defaultTab, { cookieAction: 'get' });
      assert.equal(defCookiesAfter.cookies.some((c) => c.name === 'iso_only'), false, 'default context must remain isolated');

      // Emulate forcedColors + contrast, then reset via null
      await manager.tabsBatch([
        { action: 'emulate', tabId: defaultTab, forcedColors: 'active', contrast: 'more' },
      ]);
      const { page: defPage } = await manager.getPage(defaultTab);
      const emuOn = await evaluateJs(defPage, {
        expression: '() => ({ fc: matchMedia("(forced-colors: active)").matches, ct: matchMedia("(prefers-contrast: more)").matches })',
      });
      assert.deepEqual(emuOn.result, { fc: true, ct: true });

      await manager.tabsBatch([
        { action: 'emulate', tabId: defaultTab, forcedColors: null, contrast: null },
      ]);
      const emuReset = await evaluateJs(defPage, {
        expression: '() => ({ fc: matchMedia("(forced-colors: active)").matches, ct: matchMedia("(prefers-contrast: more)").matches })',
      });
      assert.deepEqual(emuReset.result, { fc: false, ct: false });

      // inspect_compact boxes + savePath, extract_clean_text savePath, capture_page scale
      const boxed = await inspectCompact(defPage, { mode: 'interactive', boxes: true, savePath: tmpInspect });
      assert.match(boxed.text, /\[box=\d+,\d+,\d+,\d+\]/);
      assert.equal(boxed.savePath, path.resolve(tmpInspect));
      assert.ok(fs.existsSync(tmpInspect));

      const savedText = await extractCleanText(defPage, { savePath: tmpText });
      assert.equal(savedText.savePath, path.resolve(tmpText));
      assert.ok(fs.existsSync(tmpText));

      const shotDev = await capturePage(defPage, { scale: 'device', savePath: tmpShotDev });
      assert.equal(shotDev.ok, true);
      assert.ok(fs.existsSync(tmpShotDev));
    } finally {
      for (const f of [tmpInspect, tmpText, tmpShotDev]) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    }
  });

  it('supports drop files/MIME, mouse button/modifiers/coords + guard, multi-select, range slider, type submit guard, and element evaluate_js', async () => {
    const tmpDrop = path.join(os.tmpdir(), `tbm-drop-${Date.now()}.txt`);
    const tmpEval = path.join(os.tmpdir(), `tbm-eval-${Date.now()}.json`);
    fs.writeFileSync(tmpDrop, 'hello drop v3', 'utf8');

    try {
      const opened = await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/v3`, waitUntil: 'networkidle' }]);
      const { page } = await manager.getPage(opened.activeTabId);

      // 1. drop with real disk file + custom MIME dropData
      const dropRes = await actFast(page, {
        action: 'drop',
        selector: '#v3-drop',
        files: [tmpDrop],
        dropData: { 'text/plain': 'custom-drop-mime' },
      });
      assert.equal(dropRes.ok, true);
      assert.deepEqual(dropRes.files, [path.basename(tmpDrop)]);
      const droppedState = await evaluateJs(page, { expression: 'window.__v3Dropped' });
      assert.equal(droppedState.result.files[0], `${path.basename(tmpDrop)}:13`);
      assert.equal(droppedState.result.text, 'custom-drop-mime');

      // 2. coordinate right-click, Shift modifier click, coordinate hover, and coordinate Submit guard
      const rightCoord = await actFast(page, { action: 'click', x: 100, y: 58, button: 'right' });
      assert.equal(rightCoord.ok, true);
      const shiftClick = await actFast(page, { action: 'click', selector: '#ctx-btn', modifiers: ['Shift'] });
      assert.equal(shiftClick.ok, true);
      const hoverCoord = await actFast(page, { action: 'hover', x: 100, y: 58 });
      assert.equal(hoverCoord.ok, true);
      const guardedCoord = await actFast(page, { action: 'click', x: 260, y: 58 });
      assert.equal(guardedCoord.blocked, true);

      const clickState = await evaluateJs(page, {
        expression: '() => ({ right: window.__v3RightClicked, hovered: window.__v3Hovered, clicks: window.__v3Clicks })',
      });
      assert.equal(clickState.result.right, true);
      assert.equal(clickState.result.hovered, true);
      assert.equal(clickState.result.clicks.some((c) => c.shiftKey === true), true);

      // 3. multi-select + range slider via smartFillForm, and multi-select via actFast select
      const fillV3 = await smartFillForm(page, {
        fields: [
          { selector: '#skills', values: ['js', 'py'] },
          { selector: '#volume', value: 78 },
        ],
      });
      assert.equal(fillV3.filledCount, 2);
      const filledVals = await evaluateJs(page, {
        expression: '() => ({ skills: [...document.getElementById("skills").selectedOptions].map(o => o.value), vol: document.getElementById("volume").value })',
      });
      assert.deepEqual(filledVals.result, { skills: ['js', 'py'], vol: '78' });

      const selAct = await actFast(page, { action: 'select', selector: '#skills', values: ['ts', 'py'] });
      assert.deepEqual(selAct.chosen, ['ts', 'py']);

      // 4. type slowly/fill & submit guard
      const blockedType = await actFast(page, {
        action: 'type',
        selector: '#search-box',
        value: 'blocked search',
        slowly: false,
        submit: true,
      });
      assert.equal(blockedType.blocked, true);

      const okType = await actFast(page, {
        action: 'type',
        selector: '#search-box',
        value: 'turbo query',
        slowly: false,
        submit: true,
        allowSubmit: true,
      });
      assert.equal(okType.ok, true);
      assert.equal(okType.submitted, true);
      const searchDone = await evaluateJs(page, {
        expression: '() => ({ val: document.getElementById("search-box").value, sub: window.__searchSubmitted })',
      });
      assert.deepEqual(searchDone.result, { val: 'turbo query', sub: true });

      // 5. evaluateJs targeting element + savePath
      const elEval = await evaluateJs(page, {
        selector: '#ctx-btn',
        expression: '(el, arg) => ({ tag: el.tagName, combined: el.id + arg.suffix })',
        arg: { suffix: '-ok' },
        savePath: tmpEval,
      });
      assert.deepEqual(elEval.result, { tag: 'BUTTON', combined: 'ctx-btn-ok' });
      assert.ok(fs.existsSync(tmpEval));
      assert.equal(JSON.parse(fs.readFileSync(tmpEval, 'utf8')).combined, 'ctx-btn-ok');
    } finally {
      for (const f of [tmpDrop, tmpEval]) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    }
  });

  it('captures browser downloads and filters diagnostics with includeStatic, urlFilter, part, and savePath', async () => {
    const tmpDiag = path.join(os.tmpdir(), `tbm-diag-${Date.now()}.json`);
    let downloadedPath = null;

    try {
      const opened = await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/v3`, waitUntil: 'networkidle' }]);
      const tabId = opened.activeTabId;
      const { page } = await manager.getPage(tabId);

      await evaluateJs(page, {
        expression: '() => fetch("/api/echo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ v3: 99 }) }).then(r => r.json())',
      });
      await actFast(page, { action: 'click', selector: '#dl-link' });
      await actFast(page, { action: 'wait', ms: 250 });

      const noStatic = await manager.getDiagnostics(tabId, {
        statusFilter: 'all',
        includeStatic: false,
      });
      assert.equal(noStatic.requests.some((r) => r.url.includes('/pixel.png')), false, 'includeStatic=false should exclude 2xx images');
      assert.equal(noStatic.requests.some((r) => r.url.includes('/api/echo')), true);
      assert.ok(noStatic.downloads.some((d) => d.suggestedFilename === 'sample.txt'));

      const dlEntry = noStatic.downloads.find((d) => d.suggestedFilename === 'sample.txt');
      downloadedPath = dlEntry.savePath;
      assert.ok(downloadedPath && fs.existsSync(downloadedPath));
      assert.equal(fs.readFileSync(downloadedPath, 'utf8'), 'turbo-browser-v3-download');

      const withStatic = await manager.getDiagnostics(tabId, {
        statusFilter: 'all',
        includeStatic: true,
      });
      assert.equal(withStatic.requests.some((r) => r.url.includes('/pixel.png')), true);

      const urlFiltered = await manager.getDiagnostics(tabId, {
        statusFilter: 'all',
        urlFilter: '/api/echo',
        savePath: tmpDiag,
      });
      assert.equal(urlFiltered.requests.every((r) => r.url.includes('/api/echo')), true);
      assert.ok(fs.existsSync(tmpDiag));

      const echoReq = urlFiltered.requests[0];
      const partResp = await manager.getDiagnostics(tabId, {
        reqId: echoReq.reqId,
        part: 'response-body',
      });
      assert.equal(partResp.part, 'response-body');
      assert.ok(partResp.data.includes('99'));
    } finally {
      for (const f of [tmpDiag, downloadedPath].filter(Boolean)) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    }
  });

  it('supports concurrent open_many batching, turbo/clean network presets, and elapsedMs telemetry', async () => {
    const batchRes = await manager.tabsBatch([
      {
        action: 'open_many',
        urls: [`${baseUrl}/v3`, `${baseUrl}/shadow`, `${baseUrl}/dense`],
        concurrency: 3,
      },
    ]);
    assert.equal(typeof batchRes.elapsedMs, 'number');
    assert.equal(batchRes.results[0].action, 'open_many');
    assert.equal(batchRes.results[0].opened.length, 3);
    assert.equal(typeof batchRes.results[0].elapsedMs, 'number');
    const firstTabId = batchRes.results[0].opened[0].tabId;

    const presetRes = await manager.manageNetworkSession(firstTabId, { preset: 'turbo' });
    assert.equal(presetRes.presetApplied, 'turbo');
    assert.ok(presetRes.blockedResources.includes('image'));

    const { page } = await manager.getPage(firstTabId);
    const blockedCheck = await evaluateJs(page, {
      expression: `async () => {
        const imgState = await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve('loaded');
          img.onerror = () => resolve('blocked');
          img.src = '/pixel.png?v4=' + Date.now();
        });
        let trackerState = 'loaded';
        try { await fetch('/google-analytics.com/collect'); } catch { trackerState = 'blocked'; }
        return { imgState, trackerState };
      }`,
    });
    assert.deepEqual(blockedCheck.result, { imgState: 'blocked', trackerState: 'blocked' });

    const cleanRes = await manager.manageNetworkSession(firstTabId, { preset: 'clean' });
    assert.equal(cleanRes.presetApplied, 'clean');
    assert.equal(cleanRes.unblockedAll, true);

    const cleanCheck = await evaluateJs(page, {
      expression: `async () => {
        const res = await fetch('/google-analytics.com/collect');
        return await res.json();
      }`,
    });
    assert.deepEqual(cleanCheck.result, { tracked: true });

    const snapTimed = await inspectCompact(page, { mode: 'interactive' });
    assert.equal(typeof snapTimed.elapsedMs, 'number');
  });

  it('prevents stale data-tbm-ref collisions, handles regex metacharacters in labels/options, and guards implicit Enter submit', async () => {
    const opened = await manager.tabsBatch([
      { action: 'open', url: 'about:blank', isolatedContext: 'regression', activate: true },
    ]);
    const tabId = opened.results[0].tabId;
    const { page } = await manager.getPage(tabId);
    await page.setContent(`<!doctype html><html><body>
      <a id="top-link" href="#top" onclick="window.__topClicked = true; return false;">Skip Navigation</a>
      <form id="edge-f" onsubmit="event.preventDefault(); window.__edgeSubmitted = (window.__edgeSubmitted || 0) + 1;">
        <input id="first" name="q" type="text" aria-label="Search (optional)" />
        <label for="phone">Phone (optional)</label>
        <input id="phone" type="text" />
        <label for="lang">Skill (C++)</label>
        <select id="lang"><option value="">Pick</option><option value="c++">C++</option><option value="ts">TypeScript</option></select>
        <label><input id="exp" type="checkbox" /> 5+ years (Senior)</label>
        <button id="edge-sub" type="submit">Submit</button>
      </form>
      <form id="safe-search-f" onsubmit="event.preventDefault(); window.__safeSearched = (window.__safeSearched || 0) + 1;">
        <input id="q-safe" type="search" />
        <button type="submit">Search</button>
      </form>
    </body></html>`);

    // 1. Switching inspect_compact modes must clear stale [data-tbm-ref] attributes.
    await inspectCompact(page, { mode: 'interactive' });
    const formsSnap = await inspectCompact(page, { mode: 'forms' });
    assert.ok(formsSnap.text.includes('[f0:e1] <input:text> "Search (optional)"'));
    await actFast(page, { action: 'click', ref: 'f0:e1' });
    await actFast(page, { action: 'fill', ref: 'f0:e1', value: 'hello' });
    const afterRefState = await evaluateJs(page, {
      expression: '({ val: document.getElementById("first").value, topClicked: Boolean(window.__topClicked) })',
    });
    assert.deepEqual(afterRefState.result, { val: 'hello', topClicked: false });

    // 2. Regex metacharacters in keys, select value, and check labels must match cleanly without SyntaxError.
    const metaFill = await smartFillForm(page, {
      fields: [
        { keys: ['Phone (optional)'], value: '0999888777' },
        { keys: ['C++'], value: 'C++' },
        { check: '5+ years (Senior)' },
      ],
    });
    assert.equal(metaFill.filledCount, 3);
    const metaState = await evaluateJs(page, {
      expression: '({ phone: document.getElementById("phone").value, lang: document.getElementById("lang").value, exp: document.getElementById("exp").checked })',
    });
    assert.deepEqual(metaState.result, { phone: '0999888777', lang: 'c++', exp: true });

    // 3. Pressing Enter inside a <form> input must be blocked when allowSubmit=false, allowed on safe Search forms or allowSubmit=true.
    const blockedEnter = await actFast(page, { action: 'press', selector: '#first', key: 'Enter', allowSubmit: false });
    assert.equal(blockedEnter.blocked, true);

    await actFast(page, { action: 'focus', selector: '#phone' });
    const blockedActiveEnter = await actFast(page, { action: 'press', key: 'Enter', allowSubmit: false });
    assert.equal(blockedActiveEnter.blocked, true);

    const safeEnter = await actFast(page, { action: 'press', selector: '#q-safe', key: 'Enter', allowSubmit: false });
    assert.equal(safeEnter.ok, true);

    const allowedEnter = await actFast(page, { action: 'press', selector: '#first', key: 'Enter', allowSubmit: true });
    assert.equal(allowedEnter.ok, true);

    const submitCounts = await evaluateJs(page, {
      expression: '({ edge: window.__edgeSubmitted || 0, safe: window.__safeSearched || 0 })',
    });
    assert.deepEqual(submitCounts.result, { edge: 1, safe: 1 });

    // 4. Async wait for text/selector appearing after action delay (must not throw immediately on count=0).
    await page.setContent(`<!doctype html><html><body>
      <button id="enable-btn" type="button" onclick="setTimeout(() => { const inp = document.getElementById('async-inp'); inp.disabled = false; const p = document.createElement('p'); p.id='async-msg'; p.textContent='Async ready!'; document.body.appendChild(p); }, 250);">Enable</button>
      <input id="async-inp" type="text" disabled />
    </body></html>`);
    const asyncBatch = await batchActions(page, [
      { action: 'click', selector: '#enable-btn' },
      { action: 'wait', text: 'Async ready!', timeoutMs: 4000 },
      { action: 'wait', selector: '#async-msg', timeoutMs: 2000 },
      { action: 'fill', selector: '#async-inp', value: 'loaded-ok' },
    ]);
    assert.equal(asyncBatch.completed, 4);
    const asyncVal = await evaluateJs(page, { expression: 'document.getElementById("async-inp").value' });
    assert.equal(asyncVal.result, 'loaded-ok');
  });

  it('supports CLI flags --version, --help, and --doctor', async () => {
    const runCliFlag = (args) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [ENTRY_PATH, ...args], {
          env: { ...process.env, TURBO_BROWSER_HEADLESS: 'true' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
        child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
        child.on('error', reject);
        child.on('exit', (code) => resolve({ code, stdout, stderr }));
      });

    const verRes = await runCliFlag(['--version']);
    assert.equal(verRes.code, 0);
    assert.equal(verRes.stdout.trim(), '0.4.0');

    const helpRes = await runCliFlag(['--help']);
    assert.equal(helpRes.code, 0);
    assert.ok(helpRes.stdout.includes('--doctor'));
    assert.ok(helpRes.stdout.includes('--allow-submit'));

    const docRes = await runCliFlag(['--doctor']);
    assert.equal(docRes.code, 0);
    const parsed = JSON.parse(docRes.stdout);
    assert.equal(parsed.version, '0.4.0');
    assert.equal(parsed.playwrightLoaded, true);
    assert.equal(parsed.platform, process.platform);
  });

  it('serves MCP JSON-RPC 2.0 over stdio (initialize, tools/list, tools/call)', async () => {
    const child = spawn(process.execPath, [ENTRY_PATH], {
      env: { ...process.env, TURBO_BROWSER_MODE: 'launch', TURBO_BROWSER_HEADLESS: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const pending = new Map();
    let outBuf = '';

    child.stdout.on('data', (chunk) => {
      outBuf += chunk.toString('utf8');
      let nl;
      while ((nl = outBuf.indexOf('\n')) !== -1) {
        const line = outBuf.slice(0, nl).trim();
        outBuf = outBuf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        const resolver = pending.get(msg.id);
        if (resolver) {
          pending.delete(msg.id);
          resolver(msg);
        }
      }
    });

    const callRpc = (id, method, params = {}) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`RPC timeout for ${method}`)), 15000);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });

    try {
      const initRes = await callRpc(1, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      });
      assert.equal(initRes.result.serverInfo.name, 'turbo-browser-mcp');
      assert.equal(initRes.result.serverInfo.version, '0.4.0');

      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

      const listRes = await callRpc(2, 'tools/list');
      const tools = listRes.result.tools;
      assert.equal(tools.length, 10);
      for (const tool of tools) {
        assert.ok(tool.annotations, `${tool.name} missing MCP annotations`);
        assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
      }

      const openRes = await callRpc(3, 'tools/call', {
        name: 'tabs_batch',
        arguments: { operations: [{ action: 'open', url: `${baseUrl}/` }] },
      });
      assert.equal(openRes.result.isError, false);
      const tabPayload = JSON.parse(openRes.result.content[0].text);
      assert.equal(tabPayload.connectionType, 'launch');
      assert.ok(tabPayload.tabs.some((t) => t.url.startsWith(baseUrl)));

      const inspectRes = await callRpc(4, 'tools/call', {
        name: 'inspect_compact',
        arguments: { mode: 'forms', maxChars: 2000 },
      });
      assert.equal(inspectRes.result.isError, false);
      assert.ok(inspectRes.result.content[0].text.includes('Full Name'));

      const fillRpcRes = await callRpc(5, 'tools/call', {
        name: 'smart_fill_form',
        arguments: {
          fields: [{ keys: ['full name'], value: 'Stdio Tester' }],
        },
      });
      assert.equal(fillRpcRes.result.isError, false);
      assert.equal(JSON.parse(fillRpcRes.result.content[0].text).filledCount, 1);

      const actBlockedRpc = await callRpc(6, 'tools/call', {
        name: 'act_fast',
        arguments: { action: 'click', selector: '#submit-btn' },
      });
      assert.equal(actBlockedRpc.result.isError, false);
      assert.equal(JSON.parse(actBlockedRpc.result.content[0].text).blocked, true);

      const batchRpcRes = await callRpc(7, 'tools/call', {
        name: 'batch_actions',
        arguments: { steps: [{ action: 'click', selector: '#next-btn' }] },
      });
      assert.equal(batchRpcRes.result.isError, false);
      assert.equal(JSON.parse(batchRpcRes.result.content[0].text).completed, 1);

      const textRpcRes = await callRpc(8, 'tools/call', {
        name: 'extract_clean_text',
        arguments: { maxChars: 1000 },
      });
      assert.equal(textRpcRes.result.isError, false);
      assert.ok(textRpcRes.result.content[0].text.includes('Senior Full-Stack Application'));

      const evalRpcRes = await callRpc(9, 'tools/call', {
        name: 'evaluate_js',
        arguments: { expression: '() => window.__nextClicked' },
      });
      assert.equal(evalRpcRes.result.isError, false);
      assert.equal(JSON.parse(evalRpcRes.result.content[0].text).result, 1);

      const diagRpcRes = await callRpc(10, 'tools/call', {
        name: 'page_diagnostics',
        arguments: { level: 'all', statusFilter: 'all' },
      });
      assert.equal(diagRpcRes.result.isError, false);
      assert.ok(Array.isArray(JSON.parse(diagRpcRes.result.content[0].text).console));

      const capRpcRes = await callRpc(11, 'tools/call', {
        name: 'capture_page',
        arguments: { returnImage: true },
      });
      assert.equal(capRpcRes.result.isError, false);
      assert.equal(capRpcRes.result.content[1]?.type, 'image');
      assert.equal(capRpcRes.result.content[1]?.mimeType, 'image/png');

      const netRpcRes = await callRpc(12, 'tools/call', {
        name: 'network_session',
        arguments: { cookieAction: 'set', cookies: [{ name: 'rpc_cookie', value: 'ok' }] },
      });
      assert.equal(netRpcRes.result.isError, false);
      assert.equal(JSON.parse(netRpcRes.result.content[0].text).cookiesSet, 1);

      const closeRpcRes = await callRpc(13, 'tools/call', {
        name: 'tabs_batch',
        arguments: { operations: [{ action: 'close_browser' }] },
      });
      assert.equal(closeRpcRes.result.isError, false);
      assert.equal(JSON.parse(closeRpcRes.result.content[0].text).results[0].closed, true);
    } finally {
      child.stdin.end();
      await new Promise((resolve) => child.once('exit', resolve));
    }
  });

  it('supports Content-Length MCP header framing over stdio', async () => {
    const child = spawn(process.execPath, [ENTRY_PATH], {
      env: { ...process.env, TURBO_BROWSER_MODE: 'launch', TURBO_BROWSER_HEADLESS: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let rawBuf = Buffer.alloc(0);
    const messages = [];
    child.stdout.on('data', (chunk) => {
      rawBuf = Buffer.concat([rawBuf, chunk]);
      while (true) {
        const idx = rawBuf.indexOf('\r\n\r\n');
        if (idx === -1) break;
        const header = rawBuf.subarray(0, idx).toString('utf8');
        const m = /Content-Length:\s*(\d+)/i.exec(header);
        if (!m) break;
        const len = Number(m[1]);
        if (rawBuf.length < idx + 4 + len) break;
        const payload = rawBuf.subarray(idx + 4, idx + 4 + len).toString('utf8');
        rawBuf = rawBuf.subarray(idx + 4 + len);
        messages.push(JSON.parse(payload));
      }
    });

    const sendFrame = (obj) => {
      const json = JSON.stringify(obj);
      const bytes = Buffer.byteLength(json, 'utf8');
      child.stdin.write(`Content-Length: ${bytes}\r\n\r\n${json}`);
    };

    try {
      sendFrame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
      sendFrame({ jsonrpc: '2.0', id: 2, method: 'ping' });

      const deadline = Date.now() + 8000;
      while (messages.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.equal(messages.length, 2);
      assert.equal(messages[0].id, 1);
      assert.equal(messages[0].result.serverInfo.name, 'turbo-browser-mcp');
      assert.deepEqual(messages[1].result, {});
    } finally {
      child.stdin.end();
      await new Promise((resolve) => child.once('exit', resolve));
    }
  });
});
