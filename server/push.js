// Phone notifications (Web Push). Each phone that turns notifications on
// stores a subscription here; when someone ticks an item off, everyone else's
// phones are sent a notification, even with the app closed or the screen locked.

import webpush from 'web-push';

const MAX_SUBSCRIPTIONS = 20;
const SEND_TIMEOUT_MS = 10_000;
// A tick that couldn't be delivered within the hour is old news.
const TTL_SECONDS = 60 * 60;

// The push services browsers use. Only these are ever sent to, so a
// subscription can't be used to make this server call an arbitrary address.
const PUSH_HOSTS = [
  'fcm.googleapis.com', // Chrome, Edge and other Chromium browsers on Android and desktop
  'android.googleapis.com',
  'push.services.mozilla.com', // Firefox
  'push.apple.com', // Safari, including iPhone home-screen apps
  'notify.windows.com', // Edge on Windows
];

export function isKnownPushService(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  return PUSH_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
}

const B64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;
const decodedLength = (s) => Buffer.from(s, 'base64url').length;

export class PushError extends Error {}

/**
 * Check a PushSubscription as the browser serialises it
 * ({ endpoint, keys: { p256dh, auth } }) and return the parts we store.
 */
export function parseSubscription(sub, allowEndpoint = isKnownPushService) {
  if (!sub || typeof sub !== 'object') throw new PushError('subscription is required');
  const { endpoint, keys } = sub;
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || !allowEndpoint(endpoint)) {
    throw new PushError('This browser’s notification service is not supported');
  }
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  // p256dh is an uncompressed P-256 public key (65 bytes), auth a 16 byte secret.
  if (typeof p256dh !== 'string' || !B64URL_RE.test(p256dh) || decodedLength(p256dh) !== 65) {
    throw new PushError('subscription key is invalid');
  }
  if (typeof auth !== 'string' || !B64URL_RE.test(auth) || decodedLength(auth) !== 16) {
    throw new PushError('subscription secret is invalid');
  }
  return { endpoint, p256dh, auth };
}

/** VAPID keys identify this server to the push services; made once and kept in the database. */
export function loadVapidKeys(list) {
  let publicKey = list.getMeta('vapid_public_key');
  let privateKey = list.getMeta('vapid_private_key');
  if (!publicKey || !privateKey) {
    ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
    list.transaction(() => {
      list.setMeta('vapid_public_key', publicKey);
      list.setMeta('vapid_private_key', privateKey);
    });
  }
  return { publicKey, privateKey };
}

export class PushStore {
  constructor(db, { now = () => Date.now() } = {}) {
    this.now = now;
    this.stmt = {
      upsert: db.prepare(
        `INSERT INTO push_subscriptions (endpoint, person, p256dh, auth, created_at, updated_at)
         VALUES (@endpoint, @person, @p256dh, @auth, @now, @now)
         ON CONFLICT (endpoint) DO UPDATE SET
           person = excluded.person, p256dh = excluded.p256dh, auth = excluded.auth,
           updated_at = excluded.updated_at`,
      ),
      get: db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?'),
      remove: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?'),
      all: db.prepare('SELECT * FROM push_subscriptions ORDER BY updated_at'),
      // Phones that were replaced or reset never unsubscribe; keep the newest.
      prune: db.prepare(
        `DELETE FROM push_subscriptions WHERE endpoint NOT IN
           (SELECT endpoint FROM push_subscriptions ORDER BY updated_at DESC LIMIT ?)`,
      ),
    };
    this.db = db;
  }

  save({ endpoint, p256dh, auth }, person) {
    this.db.transaction(() => {
      this.stmt.upsert.run({ endpoint, person, p256dh, auth, now: this.now() });
      this.stmt.prune.run(MAX_SUBSCRIPTIONS);
    })();
  }

  get(endpoint) {
    return this.stmt.get.get(endpoint) ?? null;
  }

  remove(endpoint) {
    return this.stmt.remove.run(endpoint).changes > 0;
  }

  all() {
    return this.stmt.all.all();
  }
}

export class Notifier {
  /**
   * vapid: { publicKey, privateKey, subject }
   * fetchImpl is swappable for tests.
   */
  constructor({ store, vapid, log = console, fetchImpl = globalThis.fetch }) {
    this.store = store;
    this.vapid = vapid;
    this.log = log;
    this.fetch = fetchImpl;
    this.pending = new Set();
  }

  get publicKey() {
    return this.vapid.publicKey;
  }

  /**
   * Send `payload` to every subscribed phone except those belonging to
   * `exceptPerson` and those in `skipEndpoints` (phones looking at the app
   * right now, which show the in-app pop-up instead). Never throws.
   */
  notifyOthers(exceptPerson, payload, { skipEndpoints = new Set() } = {}) {
    const targets = this.store
      .all()
      .filter((s) => s.person !== exceptPerson && !skipEndpoints.has(s.endpoint));
    const body = JSON.stringify(payload);
    for (const sub of targets) {
      const p = this.#send(sub, body).finally(() => this.pending.delete(p));
      this.pending.add(p);
    }
    return targets.length;
  }

  /** Send to one phone, e.g. a test notification. */
  notifyEndpoint(endpoint, payload) {
    const sub = this.store.get(endpoint);
    if (!sub) return false;
    const p = this.#send(sub, JSON.stringify(payload)).finally(() => this.pending.delete(p));
    this.pending.add(p);
    return true;
  }

  /** Resolves once every notification sent so far has been delivered or failed. */
  async settle() {
    await Promise.allSettled([...this.pending]);
  }

  async #send(sub, body) {
    try {
      const details = webpush.generateRequestDetails(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
        {
          vapidDetails: this.vapid,
          TTL: TTL_SECONDS,
          urgency: 'high',
        },
      );
      const res = await this.fetch(details.endpoint, {
        method: details.method,
        headers: details.headers,
        body: details.body,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (res.status === 404 || res.status === 410) {
        // The phone unsubscribed, or the browser was reset or uninstalled.
        this.store.remove(sub.endpoint);
        this.log.log(`Removed an expired notification subscription for ${sub.person}`);
      } else if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 200);
        this.log.warn(`Notification to ${sub.person}'s phone was refused (${res.status}): ${text}`);
        return;
      }
      await res.arrayBuffer().catch(() => {});
    } catch (err) {
      // fetch hides the useful part ("ENOTFOUND", "ECONNREFUSED") in err.cause.
      const why = err.cause?.code ? `${err.message} (${err.cause.code})` : err.message;
      this.log.warn(`Could not send a notification to ${sub.person}'s phone: ${why}`);
    }
  }
}
