// Analytics and telemetry endpoints are not submits.
const ANALYTICS_HOST_RE = /(^adsapi\.|(^|\.)ads?\.|google-analytics|googletagmanager|googlesyndication|doubleclick|daily\.dev|segment\.(io|com)|mixpanel|amplitude|sentry|honeybadger|hotjar|clarity\.ms|datadoghq|newrelic|bugsnag|logrocket|fullstory|plausible|posthog)/i;
const ANALYTICS_PATH_RE = /\/(ads?|page_?views?|collect|beacon|analytics|telemetry|track|log|events?|metrics|publishers)(\/|$)/i;

export function isAnalyticsRequest(request, host, reqPath) {
  if (ANALYTICS_HOST_RE.test(host)) return true;
  if (!ANALYTICS_PATH_RE.test(reqPath)) return false;
  try {
    const ct = String(request.headers?.()['content-type'] || '').toLowerCase();
    if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) return false;
    const buf = typeof request.postDataBuffer === 'function' ? request.postDataBuffer() : null;
    const body = buf ? buf.toString('utf8') : (typeof request.postData === 'function' ? request.postData() || '' : '');
    const bytes = buf ? buf.length : Buffer.byteLength(body, 'utf8');
    if (bytes >= 2048) return false;
    if (/^--[-\w]+\r?\nContent-Disposition:\s*form-data/i.test(body)) return false;
    return true;
  } catch {
    return true;
  }
}
// One settle step after an action: no fixed sleep. Resolves when the DOM has been quiet for
// QUIET_MS and no request younger than INFLIGHT_MS is pending, or at capMs. Listeners stay
// attached until remove() so a late request is still seen by the guards that share this page.
const QUIET_MS = 80, INFLIGHT_MS = 1500, POLL_MS = 20;
const IGNORED_RESOURCES = new Set(['websocket', 'eventsource', 'media', 'ping', 'beacon']);
// Presence, suggestions and people lookups, not a blanket Google-domain exception.
const GOOGLE_BACKGROUND_RPC_HOSTS = new Set([
  'signaler-pa.clients6.google.com',
  'taskassist-pa.clients6.google.com',
  'peoplestack-pa.clients6.google.com',
]);
export function isGoogleBackgroundRequest(request) {
  if (request.method() !== 'POST') return false;
  try {
    const url = new URL(request.url());
    if (GOOGLE_BACKGROUND_RPC_HOSTS.has(url.hostname)) return true;
    if (url.hostname !== 'mail.google.com' || !/^\/mail\/u\/\d+\/$/.test(url.pathname)) return false;
    // This endpoint also sends mail (act=sm). Ignore only an explicitly identified sync;
    // opaque or unfamiliar payloads must still be reported.
    const actions = [...url.searchParams.getAll('act'), ...new URLSearchParams(request.postData?.() || '').getAll('act')];
    return actions.length > 0 && actions.every((act) => act === 'sync');
  } catch { return false; }
}

// Shared by ordinary, detailed and late click reporting. A reading navigation may
// start tracking on its destination; do not classify that cross-host traffic as a submit.
export function isBackgroundRequest(request, { pageUrl = '', readNavigation = false } = {}) {
  try {
    const url = new URL(request.url());
    if (isGoogleBackgroundRequest(request) || isAnalyticsRequest(request, url.host, url.pathname)) return true;
    if (readNavigation && request.method() === 'POST' && ['fetch', 'xhr'].includes(request.resourceType())) {
      const ct = String(request.headers?.()['content-type'] || '').toLowerCase();
      const form = /multipart\/form-data|application\/x-www-form-urlencoded/.test(ct);
      const commit = /(?:^|[/_.-])(?:submit|publish|commit|checkout|payment|purchase|delete|send|comment)(?:$|[/_.-])/i.test(url.pathname);
      return !form && !commit && url.hostname !== new URL(pageUrl).hostname;
    }
  } catch { /* Unknown requests remain observable. */ }
  return false;
}
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
export function parkLate(page, text) {
  if (page && !lateNotes.has(page)) lateNotes.set(page, text);
}
export function takeLate(page) {
  const n = page && lateNotes.get(page);
  if (n) lateNotes.delete(page);
  return n || '';
}

// Observation only: this cannot undo a request or establish submission success.
export function observeClickAftermath(page, getKind = null) {
  const beforeUrl = page.url();
  const mutatingRequests = [];
  let navigated = false;
  let getNavigation = false;
  const background = (request) => isBackgroundRequest(request, {
    pageUrl: page.url(), readNavigation: getNavigation && ['link', 'search'].includes(getKind?.() || kind),
  });
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
    if (request.isNavigationRequest?.() && request.frame() === page.mainFrame() && method === 'GET') getNavigation = true;
    if (!/^(POST|PUT|PATCH|DELETE)$/.test(method) || !['fetch', 'xhr', 'document'].includes(request.resourceType())) return;
    if (background(request)) return;
    const url = request.url();
    let pathname = '';
    try { pathname = new URL(url).pathname; } catch {}
    const finalSubmit = method === 'DELETE' ||
      /(?:^|[/_.-])(?:submit|publish|commit|checkout|payment|purchase|delete)(?:$|[/_.-])/i.test(pathname);
    const entry = { method, url, finalSubmit };
    mutatingRequests.push(entry);
    entryOf.set(request, entry);
  };
  // The HTTP status decides whether a submit worked: a 403/4xx/5xx answer is a failed submit, not a sent one.
  const entryOf = new WeakMap();
  const onResponse = (response) => {
    const entry = entryOf.get(response.request());
    if (entry) entry.status = response.status();
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('framenavigated', onNavigation);
  let late = false, lateTimer = null;
  const detach = () => {
    clearTimeout(lateTimer);
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('framenavigated', onNavigation);
    page.off('request', onLateRequest);
    page.off('framenavigated', onLateNav);
  };
  const park = (text) => { if (!lateNotes.has(page)) lateNotes.set(page, text); detach(); };
  const pathOf = (u) => { try { return new URL(u).pathname; } catch { return u; } };
  const onLateNav = (frame) => { if (frame === page.mainFrame() && pathChanged(frame.url())) park(`navigated to ${pathOf(frame.url())}`); };
  const onLateRequest = (request) => {
    if (request.isNavigationRequest?.() && request.frame() === page.mainFrame() && request.method() === 'GET') getNavigation = true;
    if (background(request)) return;
    if (/^(POST|PUT|PATCH|DELETE)$/.test(request.method()) && ['fetch', 'xhr', 'document'].includes(request.resourceType())) park(`${request.method()} ${pathOf(request.url())}`);
  };
  let kind = '';
  return {
    // What the click landed on ('link' | 'search' | 'form' | 'other'): a plain link or a GET search form that navigates
    // is reading, not submitting.
    setKind(k) { kind = k || ''; },
    async finish(result, allowSubmit) {
      if (!result || result.blocked) return;
      const readOnlyNav = kind === 'link' || kind === 'search';
      const unexpectedSubmit = !allowSubmit && ((navigated && !readOnlyNav) || mutatingRequests.some((r) => r.finalSubmit));
      result.aftermath = { beforeUrl, afterUrl: page.url(), navigated, mutatingRequests: [...mutatingRequests], unexpectedSubmit };
      if (!navigated && !unexpectedSubmit) {
        // Keep listening after the result is built, without delaying it.
        late = true;
        page.off('request', onRequest);
        page.off('framenavigated', onNavigation);
        setTimeout(() => page.off('response', onResponse), LATE_MS).unref?.();
        page.on('request', onLateRequest);
        page.on('framenavigated', onLateNav);
        lateTimer = setTimeout(detach, LATE_MS);
        lateTimer.unref?.();
      }
      const failedReq = mutatingRequests.find((r) => r.status >= 400);
      if (failedReq) {
        result.aftermath.warning = `${failedReq.method} ${pathOf(failedReq.url)} answered ${failedReq.status}: the submit failed, do not report success.`;
      }
      if (unexpectedSubmit) {
        result.aftermath.warning = 'Possible final submit observed despite allowSubmit=false. The action already occurred; inspect the result before retrying.';
      }
    },
    remove() {
      if (late) return; // late listeners detach themselves after LATE_MS
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('framenavigated', onNavigation);
    },
  };
}
