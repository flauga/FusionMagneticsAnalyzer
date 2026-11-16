// Invariant tests for the engine, steel scaling, sensitivities and insight logic.  node tools/test_phase0.js
const F = require('../palette/solver.js');
const { ferraEngine } = require('../palette/compute.js');
const I = require('../palette/insight.js');
const demo = require('../palette/demo.js');

let fails = 0;
function check(name, ok, info) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`);
  if (!ok) fails++;
}

const cls = ['nonmag', 'nonmag', 'steel', 'steel', 'steel', 'nonmag', 'steel', 'steel', 'steel', 'coil'];
const role = ['rotor', 'rotor', 'rotor', 'stator', 'stator', 'stator', 'stator', 'stator', 'stator', 'stator'];
const tp = { tauSat: 60e3, Bs: 0.6 };
const steelIds = cls.map((c, i) => (c === 'steel' ? i : -1)).filter(i => i >= 0);

function setup(steelScale) {
  const cfg = { cls, role, gmaxDetect: 3, torqueGapMax: 1.5, coilExtra: null, coilRmin: 0, powderMur: 5, powderJs: 0.8, steelScale };
  const G = F.buildGrid(demo.bodies, { hmax: 0.75 });
  const prob = F.buildProblem(G, cfg, null);
  const E = ferraEngine(F);
  E.load({ bodies: demo.bodies, hmax: 0.75, cfg, gaps: JSON.parse(JSON.stringify(prob.gaps)) });
  const torque = st => F.torqueFromStats(prob, st, tp).total;
  return { prob, E, torque };
}

function breakdown(ctx, NI) {
  const op = ctx.E.solve({ NI, keep: 'op', fields: true });
  const T0 = ctx.torque(op.stats);
  const sens = { eps: 0.05, ni: ctx.E.sens({ NI, eps: 0.05, kind: 'ni' }).stats, all: ctx.E.sens({ NI, eps: 0.05, kind: 'all' }).stats, bodies: {} };
  for (const b of steelIds) sens.bodies[b] = ctx.E.sens({ NI, eps: 0.05, kind: 'body', body: b }).stats;
  const el = I.elasticities(sens, T0, ctx.torque);
  const eShear = I.shearElasticity(ctx.prob, op.stats, tp);
  return { op, T0, el, eShear, lb: I.limitBreakdown(Object.assign({ eShear, util: null }, el)) };
}

// --- electrical: what moves NI
const win = { areaMM2: 400, rmeanMM: 30 };
const pV = { V: 24, swg: 27, pack: 0.75, Ilim: 3, tempC: 25, turnsOverride: 0, Pmax: 30, Jmax: 6 };
const rV = I.electricalLevers(F, win, pV, null);
const lev = k => rV.levers.find(l => l.key === k);
check('voltage-limited regime detected', rV.regime.kind === 'voltage');
check('packing does not change NI at fixed voltage', Math.abs(lev('pack').dNI) < 0.01, `dNI ${lev('pack').dNI.toFixed(4)} %`);
check('packing lowers power at fixed voltage', lev('pack').dP < -1, `dP ${lev('pack').dP.toFixed(1)} %`);
check('current limit does not change NI when not binding', Math.abs(lev('Ilim').dNI) < 1e-9);
check('voltage +10 % gives NI +10 %', Math.abs(lev('V').dNI - 10) < 1e-6);
check('thicker wire raises NI', lev('swg').dNI > 5, `dNI ${lev('swg').dNI.toFixed(1)} %`);
check('hotter coil lowers NI', lev('temp').dNI < -5, `dNI ${lev('temp').dNI.toFixed(1)} %`);
const rI = I.electricalLevers(F, win, Object.assign({}, pV, { Ilim: 0.5 }), null);
check('current-limited regime detected', rI.regime.kind === 'current');
check('packing raises NI when current-limited', rI.levers.find(l => l.key === 'pack').dNI > 3);
check('voltage does not change NI when current-limited', Math.abs(rI.levers.find(l => l.key === 'V').dNI) < 1e-9);

// --- engine matches direct solver
const c1 = setup(1);
const direct = F.solveNI(c1.prob, 1000, null);
const eng = c1.E.solve({ NI: 1000, keep: 'op' });
const tD = c1.torque(F.gapFieldStats(c1.prob, direct)), tE = c1.torque(eng.stats);
check('engine torque matches direct solve', Math.abs(tD / tE - 1) < 1e-4, `${tD.toFixed(4)} vs ${tE.toFixed(4)}`);
check('energy identity still holds', Math.abs(F.analyse(c1.prob, direct, demo.bodies.length, 1.6).energyCheck - 1) < 0.01);
check('non-steel body perturbation is a no-op', c1.E.sens({ NI: 1000, eps: 0.05, kind: 'body', body: 0 }).stats === null);

// --- steel scaling changes the physics
const c07 = setup(0.7), c13 = setup(1.3);
const t07 = c07.torque(c07.E.solve({ NI: 2000 }).stats), t10 = c1.torque(c1.E.solve({ NI: 2000 }).stats), t13 = c13.torque(c13.E.solve({ NI: 2000 }).stats);
check('weaker steel gives less torque, stronger more', t07 < t10 && t10 < t13, `${t07.toFixed(3)} < ${t10.toFixed(3)} < ${t13.toFixed(3)}`);

// --- sensitivities
const b07 = breakdown(c07, 1000), b13 = breakdown(c13, 150);
check('weak steel at 1000 A-t is steel-limited', b07.lb.kind === 'steel', `${b07.lb.kind}, steel share ${(100 * b07.lb.steelShare).toFixed(0)} %`);
check('stronger steel at 150 A-t leans to ampere-turns', b13.lb.steelShare < b07.lb.steelShare,
  `${(100 * b13.lb.steelShare).toFixed(0)} % vs ${(100 * b07.lb.steelShare).toFixed(0)} %`);
const sumBodies = b07.el.bodies.reduce((s, b) => s + b.e, 0);
check('per-body steel sensitivities add up to the all-steel one', sumBodies > 0.6 * b07.el.eSteel && sumBodies < 1.4 * b07.el.eSteel,
  `sum ${sumBodies.toFixed(3)} vs all ${b07.el.eSteel.toFixed(3)}`);
check('weaker steel is more steel-sensitive', b07.el.eSteel > breakdown(c1, 1000).el.eSteel);
check('torque elasticities are within physical bounds', [b07.el.eNI, b07.el.eSteel, b13.el.eNI].every(e => e > -0.05 && e < 1.5));

// --- knee of T(NI)
const pts = [100, 200, 400, 800, 1600, 3200].map(NI => [NI, c1.torque(c1.E.solve({ NI, from: 'sweep', keep: 'sweep' }).stats)]);
const knee = I.kneeNI(pts);
check('T(NI) knee found inside the range', knee > 100 && knee < 3200, `knee ${knee && knee.toFixed(0)} A-t`);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
