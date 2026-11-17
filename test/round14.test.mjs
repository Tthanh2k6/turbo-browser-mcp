// Round 14: a redirect onto a login path (or a 401/403 login form) is reported as blocked:"authwall".
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { dispatchToolCall } from '../src/index.mjs';

let server, port, manager;
const call = async (name, args) => JSON.parse((await dispatchToolCall(manager, name, args)).text);
const base = () => `http://127.0.0.1:${port}`;
const page = (res, status, title, body) => {
  res.writeHead(status, { 'content-type': 'text/html' });
  res.end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);
};
const LONG = '<p>' + 'Plenty of ordinary article text for this page. '.repeat(10) + '</p>';

before(async () => {
  server = http.createServer((req, res) => {
    const u = req.url;
    if (u.startsWith('/top')) { res.writeHead(302, { location: '/login/?reason=lor2&dest=%2Ftop' }); res.end(); return; }
    if (u.startsWith('/login')) {
      const status = u.includes('reason=') ? 403 : 200;
      return page(res, status, '', '<form><input name="u"><input type="password" name="p"></form>');
    }
    if (u === '/forbidden-form') return page(res, 403, 'Nope', '<form><input type="password" name="p"></form>');
    if (u === '/forbidden-plain') return page(res, 403, 'Nope', '<p>Forbidden</p>');
    if (u === '/redir-ok') { res.writeHead(302, { location: '/article' }); res.end(); return; }
    page(res, 200, 'Article', `${LONG}<a href="/login">Log in</a>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  manager = new BrowserManager({ mode: 'launch', headless: true });
});
after(async () => {
  await manager?.close().catch(() => {});
  await new Promise((r) => server.close(r));
});

describe('round 14: authwall detection', () => {
  it('tabs_batch open on a redirect to /login with 403 reports authwall', async () => {
    const r = await call('tabs_batch', { operations: [{ action: 'open', url: `${base()}/top` }] });
    const o = r.results[0];
    assert.equal(o.blocked, 'authwall', JSON.stringify(o));
    assert.equal(o.status, 403);
  });
  it('open_many flags it too', async () => {
    const r = await call('tabs_batch', { operations: [{ action: 'open_many', urls: [`${base()}/top`, `${base()}/article`] }] });
    const s = JSON.stringify(r);
    assert.match(s, /authwall/);
    assert.equal((s.match(/authwall/g) || []).length, 1, s);
  });
  it('navigate in tabs_batch and batch_actions flags it', async () => {
    await call('tabs_batch', { operations: [{ action: 'open', url: `${base()}/article` }] });
    const t = await call('tabs_batch', { operations: [{ action: 'navigate', url: `${base()}/top` }] });
    assert.equal(t.results[0].blocked, 'authwall', JSON.stringify(t));
    const b = await call('batch_actions', { steps: [{ action: 'navigate', url: `${base()}/top` }], continueOnError: true });
    assert.match(JSON.stringify(b), /"blocked":"authwall"/);
  });
  it('requesting the login page directly is not flagged', async () => {
    const r = await call('tabs_batch', { operations: [{ action: 'open', url: `${base()}/login` }] });
    assert.equal(r.results[0].blocked, undefined, JSON.stringify(r.results[0]));
  });
  it('a normal page with a Log in link is not flagged', async () => {
    const r = await call('tabs_batch', { operations: [{ action: 'open', url: `${base()}/article` }] });
    assert.equal(r.results[0].blocked, undefined, JSON.stringify(r.results[0]));
  });
  it('a redirect to a normal page is not flagged', async () => {
    const r = await call('tabs_batch', { operations: [{ action: 'open', url: `${base()}/redir-ok` }] });
    assert.equal(r.results[0].blocked, undefined, JSON.stringify(r.results[0]));
  });
  it('403 with a password form is flagged; 403 without one is not', async () => {
    const a = await call('tabs_batch', { operations: [{ action: 'open', url: `${base()}/forbidden-form` }] });
    assert.equal(a.results[0].blocked, 'authwall', JSON.stringify(a.results[0]));
    const b = await call('tabs_batch', { operations: [{ action: 'open', url: `${base()}/forbidden-plain` }] });
    assert.equal(b.results[0].blocked, 'thin', JSON.stringify(b.results[0])); // a 1-word 403 stub is a thin page, not an authwall
  });
});
