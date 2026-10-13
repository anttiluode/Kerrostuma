/* Headless end-to-end check of the GPU page (software WebGL is slow; allow ~10–20 min):
 *   python3 -m http.server 8123 &   then   node tests/browser.cjs
 * 1. GPU crust == CPU reference (core.js) for 2000 steps of the same world.
 * 2. Run a whole world (seed 73, the fastest cooler) to the present on the GPU, read it with the instruments.
 * 3. Grow life on the GPU; gel-on-vents vs shifted control.  4. Re-melt a patch and let it re-cool.
 * Writes shots/*.png and shots/browser.json. */
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 680 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto('http://localhost:8123/index.html?scale=0.5#73');
  await page.waitForFunction(() => window.KERROSTUMA && window.KERROSTUMA.S.L, null, { timeout: 60000 });
  fs.mkdirSync('shots', { recursive: true });
  const out = {};
  const shot = async (name, t = 7000) => {
    await page.evaluate(() => { window.KERROSTUMA.S.noRender = false; });
    await page.waitForTimeout(t);
    await page.screenshot({ path: `shots/${name}.png`, timeout: 180000 });
    await page.evaluate(() => { window.KERROSTUMA.S.noRender = true; });
  };
  const runTo = (T) => page.evaluate(async (T) => {
    const K = window.KERROSTUMA; K.S.paused = true; K.S.noRender = true; K.cam.auto = false;
    while (K.S.t < T) { for (let j = 0; j < 1500 && K.S.t < T; j++) K.crustStep(); K.readPsi(); await new Promise(r => setTimeout(r, 0)); }
    const p = K.readPsi(); let s = 0; for (const x of p) s += x * x; K.S.gain = Math.min(400, Math.max(1, 0.45 / Math.sqrt(s / p.length + 1e-12)));
  }, T);
  out.parity = await page.evaluate(() => {
    const K = window.KERROSTUMA; K.S.paused = true; K.S.noRender = true; K.newWorld(73);
    const n = 2000; for (let i = 0; i < n; i++) K.crustStep();
    const gpu = K.readPsi();
    const C = new KER.Crust(K.G, KER.law(73)); for (let i = 0; i < n; i++) C.step();
    let md = 0, ma = 0; for (let k = 0; k < gpu.length; k++) { md = Math.max(md, Math.abs(gpu[k] - C.psi[k])); ma = Math.max(ma, Math.abs(C.psi[k])); }
    return { steps: n, maxAbsDiff: md, maxAbsPsi: ma, relErr: md / ma };
  });
  console.log('parity', JSON.stringify(out.parity));
  await page.evaluate(() => { const K = window.KERROSTUMA; K.cam.yaw = 0.6; K.cam.pitch = 0.55; K.cam.dist = 4.4; });
  await runTo(8); await shot('1-molten');
  await runTo(30); await shot('2-cooling');
  const L = await page.evaluate(() => window.KERROSTUMA.S.L);
  await runTo(L.tauQ + L.age);
  out.present = await page.evaluate(() => { const K = window.KERROSTUMA; K.measure(); const c = K.S.census; const R = KER.readPlanet(c, null);
    return { tauQ: K.S.L.tauQ, spin: K.S.L.spin, xi: c.xi, chi: c.chi, defects: c.defects.perArea, coh: c.coh, verdict: document.getElementById('verdict').innerText }; });
  console.log('present', JSON.stringify(out.present));
  await shot('3-present');
  out.life = await page.evaluate(async () => {
    const K = window.KERROSTUMA; K.startLife();
    for (let i = 0; i < 900; i++) { K.lifeTick(); if (i % 50 === 0) await new Promise(r => setTimeout(r, 0)); }
    K.measure(); return { ...K.S.lifeStat, verdict: document.getElementById('verdict').innerText };
  });
  console.log('life', JSON.stringify(out.life));
  await page.evaluate(() => { const K = window.KERROSTUMA; K.cam.yaw = 2.2; K.cam.pitch = 0.75; K.cam.dist = 3.6; document.getElementById('layer').value = '1'; document.getElementById('layer').onchange(); });
  await shot('4-life');
  // probe: re-melt a patch facing the camera, then let it re-cool on the GPU
  out.probe = await page.evaluate(async () => {
    const K = window.KERROSTUMA; K.probeAt(40, 0);
    const end = K.S.scarUntil; while (K.S.t < end) { for (let j = 0; j < 1000 && K.S.t < end; j++) K.crustStep(); await new Promise(r => setTimeout(r, 0)); }
    K.measure(); return document.getElementById('mProbe').innerText;
  });
  console.log('probe', out.probe);
  out.reveal = await page.evaluate(() => { document.getElementById('bReveal').click(); return document.getElementById('truth').innerText; });
  console.log('reveal', out.reveal);
  await shot('5-reveal');
  out.errors = errors.filter(e => !/favicon/.test(e));
  console.log('errors', JSON.stringify(out.errors));
  fs.writeFileSync('shots/browser.json', JSON.stringify(out, null, 1));
  await browser.close();
})();
