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

/** Build { status?, finalUrl?, blocked? } for a finished goto. Empty object in the OK case. */
export async function navHealth(page, response, requestedUrl, title) {
  const out = {};
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
