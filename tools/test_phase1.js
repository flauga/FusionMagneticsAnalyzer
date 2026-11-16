// Phase 1 tests: steel grades, custom B-H, probes, thermal.  node tools/test_phase1.js
const F = require('../palette/solver.js');
const FI = require('../palette/insight.js');
const FM = require('../palette/materials.js');
const Study = require('../palette/study.js');
const demo = require('../palette/demo.js');

let fails = 0;
function check(name, ok, info) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`);
  if (!ok) fails++;
}

const CLS = { Shaft: 'nonmag', 'Rotor hub': 'nonmag', Separator: 'nonmag', Coil: 'coil' };
const ROT = new Set(['Shaft', 'Rotor hub', 'Rotor drum']);
const bodies = demo.bodies;
const cls = bodies.map(b => CLS[b.name] || 'steel'), role = bodies.map(b => (ROT.has(b.name) ? 'rotor' : 'stator'));
const P = { gmaxDetect: 3, torqueGapMax: 1.5, coilRmin: 0, powderMur: 5, powderJs: 0.8, pack: 0.75, coolAreaCm2: 0 };
const tp = { tauSat: 60e3, Bs: 0.6 };
const G = F.buildGrid(bodies, { hmax: 0.75 });

function solveWith(grades, scales, custom, NI) {
  const mat = FM.makeDefs(scales || {}, custom || []);
  const cfg = Study.makeCfg(P, mat, cls, role, grades, null);
  const prob = F.buildProblem(G, cfg, null);
  const sol = F.solveNI(prob, NI || 1000, null);
  return { prob, sol, T: F.torqueFromStats(prob, F.gapFieldStats(prob, sol), tp).total, an: F.analyse(prob, sol, bodies.length) };
}
const all = g => bodies.map(() => g);

// --- grades
const base = solveWith(all('1010'));
const legacyProb = F.buildProblem(G, { cls, role, gmaxDetect: 3, torqueGapMax: 1.5, coilExtra: null, coilRmin: 0, powderMur: 5, powderJs: 0.8 }, null);
const legacy = F.torqueFromStats(legacyProb, F.gapFieldStats(legacyProb, F.solveNI(legacyProb, 1000, null)), tp).total;
check('1010 grade reproduces the original solver', Math.abs(base.T / legacy - 1) < 1e-9, `${base.T.toFixed(4)} vs ${legacy.toFixed(4)}`);
const T416 = solveWith(all('416')).T, TFeCo = solveWith(all('FeCo')).T;
check('torque ranks with steel grade: 416 < 1010 < FeCo', T416 < base.T && base.T < TFeCo, `${T416.toFixed(3)} < ${base.T.toFixed(3)} < ${TFeCo.toFixed(3)}`);
const lipIdx = bodies.findIndex(b => b.name === 'Front pole lip'), lip2 = bodies.findIndex(b => b.name === 'Back pole lip');
const mixed = solveWith(bodies.map((b, i) => (i === lipIdx || i === lip2 ? 'FeCo' : '1010'))).T;
check('upgrading only the pole lips helps (they are the bottleneck)', mixed > base.T + 0.01, `${mixed.toFixed(3)} vs ${base.T.toFixed(3)}`);
check('per-grade scale changes the field', solveWith(all('1010'), { 1010: 0.8 }).T < base.T);
check('1010 knee is about 1.6 T', Math.abs(base.prob.knees[0] - 1.6) < 0.1, base.prob.knees[0].toFixed(2));
const p416 = solveWith(all('416'));
check('each body uses its own grade knee', p416.prob.bodyKnee[lipIdx] < 1.3 && base.prob.bodyKnee[lipIdx] > 1.5 && base.prob.bodyKnee[0] === null);
check('CAD material names pick grades', FM.defaultGrade('Steel') === '1010' && FM.defaultGrade('AISI 1018') === '1018' &&
  FM.defaultGrade('Stainless Steel 430F') === '430' && FM.defaultGrade('Iron, Cast') === 'grey' && FM.defaultGrade('Hiperco 50') === 'FeCo');

// --- custom curve
const tbl = F.steelTable(FM.makeDefs().defs[0]);
const text = 'H (A/m), B (T)\n' + Array.from(tbl.H).map((h, i) => `${h}, ${tbl.B[i]}`).join('\n');
const cu = FM.parseBH(text);
check('custom B-H parses', !cu.error && cu.H.length === tbl.n);
const custom = [{ id: 'custom:copy', name: 'copy of 1010', H: cu.H, B: cu.B }];
const Tc = solveWith(all('custom:copy'), {}, custom).T;
check('custom copy of 1010 gives the same torque', Math.abs(Tc / base.T - 1) < 1e-6, `${Tc.toFixed(4)} vs ${base.T.toFixed(4)}`);
check('bad custom data is rejected', !!FM.parseBH('0,0\n10,1\n5,1.2\n20,1.3\n3000,1.5').error && !!FM.parseBH('0,0\n1,10\n2,20\n3000,30').error);

// --- probes
const sol = base.sol;
const pp = FI.probePoint(G, sol, 32.5, 28);
check('probe point reads the cell field', pp && pp.body === lipIdx && pp.B > 0.5 && pp.mur > 1, `|B| ${pp.B.toFixed(3)} T, μr ${pp.mur.toFixed(0)}`);
check('probe outside the model returns null', FI.probePoint(G, sol, -5, 0) === null);
// flux across the lip cross-section from psi vs the integral of Bz over the annulus
const z = 28, r0 = 30.05, r1 = 34.95;
const line = FI.probeLine(G, sol, [r0, z], [r1, z], 400);
let phi = 0;
for (let k = 0; k < 400; k++) {
  const r = r0 + (r1 - r0) * (k + 0.5) / 400, p = FI.probePoint(G, sol, r, z);
  phi += p.Bz * 2 * Math.PI * r * 1e-3 * (r1 - r0) / 400 * 1e-3;
}
check('line flux from psi matches the integral of B', Math.abs(line.flux / Math.abs(phi) - 1) < 0.03, `${(line.flux * 1e3).toFixed(4)} vs ${(Math.abs(phi) * 1e3).toFixed(4)} mWb`);
check('normal component dominates across a pole', Math.abs(line.samples[200].Bn) > Math.abs(line.samples[200].Bt));

// --- thermal
const win = { areaMM2: base.prob.coilAreaM2 * 1e6, rmeanMM: base.prob.coilRmean * 1e3 };
const env = Study.thermalEnv(FI, FM, G, base.prob, bodies, cls, P);
check('envelope area and heat capacity are sensible', env.areaM2 > 0.02 && env.areaM2 < 0.05 && env.heatCapJK > 500 && env.massKg > 1.5 && env.massKg < 4,
  `${(env.areaM2 * 1e4).toFixed(0)} cm², ${env.heatCapJK.toFixed(0)} J/K, ${env.massKg.toFixed(2)} kg`);
const cp = { V: 24, swg: 27, pack: 0.75, Ilim: 3, tempC: 25, turnsOverride: 0, Tamb: 25, hConv: 15, duty: 100, RthCoil: 0, Tmax: 130 };
const s1 = FI.coilState(F, win, Object.assign({}, cp, { thermalOp: 1 }), env), th = s1.th;
check('steady-state temperature balances power and cooling', Math.abs(th.Tss - (25 + th.hot.P * th.Rth)) < 0.01, `${th.Tss.toFixed(1)} °C at ${th.hot.P.toFixed(1)} W`);
check('voltage drive: hot coil draws fewer ampere-turns', th.hot.NI < th.cold.NI && th.hot.R > th.cold.R,
  `NI ${th.cold.NI.toFixed(0)} cold -> ${th.hot.NI.toFixed(0)} hot`);
check('thermalOp uses the hot state, otherwise the set temperature', s1.e === th.hot && FI.coilState(F, win, cp, env).e.NI === F.coilElectrical(win, cp).NI);
const half = FI.thermal(F, win, Object.assign({}, cp, { h: 15, Rth: 0, duty: 50 }), env);
check('lower duty runs cooler', half.Tss < th.Tss && Math.abs(half.Tcont - th.Tss) < 0.01);
const hotCase = FI.thermal(F, win, Object.assign({}, cp, { h: 3, Rth: 0, Tmax: 80 }), env);
check('time to the limit is reported when continuous running exceeds it', hotCase.Tcont > 80 && hotCase.tToMax > 0 && hotCase.maxDuty < 1,
  `${hotCase.Tcont.toFixed(0)} °C steady, ${(hotCase.tToMax / 60).toFixed(1)} min to 80 °C, max duty ${(100 * hotCase.maxDuty).toFixed(0)} %`);
const runaway = FI.thermal(F, win, Object.assign({}, cp, { V: 200, Ilim: 2, h: 0.5, Rth: 0 }), env);
check('constant-current drive with poor cooling reports runaway', runaway.runaway === true);
const viol = Study.violations({ P: 1, J: 1, steelB98: 1, Tcoil: 150, runaway: false }, { Pmax: null, Jmax: null, steelB98Max: null, Tmax: 130 });
check('coil temperature limit is a study constraint', viol.length === 1 && /150/.test(viol[0]));

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
