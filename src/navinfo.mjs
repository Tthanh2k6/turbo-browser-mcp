// Navigation health hints: only emitted when the page is not a plain OK load.
const BLOCK_TITLE_RES = [
  [/just a moment|attention required|checking your browser|performing security verification/i, 'cloudflare'],
  [/access denied|are you a robot|verify you are (a )?human|human verification|captcha/i, 'bot-wall'],
];
const BLOCK_BODY_RES = [
  [/verify(ing)? you are (a )?human|checking if the site connection is secure|enable javascript and cookies to continue|performing security verification/i, 'bot-wall'],
  [/complete the security check|unusual traffic from your (computer|network)/i, 'captcha'],
];

function sameUrl(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    x.hash = '';
    y.hash = '';
    return x.href === y.href;
  } catch {
    return a === b;
  }
}

const SPLASH_RE = /^(loading|thinking|please wait|just a moment|đang tải|vui lòng chờ)/i;

/**
 * SPA splash after a "load" navigation: body text under 80 chars that is empty-with-scripts or a bare
 * "Loading..."/"Thinking" label. Waits up to maxMs for the text to grow; returns the ms waited, 0 when not a splash.
 */
export async function settleSplash(page, maxMs = 3000) {
  const read = () =>
    Promise.race([
      page.evaluate(() => {
        const t = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
        return { len: t.length, text: t.slice(0, 40), scripts: document.querySelectorAll('script[src]').length };
      }),
      new Promise((r) => setTimeout(() => r(null), 300)),
    ]).catch(() => null);
  const first = await read();
  if (!first || first.len >= 80) return 0;
  if (!(first.len === 0 ? first.scripts > 0 : SPLASH_RE.test(first.text))) return 0;
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await new Promise((r) => setTimeout(r, 100));
    const cur = await read();
    if (cur && cur.len >= 80) break;
  }
  return Date.now() - t0;
}

/** Build { status?, finalUrl?, blocked?, settledMs? } for a finished goto. Empty object in the OK case. */
export async function navHealth(page, response, requestedUrl, title, opts = {}) {
  const out = {};
  if (opts.waitUntil === 'load') {
    const ms = await settleSplash(page);
    if (ms > 0) {
      out.settledMs = ms;
      title = await page.title().catch(() => title);
    }
  }
  const status = response && typeof response.status === 'function' ? response.status() : 0;
  if (status && (status < 200 || status >= 300)) out.status = status;
  const finalUrl = page.url();
  if (requestedUrl && finalUrl && !sameUrl(requestedUrl, finalUrl)) out.finalUrl = finalUrl;

  let blocked = '';
  if (/linkedin\.com\/(authwall|checkpoint|uas\/login)/i.test(finalUrl)) blocked = 'authwall';
  if (!blocked) {
    for (const [re, tag] of BLOCK_TITLE_RES) {
      if (re.test(title || '')) { blocked = tag; break; }
    }
  }
  if (!blocked && (!title || title.length < 80)) {
    let snippet = '';
    try {
      snippet = await Promise.race([
        page.evaluate(() => (document.body?.innerText || '').slice(0, 800)),
        new Promise((r) => setTimeout(() => r(''), 400)),
      ]);
    } catch {
      snippet = '';
    }
    if (!blocked) {
      for (const [re, tag] of BLOCK_BODY_RES) {
        if (re.test(snippet)) { blocked = tag; break; }
      }
    }
  }
  if (blocked) out.blocked = blocked;
  return out;
}
