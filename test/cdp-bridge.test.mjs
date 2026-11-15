import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { createCdpBridgeServer, getRunningBridgeInfo } from '../src/cdp-bridge.mjs';
import { inspectCompact } from '../src/dom-engine.mjs';
import { parseCliArgs } from '../src/index.mjs';
import { loadPlaywright, resolveChromiumExecutable } from '../src/playwright-loader.mjs';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.once('error', reject);
  });
}

describe('CDP Keep-Alive Multiplexer Bridge (unattended AFK mode)', () => {
  it('parses --bridge and --launch-chrome CLI flags', () => {
    const p1 = parseCliArgs(['--bridge']);
    assert.equal(p1.bridge, true);
    assert.equal(p1.unknown, null);

    const p2 = parseCliArgs(['--launch-chrome']);
    assert.equal(p2.launchChrome, true);
    assert.equal(p2.unknown, null);
  });

  it('multiplexes multiple sequential BrowserManager CDP sessions over a single upstream WebSocket', async () => {
    const { chromium } = await loadPlaywright();
    const cdpPort = await getFreePort();
    const bridgePort = await getFreePort();
    const exeOpt = resolveChromiumExecutable(chromium, true);

    const upstreamBrowser = await chromium.launch({
      headless: true,
      ...exeOpt,
      args: [`--remote-debugging-port=${cdpPort}`],
    });

    let bridge = null;
    try {
      const verRes = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      const verData = await verRes.json();
      const upstreamWsUrl = verData.webSocketDebuggerUrl;
      assert.ok(upstreamWsUrl.startsWith('ws://'), 'Expected upstream ws:// debugger URL');

      bridge = await createCdpBridgeServer({
        upstreamUrl: upstreamWsUrl,
        port: bridgePort,
      });

      const info = await getRunningBridgeInfo(bridge.port);
      assert.ok(info, 'Expected getRunningBridgeInfo to detect running bridge');
      assert.equal(info.upstreamUrl, upstreamWsUrl);

      // Session 1: Connect through bridge, open a page, and close session
      const bm1 = new BrowserManager({
        mode: 'cdp',
        cdpUrl: bridge.bridgeHttpUrl,
      });
      await bm1.ensureReady();
      assert.equal(bm1.connectionType, 'cdp');
      await bm1.tabsBatch([
        {
          action: 'open',
          url: 'data:text/html,<html><head><title>AFK Bridge Tab</title></head><body><button id="b1">Ready</button></body></html>',
        },
      ]);
      await bm1.close();

      // Session 2: Reconnect through the SAME persistent bridge without re-opening upstream WS
      const bm2 = new BrowserManager({
        mode: 'cdp',
        cdpUrl: bridge.bridgeHttpUrl,
      });
      await bm2.ensureReady();
      assert.equal(bm2.connectionType, 'cdp');
      const listed2 = await bm2.tabsBatch([{ action: 'list' }]);
      const matchingTab = listed2.tabs.find((t) => t.title === 'AFK Bridge Tab');
      assert.ok(matchingTab, 'Session 2 should see the tab created in Session 1 over the persistent bridge');

      const { page: p2 } = await bm2.getPage(matchingTab.tabId);
      const snap2 = await inspectCompact(p2, { mode: 'interactive' });
      assert.match(snap2.text, /Ready/);
      await bm2.close();

      // Session 3: Third sequential session still works seamlessly
      const bm3 = new BrowserManager({
        mode: 'cdp',
        cdpUrl: bridge.bridgeHttpUrl,
      });
      await bm3.ensureReady();
      const listed3 = await bm3.tabsBatch([{ action: 'list' }]);
      assert.ok(listed3.tabs.some((t) => t.title === 'AFK Bridge Tab'));
      await bm3.close();
    } finally {
      if (bridge) await bridge.close().catch(() => {});
      await upstreamBrowser.close().catch(() => {});
    }
  });
});
