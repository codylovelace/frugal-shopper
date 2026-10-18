import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import ece from 'http_ece';
import { startServer, connectClient } from './helpers.js';
import { parseSubscription, isKnownPushService, PushError } from '../server/push.js';
import { loadConfig, ConfigError } from '../server/config.js';

const ID1 = 'item-0000001';
const ID2 = 'item-0000002';

/** What a browser would create: a P-256 key pair and a 16 byte auth secret. */
function phoneKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ecdh,
    auth,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
  };
}

/**
 * A stand-in for a push service (FCM, Apple, Mozilla): records each request
 * and decrypts the payload with the phone's private key, exactly as the
 * phone would. `status` sets what it answers.
 */
async function fakePushService() {
  const received = [];
  const waiters = [];
  const phones = new Map();
  let status = 201;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const phone = phones.get(req.url);
      const body = Buffer.concat(chunks);
      const message = {
        path: req.url,
        headers: req.headers,
        payload: phone
          ? JSON.parse(
              ece
                .decrypt(body, { version: 'aes128gcm', privateKey: phone.ecdh, authSecret: phone.keys.auth })
                .toString('utf8'),
            )
          : null,
      };
      res.writeHead(status).end();
      const w = waiters.shift();
      if (w) w(message);
      else received.push(message);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    received,
    phone(name) {
      const keys = phoneKeys();
      const path = `/push/${name}-${crypto.randomUUID()}`;
      phones.set(path, keys);
      return { endpoint: base + path, keys: keys.keys, ecdh: keys.ecdh };
    },
    next(timeoutMs = 2000) {
      if (received.length) return Promise.resolve(received.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no notification arrived')), timeoutMs);
        waiters.push((m) => {
          clearTimeout(timer);
          resolve(m);
        });
      });
    },
    setStatus(s) {
      status = s;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

const post = (base, path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const subscribe = (base, person, phone, extra = {}) =>
  post(base, '/api/push/subscribe', {
    person,
    subscription: { endpoint: phone.endpoint, expirationTime: null, keys: phone.keys },
    ...extra,
  });

async function setup(t) {
  const push = await fakePushService();
  const srv = await startServer({}, { push: { allowEndpoint: (e) => e.startsWith('http://127.0.0.1:') } });
  const cody = await connectClient(srv.wsUrl);
  const jess = await connectClient(srv.wsUrl);
  t.after(async () => {
    cody.close();
    jess.close();
    await srv.stop();
    await push.close();
  });
  await cody.nextType('state');
  await jess.nextType('state');
  cody.send({ type: 'identify', person: 'Cody', store: 'Aldi' });
  jess.send({ type: 'identify', person: 'Jess', store: 'M&S' });
  await jess.next((m) => m.type === 'presence' && m.online.length === 2);
  return { push, srv, cody, jess };
}

async function op(client, opId, operation) {
  client.send({ type: 'op', opId, op: operation });
  const reply = await client.next((m) => (m.type === 'ack' || m.type === 'nack') && m.opId === opId);
  assert.equal(reply.type, 'ack', reply.error);
}

test('only real push services are accepted as subscription endpoints', () => {
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QGx',
    'https://wns2-db5p.notify.windows.com/w/?token=abc',
  ]) {
    assert.equal(isKnownPushService(ok), true, ok);
  }
  for (const bad of [
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com.evil.example/abc',
    'https://evilpush.apple.com/abc',
    'https://127.0.0.1/abc',
    'https://user@fcm.googleapis.com/abc',
    'https://fcm.googleapis.com:8443/abc',
    'not a url',
  ]) {
    assert.equal(isKnownPushService(bad), false, bad);
  }

  const { keys } = phoneKeys();
  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
  assert.deepEqual(parseSubscription({ endpoint, keys }), { endpoint, ...keys });
  assert.throws(() => parseSubscription({ endpoint: 'https://example.com/x', keys }), PushError);
  assert.throws(() => parseSubscription({ endpoint, keys: { ...keys, p256dh: 'abc' } }), /key is invalid/);
  assert.throws(() => parseSubscription({ endpoint, keys: { ...keys, auth: keys.p256dh } }), /secret/);
  assert.throws(() => parseSubscription(null), PushError);
});

test('config: PUSH_CONTACT must be a mailto: or https: contact', () => {
  assert.match(loadConfig({}).pushContact, /^https:\/\//);
  assert.equal(loadConfig({ PUSH_CONTACT: 'mailto:me@example.com' }).pushContact, 'mailto:me@example.com');
  assert.throws(() => loadConfig({ PUSH_CONTACT: 'me@example.com' }), ConfigError);
  assert.throws(() => loadConfig({ PUSH_CONTACT: 'http://example.com' }), ConfigError);
});

test('push: a tick notifies the other person, not the one who ticked', async (t) => {
  const { push, srv, cody, jess } = await setup(t);
  const jessPhone = push.phone('jess');
  const codyPhone = push.phone('cody');
  assert.equal((await subscribe(srv.base, 'Jess', jessPhone)).status, 200);
  assert.equal((await subscribe(srv.base, 'Cody', codyPhone)).status, 200);

  await op(cody, 'op-00000001', { kind: 'add', id: ID1, name: '500g oats', quantity: 3 });
  await op(cody, 'op-00000002', { kind: 'buy', id: ID1, store: 'Aldi', pricePence: 267 });

  const sent = await push.next();
  assert.ok(sent.path.startsWith('/push/jess-'), 'went to Jess');
  assert.deepEqual(sent.payload, {
    kind: 'tick',
    by: 'Cody',
    title: 'Cody ticked off 3 × 500g oats',
    body: '£2.67 at Aldi',
    tag: 'ticks-Cody',
    tick: '3 × 500g oats £2.67',
  });
  assert.equal(sent.headers['content-encoding'], 'aes128gcm');
  assert.equal(sent.headers.urgency, 'high');
  assert.equal(sent.headers.ttl, '3600');
  // VAPID: a signed token plus this server's public key.
  const { publicKey } = await (await fetch(`${srv.base}/api/push`)).json();
  assert.match(
    sent.headers.authorization,
    new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${publicKey}$`),
  );

  // Changing the price of something already ticked off doesn't notify again.
  await op(cody, 'op-00000003', { kind: 'buy', id: ID1, store: 'Aldi', pricePence: 260 });
  // Jess ticking notifies Cody.
  await op(jess, 'op-00000004', { kind: 'add', id: ID2, name: 'Bread' });
  await op(jess, 'op-00000005', { kind: 'buy', id: ID2, store: 'M&S', pricePence: 150 });
  const toCody = await push.next();
  assert.ok(toCody.path.startsWith('/push/cody-'));
  assert.equal(toCody.payload.title, 'Jess ticked off Bread');
  await srv.push.notifier.settle();
  assert.equal(push.received.length, 0, 'no other notifications were sent');

  // Finishing the shop tells the other person.
  await op(cody, 'op-00000006', { kind: 'finishTrip', ids: [ID1, ID2] });
  const finished = await push.next();
  assert.ok(finished.path.startsWith('/push/jess-'));
  assert.equal(finished.payload.title, 'Cody finished the shop');
  assert.equal(finished.payload.body, '2 items saved to History');
});

test('push: a phone with the app on screen gets the in-app pop-up instead', async (t) => {
  const { push, srv, cody, jess } = await setup(t);
  const jessPhone = push.phone('jess');
  await subscribe(srv.base, 'Jess', jessPhone);

  jess.send({ type: 'visibility', visible: true, endpoint: jessPhone.endpoint });
  await op(cody, 'op-00000001', { kind: 'add', id: ID1, name: 'Milk' });
  await op(cody, 'op-00000002', { kind: 'buy', id: ID1, store: 'Aldi', pricePence: 120 });
  await jess.next((m) => m.type === 'changes' && m.items[0]?.bought);
  await srv.push.notifier.settle();
  assert.equal(push.received.length, 0, 'nothing sent while Jess is looking at the app');

  jess.send({ type: 'visibility', visible: false, endpoint: jessPhone.endpoint });
  await op(cody, 'op-00000003', { kind: 'add', id: ID2, name: 'Eggs' });
  await op(cody, 'op-00000004', { kind: 'buy', id: ID2, store: 'Aldi', pricePence: 199 });
  assert.equal((await push.next()).payload.title, 'Cody ticked off Eggs');
});

test('push: expired subscriptions are removed; renewals keep the owner', async (t) => {
  const { push, srv, cody } = await setup(t);
  const jessPhone = push.phone('jess');
  await subscribe(srv.base, 'Jess', jessPhone);

  // The service worker renews a subscription without knowing whose it is.
  const renewed = push.phone('jess');
  assert.equal(
    (await subscribe(srv.base, undefined, renewed, { oldEndpoint: jessPhone.endpoint })).status,
    200,
  );
  assert.deepEqual(
    srv.push.store.all().map((s) => [s.endpoint, s.person]),
    [[renewed.endpoint, 'Jess']],
  );
  assert.equal((await subscribe(srv.base, 'Nobody', push.phone('x'))).status, 400);

  push.setStatus(410);
  await op(cody, 'op-00000001', { kind: 'add', id: ID1, name: 'Milk' });
  await op(cody, 'op-00000002', { kind: 'buy', id: ID1, store: 'Aldi', pricePence: 120 });
  await push.next();
  await srv.push.notifier.settle();
  assert.deepEqual(srv.push.store.all(), [], 'gone subscription deleted');
});

test('push: test notification, unsubscribe, sign-in and cross-site checks', async (t) => {
  const push = await fakePushService();
  const srv = await startServer(
    { APP_PASSCODE: 'beefmince' },
    { push: { allowEndpoint: (e) => e.startsWith('http://127.0.0.1:') } },
  );
  t.after(async () => {
    await srv.stop();
    await push.close();
  });
  const phone = push.phone('jess');

  assert.equal((await fetch(`${srv.base}/api/push`)).status, 401);
  assert.equal((await subscribe(srv.base, 'Jess', phone)).status, 401);

  const login = await post(srv.base, '/api/login', { passcode: 'beefmince' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const as = { cookie };

  const key = await (await fetch(`${srv.base}/api/push`, { headers: as })).json();
  assert.equal(Buffer.from(key.publicKey, 'base64url').length, 65);

  const cross = await post(
    srv.base,
    '/api/push/subscribe',
    { person: 'Jess', subscription: { endpoint: phone.endpoint, keys: phone.keys } },
    { ...as, Origin: 'https://evil.example' },
  );
  assert.equal(cross.status, 403);

  const real = await post(
    srv.base,
    '/api/push/subscribe',
    {
      person: 'Jess',
      subscription: { endpoint: 'https://example.com/not-a-push-service', keys: phone.keys },
    },
    as,
  );
  assert.equal(real.status, 400, 'unknown push hosts are refused');

  assert.equal(
    (await post(srv.base, '/api/push/subscribe', { person: 'Jess', subscription: phone }, as)).status,
    200,
  );
  assert.equal((await post(srv.base, '/api/push/test', { endpoint: phone.endpoint }, as)).status, 200);
  const sent = await push.next();
  assert.equal(sent.payload.title, 'Notifications are on');
  assert.equal(sent.payload.body, "You'll get one like this when Cody ticks something off.");

  assert.equal((await post(srv.base, '/api/push/unsubscribe', { endpoint: phone.endpoint }, as)).status, 200);
  assert.deepEqual(srv.push.store.all(), []);
  assert.equal((await post(srv.base, '/api/push/test', { endpoint: phone.endpoint }, as)).status, 404);
});

test('push: the server keys are made once and kept', async () => {
  const { openDatabase, ListStore } = await import('../server/db.js');
  const { loadVapidKeys } = await import('../server/push.js');
  const list = new ListStore(openDatabase(':memory:'));
  const first = loadVapidKeys(list);
  assert.deepEqual(loadVapidKeys(list), first);
  assert.equal(Buffer.from(first.publicKey, 'base64url').length, 65);
});
