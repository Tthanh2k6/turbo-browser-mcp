// Offline regression tests for field report round 5: refill after late hydration, fail-fast on disabled targets,
// clean error messages, wait text on placeholder/aria-label/value, SPA splash budget.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, batchActions, cleanErrorMessage, smartFillForm } from '../src/dom-engine.mjs';
import { settleSplash } from '../src/navinfo.mjs';
import { dispatchToolCall } from '../src/index.mjs';

// The textarea is replaced 300 ms after load by a fresh empty one; Submit enables only on an input event.
const HYDRATE = `<!doctype html><title>Post</title><body><form onsubmit="return false">
<label for="c">Add a comment</label><div id="slot"><textarea id="c" name="comment" placeholder="Add a comment"></textarea></div>
<button id="sub" disabled>Submit</button></form>
<script>
setTimeout(() => {
  const fresh = document.createElement('textarea');
  fresh.id = 'c'; fresh.name = 'comment'; fresh.placeholder = 'Add a comment';
  fresh.addEventListener('input', () => { document.getElementById('sub').disabled = !fresh.value; });
  document.getElementById('slot').replaceChildren(fresh);
}, 300);
</script></body>`;

describe('field fixes round 4 (field report round 5)', () => {
  let m;
  let page;
  before(async () => {
    m = new BrowserManager({ mode: 'launch', headless: true });
    ({ page } = await m.getPage());
  });
  after(async () => {
    await m.close();
  });

  it('1: a fill lost to late hydration is refilled once and reported', async () => {
    await page.setContent(HYDRATE);
    const r = await smartFillForm(page, { fields: [{ keys: ['Add a comment'], value: 'Great post, thanks' }] });
    assert.equal(r.refilled, 1, JSON.stringify(r));
    assert.equal(r.filledCount, 1);
    assert.equal(await page.inputValue('#c'), 'Great post, thanks');
    assert.equal(await page.isEnabled('#sub'), true);
  });

  it('1b: a stable page is not refilled and carries no refilled key', async () => {
    await page.setContent('<label for="n">Name</label><input id="n" name="n">');
    const r = await smartFillForm(page, { fields: [{ keys: ['Name'], value: 'Ann' }] });
    assert.equal(r.refilled, undefined, JSON.stringify(r));
    assert.equal(await page.inputValue('#n'), 'Ann');
  });

  it('2: clicking a disabled button fails fast with a one-line error', async () => {
    await page.setContent('<button id="b" disabled>Submit</button><button id="a" aria-disabled="true">Post</button>');
    for (const [sel, re] of [['#b', /^target is disabled \(button 'Submit'\)$/], ['#a', /^target is disabled \(button 'Post'\)$/]]) {
      const t0 = Date.now();
      await assert.rejects(actFast(page, { action: 'click', selector: sel }), (e) => re.test(e.message));
      assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0} ms`);
    }
  });

  it('2b: a button that enables within the short wait is clicked', async () => {
    await page.setContent(`<button id="b" disabled onclick="window.__c=1">Go</button>
      <script>setTimeout(() => { document.getElementById('b').disabled = false; }, 60);</script>`);
    const r = await actFast(page, { action: 'click', selector: '#b' });
    assert.equal(r.ok, true);
    assert.equal(await page.evaluate(() => window.__c), 1);
  });

  it('2c: error messages lose ANSI codes and the call log; batch and tool errors too', async () => {
    const raw = 'locator.click: Timeout 8000ms exceeded.\n\u001b[2mCall log:\u001b[22m\n  \u001b[2m- waiting for locator(\'#x\')\u001b[22m\n  - element is not visible\n  - retrying click action';
    assert.equal(cleanErrorMessage(raw), "locator.click: Timeout 8000ms exceeded.\nretrying click action");
    assert.equal(cleanErrorMessage('plain \u001b[31mred\u001b[0m'), 'plain red');
    await page.setContent('<button id="b" disabled>Submit</button>');
    const r = await batchActions(page, [{ action: 'click', selector: '#b' }], { continueOnError: true });
    assert.match(JSON.stringify(r), /target is disabled/);
    await assert.rejects(
      dispatchToolCall(m, 'act_fast', { action: 'click', selector: '#missing', timeoutMs: 300 }),
      (e) => !/\u001b|Call log/.test(e.message) && e.message.split('\n').length <= 2,
    );
  });

  it('3: wait text matches placeholder, aria-label or value when no visible text does; visible text still first', async () => {
    await page.setContent(`<textarea placeholder="Add a comment"></textarea><input aria-label="Search docs"><input value="prefilled-x">
      <span id="t">Visible words</span><input type="hidden" placeholder="Hidden ph">`);
    for (const text of ['Add a comment', 'search docs', 'prefilled-x', 'nothing here|Add a comment']) {
      const r = await actFast(page, { action: 'wait', text, timeoutMs: 1000 });
      assert.equal(r.ok, true, text);
    }
    assert.equal((await actFast(page, { action: 'wait', text: 'Visible words', timeoutMs: 1000 })).ok, true);
    await assert.rejects(actFast(page, { action: 'wait', text: 'Hidden ph', timeoutMs: 300 }));
    await page.setContent('<div id="h"></div>');
    await page.evaluate(() => setTimeout(() => { document.getElementById('h').innerHTML = '<input placeholder="Late field">'; }, 200));
    assert.equal((await actFast(page, { action: 'wait', text: 'Late field', timeoutMs: 2000 })).ok, true);
  });

  it('4: splash settle stays inside its budget and is skipped unless waitUntil is load', async () => {
    await page.setContent('<body><script src="data:text/javascript,0"></script></body>');
    const t0 = Date.now();
    const ms = await settleSplash(page, 600);
    assert.ok(ms <= 600, `reported ${ms}`);
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}`);
    const { navHealth } = await import('../src/navinfo.mjs');
    const t1 = Date.now();
    const out = await navHealth(page, null, 'about:blank', 'x', { waitUntil: 'domcontentloaded' });
    assert.equal(out.settledMs, undefined);
    assert.ok(Date.now() - t1 < 800);
  });
});
