// opus-round3: independent gatekeeper suite (opus-gatekeeper-2).
// Outcome-based: guard tests count real server-side submissions / DOM state instead of trusting
// the tool's own flags. "R3-BUG-*" tests target concrete defects found by reading src/*.mjs;
// "R3-REG-*" tests are independent regression/contract checks of critical paths.
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
  evaluateJs,
  extractCleanText,
  inspectCompact,
  resolveSafePath,
  smartFillForm,
} from '../src/dom-engine.mjs';
import { createJsonRpcHandler } from '../src/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.resolve(__dirname, '..', 'src', 'index.mjs');

const wrap = (body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>round3</title></head><body>${body}</body></html>`;

const jsSend = (f) => `fetch('/submit?f=${f}',{method:'POST'})`;

const PAGES = {
  blank: '<p>blank</p>',
  // Two yes/no questions inside a common wrapper whose class matches [class*="field"].
  nestedblocks: `<form onsubmit="return false"><div class="form-fields">
<fieldset><legend>Do you smoke?</legend>
  <label><input type="radio" name="smoke" value="yes">Yes</label>
  <label><input type="radio" name="smoke" value="no">No</label></fieldset>
<fieldset><legend>Are you over 18?</legend>
  <label><input type="radio" name="adult" value="yes">Yes</label>
  <label><input type="radio" name="adult" value="no">No</label></fieldset>
</div></form>`,
  // Same questions as siblings (no wrapper): scoping already works here (control case).
  siblingblocks: `<form onsubmit="return false">
<fieldset><legend>Do you smoke?</legend>
  <label><input type="radio" name="smoke" value="yes">Yes</label>
  <label><input type="radio" name="smoke" value="no">No</label></fieldset>
<fieldset><legend>Are you over 18?</legend>
  <label><input type="radio" name="adult" value="yes">Yes</label>
  <label><input type="radio" name="adult" value="no">No</label></fieldset>
</form>`,
  twoinputs: `<label>Email <input id="email" name="email"></label>
<label>Name <input id="name" name="fullname"></label>`,
  ariatextbox: `<div id="bio" role="textbox" aria-label="Bio" tabindex="0"
  style="display:block;border:1px solid #999;min-height:24px;width:240px"></div>
<label>Email <input id="email" name="email"></label>`,
  menudel: `<div role="menu" aria-label="Repo actions">
<div role="menuitem" tabindex="0" id="ren" style="padding:8px;width:160px">Rename</div>
<div role="menuitem" tabindex="0" id="del" style="padding:8px;width:160px" onclick="${jsSend('menudel')}">Delete</div>
</div>`,
  ctrlenter: `<form id="cf" action="/submit?f=ctrlenter" method="post">
<textarea id="msg" name="m">hello team</textarea>
<button type="submit">Send</button></form>
<script>
document.getElementById('msg').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); document.getElementById('cf').requestSubmit(); }
});
</script>`,
  typenl: `<form action="/submit?f=typenl" method="post"><input id="q" name="q"><button type="submit">Submit</button></form>`,
  safebtn: `<form action="/submit?f=safebtn" method="post" onsubmit="event.preventDefault(); window.__s = (window.__s||0)+1">
<input id="q" name="q"><button type="submit" id="srch">Search</button></form>`,
  refs: '<div id="list"><button id="a" type="button">Alpha</button><button id="b" type="button">Beta</button></div>',
  md: `<main><h2>Plan</h2><ul><li>One<ul><li>One.a</li></ul></li><li>Two</li></ul>
<blockquote><p>Quote <b>bold</b></p></blockquote><p>Visit <a href="/x">the docs</a>.</p>
<p style="display:none">HIDDEN-TEXT</p><table><tr><th>K</th><th>V</th></tr><tr><td>a|b</td><td>1</td></tr></table></main>`,
  api: `<p>api</p><script>window.__done = fetch('/api/data.json').then(r => r.json());</script>`,
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
    if (url.pathname === '/api/data.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hello: 'world', n: 42 }));
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
    res.writeHead(404);
    res.end('nf');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, counts, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

describe('opus-round3: browser gatekeeper suite', () => {
  let fx;
  let manager;
  let page;
  let tabId;

  const open = async (name, query = '') => {
    await page.goto(`${fx.base}/page/${name}${query}`, { waitUntil: 'load' });
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

  describe('smart_fill_form correctness', () => {
    it('R3-REG-01 option + keys scoped to sibling <fieldset>s answers only the matching question (control)', async () => {
      await open('siblingblocks');
      await smartFillForm(page, { fields: [{ keys: 'over 18', option: 'Yes' }] });
      const st = await page.evaluate(() => ({
        adult: document.querySelector('[name=adult]:checked')?.value ?? null,
        smoke: document.querySelector('[name=smoke]:checked')?.value ?? null,
      }));
      assert.deepEqual(st, { adult: 'yes', smoke: null });
    });

    it('R3-BUG-01 option + keys must not also answer a sibling question when both sit in a common [class*="field"] wrapper', async () => {
      await open('nestedblocks');
      const res = await smartFillForm(page, { fields: [{ keys: 'over 18', option: 'Yes' }] });
      const st = await page.evaluate(() => ({
        adult: document.querySelector('[name=adult]:checked')?.value ?? null,
        smoke: document.querySelector('[name=smoke]:checked')?.value ?? null,
      }));
      assert.equal(st.adult, 'yes', JSON.stringify(res));
      assert.equal(
        st.smoke,
        null,
        `"Do you smoke?" was answered "Yes" although only "over 18" was requested; filled=${JSON.stringify(res.filled)}`
      );
    });

    it('R3-BUG-02 one field with a non-CSS (Playwright) selector must not silently drop every other field in the frame', async () => {
      await open('twoinputs');
      const res = await smartFillForm(page, {
        fields: [
          { selector: 'text=Name', value: 'Bob' },
          { keys: 'Email', value: 'a@b.co' },
        ],
      }).catch((e) => ({ error: e.message }));
      const email = await page.inputValue('#email');
      assert.ok(
        email === 'a@b.co' || Boolean(res.error),
        `Email silently not filled and no error reported; result=${JSON.stringify(res)}`
      );
    });

    it('R3-BUG-03 a <div role="textbox"> (no contenteditable) target must not abort the whole frame fill', async () => {
      await open('ariatextbox');
      const res = await smartFillForm(page, {
        fields: [
          { keys: 'Bio', value: 'hello' },
          { keys: 'Email', value: 'a@b.co' },
        ],
      }).catch((e) => ({ error: e.message }));
      const email = await page.inputValue('#email');
      assert.ok(
        email === 'a@b.co' || Boolean(res.error),
        `Email silently not filled and no error reported; result=${JSON.stringify(res)}`
      );
    });

    it('R3-REG-02 smart_fill_form fills by keys and reports leftover/submitButtons without submitting', async () => {
      await open('typenl');
      const res = await smartFillForm(page, { fields: [{ keys: 'q', value: 'hello' }] });
      assert.equal(await page.inputValue('#q'), 'hello');
      assert.equal(res.stoppedBeforeSubmit, true);
      assert.ok(res.submitButtons.some((b) => b.text === 'Submit'), JSON.stringify(res.submitButtons));
      assert.equal(await submissions('typenl'), 0);
    });
  });

  describe('act_fast wait', () => {
    it('R3-BUG-04 wait { url } matches a literal URL that contains "?" (query string)', async () => {
      await open('blank', '?step=2');
      const res = await actFast(page, { action: 'wait', url: '/page/blank?step=2', timeoutMs: 1500 }).catch((e) => ({
        ok: false,
        error: e.message,
      }));
      assert.equal(res.ok, true, `literal current URL never matched: ${JSON.stringify(res)}`);
    });

    it('R3-REG-03 wait { url } regex form and { ms } cap', async () => {
      await open('blank', '?step=3');
      const res = await actFast(page, { action: 'wait', url: 'step=\\d$', timeoutMs: 1500 });
      assert.equal(res.ok, true);
      const t0 = Date.now();
      const w = await actFast(page, { action: 'wait', ms: 50 });
      assert.equal(w.ms, 50);
      assert.ok(Date.now() - t0 < 3000);
    });
  });

  describe('Submit guard (allowSubmit=false, counts real submissions)', () => {
    it('R3-BUG-05 blocks click on a role="menuitem" labelled "Delete"', async () => {
      await open('menudel');
      const res = await actFast(page, { action: 'click', selector: '#del', allowSubmit: false }).catch((e) => ({
        error: e.message,
      }));
      assert.equal(await submissions('menudel'), 0, `Delete menu item fired; tool returned ${JSON.stringify(res)}`);
    });

    it('R3-REG-04 a role="menuitem" labelled "Rename" stays clickable', async () => {
      await open('menudel');
      const res = await actFast(page, { action: 'click', selector: '#ren', allowSubmit: false });
      assert.equal(res.ok, true, JSON.stringify(res));
    });

    it('R3-BUG-06 blocks Control+Enter (send chord) in a <textarea> of a form whose button is "Send"', async () => {
      await open('ctrlenter');
      const res = await actFast(page, { action: 'press', selector: '#msg', key: 'Control+Enter', allowSubmit: false }).catch(
        (e) => ({ error: e.message })
      );
      assert.equal(await submissions('ctrlenter'), 0, `form was submitted; tool returned ${JSON.stringify(res)}`);
    });

    it('R3-REG-05 type with "\\n" into a form input is blocked and the form is not submitted', async () => {
      await open('typenl');
      const res = await actFast(page, { action: 'type', selector: '#q', value: 'abc\n', allowSubmit: false });
      assert.equal(res.blocked, true, JSON.stringify(res));
      assert.equal(await submissions('typenl'), 0);
    });

    it('R3-REG-06 batch_actions allowSubmit:false ceiling overrides step-level allowSubmit:true', async () => {
      await open('typenl');
      const { batchActions } = await import('../src/dom-engine.mjs');
      const res = await batchActions(
        page,
        [
          { action: 'fill', selector: '#q', value: 'x' },
          { action: 'click', text: 'Submit', allowSubmit: true },
        ],
        { allowSubmit: false }
      );
      assert.equal(res.blocked, true, JSON.stringify(res));
      assert.equal(await submissions('typenl'), 0);
    });

    it('R3-REG-07 safe submit label ("Search") is not over-blocked', async () => {
      await open('safebtn');
      const res = await actFast(page, { action: 'click', selector: '#srch', allowSubmit: false });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(await page.evaluate(() => window.__s), 1);
    });
  });

  describe('inspect_compact / extract_clean_text', () => {
    it('R3-REG-08 onlyChanged delta shows only the new element and keeps old refs resolvable', async () => {
      await open('refs');
      const snap = new Set();
      const base = await inspectCompact(page, { includeFrames: false }, snap);
      const betaRef = /\[(f0:e\d+)\] <button> "Beta"/.exec(base.text)?.[1];
      assert.ok(betaRef, base.text);
      await page.evaluate(() => {
        const c = document.createElement('button');
        c.type = 'button';
        c.id = 'g';
        c.textContent = 'Gamma';
        document.getElementById('list').append(c);
      });
      const delta = await inspectCompact(page, { includeFrames: false, onlyChanged: true }, snap);
      assert.ok(delta.text.includes('"Gamma"'), delta.text);
      assert.ok(!delta.text.includes('"Beta"'), delta.text);
      const { result } = await evaluateJs(page, { ref: betaRef, expression: 'el.id' });
      assert.equal(result, 'b');
      const q = await inspectCompact(page, { includeFrames: false, query: 'C\\+\\+|Gamma' }, snap);
      assert.ok(q.text.includes('Gamma') && !q.text.includes('Alpha'), q.text);
      const capped = await inspectCompact(page, { includeFrames: false, maxChars: 200 }, null);
      assert.ok(capped.text.length <= 200);
    });

    it('R3-REG-09 extract_clean_text markdown: nested list, blockquote, link, escaped table pipes, hidden text dropped', async () => {
      await open('md');
      const res = await extractCleanText(page, { format: 'markdown', includeFrames: false });
      const t = res.text;
      assert.ok(t.includes('## Plan'), t);
      assert.ok(t.includes('- One') && t.includes('  - One.a') && t.includes('- Two'), t);
      assert.ok(t.includes('> Quote bold'), t);
      assert.ok(t.includes('[the docs](/x)'), t);
      assert.ok(t.includes('| K | V |') && t.includes('| --- | --- |') && t.includes('a\\|b'), t);
      assert.ok(!t.includes('HIDDEN-TEXT'), t);
      const plain = await extractCleanText(page, { format: 'text', includeFrames: false, maxChars: 200 });
      assert.ok(plain.text.length <= 200 && !plain.text.includes('HIDDEN-TEXT'));
    });
  });

  describe('evaluate_js lexer', () => {
    it('R3-REG-10 trailing ";"/comments stripped without breaking strings, regexes, templates or division', async () => {
      await open('blank');
      const cases = [
        ['"a;b" // trailing;', 'a;b'],
        ['/\\/\\//.test("x//y"); /* c */', true],
        ['10 / 2 / 5 // division not regex', 1],
        ['`${`in${1 + 1}`}-${ {a: 3}.a }`;', 'in2-3'],
        ['return 7;', 7],
        ['(x) => x * 2', null],
        ['await Promise.resolve("ok");', 'ok'],
        ['({ a: 1 })', { a: 1 }],
      ];
      for (const [expression, expected] of cases) {
        const { result } = await evaluateJs(page, { expression });
        if (expression.startsWith('(x)')) {
          const r2 = await evaluateJs(page, { expression, arg: 21 });
          assert.equal(r2.result, 42, expression);
        } else {
          assert.deepEqual(result, expected, expression);
        }
      }
    });

    it('R3-REG-11 statement lists run exactly once (no double execution on SyntaxError fallback)', async () => {
      await open('blank');
      await evaluateJs(page, { expression: 'window.__n = (window.__n || 0) + 1; const z = 1;' });
      const { result } = await evaluateJs(page, { expression: 'window.__n' });
      assert.equal(result, 1);
      await assert.rejects(evaluateJs(page, { expression: 'window.__m = (window.__m||0)+1; throw new Error("boom")' }));
      assert.equal((await evaluateJs(page, { expression: 'window.__m' })).result, 1);
    });
  });

  describe('page_diagnostics', () => {
    it('R3-REG-12 urlFilter glob + reqId response-body detail', async () => {
      await open('blank');
      await manager.getDiagnostics(tabId, { clear: true });
      await open('api');
      await page.evaluate(() => window.__done);
      const diag = await manager.getDiagnostics(tabId, { statusFilter: 'all', urlFilter: '*/api/*.json' });
      assert.equal(diag.requests.length, 1, JSON.stringify(diag.requests));
      const reqId = diag.requests[0].reqId;
      const body = await manager.getDiagnostics(tabId, { reqId, part: 'response-body' });
      assert.deepEqual(JSON.parse(body.data), { hello: 'world', n: 42 });
      const none = await manager.getDiagnostics(tabId, { statusFilter: 'all', urlFilter: '*/nope/*.json' });
      assert.equal(none.requests.length, 0);
    });
  });
});

describe('opus-round3: path confinement', () => {
  it('R3-REG-13 resolveSafePath rejects traversal, absolute-outside, NUL, and (win32) ADS / reserved / trailing-dot names', () => {
    const inside = resolveSafePath('tmp-r3/out.txt');
    assert.ok(inside.toLowerCase().startsWith(fs.realpathSync(process.cwd()).toLowerCase()));
    assert.throws(() => resolveSafePath('../escape.txt'));
    assert.throws(() => resolveSafePath('a/../../escape.txt'));
    assert.throws(() => resolveSafePath(path.join(os.tmpdir(), 'x.txt')));
    assert.throws(() => resolveSafePath('ok\0.txt'));
    assert.throws(() => resolveSafePath('   '));
    if (process.platform === 'win32') {
      assert.throws(() => resolveSafePath('out.txt:hidden'));
      assert.throws(() => resolveSafePath('dir/nul.txt'));
      assert.throws(() => resolveSafePath('dir./x.txt'));
      assert.throws(() => resolveSafePath('C:relative.txt'));
    }
  });
});

describe('opus-round3: JSON-RPC / stdio', () => {
  it('R3-REG-14 handler: notification-only batch yields no reply; bad id / params types rejected', async () => {
    const handle = createJsonRpcHandler({});
    assert.equal(await handle([{ jsonrpc: '2.0', method: 'notifications/initialized' }]), null);
    assert.equal((await handle({ jsonrpc: '2.0', id: { x: 1 }, method: 'ping' })).error.code, -32600);
    assert.equal((await handle({ jsonrpc: '2.0', id: 1, method: 'ping', params: [1] })).error.code, -32602);
    assert.equal((await handle({ jsonrpc: '2.0', id: 2, method: 'nope' })).error.code, -32601);
    const call = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope' } });
    assert.equal(call.result.isError, true);
    const init = await handle({ jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    assert.equal(init.result.protocolVersion, '2025-03-26');
  });

  it('R3-REG-15 stdio Content-Length framing counts bytes, survives a chunk split inside a UTF-8 multibyte char', async () => {
    const child = spawn(process.execPath, [INDEX_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = Buffer.alloc(0);
    child.stdout.on('data', (d) => {
      out = Buffer.concat([out, d]);
    });
    try {
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'thử-ố', method: 'ping' }), 'utf8');
      const msg = Buffer.concat([Buffer.from(`content-length: ${body.length}\r\n\r\n`, 'utf8'), body]);
      const splitAt = msg.indexOf(Buffer.from('ố', 'utf8')) + 1; // inside the 3-byte sequence
      child.stdin.write(msg.subarray(0, 9));
      await new Promise((r) => setTimeout(r, 50));
      child.stdin.write(msg.subarray(9, splitAt));
      await new Promise((r) => setTimeout(r, 50));
      child.stdin.write(msg.subarray(splitAt));
      const deadline = Date.now() + 5000;
      let parsed = null;
      while (Date.now() < deadline && !parsed) {
        const s = out.toString('utf8');
        const m = /Content-Length: (\d+)\r\n\r\n/.exec(s);
        if (m) {
          const start = out.indexOf('\r\n\r\n') + 4;
          const len = Number(m[1]);
          if (out.length >= start + len) parsed = JSON.parse(out.subarray(start, start + len).toString('utf8'));
        }
        if (!parsed) await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(parsed, `no framed reply: ${JSON.stringify(out.toString('utf8'))}`);
      assert.equal(parsed.id, 'thử-ố');
      assert.deepEqual(parsed.result, {});
    } finally {
      child.kill();
    }
  });
});
