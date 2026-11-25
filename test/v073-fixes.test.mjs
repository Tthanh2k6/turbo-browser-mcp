import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, batchActions, inspectCompact, smartFillForm } from '../src/dom-engine.mjs';
import { TOOL_DEFINITIONS, dispatchToolCall } from '../src/index.mjs';

const COMBO_FILE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Application Portal</title></head>
<body>
  <main>
    <form id="app-form" onsubmit="event.preventDefault(); location.href='/receipt-one-btn'">
      <div class="field">
        <label for="applicant-name">Full Name</label>
        <input id="applicant-name" type="text" required />
      </div>

      <div class="field">
        <button id="region-combo" type="button" role="combobox" aria-label="Region" aria-expanded="false"
          onclick="const lb=document.getElementById('region-list'); lb.hidden=!lb.hidden; this.setAttribute('aria-expanded', String(!lb.hidden));">Choose region</button>
        <ul id="region-list" role="listbox" hidden>
          <li role="option" onclick="const b=document.getElementById('region-combo'); b.textContent='Region 150'; this.parentElement.hidden=true; b.setAttribute('aria-expanded','false');">Region 150</li>
          <li role="option" onclick="const b=document.getElementById('region-combo'); b.textContent='Region 200'; this.parentElement.hidden=true; b.setAttribute('aria-expanded','false');">Region 200</li>
        </ul>
      </div>

      <div id="same-label-combo" role="combobox" aria-label="Department">Department</div>
      <div id="plan-popup" aria-haspopup="listbox" aria-label="Plan">Enterprise</div>

      <div class="field">
        <label for="resume-file">Attachment</label>
        <input id="resume-file" type="file" aria-label="Attachment" required />
      </div>

      <div class="field">
        <label for="multi-file">Supporting Docs</label>
        <input id="multi-file" type="file" aria-label="Supporting Docs" multiple />
      </div>

      <button id="submit-app" type="submit">Submit Application</button>
    </form>
  </main>
</body></html>`;

const CATALOG_SEARCH_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Catalog Search</title></head>
<body>
  <main>
    <label for="q">Keyword</label>
    <input id="q" type="text" />
    <label><input id="in-stock" type="checkbox" /> In-stock only</label>
    <button id="search-btn" type="button" onclick="
      const q = document.getElementById('q').value;
      const stock = document.getElementById('in-stock').checked;
      document.getElementById('results').textContent = 'Showing 3 results for ' + q + (stock ? ' (in-stock)' : '');
    ">Search</button>
    <button id="reset-btn" type="button" onclick="document.getElementById('q').value='';">Reset</button>
    <div id="results">Enter a query above.</div>
  </main>
</body></html>`;

const COMMENT_EDITOR_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Discussion Thread</title></head>
<body>
  <main>
    <div id="feed"></div>
    <div id="comment-editor" contenteditable="true" role="textbox" aria-label="Add a comment" style="min-height:40px;border:1px solid #ccc"></div>
    <textarea id="draft-notes" aria-label="Draft notes"></textarea>
    <input id="tag-input" type="text" aria-label="Tag" />
    <button id="post-comment" type="button" onclick="
      const txt = document.getElementById('comment-editor').innerText.trim();
      const tag = document.getElementById('tag-input').value.trim();
      const item = document.createElement('div');
      item.className = 'posted-item';
      item.textContent = txt + (tag ? ' #' + tag : '');
      document.getElementById('feed').appendChild(item);
    ">Post</button>
  </main>
</body></html>`;

const LABEL_TARGET_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Label Resolution</title></head>
<body>
  <main>
    <label for="reply-area">Reply to a comment...</label>
    <textarea id="reply-area"></textarea>
    <input id="aria-input" type="text" aria-label="Filter by author" />
    <input id="ph-input" type="text" placeholder="Quick search..." />
  </main>
</body></html>`;

const RECEIPT_ZERO_INTERACTIVE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Application Receipt</title></head>
<body>
  <main>
    <h1>Application Confirmed</h1>
    <p>Receipt ID: APP-000042</p>
    <p>Status: Received</p>
  </main>
</body></html>`;

const RECEIPT_ONE_BUTTON_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Booking Confirmation</title></head>
<body>
  <main>
    <h1>Booking Confirmed</h1>
    <p>Confirmation Code: BK-998877</p>
    <button id="print-btn" type="button">Print Receipt</button>
  </main>
</body></html>`;

describe('v0.7.3 backlog fixes (Bugs 1-6) and high-ROI features (B1-B2)', () => {
  let server;
  let baseUrl;
  let manager;
  let tmpDir;
  let fileA;
  let fileB;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-v073-'));
    fileA = path.join(tmpDir, 'attachment.pdf');
    fileB = path.join(tmpDir, 'extra.pdf');
    fs.writeFileSync(fileA, '%PDF-1.4\n% dummy attachment A\n%%EOF\n');
    fs.writeFileSync(fileB, '%PDF-1.4\n% dummy attachment B\n%%EOF\n');

    server = http.createServer((req, res) => {
      const u = new URL(req.url || '/', 'http://127.0.0.1').pathname;
      const pages = {
        '/combo-file': COMBO_FILE_HTML,
        '/catalog': CATALOG_SEARCH_HTML,
        '/comment': COMMENT_EDITOR_HTML,
        '/labels': LABEL_TARGET_HTML,
        '/receipt-zero': RECEIPT_ZERO_INTERACTIVE_HTML,
        '/receipt-one-btn': RECEIPT_ONE_BUTTON_HTML,
      };
      res.writeHead(pages[u] ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pages[u] || 'not found');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    manager = new BrowserManager({ mode: 'launch', headless: true });
  });

  after(async () => {
    await manager?.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function open(route) {
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}${route}`, waitUntil: 'load' }]);
    return (await manager.getPage()).page;
  }

  it('Bug 1: inspect_compact surfaces selected val on non-input comboboxes and attached filenames on <input type="file">', async () => {
    const page = await open('/combo-file');

    // When textContent equals aria-label ("Department"), no redundant val= is printed.
    // When textContent differs from aria-label ("Plan" -> "Enterprise"), val="Enterprise" is shown.
    const snapBefore = await inspectCompact(page, { mode: 'interactive' });
    assert.match(snapBefore.text, /<div:combobox> "Department"(?! val=)/);
    assert.match(snapBefore.text, /<div:combobox> "Plan" val="Enterprise"/);
    assert.match(snapBefore.text, /<input:file> "Attachment"(?! val=)/);

    // Fill combobox + single file + multi-file via smartFillForm and verify snapshot includes val=...
    const fillRes = await smartFillForm(page, {
      fields: [
        { keys: ['Full Name'], value: 'Alice Nguyen' },
        { selector: '#region-combo', option: 'Region 150' },
        { selector: '#resume-file', file: fileA },
        { selector: '#multi-file', files: [fileA, fileB] },
      ],
      returnSnapshot: true,
      snapshotMode: 'interactive',
    });

    assert.equal(fillRes.filledCount, 4, JSON.stringify(fillRes));
    assert.match(fillRes.snapshot, /<button:combobox> "Region" val="Region 150"/);
    assert.match(fillRes.snapshot, /<input:file> "Attachment" val="attachment\.pdf" \[req\]/);
    assert.match(fillRes.snapshot, /<input:file> "Supporting Docs" val="2 files: attachment\.pdf, extra\.pdf"/);
  });

  it('Bug 2: batch_actions wait({ textNew }) compares against pre-click baseline so synchronous/fast click results do not time out', async () => {
    const page = await open('/catalog');
    const t0 = Date.now();
    const res = await batchActions(page, [
      { action: 'fill', selector: '#q', value: 'adapter' },
      { action: 'check', selector: '#in-stock' },
      { action: 'click', selector: '#search-btn' },
      { action: 'wait', textNew: 'results', timeoutMs: 2000 },
      { action: 'extract', selector: '#results' },
    ]);
    const elapsed = Date.now() - t0;

    assert.equal(res.blocked, false);
    assert.equal(res.completed, 5, JSON.stringify(res));
    assert.ok(elapsed < 1800, `Expected fast completion without wait timeout, took ${elapsed}ms`);
    assert.match(res.results[4].text, /Showing 3 results for adapter \(in-stock\)/);
  });

  it('Bug 3: expect.textNew and wait({ textNew }) ignore text already typed inside <input>, <textarea>, and [contenteditable]', async () => {
    const page = await open('/comment');

    // Turn 1: User/agent types URL and tag into editors before clicking Post.
    await actFast(page, {
      action: 'fill',
      selector: '#comment-editor',
      value: 'Check https://github.com/Tthanh2k6/turbo-browser-mcp for details',
    });
    await actFast(page, {
      action: 'fill',
      selector: '#draft-notes',
      value: 'https://github.com/Tthanh2k6/turbo-browser-mcp',
    });
    await actFast(page, {
      action: 'fill',
      selector: '#tag-input',
      value: 'benchmark-v073',
    });

    // Turn 2: Click Post with expect.textNew matching the URL that is already inside the editor & textarea.
    const t0 = Date.now();
    const res = await actFast(page, {
      action: 'click',
      selector: '#post-comment',
      allowSubmit: true,
      expect: { textNew: 'github.com/Tthanh2k6/turbo-browser-mcp', timeoutMs: 2500 },
    });
    const elapsed = Date.now() - t0;

    assert.equal(res.ok, true);
    assert.equal(res.submitVerified, true, JSON.stringify(res));
    assert.equal(res.evidence?.type, 'textNew');
    assert.ok(elapsed < 2000, `Expected immediate textNew verification, took ${elapsed}ms`);
  });

  it('Bug 4: smart_fill_form schema documents option for both <select> and role=combobox', () => {
    const smartFillTool = TOOL_DEFINITIONS.find((t) => t.name === 'smart_fill_form');
    assert.ok(smartFillTool, 'smart_fill_form definition exists');
    const optionProp = smartFillTool.inputSchema?.properties?.fields?.items?.properties?.option;
    assert.ok(optionProp, 'fields[].option property exists');
    assert.equal(typeof optionProp.description, 'string');
    assert.match(optionProp.description, /<select>/i);
    assert.match(optionProp.description, /combobox/i);
  });

  it('Bug 5: act_fast and batch_actions resolve targets by label when ref, selector, and text are omitted', async () => {
    const page = await open('/labels');

    const r1 = await actFast(page, {
      action: 'fill',
      label: 'Reply to a comment...',
      value: 'Resolved via <label for>',
    });
    assert.equal(r1.ok, true);

    const r2 = await batchActions(page, [
      { action: 'fill', label: 'Filter by author', value: 'trungthanh' },
      { action: 'fill', label: 'Quick search...', value: 'combobox' },
    ]);
    assert.equal(r2.completed, 2, JSON.stringify(r2));

    const values = await page.evaluate(() => ({
      reply: document.getElementById('reply-area').value,
      author: document.getElementById('aria-input').value,
      search: document.getElementById('ph-input').value,
    }));
    assert.deepEqual(values, {
      reply: 'Resolved via <label for>',
      author: 'trungthanh',
      search: 'combobox',
    });
  });

  it('Bug 6a: batch_actions navigate allows about:blank', async () => {
    const page = await open('/labels');
    const res = await batchActions(page, [{ action: 'navigate', url: 'about:blank' }]);
    assert.equal(res.blocked, false);
    assert.equal(res.completed, 1, JSON.stringify(res));
    assert.equal(res.results[0].ok, true);
    assert.equal(res.results[0].url, 'about:blank');
  });

  it('Bug 6b: mode="auto" persists degraded="headless-fallback" across turns after CDP fallback', async () => {
    const prevBridge = process.env.TURBO_BROWSER_DISABLE_BRIDGE;
    process.env.TURBO_BROWSER_DISABLE_BRIDGE = 'true';
    const fallbackManager = new BrowserManager({
      mode: 'auto',
      cdpUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/unreachable`,
      cdpAutoTimeoutMs: 500,
      headless: true,
      useBridge: false,
    });
    try {
      const turn1Raw = await dispatchToolCall(fallbackManager, 'tabs_batch', {
        operations: [{ action: 'open', url: `${baseUrl}/labels`, waitUntil: 'load' }],
      });
      const turn1 = JSON.parse(turn1Raw.text);
      assert.equal(turn1.degraded, 'headless-fallback');
      assert.ok(turn1.connectionNote, 'Turn 1 includes one-shot connectionNote');

      // Turn 2: connectionNote is consumed, but degraded: "headless-fallback" must persist.
      const turn2Raw = await dispatchToolCall(fallbackManager, 'tabs_batch', {
        operations: [{ action: 'list' }],
      });
      const turn2 = JSON.parse(turn2Raw.text);
      assert.equal(turn2.connectionNote, undefined);
      assert.equal(turn2.degraded, 'headless-fallback');
    } finally {
      if (prevBridge === undefined) delete process.env.TURBO_BROWSER_DISABLE_BRIDGE;
      else process.env.TURBO_BROWSER_DISABLE_BRIDGE = prevBridge;
      await fallbackManager.close().catch(() => {});
    }

    // Explicit launch mode should not report degraded.
    const normalRaw = await dispatchToolCall(manager, 'tabs_batch', {
      operations: [{ action: 'list' }],
    });
    const normal = JSON.parse(normalRaw.text);
    assert.equal(normal.degraded, undefined);
  });

  it('Feature B1: tabs_batch supports returnSnapshot=true on Turn 1', async () => {
    const out = await dispatchToolCall(manager, 'tabs_batch', {
      operations: [{ action: 'open', url: `${baseUrl}/catalog`, waitUntil: 'load' }],
      returnSnapshot: true,
      snapshotMode: 'interactive',
    });
    const parsed = JSON.parse(out.text);
    assert.equal(typeof parsed.snapshot, 'string');
    assert.match(parsed.snapshot, /Keyword/);
    assert.match(parsed.snapshot, /Search/);
    assert.equal(parsed.pageText, undefined, 'Interactive page with >=2 buttons should not trigger receipt fallback');
  });

  it('Feature B2: returnSnapshot=true auto-falls back to pageText on receipt pages with 0 interactive elements or <2 buttons after submit', async () => {
    // Case 1: Opening a 0-interactive receipt page directly via tabs_batch(returnSnapshot: true)
    const directOut = await dispatchToolCall(manager, 'tabs_batch', {
      operations: [{ action: 'open', url: `${baseUrl}/receipt-zero`, waitUntil: 'load' }],
      returnSnapshot: true,
    });
    const directParsed = JSON.parse(directOut.text);
    assert.equal(typeof directParsed.snapshot, 'string');
    assert.equal(typeof directParsed.pageText, 'string');
    assert.match(directParsed.pageText, /APP-000042/);

    // Case 2: Submitting a form via act_fast(returnSnapshot: true) that navigates to a receipt page with only 1 button (<2 buttons)
    const page = await open('/combo-file');
    await smartFillForm(page, {
      fields: [
        { selector: '#applicant-name', value: 'Alice' },
        { selector: '#resume-file', file: fileA },
      ],
    });
    const submitRes = await actFast(page, {
      action: 'click',
      selector: '#submit-app',
      allowSubmit: true,
      returnSnapshot: true,
    });
    assert.equal(submitRes.ok, true);
    assert.equal(typeof submitRes.pageText, 'string', JSON.stringify(submitRes));
    assert.match(submitRes.pageText, /BK-998877/);
  });
});
