/*  Reproducible receipts for Kerrostuma, on the exact demo geometry (352 × 136 torus).
 *
 *    node experiments/run.js            # everything (≈ 40 min on 2 cores)
 *    node experiments/run.js summarize  # recompute calibration.json and the blind reading from results/receipt.json
 *
 *  1. calibration  τ_Q ∈ {30,60,120,240,450} × 2 seeds  → calibration.json (defects vs τ_Q)
 *  2. null band    no wind, 6 seeds                     → chiNull (largest |χ| seen without wind)
 *  3. blind test   8 fresh worlds from KER.law(seed)    → read cooling + spin with the calibration,
 *                                                         compare with the hidden law
 *  4. life         grow life on 3 worlds (CPU), gel-on-vents r vs shifted control, pulse reach vs shuffled gel
 *  Results → results/receipt.json. Every job runs in its own process.
 */
'use strict';
const { fork } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const K = require('../core.js');
const ROOT = path.join(__dirname, '..');

function crustJob(j) {
  const G = K.makeGeom({});
  const L = K.law(j.seed, j.over || {});
  const C = new K.Crust(G, L);
  const t0 = Date.now();
  C.run(L.tauQ + L.age);
  const c = K.census(G, C.psi);
  const out = { ...j, tauQ: L.tauQ, spin: L.wind === 0 ? 0 : L.spin, U0: K.windAt(L, 0, G.r),
    xi: c.xi, chi: c.chi, defects: c.defects.perArea, nDef: c.defects.count, coh: c.coh, secs: (Date.now() - t0) / 1000 };
  if (j.life) Object.assign(out, lifeOn(G, L, C.psi, c.F));
  return out;
}

/** Grow life on a finished crust (CPU), then the two life receipts. */
function lifeOn(G, L, psi, F) {
  const life = new K.Life(G, F, 20000, L.seed);
  for (let t = 0; t < 1500; t++) life.step();
  const lf = K.lifeOnFossils(G, life.M, F);
  // pulse reach: same gel vs gel shuffled cell-by-cell (same histogram), identical pulse, frozen material
  const reach = (M) => {
    const lf2 = new K.Life(G, F, 0, L.seed); lf2.M = Float32Array.from(M); lf2.P = { ...K.LIFE, spark: 0, gelGrow: 0, gelDecay: 0 };
    let best = 0, kb = 0; for (let k = 0; k < G.N; k++) if (M[k] * F[k] > best) { best = M[k] * F[k]; kb = k; }
    const ci = kb % G.Nu, cj = (kb / G.Nu) | 0;
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) lf2.U[K.idx(G, ci + di, cj + dj)] = 1;
    const ever = new Uint8Array(G.N);
    for (let t = 0; t < 400; t++) { lf2.field(); for (let k = 0; k < G.N; k++) if (lf2.U[k] > 0.5) ever[k] = 1; }
    let n = 0; for (let k = 0; k < G.N; k++) n += ever[k]; return { n, src: kb };
  };
  const grown = reach(life.M);
  // shuffle gel values outside a protected 5x5 source neighbourhood (Fisher–Yates, seeded)
  const Ms = Float32Array.from(life.M), protect = new Set();
  const ci = grown.src % G.Nu, cj = (grown.src / G.Nu) | 0;
  for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++) protect.add(K.idx(G, ci + di, cj + dj));
  const free = []; for (let k = 0; k < G.N; k++) if (!protect.has(k)) free.push(k);
  for (let a = free.length - 1; a > 0; a--) { const b = Math.floor((0.5 + 0.5 * K.hash3(a, L.seed, 99)) * (a + 1)); const t = Ms[free[a]]; Ms[free[a]] = Ms[free[b]]; Ms[free[b]] = t; }
  const shuffled = reach(Ms);
  let gel = 0; for (let k = 0; k < G.N; k++) gel += life.M[k] > 0.3;
  return { lifeR: lf.r, lifeRShift: lf.rShift, gelCells: gel, reachGrown: grown.n, reachShuffled: shuffled.n };
}

if (process.argv[2] === '--job') {
  process.on('message', (j) => { process.send(crustJob(j)); process.exit(0); });
  return;
}

async function runAll(jobs, label) {
  const n = Math.max(1, os.cpus().length), out = [];
  let next = 0;
  await new Promise((done) => {
    let active = 0;
    const launch = () => {
      if (next >= jobs.length) { if (active === 0) done(); return; }
      const j = jobs[next++]; active++;
      const ch = fork(__filename, ['--job']);
      ch.on('message', (r) => { out.push(r); console.log(`[${label}] ${JSON.stringify(r)}`); });
      ch.on('exit', () => { active--; launch(); });
      ch.send(j);
    };
    for (let i = 0; i < n; i++) launch();
  });
  return out;
}

(async () => {
  const only = process.argv[2];
  const receiptPath = path.join(ROOT, 'results', 'receipt.json');
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  const R = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath)) : {};

  if (!only || only === 'calib') {
    const jobs = [];
    for (const tauQ of [30, 60, 120, 240, 450]) for (const seed of [101, 102]) jobs.push({ seed, over: { tauQ } });
    R.calibration = await runAll(jobs, 'calib');
  }
  if (!only || only === 'null') {
    const jobs = [];
    for (const seed of [201, 202, 203, 204, 205, 206]) jobs.push({ seed, over: { tauQ: seed % 2 ? 30 : 60, wind: 0 } });
    R.nullRuns = await runAll(jobs, 'null');
  }
  // calibration file for the page
  if (R.calibration && R.nullRuns) {
    const by = {};
    for (const r of R.calibration) (by[r.over.tauQ] = by[r.over.tauQ] || []).push(r.defects);
    const points = Object.keys(by).map(Number).sort((a, b) => a - b).map(t => ({ tauQ: t, value: by[t].reduce((a, b) => a + b) / by[t].length, values: by[t] }));
    const fast = R.calibration.filter(r => r.tauQ < K.FAST_SLOW_TAU).map(r => r.defects);
    const slow = R.calibration.filter(r => r.tauQ >= K.FAST_SLOW_TAU).map(r => r.defects);
    const gm = a => Math.exp(a.reduce((s, x) => s + Math.log(x), 0) / a.length);
    const threshold = Math.sqrt(gm(fast) * gm(slow));
    const sepOK = Math.min(...fast) > threshold && Math.max(...slow) < threshold;
    const chiNull = Math.max(...R.nullRuns.map(r => Math.abs(r.chi)));
    const calib = { feature: 'defects', threshold: +threshold.toFixed(3), separatesAll: sepOK, points, chiNull: +chiNull.toFixed(3), geometry: { Nu: 352, Nv: 136, dx: 0.9 }, note: 'generated by experiments/run.js' };
    fs.writeFileSync(path.join(ROOT, 'calibration.json'), JSON.stringify(calib, null, 1));
    R.calib = calib;
  }
  if (!only || only === 'blind') {
    const jobs = [];
    for (const seed of [11, 23, 37, 41, 59, 67, 73, 89]) jobs.push({ seed, life: seed === 11 || seed === 37 || seed === 73 });
    R.blind = (await runAll(jobs, 'blind')).sort((a, b) => a.seed - b.seed);
  }
  // blind reading: the calibration never saw these worlds
  if (R.blind && R.calib) {
    for (const r of R.blind) {
      const read = K.readPlanet({ chi: r.chi, xi: r.xi, defects: { perArea: r.defects } }, R.calib);
      r.readCool = read.cool; r.trueCool = K.trueCool({ tauQ: r.tauQ });
      r.readSpin = read.spin; r.coolOK = read.cool === r.trueCool; r.spinOK = read.spin === 0 ? null : read.spin === r.spin;
    }
    const n = R.blind.length, spinClaimed = R.blind.filter(r => r.spinOK !== null);
    R.summary = {
      coolingCorrect: `${R.blind.filter(r => r.coolOK).length}/${n}`,
      spinClaimed: `${spinClaimed.length}/${n}`, spinCorrectWhenClaimed: `${spinClaimed.filter(r => r.spinOK).length}/${spinClaimed.length}`,
      life: R.blind.filter(r => r.lifeR != null).map(r => ({ seed: r.seed, r: +r.lifeR.toFixed(3), rShift: +r.lifeRShift.toFixed(3), reachGrown: r.reachGrown, reachShuffled: r.reachShuffled })),
    };
    console.log('summary', JSON.stringify(R.summary));
  }
  fs.writeFileSync(receiptPath, JSON.stringify(R, null, 1));
  console.log('wrote', receiptPath);
})();
