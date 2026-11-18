// Local fixtures only; launch a private browser without attaching to debugging ports.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, inspectCompact, smartFillForm } from '../src/dom-engine.mjs';

describe('round 24b: clone field identities', () => {
  let m, page;
  before(async () => {
    m = new BrowserManager({ mode: 'launch', headless: true });
    ({ page } = await m.getPage());
  });
  after(async () => { await m?.close(); });
  const refFor = async (selector) => 'f0:' + await page.locator(selector).getAttribute('data-tbm-ref');

  for (const [name, html, value] of [
    ['Phone inputs in separate sections', '<form><section><h2>Home</h2><input aria-label="Phone" value="kept"></section><section><h2>Work</h2><input aria-label="Phone" value="kept"></section></form>', '123'],
    ['start/end dates', '<form><input type="date" aria-label="Date" value="2026-11-18"><input type="date" aria-label="Date" value="2026-11-18"></form>', '2026-11-19'],
  ]) {
    it('rejects old refs after swapping ' + name, async () => {
      await page.setContent(html);
      await inspectCompact(page, {}, new Set());
      const refs = await Promise.all([0, 1].map(async (i) => 'f0:' + await page.locator('input').nth(i).getAttribute('data-tbm-ref')));
      const beforeValues = await page.locator('input').evaluateAll((els) => els.map((el) => el.value));
      await page.evaluate(() => {
        const [first, second] = document.querySelectorAll('input');
        const marker = document.createComment('swap');
        first.replaceWith(marker);
        second.replaceWith(first);
        marker.replaceWith(second);
      });
      for (const ref of refs) {
        await assert.rejects(actFast(page, { action: 'fill', ref, value }), /now points to a different field/);
        await assert.rejects(smartFillForm(page, { fields: [{ ref, value }] }), /now points to a different field/);
      }
      assert.deepEqual(await page.locator('input').evaluateAll((els) => els.map((el) => el.value)), beforeValues);
      await inspectCompact(page, {}, new Set());
      await actFast(page, { action: 'fill', ref: refs[0], value });
      assert.equal(await page.locator('input').nth(1).inputValue(), value);
    });
  }

  for (const attr of ['aria-label', 'placeholder', 'title']) {
    it('ignores changing counters in ' + attr + ' but detects changed words', async () => {
      await page.setContent('<input id="field" ' + attr + '="Progress (3 of 7) 12/160" value="kept">');
      await inspectCompact(page, {}, new Set());
      const ref = await refFor('#field');
      await page.locator('#field').evaluate((el, attr) => el.setAttribute(attr, 'Progress (4 of 7) 123/160'), attr);
      await actFast(page, { action: 'fill', ref, value: 'first' });
      await smartFillForm(page, { fields: [{ ref, value: 'second' }] });
      assert.equal(await page.locator('#field').inputValue(), 'second');
      await page.locator('#field').evaluate((el, attr) => el.setAttribute(attr, 'Different field (4 of 7)'), attr);
      await assert.rejects(actFast(page, { action: 'fill', ref, value: 'wrong' }), /now points to a different field/);
    });
  }

  it('keeps a lone field stable when unrelated controls are inserted elsewhere', async () => {
    await page.setContent('<form><section><input name="phone" aria-label="Phone"></section><section id="other"></section></form>');
    await inspectCompact(page, {}, new Set());
    const ref = await refFor('input');
    await page.locator('#other').evaluate((el) => {
      el.innerHTML = '<input name="email" aria-label="Email"><input name="address" aria-label="Address">';
      el.parentNode.prepend(el);
    });
    await actFast(page, { action: 'fill', ref, value: '123' });
    await smartFillForm(page, { fields: [{ ref, value: '456' }] });
    assert.equal(await page.locator('[name="phone"]').inputValue(), '456');
  });

  it('uses the nearest matching ancestor and ignores unrelated fields in the clone index', async () => {
    await page.setContent('<form><section id="local"><input name="address"><input name="address"></section><section id="other"><input name="address"></section></form>');
    await inspectCompact(page, {}, new Set());
    const ref = await refFor('#local input:nth-child(2)');
    await page.evaluate(() => {
      const unrelated = document.createElement('input');
      unrelated.name = 'email';
      document.querySelector('#local').prepend(unrelated);
      const other = document.querySelector('#other');
      other.parentNode.prepend(other);
    });
    await actFast(page, { action: 'fill', ref, value: 'line two' });
    assert.equal(await page.locator('#local [name="address"]').nth(1).inputValue(), 'line two');
  });

  for (const attr of ['name', 'id']) {
    it('keeps digits significant in ' + attr, async () => {
      await page.setContent('<input ' + attr + '="field3" aria-label="Field">');
      await inspectCompact(page, {}, new Set());
      const ref = await refFor('input');
      await page.locator('input').evaluate((el, attr) => el.setAttribute(attr, 'field4'), attr);
      await assert.rejects(actFast(page, { action: 'fill', ref, value: 'wrong' }), /now points to a different field/);
    });
  }
});
