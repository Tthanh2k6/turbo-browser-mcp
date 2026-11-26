import fs from 'node:fs';

/**
 * Secret placeholders. With TURBO_BROWSER_SECRETS_FILE (or --secrets <path>) set to a dotenv-format
 * file, a value that is exactly `$secret:NAME` in a fill/type/smart_fill_form value is replaced by the
 * real value at the moment of typing, and every tool result and error has real values replaced back
 * with the placeholder before it leaves the server. Nothing here runs, and nothing is read, when the
 * variable is not set.
 */

const PLACEHOLDER_RE = /^\$secret:([A-Za-z_][A-Za-z0-9_.-]*)$/;
const MIN_REDACT_LENGTH = 4; // shorter values would shred ordinary output
// Argument keys whose string values may carry a placeholder (typed text, never selectors or labels).
const VALUE_KEYS = new Set(['value', 'values', 'option', 'main', 'body']);

let cache = null; // { file, mtimeMs, map, redactors }

export function parseDotenv(text) {
  const out = new Map();
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let val = m[2];
    if (val.startsWith('"')) {
      const end = val.indexOf('"', 1);
      let inner = '';
      let i = 1;
      for (; i < val.length; i++) {
        if (val[i] === '\\' && i + 1 < val.length) {
          const nx = val[i + 1];
          inner += nx === 'n' ? '\n' : nx === 'r' ? '\r' : nx === 't' ? '\t' : nx;
          i++;
        } else if (val[i] === '"') break;
        else inner += val[i];
      }
      val = end === -1 ? val.slice(1) : inner;
    } else if (val.startsWith("'")) {
      const end = val.indexOf("'", 1);
      val = end === -1 ? val.slice(1) : val.slice(1, end);
    } else {
      val = val.replace(/\s+#.*$/, '').trim();
    }
    out.set(m[1], val);
  }
  return out;
}

function buildRedactors(map) {
  const list = [];
  for (const [name, value] of map) {
    if (value.length < MIN_REDACT_LENGTH) continue;
    const forms = new Set([value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]);
    for (const f of forms) list.push({ needle: f, placeholder: `$secret:${name}` });
  }
  // Longest first so a secret that contains another one is replaced as a whole.
  list.sort((a, b) => b.needle.length - a.needle.length);
  return list;
}

/** Returns { map, redactors } or null when no secrets file is configured. */
export function getSecrets() {
  const file = process.env.TURBO_BROWSER_SECRETS_FILE;
  if (!file) return null;
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    throw new Error('TURBO_BROWSER_SECRETS_FILE is set but the file cannot be read.');
  }
  if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs) return cache;
  const map = parseDotenv(fs.readFileSync(file, 'utf8'));
  cache = { file, mtimeMs: st.mtimeMs, map, redactors: buildRedactors(map) };
  return cache;
}

export const DEFAULT_REDACT_URL_PARAMS = [
  'access_token',
  'id_token',
  'refresh_token',
  'code',
  'api_key',
  'apikey',
  'token',
  'secret',
];

export function getRedactUrlParams(custom) {
  const raw = custom !== undefined ? custom : process.env.TURBO_BROWSER_REDACT_URL_PARAMS;
  if (raw === false) return [];
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  if (raw === undefined || raw === null || raw === true) return DEFAULT_REDACT_URL_PARAMS;
  const trimmed = String(raw).trim();
  if (!trimmed || /^(1|true|yes|on|default)$/i.test(trimmed)) return DEFAULT_REDACT_URL_PARAMS;
  if (/^(0|false|no|off|none)$/i.test(trimmed)) return [];
  if (trimmed.startsWith('=')) {
    return trimmed.slice(1).split(',').map((s) => s.trim()).filter(Boolean);
  }
  const extra = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set([...DEFAULT_REDACT_URL_PARAMS, ...extra])];
}

/** Mask sensitive query/fragment parameters in URLs or text containing URLs with <redacted>. */
export function redactUrlParams(text, paramList = getRedactUrlParams()) {
  if (typeof text !== 'string' || !text || !paramList || paramList.length === 0) return text;
  const escaped = paramList
    .map((p) => String(p).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .filter(Boolean);
  if (escaped.length === 0) return text;
  const re = new RegExp(`([?&#])(${escaped.join('|')})=(?:<redacted>|([^&#\\s"'\\\\>)\\]]*))`, 'gi');
  return text.replace(re, (full, sep, key, val) => {
    if (val === undefined || val === '') return full;
    return `${sep}${key}=<redacted>`;
  });
}

/** Replace real secret values in text with their placeholders and mask sensitive URL query params. */
export function redactText(text, secrets = getSecrets()) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  if (secrets) {
    for (const { needle, placeholder } of secrets.redactors) {
      if (out.includes(needle)) out = out.split(needle).join(placeholder);
    }
  }
  return redactUrlParams(out);
}

/**
 * Copy of args with `$secret:NAME` values replaced by real values. Unknown names throw (key only).
 * Returns the same object when nothing needed replacing.
 */
export function resolveSecretArgs(args, secrets = getSecrets()) {
  if (!secrets) return args;
  const walk = (node, key) => {
    if (typeof node === 'string') {
      if (!VALUE_KEYS.has(key)) return node;
      const m = PLACEHOLDER_RE.exec(node);
      if (!m) return node;
      if (!secrets.map.has(m[1])) throw new Error(`Unknown secret: ${m[1]}`);
      return secrets.map.get(m[1]);
    }
    if (Array.isArray(node)) {
      // Array items inherit the key (values: [...] and option: [...]).
      let changed = false;
      const next = node.map((x) => {
        const y = walk(x, key);
        if (y !== x) changed = true;
        return y;
      });
      return changed ? next : node;
    }
    if (node && typeof node === 'object') {
      let changed = false;
      const next = {};
      for (const [k, v] of Object.entries(node)) {
        const y = walk(v, k);
        if (y !== v) changed = true;
        next[k] = y;
      }
      return changed ? next : node;
    }
    return node;
  };
  return walk(args, '');
}
