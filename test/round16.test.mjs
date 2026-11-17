// Round 16: a stale Playwright Page (url "" after a browser-initiated navigation) is healed by reconnecting with the
// same tabIds, and a click blocked by a floating widget names the widget's host element.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { dispatchToolCall } from '../src/index.mjs';
import { loadPlaywright, resolveChromiumExecutable } from '../src/playwright-loader.mjs';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.once('error', reject);
});
let web, webPort;
before(async () => {
  web = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/cover') {
      res.end(`<title>Cover</title><a id="t" href="#x" style="position:absolute;left:20px;top:20px">target link</a>
        <div id="ext-widget-host" style="position:fixed;left:0;top:0;width:300px;height:100px;z-index:99999"></div>
        <script>const r=document.getElementById('ext-widget-host').attachShadow({mode:'open'});
        r.innerHTML='<svg width="300" height="100"><path d="M0 0H300V100H0Z" fill="red"/></svg>'</script>`);
    } else res.end(`<title>P${req.url}</title><p>page ${req.url}</p>`);
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  webPort = web.address().port;
});
after(() => new Promise((r) => web.close(r)));

describe('round 16', () => {
  it('a stale tab (url "") is healed by reconnecting, tabIds kept, real url listed', async () => {
    const { chromium } = await loadPlaywright();
    const cdpPort = await freePort();
    const up = await chromium.launch({ headless: true, ...resolveChromiumExecutable(chromium, true), args: [`--remote-debugging-port=${cdpPort}`] });
    let bm;
    try {
      const ctx = up.contexts()[0] || (await up.newContext());
      const a = await ctx.newPage();
      await a.goto(`http://127.0.0.1:${webPort}/a`);
      const b = await ctx.newPage();
      await b.goto(`http://127.0.0.1:${webPort}/b`);
      bm = new BrowserManager({ mode: 'cdp', cdpUrl: `http://127.0.0.1:${cdpPort}` });
      const first = await bm.tabsBatch([{ action: 'list' }]);
      assert.equal(first.tabs.length, 2);
      const idB = first.tabs.find((t) => t.url.endsWith('/b')).tabId;
      const idA = first.tabs.find((t) => t.url.endsWith('/a')).tabId;
      // Simulate Playwright's Page going stale: it reports no url and a blocked main world.
      const stalePage = bm.tabs.get(idB);
      stalePage.url = () => '';
      bm.markPageUnresponsive(stalePage);
      const { page } = await bm.getPage(idB);
      assert.notEqual(page, stalePage, 'tab was re-attached');
      assert.equal(await page.evaluate('location.href'), `http://127.0.0.1:${webPort}/b`);
      const tabs = await bm.listTabs();
      assert.equal(tabs.length, 2);
      assert.equal(tabs.find((t) => t.tabId === idB)?.url, `http://127.0.0.1:${webPort}/b`);
      assert.equal(tabs.find((t) => t.tabId === idA)?.url, `http://127.0.0.1:${webPort}/a`);
      assert.ok(!tabs.some((t) => t.unresponsive));
    } finally {
      await bm?.close().catch(() => {});
      await up.close().catch(() => {});
    }
  });

  it('a blocked click names the widget host, not the svg path inside it', async () => {
    const m = new BrowserManager({ mode: 'launch', headless: true });
    try {
      await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'open', url: `http://127.0.0.1:${webPort}/cover` }] });
      await assert.rejects(
        dispatchToolCall(m, 'act_fast', { action: 'click', selector: '#t', timeoutMs: 3000 }),
        (e) => /ext-widget-host/.test(e.message) && !/<path/.test(e.message)
      );
    } finally {
      await m.close().catch(() => {});
    }
  });
});
