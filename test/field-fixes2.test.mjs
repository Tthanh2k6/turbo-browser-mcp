// Offline regression tests for field report round 2 (Google Forms, Zoho Recruit): submitButtons, guard false
// positives, label fallback, aria-label text targeting, stale-ref hint, SPA splash settle.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, extractCleanText, inspectCompact, smartFillForm } from '../src/dom-engine.mjs';

const GOOGLE_FORM = `<!doctype html><title>Form</title><body>
<div role="list"><div role="listitem"><div role="heading">Ten cua ban</div><input type="text" aria-label="Ten cua ban"></div></div>
<div role="button" tabindex="0"><span>Tiếp</span></div>
<div role="button" tabindex="0"><span>Xóa hết câu trả lời</span></div></body>`;

const chips = Array.from({ length: 30 }, (_, i) => `<button type="button" class="chip" aria-label="Remove skill : Skill ${i}"><i></i></button>`).join('');
const ZOHO = `<!doctype html><title>Zoho</title><body><form onsubmit="return false">
<div class="field"><label>First Name</label><div><lyte-input><input id="rec-form_83412000000003098"></lyte-input></div></div>
<div class="field"><label>Expected Salary</label><div><div><input id="rec-form_83412000000003101"></div></div></div>
<div>${chips}<button type="button">Delete entry</button><button type="button">Delete entry</button></div>
<button type="submit">Submit Application</button></form></body>`;

const bump = (id) => `onclick="window.__c=(window.__c||0)+1;window.__last='${id}'"`;

describe('field fixes round 2', () => {
  let m;
  let page;
  let server;
  let base;
  before(async () => {
    server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      res.setHeader('content-type', 'text/html');
      if (u.pathname === '/splash') {
        res.end('<title>App</title><body>Loading...<script>setTimeout(()=>{document.body.textContent="Dashboard ready. "+"x".repeat(120)},700)</script></body>');
      } else if (u.pathname === '/hang') {
        res.write('<title>Slow</title>');
      } else if (u.pathname === '/short') {
        res.end('<title>Short</title><body><p>hello</p></body>');
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    m = new BrowserManager({ mode: 'launch', headless: true });
    ({ page } = await m.getPage());
  });
  after(async () => {
    await m.close();
    await new Promise((r) => server.close(r));
  });

  const clicks = () => page.evaluate(() => window.__c || 0);
  const reset = () => page.evaluate(() => { window.__c = 0; window.__last = ''; });

  it('1: Google Forms submitButtons lists only "Tiếp", not "Xóa hết câu trả lời"', async () => {
    await page.setContent(GOOGLE_FORM);
    const r = await smartFillForm(page, { fields: [] });
    assert.deepEqual(r.submitButtons.map((b) => b.text), ['Tiếp']);
  });

  it('1: Zoho-like form with 30 remove chips lists only "Submit Application"', async () => {
    await page.setContent(ZOHO);
    const r = await smartFillForm(page, { fields: [] });
    assert.deepEqual(r.submitButtons.map((b) => b.text), ['Submit Application']);
  });

  it('1: submitButtons is capped at 3 and puts type=submit first', async () => {
    await page.setContent(`<form onsubmit="return false"><button type="button">Send</button><button type="button">Apply</button>
<button type="button">Next</button><button type="button">Gửi</button><button type="submit">Save changes</button></form>`);
    const r = await smartFillForm(page, { fields: [] });
    assert.equal(r.submitButtons.length, 3);
    assert.equal(r.submitButtons[0].text, 'Save changes');
  });

  it('2: "Apply now" links and non-form buttons are not blocked; Apply inside a form still is', async () => {
    await page.setContent(`<a id="a1" href="/jobs/42/apply" ${bump('a1')}>Apply now</a>
<button id="a2" aria-haspopup="dialog" ${bump('a2')}>Apply</button>
<form onsubmit="return false"><button id="a3" type="button" ${bump('a3')}>Apply</button></form>`);
    page.on('framenavigated', () => {});
    await page.evaluate(() => document.getElementById('a1').addEventListener('click', (e) => e.preventDefault()));
    for (const sel of ['#a1', '#a2']) {
      const r = await actFast(page, { action: 'click', selector: sel, allowSubmit: false });
      assert.equal(r.ok, true, `${sel}: ${JSON.stringify(r)}`);
    }
    assert.equal(await clicks(), 2);
    const blocked = await actFast(page, { action: 'click', selector: '#a3', allowSubmit: false });
    assert.equal(blocked.blocked, true);
    assert.equal(await clicks(), 2);
  });

  it('2: local destructive UI (Remove chip, Clear form, Cancel, Close, Hủy, Đóng) is not blocked', async () => {
    await reset();
    const labels = ['Remove skill : Form 1099', 'Xóa hết câu trả lời', 'Cancel', 'Close', 'Hủy', 'Đóng', 'Clear'];
    await page.setContent(labels.map((l, i) => `<button id="b${i}" type="button" ${bump(`b${i}`)}>${l}</button>`).join('')
      + `<div id="r" role="button" tabindex="0" ${bump('r')}>Xóa hết câu trả lời</div>`);
    for (let i = 0; i < labels.length; i++) {
      const r = await actFast(page, { action: 'click', selector: `#b${i}`, allowSubmit: false });
      assert.equal(r.ok, true, `${labels[i]}: ${JSON.stringify(r)}`);
    }
    const r = await actFast(page, { action: 'click', selector: '#r', allowSubmit: false });
    assert.equal(r.ok, true);
    assert.equal(await clicks(), labels.length + 1);
  });

  it('2: real final submits and account deletion stay blocked', async () => {
    await reset();
    const labels = ['Submit application', 'Send', 'Pay', 'Place order', 'Gửi', 'Delete account', 'Xóa', 'Remove account'];
    await page.setContent(labels.map((l, i) => `<button id="s${i}" type="button" ${bump(`s${i}`)}>${l}</button>`).join('')
      + `<form onsubmit="window.__c=(window.__c||0)+1;return false"><button id="rs" type="submit">Remove</button></form>
<div id="mi" role="menuitem" tabindex="0" ${bump('mi')}>Remove</div>`);
    for (let i = 0; i < labels.length; i++) {
      const r = await actFast(page, { action: 'click', selector: `#s${i}`, allowSubmit: false });
      assert.equal(r.blocked, true, `${labels[i]} must stay blocked: ${JSON.stringify(r)}`);
    }
    for (const sel of ['#rs', '#mi']) {
      const r = await actFast(page, { action: 'click', selector: sel, allowSubmit: false });
      assert.equal(r.blocked, true, `${sel} must stay blocked`);
    }
    assert.equal(await clicks(), 0);
  });

  it('3: Zoho label without `for` shows the visible label in inspect_compact and smart_fill_form', async () => {
    await page.setContent(ZOHO);
    const snap = await inspectCompact(page, { mode: 'forms', query: 'input' });
    assert.match(snap.text, /"First Name"/);
    assert.match(snap.text, /"Expected Salary"/);
    assert.doesNotMatch(snap.text, /rec-form_8341/);
    const r = await smartFillForm(page, { fields: [{ keys: ['First Name'], value: 'Ada' }, { keys: ['Expected Salary'], value: '9000' }] });
    assert.equal(r.filledCount, 2, JSON.stringify(r));
    assert.match(r.filled[0].label, /^first name/);
    assert.equal(await page.inputValue('#rec-form_83412000000003098'), 'Ada');
  });

  it('3: a label shared by two inputs is not borrowed; proper <label for> pages are untouched', async () => {
    await page.setContent(`<div class="row"><label>Phone</label><input id="p1"><input id="p2"></div>
<label for="e">Email</label><input id="e" placeholder="you@x.com">`);
    const snap = await inspectCompact(page, { mode: 'forms' });
    assert.match(snap.text, /"p1"/);
    assert.match(snap.text, /"p2"/);
    assert.match(snap.text, /"Email"/);
    const r = await smartFillForm(page, { fields: [{ keys: ['Email'], value: 'a@b.co' }] });
    assert.equal(r.filled[0].label, 'you@x.com | e | email | email');
  });

  it('4: text targeting falls back to aria-label (exact first, then contains) and title', async () => {
    await page.setContent(`<button id="x1" type="button" aria-label="Remove skill : Form 1099 extra" ${bump('x1')}><svg width=10 height=10></svg></button>
<button id="x2" type="button" aria-label="Remove skill : Form 1099" ${bump('x2')}><svg width=10 height=10></svg></button>
<button id="x3" type="button" title="Toggle sidebar" ${bump('x3')}><svg width=10 height=10></svg></button>`);
    let r = await actFast(page, { action: 'click', text: 'Remove skill : Form 1099', allowSubmit: false });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(await page.evaluate(() => window.__last), 'x2');
    r = await actFast(page, { action: 'click', text: 'Form 1099 extra', allowSubmit: false });
    assert.equal(await page.evaluate(() => window.__last), 'x1');
    r = await actFast(page, { action: 'click', text: 'toggle side', allowSubmit: false });
    assert.equal(await page.evaluate(() => window.__last), 'x3');
    await assert.rejects(actFast(page, { action: 'click', text: 'no such thing at all', allowSubmit: false }), /matched 0 elements/);
  });

  it('5: a missing ref error carries the re-inspect hint', async () => {
    await page.setContent('<button>one</button><button>two</button>');
    await inspectCompact(page, {});
    await assert.rejects(
      actFast(page, { action: 'click', ref: 'f0:e99', allowSubmit: false }),
      /Nearest current refs: .*re-run inspect_compact \(same query\)/
    );
  });

  it('6a: load navigation on a splash-only SPA waits for content and reports settledMs', async () => {
    const out = await m.tabsBatch([{ action: 'open', url: `${base}/splash`, waitUntil: 'load' }]);
    const r = out.results[0];
    assert.ok(r.settledMs >= 200 && r.settledMs < 3100, JSON.stringify(r));
    const { page: p } = await m.getPage(r.tabId);
    assert.match(await p.evaluate(() => document.body.innerText), /Dashboard ready/);
  });

  it('6a: short real pages and domcontentloaded navigations are not delayed or annotated', async () => {
    const t0 = Date.now();
    const out = await m.tabsBatch([
      { action: 'open', url: `${base}/short`, waitUntil: 'load' },
      { action: 'open', url: `${base}/splash` },
    ]);
    assert.equal(out.results[0].settledMs, undefined);
    assert.equal(out.results[1].settledMs, undefined);
    assert.ok(Date.now() - t0 < 2500);
  });

  it('R3-1: an empty <main> does not hide the page body text', async () => {
    await page.setContent('<!doctype html><title>RR</title><body><main></main><div>' + 'Remote Python developer role with Supabase and row level security. '.repeat(12) + '</div></body>');
    const r = await extractCleanText(page, {});
    assert.match(r.text, /Remote Python developer role/);
    const md = await extractCleanText(page, { format: 'markdown' });
    assert.match(md.text, /Remote Python developer role/);
  });

  it('R3-1: an aria-hidden app root (modal library) does not blank the page; plain pages are untouched', async () => {
    const body = 'Python Developer, 25 hours per week, 4 weeks, remote anywhere, RESTful API. '.repeat(10);
    await page.setContent('<!doctype html><title>Arc</title><body><div id="__next" aria-hidden="true"><div>' + body + '</div></div></body>');
    const r = await extractCleanText(page, {});
    assert.match(r.text, /Python Developer, 25 hours/);
    // A genuinely hidden block next to real content stays hidden (rescue only fires when the result is under 10%).
    await page.setContent('<!doctype html><body><p>' + body + '</p><div aria-hidden="true">SECRET-HIDDEN-TEXT</div></body>');
    const plain = await extractCleanText(page, {});
    assert.doesNotMatch(plain.text, /SECRET-HIDDEN-TEXT/);
  });

  it('R3-2: tabs_batch reports a failing navigation per operation and runs the rest', async () => {
    const out = await m.tabsBatch([
      { action: 'open', url: base + '/short' },
      { action: 'open', url: 'http://nonexistent.invalid/' },
      { action: 'navigate', url: base + '/short' },
      { action: 'open', url: base + '/short' },
    ]);
    const [a, bad, skipped, d] = out.results;
    assert.equal(a.ok, undefined);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /ERR_NAME_NOT_RESOLVED|net::/);
    assert.doesNotMatch(bad.error, /\n/);
    assert.equal(skipped.skipped, true);
    assert.ok(d.tabId && d.url.endsWith('/short'));
    assert.equal(out.results.length, 4);
  });

  it('R3-2: a navigation timeout keeps the tab and reports timedOut with url and title', async () => {
    const out = await m.tabsBatch([
      { action: 'open', url: base + '/hang', timeoutMs: 400 },
      { action: 'navigate', tabId: undefined, url: base + '/hang', timeoutMs: 400 },
    ]);
    assert.equal(out.results[0].timedOut, true);
    assert.ok(out.results[0].tabId);
    assert.equal(out.results[1].timedOut, true);
    assert.equal(typeof out.results[1].title, 'string');
  });
});
