// Offline regression tests for bugs found on real sites (httpbin forms, the-internet, react-select).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { inspectCompact, smartFillForm } from '../src/dom-engine.mjs';

const FORM = `<!doctype html><form onsubmit="return false">
<p><label><input type=radio name=size value=small> Small</label>
<label><input type=radio name=size value=medium> Medium</label>
<label><input type=radio name=size value=large> Large</label></p>
<p><label><input type=checkbox name=topping value=bacon> Bacon</label>
<label><input type=checkbox name=topping value=cheese> Cheese</label>
<label><input type=checkbox name=topping value=onion> Onion</label></p>
<input name=other><button type=submit>Order</button></form>`;

const checked = (page) =>
  page.evaluate(() => [...document.querySelectorAll('input:checked')].map((e) => `${e.name}=${e.value}`));

describe('real-site fixes', () => {
  let m;
  let page;
  before(async () => {
    m = new BrowserManager({ mode: 'launch', headless: true });
    ({ page } = await m.getPage());
  });
  after(async () => m.close());

  it('A: check true/false on a specific radio/checkbox selector', async () => {
    await page.setContent(FORM);
    const r = await smartFillForm(page, {
      fields: [
        { selector: 'input[name=size][value=medium]', check: true },
        { selector: 'input[name=topping][value=cheese]', check: true },
      ],
    });
    assert.equal(r.filledCount, 2, JSON.stringify(r));
    assert.deepEqual((await checked(page)).sort(), ['size=medium', 'topping=cheese']);
    await smartFillForm(page, { fields: [{ selector: 'input[name=topping][value=cheese]', check: false }] });
    assert.deepEqual(await checked(page), ['size=medium']);
  });

  it('A: check by label on a group selector', async () => {
    await page.setContent(FORM);
    const r = await smartFillForm(page, {
      fields: [
        { selector: 'input[name=size]', check: 'Large' },
        { selector: 'input[name=topping]', check: ['Bacon', 'Onion'] },
      ],
    });
    assert.equal(r.filledCount, 3, JSON.stringify(r));
    assert.deepEqual((await checked(page)).sort(), ['size=large', 'topping=bacon', 'topping=onion']);
  });

  it('B: fields without a target or matching nothing are reported in skipped', async () => {
    await page.setContent(FORM);
    const r = await smartFillForm(page, {
      fields: [{ ref: undefined, option: 'x' }, { value: 'x' }, { selector: '#nope', value: 'y' }, { keys: 'other', value: 'ok' }],
    });
    assert.equal(r.filledCount, 1, JSON.stringify(r));
    const by = Object.fromEntries(r.skipped.map((s) => [s.idx, s.reason]));
    assert.equal(by[0], 'no-target');
    assert.equal(by[1], 'no-target');
    assert.equal(by[2], 'not-found');
    assert.equal(by[3], undefined);
  });

  it('C: diagnostics collapse duplicates and hide preset-blocked requests', async () => {
    await page.setContent('<p>x</p>');
    await m.manageNetworkSession(undefined, { preset: 'no-images' });
    await page.setContent(
      '<body>' + '<img src="http://127.0.0.1:1/a.png">'.repeat(5) +
        '<script>for(let i=0;i<4;i++)console.error("boom")</script></body>'
    );
    await page.waitForTimeout(300);
    const d = await m.getDiagnostics(undefined, {});
    assert.equal(d.networkErrors.length, 0, JSON.stringify(d.networkErrors));
    assert.ok(d.blockedByPreset >= 1, JSON.stringify(d));
    assert.ok(!d.console.some((c) => /ERR_BLOCKED_BY_CLIENT/.test(c.text)));
    const boom = d.console.filter((c) => c.text === 'boom');
    assert.equal(boom.length, 1);
    assert.equal(boom[0].count, 4);
    const all = await m.getDiagnostics(undefined, { statusFilter: 'all', level: 'all' });
    assert.ok(all.requests.filter((r) => r.url.includes('127.0.0.1:1')).length >= 1);
    assert.ok(all.networkErrors.length >= 1, 'statusFilter=all still shows preset-blocked requests');
  });

  it('D: react-select style input shows as combobox with a readable label', async () => {
    await page.setContent(
      '<div><div>Select...</div><input id="react-select-3-input" role="combobox" aria-autocomplete="list" type="text"></div>'
    );
    const snap = await inspectCompact(page, { mode: 'forms', maxChars: 2000 }, new Set());
    assert.ok(/<input:combobox> "Select\.\.\."/.test(snap.text), snap.text);
  });
});
