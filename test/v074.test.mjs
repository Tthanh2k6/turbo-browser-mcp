import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { takeLate } from '../src/aftermath.mjs';
import { BrowserManager } from '../src/browser-manager.mjs';
import { actFast, batchActions, extractCleanText, smartFillForm } from '../src/dom-engine.mjs';
import { CORE_TOOL_NAMES, TOOL_DEFINITIONS, dispatchToolCall } from '../src/index.mjs';
import { probeCdpPendingApproval } from '../src/playwright-loader.mjs';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));

const PORTALED_COMBOBOXES_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Portaled Comboboxes Fixture</title></head>
<body>
  <main>
    <form id="combo-form" onsubmit="event.preventDefault()">
      <!-- 1. Radix UI / shadcn Popover + cmdk style (no aria-controls on trigger, portal at body end, [cmdk-input] + [cmdk-item]) -->
      <div class="form-row">
        <label>Cloud Region</label>
        <input type="hidden" id="radix-val" name="radixRegion" />
        <button id="radix-trigger" type="button" role="combobox" aria-expanded="false">Select region...</button>
      </div>

      <!-- 2. MUI Autocomplete style (<input role="combobox"> filtering portaled <ul role="listbox"><li role="option"> of 200 items) -->
      <div class="MuiAutocomplete-root">
        <label for="mui-input">MUI City</label>
        <input id="mui-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" />
        <input type="hidden" id="mui-val" />
      </div>

      <!-- 3. Headless UI Combobox style (wrapper with <input role="combobox"> + chevron button, opens portal on typing) -->
      <div class="headless-group">
        <label>Assignee</label>
        <div class="headless-combo">
          <input id="hui-input" type="text" role="combobox" data-headlessui-state="" aria-expanded="false" />
          <button id="hui-btn" type="button" tabindex="-1" aria-haspopup="listbox">v</button>
        </div>
        <input type="hidden" id="hui-val" />
      </div>

      <!-- 4. react-select style (placeholder covers 1px input#react-select-2-input, portaled menu with .react-select__option) -->
      <div class="rs-field">
        <label>Framework</label>
        <div id="rs-control" class="react-select__control" style="position:relative;width:220px;height:36px;border:1px solid #888;">
          <div class="react-select__value-container" style="position:relative;width:100%;height:100%;">
            <div id="rs-placeholder" class="react-select__placeholder" style="position:absolute;inset:0;background:#fff;z-index:2;">Select framework...</div>
            <input id="react-select-2-input" role="combobox" aria-autocomplete="list" aria-expanded="false"
              style="width:1px;height:1px;opacity:0;border:0;padding:0;" />
          </div>
        </div>
        <input type="hidden" id="rs-val" />
      </div>

      <!-- 5. Virtualized scrollable listbox (200 options, renders 20 options based on scrollTop, no search input) -->
      <div class="virt-field">
        <label>Time Zone</label>
        <button id="virt-trigger" type="button" aria-haspopup="listbox" aria-expanded="false">Choose zone</button>
        <input type="hidden" id="virt-val" />
      </div>
    </form>
  </main>
  <script>
    // 1. Radix / cmdk portal
    const radixTrigger = document.getElementById('radix-trigger');
    radixTrigger.addEventListener('click', () => {
      if (document.getElementById('radix-portal')) return;
      radixTrigger.setAttribute('aria-expanded', 'true');
      const portal = document.createElement('div');
      portal.id = 'radix-portal';
      portal.setAttribute('data-radix-popper-content-wrapper', '');
      portal.innerHTML = \`
        <div role="dialog" cmdk-root="">
          <input cmdk-input="" type="text" placeholder="Search region..." />
          <div cmdk-list="" role="listbox"></div>
        </div>\`;
      document.body.appendChild(portal);
      const inp = portal.querySelector('[cmdk-input]');
      const list = portal.querySelector('[cmdk-list]');
      const all = Array.from({ length: 200 }, (_, i) => 'Region ' + (i + 1));
      const render = (q) => {
        const matches = all.filter((x) => x.toLowerCase().includes((q || '').toLowerCase())).slice(0, 15);
        list.replaceChildren(...matches.map((m) => {
          const item = document.createElement('div');
          item.setAttribute('cmdk-item', '');
          item.setAttribute('data-value', m);
          item.textContent = m;
          item.onclick = () => {
            document.getElementById('radix-val').value = m;
            radixTrigger.textContent = m;
            radixTrigger.setAttribute('aria-expanded', 'false');
            portal.remove();
          };
          return item;
        }));
      };
      inp.addEventListener('input', () => render(inp.value));
      render('');
    });

    // 2. MUI Autocomplete portal
    const muiInput = document.getElementById('mui-input');
    const muiCities = Array.from({ length: 200 }, (_, i) => 'City ' + (i + 1));
    function renderMuiPortal(filterText) {
      let popper = document.getElementById('mui-popper');
      if (!popper) {
        popper = document.createElement('div');
        popper.id = 'mui-popper';
        popper.className = 'MuiAutocomplete-popper';
        popper.innerHTML = '<ul role="listbox" id="mui-listbox"></ul>';
        document.body.appendChild(popper);
      }
      muiInput.setAttribute('aria-expanded', 'true');
      const ul = popper.querySelector('ul');
      const matches = muiCities.filter((c) => c.toLowerCase().includes((filterText || '').toLowerCase())).slice(0, 20);
      ul.replaceChildren(...matches.map((c) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.textContent = c;
        li.onclick = () => {
          muiInput.value = c;
          document.getElementById('mui-val').value = c;
          muiInput.setAttribute('aria-expanded', 'false');
          popper.remove();
        };
        return li;
      }));
    }
    muiInput.addEventListener('click', () => renderMuiPortal(muiInput.value));
    muiInput.addEventListener('input', () => renderMuiPortal(muiInput.value));

    // 3. Headless UI Combobox (only opens portal when typed into or chevron button clicked)
    const huiInput = document.getElementById('hui-input');
    const huiBtn = document.getElementById('hui-btn');
    const assignees = Array.from({ length: 180 }, (_, i) => 'Engineer ' + (i + 1));
    function renderHuiPortal(q) {
      let portal = document.getElementById('hui-portal');
      if (!portal) {
        portal = document.createElement('div');
        portal.id = 'hui-portal';
        portal.setAttribute('data-headlessui-state', 'open');
        portal.innerHTML = '<ul role="listbox"></ul>';
        document.body.appendChild(portal);
      }
      huiInput.setAttribute('aria-expanded', 'true');
      const ul = portal.querySelector('ul');
      const matches = assignees.filter((a) => a.toLowerCase().includes((q || '').toLowerCase())).slice(0, 15);
      ul.replaceChildren(...matches.map((a) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.textContent = a;
        li.onclick = () => {
          huiInput.value = a;
          document.getElementById('hui-val').value = a;
          huiInput.setAttribute('aria-expanded', 'false');
          portal.remove();
        };
        return li;
      }));
    }
    huiBtn.addEventListener('click', () => renderHuiPortal(huiInput.value));
    huiInput.addEventListener('input', () => renderHuiPortal(huiInput.value));

    // 4. react-select portal
    const rsControl = document.getElementById('rs-control');
    const rsInput = document.getElementById('react-select-2-input');
    const frameworks = ['React', 'Vue', 'Angular', 'Solid', 'Qwik', 'Astro', 'SvelteKit', 'Next.js', 'Nuxt', 'Remix'];
    function openRsMenu(q) {
      let menu = document.getElementById('rs-menu-portal');
      if (!menu) {
        menu = document.createElement('div');
        menu.id = 'rs-menu-portal';
        menu.className = 'react-select__menu-portal';
        menu.innerHTML = '<div class="react-select__menu-list" role="listbox"></div>';
        document.body.appendChild(menu);
      }
      rsInput.setAttribute('aria-expanded', 'true');
      const list = menu.querySelector('.react-select__menu-list');
      const matches = frameworks.filter((f) => f.toLowerCase().includes((q || '').toLowerCase()));
      list.replaceChildren(...matches.map((f) => {
        const opt = document.createElement('div');
        opt.className = 'react-select__option';
        opt.textContent = f;
        opt.onclick = () => {
          document.getElementById('rs-val').value = f;
          document.getElementById('rs-placeholder').textContent = f;
          rsInput.setAttribute('aria-expanded', 'false');
          menu.remove();
        };
        return opt;
      }));
    }
    rsControl.addEventListener('click', () => {
      rsInput.style.opacity = '1';
      rsInput.style.width = '80px';
      rsInput.style.height = '24px';
      rsInput.focus();
      openRsMenu(rsInput.value);
    });
    rsInput.addEventListener('input', () => openRsMenu(rsInput.value));

    // 5. Virtualized scrollable listbox (200 zones, 10 visible per scroll window)
    const virtTrigger = document.getElementById('virt-trigger');
    const zones = Array.from({ length: 200 }, (_, i) => 'UTC+' + (i + 1));
    virtTrigger.addEventListener('click', () => {
      if (document.getElementById('virt-listbox')) return;
      virtTrigger.setAttribute('aria-expanded', 'true');
      const lb = document.createElement('div');
      lb.id = 'virt-listbox';
      lb.setAttribute('role', 'listbox');
      lb.style.cssText = 'height:160px;overflow-y:auto;border:1px solid #333;position:relative;';
      const spacer = document.createElement('div');
      spacer.style.height = (zones.length * 24) + 'px';
      const viewport = document.createElement('div');
      lb.appendChild(spacer);
      lb.appendChild(viewport);
      document.body.appendChild(lb);
      const renderVirt = () => {
        const startIdx = Math.min(zones.length - 10, Math.max(0, Math.floor(lb.scrollTop / 24)));
        viewport.style.cssText = 'position:absolute;left:0;right:0;top:' + (startIdx * 24) + 'px;';
        viewport.replaceChildren(...zones.slice(startIdx, startIdx + 15).map((z) => {
          const item = document.createElement('div');
          item.setAttribute('role', 'option');
          item.style.height = '24px';
          item.textContent = z;
          item.onclick = () => {
            document.getElementById('virt-val').value = z;
            virtTrigger.textContent = z;
            virtTrigger.setAttribute('aria-expanded', 'false');
            lb.remove();
          };
          return item;
        }));
      };
      lb.addEventListener('scroll', renderVirt);
      renderVirt();
    });
  </script>
</body></html>`;

const DEVTO_REPLY_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Dev.to Comment Thread</title></head>
<body>
  <main>
    <article class="comment">
      <p>Great post on MCP token savings!</p>
      <button id="reply-btn" type="button" onclick="
        fetch('/comments/reply_form', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ comment_id: 101 }) });
        document.getElementById('reply-box').hidden = false;
      ">Reply</button>
      <button id="edit-btn" type="button" onclick="
        fetch('/comments/edit_form', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ comment_id: 101 }) });
      ">Edit</button>
      <div id="reply-box" hidden>
        <textarea id="reply-text" aria-label="Reply text">Thanks!</textarea>
        <button id="real-post-btn" type="button" onclick="
          fetch('/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'Thanks!' }) });
        ">Submit comment</button>
        <button id="custom-send-btn" type="button" onclick="
          fetch('/comments/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'Thanks!' }) });
        ">Save response</button>
      </div>
    </article>
  </main>
</body></html>`;

function buildCatalogPageHtml(pageNum, mode = 'next-btn') {
  const allRows = Array.from({ length: 12 }, (_, i) => ({
    id: `A${String(i + 1).padStart(3, '0')}`,
    name: `Adapter ${i + 1}`,
    price: Number((9.5 + i * 1.25).toFixed(2)),
  }));
  const totalPages = 3;
  const page = Math.min(totalPages, Math.max(1, pageNum));
  const slice = allRows.slice((page - 1) * 4, page * 4);
  const trs = slice
    .map((r) => `<tr class="cat-row"><td>${r.id}</td><td>${r.name}</td><td>${r.price.toFixed(2)}</td></tr>`)
    .join('');
  let navHtml = '';
  if (mode === 'next-btn') {
    const isLast = page >= totalPages;
    navHtml = `<nav><a id="next-link" href="/catalog-next?page=${page + 1}" ${isLast ? 'aria-disabled="true" class="disabled" onclick="event.preventDefault()"' : ''}>Next</a></nav>`;
  } else if (mode === 'numbered') {
    navHtml = `<nav>${Array.from({ length: totalPages }, (_, i) => `<a href="/catalog-numbered?page=${i + 1}">Page ${i + 1}</a>`).join(' ')}</nav>`;
  }
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Catalog Page ${page}</title></head>
<body>
  <main>
    <h1>Hardware Catalog</h1>
    <p>12 results. Page ${page} of ${totalPages}</p>
    <table id="catalog-table">
      <thead><tr><th>id</th><th>name</th><th>price</th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
    ${navHtml}
  </main>
</body></html>`;
}

describe('v0.7.4 deliverables: schema budget, portaled comboboxes, collect pagination, table_json, and Part C fixes', () => {
  let server;
  let baseUrl;
  let manager;

  before(async () => {
    server = http.createServer((req, res) => {
      const parsed = new URL(req.url || '/', 'http://127.0.0.1');
      const u = parsed.pathname;
      if (req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      if (u === '/comboboxes') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PORTALED_COMBOBOXES_HTML);
        return;
      }
      if (u === '/devto-reply') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(DEVTO_REPLY_HTML);
        return;
      }
      if (u === '/catalog-next') {
        const p = Number(parsed.searchParams.get('page')) || 1;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(buildCatalogPageHtml(p, 'next-btn'));
        return;
      }
      if (u === '/catalog-numbered') {
        const p = Number(parsed.searchParams.get('page')) || 1;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(buildCatalogPageHtml(p, 'numbered'));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    manager = new BrowserManager({ mode: 'launch', headless: true });
  });

  after(async () => {
    await manager?.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  });

  async function open(route) {
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}${route}`, waitUntil: 'load' }]);
    return (await manager.getPage()).page;
  }

  it('Deliverable 1: 11-tool schema is < 2,550 tokens and 6-tool core schema is < 1,850 tokens (tiktoken o200k_base) while keeping critical usage cues', () => {
    const fullStr = JSON.stringify(TOOL_DEFINITIONS);
    const compactStr = JSON.stringify(TOOL_DEFINITIONS.map(({ annotations, ...t }) => t));
    const coreTools = TOOL_DEFINITIONS.filter((t) => CORE_TOOL_NAMES.includes(t.name));
    const coreFullStr = JSON.stringify(coreTools);
    const coreCompactStr = JSON.stringify(coreTools.map(({ annotations, ...t }) => t));

    // Verify critical usage cues remain intact
    const tabsBatch = TOOL_DEFINITIONS.find((t) => t.name === 'tabs_batch');
    assert.match(tabsBatch.description, /returnSnapshot/i);
    const smartFill = TOOL_DEFINITIONS.find((t) => t.name === 'smart_fill_form');
    const optionDesc = smartFill.inputSchema.properties.fields.items.properties.option.description;
    assert.match(optionDesc, /<select>/i);
    assert.match(optionDesc, /role=combobox/i);
    const actFastTool = TOOL_DEFINITIONS.find((t) => t.name === 'act_fast');
    assert.match(actFastTool.description, /allowSubmit/i);
    const batchTool = TOOL_DEFINITIONS.find((t) => t.name === 'batch_actions');
    assert.match(batchTool.inputSchema.properties.steps.description, /nextText/);
    assert.match(batchTool.inputSchema.properties.steps.description, /maxPages/);
    const extractTool = TOOL_DEFINITIONS.find((t) => t.name === 'extract_clean_text');
    assert.ok(extractTool.inputSchema.properties.format.enum.includes('table_json'));

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
      // Fallback character budget check if Python/tiktoken is unavailable in minimal environment
      assert.ok(compactStr.length < 9500, `Expected compact schema < 9500 chars, got ${compactStr.length}`);
      assert.ok(coreCompactStr.length < 6800, `Expected core schema < 6800 chars, got ${coreCompactStr.length}`);
    }
  });

  it('Deliverable 2: smart_fill_form fills Radix/cmdk, MUI Autocomplete, Headless UI, react-select, and virtualized 200-option portaled comboboxes in one call', async () => {
    const page = await open('/comboboxes');

    const res = await smartFillForm(page, {
      fields: [
        { keys: ['Cloud Region'], option: 'Region 175' },
        { keys: ['MUI City'], option: 'City 142' },
        { keys: ['Assignee'], option: 'Engineer 165' },
        { keys: ['Framework'], option: 'SvelteKit' },
        { keys: ['Time Zone'], option: 'UTC+135' },
      ],
    });

    assert.equal(res.filledCount, 5, JSON.stringify(res));
    const committed = await page.evaluate(() => ({
      radix: document.getElementById('radix-val').value,
      mui: document.getElementById('mui-val').value,
      hui: document.getElementById('hui-val').value,
      rs: document.getElementById('rs-val').value,
      virt: document.getElementById('virt-val').value,
    }));
    assert.deepEqual(committed, {
      radix: 'Region 175',
      mui: 'City 142',
      hui: 'Engineer 165',
      rs: 'SvelteKit',
      virt: 'UTC+135',
    });
  });

  it('Deliverable 3a: batch_actions collect paginates via nextText / nextSelector + maxPages and stops when Next is disabled', async () => {
    const page = await open('/catalog-next?page=1');

    // 1. Paginate across all 3 pages using nextText: "Next" (stops when Next becomes aria-disabled="true" on page 3)
    const allPagesRes = await batchActions(page, [
      {
        action: 'collect',
        selector: 'tr.cat-row',
        nextText: 'Next',
        maxPages: 10,
      },
    ]);
    assert.equal(allPagesRes.completed, 1, JSON.stringify(allPagesRes));
    const step0 = allPagesRes.results[0];
    assert.equal(step0.ok, true);
    assert.equal(step0.pages, 3);
    assert.equal(step0.count, 12);
    assert.match(step0.items[0], /A001/);
    assert.match(step0.items[11], /A012/);

    // 2. Respect maxPages cap with nextSelector
    const page2 = await open('/catalog-next?page=1');
    const cappedRes = await batchActions(page2, [
      {
        action: 'collect',
        selector: 'tr.cat-row',
        nextSelector: '#next-link',
        maxPages: 2,
      },
    ]);
    assert.equal(cappedRes.results[0].pages, 2);
    assert.equal(cappedRes.results[0].count, 8);

    // 3. Paginate numbered links ("Page 2", "Page 3") with format: "table_json"
    const page3 = await open('/catalog-numbered?page=1');
    const tableCollectRes = await batchActions(page3, [
      {
        action: 'collect',
        selector: '#catalog-table',
        format: 'table_json',
        nextText: 'Next',
        maxPages: 10,
      },
    ]);
    const tStep = tableCollectRes.results[0];
    assert.equal(tStep.ok, true);
    assert.equal(tStep.pages, 3);
    assert.equal(tStep.count, 12);
    assert.deepEqual(tStep.items[0], { id: 'A001', name: 'Adapter 1', price: 9.5 });
    assert.deepEqual(tStep.items[11], { id: 'A012', name: 'Adapter 12', price: 23.25 });
  });

  it('Deliverable 3b: extract_clean_text with format="table_json" returns clean JSON array of row objects', async () => {
    const page = await open('/catalog-next?page=1');

    const res = await extractCleanText(page, { format: 'table_json', selector: '#catalog-table' });
    assert.equal(res.format, 'table_json');
    assert.equal(res.truncated, false);
    assert.equal(res.rowCount, 4);
    const parsed = JSON.parse(res.text);
    assert.deepEqual(parsed, [
      { id: 'A001', name: 'Adapter 1', price: 9.5 },
      { id: 'A002', name: 'Adapter 2', price: 10.75 },
      { id: 'A003', name: 'Adapter 3', price: 12 },
      { id: 'A004', name: 'Adapter 4', price: 13.25 },
    ]);

    // Also verify via MCP dispatchToolCall
    const mcpOut = await dispatchToolCall(manager, 'extract_clean_text', { format: 'table_json' });
    const lines = mcpOut.text.trim().split('\n');
    assert.deepEqual(JSON.parse(lines[lines.length - 1]), parsed);
  });

  it('Deliverable 4a: .gitattributes exists at repo root and enforces * text=auto eol=lf', () => {
    const gitattributesPath = path.join(ROOT_DIR, '.gitattributes');
    assert.ok(fs.existsSync(gitattributesPath), '.gitattributes exists');
    const content = fs.readFileSync(gitattributesPath, 'utf8');
    assert.match(content, /^\*\s+text=auto\s+eol=lf/m);
  });

  it('Deliverable 4b: act_fast suppresses false possibleSubmit on Reply/Edit editor-open buttons while keeping it on real POST buttons', async () => {
    const page = await open('/devto-reply');

    const replyRes = await actFast(page, { action: 'click', selector: '#reply-btn' });
    assert.equal(replyRes.ok, true);
    assert.equal(replyRes.possibleSubmit, undefined, JSON.stringify(replyRes));
    assert.equal(takeLate(page), '');

    const editRes = await actFast(page, { action: 'click', selector: '#edit-btn' });
    assert.equal(editRes.ok, true);
    assert.equal(editRes.possibleSubmit, undefined, JSON.stringify(editRes));
    assert.equal(takeLate(page), '');

    // Clicking a non-blocked button that sends a real comment mutation POST still reports possibleSubmit: true
    const sendRes = await actFast(page, { action: 'click', selector: '#custom-send-btn' });
    assert.equal(sendRes.ok, true);
    assert.equal(sendRes.possibleSubmit, true, JSON.stringify(sendRes));
  });

  it('Deliverable 4c: early cdpPendingApproval signal fires when Chrome 136+ hangs on Allow remote debugging', async () => {
    const hangServer = net.createServer((socket) => {
      socket.on('error', () => {});
    });
    await new Promise((resolve) => hangServer.listen(0, '127.0.0.1', resolve));
    const hangPort = hangServer.address().port;
    const wsEndpoint = `ws://127.0.0.1:${hangPort}/devtools/browser/fake-pending-guid`;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-v074-cdp-'));
    fs.writeFileSync(path.join(tmpDir, 'DevToolsActivePort'), `${hangPort}\n/devtools/browser/fake-pending-guid\n`);

    const prevBridge = process.env.TURBO_BROWSER_DISABLE_BRIDGE;
    process.env.TURBO_BROWSER_DISABLE_BRIDGE = 'true';

    let earlySignal = null;
    const pendingManager = new BrowserManager({
      mode: 'auto',
      headless: true,
      cdpUrl: 'http://127.0.0.1:1',
      userDataDir: tmpDir,
      cdpAutoTimeoutMs: 700,
      cdpPendingHintMs: 150,
      onCdpPendingApproval: (info) => {
        earlySignal = info;
      },
    });

    try {
      // 1. Direct probe detects hanging ws:// upgrade as pending approval
      const probed = await probeCdpPendingApproval(wsEndpoint, 200);
      assert.equal(probed, true, 'probeCdpPendingApproval should return true when ws upgrade hangs');

      // 2. BrowserManager fires early signal and attaches cdpPendingApproval: true on fallback
      const out = await dispatchToolCall(pendingManager, 'tabs_batch', {
        operations: [{ action: 'list' }],
      });
      const parsed = JSON.parse(out.text);
      assert.ok(earlySignal, 'onCdpPendingApproval callback should fire early before timeout expires');
      assert.equal(pendingManager.cdpPendingApproval, true);
      assert.equal(parsed.cdpPendingApproval, true);
      assert.equal(parsed.degraded, 'headless-fallback');
    } finally {
      if (prevBridge === undefined) delete process.env.TURBO_BROWSER_DISABLE_BRIDGE;
      else process.env.TURBO_BROWSER_DISABLE_BRIDGE = prevBridge;
      await pendingManager.close().catch(() => {});
      hangServer.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
