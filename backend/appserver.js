// Application server for the load-balancing experiment (Exp 7).
//
// Handles trading requests (quotes, order validation, portfolio reports). Each
// server has a fixed number of CPU "cores" and a speed factor, so servers in the
// pool have different capacities. A request occupies one core for
// cost * BASE_MS / speed milliseconds; when all cores are busy, requests wait in
// a FIFO queue - which is what makes a badly balanced server slow.
//
// Usage: node backend/appserver.js --id=server-1 --port=6001 --cores=4 --speed=1.5

const http = require('http');

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const ID = args.id || 'server-1';
const PORT = Number(args.port || 6001);
const CORES = Number(args.cores || 1);
const SPEED = Number(args.speed || 1);
const BASE_MS = 40; // service time of a cost-1 request on a speed-1 core

let busy = 0; // cores in use
const queue = []; // waiting requests
let served = 0;
let busyMs = 0; // total core time spent serving

function startNext() {
  while (busy < CORES && queue.length) {
    const job = queue.shift();
    busy += 1;
    const queuedMs = Date.now() - job.arrived;
    const serviceMs = Math.round((job.cost * BASE_MS) / SPEED);
    setTimeout(() => {
      busy -= 1;
      served += 1;
      busyMs += serviceMs;
      job.done({ server: ID, queuedMs, serviceMs });
      startNext();
    }, serviceMs);
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

http
  .createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/health')
        return send(res, 200, { id: ID, cores: CORES, speed: SPEED, busy, queued: queue.length, served, busyMs, pid: process.pid });
      if (req.method === 'POST' && req.url === '/work') {
        const { cost = 1 } = raw ? JSON.parse(raw) : {};
        queue.push({ cost: Number(cost), arrived: Date.now(), done: (r) => send(res, 200, r) });
        return startNext();
      }
      send(res, 404, { error: 'not found' });
    });
  })
  .listen(PORT, () => console.log(`[${ID}] app server on :${PORT} (${CORES} cores, speed ${SPEED}, pid ${process.pid})`));
