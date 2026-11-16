import assert from 'node:assert/strict';
import { before, after, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { smartFillForm } from '../src/dom-engine.mjs';

// The agent benchmark's application form: a button combobox opens a portal with its own search
// box (focused on open) and a paged list of 200 options, 20 at a time. The agent used to need three
// act_fast calls for it because smart_fill_form gave up without saying so.
const PAGE = `<!doctype html><form id="form"><input name="region" type="hidden">
<button id="picker" type="button" role="combobox" aria-label="Region" aria-expanded="false" aria-controls="options">Choose region</button>
</form><script>
picker.onclick = () => {
  if (document.querySelector('#portal')) return;
  picker.setAttribute('aria-expanded', 'true');
  const portal = document.createElement('div'); portal.id = 'portal';
  portal.innerHTML = '<label>Search regions <input id="search"></label><div role="listbox" id="options"></div><button type="button" id="more">More regions</button>';
  document.body.append(portal);
  let offset = 0; const search = portal.querySelector('input');
  function render() {
    const matches = Array.from({ length: 200 }, (_, i) => 'Region ' + (i + 1))
      .filter((x) => x.toLowerCase().includes(search.value.toLowerCase()));
    portal.querySelector('#options').replaceChildren(...matches.slice(offset, offset + 20).map((x) => {
      const b = document.createElement('button'); b.type = 'button'; b.role = 'option'; b.textContent = x;
      b.onclick = () => { form.elements.region.value = x; picker.textContent = x; picker.setAttribute('aria-expanded', 'false'); portal.remove(); };
      return b;
    }));
  }
  search.oninput = () => { offset = 0; render(); };
  portal.querySelector('#more').onclick = () => { offset += 20; render(); };
  render(); search.focus();
};
</script>`;

let manager, page;
before(async () => {
  manager = new BrowserManager({ mode: 'launch', headless: true });
  ({ page } = await manager.getPage());
});
after(async () => { await manager?.close(); });

it('picks an option beyond the first page through the portal search box', async () => {
  await page.setContent(PAGE);
  const result = await smartFillForm(page, { fields: [{ selector: '#picker', option: 'Region 150' }] });
  assert.equal(result.filledCount, 1);
  assert.equal(await page.inputValue('input[name="region"]'), 'Region 150');
  assert.equal(await page.textContent('#picker'), 'Region 150');
});

it('reports a combobox option it could not find instead of dropping it', async () => {
  await page.setContent(PAGE);
  const result = await smartFillForm(page, { fields: [{ selector: '#picker', option: 'Region 999' }] });
  assert.equal(result.filledCount, 0);
  const skip = result.skipped.find((s) => s.reason === 'combobox-option-not-found');
  assert.ok(skip, JSON.stringify(result.skipped));
  assert.equal(skip.wanted, 'Region 999');
  assert.equal(await page.inputValue('input[name="region"]'), '');
});
