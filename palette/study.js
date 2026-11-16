/* Ferra Brake Analyzer - parameter studies (no DOM; runs in Node for tests).
 *
 * A study changes one CAD user parameter, re-cuts the section, carries the user's setup (body classes,
 * rotor/stator roles, gap flags, coil window) onto the new geometry, solves the operating point at fixed
 * supply voltage and wire gauge, and scores the result. sweep() runs a grid and then golden-section
 * refinement around the best grid point.
 */
function ferraStudyModule(root) {
  'use strict';

  // ---------------------------------------------------------------- identity across regenerations
  const bodyKey = b => (b.path || b.component || '') + '/' + b.name;

  /** baseline: Map key -> {cls, role, grade}. Unknown bodies fall back to classify(body) -> {cls, role, grade}. */
  function mapBodies(baseline, bodies, classify) {
    const cls = [], role = [], grade = [], unmatched = [];
    bodies.forEach(b => {
      let m = baseline.get(bodyKey(b));
      if (!m) { m = classify(b); unmatched.push(b.name); }
      cls.push(m.cls); role.push(m.role); grade.push(m.grade || null);
    });
    return { cls, role, grade, unmatched };
  }

  /**
   * Solver config for a body list. P: model params; mat: {defs, index} from FerraMaterials.makeDefs.
   * (Shared by the main view and studies so both build identical problems.)
   */
  function makeCfg(P, mat, cls, role, grade, coilExtra) {
    return { cls, role, gmaxDetect: P.gmaxDetect, torqueGapMax: P.torqueGapMax, coilExtra, coilRmin: P.coilRmin,
      powderMur: P.powderMur, powderJs: P.powderJs, steelDefs: mat.defs,
      bridgeMax: P.bridgeMax, bridgePicks: P.bridgePicks, bridgeOff: P.bridgeOff,
      steelMat: grade.map(g => (g != null && mat.index[g] != null ? mat.index[g] : 0)) };
  }

  /** Cooled area / heat capacity of a model for the thermal model (P.coolAreaCm2 > 0 overrides the area). */
  function thermalEnv(FI, FM, G, prob, bodies, cls, P) {
    const info = bodies.map((b, i) => Object.assign({ cls: cls[i] }, FM.thermalOf(cls[i], b.material)));
    const env = FI.heatEnvelope(G, prob, info, P.pack);
    if (P.coolAreaCm2 > 0) env.areaM2 = P.coolAreaCm2 * 1e-4;
    return env;
  }

  function gapSignature(g, keys) {
    const ka = keys[g.a], kb = keys[g.b];
    return { pair: ka < kb ? ka + '|' + kb : kb + '|' + ka, dir: g.dir,
      rc: 0.5 * (g.box.r0 + g.box.r1), zc: 0.5 * (g.box.z0 + g.box.z1), powder: g.powder, torque: g.torque };
  }

  /** Copy powder/torque flags from baseline gap signatures to newly detected gaps (same body pair + direction, nearest). */
  function mapGaps(baseSigs, gaps, keys) {
    const used = new Set();
    let unmatched = 0;
    gaps.forEach(g => {
      const s = gapSignature(g, keys);
      let best = -1, bd = Infinity;
      baseSigs.forEach((b, n) => {
        if (used.has(n) || b.pair !== s.pair || b.dir !== s.dir) return;
        const d = Math.hypot(b.rc - s.rc, b.zc - s.zc);
        if (d < bd) { bd = d; best = n; }
      });
      if (best >= 0) { used.add(best); g.powder = baseSigs[best].powder; g.torque = baseSigs[best].torque; }
      else unmatched++;
    });
    return unmatched;
  }

  function locate(lines, x) {
    if (x < lines[0] || x > lines[lines.length - 1]) return -1;
    let lo = 0, hi = lines.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (lines[m] > x) hi = m; else lo = m; }
    return lo;
  }

  /** Coil window from picked (r, z) points; null when there are no picks, 'lost' when none still flood-fills. */
  /** Coil mask from picks; refBox = window on the base geometry (closes leaks). Returns mask, null or 'lost'; info.clipped counts closed leaks. */
  function coilMaskFromPicks(F, G, picks, refBox, info) {
    if (!picks || !picks.length) return null;
    const r = F.coilFromPicks(G, picks, refBox);
    if (info) info.clipped = r.clipped;
    return r.mask || 'lost';
  }

  // ---------------------------------------------------------------- objectives and constraints
  const OBJECTIVES = {
    torque: { label: 'Torque', unit: 'N·m', dir: 'max', get: m => m.T, d: 3 },
    torquePerW: { label: 'Torque per coil watt', unit: 'N·m/W', dir: 'max', get: m => (m.P > 0 ? m.T / m.P : null), d: 4 },
    torquePerKg: { label: 'Torque per kg', unit: 'N·m/kg', dir: 'max', get: m => (m.massKg > 0 ? m.T / m.massKg : null), d: 3 },
    util: { label: 'Flux utilisation', unit: '%', dir: 'max', get: m => 100 * m.util, d: 1 },
    Bgap: { label: 'Mean B in torque gaps', unit: 'T', dir: 'max', get: m => m.Bg, d: 4 },
    Bpoint: { label: '|B| at a point', unit: 'T', dir: 'max', get: m => m.Bpoint, d: 4 },
    lineFlux: { label: 'Flux through a probe line', unit: 'mWb', dir: 'max', get: m => (m.lineFlux != null ? m.lineFlux * 1e3 : null), d: 4 },
    Tcoil: { label: 'Coil temperature (steady state)', unit: '°C', dir: 'min', get: m => m.Tcoil, d: 1 },
    steelB98: { label: 'Highest steel B98', unit: 'T', dir: 'min', get: m => m.steelB98, d: 3 },
    mass: { label: 'Mass', unit: 'kg', dir: 'min', get: m => m.massKg, d: 3 },
    force: { label: 'Brake force', unit: 'kgf', dir: 'max', get: m => m.Fkgf, d: 2 },
    steelMass: { label: 'Steel mass', unit: 'kg', dir: 'min', get: m => m.steelMassKg, d: 3 },
    forcePerSteelKg: { label: 'Force per kg of steel', unit: 'kgf/kg', dir: 'max', get: m => (m.steelMassKg > 0 && m.Fkgf != null ? m.Fkgf / m.steelMassKg : null), d: 2 }
  };

  // ---------------------------------------------------------------- steel mass
  const STEEL_RHO = 7850; // kg/m^3
  /**
   * Mass of the bodies treated as magnetic steel. Uses the CAD mass of each body when every steel body has one
   * (catches holes and slots); otherwise revolves the section cells of the steel bodies (axisymmetric estimate).
   */
  function steelMass(G, bodies, cls) {
    const ids = bodies.map((b, i) => i).filter(i => cls[i] === 'steel');
    if (!ids.length) return { kg: 0, source: 'none' };
    if (ids.every(i => bodies[i].massKg > 0)) return { kg: ids.reduce((s, i) => s + bodies[i].massKg, 0), source: 'cad' };
    let m = 0;
    if (G && G.cellBody) {
      for (let j = 0; j < G.nz; j++) for (let i = 0; i < G.nr; i++) {
        const b = G.cellBody[j * G.nr + i];
        if (b < 0 || cls[b] !== 'steel') continue;
        m += 2 * Math.PI * G.rc[i] * (G.rs[i + 1] - G.rs[i]) * (G.zs[j + 1] - G.zs[j]); // mm^3
      }
    }
    return { kg: m * 1e-9 * STEEL_RHO, source: 'section' };
  }

  /** Brake force (kgf) at the force radius rForce (mm) through the output ratio. */
  const forceKgf = (T, P) => (T != null && P.rForce > 0 ? T * (P.ratio || 1) / (P.rForce * 1e-3) / 9.80665 : null);

  /** Full-factorial combinations of the axis grids: [[x0, y0, ...], ...], first axis varying fastest. */
  function factorial(grids) {
    let out = [[]];
    for (const g of grids) {
      const next = [];
      for (const x of g) for (const r of out) next.push(r.concat([x]));
      out = next;
    }
    return out;
  }

  /** Points on the upper-left frontier: no other point has less x and more (or equal) y. pts: [{x, y}]. */
  function pareto(pts) {
    const s = pts.filter(p => isFinite(p.x) && isFinite(p.y)).sort((a, b) => a.x - b.x || b.y - a.y);
    const out = [];
    let best = -Infinity;
    for (const p of s) if (p.y > best) { out.push(p); best = p.y; }
    return out;
  }

  /** c: {Pmax, Jmax, steelB98Max, Tmax} (any may be null). Returns a list of violated limits. */
  function violations(m, c) {
    const v = [];
    if (c.Tmax != null && m.Tcoil != null && m.Tcoil > c.Tmax) v.push(`coil ${m.runaway ? 'thermal runaway' : m.Tcoil.toFixed(0) + ' °C'} > ${c.Tmax} °C`);
    if (c.Pmax != null && m.P > c.Pmax) v.push(`P ${m.P.toFixed(1)} > ${c.Pmax} W`);
    if (c.Jmax != null && m.J > c.Jmax) v.push(`J ${m.J.toFixed(1)} > ${c.Jmax} A/mm²`);
    if (c.steelB98Max != null && m.steelB98 > c.steelB98Max) v.push(`steel B98 ${m.steelB98.toFixed(2)} > ${c.steelB98Max} T`);
    return v;
  }

  /** Higher is better; -Infinity for failed or constraint-violating points. */
  function score(pt, objective, dir) {
    if (pt.status !== 'ok' || (pt.violations && pt.violations.length)) return -Infinity;
    const v = OBJECTIVES[objective].get(pt.metrics);
    if (v == null || !isFinite(v)) return -Infinity;
    return dir === 'min' ? -v : v;
  }

  // ---------------------------------------------------------------- evaluate one design variant
  /**
   * ctx: {F, FI, FM, compute, classify, P, mat: {defs, index}, base: {bodies: Map, gaps: [sig], coilPicks},
   *       point: [r, z] | null, line: [[r, z], [r, z]] | null}
   * geo: section from the CAD. Fixed supply voltage and wire gauge (P.V, P.swg); the coil runs at P.tempC or, with
   * P.thermalOp, at its steady-state temperature.
   */
  async function evaluateGeometry(ctx, geo, massKg) {
    const { F, FI, P } = ctx;
    const bodies = geo.bodies, keys = bodies.map(bodyKey), notes = [];
    const mb = mapBodies(ctx.base.bodies, bodies, ctx.classify);
    if (mb.unmatched.length) notes.push('new bodies classified by default: ' + mb.unmatched.join(', '));
    const G = F.buildGrid(bodies, { hmax: P.hmax });
    // Parts that intersect (a parameter pushed one body into another) rebuild without a timeline error in Fusion.
    // Overlaps already in the base design (press fits, bearings) are tolerated up to twice their area + 1 mm^2.
    const newOverlaps = (G.overlaps || []).filter(o => {
      if (mb.cls[o.a] === 'ignore' || mb.cls[o.b] === 'ignore') return false;
      const key = [keys[o.a], keys[o.b]].sort().join(' & '), was = ctx.base.overlaps ? ctx.base.overlaps.get(key) || 0 : 0;
      return o.areaMM2 > 2 * was + 1;
    });
    if (newOverlaps.length) {
      const nm = i => (bodies[i].component && bodies[i].component !== bodies[i].name ? bodies[i].component + '/' : '') + bodies[i].name;
      return { status: 'cad', notes, reason: 'Bodies intersect: ' + newOverlaps.map(o => `${nm(o.a)} and ${nm(o.b)} (${o.areaMM2.toFixed(1)} mm² of section)`).join('; ') };
    }
    const ci = {};
    const coilExtra = coilMaskFromPicks(F, G, ctx.base.coilPicks, ctx.base.coilBox, ci);
    if (coilExtra === 'lost') return { status: 'error', reason: 'Picked coil window no longer encloses empty space', notes };
    if (ci.clipped) notes.push('coil window opens to the outside here (lead hole?); closed at the original window outline');
    const cfg = makeCfg(P, ctx.mat, mb.cls, mb.role, mb.grade, coilExtra);
    let prob = F.buildProblem(G, cfg, null);
    const ug = mapGaps(ctx.base.gaps, prob.gaps, keys);
    if (ug) notes.push(`${ug} gap(s) without a match, default flags`);
    prob = F.buildProblem(G, cfg, prob.gaps);
    if (!(prob.coilAreaM2 > 0)) return { status: 'error', reason: 'No coil window', notes };
    if (!prob.gaps.some(g => g.torque)) return { status: 'error', reason: 'No torque gap detected', notes };
    const win = F.coilWindow(prob);
    const env = thermalEnv(FI, ctx.FM, G, prob, bodies, mb.cls, P);
    const { e, th } = FI.coilState(F, win, P, env);
    if (!(e.NI > 0)) return { status: 'error', reason: 'No turns fit in the coil window', notes };
    await ctx.compute.call('load', { bodies, hmax: P.hmax, cfg, gaps: prob.gaps });
    const sol = await ctx.compute.call('solve', { NI: e.NI, keep: 'op', fields: true });
    const an = F.analyse(prob, sol, bodies.length);
    const sum = FI.summarize(F, prob, sol.stats, an, { tauSat: P.tauSat * 1e3, Bs: P.Bs });
    let steelB98 = 0, steelB98Body = null;
    an.bodies.forEach(b => { if (mb.cls[b.id] === 'steel' && b.Bp98 > steelB98) { steelB98 = b.Bp98; steelB98Body = bodies[b.id].name; } });
    const pp = ctx.point ? FI.probePoint(G, sol, ctx.point[0], ctx.point[1]) : null;
    const pl = ctx.line ? FI.probeLine(G, sol, ctx.line[0], ctx.line[1], 40) : null;
    const sm = steelMass(G, bodies, mb.cls);
    return {
      status: 'ok', notes,
      metrics: { T: sum.T.total, NI: e.NI, N: e.N, I: e.I, R: e.R, P: e.P, J: e.Jw, massKg: massKg != null ? massKg : env.massKg,
        util: sum.util, Bg: sum.Bg, gapMMF: sum.gapMMF, steelB98, steelB98Body, Bpoint: pp ? pp.B : null,
        lineFlux: pl ? pl.flux : null, Tcoil: th ? th.Tss : null, runaway: th ? th.runaway : false,
        converged: sol.converged, coilAreaMM2: win.areaMM2, Fkgf: forceKgf(sum.T.total, P),
        steelMassKg: sm.kg, steelMassSource: sm.source }
    };
  }

  // ---------------------------------------------------------------- search
  function grid(lo, hi, n, log) {
    const out = [];
    for (let k = 0; k < n; k++) {
      const t = n === 1 ? 0 : k / (n - 1);
      out.push(log ? lo * Math.pow(hi / lo, t) : lo + t * (hi - lo));
    }
    return out;
  }

  /**
   * evalAt(x) -> Promise<score> (higher is better, -Infinity = infeasible).
   * Grid first, then golden-section refinement inside the bracket around the best grid point.
   * Returns {best: {x, score}, atEdge, bracket}.
   */
  async function sweep(xs, refineN, evalAt, stopped) {
    const seen = [];
    const f = async x => {
      const hit = seen.find(p => Math.abs(p.x - x) <= 1e-9 * Math.max(1, Math.abs(x)));
      if (hit) return hit.s;
      const s = await evalAt(x);
      seen.push({ x, s });
      return s;
    };
    for (const x of xs) { if (stopped()) break; await f(x); }
    const bestOf = () => seen.reduce((b, p) => (p.s > b.s ? p : b), { x: null, s: -Infinity });
    let best = bestOf();
    if (best.x == null || !isFinite(best.s)) return { best: null, atEdge: false, bracket: null };
    const k = xs.indexOf(best.x);
    const atEdge = k === 0 || k === xs.length - 1;
    let a = xs[Math.max(0, k - 1)], b = xs[Math.min(xs.length - 1, k + 1)];
    if (refineN > 0 && xs.length > 1 && !stopped()) {
      const g = (Math.sqrt(5) - 1) / 2;
      let c = b - g * (b - a), d = a + g * (b - a);
      let fc = await f(c), fd = stopped() ? -Infinity : await f(d), left = refineN - 2;
      while (left > 0 && !stopped()) {
        if (fc >= fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = await f(c); }
        else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = await f(d); }
        left--;
      }
      best = bestOf();
    }
    return { best, atEdge, bracket: [a, b] };
  }

  // ---------------------------------------------------------------- two parameters
  /** Solve the n x n system A x = b (Gaussian elimination, partial pivoting). null when singular. */
  function solveLinear(A, b) {
    const n = b.length, M = A.map((row, i) => row.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-12) return null;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = c + 1; r < n; r++) {
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = M[r][n];
      for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
      x[r] = s / M[r][r];
    }
    return x;
  }

  /**
   * Least-squares quadratic f = a + b u + c v + d u^2 + e u v + f v^2 through pts [{u, v, s}] (finite s).
   * Returns the maximiser clamped to box [u0,u1]x[v0,v1], or null when the fit is not concave / under-determined.
   */
  function quadraticPeak(pts, box) {
    const P = pts.filter(p => isFinite(p.s));
    if (P.length < 6) return null;
    const basis = p => [1, p.u, p.v, p.u * p.u, p.u * p.v, p.v * p.v];
    const A = Array.from({ length: 6 }, () => new Array(6).fill(0)), r = new Array(6).fill(0);
    for (const p of P) {
      const q = basis(p);
      for (let i = 0; i < 6; i++) { r[i] += q[i] * p.s; for (let j = 0; j < 6; j++) A[i][j] += q[i] * q[j]; }
    }
    const c = solveLinear(A, r);
    if (!c) return null;
    const [, b1, b2, d, e, f] = c;
    if (!(2 * d < 0 && 4 * d * f - e * e > 0)) return null; // not a maximum
    const uv = solveLinear([[2 * d, e], [e, 2 * f]], [-b1, -b2]);
    if (!uv) return null;
    return { u: Math.min(box.u1, Math.max(box.u0, uv[0])), v: Math.min(box.v1, Math.max(box.v0, uv[1])) };
  }

  /**
   * Two-parameter study. xs, ys: grid values. evalAt([x, y]) -> Promise<score> (higher better).
   * Grid first; then, inside the cells next to the best grid point, one quadratic-surrogate guess and a bounded
   * Nelder-Mead search for the remaining refine budget. Returns {best: {v, s}, atEdge: [bool, bool], box}.
   */
  async function sweep2(xs, ys, refineN, evalAt, stopped) {
    const seen = [];
    const same = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
    const f = async v => {
      const hit = seen.find(p => same(p.v[0], v[0]) && same(p.v[1], v[1]));
      if (hit) return hit.s;
      const s = await evalAt(v);
      seen.push({ v, s });
      return s;
    };
    for (const y of ys) for (const x of xs) { if (stopped()) break; await f([x, y]); }
    const bestOf = () => seen.reduce((b, p) => (p.s > b.s ? p : b), { v: null, s: -Infinity });
    const g = bestOf();
    if (!g.v || !isFinite(g.s)) return { best: null, atEdge: [false, false], box: null };
    const i = xs.findIndex(x => same(x, g.v[0])), j = ys.findIndex(y => same(y, g.v[1]));
    const atEdge = [i === 0 || i === xs.length - 1, j === 0 || j === ys.length - 1];
    // normalised coordinates: one grid cell = 1, origin at the best grid point
    const dx = xs.length > 1 ? (xs[xs.length - 1] - xs[0]) / (xs.length - 1) : 1;
    const dy = ys.length > 1 ? (ys[ys.length - 1] - ys[0]) / (ys.length - 1) : 1;
    const box = { u0: i > 0 ? -1 : 0, u1: i < xs.length - 1 ? 1 : 0, v0: j > 0 ? -1 : 0, v1: j < ys.length - 1 ? 1 : 0 };
    const toV = (u, v) => [g.v[0] + u * dx, g.v[1] + v * dy];
    const clamp = p => ({ u: Math.min(box.u1, Math.max(box.u0, p.u)), v: Math.min(box.v1, Math.max(box.v0, p.v)) });
    let budget = refineN;
    const evalUV = async p => {
      const q = clamp(p), v = toV(q.u, q.v);
      const before = seen.length, s = await f(v);
      if (seen.length > before) budget--;
      return { u: q.u, v: q.v, s };
    };
    const boxOut = { x: [g.v[0] + box.u0 * dx, g.v[0] + box.u1 * dx], y: [g.v[1] + box.v0 * dy, g.v[1] + box.v1 * dy] };
    if (budget <= 0 || stopped()) return { best: bestOf(), atEdge, box: boxOut };

    // 1. quadratic surrogate through the neighbourhood
    const near = seen.map(p => ({ u: (p.v[0] - g.v[0]) / dx, v: (p.v[1] - g.v[1]) / dy, s: p.s }))
      .filter(p => p.u >= box.u0 - 1e-9 && p.u <= box.u1 + 1e-9 && p.v >= box.v0 - 1e-9 && p.v <= box.v1 + 1e-9);
    const peak = quadraticPeak(near, box);
    if (peak && (Math.abs(peak.u) > 1e-3 || Math.abs(peak.v) > 1e-3)) await evalUV(peak);

    // 2. bounded Nelder-Mead (maximising) from the best point so far
    if (budget > 0 && !stopped()) {
      const b0 = bestOf(), c0 = { u: (b0.v[0] - g.v[0]) / dx, v: (b0.v[1] - g.v[1]) / dy };
      const step = (c, k, sgn) => { const t = Object.assign({}, c); t[k] += sgn * 0.5; return t; };
      let S = [{ u: c0.u, v: c0.v, s: b0.s }];
      for (const k of ['u', 'v']) {
        if (budget <= 0 || stopped()) break;
        const first = c0[k] + 0.5 <= box[k + '1'] + 1e-9 ? 1 : -1;
        let V = await evalUV(step(c0, k, first));
        if (!isFinite(V.s) && budget > 0 && !stopped()) { const W = await evalUV(step(c0, k, -first)); if (isFinite(W.s)) V = W; }
        S.push(V);
      }
      let guard = 6 * refineN + 10;
      while (S.length === 3 && budget > 0 && !stopped() && guard-- > 0) {
        S.sort((a, b) => b.s - a.s);
        const [B, Gd, W] = S;
        const size = Math.max(Math.abs(B.u - W.u), Math.abs(B.v - W.v), Math.abs(B.u - Gd.u), Math.abs(B.v - Gd.v));
        if (size < 0.05) break;
        const C = { u: (B.u + Gd.u) / 2, v: (B.v + Gd.v) / 2 };
        const R = await evalUV({ u: C.u + (C.u - W.u), v: C.v + (C.v - W.v) });
        if (R.s > B.s && budget > 0) {
          const E = await evalUV({ u: C.u + 2 * (C.u - W.u), v: C.v + 2 * (C.v - W.v) });
          S[2] = E.s > R.s ? E : R;
        } else if (R.s > Gd.s) S[2] = R;
        else if (budget > 0) {
          const K = await evalUV({ u: C.u + 0.5 * (W.u - C.u), v: C.v + 0.5 * (W.v - C.v) });
          if (K.s > W.s) S[2] = K;
          else { // shrink toward the best vertex
            for (const n of [1, 2]) { if (budget <= 0 || stopped()) break; S[n] = await evalUV({ u: B.u + 0.5 * (S[n].u - B.u), v: B.v + 0.5 * (S[n].v - B.v) }); }
          }
        } else break;
      }
    }
    return { best: bestOf(), atEdge, box: boxOut };
  }

  /** CAD expression for a value in the parameter's own unit. */
  const expr = (x, unit) => String(+x.toPrecision(6)) + (unit ? ' ' + unit : '');

  const api = { bodyKey, mapBodies, makeCfg, thermalEnv, gapSignature, mapGaps, coilMaskFromPicks, OBJECTIVES, violations, score,
    evaluateGeometry, grid, sweep, sweep2, quadraticPeak, expr, steelMass, forceKgf, factorial, pareto };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FerraStudy = api;
  return api;
}
ferraStudyModule(typeof self !== 'undefined' ? self : this);
