// Round 19c: ref numbering is scoped to the tab, so an iframe that navigates cannot reuse an old ref number either.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, inspectCompact } from '../src/dom-engine.mjs';

describe('round 19c', () => {
  let m, page;
  before(async () => { m = new BrowserManager({ mode: 'launch', headless: true }); ({ page } = await m.getPage()); });
  after(async () => { await m?.close().catch(() => {}); });
  it('a navigated iframe gets refs above the old ones and the old ref fails', async () => {
    const many = (p, n) => Array.from({ length: n }, (_, i) => `<button onclick="parent.document.title='hit ${p}'">${p} ${i}</button>`).join('');
    await page.setContent(`<body><iframe id="f" srcdoc="${many('A', 10).replace(/"/g, '&quot;')}"></iframe></body>`);
    await page.waitForTimeout(300);
    const state = new Set();
    const first = await inspectCompact(page, { maxChars: 20000 }, state);
    const old = /\[(f1:e\d+)\] <button> "A 5"/.exec(first.text)?.[1];
    assert.ok(old, first.text);
    await page.evaluate((html) => { document.getElementById('f').srcdoc = html; }, many('B', 30));
    await page.waitForTimeout(400);
    const second = await inspectCompact(page, { maxChars: 20000 }, state);
    const nums = [...second.text.matchAll(/\[f1:e(\d+)\] <button> "B/g)].map((x) => Number(x[1]));
    assert.ok(nums.length >= 30 && Math.min(...nums) > Number(old.split('e')[1]), second.text.slice(0, 300));
    await assert.rejects(actFast(page, { action: 'click', ref: old }), /not found/i);
    assert.doesNotMatch(await page.title(), /hit/);
  });
});
