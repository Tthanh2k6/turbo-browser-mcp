import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { before, after, beforeEach, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, batchActions, extractCleanText, inspectCompact } from '../src/dom-engine.mjs';
import { dispatchToolCall } from '../src/index.mjs';

let server, base, manager, page, workDir;
const requests = [];
before(async () => {
  fs.mkdirSync(path.resolve('tmp'), { recursive: true });
  workDir = fs.mkdtempSync(path.resolve('tmp/brief-07-'));
  server = http.createServer((req, res) => {
    requests.push({ url: req.url, method: req.method });
    res.setHeader('content-type', 'text/html');
    if (req.url === '/') {
      res.end(`<!doctype html><title>Old page</title>
        <a id="link" href="/receipt" onclick="event.preventDefault(); setTimeout(() => location.href=this.href, 50)">Review</a>
        <form action="/receipt"><input id="enter" name="name" value="Ada"><button id="submit">Submit</button></form>
        <button id="spa" onclick="history.pushState({}, '', '/spa'); document.querySelector('#link').textContent='Updated'">Next</button>
        <button id="reload" onclick="setTimeout(() => location.reload(), 50)">Reload</button>`);
    } else if (req.url.startsWith('/receipt')) {
      // Delay the response so a request has started while page.url() is still the old URL.
      setTimeout(() => res.end('<!doctype html><title>Receipt</title><button>New document</button>'), 450);
    } else if (req.url.startsWith('/catalog')) {
      const n = Number(new URL(req.url, base).searchParams.get('page'));
      res.end(`<!doctype html><title>Catalog ${n}</title><main><h1>Page ${n}</h1><p>Row ${n * 2 - 1}</p><p>Row ${n * 2}</p></main>`);
    } else if (req.url === '/autosave') {
      res.end(`<!doctype html><main>Draft</main><script>fetch('/write', {method:'POST'}).catch(() => {})</script>`);
    } else {
      res.end('<!doctype html><main>Done</main>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  manager = new BrowserManager({ mode: 'launch', headless: true });
  ({ page } = await manager.getPage());
});
// A navigation started by the previous test (e.g. a delayed /receipt) can still be in flight under load.
beforeEach(async () => {
  for (let i = 0; i < 3; i += 1) {
    try { await page.goto(base); break; } catch (e) {
      if (!/interrupted by another navigation/.test(String(e)) || i === 2) throw e;
      await page.waitForLoadState('load').catch(() => {});
    }
  }
  requests.length = 0;
});
after(async () => {
  await manager?.close();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(workDir, { recursive: true, force: true });
});

for (const batch of [false, true]) {
  for (const step of [
    { action: 'click', selector: '#link' },
    { action: 'click', selector: '#submit', allowSubmit: true },
    { action: 'press', selector: '#enter', key: 'Enter', allowSubmit: true },
  ]) {
    it(`${batch ? 'batch' : 'act'} snapshot waits for ${step.action} ${step.selector} navigation`, async () => {
      const result = batch
        ? await batchActions(page, [step], { returnSnapshot: true })
        : await actFast(page, { ...step, returnSnapshot: true });
      assert.equal(result.error, undefined);
      assert.ok(result.snapshot.startsWith(`URL: ${base}/receipt`), JSON.stringify(result));
      assert.match(result.snapshot, /New document/);
      assert.doesNotMatch(result.snapshot, /Old page/);
    });
  }
}

it('same-document SPA snapshot includes the updated URL and content', async () => {
  const result = await actFast(page, { action: 'click', selector: '#spa', returnSnapshot: true });
  assert.ok(result.snapshot.startsWith(`URL: ${base}/spa`));
  assert.match(result.snapshot, /Updated/);
});

it('same-URL reload is detected by its main-frame request', async () => {
  await page.evaluate(() => { document.querySelector('#link').textContent = 'Stale'; });
  const result = await actFast(page, { action: 'click', selector: '#reload', returnSnapshot: true });
  assert.doesNotMatch(result.snapshot, /Stale/);
  assert.match(result.snapshot, /Review/);
});

it('navigation waits respect timeout and remove listeners on failure and blocked clicks', async () => {
  const events = ['request', 'domcontentloaded', 'framenavigated'];
  const counts = events.map(event => page.listenerCount(event));
  await assert.rejects(actFast(page, {
    action: 'click', selector: '#link', returnSnapshot: true, timeoutMs: 250,
  }), /timeout/i);
  assert.deepEqual(events.map(event => page.listenerCount(event)), counts);
  await page.goto(base);
  const blocked = await actFast(page, { action: 'click', selector: '#submit', returnSnapshot: true });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.snapshot, undefined);
  assert.deepEqual(events.map(event => page.listenerCount(event)), counts);
});

it('one dispatched batch returns all rows from three pages in order', async () => {
  const steps = [1, 2, 3].flatMap(n => [
    { action: 'navigate', url: `${base}/catalog?page=${n}` },
    { action: 'extract', format: 'text', selector: 'main', maxChars: 500 },
  ]);
  const response = await dispatchToolCall(manager, 'batch_actions', { steps });
  const result = JSON.parse(response.text);
  assert.equal(result.completed, 6, response.text);
  const extracts = result.results.filter(r => r.text);
  assert.deepEqual(extracts.flatMap(r => r.text.match(/Row \d+/g)), ['Row 1', 'Row 2', 'Row 3', 'Row 4', 'Row 5', 'Row 6']);
  for (let i = 0; i < 3; i++) {
    assert.equal(extracts[i].step, i * 2 + 1);
    assert.equal(extracts[i].url, `${base}/catalog?page=${i + 1}`);
  }
  assert.equal(page.url(), `${base}/catalog?page=3`);
});

it('extract returns standalone output for both formats, selectors and character caps', async () => {
  await page.goto(`${base}/catalog?page=1`);
  for (const format of ['text', 'markdown']) {
    const options = { format, selector: 'main', maxChars: 200 };
    const expected = await extractCleanText(page, options);
    const result = await batchActions(page, [{ action: 'extract', ...options }]);
    assert.deepEqual(result.results[0], { step: 0, ...expected });
    assert.ok(result.results[0].text.length <= 200);
  }
});

it('navigate rejects executable/local URLs, non-GET methods and bodies before making requests', async () => {
  for (const step of [
    { url: "javascript:fetch('/write',{method:'POST'})" },
    { url: 'file:///etc/passwd' },
    { url: 'data:text/html,<script>fetch("/write")</script>' },
    { url: `${base}/write`, method: 'POST' },
    { url: `${base}/write`, body: 'payload' },
    { url: `${base}/write`, postData: 'payload' },
    {},
  ]) {
    const result = await batchActions(page, [{ action: 'navigate', ...step }]);
    assert.ok(result.error, JSON.stringify(step));
  }
  assert.equal(requests.filter(r => r.url === '/write').length, 0);
  const result = await batchActions(page, [{ action: 'navigate', url: '/catalog?page=1', method: 'GET' }]);
  assert.equal(result.results[0].ok, true);
  assert.equal(requests.find(r => r.url === '/catalog?page=1').method, 'GET');
});

it('navigate retains the batch network guard on the destination page', async () => {
  const result = await batchActions(page, [
    { action: 'navigate', url: `${base}/autosave` },
    { action: 'extract', format: 'text' },
  ], { networkGuard: true, networkGuardSettleMs: 250 });
  assert.equal(result.blocked, true, JSON.stringify(result));
  assert.equal(result.results[0].blockedBy, 'network');
  assert.equal(result.results.length, 1);
  assert.equal(requests.filter(r => r.method === 'POST').length, 0);
});

it('read steps respect duplicate ledger checks and confined export paths', async () => {
  const steps = [{ action: 'navigate', url: `${base}/catalog?page=1` }, { action: 'extract', format: 'text' }];
  const options = { allowSubmit: true, submissionKey: 'read-batch', ledgerPath: path.join(workDir, 'ledger.jsonl') };
  const first = await batchActions(page, steps, options);
  assert.equal(first.submissionKey, options.submissionKey);
  const duplicate = await batchActions(page, steps, options);
  assert.equal(duplicate.blockedBy, 'ledger');
  assert.equal(duplicate.results.length, 0);
  const invalid = await batchActions(page, [{ action: 'extract', savePath: '../outside-extract.txt' }]);
  assert.match(invalid.error, /outside|allowed|traversal/i);
});

it('read step errors stop the batch or continue when requested', async () => {
  const steps = [{ action: 'navigate', url: 'javascript:void(0)' }, { action: 'extract', format: 'text' }];
  assert.equal((await batchActions(page, steps)).results.length, 1);
  const result = await batchActions(page, steps, { continueOnError: true });
  assert.equal(result.results.length, 2);
  assert.match(result.results[1].text, /Review/);
});

async function buttons() {
  await page.setContent(Array.from({ length: 140 }, (_, i) =>
    `<button id="b${i}" onclick="document.body.dataset.hit=this.id">Item ${i}</button>`).join(''));
}

it('140-button delta reports a removal without reordering noise and surviving refs stay attached', async () => {
  await buttons();
  const state = new Set();
  await inspectCompact(page, { maxChars: 20000 }, state);
  const removed = await page.locator('#b12').getAttribute('data-tbm-ref');
  const surviving = await page.locator('#b130').getAttribute('data-tbm-ref');
  await page.evaluate(() => {
    document.querySelector('#b12').remove();
    [...document.querySelectorAll('button')].reverse().forEach(button => document.body.append(button));
  });
  const delta = await inspectCompact(page, { onlyChanged: true }, state);
  assert.match(delta.text, new RegExp(`Removed: f0:${removed}(?:\\n|$)`));
  assert.doesNotMatch(delta.text, /<button>/);
  await actFast(page, { action: 'click', ref: `f0:${surviving}` });
  assert.equal(await page.getAttribute('body', 'data-hit'), 'b130');
  await page.evaluate(() => [...document.querySelectorAll('button')].reverse().forEach(button => document.body.append(button)));
  const unchanged = await inspectCompact(page, { onlyChanged: true }, state);
  assert.doesNotMatch(unchanged.text, /Removed:|<button>/);
});

it('delta caps removals at 30 refs and does not reuse the removed highest ref', async () => {
  await buttons();
  const state = new Set();
  await inspectCompact(page, { maxChars: 20000 }, state);
  await page.evaluate(() => [...document.querySelectorAll('button')].slice(100).forEach(button => button.remove()));
  const delta = await inspectCompact(page, { onlyChanged: true }, state);
  assert.match(delta.text, /Removed: .* \+10 more/);
  assert.equal(delta.text.match(/f0:e\d+/g).length, 30);
  await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<button>Item 139</button>'); });
  const added = await inspectCompact(page, { onlyChanged: true }, state);
  assert.match(added.text, /Item 139/);
});

it('ref signatures distinguish identical labels and filtered snapshots do not report false removals', async () => {
  await page.setContent('<button id="a">Same</button><button id="b">Same</button>');
  const state = new Set();
  await inspectCompact(page, {}, state);
  const oldRef = await page.locator('#b').getAttribute('data-tbm-ref');
  await page.locator('#b').evaluate(el => el.outerHTML = '<button id="c">Same</button>');
  const filtered = await inspectCompact(page, { onlyChanged: true, selector: '#a' }, state);
  assert.doesNotMatch(filtered.text, /Removed:/);
  const delta = await inspectCompact(page, { onlyChanged: true }, state);
  assert.match(delta.text, /<button> "Same"/);
  assert.match(delta.text, new RegExp(`Removed: f0:${oldRef}`));
  assert.notEqual(await page.locator('#c').getAttribute('data-tbm-ref'), oldRef);
});
