import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { BrowserManager } from '../src/browser-manager.mjs';
import {
  actFast,
  batchActions,
  evaluateJs,
  inspectCompact,
  smartFillForm,
} from '../src/dom-engine.mjs';

function startSpaSimServer() {
  const routes = new Map();

  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url || '/', 'http://127.0.0.1');
    const handler = routes.get(parsed.pathname);
    if (handler) {
      handler(req, res, parsed);
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
        baseUrl: `http://127.0.0.1:${port}`,
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

describe('SPA & Messy DOM Simulation Suite (sim-spa-forms)', () => {
  let sim;
  let manager;
  let page;
  let tmpDir;
  let sampleUploadFile;
  let savedSaveRoot;

  before(async () => {
    savedSaveRoot = process.env.TURBO_BROWSER_SAVE_ROOT;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-sim-spa-'));
    process.env.TURBO_BROWSER_SAVE_ROOT = tmpDir;
    sampleUploadFile = path.join(tmpDir, 'candidate-cv.pdf');
    fs.writeFileSync(sampleUploadFile, '%PDF-1.4 simulated resume content\n', 'utf8');

    sim = await startSpaSimServer();
    manager = new BrowserManager({ mode: 'launch', headless: true });
    const tab = await manager.getPage();
    page = tab.page;
  });

  after(async () => {
    if ( savedSaveRoot === undefined ) {
      delete process.env.TURBO_BROWSER_SAVE_ROOT;
    } else {
      process.env.TURBO_BROWSER_SAVE_ROOT = savedSaveRoot;
    }
    await manager?.close();
    if (sim?.server) {
      await new Promise((resolve) => sim.server.close(resolve));
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('1. Over-matching & scoring traps: exact "Email" vs "Manager Email" / "Backup Email" and claimed element protection', async () => {
    sim.setRoute(
      '/scoring-traps',
      `<!doctype html><html><head><title>Scoring Traps</title></head><body>
        <form id="onboarding-form">
          <div class="row">
            <label for="mgr-email">Manager Email</label>
            <input id="mgr-email" name="manager_email" type="email" placeholder="Manager Email" />
          </div>
          <div class="row">
            <label for="backup-email">Backup Email</label>
            <input id="backup-email" name="backup_email" type="email" placeholder="Backup Email" />
          </div>
          <div class="row">
            <label for="primary-email">Email</label>
            <input id="primary-email" name="email" type="email" placeholder="Email" />
          </div>
        </form>
      </body></html>`
    );

    await page.goto(`${sim.baseUrl}/scoring-traps`, { waitUntil: 'domcontentloaded' });

    // Single { keys: 'Email' } must fill ONLY the exact "Email" input, even though Manager/Backup Email appear earlier in DOM.
    const res1 = await smartFillForm(page, {
      overwrite: true,
      fields: [{ keys: 'Email', value: 'user@me.co' }],
    });
    assert.equal(res1.filledCount, 1, `Expected exactly 1 filled field, got ${JSON.stringify(res1.filled)}`);

    const vals1 = await page.evaluate(() => ({
      primary: document.getElementById('primary-email').value,
      manager: document.getElementById('mgr-email').value,
      backup: document.getElementById('backup-email').value,
    }));
    assert.equal(vals1.primary, 'user@me.co');
    assert.equal(vals1.manager, '');
    assert.equal(vals1.backup, '');

    // Claimed elements in the same call must not be overwritten by subsequent looser specs.
    await page.evaluate(() => {
      document.getElementById('primary-email').value = '';
      document.getElementById('mgr-email').value = '';
      document.getElementById('backup-email').value = '';
    });

    await smartFillForm(page, {
      overwrite: true,
      fields: [
        { keys: 'Email', value: 'primary@me.co' },
        { keys: 'Manager Email', value: 'boss@me.co' },
        { keys: 'Email', value: 'leftover-backup@me.co' },
      ],
    });

    const vals2 = await page.evaluate(() => ({
      primary: document.getElementById('primary-email').value,
      manager: document.getElementById('mgr-email').value,
      backup: document.getElementById('backup-email').value,
    }));
    assert.equal(vals2.primary, 'primary@me.co');
    assert.equal(vals2.manager, 'boss@me.co');
    assert.equal(vals2.backup, 'leftover-backup@me.co');
  });

  it('2. Multi-frame scoping: matching in frame 0 does not duplicate into frame 1 unless f.all === true, and respects f.frameIdx', async () => {
    sim.setRoute(
      '/frame-child',
      `<!doctype html><html><body>
        <label for="f1-query">Search Query</label>
        <input id="f1-query" name="search_query" type="text" />
        <label for="f1-tenant">Tenant Code</label>
        <input id="f1-tenant" name="tenant_code" type="text" />
      </body></html>`
    );
    sim.setRoute(
      '/frame-parent',
      `<!doctype html><html><head><title>Multi Frame Scoping</title></head><body>
        <label for="f0-query">Search Query</label>
        <input id="f0-query" name="search_query" type="text" />
        <label for="f0-tenant">Tenant Code</label>
        <input id="f0-tenant" name="tenant_code" type="text" />
        <iframe id="child-iframe" src="/frame-child" width="400" height="200"></iframe>
      </body></html>`
    );

    await page.goto(`${sim.baseUrl}/frame-parent`, { waitUntil: 'load' });

    // 2a. Default (f.all not set): fills frame 0 only, does not bleed into frame 1
    await smartFillForm(page, {
      overwrite: true,
      fields: [{ keys: 'Search Query', value: 'main-only' }],
    });

    const mainVal1 = await page.locator('#f0-query').inputValue();
    const childFrame = page.frames().find((f) => f.url().includes('/frame-child'));
    assert.ok(childFrame, 'Expected child iframe to be loaded');
    const childVal1 = await childFrame.locator('#f1-query').inputValue();
    assert.equal(mainVal1, 'main-only');
    assert.equal(childVal1, '');

    // 2b. Explicit frameIdx: 1 targets only frame 1
    await smartFillForm(page, {
      overwrite: true,
      fields: [{ keys: 'Search Query', value: 'iframe-targeted', frameIdx: 1 }],
    });
    assert.equal(await page.locator('#f0-query').inputValue(), 'main-only');
    assert.equal(await childFrame.locator('#f1-query').inputValue(), 'iframe-targeted');

    // 2c. Explicit all: true fills across all frames
    await smartFillForm(page, {
      overwrite: true,
      fields: [{ keys: 'Tenant Code', value: 'ACME-GLOBAL', all: true }],
    });
    assert.equal(await page.locator('#f0-tenant').inputValue(), 'ACME-GLOBAL');
    assert.equal(await childFrame.locator('#f1-tenant').inputValue(), 'ACME-GLOBAL');
  });

  it('3. String booleans "true" / "false" on <input type="checkbox"> and [role="switch"] toggle state cleanly without corrupting .value', async () => {
    sim.setRoute(
      '/string-booleans',
      `<!doctype html><html><head><title>String Booleans</title></head><body>
        <label><input id="chk-news" type="checkbox" value="newsletter_opt_in" /> Subscribe Newsletter</label>
        <label><input id="chk-terms" type="checkbox" value="tos_2026" checked /> Accept Terms</label>
        <div>
          <span id="lbl-dark">Dark Mode</span>
          <button
            id="sw-dark"
            type="button"
            role="switch"
            aria-labelledby="lbl-dark"
            aria-checked="false"
            onclick="this.setAttribute('aria-checked', this.getAttribute('aria-checked') === 'true' ? 'false' : 'true')"
          >Off</button>
        </div>
        <div>
          <span id="lbl-alerts">Instant Alerts</span>
          <button
            id="sw-alerts"
            type="button"
            role="switch"
            aria-labelledby="lbl-alerts"
            aria-checked="true"
            onclick="this.setAttribute('aria-checked', this.getAttribute('aria-checked') === 'true' ? 'false' : 'true')"
          >On</button>
        </div>
      </body></html>`
    );

    await page.goto(`${sim.baseUrl}/string-booleans`, { waitUntil: 'domcontentloaded' });

    const res = await smartFillForm(page, {
      fields: [
        { keys: 'Subscribe Newsletter', value: 'true' },
        { keys: 'Accept Terms', value: 'false' },
        { keys: 'Dark Mode', value: 'true' },
        { keys: 'Instant Alerts', value: 'false' },
      ],
    });
    assert.equal(res.filledCount, 4);

    const state = await page.evaluate(() => ({
      newsChecked: document.getElementById('chk-news').checked,
      newsValue: document.getElementById('chk-news').value,
      termsChecked: document.getElementById('chk-terms').checked,
      termsValue: document.getElementById('chk-terms').value,
      darkAria: document.getElementById('sw-dark').getAttribute('aria-checked'),
      alertsAria: document.getElementById('sw-alerts').getAttribute('aria-checked'),
    }));

    assert.equal(state.newsChecked, true);
    assert.equal(state.newsValue, 'newsletter_opt_in', 'Checkbox .value attribute must not be overwritten with "true"');
    assert.equal(state.termsChecked, false);
    assert.equal(state.termsValue, 'tos_2026');
    assert.equal(state.darkAria, 'true');
    assert.equal(state.alertsAria, 'false');
  });

  it('4. Multiple independent ARIA [role="radiogroup"] widgets without name attributes each select one radio button in one call', async () => {
    sim.setRoute(
      '/aria-radiogroups',
      `<!doctype html><html><head><title>ARIA Radiogroups</title></head><body>
        <div id="rg-billing" role="radiogroup" aria-label="Billing Cycle">
          <div role="radio" id="bill-monthly" aria-checked="false" tabindex="0">Monthly</div>
          <div role="radio" id="bill-annual" aria-checked="false" tabindex="-1">Annual</div>
        </div>

        <div id="rg-tier" role="radiogroup" aria-labelledby="tier-heading">
          <h3 id="tier-heading">Support Plan</h3>
          <div role="radio" id="tier-basic" aria-checked="false" tabindex="0">Basic</div>
          <div role="radio" id="tier-annual" aria-checked="false" tabindex="-1">Annual</div>
          <div role="radio" id="tier-pro" aria-checked="false" tabindex="-1">Pro</div>
        </div>

        <div id="rg-region" role="radiogroup" aria-label="Deployment Region">
          <label><input type="radio" id="reg-us" value="us" /> US East</label>
          <label><input type="radio" id="reg-eu" value="eu" /> EU Central</label>
        </div>

        <script>
          for (const rg of document.querySelectorAll('[role="radiogroup"]')) {
            for (const r of rg.querySelectorAll('[role="radio"]')) {
              r.addEventListener('click', () => {
                for (const peer of rg.querySelectorAll('[role="radio"]')) {
                  peer.setAttribute('aria-checked', peer === r ? 'true' : 'false');
                }
              });
            }
            for (const inp of rg.querySelectorAll('input[type="radio"]')) {
              inp.addEventListener('click', () => {
                for (const peer of rg.querySelectorAll('input[type="radio"]')) {
                  peer.checked = peer === inp;
                }
              });
            }
          }
        </script>
      </body></html>`
    );

    await page.goto(`${sim.baseUrl}/aria-radiogroups`, { waitUntil: 'domcontentloaded' });

    // First test keyed selection across all 3 independent radiogroups in one smartFillForm call
    const res1 = await smartFillForm(page, {
      fields: [
        { keys: 'Billing Cycle', option: 'Annual' },
        { keys: 'Support Plan', option: 'Pro' },
        { keys: 'Deployment Region', option: 'EU Central' },
      ],
    });
    assert.equal(res1.filledCount, 3, `Expected 3 radiogroups filled, got ${JSON.stringify(res1.filled)}`);

    const state1 = await page.evaluate(() => ({
      billMonthly: document.getElementById('bill-monthly').getAttribute('aria-checked'),
      billAnnual: document.getElementById('bill-annual').getAttribute('aria-checked'),
      tierBasic: document.getElementById('tier-basic').getAttribute('aria-checked'),
      tierAnnual: document.getElementById('tier-annual').getAttribute('aria-checked'),
      tierPro: document.getElementById('tier-pro').getAttribute('aria-checked'),
      regUs: document.getElementById('reg-us').checked,
      regEu: document.getElementById('reg-eu').checked,
    }));
    assert.equal(state1.billAnnual, 'true');
    assert.equal(state1.billMonthly, 'false');
    assert.equal(state1.tierPro, 'true');
    assert.equal(state1.tierAnnual, 'false');
    assert.equal(state1.regEu, true);
    assert.equal(state1.regUs, false);

    // Second test: un-keyed multi-option array where two distinct [role="radiogroup"] widgets are targeted in a single spec
    await smartFillForm(page, {
      fields: [{ option: ['Monthly', 'Basic'] }],
    });

    const state2 = await page.evaluate(() => ({
      billMonthly: document.getElementById('bill-monthly').getAttribute('aria-checked'),
      tierBasic: document.getElementById('tier-basic').getAttribute('aria-checked'),
    }));
    assert.equal(state2.billMonthly, 'true');
    assert.equal(state2.tierBasic, 'true');
  });

  it('5. [contenteditable="plaintext-only"] and bare <div contenteditable> appear in inspectCompact and fill cleanly in smartFillForm', async () => {
    sim.setRoute(
      '/contenteditable-variants',
      `<!doctype html><html><head><title>ContentEditable Variants</title></head><body>
        <div class="field">
          <label id="lbl-notes">Release Notes</label>
          <div
            id="ce-plaintext"
            contenteditable="plaintext-only"
            aria-labelledby="lbl-notes"
            style="min-height: 30px; min-width: 150px; border: 1px solid #ccc;"
          ></div>
        </div>
        <div class="field">
          <div
            id="ce-bare"
            contenteditable
            aria-label="Executive Bio"
            style="min-height: 30px; min-width: 150px; border: 1px solid #ccc;"
          ></div>
        </div>
      </body></html>`
    );

    await page.goto(`${sim.baseUrl}/contenteditable-variants`, { waitUntil: 'domcontentloaded' });

    for (const mode of ['interactive', 'forms', 'all']) {
      const snap = await inspectCompact(page, { mode });
      assert.match(snap.text, /Release Notes/, `Expected Release Notes in inspectCompact(${mode})`);
      assert.match(snap.text, /Executive Bio/, `Expected Executive Bio in inspectCompact(${mode})`);
    }

    const fillRes = await smartFillForm(page, {
      fields: [
        { keys: 'Release Notes', value: 'Plaintext release 4.2.0' },
        { keys: 'Executive Bio', value: 'Principal Architect' },
      ],
    });
    assert.equal(fillRes.filledCount, 2);

    const texts = await page.evaluate(() => ({
      notes: document.getElementById('ce-plaintext').innerText.trim(),
      bio: document.getElementById('ce-bare').innerText.trim(),
    }));
    assert.equal(texts.notes, 'Plaintext release 4.2.0');
    assert.equal(texts.bio, 'Principal Architect');
  });

  it('6. ARIA [role="combobox"] respects frameIdx, overwrite: false, exact option preference ("Item 1" vs "Item 10"), and portal options on main document.body', async () => {
    sim.setRoute(
      '/combo-iframe',
      `<!doctype html><html><body>
        <div class="field">
          <label id="if-cat-lbl">Category</label>
          <button
            id="iframe-combo"
            type="button"
            role="combobox"
            aria-labelledby="if-cat-lbl"
            aria-expanded="false"
            style="width:160px;height:28px;"
          ></button>
        </div>
        <script>
          const btn = document.getElementById('iframe-combo');
          btn.addEventListener('click', () => {
            btn.setAttribute('aria-expanded', 'true');
            // Render portal listbox onto parent document.body!
            const hostDoc = window.parent.document;
            let portal = hostDoc.getElementById('iframe-portal-listbox');
            if (portal) portal.remove();
            portal = hostDoc.createElement('div');
            portal.id = 'iframe-portal-listbox';
            portal.setAttribute('role', 'listbox');
            for (const label of ['Hardware', 'Software']) {
              const opt = hostDoc.createElement('div');
              opt.setAttribute('role', 'option');
              opt.textContent = label;
              opt.style.padding = '4px 8px';
              opt.addEventListener('click', () => {
                btn.textContent = label;
                btn.setAttribute('data-selected', label);
                btn.setAttribute('aria-expanded', 'false');
                portal.remove();
              });
              portal.appendChild(opt);
            }
            hostDoc.body.appendChild(portal);
          });
        </script>
      </body></html>`
    );

    sim.setRoute(
      '/combo-main',
      `<!doctype html><html><head><title>Combobox Torture</title></head><body>
        <div class="field">
          <label id="item-lbl">Select Item</label>
          <button
            id="combo-item"
            type="button"
            role="combobox"
            aria-labelledby="item-lbl"
            aria-expanded="false"
            style="width:160px;height:28px;"
          ></button>
        </div>

        <div class="field">
          <label id="env-lbl">Environment</label>
          <button
            id="combo-env"
            type="button"
            role="combobox"
            aria-labelledby="env-lbl"
            aria-expanded="false"
            data-value="Production"
            style="width:160px;height:28px;"
          >Production</button>
        </div>

        <div class="field">
          <label id="main-cat-lbl">Category</label>
          <button
            id="main-combo-cat"
            type="button"
            role="combobox"
            aria-labelledby="main-cat-lbl"
            aria-expanded="false"
            style="width:160px;height:28px;"
          ></button>
        </div>

        <iframe id="combo-child" src="/combo-iframe" width="400" height="180"></iframe>

        <script>
          function mountPortal(btn, options) {
            let portal = document.getElementById('main-portal-listbox');
            if (portal) portal.remove();
            portal = document.createElement('div');
            portal.id = 'main-portal-listbox';
            portal.setAttribute('role', 'listbox');
            for (const text of options) {
              const opt = document.createElement('div');
              opt.setAttribute('role', 'option');
              opt.textContent = text;
              opt.style.padding = '4px 8px';
              opt.addEventListener('click', () => {
                btn.textContent = text;
                btn.setAttribute('data-value', text);
                btn.setAttribute('aria-expanded', 'false');
                portal.remove();
              });
              portal.appendChild(opt);
            }
            document.body.appendChild(portal);
          }

          document.getElementById('combo-item').addEventListener('click', function () {
            this.setAttribute('aria-expanded', 'true');
            // Deliberately put "Item 10" and "Item 100" BEFORE "Item 1"
            mountPortal(this, ['Item 10', 'Item 100', 'Item 1', 'Item 2']);
          });

          document.getElementById('combo-env').addEventListener('click', function () {
            this.setAttribute('aria-expanded', 'true');
            mountPortal(this, ['Production', 'Staging', 'Development']);
          });

          document.getElementById('main-combo-cat').addEventListener('click', function () {
            this.setAttribute('aria-expanded', 'true');
            mountPortal(this, ['Hardware', 'Software']);
          });
        </script>
      </body></html>`
    );

    await page.goto(`${sim.baseUrl}/combo-main`, { waitUntil: 'load' });

    const res = await smartFillForm(page, {
      overwrite: false,
      fields: [
        { keys: 'Select Item', value: 'Item 1' },
        { keys: 'Environment', value: 'Staging' }, // Should be skipped because overwrite: false and already "Production"
        { keys: 'Category', value: 'Hardware', frameIdx: 1 }, // Should fill iframe combobox via main body portal, leaving main-combo-cat empty
      ],
    });

    const mainState = await page.evaluate(() => ({
      item: document.getElementById('combo-item').textContent.trim(),
      env: document.getElementById('combo-env').textContent.trim(),
      mainCat: document.getElementById('main-combo-cat').textContent.trim(),
    }));
    const childFrame = page.frames().find((f) => f.url().includes('/combo-iframe'));
    const iframeCat = await childFrame.locator('#iframe-combo').textContent();

    assert.equal(mainState.item, 'Item 1', 'Must pick exact "Item 1" instead of prefix-matching "Item 10"');
    assert.equal(mainState.env, 'Production', 'Must respect overwrite: false on pre-populated combobox');
    assert.equal(mainState.mainCat, '', 'Must respect frameIdx: 1 and not click main frame Category combobox');
    assert.equal(iframeCat.trim(), 'Hardware', 'Must resolve portal option rendered on parent document.body');
    assert.ok(
      res.skipped.some((s) => s.reason === 'already-filled'),
      `Expected Environment combobox in skipped list, got ${JSON.stringify(res)}`
    );
  });

  it('7. Disabled <input type="file"> is skipped in Pass 2 auto-discovery so the enabled upload input receives the file', async () => {
    sim.setRoute(
      '/disabled-file-inputs',
      `<!doctype html><html><head><title>Disabled File Inputs</title></head><body>
        <div class="field">
          <label>Resume Upload <input id="file-disabled" type="file" disabled /></label>
        </div>
        <div class="field">
          <label>Resume Upload <input id="file-aria-disabled" type="file" aria-disabled="true" /></label>
        </div>
        <div class="field">
          <label>Resume Upload <input id="file-enabled" type="file" /></label>
        </div>
      </body></html>`
    );

    await page.goto(`${sim.baseUrl}/disabled-file-inputs`, { waitUntil: 'domcontentloaded' });

    const res = await smartFillForm(page, {
      fields: [{ keys: 'Resume Upload', file: sampleUploadFile }],
    });
    assert.equal(res.filledCount, 1);

    const uploadedCounts = await page.evaluate(() => ({
      disabled: document.getElementById('file-disabled').files.length,
      ariaDisabled: document.getElementById('file-aria-disabled').files.length,
      enabled: document.getElementById('file-enabled').files.length,
      enabledName: document.getElementById('file-enabled').files[0]?.name || '',
    }));
    assert.equal(uploadedCounts.disabled, 0);
    assert.equal(uploadedCounts.ariaDisabled, 0);
    assert.equal(uploadedCounts.enabled, 1);
    assert.equal(uploadedCounts.enabledName, 'candidate-cv.pdf');
  });

  it('8. Responsive hidden-duplicate traps (.first() bug): actFast targets visible desktop control when mobile twin is display:none', async () => {
    sim.setRoute(
      '/responsive-dups',
      `<!doctype html><html><head><title>Responsive Duplicates</title></head><body>
        <!-- Mobile hidden layout rendered first in DOM -->
        <div class="mobile-drawer" style="display: none;">
          <input class="promo-input" type="text" placeholder="Promo Code" />
          <button class="action-btn" type="button" onclick="window.__clicked = 'mobile'">Continue Step</button>
        </div>
        <!-- Desktop visible layout rendered second in DOM -->
        <div class="desktop-bar">
          <input id="desktop-promo" class="promo-input" type="text" placeholder="Promo Code" />
          <button id="desktop-btn" class="action-btn" type="button" onclick="window.__clicked = 'desktop'">Continue Step</button>
        </div>
      </body></html>`
    );

    await page.goto(`${sim.baseUrl}/responsive-dups`, { waitUntil: 'domcontentloaded' });

    // Click by selector
    await actFast(page, { action: 'click', selector: '.action-btn', timeoutMs: 1500 });
    assert.equal(await page.evaluate(() => window.__clicked), 'desktop');

    // Reset and click by text
    await page.evaluate(() => {
      window.__clicked = null;
    });
    await actFast(page, { action: 'click', text: 'Continue Step', timeoutMs: 1500 });
    assert.equal(await page.evaluate(() => window.__clicked), 'desktop');

    // Fill by selector
    await actFast(page, { action: 'fill', selector: '.promo-input', value: 'VIP2026', timeoutMs: 1500 });
    assert.equal(await page.locator('#desktop-promo').inputValue(), 'VIP2026');
  });

  it('9. Deeply nested Shadow DOM + same-origin iframe coordinate drop AND stale [data-tbm-ref] cleanup across frames', async () => {
    sim.setRoute(
      '/drop-iframe',
      `<!doctype html><html><body style="margin:0;padding:10px;">
        <div
          id="iframe-dropzone"
          style="width:180px;height:80px;background:#eef;border:2px dashed #339;"
        >Iframe Drop Here</div>
        <button id="iframe-only-btn" type="button" onclick="window.__iframeBtnClicked = true">Iframe Action</button>
        <script>
          const dz = document.getElementById('iframe-dropzone');
          dz.addEventListener('drop', (e) => {
            e.preventDefault();
            window.__iframeDrop = {
              text: e.dataTransfer.getData('text/plain'),
              files: [...e.dataTransfer.files].map((f) => f.name),
            };
          });
        </script>
      </body></html>`
    );

    sim.setRoute(
      '/shadow-iframe-drop',
      `<!doctype html><html><head><title>Shadow & Iframe Drop</title></head><body style="margin:0;padding:16px;">
        <outer-drop-host id="outer-host"></outer-drop-host>
        <iframe id="drop-frame" src="/drop-iframe" style="width:260px;height:160px;border:2px solid #444;margin-top:16px;"></iframe>
        <script>
          const outer = document.getElementById('outer-host');
          const sr1 = outer.attachShadow({ mode: 'open' });
          const innerHost = document.createElement('inner-drop-host');
          sr1.appendChild(innerHost);
          const sr2 = innerHost.attachShadow({ mode: 'open' });
          const dz = document.createElement('div');
          dz.id = 'shadow-dropzone';
          dz.textContent = 'Shadow Dropzone';
          dz.style.cssText = 'width:180px;height:80px;background:#efe;border:2px dashed #282;';
          dz.addEventListener('drop', (e) => {
            e.preventDefault();
            window.__shadowDrop = {
              text: e.dataTransfer.getData('text/plain'),
              files: [...e.dataTransfer.files].map((f) => f.name),
            };
          });
          sr2.appendChild(dz);
        </script>
      </body></html>`
    );

    await page.goto(`${sim.baseUrl}/shadow-iframe-drop`, { waitUntil: 'load' });

    // 9a. Coordinate drop on deeply nested Shadow DOM dropzone
    const shadowCoords = await page.evaluate(() => {
      const outer = document.getElementById('outer-host');
      const dz = outer.shadowRoot.querySelector('inner-drop-host').shadowRoot.getElementById('shadow-dropzone');
      const r = dz.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });

    await actFast(page, {
      action: 'drop',
      x: shadowCoords.x,
      y: shadowCoords.y,
      dropData: { 'text/plain': 'dropped-into-shadow' },
      file: sampleUploadFile,
    });

    const shadowDropResult = await page.evaluate(() => window.__shadowDrop);
    assert.deepEqual(shadowDropResult, {
      text: 'dropped-into-shadow',
      files: ['candidate-cv.pdf'],
    });

    // 9b. Coordinate drop on dropzone inside same-origin iframe
    const iframeCoords = await page.evaluate(() => {
      const frameEl = document.getElementById('drop-frame');
      const fr = frameEl.getBoundingClientRect();
      const dz = frameEl.contentDocument.getElementById('iframe-dropzone');
      const dr = dz.getBoundingClientRect();
      return {
        x: Math.round(fr.left + frameEl.clientLeft + dr.left + dr.width / 2),
        y: Math.round(fr.top + frameEl.clientTop + dr.top + dr.height / 2),
      };
    });

    await actFast(page, {
      action: 'drop',
      x: iframeCoords.x,
      y: iframeCoords.y,
      dropData: { 'text/plain': 'dropped-into-iframe' },
      file: sampleUploadFile,
    });

    const childFrame = page.frames().find((f) => f.url().includes('/drop-iframe'));
    const iframeDropResult = await childFrame.evaluate(() => window.__iframeDrop);
    assert.deepEqual(iframeDropResult, {
      text: 'dropped-into-iframe',
      files: ['candidate-cv.pdf'],
    });

    // 9c. [data-tbm-ref] inside iframe survives inspectCompact({ includeFrames: false }) (refs are stable per document)
    const snapWithFrames = await inspectCompact(page, { includeFrames: true });
    const match = /\[f1:(e\d+)\]\s+<button>\s+"Iframe Action"/.exec(snapWithFrames.text);
    assert.ok(match, `Expected Iframe Action ref in snapshot: ${snapWithFrames.text}`);
    const staleBareRef = match[1]; // e.g., "e1"

    await inspectCompact(page, { includeFrames: false });

    // Refs are never recycled within a document, so the ref is no longer wiped: it still resolves to the very
    // same iframe button (never to another element), and a new full snapshot hands out only numbers above it.
    await actFast(page, { action: 'click', ref: staleBareRef, timeoutMs: 1000 });
    assert.equal(await childFrame.evaluate(() => Boolean(window.__iframeBtnClicked)), true);
  });

  it('10. Additional SPA Scenario A: { option } works on <select> and [role="combobox"], and <select> respects overwrite: false', async () => {
    sim.setRoute(
      '/select-and-combo-option',
      `<!doctype html><html><head><title>Select Option & Overwrite</title></head><body>
        <div class="field">
          <label for="sel-country">Country</label>
          <select id="sel-country">
            <option value="">-- Choose Country --</option>
            <option value="AUST">Australia</option>
            <option value="USA">United States of America</option>
            <option value="US">US</option>
          </select>
        </div>
        <div class="field">
          <label for="sel-role">Role</label>
          <select id="sel-role">
            <option value="">-- Choose Role --</option>
            <option value="eng" selected>Engineering</option>
            <option value="sales">Sales</option>
          </select>
        </div>
        <div class="field">
          <label id="lbl-tz">Timezone</label>
          <button id="combo-tz" type="button" role="combobox" aria-labelledby="lbl-tz" style="width:140px;height:28px;"></button>
        </div>
        <script>
          document.getElementById('combo-tz').addEventListener('click', function () {
            const ul = document.createElement('div');
            ul.setAttribute('role', 'listbox');
            for (const tz of ['UTC+7', 'UTC+0']) {
              const o = document.createElement('div');
              o.setAttribute('role', 'option');
              o.textContent = tz;
              o.addEventListener('click', () => {
                this.textContent = tz;
                ul.remove();
              });
              ul.appendChild(o);
            }
            document.body.appendChild(ul);
          });
        </script>
      </body></html>`
    );

    await page.goto(`${sim.baseUrl}/select-and-combo-option`, { waitUntil: 'domcontentloaded' });

    // Pass { option: 'US' } for <select>, { option: 'Sales' } with overwrite: false on pre-selected <select>, and { option: 'UTC+7' } on [role="combobox"]
    await smartFillForm(page, {
      overwrite: false,
      fields: [
        { keys: 'Country', option: 'US' },
        { keys: 'Role', value: 'Sales' }, // Already 'Engineering', should be skipped when overwrite: false
        { keys: 'Timezone', option: 'UTC+7' },
      ],
    });

    const state = await page.evaluate(() => ({
      country: document.getElementById('sel-country').value,
      role: document.getElementById('sel-role').value,
      tz: document.getElementById('combo-tz').textContent.trim(),
    }));
    assert.equal(state.country, 'US', 'Should select exact "US" option via { option: "US" }');
    assert.equal(state.role, 'eng', 'Pre-selected non-placeholder <select> should not be overwritten when overwrite: false');
    assert.equal(state.tz, 'UTC+7', 'Combobox should accept { option: "UTC+7" } as well as { value }');
  });

  it('11. Additional SPA Scenario B: .form-group with mixed control types (<input> + [role="combobox"] vs <input> + <input type="file">)', async () => {
    sim.setRoute(
      '/mixed-form-group',
      `<!doctype html><html><head><title>Mixed Form Group</title></head><body>
        <!-- Group 1: text input + ARIA combobox in same .form-group -->
        <div class="form-group">
          <div>
            <span>City Name</span>
            <input id="inp-city" type="text" placeholder="Enter city" />
          </div>
          <div>
            <span id="state-lbl">State Province</span>
            <button id="combo-state" type="button" role="combobox" aria-labelledby="state-lbl" style="width:140px;height:28px;"></button>
          </div>
        </div>

        <!-- Group 2: single text input + file input in same .form-group -->
        <div class="form-group">
          <h4>Passport Full Name</h4>
          <input id="inp-passport-holder" type="text" />
          <input id="inp-passport-scan" type="file" />
        </div>

        <script>
          document.getElementById('combo-state').addEventListener('click', function () {
            const lb = document.createElement('div');
            lb.setAttribute('role', 'listbox');
            for (const st of ['California', 'Texas']) {
              const o = document.createElement('div');
              o.setAttribute('role', 'option');
              o.textContent = st;
              o.addEventListener('click', () => {
                this.textContent = st;
                lb.remove();
              });
              lb.appendChild(o);
            }
            document.body.appendChild(lb);
          });
        </script>
      </body></html>`
    );

    await page.goto(`${sim.baseUrl}/mixed-form-group`, { waitUntil: 'domcontentloaded' });

    await smartFillForm(page, {
      overwrite: true,
      fields: [
        { keys: 'State Province', value: 'California' },
        { keys: 'Passport Full Name', value: 'TRAN MINH' },
      ],
    });

    const state = await page.evaluate(() => ({
      city: document.getElementById('inp-city').value,
      stateCombo: document.getElementById('combo-state').textContent.trim(),
      passportHolder: document.getElementById('inp-passport-holder').value,
    }));

    assert.equal(state.city, '', 'Text input must not steal "State Province" value meant for sibling [role="combobox"]');
    assert.equal(state.stateCombo, 'California');
    assert.equal(state.passportHolder, 'TRAN MINH', 'Text input paired only with <input type="file"> in .form-group must still inherit group heading');
  });

  it('12. Additional SPA Scenario C: React-like re-rendering wizard with input formatting, dynamic step mount, sticky header scroll, and batchActions', async () => {
    sim.setRoute(
      '/react-wizard',
      `<!doctype html><html><head><title>React Wizard Simulation</title></head>
      <body style="margin:0;">
        <header style="position:sticky;top:0;height:60px;background:#222;color:#fff;z-index:10;">Sticky Header</header>
        <main id="app" style="padding:16px;"></main>
        <script>
          const state = { step: 1, phone: '', company: '', taxId: '', notes: '' };
          const app = document.getElementById('app');

          function render() {
            if (state.step === 1) {
              app.innerHTML = \`
                <div class="field">
                  <label for="wiz-company">Company Name</label>
                  <input id="wiz-company" type="text" value="\${state.company}" />
                </div>
                <div class="field">
                  <label for="wiz-phone">Phone Number</label>
                  <input id="wiz-phone" type="tel" value="\${state.phone}" />
                </div>
                <button id="wiz-next" type="button">Next Step</button>
              \`;
              document.getElementById('wiz-company').addEventListener('input', (e) => {
                state.company = e.target.value;
              });
              document.getElementById('wiz-phone').addEventListener('input', (e) => {
                const digits = e.target.value.replace(/\\D/g, '').slice(0, 10);
                state.phone = digits.length >= 6
                  ? \`(\${digits.slice(0,3)}) \${digits.slice(3,6)}-\${digits.slice(6)}\`
                  : digits;
                e.target.value = state.phone;
              });
              document.getElementById('wiz-next').addEventListener('click', () => {
                setTimeout(() => {
                  state.step = 2;
                  render();
                }, 40);
              });
            } else {
              app.innerHTML = \`
                <div style="height: 1200px;">Spacer before offscreen fields</div>
                <div class="field">
                  <label for="wiz-tax">Tax Identification</label>
                  <input id="wiz-tax" type="text" value="\${state.taxId}" />
                </div>
                <div class="field">
                  <label id="lbl-wiz-notes">Compliance Notes</label>
                  <div id="wiz-notes" contenteditable="plaintext-only" aria-labelledby="lbl-wiz-notes" style="min-height:40px;border:1px solid #888;">\${state.notes}</div>
                </div>
              \`;
              document.getElementById('wiz-tax').addEventListener('input', (e) => {
                state.taxId = e.target.value;
              });
              document.getElementById('wiz-notes').addEventListener('input', (e) => {
                state.notes = e.target.innerText;
              });
            }
          }
          render();
          window.__getWizState = () => state;
        </script>
      </body></html>`
    );

    await page.goto(`${sim.baseUrl}/react-wizard`, { waitUntil: 'domcontentloaded' });

    const batchRes = await batchActions(
      page,
      [
        {
          action: 'smart_fill_form',
          fields: [
            { keys: 'Company Name', value: 'Nexus Labs' },
            { keys: 'Phone Number', value: '4155550199' },
          ],
        },
        { action: 'click', text: 'Next Step' },
        { action: 'wait', selector: '#wiz-tax', state: 'visible', timeoutMs: 3000 },
        { action: 'scroll', selector: '#wiz-tax' },
        {
          action: 'smart_fill_form',
          fields: [
            { keys: 'Tax Identification', value: 'EIN-99-1234567' },
            { keys: 'Compliance Notes', value: 'SOC2 Type II verified' },
          ],
        },
      ],
      { returnSnapshot: true, snapshotMode: 'forms' }
    );

    assert.equal(batchRes.completed, 5);
    assert.equal(batchRes.blocked, false);
    assert.match(batchRes.snapshot, /EIN-99-1234567/);

    const wizState = await evaluateJs(page, { expression: 'window.__getWizState()' });
    assert.deepEqual(wizState.result, {
      step: 2,
      company: 'Nexus Labs',
      phone: '(415) 555-0199',
      taxId: 'EIN-99-1234567',
      notes: 'SOC2 Type II verified',
    });
  });
});
