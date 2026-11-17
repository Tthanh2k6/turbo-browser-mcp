// One sessionless CDP command over a short-lived WebSocket (no dependencies, Node 20 has no global WebSocket).
// Used when Playwright's own browser-level session is unusable, e.g. through an older bridge build that does not
// track Target.attachToBrowserTarget sessions. Sessionless commands are forwarded upstream by every bridge build.
import crypto from 'node:crypto';
import http from 'node:http';
import { bridgeUrlWithToken } from './cdp-bridge.mjs';

function maskedTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  let head;
  if (payload.length < 126) head = Buffer.from([0x81, 0x80 | payload.length]);
  else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
  return Buffer.concat([head, mask, body]);
}

/** Returns the parsed `result` of `method`, or throws. `endpoint` is http(s)://host:port or ws://host:port/path. */
export async function cdpRawCall(endpoint, method, params = {}, timeoutMs = 3000, { onlyBridge = false } = {}) {
  let wsUrl = endpoint;
  if (/^https?:/i.test(endpoint)) {
    const full = bridgeUrlWithToken(endpoint);
    const versionUrl = new URL('/json/version', full);
    versionUrl.search = new URL(full).search;
    const res = await fetch(versionUrl, { signal: AbortSignal.timeout(timeoutMs) });
    wsUrl = (await res.json()).webSocketDebuggerUrl;
  }
  // A bare Chrome (chrome://inspect mode) asks the owner to Allow every new connection: only talk to a bridge.
  if (onlyBridge && !/turbo-bridge/.test(String(wsUrl))) throw new Error('not a turbo bridge endpoint');
  const u = new URL(wsUrl);
  return new Promise((resolve, reject) => {
    let done = false;
    let sock;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock?.destroy(); } catch { /* ignore */ }
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error(`CDP raw call ${method} timed out`)), timeoutMs);
    const req = http.request({
      host: u.hostname, port: u.port || 80, path: u.pathname + u.search,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') },
    });
    req.on('error', finish);
    req.on('response', (r) => finish(new Error(`upgrade refused: HTTP ${r.statusCode}`)));
    req.on('upgrade', (_res, socket, head) => {
      sock = socket;
      let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
      let msg = null; // fragmented message
      const pump = () => {
        for (;;) {
          if (buf.length < 2) return;
          const fin = (buf[0] & 0x80) !== 0;
          const op = buf[0] & 0x0f;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const payload = buf.subarray(off, off + len);
          buf = buf.subarray(off + len);
          if (op === 8) return finish(new Error('socket closed by peer'));
          if (op === 9) { continue; }
          if (op === 1 || op === 0) {
            msg = op === 1 ? payload : Buffer.concat([msg || Buffer.alloc(0), payload]);
            if (!fin) continue;
            let parsed;
            try { parsed = JSON.parse(msg.toString('utf8')); } catch { msg = null; continue; }
            msg = null;
            if (parsed.id === 1) return parsed.error ? finish(new Error(parsed.error.message || 'CDP error')) : finish(null, parsed.result ?? {});
          }
        }
      };
      socket.on('data', (d) => { buf = Buffer.concat([buf, d]); try { pump(); } catch (e) { finish(e); } });
      socket.on('error', finish);
      socket.on('close', () => finish(new Error('socket closed')));
      socket.write(maskedTextFrame(JSON.stringify({ id: 1, method, params })));
    });
    req.end();
  });
}
