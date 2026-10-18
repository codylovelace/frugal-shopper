// Phone notifications: turning them on for this phone and keeping the server
// told which phone belongs to whom. The service worker (/sw.js) shows them.

const SW_URL = '/sw.js';
let registration = null;

const isIos = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isInstalled = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

/**
 * Whether this phone can get notifications:
 * 'ok', 'insecure' (not on https), 'ios-install' (iPhone, not opened from the
 * Home Screen), 'unsupported' or 'denied' (blocked in the browser's settings).
 */
export function support() {
  if (!window.isSecureContext) return 'insecure';
  const apis = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  // iPhones only allow notifications for sites added to the Home Screen.
  if (isIos() && !isInstalled()) return 'ios-install';
  if (!apis) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return 'ok';
}

function keyBytes(base64url) {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function sameKey(buffer, base64url) {
  if (!buffer) return false;
  const a = new Uint8Array(buffer);
  const b = keyBytes(base64url);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server said ${res.status}`);
  return data;
}

async function serverKey() {
  const res = await fetch('/api/push', { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error('Notifications are not available on this server');
  return (await res.json()).publicKey;
}

/** Register the service worker; never asks the user anything. */
export async function register() {
  if (registration) return registration;
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return null;
  registration = await navigator.serviceWorker.register(SW_URL);
  return registration;
}

async function subscription() {
  const reg = await register();
  if (!reg || !('pushManager' in reg)) return null;
  return reg.pushManager.getSubscription();
}

/**
 * Ask permission, subscribe and tell the server this phone is `person`'s.
 * Must be called straight from a tap: browsers only show the permission
 * prompt in response to one. Returns the subscription's endpoint.
 */
export async function enable(person) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied' ? 'Notifications are blocked for this site' : 'Notifications were not allowed',
    );
  }
  await register();
  const reg = await navigator.serviceWorker.ready;
  const key = await serverKey();
  let sub = await reg.pushManager.getSubscription();
  // A subscription made for a different server key (e.g. the database was
  // reset) would be refused by the push service; start again.
  if (sub && !sameKey(sub.options?.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  await post('/api/push/subscribe', { person, subscription: sub.toJSON() });
  return sub.endpoint;
}

export async function disable() {
  const sub = await subscription();
  if (!sub) return;
  await post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

/**
 * If this phone already has notifications on, re-send its subscription so
 * the server has it under the right person. Returns the endpoint or null.
 */
export async function resync(person) {
  if (support() !== 'ok' || Notification.permission !== 'granted') return null;
  const sub = await subscription();
  if (!sub) return null;
  const key = await serverKey();
  if (!sameKey(sub.options?.applicationServerKey, key)) return enable(person);
  await post('/api/push/subscribe', { person, subscription: sub.toJSON() });
  return sub.endpoint;
}

export const sendTest = (endpoint) => post('/api/push/test', { endpoint });

/** Close notifications already shown, once the app itself is on screen. */
export async function clearShown() {
  if (!registration?.getNotifications) return;
  for (const n of await registration.getNotifications()) n.close();
}
