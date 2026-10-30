/* Monte Carlo engine for the brokerage growth predictor */
(function (root) {
  'use strict';

  const PAIRS = 1000;
  const QUANTILES = [0.1, 0.25, 0.5, 0.75, 0.9];

  /* ---------- Random numbers ---------- */

  // splitmix32 spreads a small integer seed across the generator's 128-bit state.
  function splitmix32(a) {
    return () => {
      a = (a + 0x9e3779b9) | 0;
      let t = a ^ (a >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t ^= t >>> 15;
      t = Math.imul(t, 0x735a2d97);
      return (t ^ (t >>> 15)) >>> 0;
    };
  }

  // sfc32: small, fast, seedable, and passes PractRand and BigCrush. Returns [0, 1).
  function sfc32(seed) {
    const mix = splitmix32(seed | 0);
    let a = mix();
    let b = mix();
    let c = mix();
    let d = mix();
    const next = () => {
      const t = (((a + b) | 0) + d) | 0;
      d = (d + 1) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
    for (let i = 0; i < 16; i++) next();
    return next;
  }

  // Standard normal draws for every pair of futures and every year; z[j * years + (k - 1)]
  // is pair j's draw for year k. Draws come in twos from the Marsaglia polar method.
  function draws(seed, years = 80, pairs = PAIRS) {
    const rand = sfc32(seed);
    const z = new Float64Array(pairs * years);
    for (let i = 0; i < z.length; i += 2) {
      let u;
      let v;
      let s;
      do {
        u = 2 * rand() - 1;
        v = 2 * rand() - 1;
        s = u * u + v * v;
      } while (s >= 1 || s === 0);
      const f = Math.sqrt((-2 * Math.log(s)) / s);
      z[i] = u * f;
      if (i + 1 < z.length) z[i + 1] = v * f;
    }
    return { seed, years, pairs, z };
  }

  /* ---------- Model ---------- */

  // The same closed form as app.js: a balance growing at a steady yearly rate, plus a
  // yearly deposit split into twelve paid at the end of each month.
  function grow(principal, deposit, rate, t) {
    const L = Math.log1p(rate / 100);
    const months = Math.abs(L) < 1e-12 ? t : Math.expm1(t * L) / Math.expm1(L / 12) / 12;
    return principal * Math.exp(t * L) + deposit * months;
  }

  // Log-scale spread for yearly returns whose median growth is g and whose standard
  // deviation is sigma: solves sigma² = g²·u·(u − 1) for u = exp(s²).
  function spread(g, sigma) {
    if (!(sigma > 0)) return 0;
    const u = (1 + Math.sqrt(1 + (4 * sigma * sigma) / (g * g))) / 2;
    return Math.sqrt(Math.log(u));
  }

  // In-place quickselect (Hoare partition, median of three): moves the k-th smallest of
  // a[lo..hi] to a[k], smaller values before it and larger ones after.
  function select(a, k, lo, hi) {
    while (hi > lo) {
      const mid = (lo + hi) >> 1;
      let t;
      if (a[mid] < a[lo]) { t = a[mid]; a[mid] = a[lo]; a[lo] = t; }
      if (a[hi] < a[lo]) { t = a[hi]; a[hi] = a[lo]; a[lo] = t; }
      if (a[hi] < a[mid]) { t = a[hi]; a[hi] = a[mid]; a[mid] = t; }
      const pivot = a[mid];
      let i = lo;
      let j = hi;
      while (i <= j) {
        while (a[i] < pivot) i++;
        while (a[j] > pivot) j--;
        if (i <= j) { t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else return;
    }
  }

  // Percentiles interpolate linearly between neighbouring order statistics at rank
  // q·(n − 1) (the common "type 7" definition), so identical futures give exact values.
  // Selections run in ascending order, each on the part of the buffer above the last.
  function quantiles(buf, outs, k) {
    const n = buf.length;
    let lo = 0;
    let prev = -Infinity;
    for (let q = 0; q < QUANTILES.length; q++) {
      const h = QUANTILES[q] * (n - 1);
      const i = Math.floor(h);
      select(buf, i, lo, n - 1);
      let v = buf[i];
      const frac = h - i;
      if (frac > 0 && i + 1 < n) {
        let next = Infinity;
        for (let x = i + 1; x < n; x++) if (buf[x] < next) next = buf[x];
        v += (next - v) * frac;
      }
      v = Math.max(v, prev); // guards against a one-ulp dip from rounding
      outs[q][k] = v;
      prev = v;
      lo = i;
    }
  }

  // Simulates every future year by year. The invested part draws a lognormal return each
  // year (antithetic pairs: one future takes +z, its twin −z); the not-invested part grows
  // at its fixed rate. Income arrives in twelve monthly deposits, and each year's return
  // accrues evenly across its months.
  function run(params, d, floor) {
    const { p1, r1, p2, r2, c, split, swings } = params;
    const years = Math.min(Math.max(Math.round(params.years) || 0, 0), d.years);
    const paths = 2 * d.pairs;
    const out = { paths, p10: null, p25: null, p50: null, p75: null, p90: null, below: new Float64Array(years + 1) };
    const outs = QUANTILES.map(() => new Float64Array(years + 1));
    [out.p10, out.p25, out.p50, out.p75, out.p90] = outs;

    const ci = c * split;
    const cc = c * (1 - split);
    const g = Math.max(1 + r1 / 100, 1e-12);
    const s = spread(g, Math.max(0, swings) / 100);
    const share = (k, total) => (floor && total < floor[k] ? 1 : 0);

    // Without swings every future is the same, so use the closed form exactly.
    if (s === 0) {
      for (let k = 0; k <= years; k++) {
        const total = grow(p1, ci, r1, k) + grow(p2, cc, r2, k);
        for (let q = 0; q < outs.length; q++) outs[q][k] = total;
        out.below[k] = share(k, total);
      }
      return out;
    }

    const monthly = Math.exp(Math.log(g) / 12); // median growth per month
    const dm = ci / 12;
    const inv = new Float64Array(paths).fill(p1);
    const buf = new Float64Array(paths);
    const z = d.z;
    const stride = d.years;

    // With monthly growth h, a year multiplies the balance by h¹² and turns twelve
    // month-end deposits into dm·(1 + h + … + h¹¹), a sum that stays exact near h = 1.
    const year = (v, h) => {
      let p = 1;
      let f = 1;
      for (let q = 1; q < 12; q++) {
        p *= h;
        f += p;
      }
      return v * p * h + dm * f;
    };

    for (let k = 0; k <= years; k++) {
      if (k > 0) {
        for (let j = 0, o = k - 1; j < d.pairs; j++, o += stride) {
          const x = Math.exp((s * z[o]) / 12);
          inv[2 * j] = year(inv[2 * j], monthly * x);
          inv[2 * j + 1] = year(inv[2 * j + 1], monthly / x);
        }
      }
      const cash = grow(p2, cc, r2, k);
      const limit = floor ? floor[k] : -Infinity;
      let under = 0;
      for (let i = 0; i < paths; i++) {
        const total = inv[i] + cash;
        buf[i] = total;
        if (total < limit) under++;
      }
      out.below[k] = under / paths;
      quantiles(buf, outs, k);
    }
    return out;
  }

  const api = { PAIRS, draws, run };
  root.MonteCarlo = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
