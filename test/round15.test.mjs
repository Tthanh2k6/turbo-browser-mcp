// Round 15: field-report fixes from the dev.to / Reddit posting sessions. Local fixtures only, headless launch.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { dispatchToolCall } from '../src/index.mjs';

let server, port, manager;
const call = async (name, args) => JSON.parse((await dispatchToolCall(manager, name, args)).text);
const base = () => `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGES = {
  '/hydrate': `<form id="f"><label>Title <input name="t"></label></form>
    <script>setTimeout(()=>{document.getElementById('f').outerHTML='<form id="f"><label>Title <input name="t"></label></form>'},500)</script>`,
  '/long': '<label>Title <input name="t"></label><label>Body <textarea name="b"></textarea></label>',
  '/chips': `<div id="box"><span id="chips"></span><input id="tg" aria-label="Tags"></div>
    <script>tg.addEventListener('input',()=>{if(tg.value.endsWith(',')){const s=document.createElement('span');s.textContent=tg.value.slice(0,-1);chips.appendChild(s);tg.value=''}})</script>`,
  '/toast-chips': `<button id="open">Add</button><button id="msg">Save</button><div id="out"></div>
    <script>open_.onclick=()=>{out.innerHTML='<div role="status"><span>mcp <button>x</button></span><span>ai <button>x</button></span></div>'};
    msg.onclick=()=>{out.innerHTML='<div role="alert">Saved to drafts</div>'}</script>`.replace('open_', 'document.getElementById("open")'),
  '/popover': `<button id="open">Open</button><div id="pop" style="display:none"><button id="card">Card</button></div>
    <script>document.getElementById('open').onclick=()=>{pop.style.display='block';setTimeout(()=>{pop.style.pointerEvents=card.style.pointerEvents='none'},300)}</script>`,
  '/lexical': `<div id="host"></div><script>
    const sr=host.attachShadow({mode:'open'});
    sr.innerHTML='<div id="ed" contenteditable="true" aria-label="Body text" role="textbox"><p>old text</p></div>';
    const ed=sr.getElementById('ed');let model=['old text'];let rendering=false;
    const paint=()=>{rendering=true;ed.replaceChildren(...model.map(t=>{const p=document.createElement('p');p.textContent=t;if(!t)p.append(document.createElement('br'));return p}));setTimeout(()=>rendering=false,0)};
    const render=()=>setTimeout(paint,0);
    new MutationObserver(()=>{if(!rendering)paint()}).observe(ed,{childList:true,subtree:true,characterData:true});
    ed.addEventListener('beforeinput',(e)=>{e.preventDefault();
      if(e.inputType==='insertText')model[model.length-1]+=String(e.data||'').replace(/\\n/g,'');
      else if(e.inputType==='insertParagraph')model.push('');
      else if(e.inputType.startsWith('delete'))model=[''];
      render()});
    window.model=()=>model.join('|')</script>`,
};

before(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>x</title><body>${PAGES[req.url.split('?')[0]] || ''}</body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  manager = new BrowserManager({ mode: 'launch', headless: true });
});
after(async () => {
  await manager?.close().catch(() => {});
  await new Promise((r) => server.close(r));
});
const open = (p) => call('tabs_batch', { operations: [{ action: 'open', url: `${base()}${p}` }] });

describe('round 15', () => {
  it('0: smart_fill_form accepts label as an alias for keys', async () => {
    await open('/long');
    const r = await call('smart_fill_form', { fields: [{ label: 'Title', value: 'hello' }] });
    assert.equal(r.filled?.length, 1, JSON.stringify(r));
  });

  it('1: a ref from before a re-render is reported as stale with the live ref', async () => {
    await open('/hydrate');
    const snap = (await dispatchToolCall(manager, 'inspect_compact', {})).text;
    const ref = /\[(f0:e\d+)\] <input[^\]]*?Title/.exec(snap.replace(/\\"/g, '"'))?.[1] || 'f0:e1';
    await sleep(900);
    const r = await call('smart_fill_form', { fields: [{ ref, value: 'x' }] });
    const s = r.skipped?.[0];
    assert.equal(s?.reason, 'stale-ref', `${JSON.stringify(r)} / ${snap.slice(0, 300)}`);
    assert.match(s.hint, /re-rendered/);
    assert.match(s.hint, /re-inspect \(was "Title"\)/);
  });

  it('2: long values are not flagged changedAfterBlur', async () => {
    await open('/long');
    const title = 'T'.repeat(80);
    const body = 'Paragraph one has some words.\n\nParagraph two has more words. '.repeat(40);
    const r = await call('smart_fill_form', { fields: [{ keys: 'Title', value: title }, { keys: 'Body', value: body }] });
    assert.equal(r.filled?.length, 2, JSON.stringify(r));
    assert.ok(!/changedAfterBlur|clearedAfterBlur/.test(JSON.stringify(r)), JSON.stringify(r));
  });

  it('3: a chip box appearing after a click is not reported as a toast, a real alert still is', async () => {
    await open('/toast-chips');
    const a = await call('act_fast', { action: 'click', text: 'Add' });
    assert.equal(a.toast, undefined, JSON.stringify(a));
    const b = await call('act_fast', { action: 'click', text: 'Save' });
    assert.equal(b.toast, 'Saved to drafts', JSON.stringify(b));
  });

  it('4: typing into a chip input that turns text into a chip reports no mismatch', async () => {
    await open('/chips');
    const r = await call('act_fast', { action: 'type', selector: '#tg', value: 'mcp,' });
    assert.equal(r.mismatch, undefined, JSON.stringify(r));
    assert.equal(await (await manager.getPage()).page.evaluate(() => document.getElementById('chips').textContent), 'mcp');
  });

  it('5: a click whose target stopped receiving pointer events fails fast with a popover hint', async () => {
    await open('/popover');
    await call('act_fast', { action: 'click', text: 'Open' });
    await sleep(500);
    const t0 = Date.now();
    await assert.rejects(dispatchToolCall(manager, 'act_fast', { action: 'click', selector: '#card' }), /popover or menu closed/);
    assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  });

  it('6: fill replaces a Lexical-like editor in an open shadow root, one paragraph per newline', async () => {
    await open('/lexical');
    const r = await call('smart_fill_form', { fields: [{ keys: 'Body text', value: 'First line\nSecond line\n\nThird' }], overwrite: true });
    assert.equal(r.filled?.length, 1, JSON.stringify(r));
    const model = await (await manager.getPage()).page.evaluate(() => window.model());
    assert.equal(model, 'First line|Second line||Third');
    const r2 = await call('smart_fill_form', { fields: [{ keys: 'Body text', value: 'Only this' }], overwrite: true });
    assert.equal(r2.filled?.length, 1, JSON.stringify(r2));
    assert.equal(await (await manager.getPage()).page.evaluate(() => window.model()), 'Only this');
  });

  it('6b: long multi-line editor fill is not flagged after blur and the field is reported once', async () => {
    await open('/lexical');
    const v = 'line one\n\nline two with a longer sentence that goes past sixty characters for the blur check\nline three';
    const r = await call('smart_fill_form', { fields: [{ label: 'Body text', value: v }], overwrite: true });
    assert.equal(r.filled?.length, 1, JSON.stringify(r));
    assert.ok(!/changedAfterBlur|clearedAfterBlur/.test(JSON.stringify(r)), JSON.stringify(r));
    assert.equal((r.skipped || []).length, 0, JSON.stringify(r));
  });

  it('7b: chrome:// pages are not flagged unresponsive', async () => {
    const p = await manager.context.newPage();
    await p.goto('chrome://version').catch(() => {});
    const res = await manager.listTabs();
    const t = res.find((x) => x.url.startsWith('chrome://'));
    assert.ok(t, JSON.stringify(res));
    assert.equal(t.unresponsive, undefined);
    await p.close();
  });

  it('7: listing tabs does not wait 1.5 s per stuck tab', async () => {
    const ctx = manager.context;
    const stuck = [];
    for (let i = 0; i < 4; i++) {
      const p = await ctx.newPage();
      await p.goto(`data:text/html,<title>S${i}</title><p>x`);
      const d = await ctx.newCDPSession(p);
      await d.send('Debugger.enable');
      await d.send('Runtime.evaluate', { expression: 'setTimeout(() => { debugger; }, 10)' });
      stuck.push(p);
    }
    await sleep(400);
    const t0 = Date.now();
    const res = await manager.listTabs();
    const ms = Date.now() - t0;
    assert.ok(ms < 4500, `list took ${ms} ms`);
    assert.ok(res.filter((t) => t.unresponsive).length >= 4);
  });
});
