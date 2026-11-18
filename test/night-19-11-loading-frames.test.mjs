// Night 19-11: inspect_compact says which empty iframes are still loading (lazy embeds such as MDN live examples).
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { dispatchToolCall } from '../src/index.mjs';

let web, port;
before(async () => {
  web = http.createServer((req, res) => {
    if (req.url === '/slow') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('<!doctype html><title>slow</title>');
      setTimeout(() => res.end('<label><input type=checkbox> Late box</label>'), 2500);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<p>host</p><input aria-label="Top field"><iframe src="/slow" style="width:300px;height:100px"></iframe>`);
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  port = web.address().port;
});
after(() => new Promise((r) => web.close(r)));

describe('night 19-11 loading frames', () => {
  let m;
  after(async () => { await m?.close().catch(() => {}); });
  it('flags a still-loading empty iframe, then lists its field once loaded', async () => {
    m = new BrowserManager({ mode: 'launch', headless: true });
    await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'open', url: `http://127.0.0.1:${port}/`, waitUntil: 'domcontentloaded' }] });
    const early = (await dispatchToolCall(m, 'inspect_compact', { mode: 'forms' })).text;
    assert.match(early, /Loading frames: f1/, early);
    await new Promise((r) => setTimeout(r, 3500));
    const later = (await dispatchToolCall(m, 'inspect_compact', { mode: 'forms' })).text;
    assert.doesNotMatch(later, /Loading frames/, later);
    assert.match(later, /Late box/, later);
  });
});
