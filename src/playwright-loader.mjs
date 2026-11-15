import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

  let cdpReachable = false;
  try {
    const res = await fetch(new URL('/json/version', cdpUrl).href, {
      signal: AbortSignal.timeout(800),
    });
    cdpReachable = res.ok;
  } catch {
    cdpReachable = false;
  }

  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    playwrightLoaded,
    ...(playwrightError ? { playwrightError } : {}),
    executablePath,
    cdpUrl,
    cdpReachable,
  };
}
