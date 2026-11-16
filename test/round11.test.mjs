// Round 11: two round-10 fixes that passed local tests but failed against real sites.
// 1. wait textNew right after navigate: real cross-origin navigations between pages with identical text, and text that
//    only lives in <title> (example.com / example.org carry "Example Domain" in the title, not in the body).
// 2. Tab context labels through a bridge: the current build and the round-8 build (b99ad7b), whose browser-level
//    sessions do not work. Headless Chromium launched here; never ports 9222/9224.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BrowserManager } from '../src/browser-manager.mjs';
import { createCdpBridgeServer } from '../src/cdp-bridge.mjs';
import { batchActions } from '../src/dom-engine.mjs';
import { loadPlaywright, resolveChromiumExecutable } from '../src/playwright-loader.mjs';

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.once('error', reject);
  });
const cap = (p, ms = 15000) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`HANG after ${ms} ms`)), ms))]);
const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, () => resolve(s)); });

describe('round 11: wait textNew after navigate on a different origin with identical text', () => {
  let chromium, browser;
  const servers = [];
  const SAME_BODY = '<!doctype html><title>Plain</title><div><h1>Shared Heading</h1><p>Same words on both origins.</p></div>';
  const TITLE_ONLY = '<!doctype html><title>Title Only Domain</title><div><p>Body text without the phrase.</p></div>';
  let bodyA, bodyB, titleA, titleB;
  const mk = async (html, headers = {}) => {
    const s = await listen((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...headers }); res.end(html); });
    servers.push(s);
    return s.address().port;
  };
  before(async () => {
    ({ chromium } = await loadPlaywright());
    browser = await chromium.launch({ headless: true, ...resolveChromiumExecutable(chromium, true) });
    bodyA = await mk(SAME_BODY);
    bodyB = await mk(SAME_BODY, { 'Cross-Origin-Opener-Policy': 'same-origin' });
    titleA = await mk(TITLE_ONLY);
    titleB = await mk(TITLE_ONLY);
  });
  after(async () => {
    await browser?.close().catch(() => {});
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  });

  it('identical body text on another origin counts as new right after navigate', async () => {
    const p = await browser.newPage();
    await p.goto(`http://127.0.0.1:${bodyA}/`);
    const out = await batchActions(p, [
      { action: 'navigate', url: `http://localhost:${bodyB}/` },
      { action: 'wait', textNew: 'Shared Heading', timeoutMs: 3000 },
    ]);
    assert.equal(out.completed, 2, JSON.stringify(out));
    assert.equal(out.results[1].ok, true);
  });

  it('text that exists only in <title> counts as new after navigate', async () => {
    const p = await browser.newPage();
    await p.goto(`http://127.0.0.1:${titleA}/`);
    const out = await batchActions(p, [
      { action: 'navigate', url: `http://localhost:${titleB}/` },
      { action: 'wait', textNew: 'Title Only Domain', timeoutMs: 3000 },
    ]);
    assert.equal(out.completed, 2, JSON.stringify(out));
    assert.equal(out.results[1].ok, true);
  });

  it('without a navigation, a title that was already there is not new, but a changed title is', async () => {
    const p = await browser.newPage();
    await p.goto(`http://127.0.0.1:${titleA}/`);
    const stale = await batchActions(p, [{ action: 'wait', textNew: 'Title Only Domain', timeoutMs: 500 }], { continueOnError: true });
    assert.equal(stale.results[0].ok, false, JSON.stringify(stale));
    setTimeout(() => { p.evaluate(() => { document.title = 'Fresh Title Arrived'; }).catch(() => {}); }, 300);
    const changed = await batchActions(p, [{ action: 'wait', textNew: 'Fresh Title', timeoutMs: 3000 }]);
    assert.equal(changed.results[0].ok, true, JSON.stringify(changed));
  });

  it('reload and back in the same batch also start from an empty baseline', async () => {
    const p = await browser.newPage();
    await p.goto(`http://127.0.0.1:${bodyA}/`);
    await p.goto(`http://localhost:${bodyB}/`);
    const out = await batchActions(p, [
      { action: 'back' },
      { action: 'wait', textNew: 'Shared Heading', timeoutMs: 3000 },
      { action: 'reload' },
      { action: 'wait', textNew: 'Same words', timeoutMs: 3000 },
    ]);
    assert.equal(out.completed, 4, JSON.stringify(out));
  });
});

// The round-8 bridge, taken from git history; left out when the history is not available (shallow clone, tarball).
const here = path.dirname(fileURLToPath(import.meta.url));
let oldBridgeUrl = null;
try {
  const src = execFileSync('git', ['show', 'b99ad7b:src/cdp-bridge.mjs'], { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const file = path.join(os.tmpdir(), 'turbo-cdp-bridge-b99ad7b.mjs');
  fs.writeFileSync(file, src);
  oldBridgeUrl = pathToFileURL(file).href;
} catch { /* no history */ }

const variants = [['current bridge', async () => createCdpBridgeServer]];
if (oldBridgeUrl) variants.push(['round-8 bridge (b99ad7b)', async () => (await import(oldBridgeUrl)).createCdpBridgeServer]);

for (const [label, load] of variants) {
  describe(`round 11: tab listing labels another client's isolated context, ${label}`, () => {
    let chromium, upstream, bridge, m1, m2;
    before(async () => {
      ({ chromium } = await loadPlaywright());
      const cdpPort = await freePort();
      upstream = await chromium.launch({ headless: true, ...resolveChromiumExecutable(chromium, true), args: [`--remote-debugging-port=${cdpPort}`] });
      const v = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
      const create = await load();
      bridge = await create({ upstreamUrl: v.webSocketDebuggerUrl, port: await freePort() });
      m1 = new BrowserManager({ mode: 'cdp', cdpUrl: bridge.bridgeHttpUrl });
      m2 = new BrowserManager({ mode: 'cdp', cdpUrl: bridge.bridgeHttpUrl });
    });
    after(async () => {
      const quiet = (p) => cap(Promise.resolve(p), 4000).catch(() => {});
      await quiet(m1?.close());
      await quiet(m2?.close());
      await quiet(bridge?.close());
      await quiet(upstream?.close());
    });

    it('a second server lists the first one isolated tab as non-default and its default tab as default', async () => {
      await cap(m1.tabsBatch([
        { action: 'open', url: 'data:text/html,<title>IsoOnly</title>', isolatedContext: 'night' },
        { action: 'open', url: 'data:text/html,<title>DefOnly</title>' },
      ]));
      const list = await cap(m2.tabsBatch([{ action: 'list' }]));
      const iso = list.tabs.find((t) => t.title === 'IsoOnly');
      const def = list.tabs.find((t) => t.title === 'DefOnly');
      assert.ok(iso && def, JSON.stringify(list.tabs));
      assert.notEqual(iso.isolatedContext, 'default', JSON.stringify(list.tabs));
      assert.equal(def.isolatedContext, 'default', JSON.stringify(list.tabs));
    });

    it('identical url and title in both contexts is never presented as a confident default', async () => {
      const same = 'data:text/html,<title>Twin</title>';
      await cap(m1.tabsBatch([
        { action: 'open', url: same, isolatedContext: 'night' },
        { action: 'open', url: same },
      ]));
      const list = await cap(m2.tabsBatch([{ action: 'list' }]));
      const twins = list.tabs.filter((t) => t.title === 'Twin');
      assert.equal(twins.length, 2, JSON.stringify(list.tabs));
      // The current bridge answers per page and labels each correctly; the old one can only say "unknown" for both.
      const labels = twins.map((t) => t.isolatedContext).sort();
      if (label.startsWith('current')) assert.deepEqual(labels, ['default', 'other'], JSON.stringify(twins));
      else assert.deepEqual(labels, ['unknown', 'unknown'], JSON.stringify(twins));
    });
  });
}
