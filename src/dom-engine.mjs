import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 8000;

const SUBMIT_LABEL_RE =
  /^(submit|publish|post|send|apply(\s+now)?|confirm(\s+and)?\s*(pay|submit|order)|pay(\s+now)?|checkout|place\s+order|delete|remove|gửi|đăng(\s*bài)?|nộp(\s*đơn)?|xác\s*nhận(\s*(nộp|gửi|thanh\s*toán))?|thanh\s*toán|xoá|xóa)\b/i;

const SAFE_SUBMIT_TYPE_RE =
  /^(next|continue|search|filter|save\s*draft|tiếp(\s*tục)?|tìm(\s*kiếm)?|lọc|lưu\s*nháp)\b/i;

const QUESTION_BLOCK_SELECTOR =
  '[role="listitem"], fieldset, .form-group, .field, [class*="Field"], [class*="field"], [class*="question"]';

const SUBMIT_SCAN_SELECTOR =
  'button, input[type="submit"], input[type="button"], [role="button"], a[role="button"]';

function compileFilterRegex(pattern) {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, 'i');
  }
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

function writeSaveFile(savePath, content) {
  if (!savePath) return null;
  const resolved = path.resolve(process.cwd(), String(savePath));
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, typeof content === 'string' ? 'utf8' : undefined);
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
  const rawFiles = Array.isArray(params.files)
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

/**
 * Resolve a compact ref (f0:e3 / e3), CSS/Playwright selector (piercing open Shadow DOM),
 * or text match across frames.
 */
export async function resolveTarget(page, { ref, selector, text, frameIdx } = {}) {
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

    for (const f of candidates) {
      const loc = f.frame.locator(`[data-tbm-ref="${parsed.refId}"]`).first();
      if ((await loc.count().catch(() => 0)) > 0) {
        return { frame: f.frame, frameIdx: f.frameIdx, locator: loc };
      }
    }
    throw new Error(`Element ref "${ref}" not found. Run inspect_compact again to refresh refs.`);
  }

  const scopedFrames = frameIdx !== undefined && frameIdx !== null
    ? frames.filter((f) => f.frameIdx === frameIdx)
    : frames;

  if (selector) {
    for (const f of scopedFrames) {
      const loc = f.frame.locator(selector).first();
      if ((await loc.count().catch(() => 0)) > 0) {
        return { frame: f.frame, frameIdx: f.frameIdx, locator: loc };
      }
    }
    throw new Error(`Selector "${selector}" matched 0 elements across ${scopedFrames.length} frame(s).`);
  }

  if (text) {
    for (const f of scopedFrames) {
      const loc = f.frame.getByText(text, { exact: false }).first();
      if ((await loc.count().catch(() => 0)) > 0) {
        return { frame: f.frame, frameIdx: f.frameIdx, locator: loc };
      }
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
      const submitRe = new RegExp(patterns.submit, 'i');
      const safeRe = new RegExp(patterns.safe, 'i');
      const tag = (el.tagName || '').toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();
      const role = (el.getAttribute('role') || '').toLowerCase();
      const rawLabel = (
        el.innerText ||
        el.textContent ||
        el.value ||
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim();

      if (tag === 'input' && type === 'submit') {
        return { isSubmit: !safeRe.test(rawLabel), label: rawLabel || 'submit', reason: 'input[type=submit]' };
      }
      if (tag === 'button' && type === 'submit') {
        const isSafe = rawLabel && safeRe.test(rawLabel);
        return { isSubmit: !isSafe, label: rawLabel || 'submit', reason: 'button[type=submit]' };
      }
      if ((tag === 'button' || role === 'button' || type === 'button' || tag === 'a') && rawLabel) {
        if (submitRe.test(rawLabel)) {
          return { isSubmit: true, label: rawLabel, reason: 'submit-label-match' };
        }
      }
      return { isSubmit: false, label: rawLabel, reason: '' };
    }, { submit: SUBMIT_LABEL_RE.source, safe: SAFE_SUBMIT_TYPE_RE.source });
  } catch {
    return { isSubmit: false, label: '', reason: '' };
  }
}

export async function isSubmitAtPoint(page, x, y) {
  let handle = null;
  try {
    handle = await page.evaluateHandle(([px, py]) => {
      const hit = document.elementFromPoint(px, py);
      if (!hit) return null;
      return hit.closest('button, input[type="submit"], input[type="button"], [role="button"], a') || hit;
    }, [x, y]);
    const empty = await handle.evaluate((el) => !el).catch(() => true);
    if (empty) return { isSubmit: false, label: '', reason: '' };
    return await isSubmitLikeElement(handle);
  } catch {
    return { isSubmit: false, label: '', reason: '' };
  } finally {
    await handle?.dispose().catch(() => {});
  }
}

/**
 * Build a token-efficient snapshot across frames & open Shadow DOM (capped at maxChars),
 * assigning deterministic data-tbm-ref IDs and supporting query, onlyChanged delta, boxes, and savePath.
 */
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

  const frames = includeFrames ? getAllFrames(page) : getAllFrames(page).slice(0, 1);
  let nextRefNum = 1;
  const entries = [];
  const nextSignatures = new Set();
  let totalMatched = 0;

  for (const frameInfo of frames) {
    let chunk;
    try {
      chunk = await frameInfo.frame.evaluate(
        ({ modeArg, frameIdxArg, startRef, rootSel, boxesArg }) => {
          const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

          const queryAllDeep = (rootNode, sel) => {
            const seen = new Set();
            const out = [];
            const stack = [rootNode];
            while (stack.length > 0) {
              const cur = stack.shift();
              if (!cur || !cur.querySelectorAll) continue;
              for (const match of cur.querySelectorAll(sel)) {
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

          const root = rootSel
            ? (queryAllDeep(document, rootSel)[0] || document.body)
            : document.body;
          if (!root) return { items: [], nextRef: startRef, total: 0 };

          const isHidden = (el) => {
            if (el.tagName === 'INPUT' && el.type === 'file') return false;
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
              return true;
            }
            const rect = el.getBoundingClientRect();
            return rect.width === 0 || rect.height === 0;
          };

          const resolveById = (el, id) => {
            const rootNode = el.getRootNode?.();
            return (rootNode?.getElementById && rootNode.getElementById(id)) || document.getElementById(id);
          };

          const labelFor = (el) => {
            const aria = clean(el.getAttribute('aria-label'));
            if (aria) return aria.slice(0, 80);

            if (el.labels && el.labels.length > 0) {
              const lblText = [...el.labels].map((l) => clean(l.innerText)).filter(Boolean).join(' ');
              if (lblText) return lblText.slice(0, 80);
            }

            const lby = el.getAttribute('aria-labelledby');
            if (lby) {
              const txt = lby
                .split(/\s+/)
                .map((id) => clean(resolveById(el, id)?.innerText))
                .filter(Boolean)
                .join(' ');
              if (txt) return txt.slice(0, 80);
            }

            const wrapLabel = el.closest('label');
            if (wrapLabel && clean(wrapLabel.innerText)) {
              return clean(wrapLabel.innerText).slice(0, 80);
            }

            const tag = el.tagName;
            if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && !el.isContentEditable) {
              const visText = clean(el.innerText || el.textContent);
              if (visText) return visText.slice(0, 80);
            }

            for (const attr of ['placeholder', 'data-placeholder', 'title', 'name', 'id']) {
              const v = clean(el.getAttribute(attr));
              if (v) return v.slice(0, 80);
            }

            return clean(el.innerText || el.textContent).slice(0, 80);
          };

          const selectorByMode = {
            interactive:
              'a[href], button, input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="radio"], [role="checkbox"], [role="tab"], [role="menuitem"], summary',
            forms:
              'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="combobox"], [role="radio"], [role="checkbox"], button, [role="button"]',
            article: 'h1, h2, h3, h4, p, li, a[href], button',
            all: 'h1, h2, h3, a[href], button, input, textarea, select, [contenteditable="true"], [role="button"], [role="textbox"], [role="combobox"], [role="radio"], [role="checkbox"], p',
          };

          const sel = selectorByMode[modeArg] || selectorByMode.interactive;
          const nodes = queryAllDeep(root, sel).filter((el) => !isHidden(el));

          let refCounter = startRef;
          const items = [];
          for (const el of nodes) {
            const tag = el.tagName.toLowerCase();
            const refId = `e${refCounter++}`;
            el.setAttribute('data-tbm-ref', refId);
            const fullRef = `f${frameIdxArg}:${refId}`;
            const inShadow = el.getRootNode?.() instanceof ShadowRoot;
            const shadowTag = inShadow ? ' [shadow]' : '';

            if (modeArg === 'article' && (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'p' || tag === 'li')) {
              const txt = clean(el.innerText || el.textContent).slice(0, 220);
              if (txt) {
                const line = `[${fullRef}] <${tag}> ${txt}`;
                items.push({ line, sig: `f${frameIdxArg}:<${tag}>:${txt}` });
              }
              continue;
            }

            const role = el.getAttribute('role');
            const type = el.getAttribute('type') || '';
            const kind = tag === 'input'
              ? `input:${type || 'text'}`
              : el.isContentEditable
                ? `${tag}:editable`
                : role
                  ? `${tag}:${role}`
                  : tag;

            const lbl = labelFor(el);
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
            } else if (el.isContentEditable) {
              const txt = clean(el.innerText);
              if (txt) extra += ` val="${txt.slice(0, 40)}"`;
            } else if (tag === 'a' && el.getAttribute('href')) {
              extra += ` href="${el.getAttribute('href').slice(0, 50)}"`;
            }

            if (el.disabled || el.getAttribute('aria-disabled') === 'true') extra += ' [disabled]';
            if (el.required || el.getAttribute('aria-required') === 'true') extra += ' [req]';

            let boxTag = '';
            if (boxesArg) {
              const br = el.getBoundingClientRect();
              boxTag = ` [box=${Math.round(br.x)},${Math.round(br.y)},${Math.round(br.width)},${Math.round(br.height)}]`;
            }

            const line = `[${fullRef}] <${kind}> "${lbl}"${extra}${shadowTag}${boxTag}`;
            const sig = `f${frameIdxArg}:<${kind}> "${lbl}"${extra}${shadowTag}`;
            items.push({ line, sig });
          }
          return { items, nextRef: refCounter, total: items.length };
        },
        {
          modeArg: mode,
          frameIdxArg: frameInfo.frameIdx,
          startRef: nextRefNum,
          rootSel: frameInfo.isMain ? rootSelector : null,
          boxesArg: boxes,
        }
      );
    } catch {
      continue;
    }

    if (!chunk) continue;
    nextRefNum = chunk.nextRef;
    totalMatched += chunk.total;

    const frameItems = [];
    for (const item of chunk.items) {
      nextSignatures.add(item.sig);
      if (queryRe && !queryRe.test(item.line)) continue;
      if (onlyChanged && previousLinesSet && previousLinesSet.size > 0 && previousLinesSet.has(item.sig)) {
        continue;
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

  if (previousLinesSet && !query) {
    previousLinesSet.clear();
    for (const s of nextSignatures) previousLinesSet.add(s);
  }

  let title = '';
  try {
    title = await page.title();
  } catch {
    title = '';
  }

  const filterNote = `${query ? ` | Query: "${query}"` : ''}${onlyChanged ? ' | Delta: true' : ''}`;
  const header = `URL: ${page.url()}\nTitle: ${title}\nMode: ${mode} | Frames: ${frames.length} | Elements: ${totalMatched}${filterNote}\n`;
  let body = '';
  let shownCount = 0;
  let truncated = false;
  const trailerReserve = 64;

  for (const line of entries) {
    const candidate = body ? `${body}\n${line}` : line;
    if (header.length + candidate.length + trailerReserve > maxChars) {
      truncated = true;
      break;
    }
    body = candidate;
    if (line.startsWith('[f')) shownCount++;
  }

  let text = `${header}${body}`;
  if (truncated) {
    text += `\n... [truncated: ${shownCount}/${totalMatched} elements]`;
  }
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
  }
  const savedPath = writeSaveFile(options.savePath, text);

  return {
    text,
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
export async function smartFillForm(page, spec = {}, previousLinesSet = null) {
  const t0 = Date.now();
  const frames = getAllFrames(page);
  const overwrite = Boolean(spec.overwrite);
  const fields = Array.isArray(spec.fields) ? spec.fields : [];

  const fileFields = [];
  const domFields = [];
  fields.forEach((f, idx) => {
    if (f && (f.file || (Array.isArray(f.files) && f.files.length > 0))) {
      fileFields.push({ ...f, _idx: idx });
    } else if (f) {
      domFields.push({ ...f, _idx: idx });
    }
  });

  const filled = [];
  const skipped = [];
  const submitButtons = [];
  const leftoverSet = new Set();
  const matchedFieldIndexes = new Set();

  // Pass 1: Run fast batch DOM fill (including open Shadow DOM) inside each frame.
  for (const frameInfo of frames) {
    let res;
    try {
      res = await frameInfo.frame.evaluate(
        ({ domSpec, mainVal, gmailSpec, overwriteFlag, frameIdxArg, qBlockSel, submitSel }) => {
          const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

          const queryAllDeep = (rootNode, sel) => {
            const seen = new Set();
            const out = [];
            const stack = [rootNode];
            while (stack.length > 0) {
              const cur = stack.shift();
              if (!cur || !cur.querySelectorAll) continue;
              for (const match of cur.querySelectorAll(sel)) {
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

          const vis = (el) => {
            if (!el) return false;
            if (el.disabled || el.readOnly) return false;
            const st = getComputedStyle(el);
            if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };

          const resolveById = (el, id) => {
            const rootNode = el.getRootNode?.();
            return (rootNode?.getElementById && rootNode.getElementById(id)) || document.getElementById(id);
          };

          const describe = (el) => {
            const parts = [];
            for (const a of ['aria-label', 'placeholder', 'name', 'id', 'title', 'data-placeholder']) {
              const v = el.getAttribute(a);
              if (v) parts.push(v);
            }
            if (el.labels) {
              for (const l of el.labels) parts.push(l.innerText);
            }
            const lby = el.getAttribute('aria-labelledby');
            if (lby) {
              for (const id of lby.split(/\s+/)) {
                const n = resolveById(el, id);
                if (n) parts.push(n.innerText);
              }
            }
            const wl = el.closest('label');
            if (wl) parts.push(wl.innerText);
            const blk = el.closest(qBlockSel) || el.getRootNode?.()?.host?.closest?.(qBlockSel);
            if (blk) parts.push(blk.innerText.slice(0, 300));
            const host = el.getRootNode?.()?.host;
            if (host) {
              const hostAttr = host.getAttribute('aria-label') || host.getAttribute('data-label');
              if (hostAttr) parts.push(hostAttr);
            }
            const prev = el.previousElementSibling;
            if (prev) parts.push(prev.innerText);
            return clean(parts.join(' | ')).toLowerCase();
          };

          const currentValue = (el) =>
            el.isContentEditable ? clean(el.innerText) : (el.value || '').trim();

          const setNativeValue = (el, val) => {
            el.focus();
            if (el.isContentEditable) {
              document.execCommand('selectAll', false);
              const ok = document.execCommand('insertText', false, val);
              if (!ok || clean(el.innerText) === '') {
                el.textContent = val;
              }
              el.dispatchEvent(new InputEvent('input', { bubbles: true, data: val, inputType: 'insertText' }));
            } else {
              const proto =
                el.tagName === 'TEXTAREA'
                  ? HTMLTextAreaElement.prototype
                  : HTMLInputElement.prototype;
              if (el._valueTracker && typeof el._valueTracker.setValue === 'function') {
                el._valueTracker.setValue('');
              }
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (setter) setter.call(el, val);
              else el.value = val;
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
            el.style.outline = '2px solid #E0461D';
            el.style.outlineOffset = '1px';
          };

          const chooseSelect = (sel, rawSpec) => {
            const specs = Array.isArray(rawSpec) ? rawSpec : [rawSpec];
            const regexes = specs
              .filter((p) => p !== undefined && p !== null)
              .map((p) => new RegExp(String(p), 'i'));
            if (regexes.length === 0) return null;

            if (sel._valueTracker && typeof sel._valueTracker.setValue === 'function') {
              sel._valueTracker.setValue('');
            }

            let chosen;
            if (sel.multiple || Array.isArray(rawSpec)) {
              const matched = [];
              for (const opt of sel.options) {
                const hit = regexes.some((re) => re.test(opt.text) || re.test(opt.value));
                opt.selected = sel.multiple ? hit : false;
                if (hit) matched.push(opt);
              }
              if (matched.length === 0) return null;
              if (!sel.multiple) {
                sel.value = matched[0].value;
                chosen = clean(matched[0].text);
              } else {
                chosen = matched.map((o) => clean(o.text));
              }
            } else {
              const opt = [...sel.options].find((o) => regexes[0].test(o.text) || regexes[0].test(o.value));
              if (!opt) return null;
              sel.value = opt.value;
              chosen = clean(opt.text);
            }
            sel.dispatchEvent(new Event('input', { bubbles: true }));
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            sel.style.outline = '2px solid #E0461D';
            return chosen;
          };

          const matchesSpec = (text, f) => {
            const keys = Array.isArray(f.keys) ? f.keys : f.keys ? [f.keys] : [];
            const nots = Array.isArray(f.not) ? f.not : f.not ? [f.not] : [];
            if (keys.length === 0) return false;
            if (nots.some((n) => new RegExp(n, 'i').test(text))) return false;
            return keys.some((k) => new RegExp(k, 'i').test(text));
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
              ['div[aria-label="Message Body"]', 'div[aria-label="Nội dung thư"]', 'div[role="textbox"][contenteditable="true"]'],
              gmailSpec.body,
              'body'
            );
          }

          // 2. Text / Select / Radio / Checkbox fields across light + open Shadow DOM
          const inputs = queryAllDeep(
            document,
            'input, textarea, select, [contenteditable="true"], [role="textbox"]'
          ).filter((el) => {
            if (!vis(el)) return false;
            const t = (el.getAttribute('type') || '').toLowerCase();
            return !['hidden', 'submit', 'button', 'image', 'reset', 'file'].includes(t);
          });

          const blocks = queryAllDeep(document, qBlockSel).filter(vis);

          for (const f of domSpec) {
            if (f.option !== undefined || f.check !== undefined) {
              const wanted = f.check ?? f.option;
              const patterns = Array.isArray(wanted) ? wanted : [wanted];
              let hitAny = false;

              const toggleChoiceControls = (container, requireKeyMatch) => {
                const controls = queryAllDeep(
                  container,
                  'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'
                ).filter((c) => {
                  const st = getComputedStyle(c);
                  return st.display !== 'none' && st.visibility !== 'hidden';
                });

                for (const pat of patterns) {
                  const re = new RegExp(pat, 'i');
                  for (const ctrl of controls) {
                    const wrap = ctrl.closest('label') || ctrl.parentElement || ctrl;
                    const optLabel = clean(
                      wrap.innerText || ctrl.getAttribute('aria-label') || ctrl.value || ''
                    );
                    if (!re.test(optLabel)) continue;
                    if (requireKeyMatch && !matchesSpec(optLabel.toLowerCase(), f)) continue;

                    const isAria = ctrl.hasAttribute('role');
                    const isChecked = isAria
                      ? ctrl.getAttribute('aria-checked') === 'true'
                      : Boolean(ctrl.checked);
                    if (!isChecked) {
                      ctrl.click();
                    }
                    ctrl.style.outline = '2px solid #E0461D';
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

              if (f.keys) {
                for (const blk of blocks) {
                  if (matchesSpec(clean(blk.innerText).toLowerCase(), f)) {
                    toggleChoiceControls(blk, false);
                  }
                }
              } else {
                toggleChoiceControls(document, false);
              }

              if (hitAny) matchedIndexes.push(f._idx);
              continue;
            }

            let targets = [];
            if (f.ref) {
              const m = /^(?:f(\d+):)?(e\d+)$/i.exec(f.ref.trim());
              if (m && (m[1] === undefined || Number(m[1]) === frameIdxArg)) {
                const el = queryAllDeep(document, `[data-tbm-ref="${m[2]}"]`)[0];
                if (el && vis(el)) targets = [el];
              }
            } else if (f.selector) {
              if (f.frameIdx === undefined || f.frameIdx === frameIdxArg) {
                targets = queryAllDeep(document, f.selector).filter(vis).slice(0, 1);
              }
            } else if (f.keys) {
              targets = inputs.filter((el) => matchesSpec(describe(el), f));
            }

            if (targets.length === 0) continue;

            for (const el of targets) {
              if (el.tagName === 'SELECT') {
                const selectSpec = f.values !== undefined ? f.values : (f.value ?? '');
                const chosen = chooseSelect(el, selectSpec);
                if (chosen !== null) {
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

              if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio') && typeof f.value === 'boolean') {
                if (Boolean(el.checked) !== f.value) el.click();
                el.style.outline = '2px solid #E0461D';
                frameFilled.push({
                  idx: f._idx,
                  frameIdx: frameIdxArg,
                  tag: `input:${el.type}`,
                  label: describe(el).slice(0, 50),
                  checked: Boolean(el.checked),
                });
                matchedIndexes.push(f._idx);
                continue;
              }

              if (el.tagName === 'INPUT' && el.type === 'range') {
                if (el.dataset.tbmRangeFilled === '1' && !overwriteFlag) {
                  frameSkipped.push({
                    idx: f._idx,
                    frameIdx: frameIdxArg,
                    reason: 'already-filled',
                    label: describe(el).slice(0, 50),
                  });
                  matchedIndexes.push(f._idx);
                  continue;
                }
                setNativeValue(el, String(f.value ?? ''));
                el.dataset.tbmRangeFilled = '1';
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

              const cur = currentValue(el);
              if (cur && !overwriteFlag) {
                frameSkipped.push({
                  idx: f._idx,
                  frameIdx: frameIdxArg,
                  reason: 'already-filled',
                  label: describe(el).slice(0, 50),
                });
                matchedIndexes.push(f._idx);
                continue;
              }

              setNativeValue(el, String(f.value ?? ''));
              frameFilled.push({
                idx: f._idx,
                frameIdx: frameIdxArg,
                tag: el.isContentEditable ? 'contenteditable' : el.tagName.toLowerCase(),
                label: describe(el).slice(0, 50),
                value: String(f.value ?? '').slice(0, 60),
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
              return !currentValue(el);
            })
            .slice(0, 10)
            .map((el) => `[f${frameIdxArg}] ${describe(el).slice(0, 70)}`);

          const submits = queryAllDeep(document, submitSel)
            .filter(vis)
            .map((el) => {
              const txt = clean(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '');
              return { frameIdx: frameIdxArg, text: txt, type: el.getAttribute('type') || '' };
            })
            .filter((b) => b.type === 'submit' || b.text);

          return { frameFilled, frameSkipped, matchedIndexes, leftover, submits };
        },
        {
          domSpec: domFields,
          mainVal: spec.main || '',
          gmailSpec: spec.gmail || null,
          overwriteFlag: overwrite,
          frameIdxArg: frameInfo.frameIdx,
          qBlockSel: QUESTION_BLOCK_SELECTOR,
          submitSel: SUBMIT_SCAN_SELECTOR,
        }
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
      if (SUBMIT_LABEL_RE.test(s.text) || (s.type === 'submit' && !SAFE_SUBMIT_TYPE_RE.test(s.text))) {
        submitButtons.push(s);
      }
    }
  }

  // Pass 1.5: Fallback to custom ARIA [role="combobox"] dropdowns (light + open Shadow DOM)
  for (const f of domFields) {
    if (matchedFieldIndexes.has(f._idx) || typeof f.value !== 'string') continue;
    for (const frameInfo of frames) {
      let comboTag = null;
      try {
        comboTag = await frameInfo.frame.evaluate(({ fieldSpec }) => {
          const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const queryAllDeep = (rootNode, sel) => {
            const seen = new Set();
            const out = [];
            const stack = [rootNode];
            while (stack.length > 0) {
              const cur = stack.shift();
              if (!cur || !cur.querySelectorAll) continue;
              for (const match of cur.querySelectorAll(sel)) {
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

          const combos = queryAllDeep(document, '[role="combobox"]').filter((el) => {
            if (el.tagName === 'SELECT') return false;
            const st = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0;
          });
          const keys = Array.isArray(fieldSpec.keys) ? fieldSpec.keys : fieldSpec.keys ? [fieldSpec.keys] : [];
          const nots = Array.isArray(fieldSpec.not) ? fieldSpec.not : fieldSpec.not ? [fieldSpec.not] : [];
          const hit = combos.find((el) => {
            if (fieldSpec.selector && el.matches(fieldSpec.selector)) return true;
            if (keys.length === 0) return false;
            const rootNode = el.getRootNode?.();
            const lblBy = (el.getAttribute('aria-labelledby') || '')
              .split(/\s+/)
              .map((id) => ((rootNode?.getElementById && rootNode.getElementById(id)) || document.getElementById(id))?.innerText || '')
              .join(' ');
            const txt = clean(
              [
                el.getAttribute('aria-label'),
                el.getAttribute('placeholder'),
                lblBy,
                el.closest('label')?.innerText,
                el.closest('[class*="field"], [class*="Field"], .form-group, [role="listitem"]')?.innerText,
              ].join(' ')
            );
            if (nots.some((n) => new RegExp(n, 'i').test(txt))) return false;
            return keys.some((k) => new RegExp(k, 'i').test(txt));
          });
          if (!hit) return null;
          const marker = `c${fieldSpec._idx}`;
          hit.setAttribute('data-tbm-combo', marker);
          return marker;
        }, { fieldSpec: f });
      } catch {
        comboTag = null;
      }
      if (!comboTag) continue;

      try {
        const comboLoc = frameInfo.frame.locator(`[data-tbm-combo="${comboTag}"]`).first();
        await comboLoc.click({ timeout: 2500 });
        const optLoc = frameInfo.frame.getByRole('option', { name: new RegExp(f.value, 'i') }).first();
        if ((await optLoc.count()) > 0) {
          await optLoc.click({ timeout: 2500 });
          filled.push({
            idx: f._idx,
            frameIdx: frameInfo.frameIdx,
            tag: 'role:combobox',
            value: f.value,
          });
          matchedFieldIndexes.add(f._idx);
          break;
        }
      } catch {
        // Ignore dropdown option lookup failures and move on.
      }
    }
  }

  // Pass 2: Direct disk file uploads across frames via Playwright setInputFiles.
  for (const ff of fileFields) {
    const rawList = Array.isArray(ff.files) ? ff.files : [ff.file];
    const resolvedPaths = rawList.map((p) => path.resolve(String(p)));
    for (const p of resolvedPaths) {
      if (!fs.existsSync(p)) {
        throw new Error(`Upload file does not exist on disk: ${p}`);
      }
    }

    let uploaded = false;
    if (ff.ref || ff.selector) {
      const target = await resolveTarget(page, {
        ref: ff.ref,
        selector: ff.selector,
        frameIdx: ff.frameIdx,
      });
      const isFileInput = await target.locator.evaluate(
        (el) => el.tagName === 'INPUT' && el.type === 'file'
      );
      if (isFileInput) {
        await target.locator.setInputFiles(resolvedPaths);
        uploaded = true;
      } else {
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 4000 }),
          target.locator.click(),
        ]);
        await chooser.setFiles(resolvedPaths);
        uploaded = true;
      }
    } else {
      const keyRes = (Array.isArray(ff.keys) ? ff.keys : ff.keys ? [ff.keys] : []).map(
        (k) => new RegExp(k, 'i')
      );
      for (const frameInfo of frames) {
        const fileInputs = frameInfo.frame.locator('input[type="file"]');
        const count = await fileInputs.count();
        for (let i = 0; i < count; i++) {
          const loc = fileInputs.nth(i);
          if (keyRes.length > 0) {
            const label = await loc.evaluate((el) => {
              const blk = el.closest('label, .form-group, .field, [role="listitem"], fieldset') || el.parentElement;
              return (
                (el.getAttribute('aria-label') || '') +
                ' ' +
                (el.name || '') +
                ' ' +
                (el.id || '') +
                ' ' +
                (blk?.innerText || '')
              );
            });
            if (!keyRes.some((re) => re.test(label))) continue;
          }
          await loc.setInputFiles(resolvedPaths);
          uploaded = true;
          break;
        }
        if (uploaded) break;
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

  const output = {
    filledCount: filled.length,
    filled,
    skipped,
    leftover: [...leftoverSet].slice(0, 12),
    stoppedBeforeSubmit: spec.stopBeforeSubmit !== false,
    submitButtons,
    elapsedMs: Date.now() - t0,
  };

  if (spec.returnSnapshot) {
    const snap = await inspectCompact(
      page,
      { mode: spec.snapshotMode || 'forms', maxChars: spec.snapshotMaxChars || 2500 },
      previousLinesSet
    );
    output.snapshot = snap.text;
    output.elapsedMs = Date.now() - t0;
  }

  return output;
}

async function executeSingleAction(page, params = {}) {
  const action = params.action;
  if (!action) throw new Error('act_fast requires action.');
  const timeout = Number(params.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const allowSubmit = resolveAllowSubmit(params.allowSubmit);

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
      const urlRe = compileFilterRegex(params.url);
      await page.waitForURL(urlRe, { timeout });
      return { ok: true, action, url: page.url() };
    }
    if (params.textGone) {
      const frames = getAllFrames(page);
      let foundLoc = null;
      for (const f of frames) {
        const loc = f.frame.getByText(params.textGone, { exact: false }).first();
        if ((await loc.count().catch(() => 0)) > 0) {
          foundLoc = loc;
          break;
        }
      }
      if (foundLoc) {
        await foundLoc.waitFor({ state: 'hidden', timeout });
      }
      return { ok: true, action, textGone: params.textGone };
    }
    if (params.selector || params.ref || params.text) {
      const target = await resolveTarget(page, params);
      await target.locator.waitFor({ state: params.state || 'visible', timeout });
      return { ok: true, action, waitedFor: params.ref || params.selector || params.text };
    }
    const ms = Math.min(Number(params.ms) || 500, 15000);
    await page.waitForTimeout(ms);
    return { ok: true, action, ms };
  }

  if (action === 'press') {
    if (!params.key) throw new Error('press action requires key.');
    if (params.ref || params.selector || params.text) {
      const target = await resolveTarget(page, params);
      if (params.key === 'Enter' && !allowSubmit) {
        const meta = await isSubmitLikeElement(target.locator);
        if (meta.isSubmit) {
          return {
            ok: false,
            blocked: true,
            action,
            label: meta.label,
            reason: 'Submit guard: allowSubmit=false blocks pressing Enter on submit-like control.',
          };
        }
      }
      await target.locator.press(params.key, { timeout });
      return { ok: true, action, key: params.key };
    }
    await page.keyboard.press(params.key);
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
      }
      await withModifiers(page, modifiers, async () => {
        await page.mouse.click(px, py, { button, clickCount: action === 'dblclick' ? 2 : 1 });
      });
      return { ok: true, action, x: px, y: py, button, modifiers };
    }
    if (action === 'hover') {
      await withModifiers(page, modifiers, async () => {
        await page.mouse.move(px, py);
      });
      return { ok: true, action, x: px, y: py, modifiers };
    }
    if (action === 'drop') {
      const handle = await page.evaluateHandle(([cx, cy]) => document.elementFromPoint(cx, cy), [px, py]);
      try {
        const empty = await handle.evaluate((el) => !el).catch(() => true);
        if (empty) throw new Error(`No element found at drop coordinates (${px}, ${py}).`);
        const info = await performDropAction(handle, params);
        return { ok: true, action, x: px, y: py, ...info };
      } finally {
        await handle.dispose().catch(() => {});
      }
    }
  }

  const target = await resolveTarget(page, params);
  const { locator, frameIdx } = target;

  if (action === 'drag') {
    const dest = await resolveTarget(page, {
      ref: params.targetRef,
      selector: params.targetSelector,
      text: params.targetText,
      frameIdx: params.targetFrameIdx,
    });
    await locator.dragTo(dest.locator, { timeout });
    return { ok: true, action, frameIdx, targetFrameIdx: dest.frameIdx };
  }

  if (action === 'drop') {
    const info = await performDropAction(locator, params);
    return { ok: true, action, frameIdx, ...info };
  }

  if (action === 'click' || action === 'dblclick') {
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
    }
    const clickOpts = {
      timeout,
      button,
      ...(modifiers.length ? { modifiers } : {}),
      ...(hasCoords ? { position: { x: Number(params.x), y: Number(params.y) } } : {}),
    };
    if (action === 'dblclick') await locator.dblclick(clickOpts);
    else await locator.click(clickOpts);
    return { ok: true, action, frameIdx, button, ...(modifiers.length ? { modifiers } : {}) };
  }

  if (action === 'hover') {
    const hoverOpts = {
      timeout,
      ...(modifiers.length ? { modifiers } : {}),
      ...(hasCoords ? { position: { x: Number(params.x), y: Number(params.y) } } : {}),
    };
    await locator.hover(hoverOpts);
    return { ok: true, action, frameIdx, ...(modifiers.length ? { modifiers } : {}) };
  }

  if (action === 'focus') {
    await locator.focus({ timeout });
    return { ok: true, action, frameIdx };
  }

  if (action === 'clear') {
    await locator.fill('', { timeout });
    return { ok: true, action, frameIdx };
  }

  if (action === 'fill') {
    const val = String(params.value ?? '');
    await locator.fill(val, { timeout });
    return { ok: true, action, frameIdx, length: val.length };
  }

  if (action === 'type') {
    if (params.submit && !allowSubmit) {
      return {
        ok: false,
        blocked: true,
        action,
        frameIdx,
        reason: 'Submit guard: blocked type with submit=true because allowSubmit=false.',
      };
    }
    const val = String(params.value ?? '');
    if (params.slowly === false && !params.delayMs) {
      await locator.fill(val, { timeout });
    } else {
      const delay = params.delayMs !== undefined ? Number(params.delayMs) || 0 : (params.slowly ? 35 : 0);
      await locator.click({ timeout });
      await page.keyboard.type(val, { delay });
    }
    if (params.submit) {
      await page.keyboard.press('Enter');
    }
    return { ok: true, action, frameIdx, length: val.length, submitted: Boolean(params.submit) };
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
    const chosen = await locator.selectOption(spec, { timeout });
    return { ok: true, action, frameIdx, chosen };
  }

  if (action === 'check' || action === 'uncheck') {
    if (action === 'check') await locator.check({ timeout });
    else await locator.uncheck({ timeout });
    return { ok: true, action, frameIdx };
  }

  if (action === 'upload') {
    const raw = params.files || (params.file ? [params.file] : null);
    if (!raw || raw.length === 0) throw new Error('upload action requires file or files path.');
    const paths = raw.map((p) => path.resolve(String(p)));
    for (const p of paths) {
      if (!fs.existsSync(p)) throw new Error(`File not found on disk: ${p}`);
    }
    const isFileInput = await locator.evaluate((el) => el.tagName === 'INPUT' && el.type === 'file');
    if (isFileInput) {
      await locator.setInputFiles(paths);
    } else {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout }),
        locator.click({ timeout }),
      ]);
      await chooser.setFiles(paths);
    }
    return { ok: true, action, frameIdx, files: paths.map((p) => path.basename(p)) };
  }

  throw new Error(`Unsupported act_fast action: ${action}`);
}

/**
 * Execute one interactive action with human-in-the-loop submit protection and optional 1-turn snapshot.
 */
export async function actFast(page, params = {}, previousLinesSet = null) {
  const t0 = Date.now();
  const res = await executeSingleAction(page, params);
  if (params.returnSnapshot && !res.blocked) {
    const snap = await inspectCompact(
      page,
      { mode: params.snapshotMode || 'interactive', maxChars: params.snapshotMaxChars || 2500 },
      previousLinesSet
    );
    res.snapshot = snap.text;
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
  const continueOnError = Boolean(options.continueOnError);
  const defaultAllowSubmit = resolveAllowSubmit(options.allowSubmit);
  const results = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    try {
      let stepResult;
      if (step.action === 'smart_fill_form' || step.action === 'fill_form') {
        stepResult = await smartFillForm(page, step, previousLinesSet);
      } else {
        stepResult = await executeSingleAction(page, {
          ...step,
          allowSubmit: step.allowSubmit ?? defaultAllowSubmit,
        });
      }
      results.push({ step: i, ...stepResult });
      if (stepResult.blocked && !continueOnError) {
        return {
          completed: results.length,
          total: steps.length,
          blocked: true,
          elapsedMs: Date.now() - t0,
          results,
        };
      }
    } catch (err) {
      results.push({ step: i, ok: false, action: step.action, error: err.message });
      if (!continueOnError) {
        return {
          completed: i,
          total: steps.length,
          blocked: false,
          error: err.message,
          elapsedMs: Date.now() - t0,
          results,
        };
      }
    }
  }

  const out = {
    completed: results.length,
    total: steps.length,
    blocked: false,
    results,
  };

  if (options.returnSnapshot) {
    const snap = await inspectCompact(
      page,
      { mode: options.snapshotMode || 'interactive', maxChars: options.snapshotMaxChars || 2500 },
      previousLinesSet
    );
    out.snapshot = snap.text;
  }

  out.elapsedMs = Date.now() - t0;
  return out;
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
  const sections = [];

  for (const frameInfo of frames) {
    let part = '';
    try {
      part = await frameInfo.frame.evaluate(({ sel, fmt }) => {
        const root = sel
          ? document.querySelector(sel)
          : document.querySelector('main, article, [role="main"]') || document.body;
        if (!root) return '';
        const clone = root.cloneNode(true);
        for (const bad of clone.querySelectorAll('script, style, noscript, svg, template')) {
          bad.remove();
        }
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

        if (fmt === 'markdown') {
          const out = [];
          const blocks = clone.querySelectorAll('h1, h2, h3, h4, p, li, tr');
          if (blocks.length > 0) {
            for (const node of blocks) {
              const tag = node.tagName.toLowerCase();
              if (tag === 'p' && node.closest('li')) continue;
              if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') {
                const level = '#'.repeat(Number(tag[1]));
                const txt = clean(node.innerText || node.textContent);
                if (txt) out.push(`${level} ${txt}`);
              } else if (tag === 'li') {
                const txt = clean(node.innerText || node.textContent);
                if (txt) out.push(`- ${txt}`);
              } else if (tag === 'tr') {
                const cells = [...node.querySelectorAll('th, td')].map((c) => clean(c.innerText || c.textContent));
                if (cells.length > 0) out.push(`| ${cells.join(' | ')} |`);
              } else {
                const rendered = [...node.childNodes]
                  .map((child) => {
                    if (child.nodeType === 1 && child.tagName === 'A' && child.getAttribute('href')) {
                      const label = clean(child.innerText || child.textContent);
                      return label ? `[${label}](${child.getAttribute('href')})` : '';
                    }
                    return child.textContent || '';
                  })
                  .join(' ');
                const txt = clean(rendered);
                if (txt) out.push(txt);
              }
            }
            return out.join('\n');
          }
        }

        return (clone.innerText || clone.textContent || '')
          .split('\n')
          .map((line) => line.replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join('\n');
      }, { sel: frameInfo.isMain ? selector : null, fmt: format });
    } catch {
      part = '';
    }
    if (part) {
      sections.push(frameInfo.isMain ? part : `[iframe f${frameInfo.frameIdx}]\n${part}`);
    }
  }

  const title = await page.title().catch(() => '');
  const header = `URL: ${page.url()}\nTitle: ${title}\n\n`;
  const joined = sections.join('\n\n');
  const full = `${header}${joined}`;
  const truncated = full.length > maxChars;
  const text = truncated ? `${full.slice(0, Math.max(0, maxChars - 20))}\n... [truncated]` : full;
  const savedPath = writeSaveFile(options.savePath, text);

  return {
    text,
    url: page.url(),
    title,
    format,
    truncated,
    charCount: text.length,
    savePath: savedPath,
  };
}

/**
 * Evaluate JavaScript expression/function inside a target frame or element (passing el, arg) and optionally save output.
 */
export async function evaluateJs(page, { expression, frameIdx = 0, arg, ref, selector, text, savePath } = {}) {
  if (!expression || typeof expression !== 'string') {
    throw new Error('evaluate_js requires an expression string.');
  }

  let resolvedFrameIdx = frameIdx;
  let result;

  if (ref || selector || text) {
    const target = await resolveTarget(page, { ref, selector, text, frameIdx });
    resolvedFrameIdx = target.frameIdx;
    result = await target.locator.evaluate(
      async (el, { code, payload }) => {
        let val;
        try {
          val = new Function('el', 'arg', `return (${code});`)(el, payload);
        } catch {
          val = new Function('el', 'arg', code)(el, payload);
        }
        if (typeof val === 'function') {
          return await val(el, payload);
        }
        return await val;
      },
      { code: expression, payload: arg }
    );
  } else {
    const frames = getAllFrames(page);
    const target = frames.find((f) => f.frameIdx === frameIdx) || frames[0];
    if (!target) throw new Error(`Frame ${frameIdx} not found.`);
    resolvedFrameIdx = target.frameIdx;
    result = await target.frame.evaluate(
      async ({ code, payload }) => {
        let val;
        try {
          val = new Function('arg', `return (${code});`)(payload);
        } catch {
          val = new Function('arg', code)(payload);
        }
        if (typeof val === 'function') {
          return await val(payload);
        }
        return await val;
      },
      { code: expression, payload: arg }
    );
  }

  const serialized = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  const savedPath = writeSaveFile(savePath, serialized ?? 'null');
  return { frameIdx: resolvedFrameIdx, result, savePath: savedPath };
}

/**
 * Capture full-page/element screenshots (png/jpeg) or PDF export safely to cwd-resolved paths.
 */
export async function capturePage(page, params = {}) {
  const mode = params.mode === 'pdf' ? 'pdf' : 'screenshot';
  const timeout = Number(params.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const resolvedPath = params.savePath
    ? path.resolve(process.cwd(), String(params.savePath))
    : null;

  if (resolvedPath) {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }

  if (mode === 'pdf') {
    let pdfBuf;
    try {
      pdfBuf = await page.pdf({ format: 'A4', printBackground: true });
    } catch {
      const client = await page.context().newCDPSession(page);
      try {
        const { data } = await client.send('Page.printToPDF', { printBackground: true });
        pdfBuf = Buffer.from(data, 'base64');
      } finally {
        await client.detach().catch(() => {});
      }
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
