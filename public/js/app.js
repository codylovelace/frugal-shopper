import { parsePence, formatPence, formatUnitPrice, compareQuotes, savingPence } from './compare.js';
import { applyLocal } from './local-ops.js';
import { parsePastedList, splitQuantity, MAX_QUANTITY } from './paste.js';
import { nameKey, looksLikeSameItem } from './match.js';
import * as notify from './notify.js';

// ---- Small helpers --------------------------------------------------------

const $ = (id) => document.getElementById(id);

/** Create an element. Text is always set with textContent, never as HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Random url-safe id. Works on plain http too, unlike crypto.randomUUID. */
function newId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const storage = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Private browsing or storage full: the app still works, it just forgets.
    }
  },
};

function toast(message, kind = 'info') {
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  $('toasts').append(el);
  setTimeout(() => el.classList.add('fade'), 3500);
  setTimeout(() => el.remove(), 4000);
}

// ---- State ----------------------------------------------------------------

const state = {
  config: null,
  identity: storage.get('fs.identity', null), // { person, store }
  serverItems: new Map(storage.get('fs.items', []).map((i) => [i.id, i])),
  outbox: storage.get('fs.outbox', []), // [{ opId, op }] not yet acknowledged
  online: [],
  filter: storage.get('fs.filter', 'all'),
  // null for the list, or { screen: 'trips' | 'trip' | 'item', id?, name? }.
  history: null,
  lastSeen: {}, // nameKey -> the latest past purchase of that item
  ws: null,
  connected: false,
  haveLiveState: false,
  // Phone notifications on this phone: the push endpoint when they're on.
  pushEndpoint: null,
  pushBusy: false,
};

function saveOutbox() {
  storage.set('fs.outbox', state.outbox);
}

function saveItems() {
  storage.set('fs.items', [...state.serverItems.values()]);
}

/** The list as the user should see it: server state plus their unsent changes. */
function viewItems() {
  const items = new Map([...state.serverItems].map(([id, item]) => [id, structuredClone(item)]));
  const by = state.identity?.person ?? '';
  for (const { op } of state.outbox) applyLocal(items, op, by);
  return [...items.values()].sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt);
}

// ---- Server connection ----------------------------------------------------

let reconnectDelay = 1000;
let reconnectTimer = null;
let connecting = false;

// Phones often keep a dead connection looking open (walked out of signal,
// screen locked). An app-level ping that expects a quick pong catches that.
const PING_EVERY_MS = 20000;
const PONG_TIMEOUT_MS = 8000;
let pingTimer = null;
let pongTimer = null;

function checkAlive() {
  clearTimeout(pongTimer);
  if (!sendRaw({ type: 'ping' })) return;
  const ws = state.ws;
  pongTimer = setTimeout(() => {
    // Don't wait for a close handshake that a dead link will never finish.
    ws.close();
    dropSocket(ws);
  }, PONG_TIMEOUT_MS);
}

function setConn(kind, text) {
  const el = $('conn');
  el.dataset.state = kind;
  el.textContent = text;
}

function sendRaw(message) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}

function flushOutbox() {
  if (!state.connected || !state.identity) return;
  for (const entry of state.outbox) sendRaw({ type: 'op', ...entry });
}

/** Queue a change. It shows immediately and is sent (or resent) until the server confirms it. */
function submit(op) {
  const entry = { opId: newId(), op };
  state.outbox.push(entry);
  saveOutbox();
  if (state.connected && state.identity) sendRaw({ type: 'op', ...entry });
  render();
}

function identify() {
  if (state.identity) sendRaw({ type: 'identify', ...state.identity });
}

async function fetchConfig() {
  const res = await fetch('/api/config', { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) throw new Error(`config ${res.status}`);
  return res.json();
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
}

async function connect() {
  clearTimeout(reconnectTimer);
  if (connecting) return;
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  // Check the server is up and we are still signed in before opening a socket;
  // a refused WebSocket upgrade gives the browser no reason we can read.
  connecting = true;
  try {
    state.config = await fetchConfig();
  } catch {
    setConn('offline', state.outbox.length ? `Offline · ${state.outbox.length} unsent` : 'Offline');
    scheduleReconnect();
    return;
  } finally {
    connecting = false;
  }
  if (state.config.authRequired && !state.config.authenticated) {
    setConn('offline', 'Locked');
    showScreen();
    return;
  }

  setConn('connecting', 'Connecting…');
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  state.ws = ws;

  ws.addEventListener('open', () => {
    state.connected = true;
    reconnectDelay = 1000;
    setConn('online', 'Live');
    identify();
    sendVisibility();
    clearInterval(pingTimer);
    pingTimer = setInterval(checkAlive, PING_EVERY_MS);
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleMessage(msg);
  });

  ws.addEventListener('close', () => dropSocket(ws));
}

function dropSocket(ws) {
  if (state.ws !== ws) return;
  clearInterval(pingTimer);
  clearTimeout(pongTimer);
  state.ws = null;
  state.connected = false;
  state.online = [];
  setConn('offline', 'Offline');
  render();
  scheduleReconnect();
}

// "3 × 500g oats", or just the name for one.
const withQuantity = (item, qty = item.quantity) => (qty > 1 ? `${qty} × ${item.name}` : item.name);

function describeChange(before, after) {
  if (!after.bought || before?.bought) return null;
  const who = after.bought.by;
  if (who === state.identity?.person) return null;
  return `${who} ticked off ${withQuantity(after)} at ${after.bought.store} for ${formatPence(after.bought.pricePence)}`;
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'state':
      state.serverItems = new Map(msg.items.map((i) => [i.id, i]));
      state.online = msg.online || [];
      state.haveLiveState = true;
      saveItems();
      // Resend anything the server has not confirmed. It ignores ones it already applied.
      flushOutbox();
      render();
      loadLastSeen();
      syncPush();
      break;
    case 'history':
      if (msg.finished && msg.by !== state.identity?.person) {
        toast(
          `${msg.by} finished the shop: ${msg.finished.count} item${msg.finished.count === 1 ? '' : 's'} saved to History`,
        );
      }
      loadLastSeen();
      if (state.history) renderHistory();
      break;
    case 'changes': {
      for (const item of msg.items) {
        const note = describeChange(state.serverItems.get(item.id), item);
        if (note) {
          toast(note);
          navigator.vibrate?.(60);
        }
        state.serverItems.set(item.id, item);
      }
      for (const id of msg.deleted) state.serverItems.delete(id);
      saveItems();
      render();
      break;
    }
    case 'ack':
      state.outbox = state.outbox.filter((e) => e.opId !== msg.opId);
      saveOutbox();
      render();
      break;
    case 'nack':
      state.outbox = state.outbox.filter((e) => e.opId !== msg.opId);
      saveOutbox();
      toast(`Not saved: ${msg.error}`, 'error');
      render();
      break;
    case 'pong':
      clearTimeout(pongTimer);
      break;
    case 'presence':
      state.online = msg.online || [];
      renderPresence();
      break;
    case 'error':
      toast(msg.error, 'error');
      break;
  }
}

// ---- Phone notifications --------------------------------------------------

const otherPeople = () =>
  (state.config?.people ?? []).map((p) => p.name).filter((n) => n !== state.identity?.person);
const othersText = () => otherPeople().join(' or ') || 'someone';

// Tells the server whether the app is on screen, so it can skip the
// notification for a phone that already shows the in-app pop-up.
function sendVisibility() {
  sendRaw({
    type: 'visibility',
    visible: document.visibilityState === 'visible',
    endpoint: state.pushEndpoint,
  });
}

let pushSynced = false;
async function syncPush() {
  if (pushSynced || !validIdentity()) return;
  pushSynced = true;
  try {
    state.pushEndpoint = await notify.resync(state.identity.person);
  } catch {
    state.pushEndpoint = null;
  }
  sendVisibility();
  renderNotify();
}

async function setNotifications(on) {
  state.pushBusy = true;
  $('notify-error').textContent = '';
  renderNotify();
  try {
    if (on) {
      state.pushEndpoint = await notify.enable(state.identity.person);
      toast(`Notifications on. You'll hear when ${othersText()} ticks something off.`);
    } else {
      await notify.disable();
      state.pushEndpoint = null;
    }
  } catch (err) {
    $('notify-error').textContent = err.message;
    if (!on) state.pushEndpoint = null;
    if (on) toast(`Couldn't turn on notifications: ${err.message}`, 'error');
  } finally {
    state.pushBusy = false;
    storage.set('fs.notifyAsked', true);
    sendVisibility();
    renderNotify();
  }
}

const NOTIFY_HELP = {
  insecure:
    'Phone notifications need the site opened on an https:// address, e.g. through a reverse proxy or tunnel. The pop-ups inside the app still work.',
  'ios-install':
    'On iPhone, notifications only work from the Home Screen: tap Share, then Add to Home Screen, and open it from there.',
  unsupported: "This browser can't show notifications.",
  denied:
    'Notifications are blocked for this site. Allow them for this site in the browser or phone settings, then reload.',
};

function renderNotify() {
  const status = notify.support();
  const on = Boolean(state.pushEndpoint);
  const who = othersText();

  // Settings, under the shop picker.
  $('notify-settings').hidden = !validIdentity();
  if (status !== 'ok') {
    $('notify-status').textContent = NOTIFY_HELP[status];
  } else {
    $('notify-status').textContent = on
      ? `On: this phone gets a notification when ${who} ticks something off or finishes the shop, even with the screen locked.`
      : `Off: get a notification on this phone when ${who} ticks something off.`;
  }
  $('notify-toggle').hidden = status !== 'ok';
  $('notify-toggle').textContent = on ? 'Turn off' : 'Turn on';
  $('notify-toggle').disabled = state.pushBusy;
  $('notify-test').hidden = status !== 'ok' || !on;

  // One-off suggestion at the top of the list.
  const asked = storage.get('fs.notifyAsked', false);
  const offer = !asked && !on && otherPeople().length > 0 && (status === 'ok' || status === 'ios-install');
  $('notify-banner').hidden = !offer;
  if (offer) {
    $('notify-banner-text').textContent =
      status === 'ok'
        ? `Get a notification on this phone when ${who} ticks something off, even with the screen locked?`
        : `To get a notification when ${who} ticks something off, add this to your Home Screen: tap Share, then Add to Home Screen, and open it from there.`;
    $('notify-banner-on').hidden = status !== 'ok';
    $('notify-banner-on').disabled = state.pushBusy;
    $('notify-banner-later').textContent = status === 'ok' ? 'Not now' : 'OK';
  }
}

// ---- Screens --------------------------------------------------------------

function showScreen() {
  const cfg = state.config;
  const locked = cfg && cfg.authRequired && !cfg.authenticated;
  const needsSetup = cfg && !locked && !validIdentity();
  $('login').hidden = !locked;
  $('setup').hidden = !needsSetup;
  const inHistory = Boolean(state.history) && !locked && !needsSetup;
  $('app').hidden = !cfg || locked || needsSetup || inHistory;
  $('history').hidden = !inHistory;
  $('totals').hidden = $('app').hidden;
  $('whoami').hidden = !cfg || locked || !validIdentity();
  $('history-open').hidden = $('whoami').hidden || inHistory;
  if (inHistory) renderHistory();
  renderNotify();
  if (locked) $('passcode').focus();
  if (needsSetup) renderSetup();
  if (!$('app').hidden) render();
}

function validIdentity() {
  const cfg = state.config;
  const id = state.identity;
  return Boolean(cfg && id && cfg.people.some((p) => p.name === id.person) && cfg.stores.includes(id.store));
}

function renderSetup() {
  const cfg = state.config;
  let person = state.identity?.person ?? null;
  let store = state.identity?.store ?? null;
  const done = $('setup-done');
  const refresh = () => {
    for (const b of $('people').children) b.setAttribute('aria-pressed', String(b.dataset.value === person));
    for (const b of $('stores').children) b.setAttribute('aria-pressed', String(b.dataset.value === store));
    done.disabled = !(person && store);
  };
  $('people').replaceChildren(
    ...cfg.people.map((p) =>
      h(
        'button',
        {
          type: 'button',
          class: 'choice',
          dataset: { value: p.name },
          onclick: () => {
            person = p.name;
            // Pre-select the shop this person usually goes to.
            if (p.store) store = p.store;
            refresh();
          },
        },
        p.name,
      ),
    ),
  );
  $('stores').replaceChildren(
    ...cfg.stores.map((s) =>
      h(
        'button',
        {
          type: 'button',
          class: 'choice',
          dataset: { value: s },
          onclick: () => {
            store = s;
            refresh();
          },
        },
        s,
      ),
    ),
  );
  done.onclick = () => {
    const changedPerson = state.identity?.person !== person;
    state.identity = { person, store };
    storage.set('fs.identity', state.identity);
    identify();
    if (changedPerson) {
      // Notifications follow the person using this phone.
      pushSynced = false;
      syncPush();
    }
    flushOutbox();
    showScreen();
  };
  refresh();
}

// ---- Rendering ------------------------------------------------------------

function renderPresence() {
  const me = state.identity;
  $('whoami').textContent = me ? `${me.person} @ ${me.store}` : '';
  const others = new Map();
  for (const o of state.online) {
    if (o.person !== me?.person) others.set(o.person, o.store);
  }
  $('online').textContent = others.size
    ? [...others].map(([p, s]) => `${p} @ ${s} online`).join(' · ')
    : state.connected
      ? 'Nobody else online'
      : '';
}

function quoteCell(item, store, cmp) {
  const q = item.quotes[store];
  const mine = store === state.identity.store;
  const cheapest = cmp.cheapest.includes(store);
  const hasPrice = q && Number.isInteger(q.pricePence);
  const unit = hasPrice ? formatUnitPrice(q.pricePence, q.size) : '';
  return h(
    'button',
    {
      type: 'button',
      class: `quote${mine ? ' mine' : ''}${cheapest ? ' cheapest' : ''}${hasPrice ? '' : ' no-price'}`,
      disabled: Boolean(item.bought),
      'aria-label': `${store} price for ${item.name}: ${hasPrice ? formatPence(q.pricePence) : 'none yet'}`,
      onclick: () => openQuote(item, store),
    },
    h('span', { class: 'quote-store' }, store),
    h('span', { class: 'quote-price' }, hasPrice ? formatPence(q.pricePence) : mine ? 'Add price' : '—'),
    q && q.size ? h('span', { class: 'quote-size' }, q.size) : null,
    unit ? h('span', { class: 'quote-unit' }, unit) : null,
    hasPrice && item.quantity > 1
      ? h(
          'span',
          { class: 'quote-line' },
          `× ${item.quantity} = ${formatPence(q.pricePence * item.quantity)}`,
        )
      : null,
    cheapest ? h('span', { class: 'badge' }, cmp.cheapest.length > 1 ? 'Same' : 'Cheapest') : null,
  );
}

const needers = (item) => Object.keys(item.needs || {});
const possessive = (name) => (name === state.identity.person ? 'My list' : `${name}'s list`);

/**
 * Whose share the row's − / + changes: on a one-person list that person's,
 * on "Both need" your own (taking yours to 0 moves it to the other list).
 */
function stepperPerson(item) {
  const people = needers(item);
  return people.length === 1 ? people[0] : state.identity.person;
}

function quantityStepper(item) {
  const who = stepperPerson(item);
  const mine = item.needs[who] || 0;
  const othersNeed = item.quantity - mine > 0;
  const change = (delta) => {
    const quantity = mine + delta;
    if (quantity < (othersNeed ? 0 : 1) || quantity > MAX_QUANTITY) return;
    submit({ kind: 'quantity', id: item.id, person: who, quantity });
  };
  return h(
    'div',
    { class: 'stepper', role: 'group', 'aria-label': `Quantity of ${item.name}` },
    h(
      'button',
      {
        type: 'button',
        class: 'step',
        'aria-label': `One fewer ${item.name}`,
        disabled: mine <= (othersNeed ? 0 : 1),
        onclick: () => change(-1),
      },
      '−',
    ),
    h('span', { class: 'qty', 'aria-live': 'polite' }, String(item.quantity)),
    h(
      'button',
      {
        type: 'button',
        class: 'step',
        'aria-label': `One more ${item.name}`,
        disabled: mine >= MAX_QUANTITY,
        onclick: () => change(1),
      },
      '+',
    ),
  );
}

/** Open items that look like this one and haven't been marked as different. */
function lookAlikes(item, open) {
  const key = nameKey(item.name);
  return open.filter(
    (o) =>
      o.id !== item.id &&
      !item.keepSeparate?.includes(o.id) &&
      (nameKey(o.name) === key || looksLikeSameItem(item.name, o.name)),
  );
}

// Filled in by render() so each suggestion is shown once, on the newer item.
let suggestions = new Map();

function mergeSuggestion(item) {
  const other = suggestions.get(item.id);
  if (!other) return null;
  const owner = needers(other);
  const whose = owner.length === 1 ? `${owner[0] === state.identity.person ? 'your' : `${owner[0]}'s`} ` : '';
  return h(
    'div',
    { class: 'suggest' },
    h('span', {}, `Same as ${whose}“${other.name}”?`),
    h(
      'button',
      {
        type: 'button',
        class: 'suggest-yes',
        onclick: () => submit({ kind: 'merge', id: item.id, intoId: other.id }),
      },
      'Combine',
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'suggest-no',
        onclick: () => submit({ kind: 'keepSeparate', id: item.id, otherId: other.id }),
      },
      'Keep separate',
    ),
  );
}

function itemRow(item) {
  const stores = state.config.stores;
  const cmp = compareQuotes(item.quotes);
  const pending = state.outbox.some((e) => e.op.id === item.id);
  const bought = item.bought;

  const check = h('button', {
    type: 'button',
    class: `check${bought ? ' checked' : ''}`,
    'aria-label': bought ? `Untick ${item.name}` : `Tick off ${item.name}`,
    'aria-pressed': String(Boolean(bought)),
    onclick: () => (bought ? untick(item) : openBuy(item)),
  });

  let detail = null;
  if (bought) {
    const saving = savingPence(item);
    detail = h(
      'p',
      { class: 'bought-line' },
      `${formatPence(bought.pricePence)}${item.quantity > 1 ? ` for ${item.quantity}` : ''} at ${bought.store} · ${bought.by}`,
      saving === null
        ? null
        : saving > 0
          ? h('span', { class: 'saved' }, ` · saved ${formatPence(saving)}`)
          : saving < 0
            ? h('span', { class: 'lost' }, ` · ${formatPence(-saving)} more than elsewhere`)
            : null,
    );
  }

  const people = needers(item);
  const split =
    people.length > 1
      ? h('span', { class: 'needs-line' }, people.map((p) => `${p} ${item.needs[p]}`).join(' · '))
      : null;

  const warn =
    !bought && cmp.basis === 'price' && !cmp.comparable
      ? h('p', { class: 'warn' }, 'Pack sizes differ, add sizes like 750g to compare fairly')
      : null;

  return h(
    'li',
    { class: `item${bought ? ' is-bought' : ''}${pending ? ' pending' : ''}`, dataset: { id: item.id } },
    h(
      'div',
      { class: 'item-head' },
      check,
      h(
        'button',
        { type: 'button', class: 'item-name', onclick: () => openEdit(item) },
        h('span', { class: 'name' }, withQuantity(item)),
        item.note ? h('span', { class: 'note' }, item.note) : null,
        split,
      ),
      bought ? null : quantityStepper(item),
    ),
    bought ? null : mergeSuggestion(item),
    bought ? null : lastTimeLine(item),
    bought
      ? detail
      : h(
          'div',
          { class: 'quotes' },
          stores.map((s) => quoteCell(item, s, cmp)),
        ),
    warn,
  );
}

function matchesFilter(item) {
  if (state.filter === 'all') return true;
  const myStore = state.identity.store;
  if (state.filter === 'needs-price') {
    const q = item.quotes[myStore];
    return !(q && Number.isInteger(q.pricePence));
  }
  if (state.filter === 'cheapest-here') {
    return compareQuotes(item.quotes).cheapest.includes(myStore);
  }
  return true;
}

function renderTotals(items) {
  const stores = state.config.stores;
  const spent = Object.fromEntries(stores.map((s) => [s, { total: 0, count: 0 }]));
  let saved = 0;
  let total = 0;
  let toBuy = 0;
  for (const item of items) {
    if (!item.bought) {
      toBuy += 1;
      continue;
    }
    const s = spent[item.bought.store];
    if (s) {
      s.total += item.bought.pricePence;
      s.count += 1;
    }
    total += item.bought.pricePence;
    const saving = savingPence(item);
    if (saving) saved += saving;
  }
  $('totals').replaceChildren(
    ...stores.map((s) =>
      h(
        'div',
        { class: 'total' },
        h('span', { class: 'label' }, `${s} (${spent[s].count})`),
        h('strong', {}, formatPence(spent[s].total)),
      ),
    ),
    h('div', { class: 'total' }, h('span', { class: 'label' }, 'Total'), h('strong', {}, formatPence(total))),
    h(
      'div',
      { class: 'total' },
      h('span', { class: 'label' }, saved >= 0 ? 'Saved' : 'Over'),
      h('strong', { class: saved >= 0 ? 'saved' : 'lost' }, formatPence(Math.abs(saved))),
    ),
    h('div', { class: 'total' }, h('span', { class: 'label' }, 'Left'), h('strong', {}, String(toBuy))),
  );
}

function render() {
  renderPresence();
  if (!state.connected && $('conn').dataset.state === 'offline') {
    const n = state.outbox.length;
    setConn('offline', n ? `Offline · ${n} unsent` : 'Offline');
  }
  if (!state.config || !validIdentity() || $('app').hidden) return;

  for (const b of document.querySelectorAll('.filter')) {
    b.setAttribute('aria-pressed', String(b.dataset.filter === state.filter));
  }

  const items = viewItems();
  const todo = items.filter((i) => !i.bought);
  const basket = items.filter((i) => i.bought).sort((a, b) => b.bought.at - a.bought.at);
  const shown = todo.filter(matchesFilter);

  suggestions = new Map();
  for (const item of todo) {
    // Suggest on the newer of the two, pointing at the older one.
    const older = lookAlikes(item, todo).filter((o) => o.sort < item.sort);
    if (older.length) suggestions.set(item.id, older[0]);
  }

  $('app').style.setProperty('--cols', state.config.stores.length);
  $('store-header').replaceChildren(
    ...state.config.stores.map((s) =>
      h(
        'span',
        { class: s === state.identity.store ? 'mine' : '' },
        s === state.identity.store ? `${s} (you)` : s,
      ),
    ),
  );
  // Sections: "Both need" first, then your list, then everyone else's.
  const people = [
    state.identity.person,
    ...state.config.people.map((p) => p.name).filter((n) => n !== state.identity.person),
  ];
  const sections = [{ title: 'Both need', items: shown.filter((i) => needers(i).length > 1) }];
  for (const person of people) {
    sections.push({
      title: possessive(person),
      items: shown.filter((i) => needers(i).length === 1 && needers(i)[0] === person),
    });
  }
  // Items for someone no longer in PEOPLE still need a home.
  const placed = new Set(sections.flatMap((sec) => sec.items.map((i) => i.id)));
  const rest = shown.filter((i) => !placed.has(i.id));
  if (rest.length) sections.push({ title: 'Other', items: rest });
  $('todo').replaceChildren(
    ...sections
      .filter((sec) => sec.items.length)
      .map((sec) =>
        h(
          'section',
          { class: 'list-section' },
          h(
            'h2',
            { class: 'section-title' },
            sec.title,
            h('span', { class: 'count' }, ` ${sec.items.length}`),
          ),
          h('ul', { class: 'items' }, sec.items.map(itemRow)),
        ),
      ),
  );
  $('basket').replaceChildren(...basket.map(itemRow));
  $('basket-section').hidden = basket.length === 0;

  const empty = $('empty');
  if (todo.length === 0) {
    empty.hidden = false;
    empty.textContent = basket.length
      ? 'Everything is ticked off. Nice work.'
      : 'The list is empty. Add the first item above.';
  } else if (shown.length === 0) {
    empty.hidden = false;
    empty.textContent = 'Nothing matches this filter.';
  } else {
    empty.hidden = true;
  }

  renderTotals(items);
}

// ---- Dialogs ----------------------------------------------------------------

function openQuote(item, store) {
  const dialog = $('quote-dialog');
  const q = item.quotes[store];
  $('quote-title').textContent = `${store} price`;
  $('quote-item').textContent = item.name;
  $('quote-price').value = q && Number.isInteger(q.pricePence) ? (q.pricePence / 100).toFixed(2) : '';
  $('quote-size').value = q?.size ?? '';
  // Suggest the size the other shop used, since it's usually the same pack.
  const otherSize = Object.values(item.quotes).find((x) => x.size)?.size;
  $('quote-size').placeholder = otherSize || '750g, 1kg, 4 x 330ml, 6';
  $('quote-error').textContent = '';
  $('quote-clear').hidden = !q;
  dialog.onclose = null;
  $('quote-form').onsubmit = (e) => {
    const action = e.submitter?.value;
    if (action === 'cancel') return;
    if (action === 'clear') {
      submit({ kind: 'quote', id: item.id, store, pricePence: null, size: '' });
      return;
    }
    const pricePence = parsePence($('quote-price').value);
    if (Number.isNaN(pricePence)) {
      e.preventDefault();
      $('quote-error').textContent = 'Enter a price like 7.25';
      return;
    }
    const size = $('quote-size').value.trim();
    submit({ kind: 'quote', id: item.id, store, pricePence, size });
  };
  dialog.showModal();
  $('quote-price').focus();
}

function openBuy(item) {
  const dialog = $('buy-dialog');
  const stores = state.config.stores;
  let chosen = state.identity.store;
  const qty = item.quantity;
  $('buy-item').textContent = withQuantity(item, qty);
  $('buy-price-label').textContent = qty > 1 ? `Price paid for all ${qty} (£)` : 'Price paid (£)';
  $('buy-error').textContent = '';

  // The quote is per pack, so pre-fill the total for the whole quantity.
  const fillPrice = () => {
    const q = item.quotes[chosen];
    $('buy-price').value = q && Number.isInteger(q.pricePence) ? ((q.pricePence * qty) / 100).toFixed(2) : '';
  };
  const refresh = () => {
    for (const b of $('buy-stores').children)
      b.setAttribute('aria-pressed', String(b.dataset.value === chosen));
  };
  $('buy-stores').replaceChildren(
    ...stores.map((s) =>
      h(
        'button',
        {
          type: 'button',
          class: 'choice',
          dataset: { value: s },
          onclick: () => {
            chosen = s;
            refresh();
            fillPrice();
          },
        },
        s,
      ),
    ),
  );
  refresh();
  fillPrice();

  $('buy-form').onsubmit = (e) => {
    if (e.submitter?.value !== 'save') return;
    const pricePence = parsePence($('buy-price').value);
    if (pricePence === null || Number.isNaN(pricePence)) {
      e.preventDefault();
      $('buy-error').textContent = 'Enter the price you paid, like 7.25';
      return;
    }
    submit({ kind: 'buy', id: item.id, store: chosen, pricePence });
    navigator.vibrate?.(30);
  };
  dialog.showModal();
  $('buy-price').focus();
  $('buy-price').select();
}

function pasteResult() {
  const onList = viewItems()
    .filter((i) => !i.bought)
    .map((i) => i.name);
  return parsePastedList($('paste-text').value, onList);
}

function updatePastePreview() {
  const { items, merging, truncated } = pasteResult();
  const parts = [items.length === 1 ? '1 item to add' : `${items.length} items to add`];
  if (merging) parts.push(`${merging} already on the list, quantities will be added`);
  if (truncated) parts.push('only the first 200 lines are used');
  $('paste-preview').textContent = parts.join(' · ');
  $('paste-add').disabled = items.length === 0;
  $('paste-add').textContent = items.length ? `Add ${items.length}` : 'Add';
}

function openPaste(text) {
  $('paste-text').value = text;
  let forPerson = state.identity.person;
  const refresh = () => {
    for (const b of $('paste-for').children)
      b.setAttribute('aria-pressed', String(b.dataset.value === forPerson));
  };
  $('paste-for').replaceChildren(
    ...state.config.people.map((p) =>
      h(
        'button',
        {
          type: 'button',
          class: 'choice',
          dataset: { value: p.name },
          onclick: () => {
            forPerson = p.name;
            refresh();
          },
        },
        p.name === state.identity.person ? `Mine (${p.name})` : p.name,
      ),
    ),
  );
  refresh();
  updatePastePreview();
  $('paste-form').onsubmit = (e) => {
    if (e.submitter?.value !== 'save') return;
    for (const { name, quantity } of pasteResult().items) {
      submit({ kind: 'add', id: newId(), name, quantity, for: forPerson, note: '' });
    }
  };
  $('paste-dialog').showModal();
  if (!text) $('paste-text').focus();
}

function untick(item) {
  if (!confirm(`Put "${item.name}" back on the list?`)) return;
  submit({ kind: 'unbuy', id: item.id });
}

function openEdit(item) {
  const dialog = $('edit-dialog');
  $('edit-name').value = item.name;
  $('edit-note').value = item.note;
  $('edit-error').textContent = '';
  const needs = { ...item.needs };
  const renderNeeds = () => {
    $('edit-needs').replaceChildren(
      ...state.config.people.map((p) => {
        const n = needs[p.name] || 0;
        const step = (delta) => {
          needs[p.name] = Math.max(0, Math.min(MAX_QUANTITY, n + delta));
          renderNeeds();
        };
        return h(
          'div',
          { class: 'needs-row' },
          h('span', { class: 'needs-name' }, p.name),
          h(
            'div',
            { class: 'stepper' },
            h(
              'button',
              {
                type: 'button',
                class: 'step',
                'aria-label': `${p.name} needs one fewer`,
                disabled: n === 0,
                onclick: () => step(-1),
              },
              '−',
            ),
            h('span', { class: 'qty' }, String(n)),
            h(
              'button',
              {
                type: 'button',
                class: 'step',
                'aria-label': `${p.name} needs one more`,
                disabled: n >= MAX_QUANTITY,
                onclick: () => step(1),
              },
              '+',
            ),
          ),
        );
      }),
    );
  };
  renderNeeds();
  $('edit-form').onsubmit = (e) => {
    const action = e.submitter?.value;
    if (action === 'cancel') return;
    if (action === 'delete') {
      if (!confirm(`Delete "${item.name}" for everyone?`)) {
        e.preventDefault();
        return;
      }
      submit({ kind: 'delete', id: item.id });
      return;
    }
    const name = $('edit-name').value.trim();
    if (!name) {
      e.preventDefault();
      $('edit-error').textContent = 'The item needs a name';
      return;
    }
    if (Object.values(needs).every((n) => n === 0)) {
      e.preventDefault();
      $('edit-error').textContent = 'Someone needs to need it, or delete the item';
      return;
    }
    if (name !== item.name || $('edit-note').value.trim() !== item.note) {
      submit({ kind: 'edit', id: item.id, name, note: $('edit-note').value.trim() });
    }
    // Raise shares before lowering any, so the item never has nobody needing it.
    const changes = state.config.people
      .map((p) => [p.name, needs[p.name] || 0, item.needs[p.name] || 0])
      .filter(([, now, before]) => now !== before)
      .sort((a, b) => b[1] - b[2] - (a[1] - a[2]));
    for (const [person, quantity] of changes) submit({ kind: 'quantity', id: item.id, person, quantity });
  };
  dialog.showModal();
}

// ---- History ----------------------------------------------------------------

const dateFmt = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const shortDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

async function getJson(path) {
  const res = await fetch(path, { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

async function loadLastSeen() {
  try {
    state.lastSeen = (await getJson('/api/last-seen')).items;
    render();
  } catch {
    // Offline: keep whatever we had.
  }
}

function quoteSummary(entry) {
  return state.config.stores
    .map((s) => {
      const q = entry.quotes[s];
      return q && Number.isInteger(q.pricePence) ? `${s} ${formatPence(q.pricePence)}` : null;
    })
    .filter(Boolean)
    .join(' · ');
}

/** "Last time (11 Oct): Aldi £0.89 · M&S £1.50, bought at Aldi", tap for the full history. */
function lastTimeLine(item) {
  const last = state.lastSeen[nameKey(item.name)];
  if (!last) return null;
  const prices = quoteSummary(last);
  return h(
    'button',
    {
      type: 'button',
      class: 'last-time',
      onclick: () => openHistory({ screen: 'item', name: item.name, from: null }),
    },
    `Last time (${shortDate.format(last.finishedAt)}): ${prices || 'no prices'}, bought at ${last.bought.store}`,
  );
}

function openHistory(view) {
  state.history = view;
  showScreen();
  window.scrollTo(0, 0);
}

let historyRequest = 0;

async function renderHistory() {
  const view = state.history;
  if (!view) return;
  const body = $('history-body');
  const request = ++historyRequest;
  const show = (title, ...children) => {
    if (request !== historyRequest) return; // a newer screen was opened meanwhile
    $('history-title').textContent = title;
    body.replaceChildren(...children);
  };
  try {
    if (view.screen === 'trips') {
      const { trips } = await getJson('/api/history');
      show(
        'History',
        trips.length
          ? h(
              'ul',
              { class: 'items' },
              trips.map((t) =>
                h(
                  'li',
                  {},
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'item trip-row',
                      onclick: () => openHistory({ screen: 'trip', id: t.id }),
                    },
                    h('span', { class: 'name' }, dateFmt.format(t.finishedAt)),
                    h(
                      'span',
                      { class: 'note' },
                      [
                        `${t.itemCount} item${t.itemCount === 1 ? '' : 's'}`,
                        ...state.config.stores
                          .filter((s) => t.spent[s])
                          .map((s) => `${s} ${formatPence(t.spent[s])}`),
                      ].join(' · '),
                    ),
                  ),
                ),
              ),
            )
          : h(
              'p',
              { class: 'empty-list' },
              'No finished shops yet. Press "Finish this shop" when you are done.',
            ),
      );
    } else if (view.screen === 'trip') {
      const trip = await getJson(`/api/history/${view.id}`);
      let total = 0;
      let saved = 0;
      for (const i of trip.items) {
        total += i.bought.pricePence;
        saved += savingPence(i) || 0;
      }
      show(
        dateFmt.format(trip.finishedAt),
        h(
          'p',
          { class: 'muted' },
          `Finished by ${trip.finishedBy} · spent ${formatPence(total)} · saved ${formatPence(saved)}`,
        ),
        h(
          'ul',
          { class: 'items' },
          trip.items.map((i) => {
            const people = Object.keys(i.needs);
            return h(
              'li',
              { class: 'item' },
              h(
                'button',
                {
                  type: 'button',
                  class: 'item-name',
                  onclick: () => openHistory({ screen: 'item', name: i.name, from: view }),
                },
                h('span', { class: 'name' }, withQuantity(i)),
                h(
                  'span',
                  { class: 'note' },
                  `${formatPence(i.bought.pricePence)} at ${i.bought.store} · ${people.length > 1 ? 'Both' : people[0] || ''}`,
                ),
                quoteSummary(i) ? h('span', { class: 'note' }, `Prices: ${quoteSummary(i)}`) : null,
              ),
            );
          }),
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'danger-link',
            onclick: () => {
              if (!confirm('Delete this shop from History for everyone?')) return;
              submit({ kind: 'deleteTrip', tripId: trip.id });
              openHistory({ screen: 'trips' });
            },
          },
          'Delete this shop from History',
        ),
      );
    } else if (view.screen === 'item') {
      const { entries } = await getJson(`/api/history/item?name=${encodeURIComponent(view.name)}`);
      const stores = state.config.stores;
      const wins = Object.fromEntries(stores.map((s) => [s, 0]));
      for (const e of entries) {
        for (const s of compareQuotes(e.quotes).cheapest) wins[s] += 1;
      }
      const compared = entries.filter((e) => compareQuotes(e.quotes).cheapest.length).length;
      show(
        view.name,
        h(
          'p',
          { class: 'muted' },
          compared
            ? `Cheapest: ${stores.map((s) => `${s} ${wins[s]} of ${compared}`).join(' · ')}`
            : 'No shop with prices from both stores yet.',
        ),
        entries.length
          ? h(
              'table',
              { class: 'history-table' },
              h(
                'thead',
                {},
                h(
                  'tr',
                  {},
                  h('th', {}, 'Date'),
                  stores.map((s) => h('th', {}, s)),
                ),
              ),
              h(
                'tbody',
                {},
                entries.map((e) => {
                  const cheapest = compareQuotes(e.quotes).cheapest;
                  return h(
                    'tr',
                    {},
                    h('td', {}, shortDate.format(e.finishedAt)),
                    stores.map((s) => {
                      const q = e.quotes[s];
                      const price = q && Number.isInteger(q.pricePence) ? formatPence(q.pricePence) : '—';
                      return h(
                        'td',
                        { class: cheapest.includes(s) ? 'cheapest-cell' : '' },
                        price,
                        q?.size ? h('span', { class: 'quote-size' }, ` ${q.size}`) : null,
                        e.bought.store === s
                          ? h('span', { class: 'bought-mark', title: 'Bought here' }, ' ✓')
                          : null,
                      );
                    }),
                  );
                }),
              ),
            )
          : h('p', { class: 'empty-list' }, 'Not bought in a finished shop yet.'),
      );
    }
  } catch {
    show(
      'History',
      h('p', { class: 'empty-list' }, 'History needs a connection. Try again when you have signal.'),
    );
  }
}

// ---- Wiring -----------------------------------------------------------------

function wire() {
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('login-error').textContent = '';
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ passcode: $('passcode').value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        $('login-error').textContent = body.error || 'Could not sign in';
        return;
      }
      $('passcode').value = '';
      connect().then(showScreen);
    } catch {
      $('login-error').textContent = 'Could not reach the server';
    }
  });

  $('add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('add-name');
    const text = input.value.trim();
    if (!text) return;
    const { name, quantity } = splitQuantity(text);
    submit({ kind: 'add', id: newId(), name, quantity, note: '' });
    input.value = '';
    input.focus();
  });

  // Pasting several lines into the add box opens the paste dialog instead of
  // squashing the whole list into one item.
  $('add-name').addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!/[\r\n]/.test(text.trim())) return;
    e.preventDefault();
    openPaste(text);
  });
  $('paste-open').addEventListener('click', () => openPaste(''));
  $('paste-text').addEventListener('input', updatePastePreview);

  for (const b of document.querySelectorAll('.filter')) {
    b.addEventListener('click', () => {
      state.filter = b.dataset.filter;
      storage.set('fs.filter', state.filter);
      render();
    });
  }

  $('finish-shop').addEventListener('click', () => {
    const ids = viewItems()
      .filter((i) => i.bought)
      .map((i) => i.id);
    if (ids.length === 0) return;
    const what = `${ids.length} ticked item${ids.length === 1 ? '' : 's'}`;
    if (!confirm(`Save ${what} to History as today's shop and clear them for everyone?`)) return;
    submit({ kind: 'finishTrip', ids });
  });

  $('history-open').addEventListener('click', () => openHistory({ screen: 'trips' }));
  $('history-back').addEventListener('click', () => {
    const v = state.history;
    // Item history opened from the list goes straight back to the list.
    if (v && 'from' in v) openHistory(v.from);
    else openHistory(v?.screen === 'trips' ? null : { screen: 'trips' });
  });

  $('whoami').addEventListener('click', () => {
    // Keep the person, let them pick again (most often to switch shop).
    $('setup').hidden = false;
    $('app').hidden = true;
    $('totals').hidden = true;
    renderSetup();
  });

  $('notify-toggle').addEventListener('click', () => setNotifications(!state.pushEndpoint));
  $('notify-banner-on').addEventListener('click', () => setNotifications(true));
  $('notify-banner-later').addEventListener('click', () => {
    storage.set('fs.notifyAsked', true);
    renderNotify();
  });
  $('notify-test').addEventListener('click', async () => {
    $('notify-error').textContent = '';
    try {
      await notify.sendTest(state.pushEndpoint);
      toast('Test notification sent.');
    } catch (err) {
      $('notify-error').textContent = err.message;
    }
  });

  // Phones suspend background tabs; reconnect as soon as the page is visible again.
  document.addEventListener('visibilitychange', () => {
    sendVisibility();
    if (document.visibilityState !== 'visible') return;
    notify.clearShown().catch(() => {});
    if (state.connected) {
      checkAlive();
    } else {
      reconnectDelay = 1000;
      connect();
    }
  });
  window.addEventListener('online', () => {
    reconnectDelay = 1000;
    connect();
  });
}

async function start() {
  wire();
  try {
    state.config = await fetchConfig();
    $('title').textContent = state.config.title;
    document.title = state.config.title;
  } catch {
    // Offline on first paint: show the last list we saw so shopping can continue.
    state.config = storage.get('fs.config', null);
    if (state.config) toast('Offline, showing the last saved list', 'error');
  }
  // Remember the settings for offline start-up, but only once we are allowed in.
  if (state.config && (!state.config.authRequired || state.config.authenticated)) {
    storage.set('fs.config', state.config);
  }
  showScreen();
  connect();
  notify
    .register()
    .then(() => notify.clearShown())
    .catch(() => {});
}

start();
