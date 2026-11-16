// Saturation bridges (a notch leaving a thin web across the inner ring).  node tools/test_bridges.js
const F = require('../palette/solver.js');
const FI = require('../palette/insight.js');
const FM = require('../palette/materials.js');
const Study = require('../palette/study.js');
const { ferraEngine } = require('../palette/compute.js');
const demo = require('../palette/demo.js');

let fails = 0;
function check(name, ok, info) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`);
  if (!ok) fails++;
}

// Demo brake with the two pole lips and the stainless separator replaced by one steel inner ring (r 30..35,
// z 6..34) notched from the coil side at mid-length: r 30+web..35, z 18..22 is empty, leaving a radial web.
function notched(web) {
  const bodies = JSON.parse(JSON.stringify(demo.bodies)).filter(b => !/pole lip|Separator/.test(b.name));
  const w = 30 + web;
  bodies.push({ name: 'Inner ring', material: 'Steel', polys: [[30, 6, 35, 6, 35, 18, w, 18, w, 22, 35, 22, 35, 34, 30, 34, 30, 6]] });
  return bodies;
}
const CLS = { Shaft: 'nonmag', 'Rotor hub': 'nonmag', Separator: 'nonmag', Coil: 'coil' };
const ROT = new Set(['Shaft', 'Rotor hub', 'Rotor drum']);
const tp = { tauSat: 60e3, Bs: 0.6 };
const P0 = { gmaxDetect: 3, torqueGapMax: 1.5, coilRmin: 0, powderMur: 5, powderJs: 0.8, bridgeMax: 1.5 };

function setup(bodies, extra) {
  const cls = bodies.map(b => CLS[b.name] || 'steel'), role = bodies.map(b => (ROT.has(b.name) ? 'rotor' : 'stator'));
  const P = Object.assign({}, P0, extra || {});
  const cfg = Study.makeCfg(P, FM.makeDefs({}, []), cls, role, bodies.map(() => '1010'), null);
  const G = F.buildGrid(bodies, { hmax: 0.75 });
  return { bodies, cls, cfg, G, prob: F.buildProblem(G, cfg, null) };
}

// --- detection
const A = setup(notched(1));
const ring = A.bodies.findIndex(b => b.name === 'Inner ring');
const br = A.prob.bridges;
check('one bridge found in the notched ring', br.length === 1 && br[0].body === ring && br[0].auto && br[0].ignore,
  br.map(b => `${A.bodies[b.body].name} t ${b.thickness.toFixed(2)} at r ${b.r.toFixed(1)} z ${b.z.toFixed(1)}`).join('; '));
check('bridge sits on the web', br.length && Math.abs(br[0].r - 30.5) < 0.3 && Math.abs(br[0].z - 20) < 0.6 && Math.abs(br[0].thickness - 1) < 0.05);
check('plain demo brake has no bridges', setup(demo.bodies).prob.bridges.length === 0);
check('demo section through the bolt holes has no bridges', setup(demo.cad.build({}, 45).geometry.bodies).prob.bridges.length === 0);
check('threshold below the web finds nothing', setup(notched(1), { bridgeMax: 0.8 }).prob.bridges.length === 0);
check('bridgeMax 0 turns auto detection off', setup(notched(1), { bridgeMax: 0 }).prob.bridges.length === 0);
const man = setup(notched(1), { bridgeMax: 0, bridgePicks: [[30.5, 20]] }).prob.bridges;
check('manual pick finds the same web', man.length === 1 && !man[0].auto && man[0].ignore && Math.abs(man[0].areaMM2 - br[0].areaMM2) < 0.5,
  man.length ? `${man[0].areaMM2.toFixed(2)} vs ${br[0].areaMM2.toFixed(2)} mm²` : 'none');
const offd = setup(notched(1), { bridgeOff: [[30.6, 20.2]] }).prob.bridges;
check('bridgeOff keeps the bridge but stops ignoring it', offd.length === 1 && !offd[0].ignore);

// --- analysis at an operating point
const NI = 1500;
const E = ferraEngine(F);
E.load({ bodies: A.bodies, hmax: 0.75, cfg: A.cfg, gaps: null });
const op = E.solve({ NI, keep: 'op', fields: true });
const T0 = F.torqueFromStats(A.prob, op.stats, tp).total;
const an = F.analyse(A.prob, op, A.bodies.length);
check('energy identity holds with a bridge bucket', Math.abs(an.energyCheck - 1) < 0.01, an.energyCheck.toFixed(4));
check('the web is saturated', an.bridges[0].Bmax > 1.6 && an.bridges[0].satFrac > 0.5, `Bmax ${an.bridges[0].Bmax.toFixed(2)} T, ${(100 * an.bridges[0].satFrac).toFixed(0)} % above knee`);
const offP = setup(notched(1), { bridgeOff: [[30.5, 20]] });
const anOff = F.analyse(offP.prob, op, A.bodies.length);
const hotEx = an.bodies[ring].hot, hp = hotEx ? FI.probePoint(A.G, op, hotEx[0], hotEx[1]) : null;
check('ring hot-spot marks saturated ring steel, not the web or the notch', hp && hp.body === ring && !A.prob.bridgeCell[hp.c] && hp.B > 1.6,
  hotEx ? `r ${hotEx[0].toFixed(1)} z ${hotEx[1].toFixed(1)}, |B| ${hp.B.toFixed(2)} T` : 'none');
const hd = setup(demo.bodies), opd = F.solveNI(hd.prob, NI, null), and = F.analyse(hd.prob, opd, demo.bodies.length);
const lip = demo.bodies.findIndex(b => b.name === 'Back pole lip'), hl = and.bodies[lip].hot;
const pl = hl ? FI.probePoint(hd.G, opd, hl[0], hl[1]) : null;
check('demo hot-spot still lands in its own saturated body', pl && pl.body === lip && pl.B > 1.5, hl ? `r ${hl[0].toFixed(1)} z ${hl[1].toFixed(1)}` : 'none');
check('ring saturated volume drops without the web', an.bodies[ring].satFrac < anOff.bodies[ring].satFrac,
  `${(100 * anOff.bodies[ring].satFrac).toFixed(1)} % → ${(100 * an.bodies[ring].satFrac).toFixed(1)} %`);

// --- sensitivities
const eps = 0.05, el = st => (F.torqueFromStats(A.prob, st, tp).total / T0 - 1) / eps;
const eBridge = el(E.sens({ NI, eps, kind: 'bridge', bridge: 0 }).stats);
check('more flux capacity in the web lowers torque (it is a shunt)', eBridge < 0, `dlnT/dln(steel) ${eBridge.toFixed(4)}`);
const eRing = el(E.sens({ NI, eps, kind: 'body', body: ring }).stats);
E.load({ bodies: A.bodies, hmax: 0.75, cfg: offP.cfg, gaps: null });
E.solve({ NI, keep: 'op' });
const eRingWithWeb = el(E.sens({ NI, eps, kind: 'body', body: ring }).stats);
check('ring lever without the web is larger than with it', eRing > eRingWithWeb, `${eRingWithWeb.toFixed(4)} → ${eRing.toFixed(4)}`);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
