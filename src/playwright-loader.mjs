import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridgeUrlWithToken, getRunningBridgeInfo } from './cdp-bridge.mjs';

let cachedPw = null;

function collectPlaywrightCandidates() {
  const roots = [
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules') : '',
    '/usr/local/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
    path.join(os.homedir(), '.local', 'share', 'npm', 'lib', 'node_modules'),
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'),
    path.join(os.homedir(), '.nvm', 'versions', 'node', process.version, 'lib', 'node_modules'),
  ].filter(Boolean);

  const out = [];
  if (process.env.PLAYWRIGHT_CORE_PATH) out.push(process.env.PLAYWRIGHT_CORE_PATH);
  for (const root of roots) {
    out.push(
      path.join(root, 'playwright-core', 'index.mjs'),
      path.join(root, '@playwright', 'mcp', 'node_modules', 'playwright-core', 'index.mjs'),
      path.join(root, 'playwright', 'node_modules', 'playwright-core', 'index.mjs')
    );
  }
  return out;
}

/**
 * Resolve playwright-core from local node_modules or global npm installations
 * (Windows, macOS, and Linux) to avoid redundant downloads.
 */
export async function loadPlaywright() {
  if (cachedPw) return cachedPw;

  try {
    cachedPw = await import('playwright-core');
    return cachedPw;
  } catch {
    // Fallback to global installs when running standalone without local node_modules.
  }

  for (const candidate of collectPlaywrightCandidates()) {
    if (fs.existsSync(candidate)) {
      cachedPw = await import(pathToFileURL(candidate).href);
      return cachedPw;
    }
  }

  throw new Error(
    'playwright-core not found. Install playwright-core (`npm i -g playwright-core`) or set PLAYWRIGHT_CORE_PATH.'
  );
}

function getCacheBinCandidates(cacheDir, dirName) {
  const base = path.join(cacheDir, dirName);
  return [
    path.join(base, 'chrome-win64', 'chrome.exe'),
    path.join(base, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
    path.join(base, 'chrome-win', 'chrome.exe'),
    path.join(base, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    path.join(base, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    path.join(base, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    path.join(base, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
    path.join(base, 'chrome-headless-shell-mac-x64', 'chrome-headless-shell'),
    path.join(base, 'chrome-linux', 'chrome'),
    path.join(base, 'chrome-linux64', 'chrome'),
    path.join(base, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
  ];
}

function getSystemBrowserPaths() {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    return [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      localAppData ? path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ].filter(Boolean);
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
  ];
}

/**
 * Find the newest existing Chromium/Chrome/Edge binary across Windows, macOS, and Linux.
 */
export function resolveChromiumExecutable(chromium, headless = true) {
  if (process.env.TURBO_BROWSER_EXECUTABLE && fs.existsSync(process.env.TURBO_BROWSER_EXECUTABLE)) {
    return { executablePath: process.env.TURBO_BROWSER_EXECUTABLE };
  }

  try {
    const nativePath = chromium?.executablePath?.();
    if (nativePath && fs.existsSync(nativePath)) {
      return { executablePath: nativePath };
    }
  } catch {
    // Ignore missing default revision and inspect cache/system browsers below.
  }

  const cacheDirs = [
    process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0'
      ? process.env.PLAYWRIGHT_BROWSERS_PATH
      : '',
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
        : path.join(os.homedir(), '.cache', 'ms-playwright'),
  ].filter(Boolean);

  for (const cacheDir of cacheDirs) {
    if (!fs.existsSync(cacheDir)) continue;
    const parseRev = (name) => {
      const m = /-(\d+)$/.exec(name);
      return m ? Number(m[1]) : -1;
    };
    const prefixes = headless ? ['chromium_headless_shell-', 'chromium-'] : ['chromium-'];
    const prefixRank = (name) => {
      const idx = prefixes.findIndex((p) => name.startsWith(p));
      return idx >= 0 ? idx : prefixes.length;
    };
    const dirs = fs.readdirSync(cacheDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && prefixes.some((p) => d.name.startsWith(p)))
      .map((d) => d.name)
      .sort((a, b) => {
        const diff = parseRev(b) - parseRev(a);
        if (diff !== 0) return diff;
        const pDiff = prefixRank(a) - prefixRank(b);
        return pDiff !== 0 ? pDiff : b.localeCompare(a);
      });

    for (const dirName of dirs) {
      const hit = getCacheBinCandidates(cacheDir, dirName).find((p) => fs.existsSync(p));
      if (hit) return { executablePath: hit };
    }
  }

  for (const exePath of getSystemBrowserPaths()) {
    if (fs.existsSync(exePath)) {
      return { executablePath: exePath };
    }
  }

  return {};
}

function isTcpPortOpen(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

function getDefaultUserDataDirs() {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    if (!localAppData) return [];
    return [
      path.join(localAppData, 'Google', 'Chrome', 'User Data'),
      path.join(localAppData, 'Microsoft', 'Edge', 'User Data'),
      path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data'),
    ];
  }
  if (process.platform === 'darwin') {
    const appSupport = path.join(os.homedir(), 'Library', 'Application Support');
    return [
      path.join(appSupport, 'Google', 'Chrome'),
      path.join(appSupport, 'Microsoft Edge'),
      path.join(appSupport, 'BraveSoftware', 'Brave-Browser'),
      path.join(appSupport, 'Chromium'),
    ];
  }
  const cfg = path.join(os.homedir(), '.config');
  return [
    path.join(cfg, 'google-chrome'),
    path.join(cfg, 'chromium'),
    path.join(cfg, 'microsoft-edge'),
    path.join(cfg, 'BraveSoftware', 'Brave-Browser'),
  ];
}

/** True when a DevToolsActivePort file exists (Chrome 144+ "Allow remote debugging" flow: the first connect needs a human click). */
export function hasDevToolsActivePort(userDataDir = '', cdpUrl = 'http://127.0.0.1:9222') {
  const isDefaultLocalCdp = /^https?:\/\/(127\.0\.0\.1|localhost):9222\/?$/i.test(String(cdpUrl || '').trim());
  const inNodeTest = Boolean(process.env.NODE_TEST_CONTEXT) || process.execArgv.includes('--test');
  const dirs = [userDataDir ? path.resolve(userDataDir) : '', ...(!inNodeTest && isDefaultLocalCdp ? getDefaultUserDataDirs() : [])].filter(Boolean);
  return dirs.some((d) => fs.existsSync(path.join(d, 'DevToolsActivePort')));
}

/** How long auto mode waits for the first CDP connect: 45 s when a person must click Allow, else 10 s. An explicit option wins. */
export function cdpConnectWaitMs({ optionMs, human, env = process.env } = {}) {
  if (optionMs) return optionMs;
  if (!human) return 10000;
  return Number(env.TURBO_BROWSER_ALLOW_WAIT_MS) > 0 ? Number(env.TURBO_BROWSER_ALLOW_WAIT_MS) : 45000;
}

/**
 * Resolve an active CDP HTTP or WebSocket endpoint. Supports both classic
 * `--remote-debugging-port` (`/json/version`) and Chrome 144+
 * `chrome://inspect/#remote-debugging` (`DevToolsActivePort` -> `ws://127.0.0.1:<port>/devtools/browser/<id>`).
 */
export async function resolveActiveCdpEndpoint(
  cdpUrl = process.env.TURBO_BROWSER_CDP_URL || 'http://127.0.0.1:9222',
  userDataDir = process.env.TURBO_BROWSER_USER_DATA_DIR || ''
) {
  const raw = bridgeUrlWithToken(String(cdpUrl || 'http://127.0.0.1:9222').trim());
  if (raw.startsWith('ws://') || raw.startsWith('wss://')) {
    try {
      const parsed = new URL(raw);
      const port = Number(parsed.port) || (parsed.protocol === 'wss:' ? 443 : 80);
      if (await isTcpPortOpen(parsed.hostname || '127.0.0.1', port)) {
        return raw;
      }
    } catch {
      // Fall through
    }
    return null;
  }

  try {
    const versionUrl = new URL('/json/version', raw);
    versionUrl.search = new URL(raw).search;
    const res = await fetch(versionUrl.href, {
      signal: AbortSignal.timeout(800),
    });
    if (res.ok) return raw;
  } catch {
    // Fall through to DevToolsActivePort inspection when /json/version is disabled or unreachable.
  }

  const isDefaultLocalCdp = /^https?:\/\/(127\.0\.0\.1|localhost):9222\/?$/i.test(raw);
  const inNodeTest = Boolean(process.env.NODE_TEST_CONTEXT) || process.execArgv.includes('--test');

  if (!inNodeTest && isDefaultLocalCdp && process.env.TURBO_BROWSER_DISABLE_BRIDGE !== 'true') {
    const runningBridge = await getRunningBridgeInfo();
    if (runningBridge) {
      return runningBridge.bridgeHttpUrl;
    }
  }

  const candidateDirs = [
    userDataDir ? path.resolve(userDataDir) : '',
    ...(!inNodeTest && isDefaultLocalCdp ? getDefaultUserDataDirs() : []),
  ].filter(Boolean);

  for (const dir of candidateDirs) {
    const portFile = path.join(dir, 'DevToolsActivePort');
    if (!fs.existsSync(portFile)) continue;
    try {
      const lines = fs
        .readFileSync(portFile, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length < 2) continue;
      const port = Number.parseInt(lines[0], 10);
      const wsPath = lines[1];
      if (!Number.isInteger(port) || port <= 0 || port > 65535 || !wsPath.startsWith('/')) {
        continue;
      }
      if (await isTcpPortOpen('127.0.0.1', port)) {
        return `ws://127.0.0.1:${port}${wsPath}`;
      }
    } catch {
      // Ignore unreadable DevToolsActivePort candidate.
    }
  }

  return null;
}

/**
 * Probe whether a ws:// CDP endpoint (Chrome 136+/144+ DevToolsActivePort) is open on TCP
 * but hanging before WebSocket upgrade response because Chrome is waiting for the user
 * to click "Allow" on the "Allow remote debugging?" dialog.
 */
export function probeCdpPendingApproval(endpoint, timeoutMs = 450) {
  if (!endpoint || (!endpoint.startsWith('ws://') && !endpoint.startsWith('wss://'))) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(endpoint);
    } catch {
      resolve(false);
      return;
    }
    const host = parsed.hostname || '127.0.0.1';
    const port = Number(parsed.port) || 9222;
    const socket = new net.Socket();
    let connected = false;
    let settled = false;
    const finish = (pending) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(pending);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      connected = true;
      const reqLines = [
        `GET ${parsed.pathname || '/'}${parsed.search || ''} HTTP/1.1`,
        `Host: ${parsed.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '\r\n',
      ].join('\r\n');
      socket.write(reqLines);
    });
    socket.once('data', () => finish(false));
    socket.once('timeout', () => finish(connected));
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
    socket.connect(port, host);
  });
}

/**
 * Inspect local Node, Playwright, Chromium binary, and CDP reachability for `--doctor`.
 */
export async function diagnoseEnvironment(
  cdpUrl = process.env.TURBO_BROWSER_CDP_URL || 'http://127.0.0.1:9222'
) {
  let playwrightLoaded = false;
  let playwrightError = null;
  let executablePath = null;

  try {
    const pw = await loadPlaywright();
    playwrightLoaded = true;
    const resolved = resolveChromiumExecutable(pw.chromium, process.env.TURBO_BROWSER_HEADLESS !== 'false');
    executablePath = resolved.executablePath || null;
  } catch (err) {
    playwrightError = String(err?.message || err);
  }

  const resolvedEndpoint = await resolveActiveCdpEndpoint(cdpUrl);
  const cdpReachable = Boolean(resolvedEndpoint);
  const cdpPendingApproval =
    resolvedEndpoint && /^wss?:\/\//i.test(resolvedEndpoint)
      ? await probeCdpPendingApproval(resolvedEndpoint, 450)
      : false;

  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    playwrightLoaded,
    ...(playwrightError ? { playwrightError } : {}),
    executablePath,
    cdpUrl: resolvedEndpoint || cdpUrl,
    cdpReachable,
    ...(cdpPendingApproval ? { cdpPendingApproval: true } : {}),
  };
}
