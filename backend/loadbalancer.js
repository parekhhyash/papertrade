// Load balancer for PaperTrade (Exp 7).
//
//  * starts a pool of 4 app servers with different capacities
//  * health-checks them every second (active) and on every failed request (passive)
//  * picks a server for each request with the selected algorithm
//  * generates a reproducible trading workload and measures latency / distribution
//
// Mounted by the gateway under /api/lb/*.

const path = require('path');
const { spawn } = require('child_process');

const ALGORITHMS = {
  round_robin: 'Round Robin',
  weighted_round_robin: 'Weighted Round Robin',
  least_connections: 'Least Connections',
  random: 'Random',
  ip_hash: 'IP Hash (sticky)',
};

// Heterogeneous pool: capacity = cores x speed. Weights are set in proportion.
const SERVERS = [
  { id: 'server-1', port: 6001, cores: 4, speed: 1.5, weight: 6 },
  { id: 'server-2', port: 6002, cores: 2, speed: 1.0, weight: 2 },
  { id: 'server-3', port: 6003, cores: 1, speed: 0.8, weight: 1 },
  { id: 'server-4', port: 6004, cores: 2, speed: 1.0, weight: 2 },
].map((s) => ({
  ...s,
  url: `http://localhost:${s.port}`,
  proc: null,
  healthy: false,
  queued: 0,
  busy: 0,
  active: 0, // open requests from the LB (what Least Connections looks at)
  currentWeight: 0, // smooth weighted round robin state
}));

const BASE_MS = 40;
const capacity = (s) => (s.cores * s.speed * 1000) / BASE_MS; // cost units per second

const CLIENTS = 24; // simulated trader terminals ("client IPs")
const REQUEST_TYPES = [
  { type: 'quote', cost: 1, p: 0.6 },
  { type: 'order', cost: 2, p: 0.25 },
  { type: 'portfolio report', cost: 6, p: 0.15 },
];

let algorithm = 'round_robin';
let config = { rate: 60, duration: 15 };
let rrIndex = 0;
let lcIndex = 0;
let run = null; // the test currently running
let history = []; // finished runs
let events = [];
let eventSeq = 0;
let comparing = false;
let stopRequested = false;

function event(type, msg) {
  events.push({ id: ++eventSeq, ts: Date.now(), type, msg });
  if (events.length > 300) events.shift();
  console.log(`[lb] ${msg}`);
}

// ------------------------------------------------------------ servers ----
function startServer(s) {
  s.proc = spawn(
    process.execPath,
    ['--max-old-space-size=64', path.join(__dirname, 'appserver.js'), `--id=${s.id}`, `--port=${s.port}`, `--cores=${s.cores}`, `--speed=${s.speed}`],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  );
  const proc = s.proc;
  proc.on('exit', () => {
    if (s.proc === proc) s.proc = null;
  });
}

function markDown(s, why) {
  if (!s.healthy) return;
  s.healthy = false;
  event('down', `${s.id} marked DOWN (${why}) - removed from rotation`);
}

async function healthCheck() {
  await Promise.all(
    SERVERS.map(async (s) => {
      try {
        const r = await fetch(`${s.url}/health`, { signal: AbortSignal.timeout(800) });
        const h = await r.json();
        s.queued = h.queued;
        s.busy = h.busy;
        if (!s.healthy) {
          s.healthy = true;
          s.currentWeight = 0;
          event('up', `${s.id} passed health check - back in rotation`);
        }
      } catch {
        s.queued = 0;
        s.busy = 0;
        markDown(s, 'health check failed');
      }
    })
  );
}
setInterval(healthCheck, 1000);

// --------------------------------------------------------- algorithms ----
function hash(str) {
  let h = 2166136261; // FNV-1a
  for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function pick(clientId, rand) {
  const pool = SERVERS.filter((s) => s.healthy);
  if (!pool.length) return null;
  switch (algorithm) {
    case 'round_robin':
      return pool[rrIndex++ % pool.length];
    case 'weighted_round_robin': {
      // smooth WRR (as in nginx): spreads the heavy server's turns out evenly
      const total = pool.reduce((t, s) => t + s.weight, 0);
      let best = null;
      for (const s of pool) {
        s.currentWeight += s.weight;
        if (!best || s.currentWeight > best.currentWeight) best = s;
      }
      best.currentWeight -= total;
      return best;
    }
    case 'least_connections': {
      const min = Math.min(...pool.map((s) => s.active));
      const tied = pool.filter((s) => s.active === min);
      return tied[lcIndex++ % tied.length];
    }
    case 'random':
      return pool[Math.floor(rand() * pool.length)];
    case 'ip_hash':
      return pool[hash(clientId) % pool.length];
  }
}

// ------------------------------------------------------------ workload ----
// Seeded PRNG so every algorithm is tested with exactly the same requests.
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildWorkload(rate, duration, seed = 42) {
  const rand = mulberry32(seed);
  const reqs = [];
  let t = 0;
  while (true) {
    t += (-Math.log(1 - rand()) / rate) * 1000; // Poisson arrivals
    if (t >= duration * 1000) break;
    // a few very active traders (bots) send most of the traffic: Zipf-like skew
    const client = Math.min(CLIENTS - 1, Math.floor(CLIENTS * Math.pow(rand(), 2.2)));
    let r = rand();
    const kind = REQUEST_TYPES.find((k) => (r -= k.p) < 0) || REQUEST_TYPES[0];
    reqs.push({ t, clientId: `10.0.0.${client + 11}`, type: kind.type, cost: kind.cost });
  }
  return reqs;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function newRun() {
  return {
    algorithm,
    rate: config.rate,
    duration: config.duration,
    started: Date.now(),
    finished: null,
    sent: 0,
    completed: 0,
    errors: 0,
    retries: 0,
    latencies: [],
    perServer: Object.fromEntries(
      SERVERS.map((s) => [s.id, { sent: 0, completed: 0, latencies: [], serviceMs: 0, maxActive: 0, clients: new Set() }])
    ),
    series: [], // one point per second: requests completed per server + avg latency
    bucket: null,
  };
}

async function dispatch(r, req) {
  const tried = new Set();
  const rand = mulberry32(hash(req.clientId + req.t));
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = pick(req.clientId, rand);
    if (!s || tried.has(s.id)) break;
    tried.add(s.id);
    const ps = r.perServer[s.id];
    const start = Date.now();
    s.active += 1;
    ps.sent += 1;
    ps.clients.add(req.clientId);
    ps.maxActive = Math.max(ps.maxActive, s.active);
    try {
      const res = await fetch(`${s.url}/work`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cost: req.cost, clientId: req.clientId, type: req.type }),
        signal: AbortSignal.timeout(30000),
      });
      const body = await res.json();
      const latency = Date.now() - start;
      s.active -= 1;
      r.completed += 1;
      r.latencies.push(latency);
      ps.completed += 1;
      ps.latencies.push(latency);
      ps.serviceMs += body.serviceMs;
      r.bucket.done[s.id] = (r.bucket.done[s.id] || 0) + 1;
      r.bucket.lat.push(latency);
      return;
    } catch {
      s.active -= 1;
      markDown(s, 'request failed');
      if (attempt === 0) {
        r.retries += 1;
        event('retry', `Request from ${req.clientId} failed on ${s.id}, retrying on another server`);
      }
    }
  }
  r.errors += 1;
}

function summarize(r) {
  const elapsed = ((r.finished || Date.now()) - r.started) / 1000;
  const window = Math.max(1, Math.min(elapsed, r.duration)); // seconds the generator was sending
  const sorted = [...r.latencies].sort((a, b) => a - b);
  const servers = SERVERS.map((s) => {
    const ps = r.perServer[s.id];
    const lat = [...ps.latencies].sort((a, b) => a - b);
    return {
      id: s.id,
      sent: ps.sent,
      completed: ps.completed,
      share: r.sent ? ps.sent / r.sent : 0,
      avgLatency: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0,
      p95: percentile(lat, 95),
      utilization: Math.min(1, ps.serviceMs / (s.cores * window * 1000)),
      maxActive: ps.maxActive,
      clients: ps.clients.size,
    };
  });
  const utils = servers.filter((s) => s.sent).map((s) => s.utilization);
  return {
    algorithm: r.algorithm,
    name: ALGORITHMS[r.algorithm],
    rate: r.rate,
    duration: r.duration,
    started: r.started,
    finished: r.finished,
    running: !r.finished,
    sent: r.sent,
    completed: r.completed,
    errors: r.errors,
    retries: r.retries,
    throughput: Math.round((r.completed / Math.max(elapsed, 1)) * 10) / 10,
    avgLatency: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0,
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    maxLatency: sorted.length ? sorted[sorted.length - 1] : 0,
    imbalance: utils.length ? Math.round((Math.max(...utils) - Math.min(...utils)) * 100) : 0,
    servers,
    series: r.series,
  };
}

async function startRun() {
  if (run && !run.finished) throw new Error('a test is already running');
  if (!SERVERS.some((s) => s.healthy)) throw new Error('no healthy server');
  stopRequested = false;
  rrIndex = 0;
  lcIndex = 0;
  SERVERS.forEach((s) => (s.currentWeight = 0));
  const r = (run = newRun());
  const workload = buildWorkload(config.rate, config.duration);
  event('run', `Test started: ${ALGORITHMS[algorithm]}, ${workload.length} requests at ~${config.rate} req/s for ${config.duration} s`);

  r.bucket = { done: {}, lat: [] };
  const sampler = setInterval(() => {
    const b = r.bucket;
    r.bucket = { done: {}, lat: [] };
    r.series.push({
      t: r.series.length + 1,
      done: b.done,
      active: Object.fromEntries(SERVERS.map((s) => [s.id, s.active])),
      queued: Object.fromEntries(SERVERS.map((s) => [s.id, s.queued])),
      avgLatency: b.lat.length ? Math.round(b.lat.reduce((a, c) => a + c, 0) / b.lat.length) : null,
    });
  }, 1000);

  const inflight = [];
  let i = 0;
  await new Promise((resolve) => {
    const tick = setInterval(() => {
      const now = Date.now() - r.started;
      while (i < workload.length && workload[i].t <= now && !stopRequested) {
        r.sent += 1;
        inflight.push(dispatch(r, workload[i++]));
      }
      if (i >= workload.length || stopRequested) {
        clearInterval(tick);
        resolve();
      }
    }, 5);
  });
  await Promise.all(inflight);
  clearInterval(sampler);
  r.finished = Date.now();
  const s = summarize(r);
  history.push(s);
  if (history.length > 20) history.shift();
  event(
    'done',
    `Test finished: ${s.name} - ${s.completed}/${s.sent} ok, avg ${s.avgLatency} ms, p95 ${s.p95} ms, imbalance ${s.imbalance}%` +
      (s.errors ? `, ${s.errors} failed` : '')
  );
  return s;
}

async function drained() {
  for (let i = 0; i < 60; i++) {
    if (SERVERS.every((s) => !s.healthy || (s.queued === 0 && s.busy === 0 && s.active === 0))) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function compareAll() {
  comparing = true;
  event('run', `Comparing all ${Object.keys(ALGORITHMS).length} algorithms with the same workload`);
  try {
    for (const a of Object.keys(ALGORITHMS)) {
      if (stopRequested) break;
      algorithm = a;
      await drained();
      await startRun();
    }
  } finally {
    comparing = false;
  }
}

// --------------------------------------------------------------- http ----
function state() {
  const live = run ? summarize(run) : null;
  return {
    algorithm,
    algorithms: ALGORITHMS,
    config,
    comparing,
    run: live,
    servers: SERVERS.map((s) => ({
      id: s.id,
      port: s.port,
      cores: s.cores,
      speed: s.speed,
      weight: s.weight,
      capacity: Math.round(capacity(s)),
      capacityShare: capacity(s) / SERVERS.reduce((t, x) => t + capacity(x), 0),
      healthy: s.healthy,
      running: !!s.proc,
      pid: s.proc?.pid ?? null,
      active: s.active,
      queued: s.queued,
      busy: s.busy,
    })),
    history: history.map(({ series, ...h }) => h),
    events: events.slice(-120),
  };
}

async function handle(req, res, p, body, send) {
  if (p === '/api/lb/state') return send(res, 200, state());
  if (p === '/api/lb/config' && req.method === 'POST') {
    if (body.algorithm && ALGORITHMS[body.algorithm]) {
      if (body.algorithm !== algorithm) event('config', `Algorithm -> ${ALGORITHMS[body.algorithm]}`);
      algorithm = body.algorithm;
    }
    if (body.rate) config.rate = Math.max(1, Math.min(200, Number(body.rate)));
    if (body.duration) config.duration = Math.max(3, Math.min(60, Number(body.duration)));
    return send(res, 200, state());
  }
  if (p === '/api/lb/run' && req.method === 'POST') {
    if (run && !run.finished) return send(res, 409, { error: 'a test is already running' });
    startRun().catch((e) => event('error', e.message));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/lb/compare' && req.method === 'POST') {
    if (comparing || (run && !run.finished)) return send(res, 409, { error: 'a test is already running' });
    compareAll().catch((e) => event('error', e.message));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/lb/stop' && req.method === 'POST') {
    stopRequested = true;
    return send(res, 200, { ok: true });
  }
  if (p === '/api/lb/reset' && req.method === 'POST') {
    history = [];
    run = null;
    events = [];
    return send(res, 200, { ok: true });
  }
  const m = p.match(/^\/api\/lb\/servers\/(server-\d)\/(kill|restart)$/);
  if (m && req.method === 'POST') {
    const s = SERVERS.find((x) => x.id === m[1]);
    if (m[2] === 'kill') {
      if (!s.proc) return send(res, 400, { error: 'not running' });
      s.proc.kill('SIGKILL');
      event('crash', `${s.id} (pid ${s.proc.pid}) was KILLED`);
    } else {
      if (s.proc) return send(res, 400, { error: 'already running' });
      startServer(s);
      event('restart', `Restarting ${s.id}`);
    }
    return send(res, 200, { ok: true });
  }
  send(res, 404, { error: 'not found' });
}

function start() {
  SERVERS.forEach(startServer);
  event('start', `Load balancer started with ${SERVERS.length} app servers`);
}

function stopAll() {
  SERVERS.forEach((s) => s.proc && s.proc.kill('SIGKILL'));
}

module.exports = { start, stopAll, handle };
