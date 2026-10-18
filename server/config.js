import path from 'node:path';

export class ConfigError extends Error {}

function list(value, name) {
  const items = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (new Set(items.map((s) => s.toLowerCase())).size !== items.length) {
    throw new ConfigError(`${name} contains a duplicate entry`);
  }
  return items;
}

function int(value, name, { min, max }) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be a whole number between ${min} and ${max}`);
  }
  return n;
}

function bool(value, name) {
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(v)) return false;
  throw new ConfigError(`${name} must be true or false`);
}

/**
 * Read settings from environment variables. Throws ConfigError with a message
 * that names the variable, so a bad stack setting fails loudly at start-up.
 */
export function loadConfig(env = process.env) {
  const stores = list(env.STORES ?? 'Aldi,M&S', 'STORES');
  if (stores.length < 2 || stores.length > 4) {
    throw new ConfigError('STORES must list between 2 and 4 shops, e.g. "Aldi,M&S"');
  }

  // PEOPLE entries are "Name" or "Name:Usual shop".
  const people = list(env.PEOPLE ?? 'Cody:Aldi,Jess:M&S', 'PEOPLE').map((entry) => {
    const [name, usual] = entry.split(':').map((s) => s.trim());
    if (!name || name.length > 30) throw new ConfigError(`PEOPLE entry "${entry}" has a bad name`);
    if (usual && !stores.includes(usual)) {
      throw new ConfigError(`PEOPLE entry "${entry}" names a shop that is not in STORES`);
    }
    return { name, store: usual || null };
  });
  if (people.length < 1 || people.length > 10) {
    throw new ConfigError('PEOPLE must list between 1 and 10 people');
  }
  if (new Set(people.map((p) => p.name.toLowerCase())).size !== people.length) {
    throw new ConfigError('PEOPLE contains a duplicate name');
  }

  const passcode = env.APP_PASSCODE ?? '';
  if (passcode !== '' && passcode.length < 4) {
    throw new ConfigError('APP_PASSCODE must be at least 4 characters (or empty to disable)');
  }

  // Contact the push services can use if this server misbehaves (RFC 8292).
  const pushContact = env.PUSH_CONTACT || 'https://github.com/codylovelace/frugal-shopper';
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(pushContact)) {
    throw new ConfigError('PUSH_CONTACT must be a mailto: address or an https:// link');
  }

  return {
    port: int(env.PORT ?? 3000, 'PORT', { min: 1, max: 65535 }),
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || './data'),
    stores,
    people,
    passcode,
    sessionSecret: env.SESSION_SECRET || '',
    sessionDays: int(env.SESSION_DAYS ?? 90, 'SESSION_DAYS', { min: 1, max: 3650 }),
    trustProxy: bool(env.TRUST_PROXY ?? 'false', 'TRUST_PROXY'),
    title: (env.APP_TITLE || 'Frugal Shopper').slice(0, 40),
    pushContact,
  };
}
