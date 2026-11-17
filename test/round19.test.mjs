// Round 19: thin-page bot wall report, possibleSubmit second check on clicks. Local fixtures only.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { dispatchToolCall } from '../src/index.mjs';

let web, port, m;
const base = () => `http://127.0.0.1:${port}`;
const open = async (p) => JSON.parse((await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'open', url: `${base()}${p}` }] })).text);
const PAGES = {
  '/403': [403, '<title>x</title><body>Denied</body>'],
  '/429': [429, '<title>x</title><body>Slow</body>'],
  '/403-login': [403, '<title>x</title><form><input type="password"></form>'],
  '/noindex': [200, '<title>x</title><meta name="robots" content="noindex"><body>Wait</body>'],
  '/noindex-long': [200, '<title>x</title><meta name="robots" content="noindex"><body>' + 'word '.repeat(80) + '</body>'],
  '/example': [200, '<title>Example Domain</title><body><h1>Example Domain</h1><p>This domain is for use in illustrative examples in documents.</p></body>'],
  '/icon': [200, '<title>I</title><button id="i" aria-label="x" onclick="fetch(\'/api/save\',{method:\'POST\',body:\'a\'})">&#9993;</button><button id="g" onclick="fetch(\'/api/list\')">&#9776;</button><button id="a" onclick="fetch(\'/analytics/collect\',{method:\'POST\',body:\'a\'})">t</button>'],
};
before(async () => {
  web = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (req.method !== 'GET' || path.startsWith('/api/') || path.startsWith('/analytics')) { res.writeHead(200); res.end('ok'); return; }
    const [status, body] = PAGES[path] || [404, ''];
    res.writeHead(status, { 'content-type': 'text/html' });
    res.end(`<!doctype html>${body}`);
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  port = web.address().port;
  m = new BrowserManager({ mode: 'launch', headless: true });
});
after(async () => { await m?.close().catch(() => {}); await new Promise((r) => web.close(r)); });

describe('round 19', () => {
  it('thin page: 403, 429 and a noindex stub with almost no text are flagged', async () => {
    for (const p of ['/403', '/429', '/noindex']) {
      const r = await open(p);
      assert.equal(r.results[0].blocked, 'thin', `${p} ${JSON.stringify(r.results[0])}`);
    }
  });
  it('thin page: not on a login form, a long noindex page or a normal tiny 200 page', async () => {
    for (const p of ['/403-login', '/noindex-long', '/example']) {
      const r = await open(p);
      assert.notEqual(r.results[0].blocked, 'thin', `${p} ${JSON.stringify(r.results[0])}`);
    }
  });
  it('possibleSubmit: an icon button outside a form that POSTs is flagged, a GET and analytics are not', async () => {
    await open('/icon');
    const post = JSON.parse((await dispatchToolCall(m, 'act_fast', { action: 'click', selector: '#i' })).text);
    assert.equal(post.possibleSubmit, true, JSON.stringify(post));
    assert.match(post.request, /^POST 127\.0\.0\.1/);
    const get = JSON.parse((await dispatchToolCall(m, 'act_fast', { action: 'click', selector: '#g' })).text);
    assert.equal(get.possibleSubmit, undefined, JSON.stringify(get));
    const an = JSON.parse((await dispatchToolCall(m, 'act_fast', { action: 'click', selector: '#a' })).text);
    assert.equal(an.possibleSubmit, undefined, JSON.stringify(an));
  });
});
