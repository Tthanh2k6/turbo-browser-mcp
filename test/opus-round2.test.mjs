// opus-round2: independent gatekeeper suite (opus-gatekeeper).
// Outcome-based: Submit-guard tests count real server-side submissions instead of trusting
// the tool's own "blocked" flag. Each test targets a concrete defect found by reading src/*.mjs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BrowserManager } from '../src/browser-manager.mjs';
import {
  actFast,
  evaluateJs,
  extractCleanText,
  inspectCompact,
  smartFillForm,
} from '../src/dom-engine.mjs';
import { createJsonRpcHandler } from '../src/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.resolve(__dirname, '..', 'src', 'index.mjs');

const wrap = (body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>round2</title></head><body>${body}</body></html>`;

const jsSend = (f) => `fetch('/submit?f=${f}',{method:'POST'})`;

const PAGES = {
  blank: '<p>blank</p>',
  // Icon-only send button: whitespace text nodes around an <svg>, accessible name from aria-label.
  iconws: `<div class="composer"><textarea id="msg">hello</textarea>
<button type="button" id="snd" aria-label="Send" style="width:60px;height:40px" onclick="${jsSend('iconws')}">
  <svg width="16" height="16" viewBox="0 0 16 16"><path d="M0 0L16 8L0 16z"></path></svg>
</button></div>`,
  // Glyph-only send button: visible text has no letters, accessible name from aria-label.
  glyph: `<button type="button" id="snd" aria-label="Send message" style="width:60px;height:40px" onclick="${jsSend('glyph')}">&#10148;</button>`,
  pressnl: `<form action="/submit?f=pressnl" method="post"><input id="q" name="q" value="x"><button type="submit">Submit</button></form>`,
  pressr: `<form action="/submit?f=pressr" method="post"><input id="q" name="q" value="x"><button type="submit">Submit</button></form>`,
  dragself: `<form action="/submit?f=dragself" method="post"><input name="q"><button type="submit" id="go" style="width:160px;height:50px">Submit</button></form>`,
  // Hand-rolled ARIA switch rendered as a type-less <button> inside a form (default type=submit).
  switchfill: `<form action="/submit?f=switchfill" method="post">
<span id="lab">Email alerts</span>
<button id="sw" role="switch" aria-checked="false" aria-labelledby="lab" style="width:60px;height:30px"
  onclick="this.setAttribute('aria-checked', this.getAttribute('aria-checked') === 'true' ? 'false' : 'true')">Toggle</button>
<button type="submit">Submit</button></form>`,
  // Hand-rolled ARIA combobox trigger rendered as a type-less <button> inside a form.
  combofill: `<form action="/submit?f=combofill" method="post">
<span id="cl">Country</span>
<button id="cb" role="combobox" aria-labelledby="cl" aria-expanded="false" style="width:160px;height:30px"
  onclick="document.getElementById('lb').hidden = false">Choose…</button>
<ul id="lb" role="listbox" hidden><li role="option">Vietnam</li><li role="option">Japan</li></ul>
<button type="submit">Submit</button></form>`,
  // Minified (React-style) table: no whitespace text nodes between cells.
  table: '<main><table><tr><th>Name</th><th>Price</th></tr><tr><td>Pro</td><td>$29</td></tr></table></main>',
  inline: '<main><div id="w"><span>un</span><b>believ</b><span>able</span> results</div></main>',
  refs: '<div id="list"><button id="a" type="button">Alpha</button><button id="b" type="button">Beta</button></div>',
};

function startFixture() {
  const counts = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/submit') {
      const f = url.searchParams.get('f') || '?';
      counts.set(f, (counts.get(f) || 0) + 1);
      req.resume();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(wrap('<h1>Submitted</h1>'));
      return;
    }
    if (url.pathname.startsWith('/page/')) {
      const name = url.pathname.slice(6);
      if (PAGES[name] !== undefined) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(wrap(PAGES[name]));
        return;
      }
    }
    if (url.pathname === '/slow500') {
      setTimeout(() => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('boom');
      }, 700);
      return;
    }
    res.writeHead(404);
    res.end('nf');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, counts, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

describe('opus-round2: browser gatekeeper suite', () => {
  let fx;
  let manager;
  let page;
  let tabId;

  const open = async (name) => {
    await page.goto(`${fx.base}/page/${name}`, { waitUntil: 'load' });
    return page;
  };
  const submissions = async (name) => {
    await page.waitForTimeout(600);
    return fx.counts.get(name) || 0;
  };

  before(async () => {
    fx = await startFixture();
    manager = new BrowserManager({ mode: 'launch', headless: true });
    await manager.tabsBatch([{ action: 'open', url: `${fx.base}/page/blank` }]);
    ({ page, tabId } = await manager.getPage());
  });

  after(async () => {
    await manager?.close();
    await new Promise((resolve) => fx.server.close(resolve));
  });

  describe('Submit guard (allowSubmit=false, counts real submissions)', () => {
    it('R2-01 blocks click on icon-only <button aria-label="Send"> whose text is whitespace around an <svg>', async () => {
      await open('iconws');
      const res = await actFast(page, { action: 'click', selector: '#snd', allowSubmit: false }).catch((e) => ({ error: e.message }));
      assert.equal(await submissions('iconws'), 0, `Send action fired; tool returned ${JSON.stringify(res)}`);
    });

    it('R2-02 blocks click on glyph-only <button aria-label="Send message">➤</button>', async () => {
      await open('glyph');
      const res = await actFast(page, { action: 'click', selector: '#snd', allowSubmit: false }).catch((e) => ({ error: e.message }));
      assert.equal(await submissions('glyph'), 0, `Send action fired; tool returned ${JSON.stringify(res)}`);
    });

    it('R2-03 blocks press key "\\n" (Playwright alias of Enter) on a form input', async () => {
      await open('pressnl');
      const res = await actFast(page, { action: 'press', selector: '#q', key: '\n', allowSubmit: false }).catch((e) => ({ error: e.message }));
      assert.equal(await submissions('pressnl'), 0, `form was submitted; tool returned ${JSON.stringify(res)}`);
    });

    it('R2-04 blocks untargeted press key "\\r" on a focused form input', async () => {
      await open('pressr');
      await page.focus('#q');
      const res = await actFast(page, { action: 'press', key: '\r', allowSubmit: false }).catch((e) => ({ error: e.message }));
      assert.equal(await submissions('pressr'), 0, `form was submitted; tool returned ${JSON.stringify(res)}`);
    });

    it('R2-05 blocks drag whose source/target is the submit button (mousedown+mouseup = click)', async () => {
      await open('dragself');
      const res = await actFast(page, {
        action: 'drag',
        selector: '#go',
        targetSelector: '#go',
        allowSubmit: false,
      }).catch((e) => ({ error: e.message }));
      assert.equal(await submissions('dragself'), 0, `form was submitted; tool returned ${JSON.stringify(res)}`);
    });

    it('R2-06 smart_fill_form (stopBeforeSubmit default) toggling a type-less <button role="switch"> must not submit its form', async () => {
      await open('switchfill');
      const res = await smartFillForm(page, { fields: [{ keys: 'Email alerts', value: true }] }).catch((e) => ({ error: e.message }));
      assert.equal(await submissions('switchfill'), 0, `form was submitted by smart_fill_form; tool returned ${JSON.stringify(res)}`);
    });

    it('R2-07 smart_fill_form opening a type-less <button role="combobox"> must not submit its form', async () => {
      await open('combofill');
      const res = await smartFillForm(page, { fields: [{ keys: 'Country', value: 'Vietnam' }] }).catch((e) => ({ error: e.message }));
      assert.equal(await submissions('combofill'), 0, `form was submitted by smart_fill_form; tool returned ${JSON.stringify(res)}`);
    });
  });

  describe('Snapshot / extraction fidelity', () => {
    it('R2-08 inspect_compact onlyChanged must not silently re-point refs of omitted (unchanged) elements', async () => {
      await open('refs');
      const snap = new Set();
      const base = await inspectCompact(page, { mode: 'interactive', includeFrames: false }, snap);
      const alphaRef = /\[(f0:e\d+)\] <button> "Alpha"/.exec(base.text)?.[1];
      assert.ok(alphaRef, `baseline missing Alpha: ${base.text}`);
      await page.evaluate(() => {
        const c = document.createElement('button');
        c.id = 'c';
        c.type = 'button';
        c.textContent = 'Gamma';
        document.getElementById('list').prepend(c);
      });
      const delta = await inspectCompact(page, { mode: 'interactive', includeFrames: false, onlyChanged: true }, snap);
      assert.ok(delta.text.includes('Gamma'), delta.text);
      assert.ok(!delta.text.includes('"Alpha"'), 'Alpha unchanged, so it is omitted from the delta (agent keeps using old ref)');
      const { result } = await evaluateJs(page, { ref: alphaRef, expression: 'el.id' });
      assert.equal(result, 'a', `ref ${alphaRef} issued for Alpha now resolves to #${result} after an onlyChanged snapshot omitted Alpha`);
    });

    it('R2-09 extract_clean_text (text) keeps table cells separated on minified tables', async () => {
      await open('table');
      const res = await extractCleanText(page, { format: 'text', includeFrames: false });
      assert.ok(!/NamePrice/.test(res.text), `header cells glued: ${JSON.stringify(res.text)}`);
      assert.ok(!/Pro\$29/.test(res.text), `body cells glued: ${JSON.stringify(res.text)}`);
    });

    it('R2-10 extract_clean_text (markdown) does not inject spaces between adjacent inline elements', async () => {
      await open('inline');
      const res = await extractCleanText(page, { format: 'markdown', includeFrames: false });
      assert.ok(res.text.includes('unbelievable results'), `inline text altered: ${JSON.stringify(res.text)}`);
    });
  });

  describe('evaluate_js lexer', () => {
    it('R2-11 trailing ";" is stripped after a non-ASCII identifier followed by division', async () => {
      await open('blank');
      const { result } = await evaluateJs(page, { expression: '(window.giá = 8) && window.giá / 2;' });
      assert.equal(result, 4);
    });
  });

  describe('page_diagnostics', () => {
    it('R2-12 clear:true must not swallow the failure of a request that was in flight when cleared', async () => {
      await open('blank');
      await manager.getDiagnostics(tabId, { clear: true });
      await page.evaluate(() => {
        window.__p = fetch('/slow500').then((r) => r.status).catch(() => -1);
      });
      await page.waitForTimeout(150);
      await manager.getDiagnostics(tabId, { clear: true });
      const status = await page.evaluate(() => window.__p);
      assert.equal(status, 500);
      await page.waitForTimeout(150);
      const diag = await manager.getDiagnostics(tabId, { statusFilter: 'all' });
      assert.ok(
        diag.networkErrors.some((r) => r.url.includes('/slow500') && r.status === 500),
        `500 response that completed after clear is missing: ${JSON.stringify(diag.networkErrors)} / requests=${JSON.stringify(diag.requests)}`
      );
    });
  });
});

describe('opus-round2: JSON-RPC robustness', () => {
  it('R2-13 a nested array inside a batch is an Invalid Request (-32600), not a recursive batch', async () => {
    const handle = createJsonRpcHandler({});
    const res = await handle([[{ jsonrpc: '2.0', id: 2, method: 'ping' }]]);
    assert.ok(Array.isArray(res) && res.length === 1, JSON.stringify(res));
    assert.equal(res[0]?.error?.code, -32600, `nested batch was executed recursively: ${JSON.stringify(res)}`);
  });

  it('R2-14 stdio: a deeply nested array message must not kill the server (next ping still answered)', async () => {
    const child = spawn(process.execPath, [INDEX_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = [];
    let buf = '';
    let exitCode = null;
    child.on('exit', (code) => {
      exitCode = code;
    });
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (l) {
          try {
            lines.push(JSON.parse(l));
          } catch {
            lines.push({ raw: l.slice(0, 80) });
          }
        }
      }
    });
    try {
      const depth = 20000;
      child.stdin.write(`${'['.repeat(depth)}${']'.repeat(depth)}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'ping' })}\n`);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !lines.some((l) => l && l.id === 77) && exitCode === null) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(
        lines.some((l) => l && l.id === 77 && l.result),
        `ping after deep-nested message not answered (exitCode=${exitCode}); replies=${JSON.stringify(lines).slice(0, 300)}`
      );
    } finally {
      child.kill();
    }
  });
});
