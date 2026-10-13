/*  Closure test: does the instruments' code close under the planet's own queries?
 *
 *      E(F(X, q)) ≟ g(E(X), q)
 *
 *  X   the full crust (ψ on the torus)                      F(X,q)  what the planet does under query q
 *  E   a code read off the rock                             g       any map from code to next code
 *
 *  If two crusts share a code but the same query sends them to different next codes, the code has
 *  thrown away something the future needs. We measure this directly.
 *
 *  Worlds  τ_Q ∈ {30, 60, 120, 240} × age ∈ {40, 120, 360} × seeds, so cooling rate and age both vary.
 *          One trajectory per (τ_Q, seed); snapshots are taken at each age on the way.
 *  Queries wait   — let the crust sit ΔT = 80 more (ε stays at its final value, no wind)
 *          melt   — re-melt a fixed disk on the outer equator; let it re-cool (τ = 15) and settle (40)
 *  Codes   E0 global census  [log defects, χ]                         what the page shows
 *          E1 + shape         E0 + [coherence, ξ, rms]
 *          E2 + local         E1 + what the rock looks like around the melt site
 *          LAW               the hidden (τ_Q, age), an oracle for comparison
 *  Score   leave-one-out k-NN regression of each next-code from each code, R² (1 = closes, 0 = no better than the mean).
 *          Leave-one-out is by (τ_Q, seed) trajectory, so a world is never predicted from its own past.
 *
 *    node experiments/closure.js            → results/closure.json   (~30–40 min on 2 cores)
 *    node experiments/closure.js summarize  → re-score an existing results/closure.json
 */
'use strict';
const { fork } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');
const K = require('../core.js');
const ROOT = path.join(__dirname, '..');
const OUT = process.env.SMOKE ? '/tmp/closure_smoke.json' : path.join(ROOT, 'results', 'closure.json');

const SMOKE = !!process.env.SMOKE;
const TAUS = SMOKE ? [10, 20] : [30, 60, 120, 240], AGES = SMOKE ? [5, 10] : [40, 120, 360], SEEDS = SMOKE ? [1, 2] : [301, 302, 303];
const WAIT = SMOKE ? 5 : 80, PROBE = { i: SMOKE ? 26 : 88, j: 0, rad: SMOKE ? 6 : 14 }, SETTLE = SMOKE ? 5 : 40;

function clone(C) {
  const D = new K.Crust(C.G, C.L);
  D.psi.set(C.psi); D.pMask.set(C.pMask); D.pT0.set(C.pT0); D.t = C.t; D.step_ = C.step_; D.pTau = C.pTau;
  return D;
}

/** Local look of the rock around the melt site: broken fraction and stripe order inside the disk and in a ring. */
function local(G, psi, F, O) {
  let a = { inF: 0, inA: 0, ringF: 0, ringA: 0, c: 0, s: 0, coh: 0 };
  for (let j = 0; j < G.Nv; j++) for (let i = 0; i < G.Nu; i++) {
    const d = K.physDist(G, PROBE.i, PROBE.j, i, j); if (d > 1.6 * PROBE.rad) continue;
    const k = j * G.Nu + i, w = G.h[j];
    if (d < 0.65 * PROBE.rad) { a.inF += w * (F[k] > 0.5); a.inA += w; }
    else if (d > 1.15 * PROBE.rad) { a.ringF += w * (F[k] > 0.5); a.ringA += w; a.c += w * O.c2[k] * O.coh[k]; a.s += w * O.s2[k] * O.coh[k]; a.coh += w * O.coh[k]; }
  }
  return { brokenIn: a.inF / a.inA, brokenRing: a.ringF / a.ringA, ringC2: a.c / a.ringA, ringS2: a.s / a.ringA, ringCoh: a.coh / a.ringA };
}

function read(G, psi) {
  const c = K.census(G, psi), O = K.orientation(G, psi);
  return { defects: c.defects.perArea, chi: c.chi, coh: c.coh, xi: c.xi, rms: c.rms, ...local(G, psi, c.F, O) };
}

function job(j) {
  const G = K.makeGeom(SMOKE ? { Nu: 104, Nv: 40, dx: 0.9 } : {});
  const L = K.law(j.seed, { tauQ: j.tauQ });
  const C = new K.Crust(G, L);
  const out = [];
  for (const age of AGES) {
    C.run(L.tauQ + age);
    const now = read(G, C.psi);
    const W = clone(C); W.run(W.t + WAIT);
    const M = clone(C); M.probe(PROBE.i, PROBE.j, PROBE.rad); M.run(M.t + M.pTau + SETTLE);
    out.push({ tauQ: j.tauQ, seed: j.seed, age, now, wait: read(G, W.psi), melt: read(G, M.psi) });
  }
  return out;
}

if (process.argv[2] === '--job') { process.on('message', (j) => { process.send(job(j)); process.exit(0); }); return; }

// ------------------------------------------------------------------ scoring
const CODES = {
  E0: s => [Math.log(s.now.defects + 0.05), s.now.chi],
  E1: s => [Math.log(s.now.defects + 0.05), s.now.chi, s.now.coh, Math.log(s.now.xi), s.now.rms],
  E2: s => [Math.log(s.now.defects + 0.05), s.now.chi, s.now.coh, Math.log(s.now.xi), s.now.rms, s.now.brokenIn, s.now.brokenRing, s.now.ringC2, s.now.ringS2, s.now.ringCoh],
  LAW: s => [Math.log(s.tauQ), Math.log(s.age)],
  'E0+age': s => [Math.log(s.now.defects + 0.05), s.now.chi, Math.log(s.age)],      // oracle: does the true age add anything?
  'E0+tauQ': s => [Math.log(s.now.defects + 0.05), s.now.chi, Math.log(s.tauQ)],   // oracle: does the true cooling rate?
};
const NEXT = {
  'wait → defects': s => Math.log(s.wait.defects + 0.05),
  'wait → coherence': s => s.wait.coh,
  'wait → Δdefects': s => Math.log(s.wait.defects + 0.05) - Math.log(s.now.defects + 0.05),
  'melt → broken inside scar': s => s.melt.brokenIn,
  'melt → scar minus ring': s => s.melt.brokenIn - s.melt.brokenRing,
};
function standardize(X) {
  const d = X[0].length, mu = Array(d).fill(0), sd = Array(d).fill(0);
  for (const x of X) x.forEach((v, k) => mu[k] += v / X.length);
  for (const x of X) x.forEach((v, k) => sd[k] += (v - mu[k]) ** 2 / X.length);
  return X.map(x => x.map((v, k) => (v - mu[k]) / (Math.sqrt(sd[k]) || 1)));
}
/** Leave-one-trajectory-out k-NN regression, R². */
function looR2(rows, code, next, k = 3) {
  const X = standardize(rows.map(CODES[code])), y = rows.map(NEXT[next]);
  const my = y.reduce((a, b) => a + b) / y.length;
  let sse = 0, sst = 0;
  rows.forEach((r, i) => {
    const cand = rows.map((q, j) => ({ j, d: Math.hypot(...X[i].map((v, t) => v - X[j][t])) }))
      .filter(c => !(rows[c.j].tauQ === r.tauQ && rows[c.j].seed === r.seed)).sort((a, b) => a.d - b.d).slice(0, k);
    const p = cand.reduce((a, c) => a + y[c.j], 0) / cand.length;
    sse += (y[i] - p) ** 2; sst += (y[i] - my) ** 2;
  });
  return 1 - sse / sst;
}
/** The square, made concrete: pairs whose E0 codes nearly agree but whose hidden pasts differ. */
function matchedPairs(rows) {
  const X = standardize(rows.map(CODES.E0)), pairs = [];
  for (let a = 0; a < rows.length; a++) for (let b = a + 1; b < rows.length; b++) {
    const A = rows[a], B = rows[b];
    if (A.tauQ === B.tauQ && A.age === B.age) continue;
    pairs.push({ a, b, dIn: Math.hypot(...X[a].map((v, t) => v - X[b][t])) });
  }
  pairs.sort((p, q) => p.dIn - q.dIn);
  return pairs.slice(0, 8).map(p => {
    const A = rows[p.a], B = rows[p.b];
    return { A: `τ${A.tauQ} age${A.age} s${A.seed}`, B: `τ${B.tauQ} age${B.age} s${B.seed}`, dIn: +p.dIn.toFixed(3),
      defectsNow: [+A.now.defects.toFixed(2), +B.now.defects.toFixed(2)], defectsAfterWait: [+A.wait.defects.toFixed(2), +B.wait.defects.toFixed(2)],
      scarBroken: [+A.melt.brokenIn.toFixed(3), +B.melt.brokenIn.toFixed(3)] };
  });
}
function score(rows) {
  const table = {};
  for (const n of Object.keys(NEXT)) { table[n] = {}; for (const c of Object.keys(CODES)) table[n][c] = +looR2(rows, c, n).toFixed(3); }
  return { table, pairs: matchedPairs(rows) };
}

(async () => {
  let rows;
  if (process.argv[2] === 'summarize') rows = JSON.parse(fs.readFileSync(OUT)).rows;
  else {
    const jobs = []; for (const tauQ of TAUS) for (const seed of SEEDS) jobs.push({ tauQ, seed });
    rows = [];
    await new Promise((done) => {
      let next = 0, active = 0; const n = Math.max(1, os.cpus().length);
      const launch = () => {
        if (next >= jobs.length) { if (!active) done(); return; }
        const j = jobs[next++]; active++;
        const ch = fork(__filename, ['--job']);
        ch.on('message', (r) => { rows.push(...r); console.log(`[closure] τ${j.tauQ} s${j.seed} ` + r.map(x => `age${x.age}: def ${x.now.defects.toFixed(2)}→${x.wait.defects.toFixed(2)} scar ${x.melt.brokenIn.toFixed(3)}`).join(' | ')); });
        ch.on('exit', () => { active--; launch(); });
        ch.send(j);
      };
      for (let i = 0; i < n; i++) launch();
    });
  }
  const S = score(rows);
  console.log(JSON.stringify(S.table, null, 1));
  console.log(JSON.stringify(S.pairs, null, 1));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ design: { TAUS, AGES, SEEDS, WAIT, PROBE, SETTLE }, rows, ...S }, null, 1));
  console.log('wrote', OUT);
})();
