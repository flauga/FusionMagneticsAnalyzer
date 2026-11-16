// Parameter-study tests: setup carry-over, metrics, optimizer.  node tools/test_study.js
const F = require('../palette/solver.js');
const FI = require('../palette/insight.js');
const Study = require('../palette/study.js');
const { ferraEngine } = require('../palette/compute.js');
const demo = require('../palette/demo.js');
const FM = require('../palette/materials.js');

let fails = 0;
const near = (a, b, tol) => Math.abs(a / b - 1) < tol;
function check(name, ok, info) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`);
  if (!ok) fails++;
}

const P = { V: 24, swg: 27, pack: 0.75, Ilim: 3, tempC: 25, turnsOverride: 0, Pmax: 30, Jmax: 6, powderMur: 5, powderJs: 0.8,
  tauSat: 60, Bs: 0.6, hmax: 0.75, gmaxDetect: 3, torqueGapMax: 1.5, coilRmin: 0,
  Tamb: 25, hConv: 15, duty: 100, RthCoil: 0, Tmax: 130, coolAreaCm2: 0, thermalOp: 0 };
const CLS = { Shaft: 'nonmag', 'Rotor hub': 'nonmag', Separator: 'nonmag', Coil: 'coil' };
const ROT = new Set(['Shaft', 'Rotor hub', 'Rotor drum']);
const base = demo.cad.build().geometry;
const baseBodies = new Map(base.bodies.map(b => [Study.bodyKey(b), { cls: CLS[b.name] || 'steel', role: ROT.has(b.name) ? 'rotor' : 'stator', grade: '1010' }]));
const baseCfg = { cls: base.bodies.map(b => baseBodies.get(Study.bodyKey(b)).cls), role: base.bodies.map(b => baseBodies.get(Study.bodyKey(b)).role),
  gmaxDetect: 3, torqueGapMax: 1.5, coilExtra: null, coilRmin: 0, powderMur: 5, powderJs: 0.8, steelScale: 1 };
const baseProb = F.buildProblem(F.buildGrid(base.bodies, { hmax: 0.75 }), baseCfg, null);
const keys0 = base.bodies.map(Study.bodyKey);
baseProb.gaps.forEach(g => { if (g.dir === 'z') g.torque = false; }); // user turned the face gaps off
const E = ferraEngine(F);
const ctx = { F, FI, FM, P, mat: FM.makeDefs({}, []), compute: { call: async (cmd, a) => E[cmd](a) }, classify: () => ({ cls: 'steel', role: 'stator' }),
  base: { bodies: baseBodies, gaps: baseProb.gaps.map(g => Study.gapSignature(g, keys0)), coilPicks: [] }, point: [32.5, 12] };

(async () => {
  // --- carry-over
  const g2 = demo.cad.build({ lip_t: 7, plate_t: 8 }).geometry;
  const mb = Study.mapBodies(baseBodies, g2.bodies, ctx.classify);
  check('body classes carry over by name', mb.unmatched.length === 0 && mb.cls[9] === 'coil' && mb.role[2] === 'rotor');
  const prob2 = F.buildProblem(F.buildGrid(g2.bodies, { hmax: 0.75 }), Object.assign({}, baseCfg, { cls: mb.cls, role: mb.role }), null);
  const un = Study.mapGaps(ctx.base.gaps, prob2.gaps, g2.bodies.map(Study.bodyKey));
  check('gap flags carry over to a changed geometry', un === 0 && prob2.gaps.filter(g => g.dir === 'z').every(g => !g.torque) && prob2.gaps.some(g => g.torque),
    `${prob2.gaps.length} gaps, ${un} unmatched`);
  const G0 = F.buildGrid(base.bodies, { hmax: 0.75 });
  check('coil pick in solid steel is reported as lost', Study.coilMaskFromPicks(F, G0, [[52, 20]]) === 'lost');

  // --- metrics respond to geometry
  const a = await Study.evaluateGeometry(ctx, base, 2.5), b = await Study.evaluateGeometry(ctx, demo.cad.build({ gap: 1.0 }).geometry, 2.5);
  check('baseline evaluates', a.status === 'ok' && a.metrics.T > 0 && a.metrics.converged, `T ${a.metrics.T.toFixed(3)} N·m, NI ${a.metrics.NI.toFixed(0)}`);
  check('wider gap gives less torque', b.metrics.T < a.metrics.T, `${b.metrics.T.toFixed(3)} < ${a.metrics.T.toFixed(3)}`);
  check('|B| at a probe point is reported', a.metrics.Bpoint > 0.3, `${a.metrics.Bpoint.toFixed(3)} T`);
  check('fixed V and gauge: NI changes with the coil window', Math.abs(b.metrics.NI - a.metrics.NI) < 1e-6 &&
    Math.abs((await Study.evaluateGeometry(ctx, demo.cad.build({ ring_t: 9 }).geometry, 2.5)).metrics.NI - a.metrics.NI) > 1);

  // --- constraints and scoring
  const pt = { status: 'ok', metrics: a.metrics, violations: Study.violations(a.metrics, { Pmax: 1, Jmax: null, steelB98Max: null }) };
  check('power limit violation makes the point infeasible', pt.violations.length === 1 && Study.score(pt, 'torque', 'max') === -Infinity);
  check('minimise flips the score', Study.score({ status: 'ok', metrics: a.metrics, violations: [] }, 'mass', 'min') === -2.5);

  // --- optimizer on a known function
  const evals = [];
  const r = await Study.sweep(Study.grid(0, 10, 6), 8, async x => { evals.push(x); return -((x - 3.3) ** 2); }, () => false);
  check('grid + golden refinement finds the optimum', Math.abs(r.best.x - 3.3) < 0.15 && evals.length === 14, `x* ${r.best.x.toFixed(3)} after ${evals.length} evals`);
  const r2 = await Study.sweep(Study.grid(0, 10, 6), 4, async x => (x > 6 ? -Infinity : x), () => false);
  check('infeasible points are skipped and range edge reported', r2.best.x <= 6 && !r2.atEdge);
  const r3 = await Study.sweep(Study.grid(0, 10, 6), 4, async x => x, () => false);
  check('optimum at the range edge is flagged', r3.atEdge && r3.best.x === 10);
  let n = 0;
  await Study.sweep(Study.grid(0, 10, 11), 6, async x => { n++; return x; }, () => n >= 3);
  check('stop request halts the sweep', n === 3);
  check('expressions keep units', Study.expr(6.123456789, 'mm') === '6.12346 mm' && Study.expr(2, '') === '2');

  // --- real 1-D study on the demo: pole lip thickness
  const xs = Study.grid(3, 9, 5), res = [];
  const out = await Study.sweep(xs, 4, async x => {
    const cadr = demo.cad.build({ lip_t: x });
    if (!cadr.feasible) return -Infinity;
    const p = await Study.evaluateGeometry(ctx, cadr.geometry, cadr.massKg);
    res.push([x, p.metrics.T]);
    return Study.score(Object.assign(p, { violations: [] }), 'torque', 'max');
  }, () => false);
  console.log('   lip_t sweep', res.sort((p, q) => p[0] - q[0]).map(([x, t]) => `${x.toFixed(2)}:${t.toFixed(3)}`).join('  '));
  check('lip thickness study returns a best point', out.best && isFinite(out.best.s), `best lip_t ${out.best.x.toFixed(2)} mm, T ${out.best.s.toFixed(3)} N·m`);

  // --- two parameters
  const qp = Study.quadraticPeak([[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]
    .map(([u, v]) => ({ u, v, s: 5 - (u - 0.3) ** 2 - 2 * (v + 0.4) ** 2 + 0.3 * (u - 0.3) * (v + 0.4) })), { u0: -1, u1: 1, v0: -1, v1: 1 });
  check('quadratic surrogate recovers an exact peak', qp && Math.abs(qp.u - 0.3) < 1e-6 && Math.abs(qp.v + 0.4) < 1e-6);
  check('quadratic surrogate refuses a saddle', Study.quadraticPeak([[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]
    .map(([u, v]) => ({ u, v, s: u * u - v * v })), { u0: -1, u1: 1, v0: -1, v1: 1 }) === null);
  const bowl = v => -(((v[0] - 3.3) / 2) ** 2) - (((v[1] - 1.7) / 1) ** 2) + 0.3 * ((v[0] - 3.3) / 2) * (v[1] - 1.7) - 0.15 * Math.sin(3 * v[0]);
  let n2 = 0;
  const r4 = await Study.sweep2(Study.grid(0, 10, 6), Study.grid(0, 5, 6), 10, async v => { n2++; return bowl(v); }, () => false);
  check('2-D grid + surrogate + Nelder-Mead lands near the optimum', Math.abs(r4.best.v[0] - 3.3) < 0.6 && Math.abs(r4.best.v[1] - 1.7) < 0.3 && n2 <= 46,
    `(${r4.best.v[0].toFixed(2)}, ${r4.best.v[1].toFixed(2)}) after ${n2} runs; grid best was (4, 2)`);
  check('2-D refinement improves on the best grid point', r4.best.s > bowl([4, 2]) + 1e-6, `${r4.best.s.toFixed(4)} vs ${bowl([4, 2]).toFixed(4)}`);
  const r5 = await Study.sweep2(Study.grid(0, 10, 6), Study.grid(0, 5, 6), 8, async v => (v[0] + v[1] > 6 ? -Infinity : v[0] + 2 * v[1]), () => false);
  check('2-D search respects an infeasible region', r5.best.v[0] + r5.best.v[1] <= 6 + 1e-9 && r5.best.s >= 10, `best ${r5.best.v.map(x => x.toFixed(2))} score ${r5.best.s.toFixed(2)}`);
  const r6 = await Study.sweep2(Study.grid(0, 10, 4), Study.grid(0, 5, 4), 6, async v => v[0] - v[1], () => false);
  check('2-D edge optimum is flagged per parameter', r6.atEdge[0] && r6.atEdge[1]);
  let n3 = 0;
  await Study.sweep2(Study.grid(0, 1, 5), Study.grid(0, 1, 5), 6, async v => { n3++; return 0; }, () => n3 >= 7);
  check('2-D stop request halts the sweep', n3 === 7);

  const res2 = [];
  const out2 = await Study.sweep2(Study.grid(4, 8, 3), Study.grid(5, 9, 3), 5, async v => {
    const cadr = demo.cad.build({ lip_t: v[0], ring_t: v[1] });
    if (!cadr.feasible) return -Infinity;
    const p = await Study.evaluateGeometry(ctx, cadr.geometry, cadr.massKg);
    const pt = Object.assign(p, { violations: Study.violations(p.metrics, { Pmax: 30, Jmax: 6, steelB98Max: null }) });
    res2.push(v);
    return Study.score(pt, 'torque', 'max');
  }, () => false);
  check('2-D demo study (lip_t x ring_t) returns a feasible best', out2.best && isFinite(out2.best.s),
    `best lip_t ${out2.best.v[0].toFixed(2)}, ring_t ${out2.best.v[1].toFixed(2)} mm, T ${out2.best.s.toFixed(3)} N·m in ${res2.length} runs`);

  // --- design map (full-factorial multi-variable sweep): force and steel mass
  const fac = Study.factorial([[1, 2, 3], [10, 20]]);
  check('factorial covers every combination, first axis fastest', fac.length === 6 && fac[0].join() === '1,10' && fac[1].join() === '2,10' && fac[5].join() === '3,20');
  check('factorial of three axes', Study.factorial([[1, 2], [3, 4], [5, 6, 7]]).length === 12);
  const pf = Study.pareto([{ x: 1, y: 5 }, { x: 2, y: 4 }, { x: 2, y: 8 }, { x: 3, y: 7 }, { x: 4, y: 9 }]);
  check('pareto keeps the lightest point for each force level', pf.map(q => q.x + ':' + q.y).join(' ') === '1:5 2:8 4:9', pf.map(q => q.x + ':' + q.y).join(' '));
  const Gm = F.buildGrid(base.bodies, { hmax: 0.75 }), clsM = base.bodies.map(b => baseBodies.get(Study.bodyKey(b)).cls);
  const smCad = Study.steelMass(Gm, base.bodies, clsM);
  const smSec = Study.steelMass(Gm, base.bodies.map(b => Object.assign({}, b, { massKg: undefined })), clsM);
  check('steel mass from CAD body masses and from the section agree', smCad.source === 'cad' && smSec.source === 'section' && near(smSec.kg, smCad.kg, 0.03),
    `CAD ${smCad.kg.toFixed(3)} kg, section ${smSec.kg.toFixed(3)} kg`);
  check('default demo parameters reproduce the base geometry', JSON.stringify(demo.cad.build({ outer_d: 110, length: 40 }).geometry.bodies) === JSON.stringify(base.bodies));
  const ctxF = Object.assign({}, ctx, { P: Object.assign({}, P, { rForce: 30, ratio: 1 }), point: null });
  const map = [];
  for (const v of Study.factorial([[100, 120], [36, 50]])) {
    const bd = demo.cad.build({ outer_d: v[0], length: v[1] });
    const r = bd.feasible ? await Study.evaluateGeometry(ctxF, bd.geometry, bd.massKg) : { status: 'cad' };
    map.push({ v, r });
  }
  const okM = map.every(o => o.r.status === 'ok' && o.r.metrics.Fkgf > 0 && o.r.metrics.steelMassKg > 0);
  check('demo design map (outer_d x length) solves every combination', okM,
    map.map(o => `${o.v.join('x')}: ${o.r.metrics ? o.r.metrics.Fkgf.toFixed(1) + ' kgf / ' + o.r.metrics.steelMassKg.toFixed(2) + ' kg' : o.r.status}`).join('; '));
  if (okM) {
    const m = (d, l) => map.find(o => o.v[0] === d && o.v[1] === l).r.metrics;
    check('force is torque at the force radius', near(m(100, 36).Fkgf, m(100, 36).T / 0.03 / 9.80665, 1e-9));
    check('a larger, longer brake carries more steel', m(120, 50).steelMassKg > m(100, 36).steelMassKg && m(120, 36).steelMassKg > m(100, 36).steelMassKg);
    check('a longer drum gives more force', m(100, 50).Fkgf > m(100, 36).Fkgf, `${m(100, 50).Fkgf.toFixed(1)} > ${m(100, 36).Fkgf.toFixed(1)} kgf`);
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
