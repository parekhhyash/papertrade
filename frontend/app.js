// PaperTrade dashboard: polls the gateway and renders both experiments.

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const time = (ts) => new Date(ts).toLocaleTimeString('en-GB');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let cluster = null;
let lastPrices = {};
let events = [];
let lastEventId = 0;
let side = 'BUY';
const writes = [];
const reads = [];

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = msg;
  $('toast').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ------------------------------------------------------------- tabs ----
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${t.dataset.tab}`));
    document.body.dataset.tab = t.dataset.tab;
    location.hash = t.dataset.tab;
  })
);
document.body.dataset.tab = 'exp5';
if (['#exp6', '#exp7'].includes(location.hash)) document.querySelector(`[data-tab="${location.hash.slice(1)}"]`).click();

// ---------------------------------------------------------- polling ----
async function poll() {
  try {
    cluster = await api(`/api/cluster?since=${lastEventId}`);
    if (cluster.events.length && cluster.events[0].id <= lastEventId) events = []; // gateway was reset
    for (const e of cluster.events) {
      events.push(e);
      lastEventId = Math.max(lastEventId, e.id);
    }
    if (events.length > 400) events = events.slice(-400);
    render();
  } catch {
    /* gateway restarting */
  }
  setTimeout(poll, 500);
}

function render() {
  const { term, primaryId, config } = cluster;
  $('b-term').innerHTML = `Term <b>${term}</b>`;
  $('b-primary').innerHTML = `Primary <b>${primaryId || 'NONE'}</b>`;
  $('b-mode').innerHTML = `Replication <b>${config.mode.toUpperCase()}</b> &middot; delay <b>${config.lagMs} ms</b>`;
  renderTicker();
  renderNodes();
  renderOrders();
  renderFailovers();
  renderEvents('events5', () => true);
  renderEvents('events6', (e) => ['commit', 'replicate', 'apply', 'buffer', 'sync', 'diverge', 'config', 'reject', 'failover', 'crash', 'rejoin'].includes(e.type));
  renderConfig();
  renderCompare();
}

function renderTicker() {
  const t = $('ticker');
  t.innerHTML = Object.entries(cluster.prices)
    .map(([s, p]) => {
      const cls = lastPrices[s] === undefined ? '' : p > lastPrices[s] ? 'up' : p < lastPrices[s] ? 'down' : '';
      return `<span>${s}<b class="${cls}">${fmt(p)}</b></span>`;
    })
    .join('');
  lastPrices = { ...cluster.prices };
  const sel = $('t-symbol');
  if (!sel.options.length) sel.innerHTML = Object.keys(cluster.prices).map((s) => `<option>${s}</option>`).join('');
  $('t-price').value = fmt(cluster.prices[sel.value]);
}

function renderNodes() {
  $('nodes').innerHTML = cluster.nodes
    .map((n) => {
      const isPrimary = n.id === cluster.primaryId && n.status !== 'down';
      const label = n.status === 'down' ? 'DOWN' : n.status === 'suspect' ? 'SUSPECT' : n.status === 'starting' ? 'STARTING' : isPrimary ? 'PRIMARY' : (n.role || '').toUpperCase();
      const roleCls = n.status === 'down' || n.status === 'starting' ? 'down' : n.status === 'suspect' ? 'suspect' : isPrimary ? 'primary' : n.role;
      const hb = [0, 1, 2].map((i) => `<i class="${i < n.misses ? 'miss' : ''}"></i>`).join('');
      const pos = n.positions ? Object.entries(n.positions).map(([s, p]) => `${s}:${p.qty}`).join(' ') || '-' : '-';
      return `
      <div class="node ${isPrimary ? 'primary' : ''} ${n.status}">
        <div class="node-top">
          <div class="node-name"><span class="dot ${n.status}"></span>${n.id}</div>
          <span class="role ${roleCls}">${label}</span>
        </div>
        <div class="kv">
          <span>Process</span><span class="mono">${n.running ? `pid ${n.pid} &middot; :${n.port}` : 'not running'}</span>
          <span>Term</span><span>${n.term ?? '-'}</span>
          <span>Applied seq</span><span><b>${n.seq ?? '-'}</b>${n.buffered?.length ? ` <span class="badge-stale">(+buffered ${n.buffered.join(',')})</span>` : ''}</span>
          <span>State hash</span><span class="mono">${n.hash ?? '-'}</span>
          <span>Cash</span><span>${n.cash !== undefined ? '$' + fmt(n.cash) : '-'}</span>
          <span>Positions</span><span class="mono">${pos}</span>
        </div>
        <div class="hb">Heartbeat ${hb} ${n.misses ? `${n.misses} missed` : 'ok'}</div>
        <div class="node-actions">
          <button class="danger-btn" data-kill="${n.id}" ${n.running ? '' : 'disabled'}>Kill process</button>
          <button class="ghost-btn" data-restart="${n.id}" ${n.running ? 'disabled' : ''}>Restart</button>
        </div>
      </div>`;
    })
    .join('');
}

// pointerdown: the cards are re-rendered on every poll, which can swallow a click
$('nodes').addEventListener('pointerdown', async (e) => {
  const kill = e.target.dataset.kill;
  const restart = e.target.dataset.restart;
  if (kill) {
    await api(`/api/nodes/${kill}/kill`, {});
    toast(`<b>${kill}</b> killed (SIGKILL)`);
  }
  if (restart) {
    await api(`/api/nodes/${restart}/restart`, {});
    toast(`<b>${restart}</b> restarting - it will replay its disk log and catch up`);
  }
});

function primaryNode() {
  return cluster.nodes.find((n) => n.id === cluster.primaryId && n.status !== 'down');
}

const nodeTag = (id) => `<span class="tag n${id.slice(-1)}">${id}</span>`;

function renderOrders() {
  const p = primaryNode();
  const orders = p?.orders || [];
  $('orders').innerHTML = orders.length
    ? orders
        .map((o) => `<tr><td>${o.seq}</td><td class="mono">${o.orderId}</td><td class="side-${o.side}">${o.side}</td><td>${o.symbol}</td><td>${o.qty}</td><td>${fmt(o.price)}</td><td>${nodeTag(o.executedBy)}</td><td>${o.term}</td></tr>`)
        .join('')
    : `<tr><td colspan="8" class="muted">${p ? 'No orders yet' : 'Primary unavailable'}</td></tr>`;
}

function renderFailovers() {
  const f = cluster.failovers;
  $('failovers').innerHTML = f.length
    ? f
        .map((x) => `<tr><td>${x.term}</td><td>${nodeTag(x.from)}</td><td>${nodeTag(x.to)}</td><td>${x.seq}</td><td>${x.detectionMs ?? '-'} ms</td><td>${x.promotionMs} ms</td></tr>`)
        .join('')
    : '<tr><td colspan="6" class="muted">No failovers yet</td></tr>';
  const p = primaryNode();
  const up = cluster.nodes.filter((n) => n.status === 'up').length;
  $('ft-stats').innerHTML = `
    <div class="stat"><span>Live replicas</span><b>${up} / ${cluster.nodes.length}</b></div>
    <div class="stat"><span>Failures tolerated now</span><b>${Math.max(0, up - 1)}</b></div>
    <div class="stat"><span>Orders committed</span><b>${p?.seq ?? '-'}</b></div>
    <div class="stat"><span>Failovers</span><b>${f.length}</b></div>`;
}

function renderEvents(id, filter) {
  const el = $(id);
  const list = events.filter(filter).sort((a, b) => a.ts - b.ts || a.id - b.id).slice(-150);
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  el.innerHTML = list
    .map((e) => `<div class="ev ${e.type}"><span class="t">${time(e.ts)}</span><span class="src">${e.node === 'gateway' ? 'gateway' : nodeTag(e.node)}</span><span class="m">${esc(e.msg)}</span></div>`)
    .join('');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

// ---------------------------------------------------------- ordering ----
$('t-side').addEventListener('click', (e) => {
  if (!e.target.dataset.v) return;
  side = e.target.dataset.v;
  $('t-side').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === e.target));
});
$('t-symbol').addEventListener('change', () => ($('t-price').value = fmt(cluster.prices[$('t-symbol').value])));

async function submitOrder(symbol, s, qty) {
  const orderId = Math.random().toString(16).slice(2, 10);
  const r = await api('/api/order', { symbol, side: s, qty, orderId });
  if (r.ok) {
    writes.unshift({ ...r, label: `${s} ${qty} ${symbol}` });
    renderWrites();
  }
  return r;
}

$('ticket').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = $('t-result');
  const symbol = $('t-symbol').value;
  const qty = Number($('t-qty').value);
  res.className = 'result wait';
  res.innerHTML = `Sending ${side} ${qty} ${symbol} to primary <b>${cluster.primaryId}</b>...`;
  $('t-submit').disabled = true;
  const r = await submitOrder(symbol, side, qty);
  $('t-submit').disabled = false;
  if (r.ok) {
    res.className = 'result ok';
    res.innerHTML = `<b>FILLED</b> ${r.order.side} ${r.order.qty} ${r.order.symbol} @ ${fmt(r.order.price)} &middot; seq <b>${r.seq}</b> &middot; order <span class="mono">${r.order.orderId}</span><br>
      Executed by primary ${nodeTag(r.servedBy)} in term ${r.term} &middot; replicated to [${r.acks.join(', ') || 'none'}]${r.failed.length ? ` &middot; <span class="badge-stale">no ack: ${r.failed.join(', ')}</span>` : ''}<br>
      Latency ${r.latencyMs} ms &middot; ${r.attempts > 1 ? `<span class="badge-stale">${r.attempts} attempts - primary failed, request retried on new primary (idempotent orderId)</span>` : '1 attempt'}`;
  } else {
    res.className = 'result err';
    res.innerHTML = `<b>REJECTED</b> ${esc(r.error)}`;
  }
});

// ------------------------------------------------------ consistency ----
const EXPLAIN = {
  strong: '<b>Strong consistency:</b> the primary waits until <b>every</b> live backup has applied the order before acknowledging. All replicas are identical after each ACK, so any replica can serve reads - but write latency equals the slowest backup.',
  quorum: '<b>Quorum:</b> the primary acknowledges once a <b>majority (W=2)</b> has the order. Reading from any <b>R=2</b> replicas always overlaps with the write set because <b>R + W &gt; N</b> (2 + 2 &gt; 3), so a quorum read is never stale, while one slow backup does not block writes.',
  eventual: '<b>Eventual consistency:</b> the primary acknowledges <b>immediately</b> and replicates in the background. Writes are fast, but backups lag behind (stale reads) and may receive updates out of order; they converge once replication catches up. If the primary crashes before replicating, acknowledged orders can be lost.',
};

function renderConfig() {
  const { mode, lagMs } = cluster.config;
  $('c-mode').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === mode));
  if (document.activeElement !== $('c-lag')) $('c-lag').value = lagMs;
  $('c-lag-v').textContent = `${$('c-lag').value} ms`;
  $('c-explain').innerHTML = EXPLAIN[mode];
}

$('c-mode').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  await api('/api/config', { mode: b.dataset.v, lagMs: Number($('c-lag').value) });
  toast(`Replication mode set to <b>${b.dataset.v.toUpperCase()}</b>`);
});
$('c-lag').addEventListener('input', () => ($('c-lag-v').textContent = `${$('c-lag').value} ms`));
$('c-lag').addEventListener('change', () => api('/api/config', { mode: cluster.config.mode, lagMs: Number($('c-lag').value) }));

$('burst').addEventListener('click', async () => {
  const syms = Object.keys(cluster.prices);
  const jobs = Array.from({ length: 5 }, (_, i) => submitOrder(syms[i % syms.length], 'BUY', 1 + Math.floor(Math.random() * 10)));
  toast('Sent 5 concurrent orders');
  await Promise.all(jobs);
});
$('single').addEventListener('click', () => submitOrder('AAPL', 'BUY', 1));

function renderWrites() {
  $('writes').innerHTML = writes.length
    ? writes
        .slice(0, 30)
        .map((w) => `<tr><td>${w.seq}</td><td>${w.label}</td><td>${w.mode}</td><td>${w.mode === 'eventual' ? '<span class="muted">none (async)</span>' : w.acks.join(', ') || '-'}</td><td><b>${w.latencyMs} ms</b></td></tr>`)
        .join('')
    : '<tr><td colspan="5" class="muted">No writes yet</td></tr>';
}

function renderCompare() {
  const nodes = cluster.nodes;
  const p = primaryNode();
  const symbols = [...new Set(nodes.flatMap((n) => Object.keys(n.positions || {})))].sort();
  const live = nodes.filter((n) => n.status === 'up' && n.seq !== undefined);
  const ref = p || live.sort((a, b) => b.seq - a.seq)[0];
  const cell = (n, v, refV) => {
    if (n.status === 'down' || n.seq === undefined) return '<td class="dead">down</td>';
    return `<td class="${ref && v !== refV ? 'stale' : ''}">${v}</td>`;
  };
  const row = (label, fn) => `<tr><td class="muted">${label}</td>${nodes.map((n) => cell(n, fn(n), ref ? fn(ref) : null)).join('')}</tr>`;
  $('compare').innerHTML =
    `<thead><tr><th></th>${nodes.map((n) => `<th class="${p && n.id === p.id ? 'primary-col' : ''}">${n.id}${p && n.id === p.id ? ' (primary)' : ''}</th>`).join('')}</tr></thead><tbody>` +
    row('Applied seq', (n) => n.seq) +
    row('State hash', (n) => `<span class="mono">${n.hash}</span>`) +
    row('Cash', (n) => '$' + fmt(n.cash)) +
    symbols.map((s) => row(`${s} qty`, (n) => n.positions?.[s]?.qty ?? 0)).join('') +
    row('Buffered (out of order)', (n) => (n.buffered?.length ? n.buffered.join(', ') : '-')) +
    '</tbody>';

  const lagging = live.filter((n) => ref && n.seq < ref.seq);
  const s = $('sync-status');
  if (!ref) {
    s.className = 'pill bad';
    s.textContent = 'No live replica';
  } else if (!lagging.length && live.every((n) => n.hash === ref.hash)) {
    s.className = 'pill ok';
    s.textContent = `CONSISTENT - all live replicas at seq ${ref.seq}`;
  } else {
    s.className = 'pill bad';
    s.textContent = `INCONSISTENT - ${lagging.map((n) => `${n.id} behind by ${ref.seq - n.seq}`).join(', ')}`;
  }
}

document.querySelectorAll('[data-read]').forEach((b) =>
  b.addEventListener('click', async () => {
    const r = await api(`/api/portfolio?read=${b.dataset.read}`);
    reads.unshift({ ...r, at: Date.now(), policy: b.dataset.read });
    $('reads').innerHTML = reads
      .slice(0, 20)
      .map((x) =>
        x.error
          ? `<tr><td>${time(x.at)}</td><td>${x.policy}</td><td colspan="5" class="err-text">${esc(x.error)}</td></tr>`
          : `<tr><td>${time(x.at)}</td><td>${x.policy}${x.policy === 'quorum' ? `<br><small class="muted">${esc(x.note.replace(/^.*from /, 'read '))}</small>` : ''}</td><td>${nodeTag(x.id)}</td><td>${x.seq}</td><td>${x.latestSeq}</td><td>$${fmt(x.cash)}</td><td>${x.stale ? `<span class="badge-stale">STALE (${x.behindBy} behind)</span>` : '<span class="badge-ok">FRESH</span>'}</td></tr>`
      )
      .join('');
  })
);

poll();
