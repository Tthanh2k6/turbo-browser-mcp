// Offline regression tests for the second real-site round (the-internet login/modal, react-select multi, savePath).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, extractCleanText, inspectCompact, smartFillForm } from '../src/dom-engine.mjs';

const LOGIN = `<!doctype html><h2>Login Page</h2><p>Enter your login details</p>
<form onsubmit="document.getElementById('flash').textContent='submitted';return false">
<label for=u>Username</label><input id=u name=u><button type=submit><i> Login</i></button></form><div id=flash></div>`;

const MODAL = `<!doctype html><a href="#x">link</a><div id=modal style="display:none"><div class=underlay style="position:fixed;inset:0"></div><div class=modal>
<div class=modal-title><h3>This is a modal window</h3><p>It is displayed over the page.</p></div>
<div class=modal-body><p>If closed, it will not appear on subsequent page loads.</p></div>
<div class=modal-footer><p style="cursor:pointer" id=closer>Close</p></div></div></div>
<script>document.getElementById('closer').addEventListener('click',()=>{document.getElementById('modal').style.display='none';document.title='closed'});
setTimeout(()=>{document.getElementById('modal').style.display='block'},0)</script>
<style>.modal{position:fixed;top:50px;left:50px;width:300px;background:#fff;z-index:9}</style>`;

const MULTI = `<!doctype html><div id=ms style="position:relative">
<input role=combobox aria-expanded=false id=cb aria-controls=lb autocomplete=off>
<div id=chips></div><ul id=lb role=listbox hidden>
<li role=option>Green</li><li role=option>Red</li><li role=option>Blue</li></ul></div>
<script>const cb=document.getElementById('cb'),lb=document.getElementById('lb');
cb.addEventListener('click',()=>{lb.hidden=false;cb.setAttribute('aria-expanded','true')});
lb.addEventListener('click',(e)=>{if(e.target.role!=='option'&&e.target.getAttribute('role')!=='option')return;
const c=document.createElement('span');c.className='chip';c.textContent=e.target.textContent;document.getElementById('chips').append(c);
lb.hidden=true;cb.setAttribute('aria-expanded','false')});</script>`;

describe('real-site fixes round 2', () => {
  let m;
  let page;
  before(async () => {
    m = new BrowserManager({ mode: 'launch', headless: true });
    ({ page } = await m.getPage());
  });
  after(async () => m.close());

  it('1: text click prefers the actionable button over a heading containing the text', async () => {
    await page.setContent(LOGIN);
    const r = await actFast(page, { action: 'click', text: 'Login', allowSubmit: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(await page.locator('#flash').textContent(), 'submitted');
  });

  it('2: text "Close" resolves to the Close control, not a paragraph in the modal', async () => {
    await page.setContent(MODAL);
    await page.waitForSelector('#closer', { state: 'visible' });
    const r = await actFast(page, { action: 'click', text: 'Close' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(await page.title(), 'closed');
  });

  it('3: smart_fill_form option array picks each entry on a multi combobox', async () => {
    await page.setContent(MULTI);
    const r = await smartFillForm(page, { fields: [{ selector: '#cb', option: ['Green', 'Red'] }] });
    assert.equal(r.filledCount, 2, JSON.stringify(r));
    assert.deepEqual(await page.locator('.chip').allTextContents(), ['Green', 'Red']);
    const bad = await smartFillForm(page, { fields: [{ selector: '#cb', option: ['Nope'] }] });
    assert.equal(bad.skipped[0]?.reason, 'combobox-option-not-found', JSON.stringify(bad));
  });

  it('4: savePath writes the full output while the returned text stays capped', async () => {
    const long = Array.from({ length: 200 }, (_, i) => `<p>paragraph number ${i} with filler words</p>`).join('');
    await page.setContent(`<!doctype html><body>${long}<button>go</button>${Array.from({ length: 80 }, (_, i) => `<a href="/p${i}">link ${i}</a>`).join('')}`);
    const f1 = path.join(process.cwd(), 'tmp', `tbm-save-${process.pid}-t.txt`);
    const f2 = path.join(process.cwd(), 'tmp', `tbm-save-${process.pid}-i.txt`);
    const t = await extractCleanText(page, { maxChars: 500, savePath: f1 });
    assert.equal(t.truncated, true);
    assert.ok(t.text.length <= 500);
    assert.ok(fs.readFileSync(f1, 'utf8').length > 5000);
    assert.ok(fs.readFileSync(f1, 'utf8').includes('paragraph number 199'));
    assert.equal(t.fullChars, fs.readFileSync(f1, 'utf8').length);
    const i = await inspectCompact(page, { mode: 'all', maxChars: 400, savePath: f2 }, new Set());
    assert.equal(i.truncated, true);
    const saved = fs.readFileSync(f2, 'utf8');
    assert.ok(saved.length > i.text.length && saved.includes('link 79') && !saved.includes('[truncated'));
    fs.rmSync(f1, { force: true });
    fs.rmSync(f2, { force: true });
  });

  it('5: interactive onlyChanged lists a pointer-cursor close control inside a new modal', async () => {
    await page.setContent('<!doctype html><a href="#x">link</a><div id=host></div>');
    const prev = new Set();
    await inspectCompact(page, { mode: 'interactive' }, prev);
    await page.evaluate(() => {
      document.getElementById('host').innerHTML = '<div class=modal style="position:fixed;top:10px;left:10px;width:200px;background:#fff"><p>Hello</p><p style="cursor:pointer">Close</p></div>';
    });
    const r = await inspectCompact(page, { mode: 'interactive', onlyChanged: true }, prev);
    assert.match(r.text, /\*?\[f0:e\d+\] <p> "Close"/, r.text);
    assert.doesNotMatch(r.text, /"Hello"/);
  });
});
