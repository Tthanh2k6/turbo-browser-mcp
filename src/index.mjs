#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { turboHome } from './home.mjs';
import { fileURLToPath } from 'node:url';
import { BrowserManager } from './browser-manager.mjs';
import {
  ensureCdpBridgeDaemon,
  getRunningBridgeInfo,
  launchUnattendedChrome,
  redactBridgeToken,
} from './cdp-bridge.mjs';
import {
  diagnoseEnvironment,
  loadPlaywright,
  resolveActiveCdpEndpoint,
  resolveChromiumExecutable,
} from './playwright-loader.mjs';
import {
  actFast,
  batchActions,
  cleanErrorMessage,
  capturePage,
  evaluateJs,
  extractCleanText,
  inspectCompact,
  smartFillFormGuarded,
} from './dom-engine.mjs';
import { takeLate } from './aftermath.mjs';
import { getPolicy, takeBlocked } from './allow-hosts.mjs';
import { waitForHuman } from './guards.mjs';
import { boundariesEnabled, boundaryInstruction, wrapPage } from './boundaries.mjs';
import { getSecrets, redactText, resolveSecretArgs } from './secrets.mjs';

// Read from package.json so --version, --doctor and serverInfo never drift from the published version.
const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

export const SKILL_PATH = fileURLToPath(new URL('../skills/turbo-browser/SKILL.md', import.meta.url));

const SERVER_INFO = {
  name: 'turbo-browser-mcp',
  version: PACKAGE_VERSION,
};

// Kept short on purpose: every byte here is sent to the model on every turn.
// Declared only on batch_actions. act_fast and batch_actions also accept them (plus ledgerPath),
// and the network guard is configured by env (TURBO_BROWSER_NETWORK_GUARD, ..._ALLOW) or the
// undeclared networkGuard / networkGuardAllow / networkGuardSettleMs arguments. See README.
const COMMIT_PROPS = {
  expect: {
    type: 'object',
    description: 'Submit evidence to wait for; returns submitVerified.',
    properties: {
      urlMatches: { type: 'string' },
      textMatches: { type: 'string' },
      textNew: { type: 'string', description: 'Like textMatches, only text new since the click.' },
      selector: { type: 'string' },
      timeoutMs: { type: 'integer' },
    },
  },
  submissionKey: { type: 'string', description: 'Idempotency key; repeat submits are refused.' },
  allowDuplicate: { type: 'boolean' },
};

// Sent once in the initialize result. Keep it short and do not repeat it in tool descriptions.
export const SERVER_INSTRUCTIONS =
  'Fill several fields, comboboxes ({ref, option}) and uploads with one smart_fill_form. Chain steps with batch_actions (returnSnapshot=true for the end state). ' +
  'After the first inspect_compact use onlyChanged=true; * marks new refs. Use refs from the latest snapshot.';

// Opt-in smaller tool list (--tools core / TURBO_BROWSER_TOOLS=core).
export const CORE_TOOL_NAMES = [
  'tabs_batch', 'inspect_compact', 'smart_fill_form', 'act_fast', 'batch_actions', 'extract_clean_text',
];
export function activeToolDefinitions(env = process.env) {
  return String(env.TURBO_BROWSER_TOOLS || '').toLowerCase() === 'core'
    ? TOOL_DEFINITIONS.filter((t) => CORE_TOOL_NAMES.includes(t.name))
    : TOOL_DEFINITIONS;
}

const SUPPORTED_PROTOCOL = '2025-03-26';
const SUPPORTED_PROTOCOLS = new Set(['2025-03-26', '2024-11-05', '2024-10-07']);

export const TOOL_DEFINITIONS = [
  {
    name: 'tabs_batch',
    description:
      'Tab operations in one call: list, open/open_many, navigate, activate, resize, emulate, reload, back/forward, close.',
    annotations: {
      title: 'Batch Tab Manager',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        includeTabs: {
          type: 'boolean',
          description: 'true always returns the tab list; false never does. Default: only when listed, tabs closed/opened in bulk, or unexpectedly changed.',
        },
        operations: {
          type: 'array',
          description: 'List of tab operations executed in order.',
          items: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: [
                  'list',
                  'open',
                  'open_many',
                  'navigate',
                  'activate',
                  'resize',
                  'emulate',
                  'reload',
                  'back',
                  'forward',
                  'close',
                  'close_browser',
                ],
              },
              url: { type: 'string' },
              urls: {
                type: 'array',
                items: { type: 'string' },
                description: 'URLs for parallel open_many action.',
              },
              concurrency: {
                type: 'integer',
                default: 5,
                description: 'Max concurrent tabs opened per batch for open_many (1-10).',
              },
              tabId: { type: 'integer' },
              force: { type: 'boolean', description: 'close: allow closing the last tab of an attached browser (this closes the browser).' },
              activate: { type: 'boolean' },
              isolatedContext: {
                type: 'string',
                description: 'Optional isolated context name for open action (separate cookies/storage).',
              },
              width: { type: 'integer' },
              height: { type: 'integer' },
              colorScheme: { oneOf: [{ type: 'string', enum: ['light', 'dark', 'no-preference'] }, { type: 'null' }] },
              media: { oneOf: [{ type: 'string', enum: ['screen', 'print'] }, { type: 'null' }] },
              reducedMotion: { oneOf: [{ type: 'string', enum: ['reduce', 'no-preference'] }, { type: 'null' }] },
              forcedColors: { oneOf: [{ type: 'string', enum: ['active', 'none'] }, { type: 'null' }] },
              contrast: { oneOf: [{ type: 'string', enum: ['more', 'no-preference'] }, { type: 'null' }] },
              userAgent: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              viewport: {
                type: 'object',
                properties: {
                  width: { type: 'integer' },
                  height: { type: 'integer' },
                },
              },
              waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle', 'commit'] },
              timeoutMs: { type: 'integer' },
            },
          },
        },
      },
    },
  },
  {
    name: 'inspect_compact',
    description:
      'List interactive elements (with refs), forms or readable sections across frames and open Shadow DOM, capped at maxChars.',
    annotations: {
      title: 'Inspect Compact DOM',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        mode: {
          type: 'string',
          enum: ['interactive', 'forms', 'article', 'all'],
          default: 'interactive',
        },
        maxChars: { type: 'integer', default: 4000 },
        includeFrames: { type: 'boolean', default: true },
        selector: { type: 'string' },
        query: { type: 'string', description: 'Filter elements matching regex or substring.' },
        onlyChanged: {
          type: 'boolean',
          default: false,
          description: 'Omit elements unchanged since the previous inspect_compact snapshot.',
        },
        boxes: {
          type: 'boolean',
          default: false,
          description: 'Include element bounding boxes [box=x,y,w,h] in snapshot lines.',
        },
        savePath: {
          type: 'string',
          description: 'File under cwd or TURBO_BROWSER_SAVE_ROOT.',
        },
      },
    },
  },
  {
    name: 'smart_fill_form',
    description:
      'Fill several fields at once: inputs, editors, comboboxes, selects, checkboxes, Shadow DOM/iframe fields, file uploads. Stops before Submit by default.',
    annotations: {
      title: 'Smart Form Prefill',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string' },
              selector: { type: 'string' },
              frameIdx: { type: 'integer' },
              keys: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
              not: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
              value: { oneOf: [{ type: 'string' }, { type: 'boolean' }, { type: 'number' }, { type: 'array', items: { type: 'string' } }] },
              values: {
                type: 'array',
                items: { type: 'string' },
                description: 'Multiple option values/patterns for <select multiple>.',
              },
              option: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
              check: {
                oneOf: [{ type: 'string' }, { type: 'boolean' }, { type: 'array', items: { type: 'string' } }],
                description: 'true/false sets a checkbox/radio; label(s) check matching options.',
              },
              file: { type: 'string' },
              files: { type: 'array', items: { type: 'string' } },
              all: {
                type: 'boolean',
                description: 'When true, fill all matching controls across frames instead of only the best match.',
              },
            },
          },
        },
        main: { type: 'string' },
        gmail: {
          type: 'object',
          properties: {
            to: { type: 'string' },
            subject: { type: 'string' },
            body: { type: 'string' },
          },
        },
        overwrite: { type: 'boolean', default: false },
        stopBeforeSubmit: { type: 'boolean', default: true },
        returnSnapshot: { type: 'boolean', default: false },
        snapshotMode: { type: 'string', enum: ['interactive', 'forms', 'article', 'all'] },
        snapshotMaxChars: { type: 'integer', default: 2500 },
      },
    },
  },
  {
    name: 'act_fast',
    description:
      'One action on a ref, selector, text or x/y. Supports returnSnapshot; blocks submit/publish/send unless allowSubmit=true.',
    annotations: {
      title: 'Fast Page Action',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        tabId: { type: 'integer' },
        action: {
          type: 'string',
          enum: [
            'click',
            'dblclick',
            'hover',
            'focus',
            'clear',
            'fill',
            'type',
            'select',
            'check',
            'uncheck',
            'drag',
            'drop',
            'press',
            'scroll',
            'wait',
            'upload',
          ],
        },
        ref: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string', description: 'Visible text. For wait: "A|B" matches any alternative (result.matched).' },
        frameIdx: { type: 'integer' },
        x: { type: 'number', description: 'Viewport x coordinate (or offset relative to target).' },
        y: { type: 'number', description: 'Viewport y coordinate (or offset relative to target).' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'] },
        },
        targetRef: { type: 'string', description: 'Drop target ref for drag action.' },
        targetSelector: { type: 'string', description: 'Drop target selector for drag action.' },
        targetText: { type: 'string', description: 'Drop target text for drag action.' },
        targetFrameIdx: { type: 'integer' },
        value: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        values: {
          type: 'array',
          items: { type: 'string' },
          description: 'Multiple option values/labels for select action.',
        },
        label: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        slowly: {
          type: 'boolean',
          description: 'When false fills immediately; when true types character by character.',
        },
        submit: {
          type: 'boolean',
          default: false,
          description: 'Press Enter after type action (blocked unless allowSubmit=true).',
        },
        delayMs: { type: 'integer' },
        key: { type: 'string' },
        file: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        dropData: {
          type: 'object',
          description: 'Custom MIME type -> string data entries for drop action DataTransfer.',
        },
        dx: { type: 'number' },
        dy: { type: 'number' },
        ms: { type: 'integer' },
        textGone: { type: 'string', description: 'Wait until matching text disappears.' },
        textNew: { type: 'string', description: 'Wait for text ("A|B") appearing after the step starts; existing matches ignored.' },
        url: { type: 'string', description: 'Wait until page URL matches pattern.' },
        loadState: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] },
        state: { type: 'string', enum: ['visible', 'hidden', 'attached', 'detached'] },
        timeoutMs: { type: 'integer' },
        observeAftermath: { type: 'boolean', description: 'Observe click navigation and mutating requests (up to 800 ms); report possible submits.' },
        allowSubmit: { type: 'boolean', default: false },
        returnSnapshot: { type: 'boolean', default: false },
        snapshotMode: { type: 'string', enum: ['interactive', 'forms', 'article', 'all'] },
        snapshotMaxChars: { type: 'integer', default: 2500 },
        snapshotQuery: { type: 'string' },
      },
    },
  },
  {
    name: 'batch_actions',
    description:
      'Run actions or smart_fill_form steps in order, including navigate/extract for multi-page reading. Stops on Submit guard blocks; optional post-batch snapshot.',
    annotations: {
      title: 'Batch Sequential Actions',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      required: ['steps'],
      properties: {
        tabId: { type: 'integer' },
        steps: {
          type: 'array',
          description: 'act_fast or smart_fill_form steps (incl. reload/back/forward); also {action:"navigate",url} (GET only), {action:"extract",format:"text"|"markdown",selector?,maxChars?}, {action:"collect",selector,scrolls?:5,waitMs?:400,maxItems?:100,maxChars?:8000,fields?:["text","href","id"],textSelector?} (scroll, read matching elements each time, dedupe: virtualized feeds).',
          items: { type: 'object' },
        },
        continueOnError: { type: 'boolean', default: false },
        observeAftermath: { type: 'boolean', description: 'Observe click aftermath for each action (adds up to 800 ms per click).' },
        allowSubmit: { type: 'boolean', default: false },
        returnSnapshot: { type: 'boolean', default: false },
        snapshotMode: { type: 'string', enum: ['interactive', 'forms', 'article', 'all'] },
        snapshotMaxChars: { type: 'integer', default: 2500 },
        snapshotQuery: { type: 'string' },
        ...COMMIT_PROPS,
      },
    },
  },
  {
    name: 'extract_clean_text',
    description:
      'Extract readable text or markdown from the main content and iframes, capped at maxChars.',
    annotations: {
      title: 'Extract Clean Page Text',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        selector: { type: 'string' },
        includeFrames: { type: 'boolean', default: true },
        format: { type: 'string', enum: ['text', 'markdown'], default: 'text' },
        maxChars: { type: 'integer', default: 6000 },
        savePath: {
          type: 'string',
          description: 'File under cwd or TURBO_BROWSER_SAVE_ROOT.',
        },
      },
    },
  },
  {
    name: 'evaluate_js',
    description:
      'Evaluate JavaScript in a frame or element (ref/selector/text passes el and arg); returns JSON.',
    annotations: {
      title: 'Evaluate Frame JavaScript',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      required: ['expression'],
      properties: {
        tabId: { type: 'integer' },
        expression: { type: 'string' },
        frameIdx: { type: 'integer', default: 0 },
        ref: { type: 'string', description: 'Optional target element ref (passes (el, arg) to expression).' },
        selector: { type: 'string', description: 'Optional target selector (passes (el, arg) to expression).' },
        text: { type: 'string', description: 'Optional visible text target (passes (el, arg) to expression).' },
        arg: {},
        savePath: {
          type: 'string',
          description: 'File under cwd or TURBO_BROWSER_SAVE_ROOT. Full result goes to the file; the reply has only savePath, bytes and a 300-char preview.',
        },
      },
    },
  },
  {
    name: 'page_diagnostics',
    description:
      'Read buffered console logs, network requests, downloads and dialogs for a tab.',
    annotations: {
      title: 'Page Diagnostics & Network Inspector',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        level: { type: 'string', enum: ['errors', 'all'], default: 'errors' },
        statusFilter: { type: 'string', enum: ['errors', 'all'], default: 'errors' },
        includeStatic: {
          type: 'boolean',
          default: false,
          description: 'Include 2xx static assets (image, font, stylesheet, media) when statusFilter=all.',
        },
        urlFilter: {
          type: 'string',
          description: 'Filter requests/networkErrors by URL substring or regex.',
        },
        reqId: { type: 'string', description: 'Inspect headers, postData, and response body for one request ID.' },
        part: {
          type: 'string',
          enum: ['request-headers', 'request-body', 'response-headers', 'response-body'],
          description: 'Return only one section when reqId is set.',
        },
        maxBodyChars: { type: 'integer', default: 4000 },
        dialogPolicy: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['dismiss', 'accept'] },
            promptText: { type: 'string' },
          },
        },
        savePath: {
          type: 'string',
          description: 'File under cwd or TURBO_BROWSER_SAVE_ROOT.',
        },
        clear: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'capture_page',
    description:
      'Screenshot (png/jpeg) or PDF of the page or an element, saved under cwd or TURBO_BROWSER_SAVE_ROOT; optional inline image.',
    annotations: {
      title: 'Capture Screenshot or PDF',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        mode: { type: 'string', enum: ['screenshot', 'pdf'], default: 'screenshot' },
        ref: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        frameIdx: { type: 'integer' },
        fullPage: { type: 'boolean', default: false },
        type: { type: 'string', enum: ['png', 'jpeg'], default: 'png' },
        quality: { type: 'integer', default: 80 },
        scale: { type: 'string', enum: ['css', 'device'], default: 'css' },
        savePath: { type: 'string' },
        returnImage: { type: 'boolean' },
      },
    },
  },
  {
    name: 'network_session',
    description:
      'Manage browser cookies, localStorage/sessionStorage, Playwright storageState files, quick blocking presets (turbo, no-images, no-media, clean), and custom resource/URL blocking.',
    annotations: {
      title: 'Network & Session Control',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        preset: {
          type: 'string',
          enum: ['turbo', 'no-images', 'no-media', 'clean'],
          description: 'Quick resource/tracker blocking preset for faster page loads (clean unblocks all).',
        },
        cookieAction: { type: 'string', enum: ['get', 'set', 'clear'] },
        urls: { type: 'array', items: { type: 'string' } },
        cookies: { type: 'array', items: { type: 'object' } },
        storageAction: { type: 'string', enum: ['get', 'set', 'clear'] },
        storageType: { type: 'string', enum: ['local', 'session', 'both'], default: 'local' },
        items: { type: 'object' },
        saveStorageStatePath: {
          type: 'string',
          description: 'Save storageState under cwd or TURBO_BROWSER_SAVE_ROOT.',
        },
        loadStorageStatePath: {
          type: 'string',
          description: 'Load storageState from cwd or TURBO_BROWSER_SAVE_ROOT.',
        },
        blockResources: { type: 'array', items: { type: 'string' } },
        blockUrls: { type: 'array', items: { type: 'string' } },
        unblockAll: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'wait_for_human',
    description:
      'Let a human do a step (login, bot check, 2FA) in the visible browser; wait until a condition holds, then continue in the same session. Only waits.',
    annotations: {
      title: 'Wait For Human Step',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        message: { type: 'string' },
        urlMatches: { type: 'string' },
        selector: { type: 'string' },
        textMatches: { type: 'string' },
        textGone: { type: 'string' },
        timeoutMs: { type: 'integer', default: 120000 },
      },
    },
  },
];

/**
 * Single boundary for every tool call. With a secrets file configured, `$secret:NAME` values are
 * resolved on the way in and every result (text and errors) is redacted on the way out.
 * Without one this is a straight pass-through.
 */
export async function dispatchToolCall(manager, name, rawArgs = {}) {
  const secrets = getSecrets();
  if (!secrets) return dispatchToolCallBase(manager, name, rawArgs);
  const args = resolveSecretArgs(rawArgs, secrets);
  try {
    const res = await dispatchToolCallBase(manager, name, args);
    if (res && typeof res.text === 'string') res.text = redactText(res.text, secrets);
    return res;
  } catch (err) {
    if (err && typeof err.message === 'string') {
      const clean = redactText(err.message, secrets);
      if (clean !== err.message) err.message = clean;
    }
    throw err;
  }
}

async function dispatchToolCallBase(manager, name, rawArgs = {}) {
  const res = await dispatchToolCallInner(manager, name, rawArgs);
  const lateTab = manager.tabs?.get?.(rawArgs?.tabId ?? manager.activeTabId);
  const late = lateTab ? takeLate(lateTab) : '';
  if (late && res && typeof res.text === 'string') {
    res.text = res.text.startsWith('{') ? `{"late":${JSON.stringify(late)}${res.text[1] === '}' ? '' : ','}${res.text.slice(1)}` : `late: ${late}
${res.text}`;
  }
  if (getPolicy() && lateTab && res && typeof res.text === 'string') {
    const b = takeBlocked(lateTab);
    if (b && !res.text.includes('"blocked":"host-not-allowed"')) {
      let obj = null;
      if (res.text.startsWith('{')) { try { obj = JSON.parse(res.text); } catch { obj = null; } }
      if (obj && typeof obj === 'object') {
        // Rare path: parse and re-emit so a result that already has a boolean "blocked" (submit guard) keeps one key.
        const { blocked: prior, ...rest } = obj;
        res.text = JSON.stringify(prior ? { ...obj, navBlocked: 'host-not-allowed', blockedUrl: b.url } : { blocked: 'host-not-allowed', blockedUrl: b.url, ...rest });
      } else {
        res.text = `blocked: host-not-allowed ${b.url}
${res.text}`;
      }
    }
  }
  const note = typeof manager.takeConnectionNote === 'function' ? manager.takeConnectionNote() : '';
  if (note && res && typeof res.text === 'string') {
    res.text = res.text.startsWith('{')
      ? `{"connectionNote":${JSON.stringify(note)}${res.text[1] === '}' ? '' : ','}${res.text.slice(1)}`
      : `connectionNote: ${note}
${res.text}`;
  }
  return res;
}

async function dispatchToolCallInner(manager, name, rawArgs = {}) {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
  switch (name) {
    case 'tabs_batch': {
      const res = await manager.tabsBatch(args.operations || [], { includeTabs: args.includeTabs });
      return { text: JSON.stringify(res) };
    }
    case 'inspect_compact': {
      const { tabId, page } = await manager.getPage(args.tabId);
      const res = await inspectCompact(page, args, manager.getSnapshotState(page));
      return {
        text: `tabId=${tabId} | chars=${res.charCount} | truncated=${res.truncated} | ms=${res.elapsedMs}${res.savePath ? ` | savePath=${res.savePath}${res.fullChars ? ` (full ${res.fullChars} chars)` : ''}` : ''}\n${wrapPage(res.text)}`,
      };
    }
    case 'smart_fill_form': {
      const { tabId, page } = await manager.getPage(args.tabId);
      const res = await smartFillFormGuarded(page, args, manager.getSnapshotState(page));
      return { text: JSON.stringify({ tabId, ...res }) };
    }
    case 'act_fast': {
      const { tabId, page } = await manager.getPage(args.tabId);
      const res = await actFast(page, args, manager.getSnapshotState(page));
      return { text: JSON.stringify({ tabId, ...res }) };
    }
    case 'batch_actions': {
      if (!Array.isArray(args.steps) || args.steps.length === 0) {
        throw new Error('batch_actions requires a non-empty steps array.');
      }
      const { tabId, page } = await manager.getPage(args.tabId);
      const res = await batchActions(
        page,
        args.steps,
        {
          continueOnError: args.continueOnError,
          allowSubmit: args.allowSubmit,
          observeAftermath: args.observeAftermath,
          returnSnapshot: args.returnSnapshot,
          snapshotMode: args.snapshotMode,
          snapshotMaxChars: args.snapshotMaxChars,
          snapshotQuery: args.snapshotQuery,
          expect: args.expect,
          submissionKey: args.submissionKey,
          allowDuplicate: args.allowDuplicate,
          ledgerPath: args.ledgerPath,
          networkGuard: args.networkGuard,
          networkGuardAllow: args.networkGuardAllow,
          networkGuardSettleMs: args.networkGuardSettleMs,
        },
        manager.getSnapshotState(page)
      );
      return { text: JSON.stringify({ tabId, ...res }) };
    }
    case 'wait_for_human': {
      const { tabId, page } = await manager.getPage(args.tabId);
      const res = await waitForHuman(page, args);
      return { text: JSON.stringify({ tabId, ...res }) };
    }
    case 'extract_clean_text': {
      const { tabId, page } = await manager.getPage(args.tabId);
      const res = await extractCleanText(page, args);
      return {
        text: `tabId=${tabId} | chars=${res.charCount} | truncated=${res.truncated}${res.note ? ` | note=${res.note}` : ''}${res.savePath ? ` | savePath=${res.savePath}${res.fullChars ? ` (full ${res.fullChars} chars)` : ''}` : ''}\n${wrapPage(res.text)}`,
      };
    }
    case 'evaluate_js': {
      const { tabId, page } = await manager.getPage(args.tabId);
      const res = await evaluateJs(page, args);
      // With savePath the full result lives in the file: return only its location, size and a short preview.
      const { result: fullResult, ...rest } = res;
      if (boundariesEnabled() && !res.savePath) {
        // Page-sourced value: metadata as JSON, then the serialized result inside the markers.
        const { result: pageValue, ...meta } = res;
        let body = typeof pageValue === 'string' ? pageValue : JSON.stringify(pageValue);
        if (body.length > 19000) body = `${body.slice(0, 18980)}... [truncated]`; // cut inside the markers
        return { text: `${JSON.stringify({ tabId, ...meta })}
${wrapPage(body)}` };
      }
      const encoded = JSON.stringify(res.savePath ? { tabId, ...rest } : { tabId, ...res });
      return {
        text: encoded.length > 20000
          ? `${encoded.slice(0, 19980)}... [truncated]`
          : encoded,
      };
    }
    case 'page_diagnostics': {
      const res = await manager.getDiagnostics(args.tabId, {
        level: args.level,
        statusFilter: args.statusFilter,
        includeStatic: Boolean(args.includeStatic),
        urlFilter: args.urlFilter,
        reqId: args.reqId,
        part: args.part,
        maxBodyChars: args.maxBodyChars,
        dialogPolicy: args.dialogPolicy,
        savePath: args.savePath,
        clear: Boolean(args.clear),
      });
      return { text: JSON.stringify(res) };
    }
    case 'capture_page': {
      const { tabId, page } = await manager.getPage(args.tabId);
      const res = await capturePage(page, args);
      const { base64, ...meta } = res;
      return {
        text: JSON.stringify({ tabId, ...meta }),
        image: base64 ? { data: base64, mimeType: res.mimeType } : null,
      };
    }
    case 'network_session': {
      const res = await manager.manageNetworkSession(args.tabId, args);
      return { text: JSON.stringify(res) };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function createJsonRpcHandler(manager) {
  async function handleSingleRequest(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      };
    }

    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== undefined;
    const { id, method } = msg;

    if (hasId) {
      const isValidId =
        id === null ||
        typeof id === 'string' ||
        (typeof id === 'number' && Number.isFinite(id));
      if (!isValidId) {
        return {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Invalid Request: id must be a string, number, or null' },
        };
      }
    }

    if (msg.jsonrpc !== '2.0') {
      return {
        jsonrpc: '2.0',
        id: hasId ? id : null,
        error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' },
      };
    }

    if (!method || typeof method !== 'string') {
      return {
        jsonrpc: '2.0',
        id: hasId ? id : null,
        error: { code: -32600, message: 'Invalid Request: method must be a non-empty string' },
      };
    }

    // Valid notifications carry no id and expect no reply.
    if (!hasId) {
      return null;
    }

    if (
      msg.params !== undefined &&
      msg.params !== null &&
      (typeof msg.params !== 'object' || Array.isArray(msg.params))
    ) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'Invalid params: params must be an object' },
      };
    }
    const params = msg.params ?? {};

    try {
      if (method === 'initialize') {
        const negotiatedProtocol =
          params.protocolVersion && SUPPORTED_PROTOCOLS.has(params.protocolVersion)
            ? params.protocolVersion
            : SUPPORTED_PROTOCOL;
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: negotiatedProtocol,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
            instructions: SERVER_INSTRUCTIONS + boundaryInstruction(),
          },
        };
      }

      if (method === 'ping') {
        return { jsonrpc: '2.0', id, result: {} };
      }

      if (method === 'tools/list') {
        return {
          jsonrpc: '2.0',
          id,
          result: { tools: activeToolDefinitions() },
        };
      }

      if (method === 'tools/call') {
        if (!params.name || typeof params.name !== 'string') {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: 'Invalid params: tools/call requires a string tool name' },
          };
        }
        if (
          params.arguments !== undefined &&
          params.arguments !== null &&
          (typeof params.arguments !== 'object' || Array.isArray(params.arguments))
        ) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: 'Invalid params: arguments must be an object' },
          };
        }
        const toolName = params.name;
        const toolArgs = params.arguments ?? {};
        if (TOOL_DEFINITIONS.some((t) => t.name === toolName) && !activeToolDefinitions().some((t) => t.name === toolName)) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `Tool "${toolName}" is not available (TURBO_BROWSER_TOOLS=core).` }],
              isError: true,
            },
          };
        }
        try {
          const out = await dispatchToolCall(manager, toolName, toolArgs);
          const content = [{ type: 'text', text: out.text }];
          if (out.image) {
            content.push({
              type: 'image',
              data: out.image.data,
              mimeType: out.image.mimeType,
            });
          }
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content,
              isError: false,
            },
          };
        } catch (err) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: cleanErrorMessage(err?.message || err) }],
              isError: true,
            },
          };
        }
      }

      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: String(err?.message || err) },
      };
    }
  }

  return async function handleMessage(msg) {
    if (Array.isArray(msg)) {
      if (msg.length === 0) {
        return {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Invalid Request: empty batch' },
        };
      }
      const replies = [];
      for (const item of msg) {
        const rep = await handleSingleRequest(item);
        if (rep) replies.push(rep);
      }
      return replies.length > 0 ? replies : null;
    }
    return handleSingleRequest(msg);
  };
}

/**
 * Start stdio transport supporting both newline-delimited JSON and Content-Length framing.
 */
export function startStdioServer(manager = new BrowserManager()) {
  const handle = createJsonRpcHandler(manager);
  let buffer = Buffer.alloc(0);
  let useContentLength = false;
  let rpcChain = Promise.resolve();

  const writeReply = (obj) => {
    if (!obj) return;
    const json = JSON.stringify(obj);
    if (useContentLength) {
      const len = Buffer.byteLength(json, 'utf8');
      process.stdout.write(`Content-Length: ${len}\r\n\r\n${json}`);
    } else {
      process.stdout.write(`${json}\n`);
    }
  };

  const enqueueMessage = (rawJson) => {
    rpcChain = rpcChain
      .then(async () => {
        let msg;
        try {
          msg = JSON.parse(rawJson);
        } catch (err) {
          process.stderr.write(`[turbo-browser-mcp] JSON parse error: ${err.message}\n`);
          writeReply({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: `Parse error: ${err.message}` },
          });
          return;
        }
        try {
          const reply = await handle(msg);
          writeReply(reply);
        } catch (err) {
          process.stderr.write(`[turbo-browser-mcp] RPC handler error: ${err?.message || err}\n`);
          writeReply({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32603, message: String(err?.message || err) },
          });
        }
      })
      .catch(() => {});
  };

  const drainBuffer = () => {
    while (buffer.length > 0) {
      while (buffer.length > 0 && (buffer[0] === 0x0d || buffer[0] === 0x0a)) {
        buffer = buffer.subarray(1);
      }
      if (buffer.length === 0) break;

      const head = buffer.subarray(0, Math.min(buffer.length, 256)).toString('utf8');
      const lowerHead = head.toLowerCase();
      if (
        buffer.length < 32 &&
        buffer.indexOf(0x0a) === -1 &&
        ('content-length:'.startsWith(lowerHead) ||
          'content-type:'.startsWith(lowerHead) ||
          /^content-[a-z0-9-]*$/i.test(head) ||
          /^x-[a-z0-9-]*$/i.test(head))
      ) {
        break;
      }
      if (/^(?:content-length|content-type|x-[a-z0-9-]+)\s*:/i.test(head)) {
        useContentLength = true;
        const crlfEnd = buffer.indexOf('\r\n\r\n');
        const lfEnd = buffer.indexOf('\n\n');
        let headerEnd = -1;
        let sepLen = 4;
        if (crlfEnd !== -1 && (lfEnd === -1 || crlfEnd <= lfEnd)) {
          headerEnd = crlfEnd;
          sepLen = 4;
        } else if (lfEnd !== -1) {
          headerEnd = lfEnd;
          sepLen = 2;
        }
        if (headerEnd === -1) {
          if (buffer.length > 65536) {
            buffer = Buffer.alloc(0);
          }
          break;
        }
        const headerText = buffer.subarray(0, headerEnd).toString('utf8');
        const match = /(?:^|\r?\n)[ \t]*Content-Length[ \t]*:[ \t]*(\d+)/i.exec(headerText);
        if (!match) {
          buffer = buffer.subarray(headerEnd + sepLen);
          continue;
        }
        const bodyLen = Number(match[1]);
        const bodyStart = headerEnd + sepLen;
        if (buffer.length < bodyStart + bodyLen) break;
        const body = buffer.subarray(bodyStart, bodyStart + bodyLen).toString('utf8');
        buffer = buffer.subarray(bodyStart + bodyLen);
        enqueueMessage(body);
        continue;
      }

      const nlIdx = buffer.indexOf('\n');
      if (nlIdx === -1) break;
      const line = buffer.subarray(0, nlIdx).toString('utf8').replace(/\r$/, '').trim();
      buffer = buffer.subarray(nlIdx + 1);
      if (line) {
        enqueueMessage(line);
      }
    }
  };

  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    drainBuffer();
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Whole cleanup is bounded: a stuck RPC or browser must not keep the process (and its tabs) alive.
    const hardStop = setTimeout(() => process.exit(0), 4000);
    await Promise.race([rpcChain.catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
    await manager.close().catch(() => {});
    clearTimeout(hardStop);
    process.exit(0);
  };

  process.stdin.on('end', () => void shutdown());
  process.stdin.on('close', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

const VALUE_FLAG_ENV = {
  '--mode': 'TURBO_BROWSER_MODE',
  '--cdp': 'TURBO_BROWSER_CDP_URL',
  '--user-data-dir': 'TURBO_BROWSER_USER_DATA_DIR',
  '--executable': 'TURBO_BROWSER_EXECUTABLE',
  '--timeout': 'TURBO_BROWSER_TIMEOUT_MS',
  '--url': 'TURBO_BROWSER_OPEN_URL',
  '--tools': 'TURBO_BROWSER_TOOLS',
  '--allow-hosts': 'TURBO_BROWSER_ALLOW_HOSTS',
  '--allow-origins': 'TURBO_BROWSER_ALLOW_ORIGINS',
  '--secrets': 'TURBO_BROWSER_SECRETS_FILE',
};

const HELP_TEXT = `turbo-browser-mcp v${SERVER_INFO.version} — Fast, token-efficient Playwright MCP server

Usage:
  turbo-browser-mcp [options]

Options:
  -h, --help                 Show this help message
  -v, --version              Print version (${SERVER_INFO.version})
  --doctor                   Check Node, Playwright, Chromium, and CDP availability (JSON)
  --bridge                   Start/verify the persistent CDP Keep-Alive Bridge daemon (1 approval total; token required)
  --bridge-insecure          Like --bridge but WITHOUT a token: any local program can then use your approved Chrome session
  --launch-chrome            Launch Chrome with a dedicated profile & --remote-debugging-port=9222 (0 prompts)
  --open-profile [--url <u>] Open the same profile in a normal, non-automated Chrome so a human can log in or
                             pass a bot check first; the agent later reuses the cookies (waits until Chrome exits)
  --mode <auto|cdp|persistent|launch>  Browser connection mode (default: auto)
  --cdp <url>                CDP endpoint URL (default: http://127.0.0.1:9222)
  --user-data-dir <path>     Persistent browser profile directory
  --executable <path>        Override Chromium/Chrome/Edge binary path
  --timeout <ms>             Default timeout in ms (default: 15000)
  --tools <all|core>         core lists only tabs_batch, inspect_compact, smart_fill_form, act_fast,
                             batch_actions, extract_clean_text (default: all)
  --headless                 Run Chromium headless (default)
  --headed                   Show Chromium browser window
  --allow-submit             Allow Submit/Publish clicks without explicit allowSubmit=true
  --allow-hosts <a,b>        Only allow navigation to these hosts and their subdomains (TURBO_BROWSER_ALLOW_HOSTS)
  --allow-origins <o,o>      Only allow these exact origins, e.g. http://localhost:3000 (TURBO_BROWSER_ALLOW_ORIGINS)
  --allow-strict             With an allowlist, also block sub-resource requests to other hosts
  --secrets <file>           dotenv file of secrets; use $secret:NAME as a fill/type value, values are redacted from results (TURBO_BROWSER_SECRETS_FILE)
  --content-boundaries       Wrap page text in <<page:nonce>> markers (TURBO_BROWSER_CONTENT_BOUNDARIES=1)
  --print-skill              Print the bundled SKILL.md for this version and exit

Example MCP config:
  {
    "mcpServers": {
      "turbo-browser": {
        "command": "npx",
        "args": ["-y", "turbo-browser-mcp"]
      }
    }
  }
`;

export function parseCliArgs(argv = process.argv.slice(2)) {
  const out = {
    version: false,
    help: false,
    doctor: false,
    bridge: false,
    launchChrome: false,
    openProfile: false,
    envOverrides: {},
    unknown: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = String(argv[i]);
    const eqIdx = raw.indexOf('=');
    const flag = eqIdx !== -1 ? raw.slice(0, eqIdx) : raw;
    const inlineVal = eqIdx !== -1 ? raw.slice(eqIdx + 1) : null;

    if (flag === '--version' || flag === '-v') {
      out.version = true;
    } else if (flag === '--help' || flag === '-h') {
      out.help = true;
    } else if (flag === '--doctor') {
      out.doctor = true;
    } else if (flag === '--bridge') {
      out.bridge = true;
    } else if (flag === '--bridge-insecure') {
      out.bridge = true;
      out.bridgeInsecure = true;
    } else if (flag === '--launch-chrome') {
      out.launchChrome = true;
    } else if (flag === '--open-profile') {
      out.openProfile = true;
    } else if (flag === '--headless') {
      out.envOverrides.TURBO_BROWSER_HEADLESS = 'true';
    } else if (flag === '--headed') {
      out.envOverrides.TURBO_BROWSER_HEADLESS = 'false';
    } else if (flag === '--allow-strict') {
      out.envOverrides.TURBO_BROWSER_ALLOW_STRICT = '1';
    } else if (flag === '--content-boundaries') {
      out.envOverrides.TURBO_BROWSER_CONTENT_BOUNDARIES = '1';
    } else if (flag === '--print-skill') {
      out.printSkill = true;
    } else if (flag === '--allow-submit') {
      out.envOverrides.TURBO_BROWSER_ALLOW_SUBMIT = 'true';
    } else if (Object.prototype.hasOwnProperty.call(VALUE_FLAG_ENV, flag)) {
      const val = inlineVal !== null ? inlineVal : argv[++i];
      if (val === undefined) {
        out.unknown = `Missing value for ${flag}`;
        return out;
      }
      out.envOverrides[VALUE_FLAG_ENV[flag]] = String(val);
    } else {
      out.unknown = `Unknown option: ${raw}`;
      return out;
    }
  }
  return out;
}

async function runCli() {
  const parsed = parseCliArgs(process.argv.slice(2));
  Object.assign(process.env, parsed.envOverrides);

  if (parsed.unknown) {
    process.stderr.write(`${parsed.unknown}\nUse --help for usage.\n`);
    process.exit(2);
  }
  if (parsed.version) {
    process.stdout.write(`${SERVER_INFO.version}\n`);
    process.exit(0);
  }
  if (parsed.help) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }
  if (parsed.printSkill) {
    process.stdout.write(fs.readFileSync(SKILL_PATH, 'utf8'));
    process.exit(0);
  }
  if (process.env.TURBO_BROWSER_SECRETS_FILE) {
    try {
      getSecrets();
    } catch (err) {
      process.stderr.write(`${err.message}
`);
      process.exit(2);
    }
  }
  if (parsed.doctor) {
    const report = await diagnoseEnvironment(process.env.TURBO_BROWSER_CDP_URL || 'http://127.0.0.1:9222');
    process.stdout.write(`${JSON.stringify({ version: SERVER_INFO.version, ...report }, null, 2)}\n`);
    process.exit(report.playwrightLoaded ? 0 : 1);
  }
  if (parsed.launchChrome) {
    const pw = await loadPlaywright();
    const { executablePath } = resolveChromiumExecutable(pw.chromium, false);
    if (!executablePath) {
      process.stderr.write('No Chrome/Chromium executable found.\n');
      process.exit(1);
    }
    const endpoint = await launchUnattendedChrome({
      executablePath,
      userDataDir: process.env.TURBO_BROWSER_USER_DATA_DIR || undefined,
      headless: process.env.TURBO_BROWSER_HEADLESS === 'true',
    });
    process.stdout.write(
      `${JSON.stringify({ ok: true, mode: 'unattended-cdp', endpoint, executablePath }, null, 2)}\n`
    );
    process.exit(0);
  }
  if (parsed.openProfile) {
    const pw = await loadPlaywright();
    const { executablePath } = resolveChromiumExecutable(pw.chromium, false);
    if (!executablePath) {
      process.stderr.write('No Chrome/Chromium executable found.\n');
      process.exit(1);
    }
    const userDataDir =
      process.env.TURBO_BROWSER_USER_DATA_DIR || path.join(turboHome(), 'chrome-profile');
    fs.mkdirSync(userDataDir, { recursive: true });
    // Plain user launch: no --remote-debugging-port, no automation flags.
    const chromeArgs = [`--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check'];
    if (process.env.TURBO_BROWSER_OPEN_URL) chromeArgs.push(process.env.TURBO_BROWSER_OPEN_URL);
    process.stderr.write(
      `Opening a normal Chrome window with profile ${userDataDir}. Log in / pass the check, then close the window.\n`
    );
    const child = spawn(executablePath, chromeArgs, { stdio: 'ignore' });
    const code = await new Promise((resolve) => {
      child.on('exit', (c) => resolve(c ?? 0));
      child.on('error', () => resolve(1));
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: code === 0,
          userDataDir,
          next: `Start the server with --user-data-dir "${userDataDir}" (or --launch-chrome) to reuse this session.`,
          note: 'If Chrome was already running with this profile (for example one started by --launch-chrome, which has a debugging port), the window opened in that process and this command returned early. Close it first for a clean non-automated session.',
        },
        null,
        2
      )}\n`
    );
    process.exit(code === 0 ? 0 : 1);
  }
  if (parsed.bridge) {
    if (parsed.bridgeInsecure) process.env.TURBO_BROWSER_BRIDGE_INSECURE = 'true';
    const insecure = process.env.TURBO_BROWSER_BRIDGE_INSECURE === 'true';
    const existing = await getRunningBridgeInfo();
    if (existing && Boolean(existing.insecure) === insecure) {
      process.stdout.write(`${redactBridgeToken(JSON.stringify({ ok: true, reused: true, ...existing }, null, 2))}\n`);
      process.exit(0);
    }
    const prevDisable = process.env.TURBO_BROWSER_DISABLE_BRIDGE;
    process.env.TURBO_BROWSER_DISABLE_BRIDGE = 'true';
    const rawEndpoint = await resolveActiveCdpEndpoint(
      process.env.TURBO_BROWSER_CDP_URL || 'http://127.0.0.1:9222',
      process.env.TURBO_BROWSER_USER_DATA_DIR || ''
    );
    if (prevDisable === undefined) delete process.env.TURBO_BROWSER_DISABLE_BRIDGE;
    else process.env.TURBO_BROWSER_DISABLE_BRIDGE = prevDisable;

    if (!rawEndpoint || (!rawEndpoint.startsWith('ws://') && !rawEndpoint.startsWith('wss://'))) {
      process.stdout.write(
        `${JSON.stringify({ ok: Boolean(rawEndpoint), bridgeNeeded: false, endpoint: rawEndpoint }, null, 2)}\n`
      );
      process.exit(rawEndpoint ? 0 : 1);
    }
    const bridgeHttpUrl = await ensureCdpBridgeDaemon(rawEndpoint, { timeoutMs: 60000, insecure });
    const info = await getRunningBridgeInfo();
    process.stdout.write(
      `${redactBridgeToken(JSON.stringify({ ok: Boolean(bridgeHttpUrl), reused: false, ...(info || { bridgeHttpUrl }) }, null, 2))}\n`
    );
    process.exit(bridgeHttpUrl ? 0 : 1);
  }

  startStdioServer();
}

function isDirectEntry() {
  if (!process.argv[1]) return false;
  const resolveReal = (p) => {
    try {
      return fs.realpathSync(p).toLowerCase();
    } catch {
      return path.resolve(p).toLowerCase();
    }
  };
  return resolveReal(fileURLToPath(import.meta.url)) === resolveReal(process.argv[1]);
}

if (isDirectEntry()) {
  void runCli();
}
