// Round 20: refs stamped with per-frame CDP loaderId; batch_actions allowSubmit propagation and dev.to page_views beacons.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, inspectCompact } from '../src/dom-engine.mjs';
import { dispatchToolCall } from '../src/index.mjs';

let web, port, m, page;
const base = () => `http://127.0.0.1:${port}`;
const call = async (name, args) => JSON.parse((await dispatchToolCall(m, name, args)).text);

const PAGES = {
  '/doc1': '<title>D1</title><button id="b">First</button>',
  '/doc2': '<title>D2</title><button data-tbm-ref="e1" onclick="document.title=\'trapped\'">Trap</button>',
  '/spa': '<title>SPA</title><button id="b" onclick="document.title=\'clicked-\'+location.pathname+location.hash">Go</button>',
  '/frames': '<title>F</title><button id="m" onclick="document.title=\'main-ok\'">MainBtn</button><iframe id="f1" src="/sub1"></iframe><iframe id="f2" src="/sub2"></iframe>',
  '/sub1': '<button onclick="parent.document.title=\'sub1\'">Sub1Btn</button>',
  '/sub1-next': '<button onclick="parent.document.title=\'sub1-next\'">Sub1Next</button>',
  '/sub2': '<button onclick="parent.document.title=\'sub2\'">Sub2Btn</button>',
  '/bf1': '<title>BF1</title><button id="b" onclick="document.title=\'bf-clicked\'">KeepMe</button><a id="to2" href="/bf2">Next</a><script>window.addEventListener("pageshow",(e)=>{window.__bfPersisted=e.persisted;});</script>',
  '/bf2': '<title>BF2</title><p>Second page</p>',
  '/devto': `<title>Dev</title>
    <button id="pub" onclick="setTimeout(()=>fetch('/api/publish',{method:'POST',body:'ok'}),250)">Publish</button>
    <button id="pv" onclick="fetch('/page_views',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({article_id:42})});setTimeout(()=>fetch('/page_views',{method:'POST',body:'{}'}),250)">Read</button>
    <button id="beacons" onclick="fetch('/pageview',{method:'POST',body:'1'});fetch('/collect',{method:'POST',body:'1'});fetch('/beacon',{method:'POST',body:'1'});fetch('/track',{method:'POST',body:'1'});fetch('/events',{method:'POST',body:'{}'});navigator.sendBeacon('/comments','ping')">Beacons</button>
    <button id="cmt" onclick="fetch('/comments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body_markdown:'hi'})})">Comment</button>
    <button id="cmt-late" onclick="setTimeout(()=>fetch('/comments',{method:'POST',body:'hi'}),250)">LateComment</button>
    <button id="form-ev" onclick="fetch('/events',{method:'POST',body:new URLSearchParams({title:'Meetup',date:'2026-11-20'})})">FormEvent</button>`,
};

before(async () => {
  web = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (req.method !== 'GET') { res.writeHead(200); res.end('ok'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body>${PAGES[p] || ''}</body></html>`);
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  port = web.address().port;
  m = new BrowserManager({ mode: 'launch', headless: true });
  ({ page } = await m.getPage());
});

after(async () => {
  await m?.close().catch(() => {});
  await new Promise((r) => web.close(r));
});

describe('round 20: loaderId ref stamps', () => {
  it('navigation to a new document fails immediately with the previous-document error and no DOM lookup', async () => {
    await page.goto(`${base()}/doc1`);
    const snap = await inspectCompact(page, {});
    const ref = /\[(f0:e\d+)\] <button> "First"/.exec(snap.text)?.[1];
    assert.ok(ref, snap.text);
    await page.goto(`${base()}/doc2`);
    const mf = page.mainFrame();
    const origLocator = mf.locator.bind(mf);
    const origEvaluate = mf.evaluate.bind(mf);
    let domLookups = 0;
    mf.locator = (...a) => { domLookups++; return origLocator(...a); };
    mf.evaluate = (...a) => { domLookups++; return origEvaluate(...a); };
    try {
      await assert.rejects(
        actFast(page, { action: 'click', ref }),
        new RegExp(`^Error: Element ref "${ref}" belongs to a previous document \\(the page navigated since it was issued\\)\\. Run inspect_compact again\\.$`)
      );
      assert.equal(domLookups, 0, `expected 0 DOM lookups, got ${domLookups}`);
    } finally {
      mf.locator = origLocator;
      mf.evaluate = origEvaluate;
    }
    assert.notEqual(await page.title(), 'trapped');
  });

  it('pushState and hash navigation keep refs working', async () => {
    await page.goto(`${base()}/spa`);
    const snap = await inspectCompact(page, {});
    const ref = /\[(f0:e\d+)\] <button> "Go"/.exec(snap.text)?.[1];
    assert.ok(ref, snap.text);
    await page.evaluate(() => {
      history.pushState({}, '', '/spa/step2');
      location.hash = '#sec';
    });
    await actFast(page, { action: 'click', ref });
    assert.equal(await page.title(), 'clicked-/spa/step2#sec');
  });

  it('an iframe navigation invalidates only that frame refs', async () => {
    await page.goto(`${base()}/frames`);
    const snap = await inspectCompact(page, { maxChars: 10000 });
    const mainRef = /\[(f0:e\d+)\] <button> "MainBtn"/.exec(snap.text)?.[1];
    const sub1Ref = /\[(f1:e\d+)\] <button> "Sub1Btn"/.exec(snap.text)?.[1];
    const sub2Ref = /\[(f2:e\d+)\] <button> "Sub2Btn"/.exec(snap.text)?.[1];
    assert.ok(mainRef && sub1Ref && sub2Ref, snap.text);

    await page.evaluate(() => {
      return new Promise((resolve) => {
        const f1 = document.getElementById('f1');
        f1.addEventListener('load', () => resolve(), { once: true });
        f1.src = '/sub1-next';
      });
    });

    await assert.rejects(
      actFast(page, { action: 'click', ref: sub1Ref }),
      new RegExp(`^Error: Element ref "${sub1Ref}" belongs to a previous document \\(the page navigated since it was issued\\)\\. Run inspect_compact again\\.$`)
    );
    await actFast(page, { action: 'click', ref: mainRef });
    assert.equal(await page.title(), 'main-ok');
    await actFast(page, { action: 'click', ref: sub2Ref });
    assert.equal(await page.title(), 'sub2');
  });

  it('bfcache back-navigation keeps refs', async (t) => {
    await page.goto(`${base()}/bf1`, { waitUntil: 'load' });
    const snap = await inspectCompact(page, {});
    const ref = /\[(f0:e\d+)\] <button> "KeepMe"/.exec(snap.text)?.[1];
    assert.ok(ref, snap.text);
    const refId = ref.split(':')[1];

    await page.goto(`${base()}/bf2`, { waitUntil: 'load' });
    await assert.rejects(actFast(page, { action: 'click', ref }), /belongs to a previous document/);

    await page.goBack({ waitUntil: 'load' });
    const restored = await page.evaluate((id) => Boolean(window.__bfPersisted && document.querySelector(`[data-tbm-ref="${id}"]`)), refId);
    if (!restored) {
      t.skip('test browser did not restore page from bfcache');
      return;
    }
    await actFast(page, { action: 'click', ref });
    assert.equal(await page.title(), 'bf-clicked');
  });
});

describe('round 20: possibleSubmit false positives', () => {
  before(async () => {
    await call('tabs_batch', { operations: [{ action: 'navigate', url: `${base()}/devto` }] });
  });

  const checkLate = async () => {
    await new Promise((r) => setTimeout(r, 600));
    return (await call('tabs_batch', { operations: [{ action: 'list' }] })).late;
  };

  it('batch_actions with allowSubmit: true passes allowSubmit to each step and parks no late possibleSubmit', async () => {
    const r = await call('batch_actions', {
      steps: [{ action: 'click', selector: '#pub' }],
      allowSubmit: true,
    });
    assert.equal(r.completed, 1, JSON.stringify(r));
    assert.equal(r.results[0].possibleSubmit, undefined, JSON.stringify(r));
    assert.equal(await checkLate(), undefined);
  });

  it('dev.to-style POST /page_views and small analytics beacons after a click are not reported', async () => {
    const pv = await call('act_fast', { action: 'click', selector: '#pv' });
    assert.equal(pv.possibleSubmit, undefined, JSON.stringify(pv));
    assert.equal(await checkLate(), undefined);

    const b = await call('act_fast', { action: 'click', selector: '#beacons' });
    assert.equal(b.possibleSubmit, undefined, JSON.stringify(b));
  });

  it('a real POST /comments (immediate or late) and a form-encoded POST /events are still reported', async () => {
    const cmt = await call('act_fast', { action: 'click', selector: '#cmt' });
    assert.equal(cmt.possibleSubmit, true, JSON.stringify(cmt));
    assert.match(cmt.request, /^POST 127\.0\.0\.1/);

    await call('act_fast', { action: 'click', selector: '#cmt-late' });
    assert.match(String(await checkLate()), /possibleSubmit: POST 127\.0\.0\.1:\d+\/comments/);

    const fev = await call('act_fast', { action: 'click', selector: '#form-ev' });
    assert.equal(fev.possibleSubmit, true, JSON.stringify(fev));
  });
});
