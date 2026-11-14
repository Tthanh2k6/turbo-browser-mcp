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
  inspectCompact,
  smartFillForm,
} from '../src/dom-engine.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRY_PATH = path.resolve(TEST_DIR, '..', 'src', 'index.mjs');

const MAIN_HTML = `<!doctype html>
<html>
<head><title>Job Application Fixture</title></head>
<body>
  <h1>Senior Full-Stack Application</h1>
  <form id="app-form" onsubmit="event.preventDefault(); window.__submitted = (window.__submitted || 0) + 1;">
    <div class="field">
      <label for="full-name">Full Name</label>
      <input id="full-name" name="fullName" type="text" required />
    </div>
    <div class="field">
      <label for="email">Email Address</label>
      <input id="email" name="email" type="email" />
    </div>
    <div class="field">
      <label>Cover Note</label>
      <div id="cover-editor" contenteditable="true" role="textbox" aria-label="Cover Note" style="min-height:90px;width:320px;border:1px solid #999;"></div>
    </div>
    <div class="field">
      <label for="country">Country</label>
      <select id="country" name="country">
        <option value="">-- Select --</option>
        <option value="vn">Vietnam</option>
        <option value="us">United States</option>
      </select>
    </div>
    <div class="field">
      <label id="workmode-lbl">Work Mode</label>
      <div id="workmode-combo" role="combobox" aria-labelledby="workmode-lbl" aria-expanded="false" tabindex="0" style="width:200px;height:28px;border:1px solid #888;">Choose...</div>
      <div id="workmode-list" role="listbox" style="display:none;">
        <div role="option" data-val="remote">Remote Full-Time</div>
        <div role="option" data-val="hybrid">Hybrid</div>
      </div>
    </div>
    <div role="listitem" class="question">
      <div>Can you start immediately?</div>
      <label><input type="radio" name="startNow" value="yes"> Yes, immediately</label>
      <label><input type="radio" name="startNow" value="no"> Next month</label>
    </div>
    <div role="listitem" class="question">
      <div>Primary tech stack (select all that apply)</div>
      <label><input type="checkbox" name="stack" value="react"> React</label>
      <label><input type="checkbox" name="stack" value="node"> Node.js</label>
      <label><input type="checkbox" name="stack" value="go"> Go</label>
    </div>
    <div class="field">
      <label for="resume-file">Resume / CV PDF</label>
      <input id="resume-file" name="resume" type="file" accept=".pdf" style="display:none" />
      <span id="resume-name"></span>
    </div>
    <iframe id="extra-frame" src="/iframe-form" style="width:400px;height:140px;border:1px solid #ccc;"></iframe>
    <div>
      <button id="next-btn" type="button" onclick="window.__nextClicked = (window.__nextClicked || 0) + 1;">Next Step</button>
      <button id="submit-btn" type="submit">Submit Application</button>
      <button id="post-btn" type="button" onclick="window.__vnPosted = true;">Đăng bài</button>
    </div>
  </form>
  <script>
    window.__reactTracked = '';
    window.__submitted = 0;
    window.__nextClicked = 0;
    window.__vnPosted = false;

    // Simulate React controlled input by rejecting direct instance .value assignments
    // while tracking prototype-setter + input events.
    const nameEl = document.getElementById('full-name');
    const nativeDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    Object.defineProperty(nameEl, 'value', {
      configurable: true,
      get() { return nativeDesc.get.call(this); },
      set() { /* Ignored like React if caller does el.value = x instead of prototype setter */ }
    });
    nameEl.addEventListener('input', () => {
      window.__reactTracked = nativeDesc.get.call(nameEl);
    });

    document.getElementById('resume-file').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      document.getElementById('resume-name').textContent = f ? f.name + ':' + f.size : '';
    });

    const combo = document.getElementById('workmode-combo');
    const list = document.getElementById('workmode-list');
    combo.addEventListener('click', () => {
      list.style.display = list.style.display === 'none' ? 'block' : 'none';
    });
    list.querySelectorAll('[role="option"]').forEach((opt) => {
      opt.addEventListener('click', () => {
        window.__workMode = opt.getAttribute('data-val');
        combo.textContent = opt.textContent;
        list.style.display = 'none';
      });
    });
  </script>
</body>
</html>`;

const IFRAME_HTML = `<!doctype html>
<html>
<body>
  <div class="field">
    <label for="emergency">Emergency Contact</label>
    <input id="emergency" name="emergencyContact" type="text" />
  </div>
  <button id="iframe-save" type="button" onclick="window.__iframeSaved = true;">Save Draft</button>
</body>
</html>`;

const GMAIL_HTML = `<!doctype html>
<html>
<body>
  <div role="dialog" style="width:500px;height:400px;border:1px solid #333;">
    <input aria-label="To recipients" type="text" />
    <input name="subjectbox" placeholder="Subject" type="text" />
    <div aria-label="Message Body" role="textbox" contenteditable="true" style="height:120px;border:1px solid #aaa;"></div>
    <button type="button" onclick="window.__mailSent = true;">Send</button>
  </div>
</body>
</html>`;

function buildLargePageHtml() {
  const buttons = Array.from({ length: 140 }, (_, i) =>
    `<button type="button" data-idx="${i}">Action Item Number ${i} Extra Label Text Here</button>`
  ).join('\n');
  return `<!doctype html>
<html>
<head><title>Dense Page</title><style>.hidden{display:none}</style></head>
<body>
  <main>
    <h1>Performance Benchmark Article</h1>
    <p>This clean paragraph explains why compact inspection stays below strict token budgets.</p>
    <p>Second meaningful paragraph inside main.</p>
    <div>${buttons}</div>
  </main>
  <script>window.__ignoredNoise = "SHOULD_NOT_APPEAR";</script>
</body>
</html>`;
}

const DIAG_HTML = `<!doctype html>
<html>
<body>
  <h1>Diagnostics Test</h1>
  <button id="alert-btn" type="button" onclick="alert('Blocking Alert Text')">Trigger Alert</button>
  <script>
    console.error('Boom console error 123');
    console.warn('Warn message 456');
    fetch('/missing-404-endpoint').catch(() => {});
  </script>
</body>
</html>`;

const SHADOW_INTERACTION_HTML = `<!doctype html>
<html>
<head>
  <title>Shadow DOM, Drag, Delta & Session Fixture</title>
  <style>
    body { background: #ffffff; color: #111111; }
    @media (prefers-color-scheme: dark) {
      body { background: #101010; color: #f5f5f5; }
    }
  </style>
</head>
<body>
  <h1 id="page-title">v0.2 Interactive Fixture</h1>
  <div id="spinner">Loading spinner...</div>
  <shadow-card></shadow-card>
  <button id="reveal-btn" type="button" onclick="addDynamicInput()">Reveal Dynamic Field</button>
  <div id="dynamic-host"></div>
  <div id="drag-src" draggable="true" style="width:80px;height:40px;background:#ccc;">Drag Me</div>
  <div id="drag-dst" style="width:120px;height:60px;border:2px dashed #333;margin-top:8px;">Drop Here</div>
  <button id="prompt-btn" type="button" onclick="window.__promptVal = prompt('Enter code:'); console.log('Prompt answered:', window.__promptVal);">Ask Prompt</button>
  <button id="api-btn" type="button" onclick="fetch('/api/echo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ping: 42 }) }).then(r => r.json()).then(d => { window.__apiResp = d; });">Call API</button>
  <script>
    setTimeout(() => {
      const sp = document.getElementById('spinner');
      if (sp) sp.style.display = 'none';
    }, 120);

    class ShadowCard extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = \`
          <div class="field">
            <input id="shadow-secret" aria-label="Shadow Secret" type="text" />
            <button id="shadow-btn" type="button">Shadow Action</button>
          </div>
        \`;
        root.getElementById('shadow-btn').addEventListener('click', () => {
          window.__shadowClicked = true;
        });
      }
    }
    customElements.define('shadow-card', ShadowCard);

    function addDynamicInput() {
      if (document.getElementById('dyn-input')) return;
      const inp = document.createElement('input');
      inp.id = 'dyn-input';
      inp.setAttribute('aria-label', 'Newly Revealed Field');
      document.getElementById('dynamic-host').appendChild(inp);
    }

    const src = document.getElementById('drag-src');
    const dst = document.getElementById('drag-dst');
    src.addEventListener('dragstart', (e) => e.dataTransfer?.setData('text/plain', 'dragged'));
    dst.addEventListener('dragover', (e) => e.preventDefault());
    dst.addEventListener('drop', (e) => {
      e.preventDefault();
      window.__dropped = true;
      dst.textContent = 'Dropped OK';
    });
  </script>
</body>
</html>`;

const V3_HTML = `<!doctype html>
<html>
<head>
  <title>v0.3 Parity Fixture</title>
  <style>
    body { margin: 0; font-family: sans-serif; }
    #v3-drop { margin-top: 100px; width: 180px; height: 60px; border: 2px dashed #444; }
  </style>
</head>
<body>
  <button id="ctx-btn" type="button" style="position:fixed;left:40px;top:40px;width:120px;height:36px;">Context Target</button>
  <button id="coord-submit" type="submit" style="position:fixed;left:200px;top:40px;width:120px;height:36px;">Submit Now</button>
  <div id="v3-drop">File Drop Zone</div>
  <img id="static-img" src="/pixel.png" width="16" height="16" alt="px" />
  <form id="v3-form" onsubmit="event.preventDefault(); window.__searchSubmitted = true;">
    <input id="search-box" type="text" aria-label="Search Box" />
    <label for="skills">Skills</label>
    <select id="skills" multiple aria-label="Skills">
      <option value="js">JavaScript</option>
      <option value="ts">TypeScript</option>
      <option value="py">Python</option>
    </select>
    <label for="volume">Volume Slider</label>
    <input id="volume" type="range" min="0" max="100" value="20" aria-label="Volume Slider" />
  </form>
  <a id="dl-link" href="/download" download="sample.txt">Download Sample</a>
  <script>
    window.__v3Clicks = [];
    window.__v3RightClicked = false;
    window.__v3Hovered = false;
    window.__searchSubmitted = false;
    window.__v3Dropped = null;

    const ctxBtn = document.getElementById('ctx-btn');
    ctxBtn.addEventListener('click', (e) => {
      window.__v3Clicks.push({ button: e.button, shiftKey: e.shiftKey, altKey: e.altKey });
    });
    ctxBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      window.__v3RightClicked = true;
    });
    ctxBtn.addEventListener('mouseenter', () => {
      window.__v3Hovered = true;
    });

    const v3Drop = document.getElementById('v3-drop');
    v3Drop.addEventListener('dragover', (e) => e.preventDefault());
    v3Drop.addEventListener('drop', (e) => {
      e.preventDefault();
      window.__v3Dropped = {
        files: e.dataTransfer ? [...e.dataTransfer.files].map((f) => f.name + ':' + f.size) : [],
        text: e.dataTransfer ? e.dataTransfer.getData('text/plain') : '',
      };
    });
  </script>
</body>
</html>`;

const FORMS_ALL_HTML = `<!doctype html>
<html>
<head><title>All Form Controls Fixture</title></head>
<body>
  <form id="all-form" onsubmit="event.preventDefault(); window.__allFormSubmitted = true;">
    <input id="f-date" type="date" aria-label="Start Date" />
    <input id="f-time" type="time" aria-label="Start Time" />
    <input id="f-dt" type="datetime-local" aria-label="Meeting Slot" />
    <input id="f-month" type="month" aria-label="Billing Month" />
    <input id="f-num" type="number" aria-label="Years Experience" />
    <input id="f-tel" type="tel" aria-label="Mobile Tel" />
    <input id="f-url" type="url" aria-label="Portfolio URL" />
    <input id="f-pass" type="password" aria-label="Access Passcode" />
    <input id="f-color" type="color" aria-label="Brand Color" />
    <input id="f-range" type="range" min="0" max="100" value="10" aria-label="Confidence Score" />
    <input id="email-personal" type="email" aria-label="Personal Email" />
    <input id="email-work" type="email" aria-label="Work Email" />
    <input id="ref-target" type="text" aria-label="Ref Target Input" />
    <input id="sel-target" type="text" aria-label="Selector Target Input" />
    <textarea id="small-note" aria-label="Short Note" style="width:140px;height:36px;"></textarea>
    <div id="main-essay" contenteditable="true" role="textbox" aria-label="Detailed Essay" style="width:360px;height:140px;border:1px solid #999;"></div>
    <button id="dark-switch" type="button" role="switch" aria-checked="false" aria-label="Dark Mode">Dark Mode</button>
    <div id="tos-check" role="checkbox" aria-checked="false" tabindex="0">I agree to terms</div>
    <input id="multi-files" type="file" multiple aria-label="Supporting Docs" />
    <span id="multi-names"></span>
    <button id="custom-upload-btn" type="button">Upload Avatar</button>
    <input id="avatar-input" type="file" style="display:none" />
    <span id="avatar-name"></span>
  </form>
  <script>
    const sw = document.getElementById('dark-switch');
    sw.addEventListener('click', () => {
      sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
    });
    const tos = document.getElementById('tos-check');
    tos.addEventListener('click', () => {
      tos.setAttribute('aria-checked', tos.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
    });
    document.getElementById('multi-files').addEventListener('change', (e) => {
      document.getElementById('multi-names').textContent = [...e.target.files].map((f) => f.name).join(',');
    });
    const avatarInput = document.getElementById('avatar-input');
    document.getElementById('custom-upload-btn').addEventListener('click', () => avatarInput.click());
    avatarInput.addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      document.getElementById('avatar-name').textContent = f ? f.name : '';
    });
  </script>
</body>
</html>`;

const SCRAPE_HTML = `<!doctype html>
<html>
<head><title>Scraping & Markdown Fixture</title></head>
<body>
  <aside id="noise">Ignore sidebar promotional banner</aside>
  <main>
    <article>
      <h1>Catalog Page 1</h1>
      <table id="pricing-table">
        <thead><tr><th>Plan</th><th>Price</th></tr></thead>
        <tbody>
          <tr><td><p>Starter</p></td><td>$0</td></tr>
          <tr><td><p>Pro</p></td><td>$29</td></tr>
        </tbody>
      </table>
      <ul>
        <li>Backend
          <ul>
            <li>Postgres</li>
            <li>Redis</li>
          </ul>
        </li>
        <li>Frontend</li>
      </ul>
      <pre><code>const fast = true;
return fast;</code></pre>
      <blockquote>Important quote for benchmark</blockquote>
      <p>Read the <a href="https://example.com/docs">API guide</a> carefully.</p>
      <shadow-article></shadow-article>
      <div id="items">
        <div class="card" data-price="10">Alpha</div>
        <div class="card" data-price="25">Beta</div>
      </div>
      <div id="page-status">Page 1 ready</div>
      <button id="load-more" type="button">Load More</button>
    </article>
  </main>
  <iframe id="scrape-frame" src="/iframe-form" style="width:300px;height:90px;"></iframe>
  <script>
    class ShadowArticle extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = '<h3>Shadow Section</h3><p>Hidden inside shadow root</p>';
      }
    }
    customElements.define('shadow-article', ShadowArticle);
    document.getElementById('load-more').addEventListener('click', () => {
      setTimeout(() => {
        const d = document.createElement('div');
        d.className = 'card';
        d.setAttribute('data-price', '50');
        d.textContent = 'Gamma';
        document.getElementById('items').appendChild(d);
        document.getElementById('page-status').textContent = 'Page 2 loaded';
      }, 120);
    });
  </script>
</body>
</html>`;

const INTERACTIONS_HTML = `<!doctype html>
<html>
<head><title>Interactions Matrix Fixture</title></head>
<body>
  <button id="dbl-btn" type="button">Double Target</button>
  <input id="edit-inp" type="text" value="initial text" aria-label="Editable Input" />
  <div id="edit-ce" contenteditable="true" role="textbox" aria-label="Editable Div" style="width:200px;height:40px;border:1px solid #999;">seed</div>
  <label><input id="agree-cb" type="checkbox" /> Native Agree</label>
  <button id="role-sw" type="button" role="switch" aria-checked="false">Notify Switch</button>
  <select id="single-sel" aria-label="Single Select">
    <option value="alpha">Alpha Label</option>
    <option value="beta">Beta Label</option>
    <option value="gamma">Gamma Label</option>
  </select>
  <select id="multi-sel" multiple aria-label="Multi Select">
    <option value="alpha">Alpha Label</option>
    <option value="beta">Beta Label</option>
    <option value="gamma">Gamma Label</option>
  </select>
  <div id="hide-me">Visible Soon Hidden</div>
  <div id="detach-me">Attached Soon Detached</div>
  <button id="trigger-waits" type="button">Trigger Waits</button>
  <button id="batch-ok-btn" type="button" onclick="window.__batchOk = true;">Batch OK</button>
  <a id="next-route" href="/interactions-done">Go Done</a>
  <div style="height:1600px;">Spacer</div>
  <button id="bottom-btn" type="button" onclick="window.__bottomHit = true;">Bottom Target</button>
  <script>
    window.__dblCount = 0;
    window.__keyLog = [];
    window.__batchOk = false;
    window.__bottomHit = false;
    document.getElementById('dbl-btn').addEventListener('dblclick', () => { window.__dblCount++; });
    const inp = document.getElementById('edit-inp');
    inp.addEventListener('focus', () => { window.__inpFocused = true; });
    inp.addEventListener('keydown', (e) => window.__keyLog.push(e.key));
    const sw = document.getElementById('role-sw');
    sw.addEventListener('click', () => {
      sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
    });
    document.getElementById('trigger-waits').addEventListener('click', () => {
      setTimeout(() => { document.getElementById('hide-me').style.display = 'none'; }, 100);
      setTimeout(() => { document.getElementById('detach-me')?.remove(); }, 130);
    });
  </script>
</body>
</html>`;

const SESSION_DIAG_HTML = `<!doctype html>
<html>
<head><title>Session & Deep Diagnostics</title></head>
<body>
  <h1>Session Fixture</h1>
  <img id="sess-img" src="/pixel.png" width="16" height="16" alt="px" />
  <button id="confirm-btn" type="button" onclick="window.__confirmAns = confirm('Proceed safely?');">Confirm Box</button>
  <button id="post-big" type="button" onclick="fetch('/api/large-echo', { method: 'POST', headers: { 'X-Custom-Hdr': 'turbo-hdr', 'Content-Type': 'application/json' }, body: JSON.stringify({ payload: 'long-data' }) }).then(r => r.text()).then(t => { window.__bigLen = t.length; });">Fetch Big Payload</button>
  <script>
    setTimeout(() => {
      throw new Error('Unhandled boom 789');
    }, 30);
  </script>
</body>
</html>`;

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+fX0AAAAASUVORK5CYII=',
  'base64'
);

function startFixtureServer() {
  let nav2Hits = 0;
  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    if (urlPath === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(MAIN_HTML);
      return;
    }
    if (urlPath === '/iframe-form') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(IFRAME_HTML);
      return;
    }
    if (urlPath === '/gmail') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(GMAIL_HTML);
      return;
    }
    if (urlPath === '/dense') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildLargePageHtml());
      return;
    }
    if (urlPath === '/diag') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(DIAG_HTML);
      return;
    }
    if (urlPath === '/shadow') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(SHADOW_INTERACTION_HTML);
      return;
    }
    if (urlPath === '/v3') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(V3_HTML);
      return;
    }
    if (urlPath === '/download') {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="sample.txt"',
      });
      res.end('turbo-browser-v3-download');
      return;
    }
    if (urlPath === '/api/echo' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, echo: JSON.parse(body || '{}') }));
      });
      return;
    }
    if (urlPath === '/pixel.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(TINY_PNG);
      return;
    }
    if (urlPath === '/google-analytics.com/collect') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tracked: true }));
      return;
    }
    if (urlPath === '/forms-all') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FORMS_ALL_HTML);
      return;
    }
    if (urlPath === '/scrape') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(SCRAPE_HTML);
      return;
    }
    if (urlPath === '/interactions') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(INTERACTIONS_HTML);
      return;
    }
    if (urlPath === '/interactions-done') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>Done Route</title></head><body><h1>Interactions Done</h1></body></html>');
      return;
    }
    if (urlPath === '/nav-1') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Nav One</title><style>
        #print-only { display: none; }
        @media print { #print-only { display: block; } }
      </style></head><body>
        <h1 id="nav-title">Page One</h1>
        <div id="print-only">Print Layout</div>
        <a id="to-nav2" href="/nav-2">Next</a>
        <button id="open-popup" type="button" onclick="window.open('/popup', '_blank')">Open Popup</button>
      </body></html>`);
      return;
    }
    if (urlPath === '/nav-2') {
      nav2Hits++;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Nav Two #${nav2Hits}</title></head><body><h1 id="nav-title">Page Two</h1><span id="hit-count">${nav2Hits}</span></body></html>`);
      return;
    }
    if (urlPath === '/popup') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Popup Window</title></head><body><h1>Popup Ready</h1><button id="popup-ping" type="button" onclick="window.__popPing = true;">Ping</button></body></html>`);
      return;
    }
    if (urlPath === '/session') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(SESSION_DIAG_HTML);
      return;
    }
    if (urlPath === '/api/large-echo' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Reply-Tag': 'turbo-large' });
        res.end(JSON.stringify({ ok: true, echo: JSON.parse(body || '{}'), pad: 'X'.repeat(450) }));
      });
      return;
    }
    if (urlPath === '/dummy.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(Buffer.from('00000018667479706d703432', 'hex'));
      return;
    }
    if (urlPath === '/capture') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Capture Fixture</title></head><body style="margin:0;">
        <div id="card-box" style="width:240px;height:120px;background:#0ea5e9;color:#fff;padding:16px;">Element Capture Box</div>
        <button id="cap-btn" type="button" style="width:160px;height:40px;">Ref Capture Target</button>
        <div style="height:2200px;">Spacer</div>
        <div id="footer-box">Bottom Box</div>
      </body></html>`);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe('turbo-browser-mcp integration', () => {
  let server;
  let baseUrl;
  let tmpPdf;
  let manager;

  before(async () => {
    ({ server, baseUrl } = await startFixtureServer());
    tmpPdf = path.join(os.tmpdir(), `tbm-cv-${Date.now()}.pdf`);
    fs.writeFileSync(tmpPdf, '%PDF-1.4\n%turbo-browser-mcp-test\n%%EOF\n', 'utf8');
    manager = new BrowserManager({ mode: 'launch', headless: true });
  });

  after(async () => {
    await manager?.close();
    await new Promise((resolve) => server?.close(resolve));
    if (tmpPdf && fs.existsSync(tmpPdf)) {
      fs.unlinkSync(tmpPdf);
    }
  });

  it('fills React controlled inputs, contenteditable, select, ARIA combobox, radios, checkboxes, iframe & disk PDF in one batch while stopping before Submit', async (t) => {
    const t0 = performance.now();
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/` }]);
    const { page } = await manager.getPage();

    const inspected = await inspectCompact(page, { mode: 'interactive', maxChars: 4000 });
    assert.ok(inspected.text.includes('[f0:e'), 'should include main frame refs');
    assert.ok(inspected.text.includes('iframe f1'), 'should traverse child iframe automatically');
    assert.ok(inspected.text.includes('[hidden-file]'), 'should include visually hidden file input');
    assert.ok(inspected.charCount <= 4000, 'should stay within maxChars');

    const fillRes = await smartFillForm(page, {
      fields: [
        { keys: ['full name'], value: 'Nguyen Trung Thanh' },
        { keys: ['email'], value: 'thanh@example.com' },
        { keys: ['cover note'], value: 'Built fast Playwright MCP automation.' },
        { keys: ['country'], value: 'Vietnam' },
        { keys: ['work mode'], value: 'Remote Full-Time' },
        { keys: ['start immediately'], option: 'Yes' },
        { keys: ['tech stack'], check: ['React', 'Node'] },
        { keys: ['emergency contact'], value: '0901234567' },
        { keys: ['resume'], file: tmpPdf },
      ],
    });

    const elapsedMs = Math.round(performance.now() - t0);
    t.diagnostic(`Form + iframe + disk upload batch elapsed: ${elapsedMs}ms, filledCount=${fillRes.filledCount}`);

    assert.equal(fillRes.filledCount, 10, 'should fill 9 field specs (with 2 checkboxes = 10 controls)');
    assert.equal(fillRes.stoppedBeforeSubmit, true);
    assert.ok(
      fillRes.submitButtons.some((b) => /Submit Application/i.test(b.text)),
      'should report detected submit button'
    );

    const state = await evaluateJs(page, {
      expression: `() => ({
        reactTracked: window.__reactTracked,
        email: document.getElementById('email').value,
        cover: document.getElementById('cover-editor').innerText.trim(),
        country: document.getElementById('country').value,
        workMode: window.__workMode,
        startYes: document.querySelector('input[name="startNow"][value="yes"]').checked,
        stacks: [...document.querySelectorAll('input[name="stack"]:checked')].map(el => el.value),
        resumeText: document.getElementById('resume-name').textContent,
        submitted: window.__submitted
      })`,
    });

    assert.equal(state.result.reactTracked, 'Nguyen Trung Thanh');
    assert.equal(state.result.email, 'thanh@example.com');
    assert.equal(state.result.cover, 'Built fast Playwright MCP automation.');
    assert.equal(state.result.country, 'vn');
    assert.equal(state.result.workMode, 'remote');
    assert.equal(state.result.startYes, true);
    assert.deepEqual(state.result.stacks, ['react', 'node']);
    assert.ok(state.result.resumeText.includes(path.basename(tmpPdf)), 'disk PDF attached cleanly');
    assert.equal(state.result.submitted, 0, 'form must NOT submit automatically');

    const iframeState = await evaluateJs(page, {
      frameIdx: 1,
      expression: `() => document.getElementById('emergency').value`,
    });
    assert.equal(iframeState.result, '0901234567');
  });

  it('enforces Submit guard (allowSubmit=false blocks submit buttons; allowSubmit=true permits; safe buttons work)', async () => {
    const { page } = await manager.getPage();

    // Blocked by default on English Submit button
    const blockedEn = await actFast(page, { action: 'click', selector: '#submit-btn' });
    assert.equal(blockedEn.blocked, true);

    // Blocked by default on Vietnamese Đăng bài button
    const blockedVn = await actFast(page, { action: 'click', selector: '#post-btn' });
    assert.equal(blockedVn.blocked, true);

    // Non-submit button succeeds
    const safeClick = await actFast(page, { action: 'click', selector: '#next-btn' });
    assert.equal(safeClick.ok, true);

    // Ref targeting inside child iframe works directly via batch_actions
    const inspected = await inspectCompact(page, { mode: 'interactive' });
    const matchIframeBtn = /\[(f1:e\d+)\]\s+<button>\s+"Save Draft"/.exec(inspected.text);
    assert.ok(matchIframeBtn, 'should locate Save Draft ref inside iframe f1');

    const batchRes = await batchActions(page, [
      { action: 'click', ref: matchIframeBtn[1] },
      { action: 'click', selector: '#submit-btn' },
    ]);
    assert.equal(batchRes.blocked, true, 'batch_actions stops safely when hitting submit button');
    assert.equal(batchRes.completed, 2);

    const checkIframe = await evaluateJs(page, { frameIdx: 1, expression: 'window.__iframeSaved' });
    assert.equal(checkIframe.result, true);

    // Explicit opt-in allows submit
    const allowedSubmit = await actFast(page, {
      action: 'click',
      selector: '#submit-btn',
      allowSubmit: true,
    });
    assert.equal(allowedSubmit.ok, true);
    const subCount = await evaluateJs(page, { expression: 'window.__submitted' });
    assert.equal(subCount.result, 1);
  });

  it('fills Gmail compose popup fields without sending email', async () => {
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/gmail` }]);
    const { page } = await manager.getPage();

    const res = await smartFillForm(page, {
      gmail: {
        to: 'hr@company.example',
        subject: 'Application for Backend Role',
        body: 'Hello team, please find my application attached.',
      },
    });
    assert.equal(res.filledCount, 3);
    assert.ok(res.submitButtons.some((b) => /^Send$/i.test(b.text)));

    const gmailState = await evaluateJs(page, {
      expression: `() => ({
        to: document.querySelector('input[aria-label*="To"]').value,
        subject: document.querySelector('input[name="subjectbox"]').value,
        body: document.querySelector('div[aria-label="Message Body"]').innerText.trim(),
        sent: Boolean(window.__mailSent)
      })`,
    });
    assert.deepEqual(gmailState.result, {
      to: 'hr@company.example',
      subject: 'Application for Backend Role',
      body: 'Hello team, please find my application attached.',
      sent: false,
    });
  });

  it('strictly caps compact snapshots and clean text output sizes on dense pages', async (t) => {
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/dense` }]);
    const { page } = await manager.getPage();

    const snap1200 = await inspectCompact(page, { mode: 'interactive', maxChars: 1200 });
    assert.ok(snap1200.charCount <= 1200, `Expected <= 1200 chars, got ${snap1200.charCount}`);
    assert.equal(snap1200.truncated, true);

    const snap4000 = await inspectCompact(page, { mode: 'interactive', maxChars: 4000 });
    assert.ok(snap4000.charCount <= 4000, `Expected <= 4000 chars, got ${snap4000.charCount}`);
    t.diagnostic(`Dense 140-button page default snapshot: ${snap4000.charCount} chars (truncated=${snap4000.truncated})`);

    const clean = await extractCleanText(page, { maxChars: 500 });
    assert.ok(clean.text.includes('Performance Benchmark Article'));
    assert.ok(!clean.text.includes('SHOULD_NOT_APPEAR'));
    assert.ok(clean.charCount <= 500);
  });

  it('captures console errors, HTTP 404 responses, and auto-dismisses alerts in page_diagnostics', async () => {
    const res = await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/diag`, waitUntil: 'networkidle' }]);
    const diagTabId = res.activeTabId;

    await actFast(await manager.getPage(diagTabId).then((x) => x.page), {
      action: 'click',
      selector: '#alert-btn',
    });

    const diag = await manager.getDiagnostics(diagTabId, true);
    assert.ok(diag.console.some((c) => c.level === 'error' && c.text.includes('Boom console error 123')));
    assert.ok(diag.console.some((c) => c.level === 'warning' && c.text.includes('Warn message 456')));
    assert.ok(diag.networkErrors.some((n) => n.status === 404 && n.url.includes('/missing-404-endpoint')));
    assert.ok(diag.dialogs.some((d) => d.type === 'alert' && d.message.includes('Blocking Alert Text')));

    const afterClear = await manager.getDiagnostics(diagTabId);
    assert.equal(afterClear.console.length, 0);
    assert.equal(afterClear.networkErrors.length, 0);
    assert.equal(afterClear.dialogs.length, 0);
  });

  it('pierces open Shadow DOM, supports query filter & onlyChanged delta snapshots, and returns 1-turn snapshots', async () => {
    await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/shadow`, waitUntil: 'networkidle' }]);
    const { page } = await manager.getPage();
    const snapState = manager.getSnapshotState(page);

    const fullSnap = await inspectCompact(page, { mode: 'interactive' }, snapState);
    assert.ok(fullSnap.text.includes('Shadow Secret'), 'should find open Shadow DOM input');
    assert.ok(fullSnap.text.includes('Shadow Action'), 'should find open Shadow DOM button');
    assert.ok(fullSnap.text.includes('[shadow]'), 'should tag Shadow DOM nodes');

    const querySnap = await inspectCompact(page, { query: 'Shadow Action' }, snapState);
    assert.ok(querySnap.text.includes('Shadow Action'));
    assert.ok(!querySnap.text.includes('Reveal Dynamic Field'));

    const fillShadow = await smartFillForm(page, {
      fields: [{ keys: ['shadow secret'], value: 'shadow-token-77' }],
      returnSnapshot: true,
    });
    assert.equal(fillShadow.filledCount, 1);
    assert.ok(fillShadow.snapshot.includes('shadow-token-77'));

    // Re-sync baseline, reveal a new dynamic input via 1-turn actFast, then inspect onlyChanged
    await inspectCompact(page, { mode: 'interactive' }, snapState);
    const shadowMatch = /\[(f0:e\d+)\]\s+<button>\s+"Shadow Action"/.exec(fullSnap.text);
    assert.ok(shadowMatch, 'should extract ref for Shadow Action button');

    const shadowClick = await actFast(page, {
      action: 'click',
      ref: shadowMatch[1],
      returnSnapshot: true,
    }, snapState);
    assert.equal(shadowClick.ok, true);
    assert.ok(shadowClick.snapshot.includes('Mode: interactive'));

    await inspectCompact(page, { mode: 'interactive' }, snapState);
    await actFast(page, { action: 'click', selector: '#reveal-btn' }, snapState);
    const deltaSnap = await inspectCompact(page, { mode: 'interactive', onlyChanged: true }, snapState);
    assert.ok(deltaSnap.text.includes('Newly Revealed Field'), 'onlyChanged should show newly added input');
    assert.ok(!deltaSnap.text.includes('Reveal Dynamic Field'), 'onlyChanged should omit unchanged controls');

    const shadowClicked = await evaluateJs(page, { expression: 'window.__shadowClicked' });
    assert.equal(shadowClicked.result, true);
  });

  it('supports drag, wait textGone, resize, emulate colorScheme dark, and markdown extraction', async () => {
    const res = await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/shadow` }]);
    const tabId = res.activeTabId;
    const { page } = await manager.getPage(tabId);

    const waitGone = await actFast(page, { action: 'wait', textGone: 'Loading spinner...', timeoutMs: 4000 });
    assert.equal(waitGone.ok, true);

    const dragRes = await actFast(page, {
      action: 'drag',
      selector: '#drag-src',
      targetSelector: '#drag-dst',
    });
    assert.equal(dragRes.ok, true);
    const dropped = await evaluateJs(page, { expression: 'window.__dropped' });
    assert.equal(dropped.result, true);

    await manager.tabsBatch([
      { action: 'resize', tabId, width: 900, height: 650 },
      { action: 'emulate', tabId, colorScheme: 'dark' },
    ]);

    const envCheck = await evaluateJs(page, {
      expression: '() => ({ w: window.innerWidth, dark: window.matchMedia("(prefers-color-scheme: dark)").matches })',
    });
    assert.equal(envCheck.result.w, 900);
    assert.equal(envCheck.result.dark, true);

    const md = await extractCleanText(page, { format: 'markdown', maxChars: 1000 });
    assert.ok(md.text.includes('# v0.2 Interactive Fixture'));
  });

  it('inspects full HTTP reqId details, all console levels, and accepts prompt dialogs per policy', async () => {
    const res = await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/shadow`, waitUntil: 'networkidle' }]);
    const tabId = res.activeTabId;
    const { page } = await manager.getPage(tabId);

    await manager.getDiagnostics(tabId, {
      dialogPolicy: { action: 'accept', promptText: 'Confirmed 123' },
    });

    await actFast(page, { action: 'click', selector: '#prompt-btn' });
    await actFast(page, { action: 'click', selector: '#api-btn' });
    await actFast(page, { action: 'wait', ms: 150 });

    const diagAll = await manager.getDiagnostics(tabId, {
      level: 'all',
      statusFilter: 'all',
    });
    assert.ok(diagAll.console.some((c) => c.level === 'log' && c.text.includes('Confirmed 123')));
    assert.ok(diagAll.dialogs.some((d) => d.type === 'prompt' && d.actionTaken === 'accepted'));

    const apiReq = diagAll.requests.find((r) => r.url.includes('/api/echo'));
    assert.ok(apiReq, 'should capture /api/echo request in ring buffer');

    const reqDetail = await manager.getDiagnostics(tabId, { reqId: apiReq.reqId });
    assert.equal(reqDetail.request.status, 200);
    assert.ok(reqDetail.request.postData.includes('42'));
    assert.ok(reqDetail.request.responseBody.includes('"ok":true'));
  });

  it('captures screenshots/PDF safely and manages cookies, storage, storageState, and resource blocking', async () => {
    const tmpShot = path.join(os.tmpdir(), `tbm-shot-${Date.now()}.png`);
    const tmpExportPdf = path.join(os.tmpdir(), `tbm-page-${Date.now()}.pdf`);
    const tmpState = path.join(os.tmpdir(), `tbm-state-${Date.now()}.json`);

    try {
      const res = await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/shadow`, waitUntil: 'networkidle' }]);
      const tabId = res.activeTabId;
      const { page } = await manager.getPage(tabId);

      const shot = await capturePage(page, { savePath: tmpShot, returnImage: true });
      assert.equal(shot.ok, true);
      assert.ok(fs.existsSync(tmpShot));
      assert.ok(shot.base64 && shot.base64.length > 100);

      const pdf = await capturePage(page, { mode: 'pdf', savePath: tmpExportPdf });
      assert.equal(pdf.ok, true);
      assert.ok(fs.existsSync(tmpExportPdf));
      assert.ok(pdf.bytes > 500);

      await manager.manageNetworkSession(tabId, {
        cookieAction: 'set',
        cookies: [{ name: 'tbm_session', value: 'abc999' }],
        storageAction: 'set',
        storageType: 'local',
        items: { draftMode: 'on' },
        saveStorageStatePath: tmpState,
        blockResources: ['image'],
        blockUrls: ['/api/echo'],
      });

      const fetched = await manager.manageNetworkSession(tabId, {
        cookieAction: 'get',
        storageAction: 'get',
        storageType: 'local',
      });
      assert.ok(fetched.cookies.some((c) => c.name === 'tbm_session' && c.value === 'abc999'));
      assert.equal(fetched.storage.local.draftMode, 'on');
      assert.ok(fs.existsSync(tmpState));

      // Verify image resourceType blocking aborts <img> load AND blockUrls aborts matching fetch
      const blockedCheck = await evaluateJs(page, {
        expression: `async () => {
          const imgRes = await new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve('loaded');
            img.onerror = () => resolve('blocked');
            img.src = '/pixel.png?t=' + Date.now();
          });
          let apiRes = 'loaded';
          try { await fetch('/api/echo', { method: 'POST', body: '{}' }); } catch { apiRes = 'blocked'; }
          return { imgRes, apiRes };
        }`,
      });
      assert.deepEqual(blockedCheck.result, { imgRes: 'blocked', apiRes: 'blocked' });

      await manager.manageNetworkSession(tabId, { unblockAll: true, cookieAction: 'clear' });
      const imgAfterUnblock = await evaluateJs(page, {
        expression: `async () => new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve('loaded');
          img.onerror = () => resolve('blocked');
          img.src = '/pixel.png?after=' + Date.now();
        })`,
      });
      assert.equal(imgAfterUnblock.result, 'loaded');
    } finally {
      for (const f of [tmpShot, tmpExportPdf, tmpState]) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    }
  });

  it('supports isolatedContext sessions, emulate forcedColors/contrast/null, boxes & savePath, and device scale screenshots', async () => {
    const tmpInspect = path.join(os.tmpdir(), `tbm-inspect-${Date.now()}.txt`);
    const tmpText = path.join(os.tmpdir(), `tbm-text-${Date.now()}.txt`);
    const tmpShotDev = path.join(os.tmpdir(), `tbm-dev-${Date.now()}.png`);

    try {
      const openDefault = await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/v3`, waitUntil: 'networkidle' }]);
      const defaultTab = openDefault.activeTabId;
      await manager.manageNetworkSession(defaultTab, {
        cookieAction: 'set',
        cookies: [{ name: 'ctx_scope', value: 'default_val' }],
      });

      const openIso = await manager.tabsBatch([
        { action: 'open', url: `${baseUrl}/v3`, isolatedContext: 'work-iso', waitUntil: 'networkidle' },
      ]);
      const isoTab = openIso.activeTabId;
      assert.ok(openIso.tabs.some((t) => t.tabId === isoTab && t.isolatedContext === 'work-iso'));

      const isoCookies = await manager.manageNetworkSession(isoTab, { cookieAction: 'get' });
      assert.equal(isoCookies.cookies.some((c) => c.name === 'ctx_scope'), false, 'isolated context must not inherit default cookies');

      await manager.manageNetworkSession(isoTab, {
        cookieAction: 'set',
        cookies: [{ name: 'iso_only', value: 'yes' }],
      });
      const defCookiesAfter = await manager.manageNetworkSession(defaultTab, { cookieAction: 'get' });
      assert.equal(defCookiesAfter.cookies.some((c) => c.name === 'iso_only'), false, 'default context must remain isolated');

      // Emulate forcedColors + contrast, then reset via null
      await manager.tabsBatch([
        { action: 'emulate', tabId: defaultTab, forcedColors: 'active', contrast: 'more' },
      ]);
      const { page: defPage } = await manager.getPage(defaultTab);
      const emuOn = await evaluateJs(defPage, {
        expression: '() => ({ fc: matchMedia("(forced-colors: active)").matches, ct: matchMedia("(prefers-contrast: more)").matches })',
      });
      assert.deepEqual(emuOn.result, { fc: true, ct: true });

      await manager.tabsBatch([
        { action: 'emulate', tabId: defaultTab, forcedColors: null, contrast: null },
      ]);
      const emuReset = await evaluateJs(defPage, {
        expression: '() => ({ fc: matchMedia("(forced-colors: active)").matches, ct: matchMedia("(prefers-contrast: more)").matches })',
      });
      assert.deepEqual(emuReset.result, { fc: false, ct: false });

      // inspect_compact boxes + savePath, extract_clean_text savePath, capture_page scale
      const boxed = await inspectCompact(defPage, { mode: 'interactive', boxes: true, savePath: tmpInspect });
      assert.match(boxed.text, /\[box=\d+,\d+,\d+,\d+\]/);
      assert.equal(boxed.savePath, path.resolve(tmpInspect));
      assert.ok(fs.existsSync(tmpInspect));

      const savedText = await extractCleanText(defPage, { savePath: tmpText });
      assert.equal(savedText.savePath, path.resolve(tmpText));
      assert.ok(fs.existsSync(tmpText));

      const shotDev = await capturePage(defPage, { scale: 'device', savePath: tmpShotDev });
      assert.equal(shotDev.ok, true);
      assert.ok(fs.existsSync(tmpShotDev));
    } finally {
      for (const f of [tmpInspect, tmpText, tmpShotDev]) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    }
  });

  it('supports drop files/MIME, mouse button/modifiers/coords + guard, multi-select, range slider, type submit guard, and element evaluate_js', async () => {
    const tmpDrop = path.join(os.tmpdir(), `tbm-drop-${Date.now()}.txt`);
    const tmpEval = path.join(os.tmpdir(), `tbm-eval-${Date.now()}.json`);
    fs.writeFileSync(tmpDrop, 'hello drop v3', 'utf8');

    try {
      const opened = await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/v3`, waitUntil: 'networkidle' }]);
      const { page } = await manager.getPage(opened.activeTabId);

      // 1. drop with real disk file + custom MIME dropData
      const dropRes = await actFast(page, {
        action: 'drop',
        selector: '#v3-drop',
        files: [tmpDrop],
        dropData: { 'text/plain': 'custom-drop-mime' },
      });
      assert.equal(dropRes.ok, true);
      assert.deepEqual(dropRes.files, [path.basename(tmpDrop)]);
      const droppedState = await evaluateJs(page, { expression: 'window.__v3Dropped' });
      assert.equal(droppedState.result.files[0], `${path.basename(tmpDrop)}:13`);
      assert.equal(droppedState.result.text, 'custom-drop-mime');

      // 2. coordinate right-click, Shift modifier click, coordinate hover, and coordinate Submit guard
      const rightCoord = await actFast(page, { action: 'click', x: 100, y: 58, button: 'right' });
      assert.equal(rightCoord.ok, true);
      const shiftClick = await actFast(page, { action: 'click', selector: '#ctx-btn', modifiers: ['Shift'] });
      assert.equal(shiftClick.ok, true);
      const hoverCoord = await actFast(page, { action: 'hover', x: 100, y: 58 });
      assert.equal(hoverCoord.ok, true);
      const guardedCoord = await actFast(page, { action: 'click', x: 260, y: 58 });
      assert.equal(guardedCoord.blocked, true);

      const clickState = await evaluateJs(page, {
        expression: '() => ({ right: window.__v3RightClicked, hovered: window.__v3Hovered, clicks: window.__v3Clicks })',
      });
      assert.equal(clickState.result.right, true);
      assert.equal(clickState.result.hovered, true);
      assert.equal(clickState.result.clicks.some((c) => c.shiftKey === true), true);

      // 3. multi-select + range slider via smartFillForm, and multi-select via actFast select
      const fillV3 = await smartFillForm(page, {
        fields: [
          { selector: '#skills', values: ['js', 'py'] },
          { selector: '#volume', value: 78 },
        ],
      });
      assert.equal(fillV3.filledCount, 2);
      const filledVals = await evaluateJs(page, {
        expression: '() => ({ skills: [...document.getElementById("skills").selectedOptions].map(o => o.value), vol: document.getElementById("volume").value })',
      });
      assert.deepEqual(filledVals.result, { skills: ['js', 'py'], vol: '78' });

      const selAct = await actFast(page, { action: 'select', selector: '#skills', values: ['ts', 'py'] });
      assert.deepEqual(selAct.chosen, ['ts', 'py']);

      // 4. type slowly/fill & submit guard
      const blockedType = await actFast(page, {
        action: 'type',
        selector: '#search-box',
        value: 'blocked search',
        slowly: false,
        submit: true,
      });
      assert.equal(blockedType.blocked, true);

      const okType = await actFast(page, {
        action: 'type',
        selector: '#search-box',
        value: 'turbo query',
        slowly: false,
        submit: true,
        allowSubmit: true,
      });
      assert.equal(okType.ok, true);
      assert.equal(okType.submitted, true);
      const searchDone = await evaluateJs(page, {
        expression: '() => ({ val: document.getElementById("search-box").value, sub: window.__searchSubmitted })',
      });
      assert.deepEqual(searchDone.result, { val: 'turbo query', sub: true });

      // 5. evaluateJs targeting element + savePath
      const elEval = await evaluateJs(page, {
        selector: '#ctx-btn',
        expression: '(el, arg) => ({ tag: el.tagName, combined: el.id + arg.suffix })',
        arg: { suffix: '-ok' },
        savePath: tmpEval,
      });
      assert.deepEqual(elEval.result, { tag: 'BUTTON', combined: 'ctx-btn-ok' });
      assert.ok(fs.existsSync(tmpEval));
      assert.equal(JSON.parse(fs.readFileSync(tmpEval, 'utf8')).combined, 'ctx-btn-ok');
    } finally {
      for (const f of [tmpDrop, tmpEval]) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    }
  });

  it('captures browser downloads and filters diagnostics with includeStatic, urlFilter, part, and savePath', async () => {
    const tmpDiag = path.join(os.tmpdir(), `tbm-diag-${Date.now()}.json`);
    let downloadedPath = null;

    try {
      const opened = await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/v3`, waitUntil: 'networkidle' }]);
      const tabId = opened.activeTabId;
      const { page } = await manager.getPage(tabId);

      await evaluateJs(page, {
        expression: '() => fetch("/api/echo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ v3: 99 }) }).then(r => r.json())',
      });
      await actFast(page, { action: 'click', selector: '#dl-link' });
      await actFast(page, { action: 'wait', ms: 250 });

      const noStatic = await manager.getDiagnostics(tabId, {
        statusFilter: 'all',
        includeStatic: false,
      });
      assert.equal(noStatic.requests.some((r) => r.url.includes('/pixel.png')), false, 'includeStatic=false should exclude 2xx images');
      assert.equal(noStatic.requests.some((r) => r.url.includes('/api/echo')), true);
      assert.ok(noStatic.downloads.some((d) => d.suggestedFilename === 'sample.txt'));

      const dlEntry = noStatic.downloads.find((d) => d.suggestedFilename === 'sample.txt');
      downloadedPath = dlEntry.savePath;
      assert.ok(downloadedPath && fs.existsSync(downloadedPath));
      assert.equal(fs.readFileSync(downloadedPath, 'utf8'), 'turbo-browser-v3-download');

      const withStatic = await manager.getDiagnostics(tabId, {
        statusFilter: 'all',
        includeStatic: true,
      });
      assert.equal(withStatic.requests.some((r) => r.url.includes('/pixel.png')), true);

      const urlFiltered = await manager.getDiagnostics(tabId, {
        statusFilter: 'all',
        urlFilter: '/api/echo',
        savePath: tmpDiag,
      });
      assert.equal(urlFiltered.requests.every((r) => r.url.includes('/api/echo')), true);
      assert.ok(fs.existsSync(tmpDiag));

      const echoReq = urlFiltered.requests[0];
      const partResp = await manager.getDiagnostics(tabId, {
        reqId: echoReq.reqId,
        part: 'response-body',
      });
      assert.equal(partResp.part, 'response-body');
      assert.ok(partResp.data.includes('99'));
    } finally {
      for (const f of [tmpDiag, downloadedPath].filter(Boolean)) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    }
  });

  it('supports concurrent open_many batching, turbo/clean network presets, and elapsedMs telemetry', async () => {
    const batchRes = await manager.tabsBatch([
      {
        action: 'open_many',
        urls: [`${baseUrl}/v3`, `${baseUrl}/shadow`, `${baseUrl}/dense`],
        concurrency: 3,
      },
    ]);
    assert.equal(typeof batchRes.elapsedMs, 'number');
    assert.equal(batchRes.results[0].action, 'open_many');
    assert.equal(batchRes.results[0].opened.length, 3);
    assert.equal(typeof batchRes.results[0].elapsedMs, 'number');
    const firstTabId = batchRes.results[0].opened[0].tabId;

    const presetRes = await manager.manageNetworkSession(firstTabId, { preset: 'turbo' });
    assert.equal(presetRes.presetApplied, 'turbo');
    assert.ok(presetRes.blockedResources.includes('image'));

    const { page } = await manager.getPage(firstTabId);
    const blockedCheck = await evaluateJs(page, {
      expression: `async () => {
        const imgState = await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve('loaded');
          img.onerror = () => resolve('blocked');
          img.src = '/pixel.png?v4=' + Date.now();
        });
        let trackerState = 'loaded';
        try { await fetch('/google-analytics.com/collect'); } catch { trackerState = 'blocked'; }
        return { imgState, trackerState };
      }`,
    });
    assert.deepEqual(blockedCheck.result, { imgState: 'blocked', trackerState: 'blocked' });

    const cleanRes = await manager.manageNetworkSession(firstTabId, { preset: 'clean' });
    assert.equal(cleanRes.presetApplied, 'clean');
    assert.equal(cleanRes.unblockedAll, true);

    const cleanCheck = await evaluateJs(page, {
      expression: `async () => {
        const res = await fetch('/google-analytics.com/collect');
        return await res.json();
      }`,
    });
    assert.deepEqual(cleanCheck.result, { tracked: true });

    const snapTimed = await inspectCompact(page, { mode: 'interactive' });
    assert.equal(typeof snapTimed.elapsedMs, 'number');
  });

  it('prevents stale data-tbm-ref collisions, handles regex metacharacters in labels/options, and guards implicit Enter submit', async () => {
    const opened = await manager.tabsBatch([
      { action: 'open', url: 'about:blank', isolatedContext: 'regression', activate: true },
    ]);
    const tabId = opened.results[0].tabId;
    const { page } = await manager.getPage(tabId);
    await page.setContent(`<!doctype html><html><body>
      <a id="top-link" href="#top" onclick="window.__topClicked = true; return false;">Skip Navigation</a>
      <form id="edge-f" onsubmit="event.preventDefault(); window.__edgeSubmitted = (window.__edgeSubmitted || 0) + 1;">
        <input id="first" name="q" type="text" aria-label="Search (optional)" />
        <label for="phone">Phone (optional)</label>
        <input id="phone" type="text" />
        <label for="lang">Skill (C++)</label>
        <select id="lang"><option value="">Pick</option><option value="c++">C++</option><option value="ts">TypeScript</option></select>
        <label><input id="exp" type="checkbox" /> 5+ years (Senior)</label>
        <button id="edge-sub" type="submit">Submit</button>
      </form>
      <form id="safe-search-f" onsubmit="event.preventDefault(); window.__safeSearched = (window.__safeSearched || 0) + 1;">
        <input id="q-safe" type="search" />
        <button type="submit">Search</button>
      </form>
    </body></html>`);

    // 1. Switching inspect_compact modes must clear stale [data-tbm-ref] attributes.
    await inspectCompact(page, { mode: 'interactive' });
    const formsSnap = await inspectCompact(page, { mode: 'forms' });
    assert.ok(formsSnap.text.includes('[f0:e1] <input:text> "Search (optional)"'));
    await actFast(page, { action: 'click', ref: 'f0:e1' });
    await actFast(page, { action: 'fill', ref: 'f0:e1', value: 'hello' });
    const afterRefState = await evaluateJs(page, {
      expression: '({ val: document.getElementById("first").value, topClicked: Boolean(window.__topClicked) })',
    });
    assert.deepEqual(afterRefState.result, { val: 'hello', topClicked: false });

    // 2. Regex metacharacters in keys, select value, and check labels must match cleanly without SyntaxError.
    const metaFill = await smartFillForm(page, {
      fields: [
        { keys: ['Phone (optional)'], value: '0999888777' },
        { keys: ['C++'], value: 'C++' },
        { check: '5+ years (Senior)' },
      ],
    });
    assert.equal(metaFill.filledCount, 3);
    const metaState = await evaluateJs(page, {
      expression: '({ phone: document.getElementById("phone").value, lang: document.getElementById("lang").value, exp: document.getElementById("exp").checked })',
    });
    assert.deepEqual(metaState.result, { phone: '0999888777', lang: 'c++', exp: true });

    // 3. Pressing Enter inside a <form> input must be blocked when allowSubmit=false, allowed on safe Search forms or allowSubmit=true.
    const blockedEnter = await actFast(page, { action: 'press', selector: '#first', key: 'Enter', allowSubmit: false });
    assert.equal(blockedEnter.blocked, true);

    await actFast(page, { action: 'focus', selector: '#phone' });
    const blockedActiveEnter = await actFast(page, { action: 'press', key: 'Enter', allowSubmit: false });
    assert.equal(blockedActiveEnter.blocked, true);

    const safeEnter = await actFast(page, { action: 'press', selector: '#q-safe', key: 'Enter', allowSubmit: false });
    assert.equal(safeEnter.ok, true);

    const allowedEnter = await actFast(page, { action: 'press', selector: '#first', key: 'Enter', allowSubmit: true });
    assert.equal(allowedEnter.ok, true);

    const submitCounts = await evaluateJs(page, {
      expression: '({ edge: window.__edgeSubmitted || 0, safe: window.__safeSearched || 0 })',
    });
    assert.deepEqual(submitCounts.result, { edge: 1, safe: 1 });

    // 4. Async wait for text/selector appearing after action delay (must not throw immediately on count=0).
    await page.setContent(`<!doctype html><html><body>
      <button id="enable-btn" type="button" onclick="setTimeout(() => { const inp = document.getElementById('async-inp'); inp.disabled = false; const p = document.createElement('p'); p.id='async-msg'; p.textContent='Async ready!'; document.body.appendChild(p); }, 250);">Enable</button>
      <input id="async-inp" type="text" disabled />
    </body></html>`);
    const asyncBatch = await batchActions(page, [
      { action: 'click', selector: '#enable-btn' },
      { action: 'wait', text: 'Async ready!', timeoutMs: 4000 },
      { action: 'wait', selector: '#async-msg', timeoutMs: 2000 },
      { action: 'fill', selector: '#async-inp', value: 'loaded-ok' },
    ]);
    assert.equal(asyncBatch.completed, 4);
    const asyncVal = await evaluateJs(page, { expression: 'document.getElementById("async-inp").value' });
    assert.equal(asyncVal.result, 'loaded-ok');
  });

  it('supports CLI flags --version, --help, and --doctor', async () => {
    const runCliFlag = (args) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [ENTRY_PATH, ...args], {
          env: { ...process.env, TURBO_BROWSER_HEADLESS: 'true' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
        child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
        child.on('error', reject);
        child.on('exit', (code) => resolve({ code, stdout, stderr }));
      });

    const verRes = await runCliFlag(['--version']);
    assert.equal(verRes.code, 0);
    assert.equal(verRes.stdout.trim(), '0.4.0');

    const helpRes = await runCliFlag(['--help']);
    assert.equal(helpRes.code, 0);
    assert.ok(helpRes.stdout.includes('--doctor'));
    assert.ok(helpRes.stdout.includes('--allow-submit'));

    const docRes = await runCliFlag(['--doctor']);
    assert.equal(docRes.code, 0);
    const parsed = JSON.parse(docRes.stdout);
    assert.equal(parsed.version, '0.4.0');
    assert.equal(parsed.playwrightLoaded, true);
    assert.equal(parsed.platform, process.platform);
  });

  it('serves MCP JSON-RPC 2.0 over stdio (initialize, tools/list, tools/call)', async () => {
    const child = spawn(process.execPath, [ENTRY_PATH], {
      env: { ...process.env, TURBO_BROWSER_MODE: 'launch', TURBO_BROWSER_HEADLESS: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const pending = new Map();
    let outBuf = '';

    child.stdout.on('data', (chunk) => {
      outBuf += chunk.toString('utf8');
      let nl;
      while ((nl = outBuf.indexOf('\n')) !== -1) {
        const line = outBuf.slice(0, nl).trim();
        outBuf = outBuf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        const resolver = pending.get(msg.id);
        if (resolver) {
          pending.delete(msg.id);
          resolver(msg);
        }
      }
    });

    const callRpc = (id, method, params = {}) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`RPC timeout for ${method}`)), 15000);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });

    try {
      const initRes = await callRpc(1, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      });
      assert.equal(initRes.result.serverInfo.name, 'turbo-browser-mcp');
      assert.equal(initRes.result.serverInfo.version, '0.4.0');

      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

      const listRes = await callRpc(2, 'tools/list');
      const tools = listRes.result.tools;
      assert.equal(tools.length, 10);
      for (const tool of tools) {
        assert.ok(tool.annotations, `${tool.name} missing MCP annotations`);
        assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
      }

      const openRes = await callRpc(3, 'tools/call', {
        name: 'tabs_batch',
        arguments: { operations: [{ action: 'open', url: `${baseUrl}/` }] },
      });
      assert.equal(openRes.result.isError, false);
      const tabPayload = JSON.parse(openRes.result.content[0].text);
      assert.equal(tabPayload.connectionType, 'launch');
      assert.ok(tabPayload.tabs.some((t) => t.url.startsWith(baseUrl)));

      const inspectRes = await callRpc(4, 'tools/call', {
        name: 'inspect_compact',
        arguments: { mode: 'forms', maxChars: 2000 },
      });
      assert.equal(inspectRes.result.isError, false);
      assert.ok(inspectRes.result.content[0].text.includes('Full Name'));

      const fillRpcRes = await callRpc(5, 'tools/call', {
        name: 'smart_fill_form',
        arguments: {
          fields: [{ keys: ['full name'], value: 'Stdio Tester' }],
        },
      });
      assert.equal(fillRpcRes.result.isError, false);
      assert.equal(JSON.parse(fillRpcRes.result.content[0].text).filledCount, 1);

      const actBlockedRpc = await callRpc(6, 'tools/call', {
        name: 'act_fast',
        arguments: { action: 'click', selector: '#submit-btn' },
      });
      assert.equal(actBlockedRpc.result.isError, false);
      assert.equal(JSON.parse(actBlockedRpc.result.content[0].text).blocked, true);

      const batchRpcRes = await callRpc(7, 'tools/call', {
        name: 'batch_actions',
        arguments: { steps: [{ action: 'click', selector: '#next-btn' }] },
      });
      assert.equal(batchRpcRes.result.isError, false);
      assert.equal(JSON.parse(batchRpcRes.result.content[0].text).completed, 1);

      const textRpcRes = await callRpc(8, 'tools/call', {
        name: 'extract_clean_text',
        arguments: { maxChars: 1000 },
      });
      assert.equal(textRpcRes.result.isError, false);
      assert.ok(textRpcRes.result.content[0].text.includes('Senior Full-Stack Application'));

      const evalRpcRes = await callRpc(9, 'tools/call', {
        name: 'evaluate_js',
        arguments: { expression: '() => window.__nextClicked' },
      });
      assert.equal(evalRpcRes.result.isError, false);
      assert.equal(JSON.parse(evalRpcRes.result.content[0].text).result, 1);

      const diagRpcRes = await callRpc(10, 'tools/call', {
        name: 'page_diagnostics',
        arguments: { level: 'all', statusFilter: 'all' },
      });
      assert.equal(diagRpcRes.result.isError, false);
      assert.ok(Array.isArray(JSON.parse(diagRpcRes.result.content[0].text).console));

      const capRpcRes = await callRpc(11, 'tools/call', {
        name: 'capture_page',
        arguments: { returnImage: true },
      });
      assert.equal(capRpcRes.result.isError, false);
      assert.equal(capRpcRes.result.content[1]?.type, 'image');
      assert.equal(capRpcRes.result.content[1]?.mimeType, 'image/png');

      const netRpcRes = await callRpc(12, 'tools/call', {
        name: 'network_session',
        arguments: { cookieAction: 'set', cookies: [{ name: 'rpc_cookie', value: 'ok' }] },
      });
      assert.equal(netRpcRes.result.isError, false);
      assert.equal(JSON.parse(netRpcRes.result.content[0].text).cookiesSet, 1);

      const closeRpcRes = await callRpc(13, 'tools/call', {
        name: 'tabs_batch',
        arguments: { operations: [{ action: 'close_browser' }] },
      });
      assert.equal(closeRpcRes.result.isError, false);
      assert.equal(JSON.parse(closeRpcRes.result.content[0].text).results[0].closed, true);
    } finally {
      child.stdin.end();
      await new Promise((resolve) => child.once('exit', resolve));
    }
  });

  it('supports Content-Length MCP header framing over stdio', async () => {
    const child = spawn(process.execPath, [ENTRY_PATH], {
      env: { ...process.env, TURBO_BROWSER_MODE: 'launch', TURBO_BROWSER_HEADLESS: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let rawBuf = Buffer.alloc(0);
    const messages = [];
    child.stdout.on('data', (chunk) => {
      rawBuf = Buffer.concat([rawBuf, chunk]);
      while (true) {
        const idx = rawBuf.indexOf('\r\n\r\n');
        if (idx === -1) break;
        const header = rawBuf.subarray(0, idx).toString('utf8');
        const m = /Content-Length:\s*(\d+)/i.exec(header);
        if (!m) break;
        const len = Number(m[1]);
        if (rawBuf.length < idx + 4 + len) break;
        const payload = rawBuf.subarray(idx + 4, idx + 4 + len).toString('utf8');
        rawBuf = rawBuf.subarray(idx + 4 + len);
        messages.push(JSON.parse(payload));
      }
    });

    const sendFrame = (obj) => {
      const json = JSON.stringify(obj);
      const bytes = Buffer.byteLength(json, 'utf8');
      child.stdin.write(`Content-Length: ${bytes}\r\n\r\n${json}`);
    };

    try {
      sendFrame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
      sendFrame({ jsonrpc: '2.0', id: 2, method: 'ping' });

      const deadline = Date.now() + 8000;
      while (messages.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.equal(messages.length, 2);
      assert.equal(messages[0].id, 1);
      assert.equal(messages[0].result.serverInfo.name, 'turbo-browser-mcp');
      assert.deepEqual(messages[1].result, {});
    } finally {
      child.stdin.end();
      await new Promise((resolve) => child.once('exit', resolve));
    }
  });

  it('fills all HTML5 input types, color/range, ARIA switches, not/ref/selector/main, overwrite, multi-file & filechooser', async () => {
    const tmpA = path.join(os.tmpdir(), `tbm-a-${Date.now()}.txt`);
    const tmpB = path.join(os.tmpdir(), `tbm-b-${Date.now()}.txt`);
    const tmpAv = path.join(os.tmpdir(), `tbm-av-${Date.now()}.png`);
    fs.writeFileSync(tmpA, 'doc a', 'utf8');
    fs.writeFileSync(tmpB, 'doc b', 'utf8');
    fs.writeFileSync(tmpAv, TINY_PNG);

    try {
      const opened = await manager.tabsBatch([
        { action: 'open', url: `${baseUrl}/forms-all`, isolatedContext: 'forms-all', waitUntil: 'networkidle' },
      ]);
      const { page } = await manager.getPage(opened.activeTabId);

      const formsSnap = await inspectCompact(page, { mode: 'forms' });
      const refMatch = /\[(f0:e\d+)\]\s+<input:text>\s+"Ref Target Input"/.exec(formsSnap.text);
      assert.ok(refMatch, 'should find Ref Target Input ref');
      assert.ok(formsSnap.text.includes('<button:switch> "Dark Mode"'), 'should inspect ARIA switch role');

      const fill1 = await smartFillForm(page, {
        fields: [
          { keys: ['start date'], value: '2026-11-14' },
          { keys: ['start time'], value: '14:30' },
          { keys: ['meeting slot'], value: '2026-11-14T14:30' },
          { keys: ['billing month'], value: '2026-11' },
          { keys: ['years experience'], value: '7' },
          { keys: ['mobile tel'], value: '+84901234567' },
          { keys: ['portfolio url'], value: 'https://example.org/app' },
          { keys: ['access passcode'], value: 'S3cret!99' },
          { keys: ['brand color'], value: '#ff5500' },
          { keys: ['confidence score'], value: 85 },
          { keys: ['email'], not: ['work'], value: 'personal@example.com' },
          { keys: ['work email'], value: 'work@example.com' },
          { ref: refMatch[1], value: 'filled-via-ref' },
          { selector: '#sel-target', value: 'filled-via-selector' },
          { keys: ['short note'], value: 'Brief note' },
          { selector: '#dark-switch', value: true },
          { check: 'I agree to terms' },
          { keys: ['supporting docs'], files: [tmpA, tmpB] },
          { selector: '#custom-upload-btn', file: tmpAv },
        ],
        main: 'Main detailed essay automatically placed in largest box.',
      });
      assert.equal(fill1.filledCount, 20);

      const postSnap = await inspectCompact(page, { mode: 'forms' });
      assert.ok(postSnap.text.includes('<button:switch> "Dark Mode" [checked]'), 'switch [checked] flag must render');
      assert.ok(postSnap.text.includes('<div:checkbox> "I agree to terms" [checked]'), 'role=checkbox [checked] must render');

      const skipCheck = await smartFillForm(page, {
        overwrite: false,
        fields: [
          { keys: ['brand color'], value: '#00ff00' },
          { keys: ['confidence score'], value: 25 },
          { keys: ['work email'], value: 'ignored@example.com' },
        ],
      });
      assert.equal(skipCheck.filledCount, 0);
      assert.equal(skipCheck.skipped.length, 3);

      const overCheck = await smartFillForm(page, {
        overwrite: true,
        fields: [
          { keys: ['brand color'], value: '#00aa55' },
          { keys: ['confidence score'], value: 33 },
          { keys: ['work email'], value: 'updated@example.com' },
          { keys: ['dark mode'], value: false },
        ],
      });
      assert.equal(overCheck.filledCount, 4);

      const vals = await evaluateJs(page, {
        expression: `() => ({
          date: document.getElementById('f-date').value,
          time: document.getElementById('f-time').value,
          dt: document.getElementById('f-dt').value,
          month: document.getElementById('f-month').value,
          num: document.getElementById('f-num').value,
          tel: document.getElementById('f-tel').value,
          url: document.getElementById('f-url').value,
          pass: document.getElementById('f-pass').value,
          color: document.getElementById('f-color').value,
          range: document.getElementById('f-range').value,
          personal: document.getElementById('email-personal').value,
          work: document.getElementById('email-work').value,
          refVal: document.getElementById('ref-target').value,
          selVal: document.getElementById('sel-target').value,
          small: document.getElementById('small-note').value,
          essay: document.getElementById('main-essay').innerText.trim(),
          darkSw: document.getElementById('dark-switch').getAttribute('aria-checked'),
          tos: document.getElementById('tos-check').getAttribute('aria-checked'),
          multi: document.getElementById('multi-names').textContent,
          avatar: document.getElementById('avatar-name').textContent
        })`,
      });
      assert.deepEqual(vals.result, {
        date: '2026-11-14',
        time: '14:30',
        dt: '2026-11-14T14:30',
        month: '2026-11',
        num: '7',
        tel: '+84901234567',
        url: 'https://example.org/app',
        pass: 'S3cret!99',
        color: '#00aa55',
        range: '33',
        personal: 'personal@example.com',
        work: 'updated@example.com',
        refVal: 'filled-via-ref',
        selVal: 'filled-via-selector',
        small: 'Brief note',
        essay: 'Main detailed essay automatically placed in largest box.',
        darkSw: 'false',
        tos: 'true',
        multi: `${path.basename(tmpA)},${path.basename(tmpB)}`,
        avatar: path.basename(tmpAv),
      });
    } finally {
      for (const f of [tmpA, tmpB, tmpAv]) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    }
  });

  it('scrapes paginated items, Shadow DOM, tables/nested lists/code/quotes markdown, inspect modes, and JSON savePath', async () => {
    const tmpScrapeJson = path.join(os.tmpdir(), `tbm-scrape-${Date.now()}.json`);
    try {
      const opened = await manager.tabsBatch([
        { action: 'open', url: `${baseUrl}/scrape`, isolatedContext: 'scrape', waitUntil: 'networkidle' },
      ]);
      const { page } = await manager.getPage(opened.activeTabId);

      const artSnap = await inspectCompact(page, { mode: 'article', includeFrames: false });
      assert.ok(artSnap.text.includes('<h1> Catalog Page 1'));
      assert.equal(artSnap.framesScanned, 1);
      assert.equal(artSnap.text.includes('iframe f1'), false);

      const allSnap = await inspectCompact(page, { mode: 'all', includeFrames: true });
      assert.ok(allSnap.framesScanned >= 2);
      assert.ok(allSnap.text.includes('Emergency Contact'));

      const scopedSnap = await inspectCompact(page, { mode: 'all', selector: '#items', includeFrames: false });
      assert.equal(scopedSnap.text.includes('Emergency Contact'), false);

      const pageBatch = await batchActions(page, [
        { action: 'click', selector: '#load-more' },
        { action: 'wait', text: 'Page 2 loaded', timeoutMs: 3000 },
      ]);
      assert.equal(pageBatch.completed, 2);

      const md = await extractCleanText(page, { format: 'markdown', includeFrames: false, maxChars: 6000 });
      assert.ok(md.text.includes('# Catalog Page 1'));
      assert.ok(md.text.includes('| Plan | Price |\n| --- | --- |'));
      assert.ok(md.text.includes('| Starter | $0 |'));
      assert.equal(md.text.includes('\nStarter\n'), false, 'should not duplicate <p> inside <td>');
      assert.ok(md.text.includes('- Backend\n  - Postgres\n  - Redis\n- Frontend'), 'nested lists should indent cleanly without duplicating');
      assert.ok(md.text.includes('```\nconst fast = true;\nreturn fast;\n```'));
      assert.ok(md.text.includes('> Important quote for benchmark'));
      assert.ok(md.text.includes('[API guide](https://example.com/docs)'));
      assert.ok(md.text.includes('### Shadow Section'));
      assert.ok(md.text.includes('Hidden inside shadow root'));
      assert.equal(md.text.includes('Ignore sidebar promotional banner'), false);

      const extracted = await evaluateJs(page, {
        arg: { minPrice: 20 },
        savePath: tmpScrapeJson,
        expression: `(arg) => [...document.querySelectorAll('.card')]
          .map(el => ({ name: el.textContent.trim(), price: Number(el.dataset.price) }))
          .filter(item => item.price >= arg.minPrice)`,
      });
      assert.deepEqual(extracted.result, [
        { name: 'Beta', price: 25 },
        { name: 'Gamma', price: 50 },
      ]);
      assert.deepEqual(JSON.parse(fs.readFileSync(tmpScrapeJson, 'utf8')), extracted.result);
    } finally {
      if (fs.existsSync(tmpScrapeJson)) fs.unlinkSync(tmpScrapeJson);
    }
  });

  it('covers dblclick, focus/clear/type slowly/press combos, check/uncheck switch, label selects, scroll, hidden/detached/url waits & batch continueOnError', async () => {
    const opened = await manager.tabsBatch([
      { action: 'open', url: `${baseUrl}/interactions`, isolatedContext: 'interactions', waitUntil: 'networkidle' },
    ]);
    const { page } = await manager.getPage(opened.activeTabId);

    await actFast(page, { action: 'dblclick', selector: '#dbl-btn' });
    await actFast(page, { action: 'focus', selector: '#edit-inp' });
    await actFast(page, { action: 'clear', selector: '#edit-inp' });
    await actFast(page, { action: 'type', selector: '#edit-inp', value: 'typed', slowly: true, delayMs: 5 });
    const typedCheck = await evaluateJs(page, { expression: 'document.getElementById("edit-inp").value' });
    assert.equal(typedCheck.result, 'typed');

    await actFast(page, { action: 'press', selector: '#edit-inp', key: 'Control+a' });
    await actFast(page, { action: 'press', selector: '#edit-inp', key: 'Backspace' });
    await actFast(page, { action: 'press', key: 'Tab' });
    await actFast(page, { action: 'press', key: 'Escape' });

    await actFast(page, { action: 'clear', selector: '#edit-ce' });
    await actFast(page, { action: 'fill', selector: '#edit-ce', value: 'ce-updated' });

    await actFast(page, { action: 'check', selector: '#agree-cb' });
    await actFast(page, { action: 'uncheck', selector: '#agree-cb' });
    await actFast(page, { action: 'check', selector: '#role-sw' });
    await actFast(page, { action: 'uncheck', selector: '#role-sw' });
    await actFast(page, { action: 'check', selector: '#role-sw' });

    const s1 = await actFast(page, { action: 'select', selector: '#single-sel', label: 'Beta Label' });
    assert.deepEqual(s1.chosen, ['beta']);
    const s2 = await actFast(page, { action: 'select', selector: '#single-sel', value: 'gamma' });
    assert.deepEqual(s2.chosen, ['gamma']);
    const m1 = await actFast(page, { action: 'select', selector: '#multi-sel', label: ['Alpha Label', 'Gamma Label'] });
    assert.deepEqual(m1.chosen, ['alpha', 'gamma']);

    await actFast(page, { action: 'scroll', dx: 0, dy: 200 });
    const scrollMid = await evaluateJs(page, { expression: 'window.scrollY' });
    assert.ok(scrollMid.result >= 150);

    await actFast(page, { action: 'scroll', selector: '#bottom-btn' });
    await actFast(page, { action: 'click', selector: '#bottom-btn' });

    await actFast(page, { action: 'click', selector: '#trigger-waits' });
    const waitHidden = await actFast(page, { action: 'wait', selector: '#hide-me', state: 'hidden', timeoutMs: 3000 });
    const waitDetached = await actFast(page, { action: 'wait', selector: '#detach-me', state: 'detached', timeoutMs: 3000 });
    assert.equal(waitHidden.ok, true);
    assert.equal(waitDetached.ok, true);

    const errBatch = await batchActions(page, [
      { action: 'smart_fill_form', fields: [{ selector: '#edit-inp', value: 'batch-done' }] },
      { action: 'click', selector: '#nonexistent-step', timeoutMs: 300 },
      { action: 'click', selector: '#batch-ok-btn' },
    ], { continueOnError: true, returnSnapshot: true });
    assert.equal(errBatch.completed, 3);
    assert.equal(errBatch.results[1].ok, false);
    assert.equal(errBatch.results[2].ok, true);
    assert.ok(errBatch.snapshot.includes('Mode: interactive'));

    const stateCheck = await evaluateJs(page, {
      expression: `() => ({
        dbl: window.__dblCount,
        focused: Boolean(window.__inpFocused),
        inpVal: document.getElementById('edit-inp').value,
        ceVal: document.getElementById('edit-ce').innerText.trim(),
        cbChecked: document.getElementById('agree-cb').checked,
        swChecked: document.getElementById('role-sw').getAttribute('aria-checked'),
        bottomHit: window.__bottomHit,
        batchOk: window.__batchOk,
        keys: window.__keyLog
      })`,
    });
    assert.equal(stateCheck.result.dbl, 1);
    assert.equal(stateCheck.result.focused, true);
    assert.equal(stateCheck.result.inpVal, 'batch-done');
    assert.equal(stateCheck.result.ceVal, 'ce-updated');
    assert.equal(stateCheck.result.cbChecked, false);
    assert.equal(stateCheck.result.swChecked, 'true');
    assert.equal(stateCheck.result.bottomHit, true);
    assert.equal(stateCheck.result.batchOk, true);
    assert.ok(stateCheck.result.keys.includes('Backspace'));

    await actFast(page, { action: 'click', selector: '#next-route' });
    const waitUrl = await actFast(page, { action: 'wait', url: '/interactions-done', timeoutMs: 3000 });
    const waitLoad = await actFast(page, { action: 'wait', loadState: 'networkidle', timeoutMs: 3000 });
    assert.equal(waitUrl.ok, true);
    assert.equal(waitLoad.ok, true);
  });

  it('manages tab back/forward/reload, popup auto-registration, activate/close focus handoff, and media/motion/UA emulation', async () => {
    const opened = await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/nav-1`, waitUntil: 'networkidle' }]);
    const mainTabId = opened.activeTabId;

    await manager.tabsBatch([{ action: 'navigate', tabId: mainTabId, url: `${baseUrl}/nav-2`, waitUntil: 'networkidle' }]);
    const { page: mainPage } = await manager.getPage(mainTabId);
    const hit1 = Number((await evaluateJs(mainPage, { expression: 'document.getElementById("hit-count").textContent' })).result);

    const reloadRes = await manager.tabsBatch([{ action: 'reload', tabId: mainTabId, waitUntil: 'networkidle' }]);
    assert.equal(reloadRes.results[0].action, 'reload');
    const hit2 = Number((await evaluateJs(mainPage, { expression: 'document.getElementById("hit-count").textContent' })).result);
    assert.ok(hit2 > hit1, 'reload should increment server visit count');

    const backRes = await manager.tabsBatch([{ action: 'back', tabId: mainTabId, waitUntil: 'domcontentloaded' }]);
    assert.ok(backRes.results[0].url.endsWith('/nav-1'));

    const fwdRes = await manager.tabsBatch([{ action: 'forward', tabId: mainTabId, waitUntil: 'domcontentloaded' }]);
    assert.ok(fwdRes.results[0].url.endsWith('/nav-2'));

    await manager.tabsBatch([{ action: 'back', tabId: mainTabId, waitUntil: 'domcontentloaded' }]);
    await manager.tabsBatch([
      {
        action: 'emulate',
        tabId: mainTabId,
        media: 'print',
        reducedMotion: 'reduce',
        viewport: { width: 820, height: 640 },
        userAgent: 'TurboAgent/1.0',
      },
    ]);
    const emuState = await evaluateJs(mainPage, {
      expression: `() => ({
        printMedia: matchMedia('print').matches,
        reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
        width: window.innerWidth,
        ua: navigator.userAgent
      })`,
    });
    assert.deepEqual(emuState.result, {
      printMedia: true,
      reduced: true,
      width: 820,
      ua: 'TurboAgent/1.0',
    });

    await actFast(mainPage, { action: 'click', selector: '#open-popup' });
    let listRes;
    for (let i = 0; i < 20; i++) {
      listRes = await manager.tabsBatch([{ action: 'list' }]);
      if (listRes.tabs.some((t) => t.url.includes('/popup'))) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const popupTab = listRes.tabs.find((t) => t.url.includes('/popup'));
    assert.ok(popupTab, 'window.open popup tab must be registered automatically');

    const { page: popupPage } = await manager.getPage(popupTab.tabId);
    await popupPage.waitForLoadState('domcontentloaded');
    await actFast(popupPage, { action: 'click', selector: '#popup-ping' });
    const pingState = await evaluateJs(popupPage, { expression: 'window.__popPing' });
    assert.equal(pingState.result, true);

    await manager.tabsBatch([{ action: 'activate', tabId: mainTabId }]);
    const afterAct = await manager.tabsBatch([{ action: 'list' }]);
    assert.equal(afterAct.activeTabId, mainTabId);

    const closePopup = await manager.tabsBatch([{ action: 'close', tabId: popupTab.tabId }]);
    assert.equal(closePopup.tabs.some((t) => t.tabId === popupTab.tabId), false);
    assert.equal(closePopup.activeTabId, mainTabId);
  });

  it('persists/restores storageState into isolatedContext, manages sessionStorage, blocks no-images/no-media, and inspects deep diagnostics', async () => {
    const tmpState = path.join(os.tmpdir(), `tbm-iso-state-${Date.now()}.json`);
    try {
      const opened = await manager.tabsBatch([{ action: 'open', url: `${baseUrl}/session`, waitUntil: 'networkidle' }]);
      const tabId = opened.activeTabId;
      const { page } = await manager.getPage(tabId);

      await manager.getDiagnostics(tabId, { dialogPolicy: { action: 'accept' } });
      await new Promise((r) => setTimeout(r, 80));
      await actFast(page, { action: 'click', selector: '#confirm-btn' });
      await actFast(page, { action: 'click', selector: '#post-big' });
      await actFast(page, { action: 'wait', ms: 120 });

      const diag = await manager.getDiagnostics(tabId, { statusFilter: 'all' });
      assert.ok(diag.console.some((c) => c.level === 'pageerror' && c.text.includes('Unhandled boom 789')));
      assert.ok(diag.dialogs.some((d) => d.type === 'confirm' && d.actionTaken === 'accepted'));

      const bigReq = diag.requests.find((r) => r.url.includes('/api/large-echo'));
      assert.ok(bigReq);

      const reqHdrs = await manager.getDiagnostics(tabId, { reqId: bigReq.reqId, part: 'request-headers' });
      assert.equal(reqHdrs.data['x-custom-hdr'], 'turbo-hdr');
      const reqBody = await manager.getDiagnostics(tabId, { reqId: bigReq.reqId, part: 'request-body' });
      assert.ok(reqBody.data.includes('long-data'));
      const respHdrs = await manager.getDiagnostics(tabId, { reqId: bigReq.reqId, part: 'response-headers' });
      assert.equal(respHdrs.data['x-reply-tag'], 'turbo-large');
      const truncBody = await manager.getDiagnostics(tabId, { reqId: bigReq.reqId, maxBodyChars: 120 });
      assert.equal(truncBody.request.bodyTruncated, true);
      assert.ok(truncBody.request.responseBody.length <= 120);

      await manager.manageNetworkSession(tabId, {
        cookieAction: 'set',
        cookies: [{ name: 'persist_sid', value: 'v4-secret' }],
        storageAction: 'set',
        storageType: 'both',
        items: { authUser: 'tthanh2k6' },
        saveStorageStatePath: tmpState,
      });

      const bothRead = await manager.manageNetworkSession(tabId, { storageAction: 'get', storageType: 'both' });
      assert.equal(bothRead.storage.local.authUser, 'tthanh2k6');
      assert.equal(bothRead.storage.session.authUser, 'tthanh2k6');

      await manager.manageNetworkSession(tabId, { storageAction: 'clear', storageType: 'session' });
      const afterClearSession = await manager.manageNetworkSession(tabId, { storageAction: 'get', storageType: 'both' });
      assert.equal(afterClearSession.storage.local.authUser, 'tthanh2k6');
      assert.equal(afterClearSession.storage.session.authUser, undefined);

      // Restore storageState into a fresh isolatedContext tab
      const isoOpened = await manager.tabsBatch([
        { action: 'open', url: `${baseUrl}/session`, isolatedContext: 'restored-iso', waitUntil: 'networkidle' },
      ]);
      const isoTabId = isoOpened.activeTabId;
      await manager.manageNetworkSession(isoTabId, { loadStorageStatePath: tmpState });
      const isoCookies = await manager.manageNetworkSession(isoTabId, {
        cookieAction: 'get',
        storageAction: 'get',
        storageType: 'local',
      });
      assert.ok(isoCookies.cookies.some((c) => c.name === 'persist_sid' && c.value === 'v4-secret'));
      assert.equal(isoCookies.storage.local.authUser, 'tthanh2k6');

      // Test no-images and no-media presets
      const noImgRes = await manager.manageNetworkSession(isoTabId, { preset: 'no-images' });
      assert.equal(noImgRes.presetApplied, 'no-images');
      const { page: isoPage } = await manager.getPage(isoTabId);
      const imgBlocked = await evaluateJs(isoPage, {
        expression: `async () => new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve('loaded');
          img.onerror = () => resolve('blocked');
          img.src = '/pixel.png?ni=' + Date.now();
        })`,
      });
      assert.equal(imgBlocked.result, 'blocked');

      const noMediaRes = await manager.manageNetworkSession(isoTabId, { preset: 'no-media' });
      assert.equal(noMediaRes.presetApplied, 'no-media');
      assert.ok(noMediaRes.blockedResources.includes('media'));
    } finally {
      if (fs.existsSync(tmpState)) fs.unlinkSync(tmpState);
    }
  });

  it('captures element screenshots by selector/ref, jpeg quality, fullPage, and returnImage=false', async () => {
    const tmpEl = path.join(os.tmpdir(), `tbm-el-${Date.now()}.png`);
    const tmpJpg = path.join(os.tmpdir(), `tbm-jpg-${Date.now()}.jpg`);
    const tmpFull = path.join(os.tmpdir(), `tbm-full-${Date.now()}.png`);
    try {
      const opened = await manager.tabsBatch([
        { action: 'open', url: `${baseUrl}/capture`, isolatedContext: 'capture', waitUntil: 'networkidle' },
      ]);
      const { page } = await manager.getPage(opened.activeTabId);

      const elShot = await capturePage(page, { selector: '#card-box', savePath: tmpEl, returnImage: false });
      assert.equal(elShot.ok, true);
      assert.equal(elShot.base64, undefined);
      assert.ok(fs.existsSync(tmpEl));

      const snap = await inspectCompact(page, { mode: 'interactive' });
      const refMatch = /\[(f0:e\d+)\]\s+<button>\s+"Ref Capture Target"/.exec(snap.text);
      assert.ok(refMatch, 'should locate button ref for capturePage');

      const boxSnap = await capturePage(page, {
        ref: refMatch[1],
        type: 'jpeg',
        quality: 60,
        returnImage: false,
        savePath: tmpJpg,
      });
      assert.equal(boxSnap.mimeType, 'image/jpeg');
      assert.equal(boxSnap.base64, undefined);
      const jpgHeader = fs.readFileSync(tmpJpg).subarray(0, 2);
      assert.deepEqual([...jpgHeader], [0xff, 0xd8], 'should write valid JPEG magic bytes');

      const fullShot = await capturePage(page, { fullPage: true, savePath: tmpFull, returnImage: false });
      assert.ok(fullShot.bytes > elShot.bytes);
      assert.ok(fs.existsSync(tmpFull));
    } finally {
      for (const f of [tmpEl, tmpJpg, tmpFull]) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    }
  });
});
