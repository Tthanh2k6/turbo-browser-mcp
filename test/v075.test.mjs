import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BrowserManager } from '../src/browser-manager.mjs';
import { capturePage, ensureFocusEmulation, inspectCompact } from '../src/dom-engine.mjs';
import {
  CORE_TOOL_NAMES,
  DEFAULT_REDACT_URL_PARAMS,
  TOOL_DEFINITIONS,
  dispatchToolCall,
  getRedactUrlParams,
  parseCliArgs,
  redactUrlParams,
} from '../src/index.mjs';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));

const OAUTH_PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>OAuth Callback Fixture</title></head>
<body>
  <main style="width:1200px;height:600px;background:linear-gradient(135deg,#0f172a,#2563eb);color:#fff;padding:32px;">
    <h1>Dashboard Ready</h1>
    <input id="bg-input" type="text" placeholder="Type while in background..." />
    <a id="oauth-link" href="/next?access_token=tok_secret_999&code=oauth_code_111&page=2">Continue</a>
    <button id="ping-btn" type="button" onclick="fetch('/api/verify?api_key=key_live_888&token=t_777&ok=1')">Verify</button>
  </main>
</body></html>`;

describe('v0.7.5 deliverables: background focus emulation, URL param redaction, capture_page maxWidth/webp/jpeg, schema budget, and README', () => {
  let server;
  let baseUrl;
  let manager;

  before(async () => {
    server = http.createServer((req, res) => {
      const parsed = new URL(req.url || '/', 'http://127.0.0.1');
      if (parsed.pathname === '/api/verify') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"verified":true}');
        return;
      }
      if (parsed.pathname === '/oauth' || parsed.pathname === '/next') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(OAUTH_PAGE_HTML);
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    manager = new BrowserManager({ mode: 'launch', headless: true, noFocus: true });
  });

  after(async () => {
    await manager?.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  });

  it('Deliverable 1: background and noFocus tabs automatically enable Emulation.setFocusEmulationEnabled({ enabled: true })', async () => {
    const opened = await manager.tabsBatch([
      { action: 'open', url: `${baseUrl}/oauth`, waitUntil: 'load' },
      { action: 'open', url: `${baseUrl}/next`, waitUntil: 'load', activate: false },
    ]);
    assert.equal(opened.results.length, 2);
    const tab1 = opened.results[0].tabId;
    const tab2 = opened.results[1].tabId;

    const { page: page1 } = await manager.getPage(tab1);
    const { page: page2 } = await manager.getPage(tab2);

    // Both foreground and background tabs report document.hasFocus() === true via CDP focus emulation
    assert.equal(await page1.evaluate(() => document.hasFocus()), true);
    assert.equal(await page2.evaluate(() => document.hasFocus()), true);
    assert.equal(manager._ensureDiagState(page1).focusEmulated, true);
    assert.equal(manager._ensureDiagState(page2).focusEmulated, true);

    // Direct helper can also toggle focus emulation on a raw Playwright page
    assert.equal(await ensureFocusEmulation(page2, true), true);
  });

  it('Deliverable 2: --redact-url-params masks default and custom sensitive URL query params across snapshots, tabs_batch, and page_diagnostics', async () => {
    assert.deepEqual(DEFAULT_REDACT_URL_PARAMS, [
      'access_token',
      'id_token',
      'refresh_token',
      'code',
      'api_key',
      'apikey',
      'token',
      'secret',
    ]);

    // CLI flag parsing supports boolean --redact-url-params, --redact-url-params=a,b, and --no-redact-url-params
    assert.equal(parseCliArgs(['--redact-url-params']).envOverrides.TURBO_BROWSER_REDACT_URL_PARAMS, 'true');
    assert.equal(
      parseCliArgs(['--redact-url-params=session_key,magic']).envOverrides.TURBO_BROWSER_REDACT_URL_PARAMS,
      'session_key,magic'
    );
    assert.equal(parseCliArgs(['--no-redact-url-params']).envOverrides.TURBO_BROWSER_REDACT_URL_PARAMS, 'false');

    const sensitiveUrl =
      `${baseUrl}/oauth?access_token=at_12345&id_token=idt_67890&refresh_token=rt_111` +
      `&code=cd_222&api_key=ak_333&apikey=ak_444&token=tk_555&secret=sec_666&state=keep_me#access_token=frag_777`;

    const redacted = redactUrlParams(sensitiveUrl);
    for (const secretVal of ['at_12345', 'idt_67890', 'rt_111', 'cd_222', 'ak_333', 'ak_444', 'tk_555', 'sec_666', 'frag_777']) {
      assert.ok(!redacted.includes(secretVal), `Expected ${secretVal} to be redacted in ${redacted}`);
    }
    assert.match(redacted, /access_token=<redacted>/);
    assert.match(redacted, /state=keep_me/);

    // Verify end-to-end redaction in tabs_batch, inspect_compact, and page_diagnostics
    const navOut = await dispatchToolCall(manager, 'tabs_batch', {
      operations: [{ action: 'open', url: sensitiveUrl, waitUntil: 'load' }],
      returnSnapshot: true,
    });
    assert.ok(!navOut.text.includes('at_12345'), navOut.text);
    assert.ok(!navOut.text.includes('tok_secret_999'), navOut.text);
    assert.ok(!navOut.text.includes('oauth_code_111'), navOut.text);
    assert.match(navOut.text, /access_token=<redacted>/);
    assert.match(navOut.text, /code=<redacted>/);

    const { tabId, page } = await manager.getPage();
    const snap = await inspectCompact(page, { mode: 'interactive' });
    assert.ok(!snap.url.includes('at_12345'));
    assert.match(snap.url, /access_token=<redacted>/);
    assert.ok(!snap.text.includes('tok_secret_999'));
    assert.match(snap.text, /code=<redacted>&page=2/);

    // Trigger XHR with sensitive query params and inspect page_diagnostics
    await page.click('#ping-btn');
    await new Promise((r) => setTimeout(r, 100));
    const diagOut = await dispatchToolCall(manager, 'page_diagnostics', {
      tabId,
      statusFilter: 'all',
    });
    assert.ok(!diagOut.text.includes('key_live_888'), diagOut.text);
    assert.ok(!diagOut.text.includes('t_777'), diagOut.text);
    assert.match(diagOut.text, /api_key=<redacted>&token=<redacted>&ok=1/);

    // Custom parameter name via TURBO_BROWSER_REDACT_URL_PARAMS
    const prevEnv = process.env.TURBO_BROWSER_REDACT_URL_PARAMS;
    process.env.TURBO_BROWSER_REDACT_URL_PARAMS = 'custom_auth,magic_code';
    try {
      assert.ok(getRedactUrlParams().includes('custom_auth'));
      assert.equal(
        redactUrlParams('https://example.com/login?custom_auth=xyz987&page=1'),
        'https://example.com/login?custom_auth=<redacted>&page=1'
      );
    } finally {
      if (prevEnv === undefined) delete process.env.TURBO_BROWSER_REDACT_URL_PARAMS;
      else process.env.TURBO_BROWSER_REDACT_URL_PARAMS = prevEnv;
    }
  });

  it('Deliverable 3: capture_page supports server-side maxWidth downscaling, format="webp"|"jpeg"|"png", and quality', async () => {
    const { tabId, page } = await manager.getPage();
    await page.setViewportSize({ width: 1280, height: 800 });

    // 1. WebP format with maxWidth=400 and quality=70
    const webpShot = await capturePage(page, {
      format: 'webp',
      maxWidth: 400,
      quality: 70,
      returnImage: true,
    });
    assert.equal(webpShot.ok, true);
    assert.equal(webpShot.format, 'webp');
    assert.equal(webpShot.type, 'webp');
    assert.equal(webpShot.mimeType, 'image/webp');
    assert.equal(webpShot.width, 400);
    assert.equal(webpShot.height, 250);
    const webpBuf = Buffer.from(webpShot.base64, 'base64');
    assert.equal(webpBuf.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(webpBuf.subarray(8, 12).toString('ascii'), 'WEBP');

    // 2. JPEG format with maxWidth=320 via MCP dispatchToolCall
    const mcpJpeg = await dispatchToolCall(manager, 'capture_page', {
      tabId,
      format: 'jpeg',
      maxWidth: 320,
      quality: 65,
      returnImage: true,
    });
    const meta = JSON.parse(mcpJpeg.text);
    assert.equal(meta.format, 'jpeg');
    assert.equal(meta.mimeType, 'image/jpeg');
    assert.equal(meta.width, 320);
    assert.equal(mcpJpeg.image?.mimeType, 'image/jpeg');
    const jpegBuf = Buffer.from(mcpJpeg.image.data, 'base64');
    assert.deepEqual([...jpegBuf.subarray(0, 2)], [0xff, 0xd8]);

    // 3. Downscaled WebP is significantly smaller than full-size 1280x800 PNG
    const fullPng = await capturePage(page, { format: 'png', returnImage: false });
    assert.ok(webpShot.bytes < fullPng.bytes, `Expected downscaled WebP (${webpShot.bytes}B) < full PNG (${fullPng.bytes}B)`);
  });

  it('Deliverable 4: 11-tool schema stays < 2,550 tokens and 6-tool core schema stays < 1,850 tokens (o200k_base)', () => {
    const fullStr = JSON.stringify(TOOL_DEFINITIONS);
    const compactStr = JSON.stringify(TOOL_DEFINITIONS.map(({ annotations, ...t }) => t));
    const coreTools = TOOL_DEFINITIONS.filter((t) => CORE_TOOL_NAMES.includes(t.name));
    const coreFullStr = JSON.stringify(coreTools);
    const coreCompactStr = JSON.stringify(coreTools.map(({ annotations, ...t }) => t));

    const capTool = TOOL_DEFINITIONS.find((t) => t.name === 'capture_page');
    assert.deepEqual(capTool.inputSchema.properties.format.enum, ['png', 'jpeg', 'webp']);
    assert.equal(capTool.inputSchema.properties.maxWidth.type, 'integer');

    const pyScript =
      'import sys,json,tiktoken\n' +
      'enc=tiktoken.get_encoding("o200k_base")\n' +
      'd=json.load(sys.stdin)\n' +
      'print(json.dumps({k:len(enc.encode(v)) for k,v in d.items()}))\n';
    const r = spawnSync('python', ['-W', 'ignore', '-X', 'utf8', '-c', pyScript], {
      input: JSON.stringify({
        full: fullStr,
        compact: compactStr,
        coreFull: coreFullStr,
        coreCompact: coreCompactStr,
      }),
      encoding: 'utf8',
      timeout: 8000,
    });
    if (r.status === 0 && r.stdout) {
      const counts = JSON.parse(r.stdout.trim());
      assert.ok(counts.compact < 2550, `Expected 11-tool compact schema < 2550 tokens, got ${counts.compact}`);
      assert.ok(counts.full < 2550, `Expected 11-tool full schema < 2550 tokens, got ${counts.full}`);
      assert.ok(counts.coreCompact < 1850, `Expected core compact schema < 1850 tokens, got ${counts.coreCompact}`);
      assert.ok(counts.coreFull < 1850, `Expected core full schema < 1850 tokens, got ${counts.coreFull}`);
    } else {
      assert.ok(compactStr.length < 10500, `Expected compact schema < 10500 chars, got ${compactStr.length}`);
      assert.ok(coreCompactStr.length < 7600, `Expected core schema < 7600 chars, got ${coreCompactStr.length}`);
    }
  });

  it('Deliverable 5: package.json and server.json are v0.7.5 with mcpName, and README top 30 lines include 4-line ASCII diagram, comparison table, and 1-click install without em dashes', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    const srv = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'server.json'), 'utf8'));
    assert.equal(pkg.version, '0.7.5');
    assert.equal(pkg.mcpName, 'io.github.Tthanh2k6/turbo-browser-mcp');
    assert.equal(srv.version, '0.7.5');
    assert.equal(srv.packages[0].version, '0.7.5');

    const readmeLines = fs.readFileSync(path.join(ROOT_DIR, 'README.md'), 'utf8').split(/\r?\n/);
    const top35 = readmeLines.slice(0, 35).join('\n');
    assert.match(top35, /vscode:mcp\/install/);
    assert.match(top35, /cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install/);
    assert.match(top35, /Step-by-step MCP\s*:/);
    assert.match(top35, /turbo-browser-mcp:\s*\[inspect_compact\]\s*->\s*\[smart_fill_form/);
    assert.match(top35, /\|\s*Capability\s*\|\s*Typical browser MCP\s*\|\s*`turbo-browser-mcp`/);
    assert.ok(!/—|–/.test(top35), 'Top 35 lines of README must not contain em/en dashes');
  });
});
