// Exp 7 - Load balancing tab. Polls /api/lb/state and renders the pool, charts and comparison.

(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const time = (ts) => new Date(ts).toLocaleTimeString('en-GB');
  const pct = (x) => `${Math.round(x * 100)}%`;

  // Categorical slots 1-4 (validated on this dashboard's dark surface). Colour follows the server.
  const COLOR = { 'server-1': '#3987e5', 'server-2': '#d95926', 'server-3': '#199e70', 'server-4': '#c98500' };

  const EXPLAIN = {
    round_robin:
      '<b>Round Robin:</b> requests go to the servers in turn (1, 2, 3, 4, 1, 2, ...). Simple and stateless, and every server gets the same <b>number</b> of requests regardless of how powerful it is, so a weak server overloads while strong ones sit idle.',
    weighted_round_robin:
      '<b>Weighted Round Robin:</b> like round robin, but each server gets turns in proportion to its <b>weight</b> (set from its capacity: 6 : 2 : 1 : 2). Uses the smooth variant (as in nginx) so the strong server\'s turns are spread out, not bunched.',
    least_connections:
      '<b>Least Connections:</b> each request goes to the server with the fewest <b>open (in-progress) requests</b>. Dynamic: a slow or busy server keeps connections open longer, so it automatically receives less new work - no weights needed.',
    random:
      '<b>Random:</b> each request goes to a uniformly random server. No state at all; on average the same as round robin (equal counts), but with extra short-term bursts on individual servers.',
    ip_hash:
      '<b>IP Hash (sticky sessions):</b> the client\'s IP address is hashed to pick the server, so the same trader always lands on the same server (useful for session/cache affinity). Load follows the clients: a few very active trading bots create a hot spot.',
  };

  let S = null;
  let pending = false;

  async function api(path, body) {
    const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  }

  async function poll() {
    try {
      S = await api('/api/lb/state');
      render();
    } catch {
      /* gateway restarting */
    }
    setTimeout(poll, document.body.dataset.tab === 'exp7' ? 500 : 2000);
  }

  function render() {
    renderControls();
    renderServers();
    renderLive();
    renderDist();
    renderComparison();
    renderEvents();
  }

  // ----------------------------------------------------------- controls ----
  function renderControls() {
    const busy = S.comparing || (S.run && S.run.running);
    $('lb-algo').innerHTML = Object.entries(S.algorithms)
      .map(([k, v]) => `<button type="button" data-algo="${k}" class="${k === S.algorithm ? 'active' : ''}" ${busy ? 'disabled' : ''}>${esc(v)}</button>`)
      .join('');
    $('lb-explain').innerHTML = EXPLAIN[S.algorithm];
    if (document.activeElement !== $('lb-rate')) $('lb-rate').value = S.config.rate;
    if (document.activeElement !== $('lb-dur')) $('lb-dur').value = S.config.duration;
    $('lb-rate-v').textContent = `${$('lb-rate').value} req/s`;
    $('lb-dur-v').textContent = `${$('lb-dur').value} s`;
    $('lb-run').disabled = busy || pending;
    $('lb-compare').disabled = busy || pending;
    $('lb-stop').disabled = !busy;
    $('lb-rate').disabled = busy;
    $('lb-dur').disabled = busy;

    const r = S.run;
    const done = S.history.length;
    let status = 'Idle. Pick an algorithm and run a load test.';
    let progress = 0;
    if (r) {
      const elapsed = ((r.finished || Date.now()) - r.started) / 1000;
      progress = r.running ? Math.min(1, elapsed / r.duration) : 1;
      status = r.running
        ? `Running <b>${esc(r.name)}</b>: ${r.sent} requests sent, ${r.completed} completed, avg ${r.avgLatency} ms, p95 ${r.p95} ms` +
          (elapsed > r.duration ? ' - generator finished, waiting for queued requests to drain...' : '')
        : `Last test: <b>${esc(r.name)}</b> - ${r.completed}/${r.sent} completed, ${r.throughput} req/s, avg ${r.avgLatency} ms, p95 ${r.p95} ms`;
    }
    if (S.comparing) status = `Comparing all algorithms (${Math.min(done + 1, 5)} of 5)... ` + status;
    $('lb-status').innerHTML = status;
    $('lb-progress').style.width = `${progress * 100}%`;
  }

  $('lb-algo').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    await api('/api/lb/config', { algorithm: b.dataset.algo });
    S = await api('/api/lb/state');
    render();
  });
  $('lb-rate').addEventListener('input', () => ($('lb-rate-v').textContent = `${$('lb-rate').value} req/s`));
  $('lb-dur').addEventListener('input', () => ($('lb-dur-v').textContent = `${$('lb-dur').value} s`));
  $('lb-rate').addEventListener('change', () => api('/api/lb/config', { rate: Number($('lb-rate').value) }));
  $('lb-dur').addEventListener('change', () => api('/api/lb/config', { duration: Number($('lb-dur').value) }));
  const start = async (path) => {
    pending = true;
    await api('/api/lb/config', { rate: Number($('lb-rate').value), duration: Number($('lb-dur').value) });
    await api(path, {});
    pending = false;
  };
  $('lb-run').addEventListener('click', () => start('/api/lb/run'));
  $('lb-compare').addEventListener('click', () => start('/api/lb/compare'));
  $('lb-stop').addEventListener('click', () => api('/api/lb/stop', {}));

  // ------------------------------------------------------------ servers ----
  function renderServers() {
    const run = S.run;
    $('lb-servers').innerHTML = S.servers
      .map((s) => {
        const rs = run?.servers.find((x) => x.id === s.id);
        const status = !s.running ? 'down' : s.healthy ? 'up' : 'suspect';
        const label = !s.running ? 'DOWN' : s.healthy ? 'HEALTHY' : 'UNHEALTHY';
        const qPct = Math.min(1, s.queued / 40);
        return `
        <div class="node ${status === 'down' ? 'down' : ''}">
          <div class="node-top">
            <div class="node-name"><span class="swatch" style="background:${COLOR[s.id]}"></span>${s.id}</div>
            <span class="role ${status === 'up' ? 'primary' : status === 'down' ? 'down' : 'suspect'}">${label}</span>
          </div>
          <div class="kv">
            <span>Process</span><span class="mono">${s.running ? `pid ${s.pid} &middot; :${s.port}` : 'not running'}</span>
            <span>Capacity</span><span>${s.cores} cores &times; ${s.speed} speed</span>
            <span>Share of pool</span><span>${pct(s.capacityShare)}</span>
            <span>Weight (WRR)</span><span>${s.weight}</span>
            <span>Requests this test</span><span><b>${rs ? rs.sent : 0}</b> <span class="muted">${rs && run.sent ? `(${pct(rs.share)})` : ''}</span></span>
            <span>Avg / p95 latency</span><span>${rs && rs.completed ? `${rs.avgLatency} / ${rs.p95} ms` : '-'}</span>
          </div>
          <div class="meter-row"><span>Open connections</span><b>${s.active}</b></div>
          <div class="meter"><i style="width:${Math.min(100, (s.active / 40) * 100)}%;background:${COLOR[s.id]}"></i></div>
          <div class="meter-row"><span>Cores busy</span><b>${s.busy} / ${s.cores}</b></div>
          <div class="meter"><i style="width:${(s.busy / s.cores) * 100}%;background:${COLOR[s.id]}"></i></div>
          <div class="meter-row"><span>Waiting in queue</span><b class="${s.queued > 10 ? 'warn-text' : ''}">${s.queued}</b></div>
          <div class="meter"><i class="${s.queued > 10 ? 'hot' : ''}" style="width:${qPct * 100}%"></i></div>
          <div class="meter-row"><span>Utilization (this test)</span><b>${rs ? pct(rs.utilization) : '-'}</b></div>
          <div class="node-actions">
            <button class="danger-btn" data-lbkill="${s.id}" ${s.running ? '' : 'disabled'}>Kill server</button>
            <button class="ghost-btn" data-lbrestart="${s.id}" ${s.running ? 'disabled' : ''}>Restart</button>
          </div>
        </div>`;
      })
      .join('');
  }

  // pointerdown: the cards re-render on every poll, which can swallow a click
  $('lb-servers').addEventListener('pointerdown', async (e) => {
    const k = e.target.dataset.lbkill;
    const r = e.target.dataset.lbrestart;
    if (k) await api(`/api/lb/servers/${k}/kill`, {});
    if (r) await api(`/api/lb/servers/${r}/restart`, {});
  });

  // -------------------------------------------------------- live chart ----
  function renderLive() {
    const el = $('lb-live');
    const series = S.run?.series || [];
    const ids = S.servers.map((s) => s.id);
    $('lb-live-hint').textContent = S.run ? `${S.run.running ? 'Running' : 'Last test'}: ${S.run.name}` : 'No test yet';
    $('lb-live-legend').innerHTML = ids.map((id) => `<span><i style="background:${COLOR[id]}"></i>${id}</span>`).join('');
    if (!series.length) {
      el.innerHTML = '<p class="muted empty">Run a load test to see how requests are distributed over time.</p>';
      return;
    }
    const W = Math.max(320, el.clientWidth || 600);
    const H = 230;
    const m = { l: 34, r: 72, t: 10, b: 26 };
    const maxT = Math.max(series.length, S.run.duration);
    const maxY = Math.max(5, ...series.flatMap((p) => ids.map((id) => p.done[id] || 0)));
    const niceMax = Math.ceil(maxY / 10) * 10;
    const x = (t) => m.l + ((t - 1) / Math.max(1, maxT - 1)) * (W - m.l - m.r);
    const y = (v) => H - m.b - (v / niceMax) * (H - m.t - m.b);
    let svg = `<svg width="${W}" height="${H}" role="img" aria-label="Requests completed per second by each server">`;
    for (let i = 0; i <= 4; i++) {
      const v = (niceMax / 4) * i;
      svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${m.l - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${v}</text>`;
    }
    for (let t = 1; t <= maxT; t += Math.ceil(maxT / 8)) svg += `<text x="${x(t)}" y="${H - 8}" class="axis" text-anchor="middle">${t}s</text>`;
    const ends = [];
    for (const id of ids) {
      const pts = series.map((p) => `${x(p.t)},${y(p.done[id] || 0)}`).join(' ');
      svg += `<polyline points="${pts}" fill="none" stroke="${COLOR[id]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      const last = series[series.length - 1];
      ends.push({ id, y: y(last.done[id] || 0), x: x(last.t) });
    }
    // direct labels at the line ends, nudged apart so they never overlap
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
    for (const e of ends) svg += `<text x="${e.x + 6}" y="${e.y + 4}" class="dlabel">${e.id}</text>`;
    svg += `<line id="lb-cross" class="cross" y1="${m.t}" y2="${H - m.b}" x1="-10" x2="-10"/>`;
    svg += `<rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent" id="lb-hit"/></svg>`;
    el.innerHTML = svg;
    const hit = $('lb-hit');
    hit.addEventListener('mousemove', (ev) => {
      const box = hit.getBoundingClientRect();
      const t = Math.round(1 + ((ev.clientX - box.left) / box.width) * (maxT - 1));
      const p = series[Math.min(series.length, Math.max(1, t)) - 1];
      if (!p) return;
      $('lb-cross').setAttribute('x1', x(p.t));
      $('lb-cross').setAttribute('x2', x(p.t));
      showTip(
        ev,
        `<b>Second ${p.t}</b>` +
          ids.map((id) => `<div><i style="background:${COLOR[id]}"></i>${id}: <b>${p.done[id] || 0}</b> req/s &middot; ${p.queued[id]} queued</div>`).join('') +
          (p.avgLatency !== null ? `<div class="muted">avg latency ${p.avgLatency} ms</div>` : '')
      );
    });
    hit.addEventListener('mouseleave', () => {
      $('lb-cross').setAttribute('x1', -10);
      $('lb-cross').setAttribute('x2', -10);
      hideTip();
    });
  }

  // ----------------------------------------------- distribution chart ----
  function renderDist() {
    const run = S.run;
    if (!run) {
      $('lb-dist').innerHTML = '<p class="muted empty">No test yet.</p>';
      return;
    }
    $('lb-dist').innerHTML =
      run.servers
        .map((rs) => {
          const s = S.servers.find((x) => x.id === rs.id);
          const over = rs.utilization >= 0.9;
          return `
        <div class="dist-row" data-tip="<b>${rs.id}</b><div>${pct(rs.share)} of requests (${rs.sent})</div><div>${pct(s.capacityShare)} of pool capacity</div><div>avg ${rs.avgLatency} ms &middot; p95 ${rs.p95} ms</div><div>utilization ${pct(rs.utilization)}</div>">
          <div class="dist-label"><span class="swatch" style="background:${COLOR[rs.id]}"></span>${rs.id}</div>
          <div class="dist-track">
            <div class="dist-bar" style="width:${rs.share * 100}%;background:${COLOR[rs.id]}"></div>
            <div class="dist-tick" style="left:${s.capacityShare * 100}%"></div>
          </div>
          <div class="dist-val">${pct(rs.share)} <span class="muted">vs ${pct(s.capacityShare)}</span>${over ? ' <span class="warn-text">overloaded</span>' : ''}</div>
          <div class="dist-lat">avg <b>${rs.avgLatency} ms</b></div>
        </div>`;
        })
        .join('') +
      `<p class="hint dist-note">Ideal balancing puts each bar on its tick: traffic in proportion to capacity. Utilization spread (max - min): <b>${run.imbalance}%</b>.</p>`;
  }

  // ------------------------------------------------------- comparison ----
  function latestPerAlgorithm() {
    const by = {};
    for (const h of S.history) by[h.algorithm] = h;
    return Object.keys(S.algorithms).map((k) => by[k]).filter(Boolean);
  }

  function renderComparison() {
    const runs = latestPerAlgorithm();
    if (!runs.length) {
      $('lb-cmp-latency').innerHTML = '<p class="muted empty">Click "Compare all 5 algorithms".</p>';
      $('lb-cmp-split').innerHTML = '';
      $('lb-cmp-legend').innerHTML = '';
    } else {
      const max = Math.max(...runs.map((r) => r.p95));
      const best = Math.min(...runs.map((r) => r.p95));
      $('lb-cmp-latency').innerHTML = runs
        .map(
          (r) => `<div class="hbar" data-tip="<b>${esc(r.name)}</b><div>avg ${r.avgLatency} ms</div><div>p95 ${r.p95} ms &middot; p99 ${r.p99} ms</div><div>max ${r.maxLatency} ms</div><div>${r.throughput} req/s at ${r.rate} req/s offered</div>">
          <div class="hbar-label">${esc(r.name)}</div>
          <div class="hbar-track"><div class="hbar-bar" style="width:${Math.max(1, (r.p95 / max) * 100)}%"></div></div>
          <div class="hbar-val">${r.p95.toLocaleString()} ms${r.p95 === best ? ' <span class="badge-ok">best</span>' : ''}</div>
        </div>`
        )
        .join('');
      const ids = S.servers.map((s) => s.id);
      $('lb-cmp-legend').innerHTML =
        ids.map((id) => `<span><i style="background:${COLOR[id]}"></i>${id}</span>`).join('');
      // capacity reference row + one 100% stacked bar per algorithm
      const capRow = {
        name: 'Capacity (ideal)',
        servers: S.servers.map((s) => ({ id: s.id, share: s.capacityShare, sent: null })),
      };
      $('lb-cmp-split').innerHTML = [capRow, ...runs]
        .map(
          (r) => `<div class="hbar ${r === capRow ? 'ideal' : ''}">
          <div class="hbar-label">${esc(r.name)}</div>
          <div class="stack">${r.servers
            .filter((x) => x.share > 0)
            .map(
              (x) =>
                `<div style="width:${x.share * 100}%;background:${COLOR[x.id]}" data-tip="<b>${esc(r.name)}</b><div>${x.id}: ${pct(x.share)}${x.sent !== null ? ` (${x.sent} requests)` : ' of capacity'}</div>">${x.share >= 0.09 ? pct(x.share) : ''}</div>`
            )
            .join('')}</div>
        </div>`
        )
        .join('');
    }

    const all = [...S.history].reverse();
    const bestP95 = runs.length ? Math.min(...runs.map((r) => r.p95)) : null;
    $('lb-history').innerHTML =
      '<thead><tr><th>Time</th><th>Algorithm</th><th>Offered</th><th>Requests</th><th>Throughput</th><th>Avg</th><th>p95</th><th>Max</th><th>Utilization spread</th><th>Retries / failed</th></tr></thead><tbody>' +
      (all.length
        ? all
            .map(
              (h) =>
                `<tr><td>${time(h.started)}</td><td><b>${esc(h.name)}</b></td><td>${h.rate} req/s</td><td>${h.completed}/${h.sent}</td><td>${h.throughput} req/s</td><td>${h.avgLatency} ms</td><td class="${h.p95 === bestP95 ? 'badge-ok' : ''}">${h.p95} ms</td><td>${h.maxLatency} ms</td><td>${h.imbalance}%</td><td>${h.retries} / ${h.errors}</td></tr>`
            )
            .join('')
        : '<tr><td colspan="10" class="muted">No tests yet</td></tr>') +
      '</tbody>';
  }

  function renderEvents() {
    const el = $('lb-events');
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    el.innerHTML = S.events
      .map((e) => `<div class="ev ${e.type === 'down' || e.type === 'crash' ? 'crash' : e.type === 'up' || e.type === 'restart' ? 'rejoin' : e.type === 'done' ? 'sync' : e.type === 'retry' ? 'buffer' : ''}"><span class="t">${time(e.ts)}</span><span class="src">lb</span><span class="m">${esc(e.msg)}</span></div>`)
      .join('');
    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  // ------------------------------------------------------------ tooltip ----
  const tip = $('tip');
  function showTip(ev, html) {
    tip.innerHTML = html;
    tip.style.display = 'block';
    const x = Math.min(window.innerWidth - tip.offsetWidth - 12, ev.clientX + 14);
    tip.style.left = `${x}px`;
    tip.style.top = `${ev.clientY + 14}px`;
  }
  function hideTip() {
    tip.style.display = 'none';
  }
  document.addEventListener('mousemove', (ev) => {
    const t = ev.target.closest?.('[data-tip]');
    if (t && document.body.dataset.tab === 'exp7') showTip(ev, t.dataset.tip);
    else if (!ev.target.closest?.('#lb-hit')) hideTip();
  });

  poll();
})();
