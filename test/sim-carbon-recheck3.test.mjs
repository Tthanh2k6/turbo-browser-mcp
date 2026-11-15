// sim-carbon-recheck3: Round-5 Pre-Opus Deep Auditor adversarial & regression suite (gemini-auditor-4).
// Strictly honors documented tool contracts and verifies real browser/server outcomes (HTTP POST counters,
// DOM values, focus targets, file attachments, extracted text/markdown, URL waits, and protocol contracts).
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
  capturePage,
  evaluateJs,
  extractCleanText,
  inspectCompact,
  smartFillForm,
} from '../src/dom-engine.mjs';
import { createJsonRpcHandler, parseCliArgs } from '../src/index.mjs';
import { diagnoseEnvironment } from '../src/playwright-loader.mjs';

const htmlDoc = (body, title = 'round5-recheck') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

function startRound5Server() {
  const posts = new Map();
  const pages = new Map();

  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    if (u.pathname === '/submit') {
      const k = u.searchParams.get('k') || 'default';
      req.resume();
      req.on('end', () => {
        posts.set(k, (posts.get(k) || 0) + 1);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(htmlDoc('<h1>Submitted</h1>', 'submitted'));
      });
      return;
    }
    if (u.pathname === '/api/ping') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (pages.has(u.pathname)) {
      const { body, title } = pages.get(u.pathname);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(htmlDoc(body, title));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(htmlDoc(`<p>route:${u.pathname}</p>`, 'route'));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        getPosts(key) {
          return posts.get(key) || 0;
        },
        clearPosts(key) {
          if (key) posts.delete(key);
          else posts.clear();
        },
        setPage(pathname, body, title = 'round5-recheck') {
          pages.set(pathname, { body, title });
        },
      });
    });
  });
}

describe('sim-carbon-recheck3: Round-5 deep adversarial & regression suite', { concurrency: 1 }, () => {
  let fx;
  let manager;
  let page;
  let tabId;
  let tmpDir;
  let sampleFile;
  let prevSaveRoot;
  let prevAllowSubmit;

  const openRoute = async (pathname, body, title) => {
    if (body !== undefined) fx.setPage(pathname, body, title);
    await page.goto(`${fx.baseUrl}${pathname}`, { waitUntil: 'load' });
    return page;
  };

  const settlePosts = async (key, ms = 350) => {
    await page.waitForTimeout(ms);
    return fx.getPosts(key);
  };

  before(async () => {
    prevAllowSubmit = process.env.TURBO_BROWSER_ALLOW_SUBMIT;
    delete process.env.TURBO_BROWSER_ALLOW_SUBMIT;
    prevSaveRoot = process.env.TURBO_BROWSER_SAVE_ROOT;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-r5-recheck-'));
    sampleFile = path.join(tmpDir, 'cv-r5.txt');
    fs.writeFileSync(sampleFile, 'round5 attachment payload\n', 'utf8');
    process.env.TURBO_BROWSER_SAVE_ROOT = [process.cwd(), tmpDir].join(path.delimiter);

    fx = await startRound5Server();
    fx.setPage('/blank', '<p>ready</p>');

    manager = new BrowserManager({ mode: 'launch', headless: true, defaultTimeoutMs: 1800 });
    await manager.tabsBatch([{ action: 'open', url: `${fx.baseUrl}/blank` }]);
    ({ page, tabId } = await manager.getPage());
  });

  after(async () => {
    if (prevAllowSubmit === undefined) delete process.env.TURBO_BROWSER_ALLOW_SUBMIT;
    else process.env.TURBO_BROWSER_ALLOW_SUBMIT = prevAllowSubmit;

    if (prevSaveRoot === undefined) delete process.env.TURBO_BROWSER_SAVE_ROOT;
    else process.env.TURBO_BROWSER_SAVE_ROOT = prevSaveRoot;

    await manager?.close();
    if (fx?.server) {
      await new Promise((resolve) => fx.server.close(resolve));
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('Adversarial Bug Reproductions (R5-BUG-01 .. R5-BUG-07)', () => {
    it('R5-BUG-01a act_fast press Enter on unfocusable targets (tabindex="" / tabindex="invalid" / closed <details> / content-visibility:hidden) must not submit the focused form', async () => {
      const targets = ['#badtab', '#emptytab', '#closedDet', '#cvHid'];
      for (const sel of targets) {
        const key = `r5b1a_${sel.slice(1)}`;
        fx.clearPosts(key);
        await openRoute(
          '/r5-bug-01a',
          `<form action="/submit?k=${key}" method="post">
            <input id="q" name="q" value="hello">
            <button type="submit">Submit</button>
          </form>
          <div id="badtab" tabindex="invalid" style="width:60px;height:20px">Invalid tabindex</div>
          <div id="emptytab" tabindex="" style="width:60px;height:20px">Empty tabindex</div>
          <details><summary>More</summary><input id="closedDet" style="width:60px;height:20px"></details>
          <div style="content-visibility:hidden;width:120px;height:30px"><input id="cvHid" style="width:60px;height:20px"></div>`
        );
        await page.focus('#q');
        const res = await actFast(page, { action: 'press', selector: sel, key: 'Enter', timeoutMs: 1000 }).catch(
          (err) => ({ ok: false, error: err.message })
        );
        const count = await settlePosts(key);
        assert.equal(
          count,
          0,
          `Enter targeting unfocusable ${sel} fell through to focused #q and POSTed ${count}x; res=${JSON.stringify(res)}`
        );
      }
    });

    it('R5-BUG-01b act_fast press Space (untargeted or via non-focusable target) must block focused [role="checkbox"] with destructive/submit label', async () => {
      fx.clearPosts('r5b1b_space');
      await openRoute(
        '/r5-bug-01b-space',
        `<div id="dangerChk" role="checkbox" tabindex="0" aria-checked="false"
              onclick="fetch('/submit?k=r5b1b_space',{method:'POST'})"
              onkeydown="if(event.key===' '||event.key==='Spacebar'){event.preventDefault();fetch('/submit?k=r5b1b_space',{method:'POST'});}">
           Delete account
         </div>
         <input id="dis" disabled>`
      );
      const direct = await actFast(page, { action: 'press', selector: '#dangerChk', key: 'Space' });
      assert.equal(direct.blocked, true, `Direct Space on #dangerChk should block: ${JSON.stringify(direct)}`);

      await page.focus('#dangerChk');
      const untargeted = await actFast(page, { action: 'press', key: 'Space' });
      assert.equal(untargeted.blocked, true, `Untargeted Space on focused #dangerChk must block: ${JSON.stringify(untargeted)}`);

      await page.focus('#dangerChk');
      const viaDisabled = await actFast(page, { action: 'press', selector: '#dis', key: 'Space', timeoutMs: 1000 }).catch(
        (err) => ({ ok: false, error: err.message })
      );
      assert.equal(
        await settlePosts('r5b1b_space'),
        0,
        `Space triggered focused [role=checkbox] "Delete account": untargeted=${JSON.stringify(untargeted)}, viaDisabled=${JSON.stringify(viaDisabled)}`
      );
    });

    it('R5-BUG-01c act_fast type containing "\\n" must not submit focused form when click on target preserves prior focus (mousedown preventDefault)', async () => {
      fx.clearPosts('r5b1c_type');
      await openRoute(
        '/r5-bug-01c-type',
        `<form action="/submit?k=r5b1c_type" method="post">
          <input id="q" name="q" value="seed">
          <button type="submit">Submit</button>
        </form>
        <button type="button" id="toolbarChip" onmousedown="event.preventDefault()">Bold</button>`
      );
      await page.focus('#q');
      const typeRes = await actFast(page, { action: 'type', selector: '#toolbarChip', value: 'x\n' }).catch((err) => ({
        ok: false,
        error: err.message,
      }));
      assert.equal(
        await settlePosts('r5b1c_type'),
        0,
        `type with newline on mousedown-preventDefault target left focus in #q and submitted form; res=${JSON.stringify(typeRes)}`
      );
    });

    it('R5-BUG-02a smart_fill_form Pass 2 filechooser upload guards against onchange requestSubmit() when stopBeforeSubmit is true', async () => {
      fx.clearPosts('r5b2_chooser');
      await openRoute(
        '/r5-bug-02a',
        `<form action="/submit?k=r5b2_chooser" method="post">
          <input id="hiddenFile" type="file" name="cv" style="display:none" onchange="this.form.requestSubmit()">
          <button type="button" id="pickBtn" onclick="document.getElementById('hiddenFile').click()">Choose CV</button>
          <button type="submit">Submit</button>
        </form>`
      );
      const rChooser = await smartFillForm(page, {
        fields: [{ selector: '#pickBtn', file: sampleFile }],
      });
      assert.equal(rChooser.filledCount, 1, JSON.stringify(rChooser));
      assert.equal(
        await settlePosts('r5b2_chooser'),
        0,
        `filechooser setFiles() bypassed stopBeforeSubmit and POSTed form; res=${JSON.stringify(rChooser)}`
      );
    });

    it('R5-BUG-02b smart_fill_form Pass 2 cleans up window submit guard even when onchange unmounts <input type="file"> (preserving future allowSubmit:true)', async () => {
      fx.clearPosts('r5b2_unmount');
      await openRoute(
        '/r5-bug-02b',
        `<form id="unmountForm" action="/submit?k=r5b2_unmount" method="post">
          <label>Resume <input id="cvInput" type="file" name="cv" onchange="window.__pickedName=this.files[0]?.name; this.remove();"></label>
          <button id="realSubmit" type="submit">Submit</button>
        </form>`
      );
      const rUnmount = await smartFillForm(page, {
        fields: [{ keys: 'Resume', file: sampleFile }],
      });
      assert.equal(rUnmount.filledCount, 1, JSON.stringify(rUnmount));

      const guardState = await page.evaluate(() => ({
        leakedCleanup: Boolean(window.__tbmCleanupFileGuard),
        pickedName: window.__pickedName || '',
        nativeSubmit: HTMLFormElement.prototype.submit.toString().includes('native code'),
        nativeReqSubmit: HTMLFormElement.prototype.requestSubmit.toString().includes('native code'),
      }));
      assert.deepEqual(
        guardState,
        {
          leakedCleanup: false,
          pickedName: 'cv-r5.txt',
          nativeSubmit: true,
          nativeReqSubmit: true,
        },
        `File guard leaked after <input type="file"> unmounted: ${JSON.stringify(guardState)}`
      );

      const navDone = page.waitForURL(/\/submit\?k=r5b2_unmount/, { timeout: 5000 });
      const submitRes = await actFast(page, { action: 'click', selector: '#realSubmit', allowSubmit: true });
      await navDone;
      assert.equal(submitRes.ok, true);
      assert.equal(
        fx.getPosts('r5b2_unmount'),
        1,
        'Leaked file-upload submit guard broke subsequent allowSubmit:true form submission'
      );
    });

    it('R5-BUG-02c smart_fill_form Pass 2 explicit ref/selector skips :disabled file inputs inside <fieldset disabled>', async () => {
      await openRoute(
        '/r5-bug-02c',
        `<form>
          <fieldset disabled>
            <input id="lockedFile" type="file" name="lockedFile">
          </fieldset>
        </form>`
      );
      const rLocked = await smartFillForm(page, {
        fields: [{ selector: '#lockedFile', file: sampleFile }],
      });
      const lockedLen = await page.evaluate(() => document.getElementById('lockedFile').files.length);
      assert.equal(lockedLen, 0, `Mutated :disabled file input inside <fieldset disabled>: files.length=${lockedLen}`);
      assert.equal(rLocked.filledCount, 0, `Reported :disabled file input as filled: ${JSON.stringify(rLocked)}`);
    });

    it('R5-BUG-03 <fieldset disabled> honors HTML first-child <legend> exception across inspect_compact, smart_fill_form, and act_fast press', async () => {
      fx.clearPosts('r5b3_press');
      await openRoute(
        '/r5-bug-03',
        `<form id="otherForm" action="/submit?k=r5b3_press" method="post">
          <input id="otherQ" name="otherQ" value="stay">
          <button type="submit">Submit</button>
        </form>
        <fieldset id="fs" disabled>
          <legend>
            <label><input type="checkbox" id="legCb"> Enable custom shipping</label>
            <label>Filter <input id="legFilter" name="filter"></label>
          </legend>
          <legend>
            <label>SecondLegend <input id="leg2Input" name="leg2"></label>
          </legend>
          <label>Street <input id="bodyStreet" name="street"></label>
          <div id="bodyAriaChk" role="checkbox" aria-checked="false" onclick="this.setAttribute('aria-checked','true')">Gift wrap</div>
        </fieldset>`
      );

      const snap = await inspectCompact(page, {});
      const lines = snap.text.split('\n');
      const legCbLine = lines.find((l) => l.includes('"Enable custom shipping"')) || '';
      const legFilterLine = lines.find((l) => l.includes('"Filter"')) || '';
      const leg2Line = lines.find((l) => l.includes('"SecondLegend"')) || '';
      const streetLine = lines.find((l) => l.includes('"Street"')) || '';
      const ariaChkLine = lines.find((l) => l.includes('"Gift wrap"')) || '';

      assert.ok(legCbLine && !legCbLine.includes('[disabled]'), `First <legend> checkbox is enabled per HTML spec: ${legCbLine}`);
      assert.ok(legFilterLine && !legFilterLine.includes('[disabled]'), `First <legend> input is enabled per HTML spec: ${legFilterLine}`);
      assert.ok(leg2Line.includes('[disabled]'), `Second <legend> input must be [disabled]: ${leg2Line}`);
      assert.ok(streetLine.includes('[disabled]'), `Fieldset body input must be [disabled]: ${streetLine}`);
      assert.ok(ariaChkLine.includes('[disabled]'), `Fieldset body [role=checkbox] must be [disabled]: ${ariaChkLine}`);

      const fillRes = await smartFillForm(page, {
        fields: [
          { keys: 'Enable custom shipping', value: true },
          { keys: 'Filter', value: 'express' },
          { keys: 'SecondLegend', value: 'should-not-fill' },
          { keys: 'Street', value: 'should-not-fill' },
          { keys: 'Gift wrap', value: true },
        ],
      });
      const domState = await page.evaluate(() => ({
        legCb: document.getElementById('legCb').checked,
        legFilter: document.getElementById('legFilter').value,
        leg2Input: document.getElementById('leg2Input').value,
        bodyStreet: document.getElementById('bodyStreet').value,
        bodyAriaChk: document.getElementById('bodyAriaChk').getAttribute('aria-checked'),
      }));
      assert.deepEqual(
        domState,
        {
          legCb: true,
          legFilter: 'express',
          leg2Input: '',
          bodyStreet: '',
          bodyAriaChk: 'false',
        },
        `smartFillForm first-<legend> vs disabled body mismatch: fill=${JSON.stringify(fillRes.filled)}, dom=${JSON.stringify(domState)}`
      );
      assert.equal(fillRes.filledCount, 2, JSON.stringify(fillRes.filled));

      await page.focus('#otherQ');
      const pressRes = await actFast(page, { action: 'press', selector: '#legFilter', key: 'Enter' });
      assert.equal(pressRes.ok, true, `Enabled input in first <legend> was falsely blocked as non-focusable: ${JSON.stringify(pressRes)}`);
      assert.equal(await settlePosts('r5b3_press'), 0);
    });

    it('R5-BUG-04 [inert] background subtrees (light + Shadow DOM) are ignored by smart_fill_form and inspect_compact, filling active dialog controls instead', async () => {
      await openRoute(
        '/r5-bug-04',
        `<main inert>
          <label>Email <input id="bgEmail" name="email"></label>
          <label>Country <select id="bgCountry"><option value="">--</option><option value="vn">Vietnam</option></select></label>
          <label>Notes <textarea id="bgNotes"></textarea></label>
          <div id="bgBio" contenteditable="true" aria-label="Bio" style="width:120px;height:28px"></div>
          <div id="bgCombo" role="combobox" aria-label="Plan" style="width:120px;height:28px">Select...</div>
          <div id="bgChk" role="checkbox" aria-checked="false" style="width:120px;height:24px" onclick="this.setAttribute('aria-checked','true')">Agree</div>
          <div id="bgSw" role="switch" aria-checked="false" style="width:120px;height:24px" onclick="this.setAttribute('aria-checked','true')">Alerts</div>
          <label>Resume <input id="bgFile" type="file"></label>
          <div id="inertShadowHost" inert></div>
        </main>
        <dialog open>
          <label>Email <input id="dlgEmail" name="email"></label>
          <label>Country <select id="dlgCountry"><option value="">--</option><option value="vn">Vietnam</option></select></label>
          <label>Notes <textarea id="dlgNotes"></textarea></label>
          <div id="dlgBio" contenteditable="true" aria-label="Bio" style="width:120px;height:28px"></div>
          <div id="dlgCombo" role="combobox" aria-label="Plan" style="width:120px;height:28px"
               onclick="document.getElementById('dlgListbox').hidden=false">Select...</div>
          <div id="dlgListbox" role="listbox" hidden>
            <div role="option" onclick="const c=document.getElementById('dlgCombo');c.textContent='Enterprise';c.setAttribute('data-value','Enterprise');this.parentElement.hidden=true;">Enterprise</div>
          </div>
          <div id="dlgChk" role="checkbox" aria-checked="false" style="width:120px;height:24px" onclick="this.setAttribute('aria-checked','true')">Agree</div>
          <div id="dlgSw" role="switch" aria-checked="false" style="width:120px;height:24px" onclick="this.setAttribute('aria-checked','true')">Alerts</div>
          <label>Resume <input id="dlgFile" type="file"></label>
          <div id="activeShadowHost"></div>
        </dialog>
        <script>
          const sInert = document.getElementById('inertShadowHost').attachShadow({ mode: 'open' });
          sInert.innerHTML = '<label>Token <input id="shInertTok"></label>';
          const sActive = document.getElementById('activeShadowHost').attachShadow({ mode: 'open' });
          sActive.innerHTML = '<label>Token <input id="shActiveTok"></label>';
        </script>`
      );

      const res = await smartFillForm(page, {
        fields: [
          { keys: 'Email', value: 'active@co.vn' },
          { keys: 'Country', value: 'Vietnam' },
          { keys: 'Notes', value: 'active note' },
          { keys: 'Bio', value: 'active bio' },
          { keys: 'Plan', value: 'Enterprise' },
          { keys: 'Agree', value: true },
          { keys: 'Alerts', value: true },
          { keys: 'Resume', file: sampleFile },
          { keys: 'Token', value: 'tok-999' },
        ],
      });

      const state = await page.evaluate(() => ({
        bg: {
          email: document.getElementById('bgEmail').value,
          country: document.getElementById('bgCountry').value,
          notes: document.getElementById('bgNotes').value,
          bio: document.getElementById('bgBio').textContent,
          chk: document.getElementById('bgChk').getAttribute('aria-checked'),
          sw: document.getElementById('bgSw').getAttribute('aria-checked'),
          files: document.getElementById('bgFile').files.length,
          tok: document.getElementById('inertShadowHost').shadowRoot.getElementById('shInertTok').value,
        },
        dlg: {
          email: document.getElementById('dlgEmail').value,
          country: document.getElementById('dlgCountry').value,
          notes: document.getElementById('dlgNotes').value,
          bio: document.getElementById('dlgBio').textContent.trim(),
          combo: document.getElementById('dlgCombo').getAttribute('data-value'),
          chk: document.getElementById('dlgChk').getAttribute('aria-checked'),
          sw: document.getElementById('dlgSw').getAttribute('aria-checked'),
          files: document.getElementById('dlgFile').files.length,
          tok: document.getElementById('activeShadowHost').shadowRoot.getElementById('shActiveTok').value,
        },
      }));

      assert.deepEqual(
        state.bg,
        { email: '', country: '', notes: '', bio: '', chk: 'false', sw: 'false', files: 0, tok: '' },
        `Mutated [inert] background controls: ${JSON.stringify(state.bg)}`
      );
      assert.deepEqual(
        state.dlg,
        {
          email: 'active@co.vn',
          country: 'vn',
          notes: 'active note',
          bio: 'active bio',
          combo: 'Enterprise',
          chk: 'true',
          sw: 'true',
          files: 1,
          tok: 'tok-999',
        },
        `Failed to fill active <dialog> controls: ${JSON.stringify({ dlg: state.dlg, filled: res.filled })}`
      );

      const snap = await inspectCompact(page, {});
      const enabledInteractiveLines = snap.text
        .split('\n')
        .filter((l) => l.startsWith('[f0:') && !l.includes('[disabled]'));
      assert.equal(
        enabledInteractiveLines.length,
        9,
        `inspect_compact exposed [inert] background controls as enabled interactive targets:\n${snap.text}`
      );
    });

    it('R5-BUG-05 smart_fill_form selector supports Playwright non-CSS selectors and host-scoped Shadow DOM selectors like act_fast', async () => {
      await openRoute(
        '/r5-bug-05',
        `<label>Work Email <input id="plainEmail" name="email"></label>
        <div id="host1"></div>
        <div id="host2"></div>
        <div id="menuHost" role="listbox" hidden>
          <div role="option" onclick="const cb=document.getElementById('host2').shadowRoot.querySelector('[role=combobox]'); cb.textContent='Pro'; cb.setAttribute('data-value','Pro'); this.parentElement.hidden=true;">Pro</div>
        </div>
        <script>
          const s1 = document.getElementById('host1').attachShadow({ mode: 'open' });
          s1.innerHTML = '<input class="city" placeholder="City"><div role="combobox" style="width:100px;height:24px">Select...</div>';
          const s2 = document.getElementById('host2').attachShadow({ mode: 'open' });
          s2.innerHTML = '<input class="city" placeholder="City"><div role="combobox" style="width:100px;height:24px" onclick="document.getElementById(\\'menuHost\\').hidden=false">Select...</div>';
        </script>`
      );

      const res = await smartFillForm(page, {
        fields: [
          { selector: 'xpath=//input[@id="plainEmail"]', value: 'dev@acme.io' },
          { selector: '#host2 .city', value: 'Da Nang' },
          { selector: '#host2 [role="combobox"]', value: 'Pro' },
        ],
      });

      const st = await page.evaluate(() => ({
        plainEmail: document.getElementById('plainEmail').value,
        host1City: document.getElementById('host1').shadowRoot.querySelector('.city').value,
        host2City: document.getElementById('host2').shadowRoot.querySelector('.city').value,
        host2Combo: document.getElementById('host2').shadowRoot.querySelector('[role="combobox"]').getAttribute('data-value'),
      }));

      assert.deepEqual(
        st,
        {
          plainEmail: 'dev@acme.io',
          host1City: '',
          host2City: 'Da Nang',
          host2Combo: 'Pro',
        },
        `smartFillForm selector parity failed: st=${JSON.stringify(st)}, res=${JSON.stringify(res)}`
      );
      assert.equal(res.filledCount, 3, JSON.stringify(res));
    });

    it('R5-BUG-06a extract_clean_text markdown <pre> never leaks display:none / visibility:hidden / aria-hidden text via textContent fallback', async () => {
      await openRoute(
        '/r5-bug-06a',
        `<main>
          <p>Public summary</p>
          <pre><span style="display:none">SECRET_DISPLAY_NONE</span></pre>
          <pre style="visibility:hidden">SECRET_VIS_HIDDEN<span style="visibility:visible"></span></pre>
          <pre><span aria-hidden="true">001 </span>const safe = 42;</pre>
        </main>`
      );
      for (const format of ['text', 'markdown']) {
        const out = await extractCleanText(page, { includeFrames: false, format });
        assert.ok(out.text.includes('Public summary'), `${format}: ${out.text}`);
        assert.ok(out.text.includes('const safe = 42;'), `${format}: ${out.text}`);
        assert.ok(
          !out.text.includes('SECRET_DISPLAY_NONE') &&
            !out.text.includes('SECRET_VIS_HIDDEN') &&
            !out.text.includes('001'),
          `${format} leaked hidden <pre> content: ${JSON.stringify(out.text)}`
        );
      }
    });

    it('R5-BUG-06b extract_clean_text pickRoot skips visibility:hidden <main> containing only empty visibility:visible placeholders', async () => {
      await openRoute(
        '/r5-bug-06b',
        `<main style="visibility:hidden">HIDDEN_DRAFT<div style="visibility:visible"></div></main>
        <article><p>PUBLISHED_STORY</p></article>`
      );
      for (const format of ['text', 'markdown']) {
        const out = await extractCleanText(page, { includeFrames: false, format });
        assert.ok(out.text.includes('PUBLISHED_STORY'), `${format} missed visible <article>: ${JSON.stringify(out.text)}`);
        assert.ok(!out.text.includes('HIDDEN_DRAFT'), `${format} leaked HIDDEN_DRAFT: ${JSON.stringify(out.text)}`);
      }
    });

    it('R5-BUG-07a act_fast wait { url } treats "*" globs strictly without premature unescaped-regex "/*" or "." false positives', async () => {
      await openRoute('/app', '<p>app root</p>');
      await page.evaluate(() => {
        setTimeout(() => history.pushState({}, '', '/app/created-42'), 120);
      });
      const waitRes = await actFast(page, { action: 'wait', url: '/app/*', timeoutMs: 4000 });
      assert.equal(waitRes.ok, true);
      assert.ok(
        waitRes.url.endsWith('/app/created-42'),
        `wait url '/app/*' resolved prematurely on '${waitRes.url}' before navigation to '/app/created-42'`
      );

      await openRoute('/files_pdf', '<p>not a pdf path</p>');
      await assert.rejects(
        actFast(page, { action: 'wait', url: '/files/*.pdf', timeoutMs: 250 }),
        /Timed out|waitForURL/i,
        'Glob /files/*.pdf must not match /files_pdf via unescaped regex'
      );
    });

    it('R5-BUG-07b inspect_compact sets truncated=true whenever maxChars slices a long URL/Title header', async () => {
      await openRoute('/long-header', '<p>static text only</p>', 'LongHeaderTitle_'.repeat(16));
      const snap = await inspectCompact(page, { maxChars: 200 });
      assert.ok(snap.charCount <= 200, `charCount ${snap.charCount} exceeded maxChars 200`);
      assert.equal(snap.truncated, true, `Header sliced to 200 chars must set truncated=true: ${JSON.stringify(snap)}`);
    });

    it('R5-BUG-08 act_fast wait { url } supports regex patterns containing "*" (e.g. ".*", "\\\\d*", "^...$") alongside "*" globs', async () => {
      await openRoute('/orders/42', '<p>order</p>');
      await page.evaluate(() => {
        setTimeout(() => history.pushState({}, '', '/orders/42?paid=true'), 80);
      });
      const res1 = await actFast(page, {
        action: 'wait',
        url: '/orders/.*\\?paid=true$',
        timeoutMs: 1500,
      });
      assert.equal(res1.ok, true);
      assert.ok(res1.url.endsWith('/orders/42?paid=true'), `Unexpected URL: ${res1.url}`);

      const res2 = await actFast(page, {
        action: 'wait',
        url: '^https?://[^/]+/orders/\\d*\\?paid=true$',
        timeoutMs: 1000,
      });
      assert.equal(res2.ok, true);
    });

    it('R5-BUG-09 <fieldset disabled> handles open Shadow DOM controls consistently across inspect_compact, smart_fill_form, and act_fast press (including first <legend>)', async () => {
      fx.clearPosts('r5b9_press');
      await openRoute(
        '/r5-bug-09',
        `<form action="/submit?k=r5b9_press" method="post">
          <input id="priorFocus" name="q" value="armed">
          <button type="submit">Submit</button>
        </form>
        <fieldset disabled>
          <legend><div id="legShadowHost"></div></legend>
          <div id="bodyShadowHost"></div>
        </fieldset>
        <script>
          const sLeg = document.getElementById('legShadowHost').attachShadow({ mode: 'open' });
          sLeg.innerHTML = '<label>LegendTok <input id="legShIn"></label><div id="legShChk" role="checkbox" aria-checked="false" style="width:90px;height:22px" onclick="this.setAttribute(\\'aria-checked\\',\\'true\\')">LegendOpt</div>';
          const sBody = document.getElementById('bodyShadowHost').attachShadow({ mode: 'open' });
          sBody.innerHTML = '<label>BodyTok <input id="bodyShIn"></label><div id="bodyShChk" role="checkbox" aria-checked="false" style="width:90px;height:22px" onclick="this.setAttribute(\\'aria-checked\\',\\'true\\')">BodyOpt</div>';
        </script>`
      );

      const snap = await inspectCompact(page, {});
      const lines = snap.text.split('\n');
      const legInLine = lines.find((l) => l.includes('"LegendTok"')) || '';
      const bodyInLine = lines.find((l) => l.includes('"BodyTok"')) || '';
      assert.ok(legInLine && !legInLine.includes('[disabled]'), `First <legend> shadow input must stay enabled: ${legInLine}`);
      assert.ok(bodyInLine.includes('[disabled]'), `Disabled fieldset body shadow input must be [disabled]: ${bodyInLine}`);

      await smartFillForm(page, {
        fields: [
          { keys: 'LegendTok', value: 'enabled-ok' },
          { keys: 'LegendOpt', value: true },
          { keys: 'BodyTok', value: 'must-not-fill' },
          { keys: 'BodyOpt', value: true },
        ],
      });

      const vals = await page.evaluate(() => {
        const sLeg = document.getElementById('legShadowHost').shadowRoot;
        const sBody = document.getElementById('bodyShadowHost').shadowRoot;
        return {
          legVal: sLeg.getElementById('legShIn').value,
          legChk: sLeg.getElementById('legShChk').getAttribute('aria-checked'),
          bodyVal: sBody.getElementById('bodyShIn').value,
          bodyChk: sBody.getElementById('bodyShChk').getAttribute('aria-checked'),
        };
      });
      assert.deepEqual(vals, {
        legVal: 'enabled-ok',
        legChk: 'true',
        bodyVal: '',
        bodyChk: 'false',
      });

      await page.focus('#priorFocus');
      const okLegPress = await actFast(page, { action: 'press', selector: '#legShadowHost #legShIn', key: 'Enter' });
      assert.equal(okLegPress.ok, true, `Enabled first-<legend> shadow input press should succeed: ${JSON.stringify(okLegPress)}`);
      assert.equal(await settlePosts('r5b9_press'), 0);
    });

    it('R5-BUG-10 smart_fill_form selector supports cascading Pass 1.5 [role="combobox"] mounted during Pass 1 and preserves document order across Shadow + Light DOM', async () => {
      await openRoute(
        '/r5-bug-10',
        `<label>Country <select id="cSel" onchange="window.__mountCity()"><option value="">--</option><option value="vn">Vietnam</option></select></label>
        <div id="mountPoint"></div>
        <div id="cityListbox" role="listbox" hidden>
          <div role="option" onclick="const c=document.getElementById('dynHost').shadowRoot.querySelector('[role=combobox]');c.textContent='Hanoi';c.setAttribute('data-value','Hanoi');this.parentElement.hidden=true;">Hanoi</div>
        </div>
        <div id="firstShadowHost"></div>
        <input class="ordered-item" id="secondLightInput">
        <script>
          window.__mountCity = () => {
            const mp = document.getElementById('mountPoint');
            mp.innerHTML = '<div id="dynHost"></div>';
            const sr = document.getElementById('dynHost').attachShadow({ mode: 'open' });
            sr.innerHTML = '<div role="combobox" aria-label="City" style="width:110px;height:24px" onclick="document.getElementById(\\'cityListbox\\').hidden=false">Select...</div>';
          };
          const srFirst = document.getElementById('firstShadowHost').attachShadow({ mode: 'open' });
          srFirst.innerHTML = '<input class="ordered-item" id="firstShadowInput">';
        </script>`
      );

      const res = await smartFillForm(page, {
        fields: [
          { keys: 'Country', value: 'Vietnam' },
          { selector: '#dynHost [role="combobox"]', value: 'Hanoi' },
          { selector: '.ordered-item', value: 'first-in-doc' },
        ],
      });

      const state = await page.evaluate(() => ({
        city: document.getElementById('dynHost')?.shadowRoot?.querySelector('[role="combobox"]')?.getAttribute('data-value') || null,
        firstShadow: document.getElementById('firstShadowHost').shadowRoot.getElementById('firstShadowInput').value,
        secondLight: document.getElementById('secondLightInput').value,
      }));
      assert.deepEqual(
        state,
        {
          city: 'Hanoi',
          firstShadow: 'first-in-doc',
          secondLight: '',
        },
        `Cascading combobox or Shadow/Light DOM order mismatch: state=${JSON.stringify(state)}, res=${JSON.stringify(res)}`
      );
      assert.equal(res.filledCount, 3, JSON.stringify(res));
    });

    it('R5-BUG-11 closed <details> and content-visibility:hidden are excluded from inspect_compact, smart_fill_form, and extract_clean_text, while offscreen content-visibility:auto stays focusable/usable', async () => {
      fx.clearPosts('r5b11_press');
      await openRoute(
        '/r5-bug-11',
        `<main>
          <form action="/submit?k=r5b11_press" method="post">
            <input id="topFormIn" name="q" value="seed">
            <button type="submit">Submit</button>
          </form>
          <details>
            <summary>FAQ Question</summary>
            <p>COLLAPSED_DETAILS_BODY</p>
            <label>HiddenToken <input id="closedDetIn" name="hiddenToken" style="width:100px;height:20px"></label>
          </details>
          <div style="content-visibility:hidden;width:180px;height:40px">
            <p>CV_HIDDEN_BODY</p>
            <label>CvToken <input id="cvHiddenIn" name="cvToken" style="width:100px;height:20px"></label>
          </div>
          <div style="margin-top:3200px;content-visibility:auto;contain-intrinsic-size:120px">
            <p>CV_AUTO_VISIBLE_BODY</p>
            <label>AutoToken <input id="cvAutoIn" name="autoToken" style="width:100px;height:20px"></label>
          </div>
        </main>`
      );

      const snap = await inspectCompact(page, {});
      assert.ok(snap.text.includes('"FAQ Question"'), snap.text);
      assert.ok(snap.text.toLowerCase().includes('"autotoken"'), `Offscreen content-visibility:auto input must remain inspectable: ${snap.text}`);
      assert.ok(
        !/hiddentoken|closeddetin|cvtoken|cvhiddenin/i.test(snap.text),
        `inspect_compact leaked closed <details> or content-visibility:hidden controls:\n${snap.text}`
      );

      const fillRes = await smartFillForm(page, {
        fields: [
          { keys: 'HiddenToken', value: 'bad-det' },
          { keys: 'CvToken', value: 'bad-cv' },
          { keys: 'AutoToken', value: 'good-auto' },
        ],
      });
      const vals = await page.evaluate(() => ({
        det: document.getElementById('closedDetIn').value,
        cvh: document.getElementById('cvHiddenIn').value,
        cva: document.getElementById('cvAutoIn').value,
      }));
      assert.deepEqual(vals, { det: '', cvh: '', cva: 'good-auto' }, JSON.stringify({ vals, fillRes }));

      for (const format of ['text', 'markdown']) {
        const ext = await extractCleanText(page, { includeFrames: false, format });
        assert.ok(ext.text.includes('FAQ Question') && ext.text.includes('CV_AUTO_VISIBLE_BODY'), `${format}: ${ext.text}`);
        assert.ok(
          !ext.text.includes('COLLAPSED_DETAILS_BODY') && !ext.text.includes('CV_HIDDEN_BODY'),
          `${format} leaked collapsed <details> or content-visibility:hidden text: ${ext.text}`
        );
      }

      await page.focus('#topFormIn');
      const pressAuto = await actFast(page, { action: 'press', selector: '#cvAutoIn', key: 'Enter' });
      assert.equal(pressAuto.ok, true, `Offscreen content-visibility:auto input was falsely treated as non-focusable: ${JSON.stringify(pressAuto)}`);
      assert.equal(await settlePosts('r5b11_press'), 0);
    });
  });

  describe('Round-5 Regression & Invariant Suite (R5-REG-01 .. R5-REG-07)', () => {
    it('R5-REG-01 #125 press Enter/Space Submit guard holds across disabled/hidden/inert targets and Shadow DOM + iframe activeElement, while allowSubmit:true submits', async () => {
      fx.clearPosts('r5reg1');
      await openRoute(
        '/r5-reg-01',
        `<div id="shHost"></div>
        <input id="disTarget" disabled>
        <script>
          const sr = document.getElementById('shHost').attachShadow({ mode: 'open' });
          sr.innerHTML = '<form action="/submit?k=r5reg1" method="post"><input id="shIn" name="q" value="v"><button type="submit">Submit</button></form>';
        </script>`
      );
      await page.evaluate(() => {
        document.getElementById('shHost').shadowRoot.getElementById('shIn').focus();
      });
      const blocked = await actFast(page, { action: 'press', selector: '#disTarget', key: 'Enter' });
      assert.equal(blocked.blocked, true, JSON.stringify(blocked));
      assert.equal(await settlePosts('r5reg1'), 0);

      const nav = page.waitForURL(/\/submit\?k=r5reg1/, { timeout: 4000 });
      const allowed = await actFast(page, { action: 'press', key: 'Enter', allowSubmit: true });
      await nav;
      assert.equal(allowed.ok, true);
      assert.equal(fx.getPosts('r5reg1'), 1);
    });

    it('R5-REG-02 #125 smart_fill_form blocks onchange submit()/requestSubmit()/onsubmit when stopBeforeSubmit:true, restores prototypes, and permits when stopBeforeSubmit:false', async () => {
      fx.clearPosts('r5reg2');
      await openRoute(
        '/r5-reg-02',
        `<form id="f2" action="/submit?k=r5reg2" method="post" onsubmit="fetch('/submit?k=r5reg2_inline',{method:'POST'})">
          <label>Name <input id="nm" name="nm" onchange="this.form.submit()"></label>
          <label>Role <select id="rl" name="rl" onchange="this.form.requestSubmit()">
            <option value="">--</option><option value="eng">Engineer</option>
          </select></label>
          <button type="submit">Submit</button>
        </form>`
      );
      const safeFill = await smartFillForm(page, {
        fields: [
          { keys: 'Name', value: 'Minh' },
          { keys: 'Role', value: 'Engineer' },
        ],
      });
      assert.equal(safeFill.stoppedBeforeSubmit, true);
      assert.equal(await settlePosts('r5reg2'), 0);
      assert.equal(fx.getPosts('r5reg2_inline'), 0);

      const protoIntact = await page.evaluate(
        () =>
          HTMLFormElement.prototype.submit.toString().includes('native code') &&
          HTMLFormElement.prototype.requestSubmit.toString().includes('native code')
      );
      assert.equal(protoIntact, true, 'HTMLFormElement.prototype methods must be restored to native functions');

      fx.clearPosts('r5reg2_allow');
      await openRoute(
        '/r5-reg-02-allow',
        `<form action="/submit?k=r5reg2_allow" method="post">
          <label>Email <input id="em" name="em" onchange="this.form.requestSubmit()"></label>
          <button type="submit">Submit</button>
        </form>`
      );
      const nav = page.waitForURL(/\/submit\?k=r5reg2_allow/, { timeout: 4000 });
      const allowFill = await smartFillForm(page, {
        stopBeforeSubmit: false,
        fields: [{ keys: 'Email', value: 'go@now.io' }],
      });
      await nav;
      assert.equal(allowFill.stoppedBeforeSubmit, false);
      assert.equal(fx.getPosts('r5reg2_allow'), 1);
    });

    it('R5-REG-03 #125 extract_clean_text preserves visibility:visible descendants inside visibility:hidden containers across tables, lists, blockquotes, and links', async () => {
      await openRoute(
        '/r5-reg-03',
        `<main style="visibility:hidden">
          <p>HIDDEN_LEAD</p>
          <blockquote style="visibility:visible">SHOWN_QUOTE</blockquote>
          <ul>
            <li>HIDDEN_ITEM</li>
            <li style="visibility:visible">SHOWN_ITEM</li>
          </ul>
          <table>
            <tr><th style="visibility:visible">Col1</th><th>HiddenCol</th></tr>
            <tr><td style="visibility:visible">Val1</td><td>HiddenVal</td></tr>
          </table>
          <p><a href="/docs" style="visibility:hidden">HIDDEN_LBL <span style="visibility:visible">DocsLink</span></a></p>
        </main>`
      );
      const txt = await extractCleanText(page, { includeFrames: false, format: 'text' });
      const md = await extractCleanText(page, { includeFrames: false, format: 'markdown' });

      for (const [fmt, s] of [['text', txt.text], ['markdown', md.text]]) {
        assert.ok(s.includes('SHOWN_QUOTE'), `${fmt}: ${s}`);
        assert.ok(s.includes('SHOWN_ITEM'), `${fmt}: ${s}`);
        assert.ok(s.includes('Col1') && s.includes('Val1'), `${fmt}: ${s}`);
        assert.ok(s.includes('DocsLink'), `${fmt}: ${s}`);
        assert.ok(
          !s.includes('HIDDEN_LEAD') &&
            !s.includes('HIDDEN_ITEM') &&
            !s.includes('HiddenCol') &&
            !s.includes('HiddenVal') &&
            !s.includes('HIDDEN_LBL'),
          `${fmt} leaked hidden text: ${s}`
        );
      }
      assert.match(md.text, /> SHOWN_QUOTE/);
      assert.match(md.text, /\[DocsLink\]\(\/docs\)/);
    });

    it('R5-REG-04 inspect_compact onlyChanged + query + maxChars caps hold and preserve existing refs', async () => {
      const buttons = Array.from({ length: 40 }, (_, i) => `<button id="b${i}" type="button">Btn_${i}</button>`).join('');
      await openRoute('/r5-reg-04', `<div>${buttons}</div>`);
      const st = manager.getSnapshotState(page);

      const full = await inspectCompact(page, { maxChars: 600 }, st);
      assert.equal(full.truncated, true);
      assert.ok(full.charCount <= 600, `charCount=${full.charCount}`);

      const baseline = await inspectCompact(page, { maxChars: 8000 }, st);
      assert.equal(baseline.truncated, false);

      await page.evaluate(() => {
        document.getElementById('b5').textContent = 'Btn_5_Updated';
      });
      const delta = await inspectCompact(page, { onlyChanged: true }, st);
      assert.match(delta.text, /\[f0:e6\] <button> "Btn_5_Updated"/);
      assert.ok(!delta.text.includes('"Btn_0"'), delta.text);
    });

    it('R5-REG-05 evaluate_js handles nested template braces, regex literals, element (el, arg), and savePath', async () => {
      await openRoute('/r5-reg-05', '<div id="box" data-k="turbo">Hello</div>');
      const saveTarget = path.join(tmpDir, 'eval-out.json');

      const r1 = await evaluateJs(page, {
        expression: '`${({ a: arg * 2 }).a}:${/https?:\\/\\//.test(location.href)}` // trailing comment;',
        arg: 21,
        savePath: saveTarget,
      });
      assert.equal(r1.result, '42:true');
      assert.equal(fs.readFileSync(saveTarget, 'utf8'), '42:true');

      const r2 = await evaluateJs(page, {
        selector: '#box',
        arg: 'mcp',
        expression: 'async (el, suffix) => `${el.dataset.k}-${suffix}`;',
      });
      assert.equal(r2.result, 'turbo-mcp');
    });

    it('R5-REG-06 capture_page (png/jpeg/pdf), open_many + isolatedContext, storageState, and batch_actions work cleanly', async () => {
      const shotPath = path.join(tmpDir, 'shot.jpg');
      const pdfPath = path.join(tmpDir, 'doc.pdf');

      await openRoute('/r5-reg-06', '<h1>Capture Check</h1><button id="okBtn" type="button" onclick="window.__ok=1">Continue</button>');
      const shot = await capturePage(page, { mode: 'screenshot', type: 'jpeg', quality: 75, savePath: shotPath });
      assert.equal(shot.ok, true);
      assert.equal(shot.base64, undefined);
      assert.ok(fs.statSync(shotPath).size > 100);

      const pdf = await capturePage(page, { mode: 'pdf', savePath: pdfPath });
      assert.equal(pdf.ok, true);
      assert.ok(fs.statSync(pdfPath).size > 100);

      const batch = await batchActions(
        page,
        [{ action: 'click', selector: '#okBtn' }],
        { returnSnapshot: true }
      );
      assert.equal(batch.blocked, false);
      assert.ok(batch.snapshot.includes('Continue'));
      assert.equal(await page.evaluate(() => window.__ok), 1);

      const multi = await manager.tabsBatch([
        { action: 'open_many', urls: [`${fx.baseUrl}/blank`, `${fx.baseUrl}/api/ping`], isolatedContext: 'r5-iso', activate: false },
      ]);
      const openedIds = multi.results[0].opened.map((o) => o.tabId).filter(Boolean);
      assert.equal(openedIds.length, 2);
      assert.equal(multi.activeTabId, tabId);
      for (const id of openedIds) {
        await manager.tabsBatch([{ action: 'close', tabId: id }]);
      }
    });

    it('R5-REG-07 CLI arg parser, diagnoseEnvironment, and JSON-RPC handler contracts hold', async () => {
      const cli = parseCliArgs(['--mode=launch', '--timeout', '9000', '--headed', '--allow-submit']);
      assert.equal(cli.unknown, null);
      assert.deepEqual(cli.envOverrides, {
        TURBO_BROWSER_MODE: 'launch',
        TURBO_BROWSER_TIMEOUT_MS: '9000',
        TURBO_BROWSER_HEADLESS: 'false',
        TURBO_BROWSER_ALLOW_SUBMIT: 'true',
      });

      const doc = await diagnoseEnvironment('http://127.0.0.1:1');
      assert.equal(doc.playwrightLoaded, true);
      assert.equal(doc.cdpReachable, false);

      const rpc = createJsonRpcHandler(manager);
      const list = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.equal(list.result.tools.length, 11);
    });
  });
});
