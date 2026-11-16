// Isolated browser contexts die with the process/client that created them (CDP mode), the default context is
// never touched, and tabs in someone else's context are not listed as "default".
// Headless Chromium launched here; never the owner's Chrome and never ports 9222/9224.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BrowserManager } from '../src/browser-manager.mjs';
import { batchActions } from '../src/dom-engine.mjs';
import { createCdpBridgeServer } from '../src/cdp-bridge.mjs';
import { loadPlaywright, resolveChromiumExecutable } from '../src/playwright-loader.mjs';

const INDEX_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.mjs');
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.once('error', reject);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = (title) => `data:text/html,<title>${title}</title><p>${title}</p>`;

describe('round 10: isolated contexts are cleaned up', () => {
  let chromium, upstream, cdpPort, bridge;
  const urls = async () => (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).filter((t) => t.type === 'page').map((t) => t.url);
  const has = async (marker) => (await urls()).some((u) => u.includes(marker));
  const waitGone = async (marker, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (!(await has(marker))) return true; await sleep(100); }
    return false;
  };

  before(async () => {
    ({ chromium } = await loadPlaywright());
    cdpPort = await freePort();
    upstream = await chromium.launch({ headless: true, ...resolveChromiumExecutable(chromium, true), args: [`--remote-debugging-port=${cdpPort}`] });
    const v = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
    bridge = await createCdpBridgeServer({ upstreamUrl: v.webSocketDebuggerUrl, port: await freePort() });
  });
  after(async () => {
    await bridge?.close().catch(() => {});
    await upstream?.close().catch(() => {});
  });

  it('bridge: a disconnecting client takes its isolated contexts along, default-context pages stay', async () => {
    const A = await chromium.connectOverCDP(bridge.bridgeHttpUrl);
    const iso = await A.newContext();
    const pIso = await iso.newPage();
    await pIso.goto(page('BR_ISO_A'));
    const pDef = await A.contexts()[0].newPage();
    await pDef.goto(page('BR_DEF_A'));
    assert.ok(await has('BR_ISO_A') && await has('BR_DEF_A'));

    await A.close();
    assert.ok(await waitGone('BR_ISO_A'), 'isolated tab must be gone after the client disconnects');
    assert.ok(await has('BR_DEF_A'), 'default-context tab must stay');
  });

  it('bridge: a context another client already works in is not disposed', async () => {
    const A = await chromium.connectOverCDP(bridge.bridgeHttpUrl);
    const pIso = await (await A.newContext()).newPage();
    await pIso.goto(page('BR_SHARED'));
    const B = await chromium.connectOverCDP(bridge.bridgeHttpUrl);
    const seen = [...B.contexts().flatMap((c) => c.pages())].find((p) => p.url().includes('BR_SHARED'));
    assert.ok(seen, 'B sees the shared page');
    await A.close();
    await sleep(800);
    assert.ok(await has('BR_SHARED'), 'B is using the context, so it survives A leaving');
    await B.close();
    assert.ok(await waitGone('BR_SHARED'), 'and goes when the last user leaves');
  });

  it('listing: tabs in a context this process did not create are not labeled default', async () => {
    const A = new BrowserManager({ mode: 'cdp', cdpUrl: bridge.bridgeHttpUrl });
    const B = new BrowserManager({ mode: 'cdp', cdpUrl: bridge.bridgeHttpUrl });
    try {
      await A.tabsBatch([{ action: 'open', url: page('LS_ISO_A'), isolatedContext: 'verify9' }, { action: 'open', url: page('LS_DEF_A') }]);
      await B.tabsBatch([{ action: 'open', url: page('LS_ISO_B'), isolatedContext: 'mine' }]);
      const list = await B.tabsBatch([{ action: 'list' }]);
      const byTitle = (t) => list.tabs.find((x) => x.title === t);
      assert.equal(byTitle('LS_ISO_B')?.isolatedContext, 'mine');
      assert.equal(byTitle('LS_DEF_A')?.isolatedContext, 'default');
      const foreign = byTitle('LS_ISO_A');
      assert.ok(!foreign || foreign.isolatedContext === 'other', `foreign isolated tab labeled ${foreign?.isolatedContext}`);
    } finally {
      await A.close().catch(() => {});
      await B.close().catch(() => {});
    }
    assert.ok(await waitGone('LS_ISO_A') && await waitGone('LS_ISO_B'));
    assert.ok(await has('LS_DEF_A'), 'default-context tab stays');
  });

  it('server process: closing stdin closes its isolated tabs, not the default ones', async () => {
    const child = spawn(process.execPath, [INDEX_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TURBO_BROWSER_MODE: 'cdp', TURBO_BROWSER_CDP_URL: bridge.bridgeHttpUrl },
    });
    const pending = new Map();
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!l) continue;
        const m = JSON.parse(l);
        pending.get(m.id)?.(m);
      }
    });
    let id = 0;
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const myId = ++id;
      const t = setTimeout(() => reject(new Error(`rpc ${method} timed out`)), 30000);
      pending.set(myId, (m) => { clearTimeout(t); resolve(m); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`);
    });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
      const r = await rpc('tools/call', {
        name: 'tabs_batch',
        arguments: { operations: [
          { action: 'open_many', urls: [page('SP_ISO_1'), page('SP_ISO_2')], isolatedContext: 'verify9' },
          { action: 'open', url: page('SP_DEF') },
        ] },
      });
      assert.ok(!r.result?.isError, JSON.stringify(r).slice(0, 400));
      assert.ok(await has('SP_ISO_1') && await has('SP_ISO_2') && await has('SP_DEF'));
      child.stdin.end();
      await Promise.race([exited, sleep(10000).then(() => { throw new Error('server did not exit'); })]);
      assert.ok(await waitGone('SP_ISO_1') && await waitGone('SP_ISO_2'), 'isolated tabs closed on shutdown');
      assert.ok(await has('SP_DEF'), 'default-context tab untouched');
    } finally {
      child.kill();
    }
  });
});

describe('round 10: wait textNew right after navigate counts the new document as new', () => {
  let chromium, browser, srv, base;
  before(async () => {
    ({ chromium } = await loadPlaywright());
    browser = await chromium.launch({ headless: true, ...resolveChromiumExecutable(chromium, true) });
    srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(req.url.startsWith('/results')
        ? '<!doctype html><title>R</title><h2>There are 12 jobs</h2>'
        : '<!doctype html><title>H</title><p>home</p>');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${srv.address().port}`;
  });
  after(async () => {
    await browser?.close().catch(() => {});
    await new Promise((r) => srv.close(r));
  });

  it('navigate then wait textNew sees text that arrived with the page', async () => {
    const p = await browser.newPage();
    const out = await batchActions(p, [
      { action: 'navigate', url: `${base}/results` },
      { action: 'wait', textNew: 'There are|jobs', timeoutMs: 3000 },
    ]);
    assert.equal(out.completed, 2, JSON.stringify(out));
    assert.equal(out.results[1].ok, true);
  });

  it('wait textNew after a non-navigation step still ignores text already on the page', async () => {
    const p = await browser.newPage();
    await p.goto(`${base}/results`);
    const out = await batchActions(p, [
      { action: 'wait', ms: 10 },
      { action: 'wait', textNew: 'There are', timeoutMs: 600 },
    ], { continueOnError: true });
    assert.equal(out.results[1].ok, false, JSON.stringify(out));
  });
});
