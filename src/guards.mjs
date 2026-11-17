import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Commit-safety helpers added after Show HN / dev.to feedback (v0.5.0):
 *  - network commit guard: while allowSubmit=false, block outgoing commit-like requests
 *    (non-GET navigations and same-site fetch/XHR writes) no matter which button label triggered them;
 *  - submit evidence: after an allowed submit, prove it registered (URL / text / selector on the next state);
 *  - submission ledger: refuse to re-submit the same submissionKey (a re-run is a second entry, not a retry);
 *  - wait_for_human: hand a step (login, bot check) to a human and resume in the same session.
 * Nothing here tries to hide automation or evade bot detection.
 */

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const GUARDED_RESOURCE_TYPES = new Set(['document', 'xhr', 'fetch']);

function toRegex(pattern) {
  const raw = String(pattern ?? '');
  // 'u' rejects common non-unicode escapes such as \_ or \-, so fall back to plain 'i' before escaping.
  for (const flags of ['iu', 'i']) {
    try {
      return new RegExp(raw, flags);
    } catch {}
  }
  return new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Explicit parameter wins; otherwise TURBO_BROWSER_NETWORK_GUARD=true enables the guard. */
export function resolveNetworkGuard(explicitVal) {
  return explicitVal !== undefined
    ? Boolean(explicitVal)
    : process.env.TURBO_BROWSER_NETWORK_GUARD === 'true';
}

export function collectAllowPatterns(list) {
  const fromParam = Array.isArray(list) ? list : list ? [list] : [];
  const fromEnv = String(process.env.TURBO_BROWSER_NETWORK_GUARD_ALLOW || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...fromParam.map(String), ...fromEnv].filter(Boolean).map(toRegex);
}

function siteKey(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host || /^[\d.]+$/.test(host) || host.includes(':')) return host;
  const parts = host.split('.');
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

/**
 * Decide whether a request looks like a commit while allowSubmit=false.
 * Exported for unit tests.
 */
export function isCommitLikeRequest({ method, resourceType, url, pageUrl, isNavigation }, allowRegexes = []) {
  const m = String(method || 'GET').toUpperCase();
  if (!WRITE_METHODS.has(m)) return false;
  const type = String(resourceType || '');
  if (!GUARDED_RESOURCE_TYPES.has(type) && !isNavigation) return false;
  const target = String(url || '');
  if (allowRegexes.some((re) => re.test(target))) return false;
  if (type === 'document' || isNavigation) return true;
  try {
    const reqHost = new URL(target).hostname;
    const pageHost = new URL(String(pageUrl || '')).hostname;
    return siteKey(reqHost) === siteKey(pageHost);
  } catch {
    return true;
  }
}

/**
 * Install a temporary page route that blocks commit-like requests. Uses route.fallback() for
 * everything else so existing network_session routes keep working.
 */
export async function installNetworkGuard(page, { allow, settleMs } = {}) {
  const allowRegexes = collectAllowPatterns(allow);
  const blocked = [];
  const settle = clampInt(settleMs, 250, 0, 5000);
  const handler = async (route) => {
    const req = route.request();
    let isNavigation = false;
    try {
      isNavigation = req.isNavigationRequest();
    } catch {}
    const info = {
      method: req.method(),
      resourceType: req.resourceType(),
      url: req.url(),
      pageUrl: page.url(),
      isNavigation,
    };
    if (isCommitLikeRequest(info, allowRegexes)) {
      blocked.push({ method: info.method, resourceType: info.resourceType, url: info.url.slice(0, 300) });
      if (info.resourceType === 'document' || isNavigation) {
        // 204 keeps the current document (and the human's half-filled form) instead of an error page.
        await route.fulfill({ status: 204, body: '' }).catch(() => {});
      } else {
        await route.abort('blockedbyclient').catch(() => {});
      }
      return;
    }
    await route.fallback().catch(() => {});
  };
  await page.route('**/*', handler);
  return {
    blocked,
    async settle() {
      if (settle > 0) await sleep(settle);
    },
    // Shorter wait between batch steps so a request fired by step N is attributed to step N.
    async settleStep() {
      if (settle > 0) await sleep(Math.min(settle, 120));
    },
    async remove() {
      await page.unroute('**/*', handler).catch(() => {});
    },
  };
}

export function describeNetworkBlock(blocked) {
  const first = blocked[0];
  const more = blocked.length > 1 ? ` (+${blocked.length - 1} more)` : '';
  return `Submit guard (network): allowSubmit=false blocked outgoing ${first.method} ${first.resourceType} request to ${first.url}${more}.`;
}

async function frameTexts(page) {
  const out = [];
  for (const frame of page.frames()) {
    try {
      const txt = await frame.evaluate(() => (document.body ? document.body.innerText : ''));
      if (txt) out.push(String(txt).slice(0, 200000));
    } catch {}
  }
  return out;
}

function textNewNeedles(textNew) {
  return String(textNew).split('|').map((x) => x.trim().toLowerCase()).filter(Boolean);
}

// In-page scan shared by arm (init=true: remember every element already showing the text) and check.
function textNewScan([ns, k, init]) {
  // After a full navigation the remembered set is gone: everything on the new page counts as new.
  const seen = init ? (window[k] = new WeakSet()) : window[k] || new WeakSet();
  for (const el of document.querySelectorAll('body *')) {
    let own = '';
    for (const n of el.childNodes) if (n.nodeType === 3) own += n.nodeValue + ' ';
    own = own.toLowerCase();
    const hit = ns.find((x) => own.includes(x));
    if (!hit) continue;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0) || getComputedStyle(el).visibility === 'hidden') continue;
    if (init) seen.add(el);
    else if (!seen.has(el)) return hit;
  }
  return '';
}

/** expect.textNew: remember what already matches before the click, so only new text counts as evidence. */
export async function armTextNew(page, textNew) {
  const key = '__tbmEN' + Math.random().toString(36).slice(2);
  const ns = textNewNeedles(textNew);
  await Promise.all(page.frames().map((f) => f.evaluate(textNewScan, [ns, key, true]).catch(() => '')));
  return key;
}

async function textNewHit(page, textNew, key) {
  const ns = textNewNeedles(textNew);
  for (const f of page.frames()) {
    const hit = await f.evaluate(textNewScan, [ns, key, false]).catch(() => '');
    if (hit) return hit;
  }
  return '';
}

async function disarmTextNew(page, key) {
  await Promise.all(page.frames().map((f) => f.evaluate((k) => { delete window[k]; }, key).catch(() => {})));
}

async function selectorVisible(page, selector) {
  for (const frame of page.frames()) {
    try {
      if (await frame.locator(selector).first().isVisible()) return true;
    } catch {}
  }
  return false;
}

function snippetAround(text, re) {
  const m = re.exec(text);
  if (!m) return '';
  const start = Math.max(0, m.index - 60);
  return text.slice(start, Math.min(text.length, m.index + m[0].length + 60)).replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Check conditions once. Returns { type, value } for the first condition that holds, else null.
 * conditions: { urlMatches, textMatches, selector, textGone }
 */
export async function checkConditions(page, conditions = {}, textNewKey = '') {
  const url = page.url();
  if (conditions.urlMatches && toRegex(conditions.urlMatches).test(url)) {
    return { type: 'url', value: url };
  }
  if (conditions.selector && (await selectorVisible(page, String(conditions.selector)))) {
    return { type: 'selector', value: String(conditions.selector) };
  }
  if (conditions.textNew && textNewKey) {
    const hit = await textNewHit(page, conditions.textNew, textNewKey);
    if (hit) return { type: 'textNew', value: hit };
  }
  if (conditions.textMatches || conditions.textGone) {
    const texts = await frameTexts(page);
    if (conditions.textMatches) {
      const re = toRegex(conditions.textMatches);
      for (const t of texts) {
        if (re.test(t)) return { type: 'text', value: snippetAround(t, toRegex(conditions.textMatches)) };
      }
    }
    if (conditions.textGone) {
      const re = toRegex(conditions.textGone);
      if (!texts.some((t) => re.test(t))) return { type: 'textGone', value: String(conditions.textGone) };
    }
  }
  return null;
}

export function hasAnyCondition(c) {
  return Boolean(c && (c.urlMatches || c.textMatches || c.textNew || c.selector || c.textGone));
}

async function pollConditions(page, conditions, timeoutMs, pollMs, textNewKey = '') {
  const t0 = Date.now();
  while (true) {
    let hit = null;
    try {
      hit = await checkConditions(page, conditions, textNewKey);
    } catch {}
    if (hit) return { hit, waitedMs: Date.now() - t0 };
    if (Date.now() - t0 >= timeoutMs) return { hit: null, waitedMs: Date.now() - t0 };
    await sleep(pollMs);
  }
}

// Client-side validation that stopped a submit: browser messages of invalid fields, aria-invalid fields with their
// described-by text, and visible alerts, each with the field label. [] when nothing is showing.
async function visibleValidation(page) {
  try {
    return await Promise.race([
      page.mainFrame().evaluate(() => {
        const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
        const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
        const labelOf = (e) => clean(e.getAttribute('aria-label') || [...(e.labels || [])].map((l) => l.innerText).join(' ') || e.placeholder || e.name || e.id).slice(0, 40);
        const out = [];
        const seen = new Set();
        const add = (field, message) => {
          const m = clean(message).slice(0, 160);
          if (!m || seen.has(field + m) || out.length >= 5) return;
          seen.add(field + m);
          out.push(field ? { field, message: m } : { message: m });
        };
        for (const e of document.querySelectorAll('input, textarea, select')) {
          if (!shown(e)) continue;
          const byAria = e.getAttribute('aria-invalid') === 'true'
            ? clean((e.getAttribute('aria-describedby') || e.getAttribute('aria-errormessage') || '').split(' ').map((id) => document.getElementById(id)?.innerText || '').join(' '))
            : '';
          if (byAria) add(labelOf(e), byAria);
          else if (e.matches(':invalid') && e.validationMessage) add(labelOf(e), e.validationMessage);
        }
        for (const e of document.querySelectorAll('[role="alert"], .error, .invalid-feedback, [class*="error-message" i]')) {
          if (shown(e) && clean(e.innerText).length < 200) add('', e.innerText);
        }
        return out;
      }),
      new Promise((r) => setTimeout(() => r([]), 1500)),
    ]);
  } catch {
    return [];
  }
}

/**
 * After an allowed submit, wait for evidence that the submission registered.
 * "The click landed" is not success: only a URL / text / element on the resulting state counts.
 */
export async function waitForSubmitEvidence(page, expect = {}, textNewKey = '') {
  if (!hasAnyCondition(expect)) {
    throw new Error('expect requires at least one of urlMatches, textMatches, textNew, selector.');
  }
  const timeoutMs = clampInt(expect.timeoutMs, 8000, 100, 120000);
  let hit, waitedMs;
  try {
    ({ hit, waitedMs } = await pollConditions(page, expect, timeoutMs, 150, textNewKey));
  } finally {
    if (textNewKey) await disarmTextNew(page, textNewKey);
  }
  if (hit) {
    return { submitVerified: true, evidence: { type: hit.type, value: hit.value }, verifyMs: waitedMs };
  }
  const validation = await visibleValidation(page);
  return {
    submitVerified: false,
    evidence: null,
    verifyMs: waitedMs,
    ...(validation.length ? { validation } : {}),
    verifyReason: `No submit evidence within ${timeoutMs} ms (url=${page.url()}). Treat the submission as NOT confirmed; check before retrying.`,
  };
}

// ---------- submission ledger ----------

export function defaultLedgerPath() {
  if (process.env.TURBO_BROWSER_LEDGER) return path.resolve(process.env.TURBO_BROWSER_LEDGER);
  return path.join(os.homedir(), '.turbo-browser-mcp', 'submissions.jsonl');
}

export function readLedger(ledgerPath) {
  let raw = '';
  try {
    raw = fs.readFileSync(ledgerPath, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

export function findLedgerEntry(ledgerPath, key) {
  const entries = readLedger(ledgerPath).filter((e) => e && e.key === key);
  return entries.length > 0 ? entries[entries.length - 1] : null;
}

export function appendLedger(ledgerPath, entry) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

// ---------- human handoff ----------

/**
 * Pause the agent until a human finishes a step in the visible browser (login, bot check, 2FA),
 * then resume in the same tab with the same cookies. It only waits; it never solves or bypasses checks.
 */
export async function waitForHuman(page, params = {}) {
  if (!hasAnyCondition(params)) {
    throw new Error('wait_for_human requires at least one of urlMatches, selector, textMatches, textGone.');
  }
  const timeoutMs = clampInt(params.timeoutMs, 120000, 1000, 1800000);
  const pollMs = clampInt(params.pollMs, 500, 100, 5000);
  const message = String(params.message || 'Finish this step in the browser window; the agent resumes automatically.');
  process.stderr.write(`[turbo-browser-mcp] wait_for_human: ${message}\n`);
  if (params.bringToFront !== false) {
    await page.bringToFront().catch(() => {});
  }
  const { hit, waitedMs } = await pollConditions(page, params, timeoutMs, pollMs);
  if (hit) {
    return { ok: true, matched: hit.type, evidence: hit.value, url: page.url(), waitedMs };
  }
  return {
    ok: false,
    timedOut: true,
    url: page.url(),
    waitedMs,
    message,
    hint: 'Condition not met yet. Call wait_for_human again to keep waiting, or ask the human what happened.',
  };
}
