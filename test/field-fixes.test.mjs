// Offline regression tests for field-report fixes (job sites): overlays, nav health, hrefs, wait alternatives, tabs echo.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, batchActions, extractCleanText, inspectCompact } from '../src/dom-engine.mjs';

const LOREM = 'Senior Python developer needed for a remote Supabase project with row level security. '.repeat(6);

const LOGIN_WALL = `<!doctype html><title>Jobs</title><body><h1>Jobs list</h1>
<ul><li>${LOREM}</li><li>${LOREM}</li></ul>
<div role="dialog" aria-modal="true" style="position:fixed;inset:0;z-index:1000;background:#fff">
<h2>Sign in to view more jobs</h2><p>Join now</p><button>Sign in</button></div></body>`;

const COOKIE = `<!doctype html><title>Shop</title><body><p>${LOREM}</p><p>${LOREM}</p>
<div id="cookie-banner" style="position:fixed;bottom:0;left:0;right:0;z-index:50;background:#eee">We use cookies to improve things. <button>Accept all</button></div></body>`;

const DIALOG_ONLY = `<!doctype html><title>Alert</title><body><p>Short page.</p>
<div role="dialog" aria-modal="true" style="position:fixed;inset:0;z-index:1000;background:#fff"><h2>Terms of service</h2><p>${LOREM}</p></div></body>`;

describe('field fixes', () => {
  let m;
  let page;
  let server;
  let base;
  before(async () => {
    server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      res.setHeader('content-type', 'text/html');
      if (u.pathname === '/ok') {
        res.end('<title>Fine</title><p>hello</p>');
      } else if (u.pathname === '/missing') {
        res.statusCode = 404;
        res.end('<title>Page Not Found</title><p>nope</p>');
      } else if (u.pathname === '/redir') {
        res.statusCode = 302;
        res.setHeader('location', '/ok');
        res.end();
      } else if (u.pathname === '/cf') {
        res.statusCode = 403;
        res.end('<title>Just a moment...</title><p>Checking your browser</p>');
      } else if (u.pathname === '/human') {
        res.end('<title>Example</title><p>Please verify you are human to continue</p>');
      } else if (u.pathname === '/late') {
        res.end('<title>Late</title><div id=o></div><script>setTimeout(()=>{document.getElementById("o").textContent="Failed: build broke"},300)</script>');
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    m = new BrowserManager({ mode: 'launch', headless: true });
    ({ page } = await m.getPage());
  });
  after(async () => {
    await m.close();
    await new Promise((r) => server.close(r));
  });

  it('1: extract skips a sign-in dialog when real content sits behind it', async () => {
    await page.setContent(LOGIN_WALL);
    const r = await extractCleanText(page, {});
    assert.match(r.text, /Overlay: Sign in to view more jobs \(skipped\)/);
    assert.match(r.text, /Senior Python developer/);
    assert.doesNotMatch(r.text, /Join now/);
  });

  it('1: extract skips a cookie banner, also in markdown format', async () => {
    await page.setContent(COOKIE);
    for (const format of ['text', 'markdown']) {
      const r = await extractCleanText(page, { format });
      assert.match(r.text, /Overlay: .*cookies.* \(skipped\)/i, format);
      assert.match(r.text, /Senior Python developer/);
      assert.doesNotMatch(r.text, /Accept all/);
    }
  });

  it('1: keeps the dialog when it is the only content, or when a selector asks for it', async () => {
    await page.setContent(DIALOG_ONLY);
    const r = await extractCleanText(page, {});
    assert.match(r.text, /Terms of service/);
    assert.doesNotMatch(r.text, /Overlay:/);
    await page.setContent(LOGIN_WALL);
    const sel = await extractCleanText(page, { selector: '[role=dialog]' });
    assert.match(sel.text, /Join now/);
    assert.doesNotMatch(sel.text, /Overlay:/);
  });

  it('1: a plain page without overlays is unchanged', async () => {
    await page.setContent(`<!doctype html><title>Plain</title><p>${LOREM}</p>`);
    const r = await extractCleanText(page, {});
    assert.doesNotMatch(r.text, /Overlay:/);
  });

  it('2: ok navigation stays minimal; 404, redirect and bot walls are flagged', async () => {
    const out = await m.tabsBatch([
      { action: 'open', url: `${base}/ok` },
      { action: 'navigate', url: `${base}/missing` },
      { action: 'navigate', url: `${base}/redir` },
      { action: 'navigate', url: `${base}/cf` },
      { action: 'navigate', url: `${base}/human` },
    ]);
    const [ok, miss, redir, cf, human] = out.results;
    assert.deepEqual(Object.keys(ok).sort(), ['action', 'isolatedContext', 'tabId', 'title', 'url']);
    assert.equal(miss.status, 404);
    assert.equal(miss.finalUrl, undefined);
    assert.equal(redir.status, undefined);
    assert.equal(redir.finalUrl, `${base}/ok`);
    assert.equal(cf.status, 403);
    assert.equal(cf.blocked, 'cloudflare');
    assert.equal(human.blocked, 'bot-wall');
  });

  it('2: open_many and batch_actions navigate report the same hints', async () => {
    const many = await m.tabsBatch([{ action: 'open_many', urls: [`${base}/ok`, `${base}/missing`] }]);
    const [a, b] = many.results[0].opened;
    assert.equal(a.status, undefined);
    assert.equal(b.status, 404);
    const { page: p } = await m.getPage();
    const res = await batchActions(p, [{ action: 'navigate', url: `${base}/redir` }], {});
    assert.equal(res.results[0].finalUrl, `${base}/ok`);
  });

  it('3: inspect_compact shows same-origin hrefs as paths, up to 120 chars, without tracking params', async () => {
    await page.goto(`${base}/ok`);
    await page.setContent(`<!doctype html><body>
<a id=a href="${base}/jobs/view/head-of-technical-support-engineer-at-some-company-1234567890">Job A</a>
<a id=b href="https://other.example/x?utm_source=a&utm_medium=b&trk=c&refId=d&id=7">Job B</a>
<a id=c href="/rel?trackingId=zzz&q=1">Job C</a>
<a id=d href="/short">Job D</a></body>`);
    const r = await inspectCompact(page, {});
    assert.match(r.text, /href="\/jobs\/view\/head-of-technical-support-engineer-at-some-company-1234567890"/);
    assert.match(r.text, /href="https:\/\/other\.example\/x\?id=7"/);
    assert.match(r.text, /href="\/rel\?q=1"/);
    assert.match(r.text, /href="\/short"/);
  });

  it('4: wait text with | matches any alternative and reports which', async () => {
    await page.goto(`${base}/late`);
    const r = await actFast(page, { action: 'wait', text: 'Succeeded|Failed', timeoutMs: 5000 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.matched, 'Failed');
    await assert.rejects(actFast(page, { action: 'wait', text: 'Nope1|Nope2', timeoutMs: 300 }));
  });

  it('5: tabs_batch echoes the tab list only when asked or when tabs changed unexpectedly', async () => {
    const nav = await m.tabsBatch([{ action: 'navigate', url: `${base}/ok` }]);
    assert.equal(nav.tabs, undefined);
    const open = await m.tabsBatch([{ action: 'open', url: `${base}/ok` }]);
    assert.equal(open.tabs, undefined);
    const list = await m.tabsBatch([{ action: 'list' }]);
    assert.ok(Array.isArray(list.tabs) && list.tabs.length >= 2);
    const closed = await m.tabsBatch([{ action: 'close', tabId: open.results[0].tabId }]);
    assert.ok(Array.isArray(closed.tabs));
    // A popup the caller did not request shows up in the next batch.
    const { page: p } = await m.getPage();
    await p.goto(`${base}/ok`);
    const countBefore = (await m.tabsBatch([{ action: 'list' }])).tabs.length;
    await p.evaluate(() => window.open('/ok', '_blank'));
    await new Promise((r) => setTimeout(r, 300));
    const after = await m.tabsBatch([{ action: 'navigate', url: `${base}/ok` }]);
    assert.ok(Array.isArray(after.tabs), 'unexpected new tab must be reported');
    assert.equal(after.tabs.length, countBefore + 1);
  });

  it('6: onlyChanged after a URL change says so and still returns the snapshot', async () => {
    const { page: p } = await m.getPage();
    const state = m.getSnapshotState(p);
    await p.setContent('<a href="#a">one</a><button>two</button>');
    await inspectCompact(p, {}, state);
    const same = await inspectCompact(p, { onlyChanged: true }, state);
    assert.doesNotMatch(same.text, /URL changed/);
    await p.goto(`${base}/missing`);
    await p.setContent('<a href="#a">one</a><button>two</button><button>three</button>');
    const changed = await inspectCompact(p, { onlyChanged: true }, state);
    assert.match(changed.text, /URL changed: full snapshot/);
    assert.match(changed.text, /three/);
  });
});
