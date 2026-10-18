import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { once } from 'node:events';
import { startServer, connectClient } from './helpers.js';
import { loadConfig, ConfigError } from '../server/config.js';
import { openDatabase, ListStore } from '../server/db.js';
import { applyOp, OpError } from '../server/ops.js';

const ID1 = 'item-0000001';
const ID2 = 'item-0000002';

function freshList() {
  return new ListStore(openDatabase(':memory:'));
}
const config = loadConfig({});

test('config defaults to Cody at Aldi and Jess at M&S', () => {
  assert.deepEqual(config.stores, ['Aldi', 'M&S']);
  assert.deepEqual(config.people, [
    { name: 'Cody', store: 'Aldi' },
    { name: 'Jess', store: 'M&S' },
  ]);
  assert.equal(config.passcode, '');
  assert.equal(config.port, 3000);
});

test('config rejects bad settings with a clear message', () => {
  assert.throws(() => loadConfig({ STORES: 'Aldi' }), ConfigError);
  assert.throws(() => loadConfig({ STORES: 'Aldi,aldi' }), /duplicate/);
  assert.throws(() => loadConfig({ PEOPLE: 'Cody:Tesco' }), /not in STORES/);
  assert.throws(() => loadConfig({ APP_PASSCODE: '12' }), /at least 4/);
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/);
  assert.throws(() => loadConfig({ TRUST_PROXY: 'maybe' }), /TRUST_PROXY/);
});

test('ops: add, quote, buy, unbuy, edit, delete', () => {
  const list = freshList();
  applyOp(list, config, { kind: 'add', id: ID1, name: '  Beef   mince 5% ', note: '' }, 'Cody');
  let item = list.getItem(ID1);
  assert.equal(item.name, 'Beef mince 5%');
  assert.equal(item.createdBy, 'Cody');

  applyOp(list, config, { kind: 'quote', id: ID1, store: 'M&S', pricePence: 725, size: '750g' }, 'Jess');
  applyOp(list, config, { kind: 'quote', id: ID1, store: 'Aldi', pricePence: 759, size: '750g' }, 'Cody');
  item = list.getItem(ID1);
  assert.equal(item.quotes['M&S'].pricePence, 725);
  assert.equal(item.quotes['M&S'].updatedBy, 'Jess');
  assert.equal(item.quotes.Aldi.size, '750g');

  applyOp(list, config, { kind: 'buy', id: ID1, store: 'M&S', pricePence: 725 }, 'Jess');
  item = list.getItem(ID1);
  assert.deepEqual({ ...item.bought, at: 0 }, { store: 'M&S', pricePence: 725, by: 'Jess', at: 0 });

  applyOp(list, config, { kind: 'unbuy', id: ID1 }, 'Cody');
  assert.equal(list.getItem(ID1).bought, null);

  applyOp(list, config, { kind: 'edit', id: ID1, name: 'Mince', note: '750g pack' }, 'Cody');
  assert.equal(list.getItem(ID1).note, '750g pack');

  // Clearing both price and size removes the quote.
  applyOp(list, config, { kind: 'quote', id: ID1, store: 'Aldi', pricePence: null, size: '' }, 'Cody');
  assert.equal(list.getItem(ID1).quotes.Aldi, undefined);

  const r = applyOp(list, config, { kind: 'delete', id: ID1 }, 'Cody');
  assert.deepEqual(r.deleted, [ID1]);
  assert.equal(list.getItem(ID1), null);
});

test('ops: validation rejects bad input', () => {
  const list = freshList();
  const bad = (op, by = 'Cody') => assert.throws(() => applyOp(list, config, op, by), OpError);
  bad({ kind: 'add', id: ID1, name: 'Milk' }, 'Mallory');
  bad({ kind: 'add', id: 'short', name: 'Milk' });
  bad({ kind: 'add', id: ID1, name: '   ' });
  bad({ kind: 'add', id: ID1, name: 'x'.repeat(101) });
  bad({ kind: 'nope' });
  applyOp(list, config, { kind: 'add', id: ID1, name: 'Milk' }, 'Cody');
  bad({ kind: 'quote', id: ID1, store: 'Tesco', pricePence: 100 });
  bad({ kind: 'quote', id: ID1, store: 'Aldi', pricePence: 1.5 });
  bad({ kind: 'quote', id: ID1, store: 'Aldi', pricePence: -1 });
  bad({ kind: 'buy', id: ID1, store: 'Aldi', pricePence: null });
  bad({ kind: 'buy', id: ID2, store: 'Aldi', pricePence: 100 });
  bad({ kind: 'clearBought', ids: 'all' });
});

test('ops: re-adding an existing id is a no-op', () => {
  const list = freshList();
  applyOp(list, config, { kind: 'add', id: ID1, name: 'Milk' }, 'Cody');
  applyOp(list, config, { kind: 'add', id: ID1, name: 'Different' }, 'Jess');
  assert.equal(list.getItem(ID1).name, 'Milk');
  assert.equal(list.listItems().length, 1);
});

test('ops: clearBought only removes listed items that are still ticked', () => {
  const list = freshList();
  for (const id of [ID1, ID2, 'item-0000003']) applyOp(list, config, { kind: 'add', id, name: id }, 'Cody');
  applyOp(list, config, { kind: 'buy', id: ID1, store: 'Aldi', pricePence: 100 }, 'Cody');
  applyOp(list, config, { kind: 'buy', id: ID2, store: 'Aldi', pricePence: 100 }, 'Cody');
  // ID2 was ticked after the button press, so it isn't in the list and must survive.
  const r = applyOp(list, config, { kind: 'clearBought', ids: [ID1, 'item-0000003'] }, 'Jess');
  assert.deepEqual(r.deleted, [ID1]);
  assert.deepEqual(
    list
      .listItems()
      .map((i) => i.id)
      .sort(),
    [ID2, 'item-0000003'],
  );
});

test('items keep the order they were added in', () => {
  const list = freshList();
  applyOp(list, config, { kind: 'add', id: ID2, name: 'B' }, 'Cody');
  applyOp(list, config, { kind: 'add', id: ID1, name: 'A' }, 'Cody');
  assert.deepEqual(
    list.listItems().map((i) => i.name),
    ['B', 'A'],
  );
});

test('database migrations are recorded and re-opening is safe', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'db.sqlite');
  let db = openDatabase(file);
  new ListStore(db).addItem({ id: ID1, name: 'Milk', note: '', by: 'Cody' });
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  db.close();
  db = openDatabase(file);
  assert.equal(new ListStore(db).getItem(ID1).name, 'Milk');
  db.close();
});

test('realtime: a tick on one phone shows up on the other', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  const cody = await connectClient(srv.wsUrl);
  const jess = await connectClient(srv.wsUrl);
  t.after(() => {
    cody.close();
    jess.close();
  });
  assert.deepEqual((await cody.nextType('state')).items, []);
  await jess.nextType('state');

  cody.send({ type: 'identify', person: 'Cody', store: 'Aldi' });
  jess.send({ type: 'identify', person: 'Jess', store: 'M&S' });
  const presence = await jess.next((m) => m.type === 'presence' && m.online.length === 2);
  assert.deepEqual(presence.online.map((o) => o.person).sort(), ['Cody', 'Jess']);

  cody.send({ type: 'op', opId: 'op-00000001', op: { kind: 'add', id: ID1, name: 'Beef mince 5%' } });
  assert.deepEqual(await cody.nextType('ack'), { type: 'ack', opId: 'op-00000001' });
  const added = await jess.nextType('changes');
  assert.equal(added.items[0].name, 'Beef mince 5%');

  jess.send({
    type: 'op',
    opId: 'op-00000002',
    op: { kind: 'quote', id: ID1, store: 'M&S', pricePence: 725, size: '750g' },
  });
  const quoted = await cody.next((m) => m.type === 'changes' && m.items[0]?.quotes['M&S']);
  assert.equal(quoted.items[0].quotes['M&S'].pricePence, 725);

  jess.send({ type: 'op', opId: 'op-00000003', op: { kind: 'buy', id: ID1, store: 'M&S', pricePence: 725 } });
  const bought = await cody.next((m) => m.type === 'changes' && m.items[0]?.bought);
  assert.equal(bought.items[0].bought.by, 'Jess');
  assert.equal(bought.items[0].bought.pricePence, 725);
});

test('realtime: resending an operation applies it once', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = await connectClient(srv.wsUrl);
  t.after(() => c.close());
  await c.nextType('state');
  c.send({ type: 'identify', person: 'Cody', store: 'Aldi' });
  await c.nextType('presence');

  c.send({ type: 'op', opId: 'op-00000001', op: { kind: 'add', id: ID1, name: 'Milk' } });
  await c.nextType('ack');
  c.send({ type: 'op', opId: 'op-00000002', op: { kind: 'buy', id: ID1, store: 'Aldi', pricePence: 100 } });
  await c.nextType('ack');
  c.send({ type: 'op', opId: 'op-00000003', op: { kind: 'unbuy', id: ID1 } });
  await c.nextType('ack');
  // A delayed resend of the buy must not tick the item again.
  c.send({ type: 'op', opId: 'op-00000002', op: { kind: 'buy', id: ID1, store: 'Aldi', pricePence: 100 } });
  await c.nextType('ack');
  assert.equal(srv.list.getItem(ID1).bought, null);
});

test('realtime: answers app-level pings so phones can spot dead connections', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = await connectClient(srv.wsUrl);
  t.after(() => c.close());
  c.send({ type: 'ping' });
  assert.deepEqual(await c.nextType('pong'), { type: 'pong' });
});

test('realtime: operations are refused until the phone says who it is', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const c = await connectClient(srv.wsUrl);
  t.after(() => c.close());
  await c.nextType('state');
  c.send({ type: 'op', opId: 'op-00000001', op: { kind: 'add', id: ID1, name: 'Milk' } });
  const nack = await c.nextType('nack');
  assert.match(nack.error, /who you are/);
  c.send({ type: 'identify', person: 'Mallory', store: 'Aldi' });
  assert.match((await c.nextType('error')).error, /Unknown person/);
  c.send({ type: 'op', opId: 'op-00000002', op: { kind: 'add', id: ID1, name: '' } });
  assert.equal((await c.nextType('nack')).opId, 'op-00000002');
  c.send({ type: 'identify', person: 'Cody', store: 'Aldi' });
  c.send({ type: 'op', opId: 'op-00000003', op: { kind: 'add', id: ID1, name: '' } });
  assert.match((await c.nextType('nack')).error, /name is required/);
});

test('http: serves the app, config and health check with security headers', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  const page = await fetch(`${srv.base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  const etag = page.headers.get('etag');
  assert.equal((await fetch(`${srv.base}/`, { headers: { 'If-None-Match': etag } })).status, 304);

  assert.equal((await fetch(`${srv.base}/js/compare.js`)).status, 200);
  assert.equal((await fetch(`${srv.base}/../package.json`)).status, 404);
  assert.equal((await fetch(`${srv.base}/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${srv.base}/nope`)).status, 404);

  const cfg = await (await fetch(`${srv.base}/api/config`)).json();
  assert.deepEqual(cfg.stores, ['Aldi', 'M&S']);
  assert.equal(cfg.authRequired, false);
  assert.equal(cfg.authenticated, true);

  assert.deepEqual(await (await fetch(`${srv.base}/healthz`)).json(), { ok: true });
});

test('passcode: locks the list until the right passcode is entered', async (t) => {
  const srv = await startServer({ APP_PASSCODE: 'beefmince' });
  t.after(() => srv.stop());

  const cfg = await (await fetch(`${srv.base}/api/config`)).json();
  assert.equal(cfg.authRequired, true);
  assert.equal(cfg.authenticated, false);
  assert.equal((await fetch(`${srv.base}/api/items`)).status, 401);

  // WebSocket refused without a session.
  const ws = new WebSocket(srv.wsUrl);
  const [err] = await once(ws, 'error');
  assert.match(err.message, /401/);

  const wrong = await fetch(`${srv.base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: 'nope' }),
  });
  assert.equal(wrong.status, 401);

  const ok = await fetch(`${srv.base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: 'beefmince' }),
  });
  assert.equal(ok.status, 200);
  const setCookie = ok.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.doesNotMatch(setCookie, /Secure/); // plain http on the LAN
  const cookie = setCookie.split(';')[0];

  assert.equal((await fetch(`${srv.base}/api/items`, { headers: { cookie } })).status, 200);
  const c = await connectClient(srv.wsUrl, { headers: { cookie } });
  t.after(() => c.close());
  assert.equal((await c.nextType('state')).type, 'state');

  // A tampered cookie is rejected.
  const forged = cookie.slice(0, -2) + 'xx';
  assert.equal((await fetch(`${srv.base}/api/items`, { headers: { cookie: forged } })).status, 401);
});

test('passcode: locks out an address after repeated wrong guesses', async (t) => {
  const srv = await startServer({ APP_PASSCODE: 'beefmince' });
  t.after(() => srv.stop());
  const attempt = (passcode) =>
    fetch(`${srv.base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode }),
    });
  for (let i = 0; i < 10; i++) assert.equal((await attempt('wrong')).status, 401);
  // Even the right passcode is refused during the lockout.
  assert.equal((await attempt('beefmince')).status, 429);
});

test('passcode: changing the passcode signs everyone out', async () => {
  const { Auth } = await import('../server/auth.js');
  const a = new Auth({ passcode: 'first', secret: 's', sessionDays: 1 });
  const b = new Auth({ passcode: 'second', secret: 's', sessionDays: 1 });
  const token = a.issueToken();
  assert.equal(a.verifyToken(token), true);
  assert.equal(b.verifyToken(token), false);
  let now = Date.now();
  const c = new Auth({ passcode: 'first', secret: 's', sessionDays: 1, now: () => now });
  const t2 = c.issueToken();
  now += 2 * 24 * 60 * 60 * 1000;
  assert.equal(c.verifyToken(t2), false, 'expired tokens are refused');
});

test('cross-site requests are refused', async (t) => {
  const srv = await startServer({ APP_PASSCODE: 'beefmince' });
  t.after(() => srv.stop());
  const login = await fetch(`${srv.base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ passcode: 'beefmince' }),
  });
  assert.equal(login.status, 403);

  const ws = new WebSocket(srv.wsUrl, { headers: { Origin: 'https://evil.example' } });
  const [err] = await once(ws, 'error');
  assert.match(err.message, /403/);
});

test('behind a reverse proxy with TRUST_PROXY, the cookie is marked Secure', async (t) => {
  const srv = await startServer({ APP_PASSCODE: 'beefmince', TRUST_PROXY: 'true' });
  t.after(() => srv.stop());
  const res = await fetch(`${srv.base}/api/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Host': 'shop.example.com',
      Origin: 'https://shop.example.com',
    },
    body: JSON.stringify({ passcode: 'beefmince' }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /Secure/);
});
