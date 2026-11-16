/* Ferra Brake Analyzer - Phase 4 analysis extras (no DOM; runs in Node for tests).
 *
 *   inductance / response   L = N * lambda / I from the flux-per-turn curve of the T(NI) sweep, and the
 *                           switch-on / switch-off transient of the nonlinear coil (no eddy currents).
 *   rotorInertia            J = sum rho * r^2 dV over the rotor bodies of the section (axisymmetric).
 *   fitShear                least-squares fit of tauSat (and Bs with two or more points) to measured torque.
 *   compareSections         flags disagreement between section angles.
 */
function ferraExtrasModule(root) {
  'use strict';
  const TWO_PI = 2 * Math.PI;

  /** Piecewise-linear interpolation through (xs, ys), linear extrapolation at the ends. xs ascending. */
  function interp(xs, ys, x) {
    const n = xs.length;
    if (n === 1) return ys[0];
    let k = 1;
    while (k < n - 1 && x > xs[k]) k++;
    const t = (x - xs[k - 1]) / (xs[k] - xs[k - 1]);
    return ys[k - 1] + t * (ys[k] - ys[k - 1]);
  }
  /** Inverse of a non-decreasing curve: x where y(x) = y. */
  function inverse(xs, ys, y) {
    for (let k = 1; k < xs.length; k++) if (y <= ys[k]) {
      const dy = ys[k] - ys[k - 1];
      return dy > 0 ? xs[k - 1] + (y - ys[k - 1]) / dy * (xs[k] - xs[k - 1]) : xs[k];
    }
    const n = xs.length - 1, dy = ys[n] - ys[n - 1];
    return dy > 0 ? xs[n] + (y - ys[n]) / dy * (xs[n] - xs[n - 1]) : xs[n];
  }

  /**
   * Curve from sweep points [{NI, phi}] and torques Ts (same order). Adds the origin.
   * Returns {NI: [], phi: [], T: []}.
   */
  function curve(pts, Ts) {
    const out = { NI: [0], phi: [0], T: [0] };
    pts.forEach((p, k) => { if (p.NI > out.NI[out.NI.length - 1]) { out.NI.push(p.NI); out.phi.push(p.phi || 0); out.T.push(Ts[k]); } });
    return out;
  }
  const slope = (c, NI) => { // dphi/dNI on the segment holding NI
    let k = 1;
    while (k < c.NI.length - 1 && NI >= c.NI[k]) k++;
    return (c.phi[k] - c.phi[k - 1]) / (c.NI[k] - c.NI[k - 1]);
  };

  /** Inductance at NI for N turns: secant L = N^2 phi / NI, incremental L = N^2 dphi/dNI, initial (unsaturated). */
  function inductance(c, N, NI) {
    const phi = interp(c.NI, c.phi, NI);
    return { Lsec: NI > 0 ? N * N * phi / NI : 0, Linc: N * N * slope(c, NI), L0: N * N * slope(c, 0), lambda: N * phi };
  }

  /**
   * Switching transient. Voltage drive V with an optional supply current limit Ilim; off by opening the switch
   * into a clamp of Voff volts (0.7 = freewheel diode, higher = Zener/TVS). Flux follows the static curve (no eddy
   * currents, no remanence).  dlambda/dt = v - R i  with  lambda = N phi(NI), i = NI / N.
   * Integrated in NI, where dt = N phi'(NI) dNI / (v - R NI / N) is exact on each linear segment.
   * Returns {NIf, Tf, tOn90, tOn90I, tOff10, tauLin, on: [[t, T]], off: [[t, T]]}.
   */
  function response(c, o) {
    const { N, R, V } = o, Ilim = o.Ilim > 0 ? o.Ilim : Infinity, Voff = o.Voff > 0 ? o.Voff : 0.7;
    const out = { on: [[0, 0]], off: [], tOn90: null, tOn90I: null, tOff10: null, tauLin: 0, NIf: 0, Tf: 0 };
    if (!(N > 0 && R > 0 && V > 0)) return out;
    const Iv = V / R, If = Math.min(Iv, Ilim), NIf = N * If, Tf = interp(c.NI, c.T, NIf);
    out.NIf = NIf; out.Tf = Tf; out.tauLin = N * N * slope(c, 0) / R;
    const tq = NI => interp(c.NI, c.T, NI);
    const NI90 = Math.min(inverse(c.NI, c.T, 0.9 * Tf), NIf), NI90I = 0.9 * NIf;
    const steps = 3000;
    // switch-on: from 0 to NI90 (or 90 % current, whichever is later)
    const top = Math.max(NI90, NI90I);
    let t = 0;
    const dN = top / steps;
    for (let s = 0; s < steps; s++) {
      const a = s * dN, m = a + dN / 2, drive = V - R * m / N;
      if (drive <= 0) break;
      t += N * slope(c, m) * dN / drive;
      const b = a + dN;
      if (out.tOn90 == null && b >= NI90 - 1e-9) out.tOn90 = t;
      if (out.tOn90I == null && b >= NI90I - 1e-9) out.tOn90I = t;
      if (s % 30 === 29) out.on.push([t, tq(b)]);
    }
    // switch-off from the steady state into the clamp
    const NI10 = inverse(c.NI, c.T, 0.1 * Tf);
    t = 0;
    out.off.push([0, Tf]);
    const dM = (NIf - NI10) / steps;
    for (let s = 0; s < steps; s++) {
      const a = NIf - s * dM, m = a - dM / 2;
      t += N * slope(c, m) * dM / (R * m / N + Voff);
      if (s % 30 === 29) out.off.push([t, tq(a - dM)]);
    }
    out.tOff10 = t;
    return out;
  }

  /**
   * Rotor mass moment of inertia about the axis from the section (axisymmetric bodies).
   * densityOf(bodyIndex) -> kg/m^3. Returns {J (kg m^2), mass (kg)}.
   */
  function rotorInertia(G, isRotor, densityOf) {
    let J = 0, m = 0;
    for (let j = 0; j < G.nz; j++) for (let i = 0; i < G.nr; i++) {
      const b = G.cellBody[j * G.nr + i];
      if (b < 0 || !isRotor(b)) continue;
      const r = G.rc[i] * 1e-3, dV = TWO_PI * r * (G.rs[i + 1] - G.rs[i]) * 1e-3 * (G.zs[j + 1] - G.zs[j]) * 1e-3;
      const dm = densityOf(b) * dV;
      m += dm; J += dm * r * r;
    }
    return { J, mass: m };
  }

  /**
   * Fit the shear model to measurements.  model(tp) -> {NIs, Ts} torque curve for that shear model (tp in Pa, T).
   * rows: [{NI, T}] measured. Torque is linear in tauSat, so for each Bs tauSat has a closed form (relative error
   * least squares); Bs is fitted by golden-section search on log(Bs) when there are two or more rows.
   * Returns {tauSat (Pa), Bs, rms (relative), rows: [{NI, T, Tfit, err}], fitBs}.
   */
  function fitShear(model, rows, Bs0) {
    rows = rows.filter(r => r.NI > 0 && r.T > 0);
    if (!rows.length) return null;
    const evalBs = Bs => {
      const c = model({ tauSat: 1, Bs });
      const u = rows.map(r => interp(c.NIs, c.Ts, r.NI)); // torque per Pa of tauSat
      let num = 0, den = 0;
      rows.forEach((r, k) => { const q = u[k] / r.T; num += q; den += q * q; });
      const tauSat = den > 0 ? num / den : 0;
      let ss = 0;
      const fit = rows.map((r, k) => { const Tf = tauSat * u[k], err = Tf / r.T - 1; ss += err * err; return { NI: r.NI, T: r.T, Tfit: Tf, err }; });
      return { tauSat, Bs, rms: Math.sqrt(ss / rows.length), rows: fit };
    };
    const distinct = new Set(rows.map(r => Math.round(r.NI))).size;
    if (distinct < 2) return Object.assign(evalBs(Bs0), { fitBs: false });
    let lo = Math.log(0.05), hi = Math.log(2.5);
    // coarse scan first: the error is not always unimodal over the full range
    let bestX = lo, bestF = Infinity;
    for (let k = 0; k <= 24; k++) {
      const x = lo + (hi - lo) * k / 24, f = evalBs(Math.exp(x)).rms;
      if (f < bestF) { bestF = f; bestX = x; }
    }
    const h = (hi - lo) / 24;
    let a = Math.max(lo, bestX - h), b = Math.min(hi, bestX + h);
    const g = (Math.sqrt(5) - 1) / 2;
    let x1 = b - g * (b - a), x2 = a + g * (b - a), f1 = evalBs(Math.exp(x1)).rms, f2 = evalBs(Math.exp(x2)).rms;
    for (let it = 0; it < 40; it++) {
      if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = b - g * (b - a); f1 = evalBs(Math.exp(x1)).rms; }
      else { a = x1; x1 = x2; f1 = f2; x2 = a + g * (b - a); f2 = evalBs(Math.exp(x2)).rms; }
    }
    const r = evalBs(Math.exp((a + b) / 2));
    r.fitBs = true;
    r.atEdge = Math.abs(Math.log(r.Bs) - lo) < 0.05 || Math.abs(Math.log(r.Bs) - hi) < 0.05;
    return r;
  }

  /**
   * Compare section-angle results with the reference (first) one.
   * runs: [{angle, status, reason, metrics: {T, Bg, util, coilAreaMM2, steelB98}, bodies: [names]}].
   * Flags |dT| > tol (default 5 %), coil area change > tol, or a different set of bodies.
   */
  function compareSections(runs, tol) {
    tol = tol || 0.05;
    const ref = runs.find(r => r.status === 'ok');
    if (!ref) return { rows: runs.map(r => Object.assign({}, r, { flags: [r.reason || 'failed'] })), spread: null, ok: false };
    let tMin = Infinity, tMax = -Infinity;
    const rows = runs.map(r => {
      if (r.status !== 'ok') return Object.assign({}, r, { flags: [r.reason || 'failed'] });
      const m = r.metrics, flags = [];
      const dT = m.T / ref.metrics.T - 1, dA = m.coilAreaMM2 / ref.metrics.coilAreaMM2 - 1;
      tMin = Math.min(tMin, m.T); tMax = Math.max(tMax, m.T);
      if (Math.abs(dT) > tol) flags.push(`torque ${dT > 0 ? '+' : ''}${(100 * dT).toFixed(1)} %`);
      if (Math.abs(dA) > tol) flags.push(`coil window ${dA > 0 ? '+' : ''}${(100 * dA).toFixed(0)} %`);
      const miss = ref.bodies.filter(b => r.bodies.indexOf(b) < 0), extra = r.bodies.filter(b => ref.bodies.indexOf(b) < 0);
      if (miss.length) flags.push('missing: ' + miss.join(', '));
      if (extra.length) flags.push('extra: ' + extra.join(', '));
      return Object.assign({}, r, { dT, dA, flags });
    });
    const spread = isFinite(tMin) ? (tMax - tMin) / ((tMax + tMin) / 2) : null;
    return { rows, spread, ok: rows.every(r => !r.flags.length), mean: null };
  }

  const api = { interp, inverse, curve, inductance, response, rotorInertia, fitShear, compareSections };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FerraExtras = api;
  return api;
}
ferraExtrasModule(typeof self !== 'undefined' ? self : this);
