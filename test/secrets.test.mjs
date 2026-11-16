// Secret placeholders: $secret:NAME values are typed for real but never appear in any tool result.
// The secrets file is a temp file created here (never a .env file). Headless launch, local fixture only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { dispatchToolCall } from '../src/index.mjs';
import { parseDotenv, redactText } from '../src/secrets.mjs';

const PW = 'hunter2-Zq9!x"y';
const USER = 'agent.smith@example.test';
const TOKEN = 'tok_live_51Habcdef';

let dir, file, m, page;
const call = async (name, args) => (await dispatchToolCall(m, name, args)).text;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-secrets-'));
  file = path.join(dir, 'secrets.txt');
  fs.writeFileSync(
    file,
    [
      '# comment',
      `export SITE_USER=${USER}`,
      `SITE_PASSWORD="${PW.replace(/["\\]/g, '\\$&')}"`,
      `API_TOKEN='${TOKEN}'`,
      'SHORT=ab',
      '',
    ].join('\n')
  );
  process.env.TURBO_BROWSER_SECRETS_FILE = file;
  m = new BrowserManager({ mode: 'launch', headless: true });
  ({ page } = await m.getPage());
  await page.setContent(
    '<title>Login</title><form onsubmit="return false"><label>User <input id="u"></label>' +
      '<label>Password <input id="pw" type="password"></label><label>Token <input id="tok"></label>' +
      '<label>Short <input id="s" maxlength="3"></label><input id="ro" readonly value="x">' +
      '<button type="submit">Sign in</button></form><p id="note">Welcome</p>'
  );
});
after(async () => {
  delete process.env.TURBO_BROWSER_SECRETS_FILE;
  await m.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function assertClean(label, text) {
  for (const secret of [PW, USER, TOKEN, JSON.stringify(PW).slice(1, -1)]) {
    assert.ok(!String(text).includes(secret), `${label} leaked a secret: ${String(text).slice(0, 300)}`);
  }
}

describe('secrets file parsing', () => {
  it('reads KEY=value lines, comments, export, quotes and escapes', () => {
    const map = parseDotenv('# c\nA=1\nexport B = two # note\nC="a\\"b"\nD=\'x y\'\nbad line\n');
    assert.equal(map.get('A'), '1');
    assert.equal(map.get('B'), 'two');
    assert.equal(map.get('C'), 'a"b');
    assert.equal(map.get('D'), 'x y');
    assert.equal(map.size, 4);
  });
  it('the test secrets file parses to the intended values', () => {
    const map = parseDotenv(fs.readFileSync(file, 'utf8'));
    assert.equal(map.get('SITE_PASSWORD'), PW);
    assert.equal(map.get('SITE_USER'), USER);
    assert.equal(map.get('API_TOKEN'), TOKEN);
  });
  it('redactText replaces raw, JSON-escaped and URL-encoded forms, leaves values under 4 chars alone', () => {
    assert.equal(redactText(`a ${USER} b`), 'a $secret:SITE_USER b');
    assert.equal(redactText(JSON.stringify({ p: PW })), '{"p":"$secret:SITE_PASSWORD"}');
    assert.equal(redactText(`x=${encodeURIComponent(PW)}`), 'x=$secret:SITE_PASSWORD');
    assert.equal(redactText('about ab abc'), 'about ab abc');
  });
});

describe('secret placeholders in tool calls', () => {
  it('smart_fill_form types the real value and the result never contains it', async () => {
    const out = await call('smart_fill_form', {
      fields: [
        { selector: '#u', value: '$secret:SITE_USER' },
        { selector: '#pw', value: '$secret:SITE_PASSWORD' },
      ],
      returnSnapshot: true,
    });
    assert.equal(await page.inputValue('#u'), USER);
    assert.equal(await page.inputValue('#pw'), PW);
    assertClean('smart_fill_form', out);
  });

  it('act_fast fill and type use the secret; batch_actions fill steps too', async () => {
    const a = await call('act_fast', { action: 'fill', selector: '#tok', value: '$secret:API_TOKEN' });
    assert.equal(await page.inputValue('#tok'), TOKEN);
    assertClean('act_fast fill', a);
    await page.fill('#tok', '');
    const t = await call('act_fast', { action: 'type', selector: '#tok', value: '$secret:API_TOKEN' });
    assert.equal(await page.inputValue('#tok'), TOKEN);
    assertClean('act_fast type', t);
    await page.fill('#u', '');
    await page.fill('#pw', '');
    const b = await call('batch_actions', {
      steps: [
        { action: 'fill', selector: '#u', value: '$secret:SITE_USER' },
        { action: 'fill', selector: '#pw', value: '$secret:SITE_PASSWORD' },
      ],
      returnSnapshot: true,
      snapshotMode: 'forms',
    });
    assert.equal(await page.inputValue('#u'), USER);
    assert.equal(await page.inputValue('#pw'), PW);
    assertClean('batch_actions', b);
  });

  it('inspect_compact, extract_clean_text and evaluate_js show the placeholder, never the value', async () => {
    const snap = await call('inspect_compact', { mode: 'forms' });
    assertClean('inspect_compact forms', snap);
    const snapAll = await call('inspect_compact', { mode: 'all' });
    assertClean('inspect_compact all', snapAll);
    await page.evaluate((pw) => { document.querySelector('#note').textContent = `Your password is ${pw}`; }, PW);
    const ex = await call('extract_clean_text', {});
    assert.match(ex, /Your password is \$secret:SITE_PASSWORD/);
    assertClean('extract_clean_text', ex);
    const ev = await call('evaluate_js', { expression: "document.querySelector('#u').value + '|' + document.querySelector('#pw').value" });
    assertClean('evaluate_js', ev);
    assert.match(ev, /\$secret:SITE_USER\|\$secret:SITE_PASSWORD/);
    const ev2 = await call('evaluate_js', { expression: "JSON.stringify({p: document.querySelector('#pw').value})" });
    assertClean('evaluate_js JSON', ev2);
    const diag = await call('page_diagnostics', {});
    assertClean('page_diagnostics', diag);
  });

  it('a value rewritten by the page (maxlength) does not echo a prefix of the secret', async () => {
    const out = await call('act_fast', { action: 'fill', selector: '#s', value: '$secret:API_TOKEN' });
    assert.equal((await page.inputValue('#s')).length, 3);
    assert.ok(!/tok_/.test(out), out);
    assertClean('maxlength mismatch', out);
  });

  it('an unknown name fails with the key only, before anything is typed', async () => {
    await page.fill('#u', 'untouched');
    await assert.rejects(
      call('smart_fill_form', { fields: [{ selector: '#u', value: '$secret:NOPE' }] }),
      (err) => {
        assert.match(err.message, /Unknown secret: NOPE/);
        assertClean('unknown name error', err.message);
        return true;
      }
    );
    assert.equal(await page.inputValue('#u'), 'untouched');
  });

  it('errors raised while typing a secret do not contain it', async () => {
    await assert.rejects(call('act_fast', { action: 'fill', selector: '#ro', value: '$secret:SITE_PASSWORD', timeoutMs: 800 }), (err) => {
      assertClean('readonly error', err.message);
      return true;
    });
  });

  it('a value that is not exactly a placeholder is typed as written', async () => {
    await call('act_fast', { action: 'fill', selector: '#u', value: 'see $secret:SITE_USER' });
    assert.equal(await page.inputValue('#u'), 'see $secret:SITE_USER');
  });

  it('with no secrets file the output is identical and a placeholder is typed literally', async () => {
    const saved = process.env.TURBO_BROWSER_SECRETS_FILE;
    delete process.env.TURBO_BROWSER_SECRETS_FILE;
    try {
      const out = await call('act_fast', { action: 'fill', selector: '#u', value: '$secret:SITE_USER' });
      assert.equal(await page.inputValue('#u'), '$secret:SITE_USER');
      assert.ok(!out.includes(USER));
      await page.fill('#u', USER);
      const ev = await call('evaluate_js', { expression: "document.querySelector('#u').value" });
      assert.ok(ev.includes(USER), 'without a secrets file nothing is redacted');
    } finally {
      process.env.TURBO_BROWSER_SECRETS_FILE = saved;
    }
  });
});
