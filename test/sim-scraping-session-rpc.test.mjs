import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, evaluateJs, extractCleanText } from '../src/dom-engine.mjs';
import { createJsonRpcHandler, dispatchToolCall } from '../src/index.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRY_PATH = path.resolve(TEST_DIR, '..', 'src', 'index.mjs');

function startSimServer() {
  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const urlPath = parsedUrl.pathname;

    if (urlPath === '/spa-pricing') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Pricing SPA</title></head><body>
        <main>
          <h1>Pricing</h1>
          <div class="card"><span>$29/mo</span><div>Pro Plan</div></div>
          <h5>Billing Notes</h5>
          <h6>Tax Details</h6>
          <table>
            <thead><tr><th>Tier | Level</th><th>Features</th></tr></thead>
            <tbody><tr><td>Pro | Plus</td><td>A | B | C</td></tr></tbody>
          </table>
          <div aria-hidden="true">Hidden Aria Secret</div>
          <p style="visibility: hidden">Invisible Secret Paragraph</p>
          <div style="visibility: hidden"><span>Nested Invisible Child</span></div>
        </main>
      </body></html>`);
      return;
    }

    if (urlPath === '/basic') {
      const id = parsedUrl.searchParams.get('id') || '1';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Basic ${id}</title></head><body><h1 id="title">Basic Page ${id}</h1></body></html>`);
      return;
    }

    if (urlPath === '/network-glob-host') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Glob Host</title></head><body><h1>Glob Filter Page</h1></body></html>`);
      return;
    }

    if (urlPath.startsWith('/ads/') || urlPath.includes('/tracker/') || urlPath.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, path: urlPath }));
      return;
    }

    if (urlPath === '/redirect-1') {
      res.writeHead(302, { Location: '/redirect-2' });
      res.end();
      return;
    }

    if (urlPath === '/redirect-2') {
      res.writeHead(302, { Location: '/redirect-final' });
      res.end();
      return;
    }

    if (urlPath === '/redirect-final') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Redirect Final</title></head><body>
        <h1>Redirect Chain Landed</h1>
        <a id="dl-fast" href="/fast-dl" download="chain-report.csv">Download CSV</a>
      </body></html>`);
      return;
    }

    if (urlPath === '/fast-dl') {
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="chain-report.csv"',
      });
      res.end('id,plan,amount\n1,pro,29\n');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
      });
    });
  });
}

describe('sim-scraping-session-rpc: SPA scraping, evaluateJs edge cases, browser/tab/emulation recovery, storageState & glob blocking, and stdio JSON-RPC stress', () => {
  let server;
  let port;
  let baseUrl;
  let manager;
  let prevSaveRoot;

  before(async () => {
    prevSaveRoot = process.env.TURBO_BROWSER_SAVE_ROOT;
    process.env.TURBO_BROWSER_SAVE_ROOT = [process.cwd(), os.tmpdir()].join(path.delimiter);
    const srv = await startSimServer();
    server = srv.server;
    port = srv.port;
    baseUrl = srv.baseUrl;
    manager = new BrowserManager({ mode: 'launch', headless: true });
  });

  after(async () => {
    await manager?.close();
    await new Promise((resolve) => server?.close(resolve));
    if (prevSaveRoot === undefined) delete process.env.TURBO_BROWSER_SAVE_ROOT;
    else process.env.TURBO_BROWSER_SAVE_ROOT = prevSaveRoot;
  });

  it('1. extractCleanText Markdown & visibility scraping: preserves Tailwind/React div/span card text, renders h5/h6, escapes table cell pipes, and excludes aria-hidden & visibility:hidden in text and markdown modes', async () => {
    const opened = await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/spa-pricing` }]);
    const { page } = await manager.getPage(opened.activeTabId);

    const txtRes = await extractCleanText(page, { format: 'text' });
    assert.match(txtRes.text, /Pricing/, 'text mode should include h1 Pricing');
    assert.ok(txtRes.text.includes('$29/mo'), 'text mode must preserve span "$29/mo"');
    assert.ok(txtRes.text.includes('Pro Plan'), 'text mode must preserve div "Pro Plan"');
    assert.equal(
      txtRes.text.includes('Hidden Aria Secret'),
      false,
      'text mode must exclude [aria-hidden="true"] elements'
    );
    assert.equal(
      txtRes.text.includes('Invisible Secret Paragraph'),
      false,
      'text mode must exclude visibility:hidden elements'
    );
    assert.equal(
      txtRes.text.includes('Nested Invisible Child'),
      false,
      'text mode must exclude descendants of visibility:hidden elements'
    );

    const mdRes = await extractCleanText(page, { format: 'markdown' });
    assert.match(mdRes.text, /^# Pricing$/m, 'markdown mode should render # Pricing');
    assert.ok(
      mdRes.text.includes('$29/mo') && mdRes.text.includes('Pro Plan'),
      `markdown mode must not drop Tailwind/React card div/span text "$29/mo" or "Pro Plan" when sibling h1 is present. Got:\n${mdRes.text}`
    );
    assert.match(mdRes.text, /^##### Billing Notes$/m, 'markdown mode must render <h5> as #####');
    assert.match(mdRes.text, /^###### Tax Details$/m, 'markdown mode must render <h6> as ######');
    assert.ok(
      mdRes.text.includes('Tier \\| Level') && mdRes.text.includes('Pro \\| Plus') && mdRes.text.includes('A \\| B \\| C'),
      `markdown table cells containing literal "|" must be escaped as "\\|". Got:\n${mdRes.text}`
    );
    assert.equal(
      mdRes.text.includes('Hidden Aria Secret'),
      false,
      'markdown mode must exclude [aria-hidden="true"] elements'
    );
    assert.equal(
      mdRes.text.includes('Invisible Secret Paragraph'),
      false,
      'markdown mode must exclude visibility:hidden elements'
    );
    assert.equal(
      mdRes.text.includes('Nested Invisible Child'),
      false,
      'markdown mode must exclude descendants of visibility:hidden elements'
    );
  });

  it('2. evaluateJs edge cases: trailing semicolons, trailing // comments, undefined -> null normalization in MCP JSON, async Promises, and single execution on runtime error', async () => {
    const opened = await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/basic?id=eval` }]);
    const tabId = opened.activeTabId;
    const { page } = await manager.getPage(tabId);

    const semiRes = await evaluateJs(page, { expression: '1 + 1;' });
    assert.equal(semiRes.result, 2, 'expression with trailing semicolon "1 + 1;" must return 2, not undefined');

    const commentRes = await evaluateJs(page, { expression: '2 + 3 // sum' });
    assert.equal(commentRes.result, 5, 'expression with trailing // comment "2 + 3 // sum" must return 5');

    const elSemiRes = await evaluateJs(page, {
      selector: '#title',
      expression: 'el.textContent.trim(); // heading text',
    });
    assert.equal(elSemiRes.result, 'Basic Page eval', 'element-scoped expression with semicolon + // comment must return value');

    const undefMcpOut = await dispatchToolCall(manager, 'evaluate_js', {
      tabId,
      expression: 'undefined',
    });
    const undefParsed = JSON.parse(undefMcpOut.text);
    assert.equal(
      Object.prototype.hasOwnProperty.call(undefParsed, 'result'),
      true,
      'MCP evaluate_js JSON must preserve "result" key when expression evaluates to undefined'
    );
    assert.equal(undefParsed.result, null, 'undefined result must be normalized to null');

    const asyncRes = await evaluateJs(page, {
      expression: 'Promise.resolve({ delayed: 42 })',
    });
    assert.deepEqual(asyncRes.result, { delayed: 42 });

    await evaluateJs(page, { expression: 'window.__errCounter = 0;' });
    await assert.rejects(
      () =>
        evaluateJs(page, {
          expression: '(() => { window.__errCounter = (window.__errCounter || 0) + 1; throw new Error("boom-once"); })()',
        }),
      /boom-once/i
    );
    const countCheck = await evaluateJs(page, { expression: 'window.__errCounter' });
    assert.equal(countCheck.result, 1, 'runtime error inside expression must execute side effects only once');
  });

  it('3. BrowserManager tab/crash/emulation lifecycle: failed open cleanup without leaking blank tab, automatic relaunch after browser.close() and isolatedContext.close(), UA reset via null, and viewport clamping', async () => {
    const opened = await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/basic?id=active-before-fail` }]);
    const prevActiveTabId = opened.activeTabId;
    const tabsBefore = await manager.listTabs();

    await assert.rejects(
      () =>
        manager.tabsBatch([
          { action: 'open', url: 'http://127.0.0.1:1/unreachable-single-open', timeoutMs: 500 },
        ]),
      /ERR_|Timeout|failed/i
    );

    const tabsAfterFail = await manager.listTabs();
    assert.equal(
      tabsAfterFail.length,
      tabsBefore.length,
      'failed single open action must close the failed page and not leak an about:blank tab'
    );
    assert.equal(
      manager.activeTabId,
      prevActiveTabId,
      'failed single open action must preserve the previous activeTabId'
    );

    // Emulation: set custom userAgent, then reset with userAgent: null; clamp viewport { width: 50, height: 50 } to >= 200
    await manager.tabsBatch([
      {
        action: 'emulate',
        tabId: prevActiveTabId,
        userAgent: 'CustomUA/1.0',
        viewport: { width: 50, height: 50 },
      },
    ]);
    const { page: emuPage } = await manager.getPage(prevActiveTabId);
    const customUa = await evaluateJs(emuPage, { expression: 'navigator.userAgent' });
    assert.ok(customUa.result.includes('CustomUA/1.0'), 'emulate should set CustomUA/1.0');

    const clampedSize = await evaluateJs(emuPage, {
      expression: '({ w: window.innerWidth, h: window.innerHeight })',
    });
    assert.ok(
      clampedSize.result.w >= 200 && clampedSize.result.h >= 200,
      `emulate viewport { width: 50, height: 50 } must clamp to >= 200x200, got ${JSON.stringify(clampedSize.result)}`
    );

    await manager.tabsBatch([
      {
        action: 'emulate',
        tabId: prevActiveTabId,
        userAgent: null,
      },
    ]);
    const restoredUa = await evaluateJs(emuPage, { expression: 'navigator.userAgent' });
    assert.equal(
      restoredUa.result.includes('CustomUA/1.0'),
      false,
      `emulate({ userAgent: null }) must restore default Chromium UA, got: ${restoredUa.result}`
    );

    // Closed isolatedContext recovery
    const isoOpen1 = await manager.tabsBatch([
      { action: 'open', url: `${baseUrl}/basic?id=iso-1`, isolatedContext: 'crash-iso' },
    ]);
    assert.ok(isoOpen1.results[0].tabId);
    const isoCtx = manager.isolatedContexts.get('crash-iso');
    assert.ok(isoCtx, 'isolatedContext crash-iso should exist');
    await isoCtx.close();

    const isoOpen2 = await manager.tabsBatch([
      { action: 'open', url: `${baseUrl}/basic?id=iso-2`, isolatedContext: 'crash-iso' },
    ]);
    assert.ok(isoOpen2.results[0].tabId, 'tabsBatch on closed isolatedContext must recreate context and succeed');
    assert.ok(isoOpen2.results[0].url.includes('id=iso-2'));

    // Simulated external Chromium crash / forced browser.close()
    await manager.browser.close();
    const afterCrashOpen = await manager.tabsBatch([
      { action: 'open', url: `${baseUrl}/basic?id=after-crash` },
    ]);
    assert.ok(afterCrashOpen.activeTabId, 'tabsBatch after browser.close() must automatically relaunch Chromium');
    const { page: recoveredPage } = await manager.getPage(afterCrashOpen.activeTabId);
    assert.equal(recoveredPage.isClosed(), false);
    assert.ok(recoveredPage.url().includes('id=after-crash'));
  });

  it('4. network_session persistence & glob matching: loadStorageStatePath does not overwrite live localStorage edits on reload, and blockUrls globs match anywhere in URL', async () => {
    const stateFile = path.join(os.tmpdir(), `tbm-sim-storage-${Date.now()}.json`);
    try {
      const storageStatePayload = {
        cookies: [],
        origins: [
          {
            origin: baseUrl,
            localStorage: [
              { name: 'liveKey', value: 'seededFromDisk' },
              { name: 'staticKey', value: 'keepMe' },
            ],
          },
        ],
      };
      fs.writeFileSync(stateFile, JSON.stringify(storageStatePayload, null, 2), 'utf8');

      const opened = await manager.tabsBatch([
        { action: 'open', url: `${baseUrl}/basic?id=storage-reload`, isolatedContext: 'storage-reload-ctx' },
      ]);
      const tabId = opened.activeTabId;
      const { page } = await manager.getPage(tabId);

      await manager.manageNetworkSession(tabId, {
        loadStorageStatePath: stateFile,
      });

      const initialVal = await evaluateJs(page, { expression: 'localStorage.getItem("liveKey")' });
      assert.equal(initialVal.result, 'seededFromDisk');

      // Live app updates localStorage and reloads page
      await evaluateJs(page, {
        expression: 'localStorage.setItem("liveKey", "updatedAfterLoad"); localStorage.getItem("liveKey")',
      });
      await page.reload({ waitUntil: 'domcontentloaded' });

      const afterReloadVal = await evaluateJs(page, {
        expression: '({ live: localStorage.getItem("liveKey"), staticVal: localStorage.getItem("staticKey") })',
      });
      assert.equal(
        afterReloadVal.result.live,
        'updatedAfterLoad',
        'localStorage edits made after loadStorageStatePath must survive page.reload() without being overwritten by initScript'
      );
      assert.equal(afterReloadVal.result.staticVal, 'keepMe');

      // Test blockUrls with non-leading wildcard globs and regex/substring coexist
      const globUrl = `http://sub.localhost:${port}/network-glob-host`;
      await manager.tabsBatch([{ action: 'navigate', tabId, url: globUrl }]);
      await manager.manageNetworkSession(tabId, {
        unblockAll: true,
        blockUrls: [
          `http://*.localhost:${port}/ads/*`,
          '*/tracker/*/pixel',
        ],
      });

      const fetchOutcomes = await evaluateJs(page, {
        expression: `async () => {
          const check = async (u) => {
            try {
              const r = await fetch(u);
              return { ok: r.ok, status: r.status };
            } catch (e) {
              return { ok: false, error: String(e.message || e) };
            }
          };
          return {
            ad: await check('/ads/banner.js'),
            tracker: await check('/tracker/v2/pixel'),
            api: await check('/api/v1/items'),
          };
        }`,
      });

      assert.equal(
        fetchOutcomes.result.ad.ok,
        false,
        `glob "http://*.localhost:${port}/ads/*" must block /ads/banner.js`
      );
      assert.equal(
        fetchOutcomes.result.tracker.ok,
        false,
        'glob "*/tracker/*/pixel" must block /tracker/v2/pixel'
      );
      assert.equal(
        fetchOutcomes.result.api.ok,
        true,
        'non-matching /api/v1/items must pass through unblocked'
      );
    } finally {
      if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    }
  });

  it('5. MCP stdio JSON-RPC framing & validation: multi-header Content-Type + Content-Length in 3-7 byte chunks, params:null / non-object params / arguments:null validation, and sequential batch execution order', async () => {
    // 5a. Direct handler validation for params: null, params: "bad", arguments: null, and sequential batch order
    const rpcHandle = createJsonRpcHandler(manager);

    const pingNullParams = await rpcHandle({
      jsonrpc: '2.0',
      id: 'p-null',
      method: 'ping',
      params: null,
    });
    assert.deepEqual(pingNullParams, { jsonrpc: '2.0', id: 'p-null', result: {} });

    const initNullParams = await rpcHandle({
      jsonrpc: '2.0',
      id: 'init-null',
      method: 'initialize',
      params: null,
    });
    assert.equal(initNullParams.result.serverInfo.name, 'turbo-browser-mcp');

    const badParamsRes = await rpcHandle({
      jsonrpc: '2.0',
      id: 'bad-params',
      method: 'tools/call',
      params: 'bad',
    });
    assert.ok(
      badParamsRes.error?.code === -32602 || badParamsRes.result?.isError === true,
      `non-object params: "bad" should return -32602 Invalid params (got: ${JSON.stringify(badParamsRes)})`
    );
    assert.equal(badParamsRes.error?.code, -32602, 'non-object params: "bad" must return JSON-RPC error code -32602');

    const nullArgsRes = await rpcHandle({
      jsonrpc: '2.0',
      id: 'null-args',
      method: 'tools/call',
      params: { name: 'tabs_batch', arguments: null },
    });
    assert.equal(nullArgsRes.result?.isError, false, 'tools/call with arguments: null must not crash');

    // Sequential batch array execution order check
    const opened = await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/basic?id=batch-seq` }]);
    const seqTabId = opened.activeTabId;
    await dispatchToolCall(manager, 'evaluate_js', {
      tabId: seqTabId,
      expression: 'window.__batchSeq = [];',
    });

    const batchReplies = await rpcHandle([
      {
        jsonrpc: '2.0',
        id: 'b1',
        method: 'tools/call',
        params: {
          name: 'evaluate_js',
          arguments: {
            tabId: seqTabId,
            expression: 'new Promise((r) => setTimeout(() => { window.__batchSeq.push("step1"); r([...window.__batchSeq]); }, 60))',
          },
        },
      },
      {
        jsonrpc: '2.0',
        id: 'b2',
        method: 'tools/call',
        params: {
          name: 'evaluate_js',
          arguments: {
            tabId: seqTabId,
            expression: 'new Promise((r) => setTimeout(() => { window.__batchSeq.push("step2"); r([...window.__batchSeq]); }, 15))',
          },
        },
      },
      {
        jsonrpc: '2.0',
        id: 'b3',
        method: 'tools/call',
        params: {
          name: 'evaluate_js',
          arguments: {
            tabId: seqTabId,
            expression: '(() => { window.__batchSeq.push("step3"); return [...window.__batchSeq]; })()',
          },
        },
      },
    ]);

    assert.equal(batchReplies.length, 3);
    const b3Result = JSON.parse(batchReplies[2].result.content[0].text).result;
    assert.deepEqual(
      b3Result,
      ['step1', 'step2', 'step3'],
      `JSON-RPC batch array must execute sequentially in deterministic array order, got ${JSON.stringify(b3Result)}`
    );

    // 5b. Real spawned child process receiving Content-Type BEFORE Content-Length split across 3-7 byte chunks
    const child = spawn(process.execPath, [ENTRY_PATH], {
      env: {
        ...process.env,
        TURBO_BROWSER_MODE: 'launch',
        TURBO_BROWSER_HEADLESS: 'true',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let rawOut = Buffer.alloc(0);
    let stderr = '';
    const replies = new Map();

    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });

    child.stdout.on('data', (chunk) => {
      rawOut = Buffer.concat([rawOut, chunk]);
      while (true) {
        const hdrEnd = rawOut.indexOf('\r\n\r\n');
        if (hdrEnd === -1) break;
        const hdr = rawOut.subarray(0, hdrEnd).toString('utf8');
        const m = /Content-Length:\s*(\d+)/i.exec(hdr);
        if (!m) break;
        const len = Number(m[1]);
        if (rawOut.length < hdrEnd + 4 + len) break;
        const body = rawOut.subarray(hdrEnd + 4, hdrEnd + 4 + len).toString('utf8');
        rawOut = rawOut.subarray(hdrEnd + 4 + len);
        const msg = JSON.parse(body);
        if (msg.id !== undefined) replies.set(msg.id, msg);
      }
    });

    const waitForReply = async (id, timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs;
      while (!replies.has(id) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(replies.has(id), `Timed out waiting for stdio reply id=${id} (stderr: ${stderr})`);
      return replies.get(id);
    };

    try {
      const reqJson = JSON.stringify({
        jsonrpc: '2.0',
        id: 77,
        method: 'initialize',
        params: null,
      });
      const byteLen = Buffer.byteLength(reqJson, 'utf8');
      const fullFrame = Buffer.from(
        `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: ${byteLen}\r\n\r\n${reqJson}`,
        'utf8'
      );

      const chunkPattern = [3, 5, 4, 7, 3, 6, 4, 5];
      let offset = 0;
      let idx = 0;
      while (offset < fullFrame.length) {
        const sz = chunkPattern[idx++ % chunkPattern.length];
        const piece = fullFrame.subarray(offset, Math.min(fullFrame.length, offset + sz));
        offset += piece.length;
        child.stdin.write(piece);
        await new Promise((r) => setTimeout(r, 2));
      }

      const reply77 = await waitForReply(77);
      assert.equal(reply77.result.serverInfo.name, 'turbo-browser-mcp');
    } finally {
      child.stdin.end();
      await new Promise((resolve) => child.once('exit', resolve));
    }
  });

  it('6. Additional stress scenarios: redirect chain diagnostics + download + navigation race, >20k chars evaluate_js truncation with full savePath export, and tools/list schema invariants', async () => {
    const saveEvalFile = path.join(os.tmpdir(), `tbm-huge-eval-${Date.now()}.txt`);
    const downloadedFiles = [];
    try {
      // 6a. Redirect chain + download + rapid navigation race
      const opened = await manager.tabsBatch([
        { action: 'open', url: `${baseUrl}/redirect-1`, isolatedContext: 'redirect-race-ctx' },
      ]);
      const tabId = opened.activeTabId;
      const { page } = await manager.getPage(tabId);
      assert.ok(page.url().endsWith('/redirect-final'), 'should follow 302 redirect chain to /redirect-final');

      await actFast(page, { action: 'click', selector: '#dl-fast' });
      const diag = await manager.getDiagnostics(tabId, { statusFilter: 'all', includeStatic: true });
      assert.ok(
        diag.requests.some((r) => r.url.endsWith('/redirect-1') && r.status === 302),
        'diagnostics should record 302 /redirect-1 hop'
      );
      assert.ok(
        diag.requests.some((r) => r.url.endsWith('/redirect-2') && r.status === 302),
        'diagnostics should record 302 /redirect-2 hop'
      );
      const dlEntry = diag.downloads.find((d) => d.suggestedFilename === 'chain-report.csv');
      assert.ok(dlEntry && dlEntry.savePath, 'download triggered before diagnostics should settle');
      downloadedFiles.push(dlEntry.savePath);

      // 6b. Huge payload (> 20k chars) truncation in evaluate_js MCP output while saving full payload to savePath
      const hugeMcpOut = await dispatchToolCall(manager, 'evaluate_js', {
        tabId,
        expression: '"X".repeat(25000)',
        savePath: saveEvalFile,
      });
      assert.ok(hugeMcpOut.text.length <= 1000, 'MCP evaluate_js with savePath returns only path, bytes and preview');
      assert.equal(JSON.parse(hugeMcpOut.text).bytes, 25000);
      assert.equal(fs.existsSync(saveEvalFile), true, 'savePath file must be written for huge evaluate_js');
      assert.equal(fs.readFileSync(saveEvalFile, 'utf8').length, 25000, 'savePath must store the full untruncated 25000 chars');

      // 6c. tools/list schema invariants check
      const rpcHandle = createJsonRpcHandler(manager);
      const listReply = await rpcHandle({ jsonrpc: '2.0', id: 'schema-check', method: 'tools/list' });
      const tools = listReply.result.tools;
      assert.ok(Array.isArray(tools) && tools.length >= 9);
      for (const tool of tools) {
        assert.equal(typeof tool.name, 'string');
        assert.equal(tool.inputSchema?.type, 'object');
      }
      const tabsBatchTool = tools.find((t) => t.name === 'tabs_batch');
      const uaProp = tabsBatchTool.inputSchema.properties.operations.items.properties.userAgent;
      assert.ok(
        uaProp.type === 'string' || Array.isArray(uaProp.oneOf),
        'tabs_batch schema should define userAgent property'
      );
    } finally {
      if (fs.existsSync(saveEvalFile)) fs.unlinkSync(saveEvalFile);
      for (const f of downloadedFiles) {
        if (f && fs.existsSync(f)) fs.unlinkSync(f);
      }
    }
  });
});
