// Two clients (two MCP servers / Claude sessions) on one CDP bridge: each gets its own sessions.
// Headless Chromium launched here; never the owner's Chrome and never ports 9222/9224.
import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { createCdpBridgeServer } from '../src/cdp-bridge.mjs';
import { actFast } from '../src/dom-engine.mjs';
import { loadPlaywright, resolveChromiumExecutable } from '../src/playwright-loader.mjs';

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.once('error', reject);
  });
const cap = (p, ms = 6000) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`HANG after ${ms} ms`)), ms))]);

describe('CDP bridge with two clients at once', () => {
  let chromium, upstream, bridge, A, B;
  before(async () => {
    ({ chromium } = await loadPlaywright());
    const cdpPort = await freePort();
    upstream = await chromium.launch({ headless: true, ...resolveChromiumExecutable(chromium, true), args: [`--remote-debugging-port=${cdpPort}`] });
    const v = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
    bridge = await createCdpBridgeServer({ upstreamUrl: v.webSocketDebuggerUrl, port: await freePort() });
    A = await chromium.connectOverCDP(bridge.bridgeHttpUrl);
  });
  after(async () => {
    await B?.close().catch(() => {});
    await A?.close().catch(() => {});
    await bridge?.close().catch(() => {});
    await upstream?.close().catch(() => {});
  });

  it('both clients evaluate on their own pages and on each other\'s pages', async () => {
    const pa = await cap(A.contexts()[0].newPage());
    await pa.goto('data:text/html,<title>PageA</title><button id=b onclick="document.title=\'clickedA\'">go</button>');
    assert.equal(await cap(pa.evaluate('1+1')), 2);

    B = await chromium.connectOverCDP(bridge.bridgeHttpUrl);
    const paSeenByB = B.contexts()[0].pages().find((p) => p.url().includes('PageA'));
    assert.ok(paSeenByB, 'B sees the page A opened');
    assert.equal(await cap(paSeenByB.evaluate('2+2')), 4, 'B evaluates on A\'s page');
    assert.equal(await cap(pa.evaluate('3+3')), 6, 'A still evaluates after B connected');

    const pa2 = await cap(A.contexts()[0].newPage());
    await pa2.goto('data:text/html,<title>PageA2</title>');
    assert.equal(await cap(pa2.evaluate('5+5')), 10, 'A opens a page while B is connected');
    const pb = await cap(B.contexts()[0].newPage());
    await pb.goto('data:text/html,<title>PageB</title><button id=b onclick="document.title=\'clickedB\'">go</button>');
    assert.equal(await cap(pb.evaluate('6+6')), 12, 'B opens its own page');

    await cap(pb.click('#b'));
    assert.equal(await pb.title(), 'clickedB');
    await cap(paSeenByB.click('#b'));
    assert.equal(await pa.title(), 'clickedA', 'B clicked on a page that A also drives; A sees the effect');
    const paSeenByA = pb && A.contexts()[0].pages().find((p) => p.url().includes('PageB'));
    assert.ok(paSeenByA, 'A sees the page B opened');
    assert.equal(await cap(paSeenByA.evaluate('7+7')), 14);
  });

  it('a client that disconnects leaves the other fully working, and a late third client works', async () => {
    await B.close();
    B = null;
    const pages = A.contexts()[0].pages();
    assert.ok(pages.length >= 1);
    assert.equal(await cap(pages[0].evaluate('8+8')), 16);
    const C = await chromium.connectOverCDP(bridge.bridgeHttpUrl);
    try {
      const seen = C.contexts()[0].pages();
      assert.ok(seen.length >= 1);
      assert.equal(await cap(seen[0].evaluate('9+9')), 18);
      const pc = await cap(C.contexts()[0].newPage());
      await pc.goto('data:text/html,<title>PageC</title>');
      assert.equal(await cap(pc.evaluate('10+10')), 20);
    } finally {
      await C.close().catch(() => {});
    }
    assert.equal(await cap(pages[0].evaluate('11+11')), 22);
  });

  it('two BrowserManagers (two MCP servers) drive tools on the same bridge at the same time', async () => {
    const m1 = new BrowserManager({ mode: 'cdp', cdpUrl: bridge.bridgeHttpUrl });
    const m2 = new BrowserManager({ mode: 'cdp', cdpUrl: bridge.bridgeHttpUrl });
    try {
      const o1 = await cap(m1.tabsBatch([{ action: 'open', url: 'data:text/html,<title>M1</title><button onclick="document.title=\'m1 clicked\'">hit</button>' }]), 15000);
      const o2 = await cap(m2.tabsBatch([{ action: 'open', url: 'data:text/html,<title>M2</title><button onclick="document.title=\'m2 clicked\'">hit</button>' }]), 15000);
      const t1 = o1.results[0].tabId;
      const t2 = o2.results[0].tabId;
      const p1 = (await m1.getPage(t1)).page;
      const p2 = (await m2.getPage(t2)).page;
      const [r1, r2] = await cap(Promise.all([actFast(p1, { action: 'click', text: 'hit' }), actFast(p2, { action: 'click', text: 'hit' })]), 15000);
      assert.equal(r1.ok, true);
      assert.equal(r2.ok, true);
      assert.equal(await p1.title(), 'm1 clicked');
      assert.equal(await p2.title(), 'm2 clicked');
      // The first server lists both tabs and can run a tool on a tab the second one opened.
      const list = await cap(m1.tabsBatch([{ action: 'list' }]), 15000);
      const other = list.tabs.find((t) => t.title === 'm2 clicked');
      assert.ok(other, JSON.stringify(list.tabs));
      const shared = (await m1.getPage(other.tabId)).page;
      assert.equal(await cap(shared.evaluate('document.title')), 'm2 clicked');
    } finally {
      await m1.close().catch(() => {});
      await m2.close().catch(() => {});
    }
  });
});
