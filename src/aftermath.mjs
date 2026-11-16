// One settle step after an action: no fixed sleep. Resolves when the DOM has been quiet for
// QUIET_MS and no request younger than INFLIGHT_MS is pending, or at capMs. Listeners stay
// attached until remove() so a late request is still seen by the guards that share this page.
const QUIET_MS = 80, INFLIGHT_MS = 1500, POLL_MS = 20;
const IGNORED_RESOURCES = new Set(['websocket', 'eventsource', 'media', 'ping']);
// A JS dialog freezes page.evaluate; give up on the DOM probe instead of hanging the action.
const probe = (promise, ms = 250) => Promise.race([promise, new Promise((r) => setTimeout(() => r(null), ms))]).catch(() => null);
export function watchActivity(page) {
  const beforeUrl = page.url();
  const inflight = new Map();
  const onRequest = (r) => { if (!IGNORED_RESOURCES.has(r.resourceType())) inflight.set(r, Date.now()); };
  const onDone = (r) => { inflight.delete(r); };
  page.on('request', onRequest);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onDone);
  let startCount = null, changed = false, pendingMutations = false;
  // The baseline must survive a slow first evaluate (busy main thread): the probe below gives up
  // after 250 ms, but the evaluate keeps running and still reports the count from before the action.
  const installRaw = page.evaluate(() => {
    const w = window;
    if (!w.__tbmActivity) {
      const s = { last: performance.now(), n: 0 };
      new MutationObserver(() => { s.last = performance.now(); s.n++; })
        .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      Object.defineProperty(w, '__tbmActivity', { value: s, enumerable: false });
    }
    return w.__tbmActivity.n;
  }).then((n) => { if (typeof n === 'number') startCount = n; return n; }).catch(() => null);
  const install = probe(installRaw);
  const read = () => probe(page.evaluate(() => {
    const s = window.__tbmActivity;
    return s ? { quiet: performance.now() - s.last, n: s.n } : null;
  }));
  return {
    async settle({ minMs = 0, capMs = 800 } = {}) {
      await install;
      const start = Date.now();
      for (;;) {
        const elapsed = Date.now() - start;
        if (elapsed >= capMs) break;
        const st = await read();
        if (!st) changed = true; // new document (or mid-navigation): the old observer is gone
        else if (startCount !== null && st.n > startCount) changed = true;
        else if (startCount === null && st.n > 0) pendingMutations = true; // baseline reply not in yet
        const requestsQuiet = ![...inflight.values()].some((t) => Date.now() - t < INFLIGHT_MS);
        if (Date.now() - start >= minMs && requestsQuiet && (!st || st.quiet >= QUIET_MS)) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    },
    outcome() {
      if (page.url() !== beforeUrl) return 'navigated';
      // Baseline never arrived but the observer saw mutations: report them rather than 'none'.
      return changed || (startCount === null && pendingMutations) ? 'changed' : 'none';
    },
    remove() {
      page.off('request', onRequest);
      page.off('requestfinished', onDone);
      page.off('requestfailed', onDone);
    },
  };
}

// A navigation or mutating request that lands after a click already returned navigated:false is parked here
// (one line per page) and attached once to the next tool result on that tab.
const lateNotes = new WeakMap();
const LATE_MS = 2000;
export function takeLate(page) {
  const n = page && lateNotes.get(page);
  if (n) lateNotes.delete(page);
  return n || '';
}

// Observation only: this cannot undo a request or establish submission success.
export function observeClickAftermath(page) {
  const beforeUrl = page.url();
  const mutatingRequests = [];
  let navigated = false;
  const pathChanged = (url) => {
    try {
      const before = new URL(beforeUrl), after = new URL(url);
      return before.origin !== after.origin || before.pathname !== after.pathname;
    } catch { return url !== beforeUrl; }
  };
  const onNavigation = (frame) => {
    if (frame === page.mainFrame() && pathChanged(frame.url())) navigated = true;
  };
  const onRequest = (request) => {
    const method = request.method();
    if (!/^(POST|PUT|PATCH|DELETE)$/.test(method) || !['fetch', 'xhr'].includes(request.resourceType())) return;
    const url = request.url();
    let pathname = '';
    try { pathname = new URL(url).pathname; } catch {}
    const finalSubmit = method === 'DELETE' ||
      /(?:^|[/_.-])(?:submit|publish|commit|checkout|payment|purchase|delete)(?:$|[/_.-])/i.test(pathname);
    mutatingRequests.push({ method, url, finalSubmit });
  };
  page.on('request', onRequest);
  page.on('framenavigated', onNavigation);
  let late = false, lateTimer = null;
  const detach = () => {
    clearTimeout(lateTimer);
    page.off('request', onRequest);
    page.off('framenavigated', onNavigation);
    page.off('request', onLateRequest);
    page.off('framenavigated', onLateNav);
  };
  const park = (text) => { if (!lateNotes.has(page)) lateNotes.set(page, text); detach(); };
  const pathOf = (u) => { try { return new URL(u).pathname; } catch { return u; } };
  const onLateNav = (frame) => { if (frame === page.mainFrame() && pathChanged(frame.url())) park(`navigated to ${pathOf(frame.url())}`); };
  const onLateRequest = (request) => {
    if (/^(POST|PUT|PATCH|DELETE)$/.test(request.method()) && ['fetch', 'xhr'].includes(request.resourceType())) park(`${request.method()} ${pathOf(request.url())}`);
  };
  return {
    async finish(result, allowSubmit) {
      if (!result || result.blocked) return;
      const unexpectedSubmit = !allowSubmit && (navigated || mutatingRequests.some((r) => r.finalSubmit));
      result.aftermath = { beforeUrl, afterUrl: page.url(), navigated, mutatingRequests: [...mutatingRequests], unexpectedSubmit };
      if (!navigated && !unexpectedSubmit) {
        // Keep listening after the result is built, without delaying it.
        late = true;
        page.off('request', onRequest);
        page.off('framenavigated', onNavigation);
        page.on('request', onLateRequest);
        page.on('framenavigated', onLateNav);
        lateTimer = setTimeout(detach, LATE_MS);
        lateTimer.unref?.();
      }
      if (unexpectedSubmit) {
        result.aftermath.warning = 'Possible final submit observed despite allowSubmit=false. The action already occurred; inspect the result before retrying.';
      }
    },
    remove() {
      if (late) return; // late listeners detach themselves after LATE_MS
      page.off('request', onRequest);
      page.off('framenavigated', onNavigation);
    },
  };
}
