// Independent adversarial suite (opus-reviewer). Self-contained fixture; outcome-based:
// every Submit-guard test counts real form submissions on the server instead of trusting
// the tool's own "blocked" flag. Tests marked `todo` document design gaps (reported, not gating).
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
  capturePage,
  evaluateJs,
  extractCleanText,
  smartFillForm,
} from '../src/dom-engine.mjs';
import { createJsonRpcHandler } from '../src/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.resolve(__dirname, '..', 'src', 'index.mjs');
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const wrap = (body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>opus</title></head><body>${body}</body></html>`;

const PAGES = {
  notype: `<form action="/submit?f=notype" method="post"><input id="q" name="q"><button id="fin">Finish</button></form>`,
  image: `<form action="/submit?f=image" method="post"><input name="q"><input type="image" id="img" src="${GIF}" alt="Go" width="60" height="30"></form>`,
  span: `<form action="/submit?f=span" method="post"><button type="submit" id="sb" style="padding:10px"><span id="inner">Send application</span></button></form>`,
  space: `<form action="/submit?f=space" method="post"><input name="q"><button type="submit" id="go">Submit</button></form>`,
  typenl: `<form action="/submit?f=typenl" method="post"><input id="q" name="q"><button type="submit">Submit</button></form>`,
  modenter: `<form action="/submit?f=modenter" method="post"><input id="q" name="q"><button type="submit">Submit</button></form>`,
  iframe: `<p>outer</p><iframe id="fr" src="/page/iframeinner" style="width:400px;height:200px;border:0"></iframe>`,
  iframeinner: `<form action="/submit?f=iframe" method="post"><button type="submit" id="pay" style="width:200px;height:60px">Pay now</button></form>`,
  shadow: `<x-pay id="host"></x-pay><script>
    const h = document.getElementById('host');
    const r = h.attachShadow({ mode: 'open' });
    r.innerHTML = '<form action="/submit?f=shadow" method="post"><button type="submit" id="sp" style="width:200px;height:60px">Pay now</button></form>';
  </script>`,
  scrolled: `<div style="height:2200px">tall</div><form action="/submit?f=scrolled" method="post"><button type="submit" id="late" style="width:200px;height:60px">Submit</button></form>`,
  label: `<form action="/submit?f=label" method="post"><label for="sbl" id="lbl">Click to proceed</label><button type="submit" id="sbl">Submit</button></form>`,
  upload: `<form action="/submit?f=upload" method="post"><input name="q"><button type="submit" id="up">Submit</button></form>`,
  enterbtn: `<form action="/submit?f=enterbtn" method="post"><input name="q"><button id="nb">OK</button></form>`,
  xoa: `<button type="button" id="del" onclick="fetch('/submit?f=xoa',{method:'POST'})">Xoá</button>`,
  batchsafe: `<form action="/submit?f=batchsafe" method="post"><input id="a" name="a"><input id="b" name="b"><button type="submit" id="send">Send</button></form>`,
  override: `<form action="/submit?f=override" method="post"><button type="submit" id="send">Send</button></form>`,
  radios: `<form><p>Do you need visa sponsorship?</p>
    <label><input type="radio" name="v" value="yes">Yes</label>
    <label><input type="radio" name="v" value="no">No</label>
    <label><input type="radio" name="v" value="notsure">Not sure</label></form>`,
  fieldset: `<form><fieldset><legend>Contact</legend>
    <label>Email <input id="email" name="contact_email"></label>
    <label>Phone <input id="phone" name="contact_phone"></label></fieldset></form>`,
  select: `<select id="s"><option value="">--</option><option value="10">Item 10</option><option value="1">Item 1</option></select>
    <select id="m" multiple size="4"><option value="a">Alpha</option><option value="b">Beta</option><option value="c">Gamma</option></select>`,
  dialogs: `<button type="button" id="dlg" onclick="alert('hi'); window.__c = confirm('sure?'); document.body.dataset.done='1'">Show dialogs</button>`,
  dl: `<a id="dl" href="/dl-stall">get file</a>`,
  img: `<img id="pix" src="/pix.png" width="10" height="10">`,
  blank: `<p>blank</p>`,
};

function startFixture() {
  const counts = new Map();
  const stalled = new Set();
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
    if (url.pathname === '/dl-stall') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="stall.bin"',
        'content-length': '1000000',
      });
      res.write(Buffer.alloc(16));
      stalled.add(res);
      return;
    }
    if (url.pathname === '/pix.png') {
      res.writeHead(200, { 'content-type': 'image/gif' });
      res.end(Buffer.from(GIF.split(',')[1], 'base64'));
      return;
    }
    res.writeHead(404);
    res.end('nf');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, counts, stalled, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

describe('opus-independent: browser adversarial suite', () => {
  let fx;
  let manager;
  let page;
  let mainTabId;

  const open = async (name) => {
    await page.goto(`${fx.base}/page/${name}`, { waitUntil: 'load' });
    return page;
  };
  const submissions = async (name) => {
    await page.waitForTimeout(500);
    return fx.counts.get(name) || 0;
  };

  before(async () => {
    fx = await startFixture();
    manager = new BrowserManager({ mode: 'launch', headless: true });
    await manager.tabsBatch([{ action: 'open', url: `${fx.base}/page/blank` }]);
    ({ page, tabId: mainTabId } = await manager.getPage());
  });

  after(async () => {
    for (const r of fx.stalled) r.destroy();
    await manager?.close();
    await new Promise((resolve) => fx.server.close(resolve));
  });

  // ---------- Submit guard: outcome-based ----------
  describe('Submit guard (counts real server submissions, allowSubmit=false)', () => {
    it('blocks click on a type-less <button> inside a form (default type=submit)', async () => {
      await open('notype');
      const res = await actFast(page, { action: 'click', selector: '#fin', allowSubmit: false }).catch((e) => ({ error: e.message }));
      assert.equal(await submissions('notype'), 0, `form was submitted; tool returned ${JSON.stringify(res)}`);
    });

    it('blocks click on <input type="image"> submitter', async () => {
      await open('image');
      const res = await actFast(page, { action: 'click', selector: '#img', allowSubmit: false }).catch((e) => ({ error: e.message }));
      assert.equal(await submissions('image'), 0, `form was submitted; tool returned ${JSON.stringify(res)}`);
    });

    it('blocks click on a descendant <span> of a submit button', async () => {
      await open('span');
      const res = await actFast(page, { action: 'click', selector: '#inner', allowSubmit: false }).catch((e) => ({ error: e.message }));
      assert.equal(await submissions('span'), 0, `form was submitted; tool returned ${JSON.stringify(res)}`);
    });

    it('blocks click by visible text on the submit button label', async () => {
      await open('span');
      const before = fx.counts.get('span') || 0;
      const res = await actFast(page, { action: 'click', text: 'Send application', allowSubmit: false }).catch((e) => ({ error: e.message }));
      assert.equal(await submissions('span'), before, `form was submitted; tool returned ${JSON.stringify(res)}`);
    });

    it('blocks pressing Space on a focused submit button', async () => {
      await open('space');
      const res = await actFast(page, { action: 'press', key: 'Space', selector: '#go', allowSubmit: false }).catch((e) => ({ error: e.message }));
      assert.equal(await submissions('space'), 0, `form was submitted; tool returned ${JSON.stringify(res)}`);
    });

    it('blocks type action whose value contains a newline (keyboard Enter)', async () => {
      await open('typenl');
      const res = await actFast(page, { action: 'type', selector: '#q', value: 'hello\n', allowSubmit: false }).catch((e) => ({ error: e.message }));
      assert.equal(await submissions('typenl'), 0, `form was submitted; tool returned ${JSON.stringify(res)}`);
    });

    it('blocks modified Enter (Shift+Enter / Control+Enter) in a form input', async () => {
      await open('modenter');
      const r1 = await actFast(page, { action: 'press', key: 'Shift+Enter', selector: '#q', allowSubmit: false }).catch((e) => ({ error: e.message }));
      await page.waitForTimeout(300);
      if (!page.url().includes('/submit')) {
        await actFast(page, { action: 'press', key: 'Control+Enter', selector: '#q', allowSubmit: false }).catch(() => {});
      }
      assert.equal(await submissions('modenter'), 0, `form was submitted; first result ${JSON.stringify(r1)}`);
    });

    it('blocks coordinate click that lands on a submit button inside an iframe', async () => {
      await open('iframe');
      const frame = page.frames().find((f) => f.url().includes('iframeinner'));
      await frame.waitForSelector('#pay');
      const box = await frame.locator('#pay').boundingBox();
      const res = await actFast(page, { action: 'click', x: box.x + box.width / 2, y: box.y + box.height / 2, allowSubmit: false });
      assert.equal(await submissions('iframe'), 0, `iframe form was submitted; tool returned ${JSON.stringify(res)}`);
    });

    it('blocks coordinate click that lands on a submit button inside open Shadow DOM', async () => {
      await open('shadow');
      const box = await page.locator('#sp').boundingBox();
      const res = await actFast(page, { action: 'click', x: box.x + box.width / 2, y: box.y + box.height / 2, allowSubmit: false });
      assert.equal(await submissions('shadow'), 0, `shadow form was submitted; tool returned ${JSON.stringify(res)}`);
    });

    it('blocks coordinate click on a submit button after the viewport was scrolled (control)', async () => {
      await open('scrolled');
      await page.locator('#late').scrollIntoViewIfNeeded();
      const box = await page.locator('#late').boundingBox();
      const res = await actFast(page, { action: 'click', x: box.x + box.width / 2, y: box.y + box.height / 2, allowSubmit: false });
      assert.equal(res.blocked, true);
      assert.equal(await submissions('scrolled'), 0);
    });

    it('blocks click on a <label for> that activates a submit button', async () => {
      await open('label');
      const res = await actFast(page, { action: 'click', selector: '#lbl', allowSubmit: false }).catch((e) => ({ error: e.message }));
      assert.equal(await submissions('label'), 0, `form was submitted; tool returned ${JSON.stringify(res)}`);
    });

    it('upload action must not click a submit button to open a file chooser', async () => {
      await open('upload');
      const res = await actFast(page, { action: 'upload', selector: '#up', file: INDEX_PATH, timeoutMs: 1500, allowSubmit: false }).catch((e) => ({ error: e.message }));
      assert.equal(await submissions('upload'), 0, `form was submitted; tool returned ${JSON.stringify(res)}`);
    });

    it('blocks Enter pressed on a focused type-less <button> in a form', async () => {
      await open('enterbtn');
      const res = await actFast(page, { action: 'press', key: 'Enter', selector: '#nb', allowSubmit: false }).catch((e) => ({ error: e.message }));
      assert.equal(await submissions('enterbtn'), 0, `form was submitted; tool returned ${JSON.stringify(res)}`);
    });

    it('blocks Vietnamese delete label "Xoá" (precomposed á; regex \\b fails after non-ASCII)', async () => {
      await open('xoa');
      const res = await actFast(page, { action: 'click', selector: '#del', allowSubmit: false });
      assert.equal(res.blocked, true, `not blocked: ${JSON.stringify(res)}`);
      assert.equal(await submissions('xoa'), 0);
    });

    it('blocks keyboard-only Space when focus is already on the submit button (no target)', async () => {
      await open('space');
      const before = fx.counts.get('space') || 0;
      await page.focus('#go');
      const res = await actFast(page, { action: 'press', key: ' ', allowSubmit: false }).catch((e) => ({ error: e.message }));
      assert.equal(await submissions('space'), before, `form was submitted; tool returned ${JSON.stringify(res)}`);
    });

    it('blocks type action whose value contains a carriage return', async () => {
      await open('typenl');
      const before = fx.counts.get('typenl') || 0;
      const res = await actFast(page, { action: 'type', selector: '#q', value: 'x\r', allowSubmit: false }).catch((e) => ({ error: e.message }));
      assert.equal(await submissions('typenl'), before, `form was submitted; tool returned ${JSON.stringify(res)}`);
    });

    it('does not block a login button "Đăng nhập" (no false positive)', async () => {
      await page.setContent(wrap('<button type="button" id="login">Đăng nhập</button>'));
      const res = await actFast(page, { action: 'click', selector: '#login', allowSubmit: false });
      assert.equal(res.ok, true, JSON.stringify(res));
    });

    it('batch stops at the blocked step and does not run later steps (control)', async () => {
      await open('batchsafe');
      const res = await batchActions(page, [
        { action: 'fill', selector: '#a', value: 'one' },
        { action: 'click', selector: '#send' },
        { action: 'fill', selector: '#b', value: 'two' },
      ], { allowSubmit: false });
      assert.equal(res.blocked, true);
      assert.equal(res.completed, 2);
      assert.equal(await page.inputValue('#b'), '');
      assert.equal(await submissions('batchsafe'), 0);
    });

    it('batch-level allowSubmit=false is a ceiling (a step cannot re-enable submit)', async () => {
      await open('override');
      await batchActions(page, [{ action: 'click', selector: '#send', allowSubmit: true }], { allowSubmit: false });
      assert.equal(await submissions('override'), 0);
    });

    it('batch_actions tolerates a null step and returns a structured error', async () => {
      await open('blank');
      const res = await batchActions(page, [null], {});
      assert.equal(res.completed, 0);
      assert.equal(res.results[0].ok, false);
    });
  });

  // ---------- Form fill correctness ----------
  describe('smart_fill_form correctness', () => {
    it('option "No" must not also select "Not sure" (substring over-match on radios)', async () => {
      await open('radios');
      await smartFillForm(page, { fields: [{ check: 'No' }] });
      const checked = await page.evaluate(() => document.querySelector('input[name=v]:checked')?.value ?? null);
      assert.equal(checked, 'no');
    });

    it('fieldset-scoped keys fill only their own input (email vs phone)', async () => {
      await open('fieldset');
      await smartFillForm(page, {
        fields: [
          { keys: 'email', value: 'a@b.co' },
          { keys: 'phone', value: '0123' },
        ],
      });
      assert.equal(await page.inputValue('#email'), 'a@b.co');
      assert.equal(await page.inputValue('#phone'), '0123', 'phone got the email value (block-text over-match)');
    });

    it('single <select> prefers the exact option ("Item 1" not "Item 10")', async () => {
      await open('select');
      await smartFillForm(page, { fields: [{ selector: '#s', value: 'Item 1' }] });
      assert.equal(await page.inputValue('#s'), '1');
    });

    it('<select multiple> with values selects exactly the requested options (control)', async () => {
      await open('select');
      await smartFillForm(page, { fields: [{ selector: '#m', values: ['Alpha', 'Gamma'] }] });
      const sel = await page.evaluate(() => [...document.querySelector('#m').selectedOptions].map((o) => o.value));
      assert.deepEqual(sel, ['a', 'c']);
    });
  });

  // ---------- evaluate_js ----------
  describe('evaluate_js', () => {
    it('does not execute side effects twice when the expression throws at runtime', async () => {
      await open('blank');
      await evaluateJs(page, { expression: '(window.__n = (window.__n || 0) + 1, notDefinedVar)' }).catch(() => {});
      const n = await page.evaluate(() => window.__n);
      assert.equal(n, 1, `side effect ran ${n} times`);
    });

    it('rejects an out-of-range frameIdx instead of silently using the main frame', async () => {
      await open('blank');
      await assert.rejects(evaluateJs(page, { expression: '1+1', frameIdx: 42 }));
    });
  });

  // ---------- Manager / lifecycle ----------
  describe('BrowserManager lifecycle', () => {
    it('open with activate:false keeps the previously active tab', async () => {
      const first = await manager.tabsBatch([{ action: 'open', url: `${fx.base}/page/blank` }]);
      const firstId = first.results[0].tabId;
      let secondId;
      try {
        const second = await manager.tabsBatch([{ action: 'open', url: `${fx.base}/page/blank`, activate: false }]);
        secondId = second.results[0].tabId;
        assert.equal(second.activeTabId, firstId, `active switched to ${second.activeTabId}`);
      } finally {
        if (secondId) await manager.tabsBatch([{ action: 'close', tabId: secondId }]).catch(() => {});
        await manager.tabsBatch([{ action: 'close', tabId: firstId }, { action: 'activate', tabId: mainTabId }]).catch(() => {});
      }
    });

    it('dialogs (alert + confirm) inside a click do not deadlock and are logged (control)', async () => {
      await open('dialogs');
      await page.evaluate(() => {}); // ensure attached
      await manager.getDiagnostics(mainTabId, { clear: true });
      const res = await actFast(page, { action: 'click', selector: '#dlg' });
      assert.equal(res.ok, true);
      await page.waitForFunction(() => document.body.dataset.done === '1');
      const diag = await manager.getDiagnostics(mainTabId, {});
      assert.equal(diag.dialogs.length, 2);
    });

    it('page_diagnostics returns promptly while a download is stalled', async () => {
      const opened = await manager.tabsBatch([{ action: 'open', url: `${fx.base}/page/dl` }]);
      const tabId = opened.results[0].tabId;
      try {
        const { page: dlPage } = await manager.getPage(tabId);
        await dlPage.click('#dl');
        await dlPage.waitForTimeout(800);
        const winner = await Promise.race([
          manager.getDiagnostics(tabId, {}).then(() => 'diag'),
          new Promise((r) => setTimeout(() => r('timeout'), 5000)),
        ]);
        assert.equal(winner, 'diag', 'getDiagnostics blocked on an unfinished download (and would stall the whole stdio queue)');
      } finally {
        for (const r of fx.stalled) r.destroy();
        fx.stalled.clear();
        await Promise.race([
          manager.tabsBatch([{ action: 'close', tabId }, { action: 'activate', tabId: mainTabId }]).catch(() => {}),
          new Promise((r) => setTimeout(r, 5000)),
        ]);
      }
    });

    it('blockUrls accepts glob-style "*.png"', async () => {
      await manager.manageNetworkSession(mainTabId, { blockUrls: ['*.png'] });
      await open('img');
      const diag = await manager.getDiagnostics(mainTabId, { statusFilter: 'all', includeStatic: true, urlFilter: 'pix' });
      await manager.manageNetworkSession(mainTabId, { unblockAll: true });
      assert.ok(diag.requests.some((r) => r.ok === false), JSON.stringify(diag.requests));
    });

    describe('path confinement (TURBO_BROWSER_SAVE_ROOT)', () => {
      const prevRoot = process.env.TURBO_BROWSER_SAVE_ROOT;
      const stamp = `${process.pid}-${Date.now()}`;
      const outsideAbs = path.join(os.tmpdir(), `tbm-opus-escape-${stamp}.txt`);
      const parentRel = `../tbm-opus-escape-${stamp}.txt`;
      const insideDir = path.join(process.cwd(), `.tbm-opus-tmp-${stamp}`);
      const junction = path.join(insideDir, 'jn');

      before(() => {
        delete process.env.TURBO_BROWSER_SAVE_ROOT;
        fs.mkdirSync(insideDir, { recursive: true });
      });
      after(() => {
        if (prevRoot === undefined) delete process.env.TURBO_BROWSER_SAVE_ROOT;
        else process.env.TURBO_BROWSER_SAVE_ROOT = prevRoot;
        for (const p of [outsideAbs, path.resolve(process.cwd(), parentRel), path.join(os.tmpdir(), `tbm-opus-link-${stamp}.txt`)]) {
          if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        try { if (fs.existsSync(junction)) fs.unlinkSync(junction); } catch { /* ignore */ }
        fs.rmSync(insideDir, { recursive: true, force: true });
      });

      it('rejects absolute savePath outside cwd (extract_clean_text)', async () => {
        await open('blank');
        await assert.rejects(extractCleanText(page, { savePath: outsideAbs }));
        assert.equal(fs.existsSync(outsideAbs), false);
      });

      it('rejects ../ traversal savePath (evaluate_js)', async () => {
        await assert.rejects(evaluateJs(page, { expression: '"pwned"', savePath: parentRel }));
        assert.equal(fs.existsSync(path.resolve(process.cwd(), parentRel)), false);
      });

      it('rejects capture_page and page_diagnostics savePath outside cwd', async () => {
        await assert.rejects(capturePage(page, { savePath: outsideAbs }));
        await assert.rejects(manager.getDiagnostics(mainTabId, { savePath: outsideAbs }));
        assert.equal(fs.existsSync(outsideAbs), false);
      });

      it('rejects saveStorageStatePath and loadStorageStatePath outside cwd', async () => {
        await assert.rejects(manager.manageNetworkSession(mainTabId, { saveStorageStatePath: outsideAbs }));
        assert.equal(fs.existsSync(outsideAbs), false);
        fs.writeFileSync(outsideAbs, JSON.stringify({ cookies: [], origins: [] }));
        try {
          await assert.rejects(manager.manageNetworkSession(mainTabId, { loadStorageStatePath: outsideAbs }));
        } finally {
          fs.unlinkSync(outsideAbs);
        }
      });

      it('rejects a path escaping through a junction/symlink inside cwd', async (t) => {
        try {
          fs.symlinkSync(os.tmpdir(), junction, 'junction');
        } catch (err) {
          t.skip(`cannot create junction: ${err.message}`);
          return;
        }
        const viaLink = path.join(junction, `tbm-opus-link-${stamp}.txt`);
        await assert.rejects(extractCleanText(page, { savePath: viaLink }));
        assert.equal(fs.existsSync(path.join(os.tmpdir(), `tbm-opus-link-${stamp}.txt`)), false);
      });

      it('allows relative paths inside cwd (control)', async () => {
        const rel = path.relative(process.cwd(), path.join(insideDir, 'sub', 'ok.txt'));
        const res = await extractCleanText(page, { savePath: rel });
        assert.ok(fs.existsSync(path.join(insideDir, 'sub', 'ok.txt')));
        assert.ok(res.savePath);
      });

      it('allows an absolute path inside a TURBO_BROWSER_SAVE_ROOT allow-list entry (control)', async () => {
        process.env.TURBO_BROWSER_SAVE_ROOT = [process.cwd(), os.tmpdir()].join(path.delimiter);
        try {
          const res = await extractCleanText(page, { savePath: outsideAbs });
          assert.ok(fs.existsSync(outsideAbs), JSON.stringify(res));
        } finally {
          delete process.env.TURBO_BROWSER_SAVE_ROOT;
          if (fs.existsSync(outsideAbs)) fs.unlinkSync(outsideAbs);
        }
      });
    });
  });
});

// ---------- JSON-RPC / MCP protocol ----------
describe('opus-independent: JSON-RPC conformance', () => {
  const handle = createJsonRpcHandler({});

  it('initialize does not echo an unsupported protocolVersion', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    assert.notEqual(res.result.protocolVersion, '1999-01-01');
  });

  it('initialize keeps a supported protocolVersion (control)', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    assert.equal(res.result.protocolVersion, '2025-03-26');
  });

  it('request with id but no method returns -32600 Invalid Request', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 7 });
    assert.equal(res.error?.code, -32600);
  });

  it('unknown tool returns isError:true; notifications get no reply (control)', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope', arguments: {} } });
    assert.equal(res.result.isError, true);
    assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  });

  it('stdio: malformed JSON gets -32700 (id null), batch array gets a reply, server keeps serving', async () => {
    const child = spawn(process.execPath, [INDEX_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = [];
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (l) lines.push(JSON.parse(l));
      }
    });
    try {
      child.stdin.write('{oops not json\n');
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`);
      child.stdin.write(`${JSON.stringify([{ jsonrpc: '2.0', id: 11, method: 'ping' }])}\n`);
      await new Promise((r) => setTimeout(r, 2500));
      const flat = lines.flatMap((l) => (Array.isArray(l) ? l : [l]));
      assert.ok(flat.some((l) => l.id === 2 && l.result), `ping not answered: ${JSON.stringify(lines)}`);
      assert.ok(flat.some((l) => l.id === null && l.error?.code === -32700), `no parse error reply: ${JSON.stringify(lines)}`);
      assert.ok(flat.some((l) => l.id === 11 || (l.id === null && l.error?.code === -32600)), `batch silently dropped: ${JSON.stringify(lines)}`);
    } finally {
      child.kill();
    }
  });
});
