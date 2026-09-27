// Gateway / cluster manager for PaperTrade.
//
//  * starts the 3 replica processes (real OS processes, so a crash is a real kill)
//  * sends heartbeats to every replica and detects failures
//  * performs failover: promotes the most up-to-date backup and bumps the term
//  * routes client orders to the current primary (with retry + idempotency)
//  * serves the frontend and the dashboard API
//
// Usage: node backend/gateway.js      (then open http://localhost:3000)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const FRONTEND = path.join(__dirname, '..', 'frontend');
const DATA_DIR = path.join(__dirname, '..', 'data');
const HEARTBEAT_MS = 1000;
const MISSES_FOR_DOWN = 3; // primary declared dead after 3 missed heartbeats

const NODES = [
  { id: 'node-1', port: 5001 },
  { id: 'node-2', port: 5002 },
  { id: 'node-3', port: 5003 },
].map((n) => ({
  ...n,
  url: `http://localhost:${n.port}`,
  proc: null,
  status: 'starting', // up | suspect | down | starting
  misses: 0,
  info: null, // last /state snapshot
  lastEventId: 0,
  downSince: null,
}));

let term = 0;
let primaryId = null;
let config = { mode: 'strong', lagMs: 300 };
let failovers = [];
let events = [];
let eventSeq = 0;

// Simulated market feed (random walk).
const prices = { AAPL: 190, TSLA: 245, INFY: 18.5, TCS: 42, RELIANCE: 30 };
setInterval(() => {
  for (const s of Object.keys(prices))
    prices[s] = Math.max(1, Math.round(prices[s] * (1 + (Math.random() - 0.5) * 0.004) * 100) / 100);
}, 1000);

function event(type, msg, node = 'gateway') {
  events.push({ id: ++eventSeq, ts: Date.now(), node, type, msg });
  if (events.length > 500) events.shift();
  if (node === 'gateway') console.log(`[gateway] ${msg}`);
}

const byId = (id) => NODES.find((n) => n.id === id);
const primary = () => byId(primaryId);

async function call(url, method = 'GET', body, timeoutMs = 800) {
  const r = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: r.status, body: await r.json() };
}

// ---------------------------------------------------------- processes ----
function startNode(node) {
  node.proc = spawn(process.execPath, [path.join(__dirname, 'replica.js'), `--id=${node.id}`, `--port=${node.port}`], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  node.status = 'starting';
  node.misses = 0;
  node.lastEventId = 0;
  const proc = node.proc;
  proc.on('exit', () => {
    if (node.proc === proc) node.proc = null;
  });
}

function killNode(node) {
  if (!node.proc) return false;
  node.proc.kill('SIGKILL'); // hard crash: no cleanup, in-flight work is lost
  event('crash', `${node.id} (pid ${node.proc.pid}) was KILLED${node.id === primaryId ? ' - it was the PRIMARY' : ''}`);
  return true;
}

// ------------------------------------------------------------ roles ----
function upNodes() {
  return NODES.filter((n) => n.status === 'up');
}

async function assignRoles() {
  const p = primary();
  if (!p) return;
  const backups = upNodes().filter((n) => n.id !== primaryId);
  await call(`${p.url}/admin/role`, 'POST', {
    role: 'primary',
    term,
    peers: backups.map((b) => ({ id: b.id, url: b.url })),
    config,
  }, 3000).catch(() => {});
  await Promise.all(
    backups.map((b) =>
      call(`${b.url}/admin/role`, 'POST', { role: 'backup', term, primaryUrl: p.url, config }, 5000).catch(() => {})
    )
  );
}

// Promote the up-to-date backup with the highest applied sequence number.
async function failover(reason) {
  const candidates = upNodes().filter((n) => n.id !== primaryId);
  if (!candidates.length) {
    event('error', `No live backup to promote (${reason}) - cluster unavailable`);
    primaryId = null;
    return;
  }
  const started = Date.now();
  const old = primaryId;
  const oldPrimary = primary();
  candidates.sort((a, b) => (b.info?.seq || 0) - (a.info?.seq || 0) || a.id.localeCompare(b.id));
  const chosen = candidates[0];
  term += 1;
  primaryId = chosen.id;
  event(
    'failover',
    `FAILOVER (${reason}): promoting ${chosen.id} [seq ${chosen.info?.seq ?? 0}] over ` +
      `${candidates.slice(1).map((c) => `${c.id} [seq ${c.info?.seq ?? 0}]`).join(', ') || 'no other backup'}; term -> ${term}`
  );
  await assignRoles();
  failovers.push({
    term,
    from: old,
    to: chosen.id,
    at: Date.now(),
    detectionMs: oldPrimary?.downSince ? started - oldPrimary.downSince : null,
    promotionMs: Date.now() - started,
    seq: chosen.info?.seq || 0,
  });
}

// ---------------------------------------------------------- heartbeat ----
async function heartbeat() {
  await Promise.all(
    NODES.map(async (n) => {
      try {
        const { body } = await call(`${n.url}/state`);
        const wasDown = n.status === 'down' || n.status === 'starting';
        n.info = body;
        n.misses = 0;
        if (n.status === 'suspect') event('heartbeat', `${n.id} answered heartbeat again`);
        n.status = 'up';
        n.downSince = null;
        if (wasDown && primaryId && n.id !== primaryId) {
          event('rejoin', `${n.id} is back (seq ${body.seq}) -> rejoining as BACKUP of ${primaryId}, term ${term}`);
          await assignRoles();
        } else if (wasDown && n.id === primaryId && body.role !== 'primary') {
          // primary restarted before being declared dead: re-assert its role
          await assignRoles();
        }
        // pull replica events into the global timeline
        const ev = await call(`${n.url}/events?since=${n.lastEventId}`);
        for (const e of ev.body) {
          n.lastEventId = e.id;
          event(e.type, e.msg, n.id);
        }
      } catch {
        n.misses += 1;
        if (n.status === 'up' || n.status === 'starting') {
          n.downSince = Date.now() - HEARTBEAT_MS;
          if (n.status === 'up') {
            n.status = 'suspect';
            event('heartbeat', `${n.id} missed heartbeat (1/${MISSES_FOR_DOWN})`);
          }
        } else if (n.status === 'suspect') {
          event('heartbeat', `${n.id} missed heartbeat (${n.misses}/${MISSES_FOR_DOWN})`);
        }
        if (n.misses >= MISSES_FOR_DOWN && n.status !== 'down') {
          n.status = 'down';
          event('down', `${n.id} declared DOWN after ${n.misses} missed heartbeats`);
          if (n.id === primaryId) await failover(`primary ${n.id} is down`);
          else await assignRoles(); // primary stops replicating to the dead backup
        }
      }
    })
  );
  // every replica had failed and one came back: elect it
  if (!primaryId && upNodes().length) await failover('no primary, a replica came back');
}

let beating = false;
setInterval(async () => {
  if (beating) return;
  beating = true;
  try {
    await heartbeat();
  } finally {
    beating = false;
  }
}, HEARTBEAT_MS);

// ------------------------------------------------------------- orders ----
async function placeOrder({ symbol, side, qty, orderId }) {
  if (!prices[symbol]) return { status: 400, body: { ok: false, error: 'Unknown symbol' } };
  const order = { orderId: orderId || crypto.randomUUID().slice(0, 8), symbol, side, qty: Number(qty), price: prices[symbol] };
  const deadline = Date.now() + 8000;
  let attempts = 0;
  let lastError = 'no primary';
  // Retry across a failover. Safe because the primary de-duplicates by orderId.
  while (Date.now() < deadline) {
    const p = primary();
    if (p && p.status !== 'down') {
      attempts += 1;
      try {
        const r = await call(`${p.url}/order`, 'POST', order, 6000);
        if (r.status !== 409) {
          if (attempts > 1 && r.body.ok)
            event('retry', `Order ${order.orderId} succeeded on ${r.body.servedBy} after ${attempts} attempts (failover)`);
          return { status: r.status, body: { ...r.body, attempts } };
        }
        lastError = r.body.error;
      } catch (e) {
        lastError = `${p.id} unreachable`;
        if (attempts === 1) event('retry', `Order ${order.orderId}: ${lastError}, waiting for failover and retrying...`);
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { status: 503, body: { ok: false, error: `Cluster unavailable: ${lastError}`, attempts } };
}

// Read the portfolio according to a read policy (consistency experiment).
async function readPortfolio(policy) {
  const live = upNodes();
  // fresh state of every live replica, so "latest" is exact rather than from the last heartbeat
  const all = (await Promise.all(live.map((n) => call(`${n.url}/state`).then((r) => r.body, () => null)))).filter(Boolean);
  if (!all.length) throw new Error('no live replica');
  // "latest" = newest write already acknowledged to a client (writes still in flight don't count)
  const primaryState = all.find((s) => s.id === primaryId);
  const latest = primaryState ? primaryState.ackedSeq : Math.max(...all.map((s) => s.seq));
  let chosen;
  let note;
  if (policy === 'primary') {
    chosen = all.find((s) => s.id === primaryId);
    if (!chosen) throw new Error('primary unavailable');
    note = 'Read from primary (always has the latest committed write)';
  } else if (policy === 'backup') {
    const backups = all.filter((s) => s.id !== primaryId);
    if (!backups.length) throw new Error('no live backup');
    chosen = backups[Math.floor(Math.random() * backups.length)];
    note = 'Read from one backup (R=1) - may be stale under eventual consistency';
  } else {
    // quorum read: R = 2 random replicas, the one with the highest seq wins
    const pick = [...all].sort(() => Math.random() - 0.5).slice(0, 2);
    if (pick.length < 2) throw new Error('quorum not available (need 2 live replicas)');
    pick.sort((a, b) => b.seq - a.seq);
    chosen = pick[0];
    note = `Quorum read (R=2) from [${pick.map((s) => `${s.id}@seq ${s.seq}`).join(', ')}] -> newest wins`;
  }
  return { ...chosen, policy, note, latestSeq: latest, stale: chosen.seq < latest, behindBy: Math.max(0, latest - chosen.seq) };
}

// --------------------------------------------------------------- http ----
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

async function handle(req, res, body) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (p === '/api/cluster' && req.method === 'GET') {
    const since = Number(url.searchParams.get('since') || 0);
    return send(res, 200, {
      term,
      primaryId,
      config,
      prices,
      failovers,
      nodes: NODES.map((n) => ({
        id: n.id,
        port: n.port,
        status: n.status,
        misses: n.misses,
        pid: n.proc?.pid ?? null,
        running: !!n.proc,
        ...(n.info ? { role: n.info.role, term: n.info.term, seq: n.info.seq, hash: n.info.hash, cash: n.info.cash, positions: n.info.positions, buffered: n.info.buffered, orders: n.info.orders } : {}),
      })),
      events: events.filter((e) => e.id > since).slice(-200),
    });
  }
  if (p === '/api/order' && req.method === 'POST') {
    const r = await placeOrder(body);
    return send(res, r.status, r.body);
  }
  if (p === '/api/portfolio' && req.method === 'GET') {
    try {
      return send(res, 200, await readPortfolio(url.searchParams.get('read') || 'primary'));
    } catch (e) {
      return send(res, 503, { error: e.message });
    }
  }
  if (p === '/api/config' && req.method === 'POST') {
    config = { mode: body.mode || config.mode, lagMs: Number(body.lagMs ?? config.lagMs) };
    event('config', `Replication mode -> ${config.mode.toUpperCase()}, simulated network delay ${config.lagMs} ms`);
    await Promise.all(NODES.filter((n) => n.status === 'up').map((n) => call(`${n.url}/admin/config`, 'POST', config).catch(() => {})));
    return send(res, 200, config);
  }
  const m = p.match(/^\/api\/nodes\/(node-\d)\/(kill|restart)$/);
  if (m && req.method === 'POST') {
    const node = byId(m[1]);
    if (m[2] === 'kill') return send(res, 200, { ok: killNode(node) });
    if (node.proc) return send(res, 400, { ok: false, error: 'already running' });
    event('restart', `Restarting ${node.id} process`);
    startNode(node);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/reset' && req.method === 'POST') {
    await reset();
    return send(res, 200, { ok: true });
  }

  // static frontend
  const file = path.join(FRONTEND, p === '/' ? 'index.html' : p);
  if (file.startsWith(FRONTEND) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(file));
  }
  send(res, 404, { error: 'not found' });
}

async function waitForAll() {
  for (let i = 0; i < 50; i++) {
    const ok = await Promise.all(NODES.map((n) => call(`${n.url}/health`).then(() => true, () => false)));
    if (ok.every(Boolean)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function bootstrap() {
  await waitForAll();
  term = 1;
  primaryId = NODES[0].id;
  NODES.forEach((n) => (n.status = 'up'));
  event('start', `Cluster started: PRIMARY ${primaryId}, backups node-2, node-3 (term ${term})`);
  await assignRoles();
}

async function reset() {
  NODES.forEach((n) => n.proc && n.proc.kill('SIGKILL'));
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  events = [];
  failovers = [];
  config = { mode: 'strong', lagMs: 300 };
  NODES.forEach((n) => ((n.info = null), (n.status = 'starting')));
  NODES.forEach(startNode);
  await bootstrap();
}

http
  .createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => handle(req, res, raw ? JSON.parse(raw) : {}).catch((e) => send(res, 500, { error: e.message })));
  })
  .listen(PORT, async () => {
    console.log(`[gateway] PaperTrade dashboard: http://localhost:${PORT}`);
    fs.rmSync(DATA_DIR, { recursive: true, force: true }); // fresh demo on every start
    NODES.forEach(startNode);
    await bootstrap();
  });

process.on('SIGINT', () => {
  NODES.forEach((n) => n.proc && n.proc.kill('SIGKILL'));
  process.exit(0);
});
