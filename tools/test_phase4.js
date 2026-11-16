// Phase 4 tests: wire standards and winding, inductance and response, rotor inertia, calibration fit, section check.
//   node tools/test_phase4.js
const F = require('../palette/solver.js');
const X = require('../palette/extras.js');
const FM = require('../palette/materials.js');
const Study = require('../palette/study.js');
const demo = require('../palette/demo.js');

let fails = 0;
function check(name, ok, info) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`);
  if (!ok) fails++;
}
const near = (a, b, tol) => Math.abs(a / b - 1) < tol;

// --- wires
check('AWG diameters follow the standard', near(F.AWG[30], 0.2546, 0.002) && near(F.AWG[20], 0.8128, 0.002), `AWG30 ${F.AWG[30]}, AWG20 ${F.AWG[20]}`);
check('wire lists run thickest first', ['SWG', 'AWG', 'metric'].every(s => { const l = F.wireList(s); return l.every((o, k) => !k || o.d < l[k - 1].d); }));
check('nearest wire across standards', F.nearestWire('metric', F.SWG[27]) === 0.4 && F.nearestWire('AWG', F.SWG[27]) === 26);
const win = { areaMM2: 15 * 22, rmeanMM: 43, wMM: 22, hMM: 15 };
const base = { V: 24, swg: 27, pack: 0.75, Ilim: 3, tempC: 20, turnsOverride: 0 };
const e0 = F.coilElectrical(win, base), di = F.insulated(F.SWG[27]);
check('random winding matches the old pack formula', e0.Nfit === Math.floor(0.75 * win.areaMM2 / (di * di)), `${e0.Nfit} turns`);
const eL = F.coilElectrical(win, Object.assign({}, base, { winding: 'layer' })), eO = F.coilElectrical(win, Object.assign({}, base, { winding: 'ortho' }));
check('orthocyclic > layer > random(0.75) turns', eO.Nfit > eL.Nfit && eL.Nfit > e0.Nfit, `${eO.Nfit} > ${eL.Nfit} > ${e0.Nfit}`);
check('layer count = turns per layer x layers', eL.Nfit === Math.floor(22 / di) * Math.floor(15 / di));
const eB = F.coilElectrical(win, Object.assign({}, base, { bobbin: 1 }));
check('bobbin wall removes turns', near(eB.Nfit / e0.Nfit, (20 * 14) / (22 * 15), 0.01), `${eB.Nfit} vs ${e0.Nfit}`);
check('voltage drive: NI independent of winding style', near(eO.NI, e0.NI, 1e-9) && near(eL.NI, e0.NI, 1e-9));
const eA = F.coilElectrical(win, Object.assign({}, base, { wire: 'AWG', swg: 26 }));
check('AWG wire resolves', eA.d === F.AWG[26] && eA.Nfit > 0);

// --- inductance and response on a linear coil: tau = N^2 k / R, 90 % current at tau ln 10
const k = 2e-6, N = 500, R = 10, lin = { NI: [0, 1000, 2000, 4000], phi: [0, 1000 * k, 2000 * k, 4000 * k], T: [0, 1, 4, 16] };
const Lx = X.inductance(lin, N, 1000);
check('linear coil: secant = incremental = N^2 k', near(Lx.Lsec, N * N * k, 1e-9) && near(Lx.Linc, N * N * k, 1e-9));
const rs = X.response(lin, { N, R, V: 24, Ilim: 0, Voff: 0.7 });
const tau = N * N * k / R;
check('linear coil: 90 % current at tau ln 10', near(rs.tOn90I, tau * Math.log(10), 0.01), `${(rs.tOn90I * 1e3).toFixed(2)} vs ${(tau * Math.log(10) * 1e3).toFixed(2)} ms`);
// T grows faster than NI here, so 90 % torque needs more than 90 % current: t = tau ln(1 / (1 - NI90 / NIf))
const f90 = X.inverse(lin.NI, lin.T, 0.9 * rs.Tf) / rs.NIf;
check('90 % torque later than 90 % current when T grows faster than NI', f90 > 0.9 && near(rs.tOn90, tau * Math.log(1 / (1 - f90)), 0.01),
  `${(100 * f90).toFixed(1)} % current, ${(rs.tOn90 * 1e3).toFixed(1)} ms`);
const rz = X.response(lin, { N, R, V: 24, Ilim: 0, Voff: 50 });
check('a higher clamp voltage switches off faster', rz.tOff10 < rs.tOff10 / 3, `${(rz.tOff10 * 1e3).toFixed(2)} vs ${(rs.tOff10 * 1e3).toFixed(2)} ms`);
const rl = X.response(lin, { N, R, V: 240, Ilim: 2.4, Voff: 0.7 });
check('current-limited supply (forced) switches on faster', rl.tOn90I < rs.tOn90I / 5 && near(rl.NIf, N * 2.4, 1e-9));

// --- on the demo brake
const CLS = { Shaft: 'nonmag', 'Rotor hub': 'nonmag', Separator: 'nonmag', Coil: 'coil' };
const ROT = new Set(['Shaft', 'Rotor hub', 'Rotor drum']);
const bodies = demo.bodies, cls = bodies.map(b => CLS[b.name] || 'steel'), role = bodies.map(b => (ROT.has(b.name) ? 'rotor' : 'stator'));
const P = { gmaxDetect: 3, torqueGapMax: 1.5, coilRmin: 0, powderMur: 5, powderJs: 0.8 };
const G = F.buildGrid(bodies, { hmax: 0.75 });
const prob = F.buildProblem(G, Study.makeCfg(P, FM.makeDefs({}, []), cls, role, bodies.map(() => '1010'), null), null);
const cw = F.coilWindow(prob);
check('coil window box from the section', near(cw.wMM, 26, 0.05) && near(cw.hMM, 12, 0.08), `${cw.wMM.toFixed(1)} x ${cw.hMM.toFixed(1)} mm`);
const NIs = [100, 300, 600, 1000, 1500, 2500];
let warm = null;
const sweep = NIs.map(NI => { const s = F.solveNI(prob, NI, warm); warm = s; return { NI, phi: F.fluxPerTurn(prob, s), stats: F.gapFieldStats(prob, s), sol: s }; });
const an = F.analyse(prob, sweep[3].sol, bodies.length);
check('flux per turn equals the analyse() linkage', near(sweep[3].phi, an.phiLink, 1e-9));
const tp0 = { tauSat: 60e3, Bs: 0.6 };
const c = X.curve(sweep, sweep.map(p => F.torqueFromStats(prob, p.stats, tp0).total));
const L1 = X.inductance(c, 1000, 300), L2 = X.inductance(c, 1000, 2500);
check('inductance falls as the steel saturates', L2.Linc < L1.Linc && L2.Lsec < L1.Lsec, `Linc ${L1.Linc.toFixed(2)} -> ${L2.Linc.toFixed(2)} H`);
check('energy check: N*NI*phi = 2 x co-energy-free identity (sum H.B dV)', near(an.energyCheck, 1, 0.02));

const rho = b => (cls[b] === 'steel' ? 7850 : 2700);
const J = X.rotorInertia(G, b => role[b] === 'rotor', rho);
const ring = (r0, r1, L, d) => d * Math.PI * L * (Math.pow(r1, 4) - Math.pow(r0, 4)) / 2 * 1e-15; // mm -> m
const Jx = ring(0, 8, 60, 2700) + ring(8, 15, 24, 2700) + ring(15, 29.5, 24, 7850);
check('rotor inertia matches the analytic annuli', near(J.J, Jx, 0.03), `${(J.J * 1e6).toFixed(1)} vs ${(Jx * 1e6).toFixed(1)} kg mm²`);

// --- calibration fit: synthetic measurements from a known shear model
const model = tp => ({ NIs: sweep.map(p => p.NI), Ts: sweep.map(p => F.torqueFromStats(prob, p.stats, tp).total) });
const truth = { tauSat: 48e3, Bs: 0.82 };
const meas = [250, 700, 1200, 2000].map(NI => ({ NI, T: X.interp(model(truth).NIs, model(truth).Ts, NI) }));
const fit = X.fitShear(model, meas, 0.6);
check('two-parameter fit recovers tauSat and Bs', fit.fitBs && near(fit.tauSat, 48e3, 0.02) && near(fit.Bs, 0.82, 0.03) && fit.rms < 0.01,
  `${(fit.tauSat / 1e3).toFixed(1)} kPa, Bs ${fit.Bs.toFixed(3)} T, rms ${(100 * fit.rms).toFixed(2)} %`);
const one = X.fitShear(model, [meas[2]], 0.82);
check('one point fits tauSat only', !one.fitBs && one.Bs === 0.82 && near(one.tauSat, 48e3, 0.01));
const noisy = X.fitShear(model, meas.map((m, i) => ({ NI: m.NI, T: m.T * (1 + (i % 2 ? 0.03 : -0.03)) })), 0.6);
check('noisy data reports a residual', noisy.rms > 0.01 && noisy.rms < 0.06, `rms ${(100 * noisy.rms).toFixed(1)} %`);

// --- section check
const runs = [
  { angle: 0, status: 'ok', metrics: { T: 6.0, coilAreaMM2: 364 }, bodies: ['a', 'b'] },
  { angle: 30, status: 'ok', metrics: { T: 6.1, coilAreaMM2: 364 }, bodies: ['a', 'b'] },
  { angle: 45, status: 'ok', metrics: { T: 5.2, coilAreaMM2: 300 }, bodies: ['a'] },
  { angle: 60, status: 'error', reason: 'no coil' }];
const cmp = X.compareSections(runs);
check('section check flags torque, window and body differences', !cmp.ok && !cmp.rows[1].flags.length && cmp.rows[2].flags.length === 3 && cmp.rows[3].flags.length === 1,
  cmp.rows[2].flags.join('; '));
const demoCad = demo.cad;
const s45 = demoCad.section(45), s0 = demoCad.section(0);
check('demo has a bolt pocket at 45°', s45.bodies.length === s0.bodies.length && JSON.stringify(s45.bodies) !== JSON.stringify(s0.bodies));

// --- found on a real design: a lead-exit hole opens the coil window; a negative gap makes parts intersect
const rect = (r0, r1, z0, z1) => [[r0, z0, r1, z0, r1, z1, r0, z1, r0, z0]];
const frame = [{ name: 'In', polys: rect(10, 12, 0, 20) }, { name: 'Out', polys: rect(20, 22, 0, 20) },
  { name: 'Lo', polys: rect(10, 22, -2, 0) }, { name: 'Hi', polys: rect(10, 22, 20, 22) }];
const ref = F.coilFromPicks(F.buildGrid(frame, { hmax: 0.5 }), [[16, 10]], null);
const leaky = frame.map(b => (b.name === 'Out' ? { name: 'Out', polys: [rect(20, 22, 0, 8)[0], rect(20, 22, 12, 20)[0]] } : b));
const Gl = F.buildGrid(leaky, { hmax: 0.5 });
const lost = F.coilFromPicks(Gl, [[16, 10]], null);
const closed = F.coilFromPicks(Gl, [[16, 10]], { r0: 12, r1: 20, z0: 0, z1: 20 });
let aClosed = 0;
if (closed.mask) closed.mask.forEach((v, c) => { if (v) aClosed += (Gl.rs[c % Gl.nr + 1] - Gl.rs[c % Gl.nr]) * (Gl.zs[(c / Gl.nr | 0) + 1] - Gl.zs[c / Gl.nr | 0]); });
check('a lead hole opens the coil window; the reference outline closes it', ref.hits === 1 && !lost.mask && closed.clipped === 1 && Math.abs(aClosed / 160 - 1) < 0.1,
  `${aClosed.toFixed(0)} mm² vs 160`);
const Go = F.buildGrid([{ name: 'A', polys: rect(0, 10, 0, 10) }, { name: 'B', polys: rect(8, 20, 0, 10) }], { hmax: 0.5 });
check('intersecting bodies are reported with their overlap area', Go.overlaps.length === 1 && Math.abs(Go.overlaps[0].areaMM2 - 20) < 1.5,
  Go.overlaps.length ? Go.overlaps[0].areaMM2.toFixed(1) + ' mm²' : 'none');
check('touching bodies are not an overlap', F.buildGrid([{ name: 'A', polys: rect(0, 10, 0, 10) }, { name: 'B', polys: rect(10, 20, 0, 10) }], { hmax: 0.5 }).overlaps.length === 0);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
