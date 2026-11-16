import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { BrowserManager } from '../src/browser-manager.mjs';
import {
  actFast,
  batchActions,
  capturePage,
  evaluateJs,
  extractCleanText,
  inspectCompact,
  resolveSafePath,
  smartFillForm,
} from '../src/dom-engine.mjs';
import { dispatchToolCall } from '../src/index.mjs';

const MAIN_SECURITY_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Submit Guard & Confinement Simulation</title>
  <style>
    body { margin: 0; padding: 16px; font-family: sans-serif; }
    #card-wrapper {
      position: relative;
      width: 320px;
      height: 130px;
      border: 1px solid #333;
      background: #fafafa;
      margin-bottom: 16px;
    }
    #card-header {
      height: 36px;
      line-height: 36px;
      padding-left: 10px;
      background: #e5e7eb;
    }
    #nested-submit-btn {
      position: absolute;
      left: 20px;
      top: 50px;
      width: 160px;
      height: 44px;
    }
    iframe {
      width: 480px;
      height: 220px;
      border: 1px solid #666;
      display: block;
      margin-top: 12px;
    }
  </style>
</head>
<body>
  <h1>Adversarial Submit Guard Fixture</h1>

  <!-- 1 & 3 & 5: Standard form with card wrapper and submit buttons -->
  <form id="main-form" method="POST" action="/submit-main">
    <input id="safe-input" name="note" type="text" value="initial" />
    <button id="submit-btn" type="submit">Submit Order</button>
    <input id="submit-input-btn" type="submit" value="Send Application" />

    <div id="card-wrapper" onclick="window.__cardWrapperClicks = (window.__cardWrapperClicks || 0) + 1;">
      <div id="card-header">Safe Card Header</div>
      <button id="nested-submit-btn" type="submit">Confirm &amp; Pay</button>
    </div>
  </form>

  <!-- 4: Submit-like role="switch" controls -->
  <form id="switch-form" method="POST" action="/submit-switch">
    <button
      id="submit-switch"
      type="button"
      role="switch"
      aria-checked="false"
      onclick="this.setAttribute('aria-checked', 'true'); document.getElementById('switch-form').requestSubmit();"
    >Publish now</button>
    <div
      id="submit-switch-div"
      role="switch"
      aria-checked="false"
      tabindex="0"
      style="display:inline-block;padding:6px 12px;border:1px solid #444;cursor:pointer;"
      onclick="this.setAttribute('aria-checked', 'true'); document.getElementById('switch-form').requestSubmit();"
    >Publish now</div>
    <div
      id="delete-switch-div"
      role="switch"
      aria-checked="true"
      tabindex="0"
      style="display:inline-block;padding:6px 12px;border:1px solid #900;cursor:pointer;"
      onclick="this.setAttribute('aria-checked', 'false'); document.getElementById('switch-form').requestSubmit();"
    >Delete</div>
    <div
      id="safe-notify-switch"
      role="switch"
      aria-checked="false"
      tabindex="0"
      style="display:inline-block;padding:6px 12px;border:1px solid #090;cursor:pointer;"
      onclick="this.setAttribute('aria-checked', this.getAttribute('aria-checked') === 'true' ? 'false' : 'true');"
    >Dark Mode</div>
  </form>

  <!-- 6: Invalid and empty button type attributes inside <form> -->
  <form id="invalid-type-form" method="POST" action="/submit-invalid-type">
    <input id="inv-form-input" name="payload" type="text" value="test-val" />
    <button id="btn-type-invalid" type="invalid">Save Changes</button>
    <button id="btn-type-empty" type="">Go</button>
  </form>

  <!-- 7: First submitter disabled (with safe label "Continue"), real submitter is detached form="myform" -->
  <form id="myform" method="POST" action="/submit-detached">
    <input id="myform-input" name="secret" type="text" value="classified" />
    <button id="disabled-first-submitter" type="submit" disabled>Continue</button>
  </form>
  <button id="detached-submitter" form="myform">Go</button>

  <!-- 8: Emoji & symbol-prefixed dangerous vs safe buttons -->
  <form id="emoji-form" method="POST" action="/submit-emoji">
    <button id="btn-emoji-publish" type="button" onclick="document.getElementById('emoji-form').requestSubmit();">🚀 Publish</button>
    <button id="btn-emoji-delete" type="button" onclick="document.getElementById('emoji-form').requestSubmit();">🗑️ Delete</button>
    <button id="btn-emoji-buy" type="button" onclick="document.getElementById('emoji-form').requestSubmit();">💳 Buy Now</button>
    <button id="btn-arrow-order" type="button" onclick="document.getElementById('emoji-form').requestSubmit();">→ Order Now</button>
    <button id="btn-bracket-vn-order" type="button" onclick="document.getElementById('emoji-form').requestSubmit();">[Đặt hàng]</button>
    <button id="btn-complete-purchase" type="button" onclick="document.getElementById('emoji-form').requestSubmit();">✨ Complete Purchase</button>
    <button id="btn-confirm-booking" type="button" onclick="document.getElementById('emoji-form').requestSubmit();">📅 Confirm Booking</button>
    <button id="btn-vn-mua-ngay" type="button" onclick="document.getElementById('emoji-form').requestSubmit();">🔥 Mua ngay</button>

    <!-- Safe buttons that should NOT be blocked -->
    <button id="btn-safe-signin" type="button" onclick="window.__safeClicks = (window.__safeClicks || 0) + 1;">🔐 Sign in</button>
    <button id="btn-safe-vn-login" type="button" onclick="window.__safeClicks = (window.__safeClicks || 0) + 1;">Đăng nhập</button>
    <button id="btn-safe-arrow-next" type="button" onclick="window.__safeClicks = (window.__safeClicks || 0) + 1;">→ Next</button>
    <button id="btn-safe-draft" type="button" onclick="window.__safeClicks = (window.__safeClicks || 0) + 1;">Save Draft</button>
  </form>

  <!-- Safe submit-type form (e.g. multi-step wizard Next / Save Draft with type="submit" and preventDefault) -->
  <form id="wizard-form" onsubmit="event.preventDefault(); window.__wizardStep = (window.__wizardStep || 0) + 1;">
    <button id="wizard-next-submit" type="submit">→ Next</button>
    <button id="wizard-draft-submit" type="submit">💾 Save Draft</button>
  </form>

  <!-- 10: Extra creative bypasses (empty input[type=submit] value="", a[role=button] Pay $50, label-for-submit, shadow submit) -->
  <form id="empty-submit-form" method="POST" action="/submit-empty-val">
    <input id="empty-submit-text" name="field1" type="text" value="abc" />
    <input id="empty-val-input-submit" type="submit" value="" />
  </form>

  <form id="link-and-label-form" method="POST" action="/submit-link-label">
    <a id="anchor-pay-btn" href="#pay" role="button" onclick="event.preventDefault(); document.getElementById('link-and-label-form').requestSubmit();">Pay $50</a>
    <button id="hidden-real-submit" type="submit" style="position:absolute;left:-9999px;">Submit Hidden</button>
    <label id="label-for-submit" for="hidden-real-submit"><span id="label-inner-span">Click Innocent Span</span></label>
  </form>

  <div id="shadow-submit-host"></div>

  <!-- 2 & 10: Iframe containing form, inputs, buttons, and offset wrapper -->
  <iframe id="child-frame" src="/iframe-security"></iframe>

  <script>
    window.__cardWrapperClicks = 0;
    window.__safeClicks = 0;
    window.__wizardStep = 0;

    const host = document.getElementById('shadow-submit-host');
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = \`
      <form id="shadow-form" method="POST" action="/submit-shadow">
        <div id="shadow-card" style="position:relative;width:240px;height:80px;border:1px solid #555;">
          <button id="shadow-submit-btn" type="submit" style="position:absolute;left:15px;top:15px;width:140px;height:40px;">🚀 Publish</button>
        </div>
      </form>
    \`;
  </script>
</body>
</html>`;

const IFRAME_SECURITY_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { margin: 0; padding: 10px; font-family: sans-serif; }
    #iframe-card {
      position: relative;
      width: 280px;
      height: 100px;
      border: 1px solid #444;
      margin-top: 8px;
    }
    #iframe-card-submit {
      position: absolute;
      left: 20px;
      top: 30px;
      width: 140px;
      height: 40px;
    }
  </style>
</head>
<body>
  <form id="iframe-form" method="POST" action="/submit-iframe">
    <input id="iframe-input" name="iframeQuery" type="text" value="inside-iframe" />
    <button id="iframe-submit-btn" type="submit">Submit Iframe</button>
    <button id="iframe-pay-btn" type="button" onclick="document.getElementById('iframe-form').requestSubmit();">💳 Buy Now</button>

    <div id="iframe-card" ondblclick="window.__iframeCardDblClicks = (window.__iframeCardDblClicks || 0) + 1;">
      <span>Iframe Card Top</span>
      <button id="iframe-card-submit" type="submit" ondblclick="document.getElementById('iframe-form').requestSubmit();">→ Order Now</button>
    </div>
  </form>
</body>
</html>`;

describe('Simulation: Submit Guard & Path Confinement Adversarial Suite', () => {
  let server;
  let baseUrl;
  let manager;
  let submissions = [];
  let prevSaveRoot;
  let tempRootDir;
  let allowedDir;
  let outsideDir;
  let uploadSampleFile;

  const getSubmissionCount = () => submissions.length;
  const resetSubmissions = () => {
    submissions.length = 0;
  };

  before(async () => {
    prevSaveRoot = process.env.TURBO_BROWSER_SAVE_ROOT;
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-sim-sec-'));
    allowedDir = path.join(tempRootDir, 'allowed-root');
    outsideDir = path.join(tempRootDir, 'outside-root');
    fs.mkdirSync(allowedDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    uploadSampleFile = path.join(allowedDir, 'sample-upload.txt');
    fs.writeFileSync(uploadSampleFile, 'sample upload content', 'utf8');

    process.env.TURBO_BROWSER_SAVE_ROOT = [process.cwd(), allowedDir].join(path.delimiter);

    server = http.createServer((req, res) => {
      const urlObj = new URL(req.url, 'http://127.0.0.1');
      if (urlObj.pathname.startsWith('/submit')) {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          submissions.push({
            method: req.method,
            url: req.url,
            body,
            ts: Date.now(),
          });
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><html><body><h1>Submitted!</h1></body></html>');
        });
        return;
      }

      if (urlObj.pathname === '/iframe-security') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(IFRAME_SECURITY_HTML);
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(MAIN_SECURITY_HTML);
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;

    manager = new BrowserManager({ mode: 'launch', headless: true });
  });

  after(async () => {
    if (prevSaveRoot === undefined) {
      delete process.env.TURBO_BROWSER_SAVE_ROOT;
    } else {
      process.env.TURBO_BROWSER_SAVE_ROOT = prevSaveRoot;
    }
    await manager?.close().catch(() => {});
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (tempRootDir && fs.existsSync(tempRootDir)) {
      fs.rmSync(tempRootDir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    resetSubmissions();
    await manager.tabsBatch([{ action: 'navigate', url: `${baseUrl}/` }]);
  });

  it('1. blocks act_fast type on submit buttons (default, slowly: true, and delayMs) with 0 server submissions', async () => {
    const { page } = await manager.getPage();

    // Default slowly (undefined -> clicks target before typing)
    const resDefault = await actFast(page, {
      action: 'type',
      selector: '#submit-btn',
      value: 'x',
      allowSubmit: false,
    });
    assert.equal(resDefault.ok, false);
    assert.equal(resDefault.blocked, true);
    assert.equal(getSubmissionCount(), 0);

    // Explicit slowly: true
    const resSlow = await actFast(page, {
      action: 'type',
      selector: '#submit-btn',
      value: 'x',
      slowly: true,
      allowSubmit: false,
    });
    assert.equal(resSlow.ok, false);
    assert.equal(resSlow.blocked, true);
    assert.equal(getSubmissionCount(), 0);

    // delayMs on <input type="submit">
    const resDelay = await actFast(page, {
      action: 'type',
      selector: '#submit-input-btn',
      value: 'x',
      delayMs: 5,
      allowSubmit: false,
    });
    assert.equal(resDelay.ok, false);
    assert.equal(resDelay.blocked, true);
    assert.equal(getSubmissionCount(), 0);

    // Slowly: false on submit button should also be blocked before attempting fill
    const resFast = await actFast(page, {
      action: 'type',
      selector: '#submit-btn',
      value: 'x',
      slowly: false,
      allowSubmit: false,
    });
    assert.equal(resFast.ok, false);
    assert.equal(resFast.blocked, true);
    assert.equal(getSubmissionCount(), 0);
  });

  it('2. blocks untargeted Enter and Space key presses when focus is trapped inside an iframe form', async () => {
    const { page } = await manager.getPage();

    // Focus the text input inside the iframe
    const focusInput = await actFast(page, {
      action: 'focus',
      selector: '#iframe-input',
      frameIdx: 1,
    });
    assert.equal(focusInput.ok, true);

    // Press Enter with NO selector/ref/text target
    const enterOnInput = await actFast(page, {
      action: 'press',
      key: 'Enter',
      allowSubmit: false,
    });
    assert.equal(enterOnInput.ok, false);
    assert.equal(enterOnInput.blocked, true);
    assert.equal(getSubmissionCount(), 0);

    // Press Control+Enter with NO selector/ref/text target
    const ctrlEnterOnInput = await actFast(page, {
      action: 'press',
      key: 'Control+Enter',
      allowSubmit: false,
    });
    assert.equal(ctrlEnterOnInput.ok, false);
    assert.equal(ctrlEnterOnInput.blocked, true);
    assert.equal(getSubmissionCount(), 0);

    // Focus the <button type="submit"> inside the iframe
    await actFast(page, {
      action: 'focus',
      selector: '#iframe-submit-btn',
      frameIdx: 1,
    });

    // Press literal ' ' (spacebar) with NO selector/ref/text target
    const spaceOnSubmitBtn = await actFast(page, {
      action: 'press',
      key: ' ',
      allowSubmit: false,
    });
    assert.equal(spaceOnSubmitBtn.ok, false);
    assert.equal(spaceOnSubmitBtn.blocked, true);
    assert.equal(getSubmissionCount(), 0);

    // Press Enter on the focused iframe submit button with NO selector/ref/text target
    const enterOnSubmitBtn = await actFast(page, {
      action: 'press',
      key: 'Enter',
      allowSubmit: false,
    });
    assert.equal(enterOnSubmitBtn.ok, false);
    assert.equal(enterOnSubmitBtn.blocked, true);
    assert.equal(getSubmissionCount(), 0);

    // Focus the emoji "💳 Buy Now" button inside the iframe and press ' '
    await actFast(page, {
      action: 'focus',
      selector: '#iframe-pay-btn',
      frameIdx: 1,
    });
    const spaceOnPayBtn = await actFast(page, {
      action: 'press',
      key: ' ',
      allowSubmit: false,
    });
    assert.equal(spaceOnPayBtn.ok, false);
    assert.equal(spaceOnPayBtn.blocked, true);
    assert.equal(getSubmissionCount(), 0);
  });

  it('3. blocks combined target + offset (x, y) click and dblclick landing on a child submit button', async () => {
    const { page } = await manager.getPage();

    // Offset (60, 70) inside #card-wrapper lands on #nested-submit-btn (left:20..180, top:50..94)
    const blockedClick = await actFast(page, {
      action: 'click',
      selector: '#card-wrapper',
      x: 60,
      y: 70,
      allowSubmit: false,
    });
    assert.equal(blockedClick.ok, false);
    assert.equal(blockedClick.blocked, true);
    assert.equal(getSubmissionCount(), 0);

    const blockedDblClick = await actFast(page, {
      action: 'dblclick',
      selector: '#card-wrapper',
      x: 60,
      y: 70,
      allowSubmit: false,
    });
    assert.equal(blockedDblClick.ok, false);
    assert.equal(blockedDblClick.blocked, true);
    assert.equal(getSubmissionCount(), 0);

    // Safe offset (60, 15) inside #card-wrapper lands on #card-header
    const safeClick = await actFast(page, {
      action: 'click',
      selector: '#card-wrapper',
      x: 60,
      y: 15,
      allowSubmit: false,
    });
    assert.equal(safeClick.ok, true);
    assert.equal(getSubmissionCount(), 0);
    const clicks = await page.evaluate(() => window.__cardWrapperClicks);
    assert.equal(clicks, 1);
  });

  it('4. blocks check and uncheck on submit-like [role="switch"] controls while allowing safe switches', async () => {
    const { page } = await manager.getPage();

    // <button role="switch">Publish now</button>
    const btnSwitch = await actFast(page, {
      action: 'check',
      selector: '#submit-switch',
      allowSubmit: false,
    });
    assert.equal(btnSwitch.ok, false);
    assert.equal(btnSwitch.blocked, true);
    assert.equal(getSubmissionCount(), 0);

    // <div role="switch">Publish now</div>
    const divSwitch = await actFast(page, {
      action: 'check',
      selector: '#submit-switch-div',
      allowSubmit: false,
    });
    assert.equal(divSwitch.ok, false);
    assert.equal(divSwitch.blocked, true);
    assert.equal(getSubmissionCount(), 0);

    // <div role="switch" aria-checked="true">Delete</div> with uncheck
    const uncheckDelete = await actFast(page, {
      action: 'uncheck',
      selector: '#delete-switch-div',
      allowSubmit: false,
    });
    assert.equal(uncheckDelete.ok, false);
    assert.equal(uncheckDelete.blocked, true);
    assert.equal(getSubmissionCount(), 0);

    // Safe switch ("Dark Mode") is allowed
    const safeSwitch = await actFast(page, {
      action: 'check',
      selector: '#safe-notify-switch',
      allowSubmit: false,
    });
    assert.equal(safeSwitch.ok, true);
    const isChecked = await page.getAttribute('#safe-notify-switch', 'aria-checked');
    assert.equal(isChecked, 'true');
    assert.equal(getSubmissionCount(), 0);
  });

  it('5. enforces batch_actions allowSubmit: false ceiling over smart_fill_form stopBeforeSubmit: false', async () => {
    const { page } = await manager.getPage();

    const batchRes = await batchActions(
      page,
      [
        {
          action: 'smart_fill_form',
          stopBeforeSubmit: false,
          overwrite: true,
          fields: [
            { selector: '#safe-input', value: 'filled-in-batch' },
            { selector: '#submit-btn', file: uploadSampleFile },
          ],
        },
      ],
      { allowSubmit: false }
    );

    assert.equal(batchRes.completed, 1);
    const step0 = batchRes.results[0];
    assert.equal(step0.stoppedBeforeSubmit, true);
    assert.ok(
      step0.skipped.some((s) => s.reason === 'blocked-submit-target'),
      `Expected blocked-submit-target in skipped: ${JSON.stringify(step0.skipped)}`
    );
    assert.equal(getSubmissionCount(), 0);
    assert.equal(await page.inputValue('#safe-input'), 'filled-in-batch');
  });

  it('6. detects and blocks invalid/empty <button type="invalid"> and <button type=""> inside <form>', async () => {
    const { page } = await manager.getPage();

    // Direct click on <button type="invalid">Save Changes</button>
    const clickInvalid = await actFast(page, {
      action: 'click',
      selector: '#btn-type-invalid',
      allowSubmit: false,
    });
    assert.equal(clickInvalid.ok, false);
    assert.equal(clickInvalid.blocked, true);
    assert.equal(getSubmissionCount(), 0);

    // Direct click on <button type="">Go</button>
    const clickEmpty = await actFast(page, {
      action: 'click',
      selector: '#btn-type-empty',
      allowSubmit: false,
    });
    assert.equal(clickEmpty.ok, false);
    assert.equal(clickEmpty.blocked, true);
    assert.equal(getSubmissionCount(), 0);

    // Coordinate click on #btn-type-invalid
    const box = await page.locator('#btn-type-invalid').boundingBox();
    const coordClick = await actFast(page, {
      action: 'click',
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
      allowSubmit: false,
    });
    assert.equal(coordClick.ok, false);
    assert.equal(coordClick.blocked, true);
    assert.equal(getSubmissionCount(), 0);

    // Enter key on input inside #invalid-type-form
    const enterRes = await actFast(page, {
      action: 'press',
      selector: '#inv-form-input',
      key: 'Enter',
      allowSubmit: false,
    });
    assert.equal(enterRes.ok, false);
    assert.equal(enterRes.blocked, true);
    assert.equal(getSubmissionCount(), 0);

    // smartFillForm also reports them in submitButtons
    const fillRes = await smartFillForm(page, { fields: [] });
    const submitTexts = fillRes.submitButtons.map((b) => b.text);
    // submitButtons is capped at 3 (the first three submit candidates are reported)
    assert.equal(submitTexts.length, 3, `Expected 3 capped submitButtons: ${JSON.stringify(submitTexts)}`);
  });

  it('7. blocks Enter on form where first submitter is disabled ("Continue") and real submitter is detached <button form="myform">Go</button>', async () => {
    const { page } = await manager.getPage();

    // Targeted Enter on #myform-input
    const targetedEnter = await actFast(page, {
      action: 'press',
      selector: '#myform-input',
      key: 'Enter',
      allowSubmit: false,
    });
    assert.equal(targetedEnter.ok, false);
    assert.equal(targetedEnter.blocked, true);
    assert.equal(getSubmissionCount(), 0);

    // Untargeted Enter when #myform-input is focused
    await actFast(page, { action: 'focus', selector: '#myform-input' });
    const untargetedEnter = await actFast(page, {
      action: 'press',
      key: 'Enter',
      allowSubmit: false,
    });
    assert.equal(untargetedEnter.ok, false);
    assert.equal(untargetedEnter.blocked, true);
    assert.equal(getSubmissionCount(), 0);

    // Newline in type action on #myform-input
    const newlineType = await actFast(page, {
      action: 'type',
      selector: '#myform-input',
      value: 'bypass\n',
      allowSubmit: false,
    });
    assert.equal(newlineType.ok, false);
    assert.equal(newlineType.blocked, true);
    assert.equal(getSubmissionCount(), 0);

    // Direct click on detached <button id="detached-submitter" form="myform">Go</button>
    const clickDetached = await actFast(page, {
      action: 'click',
      selector: '#detached-submitter',
      allowSubmit: false,
    });
    assert.equal(clickDetached.ok, false);
    assert.equal(clickDetached.blocked, true);
    assert.equal(getSubmissionCount(), 0);
  });

  it('8. blocks emoji & symbol-prefixed dangerous buttons while allowing safe login/navigation buttons', async () => {
    const { page } = await manager.getPage();

    const dangerousSelectors = [
      '#btn-emoji-publish',
      '#btn-emoji-delete',
      '#btn-emoji-buy',
      '#btn-arrow-order',
      '#btn-bracket-vn-order',
      '#btn-complete-purchase',
      '#btn-confirm-booking',
      '#btn-vn-mua-ngay',
    ];

    for (const sel of dangerousSelectors) {
      const res = await actFast(page, {
        action: 'click',
        selector: sel,
        allowSubmit: false,
      });
      assert.equal(res.ok, false, `Expected ${sel} to be blocked`);
      assert.equal(res.blocked, true, `Expected ${sel} to have blocked=true`);
      assert.equal(getSubmissionCount(), 0, `Expected 0 submissions after ${sel}`);
    }

    const safeSelectors = [
      '#btn-safe-signin',
      '#btn-safe-vn-login',
      '#btn-safe-arrow-next',
      '#btn-safe-draft',
    ];

    for (const sel of safeSelectors) {
      const res = await actFast(page, {
        action: 'click',
        selector: sel,
        allowSubmit: false,
      });
      assert.equal(res.ok, true, `Expected safe button ${sel} to be allowed`);
      assert.ok(!res.blocked, `Expected safe button ${sel} not to be blocked`);
    }
    assert.equal(await page.evaluate(() => window.__safeClicks), safeSelectors.length);

    // Also verify symbol-prefixed safe type="submit" buttons ("→ Next", "💾 Save Draft")
    const wizNext = await actFast(page, {
      action: 'click',
      selector: '#wizard-next-submit',
      allowSubmit: false,
    });
    assert.equal(wizNext.ok, true);
    const wizDraft = await actFast(page, {
      action: 'click',
      selector: '#wizard-draft-submit',
      allowSubmit: false,
    });
    assert.equal(wizDraft.ok, true);
    assert.equal(await page.evaluate(() => window.__wizardStep), 2);
    assert.equal(getSubmissionCount(), 0);
  });

  it('9. enforces resolveSafePath confinement: allows ..notes.txt inside root while rejecting ../, outside paths, and junctions', async () => {
    const { page } = await manager.getPage();

    // 9a. Legitimate dot-prefixed filename "..notes.txt" inside allowedDir
    const dotFile = path.join(allowedDir, '..notes.txt');
    const resolvedDot = resolveSafePath(dotFile, 'savePath');
    assert.equal(path.basename(resolvedDot), '..notes.txt');

    await extractCleanText(page, { savePath: dotFile });
    assert.equal(fs.existsSync(dotFile), true);

    // Also test relative "..notes-cwd.txt" inside process.cwd() (cleaned up immediately)
    const cwdDotFile = path.join(process.cwd(), '..notes-sim-temp.txt');
    try {
      const resolvedRelDot = resolveSafePath('..notes-sim-temp.txt', 'savePath');
      assert.equal(path.basename(resolvedRelDot), '..notes-sim-temp.txt');
    } finally {
      if (fs.existsSync(cwdDotFile)) fs.unlinkSync(cwdDotFile);
    }

    // 9b. Reject "../outside.txt" traversal
    assert.throws(
      () => resolveSafePath('../outside-escape.txt', 'savePath'),
      /outside allowed root/i
    );
    await assert.rejects(
      () => inspectCompact(page, { savePath: path.join(allowedDir, '..', 'outside-root', 'snap.txt') }),
      /outside allowed root/i
    );

    // 9c. Reject absolute path in outsideDir
    const outsideTarget = path.join(outsideDir, 'stolen.json');
    assert.throws(
      () => resolveSafePath(outsideTarget, 'savePath'),
      /outside allowed root/i
    );
    await assert.rejects(
      () => evaluateJs(page, { expression: '1 + 1', savePath: outsideTarget }),
      /outside allowed root/i
    );
    await assert.rejects(
      () => capturePage(page, { savePath: path.join(outsideDir, 'screen.png') }),
      /outside allowed root/i
    );

    // 9d. Reject junction / directory symlink escaping allowedDir -> outsideDir
    const junctionDir = path.join(allowedDir, 'escape-junction');
    fs.symlinkSync(outsideDir, junctionDir, process.platform === 'win32' ? 'junction' : 'dir');
    const escapedViaJunction = path.join(junctionDir, 'escaped-write.txt');

    assert.throws(
      () => resolveSafePath(escapedViaJunction, 'savePath'),
      /outside allowed root/i
    );
    await assert.rejects(
      () => extractCleanText(page, { savePath: escapedViaJunction }),
      /outside allowed root/i
    );

    // Verify 0 files were written inside outsideDir
    assert.deepEqual(fs.readdirSync(outsideDir), []);
  });

  it('10. blocks extra creative bypasses: dblclick offset in iframe, empty input[type=submit] value="", a[role=button] Pay $50, label-for-submit, shadow coordinate click, and batch_actions validation', async () => {
    const { page } = await manager.getPage();

    // 10a. dblclick with target + offset inside iframe landing on #iframe-card-submit
    const iframeDblClickOffset = await actFast(page, {
      action: 'dblclick',
      selector: '#iframe-card',
      frameIdx: 1,
      x: 50,
      y: 50,
      allowSubmit: false,
    });
    assert.equal(iframeDblClickOffset.ok, false);
    assert.equal(iframeDblClickOffset.blocked, true);
    assert.equal(getSubmissionCount(), 0);

    // 10b. Empty value="" on <input type="submit" value=""> (click and form Enter)
    const clickEmptyValSubmit = await actFast(page, {
      action: 'click',
      selector: '#empty-val-input-submit',
      allowSubmit: false,
    });
    assert.equal(clickEmptyValSubmit.ok, false);
    assert.equal(clickEmptyValSubmit.blocked, true);
    assert.equal(getSubmissionCount(), 0);

    const enterEmptyValForm = await actFast(page, {
      action: 'press',
      selector: '#empty-submit-text',
      key: 'Enter',
      allowSubmit: false,
    });
    assert.equal(enterEmptyValForm.ok, false);
    assert.equal(enterEmptyValForm.blocked, true);
    assert.equal(getSubmissionCount(), 0);

    // 10c. <a role="button">Pay $50</a> and nested <span> inside <label for="hidden-real-submit">
    const clickAnchorPay = await actFast(page, {
      action: 'click',
      selector: '#anchor-pay-btn',
      allowSubmit: false,
    });
    assert.equal(clickAnchorPay.ok, false);
    assert.equal(clickAnchorPay.blocked, true);
    assert.equal(getSubmissionCount(), 0);

    const clickLabelSpan = await actFast(page, {
      action: 'click',
      selector: '#label-inner-span',
      allowSubmit: false,
    });
    assert.equal(clickLabelSpan.ok, false);
    assert.equal(clickLabelSpan.blocked, true);
    assert.equal(getSubmissionCount(), 0);

    // 10d. Combined target + offset click on #shadow-card inside open Shadow DOM landing on #shadow-submit-btn
    const shadowOffsetClick = await actFast(page, {
      action: 'click',
      selector: '#shadow-card',
      x: 40,
      y: 30,
      allowSubmit: false,
    });
    assert.equal(shadowOffsetClick.ok, false);
    assert.equal(shadowOffsetClick.blocked, true);
    assert.equal(getSubmissionCount(), 0);

    // 10e. batch_actions with non-array steps: "bad" and mixed allowed/blocked sequence
    const badStepsDirect = await batchActions(page, 'bad', { allowSubmit: false });
    assert.equal(badStepsDirect.completed, 0);
    assert.equal(badStepsDirect.total, 0);

    await assert.rejects(
      () => dispatchToolCall(manager, 'batch_actions', { steps: 'bad' }),
      /non-empty steps array/i
    );

    const mixedBatch = await batchActions(
      page,
      [
        { action: 'fill', selector: '#safe-input', value: 'step-0-ok' },
        { action: 'click', selector: '#btn-emoji-publish' },
        { action: 'fill', selector: '#safe-input', value: 'step-2-should-not-run' },
      ],
      { allowSubmit: false, continueOnError: false }
    );
    assert.equal(mixedBatch.blocked, true);
    assert.equal(mixedBatch.completed, 2);
    assert.equal(mixedBatch.results[0].ok, true);
    assert.equal(mixedBatch.results[1].blocked, true);
    assert.equal(await page.inputValue('#safe-input'), 'step-0-ok');
    assert.equal(getSubmissionCount(), 0);
  });
});
