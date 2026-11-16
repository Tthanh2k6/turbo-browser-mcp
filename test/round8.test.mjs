// Round 8: Vietnamese/English schedule-booking commit buttons, expect.textNew, returnSnapshot query,
// Notion-style slow settle. Local fixtures only; headless launch.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, batchActions, smartFillFormGuarded } from '../src/dom-engine.mjs';

const PAGES = {
  '/book':
    '<!doctype html><title>Book</title><form onsubmit="return false"><label>Name <input name="n"></label>' +
    '<button type="button" id="b">LABEL</button></form><p id="out"></p>' +
    '<script>b.onclick=()=>{document.getElementById("out").textContent="clicked"}</script>',
  '/new-text':
    '<!doctype html><title>NT</title><p>Details are provided upon xác nhận.</p><button id="go">Lên lịch họp</button>' +
    '<script>go.onclick=()=>setTimeout(()=>{const d=document.createElement("div");d.textContent="Đã xác nhận cuộc họp";document.body.appendChild(d)},500)</script>',
  '/no-new-text':
    '<!doctype html><title>NN</title><p>Details are provided upon xác nhận.</p><button id="go">Lên lịch họp</button>',
};

let srv, base, m, page;
before(async () => {
  srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = PAGES[u.pathname];
    if (u.pathname === '/book') body = body.replace('LABEL', u.searchParams.get('l') || 'x');
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body || 'nf');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  m = new BrowserManager({ mode: 'launch', headless: true });
  ({ page } = await m.getPage());
});
after(async () => {
  await m.close();
  await new Promise((r) => srv.close(r));
});

describe('round 8 item 5: schedule and booking verbs are commit buttons', () => {
  const labels = ['Lên lịch họp', 'Lên lịch', 'Đặt lịch', 'Xác nhận đặt lịch', 'Schedule meeting', 'Book', 'Book now', 'Confirm booking'];
  for (const label of labels) {
    it(`"${label}" is listed as a submit button and blocked by the guard`, async () => {
      await page.goto(`${base}/book?l=${encodeURIComponent(label)}`);
      const fill = await smartFillFormGuarded(page, { fields: [{ label: 'Name', value: 'An' }] });
      assert.ok(
        (fill.submitButtons || []).some((b) => String(b.text).includes(label)),
        JSON.stringify(fill.submitButtons)
      );
      const r = await actFast(page, { action: 'click', selector: '#b' });
      assert.equal(r.blocked, true, JSON.stringify(r));
      assert.equal(await page.locator('#out').textContent(), '');
    });
  }
  it('look-alike words are not commit buttons', async () => {
    for (const label of ['Bookmark', 'Schedule', 'Booking history']) {
      await page.goto(`${base}/book?l=${encodeURIComponent(label)}`);
      const r = await actFast(page, { action: 'click', selector: '#b' });
      assert.notEqual(r.blocked, true, `${label}: ${JSON.stringify(r)}`);
    }
  });
});

describe('round 8 item 6: expect.textNew', () => {
  it('textMatches is satisfied by old text at once; textNew waits for the new element', async () => {
    await page.goto(`${base}/new-text`);
    const old = await actFast(page, { action: 'click', selector: '#go', allowSubmit: true, expect: { textMatches: 'xác nhận', timeoutMs: 3000 } });
    assert.equal(old.submitVerified, true);
    assert.ok(old.verifyMs < 300, `textMatches verified in ${old.verifyMs} ms (old text)`);
    await page.goto(`${base}/new-text`);
    const fresh = await actFast(page, { action: 'click', selector: '#go', allowSubmit: true, expect: { textNew: 'xác nhận', timeoutMs: 3000 } });
    assert.equal(fresh.submitVerified, true, JSON.stringify(fresh));
    assert.ok(fresh.verifyMs >= 300, `textNew verified in ${fresh.verifyMs} ms, before the new text`);
    assert.equal(fresh.evidence.type, 'textNew');
  });
  it('textNew does not verify when only old text exists, in act_fast and batch_actions', async () => {
    await page.goto(`${base}/no-new-text`);
    const a = await actFast(page, { action: 'click', selector: '#go', allowSubmit: true, expect: { textNew: 'xác nhận', timeoutMs: 600 } });
    assert.equal(a.submitVerified, false, JSON.stringify(a));
    const b = await batchActions(page, [{ action: 'click', selector: '#go' }], { allowSubmit: true, expect: { textNew: 'xác nhận', timeoutMs: 600 } });
    assert.equal(b.submitVerified, false, JSON.stringify(b));
    await page.goto(`${base}/new-text`);
    const c = await batchActions(page, [{ action: 'click', selector: '#go' }], { allowSubmit: true, expect: { textNew: 'xác nhận', timeoutMs: 3000 } });
    assert.equal(c.submitVerified, true, JSON.stringify(c));
  });
});

describe('round 8 item 4: SPA view swap on a busy page with a long-poll request', () => {
  const SPA =
    '<!doctype html><title>Meet</title><div id="app"><h1>Pick a time</h1><button class="slot">10:00</button></div>' +
    '<script>function poll(){fetch("/poll").then(r=>r.text()).then(poll).catch(()=>setTimeout(poll,500));}poll();' +
    'window.busy=(ms)=>setTimeout(()=>{const t=performance.now();while(performance.now()-t<ms);},0);' +
    'document.addEventListener("click",e=>{if(e.target.classList.contains("slot"))setTimeout(()=>{app.innerHTML="<h1>Your details</h1><input placeholder=Name><button disabled>Lên lịch họp</button>"},100)})</script>';
  let spaSrv, spaBase;
  before(async () => {
    spaSrv = http.createServer((req, res) => {
      if (req.url.startsWith('/poll')) { setTimeout(() => { res.writeHead(200); res.end('x'); }, 20000).unref(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(SPA);
    });
    await new Promise((r) => spaSrv.listen(0, '127.0.0.1', r));
    spaBase = `http://127.0.0.1:${spaSrv.address().port}`;
  });
  after(async () => {
    spaSrv.closeAllConnections?.();
    await new Promise((r) => spaSrv.close(r));
  });
  it('click returns quickly despite the long-poll and reports outcome "changed" even when the first probe is slow', async () => {
    for (const extra of [{ returnSnapshot: true }, { observeAftermath: true }]) {
      await page.goto(`${spaBase}/`, { waitUntil: 'domcontentloaded' });
      await page.evaluate('window.busy(700)');
      const t0 = Date.now();
      const r = await actFast(page, { action: 'click', text: '10:00', ...extra });
      const ms = Date.now() - t0;
      assert.equal(r.outcome, 'changed', JSON.stringify(r));
      assert.ok(ms < 4000, `click took ${ms} ms`);
    }
  });
});

describe('round 8 item 7: snapshotQuery on returnSnapshot', () => {
  it('act_fast and batch_actions snapshot only matching elements, so the new part is not truncated away', async () => {
    const days = Array.from({ length: 70 }, (_, i) => `<button>Day number ${i + 1} of the month</button>`).join('');
    const html =
      `<div id="cal"><button id="pick">Pick</button>${days}</div><div id="slots"></div>` +
        '<script>pick.onclick=()=>{cal.innerHTML=`' + days + '`;slots.innerHTML=\'<button>09:15 slot</button><button>09:45 slot</button>\'}</script>';
    await page.setContent(html);
    const plain = await actFast(page, { action: 'click', selector: '#pick', returnSnapshot: true, snapshotMaxChars: 600 });
    assert.ok(!/09:15/.test(plain.snapshot), 'precondition: the default snapshot is cut before the slots');
    await page.setContent(html);
    const q = await actFast(page, { action: 'click', selector: '#pick', returnSnapshot: true, snapshotMaxChars: 600, snapshotQuery: '[0-9]{2}:[0-9]{2}' });
    assert.match(q.snapshot, /09:15/);
    assert.match(q.snapshot, /09:45/);
    assert.ok(!/Day number/.test(q.snapshot));
    await page.setContent(html);
    const b = await batchActions(page, [{ action: 'click', selector: '#pick' }], { returnSnapshot: true, snapshotMaxChars: 600, snapshotQuery: '09:45' });
    assert.match(b.snapshot, /09:45/);
  });
});
