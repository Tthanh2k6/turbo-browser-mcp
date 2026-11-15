import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BrowserManager } from '../src/browser-manager.mjs';
import {
  actFast,
  batchActions,
  evaluateJs,
  extractCleanText,
  inspectCompact,
  resolveSafePath,
  smartFillForm,
} from '../src/dom-engine.mjs';
import { createJsonRpcHandler, dispatchToolCall } from '../src/index.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRY_PATH = path.resolve(TEST_DIR, '..', 'src', 'index.mjs');

function startAuditServer() {
  const routes = new Map();
  const submissions = [];

  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = parsed.pathname;

    if (pathname.startsWith('/submit-')) {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        submissions.push({
          method: req.method,
          path: pathname,
          body,
        });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end('<!doctype html><html><body>Submitted</body></html>');
      });
      return;
    }

    const custom = routes.get(pathname);
    if (custom) {
      custom(req, res, parsed);
      return;
    }

    if (pathname.startsWith('/api/')) {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ ok: true, path: pathname, search: parsed.search }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        submissions,
        clearSubmissions() {
          submissions.length = 0;
        },
        setRoute(pathname, htmlOrFn) {
          if (typeof htmlOrFn === 'function') {
            routes.set(pathname, htmlOrFn);
          } else {
            routes.set(pathname, (_req, res) => {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(htmlOrFn);
            });
          }
        },
      });
    });
  });
}

describe('Deep Adversarial Code Audit & Stress Suite (sim-carbon-audit)', () => {
  let srv;
  let manager;
  let savedSaveRoot;
  let savedAllowSubmit;
  let tmpRoot;
  let allowedDir;
  let outsideDir;

  before(async () => {
    savedSaveRoot = process.env.TURBO_BROWSER_SAVE_ROOT;
    savedAllowSubmit = process.env.TURBO_BROWSER_ALLOW_SUBMIT;
    delete process.env.TURBO_BROWSER_ALLOW_SUBMIT;

    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-carbon-audit-'));
    allowedDir = path.join(tmpRoot, 'allowed');
    outsideDir = path.join(tmpRoot, 'outside');
    fs.mkdirSync(allowedDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    process.env.TURBO_BROWSER_SAVE_ROOT = allowedDir;

    srv = await startAuditServer();
    manager = new BrowserManager({ mode: 'launch', headless: true });
  });

  after(async () => {
    if (savedSaveRoot === undefined) delete process.env.TURBO_BROWSER_SAVE_ROOT;
    else process.env.TURBO_BROWSER_SAVE_ROOT = savedSaveRoot;

    if (savedAllowSubmit === undefined) delete process.env.TURBO_BROWSER_ALLOW_SUBMIT;
    else process.env.TURBO_BROWSER_ALLOW_SUBMIT = savedAllowSubmit;

    await manager?.close();
    if (srv?.server) {
      await new Promise((resolve) => srv.server.close(resolve));
    }
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('1. Submit Guard blocks Unicode NFD combining-mark & ZWSP submit labels while allowing NFD safe login/wizard buttons', async () => {
    srv.clearSubmissions();
    const nfdGui = 'Gửi'.normalize('NFD');
    const nfdThanhToan = '💳 Thanh toán'.normalize('NFD');
    const nfdXoa = 'Xóa'.normalize('NFD');
    const nfdDatHang = 'Đặt hàng'.normalize('NFD');
    const nfdDangNhap = '🔐 Đăng nhập'.normalize('NFD');
    const nfdTiepTuc = 'Tiếp tục'.normalize('NFD');

    srv.setRoute(
      '/nfd-guard',
      `<!doctype html><html><head><meta charset="utf-8"><title>NFD Guard</title></head><body>
        <script>
          window.fireSubmit = (tag) => fetch('/submit-nfd?src=' + encodeURIComponent(tag), { method: 'POST', body: tag });
        </script>
        <button id="nfd-gui" type="button" onclick="fireSubmit('gui')">${nfdGui}</button>
        <div id="nfd-pay" role="button" tabindex="0" style="display:inline-block;padding:8px;" onclick="fireSubmit('pay')">${nfdThanhToan}</div>
        <a id="nfd-del" href="#del" role="button" onclick="fireSubmit('del'); return false;">${nfdXoa}</a>
        <button id="nfd-order" type="button" onclick="fireSubmit('order')">${nfdDatHang}</button>
        <button id="zwsp-pub" type="button" onclick="fireSubmit('zwsp')">\u200B\uFEFFPublish</button>

        <form onsubmit="window.__safeNfdCount = (window.__safeNfdCount || 0) + 1; return false;">
          <button id="nfd-login" type="submit">${nfdDangNhap}</button>
          <button id="nfd-next" type="submit">${nfdTiepTuc}</button>
        </form>
      </body></html>`
    );

    const { page } = await manager.getPage();
    await page.goto(`${srv.baseUrl}/nfd-guard`, { waitUntil: 'domcontentloaded' });

    for (const sel of ['#nfd-gui', '#nfd-pay', '#nfd-del', '#nfd-order', '#zwsp-pub']) {
      const clickRes = await actFast(page, { action: 'click', selector: sel, allowSubmit: false });
      assert.equal(clickRes.ok, false, `Expected ${sel} click to be blocked`);
      assert.equal(clickRes.blocked, true, `Expected ${sel} blocked=true`);
    }

    // Coordinate click & Enter press on NFD button must also be blocked
    const guiBox = await page.locator('#nfd-gui').boundingBox();
    const coordRes = await actFast(page, {
      action: 'click',
      x: Math.round(guiBox.x + guiBox.width / 2),
      y: Math.round(guiBox.y + guiBox.height / 2),
      allowSubmit: false,
    });
    assert.equal(coordRes.blocked, true, 'Coordinate click on NFD "Gửi" must be blocked');

    const enterRes = await actFast(page, {
      action: 'press',
      selector: '#nfd-order',
      key: 'Enter',
      allowSubmit: false,
    });
    assert.equal(enterRes.blocked, true, 'Enter press on NFD "Đặt hàng" must be blocked');

    // smartFillForm submitButtons discovery must detect NFD submit labels
    const fillScan = await smartFillForm(page, { fields: [] });
    assert.ok(
      fillScan.submitButtons.length >= 4,
      `Expected smartFillForm submitButtons to include NFD buttons, got ${JSON.stringify(fillScan.submitButtons)}`
    );

    // Safe NFD buttons ("Đăng nhập", "Tiếp tục" on type="submit") must be allowed
    const safeLogin = await actFast(page, { action: 'click', selector: '#nfd-login', allowSubmit: false });
    assert.equal(safeLogin.ok, true, 'Safe NFD "Đăng nhập" button should be allowed');
    const safeNext = await actFast(page, { action: 'click', selector: '#nfd-next', allowSubmit: false });
    assert.equal(safeNext.ok, true, 'Safe NFD "Tiếp tục" button should be allowed');
    assert.equal(await page.evaluate(() => window.__safeNfdCount), 2);
    assert.equal(srv.submissions.length, 0, 'Zero unauthorized submissions allowed');
  });

  it('2. Submit Guard pierces Shadow DOM both ways: inner shadow child inside <button type=submit> AND shadow-hosted [role=button] text', async () => {
    srv.clearSubmissions();
    srv.setRoute(
      '/shadow-submit-traps',
      `<!doctype html><html><head><meta charset="utf-8"><title>Shadow Submit Traps</title></head><body>
        <form id="wc-form" method="POST" action="/submit-shadow-wc">
          <button id="light-submit-btn" type="submit" style="padding:0;border:none;">
            <x-icon-inner id="icon-host" style="display:inline-block;width:120px;height:44px;"></x-icon-inner>
          </button>
        </form>

        <x-design-button id="custom-publish-host" role="button" tabindex="0" style="display:inline-block;width:140px;height:44px;cursor:pointer;"></x-design-button>

        <script>
          const iconHost = document.getElementById('icon-host');
          const sr1 = iconHost.attachShadow({ mode: 'open' });
          sr1.innerHTML = '<span id="shadow-glyph" style="display:flex;width:120px;height:44px;align-items:center;justify-content:center;">🚀Go</span>';

          const pubHost = document.getElementById('custom-publish-host');
          const sr2 = pubHost.attachShadow({ mode: 'open' });
          sr2.innerHTML = '<div class="btn-surface" style="width:140px;height:44px;">Publish</div>';
          pubHost.addEventListener('click', () => {
            fetch('/submit-shadow-host', { method: 'POST', body: 'published' });
          });
        </script>
      </body></html>`
    );

    const { page } = await manager.getPage();
    await page.goto(`${srv.baseUrl}/shadow-submit-traps`, { waitUntil: 'domcontentloaded' });

    // 2a. Clicking inner shadow element inside <button type="submit"> by selector, text, and coordinates
    const byInnerSel = await actFast(page, { action: 'click', selector: '#shadow-glyph', allowSubmit: false });
    assert.equal(byInnerSel.blocked, true, 'Click on shadow child inside <button type="submit"> must be blocked');

    const byInnerText = await actFast(page, { action: 'click', text: '🚀Go', allowSubmit: false });
    assert.equal(byInnerText.blocked, true, 'Text click on shadow child inside <button type="submit"> must be blocked');

    const iconBox = await page.locator('#icon-host').boundingBox();
    const byInnerCoords = await actFast(page, {
      action: 'click',
      x: Math.round(iconBox.x + iconBox.width / 2),
      y: Math.round(iconBox.y + iconBox.height / 2),
      allowSubmit: false,
    });
    assert.equal(byInnerCoords.blocked, true, 'Coordinate click on shadow child inside <button type="submit"> must be blocked');

    // 2b. Clicking <x-design-button role="button"> whose "Publish" text lives strictly inside its shadowRoot
    const snap = await inspectCompact(page, { mode: 'interactive' });
    assert.match(snap.text, /Publish/, 'inspectCompact should surface label from open shadowRoot of [role="button"] host');

    const byHostSel = await actFast(page, { action: 'click', selector: '#custom-publish-host', allowSubmit: false });
    assert.equal(byHostSel.blocked, true, 'Click on [role="button"] shadow host with shadow-only "Publish" label must be blocked');

    const byShadowText = await actFast(page, { action: 'click', text: 'Publish', allowSubmit: false });
    assert.equal(byShadowText.blocked, true, 'Text click on shadow text inside [role="button"] host must be blocked');

    const hostBox = await page.locator('#custom-publish-host').boundingBox();
    const byHostCoords = await actFast(page, {
      action: 'click',
      x: Math.round(hostBox.x + hostBox.width / 2),
      y: Math.round(hostBox.y + hostBox.height / 2),
      allowSubmit: false,
    });
    assert.equal(byHostCoords.blocked, true, 'Coordinate click on [role="button"] shadow host must be blocked');

    assert.equal(srv.submissions.length, 0);
  });

  it('3. Submit Guard blocks wrapper center-click (without x,y) AND below-the-fold offscreen offset clicks', async () => {
    srv.clearSubmissions();
    srv.setRoute(
      '/geometry-traps',
      `<!doctype html><html><head><meta charset="utf-8"><title>Geometry Traps</title></head><body style="margin:0;padding:16px;">
        <form method="POST" action="/submit-geometry">
          <div id="center-trap-wrapper" style="position:relative;width:200px;height:80px;border:1px solid #333;">
            <button id="center-submit-child" type="submit" style="position:absolute;left:30px;top:15px;width:140px;height:50px;">Pay Now</button>
          </div>
          <div id="safe-wrapper" onclick="window.__safeWrapClicked = true;" style="width:200px;height:50px;margin-top:8px;background:#eee;">
            <span>Safe Info Card</span>
          </div>
          <div style="height:1800px;">Vertical Spacer</div>
          <div id="offscreen-wrapper" style="position:relative;width:240px;height:100px;border:1px solid #900;">
            <button id="offscreen-submit" type="submit" style="position:absolute;left:40px;top:20px;width:160px;height:60px;">Complete Order</button>
          </div>
        </form>
      </body></html>`
    );

    const { page } = await manager.getPage();
    await page.setViewportSize({ width: 1024, height: 700 });
    await page.goto(`${srv.baseUrl}/geometry-traps`, { waitUntil: 'domcontentloaded' });

    // 3a. Clicking #center-trap-wrapper WITHOUT x/y lands at wrapper center -> hits #center-submit-child
    const centerClick = await actFast(page, {
      action: 'click',
      selector: '#center-trap-wrapper',
      allowSubmit: false,
    });
    assert.equal(centerClick.blocked, true, 'Wrapper click without x/y whose center lands on child submit button must be blocked');

    const centerDblClick = await actFast(page, {
      action: 'dblclick',
      selector: '#center-trap-wrapper',
      allowSubmit: false,
    });
    assert.equal(centerDblClick.blocked, true, 'Wrapper dblclick without x/y landing on child submit button must be blocked');

    const typeOnWrapper = await actFast(page, {
      action: 'type',
      selector: '#center-trap-wrapper',
      value: 'abc',
      allowSubmit: false,
    });
    assert.equal(typeOnWrapper.blocked, true, 'type action clicking wrapper center over child submit button must be blocked');

    // Safe wrapper without submit child still clicks normally
    const safeClick = await actFast(page, {
      action: 'click',
      selector: '#safe-wrapper',
      allowSubmit: false,
    });
    assert.equal(safeClick.ok, true);
    assert.equal(await page.evaluate(() => Boolean(window.__safeWrapClicked)), true);

    // 3b. Ensure page is scrolled to top (y=0) so #offscreen-wrapper is at y > 1800 (outside viewport)
    await page.evaluate(() => window.scrollTo(0, 0));
    const offscreenOffsetClick = await actFast(page, {
      action: 'click',
      selector: '#offscreen-wrapper',
      x: 100,
      y: 50,
      allowSubmit: false,
    });
    assert.equal(
      offscreenOffsetClick.blocked,
      true,
      'Offset click on offscreen wrapper below the fold must scroll/check hit target and block submit'
    );

    assert.equal(srv.submissions.length, 0);
  });

  it('4. Submit Guard blocks coordinate & offset clicks into sandboxed (opaque-origin), cross-origin, and Shadow-DOM-hosted iframes', async () => {
    srv.clearSubmissions();
    srv.setRoute(
      '/cross-frame-child',
      `<!doctype html><html><body style="margin:0;">
        <form method="POST" action="${srv.baseUrl}/submit-xorigin">
          <button id="xo-btn" type="submit" style="width:180px;height:60px;">Buy Now</button>
        </form>
      </body></html>`
    );

    srv.setRoute(
      '/iframe-matrix',
      `<!doctype html><html><body style="margin:0;padding:12px;">
        <div id="sb-wrap" style="display:inline-block;padding:10px;border:2px solid #333;">
          <iframe
            id="sandbox-iframe"
            sandbox="allow-scripts allow-forms"
            style="width:200px;height:80px;border:0;display:block;"
            srcdoc="<body style='margin:0'><form method='POST' action='${srv.baseUrl}/submit-sandbox'><button type='submit' style='width:180px;height:60px'>Order Now</button></form></body>"
          ></iframe>
        </div>

        <div id="xo-wrap" style="margin-top:12px;">
          <iframe
            id="xorigin-iframe"
            src="http://localhost:${srv.port}/cross-frame-child"
            style="width:200px;height:80px;border:0;display:block;"
          ></iframe>
        </div>

        <div id="shadow-iframe-host" style="margin-top:12px;width:220px;height:90px;"></div>
        <script>
          const host = document.getElementById('shadow-iframe-host');
          const sr = host.attachShadow({ mode: 'open' });
          sr.innerHTML = '<iframe id="in-shadow-frame" style="width:200px;height:80px;border:0;" src="http://localhost:${srv.port}/cross-frame-child"></iframe>';
        </script>
      </body></html>`
    );

    const { page } = await manager.getPage();
    await page.goto(`${srv.baseUrl}/iframe-matrix`, { waitUntil: 'load' });

    // Verify sandbox-iframe really has contentDocument === null (opaque origin)
    const sbHasDoc = await page.evaluate(() => Boolean(document.getElementById('sandbox-iframe').contentDocument));
    assert.equal(sbHasDoc, false, 'sandbox="allow-scripts allow-forms" iframe must have null contentDocument');

    const sbBox = await page.locator('#sandbox-iframe').boundingBox();
    const clickSandboxCoords = await actFast(page, {
      action: 'click',
      x: Math.round(sbBox.x + 60),
      y: Math.round(sbBox.y + 30),
      allowSubmit: false,
    });
    assert.equal(clickSandboxCoords.blocked, true, 'Coordinate click into opaque sandboxed iframe submit button must be blocked');

    const clickSandboxOffset = await actFast(page, {
      action: 'click',
      selector: '#sb-wrap',
      x: 50,
      y: 40,
      allowSubmit: false,
    });
    assert.equal(clickSandboxOffset.blocked, true, 'Wrapper offset click into padded sandboxed iframe must be blocked');

    const xoBox = await page.locator('#xorigin-iframe').boundingBox();
    const clickXoCoords = await actFast(page, {
      action: 'click',
      x: Math.round(xoBox.x + 60),
      y: Math.round(xoBox.y + 30),
      allowSubmit: false,
    });
    assert.equal(clickXoCoords.blocked, true, 'Coordinate click into cross-origin localhost iframe submit button must be blocked');

    const shBox = await page.locator('#shadow-iframe-host').boundingBox();
    const clickShadowIframeCoords = await actFast(page, {
      action: 'click',
      x: Math.round(shBox.x + 60),
      y: Math.round(shBox.y + 30),
      allowSubmit: false,
    });
    assert.equal(clickShadowIframeCoords.blocked, true, 'Coordinate click into cross-origin iframe inside open Shadow DOM must be blocked');

    assert.equal(srv.submissions.length, 0);
  });

  it('5. Submit Guard blocks Enter/NumpadEnter implicit submit on checkbox/radio in <form> AND Shift+Space on submit button, while allowing Space checkbox toggle', async () => {
    srv.clearSubmissions();
    srv.setRoute(
      '/implicit-enter-controls',
      `<!doctype html><html><body>
        <form id="imp-form" method="POST" action="/submit-imp">
          <label><input id="agree-cb" type="checkbox" name="agree" /> Agree</label>
          <label><input id="tier-rd" type="radio" name="tier" value="pro" /> Pro</label>
          <button id="imp-sub" type="submit">Send Form</button>
        </form>
      </body></html>`
    );

    const { page } = await manager.getPage();
    await page.goto(`${srv.baseUrl}/implicit-enter-controls`, { waitUntil: 'domcontentloaded' });

    const cbEnter = await actFast(page, {
      action: 'press',
      selector: '#agree-cb',
      key: 'Enter',
      allowSubmit: false,
    });
    assert.equal(cbEnter.blocked, true, 'Enter on <input type="checkbox"> inside <form> submits in Chromium and must be blocked');

    const rdNumpadEnter = await actFast(page, {
      action: 'press',
      selector: '#tier-rd',
      key: 'NumpadEnter',
      allowSubmit: false,
    });
    assert.equal(rdNumpadEnter.blocked, true, 'NumpadEnter on <input type="radio"> inside <form> must be blocked');

    await page.locator('#agree-cb').focus();
    const untargetedCbEnter = await actFast(page, {
      action: 'press',
      key: 'Enter',
      allowSubmit: false,
    });
    assert.equal(untargetedCbEnter.blocked, true, 'Untargeted Enter when checkbox in <form> is focused must be blocked');

    const shiftSpaceBtn = await actFast(page, {
      action: 'press',
      selector: '#imp-sub',
      key: 'Shift+Space',
      allowSubmit: false,
    });
    assert.equal(shiftSpaceBtn.blocked, true, 'Shift+Space on <button type="submit"> activates button in Chromium and must be blocked');

    // Space on normal checkbox toggles it without submitting -> must remain allowed
    const spaceToggleCb = await actFast(page, {
      action: 'press',
      selector: '#agree-cb',
      key: 'Space',
      allowSubmit: false,
    });
    assert.equal(spaceToggleCb.ok, true, 'Space on safe checkbox must be allowed');
    assert.equal(await page.locator('#agree-cb').isChecked(), true);
    assert.equal(srv.submissions.length, 0);
  });

  it('6. smartFillForm skips disabled <option>/<optgroup>, awaits async [role=combobox] menus (skipping aria-disabled), and disambiguates <fieldset>/<section> legends', async () => {
    srv.setRoute(
      '/smart-fill-edge-cases',
      `<!doctype html><html><body>
        <form id="complex-form">
          <div class="field">
            <label for="plan-sel">Subscription Plan</label>
            <select id="plan-sel">
              <option value="">-- Select --</option>
              <option value="pro-soldout" disabled>Pro</option>
              <optgroup label="Deprecated" disabled>
                <option value="pro-legacy">Pro Legacy</option>
              </optgroup>
              <option value="pro-active">Pro Annual</option>
            </select>
          </div>

          <div class="field">
            <label for="addons-sel">Addons</label>
            <select id="addons-sel" multiple>
              <option value="sso-disabled" disabled>SSO</option>
              <option value="sso-live">SSO Enterprise</option>
              <option value="audit-live">Audit Logs</option>
            </select>
          </div>

          <div class="field">
            <label id="country-lbl">Target Country</label>
            <div id="async-combo" role="combobox" aria-labelledby="country-lbl" aria-expanded="false" tabindex="0">Choose country...</div>
            <div id="combo-portal"></div>
          </div>

          <fieldset>
            <legend>Billing Address</legend>
            <div class="field">
              <label for="bill-city">City</label>
              <input id="bill-city" type="text" />
            </div>
            <div class="field">
              <label for="bill-zip">Postal Code</label>
              <input id="bill-zip" type="text" />
            </div>
          </fieldset>

          <fieldset>
            <legend>Shipping Address</legend>
            <div class="field">
              <label for="ship-city">City</label>
              <input id="ship-city" type="text" />
            </div>
            <div class="field">
              <label for="ship-zip">Postal Code</label>
              <input id="ship-zip" type="text" />
            </div>
          </fieldset>

          <section aria-label="Emergency Contact">
            <div class="field">
              <label for="emerg-phone">Phone</label>
              <input id="emerg-phone" type="tel" />
            </div>
            <div class="field">
              <label for="emerg-name">Contact Name</label>
              <input id="emerg-name" type="text" />
            </div>
          </section>
        </form>

        <script>
          const combo = document.getElementById('async-combo');
          const portal = document.getElementById('combo-portal');
          combo.addEventListener('click', () => {
            combo.setAttribute('aria-expanded', 'true');
            portal.innerHTML = '';
            setTimeout(() => {
              portal.innerHTML = \`
                <div role="listbox">
                  <div role="option" aria-disabled="true" onclick="window.__pickedDisabled = true;">Vietnam</div>
                  <div role="option" id="vn-enabled" onclick="combo.textContent = 'Vietnam (Active)'; combo.setAttribute('data-value', 'VN-ACTIVE'); portal.innerHTML = '';">Vietnam (Active)</div>
                </div>
              \`;
            }, 90);
          });
        </script>
      </body></html>`
    );

    const { page } = await manager.getPage();
    await page.goto(`${srv.baseUrl}/smart-fill-edge-cases`, { waitUntil: 'domcontentloaded' });

    const res = await smartFillForm(page, {
      overwrite: true,
      fields: [
        { keys: 'Subscription Plan', value: 'Pro' },
        { keys: 'Addons', values: ['SSO', 'Audit'] },
        { keys: 'Target Country', value: 'Vietnam' },
        { keys: 'City', not: 'Billing', value: 'Da Nang' },
        { keys: 'Billing Address City', value: 'Hanoi' },
        { keys: 'Emergency Contact Phone', value: '0909000111' },
      ],
    });

    assert.equal(res.filledCount, 6, `Expected all 6 fields filled, got ${JSON.stringify(res)}`);

    const state = await page.evaluate(() => ({
      plan: document.getElementById('plan-sel').value,
      addons: [...document.getElementById('addons-sel').selectedOptions].map((o) => o.value),
      comboVal: document.getElementById('async-combo').getAttribute('data-value'),
      pickedDisabled: Boolean(window.__pickedDisabled),
      billCity: document.getElementById('bill-city').value,
      shipCity: document.getElementById('ship-city').value,
      emergPhone: document.getElementById('emerg-phone').value,
    }));

    assert.equal(state.plan, 'pro-active', 'Must skip disabled <option> and <optgroup disabled>');
    assert.deepEqual(state.addons, ['sso-live', 'audit-live'], 'Multi-select must skip disabled <option>');
    assert.equal(state.pickedDisabled, false, 'Combobox must not click aria-disabled="true" option');
    assert.equal(state.comboVal, 'VN-ACTIVE', 'Combobox must await async-mounted listbox option');
    assert.equal(state.shipCity, 'Da Nang', '{ keys: "City", not: "Billing" } must exclude Billing fieldset');
    assert.equal(state.billCity, 'Hanoi', '{ keys: "Billing Address City" } must match Billing fieldset City');
    assert.equal(state.emergPhone, '0909000111', '{ keys: "Emergency Contact Phone" } must match section context');
  });

  it('7. inspectCompact resets onlyChanged delta on SPA route change & scopes selector across frames (along with extractCleanText)', async () => {
    srv.setRoute(
      '/scoped-child-frame',
      `<!doctype html><html><body>
        <div id="iframe-target">
          <p>Scoped Iframe Paragraph</p>
          <button id="if-scoped-btn" type="button">Iframe Scoped Action</button>
        </div>
        <div id="iframe-noise">
          <p>Unrelated Ad Copy</p>
          <button id="if-noise-btn" type="button">Ad Banner Button</button>
        </div>
      </body></html>`
    );

    srv.setRoute(
      '/spa-delta-step1',
      `<!doctype html><html><head><title>SPA Step 1</title></head><body>
        <div id="app">
          <div id="main-card">
            <input id="s1-name" placeholder="Full Name" />
            <button id="s1-next" type="button">Continue</button>
          </div>
          <button id="outside-main-btn" type="button">Global Header Action</button>
        </div>
        <iframe src="/scoped-child-frame" style="width:400px;height:180px;"></iframe>
        <script>
          window.goStep2 = () => {
            history.pushState({}, 'SPA Step 2', '/spa-delta-step2');
            document.getElementById('app').innerHTML = \`
              <div id="step2-card">
                <input id="s2-name" placeholder="Full Name" />
                <button id="s2-next" type="button">Continue</button>
              </div>
            \`;
          };
        </script>
      </body></html>`
    );

    const { page } = await manager.getPage();
    await page.goto(`${srv.baseUrl}/spa-delta-step1`, { waitUntil: 'load' });

    // 7a. Scoped selector on main frame must NOT include outside controls OR unrelated iframe body
    const scopedMain = await inspectCompact(page, { mode: 'interactive', selector: '#main-card' });
    assert.match(scopedMain.text, /Full Name/);
    assert.doesNotMatch(scopedMain.text, /Global Header Action/, 'selector=#main-card must exclude outside main controls');
    assert.doesNotMatch(scopedMain.text, /Ad Banner Button/, 'selector=#main-card must not dump non-matching iframe body');

    // Scoped selector matching inside child iframe
    const scopedIframe = await inspectCompact(page, { mode: 'interactive', selector: '#iframe-target' });
    assert.match(scopedIframe.text, /Iframe Scoped Action/);
    assert.doesNotMatch(scopedIframe.text, /Full Name/, 'selector=#iframe-target must not fallback to main document.body');
    assert.doesNotMatch(scopedIframe.text, /Ad Banner Button/, 'selector=#iframe-target must exclude #iframe-noise');

    // Non-existent selector must return 0 elements, not document.body
    const scopedMissing = await inspectCompact(page, { mode: 'interactive', selector: '#non-existent-modal' });
    assert.equal(scopedMissing.totalInteractive, 0, 'Non-existent selector must match 0 elements');

    // extractCleanText with selector inside iframe & excluding noise
    const cleanScoped = await extractCleanText(page, { selector: '#iframe-target' });
    assert.match(cleanScoped.text, /Scoped Iframe Paragraph/);
    assert.doesNotMatch(cleanScoped.text, /Unrelated Ad Copy/);

    // 7b. onlyChanged delta across SPA pushState URL transition
    const snapState = manager.getSnapshotState(page);
    const snapStep1 = await inspectCompact(page, { mode: 'interactive', includeFrames: false }, snapState);
    assert.match(snapStep1.text, /Full Name/);

    // Same URL, no DOM changes -> delta omits unchanged controls
    const sameUrlDelta = await inspectCompact(
      page,
      { mode: 'interactive', includeFrames: false, onlyChanged: true },
      snapState
    );
    assert.doesNotMatch(sameUrlDelta.text, /Full Name/);

    // SPA route change via history.pushState -> URL is now /spa-delta-step2, so controls MUST NOT be hidden by stale /spa-delta-step1 cache
    await page.evaluate(() => window.goStep2());
    const afterPushStateDelta = await inspectCompact(
      page,
      { mode: 'interactive', includeFrames: false, onlyChanged: true },
      snapState
    );
    assert.match(
      afterPushStateDelta.text,
      /Full Name/,
      'onlyChanged must invalidate baseline when SPA navigates to a new URL via pushState'
    );
    assert.match(afterPushStateDelta.text, /Continue/);
  });

  it('8. evaluateJs preserves "; //" inside strings/regexes, returns values with trailing /* ... */ & multi-line // comments, and supports top-level await', async () => {
    srv.setRoute('/eval-host', '<!doctype html><html><body><div id="probe" data-msg="ok">Hello</div></body></html>');
    const { page } = await manager.getPage();
    await page.goto(`${srv.baseUrl}/eval-host`, { waitUntil: 'domcontentloaded' });

    const strSemiSlash = await evaluateJs(page, {
      expression: '"alpha; // not-a-comment"',
    });
    assert.equal(
      strSemiSlash.result,
      'alpha; // not-a-comment',
      'Semicolon inside string literal before // must never be stripped'
    );

    const urlListStr = await evaluateJs(page, {
      expression: '"http://example.com;https://second.example.com;";',
    });
    assert.equal(urlListStr.result, 'http://example.com;https://second.example.com;');

    const regexLiteral = await evaluateJs(page, {
      expression: '/;\\s*\\/\\//.source;',
    });
    assert.equal(regexLiteral.result, ';\\s*\\/\\/');

    const blockComment = await evaluateJs(page, {
      expression: '40 + 2; /* trailing block comment */',
    });
    assert.equal(blockComment.result, 42, 'Expression with trailing /* ... */ after ; must return 42');

    const multiComments = await evaluateJs(page, {
      expression: '({ status: "ready" });\n// line comment 1\n/* block 2 */\n// line comment 3',
    });
    assert.deepEqual(multiComments.result, { status: 'ready' });

    const elBlockComment = await evaluateJs(page, {
      selector: '#probe',
      expression: 'el.dataset.msg + "!"; /* element comment */',
    });
    assert.equal(elBlockComment.result, 'ok!');

    const topAwaitExpr = await evaluateJs(page, {
      expression: 'await Promise.resolve(99);',
    });
    assert.equal(topAwaitExpr.result, 99, 'Top-level await expression must evaluate and return resolved value');

    const topAwaitStmt = await evaluateJs(page, {
      expression: 'const a = await Promise.resolve(19); const b = 23; return a + b;',
    });
    assert.equal(topAwaitStmt.result, 42, 'Multi-statement body with top-level await must work');
  });

  it('9. resolveSafePath blocks NUL bytes, Windows NTFS ADS (:), drive-relative paths, reserved device names, and trailing dots/spaces while creating deep subdirs', async () => {
    assert.throws(
      () => resolveSafePath(path.join(allowedDir, 'bad\0file.txt')),
      /null|invalid|outside/i,
      'Must reject NUL bytes in savePath'
    );

    if (process.platform === 'win32') {
      assert.throws(
        () => resolveSafePath(path.join(allowedDir, 'report.txt:hidden_stream')),
        /stream|colon|invalid|reserved/i,
        'Must reject NTFS Alternate Data Stream (:)'
      );
      assert.throws(
        () => resolveSafePath('D:drive-relative.txt'),
        /drive-relative|invalid|outside/i,
        'Must reject Windows drive-relative path D:foo'
      );
      for (const dev of ['NUL', 'CON.txt', 'sub/COM1.json', 'LPT1']) {
        assert.throws(
          () => resolveSafePath(path.join(allowedDir, dev)),
          /reserved|device|invalid/i,
          `Must reject Windows reserved device name ${dev}`
        );
      }
      assert.throws(
        () => resolveSafePath(path.join(allowedDir, 'trailing-dot.txt.')),
        /trailing|invalid/i,
        'Must reject trailing dot on filename on Windows'
      );
      assert.throws(
        () => resolveSafePath(path.join(allowedDir, 'bad dir ', 'out.txt')),
        /trailing|invalid/i,
        'Must reject trailing space on directory segment on Windows'
      );
    }

    // Valid deep non-existent directory + leading-dot filename "..audit-ok.txt"
    const deepValid = path.join(allowedDir, 'nested', 'deep', 'level3', '..audit-ok.txt');
    srv.setRoute('/save-check', '<!doctype html><html><body><main>Deep Save OK</main></body></html>');
    const { page } = await manager.getPage();
    await page.goto(`${srv.baseUrl}/save-check`, { waitUntil: 'domcontentloaded' });
    const out = await extractCleanText(page, { savePath: deepValid });
    assert.equal(out.savePath, deepValid);
    assert.equal(fs.existsSync(deepValid), true);
  });

  it('10. compileUrlPattern matches ?, +, $, and (beta) globs; loadStorageStatePath normalizes origins; open_many rejects blank URLs', async () => {
    srv.setRoute(
      '/net-edge',
      '<!doctype html><html><head><title>Net Edge</title></head><body><h1>Network Edge</h1></body></html>'
    );

    const { tabId, page } = await manager.getPage();
    await page.goto(`${srv.baseUrl}/net-edge`, { waitUntil: 'domcontentloaded' });

    // 10a. compileUrlPattern with ?, +, $, and glob with parentheses
    await manager.manageNetworkSession(tabId, {
      unblockAll: true,
      blockUrls: [
        '/api/track?id=1',
        '/api/calc?q=a+b',
        '/api/pay?amt=$10',
        '*/api/v1(beta)/*',
      ],
    });

    const netRes = await evaluateJs(page, {
      expression: `async () => {
        const probe = async (u) => {
          try {
            const r = await fetch(u);
            return r.ok;
          } catch {
            return false;
          }
        };
        return {
          track1: await probe('/api/track?id=1'),
          track2: await probe('/api/track?id=2'),
          plus: await probe('/api/calc?q=a+b'),
          dollar: await probe('/api/pay?amt=$10'),
          betaGlob: await probe('/api/v1(beta)/users'),
          stableApi: await probe('/api/v1/users'),
        };
      }`,
    });

    assert.equal(netRes.result.track1, false, 'Literal URL with ? ("/api/track?id=1") must be blocked');
    assert.equal(netRes.result.plus, false, 'Literal URL with + ("/api/calc?q=a+b") must be blocked');
    assert.equal(netRes.result.dollar, false, 'Literal URL with $ ("/api/pay?amt=$10") must be blocked');
    assert.equal(netRes.result.betaGlob, false, 'Glob with parentheses ("*/api/v1(beta)/*") must be blocked');
    assert.equal(netRes.result.track2, true, 'Non-matching query "/api/track?id=2" must pass');
    assert.equal(netRes.result.stableApi, true, 'Non-matching "/api/v1/users" must pass');

    // urlFilter in page_diagnostics also uses compileUrlPattern
    const diag = await manager.getDiagnostics(tabId, {
      statusFilter: 'all',
      urlFilter: '/api/track?id=2',
    });
    assert.ok(
      diag.requests.some((r) => r.url.includes('/api/track?id=2')),
      'page_diagnostics urlFilter with "?" must match "/api/track?id=2"'
    );

    await manager.manageNetworkSession(tabId, { unblockAll: true });

    // 10b. loadStorageStatePath with non-normalized origin (uppercase scheme + trailing slash + non-default port)
    const storageFile = path.join(allowedDir, 'state-nonnorm.json');
    fs.writeFileSync(
      storageFile,
      JSON.stringify({
        cookies: [],
        origins: [
          {
            origin: `HTTP://127.0.0.1:${srv.port}/`,
            localStorage: [{ name: 'auth_token', value: 'seeded-123' }],
          },
        ],
      }),
      'utf8'
    );

    await manager.manageNetworkSession(tabId, { loadStorageStatePath: storageFile });
    const seededNow = await page.evaluate(() => window.localStorage.getItem('auth_token'));
    assert.equal(seededNow, 'seeded-123', 'loadStorageStatePath must normalize origin URL with uppercase/trailing slash');

    await page.evaluate(() => window.localStorage.setItem('auth_token', 'live-edited'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    const afterReload = await page.evaluate(() => window.localStorage.getItem('auth_token'));
    assert.equal(afterReload, 'live-edited', 'Normalized origin seeding must not overwrite live edits on reload');

    // 10c. open_many with [null, undefined, "", "   "] must reject cleanly without opening "null"/"undefined" tabs
    const tabsBefore = (await manager.listTabs()).length;
    await assert.rejects(
      () => manager.tabsBatch([{ action: 'open_many', urls: [null, undefined, '', '   '] }]),
      /non-empty urls array/i
    );
    assert.equal((await manager.listTabs()).length, tabsBefore);
  });

  it('11. Stdio JSON-RPC 2.0 handles id:0, id:null, invalid id types, empty/notification batches, colon-prefixed NDJSON lines, X-Fake-Content-Length, and oversized headers', async () => {
    const rpc = createJsonRpcHandler(manager);

    // id: 0 vs id: null vs notification vs invalid object/array/boolean id
    const zeroId = await rpc({ jsonrpc: '2.0', id: 0, method: 'ping' });
    assert.deepEqual(zeroId, { jsonrpc: '2.0', id: 0, result: {} });

    const nullId = await rpc({ jsonrpc: '2.0', id: null, method: 'ping' });
    assert.deepEqual(nullId, { jsonrpc: '2.0', id: null, result: {} });

    const notif = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(notif, null);

    const emptyBatch = await rpc([]);
    assert.equal(emptyBatch.error?.code, -32600);

    const notifOnlyBatch = await rpc([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'notifications/cancelled' },
    ]);
    assert.equal(notifOnlyBatch, null);

    for (const badId of [{ nested: 1 }, [1, 2], true]) {
      const badIdRes = await rpc({ jsonrpc: '2.0', id: badId, method: 'ping' });
      assert.equal(badIdRes.error?.code, -32600, `Expected -32600 for non-primitive/boolean id ${JSON.stringify(badId)}`);
      assert.equal(badIdRes.id, null);
    }

    // Subprocess 1: NDJSON stream must NOT deadlock when an invalid line starts with "foo: bar\n"
    const runNdjsonProbe = () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [ENTRY_PATH], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let out = '';
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`Stdio NDJSON server deadlocked on colon line. stdout so far: ${out}`));
        }, 4000);

        child.stdout.on('data', (chunk) => {
          out += chunk.toString('utf8');
          const lines = out.trim().split('\n').filter(Boolean);
          if (lines.length >= 2) {
            clearTimeout(timer);
            child.stdin.end();
            resolve(lines.map((l) => JSON.parse(l)));
          }
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });

        child.stdin.write('invalid: unquoted-line\n');
        child.stdin.write('{"jsonrpc":"2.0","id":101,"method":"ping"}\n');
      });

    const ndjsonReplies = await runNdjsonProbe();
    assert.equal(ndjsonReplies[0].error?.code, -32700, 'Invalid colon line must return -32700 Parse error');
    assert.deepEqual(ndjsonReplies[1], { jsonrpc: '2.0', id: 101, result: {} });

    // Subprocess 2: Content-Length framing resists X-Fake-Content-Length spoofing + multi-byte UTF-8 + oversized header block
    const runFramedProbe = () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [ENTRY_PATH], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let buf = Buffer.alloc(0);
        const parsedMessages = [];

        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(
            new Error(
              `Framed stdio server timed out. Received ${parsedMessages.length} msgs: ${JSON.stringify(parsedMessages)}`
            )
          );
        }, 4500);

        child.stdout.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          while (true) {
            const sep = buf.indexOf('\r\n\r\n');
            if (sep === -1) break;
            const hdr = buf.subarray(0, sep).toString('utf8');
            const m = /(?:^|\r?\n)Content-Length:\s*(\d+)/i.exec(hdr);
            if (!m) break;
            const len = Number(m[1]);
            if (buf.length < sep + 4 + len) break;
            const body = buf.subarray(sep + 4, sep + 4 + len).toString('utf8');
            buf = buf.subarray(sep + 4 + len);
            parsedMessages.push(JSON.parse(body));
          }
          if (parsedMessages.some((m) => m.id === 303)) {
            clearTimeout(timer);
            child.stdin.end();
            resolve(parsedMessages);
          }
        });

        // Frame 1: X-Fake-Content-Length: 5 before real Content-Length with multi-byte UTF-8 ("Xin chào 🚀")
        const msg1 = JSON.stringify({
          jsonrpc: '2.0',
          id: 'utf8-Xin chào 🚀',
          method: 'ping',
        });
        const len1 = Buffer.byteLength(msg1, 'utf8');
        child.stdin.write(`X-Fake-Content-Length: 5\r\nContent-Length: ${len1}\r\n\r\n${msg1}`);

        // Frame 2: Oversized garbage header (>20KB without \r\n\r\n) followed by \r\n\r\n and a valid frame (id: 303)
        const hugeHeader = `Content-Type: text/plain\r\nX-Pad: ${'A'.repeat(20000)}\r\n\r\n`;
        child.stdin.write(hugeHeader);

        const msg2 = JSON.stringify({ jsonrpc: '2.0', id: 303, method: 'ping' });
        const len2 = Buffer.byteLength(msg2, 'utf8');
        child.stdin.write(`Content-Length: ${len2}\r\n\r\n${msg2}`);
      });

    const framedReplies = await runFramedProbe();
    assert.ok(
      framedReplies.some((r) => r.id === 'utf8-Xin chào 🚀' && r.result),
      `Expected intact reply for utf8-Xin chào 🚀, got ${JSON.stringify(framedReplies)}`
    );
    assert.ok(
      framedReplies.some((r) => r.id === 303 && r.result),
      `Expected recovery and intact reply for id 303 after oversized header, got ${JSON.stringify(framedReplies)}`
    );
  });

  it('12. End-to-end crash/close recovery & temp download cleanup leaves zero stale tabs, blockers, or temp files', async () => {
    srv.setRoute(
      '/dl-and-recover',
      `<!doctype html><html><head><title>Recover Test</title></head><body>
        <a id="dl-link" href="/audit-download" download="audit-artifact.txt">Download File</a>
        <form onsubmit="return false;">
          <label for="rec-in">Recovery Input</label>
          <input id="rec-in" type="text" />
        </form>
      </body></html>`
    );
    srv.setRoute('/audit-download', (_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="audit-artifact.txt"',
      });
      res.end('audit-download-payload');
    });

    const localMgr = new BrowserManager({ mode: 'launch', headless: true });
    try {
      const open1 = await localMgr.tabsBatch([{ action: 'open', url: `${srv.baseUrl}/dl-and-recover` }]);
      const tab1 = open1.activeTabId;
      const { page: p1 } = await localMgr.getPage(tab1);

      await localMgr.manageNetworkSession(tab1, { preset: 'no-images' });
      await Promise.all([
        p1.waitForEvent('download'),
        actFast(p1, { action: 'click', selector: '#dl-link' }),
      ]);
      const diag1 = await localMgr.getDiagnostics(tab1, { level: 'all' });
      assert.equal(diag1.downloads.length, 1);
      const dlPath = diag1.downloads[0].savePath;
      assert.equal(fs.existsSync(dlPath), true);

      // Simulate hard browser crash/disconnect
      await localMgr.browser.close();

      // Next operation must relaunch cleanly with 0 stale tabs from pre-crash session
      const open2 = await localMgr.tabsBatch([{ action: 'open', url: `${srv.baseUrl}/dl-and-recover` }]);
      assert.equal(open2.tabs.length, 1, 'Post-crash relaunch must have only the newly opened tab');

      const fillOut = await dispatchToolCall(localMgr, 'batch_actions', {
        tabId: open2.activeTabId,
        allowSubmit: false,
        returnSnapshot: true,
        steps: [
          {
            action: 'smart_fill_form',
            fields: [{ keys: 'Recovery Input', value: 'recovered-ok' }],
          },
        ],
      });
      const parsedBatch = JSON.parse(fillOut.text);
      assert.equal(parsedBatch.completed, 1);
      assert.match(parsedBatch.snapshot, /recovered-ok/);

      // close_browser must unlink tracked temp download files even across earlier crash
      await localMgr.tabsBatch([{ action: 'close_browser' }]);
      assert.equal(fs.existsSync(dlPath), false, 'close() must clean up tracked temp download files');
    } finally {
      await localMgr.close();
    }
  });

  it('13. Submit Guard blocks wrapper center-point clicks across upload, check/uncheck, and smartFillForm Pass 2 file triggers', async () => {
    srv.clearSubmissions();
    const sampleUploadPath = path.join(allowedDir, 'wrap-guard-sample.txt');
    fs.writeFileSync(sampleUploadPath, 'guard-upload-payload', 'utf8');

    srv.setRoute(
      '/guard-wrap-upload-check',
      `<!doctype html><html><head><title>Wrap Guard Upload & Check</title></head><body>
        <form action="/submit-wrap-guard" method="POST">
          <div id="upload-wrap" style="width:180px;height:44px;display:flex;align-items:center;justify-content:center;">
            <button type="submit" style="width:140px;height:36px;">Send Application</button>
          </div>
          <div id="cb-wrap" role="checkbox" aria-checked="false" style="width:180px;height:44px;display:flex;align-items:center;justify-content:center;">
            <button type="submit" style="width:140px;height:36px;">Place Order</button>
          </div>
          <label id="native-cb-wrap" style="width:180px;height:44px;display:flex;align-items:center;justify-content:center;position:relative;">
            <input type="checkbox" style="position:absolute;left:0;top:0;width:8px;height:8px;" />
            <button type="submit" style="width:140px;height:36px;">Confirm Payment</button>
          </label>
        </form>
      </body></html>`
    );

    const opened = await manager.tabsBatch([{ action: 'open', url: `${srv.baseUrl}/guard-wrap-upload-check` }]);
    const { page } = await manager.getPage(opened.activeTabId);

    const upAct = await actFast(page, {
      action: 'upload',
      selector: '#upload-wrap',
      file: sampleUploadPath,
      timeoutMs: 1200,
      allowSubmit: false,
    });
    assert.equal(upAct.ok, false, 'actFast upload on wrapper over submit button must be blocked');
    assert.equal(upAct.blocked, true);
    assert.equal(srv.submissions.length, 0, 'Server must receive 0 submissions after actFast upload wrapper test');

    const upFill = await smartFillForm(page, {
      stopBeforeSubmit: true,
      fields: [{ selector: '#upload-wrap', file: sampleUploadPath }],
    });
    assert.equal(upFill.filledCount, 0);
    assert.ok(
      upFill.skipped.some((s) => s.reason === 'blocked-submit-target'),
      `Expected blocked-submit-target skip, got ${JSON.stringify(upFill.skipped)}`
    );
    assert.equal(srv.submissions.length, 0, 'Server must receive 0 submissions after smartFillForm upload wrapper test');

    const chkAria = await actFast(page, {
      action: 'check',
      selector: '#cb-wrap',
      allowSubmit: false,
    });
    assert.equal(chkAria.ok, false, 'actFast check on ARIA checkbox wrapper over submit button must be blocked');
    assert.equal(chkAria.blocked, true);
    assert.equal(srv.submissions.length, 0, 'Server must receive 0 submissions after ARIA check wrapper test');

    const chkNative = await actFast(page, {
      action: 'check',
      selector: '#native-cb-wrap',
      allowSubmit: false,
    });
    assert.equal(chkNative.ok, false, 'actFast check on label wrapper whose center hits submit button must be blocked');
    assert.equal(chkNative.blocked, true);
    assert.equal(srv.submissions.length, 0, 'Server must receive 0 submissions after native check wrapper test');
  });

  it('14. smartFillForm Pass 1.5 ([role=combobox]) & Pass 2 (input[type=file]) prevent claimed reuse/false skips and disambiguate <fieldset> legends', async () => {
    const fileA = path.join(allowedDir, 'billing-doc.txt');
    const fileB = path.join(allowedDir, 'shipping-doc.txt');
    fs.writeFileSync(fileA, 'billing-doc', 'utf8');
    fs.writeFileSync(fileB, 'shipping-doc', 'utf8');

    srv.setRoute(
      '/combo-file-sections',
      `<!doctype html><html><head><title>Combo & File Sections</title></head><body>
        <fieldset id="fs-billing">
          <legend>Billing Address</legend>
          <div class="field">
            <label>Country</label>
            <div data-slot="combo-1" role="combobox" tabindex="0" style="width:160px;height:30px;border:1px solid #333;">Select...</div>
          </div>
          <div class="field">
            <label>Document <input data-slot="file-1" name="doc_upload" type="file" /></label>
          </div>
        </fieldset>
        <fieldset id="fs-shipping">
          <legend>Shipping Address</legend>
          <div class="field">
            <label>Country</label>
            <div data-slot="combo-2" role="combobox" tabindex="0" style="width:160px;height:30px;border:1px solid #333;">Select...</div>
          </div>
          <div class="field">
            <label>Document <input data-slot="file-2" name="doc_upload" type="file" /></label>
          </div>
        </fieldset>
        <div id="portal-listbox" role="listbox" style="display:none;border:1px solid #000;"></div>
        <script>
          let activeCombo = null;
          const listbox = document.getElementById('portal-listbox');
          function openMenu(combo) {
            activeCombo = combo;
            listbox.innerHTML = '';
            for (const name of ['Vietnam', 'Japan', 'Germany']) {
              const opt = document.createElement('div');
              opt.setAttribute('role', 'option');
              opt.style.padding = '4px 8px';
              opt.textContent = name;
              opt.addEventListener('click', () => {
                activeCombo.textContent = name;
                activeCombo.setAttribute('data-value', name);
                listbox.style.display = 'none';
              });
              listbox.appendChild(opt);
            }
            listbox.style.display = 'block';
          }
          document.querySelector('[data-slot="combo-1"]').addEventListener('click', (e) => openMenu(e.currentTarget));
          document.querySelector('[data-slot="combo-2"]').addEventListener('click', (e) => openMenu(e.currentTarget));
        </script>
      </body></html>`
    );

    const opened = await manager.tabsBatch([{ action: 'open', url: `${srv.baseUrl}/combo-file-sections` }]);
    const { page } = await manager.getPage(opened.activeTabId);

    // Case A: Disambiguate by <fieldset><legend> + field label
    const resScoped = await smartFillForm(page, {
      overwrite: false,
      fields: [
        { keys: 'Shipping Address Country', value: 'Japan' },
        { keys: 'Billing Address Country', value: 'Vietnam' },
        { keys: 'Shipping Address Document', file: fileB },
        { keys: 'Billing Address Document', file: fileA },
      ],
    });
    assert.equal(resScoped.filledCount, 4, `Expected 4 scoped fields filled, got ${JSON.stringify(resScoped)}`);
    const stateScoped = await page.evaluate(() => ({
      billingCombo: document.querySelector('[data-slot="combo-1"]').textContent.trim(),
      shippingCombo: document.querySelector('[data-slot="combo-2"]').textContent.trim(),
      billingFile: document.querySelector('[data-slot="file-1"]').files[0]?.name || null,
      shippingFile: document.querySelector('[data-slot="file-2"]').files[0]?.name || null,
    }));
    assert.deepEqual(stateScoped, {
      billingCombo: 'Vietnam',
      shippingCombo: 'Japan',
      billingFile: 'billing-doc.txt',
      shippingFile: 'shipping-doc.txt',
    });

    // Case B: Identical keys ('Country' x2, 'Document' x2) with overwrite: false must claim sequentially without false skips
    await page.reload({ waitUntil: 'domcontentloaded' });
    const resIdentical = await smartFillForm(page, {
      overwrite: false,
      fields: [
        { keys: 'Country', value: 'Vietnam' },
        { keys: 'Country', value: 'Japan' },
        { keys: 'Document', file: fileA },
        { keys: 'Document', file: fileB },
      ],
    });
    assert.equal(resIdentical.filledCount, 4, `Expected 4 identical-label fields filled without false skip, got ${JSON.stringify(resIdentical)}`);
    assert.equal(resIdentical.skipped.length, 0, `Expected 0 false skips, got ${JSON.stringify(resIdentical.skipped)}`);
    const stateIdentical = await page.evaluate(() => ({
      billingCombo: document.querySelector('[data-slot="combo-1"]').textContent.trim(),
      shippingCombo: document.querySelector('[data-slot="combo-2"]').textContent.trim(),
      billingFile: document.querySelector('[data-slot="file-1"]').files[0]?.name || null,
      shippingFile: document.querySelector('[data-slot="file-2"]').files[0]?.name || null,
    }));
    assert.deepEqual(stateIdentical, {
      billingCombo: 'Vietnam',
      shippingCombo: 'Japan',
      billingFile: 'billing-doc.txt',
      shippingFile: 'shipping-doc.txt',
    });
  });

  it('15. evaluateJs handles quotes inside regex literals and nested backticks inside template ${...} interpolations with trailing semicolons/comments', async () => {
    srv.setRoute('/eval-regex-tpl', '<!doctype html><html><body><div id="probe" data-q="&quot;">ok</div></body></html>');
    const opened = await manager.tabsBatch([{ action: 'open', url: `${srv.baseUrl}/eval-regex-tpl` }]);
    const { page } = await manager.getPage(opened.activeTabId);

    const r1 = await evaluateJs(page, {
      expression: '/"/.test(\'"\'); // regex literal containing unescaped double quote',
    });
    assert.equal(r1.result, true, 'Regex literal containing double quote + trailing semicolon/comment must return true');

    const r2 = await evaluateJs(page, {
      expression: "/'/.test(\"'\"); /* regex literal containing single quote */",
    });
    assert.equal(r2.result, true, 'Regex literal containing single quote + trailing block comment must return true');

    const r3 = await evaluateJs(page, {
      expression: '`${"`"}-${"ok"}`; // template literal with nested backtick inside ${...}',
    });
    assert.equal(r3.result, '`-ok', 'Template literal with nested backtick inside ${...} must return "`-ok"');

    const r4 = await evaluateJs(page, {
      selector: '#probe',
      expression: '/"/.test(el.dataset.q); // element-scoped regex literal with quote',
    });
    assert.equal(r4.result, true, 'Element-scoped evaluateJs must also handle regex literals with quotes');
  });
});
