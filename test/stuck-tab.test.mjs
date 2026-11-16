import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
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

describe('attached browser with a tab whose main world is blocked', () => {
  it('tabs_batch list returns quickly and marks the stuck tab unresponsive', async () => {
    const { chromium } = await loadPlaywright();
    const cdpPort = await getFreePort();
    const upstream = await chromium.launch({
      headless: true,
      ...resolveChromiumExecutable(chromium, true),
      args: [`--remote-debugging-port=${cdpPort}`],
    });
    let bm = null;
    try {
      const ctx = upstream.contexts()[0] || (await upstream.newContext());
      const stuck = await ctx.newPage();
      // Pause the page in the debugger from a separate CDP session: its main world stops answering
      // evaluate, while the browser still accepts new CDP clients (as with a tab left paused in DevTools).
      await stuck.goto('data:text/html,<title>Stuck</title><p>paused</p>');
      const dbg = await ctx.newCDPSession(stuck);
      await dbg.send('Debugger.enable');
      await dbg.send('Runtime.evaluate', { expression: 'setTimeout(() => { debugger; }, 10)' });
      await stuck.waitForTimeout(300);
      const fine = await ctx.newPage();
      await fine.goto('data:text/html,<title>Fine</title><p>ok</p>');

      bm = new BrowserManager({ mode: 'cdp', cdpUrl: `http://127.0.0.1:${cdpPort}` });
      const t0 = Date.now();
      const res = await bm.tabsBatch([{ action: 'list' }]);
      const ms = Date.now() - t0;
      assert.ok(ms < 8000, `list took ${ms} ms`);
      const tabs = res.tabs;
      assert.equal(res.results[0].tabs, undefined, 'tab list is returned once');
      const stuckTab = tabs.find((t) => t.title === 'Stuck' || t.url.includes('paused'));
      const fineTab = tabs.find((t) => t.title === 'Fine');
      assert.ok(stuckTab, 'stuck tab listed');
      assert.equal(stuckTab.unresponsive, true);
      assert.ok(fineTab, 'fine tab listed');
      assert.equal(fineTab.unresponsive, undefined);

      // A tool call that targets the stuck tab fails fast instead of hanging.
      const t1 = Date.now();
      await assert.rejects(bm.getPage(stuckTab.tabId), /page main world is blocked/);
      assert.ok(Date.now() - t1 < 2500, `getPage on stuck tab took ${Date.now() - t1} ms`);
      // The fine tab still works.
      const ok = await bm.getPage(fineTab.tabId);
      assert.equal(ok.tabId, fineTab.tabId);

      // Resume the debugger: the mark clears on the next call.
      await dbg.send('Debugger.resume').catch(() => {});
      await dbg.send('Debugger.disable').catch(() => {});
      await stuck.waitForTimeout(300);
      const back = await bm.getPage(stuckTab.tabId);
      assert.equal(back.tabId, stuckTab.tabId);
      assert.equal(bm.isPageUnresponsive(back.page), false);
    } finally {
      if (bm) await bm.close().catch(() => {});
      await upstream.close().catch(() => {});
    }
  });
});
