import { parsePence, formatPence, formatUnitPrice, compareQuotes, savingPence } from './compare.js';
import { applyLocal } from './local-ops.js';
import { parsePastedList, splitQuantity, MAX_QUANTITY } from './paste.js';

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
  ws: null,
  connected: false,
  haveLiveState: false,
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

function describeChange(before, after) {
  if (!after.bought || before?.bought) return null;
  const who = after.bought.by;
  if (who === state.identity?.person) return null;
  return `${who} ticked off ${after.name} at ${after.bought.store} for ${formatPence(after.bought.pricePence)}`;
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

// ---- Screens --------------------------------------------------------------

function showScreen() {
  const cfg = state.config;
  const locked = cfg && cfg.authRequired && !cfg.authenticated;
  const needsSetup = cfg && !locked && !validIdentity();
  $('login').hidden = !locked;
  $('setup').hidden = !needsSetup;
  $('app').hidden = !cfg || locked || needsSetup;
  $('totals').hidden = $('app').hidden;
  $('whoami').hidden = !cfg || locked || !validIdentity();
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
    state.identity = { person, store };
    storage.set('fs.identity', state.identity);
    identify();
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

function quantityStepper(item) {
  const change = (delta) => {
    const quantity = item.quantity + delta;
    if (quantity < 1 || quantity > MAX_QUANTITY) return;
    submit({ kind: 'quantity', id: item.id, quantity });
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
        disabled: item.quantity <= 1,
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
        disabled: item.quantity >= MAX_QUANTITY,
        onclick: () => change(1),
      },
      '+',
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
        h('span', { class: 'name' }, item.quantity > 1 ? `${item.quantity} × ${item.name}` : item.name),
        item.note ? h('span', { class: 'note' }, item.note) : null,
      ),
      bought ? null : quantityStepper(item),
    ),
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
  $('todo').replaceChildren(...shown.map(itemRow));
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
  $('buy-item').textContent = qty > 1 ? `${qty} × ${item.name}` : item.name;
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
  const { items, skipped, truncated } = pasteResult();
  const parts = [items.length === 1 ? '1 item to add' : `${items.length} items to add`];
  if (skipped) parts.push(`${skipped} already on the list`);
  if (truncated) parts.push('only the first 200 lines are used');
  $('paste-preview').textContent = parts.join(' · ');
  $('paste-add').disabled = items.length === 0;
  $('paste-add').textContent = items.length ? `Add ${items.length}` : 'Add';
}

function openPaste(text) {
  $('paste-text').value = text;
  updatePastePreview();
  $('paste-form').onsubmit = (e) => {
    if (e.submitter?.value !== 'save') return;
    for (const { name, quantity } of pasteResult().items) {
      submit({ kind: 'add', id: newId(), name, quantity, note: '' });
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
    submit({ kind: 'edit', id: item.id, name, note: $('edit-note').value.trim() });
  };
  dialog.showModal();
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

  $('clear-bought').addEventListener('click', () => {
    const ids = viewItems()
      .filter((i) => i.bought)
      .map((i) => i.id);
    if (ids.length === 0) return;
    if (!confirm(`Remove ${ids.length} ticked item${ids.length === 1 ? '' : 's'} for everyone?`)) return;
    submit({ kind: 'clearBought', ids });
  });

  $('whoami').addEventListener('click', () => {
    // Keep the person, let them pick again (most often to switch shop).
    $('setup').hidden = false;
    $('app').hidden = true;
    $('totals').hidden = true;
    renderSetup();
  });

  // Phones suspend background tabs; reconnect as soon as the page is visible again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
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
}

start();
