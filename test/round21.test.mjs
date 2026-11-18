// Round 21: content fingerprints on refs detect recycled DOM nodes in virtualized lists.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, batchActions, inspectCompact, smartFillForm } from '../src/dom-engine.mjs';

const refOf = (text, label) => {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(String.raw`\[(f\d+:e\d+)\] <[^>]+> "${esc}"`).exec(text);
  return m ? m[1] : null;
};

describe('round 21: recycled nodes in virtualized lists', () => {
  let m;
  let page;

  before(async () => {
    m = new BrowserManager({ mode: 'launch', headless: true });
    ({ page } = await m.getPage());
  });

  after(async () => {
    await m?.close?.().catch(() => {});
  });

  it('1: 10k-row virtualized list (~30 reused row nodes): scrolling one viewport makes an off-screen ref fail instead of acting on the new row; fresh snapshot makes it work', async () => {
    await page.setContent(`
      <div id="vp" style="height:300px;overflow-y:auto;position:relative;border:1px solid #ccc;">
        <div id="spacer" style="height:300000px;position:relative;"></div>
      </div>
      <script>
        const TOTAL = 10000;
        const ROW_H = 30;
        const POOL = 30;
        const vp = document.getElementById('vp');
        const spacer = document.getElementById('spacer');
        window.__clickedRow = null;
        const pool = Array.from({ length: POOL }, () => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.style.cssText = 'position:absolute;left:0;right:0;height:28px;display:block;width:100%;';
          btn.addEventListener('click', () => {
            window.__clickedRow = Number(btn.dataset.row);
          });
          spacer.appendChild(btn);
          return btn;
        });
        function render() {
          const start = Math.min(TOTAL - POOL, Math.max(0, Math.floor(vp.scrollTop / ROW_H)));
          for (let i = 0; i < POOL; i++) {
            const idx = start + i;
            const el = pool[i];
            el.dataset.row = String(idx);
            el.style.top = (idx * ROW_H) + 'px';
            el.textContent = 'Row ' + idx + ' - Item #' + idx;
          }
        }
        vp.addEventListener('scroll', render);
        render();
      </script>
    `);

    const state = new Set();
    const first = await inspectCompact(page, { maxChars: 20000 }, state);
    const row0Ref = refOf(first.text, 'Row 0 - Item #0');
    assert.ok(row0Ref, first.text);

    // Scroll one viewport (300px = 10 rows): pool[0] keeps its data-tbm-ref attribute but now renders Row 10.
    await page.evaluate(() => {
      const vp = document.getElementById('vp');
      vp.scrollTop = 300;
      vp.dispatchEvent(new Event('scroll'));
    });

    await assert.rejects(
      actFast(page, { action: 'click', ref: row0Ref }),
      new RegExp(
        `^Error: Element ref "${row0Ref}" now shows different content \\(the node was reused, e\\.g\\. a virtualized list scrolled\\)\\. Run inspect_compact again\\.$`
      )
    );
    assert.equal(await page.evaluate(() => window.__clickedRow), null);

    // Re-reporting the node in a fresh snapshot refreshes its fingerprint so clicking works.
    const second = await inspectCompact(page, { maxChars: 20000 }, state);
    const row10Ref = refOf(second.text, 'Row 10 - Item #10');
    assert.equal(row10Ref, row0Ref);
    await actFast(page, { action: 'click', ref: row10Ref });
    assert.equal(await page.evaluate(() => window.__clickedRow), 10);
  });

  it('2: a button whose label changes after a click works once the onlyChanged delta has been read', async () => {
    await page.setContent(`
      <button id="like" type="button" onclick="this.dataset.n = Number(this.dataset.n || 0) + 1; this.textContent = 'Likes: ' + this.dataset.n">Likes: 0</button>
    `);
    const state = new Set();
    const s1 = await inspectCompact(page, {}, state);
    const btnRef = refOf(s1.text, 'Likes: 0');
    assert.ok(btnRef, s1.text);

    await actFast(page, { action: 'click', ref: btnRef });
    assert.equal(await page.locator('#like').textContent(), 'Likes: 1');

    // Before the delta is read, the stored fingerprint is still "Likes: 0".
    await assert.rejects(
      actFast(page, { action: 'click', ref: btnRef }),
      new RegExp(`^Error: Element ref "${btnRef}" now shows different content`)
    );

    const delta = await inspectCompact(page, { onlyChanged: true }, state);
    assert.match(delta.text, new RegExp(`\\[${btnRef}\\] <button> "Likes: 1"`));

    await actFast(page, { action: 'click', ref: btnRef });
    assert.equal(await page.locator('#like').textContent(), 'Likes: 2');
  });

  it('3: typing into input, textarea, contenteditable and role=textbox after their value changed still works', async () => {
    await page.setContent(`
      <input id="inp" aria-label="Username" value="alice" />
      <textarea id="ta" aria-label="Bio">Hello</textarea>
      <div id="ce" contenteditable="true" aria-label="Notes">First note</div>
      <div id="tb" role="textbox" contenteditable="true" aria-label="Comment">Draft</div>
    `);
    const state = new Set();
    const snap = await inspectCompact(page, {}, state);
    const inpRef = refOf(snap.text, 'Username');
    const taRef = refOf(snap.text, 'Bio');
    const ceRef = refOf(snap.text, 'Notes');
    const tbRef = refOf(snap.text, 'Comment');
    assert.ok(inpRef && taRef && ceRef && tbRef, snap.text);

    await actFast(page, { action: 'fill', ref: inpRef, value: 'bob' });
    await actFast(page, { action: 'type', ref: inpRef, value: '123', slowly: true }); // slowly:false replaces the value by design
    assert.equal(await page.locator('#inp').inputValue(), 'bob123');

    await actFast(page, { action: 'fill', ref: taRef, value: 'Updated bio' });
    await actFast(page, { action: 'fill', ref: taRef, value: 'Final bio' });
    assert.equal(await page.locator('#ta').inputValue(), 'Final bio');

    await actFast(page, { action: 'type', ref: ceRef, value: ' more' });
    await actFast(page, { action: 'type', ref: ceRef, value: ' text' });
    assert.match(await page.locator('#ce').textContent(), /more text/);

    await actFast(page, { action: 'type', ref: tbRef, value: ' v2' });
    await actFast(page, { action: 'type', ref: tbRef, value: ' v3' });
    assert.match(await page.locator('#tb').textContent(), /v2 v3/);
  });

  it('4: batch_actions and smart_fill_form check each ref before its own step', async () => {
    await page.setContent(`
      <button id="step1" type="button" onclick="window.__s1 = true; document.getElementById('step2').textContent = 'Row 99'">Step 1</button>
      <button id="step2" type="button" onclick="window.__s2 = true">Row 2</button>
      <div id="sw1" role="switch" aria-checked="false" tabindex="0" onclick="this.setAttribute('aria-checked','true'); document.getElementById('sw2').textContent = 'Recycled Switch'">Switch 1</div>
      <div id="sw2" role="switch" aria-checked="false" tabindex="0" onclick="this.setAttribute('aria-checked','true')">Switch 2</div>
    `);
    const state = new Set();
    const snap = await inspectCompact(page, {}, state);
    const ref1 = refOf(snap.text, 'Step 1');
    const ref2 = refOf(snap.text, 'Row 2');
    const sw1 = refOf(snap.text, 'Switch 1');
    const sw2 = refOf(snap.text, 'Switch 2');
    assert.ok(ref1 && ref2 && sw1 && sw2, snap.text);

    const batchRes = await batchActions(page, [
      { action: 'click', ref: ref1 },
      { action: 'click', ref: ref2 },
    ]);
    assert.equal(batchRes.completed, 1);
    assert.equal(
      batchRes.error,
      `Element ref "${ref2}" now shows different content (the node was reused, e.g. a virtualized list scrolled). Run inspect_compact again.`
    );
    assert.equal(await page.evaluate(() => Boolean(window.__s1)), true);
    assert.equal(await page.evaluate(() => Boolean(window.__s2)), false);

    await assert.rejects(
      smartFillForm(page, {
        fields: [
          { ref: sw1, value: true },
          { ref: sw2, value: true },
        ],
      }),
      new RegExp(
        `^Error: Element ref "${sw2}" now shows different content \\(the node was reused, e\\.g\\. a virtualized list scrolled\\)\\. Run inspect_compact again\\.$`
      )
    );
    assert.equal(await page.locator('#sw1').getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('#sw2').getAttribute('aria-checked'), 'false');
  });
});
