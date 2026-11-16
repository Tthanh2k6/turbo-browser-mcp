// Offline regression tests for field report round 4 + Facebook notes: rendered-only extract, Freshteam labels,
// evaluate_js savePath contract, text noise, collect step, outboundLinks hint, shifted refs, tabs includeTabs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import {
  actFast,
  batchActions,
  denoiseText,
  extractCleanText,
  inspectCompact,
  smartFillForm,
} from '../src/dom-engine.mjs';
import { dispatchToolCall, TOOL_DEFINITIONS } from '../src/index.mjs';

const TOPDEV = `<!doctype html><title>Job</title><body>
<script>window.__x = "Apply now Log in";</script>
<script type="application/json" id="d">{"cta":"Apply now","menu":"Log in"}</script>
<script>self.__next_f = []; self.__next_f.push([1, "Apply now Log in SSR"]);</script>
<template><button>Apply now</button><a>Log in</a></template>
<noscript><a>Log in</a> Apply now</noscript>
<div hidden>Apply now hidden</div>
<div style="position:absolute;left:-9999px;top:0">Apply now offscreen</div>
<div style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">Apply now screen reader copy</div>
<main><h1>Senior Python Developer</h1><p>Signed in as Alice Nguyen</p><button>APPLIED</button>
<p>${'Build and review backend services for a remote product team. '.repeat(5)}</p></main></body>`;

const FRESHTEAM = `<!doctype html><title>Apply</title><body><form onsubmit="return false">
<div class="row"><label for="gen-1">First Name <span class="req">*</span></label>
<div><input id="other-id-7" name="applicant[lead_attributes[first_name]]"></div></div>
<div class="row"><div class="lbl-text">Last Name*</div><div><div><input name="applicant[lead_attributes[last_name]]"></div></div></div>
<div class="row"><div>Email*</div><div><input name="applicant[lead_attributes[email]]"></div></div>
</form></body>`;

const FB_NOISE = `<!doctype html><title>Feed</title><body><main>
<div>${'<span>Facebook</span><br>'.repeat(33)}</div>
<div>e&#x34F;</div><div>n&#x200D;</div><div>o&#x34F;&#x200D;</div>
<p>Hiring a Python developer, remote, send CV to jobs@example.com ${'Apply today with your portfolio and expected salary. '.repeat(3)}</p>
<p>FacebookFacebookFacebookFacebookFacebook 1 2</p>
</main></body>`;

const VIRTUAL = `<!doctype html><title>Feed</title><body style="margin:0">
<div id="feed" style="height:300px;overflow:auto;position:relative"><div id="sp" style="height:6000px;position:relative"></div></div>
<script>
const H = 60, TOTAL = 100, feed = document.getElementById('feed'), sp = document.getElementById('sp');
function render() {
  const first = Math.floor(feed.scrollTop / H), last = Math.min(TOTAL - 1, first + 6);
  sp.innerHTML = '';
  for (let i = first; i <= last; i++) {
    const d = document.createElement('div');
    d.className = 'post'; d.style.cssText = 'position:absolute;left:0;right:0;height:' + H + 'px;top:' + (i * H) + 'px';
    d.innerHTML = '<a href="/p/' + i + '">Post number ' + i + '</a>';
    sp.appendChild(d);
  }
}
feed.addEventListener('scroll', render); render();
</script></body>`;

const APPLY_MODAL = `<!doctype html><title>Remote job</title><body>
<button id="a" onclick="document.getElementById('m').textContent='Sign up to continue'">Apply Now</button>
<button id="o" onclick="window.__o=1">Save job</button><div id="m"></div>
<script type="application/json" id="__NEXT_DATA__">{"props":{"applyUrl":"https:\\/\\/acme.freshteam.com\\/jobs\\/AbC123\\/senior-dev","logo":"https://cdn.example.com/logo.png","other":"https://example.com/blog"}}</script>
</body>`;

describe('field fixes round 3 (field report round 4 + Facebook)', () => {
  let m;
  let page;
  before(async () => {
    m = new BrowserManager({ mode: 'launch', headless: true });
    ({ page } = await m.getPage());
  });
  after(async () => {
    await m.close();
  });

  it('1: extract_clean_text returns rendered text only (no script, template, noscript, hidden, offscreen or sr-only copies)', async () => {
    await page.setContent(TOPDEV);
    for (const format of ['text', 'markdown']) {
      for (const selector of [undefined, 'body']) {
        const r = await extractCleanText(page, { format, selector });
        assert.match(r.text, /Signed in as Alice Nguyen/, r.text);
        assert.match(r.text, /APPLIED/);
        assert.doesNotMatch(r.text, /Apply now/i, `${format}/${selector}: ${r.text}`);
        assert.doesNotMatch(r.text, /Log in/);
      }
    }
  });

  it('2: Freshteam labels: label[for] with a different id, span marker, sibling divs; trailing * stripped', async () => {
    await page.setContent(FRESHTEAM);
    const snap = await inspectCompact(page, { mode: 'forms', query: 'input' });
    assert.match(snap.text, /"First Name"/, snap.text);
    assert.match(snap.text, /"Last Name"/, snap.text);
    assert.match(snap.text, /"Email"/, snap.text);
    assert.doesNotMatch(snap.text, /"[^"]*\*"/);
    const r = await smartFillForm(page, {
      fields: [{ keys: ['First Name'], value: 'Ada' }, { keys: ['Last Name'], value: 'Lovelace' }, { keys: ['Email'], value: 'a@b.co' }],
    });
    assert.equal(r.filledCount, 3, JSON.stringify(r));
    assert.equal(await page.inputValue('[name="applicant[lead_attributes[last_name]]"]'), 'Lovelace');
  });

  it('2: a plain preceding block is not borrowed when the container has two fields', async () => {
    await page.setContent('<div><div>Phone</div><div><input id="p1"><input id="p2"></div></div>');
    const snap = await inspectCompact(page, { mode: 'forms' });
    assert.match(snap.text, /"p1"/);
    assert.doesNotMatch(snap.text, /"Phone"/);
  });

  it('3: evaluate_js with savePath returns only savePath, bytes and a preview; without savePath unchanged', async () => {
    await page.setContent('<p>x</p>');
    const dir = path.join(process.cwd(), 'tmp', 'ff3');
    const file = path.join(dir, 'out.json');
    try {
      const out = await dispatchToolCall(m, 'evaluate_js', {
        expression: 'Array.from({length: 400}, (_, i) => ({ i, t: "comment text " + i }))',
        savePath: file,
      });
      const j = JSON.parse(out.text);
      assert.equal(j.result, undefined);
      assert.equal(j.bytes, fs.statSync(file).size);
      assert.ok(j.preview.length <= 300 && j.preview.startsWith('['));
      assert.ok(out.text.length < 700, `${out.text.length}`);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 400);
      const plain = JSON.parse((await dispatchToolCall(m, 'evaluate_js', { expression: '1 + 2' })).text);
      assert.equal(plain.result, 3);
      assert.equal(plain.savePath ?? undefined, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4: denoise collapses repeated tokens and strips zero-width noise lines', async () => {
    assert.equal(denoiseText('a\nFacebook\nFacebook\nFacebook\nFacebook\nb'), 'a\nFacebook (x4)\nb');
    assert.equal(denoiseText('x\nFacebook\nFacebook\ny'), 'x\nFacebook\nFacebook\ny');
    assert.equal(denoiseText('1\n2\n3'), '1\n2\n3');
    await page.setContent(FB_NOISE);
    const r = await extractCleanText(page, {});
    assert.doesNotMatch(r.text, /[​-‏͏]/);
    assert.ok((r.text.match(/Facebook/g) || []).length <= 2, r.text);
    assert.match(r.text, /Hiring a Python developer/);
    assert.doesNotMatch(r.text, /^[eno]$/m);
    assert.match(r.text, /\b1 2\b/);
  });

  it('5: batch_actions collect scrolls a virtualized list and returns unique items', async () => {
    await page.setContent(VIRTUAL);
    const r = await batchActions(page, [
      { action: 'collect', selector: '.post', scrolls: 30, waitMs: 60, maxItems: 40, fields: ['text', 'href'] },
    ]);
    const c = r.results[0];
    assert.equal(c.action, 'collect');
    assert.equal(c.count, 40, JSON.stringify(c).slice(0, 300));
    assert.equal(c.truncated, true);
    assert.equal(new Set(c.items.map((i) => i.text)).size, 40);
    assert.equal(c.items[0].text, 'Post number 0');
    assert.match(c.items[39].href, /\/p\/39$/);
    const plain = await batchActions(page, [{ action: 'collect', selector: '.post', scrolls: 2, waitMs: 60 }]);
    assert.ok(plain.results[0].items.every((s) => typeof s === 'string'));
    assert.ok(plain.results[0].count >= 7);
    const none = await batchActions(page, [{ action: 'collect', selector: '.nope', scrolls: 3, waitMs: 20 }]);
    assert.equal(none.results[0].count, 0);
  });

  it('6: an apply click with no navigation or new tab returns outboundLinks; other clicks do not', async () => {
    await page.setContent(APPLY_MODAL);
    const r = await actFast(page, { action: 'click', text: 'Apply Now' });
    assert.deepEqual(r.outboundLinks, ['https://acme.freshteam.com/jobs/AbC123/senior-dev'], JSON.stringify(r));
    assert.equal(r._applyLike, undefined);
    const other = await actFast(page, { action: 'click', selector: '#o' });
    assert.equal(other.outboundLinks, undefined);
    await page.setContent('<button id="x">Apply here</button><script type="application/json">{"u":"https://boards.greenhouse.io/acme/jobs/1"}</script>');
    const viaSelector = await actFast(page, { action: 'click', selector: '#x' });
    assert.deepEqual(viaSelector.outboundLinks, ['https://boards.greenhouse.io/acme/jobs/1'], JSON.stringify(viaSelector));
  });

  it('7: a full re-inspect after an input was inserted above keeps refs stable, so no refs-shifted notice', async () => {
    await page.setContent('<input id="a" placeholder="Link"><input id="b" placeholder="Name"><button>Save</button>');
    const state = new Set();
    const first = await inspectCompact(page, { mode: 'forms' }, state);
    assert.doesNotMatch(first.text, /refs shifted/);
    const same = await inspectCompact(page, { mode: 'forms' }, state);
    assert.doesNotMatch(same.text, /refs shifted/);
    await page.evaluate(() => {
      const n = document.createElement('input');
      n.placeholder = 'New link';
      document.body.prepend(n);
    });
    const after2 = await inspectCompact(page, { mode: 'forms' }, state);
    // Refs never recycle within a document: the old refs stay on their elements and the new input gets a fresh number,
    // so the stopgap notice is obsolete.
    assert.doesNotMatch(after2.text, /refs shifted/, after2.text);
    const linkRef = (t) => /\[(f0:e\d+)\] <input:text> "Link"/.exec(t)?.[1];
    assert.equal(linkRef(after2.text), linkRef(first.text), after2.text);
    assert.ok(Number(/\[f0:e(\d+)\] <input:text> "New link"/.exec(after2.text)?.[1]) > 3, after2.text);
  });

  it('8: tabs_batch includeTabs forces the list on or off; default unchanged', async () => {
    const def = JSON.parse((await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'list' }] })).text);
    assert.ok(Array.isArray(def.tabs));
    const off = JSON.parse((await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'list' }], includeTabs: false })).text);
    assert.equal(off.tabs, undefined);
    assert.equal(off.results[0].tabs, undefined);
    const on = JSON.parse((await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'activate', tabId: def.activeTabId }], includeTabs: true })).text);
    assert.ok(Array.isArray(on.tabs));
    const plain = JSON.parse((await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'activate', tabId: def.activeTabId }] })).text);
    assert.equal(plain.tabs, undefined);
  });

  it('schema: no type arrays, includeTabs and collect documented', () => {
    const s = JSON.stringify(TOOL_DEFINITIONS);
    assert.ok(!s.includes('"type":['));
    const tb = TOOL_DEFINITIONS.find((t) => t.name === 'tabs_batch');
    assert.equal(tb.inputSchema.properties.includeTabs.type, 'boolean');
    assert.match(TOOL_DEFINITIONS.find((t) => t.name === 'batch_actions').inputSchema.properties.steps.description, /collect/);
  });
});
