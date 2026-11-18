// Round 22: identity fingerprints for recycled value controls.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, batchActions, inspectCompact, smartFillForm } from '../src/dom-engine.mjs';

const refOf = (text, label) => text.split('\n').find((line) => line.includes('> "' + label + '"'))?.match(/\[(f\d+:e\d+)\]/)?.[1];
const fieldError = (ref) => 'Element ref "' + ref + '" now points to a different field (its name, type or label changed, e.g. a virtualized form reused the node). Run inspect_compact again.';
const rejectsField = (promise, ref) => assert.rejects(promise, { message: fieldError(ref) });

describe('round 22: recycled value controls', () => {
  let m, page;
  before(async () => {
    m = new BrowserManager({ mode: 'launch', headless: true });
    ({ page } = await m.getPage());
  });
  after(async () => { await m?.close?.().catch(() => {}); });

  it('1: scrolling a reused input pool refuses the old field; a fresh snapshot allows filling', async () => {
    await page.setContent(`
      <div id="vp" style="height:150px;overflow:auto">
        <div id="pool" style="height:3000px;position:relative"></div>
      </div>
      <script>
        const vp = document.getElementById('vp');
        const pool = document.getElementById('pool');
        const rows = Array.from({ length: 5 }, (_, i) => {
          const row = document.createElement('div');
          row.style.cssText = 'position:absolute;height:30px';
          row.innerHTML = '<label for="field' + i + '"></label><input id="field' + i + '" value="kept">';
          pool.appendChild(row);
          return row;
        });
        function render() {
          const phone = vp.scrollTop >= 150;
          rows.forEach((row, i) => {
            row.style.top = (vp.scrollTop + i * 30) + 'px';
            const input = row.querySelector('input');
            input.name = (phone ? 'phone' : 'email') + i;
            input.type = phone ? 'tel' : 'email';
            input.setAttribute('aria-label', (phone ? 'Phone ' : 'Email ') + i);
            row.querySelector('label').textContent = (phone ? 'Phone ' : 'Email ') + i;
          });
        }
        vp.addEventListener('scroll', render);
        render();
      </script>
    `);
    const state = new Set();
    const snap = await inspectCompact(page, {}, state);
    const ref = refOf(snap.text, 'Email 0');
    assert.ok(ref, snap.text);
    await page.evaluate(() => {
      const vp = document.getElementById('vp');
      vp.scrollTop = 150;
      vp.dispatchEvent(new Event('scroll'));
    });
    await rejectsField(actFast(page, { action: 'fill', ref, value: 'wrong' }), ref);
    assert.equal(await page.locator('#field0').inputValue(), 'kept');
    const fresh = await inspectCompact(page, {}, state);
    assert.equal(refOf(fresh.text, 'Phone 0'), ref);
    await actFast(page, { action: 'fill', ref, value: '0123456789' });
    assert.equal(await page.locator('#field0').inputValue(), '0123456789');
  });

  it('2: input, textarea, contenteditable and role=textbox accept repeated typing', async () => {
    await page.setContent(`
      <input id="inp" aria-label="Username" value="alice">
      <textarea id="ta" aria-label="Bio">Hello</textarea>
      <div id="ce" contenteditable="true" aria-label="Notes">First note</div>
      <div id="tb" role="textbox" contenteditable="true" aria-label="Comment">Draft</div>
    `);
    const snap = await inspectCompact(page, {}, new Set());
    const refs = ['Username', 'Bio', 'Notes', 'Comment'].map((label) => refOf(snap.text, label));
    assert.ok(refs.every(Boolean), snap.text);
    await actFast(page, { action: 'fill', ref: refs[0], value: 'bob' });
    await actFast(page, { action: 'type', ref: refs[0], value: '123', slowly: true });
    assert.equal(await page.locator('#inp').inputValue(), 'bob123');
    await actFast(page, { action: 'fill', ref: refs[1], value: 'Updated bio' });
    await actFast(page, { action: 'fill', ref: refs[1], value: 'Final bio' });
    assert.equal(await page.locator('#ta').inputValue(), 'Final bio');
    for (const [i, id] of [[2, 'ce'], [3, 'tb']]) {
      await actFast(page, { action: 'type', ref: refs[i], value: ' more' });
      await actFast(page, { action: 'type', ref: refs[i], value: ' text' });
      assert.match(await page.locator('#' + id).textContent(), /more text/);
    }
  });

  it('3: an action changing a label requires reading the onlyChanged delta', async () => {
    await page.setContent(`
      <label id="lbl" for="field">Email</label><input id="field" value="kept">
      <button type="button" onclick="document.getElementById('lbl').textContent='Phone'">Relabel</button>
    `);
    const state = new Set();
    const snap = await inspectCompact(page, {}, state);
    const ref = refOf(snap.text, 'Email');
    assert.ok(ref, snap.text);
    const result = await batchActions(page, [
      { action: 'click', ref: refOf(snap.text, 'Relabel') },
      { action: 'fill', ref, value: 'wrong' },
    ]);
    assert.equal(result.completed, 1);
    assert.equal(result.error, fieldError(ref));
    assert.equal(await page.locator('#field').inputValue(), 'kept');
    await rejectsField(actFast(page, { action: 'fill', ref, value: 'wrong' }), ref);
    const delta = await inspectCompact(page, { onlyChanged: true }, state);
    assert.equal(refOf(delta.text, 'Phone'), ref);
    await actFast(page, { action: 'fill', ref, value: '123' });
    assert.equal(await page.locator('#field').inputValue(), '123');
  });

  it('4: smart_fill_form checks the second field after the first step recycles it', async () => {
    await page.setContent(`
      <input id="first" aria-label="First" oninput="document.getElementById('second').name='phone'">
      <input id="second" aria-label="Second" name="email" value="kept">
    `);
    const snap = await inspectCompact(page, {}, new Set());
    const first = refOf(snap.text, 'First'), second = refOf(snap.text, 'Second');
    assert.ok(first && second, snap.text);
    await rejectsField(smartFillForm(page, { fields: [
      { ref: first, value: 'filled' }, { ref: second, value: 'wrong' },
    ] }), second);
    assert.equal(await page.locator('#first').inputValue(), 'filled');
    assert.equal(await page.locator('#second').inputValue(), 'kept');
  });

  it('5: all three fingerprint copies agree, normalize identity, and exclude values', async () => {
    // Keep browser callbacks self-contained without eval in production (including CSP pages).
    const source = await readFile(new URL('../src/dom-engine.mjs', import.meta.url), 'utf8');
    const main = /function computeElementFingerprintInBrowser\(el\) \{([\s\S]*?)\n\}/.exec(source)?.[1];
    const copies = [...source.matchAll(/const fingerprintOf = \(el\) => \{([\s\S]*?)\n\s*\};/g)].map((m) => m[1]);
    assert.equal(copies.length, 2);
    const normalize = (body) => body.split('\n').map((line) => line.trim()).join('\n').trim();
    for (const copy of copies) assert.equal(normalize(copy), normalize(main));
    const fingerprint = new Function('el', main);
    await page.setContent(`
      <label for="field"> First   label </label><label for="field">Ignored label</label>
      <span id="a">ARIA first</span><span id="b">ARIA second</span>
      <input id="field" type="TEXT" name="  account   name " aria-label=" Stable "
        placeholder=" Hint " role="textbox" aria-labelledby="a b" value="old">
    `);
    const field = page.locator('#field');
    assert.equal(await field.evaluate(fingerprint),
      '#id:' + ['input', 'text', 'account name', 'field', 'Stable', 'Hint', 'textbox', 'First label'].join('\0'));
    const snap = await inspectCompact(page, {}, new Set());
    const ref = 'f0:' + await field.getAttribute('data-tbm-ref');
    assert.ok(snap.text.includes('[' + ref + ']'), snap.text);
    await actFast(page, { action: 'fill', ref, value: 'new' });
    await smartFillForm(page, { fields: [{ ref, value: 'newer' }] });
    await field.evaluate((el) => {
      el.name = 'account\nname';
      el.setAttribute('type', 'text');
      el.checked = true;
    });
    await actFast(page, { action: 'focus', ref });
    await page.locator('label').evaluateAll((labels) => labels.forEach((label) => label.remove()));
    assert.equal((await field.evaluate(fingerprint)).split('\0').at(-1), 'ARIA first ARIA second');
    await rejectsField(actFast(page, { action: 'focus', ref }), ref);
    await field.evaluate((el) => {
      el.name = 'x'.repeat(70);
      el.setAttribute('placeholder', 'a\0b');
    });
    const parts = (await field.evaluate(fingerprint)).slice(4).split('\0');
    assert.equal(parts.length, 8);
    assert.equal(parts[2], 'x'.repeat(64));
    assert.equal(parts[5], 'a b');
  });

  it('6: each identity component is checked through snapshot, act and form paths', async () => {
    for (const attr of ['type', 'name', 'id', 'aria-label', 'placeholder', 'role', 'label']) {
      await page.setContent('<label for="field">Label</label><input id="field" aria-label="Stable" value="kept">');
      const snap = await inspectCompact(page, {}, new Set());
      const ref = refOf(snap.text, 'Stable');
      assert.ok(ref, snap.text);
      await page.locator('input').evaluate((el, attr) => {
        if (attr === 'label') el.labels[0].textContent = 'Changed';
        else el.setAttribute(attr, attr === 'type' ? 'tel' : 'changed');
      }, attr);
      await rejectsField(actFast(page, { action: 'fill', ref, value: 'wrong' }), ref);
      await rejectsField(smartFillForm(page, { fields: [{ ref, value: 'wrong' }] }), ref);
      assert.equal(await page.locator('input').inputValue(), 'kept', attr);
    }
  });

  it('7: a live character counter inside the label does not trip the identity check', async () => {
    await page.setContent(`
      <label for="bio">Bio (<span id="n">0</span>/160)</label>
      <textarea id="bio" oninput="document.getElementById('n').textContent = this.value.length"></textarea>
    `);
    const snap = await inspectCompact(page, {}, new Set());
    const ref = refOf(snap.text, 'Bio (0/160)') || (/\[(f\d+:e\d+)\] <textarea>/.exec(snap.text) || [])[1];
    assert.ok(ref, snap.text);
    await actFast(page, { action: 'type', ref, value: 'hello', slowly: true });
    await actFast(page, { action: 'type', ref, value: ' world', slowly: true });
    assert.equal(await page.locator('#bio').inputValue(), 'hello world');
  });
});
