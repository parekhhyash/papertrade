// Replica server for the PaperTrade cluster.
//
// Every replica holds a full copy of the trading state (cash, positions, orders)
// and an ordered, durable operation log. Exactly one replica is the PRIMARY at a
// time: it accepts orders, assigns them a sequence number and replicates the log
// entry to the BACKUPS. Backups apply entries strictly in sequence order, so all
// replicas go through the same states (state-machine replication).
//
// Usage: node backend/replica.js --id=node-1 --port=5001

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('='))
);
const ID = args.id || 'node-1';
const PORT = Number(args.port || 5001);
const DATA_DIR = path.join(__dirname, '..', 'data');
const LOG_FILE = path.join(DATA_DIR, `${ID}.json`);
const START_CASH = 100000;

// ---------------------------------------------------------------- state ----
let role = 'recovering'; // primary | backup | recovering (until the gateway assigns a role)
let term = 0; // epoch number, bumped by the gateway on every failover
let primaryUrl = null; // where a backup catches up from
let peers = []; // [{id, url}] backups the primary replicates to
let config = { mode: 'strong', lagMs: 300 };
let log = []; // applied entries, log[i].seq === i + 1
let buffer = new Map(); // seq -> entry received out of order
let waiters = []; // replicate requests waiting for a gap to be filled before acking
let ackedSeq = 0; // primary only: highest seq acknowledged to a client
let state = emptyState();
let events = [];
let eventId = 0;

function emptyState() {
  return { cash: START_CASH, positions: {}, orders: [] };
}

function event(type, msg) {
  events.push({ id: ++eventId, ts: Date.now(), node: ID, type, msg });
  if (events.length > 300) events.shift();
  console.log(`[${ID}] ${msg}`);
}

function lastSeq() {
  return log.length;
}

// Deterministic apply: same log => same state on every replica.
function apply(entry) {
  const { symbol, side, qty, price } = entry.op;
  const pos = state.positions[symbol] || { qty: 0, avgPrice: 0 };
  if (side === 'BUY') {
    const cost = qty * price;
    pos.avgPrice = (pos.avgPrice * pos.qty + cost) / (pos.qty + qty);
    pos.qty += qty;
    state.cash -= cost;
  } else {
    pos.qty -= qty;
    state.cash += qty * price;
    if (pos.qty === 0) pos.avgPrice = 0;
  }
  state.cash = round(state.cash);
  pos.avgPrice = round(pos.avgPrice);
  if (pos.qty === 0) delete state.positions[symbol];
  else state.positions[symbol] = pos;
  state.orders.push({ ...entry.op, seq: entry.seq, term: entry.term, executedBy: entry.by });
  log.push(entry);
}

// An ack means "applied", never just "received": resolve waiters whose entry is now applied.
function notifyApplied() {
  waiters = waiters.filter((w) => (w.seq <= lastSeq() ? (w.resolve(true), false) : true));
}

function rebuild(entries) {
  state = emptyState();
  log = [];
  entries.forEach(apply);
}

function round(n) {
  return Math.round(n * 100) / 100;
}

// Short fingerprint of the replica state, used to compare replicas.
function stateHash() {
  const positions = Object.keys(state.positions)
    .sort()
    .map((s) => [s, state.positions[s].qty, state.positions[s].avgPrice]);
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([lastSeq(), state.cash, positions]))
    .digest('hex')
    .slice(0, 8);
}

// ---------------------------------------------------------- persistence ----
// The log is written to disk after every change, so a replica that is killed
// and restarted recovers everything it had applied before the crash.
function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LOG_FILE, JSON.stringify({ term, log }));
}

function loadFromDisk() {
  if (!fs.existsSync(LOG_FILE)) return;
  const saved = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  term = saved.term;
  rebuild(saved.log);
  event('recover', `Restarted: replayed ${log.length} entries from disk log (term ${term})`);
}

// ------------------------------------------------------------- helpers ----
function post(url, body, timeoutMs = 2000) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Simulated network delay to one backup (with jitter so messages can reorder).
function networkDelay() {
  if (!config.lagMs) return 0;
  return Math.round(config.lagMs * (0.5 + Math.random()));
}

// ------------------------------------------------------ primary: orders ----
async function placeOrder(req) {
  const { orderId, symbol, side, price } = req;
  const qty = Number(req.qty);

  // Idempotency: a client retrying after a failover must not execute twice.
  const existing = log.find((e) => e.op.orderId === orderId);
  if (existing) {
    event('dup', `Duplicate order ${orderId} ignored (already seq ${existing.seq})`);
    return { status: 200, body: { ok: true, duplicate: true, seq: existing.seq, servedBy: ID } };
  }

  if (!['BUY', 'SELL'].includes(side) || !(qty > 0) || !(price > 0) || !symbol)
    return { status: 400, body: { ok: false, error: 'Invalid order' } };
  if (side === 'BUY' && qty * price > state.cash)
    return { status: 400, body: { ok: false, error: 'Insufficient cash' } };
  if (side === 'SELL' && (state.positions[symbol]?.qty || 0) < qty)
    return { status: 400, body: { ok: false, error: `Not enough ${symbol} shares to sell` } };

  const started = Date.now();
  const entry = {
    seq: lastSeq() + 1,
    term,
    by: ID,
    op: { orderId, symbol, side, qty, price: round(price), ts: Date.now() },
  };
  apply(entry);
  persist();

  // Number of backup acks needed before replying to the client.
  //   strong   : W = N  -> every backup must ack
  //   quorum   : W = 2  -> primary + 1 backup (majority of 3)
  //   eventual : W = 1  -> reply immediately, replicate in background
  const needed =
    config.mode === 'strong' ? peers.length : config.mode === 'quorum' ? Math.min(1, peers.length) : 0;

  const acks = [];
  const failed = [];
  const replications = peers.map((p) =>
    sleep(networkDelay())
      .then(() => post(`${p.url}/replicate`, { term, entry }, 10000))
      .then((r) => {
        if (r.status === 200) acks.push(p.id);
        else failed.push(`${p.id} (${r.body.error})`);
      })
      .catch(() => failed.push(`${p.id} (unreachable)`))
  );

  // Wait until enough backups acked (or all replication attempts finished).
  await new Promise((resolve) => {
    if (needed === 0) return resolve();
    const check = setInterval(() => {
      if (acks.length >= needed || acks.length + failed.length >= peers.length) {
        clearInterval(check);
        resolve();
      }
    }, 5);
  });

  const latency = Date.now() - started;
  ackedSeq = Math.max(ackedSeq, entry.seq);
  const label = `${side} ${qty} ${symbol} @ ${entry.op.price}`;
  if (config.mode === 'eventual') {
    event('commit', `seq ${entry.seq}: ${label} committed locally, replying before backups ack (eventual)`);
    Promise.all(replications).then(() =>
      event(
        'replicate',
        `seq ${entry.seq} reached backups later: acked by [${acks.join(', ') || '-'}]` +
          (failed.length ? `, failed [${failed.join(', ')}]` : '')
      )
    );
  } else {
    event(
      'commit',
      `seq ${entry.seq}: ${label} committed (${config.mode}) acks [${acks.join(', ') || '-'}] in ${latency} ms` +
        (failed.length ? `, no ack from [${failed.join(', ')}] -> will catch up on rejoin` : '')
    );
  }

  return {
    status: 200,
    body: {
      ok: true,
      seq: entry.seq,
      servedBy: ID,
      term,
      mode: config.mode,
      acks: [...acks],
      failed: [...failed],
      latencyMs: latency,
      order: entry.op,
    },
  };
}

// ---------------------------------------------------- backup: replicate ----
function onReplicate({ term: t, entry }) {
  // Fencing: reject anything from a primary of an older term (a stale primary).
  if (t < term) {
    event('reject', `Rejected seq ${entry.seq} from stale primary ${entry.by} (term ${t} < ${term})`);
    return { status: 409, body: { ok: false, error: `stale term ${t} < ${term}` } };
  }
  if (role === 'primary') return { status: 409, body: { ok: false, error: 'I am primary' } };

  if (entry.seq <= lastSeq()) return { status: 200, body: { ok: true, applied: lastSeq() } };

  if (entry.seq > lastSeq() + 1) {
    buffer.set(entry.seq, entry);
    event('buffer', `seq ${entry.seq} arrived out of order (have ${lastSeq()}), buffered until gap is filled`);
    // hold the ack until the entry is actually applied
    return new Promise((resolve) => {
      const w = { seq: entry.seq, resolve };
      waiters.push(w);
      setTimeout(() => waiters.includes(w) && ((waiters = waiters.filter((x) => x !== w)), resolve(false)), 9000);
    }).then((ok) =>
      ok ? { status: 200, body: { ok: true, applied: lastSeq() } } : { status: 504, body: { ok: false, error: 'gap never filled' } }
    );
  }

  apply(entry);
  // Drain any buffered entries that are now in order.
  while (buffer.has(lastSeq() + 1)) {
    const next = buffer.get(lastSeq() + 1);
    buffer.delete(next.seq);
    apply(next);
    event('apply', `Applied buffered seq ${next.seq}`);
  }
  persist();
  notifyApplied();
  event('apply', `Applied seq ${entry.seq} from ${entry.by} -> now at seq ${lastSeq()}`);
  return { status: 200, body: { ok: true, applied: lastSeq() } };
}

// Backup (re)joining: fetch the primary's log and bring ourselves in line.
async function catchUp() {
  if (!primaryUrl) return;
  try {
    const r = await fetch(`${primaryUrl}/log`, { signal: AbortSignal.timeout(3000) });
    const { entries } = await r.json();
    let i = 0;
    while (i < log.length && i < entries.length && log[i].op.orderId === entries[i].op.orderId) i++;
    if (i < log.length) {
      // We have entries the new primary never received (written by a crashed
      // primary but never replicated). They were never durable on the
      // cluster, so they are discarded and state is rebuilt from the primary.
      const lost = log.slice(i).map((e) => `seq ${e.seq} ${e.op.side} ${e.op.qty} ${e.op.symbol}`);
      rebuild(entries);
      event('diverge', `Log diverged from primary at seq ${i + 1}; discarded ${lost.length} un-replicated entr${lost.length === 1 ? 'y' : 'ies'} [${lost.join('; ')}], full state transfer`);
    } else if (entries.length > log.length) {
      const missing = entries.length - log.length;
      entries.slice(log.length).forEach(apply);
      event('sync', `Caught up ${missing} missing entr${missing === 1 ? 'y' : 'ies'} from primary -> now at seq ${lastSeq()}`);
    } else {
      event('sync', `Already in sync with primary at seq ${lastSeq()}`);
    }
    persist();
    notifyApplied();
  } catch (e) {
    event('error', `Catch-up from primary failed: ${e.message}`);
  }
}

// ------------------------------------------------------------ http api ----
function snapshot() {
  return {
    id: ID,
    role,
    term,
    seq: lastSeq(),
    ackedSeq: role === 'primary' ? ackedSeq : null,
    hash: stateHash(),
    cash: state.cash,
    positions: state.positions,
    orders: state.orders.slice(-50).reverse(),
    buffered: [...buffer.keys()].sort((a, b) => a - b),
    mode: config.mode,
    pid: process.pid,
  };
}

async function route(req, url, body) {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/health')
    return { status: 200, body: { id: ID, role, term, seq: lastSeq(), hash: stateHash() } };
  if (req.method === 'GET' && p === '/state') return { status: 200, body: snapshot() };
  if (req.method === 'GET' && p === '/log') return { status: 200, body: { term, entries: log } };
  if (req.method === 'GET' && p === '/events') {
    const since = Number(url.searchParams.get('since') || 0);
    return { status: 200, body: events.filter((e) => e.id > since) };
  }
  if (req.method === 'POST' && p === '/order') {
    if (role !== 'primary') return { status: 409, body: { ok: false, error: `${ID} is not primary` } };
    return placeOrder(body);
  }
  if (req.method === 'POST' && p === '/replicate') return onReplicate(body);

  // Control plane, called by the gateway (the cluster manager).
  if (req.method === 'POST' && p === '/admin/role') {
    const prevRole = role;
    term = body.term;
    role = body.role;
    peers = body.peers || [];
    primaryUrl = body.primaryUrl || null;
    if (body.config) config = body.config;
    buffer.clear(); // uncommitted out-of-order entries from the old term are dropped
    waiters.forEach((w) => w.resolve(false));
    waiters = [];
    ackedSeq = lastSeq();
    persist();
    if (role === 'primary') {
      if (prevRole !== 'primary')
        event('role', `Became PRIMARY for term ${term} at seq ${lastSeq()}; backups: [${peers.map((x) => x.id).join(', ')}]`);
    } else {
      if (prevRole !== 'backup') event('role', `Now BACKUP in term ${term}, catching up from primary`);
      await catchUp();
    }
    return { status: 200, body: { ok: true, seq: lastSeq() } };
  }
  if (req.method === 'POST' && p === '/admin/config') {
    config = { ...config, ...body };
    return { status: 200, body: { ok: true, config } };
  }
  return { status: 404, body: { error: 'not found' } };
}

http
  .createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      try {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        const out = await route(req, url, raw ? JSON.parse(raw) : {});
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.body));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
  })
  .listen(PORT, () => {
    loadFromDisk();
    event('start', `Replica ${ID} listening on :${PORT} (pid ${process.pid})`);
  });
