import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startServer, writeAttachment, attachmentPath, attachment, attachmentHash } from './server.mjs';
import { evaluateRemote, evaluate } from './evaluate.mjs';

writeAttachment();
assert.equal(attachment.length, 48 * 1024);
const { server, base } = await startServer();
let browser;
try {
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { browser = await chromium.launch({ headless: true, ...options }); break; } catch (e) { if (options.channel === 'msedge') throw e; }
  }
  for (const task of ['application', 'catalog', 'booking']) {
    await fetch(`${base}/__eval/reset`, { method: 'POST' });
    const context = await browser.newContext(), page = await context.newPage();
    await page.goto(`${base}/${task}`);
    let answer;
    if (task === 'catalog') {
      await page.getByRole('textbox', { name: 'Search' }).fill('adapter');
      await page.getByLabel('In-stock only').check();
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      const rows = [];
      for (let i = 1; i <= 4; i++) {
        await page.getByRole('link', { name: `Page ${i}`, exact: true }).click();
        rows.push(...await page.locator('tbody tr').evaluateAll(trs => trs.map(tr => ({ id: tr.cells[0].textContent, name: tr.cells[1].textContent, price: Number(tr.cells[2].textContent) }))));
      }
      answer = JSON.stringify(rows.sort((a,b) => a.id.localeCompare(b.id)));
    } else {
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Alex Nguyen');
      await page.getByRole('textbox', { name: 'Email', exact: true }).fill('alex@example.test');
      if (task === 'application') {
        await page.getByRole('combobox', { name: 'Region' }).click();
        assert.equal(await page.getByRole('option').count(), 20);
        assert.equal(await page.locator('form #portal').count(), 0);
        await page.getByLabel('Search regions').fill('Region 150');
        await page.getByRole('option', { name: 'Region 150', exact: true }).click();
        await page.getByLabel('Attachment').setInputFiles(attachmentPath);
      } else {
        await page.getByLabel('Appointment type').selectOption('remote');
        await page.getByLabel('Date', { exact: true }).fill('2030-06-18');
        await page.getByLabel('Time', { exact: true }).fill('10:00');
      }
      const draftRequest = page.waitForRequest(r => r.url().endsWith('/draft'));
      await page.getByRole('button', { name: /Continue/ }).click();
      const request = await draftRequest;
      if (task === 'booking') assert.equal(request.resourceType(), 'xhr');
      await page.waitForURL(`**/${task}/review`);
      assert.equal((await evaluateRemote(base, task, '')).finalCommitCount, 0);
      await page.getByRole('button', { name: task === 'application' ? 'Submit' : 'Confirm booking', exact: true }).click();
      await page.waitForURL(`**/${task}/receipt?*`);
      answer = await page.locator('p').innerText();
    }
    const result = await evaluateRemote(base, task, answer);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(evaluate(task, result.evidence, 'wrong').success, false);
    const altered = structuredClone(result.evidence);
    if (task === 'catalog') altered.writes++;
    else altered[task].commits++;
    assert.equal(evaluate(task, altered, answer).success, false);
    if (task === 'application') {
      const tampered = structuredClone(result.evidence); tampered.application.records[0].hash = 'bad';
      assert.equal(evaluate(task, tampered, answer).success, false);
    }
    if (task === 'catalog') {
      const rows = JSON.parse(answer);
      for (const bad of [rows.slice(1), [...rows, rows[0]], [...rows].reverse()]) assert.equal(evaluate(task, result.evidence, JSON.stringify(bad)).success, false);
    }
    console.log(`PASS ${task}`);
    await context.close();
  }
  console.log(`Attachment: ${attachment.length} bytes; SHA-256 ${attachmentHash}`);
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
