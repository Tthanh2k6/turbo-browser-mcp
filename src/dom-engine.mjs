import fs from 'node:fs';
import { gotoRetry, navHealth } from './navinfo.mjs';

import { urlDenial, peekBlocked, denyMessage, matchUrl, getPolicy } from './allow-hosts.mjs';
import { isBackgroundRequest, observeClickAftermath, parkLate, watchActivity } from './aftermath.mjs';
import { armToasts, takeToast } from './toast.mjs';
import { wrapPage, boundariesEnabled } from './boundaries.mjs';
import { redactText, redactUrlParams } from './secrets.mjs';
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
  /^(next|continue|search|filter|save\s*draft|log\s*in|sign\s*in|tiếp(\s*tục)?|tìm(\s*kiếm)?|lọc|lưu\s*nháp|đăng\s+nhập|load\s+more|show\s+more|see\s+more|view\s+more|next\s+page|previous\s+page|xem\s+thêm|tải\s+thêm|다음|이전|검색|로그인|次へ|検索|ログイン|下一步|搜索|登录)(?![\p{L}\p{N}_])/iu;

// Destructive-but-local UI (chip remove, clear form, close/cancel): not a final submit unless it is type=submit.
const LOCAL_UI_RE =
  /^(?!.*(?:account|profile|permanently|everything|workspace|tài\s*khoản|vĩnh\s*viễn))(remove|clear|cancel|close|hủy|huỷ|đóng|xóa\s+hết\s+câu\s+trả\s+lời|xoá\s+hết\s+câu\s+trả\s+lời|xóa\s+biểu\s+mẫu|xoá\s+biểu\s+mẫu)(?![\p{L}\p{N}_])/iu;

const APPLY_LABEL_RE = /^apply(\s+now)?(?![\p{L}\p{N}_])/iu;

// Non-submitting buttons that merely open an inline reply/edit form (e.g. dev.to Reply/Edit buttons that load a form via XHR POST).
const EDITOR_OPEN_LABEL_RE =
  /^(reply(\s+to\b.*)?|edit(\s+(comment|post|reply|article|message|profile|bio))?|write\s+a\s+reply|add\s+a?\s*comment|leave\s+a?\s*comment|trả\s*lời|chỉnh\s*sửa|sửa)(?![\p{L}\p{N}_])/iu;

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

const pageLoaders = new WeakMap();
const pageRefFingerprints = new WeakMap();

function getPageRefFingerprints(page) {
  let map = pageRefFingerprints.get(page);
  if (!map) {
    map = new Map();
    pageRefFingerprints.set(page, map);
  }
  return map;
}

function reusedRefMessage(ref, stored) {
  if (stored?.startsWith('#id:')) {
    return `Element ref "${ref}" now points to a different field (its name, type or label changed, e.g. a virtualized form reused the node). Run inspect_compact again.`;
  }
  return `Element ref "${ref}" now shows different content (the node was reused, e.g. a virtualized list scrolled). Run inspect_compact again.`;
}

function computeElementFingerprintInBrowser(el) {
  if (!el || el.nodeType !== 1) return null;
  function identityOf(node) {
    const tag = (node.tagName || '').toLowerCase();
    const ce = node.getAttribute?.('contenteditable');
    const role = (node.getAttribute?.('role') || '').trim().toLowerCase();
    const isValueControl = tag === 'input' || tag === 'textarea' || tag === 'select' ||
      node.isContentEditable ||
      (ce !== null && ce !== undefined && String(ce).toLowerCase() !== 'false') ||
      role === 'textbox' || role === 'combobox' || role === 'slider' || role === 'spinbutton';
    if (!isValueControl) return null;
    const label = node.labels?.[0];
    const root = node.getRootNode();
    const labelText = label ? label.textContent : (node.getAttribute('aria-labelledby') || '')
      .split(/\s+/).filter(Boolean).map((id) => root.getElementById?.(id)?.textContent || '').join(' ');
    // Remove separators and mask live counters; values and checked state are never identity.
    const part = (s) => String(s || '').replace(/\u0000/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64);
    const mask = (s) => String(s || '').replace(/\d+/g, '#');
    // Hydration may expand [f] to [alt-shift-f]; only strip hints for this control's accesskey.
    const accessKeys = (node.getAttribute('accesskey') || '').toLowerCase().split(/\s+/).filter(Boolean);
    const title = (node.getAttribute('title') || '').replace(/\s*\[([^\[\]]+)\]\s*$/, (suffix, hint) => {
      const key = hint.toLowerCase().replace(/^(?:(?:alt|ctrl|control|shift|meta|cmd|command|option)[+-])+/, '');
      return accessKeys.includes(key) ? '' : suffix;
    });
    return [tag, tag === 'input' ? (node.getAttribute('type') || '').toLowerCase() : '',
      node.getAttribute('name'), node.getAttribute('id'), mask(node.getAttribute('aria-label')),
      mask(node.getAttribute('placeholder')), node.getAttribute('role'), mask(title),
      mask(labelText)].map(part).join('\u0000');
  }
  const identity = identityOf(el);
  if (identity !== null) {
    // Only matching controls count, within the nearest ancestor containing a clone.
    // parentNode includes ShadowRoot, keeping controls in the same DOM tree together.
    const tag = el.tagName.toLowerCase();
    // One pass over this DOM tree with cheap attribute checks first: a form with hundreds of fields stays fast.
    const same = (node, attr) => node.getAttribute(attr) === el.getAttribute(attr);
    const treeRoot = el.getRootNode();
    const clones = treeRoot.querySelectorAll ? Array.from(treeRoot.querySelectorAll(tag)).filter((node) => node === el ||
      (same(node, 'name') && same(node, 'id') && same(node, 'type') && same(node, 'role') && identityOf(node) === identity)) : [];
    function ownerOf(node) {
      if (!node) return '';
      const map = window.__tbmOwners || (window.__tbmOwners = new WeakMap());
      let id = map.get(node);
      if (!id) map.set(node, id = (window.__tbmOwnerSeq = (window.__tbmOwnerSeq || 0) + 1));
      return id;
    }
    const group = el.closest?.('fieldset, tr, [role="group"], [role="row"], [role="listitem"]');
    if (clones.length > 1) {
      for (let container = el.parentNode; container; container = container.parentNode) {
        const inside = clones.filter((node) => container.contains(node));
        if (inside.length > 1) {
          const owner = group || container.tagName !== 'FORM' ? `\u0000#owner:${ownerOf(group)}:${ownerOf(container)}` : '';
          return '#id:' + identity + owner + '\u0000#index:' + inside.indexOf(el) + '/' + inside.length;
        }
      }
    }
    const owner = group ? `\u0000#owner:${ownerOf(group)}:` : '';
    return '#id:' + identity + owner;
  }
  return '#text:' + String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 128);
}

function splitFingerprint(fp) {
  const at = fp.indexOf('\u0000#index:');
  if (at < 0) return { id: fp, cnt: 1, hasCnt: true };
  const tail = fp.slice(at + 8);
  const slash = tail.indexOf('/');
  return slash < 0
    ? { id: fp.slice(0, at), cnt: null, hasCnt: false }
    : { id: fp.slice(0, at), cnt: Number(tail.slice(slash + 1)), hasCnt: true };
}

async function assertRefFingerprint(page, ref, parsed, locator, frame = null, frameIdx = null) {
  const map = pageRefFingerprints.get(page);
  if (!map || !parsed || !locator) return null;
  const bare = parsed.refId.toLowerCase();
  const key = parsed.frameIdx !== null ? `f${parsed.frameIdx}:${bare}` : bare;
  const stored = map.has(key) ? map.get(key) : map.get(bare);
  if (typeof stored !== 'string') return null;
  const cur = await locator.evaluate(computeElementFingerprintInBrowser).catch(() => null);
  if (typeof cur !== 'string' || cur === stored) return null;
  const s = splitFingerprint(stored);
  const c = splitFingerprint(cur);
  if (s.id !== c.id || (s.hasCnt && c.hasCnt && s.cnt === c.cnt)) {
    throw new Error(reusedRefMessage(ref, stored));
  }
  const fi = parsed.frameIdx ?? frameIdx;
  map.set(key, cur);
  map.set(bare, cur);
  if (fi !== null && fi !== undefined) map.set(`f${fi}:${bare}`, cur);
  if (!s.hasCnt || !c.hasCnt) return null;
  if (frame) {
    const peerIds = new Set();
    for (const [k, v] of map.entries()) {
      if (typeof v !== 'string') continue;
      const ps = splitFingerprint(v);
      if (ps.id === s.id && ps.cnt === s.cnt) {
        const pid = k.includes(':') ? k.split(':')[1] : k;
        if (pid && pid !== bare) peerIds.add(pid);
      }
    }
    for (const pid of peerIds) {
      const h = await frame.$(`[data-tbm-ref="${pid}"]`).catch(() => null);
      if (!h) continue;
      try {
        const pCur = await h.evaluate(computeElementFingerprintInBrowser).catch(() => null);
        if (typeof pCur === 'string') {
          const pc = splitFingerprint(pCur);
          if (pc.id === s.id && pc.cnt === c.cnt) {
            map.set(pid, pCur);
            if (fi !== null && fi !== undefined) map.set(`f${fi}:${pid}`, pCur);
          }
        }
      } finally {
        await h.dispose().catch(() => {});
      }
    }
  }
  return `clone group for ${ref} changed size (${s.cnt} -> ${c.cnt})`;
}

function flattenCdpFrameTree(node, out = []) {
  if (!node?.frame) return out;
  out.push(node.frame);
  for (const child of node.childFrames || []) flattenCdpFrameTree(child, out);
  return out;
}

async function syncFrameTree(st) {
  if (!st?.sess) return false;
  try {
    let timer;
    const res = await Promise.race([
      st.sess.send('Page.getFrameTree'),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), 1000); }),
    ]).finally(() => clearTimeout(timer));
    const list = flattenCdpFrameTree(res?.frameTree);
    if (list.length > 0) {
      st.byId.clear();
      st.ordered = list.map((f) => {
        const entry = {
          id: f.id,
          parentId: f.parentId || '',
          loaderId: f.loaderId || '',
          name: f.name || '',
          url: f.url || '',
        };
        st.byId.set(f.id, entry);
        return entry;
      });
      return true;
    }
  } catch {}
  return false;
}

async function getPageLoaderState(page) {
  if (!page || typeof page.context !== 'function') return null;
  let st = pageLoaders.get(page);
  if (!st) {
    st = { sess: null, byId: new Map(), ordered: [], refs: new Map(), ready: null, failed: false };
    pageLoaders.set(page, st);
    st.ready = (async () => {
      const ctx = page.context();
      if (!ctx || typeof ctx.newCDPSession !== 'function') {
        st.failed = true;
        return null;
      }
      const sess = await ctx.newCDPSession(page);
      st.sess = sess;
      if (typeof sess.on === 'function') {
        sess.on('Page.frameNavigated', (ev) => {
          const f = ev?.frame;
          if (!f?.id || !f?.loaderId) return;
          const entry = {
            id: f.id,
            parentId: f.parentId || '',
            loaderId: f.loaderId,
            name: f.name || '',
            url: f.url || '',
          };
          st.byId.set(f.id, entry);
          const idx = st.ordered.findIndex((x) => x.id === f.id);
          if (idx >= 0) st.ordered[idx] = entry;
          else if (!f.parentId) st.ordered[0] = entry;
          else st.ordered.push(entry);
        });
        sess.on('Page.frameDetached', (ev) => {
          if (ev?.frameId) {
            st.byId.delete(ev.frameId);
            st.ordered = st.ordered.filter((x) => x.id !== ev.frameId);
          }
        });
      }
      await sess.send('Page.enable').catch(() => {});
      await syncFrameTree(st);
      return st;
    })().catch(() => {
      st.failed = true;
      return null;
    });
  }
  await st.ready;
  if (st.failed || !st.sess) return null;
  return st;
}

function matchCdpFrame(st, frames, frameIdx) {
  if (!st || st.ordered.length === 0) return null;
  if (frameIdx === 0) return st.ordered.find((f) => !f.parentId) || st.ordered[0] || null;
  const info = frames.find((f) => f.frameIdx === frameIdx);
  const direct = st.ordered[frameIdx];
  if (direct && direct.parentId) {
    if (!info || st.ordered.length === frames.length || ((direct.name || '') === info.name && (direct.url === info.url || !info.url))) {
      return direct;
    }
  }
  if (info) {
    if (info.name) {
      const byNameUrl = st.ordered.find((f, i) => i > 0 && f.name === info.name && f.url === info.url);
      if (byNameUrl) return byNameUrl;
      const byName = st.ordered.find((f, i) => i > 0 && f.name === info.name);
      if (byName) return byName;
    }
    if (info.url) {
      const byUrl = st.ordered.filter((f, i) => i > 0 && f.url === info.url);
      if (byUrl.length === 1) return byUrl[0];
    }
  }
  return direct || null;
}

async function isRefFromPreviousDocument(page, frames, parsed) {
  if (!parsed) return false;
  const st = pageLoaders.get(page);
  if (!st) return false;
  await st.ready;
  if (st.failed || !st.sess) return false;
  const key = parsed.frameIdx !== null
    ? `f${parsed.frameIdx}:${parsed.refId.toLowerCase()}`
    : parsed.refId.toLowerCase();
  const stamp = st.refs.get(key);
  if (!stamp || !stamp.loaderId) return false;
  await syncFrameTree(st);
  const byId = stamp.frameId ? st.byId.get(stamp.frameId) : null;
  const cur = byId?.loaderId || matchCdpFrame(st, frames, parsed.frameIdx ?? stamp.frameIdx)?.loaderId || '';
  if (!cur) {
    if (stamp.mainLoaderId) {
      const mainCur = (st.ordered.find((f) => !f.parentId) || st.ordered[0])?.loaderId || '';
      if (mainCur && mainCur !== stamp.mainLoaderId) return true;
    }
    return false;
  }
  return cur !== stamp.loaderId;
}

async function assertCurrentDocumentRef(page, ref, frames = getAllFrames(page)) {
  if (!ref) return;
  const parsed = parseRefString(String(ref));
  if (!parsed) return;
  if (await isRefFromPreviousDocument(page, frames, parsed)) {
    throw new Error(`Element ref "${ref}" belongs to a previous document (the page navigated since it was issued). Run inspect_compact again.`);
  }
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
  const m = /(<.{3,300}?>)([^\r\n]*?)\s+intercepts pointer events/.exec(raw.replace(ANSI_RE, ''));
  if (!m) return msg === raw ? err : new Error(msg);
  // Playwright says "<path ...> from <ext-host id=...> subtree" when the cover lives in another subtree (an
  // extension's floating widget, a shadow host): name that host, a bare svg path tells nobody anything.
  const host = /\sfrom\s+(<[^\r\n]{3,300}?>)\s+subtree/.exec(m[2]);
  const covering = (host ? host[1] : m[1]).replace(/\s+/g, ' ').slice(0, 140);
  return new Error(`Click blocked: ${covering} covers the target. Close or scroll it away, or act on it, then retry.`);
}

/**
 * Resolve a compact ref (f0:e3 / e3), CSS/Playwright selector (piercing open Shadow DOM),
 * or text match across frames.
 */
export async function resolveTarget(page, { ref, selector, text, label, action, frameIdx, allowHidden: paramAllowHidden } = {}, options = {}) {
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
    if (await isRefFromPreviousDocument(page, frames, parsed)) {
      throw new Error(`Element ref "${ref}" belongs to a previous document (the page navigated since it was issued). Run inspect_compact again.`);
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
        if (picked.visible) {
          const note = await assertRefFingerprint(page, ref, parsed, res.locator, f.frame, f.frameIdx);
          if (note) res.note = note;
          return res;
        }
        if (!fallback) fallback = res;
      }
    }
    if (fallback) {
      const note = await assertRefFingerprint(page, ref, parsed, fallback.locator, fallback.frame, fallback.frameIdx);
      if (note) fallback.note = note;
      return fallback;
    }
    const near = await nearbyRefs(candidates, parsed.refId);
    if (refWasIssued(page, ref)) {
      throw new Error(`Element ref "${ref}" not found (page navigated or re-rendered since this ref was issued). ${near ? `Nearest current refs: ${near}. ` : ''}Run inspect_compact again.`);
    }
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
    // A modal dialog is open: its own match wins over an identical label on the page behind it.
    for (const f of scopedFrames) {
      const modal = f.frame.locator('[role="dialog"]:visible, [role="alertdialog"]:visible, [aria-modal="true"]:visible, dialog[open]');
      if (!(await modal.count().catch(() => 0))) continue;
      const picked = await pickBestTextLocator(modal.getByText(text, { exact: false }), text, allowHidden).catch(() => null);
      if (picked?.visible) return { frame: f.frame, frameIdx: f.frameIdx, locator: picked.locator };
    }
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
    // Text split over child elements (a link of block spans): match the normalized innerText, smallest actionable element first.
    for (const f of scopedFrames) {
      const hit = await f.frame.evaluate((want) => {
        const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const w = norm(want);
        if (!w) return false;
        for (const old of document.querySelectorAll('[data-tbm-text-hit]')) old.removeAttribute('data-tbm-text-hit');
        const ACT = 'a[href], button, [role="button"], [role="link"], [role="option"], [role="tab"], [role="menuitem"], summary, label, [onclick]';
        let best = null;
        let bestLen = Infinity;
        for (const el of document.querySelectorAll(ACT)) {
          const t = norm(el.innerText);
          if (t.includes(w) && t.length < bestLen && el.getBoundingClientRect().width > 0) { best = el; bestLen = t.length; }
        }
        if (!best) return false;
        best.setAttribute('data-tbm-text-hit', '1');
        return true;
      }, String(text)).catch(() => false);
      if (hit) return { frame: f.frame, frameIdx: f.frameIdx, locator: f.frame.locator('[data-tbm-text-hit="1"]').first() };
    }
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

  const labelStr = action !== 'select' && typeof label === 'string' ? label.trim() : '';
  if (labelStr) {
    let fallback = null;
    for (const f of scopedFrames) {
      const allLoc = f.frame.getByLabel(labelStr);
      const picked = await pickBestLocator(allLoc, allowHidden);
      if (picked) {
        const res = { frame: f.frame, frameIdx: f.frameIdx, locator: picked.locator };
        if (picked.visible) return res;
        if (!fallback) fallback = res;
      }
    }
    if (fallback) return fallback;
    const q = labelStr.replace(/["\\\n]/g, (c) => (c === '\n' ? ' ' : '\\' + c));
    for (const attrSel of [`[placeholder="${q}" i]`, `[placeholder*="${q}" i]`, `[aria-label="${q}" i]`, `[aria-label*="${q}" i]`, `[title="${q}" i]`]) {
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
    throw new Error(`Label "${labelStr}" matched 0 elements across ${scopedFrames.length} frame(s).`);
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
// Highest ref number ever issued on a tab, kept in Node so it survives navigations (cross-origin included) and covers
// every frame: a new document starts numbering above it, so an old ref can only fail, never hit an unrelated element.
const pageRefHigh = new WeakMap();
const refWasIssued = (page, ref) => {
  const n = Number(/e(\d+)$/i.exec(String(ref))?.[1]);
  return Number.isFinite(n) && n <= (pageRefHigh.get(page) || 0);
};

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
  let nextRefNum = Math.max(store?.nextRefNum || 1, (pageRefHigh.get(page) || 0) + 1);
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
  const nextFingerprints = new Map();
  const fpMap = getPageRefFingerprints(page);
  const scannedFrames = new Set();
  const loadingFrames = [];
  let totalMatched = 0;
  const loaderState = await getPageLoaderState(page);
  if (loaderState) await syncFrameTree(loaderState);
  const mainLoaderId = loaderState ? (matchCdpFrame(loaderState, allFrames, 0)?.loaderId || '') : '';

  for (const frameInfo of frames) {
    let chunk;
    try {
      // One busy or hung frame must not hold the whole snapshot: give each frame 8 s.
      let capTimer;
      chunk = await Promise.race([frameInfo.frame.evaluate(
        ({ modeArg, frameIdxArg, startRef, rootSel, boxesArg, preserveRefsArg, queryArg }) => {
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

          let readBehindPopup = false;
          const isHidden = (el) => {
            if ((!readBehindPopup && isInert(el)) || isClosedDetailsOrCvHidden(el)) return true;
            if (!readBehindPopup && (el.getAttribute('aria-hidden') === 'true' || Boolean(el.closest('[aria-hidden="true"]')))) {
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

          const popups = queryAllDeep(document, '[role="listbox"], [role="menu"], [role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]')
            .filter((el) => !isHidden(el));
          readBehindPopup = Boolean(queryArg && popups.length);
          const inPopup = (el) => popups.some((popup) => {
            let cur = el;
            while (cur) {
              if (cur === popup) return true;
              cur = cur.parentElement || cur.getRootNode?.().host;
            }
            return false;
          });

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
                  if (n.hasAttribute?.('hidden') || (!readBehindPopup && n.getAttribute?.('aria-hidden') === 'true')) return '';
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
              let sib = up < 3 ? prevChild.previousElementSibling : null;
              // Skip non-visual siblings: a <script> before the field is code, not a label (the-internet /upload).
              while (sib && (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|BR|HR)$/.test(sib.tagName) || !sib.getClientRects().length)) sib = sib.previousElementSibling;
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
            if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && (!el.isContentEditable || tag === 'A' || el.getAttribute('role') === 'link')) {
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
              // Generated names/ids (UUIDs, long hex, React ":r6:") say nothing to the agent: look for the question text instead.
              if (v && (attr === 'name' || attr === 'id') && /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|:r[0-9a-z]+:)$/i.test(v)) continue;
              if (v) return v.slice(0, 80);
            }

            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
              // Nearest ancestor (up to 4 levels) whose own text, minus the field's value, reads like a short question.
              const own = clean(el.value || '');
              for (let cur = el.parentElement, i = 0; cur && i < 4; cur = cur.parentElement, i++) {
                let txt = clean(cur.innerText || '').replace(/[​]/g, '').trim();
                if (own) txt = clean(txt.split(own).join(' '));
                if (txt && /[\p{L}]/u.test(txt) && txt.length <= 160) return txt.replace(/\s*[*＊]+$/, '').slice(0, 80);
                if (txt.length > 160) break;
              }
            }

            if (fallbackVis) return fallbackVis.slice(0, 80);

            return (
              composedText(el) ||
              clean(el.innerText || el.textContent || el.shadowRoot?.innerText || el.shadowRoot?.textContent)
            ).slice(0, 80);
          };

          const selectorByMode = {
            interactive:
              'a[href], button, input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="textbox"], [role="combobox"], [aria-haspopup="listbox"], [role="radio"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], summary',
            forms:
              'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [aria-haspopup="listbox"], [role="radio"], [role="checkbox"], [role="switch"], button, [role="button"], [role="option"]',
            article: 'h1, h2, h3, h4, p, li, a[href], button',
            all: 'h1, h2, h3, a[href], button, input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="textbox"], [role="combobox"], [aria-haspopup="listbox"], [role="radio"], [role="checkbox"], [role="switch"], p',
          };

          const sel = (selectorByMode[modeArg] || selectorByMode.interactive) + (queryArg ? ', [role="row"]' : '');
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
          let nodes = rawNodes.filter((el) => !isHidden(el));
          // A modal dialog (aria-modal or a showModal()'d <dialog>) is open: the page behind it cannot be used, list only the dialog.
          if (!queryArg && (modeArg === 'interactive' || modeArg === 'forms')) {
            const modals = queryAllDeep(root, '[aria-modal="true"], dialog[open]')
              .filter((d) => !isHidden(d) && (d.getAttribute('aria-modal') === 'true' || d.matches(':modal')));
            if (modals.length > 0) {
              const inModal = nodes.filter((el) => modals.some((d) => d === el || d.contains(el) || (el.getRootNode?.() instanceof ShadowRoot && d.contains(el.getRootNode().host))));
              if (inModal.length > 0) nodes = inModal;
            }
          }

          // Keep in sync with computeElementFingerprintInBrowser (round22 tests guard all copies).
          const fingerprintOf = (el) => {
            if (!el || el.nodeType !== 1) return null;
            function identityOf(node) {
              const tag = (node.tagName || '').toLowerCase();
              const ce = node.getAttribute?.('contenteditable');
              const role = (node.getAttribute?.('role') || '').trim().toLowerCase();
              const isValueControl = tag === 'input' || tag === 'textarea' || tag === 'select' ||
                node.isContentEditable ||
                (ce !== null && ce !== undefined && String(ce).toLowerCase() !== 'false') ||
                role === 'textbox' || role === 'combobox' || role === 'slider' || role === 'spinbutton';
              if (!isValueControl) return null;
              const label = node.labels?.[0];
              const root = node.getRootNode();
              const labelText = label ? label.textContent : (node.getAttribute('aria-labelledby') || '')
                .split(/\s+/).filter(Boolean).map((id) => root.getElementById?.(id)?.textContent || '').join(' ');
              // Remove separators and mask live counters; values and checked state are never identity.
              const part = (s) => String(s || '').replace(/\u0000/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64);
              const mask = (s) => String(s || '').replace(/\d+/g, '#');
              // Hydration may expand [f] to [alt-shift-f]; only strip hints for this control's accesskey.
              const accessKeys = (node.getAttribute('accesskey') || '').toLowerCase().split(/\s+/).filter(Boolean);
              const title = (node.getAttribute('title') || '').replace(/\s*\[([^\[\]]+)\]\s*$/, (suffix, hint) => {
                const key = hint.toLowerCase().replace(/^(?:(?:alt|ctrl|control|shift|meta|cmd|command|option)[+-])+/, '');
                return accessKeys.includes(key) ? '' : suffix;
              });
              return [tag, tag === 'input' ? (node.getAttribute('type') || '').toLowerCase() : '',
                node.getAttribute('name'), node.getAttribute('id'), mask(node.getAttribute('aria-label')),
                mask(node.getAttribute('placeholder')), node.getAttribute('role'), mask(title),
                mask(labelText)].map(part).join('\u0000');
            }
            const identity = identityOf(el);
            if (identity !== null) {
              // Only matching controls count, within the nearest ancestor containing a clone.
              // parentNode includes ShadowRoot, keeping controls in the same DOM tree together.
              const tag = el.tagName.toLowerCase();
              // One pass over this DOM tree with cheap attribute checks first: a form with hundreds of fields stays fast.
              const same = (node, attr) => node.getAttribute(attr) === el.getAttribute(attr);
              const treeRoot = el.getRootNode();
              const clones = treeRoot.querySelectorAll ? Array.from(treeRoot.querySelectorAll(tag)).filter((node) => node === el ||
                (same(node, 'name') && same(node, 'id') && same(node, 'type') && same(node, 'role') && identityOf(node) === identity)) : [];
              function ownerOf(node) {
                if (!node) return '';
                const map = window.__tbmOwners || (window.__tbmOwners = new WeakMap());
                let id = map.get(node);
                if (!id) map.set(node, id = (window.__tbmOwnerSeq = (window.__tbmOwnerSeq || 0) + 1));
                return id;
              }
              const group = el.closest?.('fieldset, tr, [role="group"], [role="row"], [role="listitem"]');
              if (clones.length > 1) {
                for (let container = el.parentNode; container; container = container.parentNode) {
                  const inside = clones.filter((node) => container.contains(node));
                  if (inside.length > 1) {
                    const owner = group || container.tagName !== 'FORM' ? `\u0000#owner:${ownerOf(group)}:${ownerOf(container)}` : '';
                    return '#id:' + identity + owner + '\u0000#index:' + inside.indexOf(el) + '/' + inside.length;
                  }
                }
              }
              const owner = group ? `\u0000#owner:${ownerOf(group)}:` : '';
              return '#id:' + identity + owner;
            }
            return '#text:' + String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 128);
          };

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
                const line = `[${fullRef}] <${tag}> ${txt}${readBehindPopup && !inPopup(el) ? ' [behind popup]' : ''}`;
                items.push({ ref: fullRef, line, sig: `f${frameIdxArg}:<${tag}>:${txt}`, fp: fingerprintOf(el) });
              }
              continue;
            }

            const role = el.getAttribute('role');
            const hasListboxPopup = (el.getAttribute('aria-haspopup') || '').toLowerCase() === 'listbox';
            const type = el.getAttribute('type') || '';
            const isComboInput =
              tag === 'input' && (role === 'combobox' || hasListboxPopup || Boolean(el.getAttribute('aria-autocomplete')));
            const kind = isComboInput
              ? 'input:combobox'
              : tag === 'input'
              ? `input:${type || 'text'}`
              : el.isContentEditable && tag !== 'a' && role !== 'link'
                ? `${tag}:editable`
                : role
                  ? `${tag}:${role}`
                  : hasListboxPopup
                    ? `${tag}:combobox`
                    : tag;

            const rowText = role === 'row' ? (clean(el.getAttribute('aria-label')) || composedText(el)) : '';
            let lbl = rowText ? rowText.slice(0, 220) : labelFor(el);
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
            let extra = readBehindPopup && !inPopup(el) ? ' [behind popup]' : '';
            if (tag === 'input' || tag === 'textarea' || tag === 'select') {
              if (type === 'checkbox' || type === 'radio') {
                extra += el.checked ? ' [checked]' : '';
              } else if (type === 'file') {
                if (el.files && el.files.length > 0) {
                  const names = Array.from(el.files, (f) => f?.name || '').filter(Boolean);
                  if (names.length > 0) {
                    const fileSummary = names.length === 1 ? names[0] : `${names.length} files: ${names.join(', ')}`;
                    extra += ` val="${clean(fileSummary).slice(0, 60)}"`;
                  }
                }
                const style = getComputedStyle(el);
                if (style.display === 'none' || Number(style.opacity) === 0) extra += ' [hidden-file]';
              } else if (el.value) {
                extra += ` val="${clean(el.value).slice(0, 40)}"`;
              }
            } else if (role === 'combobox' || hasListboxPopup) {
              const comboTxt = composedText(el) || clean(el.innerText || el.textContent);
              if (comboTxt && comboTxt.toLowerCase() !== (lbl || '').toLowerCase()) {
                extra += ` val="${comboTxt.slice(0, 40)}"`;
              }
            } else if (role === 'checkbox' || role === 'radio' || role === 'switch') {
              if (el.getAttribute('aria-checked') === 'true') extra += ' [checked]';
            } else if (el.isContentEditable && tag !== 'a' && role !== 'link') {
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
            items.push({ ref: fullRef, line, sig, fp: fingerprintOf(el), rowText });
          }
          try {
            Object.defineProperty(window, '__tbmRefHigh', { value: refCounter - 1, writable: true, configurable: true, enumerable: false });
          } catch {}
          return { items, nextRef: refCounter, total: items.length, readyState: document.readyState, blank: location.href === 'about:blank' };
        },
        {
          modeArg: mode,
          frameIdxArg: frameInfo.frameIdx,
          startRef: nextRefNum,
          rootSel: rootSelector,
          boxesArg: boxes,
          preserveRefsArg: preserveRefs,
          queryArg: query,
        }
      ), new Promise((_, rej) => { capTimer = setTimeout(() => rej(new Error('frame snapshot timed out')), 8000); })]).finally(() => clearTimeout(capTimer));
    } catch (err) {
      if (/timed out/.test(String(err?.message))) entries.push(`(frame f${frameInfo.frameIdx} skipped: no answer within 8 s)`);
      continue;
    }

    if (!chunk) continue;
    // An empty iframe that is still loading (lazy embeds such as MDN's live examples) is reported so the agent waits.
    if (!frameInfo.isMain && chunk.total === 0 && (chunk.readyState !== 'complete' || chunk.blank)) loadingFrames.push(`f${frameInfo.frameIdx}`);
    scannedFrames.add(`f${frameInfo.frameIdx}`);
    nextRefNum = chunk.nextRef;
    pageRefHigh.set(page, Math.max(pageRefHigh.get(page) || 0, chunk.nextRef - 1));
    totalMatched += chunk.total;
    const cdpFrame = loaderState ? matchCdpFrame(loaderState, allFrames, frameInfo.frameIdx) : null;
    const frameStamp = cdpFrame?.loaderId
      ? { frameIdx: frameInfo.frameIdx, frameId: cdpFrame.id, loaderId: cdpFrame.loaderId, mainLoaderId }
      : null;

    const frameItems = [];
    for (const item of chunk.items) {
      item.line = redactUrlParams(item.line);
      item.sig = redactUrlParams(item.sig);
      const refLower = item.ref.toLowerCase();
      const bareLower = refLower.split(':')[1];
      if (frameStamp) {
        loaderState.refs.set(refLower, frameStamp);
        if (bareLower) loaderState.refs.set(bareLower, frameStamp);
      }
      if (!fpMap.has(refLower)) {
        fpMap.set(refLower, item.fp);
        if (bareLower) fpMap.set(bareLower, item.fp);
      }
      nextFingerprints.set(item.ref, item.fp);
      nextSignatures.add(item.sig);
      nextRefs.set(item.ref, item.sig);
      if (queryRe && !queryRe.test(item.line) && !(item.rowText && queryRe.test(item.rowText))) continue;
      if (onlyChanged && sameScope) {
        if (!baseline.refs.has(item.ref)) {
          frameItems.push(`*${item.line}`); // new since the last snapshot
          continue;
        }
        // An unchanged submit-like control stays visible so the model knows it exists.
        const fpSame = !fpMap.has(refLower) || fpMap.get(refLower) === item.fp;
        if (baseline.refs.get(item.ref) === item.sig && fpSame && !isSubmitLikeLine(item.line)) continue;
      }
      frameItems.push(item.line);
    }

    if (!frameInfo.isMain && frameItems.length > 0) {
      entries.push(`--- iframe f${frameInfo.frameIdx} (${redactUrlParams(frameInfo.url).slice(0, 80)}) ---`);
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

  const filterNote = `${query ? ` | Query: "${query}"` : ''}${onlyChanged ? ' | Delta: true' : ''}${loadingFrames.length ? ` | Loading frames: ${loadingFrames.slice(0, 8).join(',')} (inspect again shortly)` : ''}`;
  const urlChangedNote = onlyChanged && hadBaseline && !sameUrlAsBaseline
    ? 'URL changed: full snapshot\n'
    : onlyChanged && !baseline
      ? 'No earlier full snapshot (a query or selector snapshot is not kept as baseline): listing everything\n'
      : '';
  const popupNote = (await popupOpenIn(allFrames[0].frame)) ? `Note: ${POPUP_NOTE}\n` : '';
  const safePageUrl = redactUrlParams(page.url());
  const header = `URL: ${safePageUrl}\nTitle: ${title}\nMode: ${mode} | Frames: ${frames.length} | Elements: ${totalMatched}${filterNote}\n${urlChangedNote}${popupNote}`;
  let body = '';
  let shownCount = 0;
  let truncated = false;
  const trailerReserve = 64;

  const reportedRefs = new Set();
  for (const line of entries) {
    const candidate = body ? `${body}\n${line}` : line;
    if (header.length + candidate.length + trailerReserve + (removedLine ? removedLine.length + 1 : 0) > maxChars) {
      truncated = true;
      break;
    }
    body = candidate;
    const mRef = /^\*?\[(f\d+:e\d+)\]/.exec(line);
    if (mRef) {
      shownCount++;
      reportedRefs.add(mRef[1]);
    }
  }
  if (options.savePath) {
    for (const line of entries) {
      const mRef = /^\*?\[(f\d+:e\d+)\]/.exec(line);
      if (mRef) reportedRefs.add(mRef[1]);
    }
  }
  for (const ref of reportedRefs) {
    if (nextFingerprints.has(ref)) {
      const fp = nextFingerprints.get(ref);
      const refLower = ref.toLowerCase();
      const bareLower = refLower.split(':')[1];
      fpMap.set(refLower, fp);
      if (bareLower) fpMap.set(bareLower, fp);
    }
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
    url: safePageUrl,
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

// Rich text editors that ignore programmatic edits: replace the content with real key events (select all, delete,
// text, Enter between lines = one paragraph each), then check the text by lines. Returns true when it took.
async function fillEditorByKeys(page, frame, idx, val) {
  const lines = (t) => String(t).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const want = String(val).replace(/\r\n?/g, '\n');
  try {
    const loc = frame.locator('[data-tbm-fill="' + idx + '"]').first();
    await loc.focus({ timeout: 1500 });
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    const parts = want.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) await page.keyboard.press('Enter');
      if (parts[i]) await page.keyboard.insertText(parts[i]);
    }
    await new Promise((r) => setTimeout(r, 80));
    const got = await loc.evaluate((el) => el.innerText).catch(() => '');
    return lines(got).join('|') === lines(want).join('|');
  } catch {
    return false;
  }
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
// Date pickers and masked inputs often clear or reformat a value only when the field loses focus, after the fill
// already looked fine. Blur the focused field, wait one beat and compare. Returns a flag object or null.
const BLUR_SETTLE_MS = 60;
const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
function blurFlag(want, now) {
  if (norm(want) === '' || norm(now) === norm(want)) return null;
  // Reported fill values are cut at 60 chars; the live field holds the full text, so a prefix match is a match.
  if (String(want).length >= 60 && norm(now).startsWith(norm(want))) return null;
  return norm(now) === '' ? { clearedAfterBlur: true } : { changedAfterBlur: String(now).slice(0, 60) };
}
async function blurAndRead(frame, idxs) {
  return frame
    .evaluate(
      async ({ idxs: ids, settle }) => {
        const ae = document.activeElement;
        const leave = (el, ae) => {
          if (ae && ae !== document.body && typeof ae.blur === 'function') ae.blur();
          const hay = [el.name, el.id, el.className, el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('data-provide'), el.parentElement && el.parentElement.className, el.closest('[class*=date],[class*=picker],[class*=calendar]') ? 'date' : '']
            .map((x) => (typeof x === 'string' ? x : '')).join(' ');
          // Date pickers commit or clear on an outside mousedown, not on blur: send one to the body.
          if (/date|picker|calendar|ngày/i.test(hay)) {
            for (const t of ['mousedown', 'mouseup', 'click']) document.body.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, clientX: 1, clientY: 1 }));
          }
        };
        const els = {};
        for (const id of ids) els[id] = document.querySelector('[data-tbm-fill="' + id + '"]');
        for (const id of ids) if (els[id]) leave(els[id], els[id] === ae ? ae : null);
        if (ae && !ids.some((id) => els[id] === ae) && ae !== document.body && typeof ae.blur === 'function') ae.blur();
        await new Promise((r) => setTimeout(r, settle));
        const out = {};
        for (const id of ids) {
          const el = els[id];
          if (el) out[id] = String(el.isContentEditable ? el.innerText : el.value ?? '');
        }
        return out;
      },
      { idxs, settle: BLUR_SETTLE_MS }
    )
    .catch(() => null);
}
// One retry: type slowly with real key presses, then leave the field with Tab (Escape first on the second try).
async function retypeSlowly(page, locator, val) {
  for (const extra of [[], ['Escape']]) {
    try {
      await locator.focus({ timeout: 1500 });
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.type(val, { delay: 25 });
      for (const k of extra) await page.keyboard.press(k);
      await page.keyboard.press('Tab');
      await new Promise((r) => setTimeout(r, BLUR_SETTLE_MS));
      const back = await locator.evaluate((el) => String(el.isContentEditable ? el.innerText : el.value ?? '')).catch(() => '');
      if (norm(back) !== '') return back;
    } catch {
      return '';
    }
  }
  return '';
}
async function verifyAfterBlur(page, filled) {
  const fills = filled.filter((e) => e && e.value !== undefined && e.value !== '' && ['input', 'textarea', 'contenteditable'].includes(e.tag));
  if (fills.length === 0) return;
  const frames = getAllFrames(page);
  for (const fi of new Set(fills.map((e) => e.frameIdx))) {
    const frame = frames.find((f) => f.frameIdx === fi)?.frame;
    if (!frame) continue;
    const group = fills.filter((e) => e.frameIdx === fi);
    const vals = await blurAndRead(frame, group.map((e) => String(e.idx)));
    if (!vals) continue;
    for (const e of group) {
      const now = vals[String(e.idx)];
      if (now === undefined) continue;
      const flag = blurFlag(e.value, now);
      if (!flag) continue;
      if (flag.clearedAfterBlur && !/[\r\n]/.test(e.value) && String(e.value).length < 60) {
        const loc = frame.locator('[data-tbm-fill="' + e.idx + '"]').first();
        const back = await retypeSlowly(page, loc, e.value);
        if (norm(back) !== '') {
          e.retyped = true;
          e.value = back.slice(0, 60);
          if (norm(back) !== norm(e.value)) Object.assign(e, { value: back.slice(0, 60) });
          continue;
        }
      }
      Object.assign(e, flag);
    }
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

// An open popup (select listbox, menu, modal) that marks the rest of the page aria-hidden: snapshots and fills skip
// every control behind it. Cheap probe on one frame; false on any error.
const POPUP_NOTE = 'a popup is open and hides the rest of the page: pick an option or press Escape';
function popupOpenIn(frame) {
  return frame.evaluate(() => {
    if ([...document.querySelectorAll('[aria-modal="true"], dialog[open]')]
      .some((e) => !e.closest('[aria-hidden="true"]') && e.getBoundingClientRect().width > 0 &&
        (e.getAttribute('aria-modal') === 'true' || e.matches(':modal')))) return true;
    if (![...document.body.children].some((c) => c.getAttribute('aria-hidden') === 'true' && c.tagName !== 'SCRIPT')) return false;
    return [...document.querySelectorAll('[role="listbox"], [role="menu"], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')]
      .some((e) => !e.closest('[aria-hidden="true"]') && e.getBoundingClientRect().width > 0);
  }).catch(() => false);
}

// A ref that no longer exists but was in an earlier snapshot: the page re-rendered. Name the live ref with the same
// label when there is one. Returns '' when the ref was never in a snapshot (typo: keep plain not-found).
async function staleRefHint(frames, ref, previousLinesSet) {
  const m = /^(?:f(\d+):)?(e\d+)$/i.exec(String(ref).trim());
  const store = previousLinesSet ? snapshotBaselines.get(previousLinesSet) : null;
  if (!m || !store) return '';
  let label = null;
  for (const { refs } of store.byMode.values()) {
    for (const [r, sig] of refs) {
      if (r.split(':')[1] !== m[2] || (m[1] !== undefined && r.split(':')[0] !== `f${m[1]}`)) continue;
      const lm = /^f\d+:<[^>]*> "([^"]*)"/.exec(sig);
      label = lm ? lm[1].split(' | ')[0] : '';
    }
  }
  // The element is still in the page, just not usable: a modal popup hiding it is not "stale".
  for (const f of frames) {
    const live = await f.frame.evaluate((id) => Boolean(document.querySelector('[data-tbm-ref="' + id + '"]')), m[2]).catch(() => false);
    if (live) return { reason: 'hidden', hint: (await popupOpenIn(f.frame)) ? POPUP_NOTE : 'ref exists but is hidden or disabled' };
  }
  if (label === null) return '';
  let now = '';
  if (label) {
    for (const f of frames) {
      const id = await f.frame.evaluate((want) => {
        const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const w = clean(want);
        const stack = [document];
        while (stack.length) {
          const root = stack.shift();
          for (const el of root.querySelectorAll('[data-tbm-ref]')) {
            const labs = [el.getAttribute('aria-label'), el.placeholder, el.getAttribute('name'), el.value, ...[...(el.labels || [])].map((l) => l.textContent), el.innerText];
            if (labs.some((x) => clean(x).slice(0, 80) === w.slice(0, 80))) return el.getAttribute('data-tbm-ref');
          }
          for (const n of root.querySelectorAll('*')) if (n.shadowRoot) stack.push(n.shadowRoot);
        }
        return '';
      }, label).catch(() => '');
      if (id) { now = `f${f.frameIdx}:${id}`; break; }
    }
  }
  return { reason: 'stale-ref', hint: `ref from an older snapshot, page re-rendered; ${now ? `same label now ${now}` : `re-inspect${label ? ` (was "${label.slice(0, 30)}")` : ''}`}` };
}

export async function smartFillForm(page, spec = {}, previousLinesSet = null) {
  const t0 = Date.now();
  const frames = getAllFrames(page);
  const overwrite = Boolean(spec.overwrite);
  const fields = Array.isArray(spec.fields) ? spec.fields : [];
  for (const f of fields) {
    if (f?.ref) await assertCurrentDocumentRef(page, f.ref, frames);
  }
  const fpMap = pageRefFingerprints.get(page);
  const fpObj = fpMap ? Object.fromEntries(fpMap) : {};
  const fpNotes = [];

  const fileFields = [];
  const domFields = [];
  const filled = [];
  const skipped = [];
  fields.forEach((f, idx) => {
    if (!f) return;
    // Agents often write {label|name: "Email"} instead of {keys}: treat it as keys when no other target is given.
    if (!f.keys && !f.ref && !f.selector) {
      const alias = typeof f.label === 'string' && f.label ? f.label : typeof f.name === 'string' && f.name ? f.name : '';
      if (alias) f = { ...f, keys: alias };
    }
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
          async ({ domSpec, mainVal, gmailSpec, overwriteFlag, stopBeforeSubmitFlag, frameIdxArg, qBlockSel, submitSel, fpMapArg }) => {
            const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
            const getSR = (node) => node?.shadowRoot || window.__tbmGetShadowRoot?.(node) || null;
            // Keep in sync with computeElementFingerprintInBrowser (round22 tests guard all copies).
            const fingerprintOf = (el) => {
              if (!el || el.nodeType !== 1) return null;
              function identityOf(node) {
                const tag = (node.tagName || '').toLowerCase();
                const ce = node.getAttribute?.('contenteditable');
                const role = (node.getAttribute?.('role') || '').trim().toLowerCase();
                const isValueControl = tag === 'input' || tag === 'textarea' || tag === 'select' ||
                  node.isContentEditable ||
                  (ce !== null && ce !== undefined && String(ce).toLowerCase() !== 'false') ||
                  role === 'textbox' || role === 'combobox' || role === 'slider' || role === 'spinbutton';
                if (!isValueControl) return null;
                const label = node.labels?.[0];
                const root = node.getRootNode();
                const labelText = label ? label.textContent : (node.getAttribute('aria-labelledby') || '')
                  .split(/\s+/).filter(Boolean).map((id) => root.getElementById?.(id)?.textContent || '').join(' ');
                // Remove separators and mask live counters; values and checked state are never identity.
                const part = (s) => String(s || '').replace(/\u0000/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64);
                const mask = (s) => String(s || '').replace(/\d+/g, '#');
                // Hydration may expand [f] to [alt-shift-f]; only strip hints for this control's accesskey.
                const accessKeys = (node.getAttribute('accesskey') || '').toLowerCase().split(/\s+/).filter(Boolean);
                const title = (node.getAttribute('title') || '').replace(/\s*\[([^\[\]]+)\]\s*$/, (suffix, hint) => {
                  const key = hint.toLowerCase().replace(/^(?:(?:alt|ctrl|control|shift|meta|cmd|command|option)[+-])+/, '');
                  return accessKeys.includes(key) ? '' : suffix;
                });
                return [tag, tag === 'input' ? (node.getAttribute('type') || '').toLowerCase() : '',
                  node.getAttribute('name'), node.getAttribute('id'), mask(node.getAttribute('aria-label')),
                  mask(node.getAttribute('placeholder')), node.getAttribute('role'), mask(title),
                  mask(labelText)].map(part).join('\u0000');
              }
              const identity = identityOf(el);
              if (identity !== null) {
                // Only matching controls count, within the nearest ancestor containing a clone.
                // parentNode includes ShadowRoot, keeping controls in the same DOM tree together.
                const tag = el.tagName.toLowerCase();
                // One pass over this DOM tree with cheap attribute checks first: a form with hundreds of fields stays fast.
                const same = (node, attr) => node.getAttribute(attr) === el.getAttribute(attr);
                const treeRoot = el.getRootNode();
                const clones = treeRoot.querySelectorAll ? Array.from(treeRoot.querySelectorAll(tag)).filter((node) => node === el ||
                  (same(node, 'name') && same(node, 'id') && same(node, 'type') && same(node, 'role') && identityOf(node) === identity)) : [];
                function ownerOf(node) {
                  if (!node) return '';
                  const map = window.__tbmOwners || (window.__tbmOwners = new WeakMap());
                  let id = map.get(node);
                  if (!id) map.set(node, id = (window.__tbmOwnerSeq = (window.__tbmOwnerSeq || 0) + 1));
                  return id;
                }
                const group = el.closest?.('fieldset, tr, [role="group"], [role="row"], [role="listitem"]');
                if (clones.length > 1) {
                  for (let container = el.parentNode; container; container = container.parentNode) {
                    const inside = clones.filter((node) => container.contains(node));
                    if (inside.length > 1) {
                      const owner = group || container.tagName !== 'FORM' ? `\u0000#owner:${ownerOf(group)}:${ownerOf(container)}` : '';
                      return '#id:' + identity + owner + '\u0000#index:' + inside.indexOf(el) + '/' + inside.length;
                    }
                  }
                }
                const owner = group ? `\u0000#owner:${ownerOf(group)}:` : '';
                return '#id:' + identity + owner;
              }
              return '#text:' + String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 128);
            };

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
              let sib = up < 3 ? prevChild.previousElementSibling : null;
              // Skip non-visual siblings: a <script> before the field is code, not a label (the-internet /upload).
              while (sib && (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|BR|HR)$/.test(sib.tagName) || !sib.getClientRects().length)) sib = sib.previousElementSibling;
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

          // Rich editors (Lexical, ProseMirror) own their DOM: replace the content through editing commands, one
          // paragraph per newline, wait for the editor to render, then check the text really is there line by line.
          const setEditable = async (el, val) => {
            el.focus();
            const want = String(val).replace(/\r\n?/g, '\n');
            const lines = (t) => String(t).split('\n').map(clean).filter(Boolean);
            try {
              window.getSelection().selectAllChildren(el);
              if (clean(el.innerText)) document.execCommand('delete', false);
              want.split('\n').forEach((line, i) => {
                if (i > 0) document.execCommand('insertParagraph', false);
                if (line) document.execCommand('insertText', false, line);
              });
            } catch { /* fall through to the check */ }
            await new Promise((r) => setTimeout(r, 40));
            let ok = lines(el.innerText).join('\n') === lines(want).join('\n');
            if (!ok && !clean(el.innerText).length && !el.querySelector('*')) {
              el.textContent = want;
              ok = lines(el.innerText).join('\n') === lines(want).join('\n');
            }
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.style.outline = '2px solid #E0461D';
            el.style.outlineOffset = '1px';
            return ok;
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
              ((el.getAttribute('role') || '').toLowerCase() === 'combobox' ||
                (el.getAttribute('aria-haspopup') || '').toLowerCase() === 'listbox') &&
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
          const fpUpdates = [];
          const splitFp = (fp) => {
            const at = fp.indexOf('\u0000#index:');
            if (at < 0) return { id: fp, cnt: 1, hasCnt: true };
            const tail = fp.slice(at + 8);
            const slash = tail.indexOf('/');
            return slash < 0
              ? { id: fp.slice(0, at), cnt: null, hasCnt: false }
              : { id: fp.slice(0, at), cnt: Number(tail.slice(slash + 1)), hasCnt: true };
          };

          for (const f of domSpec) {
            if (f.ref) {
              const m = /^(?:f(\d+):)?(e\d+)$/i.exec(f.ref.trim());
              if (m && (m[1] === undefined || Number(m[1]) === frameIdxArg)) {
                const refEl = queryAllDeep(document, `[data-tbm-ref="${m[2]}"]`)[0];
                if (refEl && fpMapArg) {
                  const refKey = f.ref.trim().toLowerCase();
                  const bareKey = m[2].toLowerCase();
                  const storedFp = Object.prototype.hasOwnProperty.call(fpMapArg, refKey)
                    ? fpMapArg[refKey]
                    : fpMapArg[bareKey];
                  if (typeof storedFp === 'string') {
                    const curFp = fingerprintOf(refEl);
                    if (typeof curFp === 'string' && curFp !== storedFp) {
                      const s = splitFp(storedFp);
                      const c = splitFp(curFp);
                      if (s.id !== c.id || (s.hasCnt && c.hasCnt && s.cnt === c.cnt)) {
                        return { frameFilled, frameSkipped, matchedIndexes, leftover: [], submits: [], fpError: f.ref, fpStored: storedFp, fpUpdates };
                      }
                      const note = s.hasCnt && c.hasCnt ? `clone group for ${f.ref.trim()} changed size (${s.cnt} -> ${c.cnt})` : '';
                      fpMapArg[refKey] = curFp;
                      fpMapArg[bareKey] = curFp;
                      fpMapArg[`f${frameIdxArg}:${bareKey}`] = curFp;
                      fpUpdates.push({ refKey, bareKey, frameIdx: frameIdxArg, curFp, note });
                      if (note) {
                        for (const peerEl of queryAllDeep(document, '[data-tbm-ref]')) {
                          if (peerEl === refEl) continue;
                          const pid = (peerEl.getAttribute('data-tbm-ref') || '').toLowerCase();
                          if (!pid) continue;
                          const pStored = fpMapArg[`f${frameIdxArg}:${pid}`] ?? fpMapArg[pid];
                          if (typeof pStored !== 'string') continue;
                          const ps = splitFp(pStored);
                          if (ps.id !== s.id || ps.cnt !== s.cnt) continue;
                          const pCur = fingerprintOf(peerEl);
                          if (typeof pCur === 'string') {
                            const pc = splitFp(pCur);
                            if (pc.id === s.id && pc.cnt === c.cnt) {
                              fpMapArg[pid] = pCur;
                              fpMapArg[`f${frameIdxArg}:${pid}`] = pCur;
                              fpUpdates.push({ refKey: `f${frameIdxArg}:${pid}`, bareKey: pid, frameIdx: frameIdxArg, curFp: pCur, note: '' });
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
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
                const PROMPT_RE = /^\s*(?:--|[-–—]\s*\S.*[-–—]\s*$|(?:please\s+)?(?:select|choose|pick)\b|open (?:this )?(?:select )?menu|chọn\b|vui lòng chọn|\.\.\.|…)/i;
                const isPlaceholderOpt = (o) => {
                  if (!o) return false;
                  if (o.value === '') return true;
                  if (o !== el.options[0]) return false;
                  const txt = clean(o.text || '');
                  return Boolean(o.disabled || o.hidden || PROMPT_RE.test(txt) || /(\.\.\.|…)\s*$/.test(txt));
                };
                const selPlaceholder = isPlaceholderOpt(selOpt);
                const isSelectAlreadyFilled = Boolean(
                  !selPlaceholder &&
                  (el.dataset.tbmSelectFilled === '1' ||
                  (selOpt && selOpt.value !== '' && !selOpt.disabled && (el.selectedIndex > 0 || selOpt.hasAttribute('selected'))))
                );
                if (isSelectAlreadyFilled && !overwriteFlag) {
                  claimed.add(el);
                  const reqRaw = f.values !== undefined ? f.values : (f.value ?? f.option);
                  const req = Array.isArray(reqRaw) ? (reqRaw.length === 1 ? reqRaw[0] : undefined) : reqRaw;
                  const curText = selOpt ? clean(selOpt.text || '') : '';
                  const same =
                    req === undefined ||
                    String(req) === '' ||
                    clean(String(req)).toLowerCase() === curText.toLowerCase() ||
                    (selOpt && String(req) === selOpt.value);
                  frameSkipped.push({
                    idx: f._idx,
                    frameIdx: frameIdxArg,
                    reason: same || !curText ? 'already-filled' : `already-filled (has ${curText.slice(0, 40)})`,
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
              // Only an identical value counts as already filled: a different requested value replaces the old one.
              const sameAsCur = f.value === undefined || clean(String(f.value)) === clean(cur);
              if (cur && !overwriteFlag && sameAsCur) {
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
              let editRejected = false;
              if (el.isContentEditable && strVal !== '') {
                editRejected = !(await setEditable(el, strVal));
                if (editRejected) {
                  // Editing commands did not take (editor inside a shadow root, or one that owns its DOM): the Node side retries with real key events.
                  try { el.setAttribute('data-tbm-fill', String(f._idx)); } catch { /* ignore */ }
                  frameSkipped.push({ idx: f._idx, frameIdx: frameIdxArg, reason: 'value-rejected-by-input', label: describe(el).slice(0, 50), _editor: 1, _val: strVal });
                  matchedIndexes.push(f._idx);
                  continue;
                }
              } else setNativeValue(el, strVal);
              let afterVal = currentValue(el);
              // A widget that empties the value on blur (date pickers) also empties it on our synthetic blur. If the
              // value sticks when set again without events, the input accepts it: keep it so the post-blur check can
              // report and retry instead of calling the value rejected.
              if (strVal !== '' && afterVal === '' && !el.isContentEditable && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
                const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                if (setter) setter.call(el, strVal);
                afterVal = currentValue(el);
              }
              if (
                editRejected ||
                (strVal !== '' && afterVal === '') ||
                (cur !== '' && clean(afterVal) === clean(cur) && clean(strVal) !== clean(cur))
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
                ...(cur && !overwriteFlag ? { replaced: true } : {}),
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

          return { frameFilled, frameSkipped, matchedIndexes, leftover, submits, fpUpdates };
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
            fpMapArg: fpObj,
          }
        )
      );
    } catch {
      continue;
    }

    if (!res) continue;
    if (Array.isArray(res.fpUpdates) && fpMap) {
      for (const u of res.fpUpdates) {
        fpMap.set(u.refKey, u.curFp);
        fpMap.set(u.bareKey, u.curFp);
        fpMap.set(`f${u.frameIdx}:${u.bareKey}`, u.curFp);
        fpObj[u.refKey] = u.curFp;
        fpObj[u.bareKey] = u.curFp;
        fpObj[`f${u.frameIdx}:${u.bareKey}`] = u.curFp;
        if (u.note && !fpNotes.includes(u.note)) fpNotes.push(u.note);
      }
    }
    if (res.fpError) {
      if (selectorHandlesToDispose.length > 0) {
        for (const h of selectorHandlesToDispose) await h.dispose().catch(() => {});
      }
      throw new Error(reusedRefMessage(res.fpError, res.fpStored));
    }
    filled.push(...res.frameFilled);
    for (const sk of res.frameSkipped) {
      if (!sk._editor) { skipped.push(sk); continue; }
      const { _editor, _val, ...rest } = sk;
      const ok = await fillEditorByKeys(page, frameInfo.frame, sk.idx, _val);
      if (ok) filled.push({ idx: sk.idx, frameIdx: sk.frameIdx, tag: 'contenteditable', label: sk.label, value: _val.slice(0, 60) });
      else skipped.push(rest);
    }
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

            const combos = queryAllDeep(document, '[role="combobox"], [aria-haspopup="listbox"]').filter((el) => {
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
              if (st.display === 'none' || st.visibility === 'hidden') return false;
              // react-select dummy/search inputs can have opacity 0 or 1px width inside a visible control wrapper.
              if (el.tagName === 'INPUT' && (Number(st.opacity) === 0 || r.width === 0 || r.height === 0)) {
                const ctrl = el.closest('[class*="control" i], [class*="select" i], [class*="combobox" i]');
                if (ctrl) {
                  const cr = ctrl.getBoundingClientRect();
                  const cst = getComputedStyle(ctrl);
                  return cst.display !== 'none' && cst.visibility !== 'hidden' && cr.width > 0 && cr.height > 0;
                }
              }
              return Number(st.opacity) !== 0 && r.width > 0 && r.height > 0;
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
              const ownLabels = el.labels && el.labels.length > 0
                ? [...el.labels].map((l) => composedText(l) || l.innerText).join(' ')
                : '';
              const nearComboLabel = (() => {
                const COMBO_FIELD_SEL =
                  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]):not([type="reset"]), textarea, select, [role="combobox"], [aria-haspopup="listbox"]';
                let cur = el;
                let prevChild = el;
                for (let up = 0; up < 4 && cur.parentElement; up++) {
                  cur = cur.parentElement;
                  let fields = 0;
                  try {
                    const all = [...cur.querySelectorAll(COMBO_FIELD_SEL)];
                    const hasComboRole = all.some((n) => (n.getAttribute('role') || '').toLowerCase() === 'combobox');
                    // Count a combobox wrapper, its inner input, and its companion listbox toggle button as one control.
                    fields = all.filter(
                      (n) =>
                        !(hasComboRole && n.tagName === 'BUTTON' && (n.getAttribute('aria-haspopup') || '').toLowerCase() === 'listbox' && (n.getAttribute('role') || '').toLowerCase() !== 'combobox') &&
                        !all.some((other) => other !== n && other.contains(n))
                    ).length;
                  } catch {}
                  if (fields > 1) break;
                  for (const c of cur.querySelectorAll('label, [class*="label" i]')) {
                    if (c.contains(el)) continue;
                    const forId = c.getAttribute?.('for');
                    if (forId && forId !== el.id && document.getElementById(forId) && !cur.contains(document.getElementById(forId))) continue;
                    const t = clean(c.innerText || c.textContent).replace(/\s*[*\uFF0A]+$/, '');
                    if (t && t.length <= 80 && /[\p{L}\p{N}]/u.test(t)) return t;
                  }
                  const sib = prevChild.previousElementSibling;
                  if (sib && !sib.matches(COMBO_FIELD_SEL) && !sib.querySelector(COMBO_FIELD_SEL)) {
                    const t = clean(sib.innerText || sib.textContent).replace(/\s*[*\uFF0A]+$/, '');
                    if (t && t.length <= 60 && /[\p{L}\p{N}]/u.test(t)) return t;
                  }
                  prevChild = cur;
                }
                return '';
              })();
              const prev = el.previousElementSibling;
              const prevTxt =
                prev && !prev.matches('button, input, select, textarea, a, [role="button"], [role="combobox"]')
                  ? (composedText(prev) || prev.innerText)
                  : '';
              const blk = closestComposed(el, '[class*="field"], [class*="Field"], .form-group, [role="listitem"], [class*="select" i], [class*="combobox" i], [class*="autocomplete" i]');
              let blkTxt = '';
              let blkLblTxt = '';
              if (blk) {
                const rawSibs = queryAllDeep(
                  blk,
                  'input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]):not([type="file"]), textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [aria-haspopup="listbox"]'
                );
                const siblings = rawSibs.filter((n) => !rawSibs.some((other) => other !== n && other.contains(n)));
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
                ownLabels,
                nearComboLabel,
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

        const clickWidgetSafely = async (loc, isComboTrigger = false) => {
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
            try {
              await loc.click({ timeout: isComboTrigger ? 1200 : 2500 });
            } catch (err) {
              if (!isComboTrigger) throw err;
              // In react-select / Headless UI / MUI, the inner <input role="combobox"> may be covered by a placeholder
              // or value container, or have a companion toggle button: click the control wrapper / toggle button and focus.
              await loc.evaluate((el) => {
                const ctrl =
                  el.closest?.('[class*="control" i], [role="combobox"], [class*="select" i], [class*="combobox" i], [class*="autocomplete" i]') ||
                  el.parentElement ||
                  el;
                const toggleBtn =
                  ctrl !== el && ctrl.querySelector?.('button[aria-haspopup="listbox"], button[aria-label*="open" i], [class*="indicator" i]');
                const target = toggleBtn || ctrl;
                for (const evt of ['mousedown', 'mouseup', 'click']) {
                  target.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }));
                }
                if (typeof el.focus === 'function') el.focus();
              });
            }
          });
        };

        const verifySelfInputCommit = async () => {
          return comboLoc
            .evaluate((el, wanted) => {
              const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
              const w = clean(wanted);
              if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return true;
              if (el.getAttribute('aria-expanded') === 'false') return true;
              const attrs = [el.getAttribute('data-value'), el.getAttribute('data-selected'), el.getAttribute('aria-valuetext')];
              if (attrs.some((v) => clean(v) === w)) return true;
              const doc = el.ownerDocument || document;
              const listId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
              const listEl = listId ? doc.getElementById(listId) : null;
              if (listId && (!listEl || listEl.hidden || getComputedStyle(listEl).display === 'none')) return true;
              const scope = el.form || doc;
              for (const h of scope.querySelectorAll('input[type="hidden"], input:not([role="combobox"])')) {
                if (h !== el && clean(h.value) === w) return true;
              }
              for (const opt of doc.querySelectorAll('[role="option"], [cmdk-item], [data-radix-collection-item], [class*="option" i]')) {
                if (
                  (opt.getAttribute('aria-selected') === 'true' ||
                    opt.getAttribute('data-state') === 'checked' ||
                    opt.getAttribute('data-selected') === 'true' ||
                    /\bselected\b/i.test(opt.className || '')) &&
                  clean(opt.textContent).includes(w)
                ) {
                  return true;
                }
              }
              const visibleOptions = [...doc.querySelectorAll('[role="option"], [cmdk-item], [data-radix-collection-item]')].filter((o) => {
                const r = o.getBoundingClientRect();
                const st = getComputedStyle(o);
                return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
              });
              return visibleOptions.length === 0;
            }, comboWanted)
            .catch(() => true);
        };

        const tryPickEnabledOption = async (requireCommitCheck = false) => {
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
                if (requireCommitCheck && !(await verifySelfInputCommit())) {
                  return { clicked: false, sawDisabledMatch, anyVisibleOption };
                }
                return { clicked: true, sawDisabledMatch, anyVisibleOption };
              }
            }

            // Fallback for custom portaled combobox items (cmdk, Radix collection items, react-select v3/v4, or ul[role=listbox] > li without role=option).
            const customMatch = await scope
              .evaluate((wanted) => {
                const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
                const wLower = clean(wanted).toLowerCase();
                if (!wLower) return { hit: false, anyVis: false, disabled: false };
                for (const old of document.querySelectorAll('[data-tbm-portal-opt]')) {
                  old.removeAttribute('data-tbm-portal-opt');
                }
                const CUSTOM_OPT_SEL =
                  '[cmdk-item], [data-radix-collection-item], [class*="react-select__option"], [class*="-option"]:not(select), [role="listbox"] > li, [role="listbox"] > button, [role="listbox"] > div[tabindex], [role="menu"] [role="menuitem"], [role="menu"] [role="menuitemradio"]';
                const nodes = [...document.querySelectorAll(CUSTOM_OPT_SEL)];
                let anyVis = false;
                let best = null;
                let bestTier = 0;
                let sawDis = false;
                for (const node of nodes) {
                  if (node.getAttribute('role') === 'combobox') continue;
                  const r = node.getBoundingClientRect();
                  const st = getComputedStyle(node);
                  if (r.width <= 0 || r.height <= 0 || st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) continue;
                  anyVis = true;
                  const txt = clean(node.innerText || node.textContent);
                  const val = clean(node.getAttribute('data-value') || '');
                  const tLower = txt.toLowerCase();
                  const vLower = val.toLowerCase();
                  let tier = 0;
                  if (tLower === wLower || vLower === wLower) tier = 3;
                  else if (tLower.startsWith(wLower) || vLower.startsWith(wLower)) tier = 2;
                  else if (tLower.includes(wLower) || vLower.includes(wLower)) tier = 1;
                  if (tier === 0) continue;
                  const dis = Boolean(
                    node.disabled ||
                    node.getAttribute('aria-disabled') === 'true' ||
                    node.getAttribute('data-disabled') === 'true' ||
                    node.hasAttribute('data-disabled') && node.getAttribute('data-disabled') !== 'false' ||
                    node.closest('[aria-disabled="true"]')
                  );
                  if (dis) {
                    sawDis = true;
                    continue;
                  }
                  if (tier > bestTier) {
                    bestTier = tier;
                    best = node;
                    if (tier === 3) break;
                  }
                }
                if (best) {
                  best.setAttribute('data-tbm-portal-opt', '1');
                  return { hit: true, anyVis: true, disabled: false };
                }
                return { hit: false, anyVis, disabled: sawDis };
              }, comboWanted)
              .catch(() => ({ hit: false, anyVis: false, disabled: false }));
            if (customMatch.anyVis) anyVisibleOption = true;
            if (customMatch.disabled) sawDisabledMatch = true;
            if (customMatch.hit) {
              const optLoc = scope.locator('[data-tbm-portal-opt="1"]').first();
              await clickWidgetSafely(optLoc);
              if (requireCommitCheck && !(await verifySelfInputCommit())) {
                return { clicked: false, sawDisabledMatch, anyVisibleOption };
              }
              return { clicked: true, sawDisabledMatch, anyVisibleOption };
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
            await clickWidgetSafely(comboLoc, true);
          }
        } else {
          await clickWidgetSafely(comboLoc, true);
        }

        // Wait briefly for options to appear; if a search input is already ready in the portal or trigger, move to typing quickly.
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
            if (attempt >= 2) {
              if (pollRes.anyVisibleOption) break;
              const hasSearchBoxReady = await comboLoc
                .evaluate((el) => {
                  const doc = el.ownerDocument || document;
                  if (el.matches?.('input, textarea') && !el.readOnly && !el.disabled) return true;
                  if (doc.activeElement && doc.activeElement !== el && doc.activeElement.matches?.('input, textarea')) return true;
                  return Boolean(doc.querySelector('[cmdk-input], [role="dialog"] input, [data-radix-popper-content-wrapper] input, [role="listbox"] input'));
                })
                .catch(() => false);
              if (hasSearchBoxReady) break;
            }
            await page.waitForTimeout(35);
          }
        }

        if (!clickedOption) {
          // Portaled searchable comboboxes (Radix/cmdk, MUI Autocomplete, Headless UI Combobox, react-select):
          // locate the search input in the portal, aria-controls container, combobox wrapper, or trigger itself,
          // type the filter query, and click the matching option in the portal.
          const searchHandle = await comboLoc
            .evaluateHandle((el) => {
              const isEditableInput = (n) => {
                if (!n || !n.matches?.('input:not([type]), input[type="text"], input[type="search"], input[role="combobox"], [cmdk-input], textarea')) {
                  return false;
                }
                if (n.readOnly || n.disabled || n.getAttribute('aria-disabled') === 'true') return false;
                const st = getComputedStyle(n);
                if (st.display === 'none' || st.visibility === 'hidden') return false;
                const r = n.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) {
                  const ctrl = n.closest('[class*="control" i], [class*="select" i], [class*="combobox" i]');
                  if (!ctrl) return false;
                  const cr = ctrl.getBoundingClientRect();
                  return cr.width > 0 && cr.height > 0;
                }
                return true;
              };
              const doc = el.ownerDocument || document;
              // 1. Focused search input inside the newly opened portal
              if (doc.activeElement && doc.activeElement !== el && isEditableInput(doc.activeElement)) {
                return doc.activeElement;
              }
              // 2. Input linked via aria-controls / aria-owns on el or its wrapper
              const ctrlSource = el.hasAttribute('aria-controls') || el.hasAttribute('aria-owns')
                ? el
                : el.closest?.('[aria-controls], [aria-owns]') || el.querySelector?.('[aria-controls], [aria-owns]');
              const id = ctrlSource ? (ctrlSource.getAttribute('aria-controls') || ctrlSource.getAttribute('aria-owns')) : '';
              let box = id ? doc.getElementById(id) : null;
              for (let up = 0; box && box !== doc.body && box.tagName !== 'FORM' && up < 4; up++, box = box.parentElement) {
                const input = [...box.querySelectorAll('input, textarea')].find((n) => n !== el && isEditableInput(n));
                if (input) return input;
              }
              // 3. Input inside el itself or its immediate combobox control wrapper (react-select, Headless UI, MUI)
              if (!el.matches?.('input, textarea')) {
                const innerInput = [...el.querySelectorAll('input, textarea')].find(isEditableInput);
                if (innerInput) return innerInput;
                const ctrlWrap = el.closest?.('[role="combobox"], [class*="select" i], [class*="combobox" i], [class*="autocomplete" i]');
                if (ctrlWrap) {
                  const wrapInput = [...ctrlWrap.querySelectorAll('input, textarea')].find(isEditableInput);
                  if (wrapInput) return wrapInput;
                }
              }
              // 4. Input inside any visible open portal / popover / dialog / listbox container
              const PORTAL_SEL =
                '[data-radix-popper-content-wrapper], [cmdk-root], [role="dialog"], [data-headlessui-state*="open" i], [class*="portal" i], [class*="popover" i], [class*="popper" i], [class*="dropdown" i], [class*="menu" i]';
              for (const portal of doc.querySelectorAll(PORTAL_SEL)) {
                if (portal.contains(el)) continue;
                const pr = portal.getBoundingClientRect();
                const pst = getComputedStyle(portal);
                if (pr.width <= 0 || pr.height <= 0 || pst.display === 'none' || pst.visibility === 'hidden') continue;
                const hasListOrCmdk = Boolean(
                  portal.querySelector('[role="listbox"], [role="option"], [cmdk-list], [cmdk-item], [cmdk-input], [data-radix-collection-item], [class*="option" i]')
                );
                if (!hasListOrCmdk) continue;
                const portalInput = [...portal.querySelectorAll('input, textarea')].find(isEditableInput);
                if (portalInput) return portalInput;
              }
              // 5. Any visible [cmdk-input] or search input adjacent to a visible [role="listbox"]
              for (const lb of doc.querySelectorAll('[role="listbox"], [cmdk-list]')) {
                const lr = lb.getBoundingClientRect();
                const lst = getComputedStyle(lb);
                if (lr.width <= 0 || lr.height <= 0 || lst.display === 'none' || lst.visibility === 'hidden') continue;
                let anc = lb.parentElement;
                for (let up = 0; anc && anc !== doc.body && anc.tagName !== 'FORM' && up < 3; up++, anc = anc.parentElement) {
                  const adjInput = [...anc.querySelectorAll('input, textarea')].find((n) => n !== el && isEditableInput(n));
                  if (adjInput) return adjInput;
                }
              }
              // 6. Trigger el itself is a searchable <input role="combobox"> (MUI Autocomplete, Headless UI, react-select)
              if (isEditableInput(el)) return el;
              return null;
            })
            .catch(() => null);
          const searchEl = searchHandle?.asElement?.() || null;
          if (searchEl) {
            const isSelfInput = await comboLoc.evaluate((el, s) => el === s, searchEl).catch(() => false);
            await searchEl.focus().catch(() => {});
            await searchEl.fill(comboWanted).catch(async () => {
              await searchEl.evaluate((inp, val) => {
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                if (setter) setter.call(inp, val);
                else inp.value = val;
                inp.dispatchEvent(new InputEvent('input', { bubbles: true, data: val, inputType: 'insertText' }));
                inp.dispatchEvent(new Event('change', { bubbles: true }));
              }, comboWanted).catch(() => {});
            });
            for (let attempt = 0; attempt < 18 && !clickedOption; attempt++) {
              const pollRes = await tryPickEnabledOption(isSelfInput);
              if (pollRes.clicked) {
                clickedOption = true;
                await comboLoc.evaluate((el) => el.removeAttribute('data-tbm-combo-open')).catch(() => {});
                break;
              }
              if (pollRes.sawDisabledMatch) {
                break;
              }
              // If .fill() did not trigger a keystroke-based filter after 3 polls, type with real key events once.
              if (attempt === 3) {
                await searchEl.focus().catch(() => {});
                await searchEl.evaluate((inp) => {
                  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                  if (setter) setter.call(inp, '');
                  else inp.value = '';
                  inp.dispatchEvent(new Event('input', { bubbles: true }));
                }).catch(() => {});
                await page.keyboard.type(comboWanted).catch(() => {});
              } else {
                await page.waitForTimeout(35);
              }
            }
          }
          await searchHandle?.dispose?.().catch(() => {});
        }

        if (!clickedOption) {
          // Scrollable virtualized listbox (e.g. react-window / MUI virtualized 200+ options mounted on scroll).
          const hasScrollableListbox = await page
            .evaluate(() => {
              for (const lb of document.querySelectorAll('[role="listbox"], [cmdk-list]')) {
                const r = lb.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) continue;
                const candidates = [lb, ...lb.querySelectorAll('*')];
                for (const c of candidates) {
                  if (c.scrollHeight > c.clientHeight + 16) return true;
                }
              }
              return false;
            })
            .catch(() => false);
          if (hasScrollableListbox) {
            for (let step = 0; step < 45 && !clickedOption; step++) {
              const moved = await page
                .evaluate(() => {
                  for (const lb of document.querySelectorAll('[role="listbox"], [cmdk-list]')) {
                    const r = lb.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0) continue;
                    const scroller = [lb, ...lb.querySelectorAll('*')].find((c) => c.scrollHeight > c.clientHeight + 16);
                    if (!scroller) continue;
                    const before = scroller.scrollTop;
                    scroller.scrollTop = before + Math.max(140, Math.floor(scroller.clientHeight * 0.9));
                    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
                    return scroller.scrollTop !== before;
                  }
                  return false;
                })
                .catch(() => false);
              await page.waitForTimeout(15);
              const pollRes = await tryPickEnabledOption();
              if (pollRes.clicked) {
                clickedOption = true;
                await comboLoc.evaluate((el) => el.removeAttribute('data-tbm-combo-open')).catch(() => {});
                break;
              }
              if (!moved) break;
            }
          }
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
    if (f.ref && !f.selector && !f.keys) {
      const info = await staleRefHint(frames, f.ref, previousLinesSet);
      if (info) { skipped.push({ idx: f._idx, reason: info.reason, hint: info.hint }); continue; }
    }
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
      if (target.note && !fpNotes.includes(target.note)) fpNotes.push(target.note);
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

  filled.sort((x, y) => (x?.idx ?? 1e9) - (y?.idx ?? 1e9));
  skipped.sort((x, y) => (x?.idx ?? 1e9) - (y?.idx ?? 1e9));
  if (!spec._noRecheck) await verifyAfterBlur(page, filled);

  const output = {
    filledCount: filled.length,
    filled,
    skipped,
    leftover: [...leftoverSet].slice(0, 12),
    stoppedBeforeSubmit: spec.stopBeforeSubmit !== false,
    submitButtons,
    ...(refilled > 0 ? { refilled } : {}),
    ...(fpNotes.length > 0 ? { note: fpNotes[0] } : {}),
    elapsedMs: Date.now() - t0,
  };

  if (spec.returnSnapshot) {
    const snap = await snapshotAfterAction(
      page,
      {
        mode: spec.snapshotMode || 'forms',
        maxChars: spec.snapshotMaxChars || 2500,
        query: spec.snapshotQuery,
        afterNavOrSubmit: spec.stopBeforeSubmit === false,
      },
      previousLinesSet
    );
    output.snapshot = snap.snapshot;
    if (snap.pageText) output.pageText = snap.pageText;
    output.elapsedMs = Date.now() - t0;
  }

  return output;
}

/**
 * Run inspectCompact after an action or tabs_batch; when in interactive mode (or 0 elements found)
 * and the page has 0 interactive elements (or < 2 buttons after navigation/submit), automatically
 * extract up to 800 chars of compact main/body text so receipt pages need no extra extract turn.
 */
export async function snapshotAfterAction(page, options = {}, previousLinesSet = null) {
  const mode = options.mode || 'interactive';
  const maxChars = options.maxChars || 2500;
  const query = options.query;
  const snap = await inspectCompact(page, { mode, maxChars, query }, previousLinesSet);
  const afterNavOrSubmit = options.afterNavOrSubmit !== false;
  let pageText = '';
  if ((mode === 'interactive' || snap.totalInteractive === 0) && !query) {
    let buttonCount = 0;
    for (const line of (snap.text || '').split('\n')) {
      const m = /^\*?\[f\d+:e\d+\] <([^>]+)> /.exec(line);
      if (m && /^(?:button(?::button)?|input:(?:submit|button|image)|[^>\s]+:button)$/i.test(m[1])) {
        buttonCount++;
      }
    }
    if (snap.totalInteractive === 0 || (mode === 'interactive' && afterNavOrSubmit && buttonCount < 2)) {
      const rawText = await page
        .evaluate(() => {
          const root = document.querySelector('main, article, [role="main"]') || document.body;
          if (!root) return '';
          return (root.innerText || root.textContent || '')
            .split('\n')
            .map((l) => l.replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .join('\n')
            .trim()
            .slice(0, 800);
        })
        .catch(() => '');
      if (rawText) {
        pageText = wrapPage(rawText);
        snap.text = `${snap.text.replace(/\s+$/, '')}\nPage text:\n${rawText}`;
      }
    }
  }
  return {
    ...snap,
    snapshot: wrapPage(snap.text),
    ...(pageText ? { pageText } : {}),
  };
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
 * Scroll-and-collect for virtualized feeds and multi-page lists/tables: reads matching elements (`selector`),
 * optionally scrolls `scrolls` times per page, optionally clicks a pagination control (`nextText` / `nextSelector`,
 * up to `maxPages` pages, stopping when Next disappears or is disabled), and returns deduplicated items.
 */
export async function collectItems(page, step = {}) {
  const selector = String(step.selector || '');
  if (!selector) throw new Error('collect requires selector.');
  const nextSelector = step.nextSelector ? String(step.nextSelector).trim() : '';
  const nextText = step.nextText ? String(step.nextText).trim() : '';
  const hasPagination = Boolean(nextSelector || nextText || Number(step.maxPages) > 1);
  const maxPages = hasPagination ? Math.min(50, Math.max(1, Number(step.maxPages) || 10)) : 1;
  const scrolls = Math.min(
    60,
    Math.max(0, Number.isFinite(Number(step.scrolls)) ? Number(step.scrolls) : hasPagination ? 0 : 5)
  );
  const waitMs = Math.min(5000, Math.max(0, Number.isFinite(Number(step.waitMs)) ? Number(step.waitMs) : 400));
  const maxItems = Math.min(2000, Math.max(1, Number(step.maxItems) || 100));
  const maxChars = Math.max(200, Number(step.maxChars) || 8000);
  const rawFields = Array.isArray(step.fields) ? step.fields.map((f) => String(f || '').trim()).filter(Boolean) : [];
  const tableJsonMode = step.format === 'table_json';
  const sub = String(step.itemSelector || step.textSelector || '');
  const t0 = Date.now();

  const seenKeys = new Set();
  const allItems = [];
  let totalChars = 0;
  let totalScrolls = 0;
  let full = false;
  let maxMatchedOnAnyPage = 0;
  let pagesVisited = 0;

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const pageRes = await page.evaluate(
      async ({
        sel,
        sub,
        scrolls: nScrolls,
        waitMs: wait,
        maxItems: cap,
        maxChars: charCap,
        fields: want,
        tableJson,
        seenArr,
        curCount,
        curChars,
      }) => {
        const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const parseCellVal = (raw) => {
          const s = clean(raw);
          if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s)) {
            const n = Number(s);
            if (Number.isFinite(n)) return n;
          }
          return s;
        };
        const tableHeadersFor = (tbl) => {
          if (!tbl) return [];
          const headRows = [...tbl.querySelectorAll('thead tr')];
          const hdrTr = headRows.length > 0 ? headRows[headRows.length - 1] : tbl.querySelector('tr');
          if (!hdrTr) return [];
          const cells = [...hdrTr.children].filter((c) => c.tagName === 'TH' || c.tagName === 'TD');
          if (headRows.length === 0 && !cells.some((c) => c.tagName === 'TH')) return [];
          return cells.map((c, idx) => clean(c.innerText || c.textContent) || `col${idx + 1}`);
        };
        const isBuiltInFieldsOnly =
          want.length > 0 && want.every((f) => f === 'text' || f === 'href' || f === 'id');
        const hash = (s) => {
          let h = 5381;
          for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) | 0;
          return `${s.length}:${h}`;
        };
        const seen = new Set(seenArr);
        const pageItems = [];
        const newKeys = [];
        let count = curCount;
        let chars = curChars;
        let isFull = false;
        let matched = 0;

        const addCandidate = (item, keyStr) => {
          if (isFull || !keyStr) return false;
          const key = hash(keyStr);
          if (seen.has(key)) return false;
          const size = typeof item === 'string' ? item.length : JSON.stringify(item).length;
          if (count >= cap || chars + size > charCap) {
            isFull = true;
            return false;
          }
          seen.add(key);
          newKeys.push(key);
          pageItems.push(item);
          count++;
          chars += size;
          return true;
        };

        const read = () => {
          let added = 0;
          const rawEls = [...document.querySelectorAll(sel)];
          const els = [];
          for (const el of rawEls) {
            if (el.tagName === 'TABLE') {
              const bodyRows = [...el.querySelectorAll('tbody tr')];
              if (bodyRows.length > 0) els.push(...bodyRows);
              else els.push(...[...el.querySelectorAll('tr')].filter((tr) => !tr.closest('thead, tfoot')));
            } else {
              els.push(el);
            }
          }
          matched = Math.max(matched, els.length);
          for (const el of els) {
            if (isFull) break;
            const isTableRow = el.tagName === 'TR';
            if (isTableRow && (tableJson || (want.length > 0 && !isBuiltInFieldsOnly))) {
              if (el.closest('thead, tfoot')) continue;
              const directCells = [...el.children].filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
              if (directCells.length === 0 || directCells.every((c) => c.tagName === 'TH')) continue;
              const tbl = el.closest('table');
              const headers = tableHeadersFor(tbl);
              const rowObj = {};
              directCells.forEach((cell, idx) => {
                const colName = headers[idx] || want[idx] || `col${idx + 1}`;
                rowObj[colName] = parseCellVal(cell.innerText || cell.textContent);
              });
              let outObj = rowObj;
              if (want.length > 0 && !tableJson) {
                outObj = {};
                for (const f of want) {
                  const hitKey = Object.keys(rowObj).find((k) => k.toLowerCase() === f.toLowerCase());
                  if (hitKey !== undefined) outObj[hitKey] = rowObj[hitKey];
                }
                if (Object.keys(outObj).length === 0) outObj = rowObj;
              }
              if (addCandidate(outObj, JSON.stringify(outObj))) added++;
              continue;
            }

            const tEl = sub ? el.querySelector(sub) : el;
            if (!tEl) continue;
            const text = (tEl.innerText || '')
              .replace(/[ \t]+/g, ' ')
              .replace(/\n\s*\n+/g, '\n')
              .trim()
              .slice(0, 1500);
            if (!text) continue;
            const keyStr = text.replace(/\s+/g, ' ').trim();
            let item = text;
            if (want.length) {
              item = {};
              for (const f of want) {
                if (f === 'text') item.text = text;
                else if (f === 'id') {
                  const v = el.id || el.getAttribute('data-id');
                  if (v) item.id = v;
                } else if (f === 'href') {
                  const own = sub ? tEl.closest('a[href]') : null;
                  const v = (own || (el.matches('a[href]') ? el : el.querySelector('a[href]')))?.href;
                  if (v) item.href = v;
                }
              }
              if (!Object.keys(item).length) item = text;
            }
            if (addCandidate(item, keyStr)) added++;
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

        let pageAdded = read();
        if (!matched) {
          for (let k = 0; k < 6 && !matched; k++) {
            await new Promise((res) => setTimeout(res, 150));
            pageAdded += read();
          }
        }
        let done = 0;
        let idle = 0;
        for (let i = 0; i < nScrolls && !isFull; i++) {
          const box = scroller();
          const before = box ? box.scrollTop : window.scrollY;
          const stepPx = Math.max(200, Math.floor((box ? box.clientHeight : window.innerHeight) * 0.9));
          if (box) box.scrollTop = before + stepPx;
          else window.scrollBy(0, stepPx);
          done++;
          await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
          await new Promise((res) => setTimeout(res, wait));
          const moved = (box ? box.scrollTop : window.scrollY) !== before;
          let added = read();
          if (moved && added === 0) {
            await new Promise((res) => setTimeout(res, Math.max(wait, 150)));
            added = read();
          }
          pageAdded += added;
          idle = added === 0 && !moved ? idle + 1 : added === 0 ? idle : 0;
          if (idle >= 1) break;
        }
        return {
          pageItems,
          newKeys,
          scrolls: done,
          full: isFull,
          matched,
          pageAdded,
          chars,
        };
      },
      {
        sel: selector,
        sub,
        scrolls,
        waitMs,
        maxItems,
        maxChars,
        fields: rawFields,
        tableJson: tableJsonMode,
        seenArr: [...seenKeys],
        curCount: allItems.length,
        curChars: totalChars,
      }
    );

    pagesVisited = pageNum;
    for (const k of pageRes.newKeys) seenKeys.add(k);
    allItems.push(...pageRes.pageItems);
    totalChars = pageRes.chars;
    totalScrolls += pageRes.scrolls;
    full = pageRes.full;
    maxMatchedOnAnyPage = Math.max(maxMatchedOnAnyPage, pageRes.matched);

    if (full || pageNum >= maxPages) break;

    // Locate and validate the Next pagination button/link.
    const hasNext = await page
      .evaluate(
        ({ nextSel, nextTxt, nextPageNum }) => {
          const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
          for (const old of document.querySelectorAll('[data-tbm-collect-next]')) {
            old.removeAttribute('data-tbm-collect-next');
          }
          const isVisible = (el) => {
            if (!el || el.nodeType !== 1) return false;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            const st = getComputedStyle(el);
            return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) !== 0;
          };
          const isDisabled = (el) => {
            let cur = el;
            for (let d = 0; cur && cur.nodeType === 1 && d < 4; d++, cur = cur.parentElement) {
              if (
                cur.disabled ||
                Boolean(cur.matches?.(':disabled')) ||
                cur.getAttribute('aria-disabled') === 'true' ||
                cur.hasAttribute('disabled') ||
                /\bdisabled\b/i.test(typeof cur.className === 'string' ? cur.className : '')
              ) {
                return true;
              }
            }
            const tag = (el.tagName || '').toUpperCase();
            if (tag === 'A') {
              const href = (el.getAttribute('href') || '').trim();
              if (!href && !el.hasAttribute('onclick') && el.getAttribute('role') !== 'button') {
                // Anchor without href or click handler is often an inactive pagination item
              }
            }
            return false;
          };

          if (nextSel) {
            const matches = [...document.querySelectorAll(nextSel)].filter(isVisible);
            const enabled = matches.find((el) => !isDisabled(el));
            if (!enabled) return false;
            enabled.setAttribute('data-tbm-collect-next', '1');
            return true;
          }

          const ACT_SEL =
            'a[href], button, input[type="button"], input[type="submit"], [role="button"], [role="link"], [onclick]';
          const candidates = [...document.querySelectorAll(ACT_SEL)].filter(isVisible);

          if (nextTxt) {
            const want = clean(nextTxt).toLowerCase();
            const scored = [];
            let sawAnyMatch = false;
            for (const el of candidates) {
              const labels = [
                clean(el.innerText || el.textContent),
                clean(el.getAttribute('aria-label')),
                clean(el.getAttribute('title')),
                clean(el.value),
              ].filter(Boolean);
              let tier = 0;
              for (const l of labels) {
                const ll = l.toLowerCase();
                if (ll === want) {
                  tier = 3;
                  break;
                }
                if (ll.startsWith(want) || ll.endsWith(want)) tier = Math.max(tier, 2);
                else if (ll.includes(want)) tier = Math.max(tier, 1);
              }
              if (tier > 0) {
                sawAnyMatch = true;
                if (!isDisabled(el)) scored.push({ el, tier });
              }
            }
            if (scored.length > 0) {
              scored.sort((a, b) => b.tier - a.tier);
              scored[0].el.setAttribute('data-tbm-collect-next', '1');
              return true;
            }
            // If a matching Next control exists on the page but is disabled, stop immediately.
            if (sawAnyMatch) return false;
          }

          // Fallback for numbered pagination links ("Page 2", "2", or ?page=2) when nextText is generic ("Next"/"Page") or maxPages > 1.
          if (!nextTxt || /^(next(\s+page)?|page|[>›»])$/i.test(clean(nextTxt))) {
            const wantPageLbl = `page ${nextPageNum}`;
            const wantNumStr = String(nextPageNum);
            const pageRe = new RegExp(`[?&]page=${nextPageNum}(?:[&#]|$)`, 'i');
            for (const el of candidates) {
              if (isDisabled(el)) continue;
              const txt = clean(el.innerText || el.textContent).toLowerCase();
              const aria = clean(el.getAttribute('aria-label')).toLowerCase();
              const href = el.getAttribute('href') || '';
              if (
                txt === wantPageLbl ||
                aria === wantPageLbl ||
                ((txt === wantNumStr || pageRe.test(href)) &&
                  Boolean(el.closest('nav, [role="navigation"], [class*="pag" i], ul, ol') || pageRe.test(href)))
              ) {
                el.setAttribute('data-tbm-collect-next', '1');
                return true;
              }
            }
          }

          return false;
        },
        { nextSel: nextSelector, nextTxt: nextText, nextPageNum: pageNum + 1 }
      )
      .catch(() => false);

    if (!hasNext) break;

    const urlBefore = page.url();
    const firstKeyBefore = pageRes.newKeys[0] || '';
    const navWatch = watchActionNavigation(page, DEFAULT_TIMEOUT_MS);
    const actWatch = watchActivity(page);
    try {
      const nextLoc = page.locator('[data-tbm-collect-next="1"]').first();
      await nextLoc.click({ timeout: 2500 });
      await navWatch.finish();
      await actWatch.settle({ minMs: Math.min(waitMs, 60), capMs: Math.max(waitMs, 800) });
    } catch {
      break;
    } finally {
      navWatch.remove();
      actWatch.remove();
    }

    // If neither URL changed nor any new items appeared on the previous page, guard against infinite loops on no-op buttons.
    if (pageNum > 1 && pageRes.pageAdded === 0 && page.url() === urlBefore && !firstKeyBefore) {
      break;
    }
  }

  const res = {
    ok: true,
    action: 'collect',
    count: allItems.length,
    scrolls: totalScrolls,
    ...(hasPagination ? { pages: pagesVisited } : {}),
    truncated: full,
    items: allItems,
    elapsedMs: Date.now() - t0,
  };
  if (!allItems.length) {
    res.note = maxMatchedOnAnyPage
      ? `${maxMatchedOnAnyPage} elements matched but none had text`
      : 'selector matched 0 elements';
  }
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

const activeLateMutating = new WeakMap();

async function executeSingleAction(page, rawParams = {}) {
  const allowSubmit = resolveAllowSubmit(rawParams.allowSubmit);
  const params = { ...rawParams, allowSubmit };
  if (params.ref) await assertCurrentDocumentRef(page, params.ref);
  if (params.targetRef) await assertCurrentDocumentRef(page, params.targetRef);
  const silentState = { count: 0, wantKind: false, clickKind: '', editorOpen: false };
  const enabled = params.observeAftermath ?? (process.env.TURBO_BROWSER_OBSERVE_AFTERMATH === 'true');
  const observer = enabled && ['click', 'dblclick'].includes(params.action) ? observeClickAftermath(page, () => silentState.clickKind) : null;
  const navigation = params.returnSnapshot && ['click', 'dblclick', 'press'].includes(params.action)
    ? watchActionNavigation(page, Number(params.timeoutMs) || DEFAULT_TIMEOUT_MS) : null;
  // A committing click/key gets the same settle step so a toast ("This domain isn't allowed.") can show up.
  const wantToast = ['click', 'dblclick', 'press'].includes(params.action);
  const toastWindow = wantToast && allowSubmit;
  // One shared settle step replaces fixed sleeps; listeners stay attached until it is done.
  const activity = observer || navigation || toastWindow ? watchActivity(page) : null;
  if (wantToast) await armToasts(page);
  const beforeApplyUrl = page.url();
  let openedTab = null, popupReady;
  const popup = new Promise((resolve) => { popupReady = resolve; });
  const onNewPage = (child) => { openedTab ||= child; popupReady(); };
  const watchPopup = ['click', 'dblclick', 'press'].includes(params.action);
  if (watchPopup) page.on('popup', onNewPage);
  let res;
  // Classifying the clicked element costs a round trip: only when the aftermath observer reports it.
  silentState.wantKind = Boolean(observer);
  // Second check behind the label/type/form heuristics: an icon-only button outside a form can still submit.
  // Mutating fetch/XHR requests started by a click are reported (never blocked); one that starts within ~800 ms
  // after the result is parked on the next tool result.
  const clickAction = ['click', 'dblclick'].includes(params.action);
  if (clickAction || allowSubmit) {
    activeLateMutating.get(page)?.();
    activeLateMutating.delete(page);
  }
  const mutating = [];
  let watchOpen = clickAction;
  let returned = false;
  let completed = false;
  let getNavigation = false;
  const onMutating = (request) => {
    if (request.isNavigationRequest?.() && request.frame() === page.mainFrame() && request.method() === 'GET') getNavigation = true;
    const rType = request.resourceType?.() || '';
    if (!watchOpen || !/^(POST|PUT|PATCH|DELETE)$/.test(request.method()) || !['fetch', 'xhr', 'document'].includes(rType)) return;
    let host = '';
    let reqPath = '';
    try { const u = new URL(request.url()); host = u.host; reqPath = u.pathname; } catch { return; }
    if (isBackgroundRequest(request, { pageUrl: page.url(), readNavigation: getNavigation })) return;
    // An allowed submit was the point of the click: the agent knows it submitted, no late warning.
    if (silentState.editorOpen) return;
    if (returned && params.allowSubmit === true) return;
    if (returned) parkLate(page, `possibleSubmit: ${request.method()} ${host}${reqPath.slice(0, 60)}`);
    else mutating.push({ method: request.method(), host });
  };
  // With observeAftermath the aftermath report already lists mutating requests (and parks late ones itself).
  if (clickAction && !observer) page.on('request', onMutating);
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
      if (watchPopup && params._registerPopup) {
        let timer;
        if (!openedTab) await Promise.race([popup, new Promise((resolve) => { timer = setTimeout(resolve, 150); })]);
        clearTimeout(timer);
        if (openedTab) res.newTab = params._registerPopup(openedTab);
      }
      if ((observer || navigation) && res && typeof res === 'object') res.outcome = activity.outcome();
      if (wantToast && res && typeof res === 'object') {
        const toast = await takeToast(page);
        if (toast) res.toast = toast;
      }
      // An SPA route change leaves no navigation event: say where the click ended up.
      if (['click', 'dblclick'].includes(params.action) && res && typeof res === 'object' && res.url === undefined && !res.outcome && page.url() !== beforeApplyUrl) {
        res.url = page.url();
      }
    }
    await observer?.finish(res, allowSubmit);
    if (res && res._applyLike) {
      if (!observer && !navigation) await new Promise((r) => setTimeout(r, 600));
      if (!openedTab && page.url() === beforeApplyUrl) {
        const links = await findOutboundApplyLinks(page);
        if (links.length) res.outboundLinks = links;
      }
    }
    completed = true;
  } finally {
    returned = true;
    if (clickAction) {
      const ok = completed && res && typeof res === 'object' && !res.blocked;
      if (silentState.editorOpen && res?.aftermath && !res.aftermath.navigated) {
        res.aftermath.unexpectedSubmit = false;
        delete res.aftermath.warning;
      }
      const seen = observer ? (res?.aftermath?.mutatingRequests || []).map((r) => ({ method: r.method, host: (() => { try { return new URL(r.url).host; } catch { return ''; } })() })) : mutating;
      if (ok && seen.length && params.allowSubmit !== true && !silentState.editorOpen) {
        res.possibleSubmit = true;
        res.request = `${seen[0].method} ${seen[0].host}`;
      }
      if (observer || !ok || params.allowSubmit === true || silentState.editorOpen) { watchOpen = false; page.off('request', onMutating); }
      else {
        const off = () => { watchOpen = false; page.off('request', onMutating); };
        const t = setTimeout(off, 800);
        t.unref?.();
        activeLateMutating.set(page, () => { clearTimeout(t); off(); });
      }
    }
    if (watchPopup) page.off('popup', onNewPage);
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
  if (silentState.note && res && typeof res === 'object' && !res.note) {
    res.note = silentState.note;
  }
  return res;
}

function waitTextNewScan([ns, k, init, fresh]) {
  // fresh: the document was just loaded by a navigation in this batch, so an empty baseline is the right one
  // (this also covers a baseline write that was lost to a process swap).
  if (fresh && !window[k]) {
    window[k] = new WeakMap();
    window[k + 't'] = '';
  }
  const seen = init ? (window[k] = new WeakMap()) : window[k];
  if (!seen) return '';
  if (init) window[k + 't'] = document.title;
  // The page title counts too: text such as "Example Domain" can live only in <title>.
  const title = (document.title || '').toLowerCase();
  if (!init && title && document.title !== window[k + 't']) {
    const th = ns.find((x) => title.includes(x));
    if (th) return th;
  }
  const EDITABLE_SEL =
    'input, textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]';
  const BLOCK_DESC_SEL =
    'div, p, li, ul, ol, table, tr, section, article, main, form, header, footer, nav, aside, blockquote, pre, h1, h2, h3, h4, h5, h6';
  for (const el of document.querySelectorAll('body *')) {
    if (el.isContentEditable || el.closest?.(EDITABLE_SEL)) continue;
    let own = '';
    for (const n of el.childNodes) if (n.nodeType === 3) own += n.nodeValue + ' ';
    own = own.replace(/\s+/g, ' ').trim().toLowerCase();
    const inlineFull = !el.querySelector(BLOCK_DESC_SEL)
      ? (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
      : '';
    const hit = ns.find((x) => own.includes(x) || (inlineFull && inlineFull.includes(x)));
    if (!hit) continue;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0) || getComputedStyle(el).visibility === 'hidden') continue;
    const sig = inlineFull || own;
    if (init) seen.set(el, sig);
    else if (!seen.has(el) || seen.get(el) !== sig) return hit;
  }
  return '';
}

async function armWaitTextNew(page, textNew) {
  const needles = String(textNew).split('|').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const key = '__tbmTN' + Math.random().toString(36).slice(2);
  const frames = getAllFrames(page);
  await Promise.all(frames.map((f) => f.frame.evaluate(waitTextNewScan, [needles, key, true, false]).catch(() => '')));
  return key;
}

async function disarmWaitTextNew(page, key) {
  if (!key) return;
  for (const f of getAllFrames(page)) {
    f.frame.evaluate((k) => { delete window[k]; delete window[k + 't']; }, key).catch(() => {});
  }
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
    if (params.ref || params.selector || params.text || (typeof params.label === 'string' && params.label.trim())) {
      const target = await resolveTarget(page, params);
      if (target.note) silentState.note = target.note;
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
      const preKey = typeof params._textNewKey === 'string' ? params._textNewKey : '';
      const key = preKey || ('__tbmTN' + Math.random().toString(36).slice(2));
      const frames = getAllFrames(page);
      if (params._freshDocument) {
        // Right after navigate/reload/back/forward in the same batch: everything on the new document is new.
        await Promise.all(frames.map((f) => f.frame.evaluate((k) => { window[k] = new WeakMap(); window[k + 't'] = ''; }, key).catch(() => '')));
      } else if (!preKey) {
        await Promise.all(frames.map((f) => f.frame.evaluate(waitTextNewScan, [needles, key, true, false]).catch(() => '')));
      }
      const deadline = Date.now() + timeout;
      try {
        while (Date.now() <= deadline) {
          for (const f of getAllFrames(page)) {
            const hit = await f.frame.evaluate(waitTextNewScan, [needles, key, false, Boolean(params._freshDocument || preKey)]).catch(() => '');
            if (hit) return { ok: true, action, waitedFor: params.textNew, ...(needles.length > 1 ? { matched: needleOrig[needles.indexOf(hit)] } : {}) };
          }
          await page.waitForTimeout(80);
        }
      } finally {
        await disarmWaitTextNew(page, key);
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
    if (params.ref || (!params.selector && !params.text && typeof params.label === 'string' && params.label.trim())) {
      const target = await resolveTarget(page, params, {
        allowHidden: ['hidden', 'detached', 'attached'].includes(params.state),
      });
      if (target.note) silentState.note = target.note;
      await target.locator.waitFor({ state: params.state || 'visible', timeout });
      return { ok: true, action, waitedFor: params.ref || params.label };
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
      // A plain word ("Error") must not match inside another word ("errors"); phrases and punctuation stay substrings.
      const altSource = (x) => {
        const esc = x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return /^[\p{L}\p{N}_]+$/u.test(x) ? `(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])` : esc;
      };
      const altRe = altMode ? new RegExp(textAlts.map(altSource).join('|'), 'iu') : null;
      const altRes = altMode ? textAlts.map((x) => ({ x, re: new RegExp(altSource(x), 'iu') })) : [];
      let matchedSnippet = '';
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
                const hay = (await list.nth(i).textContent().catch(() => '')) || '';
                const hit = altRes.find((a) => a.re.test(hay));
                matchedAlt = hit?.x;
                const at = hit ? hay.search(hit.re) : -1;
                if (at >= 0) matchedSnippet = hay.slice(Math.max(0, at - 30), at + 50).replace(/\s+/g, ' ').trim();
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
      return { ok: true, action, waitedFor: params.selector || params.text, ...(matchedAlt ? { matched: matchedAlt, ...(matchedSnippet ? { snippet: matchedSnippet } : {}) } : {}) };
    }
    const wantMs = Number(params.ms) || 500;
    const ms = Math.min(wantMs, 15000);
    await page.waitForTimeout(ms);
    return { ok: true, action, ms, ...(wantMs > ms ? { cappedTo: ms } : {}) };
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
    if (params.ref || params.selector || params.text || (typeof params.label === 'string' && params.label.trim())) {
      target = await resolveTarget(page, params);
      if (target.note) silentState.note = target.note;
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

  const hasTarget = Boolean(
    params.ref ||
    params.selector ||
    params.text ||
    (action !== 'select' && typeof params.label === 'string' && params.label.trim())
  );
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
  if (target.note) silentState.note = target.note;
  const { locator, frameIdx } = target;

  if (action === 'drag') {
    const dest = await resolveTarget(page, {
      ref: params.targetRef,
      selector: params.targetSelector,
      text: params.targetText,
      frameIdx: params.targetFrameIdx,
    });
    if (dest.note && !silentState.note) silentState.note = dest.note;
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
      const cleanMetaLbl = String(meta.label || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
      if (
        (cleanMetaLbl && EDITOR_OPEN_LABEL_RE.test(cleanMetaLbl)) ||
        (typeof params.text === 'string' && EDITOR_OPEN_LABEL_RE.test(params.text.trim()))
      ) {
        silentState.editorOpen = true;
      }
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
        const go = (o) => (action === 'dblclick' ? locator.dblclick(o) : locator.click(o));
        try {
          await go({ ...clickOpts, timeout: Math.min(timeout, 1500) });
        } catch (err) {
          // The page root receiving the click means the target's popover/menu closed under us; retrying for 8 s will not reopen it.
          if (/<(html|body)[\s>][^\r\n]*?\s+intercepts pointer events/.test(String(err?.message || err).replace(ANSI_RE, ''))) {
            throw new Error('Click missed: the target is no longer under the pointer (its popover or menu closed). Reopen it and click in the same batch.');
          }
          await go(clickOpts);
        }
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
    if (back && !back.secret && !back.sh && val !== '' && !out.mismatch && !out.retyped && !/[\r\n]/.test(val)) {
      const now = await locator
        .evaluate(async (el) => {
          const leave = (el, ae) => {
          if (ae && ae !== document.body && typeof ae.blur === 'function') ae.blur();
          const hay = [el.name, el.id, el.className, el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('data-provide'), el.parentElement && el.parentElement.className, el.closest('[class*=date],[class*=picker],[class*=calendar]') ? 'date' : '']
            .map((x) => (typeof x === 'string' ? x : '')).join(' ');
          // Date pickers commit or clear on an outside mousedown, not on blur: send one to the body.
          if (/date|picker|calendar|ngày/i.test(hay)) {
            for (const t of ['mousedown', 'mouseup', 'click']) document.body.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, clientX: 1, clientY: 1 }));
          }
        };
          leave(el, document.activeElement === el ? el : null);
          await new Promise((r) => setTimeout(r, 60));
          return String(el.value ?? '');
        })
        .catch(() => null);
      const flag = now === null ? null : blurFlag(val, now);
      if (flag) {
        if (flag.clearedAfterBlur) {
          const again = await retypeSlowly(page, locator, val);
          if (norm(again) !== '') out.retyped = true;
          else Object.assign(out, flag);
        } else Object.assign(out, flag);
      }
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
    const ringBefore = await ringSig(locator);
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
    if (typedBack && !typedBack.v.endsWith(val.replace(/\r\n/g, '\n'))) {
      // A tag/chip input turns the text into a chip and empties itself: that is a commit, not a mismatch.
      const consumed = typedBack.v === '' && ringBefore && (await ringSig(locator)) !== ringBefore;
      if (!consumed) typedOut.mismatch = mismatchText(typedBack);
    }
    if (params.submit) {
      await page.keyboard.press('Enter');
    }
    return typedOut;
  }

  if (action === 'select') {
    // `option` is what smart_fill_form calls the visible option text; accept it here too (as a label).
    const optionAlias = params.values === undefined && params.value === undefined && params.label === undefined
      ? params.option : undefined;
    const raw = params.values ?? params.value ?? params.label ?? optionAlias;
    if (raw === undefined) throw new Error('select action requires value, values, label, or option.');
    const isNativeSelect = await locator.evaluate((el) => el.tagName === 'SELECT').catch(() => true);
    if (!isNativeSelect) {
      throw new Error('select works on a native <select>. For an ARIA combobox or custom dropdown use smart_fill_form with {ref, option}.');
    }
    const byLabel = params.label !== undefined || optionAlias !== undefined;
    const labelValue = params.label ?? optionAlias;
    let spec;
    if (Array.isArray(raw)) {
      spec = byLabel ? raw.map((l) => ({ label: String(l) })) : raw.map((v) => String(v));
    } else {
      spec = byLabel ? { label: String(labelValue) } : String(raw);
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
      native: el.tagName === 'INPUT' && /^(checkbox|radio)$/.test(el.type),
    })).catch(() => ({ role: '', ariaChecked: null }));

    await withActionSubmitGuard(async () => {
      if (!roleInfo.native && (roleInfo.role === 'switch' || roleInfo.role === 'checkbox' || roleInfo.role === 'radio')) {
        if ((roleInfo.ariaChecked === 'true') !== wantChecked) {
          await locator.click({ timeout });
        }
      } else {
        const go = (o) => (wantChecked ? locator.check(o) : locator.uncheck(o));
        try {
          await go({ timeout: Math.min(timeout, 2500) });
        } catch (err) {
          if (await locator.isChecked().catch(() => null) === wantChecked) return;
          // Clipped/transparent controls may time out as invisible, outside the viewport, or intercepted.
          // Use the visible surface a person clicks; never toggle the property directly.
          const handle = await locator.evaluateHandle((el) => {
            if (el.tagName !== 'INPUT' || !/^(checkbox|radio)$/.test(el.type) || el.matches(':disabled')) return null;
            const visible = (node) => {
              if (node.matches(':disabled, [aria-disabled="true"]') || node.closest('[inert]')) return false;
              const rect = node.getBoundingClientRect();
              if (!rect.width || !rect.height) return false;
              for (let cur = node; cur; cur = cur.parentElement) {
                const s = getComputedStyle(cur);
                if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
              }
              return true;
            };
            for (const label of el.labels || []) if (visible(label)) return label;
            for (let cur = el.parentElement; cur; cur = cur.parentElement) {
              if (cur.matches('label, [role="checkbox"], [role="radio"], [role="switch"], button, [role="button"], [onclick], [tabindex]:not([tabindex="-1"])') && visible(cur)) return cur;
            }
            return null;
          });
          try {
            const target = handle.asElement();
            if (!target) throw err;
            if (!allowSubmit) {
              const meta = await isSubmitLikeElement(target);
              if (meta.isSubmit) throw new Error(`Submit guard: blocked ${action} on "${meta.label}" because allowSubmit=false.`);
              await target.scrollIntoViewIfNeeded({ timeout });
              const box = await target.boundingBox();
              if (box) {
                const point = await isSubmitAtPoint(page, box.x + box.width / 2, box.y + box.height / 2);
                if (point.isSubmit) throw new Error(`Submit guard: blocked ${action} on "${point.label}" because allowSubmit=false.`);
              }
            }
            try {
              await target.click({ timeout: Math.min(timeout, 2500) });
            } catch (clickErr) {
              // A transparent overlay still covers the label: a DOM click on the label is what a person's click does.
              if (!/intercepts pointer events|covers the target|Timeout/i.test(String(clickErr?.message || clickErr))) throw clickErr;
              await target.evaluate((node) => node.click());
            }
            if (await locator.isChecked() !== wantChecked) throw new Error(`Checkbox did not become ${wantChecked ? 'checked' : 'unchecked'} after clicking its label or wrapper.`);
          } finally { await handle.dispose(); }
        }
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
// Size of the markup around a field (up to 3 ancestors up): changes when typing adds a chip or list item.
function ringSig(locator) {
  return locator.evaluate((el) => {
    let box = el;
    for (let i = 0; i < 3 && box.parentElement && box.parentElement !== document.body; i++) box = box.parentElement;
    return `${box.querySelectorAll('*').length}:${(box.textContent || '').length}`;
  }).catch(() => null);
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
    res = await executeSingleAction(page, { ...params, allowSubmit });
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
    const snap = await snapshotAfterAction(
      page,
      {
        mode: params.snapshotMode || 'interactive',
        maxChars: params.snapshotMaxChars || 2500,
        query: params.snapshotQuery,
        afterNavOrSubmit: Boolean(
          allowSubmit ||
          res.outcome === 'navigated' ||
          res.url ||
          ['reload', 'back', 'forward'].includes(params.action)
        ),
      },
      previousLinesSet
    );
    res.snapshot = snap.snapshot;
    if (snap.pageText) res.pageText = snap.pageText;
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

const MUTATING_BATCH_ACTIONS = new Set([
  'click', 'dblclick', 'press', 'fill', 'type', 'clear', 'smart_fill_form', 'fill_form',
  'navigate', 'reload', 'back', 'forward', 'select', 'check', 'uncheck', 'upload', 'drop', 'drag',
]);

async function batchActionsCore(page, stepList, options, previousLinesSet, guardState) {
  const t0 = Date.now();
  const continueOnError = Boolean(options.continueOnError);
  const defaultAllowSubmit = resolveAllowSubmit(options.allowSubmit);
  let lastNavBad = '';
  const results = [];
  let prevWasNav = false;
  let pendingTextNewKey = '';

  try {
    for (let i = 0; i < stepList.length; i++) {
      const step = stepList[i];
      const afterNav = prevWasNav;
      const isNavStep = ['navigate', 'reload', 'back', 'forward'].includes(step?.action);
      prevWasNav = isNavStep;
      const nextStep = stepList[i + 1];
      if (pendingTextNewKey && !(step?.action === 'wait' && step?.textNew)) {
        await disarmWaitTextNew(page, pendingTextNewKey);
        pendingTextNewKey = '';
      }
      if (
        !isNavStep &&
        MUTATING_BATCH_ACTIONS.has(step?.action) &&
        nextStep &&
        nextStep.action === 'wait' &&
        nextStep.textNew
      ) {
        pendingTextNewKey = await armWaitTextNew(page, nextStep.textNew);
      }
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
          const rawUrl = String(step.url).trim();
          const isBlank = rawUrl.toLowerCase() === 'about:blank';
          const url = isBlank ? new URL('about:blank') : new URL(rawUrl, page.url());
          if (!isBlank && !['http:', 'https:'].includes(url.protocol)) {
            throw new Error('navigate requires an HTTP(S) URL.');
          }
          if ((step.method !== undefined && String(step.method).toUpperCase() !== 'GET') ||
              step.body !== undefined || step.postData !== undefined) {
            throw new Error('navigate supports GET only, without a request body.');
          }
          if (!isBlank) {
            const denied = urlDenial(url.href);
            if (denied) throw new Error(denied);
          }
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
          const stepAllowSubmit =
            options.allowSubmit === false ? false : resolveAllowSubmit(step.allowSubmit ?? defaultAllowSubmit);
          const preWaitKey = step.action === 'wait' && step.textNew ? pendingTextNewKey : '';
          if (preWaitKey) pendingTextNewKey = '';
          stepResult = await executeSingleAction(page, {
            ...step,
            ...(afterNav && step.action === 'wait' && step.textNew ? { _freshDocument: true } : {}),
            ...(preWaitKey ? { _textNewKey: preWaitKey } : {}),
            returnSnapshot: options.returnSnapshot || step.returnSnapshot,
            observeAftermath: step.observeAftermath ?? options.observeAftermath,
            _registerPopup: options._registerPopup,
            allowSubmit: stepAllowSubmit,
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
  } finally {
    if (pendingTextNewKey) {
      await disarmWaitTextNew(page, pendingTextNewKey);
      pendingTextNewKey = '';
    }
  }

  const out = {
    completed: results.length,
    total: stepList.length,
    blocked: false,
    results,
  };

  if (options.returnSnapshot) {
    const snap = await snapshotAfterAction(
      page,
      {
        mode: options.snapshotMode || 'interactive',
        maxChars: options.snapshotMaxChars || 2500,
        query: options.snapshotQuery,
        afterNavOrSubmit: true,
      },
      previousLinesSet
    );
    out.snapshot = snap.snapshot;
    if (snap.pageText) out.pageText = snap.pageText;
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
  const maxChars = Math.max(1, Number(options.maxChars) || 6000);
  const includeFrames = options.includeFrames !== false;
  let selector = options.selector || null;
  const format =
    options.format === 'markdown'
      ? 'markdown'
      : options.format === 'table_json'
        ? 'table_json'
        : 'text';

  const frames = includeFrames ? getAllFrames(page) : getAllFrames(page).slice(0, 1);

  if (format === 'table_json') {
    const allRows = [];
    for (const frameInfo of frames) {
      const frameRows = await frameInfo.frame
        .evaluate((sel) => {
          const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
          const parseCellVal = (raw) => {
            const s = clean(raw);
            if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s)) {
              const n = Number(s);
              if (Number.isFinite(n)) return n;
            }
            return s;
          };
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
              let matches = [];
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
          const isHidden = (el) => {
            let cur = el;
            while (cur && cur.nodeType === 1) {
              if (cur.hasAttribute('hidden') || cur.getAttribute('aria-hidden') === 'true') return true;
              try {
                const st = getComputedStyle(cur);
                if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return true;
              } catch {}
              const rn = cur.getRootNode?.();
              cur = cur.parentElement || (rn instanceof ShadowRoot ? rn.host : null);
            }
            return false;
          };
          const extractTableRows = (tbl, onlyRows = null) => {
            const headRows = [...tbl.querySelectorAll('thead tr')].filter((tr) => !isHidden(tr));
            let hdrTr = headRows.length > 0 ? headRows[headRows.length - 1] : null;
            if (!hdrTr) {
              const firstTr = [...tbl.querySelectorAll('tr')].find((tr) => !isHidden(tr));
              if (firstTr && [...firstTr.children].some((c) => c.tagName === 'TH')) hdrTr = firstTr;
            }
            const headers = hdrTr
              ? [...hdrTr.children]
                  .filter((c) => (c.tagName === 'TH' || c.tagName === 'TD') && !isHidden(c))
                  .map((c, idx) => clean(c.innerText || c.textContent) || `col${idx + 1}`)
              : [];
            const candidateTrs =
              onlyRows ||
              ([...tbl.querySelectorAll('tbody tr')].length > 0
                ? [...tbl.querySelectorAll('tbody tr')]
                : [...tbl.querySelectorAll('tr')].filter((tr) => !tr.closest('thead, tfoot')));
            const out = [];
            for (const tr of candidateTrs) {
              if (tr === hdrTr || isHidden(tr)) continue;
              const cells = [...tr.children].filter((c) => (c.tagName === 'TD' || c.tagName === 'TH') && !isHidden(c));
              if (cells.length === 0) continue;
              if (cells.every((c) => c.tagName === 'TH')) continue;
              const rowObj = {};
              let hasContent = false;
              cells.forEach((cell, idx) => {
                const key = headers[idx] || `col${idx + 1}`;
                const val = parseCellVal(cell.innerText || cell.textContent);
                if (val !== '') hasContent = true;
                rowObj[key] = val;
              });
              if (hasContent) out.push(rowObj);
            }
            return out;
          };

          const rows = [];
          if (sel) {
            const matched = findDeepAll(document, sel).filter((el) => !isHidden(el));
            const directTrs = matched.filter((el) => el.tagName === 'TR');
            if (directTrs.length > 0) {
              const byTable = new Map();
              for (const tr of directTrs) {
                const tbl = tr.closest('table') || document.body;
                if (!byTable.has(tbl)) byTable.set(tbl, []);
                byTable.get(tbl).push(tr);
              }
              for (const [tbl, trList] of byTable.entries()) {
                rows.push(...extractTableRows(tbl, trList));
              }
              return rows;
            }
            for (const m of matched) {
              if (m.tagName === 'TABLE') {
                rows.push(...extractTableRows(m));
              } else if (m.tagName === 'TBODY') {
                const tbl = m.closest('table') || m;
                rows.push(...extractTableRows(tbl, [...m.querySelectorAll('tr')]));
              } else {
                for (const tbl of findDeepAll(m, 'table').filter((t) => !isHidden(t))) {
                  rows.push(...extractTableRows(tbl));
                }
              }
            }
            return rows;
          }
          const root =
            findDeepAll(document, 'main, article, [role="main"]').find((el) => !isHidden(el) && el.querySelector('table')) ||
            document.body;
          if (!root) return rows;
          for (const tbl of findDeepAll(root, 'table').filter((t) => !isHidden(t))) {
            rows.push(...extractTableRows(tbl));
          }
          return rows;
        }, selector)
        .catch(() => []);
      if (Array.isArray(frameRows) && frameRows.length > 0) {
        allRows.push(...frameRows);
      }
    }
    const title = await page.title().catch(() => '');
    const full = JSON.stringify(allRows);
    const MARK = '\n... [truncated]';
    const truncated = full.length > maxChars;
    const text = truncated ? `${full.slice(0, Math.max(0, maxChars - MARK.length))}${MARK}` : full;
    const savedPath = writeSaveFile(options.savePath, full);
    return {
      text,
      rows: allRows,
      rowCount: allRows.length,
      fullChars: savedPath && truncated ? full.length : undefined,
      url: page.url(),
      title,
      format,
      truncated,
      charCount: text.length,
      savePath: savedPath,
      ...(allRows.length === 0 ? { note: 'no visible table rows found' } : {}),
    };
  }
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
    if (sections.length === 0 && selector) {
      // The selector matched nothing useful (no <main>, or content in a sibling): read the whole page instead.
      const wanted = selector;
      selector = null;
      await runAll();
      if (sections.length > 0) note = `selector "${wanted}" had no text; used the page body`;
    }
    if (sections.length === 0) note = 'page has no text yet';
  }
  // An SPA that is still rendering: a sliver of text with an empty app root, or a document younger than ~8 s whose text
  // is still growing (lazy lists load after the shell). Poll until the text holds still, at most 3 s.
  const small = !selector && sections.length > 0 && sections.join('').length < 400;
  const probeState = !selector && sections.length > 0
    ? await page.mainFrame().evaluate((checkRoot) => ({
      // Young document that already used fetch/XHR: a data-driven page whose list may still be coming in.
      young: performance.now() < 8000 && performance.getEntriesByType('resource').some((e) => e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest'),
      emptyRoot: checkRoot && [...document.querySelectorAll('#app, #root, #__next, #app-root, main, [role="main"]')].some((e) => !(e.innerText || '').trim()),
    }), small).catch(() => ({ young: false, emptyRoot: false }))
    : { young: false, emptyRoot: false };
  if (probeState.emptyRoot || probeState.young) {
    const until = Date.now() + 3000;
    const quietPolls = probeState.emptyRoot ? 5 : sections.join('').length < 1500 ? 6 : 3;
    let last = sections.join('').length;
    let still = 0;
    while (still < quietPolls && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 200));
      await runAll();
      const len = sections.join('').length;
      still = len === last ? still + 1 : 0;
      last = len;
    }
  }

  const title = await page.title().catch(() => '');
  const fullHeader = `URL: ${page.url()}\nTitle: ${title}\n\n`;
  const joined = sections.join('\n\n');
  const full = `${fullHeader}${joined}`;
  const truncated = full.length > maxChars;
  // The whole reply stays within maxChars. On a small budget the header shrinks (no title, short URL)
  // so most of the budget goes to content instead of URL/title.
  const MARK = '\n... [truncated]';
  let header = fullHeader;
  if (truncated && header.length > maxChars / 4) {
    const url = page.url();
    const room = Math.max(12, Math.floor(maxChars / 4) - 7);
    header = `URL: ${url.length > room ? `${url.slice(0, room - 1)}…` : url}\n\n`;
  }
  const text = truncated ? `${header}${joined.slice(0, Math.max(0, maxChars - header.length - MARK.length))}${MARK}` : full;
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

const pageFocusSessions = new WeakMap();

/**
 * Enable Emulation.setFocusEmulationEnabled on a page's persistent CDP session so background
 * or --no-focus tabs continue rendering and receiving input without stealing window focus.
 */
export async function ensureFocusEmulation(page, enabled = true) {
  if (!page || typeof page.context !== 'function') return false;
  if (
    arguments.length < 2 &&
    /^(0|false|no|off)$/i.test(String(process.env.TURBO_BROWSER_FOCUS_EMULATION || ''))
  ) {
    return false;
  }
  const want = Boolean(enabled);
  let entry = pageFocusSessions.get(page);
  if (entry && entry.enabled === want) return true;
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const ctx = page.context();
        if (!ctx || typeof ctx.newCDPSession !== 'function') return false;
        const session = entry?.session || (await ctx.newCDPSession(page));
        if (!entry) {
          entry = { session, enabled: false };
          pageFocusSessions.set(page, entry);
          page.once?.('close', () => {
            pageFocusSessions.delete(page);
            session.detach().catch(() => {});
          });
        }
        await session.send('Emulation.setFocusEmulationEnabled', { enabled: want });
        if (want) await session.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
        entry.enabled = want;
        return true;
      })(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), 1000);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Capture full-page/element screenshots (png/jpeg/webp, with optional server-side maxWidth downscaling)
 * or PDF export safely to cwd-resolved paths.
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

  const rawFormat = params.format ?? params.type ?? process.env.TURBO_BROWSER_SCREENSHOT_FORMAT ?? 'png';
  const fmtNorm = String(rawFormat).trim().toLowerCase();
  const type = fmtNorm === 'jpeg' || fmtNorm === 'jpg' ? 'jpeg' : fmtNorm === 'webp' ? 'webp' : 'png';
  const quality = type !== 'png' ? Math.min(100, Math.max(1, Number(params.quality) || 80)) : undefined;
  const maxWidth = Math.max(0, Number(params.maxWidth ?? process.env.TURBO_BROWSER_SCREENSHOT_MAX_WIDTH) || 0);
  const shotOpts = {
    type: type === 'jpeg' ? 'jpeg' : 'png',
    quality: type === 'jpeg' ? quality : undefined,
    scale: params.scale === 'device' ? 'device' : 'css',
    timeout,
  };

  if (typeof page.context === 'function') {
    await ensureFocusEmulation(page).catch(() => {});
  }

  // Playwright waits indefinitely for FontFaceSet.ready within its screenshot timeout.
  // Give web fonts a short chance, then capture through CDP without changing global env
  // flags or the page's FontFaceSet (other concurrent captures must stay independent).
  const fontsPending = (await Promise.all((page.frames?.() || []).map((frame) => frame.evaluate(async (ms) => {
    if (!document.fonts || document.fonts.status === 'loaded') return false;
    let timer;
    const ready = await Promise.race([
      document.fonts.ready.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
    clearTimeout(timer);
    return !ready;
  }, Math.min(500, timeout)).catch(() => false)))).some(Boolean);
  const target = params.ref || params.selector || params.text ? await resolveTarget(page, params) : null;
  let imgBuf;
  let outWidth;
  let outHeight;
  const useCdpCapture = (fontsPending || type === 'webp' || maxWidth > 0) && typeof page.context === 'function';
  if (useCdpCapture) {
    if (target) await target.locator.scrollIntoViewIfNeeded({ timeout });
    const box = target ? await target.locator.boundingBox({ timeout }) : null;
    if (target && (!box || !box.width || !box.height)) throw new Error('Screenshot target is not visible.');
    const client = await page.context().newCDPSession(page);
    try {
      await client.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      const { cssLayoutViewport: viewport, cssContentSize: content } = await client.send('Page.getLayoutMetrics');
      const dpr = (await page.evaluate(() => window.devicePixelRatio).catch(() => 1)) || 1;
      const clip = box
        ? { x: box.x + viewport.pageX, y: box.y + viewport.pageY, width: box.width, height: box.height }
        : params.fullPage ? { x: 0, y: 0, width: content.width, height: content.height }
          : { x: viewport.pageX, y: viewport.pageY, width: viewport.clientWidth, height: viewport.clientHeight };
      const baseScale = shotOpts.scale === 'device' ? 1 : 1 / dpr;
      const naturalPixelWidth = clip.width * dpr * baseScale;
      const naturalPixelHeight = clip.height * dpr * baseScale;
      const downscale = maxWidth > 0 && naturalPixelWidth > maxWidth ? maxWidth / naturalPixelWidth : 1;
      const clipScale = baseScale * downscale;
      outWidth = Math.max(1, Math.round(naturalPixelWidth * downscale));
      outHeight = Math.max(1, Math.round(naturalPixelHeight * downscale));
      const { data } = await client.send('Page.captureScreenshot', {
        format: type,
        ...(type !== 'png' ? { quality } : {}),
        clip: { ...clip, scale: clipScale },
        captureBeyondViewport: true,
      });
      imgBuf = Buffer.from(data, 'base64');
    } finally { await client.detach().catch(() => {}); }
  } else if (target) imgBuf = await target.locator.screenshot(shotOpts);
  else imgBuf = await page.screenshot({ ...shotOpts, fullPage: Boolean(params.fullPage) });

  if (resolvedPath) {
    fs.writeFileSync(resolvedPath, imgBuf);
  }

  const shouldReturnImage = params.returnImage ?? !resolvedPath;
  return {
    ok: true,
    mode: 'screenshot',
    ...(fontsPending ? { fontsPending: true } : {}),
    type,
    format: type,
    mimeType: `image/${type}`,
    ...(outWidth ? { width: outWidth, height: outHeight } : {}),
    savePath: resolvedPath,
    bytes: imgBuf.length,
    base64: shouldReturnImage ? imgBuf.toString('base64') : undefined,
  };
}
