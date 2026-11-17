// Round 13: a bridge whose Chrome vanished must not linger, and auto mode must say why it fell back to a launched browser.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { checkBridgeHealth, createCdpBridgeServer, probeBridge } from '../src/cdp-bridge.mjs';
import { dispatchToolCall } from '../src/index.mjs';
import { loadPlaywright, resolveChromiumExecutable } from '../src/playwright-loader.mjs';

const BRIDGE_JS = fileURLToPath(new URL('../src/cdp-bridge.mjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.once('error', reject);
  });
}

// Plain child process (not Playwright's launch) so the test can kill the browser the way a crash or quit would.
async function startChromium(port) {
  const { chromium } = await loadPlaywright();
  const exe = resolveChromiumExecutable(chromium, true).executablePath || chromium.executablePath();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-r13-'));
  const child = spawn(exe, ['--headless=new', '--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return { child, ws: (await res.json()).webSocketDebuggerUrl };
    } catch {}
    await sleep(150);
  }
  child.kill();
  throw new Error('chromium did not start');
}

const waitExit = (child, ms) => new Promise((resolve) => {
  if (child.exitCode !== null) return resolve(child.exitCode);
  const t = setTimeout(() => resolve('timeout'), ms);
  child.once('exit', (code) => { clearTimeout(t); resolve(code); });
});

describe('round 13: bridge upstream loss', () => {
  it('daemon exits with code 3 when Chrome dies and leaves the port free; the client gets a clean error', async () => {
    const cdpPort = await getFreePort();
    const bridgePort = await getFreePort();
    const { child: chrome, ws } = await startChromium(cdpPort);
    let daemon;
    let bm;
    try {
      let stderr = '';
      daemon = spawn(process.execPath, [BRIDGE_JS, '--daemon', '--upstream', ws, '--port', String(bridgePort), '--insecure'], { stdio: ['ignore', 'ignore', 'pipe'] });
      daemon.stderr.on('data', (d) => { stderr += d; });
      for (let i = 0; i < 60 && !(await probeBridge(bridgePort))?.upstreamConnected; i++) await sleep(150);
      assert.equal((await probeBridge(bridgePort))?.upstreamConnected, true);

      bm = new BrowserManager({ mode: 'cdp', cdpUrl: `http://127.0.0.1:${bridgePort}` });
      const { page } = await bm.getPage();
      assert.equal(await page.evaluate('1+1'), 2);

      const t0 = Date.now();
      chrome.kill('SIGKILL');
      const code = await waitExit(daemon, 12000);
      assert.equal(code, 3, `exit code ${code}, stderr: ${stderr}`);
      assert.ok(Date.now() - t0 < 12000);
      assert.match(stderr, /upstream .* closed and could not be re-established/);
      assert.equal(await probeBridge(bridgePort), null, 'port must be free');

      await assert.rejects(page.evaluate('1+1'), (e) => e instanceof Error && e.message.length > 0);

      // Nothing left on the port: a fresh auto manager simply launches, without hanging.
      const fresh = new BrowserManager({ mode: 'auto', headless: true, bridgePort, cdpUrl: 'http://127.0.0.1:1', userDataDir: '' });
      try {
        await dispatchToolCall(fresh, 'tabs_batch', { operations: [{ action: 'list' }] });
        assert.equal(fresh.connectionType, 'launch');
      } finally {
        await fresh.close().catch(() => {});
      }
    } finally {
      await bm?.close().catch(() => {});
      try { daemon?.kill(); } catch {}
      try { chrome.kill('SIGKILL'); } catch {}
    }
  });

  it('a bridge with a dead upstream is cleared and the launch fallback says why, once', async () => {
    const cdpPort = await getFreePort();
    const bridgePort = await getFreePort();
    const { child: chrome, ws } = await startChromium(cdpPort);
    let bridge;
    let fresh;
    try {
      bridge = await createCdpBridgeServer({ upstreamUrl: ws, port: bridgePort });
      chrome.kill('SIGKILL');
      for (let i = 0; i < 50 && (await probeBridge(bridgePort))?.upstreamConnected; i++) await sleep(100);
      assert.equal((await probeBridge(bridgePort)).upstreamConnected, false);

      fresh = new BrowserManager({ mode: 'auto', headless: true, bridgePort, cdpUrl: 'http://127.0.0.1:1', userDataDir: '' });
      const t0 = Date.now();
      const first = await dispatchToolCall(fresh, 'tabs_batch', { operations: [{ action: 'list' }] });
      assert.equal(fresh.connectionType, 'launch');
      assert.match(first.text, /connectionNote.*Chrome remote debugging is no longer available \(bridge upstream closed\); using a headless browser\. Logged-in sites will not be available\./, first.text.slice(0, 300));
      assert.ok(Date.now() - t0 < 25000);
      const second = await dispatchToolCall(fresh, 'tabs_batch', { operations: [{ action: 'list' }] });
      assert.doesNotMatch(second.text, /connectionNote/);
    } finally {
      await fresh?.close().catch(() => {});
      await bridge?.close().catch(() => {});
      try { chrome.kill('SIGKILL'); } catch {}
    }
  });

  it('a hung listener on the bridge port is detected quickly and a foreign process is never killed', async () => {
    const port = await getFreePort();
    const hang = net.createServer((s) => s.on('error', () => {}));
    await new Promise((r) => hang.listen(port, '127.0.0.1', r));
    try {
      const t0 = Date.now();
      const h = await checkBridgeHealth(port);
      assert.equal(h.state, 'hung');
      assert.equal(h.stopped, false);
      assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0} ms`);
    } finally {
      hang.close();
    }
  });

  it('a library bridge reports the lost upstream through onUpstreamLost exactly once', async () => {
    const cdpPort = await getFreePort();
    const bridgePort = await getFreePort();
    const { child: chrome, ws } = await startChromium(cdpPort);
    let lost = 0;
    let bridge;
    try {
      bridge = await createCdpBridgeServer({ upstreamUrl: ws, port: bridgePort, reconnectMs: 1500, onUpstreamLost: () => { lost++; } });
      chrome.kill('SIGKILL');
      for (let i = 0; i < 80 && lost === 0; i++) await sleep(100);
      await sleep(500);
      assert.equal(lost, 1);
    } finally {
      await bridge?.close().catch(() => {});
      try { chrome.kill('SIGKILL'); } catch {}
    }
  });
});
