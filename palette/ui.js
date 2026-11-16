/* Ferra Brake Analyzer - palette UI. Depends on solver.js (FerraSolver) and demo.js (FERRA_DEMO). */
(function () {
  'use strict';
  const F = window.FerraSolver, FI = window.FerraInsight, FS = window.FerraStudy, FM = window.FerraMaterials, FX = window.FerraExtras;
  const $ = id => document.getElementById(id);
  const G0 = 9.80665;

  // ------------------------------------------------------------------ state
  const P = { // model + electrical parameters (editable in Model settings)
    V: 24, swg: 27, wire: 'SWG', winding: 'random', bobbin: 0, pack: 0.75, Ilim: 3, tempC: 25, turnsOverride: 0, Pmax: 30, Jmax: 6,
    Voff: 0.7, rpm: 300,
    rForce: 30, ratio: 1,
    powderMur: 5, powderJs: 0.8, tauSat: 60, Bs: 0.6,
    hmax: 0.75, gmaxDetect: 3, torqueGapMax: 1.5, coilRmin: 0,
    Tamb: 25, hConv: 12, duty: 100, RthCoil: 0, Tmax: 130, coolAreaCm2: 0, thermalOp: 0,
    gradeScale: {} // steel grade id -> scale on the library curve
  };
  const S = {
    geo: null, meta: [], G: null, prob: null, coilPicks: [], coilExtra: null,
    sweep: null, op: null, opStats: null, opAn: null, opT: null, sens: null, el: null, neck: -1,
    token: 0, opTok: 0, stale: false, selected: -1, pickMode: false, view: null,
    customGrades: [], mat: null, probes: [], probeMode: null, probeA: null, probeSel: -1,
    resp: null, sum: null, snaps: [], calText: '', calFit: null,
    compute: window.ferraCompute(window.FerraSolver)
  };
  S.mat = FM.makeDefs(P.gradeScale, S.customGrades);

  // ------------------------------------------------------------------ helpers
  const fmt = (x, d = 2) => (x == null || !isFinite(x) ? '–' : x.toFixed(d));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sleep = () => new Promise(r => setTimeout(r, 0));
  function status(msg, kind) { const el = $('status'); el.textContent = msg; el.className = kind || ''; }
  const tp = () => ({ tauSat: P.tauSat * 1e3, Bs: P.Bs });
  const COLORS = ['#7aa6c2', '#c2a27a', '#8fc27a', '#c27a9e', '#7ac2b6', '#b6c27a', '#a07ac2', '#c2877a', '#7a8bc2', '#c2bf7a'];

  // ------------------------------------------------------------------ Fusion bridge
  const inFusion = () => typeof window.adsk !== 'undefined' && typeof window.adsk.fusionSendData === 'function';
  async function fusion(action, data) {
    if (!inFusion()) throw new Error('Not running inside Fusion.');
    return await window.adsk.fusionSendData(action, JSON.stringify(data || {}));
  }
  window.fusionJavaScriptHandler = { handle: function () { return 'OK'; } };

  // ------------------------------------------------------------------ classification defaults
  function classify(b) {
    const n = (b.name + ' ' + (b.component || '')).toLowerCase();
    const m = (b.material || '').toLowerCase();
    let cls = 'nonmag', role = 'stator', why = '';
    if (/coil|winding|bobbin.?wire/.test(n)) cls = 'coil';
    else if (/powder/.test(n)) cls = 'powder';
    else if (/bearing|screw|bolt|nut\b|washer|circlip|grub|key\b/.test(n)) { cls = 'ignore'; why = 'fastener/bearing'; }
    else if (/separator|o-?ring|seal|felt|v-?ring|gasket|spacer.*(nylon|ptfe|rubber)/.test(n)) { cls = 'nonmag'; why = 'seal/separator by name'; }
    else if (/stainless|inox|aisi\s*3\d\d|\b3(04|16)\b/.test(m)) cls = /\b4(10|16|20|30|40)\b/.test(m) ? 'steel' : 'nonmag';
    else if (/steel|iron|1018|1020|1010|en8|en3|c45|ms\b|mild/.test(m)) cls = 'steel';
    else if (/copper/.test(m)) cls = /coil|wind/.test(n) ? 'coil' : 'nonmag';
    else if (!m) { cls = 'steel'; why = 'no material set, assumed steel'; }
    if (/rotor|disc|disk|drum|shaft|hub|armature|inner.?cyl/.test(n)) role = 'rotor';
    return { cls, role, why, grade: FM.defaultGrade(b.material) };
  }

  // ------------------------------------------------------------------ pipeline
  // Every input names the earliest stage it invalidates; invalidate() re-runs that stage and everything after it:
  //   grid -> detect (gaps) -> problem -> T(NI) sweep -> electrical -> operating point -> sensitivities -> render
  const STAGE_OF = {
    hmax: 'grid', gmaxDetect: 'detect', torqueGapMax: 'detect',
    powderMur: 'problem', powderJs: 'problem', coilRmin: 'problem',
    Tamb: 'elec', hConv: 'elec', duty: 'elec', RthCoil: 'elec', Tmax: 'elec', coolAreaCm2: 'elec', thermalOp: 'elec',
    tauSat: 'torque', Bs: 'torque',
    V: 'elec', swg: 'elec', pack: 'elec', Ilim: 'elec', tempC: 'elec', turnsOverride: 'elec', Pmax: 'elec', Jmax: 'elec',
    rForce: 'elec', ratio: 'elec', wire: 'elec', winding: 'elec', bobbin: 'elec', Voff: 'elec', rpm: 'elec'
  };
  const SENS_EPS = 0.05; // +5 % perturbation for the sensitivity solves

  function invalidate(stage) {
    if (!S.G) { updateElectrical(); return; }
    if (stage === 'grid') rebuildGrid();
    else if (stage === 'detect') rebuildProblem(true);
    else if (stage === 'problem') rebuildProblem(false);
    else if (stage === 'torque') { updateElectrical(); renderGaps(); }
    else updateElectrical();
  }

  function fail(e) {
    console.error(e);
    status(String((e && e.message) || e).split('\n')[0], 'err');
  }

  /**
   * opts.carry: keep body classes/roles, gap flags and coil picks from the design currently loaded
   * (matched by component path + body name), e.g. when re-reading the same design or previewing a study run.
   */
  function loadGeometry(geo, opts) {
    opts = opts || {};
    const prev = opts.carry && S.geo && S.meta.length ? snapshotSetup() : null;
    S.geo = geo;
    S.meta = geo.bodies.map((b, i) => {
      const c = classify(b);
      const saved = (geo.classification && geo.classification[i]) || (prev && prev.bodies.get(FS.bodyKey(b)));
      return { name: b.name, component: b.component, material: b.material || '', cls: saved ? saved.cls : c.cls,
        role: saved ? saved.role : c.role, grade: (saved && saved.grade) || c.grade,
        why: saved ? '' : c.why, color: COLORS[i % COLORS.length], id: b.id != null ? b.id : i };
    });
    if (geo.params) {
      Object.assign(P, geo.params);
      if (!geo.params.wire) Object.assign(P, { wire: 'SWG', winding: 'random', bobbin: 0 }); // files from before wire standards
      P.gradeScale = Object.assign({}, geo.params.gradeScale || {});
      // files from before steel grades: a global "steel saturation knee" scaled the 1010 curve
      if (geo.params.steelKnee && Math.abs(geo.params.steelKnee - F.STEEL_KNEE_REF) > 1e-9 && !P.gradeScale['1010']) P.gradeScale['1010'] = geo.params.steelKnee / F.STEEL_KNEE_REF;
      delete P.steelKnee;
    }
    if (geo.materials && geo.materials.custom) S.customGrades = geo.materials.custom;
    if (geo.calibration != null) S.calText = geo.calibration;
    if (geo.snapshots) S.snaps = geo.snapshots.map(x => Object.assign({}, x, { geo: null }));
    refreshMat();
    if (!prev) { S.probes = geo.probes || []; S.probeSel = -1; }
    S.coilPicks = geo.coilPicks || (prev ? prev.coilPicks : []);
    S.pendingGaps = geo.gaps && geo.gaps.length ? geo.gaps : null;
    S.carryGaps = prev && !S.pendingGaps ? prev.gaps : null;
    renderSettings();
    $('source').textContent = (geo.source || 'Geometry') + (opts.label ? ' · ' + opts.label : '');
    $('empty').style.display = 'none';
    const w = (geo.warnings || []).map(esc);
    S.meta.forEach(m => { if (m.why === 'no material set, assumed steel') w.push(`${esc(m.name)}: no material set, treated as steel.`); });
    $('warnings').innerHTML = w.map(x => `<p>${x}</p>`).join('');
    syncSliders();
    rebuildGrid();
  }

  function rebuildGrid() {
    if (!S.geo) return;
    try { S.G = F.buildGrid(S.geo.bodies, { hmax: P.hmax }); }
    catch (e) { status(e.message, 'err'); return; }
    S.view = null;
    rebuildProblem(true);
  }

  function coilExtraMask() {
    if (!S.coilPicks.length) return null;
    const res = F.coilFromPicks(S.G, S.coilPicks, S.coilPickBox), mask = res.mask || new Uint8Array(S.G.nr * S.G.nz);
    S.coilClipped = res.clipped;
    return mask;
  }

  function locate(lines, x) {
    if (x < lines[0] || x > lines[lines.length - 1]) return -1;
    let lo = 0, hi = lines.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (lines[m] > x) hi = m; else lo = m; }
    return lo;
  }

  function cfg() {
    return FS.makeCfg(P, S.mat, S.meta.map(m => m.cls), S.meta.map(m => m.role), S.meta.map(m => m.grade), S.coilExtra);
  }

  function rebuildProblem(redetect) {
    S.coilExtra = coilExtraMask();
    const keep = !redetect && S.prob ? S.prob.gaps : null;
    S.prob = F.buildProblem(S.G, cfg(), keep);
    const pg = S.pendingGaps;
    S.pendingGaps = null;
    if (pg && pg.length === S.prob.gaps.length && pg.every((g, n) => g.dir === S.prob.gaps[n].dir)) {
      S.prob.gaps.forEach((g, n) => { g.powder = pg[n].powder; g.torque = pg[n].torque; });
      S.prob = F.buildProblem(S.G, cfg(), S.prob.gaps);
    }
    if (S.carryGaps) {
      FS.mapGaps(S.carryGaps, S.prob.gaps, S.geo.bodies.map(FS.bodyKey));
      S.carryGaps = null;
      S.prob = F.buildProblem(S.G, cfg(), S.prob.gaps);
    }
    S.token++; // drop any in-flight solves for the old problem
    S.sweep = null; S.op = null; S.opStats = null; S.opAn = null; S.opT = null; S.sens = null; S.el = null; S.neck = -1;
    renderTables();
    renderResults();
    draw();
    const hasCoil = S.prob.coilAreaM2 > 0;
    if (S.coilPicks.length && !S.coilClipped && S.prob.coilBox) S.coilPickBox = S.prob.coilBox; // reference outline for leaky variants
    $('coilNote').textContent = hasCoil
      ? `Window ${fmt(S.prob.coilAreaM2 * 1e6, 0)} mm², mean radius ${fmt(S.prob.coilRmean * 1e3, 1)} mm.${S.coilClipped ? ' The picked space opens to the outside in this section (lead hole?); closed at the earlier window outline.' : ''}`
      : 'No coil found. Mark a body as Coil, or pick the empty winding space in the section.';
    if (!hasCoil) { $('dCoilWin').open = true; status('Needs a coil window', 'err'); updateElectrical(); return; }
    if (!S.prob.gaps.some(g => g.torque)) status('No torque gap found: set rotor/stator roles', 'err');
    S.compute.call('load', { bodies: S.geo.bodies, hmax: P.hmax, cfg: cfg(), gaps: S.prob.gaps }).catch(fail);
    runSweep();
  }

  function coilWindow() {
    return F.coilWindow(S.prob);
  }

  // Cooled area / heat capacity of the loaded model (cached per problem, packing factor and area override).
  let envCache = null;
  function thermalEnvNow() {
    if (!S.prob || !S.G) return null;
    if (!envCache || envCache.prob !== S.prob || envCache.pack !== P.pack || envCache.area !== P.coolAreaCm2) {
      envCache = { prob: S.prob, pack: P.pack, area: P.coolAreaCm2,
        env: FS.thermalEnv(FI, FM, S.G, S.prob, S.geo.bodies, S.meta.map(m => m.cls), P) };
    }
    return envCache.env;
  }

  /** Coil state {e, th} at the operating temperature (fixed, or steady state when P.thermalOp). */
  function coilAt(swg, V) {
    const p = Object.assign({}, P, { V: V != null ? V : P.V, swg: swg != null ? swg : P.swg });
    return FI.coilState(F, coilWindow(), p, thermalEnvNow());
  }

  function elec(swg, V) { return coilAt(swg, V).e; }

  /** Params for the electrical levers: at the steady-state temperature when the operating point uses it. */
  function leverParams() {
    const st = coilAt();
    return P.thermalOp && st.th ? Object.assign({}, P, { tempC: st.th.Tss }) : P;
  }

  function sweepMaxNI() {
    let m = 0;
    for (const o of F.wireList(P.wire)) m = Math.max(m, elec(o.key, 60).NI, elec(o.key, P.V).NI);
    return Math.max(200, Math.min(m * 1.1, 20000));
  }

  async function runSweep() {
    const tok = ++S.token;
    const NImax = sweepMaxNI();
    const fr = [0.01, 0.025, 0.05, 0.08, 0.12, 0.17, 0.23, 0.3, 0.4, 0.5, 0.62, 0.75, 0.87, 1];
    const pts = [];
    try {
      for (let n = 0; n < fr.length; n++) {
        status(`Solving field ${n + 1}/${fr.length}`, 'busy');
        const r = await S.compute.call('solve', { NI: fr[n] * NImax, from: 'sweep', keep: 'sweep' });
        if (tok !== S.token) return;
        pts.push({ NI: r.NI, stats: r.stats, phi: r.phi, converged: r.converged });
      }
    } catch (e) { if (tok === S.token) fail(e); return; }
    S.sweep = { pts, NImax };
    status('Ready');
    updateElectrical();
  }

  function torqueAt(NI) {
    const pts = S.sweep.pts;
    const Ts = pts.map(p => F.torqueFromStats(S.prob, p.stats, tp()).total);
    if (NI <= pts[0].NI) return Ts[0] * NI / pts[0].NI;
    for (let k = 1; k < pts.length; k++) if (NI <= pts[k].NI) {
      const t = (NI - pts[k - 1].NI) / (pts[k].NI - pts[k - 1].NI);
      return Ts[k - 1] + t * (Ts[k] - Ts[k - 1]);
    }
    const n = pts.length - 1;
    return Ts[n] + (NI - pts[n].NI) * (Ts[n] - Ts[n - 1]) / (pts[n].NI - pts[n - 1].NI);
  }

  // ------------------------------------------------------------------ electrical stage (sliders, coil settings)
  let opTimer = null;
  function updateElectrical() {
    const e = elec();
    const flag = e.overfill ? ' class="flag"' : '';
    $('coilKV').innerHTML = [
      ['Turns' + (P.turnsOverride > 0 ? ' (fixed)' : ' (fit)'), `<dd${flag}>${e.N}${P.turnsOverride > 0 ? ` <span class="note">fits ${e.Nfit}</span>` : ''}</dd>`],
      ['Resistance at ' + P.tempC + ' °C', `<dd>${fmt(e.R, 2)} Ω</dd>`],
      ['Current', `<dd>${fmt(e.I, 2)} A</dd>`],
      ['Ampere-turns', `<dd>${fmt(e.NI, 0)} A-t</dd>`],
      ['Power', `<dd${e.P > P.Pmax ? ' class="flag"' : ''}>${fmt(e.P, 1)} W</dd>`],
      ['Current density', `<dd${e.Jw > P.Jmax ? ' class="flag"' : ''}>${fmt(e.Jw, 2)} A/mm²</dd>`]
    ].map(([k, v]) => `<dt>${k}</dt>${v}`).join('');
    $('coilMoreKV').innerHTML = [
      ['Limited by', `<dd>${e.limitedBy}</dd>`],
      ['Wire length', `<dd>${fmt(e.lengthM, 1)} m</dd>`],
      ['Copper fill of window', `<dd>${fmt(100 * e.fill, 0)} %</dd>`],
      ['Power limit / density limit', `<dd>${P.Pmax} W / ${P.Jmax} A/mm²</dd>`]
    ].map(([k, v]) => `<dt>${k}</dt>${v}`).join('');
    $('gHint').textContent = `${fmt(e.di, 3)} mm over enamel`;
    renderLevers();
    renderThermal();
    renderResponse();
    if (!S.sweep) { renderGauges(); return; }
    if (e.NI > S.sweep.NImax) { runSweep(); return; }
    const T = torqueAt(e.NI);
    showTorque(T);
    renderGauges();
    drawCurve(e.NI, T);
    clearTimeout(opTimer);
    if (!(e.NI > 0)) return;
    if (S.op && Math.abs(S.op.NI - e.NI) <= 1e-9 * e.NI) {
      // Same ampere-turns: the field is unchanged, but torque settings and the electrical picture may not be.
      S.stale = false;
      renderResults(); renderGaps(); renderBodies();
      return;
    }
    S.stale = true;
    renderResults();
    opTimer = setTimeout(() => solveOperatingPoint(e.NI), 350);
  }

  function showTorque(T) {
    $('rT').textContent = fmt(T, 2);
    const Fn = T * P.ratio / (P.rForce * 1e-3);
    $('rF').textContent = fmt(Fn / G0, 1);
    $('rFlabel').textContent = `Force at r = ${P.rForce} mm${P.ratio !== 1 ? ` × ${P.ratio}` : ''}, kgf`;
  }

  const pc = x => (x == null || !isFinite(x) ? '–' : Math.abs(x) < 0.05 ? '0' : (x > 0 ? '+' : '−') + Math.abs(x).toFixed(Math.abs(x) < 10 ? 1 : 0));

  function renderLevers() {
    const box = $('regime'), tbl = $('levers');
    if (!S.prob || !S.prob.coilAreaM2) { box.innerHTML = '<span class="note">Needs a coil window.</span>'; tbl.innerHTML = ''; return; }
    const r = FI.electricalLevers(F, coilWindow(), leverParams(), S.sweep ? torqueAt : null), b = r.base;
    let html;
    if (r.regime.kind === 'none') html = '<strong>No turns fit.</strong> The window is too small for this wire.';
    else if (r.regime.kind === 'voltage') html = `<strong>Voltage-limited</strong> (I = V/R = ${fmt(b.I, 2)} A). NI = V·A<sub>wire</sub>/(ρ·MLT): the turn count cancels, so packing and turns trade current for power but leave NI and torque unchanged. The ${P.Ilim} A current limit only matters if set below ${fmt(r.regime.Iknee, 2)} A.`;
    else html = `<strong>Current-limited</strong> by the ${P.Ilim} A supply. NI = N × ${P.Ilim} A, so more turns or a higher limit add NI; voltage above ${fmt(r.regime.Vknee, 1)} V adds nothing.`;
    for (const f of r.flags) {
      if (f.kind === 'power') html += `<br><span class="warn">Power ${fmt(f.value, 1)} W is over the ${f.limit} W limit.</span>`;
      if (f.kind === 'density') html += `<br><span class="warn">Current density ${fmt(f.value, 1)} A/mm² is over the ${f.limit} A/mm² limit.</span>`;
      if (f.kind === 'overfill') html += `<br><span class="warn">${f.value} turns do not fit (max ${f.limit}).</span>`;
    }
    box.innerHTML = html;
    tbl.innerHTML = `<thead><tr><th class="l">Change</th><th>NI</th><th>Power</th><th>Torque</th></tr></thead><tbody>${
      r.levers.map(l => `<tr><td class="l">${esc(l.label)}</td><td class="${Math.abs(l.dNI || 0) < 0.05 ? 'mute' : ''}">${pc(l.dNI)} %</td><td>${pc(l.dP)} %</td><td>${pc(l.dT)} %</td></tr>`).join('')
    }</tbody>`;
  }

  // ------------------------------------------------------------------ operating point + sensitivities
  async function solveOperatingPoint(NI) {
    if (!S.sweep || NI <= 0) return;
    const tok = S.token, otok = ++S.opTok;
    const live = () => tok === S.token && otok === S.opTok;
    status('Solving operating point', 'busy');
    let r;
    try { r = await S.compute.call('solve', { NI, from: 'op', keep: 'op', fields: true }); }
    catch (e) { if (live()) fail(e); return; }
    if (!live()) return;
    S.op = r; S.opStats = r.stats; S.stale = false;
    S.opAn = F.analyse(S.prob, r, S.meta.length);
    S.sens = { NI, eps: SENS_EPS, ni: null, all: null, bodies: {}, pending: true };
    renderResults(); renderTables(); draw();
    drawCurve(NI, S.opT ? S.opT.total : torqueAt(NI));
    // Steel bodies that spend under 0.3 % of the ampere-turns cannot change torque measurably.
    const steel = S.opAn.bodies.filter(b => S.meta[b.id].cls === 'steel' && b.mmfPct >= 0.3)
      .sort((a, b) => b.mmfPct - a.mmfPct).slice(0, 8);
    const jobs = [{ kind: 'ni' }, { kind: 'all' }].concat(steel.map(b => ({ kind: 'body', body: b.id })));
    for (let n = 0; n < jobs.length; n++) {
      status(`Sensitivity ${n + 1}/${jobs.length}`, 'busy');
      let q;
      try { q = await S.compute.call('sens', Object.assign({ NI, eps: SENS_EPS }, jobs[n])); }
      catch (e) { if (live()) fail(e); return; }
      if (!live()) return;
      if (q.kind === 'body') { if (q.stats) S.sens.bodies[q.body] = q.stats; }
      else S.sens[q.kind] = q.stats;
      renderResults(); renderBodies();
    }
    S.sens.pending = false;
    status(r.converged ? 'Ready' : 'Field solve did not fully converge', r.converged ? '' : 'err');
    renderResults(); renderBodies(); draw();
  }

  // ------------------------------------------------------------------ limit breakdown
  // Fallback before the sensitivity solves finish: slope of the interpolated T(NI) curve.
  function elasticity(NI) {
    const h = 0.05;
    const t0 = torqueAt(NI * (1 - h)), t1 = torqueAt(NI * (1 + h));
    return (t1 - t0) / (t0 + t1) / h; // d lnT / d lnNI
  }

  function renderResults() {
    const an = S.opAn, st = S.opStats, prob = S.prob, v = $('verdict');
    if (!an || !st) {
      $('resKV').innerHTML = '';
      v.className = 'verdict';
      const msg = !S.geo ? 'Load a design to see whether the brake is balanced.' : prob && !prob.coilAreaM2 ? 'Needs a coil window: mark a body as Coil or pick the winding space (Coil window, left).' : 'Solving the field…';
      v.innerHTML = `<p class="note">${msg}</p>`;
      $('balCard').className = 'bal-card' + (S.stale ? ' stale' : '');
      $('balCard').innerHTML = `<p class="note">${msg}</p>`;
      renderMassLine();
      return;
    }
    const { T, phiGap, util, Bg, gapMMF } = FI.summarize(F, prob, st, an, tp());
    S.opT = T;
    if (!S.stale) showTorque(T.total);
    const eSh = FI.shearElasticity(prob, st, tp());
    const torqueOf = s => F.torqueFromStats(prob, s, tp()).total;
    const el = S.sens ? FI.elasticities(S.sens, T.total, torqueOf) : { eNI: null, eSteel: null, bodies: [] };
    S.el = el;
    const eNI = el.eNI != null ? el.eNI : elasticity(S.op.NI);
    const lb = FI.limitBreakdown({ eNI: el.eNI, eSteel: el.eSteel, bodies: el.bodies, eShear: eSh, util });
    const steelByMMF = an.bodies.filter(b => S.meta[b.id].cls === 'steel').sort((a, b) => b.mmfPct - a.mmfPct);
    const mmfTop = steelByMMF[0];
    if (lb.neck) S.neck = lb.neck.id;
    else if (lb.kind === 'pending') S.neck = mmfTop && mmfTop.mmfPct > 8 ? mmfTop.id : -1;
    else S.neck = -1;
    const tauFrac = Math.tanh(Bg / P.Bs);

    $('resKV').className = 'kv' + (S.stale ? ' stale' : '');
    $('resKV').innerHTML = [
      ['Mean B in torque gaps', `${fmt(Bg, 3)} T`],
      ['Powder shear used', `${fmt(100 * tauFrac, 0)} % of τ<sub>sat</sub>`],
      ['Coil flux', `${fmt(an.phiTotal * 1e3, 3)} mWb`],
      ['Flux through torque gap', `${fmt(phiGap * 1e3, 3)} mWb`],
      ['Flux utilisation', `${fmt(100 * util, 0)} %`],
      ['MMF spent in torque gaps', `${fmt(gapMMF, 0)} %`]
    ].map(([k, x]) => `<dt>${k}</dt><dd>${x}</dd>`).join('');

    const name = id => esc(S.meta[id].name);
    const at = id => { const h = an.bodies[id].hot; return h ? ` around r ${fmt(h[0], 1)} mm, z ${fmt(h[1], 1)} mm` : ''; };
    const reg = FI.electricalLevers(F, coilWindow(), leverParams(), null).regime.kind;
    const raiseNI = reg === 'current' ? 'raise the supply current limit or add turns' : 'raise the voltage or use thicker wire (turns cancel at fixed voltage)';
    const lines = [];
    const LABEL = { steel: 'Steel-limited', ampere: 'Ampere-turn limited', balanced: 'Balanced: steel and ampere-turns both matter',
      powder: 'Powder-shear limited', flat: 'Torque barely responds', pending: 'Working out what limits torque…' };
    S.sum = { util, Bg, gapMMF, kind: lb.kind, label: LABEL[lb.kind] };
    lines.push(`<p class="head"><strong>${LABEL[lb.kind]}</strong></p>`);
    renderBalanceCard(lb, { name, at, raiseNI, tauFrac, util });
    if (lb.kind === 'steel') lines.push(`<p>More flux capacity in the steel buys ${fmt(lb.steelShare / Math.max(1e-6, 1 - lb.steelShare), 1)}× more torque than the same percentage more ampere-turns.${lb.neck ? ` Biggest lever: <strong>${name(lb.neck.id)}</strong>${at(lb.neck.id)}. Add cross-section there before adding turns or current.` : ''}</p>`);
    else if (lb.kind === 'ampere') lines.push(`<p>The steel has headroom and torque follows NI. To get more NI, ${raiseNI}.</p>`);
    else if (lb.kind === 'balanced') lines.push(`<p>Neither lever dominates.${lb.neck ? ` The steel lever is mainly <strong>${name(lb.neck.id)}</strong>${at(lb.neck.id)}.` : ''}</p>`);
    else if (lb.kind === 'powder') lines.push(`<p>The gap field is at ${fmt(100 * tauFrac, 0)} % of shear saturation, so more flux buys little torque. Gains now come from radius, active length or more shear surfaces.</p>`);
    else if (lb.kind === 'flat') lines.push('<p>Neither more ampere-turns nor more steel changes torque. Check that the torque gaps are set correctly.</p>');

    // lever table: torque change per +10 %
    const rows = [['Ampere-turns', 10 * eNI, el.eNI == null]];
    if (el.eSteel != null) rows.push(['All steel, flux capacity', 10 * el.eSteel]);
    el.bodies.slice(0, 4).forEach(b => rows.push([`&nbsp;&nbsp;${name(b.id)}`, 10 * b.e]));
    if (eSh != null) rows.push(['Gap flux density (shear curve)', 10 * eSh]);
    lines.push(`<table class="mini"><thead><tr><th class="l">+10 % in…</th><th>Torque</th></tr></thead><tbody>${
      rows.map(([k, x, est]) => `<tr><td class="l">${k}${est ? ' <span class="note">(curve)</span>' : ''}</td><td>${pc(x)} %</td></tr>`).join('')}</tbody></table>`);
    if (S.sens && S.sens.pending) lines.push('<p class="note">Running sensitivity solves…</p>');

    if (lb.bypass) lines.push(`<p><strong>Flux bypass.</strong> Only ${fmt(100 * util, 0)} % of the coil flux crosses the torque gap. Follow the flux lines to the steel or non-working gap that short-circuits it; a non-magnetic separator there is usually the largest single gain.</p>`);
    if (mmfTop && lb.neck && mmfTop.id !== lb.neck.id && mmfTop.mmfPct > 10) {
      const e = el.bodies.find(b => b.id === mmfTop.id);
      lines.push(`<p class="note">${name(mmfTop.id)} spends the most ampere-turns (${fmt(mmfTop.mmfPct, 0)} %), but +10 % steel there adds only ${pc(e ? 10 * e.e : 0)} % torque: that MMF is spent on flux that does not limit torque.</p>`);
    }
    lines.push(`<p class="note">Energy check ${fmt(an.energyCheck, 3)} · solver ${esc(S.compute.mode)}.</p>`);
    v.className = 'verdict ' + (lb.kind === 'steel' ? 'steel' : '') + (S.stale ? ' stale' : '');
    v.innerHTML = lines.join('');
    renderMassLine();
  }

  // Headline verdict: is the brake balanced between steel and ampere-turns? Details stay in "Why: lever breakdown".
  function renderBalanceCard(lb, x) {
    const card = $('balCard');
    const share = lb.steelShare;
    const bar = share != null ? `<div class="balance" title="Share of the marginal torque gain that comes from steel vs ampere-turns"><span style="width:${(100 * share).toFixed(0)}%"></span></div>
        <div class="balance-lbl"><span>Ampere-turns ${fmt(100 * (1 - share), 0)} %</span><span>Steel ${fmt(100 * share, 0)} %</span></div>` : '';
    const neck = lb.neck ? `<strong>${x.name(lb.neck.id)}</strong>${x.at(lb.neck.id)}` : 'the most saturated steel (see Bodies)';
    let tone = 'info', head = '', body = '';
    if (lb.kind === 'pending') { head = 'Checking balance…'; body = 'Running the sensitivity solves.'; }
    else if (lb.kind === 'balanced') {
      tone = 'good'; head = 'Well balanced';
      body = 'Steel and ampere-turns both limit torque about equally: neither the iron nor the copper is being wasted.';
    } else if (lb.kind === 'steel') {
      tone = 'bad'; head = 'Not balanced: steel-limited';
      body = `The steel saturates before the coil runs out of ampere-turns. Add cross-section at ${neck}, or use less copper / power for the same torque.`;
    } else if (lb.kind === 'ampere') {
      tone = 'bad'; head = 'Not balanced: ampere-turn limited';
      body = `The steel has headroom, so it is heavier than it needs to be for this coil. Either trim steel, or ${x.raiseNI}.`;
    } else if (lb.kind === 'powder') {
      tone = 'info'; head = 'Powder-shear limited';
      body = `The gap is at ${fmt(100 * x.tauFrac, 0)} % of shear saturation. More flux buys little; more radius, active length or shear surfaces do.`;
    } else if (lb.kind === 'flat') {
      tone = 'bad'; head = 'Torque does not respond';
      body = 'Neither ampere-turns nor steel changes torque. Check the torque gaps in the Working gaps tab.';
    }
    const e = elec(), st = coilAt(), th = st && st.th, chips = [];
    if (e.P > P.Pmax) chips.push(`power ${fmt(e.P, 1)} W > ${P.Pmax} W`);
    if (e.Jw > P.Jmax) chips.push(`J ${fmt(e.Jw, 1)} > ${P.Jmax} A/mm²`);
    if (e.overfill) chips.push('turns do not fit');
    if (th && th.runaway) chips.push('thermal runaway');
    else if (th && th.overMax) chips.push(`coil ${fmt(th.Tss, 0)} °C > ${P.Tmax} °C`);
    if (lb.bypass) chips.push(`flux bypass: ${fmt(100 * x.util, 0)} % reaches the gap`);
    card.className = `bal-card ${tone}` + (S.stale ? ' stale' : '');
    card.innerHTML = `<p class="bal-k">Balance</p><p class="bal-h">${head}</p>${bar}<p>${body}</p>
      <div class="chips">${chips.length ? chips.map(c => `<span class="chip">${esc(c)}</span>`).join('') : (lb.kind === 'pending' ? '' : '<span class="chip okc">within power, density and thermal limits</span>')}</div>`;
  }

  /** Steel and total mass of the loaded design (CAD body masses when available, else the revolved section). */
  function steelMassNow() {
    if (!S.G || !S.geo) return null;
    return FS.steelMass(S.G, S.geo.bodies, S.meta.map(m => m.cls));
  }
  function renderMassLine() {
    const el = $('massLine'), sm = steelMassNow(), env = thermalEnvNow();
    if (!sm) { el.textContent = ''; return; }
    el.innerHTML = `Steel ${fmt(sm.kg, 3)} kg${env ? ` · whole brake ≈ ${fmt(env.massKg, 2)} kg` : ''} <span class="note" title="${sm.source === 'cad' ? 'Sum of the CAD masses of the bodies treated as steel' : 'Revolved section of the steel bodies at 7850 kg/m³'}">(${sm.source === 'cad' ? 'CAD' : 'from section'})</span>`;
  }

  // ------------------------------------------------------------------ tables
  function renderTables() { renderBodies(); renderGaps(); renderGauges(); renderProbes(); if (!$('tab-materials').hidden) renderMaterials(); }

  function renderBodies() {
    const an = S.opAn;
    const opt = (v, list) => list.map(([k, l]) => `<option value="${k}"${k === v ? ' selected' : ''}>${l}</option>`).join('');
    const rows = S.meta.map((m, i) => {
      const a = an ? an.bodies[i] : null;
      const steel = m.cls === 'steel';
      const eb = S.el ? S.el.bodies.find(b => b.id === i) : null;
      return `<tr data-i="${i}" class="${i === S.selected ? 'sel' : ''} ${i === S.neck ? 'neck' : ''}">
        <td><span class="sw" style="background:${m.color}"></span>${esc(m.name)}<br><span class="note">${esc(m.component || '')}</span></td>
        <td class="l">${esc(m.material || '—')}</td>
        <td class="l"><select data-k="cls" data-i="${i}">${opt(m.cls, [['steel', 'Magnetic steel'], ['nonmag', 'Non-magnetic'], ['coil', 'Coil'], ['powder', 'Powder'], ['ignore', 'Ignore (air)']])}</select></td>
        <td class="l"><select data-k="role" data-i="${i}">${opt(m.role, [['stator', 'Stator'], ['rotor', 'Rotor']])}</select></td>
        <td class="l">${steel ? `<select class="grade" data-k="grade" data-i="${i}">${S.mat.grades.map(g => `<option value="${esc(g.id)}"${g.id === m.grade ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}</select>` : '<span class="note">–</span>'}</td>
        <td class="${a && steel && S.prob && a.Bp98 > (S.prob.bodyKnee[i] || F.STEEL_KNEE_REF) ? 'hot' : ''}">${a ? fmt(a.Bp98, 2) : '–'}</td>
        <td>${a && steel ? fmt(100 * a.satFrac, 0) : '–'}</td>
        <td>${a ? fmt(a.mmfPct, 1) : '–'}</td>
        <td class="${i === S.neck ? 'hot' : ''}">${eb ? pc(10 * eb.e) + ' %' : '–'}</td></tr>`;
    }).join('');
    $('tab-bodies').innerHTML = `<table><thead><tr><th>Body</th><th class="l">CAD material</th><th class="l">Treat as</th><th class="l">Moves with</th><th class="l">Steel grade</th>
      <th title="98th percentile of |B| over the body volume">B98, T</th><th title="Volume above the knee of the body's grade">Saturated, %</th><th title="Share of coil ampere-turns consumed (energy-weighted)">MMF, %</th><th title="Torque change if this body's steel carried 10 % more flux at every H (about 10 % more cross-section where it saturates)">+10 % steel → T</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function renderGaps() {
    const g = S.prob ? S.prob.gaps : [];
    const st = S.opStats, an = S.opAn, T = S.opT;
    const rows = g.map((x, n) => `<tr>
      <td>${x.id}</td><td class="l">${x.dir === 'r' ? 'Radial (cylinder)' : 'Axial (face)'}</td>
      <td class="l">${esc(S.meta[x.a].name)} / ${esc(S.meta[x.b].name)}</td>
      <td>${fmt(x.thickness, 2)}</td><td>${fmt(x.box.r0, 1)}–${fmt(x.box.r1, 1)}</td><td>${fmt(x.box.z0, 1)}–${fmt(x.box.z1, 1)}</td>
      <td>${fmt(x.areaMM2 / 100, 1)}</td>
      <td><input type="checkbox" data-g="${n}" data-k="powder"${x.powder ? ' checked' : ''}></td>
      <td><input type="checkbox" data-g="${n}" data-k="torque"${x.torque ? ' checked' : ''}></td>
      <td>${st ? fmt(st[n].Bavg, 3) : '–'}</td><td>${st ? fmt(st[n].flux * 1e3, 3) : '–'}</td>
      <td>${T && x.torque ? fmt(T.per[n], 2) : '–'}</td><td>${an ? fmt(an.gaps[n].mmfPct, 1) : '–'}</td></tr>`).join('');
    $('tab-gaps').innerHTML = g.length ? `<table><thead><tr><th>#</th><th class="l">Type</th><th class="l">Between</th><th>Gap, mm</th><th>r, mm</th><th>z, mm</th><th>Area, cm²</th>
      <th title="Gap filled with powder (magnetic). Off = air.">Powder</th><th title="Counts toward torque">Torque</th><th>B avg, T</th><th>Flux, mWb</th><th>T, N·m</th><th>MMF, %</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="note">Gaps are runs of empty space between rotor steel and stator steel up to ${P.gmaxDetect} mm. Gaps above ${P.torqueGapMax} mm start with Torque off.</p>`
      : '<p class="note">No working gaps found. Mark the rotating parts as Rotor in the Bodies tab.</p>';
  }

  function renderGauges() {
    if (!S.prob || !S.prob.coilAreaM2) { $('tab-gauges').innerHTML = '<p class="note">Needs a coil window.</p>'; return; }
    const rows = [];
    let best = null;
    for (const w of F.wireList(P.wire)) {
      const g = w.key, e = elec(g);
      const T = S.sweep ? torqueAt(e.NI) : null;
      rows.push({ g, w, e, T });
      const fits = e.P <= P.Pmax && e.Jw <= P.Jmax;
      if (T != null && fits && (!best || T > best.T)) best = { g, T };
    }
    const rule = P.turnsOverride > 0 ? 'Turns are fixed by the override.'
      : P.winding === 'layer' ? 'Turns = turns per layer × layers (square stacking) in the window less the bobbin.'
      : P.winding === 'ortho' ? 'Turns = orthocyclic (hexagonal) stacking in the window less the bobbin.'
      : `Turns = ${P.pack} × window${P.bobbin ? ' less the bobbin' : ''} / (enamelled diameter)².`;
    $('tab-gauges').innerHTML = `<table><thead><tr><th>Wire</th><th>Bare, mm</th><th>Turns</th><th>Cu fill</th><th>R, Ω</th><th>I, A</th><th>NI, A-t</th><th>P, W</th><th>J, A/mm²</th><th>Torque, N·m</th></tr></thead><tbody>${
      rows.map(o => `<tr class="${o.g === P.swg ? 'cur' : ''} ${best && o.g === best.g ? 'best' : ''}"><td>${o.w.name}</td><td>${fmt(o.e.d, 3)}</td><td>${o.e.N}</td><td>${fmt(100 * o.e.fill, 0)} %</td><td>${fmt(o.e.R, 2)}</td>
        <td>${fmt(o.e.I, 2)}</td><td>${fmt(o.e.NI, 0)}</td><td class="${o.e.P > P.Pmax ? 'hot' : ''}">${fmt(o.e.P, 1)}</td><td class="${o.e.Jw > P.Jmax ? 'hot' : ''}">${fmt(o.e.Jw, 1)}</td><td>${o.T != null ? fmt(o.T, 2) : '–'}</td></tr>`).join('')
    }</tbody></table><p class="note">At ${P.V} V and ${P.Ilim} A supply limit. Green = most torque within ${P.Pmax} W and ${P.Jmax} A/mm²${best ? '' : ' (no gauge meets both limits)'}. ${rule} Wire standard and winding style are in Model settings.</p>`;
  }

  const SETTINGS = [
    ['Coil and supply'],
    ['wire', 'Wire standard', '', 0, 'select', [['SWG', 'SWG (British)'], ['AWG', 'AWG'], ['metric', 'Metric, IEC 60317 (mm)']]],
    ['winding', 'Winding', '', 0, 'select', [['random', 'Random wound (packing factor)'], ['layer', 'Layer wound (square stacking)'], ['ortho', 'Orthocyclic (hexagonal)']]],
    ['bobbin', 'Bobbin wall (inner tube and flanges)', 'mm', 0.1],
    ['Ilim', 'Supply current limit', 'A', 0.1], ['pack', 'Packing factor (random winding)', '', 0.01], ['turnsOverride', 'Turns override (0 = fit)', '', 1],
    ['tempC', 'Coil temperature (fixed)', '°C', 5], ['coilRmin', 'Coil starts at radius', 'mm', 0.5],
    ['Pmax', 'Coil power limit (gauge pick)', 'W', 1], ['Jmax', 'Current density limit (gauge pick)', 'A/mm²', 0.5],
    ['Output'],
    ['rForce', 'Force reported at radius', 'mm', 1], ['ratio', 'Ratio (brake turns per output turn)', '', 0.1],
    ['Powder'],
    ['powderMur', 'Powder relative permeability', '', 0.5], ['powderJs', 'Powder saturation polarisation', 'T', 0.05],
    ['tauSat', 'Shear stress at saturation τsat', 'kPa', 1], ['Bs', 'Shear model knee Bs (τ = τsat·tanh(B/Bs))', 'T', 0.05],
    ['Thermal (lumped model)'],
    ['thermalOp', 'Solve at steady-state coil temperature', '', 1, 'bool'], ['Tamb', 'Ambient temperature', '°C', 1],
    ['hConv', 'Heat-transfer coefficient (≈10 still air, 25–50 fan)', 'W/m²K', 1], ['duty', 'Duty cycle', '%', 5],
    ['RthCoil', 'Coil-to-case thermal resistance', 'K/W', 0.1], ['Tmax', 'Coil temperature limit (insulation class)', '°C', 5],
    ['coolAreaCm2', 'Cooled area (0 = outer envelope)', 'cm²', 10],
    ['Response'],
    ['Voff', 'Turn-off clamp voltage (0.7 = diode)', 'V', 0.5], ['rpm', 'Speed for the stopping time', 'rpm', 50],
    ['Mesh'],
    ['hmax', 'Mesh size', 'mm', 0.05],
    ['gmaxDetect', 'Detect gaps up to', 'mm', 0.1], ['torqueGapMax', 'Count torque for gaps up to', 'mm', 0.1]
  ];

  function renderSettings() {
    const html = SETTINGS.map(s => s.length === 1 ? `<h3>${s[0]}</h3>` : s[4] === 'bool'
      ? `<label>${s[1]} <input type="checkbox" data-p="${s[0]}" data-bool="1"${P[s[0]] ? ' checked' : ''}></label>`
      : s[4] === 'select'
      ? `<label>${s[1]} <select data-p="${s[0]}" data-str="1">${s[5].map(([v, t]) => `<option value="${v}"${P[s[0]] === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label>`
      : `<label>${s[1]} <span><input type="number" data-p="${s[0]}" value="${P[s[0]]}" step="${s[3]}"> ${s[2]}</span></label>`).join('');
    $('tab-settings').innerHTML = `<div class="settings">${html}
      <h3>Calibrate the shear model from measurements</h3>
      <label class="stack">One measurement per line: coil current (A), force at the force radius (kgf)
        <textarea id="calText" rows="4" placeholder="0.3, 4.2&#10;0.6, 9.8&#10;1.0, 14.5">${esc(S.calText)}</textarea></label>
      <div class="row"><button id="btnCal">Fit</button><button id="btnCalApply" hidden>Use these values</button></div>
      <div class="note" id="calOut">One current level fits τsat. Two or more levels also fit Bs, the bend of the torque curve.</div></div>`;
    $('btnCal').onclick = calibrate;
    $('btnCalApply').onclick = applyCal;
  }

  // ------------------------------------------------------------------ events
  document.addEventListener('change', ev => {
    const t = ev.target;
    if (t.dataset.p && t.dataset.str) {
      const k = t.dataset.p;
      if (k === 'wire' && t.value !== P.wire) P.swg = F.nearestWire(t.value, F.wireDia(P.wire, P.swg));
      P[k] = t.value;
      syncSliders();
      invalidate(STAGE_OF[k] || 'elec');
      return;
    }
    if (t.dataset.p) {
      const k = t.dataset.p, v = t.dataset.bool ? (t.checked ? 1 : 0) : parseFloat(t.value);
      if (!isFinite(v)) return;
      P[k] = v;
      invalidate(STAGE_OF[k] || 'elec');
      return;
    }
    if (t.dataset.k === 'cls' || t.dataset.k === 'role') {
      S.meta[+t.dataset.i][t.dataset.k] = t.value;
      invalidate('detect');
      return;
    }
    if (t.dataset.k === 'grade') {
      S.meta[+t.dataset.i].grade = t.value;
      invalidate('problem');
      return;
    }
    if (t.dataset.gs) {
      const v = parseFloat(t.value);
      if (!(v > 0)) return;
      P.gradeScale[t.dataset.gs] = v;
      refreshMat();
      renderMaterials();
      if (S.meta.some(m => m.cls === 'steel' && m.grade === t.dataset.gs)) invalidate('problem');
      return;
    }
    if (t.dataset.g != null) {
      const g = S.prob.gaps[+t.dataset.g];
      g[t.dataset.k] = t.checked;
      invalidate(t.dataset.k === 'powder' ? 'problem' : 'torque');
    }
  });

  function syncSliders() {
    const wl = F.wireList(P.wire);
    let i = wl.findIndex(o => o.key === P.swg);
    if (i < 0) { P.swg = F.nearestWire(P.wire, 0.4); i = wl.findIndex(o => o.key === P.swg); }
    $('sV').value = P.V;
    $('sG').min = 0; $('sG').max = wl.length - 1; $('sG').value = i;
    $('oV').innerHTML = `${P.V} <small>V</small>`;
    $('oG').innerHTML = P.wire === 'metric' ? `${wl[i].name}` : `${wl[i].name} <small>${wl[i].d} mm</small>`;
  }
  $('sV').addEventListener('input', e => { P.V = parseFloat(e.target.value); syncSliders(); invalidate('elec'); });
  $('sG').addEventListener('input', e => { P.swg = F.wireList(P.wire)[parseInt(e.target.value, 10)].key; syncSliders(); invalidate('elec'); });

  document.querySelectorAll('[role=tab]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('[role=tab]').forEach(x => x.setAttribute('aria-selected', x === b));
    document.querySelectorAll('.tabpanel').forEach(p => { p.hidden = p.id !== 'tab-' + b.dataset.tab; });
    if (b.dataset.tab === 'materials') renderMaterials();
    if (b.dataset.tab === 'probes') renderProbes();
    if (b.dataset.tab === 'sections') renderSections();
    if (b.dataset.tab === 'compare') renderCompare();
    if (b.dataset.tab === 'map') {
      if (!ST.params.length && (inFusion() || (S.geo && S.geo.source === window.FERRA_DEMO.source))) loadParams();
      else if (!$('tab-map').firstChild || !$('mpChart')) renderMap();
      else drawMap();
    }
    if (b.dataset.tab === 'study') {
      if (!ST.params.length && (inFusion() || (S.geo && S.geo.source === window.FERRA_DEMO.source))) loadParams();
      else if (!ST.params.length) renderStudy();
      else drawStudyChart();
    }
  }));

  $('tab-bodies').addEventListener('click', ev => {
    const tr = ev.target.closest('tr[data-i]');
    if (!tr || ev.target.tagName === 'SELECT') return;
    selectBody(+tr.dataset.i);
  });

  function selectBody(i) {
    S.selected = i;
    renderBodies(); draw();
    if (inFusion() && i >= 0) fusion('select', { id: S.meta[i].id }).catch(() => {});
  }

  $('btnExtract').onclick = async () => {
    if (!inFusion()) { status('Open this panel from Fusion to read the design', 'err'); return; }
    status('Reading design', 'busy');
    try {
      const raw = await fusion('extract', { axis: $('axis').value, angle: parseFloat($('angle').value) || 0 });
      const res = JSON.parse(raw);
      if (!res.ok) { status(res.error || 'Extraction failed', 'err'); return; }
      loadGeometry(res, { carry: !!(S.geo && S.geo.source === res.source) });
      ST.preview = null;
    } catch (e) { status(String(e.message || e), 'err'); }
  };
  $('btnDemo').onclick = () => {
    ST.mock = {}; ST.params = []; ST.msg = ''; ST.spec = null; ST.pts = []; ST.preview = null;
    if (!MP.running) { MP.spec = null; MP.pts = []; }
    loadGeometry(JSON.parse(JSON.stringify(window.FERRA_DEMO)));
    if (!$('tab-study').hidden || !$('tab-map').hidden) loadParams();
  };
  $('btnOpen').onclick = async () => {
    if (inFusion()) {
      try { const raw = await fusion('openJSON', {}); if (raw) loadGeometry(JSON.parse(raw)); }
      catch (e) { status('Could not open: ' + e.message, 'err'); }
    } else $('fileIn').click();
  };
  $('fileIn').onchange = ev => {
    const f = ev.target.files[0]; if (!f) return;
    f.text().then(t => loadGeometry(JSON.parse(t))).catch(e => status('Could not open: ' + e.message, 'err'));
  };
  $('btnSave').onclick = async () => {
    if (!S.geo) return;
    const out = Object.assign({}, S.geo, { classification: S.meta.map(m => ({ cls: m.cls, role: m.role, grade: m.grade })),
      params: P, coilPicks: S.coilPicks, probes: S.probes, materials: { custom: S.customGrades },
      calibration: S.calText, snapshots: S.snaps.map(x => Object.assign({}, x, { geo: undefined })),
      gaps: S.prob ? S.prob.gaps.map(g => ({ id: g.id, dir: g.dir, thickness: g.thickness, powder: g.powder, torque: g.torque })) : [],
      result: S.opT ? { NI: S.op.NI, torqueNm: S.opT.total } : null });
    const content = JSON.stringify(out);
    const name = (S.geo.source || 'brake').replace(/[^\w.-]+/g, '_') + '_analysis.json';
    if (inFusion()) {
      const r = JSON.parse(await fusion('saveJSON', { filename: name, content }));
      status(r.ok ? 'Saved ' + r.path : 'Save cancelled');
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([content], { type: 'application/json' })); a.download = name; a.click();
    }
  };
  $('btnPickCoil').onclick = () => { S.pickMode = !S.pickMode; $('btnPickCoil').classList.toggle('on', S.pickMode);
    status(S.pickMode ? 'Click inside the empty coil window' : 'Ready'); };
  $('btnClearCoil').onclick = () => { S.coilPicks = []; S.coilPickBox = null; if (S.G) rebuildProblem(false); };
  $('mode').onchange = draw; $('showFlux').onchange = draw;
  $('btnFit').onclick = () => { S.view = null; draw(); };

  // ------------------------------------------------------------------ drawing
  const cv = $('view'), ctx = cv.getContext('2d');
  const MAGMA = [[0, [11, 13, 31]], [0.2, [59, 28, 110]], [0.4, [140, 41, 129]], [0.6, [222, 73, 104]], [0.78, [251, 135, 97]], [0.9, [253, 198, 132]], [1, [252, 253, 191]]];
  const SAT = [[0, [46, 74, 98]], [0.6, [64, 140, 120]], [0.85, [226, 190, 80]], [1, [230, 110, 50]], [1.25, [215, 38, 61]]];
  function ramp(stops, x) {
    if (x <= stops[0][0]) return stops[0][1];
    for (let k = 1; k < stops.length; k++) if (x <= stops[k][0]) {
      const t = (x - stops[k - 1][0]) / (stops[k][0] - stops[k - 1][0]), a = stops[k - 1][1], b = stops[k][1];
      return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
    }
    return stops[stops.length - 1][1];
  }
  const rgb = c => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
  const BMAX = 2.2;

  function fitView() {
    const G = S.G, b = G.bounds;
    const W = cv.clientWidth, H = cv.clientHeight;
    const zr = b.zmax - b.zmin, rr = b.rmax;
    const sc = Math.min((W - 60) / zr, (H - 50) / rr);
    S.view = { sc, ox: (W - zr * sc) / 2 - b.zmin * sc, oy: H - 25 - (H - 50 - rr * sc) / 2 };
  }
  const X = z => S.view.ox + z * S.view.sc; // z horizontal
  const Y = r => S.view.oy - r * S.view.sc; // r vertical, axis at bottom
  const toWorld = (px, py) => ({ z: (px - S.view.ox) / S.view.sc, r: (S.view.oy - py) / S.view.sc });

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#12161b'; ctx.fillRect(0, 0, W, H);
    if (!S.G) return;
    if (!S.view) fitView();
    const G = S.G, mode = $('mode').value, sol = S.op, prob = S.prob;
    const { nr, nz, rs, zs, cellBody } = G;
    for (let j = 0; j < nz; j++) {
      const x0 = X(zs[j]), x1 = X(zs[j + 1]);
      if (x1 < 0 || x0 > W) continue;
      for (let i = 0; i < nr; i++) {
        const y0 = Y(rs[i + 1]), y1 = Y(rs[i]);
        if (y1 < 0 || y0 > H) continue;
        const c = i + j * nr, b = cellBody[c];
        let col = null;
        const isCoil = prob && prob.coilMask[c];
        if (mode === 'mat' || !sol) {
          if (isCoil) col = '#9a5a2c';
          else if (prob && prob.gapCell[c] && prob.cellMat[c] === F.M_POWDER) col = '#6d6a5e';
          else if (b >= 0) col = S.meta[b].cls === 'ignore' ? '#2a3038' : S.meta[b].color;
          else continue;
        } else if (mode === 'B') {
          col = rgb(ramp(MAGMA, Math.min(1, sol.Bm[c] / BMAX)));
        } else {
          const steel = b >= 0 && S.meta[b].cls === 'steel';
          if (steel) col = rgb(ramp(SAT, sol.Bm[c] / (prob.bodyKnee[b] || F.STEEL_KNEE_REF)));
          else if (prob.cellMat[c] === F.M_POWDER) col = rgb(ramp(MAGMA, Math.min(1, sol.Bm[c] / BMAX)));
          else if (isCoil) col = '#4a3020';
          else if (b >= 0) col = '#2a3038';
          else continue;
        }
        ctx.fillStyle = col;
        ctx.fillRect(x0, y0, x1 - x0 + 0.6, y1 - y0 + 0.6);
      }
    }
    if (sol && $('showFlux').checked) drawFluxLines(sol);
    // torque gaps
    if (prob) {
      ctx.lineWidth = 1.5;
      prob.gaps.forEach(g => {
        if (!g.torque) return;
        ctx.strokeStyle = '#e7a46b'; ctx.setLineDash([3, 2]);
        ctx.strokeRect(X(g.box.z0), Y(g.box.r1), (g.box.z1 - g.box.z0) * S.view.sc, (g.box.r1 - g.box.r0) * S.view.sc);
      });
      ctx.setLineDash([]);
    }
    // outlines
    S.geo.bodies.forEach((body, bi) => {
      const sel = bi === S.selected, neck = bi === S.neck;
      ctx.strokeStyle = sel ? '#ffffff' : neck ? '#ff6b5a' : 'rgba(233,238,243,0.75)';
      ctx.lineWidth = sel || neck ? 2.2 : 1;
      ctx.beginPath();
      for (const pl of body.polys) {
        for (let k = 0; k + 3 < pl.length; k += 2) {
          if (pl[k] < -1e-3 || pl[k + 2] < -1e-3) continue; // draw only the r >= 0 half
          ctx.moveTo(X(pl[k + 1]), Y(pl[k])); ctx.lineTo(X(pl[k + 3]), Y(pl[k + 2]));
        }
      }
      ctx.stroke();
    });
    if (S.probes.length || S.probeA) drawProbes(X, Y);
    // saturation hot-spot marker on the bottleneck
    if (S.opAn && S.neck >= 0) {
      const h = S.opAn.bodies[S.neck].hot;
      if (h) { ctx.strokeStyle = '#ff6b5a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X(h[1]), Y(h[0]), 9, 0, 2 * Math.PI); ctx.stroke(); }
    }
    // axis
    ctx.strokeStyle = '#8ea3b6'; ctx.setLineDash([14, 3, 2, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, Y(0)); ctx.lineTo(W, Y(0)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#8ea3b6'; ctx.font = '11px sans-serif';
    ctx.fillText('axis', 6, Y(0) - 4);
    drawLegend(mode, !!sol);
  }

  function drawLegend(mode, hasSol) {
    const el = $('legend');
    if (!hasSol || mode === 'mat') { el.innerHTML = mode === 'mat' ? 'Materials' : ''; return; }
    const c = document.createElement('canvas'); c.width = 140; c.height = 10;
    const g = c.getContext('2d');
    for (let x = 0; x < 140; x++) { g.fillStyle = rgb(mode === 'B' ? ramp(MAGMA, x / 139) : ramp(SAT, 1.25 * x / 139)); g.fillRect(x, 0, 1, 10); }
    el.innerHTML = mode === 'B' ? `|B| 0 – ${BMAX} T` : 'steel B ÷ knee of its grade: 0 – 1.25';
    el.appendChild(c);
  }

  // marching squares on psi nodes
  function drawFluxLines(sol) {
    const G = S.G, NR = G.nr + 1, NZ = G.nz + 1, psi = sol.psi;
    let mx = 0; for (let k = 0; k < psi.length; k++) mx = Math.max(mx, Math.abs(psi[k]));
    if (!mx) return;
    const levels = 18;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 0.9;
    ctx.beginPath();
    for (let L = 1; L <= levels; L++) {
      const v = mx * (L - 0.5) / levels;
      for (let j = 0; j < NZ - 1; j++) for (let i = 0; i < NR - 1; i++) {
        const k = j * NR + i;
        const a = psi[k] - v, b = psi[k + 1] - v, c = psi[k + NR + 1] - v, d = psi[k + NR] - v;
        const pts = [];
        const edge = (p, q, r0, z0, r1, z1) => { if ((p > 0) !== (q > 0)) { const t = p / (p - q); pts.push([r0 + t * (r1 - r0), z0 + t * (z1 - z0)]); } };
        edge(a, b, G.rs[i], G.zs[j], G.rs[i + 1], G.zs[j]);
        edge(b, c, G.rs[i + 1], G.zs[j], G.rs[i + 1], G.zs[j + 1]);
        edge(c, d, G.rs[i + 1], G.zs[j + 1], G.rs[i], G.zs[j + 1]);
        edge(d, a, G.rs[i], G.zs[j + 1], G.rs[i], G.zs[j]);
        for (let p = 0; p + 1 < pts.length; p += 2) {
          ctx.moveTo(X(pts[p][1]), Y(pts[p][0])); ctx.lineTo(X(pts[p + 1][1]), Y(pts[p + 1][0]));
        }
      }
    }
    ctx.stroke();
  }

  // hover / pan / zoom / pick
  let drag = null;
  cv.addEventListener('mousedown', e => { drag = { x: e.offsetX, y: e.offsetY, moved: false }; });
  window.addEventListener('mouseup', e => {
    if (drag && !drag.moved && S.G && S.view) onClick(drag.x, drag.y);
    drag = null;
  });
  cv.addEventListener('mousemove', e => {
    if (drag) {
      const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.moved && S.view) { S.view.ox += dx; S.view.oy += dy; drag.x = e.offsetX; drag.y = e.offsetY; draw(); }
      return;
    }
    hover(e.offsetX, e.offsetY);
  });
  cv.addEventListener('mouseleave', () => { $('tip').style.display = 'none'; });
  cv.addEventListener('wheel', e => {
    if (!S.view) return;
    e.preventDefault();
    const f = Math.exp(-e.deltaY * 0.0015), w = toWorld(e.offsetX, e.offsetY);
    S.view.sc *= f; S.view.ox = e.offsetX - w.z * S.view.sc; S.view.oy = e.offsetY + w.r * S.view.sc;
    draw();
  }, { passive: false });
  window.addEventListener('resize', () => { draw(); drawStudyChart(); drawLineChart(); if (!$('tab-materials').hidden) drawBH(gradesInUse()); });

  function cellAt(px, py) {
    const w = toWorld(px, py), i = locate(S.G.rs, w.r), j = locate(S.G.zs, w.z);
    return { w, i, j, c: i >= 0 && j >= 0 ? j * S.G.nr + i : -1 };
  }

  function hover(px, py) {
    const tip = $('tip');
    if (!S.G || !S.view) { tip.style.display = 'none'; return; }
    const { w, c } = cellAt(px, py);
    if (c < 0) { tip.style.display = 'none'; return; }
    const b = S.G.cellBody[c];
    let txt = `r ${fmt(w.r, 2)} mm  z ${fmt(w.z, 2)} mm\n${b >= 0 ? S.meta[b].name : (S.prob && S.prob.coilMask[c] ? 'Coil window' : 'Air')}`;
    if (b >= 0 && S.meta[b].cls === 'steel') txt += `  ·  ${gradeName(S.meta[b].grade).split(' (')[0]}`;
    if (S.prob && S.prob.gapCell[c]) txt += `  (gap ${S.prob.gaps[S.prob.gapCell[c] - 1].id})`;
    if (S.op) {
      const B = S.op.Bm[c], H = B > 0 ? S.op.HB[c] / B : 0;
      txt += `\n|B| ${fmt(B, 3)} T   Br ${fmt(S.op.Br[c], 3)}  Bz ${fmt(S.op.Bz[c], 3)}`;
      if (H > 0) txt += `\nH ${fmt(H / 1000, 2)} kA/m   μr ${fmt(B / (H * F.MU0), 0)}`;
    }
    tip.textContent = txt;
    tip.style.display = 'block';
    tip.style.left = Math.min(px + 14, cv.clientWidth - 230) + 'px';
    tip.style.top = Math.min(py + 14, cv.clientHeight - 70) + 'px';
  }

  function onClick(px, py) {
    const { w, i, j, c } = cellAt(px, py);
    if (c < 0) return;
    if (probeClick(w)) return;
    if (ST.pickProbe) {
      ST.pickProbe = false;
      if ($('stR')) { $('stR').value = +w.r.toFixed(2); $('stZ').value = +w.z.toFixed(2); $('stPick').classList.remove('on'); }
      status(`Probe point r ${fmt(w.r, 2)} mm, z ${fmt(w.z, 2)} mm`);
      return;
    }
    if (S.pickMode) {
      const m = F.floodEmpty(S.G, i, j);
      if (!m) { status('That space is open to the outside or is not empty. Click inside the closed winding space.', 'err'); return; }
      S.coilPicks.push([w.r, w.z]);
      S.pickMode = false; $('btnPickCoil').classList.remove('on');
      rebuildProblem(false);
      return;
    }
    selectBody(S.G.cellBody[c]);
  }

  // ------------------------------------------------------------------ T(NI) curve
  function drawCurve(NIop, Top) {
    const c = $('curve'), g = c.getContext('2d'), dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    c.width = W * dpr; c.height = H * dpr; g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!S.sweep) return;
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue('--muted').trim(), cop = css.getPropertyValue('--copper').trim(), line = css.getPropertyValue('--line').trim();
    const pts = S.sweep.pts.map(p => [p.NI, F.torqueFromStats(S.prob, p.stats, tp()).total]);
    pts.unshift([0, 0]);
    const xm = pts[pts.length - 1][0], ym = Math.max(...pts.map(p => p[1])) * 1.1 || 1;
    const L = 38, B = 22, R = 24, T = 8;
    const sx = x => L + x / xm * (W - L - R), sy = y => H - B - y / ym * (H - B - T);
    g.strokeStyle = line; g.lineWidth = 1; g.fillStyle = ink; g.font = '10.5px sans-serif';
    for (let k = 0; k <= 4; k++) {
      const y = ym * k / 4; g.beginPath(); g.moveTo(L, sy(y)); g.lineTo(W - R, sy(y)); g.stroke();
      g.fillText(y.toFixed(y < 10 ? 1 : 0), 4, sy(y) + 3);
      const x = xm * k / 4; g.fillText(x.toFixed(0), sx(x) - 10, H - 6);
    }
    const knee = FI.kneeNI(pts);
    if (knee && knee < xm) {
      g.strokeStyle = ink; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(sx(knee), T); g.lineTo(sx(knee), H - B); g.stroke(); g.setLineDash([]);
      g.fillStyle = ink; g.fillText(`knee ${knee.toFixed(0)} A-t`, Math.min(sx(knee) + 4, W - 80), T + 10);
    }
    g.strokeStyle = cop; g.lineWidth = 2; g.beginPath();
    pts.forEach((p, k) => (k ? g.lineTo(sx(p[0]), sy(p[1])) : g.moveTo(sx(p[0]), sy(p[1]))));
    g.stroke();
    if (NIop > 0) {
      g.fillStyle = cop; g.beginPath(); g.arc(sx(Math.min(NIop, xm)), sy(Top), 4.5, 0, 2 * Math.PI); g.fill();
      g.fillStyle = ink; g.fillText(`${NIop.toFixed(0)} A-t`, Math.min(sx(NIop) + 7, W - 60), sy(Top) + 14);
    }
  }

  // ------------------------------------------------------------------ materials (steel grades)
  function refreshMat() { S.mat = FM.makeDefs(P.gradeScale, S.customGrades); }
  const gradeName = id => { const g = S.mat.grades.find(x => x.id === id); return g ? g.name : String(id); };
  const GRADE_COLORS = ['#d08a52', '#7aa6c2', '#8fc27a', '#c27a9e', '#e0c060', '#7ac2b6', '#a07ac2', '#ef6b57', '#9aa6b2', '#b6c27a', '#ffffff', '#5fb884'];

  function bAt(t, h) {
    if (h <= t.H[0]) return 0;
    for (let i = 1; i < t.n; i++) if (t.H[i] >= h) return t.B[i - 1] + (t.B[i] - t.B[i - 1]) * (h - t.H[i - 1]) / (t.H[i] - t.H[i - 1]);
    return t.B[t.n - 1] + F.MU0 * (h - t.H[t.n - 1]);
  }

  function gradesInUse() {
    const used = {};
    S.meta.forEach(m => { if (m.cls === 'steel') (used[m.grade] = used[m.grade] || []).push(m.name); });
    return used;
  }

  function renderMaterials() {
    const el = $('tab-materials');
    const used = gradesInUse();
    const rows = S.mat.grades.map((g, i) => {
      const t = F.steelTable(S.mat.defs[i]), u = used[g.id];
      return `<tr class="${u ? '' : 'unused'}"><td class="l"><span class="sw" style="background:${GRADE_COLORS[i % GRADE_COLORS.length]}"></span>${esc(g.name)}${g.custom ? ' <span class="note">custom</span>' : ''}</td>
        <td>${fmt(F.kneeOf(t), 2)}</td><td>${fmt(bAt(t, 1000), 2)}</td><td>${fmt(bAt(t, 5000), 2)}</td><td>${fmt(bAt(t, 40000), 2)}</td>
        <td><input type="number" data-gs="${esc(g.id)}" value="${P.gradeScale[g.id] || 1}" step="0.01" min="0.3" max="1.5"></td>
        <td class="l">${u ? esc(u.join(', ')) : '<span class="note">–</span>'}</td>
        <td>${g.custom ? `<button data-act="delGrade" data-id="${esc(g.id)}">Remove</button>` : ''}</td></tr>`;
    }).join('');
    el.innerHTML = `<div class="mat">
      <div><table><thead><tr><th class="l">Steel grade</th><th title="B where the differential relative permeability falls below 50">Knee, T</th>
        <th>B at 1 kA/m, T</th><th>B at 5 kA/m, T</th><th>B at 40 kA/m, T</th><th title="Multiplies the polarisation (B − μ0H) at every H. 1 = library curve.">Scale</th><th class="l">Used by</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table>
        <p class="note">Library curves are typical values for annealed material, derived from the measured 1010 curve. Machined, cold-worked or welded parts are usually worse. Adjust a grade with Scale or add a supplier curve. Set each steel body's grade in the Bodies tab.</p></div>
      <div class="mat-side"><canvas id="bhChart"></canvas><div class="mat-import">
        <h3>Add a custom B-H curve</h3>
        <label class="stack">Name <input type="text" id="cuName" placeholder="e.g. Supplier 1018, annealed"></label>
        <textarea id="cuData" rows="6" placeholder="H (A/m), B (T), one pair per line&#10;0, 0&#10;200, 0.6&#10;800, 1.2&#10;…"></textarea>
        <div class="row"><button data-act="addGrade">Add curve</button><span class="note" id="cuMsg"></span></div></div></div></div>`;
    drawBH(used);
  }

  function drawBH(used) {
    const c = $('bhChart');
    if (!c) return;
    const g = c.getContext('2d'), dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    c.width = W * dpr; c.height = H * dpr; g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const col = chartColors();
    const L = 34, R = 8, T = 16, B = 26, h0 = 1, h1 = 5, bMax = 2.5;
    const sx = h => L + (Math.log10(h) - h0) / (h1 - h0) * (W - L - R), sy = b => H - B - b / bMax * (H - B - T);
    g.strokeStyle = col.line; g.fillStyle = col.ink; g.lineWidth = 1; g.font = '10.5px sans-serif';
    for (let e = h0; e <= h1; e++) { g.beginPath(); g.moveTo(sx(10 ** e), T); g.lineTo(sx(10 ** e), H - B); g.stroke(); g.fillText(e === 3 ? '1k' : e === 4 ? '10k' : e === 5 ? '100k' : String(10 ** e), sx(10 ** e) - 8, H - B + 12); }
    for (let b = 0; b <= bMax + 1e-9; b += 0.5) { g.beginPath(); g.moveTo(L, sy(b)); g.lineTo(W - R, sy(b)); g.stroke(); g.fillText(b.toFixed(1), 4, sy(b) + 3); }
    g.fillText('B, T', L, 10); g.fillText('H, A/m', W - R - 40, H - 3);
    const show = S.mat.grades.map((gr, i) => ({ gr, i })).filter(o => used[o.gr.id] || o.gr.custom);
    if (!show.length) show.push({ gr: S.mat.grades[0], i: 0 });
    show.forEach(({ gr, i }, n) => {
      const t = F.steelTable(S.mat.defs[i]);
      g.strokeStyle = GRADE_COLORS[i % GRADE_COLORS.length]; g.lineWidth = 2; g.beginPath();
      for (let k = 0; k <= 120; k++) { const h = 10 ** (h0 + (h1 - h0) * k / 120), x = sx(h), y = sy(Math.min(bMax, bAt(t, h))); k ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.stroke();
      g.fillStyle = GRADE_COLORS[i % GRADE_COLORS.length];
      g.fillText(gr.name.split(' (')[0].slice(0, 28), L + 6, T + 12 + 12 * n);
    });
  }

  $('tab-materials').addEventListener('click', ev => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'addGrade') {
      const name = $('cuName').value.trim();
      if (!name) { $('cuMsg').textContent = 'Give the curve a name.'; return; }
      const r = FM.parseBH($('cuData').value);
      if (r.error) { $('cuMsg').textContent = r.error; return; }
      const id = 'custom:' + name;
      S.customGrades = S.customGrades.filter(c => c.id !== id).concat([{ id, name, H: r.H, B: r.B }]);
      refreshMat();
      renderMaterials(); renderBodies();
      $('cuMsg').textContent = `Added “${name}” (${r.H.length} points). Pick it for a body in the Bodies tab.`;
      if (S.meta.some(m => m.grade === id)) invalidate('problem');
    } else if (b.dataset.act === 'delGrade') {
      const id = b.dataset.id;
      S.customGrades = S.customGrades.filter(c => c.id !== id);
      let hit = false;
      S.meta.forEach(m => { if (m.grade === id) { m.grade = FM.defaultGrade(m.material); hit = true; } });
      refreshMat();
      renderMaterials();
      if (hit) invalidate('problem'); else renderBodies();
    }
  });

  // ------------------------------------------------------------------ probes
  // S.probes: [{type: 'pt', r, z} | {type: 'line', a: [r, z], b: [r, z]}] in mm. Names P1.. / L1.. by type order.
  function probeName(i) {
    const p = S.probes[i];
    let n = 0;
    for (let k = 0; k <= i; k++) if (S.probes[k].type === p.type) n++;
    return (p.type === 'pt' ? 'P' : 'L') + n;
  }

  function setProbeMode(m) {
    S.probeMode = S.probeMode === m ? null : m;
    S.probeA = null;
    document.querySelectorAll('#tab-probes [data-act=addPt], #tab-probes [data-act=addLine]').forEach(b =>
      b.classList.toggle('on', (b.dataset.act === 'addPt' && S.probeMode === 'pt') || (b.dataset.act === 'addLine' && S.probeMode === 'line')));
    status(S.probeMode === 'pt' ? 'Click the probe point on the section' : S.probeMode === 'line' ? 'Click the start of the probe line' : 'Ready');
  }

  /** Canvas click while placing probes. Returns true when the click was used. */
  function probeClick(w) {
    if (!S.probeMode) return false;
    const pt = [+w.r.toFixed(2), +w.z.toFixed(2)];
    if (S.probeMode === 'pt') { S.probes.push({ type: 'pt', r: pt[0], z: pt[1] }); setProbeMode(null); }
    else if (!S.probeA) { S.probeA = pt; status('Click the end of the probe line'); }
    else { S.probes.push({ type: 'line', a: S.probeA, b: pt }); S.probeSel = S.probes.length - 1; setProbeMode(null); }
    renderProbes(); draw();
    if (ST.params.length) renderStudy();
    return true;
  }

  function renderProbes() {
    const el = $('tab-probes');
    if (!el) return;
    const sol = S.op, G = S.G;
    const pts = [], lines = [];
    S.probes.forEach((p, i) => {
      const del = `<button data-act="delProbe" data-i="${i}" title="Remove">×</button>`;
      if (p.type === 'pt') {
        const q = sol && G ? FI.probePoint(G, sol, p.r, p.z) : null;
        const where = q && q.body >= 0 ? esc(S.meta[q.body].name) : q ? (S.prob && S.prob.coilMask[q.c] ? 'coil window' : S.prob && S.prob.gapCell[q.c] ? 'gap' : 'air') : '–';
        pts.push(`<tr><td>${probeName(i)}</td><td>${fmt(p.r, 2)}</td><td>${fmt(p.z, 2)}</td><td class="l">${where}</td>
          <td>${q ? fmt(q.B, 3) : '–'}</td><td>${q ? fmt(q.Br, 3) : '–'}</td><td>${q ? fmt(q.Bz, 3) : '–'}</td><td>${q ? fmt(q.H / 1000, 2) : '–'}</td>
          <td>${q && q.mur ? fmt(q.mur, 0) : '–'}</td><td>${del}</td></tr>`);
      } else {
        const q = sol && G ? FI.probeLine(G, sol, p.a, p.b) : null;
        lines.push(`<tr data-pl="${i}" class="${S.probeSel === i ? 'sel' : ''}" title="Click to plot B along this line"><td>${probeName(i)}</td>
          <td>${fmt(p.a[0], 1)}, ${fmt(p.a[1], 1)}</td><td>${fmt(p.b[0], 1)}, ${fmt(p.b[1], 1)}</td><td>${q ? fmt(q.length, 2) : '–'}</td>
          <td>${q ? fmt(q.Bmean, 3) : '–'}</td><td>${q ? fmt(q.Bmax, 3) : '–'}</td><td>${q && q.flux != null ? fmt(q.flux * 1e3, 4) : '–'}</td><td>${del}</td></tr>`);
      }
    });
    el.innerHTML = `<div class="row probes-bar"><button data-act="addPt" class="${S.probeMode === 'pt' ? 'on' : ''}">Add point</button>
        <button data-act="addLine" class="${S.probeMode === 'line' ? 'on' : ''}">Add line</button>
        <button data-act="clearProbes"${S.probes.length ? '' : ' disabled'}>Clear all</button>
        <span class="note">Click on the section to place a point; for a line click its start, then its end. Flux = total flux crossing the surface the line sweeps around the axis.</span></div>
      ${pts.length ? `<table><thead><tr><th>Point</th><th>r, mm</th><th>z, mm</th><th class="l">In</th><th>|B|, T</th><th>Br, T</th><th>Bz, T</th><th>H, kA/m</th><th>μr</th><th></th></tr></thead><tbody>${pts.join('')}</tbody></table>` : ''}
      ${lines.length ? `<table><thead><tr><th>Line</th><th>Start r, z</th><th>End r, z</th><th>Length, mm</th><th>Mean |B|, T</th><th>Max |B|, T</th><th>Flux, mWb</th><th></th></tr></thead><tbody>${lines.join('')}</tbody></table>
        <canvas id="lineChart"></canvas>` : ''}
      ${S.probes.length ? '' : '<p class="note">No probes yet.</p>'}${S.probes.length && !sol ? '<p class="note">Values appear after the operating point is solved.</p>' : ''}`;
    drawLineChart();
  }

  function drawLineChart() {
    const c = $('lineChart');
    if (!c) return;
    const g = c.getContext('2d'), dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    c.width = W * dpr; c.height = H * dpr; g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const col = chartColors();
    g.font = '10.5px sans-serif'; g.fillStyle = col.ink;
    let i = S.probeSel;
    if (!(i >= 0 && S.probes[i] && S.probes[i].type === 'line')) i = S.probes.findIndex(p => p.type === 'line');
    if (i < 0 || !S.op) { g.fillText('B along the selected line appears here after the solve.', 8, 16); return; }
    const p = S.probes[i], q = FI.probeLine(S.G, S.op, p.a, p.b, 200);
    const ok = q.samples.filter(s => s.B != null);
    let y0 = 0, y1 = 0;
    ok.forEach(s => { y0 = Math.min(y0, s.Bn, s.Bt); y1 = Math.max(y1, s.B); });
    if (y1 - y0 < 1e-6) y1 = y0 + 1;
    const L = 40, R = 10, T = 18, B = 26;
    const sx = s => L + s / q.length * (W - L - R), sy = y => H - B - (y - y0) / (y1 - y0) * (H - B - T);
    g.strokeStyle = col.line; g.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const y = y0 + (y1 - y0) * k / 4, s = q.length * k / 4;
      g.beginPath(); g.moveTo(L, sy(y)); g.lineTo(W - R, sy(y)); g.stroke();
      g.fillText(y.toFixed(2), 4, sy(y) + 3); g.fillText(s.toFixed(1), sx(s) - 8, H - B + 12);
    }
    g.fillText(`${probeName(i)}: B along the line, T`, L, 11);
    g.fillText('distance from start, mm', W - R - 120, H - 3);
    const series = [['B', col.cop, '|B|', []], ['Bn', col.ink, 'across', [4, 3]], ['Bt', '#7aa6c2', 'along', [2, 2]]];
    series.forEach(([k, color, label, dash], n) => {
      g.strokeStyle = color; g.lineWidth = k === 'B' ? 2 : 1.4; g.setLineDash(dash); g.beginPath();
      let on = false;
      q.samples.forEach(s => { if (s[k] == null) { on = false; return; } const x = sx(s.s), y = sy(s[k]); on ? g.lineTo(x, y) : g.moveTo(x, y); on = true; });
      g.stroke(); g.setLineDash([]);
      g.fillStyle = color; g.fillText(label, W - R - 150 + 50 * n, 11);
    });
  }

  $('tab-probes').addEventListener('click', ev => {
    const b = ev.target.closest('[data-act]');
    if (b) {
      const a = b.dataset.act;
      if (a === 'addPt') setProbeMode('pt');
      else if (a === 'addLine') setProbeMode('line');
      else if (a === 'clearProbes') { S.probes = []; S.probeSel = -1; }
      else if (a === 'delProbe') { S.probes.splice(+b.dataset.i, 1); S.probeSel = -1; }
      renderProbes(); draw();
      if (ST.params.length && (a === 'clearProbes' || a === 'delProbe')) renderStudy();
      return;
    }
    const tr = ev.target.closest('tr[data-pl]');
    if (tr) { S.probeSel = +tr.dataset.pl; renderProbes(); }
  });

  function drawProbes(X, Y) {
    ctx.save();
    ctx.strokeStyle = '#7fe0ff'; ctx.fillStyle = '#7fe0ff'; ctx.lineWidth = 1.6; ctx.font = '11px sans-serif';
    S.probes.forEach((p, i) => {
      if (p.type === 'pt') {
        const x = X(p.z), y = Y(p.r);
        ctx.beginPath(); ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y); ctx.moveTo(x, y - 6); ctx.lineTo(x, y + 6); ctx.stroke();
        ctx.fillText(probeName(i), x + 5, y - 5);
      } else {
        ctx.setLineDash(i === S.probeSel ? [] : [5, 3]);
        ctx.beginPath(); ctx.moveTo(X(p.a[1]), Y(p.a[0])); ctx.lineTo(X(p.b[1]), Y(p.b[0])); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillText(probeName(i), X(0.5 * (p.a[1] + p.b[1])) + 5, Y(0.5 * (p.a[0] + p.b[0])) - 5);
      }
    });
    if (S.probeA) { ctx.beginPath(); ctx.arc(X(S.probeA[1]), Y(S.probeA[0]), 4, 0, 2 * Math.PI); ctx.fill(); }
    ctx.restore();
  }

  // ------------------------------------------------------------------ thermal panel
  const fmtDur = s => (s == null || !isFinite(s) ? '–' : s < 120 ? `${s.toFixed(0)} s` : s < 7200 ? `${(s / 60).toFixed(1)} min` : `${(s / 3600).toFixed(1)} h`);

  function renderThermal() {
    const kv = $('thermKV'), note = $('thermNote');
    const st = S.prob && S.prob.coilAreaM2 ? coilAt() : null, th = st && st.th;
    $('thermFlag').textContent = th ? (th.runaway ? 'runaway' : th.overMax ? `${fmt(th.Tss, 0)} °C` : '') : '';
    if (!th) { kv.innerHTML = ''; note.textContent = 'Needs a coil window.'; return; }
    const env = thermalEnvNow(), flagT = th.runaway || th.overMax ? ' class="flag"' : '';
    const Tq = S.sweep ? [torqueAt(th.cold.NI), torqueAt(th.hot.NI)] : null;
    kv.innerHTML = [
      ['Steady coil temperature' + (P.duty < 100 ? ` at ${P.duty} % duty` : ''), `<dd${flagT}>${th.runaway ? 'thermal runaway' : fmt(th.Tss, 0) + ' °C'}</dd>`],
      ['Power, cold → hot', `<dd>${fmt(th.cold.P, 1)} → ${fmt(th.hot.P, 1)} W</dd>`],
      ['Ampere-turns, cold → hot', `<dd>${fmt(th.cold.NI, 0)} → ${fmt(th.hot.NI, 0)} A-t</dd>`],
      Tq ? ['Torque, cold → hot', `<dd>${fmt(Tq[0], 2)} → ${fmt(Tq[1], 2)} N·m</dd>`] : null,
      ['Always on: reaches ' + P.Tmax + ' °C in', `<dd${th.tToMax != null ? ' class="flag"' : ''}>${th.tToMax != null ? fmtDur(th.tToMax) : `never (settles at ${fmt(th.Tcont, 0)} °C)`}</dd>`],
      ['Longest duty under ' + P.Tmax + ' °C', `<dd>${fmt(100 * th.maxDuty, 0)} %</dd>`],
      ['Cooled area × h', `<dd>${fmt(env.areaM2 * 1e4, 0)} cm² × ${P.hConv} W/m²K</dd>`],
      ['Heat capacity, time constant', `<dd>${fmt(env.heatCapJK, 0)} J/K, ${fmtDur(th.tau)}</dd>`]
    ].filter(Boolean).map(([k, v]) => `<dt>${k}</dt>${v}`).join('');
    note.textContent = (P.thermalOp ? 'The operating point uses the steady-state (hot) coil.' : `The operating point uses a ${P.tempC} °C coil. Turn on “Solve at steady-state coil temperature” in Model settings to use the hot values.`) +
      ' Lumped model: the whole brake at one temperature, cooled from its outer surface.';
  }

  // ------------------------------------------------------------------ parameter study (Optimize tab)
  // One or two CAD user parameters are swept at fixed supply voltage and wire gauge. Each run sets the
  // parameters in Fusion, re-cuts the section in the frame of the loaded design, carries the body/gap/coil
  // setup over, and solves in a second worker so the main view stays usable. Fusion restores the original
  // expressions at the end (also if the palette closes or the add-in stops mid-study).
  const ST = { params: [], msg: '', running: false, stop: false, pts: [], spec: null, result: null,
    baseGeo: null, preview: null, compute: null, mock: {}, frame: null, angle: 0, applyArm: 0, pickProbe: false, hits: [] };

  const cad = {
    async list() {
      if (inFusion()) return JSON.parse(await fusion('listParams', {}));
      if (!S.geo || S.geo.source !== window.FERRA_DEMO.source) {
        return { ok: false, error: 'Outside Fusion, parameter studies run on the demo brake. Load the demo brake first.' };
      }
      return { ok: true, parametric: true, params: window.FERRA_DEMO_CAD.PARAMS.map(p => {
        const v = ST.mock[p.name] != null ? ST.mock[p.name] : p.value;
        return { name: p.name, unit: p.unit, comment: p.comment, value: v, expression: FS.expr(v, p.unit), driven: false };
      }) };
    },
    /** set: [[param, value], ...] */
    async evalPoint(set) {
      if (inFusion()) {
        const m = {};
        set.forEach(([p, x]) => { m[p.name] = FS.expr(x, p.unit); });
        return JSON.parse(await fusion('evalPoint', { set: m, extract: { frame: ST.frame, angle: ST.angle } }));
      }
      await sleep();
      const v = Object.assign({}, ST.mock);
      set.forEach(([p, x]) => { v[p.name] = x; });
      return window.FERRA_DEMO_CAD.build(v);
    },
    async restore() {
      if (inFusion()) return JSON.parse(await fusion('restoreParams', {}));
      return { ok: true, restored: [] };
    },
    async apply(set) {
      if (inFusion()) {
        const m = {};
        set.forEach(([p, x]) => { m[p.name] = FS.expr(x, p.unit); });
        const r = JSON.parse(await fusion('setParams', { set: m }));
        if (!r.ok) return { ok: false, error: (r.errors || [r.error]).join('; ') };
        const g = JSON.parse(await fusion('extract', { axis: $('axis').value, angle: parseFloat($('angle').value) || 0 }));
        return g.ok ? { ok: true, geometry: g, timelineErrors: r.timelineErrors || [] } : { ok: false, error: g.error };
      }
      const v = Object.assign({}, ST.mock);
      set.forEach(([p, x]) => { v[p.name] = x; });
      const b = window.FERRA_DEMO_CAD.build(v);
      if (!b.feasible) return { ok: false, error: b.errors.join('; ') };
      ST.mock = v;
      return { ok: true, geometry: b.geometry, timelineErrors: [] };
    }
  };

  async function loadParams() {
    ST.msg = 'Reading user parameters…';
    renderStudy();
    renderMap();
    try {
      const r = await cad.list();
      ST.params = [];
      if (!r.ok) ST.msg = r.error;
      else if (!r.parametric) ST.msg = 'Parameter studies need a parametric design (timeline / design history on).';
      else if (!r.params.length) ST.msg = 'This design has no user parameters. Add them in Modify → Change Parameters and drive the dimensions you want to sweep from them.';
      else { ST.params = r.params; ST.msg = ''; }
      if (r.ok && r.studyActive && !MP.running) await cad.restore(); // an earlier study was interrupted
    } catch (e) {
      ST.params = []; ST.msg = 'Could not read parameters: ' + (e.message || e);
    }
    renderStudy();
    renderMap();
  }

  const OBJ_KEYS = ['torque', 'force', 'forcePerSteelKg', 'steelMass', 'torquePerW', 'torquePerKg', 'util', 'Bgap', 'Bpoint', 'lineFlux', 'steelB98', 'Tcoil', 'mass'];
  const probeOpts = type => S.probes.map((p, i) => ({ p, i })).filter(o => o.p.type === type);

  function axisRow(n) {
    const sfx = n === 1 ? '' : '2';
    return `<div class="row"><label>${n === 1 ? 'Parameter' : 'Second parameter'} <select id="stParam${sfx}">${ST.params.map((p, i) => `<option value="${i}">${esc(p.name)} = ${esc(p.expression)}</option>`).join('')}</select></label>
        ${n === 1 ? '<button data-act="load" title="Read the user parameters again">Reload</button>' : ''}</div>
      <p class="note" id="stInfo${sfx}"></p>
      <div class="row"><label>From <input type="number" id="stLo${sfx}" step="any"></label><label>to <input type="number" id="stHi${sfx}" step="any"></label>
        <span id="stUnit${sfx}"></span><label>in <input type="number" id="stN${sfx}" value="${n === 1 ? 7 : 5}" min="2" max="41" step="1"> steps</label></div>`;
  }

  function renderStudy() {
    const el = $('tab-study');
    if (!ST.params.length) {
      el.innerHTML = `<div class="study-empty"><p class="note">${esc(ST.msg || 'Sweep one or two CAD user parameters at fixed voltage and wire gauge, then refine around the best value.')}</p>
        <button data-act="load">Load user parameters</button></div>`;
      return;
    }
    el.innerHTML = `<div class="study">
      <div class="study-setup">
        ${axisRow(1)}
        <label class="chk"><input type="checkbox" id="stTwo"${ST.params.length < 2 ? ' disabled' : ''}> Also sweep a second parameter (grid of both)</label>
        <div id="stAxis2" class="axis2" hidden>${axisRow(2)}</div>
        <div class="row"><label>Objective <select id="stObj">${OBJ_KEYS.map(k => `<option value="${k}">${FS.OBJECTIVES[k].label}</option>`).join('')}</select></label>
          <select id="stDir"><option value="max">Maximise</option><option value="min">Minimise</option></select></div>
        <div class="row" id="stPointRow" hidden><label>Point r <input type="number" id="stR" step="0.5"> mm</label><label>z <input type="number" id="stZ" step="0.5"> mm</label>
          <button data-act="pickProbe" id="stPick">Pick on section</button>
          ${probeOpts('pt').length ? `<select id="stProbePt"><option value="">or use probe…</option>${probeOpts('pt').map(o => `<option value="${o.i}">${probeName(o.i)} (${o.p.r}, ${o.p.z})</option>`).join('')}</select>` : ''}</div>
        <div class="row" id="stLineRow" hidden>${probeOpts('line').length ? `<label>Probe line <select id="stLine">${probeOpts('line').map(o => `<option value="${o.i}">${probeName(o.i)}</option>`).join('')}</select></label>`
          : '<span class="note">Add a probe line in the Probes tab first.</span>'}</div>
        <label class="chk"><input type="checkbox" id="stLim" checked> Keep within the coil power and current-density limits (Model settings)</label>
        <label class="chk"><input type="checkbox" id="stB98"> Steel B98 at most <input type="number" id="stB98v" value="2.0" step="0.05"> T</label>
        <label class="chk"><input type="checkbox" id="stTmax"> Steady-state coil temperature within the limit (Thermal settings)</label>
        <p class="note">Torque is solved at the coil temperature chosen in Model settings (fixed, or steady state).</p>
        <div class="row"><label>Refine around the best value with <input type="number" id="stRef" value="6" min="0" max="30" step="1"> extra runs</label></div>
        <div class="row"><button class="primary" data-act="run" id="stRun">Run study</button><button data-act="stop" id="stStop" disabled>Stop</button>
          <span class="note" id="stCount"></span></div>
        <p class="note" id="stProg"></p>
        <p class="note">Voltage and wire gauge stay as set by the sliders; turns are refitted to each coil window. Each run changes the parameters in the CAD model, re-cuts the section and solves. The original values are put back at the end.</p>
      </div>
      <div class="study-out"><canvas id="stChart" title="Click a point to show that variant"></canvas><div id="stBest"></div></div>
      <div class="study-table" id="stTable"></div>
    </div>`;
    $('stParam').onchange = () => paramDefaults('', true);
    $('stParam2').onchange = () => paramDefaults('2', true);
    $('stTwo').onchange = () => {
      $('stAxis2').hidden = !$('stTwo').checked;
      if ($('stTwo').checked) {
        if ($('stParam2').value === $('stParam').value) { $('stParam2').value = String((+$('stParam').value + 1) % ST.params.length); paramDefaults('2', true); }
        if (+$('stN').value > 7) $('stN').value = 5;
        if (+$('stRef').value < 8) $('stRef').value = 8;
      }
      runCount();
    };
    $('stObj').onchange = () => { const o = FS.OBJECTIVES[$('stObj').value]; $('stDir').value = o.dir; $('stPointRow').hidden = $('stObj').value !== 'Bpoint'; $('stLineRow').hidden = $('stObj').value !== 'lineFlux'; };
    if ($('stProbePt')) $('stProbePt').onchange = () => { const p = S.probes[+$('stProbePt').value]; if (p) { $('stR').value = p.r; $('stZ').value = p.z; } };
    ['stN', 'stN2', 'stRef'].forEach(id => { $(id).oninput = runCount; });
    $('stParam2').value = String(Math.min(1, ST.params.length - 1));
    paramDefaults('2', true);
    if (ST.spec) fillSetup(ST.spec); else paramDefaults('', true);
    runCount();
    setRunning(ST.running);
    renderStudyResults();
  }

  function runCount() {
    if (!$('stCount')) return;
    const n1 = Math.round(+$('stN').value) || 0, n2 = $('stTwo').checked ? Math.round(+$('stN2').value) || 0 : 1, r = Math.max(0, Math.round(+$('stRef').value) || 0);
    $('stCount').textContent = `${n1 * n2} grid runs + up to ${r} refinement runs`;
  }

  const nice = x => +x.toPrecision(3);
  function paramDefaults(sfx, resetRange) {
    const p = ST.params[+$('stParam' + sfx).value];
    if (!p) return;
    $('stUnit' + sfx).textContent = p.unit || '';
    const parts = [`Now ${esc(p.expression)}.`];
    if (p.comment) parts.unshift(esc(p.comment) + '.');
    if (p.driven) parts.push('It is defined by other parameters; the study replaces that expression with numbers and puts it back afterwards.');
    $('stInfo' + sfx).innerHTML = parts.join(' ');
    if (resetRange) {
      const v = p.value;
      if (v > 0) { $('stLo' + sfx).value = nice(v * 0.6); $('stHi' + sfx).value = nice(v * 1.4); }
      else if (v < 0) { $('stLo' + sfx).value = nice(v * 1.4); $('stHi' + sfx).value = nice(v * 0.6); }
      else { $('stLo' + sfx).value = -1; $('stHi' + sfx).value = 1; }
    }
  }

  function fillSetup(sp) {
    sp.axes.forEach((a, n) => {
      const sfx = n ? '2' : '', i = ST.params.findIndex(p => p.name === a.p.name);
      if (i >= 0) $('stParam' + sfx).value = i;
      paramDefaults(sfx, false);
      $('stLo' + sfx).value = a.lo; $('stHi' + sfx).value = a.hi; $('stN' + sfx).value = a.n;
    });
    $('stTwo').checked = sp.axes.length === 2;
    $('stAxis2').hidden = sp.axes.length !== 2;
    $('stRef').value = sp.ref;
    $('stObj').value = sp.objective; $('stDir').value = sp.dir;
    $('stPointRow').hidden = sp.objective !== 'Bpoint';
    $('stLineRow').hidden = sp.objective !== 'lineFlux';
    if (sp.lineIdx != null && $('stLine')) $('stLine').value = sp.lineIdx;
    $('stTmax').checked = sp.cons.Tmax != null;
    if (sp.point) { $('stR').value = sp.point[0]; $('stZ').value = sp.point[1]; }
    $('stLim').checked = sp.cons.Pmax != null;
    $('stB98').checked = sp.cons.steelB98Max != null;
    if (sp.cons.steelB98Max != null) $('stB98v').value = sp.cons.steelB98Max;
  }

  function setRunning(on) {
    if (!$('stRun')) return;
    $('stRun').disabled = on; $('stStop').disabled = !on;
  }

  function studyMsg(m, kind) { if ($('stProg')) $('stProg').textContent = m; status(m, kind == null ? 'err' : kind); }

  /** Classes, roles, gap flags and coil picks of the design in the main view, keyed for re-mapping. */
  function snapshotSetup() {
    const keys = S.geo.bodies.map(FS.bodyKey);
    return {
      bodies: new Map(S.geo.bodies.map((b, i) => [keys[i], { cls: S.meta[i].cls, role: S.meta[i].role, grade: S.meta[i].grade }])),
      gaps: S.prob ? S.prob.gaps.map(g => FS.gapSignature(g, keys)) : [],
      coilPicks: S.coilPicks.slice(), coilBox: S.coilPickBox,
      overlaps: new Map((S.G && S.G.overlaps || []).map(o => [[keys[o.a], keys[o.b]].sort().join(' & '), o.areaMM2]))
    };
  }

  function readAxis(sfx) {
    const p = ST.params[+$('stParam' + sfx).value];
    const lo = parseFloat($('stLo' + sfx).value), hi = parseFloat($('stHi' + sfx).value), n = Math.round(parseFloat($('stN' + sfx).value));
    if (!(hi > lo)) return `${p.name}: the range needs From below To.`;
    if (!(n >= 2 && n <= 41)) return `${p.name}: use 2 to 41 steps.`;
    return { p, lo, hi, n };
  }

  const vlabel = (sp, v) => sp.axes.map((a, n) => `${a.p.name} = ${FS.expr(v[n], a.p.unit)}`).join(', ');

  async function runStudy() {
    if (ST.running) return;
    if (MP.running) return studyMsg('A design map is running. Wait for it or stop it first.');
    if (!S.geo || !S.prob) return studyMsg('Load a design and set it up first.');
    if (!S.prob.coilAreaM2) return studyMsg('Set up the coil window first.');
    if (!S.prob.gaps.some(g => g.torque)) return studyMsg('No torque gap: set rotor/stator roles first.');
    const axes = [readAxis('')];
    if ($('stTwo').checked) axes.push(readAxis('2'));
    const bad = axes.find(a => typeof a === 'string');
    if (bad) return studyMsg(bad);
    if (axes.length === 2 && axes[0].p.name === axes[1].p.name) return studyMsg('Pick two different parameters.');
    if (axes.length === 2 && axes[0].n * axes[1].n > 225) return studyMsg('Keep the grid to 225 runs or fewer.');
    const ref = Math.max(0, Math.round(parseFloat($('stRef').value) || 0));
    const objective = $('stObj').value, dir = $('stDir').value;
    const point = objective === 'Bpoint' ? [parseFloat($('stR').value), parseFloat($('stZ').value)] : null;
    if (point && !point.every(isFinite)) return studyMsg('Enter the probe point r and z, or pick it on the section.');
    let line = null, lineIdx = null;
    if (objective === 'lineFlux') {
      if (!$('stLine')) return studyMsg('Add a probe line in the Probes tab first.');
      lineIdx = +$('stLine').value;
      const pl = S.probes[lineIdx];
      line = [pl.a, pl.b];
    }
    const cons = { Pmax: $('stLim').checked ? P.Pmax : null, Jmax: $('stLim').checked ? P.Jmax : null,
      steelB98Max: $('stB98').checked ? parseFloat($('stB98v').value) : null, Tmax: $('stTmax').checked ? P.Tmax : null };
    axes.forEach(a => { a.grid = FS.grid(a.lo, a.hi, a.n, false).map(x => +x.toPrecision(6)); });
    const sp = ST.spec = { axes, ref, objective, dir, point, line, lineIdx, cons, V: P.V, swg: P.swg };
    if (ST.preview == null) ST.baseGeo = S.geo;
    ST.frame = S.geo.axis && S.geo.axis.origin ? { origin: S.geo.axis.origin, dir: S.geo.axis.dir } : null;
    ST.angle = parseFloat($('angle').value) || 0;
    const setup = snapshotSetup();
    if (!ST.compute) ST.compute = window.ferraCompute(F);
    const ctx = { F, FI, FM, P: Object.assign({}, P), mat: S.mat, compute: ST.compute, classify, point, line,
      base: { bodies: setup.bodies, gaps: setup.gaps, coilPicks: setup.coilPicks, coilBox: setup.coilBox, overlaps: setup.overlaps } };
    const nGrid = axes.reduce((s, a) => s * a.n, 1);
    ST.pts = []; ST.result = null; ST.running = true; ST.stop = false; ST.applyArm = 0;
    setRunning(true);
    renderStudyResults();
    let k = 0, bridgeDown = false;
    const evalVec = async v0 => {
      const v = v0.map(x => +x.toPrecision(6));
      k++;
      const label = `Run ${k}${k <= nGrid ? '/' + nGrid : ' (refine)'}: ${vlabel(sp, v)}`;
      if ($('stProg')) $('stProg').textContent = label;
      status(label, 'busy');
      const pt = { v, x: v[0], k, refine: k > nGrid };
      try {
        const r = await cad.evalPoint(axes.map((a, n) => [a.p, v[n]]));
        if (!r.ok) { bridgeDown = true; throw new Error(r.error || 'CAD update failed'); }
        if (!r.feasible) { pt.status = 'cad'; pt.reason = r.errors.join('; '); }
        else {
          Object.assign(pt, await FS.evaluateGeometry(ctx, r.geometry, r.massKg));
          if (pt.status === 'ok') { pt.geo = r.geometry; pt.violations = FS.violations(pt.metrics, cons); }
        }
      } catch (e) {
        pt.status = 'error'; pt.reason = String((e && e.message) || e).split('\n')[0];
        if (bridgeDown) ST.stop = true;
      }
      pt.score = FS.score(pt, objective, dir);
      ST.pts.push(pt);
      renderStudyResults();
      return pt.score;
    };
    let restoreMsg = '';
    try {
      ST.result = axes.length === 1
        ? await FS.sweep(axes[0].grid, ref, x => evalVec([x]), () => ST.stop)
        : await FS.sweep2(axes[0].grid, axes[1].grid, ref, evalVec, () => ST.stop);
    } catch (e) {
      fail(e);
    } finally {
      try {
        const r = await cad.restore();
        if (!r.ok) restoreMsg = 'Could not restore parameters: ' + (r.errors || [r.error]).join('; ');
      } catch (e) { restoreMsg = 'Could not restore parameters: ' + (e.message || e); }
      ST.running = false;
      setRunning(false);
      renderStudyResults();
      const m = restoreMsg || (ST.stop ? 'Study stopped. Parameters restored.' : `Study done (${ST.pts.length} runs). Parameters restored.`);
      studyMsg(m, restoreMsg ? 'err' : '');
    }
  }

  function bestPoint() {
    let b = null;
    for (const p of ST.pts) if (isFinite(p.score) && (!b || p.score > b.score)) b = p;
    return b;
  }

  function objValue(p) {
    if (!p || p.status !== 'ok') return null;
    const v = FS.OBJECTIVES[ST.spec.objective].get(p.metrics);
    return v != null && isFinite(v) ? v : null;
  }
  function fmtObj(p) { const v = objValue(p); return v == null ? '–' : fmt(v, FS.OBJECTIVES[ST.spec.objective].d); }

  const byV = (a, b) => (a.v[0] - b.v[0]) || ((a.v[1] || 0) - (b.v[1] || 0));

  function renderStudyResults() {
    if (!$('stTable') || !ST.spec) { if ($('stChart')) drawStudyChart(); return; }
    const sp = ST.spec, o = FS.OBJECTIVES[sp.objective];
    const best = bestPoint();
    const rows = ST.pts.slice().sort(byV);
    const stat = p => p.status === 'ok' ? (p.violations.length ? `<span class="warn">over limit: ${esc(p.violations.join(', '))}</span>` : (p.metrics.converged ? 'ok' : '<span class="warn">not fully converged</span>'))
      : p.status === 'cad' ? `<span class="warn">CAD error: ${esc(p.reason)}</span>` : `<span class="warn">${esc(p.reason || 'failed')}</span>`;
    const axTh = sp.axes.map(a => `<th>${esc(a.p.name)}${a.p.unit ? ', ' + esc(a.p.unit) : ''}</th>`).join('');
    $('stTable').innerHTML = rows.length ? `<table><thead><tr>${axTh}<th>${esc(o.label)}, ${esc(o.unit)}</th>
      <th>Torque, N·m</th><th>NI, A-t</th><th>I, A</th><th>P, W</th><th>J, A/mm²</th><th>Steel B98, T</th><th>Coil, °C</th><th>Mass, kg</th><th class="l">Status</th></tr></thead><tbody>${
      rows.map(p => { const m = p.metrics || {}; return `<tr data-k="${p.k}" class="${best && p === best ? 'best' : ''} ${ST.preview === p.k ? 'prev' : ''}" title="Click to show this variant in the main view">
        ${p.v.map((x, n) => `<td>${fmt(x, 4)}${n === p.v.length - 1 && p.refine ? ' <span class="note">refine</span>' : ''}</td>`).join('')}<td>${fmtObj(p)}</td><td>${fmt(m.T, 3)}</td><td>${fmt(m.NI, 0)}</td><td>${fmt(m.I, 2)}</td>
        <td>${fmt(m.P, 1)}</td><td>${fmt(m.J, 2)}</td><td>${fmt(m.steelB98, 2)}</td><td>${m.runaway ? 'runaway' : fmt(m.Tcoil, 0)}</td><td>${m.massKg != null ? fmt(m.massKg, 3) : '–'}</td><td class="l">${stat(p)}</td></tr>`; }).join('')
    }</tbody></table>` : '';
    let html = '';
    if (best) {
      html += `<p><strong>Best: ${esc(vlabel(sp, best.v))}</strong> → ${esc(o.label)} ${fmtObj(best)} ${esc(o.unit)} (torque ${fmt(best.metrics.T, 3)} N·m, ${fmt(best.metrics.P, 1)} W)</p>`;
      const R = ST.result;
      if (!ST.running && R) {
        const edges = sp.axes.length === 1 ? (R.atEdge ? [sp.axes[0].p.name] : []) : sp.axes.filter((a, n) => R.atEdge[n]).map(a => a.p.name);
        if (edges.length) html += `<p class="warn">The best grid value of ${esc(edges.join(' and '))} is at the end of its range: the optimum may lie beyond it. Extend the range and run again.</p>`;
        else if (sp.axes.length === 1 && R.bracket) html += `<p class="note">Optimum lies between ${fmt(R.bracket[0], 4)} and ${fmt(R.bracket[1], 4)} ${esc(sp.axes[0].p.unit || '')}. Differences below about ${fmt(P.hmax, 2)} mm of geometry are within mesh noise.</p>`;
        else if (R.box) html += `<p class="note">Refined within ${esc(sp.axes[0].p.name)} ${fmt(R.box.x[0], 4)}–${fmt(R.box.x[1], 4)} and ${esc(sp.axes[1].p.name)} ${fmt(R.box.y[0], 4)}–${fmt(R.box.y[1], 4)} (one grid cell around the best grid point). Differences below about ${fmt(P.hmax, 2)} mm of geometry are within mesh noise.</p>`;
      }
      html += `<div class="row">
        <button data-act="preview" data-k="${best.k}">Show best in main view</button>
        ${ST.running ? '' : `<button data-act="apply" data-k="${best.k}" class="${ST.applyArm === best.k ? 'on' : ''}">${ST.applyArm === best.k ? 'Click again to change the CAD model' : 'Apply to CAD'}</button>`}
        ${ST.preview != null ? '<button data-act="back">Back to the current design</button>' : ''}
        <button data-act="csv">Export CSV</button></div>`;
    } else if (ST.pts.length && !ST.running) html = '<p class="warn">No run met the constraints. Widen the range or relax the limits.</p>';
    $('stBest').innerHTML = html;
    drawStudyChart();
  }

  function chartColors() {
    const css = getComputedStyle(document.documentElement), v = n => css.getPropertyValue(n).trim();
    return { ink: v('--muted'), cop: v('--copper'), line: v('--line'), warn: v('--warn'), ok: v('--ok'), panel: v('--panel') };
  }

  function drawStudyChart() {
    const c = $('stChart');
    if (!c) return;
    const g = c.getContext('2d'), dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    c.width = W * dpr; c.height = H * dpr; g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    ST.hits = [];
    const col = chartColors();
    g.font = '10.5px sans-serif'; g.fillStyle = col.ink;
    if (!ST.spec) { g.fillText('Results of the study appear here.', 10, 20); return; }
    if (ST.spec.axes.length === 2) drawHeatmap(g, W, H, col); else drawLine(g, W, H, col);
  }

  function drawLine(g, W, H, col) {
    const sp = ST.spec, o = FS.OBJECTIVES[sp.objective], ax = sp.axes[0];
    const ok = ST.pts.map(p => ({ p, y: objValue(p) })).filter(q => q.y != null);
    let x0 = ax.lo, x1 = ax.hi;
    ST.pts.forEach(p => { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); });
    let y0 = Infinity, y1 = -Infinity;
    ok.forEach(q => { y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); });
    if (!isFinite(y0)) { y0 = 0; y1 = 1; }
    if (y1 - y0 < 1e-9 * Math.max(1, Math.abs(y1))) { y0 -= Math.abs(y0) * 0.05 + 1e-3; y1 += Math.abs(y1) * 0.05 + 1e-3; }
    const pad = 0.08 * (y1 - y0); y0 -= pad; y1 += pad;
    const L = 50, R = 12, T = 18, B = 30;
    const sx = x => L + (x - x0) / (x1 - x0) * (W - L - R), sy = y => H - B - (y - y0) / (y1 - y0) * (H - B - T);
    g.strokeStyle = col.line; g.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const y = y0 + (y1 - y0) * k / 4, x = x0 + (x1 - x0) * k / 4;
      g.beginPath(); g.moveTo(L, sy(y)); g.lineTo(W - R, sy(y)); g.stroke();
      g.fillText(+y.toPrecision(3) + '', 4, sy(y) + 3);
      g.fillText(+x.toPrecision(3) + '', sx(x) - 10, H - B + 13);
    }
    g.fillText(`${o.label}, ${o.unit}`, L, 11);
    const xl = `${ax.p.name}${ax.p.unit ? ', ' + ax.p.unit : ''}`;
    g.fillText(xl, W - R - g.measureText(xl).width, H - 4);
    const good = ok.filter(q => !q.p.violations.length).sort((a, b) => a.p.x - b.p.x);
    g.strokeStyle = col.cop; g.lineWidth = 1.8; g.beginPath();
    good.forEach((q, k) => (k ? g.lineTo(sx(q.p.x), sy(q.y)) : g.moveTo(sx(q.p.x), sy(q.y))));
    g.stroke();
    for (const q of ok) {
      const X = sx(q.p.x), Y = sy(q.y);
      g.beginPath(); g.arc(X, Y, q.p.refine ? 3 : 4, 0, 2 * Math.PI);
      if (q.p.violations.length) { g.strokeStyle = col.warn; g.lineWidth = 1.5; g.stroke(); }
      else { g.fillStyle = q.p.refine ? col.ok : col.cop; g.fill(); }
      ST.hits.push({ x: X, y: Y, r: 8, k: q.p.k });
    }
    g.strokeStyle = col.warn; g.lineWidth = 1.5;
    for (const p of ST.pts) if (p.status !== 'ok') {
      const X = sx(p.x), Y = H - B - 6;
      g.beginPath(); g.moveTo(X - 4, Y - 4); g.lineTo(X + 4, Y + 4); g.moveTo(X + 4, Y - 4); g.lineTo(X - 4, Y + 4); g.stroke();
    }
    const b = bestPoint(), q = b && ok.find(z => z.p === b);
    if (q) { g.strokeStyle = col.ok; g.lineWidth = 2; g.beginPath(); g.arc(sx(b.x), sy(q.y), 8, 0, 2 * Math.PI); g.stroke(); }
  }

  const VIRIDIS = [[0, [68, 1, 84]], [0.25, [59, 82, 139]], [0.5, [33, 145, 140]], [0.75, [94, 201, 98]], [1, [253, 231, 37]]];

  function drawHeatmap(g, W, H, col) {
    const sp = ST.spec, o = FS.OBJECTIVES[sp.objective], [A, Bx] = sp.axes;
    const L = 50, R = 58, T = 18, B = 30;
    const x0 = A.lo, x1 = A.hi, y0 = Bx.lo, y1 = Bx.hi;
    const sx = x => L + (x - x0) / (x1 - x0) * (W - L - R), sy = y => H - B - (y - y0) / (y1 - y0) * (H - B - T);
    const vals = ST.pts.map(objValue).filter(v => v != null);
    let v0 = Math.min(...vals), v1 = Math.max(...vals);
    if (!vals.length) { v0 = 0; v1 = 1; }
    if (v1 - v0 < 1e-12) v1 = v0 + 1e-12;
    const colorOf = v => rgb(ramp(VIRIDIS, (v - v0) / (v1 - v0)));
    const edges = gr => gr.map((x, i) => [i ? 0.5 * (gr[i - 1] + x) : x, i < gr.length - 1 ? 0.5 * (x + gr[i + 1]) : x]);
    const ex = edges(A.grid), ey = edges(Bx.grid);
    const same = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
    // grid cells
    A.grid.forEach((x, i) => Bx.grid.forEach((y, j) => {
      const p = ST.pts.find(q => !q.refine && same(q.v[0], x) && same(q.v[1], y));
      const X0 = sx(ex[i][0]), X1 = sx(ex[i][1]), Y0 = sy(ey[j][1]), Y1 = sy(ey[j][0]);
      const w = Math.max(1, X1 - X0), h = Math.max(1, Y1 - Y0);
      if (!p) { g.strokeStyle = col.line; g.lineWidth = 1; g.strokeRect(X0 + 0.5, Y0 + 0.5, w - 1, h - 1); return; }
      const v = objValue(p);
      if (v != null) {
        g.fillStyle = colorOf(v); g.fillRect(X0, Y0, w + 0.5, h + 0.5);
        if (p.violations.length) { // hatch over-limit cells
          g.save(); g.beginPath(); g.rect(X0, Y0, w, h); g.clip();
          g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 1.2;
          for (let t = -h; t < w; t += 6) { g.beginPath(); g.moveTo(X0 + t, Y1); g.lineTo(X0 + t + h, Y0); g.stroke(); }
          g.restore();
        }
      } else {
        g.fillStyle = col.line; g.fillRect(X0, Y0, w + 0.5, h + 0.5);
        const cx = sx(x), cy = sy(y);
        g.strokeStyle = col.warn; g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(cx - 4, cy - 4); g.lineTo(cx + 4, cy + 4); g.moveTo(cx + 4, cy - 4); g.lineTo(cx - 4, cy + 4); g.stroke();
      }
      ST.hits.push({ rect: [X0, Y0, w, h], k: p.k });
    }));
    // refinement runs on top
    for (const p of ST.pts.filter(q => q.refine)) {
      const v = objValue(p), X = sx(p.v[0]), Y = sy(p.v[1]);
      g.beginPath(); g.arc(X, Y, 4.5, 0, 2 * Math.PI);
      if (v != null && !p.violations.length) { g.fillStyle = colorOf(v); g.fill(); }
      g.strokeStyle = v == null || p.violations.length ? col.warn : '#ffffff'; g.lineWidth = 1.3; g.stroke();
      ST.hits.unshift({ x: X, y: Y, r: 7, k: p.k });
    }
    const b = bestPoint();
    if (b) { g.strokeStyle = col.ok; g.lineWidth = 2.2; g.beginPath(); g.arc(sx(b.v[0]), sy(b.v[1]), 9, 0, 2 * Math.PI); g.stroke(); }
    // axes
    g.fillStyle = col.ink;
    const ticks = (gr, n) => gr.filter((_, i) => gr.length <= n || i % Math.ceil(gr.length / n) === 0 || i === gr.length - 1);
    ticks(A.grid, 6).forEach(x => { const s = +x.toPrecision(3) + ''; g.fillText(s, sx(x) - g.measureText(s).width / 2, H - B + 13); });
    ticks(Bx.grid, 6).forEach(y => { const s = +y.toPrecision(3) + ''; g.fillText(s, L - 6 - g.measureText(s).width, sy(y) + 3); });
    const xl = `${A.p.name}${A.p.unit ? ', ' + A.p.unit : ''}`;
    g.fillText(xl, W - R - g.measureText(xl).width, H - 4);
    g.fillText(`${Bx.p.name}${Bx.p.unit ? ', ' + Bx.p.unit : ''}`, 4, 11);
    // colour bar
    const cbX = W - R + 14, cbT = T, cbH = H - B - T;
    for (let t = 0; t < cbH; t++) { g.fillStyle = rgb(ramp(VIRIDIS, 1 - t / cbH)); g.fillRect(cbX, cbT + t, 10, 1.2); }
    g.fillStyle = col.ink;
    g.fillText(+v1.toPrecision(3) + '', cbX + 13, cbT + 8);
    g.fillText(+v0.toPrecision(3) + '', cbX + 13, cbT + cbH);
    g.save(); g.translate(W - 4, T + cbH / 2); g.rotate(-Math.PI / 2);
    const ol = `${o.label}, ${o.unit}`; g.fillText(ol, -g.measureText(ol).width / 2, 0); g.restore();
  }

  function exportCSV() {
    if (!ST.spec || !ST.pts.length) return;
    const sp = ST.spec, o = FS.OBJECTIVES[sp.objective];
    const head = ['run'].concat(sp.axes.map(a => `${a.p.name} (${a.p.unit || '-'})`), [`${o.label} (${o.unit})`, 'torque_Nm', 'NI_At', 'turns', 'I_A', 'R_ohm', 'P_W', 'J_Amm2',
      'steel_B98_T', 'steel_B98_body', 'coil_C', 'mass_kg', 'flux_util', 'gap_B_T', 'refine', 'status']);
    const q = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [head.join(',')].concat(ST.pts.slice().sort(byV).map(p => {
      const m = p.metrics || {};
      const st = p.status === 'ok' ? (p.violations.length ? 'over limit: ' + p.violations.join('; ') : 'ok') : p.status + ': ' + (p.reason || '');
      return [p.k].concat(p.v, [objValue(p), m.T, m.NI, m.N, m.I, m.R, m.P, m.J, m.steelB98, m.steelB98Body, m.runaway ? 'runaway' : m.Tcoil, m.massKg, m.util, m.Bg, p.refine ? 1 : 0, st]).map(q).join(',');
    }));
    saveText(`${(S.geo && S.geo.source || 'brake').replace(/[^\w.-]+/g, '_')}_${sp.axes.map(a => a.p.name).join('_x_')}_study.csv`, lines.join('\n'), 'CSV (*.csv)');
  }

  async function saveText(name, content, filter) {
    if (inFusion()) {
      const r = JSON.parse(await fusion('saveJSON', { filename: name, content, filter }));
      status(r.ok ? 'Saved ' + r.path : 'Save cancelled');
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain' })); a.download = name; a.click();
    }
  }

  function previewPoint(k) {
    const p = ST.pts.find(z => z.k === k);
    if (!p || !p.geo) return;
    if (ST.preview == null) ST.baseGeo = S.geo;
    ST.preview = k;
    loadGeometry(p.geo, { carry: true, label: `preview ${vlabel(ST.spec, p.v)} (CAD unchanged)` });
    renderStudyResults();
  }

  function backToBase() {
    if (ST.preview == null || !ST.baseGeo) return;
    ST.preview = null;
    loadGeometry(ST.baseGeo, { carry: true });
    renderStudyResults();
  }

  async function applyPoint(k) {
    const p = ST.pts.find(z => z.k === k);
    if (!p || ST.running) return;
    if (ST.applyArm !== k) {
      ST.applyArm = k; renderStudyResults();
      setTimeout(() => { if (ST.applyArm === k) { ST.applyArm = 0; renderStudyResults(); } }, 5000);
      return;
    }
    ST.applyArm = 0;
    status('Changing the CAD model', 'busy');
    try {
      const r = await cad.apply(ST.spec.axes.map((a, n) => [a.p, p.v[n]]));
      if (!r.ok) { studyMsg('Apply failed: ' + r.error); return; }
      ST.preview = null;
      loadGeometry(r.geometry, { carry: true });
      ST.baseGeo = S.geo;
      const msg = `${vlabel(ST.spec, p.v)} set in the CAD model.`;
      await loadParams();
      studyMsg(r.timelineErrors && r.timelineErrors.length ? msg + ' Timeline errors: ' + r.timelineErrors.join('; ') : msg,
        r.timelineErrors && r.timelineErrors.length ? 'err' : '');
    } catch (e) { fail(e); }
  }

  $('tab-study').addEventListener('click', ev => {
    if (ev.target.id === 'stChart') {
      const rc = ev.target.getBoundingClientRect(), x = ev.clientX - rc.left, y = ev.clientY - rc.top;
      const h = ST.hits.find(t => (t.rect ? x >= t.rect[0] && x <= t.rect[0] + t.rect[2] && y >= t.rect[1] && y <= t.rect[1] + t.rect[3]
        : Math.hypot(x - t.x, y - t.y) <= t.r));
      if (h) previewPoint(h.k);
      return;
    }
    const b = ev.target.closest('[data-act]');
    if (b) {
      const act = b.dataset.act, k = +b.dataset.k;
      if (act === 'load') loadParams();
      else if (act === 'run') runStudy();
      else if (act === 'stop') { ST.stop = true; studyMsg('Stopping after this run…', 'busy'); }
      else if (act === 'preview') previewPoint(k);
      else if (act === 'apply') applyPoint(k);
      else if (act === 'back') backToBase();
      else if (act === 'csv') exportCSV();
      else if (act === 'pickProbe') { ST.pickProbe = !ST.pickProbe; b.classList.toggle('on', ST.pickProbe); status(ST.pickProbe ? 'Click the probe point on the section' : 'Ready'); }
      return;
    }
    const tr = ev.target.closest('tr[data-k]');
    if (tr) previewPoint(+tr.dataset.k);
  });

  // ------------------------------------------------------------------ design map (multi-variable sweep)
  // Full-factorial sweep of two or three CAD user parameters: every combination from min to max is built in the CAD
  // model, re-cut, solved at the slider voltage and gauge, and recorded with its brake force and steel mass. Plots:
  // force heat map (steel mass in each cell), force vs steel mass (with the lightest-for-its-force frontier), and
  // force vs the first parameter with one line per value of the second.
  const MP = { spec: null, pts: [], running: false, stop: false, view: 'heat', slice: 0, colorBy: 0, hits: [] };
  const MAP_MAX_RUNS = 400;
  const MAP_METRICS = {
    force: { label: 'Brake force', unit: 'kgf', d: 2, get: m => m.Fkgf },
    torque: { label: 'Torque', unit: 'N·m', d: 3, get: m => m.T },
    steelMass: { label: 'Steel mass', unit: 'kg', d: 3, get: m => m.steelMassKg },
    forcePerSteelKg: { label: 'Force per kg of steel', unit: 'kgf/kg', d: 2, get: m => (m.steelMassKg > 0 && m.Fkgf != null ? m.Fkgf / m.steelMassKg : null) },
    power: { label: 'Coil power', unit: 'W', d: 1, get: m => m.P },
    steelB98: { label: 'Highest steel B98', unit: 'T', d: 2, get: m => m.steelB98 }
  };

  function mapAxisRow(n) {
    const p = ST.params, def = Math.min(n, p.length - 1);
    return `<div class="map-axis" data-ax="${n}"><div class="row"><label>${n === 2 ? '<input type="checkbox" id="mpUse2"> ' : ''}Parameter ${n + 1}
        <select id="mpP${n}">${p.map((q, i) => `<option value="${i}"${i === def ? ' selected' : ''}>${esc(q.name)} = ${esc(q.expression)}</option>`).join('')}</select></label></div>
      <div class="row" id="mpR${n}"><label>min <input type="number" id="mpLo${n}" step="any"></label><label>max <input type="number" id="mpHi${n}" step="any"></label>
        <span id="mpU${n}"></span><label>steps <input type="number" id="mpN${n}" value="${n === 2 ? 3 : 5}" min="2" max="21" step="1"></label></div>
      <p class="note" id="mpI${n}"></p></div>`;
  }

  /** Suggest a range around the current value, nudged toward the demo's thin-and-wide vs small-and-thick example. */
  function mapDefaults(n) {
    const p = ST.params[+$('mpP' + n).value];
    if (!p) return;
    $('mpU' + n).textContent = p.unit || '';
    $('mpI' + n).innerHTML = [p.comment ? esc(p.comment) + '.' : '', `Now ${esc(p.expression)}.`, p.driven ? 'Driven by other parameters; replaced by numbers during the sweep and put back afterwards.' : ''].join(' ');
    const v = p.value;
    if (v > 0) { $('mpLo' + n).value = nice(v * 0.7); $('mpHi' + n).value = nice(v * 1.3); }
    else if (v < 0) { $('mpLo' + n).value = nice(v * 1.3); $('mpHi' + n).value = nice(v * 0.7); }
    else { $('mpLo' + n).value = -1; $('mpHi' + n).value = 1; }
  }

  function mapCount() {
    if (!$('mpCount')) return;
    const n = [0, 1, 2].filter(k => k < 2 || ($('mpUse2') && $('mpUse2').checked)).reduce((s, k) => s * (Math.round(+$('mpN' + k).value) || 0), 1);
    $('mpCount').textContent = `${n} combinations`;
    $('mpCount').className = n > MAP_MAX_RUNS ? 'warn' : 'note';
  }

  function renderMap() {
    const el = $('tab-map');
    if (ST.params.length < 2) {
      el.innerHTML = `<div class="study-empty"><p class="note">${esc(ST.params.length === 1 ? 'A design map needs at least two user parameters.' : (ST.msg || 'Sweep two or three CAD parameters over every combination and see how brake force and steel mass change together (for example a thin, large-diameter brake against a small, thick one).'))}</p>
        <button data-mact="load">Load user parameters</button></div>`;
      return;
    }
    el.innerHTML = `<div class="map">
      <div class="map-setup">
        ${mapAxisRow(0)}${mapAxisRow(1)}${ST.params.length >= 3 ? mapAxisRow(2) : ''}
        <label class="chk"><input type="checkbox" id="mpLim"> Mark runs over the coil power / current-density limits</label>
        <div class="row"><button class="primary" data-mact="run" id="mpRun">Run design map</button><button data-mact="stop" id="mpStop" disabled>Stop</button>
          <span class="note" id="mpCount"></span></div>
        <p class="note" id="mpProg"></p>
        <p class="note">Every combination of the parameters, min to max, is built in the CAD model and solved at the slider voltage and wire gauge (turns refitted to each coil window). Steel mass is the CAD mass of the bodies treated as steel. Parameters are put back at the end.</p>
      </div>
      <div class="map-out">
        <div class="row"><label>Plot <select id="mpView">
            <option value="heat">Force map (steel mass in each cell)</option>
            <option value="scatter">Force vs steel mass</option>
            <option value="lines">Force vs parameter 1</option></select></label>
          <label id="mpMetricL">Colour <select id="mpMetric">${Object.keys(MAP_METRICS).map(k => `<option value="${k}">${MAP_METRICS[k].label}</option>`).join('')}</select></label>
          <label id="mpSliceL" hidden><span id="mpSliceN"></span> <select id="mpSlice"></select></label></div>
        <canvas id="mpChart" title="Hover for values, click to show that variant in the main view"></canvas>
        <div id="mpSum"></div>
      </div>
      <div class="map-table" id="mpTable"></div>
    </div>`;
    for (const n of [0, 1, 2]) if ($('mpP' + n)) { $('mpP' + n).onchange = () => mapDefaults(n); mapDefaults(n); $('mpN' + n).oninput = mapCount; }
    if ($('mpUse2')) {
      const sync = () => { $('mpR2').hidden = $('mpI2').hidden = !$('mpUse2').checked; $('mpP2').disabled = !$('mpUse2').checked; mapCount(); };
      $('mpUse2').onchange = sync; sync();
    }
    // a parameter list from the demo: start on the diameter vs length example
    const iD = ST.params.findIndex(p => p.name === 'outer_d'), iL = ST.params.findIndex(p => p.name === 'length');
    if (iD >= 0 && iL >= 0 && !MP.spec) { $('mpP0').value = iD; $('mpP1').value = iL; mapDefaults(0); mapDefaults(1);
      $('mpLo0').value = 90; $('mpHi0').value = 130; $('mpLo1').value = 30; $('mpHi1').value = 60; }
    if (MP.spec) MP.spec.axes.forEach((a, n) => {
      const i = ST.params.findIndex(p => p.name === a.p.name);
      if (i >= 0 && $('mpP' + n)) { $('mpP' + n).value = i; mapDefaults(n); $('mpLo' + n).value = a.lo; $('mpHi' + n).value = a.hi; $('mpN' + n).value = a.n; }
      if (n === 2 && $('mpUse2')) { $('mpUse2').checked = true; $('mpUse2').onchange(); }
    });
    $('mpView').value = MP.view;
    $('mpView').onchange = () => { MP.view = $('mpView').value; mapControls(); drawMap(); };
    $('mpMetric').onchange = () => drawMap();
    $('mpSlice').onchange = () => { MP.slice = +$('mpSlice').value; drawMap(); };
    mapCount();
    $('mpRun').disabled = MP.running; $('mpStop').disabled = !MP.running;
    mapControls();
    renderMapResults();
  }

  /** Show the colour and slice pickers that apply to the current plot. */
  function mapControls() {
    if (!$('mpView')) return;
    const sp = MP.spec, three = sp && sp.axes.length === 3;
    $('mpMetricL').hidden = MP.view === 'lines';
    $('mpMetricL').firstChild.textContent = MP.view === 'scatter' ? 'Colour by ' : 'Colour ';
    if (MP.view === 'scatter') {
      $('mpMetric').innerHTML = (sp ? sp.axes : []).map((a, n) => `<option value="ax${n}">${esc(a.p.name)}</option>`).join('');
    } else if (!$('mpMetric').querySelector('option[value=force]')) {
      $('mpMetric').innerHTML = Object.keys(MAP_METRICS).map(k => `<option value="${k}">${MAP_METRICS[k].label}</option>`).join('');
    }
    $('mpSliceL').hidden = !(three && MP.view !== 'scatter');
    if (three) {
      const a = sp.axes[2];
      $('mpSliceN').textContent = a.p.name;
      $('mpSlice').innerHTML = a.grid.map((x, i) => `<option value="${i}"${i === MP.slice ? ' selected' : ''}>${FS.expr(x, a.p.unit)}</option>`).join('');
    }
  }

  function readMapAxis(n) {
    const p = ST.params[+$('mpP' + n).value];
    const lo = parseFloat($('mpLo' + n).value), hi = parseFloat($('mpHi' + n).value), k = Math.round(parseFloat($('mpN' + n).value));
    if (!(hi > lo)) return `${p.name}: min must be below max.`;
    if (!(k >= 2 && k <= 21)) return `${p.name}: use 2 to 21 steps.`;
    return { p, lo, hi, n: k, grid: FS.grid(lo, hi, k, false).map(x => +x.toPrecision(6)) };
  }

  async function runMap() {
    if (MP.running) return;
    const msg = (m, kind) => { if ($('mpProg')) $('mpProg').textContent = m; status(m, kind == null ? 'err' : kind); };
    if (ST.running) return msg('An Optimize study is running. Wait for it or stop it first.');
    if (!S.geo || !S.prob) return msg('Load a design and set it up first.');
    if (!S.prob.coilAreaM2) return msg('Set up the coil window first.');
    if (!S.prob.gaps.some(g => g.torque)) return msg('No torque gap: set rotor/stator roles first.');
    const axes = [readMapAxis(0), readMapAxis(1)];
    if ($('mpUse2') && $('mpUse2').checked) axes.push(readMapAxis(2));
    const bad = axes.find(a => typeof a === 'string');
    if (bad) return msg(bad);
    if (new Set(axes.map(a => a.p.name)).size !== axes.length) return msg('Pick different parameters on each axis.');
    const combos = FS.factorial(axes.map(a => a.grid));
    if (combos.length > MAP_MAX_RUNS) return msg(`${combos.length} combinations: keep it to ${MAP_MAX_RUNS} or fewer (fewer steps).`);
    const cons = $('mpLim').checked ? { Pmax: P.Pmax, Jmax: P.Jmax } : {};
    MP.spec = { axes, V: P.V, swg: P.swg, cons, rForce: P.rForce, ratio: P.ratio };
    MP.pts = []; MP.slice = 0; MP.running = true; MP.stop = false;
    if (ST.preview == null) ST.baseGeo = S.geo;
    ST.frame = S.geo.axis && S.geo.axis.origin ? { origin: S.geo.axis.origin, dir: S.geo.axis.dir } : null;
    ST.angle = parseFloat($('angle').value) || 0;
    const setup = snapshotSetup();
    if (!ST.compute) ST.compute = window.ferraCompute(F);
    const ctx = { F, FI, FM, P: Object.assign({}, P), mat: S.mat, compute: ST.compute, classify, point: null, line: null,
      base: { bodies: setup.bodies, gaps: setup.gaps, coilPicks: setup.coilPicks, coilBox: setup.coilBox, overlaps: setup.overlaps } };
    $('mpRun').disabled = true; $('mpStop').disabled = false;
    mapControls();
    const t0 = Date.now();
    let restoreMsg = '';
    try {
      for (let k = 0; k < combos.length && !MP.stop; k++) {
        const v = combos[k];
        const eta = k ? ` · about ${fmtDur((Date.now() - t0) / 1000 / k * (combos.length - k))} left` : '';
        const label = `Run ${k + 1}/${combos.length}: ${axes.map((a, n) => `${a.p.name} = ${FS.expr(v[n], a.p.unit)}`).join(', ')}${eta}`;
        if ($('mpProg')) $('mpProg').textContent = label;
        status(label, 'busy');
        const pt = { k: k + 1, v };
        try {
          const r = await cad.evalPoint(axes.map((a, n) => [a.p, v[n]]));
          if (!r.ok) { MP.stop = true; throw new Error(r.error || 'CAD update failed'); }
          if (!r.feasible) { pt.status = 'cad'; pt.reason = r.errors.join('; '); }
          else {
            Object.assign(pt, await FS.evaluateGeometry(ctx, r.geometry, r.massKg));
            if (pt.status === 'ok') { pt.geo = r.geometry; pt.violations = FS.violations(pt.metrics, cons); }
          }
        } catch (e) { pt.status = 'error'; pt.reason = String((e && e.message) || e).split('\n')[0]; }
        MP.pts.push(pt);
        renderMapResults();
      }
    } catch (e) { fail(e); } finally {
      try {
        const r = await cad.restore();
        if (!r.ok) restoreMsg = 'Could not restore parameters: ' + (r.errors || [r.error]).join('; ');
      } catch (e) { restoreMsg = 'Could not restore parameters: ' + (e.message || e); }
      MP.running = false;
      if ($('mpRun')) { $('mpRun').disabled = false; $('mpStop').disabled = true; }
      renderMapResults();
      msg(restoreMsg || (MP.stop ? 'Design map stopped. Parameters restored.' : `Design map done (${MP.pts.length} runs). Parameters restored.`), restoreMsg ? 'err' : '');
    }
  }

  const mpOk = p => p.status === 'ok' && p.metrics && p.metrics.Fkgf != null;
  const mpLabel = v => MP.spec.axes.map((a, n) => `${a.p.name} = ${FS.expr(v[n], a.p.unit)}`).join(', ');
  const sameV = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));

  function renderMapResults() {
    if (!$('mpTable')) return;
    const sp = MP.spec;
    if (!sp) { $('mpTable').innerHTML = ''; $('mpSum').innerHTML = ''; drawMap(); return; }
    const ok = MP.pts.filter(mpOk);
    const front = new Set(FS.pareto(ok.map(p => ({ x: p.metrics.steelMassKg, y: p.metrics.Fkgf, p }))).map(q => q.p));
    const stat = p => p.status === 'ok' ? (p.violations.length ? `<span class="warn">over limit: ${esc(p.violations.join(', '))}</span>` : (p.metrics.converged ? 'ok' : '<span class="warn">not fully converged</span>'))
      : p.status === 'cad' ? `<span class="warn">CAD: ${esc(p.reason)}</span>` : `<span class="warn">${esc(p.reason || 'failed')}</span>`;
    $('mpTable').innerHTML = MP.pts.length ? `<table><thead><tr>${sp.axes.map(a => `<th>${esc(a.p.name)}${a.p.unit ? ', ' + esc(a.p.unit) : ''}</th>`).join('')}
      <th>Force, kgf</th><th>Torque, N·m</th><th>Steel, kg</th><th>Total, kg</th><th>kgf per kg steel</th><th>I, A</th><th>P, W</th><th>Steel B98, T</th><th class="l">Status</th></tr></thead><tbody>${
      MP.pts.map(p => { const m = p.metrics || {}; return `<tr data-mk="${p.k}" class="${front.has(p) ? 'best' : ''} ${ST.preview === 'map:' + p.k ? 'prev' : ''}" title="Click to show this variant in the main view">
        ${p.v.map(x => `<td>${fmt(x, 3)}</td>`).join('')}<td>${fmt(m.Fkgf, 2)}</td><td>${fmt(m.T, 3)}</td><td>${fmt(m.steelMassKg, 3)}</td><td>${fmt(m.massKg, 3)}</td>
        <td>${fmt(MAP_METRICS.forcePerSteelKg.get(m), 2)}</td><td>${fmt(m.I, 2)}</td><td>${fmt(m.P, 1)}</td><td>${fmt(m.steelB98, 2)}</td><td class="l">${stat(p)}</td></tr>`; }).join('')
    }</tbody></table><p class="note">Green rows are the lightest designs for their force (no other run gives more force with less steel).</p>` : '';
    let html = '';
    if (ok.length) {
      const big = ok.reduce((b, p) => (p.metrics.Fkgf > b.metrics.Fkgf ? p : b));
      const eff = ok.reduce((b, p) => (MAP_METRICS.forcePerSteelKg.get(p.metrics) > MAP_METRICS.forcePerSteelKg.get(b.metrics) ? p : b));
      html += `<p><strong>Most force:</strong> ${esc(mpLabel(big.v))} → ${fmt(big.metrics.Fkgf, 1)} kgf with ${fmt(big.metrics.steelMassKg, 2)} kg steel</p>
        <p><strong>Most force per kg of steel:</strong> ${esc(mpLabel(eff.v))} → ${fmt(eff.metrics.Fkgf, 1)} kgf, ${fmt(eff.metrics.steelMassKg, 2)} kg (${fmt(MAP_METRICS.forcePerSteelKg.get(eff.metrics), 1)} kgf/kg)</p>`;
    }
    const failed = MP.pts.length - ok.length;
    if (failed) html += `<p class="warn">${failed} combination(s) could not be built or solved (see Status).</p>`;
    html += `<div class="row">${ST.preview != null ? '<button data-mact="back">Back to the current design</button>' : ''}${MP.pts.length ? '<button data-mact="csv">Export CSV</button>' : ''}</div>`;
    html += `<p class="note">At ${sp.V} V, ${esc(String((F.wireList(P.wire).find(o => o.key === sp.swg) || {}).name || sp.swg))}; force at r = ${sp.rForce} mm${sp.ratio !== 1 ? ` × ${sp.ratio}` : ''}.</p>`;
    $('mpSum').innerHTML = html;
    drawMap();
  }

  function mapValue(p, key) {
    if (!mpOk(p)) return null;
    const v = MAP_METRICS[key].get(p.metrics);
    return v != null && isFinite(v) ? v : null;
  }

  function drawMap() {
    const c = $('mpChart');
    if (!c) return;
    const g = c.getContext('2d'), dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    c.width = W * dpr; c.height = H * dpr; g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    MP.hits = [];
    const col = chartColors();
    g.font = '10.5px sans-serif'; g.fillStyle = col.ink;
    if (!MP.spec) { g.fillText('Results of the design map appear here.', 10, 20); return; }
    if (MP.view === 'scatter') drawMapScatter(g, W, H, col);
    else if (MP.view === 'lines') drawMapLines(g, W, H, col);
    else drawMapHeat(g, W, H, col);
  }

  /** Points of the current 2-D slice (third axis at the chosen value). */
  function slicePts() {
    const sp = MP.spec;
    if (sp.axes.length < 3) return MP.pts;
    const z = sp.axes[2].grid[Math.min(MP.slice, sp.axes[2].grid.length - 1)];
    return MP.pts.filter(p => sameV(p.v[2], z));
  }

  const axisName = a => `${a.p.name}${a.p.unit ? ', ' + a.p.unit : ''}`;
  const tick = x => +(+x).toPrecision(3) + '';

  function drawMapHeat(g, W, H, col) {
    const sp = MP.spec, [A, Bx] = sp.axes, key = MAP_METRICS[$('mpMetric').value] ? $('mpMetric').value : 'force', M = MAP_METRICS[key], pts = slicePts();
    const L = 50, R = 62, T = 24, B = 30;
    const sx = x => L + (x - A.lo) / (A.hi - A.lo) * (W - L - R), sy = y => H - B - (y - Bx.lo) / (Bx.hi - Bx.lo) * (H - B - T);
    const vals = pts.map(p => mapValue(p, key)).filter(v => v != null);
    let v0 = vals.length ? Math.min(...vals) : 0, v1 = vals.length ? Math.max(...vals) : 1;
    if (v1 - v0 < 1e-12) v1 = v0 + 1e-12;
    const t01 = v => (v - v0) / (v1 - v0);
    const edges = gr => gr.map((x, i) => [i ? 0.5 * (gr[i - 1] + x) : x, i < gr.length - 1 ? 0.5 * (x + gr[i + 1]) : x]);
    const ex = edges(A.grid), ey = edges(Bx.grid);
    A.grid.forEach((x, i) => Bx.grid.forEach((y, j) => {
      const p = pts.find(q => sameV(q.v[0], x) && sameV(q.v[1], y));
      const X0 = sx(ex[i][0]), X1 = sx(ex[i][1]), Y0 = sy(ey[j][1]), Y1 = sy(ey[j][0]);
      const w = Math.max(1, X1 - X0), h = Math.max(1, Y1 - Y0);
      if (!p) { g.strokeStyle = col.line; g.lineWidth = 1; g.strokeRect(X0 + 0.5, Y0 + 0.5, w - 1, h - 1); return; }
      const v = mapValue(p, key);
      if (v == null) {
        g.fillStyle = col.line; g.fillRect(X0, Y0, w + 0.5, h + 0.5);
        const cx = (X0 + X1) / 2, cy = (Y0 + Y1) / 2;
        g.strokeStyle = col.warn; g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(cx - 4, cy - 4); g.lineTo(cx + 4, cy + 4); g.moveTo(cx + 4, cy - 4); g.lineTo(cx - 4, cy + 4); g.stroke();
      } else {
        g.fillStyle = rgb(ramp(VIRIDIS, t01(v))); g.fillRect(X0, Y0, w + 0.5, h + 0.5);
        if (p.violations && p.violations.length) {
          g.save(); g.beginPath(); g.rect(X0, Y0, w, h); g.clip();
          g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = 1;
          for (let t = -h; t < w; t += 6) { g.beginPath(); g.moveTo(X0 + t, Y1); g.lineTo(X0 + t + h, Y0); g.stroke(); }
          g.restore();
        }
        // cell label: the colour metric and, for force, the steel mass under it
        if (w > 44 && h > 24) {
          g.fillStyle = t01(v) > 0.6 ? '#10141a' : '#ffffff';
          const l1 = fmt(v, M.d), l2 = key === 'force' || key === 'torque' ? `${fmt(p.metrics.steelMassKg, 2)} kg` : `${fmt(p.metrics.Fkgf, 1)} kgf`;
          g.font = '600 11px sans-serif'; g.fillText(l1, (X0 + X1) / 2 - g.measureText(l1).width / 2, (Y0 + Y1) / 2 - 1);
          g.font = '10px sans-serif'; g.fillText(l2, (X0 + X1) / 2 - g.measureText(l2).width / 2, (Y0 + Y1) / 2 + 11);
        }
      }
      MP.hits.push({ rect: [X0, Y0, w, h], k: p.k });
    }));
    g.font = '10.5px sans-serif'; g.fillStyle = col.ink;
    const ticks = gr => gr.filter((_, i) => gr.length <= 7 || i % Math.ceil(gr.length / 7) === 0 || i === gr.length - 1);
    ticks(A.grid).forEach(x => { const s = tick(x); g.fillText(s, sx(x) - g.measureText(s).width / 2, H - B + 13); });
    ticks(Bx.grid).forEach(y => { const s = tick(y); g.fillText(s, L - 6 - g.measureText(s).width, sy(y) + 3); });
    const xl = axisName(A); g.fillText(xl, W - R - g.measureText(xl).width, H - 4);
    g.fillText(axisName(Bx), 4, 11);
    const cbX = W - R + 14, cbH = H - B - T;
    for (let t = 0; t < cbH; t++) { g.fillStyle = rgb(ramp(VIRIDIS, 1 - t / cbH)); g.fillRect(cbX, T + t, 10, 1.2); }
    g.fillStyle = col.ink;
    g.fillText(tick(v1), cbX + 13, T + 8); g.fillText(tick(v0), cbX + 13, T + cbH);
    g.save(); g.translate(W - 4, T + cbH / 2); g.rotate(-Math.PI / 2);
    const ol = `${M.label}, ${M.unit}`; g.fillText(ol, -g.measureText(ol).width / 2, 0); g.restore();
  }

  function drawMapScatter(g, W, H, col) {
    const sp = MP.spec, ok = MP.pts.filter(p => mpOk(p) && p.metrics.steelMassKg > 0);
    const cAx = Math.max(0, Math.min(sp.axes.length - 1, +(($('mpMetric').value || 'ax0').slice(2)) || 0)), CA = sp.axes[cAx];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    ok.forEach(p => { x0 = Math.min(x0, p.metrics.steelMassKg); x1 = Math.max(x1, p.metrics.steelMassKg); y0 = Math.min(y0, p.metrics.Fkgf); y1 = Math.max(y1, p.metrics.Fkgf); });
    if (!ok.length) { g.fillText('No solved runs yet.', 10, 20); return; }
    if (x1 - x0 < 1e-9) { x0 *= 0.95; x1 = x1 * 1.05 + 1e-6; }
    if (y1 - y0 < 1e-9) { y0 *= 0.95; y1 = y1 * 1.05 + 1e-6; }
    const px = 0.06 * (x1 - x0), py = 0.08 * (y1 - y0); x0 -= px; x1 += px; y0 -= py; y1 += py;
    const L = 50, R = 96, T = 18, B = 30;
    const sx = x => L + (x - x0) / (x1 - x0) * (W - L - R), sy = y => H - B - (y - y0) / (y1 - y0) * (H - B - T);
    g.strokeStyle = col.line; g.lineWidth = 1; g.fillStyle = col.ink;
    for (let k = 0; k <= 4; k++) {
      const y = y0 + (y1 - y0) * k / 4, x = x0 + (x1 - x0) * k / 4;
      g.beginPath(); g.moveTo(L, sy(y)); g.lineTo(W - R, sy(y)); g.stroke();
      g.fillText(tick(y), 4, sy(y) + 3);
      const s = tick(x); g.fillText(s, sx(x) - g.measureText(s).width / 2, H - B + 13);
    }
    g.fillText('Brake force, kgf', L, 11);
    const xl = 'Steel mass, kg'; g.fillText(xl, W - R - g.measureText(xl).width, H - 4);
    // frontier: most force for the least steel
    const front = FS.pareto(ok.map(p => ({ x: p.metrics.steelMassKg, y: p.metrics.Fkgf, p })));
    g.strokeStyle = col.ok; g.lineWidth = 1.6; g.setLineDash([5, 4]); g.beginPath();
    front.forEach((q, k) => (k ? g.lineTo(sx(q.x), sy(q.y)) : g.moveTo(sx(q.x), sy(q.y)))); g.stroke(); g.setLineDash([]);
    const tc = x => (CA.hi > CA.lo ? (x - CA.lo) / (CA.hi - CA.lo) : 0.5);
    for (const p of ok) {
      const X = sx(p.metrics.steelMassKg), Y = sy(p.metrics.Fkgf);
      g.beginPath(); g.arc(X, Y, 5, 0, 2 * Math.PI);
      g.fillStyle = rgb(ramp(VIRIDIS, tc(p.v[cAx]))); g.fill();
      g.strokeStyle = p.violations && p.violations.length ? col.warn : 'rgba(0,0,0,0.35)'; g.lineWidth = p.violations && p.violations.length ? 1.6 : 0.8; g.stroke();
      MP.hits.push({ x: X, y: Y, r: 7, k: p.k });
    }
    // colour key
    const cbX = W - R + 16, cbH = H - B - T;
    for (let t = 0; t < cbH; t++) { g.fillStyle = rgb(ramp(VIRIDIS, 1 - t / cbH)); g.fillRect(cbX, T + t, 10, 1.2); }
    g.fillStyle = col.ink;
    g.fillText(tick(CA.hi), cbX + 13, T + 8); g.fillText(tick(CA.lo), cbX + 13, T + cbH);
    g.save(); g.translate(W - 6, T + cbH / 2); g.rotate(-Math.PI / 2);
    const ol = axisName(CA); g.fillText(ol, -g.measureText(ol).width / 2, 0); g.restore();
    g.fillStyle = col.ok; g.fillText('-- lightest for its force', L + 6, T + 12);
  }

  function drawMapLines(g, W, H, col) {
    const sp = MP.spec, [A, Bx] = sp.axes, pts = slicePts().filter(mpOk);
    if (!pts.length) { g.fillText('No solved runs yet.', 10, 20); return; }
    let y0 = Math.min(...pts.map(p => p.metrics.Fkgf)), y1 = Math.max(...pts.map(p => p.metrics.Fkgf));
    if (y1 - y0 < 1e-9) { y0 *= 0.95; y1 = y1 * 1.05 + 1e-6; }
    const py = 0.08 * (y1 - y0); y0 -= py; y1 += py;
    const L = 50, R = 110, T = 18, B = 30;
    const sx = x => L + (x - A.lo) / (A.hi - A.lo) * (W - L - R), sy = y => H - B - (y - y0) / (y1 - y0) * (H - B - T);
    g.strokeStyle = col.line; g.lineWidth = 1; g.fillStyle = col.ink;
    for (let k = 0; k <= 4; k++) {
      const y = y0 + (y1 - y0) * k / 4, x = A.lo + (A.hi - A.lo) * k / 4;
      g.beginPath(); g.moveTo(L, sy(y)); g.lineTo(W - R, sy(y)); g.stroke();
      g.fillText(tick(y), 4, sy(y) + 3);
      const s = tick(x); g.fillText(s, sx(x) - g.measureText(s).width / 2, H - B + 13);
    }
    g.fillText('Brake force, kgf', L, 11);
    const xl = axisName(A); g.fillText(xl, W - R - g.measureText(xl).width, H - 4);
    Bx.grid.forEach((y, j) => {
      const line = pts.filter(p => sameV(p.v[1], y)).sort((a, b) => a.v[0] - b.v[0]);
      const c = rgb(ramp(VIRIDIS, Bx.grid.length > 1 ? j / (Bx.grid.length - 1) : 0.5));
      g.strokeStyle = c; g.lineWidth = 2; g.beginPath();
      line.forEach((p, k) => (k ? g.lineTo(sx(p.v[0]), sy(p.metrics.Fkgf)) : g.moveTo(sx(p.v[0]), sy(p.metrics.Fkgf)))); g.stroke();
      line.forEach(p => {
        const X = sx(p.v[0]), Y = sy(p.metrics.Fkgf);
        g.fillStyle = c; g.beginPath(); g.arc(X, Y, 3.5, 0, 2 * Math.PI); g.fill();
        MP.hits.push({ x: X, y: Y, r: 7, k: p.k });
      });
      g.fillStyle = c; g.fillRect(W - R + 12, T + 4 + j * 15, 12, 3);
      g.fillStyle = col.ink; g.fillText(`${FS.expr(y, Bx.p.unit)}`, W - R + 28, T + 9 + j * 15);
    });
    g.fillStyle = col.ink; g.fillText(Bx.p.name, W - R + 12, T - 4);
  }

  function mapHit(ev) {
    const rc = ev.target.getBoundingClientRect(), x = ev.clientX - rc.left, y = ev.clientY - rc.top;
    return MP.hits.find(t => (t.rect ? x >= t.rect[0] && x <= t.rect[0] + t.rect[2] && y >= t.rect[1] && y <= t.rect[1] + t.rect[3]
      : Math.hypot(x - t.x, y - t.y) <= t.r));
  }

  function previewMap(k) {
    const p = MP.pts.find(z => z.k === k);
    if (!p || !p.geo) return;
    if (ST.preview == null) ST.baseGeo = S.geo;
    ST.preview = 'map:' + k;
    loadGeometry(p.geo, { carry: true, label: `preview ${mpLabel(p.v)} (CAD unchanged)` });
    renderMapResults();
  }

  function exportMapCSV() {
    const sp = MP.spec;
    if (!sp || !MP.pts.length) return;
    const head = ['run'].concat(sp.axes.map(a => `${a.p.name} (${a.p.unit || '-'})`), ['force_kgf', 'torque_Nm', 'steel_mass_kg', 'steel_mass_source', 'total_mass_kg',
      'force_per_steel_kg', 'NI_At', 'turns', 'I_A', 'R_ohm', 'P_W', 'J_Amm2', 'steel_B98_T', 'steel_B98_body', 'flux_util', 'gap_B_T', 'status']);
    const q = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const rows = MP.pts.map(p => {
      const m = p.metrics || {};
      const st = p.status === 'ok' ? (p.violations.length ? 'over limit: ' + p.violations.join('; ') : 'ok') : p.status + ': ' + (p.reason || '');
      return [p.k].concat(p.v, [m.Fkgf, m.T, m.steelMassKg, m.steelMassSource, m.massKg, MAP_METRICS.forcePerSteelKg.get(m), m.NI, m.N, m.I, m.R, m.P, m.J,
        m.steelB98, m.steelB98Body, m.util, m.Bg, st]).map(q).join(',');
    });
    saveText(`${(S.geo && S.geo.source || 'brake').replace(/[^\w.-]+/g, '_')}_${sp.axes.map(a => a.p.name).join('_x_')}_map.csv`, [head.join(',')].concat(rows).join('\n'), 'CSV (*.csv)');
  }

  const mpTip = document.createElement('div');
  mpTip.id = 'mpTip';
  document.body.appendChild(mpTip);
  $('tab-map').addEventListener('mousemove', ev => {
    if (ev.target.id !== 'mpChart') { mpTip.style.display = 'none'; return; }
    const h = mapHit(ev), p = h && MP.pts.find(z => z.k === h.k);
    if (!p) { mpTip.style.display = 'none'; return; }
    const m = p.metrics || {};
    mpTip.textContent = MP.spec.axes.map((a, n) => `${a.p.name} = ${FS.expr(p.v[n], a.p.unit)}`).join('\n') + '\n' +
      (mpOk(p) ? `Force ${fmt(m.Fkgf, 2)} kgf  ·  torque ${fmt(m.T, 3)} N·m\nSteel ${fmt(m.steelMassKg, 3)} kg  ·  ${fmt(MAP_METRICS.forcePerSteelKg.get(m), 1)} kgf/kg\n${fmt(m.I, 2)} A, ${fmt(m.P, 1)} W` : (p.reason || 'failed'));
    mpTip.style.display = 'block';
    mpTip.style.left = Math.min(window.innerWidth - mpTip.offsetWidth - 8, ev.clientX + 14) + 'px';
    mpTip.style.top = Math.min(window.innerHeight - mpTip.offsetHeight - 8, ev.clientY + 14) + 'px';
  });
  $('tab-map').addEventListener('mouseleave', () => { mpTip.style.display = 'none'; });
  $('tab-map').addEventListener('click', ev => {
    if (ev.target.id === 'mpChart') { const h = mapHit(ev); if (h) previewMap(h.k); return; }
    const b = ev.target.closest('[data-mact]');
    if (b) {
      const act = b.dataset.mact;
      if (act === 'load') loadParams();
      else if (act === 'run') runMap();
      else if (act === 'stop') { MP.stop = true; status('Stopping after this run…', 'busy'); }
      else if (act === 'back') { backToBase(); renderMapResults(); }
      else if (act === 'csv') exportMapCSV();
      return;
    }
    const tr = ev.target.closest('tr[data-mk]');
    if (tr) previewMap(+tr.dataset.mk);
  });
  window.addEventListener('resize', () => { if (!$('tab-map').hidden) drawMap(); });

  // ------------------------------------------------------------------ response: inductance, switching, rotor inertia
  const fmtT = s => (s == null || !isFinite(s) ? '–' : s < 1e-3 ? `${(s * 1e6).toFixed(0)} µs` : s < 1 ? `${(s * 1e3).toFixed(s < 0.01 ? 2 : s < 0.1 ? 1 : 0)} ms` : `${s.toFixed(2)} s`);
  const fmtL = L => (!(L > 0) ? '–' : L >= 1 ? `${L.toFixed(2)} H` : `${(L * 1e3).toFixed(L < 0.01 ? 2 : 0)} mH`);

  function sweepCurve() {
    const pts = S.sweep.pts;
    return FX.curve(pts, pts.map(p => F.torqueFromStats(S.prob, p.stats, tp()).total));
  }

  function rotorInertiaNow() {
    if (!S.G || !S.meta.length) return null;
    return FX.rotorInertia(S.G, b => S.meta[b] && S.meta[b].role === 'rotor' && S.meta[b].cls !== 'coil',
      b => FM.thermalOf(S.meta[b].cls, S.meta[b].material).rho);
  }

  function renderResponse() {
    const kv = $('respKV'), note = $('respNote');
    S.resp = null;
    if (!S.sweep || !S.prob || !S.prob.coilAreaM2) {
      kv.innerHTML = ''; drawResponse(null);
      note.textContent = S.prob && S.prob.coilAreaM2 ? 'Appears after the field sweep.' : 'Needs a coil window.';
      return;
    }
    const e = elec(), c = sweepCurve();
    const L = FX.inductance(c, e.N, e.NI);
    const r = FX.response(c, { N: e.N, R: e.R, V: P.V, Ilim: P.Ilim, Voff: P.Voff });
    const J = rotorInertiaNow(), w = P.rpm * 2 * Math.PI / 60;
    const tStop = J && J.J > 0 && r.Tf > 0 && w > 0 ? J.J * w / r.Tf : null;
    S.resp = { L, r, J, tStop };
    kv.innerHTML = [
      ['Inductance (operating point)', fmtL(L.Lsec)],
      ['Incremental / unsaturated L', `${fmtL(L.Linc)} / ${fmtL(L.L0)}`],
      ['Time constant L₀/R', fmtT(r.tauLin)],
      ['On → 90 % torque', `${fmtT(r.tOn90)} <span class="note">(current ${fmtT(r.tOn90I)})</span>`],
      ['Off → 10 % torque', `${fmtT(r.tOff10)} <span class="note">${P.Voff} V clamp</span>`],
      ['Switch sees at turn-off', `${fmt(P.V + P.Voff, 1)} V`],
      J && J.J > 0 ? ['Rotor inertia', `${fmt(J.J * 1e6, 0)} kg·mm² <span class="note">(${fmt(J.mass, 2)} kg)</span>`] : null,
      tStop != null ? [`Rotor stops from ${P.rpm} rpm`, fmtT(tStop)] : null
    ].filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    note.textContent = 'Static flux curve, no eddy currents: solid steel poles slow both edges, often 2–5×. ' +
      `Turn-off assumes the coil freewheels into a ${P.Voff} V clamp (0.7 V = diode; a Zener or TVS is faster). Rotor inertia from the section, rotor bodies only.`;
    drawResponse(r);
  }

  function drawResponse(r) {
    const c = $('respChart'), g = c.getContext('2d'), dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    c.width = W * dpr; c.height = H * dpr; g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!r || !(r.Tf > 0)) return;
    const col = chartColors(), tOn = r.on[r.on.length - 1][0], tOff = r.off[r.off.length - 1][0];
    const tm = Math.max(tOn, tOff) * 1.05 || 1, L = 30, B = 18, R = 8, T = 6;
    const sx = t => L + t / tm * (W - L - R), sy = y => H - B - y * (H - B - T);
    g.strokeStyle = col.line; g.lineWidth = 1; g.fillStyle = col.ink; g.font = '10px sans-serif';
    [0, 0.5, 1].forEach(y => { g.beginPath(); g.moveTo(L, sy(y)); g.lineTo(W - R, sy(y)); g.stroke(); g.fillText(`${(100 * y).toFixed(0)}%`, 2, sy(y) + 3); });
    g.fillText('0', L - 2, H - 5); g.fillText(fmtT(tm), W - R - 40, H - 5);
    const trace = (pts, colr) => {
      g.strokeStyle = colr; g.lineWidth = 2; g.beginPath();
      pts.forEach(([t, Tq], k) => (k ? g.lineTo(sx(t), sy(Tq / r.Tf)) : g.moveTo(sx(t), sy(Tq / r.Tf))));
      g.stroke();
    };
    trace(r.on, col.cop); trace(r.off, col.ink);
    g.fillStyle = col.cop; g.fillText('on', Math.min(sx(tOn) + 4, W - R - 16), sy(r.on[r.on.length - 1][1] / r.Tf) + 12);
    g.fillStyle = col.ink; g.fillText('off', sx(tOff * 0.35) + 4, sy(0.75));
  }

  // ------------------------------------------------------------------ calibration fit (Model settings)
  function parseCal(text) {
    const rows = [];
    for (const line of String(text || '').split(/\r?\n/)) {
      const n = line.trim().split(/[\s,;\t]+/).map(Number).filter(x => isFinite(x));
      if (n.length >= 2 && n[0] > 0 && n[1] > 0) rows.push({ I: n[0], kgf: n[1] });
    }
    return rows;
  }

  function calibrate() {
    S.calText = $('calText').value;
    const rows = parseCal(S.calText), out = $('calOut');
    S.calFit = null; $('btnCalApply').hidden = true;
    if (!rows.length) { out.innerHTML = 'Enter at least one line: coil current (A), measured force (kgf).'; return; }
    if (!S.sweep) { out.innerHTML = 'Wait for the field solve to finish.'; return; }
    const N = elec().N, toT = kgf => kgf * G0 * (P.rForce * 1e-3) / P.ratio;
    const meas = rows.map(r => ({ NI: N * r.I, T: toT(r.kgf), I: r.I, kgf: r.kgf }));
    const NIs = [0].concat(S.sweep.pts.map(p => p.NI));
    const model = t => ({ NIs, Ts: [0].concat(S.sweep.pts.map(p => F.torqueFromStats(S.prob, p.stats, t).total)) });
    const fit = FX.fitShear(model, meas, P.Bs);
    if (!fit) { out.innerHTML = 'No usable rows.'; return; }
    const cur = model(tp()), errNow = meas.map(m => FX.interp(cur.NIs, cur.Ts, m.NI) / m.T - 1);
    const rmsNow = Math.sqrt(errNow.reduce((s, x) => s + x * x, 0) / errNow.length);
    const beyond = meas.some(m => m.NI > S.sweep.NImax);
    const k2f = T => T * P.ratio / (P.rForce * 1e-3) / G0;
    S.calFit = fit;
    out.innerHTML = `<p><strong>τ<sub>sat</sub> = ${fmt(fit.tauSat / 1e3, 1)} kPa, B<sub>s</sub> = ${fmt(fit.Bs, 3)} T</strong>${fit.fitBs ? '' : ' (B<sub>s</sub> kept: one current level)'} ·
      rms error ${fmt(100 * fit.rms, 1)} % (now ${fmt(100 * rmsNow, 1)} %)</p>
      <table class="mini"><thead><tr><th>I, A</th><th>NI, A-t</th><th>Measured, kgf</th><th>Fit, kgf</th><th>Error</th></tr></thead><tbody>${
      fit.rows.map((r, k) => `<tr><td>${fmt(meas[k].I, 2)}</td><td>${fmt(r.NI, 0)}</td><td>${fmt(meas[k].kgf, 1)}</td><td>${fmt(k2f(r.Tfit), 1)}</td><td>${pc(100 * r.err)} %</td></tr>`).join('')
      }</tbody></table>${fit.atEdge ? '<p class="flag">B<sub>s</sub> ran to the edge of its range (0.05–2.5 T): the points may not cover the bend of the curve, or the model shape does not fit.</p>' : ''}${
      beyond ? '<p class="flag">Some points are above the swept ampere-turns and use an extrapolated curve.</p>' : ''}${
      fit.fitBs && fit.rms > 0.08 ? '<p class="note">An error above about 8 % after fitting suggests the gap, the powder or the B-H data differ from the model, not just the shear constants.</p>' : ''}
      <p class="note">Uses ${N} turns, the force radius (${P.rForce} mm) and ratio (${P.ratio}). Measure at a steady temperature.</p>`;
    $('btnCalApply').hidden = false;
  }

  function applyCal() {
    if (!S.calFit) return;
    P.tauSat = +(S.calFit.tauSat / 1e3).toFixed(2);
    P.Bs = +S.calFit.Bs.toFixed(3);
    const keep = $('calOut').innerHTML;
    renderSettings();
    $('calOut').innerHTML = keep + `<p class="ok">Applied: τsat ${P.tauSat} kPa, Bs ${P.Bs} T.</p>`;
    invalidate('torque');
  }

  // ------------------------------------------------------------------ section-angle check
  const SEC = { running: false, runs: null, cmp: null, msg: '' };

  function renderSections() {
    const box = $('tab-sections');
    if (!box.firstChild) {
      box.innerHTML = `<div class="sections"><div class="row">
        <label>Extra angles from the current section <input id="secAngles" type="text" value="15, 30, 45, 60, 75" style="width:150px"> °</label>
        <label>Flag differences over <input type="number" id="secTol" value="5" step="1" min="1"> %</label>
        <button class="primary" id="btnSec">Check section angles</button><button id="btnSecBack" hidden>Back to the main section</button></div>
        <p class="note">The model assumes the brake is the same at every angle. Holes, bolts and slots break that; this re-cuts the design at other angles,
        solves each at the current supply voltage and wire, and flags angles whose torque or coil window differ.</p>
        <p id="secMsg" class="note"></p><div id="secOut"></div></div>`;
    }
    $('secMsg').textContent = SEC.msg;
    $('btnSecBack').hidden = ST.preview !== 'sec';
    $('btnSec').disabled = SEC.running;
    const cmp = SEC.cmp;
    if (!cmp) { $('secOut').innerHTML = ''; return; }
    const ok = cmp.rows.filter(r => r.status === 'ok'), mean = ok.length ? ok.reduce((s, r) => s + r.metrics.T, 0) / ok.length : null;
    const rows = cmp.rows.map((r, k) => {
      const m = r.metrics || {};
      return `<tr class="${r.flags.length ? 'flagrow' : ''}"><td>${fmt(r.angle, 0)}°${k === 0 ? ' (current)' : ''}</td>
        <td>${r.status === 'ok' ? fmt(m.T, 3) : '–'}</td><td>${r.dT != null ? pc(100 * r.dT) + ' %' : '–'}</td>
        <td>${fmt(m.Bg, 3)}</td><td>${m.util != null ? fmt(100 * m.util, 0) + ' %' : '–'}</td>
        <td>${fmt(m.steelB98, 2)}${m.steelB98Body ? ` <span class="note">${esc(m.steelB98Body)}</span>` : ''}</td><td>${fmt(m.coilAreaMM2, 0)}</td>
        <td class="l">${r.flags.length ? esc(r.flags.join('; ')) : '<span class="ok">ok</span>'}</td>
        <td>${r.geo ? `<button data-sec="${k}">View</button>` : ''}</td></tr>`;
    }).join('');
    const head = cmp.ok
      ? `<p class="ok"><strong>The section is representative:</strong> torque varies ${fmt(100 * cmp.spread, 1)} % across the angles checked.</p>`
      : `<p class="flag"><strong>The section depends on the angle</strong> (torque spread ${fmt(100 * (cmp.spread || 0), 1)} %). The 2-D model treats each cut as a full ring:
         a hole cut at one angle is modelled as a groove all the way round, so a flagged angle overstates that hole. For a repeating pattern
         (a bolt circle), average evenly spaced angles over one repeat (all angles here: ${fmt(mean, 3)} N·m). A single hole, such as a coil-lead
         exit, spans only a few degrees: analyse at an angle clear of it and use the flagged angle only to look for local saturation.</p>`;
    $('secOut').innerHTML = head + `<table><thead><tr><th>Angle</th><th>Torque, N·m</th><th>vs current</th><th>Gap B, T</th><th>Utilisation</th>
      <th>Steel B98, T</th><th>Coil window, mm²</th><th>Flags</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  async function sectionAt(angle) {
    if (inFusion()) {
      const frame = S.geo.axis && S.geo.axis.origin ? { origin: S.geo.axis.origin, dir: S.geo.axis.dir } : null;
      const g = JSON.parse(await fusion('extract', frame ? { frame, angle } : { axis: $('axis').value, angle }));
      if (!g.ok) throw new Error(g.error || 'extract failed');
      return g;
    }
    await sleep();
    return window.FERRA_DEMO_CAD.build(ST.mock, angle).geometry;
  }

  async function runSections() {
    if (SEC.running || ST.running) return;
    const say = m => { SEC.msg = m; renderSections(); };
    if (!S.geo || !S.prob) return say('Load a design first.');
    if (!S.prob.coilAreaM2 || !S.prob.gaps.some(g => g.torque)) return say('Set up the coil window and a torque gap first.');
    if (ST.preview != null) return say('Go back to the main section first.');
    if (!inFusion() && S.geo.source !== window.FERRA_DEMO.source) return say('Re-cutting at other angles needs Fusion (or the demo brake).');
    const extra = $('secAngles').value.split(/[\s,;]+/).map(Number).filter(x => isFinite(x) && x !== 0);
    if (!extra.length) return say('Enter one or more angles.');
    const tol = Math.max(0.5, parseFloat($('secTol').value) || 5) / 100;
    const base = parseFloat($('angle').value) || 0, angles = [0].concat(extra.slice(0, 12));
    const setup = snapshotSetup();
    if (!ST.compute) ST.compute = window.ferraCompute(F);
    const ctx = { F, FI, FM, P: Object.assign({}, P), mat: S.mat, compute: ST.compute, classify, point: null, line: null,
      base: { bodies: setup.bodies, gaps: setup.gaps, coilPicks: setup.coilPicks, coilBox: setup.coilBox, overlaps: setup.overlaps } };
    SEC.running = true; SEC.cmp = null;
    const runs = [];
    try {
      for (let k = 0; k < angles.length; k++) {
        const a = base + angles[k];
        say(`Section ${k + 1}/${angles.length} at ${a}°`); status(`Section check ${k + 1}/${angles.length}`, 'busy');
        const run = { angle: a };
        try {
          const geo = k === 0 ? S.geo : await sectionAt(a);
          Object.assign(run, await FS.evaluateGeometry(ctx, geo, null));
          run.geo = geo;
          run.bodies = geo.bodies.filter(b => b.polys && b.polys.length).map(b => (b.component && b.component !== b.name ? b.component + '/' : '') + b.name);
        } catch (e) { run.status = 'error'; run.reason = String((e && e.message) || e).split('\n')[0]; }
        runs.push(run);
      }
      SEC.runs = runs;
      SEC.cmp = FX.compareSections(runs, tol);
      SEC.msg = `Checked ${runs.length} angles.`;
      status('Ready');
    } finally { SEC.running = false; renderSections(); }
  }

  $('tab-sections').addEventListener('click', ev => {
    if (ev.target.id === 'btnSec') return runSections();
    if (ev.target.id === 'btnSecBack') { backToBase(); return renderSections(); }
    const b = ev.target.closest('[data-sec]');
    if (b && SEC.cmp) {
      const r = SEC.cmp.rows[+b.dataset.sec];
      if (!r.geo) return;
      if (r.geo === (ST.baseGeo && ST.preview != null ? ST.baseGeo : S.geo)) { backToBase(); return renderSections(); }
      if (ST.preview == null) ST.baseGeo = S.geo;
      ST.preview = 'sec';
      loadGeometry(r.geo, { carry: true, label: `section at ${r.angle}° (view only)` });
      renderSections();
    }
  });

  // ------------------------------------------------------------------ snapshots, comparison and report
  const SNAP_ROWS = [
    ['T', 'Torque', 'N·m', 3, 1], ['F', 'Force at radius', 'kgf', 1, 1], ['NI', 'Ampere-turns', 'A-t', 0, 1], ['N', 'Turns', '', 0, 0],
    ['I', 'Current', 'A', 2, 0], ['R', 'Resistance', 'Ω', 2, 0], ['P', 'Power', 'W', 1, -1], ['J', 'Current density', 'A/mm²', 2, -1],
    ['Tcoil', 'Steady coil temperature', '°C', 0, -1, '°C'], ['TperW', 'Torque per watt', 'N·m/W', 3, 1], ['util', 'Flux utilisation', '%', 0, 1, 'pt'],
    ['Bg', 'Mean gap B', 'T', 3, 1], ['steelB98', 'Highest steel B98', 'T', 2, 0], ['L', 'Inductance', 'mH', 0, 0],
    ['tOn', 'Switch-on to 90 %', 'ms', 1, -1], ['tOff', 'Switch-off to 10 %', 'ms', 1, -1], ['Jrot', 'Rotor inertia', 'kg·mm²', 0, -1],
    ['mass', 'Mass', 'kg', 2, -1]
  ];

  function currentMetrics() {
    const e = elec(), st = coilAt(), an = S.opAn, sum = S.sum || {};
    let b98 = 0, b98Body = '';
    if (an) an.bodies.forEach(b => { if (S.meta[b.id].cls === 'steel' && b.Bp98 > b98) { b98 = b.Bp98; b98Body = S.meta[b.id].name; } });
    const T = S.opT ? S.opT.total : null, env = thermalEnvNow(), rs = S.resp;
    return { T, F: T != null ? T * P.ratio / (P.rForce * 1e-3) / G0 : null, NI: e.NI, N: e.N, I: e.I, R: e.R, P: e.P, J: e.Jw,
      Tcoil: st.th && !st.th.runaway ? st.th.Tss : null, TperW: T != null && e.P > 0 ? T / e.P : null,
      util: sum.util != null ? 100 * sum.util : null, Bg: sum.Bg, steelB98: b98 || null, steelB98Body: b98Body,
      L: rs ? rs.L.Lsec * 1e3 : null, tOn: rs ? rs.r.tOn90 * 1e3 : null, tOff: rs ? rs.r.tOff10 * 1e3 : null,
      Jrot: rs && rs.J ? rs.J.J * 1e6 : null, mass: env ? env.massKg : null, limit: sum.label || '' };
  }

  function inputsSummary() {
    const wl = F.wireList(P.wire), w = wl.find(o => o.key === P.swg);
    const WIND = { random: `random, pack ${P.pack}`, layer: 'layer wound', ortho: 'orthocyclic' };
    return [['Design', $('source').textContent], ['Supply', `${P.V} V, limit ${P.Ilim} A`],
      ['Wire', `${w ? w.name : P.swg} (${w ? w.d : ''} mm), ${WIND[P.winding] || P.winding}${P.bobbin ? `, bobbin ${P.bobbin} mm` : ''}`],
      ['Coil temperature', P.thermalOp ? 'steady state' : `${P.tempC} °C`], ['Shear model', `τsat ${P.tauSat} kPa, Bs ${P.Bs} T`],
      ['Steel grades', [...new Set(S.meta.filter(m => m.cls === 'steel').map(m => m.grade))].join(', ')], ['Mesh', `${P.hmax} mm`]];
  }

  function thumb() {
    const t = document.createElement('canvas'), w = 360, h = Math.round(w * cv.height / Math.max(1, cv.width));
    t.width = w; t.height = h;
    t.getContext('2d').drawImage(cv, 0, 0, w, h);
    return t.toDataURL('image/png');
  }

  function takeSnapshot() {
    if (!S.opT || S.stale) { status('Wait for the operating point to finish solving.', 'err'); return; }
    const name = ($('snapName').value || '').trim() || `Snapshot ${S.snaps.length + 1}`;
    S.snaps.push({ name, time: new Date().toISOString(), metrics: currentMetrics(), inputs: inputsSummary(),
      P: JSON.parse(JSON.stringify(P)), geo: S.geo, img: thumb() });
    $('snapName').value = '';
    renderCompare();
    status(`Saved snapshot “${name}”`);
  }

  function compareTable(snaps, forReport) {
    if (!snaps.length) return '';
    const ref = snaps[0].metrics;
    const head = snaps.map((s, k) => `<th>${esc(s.name)}${k === 0 ? '<br><span class="note">reference</span>' : ''}${forReport ? '' : `<br>
      ${k ? `<button data-snap="ref" data-k="${k}" title="Use as the reference column">Ref</button>` : ''}<button data-snap="restore" data-k="${k}" title="Load this snapshot's settings (and its geometry)">Restore</button><button data-snap="del" data-k="${k}" title="Delete">✕</button>`}</th>`).join('');
    const body = SNAP_ROWS.map(([key, label, unit, d, better, abs]) => {
      const cells = snaps.map((s, k) => {
        const v = s.metrics[key];
        if (v == null) return '<td>–</td>';
        let delta = '';
        if (k && ref[key] != null && (abs || ref[key] !== 0)) {
          const dv = abs ? v - ref[key] : 100 * (v / ref[key] - 1), cls = Math.abs(dv) < 0.5 || !better ? 'note' : (dv * better > 0 ? 'ok' : 'flag');
          delta = ` <span class="${cls}">${pc(dv)} ${abs || '%'}</span>`;
        }
        return `<td>${fmt(v, d)}${delta}</td>`;
      }).join('');
      return `<tr><td class="l">${label}${unit ? ', ' + unit : ''}</td>${cells}</tr>`;
    }).join('');
    const lim = `<tr><td class="l">Limit</td>${snaps.map(s => `<td class="l">${esc(s.metrics.limit || '–')}</td>`).join('')}</tr>`;
    const inp = snaps[0].inputs.map(([k], n) => `<tr><td class="l">${esc(k)}</td>${snaps.map(s => `<td class="l">${esc(s.inputs[n] ? s.inputs[n][1] : '')}</td>`).join('')}</tr>`).join('');
    const imgs = `<tr><td></td>${snaps.map(s => `<td>${s.img ? `<img src="${s.img}" alt="Section of ${esc(s.name)}" style="width:${forReport ? 220 : 150}px">` : ''}</td>`).join('')}</tr>`;
    return `<table class="compare"><thead><tr><th></th>${head}</tr></thead><tbody>${imgs}${body}${lim}${inp}</tbody></table>`;
  }

  function renderCompare() {
    const box = $('tab-compare');
    if (!box.firstChild) {
      box.innerHTML = `<div class="compare-wrap"><div class="row"><input type="text" id="snapName" placeholder="Snapshot name" style="width:180px">
        <button class="primary" id="btnSnap">Save snapshot</button><button id="btnReport">Export report (HTML)</button>
        <span class="note">A snapshot stores the results, settings and geometry of the current design. Deltas are against the first column; green is better.</span></div>
        <div id="snapOut"></div></div>`;
    }
    $('snapOut').innerHTML = S.snaps.length ? compareTable(S.snaps, false) : '<p class="note">No snapshots yet. Set up a design, then Save snapshot; change something and save another to compare.</p>';
  }

  $('tab-compare').addEventListener('click', ev => {
    if (ev.target.id === 'btnSnap') return takeSnapshot();
    if (ev.target.id === 'btnReport') return exportReport();
    const b = ev.target.closest('[data-snap]');
    if (!b) return;
    const k = +b.dataset.k, s = S.snaps[k];
    if (b.dataset.snap === 'del') S.snaps.splice(k, 1);
    else if (b.dataset.snap === 'ref') { S.snaps.splice(k, 1); S.snaps.unshift(s); }
    else if (b.dataset.snap === 'restore') {
      if (s.geo && s.geo !== S.geo) { ST.preview = null; loadGeometry(s.geo, { carry: true, label: `restored “${s.name}”` }); }
      Object.assign(P, JSON.parse(JSON.stringify(s.P)));
      refreshMat(); renderSettings(); syncSliders();
      invalidate('grid');
      status(`Restored settings of “${s.name}”`);
    }
    renderCompare();
  });

  /** Copy of a rendered panel with form controls replaced by their values (for the static report). */
  function staticCopy(el) {
    if (!el) return '';
    const c = el.cloneNode(true);
    c.querySelectorAll('select').forEach(s => { const o = s.options[s.selectedIndex]; s.replaceWith(document.createTextNode(o ? o.text : '')); });
    c.querySelectorAll('input').forEach(i => i.replaceWith(document.createTextNode(i.type === 'checkbox' ? (i.checked ? '✓' : '–') : i.value)));
    c.querySelectorAll('button, canvas').forEach(b => b.remove());
    return c.innerHTML;
  }
  const kvTable = el => `<table class="kv">${[...el.querySelectorAll('dt')].map(dt => `<tr><th>${dt.innerHTML}</th><td>${dt.nextElementSibling ? dt.nextElementSibling.innerHTML : ''}</td></tr>`).join('')}</table>`;

  function exportReport() {
    if (!S.opT || S.stale) { status('Wait for the operating point to finish solving.', 'err'); return; }
    const m = currentMetrics(), src = $('source').textContent, date = new Date();
    // charts are drawn on a transparent background in the theme's ink: give them the panel colour so they read on paper
    const onPanel = c => {
      if (!c.width || !c.height) return ''; // chart is in a collapsed section
      const t = document.createElement('canvas'), g = t.getContext('2d');
      t.width = c.width; t.height = c.height;
      g.fillStyle = chartColors().panel; g.fillRect(0, 0, t.width, t.height); g.drawImage(c, 0, 0);
      return t.toDataURL('image/png');
    };
    const shut = ['dCurve', 'dResp'].filter(id => !$(id).open);
    shut.forEach(id => { $(id).open = true; });
    if (shut.length) { const e = elec(); drawCurve(e.NI, S.opT.total); renderResponse(); }
    const imgView = cv.toDataURL('image/png'), imgCurve = onPanel($('curve')), imgResp = onPanel($('respChart'));
    shut.forEach(id => { $(id).open = false; });
    const tbl = id => { const t = $(id).querySelector('table'); return t ? `<table>${staticCopy(t)}</table>` : '<p>–</p>'; };
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Brake report ${esc(src)}</title>
<style>body{font:13px/1.45 "Segoe UI",Arial,sans-serif;color:#1b2733;max-width:1000px;margin:24px auto;padding:0 16px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 6px;border-bottom:1px solid #d5dbe1;padding-bottom:3px}
table{border-collapse:collapse;margin:4px 0}th,td{border-bottom:1px solid #e3e7eb;padding:3px 8px;text-align:right;vertical-align:top}
th{background:#f3f5f7;font-weight:600}td.l,th:first-child,table.kv th{text-align:left}table.kv th{background:none;font-weight:normal;color:#5d6b78}
.big{display:flex;gap:30px;margin:10px 0}.big b{font-size:26px;display:block}.note{color:#5d6b78}.flag{color:#c2412d}.ok{color:#2f7d4f}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px 24px}img{max-width:100%;border-radius:4px}.balance{display:none}
.balance-lbl{display:flex;justify-content:space-between;max-width:320px;color:#5d6b78}.chip{border:1px solid #c2412d;color:#c2412d;border-radius:10px;padding:0 7px;margin-right:4px;font-size:11px}.chip.okc{border-color:#2f7d4f;color:#2f7d4f}.bal-k{color:#5d6b78;margin:0}.bal-h{font-size:17px;font-weight:600;margin:2px 0}
@media print{body{margin:0}h2{break-after:avoid}table{break-inside:avoid}}</style></head><body>
<h1>Magnetic powder brake analysis</h1><p class="note">${esc(src)} · ${date.toLocaleString()} · Ferra Brake Analyzer (axisymmetric nonlinear magnetostatics)</p>
<div class="big"><div><b>${fmt(m.T, 2)} N·m</b>torque</div><div><b>${fmt(m.F, 1)} kgf</b>at r = ${P.rForce} mm${P.ratio !== 1 ? ` × ${P.ratio}` : ''}</div>
<div><b>${fmt(m.P, 1)} W</b>coil power</div><div><b>${m.Tcoil != null ? fmt(m.Tcoil, 0) + ' °C' : '–'}</b>steady coil</div></div>
<h2>Inputs</h2><table class="kv">${inputsSummary().map(([k, v]) => `<tr><th>${esc(k)}</th><td class="l">${esc(v)}</td></tr>`).join('')}</table>
<h2>Balance</h2>${staticCopy($('balCard'))}
<h2>Field and what limits torque</h2><div class="cols"><div>${kvTable($('resKV'))}</div><div>${staticCopy($('verdict'))}</div></div>
<h2>Section</h2><img src="${imgView}" alt="Flux density in the section"><div class="cols">${imgCurve ? `<div><h3>Torque vs ampere-turns</h3><img src="${imgCurve}" alt="Torque curve"></div>` : ''}
${imgResp ? `<div><h3>Switching (torque vs time)</h3><img src="${imgResp}" alt="Switching transient"></div>` : ''}</div>
<h2>Coil, thermal and response</h2><div class="cols"><div>${kvTable($('coilKV'))}${kvTable($('coilMoreKV'))}</div><div>${kvTable($('thermKV'))}</div><div>${kvTable($('respKV'))}</div><div>${staticCopy($('levers').parentNode)}</div></div>
<h2>Bodies</h2>${tbl('tab-bodies')}<h2>Working gaps</h2>${tbl('tab-gaps')}
${S.snaps.length ? `<h2>Design comparison</h2>${compareTable(S.snaps, true)}` : ''}
${SEC.cmp ? `<h2>Section-angle check</h2>${staticCopy($('secOut'))}` : ''}
<h2>Model assumptions</h2><ul><li>Axisymmetric: the section is treated as a full ring; holes and slots are not modelled except as grooves (see the section-angle check).</li>
<li>Steel from the grade library or supplied B-H curves; powder as a saturating linear material (μr ${P.powderMur}, Js ${P.powderJs} T).</li>
<li>Shear stress τ = τsat·tanh(B/Bs), τsat ${P.tauSat} kPa, Bs ${P.Bs} T${S.calFit ? ' (fitted to measurements)' : ''}.</li>
<li>Thermal: lumped, the whole brake at one temperature. Switching: static flux curve, no eddy currents or remanence.</li></ul>
</body></html>`;
    saveText((S.geo.source || 'brake').replace(/[^\w.-]+/g, '_') + '_report.html', html, 'HTML (*.html)');
  }

  // ------------------------------------------------------------------ collapsible sections
  // Open/closed state is a per-viewer convenience; canvases inside a closed <details> have no size, so redraw on open.
  document.querySelectorAll('details[id]').forEach(d => {
    try { const v = localStorage.getItem('ferra.fold.' + d.id); if (v != null) d.open = v === '1'; } catch (e) { /* storage unavailable */ }
    d.addEventListener('toggle', () => {
      try { localStorage.setItem('ferra.fold.' + d.id, d.open ? '1' : '0'); } catch (e) { /* storage unavailable */ }
      if (!d.open) return;
      if (d.id === 'dCurve' && S.sweep) { const e = elec(); drawCurve(e.NI, S.opT && !S.stale ? S.opT.total : torqueAt(e.NI)); }
      if (d.id === 'dResp') renderResponse();
    });
  });

  // ------------------------------------------------------------------ boot
  renderSettings();
  updateElectrical();
  renderStudy();
  renderMap();
  window.addEventListener('load', () => {
    if (inFusion()) setTimeout(() => $('btnExtract').click(), 300);
  });
  window.FerraUI = { S, P, ST, MP, loadGeometry };
})();
