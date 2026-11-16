// Round 9: fixes from the Reddit, dev.to and Contra field report (web-component fill, disabled fail-fast, delta
// baselines, pointer-only list items, toasts, dev.to submit buttons, PDF print CSS, batch reload/back/forward,
// type truncation, empty SPA extract). Local fixtures only; headless launch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, batchActions, capturePage, extractCleanText, inspectCompact, smartFillForm } from '../src/dom-engine.mjs';

let srv, base, m, page;
const hits = { b: 0 };
before(async () => {
  srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (u.pathname === '/a') return res.end('<!doctype html><title>A</title><p>page a</p><a href="/b">to b</a>');
    if (u.pathname === '/b') {
      hits.b++;
      return res.end(`<!doctype html><title>B</title><p id="n">hit ${hits.b}</p>`);
    }
    if (u.pathname === '/spa') {
      return res.end('<!doctype html><title>Spa</title><div id="root"></div><script>setTimeout(()=>{root.innerHTML="<main><p>Hello SPA content</p></main>"},700)</script>');
    }
    if (u.pathname === '/spa-empty') return res.end('<!doctype html><title>Empty</title><div id="root"></div>');
    res.end('nf');
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

const FACEPLATE = `<div role="dialog" id="dlg"><fp-input id="fp"></fp-input><button id="save" disabled>Save</button></div>
<script>
class FP extends HTMLElement {
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.innerHTML = '<label>Display Text <input></label>';
    const i = r.querySelector('input');
    i.addEventListener('input', (e) => {
      if (!e.isTrusted) return; // the component only registers real typing
      this.value = i.value;
      document.getElementById('save').disabled = !this.value;
    });
  }
}
customElements.define('fp-input', FP);
</script>`;

const FACEPLATE_KEYS = FACEPLATE.replace('if (!e.isTrusted) return; // the component only registers real typing', 'if (!this._k) return;').replace("const i = r.querySelector('input');", "const i = r.querySelector('input'); i.addEventListener('keydown', () => { this._k = true; });").replaceAll('fp-input', 'fk-input').replaceAll('FP', 'FK');

describe('round 9 item 1: web-component fill falls back to typing', () => {
  it('smart_fill_form retypes a faceplate-style field the component ignored', async () => {
    await page.setContent(FACEPLATE);
    const r = await smartFillForm(page, { fields: [{ keys: ['Display Text'], value: 'hello' }] });
    assert.equal(r.filled[0].retyped, true, JSON.stringify(r));
    assert.equal(await page.evaluate(() => document.getElementById('save').disabled), false);
    assert.equal(await page.evaluate(() => document.getElementById('fp').value), 'hello');
  });
  it('act_fast fill does the same and reports retyped', async () => {
    await page.setContent(FACEPLATE_KEYS);
    const r = await actFast(page, { action: 'fill', selector: 'fk-input input', value: 'again' });
    assert.equal(r.retyped, true, JSON.stringify(r));
    assert.equal(await page.evaluate(() => document.getElementById('save').disabled), false);
  });
  it('normal inputs cost nothing: no retyped key and no keyboard use', async () => {
    await page.setContent('<form><label>Name <input id="n"></label><button id="s" disabled>Save</button></form>');
    let typed = 0;
    const orig = page.keyboard.type.bind(page.keyboard);
    page.keyboard.type = (...a) => { typed++; return orig(...a); };
    try {
      const r = await smartFillForm(page, { fields: [{ keys: ['Name'], value: 'Ann' }] });
      assert.equal(r.filled[0].retyped, undefined);
      const r2 = await actFast(page, { action: 'fill', selector: '#n', value: 'Bob' });
      assert.equal(r2.retyped, undefined);
      assert.equal(typed, 0);
    } finally {
      page.keyboard.type = orig;
    }
  });
});

describe('round 9 item 2: click on a disabled target fails fast for every target kind', () => {
  const HTML = `<button id="b" disabled><span>Save profile</span></button>
    <div id="a" role="button" aria-disabled="true"><span>Post now</span></div>
    <fp-x></fp-x><script>customElements.define('fp-x', class extends HTMLElement { constructor(){ super(); this.attachShadow({mode:'open'}).innerHTML='<div role="button" aria-disabled="true"><span>Shadow commit</span></div>'; } });</script>`;
  const fast = async (params) => {
    const t0 = Date.now();
    await assert.rejects(actFast(page, params), (e) => /target is disabled/.test(e.message), JSON.stringify(params));
    const ms = Date.now() - t0;
    // The old behaviour waited the full 8 s timeout; 1 s leaves room for a loaded CI box.
    assert.ok(ms < 1000, `${JSON.stringify(params)} took ${ms} ms`);
  };
  it('text, selector and ref targets', async () => {
    await page.setContent(HTML);
    await fast({ action: 'click', text: 'Save profile' });
    await fast({ action: 'click', text: 'Post now' });
    await fast({ action: 'click', text: 'Shadow commit' });
    await fast({ action: 'click', selector: '#b span' });
    const snap = await inspectCompact(page, { mode: 'interactive' }, new Set());
    const ref = /\[(f0:e\d+)\] <button> "Save profile"/.exec(snap.text)?.[1];
    assert.ok(ref, snap.text);
    await fast({ action: 'click', ref });
  });
});

describe('round 9 item 3: delta baselines', () => {
  let seq = 0;
  const mk = () => { const tag = `fp-host-${++seq}`; return `<body><button id="add">Add link</button><div id="dlg" role="dialog"><${tag}></${tag}></div><div id="tail"></div>
    <script>
    customElements.define('${tag}', class extends HTMLElement { constructor(){ super(); this.attachShadow({mode:'open'}).innerHTML='<label>Name <input></label>'; } });
    for (let i = 0; i < 25; i++) { const b = document.createElement('button'); b.textContent = 'Filler ' + i; document.getElementById('dlg').appendChild(b); }
    document.getElementById('add').onclick = () => {
      for (const t of ['Display Text', 'Custom URL']) {
        const h = document.createElement('div'); h.attachShadow({mode:'open'}).innerHTML = '<label>' + t + ' <input></label>';
        document.getElementById('tail').appendChild(h);
      }
    };
    </script></body>`; };
  it('a snapshot in another mode does not replace the forms baseline', async () => {
    await page.setContent(mk());
    const set = new Set();
    await inspectCompact(page, { mode: 'forms', onlyChanged: true }, set);
    await actFast(page, { action: 'click', selector: '#add', returnSnapshot: true }, set);
    const r = await inspectCompact(page, { mode: 'forms', onlyChanged: true }, set);
    assert.match(r.text, /\*\[f0:e\d+\] <input:text> "Display Text"/, r.text);
    assert.match(r.text, /\*\[f0:e\d+\] <input:text> "Custom URL"/, r.text);
    assert.doesNotMatch(r.text, /"Add link"/, r.text);
  });
  it('elements cut off by maxChars are not marked as seen', async () => {
    await page.setContent(mk());
    const set = new Set();
    await inspectCompact(page, { mode: 'forms' }, set);
    const cut = await actFast(page, { action: 'click', selector: '#add', returnSnapshot: true, snapshotMode: 'forms', snapshotMaxChars: 300 }, set);
    assert.doesNotMatch(cut.snapshot, /Display Text/, 'fixture: the new inputs must be cut off');
    const r = await inspectCompact(page, { mode: 'forms', onlyChanged: true }, set);
    assert.match(r.text, /\*\[f0:e\d+\] <input:text> "Display Text"/, r.text);
    assert.match(r.text, /\*\[f0:e\d+\] <input:text> "Custom URL"/, r.text);
  });
});

describe('round 9 item 4: pointer-only clickable items', () => {
  it('lists every item of a dialog list (not just 8) and pointer+tabindex/onclick items elsewhere', async () => {
    const lis = Array.from({ length: 12 }, (_, i) => `<li style="cursor:pointer">Network ${i}</li>`).join('');
    await page.setContent(`<div role="dialog"><ul>${lis}</ul></div>
      <ul><li tabindex="0" style="cursor:pointer">Alpha row</li></ul>
      <div onclick="window.__x=1" style="cursor:pointer">Beta row</div>
      <div style="cursor:pointer">Plain card</div>`);
    const r = await inspectCompact(page, { mode: 'interactive', maxChars: 6000 });
    for (let i = 0; i < 12; i++) assert.match(r.text, new RegExp(`"Network ${i}"`), r.text);
    assert.match(r.text, /"Alpha row"/);
    assert.match(r.text, /"Beta row"/);
    assert.doesNotMatch(r.text, /"Plain card"/, 'pointer cursor alone, outside a dialog, is not enough');
  });
  it('does not flood a page of pointer cards with no handlers', async () => {
    const cards = Array.from({ length: 120 }, (_, i) => `<div style="cursor:pointer"><p>Card ${i}</p></div>`).join('');
    await page.setContent(`<button>Go</button>${cards}`);
    const r = await inspectCompact(page, { mode: 'interactive', maxChars: 6000 });
    assert.equal((r.text.match(/\[f0:e\d+\]/g) || []).length, 1, r.text);
  });
});

describe('round 9 item 5: toast after an action', () => {
  const page5 = (extra = '') => `<button id="go">Save</button>${extra}
    <div role="status" id="old">Saved earlier</div>
    <script>go.onclick = () => fetch('/a').then(() => {
      const d = document.createElement('div'); d.setAttribute('role', 'alert'); d.textContent = "This domain isn't allowed."; document.body.appendChild(d);
    });</script>`;
  it('act_fast with an aftermath window surfaces the new alert once', async () => {
    await page.goto(base + '/a');
    await page.setContent(page5());
    const r = await actFast(page, { action: 'click', selector: '#go', returnSnapshot: true });
    assert.equal(r.toast, "This domain isn't allowed.", JSON.stringify(r));
    const again = await actFast(page, { action: 'click', selector: '#old', returnSnapshot: true });
    assert.equal(again.toast, undefined, 'the same alert is not reported twice');
  });
  it('a long toast is cut to 120 characters; shadow DOM toast-like class is found', async () => {
    await page.goto(base + '/a');
    await page.setContent(`<button id="go">Go</button><x-t></x-t><script>
      customElements.define('x-t', class extends HTMLElement { constructor(){ super(); this.attachShadow({mode:'open'}); } });
      go.onclick = () => fetch('/a').then(() => { const d = document.createElement('div'); d.className = 'snackbar-toast'; d.textContent = 'Z'.repeat(300); document.querySelector('x-t').shadowRoot.appendChild(d); });</script>`);
    const r = await actFast(page, { action: 'click', selector: '#go', returnSnapshot: true });
    assert.ok(r.toast && r.toast.length <= 120 && r.toast.startsWith('ZZZ'), JSON.stringify(r));
  });
  it('batch click with allowSubmit surfaces it; no toast key when nothing appears', async () => {
    await page.goto(base + '/a');
    await page.setContent(page5());
    const b = await batchActions(page, [{ action: 'click', selector: '#go' }], { allowSubmit: true });
    assert.equal(b.results[0].toast, "This domain isn't allowed.", JSON.stringify(b));
    await page.goto(base + '/a');
    await page.setContent('<button id="x">Plain</button><div role="status">Always here</div>');
    const n = await actFast(page, { action: 'click', selector: '#x', returnSnapshot: true });
    assert.equal('toast' in n, false, JSON.stringify(n));
  });
});

describe('round 9 item 6: smart_fill_form submitButtons', () => {
  it('skips account-connection buttons and ranks the filled form first; Save ... counts', async () => {
    const conn = ['Facebook', 'Google', 'MLH'].map((n) => `<form method="post" action="/c"><button type="submit">Connect ${n} Account</button></form>`).join('');
    await page.setContent(`${conn}<form id="p" onsubmit="return false"><label>Name <input name="n"></label><button type="submit">Save Profile Information</button></form>`);
    const r = await smartFillForm(page, { fields: [{ keys: ['Name'], value: 'Ann' }] });
    const texts = r.submitButtons.map((b) => b.text);
    assert.equal(texts[0], 'Save Profile Information', JSON.stringify(texts));
    assert.ok(!texts.some((t) => /connect/i.test(t)), JSON.stringify(texts));
  });
  it('a type=button "Save ..." is listed; OAuth sign-in buttons are not', async () => {
    await page.setContent(`<div><label>Bio <input name="b"></label><button type="button">Save changes</button></div>
      <button type="button">Sign in with Google</button><button type="button">Continue with GitHub</button><button type="button">Disconnect Twitter account</button>`);
    const r = await smartFillForm(page, { fields: [{ keys: ['Bio'], value: 'x' }] });
    const texts = r.submitButtons.map((b) => b.text);
    assert.deepEqual(texts, ['Save changes'], JSON.stringify(texts));
  });
});

describe('round 9 item 7: capture_page pdf honours print CSS', () => {
  const pages = (b) => (b.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  const CV = '<style>@page{margin:0}html,body{margin:0}.p{height:296mm;background:#ddd}.screen-only{height:50mm}@media print{.screen-only{display:none}}</style><div class="screen-only">menu</div><div class="p">CV</div>';
  it('a one-page A4 CV is one page, also on the CDP fallback path, and media emulation is restored', async () => {
    await page.setContent(CV);
    const dir = fs.mkdtempSync(path.join(process.cwd(), 'r9pdf-'));
    try {
      const a = path.join(dir, 'a.pdf');
      await capturePage(page, { mode: 'pdf', savePath: a });
      assert.equal(pages(fs.readFileSync(a)), 1);
      const realPdf = page.pdf.bind(page);
      page.pdf = async () => { throw new Error('headed chrome: pdf unsupported'); };
      try {
        const b = path.join(dir, 'b.pdf');
        await capturePage(page, { mode: 'pdf', savePath: b });
        assert.equal(pages(fs.readFileSync(b)), 1, 'fallback path');
      } finally {
        page.pdf = realPdf;
      }
      assert.equal(await page.evaluate(() => matchMedia('print').matches), false, 'print emulation restored');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('round 9 item 8: batch reload/back/forward and unknown actions', () => {
  it('navigates, goes back and forward and reloads', async () => {
    hits.b = 0;
    const r = await batchActions(page, [
      { action: 'navigate', url: `${base}/a` },
      { action: 'navigate', url: `${base}/b` },
      { action: 'back' },
      { action: 'forward' },
      { action: 'reload' },
    ]);
    assert.equal(r.error, undefined, JSON.stringify(r));
    assert.equal(r.completed, 5);
    assert.match(r.results[2].url, /\/a$/);
    assert.match(r.results[3].url, /\/b$/);
    assert.match(await page.textContent('#n'), /hit \d+/);
    assert.ok(hits.b >= 2, `reload must hit the server again (hits ${hits.b})`);
  });
  it('unknown actions are named', async () => {
    const r = await batchActions(page, [{ action: 'frobnicate' }], { continueOnError: true });
    assert.match(JSON.stringify(r), /unknown batch action: frobnicate/);
  });
});

describe('round 9 item 9: type reports truncation', () => {
  it('maxlength: mismatch for both typing paths; none when the text fits or appends', async () => {
    await page.setContent('<textarea id="t" maxlength="10"></textarea><input id="i" value="ab"><input id="p" type="password" maxlength="4">');
    const long = 'abcdefghijklmnopqrstuvwxyz';
    const a = await actFast(page, { action: 'type', selector: '#t', value: long });
    assert.match(a.mismatch || '', /abcdefghij/, JSON.stringify(a));
    await page.fill('#t', '');
    const b = await actFast(page, { action: 'type', selector: '#t', value: long, slowly: false });
    assert.match(b.mismatch || '', /abcdefghij/, JSON.stringify(b));
    const ok = await actFast(page, { action: 'type', selector: '#i', value: 'cd' });
    assert.equal(ok.mismatch, undefined, JSON.stringify(ok));
    const pw = await actFast(page, { action: 'type', selector: '#p', value: 'hunter2hunter2' });
    assert.ok(pw.mismatch, JSON.stringify(pw));
    assert.doesNotMatch(pw.mismatch, /hunt/);
  });
  it('with a secrets file the mismatch text never echoes the field value', async () => {
    const f = path.join(os.tmpdir(), `r9-secrets-${process.pid}.env`);
    fs.writeFileSync(f, 'TOK=abcdefgh\n');
    process.env.TURBO_BROWSER_SECRETS_FILE = f;
    try {
      await page.setContent('<input id="t" maxlength="5">');
      const r = await actFast(page, { action: 'type', selector: '#t', value: 'abcdefgh' });
      assert.equal(r.mismatch, 'field value differs from the typed value', JSON.stringify(r));
    } finally {
      delete process.env.TURBO_BROWSER_SECRETS_FILE;
      fs.rmSync(f, { force: true });
    }
  });
});

describe('round 9 item 10: extract on a page without text yet', () => {
  it('waits for SPA text that arrives within about 2 s', async () => {
    await page.goto(`${base}/spa`);
    const r = await extractCleanText(page, {});
    assert.match(r.text, /Hello SPA content/, r.text);
    assert.equal(r.note, undefined);
  });
  it('says so when there is still no text, after a bounded wait', async () => {
    await page.goto(`${base}/spa-empty`);
    const t0 = Date.now();
    const r = await extractCleanText(page, {});
    const ms = Date.now() - t0;
    assert.equal(r.note, 'page has no text yet', JSON.stringify(r));
    assert.ok(ms >= 1500 && ms < 3500, `waited ${ms} ms`);
  });
  it('a page with text does not wait', async () => {
    await page.setContent('<p>Plain text here</p>');
    const t0 = Date.now();
    const r = await extractCleanText(page, {});
    assert.ok(Date.now() - t0 < 600);
    assert.equal(r.note, undefined);
  });
  it('selector main works with nested positioned/overflow containers and under an aria-hidden app root', async () => {
    await page.setContent('<div style="position:relative;overflow:hidden"><main><div style="position:relative;overflow:hidden;height:300px"><div style="position:absolute;inset:0;overflow:auto"><div style="position:absolute;top:0;left:0"><p>Nested visible words</p></div></div></div></main></div>');
    assert.match((await extractCleanText(page, { selector: 'main' })).text, /Nested visible words/);
    await page.setContent('<div id="root" aria-hidden="true"><main><p>Modal-covered words</p></main></div><div role="dialog">Dialog</div>');
    assert.match((await extractCleanText(page, { selector: 'main' })).text, /Modal-covered words/);
  });
});

describe('round 9 item 11: aftermath does not call a link or a search form a submit', () => {
  let other, otherBase;
  before(async () => {
    other = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>Other</title><p>other site</p>');
    });
    await new Promise((r) => other.listen(0, '127.0.0.1', r));
    otherBase = `http://127.0.0.1:${other.address().port}`;
  });
  after(async () => { await new Promise((r) => other.close(r)); });
  it('plain link to another origin: navigated, not unexpectedSubmit', async () => {
    await page.goto(`${base}/a`);
    await page.setContent(`<a id="l" href="${otherBase}/post/">Title link</a>`);
    const b = await batchActions(page, [{ action: 'click', selector: '#l' }], { observeAftermath: true });
    const a = b.results[0].aftermath;
    assert.equal(a.navigated, true, JSON.stringify(a));
    assert.equal(a.unexpectedSubmit, false, JSON.stringify(a));
    assert.equal(a.warning, undefined);
  });
  it('GET search form: not unexpectedSubmit; POST form: still flagged', async () => {
    await page.goto(`${base}/a`);
    await page.setContent('<form action="/spa-empty" method="get"><input type="search" name="q" value="x"><button id="g" type="submit">Search</button></form>');
    const g = await actFast(page, { action: 'click', selector: '#g', observeAftermath: true });
    assert.equal(g.aftermath.navigated, true, JSON.stringify(g));
    assert.equal(g.aftermath.unexpectedSubmit, false, JSON.stringify(g.aftermath));
    await page.goto(`${base}/a`);
    await page.setContent('<form action="/spa-empty" method="post"><input name="n" value="x"><button id="p" type="submit">Continue</button></form>');
    const p = await actFast(page, { action: 'click', selector: '#p', observeAftermath: true });
    assert.equal(p.aftermath.unexpectedSubmit, true, JSON.stringify(p.aftermath));
  });
});

describe('round 9 item 12: open_many reports bot walls', () => {
  it('a "Prove your humanity" page is blocked in open_many, open and navigate alike', async () => {
    const wall = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>Reddit - Prove your humanity</title><p>Please wait</p>');
    });
    await new Promise((r) => wall.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${wall.address().port}/`;
    try {
      const r = await m.tabsBatch([{ action: 'open_many', urls: [url], isolatedContext: 'r9wall' }]);
      assert.match(JSON.stringify(r), /"blocked":"bot-wall"/, JSON.stringify(r));
      const o = await m.tabsBatch([{ action: 'open', url, isolatedContext: 'r9wall' }]);
      assert.match(JSON.stringify(o), /"blocked":"bot-wall"/, JSON.stringify(o));
    } finally {
      await new Promise((r) => wall.close(r));
    }
  });
});

describe('round 9 item 13: collect href follows the textSelector link', () => {
  it('uses the title link, not the row\'s first anchor', async () => {
    await page.setContent(`<table>
      <tr class="athing"><td><a href="/vote?id=1&how=up">up</a></td><td><span class="titleline"><a href="https://a.example/post-1">First post</a></span></td></tr>
      <tr class="athing"><td><a href="/vote?id=2&how=up">up</a></td><td><span class="titleline"><a href="https://b.example/post-2"><b>Second</b> post</a></span></td></tr>
      <tr class="athing"><td><a href="/vote?id=3&how=up">up</a></td><td><span class="titleline">No link here</span></td></tr></table>`);
    const r = await batchActions(page, [{ action: 'collect', selector: 'tr.athing', textSelector: '.titleline a', fields: ['text', 'href'] }]);
    const items = r.results[0].items;
    assert.equal(items[0].href, 'https://a.example/post-1', JSON.stringify(items));
    assert.equal(items[1].href, 'https://b.example/post-2', JSON.stringify(items));
    const row = await batchActions(page, [{ action: 'collect', selector: 'tr.athing', textSelector: '.titleline', fields: ['text', 'href'] }]);
    assert.match(row.results[0].items[2].text, /No link here/);
    assert.match(row.results[0].items[0].href, /vote\?id=1/, 'unchanged when the text element is not a link');
  });
});
