// Local fixtures only: launch Chromium, never connect to the owner's debugging ports.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, capturePage } from '../src/dom-engine.mjs';
import { dispatchToolCall } from '../src/index.mjs';
import { takeLate } from '../src/aftermath.mjs';

describe('round 24: field bugs', () => {
  let m, page;
  before(async () => {
    m = new BrowserManager({ mode: 'launch', headless: true });
    ({ page } = await m.getPage());
  });
  beforeEach(async () => { await page.goto('about:blank'); takeLate(page); });
  after(async () => { await m?.close(); });

  it('1: background actions send focus emulation and resume only their target', async () => {
    const bg = await m.context.newPage();
    const id = m.pageToId.get(bg);
    m.activeTabId = m.pageToId.get(page);
    const active = m.activeTabId;
    const session = await m.context.newCDPSession(bg);
    const calls = [];
    const original = m.context.newCDPSession.bind(m.context);
    m.context.newCDPSession = async (target) => {
      const s = await original(target), send = s.send.bind(s);
      s.send = (method, params) => { calls.push({ target, method, params }); return send(method, params); };
      return s;
    };
    try {
      await bg.setContent(`<button onclick="if(document.visibilityState === 'visible') requestAnimationFrame(() => document.body.append('Compose ready'))">Compose</button>`);
      await page.bringToFront();
      await session.send('Page.setWebLifecycleState', { state: 'frozen' });
      await dispatchToolCall(m, 'act_fast', { tabId: id, action: 'click', text: 'Compose', timeoutMs: 800 });
      await bg.waitForFunction(() => document.body.textContent.includes('Compose ready'), undefined, { timeout: 1000 });
      for (const [method, params] of [['Emulation.setFocusEmulationEnabled', { enabled: true }], ['Page.setWebLifecycleState', { state: 'active' }]]) {
        assert.ok(calls.some((c) => c.target === bg && c.method === method && JSON.stringify(c.params) === JSON.stringify(params)), method);
      }
      assert.ok(calls.every((c) => c.target === bg));
      assert.equal(m.activeTabId, active);
    } finally {
      m.context.newCDPSession = original;
      await session.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
      await session.detach();
      await bg.close();
    }
  });

  it('2: target blank and window.open return usable tab IDs, ordinary clicks do not', async () => {
    await m.context.route('https://popup.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>Child</title><p>Ready</p>' }));
    try {
      for (const html of ['<a href="https://popup.test/child" target="_blank">Open</a>', `<button onclick="window.open('https://popup.test/child')">Open</button>`]) {
        await page.setContent(html);
        const r = JSON.parse((await dispatchToolCall(m, 'act_fast', { tabId: m.pageToId.get(page), action: 'click', text: 'Open' })).text);
        assert.equal(typeof r.newTab, 'number', JSON.stringify(r));
        const child = (await m.getPage(r.newTab)).page;
        assert.equal(await child.title(), 'Child');
        await child.close();
      }
      await page.setContent('<button>Ordinary</button>');
      const r = JSON.parse((await dispatchToolCall(m, 'act_fast', { tabId: m.pageToId.get(page), action: 'click', text: 'Ordinary' })).text);
      assert.equal(r.newTab, undefined);
      // Another opener in the same context must not be attributed to this action.
      const other = await m.context.newPage();
      const click = page.locator('button').click.bind(page.locator('button'));
      const resolve = page.locator.bind(page);
      page.locator = (...args) => {
        const loc = resolve(...args);
        loc.click = async (...opts) => {
          await other.evaluate(() => window.open('https://popup.test/unrelated'));
          return click(...opts);
        };
        return loc;
      };
      try {
        const unrelated = JSON.parse((await dispatchToolCall(m, 'act_fast', { tabId: m.pageToId.get(page), action: 'click', selector: 'button' })).text);
        assert.equal(unrelated.newTab, undefined);
      } finally { page.locator = resolve; await other.close(); }
      await page.setContent(`<button onclick="window.open('https://popup.test/batch')">Open</button>`);
      const batch = JSON.parse((await dispatchToolCall(m, 'batch_actions', { tabId: m.pageToId.get(page), steps: [{ action: 'click', text: 'Open' }] })).text);
      assert.equal(typeof batch.results[0].newTab, 'number');
      await m.tabs.get(batch.results[0].newTab).close();
    } finally { await m.context.unroute('https://popup.test/**'); }
  });

  it('3: screenshots fall back when a web font never finishes', async () => {
    await page.route('https://fonts.test/**', () => {});
    try {
      await page.setContent(`<style>@font-face{font-family:stuck;src:url(https://fonts.test/font.woff2)}p{font-family:stuck}</style><p>Pending font</p>`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.fonts.status === 'loading');
      for (const opts of [{}, { selector: 'p', type: 'jpeg' }, { fullPage: true, scale: 'device' }]) {
        const start = Date.now();
        const r = await capturePage(page, { ...opts, timeoutMs: 1800 });
        assert.equal(r.fontsPending, true);
        assert.ok(r.bytes > 100);
        assert.ok(Date.now() - start < 3000);
      }
    } finally { await page.unroute('https://fonts.test/**', undefined, { behavior: 'ignoreErrors' }); }
    await page.goto('about:blank');
    const r = await capturePage(page, { returnImage: false });
    assert.equal(r.fontsPending, undefined);
  });

  it('4a: a GET job link followed by a cross-host tracking POST is not a submit', async () => {
    await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: route.request().url().endsWith('/job')
      ? `<p>Job</p><script>fetch('https://r.dover.com/rpc', {method:'POST',body:'{}'})</script>`
      : '<a href="/job">View job</a>' }));
    try {
      for (const observeAftermath of [false, true]) {
        await page.goto('https://jobs.test/');
        const r = await actFast(page, { action: 'click', text: 'View job', returnSnapshot: true, observeAftermath });
        assert.equal(r.possibleSubmit, undefined, JSON.stringify(r));
        // Tracking arriving after the tool returns must not be parked as a late submit.
        await page.evaluate(() => fetch('https://r.dover.com/rpc', { method: 'POST', body: '{}' }));
        assert.equal(takeLate(page), '');
      }
    } finally { await page.unroute('**/*'); }
  });

  it('4b: editor telemetry is quiet, but a real form POST is still reported', async () => {
    await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<main></main>' }));
    try {
      for (const observeAftermath of [false, true]) {
        await page.goto('https://www.reddit.com/thread');
        await page.setContent(`<textarea onclick="fetch('/svc/shreddit/events', {method:'POST',body:'{}'})" placeholder="Join the conversation"></textarea>
          <button id="reply" onclick="document.querySelector('form').hidden=false;fetch('/svc/shreddit/telemetry', {method:'POST',body:'{}'})">Reply</button>
          <form hidden><textarea name="comment">Hello</textarea><button type="button" id="post" onclick="fetch('/svc/shreddit/comment', {method:'POST',body:new URLSearchParams(new FormData(this.form))})">Go</button></form>`);
        for (const selector of ['textarea', '#reply']) {
          const r = await actFast(page, { action: 'click', selector: selector === 'textarea' ? 'textarea[placeholder]' : selector, returnSnapshot: true, observeAftermath });
          assert.equal(r.possibleSubmit, undefined, JSON.stringify(r));
          await page.evaluate(() => fetch('/svc/shreddit/events', { method: 'POST', body: '{}' }));
          assert.equal(takeLate(page), '');
        }
        const posted = await actFast(page, { action: 'click', selector: '#post', returnSnapshot: true, observeAftermath });
        assert.equal(posted.possibleSubmit, true, JSON.stringify(posted));
      }
    } finally { await page.unroute('**/*'); }
  });

  it('5: configured hosts open and navigate in fresh cookie contexts', async () => {
    const isolated = new BrowserManager({ mode: 'launch', headless: true, isolateHosts: '*.private.test' });
    try {
      await isolated.ensureReady();
      const install = isolated._installContextInitScript.bind(isolated);
      const route = (r) => r.fulfill({ contentType: 'text/html', body: '<title>Local</title><p>Local fixture</p>' });
      await isolated.context.route('**/*', route);
      isolated._installContextInitScript = async (ctx) => { await install(ctx); await ctx.route('**/*', route); };
      await isolated.context.addCookies([{ name: 'owner', value: 'signed-in', domain: '.private.test', path: '/' }]);
      const open = async (op) => (await isolated.tabsBatch([op])).results[0];
      const a = await open({ action: 'open', url: 'https://www.private.test/' });
      const ap = isolated.tabs.get(a.tabId);
      assert.notEqual(ap.context(), isolated.context);
      assert.deepEqual(await ap.context().cookies(), []);
      const b = await open({ action: 'open', url: 'https://www.private.test/' });
      assert.notEqual(ap.context(), isolated.tabs.get(b.tabId).context());
      const plain = await open({ action: 'open', url: 'https://public.test/' });
      const old = isolated.tabs.get(plain.tabId);
      const nav = await open({ action: 'navigate', tabId: plain.tabId, url: 'https://www.private.test/' });
      assert.notEqual(isolated.tabs.get(nav.tabId).context(), isolated.context);
      assert.equal(old.url(), 'https://public.test/');
      const explicit = await open({ action: 'open', url: 'https://www.private.test/', isolatedContext: 'default' });
      assert.equal(isolated.tabs.get(explicit.tabId).context(), isolated.context);
      const named = await open({ action: 'navigate', tabId: explicit.tabId, url: 'https://www.private.test/', isolatedContext: 'chosen' });
      assert.equal(isolated.tabContextName.get(named.tabId), 'chosen');
      const many = await open({ action: 'open_many', urls: ['https://private.test/', 'https://private.test.evil.test/'] });
      assert.notEqual(isolated.tabs.get(many.opened[0].tabId).context(), isolated.context);
      assert.equal(isolated.tabs.get(many.opened[1].tabId).context(), isolated.context);
    } finally { await isolated.close(); }
  });

  it('5b: isolation is off by default and reads the optional environment setting', () => {
    const old = process.env.TURBO_BROWSER_ISOLATE_HOSTS;
    try {
      delete process.env.TURBO_BROWSER_ISOLATE_HOSTS;
      assert.equal(new BrowserManager()._contextForUrl('https://www.linkedin.com'), undefined);
      process.env.TURBO_BROWSER_ISOLATE_HOSTS = ' *.linkedin.com , exact.test ';
      const manager = new BrowserManager();
      assert.ok(manager._contextForUrl('https://www.linkedin.com'));
      assert.ok(manager._contextForUrl('https://linkedin.com'));
      assert.ok(manager._contextForUrl('https://exact.test'));
      assert.equal(manager._contextForUrl('https://sub.exact.test'), undefined);
      assert.equal(manager._contextForUrl('https://notlinkedin.com'), undefined);
      assert.equal(manager._contextForUrl('https://linkedin.com.evil.test'), undefined);
      assert.equal(manager._contextForUrl('https://www.linkedin.com', 'default'), 'default');
    } finally {
      if (old === undefined) delete process.env.TURBO_BROWSER_ISOLATE_HOSTS;
      else process.env.TURBO_BROWSER_ISOLATE_HOSTS = old;
    }
  });
});
