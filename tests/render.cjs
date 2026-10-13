/* Quick visual check: inject a finished crust computed by core.js, optionally grow life on the GPU,
 * and render frames from a few camera angles.
 *   python3 -m http.server 8123 &
 *   LIFE=600 VIEWS='[[0.6,0.42,3.3]]' node tests/render.cjs crust.bin
 * Needs Playwright (Chromium). Screenshots go to shots/. */
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const psi = Array.from(new Float32Array(fs.readFileSync(process.argv[2]).buffer.slice(0)));
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: +(process.env.W || 960), height: +(process.env.H || 600) } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto('http://localhost:8123/index.html?scale=' + (process.env.SCALE || 0.5) + '#7');
  await page.waitForFunction(() => window.KERROSTUMA && window.KERROSTUMA.S.L);
  await page.evaluate((psi) => {
    const K = window.KERROSTUMA; const S = K.S; S.paused = true; S.noRender = true;
    S.L = KER.law(7, { tauQ: 60 }); S.t = S.L.tauQ + S.L.age + 1;
    K.injectPsi(new Float32Array(psi));
  }, psi);
  if (process.env.LIFE) {
    await page.evaluate(async (n) => { const K = window.KERROSTUMA; K.startLife(); for (let i = 0; i < n; i++) { K.lifeTick(); if (i % 25 === 0) await new Promise(r => setTimeout(r, 0)); } K.measure(); }, +process.env.LIFE);
  } else await page.evaluate(() => window.KERROSTUMA.measure());
  const views = JSON.parse(process.env.VIEWS || '[[0.6,0.42,3.3]]');
  fs.mkdirSync('shots', { recursive: true });
  let i = 0;
  for (const [yaw, pitch, dist, layer] of views) {
    await page.evaluate(([y, p, d, l]) => {
      const K = window.KERROSTUMA; K.cam.yaw = y; K.cam.pitch = p; K.cam.dist = d; K.cam.auto = false; K.S.noRender = false;
      const sel = document.getElementById('layer'); sel.value = l ? '1' : '0'; sel.onchange();
    }, [yaw, pitch, dist, layer || 0]);
    await page.waitForTimeout(+(process.env.WAIT || 6000));
    await page.screenshot({ path: `shots/${process.env.PREFIX || 'view'}${i++}.png`, timeout: 180000 });
    await page.evaluate(() => { window.KERROSTUMA.S.noRender = true; });
  }
  console.log(JSON.stringify(await page.evaluate(() => { const c = window.KERROSTUMA.S.census; return c && { xi: c.xi, chi: c.chi, def: c.defects.perArea, life: window.KERROSTUMA.S.lifeStat }; })));
  console.log('errors', JSON.stringify(errors));
  await browser.close();
})();
