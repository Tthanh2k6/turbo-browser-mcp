import crypto from 'node:crypto';
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const DEFAULT_BRIDGE_PORT = Number(process.env.TURBO_BROWSER_BRIDGE_PORT) || 9224;

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

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.end(encodeWsFrame(Buffer.alloc(0), 0x08, this.maskOutgoing));
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
} = {}) {
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
  const attachedTargets = new Map(); // sessionId -> Target.attachedToTarget params
  const discoveredTargets = new Map(); // targetId -> targetInfo
  let autoAttachEnabledUpstream = false;
  let discoverEnabledUpstream = false;

  function sendUpstreamRaw(obj) {
    if (!upstreamWs || upstreamWs.closed) return false;
    upstreamWs.send(JSON.stringify(obj));
    return true;
  }

  function callUpstreamInternal(method, params = {}) {
    return new Promise((resolve) => {
      if (!upstreamWs || upstreamWs.closed) {
        resolve(null);
        return;
      }
      const id = nextUpstreamId++;
      pendingCalls.set(id, { client: null, clientMsgId: null, internalResolve: resolve });
      sendUpstreamRaw({ id, method, params });
    });
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

          // Track target attachment state on root browser session so concurrent/subsequent clients stay in sync
          if (!msg.id && msg.method && !msg.sessionId) {
            if (msg.method === 'Target.attachedToTarget' && msg.params?.sessionId) {
              attachedTargets.set(msg.params.sessionId, msg.params);
            } else if (msg.method === 'Target.detachedFromTarget' && msg.params?.sessionId) {
              attachedTargets.delete(msg.params.sessionId);
            } else if (msg.method === 'Target.targetCreated' && msg.params?.targetInfo?.targetId) {
              discoveredTargets.set(msg.params.targetInfo.targetId, msg.params.targetInfo);
            } else if (msg.method === 'Target.targetDestroyed' && msg.params?.targetId) {
              discoveredTargets.delete(msg.params.targetId);
            } else if (msg.method === 'Target.targetInfoChanged' && msg.params?.targetInfo?.targetId) {
              const tInfo = msg.params.targetInfo;
              discoveredTargets.set(tInfo.targetId, tInfo);
              for (const [sid, entry] of attachedTargets.entries()) {
                if (entry.targetInfo?.targetId === tInfo.targetId) {
                  attachedTargets.set(sid, { ...entry, targetInfo: tInfo });
                }
              }
            }
          }

          if (msg.id !== undefined) {
            const pending = pendingCalls.get(msg.id);
            if (pending) {
              pendingCalls.delete(msg.id);
              if (pending.internalResolve) {
                pending.internalResolve(msg.result ?? null);
                return;
              }
              if (pending.client && !pending.client.closed) {
                const reply = { ...msg, id: pending.clientMsgId };
                pending.client.send(JSON.stringify(reply));
              }
            }
            return;
          }

          // Broadcast CDP events to all active downstream clients
          for (const c of clients) {
            if (!c.closed) {
              c.send(rawText);
            }
          }
        };

        ws.onClose = () => {
          upstreamConnected = false;
          upstreamWs = null;
          for (const c of clients) {
            c.close();
          }
          clients.clear();
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

  await connectUpstream();

  const server = http.createServer((req, res) => {
    const addr = server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : port;
    const wsEndpoint = `ws://${host}:${actualPort}/devtools/browser/turbo-bridge`;

    if (req.url?.startsWith('/json/version')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ...browserVersionInfo,
          webSocketDebuggerUrl: wsEndpoint,
          turboBridge: true,
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
      setTimeout(() => {
        for (const c of clients) c.close();
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

  server.on('upgrade', (req, socket) => {
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
    clients.add(client);

    client.onMessage = (rawMsg) => {
      let parsed;
      try {
        parsed = JSON.parse(rawMsg);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;

      const clientMsgId = parsed.id;
      if (!parsed.sessionId && parsed.method === 'Browser.close') {
        client.send(JSON.stringify({ id: clientMsgId, result: {} }));
        client.close();
        return;
      }

      const isRootTargetAutoAttach =
        !parsed.sessionId &&
        parsed.method === 'Target.setAutoAttach' &&
        parsed.params?.autoAttach === true;
      const isRootDiscover =
        !parsed.sessionId &&
        parsed.method === 'Target.setDiscoverTargets' &&
        parsed.params?.discover === true;

      // If another client already enabled autoAttach/discover on the upstream socket,
      // replay cached target events so the new client immediately sees all open tabs!
      if (isRootTargetAutoAttach && autoAttachEnabledUpstream && attachedTargets.size > 0) {
        for (const params of attachedTargets.values()) {
          client.send(JSON.stringify({ method: 'Target.attachedToTarget', params }));
        }
      }
      if (isRootDiscover && discoverEnabledUpstream && discoveredTargets.size > 0) {
        for (const targetInfo of discoveredTargets.values()) {
          client.send(JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo } }));
        }
      }

      if (isRootTargetAutoAttach) autoAttachEnabledUpstream = true;
      if (isRootDiscover) discoverEnabledUpstream = true;

      const upstreamId = nextUpstreamId++;
      pendingCalls.set(upstreamId, { client, clientMsgId, internalResolve: null });
      sendUpstreamRaw({ ...parsed, id: upstreamId });
    };

    client.onClose = () => {
      clients.delete(client);
      // When all downstream clients disconnect, reset autoAttach/discover on the upstream
      // socket so the next sequential client gets fresh Target.attachedToTarget events
      // from Chrome without closing the upstream WebSocket!
      if (clients.size === 0 && upstreamConnected) {
        autoAttachEnabledUpstream = false;
        discoverEnabledUpstream = false;
        attachedTargets.clear();
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

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const bridgeHttpUrl = `http://${host}:${actualPort}`;
  const bridgeWsUrl = `ws://${host}:${actualPort}/devtools/browser/turbo-bridge`;

  return {
    server,
    port: actualPort,
    bridgeHttpUrl,
    bridgeWsUrl,
    close: async () => {
      for (const c of clients) c.close();
      clients.clear();
      try {
        upstreamWs?.close();
      } catch {}
      await new Promise((r) => server.close(() => r()));
    },
  };
}

/**
 * Check if a persistent CDP Bridge is already running and connected to the given upstreamUrl.
 */
export async function getRunningBridgeInfo(bridgePort = DEFAULT_BRIDGE_PORT, host = '127.0.0.1') {
  try {
    const res = await fetch(`http://${host}:${bridgePort}/json/version`, {
      signal: AbortSignal.timeout(600),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.turboBridge && data.upstreamConnected) {
      return {
        bridgeHttpUrl: `http://${host}:${bridgePort}`,
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
    const res = await fetch(`http://${host}:${bridgePort}/json/version`, { signal: AbortSignal.timeout(600) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.turboBridge) {
      return { bridgeHttpUrl: `http://${host}:${bridgePort}`, upstreamUrl: data.upstreamUrl, upstreamConnected: Boolean(data.upstreamConnected) };
    }
  } catch {
    // nothing listening
  }
  return null;
}

/** Ask a running bridge to exit (POST /shutdown) and wait until its port is free. False for daemons too old to know it. */
export async function stopBridge(bridgePort = DEFAULT_BRIDGE_PORT, host = '127.0.0.1', waitMs = 2500) {
  try {
    await fetch(`http://${host}:${bridgePort}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(800) });
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
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 6000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
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

/**
 * Spawn a background detached CDP Bridge process so the single approved Chrome WebSocket
 * persists across process exits and AFK overnight runs.
 */
export async function ensureCdpBridgeDaemon(
  upstreamUrl,
  { bridgePort = DEFAULT_BRIDGE_PORT, host = '127.0.0.1', timeoutMs = 45000, onNote = null } = {}
) {
  const existing = await probeBridge(bridgePort, host);
  if (existing && existing.upstreamConnected && existing.upstreamUrl === upstreamUrl) {
    return existing.bridgeHttpUrl;
  }
  if (existing) {
    // A daemon from a previous Chrome run still owns the port: replace it instead of waiting for a port that never frees.
    let stopped = await stopBridge(bridgePort, host);
    let how = 'bridge upstream stale: restarted';
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
  if (process.platform === 'win32') {
    try {
      // Spawn outside any temporary Job Object on Windows via Win32_Process.Create
      const cmdLine = `"${process.execPath}" "${selfPath}" --daemon --upstream "${upstreamUrl}" --port ${bridgePort} --host ${host}`;
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
        [selfPath, '--daemon', '--upstream', upstreamUrl, '--port', String(bridgePort), '--host', host],
        { detached: true, stdio: 'ignore', windowsHide: true }
      );
      child.unref();
    }
  } else {
    const child = spawn(
      process.execPath,
      [selfPath, '--daemon', '--upstream', upstreamUrl, '--port', String(bridgePort), '--host', host],
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
  userDataDir = path.join(os.homedir(), '.turbo-browser-mcp', 'chrome-profile'),
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

  createCdpBridgeServer({ upstreamUrl, port, host })
    .then(({ server, bridgeHttpUrl }) => {
      console.log(`[turbo-browser-mcp] CDP Keep-Alive Bridge listening at ${bridgeHttpUrl} -> ${upstreamUrl}`);
      server.on('close', () => process.exit(0));
    })
    .catch((err) => {
      console.error(`[turbo-browser-mcp] Bridge daemon failed: ${err.message}`);
      process.exit(1);
    });
}
