// Wikipedia-style markup and deterministic hydration; no network or shared Chrome.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, inspectCompact, smartFillForm } from '../src/dom-engine.mjs';
import { dispatchToolCall } from '../src/index.mjs';

const searchForm = (id) => `
  <form>
    <label for="${id}" style="position:absolute;clip:rect(0,0,0,0);width:1px;height:1px;overflow:hidden">Search Wikipedia</label>
    <input type="search" name="search" id="${id}" accesskey="f" title="Search Wikipedia [f]"
      aria-label="Search Wikipedia" placeholder="Search Wikipedia" autocomplete="off">
    <input type="hidden" name="title" value="Special:Search">
  </form>`;
const fixture = `<main>${searchForm('searchInput')}</main>
  <header id="sticky" hidden>${searchForm('stickySearchInput')}</header>`;

describe('night 19-11: Wikipedia search accesskey hydration', () => {
  let manager, page;
  before(async () => {
    manager = new BrowserManager({ mode: 'launch', headless: true });
    ({ page } = await manager.getPage());
  });
  after(async () => { await manager?.close(); });

  const inspectSearch = async () => {
    const snapshot = await inspectCompact(page, { query: 'Search' }, new Set());
    const ref = snapshot.text.match(/\[(f\d+:e\d+)\] <input:search>/)?.[1];
    assert.ok(ref, snapshot.text);
    return ref;
  };

  it('inspect -> evaluate -> type -> smart fill survives shortcut hydration and sticky search visibility', async () => {
    await page.setContent(fixture);
    const ref = await inspectSearch();
    for (const hint of ['alt-f', 'alt-shift-f', 'ctrl-option-f', 'f']) {
      await page.locator('#searchInput').evaluate((el, hint) => {
        el.title = `Search Wikipedia [${hint}]`;
        document.querySelector('#sticky').hidden = false;
      }, hint);
      const result = await dispatchToolCall(manager, 'evaluate_js', { ref, expression: '(el) => el.name' });
      assert.match(result.text, /search/);
      const previousValue = await page.locator('#searchInput').inputValue();
      await dispatchToolCall(manager, 'act_fast', { action: 'type', ref, value: 'Model Context Protocol' });
      assert.equal(await page.locator('#searchInput').inputValue(), previousValue + 'Model Context Protocol');
      await smartFillForm(page, { fields: [{ ref, value: 'Wikipedia' }] });
      assert.equal(await page.locator('#searchInput').inputValue(), 'Wikipedia');
    }
    assert.equal(await page.locator('#stickySearchInput').inputValue(), '');
    assert.deepEqual(await page.locator('input[type=hidden]').evaluateAll(els => els.map(el => el.value)),
      ['Special:Search', 'Special:Search']);
  });

  it('still refuses a reused search field and meaningful title changes', async () => {
    for (const change of ['field', 'title', 'unrelated hint', 'no accesskey']) {
      await page.setContent(fixture);
      if (change === 'no accesskey') await page.locator('#searchInput').evaluate(el => el.removeAttribute('accesskey'));
      const ref = await inspectSearch();
      await page.locator('#searchInput').evaluate((el, change) => {
        el.value = 'kept';
        if (change === 'field') el.name = 'email';
        else if (change === 'title') el.title = 'Search private messages [alt-f]';
        else if (change === 'unrelated hint') el.title = 'Search Wikipedia [alt-g]';
        else el.title = 'Search Wikipedia [alt-f]';
      }, change);
      await assert.rejects(actFast(page, { action: 'type', ref, value: 'wrong' }), /now points to a different field/);
      await assert.rejects(smartFillForm(page, { fields: [{ ref, value: 'wrong' }] }), /now points to a different field/);
      assert.equal(await page.locator('#searchInput').inputValue(), 'kept');
    }
  });

  it('still refuses a same-size clone swap after shortcut normalization', async () => {
    await page.setContent(`<main>${searchForm('searchInput')}${searchForm('searchInput')}</main>`);
    await page.locator('input[type=search]').nth(1).evaluate(el => { el.title = 'Search Wikipedia [alt-shift-f]'; });
    const ref = await inspectSearch();
    await page.locator('main').evaluate(main => main.prepend(main.lastElementChild));
    await assert.rejects(actFast(page, { action: 'type', ref, value: 'wrong' }), /now points to a different field/);
    await assert.rejects(smartFillForm(page, { fields: [{ ref, value: 'wrong' }] }), /now points to a different field/);
    assert.deepEqual(await page.locator('input[type=search]').evaluateAll(els => els.map(el => el.value)), ['', '']);
  });
});
