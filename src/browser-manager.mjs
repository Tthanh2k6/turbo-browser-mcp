import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkBridgeHealth, DEFAULT_BRIDGE_PORT, ensureCdpBridgeDaemon, probeBridge, redactBridgeToken } from './cdp-bridge.mjs';
import { cdpRawCall } from './cdp-raw.mjs';
import { resolveSafePath } from './dom-engine.mjs';
import { gotoRetry, navHealth } from './navinfo.mjs';
import { redactText } from './secrets.mjs';
import { getPolicy, installGuard, takeBlocked, peekBlocked, urlDenial, denyMessage, matchUrl } from './allow-hosts.mjs';

const firstLine = (err) => String((err && err.message) || err).split(/\r?\n/)[0];
import {
  loadPlaywright,
  cdpConnectWaitMs,
  hasDevToolsActivePort,
  resolveActiveCdpEndpoint,
  resolveChromiumExecutable,
} from './playwright-loader.mjs';

const CONSOLE_RING_LIMIT = 80;
const REQUEST_RING_LIMIT = 100;
const DIALOG_RING_LIMIT = 50;
const DOWNLOAD_RING_LIMIT = 20;
const ERROR_CONSOLE_LEVELS = new Set(['error', 'warning', 'assert', 'pageerror']);
const STATIC_RESOURCE_TYPES = new Set(['image', 'font', 'stylesheet', 'media']);
const NETWORK_PRESETS = {
  turbo: {
    resources: ['image', 'font', 'media'],
    urls: [
      'doubleclick.net',
      'googlesyndication.com',
      'google-analytics.com',
      'googletagmanager.com',
      'connect.facebook.net',
      'hotjar.com',
      'mixpanel.com',
      'segment.io',
    ],
  },
  'no-images': { resources: ['image'], urls: [] },
  'no-media': { resources: ['image', 'media', 'font'], urls: [] },
};

function pushRing(arr, item, limit, onEvict) {
  arr.push(item);
  if (arr.length > limit) {
    const evicted = arr.splice(0, arr.length - limit);
    if (onEvict) {
      for (const old of evicted) onEvict(old);
    }
  }
}

function compileUrlPattern(pattern) {
  const raw = String(pattern ?? '').trim();
  if (!raw) {
    return {
      source: '',
      test() {
        return false;
      },
    };
  }
  const rawLower = raw.toLowerCase();
  let globRe = null;
  if (
    raw.includes('*') &&
    !/\\[dwsbDWSB.]|\.\*|\.\+|^\^|\$$/.test(raw)
  ) {
    const globSource = raw.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    globRe = new RegExp(globSource, 'i');
  }
  let regRe = null;
  try {
    regRe = new RegExp(raw, 'i');
  } catch {
    regRe = null;
  }
  return {
    source: globRe?.source ?? regRe?.source ?? raw,
    test(val) {
      const s = String(val || '');
      if (raw && s.toLowerCase().includes(rawLower)) return true;
      if (globRe) return globRe.test(s);
      if (regRe) return regRe.test(s);
      return false;
    },
  };
}

/**
 * Manages Chromium lifecycle (CDP attach, persistent profile, or headless/headed launch),
 * integer tab IDs, per-page diagnostics, dialog handling, and network/session state.
 */
export class BrowserManager {
  constructor(options = {}) {
    this.mode = options.mode ?? process.env.TURBO_BROWSER_MODE ?? 'auto';
    this.cdpUrl = options.cdpUrl ?? process.env.TURBO_BROWSER_CDP_URL ?? 'http://127.0.0.1:9222';
    this.userDataDir = options.userDataDir ?? process.env.TURBO_BROWSER_USER_DATA_DIR ?? '';
    this.headless =
      options.headless ?? (process.env.TURBO_BROWSER_HEADLESS !== 'false');
    this.defaultTimeoutMs =
      options.defaultTimeoutMs ?? (Number(process.env.TURBO_BROWSER_TIMEOUT_MS) || 15000);
    this.isolateHosts = String(options.isolateHosts ?? process.env.TURBO_BROWSER_ISOLATE_HOSTS ?? '')
      .split(',').map((s) => s.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean);
    this.nextAutoContextId = 1;

    this.browser = null;
    this.context = null;
    this.connectionType = null;
    this.initPromise = null;

    this.nextTabId = 1;
    this.activeTabId = null;
    this.tabs = new Map();
    this.isolatedContexts = new Map();
    this._foreignPages = new WeakSet();
    this._unknownContextPages = new WeakSet();
    this.tabContextName = new Map();
    this.pageToId = new WeakMap();
    this.attachedPages = new WeakSet();
    this.diagnostics = new WeakMap();
    this.tempDownloadFiles = new Set();
    this.connectionNote = '';
    this.degradedReason = '';
    this.cdpPendingApproval = false;
    this.cdpPendingHintMs = options.cdpPendingHintMs;
    this.onCdpPendingApproval = options.onCdpPendingApproval;
    this.bridgePort = options.bridgePort;
    this.cdpAutoTimeoutMs = options.cdpAutoTimeoutMs;
    this.bridgeRetryMs = options.bridgeRetryMs;
    // Tests inject a fake endpoint; node:test normally disables the bridge daemon.
    this.useBridge = options.useBridge;
  }

  /** One-shot: why auto mode ended up where it did. Returned once, then cleared. */
  takeConnectionNote() {
    const n = this.connectionNote;
    this.connectionNote = '';
    return n;
  }

  _note(msg) {
    this.connectionNote = this.connectionNote ? `${this.connectionNote}; ${msg}` : msg;
  }

  _resetBrowserState() {
    if (this.connectionType === 'cdp') this._lostCdp = true;
    this.context = null;
    this.browser = null;
    this.connectionType = null;
    this.tabs.clear();
    this.isolatedContexts.clear();
    this.tabContextName.clear();
    this.activeTabId = null;
  }

  async ensureReady() {
    if (
      this.browser &&
      typeof this.browser.isConnected === 'function' &&
      !this.browser.isConnected()
    ) {
      this._resetBrowserState();
    }
    if (this.context) return;
    if (!this.initPromise) {
      this.initPromise = this._init().finally(() => {
        this.initPromise = null;
      });
    }
    await this.initPromise;
  }

  async _canReachCdp() {
    const endpoint = await resolveActiveCdpEndpoint(this.cdpUrl, this.userDataDir);
    return Boolean(endpoint);
  }

  async _launchFallback(chromium) {
    const exeOpt = resolveChromiumExecutable(chromium, this.headless);
    const attempts = [
      { headless: this.headless, ...exeOpt },
      { headless: this.headless, channel: 'chrome' },
      { headless: this.headless, channel: 'msedge' },
      { headless: this.headless },
    ];
    let lastErr;
    for (const opts of attempts) {
      try {
        return await chromium.launch(opts);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  async _init() {
    const { chromium } = await loadPlaywright();
    const tm = { t0: Date.now() };
    const lap = (k) => { tm[k] = Date.now() - (tm.last || tm.t0); tm.last = Date.now(); };

    // A bridge whose Chrome is gone (or that no longer answers) must not linger or be mistaken for absent:
    // clear it quickly and remember it so a launch fallback can say why logged-in sites are missing.
    let bridgeLost = false;
    if (this.mode === 'auto' && process.env.TURBO_BROWSER_DISABLE_BRIDGE !== 'true' &&
        (this.bridgePort || this.useBridge || !(Boolean(process.env.NODE_TEST_CONTEXT) || process.execArgv.includes('--test')))) {
      try {
        const h = await checkBridgeHealth(this.bridgePort || undefined);
        bridgeLost = h.state === 'dead-upstream' || h.state === 'hung';
      } catch { /* health check is best effort */ }
    }

    const activeCdpEndpoint =
      this.mode === 'cdp' || this.mode === 'auto'
        ? await resolveActiveCdpEndpoint(this.cdpUrl, this.userDataDir)
        : null;

    if (this.mode === 'cdp' || (this.mode === 'auto' && activeCdpEndpoint)) {
      let targetEndpoint = activeCdpEndpoint || this.cdpUrl;
      // Chrome 144+ shows an Allow prompt on the first connect: give a person time to click it.
      const human = this.mode === 'auto' && Boolean(activeCdpEndpoint) && /^wss?:/.test(activeCdpEndpoint) &&
        hasDevToolsActivePort(this.userDataDir, this.cdpUrl);
      const isWsCdp = /^wss?:\/\//i.test(targetEndpoint) || human;
      const waitMs = cdpConnectWaitMs({ optionMs: this.cdpAutoTimeoutMs, human });
      if (human) process.stderr.write(`waiting for 'Allow' in Chrome (up to ${Math.round(waitMs / 1000)} s)
`);
      const hintDelay = Number.isFinite(Number(this.cdpPendingHintMs))
        ? Math.max(50, Number(this.cdpPendingHintMs))
        : Math.min(800, Math.max(200, Math.floor(waitMs / 3)));
      const pendingTimer = isWsCdp
        ? setTimeout(() => {
            this.cdpPendingApproval = true;
            try {
              this.onCdpPendingApproval?.({ endpoint: targetEndpoint, waitMs });
            } catch {}
            if (human) {
              process.stderr.write(
                `[turbo-browser-mcp] cdpPendingApproval: click "Allow" on Chrome's remote debugging prompt\n`
              );
            }
          }, hintDelay)
        : null;
      pendingTimer?.unref?.();
      lap('prep');
      let bridgeTimedOut = false;
      let usedBridge = false;
      const inNodeTest = this.useBridge ? false : Boolean(process.env.NODE_TEST_CONTEXT) || process.execArgv.includes('--test');
      if (
        !inNodeTest &&
        process.env.TURBO_BROWSER_DISABLE_BRIDGE !== 'true' &&
        (targetEndpoint.startsWith('ws://') || targetEndpoint.startsWith('wss://'))
      ) {
        const bridged = await ensureCdpBridgeDaemon(targetEndpoint, {
          timeoutMs: this.mode === 'auto' ? Math.max(12000, human ? waitMs + 2000 : 0) : Math.max(this.defaultTimeoutMs, 30000),
          ...(this.bridgePort ? { bridgePort: this.bridgePort } : {}),
          insecure: process.env.TURBO_BROWSER_BRIDGE_INSECURE === 'true',
          onNote: (n) => { if (/did not start/.test(n)) bridgeTimedOut = true; this._note(n); },
        });
        if (bridged) {
          targetEndpoint = bridged;
          usedBridge = true;
        }
      }
      lap('bridge');
      try {
        // auto falls back to launch, so it must not wait the full 20 s for a permission prompt nobody answers.
        const attach = (timeout) => chromium.connectOverCDP(targetEndpoint, { timeout });
        try {
          // After a bridge that waited the full Allow window, a direct retry would only prompt again: keep it short.
          this.browser = await attach(this.mode === 'auto' ? (bridgeTimedOut ? 3000 : Math.min(waitMs, 60000)) : Math.max(this.defaultTimeoutMs, 20000));
        } catch (firstErr) {
          // A live bridge is the owner's signed-in Chrome: attaching through it can be slow (every tab is attached on
          // the first client), so give it one longer try, and never swap it for a signed-out browser.
          const bridgePort = this.bridgePort || DEFAULT_BRIDGE_PORT;
          const alive = usedBridge && this.mode === 'auto' && (await probeBridge(bridgePort).catch(() => null))?.upstreamConnected === true;
          if (!alive) throw firstErr;
          const retryMs = this.bridgeRetryMs || 45000;
          try {
            this.browser = await attach(retryMs);
          } catch (retryErr) {
            throw new Error(`The CDP bridge on port ${bridgePort} is running but attaching through it failed (step: connect to the bridge, tried ${Math.round(waitMs / 1000)} s then ${Math.round(retryMs / 1000)} s: ${String(retryErr?.message || retryErr).split(String.fromCharCode(10))[0].slice(0, 120)}). Not opening a separate signed-out browser. Try again, or set TURBO_BROWSER_MODE=launch to use a fresh browser on purpose.`);
          }
        }
        clearTimeout(pendingTimer);
        this.cdpPendingApproval = false;
        lap('connect');
        this.connectionNote = '';
        this._cdpEndpoint = targetEndpoint;
        this.context = this.browser.contexts()[0] ?? (await this.browser.newContext());
        this.connectionType = 'cdp';
      } catch (err) {
        clearTimeout(pendingTimer);
        if (/^The CDP bridge on port/.test(String(err?.message))) throw err;
        const m = String(err?.message || err);
        const isApprovalTimeout = isWsCdp && (/timeout/i.test(m) || bridgeTimedOut);
        this.cdpPendingApproval = Boolean(isApprovalTimeout && (human || hasDevToolsActivePort(this.userDataDir, this.cdpUrl) || this.cdpPendingHintMs !== undefined));
        if (this.mode === 'auto') {
          this._note(/timeout/i.test(m)
            ? `cdp: no response within ${Math.round(waitMs / 1000)}s (Chrome may be waiting for 'Allow remote debugging')`
            : `cdp: ${m.slice(0, 120).split(String.fromCharCode(10))[0]}`);
        }
        if (this.mode === 'cdp') {
          throw new Error(
            `Failed to attach via CDP at ${redactBridgeToken(targetEndpoint)}. Enable chrome://inspect/#remote-debugging (and click Allow on the prompt) or start Chrome with --remote-debugging-port=9222. (${err.message})`
          );
        }
      }
    }

    if (!this.context && (this.mode === 'persistent' || (this.mode === 'auto' && this.userDataDir))) {
      if (!this.userDataDir) {
        throw new Error('TURBO_BROWSER_USER_DATA_DIR is required for persistent mode.');
      }
      const exeOpt = resolveChromiumExecutable(chromium, this.headless);
      this.context = await chromium.launchPersistentContext(this.userDataDir, {
        headless: this.headless,
        viewport: { width: 1280, height: 800 },
        ...exeOpt,
      });
      this.browser = this.context.browser();
      this.connectionType = 'persistent';
    }

    if (!this.context) {
      this.browser = await this._launchFallback(chromium);
      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 800 },
      });
      this.connectionType = 'launch';
    }

    if (bridgeLost && this.connectionType !== 'cdp') {
      this.connectionNote = `Chrome remote debugging is no longer available (bridge upstream closed); using ${this.headless ? 'a headless' : 'a separate'} browser. Logged-in sites will not be available.`;
      this.degradedReason = 'headless-fallback';
    } else if (this.connectionNote && this.connectionType !== 'cdp') {
      this.connectionNote = `${this.connectionType} fallback (${this.connectionNote})`;
      this.degradedReason = 'headless-fallback';
    } else if (this._lostCdp && this.connectionType !== 'cdp') {
      this.connectionNote = `The attached Chrome is gone (closed or disconnected); using ${this.headless ? 'a headless' : 'a separate'} ${this.connectionType} browser. Logged-in sites will not be available.`;
      this.degradedReason = 'headless-fallback';
    }
    if (this.connectionType === 'cdp') {
      this._lostCdp = false;
      this.degradedReason = '';
    }

    const currentBrowser = this.browser;
    const currentContext = this.context;
    if (currentBrowser && typeof currentBrowser.on === 'function') {
      currentBrowser.on('disconnected', () => {
        if (this.browser === currentBrowser) {
          this._resetBrowserState();
        }
      });
    }
    if (currentContext && typeof currentContext.on === 'function') {
      currentContext.on('close', () => {
        if (this.context === currentContext) {
          this._resetBrowserState();
        }
      });
    }

    this.context.setDefaultTimeout(this.defaultTimeoutMs);
    lap('launch');
    await this._installContextInitScript(this.context);
    lap('initScript');
    if (Date.now() - tm.t0 > 5000) {
      const parts = ['prep', 'bridge', 'connect', 'launch', 'initScript'].filter((k) => tm[k] > 500).map((k) => `${k} ${(tm[k] / 1000).toFixed(1)}s`);
      process.stderr.write(`turbo-browser: slow start (${((Date.now() - tm.t0) / 1000).toFixed(1)}s): ${parts.join(', ')}
`);
    }
    this.context.on('page', (page) => this._registerPage(page, true));
    for (const page of this.context.pages()) {
      this._registerPage(page, this.activeTabId === null);
    }
  }

  _shadowInitFn() {
    return () => {
      const installFormGuardOnWin = (w) => {
        if (!w || typeof w !== 'object') return;
        try {
          const proto = w.HTMLFormElement?.prototype;
          if (proto) {
            const readWinProp = (winObj, prop) => {
              try {
                return winObj ? winObj[prop] : undefined;
              } catch {
                return undefined;
              }
            };
            // Count suppressed submits so the tool can report them instead of returning a silent ok.
            const noteBlocked = () => {
              try {
                Object.defineProperty(w, '__tbmSilentSubmitBlocks', {
                  value: (Number(w.__tbmSilentSubmitBlocks) || 0) + 1,
                  writable: true,
                  enumerable: false,
                  configurable: true,
                });
              } catch {}
            };
            const resolveGuardState = (formEl) => {
              let fWin = w;
              try {
                fWin = formEl?.ownerDocument?.defaultView || w;
              } catch {}
              let parentWin = null;
              try {
                if (w.parent && w.parent !== w && typeof w.parent.document === 'object') parentWin = w.parent;
              } catch {}
              let topWin = null;
              try {
                if (w.top && w.top !== w && typeof w.top.document === 'object') topWin = w.top;
              } catch {}
              const wins = [fWin, w, parentWin, topWin];
              const guardOn = wins.some((winObj) => Number(readWinProp(winObj, '__tbmSubmitGuardActive')) > 0);
              const allowSafe = wins.some((winObj) => Boolean(readWinProp(winObj, '__tbmAllowSafeForm')));
              let checkSub;
              for (const winObj of wins) {
                const fn = readWinProp(winObj, '__tbmIsSafeSubmitter');
                if (typeof fn === 'function') {
                  checkSub = fn;
                  break;
                }
              }
              return { guardOn, allowSafe, checkSub };
            };
            const origSub = proto.submit;
            if (typeof origSub === 'function' && !origSub.__tbmProxy) {
              const proxySub = new Proxy(origSub, {
                apply(target, thisArg, args) {
                  const { guardOn, allowSafe } = resolveGuardState(thisArg);
                  if (guardOn) {
                    if (!(allowSafe && thisArg && thisArg.__tbmAllowedSubmit === true)) {
                      noteBlocked();
                      return undefined;
                    }
                  }
                  return Reflect.apply(target, thisArg, args);
                },
              });
              Object.defineProperty(proxySub, '__tbmProxy', { value: true, enumerable: false });
              proto.submit = proxySub;
            }
            const origReqSub = proto.requestSubmit;
            if (typeof origReqSub === 'function' && !origReqSub.__tbmProxy) {
              const proxyReqSub = new Proxy(origReqSub, {
                apply(target, thisArg, args) {
                  const { guardOn, allowSafe, checkSub } = resolveGuardState(thisArg);
                  if (guardOn) {
                    if (!(allowSafe && thisArg && thisArg.__tbmAllowedSubmit === true)) {
                      noteBlocked();
                      return undefined;
                    }
                    if (args.length > 0 && args[0] !== undefined && args[0] !== null) {
                      if (typeof checkSub !== 'function' || !checkSub(args[0])) {
                        noteBlocked();
                        return undefined;
                      }
                    }
                  }
                  return Reflect.apply(target, thisArg, args);
                },
              });
              Object.defineProperty(proxyReqSub, '__tbmProxy', { value: true, enumerable: false });
              proto.requestSubmit = proxyReqSub;
            }
          }
          const wrapFrameAccessor = (Ctor, prop, extractWin) => {
            const p = Ctor?.prototype;
            if (!p) return;
            const desc = Object.getOwnPropertyDescriptor(p, prop);
            if (!desc || typeof desc.get !== 'function' || desc.get.__tbmProxy) return;
            const proxyGet = new Proxy(desc.get, {
              apply(target, thisArg, args) {
                const res = Reflect.apply(target, thisArg, args);
                try {
                  const cw = extractWin(res);
                  if (cw) installFormGuardOnWin(cw);
                } catch {}
                return res;
              },
            });
            Object.defineProperty(proxyGet, '__tbmProxy', { value: true, enumerable: false });
            Object.defineProperty(p, prop, { ...desc, get: proxyGet });
          };
          wrapFrameAccessor(w.HTMLIFrameElement, 'contentWindow', (v) => v);
          wrapFrameAccessor(w.HTMLIFrameElement, 'contentDocument', (v) => v?.defaultView);
          wrapFrameAccessor(w.HTMLFrameElement, 'contentWindow', (v) => v);
          wrapFrameAccessor(w.HTMLFrameElement, 'contentDocument', (v) => v?.defaultView);
          wrapFrameAccessor(w.HTMLObjectElement, 'contentWindow', (v) => v);
          wrapFrameAccessor(w.HTMLObjectElement, 'contentDocument', (v) => v?.defaultView);
        } catch {}
      };
      installFormGuardOnWin(window);
      Object.defineProperty(window, '__tbmInstallFormGuard', {
        value: installFormGuardOnWin,
        configurable: true,
        enumerable: false,
      });
      const origAttach = Element.prototype.attachShadow;
      if (!origAttach || origAttach.__tbmProxy) return;
      const closedRoots = new WeakMap();
      const allRootRefs = new Set();
      const registry =
        typeof FinalizationRegistry === 'function'
          ? new FinalizationRegistry((ref) => {
              allRootRefs.delete(ref);
            })
          : null;
      const guardSub = (e) => {
        if (window.__tbmSubmitGuardActive > 0) {
          const f = e.target;
          if (window.__tbmAllowSafeForm && f && f.__tbmAllowedSubmit === true) return;
          try {
            Object.defineProperty(window, '__tbmSilentSubmitBlocks', {
              value: (Number(window.__tbmSilentSubmitBlocks) || 0) + 1,
              writable: true,
              enumerable: false,
              configurable: true,
            });
          } catch {}
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      };
      const registerRoot = (host, sr) => {
        if (!sr || typeof sr !== 'object') return;
        try {
          closedRoots.set(host, sr);
          if (typeof WeakRef === 'function') {
            const ref = new WeakRef(sr);
            allRootRefs.add(ref);
            if (registry) registry.register(sr, ref);
          }
          sr.addEventListener?.('submit', guardSub, true);
          if (typeof window.__tbmOnShadowRoot === 'function') {
            window.__tbmOnShadowRoot(sr);
          }
        } catch {}
      };
      const proxyAttach = new Proxy(origAttach, {
        apply(target, thisArg, args) {
          const sr = Reflect.apply(target, thisArg, args);
          registerRoot(thisArg, sr);
          return sr;
        },
      });
      Object.defineProperty(proxyAttach, '__tbmProxy', { value: true, enumerable: false });
      Element.prototype.attachShadow = proxyAttach;
      Object.defineProperty(window, '__tbmGetShadowRoot', {
        value: (el) => {
          if (!el) return null;
          if (el.shadowRoot) return el.shadowRoot;
          const local = closedRoots.get(el);
          if (local) return local;
          try {
            const ow = el.ownerDocument?.defaultView;
            if (ow && ow !== window && typeof ow.__tbmGetShadowRoot === 'function') {
              return ow.__tbmGetShadowRoot(el);
            }
          } catch {}
          return null;
        },
        configurable: true,
        enumerable: false,
      });
      Object.defineProperty(window, '__tbmGetAllShadowRoots', {
        value: () => {
          const live = [];
          for (const ref of [...allRootRefs]) {
            const sr = typeof ref.deref === 'function' ? ref.deref() : ref;
            if (sr) {
              live.push(sr);
            } else {
              allRootRefs.delete(ref);
            }
          }
          return live;
        },
        configurable: true,
        enumerable: false,
      });
    };
  }

  async _installContextInitScript(ctx) {
    if (!ctx || typeof ctx.addInitScript !== 'function' || this._initScriptInstalled?.has(ctx)) return;
    if (!this._initScriptInstalled) this._initScriptInstalled = new WeakSet();
    this._initScriptInstalled.add(ctx);
    const initFn = this._shadowInitFn();
    await ctx.addInitScript(initFn).catch(() => {});
    let pages = [];
    try {
      pages = ctx.pages();
    } catch {}
    // Existing tabs in an attached browser can have a blocked main world (an open
    // alert/confirm, a paused debugger). Evaluate never resolves there, so cap each
    // frame and run them in parallel: one stuck tab must not hang every tool call.
    const capMs = Number(process.env.TURBO_BROWSER_INIT_EVAL_MS) || 1500;
    await Promise.all(
      pages.map(async (p) => {
        let frames = [];
        try {
          frames = p.frames();
        } catch {}
        const results = await Promise.all(
          frames.map((f) => {
            let timer;
            const capped = new Promise((resolve) => {
              timer = setTimeout(() => resolve('timeout'), capMs);
            });
            return Promise.race([f.evaluate(initFn).then(() => 'ok', () => 'error'), capped]).finally(() =>
              clearTimeout(timer)
            );
          })
        );
        if (results[0] === 'timeout') this.markPageUnresponsive(p);
      })
    );
  }

  markPageUnresponsive(page) {
    if (!this._unresponsivePages) this._unresponsivePages = new WeakSet();
    this._unresponsivePages.add(page);
  }

  isPageUnresponsive(page) {
    // Browser-internal pages refuse script injection; that is not a blocked main world.
    try { if (/^(chrome|devtools|chrome-untrusted|edge|about):/i.test(page.url()) && page.url() !== 'about:blank') return false; } catch { /* ignore */ }
    return !!this._unresponsivePages?.has(page);
  }

  // Page.setWebLifecycleState through a short-lived session. False when the page does not take it.
  async _thaw(page, state) {
    let sess;
    try {
      sess = await page.context().newCDPSession(page);
      await Promise.race([sess.send('Page.setWebLifecycleState', { state }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1000))]);
      return true;
    } catch {
      return false;
    } finally {
      await sess?.detach().catch(() => {});
    }
  }

  /**
   * Quick liveness probe of the page main world. Marks the page unresponsive when it does not
   * answer within capMs, clears the mark when it answers again. Returns true when responsive.
   */
  async probePage(page, capMs = 2000, { restoreFrozen = false } = {}) {
    let timer;
    try {
      const ask = () => Promise.race([
        page.mainFrame().evaluate('1').then(() => true, () => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), capMs);
        }),
      ]);
      let ok = await ask();
      if (ok) this._frozenPages?.delete(page);
      // Chrome freezes hidden tabs (Memory Saver): their main world answers nothing until resumed. Resume it; if it then
      // answers it was frozen, not blocked. A listing puts the freeze back so it does not wake the owner's tabs for good.
      if (!ok && (await this._thaw(page, 'active'))) {
        clearTimeout(timer);
        ok = await ask();
        if (ok) {
          if (!this._frozenPages) this._frozenPages = new WeakSet();
          this._frozenPages.add(page);
          if (restoreFrozen) await this._thaw(page, 'frozen');
        }
      }
      if (ok) this._unresponsivePages?.delete(page);
      else this.markPageUnresponsive(page);
      return ok;
    } catch {
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  // Page targets as the browser reports them (raw CDP, independent of Playwright's Page objects). [] when unavailable.
  async _rawPageTargets() {
    if (this.connectionType !== 'cdp' || !this._cdpEndpoint) return [];
    try {
      const r = await cdpRawCall(this._cdpEndpoint, 'Target.getTargets', {}, 2000, { onlyBridge: /^wss?:/i.test(this._cdpEndpoint) });
      return (r?.targetInfos || []).filter((t) => t.type === 'page');
    } catch {
      return [];
    }
  }

  // A tab whose Page object went stale (url stays "" after a browser-initiated navigation or a swapped target, e.g.
  // omnibox from the new-tab page) while the browser lists a real page url nobody here knows. Playwright cannot
  // re-attach a single Page, so reconnect once and keep every tab's id. Returns true when it reconnected.
  async _healStalePages() {
    if (this.connectionType !== 'cdp' || !this.context || this.isolatedContexts.size > 0) return false;
    let pages;
    try { pages = this.context.pages().filter((p) => !p.isClosed()); } catch { return false; }
    const empty = pages.filter((p) => p.url() === '');
    this._staleFallback = null;
    if (empty.length === 0 || Date.now() - (this._lastHeal || 0) < 8000) return false;
    const known = new Set(pages.map((p) => p.url()).filter(Boolean));
    const lost = (await this._rawPageTargets()).filter((t) => t.url && !known.has(t.url) && !/^(chrome|devtools|about|chrome-untrusted|edge):/i.test(t.url));
    if (lost.length === 0) return false;
    this._lastHeal = Date.now();
    const order = pages.map((p) => this.pageToId.get(p));
    const oldActive = this.activeTabId;
    const ctxName = new Map([...this.tabContextName]);
    const oldBrowser = this.browser;
    this._resetBrowserState();
    await oldBrowser?.close().catch(() => {});
    try {
      await this.ensureReady();
    } catch {
      return false;
    }
    const fresh = this.context.pages().filter((p) => !p.isClosed());
    if (fresh.length === order.length) {
      this.tabs.clear();
      this.tabContextName.clear();
      fresh.forEach((p, i) => {
        const id = order[i];
        this.tabs.set(id, p);
        this.pageToId.set(p, id);
        this.tabContextName.set(id, ctxName.get(id) || 'default');
      });
      this.activeTabId = this.tabs.has(oldActive) ? oldActive : order[0] ?? null;
    }
    const still = this.context.pages().filter((p) => !p.isClosed() && p.url() === '');
    if (still.length === 1 && lost.length === 1) this._staleFallback = { page: still[0], url: lost[0].url, title: lost[0].title || '' };
    return true;
  }

  async _requireResponsive(page) {
    // Returns the page to use: after a reconnect (stale Page object) that is the tab's fresh Page, same tabId.
    const id = this.pageToId.get(page);
    const renewed = () => (id !== undefined && this.tabs.get(id)) || page;
    if (page.url() === '' && (await this._healStalePages().catch(() => false))) return renewed();
    // Keep this target rendering even when Chrome's front tab is elsewhere. The session must
    // stay attached: detaching clears focus emulation. Never activate or reset another tab.
    await this._keepRendering(page);
    // Only pages already marked unresponsive (at attach time or by tabs_batch list) pay for a probe:
    // a short re-check, since the dialog may be gone. Probing every page on every call made slow
    // but healthy pages (heavy scripts mid-load) look blocked.
    if (!this.isPageUnresponsive(page) && !this._frozenPages?.has(page)) return page;
    const ok = await this.probePage(page, Number(process.env.TURBO_BROWSER_PROBE_MS) || 1000);
    if (!ok) {
      if (await this._healStalePages().catch(() => false)) return renewed();
      throw new Error('page main world is blocked (open dialog or paused debugger?)');
    }
    return page;
  }

  async _keepRendering(page) {
    const diag = this._ensureDiagState(page);
    let timer;
    try {
      await Promise.race([
        (async () => {
          if (!diag.cdpSession) diag.cdpSession = await page.context().newCDPSession(page);
          await diag.cdpSession.send('Emulation.setFocusEmulationEnabled', { enabled: true });
          await diag.cdpSession.send('Page.setWebLifecycleState', { state: 'active' });
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 1000); }),
      ]);
    } catch { /* Some targets do not support emulation; the liveness check still applies. */ }
    finally { clearTimeout(timer); }
  }

  _ensureDiagState(page) {
    let diag = this.diagnostics.get(page);
    if (!diag) {
      diag = {
        console: [],
        requests: [],
        requestMap: new Map(),
        reqObjToEntry: new WeakMap(),
        dialogs: [],
        downloads: [],
        pendingDownloads: [],
        dialogPolicy: { action: 'dismiss', promptText: '' },
        nextReqSeq: 1,
        lastSnapshotLines: new Set(),
        blockedResources: new Set(),
        blockedUrlPatterns: [],
        presetBlockedReqs: new WeakSet(),
        presetResources: new Set(),
        presetUrlSources: new Set(),
        routeHandlerAttached: false,
        cdpSession: null,
      };
      this.diagnostics.set(page, diag);
    }
    return diag;
  }

  _recordRequest(diag, req) {
    const reqId = `r${diag.nextReqSeq++}`;
    const entry = {
      reqId,
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      startTime: Date.now(),
      ts: new Date().toISOString(),
      status: null,
      statusText: null,
      ok: null,
      durationMs: null,
      failureText: null,
      requestHeaders: req.headers(),
      postData: (req.postData() || '').slice(0, 2000),
      responseHeaders: null,
      _response: null,
    };
    diag.requestMap.set(reqId, entry);
    diag.reqObjToEntry.set(req, entry);
    pushRing(diag.requests, entry, REQUEST_RING_LIMIT, (old) => {
      diag.requestMap.delete(old.reqId);
    });
    return entry;
  }

  _registerPage(page, makeActive = false, contextName = 'default') {
    if (this.pageToId.has(page)) {
      const existingId = this.pageToId.get(page);
      if (makeActive) this.activeTabId = existingId;
      return existingId;
    }

    const tabId = this.nextTabId++;
    this.tabs.set(tabId, page);
    this.tabContextName.set(tabId, contextName);
    this.pageToId.set(page, tabId);
    if (makeActive || this.activeTabId === null) {
      this.activeTabId = tabId;
    }

    // Pages in contexts turbo owns are guarded on sight; in CDP mode only pages turbo opens or drives are.
    if (this.connectionType !== 'cdp') {
      const policy = getPolicy();
      if (policy) installGuard(page, policy).catch(() => {});
    }

    if (!this.attachedPages.has(page)) {
      this.attachedPages.add(page);
      const diag = this._ensureDiagState(page);

      page.on('console', (msg) => {
        pushRing(
          diag.console,
          {
            level: msg.type(),
            text: msg.text().slice(0, 500),
            ts: new Date().toISOString(),
          },
          CONSOLE_RING_LIMIT
        );
      });

      page.on('pageerror', (err) => {
        pushRing(
          diag.console,
          {
            level: 'pageerror',
            text: String(err?.message ?? err).slice(0, 500),
            ts: new Date().toISOString(),
          },
          CONSOLE_RING_LIMIT
        );
      });

      const ensureEntryInRing = (entry) => {
        if (entry && !diag.requestMap.has(entry.reqId)) {
          diag.requestMap.set(entry.reqId, entry);
          pushRing(diag.requests, entry, REQUEST_RING_LIMIT, (old) => {
            diag.requestMap.delete(old.reqId);
          });
        }
        return entry;
      };

      page.on('request', (req) => {
        this._recordRequest(diag, req);
      });

      page.on('response', (res) => {
        const req = res.request();
        const entry = ensureEntryInRing(diag.reqObjToEntry.get(req) ?? this._recordRequest(diag, req));
        entry.status = res.status();
        entry.statusText = res.statusText();
        entry.ok = res.ok();
        entry.durationMs = Date.now() - entry.startTime;
        entry.responseHeaders = res.headers();
        entry._response = res;
      });

      page.on('requestfailed', (req) => {
        const entry = ensureEntryInRing(diag.reqObjToEntry.get(req) ?? this._recordRequest(diag, req));
        entry.ok = false;
        entry.failureText = req.failure()?.errorText || 'failed';
        if (diag.presetBlockedReqs.has(req)) entry.blockedByPreset = true;
        entry.durationMs = Date.now() - entry.startTime;
      });

      page.on('dialog', async (dialog) => {
        const policy = diag.dialogPolicy;
        const accept = policy.action === 'accept';
        pushRing(
          diag.dialogs,
          {
            type: dialog.type(),
            message: dialog.message().slice(0, 300),
            actionTaken: accept ? 'accepted' : 'dismissed',
            promptText: accept && policy.promptText ? policy.promptText : undefined,
            ts: new Date().toISOString(),
          },
          DIALOG_RING_LIMIT
        );
        if (accept) {
          await dialog.accept(policy.promptText || undefined).catch(() => {});
        } else {
          await dialog.dismiss().catch(() => {});
        }
      });

      page.on('download', (download) => {
        const safeName = path.basename(download.suggestedFilename() || 'download.bin');
        const savePath = path.join(os.tmpdir(), `tbm-dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`);
        this.tempDownloadFiles.add(savePath);
        const job = download.saveAs(savePath).then(() => {
          pushRing(
            diag.downloads,
            {
              url: download.url(),
              suggestedFilename: safeName,
              savePath,
              ts: new Date().toISOString(),
            },
            DOWNLOAD_RING_LIMIT
          );
        }).catch((err) => {
          pushRing(
            diag.downloads,
            {
              url: download.url(),
              suggestedFilename: safeName,
              error: String(err?.message || err),
              ts: new Date().toISOString(),
            },
            DOWNLOAD_RING_LIMIT
          );
        });
        diag.pendingDownloads.push(job);
        job.finally(() => {
          const idx = diag.pendingDownloads.indexOf(job);
          if (idx !== -1) diag.pendingDownloads.splice(idx, 1);
        });
      });

      page.on('close', () => {
        if (diag.cdpSession) {
          diag.cdpSession.detach().catch(() => {});
          diag.cdpSession = null;
        }
        const id = this.pageToId.get(page);
        if (id !== undefined) {
          this.tabs.delete(id);
          this.tabContextName.delete(id);
          if (this.activeTabId === id) {
            const remaining = [...this.tabs.keys()];
            this.activeTabId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
          }
        }
      });
    }

    return tabId;
  }

  _syncOpenPages() {
    if (!this.context) return;
    const contextPairs = [
      ['default', this.context],
      ...this.isolatedContexts.entries(),
    ];
    for (const [ctxName, ctx] of contextPairs) {
      let pages = [];
      try {
        pages = ctx.pages();
      } catch {
        if (ctxName !== 'default') this.isolatedContexts.delete(ctxName);
        continue;
      }
      for (const page of pages) {
        if (!page.isClosed()) {
          this._registerPage(page, false, ctxName);
        }
      }
    }
    for (const [id, page] of [...this.tabs.entries()]) {
      if (page.isClosed()) {
        this.tabs.delete(id);
        this.tabContextName.delete(id);
      }
    }
    if (this.activeTabId !== null && !this.tabs.has(this.activeTabId)) {
      const remaining = [...this.tabs.keys()];
      this.activeTabId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    }
  }

  async getPage(tabId) {
    await this.ensureReady();
    this._syncOpenPages();

    if (tabId !== undefined && tabId !== null) {
      const target = this.tabs.get(tabId);
      if (!target || target.isClosed()) {
        throw new Error(`Tab ${tabId} not found or closed.`);
      }
      await this._guard(target);
      const usable = await this._requireResponsive(target);
      return { tabId, page: usable };
    }

    if (this.activeTabId !== null && this.tabs.has(this.activeTabId)) {
      const activePage = this.tabs.get(this.activeTabId);
      await this._guard(activePage);
      const usable = await this._requireResponsive(activePage);
      return { tabId: this.activeTabId, page: usable };
    }

    const page = await this.context.newPage();
    await this._keepRendering(page);
    await this._guard(page);
    const newId = this._registerPage(page, true);
    return { tabId: newId, page };
  }

  /** Navigation allowlist: no-op unless a policy is set. */
  async _guard(page) {
    const policy = getPolicy();
    if (policy) await installGuard(page, policy);
  }

  getSnapshotState(page) {
    return this._ensureDiagState(page).lastSnapshotLines;
  }

  // CDP only: Playwright files every page of a context it did not create under the default context, so a
  // tab another process opened in its isolated context would be listed as "default". Ask Chrome which context
  // each unchecked default-context page really lives in; non-default ones are labeled "other".
  async _labelForeignContextPages() {
    if (this.connectionType !== 'cdp' || !this.browser || !this.context) return;
    this._ctxChecked ||= new WeakSet();
    let pages;
    try { pages = this.context.pages().filter((p) => !p.isClosed() && !this._ctxChecked.has(p)); } catch { return; }
    if (pages.length > 0) {
      const work = (async () => {
        let viaSession = false;
        try {
          const root = await this.browser.newBrowserCDPSession();
          try {
            const res = await root.send('Target.getBrowserContexts');
            const nonDefault = new Set(res?.browserContextIds || []);
            if (nonDefault.size === 0) { for (const p of pages) this._ctxChecked.add(p); viaSession = true; return; }
            await Promise.all(pages.map(async (p) => {
              let s;
              try {
                s = await this.context.newCDPSession(p);
                const info = (await s.send('Target.getTargetInfo'))?.targetInfo;
                this._ctxChecked.add(p);
                if (info?.browserContextId && nonDefault.has(info.browserContextId)) this._foreignPages.add(p);
              } catch { /* leave unchecked, retried next listing */ } finally { await s?.detach().catch(() => {}); }
            }));
            viaSession = pages.every((p) => this._ctxChecked.has(p));
          } finally { await root.detach().catch(() => {}); }
        } catch { /* fall through to the bridge route */ }
        if (viaSession) return;
        await this._labelPagesViaBridge(pages);
      })().catch(() => {});
      let timer;
      await Promise.race([work, new Promise((r) => { timer = setTimeout(r, 2000); })]);
      clearTimeout(timer);
    }
    for (const [tabId, p] of this.tabs) {
      if (this._foreignPages.has(p) && (this.tabContextName.get(tabId) || 'default') === 'default') this.tabContextName.set(tabId, 'other');
      else if (this._unknownContextPages.has(p) && (this.tabContextName.get(tabId) || 'default') === 'default') this.tabContextName.set(tabId, 'unknown');
    }
  }

  // An older bridge build never tracked Target.attachToBrowserTarget sessions, so Playwright's browser-level session
  // (and every newCDPSession built on it) fails with "Session with given id not found". A sessionless Target.getTargets
  // is forwarded by every bridge build and returns each page's browserContextId. Playwright does not expose a page's
  // targetId, so pages are matched by url and title; a page that matches targets of both kinds is marked "unknown".
  async _labelPagesViaBridge(pages) {
    if (!this._cdpEndpoint) return;
    let info, version;
    try {
      info = (await cdpRawCall(this._cdpEndpoint, 'Target.getTargets', {}, 2000, { onlyBridge: true }))?.targetInfos;
      version = await cdpRawCall(this._cdpEndpoint, 'Target.getBrowserContexts', {}, 2000, { onlyBridge: true });
    } catch { return; }
    const nonDefault = new Set(version?.browserContextIds || []);
    const targets = (info || []).filter((t) => t.type === 'page');
    for (const p of pages) {
      let url = '', title = '';
      try { url = p.url(); title = await p.title(); } catch { continue; }
      let cands = targets.filter((t) => t.url === url);
      if (cands.length > 1) { const byTitle = cands.filter((t) => t.title === title); if (byTitle.length) cands = byTitle; }
      if (cands.length === 0) continue; // not listed yet: retried next listing
      const foreign = cands.filter((t) => nonDefault.has(t.browserContextId)).length;
      if (foreign === cands.length) { this._ctxChecked.add(p); this._foreignPages.add(p); }
      else if (foreign === 0) this._ctxChecked.add(p);
      else { this._ctxChecked.add(p); this._unknownContextPages.add(p); }
    }
  }

  async listTabs() {
    await this.ensureReady();
    this._syncOpenPages();
    await this._healStalePages().catch(() => {});
    await this._labelForeignContextPages();
    const results = [];
    // Re-probe the main world of every tab in parallel (1.5 s cap): marks tabs that got stuck after
    // attach and clears marks on tabs that answer again.
    await Promise.all([...this.tabs.values()].map((p) => this.probePage(p, 1500, { restoreFrozen: true })));
    // Titles in parallel, and never waited for on a stuck tab (title reads the blocked main world): sequential
    // 1.5 s waits made a listing with many such tabs take 15-20 s.
    const entries = await Promise.all([...this.tabs.entries()].map(async ([tabId, page]) => {
      let title = '';
      const stuck = this.isPageUnresponsive(page);
      if (!stuck && !this._frozenPages?.has(page)) {
        let timer;
        try {
          title = await Promise.race([
            page.title(),
            new Promise((resolve) => {
              timer = setTimeout(() => resolve(''), 1500);
            }),
          ]);
        } catch {
          title = '';
        } finally {
          clearTimeout(timer);
        }
      }
      let url = page.url();
      if (url === '' && this._staleFallback?.page === page) { url = this._staleFallback.url; title = this._staleFallback.title; }
      const entry = {
        tabId,
        url,
        title,
        active: tabId === this.activeTabId,
        isolatedContext: this.tabContextName.get(tabId) || 'default',
      };
      // A tab with no committed document yet (empty url) has nothing to be stuck on.
      if (this._frozenPages?.has(page) && !stuck) entry.frozen = true;
      else if (stuck && url) entry.unresponsive = true;
      return entry;
    }));
    results.push(...entries);
    return results;
  }

  async _getOrCreateContext(contextName) {
    if (!contextName || contextName === 'default') {
      return { name: 'default', ctx: this.context };
    }
    if (this.isolatedContexts.has(contextName)) {
      const existingCtx = this.isolatedContexts.get(contextName);
      try {
        existingCtx.pages();
        return { name: contextName, ctx: existingCtx };
      } catch {
        this.isolatedContexts.delete(contextName);
      }
    }
    const browserRef = this.browser || this.context.browser();
    if (!browserRef) {
      throw new Error('isolatedContext requires a multi-context browser session (launch or cdp mode).');
    }
    const isoCtx = await browserRef.newContext({ viewport: { width: 1280, height: 800 } });
    isoCtx.setDefaultTimeout(this.defaultTimeoutMs);
    await this._installContextInitScript(isoCtx);
    isoCtx.on('page', (page) => this._registerPage(page, true, contextName));
    isoCtx.on('close', () => {
      if (this.isolatedContexts.get(contextName) === isoCtx) {
        this.isolatedContexts.delete(contextName);
      }
      for (const [tid, cName] of [...this.tabContextName.entries()]) {
        if (cName === contextName) {
          this.tabs.delete(tid);
          this.tabContextName.delete(tid);
        }
      }
      if (this.activeTabId !== null && !this.tabs.has(this.activeTabId)) {
        const remaining = [...this.tabs.keys()];
        this.activeTabId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
      }
    });
    this.isolatedContexts.set(contextName, isoCtx);
    return { name: contextName, ctx: isoCtx };
  }

  _contextForUrl(url, explicit) {
    if (explicit !== undefined && explicit !== null) return explicit;
    let host;
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) return undefined;
      host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    } catch { return undefined; }
    const match = this.isolateHosts.some((pattern) => pattern.startsWith('*.')
      ? host === pattern.slice(2) || host.endsWith('.' + pattern.slice(2))
      : host === pattern);
    if (!match) return undefined;
    let name;
    do { name = `auto-isolate-${this.nextAutoContextId++}`; } while (this.isolatedContexts.has(name));
    return name;
  }

  async tabsBatch(operations = [], { includeTabs } = {}) {
    const batchStart = Date.now();
    await this.ensureReady();
    this._syncOpenPages();

    const ops = Array.isArray(operations) && operations.length > 0
      ? operations
      : [{ action: 'list' }];

    const results = [];
    const tabsBefore = new Set(this._knownTabIds || this.tabs.keys());
    let tabsRequested = false;
    let failedOpen = false;
    for (const op of ops) {
      const action = op.action || (op.url ? 'open' : 'list');
      if (action === 'list' || action === 'open_many' || action === 'close') tabsRequested = true;

      if (action === 'close_browser') {
        await this.close();
        results.push({ action: 'close_browser', closed: true });
        return {
          connectionType: null,
          activeTabId: null,
          elapsedMs: Date.now() - batchStart,
          results,
          tabs: [],
        };
      }

      if (action === 'list') {
        // The tab list is returned once, at top level (not repeated inside this result).
        results.push({ action: 'list' });
        continue;
      }

      if (action === 'open_many') {
        const urls = Array.isArray(op.urls)
          ? op.urls
              .filter((u) => u !== null && u !== undefined)
              .map((u) => String(u).trim())
              .filter(Boolean)
          : [];
        if (urls.length === 0) throw new Error('open_many action requires a non-empty urls array.');
        const batchT0 = Date.now();
        const prevActiveTabId = this.activeTabId;
        const concurrency = Math.min(10, Math.max(1, Number(op.concurrency) || 5));
        const navOpts = {
          waitUntil: op.waitUntil || 'domcontentloaded',
          timeout: op.timeoutMs || this.defaultTimeoutMs,
        };
        const opened = [];
        for (let i = 0; i < urls.length; i += concurrency) {
          const slice = urls.slice(i, i + concurrency);
          const chunkResults = await Promise.all(
            slice.map(async (targetUrl) => {
              const denied = urlDenial(targetUrl);
              if (denied) {
                return { tabId: null, isolatedContext: op.isolatedContext || 'default', url: targetUrl, title: '', ok: false, error: denied };
              }
              const { name: ctxName, ctx } = await this._getOrCreateContext(this._contextForUrl(targetUrl, op.isolatedContext));
              const page = await ctx.newPage();
              const tabId = this._registerPage(page, false, ctxName);
              try {
                await this._keepRendering(page);
                await this._guard(page);
                const resp = await page.goto(targetUrl, navOpts);
                const title = await page.title().catch(() => '');
                return {
                  tabId,
                  isolatedContext: ctxName,
                  url: page.url(),
                  title,
                  ok: true,
                  ...(await navHealth(page, resp, targetUrl, title, { waitUntil: navOpts.waitUntil })),
                };
              } catch (err) {
                const stopped = takeBlocked(page);
                await page.close().catch(() => {});
                this.tabs.delete(tabId);
                this.tabContextName.delete(tabId);
                return {
                  tabId: null,
                  isolatedContext: ctxName,
                  url: stopped ? stopped.url : targetUrl,
                  title: '',
                  ok: false,
                  error: stopped ? denyMessage(matchUrl(stopped.url, getPolicy())) : String(err?.message || err),
                  ...(stopped ? { blocked: 'host-not-allowed' } : {}),
                };
              }
            })
          );
          opened.push(...chunkResults);
        }
        if (op.activate === false) {
          this.activeTabId =
            prevActiveTabId !== null && this.tabs.has(prevActiveTabId)
              ? prevActiveTabId
              : ([...this.tabs.keys()][0] ?? null);
        } else {
          const lastOk = [...opened].reverse().find((item) => item.ok !== false && item.tabId !== null);
          this.activeTabId = lastOk ? lastOk.tabId : prevActiveTabId;
        }
        results.push({
          action: 'open_many',
          opened,
          elapsedMs: Date.now() - batchT0,
        });
        continue;
      }

      if (action === 'open') {
        const denied = op.url ? urlDenial(op.url) : null;
        if (denied) {
          if (ops.length === 1) throw new Error(denied);
          results.push({ action: 'open', ok: false, url: op.url, error: denied });
          failedOpen = true;
          continue;
        }
        const prevActiveTabId = this.activeTabId;
        const { name: ctxName, ctx } = await this._getOrCreateContext(this._contextForUrl(op.url, op.isolatedContext));
        const page = await ctx.newPage();
        const tabId = this._registerPage(page, op.activate !== false, ctxName);
        if (op.activate === false) {
          this.activeTabId =
            prevActiveTabId !== null && this.tabs.has(prevActiveTabId)
              ? prevActiveTabId
              : tabId;
        }
        let openResp = null;
        if (op.url) {
          try {
            await this._keepRendering(page);
            await this._guard(page);
            openResp = await page.goto(op.url, {
              waitUntil: op.waitUntil || 'domcontentloaded',
              timeout: op.timeoutMs || this.defaultTimeoutMs,
            });
          } catch (err) {
            if (err && err.name === 'TimeoutError' && !peekBlocked(page)) {
              // The page is usually usable after a slow load: keep the tab and say so.
              results.push({
                action: 'open',
                tabId,
                isolatedContext: ctxName,
                ok: false,
                timedOut: true,
                url: page.url(),
                title: await page.title().catch(() => ''),
                error: firstLine(err),
              });
              continue;
            }
            const stopped = takeBlocked(page);
            if (stopped) err = new Error(denyMessage(matchUrl(stopped.url, getPolicy())));
            await page.close().catch(() => {});
            this.tabs.delete(tabId);
            this.tabContextName.delete(tabId);
            this.activeTabId =
              prevActiveTabId !== null && this.tabs.has(prevActiveTabId)
                ? prevActiveTabId
                : ([...this.tabs.keys()].pop() ?? null);
            if (ops.length === 1) throw err; // a lone failing open keeps rejecting, as before
            results.push({ action: 'open', ok: false, url: stopped ? stopped.url : op.url, error: firstLine(err), ...(stopped ? { blocked: 'host-not-allowed' } : {}) });
            failedOpen = true;
            continue;
          }
        }
        if (op.activate === false) {
          this.activeTabId =
            prevActiveTabId !== null && this.tabs.has(prevActiveTabId)
              ? prevActiveTabId
              : tabId;
        }
        const openTitle = await page.title().catch(() => '');
        results.push({
          action: 'open',
          tabId,
          isolatedContext: ctxName,
          url: page.url(),
          title: openTitle,
          ...(op.url ? await navHealth(page, openResp, op.url, openTitle, { waitUntil: op.waitUntil }) : {}),
        });
        continue;
      }

      if (action === 'navigate') {
        if (failedOpen && (op.tabId === undefined || op.tabId === null)) {
          results.push({ action: 'navigate', ok: false, skipped: true, error: 'skipped: the earlier open failed and no tabId was given' });
          continue;
        }
        if (!op.url) throw new Error('navigate action requires url.');
        const navDenied = urlDenial(op.url);
        if (navDenied) {
          results.push({ action: 'navigate', ok: false, url: op.url, error: navDenied });
          continue;
        }
        const { tabId, page } = await this.getPage(op.tabId);
        const contextName = this._contextForUrl(op.url, op.isolatedContext);
        if (contextName !== undefined && contextName !== this.tabContextName.get(tabId)) {
          // A Page cannot change cookie contexts. Leave the owner's tab intact and return
          // the new tab's ID, just as open does, without sending the URL through the old page.
          const opened = await this.tabsBatch([{ ...op, action: 'open', isolatedContext: contextName, activate: op.activate === true }], { includeTabs: false });
          const { isolatedContext, ...result } = opened.results[0];
          results.push({ ...result, action: 'navigate' });
          continue;
        }
        let navResp, navRetried;
        try {
          ({ resp: navResp, retried: navRetried } = await gotoRetry(page, op.url, {
            waitUntil: op.waitUntil || 'domcontentloaded',
            timeout: op.timeoutMs || this.defaultTimeoutMs,
          }));
        } catch (err) {
          const stopped = takeBlocked(page);
          results.push({
            action: 'navigate',
            tabId,
            ok: false,
            ...(err && err.name === 'TimeoutError' && !stopped ? { timedOut: true } : {}),
            url: stopped ? stopped.url : page.url(),
            title: await page.title().catch(() => ''),
            error: stopped ? denyMessage(matchUrl(stopped.url, getPolicy())) : firstLine(err),
            ...(stopped ? { blocked: 'host-not-allowed' } : {}),
          });
          continue;
        }
        if (op.activate === true) {
          this.activeTabId = tabId;
          await page.bringToFront().catch(() => {});
        }
        const navTitle = await page.title().catch(() => '');
        results.push({
          action: 'navigate',
          tabId,
          url: page.url(),
          title: navTitle,
          ...(navRetried ? { retried: navRetried } : {}),
          ...(await navHealth(page, navResp, op.url, navTitle, { waitUntil: op.waitUntil })),
        });
        continue;
      }

      if (action === 'activate') {
        const { tabId, page } = await this.getPage(op.tabId);
        this.activeTabId = tabId;
        await page.bringToFront().catch(() => {});
        results.push({ action: 'activate', tabId, url: page.url() });
        continue;
      }

      if (action === 'resize') {
        const { tabId, page } = await this.getPage(op.tabId);
        const width = Math.max(200, Number(op.width) || 1280);
        const height = Math.max(200, Number(op.height) || 800);
        await page.setViewportSize({ width, height });
        results.push({ action: 'resize', tabId, width, height });
        continue;
      }

      if (action === 'emulate') {
        const { tabId, page } = await this.getPage(op.tabId);
        const mediaOpts = {};
        for (const key of ['colorScheme', 'media', 'reducedMotion', 'forcedColors', 'contrast']) {
          if (op[key] !== undefined) mediaOpts[key] = op[key];
        }
        if (Object.keys(mediaOpts).length > 0) {
          await page.emulateMedia(mediaOpts);
        }
        let appliedViewport;
        if (op.viewport && (op.viewport.width !== undefined || op.viewport.height !== undefined)) {
          appliedViewport = {
            width: Math.max(200, Number(op.viewport.width) || 1280),
            height: Math.max(200, Number(op.viewport.height) || 800),
          };
          await page.setViewportSize(appliedViewport);
        }
        if (op.userAgent !== undefined) {
          const diag = this._ensureDiagState(page);
          if (!diag.cdpSession) {
            diag.cdpSession = await page.context().newCDPSession(page);
          }
          await diag.cdpSession.send('Emulation.setUserAgentOverride', {
            userAgent: op.userAgent ? String(op.userAgent) : '',
          });
          if (Object.keys(mediaOpts).length > 0) {
            await page.emulateMedia(mediaOpts);
          }
        }
        results.push({
          action: 'emulate',
          tabId,
          ...mediaOpts,
          viewport: appliedViewport || undefined,
          userAgent: op.userAgent !== undefined ? Boolean(op.userAgent) : undefined,
        });
        continue;
      }

      if (action === 'reload' || action === 'back' || action === 'forward') {
        const { tabId, page } = await this.getPage(op.tabId);
        const navOpts = {
          waitUntil: op.waitUntil || 'domcontentloaded',
          timeout: op.timeoutMs || this.defaultTimeoutMs,
        };
        if (action === 'reload') await page.reload(navOpts);
        else if (action === 'back') await page.goBack(navOpts);
        else await page.goForward(navOpts);
        results.push({ action, tabId, url: page.url() });
        continue;
      }

      if (action === 'close') {
        const { tabId, page } = await this.getPage(op.tabId);
        // Closing the last page of an attached browser closes the whole browser (the owner's Chrome).
        // Only pages of the default context count: a tab in an isolated context lives in its own
        // browser context, so closing it never closes Chrome.
        const inDefaultContext = page.context() === this.context;
        if (this.connectionType === 'cdp' && op.force !== true && inDefaultContext && this.context.pages().filter((p) => !p.isClosed()).length <= 1) {
          throw new Error('Refusing to close the last tab of the attached browser: that closes Chrome. Open about:blank first, or pass force:true.');
        }
        await page.close();
        this.tabs.delete(tabId);
        this._syncOpenPages();
        results.push({ action: 'close', tabId, activeTabId: this.activeTabId });
        continue;
      }

      throw new Error(`Unsupported tabs_batch action: ${action}`);
    }

    // Echo the tab list only when asked (list/open_many/close) or when it changed in a way the
    // caller did not request (popup opened, tab crashed). open/navigate/etc. return their own tabId.
    let echoTabs = includeTabs === true ? true : tabsRequested;
    if (!echoTabs && includeTabs !== false) {
      const expected = new Set(tabsBefore);
      for (const r of results) {
        if (r.action === 'open' && r.tabId !== undefined && r.tabId !== null) expected.add(r.tabId);
      }
      this._syncOpenPages();
      const now = [...this.tabs.keys()];
      echoTabs = now.length !== expected.size || now.some((id) => !expected.has(id));
    }
    this._knownTabIds = new Set(this.tabs.keys());
    return {
      connectionType: this.connectionType,
      activeTabId: this.activeTabId,
      elapsedMs: Date.now() - batchStart,
      results,
      ...(echoTabs && includeTabs !== false ? { tabs: await this.listTabs() } : {}),
    };
  }

  async getDiagnostics(tabId, options = {}) {
    const opts = typeof options === 'boolean' ? { clear: options } : (options || {});
    const { tabId: id, page } = await this.getPage(tabId);
    const diag = this._ensureDiagState(page);

    if (diag.pendingDownloads.length > 0) {
      await Promise.race([
        Promise.allSettled([...diag.pendingDownloads]),
        new Promise((r) => setTimeout(r, 2500)),
      ]);
    }

    if (opts.dialogPolicy) {
      diag.dialogPolicy = {
        action: opts.dialogPolicy.action === 'accept' ? 'accept' : 'dismiss',
        promptText: opts.dialogPolicy.promptText ?? '',
      };
    }

    if (opts.reqId) {
      const entry = diag.requestMap.get(opts.reqId);
      if (!entry) {
        throw new Error(`Request "${opts.reqId}" not found in diagnostics buffer.`);
      }
      const maxBodyChars = Math.max(100, Number(opts.maxBodyChars) || 4000);
      let bodyText = '';
      let bodyTruncated = false;
      let bodyError = null;
      if (entry._response && (!opts.part || opts.part === 'response-body')) {
        try {
          const fullBody = await entry._response.text();
          bodyTruncated = fullBody.length > maxBodyChars;
          bodyText = fullBody.slice(0, maxBodyChars);
        } catch (err) {
          bodyError = String(err?.message || err);
        }
      }

      const fullDetail = {
        reqId: entry.reqId,
        method: entry.method,
        url: entry.url,
        resourceType: entry.resourceType,
        status: entry.status,
        statusText: entry.statusText,
        ok: entry.ok,
        durationMs: entry.durationMs,
        failureText: entry.failureText,
        requestHeaders: entry.requestHeaders,
        postData: entry.postData,
        responseHeaders: entry.responseHeaders,
        responseBody: bodyText,
        bodyTruncated,
        bodyError,
      };

      const partMap = {
        'request-headers': entry.requestHeaders,
        'request-body': entry.postData,
        'response-headers': entry.responseHeaders,
        'response-body': bodyText,
      };

      const detailPayload = opts.part && Object.prototype.hasOwnProperty.call(partMap, opts.part)
        ? { tabId: id, reqId: entry.reqId, part: opts.part, data: partMap[opts.part], bodyTruncated, bodyError }
        : { tabId: id, request: fullDetail };

      if (opts.savePath) {
        const resolved = resolveSafePath(opts.savePath, 'savePath');
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, redactText(JSON.stringify(detailPayload, null, 2)), 'utf8');
        detailPayload.savePath = resolved;
      }
      return detailPayload;
    }

    const level = opts.level || 'errors';
    const statusFilter = opts.statusFilter || 'errors';
    const includeStatic = Boolean(opts.includeStatic);
    const urlMatcher = opts.urlFilter ? compileUrlPattern(opts.urlFilter) : null;

    const blockedByPreset = diag.requests.filter((r) => r.blockedByPreset).length;
    // Collapse identical entries into one with a count (first occurrence keeps its reqId/ts).
    const collapse = (list, keyOf) => {
      const seen = new Map();
      const out = [];
      for (const item of list) {
        const key = keyOf(item);
        const prev = seen.get(key);
        if (prev) {
          prev.count = (prev.count || 1) + 1;
        } else {
          const copy = { ...item };
          seen.set(key, copy);
          out.push(copy);
        }
      }
      return out;
    };

    const consoleFiltered = level === 'all'
      ? [...diag.console]
      : collapse(
          diag.console.filter(
            (c) =>
              ERROR_CONSOLE_LEVELS.has(c.level) &&
              !(blockedByPreset > 0 && /ERR_BLOCKED_BY_CLIENT/.test(c.text))
          ),
          (c) => `${c.level} ${c.text}`
        );

    const compactReq = (r) => ({
      reqId: r.reqId,
      method: r.method,
      url: r.url,
      resourceType: r.resourceType,
      status: r.status,
      ok: r.ok,
      durationMs: r.durationMs,
      failureText: r.failureText,
      ts: r.ts,
    });

    const isErrorReq = (r) => r.ok === false || (r.status !== null && r.status >= 400);
    const matchesUrl = (r) => !urlMatcher || urlMatcher.test(r.url);
    const reqKey = (r) => `${r.method} ${r.url} ${r.status} ${r.failureText}`;
    const networkErrors = collapse(
      diag.requests
        .filter((r) => isErrorReq(r) && matchesUrl(r) && (statusFilter === 'all' || !r.blockedByPreset))
        .map(compactReq),
      reqKey
    );

    const filteredReqs = statusFilter === 'all'
      ? diag.requests.filter((r) => {
          if (!matchesUrl(r)) return false;
          if (!includeStatic && !isErrorReq(r) && STATIC_RESOURCE_TYPES.has(r.resourceType)) {
            return false;
          }
          return true;
        }).map(compactReq)
      : networkErrors;

    const snapshot = {
      tabId: id,
      url: page.url(),
      dialogPolicy: diag.dialogPolicy,
      console: consoleFiltered,
      requests: filteredReqs,
      networkErrors,
      dialogs: [...diag.dialogs],
      downloads: [...diag.downloads],
      totalBufferedRequests: diag.requests.length,
    };
    if (blockedByPreset > 0) snapshot.blockedByPreset = blockedByPreset;

    if (opts.savePath) {
      const resolved = resolveSafePath(opts.savePath, 'savePath');
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, redactText(JSON.stringify(snapshot, null, 2)), 'utf8');
      snapshot.savePath = resolved;
    }

    if (opts.clear) {
      diag.console.length = 0;
      diag.requests.length = 0;
      diag.requestMap.clear();
      diag.reqObjToEntry = new WeakMap();
      diag.dialogs.length = 0;
      diag.downloads.length = 0;
    }

    return snapshot;
  }

  async manageNetworkSession(tabId, params = {}) {
    const { tabId: id, page } = await this.getPage(tabId);
    const diag = this._ensureDiagState(page);
    const result = { tabId: id, url: page.url() };

    const presetName = params.preset ? String(params.preset).toLowerCase() : null;
    if (presetName && presetName !== 'clean' && !NETWORK_PRESETS[presetName]) {
      throw new Error(`Unsupported network_session preset: ${params.preset}`);
    }

    if (params.unblockAll || presetName === 'clean') {
      diag.blockedResources.clear();
      diag.blockedUrlPatterns.length = 0;
      diag.presetResources.clear();
      diag.presetUrlSources.clear();
      if (diag.routeHandlerAttached) {
        await page.unroute('**/*').catch(() => {});
        diag.routeHandlerAttached = false;
      }
      result.unblockedAll = true;
      if (presetName === 'clean') result.presetApplied = 'clean';
    }

    const presetSpec = presetName && presetName !== 'clean' ? NETWORK_PRESETS[presetName] : null;
    const blockResourcesInput = [
      ...(presetSpec ? presetSpec.resources : []),
      ...(Array.isArray(params.blockResources) ? params.blockResources : []),
    ]
      .map((r) => String(r ?? '').trim().toLowerCase())
      .filter(Boolean);
    const blockUrlsInput = [
      ...(presetSpec ? presetSpec.urls : []),
      ...(Array.isArray(params.blockUrls) ? params.blockUrls : []),
    ]
      .map((u) => String(u ?? '').trim())
      .filter(Boolean);

    if (blockResourcesInput.length > 0 || blockUrlsInput.length > 0) {
      for (const r of blockResourcesInput) diag.blockedResources.add(r);
      if (presetSpec) {
        for (const r of presetSpec.resources) diag.presetResources.add(r);
        for (const u of presetSpec.urls) diag.presetUrlSources.add(u);
      }
      const existingSources = new Set(diag.blockedUrlPatterns.map((p) => p.source));
      for (const src of blockUrlsInput) {
        if (!existingSources.has(src)) {
          existingSources.add(src);
          diag.blockedUrlPatterns.push({ source: src, matcher: compileUrlPattern(src) });
        }
      }
      if (!diag.routeHandlerAttached) {
        diag.routeHandlerAttached = true;
        await page.route('**/*', async (route) => {
          const req = route.request();
          const resType = req.resourceType().toLowerCase();
          const reqUrl = req.url();
          if (
            diag.blockedResources.has(resType) ||
            diag.blockedUrlPatterns.some((p) => p.matcher.test(reqUrl))
          ) {
            // Only our own preset's blocks are hidden from default diagnostics; explicit blocks stay visible.
            if (
              diag.presetResources.has(resType) ||
              diag.blockedUrlPatterns.some((p) => diag.presetUrlSources.has(p.source) && p.matcher.test(reqUrl))
            ) {
              diag.presetBlockedReqs.add(req);
            }
            await route.abort('blockedbyclient').catch(() => {});
            return;
          }
          await route.continue().catch(() => {});
        });
      }
      if (presetSpec) result.presetApplied = presetName;
      result.blockedResources = [...diag.blockedResources];
      result.blockedUrls = diag.blockedUrlPatterns.map((p) => p.source);
    }

    const pageCtx = page.context();

    if (params.loadStorageStatePath) {
      const srcPath = resolveSafePath(params.loadStorageStatePath, 'loadStorageStatePath');
      const raw = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
      if (Array.isArray(raw.cookies) && raw.cookies.length > 0) {
        await pageCtx.addCookies(raw.cookies);
      }
      if (Array.isArray(raw.origins) && raw.origins.length > 0) {
        const normalizedOrigins = raw.origins.map((o) => {
          let normOrigin = String(o?.origin || '');
          try {
            normOrigin = new URL(normOrigin).origin;
          } catch {
            normOrigin = normOrigin.replace(/\/+$/, '').toLowerCase();
          }
          return { ...o, origin: normOrigin };
        });
        const seedKey = `__tbm_ls_seeded_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await pageCtx.addInitScript(
          ({ origins, markerKey }) => {
            try {
              if (window.sessionStorage.getItem(markerKey) === '1') return;
              const m = origins.find((o) => o.origin === window.location.origin);
              if (m && Array.isArray(m.localStorage)) {
                for (const item of m.localStorage) {
                  window.localStorage.setItem(item.name, item.value);
                }
                window.sessionStorage.setItem(markerKey, '1');
              }
            } catch {
              // Ignore storage access errors on opaque origins.
            }
          },
          { origins: normalizedOrigins, markerKey: seedKey }
        );
        if (page.url().startsWith('http')) {
          const curOrigin = new URL(page.url()).origin;
          const match = normalizedOrigins.find((o) => o.origin === curOrigin);
          if (match) {
            await page.evaluate(
              ({ entries, markerKey }) => {
                if (Array.isArray(entries)) {
                  for (const item of entries) {
                    window.localStorage.setItem(item.name, item.value);
                  }
                }
                try {
                  window.sessionStorage.setItem(markerKey, '1');
                } catch {}
              },
              { entries: match.localStorage || null, markerKey: seedKey }
            );
          }
        }
      }
      result.loadedStorageStatePath = srcPath;
    }

    if (params.cookieAction === 'get') {
      const cookies = await pageCtx.cookies(params.urls);
      result.cookies = cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
        expires: c.expires,
      }));
    } else if (params.cookieAction === 'set') {
      const pageUrl = page.url();
      const normalized = (params.cookies || []).map((c) => {
        if (!c.url && !c.domain && pageUrl.startsWith('http')) {
          return { ...c, url: pageUrl };
        }
        return c;
      });
      await pageCtx.addCookies(normalized);
      result.cookiesSet = normalized.length;
    } else if (params.cookieAction === 'clear') {
      await pageCtx.clearCookies();
      result.cookiesCleared = true;
    }

    if (params.storageAction) {
      const storageType = params.storageType || 'local';
      result.storage = await page.evaluate(
        ({ action, kind, items }) => {
          const readStore = (s) => {
            const out = {};
            for (let i = 0; i < s.length; i++) {
              const k = s.key(i);
              if (k && k.startsWith('__tbm_ls_seeded_')) continue;
              out[k] = s.getItem(k);
            }
            return out;
          };
          const targets = kind === 'session'
            ? [['session', window.sessionStorage]]
            : kind === 'both'
              ? [['local', window.localStorage], ['session', window.sessionStorage]]
              : [['local', window.localStorage]];

          if (action === 'clear') {
            for (const [, store] of targets) store.clear();
            return { cleared: kind };
          }
          if (action === 'set' && items && typeof items === 'object') {
            for (const [, store] of targets) {
              for (const [k, v] of Object.entries(items)) {
                store.setItem(k, String(v));
              }
            }
            return { setKeys: Object.keys(items) };
          }
          const dump = {};
          for (const [name, store] of targets) dump[name] = readStore(store);
          return dump;
        },
        { action: params.storageAction, kind: storageType, items: params.items || {} }
      );
    }

    if (params.saveStorageStatePath) {
      const targetPath = resolveSafePath(params.saveStorageStatePath, 'saveStorageStatePath');
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      await pageCtx.storageState({ path: targetPath });
      result.savedStorageStatePath = targetPath;
    }

    return result;
  }

  async close() {
    // Contexts this process created (never the default/user context): close them so their pages go too.
    // Bounded, so a wedged browser cannot hang shutdown.
    const isoCloses = [...this.isolatedContexts.values()].map((ctx) => ctx.close().catch(() => {}));
    let isoTimer;
    await Promise.race([
      Promise.all(isoCloses),
      new Promise((resolve) => { isoTimer = setTimeout(resolve, 2000); }),
    ]);
    clearTimeout(isoTimer);
    this.isolatedContexts.clear();
    this.tabContextName.clear();

    if (this.connectionType === 'persistent' && this.context) {
      await this.context.close().catch(() => {});
    } else if (this.connectionType === 'launch' && this.browser) {
      await this.browser.close().catch(() => {});
    } else if (this.connectionType === 'cdp' && this.browser) {
      // Closing a connectOverCDP Browser disconnects without terminating the user's Chrome.
      await this.browser.close().catch(() => {});
    }
    for (const f of this.tempDownloadFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        // Ignore cleanup errors on already-removed or locked temp files.
      }
    }
    this.tempDownloadFiles.clear();
    this.tabs.clear();
    this.context = null;
    this.browser = null;
    this.activeTabId = null;
    this.connectionType = null;
  }
}
