import assert from 'node:assert/strict';
import { before, after, it } from 'node:test';
import { BrowserManager } from '../src/browser-manager.mjs';
import { smartFillForm } from '../src/dom-engine.mjs';

// Like the existing suites, fixtures are local HTML pages served via setContent.
function selectFixture({ searchable = false, windowed = false, inert = false } = {}) {
  return `<!doctype html><form><label>Region
    ${searchable ? '<input id="combo" role="combobox"' : '<button type="button" id="combo" role="combobox"'}
    aria-label="Region" aria-expanded="false" aria-controls="options">${searchable ? '' : 'Choose region</button>'}
    </label><input type="hidden" name="region" id="committed"></form>
    <script>(() => {
      const combo = document.querySelector('#combo');
      const values = Array.from({length: 200}, (_, i) => 'Region ' + i);
      let filtered = values, active = -1;
      function choose(value) {
        if (${inert}) return;
        committed.value = value;
        combo.dataset.value = value;
        if (combo.tagName === 'INPUT') combo.value = '';
        else combo.textContent = value;
        combo.setAttribute('aria-expanded', 'false');
        document.querySelector('#options')?.remove();
      }
      function render() {
        document.querySelector('#options')?.remove();
        const list = document.createElement('div'); list.id = 'options'; list.role = 'listbox';
        const start = ${windowed} ? Math.max(0, active - 10) : 0;
        filtered.slice(start, ${windowed} ? start + 20 : filtered.length).forEach((value, offset) => {
          const option = document.createElement('div'); option.role = 'option';
          option.id = 'option-' + (start + offset); option.textContent = value;
          option.onclick = () => choose(value); list.append(option);
        });
        document.body.append(list); combo.setAttribute('aria-expanded', 'true');
      }
      combo.onfocus = render;
      combo.onclick = () => { if (!document.querySelector('#options')) render(); };
      combo.oninput = () => { filtered = values.filter(v => v === combo.value); active = -1; render(); };
      combo.onkeydown = e => {
        if (e.key === 'ArrowDown') {
          e.preventDefault(); active = Math.min(active + 1, filtered.length - 1); render();
          combo.setAttribute('aria-activedescendant', 'option-' + active);
        }
        if (e.key === 'Enter') { e.preventDefault(); if (active >= 0) choose(filtered[active]); }
      };
    })();</script>`;
}

let manager, page;
before(async () => {
  manager = new BrowserManager({ mode: 'launch', headless: true });
  ({ page } = await manager.getPage());
});
after(async () => { await manager?.close(); });

for (const [name, options, value] of [
  ['react-select focus portal', { searchable: true }, 'Region 8'],
  ['Radix button portal', {}, 'Region 9'],
  ['filtered virtual list', { searchable: true, windowed: true }, 'Region 150'],
  ['keyboard windowed list', { windowed: true }, 'Region 50'],
]) {
  it(name + ' commits the selected value', async () => {
    await page.setContent(selectFixture(options));
    const result = await smartFillForm(page, { fields: [{ selector: '#combo', value }] });
    assert.equal(await page.locator('#committed').inputValue(), value);
    assert.equal(result.filled.length, 1);
  });
}
it('does not report a typed query or uncommitted Enter as success', async () => {
  await page.setContent(selectFixture({ searchable: true, windowed: true, inert: true }));
  const result = await smartFillForm(page, { fields: [{ selector: '#combo', value: 'Region 150' }] });
  assert.equal(await page.locator('#committed').inputValue(), '');
  assert.equal(result.filled.length, 0);
});
it('bounds keyboard navigation when an option is missing', async () => {
  await page.setContent(selectFixture({ windowed: true }));
  const result = await smartFillForm(page, { fields: [{ selector: '#combo', value: 'Missing' }] });
  assert.equal(await page.locator('#committed').inputValue(), '');
  assert.equal(result.filled.length, 0);
});
