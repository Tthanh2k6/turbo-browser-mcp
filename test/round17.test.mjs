// Round 17: frozen background tabs are resumed (and listed as frozen, not unresponsive), SPA clicks report the new
// url, extract waits for an SPA to render past a footer-only shell.
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
    if (req.url === '/spa') {
      res.end(`<title>SPA</title><body><a id="job" href="/jobs/1">Job</a><div id="app"></div><footer>Footer text only here</footer>
        <script>document.getElementById('job').addEventListener('click',(e)=>{e.preventDefault();history.pushState({}, '', '/jobs/1');
        setTimeout(()=>{document.getElementById('app').innerHTML='<main><h1>Senior engineer</h1><p>'+'Real job description text. '.repeat(30)+'</p></main>'},900)})</script>`);
    } else res.end(`<title>P${req.url}</title><p>page ${req.url}`);
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  webPort = web.address().port;
});
after(() => new Promise((r) => web.close(r)));

describe('round 17', () => {
  it('a hidden tab whose main world only answers after Page.setWebLifecycleState active is frozen, not unresponsive', async () => {
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
      const idA = first.tabs.find((t) => t.url.endsWith('/a')).tabId;
      // Headless Chromium never freezes a tab, so stand in for Chrome: A's main world hangs until it is resumed.
      const pageA = bm.tabs.get(idA);
      let frozen = true;
      let resumes = 0;
      pageA.mainFrame = () => ({ evaluate: () => (frozen ? new Promise(() => {}) : Promise.resolve(1)) });
      pageA.context = () => ({ newCDPSession: async () => ({
        send: async (m, p) => { assert.equal(m, 'Page.setWebLifecycleState'); frozen = p.state === 'frozen'; if (p.state === 'active') resumes++; },
        detach: async () => {},
      }) });
      const t0 = Date.now();
      const tabs = await bm.listTabs();
      const entry = tabs.find((t) => t.tabId === idA);
      assert.equal(entry.frozen, true, JSON.stringify(entry));
      assert.equal(entry.unresponsive, undefined);
      assert.equal(frozen, true, 'a listing puts the freeze back');
      assert.ok(Date.now() - t0 < 5000);
      // A call on it resumes it instead of failing.
      const got = await bm.getPage(idA);
      assert.equal(got.page, pageA);
      assert.equal(frozen, false);
      assert.ok(resumes >= 2);
    } finally {
      await bm?.close().catch(() => {});
      await up.close().catch(() => {});
    }
  });

  it('an SPA click reports the new url and extract waits past the footer-only shell', async () => {
    const m = new BrowserManager({ mode: 'launch', headless: true });
    try {
      await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'open', url: `http://127.0.0.1:${webPort}/spa` }] });
      const click = (await dispatchToolCall(m, 'act_fast', { action: 'click', selector: '#job' })).text;
      assert.match(click, /\/jobs\/1/, click);
      const ex = (await dispatchToolCall(m, 'extract_clean_text', {})).text;
      assert.match(ex, /Senior engineer/, ex.slice(0, 300));
    } finally {
      await m.close().catch(() => {});
    }
  });
});
