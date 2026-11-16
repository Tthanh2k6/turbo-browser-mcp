// New alert/status/toast text that appears after a click or key press (e.g. "This domain isn't allowed.").
// Cost: one tiny evaluate before and one after the action; nothing is added to the result unless a new message shows.
const probe = (promise, ms = 250) => Promise.race([promise, new Promise((r) => setTimeout(() => r(null), ms))]).catch(() => null);

// Runs in the page. Returns the first message that was not showing at the previous scan, or ''.
// The first scan of a document only records what is already there (init) and returns ''.
function scanToasts(init) {
  const SEL = '[role="alert"], [role="status"], [aria-live="assertive"], [class*="toast" i], [class*="snackbar" i], [data-testid*="toast" i]';
  const getSR = (n) => n?.shadowRoot || window.__tbmGetShadowRoot?.(n) || null;
  const found = [];
  const stack = [document];
  while (stack.length) {
    const cur = stack.shift();
    if (!cur) continue;
    const own = cur.nodeType === 1 ? getSR(cur) : null;
    if (own) stack.push(own);
    if (!cur.querySelectorAll) continue;
    try { found.push(...cur.querySelectorAll(SEL)); } catch { /* ignore */ }
    for (const n of cur.querySelectorAll('*')) { const s = getSR(n); if (s) stack.push(s); }
  }
  const texts = [];
  for (const el of found) {
    const txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!txt) continue;
    const r = el.getBoundingClientRect();
    let hidden = !(r.width > 0 && r.height > 0);
    try { const st = getComputedStyle(el); hidden = hidden || st.visibility === 'hidden' || st.display === 'none'; } catch { /* ignore */ }
    if (!hidden) texts.push(txt);
  }
  const prev = window.__tbmToastSeen;
  Object.defineProperty(window, '__tbmToastSeen', { value: new Set(texts), writable: true, configurable: true, enumerable: false });
  if (!prev || init) return '';
  return texts.find((t) => !prev.has(t)) || '';
}

/** Call before the action. */
export async function armToasts(page) {
  await probe(page.evaluate(() => (window.__tbmToastSeen ? true : null)).then((has) => (has ? null : page.evaluate(scanToasts, true))));
}

/** Call after the action settled. Returns the new message (max 120 chars) or ''. */
export async function takeToast(page) {
  const t = await probe(page.evaluate(scanToasts, false));
  return typeof t === 'string' ? t.slice(0, 120) : '';
}
