// Local fixtures only; launch a private browser without attaching to debugging ports.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, inspectCompact, smartFillForm } from '../src/dom-engine.mjs';

const THREE_PHONES_HTML = [
  '<form>',
  '<div class="row"><input aria-label="Phone"></div>',
  '<div class="row"><input aria-label="Phone"></div>',
  '<div class="row"><input aria-label="Phone"></div>',
  '</form>',
].join('');

describe('night 19-11: clone group size shifts vs swaps', () => {
  let m, page;
  before(async () => {
    m = new BrowserManager({ mode: 'launch', headless: true });
    ({ page } = await m.getPage());
  });
  after(async () => { await m?.close(); });

  const refsForInputs = (count) =>
    Promise.all(
      Array.from({ length: count }, async (_, i) => 'f0:' + await page.locator('input').nth(i).getAttribute('data-tbm-ref'))
    );

  it('fills surviving rows by old refs after deleting row 1 of 3 with one 3 -> 2 note', async () => {
    await page.setContent(THREE_PHONES_HTML);
    await inspectCompact(page, {}, new Set());
    const refs = await refsForInputs(3);
    await page.evaluate(() => document.querySelector('.row').remove());

    const r2 = await actFast(page, { action: 'fill', ref: refs[1], value: '222-0002' });
    const r3 = await actFast(page, { action: 'fill', ref: refs[2], value: '333-0003' });
    const notes = [r2.note, r3.note].filter(Boolean);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /clone group for (?:f0:)?e\d+ changed size \(3 -> 2\)/);
    assert.deepEqual(
      await page.locator('input').evaluateAll((els) => els.map((el) => el.value)),
      ['222-0002', '333-0003']
    );

    await page.setContent(THREE_PHONES_HTML);
    await inspectCompact(page, {}, new Set());
    const formRefs = await refsForInputs(3);
    await page.evaluate(() => document.querySelector('.row').remove());

    const res = await smartFillForm(page, {
      fields: [
        { ref: formRefs[1], value: '444-0002' },
        { ref: formRefs[2], value: '555-0003' },
      ],
    });
    assert.match(res.note || '', /clone group for (?:f0:)?e\d+ changed size \(3 -> 2\)/);
    assert.deepEqual(
      await page.locator('input').evaluateAll((els) => els.map((el) => el.value)),
      ['444-0002', '555-0003']
    );
  });

  it('still rejects straight swap of two clones when the group count is unchanged', async () => {
    await page.setContent(THREE_PHONES_HTML);
    await inspectCompact(page, {}, new Set());
    const refs = await refsForInputs(3);
    await page.evaluate(() => {
      const [first, second] = document.querySelectorAll('input');
      first.value = 'kept-1';
      second.value = 'kept-2';
      const marker = document.createComment('swap');
      first.replaceWith(marker);
      second.replaceWith(first);
      marker.replaceWith(second);
    });

    for (const ref of [refs[0], refs[1]]) {
      await assert.rejects(actFast(page, { action: 'fill', ref, value: 'wrong' }), /now points to a different field/);
      await assert.rejects(smartFillForm(page, { fields: [{ ref, value: 'wrong' }] }), /now points to a different field/);
    }
    assert.deepEqual(
      await page.locator('input').evaluateAll((els) => els.map((el) => el.value)),
      ['kept-2', 'kept-1', '']
    );
  });

  it('keeps old refs working when a fourth row is added and reports note 3 -> 4', async () => {
    await page.setContent(THREE_PHONES_HTML);
    await inspectCompact(page, {}, new Set());
    const refs = await refsForInputs(3);
    await page.evaluate(() => {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = '<input aria-label="Phone">';
      document.querySelector('form').appendChild(row);
    });

    const a0 = await actFast(page, { action: 'fill', ref: refs[0], value: '111-0001' });
    const a1 = await actFast(page, { action: 'fill', ref: refs[1], value: '222-0002' });
    const a2 = await smartFillForm(page, { fields: [{ ref: refs[2], value: '333-0003' }] });
    const notes = [a0.note, a1.note, a2.note].filter(Boolean);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /clone group for (?:f0:)?e\d+ changed size \(3 -> 4\)/);
    assert.deepEqual(
      await page.locator('input').evaluateAll((els) => els.map((el) => el.value)),
      ['111-0001', '222-0002', '333-0003', '']
    );
  });
});
