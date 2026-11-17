// Round 18b: field-report items 7-16.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { dispatchToolCall } from '../src/index.mjs';

let web, port, m;
const call = async (name, args) => (await dispatchToolCall(m, name, args)).text;
const open = (p) => dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'open', url: `http://127.0.0.1:${port}${p}` }] });
const PAGES = {
  '/delta': '<title>D</title><button id="a">Alpha</button><button id="b">Beta</button>',
  '/loadmore': '<title>L</title><form onsubmit="return false"><button type="submit" id="lm">Load more</button></form>',
  '/switch': '<title>S</title><label id="lab"><input type="checkbox" id="cb" style="position:absolute;opacity:0;width:1px;height:1px"><span style="display:inline-block;width:40px;height:20px;background:#ccc">tok</span> Token A</label><span id="cover" style="position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:auto"></span>',
  '/modal': '<title>M</title><button id="bg">Sign out</button><div role="dialog" aria-modal="true" style="position:fixed;left:50%;top:20%;background:#fff;padding:20px"><p>Sure?</p><button id="ok" onclick="document.title=\'done\'">Sign out</button></div><div id="cover" style="position:fixed;inset:0;z-index:-1"></div>',
  '/lazy': '<title>Z</title><nav>menu links here</nav><script>fetch("/api/data");setTimeout(()=>{document.body.insertAdjacentHTML("beforeend","<main><ul>"+Array.from({length:40},(_,i)=>"<li>Variable number "+i+" with a value</li>").join("")+"</ul></main>")},1200)</script>',
  '/nomain': '<title>N</title><div><p>Rendered content without a main element, long enough to count as text for the extractor here.</p></div>',
  '/post': '<title>P</title><button id="go" onclick="fetch(\'/api/deploy\',{method:\'POST\',body:\'x\'}).then(()=>{})">Redeploy</button>',
  '/popup': '<title>Q</title><a href="#r1">row one link</a><a href="#r2">row two link</a><div role="dialog" aria-modal="true"><button>Confirm popup</button></div>',
};
before(async () => {
  web = http.createServer((req, res) => {
    if (req.method === 'POST') { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":"challenge_required"}'); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html>${PAGES[req.url.split('?')[0]] || ''}`);
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  port = web.address().port;
  m = new BrowserManager({ mode: 'launch', headless: true });
});
after(async () => { await m?.close().catch(() => {}); await new Promise((r) => web.close(r)); });

describe('round 18b', () => {
  it('10: onlyChanged marks rows added by evaluate_js with *', async () => {
    await open('/delta');
    await call('inspect_compact', {});
    await call('evaluate_js', { expression: "document.body.insertAdjacentHTML('beforeend','<button id=c>Gamma</button>')" });
    const out = await call('inspect_compact', { onlyChanged: true });
    assert.match(out, /\*\[f0:e\d+\] <button> "Gamma"/, out);
    assert.ok(!/Alpha/.test(out), out);
  });

  it('10b: onlyChanged without an earlier full snapshot says why nothing is marked', async () => {
    await open('/delta');
    await call('inspect_compact', { query: 'Alpha' });
    const out = await call('inspect_compact', { onlyChanged: true });
    assert.match(out, /No earlier full snapshot/, out);
  });

  it('7: a submit-type "Load more" button is not blocked by the submit guard', async () => {
    await open('/loadmore');
    const out = await call('act_fast', { action: 'click', text: 'Load more' });
    assert.ok(!/blocked|Submit guard/i.test(out), out);
  });

  it('8: check falls back to the label when a styled span covers the input', async () => {
    await open('/switch');
    const out = await call('act_fast', { action: 'check', selector: '#cb' }).catch((e) => `ERR ${e.message}`);
    const checked = await (await m.getPage()).page.evaluate(() => document.getElementById('cb').checked);
    assert.equal(checked, true, out);
  });

  it('11: text targeting prefers the open modal over an identical label behind it', async () => {
    await open('/modal');
    await call('act_fast', { action: 'click', text: 'Sign out' });
    assert.equal(await (await m.getPage()).page.title(), 'done');
  });

  it('9: extract right after load waits for a lazy list', async () => {
    await open('/lazy');
    await new Promise((r) => setTimeout(r, 300)); // the first fetch has finished by now
    const out = await call('extract_clean_text', {});
    assert.match(out, /Variable number 39/, out.slice(0, 300));
  });

  it('14: extract with a selector that has no text falls back to the body', async () => {
    await open('/nomain');
    const out = await call('extract_clean_text', { selector: 'main' });
    assert.match(out, /Rendered content without a main element/, out);
    assert.match(out, /used the page body/, out);
  });

  it('15: with a modal popup open, the snapshot lists only the popup', async () => {
    await open('/popup');
    const out = await call('inspect_compact', {});
    assert.match(out, /Confirm popup/, out);
    assert.ok(!/row one link/.test(out), out);
  });

  it('16: aftermath carries the HTTP status of a mutating request and warns on a 4xx', async () => {
    await open('/post');
    const out = await call('act_fast', { action: 'click', text: 'Redeploy', observeAftermath: true });
    assert.match(out, /"status":\s*403|status.{0,4}403/, out);
    assert.match(out, /do not report success/, out);
  });
});
