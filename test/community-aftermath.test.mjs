import assert from 'node:assert/strict';
import http from 'node:http';
import { before, after, beforeEach, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, batchActions } from '../src/dom-engine.mjs';

const fixture = `<!doctype html><form action="/receipt">
  <button id="draft" type="submit" onclick="event.preventDefault(); const xhr = new XMLHttpRequest(); xhr.open('POST', '/draft'); xhr.send('draft')">Continue</button>
  <button id="final" type="submit">Submit</button>
  <button id="misleading" type="submit">Continue</button>
  <button id="commit" type="submit" onclick="event.preventDefault(); setTimeout(() => fetch('/submit', {method:'POST'}), 200)">Continue</button>
  <button id="hash" type="submit" onclick="event.preventDefault(); location.hash='step2'">Next</button>
</form>`;
let server, base, manager, page;
before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/' ? fixture : '<h1>Receipt 123</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  manager = new BrowserManager({ mode: 'launch', headless: true });
  ({ page } = await manager.getPage());
});
beforeEach(async () => { await page.goto(base); });
after(async () => {
  await manager?.close();
  await new Promise(resolve => server.close(resolve));
});
it('records wizard Continue XHR without classifying a draft as final', async () => {
  const result = await actFast(page, { action: 'click', selector: '#draft', observeAftermath: true });
  assert.equal(result.aftermath.navigated, false);
  assert.equal(result.aftermath.unexpectedSubmit, false);
  assert.deepEqual(result.aftermath.mutatingRequests, [{ method: 'POST', url: base + '/draft', finalSubmit: false }]);
});
it('reports allowed final Submit navigation', async () => {
  const result = await actFast(page, { action: 'click', selector: '#final', allowSubmit: true, observeAftermath: true });
  assert.equal(result.aftermath.navigated, true);
  assert.equal(new URL(result.aftermath.afterUrl).pathname, '/receipt');
  assert.equal(result.aftermath.unexpectedSubmit, false);
});
it('flags a safe label that navigates despite allowSubmit=false', async () => {
  const result = await actFast(page, { action: 'click', selector: '#misleading', observeAftermath: true });
  assert.equal(result.aftermath.navigated, true);
  assert.equal(result.aftermath.unexpectedSubmit, true);
  assert.match(result.aftermath.warning, /already occurred/);
});
it('batch option observes delayed commit-like fetches and cleans up listeners', async () => {
  const listeners = page.listenerCount('request');
  const result = await batchActions(page, [{ action: 'click', selector: '#commit' }], { observeAftermath: true });
  assert.equal(result.results[0].aftermath.unexpectedSubmit, true);
  assert.equal(result.results[0].aftermath.mutatingRequests[0].finalSubmit, true);
  assert.equal(page.listenerCount('request'), listeners);
});
it('default behavior has no observer or report', async () => {
  const result = await actFast(page, { action: 'click', selector: '#draft' });
  assert.equal(result.aftermath, undefined);
});
it('does not interpret hash changes as different paths', async () => {
  const result = await actFast(page, { action: 'click', selector: '#hash', observeAftermath: true });
  assert.equal(result.aftermath.navigated, false);
});
it('keeps the label guard and removes listeners for blocked or failed clicks', async () => {
  const requests = page.listenerCount('request'), navigations = page.listenerCount('framenavigated');
  const result = await actFast(page, { action: 'click', selector: '#final', observeAftermath: true });
  assert.equal(result.blocked, true);
  assert.equal(result.aftermath, undefined);
  await actFast(page, { action: 'click', selector: '#missing', timeoutMs: 50, observeAftermath: true }).catch(() => {});
  assert.equal(page.listenerCount('request'), requests);
  assert.equal(page.listenerCount('framenavigated'), navigations);
});
