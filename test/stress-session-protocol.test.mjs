import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, evaluateJs } from '../src/dom-engine.mjs';
import { createJsonRpcHandler, dispatchToolCall } from '../src/index.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRY_PATH = path.resolve(TEST_DIR, '..', 'src', 'index.mjs');

function startStressServers() {
  const createHandler = (serverLabel) => (req, res) => {
    const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const urlPath = parsedUrl.pathname;

    if (urlPath === '/tab') {
      const id = parsedUrl.searchParams.get('id') || '0';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Tab ${serverLabel}-${id}</title></head><body><h1 id="hdr">Tab ${serverLabel}-${id}</h1></body></html>`);
      return;
    }

    if (urlPath === '/fast') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>Fast Page</title></head><body><h1>Fast Loaded</h1></body></html>');
      return;
    }

    if (urlPath === '/slow-hang') {
      const timer = setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><html><head><title>Slow Page</title></head><body><h1>Slow Loaded</h1></body></html>');
        }
      }, 8000);
      req.on('close', () => clearTimeout(timer));
      return;
    }

    if (urlPath === '/ring-overflow') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>Ring Overflow Fixture</title></head><body><h1>Ring Overflow</h1></body></html>');
      return;
    }

    if (urlPath === '/api/ring') {
      const seq = parsedUrl.searchParams.get('seq') || '0';
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Ring-Seq': String(seq) });
      res.end(JSON.stringify({ ok: true, seq: Number(seq) }));
      return;
    }

    if (urlPath === '/download-ok') {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="stress-ok.txt"',
      });
      res.end('stress-download-payload-ok');
      return;
    }

    if (urlPath === '/download-abort') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="stress-abort.bin"',
        'Content-Length': '65536',
      });
      res.write(Buffer.from('partial-bytes'));
      setTimeout(() => {
        res.destroy(new Error('Simulated mid-stream abort'));
      }, 20);
      return;
    }

    if (urlPath === '/downloads-page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Downloads Page</title></head><body>
        <a id="dl-ok" href="/download-ok" download="stress-ok.txt">Download OK</a>
        <a id="dl-abort" href="/download-abort" download="stress-abort.bin">Download Abort</a>
      </body></html>`);
      return;
    }

    if (urlPath === '/submit-guard') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Submit Guard Env Test</title></head><body>
        <form id="f" onsubmit="event.preventDefault(); window.__submitCount = (window.__submitCount || 0) + 1;">
          <input id="name-inp" type="text" value="Alice" />
          <button id="submit-btn" type="submit">Submit Application</button>
        </form>
      </body></html>`);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  };

  const server1 = http.createServer(createHandler('S1'));
  const server2 = http.createServer(createHandler('S2'));

  return Promise.all([
    new Promise((resolve) => {
      server1.listen(0, '127.0.0.1', () => {
        resolve({ server: server1, baseUrl: `http://127.0.0.1:${server1.address().port}` });
      });
    }),
    new Promise((resolve) => {
      server2.listen(0, '127.0.0.1', () => {
        resolve({ server: server2, baseUrl: `http://127.0.0.1:${server2.address().port}` });
      });
    }),
  ]);
}

describe('stress-session-protocol: tab torture, open_many partial failures, ring eviction, network sessions, and stdio JSON-RPC', () => {
  let server1;
  let baseUrl1;
  let server2;
  let baseUrl2;
  let manager;
  let prevSaveRoot;

  before(async () => {
    prevSaveRoot = process.env.TURBO_BROWSER_SAVE_ROOT;
    process.env.TURBO_BROWSER_SAVE_ROOT = [process.cwd(), os.tmpdir()].join(path.delimiter);
    const [s1, s2] = await startStressServers();
    server1 = s1.server;
    baseUrl1 = s1.baseUrl;
    server2 = s2.server;
    baseUrl2 = s2.baseUrl;
    manager = new BrowserManager({ mode: 'launch', headless: true });
  });

  after(async () => {
    await manager?.close();
    await Promise.all([
      new Promise((resolve) => server1?.close(resolve)),
      new Promise((resolve) => server2?.close(resolve)),
    ]);
    if (prevSaveRoot === undefined) delete process.env.TURBO_BROWSER_SAVE_ROOT;
    else process.env.TURBO_BROWSER_SAVE_ROOT = prevSaveRoot;
  });

  it('1. Tab lifecycle torture: opens 5 tabs, closes all (including activeTabId), recovers cleanly on next getPage/tabsBatch, and rejects invalid tabId close', async () => {
    const urls = [1, 2, 3, 4, 5].map((i) => `${baseUrl1}/tab?id=${i}`);
    const openRes = await manager.tabsBatch([{ action: 'open_many', urls, concurrency: 5 }]);
    const openedTabs = openRes.results[0].opened;
    assert.equal(openedTabs.length, 5, 'should open 5 tabs');
    assert.equal(openRes.activeTabId, openedTabs[4].tabId, 'last opened tab should be active');

    // Close the current activeTabId first and verify activeTabId hands off to another open tab
    const firstCloseId = openRes.activeTabId;
    const afterFirstClose = await manager.tabsBatch([{ action: 'close', tabId: firstCloseId }]);
    assert.notEqual(afterFirstClose.activeTabId, firstCloseId);
    assert.ok(afterFirstClose.activeTabId !== null, 'activeTabId must hand off to a remaining tab');

    // Close all remaining tabs (including whichever tab becomes activeTabId)
    const remainingIds = afterFirstClose.tabs.map((t) => t.tabId);
    assert.ok(remainingIds.length >= 4);
    const closeAllOps = remainingIds.map((tabId) => ({ action: 'close', tabId }));
    const afterCloseAll = await manager.tabsBatch(closeAllOps);
    assert.equal(afterCloseAll.tabs.length, 0, 'all tabs should be closed');
    assert.equal(afterCloseAll.activeTabId, null, 'activeTabId should be null when 0 tabs remain');

    // Verify closing an already-closed tabId or bogus tabId throws a clear error
    await assert.rejects(
      () => manager.tabsBatch([{ action: 'close', tabId: firstCloseId }]),
      /Tab .* not found or closed/i
    );
    await assert.rejects(
      () => manager.tabsBatch([{ action: 'close', tabId: 999999 }]),
      /Tab 999999 not found or closed/i
    );

    // Verify getPage() cleanly recovers by creating and registering a valid new tab without throwing
    const recovered1 = await manager.getPage();
    assert.equal(typeof recovered1.tabId, 'number');
    assert.equal(recovered1.page.isClosed(), false);
    assert.equal(manager.activeTabId, recovered1.tabId);

    // Close that recovered tab so 0 tabs remain again, then verify tabsBatch navigate recovers cleanly
    await manager.tabsBatch([{ action: 'close', tabId: recovered1.tabId }]);
    const listEmpty = await manager.listTabs();
    assert.equal(listEmpty.length, 0);

    const navRecover = await manager.tabsBatch([
      { action: 'navigate', url: `${baseUrl1}/tab?id=recovered` },
    ]);
    assert.equal(navRecover.tabs.length, 1);
    assert.ok(navRecover.activeTabId !== null);
    assert.ok(navRecover.results[0].url.includes('id=recovered'));
  });

  it('2. Concurrent open_many partial failures & timeouts: handles fast + slow timeout + unreachable URLs with telemetry and clear error reporting', async () => {
    await assert.rejects(
      () => manager.tabsBatch([{ action: 'open_many', urls: [] }]),
      /open_many action requires a non-empty urls array/i
    );

    const fastUrl = `${baseUrl1}/fast`;
    const slowUrl = `${baseUrl1}/slow-hang`;
    const unreachableUrl = 'http://127.0.0.1:1/unreachable';

    const t0 = Date.now();
    let batchRes = null;
    let thrownErr = null;
    try {
      batchRes = await manager.tabsBatch([
        {
          action: 'open_many',
          urls: [fastUrl, slowUrl, unreachableUrl],
          concurrency: 3,
          timeoutMs: 400,
        },
      ]);
    } catch (err) {
      thrownErr = err;
    }
    const elapsed = Date.now() - t0;

    assert.equal(
      thrownErr,
      null,
      `open_many should handle partial failures gracefully instead of rejecting whole batch (threw: ${thrownErr?.message})`
    );
    assert.equal(typeof batchRes.elapsedMs, 'number');
    assert.ok(batchRes.elapsedMs >= 0 && elapsed < 6000, 'timeoutMs should bound slow URL wait time');

    const omRes = batchRes.results[0];
    assert.equal(omRes.action, 'open_many');
    assert.equal(typeof omRes.elapsedMs, 'number');
    assert.equal(omRes.opened.length, 3);

    const fastEntry = omRes.opened[0];
    const slowEntry = omRes.opened[1];
    const unreachEntry = omRes.opened[2];

    assert.ok(fastEntry.tabId, 'fast URL must have a valid registered tabId');
    assert.equal(fastEntry.url, fastUrl);
    assert.equal(fastEntry.title, 'Fast Page');
    assert.notEqual(fastEntry.ok, false);

    assert.equal(slowEntry.ok, false, 'slow timed-out URL must be marked ok: false');
    assert.match(String(slowEntry.error || ''), /Timeout|timed out|ERR_/i);

    assert.equal(unreachEntry.ok, false, 'unreachable URL must be marked ok: false');
    assert.match(String(unreachEntry.error || ''), /ERR_UNSAFE_PORT|ERR_CONNECTION_REFUSED|ERR_|Timeout|failed/i);

    const { page } = await manager.getPage(fastEntry.tabId);
    assert.equal(page.url(), fastUrl);
  });

  it('3. Diagnostics ring buffer overflow: >110 HTTP requests (limit=100) and >90 console logs (limit=80) evict oldest entries and clean up requestMap', async () => {
    const opened = await manager.tabsBatch([
      { action: 'open', url: `${baseUrl1}/ring-overflow`, isolatedContext: 'ring-ctx', waitUntil: 'networkidle' },
    ]);
    const tabId = opened.activeTabId;
    const { page } = await manager.getPage(tabId);

    const initialDiag = await manager.getDiagnostics(tabId, { clear: true });
    assert.ok(initialDiag.totalBufferedRequests >= 1);

    await evaluateJs(page, {
      expression: `async () => {
        for (let i = 1; i <= 95; i++) {
          console.error('overflow-log-' + i);
        }
        for (let i = 1; i <= 115; i++) {
          await fetch('/api/ring?seq=' + i);
        }
        return true;
      }`,
    });

    const diag = await manager.getDiagnostics(tabId, {
      level: 'all',
      statusFilter: 'all',
      includeStatic: true,
    });

    assert.equal(diag.console.length, 80, 'console ring buffer must be capped at CONSOLE_RING_LIMIT (80)');
    assert.equal(diag.console[0].text, 'overflow-log-16', 'oldest retained console log should be #16');
    assert.equal(diag.console[79].text, 'overflow-log-95', 'newest retained console log should be #95');

    assert.equal(diag.totalBufferedRequests, 100, 'request ring buffer must be capped at REQUEST_RING_LIMIT (100)');
    assert.equal(diag.requests.length, 100);
    assert.ok(diag.requests[0].url.endsWith('seq=16'), `expected oldest request to be seq=16, got ${diag.requests[0].url}`);
    assert.ok(diag.requests[99].url.endsWith('seq=115'), `expected newest request to be seq=115, got ${diag.requests[99].url}`);

    const internalDiag = manager.diagnostics.get(page);
    assert.equal(internalDiag.requestMap.size, 100, 'requestMap size must match REQUEST_RING_LIMIT (100)');

    await assert.rejects(
      () => manager.getDiagnostics(tabId, { reqId: 'r1' }),
      /Request "r1" not found in diagnostics buffer/i
    );
    await assert.rejects(
      () => manager.getDiagnostics(tabId, { reqId: 'r2' }),
      /Request "r2" not found in diagnostics buffer/i
    );
    await assert.rejects(
      () => manager.getDiagnostics(tabId, { reqId: 'r_nonexistent_99999' }),
      /Request "r_nonexistent_99999" not found in diagnostics buffer/i
    );

    const newestReqId = diag.requests[99].reqId;
    const detail = await manager.getDiagnostics(tabId, { reqId: newestReqId });
    assert.equal(detail.request.status, 200);
    assert.equal(detail.request.responseHeaders['x-ring-seq'], '115');
    assert.deepEqual(JSON.parse(detail.request.responseBody), { ok: true, seq: 115 });
  });

  it('4a. Network session edge cases: rejects invalid preset and isolates concurrent isolatedContext cookie/storage mutations', async () => {
    const opened = await manager.tabsBatch([
      { action: 'open', url: `${baseUrl1}/tab?id=net-main`, waitUntil: 'domcontentloaded' },
    ]);
    const mainTabId = opened.activeTabId;

    await assert.rejects(
      () => manager.manageNetworkSession(mainTabId, { preset: 'ultra-bogus-preset' }),
      /Unsupported network_session preset: ultra-bogus-preset/i
    );

    const isoNames = ['iso-concurrent-1', 'iso-concurrent-2', 'iso-concurrent-3'];
    const openedIso = await Promise.all(
      isoNames.map((name, idx) =>
        manager.tabsBatch([
          { action: 'open', url: `${baseUrl1}/tab?id=${idx}`, isolatedContext: name, activate: false },
        ])
      )
    );
    const isoTabs = openedIso.map((r) => r.results[0].tabId);

    await Promise.all(
      isoTabs.map((tabId, idx) =>
        manager.manageNetworkSession(tabId, {
          cookieAction: 'set',
          cookies: [
            { name: 'shared_key', value: `val-${idx}` },
            { name: `only_${idx}`, value: `secret-${idx}` },
          ],
          storageAction: 'set',
          storageType: 'both',
          items: {
            tenant: `tenant-${idx}`,
            [`slot_${idx}`]: `data-${idx}`,
          },
        })
      )
    );

    const verifyStates = await Promise.all(
      isoTabs.map((tabId) =>
        manager.manageNetworkSession(tabId, {
          cookieAction: 'get',
          storageAction: 'get',
          storageType: 'both',
        })
      )
    );

    for (let idx = 0; idx < isoTabs.length; idx++) {
      const st = verifyStates[idx];
      const cookieNames = st.cookies.map((c) => c.name).sort();
      assert.deepEqual(cookieNames, [`only_${idx}`, 'shared_key'].sort());
      assert.equal(st.cookies.find((c) => c.name === 'shared_key').value, `val-${idx}`);
      assert.deepEqual(st.storage.local, { tenant: `tenant-${idx}`, [`slot_${idx}`]: `data-${idx}` });
      assert.deepEqual(st.storage.session, { tenant: `tenant-${idx}`, [`slot_${idx}`]: `data-${idx}` });
    }
  });

  it('4b. Network session edge cases: saveStorageStatePath + loadStorageStatePath on empty and multi-cookie/multi-origin states', async () => {
    const emptyStatePath = path.join(os.tmpdir(), `tbm-empty-state-${Date.now()}.json`);
    const multiStatePath = path.join(os.tmpdir(), `tbm-multi-state-${Date.now()}.json`);

    try {
      const emptyIsoOpen = await manager.tabsBatch([
        { action: 'open', url: `${baseUrl1}/tab?id=empty-iso`, isolatedContext: 'iso-empty', activate: false },
      ]);
      const emptyTabId = emptyIsoOpen.results[0].tabId;

      const savedEmpty = await manager.manageNetworkSession(emptyTabId, {
        saveStorageStatePath: emptyStatePath,
      });
      assert.equal(savedEmpty.savedStorageStatePath, emptyStatePath);
      const rawEmpty = JSON.parse(fs.readFileSync(emptyStatePath, 'utf8'));
      assert.deepEqual(rawEmpty.cookies, []);

      const loadedEmpty = await manager.manageNetworkSession(emptyTabId, {
        loadStorageStatePath: emptyStatePath,
        cookieAction: 'get',
        storageAction: 'get',
      });
      assert.equal(loadedEmpty.loadedStorageStatePath, emptyStatePath);
      assert.deepEqual(loadedEmpty.cookies, []);
      assert.deepEqual(loadedEmpty.storage.local, {});

      const srcOpen1 = await manager.tabsBatch([
        { action: 'open', url: `${baseUrl1}/tab?id=o1`, isolatedContext: 'iso-multi-src', activate: false },
      ]);
      const srcTab1 = srcOpen1.results[0].tabId;
      await manager.manageNetworkSession(srcTab1, {
        cookieAction: 'set',
        cookies: [
          { name: 'c_origin1', value: 'v_origin1', url: baseUrl1 },
          { name: 'c_origin1_extra', value: 'v_extra', url: baseUrl1 },
        ],
        storageAction: 'set',
        storageType: 'local',
        items: { origin1Key: 'origin1Val' },
      });

      await manager.tabsBatch([{ action: 'navigate', tabId: srcTab1, url: `${baseUrl2}/tab?id=o2` }]);
      await manager.manageNetworkSession(srcTab1, {
        cookieAction: 'set',
        cookies: [{ name: 'c_origin2', value: 'v_origin2', url: baseUrl2 }],
        storageAction: 'set',
        storageType: 'local',
        items: { origin2Key: 'origin2Val' },
        saveStorageStatePath: multiStatePath,
      });

      const savedMultiRaw = JSON.parse(fs.readFileSync(multiStatePath, 'utf8'));
      assert.equal(savedMultiRaw.cookies.length, 3, 'should save all 3 cookies across both origins');
      assert.equal(savedMultiRaw.origins.length, 2, 'should save localStorage for both origins');

      const dstOpen = await manager.tabsBatch([
        { action: 'open', url: `${baseUrl1}/tab?id=dst1`, isolatedContext: 'iso-multi-dst', activate: false },
      ]);
      const dstTab = dstOpen.results[0].tabId;

      const loadedMulti1 = await manager.manageNetworkSession(dstTab, {
        loadStorageStatePath: multiStatePath,
        cookieAction: 'get',
        urls: [baseUrl1, baseUrl2],
        storageAction: 'get',
        storageType: 'local',
      });
      assert.equal(loadedMulti1.cookies.length, 3, 'loadStorageStatePath must load cookies before cookieAction=get');
      assert.equal(
        loadedMulti1.storage.local.origin1Key,
        'origin1Val',
        'loadStorageStatePath must populate localStorage before storageAction=get'
      );

      await manager.tabsBatch([{ action: 'navigate', tabId: dstTab, url: `${baseUrl2}/tab?id=dst2` }]);
      const loadedMulti2 = await manager.manageNetworkSession(dstTab, {
        storageAction: 'get',
        storageType: 'local',
      });
      assert.equal(
        loadedMulti2.storage.local.origin2Key,
        'origin2Val',
        'multi-origin storageState should restore localStorage for non-active origins upon navigation'
      );
    } finally {
      for (const f of [emptyStatePath, multiStatePath]) {
        if (f && fs.existsSync(f)) fs.unlinkSync(f);
      }
    }
  });

  it('4c. Network session edge cases: download success + mid-stream aborted download error handling & clean cleanup', async () => {
    const downloadedFilesToClean = [];
    try {
      const dlOpen = await manager.tabsBatch([
        { action: 'open', url: `${baseUrl1}/downloads-page`, isolatedContext: 'iso-dl', activate: true },
      ]);
      const dlTab = dlOpen.activeTabId;
      const { page: dlPage } = await manager.getPage(dlTab);

      await actFast(dlPage, { action: 'click', selector: '#dl-ok' });
      await actFast(dlPage, { action: 'click', selector: '#dl-abort' });
      await actFast(dlPage, { action: 'wait', ms: 300 });

      const dlDiag = await manager.getDiagnostics(dlTab);
      const internalDlDiag = manager.diagnostics.get(dlPage);
      assert.equal(internalDlDiag.pendingDownloads.length, 0, 'all pendingDownloads must settle and clean up');

      const okDl = dlDiag.downloads.find((d) => d.suggestedFilename === 'stress-ok.txt');
      assert.ok(okDl, 'successful download must be recorded');
      assert.ok(okDl.savePath && fs.existsSync(okDl.savePath));
      assert.equal(fs.readFileSync(okDl.savePath, 'utf8'), 'stress-download-payload-ok');
      downloadedFilesToClean.push(okDl.savePath);

      const abortDl = dlDiag.downloads.find((d) => d.suggestedFilename === 'stress-abort.bin');
      assert.ok(abortDl, 'aborted download must be recorded in diagnostics');
      if (abortDl.savePath) downloadedFilesToClean.push(abortDl.savePath);
      assert.ok(
        abortDl.error || !abortDl.savePath || !fs.existsSync(abortDl.savePath),
        'aborted mid-stream download should record error and not leave corrupt file behind'
      );
    } finally {
      for (const f of downloadedFilesToClean) {
        if (f && fs.existsSync(f)) fs.unlinkSync(f);
      }
    }
  });

  it('5a. MCP JSON-RPC error handling: unknown tool name and missing required arguments return isError:true', async () => {
    const rpcHandle = createJsonRpcHandler(manager);

    const unknownToolRes = await rpcHandle({
      jsonrpc: '2.0',
      id: 101,
      method: 'tools/call',
      params: { name: 'nonexistent_tool_xyz', arguments: {} },
    });
    assert.equal(unknownToolRes.result.isError, true);
    assert.match(unknownToolRes.result.content[0].text, /Unknown tool: nonexistent_tool_xyz/i);

    const missingActionRes = await rpcHandle({
      jsonrpc: '2.0',
      id: 102,
      method: 'tools/call',
      params: { name: 'act_fast', arguments: {} },
    });
    assert.equal(missingActionRes.result.isError, true);
    assert.match(missingActionRes.result.content[0].text, /act_fast requires action/i);

    const missingExprRes = await rpcHandle({
      jsonrpc: '2.0',
      id: 103,
      method: 'tools/call',
      params: { name: 'evaluate_js', arguments: {} },
    });
    assert.equal(missingExprRes.result.isError, true);
    assert.match(missingExprRes.result.content[0].text, /evaluate_js requires an expression/i);

    const missingStepsRes = await rpcHandle({
      jsonrpc: '2.0',
      id: 104,
      method: 'tools/call',
      params: { name: 'batch_actions', arguments: {} },
    });
    assert.equal(missingStepsRes.result.isError, true, 'batch_actions with missing required steps must return isError: true');
  });

  it('5b. MCP stdio JSON-RPC stress: irregular tiny byte chunks, back-to-back pipelined requests, malformed JSON recovery, and allowSubmit default vs TURBO_BROWSER_ALLOW_SUBMIT=true', async () => {
    const child1 = spawn(process.execPath, [ENTRY_PATH], {
      env: {
        ...process.env,
        TURBO_BROWSER_MODE: 'launch',
        TURBO_BROWSER_HEADLESS: 'true',
        TURBO_BROWSER_ALLOW_SUBMIT: 'false',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let rawOut1 = Buffer.alloc(0);
    let stderr1 = '';
    const replies1 = new Map();

    child1.stderr.on('data', (c) => {
      stderr1 += c.toString('utf8');
    });

    child1.stdout.on('data', (chunk) => {
      rawOut1 = Buffer.concat([rawOut1, chunk]);
      while (true) {
        const hdrEnd = rawOut1.indexOf('\r\n\r\n');
        if (hdrEnd === -1) break;
        const hdr = rawOut1.subarray(0, hdrEnd).toString('utf8');
        const m = /Content-Length:\s*(\d+)/i.exec(hdr);
        if (!m) break;
        const len = Number(m[1]);
        if (rawOut1.length < hdrEnd + 4 + len) break;
        const body = rawOut1.subarray(hdrEnd + 4, hdrEnd + 4 + len).toString('utf8');
        rawOut1 = rawOut1.subarray(hdrEnd + 4 + len);
        const msg = JSON.parse(body);
        if (msg.id !== undefined) replies1.set(msg.id, msg);
      }
    });

    const waitForReply = async (map, id, timeoutMs = 15000) => {
      const deadline = Date.now() + timeoutMs;
      while (!map.has(id) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(map.has(id), `Timed out waiting for JSON-RPC reply id=${id} (stderr: ${stderr1})`);
      return map.get(id);
    };

    const encodeFrame = (obj, headerPrefix = 'Content-Length') => {
      const json = typeof obj === 'string' ? obj : JSON.stringify(obj);
      const byteLen = Buffer.byteLength(json, 'utf8');
      return Buffer.from(`${headerPrefix}: ${byteLen}\r\n\r\n${json}`, 'utf8');
    };

    try {
      // Write initialize frame split across irregular tiny byte chunks (1, 2, 3, 5 bytes)
      const initFrame = encodeFrame({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', clientInfo: { name: 'chunk-tester 🚀' } },
      });
      const stepSizes = [1, 2, 3, 1, 4, 2, 5, 1, 3, 2, 7];
      let offset = 0;
      let stepIdx = 0;
      while (offset < initFrame.length) {
        const sz = stepSizes[stepIdx % stepSizes.length];
        stepIdx++;
        const slice = initFrame.subarray(offset, Math.min(initFrame.length, offset + sz));
        offset += slice.length;
        child1.stdin.write(slice);
        await new Promise((r) => setTimeout(r, 2));
      }

      const initReply = await waitForReply(replies1, 1);
      assert.equal(initReply.result.serverInfo.name, 'turbo-browser-mcp');

      // Send malformed JSON inside a Content-Length frame, immediately pipelined with 3 back-to-back valid frames in a SINGLE write
      const malformedFrame = encodeFrame('{"jsonrpc":"2.0","id":999,"method":BROKEN_JSON');
      const piped1 = encodeFrame({ jsonrpc: '2.0', id: 2, method: 'ping' });
      const piped2 = encodeFrame(
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'unknown_tool_2', arguments: {} } },
        'content-length'
      );
      const piped3 = encodeFrame({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'tabs_batch',
          arguments: { operations: [{ action: 'open', url: `${baseUrl1}/submit-guard` }] },
        },
      });

      child1.stdin.write(Buffer.concat([malformedFrame, piped1, piped2, piped3]));

      const r2 = await waitForReply(replies1, 2);
      const r3 = await waitForReply(replies1, 3);
      const r4 = await waitForReply(replies1, 4);

      assert.deepEqual(r2.result, {});
      assert.equal(r3.result.isError, true);
      assert.equal(r4.result.isError, false);
      assert.ok(
        /JSON parse error/i.test(stderr1) || replies1.get(null)?.error?.code === -32700,
        'malformed JSON should log parse error or return -32700 error response and recover'
      );

      // Verify default allowSubmit=false blocks #submit-btn click when allowSubmit is omitted
      child1.stdin.write(
        encodeFrame({
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: { name: 'act_fast', arguments: { action: 'click', selector: '#submit-btn' } },
        })
      );
      const r5 = await waitForReply(replies1, 5);
      const r5Payload = JSON.parse(r5.result.content[0].text);
      assert.equal(r5Payload.blocked, true, 'default allowSubmit=false must block submit button');

      child1.stdin.write(
        encodeFrame({
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: { name: 'tabs_batch', arguments: { operations: [{ action: 'close_browser' }] } },
        })
      );
      await waitForReply(replies1, 6);
    } finally {
      child1.stdin.end();
      await new Promise((resolve) => child1.once('exit', resolve));
    }

    // Verify TURBO_BROWSER_ALLOW_SUBMIT=true env flag permits submit by default while explicit allowSubmit=false still blocks
    const prevEnv = process.env.TURBO_BROWSER_ALLOW_SUBMIT;
    process.env.TURBO_BROWSER_ALLOW_SUBMIT = 'true';
    try {
      await dispatchToolCall(manager, 'tabs_batch', {
        operations: [{ action: 'open', url: `${baseUrl1}/submit-guard` }],
      });

      const explicitBlockedOut = await dispatchToolCall(manager, 'act_fast', {
        action: 'click',
        selector: '#submit-btn',
        allowSubmit: false,
      });
      assert.equal(JSON.parse(explicitBlockedOut.text).blocked, true);

      const envAllowedOut = await dispatchToolCall(manager, 'act_fast', {
        action: 'click',
        selector: '#submit-btn',
      });
      const envAllowedPayload = JSON.parse(envAllowedOut.text);
      assert.equal(envAllowedPayload.ok, true);
      assert.equal(Boolean(envAllowedPayload.blocked), false);

      const submitCountOut = await dispatchToolCall(manager, 'evaluate_js', {
        expression: 'window.__submitCount',
      });
      assert.equal(JSON.parse(submitCountOut.text).result, 1);
    } finally {
      if (prevEnv === undefined) delete process.env.TURBO_BROWSER_ALLOW_SUBMIT;
      else process.env.TURBO_BROWSER_ALLOW_SUBMIT = prevEnv;
    }
  });
});
