#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserManager } from './browser-manager.mjs';
import {
  ensureCdpBridgeDaemon,
  getRunningBridgeInfo,
  launchUnattendedChrome,
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
  capturePage,
  evaluateJs,
  extractCleanText,
  inspectCompact,
  smartFillForm,
} from './dom-engine.mjs';

const SERVER_INFO = {
  name: 'turbo-browser-mcp',
  version: '0.4.0',
};

const SUPPORTED_PROTOCOL = '2025-03-26';
const SUPPORTED_PROTOCOLS = new Set(['2025-03-26', '2024-11-05', '2024-10-07']);

export const TOOL_DEFINITIONS = [
  {
    name: 'tabs_batch',
    description:
      'List, open (single or parallel open_many, with optional isolatedContext), navigate, activate, resize viewport, emulate media/colors/contrast/UA, reload, go back/forward, close tabs, or close browser in a single call.',
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
              activate: { type: 'boolean' },
              isolatedContext: {
                type: 'string',
                description: 'Optional isolated context name for open action (separate cookies/storage).',
              },
              width: { type: 'integer' },
              height: { type: 'integer' },
              colorScheme: {
                oneOf: [{ type: 'string', enum: ['light', 'dark', 'no-preference'] }, { type: 'null' }],
              },
              media: {
                oneOf: [{ type: 'string', enum: ['screen', 'print'] }, { type: 'null' }],
              },
              reducedMotion: {
                oneOf: [{ type: 'string', enum: ['reduce', 'no-preference'] }, { type: 'null' }],
              },
              forcedColors: {
                oneOf: [{ type: 'string', enum: ['active', 'none'] }, { type: 'null' }],
              },
              contrast: {
                oneOf: [{ type: 'string', enum: ['more', 'no-preference'] }, { type: 'null' }],
              },
              userAgent: {
                oneOf: [{ type: 'string' }, { type: 'null' }],
              },
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
      'Inspect visible interactive elements, forms, or readable sections across main frame, iframes, and open Shadow DOM. Supports query filter, onlyChanged delta mode, bounding boxes, and savePath, capped at maxChars.',
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
          description: 'Optional file path confined to cwd (or TURBO_BROWSER_SAVE_ROOT) to save snapshot text.',
        },
      },
    },
  },
  {
    name: 'smart_fill_form',
    description:
      'Fill React-controlled inputs, contenteditable editors, single/multi selects, range sliders, ARIA comboboxes, radios/checkboxes, open Shadow DOM fields, Gmail compose dialogs, iframe fields, and local disk file uploads in one batch. Stops before Submit by default.',
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
              keys: {
                oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
              },
              not: {
                oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
              },
              value: {
                oneOf: [
                  { type: 'string' },
                  { type: 'boolean' },
                  { type: 'number' },
                  { type: 'array', items: { type: 'string' } },
                ],
              },
              values: {
                type: 'array',
                items: { type: 'string' },
                description: 'Multiple option values/patterns for <select multiple>.',
              },
              option: {
                oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
              },
              check: {
                oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
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
      'Run a single DOM action (click, dblclick, hover, drag, drop files/data, fill, type, select single/multi, check, upload from disk, press, scroll, wait) targeting a compact ref, selector, text, or viewport coordinates (x, y). Supports mouse button/modifiers, 1-turn returnSnapshot=true, and blocks submit/publish/send actions unless allowSubmit=true.',
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
        text: { type: 'string' },
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
        value: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
        values: {
          type: 'array',
          items: { type: 'string' },
          description: 'Multiple option values/labels for select action.',
        },
        label: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
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
        url: { type: 'string', description: 'Wait until page URL matches pattern.' },
        loadState: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] },
        state: { type: 'string', enum: ['visible', 'hidden', 'attached', 'detached'] },
        timeoutMs: { type: 'integer' },
        allowSubmit: { type: 'boolean', default: false },
        returnSnapshot: { type: 'boolean', default: false },
        snapshotMode: { type: 'string', enum: ['interactive', 'forms', 'article', 'all'] },
        snapshotMaxChars: { type: 'integer', default: 2500 },
      },
    },
  },
  {
    name: 'batch_actions',
    description:
      'Execute an array of page actions and/or smart_fill_form steps sequentially in one MCP turn, stopping safely if blocked by the Submit guard, with optional post-batch compact snapshot.',
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
          items: { type: 'object' },
        },
        continueOnError: { type: 'boolean', default: false },
        allowSubmit: { type: 'boolean', default: false },
        returnSnapshot: { type: 'boolean', default: false },
        snapshotMode: { type: 'string', enum: ['interactive', 'forms', 'article', 'all'] },
        snapshotMaxChars: { type: 'integer', default: 2500 },
      },
    },
  },
  {
    name: 'extract_clean_text',
    description:
      'Extract clean readable plain text or compact markdown from main/article content (and iframes) without script/style noise, capped at maxChars, with optional savePath file export.',
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
          description: 'Optional file path confined to cwd (or TURBO_BROWSER_SAVE_ROOT) to save text output.',
        },
      },
    },
  },
  {
    name: 'evaluate_js',
    description:
      'Evaluate a JavaScript expression or function in a target frame or element (ref/selector/text, passing el and arg) and return JSON-serializable output, with optional savePath export.',
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
          description: 'Optional file path confined to cwd (or TURBO_BROWSER_SAVE_ROOT) to save result.',
        },
      },
    },
  },
  {
    name: 'page_diagnostics',
    description:
      'Read buffered console logs, network requests/failures (supporting includeStatic, urlFilter, and reqId/part detail inspection), completed downloads, and dialog logs/policy for a tab.',
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
          description: 'Optional JSON file path confined to cwd (or TURBO_BROWSER_SAVE_ROOT) to save diagnostics output.',
        },
        clear: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'capture_page',
    description:
      'Capture a full-page or element screenshot (png/jpeg, css/device scale) or export PDF confined to cwd (or TURBO_BROWSER_SAVE_ROOT), with optional inline image return.',
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
          description: 'Save storageState JSON to a path confined to cwd (or TURBO_BROWSER_SAVE_ROOT).',
        },
        loadStorageStatePath: {
          type: 'string',
          description: 'Load storageState JSON from a path confined to cwd (or TURBO_BROWSER_SAVE_ROOT).',
        },
        blockResources: { type: 'array', items: { type: 'string' } },
        blockUrls: { type: 'array', items: { type: 'string' } },
        unblockAll: { type: 'boolean', default: false },
      },
    },
  },
];

export async function dispatchToolCall(manager, name, rawArgs = {}) {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
  switch (name) {
    case 'tabs_batch': {
      const res = await manager.tabsBatch(args.operations || []);
      return { text: JSON.stringify(res) };
    }
    case 'inspect_compact': {
      const { tabId, page } = await manager.getPage(args.tabId);
      const res = await inspectCompact(page, args, manager.getSnapshotState(page));
      return {
        text: `tabId=${tabId} | chars=${res.charCount} | truncated=${res.truncated} | ms=${res.elapsedMs}${res.savePath ? ` | savePath=${res.savePath}` : ''}\n${res.text}`,
      };
    }
    case 'smart_fill_form': {
      const { tabId, page } = await manager.getPage(args.tabId);
      const res = await smartFillForm(page, args, manager.getSnapshotState(page));
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
          returnSnapshot: args.returnSnapshot,
          snapshotMode: args.snapshotMode,
          snapshotMaxChars: args.snapshotMaxChars,
        },
        manager.getSnapshotState(page)
      );
      return { text: JSON.stringify({ tabId, ...res }) };
    }
    case 'extract_clean_text': {
      const { tabId, page } = await manager.getPage(args.tabId);
      const res = await extractCleanText(page, args);
      return {
        text: `tabId=${tabId} | chars=${res.charCount} | truncated=${res.truncated}${res.savePath ? ` | savePath=${res.savePath}` : ''}\n${res.text}`,
      };
    }
    case 'evaluate_js': {
      const { tabId, page } = await manager.getPage(args.tabId);
      const res = await evaluateJs(page, args);
      const encoded = JSON.stringify({ tabId, ...res });
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
          result: { tools: TOOL_DEFINITIONS },
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
              content: [{ type: 'text', text: String(err?.message || err) }],
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

  const shutdown = async () => {
    await rpcChain.catch(() => {});
    await manager.close().catch(() => {});
    process.exit(0);
  };

  process.stdin.on('end', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

const VALUE_FLAG_ENV = {
  '--mode': 'TURBO_BROWSER_MODE',
  '--cdp': 'TURBO_BROWSER_CDP_URL',
  '--user-data-dir': 'TURBO_BROWSER_USER_DATA_DIR',
  '--executable': 'TURBO_BROWSER_EXECUTABLE',
  '--timeout': 'TURBO_BROWSER_TIMEOUT_MS',
};

const HELP_TEXT = `turbo-browser-mcp v${SERVER_INFO.version} — Fast, token-efficient Playwright MCP server

Usage:
  turbo-browser-mcp [options]

Options:
  -h, --help                 Show this help message
  -v, --version              Print version (${SERVER_INFO.version})
  --doctor                   Check Node, Playwright, Chromium, and CDP availability (JSON)
  --bridge                   Start/verify the persistent CDP Keep-Alive Bridge daemon (1 approval total)
  --launch-chrome            Launch Chrome with a dedicated profile & --remote-debugging-port=9222 (0 prompts)
  --mode <auto|cdp|persistent|launch>  Browser connection mode (default: auto)
  --cdp <url>                CDP endpoint URL (default: http://127.0.0.1:9222)
  --user-data-dir <path>     Persistent browser profile directory
  --executable <path>        Override Chromium/Chrome/Edge binary path
  --timeout <ms>             Default timeout in ms (default: 15000)
  --headless                 Run Chromium headless (default)
  --headed                   Show Chromium browser window
  --allow-submit             Allow Submit/Publish clicks without explicit allowSubmit=true

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
    } else if (flag === '--launch-chrome') {
      out.launchChrome = true;
    } else if (flag === '--headless') {
      out.envOverrides.TURBO_BROWSER_HEADLESS = 'true';
    } else if (flag === '--headed') {
      out.envOverrides.TURBO_BROWSER_HEADLESS = 'false';
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
  if (parsed.bridge) {
    const existing = await getRunningBridgeInfo();
    if (existing) {
      process.stdout.write(`${JSON.stringify({ ok: true, reused: true, ...existing }, null, 2)}\n`);
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
    const bridgeHttpUrl = await ensureCdpBridgeDaemon(rawEndpoint, { timeoutMs: 60000 });
    const info = await getRunningBridgeInfo();
    process.stdout.write(
      `${JSON.stringify({ ok: Boolean(bridgeHttpUrl), reused: false, ...(info || { bridgeHttpUrl }) }, null, 2)}\n`
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
