// Night 19-11: a <script> sibling before an unlabeled field must not become the field's label (the-internet /upload).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { dispatchToolCall } from '../src/index.mjs';

describe('night 19-11 script label', () => {
  let m;
  before(async () => {
    m = new BrowserManager({ mode: 'launch', headless: true });
    await dispatchToolCall(m, 'tabs_batch', { operations: [{ action: 'open', url: 'about:blank' }] });
    const { page } = await m.getPage();
    await page.setContent(`
      <div class="example">
        <script>$('.dz-success-mark').remove();</script>
        <form><input id="file-upload" type="file" name="file"><br>
        <input id="file-submit" type="submit" value="Upload"></form>
      </div>
      <div><span>Nickname</span><input name="nick"></div>`);
  });
  after(async () => { await m?.close().catch(() => {}); });

  it('never shows script source as a label, keeps real sibling text', async () => {
    const out = (await dispatchToolCall(m, 'inspect_compact', { mode: 'forms' })).text;
    assert.doesNotMatch(out, /dz-success-mark/, out);
    assert.match(out, /<input:text> "Nickname"/, out);
  });
});
