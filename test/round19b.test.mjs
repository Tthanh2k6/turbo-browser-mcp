// Round 19b: ad beacons are not submits, a live token bridge is never swapped for a signed-out browser,
// tests keep out of the real home folder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { bridgeStatePath } from '../src/cdp-bridge.mjs';
import { turboHome } from '../src/home.mjs';
import { dispatchToolCall } from '../src/index.mjs';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.once('error', reject);
});
const realHome = path.join(os.homedir(), '.turbo-browser-mcp');
const bridgeFiles = () => { try { return fs.readdirSync(realHome).filter((f) => /^bridge-\d+\.json$/.test(f)).length; } catch { return 0; } };
const realBefore = bridgeFiles();

describe('round 19b: state folder', () => {
  it('tests write their state into a temp folder, not the real home', () => {
    assert.ok(process.env.TURBO_BROWSER_HOME, 'run through npm test (node --import ./test/setup-home.mjs)');
    assert.notEqual(path.resolve(turboHome()), path.resolve(realHome));
    assert.ok(bridgeStatePath(1234).startsWith(path.resolve(process.env.TURBO_BROWSER_HOME)));
  });
  it('the real home gained no bridge-<port>.json files during this file', () => {
    assert.equal(bridgeFiles(), realBefore);
  });
});

describe('round 19b: possibleSubmit and ad beacons', () => {
  let web, port, m;
  before(async () => {
    web = http.createServer((req, res) => {
      if (req.method !== 'GET') { res.writeHead(200); res.end('ok'); return; }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>P</title>
        <button id="ads" onclick="setTimeout(()=>fetch('/v1/publishers/dev-to-1',{method:'POST',body:'x'}),300)">ad</button>
        <button id="pub" onclick="setTimeout(()=>fetch('/api/save',{method:'POST',body:'x'}),300)">Save</button>
        <button id="beacon" onclick="navigator.sendBeacon('/api/log','x')">b</button>`);
    });
    await new Promise((r) => web.listen(0, '127.0.0.1', r));
    port = web.address().port;
    m = new BrowserManager({ mode: 'launch', headless: true });
    await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'open', url: `http://127.0.0.1:${port}/` }] });
  });
  after(async () => { await m?.close().catch(() => {}); await new Promise((r) => web.close(r)); });
  const late = async () => { await new Promise((r) => setTimeout(r, 700)); return JSON.parse((await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'list' }] })).text).late; };

  it('an ads POST after a click is not reported', async () => {
    await dispatchToolCall(m, 'act_fast', { action: 'click', selector: '#ads' });
    assert.equal(await late(), undefined);
  });
  it('a sendBeacon is not reported', async () => {
    await dispatchToolCall(m, 'act_fast', { action: 'click', selector: '#beacon' });
    assert.equal(await late(), undefined);
  });
  it('after a guarded submit with allowSubmit no late possibleSubmit is attached', async () => {
    await dispatchToolCall(m, 'act_fast', { action: 'click', selector: '#pub', allowSubmit: true });
    assert.equal(await late(), undefined);
  });
  it('an unclassified click that POSTs late is still reported', async () => {
    await dispatchToolCall(m, 'act_fast', { action: 'click', selector: '#pub' });
    assert.match(String(await late()), /possibleSubmit: POST 127\.0\.0\.1/);
  });
});

describe('round 19b: a live bridge is not replaced by a launch browser', () => {
  it('a bridge that answers /json/version but never completes the attach gets one longer retry, then a clear error', async () => {
    const port = await freePort();
    const token = 'tok-test';
    const upstream = `ws://127.0.0.1:${port}/devtools/browser/up`;
    fs.mkdirSync(path.dirname(bridgeStatePath(port)), { recursive: true });
    fs.writeFileSync(bridgeStatePath(port), JSON.stringify({ token }));
    let upgrades = 0;
    const fake = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        Browser: 'Chrome/Fake', 'Protocol-Version': '1.3', turboBridge: true, tokenRequired: true, upstreamConnected: true, upstreamUrl: upstream,
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/turbo-bridge?token=${token}`,
      }));
    });
    const stuck = [];
    fake.on('upgrade', (_req, socket) => { upgrades++; stuck.push(socket); /* never answered: a bridge stuck attaching to its tabs */ });
    await new Promise((r) => fake.listen(port, '127.0.0.1', r));
    const m = new BrowserManager({ mode: 'auto', cdpUrl: upstream, useBridge: true, bridgePort: port, cdpAutoTimeoutMs: 700, bridgeRetryMs: 1200 });
    try {
      await assert.rejects(m.tabsBatch([{ action: 'list' }]), /CDP bridge on port \d+ is running but attaching through it failed.*Not opening a separate signed-out browser/s);
      assert.equal(upgrades, 2, 'one try and one retry');
      assert.equal(m.connectionType, null);
    } finally {
      for (const sock of stuck) sock.destroy();
      fake.closeAllConnections?.();
      await new Promise((r) => fake.close(r));
      await m.close().catch(() => {});
    }
  });
});
