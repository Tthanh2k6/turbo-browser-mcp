#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { BrowserManager } from '../src/browser-manager.mjs';
import {
  actFast,
  batchActions,
  extractCleanText,
  inspectCompact,
  smartFillForm,
} from '../src/dom-engine.mjs';
import { TOOL_DEFINITIONS } from '../src/index.mjs';

function pctSaved(baseline, current) {
  if (!baseline || baseline <= 0) return 0;
  return Number((((baseline - current) / baseline) * 100).toFixed(1));
}

function ratioX(baseline, current) {
  return Number((baseline / Math.max(1, current)).toFixed(2));
}

function sumCumulativeTurnTokens(turnTokenList) {
  const n = turnTokenList.length;
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += (n - i) * turnTokenList[i];
  }
  return total;
}

function countTokensBatch(payloadMap) {
  const keys = Object.keys(payloadMap);
  const pyScript =
    'import sys,json,tiktoken\n' +
    'enc=tiktoken.get_encoding("o200k_base")\n' +
    'data=json.load(sys.stdin)\n' +
    'print(json.dumps({k:len(enc.encode(v)) for k,v in data.items()}))\n';
  const inputJson = JSON.stringify(payloadMap);

  for (const pyBin of ['python', 'python3']) {
    try {
      const res = spawnSync(pyBin, ['-W', 'ignore', '-X', 'utf8', '-c', pyScript], {
        input: inputJson,
        encoding: 'utf8',
        timeout: 8000,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (res.status === 0 && res.stdout) {
        const parsed = JSON.parse(res.stdout.trim());
        if (keys.every((k) => Number.isFinite(parsed[k]))) {
          return { tokenizer: 'tiktoken (o200k_base)', counts: parsed };
        }
      }
    } catch {
      // Fallback below when Python/tiktoken is absent (e.g., minimal CI containers).
    }
  }

  const approxCounts = {};
  for (const k of keys) {
    const text = String(payloadMap[k] ?? '');
    const divisor = k.includes('base64') ? 1.5 : 3.8;
    approxCounts[k] = text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length / divisor));
  }
  return { tokenizer: 'approx-bpe', counts: approxCounts };
}

function makeDeterministicPdfBuffer(targetBytes = 49152) {
  const header = Buffer.from('%PDF-1.4\n% Bench deterministic resume payload\n', 'utf8');
  const footer = Buffer.from('\n%%EOF\n', 'utf8');
  const bodyLen = Math.max(0, targetBytes - header.length - footer.length);
  const body = Buffer.alloc(bodyLen);
  let seed = 0x13579bdf;
  for (let i = 0; i < bodyLen; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    body[i] = seed & 0xff;
  }
  return Buffer.concat([header, body, footer]);
}

function buildDenseHtml() {
  const navLinks = Array.from({ length: 8 }, (_, i) =>
    `<a href="#section-${i}" class="nav-link inline-flex items-center px-3 py-2 text-xs font-medium text-slate-300">Nav Workspace ${i + 1}</a>`
  ).join('\n');
  const rows = Array.from({ length: 140 }, (_, i) =>
    `<div class="flex items-center justify-between border-b border-slate-800 py-2 px-3">` +
    `<span class="badge bg-emerald-900 text-emerald-200 text-xs">ENV-${i % 4}</span>` +
    `<button type="button" id="btn-${i}" class="px-3 py-1.5 rounded bg-slate-800 text-sm text-white hover:bg-slate-700">` +
    `<svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="5"></circle></svg>` +
    `Inventory Action Row Item #${i} - Configure Settings` +
    `</button></div>`
  ).join('\n');
  return `<!doctype html>
<html>
<head><title>Dense SaaS Operations Console</title></head>
<body>
  <header class="top-nav"><nav aria-label="Primary">${navLinks}</nav></header>
  <main>
    <h1>Operations Console</h1>
    <p>Production inventory grid with 140 interactive controls and live dynamic token fields.</p>
    <button id="add-field" type="button" onclick="document.getElementById('host').innerHTML='<input aria-label=DynamicToken type=text placeholder=Token />'">Add Dynamic Field</button>
    <div id="host"></div>
    <section aria-label="Action Rows">${rows}</section>
  </main>
</body>
</html>`;
}

function buildComplexFormHtml() {
  const chromeLinks = Array.from({ length: 24 }, (_, i) =>
    `<a href="#guide-${i}" class="text-xs text-slate-500">Application Policy Section ${i + 1}</a>`
  ).join(' ');
  const faqItems = Array.from({ length: 12 }, (_, i) =>
    `<p class="help-item">Guideline #${i + 1}: verify work authorization, portfolio links, and availability window before submitting.</p>`
  ).join('\n');
  const countries = [
    ['', 'Select Country'],
    ['vn', 'Vietnam'],
    ['sg', 'Singapore'],
    ['jp', 'Japan'],
    ['us', 'United States'],
    ['ca', 'Canada'],
    ['de', 'Germany'],
    ['au', 'Australia'],
  ]
    .map(([v, label]) => `<option value="${v}">${label}</option>`)
    .join('');

  return `<!doctype html>
<html>
<head><title>Senior Engineer Application Form</title></head>
<body>
  <header><nav aria-label="Header Links">${chromeLinks}</nav></header>
  <aside aria-label="Candidate FAQ">${faqItems}</aside>
  <main>
    <h1>Senior Engineer Application</h1>
    <form id="bench-form" onsubmit="event.preventDefault()">
      <div><label for="f-name">Full Name</label><input id="f-name" type="text" required /></div>
      <div><label for="f-email">Email Address</label><input id="f-email" type="email" required /></div>
      <div><label for="f-phone">Phone Number</label><input id="f-phone" type="tel" /></div>
      <div><label for="f-url">Portfolio URL</label><input id="f-url" type="url" /></div>
      <div><label for="f-date">Availability Date</label><input id="f-date" type="date" /></div>
      <div><label for="f-country">Country</label><select id="f-country">${countries}</select></div>
      <fieldset>
        <legend>Experience Level</legend>
        <label><input id="exp-0" type="radio" name="exp" value="0-1" /> 0-1 years</label>
        <label><input id="exp-2" type="radio" name="exp" value="2-4" /> 2-4 years</label>
        <label><input id="exp-5" type="radio" name="exp" value="5+" /> 5+ years</label>
        <label><input id="exp-10" type="radio" name="exp" value="10+" /> 10+ years</label>
      </fieldset>
      <div><label><input id="f-remote" type="checkbox" /> Open to remote work</label></div>
      <div>
        <label id="lbl-note">Cover Note</label>
        <div id="f-note" contenteditable="true" role="textbox" aria-label="Cover Note" style="min-height:48px;border:1px solid #999"></div>
      </div>
      <div><label><input id="f-terms" type="checkbox" /> Accept Terms</label></div>
      <div style="margin-top:12px">
        <label for="f-resume">Resume PDF</label><input id="f-resume" type="file" accept=".pdf" />
      </div>
      <button type="submit">Submit Application</button>
    </form>
  </main>
</body>
</html>`;
}

const WORKFLOW_HTML = `<!doctype html>
<html>
<head><title>Filter Drawer Workflow</title></head>
<body>
  <header>
    <a href="#dash">Dashboard</a>
    <a href="#reports">Reports</a>
    <a href="#billing">Billing</a>
    <a href="#audit">Audit Log</a>
  </header>
  <main>
    <h1>Project Filter Workflow</h1>
    <button id="open-drawer" type="button" onclick="document.getElementById('drawer').hidden=false">Open Filters</button>
    <div id="drawer" hidden>
      <div role="tablist">
        <button id="tab-general" type="button">General</button>
        <button id="tab-filters" type="button" onclick="document.getElementById('filter-pane').hidden=false">Advanced Filters</button>
      </div>
      <div id="filter-pane" hidden>
        <label for="search-q">Search Query</label>
        <input id="search-q" type="text" />
        <label><input id="only-active" type="checkbox" /> Active Only</label>
        <div id="wf-list" tabindex="0" role="listbox" aria-label="Sort Results"
          onkeydown="if(event.key==='ArrowDown'){document.getElementById('workflow-done').hidden=false;}">
          <div>Result Order: Relevance</div>
          <div>Result Order: Updated</div>
        </div>
      </div>
    </div>
    <div id="workflow-done" hidden>Filter pipeline ready</div>
  </main>
</body>
</html>`;

function buildHeavyArticleHtml() {
  const nav = Array.from({ length: 16 }, (_, i) => `<a href="/nav/${i}">Category ${i + 1}</a>`).join(' | ');
  const sidebar = Array.from({ length: 24 }, (_, i) =>
    `<div class="promo-card"><h4>Sponsored Link ${i + 1}</h4><p>Related newsletter subscription item ${i + 1} with tracking metadata.</p></div>`
  ).join('\n');
  const fillerRows = Array.from({ length: 40 }, (_, i) =>
    `<tr data-meta="row-${i}"><td>Feature_${i + 1}</td><td>Passed</td><td>${10 + (i % 15)} ms</td></tr>`
  ).join('\n');
  const nextData = JSON.stringify({
    props: {
      pageProps: {
        flags: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`exp_flag_${i}`, i % 2 === 0])),
        telemetryTokens: Array.from({ length: 30 }, (_, i) => `tok_0000${i}_abcdef`),
      },
    },
  });
  const imgs = Array.from({ length: 8 }, (_, i) =>
    `<img src="/slow-img/${i}.png" alt="Hero ${i}" width="64" height="64" />`
  ).join('\n');

  return `<!doctype html>
<html>
<head>
  <title>Engineering Benchmark Report</title>
  <style>
    @font-face {
      font-family: 'BenchSans';
      src: url('/slow-font/inter.woff2') format('woff2');
    }
    body { font-family: 'BenchSans', sans-serif; }
  </style>
</head>
<body>
  <header><nav>${nav}</nav></header>
  <aside>${sidebar}</aside>
  <main>
    <article>
      <h1>Cutting MCP Browser Context and Latency</h1>
      <p>Browser agents stall when full accessibility trees repeat on every step.</p>
      <h2>Core Architecture</h2>
      <ul>
        <li>Deterministic frame-scoped DOM refs capped at maxChars</li>
        <li>Single-turn multi-field form prefill with React value tracker sync</li>
        <li>Non-Base64 local disk uploads via Playwright setInputFiles</li>
      </ul>
      <h2>Benchmark Metrics</h2>
      <table>
        <thead><tr><th>Check</th><th>Status</th><th>Time</th></tr></thead>
        <tbody>
          <tr><td>Snapshot Cap</td><td>Passed</td><td>12 ms</td></tr>
          <tr><td>Submit Guard</td><td>Passed</td><td>18 ms</td></tr>
        </tbody>
      </table>
      <pre><code>npm test -- --test-concurrency=4</code></pre>
      <blockquote>Keep destructive submits gated behind allowSubmit=true.</blockquote>
    </article>
    <section hidden aria-hidden="true"><table>${fillerRows}</table></section>
    <div>${imgs}</div>
    <div id="diag-ready" data-done="0">pending</div>
  </main>
  <footer>Copyright Example Engineering Blog | Privacy | Terms | Cookie Settings</footer>
  <script id="__NEXT_DATA__" type="application/json">${nextData}</script>
  <script>
    (async () => {
      for (let i = 0; i < 20; i++) console.log('static telemetry trace #' + i + ' loaded module chunk-' + i);
      console.error('OrderAPI 500: upstream gateway timeout on /api/v1/orders');
      console.error('AuthRefreshError: session token check returned 500');
      const jobs = [];
      for (let i = 0; i < 20; i++) jobs.push(fetch('/static/chunk-' + i + '.js').catch(() => {}));
      jobs.push(fetch('/api/v1/orders').catch(() => {}));
      jobs.push(fetch('/api/v1/orders?retry=1').catch(() => {}));
      await Promise.all(jobs);
      const el = document.getElementById('diag-ready');
      el.dataset.done = '1';
      el.textContent = 'ready';
    })();
  </script>
</body>
</html>`;
}

function startServer() {
  const denseHtml = buildDenseHtml();
  const complexFormHtml = buildComplexFormHtml();
  const heavyArticleHtml = buildHeavyArticleHtml();
  const dummyPng = Buffer.alloc(32 * 1024, 0x89);
  const dummyFont = Buffer.alloc(48 * 1024, 0x77);
  const telemetry = {
    assetBytes: 0,
    assetHits: 0,
    trackAssets: false,
  };

  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const u = parsedUrl.pathname;

    if (u.startsWith('/slow-img/')) {
      setTimeout(() => {
        if (telemetry.trackAssets) {
          telemetry.assetBytes += dummyPng.length;
          telemetry.assetHits += 1;
        }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        res.end(dummyPng);
      }, 50);
      return;
    }
    if (u === '/slow-font/inter.woff2') {
      setTimeout(() => {
        if (telemetry.trackAssets) {
          telemetry.assetBytes += dummyFont.length;
          telemetry.assetHits += 1;
        }
        res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'no-store' });
        res.end(dummyFont);
      }, 50);
      return;
    }
    if (u.startsWith('/static/')) {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
      res.end(`/* chunk ${u} */ window.__chunkLoaded = (window.__chunkLoaded || 0) + 1;`);
      return;
    }
    if (u === '/api/v1/orders') {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Upstream database connection timed out', code: 'E_DB_TIMEOUT' }));
      return;
    }
    if (u === '/net-tab') {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Tab ${parsedUrl.searchParams.get('i') || ''}</title></head><body><h1>Tab Ready</h1></body></html>`);
      }, 60);
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (u === '/dense') return res.end(denseHtml);
    if (u === '/complex-form') return res.end(complexFormHtml);
    if (u === '/workflow') return res.end(WORKFLOW_HTML);
    if (u === '/heavy-article') return res.end(heavyArticleHtml);
    return res.end('<!doctype html><html><head><title>Warmup</title></head><body><h1>Ready</h1></body></html>');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}`, telemetry });
    });
  });
}

async function runBenchmark() {
  const { server, baseUrl, telemetry } = await startServer();
  const manager = new BrowserManager({ mode: 'launch', headless: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-bench-'));
  const tokenPayloads = {};

  try {
    // Warm up Chromium + context once outside timed scenarios.
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/warmup`, waitUntil: 'load' }]);

    // S1: Dense 140-Control SaaS Console Snapshot & Delta
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/dense`, waitUntil: 'load' }]);
    const { page: densePage } = await manager.getPage();
    const snapState = manager.getSnapshotState(densePage);
    const rawHtmlDense = await densePage.evaluate(() => document.documentElement.outerHTML);
    const fullAriaDense = await densePage.locator('body').ariaSnapshot();

    const s1CompactT0 = Date.now();
    const compactSnap = await inspectCompact(densePage, { mode: 'interactive', maxChars: 4000 }, snapState);
    const s1CompactMs = Date.now() - s1CompactT0;
    assert.ok(compactSnap.charCount <= 4000, 'compact snapshot exceeded 4000 maxChars');

    await actFast(densePage, { action: 'click', selector: '#add-field' }, snapState);
    const fullAriaDenseAfter = await densePage.locator('body').ariaSnapshot();
    const s1DeltaT0 = Date.now();
    const deltaSnap = await inspectCompact(
      densePage,
      { mode: 'interactive', onlyChanged: true, maxChars: 4000 },
      snapState
    );
    const s1DeltaMs = Date.now() - s1DeltaT0;
    assert.ok(deltaSnap.text.includes('DynamicToken'), 'delta snapshot missing newly added DynamicToken field');

    tokenPayloads.s1_rawHtml = rawHtmlDense;
    tokenPayloads.s1_fullAria = fullAriaDense;
    tokenPayloads.s1_compact = compactSnap.text;
    tokenPayloads.s1_fullAriaAfter = fullAriaDenseAfter;
    tokenPayloads.s1_delta = deltaSnap.text;

    // S2: Complex 10-Field Application Form (11-Turn Step-by-Step vs 1-Turn smart_fill_form)
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/complex-form`, waitUntil: 'load' }]);
    const { page: stepFormPage } = await manager.getPage();
    const stepActions = [
      { action: 'fill', selector: '#f-name', value: 'Trung Thanh' },
      { action: 'fill', selector: '#f-email', value: 'bench@example.com' },
      { action: 'fill', selector: '#f-phone', value: '+84-900-123-456' },
      { action: 'fill', selector: '#f-url', value: 'https://github.com/Tthanh2k6' },
      { action: 'fill', selector: '#f-date', value: '2026-12-01' },
      { action: 'select', selector: '#f-country', value: 'vn' },
      { action: 'check', selector: '#exp-5' },
      { action: 'check', selector: '#f-remote' },
      { action: 'fill', selector: '#f-note', value: 'Automated 10-field form benchmark note.' },
      { action: 'check', selector: '#f-terms' },
    ];

    const s2SeqTurnPayloads = [];
    const s2SeqT0 = Date.now();
    s2SeqTurnPayloads.push(await stepFormPage.locator('body').ariaSnapshot());
    for (const step of stepActions) {
      await actFast(stepFormPage, step);
      const snapText = await stepFormPage.locator('body').ariaSnapshot();
      s2SeqTurnPayloads.push(JSON.stringify(step) + '\n' + snapText);
    }
    const s2SeqMs = Date.now() - s2SeqT0;

    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/complex-form`, waitUntil: 'load' }]);
    const { page: batchFormPage } = await manager.getPage();
    const s2BatchArgs = {
      fields: [
        { keys: ['full name'], value: 'Trung Thanh' },
        { keys: ['email'], value: 'bench@example.com' },
        { keys: ['phone'], value: '+84-900-123-456' },
        { keys: ['portfolio'], value: 'https://github.com/Tthanh2k6' },
        { keys: ['availability'], value: '2026-12-01' },
        { keys: ['country'], option: 'Vietnam' },
        { check: '5+ years' },
        { check: 'Open to remote work' },
        { keys: ['cover note'], value: 'Automated 10-field form benchmark note.' },
        { check: 'Accept Terms' },
      ],
      returnSnapshot: true,
      snapshotMode: 'forms',
    };
    const s2BatchT0 = Date.now();
    const s2BatchRes = await smartFillForm(batchFormPage, s2BatchArgs);
    const s2BatchMs = Date.now() - s2BatchT0;
    assert.equal(s2BatchRes.filledCount, 10, `expected filledCount=10, got ${s2BatchRes.filledCount}`);

    s2SeqTurnPayloads.forEach((p, idx) => {
      tokenPayloads[`s2_seq_t${idx}`] = p;
    });
    tokenPayloads.s2_turbo = JSON.stringify(s2BatchArgs) + '\n' + JSON.stringify(s2BatchRes);

    // S3: 48 KiB Resume PDF Upload (Inline Base64 Tool Call vs Direct Disk Path)
    const pdfBytes = 49152;
    const pdfBuf = makeDeterministicPdfBuffer(pdfBytes);
    const pdfPath = path.join(tmpDir, 'Trung_Thanh_Resume.pdf');
    fs.writeFileSync(pdfPath, pdfBuf);

    const inlineBase64Payload = JSON.stringify({
      name: 'upload_inline',
      arguments: {
        selector: '#f-resume',
        fileName: 'Trung_Thanh_Resume.pdf',
        mimeType: 'application/pdf',
        file_base64: pdfBuf.toString('base64'),
      },
    });
    const s3T0 = Date.now();
    const uploadRes = await actFast(batchFormPage, {
      action: 'upload',
      selector: '#f-resume',
      file: pdfPath,
    });
    const s3Ms = Date.now() - s3T0;
    const uploadedMeta = await batchFormPage.evaluate(() => {
      const f = document.getElementById('f-resume')?.files?.[0];
      return f ? { name: f.name, size: f.size } : null;
    });
    assert.equal(uploadRes.ok, true);
    assert.equal(uploadedMeta?.size, pdfBytes, 'PDF size mismatch after direct disk upload');

    const diskPathPayload = JSON.stringify({
      name: 'act_fast',
      arguments: { action: 'upload', selector: '#f-resume', file: pdfPath },
    });
    const diskResultPayload = JSON.stringify(uploadRes);
    tokenPayloads.s3_base64 = inlineBase64Payload;
    tokenPayloads.s3_disk = diskPathPayload + '\n' + diskResultPayload;

    // S4: 6-Step Interactive UI Workflow (6-Turn Step-by-Step vs 1-Turn batch_actions)
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/workflow`, waitUntil: 'load' }]);
    const { page: seqWfPage } = await manager.getPage();
    const wfSteps = [
      { action: 'click', selector: '#open-drawer' },
      { action: 'click', selector: '#tab-filters' },
      { action: 'fill', selector: '#search-q', value: 'playwright' },
      { action: 'check', selector: '#only-active' },
      { action: 'press', selector: '#wf-list', key: 'ArrowDown' },
      { action: 'wait', selector: '#workflow-done', state: 'visible' },
    ];
    const s4SeqTurnPayloads = [];
    const s4SeqT0 = Date.now();
    for (const step of wfSteps) {
      await actFast(seqWfPage, step);
      const snapText = await seqWfPage.locator('body').ariaSnapshot();
      s4SeqTurnPayloads.push(JSON.stringify(step) + '\n' + snapText);
    }
    const s4SeqMs = Date.now() - s4SeqT0;
    assert.equal(await seqWfPage.locator('#workflow-done').isVisible(), true);

    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/workflow`, waitUntil: 'load' }]);
    const { page: batchWfPage } = await manager.getPage();
    const s4BatchT0 = Date.now();
    const s4BatchRes = await batchActions(batchWfPage, wfSteps, {
      returnSnapshot: true,
      snapshotMode: 'interactive',
    });
    const s4BatchMs = Date.now() - s4BatchT0;
    assert.equal(s4BatchRes.completed, 6, `expected 6 completed steps, got ${s4BatchRes.completed}`);
    assert.equal(await batchWfPage.locator('#workflow-done').isVisible(), true);

    s4SeqTurnPayloads.forEach((p, idx) => {
      tokenPayloads[`s4_seq_t${idx}`] = p;
    });
    tokenPayloads.s4_turbo = JSON.stringify({ steps: wfSteps, returnSnapshot: true }) + '\n' + JSON.stringify(s4BatchRes);

    // S5: Parallel 6-Tab Opening (60 ms simulated TTFB per tab)
    const tabUrls = [1, 2, 3, 4, 5, 6].map((i) => `${baseUrl}/net-tab?i=${i}`);
    const s5SeqT0 = Date.now();
    for (const u of tabUrls) {
      await manager.tabsBatch([{ action: 'open', url: u, waitUntil: 'domcontentloaded' }]);
    }
    const s5SeqMs = Date.now() - s5SeqT0;

    const s5ParT0 = Date.now();
    const s5ParOut = await manager.tabsBatch([
      { action: 'open_many', urls: tabUrls, concurrency: 6, waitUntil: 'domcontentloaded' },
    ]);
    const s5ParMs = Date.now() - s5ParT0;
    const openedOkCount = (s5ParOut.results?.[0]?.opened || []).filter((o) => o.ok).length;
    assert.equal(openedOkCount, 6, `open_many did not open all 6 tabs (${openedOkCount})`);

    // S6: Heavy Asset Page Load (preset: "turbo" vs "clean"), Markdown Scraping, & Diagnostics
    telemetry.assetBytes = 0;
    telemetry.assetHits = 0;
    telemetry.trackAssets = true;
    const s6CleanT0 = Date.now();
    const cleanBatch = await manager.tabsBatch([
      { action: 'open', url: `${baseUrl}/heavy-article`, waitUntil: 'load' },
    ]);
    const cleanTabId = cleanBatch.results?.[0]?.tabId;
    const s6CleanMs = Date.now() - s6CleanT0;
    telemetry.trackAssets = false;
    const cleanAssetBytes = telemetry.assetBytes;
    const cleanAssetHits = telemetry.assetHits;
    const { page: cleanArticlePage } = await manager.getPage(cleanTabId);
    await cleanArticlePage.waitForSelector('#diag-ready[data-done="1"]', { timeout: 5000 });

    const turboOpenBatch = await manager.tabsBatch([
      { action: 'open', url: `${baseUrl}/warmup`, waitUntil: 'domcontentloaded' },
    ]);
    const turboTabId = turboOpenBatch.results?.[0]?.tabId;
    await manager.manageNetworkSession(turboTabId, { preset: 'turbo' });

    telemetry.assetBytes = 0;
    telemetry.assetHits = 0;
    telemetry.trackAssets = true;
    const s6TurboT0 = Date.now();
    await manager.tabsBatch([
      { action: 'navigate', tabId: turboTabId, url: `${baseUrl}/heavy-article`, waitUntil: 'load' },
    ]);
    const s6TurboMs = Date.now() - s6TurboT0;
    telemetry.trackAssets = false;
    const turboAssetBytes = telemetry.assetBytes;
    const turboAssetHits = telemetry.assetHits;
    assert.equal(turboAssetBytes, 0, `expected 0 media bytes in turbo mode, saw ${turboAssetBytes}`);
    await manager.manageNetworkSession(turboTabId, { preset: 'clean' });

    // S6b: Article Extraction (extract_clean_text Markdown vs Raw HTML)
    const rawArticleHtml = await cleanArticlePage.evaluate(() => document.documentElement.outerHTML);
    const mdExtract = await extractCleanText(cleanArticlePage, { format: 'markdown', maxChars: 6000 });
    assert.ok(mdExtract.text.includes('Cutting MCP Browser Context'), 'extracted markdown missing article heading');

    tokenPayloads.s6b_rawHtml = rawArticleHtml;
    tokenPayloads.s6b_markdown = mdExtract.text;

    // S6c: Diagnostics Filtering (default errors-only vs unfiltered all + includeStatic)
    const diagAll = await manager.getDiagnostics(cleanTabId, {
      level: 'all',
      statusFilter: 'all',
      includeStatic: true,
    });
    const diagFiltered = await manager.getDiagnostics(cleanTabId, {
      level: 'errors',
      statusFilter: 'errors',
      includeStatic: false,
    });
    const diagAllStr = JSON.stringify(diagAll);
    const diagFilteredStr = JSON.stringify(diagFiltered);
    assert.ok(diagAll.requests.length >= 20, 'expected >= 20 buffered requests in unfiltered diagnostics');
    assert.equal(diagFiltered.requests.length, 2, `expected 2 failing requests in filtered diagnostics, got ${diagFiltered.requests.length}`);

    tokenPayloads.s6c_diagAll = diagAllStr;
    tokenPayloads.s6c_diagFiltered = diagFilteredStr;

    // S7: MCP Tool Schema Footprint
    const toolSchemaStr = JSON.stringify(TOOL_DEFINITIONS);
    tokenPayloads.s7_toolSchema = toolSchemaStr;
    const compactToolSchemaStr = JSON.stringify(TOOL_DEFINITIONS.map(({ annotations, ...tool }) => tool));
    tokenPayloads.s7_toolSchemaCompact = compactToolSchemaStr;

    const { tokenizer, counts } = countTokensBatch(tokenPayloads);

    const s2SeqDirectTokens = s2SeqTurnPayloads.reduce((acc, _, idx) => acc + counts[`s2_seq_t${idx}`], 0);
    const s2SeqCumulativeTokens = sumCumulativeTurnTokens(
      s2SeqTurnPayloads.map((_, idx) => counts[`s2_seq_t${idx}`])
    );
    const s2SeqChars = s2SeqTurnPayloads.reduce((acc, p) => acc + p.length, 0);
    const s2TurboChars = tokenPayloads.s2_turbo.length;

    const s4SeqDirectTokens = s4SeqTurnPayloads.reduce((acc, _, idx) => acc + counts[`s4_seq_t${idx}`], 0);
    const s4SeqCumulativeTokens = sumCumulativeTurnTokens(
      s4SeqTurnPayloads.map((_, idx) => counts[`s4_seq_t${idx}`])
    );
    const s4SeqChars = s4SeqTurnPayloads.reduce((acc, p) => acc + p.length, 0);
    const s4TurboChars = tokenPayloads.s4_turbo.length;

    const results = {
      tokenizer,
      s1_snapshot: {
        rawHtmlChars: rawHtmlDense.length,
        rawHtmlTokens: counts.s1_rawHtml,
        fullAriaChars: fullAriaDense.length,
        fullAriaTokens: counts.s1_fullAria,
        compactChars: compactSnap.charCount,
        compactTokens: counts.s1_compact,
        compactMs: s1CompactMs,
        compactSavedVsRawHtmlPct: pctSaved(counts.s1_rawHtml, counts.s1_compact),
        compactSavedVsFullAriaPct: pctSaved(counts.s1_fullAria, counts.s1_compact),
        fullAriaAfterChars: fullAriaDenseAfter.length,
        fullAriaAfterTokens: counts.s1_fullAriaAfter,
        deltaChars: deltaSnap.charCount,
        deltaTokens: counts.s1_delta,
        deltaMs: s1DeltaMs,
        deltaSavedVsFullAriaPct: pctSaved(counts.s1_fullAriaAfter, counts.s1_delta),
        deltaSavedVsRawHtmlPct: pctSaved(counts.s1_rawHtml, counts.s1_delta),
      },
      s2_form10Fields: {
        stepByStepTurns: s2SeqTurnPayloads.length,
        stepByStepMs: s2SeqMs,
        stepByStepChars: s2SeqChars,
        stepByStepDirectTokens: s2SeqDirectTokens,
        stepByStepCumulativeTokens: s2SeqCumulativeTokens,
        turboTurns: 1,
        turboMs: s2BatchMs,
        turboChars: s2TurboChars,
        turboTokens: counts.s2_turbo,
        filledCount: s2BatchRes.filledCount,
        speedupX: ratioX(s2SeqMs, s2BatchMs),
        directTokenSavedPct: pctSaved(s2SeqDirectTokens, counts.s2_turbo),
        cumulativeTokenSavedPct: pctSaved(s2SeqCumulativeTokens, counts.s2_turbo),
      },
      s3_pdf48KiBUpload: {
        fileBytes: pdfBytes,
        base64Chars: inlineBase64Payload.length,
        base64ArgTokens: counts.s3_base64,
        diskPayloadChars: tokenPayloads.s3_disk.length,
        diskPayloadTokens: counts.s3_disk,
        uploadMs: s3Ms,
        tokenSavedPct: pctSaved(counts.s3_base64, counts.s3_disk),
      },
      s4_workflow6Steps: {
        stepByStepTurns: s4SeqTurnPayloads.length,
        stepByStepMs: s4SeqMs,
        stepByStepChars: s4SeqChars,
        stepByStepDirectTokens: s4SeqDirectTokens,
        stepByStepCumulativeTokens: s4SeqCumulativeTokens,
        turboTurns: 1,
        turboMs: s4BatchMs,
        turboChars: s4TurboChars,
        turboTokens: counts.s4_turbo,
        completedSteps: s4BatchRes.completed,
        speedupX: ratioX(s4SeqMs, s4BatchMs),
        directTokenSavedPct: pctSaved(s4SeqDirectTokens, counts.s4_turbo),
        cumulativeTokenSavedPct: pctSaved(s4SeqCumulativeTokens, counts.s4_turbo),
      },
      s5_multiTab6Urls: {
        simulatedTtfbMs: 60,
        sequentialTurns: 6,
        sequentialMs: s5SeqMs,
        parallelTurns: 1,
        parallelOpenManyMs: s5ParMs,
        speedupX: ratioX(s5SeqMs, s5ParMs),
      },
      s6a_heavyLoadTurboPreset: {
        cleanMs: s6CleanMs,
        cleanAssetHits,
        cleanAssetBytes,
        turboMs: s6TurboMs,
        turboAssetHits,
        turboAssetBytes,
        speedupX: ratioX(s6CleanMs, s6TurboMs),
        mediaBytesSavedPct: pctSaved(cleanAssetBytes, turboAssetBytes),
      },
      s6b_articleMarkdown: {
        rawHtmlChars: rawArticleHtml.length,
        rawHtmlTokens: counts.s6b_rawHtml,
        markdownChars: mdExtract.charCount,
        markdownTokens: counts.s6b_markdown,
        tokenSavedPct: pctSaved(counts.s6b_rawHtml, counts.s6b_markdown),
      },
      s6c_diagnosticsFilter: {
        unfilteredRequests: diagAll.requests.length,
        unfilteredConsole: diagAll.console.length,
        unfilteredChars: diagAllStr.length,
        unfilteredTokens: counts.s6c_diagAll,
        filteredRequests: diagFiltered.requests.length,
        filteredConsole: diagFiltered.console.length,
        filteredChars: diagFilteredStr.length,
        filteredTokens: counts.s6c_diagFiltered,
        tokenSavedPct: pctSaved(counts.s6c_diagAll, counts.s6c_diagFiltered),
      },
      s7_toolSchema: {
        toolCount: TOOL_DEFINITIONS.length,
        schemaChars: toolSchemaStr.length,
        schemaTokens: counts.s7_toolSchema,
        compactSchemaChars: compactToolSchemaStr.length,
        compactSchemaTokens: counts.s7_toolSchemaCompact,
      },
    };

    console.log(`=== turbo-browser-mcp Benchmark (Chromium headless | tokenizer=${tokenizer}) ===\n`);
    console.log('| Scenario | Baseline | turbo-browser-mcp | Measured Savings |');
    console.log('| :--- | :--- | :--- | :--- |');
    console.log(
      `| S1a. Dense 140-btn snapshot | ${results.s1_snapshot.rawHtmlTokens} tok HTML / ${results.s1_snapshot.fullAriaTokens} tok ARIA | ${results.s1_snapshot.compactTokens} tok compact (${results.s1_snapshot.compactMs} ms) | ${results.s1_snapshot.compactSavedVsRawHtmlPct}% vs HTML / ${results.s1_snapshot.compactSavedVsFullAriaPct}% vs ARIA |`
    );
    console.log(
      `| S1b. Post-click delta (onlyChanged) | ${results.s1_snapshot.fullAriaAfterTokens} tok full ARIA | ${results.s1_snapshot.deltaTokens} tok delta (${results.s1_snapshot.deltaMs} ms) | ${results.s1_snapshot.deltaSavedVsFullAriaPct}% tokens saved |`
    );
    console.log(
      `| S2. 10-field complex form fill | 11 turns (${results.s2_form10Fields.stepByStepMs} ms, ${results.s2_form10Fields.stepByStepDirectTokens} dir / ${results.s2_form10Fields.stepByStepCumulativeTokens} cum tok) | 1 turn (${results.s2_form10Fields.turboMs} ms, ${results.s2_form10Fields.turboTokens} tok) | ${results.s2_form10Fields.speedupX}x faster, ${results.s2_form10Fields.directTokenSavedPct}% dir / ${results.s2_form10Fields.cumulativeTokenSavedPct}% cum tok saved |`
    );
    console.log(
      `| S3. 48 KiB PDF file upload | ${results.s3_pdf48KiBUpload.base64ArgTokens} tok inline Base64 | ${results.s3_pdf48KiBUpload.diskPayloadTokens} tok disk path (${results.s3_pdf48KiBUpload.uploadMs} ms) | ${results.s3_pdf48KiBUpload.tokenSavedPct}% tokens saved |`
    );
    console.log(
      `| S4. 6-step UI filter workflow | 6 turns (${results.s4_workflow6Steps.stepByStepMs} ms, ${results.s4_workflow6Steps.stepByStepDirectTokens} dir / ${results.s4_workflow6Steps.stepByStepCumulativeTokens} cum tok) | 1 turn (${results.s4_workflow6Steps.turboMs} ms, ${results.s4_workflow6Steps.turboTokens} tok) | ${results.s4_workflow6Steps.speedupX}x faster, ${results.s4_workflow6Steps.directTokenSavedPct}% dir / ${results.s4_workflow6Steps.cumulativeTokenSavedPct}% cum tok saved |`
    );
    console.log(
      `| S5. Open 6 tabs (60ms TTFB) | 6 turns (${results.s5_multiTab6Urls.sequentialMs} ms sequential) | 1 turn (${results.s5_multiTab6Urls.parallelOpenManyMs} ms open_many) | 6x fewer turns, ${results.s5_multiTab6Urls.speedupX}x faster |`
    );
    console.log(
      `| S6a. Heavy asset page load (8 imgs + font) | ${results.s6a_heavyLoadTurboPreset.cleanMs} ms (${Math.round(cleanAssetBytes / 1024)} KiB clean) | ${results.s6a_heavyLoadTurboPreset.turboMs} ms (0 KiB turbo) | ${results.s6a_heavyLoadTurboPreset.speedupX}x faster, ${results.s6a_heavyLoadTurboPreset.mediaBytesSavedPct}% media saved |`
    );
    console.log(
      `| S6b. Article Markdown scraping | ${results.s6b_articleMarkdown.rawHtmlTokens} tok raw HTML | ${results.s6b_articleMarkdown.markdownTokens} tok Markdown | ${results.s6b_articleMarkdown.tokenSavedPct}% tokens saved |`
    );
    console.log(
      `| S6c. Diagnostics error filter | ${results.s6c_diagnosticsFilter.unfilteredTokens} tok unfiltered (${diagAll.requests.length} reqs) | ${results.s6c_diagnosticsFilter.filteredTokens} tok errors-only (${diagFiltered.requests.length} reqs) | ${results.s6c_diagnosticsFilter.tokenSavedPct}% tokens saved |`
    );
    console.log(
      `| S7. Static MCP tool schema | — | ${results.s7_toolSchema.toolCount} tools (${results.s7_toolSchema.schemaTokens} full / ${results.s7_toolSchema.compactSchemaTokens} compact tok) | Compact excludes annotations |`
    );
    console.log('\nRaw JSON:\n' + JSON.stringify(results, null, 2));
  } finally {
    await manager.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runBenchmark().catch((err) => {
  console.error(err);
  process.exit(1);
});
