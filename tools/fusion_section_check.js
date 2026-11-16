// Runs the palette pipeline (setup, coil, solve, response, inertia) on a section exported from Fusion.
//   node tools/fusion_section_check.js tools/_fusion_section_0.json [more sections...]
// Uses the palette's default classification and picks the largest enclosed empty region as the coil window.
const F = require('../palette/solver.js');
const FI = require('../palette/insight.js');
const FM = require('../palette/materials.js');
const FS = require('../palette/study.js');
const FX = require('../palette/extras.js');
const { ferraEngine } = require('../palette/compute.js');
const fs = require('fs');

function classify(b) { // same rules as ui.js classify()
  const n = (b.name + ' ' + (b.component || '')).toLowerCase(), m = (b.material || '').toLowerCase();
  let cls = 'nonmag', role = 'stator';
  if (/coil|winding|bobbin.?wire/.test(n)) cls = 'coil';
  else if (/powder/.test(n)) cls = 'powder';
  else if (/bearing|screw|bolt|nut\b|washer|circlip|grub|key\b/.test(n)) cls = 'ignore';
  else if (/separator|o-?ring|seal|felt|v-?ring|gasket|spacer.*(nylon|ptfe|rubber)/.test(n)) cls = 'nonmag';
  else if (/stainless|inox|aisi\s*3\d\d|\b3(04|16)\b/.test(m)) cls = /\b4(10|16|20|30|40)\b/.test(m) ? 'steel' : 'nonmag';
  else if (/steel|iron|1018|1020|1010|en8|en3|c45|ms\b|mild/.test(m)) cls = 'steel';
  else if (/copper/.test(m)) cls = /coil|wind/.test(n) ? 'coil' : 'nonmag';
  else if (!m) cls = 'steel';
  if (/rotor|disc|disk|drum|shaft|hub|armature|inner.?cyl/.test(n)) role = 'rotor';
  return { cls, role, grade: FM.defaultGrade(b.material) };
}

const P = { V: 24, swg: 27, wire: 'SWG', winding: 'random', bobbin: 0, pack: 0.75, Ilim: 3, tempC: 25, turnsOverride: 0, Pmax: 30, Jmax: 6,
  powderMur: 5, powderJs: 0.8, tauSat: 60, Bs: 0.6, hmax: 0.75, gmaxDetect: 3, torqueGapMax: 1.5, coilRmin: 0,
  Tamb: 25, hConv: 12, duty: 100, RthCoil: 0, Tmax: 130, coolAreaCm2: 0, thermalOp: 0, Voff: 0.7, rpm: 300 };

function largestEnclosed(G) {
  const seen = new Uint8Array(G.nr * G.nz);
  let best = null;
  for (let j = 0; j < G.nz; j++) for (let i = 0; i < G.nr; i++) {
    const c = j * G.nr + i;
    if (seen[c] || G.cellBody[c] >= 0) continue;
    const m = F.floodEmpty(G, i, j);
    if (!m) { seen[c] = 1; continue; }
    let a = 0;
    for (let k = 0; k < m.length; k++) if (m[k]) { seen[k] = 1; a += (G.rs[k % G.nr + 1] - G.rs[k % G.nr]) * (G.zs[(k / G.nr | 0) + 1] - G.zs[k / G.nr | 0]); }
    if (!best || a > best.a) best = { a, pick: [G.rc[i], G.zc[j]] };
  }
  return best;
}

(async () => {
  const files = process.argv.slice(2);
  const base = JSON.parse(fs.readFileSync(files[0], 'utf8'));
  const meta = base.bodies.map(classify);
  const G = F.buildGrid(base.bodies, { hmax: P.hmax });
  const enc = largestEnclosed(G);
  console.log(`grid ${G.nr}x${G.nz}; largest enclosed empty region ${enc ? enc.a.toFixed(0) + ' mm² at r ' + enc.pick[0].toFixed(1) + ', z ' + enc.pick[1].toFixed(1) : 'none'}`);
  base.bodies.forEach((b, i) => console.log(`  ${b.component}/${b.name} (${b.material}) -> ${meta[i].cls}, ${meta[i].role}, ${meta[i].grade}`));
  const mat = FM.makeDefs({}, []);
  const cfg = FS.makeCfg(P, mat, meta.map(m => m.cls), meta.map(m => m.role), meta.map(m => m.grade), enc ? FS.coilMaskFromPicks(F, G, [enc.pick]) : null);
  const prob = F.buildProblem(G, cfg, null);
  console.log(`coil window ${(prob.coilAreaM2 * 1e6).toFixed(0)} mm², box ${JSON.stringify(F.coilWindow(prob))}`);
  prob.gaps.forEach(g => console.log(`  gap ${g.id} ${g.dir} t ${g.thickness.toFixed(2)} mm, len ${g.length.toFixed(1)} mm, torque ${g.torque}`));
  const E = ferraEngine(F);
  const ctx = { F, FI, FM, P, mat, compute: { call: async (cmd, a) => E[cmd](a) }, classify, point: null, line: null,
    base: { bodies: new Map(base.bodies.map((b, i) => [FS.bodyKey(b), meta[i]])), gaps: prob.gaps.map(g => FS.gapSignature(g, base.bodies.map(FS.bodyKey))),
      coilPicks: enc ? [enc.pick] : [], coilBox: prob.coilBox,
      overlaps: new Map(G.overlaps.map(o => [[FS.bodyKey(base.bodies[o.a]), FS.bodyKey(base.bodies[o.b])].sort().join(' & '), o.areaMM2])) } };
  console.log('base overlaps', JSON.stringify(G.overlaps.map(o => [base.bodies[o.a].component, base.bodies[o.b].component, +o.areaMM2.toFixed(2)])));
  // T(NI) sweep with flux per turn -> response
  E.load({ bodies: base.bodies, hmax: P.hmax, cfg, gaps: prob.gaps });
  const e = F.coilElectrical(F.coilWindow(prob), P);
  const pts = [];
  for (const fr of [0.05, 0.15, 0.3, 0.5, 0.75, 1, 1.5, 2.5]) {
    const t0 = Date.now(), r = E.solve({ NI: fr * e.NI, from: 'sweep', keep: 'sweep' });
    pts.push({ NI: r.NI, phi: r.phi, stats: r.stats, ms: Date.now() - t0, conv: r.converged, newton: r.newton });
  }
  const tp = { tauSat: P.tauSat * 1e3, Bs: P.Bs };
  const Ts = pts.map(p => F.torqueFromStats(prob, p.stats, tp).total);
  pts.forEach((p, k) => console.log(`  NI ${p.NI.toFixed(0)}: T ${Ts[k].toFixed(3)} N·m, phi/turn ${(p.phi * 1e6).toFixed(1)} µWb, ${p.newton} Newton, ${p.conv ? 'conv' : 'NOT CONVERGED'}, ${p.ms} ms`));
  const c = FX.curve(pts, Ts), L = FX.inductance(c, e.N, e.NI), rs = FX.response(c, { N: e.N, R: e.R, V: P.V, Ilim: P.Ilim, Voff: P.Voff });
  const J = FX.rotorInertia(G, b => meta[b].role === 'rotor' && meta[b].cls !== 'coil' && meta[b].cls !== 'ignore', b => FM.thermalOf(meta[b].cls, base.bodies[b].material).rho);
  console.log(`coil: ${e.N} turns, ${e.R.toFixed(1)} Ω, ${e.I.toFixed(2)} A, NI ${e.NI.toFixed(0)}, ${e.P.toFixed(1)} W, fill ${(100 * e.fill).toFixed(0)} %`);
  console.log(`L ${L.Lsec.toFixed(3)} H (inc ${L.Linc.toFixed(3)}, L0 ${L.L0.toFixed(3)}); on90 ${(rs.tOn90 * 1e3).toFixed(0)} ms, off10 ${(rs.tOff10 * 1e3).toFixed(0)} ms; rotor J ${(J.J * 1e6).toFixed(0)} kg·mm², ${J.mass.toFixed(2)} kg`);
  for (const f of files) {
    const geo = JSON.parse(fs.readFileSync(f, 'utf8'));
    const r = await FS.evaluateGeometry(ctx, geo, geo.massKg);
    const m = r.metrics || {};
    console.log(`${f}: ${r.status}${r.reason ? ' ' + r.reason : ''} T ${m.T && m.T.toFixed(3)} N·m, Bg ${m.Bg && m.Bg.toFixed(3)}, util ${m.util && (100 * m.util).toFixed(0)} %, coil ${m.coilAreaMM2 && m.coilAreaMM2.toFixed(0)} mm², B98 ${m.steelB98 && m.steelB98.toFixed(2)} ${m.steelB98Body || ''}, notes ${JSON.stringify(r.notes)}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
