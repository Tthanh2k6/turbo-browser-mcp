// Round 18c: the last tab of an attached browser is protected, wait alternatives match whole words.
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
    res.end(req.url === '/err' ? '<p>Deploy finished with Error code 7</p>' : '<p>logs &amp; errors overview</p>');
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  webPort = web.address().port;
});
after(() => new Promise((r) => web.close(r)));

describe('round 18c', () => {
  it('17: closing the last tab of an attached browser is refused without force', async () => {
    const { chromium } = await loadPlaywright();
    const port = await freePort();
    const up = await chromium.launch({ headless: true, ...resolveChromiumExecutable(chromium, true), args: [`--remote-debugging-port=${port}`] });
    let bm;
    try {
      const ctx = up.contexts()[0] || (await up.newContext());
      const only = await ctx.newPage();
      await only.goto(`http://127.0.0.1:${webPort}/`);
      for (const p of ctx.pages()) if (p !== only) await p.close().catch(() => {});
      bm = new BrowserManager({ mode: 'cdp', cdpUrl: `http://127.0.0.1:${port}` });
      const list = await bm.tabsBatch([{ action: 'list' }]);
      assert.equal(list.tabs.length, 1);
      await assert.rejects(bm.tabsBatch([{ action: 'close', tabId: list.tabs[0].tabId }]), /last tab of the attached browser/);
      assert.equal(up.isConnected(), true);
      // A second tab makes closing the first fine.
      await bm.tabsBatch([{ action: 'open', url: `http://127.0.0.1:${webPort}/` }]);
      await bm.tabsBatch([{ action: 'close', tabId: list.tabs[0].tabId }]);
      assert.equal(up.isConnected(), true);
    } finally {
      await bm?.close().catch(() => {});
      await up.close().catch(() => {});
    }
  });

  it('18: a plain-word wait alternative does not match inside another word, and the snippet is returned', async () => {
    const m = new BrowserManager({ mode: 'launch', headless: true });
    try {
      await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'open', url: `http://127.0.0.1:${webPort}/` }] });
      await assert.rejects(dispatchToolCall(m, 'act_fast', { action: 'wait', text: 'Ready|Error|Failed', timeoutMs: 1200 }), /Timed out/);
      await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'open', url: `http://127.0.0.1:${webPort}/err` }] });
      const out = (await dispatchToolCall(m, 'act_fast', { action: 'wait', text: 'Ready|Error|Failed', timeoutMs: 3000 })).text;
      assert.match(out, /"matched":"Error"/, out);
      assert.match(out, /Error code 7/, out);
    } finally {
      await m.close().catch(() => {});
    }
  });
});
