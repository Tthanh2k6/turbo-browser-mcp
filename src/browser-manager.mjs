import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPlaywright, resolveChromiumExecutable } from './playwright-loader.mjs';

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
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return { test: (val) => val.toLowerCase().includes(String(pattern).toLowerCase()) };
  }
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

    this.browser = null;
    this.context = null;
    this.connectionType = null;
    this.initPromise = null;

    this.nextTabId = 1;
    this.activeTabId = null;
    this.tabs = new Map();
    this.isolatedContexts = new Map();
    this.tabContextName = new Map();
    this.pageToId = new WeakMap();
    this.attachedPages = new WeakSet();
    this.diagnostics = new WeakMap();
  }

  async ensureReady() {
    if (this.context) return;
    if (!this.initPromise) {
      this.initPromise = this._init().finally(() => {
        this.initPromise = null;
      });
    }
    await this.initPromise;
  }

  async _canReachCdp() {
    try {
      const url = new URL('/json/version', this.cdpUrl).href;
      const res = await fetch(url, { signal: AbortSignal.timeout(800) });
      return res.ok;
    } catch {
      return false;
    }
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

    if (this.mode === 'cdp' || (this.mode === 'auto' && (await this._canReachCdp()))) {
      try {
        this.browser = await chromium.connectOverCDP(this.cdpUrl);
        this.context = this.browser.contexts()[0] ?? (await this.browser.newContext());
        this.connectionType = 'cdp';
      } catch (err) {
        if (this.mode === 'cdp') {
          throw new Error(
            `Failed to attach via CDP at ${this.cdpUrl}. Start Chrome with --remote-debugging-port=9222. (${err.message})`
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

    this.context.setDefaultTimeout(this.defaultTimeoutMs);
    this.context.on('page', (page) => this._registerPage(page, true));
    for (const page of this.context.pages()) {
      this._registerPage(page, this.activeTabId === null);
    }
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
        routeHandlerAttached: false,
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

      page.on('request', (req) => {
        this._recordRequest(diag, req);
      });

      page.on('response', (res) => {
        const req = res.request();
        const entry = diag.reqObjToEntry.get(req) ?? this._recordRequest(diag, req);
        entry.status = res.status();
        entry.statusText = res.statusText();
        entry.ok = res.ok();
        entry.durationMs = Date.now() - entry.startTime;
        entry.responseHeaders = res.headers();
        entry._response = res;
      });

      page.on('requestfailed', (req) => {
        const entry = diag.reqObjToEntry.get(req) ?? this._recordRequest(diag, req);
        entry.ok = false;
        entry.failureText = req.failure()?.errorText || 'failed';
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
        const savePath = path.join(os.tmpdir(), `tbm-dl-${Date.now()}-${safeName}`);
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
      for (const page of ctx.pages()) {
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
      return { tabId, page: target };
    }

    if (this.activeTabId !== null && this.tabs.has(this.activeTabId)) {
      return { tabId: this.activeTabId, page: this.tabs.get(this.activeTabId) };
    }

    const page = await this.context.newPage();
    const newId = this._registerPage(page, true);
    return { tabId: newId, page };
  }

  getSnapshotState(page) {
    return this._ensureDiagState(page).lastSnapshotLines;
  }

  async listTabs() {
    await this.ensureReady();
    this._syncOpenPages();
    const results = [];
    for (const [tabId, page] of this.tabs.entries()) {
      let title = '';
      try {
        title = await page.title();
      } catch {
        title = '';
      }
      results.push({
        tabId,
        url: page.url(),
        title,
        active: tabId === this.activeTabId,
        isolatedContext: this.tabContextName.get(tabId) || 'default',
      });
    }
    return results;
  }

  async _getOrCreateContext(contextName) {
    if (!contextName || contextName === 'default') {
      return { name: 'default', ctx: this.context };
    }
    if (this.isolatedContexts.has(contextName)) {
      return { name: contextName, ctx: this.isolatedContexts.get(contextName) };
    }
    const browserRef = this.browser || this.context.browser();
    if (!browserRef) {
      throw new Error('isolatedContext requires a multi-context browser session (launch or cdp mode).');
    }
    const isoCtx = await browserRef.newContext({ viewport: { width: 1280, height: 800 } });
    isoCtx.setDefaultTimeout(this.defaultTimeoutMs);
    isoCtx.on('page', (page) => this._registerPage(page, true, contextName));
    this.isolatedContexts.set(contextName, isoCtx);
    return { name: contextName, ctx: isoCtx };
  }

  async tabsBatch(operations = []) {
    const batchStart = Date.now();
    await this.ensureReady();
    this._syncOpenPages();

    const ops = Array.isArray(operations) && operations.length > 0
      ? operations
      : [{ action: 'list' }];

    const results = [];
    for (const op of ops) {
      const action = op.action || (op.url ? 'open' : 'list');

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
        results.push({ action: 'list', tabs: await this.listTabs() });
        continue;
      }

      if (action === 'open_many') {
        const urls = Array.isArray(op.urls) ? op.urls.map((u) => String(u)).filter(Boolean) : [];
        if (urls.length === 0) throw new Error('open_many action requires a non-empty urls array.');
        const batchT0 = Date.now();
        const prevActiveTabId = this.activeTabId;
        const { name: ctxName, ctx } = await this._getOrCreateContext(op.isolatedContext);
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
              const page = await ctx.newPage();
              const tabId = this._registerPage(page, false, ctxName);
              await page.goto(targetUrl, navOpts);
              return {
                tabId,
                isolatedContext: ctxName,
                url: page.url(),
                title: await page.title().catch(() => ''),
              };
            })
          );
          opened.push(...chunkResults);
        }
        if (op.activate === false) {
          this.activeTabId = prevActiveTabId;
        } else if (opened.length > 0) {
          this.activeTabId = opened[opened.length - 1].tabId;
        }
        results.push({
          action: 'open_many',
          opened,
          elapsedMs: Date.now() - batchT0,
        });
        continue;
      }

      if (action === 'open') {
        const { name: ctxName, ctx } = await this._getOrCreateContext(op.isolatedContext);
        const page = await ctx.newPage();
        const tabId = this._registerPage(page, op.activate !== false, ctxName);
        if (op.url) {
          await page.goto(op.url, {
            waitUntil: op.waitUntil || 'domcontentloaded',
            timeout: op.timeoutMs || this.defaultTimeoutMs,
          });
        }
        results.push({
          action: 'open',
          tabId,
          isolatedContext: ctxName,
          url: page.url(),
          title: await page.title().catch(() => ''),
        });
        continue;
      }

      if (action === 'navigate') {
        const { tabId, page } = await this.getPage(op.tabId);
        if (!op.url) throw new Error('navigate action requires url.');
        await page.goto(op.url, {
          waitUntil: op.waitUntil || 'domcontentloaded',
          timeout: op.timeoutMs || this.defaultTimeoutMs,
        });
        if (op.activate !== false) this.activeTabId = tabId;
        results.push({
          action: 'navigate',
          tabId,
          url: page.url(),
          title: await page.title().catch(() => ''),
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
        if (op.viewport?.width && op.viewport?.height) {
          await page.setViewportSize({
            width: Number(op.viewport.width),
            height: Number(op.viewport.height),
          });
        }
        if (op.userAgent) {
          const client = await page.context().newCDPSession(page);
          await client.send('Emulation.setUserAgentOverride', { userAgent: String(op.userAgent) });
          await client.detach().catch(() => {});
        }
        results.push({
          action: 'emulate',
          tabId,
          ...mediaOpts,
          viewport: op.viewport || undefined,
          userAgent: op.userAgent ? true : undefined,
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
        await page.close();
        this.tabs.delete(tabId);
        this._syncOpenPages();
        results.push({ action: 'close', tabId, activeTabId: this.activeTabId });
        continue;
      }

      throw new Error(`Unsupported tabs_batch action: ${action}`);
    }

    return {
      connectionType: this.connectionType,
      activeTabId: this.activeTabId,
      elapsedMs: Date.now() - batchStart,
      results,
      tabs: await this.listTabs(),
    };
  }

  async getDiagnostics(tabId, options = {}) {
    const opts = typeof options === 'boolean' ? { clear: options } : (options || {});
    const { tabId: id, page } = await this.getPage(tabId);
    const diag = this._ensureDiagState(page);

    if (diag.pendingDownloads.length > 0) {
      await Promise.allSettled([...diag.pendingDownloads]);
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
        const resolved = path.resolve(process.cwd(), String(opts.savePath));
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, JSON.stringify(detailPayload, null, 2), 'utf8');
        detailPayload.savePath = resolved;
      }
      return detailPayload;
    }

    const level = opts.level || 'errors';
    const statusFilter = opts.statusFilter || 'errors';
    const includeStatic = Boolean(opts.includeStatic);
    const urlMatcher = opts.urlFilter ? compileUrlPattern(opts.urlFilter) : null;

    const consoleFiltered = level === 'all'
      ? [...diag.console]
      : diag.console.filter((c) => ERROR_CONSOLE_LEVELS.has(c.level));

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
    const networkErrors = diag.requests.filter((r) => isErrorReq(r) && matchesUrl(r)).map(compactReq);

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

    if (opts.savePath) {
      const resolved = path.resolve(process.cwd(), String(opts.savePath));
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, JSON.stringify(snapshot, null, 2), 'utf8');
      snapshot.savePath = resolved;
    }

    if (opts.clear) {
      diag.console.length = 0;
      diag.requests.length = 0;
      diag.requestMap.clear();
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
    ];
    const blockUrlsInput = [
      ...(presetSpec ? presetSpec.urls : []),
      ...(Array.isArray(params.blockUrls) ? params.blockUrls : []),
    ];

    if (blockResourcesInput.length > 0 || blockUrlsInput.length > 0) {
      for (const r of blockResourcesInput) diag.blockedResources.add(String(r).toLowerCase());
      const existingSources = new Set(diag.blockedUrlPatterns.map((p) => p.source));
      for (const pat of blockUrlsInput) {
        const src = String(pat);
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
      const targetPath = path.resolve(process.cwd(), String(params.saveStorageStatePath));
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      await pageCtx.storageState({ path: targetPath });
      result.savedStorageStatePath = targetPath;
    }

    if (params.loadStorageStatePath) {
      const srcPath = path.resolve(process.cwd(), String(params.loadStorageStatePath));
      const raw = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
      if (Array.isArray(raw.cookies) && raw.cookies.length > 0) {
        await pageCtx.addCookies(raw.cookies);
      }
      if (Array.isArray(raw.origins) && raw.origins.length > 0 && page.url().startsWith('http')) {
        const curOrigin = new URL(page.url()).origin;
        const match = raw.origins.find((o) => o.origin === curOrigin);
        if (match && Array.isArray(match.localStorage)) {
          await page.evaluate((entries) => {
            for (const item of entries) {
              window.localStorage.setItem(item.name, item.value);
            }
          }, match.localStorage);
        }
      }
      result.loadedStorageStatePath = srcPath;
    }

    return result;
  }

  async close() {
    for (const ctx of this.isolatedContexts.values()) {
      await ctx.close().catch(() => {});
    }
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
    this.tabs.clear();
    this.context = null;
    this.browser = null;
    this.activeTabId = null;
    this.connectionType = null;
  }
}
