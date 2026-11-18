// Round 23: local field-bug fixtures; launch our own Chromium, never attach to the user's browser.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, extractCleanText, inspectCompact } from '../src/dom-engine.mjs';
import { dispatchToolCall } from '../src/index.mjs';
import { takeLate } from '../src/aftermath.mjs';

const lines = (text) => text.split('\n').filter((line) => /^\*?\[f\d+:e\d+\]/.test(line));

describe('round 23: field bugs', () => {
  let m, page;
  before(async () => {
    m = new BrowserManager({ mode: 'launch', headless: true });
    ({ page } = await m.getPage());
  });
  beforeEach(async () => { await page.goto('about:blank'); takeLate(page); });
  after(async () => { await m?.close().catch(() => {}); });

  it('1: selector and query already filter together', async () => {
    await page.setContent('<section id="scope"><button>Keep inside</button><button>Discard</button></section><button>Keep outside</button>');
    const snap = await inspectCompact(page, { selector: '#scope', query: 'Keep' });
    assert.equal(lines(snap.text).length, 1, snap.text);
    assert.match(lines(snap.text)[0], /Keep inside/);
  });

  it('2: a Gmail row matches combined text beyond the short label', async () => {
    await page.setContent(`<div role="row"><span>Alice </span><span>${'Weekly update '.repeat(8)}</span><span>project violet</span></div><div role="row"><span>Bob </span><span>Other project</span></div>`);
    const snap = await inspectCompact(page, { query: 'Alice.*project violet' });
    assert.equal(lines(snap.text).length, 1, snap.text);
    assert.match(lines(snap.text)[0], /<div:row>/);
  });

  it('3: query reads behind a popup but still excludes CSS-hidden content', async () => {
    await page.setContent('<main aria-hidden="true" inert><button>Violet behind</button><button style="display:none">Violet secret</button></main><div role="dialog" aria-modal="true"><button>Violet popup</button></div>');
    const normal = await inspectCompact(page);
    assert.doesNotMatch(normal.text, /Violet behind/);
    const snap = await inspectCompact(page, { query: 'Violet' });
    assert.match(snap.text, /a popup is open/);
    assert.equal(lines(snap.text).length, 2, snap.text);
    assert.match(lines(snap.text).find((line) => line.includes('Violet behind')), /\[behind popup\]/);
    assert.doesNotMatch(lines(snap.text).find((line) => line.includes('Violet popup')), /behind popup/);
    assert.doesNotMatch(snap.text, /Violet secret/);
  });

  it('4: act_fast already forwards snapshotQuery through dispatch', async () => {
    await page.setContent('<button id="open">Open</button><button>Keep this</button><button>Discard</button>');
    const result = JSON.parse((await dispatchToolCall(m, 'act_fast', {
      action: 'click', selector: '#open', returnSnapshot: true, snapshotQuery: '^.*Keep this',
    })).text);
    assert.equal(lines(result.snapshot).length, 1, result.snapshot);
    assert.match(lines(result.snapshot)[0], /Keep this/);
  });

  it('5: a small maxChars still returns mostly content: the URL/title header shrinks, the total stays capped', async () => {
    const content = 'Readable content for the job description. '.repeat(20);
    await page.setContent(`<title>${'Long title '.repeat(30)}</title><main>${content}</main>`);
    for (const format of ['text', 'markdown']) {
      const result = await extractCleanText(page, { selector: 'main', format, maxChars: 120 });
      assert.ok(result.text.length <= 120, result.text);
      assert.ok(!result.text.includes('Long title'), result.text);
      const body = result.text.split('\n\n')[1].split('\n... [truncated]')[0];
      assert.ok(body.length >= 60, result.text);
      assert.ok(content.startsWith(body), result.text);
      assert.equal(result.truncated, true);
      assert.equal(result.charCount, result.text.length);
    }
  });

  it('6: Gmail background RPCs and late sync are quiet; real sends still report', async () => {
    // All URLs, including Google-shaped ones, are fulfilled locally by Playwright.
    await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<button id="go">Open draft</button>' }));
    try {
      await page.goto('https://mail.google.com/mail/u/0/');
      for (const observeAftermath of [false, true]) {
        await page.evaluate(() => {
          document.querySelector('#go').onclick = () => {
            for (const name of ['signaler', 'taskassist', 'peoplestack']) {
              fetch('https://' + name + '-pa.clients6.google.com/rpc', { method: 'POST', body: '{}' });
            }
          };
        });
        const opened = await actFast(page, { action: 'click', selector: '#go', returnSnapshot: true, observeAftermath });
        assert.equal(opened.possibleSubmit, undefined, JSON.stringify(opened));
        await page.evaluate(() => fetch('/mail/u/0/?act=sync', { method: 'POST', body: 'act=sync' }));
        assert.equal(takeLate(page), '');
        await page.evaluate(() => {
          document.querySelector('#go').onclick = () => fetch('/mail/u/0/?act=sm', { method: 'POST', body: 'act=sm&to=alice&body=hello' });
        });
        const sent = await actFast(page, { action: 'click', selector: '#go', returnSnapshot: true, observeAftermath });
        assert.equal(sent.possibleSubmit, true, JSON.stringify(sent));
      }
    } finally { await page.unroute('**/*'); }
  });

  it('7: clipped checkboxes use their label or visible checkbox wrapper and verify state', async () => {
    await page.setContent(`<style>input { position:absolute; width:1px; height:1px; clip-path:inset(50%); opacity:0; pointer-events:none }</style>
      <input id="labelled" type="checkbox"><label for="labelled">Accept terms</label>
      <div role="checkbox" onclick="document.querySelector('#wrapped').checked = !document.querySelector('#wrapped').checked"><input id="wrapped" type="checkbox">Enable alerts</div>`);
    for (const selector of ['#labelled', '#wrapped']) {
      await actFast(page, { action: 'check', selector, timeoutMs: 400 });
      assert.equal(await page.locator(selector).isChecked(), true);
      await actFast(page, { action: 'check', selector, timeoutMs: 400 });
      assert.equal(await page.locator(selector).isChecked(), true);
      await actFast(page, { action: 'uncheck', selector, timeoutMs: 400 });
      assert.equal(await page.locator(selector).isChecked(), false);
    }
  });

  it('8: a background target renders via requestAnimationFrame without activation', async () => {
    const other = await m.tabsBatch([{ action: 'open', url: 'about:blank', activate: false }]);
    const tabId = other.results[0].tabId;
    const bg = m.tabs.get(tabId), active = m.activeTabId;
    const cdp = await bg.context().newCDPSession(bg);
    try {
      await bg.setContent('<button onclick="requestAnimationFrame(() => document.body.append(\'Compose ready\'))">Compose</button>');
      await page.bringToFront();
      await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
      // Queue rendering on the frozen target. A tool must resume it before reading/acting.
      const action = dispatchToolCall(m, 'act_fast', { tabId, action: 'click', text: 'Compose', timeoutMs: 700 });
      await action;
      await bg.waitForFunction(() => document.body.textContent.includes('Compose ready'), undefined, { timeout: 1000 });
      assert.equal(m.activeTabId, active);
    } finally {
      await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
      await cdp.detach();
      await bg.close();
    }
  });

  it('9: navigating another tab preserves activeTabId unless activate is true', async () => {
    const active = m.activeTabId;
    const opened = await m.tabsBatch([{ action: 'open', url: 'about:blank', activate: false }]);
    const tabId = opened.results[0].tabId;
    try {
      await m.tabsBatch([{ action: 'navigate', tabId, url: 'data:text/html,<title>Background</title>' }]);
      assert.equal(m.activeTabId, active);
      await m.tabsBatch([{ action: 'navigate', tabId, url: 'about:blank', activate: true }]);
      assert.equal(m.activeTabId, tabId);
    } finally {
      await m.tabs.get(tabId).close();
      m.activeTabId = active;
    }
  });

  it('10: first-call list already waits for connection and discovers existing tabs', async () => {
    const fresh = new BrowserManager({ mode: 'launch', headless: true });
    const init = fresh._init.bind(fresh);
    fresh._init = async () => { await init(); await fresh.context.newPage(); };
    try {
      const result = JSON.parse((await dispatchToolCall(fresh, 'tabs_batch', { operations: [{ action: 'list' }] })).text);
      assert.equal(result.connectionType, 'launch');
      assert.ok(result.tabs.length > 0);
    } finally { await fresh.close(); }
  });

  it('11: compose links retain separate text and accessible labels across snapshots', async () => {
    await page.setContent('<div role="dialog"><form><div contenteditable="true"><a href="/one">First link</a> <a href="/two">Second link</a></div><a href="/three" aria-labelledby="third">Fallback</a><span id="third">Third link</span></form></div>');
    const state = new Set();
    for (let i = 0; i < 2; i++) {
      const snap = await inspectCompact(page, {}, state);
      const links = lines(snap.text).filter((line) => line.includes('<a>'));
      for (const [name, href] of [['First', 'one'], ['Second', 'two'], ['Third', 'three']]) {
        assert.ok(links.some((line) => line.includes(`"${name} link"`) && line.includes(`href="/${href}"`)), snap.text);
      }
    }
  });

  it('12: a field named by a generated id is labelled by its nearby question text', async () => {
    await page.setContent(`<form><div><div><span>Why is this role perfect for you? *</span></div><div><textarea name="b6c16dc1-d7c5-4555-94f2-20e2f9839680" id=":r6:"></textarea></div></div><input name="email" placeholder="Email"></form>`);
    const snap = await inspectCompact(page, { mode: 'forms' });
    assert.match(snap.text, /<textarea> "Why is this role perfect for you\?"/, snap.text);
    assert.ok(!/b6c16dc1/.test(snap.text), snap.text);
    assert.match(snap.text, /"Email"/, snap.text);
  });
});
