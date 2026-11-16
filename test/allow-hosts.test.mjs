import assert from 'node:assert/strict';
import http from 'node:http';
import { after, afterEach, before, describe, it } from 'node:test';

import { BrowserManager } from '../src/browser-manager.mjs';
import { getPolicy, matchUrl, urlDenial } from '../src/allow-hosts.mjs';
import { dispatchToolCall, parseCliArgs } from '../src/index.mjs';

// Server A is reached as 127.0.0.1, server B as localhost (and sub.localhost): same machine, different hosts.
let A, B, portA, portB;
let manager;
let dataHits = 0;
const ENV_KEYS = ['TURBO_BROWSER_ALLOW_HOSTS', 'TURBO_BROWSER_ALLOW_ORIGINS', 'TURBO_BROWSER_ALLOW_STRICT'];
const setPolicy = (o = {}) => {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, o);
};
const listen = (handler) =>
  new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve([s, s.address().port]));
  });
const html = (res, body) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`);
};
const call = async (name, args) => JSON.parse((await dispatchToolCall(manager, name, args)).text);
const hostA = () => `http://127.0.0.1:${portA}`;
const hostB = () => `http://localhost:${portB}`;
const tabs = (operations) => call('tabs_batch', { operations });

before(async () => {
  [B, portB] = await listen((req, res) => {
    if (req.url.startsWith('/beacon')) { res.writeHead(204); res.end(); return; }
    if (req.url.startsWith('/data')) { dataHits++; res.writeHead(200, { 'access-control-allow-origin': '*' }); res.end('{}'); return; }
    html(res, '<h1 id="b">page b</h1>');
  });
  [A, portA] = await listen((req, res) => {
    if (req.url === '/redir') { res.writeHead(302, { location: `http://localhost:${portB}/landed` }); res.end(); return; }
    if (req.url === '/link') return html(res, `<a id="l" href="http://localhost:${portB}/via-link">go</a><button id="js" onclick="location.assign('http://localhost:${portB}/via-js')">js</button>`);
    if (req.url === '/form') return html(res, `<form method="get" action="http://localhost:${portB}/via-form"><button id="f">send</button></form>`);
    if (req.url === '/sub') return html(res, `<img id="i" src="http://localhost:${portB}/x.png"><script>fetch('http://localhost:${portB}/data').then(()=>document.title='fetched',()=>document.title='fetch-blocked')</script>`);
    html(res, '<h1 id="a">page a</h1>');
  });
  manager = new BrowserManager({ mode: 'launch', headless: true });
});

afterEach(() => setPolicy());
after(async () => {
  setPolicy();
  await manager?.close().catch(() => {});
  await new Promise((r) => A.close(r));
  await new Promise((r) => B.close(r));
});

describe('policy parsing', () => {
  it('unset or empty means no policy', () => {
    assert.equal(getPolicy({}), null);
    assert.equal(getPolicy({ TURBO_BROWSER_ALLOW_HOSTS: ' , ,' }), null);
    assert.equal(urlDenial('http://evil.com/', null), null);
  });
  it('matches host and subdomains, ignores case, whitespace, empties and a leading wildcard', () => {
    const p = getPolicy({ TURBO_BROWSER_ALLOW_HOSTS: ' Example.COM , *.Shop.test,, ' });
    assert.equal(matchUrl('https://example.com/x', p).ok, true);
    assert.equal(matchUrl('https://a.b.EXAMPLE.com/', p).ok, true);
    assert.equal(matchUrl('https://shop.test/', p).ok, true);
    assert.equal(matchUrl('https://notexample.com/', p).ok, false);
    assert.equal(matchUrl('https://example.com.evil.com/', p).ok, false);
  });
  it('always allows about:blank, data:, blob:, chrome-error: and blocks file:', () => {
    const p = getPolicy({ TURBO_BROWSER_ALLOW_HOSTS: 'example.com' });
    for (const u of ['about:blank', 'data:text/html,hi', 'blob:http://evil.com/1', 'chrome-error://chromewebdata/']) {
      assert.equal(matchUrl(u, p).ok, true, u);
    }
    assert.equal(matchUrl('file:///etc/passwd', p).ok, false);
    assert.match(urlDenial('file:///x', p), /^scheme not allowed: file:/);
  });
  it('requires both lists to pass when both are set', () => {
    const p = getPolicy({ TURBO_BROWSER_ALLOW_HOSTS: 'localhost', TURBO_BROWSER_ALLOW_ORIGINS: 'http://localhost:3000' });
    assert.equal(matchUrl('http://localhost:3000/a', p).ok, true);
    assert.equal(matchUrl('http://localhost:3001/a', p).ok, false);
    assert.equal(matchUrl('http://127.0.0.1:3000/a', p).ok, false);
    const o = getPolicy({ TURBO_BROWSER_ALLOW_ORIGINS: 'http://localhost:3000' });
    assert.match(urlDenial('http://localhost:3001/', o), /^origin not allowed: http:\/\/localhost:3001 \(TURBO_BROWSER_ALLOW_ORIGINS\)$/);
  });
  it('CLI flags map to the env variables', () => {
    const r = parseCliArgs(['--allow-hosts', 'a.com,b.com', '--allow-origins=http://x:1', '--allow-strict']);
    assert.deepEqual(r.envOverrides, {
      TURBO_BROWSER_ALLOW_HOSTS: 'a.com,b.com',
      TURBO_BROWSER_ALLOW_ORIGINS: 'http://x:1',
      TURBO_BROWSER_ALLOW_STRICT: '1',
    });
  });
});

describe('unset policy', () => {
  it('changes nothing: no extra keys, no blocked field, no guard', async () => {
    setPolicy();
    const r = await tabs([{ action: 'open', url: `${hostA()}/redir` }]);
    assert.equal(r.results[0].action, 'open');
    assert.match(r.results[0].url, /localhost/);
    assert.deepEqual(Object.keys(r.results[0]).sort(), ['action', 'finalUrl', 'isolatedContext', 'tabId', 'title', 'url']);
    const text = (await dispatchToolCall(manager, 'inspect_compact', {})).text;
    assert.ok(!/blocked/.test(text));
  });
});

describe('allowed and denied inputs', () => {
  it('allowed navigation works', async () => {
    setPolicy({ TURBO_BROWSER_ALLOW_HOSTS: '127.0.0.1' });
    const r = await tabs([{ action: 'open', url: `${hostA()}/ok` }]);
    assert.equal(r.results[0].ok, undefined);
    assert.match(r.results[0].title, /t/);
    assert.ok(!('blocked' in r.results[0]));
  });
  it('a lone denied open rejects with the documented message', async () => {
    setPolicy({ TURBO_BROWSER_ALLOW_HOSTS: '127.0.0.1' });
    await assert.rejects(tabs([{ action: 'open', url: `${hostB()}/` }]), /^Error: host not allowed: localhost \(TURBO_BROWSER_ALLOW_HOSTS\)$/);
  });
  it('a denied open among other operations fails alone', async () => {
    setPolicy({ TURBO_BROWSER_ALLOW_HOSTS: '127.0.0.1' });
    const r = await tabs([{ action: 'open', url: `${hostB()}/` }, { action: 'open', url: `${hostA()}/ok` }, { action: 'list' }]);
    assert.equal(r.results[0].ok, false);
    assert.match(r.results[0].error, /host not allowed: localhost/);
  });
  it('open_many fails only the denied URL', async () => {
    setPolicy({ TURBO_BROWSER_ALLOW_HOSTS: '127.0.0.1' });
    const r = await tabs([{ action: 'open_many', urls: [`${hostA()}/1`, `${hostB()}/2`, `${hostA()}/3`] }]);
    const o = r.results[0].opened;
    assert.deepEqual(o.map((x) => x.ok), [true, false, true]);
    assert.match(o[1].error, /^host not allowed: localhost/);
    assert.equal(o[1].tabId, null);
  });
  it('tabs_batch navigate and batch_actions navigate are checked', async () => {
    setPolicy({ TURBO_BROWSER_ALLOW_HOSTS: '127.0.0.1' });
    await tabs([{ action: 'open', url: `${hostA()}/ok` }]);
    const n = await tabs([{ action: 'navigate', url: `${hostB()}/` }]);
    assert.equal(n.results[0].ok, false);
    assert.match(n.results[0].error, /host not allowed: localhost/);
    const b = await call('batch_actions', { steps: [{ action: 'navigate', url: `${hostB()}/` }], continueOnError: true });
    assert.match(JSON.stringify(b), /host not allowed: localhost/);
    const ok = await call('batch_actions', { steps: [{ action: 'navigate', url: `${hostA()}/ok` }] });
    assert.ok(!/host not allowed/.test(JSON.stringify(ok)));
  });
  it('subdomains of an allowed host pass, other hosts do not', async () => {
    setPolicy({ TURBO_BROWSER_ALLOW_HOSTS: '*.LOCALHOST' });
    const r = await tabs([{ action: 'open_many', urls: [`${hostB()}/`, `http://sub.localhost:${portB}/`, `${hostA()}/`] }]);
    assert.deepEqual(r.results[0].opened.map((x) => x.ok), [true, true, false]);
  });
  it('hosts and origins must both pass', async () => {
    setPolicy({ TURBO_BROWSER_ALLOW_HOSTS: 'localhost,127.0.0.1', TURBO_BROWSER_ALLOW_ORIGINS: hostA() });
    const r = await tabs([{ action: 'open_many', urls: [`${hostA()}/`, `${hostB()}/`] }]);
    assert.deepEqual(r.results[0].opened.map((x) => x.ok), [true, false]);
    assert.match(r.results[0].opened[1].error, /origin not allowed/);
  });
});

describe('navigation not started by a URL input', () => {
  it('blocks a server redirect to a denied host and reports it', async () => {
    setPolicy({ TURBO_BROWSER_ALLOW_HOSTS: '127.0.0.1' });
    const r = await tabs([{ action: 'open', url: `${hostA()}/ok` }, { action: 'navigate', url: `${hostA()}/redir` }]);
    const n = r.results[1];
    assert.equal(n.ok, false);
    assert.equal(n.blocked, 'host-not-allowed');
    assert.match(n.url, /localhost:\d+\/landed/);
    assert.match(n.error, /host not allowed: localhost/);
    const o = await tabs([{ action: 'open', url: `${hostA()}/ok` }, { action: 'open', url: `${hostA()}/redir` }]);
    assert.equal(o.results[1].blocked, 'host-not-allowed');
    const many = await tabs([{ action: 'open_many', urls: [`${hostA()}/redir`, `${hostA()}/ok`] }]);
    assert.equal(many.results[0].opened[0].blocked, 'host-not-allowed');
    assert.equal(many.results[0].opened[1].ok, true);
  });
  it('blocks a batch_actions navigate that redirects, and reports once', async () => {
    setPolicy({ TURBO_BROWSER_ALLOW_HOSTS: '127.0.0.1' });
    await tabs([{ action: 'open', url: `${hostA()}/ok` }]);
    const b = await call('batch_actions', { steps: [{ action: 'navigate', url: `${hostA()}/redir` }], continueOnError: true });
    assert.equal(b.blocked, 'host-not-allowed');
    assert.match(b.blockedUrl, /localhost/);
    const again = await call('batch_actions', { steps: [{ action: 'extract', format: 'text' }] });
    assert.ok(!/host-not-allowed/.test(JSON.stringify(again)));
  });
  for (const [name, path, sel] of [['link click', '/link', '#l'], ['JS redirect', '/link', '#js'], ['form submit', '/form', '#f']]) {
    it(`blocks a ${name} to a denied host and reports it once`, async () => {
      setPolicy({ TURBO_BROWSER_ALLOW_HOSTS: '127.0.0.1' });
      await tabs([{ action: 'open', url: `${hostA()}${path}` }]);
      await dispatchToolCall(manager, 'act_fast', { action: 'click', selector: sel, timeoutMs: 3000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      const probe = await dispatchToolCall(manager, 'extract_clean_text', {});
      assert.ok(!/page b/.test(probe.text), 'denied page must not load');
      const { page } = await manager.getPage();
      assert.match(page.url(), /^http:\/\/127\.0\.0\.1/);
    });
  }
  it('the click result carries blocked once', async () => {
    setPolicy({ TURBO_BROWSER_ALLOW_HOSTS: '127.0.0.1' });
    await tabs([{ action: 'open', url: `${hostA()}/link` }]);
    const click = await dispatchToolCall(manager, 'act_fast', { action: 'click', selector: '#l', timeoutMs: 3000 }).catch((e) => ({ text: String(e) }));
    let text = click.text;
    if (!/host-not-allowed/.test(text)) text = (await dispatchToolCall(manager, 'extract_clean_text', {})).text;
    assert.match(text, /"blocked":"host-not-allowed","blockedUrl":"http:\/\/localhost:\d+\/via-link"/);
    const after2 = (await dispatchToolCall(manager, 'extract_clean_text', {})).text;
    assert.ok(!/host-not-allowed/.test(after2));
  });
  it('does not restrict sub-resources by default', async () => {
    setPolicy({ TURBO_BROWSER_ALLOW_HOSTS: '127.0.0.1' });
    dataHits = 0;
    await tabs([{ action: 'open', url: `${hostA()}/sub` }]);
    await new Promise((r) => setTimeout(r, 400));
    const { page } = await manager.getPage();
    assert.equal(await page.title(), 'fetched');
    assert.equal(dataHits, 1);
  });
  it('strict mode aborts sub-resource requests and wraps WebSocket and sendBeacon', async () => {
    setPolicy({ TURBO_BROWSER_ALLOW_HOSTS: '127.0.0.1', TURBO_BROWSER_ALLOW_STRICT: '1' });
    dataHits = 0;
    await tabs([{ action: 'open', url: `${hostA()}/sub` }]);
    await new Promise((r) => setTimeout(r, 400));
    const { page } = await manager.getPage();
    assert.equal(await page.title(), 'fetch-blocked');
    assert.equal(dataHits, 0);
    const probe = await page.evaluate((b) => {
      let ws = 'ok';
      try { new WebSocket(b.replace('http', 'ws') + '/s'); } catch (e) { ws = e.name; }
      return { ws, beacon: navigator.sendBeacon(b + '/beacon', 'x') };
    }, hostB());
    assert.equal(probe.ws, 'SecurityError');
    assert.equal(probe.beacon, false);
  });
});

describe('overhead (informational)', () => {
  it('measures ms per navigation with and without a policy', async () => {
    const N = 8;
    const run = async (env) => {
      setPolicy(env);
      await tabs([{ action: 'open', url: `${hostA()}/ok` }]);
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < N; i++) await tabs([{ action: 'navigate', url: `${hostA()}/ok?i=${i}`, waitUntil: 'domcontentloaded' }]);
      return Number(process.hrtime.bigint() - t0) / 1e6 / N;
    };
    const off = await run({});
    const on = await run({ TURBO_BROWSER_ALLOW_HOSTS: '127.0.0.1' });
    const strict = await run({ TURBO_BROWSER_ALLOW_HOSTS: '127.0.0.1', TURBO_BROWSER_ALLOW_STRICT: '1' });
    console.log(`overhead ms/nav: off=${off.toFixed(1)} on=${on.toFixed(1)} strict=${strict.toFixed(1)}`);
    assert.ok(Number.isFinite(off + on + strict));
  });
});
