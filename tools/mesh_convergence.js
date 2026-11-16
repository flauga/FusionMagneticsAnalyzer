const F = require('../palette/solver.js');
const demo = require('../palette/demo.js');
const cls = ['nonmag','nonmag','steel','steel','steel','nonmag','steel','steel','steel','coil'];
const role = ['rotor','rotor','rotor','stator','stator','stator','stator','stator','stator','stator'];
for (const h of [1.5, 1.0, 0.75, 0.5, 0.35]) {
  const t0=Date.now();
  const G = F.buildGrid(demo.bodies, { hmax: h });
  const prob = F.buildProblem(G, { cls, role, gmaxDetect: 3, torqueGapMax: 1.5, coilExtra: null, coilRmin: 0, powderMur: 5, powderJs: 0.8 });
  const sol = F.solveNI(prob, 800, null);
  const st = F.gapFieldStats(prob, sol);
  const T = F.torqueFromStats(prob, st, { tauSat: 60e3, Bs: 0.6 });
  console.log('h', h, 'cells', G.nr*G.nz, 'T', T.total.toFixed(4), 'B', st[0].Bavg.toFixed(4), 'newton', sol.newton, 'cg', sol.cgIt, (Date.now()-t0)+'ms');
}
