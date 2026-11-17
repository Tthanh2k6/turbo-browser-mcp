import crypto from 'node:crypto';
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { turboHome } from './home.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const DEFAULT_BRIDGE_PORT = Number(process.env.TURBO_BROWSER_BRIDGE_PORT) || 9224;

// ---------- bridge authentication ----------
// The bridge holds a Chrome connection the owner already approved, so every request needs a random per-start token.
// The token lives in a state file under the user's profile (mode 0600; on Windows it inherits the profile's ACL) and
// turbo clients read it from there. Host and Origin are checked as well, so a web page cannot reach the bridge.
export function bridgeStatePath(port) {
  return path.join(turboHome(), `bridge-${Number(port)}.json`);
}
export function readBridgeToken(port) {
  try {
    return String(JSON.parse(fs.readFileSync(bridgeStatePath(port), 'utf8')).token || '');
  } catch {
    return '';
  }
}
function writeBridgeToken(port, token) {
  const file = bridgeStatePath(port);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ token, pid: process.pid, created: new Date().toISOString() }), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* not supported on this platform */ }
}
/** Add the stored token to a local http(s) bridge url that has none. Other urls pass through unchanged. */
export function bridgeUrlWithToken(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || u.searchParams.has('token') || !['127.0.0.1', 'localhost'].includes(u.hostname)) return url;
    const token = readBridgeToken(Number(u.port));
    if (!token) return url;
    u.searchParams.set('token', token);
    return u.href;
  } catch {
    return url;
  }
}
/** Never print a token: for logs and CLI output. */
export function redactBridgeToken(text) {
  return String(text).replace(/([?&]token=)[^&"\s]+/g, '$1***');
}
const safeEq = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(String(hostHeader).trim());
  return Boolean(m) && ['localhost', '127.0.0.1', '[::1]'].includes(m[1].toLowerCase());
}
// A web page origin is refused; no Origin header (a program) or an extension/DevTools origin is fine.
function originAllowed(origin) {
  return origin === undefined || /^(chrome-extension|devtools):\/\//i.test(String(origin));
}
function requestToken(req) {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^bearer /i.test(auth)) return auth.slice(7).trim();
  const hdr = req.headers['x-turbo-bridge-token'];
  if (typeof hdr === 'string') return hdr;
  try { return new URL(req.url || '/', 'http://localhost').searchParams.get('token') || ''; } catch { return ''; }
}

/**
 * Encode a UTF-8 string or Buffer into an RFC 6455 WebSocket frame.
 * Set `mask = true` for client-to-server frames, `false` for server-to-client frames.
 */
function encodeWsFrame(payload, opcode = 0x01, mask = false) {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const len = data.length;
  const maskBit = mask ? 0x80 : 0x00;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = maskBit | len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = maskBit | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  if (!mask) {
    return Buffer.concat([header, data]);
  }
  const maskKey = crypto.randomBytes(4);
  const maskedData = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) {
    maskedData[i] = data[i] ^ maskKey[i & 3];
  }
  return Buffer.concat([header, maskKey, maskedData]);
}

/**
 * Minimal RFC 6455 WebSocket connection wrapper for upgraded HTTP sockets.
 */
class ServerWsClient {
  constructor(socket, { maskOutgoing = false, initialChunk = null } = {}) {
    this.socket = socket;
    this.maskOutgoing = maskOutgoing;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.closed = false;
    this.onMessage = null;
    this.onClose = null;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._handleClose());
    socket.on('end', () => this._handleClose());
    socket.on('error', () => this._handleClose());
    if (initialChunk && initialChunk.length > 0) {
      this._onData(initialChunk);
    }
  }

  _onData(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        payloadLen = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      const totalFrameLen = offset + maskLen + payloadLen;
      if (this.buffer.length < totalFrameLen) return;

      const payload = Buffer.from(this.buffer.subarray(offset + maskLen, totalFrameLen));
      if (masked) {
        const maskKey = this.buffer.subarray(offset, offset + 4);
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i & 3];
        }
      }
      this.buffer = this.buffer.subarray(totalFrameLen);

      if (opcode === 0x08) {
        // Close frame
        this.close();
        return;
      }
      if (opcode === 0x09) {
        // Ping -> Pong
        if (!this.closed) {
          this.socket.write(encodeWsFrame(payload, 0x0a, this.maskOutgoing));
        }
        continue;
      }
      if (opcode === 0x0a) {
        continue;
      }

      if (opcode === 0x01 || opcode === 0x02) {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
      } else if (opcode === 0x00) {
        this.fragments.push(payload);
      }

      if (fin && (this.fragmentOpcode === 0x01 || this.fragmentOpcode === 0x02)) {
        const full = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
        this.fragments = [];
        this.fragmentOpcode = 0;
        if (this.onMessage) {
          this.onMessage(full.toString('utf8'));
        }
      }
    }
  }

  send(text) {
    if (this.closed || !this.socket.writable) return;
    try {
      this.socket.write(encodeWsFrame(text, 0x01, this.maskOutgoing));
    } catch {
      this._handleClose();
    }
  }

  close(code = 0, reason = '') {
    if (this.closed) return;
    this.closed = true;
    try {
      let body = Buffer.alloc(0);
      if (code) {
        body = Buffer.concat([Buffer.from([(code >> 8) & 0xff, code & 0xff]), Buffer.from(String(reason).slice(0, 100), 'utf8')]);
      }
      this.socket.end(encodeWsFrame(body, 0x08, this.maskOutgoing));
    } catch {
      this.socket.destroy();
    }
    this._handleClose();
  }

  _handleClose() {
    if (this.closed && !this.onClose) return;
    this.closed = true;
    const cb = this.onClose;
    this.onClose = null;
    if (cb) cb();
  }
}

/**
 * Start a persistent CDP Keep-Alive Multiplexer Bridge server.
 * Holds a single upstream WebSocket connection to Chrome's `DevToolsActivePort`
 * so Chrome only prompts "Allow remote debugging?" ONCE, while allowing unlimited
 * sequential or concurrent Playwright / MCP connections without re-prompting.
 */
export async function createCdpBridgeServer({
  upstreamUrl,
  port = DEFAULT_BRIDGE_PORT,
  host = '127.0.0.1',
  connectTimeoutMs = 60000,
  // Called once when the upstream is gone for good (after the optional reconnect). The daemon exits from it.
  onUpstreamLost = null,
  // Library use keeps a bridge with a dead upstream alive (probeBridge reports upstreamConnected:false); the daemon sets this.
  reconnectMs = 0,
  log = null,
  // Called when the bridge's own listening socket errors or closes unexpectedly (not via /shutdown).
  onServerLost = null,
  // Required by default; a random token is generated when none is given. insecure:true is the explicit opt-out.
  token = null,
  insecure = false,
} = {}) {
  const authToken = insecure ? '' : (token || crypto.randomBytes(24).toString('hex'));
  const tokenSuffix = authToken ? `?token=${encodeURIComponent(authToken)}` : '';
  // Returns [status, reason] for a request that must be refused, else null.
  const refuse = (req) => {
    if (!hostAllowed(req.headers.host)) return [403, 'host not allowed'];
    if (!originAllowed(req.headers.origin)) return [403, 'origin not allowed'];
    if (authToken && !safeEq(requestToken(req), authToken)) return [401, 'token required'];
    return null;
  };
  if (!upstreamUrl || (!upstreamUrl.startsWith('ws://') && !upstreamUrl.startsWith('wss://'))) {
    throw new Error(`createCdpBridgeServer requires a ws:// or wss:// upstreamUrl (got ${upstreamUrl})`);
  }

  let upstreamWs = null;
  let upstreamConnected = false;
  let browserVersionInfo = {
    Browser: 'Chrome/TurboBridge',
    'Protocol-Version': '1.3',
    'User-Agent': 'Mozilla/5.0 Chrome/TurboBridge',
  };

  let nextUpstreamId = 100000;
  const pendingCalls = new Map(); // upstreamId -> { client, clientMsgId, internalResolve }
  const clients = new Set(); // Set<ServerWsClient>
  const discoveredTargets = new Map(); // targetId -> targetInfo
  // Every client gets its own CDP sessions. Sessions are not shared: two Playwright clients on one
  // session fight over one-time setup (Page.setFontFamilies) and miss each other's
  // Runtime.executionContextCreated. The bridge keeps ONE upstream connection (so Chrome's
  // "Allow remote debugging" prompt appears once) and attaches a separate flat session per client.
  const owners = new Map(); // upstream sessionId -> { client, targetId, root }
  const bridgeAttached = new Map(); // bridge-owned session (S0) -> Target.attachedToTarget params
  const resumes = new Map(); // S0 sessionId -> { waiting: Set<client>, timer }
  let upstreamAutoAttach = null; // promise once enabled
  let upstreamDiscover = null;
  const RESUME_FALLBACK_MS = 10000;

  function sendUpstreamRaw(obj) {
    if (!upstreamWs || upstreamWs.closed) return false;
    upstreamWs.send(JSON.stringify(obj));
    return true;
  }

  function callUpstreamInternal(method, params = {}, sessionId) {
    return new Promise((resolve) => {
      if (!upstreamWs || upstreamWs.closed) {
        resolve(null);
        return;
      }
      const id = nextUpstreamId++;
      pendingCalls.set(id, { client: null, clientMsgId: null, internalResolve: resolve });
      sendUpstreamRaw({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    });
  }

  function resumeBridgeSession(s0) {
    const rec = resumes.get(s0);
    if (!rec) return;
    clearTimeout(rec.timer);
    resumes.delete(s0);
    void callUpstreamInternal('Runtime.runIfWaitingForDebugger', {}, s0);
  }

  function clientResumed(client, s0) {
    const rec = resumes.get(s0);
    if (!rec) return;
    rec.waiting.delete(client);
    if (rec.waiting.size === 0) resumeBridgeSession(s0);
  }

  // Attach one new upstream session for this client to a target the bridge already tracks, then announce it.
  async function attachForClient(client, params, waiting) {
    const targetId = params.targetInfo?.targetId;
    if (client.attachedTargetIds.has(targetId)) return;
    client.attachedTargetIds.add(targetId);
    const res = await callUpstreamInternal('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = res?.sessionId;
    if (!sessionId) {
      client.attachedTargetIds.delete(targetId);
      return;
    }
    if (client.closed) {
      void callUpstreamInternal('Target.detachFromTarget', { sessionId });
      return;
    }
    owners.set(sessionId, { client, targetId, root: true });
    client.sessions.add(sessionId);
    if (waiting) resumes.get(params.sessionId)?.waiting.add(client);
    client.send(
      JSON.stringify({
        method: 'Target.attachedToTarget',
        params: { sessionId, targetInfo: params.targetInfo, waitingForDebugger: Boolean(waiting) },
      })
    );
  }

  // A target the bridge just auto-attached to: give every autoAttach client its own session.
  function handleNewTarget(params) {
    const s0 = params.sessionId;
    bridgeAttached.set(s0, params);
    const waiting = Boolean(params.waitingForDebugger);
    const targets = [...clients].filter((c) => c.autoAttach && !c.closed);
    if (waiting) resumes.set(s0, { waiting: new Set(), timer: setTimeout(() => resumeBridgeSession(s0), RESUME_FALLBACK_MS) });
    const tasks = targets.map((c) => {
      const t = attachForClient(c, params, waiting && c.waitDbg);
      c.tasks.add(t);
      void t.then(() => c.tasks.delete(t), () => c.tasks.delete(t));
      return t;
    });
    Promise.all(tasks)
      .catch(() => {})
      .then(() => {
        if (waiting && resumes.get(s0)?.waiting.size === 0) resumeBridgeSession(s0);
      });
  }

  // Browser contexts a client created through the bridge die with that client, unless another client
  // already works inside them (then that client inherits them). The default context is never touched.
  function contextInUseByOther(client, ctxId) {
    for (const other of clients) {
      if (other === client || other.closed) continue;
      for (const tid of other.attachedTargetIds) {
        const info = discoveredTargets.get(tid) || [...bridgeAttached.values()].find((p) => p.targetInfo?.targetId === tid)?.targetInfo;
        if (info?.browserContextId === ctxId) return other;
      }
    }
    return null;
  }

  function disposeClientContexts(client) {
    for (const ctxId of [...client.createdContexts]) {
      client.createdContexts.delete(ctxId);
      const heir = contextInUseByOther(client, ctxId);
      if (heir) heir.createdContexts.add(ctxId);
      else void callUpstreamInternal('Target.disposeBrowserContext', { browserContextId: ctxId });
    }
  }

  function releaseClient(client) {
    disposeClientContexts(client);
    for (const sid of client.sessions) {
      owners.delete(sid);
      void callUpstreamInternal('Target.detachFromTarget', { sessionId: sid });
    }
    client.sessions.clear();
    for (const s0 of [...resumes.keys()]) clientResumed(client, s0);
    for (const [sid, o] of owners) if (o.client === client) owners.delete(sid);
  }

  async function connectUpstream() {
    return new Promise((resolve, reject) => {
      const parsed = new URL(upstreamUrl);
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        hostname: parsed.hostname || '127.0.0.1',
        port: Number(parsed.port) || 9222,
        path: `${parsed.pathname || '/'}${parsed.search || ''}`,
        method: 'GET',
        headers: {
          Host: parsed.host,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
        },
      });

      const timer = setTimeout(() => {
        try {
          req.destroy();
        } catch {}
        reject(new Error(`Timed out connecting to upstream CDP WebSocket: ${upstreamUrl}`));
      }, connectTimeoutMs);

      req.on('upgrade', async (res, socket, head) => {
        clearTimeout(timer);
        const ws = new ServerWsClient(socket, { maskOutgoing: true, initialChunk: head });
        upstreamWs = ws;
        upstreamConnected = true;

        ws.onMessage = (rawText) => {
          let msg;
          try {
            msg = JSON.parse(rawText);
          } catch {
            return;
          }

          if (msg.id !== undefined) {
            const pending = pendingCalls.get(msg.id);
            if (pending) {
              pendingCalls.delete(msg.id);
              if (pending.internalResolve) {
                pending.internalResolve(msg.result ?? null);
                return;
              }
              if (pending.method === 'Target.createBrowserContext' && msg.result?.browserContextId) {
                if (pending.client && !pending.client.closed) pending.client.createdContexts.add(msg.result.browserContextId);
                else if (pending.client) void callUpstreamInternal('Target.disposeBrowserContext', { browserContextId: msg.result.browserContextId });
              } else if (pending.method === 'Target.disposeBrowserContext' && !msg.error && pending.contextId) {
                pending.client?.createdContexts.delete(pending.contextId);
              }
              if (pending.client && !pending.client.closed) {
                if ((pending.method === 'Target.attachToTarget' || pending.method === 'Target.attachToBrowserTarget') && msg.result?.sessionId) {
                  owners.set(msg.result.sessionId, { client: pending.client, targetId: pending.targetId, root: false });
                  pending.client.sessions.add(msg.result.sessionId);
                } else if (pending.method === 'Target.detachFromTarget' && pending.detachSessionId) {
                  owners.delete(pending.detachSessionId);
                  pending.client.sessions.delete(pending.detachSessionId);
                }
                const out = JSON.stringify({ ...msg, id: pending.clientMsgId });
                if (pending.method === 'Target.createTarget' && pending.client.tasks.size > 0) {
                  // Chrome announces the new target (attachedToTarget) before this reply; keep that order.
                  const c = pending.client;
                  void Promise.all([...c.tasks]).catch(() => {}).then(() => { if (!c.closed) c.send(out); });
                } else {
                  pending.client.send(out);
                }
              }
            }
            return;
          }

          if (msg.sessionId) {
            // Session event: only the client that owns the session sees it.
            const owner = owners.get(msg.sessionId);
            if (!owner || owner.client.closed) return;
            if (msg.method === 'Target.attachedToTarget' && msg.params?.sessionId) {
              owners.set(msg.params.sessionId, { client: owner.client, targetId: msg.params.targetInfo?.targetId, root: false });
              owner.client.sessions.add(msg.params.sessionId);
            } else if (msg.method === 'Target.detachedFromTarget' && msg.params?.sessionId) {
              owners.delete(msg.params.sessionId);
              owner.client.sessions.delete(msg.params.sessionId);
            }
            owner.client.send(rawText);
            return;
          }

          if (!msg.method) return;
          // Browser-level events.
          if (msg.method === 'Target.attachedToTarget' && msg.params?.sessionId) {
            handleNewTarget(msg.params);
            return;
          }
          if (msg.method === 'Target.detachedFromTarget' && msg.params?.sessionId) {
            const sid = msg.params.sessionId;
            bridgeAttached.delete(sid);
            const resume = resumes.get(sid);
            if (resume) {
              clearTimeout(resume.timer);
              resumes.delete(sid);
            }
            const owner = owners.get(sid);
            if (owner) {
              owners.delete(sid);
              owner.client.sessions.delete(sid);
              if (!owner.client.closed) owner.client.send(rawText);
            }
            return;
          }
          let discoverEvent = false;
          if (msg.method === 'Target.targetCreated' && msg.params?.targetInfo?.targetId) {
            discoveredTargets.set(msg.params.targetInfo.targetId, msg.params.targetInfo);
            discoverEvent = true;
          } else if (msg.method === 'Target.targetDestroyed' && msg.params?.targetId) {
            discoveredTargets.delete(msg.params.targetId);
            discoverEvent = true;
          } else if (msg.method === 'Target.targetInfoChanged' && msg.params?.targetInfo?.targetId) {
            const tInfo = msg.params.targetInfo;
            discoveredTargets.set(tInfo.targetId, tInfo);
            for (const [sid, entry] of bridgeAttached.entries()) {
              if (entry.targetInfo?.targetId === tInfo.targetId) bridgeAttached.set(sid, { ...entry, targetInfo: tInfo });
            }
            discoverEvent = true;
          }
          for (const c of clients) {
            if (c.closed) continue;
            if (discoverEvent ? c.discover : true) c.send(rawText);
          }
        };

        ws.onClose = () => {
          if (upstreamWs !== ws) return;
          upstreamConnected = false;
          upstreamWs = null;
          // Everything tied to the dead connection is void: tell clients why, and fail any waiting internal calls.
          for (const c of clients) {
            c.close(1011, 'turbo-bridge: upstream Chrome closed the remote-debugging connection');
          }
          clients.clear();
          for (const [id, p] of pendingCalls) {
            pendingCalls.delete(id);
            p.internalResolve?.(null);
          }
          owners.clear();
          bridgeAttached.clear();
          discoveredTargets.clear();
          for (const r of resumes.values()) clearTimeout(r.timer);
          resumes.clear();
          upstreamAutoAttach = null;
          upstreamDiscover = null;
          if (!shuttingDown) void handleUpstreamLost();
        };

        try {
          const ver = await callUpstreamInternal('Browser.getVersion', {});
          if (ver && ver.product) {
            browserVersionInfo = {
              Browser: ver.product,
              'Protocol-Version': ver.protocolVersion || '1.3',
              'User-Agent': ver.userAgent || browserVersionInfo['User-Agent'],
              'V8-Version': ver.jsVersion || '',
              'WebKit-Version': ver.revision || '',
            };
          }
        } catch {}
        resolve(ws);
      });

      req.on('response', (res) => {
        clearTimeout(timer);
        reject(new Error(`Upstream CDP rejected WebSocket upgrade with HTTP ${res.statusCode}`));
      });

      req.on('error', (err) => {
        if (!upstreamConnected) {
          clearTimeout(timer);
          reject(new Error(`Upstream CDP WebSocket error on ${upstreamUrl}: ${err?.message || 'connection failed'}`));
        }
      });

      req.end();
    });
  }

  let shuttingDown = false;
  let lostHandled = false;

  // Reconnect only where no approval is involved: a classic --remote-debugging-port answers /json/version and reports
  // the same browser websocket URL. Chrome 144+ inspect mode (no /json/version) would show a fresh "Allow" prompt, so never retry there.
  async function upstreamStillSameBrowser() {
    try {
      const u = new URL(upstreamUrl);
      const res = await fetch(`http://${u.hostname}:${u.port}/json/version`, { signal: AbortSignal.timeout(800) });
      if (!res.ok) return false;
      const data = await res.json();
      return data && data.webSocketDebuggerUrl === upstreamUrl;
    } catch {
      return false;
    }
  }

  async function handleUpstreamLost() {
    if (lostHandled || shuttingDown) return;
    lostHandled = true;
    const deadline = Date.now() + reconnectMs;
    while (Date.now() < deadline && !shuttingDown) {
      if (await upstreamStillSameBrowser()) {
        try {
          await connectUpstream();
          lostHandled = false;
          log?.('upstream reconnected');
          return;
        } catch {
          // keep trying until the deadline
        }
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (shuttingDown) return;
    log?.(`upstream ${upstreamUrl} closed and could not be re-established`);
    try { await onUpstreamLost?.(); } catch {}
  }

  await connectUpstream();

  const server = http.createServer((req, res) => {
    const addr = server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : port;
    const wsEndpoint = `ws://${host}:${actualPort}/devtools/browser/turbo-bridge${tokenSuffix}`;
    const denied = refuse(req);
    if (denied) {
      res.writeHead(denied[0], { 'Content-Type': 'text/plain' });
      res.end(denied[1]);
      return;
    }

    if (req.url?.startsWith('/json/version')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ...browserVersionInfo,
          webSocketDebuggerUrl: wsEndpoint,
          turboBridge: true,
          tokenRequired: Boolean(authToken),
          upstreamUrl,
          upstreamConnected,
        })
      );
      return;
    }

    if (req.url === '/json' || req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([...discoveredTargets.values()]));
      return;
    }

    if (req.url === '/shutdown' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      shuttingDown = true;
      setTimeout(() => {
        for (const c of clients) c.close(1001, 'turbo-bridge: shutting down');
        clients.clear();
        try { upstreamWs?.close(); } catch {}
        server.close();
        server.closeAllConnections?.();
      }, 20);
      return;
    }

    if (req.url === '/healthz') {
      res.writeHead(upstreamConnected ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: upstreamConnected, upstreamUrl, activeClients: clients.size }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  // Upgraded sockets are no longer tracked by the http server: keep them so close() can end them.
  const upgradedSockets = new Set();
  server.on('upgrade', (req, socket) => {
    upgradedSockets.add(socket);
    socket.once('close', () => upgradedSockets.delete(socket));
    const denied = refuse(req);
    if (denied) {
      socket.on('error', () => {});
      socket.end(['HTTP/1.1 ' + denied[0] + ' ' + (denied[0] === 401 ? 'Unauthorized' : 'Forbidden'), 'Connection: close', '', ''].join('\r\n'), () => socket.destroy());
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key || !upstreamConnected) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n',
      ].join('\r\n')
    );

    const client = new ServerWsClient(socket);
    client.autoAttach = false;
    client.waitDbg = false;
    client.discover = false;
    client.sessions = new Set();
    client.tasks = new Set();
    client.attachedTargetIds = new Set();
    client.createdContexts = new Set();
    clients.add(client);

    const reply = (id, result, sessionId) =>
      client.send(JSON.stringify({ id, ...(sessionId ? { sessionId } : {}), result: result ?? {} }));

    client.onMessage = async (rawMsg) => {
      let parsed;
      try {
        parsed = JSON.parse(rawMsg);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;

      const clientMsgId = parsed.id;
      if (!parsed.sessionId && parsed.method === 'Browser.close') {
        reply(clientMsgId, {});
        client.close();
        return;
      }

      if (!parsed.sessionId && parsed.method === 'Target.setAutoAttach') {
        // Handled here: the bridge attaches a separate session for this client (see attachForClient).
        if (parsed.params?.autoAttach === true) {
          client.autoAttach = true;
          client.waitDbg = Boolean(parsed.params?.waitForDebuggerOnStart);
          if (!upstreamAutoAttach) {
            upstreamAutoAttach = callUpstreamInternal('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
          }
          await upstreamAutoAttach;
          for (const p of [...bridgeAttached.values()]) {
            const t = attachForClient(client, p, false);
            client.tasks.add(t);
            void t.then(() => client.tasks.delete(t), () => client.tasks.delete(t));
          }
          await Promise.all([...client.tasks]).catch(() => {});
        } else {
          client.autoAttach = false;
        }
        reply(clientMsgId, {});
        return;
      }
      if (!parsed.sessionId && parsed.method === 'Target.setDiscoverTargets') {
        if (parsed.params?.discover === true) {
          client.discover = true;
          if (!upstreamDiscover) upstreamDiscover = callUpstreamInternal('Target.setDiscoverTargets', { discover: true });
          await upstreamDiscover;
          for (const targetInfo of discoveredTargets.values()) {
            client.send(JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo } }));
          }
        } else {
          client.discover = false;
        }
        reply(clientMsgId, {});
        return;
      }

      if (parsed.sessionId) {
        const owner = owners.get(parsed.sessionId);
        if (!owner || owner.client !== client) {
          client.send(
            JSON.stringify({ id: clientMsgId, sessionId: parsed.sessionId, error: { code: -32001, message: 'Session with given id not found.' } })
          );
          return;
        }
        if (owner.root && parsed.method === 'Runtime.runIfWaitingForDebugger') {
          // The target is held by the bridge's own session until every client has said it is ready.
          for (const [s0, p] of bridgeAttached) {
            if (p.targetInfo?.targetId === owner.targetId) clientResumed(client, s0);
          }
          reply(clientMsgId, {}, parsed.sessionId);
          return;
        }
      }

      const upstreamId = nextUpstreamId++;
      pendingCalls.set(upstreamId, {
        client,
        clientMsgId,
        internalResolve: null,
        method: parsed.method,
        targetId: parsed.params?.targetId,
        contextId: parsed.method === 'Target.disposeBrowserContext' ? parsed.params?.browserContextId : undefined,
        detachSessionId: parsed.method === 'Target.detachFromTarget' ? parsed.params?.sessionId : undefined,
      });
      sendUpstreamRaw({ ...parsed, id: upstreamId });
    };

    client.onClose = () => {
      clients.delete(client);
      releaseClient(client);
      // With no clients left, drop the bridge's own attachments so Chrome stops instrumenting tabs.
      if (clients.size === 0 && upstreamConnected) {
        for (const s0 of [...resumes.keys()]) resumeBridgeSession(s0);
        upstreamAutoAttach = null;
        upstreamDiscover = null;
        for (const s0 of bridgeAttached.keys()) void callUpstreamInternal('Target.detachFromTarget', { sessionId: s0 });
        bridgeAttached.clear();
        discoveredTargets.clear();
        callUpstreamInternal('Target.setAutoAttach', {
          autoAttach: false,
          waitForDebuggerOnStart: false,
          flatten: true,
        }).catch(() => {});
        callUpstreamInternal('Target.setDiscoverTargets', {
          discover: false,
        }).catch(() => {});
      }
    };
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  let serverLostFired = false;
  const serverLost = (why) => {
    if (shuttingDown || serverLostFired) return;
    serverLostFired = true;
    log?.(`bridge server socket lost (${why})`);
    for (const c of clients) c.close(1011, 'turbo-bridge: bridge server failed');
    clients.clear();
    try { upstreamWs?.close(); } catch {}
    try { onServerLost?.(why); } catch {}
  };
  server.on('error', (err) => serverLost(err?.message || 'error'));
  server.on('close', () => serverLost('closed'));
  if (onServerLost) {
    // A listening socket that vanished without an event (observed once on Windows) must not leave a zombie daemon.
    setInterval(() => { if (!server.listening) serverLost('not listening'); }, 3000).unref();
  }

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  if (authToken) writeBridgeToken(actualPort, authToken);
  // With a token the url carries it as ?token=: Playwright keeps the query when it asks /json/version.
  const bridgeHttpUrl = `http://${host}:${actualPort}${authToken ? tokenSuffix.replace('?', '/?') : ''}`;
  const bridgeWsUrl = `ws://${host}:${actualPort}/devtools/browser/turbo-bridge${tokenSuffix}`;

  return {
    server,
    port: actualPort,
    bridgeHttpUrl,
    bridgeWsUrl,
    token: authToken,
    close: async () => {
      shuttingDown = true;
      for (const c of clients) c.close(1001, 'turbo-bridge: shutting down');
      clients.clear();
      try {
        upstreamWs?.close();
      } catch {}
      const closed = new Promise((r) => server.close(() => r()));
      server.closeAllConnections?.();
      for (const sock of upgradedSockets) sock.destroy();
      await closed;
    },
  };
}

/**
 * Check if a persistent CDP Bridge is already running and connected to the given upstreamUrl.
 */
function bridgeFetch(bridgePort, host, route, init = {}) {
  const token = readBridgeToken(bridgePort);
  return fetch(`http://${host}:${bridgePort}${route}`, {
    ...init,
    headers: { ...(token ? { 'x-turbo-bridge-token': token } : {}), ...(init.headers || {}) },
    signal: init.signal || AbortSignal.timeout(600),
  });
}

export async function getRunningBridgeInfo(bridgePort = DEFAULT_BRIDGE_PORT, host = '127.0.0.1') {
  try {
    const res = await bridgeFetch(bridgePort, host, '/json/version');
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.turboBridge && data.upstreamConnected) {
      return {
        bridgeHttpUrl: bridgeUrlWithToken(`http://${host}:${bridgePort}`),
        insecure: !data.tokenRequired,
        bridgeWsUrl: data.webSocketDebuggerUrl,
        upstreamUrl: data.upstreamUrl,
      };
    }
  } catch {
    // Bridge not running
  }
  return null;
}

/** Like getRunningBridgeInfo, but also reports a bridge whose upstream is gone (upstreamConnected false). */
export async function probeBridge(bridgePort = DEFAULT_BRIDGE_PORT, host = '127.0.0.1') {
  try {
    const res = await bridgeFetch(bridgePort, host, '/json/version');
    // A bridge that refuses our token (state file gone or replaced) is unusable: report it so it gets replaced.
    if (res.status === 401) return { bridgeHttpUrl: `http://${host}:${bridgePort}`, upstreamUrl: '', upstreamConnected: false, unauthorized: true };
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.turboBridge) {
      return { bridgeHttpUrl: bridgeUrlWithToken(`http://${host}:${bridgePort}`), upstreamUrl: data.upstreamUrl, upstreamConnected: Boolean(data.upstreamConnected), insecure: !data.tokenRequired };
    }
  } catch {
    // nothing listening
  }
  return null;
}

/** Ask a running bridge to exit (POST /shutdown) and wait until its port is free. False for daemons too old to know it. */
export async function stopBridge(bridgePort = DEFAULT_BRIDGE_PORT, host = '127.0.0.1', waitMs = 2500) {
  try {
    await bridgeFetch(bridgePort, host, '/shutdown', { method: 'POST', signal: AbortSignal.timeout(800) });
  } catch {
    // fall through to the liveness check
  }
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    if (!(await probeBridge(bridgePort, host))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * A bridge from older code has no /shutdown route. Stop it only when the process that listens on the port
 * provably is our daemon (command line has cdp-bridge.mjs, --daemon and --port <port>). Returns true when it is gone.
 */
export async function killVerifiedStaleBridge(bridgePort = DEFAULT_BRIDGE_PORT, host = '127.0.0.1') {
  let pid = 0, cmd = '';
  try {
    if (process.platform === 'win32') {
      const ps = `$c = Get-NetTCPConnection -LocalPort ${Number(bridgePort)} -ErrorAction Stop | Where-Object { $_.RemotePort -eq 0 } | Select-Object -First 1; ` +
        '$p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"; "$($p.ProcessId)|$($p.CommandLine)"';
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      [pid, cmd] = [Number(out.split('|')[0]), out.slice(out.indexOf('|') + 1)];
    } else {
      pid = Number(execFileSync('lsof', ['-ti', `tcp:${Number(bridgePort)}`, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).split(/\s+/)[0]);
      cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
    }
  } catch {
    return false;
  }
  if (!pid || pid === process.pid || !/cdp-bridge\.mjs/.test(cmd) || !/--daemon\b/.test(cmd) || !new RegExp('--port\\s+' + Number(bridgePort) + '\\b').test(cmd)) return false;
  try { process.kill(pid); } catch { return false; }
  const start = Date.now();
  while (Date.now() - start < 2500) {
    if (!(await probeBridge(bridgePort, host))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function tcpOpen(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/**
 * Quick (about 1 s worst case) classification of whatever sits on the bridge port:
 * absent (nothing listening), ok, dead-upstream (bridge answers but Chrome is gone) or hung (port open, no valid answer).
 * A dead or hung bridge is stopped; a hung one only when it provably is our own daemon (killVerifiedStaleBridge).
 */
export async function checkBridgeHealth(bridgePort = DEFAULT_BRIDGE_PORT, host = '127.0.0.1') {
  const info = await probeBridge(bridgePort, host);
  if (info) {
    if (info.upstreamConnected) return { state: 'ok', ...info };
    let stopped = await stopBridge(bridgePort, host, 1500);
    if (!stopped) stopped = await killVerifiedStaleBridge(bridgePort, host);
    return { state: 'dead-upstream', stopped };
  }
  if (await tcpOpen(host, bridgePort)) {
    const stopped = await killVerifiedStaleBridge(bridgePort, host);
    return { state: 'hung', stopped };
  }
  return { state: 'absent' };
}

/**
 * Spawn a background detached CDP Bridge process so the single approved Chrome WebSocket
 * persists across process exits and AFK overnight runs.
 */
export async function ensureCdpBridgeDaemon(
  upstreamUrl,
  { bridgePort = DEFAULT_BRIDGE_PORT, host = '127.0.0.1', timeoutMs = 45000, onNote = null, insecure = false } = {}
) {
  const existing = await probeBridge(bridgePort, host);
  // A bridge without a token is never reused silently: it is replaced by an authenticated one (unless insecure was asked for).
  if (existing && existing.upstreamConnected && existing.upstreamUrl === upstreamUrl && !existing.unauthorized && Boolean(existing.insecure) === Boolean(insecure)) {
    return existing.bridgeHttpUrl;
  }
  if (existing) {
    // A daemon from a previous Chrome run still owns the port: replace it instead of waiting for a port that never frees.
    let stopped = await stopBridge(bridgePort, host);
    let how = existing.insecure && !insecure ? 'bridge without a token replaced by an authenticated one' : 'bridge upstream stale: restarted';
    if (!stopped && (await killVerifiedStaleBridge(bridgePort, host))) {
      stopped = true;
      how = 'bridge from older code (no /shutdown) terminated and restarted';
    }
    if (!stopped) {
      onNote?.(`bridge on port ${bridgePort} is stale (upstream gone) and could not be stopped; connecting directly`);
      return null;
    }
    onNote?.(how);
  }

  const selfPath = fileURLToPath(import.meta.url);
  // The daemon reads its token from this file (a command line or environment would be visible to other processes).
  if (!insecure) writeBridgeToken(bridgePort, crypto.randomBytes(24).toString('hex'));
  // A detached daemon does not inherit the environment on Windows: hand it the state folder explicitly.
  const homeArg = process.env.TURBO_BROWSER_HOME ? ` --home "${turboHome()}"` : '';
  const homeArgv = process.env.TURBO_BROWSER_HOME ? ['--home', turboHome()] : [];
  const insecureArg = (insecure ? ' --insecure' : '') + homeArg;
  if (process.platform === 'win32') {
    try {
      // Spawn outside any temporary Job Object on Windows via Win32_Process.Create
      const cmdLine = `"${process.execPath}" "${selfPath}" --daemon --upstream "${upstreamUrl}" --port ${bridgePort} --host ${host}${insecureArg}`;
      const escaped = cmdLine.replace(/'/g, "''");
      // DETACHED_PROCESS (no console) + SW_HIDE: node.exe is a console app, so without them Windows opens a console window.
      const ps = "$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; CreateFlags = [uint32]8 }; " +
        `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${escaped}'; ProcessStartupInformation = $si }; ` +
        'if ($r.ReturnValue -ne 0) { exit 1 }';
      execSync(
        `powershell -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`,
        { stdio: 'ignore', timeout: 5000, windowsHide: true }
      );
    } catch {
      const child = spawn(
        process.execPath,
        [selfPath, '--daemon', '--upstream', upstreamUrl, '--port', String(bridgePort), '--host', host, ...(insecure ? ['--insecure'] : []), ...homeArgv],
        { detached: true, stdio: 'ignore', windowsHide: true }
      );
      child.unref();
    }
  } else {
    const child = spawn(
      process.execPath,
      [selfPath, '--daemon', '--upstream', upstreamUrl, '--port', String(bridgePort), '--host', host, ...(insecure ? ['--insecure'] : []), ...homeArgv],
      { detached: true, stdio: 'ignore', windowsHide: true }
    );
    child.unref();
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await getRunningBridgeInfo(bridgePort, host);
    if (info) return info.bridgeHttpUrl;
    await new Promise((r) => setTimeout(r, 400));
  }
  onNote?.(`bridge did not start within ${Math.round(timeoutMs / 1000)}s`);
  return null;
}

/**
 * Launch Chrome with a dedicated non-default `--user-data-dir` and `--remote-debugging-port`
 * so Chrome 136+/144+/157 exposes standard HTTP/WS CDP with ZERO "Allow remote debugging?" prompts.
 */
export async function launchUnattendedChrome({
  executablePath,
  port = 9222,
  userDataDir = path.join(turboHome(), 'chrome-profile'),
  headless = false,
} = {}) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (headless) args.push('--headless=new');

  if (process.platform === 'win32') {
    try {
      const quotedArgs = args.map((a) => `"${a}"`).join(' ');
      const cmdLine = `"${executablePath}" ${quotedArgs}`;
      const escaped = cmdLine.replace(/'/g, "''");
      execSync(
        `powershell -NoProfile -Command "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${escaped}' }"`,
        { stdio: 'ignore', timeout: 5000 }
      );
    } catch {
      const child = spawn(executablePath, args, { detached: true, stdio: 'ignore', windowsHide: headless });
      child.unref();
    }
  } else {
    const child = spawn(executablePath, args, { detached: true, stdio: 'ignore' });
    child.unref();
  }

  const endpoint = `http://127.0.0.1:${port}`;
  const start = Date.now();
  while (Date.now() - start < 15000) {
    try {
      const res = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(600) });
      if (res.ok) return endpoint;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for unattended Chrome on ${endpoint}`);
}

// CLI daemon entrypoint: node src/cdp-bridge.mjs --daemon --upstream ws://... --port 9224
const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() ===
    path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (isDirectRun && process.argv.includes('--daemon')) {
  const getArg = (flag, fallback) => {
    const idx = process.argv.indexOf(flag);
    return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
  };
  const upstreamUrl = getArg('--upstream', '');
  const port = Number(getArg('--port', DEFAULT_BRIDGE_PORT)) || DEFAULT_BRIDGE_PORT;
  const host = getArg('--host', '127.0.0.1');
  const homeArg = getArg('--home', '');
  if (homeArg) process.env.TURBO_BROWSER_HOME = homeArg;
  const insecure = process.argv.includes('--insecure');
  const daemonToken = insecure ? '' : readBridgeToken(port);
  if (!insecure && !daemonToken) {
    console.error('[turbo-browser-mcp] Bridge daemon refuses to start without a token (pass --insecure to run it open).');
    process.exit(1);
  }

  // Distinct exit codes: 0 shutdown, 1 failed to start, 3 upstream Chrome gone for good, 4 own server socket lost.
  // The daemon keeps no pid/port marker files; the listening port is the only state it owns.
  const log = (m) => console.error(`[turbo-browser-mcp] bridge: ${m}`);
  createCdpBridgeServer({
    upstreamUrl,
    port,
    host,
    insecure,
    token: daemonToken || null,
    reconnectMs: 2500,
    log,
    onUpstreamLost: () => { setTimeout(() => process.exit(3), 50); },
    onServerLost: () => { setTimeout(() => process.exit(4), 50); },
  })
    .then(({ server, bridgeHttpUrl }) => {
      console.log(`[turbo-browser-mcp] CDP Keep-Alive Bridge listening at ${redactBridgeToken(bridgeHttpUrl)} -> ${upstreamUrl}`);
      // Runs after serverLost(): an unexpected close has already scheduled exit code 4; a /shutdown close exits 0.
      server.on('close', () => setTimeout(() => process.exit(0), 200));
    })
    .catch((err) => {
      console.error(`[turbo-browser-mcp] Bridge daemon failed: ${err.message}`);
      process.exit(1);
    });
}
