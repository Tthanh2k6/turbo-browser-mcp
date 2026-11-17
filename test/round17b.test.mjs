// Round 17b: Radix-like select that hides the page, portal options in snapshots, text split over child elements,
// filled[] in idx order.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { dispatchToolCall } from '../src/index.mjs';

let web, port, m;
const call = async (name, args) => (await dispatchToolCall(m, name, args)).text;
const PAGE = `<title>R</title><body><div id="root"><label>Name <input name="n"></label><label>Email <input name="e"></label>
  <button role="combobox" id="sel" aria-expanded="false" aria-label="Country">Choose</button><button id="other">Other</button>
  <a id="job" href="#j" style="display:block"><span style="display:block">Developer Relations Engineer</span><span style="display:block">Marketing</span><span style="display:block">•</span><span style="display:block">Remote, Global</span><span style="display:block">Full time</span></a><textarea aria-label="Bio">old bio</textarea><form id="v" onsubmit="return false"><label>Note <input id="note" maxlength="500" required></label><button type="submit" id="go">Send</button></form></div>
<script>
const root=document.getElementById('root');let pop=null;
const close=()=>{if(pop){pop.remove();pop=null}root.removeAttribute('aria-hidden');sel.setAttribute('aria-expanded','false')};
sel.onclick=()=>{if(pop)return;pop=document.createElement('div');pop.setAttribute('data-radix-popper-content-wrapper','');
  pop.innerHTML='<div role="listbox"><div role="option" tabindex="-1">France</div><div role="option" tabindex="-1">Spain</div></div>';
  document.body.appendChild(pop);root.setAttribute('aria-hidden','true');sel.setAttribute('aria-expanded','true');
  pop.querySelectorAll('[role=option]').forEach(o=>o.onclick=()=>{sel.textContent=o.textContent;close()})};
document.addEventListener('keydown',e=>{if(e.key==='Escape')close()});
</script></body>`;
before(async () => {
  web = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end(PAGE); });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  port = web.address().port;
  m = new BrowserManager({ mode: 'launch', headless: true });
});
after(async () => { await m?.close().catch(() => {}); await new Promise((r) => web.close(r)); });

describe('round 17b', () => {
  it('open popup that hides the page: refs are not stale, options are listed, a hint names the popup', async () => {
    await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'open', url: `http://127.0.0.1:${port}/` }] });
    const snap = await call('inspect_compact', {});
    const ref = /\[(f0:e\d+)\] <input[^\n]*Name/.exec(snap)?.[1];
    assert.ok(ref, snap);
    await call('act_fast', { action: 'click', selector: '#sel' });
    const open = await call('inspect_compact', { query: 'option' });
    assert.match(open, /France/, open);
    const full = await call('inspect_compact', {});
    assert.match(full, /popup is open/i, full);
    const r = JSON.parse(await call('smart_fill_form', { fields: [{ ref, value: 'x' }] }));
    const s = r.skipped?.[0];
    assert.ok(s && s.reason !== 'stale-ref', JSON.stringify(r));
    assert.match(s.hint || '', /popup is open/);
    assert.ok(!/same label now/.test(s.hint || ''));
    await call('act_fast', { action: 'press', key: 'Escape' });
    const ok = JSON.parse(await call('smart_fill_form', { fields: [{ ref, value: 'x' }] }));
    assert.equal(ok.filled?.length, 1, JSON.stringify(ok));
  });

  it('text targeting matches the innerText spread over child elements and picks the smallest actionable element', async () => {
    await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'open', url: `http://127.0.0.1:${port}/` }] });
    const out = await call('act_fast', { action: 'click', text: 'Developer Relations Engineer Marketing • Remote, Global' }).catch((e) => String(e.message));
    assert.ok(!/not found|No element/i.test(out), out);
  });

  it('a different requested value replaces a filled field, an identical one is skipped', async () => {
    await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'open', url: `http://127.0.0.1:${port}/` }] });
    const r = JSON.parse(await call('smart_fill_form', { fields: [{ keys: 'Bio', value: 'new bio' }] }));
    assert.equal(r.filled?.length, 1, JSON.stringify(r));
    assert.equal(r.filled[0].replaced, true);
    const again = JSON.parse(await call('smart_fill_form', { fields: [{ keys: 'Bio', value: 'new bio' }] }));
    assert.equal(again.skipped?.[0]?.reason, 'already-filled', JSON.stringify(again));
  });

  it('a submit stopped by client validation returns the visible validation messages', async () => {
    await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'open', url: `http://127.0.0.1:${port}/` }] });
    const out = await call('act_fast', { action: 'click', selector: '#go', allowSubmit: true, expect: { textMatches: 'Thank you', timeoutMs: 500 } });
    assert.match(out, /validation/, out);
    assert.match(out, /Note/, out);
  });

  it('filled entries come back in idx order', async () => {
    await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'open', url: `http://127.0.0.1:${port}/` }] });
    const r = JSON.parse(await call('smart_fill_form', { fields: [{ keys: 'Name', value: 'a' }, { keys: 'Country', option: 'Spain' }, { keys: 'Email', value: 'b' }] }));
    const idx = (r.filled || []).map((f) => f.idx);
    assert.deepEqual(idx, [...idx].sort((a, b) => a - b), JSON.stringify(r));
    assert.equal(idx.length, 3, JSON.stringify(r));
  });
});
