// Offline regression tests for field report round 7: CDP Allow wait and stale-bridge kill, navigate retry on
// ERR_ABORTED, wait textNew, late aftermath. Nothing here touches a real Chrome: headless launch, fake files, fake sockets.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { killVerifiedStaleBridge, probeBridge } from '../src/cdp-bridge.mjs';
import { actFast, batchActions } from '../src/dom-engine.mjs';
import { dispatchToolCall, TOOL_DEFINITIONS } from '../src/index.mjs';
import { cdpConnectWaitMs, hasDevToolsActivePort } from '../src/playwright-loader.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.once('error', reject);
});

const PAGES = {
  '/start': '<!doctype html><title>Start</title><p>start</p>',
  '/target': '<!doctype html><title>Target</title><p>target</p>',
  '/list':
    '<!doctype html><title>L</title><ul id="l"><li>Succeeded</li></ul><button id="b">go</button>' +
    '<script>b.onclick=()=>setTimeout(()=>{const li=document.createElement("li");li.textContent="Succeeded";l.appendChild(li)},500);' +
    'window.swap=()=>setTimeout(()=>{l.innerHTML="<li>Succeeded</li>"},400)</script>',
  '/late-nav': '<!doctype html><title>N</title><button id="go" onclick="setTimeout(()=>{location.href=\'/target\'},1000)">go</button>',
  '/late-post':
    '<!doctype html><title>P</title><button id="go" onclick="setTimeout(()=>{fetch(\'/api/save\',{method:\'POST\',body:\'x\'})},1000)">go</button>',
  '/plain': '<!doctype html><title>Q</title><button id="go" onclick="document.title=\'x\'">go</button>',
};

function captureStderr() {
  const orig = process.stderr.write;
  const lines = [];
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    const cb = rest.at(-1);
    if (typeof cb === 'function') cb();
    return true;
  };
  return { lines, restore: () => { process.stderr.write = orig; } };
}

describe('round 7 fix 1: CDP Allow wait', () => {
  it('1a: 45 s when a DevToolsActivePort file exists, 10 s otherwise, env and explicit option override', () => {
    assert.equal(cdpConnectWaitMs({ human: true, env: {} }), 45000);
    assert.equal(cdpConnectWaitMs({ human: false, env: {} }), 10000);
    assert.equal(cdpConnectWaitMs({ human: false, env: { TURBO_BROWSER_ALLOW_WAIT_MS: '90000' } }), 10000);
    assert.equal(cdpConnectWaitMs({ human: true, env: { TURBO_BROWSER_ALLOW_WAIT_MS: '90000' } }), 90000);
    assert.equal(cdpConnectWaitMs({ human: true, env: { TURBO_BROWSER_ALLOW_WAIT_MS: 'abc' } }), 45000);
    assert.equal(cdpConnectWaitMs({ human: true, optionMs: 1500, env: {} }), 1500);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-dtap-'));
    try {
      assert.equal(hasDevToolsActivePort(dir, 'http://127.0.0.1:1'), false);
      fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '1\n/devtools/browser/x\n');
      assert.equal(hasDevToolsActivePort(dir, 'http://127.0.0.1:1'), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('1b: auto mode with a silent DevToolsActivePort endpoint prints one stderr line and waits the Allow window', async () => {
    const hang = net.createServer((s) => s.on('error', () => {}));
    await new Promise((r) => hang.listen(0, '127.0.0.1', r));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-dtap-'));
    fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), `${hang.address().port}\n/devtools/browser/fake-guid\n`);
    const prevBridge = process.env.TURBO_BROWSER_DISABLE_BRIDGE, prevWait = process.env.TURBO_BROWSER_ALLOW_WAIT_MS;
    process.env.TURBO_BROWSER_DISABLE_BRIDGE = 'true';
    process.env.TURBO_BROWSER_ALLOW_WAIT_MS = '2500';
    const cap = captureStderr();
    const m = new BrowserManager({ mode: 'auto', headless: true, cdpUrl: 'http://127.0.0.1:1', userDataDir: dir });
    try {
      const t0 = Date.now();
      const first = await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'list' }] });
      const took = Date.now() - t0;
      cap.restore();
      assert.ok(took >= 2300, `gave up after ${took} ms, before the Allow window`);
      assert.deepEqual(cap.lines.filter((l) => /waiting for 'Allow'/.test(l)), ["waiting for 'Allow' in Chrome (up to 3 s)\n"]);
      assert.match(first.text, /connectionNote.*fallback \(cdp: no response within 3s/, first.text.slice(0, 300));
    } finally {
      cap.restore();
      if (prevBridge === undefined) delete process.env.TURBO_BROWSER_DISABLE_BRIDGE; else process.env.TURBO_BROWSER_DISABLE_BRIDGE = prevBridge;
      if (prevWait === undefined) delete process.env.TURBO_BROWSER_ALLOW_WAIT_MS; else process.env.TURBO_BROWSER_ALLOW_WAIT_MS = prevWait;
      await m.close().catch(() => {});
      hang.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('1c: without DevToolsActivePort auto mode stays quiet on stderr', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-nodtap-'));
    const cap = captureStderr();
    const m = new BrowserManager({ mode: 'auto', headless: true, cdpUrl: 'http://127.0.0.1:1', userDataDir: dir });
    try {
      await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'list' }] });
      cap.restore();
      assert.equal(cap.lines.filter((l) => /waiting for 'Allow'/.test(l)).length, 0);
    } finally {
      cap.restore();
      await m.close().catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('1d: a stale bridge from older code is terminated when its command line proves it is ours, and left alone otherwise', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-oldbridge-'));
    const script = path.join(dir, 'cdp-bridge.mjs'); // old daemon: knows /json/version, has no /shutdown route
    fs.writeFileSync(script, `import http from 'node:http';
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
http.createServer((req, res) => {
  if (req.url.startsWith('/json/version')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ turboBridge: true, upstreamUrl: 'ws://127.0.0.1:1/x', upstreamConnected: false })); return; }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1');
`);
    const port = await freePort();
    const child = spawn(process.execPath, [script, '--daemon', '--upstream', 'ws://127.0.0.1:1/x', '--port', String(port), '--host', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
    // A foreign listener that only imitates the JSON answer: this test process, so no cdp-bridge.mjs in its command line.
    const impostorPort = await freePort();
    const impostor = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"turboBridge":true,"upstreamConnected":false,"upstreamUrl":"ws://x"}');
    });
    await new Promise((r) => impostor.listen(impostorPort, '127.0.0.1', r));
    try {
      for (let i = 0; i < 50 && !(await probeBridge(port)); i++) await sleep(100);
      assert.ok(await probeBridge(port), 'fake old daemon did not start');
      assert.equal(await killVerifiedStaleBridge(impostorPort), false);
      assert.ok(await probeBridge(impostorPort), 'impostor must not be killed');
      assert.equal(await killVerifiedStaleBridge(port), true);
      assert.equal(await probeBridge(port), null);
    } finally {
      child.kill();
      impostor.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('round 7 fixes 2-4: navigate retry, textNew, late aftermath', () => {
  let m, page, srv, base;
  before(async () => {
    srv = http.createServer((req, res) => {
      if (req.method === 'POST') { res.writeHead(200); res.end('ok'); return; }
      const body = PAGES[req.url.split('?')[0]];
      res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html' });
      res.end(body || '<!doctype html><title>nf</title>');
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

  it('2: navigate retries once on ERR_ABORTED when the tab did not move, and reports retried:1 only then', async () => {
    await page.goto(`${base}/start`);
    let hits = 0;
    await page.route('**/target', (route) => (++hits === 1 ? route.abort('aborted') : route.continue()));
    const r = await batchActions(page, [{ action: 'navigate', url: `${base}/target` }]);
    assert.equal(r.results[0].ok, true, JSON.stringify(r));
    assert.equal(r.results[0].retried, 1);
    assert.match(page.url(), /\/target$/);
    // tabs_batch navigate takes the same path
    await page.goto(`${base}/start`);
    hits = 0;
    const t = await m.tabsBatch([{ action: 'navigate', url: `${base}/target` }]);
    assert.notEqual(t.results[0].ok, false, JSON.stringify(t));
    assert.equal(t.results[0].retried, 1, JSON.stringify(t));
    // no abort: no retried key
    await page.unroute('**/target');
    await page.goto(`${base}/start`);
    const clean = await batchActions(page, [{ action: 'navigate', url: `${base}/target` }]);
    assert.equal('retried' in clean.results[0], false);
    // a persistent abort still fails after the single retry
    await page.goto(`${base}/start`);
    hits = 0;
    await page.route('**/target', (route) => { hits++; return route.abort('aborted'); });
    const bad = await batchActions(page, [{ action: 'navigate', url: `${base}/target` }], { continueOnError: true });
    assert.equal(hits, 2);
    assert.match(JSON.stringify(bad), /ERR_ABORTED/);
    await page.unroute('**/target');
  });

  it('3: wait textNew ignores existing matches and resolves on a new one; text keeps returning at once', async () => {
    await page.goto(`${base}/list`);
    let t0 = Date.now();
    await actFast(page, { action: 'wait', text: 'Succeeded', timeoutMs: 3000 });
    assert.ok(Date.now() - t0 < 300, 'existing text should resolve at once');
    await page.click('#b'); // a new "Succeeded" row appears after 500 ms
    t0 = Date.now();
    const r = await actFast(page, { action: 'wait', textNew: 'Failed|Succeeded', timeoutMs: 4000 });
    const took = Date.now() - t0;
    assert.equal(r.ok, true);
    assert.equal(r.matched, 'Succeeded');
    assert.ok(took >= 400 && took < 2500, `textNew resolved after ${took} ms`);
    assert.equal(await page.locator('li').count(), 2);
    // nothing new: times out
    await assert.rejects(actFast(page, { action: 'wait', textNew: 'Succeeded', timeoutMs: 700 }), /Timed out.*new/);
    // an element replaced by an identical new one counts as new
    const swap = page.evaluate(() => window.swap());
    t0 = Date.now();
    await actFast(page, { action: 'wait', textNew: 'Succeeded', timeoutMs: 3000 });
    await swap;
    assert.ok(Date.now() - t0 >= 300);
  });

  it('3b: textNew is in the act_fast schema in one short phrase; schema keeps oneOf, no type arrays', () => {
    const def = TOOL_DEFINITIONS.find((t) => t.name === 'act_fast');
    assert.ok(def.inputSchema.properties.textNew.description.length < 130);
    assert.doesNotMatch(JSON.stringify(TOOL_DEFINITIONS), /"type":\[/);
  });

  it('4: a navigation or POST landing after a click returned is attached once to the next tool result', async () => {
    for (const [route, expected] of [['/late-nav', 'navigated to /target'], ['/late-post', 'POST /api/save']]) {
      await page.goto(`${base}${route}`);
      const click = await dispatchToolCall(m, 'act_fast', { action: 'click', selector: '#go', observeAftermath: true });
      assert.match(click.text, /"navigated":false/, click.text.slice(0, 300));
      assert.doesNotMatch(click.text, /"late"/);
      await sleep(1700);
      const next = await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'list' }] });
      assert.ok(next.text.includes(`"late":"${expected}"`), `${route}: ${next.text.slice(0, 200)}`);
      const again = await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'list' }] });
      assert.doesNotMatch(again.text, /"late"/);
    }
  });

  it('4b: nothing late is reported for a quiet click, or when aftermath is off', async () => {
    await page.goto(`${base}/plain`);
    await dispatchToolCall(m, 'act_fast', { action: 'click', selector: '#go', observeAftermath: true });
    await sleep(2300);
    const quiet = await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'list' }] });
    assert.doesNotMatch(quiet.text, /"late"/);
    await page.goto(`${base}/late-nav`);
    await dispatchToolCall(m, 'act_fast', { action: 'click', selector: '#go' });
    await sleep(1600);
    const off = await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'list' }] });
    assert.doesNotMatch(off.text, /"late"/);
  });
});
