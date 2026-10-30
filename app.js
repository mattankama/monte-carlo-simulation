/* Brokerage growth predictor */
(() => {
  'use strict';

  const START_YEAR = new Date().getFullYear();
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MIN_YEARS = 1;
  const MAX_YEARS = 80;
  const LIMITS = {
    money: { min: 0, max: 1e10 },
    rate: { min: -99, max: 100 },
    swing: { min: 0, max: 60 },
    inflation: { min: 0, max: 10 },
  };
  // Arrow-key steps for each kind of field, plain and with Shift.
  const STEPS = {
    money: [1000, 10000],
    rate: [0.25, 1],
    swing: [1, 5],
    inflation: [0.1, 0.5],
  };
  const KEYS = ['p1', 'r1', 'p2', 'r2', 'c', 'split', 'infl', 'years'];
  const TWEEN_MS = 420;
  const INTRO_MS = 1400;
  const SEED = 1; // a fixed start, so the same inputs always show the same futures
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Yearly swings of the invested part: the standard deviation of US annual returns,
  // 1928–2025, for the S&P 500 (19.4%) and annually rebalanced stock/bond blends
  // (15.6%, 12.1% and 9.2%), from Damodaran's NYU Stern data.
  const SWINGS = {
    initial: 19,
    presets: [
      { label: 'All stocks', rate: 19 },
      { label: '80% stocks', rate: 16 },
      { label: '60% stocks', rate: 12 },
      { label: '40% stocks', rate: 9 },
    ],
  };

  // Inflation for today's dollars, as of September 2026. Sources: BLS CPI-U (CUUR0000SA0);
  // the Fed's Statement on Longer-Run Goals (Jan 2026); the 2026 Social Security Trustees
  // Report (ultimate CPI 1.8/2.4/3.0%); Treasury par yield curves (Sep 25 2026); the
  // Philadelphia Fed SPF (Q3 2026); Cleveland Fed inflation expectations (Sep 2026).
  const INFLATION = {
    initial: 2.5,
    presets: [
      // The Fed's 2% PCE goal plus the ~0.3-point gap by which CPI runs higher; CBO's long-run CPI-U.
      { label: 'Fed target', rate: 2.3, note: "The Fed's 2% goal plus the usual gap by which consumer prices run higher" },
      // Trustees 2.4% (75-year), Cleveland Fed 30-year 2.6%, 30-year TIPS breakeven 2.3%, SPF 10-year 2.3%.
      { label: 'Long-run forecast', rate: 2.5, note: 'About what official and market forecasts expect over the long run' },
      // CPI-U compounded 1928–2025, the same years as the swings presets.
      { label: 'US history', rate: 3, note: 'The US average from 1928 to 2025' },
    ],
  };

  /* ---------- Formatting ---------- */

  const fmtUsd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const fmtUsdCompact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 });
  const fmtUsd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumSignificantDigits: 2 });
  const fmtUsd2Compact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumSignificantDigits: 2 });
  const fmtInt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const fmtCents = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtPct = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fmtSci = new Intl.NumberFormat('en-US', { notation: 'scientific', maximumFractionDigits: 2 });
  const fmtUsdSci = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'scientific', maximumFractionDigits: 2 });

  // Whole dollars; compact past a billion and scientific past a quadrillion,
  // so figures never overflow their slot.
  function usd(value) {
    const n = Math.round(value) || 0;
    const abs = Math.abs(n);
    if (abs >= 1e15) return fmtUsdSci.format(n);
    return abs >= 1e9 ? fmtUsdCompact.format(n) : fmtUsd.format(n);
  }

  // Simulated amounts get a few significant figures; more would be false precision.
  function roundSig(value, digits) {
    if (!value || !Number.isFinite(value)) return 0;
    const unit = Math.pow(10, Math.floor(Math.log10(Math.abs(value))) - digits + 1);
    return Math.round(value / unit) * unit;
  }

  const usdRough = (v) => usd(roundSig(v, 3));
  // The range gets two figures, compact from a million: $64,000, $1.6M.
  const usdSpread = (v) => {
    const r = roundSig(v, 2);
    return (Math.abs(r) >= 1e6 ? fmtUsd2Compact : fmtUsd2).format(r);
  };
  const usdAxis = (v) => (v >= 1e15 ? fmtUsdSci.format(v) : fmtUsdCompact.format(v));
  const pctText = (p) => (p >= 1e6 ? fmtSci.format(p) : fmtPct.format(p));

  const yearsLabel = (y) => (y === 1 ? '1 year' : `${y} years`);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const easeOutCubic = (k) => 1 - Math.pow(1 - k, 3);
  const easeInOutCubic = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

  function niceStep(raw) {
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / pow;
    const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return nice * pow;
  }

  // Whole percents: 2,000 simulations can't resolve anything finer.
  function riskText(share) {
    const pct = share * 100;
    if (pct < 1) return 'Less than 1% chance of ending with less than you put in';
    if (pct > 99) return 'More than 99% chance of ending with less than you put in';
    const n = Math.round(pct);
    const an = n === 8 || n === 11 || n === 18 || (n >= 80 && n < 90);
    return `About ${an ? 'an' : 'a'} ${n}% chance of ending with less than you put in`;
  }

  /* ---------- Model ---------- */

  // A balance growing at a steady yearly rate, plus a yearly deposit split into twelve
  // paid at the end of each month, each growing from its own date. The closed form passes
  // through every month-end balance and stays smooth between them; t may be fractional.
  function grow(principal, deposit, rate, t) {
    const L = Math.log1p(rate / 100);
    const months = Math.abs(L) < 1e-12 ? t : Math.expm1(t * L) / Math.expm1(L / 12) / 12;
    return principal * Math.exp(t * L) + deposit * months;
  }

  // Each part grows at its own rate; yearly income is split between them.
  function totalAt(s, t) {
    return grow(s.p1, s.c * s.split, s.r1, t) + grow(s.p2, s.c * (1 - s.split), s.r2, t);
  }

  // What an amount t years out is worth in today's dollars; 1 with inflation off.
  const deflator = (s, t) => Math.exp(-t * Math.log1p(s.infl / 100));

  // Money put in by year t, in today's dollars: each monthly deposit is worth less by the
  // time it arrives, so income counts at the sum of the monthly deflators.
  function putInAt(s, t) {
    const L = Math.log1p(s.infl / 100);
    const deposits = Math.abs(L) < 1e-12 ? t : -Math.expm1(-t * L) / Math.expm1(L / 12) / 12;
    return s.p1 + s.p2 + s.c * deposits;
  }

  // A smooth curve through yearly values that never overshoots them (Fritsch–Carlson),
  // in log space when every value is positive, so steady growth stays exact.
  function spline(values) {
    const n = values.length - 1;
    const log = values.every((v) => v > 0);
    const y = log ? values.map(Math.log) : Array.from(values);
    const d = new Float64Array(n);
    const m = new Float64Array(n + 1);
    for (let k = 0; k < n; k++) d[k] = y[k + 1] - y[k];
    m[0] = d[0];
    m[n] = d[n - 1];
    for (let k = 1; k < n; k++) m[k] = d[k - 1] * d[k] > 0 ? (d[k - 1] + d[k]) / 2 : 0;
    for (let k = 0; k < n; k++) {
      if (d[k] === 0) {
        m[k] = 0;
        m[k + 1] = 0;
        continue;
      }
      const a = m[k] / d[k];
      const b = m[k + 1] / d[k];
      const h = a * a + b * b;
      if (h > 9) {
        const tau = 3 / Math.sqrt(h);
        m[k] = tau * a * d[k];
        m[k + 1] = tau * b * d[k];
      }
    }
    return (t) => {
      const k = clamp(Math.floor(t), 0, n - 1);
      const h = t - k;
      const h2 = h * h;
      const h3 = h2 * h;
      const v = (2 * h3 - 3 * h2 + 1) * y[k] + (h3 - 2 * h2 + h) * m[k] + (3 * h2 - 2 * h3) * y[k + 1] + (h3 - h2) * m[k + 1];
      return log ? Math.exp(v) : v;
    };
  }

  /* ---------- Field parsing ---------- */

  function parseField(raw, kind) {
    const s = raw.replace(/−/g, '-').replace(/[\s,$%]/g, '');
    if (s === '' || s === '-' || s === '.' || s === '-.') return { value: 0, error: '' };
    if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return { value: 0, error: 'Enter a number' };
    const value = Number(s);
    const { min, max } = LIMITS[kind];
    const unit = kind === 'rate' ? 'a rate of ' : '';
    if (value < min) {
      return { value: min, error: min === 0 ? 'Enter 0 or more' : `Use ${unit}${min}% or higher` };
    }
    if (value > max) {
      return { value: max, error: kind === 'money' ? `Use ${usd(max)} or less` : `Use ${unit}${max}% or lower` };
    }
    return { value, error: '' };
  }

  const formatMoney = (v) => (Number.isInteger(v) ? fmtInt.format(v) : fmtCents.format(v));
  const formatRate = (v) => String(Math.round(v * 100) / 100);

  // Groups thousands while typing and keeps the caret beside the same digit.
  function groupMoney(input) {
    const raw = input.value;
    const caret = input.selectionStart ?? raw.length;
    const before = raw.slice(0, caret).replace(/[^\d.]/g, '').length;
    let s = raw.replace(/[^\d.]/g, '');
    const dot = s.indexOf('.');
    if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '').slice(0, 2);
    const parts = s.split('.');
    const whole = parts[0].replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const out = parts.length > 1 ? `${whole}.${parts[1]}` : whole;
    if (out === raw) return;
    let pos = 0;
    for (let seen = 0; pos < out.length && seen < before; pos++) {
      if (out[pos] !== ',') seen++;
    }
    input.value = out;
    input.setSelectionRange(pos, pos);
  }

  function cleanRate(input) {
    const raw = input.value;
    let s = raw.replace(/−/g, '-').replace(/[^\d.-]/g, '');
    const negative = s.startsWith('-');
    s = s.replace(/-/g, '');
    const dot = s.indexOf('.');
    if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '');
    const out = (negative ? '-' : '') + s;
    if (out === raw) return;
    const caret = Math.max(0, (input.selectionStart ?? raw.length) - (raw.length - out.length));
    input.value = out;
    input.setSelectionRange(caret, caret);
  }

  /* ---------- Elements ---------- */

  const $ = (id) => document.getElementById(id);
  const fields = Array.from(document.querySelectorAll('input[data-kind]'));
  const yearsInput = $('years');
  const yearsOut = $('yearsOut');
  const rulerTicks = $('rulerTicks');
  const rulerLabels = $('rulerLabels');
  const resultKind = $('resultKind');
  const resultReal = $('resultReal');
  const yearsText = $('yearsText');
  const figureSr = $('figureSr');
  const figureInt = $('figureInt');
  const figureDec = $('figureDec');
  const spread = $('spread');
  const spreadLo = $('spreadLo');
  const spreadHi = $('spreadHi');
  const delta = $('delta');
  const deltaAmount = $('deltaAmount');
  const deltaFrom = $('deltaFrom');
  const deltaAdded = $('deltaAdded');
  const risk = $('risk');
  const fanKey = $('fanKey');
  const tableNote = $('tableNote');
  const tableHead = $('tableHead');
  const tableBody = $('tableBody');
  const summaryLive = $('summaryLive');
  const controls = $('controls');
  const incomeSwitch = $('incomeSwitch');
  const incomeBody = $('incomeBody');
  const splitInput = $('split');
  const splitInvPct = $('splitInvPct');
  const splitCashPct = $('splitCashPct');
  const simSwitch = $('simSwitch');
  const simBody = $('simBody');
  const simNote = $('simNote');
  const swingPreset = $('swingPreset');
  const swingsInput = $('swings');
  const reshuffle = $('reshuffle');
  const realSwitch = $('realSwitch');
  const realBody = $('realBody');
  const inflPreset = $('inflPreset');
  const inflInput = $('infl');
  const inflNote = $('inflNote');
  const fineFixed = $('fineFixed');
  const fineSim = $('fineSim');
  const fineSimDetail = $('fineSimDetail');
  const fineIncome = $('fineIncome');
  const fineReal = $('fineReal');

  const isOn = (button) => button.getAttribute('aria-checked') === 'true';

  /* ---------- Chart ---------- */

  function createChart(fig) {
    const svg = fig.querySelector('svg');
    const tip = fig.querySelector('.tip');
    const tipField = (name) => tip.querySelector(`[data-tip="${name}"]`);
    const tipYear = tipField('year');
    const tipRel = tipField('rel');
    const tipHi = tipField('hi');
    const tipMid = tipField('mid');
    const tipLo = tipField('lo');
    const tipMidLabel = tipField('midLabel');
    const tipReal = tipField('real');
    const tipFan = tip.querySelectorAll('[data-fan]');
    const live = $('chartLive');

    const node = (name, attrs = {}, parent = svg) => {
      const n = document.createElementNS(SVG_NS, name);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      parent.append(n);
      return n;
    };
    const show = (n, on) => { n.style.display = on ? '' : 'none'; };
    const place = (dot, cx, cy) => { dot.setAttribute('cx', cx.toFixed(2)); dot.setAttribute('cy', cy.toFixed(2)); };

    const gGrid = node('g', { class: 'c-grid' });
    const gYLabels = node('g', { class: 'c-ylabels' });
    const gXLabels = node('g', { class: 'c-xlabels' });
    const bandOuter = node('path', { class: 'c-band c-band--outer' });
    const bandInner = node('path', { class: 'c-band c-band--inner' });
    const area = node('path', { class: 'c-area' });
    const baseline = node('line', { class: 'c-base' });
    const line = node('path', { class: 'c-line' });
    const endDot = node('circle', { class: 'c-dot', r: 4 });
    const cross = node('line', { class: 'c-cross' });
    const hoverDot = node('circle', { class: 'c-dot', r: 4.5 });

    const ctx = document.createElement('canvas').getContext('2d');
    let family = '';
    // Axis digits render tabular; a zero is at least as wide as any of them.
    const measure = (text, size = 12, weight = 400) => {
      ctx.font = `${weight} ${size}px ${family}`;
      return ctx.measureText(text.replace(/\d/g, '0')).width;
    };

    let geo = null;
    let hoverT = null;

    function render({ view, T, tEnd }) {
      const W = fig.clientWidth;
      const H = fig.clientHeight;
      if (!W || !H) return;
      family = getComputedStyle(fig).fontFamily;
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

      const at = view.at;
      // Scan the whole horizon, whole years included, so a mid-range peak still fits and
      // the axis holds still while the reveal runs.
      let peak = 0;
      for (let i = 0; i <= 96; i++) peak = Math.max(peak, at((T * i) / 96).hi);
      for (let k = 1; k < T; k++) peak = Math.max(peak, at(k).hi);
      const yTop = peak > 0 ? peak * 1.12 : 100;
      const yStep = niceStep(yTop / 5);
      const yTicks = [];
      for (let i = 0; i * yStep <= yTop * (1 + 1e-9); i++) yTicks.push(i * yStep);
      const yText = yTicks.map(usdAxis);
      // Room for labels up to "$12.5M" at all times, so the plot's left edge stays put.
      const gutter = Math.ceil(Math.max(measure('$12.5M'), ...yText.map((t) => measure(t)))) + 14;

      const m = { top: 12, right: 20, bottom: 34, left: gutter };
      const pw = Math.max(10, W - m.left - m.right);
      const ph = Math.max(10, H - m.top - m.bottom);
      const x = (t) => m.left + (t / T) * pw;
      const y = (v) => m.top + ph - (v / yTop) * ph;
      const y0 = m.top + ph;
      const crisp = (v) => Math.round(v) + 0.5;

      gGrid.replaceChildren();
      gYLabels.replaceChildren();
      yTicks.forEach((v, i) => {
        const gy = crisp(y(v));
        if (i > 0) node('line', { x1: m.left, x2: W - m.right, y1: gy, y2: gy }, gGrid);
        node('text', { x: m.left - 12, y: gy, dy: '0.32em', 'text-anchor': 'end' }, gYLabels).textContent = yText[i];
      });
      baseline.setAttribute('x1', m.left);
      baseline.setAttribute('x2', W - m.right);
      baseline.setAttribute('y1', crisp(y0));
      baseline.setAttribute('y2', crisp(y0));

      gXLabels.replaceChildren();
      const xStep = [1, 2, 5, 10, 20].find((st) => (pw / T) * st >= 72) || 40;
      for (let t = 0; t <= T + 1e-6; t += xStep) {
        node('text', { x: x(t).toFixed(2), y: y0 + 22, 'text-anchor': 'middle' }, gXLabels).textContent = String(START_YEAR + t);
      }

      // Sample the curves; whole years fall on them.
      const n = clamp(Math.round(pw / 4), 24, 220);
      const pts = { lo: [], q1: [], mid: [], q3: [], hi: [] };
      for (let i = 0; i <= n; i++) {
        const t = (tEnd * i) / n;
        const v = at(t);
        const px = x(t).toFixed(2);
        for (const key in pts) pts[key].push(`${px},${y(v[key]).toFixed(2)}`);
      }
      const path = (list) => `M${list.join('L')}`;
      const midPath = path(pts.mid);
      line.setAttribute('d', midPath);
      area.setAttribute('d', `${midPath}L${x(tEnd).toFixed(2)},${y0}L${x(0).toFixed(2)},${y0}Z`);
      if (view.fan) {
        bandOuter.setAttribute('d', `${path(pts.hi)}L${pts.lo.reverse().join('L')}Z`);
        bandInner.setAttribute('d', `${path(pts.q3)}L${pts.q1.reverse().join('L')}Z`);
      }
      place(endDot, x(tEnd), y(at(tEnd).mid));
      [line, endDot].forEach((el) => show(el, peak > 0));

      geo = { m, pw, T, tEnd, W, x, y, y0, view };
      if (hoverT === null) hideMarks();
      else placeHover();
    }

    function lastYear() {
      return geo ? Math.floor(geo.tEnd + 1e-6) : 0;
    }

    function hideMarks() {
      [cross, hoverDot].forEach((el) => show(el, false));
      tip.hidden = true;
      fig.classList.remove('is-inspecting');
    }

    function placeHover() {
      const t = clamp(hoverT, 0, lastYear());
      const { view } = geo;
      const v = view.at(t);
      const cx = geo.x(t);
      const lx = Math.round(cx) + 0.5;
      cross.setAttribute('x1', lx);
      cross.setAttribute('x2', lx);
      cross.setAttribute('y1', geo.m.top);
      cross.setAttribute('y2', geo.y0);
      show(cross, true);
      place(hoverDot, cx, geo.y(v.mid));
      show(hoverDot, true);
      fig.classList.add('is-inspecting');

      const money = view.rough ? usdRough : usd;
      tipYear.textContent = String(START_YEAR + t);
      tipRel.textContent = t === 0 ? 'Today' : `Year ${t}`;
      tipHi.textContent = money(v.hi);
      tipMid.textContent = money(v.mid);
      tipLo.textContent = money(v.lo);
      tipMidLabel.textContent = view.rough ? 'Typical' : 'Total';
      tipFan.forEach((el) => { el.hidden = !view.rough; });
      tipReal.hidden = !view.real;
      tip.hidden = false;
      const tw = tip.offsetWidth;
      let left = cx + 16;
      if (left + tw > geo.W) left = cx - 16 - tw;
      tip.style.transform = `translate(${Math.round(Math.max(0, left))}px, ${geo.m.top}px)`;
    }

    function inspect(t) {
      if (!geo) return;
      hoverT = clamp(t, 0, lastYear());
      placeHover();
    }

    function release() {
      hoverT = null;
      hideMarks();
    }

    let liveTimer = 0;
    function announce() {
      clearTimeout(liveTimer);
      liveTimer = setTimeout(() => {
        if (hoverT === null) return;
        const { view } = geo;
        const v = view.at(hoverT);
        const when = hoverT === 0 ? 'today' : `year ${hoverT}`;
        const real = view.real ? " in today's dollars" : '';
        live.textContent = view.rough
          ? `${START_YEAR + hoverT}, ${when}: typical ${usdRough(v.mid)}, top 10% ${usdRough(v.hi)}, bottom 10% ${usdRough(v.lo)}${real}.`
          : `${START_YEAR + hoverT}, ${when}: total ${usd(v.mid)}${real}.`;
      }, 160);
    }

    const yearFromPointer = (e) => {
      const box = svg.getBoundingClientRect();
      return Math.round(((e.clientX - box.left - geo.m.left) / geo.pw) * geo.T);
    };

    fig.addEventListener('pointermove', (e) => { if (geo) inspect(yearFromPointer(e)); });
    fig.addEventListener('pointerdown', (e) => { if (geo) inspect(yearFromPointer(e)); });
    fig.addEventListener('pointerleave', release);
    fig.addEventListener('pointercancel', release);
    fig.addEventListener('focus', () => { if (fig.matches(':focus-visible')) { inspect(lastYear()); announce(); } });
    fig.addEventListener('blur', release);
    fig.addEventListener('keydown', (e) => {
      if (!geo) return;
      const max = lastYear();
      let t = hoverT === null ? max : hoverT;
      switch (e.key) {
        case 'ArrowLeft': case 'ArrowDown': t -= 1; break;
        case 'ArrowRight': case 'ArrowUp': t += 1; break;
        case 'PageDown': t -= 5; break;
        case 'PageUp': t += 5; break;
        case 'Home': t = 0; break;
        case 'End': t = max; break;
        case 'Escape': release(); return;
        default: return;
      }
      e.preventDefault();
      inspect(t);
      announce();
    });

    return {
      render,
      describe(text) { svg.setAttribute('aria-label', text); },
      setFan(on) { fig.classList.toggle('is-fan', on); },
    };
  }

  const chart = createChart($('chart'));

  /* ---------- Simulation ---------- */

  const engine = window.MonteCarlo;
  const BANDS = ['p10', 'p25', 'p50', 'p75', 'p90', 'below'];
  const PATHS = fmtInt.format(engine ? 2 * engine.PAIRS : 2000);
  const sim = { on: false, swings: SWINGS.initial, seed: SEED, draws: null };

  // Always the full 80 years, so the time slider only chooses how much to show.
  function simulate(s, swings) {
    if (!sim.draws || sim.draws.seed !== sim.seed) sim.draws = engine.draws(sim.seed, MAX_YEARS);
    // "Less than you put in" compares against today's-dollar deposits, converted back.
    const floor = new Float64Array(MAX_YEARS + 1);
    for (let k = 0; k <= MAX_YEARS; k++) floor[k] = putInAt(s, k) / deflator(s, k);
    const r = engine.run({ p1: s.p1, r1: s.r1, p2: s.p2, r2: s.r2, c: s.c, split: s.split, swings, years: MAX_YEARS }, sim.draws, floor);
    return Object.fromEntries(BANDS.map((k) => [k, r[k]]));
  }

  const copyBands = (b) => Object.fromEntries(BANDS.map((k) => [k, Float64Array.from(b[k])]));

  /* ---------- State & motion ---------- */

  const target = { p1: 0, r1: 0, p2: 0, r2: 0, c: 0, split: 0.8, infl: 0, years: 10 };
  const shown = { ...target, reveal: reducedMotion.matches ? 1 : 0 };
  // Simulated percentiles: where the fan is heading and what's on screen now. The fan
  // stays drawn while it folds back into the line after its switch goes off.
  let bandsTarget = null;
  let bands = null;
  let fan = false;
  let tween = null;
  let intro = null;
  let frameId = 0;
  let ready = false;

  function setTarget(next, resim = false) {
    const moved = KEYS.filter((k) => next[k] !== target[k]);
    if (ready && !moved.length && !resim) return;
    Object.assign(target, next);
    // Moving the time slider never re-simulates; everything else the model reads does.
    if (fan && (resim || moved.some((k) => k !== 'years'))) bandsTarget = simulate(target, sim.on ? sim.swings : 0);
    renderStatic();
    if (!ready || reducedMotion.matches) {
      KEYS.forEach((k) => { shown[k] = target[k]; });
      settle();
      draw();
      return;
    }
    const from = {};
    KEYS.forEach((k) => { from[k] = shown[k]; });
    tween = { from, bands: bands && copyBands(bands), start: performance.now() };
    requestFrame();
  }

  // Lands the fan on its target, or drops it once it has folded back into the line.
  function settle() {
    if (!fan) return;
    if (sim.on) {
      bands = copyBands(bandsTarget);
      return;
    }
    fan = false;
    bands = null;
    bandsTarget = null;
  }

  function requestFrame() {
    if (!frameId) frameId = requestAnimationFrame(tick);
  }

  function tick(now) {
    frameId = 0;
    let running = false;
    if (tween) {
      const k = clamp((now - tween.start) / TWEEN_MS, 0, 1);
      const e = easeOutCubic(k);
      // Land exactly on the target, so a share tweened to 0% or 100% leaves no sliver.
      KEYS.forEach((key) => { shown[key] = k < 1 ? tween.from[key] + (target[key] - tween.from[key]) * e : target[key]; });
      if (fan && tween.bands) {
        BANDS.forEach((key) => {
          const a = tween.bands[key];
          const b = bandsTarget[key];
          const out = bands[key];
          for (let i = 0; i < out.length; i++) out[i] = k < 1 ? a[i] + (b[i] - a[i]) * e : b[i];
        });
      }
      if (k < 1) running = true;
      else {
        tween = null;
        settle();
      }
    }
    if (intro) {
      const k = clamp((now - intro.start) / INTRO_MS, 0, 1);
      shown.reveal = easeInOutCubic(k);
      if (k < 1) running = true;
      else intro = null;
    }
    draw();
    if (running) requestFrame();
  }

  /* ---------- Rendering ---------- */

  // What the chart and headline read: the fixed-rate total, or the simulated fan between
  // whole years, in today's dollars when inflation is on.
  function currentView() {
    const s = shown;
    const base = { fan, rough: sim.on, real: isOn(realSwitch) };
    if (!fan) {
      const at = (t) => {
        const v = totalAt(s, t) * deflator(s, t);
        return { lo: v, q1: v, mid: v, q3: v, hi: v };
      };
      return { ...base, at, below: () => 0 };
    }
    const [lo, q1, mid, q3, hi] = ['p10', 'p25', 'p50', 'p75', 'p90'].map((k) => spline(bands[k]));
    const at = (t) => {
      const f = deflator(s, t);
      return { lo: lo(t) * f, q1: q1(t) * f, mid: mid(t) * f, q3: q3(t) * f, hi: hi(t) * f };
    };
    const below = (t) => {
      const k = clamp(Math.floor(t), 0, MAX_YEARS - 1);
      return bands.below[k] + (bands.below[k + 1] - bands.below[k]) * (t - k);
    };
    return { ...base, at, below };
  }

  function draw() {
    const T = Math.max(shown.years, 1e-6);
    const tEnd = T * shown.reveal;
    const view = currentView();
    const end = view.at(tEnd);
    const principal = shown.p1 + shown.p2;
    const putIn = putInAt(shown, tEnd);

    renderFigure(end.mid, view.rough);
    renderDelta(end.mid - putIn, principal, putIn - principal, shown.c > 0, view.rough);
    if (view.rough) renderSpread(end, view.below(tEnd));
    chart.render({ view, T, tEnd });
  }

  function renderFigure(value, rough) {
    const v = rough ? roundSig(value, 3) : value;
    if (v >= 1e9) {
      figureInt.textContent = usd(v).replace('$', '');
      figureDec.textContent = '';
      return;
    }
    if (rough) {
      figureInt.textContent = fmtInt.format(Math.round(v));
      figureDec.textContent = '';
      return;
    }
    const cents = Math.round(v * 100);
    figureInt.textContent = fmtInt.format(Math.floor(cents / 100));
    figureDec.textContent = `.${String(cents % 100).padStart(2, '0')}`;
  }

  // Growth leaves out the money put in, so income never counts as a gain.
  function renderDelta(growth, principal, added, hasIncome, rough) {
    if (principal <= 0 && !hasIncome) {
      deltaAmount.textContent = '';
      deltaFrom.textContent = 'Add a principal or yearly income to see a projection';
      deltaAdded.textContent = '';
      delta.classList.remove('is-loss');
      return;
    }
    const base = principal + added;
    const rounded = Math.round(rough ? roundSig(growth, 3) : growth) || 0;
    const loss = rounded < 0;
    const sign = loss ? '−' : '+';
    const pct = base > 0 ? Math.abs(growth / base) * 100 : 0;
    const pctShown = rough && pct < 1e6 ? fmtInt.format(Math.round(pct)) : pctText(pct);
    // Principal and income sit in separate spans so a narrow column can stack them.
    const lead = `${rough ? 'typical growth ' : ''}on`;
    const both = principal > 0 && hasIncome;
    deltaAmount.textContent = `${sign}${usd(Math.abs(rounded))} (${sign}${pctShown}%)`;
    deltaFrom.textContent = hasIncome && !both ? `${lead} ${usd(added)} added` : `${lead} ${usd(principal)} principal`;
    deltaAdded.textContent = both ? `and ${usd(added)} added` : '';
    delta.classList.toggle('is-loss', loss);
  }

  function renderSpread(end, share) {
    spreadLo.textContent = usdSpread(end.lo);
    spreadHi.textContent = usdSpread(end.hi);
    const text = riskText(share);
    if (risk.textContent !== text) risk.textContent = text;
  }

  // Everything that depends only on the settled inputs, not the animation.
  function renderStatic() {
    const s = target;
    const y = s.years;
    const f = deflator(s, y);
    const real = isOn(realSwitch);
    const realText = real ? ", in today's dollars" : '';
    const income = s.c > 0 ? `, with ${usd(s.c)} a year added in equal monthly deposits` : '';
    const empty = s.p1 + s.p2 <= 0 && s.c <= 0;

    yearsText.textContent = yearsLabel(y);
    resultKind.textContent = sim.on ? 'Typical value' : 'Projected value';
    resultReal.hidden = !real;
    spread.hidden = !sim.on || empty;
    risk.hidden = !sim.on || empty;
    fanKey.hidden = !sim.on;
    chart.setFan(sim.on);

    if (sim.on) {
      const b = bandsTarget;
      const mid = usdRough(b.p50[y] * f);
      const range = `8 in 10 simulations end between ${usdSpread(b.p10[y] * f)} and ${usdSpread(b.p90[y] * f)}`;
      figureSr.textContent = `About ${mid}`;
      chart.describe(`Fan chart of ${PATHS} simulated futures${realText}. The typical value grows from ${usd(s.p1 + s.p2)} today to about ${mid} in ${yearsLabel(y)}${income}. ${range}.`);
      if (ready) announceSummary(`Typical value in ${yearsLabel(y)}${realText}: about ${mid}. ${range}. ${riskText(b.below[y])}.`);
    } else {
      const total = totalAt(s, y) * f;
      const included = s.c > 0 ? `, including ${usd(putInAt(s, y) - s.p1 - s.p2)} of yearly income` : '';
      figureSr.textContent = total >= 1e9 ? usd(total) : `$${fmtCents.format(total)}`;
      chart.describe(`Area chart of the account growing from ${usd(s.p1 + s.p2)} today to ${usd(total)} in ${yearsLabel(y)}${income}${realText}.`);
      if (ready) announceSummary(`Projected value in ${yearsLabel(y)}${realText}: ${usd(total)}${included}.`);
    }
    renderTable();
    renderFineprint();
  }

  function renderTable() {
    const s = target;
    const heads = sim.on ? ['Year', 'Bottom 10%', 'Typical', 'Top 10%'] : ['Year', 'Total'];
    tableNote.hidden = !isOn(realSwitch);
    tableHead.replaceChildren(...heads.map((text) => {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = text;
      return th;
    }));
    const rows = document.createDocumentFragment();
    const span = (cls, text) => {
      const el = document.createElement('span');
      el.className = cls;
      el.textContent = text;
      return el;
    };
    const cell = (text, key = false) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (key) td.className = 'is-key';
      return td;
    };
    for (let t = 0; t <= s.years; t++) {
      const f = deflator(s, t);
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.append(String(START_YEAR + t), span('rel', t === 0 ? 'Today' : `Year ${t}`));
      if (sim.on) {
        const b = bandsTarget;
        tr.append(th, cell(usdRough(b.p10[t] * f)), cell(usdRough(b.p50[t] * f), true), cell(usdRough(b.p90[t] * f)));
      } else {
        tr.append(th, cell(usd(totalAt(s, t) * f), true));
      }
      rows.append(tr);
    }
    tableBody.replaceChildren(rows);
  }

  const inflationPreset = (rate) => INFLATION.presets.find((p) => p.rate === rate);

  function renderFineprint() {
    fineFixed.hidden = sim.on;
    fineSim.hidden = !sim.on;
    fineSimDetail.textContent = `${PATHS} simulations in which the invested part swings ${formatRate(sim.swings)}% a year around its typical return, each year independent of the last. The not-invested part grows at its fixed rate.`;
    fineIncome.hidden = !isOn(incomeSwitch);
    const rate = parseField(inflInput.value, 'inflation').value;
    const preset = inflationPreset(rate);
    const why = preset ? `, ${preset.note.charAt(0).toLowerCase()}${preset.note.slice(1)}` : '';
    fineReal.hidden = !isOn(realSwitch);
    fineReal.textContent = `Today's dollars assumes prices rise ${formatRate(rate)}% a year${why}; actual inflation will vary.`;
  }

  let summaryTimer = 0;
  function announceSummary(text) {
    clearTimeout(summaryTimer);
    summaryTimer = setTimeout(() => { summaryLive.textContent = text; }, 900);
  }

  /* ---------- Inputs ---------- */

  function readInputs(resim = false) {
    const values = {};
    fields.forEach((input) => {
      const { value, error } = parseField(input.value, input.dataset.kind);
      values[input.id] = value;
      showError(input, error);
    });
    if (values.swings !== sim.swings) {
      sim.swings = values.swings;
      resim = resim || sim.on;
    }
    // Optional sections count only while their switches are on, whatever their fields hold.
    setTarget({
      p1: values.p1,
      r1: values.r1,
      p2: values.p2,
      r2: values.r2,
      c: isOn(incomeSwitch) ? values.c : 0,
      split: Number(splitInput.value) / 100,
      infl: isOn(realSwitch) ? values.infl : 0,
      years: clamp(Math.round(Number(yearsInput.value)) || MIN_YEARS, MIN_YEARS, MAX_YEARS),
    }, resim);
  }

  function showError(input, message) {
    const hint = $(`${input.id}-hint`);
    input.closest('.field').classList.toggle('is-invalid', Boolean(message));
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    if (hint.textContent !== message) hint.textContent = message;
  }

  fields.forEach((input) => {
    const kind = input.dataset.kind;

    input.addEventListener('beforeinput', (e) => {
      // Deleting across a thousands separator removes the digit beside it.
      if (kind !== 'money' || input.selectionStart !== input.selectionEnd) return;
      const i = input.selectionStart;
      const v = input.value;
      if (e.inputType === 'deleteContentBackward' && v[i - 1] === ',' && i >= 2) {
        e.preventDefault();
        input.value = v.slice(0, i - 2) + v.slice(i - 1);
        input.setSelectionRange(i - 2, i - 2);
        input.dispatchEvent(new Event('input'));
      } else if (e.inputType === 'deleteContentForward' && v[i] === ',') {
        e.preventDefault();
        input.value = v.slice(0, i + 1) + v.slice(i + 2);
        input.setSelectionRange(i + 1, i + 1);
        input.dispatchEvent(new Event('input'));
      }
    });

    input.addEventListener('input', () => {
      if (kind === 'money') groupMoney(input);
      else cleanRate(input);
      readInputs();
    });

    input.addEventListener('blur', () => {
      if (input.value.trim() === '') input.value = '0';
      const { value, error } = parseField(input.value, kind);
      if (!error) input.value = kind === 'money' ? formatMoney(value) : formatRate(value);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const { min, max } = LIMITS[kind];
      const step = STEPS[kind][e.shiftKey ? 1 : 0];
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      const next = clamp(Math.round((parseField(input.value, kind).value + dir * step) * 100) / 100, min, max);
      input.value = kind === 'money' ? formatMoney(next) : formatRate(next);
      input.dispatchEvent(new Event('input'));
    });

    // Clicking the $ or % beside a field focuses the field.
    input.closest('.input-shell').addEventListener('mousedown', (e) => {
      if (e.target === input) return;
      e.preventDefault();
      input.focus();
    });
  });

  // A preset fills its field; a typed value that matches no preset selects Custom.
  function linkPresets(select, input, presets, onMatch = () => {}) {
    presets.forEach((p, i) => select.add(new Option(p.label, String(i))));
    select.add(new Option('Custom', 'custom'));
    const sync = () => {
      const { value } = parseField(input.value, input.dataset.kind);
      const i = presets.findIndex((p) => p.rate === value);
      select.value = i === -1 ? 'custom' : String(i);
      onMatch(presets[i]);
    };
    select.addEventListener('change', () => {
      if (select.value === 'custom') return;
      input.value = formatRate(presets[Number(select.value)].rate);
      input.dispatchEvent(new Event('input'));
    });
    input.addEventListener('input', sync);
    sync();
  }

  // Enter in a field never reloads the page.
  controls.addEventListener('submit', (e) => e.preventDefault());

  /* ---------- Time horizon ---------- */

  // Tick density follows the range so the ruler stays readable at any maximum.
  function buildRuler() {
    const spanYears = MAX_YEARS - MIN_YEARS;
    const tickEvery = spanYears > 60 ? 5 : 1;
    const labelEvery = spanYears > 60 ? 20 : 10;
    const pos = (y) => `${((y - MIN_YEARS) / spanYears) * 100}%`;
    const labels = [MIN_YEARS];
    for (let y = labelEvery; y <= MAX_YEARS; y += labelEvery) if (y > MIN_YEARS) labels.push(y);
    if (labels[labels.length - 1] !== MAX_YEARS) labels.push(MAX_YEARS);

    for (let y = MIN_YEARS; y <= MAX_YEARS; y++) {
      const major = labels.includes(y) || (tickEvery === 1 && y % 5 === 0);
      if (!major && y % tickEvery !== 0) continue;
      const tick = document.createElement('span');
      tick.className = major ? 'ruler-tick is-major' : 'ruler-tick';
      tick.style.left = pos(y);
      tick.dataset.year = String(y);
      rulerTicks.append(tick);
    }
    labels.forEach((y) => {
      const label = document.createElement('span');
      label.className = 'ruler-label';
      label.style.left = pos(y);
      label.textContent = String(y);
      rulerLabels.append(label);
    });
  }

  function syncYears() {
    const y = Number(yearsInput.value);
    const text = yearsLabel(y);
    yearsOut.textContent = text;
    yearsInput.setAttribute('aria-valuetext', text);
    yearsInput.style.setProperty('--p', String((y - MIN_YEARS) / (MAX_YEARS - MIN_YEARS)));
    for (const tick of rulerTicks.children) tick.classList.toggle('is-on', Number(tick.dataset.year) <= y);
  }

  yearsInput.addEventListener('input', () => {
    syncYears();
    readInputs();
  });

  /* ---------- Optional sections ---------- */

  // Closed, a section's fields fold away and drop out of the tab order.
  function setOpen(button, body, on) {
    button.setAttribute('aria-checked', String(on));
    body.classList.toggle('is-open', on);
    body.inert = !on;
  }

  function syncSplit() {
    const inv = Number(splitInput.value);
    splitInvPct.textContent = `${inv}%`;
    splitCashPct.textContent = `${100 - inv}%`;
    splitInput.setAttribute('aria-valuetext', `${inv}% invested, ${100 - inv}% not invested`);
    splitInput.style.setProperty('--p', String(inv / 100));
  }

  incomeSwitch.addEventListener('click', () => {
    setOpen(incomeSwitch, incomeBody, !isOn(incomeSwitch));
    readInputs(true);
  });

  splitInput.addEventListener('input', () => {
    syncSplit();
    readInputs();
  });

  simSwitch.addEventListener('click', () => {
    sim.on = !isOn(simSwitch);
    setOpen(simSwitch, simBody, sim.on);
    // The fan grows out of the fixed-rate line: with no swings, every future is that line.
    if (sim.on && !fan) {
      fan = true;
      bands = simulate(shown, 0);
    }
    readInputs(true);
  });

  reshuffle.addEventListener('click', () => {
    sim.seed += 1;
    readInputs(true);
  });

  realSwitch.addEventListener('click', () => {
    setOpen(realSwitch, realBody, !isOn(realSwitch));
    readInputs(true);
  });

  /* ---------- Start ---------- */

  if (!engine) {
    simSwitch.disabled = true;
    simNote.textContent = "The simulation couldn't load";
  }
  swingsInput.value = formatRate(SWINGS.initial);
  inflInput.value = formatRate(INFLATION.initial);
  linkPresets(swingPreset, swingsInput, SWINGS.presets);
  linkPresets(inflPreset, inflInput, INFLATION.presets, (preset) => {
    inflNote.textContent = preset ? `${preset.note}.` : '';
    inflNote.hidden = !preset;
  });
  yearsInput.min = String(MIN_YEARS);
  yearsInput.max = String(MAX_YEARS);
  buildRuler();
  syncYears();
  syncSplit();
  readInputs();
  ready = true;

  new ResizeObserver(() => draw()).observe($('chart'));
  // A column taller than the window sticks by its bottom edge, so all of it stays reachable.
  const results = $('chart').closest('.results');
  new ResizeObserver(() => controls.style.setProperty('--panel-h', `${controls.offsetHeight}px`)).observe(controls);
  new ResizeObserver(() => results.style.setProperty('--results-h', `${results.offsetHeight}px`)).observe(results);

  // Once the typeface is in, let time run forward from today to the horizon.
  const fontsReady = document.fonts ? document.fonts.ready : Promise.resolve();
  Promise.race([fontsReady, new Promise((resolve) => setTimeout(resolve, 900))]).then(() => {
    if (shown.reveal >= 1) {
      draw();
      return;
    }
    intro = { start: performance.now() };
    requestFrame();
  });
})();
