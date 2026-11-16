// Offline regression tests for field report round 6: collect state/fields/itemSelector/status note, CAPTCHA detection,
// stale CDP bridge replacement, and the auto-mode fallback note.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { createCdpBridgeServer, ensureCdpBridgeDaemon, probeBridge, stopBridge } from '../src/cdp-bridge.mjs';
import { batchActions, collectItems } from '../src/dom-engine.mjs';
import { dispatchToolCall } from '../src/index.mjs';
import { loadPlaywright, resolveChromiumExecutable } from '../src/playwright-loader.mjs';

const rows = (n, prefix) =>
  Array.from({ length: n }, (_, i) => `<tr class="job" data-x="${i}"><td><h2>${prefix} ${i}</h2><a href="/j/${i}">${prefix} ${i} apply</a></td></tr>`).join('');

const PAGES = {
  '/a': `<!doctype html><title>A</title><table>${rows(5, 'Alpha')}</table>`,
  '/b': `<!doctype html><title>B</title><table>${rows(7, 'Beta')}</table>`,
  '/late':
    '<!doctype html><title>L</title><table id="t"></table><script>setTimeout(()=>{document.getElementById("t").innerHTML=' +
    JSON.stringify(rows(3, 'Late')) +
    '},350)</script>',
  '/ddg': '<!doctype html><title>DuckDuckGo</title><body><p>Select all squares containing a duck</p></body>',
  '/robot': '<!doctype html><title>Search</title><body><p>Are you a robot? Please confirm.</p></body>',
  '/frame':
    '<!doctype html><title>Form</title><body><p>Please wait</p><iframe src="http://127.0.0.1:1/hcaptcha.com/captcha/v1/x" style="width:300px;height:400px"></iframe></body>',
  '/hidden-frame':
    '<!doctype html><title>Form</title><body><p>Sign up</p><iframe src="http://127.0.0.1:1/recaptcha/api2/bframe" style="position:absolute;left:-9999px;width:300px;height:400px"></iframe></body>',
};

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.once('error', reject);
  });
}

describe('field fixes round 5 (field report round 6): collect and blocked', () => {
  let m;
  let page;
  let srv;
  let base;
  before(async () => {
    srv = http.createServer((req, res) => {
      const body = PAGES[req.url.split('?')[0]];
      res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html' });
      res.end(body || '<!doctype html><title>Not found</title><p>nope</p>');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${srv.address().port}`;
    m = new BrowserManager({ mode: 'launch', headless: true });
    ({ page } = await m.getPage());
  });
  after(async () => {
    await m.close();
    await new Promise((r) => srv.close(r));
  });

  it('1a: collect keeps no state between calls or navigations on the same tab', async () => {
    const r = await batchActions(page, [
      { action: 'navigate', url: `${base}/a` },
      { action: 'collect', selector: 'tr.job', scrolls: 0 },
      { action: 'collect', selector: 'tr.job', scrolls: 0 },
      { action: 'navigate', url: `${base}/b` },
      { action: 'collect', selector: 'tr.job', scrolls: 0 },
    ]);
    assert.deepEqual([r.results[1].count, r.results[2].count, r.results[4].count], [5, 5, 7], JSON.stringify(r).slice(0, 300));
  });

  it('1a2: rows rendered shortly after domcontentloaded are still collected', async () => {
    await page.goto(`${base}/late`);
    const c = await collectItems(page, { selector: 'tr.job', scrolls: 0 });
    assert.equal(c.count, 3, JSON.stringify(c));
  });

  it('1b: missing fields are omitted and fall back to text when nothing is left', async () => {
    await page.goto(`${base}/a`);
    const c = await collectItems(page, { selector: 'tr.job', scrolls: 0, fields: ['id'] });
    assert.equal(c.count, 5);
    assert.ok(c.items.every((i) => typeof i === 'string' && /Alpha/.test(i)), JSON.stringify(c.items));
    const d = await collectItems(page, { selector: 'tr.job', scrolls: 0, fields: ['id', 'href'] });
    assert.deepEqual(Object.keys(d.items[0]), ['href']);
    assert.match(d.items[0].href, /\/j\/0$/);
  });

  it('1c: itemSelector reads text from a sub-element only', async () => {
    const full = await collectItems(page, { selector: 'tr.job', scrolls: 0 });
    const sub = await collectItems(page, { selector: 'tr.job', itemSelector: 'h2', scrolls: 0, fields: ['text', 'href'] });
    assert.equal(sub.items[0].text, 'Alpha 0');
    assert.match(sub.items[0].href, /\/j\/0$/);
    assert.ok(full.items[0].length > sub.items[0].text.length);
    const plain = await collectItems(page, { selector: 'tr.job', textSelector: 'h2', scrolls: 0 });
    assert.deepEqual(plain.items.slice(0, 2), ['Alpha 0', 'Alpha 1']);
  });

  it('1d: collect right after a 404 or blocked navigate says so', async () => {
    const r = await batchActions(page, [
      { action: 'navigate', url: `${base}/nothing-here` },
      { action: 'collect', selector: 'tr.job', scrolls: 0 },
      { action: 'navigate', url: `${base}/ddg` },
      { action: 'collect', selector: 'tr.job', scrolls: 0 },
    ], { continueOnError: true });
    assert.equal(r.results[1].count, 0);
    assert.match(r.results[1].note, /^page status 404/);
    assert.match(r.results[3].note, /^page blocked \(captcha\)/);
    const ok = await batchActions(page, [{ action: 'navigate', url: `${base}/a` }, { action: 'collect', selector: 'tr.job', scrolls: 0 }]);
    assert.equal(ok.results[1].note, undefined);
  });

  it('2: CAPTCHA/challenge pages are flagged blocked; hidden challenge frames are not', async () => {
    for (const p of ['/ddg', '/robot', '/frame']) {
      const r = await batchActions(page, [{ action: 'navigate', url: `${base}${p}` }]);
      assert.equal(r.results[0].blocked, 'captcha', `${p}: ${JSON.stringify(r.results[0])}`);
    }
    const r = await batchActions(page, [{ action: 'navigate', url: `${base}/hidden-frame` }]);
    assert.equal(r.results[0].blocked, undefined, JSON.stringify(r.results[0]));
  });
});

describe('field fixes round 5: startup and CDP bridge', () => {
  it('3a: a bridge whose upstream is gone is replaced quickly with a note', async () => {
    const { chromium } = await loadPlaywright();
    const exeOpt = resolveChromiumExecutable(chromium, true);
    const portA = await getFreePort();
    const portB = await getFreePort();
    const bridgePort = await getFreePort();
    const launch = (port) => chromium.launch({ headless: true, ...exeOpt, args: [`--remote-debugging-port=${port}`] });
    const wsOf = async (port) => (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
    const a = await launch(portA);
    const b = await launch(portB);
    let bridge;
    try {
      const wsA = await wsOf(portA);
      const wsB = await wsOf(portB);
      bridge = await createCdpBridgeServer({ upstreamUrl: wsA, port: bridgePort });
      assert.equal((await probeBridge(bridgePort)).upstreamUrl, wsA);
      await a.close(); // "Chrome restarted": the daemon is alive but its upstream is dead
      for (let i = 0; i < 30 && (await probeBridge(bridgePort))?.upstreamConnected; i++) await new Promise((r) => setTimeout(r, 100));
      assert.equal((await probeBridge(bridgePort)).upstreamConnected, false);
      const notes = [];
      const t0 = Date.now();
      const url = await ensureCdpBridgeDaemon(wsB, { bridgePort, timeoutMs: 15000, onNote: (n) => notes.push(n) });
      assert.ok(url, 'expected a bridge URL');
      assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0} ms`);
      assert.deepEqual(notes, ['bridge upstream stale: restarted']);
      const info = await probeBridge(bridgePort);
      assert.equal(info.upstreamUrl, wsB);
      assert.equal(info.upstreamConnected, true);
    } finally {
      await stopBridge(bridgePort).catch(() => {});
      await bridge?.close().catch(() => {});
      await a.close().catch(() => {});
      await b.close().catch(() => {});
    }
  });

  it('3b: auto mode with a silent CDP endpoint falls back fast and says why exactly once', async () => {
    const hang = net.createServer((s) => s.on('error', () => {}));
    await new Promise((r) => hang.listen(0, '127.0.0.1', r));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-dtap-'));
    fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), `${hang.address().port}\n/devtools/browser/fake-guid\n`);
    const prev = process.env.TURBO_BROWSER_DISABLE_BRIDGE;
    process.env.TURBO_BROWSER_DISABLE_BRIDGE = 'true';
    const m = new BrowserManager({ mode: 'auto', headless: true, cdpUrl: 'http://127.0.0.1:1', userDataDir: dir, cdpAutoTimeoutMs: 1500 });
    try {
      const t0 = Date.now();
      const first = await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'list' }] });
      assert.ok(Date.now() - t0 < 25000, `took ${Date.now() - t0} ms`);
      assert.match(first.text, /connectionNote.*fallback \(cdp: no response within 2s \(Chrome may be waiting for 'Allow remote debugging'\)\)/, first.text.slice(0, 300));
      assert.notEqual(m.connectionType, 'cdp');
      const second = await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'list' }] });
      assert.doesNotMatch(second.text, /connectionNote/);
    } finally {
      if (prev === undefined) delete process.env.TURBO_BROWSER_DISABLE_BRIDGE;
      else process.env.TURBO_BROWSER_DISABLE_BRIDGE = prev;
      await m.close().catch(() => {});
      hang.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
