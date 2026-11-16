import fs from 'node:fs';
import { gotoRetry, navHealth } from './navinfo.mjs';
import { urlDenial, peekBlocked, denyMessage, matchUrl, getPolicy } from './allow-hosts.mjs';
import { observeClickAftermath, watchActivity } from './aftermath.mjs';
import { armToasts, takeToast } from './toast.mjs';
import { wrapPage, boundariesEnabled } from './boundaries.mjs';
import { redactText } from './secrets.mjs';
import path from 'node:path';
import {
  appendLedger,
  defaultLedgerPath,
  describeNetworkBlock,
  findLedgerEntry,
  hasAnyCondition,
  installNetworkGuard,
  resolveNetworkGuard,
  waitForSubmitEvidence,
  armTextNew,
} from './guards.mjs';

const DEFAULT_TIMEOUT_MS = 8000;

const SUBMIT_LABEL_RE =
  /^(submit|publish|post|send|apply(\s+now)?|confirm(\s+and)?\s*(pay|submit|order|booking)|pay(\s+now)?|buy(\s+now)?|order(\s+now)?|complete\s+(order|purchase)|checkout|place\s+order|delete|remove|gửi|đăng(?!\s+nhập)(\s*bài)?|nộp(\s*đơn)?|xác\s*nhận(\s*(nộp|gửi|thanh\s*toán|đặt))?|thanh\s*toán|đặt\s+hàng|mua\s+ngay|xoá|xóa|hoàn\s*tất|lên\s+lịch(\s+họp)?|đặt\s+(lịch|hẹn|chỗ|bàn|phòng)|schedule\s+(meeting|call|demo|appointment|now)|book(\s+(now|an?\s+\p{L}+|appointment|meeting|call|demo))?|(제출|신청|등록|접수|결제|구매|삭제)(하기)?|送信(する)?|確定|申し込む|購入(する)?|削除|提交|确认提交|支付|购买|删除)(?![\p{L}\p{N}_])/iu;

const SAFE_SUBMIT_TYPE_RE =
  /^(next|continue|search|filter|save\s*draft|log\s*in|sign\s*in|tiếp(\s*tục)?|tìm(\s*kiếm)?|lọc|lưu\s*nháp|đăng\s+nhập|다음|이전|검색|로그인|次へ|検索|ログイン|下一步|搜索|登录)(?![\p{L}\p{N}_])/iu;

// Destructive-but-local UI (chip remove, clear form, close/cancel): not a final submit unless it is type=submit.
const LOCAL_UI_RE =
  /^(?!.*(?:account|profile|permanently|everything|workspace|tài\s*khoản|vĩnh\s*viễn))(remove|clear|cancel|close|hủy|huỷ|đóng|xóa\s+hết\s+câu\s+trả\s+lời|xoá\s+hết\s+câu\s+trả\s+lời|xóa\s+biểu\s+mẫu|xoá\s+biểu\s+mẫu)(?![\p{L}\p{N}_])/iu;

const APPLY_LABEL_RE = /^apply(\s+now)?(?![\p{L}\p{N}_])/iu;

// smart_fill_form submitButtons: never list these, even when type=submit.
const SUBMIT_CAND_NEG_RE =
  /^(clear|reset|remove|delete|cancel|close|discard|xóa|xoá|hủy|huỷ|đóng|bỏ\s+qua)(?![\p{L}\p{N}_])/iu;
// Account-connection / OAuth buttons ("Connect Google Account", "Sign in with GitHub") never commit a filled form.
const ACCOUNT_CONNECT_RE =
  /^(connect|disconnect|link|unlink)\s.*\b(account|facebook|google|github|twitter|apple|microsoft|mlh|linkedin|discord|slack|x)\b|(^|\s)(sign|log)\s*(in|up)?\s+with\s+\p{L}|^continue\s+with\s+(google|facebook|github|apple|microsoft|twitter|linkedin|discord)/iu;
// "Save changes", "Save profile": commit buttons that do not read as submit/publish (but not "Save draft").
const SAVE_COMMIT_RE = /^save(?!\s*(as\s+)?draft|\s*for\s*later)(?![\p{L}\p{N}_])/iu;
const NEXT_STEP_RE = /^(next|continue|tiếp(\s*tục)?)(?![\p{L}\p{N}_])/iu;

const COMPOUND_DANGER_RE =
  /(?:^|[^\p{L}\p{N}_])(submit|publish|post|send|apply(\s+now)?|pay|payment|purchase|buy|place\s+order|complete\s+(order|purchase)|checkout|delete|remove|confirm|thanh\s*toán|đặt\s+hàng|mua\s+ngay|đăng(?!\s+nhập)(\s*bài)?|xoá|xóa|gửi|nộp|lên\s+lịch|đặt\s+lịch|schedule\s+(meeting|call|demo)|book\s+(now|an?\s)|제출|결제|送信|提交|支付)(?![\p{L}\p{N}_])/iu;

// Affirmative buttons that commit when they sit inside a modal opened by an earlier "next" step
// (e.g. Korean portals: 다음 -> modal 확인 is the real submit).
const MODAL_CONFIRM_RE =
  /^(ok(ay)?|yes|confirm|확인|예|네|はい|確認|OK|确定|確定|确认|đồng\s*ý|có|xác\s*nhận)(?![\p{L}\p{N}_])/iu;

const MODAL_SELECTOR = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]';

const QUESTION_BLOCK_SELECTOR =
  '[role="listitem"], [role="radiogroup"], [role="group"], fieldset, .form-group, .field, [class*="Field"], [class*="field"], [class*="question"]';

const SUBMIT_SCAN_SELECTOR =
  'button, input[type="submit"], input[type="image"], input[type="button"], [role="button"], a[role="button"]';

function compileFilterRegex(pattern) {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, 'i');
  }
}

function matchesPattern(text, pattern) {
  if (pattern === undefined || pattern === null) return false;
  const raw = String(pattern);
  if (!raw) return false;
  const hay = String(text || '');
  if (hay.toLowerCase().includes(raw.toLowerCase())) return true;
  return compileFilterRegex(raw).test(hay);
}

/**
 * Determine whether Submit/Publish actions are permitted (explicit parameter overrides env default).
 */
export function resolveAllowSubmit(explicitVal) {
  return explicitVal !== undefined
    ? Boolean(explicitVal)
    : process.env.TURBO_BROWSER_ALLOW_SUBMIT === 'true';
}

const EXT_MIME_MAP = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function inferMimeType(filePath) {
  return EXT_MIME_MAP[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function canonicalizePath(targetPath, { rejectDangling = false, allowUncTarget = false } = {}) {
  const resolved = path.resolve(targetPath);
  let cur = resolved;
  const tail = [];
  while (true) {
    let st = null;
    try {
      st = fs.lstatSync(cur, { throwIfNoEntry: false });
    } catch (err) {
      if (rejectDangling && err?.code === 'ELOOP') {
        throw new Error(
          `Refusing cyclic symlink/junction "${cur}" (outside allowed root).`
        );
      }
    }
    if (st) {
      if (st.isSymbolicLink()) {
        let linkTarget = '';
        try {
          linkTarget = String(fs.readlinkSync(cur) || '').trim();
        } catch {}
        if (
          !allowUncTarget &&
          /^(?:[\\/]{2}|\\\\[?.]\\UNC\\|\\\?\?\\UNC\\)/i.test(linkTarget)
        ) {
          throw new Error(
            `Refusing symlink/junction "${cur}" targeting network/UNC path "${linkTarget}" (outside allowed root).`
          );
        }
        try {
          const real = fs.realpathSync(cur);
          return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
        } catch {
          if (rejectDangling) {
            throw new Error(
              `Refusing dangling or unresolvable symlink/junction "${cur}" (outside allowed root).`
            );
          }
          return tail.length > 0 ? path.join(cur, ...tail.reverse()) : cur;
        }
      }
      try {
        const real = fs.realpathSync(cur);
        return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
      } catch {
        return tail.length > 0 ? path.join(cur, ...tail.reverse()) : cur;
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return resolved;
    tail.push(path.basename(cur));
    cur = parent;
  }
}

/**
 * Resolve a file path for saving/loading state confined to process.cwd() or TURBO_BROWSER_SAVE_ROOT.
 */
export function resolveSafePath(inputPath, purpose = 'savePath') {
  const rawInput = String(inputPath ?? '');
  if (rawInput.includes('\0')) {
    throw new Error(`${purpose} contains invalid null byte.`);
  }
  const raw = rawInput.trim();
  if (!raw) {
    throw new Error(`${purpose} requires a non-empty file path.`);
  }
  if (process.platform === 'win32') {
    if (/^[a-zA-Z]:(?![\\/])/.test(raw)) {
      throw new Error(`${purpose} rejects Windows drive-relative path "${raw}".`);
    }
    const withoutDrive = rawInput.replace(/^\s*[a-zA-Z]:[\\/]/, '');
    if (withoutDrive.includes(':')) {
      throw new Error(`${purpose} rejects Windows NTFS alternate data stream or colon in "${raw}".`);
    }
    const rawSegments = withoutDrive.split(/[\\/]+/).filter(Boolean);
    for (const seg of rawSegments) {
      if (seg !== '.' && seg !== '..' && /[\s.]$/.test(seg)) {
        throw new Error(`${purpose} rejects trailing dot or space in path segment "${seg}".`);
      }
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(seg)) {
        throw new Error(`${purpose} rejects Windows reserved device name "${seg}".`);
      }
    }
  }
  const isPathInsideRoot = (candidatePath, rootDir) => {
    const normCand = process.platform === 'win32' ? candidatePath.toLowerCase() : candidatePath;
    const normRoot = process.platform === 'win32' ? rootDir.toLowerCase() : rootDir;
    const rel = path.relative(normRoot, normCand);
    return (
      rel === '' ||
      (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !rel.startsWith('../'))
    );
  };
  const envRoots = (process.env.TURBO_BROWSER_SAVE_ROOT || '')
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
  const rootPairs = (envRoots.length > 0 ? envRoots : [process.cwd()]).map((r) => {
    const rawRoot = path.resolve(process.cwd(), r);
    return {
      rawRoot,
      canonRoot: canonicalizePath(rawRoot, { rejectDangling: false, allowUncTarget: true }),
    };
  });
  const allowedRoots = rootPairs.map((p) => p.canonRoot);
  const rawCandidate = path.resolve(process.cwd(), raw);
  const lexicalInside = rootPairs.some(
    ({ rawRoot, canonRoot }) => isPathInsideRoot(rawCandidate, rawRoot) || isPathInsideRoot(rawCandidate, canonRoot)
  );
  if (!lexicalInside) {
    throw new Error(
      `Path "${raw}" (${purpose}) resolves outside allowed root(s) (${allowedRoots.join(', ')}). Set TURBO_BROWSER_SAVE_ROOT to allow additional directories.`
    );
  }
  const allowUncTarget = allowedRoots.some((r) => /^(?:[\\/]{2}|\\\\\?\\UNC\\)/i.test(r));
  const candidate = canonicalizePath(rawCandidate, { rejectDangling: true, allowUncTarget });
  const isInside = allowedRoots.some((rootDir) => isPathInsideRoot(candidate, rootDir));

  if (!isInside) {
    throw new Error(
      `Path "${raw}" (${purpose}) resolves outside allowed root(s) (${allowedRoots.join(', ')}). Set TURBO_BROWSER_SAVE_ROOT to allow additional directories.`
    );
  }
  return candidate;
}

function writeSaveFile(savePath, content) {
  if (!savePath) return null;
  const resolved = resolveSafePath(savePath, 'savePath');
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  // Saved files never hold a configured secret value (no-op without a secrets file).
  fs.writeFileSync(resolved, redactText(content), typeof content === 'string' ? 'utf8' : undefined);
  return resolved;
}

function normalizeModifiers(modifiers) {
  if (!Array.isArray(modifiers)) return [];
  const valid = new Set(['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift']);
  return modifiers
    .map((m) => String(m))
    .filter((m) => valid.has(m))
    .map((m) => (m === 'ControlOrMeta' ? (process.platform === 'darwin' ? 'Meta' : 'Control') : m));
}

async function withModifiers(page, modifiers, fn) {
  const pressed = [];
  try {
    for (const mod of modifiers) {
      await page.keyboard.down(mod);
      pressed.push(mod);
    }
    return await fn();
  } finally {
    for (let i = pressed.length - 1; i >= 0; i--) {
      await page.keyboard.up(pressed[i]).catch(() => {});
    }
  }
}

async function performDropAction(targetHandleOrLocator, params) {
  const rawFiles =
    Array.isArray(params.files) && params.files.length > 0
      ? params.files
      : params.file
        ? [params.file]
        : [];
  const dropData =
    params.dropData && typeof params.dropData === 'object' && !Array.isArray(params.dropData)
      ? params.dropData
      : {};
  if (rawFiles.length === 0 && Object.keys(dropData).length === 0) {
    throw new Error('drop action requires file, files, or dropData.');
  }

  const filePayloads = rawFiles.map((rawPath) => {
    const resolved = path.resolve(String(rawPath));
    if (!fs.existsSync(resolved)) {
      throw new Error(`File not found on disk: ${resolved}`);
    }
    return {
      name: path.basename(resolved),
      mimeType: inferMimeType(resolved),
      base64: fs.readFileSync(resolved).toString('base64'),
    };
  });
  const dropEntries = Object.entries(dropData).map(([k, v]) => [String(k), String(v ?? '')]);

  await targetHandleOrLocator.evaluate(
    (el, { files, entries }) => {
      const dt = new DataTransfer();
      for (const [mime, val] of entries) dt.setData(mime, val);
      for (const f of files) {
        const bin = atob(f.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        dt.items.add(new File([bytes], f.name, { type: f.mimeType || 'application/octet-stream' }));
      }
      for (const evtName of ['dragenter', 'dragover', 'drop']) {
        el.dispatchEvent(new DragEvent(evtName, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
    },
    { files: filePayloads, entries: dropEntries }
  );

  return {
    files: filePayloads.map((f) => f.name),
    mimeTypes: dropEntries.map(([k]) => k),
  };
}

/**
 * Return active frames in page order with deterministic integer indices.
 */
export function getAllFrames(page) {
  const frames = [];
  const rawFrames = page.frames();
  for (let i = 0; i < rawFrames.length; i++) {
    const frame = rawFrames[i];
    if (frame.isDetached()) continue;
    frames.push({
      frameIdx: frames.length,
      frame,
      name: frame.name() || '',
      url: frame.url() || '',
      isMain: frame === page.mainFrame(),
    });
  }
  return frames;
}

function parseRefString(refStr) {
  const full = /^f(\d+):(e\d+)$/i.exec(refStr.trim());
  if (full) {
    return { frameIdx: Number(full[1]), refId: full[2] };
  }
  const bare = /^(e\d+)$/i.exec(refStr.trim());
  if (bare) {
    return { frameIdx: null, refId: bare[1] };
  }
  return null;
}

async function pickBestLocator(allLoc, allowHidden = false) {
  const count = await allLoc.count().catch(() => 0);
  if (count === 0) return null;
  if (allowHidden) {
    return { locator: allLoc.first(), visible: true };
  }
  const limit = Math.min(count, 12);
  for (let i = 0; i < limit; i++) {
    const cand = allLoc.nth(i);
    if (await cand.isVisible().catch(() => false)) {
      return { locator: cand, visible: true };
    }
  }
  return { locator: allLoc.first(), visible: false };
}

// Text targeting: among visible matches prefer actionable ones (button/link/role=button/submit/label or
// pointer cursor), then ones whose whole text equals the query, so a heading "Login Page" never beats the
// "Login" button and a paragraph that merely mentions "Close" never beats the "Close" control.
async function pickBestTextLocator(allLoc, text, allowHidden = false) {
  const count = await allLoc.count().catch(() => 0);
  if (count === 0) return null;
  if (allowHidden || count === 1) return pickBestLocator(allLoc, allowHidden);
  const scores = await allLoc.evaluateAll((els, q) => {
    const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const want = norm(q);
    const act = 'button, a[href], input[type=submit], input[type=button], input[type=image], summary, label, [role=button], [role=link], [role=menuitem], [role=tab], [onclick]';
    return els.slice(0, 40).map((el) => {
      const r = el.getBoundingClientRect();
      let vis = r.width > 0 && r.height > 0;
      try { vis = vis && getComputedStyle(el).visibility !== 'hidden' && el.checkVisibility?.() !== false; } catch {}
      if (!vis) return -1;
      let a = 0;
      try { a = el.closest(act) ? 2 : getComputedStyle(el).cursor === 'pointer' ? 2 : 0; } catch {}
      const t = norm(el.value && /^(submit|button)$/.test(el.type) ? el.value : el.textContent);
      return a + (t === want ? 1 : 0);
    });
  }, text).catch(() => null);
  if (!scores) return pickBestLocator(allLoc, allowHidden);
  let best = -1;
  let bestScore = -1;
  scores.forEach((sc, i) => { if (sc > bestScore) { bestScore = sc; best = i; } });
  if (best >= 0 && bestScore >= 0) return { locator: allLoc.nth(best), visible: true };
  return { locator: allLoc.first(), visible: false };
}

// Up to 3 live refs closest in number to a missing one, each with a short label, so the model can
// retry without another snapshot. Never throws.
async function nearbyRefs(frames, refId) {
  const want = Number(String(refId).replace(/\D/g, ''));
  const found = [];
  for (const f of frames) {
    const rows = await f.frame.evaluate(() => [...document.querySelectorAll('[data-tbm-ref]')].map((el) => [
      el.getAttribute('data-tbm-ref'),
      (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.getAttribute('name') || el.tagName)
        .toString().replace(/\s+/g, ' ').trim().slice(0, 30),
    ])).catch(() => []);
    for (const [id, label] of rows) {
      const n = Number(String(id).replace(/\D/g, ''));
      if (Number.isFinite(n)) found.push({ d: Math.abs(n - want), text: `f${f.frameIdx}:${id} "${label}"` });
    }
  }
  return found.sort((a, b) => a.d - b.d).slice(0, 3).map((x) => x.text).join(', ');
}

// Up to 5 option labels closest to the wanted text: substring matches first, then edit distance.
function closestOptions(wanted, options, limit = 5) {
  const w = String(wanted).toLowerCase();
  const dist = (a, b) => {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return row[b.length];
  };
  return [...new Set(options.map((o) => String(o).trim()).filter(Boolean))]
    .map((o) => {
      const l = o.toLowerCase();
      return { o, d: l.includes(w) || w.includes(l) ? 0 : dist(w, l) };
    })
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((x) => x.o);
}

// Playwright's click failure carries a long call log; keep the covering element, one line.
// Strip ANSI escapes and Playwright's "Call log:" block: keep the first line plus at most one detail line.
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export function cleanErrorMessage(raw) {
  const msg = String(raw ?? '').replace(ANSI_RE, '');
  const at = msg.search(/\r?\n\s*Call log:/i);
  if (at < 0) return msg;
  const head = msg.slice(0, at).trim();
  const log = msg.slice(at).split(/\r?\n/).slice(1).map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
  const detail = log.length ? log[log.length - 1].slice(0, 160) : '';
  return detail ? `${head}\n${detail}` : head;
}

function conciseActionError(err) {
  const raw = String(err?.message || err);
  const msg = cleanErrorMessage(raw);
  const m = /(<.{3,300}?>)[^\r\n]*?\s+intercepts pointer events/.exec(raw.replace(ANSI_RE, ''));
  if (!m) return msg === raw ? err : new Error(msg);
  const covering = m[1].replace(/\s+/g, ' ').slice(0, 140);
  return new Error(`Click blocked: ${covering} covers the target. Close or scroll it away, or act on it, then retry.`);
}

/**
 * Resolve a compact ref (f0:e3 / e3), CSS/Playwright selector (piercing open Shadow DOM),
 * or text match across frames.
 */
export async function resolveTarget(page, { ref, selector, text, frameIdx, allowHidden: paramAllowHidden } = {}, options = {}) {
  const allowHidden = Boolean(options.allowHidden ?? paramAllowHidden);
  const frames = getAllFrames(page);
  if (frames.length === 0) {
    throw new Error('No active frames on page.');
  }

  if (ref) {
    const parsed = parseRefString(ref);
    if (!parsed) {
      throw new Error(`Invalid ref format "${ref}". Expected "f0:e1" or "e1".`);
    }
    const candidates = parsed.frameIdx !== null
      ? frames.filter((f) => f.frameIdx === parsed.frameIdx)
      : frames;

    let fallback = null;
    for (const f of candidates) {
      const allLoc = f.frame.locator(`[data-tbm-ref="${parsed.refId}"]`);
      const picked = await pickBestLocator(allLoc, allowHidden);
      if (picked) {
        const res = { frame: f.frame, frameIdx: f.frameIdx, locator: picked.locator };
        if (picked.visible) return res;
        if (!fallback) fallback = res;
      }
    }
    if (fallback) return fallback;
    const near = await nearbyRefs(candidates, parsed.refId);
    throw new Error(`Element ref "${ref}" not found. ${near ? `Nearest current refs: ${near}. If the page re-rendered, re-run inspect_compact (same query).` : 'Run inspect_compact to refresh refs.'}`);
  }

  const scopedFrames = frameIdx !== undefined && frameIdx !== null
    ? frames.filter((f) => f.frameIdx === frameIdx)
    : frames;

  if (selector) {
    let fallback = null;
    for (const f of scopedFrames) {
      const allLoc = f.frame.locator(selector);
      const picked = await pickBestLocator(allLoc, allowHidden);
      if (picked) {
        const res = { frame: f.frame, frameIdx: f.frameIdx, locator: picked.locator };
        if (picked.visible) return res;
        if (!fallback) fallback = res;
      }
    }
    if (fallback) return fallback;
    throw new Error(`Selector "${selector}" matched 0 elements across ${scopedFrames.length} frame(s).`);
  }

  if (text) {
    let fallback = null;
    for (const f of scopedFrames) {
      const allLoc = f.frame.getByText(text, { exact: false });
      const picked = await pickBestTextLocator(allLoc, text, allowHidden);
      if (picked) {
        const res = { frame: f.frame, frameIdx: f.frameIdx, locator: picked.locator };
        if (picked.visible) return res;
        if (!fallback) fallback = res;
      }
    }
    if (fallback) return fallback;
    // No visible text matched: fall back to aria-label, then title (exact first, then contains).
    const q = String(text).replace(/["\\\n]/g, (c) => (c === '\n' ? ' ' : '\\' + c));
    for (const attrSel of [`[aria-label="${q}" i]`, `[aria-label*="${q}" i]`, `[title="${q}" i]`, `[title*="${q}" i]`]) {
      for (const f of scopedFrames) {
        let picked = null;
        try {
          picked = await pickBestLocator(f.frame.locator(attrSel), allowHidden);
        } catch {}
        if (picked) {
          const res = { frame: f.frame, frameIdx: f.frameIdx, locator: picked.locator };
          if (picked.visible) return res;
          if (!fallback) fallback = res;
        }
      }
      if (fallback) return fallback;
    }
    throw new Error(`Text "${text}" matched 0 elements across ${scopedFrames.length} frame(s).`);
  }

  throw new Error('Target requires ref, selector, or text.');
}

/**
 * Inspect whether an element represents a final Submit/Publish/Send/Pay/Delete action.
 */
export async function isSubmitLikeElement(locator) {
  try {
    return await locator.evaluate((el, patterns) => {
      if (!el) return { isSubmit: false, label: '', reason: '' };
      const submitRe = new RegExp(patterns.submit, 'iu');
      const safeRe = new RegExp(patterns.safe, 'iu');
      const dangerRe = new RegExp(patterns.danger, 'iu');
      const modalRe = new RegExp(patterns.modal, 'iu');
      const localRe = new RegExp(patterns.localUi, 'iu');
      const applyRe = new RegExp(patterns.apply, 'iu');
      const isShadowRoot = (r) => Boolean(r && r.nodeType === 11 && 'host' in r);
      const getSR = (node) => node?.shadowRoot || window.__tbmGetShadowRoot?.(node) || null;
      const closestComposed = (node, sel) => {
        let cur = node;
        while (cur) {
          if (cur.nodeType === 1 && cur.matches?.(sel)) return cur;
          const root = cur.getRootNode?.();
          cur = cur.assignedSlot || cur.parentElement || (isShadowRoot(root) ? root.host : null);
        }
        return null;
      };
      const isElementFocusableAndVisible = (node) => {
        if (!node || node.nodeType !== 1) return false;
        if (node.disabled || Boolean(node.matches?.(':disabled')) || node.getAttribute?.('aria-disabled') === 'true') return false;
        if (typeof node.checkVisibility === 'function' && node.checkVisibility({ visibilityProperty: true, opacityProperty: false }) === false) return false;
        let cur = node;
        while (cur && cur.nodeType === 1) {
          if (cur.hasAttribute('hidden') || cur.hasAttribute('inert') || Boolean(cur.inert)) return false;
          const parent = cur.parentElement;
          if (parent && parent.tagName === 'DETAILS' && !parent.open) {
            const firstSummary = [...parent.children].find((c) => c.tagName === 'SUMMARY');
            if (!firstSummary || cur !== firstSummary) return false;
          }
          if (parent && parent.tagName === 'FIELDSET' && parent.disabled) {
            const firstLegend = [...parent.children].find((c) => c.tagName === 'LEGEND');
            if (!firstLegend || cur !== firstLegend) return false;
          }
          try {
            const st = getComputedStyle(cur);
            if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse' || st.contentVisibility === 'hidden') return false;
          } catch {}
          const rn = cur.getRootNode?.();
          cur = parent || (isShadowRoot(rn) ? rn.host : null);
        }
        const r = node.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const resolveDelegatedFocus = (host) => {
        let cur = host;
        const seen = new Set();
        while (getSR(cur)?.delegatesFocus && !seen.has(cur)) {
          seen.add(cur);
          const candidates = getSR(cur).querySelectorAll('*');
          let next = null;
          for (const c of candidates) {
            if (!isElementFocusableAndVisible(c)) continue;
            if (getSR(c)?.delegatesFocus) {
              const inner = resolveDelegatedFocus(c);
              if (inner) {
                next = inner;
                break;
              }
              continue;
            }
            const rawTab = c.getAttribute('tabindex');
            const hasValidTab = rawTab !== null && /^\s*[+-]?\d+\s*$/.test(rawTab) && Number(rawTab) >= 0;
            if (
              c.isContentEditable ||
              hasValidTab ||
              (c.matches?.('input:not([type="hidden"]), select, textarea, button, a[href], area[href], summary') && c.tabIndex >= 0)
            ) {
              next = c;
              break;
            }
          }
          if (!next) return null;
          cur = next;
        }
        return cur !== host ? cur : null;
      };
      if (getSR(el)?.delegatesFocus) {
        const df = resolveDelegatedFocus(el);
        if (df) el = df;
      }
      const lbl = closestComposed(el, 'label');
      const btn =
        closestComposed(
          el,
          'button, input[type="submit"], input[type="image"], input[type="button"], [type="submit"], [type="image"], [role="button"], [role="switch"], [role="checkbox"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], a'
        ) ||
        (lbl && lbl.control) ||
        el;
      let hostEl = null;
      let hostType = '';
      let hostRole = '';
      let curHost = isShadowRoot(btn.getRootNode?.()) ? btn.getRootNode().host : null;
      while (curHost) {
        if (!hostEl) hostEl = curHost;
        if (!hostRole) hostRole = (curHost.getAttribute?.('role') || '').toLowerCase();
        const ht = (curHost.getAttribute?.('type') || '').toLowerCase();
        if (ht) {
          hostType = ht;
          break;
        }
        const nextRn = curHost.getRootNode?.();
        curHost = isShadowRoot(nextRn) ? nextRn.host : null;
      }
      const findShadowInnerBtn = (rootHost) => {
        const rootSr = getSR(rootHost);
        if (!rootSr) return { btn: null, type: '' };
        const stack = [rootSr];
        let firstBtn = null;
        while (stack.length > 0) {
          const sr = stack.shift();
          if (!sr || !sr.querySelectorAll) continue;
          for (const node of sr.querySelectorAll('*')) {
            if (
              node.matches?.(
                'button, input[type="submit"], input[type="image"], input[type="button"], [type="submit"], [type="image"], [role="button"]'
              )
            ) {
              if (!firstBtn) firstBtn = node;
              const nTag = (node.tagName || '').toLowerCase();
              const sameScopeForm = Boolean(node.form || node.closest?.('form'));
              const effType = (
                nTag === 'button'
                  ? (sameScopeForm ? (node.type || 'submit') : (node.getAttribute?.('type') || ''))
                  : (node.getAttribute?.('type') || '')
              ).toLowerCase();
              if (effType === 'submit' || effType === 'image') {
                return { btn: node, type: effType };
              }
            }
            const childSr = getSR(node);
            if (childSr) {
              const childHostType = (node.getAttribute?.('type') || '').toLowerCase();
              if (childHostType !== 'button' && childHostType !== 'reset') {
                stack.push(childSr);
              }
            }
          }
        }
        return { btn: firstBtn, type: '' };
      };
      const shadowInnerInfo = findShadowInnerBtn(btn);
      const shadowInnerBtn = shadowInnerInfo.btn;
      const innerType = shadowInnerInfo.type;
      const tag = (btn.tagName || '').toLowerCase();
      const sameScopeBtnForm = Boolean(btn.form || btn.closest?.('form'));
      const rawType = (
        tag === 'button'
          ? (sameScopeBtnForm && hostType !== 'button' && hostType !== 'reset' ? (btn.type || 'submit') : (btn.getAttribute?.('type') || ''))
          : (btn.getAttribute?.('type') || '')
      ).toLowerCase();
      const type =
        (!sameScopeBtnForm && rawType === 'button' && (hostType === 'submit' || hostType === 'image')
          ? hostType
          : rawType) ||
        (hostType === 'submit' || hostType === 'image' || hostType === 'button' || hostType === 'reset' ? hostType : '') ||
        (innerType === 'submit' || innerType === 'image' ? innerType : '');
      const role = (btn.getAttribute?.('role') || hostRole || '').toLowerCase();
      const normLbl = (s) =>
        String(s || '')
          .normalize('NFC')
          .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      const doc = btn.ownerDocument || document;
      const BLOCK_TAGS = new Set([
        'DIV', 'P', 'LI', 'UL', 'OL', 'TR', 'TD', 'TH',
        'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'ASIDE', 'NAV',
        'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'BR',
      ]);
      const extractAccessibleText = (rootNode, allowHidden = false) => {
        if (!rootNode) return '';
        const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE']);
        const walkChildren = (nodes) => {
          let out = '';
          for (const c of nodes || []) {
            const piece = walk(c);
            if (!piece) continue;
            const cTag = c.nodeType === 1 ? (c.tagName || '').toUpperCase() : '';
            if (BLOCK_TAGS.has(cTag)) {
              out += (out && !/\s$/.test(out) ? ' ' : '') + piece + ' ';
            } else {
              out += piece;
            }
          }
          return out;
        };
        const walk = (n) => {
          if (!n) return '';
          if (n.nodeType === 3) return n.textContent || '';
          if (n.nodeType !== 1 && n.nodeType !== 11) return '';
          if (n.nodeType === 1) {
            const t = (n.tagName || '').toUpperCase();
            if (SKIP.has(t)) return '';
            if (t === 'BR') return ' ';
            if (!allowHidden && n !== rootNode) {
              if (n.hasAttribute?.('hidden') || n.getAttribute?.('aria-hidden') === 'true') return '';
              try {
                const st = getComputedStyle(n);
                if (st.display === 'none' || st.visibility === 'hidden') return '';
              } catch {}
            }
            if (t === 'SLOT' && typeof n.assignedNodes === 'function') {
              const assigned = n.assignedNodes({ flatten: true });
              const list = assigned.length > 0 ? assigned : (n.childNodes || []);
              return walkChildren(list);
            }
            const nSr = getSR(n);
            if (nSr) {
              const srOut = walkChildren(nSr.childNodes);
              if (normLbl(srOut)) return srOut;
            }
          }
          return walkChildren(n.childNodes);
        };
        return walk(rootNode);
      };
      const resolveAriaLabelledBy = (node) => {
        const lby = node?.getAttribute?.('aria-labelledby');
        if (!lby) return '';
        const rn = node.getRootNode?.();
        return lby
          .split(/\s+/)
          .map((id) => {
            const refEl = (rn?.getElementById && rn.getElementById(id)) || doc.getElementById(id);
            return extractAccessibleText(refEl, true) || refEl?.textContent || '';
          })
          .join(' ');
      };
      const candidates = [
        resolveAriaLabelledBy(btn),
        btn.getAttribute?.('aria-label'),
        hostEl ? resolveAriaLabelledBy(hostEl) : '',
        hostEl ? hostEl.getAttribute?.('aria-label') : '',
        el !== btn ? resolveAriaLabelledBy(el) : '',
        el !== btn ? el.getAttribute?.('aria-label') : '',
        extractAccessibleText(btn),
        extractAccessibleText(getSR(btn)),
        hostEl ? extractAccessibleText(hostEl) : '',
        el !== btn && el.getAttribute?.('aria-hidden') !== 'true' ? extractAccessibleText(el) : '',
        tag === 'input' && type !== 'checkbox' && type !== 'radio' ? btn.value : '',
        btn.getAttribute?.('alt'),
        btn.querySelector?.('[alt]')?.getAttribute?.('alt'),
        btn.querySelector?.('[aria-label]')?.getAttribute?.('aria-label'),
        btn.querySelector?.('svg title')?.textContent,
        btn.getAttribute?.('title'),
        hostEl ? hostEl.getAttribute?.('title') : '',
        el !== btn ? el.getAttribute?.('title') : '',
        btn.labels && btn.labels.length > 0 ? [...btn.labels].map((l) => extractAccessibleText(l)).join(' ') : '',
        extractAccessibleText(closestComposed(btn, 'label')),
      ];
      let rawLabel = '';
      for (const c of candidates) {
        const n = normLbl(c);
        if (!n) continue;
        if (!rawLabel) rawLabel = n;
        if (/[\p{L}\p{N}]/u.test(n)) {
          rawLabel = n;
          break;
        }
      }
      const cleanLbl = rawLabel.replace(/^[^\p{L}\p{N}]+/u, '').trim();
      const isSafeLbl = Boolean(cleanLbl && safeRe.test(cleanLbl) && !dangerRe.test(cleanLbl));
      const ownForm =
        btn.form ||
        shadowInnerBtn?.form ||
        closestComposed(btn, 'form') ||
        getSR(btn)?.querySelector?.('form') ||
        null;

      if (tag === 'input' && (type === 'submit' || type === 'image')) {
        return {
          isSubmit: !isSafeLbl,
          isSafeSubmit: Boolean(isSafeLbl && ownForm),
          label: rawLabel || 'submit',
          reason: `input[type=${type}]`,
        };
      }
      if (type === 'submit' || type === 'image') {
        return {
          isSubmit: !isSafeLbl,
          isSafeSubmit: Boolean(isSafeLbl && ownForm),
          label: rawLabel || 'submit',
          reason: `${tag}[type=${type}]`,
        };
      }
      const isButtonLike =
        tag === 'button' ||
        Boolean(shadowInnerBtn) ||
        Boolean(hostEl) ||
        role === 'button' ||
        role === 'switch' ||
        role === 'checkbox' ||
        role === 'menuitem' ||
        role === 'menuitemcheckbox' ||
        role === 'menuitemradio' ||
        type === 'button' ||
        type === 'checkbox' ||
        type === 'radio' ||
        tag === 'a';
      if (isButtonLike && cleanLbl) {
        const isMenuRole = /^menuitem/.test(role);
        const plainBtn = (tag === 'button' || role === 'button' || (tag === 'input' && type === 'button')) && !isMenuRole;
        const localUi = plainBtn && localRe.test(cleanLbl);
        const hrefAttr = tag === 'a' ? (btn.getAttribute?.('href') || '').trim() : '';
        const applyNav =
          applyRe.test(cleanLbl) &&
          !isMenuRole &&
          ((tag === 'a' && hrefAttr !== '' && !/^(#|javascript:)/i.test(hrefAttr)) || (!ownForm && (plainBtn || tag === 'a')));
        if ((submitRe.test(cleanLbl) || (safeRe.test(cleanLbl) && dangerRe.test(cleanLbl))) && !isSafeLbl && !localUi && !applyNav) {
          return { isSubmit: true, isSafeSubmit: false, label: rawLabel, reason: 'submit-label-match' };
        }
        if (modalRe.test(cleanLbl) && !isSafeLbl) {
          const dlg = closestComposed(btn, patterns.modalSelector);
          if (dlg) {
            const dlgText = normLbl(`${dlg.getAttribute?.('aria-label') || ''} ${(dlg.textContent || '').slice(0, 600)}`);
            // Only real cookie banners are exempt: "privacy"/"consent" also appear in submit confirmations.
            const isCookieBanner = /cookie|쿠키|クッキー/i.test(dlgText);
            // Date/time pickers confirm a value inside the form, not the form itself.
            let isPicker = false;
            try {
              isPicker = Boolean(
                dlg.querySelector?.(
                  '[role="grid"], input[type="date"], input[type="time"], [class*="calendar" i], [class*="datepicker" i], [class*="date-picker" i], [class*="timepicker" i]'
                )
              );
            } catch {}
            if (!isCookieBanner && !isPicker) {
              return { isSubmit: true, isSafeSubmit: false, label: rawLabel, reason: 'modal-confirm' };
            }
          }
        }
      }
      const isSafeButtonWidget =
        tag === 'button' ||
        Boolean(shadowInnerBtn) ||
        Boolean(hostEl) ||
        role === 'button' ||
        (tag === 'input' && type === 'button');
      return {
        isSubmit: false,
        isSafeSubmit: Boolean(isSafeButtonWidget && isSafeLbl && ownForm),
        label: rawLabel,
        reason: '',
      };
    }, {
      submit: SUBMIT_LABEL_RE.source,
      safe: SAFE_SUBMIT_TYPE_RE.source,
      danger: COMPOUND_DANGER_RE.source,
      modal: MODAL_CONFIRM_RE.source,
      modalSelector: MODAL_SELECTOR,
      localUi: LOCAL_UI_RE.source,
      apply: APPLY_LABEL_RE.source,
    });
  } catch {
    return { isSubmit: false, label: '', reason: '' };
  }
}

async function getDeepElementHandleAtPoint(page, x, y, climbInteractive = false) {
  let curFrame = page.mainFrame();
  let cx = x;
  let cy = y;

  for (let depth = 0; depth < 8; depth++) {
    const stepHandle = await curFrame.evaluateHandle(
      ([px, py, climb]) => {
        const closestComposed = (node, sel) => {
          let cur = node;
          while (cur) {
            if (cur.nodeType === 1 && cur.matches?.(sel)) return cur;
            const root = cur.getRootNode?.();
            cur = cur.assignedSlot || cur.parentElement || (root instanceof ShadowRoot ? root.host : null);
          }
          return null;
        };

        const getSR = (node) => node?.shadowRoot || window.__tbmGetShadowRoot?.(node) || null;
        let hit = document.elementFromPoint(px, py);
        while (hit) {
          const sr = getSR(hit);
          if (sr && typeof sr.elementFromPoint === 'function') {
            const inner = sr.elementFromPoint(px, py);
            if (inner && inner !== hit) {
              hit = inner;
              continue;
            }
          }
          break;
        }
        if (!hit) return null;
        const tag = (hit.tagName || '').toUpperCase();
        if (tag === 'IFRAME' || tag === 'FRAME') {
          return hit;
        }
        if (climb) {
          const interactive = closestComposed(
            hit,
            'button, input[type="submit"], input[type="image"], input[type="button"], [type="submit"], [type="image"], [role="button"], [role="switch"], [role="checkbox"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], a'
          );
          if (interactive) return interactive;
          const lbl = closestComposed(hit, 'label');
          if (lbl && lbl.control) return lbl.control;
          return hit;
        }
        return hit;
      },
      [cx, cy, climbInteractive]
    );

    const elemHandle = stepHandle.asElement();
    if (!elemHandle) {
      return stepHandle;
    }

    const frameOffset = await elemHandle
      .evaluate((el) => {
        const tag = (el.tagName || '').toUpperCase();
        if (tag !== 'IFRAME' && tag !== 'FRAME') return null;
        const rect = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        const padLeft = parseFloat(st.paddingLeft) || 0;
        const padTop = parseFloat(st.paddingTop) || 0;
        return {
          left: rect.left + (el.clientLeft || 0) + padLeft,
          top: rect.top + (el.clientTop || 0) + padTop,
        };
      })
      .catch(() => null);

    if (!frameOffset) {
      return elemHandle;
    }

    const childFrame = await elemHandle.contentFrame().catch(() => null);
    await elemHandle.dispose().catch(() => {});
    if (!childFrame) {
      return await curFrame.evaluateHandle(() => null);
    }
    cx -= frameOffset.left;
    cy -= frameOffset.top;
    curFrame = childFrame;
  }

  return await curFrame.evaluateHandle(() => null);
}

export async function isSubmitAtPoint(page, x, y) {
  let handle = null;
  try {
    handle = await getDeepElementHandleAtPoint(page, x, y, true);
    const empty = await handle.evaluate((el) => !el).catch(() => true);
    if (empty) return { isSubmit: false, label: '', reason: '' };
    return await isSubmitLikeElement(handle);
  } catch {
    return { isSubmit: false, label: '', reason: '' };
  } finally {
    await handle?.dispose().catch(() => {});
  }
}

function checkEnterSubmitInBrowser(target, patterns) {
  const doc = target?.ownerDocument || document;
  const win = doc.defaultView || window;
  if (!target || target === doc.body || target === doc.documentElement) {
    return { isSubmit: false, label: '', reason: '' };
  }
  const isShadowRoot = (r) => Boolean(r && r.nodeType === 11 && 'host' in r);
  const closestComposed = (node, sel) => {
    let cur = node;
    while (cur) {
      if (cur.nodeType === 1 && cur.matches?.(sel)) return cur;
      const root = cur.getRootNode?.();
      cur = cur.assignedSlot || cur.parentElement || (isShadowRoot(root) ? root.host : null);
    }
    return null;
  };
  const isElementFocusableAndVisible = (node) => {
    if (!node || node.nodeType !== 1) return false;
    if (node.disabled || Boolean(node.matches?.(':disabled')) || node.getAttribute?.('aria-disabled') === 'true') return false;
    if (typeof node.checkVisibility === 'function' && node.checkVisibility({ visibilityProperty: true, opacityProperty: false }) === false) return false;
    let cur = node;
    while (cur && cur.nodeType === 1) {
      if (cur.hasAttribute('hidden') || cur.hasAttribute('inert') || Boolean(cur.inert)) return false;
      const parent = cur.parentElement;
      if (parent && parent.tagName === 'DETAILS' && !parent.open) {
        const firstSummary = [...parent.children].find((c) => c.tagName === 'SUMMARY');
        if (!firstSummary || cur !== firstSummary) return false;
      }
      if (parent && parent.tagName === 'FIELDSET' && parent.disabled) {
        const firstLegend = [...parent.children].find((c) => c.tagName === 'LEGEND');
        if (!firstLegend || cur !== firstLegend) return false;
      }
      try {
        const st = getComputedStyle(cur);
        if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse' || st.contentVisibility === 'hidden') return false;
      } catch {}
      const rn = cur.getRootNode?.();
      cur = parent || (isShadowRoot(rn) ? rn.host : null);
    }
    const r = node.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const getSR = (node) => node?.shadowRoot || win.__tbmGetShadowRoot?.(node) || window.__tbmGetShadowRoot?.(node) || null;
  const resolveDelegatedFocus = (host) => {
    let cur = host;
    const seen = new Set();
    while (getSR(cur)?.delegatesFocus && !seen.has(cur)) {
      seen.add(cur);
      const candidates = getSR(cur).querySelectorAll('*');
      let next = null;
      for (const c of candidates) {
        if (!isElementFocusableAndVisible(c)) continue;
        if (getSR(c)?.delegatesFocus) {
          const inner = resolveDelegatedFocus(c);
          if (inner) {
            next = inner;
            break;
          }
          continue;
        }
        const rawTab = c.getAttribute('tabindex');
        const hasValidTab = rawTab !== null && /^\s*[+-]?\d+\s*$/.test(rawTab) && Number(rawTab) >= 0;
        if (
          c.isContentEditable ||
          hasValidTab ||
          (c.matches?.('input:not([type="hidden"]), select, textarea, button, a[href], area[href], summary') && c.tabIndex >= 0)
        ) {
          next = c;
          break;
        }
      }
      if (!next) return null;
      cur = next;
    }
    return cur !== host ? cur : null;
  };
  if (getSR(target)?.delegatesFocus) {
    const df = resolveDelegatedFocus(target);
    if (df) target = df;
  }
  const submitRe = new RegExp(patterns.submit, 'iu');
  const safeRe = new RegExp(patterns.safe, 'iu');
  const dangerRe = new RegExp(patterns.danger, 'iu');
  const effTarget =
    closestComposed(
      target,
      'button, input[type="submit"], input[type="image"], input[type="button"], input[type="checkbox"], input[type="radio"], [type="submit"], [type="image"], [role="button"], [role="switch"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], a'
    ) || target;
  let hostEl = null;
  let hostType = '';
  let hostRole = '';
  let curHost = isShadowRoot(effTarget.getRootNode?.()) ? effTarget.getRootNode().host : null;
  while (curHost) {
    if (!hostEl) hostEl = curHost;
    if (!hostRole) hostRole = (curHost.getAttribute?.('role') || '').toLowerCase();
    const ht = (curHost.getAttribute?.('type') || '').toLowerCase();
    if (ht) {
      hostType = ht;
      break;
    }
    const nextRn = curHost.getRootNode?.();
    curHost = isShadowRoot(nextRn) ? nextRn.host : null;
  }
  const findShadowInnerBtn = (rootHost) => {
    const rootSr = getSR(rootHost);
    if (!rootSr) return { btn: null, type: '' };
    const stack = [rootSr];
    let firstBtn = null;
    while (stack.length > 0) {
      const sr = stack.shift();
      if (!sr || !sr.querySelectorAll) continue;
      for (const node of sr.querySelectorAll('*')) {
        if (
          node.matches?.(
            'button, input[type="submit"], input[type="image"], input[type="button"], [type="submit"], [type="image"], [role="button"]'
          )
        ) {
          if (!firstBtn) firstBtn = node;
          const nTag = (node.tagName || '').toLowerCase();
          const sameScopeForm = Boolean(node.form || node.closest?.('form'));
          const effType = (
            nTag === 'button'
              ? (sameScopeForm ? (node.type || 'submit') : (node.getAttribute?.('type') || ''))
              : (node.getAttribute?.('type') || '')
          ).toLowerCase();
          if (effType === 'submit' || effType === 'image') {
            return { btn: node, type: effType };
          }
        }
        const childSr = getSR(node);
        if (childSr) {
          const childHostType = (node.getAttribute?.('type') || '').toLowerCase();
          if (childHostType !== 'button' && childHostType !== 'reset') {
            stack.push(childSr);
          }
        }
      }
    }
    return { btn: firstBtn, type: '' };
  };
  const shadowInnerInfo = findShadowInnerBtn(effTarget);
  const shadowInnerBtn = shadowInnerInfo.btn;
  const innerType = shadowInnerInfo.type;
  const tag = (effTarget.tagName || '').toLowerCase();
  const sameScopeEffForm = Boolean(effTarget.form || effTarget.closest?.('form'));
  const rawType = (
    tag === 'button'
      ? (sameScopeEffForm && hostType !== 'button' && hostType !== 'reset' ? (effTarget.type || 'submit') : (effTarget.getAttribute?.('type') || ''))
      : (effTarget.getAttribute?.('type') || '')
  ).toLowerCase();
  const type =
    (!sameScopeEffForm && rawType === 'button' && (hostType === 'submit' || hostType === 'image')
      ? hostType
      : rawType) ||
    (hostType === 'submit' || hostType === 'image' || hostType === 'button' || hostType === 'reset' ? hostType : '') ||
    (innerType === 'submit' || innerType === 'image' ? innerType : '');
  const role = (effTarget.getAttribute?.('role') || hostRole || '').toLowerCase();
  const normLbl = (s) =>
    String(s || '')
      .normalize('NFC')
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const BLOCK_TAGS = new Set([
    'DIV', 'P', 'LI', 'UL', 'OL', 'TR', 'TD', 'TH',
    'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'ASIDE', 'NAV',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'BR',
  ]);
  const extractAccessibleText = (rootNode, allowHidden = false) => {
    if (!rootNode) return '';
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE']);
    const walkChildren = (nodes) => {
      let out = '';
      for (const c of nodes || []) {
        const piece = walk(c);
        if (!piece) continue;
        const cTag = c.nodeType === 1 ? (c.tagName || '').toUpperCase() : '';
        if (BLOCK_TAGS.has(cTag)) {
          out += (out && !/\s$/.test(out) ? ' ' : '') + piece + ' ';
        } else {
          out += piece;
        }
      }
      return out;
    };
    const walk = (n) => {
      if (!n) return '';
      if (n.nodeType === 3) return n.textContent || '';
      if (n.nodeType !== 1 && n.nodeType !== 11) return '';
      if (n.nodeType === 1) {
        const t = (n.tagName || '').toUpperCase();
        if (SKIP.has(t)) return '';
        if (t === 'BR') return ' ';
        if (!allowHidden && n !== rootNode) {
          if (n.hasAttribute?.('hidden') || n.getAttribute?.('aria-hidden') === 'true') return '';
          try {
            const st = getComputedStyle(n);
            if (st.display === 'none' || st.visibility === 'hidden') return '';
          } catch {}
        }
        if (t === 'SLOT' && typeof n.assignedNodes === 'function') {
          const assigned = n.assignedNodes({ flatten: true });
          const list = assigned.length > 0 ? assigned : (n.childNodes || []);
          return walkChildren(list);
        }
        const nSr = getSR(n);
        if (nSr) {
          const srOut = walkChildren(nSr.childNodes);
          if (normLbl(srOut)) return srOut;
        }
      }
      return walkChildren(n.childNodes);
    };
    return walk(rootNode);
  };
  const resolveAriaLabelledBy = (node) => {
    const lby = node?.getAttribute?.('aria-labelledby');
    if (!lby) return '';
    const rn = node.getRootNode?.();
    return lby
      .split(/\s+/)
      .map((id) => {
        const refEl = (rn?.getElementById && rn.getElementById(id)) || doc.getElementById(id);
        return extractAccessibleText(refEl, true) || refEl?.textContent || '';
      })
      .join(' ');
  };
  const labelOf = (node) => {
    const nTag = (node.tagName || '').toLowerCase();
    const nType = (node.getAttribute?.('type') || '').toLowerCase();
    const nRn = node.getRootNode?.();
    const nHost = isShadowRoot(nRn) ? nRn.host : null;
    const cands = [
      resolveAriaLabelledBy(node),
      node.getAttribute?.('aria-label'),
      nHost ? resolveAriaLabelledBy(nHost) : '',
      nHost ? nHost.getAttribute?.('aria-label') : '',
      extractAccessibleText(node),
      extractAccessibleText(getSR(node)),
      nHost ? extractAccessibleText(nHost) : '',
      nTag === 'input' && nType !== 'checkbox' && nType !== 'radio' ? node.value : '',
      node.getAttribute?.('alt'),
      node.querySelector?.('[alt]')?.getAttribute?.('alt'),
      node.querySelector?.('[aria-label]')?.getAttribute?.('aria-label'),
      node.querySelector?.('svg title')?.textContent,
      node.getAttribute?.('title'),
      nHost ? nHost.getAttribute?.('title') : '',
      node.labels && node.labels.length > 0 ? [...node.labels].map((l) => extractAccessibleText(l)).join(' ') : '',
      extractAccessibleText(closestComposed(node, 'label')),
    ];
    let first = '';
    for (const c of cands) {
      const n = normLbl(c);
      if (!n) continue;
      if (!first) first = n;
      if (/[\p{L}\p{N}]/u.test(n)) return n;
    }
    return first;
  };
  const cleanLabelOf = (raw) => raw.replace(/^[^\p{L}\p{N}]+/u, '').trim();

  const rawLabel = labelOf(effTarget);
  const cleanLabel = cleanLabelOf(rawLabel);
  const isSafeLbl = Boolean(cleanLabel && safeRe.test(cleanLabel) && !dangerRe.test(cleanLabel));
  const ownForm =
    effTarget.form ||
    shadowInnerBtn?.form ||
    closestComposed(effTarget, 'form') ||
    getSR(effTarget)?.querySelector?.('form') ||
    null;
  if (type === 'submit' || type === 'image') {
    return {
      isSubmit: !isSafeLbl,
      isSafeSubmit: Boolean(isSafeLbl && ownForm),
      label: rawLabel || 'submit',
      reason: `${tag}[type=${type}]`,
    };
  }
  const isButtonLike =
    tag === 'button' ||
    Boolean(shadowInnerBtn) ||
    Boolean(hostEl) ||
    role === 'button' ||
    role === 'switch' ||
    role === 'checkbox' ||
    role === 'radio' ||
    role === 'menuitem' ||
    role === 'menuitemcheckbox' ||
    role === 'menuitemradio' ||
    type === 'button' ||
    type === 'checkbox' ||
    type === 'radio' ||
    tag === 'a';
  if (
    isButtonLike &&
    cleanLabel &&
    (submitRe.test(cleanLabel) || (safeRe.test(cleanLabel) && dangerRe.test(cleanLabel))) &&
    !isSafeLbl
  ) {
    return { isSubmit: true, isSafeSubmit: false, label: rawLabel, reason: 'submit-label-match' };
  }

  let isFormAssocHost = false;
  let fh = isShadowRoot(target.getRootNode?.()) ? target.getRootNode().host : null;
  while (fh) {
    const ctor = win?.customElements?.get?.((fh.tagName || '').toLowerCase());
    if (fh.form || Boolean(ctor?.formAssociated)) {
      isFormAssocHost = true;
      break;
    }
    const nextRn = fh.getRootNode?.();
    fh = isShadowRoot(nextRn) ? nextRn.host : null;
  }

  const form =
    target.form ||
    (isFormAssocHost || Boolean(patterns?.hasCtrlOrMeta)
      ? closestComposed(target, 'form')
      : target.closest?.('form'));
  const isTextEntryInForm =
    (tag === 'input' && !['button', 'reset', 'file'].includes(type)) ||
    (Boolean(patterns?.hasCtrlOrMeta) && (tag === 'textarea' || Boolean(target.isContentEditable) || role === 'textbox'));
  const BLOCKING_INPUT_TYPES = new Set([
    'text', 'search', 'url', 'tel', 'email', 'password',
    'date', 'month', 'week', 'time', 'datetime-local', 'number',
  ]);
  if (form && isTextEntryInForm) {
    const formRoot = form.getRootNode?.() || doc;
    const extImages = formRoot.querySelectorAll
      ? [...formRoot.querySelectorAll('input[type="image"][form]')].filter((el) => el.form === form)
      : [];
    const descendantBtns = [...form.querySelectorAll('button, input[type="submit"], input[type="image"]')].filter(
      (el) => !el.hasAttribute?.('form') || el.form === form
    );
    const candidates = new Set([
      ...(form.elements ? [...form.elements] : []),
      ...descendantBtns,
      ...extImages,
    ]);
    const submitBtns = [];
    for (const el of candidates) {
      if (!el || el.disabled || Boolean(el.matches?.(':disabled'))) continue;
      if (el.form && el.form !== form) continue;
      const bTag = (el.tagName || '').toLowerCase();
      const bType = (
        bTag === 'button'
          ? (el.type || 'submit')
          : (el.getAttribute?.('type') || '')
      ).toLowerCase();
      if ((bTag === 'button' && bType === 'submit') || (bTag === 'input' && (bType === 'submit' || bType === 'image'))) {
        submitBtns.push(el);
      }
    }
    if (submitBtns.length === 0) {
      let blockingInputs = 0;
      for (const el of candidates) {
        if (!el || (el.tagName || '').toLowerCase() !== 'input') continue;
        if (el.form && el.form !== form) continue;
        const iType = (el.type || el.getAttribute?.('type') || 'text').toLowerCase();
        if (BLOCKING_INPUT_TYPES.has(iType)) {
          blockingInputs++;
        }
      }
      const targetInputType = tag === 'input' ? (effTarget.type || type || 'text').toLowerCase() : '';
      const targetCanImplicitSubmit =
        Boolean(patterns?.hasCtrlOrMeta) ||
        Boolean(isFormAssocHost) ||
        (tag === 'input' && BLOCKING_INPUT_TYPES.has(targetInputType));
      if (targetCanImplicitSubmit && (blockingInputs <= 1 || Boolean(patterns?.hasCtrlOrMeta))) {
        return { isSubmit: true, isSafeSubmit: false, label: rawLabel || target.name || 'form', reason: 'implicit-form-enter' };
      }
      return { isSubmit: false, isSafeSubmit: false, label: rawLabel, reason: '' };
    }
    submitBtns.sort((a, b) => {
      if (a === b || typeof a.compareDocumentPosition !== 'function') return 0;
      const pos = a.compareDocumentPosition(b);
      if (pos & 4) return -1;
      if (pos & 2) return 1;
      return 0;
    });
    const defaultBtn = submitBtns[0];
    const btnRaw = labelOf(defaultBtn);
    const btnClean = cleanLabelOf(btnRaw);
    const btnSafe = Boolean(btnClean && safeRe.test(btnClean) && !dangerRe.test(btnClean));
    if (submitRe.test(btnClean) || !btnSafe) {
      return { isSubmit: true, isSafeSubmit: false, label: btnRaw || 'submit', reason: 'implicit-form-enter' };
    }
    return { isSubmit: false, isSafeSubmit: true, label: rawLabel, reason: '' };
  }

  const isSafeButtonWidget =
    tag === 'button' ||
    Boolean(shadowInnerBtn) ||
    Boolean(hostEl) ||
    role === 'button' ||
    (tag === 'input' && type === 'button');
  return {
    isSubmit: false,
    isSafeSubmit: Boolean(isSafeButtonWidget && isSafeLbl && ownForm),
    label: rawLabel,
    reason: '',
  };
}

async function isEnterSubmitTarget(page, locator, extra = {}) {
  const patterns = {
    submit: SUBMIT_LABEL_RE.source,
    safe: SAFE_SUBMIT_TYPE_RE.source,
    danger: COMPOUND_DANGER_RE.source,
    hasCtrlOrMeta: Boolean(extra.hasCtrlOrMeta),
  };
  if (locator) {
    try {
      return await locator.evaluate(checkEnterSubmitInBrowser, patterns);
    } catch {
      return { isSubmit: false, label: '', reason: '' };
    }
  }
  let handle = null;
  try {
    handle = await page.evaluateHandle(() => {
      const getSR = (node) => node?.shadowRoot || window.__tbmGetShadowRoot?.(node) || null;
      let cur = document.activeElement;
      while (cur) {
        const sr = getSR(cur);
        if (sr && sr.activeElement) {
          cur = sr.activeElement;
          continue;
        }
        const tag = (cur.tagName || '').toUpperCase();
        if ((tag === 'IFRAME' || tag === 'FRAME') && cur.contentDocument && cur.contentDocument.activeElement) {
          cur = cur.contentDocument.activeElement;
          continue;
        }
        break;
      }
      return cur || null;
    });
    const hasActive = await handle.evaluate((el) => Boolean(el)).catch(() => false);
    if (hasActive) {
      const mainRes = await handle.evaluate(checkEnterSubmitInBrowser, patterns);
      if (mainRes && (mainRes.isSubmit || mainRes.isSafeSubmit)) return mainRes;
    }
  } catch {
    // Fall through to child frame inspection.
  } finally {
    await handle?.dispose().catch(() => {});
  }

  for (const fInfo of getAllFrames(page).slice(1)) {
    let fHandle = null;
    try {
      fHandle = await fInfo.frame.evaluateHandle(() => {
        const getSR = (node) => node?.shadowRoot || window.__tbmGetShadowRoot?.(node) || null;
        let cur = document.activeElement;
        while (cur) {
          const sr = getSR(cur);
          if (sr && sr.activeElement) {
            cur = sr.activeElement;
            continue;
          }
          break;
        }
        if (!cur || cur === document.body || cur === document.documentElement) return null;
        return cur;
      });
      const hasChildActive = await fHandle.evaluate((el) => Boolean(el)).catch(() => false);
      if (hasChildActive) {
        const fRes = await fHandle.evaluate(checkEnterSubmitInBrowser, patterns);
        if (fRes && (fRes.isSubmit || fRes.isSafeSubmit)) return fRes;
      }
    } catch {
      // Ignore detached frames.
    } finally {
      await fHandle?.dispose().catch(() => {});
    }
  }

  return { isSubmit: false, label: '', reason: '' };
}

/**
 * Build a token-efficient snapshot across frames & open Shadow DOM (capped at maxChars),
 * assigning deterministic data-tbm-ref IDs and supporting query, onlyChanged delta, boxes, and savePath.
 */
const snapshotBaselines = new WeakMap();

// Same label rules the submit guard uses, applied to a snapshot line: `[f0:e3] <button> "Submit"`.
function isSubmitLikeLine(line) {
  const m = /^\[[^\]]+\] <([^>]+)> "([^"]*)"/.exec(line);
  if (!m || !/^(button|input:(submit|button|image)|\w+:button)$/.test(m[1])) return false;
  const label = m[2].trim();
  return SUBMIT_LABEL_RE.test(label) || (SAFE_SUBMIT_TYPE_RE.test(label) && COMPOUND_DANGER_RE.test(label));
}

export async function inspectCompact(page, options = {}, previousLinesSet = null) {
  const t0 = Date.now();
  const mode = options.mode || 'interactive';
  const maxChars = Math.max(200, Number(options.maxChars) || 4000);
  const includeFrames = options.includeFrames !== false;
  const rootSelector = options.selector || null;
  const query = options.query ? String(options.query) : '';
  const onlyChanged = Boolean(options.onlyChanged);
  const boxes = Boolean(options.boxes);
  const queryRe = query ? compileFilterRegex(query) : null;

  const allFrames = getAllFrames(page);
  const urlKey = `__url__:${page.url()}`;
  const hadBaseline = Boolean(previousLinesSet && previousLinesSet.size > 0);
  const sameUrlAsBaseline = Boolean(previousLinesSet && previousLinesSet.has(urlKey));
  // One baseline per mode: a snapshot in another mode (an action's returnSnapshot) must not replace this mode's.
  const store = sameUrlAsBaseline ? snapshotBaselines.get(previousLinesSet) : null;
  const baseline = store?.byMode?.get(mode) || null;
  const sameScope = baseline?.includeFrames === includeFrames;
  // Refs are never recycled within a document: attributes persist on live elements and new refs start above
  // the per-document high-water mark (window.__tbmRefHigh), so a stale ref can only fail, never hit another element.
  const preserveRefs = true;
  const frames = includeFrames ? allFrames : allFrames.slice(0, 1);
  let nextRefNum = store?.nextRefNum || 1;
  if (allFrames.length > 1) {
    // Keep bare eN unique across frames: start above the highest ref any frame already holds.
    for (const frameInfo of allFrames) {
      const high = await frameInfo.frame
        .evaluate(() => {
          let max = Number(window.__tbmRefHigh) || 0;
          const stack = [document];
          while (stack.length > 0) {
            const cur = stack.shift();
            if (!cur || !cur.querySelectorAll) continue;
            for (const el of cur.querySelectorAll('[data-tbm-ref]')) {
              const m = /^e(\d+)$/i.exec(el.getAttribute('data-tbm-ref') || '');
              if (m && Number(m[1]) > max) max = Number(m[1]);
            }
            for (const node of cur.querySelectorAll('*')) {
              if (node.shadowRoot) stack.push(node.shadowRoot);
            }
          }
          return max;
        })
        .catch(() => 0);
      if (high >= nextRefNum) nextRefNum = high + 1;
    }
  }
  const entries = [];
  const nextSignatures = new Set();
  const nextRefs = new Map();
  const scannedFrames = new Set();
  let totalMatched = 0;

  for (const frameInfo of frames) {
    let chunk;
    try {
      chunk = await frameInfo.frame.evaluate(
        ({ modeArg, frameIdxArg, startRef, rootSel, boxesArg, preserveRefsArg }) => {
          const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

          const queryAllDeep = (rootNode, sel) => {
            const seen = new Set();
            const out = [];
            const stack = [rootNode];
            while (stack.length > 0) {
              const cur = stack.shift();
              if (!cur) continue;
              if (cur.shadowRoot) {
                stack.push(cur.shadowRoot);
              }
              if (!cur.querySelectorAll) continue;
              let matches;
              try {
                matches = cur.querySelectorAll(sel);
              } catch {
                return out;
              }
              for (const match of matches) {
                if (!seen.has(match)) {
                  seen.add(match);
                  out.push(match);
                }
              }
              for (const node of cur.querySelectorAll('*')) {
                if (node.shadowRoot) {
                  stack.push(node.shadowRoot);
                }
              }
            }
            return out;
          };

          let refCounter = Math.max(startRef, (Number(window.__tbmRefHigh) || 0) + 1);
          for (const oldRefEl of queryAllDeep(document, '[data-tbm-ref]')) {
            const m = /^e(\d+)$/i.exec(oldRefEl.getAttribute('data-tbm-ref') || '');
            if (m) {
              const num = Number(m[1]);
              if (num >= refCounter) refCounter = num + 1;
            }
          }

          const isDisabledByFieldset = (node) => {
            let cur = node;
            while (cur && cur.nodeType === 1) {
              const parent = cur.parentElement;
              if (parent && parent.tagName === 'FIELDSET' && parent.disabled) {
                const firstLegend = [...parent.children].find((c) => c.tagName === 'LEGEND');
                if (!firstLegend || cur !== firstLegend) return true;
              }
              const rn = cur.getRootNode?.();
              cur = parent || (rn instanceof ShadowRoot ? rn.host : null);
            }
            return false;
          };

          const isInert = (node) => {
            let cur = node;
            while (cur && cur.nodeType === 1) {
              if (cur.hasAttribute('inert') || Boolean(cur.inert)) return true;
              const rn = cur.getRootNode?.();
              cur = cur.parentElement || (rn instanceof ShadowRoot ? rn.host : null);
            }
            return false;
          };

          const isClosedDetailsOrCvHidden = (node) => {
            let cur = node;
            while (cur && cur.nodeType === 1) {
              const parent = cur.parentElement;
              if (parent && parent.tagName === 'DETAILS' && !parent.open) {
                const firstSummary = [...parent.children].find((c) => c.tagName === 'SUMMARY');
                if (!firstSummary || cur !== firstSummary) return true;
              }
              try {
                if (getComputedStyle(cur).contentVisibility === 'hidden') return true;
              } catch {
                // ignore
              }
              const rn = cur.getRootNode?.();
              cur = parent || (rn instanceof ShadowRoot ? rn.host : null);
            }
            return false;
          };

          const isHidden = (el) => {
            if (isInert(el) || isClosedDetailsOrCvHidden(el)) return true;
            if (el.getAttribute('aria-hidden') === 'true' || Boolean(el.closest('[aria-hidden="true"]'))) {
              return true;
            }
            if (el.tagName === 'INPUT' && el.type === 'file') return false;
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
              return true;
            }
            const rect = el.getBoundingClientRect();
            return rect.width === 0 || rect.height === 0;
          };

          const rootMatches = rootSel ? queryAllDeep(document, rootSel) : [document.body];
          const root = rootMatches.find((el) => el && !isHidden(el)) || rootMatches[0];
          if (!root) return { items: [], nextRef: refCounter, total: 0 };

          const resolveById = (el, id) => {
            const rootNode = el.getRootNode?.();
            return (rootNode?.getElementById && rootNode.getElementById(id)) || document.getElementById(id);
          };

          const closestComposed = (node, sel) => {
            let cur = node;
            while (cur) {
              if (cur.nodeType === 1 && cur.matches?.(sel)) return cur;
              const rn = cur.getRootNode?.();
              cur = cur.assignedSlot || cur.parentElement || (rn instanceof ShadowRoot ? rn.host : null);
            }
            return null;
          };

          const BLOCK_TAGS = new Set([
            'DIV', 'P', 'LI', 'UL', 'OL', 'TR', 'TD', 'TH',
            'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'ASIDE', 'NAV',
            'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'BR',
          ]);
          const getSR = (node) => node?.shadowRoot || window.__tbmGetShadowRoot?.(node) || null;
          const composedText = (rootNode, allowHidden = false) => {
            if (!rootNode) return '';
            const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'SELECT', 'OPTION']);
            const walkChildren = (nodes) => {
              let out = '';
              for (const c of nodes || []) {
                const piece = walk(c);
                if (!piece) continue;
                const cTag = c.nodeType === 1 ? (c.tagName || '').toUpperCase() : '';
                if (BLOCK_TAGS.has(cTag)) {
                  out += (out && !/\s$/.test(out) ? ' ' : '') + piece + ' ';
                } else {
                  out += piece;
                }
              }
              return out;
            };
            const walk = (n) => {
              if (!n) return '';
              if (n.nodeType === 3) return n.textContent || '';
              if (n.nodeType !== 1 && n.nodeType !== 11) return '';
              if (n.nodeType === 1) {
                const t = (n.tagName || '').toUpperCase();
                if (SKIP.has(t)) return '';
                if (t === 'BR') return ' ';
                if (!allowHidden && n !== rootNode) {
                  if (n.hasAttribute?.('hidden') || n.getAttribute?.('aria-hidden') === 'true') return '';
                  try {
                    const st = getComputedStyle(n);
                    if (st.display === 'none' || st.visibility === 'hidden') return '';
                  } catch {}
                }
                if (t === 'SLOT' && typeof n.assignedNodes === 'function') {
                  const assigned = n.assignedNodes({ flatten: true });
                  const list = assigned.length > 0 ? assigned : (n.childNodes || []);
                  return walkChildren(list);
                }
                const sr = getSR(n);
                if (sr) {
                  const srOut = walkChildren(sr.childNodes);
                  if (clean(srOut)) return srOut;
                }
              }
              return walkChildren(n.childNodes);
            };
            return clean(walk(rootNode));
          };


          // Visible label that is a preceding <label>/[class*=label] in the field container, with no `for` link
          // (Zoho Recruit style). Walks up at most 4 ancestors; stops when the container holds another field.
          const nearestFieldLabel = (el) => {
            const FIELD_SEL =
              'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]):not([type="reset"]), textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]';
            let cur = el;
            let prevChild = el;
            for (let up = 0; up < 4 && cur.parentElement; up++) {
              cur = cur.parentElement;
              let fields = 0;
              try {
                fields = cur.querySelectorAll(FIELD_SEL).length;
              } catch {}
              if (fields > 1) return '';
              let best = '';
              for (const c of cur.querySelectorAll('label, [class*="label" i]')) {
                if (c.contains(el) || !(c.compareDocumentPosition(el) & 4)) continue;
                const forId = c.getAttribute?.('for');
                if (forId && forId !== el.id && document.getElementById(forId)) continue;
                if (c.querySelector('input, select, textarea, button')) continue;
                const t = clean(c.innerText || c.textContent).replace(/\s*[*\uFF0A]+$/, '');
                if (t && t.length <= 80 && /[\p{L}\p{N}]/u.test(t)) best = t;
              }
              if (best) return best;
              // Plain sibling block before the field (no label element): "First Name*" in a <div>.
              const sib = up < 3 ? prevChild.previousElementSibling : null;
              if (sib && !sib.matches(FIELD_SEL) && !sib.querySelector(FIELD_SEL) && !sib.querySelector('button, a')) {
                const t = clean(sib.innerText || sib.textContent).replace(/\s*[*\uFF0A]+$/, '');
                if (t && t.length <= 60 && /[\p{L}\p{N}]/u.test(t)) return t;
              }
              prevChild = cur;
            }
            return '';
          };

          const labelFor = (el) => {
            const aria = clean(el.getAttribute('aria-label'));
            if (aria) return aria.slice(0, 80);

            if (el.labels && el.labels.length > 0) {
              const lblText = [...el.labels]
                .map((l) => composedText(l) || clean(l.innerText))
                .filter(Boolean)
                .join(' ');
              if (lblText) return lblText.replace(/\s*[*\uFF0A]+$/, '').slice(0, 80);
            }

            const lby = el.getAttribute('aria-labelledby');
            if (lby) {
              const txt = lby
                .split(/\s+/)
                .map((id) => {
                  const refNode = resolveById(el, id);
                  return composedText(refNode, true) || clean(refNode?.innerText);
                })
                .filter(Boolean)
                .join(' ');
              if (txt) return txt.slice(0, 80);
            }

            const wrapLabel = closestComposed(el, 'label');
            const wrapTxt = wrapLabel ? (composedText(wrapLabel) || clean(wrapLabel.innerText)) : '';
            if (wrapTxt) {
              return wrapTxt.replace(/\s*[*\uFF0A]+$/, '').slice(0, 80);
            }

            const tag = el.tagName;
            let fallbackVis = '';
            if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && !el.isContentEditable) {
              const sr = getSR(el);
              const visText =
                composedText(el) ||
                clean(el.innerText || el.textContent || sr?.innerText || sr?.textContent);
              if (visText) {
                if (/[\p{L}\p{N}]/u.test(visText)) return visText.slice(0, 80);
                fallbackVis = visText;
              }
            }

            for (const attr of ['placeholder', 'data-placeholder', 'title', 'name', 'id']) {
              if (attr === 'name' && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable)) {
                const near = nearestFieldLabel(el);
                if (near) return near.slice(0, 80);
              }
              const v = clean(el.getAttribute(attr));
              if (v) return v.slice(0, 80);
            }

            if (fallbackVis) return fallbackVis.slice(0, 80);

            return (
              composedText(el) ||
              clean(el.innerText || el.textContent || el.shadowRoot?.innerText || el.shadowRoot?.textContent)
            ).slice(0, 80);
          };

          const selectorByMode = {
            interactive:
              'a[href], button, input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="radio"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"], summary',
            forms:
              'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="radio"], [role="checkbox"], [role="switch"], button, [role="button"]',
            article: 'h1, h2, h3, h4, p, li, a[href], button',
            all: 'h1, h2, h3, a[href], button, input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="textbox"], [role="combobox"], [role="radio"], [role="checkbox"], [role="switch"], p',
          };

          const sel = selectorByMode[modeArg] || selectorByMode.interactive;
          const rawNodes = queryAllDeep(root, sel);
          if (root.nodeType === 1 && root.matches?.(sel) && !rawNodes.includes(root)) {
            rawNodes.unshift(root);
          }
          // Inside an open dialog/modal, custom controls (a <p>Close</p> with a pointer cursor or onclick)
          // are the only way out, so list them too. Only runs when a visible dialog exists.
          if (modeArg === 'interactive') {
            let added = 0;
            for (const dlg of queryAllDeep(root, '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], .modal')) {
              if (added >= 40) break;
              if (isHidden(dlg)) continue;
              for (const el of queryAllDeep(dlg, '*').slice(0, 800)) {
                if (added >= 40) break;
                if (rawNodes.includes(el) || el.matches?.(sel) || el.closest?.(sel) || !clean(el.textContent)) continue;
                let clickable = el.hasAttribute('onclick');
                if (!clickable) {
                  try {
                    const cur = getComputedStyle(el).cursor === 'pointer';
                    clickable = cur && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== 'pointer');
                  } catch {}
                }
                if (clickable && !isHidden(el)) {
                  rawNodes.push(el);
                  added++;
                }
              }
            }
            // Elsewhere a pointer cursor alone is too common (whole cards); require a handler signal as well:
            // an onclick attribute or a tabindex. Cheap attribute selector first, computed style only on those.
            let extra = 0;
            for (const el of queryAllDeep(root, '[onclick], [tabindex]:not([tabindex="-1"])')) {
              if (extra >= 20) break;
              if (rawNodes.includes(el) || el.matches?.(sel) || el.closest?.(sel)) continue;
              const txt = clean(el.textContent);
              if (!txt || txt.length > 120) continue;
              let ptr = false;
              try { ptr = getComputedStyle(el).cursor === 'pointer'; } catch {}
              if (ptr && !isHidden(el)) {
                rawNodes.push(el);
                extra++;
              }
            }
          }
          const nodes = rawNodes.filter((el) => !isHidden(el));

          const usedRefs = new Set();
          const items = [];
          for (const el of nodes) {
            const tag = el.tagName.toLowerCase();
            let refId = preserveRefsArg ? el.getAttribute('data-tbm-ref') : null;
            if (!refId || !/^e\d+$/i.test(refId) || usedRefs.has(refId)) {
              refId = `e${refCounter++}`;
              el.setAttribute('data-tbm-ref', refId);
            }
            usedRefs.add(refId);
            const fullRef = `f${frameIdxArg}:${refId}`;
            const inShadow = el.getRootNode?.() instanceof ShadowRoot;
            const shadowTag = inShadow ? ' [shadow]' : '';

            if (modeArg === 'article' && (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'p' || tag === 'li')) {
              const txt = (composedText(el) || clean(el.innerText || el.textContent)).slice(0, 220);
              if (txt) {
                const line = `[${fullRef}] <${tag}> ${txt}`;
                items.push({ ref: fullRef, line, sig: `f${frameIdxArg}:<${tag}>:${txt}` });
              }
              continue;
            }

            const role = el.getAttribute('role');
            const type = el.getAttribute('type') || '';
            const isComboInput =
              tag === 'input' && (role === 'combobox' || Boolean(el.getAttribute('aria-autocomplete')));
            const kind = isComboInput
              ? 'input:combobox'
              : tag === 'input'
              ? `input:${type || 'text'}`
              : el.isContentEditable
                ? `${tag}:editable`
                : role
                  ? `${tag}:${role}`
                  : tag;

            let lbl = labelFor(el);
            if (tag === 'input' && /^react-select-\d+-input$/.test(lbl)) {
              // Auto-generated id: use short visible text of the nearby wrapper instead (placeholder/value).
              let host = el.parentElement;
              for (let up = 0; host && up < 3; up++, host = host.parentElement) {
                const near = clean(host.innerText || host.textContent);
                if (near && near.length <= 60) {
                  lbl = near;
                  break;
                }
              }
            }
            let extra = '';
            if (tag === 'input' || tag === 'textarea' || tag === 'select') {
              if (type === 'checkbox' || type === 'radio') {
                extra += el.checked ? ' [checked]' : '';
              } else if (type === 'file') {
                const style = getComputedStyle(el);
                if (style.display === 'none' || Number(style.opacity) === 0) extra += ' [hidden-file]';
              } else if (el.value) {
                extra += ` val="${clean(el.value).slice(0, 40)}"`;
              }
            } else if (role === 'checkbox' || role === 'radio' || role === 'switch') {
              if (el.getAttribute('aria-checked') === 'true') extra += ' [checked]';
            } else if (el.isContentEditable) {
              const txt = clean(el.innerText);
              if (txt) extra += ` val="${txt.slice(0, 40)}"`;
            } else if (tag === 'a' && el.getAttribute('href')) {
              const rawHref = el.getAttribute('href');
              let shownHref = rawHref;
              try {
                const isAbs = /^(https?:)?\/\//i.test(rawHref);
                const u = new URL(el.href || rawHref, location.href);
                if (/^https?:$/.test(u.protocol) && (isAbs || rawHref.includes('?'))) {
                  const TRACK = /^(utm_.*|trk|trkinfo|refid|trackingid|fbclid|gclid|mc_[a-z]+|ref_src|igshid)$/i;
                  for (const k of [...u.searchParams.keys()]) if (TRACK.test(k)) u.searchParams.delete(k);
                  if (isAbs) {
                    shownHref = u.origin === location.origin ? `${u.pathname}${u.search}${u.hash}` : u.href;
                  } else {
                    shownHref = `${rawHref.slice(0, rawHref.indexOf('?'))}${u.search}${u.hash}`;
                  }
                }
              } catch {
                shownHref = rawHref;
              }
              extra += ` href="${shownHref.slice(0, 120)}"`;
            }

            if (
              el.disabled ||
              Boolean(el.matches?.(':disabled')) ||
              isDisabledByFieldset(el) ||
              el.getAttribute('aria-disabled') === 'true' ||
              Boolean(el.closest?.('[aria-disabled="true"]'))
            ) {
              extra += ' [disabled]';
            }
            if (el.required || el.getAttribute('aria-required') === 'true') extra += ' [req]';

            let boxTag = '';
            if (boxesArg) {
              const br = el.getBoundingClientRect();
              boxTag = ` [box=${Math.round(br.x)},${Math.round(br.y)},${Math.round(br.width)},${Math.round(br.height)}]`;
            }

            const line = `[${fullRef}] <${kind}> "${lbl}"${extra}${shadowTag}${boxTag}`;
            const sig = `f${frameIdxArg}:<${kind}> "${lbl}"${extra}${shadowTag}`;
            items.push({ ref: fullRef, line, sig });
          }
          try {
            Object.defineProperty(window, '__tbmRefHigh', { value: refCounter - 1, writable: true, configurable: true, enumerable: false });
          } catch {}
          return { items, nextRef: refCounter, total: items.length };
        },
        {
          modeArg: mode,
          frameIdxArg: frameInfo.frameIdx,
          startRef: nextRefNum,
          rootSel: rootSelector,
          boxesArg: boxes,
          preserveRefsArg: preserveRefs,
        }
      );
    } catch {
      continue;
    }

    if (!chunk) continue;
    scannedFrames.add(`f${frameInfo.frameIdx}`);
    nextRefNum = chunk.nextRef;
    totalMatched += chunk.total;

    const frameItems = [];
    for (const item of chunk.items) {
      nextSignatures.add(item.sig);
      nextRefs.set(item.ref, item.sig);
      if (queryRe && !queryRe.test(item.line)) continue;
      if (onlyChanged && sameScope) {
        if (!baseline.refs.has(item.ref)) {
          frameItems.push(`*${item.line}`); // new since the last snapshot
          continue;
        }
        // An unchanged submit-like control stays visible so the model knows it exists.
        if (baseline.refs.get(item.ref) === item.sig && !isSubmitLikeLine(item.line)) continue;
      }
      frameItems.push(item.line);
    }

    if (!frameInfo.isMain && frameItems.length > 0) {
      entries.push(`--- iframe f${frameInfo.frameIdx} (${frameInfo.url.slice(0, 80)}) ---`);
    }
    for (const line of frameItems) {
      entries.push(line);
    }
  }

  let removedLine = '';
  if (onlyChanged && sameScope && !query && !rootSelector) {
    const removed = [...baseline.refs.keys()].filter((ref) =>
      !nextRefs.has(ref) && (scannedFrames.has(ref.split(':')[0]) ||
        !frames.some((f) => `f${f.frameIdx}` === ref.split(':')[0])));
    if (removed.length) {
      removedLine = `Removed: ${removed.slice(0, 30).join(', ')}${removed.length > 30 ? ` +${removed.length - 30} more` : ''}`;
    }
  }

  let title = '';
  try {
    title = await page.title();
  } catch {
    title = '';
  }

  const filterNote = `${query ? ` | Query: "${query}"` : ''}${onlyChanged ? ' | Delta: true' : ''}`;
  const urlChangedNote = onlyChanged && hadBaseline && !sameUrlAsBaseline
    ? 'URL changed: full snapshot\n'
    : '';
  const header = `URL: ${page.url()}\nTitle: ${title}\nMode: ${mode} | Frames: ${frames.length} | Elements: ${totalMatched}${filterNote}\n${urlChangedNote}`;
  let body = '';
  let shownCount = 0;
  let truncated = false;
  const trailerReserve = 64;

  for (const line of entries) {
    const candidate = body ? `${body}\n${line}` : line;
    if (header.length + candidate.length + trailerReserve + (removedLine ? removedLine.length + 1 : 0) > maxChars) {
      truncated = true;
      break;
    }
    body = candidate;
    if (/^\*?\[f/.test(line)) shownCount++;
  }

  if (previousLinesSet && !query && !rootSelector) {
    // Lines cut off by maxChars were never shown: leave them out of the baseline so the next delta reports them.
    if (truncated) {
      const cutAt = entries.indexOf(body.split('\n').pop()) + 1;
      for (const line of entries.slice(cutAt)) {
        const ref = /^\*?\[(f\d+:e\d+)\]/.exec(line)?.[1];
        if (ref) nextRefs.delete(ref);
      }
    }
    previousLinesSet.clear();
    previousLinesSet.add(urlKey);
    for (const s of nextSignatures) previousLinesSet.add(s);
    const byMode = sameUrlAsBaseline && store ? store.byMode : new Map();
    byMode.set(mode, { refs: nextRefs, includeFrames });
    snapshotBaselines.set(previousLinesSet, { byMode, nextRefNum });
  }

  let text = `${header}${body}${removedLine ? `\n${removedLine}` : ''}`;
  if (truncated) {
    text += `\n... [truncated: ${shownCount}/${totalMatched} elements]`;
  }
  if (text.length > maxChars) {
    truncated = true;
    text = text.slice(0, maxChars);
  }
  // savePath gets the full uncapped snapshot; the returned text stays capped.
  const fullText = options.savePath ? [`${header}${entries.join('\n')}`, removedLine].filter(Boolean).join('\n') : text;
  const savedPath = writeSaveFile(options.savePath, fullText);

  return {
    text,
    fullChars: savedPath && fullText.length > text.length ? fullText.length : undefined,
    url: page.url(),
    title,
    mode,
    framesScanned: frames.length,
    totalInteractive: totalMatched,
    shownCount,
    truncated,
    charCount: text.length,
    savePath: savedPath,
    elapsedMs: Date.now() - t0,
  };
}

/**
 * Fill React-controlled inputs, contenteditable editors, selects, ARIA comboboxes,
 * radios/checkboxes, open Shadow DOM fields, Gmail compose dialogs, iframe fields,
 * and direct disk file inputs.
 */
// Late hydration can replace a field right after we filled it. On a young page, wait briefly, re-check each text
// fill (marked data-tbm-fill) and refill once the ones whose element vanished or lost its value.
const RECHECK_SETTLE_MS = 350;

// Web components (Reddit "faceplate" inputs) can ignore a programmatic value: the inner input holds it, the component
// state and its Save button do not. In-page probe, only run for fields that sit inside a shadow root. Takes an element
// (locator.evaluate) or a list of data-tbm-fill ids (frame.evaluate, returns the stale ids).
function commitStaleProbe(arg) {
  const getSR = (n) => n?.shadowRoot || window.__tbmGetShadowRoot?.(n) || null;
  const deep = (root, sel) => {
    const out = [];
    const stack = [root];
    while (stack.length) {
      const cur = stack.shift();
      if (!cur) continue;
      const own = cur.nodeType === 1 ? getSR(cur) : null;
      if (own) stack.push(own);
      if (!cur.querySelectorAll) continue;
      try { out.push(...cur.querySelectorAll(sel)); } catch { /* ignore */ }
      for (const n of cur.querySelectorAll('*')) { const s = getSR(n); if (s) stack.push(s); }
    }
    return out;
  };
  const up = (n) => {
    const rn = n.getRootNode?.();
    return n.parentElement || (rn instanceof ShadowRoot ? rn.host : null);
  };
  const COMMIT = /^(save|ok|okay|done|apply|add|update|confirm|submit|create|continue|next|set)(?![\p{L}\p{N}_])/iu;
  const isOff = (b) => Boolean(b.matches?.(':disabled') || b.getAttribute('aria-disabled') === 'true');
  const stale = (el) => {
    if (!(el.getRootNode?.() instanceof ShadowRoot)) return false;
    const host = el.getRootNode().host;
    if (host && typeof host.value === 'string' && host.value !== String(el.value ?? '')) return true;
    let box = el;
    while (box && !(box.nodeType === 1 && box.matches('form, dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]'))) box = up(box);
    if (!box) return false;
    const commits = deep(box, 'button, input[type="submit"], [role="button"]').filter((b) => {
      const label = (b.getAttribute('aria-label') || b.innerText || b.value || '').replace(/\s+/g, ' ').trim();
      return b.type === 'submit' || COMMIT.test(label);
    });
    return commits.length > 0 && commits.every(isOff);
  };
  if (Array.isArray(arg)) return arg.filter((id) => deep(document, `[data-tbm-fill="${id}"]`).some(stale));
  return stale(arg);
}

// Fallback for such fields: focus, select all and type for real (trusted key events). Returns true when typed.
async function retypeField(page, locator, val) {
  if (/[\r\n]/.test(val)) return false;
  try {
    await locator.focus({ timeout: 1500 });
    await page.keyboard.press('ControlOrMeta+a');
    if (val === '') await page.keyboard.press('Backspace');
    else await page.keyboard.type(val);
    return true;
  } catch {
    return false;
  }
}
async function recheckFilled(page, spec, filled) {
  const textFills = filled.filter((e) => e && e.value !== undefined && ['input', 'textarea', 'contenteditable'].includes(e.tag));
  if (textFills.length === 0) return 0;
  const frames = getAllFrames(page);
  const frameOf = (e) => frames.find((f) => f.frameIdx === e.frameIdx)?.frame;
  const probe = (frame) =>
    Promise.race([
      frame.evaluate(() => document.readyState !== 'complete' || performance.now() < 3000).catch(() => false),
      new Promise((r) => setTimeout(() => r(false), 300)),
    ]);
  const fills = [...new Set(textFills.map(frameOf).filter(Boolean))];
  const young = (await Promise.all(fills.map(probe))).some(Boolean);
  if (!young) return 0;
  await new Promise((r) => setTimeout(r, RECHECK_SETTLE_MS));
  const bad = new Set();
  for (const e of textFills) {
    const frame = frameOf(e);
    if (!frame) continue;
    const ok = await frame
      .evaluate((idx) => {
        const els = [...document.querySelectorAll(`[data-tbm-fill="${idx}"]`)];
        if (els.length === 0) return false;
        return els.every((el) => el.isConnected && String(el.isContentEditable ? el.textContent : el.value ?? '').trim() !== '');
      }, String(e.idx))
      .catch(() => true);
    if (!ok) bad.add(e.idx);
  }
  if (bad.size === 0) return 0;
  const idxs = [...bad];
  const sub = await smartFillForm(page, {
    ...spec,
    fields: idxs.map((i) => spec.fields[i]),
    overwrite: false,
    main: undefined,
    gmail: undefined,
    returnSnapshot: false,
    _noRecheck: true,
  });
  let n = 0;
  for (const e of sub.filled || []) {
    const orig = idxs[e.idx];
    for (let k = filled.length - 1; k >= 0; k--) if (filled[k].idx === orig && filled[k].tag === e.tag) filled.splice(k, 1);
    filled.push({ ...e, idx: orig });
    n++;
  }
  return n;
}

export async function smartFillForm(page, spec = {}, previousLinesSet = null) {
  const t0 = Date.now();
  const frames = getAllFrames(page);
  const overwrite = Boolean(spec.overwrite);
  const fields = Array.isArray(spec.fields) ? spec.fields : [];

  const fileFields = [];
  const domFields = [];
  const filled = [];
  const skipped = [];
  fields.forEach((f, idx) => {
    if (!f) return;
    const hasNonEmptyFile = typeof f.file === 'string' ? f.file.trim().length > 0 : Boolean(f.file);
    const hasNonEmptyFiles =
      Array.isArray(f.files) &&
      f.files.some((p) => p !== undefined && p !== null && String(p).trim() !== '');
    if (hasNonEmptyFile || hasNonEmptyFiles) {
      fileFields.push({ ...f, _idx: idx });
    } else if (
      (Array.isArray(f.files) || f.file !== undefined) &&
      f.value === undefined &&
      f.values === undefined &&
      f.option === undefined &&
      f.check === undefined
    ) {
      skipped.push({ idx, reason: 'empty-file-list' });
    } else {
      domFields.push({ ...f, _idx: idx });
    }
  });

  const submitButtons = [];
  const leftoverSet = new Set();
  const matchedFieldIndexes = new Set();

  const withFrameSubmitGuard = async (frame, fn) => {
    const allFrames = spec.stopBeforeSubmit !== false ? getAllFrames(page).map((f) => f.frame) : [];
    const targetFrames =
      spec.stopBeforeSubmit !== false && frame && !allFrames.includes(frame)
        ? [...allFrames, frame]
        : allFrames;
    for (const targetFrame of targetFrames) {
      await targetFrame
        .evaluate(() => {
          const win = window;
          if (win.__tbmCleanupFileGuard) win.__tbmCleanupFileGuard();
          Object.defineProperty(win, '__tbmSubmitGuardActive', {
            value: (win.__tbmSubmitGuardActive || 0) + 1,
            writable: true,
            enumerable: false,
            configurable: true,
          });
          if (typeof win.__tbmInstallFormGuard === 'function') {
            win.__tbmInstallFormGuard(win);
          }
          const origSub = win.HTMLFormElement?.prototype?.submit;
          const origReqSub = win.HTMLFormElement?.prototype?.requestSubmit;
          const hasProxySub = Boolean(origSub?.__tbmProxy);
          const hasProxyReqSub = Boolean(origReqSub?.__tbmProxy);
          const origAttachShadow = win.Element?.prototype?.attachShadow;
          const guardSub = (e) => {
            e.preventDefault();
            e.stopImmediatePropagation();
          };
          const guardedRoots = new Set();
          const attachToRoot = (root) => {
            if (!root || guardedRoots.has(root)) return;
            guardedRoots.add(root);
            root.addEventListener?.('submit', guardSub, true);
            if (root.querySelectorAll) {
              for (const el of root.querySelectorAll('*')) {
                const sr = el.shadowRoot || win.__tbmGetShadowRoot?.(el);
                if (sr) attachToRoot(sr);
              }
            }
          };
          win.addEventListener('submit', guardSub, true);
          attachToRoot(win.document);
          for (const sr of win.__tbmGetAllShadowRoots?.() || []) {
            attachToRoot(sr);
          }
          if (win.HTMLFormElement?.prototype) {
            if (!hasProxySub) win.HTMLFormElement.prototype.submit = function () {};
            if (typeof origReqSub === 'function' && !hasProxyReqSub) {
              win.HTMLFormElement.prototype.requestSubmit = function () {};
            }
          }
          if (win.Element?.prototype && typeof origAttachShadow === 'function') {
            win.Element.prototype.attachShadow = function (init) {
              const sr = origAttachShadow.call(this, init);
              attachToRoot(sr);
              return sr;
            };
          }
          Object.defineProperty(win, '__tbmCleanupFileGuard', {
            value: () => {
              Object.defineProperty(win, '__tbmSubmitGuardActive', {
                value: Math.max(0, (win.__tbmSubmitGuardActive || 1) - 1),
                writable: true,
                enumerable: false,
                configurable: true,
              });
              win.removeEventListener('submit', guardSub, true);
              for (const r of guardedRoots) {
                r.removeEventListener?.('submit', guardSub, true);
              }
              guardedRoots.clear();
              if (win.HTMLFormElement?.prototype) {
                if (origSub && !hasProxySub) win.HTMLFormElement.prototype.submit = origSub;
                if (origReqSub && !hasProxyReqSub) win.HTMLFormElement.prototype.requestSubmit = origReqSub;
              }
              if (win.Element?.prototype && origAttachShadow) {
                win.Element.prototype.attachShadow = origAttachShadow;
              }
              delete win.__tbmCleanupFileGuard;
            },
            writable: true,
            enumerable: false,
            configurable: true,
          });
        })
        .catch(() => {});
    }
    try {
      return await fn();
    } finally {
      for (const targetFrame of targetFrames) {
        await targetFrame
          .evaluate(async () => {
            await Promise.resolve();
            await new Promise((r) => setTimeout(r, 0));
            if (window.__tbmCleanupFileGuard) window.__tbmCleanupFileGuard();
          })
          .catch(() => {});
      }
    }
  };

  // Pass 1: Run fast batch DOM fill (including open Shadow DOM) inside each frame.
  const selectorHandlesToDispose = [];
  const tagSelectorMatches = async (frame, f) => {
    if (!f.selector) return;
    try {
      const handles = await frame.locator(f.selector).elementHandles();
      for (let order = 0; order < handles.length; order++) {
        const h = handles[order];
        selectorHandlesToDispose.push(h);
        await h
          .evaluate(
            (el, { idx, ord }) => {
              if (!el || el.nodeType !== 1) return;
              const prev = el.getAttribute('data-tbm-sel-match');
              const list = prev ? prev.split(',').filter((t) => t !== String(idx) && !t.startsWith(`${idx}:`)) : [];
              list.push(`${idx}:${ord}`);
              el.setAttribute('data-tbm-sel-match', list.join(','));
            },
            { idx: f._idx, ord: order }
          )
          .catch(() => {});
      }
    } catch {
      // Ignore invalid or unsupported selectors
    }
  };
  for (const frameInfo of frames) {
    const activeDomFields = domFields.filter((f) => {
      if (f.frameIdx !== undefined && f.frameIdx !== null && Number(f.frameIdx) !== frameInfo.frameIdx) {
        return false;
      }
      if (matchedFieldIndexes.has(f._idx) && !f.all) {
        return false;
      }
      return true;
    });

    await frameInfo.frame
      .evaluate(() => {
        const stack = [document];
        while (stack.length > 0) {
          const cur = stack.shift();
          if (!cur || !cur.querySelectorAll) continue;
          for (const el of cur.querySelectorAll('[data-tbm-sel-match]')) {
            el.removeAttribute('data-tbm-sel-match');
          }
          for (const node of cur.querySelectorAll('*')) {
            if (node.shadowRoot) stack.push(node.shadowRoot);
          }
        }
      })
      .catch(() => {});

    for (const f of activeDomFields) {
      await tagSelectorMatches(frameInfo.frame, f);
    }

    let res;
    try {
      res = await withFrameSubmitGuard(frameInfo.frame, () =>
        frameInfo.frame.evaluate(
          ({ domSpec, mainVal, gmailSpec, overwriteFlag, stopBeforeSubmitFlag, frameIdxArg, qBlockSel, submitSel }) => {
            const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
            const getSR = (node) => node?.shadowRoot || window.__tbmGetShadowRoot?.(node) || null;

            const safeControlClick = (node) => {
            if (stopBeforeSubmitFlag) {
              const btn = node.tagName === 'BUTTON' ? node : node.closest?.('button');
              const form = node.form || btn?.form || node.closest?.('form');
              const isSubmitBtn =
                btn && form && (btn.type || 'submit').toLowerCase() === 'submit';
              const guardClick = (ev) => {
                if (isSubmitBtn) ev.preventDefault();
              };
              const guardSubmit = (ev) => {
                ev.preventDefault();
                ev.stopImmediatePropagation();
              };
              window.addEventListener('click', guardClick, false);
              window.addEventListener('submit', guardSubmit, true);
              if (form) form.addEventListener('submit', guardSubmit, true);
              try {
                node.click();
              } finally {
                window.removeEventListener('click', guardClick, false);
                window.removeEventListener('submit', guardSubmit, true);
                if (form) form.removeEventListener('submit', guardSubmit, true);
              }
            } else {
              node.click();
            }
          };

          const queryAllDeep = (rootNode, sel) => {
            const seen = new Set();
            const out = [];
            const stack = [rootNode];
            while (stack.length > 0) {
              const cur = stack.shift();
              if (!cur) continue;
              if (cur.shadowRoot) {
                stack.push(cur.shadowRoot);
              }
              if (!cur.querySelectorAll) continue;
              let matches;
              try {
                matches = cur.querySelectorAll(sel);
              } catch {
                return out;
              }
              for (const match of matches) {
                if (!seen.has(match)) {
                  seen.add(match);
                  out.push(match);
                }
              }
              for (const node of cur.querySelectorAll('*')) {
                if (node.shadowRoot) {
                  stack.push(node.shadowRoot);
                }
              }
            }
            return out;
          };

          const isDisabledByFieldset = (node) => {
            let cur = node;
            while (cur && cur.nodeType === 1) {
              const parent = cur.parentElement;
              if (parent && parent.tagName === 'FIELDSET' && parent.disabled) {
                const firstLegend = [...parent.children].find((c) => c.tagName === 'LEGEND');
                if (!firstLegend || cur !== firstLegend) return true;
              }
              const rn = cur.getRootNode?.();
              cur = parent || (rn instanceof ShadowRoot ? rn.host : null);
            }
            return false;
          };

          const isInert = (node) => {
            let cur = node;
            while (cur && cur.nodeType === 1) {
              if (cur.hasAttribute('inert') || Boolean(cur.inert)) return true;
              const rn = cur.getRootNode?.();
              cur = cur.parentElement || (rn instanceof ShadowRoot ? rn.host : null);
            }
            return false;
          };

          const isClosedDetailsOrCvHidden = (node) => {
            let cur = node;
            while (cur && cur.nodeType === 1) {
              const parent = cur.parentElement;
              if (parent && parent.tagName === 'DETAILS' && !parent.open) {
                const firstSummary = [...parent.children].find((c) => c.tagName === 'SUMMARY');
                if (!firstSummary || cur !== firstSummary) return true;
              }
              try {
                if (getComputedStyle(cur).contentVisibility === 'hidden') return true;
              } catch {
                // ignore
              }
              const rn = cur.getRootNode?.();
              cur = parent || (rn instanceof ShadowRoot ? rn.host : null);
            }
            return false;
          };

          const compareComposedOrder = (a, b) => {
            if (a === b) return 0;
            const pathOf = (n) => {
              const p = [];
              let c = n;
              while (c) {
                p.unshift(c);
                const rn = c.getRootNode?.();
                c = c.assignedSlot || c.parentNode || (rn instanceof ShadowRoot ? rn.host : null);
              }
              return p;
            };
            const pa = pathOf(a);
            const pb = pathOf(b);
            const len = Math.min(pa.length, pb.length);
            for (let i = 0; i < len; i++) {
              if (pa[i] !== pb[i]) {
                if (pa[i] instanceof ShadowRoot) return -1;
                if (pb[i] instanceof ShadowRoot) return 1;
                const pos = pa[i].compareDocumentPosition(pb[i]);
                if (pos & 4) return -1;
                if (pos & 2) return 1;
                return 0;
              }
            }
            return pa.length - pb.length;
          };

          const closestComposed = (node, sel) => {
            let cur = node;
            while (cur) {
              if (cur.nodeType === 1 && cur.matches?.(sel)) return cur;
              const rn = cur.getRootNode?.();
              cur = cur.assignedSlot || cur.parentElement || (rn instanceof ShadowRoot ? rn.host : null);
            }
            return null;
          };

          const BLOCK_TAGS = new Set([
            'DIV', 'P', 'LI', 'UL', 'OL', 'TR', 'TD', 'TH',
            'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'ASIDE', 'NAV',
            'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'BR',
          ]);
          const composedText = (rootNode, allowHidden = false) => {
            if (!rootNode) return '';
            const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'SELECT', 'OPTION']);
            const walkChildren = (nodes) => {
              let out = '';
              for (const c of nodes || []) {
                const piece = walk(c);
                if (!piece) continue;
                const cTag = c.nodeType === 1 ? (c.tagName || '').toUpperCase() : '';
                if (BLOCK_TAGS.has(cTag)) {
                  out += (out && !/\s$/.test(out) ? ' ' : '') + piece + ' ';
                } else {
                  out += piece;
                }
              }
              return out;
            };
            const walk = (n) => {
              if (!n) return '';
              if (n.nodeType === 3) return n.textContent || '';
              if (n.nodeType !== 1 && n.nodeType !== 11) return '';
              if (n.nodeType === 1) {
                const t = (n.tagName || '').toUpperCase();
                if (SKIP.has(t)) return '';
                if (t === 'BR') return ' ';
                if (!allowHidden && n !== rootNode) {
                  if (n.hasAttribute?.('hidden') || n.getAttribute?.('aria-hidden') === 'true') return '';
                  try {
                    const st = getComputedStyle(n);
                    if (st.display === 'none' || st.visibility === 'hidden') return '';
                  } catch {}
                }
                if (t === 'SLOT' && typeof n.assignedNodes === 'function') {
                  const assigned = n.assignedNodes({ flatten: true });
                  const list = assigned.length > 0 ? assigned : (n.childNodes || []);
                  return walkChildren(list);
                }
                const sr = getSR(n);
                if (sr) {
                  const srOut = walkChildren(sr.childNodes);
                  if (clean(srOut)) return srOut;
                }
              }
              return walkChildren(n.childNodes);
            };
            return clean(walk(rootNode));
          };

          const getSelOrder = (el, idx) => {
            const raw = el?.getAttribute?.('data-tbm-sel-match') || '';
            const prefix = `${idx}:`;
            for (const part of raw.split(',')) {
              if (part === String(idx)) return 0;
              if (part.startsWith(prefix)) return Number(part.slice(prefix.length)) || 0;
            }
            return -1;
          };

          const hasSelToken = (el, idx) => getSelOrder(el, idx) >= 0;

          const vis = (el) => {
            if (!el) return false;
            if (
              el.disabled ||
              Boolean(el.matches?.(':disabled')) ||
              isDisabledByFieldset(el) ||
              isInert(el) ||
              isClosedDetailsOrCvHidden(el) ||
              el.readOnly ||
              el.hasAttribute('readonly') ||
              el.getAttribute('aria-readonly') === 'true' ||
              el.getAttribute('aria-disabled') === 'true' ||
              Boolean(el.closest('[aria-disabled="true"]')) ||
              el.getAttribute('aria-hidden') === 'true' ||
              Boolean(el.closest('[aria-hidden="true"]'))
            ) {
              return false;
            }
            const st = getComputedStyle(el);
            if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };

          const resolveById = (el, id) => {
            const rootNode = el.getRootNode?.();
            return (rootNode?.getElementById && rootNode.getElementById(id)) || document.getElementById(id);
          };


          // Visible label that is a preceding <label>/[class*=label] in the field container, with no `for` link
          // (Zoho Recruit style). Walks up at most 4 ancestors; stops when the container holds another field.
          const nearestFieldLabel = (el) => {
            const FIELD_SEL =
              'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]):not([type="reset"]), textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]';
            let cur = el;
            let prevChild = el;
            for (let up = 0; up < 4 && cur.parentElement; up++) {
              cur = cur.parentElement;
              let fields = 0;
              try {
                fields = cur.querySelectorAll(FIELD_SEL).length;
              } catch {}
              if (fields > 1) return '';
              let best = '';
              for (const c of cur.querySelectorAll('label, [class*="label" i]')) {
                if (c.contains(el) || !(c.compareDocumentPosition(el) & 4)) continue;
                const forId = c.getAttribute?.('for');
                if (forId && forId !== el.id && document.getElementById(forId)) continue;
                if (c.querySelector('input, select, textarea, button')) continue;
                const t = clean(c.innerText || c.textContent).replace(/\s*[*\uFF0A]+$/, '');
                if (t && t.length <= 80 && /[\p{L}\p{N}]/u.test(t)) best = t;
              }
              if (best) return best;
              // Plain sibling block before the field (no label element): "First Name*" in a <div>.
              const sib = up < 3 ? prevChild.previousElementSibling : null;
              if (sib && !sib.matches(FIELD_SEL) && !sib.querySelector(FIELD_SEL) && !sib.querySelector('button, a')) {
                const t = clean(sib.innerText || sib.textContent).replace(/\s*[*\uFF0A]+$/, '');
                if (t && t.length <= 60 && /[\p{L}\p{N}]/u.test(t)) return t;
              }
              prevChild = cur;
            }
            return '';
          };

          const describeParts = (el) => {
            const parts = [];
            for (const a of ['aria-label', 'placeholder', 'name', 'id', 'title', 'data-placeholder']) {
              const v = el.getAttribute(a);
              if (v) parts.push(v);
            }
            if (el.labels) {
              for (const l of el.labels) parts.push(composedText(l) || l.innerText);
            }
            const lby = el.getAttribute('aria-labelledby');
            if (lby) {
              for (const id of lby.split(/\s+/)) {
                const n = resolveById(el, id);
                if (n) parts.push(composedText(n, true) || n.innerText);
              }
            }
            const wl = closestComposed(el, 'label');
            if (wl) parts.push(composedText(wl) || wl.innerText);
            else if (
              !el.getAttribute('aria-label') &&
              !lby &&
              !(el.labels && el.labels.length > 0) &&
              /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)
            ) {
              const near = nearestFieldLabel(el);
              if (near) parts.unshift(near);
            }
            const blk = closestComposed(el, qBlockSel);
            if (blk) {
              const blkTextInputs = queryAllDeep(
                blk,
                'input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]):not([type="reset"]):not([type="file"]), textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]'
              );
              if (blkTextInputs.length <= 1) {
                parts.push((composedText(blk) || blk.innerText || '').slice(0, 300));
              }
            }
            const elRoleDesc = (el.getAttribute('role') || '').toLowerCase();
            if (elRoleDesc === 'switch' || elRoleDesc === 'checkbox' || elRoleDesc === 'radio') {
              const ct = composedText(el) || el.innerText;
              if (ct) parts.push(ct);
            }
            const host = el.getRootNode?.()?.host;
            if (host) {
              const hostAttr = host.getAttribute('aria-label') || host.getAttribute('data-label');
              if (hostAttr) parts.push(hostAttr);
            }
            const prev = el.previousElementSibling;
            if (prev && !prev.matches('button, input, select, textarea, a, [role="button"], [role="switch"], [role="checkbox"], [role="radio"], [role="textbox"], [role="combobox"]')) {
              parts.push(composedText(prev) || prev.innerText);
            }
            const primaryParts = parts.map((p) => clean(p)).filter(Boolean);
            const contextParts = [];
            let curFs = closestComposed(el, 'fieldset');
            while (curFs) {
              const leg = curFs.querySelector('legend');
              const legTxt = leg ? (composedText(leg) || clean(leg.innerText)) : '';
              if (legTxt) contextParts.unshift(legTxt);
              const rnFs = curFs.getRootNode?.();
              curFs = closestComposed(curFs.assignedSlot || curFs.parentElement || (rnFs instanceof ShadowRoot ? rnFs.host : null), 'fieldset');
            }
            const sec = closestComposed(el, 'section, [role="region"], [role="group"]');
            if (sec && sec.tagName !== 'FIELDSET') {
              const secAria = sec.getAttribute('aria-label');
              const secLby = sec.getAttribute('aria-labelledby');
              let secHeading = '';
              if (secAria) {
                secHeading = secAria;
              } else if (secLby) {
                secHeading = secLby
                  .split(/\s+/)
                  .map((id) => {
                    const rn = resolveById(sec, id);
                    return composedText(rn, true) || rn?.innerText || '';
                  })
                  .join(' ');
              } else {
                const h = sec.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > legend');
                if (h) secHeading = composedText(h) || h.innerText;
              }
              if (clean(secHeading)) contextParts.push(clean(secHeading));
            }
            if (contextParts.length > 0) {
              const ctxJoined = contextParts.join(' ');
              if (primaryParts.length > 0) {
                for (const pp of primaryParts) {
                  parts.push(`${ctxJoined} ${pp}`);
                }
              } else {
                parts.push(ctxJoined);
              }
            }
            return parts.map((p) => clean(p).toLowerCase()).filter(Boolean);
          };

          const describe = (el) => describeParts(el).join(' | ');

          const describeBlock = (blk) => {
            const parts = [];
            const aria = blk.getAttribute('aria-label');
            if (aria) parts.push(aria);
            const lby = blk.getAttribute('aria-labelledby');
            if (lby) {
              for (const id of lby.split(/\s+/)) {
                const n = resolveById(blk, id);
                if (n) parts.push(composedText(n, true) || n.innerText || n.textContent);
              }
            }
            const titleAttr = blk.getAttribute('title');
            if (titleAttr) parts.push(titleAttr);
            const ct = composedText(blk) || blk.innerText;
            if (ct) parts.push(ct);
            return clean(parts.join(' | ')).toLowerCase();
          };

          const parseBoolValue = (val) => {
            if (typeof val === 'boolean') return val;
            if (typeof val === 'string') {
              const norm = val.trim().toLowerCase();
              if (norm === 'true') return true;
              if (norm === 'false') return false;
            }
            return null;
          };

          const currentValue = (el) => {
            if (el.isContentEditable) return clean(el.innerText);
            if (typeof el.value === 'string') return el.value.trim();
            return clean(el.getAttribute('data-value') || el.innerText || '');
          };

          const setNativeValue = (el, val) => {
            el.focus();
            if (el.isContentEditable) {
              document.execCommand('selectAll', false);
              const ok = document.execCommand('insertText', false, val);
              if (!ok || clean(el.innerText) !== clean(val)) {
                el.textContent = val;
              }
              el.dispatchEvent(new InputEvent('input', { bubbles: true, data: val, inputType: 'insertText' }));
            } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
              const proto =
                el instanceof HTMLTextAreaElement
                  ? HTMLTextAreaElement.prototype
                  : HTMLInputElement.prototype;
              if (el._valueTracker && typeof el._valueTracker.setValue === 'function') {
                el._valueTracker.setValue('');
              }
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (setter) setter.call(el, val);
              else el.value = val;
              el.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
              el.textContent = val;
              el.setAttribute('data-value', val);
              el.dispatchEvent(new InputEvent('input', { bubbles: true, data: val, inputType: 'insertText' }));
            }
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
            el.style.outline = '2px solid #E0461D';
            el.style.outlineOffset = '1px';
          };

          const safePatternMatch = (text, pat) => {
            if (pat === undefined || pat === null) return false;
            const raw = String(pat);
            if (!raw) return false;
            const hay = String(text || '');
            if (hay.toLowerCase().includes(raw.toLowerCase())) return true;
            try {
              return new RegExp(raw, 'i').test(hay);
            } catch {
              const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              return new RegExp(escaped, 'i').test(hay);
            }
          };

          const rankOptionMatch = (opt, pat) => {
            const raw = String(pat ?? '').trim();
            if (!raw) return 0;
            const rawLower = raw.toLowerCase();
            const txt = clean(opt.text);
            const txtLower = txt.toLowerCase();
            const valLower = String(opt.value ?? '').trim().toLowerCase();
            if (txtLower === rawLower || valLower === rawLower) return 3;
            const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const wordPrefixRe = new RegExp(`^${escaped}(?![\\p{L}\\p{N}_])`, 'iu');
            if (wordPrefixRe.test(txt) || wordPrefixRe.test(String(opt.value ?? '').trim())) return 2;
            if (safePatternMatch(txt, pat) || safePatternMatch(opt.value, pat)) return 1;
            return 0;
          };

          const chooseSelect = (sel, rawSpec) => {
            const specs = Array.isArray(rawSpec) ? rawSpec : [rawSpec];
            const patterns = specs.filter((p) => p !== undefined && p !== null && String(p) !== '');
            if (patterns.length === 0) return null;

            const enabledOptions = [...sel.options].filter(
              (opt) => !opt.disabled && !opt.closest('optgroup:disabled')
            );
            if (enabledOptions.length === 0) return null;

            if (sel._valueTracker && typeof sel._valueTracker.setValue === 'function') {
              sel._valueTracker.setValue('');
            }

            let chosen;
            if (sel.multiple || Array.isArray(rawSpec)) {
              const selectedSet = new Set();
              for (const pat of patterns) {
                let bestTier = 0;
                const scored = enabledOptions.map((opt) => {
                  const tier = rankOptionMatch(opt, pat);
                  if (tier > bestTier) bestTier = tier;
                  return { opt, tier };
                });
                if (bestTier > 0) {
                  for (const { opt, tier } of scored) {
                    if (tier === bestTier) selectedSet.add(opt);
                  }
                }
              }
              const matched = enabledOptions.filter((opt) => selectedSet.has(opt));
              if (matched.length === 0) return null;
              for (const opt of sel.options) {
                opt.selected = sel.multiple ? selectedSet.has(opt) : false;
              }
              if (!sel.multiple) {
                sel.value = matched[0].value;
                chosen = clean(matched[0].text);
              } else {
                chosen = matched.map((o) => clean(o.text));
              }
            } else {
              const pat = patterns[0];
              let bestOpt = null;
              let bestTier = 0;
              for (const o of enabledOptions) {
                const tier = rankOptionMatch(o, pat);
                if (tier > bestTier) {
                  bestTier = tier;
                  bestOpt = o;
                  if (tier === 3) break;
                }
              }
              if (!bestOpt) return null;
              sel.value = bestOpt.value;
              chosen = clean(bestOpt.text);
            }
            sel.dataset.tbmSelectFilled = '1';
            sel.dispatchEvent(new Event('input', { bubbles: true }));
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            sel.style.outline = '2px solid #E0461D';
            return chosen;
          };

          const matchesSpec = (text, f) => {
            const keys = Array.isArray(f.keys) ? f.keys : f.keys ? [f.keys] : [];
            const nots = Array.isArray(f.not) ? f.not : f.not ? [f.not] : [];
            if (keys.length === 0) return false;
            if (nots.some((n) => safePatternMatch(text, n))) return false;
            return keys.some((k) => safePatternMatch(text, k));
          };

          const rankFieldMatch = (el, f) => {
            const keys = Array.isArray(f.keys) ? f.keys : f.keys ? [f.keys] : [];
            const nots = Array.isArray(f.not) ? f.not : f.not ? [f.not] : [];
            if (keys.length === 0) return 0;
            const parts = describeParts(el);
            const fullText = parts.join(' | ');
            if (nots.some((n) => safePatternMatch(fullText, n))) return 0;

            let bestTier = 0;
            for (const k of keys) {
              const raw = clean(String(k ?? ''));
              if (!raw) continue;
              const rawLower = raw.toLowerCase();
              if (parts.some((p) => p === rawLower)) {
                if (bestTier < 4) bestTier = 4;
                continue;
              }
              const escaped = rawLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const partPrefixRe = new RegExp(`^${escaped}(?![\\p{L}\\p{N}_])`, 'iu');
              if (parts.some((p) => partPrefixRe.test(p))) {
                if (bestTier < 3) bestTier = 3;
                continue;
              }
              const wordBoundaryRe = new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu');
              if (wordBoundaryRe.test(fullText)) {
                if (bestTier < 2) bestTier = 2;
                continue;
              }
              if (safePatternMatch(fullText, k)) {
                if (bestTier < 1) bestTier = 1;
              }
            }
            return bestTier;
          };

          const frameFilled = [];
          const frameSkipped = [];
          const matchedIndexes = [];

          // 1. Direct Gmail compose support
          if (gmailSpec) {
            const dlg =
              queryAllDeep(document, 'div[role="dialog"], .M9, .AD').find(vis) || document;
            const fillGmailInput = (selectors, val, tag) => {
              if (!val) return;
              for (const s of selectors) {
                const el = queryAllDeep(dlg, s).find(vis);
                if (el && (overwriteFlag || !currentValue(el))) {
                  setNativeValue(el, val);
                  frameFilled.push({ tag: `gmail:${tag}`, frameIdx: frameIdxArg, preview: val.slice(0, 60) });
                  return;
                }
              }
            };
            fillGmailInput(
              ['input[aria-label*="To"]', 'input[aria-label*="Người nhận"]', 'input[peoplekit-id]', 'textarea[name="to"]', 'input[name="to"]'],
              gmailSpec.to,
              'to'
            );
            fillGmailInput(['input[name="subjectbox"]', 'input[aria-label*="Subject"]'], gmailSpec.subject, 'subject');
            fillGmailInput(
              ['div[aria-label="Message Body"]', 'div[aria-label="Nội dung thư"]', 'div[role="textbox"][contenteditable]:not([contenteditable="false"])'],
              gmailSpec.body,
              'body'
            );
          }

          // 2. Text / Select / Radio / Checkbox / ARIA Switch fields across light + open Shadow DOM
          const inputs = queryAllDeep(
            document,
            'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="checkbox"], [role="radio"], [role="switch"]'
          ).filter((el) => {
            if (!vis(el)) return false;
            const r = (el.getAttribute('role') || '').toLowerCase();
            if (r === 'switch' || r === 'checkbox' || r === 'radio') return true;
            const t = (el.getAttribute('type') || '').toLowerCase();
            return !['hidden', 'submit', 'button', 'image', 'reset', 'file'].includes(t);
          });

          const containsComposed = (ancestor, node) => {
            let cur = node;
            while (cur) {
              if (cur === ancestor) return true;
              if (ancestor.contains && ancestor.contains(cur)) return true;
              const rn = cur.getRootNode?.();
              cur = cur.assignedSlot || cur.parentElement || (rn instanceof ShadowRoot ? rn.host : null);
            }
            return false;
          };

          const isCustomCombobox = (el) =>
            Boolean(
              el &&
              (el.getAttribute('role') || '').toLowerCase() === 'combobox' &&
              !['SELECT'].includes(el.tagName) &&
              !el.isContentEditable
            );

          const choiceSel =
            'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], [role="switch"]';
          const getChoiceOptLabel = (ctrl) => {
            const wrap = closestComposed(ctrl, 'label');
            const lblListTxt = ctrl.labels?.length
              ? [...ctrl.labels].map((l) => composedText(l) || l.innerText).join(' ')
              : '';
            const selfLabel = clean(
              (ctrl.hasAttribute('role') ? (composedText(ctrl) || ctrl.innerText) : '') ||
              ctrl.getAttribute('aria-label') ||
              ctrl.getAttribute('title') ||
              ''
            );
            const parentTxt =
              !wrap &&
              !lblListTxt &&
              !selfLabel &&
              ctrl.parentElement &&
              !/^(FORM|BODY|HTML|MAIN|SECTION)$/i.test(ctrl.parentElement.tagName)
                ? (composedText(ctrl.parentElement) || ctrl.parentElement.innerText)
                : '';
            return clean(
              (wrap ? (composedText(wrap) || wrap.innerText) : '') || lblListTxt || selfLabel || parentTxt || ctrl.value || ''
            );
          };

          const rawBlocks = queryAllDeep(document, qBlockSel).filter(vis);
          const blockChoiceMap = new Map(
            rawBlocks.map((b) => [b, queryAllDeep(b, choiceSel).filter(vis)])
          );
          const blockChoiceCounts = new Map(
            rawBlocks.map((b) => [b, (blockChoiceMap.get(b) || []).length])
          );
          const blocks = rawBlocks.filter((b) => {
            const ctrls = blockChoiceMap.get(b) || [];
            if (ctrls.length === 1 && !b.matches('fieldset, [role="radiogroup"], [role="group"]')) {
              const singleOptLbl = getChoiceOptLabel(ctrls[0]).toLowerCase();
              const blkText = (composedText(b) || clean(b.innerText || '')).toLowerCase();
              const isPureOptionWrapper = Boolean(singleOptLbl && blkText === singleOptLbl);
              if (isPureOptionWrapper) {
                const hasMultiAncestor = rawBlocks.some(
                  (anc) => anc !== b && containsComposed(anc, b) && (blockChoiceCounts.get(anc) || 0) > 1
                );
                if (hasMultiAncestor) return false;
              }
            }
            return true;
          });
          const claimed = new Set();
          const radioGroupMap = new Map();
          let nextRadioGroupId = 1;

          for (const f of domSpec) {
            if (f.option !== undefined || f.check !== undefined) {
              const wanted = f.check ?? f.option;
              const checkIsBool = typeof f.check === 'boolean';
              const patterns = Array.isArray(wanted) ? wanted : [wanted];
              let hitAny = false;

              const toggleChoiceControls = (container, requireKeyMatch) => {
                const rawControls =
                  container && container.nodeType === 1 && container.matches?.(choiceSel)
                    ? [container]
                    : queryAllDeep(container, choiceSel);
                const containerHasMatchingSelectOrCombo =
                  container !== document &&
                  Boolean(f.keys) &&
                  f.check === undefined &&
                  queryAllDeep(container, 'select, [role="combobox"]')
                    .filter(vis)
                    .some((s) => rankFieldMatch(s, f) > 0 || matchesSpec(describe(s), f));

                const controls = rawControls.filter((ctrl) => {
                  if (!vis(ctrl)) return false;
                  if (container !== document && f.keys) {
                    const nestedUnmatchedBlock = blocks.some(
                      (subBlk) =>
                        subBlk !== container &&
                        containsComposed(container, subBlk) &&
                        containsComposed(subBlk, ctrl) &&
                        (blockChoiceCounts.get(subBlk) || 0) > 0 &&
                        !matchesSpec(describeBlock(subBlk), f)
                    );
                    if (nestedUnmatchedBlock) return false;
                    if (containerHasMatchingSelectOrCombo && !matchesSpec(describe(ctrl), f)) {
                      return false;
                    }
                  }
                  return true;
                });

                const decorated = controls.map((ctrl) => ({
                  ctrl,
                  optLabel: getChoiceOptLabel(ctrl),
                }));

                const rankChoiceMatch = (optLabel, val, pat) => {
                  const raw = String(pat ?? '').trim();
                  if (!raw) return 0;
                  const rawLower = raw.toLowerCase();
                  const lblLower = optLabel.toLowerCase();
                  const valLower = String(val ?? '').trim().toLowerCase();
                  if (lblLower === rawLower || valLower === rawLower) return 3;
                  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                  const wordRe = new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu');
                  if (wordRe.test(optLabel) || wordRe.test(String(val ?? ''))) return 2;
                  if (safePatternMatch(optLabel, pat)) return 1;
                  return 0;
                };

                for (const pat of patterns) {
                  let bestTier = 0;
                  const scored = [];
                  for (const item of decorated) {
                    if (
                      requireKeyMatch &&
                      !matchesSpec(`${item.optLabel.toLowerCase()} ${describe(item.ctrl)}`, f)
                    ) {
                      continue;
                    }
                    const tier = rankChoiceMatch(item.optLabel, item.ctrl.value, pat);
                    if (tier > 0) {
                      if (tier > bestTier) bestTier = tier;
                      scored.push({ ...item, tier });
                    }
                  }
                  if (bestTier === 0) continue;

                  const clickedRadioGroups = new Set();
                  for (const { ctrl, optLabel, tier } of scored) {
                    if (tier !== bestTier) continue;
                    const isAria = ctrl.hasAttribute('role');
                    const isRadio = (isAria ? ctrl.getAttribute('role') : ctrl.type) === 'radio';
                    if (isRadio) {
                      const rg = ctrl.closest('[role="radiogroup"], [role="group"], fieldset, .form-group, .field');
                      if (rg && !radioGroupMap.has(rg)) {
                        radioGroupMap.set(rg, `__rg_${nextRadioGroupId++}`);
                      }
                      const groupKey =
                        ctrl.name ||
                        ctrl.getAttribute('name') ||
                        (rg ? radioGroupMap.get(rg) : '__default_aria_radio__');
                      if (clickedRadioGroups.has(groupKey)) continue;
                      clickedRadioGroups.add(groupKey);
                    }
                    const isChecked = isAria
                      ? ctrl.getAttribute('aria-checked') === 'true'
                      : Boolean(ctrl.checked);
                    if (!isChecked) {
                      safeControlClick(ctrl);
                    }
                    ctrl.style.outline = '2px solid #E0461D';
                    claimed.add(ctrl);
                    frameFilled.push({
                      idx: f._idx,
                      frameIdx: frameIdxArg,
                      tag: isAria ? ctrl.getAttribute('role') : `input:${ctrl.type}`,
                      label: optLabel.slice(0, 60),
                    });
                    hitAny = true;
                  }
                }
              };

              if (f.ref || f.selector) {
                let explicitTargets = [];
                if (f.ref) {
                  const m = /^(?:f(\d+):)?(e\d+)$/i.exec(f.ref.trim());
                  if (m && (m[1] === undefined || Number(m[1]) === frameIdxArg)) {
                    const el = queryAllDeep(document, `[data-tbm-ref="${m[2]}"]`)[0];
                    if (el && vis(el)) explicitTargets = [el];
                  }
                } else if (f.selector) {
                  if (f.frameIdx === undefined || f.frameIdx === frameIdxArg) {
                    const preTagged = queryAllDeep(document, '[data-tbm-sel-match]')
                      .filter((el) => hasSelToken(el, f._idx))
                      .sort(compareComposedOrder)
                      .filter(vis);
                    const matchedEls =
                      preTagged.length > 0
                        ? preTagged
                        : queryAllDeep(document, f.selector).filter(vis).sort(compareComposedOrder);
                    explicitTargets =
                      f.all || (f.check !== undefined && !checkIsBool) ? matchedEls : matchedEls.slice(0, 1);
                  }
                }
                // check:'label' / ['a','b'] on one radio/checkbox of a named group: act on the whole group.
                if (f.check !== undefined && !checkIsBool && explicitTargets.length === 1) {
                  const one = explicitTargets[0];
                  if (one.matches?.('input[type="checkbox"], input[type="radio"]') && one.name) {
                    explicitTargets = queryAllDeep(document, choiceSel).filter(
                      (c) => vis(c) && c.name === one.name && c.type === one.type && c.form === one.form
                    );
                  }
                }
                if (checkIsBool) {
                  for (const raw of explicitTargets) {
                    const ctrl = raw.tagName === 'LABEL' && raw.control ? raw.control : raw;
                    if (!ctrl.matches?.(choiceSel)) continue;
                    const isAria = ctrl.hasAttribute('role') && !ctrl.matches('input');
                    const isRadio = (isAria ? ctrl.getAttribute('role') : ctrl.type) === 'radio';
                    const now = isAria ? ctrl.getAttribute('aria-checked') === 'true' : Boolean(ctrl.checked);
                    if (f.check === false && isRadio) continue;
                    if (now !== f.check) safeControlClick(ctrl);
                    ctrl.style.outline = '2px solid #E0461D';
                    claimed.add(ctrl);
                    frameFilled.push({
                      idx: f._idx,
                      frameIdx: frameIdxArg,
                      tag: isAria ? ctrl.getAttribute('role') : `input:${ctrl.type}`,
                      label: getChoiceOptLabel(ctrl).slice(0, 60),
                    });
                    hitAny = true;
                  }
                } else if (
                  explicitTargets.length > 0 &&
                  !explicitTargets.some((el) => el.tagName === 'SELECT' || isCustomCombobox(el))
                ) {
                  for (const tEl of explicitTargets) {
                    toggleChoiceControls(tEl, false);
                  }
                }
              } else if (f.keys) {
                const matchingBlocks = blocks.filter((blk) => matchesSpec(describeBlock(blk), f));
                const innermostBlocks = matchingBlocks.filter(
                  (blk) => !matchingBlocks.some((other) => other !== blk && containsComposed(blk, other))
                );
                for (const blk of innermostBlocks) {
                  toggleChoiceControls(blk, false);
                }
                if (!hitAny) {
                  const hasMatchingSelectOrCombo = queryAllDeep(document, 'select, [role="combobox"]')
                    .filter(vis)
                    .some((s) => rankFieldMatch(s, f) > 0 || matchesSpec(describe(s), f));
                  if (f.check !== undefined || !hasMatchingSelectOrCombo) {
                    toggleChoiceControls(document, true);
                  }
                }
              } else {
                toggleChoiceControls(document, false);
              }

              if (hitAny) {
                matchedIndexes.push(f._idx);
                continue;
              }
              if (f.check !== undefined) {
                continue;
              }
            }

            let targets = [];
            if (f.ref) {
              const m = /^(?:f(\d+):)?(e\d+)$/i.exec(f.ref.trim());
              if (m && (m[1] === undefined || Number(m[1]) === frameIdxArg)) {
                const el = queryAllDeep(document, `[data-tbm-ref="${m[2]}"]`)[0];
                if (el && vis(el) && !isCustomCombobox(el)) targets = [el];
              }
            } else if (f.selector) {
              if (f.frameIdx === undefined || f.frameIdx === frameIdxArg) {
                const preTagged = queryAllDeep(document, '[data-tbm-sel-match]')
                  .filter((el) => hasSelToken(el, f._idx))
                  .sort(compareComposedOrder)
                  .map((el) => (el.tagName === 'LABEL' && el.control ? el.control : el))
                  .filter((el) => vis(el) && !isCustomCombobox(el));
                const matchedEls =
                  preTagged.length > 0
                    ? preTagged
                    : queryAllDeep(document, f.selector)
                        .filter((el) => vis(el) && !isCustomCombobox(el))
                        .sort(compareComposedOrder);
                targets = f.all ? matchedEls : matchedEls.slice(0, 1);
              }
            } else if (f.keys) {
              const scored = [];
              let bestTier = 0;
              for (const el of inputs) {
                if (!f.all && claimed.has(el)) continue;
                const tier = rankFieldMatch(el, f);
                if (tier > 0) {
                  if (tier > bestTier) bestTier = tier;
                  scored.push({ el, tier });
                }
              }
              if (bestTier > 0) {
                if (f.all) {
                  targets = scored.map((s) => s.el);
                } else {
                  const winner = scored.find((s) => s.tier === bestTier);
                  if (winner) targets = [winner.el];
                }
              }
            }

            if (targets.length === 0) continue;

            for (const el of targets) {
              if (el.tagName === 'SELECT') {
                const selOpt = !el.multiple && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
                const isSelectAlreadyFilled = Boolean(
                  el.dataset.tbmSelectFilled === '1' ||
                  (selOpt && selOpt.value !== '' && !selOpt.disabled && (el.selectedIndex > 0 || selOpt.hasAttribute('selected')))
                );
                if (isSelectAlreadyFilled && !overwriteFlag) {
                  claimed.add(el);
                  frameSkipped.push({
                    idx: f._idx,
                    frameIdx: frameIdxArg,
                    reason: 'already-filled',
                    label: describe(el).slice(0, 50),
                  });
                  matchedIndexes.push(f._idx);
                  continue;
                }
                const selectSpec = f.values !== undefined ? f.values : (f.value ?? f.option ?? '');
                const chosen = chooseSelect(el, selectSpec);
                if (chosen !== null) {
                  claimed.add(el);
                  frameFilled.push({
                    idx: f._idx,
                    frameIdx: frameIdxArg,
                    tag: el.multiple ? 'select:multiple' : 'select',
                    label: describe(el).slice(0, 50),
                    value: chosen,
                  });
                  matchedIndexes.push(f._idx);
                }
                continue;
              }

              const elRole = (el.getAttribute('role') || '').toLowerCase();
              const parsedBool = parseBoolValue(f.value);
              if (elRole === 'switch' || elRole === 'checkbox' || elRole === 'radio') {
                if (parsedBool !== null) {
                  const curChecked = el.getAttribute('aria-checked') === 'true';
                  if (curChecked !== parsedBool) safeControlClick(el);
                  el.style.outline = '2px solid #E0461D';
                  claimed.add(el);
                  frameFilled.push({
                    idx: f._idx,
                    frameIdx: frameIdxArg,
                    tag: `role:${elRole}`,
                    label: describe(el).slice(0, 50),
                    checked: el.getAttribute('aria-checked') === 'true',
                  });
                  matchedIndexes.push(f._idx);
                }
                continue;
              }

              if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
                if (parsedBool !== null) {
                  if (Boolean(el.checked) !== parsedBool) safeControlClick(el);
                  el.style.outline = '2px solid #E0461D';
                  claimed.add(el);
                  frameFilled.push({
                    idx: f._idx,
                    frameIdx: frameIdxArg,
                    tag: `input:${el.type}`,
                    label: describe(el).slice(0, 50),
                    checked: Boolean(el.checked),
                  });
                  matchedIndexes.push(f._idx);
                }
                continue;
              }

              if (el.tagName === 'INPUT' && el.type === 'color') {
                if (el.dataset.tbmColorFilled === '1' && !overwriteFlag) {
                  claimed.add(el);
                  frameSkipped.push({
                    idx: f._idx,
                    frameIdx: frameIdxArg,
                    reason: 'already-filled',
                    label: describe(el).slice(0, 50),
                  });
                  matchedIndexes.push(f._idx);
                  continue;
                }
                const rawColor = String(f.value ?? '').trim();
                if (!/^#[0-9a-f]{6}$/i.test(rawColor)) {
                  frameSkipped.push({
                    idx: f._idx,
                    frameIdx: frameIdxArg,
                    reason: 'value-rejected-by-input',
                    label: describe(el).slice(0, 50),
                  });
                  continue;
                }
                setNativeValue(el, rawColor);
                el.dataset.tbmColorFilled = '1';
                claimed.add(el);
                frameFilled.push({
                  idx: f._idx,
                  frameIdx: frameIdxArg,
                  tag: 'input:color',
                  label: describe(el).slice(0, 50),
                  value: el.value,
                });
                matchedIndexes.push(f._idx);
                continue;
              }

              if (el.tagName === 'INPUT' && el.type === 'range') {
                if (el.dataset.tbmRangeFilled === '1' && !overwriteFlag) {
                  claimed.add(el);
                  frameSkipped.push({
                    idx: f._idx,
                    frameIdx: frameIdxArg,
                    reason: 'already-filled',
                    label: describe(el).slice(0, 50),
                  });
                  matchedIndexes.push(f._idx);
                  continue;
                }
                const rawRange = String(f.value ?? '').trim();
                const numRange = Number(rawRange);
                if (rawRange === '' || !Number.isFinite(numRange)) {
                  frameSkipped.push({
                    idx: f._idx,
                    frameIdx: frameIdxArg,
                    reason: 'value-rejected-by-input',
                    label: describe(el).slice(0, 50),
                  });
                  continue;
                }
                setNativeValue(el, rawRange);
                el.dataset.tbmRangeFilled = '1';
                claimed.add(el);
                frameFilled.push({
                  idx: f._idx,
                  frameIdx: frameIdxArg,
                  tag: 'input:range',
                  label: describe(el).slice(0, 50),
                  value: el.value,
                });
                matchedIndexes.push(f._idx);
                continue;
              }

              if (f.value === undefined && f.option !== undefined) {
                continue;
              }

              const cur = currentValue(el);
              if (cur && !overwriteFlag) {
                claimed.add(el);
                frameSkipped.push({
                  idx: f._idx,
                  frameIdx: frameIdxArg,
                  reason: 'already-filled',
                  label: describe(el).slice(0, 50),
                });
                matchedIndexes.push(f._idx);
                continue;
              }

              const strVal = String(f.value ?? '');
              setNativeValue(el, strVal);
              const afterVal = currentValue(el);
              if (
                (strVal !== '' && afterVal === '') ||
                (overwriteFlag && cur !== '' && clean(afterVal) === clean(cur) && clean(strVal) !== clean(cur))
              ) {
                frameSkipped.push({
                  idx: f._idx,
                  frameIdx: frameIdxArg,
                  reason: 'value-rejected-by-input',
                  label: describe(el).slice(0, 50),
                });
                continue;
              }
              claimed.add(el);
              try { el.setAttribute('data-tbm-fill', String(f._idx)); } catch { /* ignore */ }
              frameFilled.push({
                idx: f._idx,
                frameIdx: frameIdxArg,
                tag: el.isContentEditable ? 'contenteditable' : el.tagName.toLowerCase(),
                label: describe(el).slice(0, 50),
                value: strVal.slice(0, 60),
                ...(el.getRootNode?.() instanceof ShadowRoot ? { _sh: 1 } : {}),
              });
              matchedIndexes.push(f._idx);
            }
          }

          // 3. Optional main large box
          if (mainVal) {
            const largeBoxes = inputs.filter((el) => {
              if (el.tagName === 'TEXTAREA' || el.isContentEditable || el.getAttribute('role') === 'textbox') {
                const r = el.getBoundingClientRect();
                return r.height >= 80 && r.width >= 200;
              }
              return false;
            });
            largeBoxes.sort((a, b) => {
              const ra = a.getBoundingClientRect();
              const rb = b.getBoundingClientRect();
              return rb.width * rb.height - ra.width * ra.height;
            });
            const box = largeBoxes[0];
            if (box) {
              if (!currentValue(box) || overwriteFlag) {
                setNativeValue(box, mainVal);
                frameFilled.push({ tag: 'main', frameIdx: frameIdxArg, preview: mainVal.slice(0, 60) });
              } else {
                frameSkipped.push({ reason: 'main-already-filled', frameIdx: frameIdxArg });
              }
            }
          }

          // 4. Collect remaining unfilled text/select inputs & submit buttons
          const leftover = inputs
            .filter((el) => {
              if (el.tagName === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox')) return false;
              const r = (el.getAttribute('role') || '').toLowerCase();
              if (r === 'radio' || r === 'checkbox' || r === 'switch') return false;
              return !currentValue(el);
            })
            .slice(0, 10)
            .map((el) => `[f${frameIdxArg}] ${describe(el).slice(0, 70)}`);

          const extractAccessibleText = (rootNode, allowHidden = false) => {
            if (!rootNode) return '';
            const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE']);
            const walkChildren = (nodes) => {
              let out = '';
              for (const c of nodes || []) {
                const piece = walk(c);
                if (!piece) continue;
                const cTag = c.nodeType === 1 ? (c.tagName || '').toUpperCase() : '';
                if (BLOCK_TAGS.has(cTag)) {
                  out += (out && !/\s$/.test(out) ? ' ' : '') + piece + ' ';
                } else {
                  out += piece;
                }
              }
              return out;
            };
            const walk = (n) => {
              if (!n) return '';
              if (n.nodeType === 3) return n.textContent || '';
              if (n.nodeType !== 1 && n.nodeType !== 11) return '';
              if (n.nodeType === 1) {
                const t = (n.tagName || '').toUpperCase();
                if (SKIP.has(t)) return '';
                if (t === 'BR') return ' ';
                if (!allowHidden && n !== rootNode) {
                  if (n.hasAttribute?.('hidden') || n.getAttribute?.('aria-hidden') === 'true') return '';
                  try {
                    const st = getComputedStyle(n);
                    if (st.display === 'none' || st.visibility === 'hidden') return '';
                  } catch {}
                }
                if (t === 'SLOT' && typeof n.assignedNodes === 'function') {
                  const assigned = n.assignedNodes({ flatten: true });
                  const list = assigned.length > 0 ? assigned : (n.childNodes || []);
                  return walkChildren(list);
                }
                const sr = getSR(n);
                if (sr) {
                  const srOut = walkChildren(sr.childNodes);
                  if (clean(srOut)) return srOut;
                }
              }
              return walkChildren(n.childNodes);
            };
            return walk(rootNode);
          };

          const resolveAriaLabelledBy = (node) => {
            const lby = node?.getAttribute?.('aria-labelledby');
            if (!lby) return '';
            const rn = node.getRootNode?.();
            return lby
              .split(/\s+/)
              .map((id) => {
                const refEl = (rn?.getElementById && rn.getElementById(id)) || document.getElementById(id);
                return extractAccessibleText(refEl, true) || refEl?.textContent || '';
              })
              .join(' ');
          };

          const submits = queryAllDeep(document, submitSel)
            .filter((el) => {
              if (!vis(el)) return false;
              const r = (el.getAttribute('role') || '').toLowerCase();
              if (['switch', 'checkbox', 'radio', 'combobox', 'option', 'tab', 'menuitem', 'slider'].includes(r)) {
                return false;
              }
              return true;
            })
            .map((el) => {
              const cands = [
                resolveAriaLabelledBy(el),
                el.getAttribute('aria-label'),
                extractAccessibleText(el),
                extractAccessibleText(getSR(el)),
                el.value,
                el.getAttribute('alt'),
                el.querySelector?.('[alt]')?.getAttribute?.('alt'),
                el.querySelector?.('[aria-label]')?.getAttribute?.('aria-label'),
                el.querySelector?.('svg title')?.textContent,
                el.getAttribute('title'),
              ];
              let txt = '';
              for (const c of cands) {
                const n = clean(c).normalize('NFC');
                if (!n) continue;
                if (!txt) txt = n;
                if (/[\p{L}\p{N}]/u.test(n)) {
                  txt = n;
                  break;
                }
              }
              const tag = (el.tagName || '').toLowerCase();
              let hostType = '';
              let curHost = el.getRootNode?.() instanceof ShadowRoot ? el.getRootNode().host : null;
              while (curHost) {
                const ht = (curHost.getAttribute?.('type') || '').toLowerCase();
                if (ht) {
                  hostType = ht;
                  break;
                }
                const nextRn = curHost.getRootNode?.();
                curHost = nextRn instanceof ShadowRoot ? nextRn.host : null;
              }
              const sameScopeForm = Boolean(el.form || el.closest?.('form'));
              const ownType = (
                tag === 'button'
                  ? (sameScopeForm && hostType !== 'button' && hostType !== 'reset' ? (el.type || 'submit') : (el.getAttribute('type') || ''))
                  : (el.getAttribute('type') || '')
              ).toLowerCase();
              const rawType =
                ownType ||
                (hostType === 'submit' || hostType === 'image' || hostType === 'button' || hostType === 'reset' ? hostType : '');
              // Same form (or dialog) as a field we just filled: those buttons commit our fill.
              const scopeOf = (n) => {
                let cur = n;
                while (cur) {
                  if (cur.nodeType === 1 && cur.matches?.('form, dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]')) return cur;
                  const rn = cur.getRootNode?.();
                  cur = cur.parentElement || (rn instanceof ShadowRoot ? rn.host : null);
                }
                return null;
              };
              const myScope = el.form || scopeOf(el);
              let sameScope = false;
              if (myScope) for (const c of claimed) if ((c.form || scopeOf(c)) === myScope) { sameScope = true; break; }
              return { frameIdx: frameIdxArg, text: txt, type: rawType, ...(sameScope ? { _same: 1 } : {}) };
            })
            .filter((b) => b.type === 'submit' || b.type === 'image' || b.text);

          return { frameFilled, frameSkipped, matchedIndexes, leftover, submits };
          },
          {
            domSpec: activeDomFields,
            mainVal: spec.main || '',
            gmailSpec: spec.gmail || null,
            overwriteFlag: overwrite,
            stopBeforeSubmitFlag: spec.stopBeforeSubmit !== false,
            frameIdxArg: frameInfo.frameIdx,
            qBlockSel: QUESTION_BLOCK_SELECTOR,
            submitSel: SUBMIT_SCAN_SELECTOR,
          }
        )
      );
    } catch {
      continue;
    }

    if (!res) continue;
    filled.push(...res.frameFilled);
    skipped.push(...res.frameSkipped);
    for (const mIdx of res.matchedIndexes) matchedFieldIndexes.add(mIdx);
    for (const l of res.leftover) leftoverSet.add(l);
    for (const s of res.submits) {
      const cleanLbl = (s.text || '').normalize('NFC').replace(/^[^\p{L}\p{N}]+/u, '').trim();
      if (SUBMIT_CAND_NEG_RE.test(cleanLbl) || ACCOUNT_CONNECT_RE.test(cleanLbl)) continue;
      const isSafe = Boolean(cleanLbl && SAFE_SUBMIT_TYPE_RE.test(cleanLbl) && !COMPOUND_DANGER_RE.test(cleanLbl));
      if (
        SUBMIT_LABEL_RE.test(cleanLbl) ||
        NEXT_STEP_RE.test(cleanLbl) ||
        SAVE_COMMIT_RE.test(cleanLbl) ||
        (SAFE_SUBMIT_TYPE_RE.test(cleanLbl) && COMPOUND_DANGER_RE.test(cleanLbl)) ||
        ((s.type === 'submit' || s.type === 'image') && !isSafe)
      ) {
        submitButtons.push(s);
      }
    }
  }
  if (submitButtons.length > 1) {
    const rank = (b) => (b._same ? 0 : 2) + (b.type === 'submit' || b.type === 'image' ? 0 : 1);
    submitButtons.sort((a, b) => rank(a) - rank(b));
  }
  if (submitButtons.length > 3) submitButtons.length = 3;
  for (const b of submitButtons) delete b._same;

  // Pass 1.5: Fallback to custom ARIA [role="combobox"] dropdowns (light + open Shadow DOM)
  for (const frameInfo of frames) {
    await frameInfo.frame
      .evaluate(() => {
        const stack = [document];
        while (stack.length > 0) {
          const cur = stack.shift();
          if (!cur || !cur.querySelectorAll) continue;
          for (const el of cur.querySelectorAll('[data-tbm-combo-claimed]')) {
            el.removeAttribute('data-tbm-combo-claimed');
          }
          for (const node of cur.querySelectorAll('*')) {
            if (node.shadowRoot) stack.push(node.shadowRoot);
          }
        }
      })
      .catch(() => {});
  }

  // An array `option` on a combobox picks each entry in turn (multi-select comboboxes such as react-select).
  const comboJobs = domFields.flatMap((f) =>
    f.value === undefined && Array.isArray(f.option) && f.option.length > 0 && f.option.every((o) => typeof o === 'string')
      ? f.option.map((o, k) => ({ ...f, option: o, _again: k > 0 }))
      : [f]);
  for (const f of comboJobs) {
    const comboWanted =
      typeof f.value === 'string'
        ? f.value
        : typeof f.option === 'string'
          ? f.option
          : null;
    if (!comboWanted || (!f._again && matchedFieldIndexes.has(f._idx) && !f.all)) continue;
    if (f._again && !filled.some((e) => e.idx === f._idx)) continue;

    for (const frameInfo of frames) {
      if (f.frameIdx !== undefined && f.frameIdx !== null && Number(f.frameIdx) !== frameInfo.frameIdx) {
        continue;
      }
      if (f.selector) {
        await tagSelectorMatches(frameInfo.frame, f);
      }
      let comboRes = null;
      try {
        comboRes = await frameInfo.frame.evaluate(
          ({ fieldSpec, frameIdxArg, overwriteFlag }) => {
            const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
            const queryAllDeep = (rootNode, sel) => {
              const seen = new Set();
              const out = [];
              const stack = [rootNode];
              while (stack.length > 0) {
                const cur = stack.shift();
                if (!cur) continue;
                if (cur.shadowRoot) stack.push(cur.shadowRoot);
                if (!cur.querySelectorAll) continue;
                let matches;
                try {
                  matches = cur.querySelectorAll(sel);
                } catch {
                  return out;
                }
                for (const match of matches) {
                  if (!seen.has(match)) {
                    seen.add(match);
                    out.push(match);
                  }
                }
                for (const node of cur.querySelectorAll('*')) {
                  if (node.shadowRoot) stack.push(node.shadowRoot);
                }
              }
              return out;
            };

            const safePatternMatch = (text, pat) => {
              if (pat === undefined || pat === null) return false;
              const raw = String(pat);
              if (!raw) return false;
              const hay = String(text || '');
              if (hay.toLowerCase().includes(raw.toLowerCase())) return true;
              try {
                return new RegExp(raw, 'i').test(hay);
              } catch {
                const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return new RegExp(escaped, 'i').test(hay);
              }
            };

            for (const old of queryAllDeep(document, '[data-tbm-combo]')) {
              old.removeAttribute('data-tbm-combo');
            }

            const isDisabledByFieldset = (node) => {
              let cur = node;
              while (cur && cur.nodeType === 1) {
                const parent = cur.parentElement;
                if (parent && parent.tagName === 'FIELDSET' && parent.disabled) {
                  const firstLegend = [...parent.children].find((c) => c.tagName === 'LEGEND');
                  if (!firstLegend || cur !== firstLegend) return true;
                }
                const rn = cur.getRootNode?.();
                cur = parent || (rn instanceof ShadowRoot ? rn.host : null);
              }
              return false;
            };

            const isInert = (node) => {
              let cur = node;
              while (cur && cur.nodeType === 1) {
                if (cur.hasAttribute('inert') || Boolean(cur.inert)) return true;
                const rn = cur.getRootNode?.();
                cur = cur.parentElement || (rn instanceof ShadowRoot ? rn.host : null);
              }
              return false;
            };

            const isClosedDetailsOrCvHidden = (node) => {
              let cur = node;
              while (cur && cur.nodeType === 1) {
                const parent = cur.parentElement;
                if (parent && parent.tagName === 'DETAILS' && !parent.open) {
                  const firstSummary = [...parent.children].find((c) => c.tagName === 'SUMMARY');
                  if (!firstSummary || cur !== firstSummary) return true;
                }
                try {
                  if (getComputedStyle(cur).contentVisibility === 'hidden') return true;
                } catch {
                  // ignore
                }
                const rn = cur.getRootNode?.();
                cur = parent || (rn instanceof ShadowRoot ? rn.host : null);
              }
              return false;
            };

            const compareComposedOrder = (a, b) => {
              if (a === b) return 0;
              const pathOf = (n) => {
                const p = [];
                let c = n;
                while (c) {
                  p.unshift(c);
                  const rn = c.getRootNode?.();
                  c = c.assignedSlot || c.parentNode || (rn instanceof ShadowRoot ? rn.host : null);
                }
                return p;
              };
              const pa = pathOf(a);
              const pb = pathOf(b);
              const len = Math.min(pa.length, pb.length);
              for (let i = 0; i < len; i++) {
                if (pa[i] !== pb[i]) {
                  if (pa[i] instanceof ShadowRoot) return -1;
                  if (pb[i] instanceof ShadowRoot) return 1;
                  const pos = pa[i].compareDocumentPosition(pb[i]);
                  if (pos & 4) return -1;
                  if (pos & 2) return 1;
                  return 0;
                }
              }
              return pa.length - pb.length;
            };

            const getSelOrder = (el, idx) => {
              const raw = el?.getAttribute?.('data-tbm-sel-match') || '';
              const prefix = `${idx}:`;
              for (const part of raw.split(',')) {
                if (part === String(idx)) return 0;
                if (part.startsWith(prefix)) return Number(part.slice(prefix.length)) || 0;
              }
              return -1;
            };

            const hasSelToken = (el, idx) => getSelOrder(el, idx) >= 0;

            const combos = queryAllDeep(document, '[role="combobox"]').filter((el) => {
              if (el.tagName === 'SELECT') return false;
              if (!fieldSpec.all && !fieldSpec._again && el.getAttribute('data-tbm-combo-claimed') === '1') return false;
              if (
                el.disabled ||
                Boolean(el.matches?.(':disabled')) ||
                isDisabledByFieldset(el) ||
                isInert(el) ||
                isClosedDetailsOrCvHidden(el) ||
                el.readOnly ||
                el.hasAttribute('readonly') ||
                el.getAttribute('aria-readonly') === 'true' ||
                el.getAttribute('aria-disabled') === 'true' ||
                Boolean(el.closest('[aria-disabled="true"]')) ||
                el.getAttribute('aria-hidden') === 'true' ||
                Boolean(el.closest('[aria-hidden="true"]'))
              ) {
                return false;
              }
              const st = getComputedStyle(el);
              const r = el.getBoundingClientRect();
              return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) !== 0 && r.width > 0 && r.height > 0;
            });

            const keys = Array.isArray(fieldSpec.keys) ? fieldSpec.keys : fieldSpec.keys ? [fieldSpec.keys] : [];
            const nots = Array.isArray(fieldSpec.not) ? fieldSpec.not : fieldSpec.not ? [fieldSpec.not] : [];

            const resolveById = (el, id) => {
              const rootNode = el.getRootNode?.();
              return (rootNode?.getElementById && rootNode.getElementById(id)) || document.getElementById(id);
            };

            const closestComposed = (node, sel) => {
              let cur = node;
              while (cur) {
                if (cur.nodeType === 1 && cur.matches?.(sel)) return cur;
                const rn = cur.getRootNode?.();
                cur = cur.assignedSlot || cur.parentElement || (rn instanceof ShadowRoot ? rn.host : null);
              }
              return null;
            };

            const BLOCK_TAGS = new Set([
              'DIV', 'P', 'LI', 'UL', 'OL', 'TR', 'TD', 'TH',
              'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'ASIDE', 'NAV',
              'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'BR',
            ]);
            const getSR = (node) => node?.shadowRoot || window.__tbmGetShadowRoot?.(node) || null;
            const composedText = (rootNode, allowHidden = false, excludeNode = null) => {
              if (!rootNode) return '';
              const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'SELECT', 'OPTION']);
              const walkChildren = (nodes) => {
                let out = '';
                for (const c of nodes || []) {
                  const piece = walk(c);
                  if (!piece) continue;
                  const cTag = c.nodeType === 1 ? (c.tagName || '').toUpperCase() : '';
                  if (BLOCK_TAGS.has(cTag)) {
                    out += (out && !/\s$/.test(out) ? ' ' : '') + piece + ' ';
                  } else {
                    out += piece;
                  }
                }
                return out;
              };
              const walk = (n) => {
                if (!n || n === excludeNode) return '';
                if (n.nodeType === 3) return n.textContent || '';
                if (n.nodeType !== 1 && n.nodeType !== 11) return '';
                if (n.nodeType === 1) {
                  const t = (n.tagName || '').toUpperCase();
                  if (SKIP.has(t)) return '';
                  if (t === 'BR') return ' ';
                  if (!allowHidden && n !== rootNode) {
                    if (n.hasAttribute?.('hidden') || n.getAttribute?.('aria-hidden') === 'true') return '';
                    try {
                      const st = getComputedStyle(n);
                      if (st.display === 'none' || st.visibility === 'hidden') return '';
                    } catch {}
                  }
                  if (t === 'SLOT' && typeof n.assignedNodes === 'function') {
                    const assigned = n.assignedNodes({ flatten: true });
                    const list = assigned.length > 0 ? assigned : (n.childNodes || []);
                    return walkChildren(list);
                  }
                  const sr = getSR(n);
                  if (sr) {
                    const srOut = walkChildren(sr.childNodes);
                    if (clean(srOut)) return srOut;
                  }
                }
                return walkChildren(n.childNodes);
              };
              return clean(walk(rootNode));
            };

            const describeComboParts = (el) => {
              const lblBy = (el.getAttribute('aria-labelledby') || '')
                .split(/\s+/)
                .map((id) => {
                  const refNode = resolveById(el, id);
                  return composedText(refNode, true) || refNode?.innerText || '';
                })
                .join(' ');
              const prev = el.previousElementSibling;
              const prevTxt =
                prev && !prev.matches('button, input, select, textarea, a, [role="button"], [role="combobox"]')
                  ? (composedText(prev) || prev.innerText)
                  : '';
              const blk = closestComposed(el, '[class*="field"], [class*="Field"], .form-group, [role="listitem"]');
              let blkTxt = '';
              let blkLblTxt = '';
              if (blk) {
                const siblings = queryAllDeep(
                  blk,
                  'input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]):not([type="file"]), textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]'
                );
                if (siblings.length <= 1) {
                  blkTxt = composedText(blk, false, el) || composedText(blk) || blk.innerText;
                  const innerLbl = blk.querySelector('label');
                  if (innerLbl) blkLblTxt = composedText(innerLbl, false, el) || composedText(innerLbl) || innerLbl.innerText;
                }
              }
              const wrapLbl = closestComposed(el, 'label');
              const wrapLblClean = wrapLbl ? (composedText(wrapLbl, false, el) || composedText(wrapLbl) || wrapLbl.innerText) : '';
              const host = el.getRootNode?.()?.host;
              const hostAttr = host ? (host.getAttribute('aria-label') || host.getAttribute('data-label') || '') : '';
              const rawParts = [
                el.getAttribute('aria-label'),
                el.getAttribute('placeholder'),
                el.getAttribute('name'),
                el.getAttribute('id'),
                lblBy,
                wrapLblClean,
                hostAttr,
                prevTxt,
                blkLblTxt,
                blkTxt,
              ];
              const primaryParts = rawParts.map((p) => clean(p)).filter(Boolean);
              const contextParts = [];
              let curFs = closestComposed(el, 'fieldset');
              while (curFs) {
                const leg = curFs.querySelector('legend');
                const legTxt = leg ? (composedText(leg) || clean(leg.innerText)) : '';
                if (legTxt) contextParts.unshift(legTxt);
                const rnFs = curFs.getRootNode?.();
                curFs = closestComposed(curFs.assignedSlot || curFs.parentElement || (rnFs instanceof ShadowRoot ? rnFs.host : null), 'fieldset');
              }
              const sec = closestComposed(el, 'section, [role="region"], [role="group"]');
              if (sec && sec.tagName !== 'FIELDSET') {
                const secAria = sec.getAttribute('aria-label');
                const secLby = sec.getAttribute('aria-labelledby');
                let secHeading = '';
                if (secAria) {
                  secHeading = secAria;
                } else if (secLby) {
                  secHeading = secLby
                    .split(/\s+/)
                    .map((id) => {
                      const rn = resolveById(sec, id);
                      return composedText(rn, true) || rn?.innerText || '';
                    })
                    .join(' ');
                } else {
                  const h = sec.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > legend');
                  if (h) secHeading = composedText(h) || h.innerText;
                }
                if (clean(secHeading)) contextParts.push(clean(secHeading));
              }
              const allParts = [...primaryParts];
              if (contextParts.length > 0) {
                const ctxJoined = contextParts.join(' ');
                if (primaryParts.length > 0) {
                  for (const pp of primaryParts) {
                    allParts.push(`${ctxJoined} ${pp}`);
                  }
                } else {
                  allParts.push(ctxJoined);
                }
              }
              return allParts.map((p) => clean(p).toLowerCase()).filter(Boolean);
            };

            const describeCombo = (el) => describeComboParts(el).join(' | ');

            const rankCombo = (el) => {
              if (keys.length === 0) return 0;
              const parts = describeComboParts(el);
              const fullText = parts.join(' | ');
              if (nots.some((n) => safePatternMatch(fullText, n))) return 0;
              let bestTier = 0;
              for (const k of keys) {
                const raw = clean(String(k ?? ''));
                if (!raw) continue;
                const rawLower = raw.toLowerCase();
                if (parts.some((p) => p === rawLower)) {
                  if (bestTier < 4) bestTier = 4;
                  continue;
                }
                const escaped = rawLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const partPrefixRe = new RegExp(`^${escaped}(?![\\p{L}\\p{N}_])`, 'iu');
                if (parts.some((p) => partPrefixRe.test(p))) {
                  if (bestTier < 3) bestTier = 3;
                  continue;
                }
                const wordBoundaryRe = new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu');
                if (wordBoundaryRe.test(fullText)) {
                  if (bestTier < 2) bestTier = 2;
                  continue;
                }
                if (safePatternMatch(fullText, k)) {
                  if (bestTier < 1) bestTier = 1;
                }
              }
              return bestTier;
            };

            let hit = null;
            if (fieldSpec.ref) {
              const m = /^(?:f(\d+):)?(e\d+)$/i.exec(fieldSpec.ref.trim());
              if (m && (m[1] === undefined || Number(m[1]) === frameIdxArg)) {
                hit = combos.find((el) => el.getAttribute('data-tbm-ref') === m[2]) || null;
              }
            } else if (fieldSpec.selector) {
              const taggedCombos = combos
                .filter((el) => hasSelToken(el, fieldSpec._idx))
                .sort(compareComposedOrder);
              hit =
                taggedCombos[0] ||
                combos
                  .filter((el) => {
                    try {
                      return el.matches(fieldSpec.selector);
                    } catch {
                      return false;
                    }
                  })
                  .sort(compareComposedOrder)[0] ||
                null;
            } else if (keys.length > 0) {
              let bestTier = 0;
              for (const el of combos) {
                const t = rankCombo(el);
                if (t > bestTier) {
                  bestTier = t;
                  hit = el;
                  if (t === 4) break;
                }
              }
            }

            if (!hit) return null;

            const rawComboVal = clean(
              hit.value ||
              hit.getAttribute('data-value') ||
              hit.getAttribute('data-selected') ||
              composedText(hit) ||
              (hit.innerText || hit.textContent || '')
            );
            const placeholderAttr = clean(hit.getAttribute('placeholder') || hit.getAttribute('data-placeholder') || '');
            const isPlaceholderText =
              !rawComboVal ||
              (placeholderAttr && rawComboVal.toLowerCase() === placeholderAttr.toLowerCase()) ||
              /^(--|choose\b|select\b|pick\b|chọn\b|\.\.\.|…)/i.test(rawComboVal) ||
              /\.\.\.$|…$/.test(rawComboVal);

            if (!isPlaceholderText && !overwriteFlag) {
              hit.setAttribute('data-tbm-combo-claimed', '1');
              return { skipped: true, label: describeCombo(hit).slice(0, 50) };
            }

            const marker = `c${fieldSpec._idx}`;
            hit.setAttribute('data-tbm-combo', marker);
            return { marker, label: describeCombo(hit).slice(0, 50) };
          },
          { fieldSpec: f, frameIdxArg: frameInfo.frameIdx, overwriteFlag: overwrite }
        );
      } catch {
        comboRes = null;
      }
      if (!comboRes) continue;
      if (comboRes.skipped) {
        skipped.push({
          idx: f._idx,
          frameIdx: frameInfo.frameIdx,
          reason: 'already-filled',
          label: comboRes.label,
        });
        matchedFieldIndexes.add(f._idx);
        if (!f.all) break;
        continue;
      }

      try {
        const comboLoc = frameInfo.frame.locator(`[data-tbm-combo="${comboRes.marker}"]`).first();
        const optionScopes = frameInfo.isMain ? [frameInfo.frame] : [frameInfo.frame, page.mainFrame()];
        const stopBeforeSubmit = spec.stopBeforeSubmit !== false;

        const clickWidgetSafely = async (loc) => {
          await withFrameSubmitGuard(frameInfo.frame, async () => {
            if (stopBeforeSubmit) {
              await loc
                .evaluate((el) => {
                  const win = el.ownerDocument?.defaultView || window;
                  const btn = el.tagName === 'BUTTON' ? el : el.closest?.('button');
                  const form = el.form || btn?.form || el.closest?.('form');
                  const isSubmitBtn =
                    btn && form && (btn.type || 'submit').toLowerCase() === 'submit';
                  if (isSubmitBtn) {
                    win.addEventListener('click', (e) => e.preventDefault(), { once: true });
                  }
                })
                .catch(() => {});
            }
            await loc.click({ timeout: 2500 });
          });
        };

        const tryPickEnabledOption = async () => {
          let sawDisabledMatch = false;
          let anyVisibleOption = false;
          for (const scope of optionScopes) {
            const anyOptCount = await scope.getByRole('option').count().catch(() => 0);
            if (anyOptCount > 0) {
              for (let k = 0; k < Math.min(anyOptCount, 12); k++) {
                if (await scope.getByRole('option').nth(k).isVisible().catch(() => false)) {
                  anyVisibleOption = true;
                  break;
                }
              }
            }
            const candidates = [
              scope.getByRole('option', { name: comboWanted, exact: true }),
              scope.getByRole('option', { name: comboWanted, exact: false }),
              scope.getByRole('option', { name: compileFilterRegex(comboWanted) }),
            ];
            for (const cand of candidates) {
              const count = await cand.count().catch(() => 0);
              if (count <= 0) continue;
              const limit = Math.min(count, 12);
              for (let i = 0; i < limit; i++) {
                const nth = cand.nth(i);
                const visible = await nth.isVisible().catch(() => false);
                if (!visible) continue;
                anyVisibleOption = true;
                const isDisabledOpt = await nth
                  .evaluate((el) =>
                    Boolean(
                      el.disabled ||
                      el.getAttribute('aria-disabled') === 'true' ||
                      el.closest('[aria-disabled="true"]')
                    )
                  )
                  .catch(() => false);
                if (isDisabledOpt) {
                  sawDisabledMatch = true;
                  continue;
                }
                await clickWidgetSafely(nth);
                return { clicked: true, sawDisabledMatch, anyVisibleOption };
              }
            }
          }
          return { clicked: false, sawDisabledMatch, anyVisibleOption };
        };

        const wasLeftOpen = await comboLoc
          .evaluate((el) => el.getAttribute('data-tbm-combo-open') === '1')
          .catch(() => false);

        let clickedOption = false;
        if (wasLeftOpen) {
          const preCheck = await tryPickEnabledOption();
          if (preCheck.clicked) {
            clickedOption = true;
            await comboLoc.evaluate((el) => el.removeAttribute('data-tbm-combo-open')).catch(() => {});
          } else if (preCheck.sawDisabledMatch) {
            // Target option is still disabled in the already-open dropdown
          } else if (!preCheck.anyVisibleOption) {
            await clickWidgetSafely(comboLoc);
          }
        } else {
          await clickWidgetSafely(comboLoc);
        }

        if (!clickedOption) {
          for (let attempt = 0; attempt < 18; attempt++) {
            const pollRes = await tryPickEnabledOption();
            if (pollRes.clicked) {
              clickedOption = true;
              await comboLoc.evaluate((el) => el.removeAttribute('data-tbm-combo-open')).catch(() => {});
              break;
            }
            if (pollRes.sawDisabledMatch) {
              await comboLoc.evaluate((el) => el.setAttribute('data-tbm-combo-open', '1')).catch(() => {});
              break;
            }
            // The list is open but the option is not rendered (paged, windowed or filtered list):
            // stop polling and go to the search box / keyboard steps below.
            if (pollRes.anyVisibleOption && attempt >= 2) break;
            await page.waitForTimeout(35);
          }
        }

        if (!clickedOption) {
          // Portaled lists with their own search box: the box is focused on open, or sits next to
          // the listbox named by aria-controls. Type the wanted text there, then pick the option.
          const searchHandle = await comboLoc.evaluateHandle((el) => {
            const isText = (n) => Boolean(n && n !== el && n.matches?.(
              'input:not([type]), input[type="text"], input[type="search"], textarea') && !n.readOnly && !n.disabled);
            const doc = el.ownerDocument;
            if (isText(doc.activeElement)) return doc.activeElement;
            const id = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
            let box = id ? doc.getElementById(id) : null;
            for (let up = 0; box && up < 3; up++, box = box.parentElement) {
              const input = [...box.querySelectorAll('input, textarea')].find(isText);
              if (input) return input;
            }
            return null;
          }).catch(() => null);
          const searchEl = searchHandle?.asElement?.() || null;
          if (searchEl) {
            await searchEl.fill(comboWanted).catch(() => {});
            for (let attempt = 0; attempt < 18 && !clickedOption; attempt++) {
              const pollRes = await tryPickEnabledOption();
              if (pollRes.clicked) {
                clickedOption = true;
                await comboLoc.evaluate((el) => el.removeAttribute('data-tbm-combo-open')).catch(() => {});
              } else if (pollRes.sawDisabledMatch) {
                break;
              } else {
                await page.waitForTimeout(35);
              }
            }
          }
          await searchHandle?.dispose?.().catch(() => {});
        }

        if (!clickedOption) {
          // Windowed lists may have no matching DOM option until keyboard navigation.
          const inner = comboLoc.locator('input:not([type="hidden"]), textarea').first();
          const keyboard = await comboLoc.evaluate((el) => el.matches('input, textarea'))
            ? comboLoc : await inner.count() ? inner : comboLoc;
          await keyboard.focus();
          if (await keyboard.evaluate((el) => el.matches('input, textarea') && !el.readOnly)) {
            await keyboard.fill(comboWanted);
          }
          for (let step = 0; step < 100; step++) {
            await page.keyboard.press('ArrowDown');
            const activeMatches = await keyboard.evaluate((el, wanted) => {
              const root = el.getRootNode();
              const id = el.getAttribute('aria-activedescendant') ||
                el.closest('[role="combobox"]')?.getAttribute('aria-activedescendant');
              const active = (id && (root.getElementById?.(id) || el.ownerDocument.getElementById(id))) ||
                root.activeElement;
              return active?.getAttribute('role') === 'option' &&
                active.getAttribute('aria-disabled') !== 'true' &&
                (active.textContent || '').trim().toLowerCase() === wanted.trim().toLowerCase();
            }, comboWanted);
            if (!activeMatches) continue;
            await withFrameSubmitGuard(frameInfo.frame, () => page.keyboard.press('Enter'));
            // A search input containing the query is not evidence of a selection.
            for (let attempt = 0; attempt < 10; attempt++) {
              clickedOption = await comboLoc.evaluate((el, wanted) => {
                const clean = (v) => String(v || '').trim().toLowerCase();
                const values = [el.getAttribute('data-value'), el.getAttribute('data-selected'),
                  el.getAttribute('aria-valuetext'), el.textContent];
                if (el.getAttribute('aria-expanded') === 'false') values.push(el.value);
                return values.some((v) => clean(v) === clean(wanted));
              }, comboWanted);
              if (clickedOption) break;
              await page.waitForTimeout(35);
            }
            break;
          }
        }

        if (!clickedOption) {
          const seen = [];
          for (const scope of optionScopes) {
            const texts = await scope.getByRole('option').allTextContents().catch(() => []);
            for (const t of texts) if (t.trim() && seen.length < 5) seen.push(t.trim().slice(0, 60));
          }
          skipped.push({ idx: f._idx, reason: 'combobox-option-not-found', wanted: comboWanted,
            ...(seen.length ? { visibleOptions: seen } : {}) });
          await page.keyboard.press('Escape').catch(() => {});
          matchedFieldIndexes.add(f._idx);
          break;
        }

        if (clickedOption) {
          await comboLoc.evaluate((el) => el.setAttribute('data-tbm-combo-claimed', '1')).catch(() => {});
          filled.push({
            idx: f._idx,
            frameIdx: frameInfo.frameIdx,
            tag: 'role:combobox',
            value: comboWanted,
          });
          matchedFieldIndexes.add(f._idx);
          if (!f.all) break;
        }
      } catch {
        // Ignore dropdown option lookup failures and move on.
      }
    }
  }

  // Never drop a field silently: anything neither filled nor already reported is listed here.
  const reported = new Set(skipped.map((e) => e.idx));
  for (const f of domFields) {
    if (matchedFieldIndexes.has(f._idx) || reported.has(f._idx)) continue;
    const hasTarget = Boolean(f.ref || f.selector || f.keys);
    skipped.push({ idx: f._idx, reason: hasTarget ? 'not-found' : 'no-target' });
  }

  if (selectorHandlesToDispose.length > 0) {
    for (const h of selectorHandlesToDispose) {
      await h.dispose().catch(() => {});
    }
    for (const frameInfo of frames) {
      await frameInfo.frame
        .evaluate(() => {
          const stack = [document];
          while (stack.length > 0) {
            const cur = stack.shift();
            if (!cur || !cur.querySelectorAll) continue;
            for (const el of cur.querySelectorAll('[data-tbm-sel-match]')) {
              el.removeAttribute('data-tbm-sel-match');
            }
            for (const node of cur.querySelectorAll('*')) {
              if (node.shadowRoot) stack.push(node.shadowRoot);
            }
          }
        })
        .catch(() => {});
    }
  }

  // Pass 2: Direct disk file uploads across frames via Playwright setInputFiles.
  if (fileFields.length > 0) {
    for (const frameInfo of frames) {
      await frameInfo.frame
        .evaluate(() => {
          const stack = [document];
          while (stack.length > 0) {
            const cur = stack.shift();
            if (!cur || !cur.querySelectorAll) continue;
            for (const el of cur.querySelectorAll('input[type="file"][data-tbm-file-claimed]')) {
              el.removeAttribute('data-tbm-file-claimed');
            }
            for (const node of cur.querySelectorAll('*')) {
              if (node.shadowRoot) stack.push(node.shadowRoot);
            }
          }
        })
        .catch(() => {});
    }
  }

  const setInputFilesSafely = async (loc, paths, frame) => {
    const targetFrame = frame || loc.page?.()?.mainFrame?.() || page.mainFrame();
    await loc.evaluate((el) => el.setAttribute('data-tbm-file-claimed', '1')).catch(() => {});
    await withFrameSubmitGuard(targetFrame, async () => {
      await loc.setInputFiles(paths);
    });
  };

  for (const ff of fileFields) {
    const rawList =
      Array.isArray(ff.files) && ff.files.length > 0
        ? ff.files
        : ff.file
          ? [ff.file]
          : [];
    const validList = rawList.filter((p) => p !== undefined && p !== null && String(p).trim() !== '');
    if (validList.length === 0) {
      skipped.push({ idx: ff._idx, reason: 'empty-file-list' });
      continue;
    }
    const resolvedPaths = validList.map((p) => path.resolve(String(p)));
    for (const p of resolvedPaths) {
      if (!fs.existsSync(p)) {
        throw new Error(`Upload file does not exist on disk: ${p}`);
      }
    }

    let uploaded = false;
    if (ff.ref || ff.selector) {
      const target = await resolveTarget(
        page,
        {
          ref: ff.ref,
          selector: ff.selector,
          frameIdx: ff.frameIdx,
        },
        { allowHidden: true }
      );
      const isDisabledOrInertTarget = await target.locator
        .evaluate((el) => {
          const isDisabledByFieldset = (node) => {
            let cur = node;
            while (cur && cur.nodeType === 1) {
              const parent = cur.parentElement;
              if (parent && parent.tagName === 'FIELDSET' && parent.disabled) {
                const firstLegend = [...parent.children].find((c) => c.tagName === 'LEGEND');
                if (!firstLegend || cur !== firstLegend) return true;
              }
              const rn = cur.getRootNode?.();
              cur = parent || (rn instanceof ShadowRoot ? rn.host : null);
            }
            return false;
          };
          let cur = el;
          while (cur && cur.nodeType === 1) {
            if (cur.hasAttribute('inert') || Boolean(cur.inert)) return true;
            const rn = cur.getRootNode?.();
            cur = cur.parentElement || (rn instanceof ShadowRoot ? rn.host : null);
          }
          return (
            Boolean(el.disabled) ||
            Boolean(el.matches?.(':disabled')) ||
            isDisabledByFieldset(el) ||
            el.getAttribute('aria-disabled') === 'true' ||
            Boolean(el.closest('[aria-disabled="true"]'))
          );
        })
        .catch(() => false);
      if (isDisabledOrInertTarget) {
        skipped.push({ idx: ff._idx, reason: 'file-input-disabled' });
        continue;
      }
      const isFileInput = await target.locator.evaluate(
        (el) => el.tagName === 'INPUT' && el.type === 'file'
      );
      if (isFileInput) {
        await setInputFilesSafely(target.locator, resolvedPaths, target.frame);
        uploaded = true;
      } else {
        if (spec.stopBeforeSubmit !== false) {
          const meta = await isSubmitLikeElement(target.locator);
          if (meta.isSubmit) {
            skipped.push({ idx: ff._idx, reason: 'blocked-submit-target', label: meta.label });
            continue;
          }
          await target.locator.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
          const box = await target.locator.boundingBox().catch(() => null);
          if (box && box.width > 0 && box.height > 0) {
            const ptMeta = await isSubmitAtPoint(page, box.x + box.width / 2, box.y + box.height / 2);
            if (ptMeta.isSubmit) {
              skipped.push({ idx: ff._idx, reason: 'blocked-submit-target', label: ptMeta.label });
              continue;
            }
          }
        }
        await withFrameSubmitGuard(target.frame, async () => {
          const [chooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 4000 }),
            target.locator.click(),
          ]);
          await chooser.setFiles(resolvedPaths);
        });
        uploaded = true;
      }
    } else {
      const fileKeys = Array.isArray(ff.keys) ? ff.keys : ff.keys ? [ff.keys] : [];
      const fileNots = Array.isArray(ff.not) ? ff.not : ff.not ? [ff.not] : [];
      for (const frameInfo of frames) {
        if (ff.frameIdx !== undefined && ff.frameIdx !== null && Number(ff.frameIdx) !== frameInfo.frameIdx) {
          continue;
        }
        const fileInputs = frameInfo.frame.locator('input[type="file"]');
        const count = await fileInputs.count();
        for (let i = 0; i < count; i++) {
          const loc = fileInputs.nth(i);
          const isSkipOrClaimed = await loc
            .evaluate((el, allowAll) => {
              const isDisabledByFieldset = (node) => {
                let cur = node;
                while (cur && cur.nodeType === 1) {
                  const parent = cur.parentElement;
                  if (parent && parent.tagName === 'FIELDSET' && parent.disabled) {
                    const firstLegend = [...parent.children].find((c) => c.tagName === 'LEGEND');
                    if (!firstLegend || cur !== firstLegend) return true;
                  }
                  const rn = cur.getRootNode?.();
                  cur = parent || (rn instanceof ShadowRoot ? rn.host : null);
                }
                return false;
              };
              let cur = el;
              while (cur && cur.nodeType === 1) {
                if (cur.hasAttribute('inert') || Boolean(cur.inert)) return true;
                const rn = cur.getRootNode?.();
                cur = cur.parentElement || (rn instanceof ShadowRoot ? rn.host : null);
              }
              return (
                (!allowAll && el.getAttribute('data-tbm-file-claimed') === '1') ||
                el.disabled ||
                Boolean(el.matches?.(':disabled')) ||
                isDisabledByFieldset(el) ||
                el.getAttribute('aria-disabled') === 'true' ||
                Boolean(el.closest('[aria-disabled="true"]'))
              );
            }, Boolean(ff.all))
            .catch(() => false);
          if (isSkipOrClaimed) continue;

          if (fileKeys.length > 0 || fileNots.length > 0) {
            const label = await loc.evaluate((el) => {
              const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
              const resolveById = (node, id) => {
                const rn = node.getRootNode?.();
                return (rn?.getElementById && rn.getElementById(id)) || document.getElementById(id);
              };
              const closestComposed = (node, sel) => {
                let cur = node;
                while (cur) {
                  if (cur.nodeType === 1 && cur.matches?.(sel)) return cur;
                  const rn = cur.getRootNode?.();
                  cur = cur.assignedSlot || cur.parentElement || (rn instanceof ShadowRoot ? rn.host : null);
                }
                return null;
              };
              const BLOCK_TAGS = new Set([
                'DIV', 'P', 'LI', 'UL', 'OL', 'TR', 'TD', 'TH',
                'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'ASIDE', 'NAV',
                'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'BR',
              ]);
              const getSR = (node) => node?.shadowRoot || window.__tbmGetShadowRoot?.(node) || null;
              const composedText = (rootNode, allowHidden = false) => {
                if (!rootNode) return '';
                const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'SELECT', 'OPTION']);
                const walkChildren = (nodes) => {
                  let out = '';
                  for (const c of nodes || []) {
                    const piece = walk(c);
                    if (!piece) continue;
                    const cTag = c.nodeType === 1 ? (c.tagName || '').toUpperCase() : '';
                    if (BLOCK_TAGS.has(cTag)) {
                      out += (out && !/\s$/.test(out) ? ' ' : '') + piece + ' ';
                    } else {
                      out += piece;
                    }
                  }
                  return out;
                };
                const walk = (n) => {
                  if (!n) return '';
                  if (n.nodeType === 3) return n.textContent || '';
                  if (n.nodeType !== 1 && n.nodeType !== 11) return '';
                  if (n.nodeType === 1) {
                    const t = (n.tagName || '').toUpperCase();
                    if (SKIP.has(t)) return '';
                    if (t === 'BR') return ' ';
                    if (!allowHidden && n !== rootNode) {
                      if (n.hasAttribute?.('hidden') || n.getAttribute?.('aria-hidden') === 'true') return '';
                      try {
                        const st = getComputedStyle(n);
                        if (st.display === 'none' || st.visibility === 'hidden') return '';
                      } catch {}
                    }
                    if (t === 'SLOT' && typeof n.assignedNodes === 'function') {
                      const assigned = n.assignedNodes({ flatten: true });
                      const list = assigned.length > 0 ? assigned : (n.childNodes || []);
                      return walkChildren(list);
                    }
                    const sr = getSR(n);
                    if (sr) {
                      const srOut = walkChildren(sr.childNodes);
                      if (clean(srOut)) return srOut;
                    }
                  }
                  return walkChildren(n.childNodes);
                };
                return clean(walk(rootNode));
              };
              const lbyTxt = (el.getAttribute('aria-labelledby') || '')
                .split(/\s+/)
                .map((id) => {
                  const refNode = resolveById(el, id);
                  return composedText(refNode, true) || refNode?.innerText || '';
                })
                .join(' ');
              const wrapLbl = closestComposed(el, 'label');
              const blk = closestComposed(el, '.form-group, .field, [role="listitem"]');
              const host = el.getRootNode?.()?.host;
              const hostAttr = host ? (host.getAttribute('aria-label') || host.getAttribute('data-label') || '') : '';
              const primary = [
                el.getAttribute('aria-label'),
                el.name,
                el.id,
                el.title,
                lbyTxt,
                hostAttr,
                ...(el.labels ? [...el.labels].map((l) => composedText(l) || l.innerText) : []),
                wrapLbl ? (composedText(wrapLbl) || wrapLbl.innerText) : '',
                blk ? (composedText(blk) || blk.innerText) : '',
              ]
                .map(clean)
                .filter(Boolean);

              const ctx = [];
              let curFs = closestComposed(el, 'fieldset');
              while (curFs) {
                const leg = curFs.querySelector('legend');
                const legTxt = leg ? (composedText(leg) || clean(leg.innerText)) : '';
                if (legTxt) ctx.unshift(legTxt);
                const rnFs = curFs.getRootNode?.();
                curFs = closestComposed(curFs.assignedSlot || curFs.parentElement || (rnFs instanceof ShadowRoot ? rnFs.host : null), 'fieldset');
              }
              const sec = closestComposed(el, 'section, [role="region"], [role="group"]');
              if (sec && sec.tagName !== 'FIELDSET') {
                const secAria = sec.getAttribute('aria-label');
                const h = sec.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > legend');
                const secTxt = clean(secAria || (h ? (composedText(h) || h.innerText) : '') || '');
                if (secTxt) ctx.push(secTxt);
              }
              const out = [...primary];
              if (ctx.length > 0) {
                const ctxStr = ctx.join(' ');
                out.push(ctxStr);
                for (const p of primary) out.push(`${ctxStr} ${p}`);
              }
              return out.join(' | ');
            });
            if (fileNots.some((n) => matchesPattern(label, n))) continue;
            if (fileKeys.length > 0 && !fileKeys.some((k) => matchesPattern(label, k))) continue;
          }
          await setInputFilesSafely(loc, resolvedPaths, frameInfo.frame);
          uploaded = true;
          if (!ff.all) break;
        }
        if (uploaded && !ff.all) break;
      }
    }

    if (uploaded) {
      filled.push({
        idx: ff._idx,
        tag: 'input:file',
        files: resolvedPaths.map((p) => path.basename(p)),
      });
    } else {
      skipped.push({ idx: ff._idx, reason: 'file-input-not-found' });
    }
  }

  const refilled = spec._noRecheck ? 0 : await recheckFilled(page, spec, filled);

  // Shadow-DOM fields (web components) whose component ignored the programmatic value: type them for real.
  if (!spec._noRecheck) {
    const shadowFills = filled.filter((e) => e && e._sh && e.value !== undefined);
    if (shadowFills.length > 0) {
      for (const fi of new Set(shadowFills.map((e) => e.frameIdx))) {
        const frame = frames.find((f) => f.frameIdx === fi)?.frame;
        if (!frame) continue;
        const group = shadowFills.filter((e) => e.frameIdx === fi);
        const bad = await frame.evaluate(commitStaleProbe, group.map((e) => String(e.idx))).catch(() => []);
        for (const e of group) {
          if (!bad.includes(String(e.idx))) continue;
          const want = spec.fields?.[e.idx]?.value;
          if (typeof want !== 'string') continue;
          if (await retypeField(page, frame.locator(`[data-tbm-fill="${e.idx}"]`).first(), want)) e.retyped = true;
        }
      }
    }
    for (const e of filled) if (e && e._sh) delete e._sh;
  }

  const output = {
    filledCount: filled.length,
    filled,
    skipped,
    leftover: [...leftoverSet].slice(0, 12),
    stoppedBeforeSubmit: spec.stopBeforeSubmit !== false,
    submitButtons,
    ...(refilled > 0 ? { refilled } : {}),
    elapsedMs: Date.now() - t0,
  };

  if (spec.returnSnapshot) {
    const snap = await inspectCompact(
      page,
      { mode: spec.snapshotMode || 'forms', maxChars: spec.snapshotMaxChars || 2500, query: spec.snapshotQuery },
      previousLinesSet
    );
    output.snapshot = wrapPage(snap.text);
    output.elapsedMs = Date.now() - t0;
  }

  return output;
}

/**
 * Run one action and, if the submit guard suppressed a form submission the action triggered
 * (submit event, form.submit(), requestSubmit()), say so in the result. The action itself still
 * succeeded (e.g. a select changed its value), so ok stays true and batches keep going.
 */
// Listen before the action: waitForLoadState alone can resolve against the old document.
// How long to wait for a navigation to start after the action before assuming none will.
const NAV_START_WINDOW_MS = 150;
function watchActionNavigation(page, timeout) {
  const deadline = Date.now() + timeout;
  const beforeUrl = page.url();
  let requested = false, loaded = false;
  let wake = () => {};
  const onRequest = (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      requested = true;
      loaded = false;
      wake();
    }
  };
  const onLoaded = () => { loaded = true; wake(); };
  const onNavigated = (frame) => { if (frame === page.mainFrame()) wake(); };
  const onCancelled = (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      requested = false;
      wake();
    }
  };
  const onResponse = (response) => {
    // The network guard uses 204 to keep the current document when blocking a POST.
    if ([204, 205].includes(response.status())) onCancelled(response.request());
  };
  page.on('request', onRequest);
  page.on('requestfailed', onCancelled);
  page.on('response', onResponse);
  page.on('domcontentloaded', onLoaded);
  page.on('framenavigated', onNavigated);
  const wait = (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => { clearTimeout(timer); resolve(); };
  });
  return {
    async finish() {
      if (!requested && page.url() === beforeUrl) {
        // Always give a navigation the start window, even when the action itself used up the
        // timeout; otherwise a slow click hides a navigation that is about to begin.
        await wait(NAV_START_WINDOW_MS);
      }
      // pushState/hash changes have no document request and need no load wait.
      while (requested && !loaded) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Navigation did not reach domcontentloaded within the action timeout.');
        await wait(remaining);
      }
    },
    remove() {
      page.off('request', onRequest);
      page.off('requestfailed', onCancelled);
      page.off('response', onResponse);
      page.off('domcontentloaded', onLoaded);
      page.off('framenavigated', onNavigated);
    },
  };
}

/**
 * Scroll-and-collect for virtualized feeds: reads innerText of every element matching `selector`, scrolls (the
 * nearest scrollable ancestor of the first match, else the window), repeats, and returns the unique items.
 * One round trip; the loop runs inside the page. Dedupe is by a cheap text hash.
 */
export async function collectItems(page, step = {}) {
  const selector = String(step.selector || '');
  if (!selector) throw new Error('collect requires selector.');
  const scrolls = Math.min(60, Math.max(0, Number.isFinite(Number(step.scrolls)) ? Number(step.scrolls) : 5));
  const waitMs = Math.min(5000, Math.max(0, Number.isFinite(Number(step.waitMs)) ? Number(step.waitMs) : 400));
  const maxItems = Math.min(2000, Math.max(1, Number(step.maxItems) || 100));
  const maxChars = Math.max(200, Number(step.maxChars) || 8000);
  const fields = Array.isArray(step.fields) ? step.fields.filter((f) => f === 'text' || f === 'href' || f === 'id') : [];
  const sub = String(step.itemSelector || step.textSelector || '');
  const t0 = Date.now();
  const r = await page.evaluate(
    async ({ sel, sub, scrolls: nScrolls, waitMs: wait, maxItems: cap, maxChars: charCap, fields: want }) => {
      const hash = (s) => {
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) | 0;
        return `${s.length}:${h}`;
      };
      const seen = new Set(); // per call only: nothing survives between collect calls or navigations
      const items = [];
      let chars = 0;
      let full = false;
      let matched = 0;
      const read = () => {
        let added = 0;
        const els = document.querySelectorAll(sel);
        matched = Math.max(matched, els.length);
        for (const el of els) {
          if (full) break;
          const tEl = sub ? el.querySelector(sub) : el;
          if (!tEl) continue;
          const text = (tEl.innerText || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, 1500);
          if (!text) continue;
          const key = hash(text);
          if (seen.has(key)) continue;
          seen.add(key);
          let item = text;
          if (want.length) {
            item = {};
            for (const f of want) {
              if (f === 'text') item.text = text;
              else if (f === 'id') {
                const v = el.id || el.getAttribute('data-id');
                if (v) item.id = v;
              } else if (f === 'href') {
                // textSelector on (or inside) a link: that link's URL, not the row's first anchor (an upvote link).
                const own = sub ? tEl.closest('a[href]') : null;
                const v = (own || (el.matches('a[href]') ? el : el.querySelector('a[href]')))?.href;
                if (v) item.href = v;
              }
            }
            if (!Object.keys(item).length) item = text;
          }
          const size = typeof item === 'string' ? item.length : JSON.stringify(item).length;
          if (items.length >= cap || chars + size > charCap) {
            full = true;
            break;
          }
          items.push(item);
          chars += size;
          added++;
        }
        return added;
      };
      const scroller = () => {
        const first = document.querySelector(sel);
        for (let p = first?.parentElement; p && p !== document.body; p = p.parentElement) {
          const st = getComputedStyle(p);
          if (/(auto|scroll)/.test(st.overflowY) && p.scrollHeight > p.clientHeight + 4) return p;
        }
        return null;
      };
      read();
      if (!matched) {
        // Rows rendered a beat after domcontentloaded: poll briefly before declaring the page empty.
        for (let k = 0; k < 6 && !matched; k++) {
          await new Promise((res) => setTimeout(res, 150));
          read();
        }
      }
      let done = 0;
      let idle = 0;
      for (let i = 0; i < nScrolls && !full; i++) {
        const box = scroller();
        const before = box ? box.scrollTop : window.scrollY;
        const step = Math.max(200, Math.floor((box ? box.clientHeight : window.innerHeight) * 0.9));
        if (box) box.scrollTop = before + step;
        else window.scrollBy(0, step);
        done++;
        // Wait for two frames (scroll handlers render on the next frame), then waitMs.
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        await new Promise((res) => setTimeout(res, wait));
        const moved = (box ? box.scrollTop : window.scrollY) !== before;
        let added = read();
        // Slow renderers (busy page, slow device) may not have swapped items in yet: give them one more wait
        // before scrolling again, otherwise the next scroll skips the items that were about to appear.
        if (moved && added === 0) {
          await new Promise((res) => setTimeout(res, Math.max(wait, 150)));
          added = read();
        }
        idle = added === 0 && !moved ? idle + 1 : added === 0 ? idle : 0;
        if (idle >= 1) break;
      }
      return { items, scrolls: done, truncated: full, matched };
    },
    { sel: selector, sub, scrolls, waitMs, maxItems, maxChars, fields }
  );
  const res = { ok: true, action: 'collect', count: r.items.length, scrolls: r.scrolls, truncated: r.truncated, items: r.items, elapsedMs: Date.now() - t0 };
  if (!r.items.length) res.note = r.matched ? `${r.matched} elements matched but none had text` : 'selector matched 0 elements';
  return res;
}

const APPLY_HOST_PATH_RE =/apply|careers|jobs|greenhouse|lever|ashby|workable|freshteam|zohorecruit|smartrecruiters|recruitee|breezy/i;
const STATIC_EXT_RE = /\.(?:js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map|json|xml)(?:[?#]|$)/i;

/**
 * Up to 3 absolute URLs on a different host that look like an application/ATS page, from anchors and inline
 * JSON/HTML. Used only when an "apply" click did nothing visible (button opens a modal, link lives in page data).
 */
export async function findOutboundApplyLinks(page) {
  let raw = [];
  try {
    raw = await page.evaluate(() => {
      const out = [];
      for (const a of document.querySelectorAll('a[href]')) out.push(a.href);
      const BS = String.fromCharCode(92);
      const html = document.documentElement.innerHTML.split(BS + 'u002F').join('/').split(BS + '/').join('/');
      const m = html.match(/https?:\/\/[^\s"'<>\\\)]+/g);
      if (m) for (const u of m.slice(0, 4000)) out.push(u);
      return out;
    });
  } catch {
    return [];
  }
  let here = '';
  try { here = new URL(page.url()).host; } catch { return []; }
  const seen = new Set();
  const found = [];
  for (const u of raw) {
    let url;
    try { url = new URL(u.replace(/[.,;]+$/, '')); } catch { continue; }
    if (!/^https?:$/.test(url.protocol) || url.host === here || STATIC_EXT_RE.test(url.pathname)) continue;
    if (!APPLY_HOST_PATH_RE.test(url.host) && !APPLY_HOST_PATH_RE.test(url.pathname)) continue;
    const key = url.origin + url.pathname;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(url.href);
    if (found.length >= 3) break;
  }
  return found;
}

async function executeSingleAction(page, params = {}) {
  const silentState = { count: 0, wantKind: false, clickKind: '' };
  const enabled = params.observeAftermath ?? (process.env.TURBO_BROWSER_OBSERVE_AFTERMATH === 'true');
  const observer = enabled && ['click', 'dblclick'].includes(params.action) ? observeClickAftermath(page) : null;
  const navigation = params.returnSnapshot && ['click', 'dblclick', 'press'].includes(params.action)
    ? watchActionNavigation(page, Number(params.timeoutMs) || DEFAULT_TIMEOUT_MS) : null;
  // A committing click/key gets the same settle step so a toast ("This domain isn't allowed.") can show up.
  const wantToast = ['click', 'dblclick', 'press'].includes(params.action);
  const toastWindow = wantToast && resolveAllowSubmit(params.allowSubmit);
  // One shared settle step replaces fixed sleeps; listeners stay attached until it is done.
  const activity = observer || navigation || toastWindow ? watchActivity(page) : null;
  if (wantToast) await armToasts(page);
  const beforeApplyUrl = page.url();
  let openedTab = false;
  const onNewPage = () => { openedTab = true; };
  const ctxForTabs = ['click'].includes(params.action) ? page.context() : null;
  ctxForTabs?.on('page', onNewPage);
  let res;
  silentState.wantKind = Boolean(observer);
  try {
    try {
      res = await executeSingleActionInner(page, params, silentState);
    } catch (err) {
      throw conciseActionError(err);
    }
    observer?.setKind(silentState.clickKind);
    if (!res.blocked) {
      await navigation?.finish();
      // The guard keeps watching at least 400 ms so a late commit-like request is still reported.
      await activity?.settle({ minMs: observer ? 400 : 0 });
      if ((observer || navigation) && res && typeof res === 'object') res.outcome = activity.outcome();
      if (wantToast && res && typeof res === 'object') {
        const toast = await takeToast(page);
        if (toast) res.toast = toast;
      }
    }
    await observer?.finish(res, resolveAllowSubmit(params.allowSubmit));
    if (res && res._applyLike) {
      if (!observer && !navigation) await new Promise((r) => setTimeout(r, 600));
      if (!openedTab && page.url() === beforeApplyUrl) {
        const links = await findOutboundApplyLinks(page);
        if (links.length) res.outboundLinks = links;
      }
    }
  } finally {
    ctxForTabs?.off('page', onNewPage);
    if (res && res._applyLike !== undefined) delete res._applyLike;
    observer?.remove();
    navigation?.remove();
    activity?.remove();
  }
  if (silentState.count > 0 && res && typeof res === 'object' && !res.blocked) {
    res.submitSuppressed = silentState.count;
    res.note =
      'The page tried to submit a form during this action (submit event, form.submit() or requestSubmit()); it was stopped because allowSubmit=false. Nothing was sent.';
  }
  return res;
}

async function executeSingleActionInner(page, params = {}, silentState = { count: 0 }) {
  const action = params.action;
  if (!action) throw new Error('act_fast requires action.');
  const timeout = Number(params.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const allowSubmit = resolveAllowSubmit(params.allowSubmit);

  if (action === 'reload' || action === 'back' || action === 'forward') {
    const opts = { waitUntil: 'domcontentloaded', timeout };
    const resp = action === 'reload' ? await page.reload(opts) : action === 'back' ? await page.goBack(opts) : await page.goForward(opts);
    if (!resp && action !== 'reload') throw new Error(`nothing to go ${action} to`);
    return { ok: true, action, url: page.url() };
  }

  if (action === 'scroll') {
    if (params.ref || params.selector || params.text) {
      const target = await resolveTarget(page, params);
      await target.locator.scrollIntoViewIfNeeded({ timeout });
      return { ok: true, action, frameIdx: target.frameIdx };
    }
    const dx = Number(params.dx) || 0;
    const dy = Number(params.dy ?? 500);
    await page.evaluate(([x, y]) => window.scrollBy(x, y), [dx, dy]);
    return { ok: true, action, dx, dy };
  }

  if (action === 'wait') {
    if (params.loadState) {
      await page.waitForLoadState(params.loadState, { timeout });
      return { ok: true, action, loadState: params.loadState };
    }
    if (params.url) {
      const urlPattern = String(params.url);
      const urlRe = compileFilterRegex(urlPattern);
      const isGlob =
        urlPattern.includes('*') && !/\\[dwsbDWSB.?]|\.\*|\.\+|^\^|\$$/.test(urlPattern);
      const globRe = isGlob
        ? new RegExp(
            urlPattern
              .split(/\*+/)
              .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
              .join('.*'),
            'i'
          )
        : null;
      await page.waitForURL(
        (u) => {
          const href = String(u?.href ?? u);
          if (href.toLowerCase().includes(urlPattern.toLowerCase())) return true;
          if (globRe) return globRe.test(href);
          return urlRe.test(href);
        },
        { timeout }
      );
      return { ok: true, action, url: page.url() };
    }
    if (params.textNew) {
      // Only text that appears after this step starts: elements already showing it are remembered and ignored.
      const needleOrig = String(params.textNew).split('|').map((x) => x.trim()).filter(Boolean);
      const needles = needleOrig.map((x) => x.toLowerCase());
      const key = '__tbmTN' + Math.random().toString(36).slice(2);
      const scan = ([ns, k, init]) => {
        const seen = init ? (window[k] = new WeakSet()) : window[k];
        if (!seen) return '';
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
      };
      const frames = getAllFrames(page);
      if (params._freshDocument) {
        // Right after navigate/reload/back/forward in the same batch: everything on the new document is new.
        await Promise.all(frames.map((f) => f.frame.evaluate((k) => { window[k] = new WeakSet(); }, key).catch(() => '')));
      } else {
        await Promise.all(frames.map((f) => f.frame.evaluate(scan, [needles, key, true]).catch(() => '')));
      }
      const deadline = Date.now() + timeout;
      try {
        while (Date.now() <= deadline) {
          for (const f of getAllFrames(page)) {
            const hit = await f.frame.evaluate(scan, [needles, key, false]).catch(() => '');
            if (hit) return { ok: true, action, waitedFor: params.textNew, ...(needles.length > 1 ? { matched: needleOrig[needles.indexOf(hit)] } : {}) };
          }
          await page.waitForTimeout(80);
        }
      } finally {
        for (const f of getAllFrames(page)) f.frame.evaluate((k) => { delete window[k]; }, key).catch(() => {});
      }
      throw new Error(`Timed out after ${timeout}ms waiting for new "${params.textNew}".`);
    }
    if (params.textGone) {
      const deadline = Date.now() + timeout;
      while (Date.now() <= deadline) {
        const frames = getAllFrames(page);
        let waitedOnVisible = false;
        for (const f of frames) {
          const list = f.frame.getByText(params.textGone, { exact: false });
          const cnt = await list.count().catch(() => 0);
          for (let i = 0; i < cnt; i++) {
            const item = list.nth(i);
            if (await item.isVisible().catch(() => false)) {
              const rem = Math.max(1, deadline - Date.now());
              await item.waitFor({ state: 'hidden', timeout: rem });
              waitedOnVisible = true;
              break;
            }
          }
          if (waitedOnVisible) break;
        }
        if (!waitedOnVisible) {
          return { ok: true, action, textGone: params.textGone };
        }
      }
      throw new Error(`Timed out after ${timeout}ms waiting for "${params.textGone}" to disappear.`);
    }
    if (params.ref) {
      const target = await resolveTarget(page, params, {
        allowHidden: ['hidden', 'detached', 'attached'].includes(params.state),
      });
      await target.locator.waitFor({ state: params.state || 'visible', timeout });
      return { ok: true, action, waitedFor: params.ref };
    }
    if (params.selector || params.text) {
      const desiredState = params.state || 'visible';
      const frames = getAllFrames(page);
      const scopedFrames = params.frameIdx !== undefined && params.frameIdx !== null
        ? frames.filter((f) => f.frameIdx === params.frameIdx)
        : frames;
      if (scopedFrames.length === 0) {
        throw new Error(`No matching frames found for wait target (${params.selector || params.text}).`);
      }
      const textAlts = !params.selector && typeof params.text === 'string' && params.text.includes('|')
        ? params.text.split('|').map((x) => x.trim()).filter(Boolean)
        : [];
      const altMode = textAlts.length > 1;
      const altRe = altMode
        ? new RegExp(textAlts.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i')
        : null;
      const makeListLoc = (f) =>
        params.selector
          ? f.frame.locator(params.selector)
          : f.frame.getByText(altMode ? altRe : params.text, { exact: false });

      if (desiredState === 'hidden' || desiredState === 'detached') {
        const deadline = Date.now() + timeout;
        while (Date.now() <= deadline) {
          let waitedAny = false;
          for (const f of scopedFrames) {
            const list = makeListLoc(f);
            const cnt = await list.count().catch(() => 0);
            for (let i = 0; i < cnt; i++) {
              const item = list.nth(i);
              if (desiredState === 'detached') {
                const rem = Math.max(1, deadline - Date.now());
                await item.waitFor({ state: 'detached', timeout: rem });
                waitedAny = true;
                break;
              } else if (await item.isVisible().catch(() => false)) {
                const rem = Math.max(1, deadline - Date.now());
                await item.waitFor({ state: 'hidden', timeout: rem });
                waitedAny = true;
                break;
              }
            }
            if (waitedAny) break;
          }
          if (!waitedAny) {
            return { ok: true, action, waitedFor: params.selector || params.text };
          }
        }
        throw new Error(`Timed out after ${timeout}ms waiting for "${params.selector || params.text}" to become ${desiredState}.`);
      }

      if (desiredState === 'attached') {
        try {
          await Promise.any(scopedFrames.map((f) => makeListLoc(f).first().waitFor({ state: 'attached', timeout })));
        } catch {
          throw new Error(`Timed out after ${timeout}ms waiting for "${params.selector || params.text}" to become ${desiredState}.`);
        }
        return { ok: true, action, waitedFor: params.selector || params.text };
      }

      const deadline = Date.now() + timeout;
      let foundVisible = false;
      let matchedAlt;
      while (Date.now() <= deadline) {
        for (const f of scopedFrames) {
          const list = makeListLoc(f);
          const cnt = await list.count().catch(() => 0);
          for (let i = 0; i < cnt; i++) {
            if (await list.nth(i).isVisible().catch(() => false)) {
              foundVisible = true;
              if (altMode) {
                const hay = ((await list.nth(i).textContent().catch(() => '')) || '').toLowerCase();
                matchedAlt = textAlts.find((x) => hay.includes(x.toLowerCase()));
              }
              break;
            }
          }
          if (foundVisible) break;
        }
        if (!foundVisible && !params.selector && typeof params.text === 'string') {
          // No visible text matched: fall back to a placeholder, aria-label or value (e.g. "Add a comment").
          const needles = (altMode ? textAlts : [params.text]).map((x) => x.toLowerCase());
          for (const f of scopedFrames) {
            const hit = await f.frame
              .evaluate((ns) => {
                for (const el of document.querySelectorAll('[placeholder],[aria-label],input[value],textarea')) {
                  const hay = `${el.getAttribute('placeholder') || ''}
${el.getAttribute('aria-label') || ''}
${el.value || ''}`.toLowerCase();
                  const n = ns.find((x) => hay.includes(x));
                  if (!n) continue;
                  const r = el.getBoundingClientRect();
                  const st = getComputedStyle(el);
                  if (r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none') return n;
                }
                return '';
              }, needles)
              .catch(() => '');
            if (hit) {
              foundVisible = true;
              if (altMode) matchedAlt = textAlts.find((x) => x.toLowerCase() === hit);
              break;
            }
          }
        }
        if (foundVisible) break;
        await page.waitForTimeout(50);
      }
      if (!foundVisible) {
        throw new Error(`Timed out after ${timeout}ms waiting for "${params.selector || params.text}" to become ${desiredState}.`);
      }
      return { ok: true, action, waitedFor: params.selector || params.text, ...(matchedAlt ? { matched: matchedAlt } : {}) };
    }
    const ms = Math.min(Number(params.ms) || 500, 15000);
    await page.waitForTimeout(ms);
    return { ok: true, action, ms };
  }

  let target = null;
  const markSafeElementOwnForm = (el) => {
    if (!el || el.nodeType !== 1) return;
    const win = el.ownerDocument?.defaultView || window;
    const getSR = (node) => node?.shadowRoot || win.__tbmGetShadowRoot?.(node) || null;
    const isShadowRoot = (r) => Boolean(r && r.nodeType === 11 && 'host' in r);
    const closestComposed = (node, sel) => {
      let cur = node;
      while (cur) {
        if (cur.nodeType === 1 && cur.matches?.(sel)) return cur;
        const root = cur.getRootNode?.();
        cur = cur.assignedSlot || cur.parentElement || (isShadowRoot(root) ? root.host : null);
      }
      return null;
    };
    const findShadowDescendant = (rootHost, sel) => {
      const firstSr = getSR(rootHost);
      if (!firstSr) return null;
      const queue = [firstSr];
      const seen = new Set();
      while (queue.length > 0) {
        const sr = queue.shift();
        if (!sr || seen.has(sr)) continue;
        seen.add(sr);
        const match = sr.querySelector?.(sel);
        if (match) return match;
        if (sr.querySelectorAll) {
          for (const child of sr.querySelectorAll('*')) {
            if (getSR(child)) queue.push(getSR(child));
          }
        }
      }
      return null;
    };
    const lbl = closestComposed(el, 'label');
    const base = (lbl && lbl.control) || el;
    const shadowInnerBtn = findShadowDescendant(
      base,
      'button, input[type="submit"], input[type="button"], input[type="image"], [role="button"]'
    );
    const ownForm =
      base.form ||
      shadowInnerBtn?.form ||
      closestComposed(base, 'form') ||
      (shadowInnerBtn ? closestComposed(shadowInnerBtn, 'form') : null) ||
      findShadowDescendant(base, 'form') ||
      null;
    if (ownForm && typeof ownForm === 'object') {
      Object.defineProperty(ownForm, '__tbmAllowedSubmit', {
        value: true,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
  };

  const withActionSubmitGuard = async (fn, frameOverride = null, allowSafe = false, safeTargetInfo = null) => {
    const allFrames = !allowSubmit ? getAllFrames(page).map((f) => f.frame) : [];
    const targetFrames =
      !allowSubmit && frameOverride && !allFrames.includes(frameOverride)
        ? [...allFrames, frameOverride]
        : allFrames;
    // One slow or hung frame (ads, analytics iframes on a busy SPA) must not stall the action:
    // install in parallel and stop waiting after capMs.
    const capped = (promises, capMs) => {
      let timer;
      return Promise.race([
        Promise.all(promises),
        new Promise((resolve) => { timer = setTimeout(resolve, capMs); }),
      ]).finally(() => clearTimeout(timer));
    };
    await capped(targetFrames.map(async (tf) => {
      await tf
        .evaluate(
          ({ isAllowSafe, useActiveEl, submitSrc, safeSrc, dangerSrc }) => {
            const win = window;
            if (win.__tbmCleanupActGuard) win.__tbmCleanupActGuard();
            delete win.__tbmSilentSubmitBlocks;
            const noteBlocked = () => {
              try {
                Object.defineProperty(win, '__tbmSilentSubmitBlocks', {
                  value: (Number(win.__tbmSilentSubmitBlocks) || 0) + 1,
                  writable: true,
                  enumerable: false,
                  configurable: true,
                });
              } catch {}
            };
            Object.defineProperty(win, '__tbmSubmitGuardActive', {
              value: (win.__tbmSubmitGuardActive || 0) + 1,
              writable: true,
              enumerable: false,
              configurable: true,
            });
            Object.defineProperty(win, '__tbmAllowSafeForm', {
              value: Boolean(isAllowSafe),
              writable: true,
              enumerable: false,
              configurable: true,
            });
            const submitRe = new RegExp(submitSrc, 'iu');
            const safeRe = new RegExp(safeSrc, 'iu');
            const dangerRe = new RegExp(dangerSrc, 'iu');
            const getSR = (node) => node?.shadowRoot || win.__tbmGetShadowRoot?.(node) || null;
            const isShadowRoot = (r) => Boolean(r && r.nodeType === 11 && 'host' in r);
            const closestComposed = (node, sel) => {
              let cur = node;
              while (cur) {
                if (cur.nodeType === 1 && cur.matches?.(sel)) return cur;
                const root = cur.getRootNode?.();
                cur = cur.assignedSlot || cur.parentElement || (isShadowRoot(root) ? root.host : null);
              }
              return null;
            };
            const BLOCK_TAGS = new Set([
              'DIV', 'P', 'LI', 'UL', 'OL', 'TR', 'TD', 'TH',
              'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'ASIDE', 'NAV',
              'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'BR',
            ]);
            const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE']);
            const normLbl = (s) => (s || '').replace(/\s+/g, ' ').trim().normalize('NFC');
            const extractAccessibleText = (rootNode, allowHidden = false) => {
              if (!rootNode) return '';
              const walkChildren = (nodes) => {
                let out = '';
                for (const c of nodes || []) {
                  const piece = walk(c);
                  if (!piece) continue;
                  const cTag = c.nodeType === 1 ? (c.tagName || '').toUpperCase() : '';
                  if (BLOCK_TAGS.has(cTag)) {
                    out += (out && !/\s$/.test(out) ? ' ' : '') + piece + ' ';
                  } else {
                    out += piece;
                  }
                }
                return out;
              };
              const walk = (n) => {
                if (!n) return '';
                if (n.nodeType === 3) return n.textContent || '';
                if (n.nodeType !== 1 && n.nodeType !== 11) return '';
                if (n.nodeType === 1) {
                  const t = (n.tagName || '').toUpperCase();
                  if (SKIP_TAGS.has(t)) return '';
                  if (t === 'BR') return ' ';
                  if (!allowHidden && n !== rootNode) {
                    if (n.hasAttribute?.('hidden') || n.getAttribute?.('aria-hidden') === 'true') return '';
                    try {
                      const st = win.getComputedStyle(n);
                      if (st.display === 'none' || st.visibility === 'hidden') return '';
                    } catch {}
                  }
                  if (t === 'SLOT' && typeof n.assignedNodes === 'function') {
                    const assigned = n.assignedNodes({ flatten: true });
                    const list = assigned.length > 0 ? assigned : (n.childNodes || []);
                    return walkChildren(list);
                  }
                  if (getSR(n)) {
                    const srOut = walkChildren(getSR(n).childNodes);
                    if (normLbl(srOut)) return srOut;
                  }
                }
                return walkChildren(n.childNodes);
              };
              return walk(rootNode);
            };
            const resolveAriaLabelledBy = (node) => {
              const lby = node?.getAttribute?.('aria-labelledby');
              if (!lby) return '';
              const rn = node.getRootNode?.();
              return lby
                .split(/\s+/)
                .map((id) => {
                  const refEl = (rn?.getElementById && rn.getElementById(id)) || win.document.getElementById(id);
                  return extractAccessibleText(refEl, true) || refEl?.textContent || '';
                })
                .join(' ');
            };
            const isSafeSubmitter = (subEl) => {
              if (!subEl || subEl.nodeType !== 1) return false;
              const nTag = (subEl.tagName || '').toLowerCase();
              const nType = (subEl.type || subEl.getAttribute?.('type') || '').toLowerCase();
              const nRoot = subEl.getRootNode?.();
              const nHost = isShadowRoot(nRoot) ? nRoot.host : null;
              const cands = [
                resolveAriaLabelledBy(subEl),
                subEl.getAttribute?.('aria-label'),
                nHost ? resolveAriaLabelledBy(nHost) : '',
                nHost ? nHost.getAttribute?.('aria-label') : '',
                extractAccessibleText(subEl),
                extractAccessibleText(getSR(subEl)),
                nHost ? extractAccessibleText(nHost) : '',
                nTag === 'input' && nType !== 'checkbox' && nType !== 'radio' ? subEl.value : '',
                subEl.getAttribute?.('alt'),
                subEl.querySelector?.('[alt]')?.getAttribute?.('alt'),
                subEl.querySelector?.('[aria-label]')?.getAttribute?.('aria-label'),
                subEl.querySelector?.('svg title')?.textContent,
                subEl.getAttribute?.('title'),
                nHost ? nHost.getAttribute?.('title') : '',
                subEl.labels && subEl.labels.length > 0 ? [...subEl.labels].map((l) => extractAccessibleText(l)).join(' ') : '',
                extractAccessibleText(closestComposed(subEl, 'label')),
              ];
              let raw = '';
              for (const c of cands) {
                const n = normLbl(c);
                if (!n) continue;
                if (!raw) raw = n;
                if (/[\p{L}\p{N}]/u.test(n)) {
                  raw = n;
                  break;
                }
              }
              const clean = raw.replace(/^[^\p{L}\p{N}]+/u, '').trim();
              if (!clean) return false;
              return safeRe.test(clean) && !dangerRe.test(clean) && !submitRe.test(clean);
            };
            Object.defineProperty(win, '__tbmIsSafeSubmitter', {
              value: isSafeSubmitter,
              writable: true,
              enumerable: false,
              configurable: true,
            });
            if (typeof win.__tbmInstallFormGuard === 'function') {
              win.__tbmInstallFormGuard(win);
            }
            const origSub = win.HTMLFormElement?.prototype?.submit;
            const origReqSub = win.HTMLFormElement?.prototype?.requestSubmit;
            const hasProxySub = Boolean(origSub?.__tbmProxy);
            const hasProxyReqSub = Boolean(origReqSub?.__tbmProxy);
            const origAttachShadow = win.Element?.prototype?.attachShadow;
            const guardSub = (e) => {
              if (
                win.__tbmAllowSafeForm &&
                e.target &&
                e.target.__tbmAllowedSubmit === true &&
                (!e.submitter || isSafeSubmitter(e.submitter))
              ) {
                return;
              }
              noteBlocked();
              e.preventDefault();
              e.stopImmediatePropagation();
            };
            const guardedRoots = new Set();
            const attachToRoot = (root) => {
              if (!root || guardedRoots.has(root)) return;
              guardedRoots.add(root);
              root.addEventListener?.('submit', guardSub, true);
              if (root.querySelectorAll) {
                for (const f of root.querySelectorAll('form')) {
                  delete f.__tbmAllowedSubmit;
                }
                for (const el of root.querySelectorAll('*')) {
                  const sr = el.shadowRoot || win.__tbmGetShadowRoot?.(el);
                  if (sr) attachToRoot(sr);
                }
              }
            };
            win.addEventListener('submit', guardSub, true);
            attachToRoot(document);
            for (const sr of win.__tbmGetAllShadowRoots?.() || []) {
              attachToRoot(sr);
            }
            if (isAllowSafe && useActiveEl) {
              const findShadowDescendant = (rootHost, sel) => {
                const firstSr = getSR(rootHost);
                if (!firstSr) return null;
                const queue = [firstSr];
                const seen = new Set();
                while (queue.length > 0) {
                  const sr = queue.shift();
                  if (!sr || seen.has(sr)) continue;
                  seen.add(sr);
                  const match = sr.querySelector?.(sel);
                  if (match) return match;
                  if (sr.querySelectorAll) {
                    for (const child of sr.querySelectorAll('*')) {
                      if (getSR(child)) queue.push(getSR(child));
                    }
                  }
                }
                return null;
              };
              let active = document.activeElement;
              while (active && getSR(active) && getSR(active).activeElement) {
                active = getSR(active).activeElement;
              }
              if (active && active.nodeType === 1) {
                const lbl = closestComposed(active, 'label');
                const base = (lbl && lbl.control) || active;
                const shadowInnerBtn = findShadowDescendant(
                  base,
                  'button, input[type="submit"], input[type="button"], input[type="image"], [role="button"]'
                );
                const ownForm =
                  base.form ||
                  shadowInnerBtn?.form ||
                  closestComposed(base, 'form') ||
                  (shadowInnerBtn ? closestComposed(shadowInnerBtn, 'form') : null) ||
                  findShadowDescendant(base, 'form') ||
                  null;
                if (ownForm && typeof ownForm === 'object') {
                  Object.defineProperty(ownForm, '__tbmAllowedSubmit', {
                    value: true,
                    writable: true,
                    enumerable: false,
                    configurable: true,
                  });
                }
              }
            }
            if (win.HTMLFormElement?.prototype) {
              if (!hasProxySub) {
                win.HTMLFormElement.prototype.submit = function () {
                  if (win.__tbmAllowSafeForm && this && this.__tbmAllowedSubmit === true && origSub) {
                    return origSub.apply(this, arguments);
                  }
                  noteBlocked();
                };
              }
              if (typeof origReqSub === 'function' && !hasProxyReqSub) {
                win.HTMLFormElement.prototype.requestSubmit = function () {
                  if (win.__tbmAllowSafeForm && this && this.__tbmAllowedSubmit === true) {
                    if (arguments.length > 0 && arguments[0] !== undefined && arguments[0] !== null) {
                      if (!isSafeSubmitter(arguments[0])) {
                        noteBlocked();
                        return;
                      }
                    }
                    return origReqSub.apply(this, arguments);
                  }
                  noteBlocked();
                };
              }
            }
            if (win.Element?.prototype && typeof origAttachShadow === 'function') {
              win.Element.prototype.attachShadow = function (init) {
                const sr = origAttachShadow.call(this, init);
                attachToRoot(sr);
                return sr;
              };
            }
            Object.defineProperty(win, '__tbmCleanupActGuard', {
              value: () => {
                Object.defineProperty(win, '__tbmSubmitGuardActive', {
                  value: Math.max(0, (win.__tbmSubmitGuardActive || 1) - 1),
                  writable: true,
                  enumerable: false,
                  configurable: true,
                });
                Object.defineProperty(win, '__tbmAllowSafeForm', {
                  value: false,
                  writable: true,
                  enumerable: false,
                  configurable: true,
                });
                delete win.__tbmIsSafeSubmitter;
                win.removeEventListener('submit', guardSub, true);
                for (const r of guardedRoots) {
                  r.removeEventListener?.('submit', guardSub, true);
                  if (r.querySelectorAll) {
                    for (const f of r.querySelectorAll('form')) {
                      delete f.__tbmAllowedSubmit;
                    }
                  }
                }
                guardedRoots.clear();
                if (win.HTMLFormElement?.prototype) {
                  if (origSub && !hasProxySub) win.HTMLFormElement.prototype.submit = origSub;
                  if (origReqSub && !hasProxyReqSub) win.HTMLFormElement.prototype.requestSubmit = origReqSub;
                }
                if (win.Element?.prototype && origAttachShadow) {
                  win.Element.prototype.attachShadow = origAttachShadow;
                }
                delete win.__tbmCleanupActGuard;
              },
              writable: true,
              enumerable: false,
              configurable: true,
            });
          },
          {
            isAllowSafe: Boolean(allowSafe),
            useActiveEl: Boolean(safeTargetInfo?.useActiveElement),
            submitSrc: SUBMIT_LABEL_RE.source,
            safeSrc: SAFE_SUBMIT_TYPE_RE.source,
            dangerSrc: COMPOUND_DANGER_RE.source,
          }
        )
        .catch(() => {});
    }), 3000);
    if (!allowSubmit && allowSafe && safeTargetInfo) {
      if (safeTargetInfo.locator) {
        await safeTargetInfo.locator.evaluate(markSafeElementOwnForm).catch(() => {});
      }
      if (safeTargetInfo.coords) {
        const h = await getDeepElementHandleAtPoint(page, safeTargetInfo.coords.x, safeTargetInfo.coords.y, true);
        try {
          await h.evaluate(markSafeElementOwnForm).catch(() => {});
        } finally {
          await h.dispose().catch(() => {});
        }
      }
    }
    try {
      return await fn();
    } finally {
      let silentBlocks = 0;
      const counts = [];
      await capped(targetFrames.map(async (tf) => {
        const n = await tf
          .evaluate(async () => {
            await Promise.resolve();
            await new Promise((r) => setTimeout(r, 0));
            const count = Number(window.__tbmSilentSubmitBlocks) || 0;
            delete window.__tbmSilentSubmitBlocks;
            if (window.__tbmCleanupActGuard) window.__tbmCleanupActGuard();
            return count;
          })
          .catch(() => 0);
        counts.push(Number(n) || 0);
      }), 2000);
      for (const n of counts) silentBlocks += n;
      silentState.count += silentBlocks;
    }
  };

  if (action === 'press') {
    if (!params.key) throw new Error('press action requires key.');
    const rawKey = String(params.key);
    const keyParts = rawKey.split('+');
    const isEnterPart = (p) => {
      const t = p.trim();
      return /^(numpad)?enter$/i.test(t) || /^return$/i.test(t) || p === '\n' || p === '\r' || p === '\r\n';
    };
    const isSpacePart = (p) => {
      const t = p.trim();
      return /^(space|spacebar)$/i.test(t) || p === ' ';
    };
    const isEnter =
      keyParts.some(isEnterPart) ||
      rawKey === '\n' ||
      rawKey === '\r' ||
      rawKey === '\r\n';
    const isSpace =
      keyParts.some(isSpacePart) ||
      rawKey === ' ';
    const hasCtrlOrMeta = keyParts.some((p) => /^(control|ctrl|meta|command|cmd|controlormeta)$/i.test(p.trim()));
    if (params.ref || params.selector || params.text) {
      target = await resolveTarget(page, params);
      let isSafeTargetPress = false;
      let isSafeActivePress = false;
      if ((isEnter || isSpace) && !allowSubmit) {
        const meta = isEnter
          ? await isEnterSubmitTarget(page, target.locator, { hasCtrlOrMeta })
          : await isSubmitLikeElement(target.locator);
        if (meta.isSubmit) {
          return {
            ok: false,
            blocked: true,
            action,
            label: meta.label,
            reason: `Submit guard: allowSubmit=false blocks pressing ${params.key} (${meta.reason}).`,
          };
        }
        isSafeTargetPress = Boolean(meta.isSafeSubmit);
        const isNonFocusable = await target.locator
          .evaluate((el) => {
            if (!el) return true;
            const isDisabledByFieldset = (node) => {
              let cur = node;
              while (cur && cur.nodeType === 1) {
                const parent = cur.parentElement;
                if (parent && parent.tagName === 'FIELDSET' && parent.disabled) {
                  const firstLegend = [...parent.children].find((c) => c.tagName === 'LEGEND');
                  if (!firstLegend || cur !== firstLegend) return true;
                }
                const rn = cur.getRootNode?.();
                cur = parent || (rn instanceof ShadowRoot ? rn.host : null);
              }
              return false;
            };
            if (
              el.disabled ||
              Boolean(el.matches?.(':disabled')) ||
              isDisabledByFieldset(el) ||
              el.getAttribute?.('aria-disabled') === 'true'
            ) {
              return true;
            }
            if (
              typeof el.checkVisibility === 'function' &&
              el.checkVisibility({ visibilityProperty: true, opacityProperty: false }) === false
            ) {
              return true;
            }
            let cur = el;
            while (cur && cur.nodeType === 1) {
              if (cur.hasAttribute('hidden') || cur.hasAttribute('inert') || Boolean(cur.inert)) {
                return true;
              }
              const parent = cur.parentElement;
              if (parent && parent.tagName === 'DETAILS' && !parent.open) {
                const firstSummary = [...parent.children].find((c) => c.tagName === 'SUMMARY');
                if (!firstSummary || cur !== firstSummary) {
                  return true;
                }
              }
              try {
                const st = getComputedStyle(cur);
                if (
                  st.display === 'none' ||
                  st.visibility === 'hidden' ||
                  st.visibility === 'collapse' ||
                  st.contentVisibility === 'hidden'
                ) {
                  return true;
                }
              } catch {
                // ignore
              }
              const rn = cur.getRootNode?.();
              cur = parent || (rn instanceof ShadowRoot ? rn.host : null);
            }
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return true;
            if (el.isContentEditable) return false;
            const isElementFocusableAndVisible = (node) => {
              if (!node || node.nodeType !== 1) return false;
              if (
                node.disabled ||
                Boolean(node.matches?.(':disabled')) ||
                isDisabledByFieldset(node) ||
                node.getAttribute?.('aria-disabled') === 'true'
              ) {
                return false;
              }
              if (
                typeof node.checkVisibility === 'function' &&
                node.checkVisibility({ visibilityProperty: true, opacityProperty: false }) === false
              ) {
                return false;
              }
              let c = node;
              while (c && c.nodeType === 1) {
                if (c.hasAttribute('hidden') || c.hasAttribute('inert') || Boolean(c.inert)) return false;
                const p = c.parentElement;
                if (p && p.tagName === 'DETAILS' && !p.open) {
                  const firstSummary = [...p.children].find((ch) => ch.tagName === 'SUMMARY');
                  if (!firstSummary || c !== firstSummary) return false;
                }
                try {
                  const st = getComputedStyle(c);
                  if (
                    st.display === 'none' ||
                    st.visibility === 'hidden' ||
                    st.visibility === 'collapse' ||
                    st.contentVisibility === 'hidden'
                  ) {
                    return false;
                  }
                } catch {}
                const rn = c.getRootNode?.();
                c = p || (rn instanceof ShadowRoot ? rn.host : null);
              }
              const nr = node.getBoundingClientRect();
              return nr.width > 0 && nr.height > 0;
            };
            const getSR = (node) => node?.shadowRoot || window.__tbmGetShadowRoot?.(node) || null;
            const resolveDelegatedFocus = (host) => {
              let curHost = host;
              const seen = new Set();
              while (getSR(curHost)?.delegatesFocus && !seen.has(curHost)) {
                seen.add(curHost);
                const candidates = getSR(curHost).querySelectorAll('*');
                let next = null;
                for (const cand of candidates) {
                  if (!isElementFocusableAndVisible(cand)) continue;
                  if (getSR(cand)?.delegatesFocus) {
                    const inner = resolveDelegatedFocus(cand);
                    if (inner) {
                      next = inner;
                      break;
                    }
                    continue;
                  }
                  const rawCandTab = cand.getAttribute('tabindex');
                  const hasCandTab = rawCandTab !== null && /^\s*[+-]?\d+\s*$/.test(rawCandTab) && Number(rawCandTab) >= 0;
                  if (
                    cand.isContentEditable ||
                    hasCandTab ||
                    (cand.matches?.('input:not([type="hidden"]), select, textarea, button, a[href], area[href], summary') && cand.tabIndex >= 0)
                  ) {
                    next = cand;
                    break;
                  }
                }
                if (!next) return null;
                curHost = next;
              }
              return curHost !== host ? curHost : null;
            };
            if (getSR(el)?.delegatesFocus) {
              if (resolveDelegatedFocus(el)) return false;
              const rawHostTab = el.getAttribute('tabindex');
              const hasHostTab = rawHostTab !== null && /^\s*[+-]?\d+\s*$/.test(rawHostTab) && Number(rawHostTab) >= 0;
              return !hasHostTab;
            }
            const rawTab = el.getAttribute('tabindex');
            const hasValidTab = rawTab !== null && /^\s*[+-]?\d+\s*$/.test(rawTab);
            if (el.matches?.('input, select, textarea, button, a[href], area[href], summary, iframe')) {
              return el.tabIndex < 0 && !hasValidTab;
            }
            if (hasValidTab) return false;
            return el.tabIndex < 0;
          })
          .catch(() => true);
        if (isNonFocusable) {
          const activeMeta = await isEnterSubmitTarget(page, null, { hasCtrlOrMeta });
          if (activeMeta.isSubmit && (isEnter || activeMeta.reason !== 'implicit-form-enter')) {
            return {
              ok: false,
              blocked: true,
              action,
              label: activeMeta.label,
              reason: `Submit guard: allowSubmit=false blocks pressing ${params.key} (${activeMeta.reason}).`,
            };
          }
          if (activeMeta.isSafeSubmit) isSafeActivePress = true;
        }
      }
      const isSafePress = isSafeTargetPress || isSafeActivePress;
      await withActionSubmitGuard(
        () => target.locator.press(params.key, { timeout }),
        target.frame,
        isSafePress,
        {
          locator: isSafeTargetPress ? target.locator : null,
          useActiveElement: isSafeActivePress,
        },
      );
      return { ok: true, action, key: params.key };
    }
    let isSafePress = false;
    if ((isEnter || isSpace) && !allowSubmit) {
      const meta = await isEnterSubmitTarget(page, null, { hasCtrlOrMeta });
      if (meta.isSubmit && (isEnter || meta.reason !== 'implicit-form-enter')) {
        return {
          ok: false,
          blocked: true,
          action,
          label: meta.label,
          reason: `Submit guard: allowSubmit=false blocks pressing ${params.key} (${meta.reason}).`,
        };
      }
      isSafePress = Boolean(meta.isSafeSubmit);
    }
    await withActionSubmitGuard(
      () => page.keyboard.press(params.key),
      null,
      isSafePress,
      { useActiveElement: isSafePress },
    );
    return { ok: true, action, key: params.key };
  }

  const hasTarget = Boolean(params.ref || params.selector || params.text);
  const hasCoords =
    params.x !== undefined &&
    params.x !== null &&
    params.x !== '' &&
    params.y !== undefined &&
    params.y !== null &&
    params.y !== '' &&
    Number.isFinite(Number(params.x)) &&
    Number.isFinite(Number(params.y));
  const button = ['left', 'right', 'middle'].includes(params.button) ? params.button : 'left';
  const modifiers = normalizeModifiers(params.modifiers);

  if (!hasTarget && hasCoords && (action === 'click' || action === 'dblclick' || action === 'hover' || action === 'drop')) {
    const px = Number(params.x);
    const py = Number(params.y);
    if (action === 'click' || action === 'dblclick') {
      let isSafeClick = false;
      if (!allowSubmit) {
        const meta = await isSubmitAtPoint(page, px, py);
        if (meta.isSubmit) {
          return {
            ok: false,
            blocked: true,
            action,
            x: px,
            y: py,
            label: meta.label,
            reason: `Submit guard: blocked ${action} at (${px}, ${py}) on "${meta.label}" (${meta.reason}) because allowSubmit=false.`,
          };
        }
        isSafeClick = Boolean(meta.isSafeSubmit);
      }
      await withActionSubmitGuard(
        () =>
          withModifiers(page, modifiers, async () => {
            await page.mouse.click(px, py, { button, clickCount: action === 'dblclick' ? 2 : 1 });
          }),
        null,
        isSafeClick,
        isSafeClick ? { coords: { x: px, y: py } } : null,
      );
      return { ok: true, action, x: px, y: py, button, modifiers };
    }
    if (action === 'hover') {
      await withActionSubmitGuard(() =>
        withModifiers(page, modifiers, async () => {
          await page.mouse.move(px, py);
        })
      );
      return { ok: true, action, x: px, y: py, modifiers };
    }
    if (action === 'drop') {
      const handle = await getDeepElementHandleAtPoint(page, px, py, false);
      try {
        const empty = await handle.evaluate((el) => !el).catch(() => true);
        if (empty) throw new Error(`No element found at drop coordinates (${px}, ${py}).`);
        const ownerFrame = (await handle.ownerFrame?.().catch(() => null)) || page.mainFrame();
        const info = await withActionSubmitGuard(() => performDropAction(handle, params), ownerFrame);
        return { ok: true, action, x: px, y: py, ...info };
      } finally {
        await handle.dispose().catch(() => {});
      }
    }
  }

  target = await resolveTarget(page, params, {
    allowHidden: action === 'upload',
  });
  const { locator, frameIdx } = target;

  if (action === 'drag') {
    const dest = await resolveTarget(page, {
      ref: params.targetRef,
      selector: params.targetSelector,
      text: params.targetText,
      frameIdx: params.targetFrameIdx,
    });
    if (!allowSubmit) {
      for (const [which, loc] of [['source', locator], ['target', dest.locator]]) {
        const meta = await isSubmitLikeElement(loc);
        if (meta.isSubmit) {
          return {
            ok: false,
            blocked: true,
            action,
            frameIdx,
            label: meta.label,
            reason: `Submit guard: blocked drag (${which}) on "${meta.label}" (${meta.reason}) because allowSubmit=false.`,
          };
        }
        await loc.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
        const box = await loc.boundingBox().catch(() => null);
        if (box && box.width > 0 && box.height > 0) {
          const ptMeta = await isSubmitAtPoint(page, box.x + box.width / 2, box.y + box.height / 2);
          if (ptMeta.isSubmit) {
            return {
              ok: false,
              blocked: true,
              action,
              frameIdx,
              label: ptMeta.label,
              reason: `Submit guard: blocked drag (${which}) on "${ptMeta.label}" (${ptMeta.reason}) because allowSubmit=false.`,
            };
          }
        }
      }
    }
    await withActionSubmitGuard(() => locator.dragTo(dest.locator, { timeout }));
    return { ok: true, action, frameIdx, targetFrameIdx: dest.frameIdx };
  }

  if (action === 'drop') {
    const info = await withActionSubmitGuard(() => performDropAction(locator, params));
    return { ok: true, action, frameIdx, ...info };
  }

  if (action === 'click' || action === 'dblclick') {
    const disabledLabel = await disabledTargetLabel(locator);
    if (disabledLabel) throw new Error(`target is disabled (${disabledLabel})`);
    if (silentState.wantKind) {
      silentState.clickKind = await locator.evaluate((el) => {
        let cur = el;
        let form = el.form || null;
        while (cur) {
          if (cur.nodeType === 1 && cur.matches?.('a[href]')) return 'link';
          if (cur.nodeType === 1 && !form && cur.tagName === 'FORM') form = cur;
          const rn = cur.getRootNode?.();
          cur = cur.parentElement || (rn instanceof ShadowRoot ? rn.host : null);
        }
        if (!form) return 'other';
        const get = (form.getAttribute('method') || 'get').toLowerCase() === 'get';
        const searchy = form.getAttribute('role') === 'search' || Boolean(form.querySelector('input[type="search"], input[name="q"], input[name="query"], input[name="search"], input[name="s"], input[name="keyword"]'));
        return get && searchy ? 'search' : 'form';
      }).catch(() => '');
    }
    let isSafeLocatorClick = false;
    let isSafePointClick = false;
    let safePointCoords = null;
    if (!allowSubmit) {
      const meta = await isSubmitLikeElement(locator);
      if (meta.isSubmit) {
        return {
          ok: false,
          blocked: true,
          action,
          frameIdx,
          label: meta.label,
          reason: `Submit guard: blocked ${action} on "${meta.label}" (${meta.reason}) because allowSubmit=false.`,
        };
      }
      isSafeLocatorClick = Boolean(meta.isSafeSubmit);
      await locator.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
      const box = await locator.boundingBox().catch(() => null);
      if (box && box.width > 0 && box.height > 0) {
        const vpX = box.x + (hasCoords ? Number(params.x) : box.width / 2);
        const vpY = box.y + (hasCoords ? Number(params.y) : box.height / 2);
        const ptMeta = await isSubmitAtPoint(page, vpX, vpY);
        if (ptMeta.isSubmit) {
          return {
            ok: false,
            blocked: true,
            action,
            frameIdx,
            ...(hasCoords ? { x: Number(params.x), y: Number(params.y) } : {}),
            label: ptMeta.label,
            reason: `Submit guard: blocked ${action} on "${ptMeta.label}" (${ptMeta.reason}) because allowSubmit=false.`,
          };
        }
        if (ptMeta.isSafeSubmit) {
          isSafePointClick = true;
          safePointCoords = { x: vpX, y: vpY };
        }
      }
    }
    const isSafeClick = isSafeLocatorClick || isSafePointClick;
    let applyLike = /apply/i.test(String(params.text || ''));
    if (!applyLike && action === 'click' && !params.text) {
      applyLike = await locator
        .evaluate((el) => /apply/i.test((el.innerText || el.getAttribute('aria-label') || el.value || '').slice(0, 60)))
        .catch(() => false);
    }
    const clickOpts = {
      timeout,
      button,
      ...(modifiers.length ? { modifiers } : {}),
      ...(hasCoords ? { position: { x: Number(params.x), y: Number(params.y) } } : {}),
    };
    await withActionSubmitGuard(
      async () => {
        if (action === 'dblclick') await locator.dblclick(clickOpts);
        else await locator.click(clickOpts);
      },
      target.frame,
      isSafeClick,
      isSafeClick
        ? {
            locator: isSafeLocatorClick ? locator : null,
            coords: isSafePointClick ? safePointCoords : null,
          }
        : null,
    );
    return { ok: true, action, frameIdx, button, ...(modifiers.length ? { modifiers } : {}), ...(applyLike ? { _applyLike: true } : {}) };
  }

  if (action === 'hover') {
    const hoverOpts = {
      timeout,
      ...(modifiers.length ? { modifiers } : {}),
      ...(hasCoords ? { position: { x: Number(params.x), y: Number(params.y) } } : {}),
    };
    await withActionSubmitGuard(() => locator.hover(hoverOpts), target.frame);
    return { ok: true, action, frameIdx, ...(modifiers.length ? { modifiers } : {}) };
  }

  if (action === 'focus') {
    await withActionSubmitGuard(() => locator.focus({ timeout }), target.frame);
    return { ok: true, action, frameIdx };
  }

  if (action === 'clear') {
    await withActionSubmitGuard(() => locator.fill('', { timeout }));
    return { ok: true, action, frameIdx };
  }

  if (action === 'fill') {
    const val = String(params.value ?? '');
    await withActionSubmitGuard(() => locator.fill(val, { timeout }));
    const out = { ok: true, action, frameIdx, length: val.length };
    // Masks, maxlength and number inputs can change what was typed; say so instead of letting the model assume.
    const back = await readBack(locator);
    if (back && back.v !== val) out.mismatch = mismatchText(back);
    else if (back?.sh && await locator.evaluate(commitStaleProbe).catch(() => false) && await retypeField(page, locator, val)) {
      out.retyped = true;
    }
    return out;
  }

  if (action === 'type') {
    const val = String(params.value ?? '');
    if (!allowSubmit) {
      const selfMeta = await isSubmitLikeElement(locator);
      if (selfMeta.isSubmit) {
        return {
          ok: false,
          blocked: true,
          action,
          frameIdx,
          label: selfMeta.label,
          reason: `Submit guard: blocked type on "${selfMeta.label}" (${selfMeta.reason}) because allowSubmit=false.`,
        };
      }
      if (params.submit || /[\r\n]/.test(val)) {
        if (params.submit) {
          return {
            ok: false,
            blocked: true,
            action,
            frameIdx,
            reason: 'Submit guard: blocked type with submit=true because allowSubmit=false.',
          };
        }
        const isMultiline = await locator
          .evaluate((el) => el.tagName === 'TEXTAREA' || Boolean(el.isContentEditable))
          .catch(() => false);
        if (!isMultiline) {
          let meta = await isEnterSubmitTarget(page, locator);
          if (!meta.isSubmit) {
            const innerInput = locator
              .locator('input:not([type="hidden"]):not([type="button"]):not([type="reset"]):not([type="file"])')
              .first();
            if ((await innerInput.count().catch(() => 0)) > 0) {
              meta = await isEnterSubmitTarget(page, innerInput);
            }
          }
          if (!meta.isSubmit) {
            let ctrlHandle = null;
            try {
              ctrlHandle = await locator.evaluateHandle((el) => {
                const lbl = el.tagName === 'LABEL' ? el : el.closest?.('label');
                return lbl?.control || null;
              });
              const hasCtrl = await ctrlHandle.evaluate((c) => Boolean(c)).catch(() => false);
              if (hasCtrl) {
                meta = await ctrlHandle.evaluate(checkEnterSubmitInBrowser, {
                  submit: SUBMIT_LABEL_RE.source,
                  safe: SAFE_SUBMIT_TYPE_RE.source,
                  danger: COMPOUND_DANGER_RE.source,
                });
              }
            } catch {
              // Ignore non-label or detached elements.
            } finally {
              await ctrlHandle?.dispose().catch(() => {});
            }
          }
          if (meta.isSubmit) {
            return {
              ok: false,
              blocked: true,
              action,
              frameIdx,
              label: meta.label,
              reason: `Submit guard: blocked type containing newline on "${meta.label}" (${meta.reason}) because allowSubmit=false.`,
            };
          }
        }
      }
    }
    if (params.slowly === false && !params.delayMs) {
      await withActionSubmitGuard(() => locator.fill(val, { timeout }));
    } else {
      if (!allowSubmit) {
        await locator.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
        const box = await locator.boundingBox().catch(() => null);
        if (box && box.width > 0 && box.height > 0) {
          const ptMeta = await isSubmitAtPoint(page, box.x + box.width / 2, box.y + box.height / 2);
          if (ptMeta.isSubmit) {
            return {
              ok: false,
              blocked: true,
              action,
              frameIdx,
              label: ptMeta.label,
              reason: `Submit guard: blocked type on "${ptMeta.label}" (${ptMeta.reason}) because allowSubmit=false.`,
            };
          }
        }
      }
      const delay = params.delayMs !== undefined ? Number(params.delayMs) || 0 : (params.slowly ? 35 : 0);
      await withActionSubmitGuard(() => locator.click({ timeout }), target.frame);
      let isSafeTypeEnter = false;
      if (!allowSubmit && /[\r\n]/.test(val)) {
        const isActiveMultiline = await page
          .evaluate(() => {
            const getSR = (node) => node?.shadowRoot || window.__tbmGetShadowRoot?.(node) || null;
            let active = document.activeElement;
            while (active && getSR(active) && getSR(active).activeElement) {
              active = getSR(active).activeElement;
            }
            return Boolean(active && (active.tagName === 'TEXTAREA' || active.isContentEditable));
          })
          .catch(() => false);
        if (!isActiveMultiline) {
          const activeMeta = await isEnterSubmitTarget(page, null);
          if (activeMeta.isSubmit) {
            return {
              ok: false,
              blocked: true,
              action,
              frameIdx,
              label: activeMeta.label,
              reason: `Submit guard: blocked type containing newline on "${activeMeta.label}" (${activeMeta.reason}) because allowSubmit=false.`,
            };
          }
          isSafeTypeEnter = Boolean(activeMeta.isSafeSubmit);
        }
      }
      await withActionSubmitGuard(
        () => page.keyboard.type(val, { delay }),
        target.frame,
        isSafeTypeEnter,
        isSafeTypeEnter ? { useActiveElement: true } : null,
      );
    }
    const typedOut = { ok: true, action, frameIdx, length: val.length, submitted: Boolean(params.submit) };
    // Typing appends, so only the tail has to match; maxlength, masks and number inputs cut it short.
    const typedBack = val ? await readBack(locator) : null;
    if (typedBack && !typedBack.v.endsWith(val.replace(/\r\n/g, '\n'))) typedOut.mismatch = mismatchText(typedBack);
    if (params.submit) {
      await page.keyboard.press('Enter');
    }
    return typedOut;
  }

  if (action === 'select') {
    const raw = params.values ?? params.value ?? params.label;
    if (raw === undefined) throw new Error('select action requires value, values, or label.');
    let spec;
    if (Array.isArray(raw)) {
      spec = params.label ? raw.map((l) => ({ label: String(l) })) : raw.map((v) => String(v));
    } else {
      spec = params.label ? { label: String(params.label) } : String(raw);
    }
    let chosen;
    try {
      chosen = await withActionSubmitGuard(() => locator.selectOption(spec, { timeout }));
    } catch (err) {
      const options = await locator.evaluate((el) => [...(el.options || [])].map((o) => o.label || o.text || o.value)).catch(() => []);
      if (!options.length) throw err;
      const wanted = [].concat(raw).map(String).join(', ');
      throw new Error(`Option "${wanted}" not found. Closest: ${closestOptions([].concat(raw)[0], options).join(' | ')}.`);
    }
    return { ok: true, action, frameIdx, chosen };
  }

  if (action === 'check' || action === 'uncheck') {
    if (!allowSubmit) {
      const meta = await isSubmitLikeElement(locator);
      if (meta.isSubmit) {
        return {
          ok: false,
          blocked: true,
          action,
          frameIdx,
          label: meta.label,
          reason: `Submit guard: blocked ${action} on "${meta.label}" (${meta.reason}) because allowSubmit=false.`,
        };
      }
      await locator.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
      const box = await locator.boundingBox().catch(() => null);
      if (box && box.width > 0 && box.height > 0) {
        const ptMeta = await isSubmitAtPoint(page, box.x + box.width / 2, box.y + box.height / 2);
        if (ptMeta.isSubmit) {
          return {
            ok: false,
            blocked: true,
            action,
            frameIdx,
            label: ptMeta.label,
            reason: `Submit guard: blocked ${action} on "${ptMeta.label}" (${ptMeta.reason}) because allowSubmit=false.`,
          };
        }
      }
    }
    const wantChecked = action === 'check';
    const roleInfo = await locator.evaluate((el) => ({
      role: (el.getAttribute('role') || '').toLowerCase(),
      ariaChecked: el.getAttribute('aria-checked'),
    })).catch(() => ({ role: '', ariaChecked: null }));

    await withActionSubmitGuard(async () => {
      if (roleInfo.role === 'switch' || roleInfo.role === 'checkbox' || roleInfo.role === 'radio') {
        if ((roleInfo.ariaChecked === 'true') !== wantChecked) {
          await locator.click({ timeout });
        }
      } else if (wantChecked) {
        await locator.check({ timeout });
      } else {
        await locator.uncheck({ timeout });
      }
    });
    return { ok: true, action, frameIdx };
  }

  if (action === 'upload') {
    const raw =
      Array.isArray(params.files) && params.files.length > 0
        ? params.files
        : params.file
          ? [params.file]
          : null;
    if (!raw || raw.length === 0) throw new Error('upload action requires file or files path.');
    const paths = raw.map((p) => path.resolve(String(p)));
    for (const p of paths) {
      if (!fs.existsSync(p)) throw new Error(`File not found on disk: ${p}`);
    }
    const isFileInput = await locator.evaluate((el) => el.tagName === 'INPUT' && el.type === 'file');
    if (isFileInput) {
      await withActionSubmitGuard(() => locator.setInputFiles(paths));
    } else {
      if (!allowSubmit) {
        const meta = await isSubmitLikeElement(locator);
        if (meta.isSubmit) {
          return {
            ok: false,
            blocked: true,
            action,
            frameIdx,
            label: meta.label,
            reason: `Submit guard: blocked upload click on "${meta.label}" (${meta.reason}) because allowSubmit=false.`,
          };
        }
        await locator.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
        const box = await locator.boundingBox().catch(() => null);
        if (box && box.width > 0 && box.height > 0) {
          const ptMeta = await isSubmitAtPoint(page, box.x + box.width / 2, box.y + box.height / 2);
          if (ptMeta.isSubmit) {
            return {
              ok: false,
              blocked: true,
              action,
              frameIdx,
              label: ptMeta.label,
              reason: `Submit guard: blocked upload click on "${ptMeta.label}" (${ptMeta.reason}) because allowSubmit=false.`,
            };
          }
        }
      }
      await withActionSubmitGuard(async () => {
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout }),
          locator.click({ timeout }),
        ]);
        await chooser.setFiles(paths);
      });
    }
    return { ok: true, action, frameIdx, files: paths.map((p) => path.basename(p)) };
  }

  throw new Error(`Unsupported act_fast action: ${action}`);
}

/**
 * Execute one interactive action with human-in-the-loop submit protection and optional 1-turn snapshot.
 */
function resolveLedgerPath(params) {
  if (params.ledgerPath) return resolveSafePath(params.ledgerPath, 'ledgerPath');
  return defaultLedgerPath();
}

function tagBlockedBy(res) {
  if (res && res.blocked && !res.blockedBy) {
    res.blockedBy = /modal-confirm/.test(String(res.reason || '')) ? 'modal' : 'label';
  }
  return res;
}

function applyNetworkBlock(res, blockedRequests) {
  if (!res || blockedRequests.length === 0) return res;
  if (!res.blocked) {
    res.ok = false;
    res.blocked = true;
    res.blockedBy = 'network';
    res.reason = describeNetworkBlock(blockedRequests);
  }
  res.networkBlocked = [...(res.networkBlocked || []), ...blockedRequests];
  return res;
}

/**
 * Validate expect + check the submission ledger before anything is clicked.
 * Returns { key, ledgerPath, refusal } where refusal is a blocked result when the key was already used.
 */
function prepareCommitControls(params, maySubmit) {
  if (params.expect !== undefined && params.expect !== null && !hasAnyCondition(params.expect)) {
    throw new Error('expect requires at least one of urlMatches, textMatches, textNew, selector.');
  }
  const key =
    params.submissionKey !== undefined && params.submissionKey !== null && String(params.submissionKey) !== ''
      ? String(params.submissionKey)
      : '';
  if (!key) return { key: '', ledgerPath: null, refusal: null };
  const ledgerPath = resolveLedgerPath(params);
  if (!maySubmit) return { key, ledgerPath, refusal: null };
  const prev = findLedgerEntry(ledgerPath, key);
  if (prev && !params.allowDuplicate) {
    return {
      key,
      ledgerPath,
      refusal: {
        ok: false,
        blocked: true,
        blockedBy: 'ledger',
        reason: `Duplicate guard: submissionKey "${key}" was already submitted at ${prev.time} (${prev.finalUrl}, submitVerified=${prev.submitVerified}). A re-run would create a second entry; pass allowDuplicate=true only if that is intended.`,
        previousSubmission: prev,
      },
    };
  }
  return { key, ledgerPath, refusal: null };
}

async function finishCommit(page, params, key, ledgerPath, res, textNewKey = '') {
  if (params.expect) {
    Object.assign(res, await waitForSubmitEvidence(page, params.expect, textNewKey));
  }
  if (key) {
    let origin = '';
    try {
      origin = new URL(page.url()).origin;
    } catch {}
    appendLedger(ledgerPath, {
      key,
      time: new Date().toISOString(),
      origin,
      finalUrl: page.url(),
      submitVerified: params.expect ? Boolean(res.submitVerified) : null,
      evidence: res.evidence ?? null,
    });
    res.submissionKey = key;
    res.ledgerPath = ledgerPath;
  }
}

function networkGuardOptions(params) {
  return { allow: params.networkGuardAllow, settleMs: params.networkGuardSettleMs };
}

/**
 * smart_fill_form with the optional network commit guard (active while stopBeforeSubmit is true).
 */
export async function smartFillFormGuarded(page, spec = {}, previousLinesSet = null) {
  const stop = spec.stopBeforeSubmit !== undefined ? Boolean(spec.stopBeforeSubmit) : true;
  const guard =
    stop && resolveNetworkGuard(spec.networkGuard) ? await installNetworkGuard(page, networkGuardOptions(spec)) : null;
  let res;
  try {
    res = await smartFillForm(page, spec, previousLinesSet);
    if (guard) await guard.settle();
  } finally {
    if (guard) await guard.remove();
  }
  if (guard) applyNetworkBlock(res, guard.blocked);
  return res;
}

// A disabled target never becomes clickable by waiting 8 s: allow ~1.2 s for it to enable, then fail with one line.
// Value the field holds after fill/type, for the mismatch report. Never echoed for password fields or with secrets on.
function readBack(locator) {
  return locator.evaluate((el) => (
    ['INPUT', 'TEXTAREA'].includes(el.tagName) && el.type !== 'file'
      ? { v: String(el.value), secret: el.type === 'password', sh: el.getRootNode?.() instanceof ShadowRoot } : null
  )).catch(() => null);
}
function mismatchText(back) {
  return back.secret || process.env.TURBO_BROWSER_SECRETS_FILE ? 'field value differs from the typed value' : `field now holds "${back.v.slice(0, 60)}"`;
}

async function disabledTargetLabel(locator, waitMs = 150) {
  const probe = () =>
    locator
      .evaluate((el) => {
        // The matched node can be a span inside a disabled button or a div[aria-disabled] wrapper: check the node
        // and its ancestors up to the nearest interactive one (crossing shadow roots).
        const isOff = (n) => n.matches?.(':disabled') || n.getAttribute?.('aria-disabled') === 'true';
        const INTERACTIVE = 'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"]';
        let off = null;
        let cur = el;
        for (let d = 0; cur && cur.nodeType === 1 && d < 8; d++) {
          if (isOff(cur)) { off = cur; break; }
          if (cur !== el && cur.matches(INTERACTIVE)) break;
          const rn = cur.getRootNode?.();
          cur = cur.parentElement || (rn instanceof ShadowRoot ? rn.host : null);
        }
        if (!off) return null;
        const name = (off.getAttribute('aria-label') || off.innerText || off.value || off.getAttribute('placeholder') || off.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        const role = off.getAttribute('role') || off.tagName.toLowerCase();
        return name ? `${role} '${name}'` : role;
      }, undefined, { timeout: 1000 })
      .catch(() => null);
  let label = await probe();
  const t0 = Date.now();
  while (label && Date.now() - t0 < waitMs) {
    await new Promise((r) => setTimeout(r, 100));
    label = await probe();
  }
  return label;
}

export async function actFast(page, params = {}, previousLinesSet = null) {
  const t0 = Date.now();
  const allowSubmit = resolveAllowSubmit(params.allowSubmit);
  const { key, ledgerPath, refusal } = prepareCommitControls(params, allowSubmit);
  if (refusal) {
    return { action: params.action, ...refusal, elapsedMs: Date.now() - t0 };
  }
  const guard =
    !allowSubmit && resolveNetworkGuard(params.networkGuard)
      ? await installNetworkGuard(page, networkGuardOptions(params))
      : null;
  const tnKey = allowSubmit && params.expect?.textNew ? await armTextNew(page, params.expect.textNew) : '';
  let res;
  try {
    res = await executeSingleAction(page, params);
    if (guard) await guard.settle();
  } finally {
    if (guard) await guard.remove();
  }
  tagBlockedBy(res);
  if (guard) applyNetworkBlock(res, guard.blocked);
  if (allowSubmit && !res.blocked && (params.expect || key)) {
    await finishCommit(page, params, key, ledgerPath, res, tnKey);
  }
  if (params.returnSnapshot && !res.blocked) {
    const snap = await inspectCompact(
      page,
      { mode: params.snapshotMode || 'interactive', maxChars: params.snapshotMaxChars || 2500, query: params.snapshotQuery },
      previousLinesSet
    );
    res.snapshot = wrapPage(snap.text);
  }
  res.elapsedMs = Date.now() - t0;
  return res;
}

/**
 * Execute multiple DOM/form actions sequentially in a single MCP turn,
 * optionally returning the post-batch compact snapshot.
 */
export async function batchActions(page, steps = [], options = {}, previousLinesSet = null) {
  const t0 = Date.now();
  const stepList = Array.isArray(steps) ? steps : [];
  const defaultAllowSubmit = resolveAllowSubmit(options.allowSubmit);
  const maySubmit =
    options.allowSubmit === false
      ? false
      : defaultAllowSubmit ||
        stepList.some(
          (s) =>
            s &&
            typeof s === 'object' &&
            (s.allowSubmit === true ||
              ((s.action === 'smart_fill_form' || s.action === 'fill_form') && s.stopBeforeSubmit === false))
        );
  const { key, ledgerPath, refusal } = prepareCommitControls(options, maySubmit);
  if (refusal) {
    return { completed: 0, total: stepList.length, ...refusal, results: [], elapsedMs: Date.now() - t0 };
  }
  const guard =
    !maySubmit && resolveNetworkGuard(options.networkGuard)
      ? await installNetworkGuard(page, networkGuardOptions(options))
      : null;
  const guardState = { guard, seen: 0 };
  const tnKey = maySubmit && options.expect?.textNew ? await armTextNew(page, options.expect.textNew) : '';
  let out;
  try {
    out = await batchActionsCore(page, stepList, options, previousLinesSet, guardState);
    if (guard && !out.blocked) {
      await guard.settle();
      if (guard.blocked.length > guardState.seen) {
        applyNetworkBlock(out, guard.blocked.slice(guardState.seen));
      }
    }
  } finally {
    if (guard) await guard.remove();
  }
  if (maySubmit && !out.blocked && !out.error && (options.expect || key)) {
    await finishCommit(page, options, key, ledgerPath, out, tnKey);
  }
  out.elapsedMs = Date.now() - t0;
  return out;
}

const BATCH_ACTIONS = new Set([
  'click', 'dblclick', 'hover', 'focus', 'clear', 'fill', 'type', 'select', 'check', 'uncheck', 'drag', 'drop', 'press',
  'scroll', 'wait', 'upload', 'reload', 'back', 'forward',
]);

async function batchActionsCore(page, stepList, options, previousLinesSet, guardState) {
  const t0 = Date.now();
  const continueOnError = Boolean(options.continueOnError);
  const defaultAllowSubmit = resolveAllowSubmit(options.allowSubmit);
  let lastNavBad = '';
  const results = [];
  let prevWasNav = false;

  for (let i = 0; i < stepList.length; i++) {
    const step = stepList[i];
    const afterNav = prevWasNav;
    prevWasNav = ['navigate', 'reload', 'back', 'forward'].includes(step?.action);
    try {
      if (!step || typeof step !== 'object') {
        throw new Error('Invalid batch step: expected an action object.');
      }
      let stepResult;
      if (step.action === 'smart_fill_form' || step.action === 'fill_form') {
        const effectiveStopBeforeSubmit =
          options.allowSubmit === false
            ? true
            : step.stopBeforeSubmit !== undefined
              ? Boolean(step.stopBeforeSubmit)
              : !defaultAllowSubmit;
        stepResult = await smartFillForm(
          page,
          { ...step, stopBeforeSubmit: effectiveStopBeforeSubmit },
          previousLinesSet
        );
      } else if (step.action === 'navigate') {
        if (!step.url) throw new Error('navigate requires url.');
        const url = new URL(String(step.url), page.url());
        if (!['http:', 'https:'].includes(url.protocol)) {
          throw new Error('navigate requires an HTTP(S) URL.');
        }
        if ((step.method !== undefined && String(step.method).toUpperCase() !== 'GET') ||
            step.body !== undefined || step.postData !== undefined) {
          throw new Error('navigate supports GET only, without a request body.');
        }
        const denied = urlDenial(url.href);
        if (denied) throw new Error(denied);
        let navResp, navRetried;
        try {
          ({ resp: navResp, retried: navRetried } = await gotoRetry(page, url.href, {
            waitUntil: 'domcontentloaded', timeout: Number(step.timeoutMs) || DEFAULT_TIMEOUT_MS,
          }));
        } catch (navErr) {
          // A redirect to a disallowed host: the record stays on the page so the tool result reports it once.
          const stopped = peekBlocked(page);
          if (stopped) throw new Error(denyMessage(matchUrl(stopped.url, getPolicy())));
          throw navErr;
        }
        const navTitle = await page.title().catch(() => '');
        stepResult = { ok: true, action: 'navigate', url: page.url(), ...(navRetried ? { retried: navRetried } : {}), ...(await navHealth(page, navResp, url.href, navTitle)) };
        lastNavBad = stepResult.blocked ? `page blocked (${stepResult.blocked})` : stepResult.status >= 400 ? `page status ${stepResult.status}` : '';
      } else if (step.action === 'extract') {
        stepResult = await extractCleanText(page, step);
        if (boundariesEnabled() && typeof stepResult.text === 'string') stepResult.text = wrapPage(stepResult.text);
      } else if (step.action === 'collect') {
        stepResult = await collectItems(page, step);
        if (boundariesEnabled() && Array.isArray(stepResult.items)) {
          stepResult.items = stepResult.items.map((it) => (typeof it === 'string' ? wrapPage(it) : it && typeof it.text === 'string' ? { ...it, text: wrapPage(it.text) } : it));
        }
        if (lastNavBad) stepResult.note = lastNavBad + (stepResult.note ? `; ${stepResult.note}` : '');
      } else {
        if (step.action && !BATCH_ACTIONS.has(step.action)) throw new Error(`unknown batch action: ${step.action}`);
        lastNavBad = '';
        stepResult = await executeSingleAction(page, {
          ...step,
          ...(afterNav && step.action === 'wait' && step.textNew ? { _freshDocument: true } : {}),
          returnSnapshot: options.returnSnapshot || step.returnSnapshot,
          observeAftermath: step.observeAftermath ?? options.observeAftermath,
          allowSubmit: options.allowSubmit === false ? false : (step.allowSubmit ?? defaultAllowSubmit),
        });
      }
      tagBlockedBy(stepResult);
      const g = guardState?.guard;
      if (g) await g.settleStep();
      if (g && g.blocked.length > guardState.seen) {
        applyNetworkBlock(stepResult, g.blocked.slice(guardState.seen));
        guardState.seen = g.blocked.length;
      }
      results.push({ step: i, ...stepResult });
      if (stepResult.blocked && !continueOnError) {
        return {
          completed: results.length,
          total: stepList.length,
          blocked: true,
          elapsedMs: Date.now() - t0,
          results,
        };
      }
    } catch (err) {
      results.push({ step: i, ok: false, action: step?.action, error: cleanErrorMessage(err.message) });
      if (!continueOnError) {
        return {
          completed: i,
          total: stepList.length,
          blocked: false,
          error: cleanErrorMessage(err.message),
          elapsedMs: Date.now() - t0,
          results,
        };
      }
    }
  }

  const out = {
    completed: results.length,
    total: stepList.length,
    blocked: false,
    results,
  };

  if (options.returnSnapshot) {
    const snap = await inspectCompact(
      page,
      { mode: options.snapshotMode || 'interactive', maxChars: options.snapshotMaxChars || 2500, query: options.snapshotQuery },
      previousLinesSet
    );
    out.snapshot = wrapPage(snap.text);
  }

  out.elapsedMs = Date.now() - t0;
  return out;
}

const INVISIBLE_RE = /[\u200B-\u200F\u2060\u2062-\u2064\uFEFF\u034F\u00AD]/g;

/**
 * Cheap generic noise filter for extracted text (anti-scrape watermarks as on Facebook): strips zero-width
 * characters, drops lines that were only 1-2 visible chars once those were removed (obfuscation fragments),
 * and collapses runs of the same short token ("Facebook" x33) into one with a count.
 */
export function denoiseText(text) {
  if (!text) return text;
  const hasInvisible = /[\u200B-\u200F\u2060\u2062-\u2064\uFEFF\u034F\u00AD]/.test(text);
  const lines = text.split('\n');
  const out = [];
  let runLine = null;
  let runCount = 0;
  const flush = () => {
    if (runLine === null) return;
    out.push(runCount >= 3 ? `${runLine} (x${runCount})` : Array(runCount).fill(runLine).join('\n'));
    runLine = null;
    runCount = 0;
  };
  for (const raw of lines) {
    let line = raw;
    if (hasInvisible && INVISIBLE_RE.test(line)) {
      INVISIBLE_RE.lastIndex = 0;
      line = line.replace(INVISIBLE_RE, '');
      if (line.replace(/[\s|]/g, '').length <= 2) continue;
    }
    INVISIBLE_RE.lastIndex = 0;
    if (line.length >= 12 && line.length <= 4000) {
      // "FacebookFacebookFacebook..." or "Facebook Facebook Facebook ..." inside one line
      line = line.replace(/((?=\S*\p{L})\S{3,20}?)(?:\s*\1){3,}/gu, '$1');
    }
    if (line.length > 0 && line.length <= 30 && line === runLine) {
      runCount += 1;
      continue;
    }
    flush();
    if (line.length > 0 && line.length <= 30) {
      runLine = line;
      runCount = 1;
    } else {
      out.push(line);
    }
  }
  flush();
  return out.join('\n');
}

/**
 * Extract readable main article / page text cleanly in plain text or compact markdown.
 */
export async function extractCleanText(page, options = {}) {
  const maxChars = Math.max(200, Number(options.maxChars) || 6000);
  const includeFrames = options.includeFrames !== false;
  const selector = options.selector || null;
  const format = options.format === 'markdown' ? 'markdown' : 'text';

  const frames = includeFrames ? getAllFrames(page) : getAllFrames(page).slice(0, 1);
  let sections = [];

  const runAll = async () => {
  sections = [];
  for (const frameInfo of frames) {
    let part = '';
    try {
      const runFrame = (skipOv, rescue = false) => frameInfo.frame.evaluate(({ sel, fmt, skipOv: doSkip, rescue: rescueMode }) => {
        const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'TEMPLATE']);
        const skipSet = new Set();
        let overlayNote = '';
        const ret = (t) => ({ t, o: overlayNote });
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const getSR = (node) => node?.shadowRoot || window.__tbmGetShadowRoot?.(node) || null;

        const findDeepAll = (rootNode, query) => {
          const seen = new Set();
          const out = [];
          const stack = [rootNode];
          while (stack.length > 0) {
            const cur = stack.shift();
            if (!cur) continue;
            const sr = getSR(cur);
            if (sr) stack.push(sr);
            if (!cur.querySelectorAll) continue;
            let matches;
            try {
              matches = cur.querySelectorAll(query);
            } catch {
              return out;
            }
            for (const m of matches) {
              if (!seen.has(m)) {
                seen.add(m);
                out.push(m);
              }
            }
            for (const el of cur.querySelectorAll('*')) {
              const elSr = getSR(el);
              if (elSr) stack.push(elSr);
            }
          }
          return out;
        };

        const isSubtreeHidden = (el) => {
          if (!el || el.nodeType !== 1) return false;
          let cur = el;
          while (cur && cur.nodeType === 1) {
            if (skipSet.has(cur)) return true;
            if (SKIP_TAGS.has((cur.tagName || '').toUpperCase()) || cur.hasAttribute('hidden')) return true;
            if (!rescueMode && cur.getAttribute('aria-hidden') === 'true') return true;
            const parent = cur.parentElement;
            if (parent && parent.tagName === 'DETAILS' && !parent.open) {
              const firstSummary = [...parent.children].find((c) => c.tagName === 'SUMMARY');
              if (!firstSummary || cur !== firstSummary) return true;
            }
            try {
              const st = getComputedStyle(cur);
              if (st.display === 'none' || Number(st.opacity) === 0 || st.contentVisibility === 'hidden') {
                return true;
              }
              // sr-only / offscreen text (clip pattern, 1px boxes, parked left of the page) is not rendered visibly.
              if (st.position === 'absolute' || st.position === 'fixed') {
                const rc = cur.getBoundingClientRect();
                if ((rc.width <= 1 && rc.height <= 1 && st.overflow !== 'visible') || rc.right <= 0 || rc.bottom <= 0 && st.position === 'fixed') {
                  return true;
                }
              }
            } catch {
              // ignore
            }
            const rn = cur.getRootNode?.();
            cur = parent || (rn instanceof ShadowRoot ? rn.host : null);
          }
          return false;
        };

        const isSelfVisibilityHidden = (el) => {
          if (!el || el.nodeType !== 1) return false;
          try {
            const st = getComputedStyle(el);
            return st.visibility === 'hidden' || st.visibility === 'collapse';
          } catch {
            return false;
          }
        };

        const extractDeepPlain = (node) => {
          if (!node) return '';
          if (node.nodeType === 3) {
            const parentEl =
              node.parentElement ||
              (node.getRootNode?.() instanceof ShadowRoot ? node.getRootNode().host : null);
            if (parentEl && isSelfVisibilityHidden(parentEl)) return '';
            return node.textContent || '';
          }
          if (node.nodeType !== 1 && node.nodeType !== 11) return '';
          if (node.nodeType === 1 && isSubtreeHidden(node)) return '';
          if (node.nodeType === 1 && node.tagName === 'BR') return '\n';

          let pieces = [];
          if (node.nodeType === 1 && getSR(node)) {
            pieces.push(extractDeepPlain(getSR(node)));
          } else if (node.nodeType === 1 && node.tagName === 'SLOT' && typeof node.assignedNodes === 'function') {
            const assigned = node.assignedNodes({ flatten: true });
            const list = assigned.length > 0 ? assigned : [...node.childNodes];
            for (const c of list) pieces.push(extractDeepPlain(c));
          } else {
            for (const c of node.childNodes) pieces.push(extractDeepPlain(c));
          }
          const inner = pieces.join('');
          const BLOCK = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'TR', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'BLOCKQUOTE', 'PRE']);
          if (node.nodeType === 1 && (node.tagName === 'TD' || node.tagName === 'TH')) {
            return ` ${inner} `;
          }
          if (node.nodeType === 1 && BLOCK.has(node.tagName)) {
            return `\n${inner}\n`;
          }
          return inner;
        };

        const isCompletelyHiddenRoot = (el) => {
          if (isSubtreeHidden(el)) return true;
          if (!isSelfVisibilityHidden(el)) return false;
          return extractDeepPlain(el).trim().length === 0;
        };

        let root = null;
        if (sel) {
          const matches = findDeepAll(document, sel);
          root = matches.find((el) => !isCompletelyHiddenRoot(el)) || matches[0] || null;
        } else {
          const mainMatches = findDeepAll(document, 'main, article, [role="main"]');
          root = rescueMode ? document.body : (mainMatches.find((el) => !isCompletelyHiddenRoot(el)) || document.body);
        }
        if (!root) return ret('');

        if (!sel && doSkip) {
          // Skip visible overlays (dialogs, sign-in walls, cookie banners) so they do not replace the page text.
          const COOKIE_RE = /cookie|consent|gdpr|onetrust|privacy-?(banner|notice)|cc-window/i;
          const cands = new Set();
          const addAll = (q) => {
            try { for (const e of root.querySelectorAll(q)) cands.add(e); } catch { /* ignore */ }
          };
          addAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], [id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="gdpr" i], [class*="gdpr" i], [id*="onetrust" i], [class*="onetrust" i]');
          for (const c1 of root.children || []) {
            cands.add(c1);
            for (const c2 of c1.children || []) cands.add(c2);
          }
          const vw = window.innerWidth || 1;
          const vh = window.innerHeight || 1;
          const found = [];
          for (const el of cands) {
            if (el === root || el.nodeType !== 1 || SKIP_TAGS.has(el.tagName)) continue;
            let st;
            try { st = getComputedStyle(el); } catch { continue; }
            if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) continue;
            if (st.position !== 'fixed' && st.position !== 'sticky' && st.position !== 'absolute') continue;
            const r = el.getBoundingClientRect();
            const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
            const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
            if (w < 40 || h < 20) continue;
            const idc = `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`;
            const role = el.getAttribute('role');
            const isDialog = role === 'dialog' || role === 'alertdialog' || el.getAttribute('aria-modal') === 'true' || el.tagName === 'DIALOG';
            const cookieLike = COOKIE_RE.test(idc);
            const z = parseInt(st.zIndex, 10) || 0;
            const cover = (w * h) / (vw * vh);
            const stuck = st.position === 'fixed' || st.position === 'sticky';
            const ok = (isDialog && (stuck || st.position === 'absolute')) ||
              (cookieLike && stuck) ||
              (stuck && z >= 100 && (cover >= 0.5 || (w >= vw * 0.6 && (r.top <= 4 || r.bottom >= vh - 4) && cookieLike)));
            if (!ok) continue;
            if (el.querySelector('main, article, [role="main"]')) continue;
            if (clean(el.innerText).length > 4000) continue;
            found.push(el);
          }
          const top = found.filter((el) => !found.some((o) => o !== el && o.contains(el)));
          if (top.length > 0) {
            for (const el of top) skipSet.add(el);
            const head = top[0].querySelector('h1,h2,h3,[role="heading"]');
            const label = clean(head?.innerText || top[0].innerText).slice(0, 40);
            overlayNote = `Overlay: ${label}${top.length > 1 ? ` +${top.length - 1}` : ''} (skipped)`;
          }
        }

        if (fmt === 'markdown') {
          const childNodesOf = (node) => {
            if (!node) return [];
            if (node.nodeType === 1 && getSR(node)) {
              return [...getSR(node).childNodes];
            }
            if (node.nodeType === 1 && node.tagName === 'SLOT' && typeof node.assignedNodes === 'function') {
              const assigned = node.assignedNodes({ flatten: true });
              return assigned.length > 0 ? [...assigned] : [...node.childNodes];
            }
            return [...(node.childNodes || [])];
          };

          const SEMANTIC_BLOCKS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'TR', 'PRE', 'BLOCKQUOTE']);
          const GENERIC_CONTAINERS = new Set([
            'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'NAV',
            'FORM', 'FIELDSET', 'DL', 'DT', 'DD', 'FIGURE', 'FIGCAPTION', 'DETAILS', 'SUMMARY',
            'UL', 'OL', 'TABLE', 'THEAD', 'TBODY', 'TFOOT',
          ]);

          const renderInline = (node, skipSubLists = false) => {
            if (!node) return '';
            if (node.nodeType === 3) {
              const parentEl =
                node.parentElement ||
                (node.getRootNode?.() instanceof ShadowRoot ? node.getRootNode().host : null);
              if (parentEl && isSelfVisibilityHidden(parentEl)) return '';
              return node.textContent || '';
            }
            if (node.nodeType !== 1 && node.nodeType !== 11) return '';
            if (node.nodeType === 1 && isSubtreeHidden(node)) return '';
            if (node.nodeType === 1 && node.tagName === 'BR') return ' ';
            if (skipSubLists && node.nodeType === 1 && (node.tagName === 'UL' || node.tagName === 'OL')) return '';
            if (node.nodeType === 1 && node.tagName === 'A' && node.getAttribute('href')) {
              let inner = '';
              for (const c of childNodesOf(node)) inner += renderInline(c, skipSubLists);
              const label = clean(inner);
              return label ? `[${label}](${node.getAttribute('href')})` : '';
            }
            let outStr = '';
            for (const c of childNodesOf(node)) {
              const isBlockChild =
                c.nodeType === 1 && (SEMANTIC_BLOCKS.has(c.tagName) || GENERIC_CONTAINERS.has(c.tagName));
              const piece = renderInline(c, skipSubLists);
              if (!piece) continue;
              if (isBlockChild) {
                const trimmed = piece.trim();
                if (trimmed) {
                  if (outStr && !/\s$/.test(outStr)) outStr += ' ';
                  outStr += `${trimmed} `;
                }
              } else {
                outStr += piece;
              }
            }
            return outStr;
          };

          const listDepthOf = (liNode) => {
            let depth = 0;
            let cur = liNode.parentElement;
            while (cur) {
              if (cur.tagName === 'UL' || cur.tagName === 'OL') depth++;
              cur = cur.parentElement;
            }
            return Math.max(0, depth - 1);
          };

          const out = [];

          const extractPreText = (n) => {
            if (!n) return '';
            if (n.nodeType === 3) {
              const parentEl =
                n.parentElement ||
                (n.getRootNode?.() instanceof ShadowRoot ? n.getRootNode().host : null);
              if (parentEl && isSelfVisibilityHidden(parentEl)) return '';
              return n.textContent || '';
            }
            if (n.nodeType !== 1 && n.nodeType !== 11) return '';
            if (n.nodeType === 1 && isSubtreeHidden(n)) return '';
            if (n.nodeType === 1 && n.tagName === 'BR') return '\n';
            let res = '';
            for (const c of childNodesOf(n)) res += extractPreText(c);
            return res;
          };

          const renderSemanticBlock = (node) => {
            const tag = node.tagName.toLowerCase();
            if (tag === 'pre') {
              if (isCompletelyHiddenRoot(node)) return;
              const codeTxt = extractPreText(node).replace(/^\n+|\n+$/g, '');
              if (codeTxt) out.push(`\`\`\`\n${codeTxt}\n\`\`\``);
            } else if (tag === 'blockquote') {
              const txt = clean(renderInline(node));
              if (txt) out.push(`> ${txt}`);
            } else if (/^h[1-6]$/.test(tag)) {
              const level = '#'.repeat(Number(tag[1]));
              const txt = clean(renderInline(node));
              if (txt) out.push(`${level} ${txt}`);
            } else if (tag === 'li') {
              const txt = clean(renderInline(node, true));
              const indent = '  '.repeat(listDepthOf(node));
              if (txt) out.push(`${indent}- ${txt}`);
              for (const c of childNodesOf(node)) {
                if (c.nodeType === 1 && !isSubtreeHidden(c) && (c.tagName === 'UL' || c.tagName === 'OL')) {
                  walkContainer(c);
                }
              }
            } else if (tag === 'tr') {
              if (isCompletelyHiddenRoot(node)) return;
              const directCells = [...node.children].filter((c) => c.tagName === 'TH' || c.tagName === 'TD');
              const cells = (directCells.length > 0 ? directCells : [...node.querySelectorAll('th, td')]).filter(
                (c) => !isSubtreeHidden(c) && !isCompletelyHiddenRoot(c)
              );
              const cellTexts = cells.map((c) => clean(renderInline(c)).replace(/\|/g, '\\|'));
              if (cellTexts.length > 0) {
                out.push(`| ${cellTexts.join(' | ')} |`);
                if (cells.every((c) => c.tagName === 'TH')) {
                  out.push(`| ${cells.map(() => '---').join(' | ')} |`);
                }
              }
            } else {
              const txt = clean(renderInline(node));
              if (txt) out.push(txt);
            }
          };

          const hasBlockDescendant = (node) => {
            for (const c of childNodesOf(node)) {
              if (c.nodeType === 1 && !isSubtreeHidden(c)) {
                if (SEMANTIC_BLOCKS.has(c.tagName) || GENERIC_CONTAINERS.has(c.tagName) || Boolean(c.shadowRoot)) {
                  return true;
                }
                if (hasBlockDescendant(c)) return true;
              }
            }
            return false;
          };

          const walkContainer = (container) => {
            if (!container) return;
            if (container.nodeType === 1 && isSubtreeHidden(container)) return;
            if (container.nodeType === 1 && SEMANTIC_BLOCKS.has(container.tagName)) {
              renderSemanticBlock(container);
              return;
            }

            let inlineBuf = '';
            const flushInline = () => {
              const txt = clean(inlineBuf);
              if (txt) out.push(txt);
              inlineBuf = '';
            };

            for (const child of childNodesOf(container)) {
              if (child.nodeType === 3) {
                if (container.nodeType !== 1 || !isSelfVisibilityHidden(container)) {
                  inlineBuf += child.textContent || '';
                }
                continue;
              }
              if (child.nodeType !== 1 && child.nodeType !== 11) continue;
              if (child.nodeType === 1 && isSubtreeHidden(child)) continue;

              if (child.nodeType === 1 && SEMANTIC_BLOCKS.has(child.tagName)) {
                flushInline();
                renderSemanticBlock(child);
              } else if (
                child.nodeType === 11 ||
                GENERIC_CONTAINERS.has(child.tagName) ||
                Boolean(child.shadowRoot) ||
                hasBlockDescendant(child)
              ) {
                flushInline();
                walkContainer(child);
              } else {
                const piece = renderInline(child);
                if (piece) inlineBuf += piece;
              }
            }
            flushInline();
          };

          walkContainer(root);
          if (out.length > 0) return ret(out.join('\n'));
        }

        return ret(extractDeepPlain(root)
          .split('\n')
          .map((line) => line.replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join('\n'));
      }, { sel: selector, fmt: format, skipOv, rescue });
      let res = await runFrame(true);
      if (res.o && res.t.length < 200) res = await runFrame(false);
      if (!selector && res.t.length < 3000) {
        // Main-content heuristic picked an empty <main> or an aria-hidden app root (modal libraries set it on #__next):
        // when the result is under 10% of the page's innerText, retry from <body> ignoring aria-hidden.
        const bodyLen = await frameInfo.frame
          .evaluate(() => (document.body ? document.body.innerText.replace(/\s+/g, ' ').trim().length : 0))
          .catch(() => 0);
        if (bodyLen > 300 && res.t.length < bodyLen * 0.1) {
          const rescued = await runFrame(true, true);
          if (rescued.t.length > res.t.length) res = rescued;
        }
      } else if (selector && !res.t) {
        // The selector matched but everything was dropped: a modal library can set aria-hidden on the app root.
        const rescued = await runFrame(true, true);
        if (rescued.t) res = rescued;
      }
      part = denoiseText(res.o ? `${res.o}\n${res.t}` : res.t);
    } catch {
      part = '';
    }
    if (part) {
      sections.push(frameInfo.isMain ? part : `[iframe f${frameInfo.frameIdx}]\n${part}`);
    }
  }
  };
  await runAll();
  // An SPA right after navigate: the shell is there, the text is not (or is still fading in). Wait once, up to ~2 s.
  let note = '';
  if (sections.length === 0) {
    const until = Date.now() + 2000;
    while (sections.length === 0 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 200));
      await runAll();
    }
    if (sections.length === 0) note = 'page has no text yet';
  }

  const title = await page.title().catch(() => '');
  const header = `URL: ${page.url()}\nTitle: ${title}\n\n`;
  const joined = sections.join('\n\n');
  const full = `${header}${joined}`;
  const truncated = full.length > maxChars;
  const text = truncated ? `${full.slice(0, Math.max(0, maxChars - 20))}\n... [truncated]` : full;
  const savedPath = writeSaveFile(options.savePath, full);

  return {
    text,
    fullChars: savedPath && truncated ? full.length : undefined,
    url: page.url(),
    title,
    format,
    truncated,
    charCount: text.length,
    savePath: savedPath,
    ...(note ? { note } : {}),
  };
}

function stripTrailingSemisAndComments(src) {
  const REGEX_PRECEDING_KEYWORDS = new Set([
    'return', 'typeof', 'void', 'delete', 'in', 'instanceof',
    'case', 'throw', 'new', 'yield', 'await', 'else', 'do',
  ]);
  let lastCodeEnd = 0;
  let i = 0;
  const n = src.length;
  let canStartRegex = true;
  let afterMemberAccess = false;
  let braceDepth = 0;
  const templateBraceStack = [];

  const scanTemplateChunk = () => {
    afterMemberAccess = false;
    while (i < n) {
      if (src[i] === '\\') {
        i = Math.min(n, i + 2);
        continue;
      }
      if (src[i] === '`') {
        i++;
        lastCodeEnd = i;
        canStartRegex = false;
        return;
      }
      if (src[i] === '$' && src[i + 1] === '{') {
        templateBraceStack.push(braceDepth);
        braceDepth++;
        i += 2;
        lastCodeEnd = i;
        canStartRegex = true;
        return;
      }
      i++;
    }
    lastCodeEnd = i;
    canStartRegex = false;
  };

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }
    if (ch === ';') {
      canStartRegex = true;
      afterMemberAccess = false;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      if (i < n) i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          i = Math.min(n, i + 2);
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      lastCodeEnd = i;
      canStartRegex = false;
      afterMemberAccess = false;
      continue;
    }
    if (ch === '`') {
      i++;
      scanTemplateChunk();
      continue;
    }
    if (ch === '{') {
      braceDepth++;
      i++;
      lastCodeEnd = i;
      canStartRegex = true;
      afterMemberAccess = false;
      continue;
    }
    if (ch === '}') {
      if (
        templateBraceStack.length > 0 &&
        braceDepth === templateBraceStack[templateBraceStack.length - 1] + 1
      ) {
        templateBraceStack.pop();
        braceDepth--;
        i++;
        scanTemplateChunk();
        continue;
      }
      if (braceDepth > 0) braceDepth--;
      i++;
      lastCodeEnd = i;
      canStartRegex = false;
      afterMemberAccess = false;
      continue;
    }
    if (ch === '/' && canStartRegex) {
      i++;
      let inCharClass = false;
      while (i < n) {
        if (src[i] === '\\') {
          i = Math.min(n, i + 2);
          continue;
        }
        if (src[i] === '[') {
          inCharClass = true;
          i++;
          continue;
        }
        if (src[i] === ']') {
          inCharClass = false;
          i++;
          continue;
        }
        if (src[i] === '/' && !inCharClass) {
          i++;
          break;
        }
        if (src[i] === '\n' || src[i] === '\r') {
          break;
        }
        i++;
      }
      while (i < n && /[a-z]/i.test(src[i])) i++;
      lastCodeEnd = i;
      canStartRegex = false;
      afterMemberAccess = false;
      continue;
    }
    if (ch === '.') {
      if (next === '.' && src[i + 2] === '.') {
        i += 3;
        lastCodeEnd = i;
        canStartRegex = true;
        afterMemberAccess = false;
        continue;
      }
      i++;
      lastCodeEnd = i;
      canStartRegex = false;
      afterMemberAccess = true;
      continue;
    }
    const cp = src.codePointAt(i);
    const chStr = String.fromCodePoint(cp);
    if (/[\p{ID_Start}$_]/u.test(chStr)) {
      const start = i;
      i += chStr.length;
      while (i < n) {
        const nextCp = src.codePointAt(i);
        const nextStr = String.fromCodePoint(nextCp);
        if (!/[\p{ID_Continue}$\u200C\u200D]/u.test(nextStr)) break;
        i += nextStr.length;
      }
      const word = src.slice(start, i);
      lastCodeEnd = i;
      canStartRegex = !afterMemberAccess && REGEX_PRECEDING_KEYWORDS.has(word);
      afterMemberAccess = false;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      i++;
      while (i < n && /[0-9a-zA-Z_.]/.test(src[i])) i++;
      lastCodeEnd = i;
      canStartRegex = false;
      afterMemberAccess = false;
      continue;
    }
    if ((ch === '+' && next === '+') || (ch === '-' && next === '-')) {
      i += 2;
      lastCodeEnd = i;
      canStartRegex = false;
      afterMemberAccess = false;
      continue;
    }
    if (ch === ')' || ch === ']') {
      i++;
      lastCodeEnd = i;
      canStartRegex = false;
      afterMemberAccess = false;
      continue;
    }
    i++;
    lastCodeEnd = i;
    canStartRegex = true;
    afterMemberAccess = false;
  }
  return src.slice(0, lastCodeEnd).trim();
}

/**
 * Evaluate JavaScript expression/function inside a target frame or element (passing el, arg) and optionally save output.
 */
export async function evaluateJs(page, { expression, frameIdx = 0, arg, ref, selector, text, savePath } = {}) {
  if (!expression || typeof expression !== 'string') {
    throw new Error('evaluate_js requires an expression string.');
  }

  const exprCandidate = stripTrailingSemisAndComments(expression);
  let resolvedFrameIdx = frameIdx;
  let result;

  if (ref || selector || text) {
    const target = await resolveTarget(page, { ref, selector, text, frameIdx });
    resolvedFrameIdx = target.frameIdx;
    result = await target.locator.evaluate(
      async (el, { code, exprCode, payload }) => {
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        let fn;
        try {
          fn = new AsyncFunction('el', 'arg', `return (\n${exprCode}\n);`);
        } catch (err) {
          if (err instanceof SyntaxError) {
            fn = new AsyncFunction('el', 'arg', code);
          } else {
            throw err;
          }
        }
        const val = await fn(el, payload);
        const finalVal = typeof val === 'function' ? await val(el, payload) : val;
        return finalVal === undefined ? null : finalVal;
      },
      { code: expression, exprCode: exprCandidate, payload: arg }
    );
  } else {
    const frames = getAllFrames(page);
    const target = frames.find((f) => f.frameIdx === frameIdx);
    if (!target) throw new Error(`Frame ${frameIdx} not found.`);
    resolvedFrameIdx = target.frameIdx;
    result = await target.frame.evaluate(
      async ({ code, exprCode, payload }) => {
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        let fn;
        try {
          fn = new AsyncFunction('arg', `return (\n${exprCode}\n);`);
        } catch (err) {
          if (err instanceof SyntaxError) {
            fn = new AsyncFunction('arg', code);
          } else {
            throw err;
          }
        }
        const val = await fn(payload);
        const finalVal = typeof val === 'function' ? await val(payload) : val;
        return finalVal === undefined ? null : finalVal;
      },
      { code: expression, exprCode: exprCandidate, payload: arg }
    );
  }

  const normalizedResult = result === undefined ? null : result;
  const serialized = typeof normalizedResult === 'string' ? normalizedResult : JSON.stringify(normalizedResult, null, 2);
  const savedPath = writeSaveFile(savePath, serialized ?? 'null');
  const out = { frameIdx: resolvedFrameIdx, result: normalizedResult, savePath: savedPath };
  if (savedPath) {
    const body = serialized ?? 'null';
    out.bytes = Buffer.byteLength(body, 'utf8');
    out.preview = body.slice(0, 300);
  }
  return out;
}

/**
 * Capture full-page/element screenshots (png/jpeg) or PDF export safely to cwd-resolved paths.
 */
export async function capturePage(page, params = {}) {
  const mode = params.mode === 'pdf' ? 'pdf' : 'screenshot';
  const timeout = Number(params.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const resolvedPath = params.savePath
    ? resolveSafePath(params.savePath, 'savePath')
    : null;

  if (resolvedPath) {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }

  if (mode === 'pdf') {
    let pdfBuf;
    // Print media + the page's own @page size/margins; A4 with no margin only when the CSS declares none.
    await page.emulateMedia({ media: 'print' }).catch(() => {});
    try {
      try {
        pdfBuf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
      } catch {
        const client = await page.context().newCDPSession(page);
        try {
          const { data } = await client.send('Page.printToPDF', {
            printBackground: true,
            preferCSSPageSize: true,
            paperWidth: 8.27,
            paperHeight: 11.7,
            marginTop: 0,
            marginBottom: 0,
            marginLeft: 0,
            marginRight: 0,
          });
          pdfBuf = Buffer.from(data, 'base64');
        } finally {
          await client.detach().catch(() => {});
        }
      }
    } finally {
      await page.emulateMedia({ media: null }).catch(() => {});
    }
    if (resolvedPath) {
      fs.writeFileSync(resolvedPath, pdfBuf);
    }
    return {
      ok: true,
      mode: 'pdf',
      savePath: resolvedPath,
      bytes: pdfBuf.length,
    };
  }

  const type = params.type === 'jpeg' ? 'jpeg' : 'png';
  const shotOpts = {
    type,
    quality: type === 'jpeg' ? (Number(params.quality) || 80) : undefined,
    scale: params.scale === 'device' ? 'device' : 'css',
    timeout,
  };

  let imgBuf;
  if (params.ref || params.selector || params.text) {
    const target = await resolveTarget(page, params);
    imgBuf = await target.locator.screenshot(shotOpts);
  } else {
    imgBuf = await page.screenshot({
      ...shotOpts,
      fullPage: Boolean(params.fullPage),
    });
  }

  if (resolvedPath) {
    fs.writeFileSync(resolvedPath, imgBuf);
  }

  const shouldReturnImage = params.returnImage ?? !resolvedPath;
  return {
    ok: true,
    mode: 'screenshot',
    type,
    mimeType: type === 'jpeg' ? 'image/jpeg' : 'image/png',
    savePath: resolvedPath,
    bytes: imgBuf.length,
    base64: shouldReturnImage ? imgBuf.toString('base64') : undefined,
  };
}
