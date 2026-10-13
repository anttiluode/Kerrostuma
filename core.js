/*  Kerrostuma core — the laws of the planet, written once on the CPU so they can
 *  be tested, and mirrored line for line by the GPU shaders in index.html.
 *
 *  THE PLANET IS A TORUS.  Not for style: a periodic grid maps onto a torus with
 *  no seam and no poles. The field lives on the curved surface, so every
 *  derivative uses the torus metric
 *        ds² = h(v)² du² + r² dv²,     h(v) = R + r cos v
 *  (u: the long way round, v: round the tube; v = 0 is the outer equator).
 *
 *  THE CRUST: Swift–Hohenberg, quenched.
 *        ∂ψ/∂t = ε(t) ψ − (1 + ∇²)² ψ − ψ³ − U(v) ∂ψ/∂s + noise
 *  ε(t) ramps from −0.25 (molten: every pattern decays) to +0.30 (crystal) over
 *  the hidden time τ_Q. The faster the ramp, the less time domains have to agree
 *  on a direction, and the more broken the frozen crust (the Kibble–Zurek idea).
 *  U(v) = U₀ sin v is a zonal wind that blows only while the crust forms. Shear
 *  tilts the stripes' wavevectors (dk_v/dt = −U′ k_u), so the sign of U₀, the
 *  planet's spin, is combed into the rock as chevron belts. The wind then dies;
 *  the chevrons stay.
 *
 *  LIFE (ported from GelatinIsland): carriers feed where the crust is
 *  frustrated (amplitude dips = defects and grain boundaries), lay trail, the
 *  trail consolidates into gel, and the gel conducts excitation pulses.
 *
 *  Honest note: the planet is a model. Nothing here claims real planets form
 *  this way. What the tests check is narrower: that the frozen crust carries a
 *  readable record of the hidden cooling rate and spin, and that life organizes
 *  on that record, each against a matched control.
 */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.KER = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ hashing
  // Same integer hash in GLSL (uint ops). Returns a value in [-1, 1).
  function hash3(i, j, k) {
    let x = (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791)) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
    x = (x ^ (x >>> 16)) >>> 0;
    return x / 4294967296 * 2 - 1;
  }
  function rnd(seed, k) { return 0.5 + 0.5 * hash3(seed, k, 977); }

  // ------------------------------------------------------------------ geometry
  /** Torus grid. dx is the physical cell size at the tube centre (R Δu = r Δv = dx). */
  function makeGeom(opt = {}) {
    const Nu = opt.Nu || 352, Nv = opt.Nv || 136, dx = opt.dx || 0.9;
    const du = 2 * Math.PI / Nu, dv = 2 * Math.PI / Nv;
    const R = dx / du, r = dx / dv;
    const h = new Float64Array(Nv), hp = new Float64Array(Nv), hm = new Float64Array(Nv);
    for (let j = 0; j < Nv; j++) {
      const v = j * dv;
      h[j] = R + r * Math.cos(v);
      hp[j] = R + r * Math.cos(v + 0.5 * dv);
      hm[j] = R + r * Math.cos(v - 0.5 * dv);
    }
    // explicit stability for −(1+∇²)²: dt·(1−λmax)² < 2, λmax from the smallest cells (inner equator)
    const hin = R - r;
    const lmax = 4 / (hin * du) ** 2 + 4 / (r * dv) ** 2;
    const dt = opt.dt || +(1.6 / ((1 - lmax) ** 2)).toPrecision(2);
    return { Nu, Nv, dx, du, dv, R, r, h, hp, hm, dt, N: Nu * Nv };
  }

  // ------------------------------------------------------------------ the law
  /** The hidden law of world `seed`. Cooling time τ_Q and spin are what the crust must remember. */
  function law(seed, over = {}) {
    const u = (k) => rnd(seed, k);
    const L = {
      seed,
      tauQ: 30 * Math.pow(15, u(1)),          // 30 … 450, log-uniform: fast to slow cooling
      spin: u(2) < 0.5 ? -1 : 1,
      wind: 0.8 + 0.4 * u(3),                 // wind strength (shear rate γ = wind·gamma0 at the tube)
      gamma0: 0.045, windEps: 0.0, windT: 60,  // the wind blows from the molten start until windT after ε crosses windEps
      eps0: -0.25, epsF: 0.30,
      age: 120,                               // fixed and known in this demo (see README: the age–rate gauge)
      noiseUntil: 0.6,                        // noise is injected during the first 60% of the quench
      noise: 1e-4,
      hue: u(4),
    };
    Object.assign(L, over);
    L.U0 = L.spin * L.wind;
    return L;
  }

  function epsAt(L, t) { return L.eps0 + (L.epsF - L.eps0) * Math.min(1, Math.max(0, t / L.tauQ)); }
  /** Zonal wind speed at the tube's top (multiply by sin v). It blows for a fixed window while the crust sets. */
  function windStart(L) { return L.tauQ * (L.windEps - L.eps0) / (L.epsF - L.eps0); }
  function windEnd(L) { return Math.min(L.tauQ, windStart(L) + L.windT); }
  function windAt(L, t, r) { return t < windEnd(L) ? L.spin * L.wind * L.gamma0 * r : 0; }

  // ------------------------------------------------------------------ operators
  function idx(G, i, j) { return ((j + G.Nv) % G.Nv) * G.Nu + ((i + G.Nu) % G.Nu); }

  /** Metric Laplacian on the torus (conservative form). */
  function laplace(G, src, dst) {
    const { Nu, Nv, du, dv, r, h, hp, hm } = G;
    const iu2 = 1 / (du * du), ir2v = 1 / (r * r * dv * dv);
    for (let j = 0; j < Nv; j++) {
      const jn = (j + 1) % Nv, js = (j - 1 + Nv) % Nv;
      const cu = iu2 / (h[j] * h[j]);
      const cvp = hp[j] / h[j] * ir2v, cvm = hm[j] / h[j] * ir2v;
      const row = j * Nu, rn = jn * Nu, rs = js * Nu;
      for (let i = 0; i < Nu; i++) {
        const ie = i + 1 === Nu ? 0 : i + 1, iw = i === 0 ? Nu - 1 : i - 1;
        const c = src[row + i];
        dst[row + i] = cu * (src[row + ie] + src[row + iw] - 2 * c)
          + cvp * (src[rn + i] - c) - cvm * (c - src[rs + i]);
      }
    }
  }

  // ------------------------------------------------------------------ the crust
  class Crust {
    constructor(G, L) {
      this.G = G; this.L = L;
      this.psi = new Float32Array(G.N);
      this.l1 = new Float32Array(G.N);
      this.l2 = new Float32Array(G.N);
      this.step_ = 0; this.t = 0;
      // probe scars: per-cell melt mask and the time the melt began
      this.pMask = new Float32Array(G.N);
      this.pT0 = new Float32Array(G.N);
      this.pTau = 15;
      for (let k = 0; k < G.N; k++) this.psi[k] = 1e-3 * hash3(k, L.seed, 1);
    }
    /** Local ε including probe scars (re-melted patches re-cool at the probe's known rate). */
    epsLocal(k) {
      const e = epsAt(this.L, this.t);
      const m = this.pMask[k];
      if (m <= 0) return e;
      const L = this.L, s = (this.t - this.pT0[k]) / this.pTau;
      const ep = L.eps0 + (L.epsF - L.eps0) * Math.min(1, Math.max(0, s));
      return e + (ep - e) * m;
    }
    step() {
      const G = this.G, L = this.L, dt = G.dt, psi = this.psi;
      laplace(G, psi, this.l1);
      laplace(G, this.l1, this.l2);
      const U = windAt(L, this.t, G.r);
      const noisy = this.t < L.noiseUntil * L.tauQ;
      const namp = L.noise * Math.sqrt(dt);
      const { Nu, Nv, du, h } = G;
      for (let j = 0; j < Nv; j++) {
        const sv = Math.sin(j * G.dv), adv = U * sv / (2 * h[j] * du);
        const row = j * Nu;
        for (let i = 0; i < Nu; i++) {
          const k = row + i;
          const p = psi[k];
          const ie = i + 1 === Nu ? 0 : i + 1, iw = i === 0 ? Nu - 1 : i - 1;
          const e = this.epsLocal(k);
          let f = (e - 1) * p - 2 * this.l1[k] - this.l2[k] - p * p * p;
          f -= adv * (psi[row + ie] - psi[row + iw]);
          let np = p + dt * f;
          if (noisy || this.pMask[k] > 0 && this.t - this.pT0[k] < 0.6 * this.pTau) np += namp * hash3(k, this.step_, L.seed);
          this.l2[k] = np;                   // reuse l2 as the output buffer
        }
      }
      const tmp = this.psi; this.psi = this.l2; this.l2 = tmp;
      this.step_++; this.t += dt;
    }
    run(T) { while (this.t < T - 1e-9) this.step(); }
    /** Re-melt a disk (physical radius rad) around cell (ci,cj); it re-cools at the probe rate. */
    probe(ci, cj, rad = 14) {
      const G = this.G;
      for (let j = 0; j < G.Nv; j++) for (let i = 0; i < G.Nu; i++) {
        const d = physDist(G, ci, cj, i, j);
        const m = 1 - smoothstep(0.7 * rad, rad, d);
        if (m <= 0) continue;
        const k = idx(G, i, j);
        this.pMask[k] = Math.max(this.pMask[k], m);
        this.pT0[k] = this.t;
        this.psi[k] *= (1 - m);
      }
    }
  }

  function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
  /** Approximate geodesic distance for short ranges (local flat metric at the midpoint). */
  function physDist(G, i0, j0, i1, j1) {
    let di = i1 - i0, dj = j1 - j0;
    di -= Math.round(di / G.Nu) * G.Nu; dj -= Math.round(dj / G.Nv) * G.Nv;
    const hm = G.R + G.r * Math.cos((j0 + 0.5 * dj) * G.dv);
    return Math.hypot(di * G.du * hm, dj * G.dv * G.r);
  }

  // ------------------------------------------------------------------ the instruments
  /** Physical gradients (∂/∂s along u, ∂/∂n along v). */
  function grads(G, psi) {
    const gx = new Float32Array(G.N), gy = new Float32Array(G.N);
    const { Nu, Nv, du, dv, r, h } = G;
    for (let j = 0; j < Nv; j++) {
      const jn = (j + 1) % Nv, js = (j - 1 + Nv) % Nv;
      for (let i = 0; i < Nu; i++) {
        const ie = (i + 1) % Nu, iw = (i - 1 + Nu) % Nu, k = j * Nu + i;
        gx[k] = (psi[j * Nu + ie] - psi[j * Nu + iw]) / (2 * h[j] * du);
        gy[k] = (psi[jn * Nu + i] - psi[js * Nu + i]) / (2 * r * dv);
      }
    }
    return { gx, gy };
  }
  function blur(G, a, iters) {
    let src = Float32Array.from(a), dst = new Float32Array(G.N);
    const { Nu, Nv } = G;
    for (let it = 0; it < iters; it++) {
      for (let j = 0; j < Nv; j++) {
        const jn = (j + 1) % Nv, js = (j - 1 + Nv) % Nv;
        for (let i = 0; i < Nu; i++) {
          const ie = (i + 1) % Nu, iw = (i - 1 + Nu) % Nu;
          dst[j * Nu + i] = 0.5 * src[j * Nu + i] + 0.125 * (src[j * Nu + ie] + src[j * Nu + iw] + src[jn * Nu + i] + src[js * Nu + i]);
        }
      }
      const t = src; src = dst; dst = t;
    }
    return src;
  }

  /** Orientation of the stripes' wavevector in the physical frame, from the smoothed structure tensor. */
  function orientation(G, psi, iters = 6) {
    const { gx, gy } = grads(G, psi);
    const xx = new Float32Array(G.N), yy = new Float32Array(G.N), xy = new Float32Array(G.N);
    for (let k = 0; k < G.N; k++) { xx[k] = gx[k] * gx[k]; yy[k] = gy[k] * gy[k]; xy[k] = gx[k] * gy[k]; }
    const Jxx = blur(G, xx, iters), Jyy = blur(G, yy, iters), Jxy = blur(G, xy, iters);
    const c2 = new Float32Array(G.N), s2 = new Float32Array(G.N), coh = new Float32Array(G.N);
    for (let k = 0; k < G.N; k++) {
      const a = Jxx[k] - Jyy[k], b = 2 * Jxy[k], n = Math.hypot(a, b);
      c2[k] = n > 0 ? a / n : 0; s2[k] = n > 0 ? b / n : 0;
      coh[k] = n / (Jxx[k] + Jyy[k] + 1e-12);
    }
    return { c2, s2, coh };
  }

  /** Food for life: where the crust is frustrated. A² = ψ² + |∇ψ|² is flat on perfect stripes and dips at defects. */
  function frustration(G, psi) {
    const { gx, gy } = grads(G, psi);
    const a2 = new Float32Array(G.N);
    for (let k = 0; k < G.N; k++) a2[k] = psi[k] * psi[k] + gx[k] * gx[k] + gy[k] * gy[k];
    const s = blur(G, a2, 3);
    let mean = 0; for (let k = 0; k < G.N; k++) mean += s[k]; mean /= G.N;
    const F = new Float32Array(G.N);
    for (let k = 0; k < G.N; k++) F[k] = mean > 1e-9 ? smoothstep(0.85, 0.45, s[k] / mean) : 0;
    return F;
  }

  /** Count defects: connected blobs of strong frustration, per 1000 physical area units. */
  function defectCount(G, F, thr = 0.5) {
    const seen = new Uint8Array(G.N); let n = 0;
    const stack = [];
    for (let k0 = 0; k0 < G.N; k0++) {
      if (seen[k0] || F[k0] < thr) continue;
      n++; seen[k0] = 1; stack.push(k0);
      while (stack.length) {
        const k = stack.pop(), i = k % G.Nu, j = (k / G.Nu) | 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const kk = idx(G, i + di, j + dj);
          if (!seen[kk] && F[kk] >= thr) { seen[kk] = 1; stack.push(kk); }
        }
      }
    }
    const area = 4 * Math.PI * Math.PI * G.R * G.r;
    return { count: n, perArea: 1000 * n / area };
  }

  /** Domain length ξ: distance where the orientation correlation Re<z z*> (z = e^{2iθ}) falls to 1/e. */
  function domainLength(G, O) {
    const { Nu, Nv } = G;
    const maxLag = Math.floor(Nv / 2);
    const corr = new Float64Array(maxLag + 1);
    // along v (uniform spacing r Δv)
    for (let L = 0; L <= maxLag; L++) {
      let s = 0;
      for (let j = 0; j < Nv; j++) {
        const jj = (j + L) % Nv;
        for (let i = 0; i < Nu; i++) {
          const a = j * Nu + i, b = jj * Nu + i;
          s += O.c2[a] * O.c2[b] + O.s2[a] * O.s2[b];
        }
      }
      corr[L] = s / G.N;
    }
    // along u, binned by physical distance into the same lag units
    const cu = new Float64Array(maxLag + 1), nu = new Float64Array(maxLag + 1);
    for (let j = 0; j < Nv; j++) {
      const step = G.h[j] * G.du / (G.r * G.dv);
      for (let L = 0; L <= maxLag * 1.6; L++) {
        const b = Math.round(L * step); if (b > maxLag) break;
        let s = 0;
        for (let i = 0; i < Nu; i++) {
          const a = j * Nu + i, c = j * Nu + (i + L) % Nu;
          s += O.c2[a] * O.c2[c] + O.s2[a] * O.s2[c];
        }
        cu[b] += s / Nu; nu[b]++;
      }
    }
    const lag = G.r * G.dv;
    const both = [];
    for (let L = 0; L <= maxLag; L++) both.push(nu[L] > 0 ? 0.5 * (corr[L] + cu[L] / nu[L]) : corr[L]);
    const c0 = both[0] || 1;
    for (let L = 1; L <= maxLag; L++) {
      const c = both[L] / c0;
      if (c < Math.exp(-1)) {
        const p = both[L - 1] / c0;
        return lag * (L - 1 + (p - Math.exp(-1)) / Math.max(1e-9, p - c));
      }
    }
    return lag * maxLag;
  }

  /** Chevron index χ = <sin 2θ · coherence · sign(cos v)>, area-weighted. Its sign is −sign(spin). */
  function chevron(G, O) {
    let s = 0, w = 0;
    for (let j = 0; j < G.Nv; j++) {
      const sg = Math.sign(Math.cos(j * G.dv)), a = G.h[j];
      for (let i = 0; i < G.Nu; i++) { const k = j * G.Nu + i; s += a * sg * O.s2[k] * O.coh[k]; w += a; }
    }
    return s / w;
  }

  /** Everything an observer can read off the frozen crust. */
  function census(G, psi) {
    const O = orientation(G, psi), F = frustration(G, psi);
    let coh = 0; for (let k = 0; k < G.N; k++) coh += O.coh[k]; coh /= G.N;
    let rms = 0; for (let k = 0; k < G.N; k++) rms += psi[k] * psi[k]; rms = Math.sqrt(rms / G.N);
    return { xi: domainLength(G, O), chi: chevron(G, O), defects: defectCount(G, F), coh, rms, F };
  }

  /** What the instruments conclude.
   *  Spin: only when |χ| exceeds the largest |χ| seen on no-wind worlds (chiNull).
   *  Cooling: a two-class reading, fast or slow, from defect density against the threshold that
   *  separated the calibration worlds (experiments/run.js, same geometry). The calibration is too
   *  noisy inside each class to claim a number, so no number is claimed. */
  function featureOf(c, name) { return name === 'xi' ? c.xi : c.defects.perArea; }
  const FAST_SLOW_TAU = Math.sqrt(60 * 120);   // truth boundary between the two calibrated classes
  function readPlanet(c, calib) {
    const out = { spin: 0, cool: null };
    const nullBand = calib && calib.chiNull ? calib.chiNull : 0.2;
    if (Math.abs(c.chi) > nullBand) out.spin = c.chi < 0 ? +1 : -1;
    if (calib && calib.threshold) out.cool = featureOf(c, calib.feature) > calib.threshold ? 'fast' : 'slow';
    return out;
  }
  function trueCool(L) { return L.tauQ < FAST_SLOW_TAU ? 'fast' : 'slow'; }

  // ------------------------------------------------------------------ life
  const LIFE = {
    sd: 6.0, sa: 0.5, ra: 0.38, step: 0.7,    // carrier sensing distance/angle, turn angle, step (physical units)
    wFood: 3.0, wGel: 0.0, wRef: 1.0,          // sensed = T + wFood N + wGel M − wRef V
    deposit: 0.25, decay: 0.92, diff: 0.25, tCap: 12, tSat: 1.5, regrow: 0.004, eat: 0.05,
    gelGrow: 0.03, gelTh: 2.5, gelDecay: 0.0012,
    exK: 1.6, exD: 0.1, recov: 0.03, refr: 1.0, spark: 0.0003,
  };

  class Life {
    constructor(G, F, nAgents, seed, P = LIFE) {
      this.G = G; this.P = P; this.seed = seed; this.tick = 0;
      this.F = F;
      this.T = new Float32Array(G.N); this.M = new Float32Array(G.N);
      this.U = new Float32Array(G.N); this.V = new Float32Array(G.N);
      this.Nf = Float32Array.from(F);          // available food: replenishes toward F, eaten by traffic
      this.dep = new Float32Array(G.N);
      this.n = nAgents; this.a = new Float32Array(nAgents * 3); // u, v (radians), heading
      // carriers are born at vents: sample cells with probability ∝ F²
      const cdf = new Float64Array(G.N); let acc = 0;
      for (let k = 0; k < G.N; k++) { acc += F[k] * F[k] + 1e-6; cdf[k] = acc; }
      for (let n = 0; n < nAgents; n++) {
        const x = (0.5 + 0.5 * hash3(n, seed, 11)) * acc;
        let lo = 0, hi = G.N - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < x) lo = mid + 1; else hi = mid; }
        const i = lo % G.Nu, j = (lo / G.Nu) | 0;
        this.a[3 * n] = (i + 0.5) * G.du; this.a[3 * n + 1] = (j + 0.5) * G.dv;
        this.a[3 * n + 2] = Math.PI * (1 + hash3(n, seed, 12));
      }
    }
    sample(arr, u, v) {
      const G = this.G;
      const i = ((Math.floor(u / G.du) % G.Nu) + G.Nu) % G.Nu, j = ((Math.floor(v / G.dv) % G.Nv) + G.Nv) % G.Nv;
      return arr[j * G.Nu + i];
    }
    sense(u, v, hd) {
      const G = this.G, P = this.P;
      const h = G.R + G.r * Math.cos(v);
      const su = u + P.sd * Math.cos(hd) / h, sv = v + P.sd * Math.sin(hd) / G.r;
      const t = this.sample(this.T, su, sv), q = t / P.tSat;
      return t / (1 + q * q) + P.wFood * this.sample(this.Nf, su, sv) + P.wGel * this.sample(this.M, su, sv) - P.wRef * this.sample(this.V, su, sv);
    }
    step() {
      const G = this.G, P = this.P, a = this.a;
      this.dep.fill(0);
      for (let n = 0; n < this.n; n++) {
        let u = a[3 * n], v = a[3 * n + 1], hd = a[3 * n + 2];
        const f = this.sense(u, v, hd), l = this.sense(u, v, hd + P.sa), r = this.sense(u, v, hd - P.sa);
        const jit = hash3(n, this.tick, this.seed);
        if (f >= l && f >= r) hd += 0.1 * P.ra * jit;
        else if (l > r) hd += P.ra; else hd -= P.ra;
        const h = G.R + G.r * Math.cos(v);
        u += P.step * Math.cos(hd) / h; v += P.step * Math.sin(hd) / G.r;
        u = ((u % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); v = ((v % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        a[3 * n] = u; a[3 * n + 1] = v; a[3 * n + 2] = hd;
        const i = Math.floor(u / G.du) % G.Nu, j = Math.floor(v / G.dv) % G.Nv;
        this.dep[j * G.Nu + i] += P.deposit;
      }
      this.field();
      this.tick++;
    }
    /** Trail, gel and excitation updates — the same per-cell rules the GPU runs. */
    field() {
      const G = this.G, P = this.P, { Nu, Nv } = G;
      const T = this.T, M = this.M, U = this.U, V = this.V;
      const T2 = new Float32Array(G.N), M2 = new Float32Array(G.N), U2 = new Float32Array(G.N), V2 = new Float32Array(G.N), N2 = new Float32Array(G.N);
      const Nf = this.Nf;
      for (let j = 0; j < Nv; j++) {
        const jn = (j + 1) % Nv, js = (j - 1 + Nv) % Nv;
        const ku = Math.min(0.24, P.exD * (G.R / G.h[j]) ** 2), kv = P.exD;
        for (let i = 0; i < Nu; i++) {
          const ie = (i + 1) % Nu, iw = (i - 1 + Nu) % Nu, k = j * Nu + i;
          const kE = j * Nu + ie, kW = j * Nu + iw, kN = jn * Nu + i, kS = js * Nu + i;
          const lapT = T[kE] + T[kW] + T[kN] + T[kS] - 4 * T[k];
          T2[k] = Math.min(P.tCap, P.decay * (T[k] + P.diff * 0.25 * lapT) + this.dep[k]);
          N2[k] = Math.min(1, Math.max(0, Nf[k] + P.regrow * (this.F[k] - Nf[k]) - P.eat * Math.min(T[k], P.tCap) / P.tCap * Nf[k]));
          const m = M[k];
          M2[k] = Math.min(1, Math.max(0, m + P.gelGrow * Math.max(T[k] - P.gelTh, 0) / (1 + T[k]) * (1 - m) * (0.3 + this.F[k]) - P.gelDecay * m));
          const g = smoothstep(0.05, 0.35, m);
          const K = (a, b) => { const ka = 0.02 + smoothstep(0.05, 0.35, a), kb = 0.02 + smoothstep(0.05, 0.35, b); return 2 * ka * kb / (ka + kb); };
          const c = U[k];
          const flux = ku * (K(m, M[kE]) * (U[kE] - c) + K(m, M[kW]) * (U[kW] - c)) + kv * (K(m, M[kN]) * (U[kN] - c) + K(m, M[kS]) * (U[kS] - c));
          const th = 0.12 + P.refr * V[k] + 0.45 * (1 - g);
          let nu = c + P.exK * c * (1 - c) * (c - th) + flux;
          if (g > 0.5 && this.F[k] > 0.4 && V[k] < 0.05 && 0.5 + 0.5 * hash3(k, this.tick, this.seed + 7) < P.spark) nu = 1;
          U2[k] = Math.min(1, Math.max(0, nu));
          V2[k] = Math.min(1, Math.max(0, V[k] + P.recov * (c - V[k])));
        }
      }
      this.T = T2; this.M = M2; this.U = U2; this.V = V2; this.Nf = N2;
    }
  }

  /** Pearson correlation. */
  function pearson(a, b) {
    const n = a.length; let ma = 0, mb = 0;
    for (let k = 0; k < n; k++) { ma += a[k]; mb += b[k]; } ma /= n; mb /= n;
    let sab = 0, saa = 0, sbb = 0;
    for (let k = 0; k < n; k++) { const x = a[k] - ma, y = b[k] - mb; sab += x * y; saa += x * x; sbb += y * y; }
    return sab / Math.sqrt(saa * sbb + 1e-30);
  }
  /** Circular shift by half the planet in u and a quarter in v: same statistics, wrong places. */
  function shifted(G, a) {
    const out = new Float32Array(G.N), su = G.Nu >> 1, sv = G.Nv >> 2;
    for (let j = 0; j < G.Nv; j++) for (let i = 0; i < G.Nu; i++) out[((j + sv) % G.Nv) * G.Nu + (i + su) % G.Nu] = a[j * G.Nu + i];
    return out;
  }
  /** Does life sit on the fossils? corr(gel, food) against the shifted-food control. */
  function lifeOnFossils(G, M, F) {
    const Fs = blur(G, F, 4);
    return { r: pearson(M, Fs), rShift: pearson(M, shifted(G, Fs)) };
  }

  return {
    hash3, rnd, makeGeom, law, epsAt, windAt, windStart, windEnd, idx, laplace, Crust, physDist, smoothstep,
    grads, blur, orientation, frustration, defectCount, domainLength, chevron, census, readPlanet, featureOf, trueCool, FAST_SLOW_TAU,
    LIFE, Life, pearson, shifted, lifeOnFossils,
  };
});
