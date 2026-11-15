// sim-carbon-recheck5: Round-7 Pre-Opus independent deep audit suite (gemini-auditor-6).
//
// Part 1 ("R7-REG-01..05"): Independent regression verification of #155 fixes (R6O-BUG-01..05),
// including microtask/macrotask-0 deferred auto-submits, drag drop guard, cross-frame act_fast &
// upload guard, closed Shadow DOM across main/srcdoc/about:blank/popup + attachShadow toString,
// and HTML §4.10.22.2 multi-field buttonless implicit Enter behavior.
//
// Part 2 ("R7-BUG-01a..07b"): Deterministic real-Chromium reproductions of newly uncovered defects
// in src/dom-engine.mjs and src/browser-manager.mjs, each paired with positive controls proving
// native Chromium behavior on the exact fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, inspectCompact, smartFillForm } from '../src/dom-engine.mjs';
import { loadPlaywright, resolveChromiumExecutable } from '../src/playwright-loader.mjs';

const COUNTER_SCRIPT = `<script>
  window.__submits = 0;
  window.__submittedIds = [];
  document.addEventListener('submit', function (e) {
    e.preventDefault();
    window.__submits++;
    if (e.target && e.target.id) window.__submittedIds.push(e.target.id);
  });
</script>`;

const htmlDoc = (body, withCounter = true) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>r7-recheck5</title></head><body>${withCounter ? COUNTER_SCRIPT : ''}${body}</body></html>`;

describe('sim-carbon-recheck5: Round-7 pre-Opus deep audit suite', { concurrency: 1 }, () => {
  let tmpDir;
  let uploadFile;
  let server;
  let baseUrl;
  let manager;
  let page;
  const dynamicPages = new Map();

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-r7-recheck5-'));
    uploadFile = path.join(tmpDir, 'sample.txt');
    fs.writeFileSync(uploadFile, 'round7-sample-payload');

    server = http.createServer((req, res) => {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (dynamicPages.has(u.pathname)) {
        res.end(dynamicPages.get(u.pathname));
        return;
      }
      res.end(htmlDoc('<p>blank</p>'));
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    manager = new BrowserManager({ mode: 'launch', userDataDir: tmpDir, headless: true, defaultTimeoutMs: 4000 });
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/blank` }]);
    ({ page } = await manager.getPage());
  });

  after(async () => {
    await manager?.close().catch(() => {});
    if (server) await new Promise((resolve) => server.close(resolve));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const setRoute = (routePath, html) => {
    dynamicPages.set(routePath, html);
  };

  const gotoRoute = async (routePath) => {
    await page.goto(`${baseUrl}${routePath}`, { waitUntil: 'load' });
  };

  const getSubmits = (targetPage = page) => targetPage.evaluate(() => window.__submits || 0);

  describe('Round-7 regression verification of #155 (R6O-BUG-01..05)', () => {
    it('R7-REG-01 smart_fill_form Pass 1 & act_fast block microtask/Promise/setTimeout(0) deferred auto-submits and restore prototypes', async () => {
      setRoute(
        '/reg01',
        htmlDoc(`
          <form id="f1" action="/submit" method="post">
            <label>Country
              <select id="country" name="country" onchange="Promise.resolve().then(() => queueMicrotask(() => this.form.requestSubmit()))">
                <option value="">--</option>
                <option value="vn">Vietnam</option>
                <option value="jp">Japan</option>
              </select>
            </label>
            <label>Code
              <input id="code" name="code" oninput="setTimeout(() => this.form.requestSubmit(), 0)">
            </label>
            <label>
              <input id="agree" type="checkbox" name="agree" onchange="queueMicrotask(() => this.form.submit())"> Agree terms
            </label>
            <button type="submit">Place order</button>
          </form>
        `)
      );

      await gotoRoute('/reg01');
      const guarded = await smartFillForm(page, {
        stopBeforeSubmit: true,
        fields: [
          { keys: 'Country', value: 'Vietnam' },
          { keys: 'Code', value: 'PROMO7' },
          { keys: 'Agree terms', value: true },
        ],
      });
      assert.equal(guarded.filledCount, 3);
      await page.evaluate(() => new Promise((r) => setTimeout(r, 30)));
      assert.equal(await getSubmits(), 0, 'deferred microtask/macrotask-0 submits must be blocked');

      const actSel = await actFast(page, { action: 'select', selector: '#country', value: 'jp', allowSubmit: false });
      assert.equal(actSel.ok, true);
      await page.evaluate(() => new Promise((r) => setTimeout(r, 30)));
      assert.equal(await getSubmits(), 0);

      const protoNative = await page.evaluate(() =>
        [HTMLFormElement.prototype.submit, HTMLFormElement.prototype.requestSubmit].every((fn) =>
          Function.prototype.toString.call(fn).includes('[native code]')
        )
      );
      assert.equal(protoNative, true, 'HTMLFormElement prototypes must be restored after guard');

      // Positive control: stopBeforeSubmit=false allows deferred auto-submit
      await gotoRoute('/reg01');
      await smartFillForm(page, {
        stopBeforeSubmit: false,
        fields: [{ keys: 'Country', value: 'Vietnam' }],
      });
      await page.evaluate(() => new Promise((r) => setTimeout(r, 30)));
      assert.equal(await getSubmits(), 1);
    });

    it('R7-REG-02 act_fast drag blocks synchronous and microtask drop auto-submits when allowSubmit=false, allows when true', async () => {
      setRoute(
        '/reg02',
        htmlDoc(`
          <style>
            #chip, #zone { width: 90px; height: 50px; display: inline-block; border: 1px solid #333; margin: 8px; }
          </style>
          <div id="chip" draggable="true">Item</div>
          <div id="zone">Drop here</div>
          <form id="df" action="/submit" method="post"><input name="item" value="1"><button type="submit">Pay now</button></form>
          <script>
            window.__dropped = 0;
            const chip = document.getElementById('chip');
            const zone = document.getElementById('zone');
            chip.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', '1'); });
            zone.addEventListener('dragover', (e) => e.preventDefault());
            zone.addEventListener('drop', (e) => {
              e.preventDefault();
              window.__dropped++;
              document.getElementById('df').requestSubmit();
              queueMicrotask(() => document.getElementById('df').requestSubmit());
            });
          </script>
        `)
      );

      await gotoRoute('/reg02');
      const blockedDrag = await actFast(page, {
        action: 'drag',
        selector: '#chip',
        targetSelector: '#zone',
        allowSubmit: false,
      });
      assert.equal(blockedDrag.ok, true);
      assert.equal(await page.evaluate(() => window.__dropped), 1);
      assert.equal(await getSubmits(), 0);

      await gotoRoute('/reg02');
      const allowedDrag = await actFast(page, {
        action: 'drag',
        selector: '#chip',
        targetSelector: '#zone',
        allowSubmit: true,
      });
      assert.equal(allowedDrag.ok, true);
      assert.ok((await getSubmits()) >= 1);
    });

    it('R7-REG-03 act_fast & smart_fill_form Pass 2 upload guard cross-frame requestSubmit() across parent and child iframes', async () => {
      setRoute(
        '/reg03-child',
        htmlDoc(`
          <label>Tier
            <select id="tier" onchange="parent.document.getElementById('parentForm').requestSubmit()">
              <option value="free">Free</option>
              <option value="pro">Pro</option>
            </select>
          </label>
          <label>Doc <input id="docFile" type="file" onchange="parent.document.getElementById('parentForm').requestSubmit()"></label>
        `)
      );
      setRoute(
        '/reg03-main',
        htmlDoc(`
          <form id="parentForm" action="/submit" method="post"><input name="x" value="1"><button type="submit">Pay now</button></form>
          <iframe id="cf" src="/reg03-child" style="width:400px;height:200px"></iframe>
        `)
      );

      await gotoRoute('/reg03-main');
      const selRes = await actFast(page, { action: 'select', frameIdx: 1, selector: '#tier', value: 'pro', allowSubmit: false });
      assert.equal(selRes.ok, true);
      assert.equal(await getSubmits(), 0);

      const upRes = await smartFillForm(page, {
        stopBeforeSubmit: true,
        fields: [{ keys: 'Doc', file: uploadFile }],
      });
      assert.equal(upRes.filledCount, 1);
      assert.equal(await getSubmits(), 0);
    });

    it('R7-REG-04 closed Shadow DOM submit guard & native attachShadow.toString() hold across main frame, srcdoc, dynamic about:blank iframe, and popup', async () => {
      const closedCompScript = `<style>x-closed-pay { display: inline-block; }</style><script>
        customElements.define('x-closed-pay', class extends HTMLElement {
          constructor() {
            super();
            const sr = this.attachShadow({ mode: 'closed', delegatesFocus: true });
            sr.innerHTML = '<form action="/submit" style="display:inline-block"><button type="submit" style="padding:10px 20px">Pay now</button></form>';
            sr.querySelector('form').addEventListener('submit', (e) => {
              e.preventDefault();
              window.__submits = (window.__submits || 0) + 1;
            });
          }
        });
      </script>`;

      setRoute('/reg04-popup', htmlDoc(`${closedCompScript}<x-closed-pay id="popHost"></x-closed-pay>`));
      const srcdocHtml = `<!doctype html><html><body><script>window.__submits=0;</script>${closedCompScript}<x-closed-pay id="sdHost"></x-closed-pay></body></html>`;
      const safeDynJson = JSON.stringify(srcdocHtml.replace('sdHost', 'dynHost')).replace(/<\//g, '<\\/');
      const safeAttrSrcdoc = srcdocHtml
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;');
      setRoute(
        '/reg04-main',
        htmlDoc(`
          ${closedCompScript}
          <x-closed-pay id="mainHost"></x-closed-pay>
          <iframe id="sdFrame" srcdoc="${safeAttrSrcdoc}" style="width:320px;height:120px"></iframe>
          <div id="dynMount"></div>
          <button id="openPopupBtn" type="button" onclick="window.open('/reg04-popup')">Open Popup</button>
          <script>
            const dyn = document.createElement('iframe');
            dyn.id = 'dynFrame';
            document.getElementById('dynMount').appendChild(dyn);
            const ddoc = dyn.contentDocument;
            ddoc.open();
            ddoc.write(${safeDynJson});
            ddoc.close();
          </script>
        `)
      );

      await gotoRoute('/reg04-main');
      const toStringCheck = await page.evaluate(() =>
        Function.prototype.toString.call(Element.prototype.attachShadow).includes('[native code]')
      );
      assert.equal(toStringCheck, true, 'attachShadow Proxy must preserve native Function.prototype.toString');

      const mainClick = await actFast(page, { action: 'click', selector: '#mainHost', allowSubmit: false });
      assert.equal(mainClick.blocked, true);
      const mainEnter = await actFast(page, { action: 'press', selector: '#mainHost', key: 'Enter', allowSubmit: false });
      assert.equal(mainEnter.blocked, true);
      assert.equal(await getSubmits(), 0);

      const sdClick = await actFast(page, { action: 'click', frameIdx: 1, selector: '#sdHost', allowSubmit: false });
      assert.equal(sdClick.blocked, true);
      assert.equal(await page.frames()[1].evaluate(() => window.__submits || 0), 0);

      const dynClick = await actFast(page, { action: 'click', frameIdx: 2, selector: '#dynHost', allowSubmit: false });
      assert.equal(dynClick.blocked, true);
      assert.equal(await page.frames()[2].evaluate(() => window.__submits || 0), 0);

      const [popup] = await Promise.all([
        page.waitForEvent('popup'),
        actFast(page, { action: 'click', selector: '#openPopupBtn', allowSubmit: false }),
      ]);
      try {
        await popup.waitForLoadState('load');
        const popClick = await actFast(popup, { action: 'click', selector: '#popHost', allowSubmit: false });
        assert.equal(popClick.blocked, true);
        assert.equal(await getSubmits(popup), 0);

        const popAllowed = await actFast(popup, { action: 'click', selector: '#popHost', allowSubmit: true });
        assert.equal(popAllowed.ok, true);
        assert.equal(await getSubmits(popup), 1);
      } finally {
        await popup.close().catch(() => {});
      }
    });

    it('R7-REG-05 HTML §4.10.22.2 multi-field buttonless forms (default/uppercase/bogus/disabled/external inputs) allow Enter; 1-field blocks', async () => {
      setRoute(
        '/reg05',
        htmlDoc(`
          <form id="multiDefault" action="/s"><input id="md1" value="a"><input id="md2" type="bogus" value="b"></form>
          <form id="multiUpper" action="/s"><input id="mu1" TYPE="EMAIL" value="a@b.co"><input id="mu2" disabled value="x"></form>
          <form id="multiExt" action="/s"><input id="me1" value="a"></form>
          <input id="me2" form="multiExt" value="b">
          <form id="singleHidden" action="/s"><input type="hidden" name="csrf" value="1"><input id="sh1" value="only"></form>
        `)
      );

      await gotoRoute('/reg05');
      for (const sel of ['#md1', '#mu1', '#me1']) {
        const res = await actFast(page, { action: 'press', selector: sel, key: 'Enter', allowSubmit: false });
        assert.equal(res.ok, true, `${sel} in 2-blocking-input buttonless form must not over-block: ${JSON.stringify(res)}`);
      }
      assert.equal(await getSubmits(), 0);

      const singleRes = await actFast(page, { action: 'press', selector: '#sh1', key: 'Enter', allowSubmit: false });
      assert.equal(singleRes.blocked, true, '1-blocking-input + hidden input buttonless form must still block Enter');
      assert.equal(await getSubmits(), 0);
    });
  });

  describe('Round-7 newly uncovered defects in src/dom-engine.mjs & src/browser-manager.mjs', () => {
    it('R7-BUG-01a smart_fill_form Pass 1 blocks cross-frame auto-submits (iframe -> parent and parent -> iframe) when stopBeforeSubmit=true', async () => {
      setRoute(
        '/bug01a-child',
        htmlDoc(`
          <form id="childForm" action="javascript:void(window.__submits++)"><input name="c" value="1"><button type="submit">Pay child</button></form>
          <label>Child Name <input id="cName" oninput="parent.document.getElementById('parentForm').requestSubmit()"></label>
          <label>Child Plan
            <select id="cPlan" onchange="queueMicrotask(() => parent.document.getElementById('parentForm').requestSubmit())">
              <option value="">--</option>
              <option value="pro">Pro</option>
            </select>
          </label>
          <label><input id="cOpt" type="checkbox" onchange="parent.document.getElementById('parentForm').submit()"> Child Opt</label>
        `)
      );
      setRoute(
        '/bug01a-main',
        htmlDoc(`
          <form id="parentForm" action="javascript:void(window.__submits++)"><input name="p" value="1"><button type="submit">Pay parent</button></form>
          <label>Parent Note <input id="pNote" oninput="document.getElementById('cf').contentDocument.getElementById('childForm').requestSubmit()"></label>
          <iframe id="cf" src="/bug01a-child" style="width:420px;height:220px"></iframe>
        `)
      );

      // Positive control: stopBeforeSubmit=false triggers cross-frame submit
      await gotoRoute('/bug01a-main');
      await smartFillForm(page, {
        stopBeforeSubmit: false,
        fields: [{ keys: 'Child Name', value: 'Alice' }],
      });
      assert.equal(await getSubmits(), 1, 'positive control: child oninput submits parentForm when unguarded');

      // Defect check: stopBeforeSubmit=true must block BOTH parent->child and child->parent Pass-1 auto-submits
      await gotoRoute('/bug01a-main');
      const res = await smartFillForm(page, {
        stopBeforeSubmit: true,
        fields: [
          { keys: 'Parent Note', value: 'Hello' },
          { keys: 'Child Name', value: 'Alice' },
          { keys: 'Child Plan', value: 'Pro' },
          { keys: 'Child Opt', value: true },
        ],
      });
      assert.equal(res.filledCount, 4);
      await page.evaluate(() => new Promise((r) => setTimeout(r, 30)));
      const parentSubmits = await getSubmits();
      const childSubmits = await page.frames()[1].evaluate(() => window.__submits || 0);
      assert.equal(parentSubmits, 0, `Pass 1 iframe->parent auto-submit leaked (${parentSubmits} submits)`);
      assert.equal(childSubmits, 0, `Pass 1 parent->iframe auto-submit leaked (${childSubmits} submits)`);
    });

    it('R7-BUG-01b smart_fill_form Pass 1.5 [role="combobox"] (clickWidgetSafely) blocks cross-frame auto-submits across parent and iframe', async () => {
      setRoute(
        '/bug01b-child',
        htmlDoc(`
          <form id="childForm" action="/submit-child" method="post"><input name="c" value="1"><button type="submit">Pay child</button></form>
          <label id="lblRegion">Region</label>
          <div id="combo" role="combobox" aria-labelledby="lblRegion" aria-expanded="false" tabindex="0"
               onclick="this.setAttribute('aria-expanded','true'); document.getElementById('lb').style.display='block';"
               style="width:160px;height:32px;border:1px solid #333">Select region</div>
          <div id="lb" role="listbox" style="display:none">
            <div role="option" style="padding:6px"
                 onclick="document.getElementById('combo').textContent='APAC'; parent.document.getElementById('parentForm').requestSubmit();">APAC</div>
          </div>
        `)
      );
      setRoute(
        '/bug01b-main',
        htmlDoc(`
          <form id="parentForm" action="/submit-parent" method="post"><input name="p" value="1"><button type="submit">Pay parent</button></form>
          <label id="lblCurrency">Currency</label>
          <div id="pCombo" role="combobox" aria-labelledby="lblCurrency" aria-expanded="false" tabindex="0"
               onclick="this.setAttribute('aria-expanded','true'); document.getElementById('pLb').style.display='block';"
               style="width:160px;height:32px;border:1px solid #333">Select currency</div>
          <div id="pLb" role="listbox" style="display:none">
            <div role="option" style="padding:6px"
                 onclick="document.getElementById('pCombo').textContent='USD'; document.getElementById('cf').contentDocument.getElementById('childForm').requestSubmit();">USD</div>
          </div>
          <iframe id="cf" src="/bug01b-child" style="width:420px;height:220px"></iframe>
        `)
      );

      await gotoRoute('/bug01b-main');
      const res = await smartFillForm(page, {
        stopBeforeSubmit: true,
        fields: [
          { keys: 'Region', value: 'APAC' },
          { keys: 'Currency', value: 'USD' },
        ],
      });
      assert.equal(res.filledCount, 2);
      await page.evaluate(() => new Promise((r) => setTimeout(r, 30)));
      const parentSubmits = await getSubmits();
      const childSubmits = await page.frames()[1].evaluate(() => window.__submits || 0);
      assert.equal(parentSubmits, 0, `Pass 1.5 iframe combobox submitted parentForm (${parentSubmits}x)`);
      assert.equal(childSubmits, 0, `Pass 1.5 parent combobox submitted childForm (${childSubmits}x)`);
    });

    it('R7-BUG-02 smart_fill_form Pass 1 preserves filledCount when onchange detaches iframe via setTimeout(0) or navigates iframe', async () => {
      setRoute(
        '/bug02-child-detach',
        htmlDoc(`
          <label>Plan
            <select id="plan" onchange="parent.__chosenPlan = this.value; setTimeout(() => { if (window.frameElement) window.frameElement.remove(); }, 0);">
              <option value="">--</option>
              <option value="pro">Pro</option>
            </select>
          </label>
        `)
      );
      setRoute(
        '/bug02-child-nav',
        htmlDoc(`
          <label>Seat
            <select id="seat" onchange="parent.__chosenSeat = this.value; location.href = '/blank';">
              <option value="">--</option>
              <option value="aisle">Aisle</option>
            </select>
          </label>
        `)
      );
      setRoute(
        '/bug02-main',
        htmlDoc(`
          <script>window.__chosenPlan = ''; window.__chosenSeat = '';</script>
          <iframe id="fDetach" src="/bug02-child-detach" style="width:300px;height:100px"></iframe>
          <iframe id="fNav" src="/bug02-child-nav" style="width:300px;height:100px"></iframe>
        `)
      );

      await gotoRoute('/bug02-main');
      const res = await smartFillForm(page, {
        stopBeforeSubmit: true,
        fields: [
          { keys: 'Plan', value: 'Pro' },
          { keys: 'Seat', value: 'Aisle' },
        ],
      });
      const state = await page.evaluate(() => ({ plan: window.__chosenPlan, seat: window.__chosenSeat }));
      assert.equal(state.plan, 'pro');
      assert.equal(state.seat, 'aisle');
      assert.equal(res.filledCount, 2, `Pass 1 lost frameFilled results during async guard flush: ${JSON.stringify(res)}`);
    });

    it('R7-BUG-03 isSubmitLikeElement delegates focus via getSR on closed delegatesFocus hosts (blocks Space on inner danger button & safe-prefix spoof)', async () => {
      setRoute(
        '/bug03',
        htmlDoc(`
          <script>
            window.__deleted = 0;
            window.__spoofSubmits = 0;
            customElements.define('x-closed-del-card', class extends HTMLElement {
              constructor() {
                super();
                const sr = this.attachShadow({ mode: 'closed', delegatesFocus: true });
                sr.innerHTML = '<h2>Account overview</h2><button type="button" style="padding:8px 16px">Delete account</button>';
                sr.querySelector('button').addEventListener('click', () => { window.__deleted++; });
              }
            });
            customElements.define('x-closed-spoof-card', class extends HTMLElement {
              constructor() {
                super();
                const sr = this.attachShadow({ mode: 'closed', delegatesFocus: true });
                sr.innerHTML = '<div>Continue</div><form action="/submit"><button type="submit" style="padding:8px 16px">Go</button></form>';
                sr.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); window.__spoofSubmits++; });
              }
            });
          </script>
          <x-closed-del-card id="delHost"></x-closed-del-card>
          <x-closed-spoof-card id="spoofHost"></x-closed-spoof-card>
        `)
      );

      await gotoRoute('/bug03');
      const delSpace = await actFast(page, { action: 'press', selector: '#delHost', key: 'Space', allowSubmit: false });
      assert.equal(delSpace.blocked, true, `Space on closed delegatesFocus danger card must block: ${JSON.stringify(delSpace)}`);
      assert.equal(await page.evaluate(() => window.__deleted), 0);

      const spoofSpace = await actFast(page, { action: 'press', selector: '#spoofHost', key: 'Space', allowSubmit: false });
      assert.equal(spoofSpace.blocked, true, `Space on closed delegatesFocus card with "Continue" sibling must block inner submit button: ${JSON.stringify(spoofSpace)}`);
      assert.equal(await page.evaluate(() => window.__spoofSubmits), 0);
    });

    it('R7-BUG-04a untargeted press Enter/Space resolves closed-Shadow activeElement, cross-iframe ShadowRoot, and <x-btn type="submit"> wrapping <button type="button">', async () => {
      setRoute(
        '/bug04a-child',
        htmlDoc(`
          <script>
            customElements.define('x-child-closed-del', class extends HTMLElement {
              constructor() {
                super();
                const sr = this.attachShadow({ mode: 'closed' });
                sr.innerHTML = '<h2>Workspace</h2><button id="cDel" type="button">Delete account</button>';
                const btn = sr.querySelector('#cDel');
                btn.addEventListener('click', () => { parent.__childDeleted++; });
                window.__focusChildClosedDel = () => btn.focus();
              }
            });
            customElements.define('x-child-sub-btn', class extends HTMLElement {
              constructor() {
                super();
                const sr = this.attachShadow({ mode: 'open' });
                sr.innerHTML = '<button id="innerBase" type="button"><slot></slot></button>';
                sr.querySelector('#innerBase').addEventListener('click', () => {
                  parent.__childSubClicked++;
                  const f = this.closest('form');
                  if (f) f.requestSubmit();
                });
              }
            });
          </script>
          <x-child-closed-del id="ccd"></x-child-closed-del>
          <form id="cfSub" action="/s"><x-child-sub-btn id="csb" type="submit">Go</x-child-sub-btn></form>
        `)
      );
      setRoute(
        '/bug04a-main',
        htmlDoc(`
          <script>
            window.__mainDeleted = 0;
            window.__childDeleted = 0;
            window.__childSubClicked = 0;
            window.__mainSubClicked = 0;
            customElements.define('x-main-closed-del', class extends HTMLElement {
              constructor() {
                super();
                const sr = this.attachShadow({ mode: 'closed' });
                sr.innerHTML = '<h2>Profile</h2><button id="mDel" type="button">Delete account</button>';
                const btn = sr.querySelector('#mDel');
                btn.addEventListener('click', () => { window.__mainDeleted++; });
                window.__focusMainClosedDel = () => btn.focus();
              }
            });
            customElements.define('x-main-sub-btn', class extends HTMLElement {
              constructor() {
                super();
                const sr = this.attachShadow({ mode: 'open', delegatesFocus: true });
                sr.innerHTML = '<button id="mInnerBase" type="button"><slot></slot></button>';
                sr.querySelector('#mInnerBase').addEventListener('click', () => {
                  window.__mainSubClicked++;
                  const f = this.closest('form');
                  if (f) f.requestSubmit();
                });
              }
            });
          </script>
          <x-main-closed-del id="mcd"></x-main-closed-del>
          <form id="mfSub" action="/s"><x-main-sub-btn id="msb" type="submit">Go</x-main-sub-btn></form>
          <iframe id="cf" src="/bug04a-child" style="width:400px;height:200px"></iframe>
        `)
      );

      await gotoRoute('/bug04a-main');

      // 1) Main-frame closed ShadowRoot activeElement + untargeted Enter
      await page.evaluate(() => window.__focusMainClosedDel());
      const rMainClosed = await actFast(page, { action: 'press', key: 'Enter', allowSubmit: false });
      assert.equal(rMainClosed.blocked, true, `untargeted Enter on focused closed-shadow Delete must block: ${JSON.stringify(rMainClosed)}`);
      assert.equal(await page.evaluate(() => window.__mainDeleted), 0);

      // 2) <x-main-sub-btn type="submit">Go</x-main-sub-btn> with delegatesFocus + inner <button type="button">
      const rMainHostSub = await actFast(page, { action: 'press', selector: '#msb', key: 'Enter', allowSubmit: false });
      assert.equal(rMainHostSub.blocked, true, `Enter on <x-main-sub-btn type="submit"> wrapping <button type="button"> must block: ${JSON.stringify(rMainHostSub)}`);
      assert.equal(await page.evaluate(() => window.__mainSubClicked), 0);

      // 3) Child-iframe closed ShadowRoot activeElement + untargeted Enter
      await page.evaluate(() => {
        const ifr = document.getElementById('cf');
        ifr.focus();
        ifr.contentWindow.__focusChildClosedDel();
      });
      const rChildClosed = await actFast(page, { action: 'press', key: 'Enter', allowSubmit: false });
      assert.equal(rChildClosed.blocked, true, `untargeted Enter on child-iframe closed-shadow Delete must block: ${JSON.stringify(rChildClosed)}`);
      assert.equal(await page.evaluate(() => window.__childDeleted), 0);

      // 4) Child-iframe <x-child-sub-btn type="submit">Go</x-child-sub-btn> inner <button type="button"> focused + untargeted Enter
      await page.evaluate(() => {
        const ifr = document.getElementById('cf');
        ifr.focus();
        ifr.contentDocument.getElementById('csb').shadowRoot.getElementById('innerBase').focus();
      });
      const rChildHostSub = await actFast(page, { action: 'press', key: 'Enter', allowSubmit: false });
      assert.equal(rChildHostSub.blocked, true, `untargeted Enter on child-iframe <x-child-sub-btn type="submit"> inner button must block: ${JSON.stringify(rChildHostSub)}`);
      assert.equal(await page.evaluate(() => window.__childSubClicked), 0);
    });

    it('R7-BUG-04b untargeted press Enter/Space on focused safe <button type="submit">Search</button> preserves isSafeSubmit=true', async () => {
      setRoute(
        '/bug04b',
        htmlDoc(`
          <form id="searchForm" action="/search" method="get">
            <input id="q" name="q" value="laptop">
            <button id="sb" type="submit">Search</button>
          </form>
        `)
      );

      await gotoRoute('/bug04b');
      // Baseline: targeted press on #sb allows safe Search submit
      const targeted = await actFast(page, { action: 'press', selector: '#sb', key: 'Enter', allowSubmit: false });
      assert.equal(targeted.ok, true);
      assert.equal(await getSubmits(), 1);

      // Defect check: untargeted press when #sb or #q already has focus must ALSO allow safe Search submit
      await page.focus('#sb');
      const untargetedBtn = await actFast(page, { action: 'press', key: 'Enter', allowSubmit: false });
      assert.equal(untargetedBtn.ok, true);
      assert.equal(await getSubmits(), 2, 'untargeted Enter on focused Search submit button must preserve isSafeSubmit=true');

      await page.focus('#q');
      const untargetedInput = await actFast(page, { action: 'press', key: 'Enter', allowSubmit: false });
      assert.equal(untargetedInput.ok, true);
      assert.equal(await getSubmits(), 3, 'untargeted Enter on focused input inside safe Search form must preserve isSafeSubmit=true');
    });

    it('R7-BUG-05a checkEnterSubmitInBrowser does NOT over-block Enter on checkbox in buttonless form, <fieldset disabled> submit button, or button[form="other"]', async () => {
      setRoute(
        '/bug05a',
        htmlDoc(`
          <form id="fChk" action="/s"><input id="tChk" value="a"><input id="chkOnly" type="checkbox"></form>
          <form id="fFieldset" action="/s">
            <input id="fs1" value="1"><input id="fs2" value="2">
            <fieldset disabled><button type="submit">Place order</button></fieldset>
          </form>
          <form id="otherForm" action="/s"></form>
          <form id="fForeignBtn" action="/s">
            <input id="fb1" value="1"><input id="fb2" value="2">
            <button type="submit" form="otherForm">Place order</button>
          </form>
        `)
      );

      // Positive control: prove native Chromium performs 0 implicit submissions on all 3 cases
      await gotoRoute('/bug05a');
      for (const sel of ['#chkOnly', '#fs1', '#fb1']) {
        await actFast(page, { action: 'press', selector: sel, key: 'Enter', allowSubmit: true });
      }
      assert.equal(await getSubmits(), 0, 'native Chromium must NOT implicitly submit any of these 3 forms');

      // Defect check: allowSubmit=false must NOT pre-block any of these 3 cases as implicit-form-enter
      for (const sel of ['#chkOnly', '#fs1', '#fb1']) {
        const res = await actFast(page, { action: 'press', selector: sel, key: 'Enter', allowSubmit: false });
        assert.equal(res.ok, true, `${sel} was falsely over-blocked as implicit submit: ${JSON.stringify(res)}`);
      }
      assert.equal(await getSubmits(), 0);
    });

    it('R7-BUG-05b checkEnterSubmitInBrowser blocks implicit Enter on 2-field form with aria-disabled="true" submit button or external <input type="image" form="...">', async () => {
      setRoute(
        '/bug05b',
        htmlDoc(`
          <script>window.__ariaBtnClicks = 0; window.__extImgClicks = 0;</script>
          <form id="fAria" action="/s">
            <input id="ar1" value="1"><input id="ar2" value="2">
            <button id="ariaSub" type="submit" aria-disabled="true" onclick="window.__ariaBtnClicks++">Place order</button>
          </form>
          <form id="fExtImg" action="/s">
            <input id="ei1" value="1"><input id="ei2" value="2">
          </form>
          <input id="extImg" type="image" form="fExtImg" alt="Pay now" onclick="window.__extImgClicks++">
        `)
      );

      // Positive control: prove native Chromium implicitly activates & submits BOTH forms on Enter!
      await gotoRoute('/bug05b');
      await actFast(page, { action: 'press', selector: '#ar1', key: 'Enter', allowSubmit: true });
      await actFast(page, { action: 'press', selector: '#ei1', key: 'Enter', allowSubmit: true });
      assert.equal(await page.evaluate(() => window.__ariaBtnClicks), 1, 'native Chromium clicks aria-disabled submit button on Enter');
      assert.equal(await page.evaluate(() => window.__extImgClicks), 1, 'native Chromium clicks external input[type=image][form] on Enter');
      assert.equal(await getSubmits(), 2);

      // Defect check: allowSubmit=false MUST pre-block both (blocked: true, 0 button click side-effects, 0 submits)
      await gotoRoute('/bug05b');
      const rAria = await actFast(page, { action: 'press', selector: '#ar1', key: 'Enter', allowSubmit: false });
      assert.equal(rAria.blocked, true, `Enter with aria-disabled="true" submit button must block: ${JSON.stringify(rAria)}`);
      assert.equal(await page.evaluate(() => window.__ariaBtnClicks), 0);

      const rExtImg = await actFast(page, { action: 'press', selector: '#ei1', key: 'Enter', allowSubmit: false });
      assert.equal(rExtImg.blocked, true, `Enter with external input[type=image][form] must block: ${JSON.stringify(rExtImg)}`);
      assert.equal(await page.evaluate(() => window.__extImgClicks), 0);
      assert.equal(await getSubmits(), 0);
    });

    it('R7-BUG-05c isSafeSubmit=true only exempts the safe control own <form> and still blocks cross-form / cross-frame dangerForm.requestSubmit()', async () => {
      setRoute(
        '/bug05c',
        htmlDoc(`
          <form id="dangerForm" action="/pay" method="post">
            <input name="amount" value="999">
            <button type="submit">Pay now</button>
          </form>
          <form id="searchForm" action="/search" method="get">
            <input id="qHijack" name="q" value="shoes"
                   onkeydown="if (event.key === 'Enter') { event.preventDefault(); document.getElementById('dangerForm').requestSubmit(); }">
            <button id="sbClean" type="submit">Search</button>
          </form>
          <button id="standaloneSearchBtn" type="button" onclick="document.getElementById('dangerForm').requestSubmit()">Search</button>
        `)
      );

      await gotoRoute('/bug05c');
      // 1) Pressing Enter on #qHijack inside safe #searchForm tries to requestSubmit #dangerForm -> MUST be blocked!
      await actFast(page, { action: 'press', selector: '#qHijack', key: 'Enter', allowSubmit: false });
      // 2) Clicking standalone type="button" labelled "Search" tries to requestSubmit #dangerForm -> MUST be blocked!
      await actFast(page, { action: 'click', selector: '#standaloneSearchBtn', allowSubmit: false });
      await page.evaluate(() => new Promise((r) => setTimeout(r, 20)));
      const submittedAfterAttacks = await page.evaluate(() => window.__submittedIds.slice());
      assert.deepEqual(
        submittedAfterAttacks,
        [],
        `isSafeSubmit=true let cross-form dangerForm submit under allowSubmit=false: ${JSON.stringify(submittedAfterAttacks)}`
      );

      // 3) Positive control: clicking #sbClean still submits #searchForm cleanly under allowSubmit=false
      await actFast(page, { action: 'click', selector: '#sbClean', allowSubmit: false });
      const submittedAfterCleanSearch = await page.evaluate(() => window.__submittedIds.slice());
      assert.deepEqual(submittedAfterCleanSearch, ['searchForm']);
    });

    it('R7-BUG-06 inspect_compact & smart_fill_form compose text through closed Shadow DOM labels on light-DOM controls & buttons', async () => {
      setRoute(
        '/bug06',
        htmlDoc(`
          <script>
            customElements.define('x-closed-field-lbl', class extends HTMLElement {
              constructor() {
                super();
                this.attachShadow({ mode: 'closed' }).innerHTML = '<span>Cardholder name</span>';
              }
            });
            customElements.define('x-closed-pay-lbl', class extends HTMLElement {
              constructor() {
                super();
                this.attachShadow({ mode: 'closed' }).innerHTML = '<span>Pay now</span>';
              }
            });
          </script>
          <form id="f6" action="/pay" method="post">
            <label><x-closed-field-lbl></x-closed-field-lbl> <input id="ch" name="ch"></label>
            <button id="payBtn" type="button"><x-closed-pay-lbl></x-closed-pay-lbl></button>
          </form>
        `)
      );

      await gotoRoute('/bug06');
      // Baseline: act_fast already sees "Pay now" via getSR and blocks #payBtn
      const clickRes = await actFast(page, { action: 'click', selector: '#payBtn', allowSubmit: false });
      assert.equal(clickRes.blocked, true);

      // Defect check 1: inspect_compact must show "Cardholder name" and "Pay now" (not fallback id "payBtn")
      const snap = await inspectCompact(page, {});
      assert.ok(snap.text.includes('Cardholder name'), `inspect_compact missed closed-shadow label on <label>: ${snap.text}`);
      assert.ok(snap.text.includes('Pay now'), `inspect_compact missed closed-shadow label on <button>: ${snap.text}`);

      // Defect check 2: smart_fill_form must match "Cardholder name" and report "Pay now" in submitButtons
      const fillRes = await smartFillForm(page, {
        stopBeforeSubmit: true,
        fields: [{ keys: 'Cardholder name', value: 'Nguyen Van A' }],
      });
      assert.equal(fillRes.filledCount, 1, `smart_fill_form missed closed-shadow <label> text: ${JSON.stringify(fillRes)}`);
      assert.equal(await page.locator('#ch').inputValue(), 'Nguyen Van A');
      assert.ok(
        fillRes.submitButtons.some((b) => /Pay now/i.test(b.text || '')),
        `smart_fill_form.submitButtons missed "Pay now": ${JSON.stringify(fillRes.submitButtons)}`
      );
    });

    it('R7-BUG-07a __tbmGetAllShadowRoots releases unmounted ShadowRoots on GC, __tbmGetShadowRoot works cross-realm, and __tbmSubmitGuardActive is non-enumerable', async () => {
      setRoute(
        '/bug07a-child',
        htmlDoc(`
          <script>
            customElements.define('x-child-closed', class extends HTMLElement {
              constructor() {
                super();
                this.attachShadow({ mode: 'closed' }).innerHTML = '<span>secret</span>';
              }
            });
          </script>
          <x-child-closed id="cc"></x-child-closed>
        `)
      );
      setRoute(
        '/bug07a-main',
        htmlDoc(`
          <div id="spaMount"></div>
          <button id="noopBtn" type="button">Ping</button>
          <iframe id="cf" src="/bug07a-child"></iframe>
        `)
      );

      await gotoRoute('/bug07a-main');
      await actFast(page, { action: 'click', selector: '#noopBtn', allowSubmit: false });

      // 1) Enumerable window global check
      const enumKeys = await page.evaluate(() => Object.keys(window).filter((k) => k.startsWith('__tbm')));
      assert.deepEqual(enumKeys, [], `__tbm* globals polluted Object.keys(window): ${JSON.stringify(enumKeys)}`);

      // 2) Cross-realm same-origin __tbmGetShadowRoot(childIframeElement) check
      const crossRealmFound = await page.evaluate(() => {
        const childEl = document.getElementById('cf').contentDocument.getElementById('cc');
        const sr = window.__tbmGetShadowRoot?.(childEl);
        return Boolean(sr && sr.textContent === 'secret');
      });
      assert.equal(crossRealmFound, true, 'window.__tbmGetShadowRoot(el) must resolve closed roots from same-origin child frames');

      // 3) Detached ShadowRoot GC check via CDP HeapProfiler.collectGarbage
      await page.evaluate(() => {
        window.__ephemeralHostRef = (() => {
          const el = document.createElement('div');
          const sr = el.attachShadow({ mode: 'closed' });
          sr.innerHTML = '<span>ephemeral</span>';
          document.getElementById('spaMount').appendChild(el);
          el.remove();
          return new WeakRef(el);
        })();
      });
      const cdp = await page.context().newCDPSession(page);
      try {
        await cdp.send('HeapProfiler.collectGarbage');
        await page.evaluate(() => new Promise((r) => setTimeout(r, 25)));
        await cdp.send('HeapProfiler.collectGarbage');
      } finally {
        await cdp.detach().catch(() => {});
      }
      const leakCheck = await page.evaluate(() => ({
        retained: Boolean(window.__ephemeralHostRef.deref()),
        liveRootCount: window.__tbmGetAllShadowRoots().length,
      }));
      assert.equal(leakCheck.retained, false, `Detached closed-shadow host leaked across GC: ${JSON.stringify(leakCheck)}`);
      assert.equal(leakCheck.liveRootCount, 0, `Detached ShadowRoot remained in __tbmGetAllShadowRoots: ${JSON.stringify(leakCheck)}`);
    });

    it('R7-BUG-07b BrowserManager mode="cdp" injects closed-Shadow-DOM hook into already-open pages without reload', async () => {
      setRoute(
        '/bug07b-spa',
        htmlDoc(`
          <script>
            window.mountClosedCheckout = () => {
              const host = document.createElement('div');
              host.id = 'cdpClosedPay';
              host.style.display = 'inline-block';
              const sr = host.attachShadow({ mode: 'closed' });
              sr.innerHTML = '<form action="/pay"><button type="submit" style="padding:10px 20px">Pay now</button></form>';
              sr.querySelector('form').addEventListener('submit', (e) => {
                e.preventDefault();
                window.__submits++;
              });
              document.body.appendChild(host);
            };
          </script>
          <h1>Existing SPA Tab Before CDP Attach</h1>
        `)
      );

      const cdpPort = await new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
          const p = s.address().port;
          s.close(() => resolve(p));
        });
      });

      const { chromium } = await loadPlaywright();
      const exeOpt = resolveChromiumExecutable(chromium, true);
      const extBrowser = await chromium.launch({
        headless: true,
        ...exeOpt,
        args: [`--remote-debugging-port=${cdpPort}`],
      });
      let cdpMgr = null;
      try {
        const extCtx = await extBrowser.newContext();
        const extPage = await extCtx.newPage();
        await extPage.goto(`${baseUrl}/bug07b-spa`, { waitUntil: 'load' });

        // Attach BrowserManager via CDP to the ALREADY-OPEN tab (no page reload!)
        cdpMgr = new BrowserManager({ mode: 'cdp', cdpUrl: `http://127.0.0.1:${cdpPort}`, defaultTimeoutMs: 4000 });
        const { page: attachedPage } = await cdpMgr.getPage();
        await attachedPage.evaluate(() => window.mountClosedCheckout());

        const res = await actFast(attachedPage, { action: 'click', selector: '#cdpClosedPay', allowSubmit: false });
        const submits = await getSubmits(attachedPage);
        assert.equal(res.blocked, true, `Closed shadow modal on CDP-attached existing page was not blocked: ${JSON.stringify(res)}`);
        assert.equal(submits, 0, `Closed shadow modal on CDP-attached existing page submitted (${submits}x)`);
      } finally {
        await cdpMgr?.close().catch(() => {});
        await extBrowser.close().catch(() => {});
      }
    });

    it('R7-BUG-08a blocked/early-exit actions and dangerous requestSubmit(submitter) must NEVER leak __tbmAllowedSubmit across actions or forms', async () => {
      setRoute(
        '/bug08a',
        htmlDoc(`
          <form id="checkoutForm" action="/pay" method="post">
            <label>Coupon <input id="coupon" name="coupon" oninput="if (this.value === 'AUTO') this.form.requestSubmit()"></label>
            <button id="searchCouponBtn" type="submit">Search</button>
            <button id="payBtn" type="submit">Pay now</button>
          </form>
          <button id="overlayDanger" type="button" style="position:fixed;left:0;top:0;width:520px;height:300px;z-index:99">Delete account</button>
          <form id="hijackSubmitterForm" action="/pay2" method="post">
            <button id="safeHijackBtn" type="submit"
                    onclick="event.preventDefault(); this.form.requestSubmit(document.getElementById('realPaySubmitter'));">Search</button>
            <button id="realPaySubmitter" type="submit">Pay now</button>
          </form>
        `)
      );

      // 1) Click on #searchCouponBtn blocked by #overlayDanger at point must NOT leave checkoutForm.__tbmAllowedSubmit set!
      await gotoRoute('/bug08a');
      const blockedByOverlay = await actFast(page, { action: 'click', selector: '#searchCouponBtn', allowSubmit: false });
      assert.equal(blockedByOverlay.blocked, true);
      await page.evaluate(() => document.getElementById('overlayDanger').remove());
      await actFast(page, { action: 'fill', selector: '#coupon', value: 'AUTO', allowSubmit: false });
      assert.equal(await getSubmits(), 0, 'blocked overlay click leaked __tbmAllowedSubmit onto checkoutForm for later fill!');

      // 2) Drag from #searchCouponBtn to #payBtn (blocked on target) must NOT leak __tbmAllowedSubmit onto checkoutForm!
      await gotoRoute('/bug08a');
      await page.evaluate(() => document.getElementById('overlayDanger').remove());
      const blockedDrag = await actFast(page, {
        action: 'drag',
        selector: '#searchCouponBtn',
        targetSelector: '#payBtn',
        allowSubmit: false,
      });
      assert.equal(blockedDrag.blocked, true);
      await actFast(page, { action: 'fill', selector: '#coupon', value: 'AUTO', allowSubmit: false });
      assert.equal(await getSubmits(), 0, 'blocked drag leaked __tbmAllowedSubmit onto checkoutForm for later fill!');

      // 3) Safe button calling this.form.requestSubmit(dangerousSubmitter) must NOT allow submitting via "Pay now" submitter!
      const hijackClick = await actFast(page, { action: 'click', selector: '#safeHijackBtn', allowSubmit: false });
      assert.equal(hijackClick.ok, true);
      assert.equal(await getSubmits(), 0, 'requestSubmit(realPaySubmitter) must be blocked even on an allowed safe form!');
    });

    it('R7-BUG-08b SPA safe buttons (<button type="button">Sign in</button> and <div role="button">Continue</div>) inside their own <form> remain allowed', async () => {
      setRoute(
        '/bug08b',
        htmlDoc(`
          <form id="loginForm" action="/login" method="post">
            <input name="email" value="user@example.com">
            <button id="spaLoginBtn" type="button" onclick="this.form.requestSubmit()">Sign in</button>
            <div id="roleContinueBtn" role="button" tabindex="0" style="padding:8px;display:inline-block"
                 onclick="this.closest('form').requestSubmit()">Continue</div>
          </form>
        `)
      );

      await gotoRoute('/bug08b');
      const rSpa = await actFast(page, { action: 'click', selector: '#spaLoginBtn', allowSubmit: false });
      assert.equal(rSpa.ok, true);
      assert.equal(await getSubmits(), 1, 'SPA <button type="button" onclick="this.form.requestSubmit()">Sign in</button> must submit own form');

      const rRole = await actFast(page, { action: 'click', selector: '#roleContinueBtn', allowSubmit: false });
      assert.equal(rRole.ok, true);
      assert.equal(await getSubmits(), 2, 'SPA <div role="button" onclick="this.closest(\'form\').requestSubmit()">Continue</div> must submit own form');
    });

    it('R7-BUG-09 isSafeSubmitter & markSafeElementOwnForm resolve aria-labelledby, child alt, closed-shadow labels, and external <label for> (both safe allow & danger block)', async () => {
      setRoute(
        '/bug09',
        htmlDoc(`
          <script>
            customElements.define('x-closed-search-lbl', class extends HTMLElement {
              constructor() {
                super();
                this.attachShadow({ mode: 'closed' }).innerHTML = '<span>Search</span>';
              }
            });
          </script>
          <span id="lblSearch">Search</span>
          <form id="fAria" action="/s">
            <input id="qAria" value="laptop">
            <button id="btnAria" type="submit" aria-labelledby="lblSearch">🔍</button>
          </form>

          <form id="fChildImg" action="/s">
            <button id="btnImg" type="submit"><img alt="Search" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></button>
          </form>

          <form id="fClosedChild" action="/s">
            <button id="btnClosedChild" type="submit"><x-closed-search-lbl></x-closed-search-lbl></button>
          </form>

          <label id="extLabel" for="btnExt" style="display:inline-block;padding:8px;background:#eee"><span id="extSpan">Search</span></label>
          <form id="fExtLabel" action="/s">
            <button id="btnExt" type="submit">🔍</button>
          </form>

          <span id="lblPay">Pay now</span>
          <form id="fDangerAria" action="/pay" method="post">
            <button id="btnSafeHijackAria" type="submit"
                    onclick="event.preventDefault(); this.form.requestSubmit(document.getElementById('btnDangerAria'))">Search</button>
            <button id="btnDangerAria" type="submit" aria-labelledby="lblPay">Next</button>
          </form>
        `)
      );

      await gotoRoute('/bug09');

      // 1) Dangerous submitter whose aria-labelledby="lblPay" ("Pay now") overrides visible text "Next" MUST be blocked in requestSubmit(sub)!
      await actFast(page, { action: 'click', selector: '#btnSafeHijackAria', allowSubmit: false });
      assert.deepEqual(
        await page.evaluate(() => window.__submittedIds.slice()),
        [],
        'isSafeSubmitter must resolve aria-labelledby="lblPay" before innerText "Next" and block requestSubmit(btnDangerAria)!'
      );

      // 2) Legitimate safe Search buttons labelled via aria-labelledby, child img[alt], closed-shadow child, or external <label for> (selector & {x,y}) MUST submit!
      await actFast(page, { action: 'click', selector: '#btnAria', allowSubmit: false });
      await actFast(page, { action: 'press', selector: '#qAria', key: 'Enter', allowSubmit: false });
      await actFast(page, { action: 'click', selector: '#btnImg', allowSubmit: false });
      await actFast(page, { action: 'click', selector: '#btnClosedChild', allowSubmit: false });
      await actFast(page, { action: 'click', selector: '#extSpan', allowSubmit: false });

      const extBox = await page.locator('#extSpan').boundingBox();
      await actFast(page, {
        action: 'click',
        x: Math.round(extBox.x + extBox.width / 2),
        y: Math.round(extBox.y + extBox.height / 2),
        allowSubmit: false,
      });

      assert.deepEqual(
        await page.evaluate(() => window.__submittedIds.slice()),
        ['fAria', 'fAria', 'fChildImg', 'fClosedChild', 'fExtLabel', 'fExtLabel']
      );
    });

    it('R7-BUG-10 act_fast type/focus/hover guard against click/focus/mouseenter form.requestSubmit() under allowSubmit=false while allowing safe Search newline type', async () => {
      setRoute(
        '/bug10',
        htmlDoc(`
          <form id="fTypeClickDanger" action="/pay" method="post">
            <input id="inClickDanger" onclick="this.form.requestSubmit()">
            <button type="submit">Pay now</button>
          </form>
          <form id="fFocusDanger" action="/pay2" method="post">
            <input id="inFocusDanger" onfocus="this.form.requestSubmit()">
            <button type="submit">Pay now</button>
          </form>
          <form id="fHoverDanger" action="/pay3" method="post">
            <div id="hoverZone" style="width:80px;height:30px;background:#ddd" onmouseenter="document.getElementById('fHoverDanger').requestSubmit()">Hover</div>
            <button type="submit">Pay now</button>
          </form>
          <form id="fTypeSafeSearch" action="/search" method="get">
            <input id="inTypeSearch" name="q">
            <button id="btnTypeSearch" type="submit">Search</button>
          </form>
        `)
      );

      await gotoRoute('/bug10');

      // 1) type (which clicks to focus), focus, and hover (selector & {x,y}) MUST NOT allow onclick/onfocus/onmouseenter form.requestSubmit() under allowSubmit=false!
      await actFast(page, { action: 'type', selector: '#inClickDanger', value: 'abc', allowSubmit: false });
      await actFast(page, { action: 'focus', selector: '#inFocusDanger', allowSubmit: false });
      await actFast(page, { action: 'hover', selector: '#hoverZone', allowSubmit: false });
      await page.mouse.move(1, 1);
      const hzBox = await page.locator('#hoverZone').boundingBox();
      await actFast(page, {
        action: 'hover',
        x: Math.round(hzBox.x + hzBox.width / 2),
        y: Math.round(hzBox.y + hzBox.height / 2),
        allowSubmit: false,
      });
      await page.evaluate(() => new Promise((r) => setTimeout(r, 20)));
      assert.deepEqual(
        await page.evaluate(() => window.__submittedIds.slice()),
        [],
        'type/focus/hover leaked unguarded form.requestSubmit() under allowSubmit=false!'
      );

      // 2) Typing query + "\\n" into a safe Search input MUST submit its own safe form under allowSubmit=false!
      await actFast(page, { action: 'type', selector: '#inTypeSearch', value: 'shoes\n', allowSubmit: false });
      assert.deepEqual(
        await page.evaluate(() => window.__submittedIds.slice()),
        ['fTypeSafeSearch'],
        'type with "\\n" into safe Search input must submit fTypeSafeSearch!'
      );
    });
  });
});
