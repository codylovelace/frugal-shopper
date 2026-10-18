import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { once } from 'node:events';
import { startServer, connectClient } from './helpers.js';
import { loadConfig, ConfigError } from '../server/config.js';
import { openDatabase, ListStore, MIGRATIONS } from '../server/db.js';
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
  new ListStore(db).addItem({ id: ID1, name: 'Milk', note: '', needs: { Cody: 1 }, by: 'Cody' });
  assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
  db.close();
  db = openDatabase(file);
  assert.equal(new ListStore(db).getItem(ID1).name, 'Milk');
  db.close();
});

test('an existing database from the first version gains quantity 1 on every item', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { default: Database } = await import('better-sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'v1.sqlite');
  const old = new Database(file);
  old.exec(MIGRATIONS[0]);
  old.pragma('user_version = 1');
  old
    .prepare(
      `INSERT INTO items (id, name, note, sort, created_at, created_by, updated_at)
       VALUES ('item-0000001', 'Milk', '', 1, 0, 'Cody', 0)`,
    )
    .run();
  old.close();
  const db = openDatabase(file);
  t.after(() => db.close());
  assert.equal(new ListStore(db).getItem(ID1).quantity, 1);
});

test('ops: quantity defaults to 1 and each person sets their own share', () => {
  const list = freshList();
  applyOp(list, config, { kind: 'add', id: ID1, name: 'Milk' }, 'Cody');
  assert.deepEqual(list.getItem(ID1).needs, { Cody: 1 });
  assert.equal(list.getItem(ID1).quantity, 1);
  applyOp(list, config, { kind: 'add', id: ID2, name: 'Eggs', quantity: 3 }, 'Cody');
  assert.equal(list.getItem(ID2).quantity, 3);

  applyOp(list, config, { kind: 'quantity', id: ID1, quantity: 4 }, 'Cody');
  assert.deepEqual(list.getItem(ID1).needs, { Cody: 4 });
  // Jess adds herself, which makes it a "both need" item with a summed quantity.
  applyOp(list, config, { kind: 'quantity', id: ID1, quantity: 1 }, 'Jess');
  assert.deepEqual(list.getItem(ID1).needs, { Cody: 4, Jess: 1 });
  assert.equal(list.getItem(ID1).quantity, 5);
  // Either phone can change the other person's share.
  applyOp(list, config, { kind: 'quantity', id: ID1, person: 'Jess', quantity: 2 }, 'Cody');
  assert.deepEqual(list.getItem(ID1).needs, { Cody: 4, Jess: 2 });
  // 0 removes a person while someone else still needs it...
  applyOp(list, config, { kind: 'quantity', id: ID1, quantity: 0 }, 'Cody');
  assert.deepEqual(list.getItem(ID1).needs, { Jess: 2 });
  // ...but the last person can't drop to 0.
  assert.throws(
    () => applyOp(list, config, { kind: 'quantity', id: ID1, quantity: 0 }, 'Jess'),
    /delete the item/,
  );

  for (const bad of [100, 1.5, '2', null, -1]) {
    assert.throws(() => applyOp(list, config, { kind: 'quantity', id: ID1, quantity: bad }, 'Jess'), OpError);
  }
  assert.throws(
    () => applyOp(list, config, { kind: 'quantity', id: ID1, person: 'Mallory', quantity: 1 }, 'Jess'),
    /unknown person/,
  );
  assert.throws(
    () => applyOp(list, config, { kind: 'add', id: 'item-0000003', name: 'X', quantity: 0 }, 'Cody'),
    OpError,
  );
});

test('ops: importing the same item twice combines the quantities (the oats example)', () => {
  const list = freshList();
  applyOp(list, config, { kind: 'add', id: ID1, name: '500g Oats', quantity: 2 }, 'Cody');
  // Jess imports her list: same item, written differently.
  const r = applyOp(list, config, { kind: 'add', id: ID2, name: '500 g oats', quantity: 1 }, 'Jess');
  assert.equal(r.mergedInto, ID1);
  assert.deepEqual(
    list.listItems().map((i) => [i.name, i.needs, i.quantity]),
    [['500g Oats', { Cody: 2, Jess: 1 }, 3]],
  );
  // Adding it again for the same person tops up their share.
  applyOp(list, config, { kind: 'add', id: 'item-0000003', name: 'oats 500g', quantity: 1 }, 'Cody');
  assert.deepEqual(list.getItem(ID1).needs, { Cody: 3, Jess: 1 });
  // Something added for someone else goes on their list.
  applyOp(list, config, { kind: 'add', id: 'item-0000004', name: 'Bread', for: 'Jess' }, 'Cody');
  assert.deepEqual(list.getItem('item-0000004').needs, { Jess: 1 });
});

test('ops: a bought item is not merged into; a new line is added instead', () => {
  const list = freshList();
  applyOp(list, config, { kind: 'add', id: ID1, name: 'Milk' }, 'Cody');
  applyOp(list, config, { kind: 'buy', id: ID1, store: 'Aldi', pricePence: 99 }, 'Cody');
  applyOp(list, config, { kind: 'add', id: ID2, name: 'milk' }, 'Jess');
  assert.equal(list.listItems().length, 2);
});

test('ops: merge look-alike items, or remember to keep them apart', () => {
  const list = freshList();
  applyOp(list, config, { kind: 'add', id: ID1, name: '500g oats', quantity: 2 }, 'Cody');
  applyOp(list, config, { kind: 'add', id: ID2, name: '500g rolled oats', quantity: 1 }, 'Jess');
  applyOp(list, config, { kind: 'quote', id: ID2, store: 'M&S', pricePence: 150, size: '500g' }, 'Jess');
  assert.equal(list.listItems().length, 2, 'near matches are not merged automatically');

  const r = applyOp(list, config, { kind: 'merge', id: ID2, intoId: ID1 }, 'Cody');
  assert.deepEqual(r.deleted, [ID2]);
  const merged = list.getItem(ID1);
  assert.deepEqual(merged.needs, { Cody: 2, Jess: 1 });
  assert.equal(merged.quotes['M&S'].pricePence, 150, 'prices carry over');
  assert.equal(list.getItem(ID2), null);

  applyOp(list, config, { kind: 'add', id: 'item-0000003', name: 'Milk' }, 'Cody');
  applyOp(list, config, { kind: 'add', id: 'item-0000004', name: 'Oat milk' }, 'Jess');
  applyOp(list, config, { kind: 'keepSeparate', id: 'item-0000004', otherId: 'item-0000003' }, 'Jess');
  assert.deepEqual(list.getItem('item-0000003').keepSeparate, ['item-0000004']);
  assert.deepEqual(list.listItems().find((i) => i.id === 'item-0000004').keepSeparate, ['item-0000003']);
  assert.throws(() => applyOp(list, config, { kind: 'merge', id: ID1, intoId: ID1 }, 'Cody'), OpError);
});

test("an existing database from the second version keeps quantities as the creator's need", async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { default: Database } = await import('better-sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'v2.sqlite');
  const old = new Database(file);
  old.exec(MIGRATIONS[0]);
  old.exec(MIGRATIONS[1]);
  old.pragma('user_version = 2');
  old
    .prepare(
      `INSERT INTO items (id, name, note, quantity, sort, created_at, created_by, updated_at)
       VALUES ('item-0000001', 'Milk', '', 3, 1, 0, 'Jess', 0)`,
    )
    .run();
  old.close();
  const db = openDatabase(file);
  t.after(() => db.close());
  const item = new ListStore(db).getItem(ID1);
  assert.deepEqual(item.needs, { Jess: 3 });
  assert.equal(item.quantity, 3);
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

test('history: finishing a shop saves the ticked items by date and keeps the rest', async () => {
  const { HistoryStore } = await import('../server/history.js');
  const db = openDatabase(':memory:');
  let now = Date.UTC(2026, 9, 18, 10);
  const list = new ListStore(db, { now: () => now });
  const history = new HistoryStore(db, { now: () => now });
  const op = (o, by = 'Cody') => applyOp(list, config, o, by, history);

  op({ kind: 'add', id: ID1, name: '500g oats', quantity: 2 });
  op({ kind: 'add', id: ID2, name: '500g oats' }, 'Jess');
  op({ kind: 'quote', id: ID1, store: 'Aldi', pricePence: 89, size: '500g' });
  op({ kind: 'quote', id: ID1, store: 'M&S', pricePence: 150, size: '500g' }, 'Jess');
  op({ kind: 'buy', id: ID1, store: 'Aldi', pricePence: 267 });
  op({ kind: 'add', id: 'item-0000003', name: 'Bread' }, 'Jess');

  assert.throws(() => op({ kind: 'finishTrip', ids: ['item-0000003'] }), /nothing ticked/);
  const r = op({ kind: 'finishTrip', ids: [ID1, 'item-0000003'] });
  assert.deepEqual(r.deleted, [ID1], 'only ticked items are saved and removed');
  assert.equal(r.historyChanged, true);
  assert.deepEqual(
    list.listItems().map((i) => i.name),
    ['Bread'],
  );

  const [trip] = history.listTrips();
  assert.deepEqual(trip, {
    id: r.tripId,
    finishedAt: now,
    finishedBy: 'Cody',
    itemCount: 1,
    spent: { Aldi: 267 },
  });
  const detail = history.getTrip(r.tripId);
  assert.equal(detail.items[0].name, '500g oats');
  assert.deepEqual(detail.items[0].needs, { Cody: 2, Jess: 1 });
  assert.equal(detail.items[0].quantity, 3);
  assert.deepEqual(detail.items[0].quotes, {
    Aldi: { pricePence: 89, size: '500g' },
    'M&S': { pricePence: 150, size: '500g' },
  });
  assert.deepEqual(detail.items[0].bought.store, 'Aldi');

  // A week later, oats again but M&S is cheaper.
  now += 7 * 24 * 60 * 60 * 1000;
  op({ kind: 'add', id: 'item-0000004', name: 'Oats 500 g' }, 'Jess');
  op({ kind: 'quote', id: 'item-0000004', store: 'M&S', pricePence: 80, size: '500g' }, 'Jess');
  op({ kind: 'buy', id: 'item-0000004', store: 'M&S', pricePence: 80 }, 'Jess');
  op({ kind: 'finishTrip', ids: ['item-0000004'] }, 'Jess');

  const past = history.itemHistory('500G OATS');
  assert.deepEqual(
    past.map((e) => [e.bought.store, e.bought.pricePence]),
    [
      ['M&S', 80],
      ['Aldi', 267],
    ],
  );
  const last = history.lastSeen();
  assert.equal(Object.keys(last).length, 1, 'both spellings count as one item');
  assert.equal(Object.values(last)[0].bought.store, 'M&S');

  assert.equal(history.listTrips().length, 2);
  op({ kind: 'deleteTrip', tripId: r.tripId });
  assert.equal(history.listTrips().length, 1);
  assert.equal(history.getTrip(r.tripId), null);
  assert.throws(() => op({ kind: 'deleteTrip', tripId: 'x' }), OpError);
  db.close();
});

test('history: API needs sign-in and finishing a shop notifies both phones', async (t) => {
  const srv = await startServer({ APP_PASSCODE: 'beefmince' });
  t.after(() => srv.stop());
  for (const path of ['/api/history', '/api/history/1', '/api/history/item?name=milk', '/api/last-seen']) {
    assert.equal((await fetch(`${srv.base}${path}`)).status, 401, path);
  }
  const login = await fetch(`${srv.base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: 'beefmince' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const get = (path) => fetch(`${srv.base}${path}`, { headers: { cookie } });

  const cody = await connectClient(srv.wsUrl, { headers: { cookie } });
  const jess = await connectClient(srv.wsUrl, { headers: { cookie } });
  t.after(() => {
    cody.close();
    jess.close();
  });
  await cody.nextType('state');
  await jess.nextType('state');
  cody.send({ type: 'identify', person: 'Cody', store: 'Aldi' });
  await cody.nextType('presence');
  const send = (opId, op) => cody.send({ type: 'op', opId, op });
  send('op-00000001', { kind: 'add', id: ID1, name: 'Milk' });
  send('op-00000002', { kind: 'buy', id: ID1, store: 'Aldi', pricePence: 99 });
  send('op-00000003', { kind: 'finishTrip', ids: [ID1] });
  const note = await jess.nextType('history');
  assert.equal(note.by, 'Cody');
  assert.equal(note.finished.count, 1);

  const { trips } = await (await get('/api/history')).json();
  assert.equal(trips.length, 1);
  assert.equal((await (await get(`/api/history/${trips[0].id}`)).json()).items[0].name, 'Milk');
  assert.equal((await get('/api/history/999')).status, 404);
  assert.equal((await (await get('/api/history/item?name=MILK')).json()).entries.length, 1);
  assert.equal((await get('/api/history/item?name=')).status, 400);
  assert.deepEqual(Object.keys((await (await get('/api/last-seen')).json()).items), ['milk']);
});
