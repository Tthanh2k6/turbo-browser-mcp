// Night 19-11: act_fast select accepts `option` (visible text, like smart_fill_form) and points ARIA comboboxes to smart_fill_form.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { dispatchToolCall } from '../src/index.mjs';

describe('night 19-11 select option', () => {
  let m;
  before(async () => {
    m = new BrowserManager({ mode: 'launch', headless: true });
    await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'open', url: 'about:blank' }] });
    const { page } = await m.getPage();
    await page.setContent(`
      <label for="c">Country</label><select id="c"><option value="vn">Viet Nam</option><option value="jp">Japan</option></select>
      <label id="fl">Fruit</label><div role="combobox" aria-labelledby="fl" tabindex="0">Choose</div>`);
  });
  after(async () => { await m?.close().catch(() => {}); });

  it('selects a native option by its visible text through option', async () => {
    const out = (await dispatchToolCall(m, 'act_fast', { action: 'select', selector: '#c', option: 'Japan' })).text;
    assert.match(out, /"ok":true/);
    const { page } = await m.getPage();
    assert.equal(await page.$eval('#c', (el) => el.value), 'jp');
  });

  it('value and label keep working', async () => {
    await dispatchToolCall(m, 'act_fast', { action: 'select', selector: '#c', value: 'vn' });
    const { page } = await m.getPage();
    assert.equal(await page.$eval('#c', (el) => el.value), 'vn');
  });

  it('an ARIA combobox gets a hint to use smart_fill_form', async () => {
    await assert.rejects(
      dispatchToolCall(m, 'act_fast', { action: 'select', selector: '[role=combobox]', option: 'Banana' }),
      /smart_fill_form/,
    );
  });
});
