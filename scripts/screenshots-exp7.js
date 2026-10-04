// Drives the Exp 7 (load balancing) tab and saves screenshots to docs/screenshots.
// Start the app first (npm start), then: npm run screenshots:exp7

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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const post = (url, body) => page.evaluate(([u, b]) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }), [url, body]);
  const state = () => page.evaluate(() => fetch('/api/lb/state').then((r) => r.json()));
  const until = async (fn, timeout = 90000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await fn(await state())) return;
      await wait(250);
    }
    throw new Error('timeout');
  };
  const shot = async (name) => {
    await wait(800);
    await page.addStyleTag({ content: '#toast{display:none}' });
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
    console.log('saved', name);
  };
  const idle = (s) => !s.comparing && (!s.run || !s.run.running) && s.servers.every((x) => !x.healthy || (x.queued === 0 && x.active === 0));
  const allHealthy = (s) => s.servers.every((x) => x.healthy);
  const runTest = async (algo) => {
    await until(idle);
    await page.click(`[data-algo="${algo}"]`);
    await wait(300);
    await page.click('#lb-run');
    await until((s) => s.run && s.run.running && s.run.algorithm === algo);
  };
  const finished = () => until((s) => s.run && !s.run.running);

  await page.goto(`${BASE}/#exp7`);
  await post('/api/lb/reset', {});
  await post('/api/lb/config', { rate: 60, duration: 15 });
  await page.reload();
  await until(allHealthy);

  // 1. Round robin: equal counts, the weak server-3 queues up
  await runTest('round_robin');
  await until((s) => (Date.now() - s.run.started) / 1000 > 11);
  await shot('exp7-01-round-robin-overload');
  await finished();

  // 2. Weighted round robin
  await runTest('weighted_round_robin');
  await finished();
  await shot('exp7-02-weighted-round-robin');

  // 3. Least connections (mid-run)
  await runTest('least_connections');
  await until((s) => (Date.now() - s.run.started) / 1000 > 9);
  await shot('exp7-03-least-connections-live');
  await finished();

  // 4. Random, then IP hash
  await runTest('random');
  await finished();
  await runTest('ip_hash');
  await finished();
  await shot('exp7-04-ip-hash-hotspot');

  // 5. Comparison of all five
  await page.locator('#lb-history').locator('xpath=ancestor::section').screenshot({ path: path.join(OUT, 'exp7-05-algorithm-comparison.png') });
  console.log('saved exp7-05-algorithm-comparison');

  // 6. Server failure during a test: health check removes it, requests are retried
  await post('/api/lb/config', { duration: 20 });
  await page.reload();
  await runTest('least_connections');
  await until((s) => (Date.now() - s.run.started) / 1000 > 5);
  await page.locator('[data-lbkill="server-1"]').dispatchEvent('pointerdown');
  await until((s) => !s.servers[0].healthy);
  await wait(3500);
  await shot('exp7-06-server-failure');
  await page.locator('[data-lbrestart="server-1"]').dispatchEvent('pointerdown');
  await finished();
  await shot('exp7-07-server-recovered');

  await post('/api/lb/config', { duration: 15 });
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
