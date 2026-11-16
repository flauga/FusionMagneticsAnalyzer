const F = require('../palette/solver.js');
const demo = require('../palette/demo.js');
let t0 = Date.now();
const G = F.buildGrid(demo.bodies, { hmax: 0.75 });
console.log('grid', G.nr, 'x', G.nz, 'cells', G.nr*G.nz, (Date.now()-t0)+'ms');
const cls = ['nonmag','nonmag','steel','steel','steel','nonmag','steel','steel','steel','coil'];
const role = ['rotor','rotor','rotor','stator','stator','stator','stator','stator','stator','stator'];
for (const [mur, Js, NIs] of [[1, 5, [200]], [5, 0.8, [200, 500, 1000, 2000, 4000]]]) {
  const prob = F.buildProblem(G, { cls, role, gmaxDetect: 3, torqueGapMax: 1.5, coilExtra: null, coilRmin: 0, powderMur: mur, powderJs: Js });
  console.log('gaps', prob.gaps.map(g => `${g.id}:${g.dir} t=${g.thickness.toFixed(2)} A=${g.areaMM2.toFixed(0)} torque=${g.torque} pair=${g.a}-${g.b}`).join(' | '));
  console.log('coil area mm2', (prob.coilAreaM2*1e6).toFixed(1), 'rmean', (prob.coilRmean*1e3).toFixed(2));
  let warm = null;
  for (const NI of NIs) {
    t0 = Date.now();
    const sol = F.solveNI(prob, NI, warm);
    warm = sol;
    const st = F.gapFieldStats(prob, sol);
    const T = F.torqueFromStats(prob, st, { tauSat: 60e3, Bs: 0.6 });
    const an = F.analyse(prob, sol, demo.bodies.length, 1.5);
    console.log(`mur=${mur} NI=${NI} newton=${sol.newton} cg=${sol.cgIt} res=${sol.residual.toExponential(1)} ${Date.now()-t0}ms`);
    console.log('  gapB', st.map(s => s.Bavg.toFixed(3)).join(','), 'gapFlux mWb', st.map(s => (s.flux*1e3).toFixed(3)).join(','), 'phiTot', (an.phiTotal*1e3).toFixed(3), 'phiLink', (an.phiLink*1e3).toFixed(3), 'T', T.total.toFixed(3), 'Nm');
    console.log('  energyCheck', an.energyCheck.toFixed(4), 'air%', an.airMMFpct.toFixed(1), 'gaps%', an.gaps.map(g=>g.mmfPct.toFixed(1)).join(','));
    console.log('  bodies', an.bodies.map((b,i)=>`${demo.bodies[i].name}:p98=${b.Bp98.toFixed(2)} mmf%=${b.mmfPct.toFixed(1)}`).join(' | '));
  }
}
