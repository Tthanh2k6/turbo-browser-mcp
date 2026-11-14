#!/usr/bin/env node
import http from 'node:http';
import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, inspectCompact, smartFillForm } from '../src/dom-engine.mjs';

function buildDenseHtml() {
  const buttons = Array.from({ length: 140 }, (_, i) =>
    `<button type="button" id="btn-${i}">Inventory Action Row Item #${i} - Configure Settings</button>`
  ).join('\n');
  return `<!doctype html>
<html>
<head><title>Dense UI Benchmark</title></head>
<body>
  <main>
    <h1>Operations Console</h1>
    <p>Dense interface with 140 interactive buttons and dynamic controls.</p>
    <button id="add-field" type="button" onclick="document.getElementById('host').innerHTML='<input aria-label=DynamicToken type=text />'">Add Dynamic Field</button>
    <div id="host"></div>
    <div class="grid">${buttons}</div>
  </main>
</body>
</html>`;
}

const FORM_HTML = `<!doctype html>
<html>
<head><title>7-Field Form Benchmark</title></head>
<body>
  <form id="bench-form" onsubmit="event.preventDefault()">
    <label for="f-name">Full Name</label><input id="f-name" type="text" />
    <label for="f-email">Email Address</label><input id="f-email" type="email" />
    <label for="f-role">Target Role</label><input id="f-role" type="text" />
    <label for="f-city">City</label><input id="f-city" type="text" />
    <label for="f-notes">Cover Note</label><textarea id="f-notes"></textarea>
    <label for="f-country">Country</label>
    <select id="f-country">
      <option value="">Select</option>
      <option value="vn">Vietnam</option>
      <option value="us">United States</option>
    </select>
    <label><input type="checkbox" id="f-terms" /> Accept Terms</label>
  </form>
</body>
</html>`;

function startServer() {
  const denseHtml = buildDenseHtml();
  const server = http.createServer((req, res) => {
    const u = (req.url || '/').split('?')[0];
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (u === '/dense') return res.end(denseHtml);
    if (u === '/form') return res.end(FORM_HTML);
    res.end(`<!doctype html><html><head><title>Tab ${req.url}</title></head><body><h1>Tab Ready</h1></body></html>`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function runBenchmark() {
  const { server, baseUrl } = await startServer();
  const manager = new BrowserManager({ mode: 'launch', headless: true });

  try {
    // 1. Token / Payload Size Efficiency
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/dense`, waitUntil: 'load' }]);
    const { page: densePage } = await manager.getPage();
    const rawHtmlLen = await densePage.evaluate(() => document.documentElement.outerHTML.length);
    const snapState = manager.getSnapshotState(densePage);

    const compact = await inspectCompact(densePage, { mode: 'interactive', maxChars: 4000 }, snapState);
    await actFast(densePage, { action: 'click', selector: '#add-field' }, snapState);
    const delta = await inspectCompact(densePage, { mode: 'interactive', onlyChanged: true, maxChars: 4000 }, snapState);

    // 2. Step-by-Step vs 1-Turn Form Fill + Snapshot
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/form`, waitUntil: 'load' }]);
    const { page: stepPage } = await manager.getPage();
    const stepFields = [
      { selector: '#f-name', value: 'Trung Thanh' },
      { selector: '#f-email', value: 'bench@example.com' },
      { selector: '#f-role', value: 'Full-Stack Engineer' },
      { selector: '#f-city', value: 'Ho Chi Minh' },
      { selector: '#f-notes', value: 'Automated 7-field form benchmark.' },
    ];
    const seqT0 = Date.now();
    let seqTurns = 0;
    for (const sf of stepFields) {
      await actFast(stepPage, { action: 'fill', selector: sf.selector, value: sf.value });
      seqTurns++;
      await inspectCompact(stepPage, { mode: 'forms' });
      seqTurns++;
    }
    await actFast(stepPage, { action: 'select', selector: '#f-country', value: 'vn' });
    seqTurns++;
    await inspectCompact(stepPage, { mode: 'forms' });
    seqTurns++;
    await actFast(stepPage, { action: 'check', selector: '#f-terms' });
    seqTurns++;
    await inspectCompact(stepPage, { mode: 'forms' });
    seqTurns++;
    const seqMs = Date.now() - seqT0;

    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/form`, waitUntil: 'load' }]);
    const { page: batchPage } = await manager.getPage();
    const batchT0 = Date.now();
    const batchRes = await smartFillForm(batchPage, {
      fields: [
        { keys: ['full name'], value: 'Trung Thanh' },
        { keys: ['email'], value: 'bench@example.com' },
        { keys: ['target role'], value: 'Full-Stack Engineer' },
        { keys: ['city'], value: 'Ho Chi Minh' },
        { keys: ['cover note'], value: 'Automated 7-field form benchmark.' },
        { keys: ['country'], value: 'Vietnam' },
        { check: 'Accept Terms' },
      ],
      returnSnapshot: true,
    });
    const batchMs = Date.now() - batchT0;

    // 3. Sequential vs Parallel Multi-Tab Open (4 URLs)
    const tabUrls = [1, 2, 3, 4].map((i) => `${baseUrl}/tab?i=${i}`);
    const tabSeqT0 = Date.now();
    for (const u of tabUrls) {
      await manager.tabsBatch([{ action: 'open', url: u, waitUntil: 'domcontentloaded' }]);
    }
    const tabSeqMs = Date.now() - tabSeqT0;

    const tabParT0 = Date.now();
    await manager.tabsBatch([{ action: 'open_many', urls: tabUrls, waitUntil: 'domcontentloaded' }]);
    const tabParMs = Date.now() - tabParT0;

    const results = {
      snapshot: {
        rawHtmlChars: rawHtmlLen,
        compactChars: compact.charCount,
        deltaChars: delta.charCount,
        reductionPct: Number((((rawHtmlLen - compact.charCount) / rawHtmlLen) * 100).toFixed(1)),
      },
      form7Fields: {
        stepByStepTurns: seqTurns,
        stepByStepMs: seqMs,
        turboBatchTurns: 1,
        turboBatchMs: batchMs,
        filledCount: batchRes.filledCount,
        speedupX: Number((seqMs / Math.max(1, batchMs)).toFixed(2)),
      },
      multiTab4Urls: {
        sequentialMs: tabSeqMs,
        parallelOpenManyMs: tabParMs,
        speedupX: Number((tabSeqMs / Math.max(1, tabParMs)).toFixed(2)),
      },
    };

    console.log('=== turbo-browser-mcp Benchmark (local Chromium headless) ===\n');
    console.log('| Scenario | Baseline | turbo-browser-mcp | Savings |');
    console.log('| :--- | :--- | :--- | :--- |');
    console.log(
      `| Dense 140-btn DOM snapshot | ${rawHtmlLen} chars raw HTML | ${compact.charCount} chars compact / ${delta.charCount} chars delta | ${results.snapshot.reductionPct}% fewer chars |`
    );
    console.log(
      `| 7-field form fill + snapshot | ${seqTurns} MCP turns (${seqMs} ms) | 1 MCP turn (${batchMs} ms, filled=${batchRes.filledCount}) | ${seqTurns}x fewer turns, ${results.form7Fields.speedupX}x faster |`
    );
    console.log(
      `| Open 4 tabs (domcontentloaded) | ${tabSeqMs} ms sequential | ${tabParMs} ms open_many parallel | ${results.multiTab4Urls.speedupX}x faster |`
    );
    console.log('\nRaw JSON:\n' + JSON.stringify(results, null, 2));
  } finally {
    await manager.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

runBenchmark().catch((err) => {
  console.error(err);
  process.exit(1);
});
