// Round 12: two bugs found on the public Selenium web-form demo page.
// 1. A <select> whose selected option is a placeholder counts as empty.
// 2. Values that a date-picker widget clears or reformats on blur are reported per field (and retyped once).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { batchActions, smartFillForm } from '../src/dom-engine.mjs';

let manager, page;
before(async () => {
  manager = new BrowserManager({ mode: 'launch', headless: true });
  ({ page } = await manager.getPage());
});
after(async () => { await manager?.close(); });

const sel = (opts, extra = '') => `<!doctype html><form><select name="s" ${extra}>${opts}</select><input name="other"></form>`;
const fillSel = async (html, field = { selector: 'select[name=s]', option: 'Two' }, overwrite = false) => {
  await page.setContent(html);
  const r = await smartFillForm(page, { fields: [field], overwrite });
  return { r, value: await page.$eval('select[name=s]', (e) => e.value) };
};

describe('round 12: placeholder selects count as empty', () => {
  const rest = '<option value="1">One</option><option value="2">Two</option><option value="3">Three</option>';
  const cases = {
    'selenium: selected option without value': `<option selected>Open this select menu</option>${rest}`,
    'empty value': `<option value="">Pick one</option>${rest}`,
    'empty value no prompt text': `<option value=""></option>${rest}`,
    'Select... text with value': `<option value="x" selected>Select...</option>${rest}`,
    'Choose text': `<option value="x" selected>Choose an option</option>${rest}`,
    'dashes': `<option value="x" selected>-- pick --</option>${rest}`,
    'Vietnamese': `<option value="x" selected>Chọn tỉnh</option>${rest}`,
    'Please select': `<option value="x" selected>Please select</option>${rest}`,
    'disabled first option': `<option value="x" disabled selected>Country</option>${rest}`,
    'hidden first option': `<option value="x" hidden selected>Country</option>${rest}`,
  };
  for (const [name, opts] of Object.entries(cases)) {
    it(`fills over ${name}`, async () => {
      const { r, value } = await fillSel(sel(opts));
      assert.equal(r.filledCount, 1, JSON.stringify(r));
      assert.equal(value, '2');
    });
  }

  it('skips a real current value that already equals the requested option', async () => {
    const { r, value } = await fillSel(sel('<option value="1">One</option><option value="2" selected>Two</option>'));
    assert.equal(r.filledCount, 0);
    assert.equal(r.skipped[0].reason, 'already-filled');
    assert.equal(value, '2');
  });

  it('skips a different real value and names it so the caller can pass overwrite', async () => {
    const { r, value } = await fillSel(sel('<option value="1" selected>One</option><option value="2">Two</option>'));
    assert.equal(r.filledCount, 0);
    assert.equal(r.skipped[0].reason, 'already-filled (has One)');
    assert.equal(value, '1');
  });

  it('overwrite still replaces a real value', async () => {
    const { r, value } = await fillSel(sel('<option value="1" selected>One</option><option value="2">Two</option>'), { selector: 'select[name=s]', option: 'Two' }, true);
    assert.equal(r.filledCount, 1);
    assert.equal(value, '2');
  });
});

describe('round 12: values changed by a widget after blur', () => {
  const widget = (script) => `<!doctype html><form><input name="d" type="text"><input name="e" type="text"></form><script>(() => {
const d = document.querySelector('[name=d]'); ${script}})();</script>`;
  const CLEAR_UNPARSEABLE = widget(`d.addEventListener('blur', () => { if (d.value.includes('/')) d.value = ''; });`);
  // Accepts only what arrived through real key presses (like pickers that parse on keyup).
  const CLEAR_UNLESS_TYPED = widget(`d.addEventListener('keydown', (e) => { if (e.isTrusted) d._typed = true; });
    d.addEventListener('blur', () => { if (!d._typed) d.value = ''; });`);
  const REFORMAT = widget(`d.addEventListener('blur', () => { const p = d.value.split('/'); if (p.length === 3 && p[2].length === 4) d.value = p[2] + '-' + p[0] + '-' + p[1]; });`);
  const PLAIN = widget('');
  const run = async (html, tool) => {
    await page.setContent(html);
    return tool();
  };
  const fields = [{ selector: 'input[name=d]', value: '11/17/2026' }];

  it('smart_fill_form reports clearedAfterBlur when the widget empties the value', async () => {
    const r = await run(CLEAR_UNPARSEABLE, () => smartFillForm(page, { fields }));
    const f = r.filled.find((x) => x.idx === 0);
    assert.equal(f.clearedAfterBlur, true, JSON.stringify(r));
    assert.notEqual(f.retyped, true);
  });

  it('smart_fill_form retypes once and reports retyped when real typing is accepted', async () => {
    const r = await run(CLEAR_UNLESS_TYPED, () => smartFillForm(page, { fields }));
    const f = r.filled.find((x) => x.idx === 0);
    assert.equal(f.retyped, true, JSON.stringify(r));
    assert.equal(f.clearedAfterBlur, undefined);
    assert.equal(await page.inputValue('input[name=d]'), '11/17/2026');
    await page.click('input[name=e]');
    assert.equal(await page.inputValue('input[name=d]'), '11/17/2026');
  });

  it('smart_fill_form reports changedAfterBlur when the widget reformats the value', async () => {
    const r = await run(REFORMAT, () => smartFillForm(page, { fields }));
    const f = r.filled.find((x) => x.idx === 0);
    assert.equal(f.changedAfterBlur, '2026-11-17', JSON.stringify(r));
    assert.equal(f.clearedAfterBlur, undefined);
  });

  it('a normal input gets no extra flags', async () => {
    const r = await run(PLAIN, () => smartFillForm(page, { fields }));
    const f = r.filled[0];
    assert.equal(f.clearedAfterBlur, undefined);
    assert.equal(f.changedAfterBlur, undefined);
    assert.equal(f.retyped, undefined);
  });

  it('fill action reports the same three outcomes', async () => {
    let r = await run(CLEAR_UNPARSEABLE, () => batchActions(page, [{ action: 'fill', selector: 'input[name=d]', value: '11/17/2026' }]));
    assert.equal(r.results?.[0]?.clearedAfterBlur ?? r.steps?.[0]?.clearedAfterBlur, true, JSON.stringify(r));
    r = await run(CLEAR_UNLESS_TYPED, () => batchActions(page, [{ action: 'fill', selector: 'input[name=d]', value: '11/17/2026' }]));
    assert.equal((r.results ?? r.steps)[0].retyped, true, JSON.stringify(r));
    r = await run(REFORMAT, () => batchActions(page, [{ action: 'fill', selector: 'input[name=d]', value: '11/17/2026' }]));
    assert.equal((r.results ?? r.steps)[0].changedAfterBlur, '2026-11-17', JSON.stringify(r));
  });
});

describe('round 12: collect dedupes on whitespace-normalized text', () => {
  it('returns one item for two comments that differ only in whitespace, with the original text', async () => {
    await page.setContent(`<!doctype html><body><div class="p">ok rồi. \nCòn nữa</div><div class="p">ok rồi.\nCòn nữa</div><div class="p">khác hẳn</div></body>`);
    const r = await batchActions(page, [{ action: 'collect', selector: '.p', scrolls: 0 }]);
    const items = r.results[0].items;
    assert.equal(items.length, 2, JSON.stringify(items));
    assert.ok(items[0].startsWith('ok rồi.'));
    assert.equal(items[1], 'khác hẳn');
  });
});

describe('round 12: pickers that clear on an outside mousedown instead of blur', () => {
  const PAGE = `<!doctype html><form><div class="datepicker-wrap"><input name="my-date" type="text"></div><input name="e"></form><script>(() => {
const d = document.querySelector('[name=my-date]');
d.addEventListener('keydown', (e) => { if (e.isTrusted) d._typed = true; });
document.addEventListener('mousedown', () => { if (!d._typed) d.value = ''; });
})();</script>`;
  it('smart_fill_form detects the clearing and fixes it by typing', async () => {
    await page.setContent(PAGE);
    const r = await smartFillForm(page, { fields: [{ selector: 'input[name=my-date]', value: '11/17/2026' }] });
    assert.equal(r.filled[0].retyped, true, JSON.stringify(r));
    await page.mouse.click(5, 5);
    assert.equal(await page.inputValue('input[name=my-date]'), '11/17/2026');
  });
});
