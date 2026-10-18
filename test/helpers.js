import { once } from 'node:events';
import WebSocket from 'ws';
import { openDatabase, ListStore } from '../server/db.js';
import { Auth } from '../server/auth.js';
import { HistoryStore } from '../server/history.js';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { PushStore, Notifier, loadVapidKeys } from '../server/push.js';

export const silentLog = { warn() {}, error() {}, log() {} };

/**
 * Starts the app on a random port. `push.allowEndpoint` lets tests point
 * subscriptions at a local stand-in for a push service.
 */
export async function startServer(env = {}, { push: pushOptions = {} } = {}) {
  const config = loadConfig({ PEOPLE: 'Cody:Aldi,Jess:M&S', STORES: 'Aldi,M&S', ...env });
  const db = openDatabase(':memory:');
  const list = new ListStore(db);
  const history = new HistoryStore(db);
  const auth = new Auth({ passcode: config.passcode, secret: 'test-secret', sessionDays: 1 });
  const pushStore = new PushStore(db);
  const notifier = new Notifier({
    store: pushStore,
    vapid: { ...loadVapidKeys(list), subject: config.pushContact },
    log: silentLog,
  });
  const push = { store: pushStore, notifier, allowEndpoint: pushOptions.allowEndpoint };
  const { server, close } = createApp({ config, list, history, auth, push, log: silentLog });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    list,
    history,
    auth,
    push,
    async stop() {
      await close();
      db.close();
    },
  };
}

/** A WebSocket client that buffers messages so tests can wait for a given type. */
export async function connectClient(url, options = {}) {
  const ws = new WebSocket(url, options);
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  await once(ws, 'open');
  const next = (match = () => true, timeoutMs = 2000) => {
    const i = queue.findIndex(match);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
      waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  };
  return {
    ws,
    send: (m) => ws.send(JSON.stringify(m)),
    next,
    nextType: (type) => next((m) => m.type === type),
    close: () => ws.close(),
  };
}
