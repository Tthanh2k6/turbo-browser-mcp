// Opt-in navigation allowlist. Unset env = getPolicy() returns null and nothing else here runs.
// Config: TURBO_BROWSER_ALLOW_HOSTS (host + subdomains), TURBO_BROWSER_ALLOW_ORIGINS (exact origins),
// TURBO_BROWSER_ALLOW_STRICT=1 (also check sub-resources). See README, "Restricting navigation".

const ALWAYS_OK_SCHEMES = new Set(['about:', 'data:', 'blob:', 'chrome-error:']);

function parseHosts(raw) {
  const out = [];
  for (let e of String(raw || '').split(',')) {
    e = e.trim().toLowerCase();
    if (!e) continue;
    if (e.includes('://')) {
      try { e = new URL(e).hostname; } catch { continue; }
    }
    e = e.replace(/^\*\./, '').replace(/^\.+/, '').replace(/\.+$/, '');
    if (e && !out.includes(e)) out.push(e);
  }
  return out;
}

function parseOrigins(raw) {
  const out = [];
  for (let e of String(raw || '').split(',')) {
    e = e.trim();
    if (!e) continue;
    try {
      const o = new URL(e).origin;
      if (o !== 'null' && !out.includes(o)) out.push(o);
    } catch { /* ignore a malformed entry */ }
  }
  return out;
}

let cached = { key: '', policy: null };

/** The active policy or null. Cheap: re-parses only when the env strings change. */
export function getPolicy(env = process.env) {
  const h = env.TURBO_BROWSER_ALLOW_HOSTS || '';
  const o = env.TURBO_BROWSER_ALLOW_ORIGINS || '';
  const s = env.TURBO_BROWSER_ALLOW_STRICT || '';
  if (!h && !o) return null;
  const key = `${h}\n${o}\n${s}`;
  if (cached.key === key) return cached.policy;
  const hosts = parseHosts(h);
  const origins = parseOrigins(o);
  const strict = /^(1|true|yes)$/i.test(s.trim());
  const policy = hosts.length || origins.length
    ? { hosts, hostsSet: Boolean(hosts.length), origins, originsSet: Boolean(origins.length), strict }
    : null;
  cached = { key, policy };
  return policy;
}

// Self-contained on purpose: it is also stringified into the page for strict mode.
export function matchUrl(rawUrl, cfg) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { return { ok: false, why: 'url', value: String(rawUrl).slice(0, 80) }; }
  const p = u.protocol;
  if (p === 'about:' || p === 'data:' || p === 'blob:' || p === 'chrome-error:') return { ok: true };
  if (p !== 'http:' && p !== 'https:' && p !== 'ws:' && p !== 'wss:') return { ok: false, why: 'scheme', value: p };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (cfg.hostsSet && !cfg.hosts.some((e) => host === e || host.endsWith('.' + e))) {
    return { ok: false, why: 'host', value: host };
  }
  if (cfg.originsSet) {
    const o = u.origin.replace(/^ws/, 'http');
    if (!cfg.origins.includes(o)) {
      return { ok: false, why: 'origin', value: u.origin };
    }
  }
  return { ok: true };
}

export function denyMessage(v) {
  if (v.why === 'origin') return `origin not allowed: ${v.value} (TURBO_BROWSER_ALLOW_ORIGINS)`;
  if (v.why === 'scheme') return `scheme not allowed: ${v.value} (TURBO_BROWSER_ALLOW_HOSTS)`;
  if (v.why === 'url') return `url not allowed: ${v.value} (TURBO_BROWSER_ALLOW_HOSTS)`;
  return `host not allowed: ${v.value} (TURBO_BROWSER_ALLOW_HOSTS)`;
}

/** null when allowed (or no policy), else the error text. Use on every URL typed in by the caller. */
export function urlDenial(url, policy = getPolicy()) {
  if (!policy) return null;
  const v = matchUrl(url, policy);
  return v.ok ? null : denyMessage(v);
}

const guards = new WeakMap(); // page -> { ready, blocked }

/** Last main-frame navigation the guard stopped on this page, cleared by take. */
export function takeBlocked(page) {
  const g = page && guards.get(page);
  if (!g || !g.blocked) return null;
  const b = g.blocked;
  g.blocked = null;
  return b;
}
export function peekBlocked(page) {
  const g = page && guards.get(page);
  return (g && g.blocked) || null;
}

/**
 * Stop main-frame document requests (initial, redirect hops, clicks, form posts, JS navigations) to
 * disallowed hosts on this page, using CDP Fetch limited to resourceType Document. Strict mode widens
 * the pattern to every request and also wraps WebSocket/EventSource/sendBeacon in the page.
 * Only called for pages turbo opens or drives. Idempotent.
 */
export function installGuard(page, policy = getPolicy()) {
  if (!policy || !page) return Promise.resolve();
  let g = guards.get(page);
  if (g) return g.ready;
  g = { blocked: null, ready: null };
  guards.set(page, g);
  const cfg = { hosts: policy.hosts, hostsSet: policy.hostsSet, origins: policy.origins, originsSet: policy.originsSet };
  g.ready = (async () => {
    const sess = await page.context().newCDPSession(page);
    let mainId = '';
    sess.on('Fetch.requestPaused', (ev) => {
      const url = ev.request.url;
      const main = ev.resourceType === 'Document' && ev.frameId === mainId;
      let allow = true;
      if (main) {
        const v = matchUrl(url, cfg);
        if (!v.ok) { allow = false; g.blocked = { url: url.slice(0, 300) }; }
      } else if (policy.strict && /^(https?|wss?):/i.test(url)) {
        allow = matchUrl(url, cfg).ok;
      }
      const p = allow
        ? sess.send('Fetch.continueRequest', { requestId: ev.requestId })
        // Aborted (not BlockedByClient) for the main frame: Chrome then keeps the current page instead of an error page.
        : sess.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: main ? 'Aborted' : 'BlockedByClient' });
      p.catch(() => {});
    });
    const [tree] = await Promise.all([
      sess.send('Page.getFrameTree'),
      sess.send('Fetch.enable', { patterns: policy.strict ? [{ urlPattern: '*' }] : [{ resourceType: 'Document' }] }),
    ]);
    mainId = tree.frameTree.frame.id;
    if (policy.strict) {
      await page.addInitScript(
        `(${strictShim})(${JSON.stringify(cfg)}, ${matchUrl.toString()})`
      );
    }
  })().catch((err) => {
    guards.delete(page);
    throw err;
  });
  return g.ready;
}

// Runs in the page. Page JS can restore the originals, so this is a speed bump, not a boundary.
function strictShim(cfg, match) {
  const ok = (u) => { try { return match(new URL(String(u), location.href).href, cfg).ok; } catch { return false; } };
  const W = window.WebSocket;
  if (W) {
    window.WebSocket = new Proxy(W, {
      construct(t, a) { if (!ok(a[0])) throw new DOMException('host not allowed', 'SecurityError'); return Reflect.construct(t, a); },
    });
  }
  const E = window.EventSource;
  if (E) {
    window.EventSource = new Proxy(E, {
      construct(t, a) { if (!ok(a[0])) throw new DOMException('host not allowed', 'SecurityError'); return Reflect.construct(t, a); },
    });
  }
  if (navigator.sendBeacon) {
    const orig = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (u, d) => (ok(u) ? orig(u, d) : false);
  }
}
