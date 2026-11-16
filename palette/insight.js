/* Ferra Brake Analyzer - design insight (no DOM; runs in Node for tests).
 *
 * electricalLevers: which electrical inputs actually move the ampere-turns, and the regime that explains it.
 * shearElasticity:  how much torque responds to gap flux density under the powder shear model.
 * elasticities:     torque sensitivities from the perturbed solves (ampere-turns, all steel, each steel body).
 * limitBreakdown:   classify the design from those sensitivities instead of fixed MMF-share thresholds.
 * kneeNI:           ampere-turns where the T(NI) curve bends over (dlnT/dlnNI falls below 0.5).
 */
function ferraInsightModule(root) {
  'use strict';

  const pct = (a, b) => (b > 0 && isFinite(a) ? 100 * (a / b - 1) : null);

  /**
   * win: {areaMM2, rmeanMM}; p: coil params (V, swg, pack, Ilim, tempC, turnsOverride, Pmax, Jmax);
   * torqueAt: NI -> torque (or null before the field sweep exists).
   */
  function electricalLevers(F, win, p, torqueAt) {
    const base = F.coilElectrical(win, p);
    const T0 = torqueAt && base.NI > 0 ? torqueAt(base.NI) : null;
    const mk = (key, label, q) => {
      const e = F.coilElectrical(win, Object.assign({}, p, q));
      const T = T0 != null ? torqueAt(e.NI) : null;
      return { key, label, dNI: pct(e.NI, base.NI), dP: pct(e.P, base.P), dT: T0 != null ? pct(T, T0) : null, e };
    };
    const levers = [mk('V', 'Voltage +10 %', { V: p.V * 1.1 }), mk('Ilim', 'Current limit +10 %', { Ilim: p.Ilim * 1.1 })];
    if (p.turnsOverride > 0) levers.push(mk('turns', 'Turns +10 %', { turnsOverride: Math.round(p.turnsOverride * 1.1) }));
    else levers.push(mk('pack', 'Packing +0.05', { pack: Math.min(0.95, p.pack + 0.05) }));
    const wl = F.wireList ? F.wireList(p.wire || 'SWG') : null, wi = wl ? wl.findIndex(o => o.key === p.swg) : -1;
    if (wi > 0) levers.push(mk('swg', `${wl[wi - 1].name} (thicker)`, { swg: wl[wi - 1].key }));
    levers.push(mk('temp', 'Coil +20 °C', { tempC: p.tempC + 20 }));

    let regime;
    if (!(base.N > 0)) regime = { kind: 'none' };
    else if (base.limitedBy === 'supply limit') regime = { kind: 'current', Vknee: p.Ilim * base.R };
    else regime = { kind: 'voltage', Iknee: base.I };
    const flags = [];
    if (p.Pmax > 0 && base.P > p.Pmax) flags.push({ kind: 'power', value: base.P, limit: p.Pmax });
    if (p.Jmax > 0 && base.Jw > p.Jmax) flags.push({ kind: 'density', value: base.Jw, limit: p.Jmax });
    if (base.overfill) flags.push({ kind: 'overfill', value: base.N, limit: base.Nfit });
    return { base, regime, levers, flags };
  }

  /**
   * d lnT / d lnB for the torque gaps at the solved field, from tau = tauSat * tanh(B/Bs):
   * B tau'/tau = x sech^2(x) / tanh(x), torque-weighted. 1 = torque proportional to B, 0 = shear saturated.
   */
  function shearElasticity(prob, stats, tp) {
    let num = 0, den = 0;
    stats.forEach((st, n) => {
      if (!prob.gaps[n].torque) return;
      for (const [B, rm, len] of st.seg) {
        const x = B / tp.Bs, t = Math.tanh(x), w = rm * rm * len;
        den += t * w;
        num += x * (1 - t * t) * w;
      }
    });
    return den > 0 ? num / den : null;
  }

  /**
   * sens: {eps, ni: stats|null, all: stats|null, bodies: {id: stats}} from the engine's 'sens' solves.
   * torqueOf: stats -> total torque. Returns d lnT / d ln(x) for each perturbation.
   */
  function elasticities(sens, T0, torqueOf) {
    const el = st => (st && T0 > 0 ? (torqueOf(st) / T0 - 1) / sens.eps : null);
    const bodies = Object.keys(sens.bodies || {}).map(id => ({ id: +id, e: el(sens.bodies[id]) })).filter(b => b.e != null);
    bodies.sort((a, b) => b.e - a.e);
    return { eNI: el(sens.ni), eSteel: el(sens.all), bodies };
  }

  /**
   * Classify from sensitivities. Steel +x % means steel that carries x % more flux at every H
   * (about x % more cross-section where it is saturated), compared like-for-like with x % more NI.
   */
  function limitBreakdown(o) {
    const a = o.eNI != null ? Math.max(0, o.eNI) : null;
    const b = o.eSteel != null ? Math.max(0, o.eSteel) : null;
    const steelShare = a != null && b != null && a + b > 1e-6 ? b / (a + b) : null;
    let kind = 'pending';
    if (a != null && b != null) {
      if (o.eShear != null && o.eShear < 0.3 && Math.max(a, b) < 0.15) kind = 'powder';
      else if (steelShare == null) kind = 'flat';
      else if (steelShare > 0.6) kind = 'steel';
      else if (steelShare < 0.4) kind = 'ampere';
      else kind = 'balanced';
    }
    const top = o.bodies && o.bodies.length ? o.bodies[0] : null;
    const neck = top && top.e > 0.005 && (b == null || top.e > 0.1 * b) ? top : null;
    return { kind, steelShare, neck, bypass: o.util != null && o.util < 0.6 };
  }

  /** Torque and gap metrics at a solved field (shared by the results panel and parameter studies). */
  function summarize(F, prob, stats, an, tp) {
    const T = F.torqueFromStats(prob, stats, tp);
    const tg = prob.gaps.map((g, n) => ({ g, n })).filter(o => o.g.torque);
    const phiGap = tg.length ? Math.max(...tg.map(o => stats[o.n].flux)) : 0;
    const util = an.phiTotal > 0 ? phiGap / an.phiTotal : 0;
    const area = tg.reduce((s, o) => s + o.g.areaMM2, 0);
    const Bg = area > 0 ? tg.reduce((s, o) => s + stats[o.n].Bavg * o.g.areaMM2, 0) / area : 0;
    const gapMMF = tg.reduce((s, o) => s + an.gaps[o.n].mmfPct, 0);
    return { T, phiGap, util, Bg, gapMMF };
  }

  // ---------------------------------------------------------------- probes
  const MU0 = 4e-7 * Math.PI;

  function loc(lines, x) {
    if (!(x >= lines[0] && x <= lines[lines.length - 1])) return -1;
    let lo = 0, hi = lines.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (lines[m] > x) hi = m; else lo = m; }
    return lo;
  }

  /** Field in the grid cell containing (r, z) mm. null outside the model. */
  function probePoint(G, sol, r, z) {
    const i = loc(G.rs, r), j = loc(G.zs, z);
    if (i < 0 || j < 0) return null;
    const c = j * G.nr + i, B = sol.Bm[c], H = B > 0 ? sol.HB[c] / B : 0;
    return { c, B, Br: sol.Br[c], Bz: sol.Bz[c], H, mur: H > 0 ? B / (H * MU0) : null, body: G.cellBody[c] };
  }

  /** Flux function psi (= r A_phi, flux inside radius r / 2 pi) at (r, z) mm, bilinear between nodes. */
  function psiAt(G, psi, r, z) {
    const i = loc(G.rs, r), j = loc(G.zs, z);
    if (i < 0 || j < 0) return null;
    const NR = G.nr + 1, k = j * NR + i;
    const tr = (r - G.rs[i]) / (G.rs[i + 1] - G.rs[i]), tz = (z - G.zs[j]) / (G.zs[j + 1] - G.zs[j]);
    return (1 - tr) * (1 - tz) * psi[k] + tr * (1 - tz) * psi[k + 1] + (1 - tr) * tz * psi[k + NR] + tr * tz * psi[k + NR + 1];
  }

  /**
   * Samples along the segment a -> b ([r, z] mm). Bt along the line, Bn across it.
   * flux: total flux through the surface the segment sweeps about the axis = 2 pi |psi(b) - psi(a)| (Wb).
   */
  function probeLine(G, sol, a, b, n) {
    n = n || 120;
    const dr = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dr, dz);
    if (!(L > 0)) return null;
    const tr = dr / L, tz = dz / L, samples = [];
    let sum = 0, cnt = 0, max = 0;
    for (let k = 0; k <= n; k++) {
      const s = L * k / n, p = probePoint(G, sol, a[0] + tr * s, a[1] + tz * s);
      if (!p) { samples.push({ s, B: null }); continue; }
      const Bt = p.Br * tr + p.Bz * tz, Bn = -p.Br * tz + p.Bz * tr;
      samples.push({ s, B: p.B, Br: p.Br, Bz: p.Bz, Bt, Bn, H: p.H });
      sum += p.B; cnt++; max = Math.max(max, p.B);
    }
    const pa = psiAt(G, sol.psi, a[0], a[1]), pb = psiAt(G, sol.psi, b[0], b[1]);
    return { length: L, samples, Bmean: cnt ? sum / cnt : null, Bmax: cnt ? max : null,
      flux: pa != null && pb != null ? 2 * Math.PI * Math.abs(pb - pa) : null };
  }

  // ---------------------------------------------------------------- thermal
  /**
   * Volume, mass, heat capacity and cooled area of the model. info[body] = {cls, rho, c}; coil-window cells are
   * a copper / resin mix at the packing factor. Area = outer cylinder + both end faces of the envelope.
   */
  function heatEnvelope(G, prob, info, pack) {
    let rmax = 0, z0 = Infinity, z1 = -Infinity, C = 0, m = 0;
    const pk = Math.min(1, Math.max(0, pack || 0));
    const coilRho = pk * 8900 + (1 - pk) * 1200, coilRC = pk * 8900 * 385 + (1 - pk) * 1200 * 1500;
    for (let j = 0; j < G.nz; j++) for (let i = 0; i < G.nr; i++) {
      const c = j * G.nr + i, b = G.cellBody[c], coil = prob.coilMask[c];
      if (b < 0 && !coil) continue;
      const cls = b >= 0 ? info[b].cls : 'coil';
      if (cls === 'ignore') continue;
      const dV = 2 * Math.PI * 0.5 * (G.rs[i] + G.rs[i + 1]) * (G.rs[i + 1] - G.rs[i]) * (G.zs[j + 1] - G.zs[j]) * 1e-9;
      if (coil || cls === 'coil') { m += coilRho * dV; C += coilRC * dV; }
      else { m += info[b].rho * dV; C += info[b].rho * info[b].c * dV; }
      rmax = Math.max(rmax, G.rs[i + 1]); z0 = Math.min(z0, G.zs[j]); z1 = Math.max(z1, G.zs[j + 1]);
    }
    const R = rmax * 1e-3, L = isFinite(z0) ? (z1 - z0) * 1e-3 : 0;
    return { areaM2: 2 * Math.PI * R * L + 2 * Math.PI * R * R, heatCapJK: C, massKg: m, R, L };
  }

  /**
   * Lumped steady-state model: brake at one temperature, cooled through env.areaM2 at h, plus a coil-to-case
   * resistance Rth. Coil resistance follows temperature, so power and temperature are iterated together.
   * p: coil params + {Tamb, h, duty (%), Rth (K/W), Tmax}. Returns hot/cold electrical states and limits.
   */
  function thermal(F, win, p, env) {
    const Rth = 1 / Math.max(1e-9, p.h * env.areaM2) + (p.Rth || 0);
    const at = T => F.coilElectrical(win, Object.assign({}, p, { tempC: T }));
    const steady = duty => {
      let T = p.Tamb, e = at(T);
      for (let k = 0; k < 300; k++) {
        const Tn = p.Tamb + duty * e.P * Rth;
        if (!(Tn < 1000)) return { T: 1000, e: at(1000), runaway: true };
        if (Math.abs(Tn - T) < 1e-4) return { T: Tn, e: at(Tn), runaway: false };
        T += 0.7 * (Tn - T);
        e = at(T);
      }
      return { T, e, runaway: false };
    };
    const duty = Math.min(1, Math.max(0, (p.duty == null ? 100 : p.duty) / 100));
    const ss = steady(duty), cont = duty < 1 ? steady(1) : ss;
    const tau = env.heatCapJK * Rth;
    const tToMax = cont.T > p.Tmax ? -tau * Math.log(1 - (p.Tmax - p.Tamb) / (cont.T - p.Tamb)) : null;
    const eMax = at(p.Tmax);
    const maxDuty = eMax.P > 0 ? Math.min(1, Math.max(0, (p.Tmax - p.Tamb) / (eMax.P * Rth))) : 1;
    return { Tss: ss.T, runaway: ss.runaway, hot: ss.e, cold: at(p.Tamb), Rth, tau, Tcont: cont.T, tToMax, maxDuty,
      overMax: ss.T > p.Tmax };
  }

  /**
   * Coil state at the operating temperature. p: coil + thermal params (Tamb, hConv, duty, RthCoil, Tmax, thermalOp).
   * thermalOp = 1 solves the coil at its steady-state temperature, otherwise at p.tempC. env null = no thermal model.
   */
  function coilState(F, win, p, env) {
    const th = env ? thermal(F, win, Object.assign({}, p, { h: p.hConv, Rth: p.RthCoil }), env) : null;
    const e = p.thermalOp && th ? th.hot : F.coilElectrical(win, p);
    return { e, th };
  }

  /** pts: [[NI, T], ...] ascending. First NI where the local log-log slope falls below 0.5. */
  function kneeNI(pts) {
    for (let k = 1; k < pts.length; k++) {
      const [n0, t0] = pts[k - 1], [n1, t1] = pts[k];
      if (!(n0 > 0 && t0 > 0 && n1 > n0 && t1 > 0)) continue;
      if (Math.log(t1 / t0) / Math.log(n1 / n0) < 0.5) return Math.sqrt(n0 * n1);
    }
    return null;
  }

  const api = { electricalLevers, shearElasticity, elasticities, limitBreakdown, summarize, kneeNI,
    probePoint, psiAt, probeLine, heatEnvelope, thermal, coilState };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FerraInsight = api;
  return api;
}
ferraInsightModule(typeof self !== 'undefined' ? self : this);
