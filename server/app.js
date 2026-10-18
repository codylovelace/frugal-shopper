import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { applyOp, OpError } from './ops.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
};

const OP_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const HEARTBEAT_MS = 25_000;
const MAX_MESSAGE_BYTES = 64 * 1024;

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; " +
    "script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

/**
 * Read every file under public/ into memory once. Only these exact paths are
 * ever served, so there is no way to request a file outside the folder.
 */
function loadStaticFiles(dir = PUBLIC_DIR) {
  const files = new Map();
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const type = MIME[path.extname(entry.name)];
      if (!type) continue;
      const body = fs.readFileSync(full);
      const urlPath = '/' + path.relative(dir, full).split(path.sep).join('/');
      const etag = `"${crypto.createHash('sha1').update(body).digest('base64url')}"`;
      files.set(urlPath, { body, type, etag });
    }
  };
  walk(dir);
  files.set('/', files.get('/index.html'));
  return files;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
}

function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function createApp({ config, list, history, auth, log = console }) {
  const files = loadStaticFiles();

  const clientIp = (req) => {
    if (config.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      if (fwd) return String(fwd).split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  };

  const isSecure = (req) =>
    Boolean(req.socket.encrypted) ||
    (config.trustProxy && String(req.headers['x-forwarded-proto'] || '').startsWith('https'));

  // Browsers always send Origin on WebSocket and cross-site POST requests.
  // Requiring it to match the host we were reached on stops another website
  // from using a signed-in browser to talk to this app.
  const sameOrigin = (req) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      return false;
    }
    const expected = [req.headers.host];
    if (config.trustProxy && req.headers['x-forwarded-host']) {
      expected.push(String(req.headers['x-forwarded-host']).split(',')[0].trim());
    }
    return expected.includes(host);
  };

  const publicConfig = (req) => ({
    title: config.title,
    stores: config.stores,
    people: config.people,
    authRequired: auth.enabled,
    authenticated: auth.isAuthenticated(req),
  });

  async function handleApi(req, res, url) {
    if (url.pathname === '/api/config' && req.method === 'GET') {
      return sendJson(res, 200, publicConfig(req));
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Cross-site request refused' });
      if (!auth.enabled) return sendJson(res, 200, { ok: true });
      const ip = clientIp(req);
      if (auth.isLockedOut(ip)) {
        return sendJson(res, 429, { error: 'Too many wrong attempts. Try again in 15 minutes.' });
      }
      let body;
      try {
        body = await readJson(req);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
      if (!auth.checkPasscode(body.passcode)) {
        auth.recordFailure(ip);
        log.warn(`Failed passcode attempt from ${ip}`);
        return sendJson(res, 401, { error: 'Wrong passcode' });
      }
      auth.clearFailures(ip);
      return sendJson(
        res,
        200,
        { ok: true },
        { 'Set-Cookie': auth.cookie(auth.issueToken(), { secure: isSecure(req) }) },
      );
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Cross-site request refused' });
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie({ secure: isSecure(req) }) });
    }
    if (url.pathname === '/api/items' && req.method === 'GET') {
      if (!auth.isAuthenticated(req)) return sendJson(res, 401, { error: 'Sign in first' });
      return sendJson(res, 200, { items: list.listItems() });
    }
    if (url.pathname.startsWith('/api/history') || url.pathname === '/api/last-seen') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      if (!auth.isAuthenticated(req)) return sendJson(res, 401, { error: 'Sign in first' });
      if (url.pathname === '/api/history') return sendJson(res, 200, { trips: history.listTrips() });
      if (url.pathname === '/api/last-seen') return sendJson(res, 200, { items: history.lastSeen() });
      if (url.pathname === '/api/history/item') {
        const name = (url.searchParams.get('name') || '').slice(0, 100);
        if (!name.trim()) return sendJson(res, 400, { error: 'name is required' });
        return sendJson(res, 200, { name, entries: history.itemHistory(name) });
      }
      const m = /^\/api\/history\/(\d{1,12})$/.exec(url.pathname);
      if (m) {
        const trip = history.getTrip(Number(m[1]));
        return trip ? sendJson(res, 200, trip) : sendJson(res, 404, { error: 'No such shop' });
      }
    }
    return sendJson(res, 404, { error: 'Not found' });
  }

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return send(res, 400, 'Bad request');
    }

    if (url.pathname === '/healthz') {
      try {
        return sendJson(res, 200, { ok: list.ping() });
      } catch (err) {
        log.error('Health check failed', err);
        return sendJson(res, 503, { ok: false });
      }
    }

    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch((err) => {
        log.error('API error', err);
        if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
      });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    }
    const file = files.get(url.pathname);
    if (!file) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    const headers = {
      'Content-Type': file.type,
      ETag: file.etag,
      // Revalidate every time so phones pick up a new version straight after a redeploy.
      'Cache-Control': 'no-cache',
    };
    if (req.headers['if-none-match'] === file.etag) return send(res, 304, undefined, headers);
    return send(res, 200, req.method === 'HEAD' ? undefined : file.body, headers);
  });

  // ---- Realtime ----------------------------------------------------------

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  const presence = () => {
    const online = [];
    for (const ws of wss.clients) {
      if (ws.identity) online.push(ws.identity);
    }
    return online;
  };

  const broadcast = (message) => {
    const data = JSON.stringify(message);
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  };

  const reply = (ws, message) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  };

  server.on('upgrade', (req, socket, head) => {
    const reject = (status, text) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return reject(400, 'Bad Request');
    }
    if (pathname !== '/ws') return reject(404, 'Not Found');
    if (!sameOrigin(req)) return reject(403, 'Forbidden');
    if (!auth.isAuthenticated(req)) return reject(401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.identity = null;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    reply(ws, { type: 'state', items: list.listItems(), online: presence() });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return reply(ws, { type: 'error', error: 'Message was not valid JSON' });
      }

      if (msg.type === 'ping') return reply(ws, { type: 'pong' });

      if (msg.type === 'identify') {
        const person = config.people.find((p) => p.name === msg.person);
        if (!person || !config.stores.includes(msg.store)) {
          return reply(ws, { type: 'error', error: 'Unknown person or shop' });
        }
        ws.identity = { person: person.name, store: msg.store };
        return broadcast({ type: 'presence', online: presence() });
      }

      if (msg.type === 'op') {
        if (typeof msg.opId !== 'string' || !OP_ID_RE.test(msg.opId)) {
          return reply(ws, { type: 'error', error: 'Operation id missing' });
        }
        if (!ws.identity) {
          return reply(ws, { type: 'nack', opId: msg.opId, error: 'Choose who you are first' });
        }
        let result;
        try {
          result = list.transaction(() => {
            // A client resends anything it did not see acknowledged, e.g.
            // after its connection dropped mid-shop. Apply each op only once.
            if (list.hasAppliedOp(msg.opId)) return null;
            const r = applyOp(list, config, msg.op, ws.identity.person, history);
            list.recordOp(msg.opId);
            return r;
          });
        } catch (err) {
          if (err instanceof OpError) {
            return reply(ws, { type: 'nack', opId: msg.opId, error: err.message });
          }
          log.error('Failed to apply operation', err);
          return reply(ws, { type: 'nack', opId: msg.opId, error: 'Server error, not saved' });
        }
        if (result && (result.items.length || result.deleted.length)) {
          broadcast({ type: 'changes', items: result.items, deleted: result.deleted });
        }
        if (result?.historyChanged) {
          broadcast({
            type: 'history',
            by: ws.identity.person,
            finished: result.tripId ? { tripId: result.tripId, count: result.deleted.length } : null,
          });
        }
        return reply(ws, { type: 'ack', opId: msg.opId });
      }

      return reply(ws, { type: 'error', error: 'Unknown message type' });
    });

    ws.on('close', () => {
      if (ws.identity) broadcast({ type: 'presence', online: presence() });
    });
    ws.on('error', (err) => log.warn('WebSocket error', err.message));
  });

  // Drop connections that stop answering pings (phone went into a tunnel),
  // so presence stays honest.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);

  const pruneTimer = setInterval(
    () => {
      try {
        list.pruneOps();
      } catch (err) {
        log.error('Failed to prune old operation ids', err);
      }
    },
    60 * 60 * 1000,
  );
  heartbeat.unref();
  pruneTimer.unref();

  const close = () =>
    new Promise((resolve) => {
      clearInterval(heartbeat);
      clearInterval(pruneTimer);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });

  return { server, close };
}
