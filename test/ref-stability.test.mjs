// Refs never recycle within a document: a stale ref fails with not-found instead of hitting another element.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, inspectCompact } from '../src/dom-engine.mjs';

const refOf = (text, label) => {
  const m = new RegExp(String.raw`\[(f0:e\d+)\] <button> "${label}"`).exec(text);
  return m ? m[1] : null;
};
const maxRef = (text) => Math.max(0, ...[...text.matchAll(/\[f0:e(\d+)\]/g)].map((x) => Number(x[1])));
const clickFails = async (page, ref) => {
  try {
    const r = await actFast(page, { action: 'click', ref });
    return JSON.stringify(r);
  } catch (e) {
    return e.message;
  }
};

describe('ref stability within a document', () => {
  let m;
  let page;
  before(async () => {
    m = new BrowserManager({ mode: 'launch', headless: true });
    ({ page } = await m.getPage());
  });
  after(async () => {
    await m.close?.();
  });

  it('1: a removed element ref is not reused; its click fails with not-found', async () => {
    const html = Array.from({ length: 14 }, (_, i) => `<button id="b${i}">Btn ${i}</button>`).join('');
    await page.setContent(`<body>${html}</body>`);
    const state = new Set();
    const first = await inspectCompact(page, { maxChars: 20000 }, state);
    const prevMax = maxRef(first.text);
    const gone = refOf(first.text, 'Btn 11');
    assert.ok(gone, first.text);
    await page.evaluate(() => {
      document.getElementById('b11').remove();
      const n = document.createElement('button');
      n.id = 'fresh';
      n.textContent = 'Fresh';
      document.body.prepend(n);
    });
    const second = await inspectCompact(page, { maxChars: 20000 }, state);
    const freshRef = refOf(second.text, 'Fresh');
    assert.ok(freshRef, second.text);
    assert.ok(Number(freshRef.split(':e')[1]) > prevMax, `${freshRef} <= ${prevMax}`);
    assert.notEqual(freshRef, gone);
    assert.doesNotMatch(second.text, /refs shifted/);
    const msg = await clickFails(page, gone);
    assert.match(msg, /not found/i, msg);
  });

  it('2: 140 buttons, remove one, reorder: survivors keep refs and clicks hit the same element', async () => {
    const html = Array.from({ length: 140 }, (_, i) => `<button id="b${i}" onclick="window.__hit='b${i}'">Item ${i}</button>`).join('');
    await page.setContent(`<body>${html}</body>`);
    const state = new Set();
    const first = await inspectCompact(page, { maxChars: 60000 }, state);
    const before = new Map();
    for (let i = 0; i < 140; i++) before.set(i, refOf(first.text, `Item ${i}`));
    assert.ok([...before.values()].every(Boolean), 'all 140 listed');
    await page.evaluate(() => {
      document.getElementById('b70').remove();
      const kids = [...document.body.children].reverse();
      for (const k of kids) document.body.appendChild(k);
    });
    const second = await inspectCompact(page, { maxChars: 60000 }, state);
    for (let i = 0; i < 140; i++) {
      if (i === 70) continue;
      assert.equal(refOf(second.text, `Item ${i}`), before.get(i), `Item ${i}`);
    }
    await actFast(page, { action: 'click', ref: before.get(33) });
    assert.equal(await page.evaluate(() => window.__hit), 'b33');
    assert.match(await clickFails(page, before.get(70)), /not found/i);
  });

  it('3: after a real navigation numbering continues above the old marks and old refs fail with a navigated hint', async () => {
    const html = Array.from({ length: 20 }, (_, i) => `<button>Old ${i}</button>`).join('');
    await page.goto(`data:text/html,<body>${encodeURIComponent(html)}</body>`);
    const state = new Set();
    const first = await inspectCompact(page, { maxChars: 20000 }, state);
    const old = refOf(first.text, 'Old 17');
    assert.ok(old);
    // The new document has 40 buttons, so a restarted counter would give "New 17" the same number as the old ref.
    const html2 = Array.from({ length: 40 }, (_, i) => `<button onclick="document.title='clicked ' + this.textContent">New ${i}</button>`).join('');
    await page.goto(`data:text/html,<title>t</title><body>${encodeURIComponent(html2)}</body>`);
    const second = await inspectCompact(page, { maxChars: 20000 }, state);
    assert.notEqual(refOf(second.text, 'New 17'), old);
    assert.ok(Math.min(...[...second.text.matchAll(/\[f0:e(\d+)\]/g)].map((m) => Number(m[1]))) > Number(/e(\d+)$/.exec(old)[1]));
    assert.match(await clickFails(page, old), /navigated or re-rendered since this ref was issued|belongs to a previous document/i);
    assert.equal(await page.title(), 't', 'no button was clicked');
  });
});
