import crypto from 'node:crypto';
import path from 'node:path';
import { loadConfig, ConfigError } from './config.js';
import { openDatabase, ListStore } from './db.js';
import { Auth } from './auth.js';
import { createApp } from './app.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const dbFile = path.join(config.dataDir, 'frugal-shopper.db');
let db;
try {
  db = openDatabase(dbFile);
} catch (err) {
  if (err.code === 'EACCES' || err.code === 'SQLITE_CANTOPEN' || err.code === 'SQLITE_READONLY') {
    console.error(
      `Cannot write the database at ${dbFile} (${err.code}). The container runs as user ` +
        `"node" (uid 1000); if /data is a bind mount, run: chown -R 1000:1000 <host folder>`,
    );
    process.exit(1);
  }
  throw err;
}
const list = new ListStore(db);

// Without SESSION_SECRET, generate one and keep it in the database so
// sign-ins survive container restarts and image updates.
let secret = config.sessionSecret || list.getMeta('session_secret');
if (!secret) {
  secret = crypto.randomBytes(32).toString('base64url');
  list.setMeta('session_secret', secret);
}

const auth = new Auth({ passcode: config.passcode, secret, sessionDays: config.sessionDays });
const { server, close } = createApp({ config, list, auth });

server.listen(config.port, config.host, () => {
  console.log(`Frugal Shopper listening on http://${config.host}:${config.port}`);
  console.log(`Shops: ${config.stores.join(', ')}; people: ${config.people.map((p) => p.name).join(', ')}`);
  console.log(`Database: ${dbFile}`);
  if (!auth.enabled) {
    console.warn('APP_PASSCODE is not set: anyone who can reach this port can edit the list.');
  }
});

let stopping = false;
const shutdown = (signal) => {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  close()
    .then(() => {
      db.close();
      process.exit(0);
    })
    .catch((err) => {
      console.error('Error during shutdown', err);
      process.exit(1);
    });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
