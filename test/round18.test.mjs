// Round 18: the CDP bridge requires a token (random per start, user-only state file), checks Host and Origin, and an
// old tokenless bridge is replaced instead of reused. Random ports and an own Chromium only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import {
  bridgeStatePath, createCdpBridgeServer, ensureCdpBridgeDaemon, probeBridge, readBridgeToken, stopBridge,
} from '../src/cdp-bridge.mjs';
import { loadPlaywright, resolveChromiumExecutable } from '../src/playwright-loader.mjs';

const BRIDGE_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cdp-bridge.mjs');
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.once('error', reject);
});
const get = (port, route, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: route, headers }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', reject);
  req.end();
});
const upgrade = (port, route, headers = {}) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port, path: route, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } });
  req.on('upgrade', (_r, sock) => { sock.destroy(); resolve(101); });
  req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
  req.on('error', () => resolve(0));
  req.end();
});

describe('round 18: bridge authentication', () => {
  let up, upstreamWs, bridge, port;
  before(async () => {
    const { chromium } = await loadPlaywright();
    const cdp = await freePort();
    up = await chromium.launch({ headless: true, ...resolveChromiumExecutable(chromium, true), args: [`--remote-debugging-port=${cdp}`] });
    upstreamWs = (await (await fetch(`http://127.0.0.1:${cdp}/json/version`)).json()).webSocketDebuggerUrl;
    port = await freePort();
    bridge = await createCdpBridgeServer({ upstreamUrl: upstreamWs, port });
  });
  after(async () => {
    await bridge?.close().catch(() => {});
    await up?.close().catch(() => {});
  });

  it('refuses requests without the token, with a wrong token, a foreign Host or a page Origin', async () => {
    assert.ok(bridge.token && bridge.token.length >= 32);
    assert.equal(readBridgeToken(port), bridge.token, `state file ${bridgeStatePath(port)}`);
    assert.equal((await get(port, '/json/version')).status, 401);
    assert.equal((await get(port, '/healthz')).status, 401);
    assert.equal((await get(port, '/json/version', { 'x-turbo-bridge-token': 'nope' })).status, 401);
    assert.equal((await get(port, '/json/version', { 'x-turbo-bridge-token': bridge.token })).status, 200);
    assert.equal((await get(port, `/json/version?token=${bridge.token}`)).status, 200);
    assert.equal((await get(port, '/json/version', { 'x-turbo-bridge-token': bridge.token, Host: 'evil.example' })).status, 403);
    assert.equal((await get(port, '/json/version', { 'x-turbo-bridge-token': bridge.token, Origin: 'https://evil.example' })).status, 403);
    assert.equal(await upgrade(port, '/devtools/browser/turbo-bridge'), 401);
    assert.equal(await upgrade(port, `/devtools/browser/turbo-bridge?token=${bridge.token}`, { Origin: 'https://evil.example' }), 403);
    assert.equal(await upgrade(port, `/devtools/browser/turbo-bridge?token=${bridge.token}`), 101);
    const v = JSON.parse((await get(port, '/json/version', { 'x-turbo-bridge-token': bridge.token })).body);
    assert.match(v.webSocketDebuggerUrl, /\?token=/);
  });

  it('turbo clients pick the token up on their own', async () => {
    const info = await probeBridge(port);
    assert.equal(info.upstreamConnected, true);
    assert.equal(info.insecure, false);
    assert.match(info.bridgeHttpUrl, /token=/);
  });

  it('an old tokenless bridge is replaced by an authenticated one, never reused silently', async () => {
    const p2 = await freePort();
    const old = await createCdpBridgeServer({ upstreamUrl: upstreamWs, port: p2, insecure: true });
    const notes = [];
    let url;
    try {
      assert.equal((await probeBridge(p2)).insecure, true);
      url = await ensureCdpBridgeDaemon(upstreamWs, { bridgePort: p2, timeoutMs: 20000, onNote: (n) => notes.push(n) });
    } finally {
      await old.close().catch(() => {});
    }
    try {
      assert.ok(url && /token=/.test(url), String(url));
      assert.ok(notes.some((n) => /without a token/.test(n)), notes.join('|'));
      const after = await probeBridge(p2);
      assert.equal(after.insecure, false);
      assert.equal((await get(p2, '/json/version')).status, 401);
    } finally {
      await stopBridge(p2);
    }
  });

  it('the daemon refuses to start without a token unless --insecure is given', async () => {
    const p3 = await freePort();
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [BRIDGE_JS, '--daemon', '--upstream', upstreamWs, '--port', String(p3)], { stdio: 'ignore' });
      child.on('exit', resolve);
    });
    assert.equal(code, 1);
    assert.equal(await probeBridge(p3), null);
  });
});
