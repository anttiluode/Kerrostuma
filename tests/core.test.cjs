// Fast checks of the reference engine (node --test tests/). The long receipts live in experiments/run.js.
const test = require('node:test');
const assert = require('node:assert');
const K = require('../core.js');

test('hash3 is deterministic and roughly uniform in [-1,1)', () => {
  assert.strictEqual(K.hash3(1, 2, 3), K.hash3(1, 2, 3));
  let s = 0, s2 = 0, n = 20000, mn = 1, mx = -1;
  for (let i = 0; i < n; i++) { const x = K.hash3(i, 7, 11); s += x; s2 += x * x; mn = Math.min(mn, x); mx = Math.max(mx, x); }
  assert.ok(Math.abs(s / n) < 0.02); assert.ok(Math.abs(s2 / n - 1 / 3) < 0.02); assert.ok(mn >= -1 && mx < 1);
});

test('metric Laplacian matches the analytic torus Laplacian of cos v', () => {
  const G = K.makeGeom({ Nu: 208, Nv: 80, dx: 0.9 });
  const f = new Float32Array(G.N), L = new Float32Array(G.N);
  for (let j = 0; j < G.Nv; j++) for (let i = 0; i < G.Nu; i++) f[j * G.Nu + i] = Math.cos(j * G.dv);
  K.laplace(G, f, L);
  // Δf = f''/r² − sin v · f' / (r h),  f = cos v  →  −cos v / r² + sin² v / (r h)
  let err = 0, mag = 0;
  for (let j = 0; j < G.Nv; j++) {
    const v = j * G.dv, h = G.R + G.r * Math.cos(v);
    const ex = -Math.cos(v) / (G.r * G.r) + Math.sin(v) ** 2 / (G.r * h);
    err = Math.max(err, Math.abs(L[j * G.Nu] - ex)); mag = Math.max(mag, Math.abs(ex));
  }
  assert.ok(err / mag < 0.01, `relative error ${err / mag}`);
});

test('metric Laplacian conserves the area integral (Σ h Δf = 0)', () => {
  const G = K.makeGeom({ Nu: 208, Nv: 80, dx: 0.9 });
  const f = new Float32Array(G.N), L = new Float32Array(G.N);
  for (let k = 0; k < G.N; k++) f[k] = K.hash3(k, 3, 5);
  K.laplace(G, f, L);
  let s = 0, a = 0; for (let j = 0; j < G.Nv; j++) for (let i = 0; i < G.Nu; i++) { s += G.h[j] * L[j * G.Nu + i]; a += G.h[j] * Math.abs(L[j * G.Nu + i]); }
  assert.ok(Math.abs(s) / a < 1e-4);
});

test('molten crust decays, crystal crust grows (ε sign controls the instability)', () => {
  const G = K.makeGeom({ Nu: 104, Nv: 40, dx: 0.9 });
  const rms = (p) => Math.sqrt(p.reduce((a, b) => a + b * b, 0) / p.length);
  const hot = new K.Crust(G, K.law(3, { tauQ: 1e9, noise: 0 }));   // ε stays ≈ −0.25
  const r0 = rms(hot.psi); hot.run(20); assert.ok(rms(hot.psi) < 0.5 * r0);
  const cold = new K.Crust(G, K.law(3, { eps0: 0.3, epsF: 0.3, noise: 0 }));
  const c0 = rms(cold.psi); cold.run(60); assert.ok(rms(cold.psi) > 50 * c0);
});

test('the wind blows only while the crust forms', () => {
  const L = K.law(5, { tauQ: 100 });
  assert.notStrictEqual(K.windAt(L, 1, 19.5), 0);
  assert.strictEqual(K.windAt(L, L.tauQ + 1, 19.5), 0);
  assert.strictEqual(Math.sign(K.windAt(L, 1, 19.5)), L.spin);
});

test('a probe re-melts a disk and leaves the far crust untouched', () => {
  const G = K.makeGeom({ Nu: 104, Nv: 40, dx: 0.9 });
  const C = new K.Crust(G, K.law(9, { tauQ: 10, age: 20 }));
  C.run(30);
  const before = Float32Array.from(C.psi);
  C.probe(50, 20, 6);
  assert.ok(Math.abs(C.psi[K.idx(G, 50, 20)]) < 1e-6);
  assert.strictEqual(C.psi[K.idx(G, 0, 0)], before[K.idx(G, 0, 0)]);
  assert.ok(C.epsLocal(K.idx(G, 50, 20)) < 0);          // the scar is molten again
});

test('life: carriers move, gel grows on vents, shifted control does not correlate', () => {
  const G = K.makeGeom({ Nu: 104, Nv: 40, dx: 0.9 });
  const F = new Float32Array(G.N);
  for (let j = 0; j < G.Nv; j++) for (let i = 0; i < G.Nu; i++) { const d = K.physDist(G, 20, 10, i, j), e = K.physDist(G, 70, 30, i, j); F[j * G.Nu + i] = Math.exp(-d * d / 20) + Math.exp(-e * e / 20); }
  const life = new K.Life(G, F, 1500, 1);
  for (let t = 0; t < 300; t++) life.step();
  for (let k = 0; k < G.N; k++) assert.ok(Number.isFinite(life.T[k]) && Number.isFinite(life.U[k]));
  const lf = K.lifeOnFossils(G, life.M, F);
  assert.ok(lf.r > lf.rShift + 0.1, JSON.stringify(lf));
});
