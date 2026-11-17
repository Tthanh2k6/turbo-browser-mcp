import assert from 'node:assert/strict';
import http from 'node:http';
import { before, after, beforeEach, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, batchActions, inspectCompact } from '../src/dom-engine.mjs';
import { CORE_TOOL_NAMES, TOOL_DEFINITIONS, createJsonRpcHandler, parseCliArgs } from '../src/index.mjs';

let server, base, manager, page;
const requests = [];
before(async () => {
  server = http.createServer((req, res) => {
    requests.push({ url: req.url, method: req.method });
    res.setHeader('content-type', 'text/html');
    if (req.url === '/') res.end('<!doctype html><title>Home</title><main>Home</main>');
    else res.end('<!doctype html><main>Other</main>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  manager = new BrowserManager({ mode: 'launch', headless: true });
  ({ page } = await manager.getPage());
});
beforeEach(async () => { await page.goto(base); requests.length = 0; });
after(async () => {
  await manager?.close();
  await new Promise(resolve => server.close(resolve));
});

// Item 1 and 4: instructions and core tool list.
it('initialize returns short server instructions', async () => {
  const handle = createJsonRpcHandler({});
  const reply = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const text = reply.result.instructions;
  assert.match(text, /smart_fill_form/);
  assert.match(text, /batch_actions/);
  assert.match(text, /onlyChanged/);
  assert.ok(text.length < 400, `instructions are ${text.length} chars`);
});

it('core mode lists exactly the six core tools and refuses the others; default lists all', async () => {
  const handle = createJsonRpcHandler({});
  const names = async () => (await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.map(t => t.name);
  assert.equal((await names()).length, TOOL_DEFINITIONS.length);
  process.env.TURBO_BROWSER_TOOLS = 'core';
  try {
    assert.deepEqual((await names()).sort(), [...CORE_TOOL_NAMES].sort());
    assert.equal(CORE_TOOL_NAMES.length, 6);
    const refused = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'evaluate_js', arguments: { expression: '1' } } });
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.content[0].text, /not available/);
  } finally {
    delete process.env.TURBO_BROWSER_TOOLS;
  }
  assert.equal((await names()).length, TOOL_DEFINITIONS.length);
});

it('--tools sets TURBO_BROWSER_TOOLS', () => {
  assert.equal(parseCliArgs(['--tools', 'core']).envOverrides.TURBO_BROWSER_TOOLS, 'core');
  assert.equal(parseCliArgs(['--tools=all']).envOverrides.TURBO_BROWSER_TOOLS, 'all');
});

// Some clients (for example Gemini function declarations) reject JSON Schema type arrays,
// so unions stay as oneOf.
it('tool schemas use no JSON Schema type arrays', () => {
  assert.doesNotMatch(JSON.stringify(TOOL_DEFINITIONS), /"type":\[/);
});

// Item 2: one settle step.
it('click that changes the DOM reports outcome changed and settles quickly', async () => {
  await page.setContent('<button id="b" onclick="setTimeout(() => document.body.append(\'done\'), 60)">Go</button>');
  const t0 = Date.now();
  const result = await actFast(page, { action: 'click', selector: '#b', returnSnapshot: true });
  assert.equal(result.outcome, 'changed');
  assert.match(await page.textContent('body'), /done/);
  assert.ok(Date.now() - t0 < 1500);
});

it('click with no effect reports outcome none and does not wait the old 300 ms to 1 s', async () => {
  await page.setContent('<button id="b">Nothing</button>');
  // Best of three: a loaded CI runner can delay one click by a few hundred ms without the settle step waiting.
  const times = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const result = await actFast(page, { action: 'click', selector: '#b', returnSnapshot: true });
    assert.equal(result.outcome, 'none');
    times.push(Date.now() - t0);
  }
  assert.ok(Math.min(...times) < 600, `took ${times.join(', ')} ms`);
});

it('navigation outcome is navigated and a late commit-like POST is still reported', async () => {
  await page.setContent('<a id="l" href="/next">Next</a>');
  const nav = await actFast(page, { action: 'click', selector: '#l', returnSnapshot: true });
  assert.equal(nav.outcome, 'navigated');
  await page.setContent('<button id="c" onclick="setTimeout(() => fetch(\'/submit\', {method:\'POST\'}), 250)">Continue</button>');
  const late = await actFast(page, { action: 'click', selector: '#c', observeAftermath: true });
  assert.equal(late.aftermath.unexpectedSubmit, true);
  assert.equal(late.aftermath.mutatingRequests[0].finalSubmit, true);
});

it('settle detaches its listeners', async () => {
  await page.setContent('<button id="b">Nothing</button>');
  await new Promise((r) => setTimeout(r, 900)); // the previous click's 800 ms request watch has ended
  const before = ['request', 'requestfinished', 'requestfailed'].map(e => page.listenerCount(e));
  await actFast(page, { action: 'click', selector: '#b', returnSnapshot: true, observeAftermath: true });
  await new Promise((r) => setTimeout(r, 2300)); // the late-aftermath listeners detach themselves after 2 s
  assert.deepEqual(['request', 'requestfinished', 'requestfailed'].map(e => page.listenerCount(e)), before);
});

it('an alert dialog does not hang the settle step', async () => {
  await page.setContent('<button id="b" onclick="alert(1)">Alert</button>');
  const result = await actFast(page, { action: 'click', selector: '#b', returnSnapshot: true });
  assert.equal(result.ok, true);
});

// Item 3: recoverable errors.
it('a stale ref error names the nearest current refs with labels', async () => {
  await page.setContent('<button>Alpha</button><button>Beta</button><button>Gamma</button><button>Delta</button>');
  await inspectCompact(page, {}, new Set());
  const result = await batchActions(page, [{ action: 'click', ref: 'f0:e99' }]);
  assert.match(result.error, /not found\. Nearest current refs: (f0:e\d+ "[A-Za-z]+"(, )?){3}\./);
});

it('an intercepted click names the covering element in one line', async () => {
  await page.setContent('<button id="t">Target</button><div id="cover" style="position:fixed;inset:0;background:#0001">Overlay</div>');
  const result = await batchActions(page, [{ action: 'click', selector: '#t', timeoutMs: 800 }]);
  assert.match(result.error, /^Click blocked: <div id="cover"/);
  assert.ok(!result.error.includes('\n'));
  assert.ok(result.error.length < 260);
});

it('a missing select option lists the closest options', async () => {
  await page.setContent('<select id="s"><option>Vietnam</option><option>Viet Nam North</option><option>Thailand</option><option>Laos</option><option>Cambodia</option><option>Japan</option></select>');
  const result = await batchActions(page, [{ action: 'select', selector: '#s', label: 'Vietnm', timeoutMs: 500 }]);
  assert.match(result.error, /Option "Vietnm" not found\. Closest: Vietnam/);
  assert.ok(result.error.split('|').length <= 5);
});

it('fill reads the value back and reports a mismatch', async () => {
  await page.setContent('<input id="a" maxlength="3"><input id="b"><input id="p" type="password" maxlength="2">');
  const cut = await actFast(page, { action: 'fill', selector: '#a', value: 'abcdef' });
  assert.equal(cut.mismatch, 'field now holds "abc"');
  const ok = await actFast(page, { action: 'fill', selector: '#b', value: 'fine' });
  assert.equal(ok.mismatch, undefined);
  const secret = await actFast(page, { action: 'fill', selector: '#p', value: 'hunter2' });
  assert.ok(secret.mismatch);
  assert.doesNotMatch(secret.mismatch, /hu/);
});

// Item 5: delta details.
it('delta marks new refs with * and keeps an unchanged submit-like control', async () => {
  await page.setContent('<button>Keep</button><button>Submit</button><button>Search</button>');
  const state = new Set();
  await inspectCompact(page, {}, state);
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<button>Fresh</button>'));
  const delta = await inspectCompact(page, { onlyChanged: true }, state);
  assert.match(delta.text, /^\*\[f0:e\d+\] <button> "Fresh"/m);
  assert.match(delta.text, /^\[f0:e\d+\] <button> "Submit"/m);
  assert.doesNotMatch(delta.text, /"Keep"|"Search"/);
  assert.equal(delta.shownCount, 2);
});

it('the guard still blocks the submit-like control that the delta keeps', async () => {
  await page.setContent('<button id="s" onclick="document.body.dataset.hit=1">Submit</button>');
  const state = new Set();
  await inspectCompact(page, {}, state);
  const delta = await inspectCompact(page, { onlyChanged: true }, state);
  const ref = /\[(f0:e\d+)\] <button> "Submit"/.exec(delta.text)[1];
  const result = await actFast(page, { action: 'click', ref });
  assert.equal(result.blocked, true);
  assert.equal(await page.getAttribute('body', 'data-hit'), null);
});
