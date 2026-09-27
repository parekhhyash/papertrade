// Drives the dashboard through both experiments and saves screenshots to
// docs/screenshots. Start the app first (npm start), then: npm run screenshots
// Needs Playwright (npm i -g playwright, or set NODE_PATH to where it lives).

const path = require('path');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}

const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const shot = async (name) => {
    await wait(700); // let one more poll land
    await page.addStyleTag({ content: '#toast{display:none}' });
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
    console.log('saved', name);
  };
  const post = (url, body) => page.evaluate(([u, b]) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }), [url, body]);
  const cluster = () => page.evaluate(() => fetch('/api/cluster').then((r) => r.json()));
  const until = async (fn, timeout = 20000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await fn(await cluster())) return;
      await wait(250);
    }
    throw new Error('timeout waiting for cluster state');
  };
  const sendOrder = async (symbol, side, qty) => {
    await page.selectOption('#t-symbol', symbol);
    await page.click(`#t-side [data-v="${side}"]`);
    await page.fill('#t-qty', String(qty));
    await page.click('#t-submit');
  };
  const orderDone = () =>
    page.waitForFunction(() => !document.querySelector('#t-result').classList.contains('wait'), null, { timeout: 20000 });
  const order = async (symbol, side, qty) => {
    await sendOrder(symbol, side, qty);
    await orderDone();
  };
  const nodeAction = (attr, id) => page.locator(`[data-${attr}="${id}"]`).dispatchEvent('pointerdown');
  const allSynced = (c) => {
    const up = c.nodes.filter((n) => n.status === 'up');
    return up.length === 3 && up.every((n) => n.hash === up[0].hash && n.role !== 'recovering');
  };

  // =========================== EXP 5 ===========================
  await page.goto(`${BASE}/#exp5`);
  await post('/api/reset', {});
  await page.reload();
  await until(allSynced);
  await order('AAPL', 'BUY', 20);
  await order('TSLA', 'BUY', 10);
  await order('INFY', 'BUY', 100);
  await order('AAPL', 'SELL', 5);
  await until((c) => allSynced(c) && c.nodes[0].seq === 4);
  await shot('exp5-01-healthy-cluster');

  await nodeAction('kill', 'node-1');
  await until((c) => c.nodes[0].status === 'suspect');
  // an order placed while the primary is dead: the gateway keeps retrying until failover
  await sendOrder('TCS', 'BUY', 50);
  await until((c) => c.nodes[0].misses >= 2);
  await shot('exp5-02-primary-crashed-suspect');

  await orderDone();
  await until((c) => c.primaryId === 'node-2' && c.nodes[1].term === 2 && c.nodes.slice(1).every((n) => n.seq === 5));
  await shot('exp5-03-failover-new-primary');

  await order('RELIANCE', 'BUY', 40);
  await order('TSLA', 'SELL', 4);
  await nodeAction('restart', 'node-1');
  await until((c) => allSynced(c) && c.nodes[0].role === 'backup' && c.nodes[0].seq === c.nodes[1].seq);
  await wait(1200);
  await shot('exp5-04-old-primary-rejoined');

  // a backup failure does not interrupt service
  await nodeAction('kill', 'node-3');
  await until((c) => c.nodes[2].status === 'down');
  await order('AAPL', 'BUY', 3);
  await until((c) => c.nodes[0].seq === 8 && c.nodes[1].seq === 8);
  await shot('exp5-05-backup-down-service-continues');
  await nodeAction('restart', 'node-3');
  await until((c) => allSynced(c));

  // =========================== EXP 6 ===========================
  await page.click('[data-tab="exp6"]');
  await post('/api/reset', {});
  await page.reload();
  await until(allSynced);
  const setMode = async (mode, lag) => {
    await post('/api/config', { mode, lagMs: lag });
    await wait(600);
  };
  const readAll = async (policies) => {
    for (const p of policies) {
      await page.click(`[data-read="${p}"]`);
      await wait(250);
    }
  };

  // 1. strong consistency: slow writes, every replica identical after ACK
  await setMode('strong', 1500);
  await page.click('#burst');
  await page.waitForFunction(() => document.querySelectorAll('#writes tr').length >= 5, null, { timeout: 20000 });
  await readAll(['backup', 'backup', 'primary', 'quorum']);
  await shot('exp6-01-strong-consistency');

  // 2. eventual consistency: fast writes, backups lag -> stale reads
  await setMode('eventual', 5000);
  await page.click('#burst');
  await page.waitForFunction(() => document.querySelectorAll('#writes tr').length >= 10, null, { timeout: 20000 });
  await wait(1800);
  await readAll(['backup', 'backup', 'primary']);
  await shot('exp6-02-eventual-stale-reads');

  // 3. ... and they converge
  await until(allSynced, 20000);
  await readAll(['backup', 'backup']);
  await shot('exp6-03-eventual-converged');

  // 4. quorum: W=2, R=2. Read right after each ACK, while the slower backup
  //    has not applied the order yet: R=1 backup reads can be stale, quorum reads never are.
  await setMode('quorum', 4000);
  for (let i = 0; i < 3; i++) {
    const rows = await page.locator('#writes tr').count();
    await page.click('#single');
    await page.waitForFunction((n) => document.querySelectorAll('#writes tr').length > n, rows, { timeout: 20000 });
    await readAll(['backup', 'quorum', 'backup', 'quorum']);
  }
  await shot('exp6-04-quorum-reads');
  await until(allSynced, 20000);

  // 5. eventual + primary crash = acknowledged writes lost, logs diverge
  await setMode('eventual', 6000);
  await page.click('#burst');
  await page.waitForFunction(() => document.querySelectorAll('#writes tr').length >= 18, null, { timeout: 20000 });
  await nodeAction('kill', 'node-1');
  await until((c) => c.primaryId === 'node-2' || c.primaryId === 'node-3');
  await nodeAction('restart', 'node-1');
  await until((c) => allSynced(c) && c.nodes[0].role === 'backup', 20000);
  await wait(1200);
  await shot('exp6-05-async-failover-lost-writes');

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
