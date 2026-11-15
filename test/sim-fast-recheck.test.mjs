import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, smartFillForm } from '../src/dom-engine.mjs';

describe('Fast Recheck Audit (#170 diff)', { concurrency: 1 }, () => {
  let server1;
  let server2;
  let baseUrl1;
  let baseUrl2;
  let tmpDir;
  let bm;
  let hits = [];

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-fast-recheck-'));
    const handler = (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname.startsWith('/submit')) {
        hits.push(u.pathname + u.search);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Submitted</h1>');
        return;
      }
      if (u.pathname === '/xorigin-child') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!doctype html><html><body>
          <form id="xf" action="/submit-xorigin" method="GET">
            <input id="xi" name="q" value="hello" />
            <button id="xb" type="submit">Pay XOrigin</button>
          </form>
        </body></html>`);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><body>ok</body></html>');
    };

    server1 = http.createServer(handler);
    await new Promise((r) => server1.listen(0, '127.0.0.1', r));
    baseUrl1 = `http://127.0.0.1:${server1.address().port}`;

    server2 = http.createServer(handler);
    await new Promise((r) => server2.listen(0, '127.0.0.1', r));
    baseUrl2 = `http://127.0.0.1:${server2.address().port}`;

    bm = new BrowserManager({
      userDataDir: path.join(tmpDir, 'profile'),
      headless: true,
    });
  });

  after(async () => {
    if (bm) await bm.close().catch(() => {});
    if (server1) await new Promise((r) => server1.close(r));
    if (server2) await new Promise((r) => server2.close(r));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. Cross-origin iframe contentWindow/contentDocument, detached iframe, descriptor toString, and child form.submit()', async () => {
    hits = [];
    const { page } = await bm.getPage();
    await page.goto(`${baseUrl1}/`, { waitUntil: 'load' });

    await page.setContent(`<!doctype html><html><body>
      <iframe id="xframe" src="${baseUrl2}/xorigin-child"></iframe>
    </body></html>`, { waitUntil: 'load' });

    // Check parent accessing cross-origin iframe contentWindow / contentDocument + detached iframe + descriptor toString
    const parentCheck = await page.evaluate(() => {
      const xf = document.getElementById('xframe');
      const cw = xf.contentWindow;
      const cd = xf.contentDocument;
      const detached = document.createElement('iframe');
      const dcw = detached.contentWindow;
      const dcd = detached.contentDocument;
      const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
      const getStr = Function.prototype.toString.call(desc.get);
      return {
        hasCw: Boolean(cw),
        cdIsNull: cd === null,
        dcwIsNull: dcw === null,
        dcdIsNull: dcd === null,
        nativeGetStr: getStr.includes('[native code]'),
      };
    });
    assert.equal(parentCheck.hasCw, true);
    assert.equal(parentCheck.cdIsNull, true);
    assert.equal(parentCheck.dcwIsNull, true);
    assert.equal(parentCheck.dcdIsNull, true);
    assert.equal(parentCheck.nativeGetStr, true);

    // Check inside the cross-origin child frame: does calling form.submit() or requestSubmit() throw SecurityError when reading parentWin.__tbmAllowSafeForm?
    const childFrame = page.frames().find((f) => f.url().includes('/xorigin-child'));
    assert.ok(childFrame, 'Cross-origin child frame should exist');

    // First test under act_fast guard on child frame: must block cleanly WITHOUT throwing SecurityError
    await childFrame.evaluate(() => {
      window.__childSubmitErr = null;
      const btn = document.getElementById('xb');
      btn.type = 'button';
      btn.textContent = 'Run hook';
      btn.onclick = () => {
        try {
          document.getElementById('xf').submit();
        } catch (err) {
          window.__childSubmitErr = `${err.name}: ${err.message}`;
        }
      };
    });
    const actRes = await actFast(page, { action: 'click', selector: '#xb', allowSubmit: false });
    assert.equal(actRes.ok, true);
    assert.equal(hits.length, 0, 'Cross-origin child form.submit() should be blocked under act_fast');
    const childGuardErr = await childFrame.evaluate(() => window.__childSubmitErr);
    assert.equal(childGuardErr, null, `Guarded cross-origin child form.submit() threw: ${childGuardErr}`);

    // Now test normal unguarded form.submit() and form.requestSubmit() inside cross-origin child frame (must not throw SecurityError!)
    const childDirectRes = await childFrame.evaluate(() => {
      try {
        const f = document.getElementById('xf');
        f.addEventListener('submit', (e) => e.preventDefault());
        f.requestSubmit();
        return { ok: true };
      } catch (err) {
        return { ok: false, name: err.name, message: err.message };
      }
    });
    assert.equal(childDirectRes.ok, true, `Cross-origin child requestSubmit threw: ${childDirectRes.name}: ${childDirectRes.message}`);
  });

  it('2. Prototype & property residue check after act_fast and smart_fill_form', async () => {
    const { page } = await bm.getPage();
    await page.goto(`${baseUrl1}/`, { waitUntil: 'load' });
    await page.setContent(`<!doctype html><html><body>
      <form id="f1" action="/submit-residue" onsubmit="event.preventDefault()">
        <input id="in1" name="n" value="" />
        <button id="safe1" type="submit">Save draft</button>
      </form>
    </body></html>`);

    await smartFillForm(page, [{ selector: '#in1', value: 'abc' }], { allowSubmit: false });
    await actFast(page, { action: 'press', selector: '#in1', key: 'Enter', allowSubmit: false });

    const residue = await page.evaluate(() => {
      const f = document.getElementById('f1');
      const winKeys = Object.keys(window).filter((k) => k.startsWith('__tbm'));
      const formKeys = Object.keys(f).filter((k) => k.startsWith('__tbm'));
      const subStr = Function.prototype.toString.call(HTMLFormElement.prototype.submit);
      const reqSubStr = Function.prototype.toString.call(HTMLFormElement.prototype.requestSubmit);
      return {
        winKeys,
        formKeys,
        guardActive: window.__tbmSubmitGuardActive,
        allowSafe: window.__tbmAllowSafeForm,
        hasSafeSubmitterFn: typeof window.__tbmIsSafeSubmitter !== 'undefined',
        hasAllowedOnForm: typeof f.__tbmAllowedSubmit !== 'undefined',
        subNative: subStr.includes('[native code]'),
        reqSubNative: reqSubStr.includes('[native code]'),
      };
    });
    assert.deepEqual(residue.winKeys, []);
    assert.deepEqual(residue.formKeys, []);
    assert.equal(residue.guardActive, 0);
    assert.equal(residue.allowSafe, false);
    assert.equal(residue.hasSafeSubmitterFn, false);
    assert.equal(residue.hasAllowedOnForm, false);
    assert.equal(residue.subNative, true);
    assert.equal(residue.reqSubNative, true);
  });

  it('3. Tree order with external [form="id"] buttons before and after <form>', async () => {
    hits = [];
    const { page } = await bm.getPage();
    await page.goto(`${baseUrl1}/`, { waitUntil: 'load' });

    // Case A: Dangerous external [form="f"] BEFORE <form id="f"><button>Save draft</button></form>
    await page.setContent(`<!doctype html><html><body>
      <button id="ext-danger" type="submit" form="f">Pay now</button>
      <form id="f" action="/submit-tree-a">
        <input id="q" name="q" value="1" />
        <button id="in-safe" type="submit">Save draft</button>
      </form>
    </body></html>`);

    const resA = await actFast(page, { action: 'press', selector: '#q', key: 'Enter', allowSubmit: false });
    assert.equal(resA.blocked, true, 'External dangerous button before form is default button and must block');
    assert.equal(hits.length, 0);

    // Case B: Safe external [form="f"] BEFORE <form id="f"><button>Pay now</button></form>
    await page.setContent(`<!doctype html><html><body>
      <button id="ext-safe" type="submit" form="f">Save draft</button>
      <form id="f" action="/submit-tree-b" onsubmit="event.preventDefault(); window.__treeBSubmitted = (event.submitter && event.submitter.id) || 'none';">
        <input id="q" name="q" value="1" />
        <button id="in-danger" type="submit">Pay now</button>
      </form>
    </body></html>`);

    const resB = await actFast(page, { action: 'press', selector: '#q', key: 'Enter', allowSubmit: false });
    assert.equal(resB.ok, true, 'External safe button before form is default button and must be allowed');
    const treeBSub = await page.evaluate(() => window.__treeBSubmitted);
    assert.equal(treeBSub, 'ext-safe');
  });

  it('4. Key chord parsing for dangerous and non-submit keys', async () => {
    hits = [];
    const { page } = await bm.getPage();
    await page.goto(`${baseUrl1}/`, { waitUntil: 'load' });

    await page.setContent(`<!doctype html><html><body>
      <form id="f" action="/submit-chords">
        <input id="q" name="q" value="test" />
        <button id="pay" type="submit">Pay now</button>
      </form>
    </body></html>`);

    const r1 = await actFast(page, { action: 'press', selector: '#q', key: 'Enter+Shift', allowSubmit: false });
    assert.equal(r1.blocked, true, 'Enter+Shift on input with dangerous default button must block');

    const r2 = await actFast(page, { action: 'press', selector: '#pay', key: 'Space+Alt', allowSubmit: false });
    assert.equal(r2.blocked, true, 'Space+Alt on dangerous button must block');

    const r3 = await actFast(page, { action: 'press', selector: '#q', key: 'Control+Enter', allowSubmit: false });
    assert.equal(r3.blocked, true, 'Control+Enter on input must block');

    for (const safeKey of ['Tab', 'Escape', 'Shift+A', '+']) {
      const rSafe = await actFast(page, { action: 'press', selector: '#q', key: safeKey, allowSubmit: false });
      assert.equal(rSafe.ok, true, `Safe key "${safeKey}" should not be blocked`);
    }
    assert.equal(hits.length, 0);
  });
});
