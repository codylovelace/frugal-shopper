import crypto from 'node:crypto';

export const COOKIE_NAME = 'fs_session';

const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

function sign(key, payload) {
  return crypto.createHmac('sha256', key).update(payload).digest('base64url');
}

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

/**
 * Shared-passcode sessions. When no passcode is configured every request is
 * allowed. The signing key mixes in the passcode, so changing APP_PASSCODE
 * signs everyone out.
 */
export class Auth {
  constructor({ passcode, secret, sessionDays, now = () => Date.now() }) {
    this.passcode = passcode;
    this.enabled = passcode !== '';
    this.key = crypto.createHmac('sha256', secret).update(`passcode:${passcode}`).digest();
    this.maxAgeMs = sessionDays * 24 * 60 * 60 * 1000;
    this.now = now;
    this.failures = new Map(); // ip -> { count, first }
  }

  checkPasscode(candidate) {
    if (typeof candidate !== 'string') return false;
    // Hash both sides so the comparison is constant time whatever the lengths.
    const a = crypto.createHash('sha256').update(candidate).digest();
    const b = crypto.createHash('sha256').update(this.passcode).digest();
    return crypto.timingSafeEqual(a, b);
  }

  isLockedOut(ip) {
    const f = this.failures.get(ip);
    if (!f) return false;
    if (this.now() - f.first > FAILURE_WINDOW_MS) {
      this.failures.delete(ip);
      return false;
    }
    return f.count >= MAX_FAILURES;
  }

  recordFailure(ip) {
    const f = this.failures.get(ip);
    if (!f || this.now() - f.first > FAILURE_WINDOW_MS) {
      this.failures.set(ip, { count: 1, first: this.now() });
    } else {
      f.count += 1;
    }
  }

  clearFailures(ip) {
    this.failures.delete(ip);
  }

  issueToken() {
    const payload = Buffer.from(JSON.stringify({ exp: this.now() + this.maxAgeMs })).toString('base64url');
    return `${payload}.${sign(this.key, payload)}`;
  }

  verifyToken(token) {
    if (typeof token !== 'string') return false;
    const dot = token.indexOf('.');
    if (dot <= 0) return false;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!safeEqual(sig, sign(this.key, payload))) return false;
    try {
      const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return Number.isFinite(exp) && exp > this.now();
    } catch {
      return false;
    }
  }

  isAuthenticated(req) {
    if (!this.enabled) return true;
    return this.verifyToken(parseCookies(req.headers.cookie)[COOKIE_NAME]);
  }

  cookie(token, { secure }) {
    const parts = [
      `${COOKIE_NAME}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(this.maxAgeMs / 1000)}`,
    ];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }

  clearCookie({ secure }) {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
  }
}
