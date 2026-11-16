/* Ferra Brake Analyzer - compute engine.
 *
 * All field solves run through ferraEngine, either inside a Web Worker (UI stays responsive) or inline
 * on the main thread when a worker cannot be created (some embedded browsers block workers on file://).
 * The worker is built from a Blob holding the source text of ferraSolverModule (solver.js) and of the
 * functions below, so no extra file has to be fetched.
 *
 * Engine commands (each is one short job, so the UI can drop stale work between calls):
 *   load  {bodies, hmax, cfg, gaps}        build grid + problem (gaps passed in so both threads agree)
 *   solve {NI, from, keep, fields}         nonlinear solve; warm-start from / store into a named slot
 *   sens  {NI, eps, kind, body}            perturbed solve from the 'op' slot: kind 'ni' | 'all' | 'body'
 */

function ferraEngine(F) {
  'use strict';
  let prob = null;
  let warm = {};

  function need() {
    if (!prob) throw new Error('No problem loaded.');
  }

  function load(a) {
    const G = F.buildGrid(a.bodies, { hmax: a.hmax });
    prob = F.buildProblem(G, a.cfg, a.gaps);
    warm = {};
    return { nGaps: prob.gaps.length, coilAreaM2: prob.coilAreaM2 };
  }

  function solve(a) {
    need();
    const sol = F.solveNI(prob, a.NI, warm[a.from] || warm.op || warm.sweep || null);
    if (a.keep) warm[a.keep] = sol;
    const out = { NI: sol.NI, newton: sol.newton, residual: sol.residual, converged: sol.converged,
      stats: F.gapFieldStats(prob, sol), phi: F.fluxPerTurn(prob, sol) };
    if (a.fields) { out.psi = sol.psi; out.Br = sol.Br; out.Bz = sol.Bz; out.Bm = sol.Bm; out.HB = sol.HB; }
    return out;
  }

  /** One sensitivity solve around the stored operating point. eps = relative step (0.05 = +5 %). */
  function sens(a) {
    need();
    const base = warm.op;
    if (!base) throw new Error('Solve the operating point first.');
    // "+eps flux capacity": the steel's polarisation scaled by (1 + eps) at every H
    const bump = def => {
      const d = typeof def === 'number' ? { kB: 1, kH: 1, scale: def } : Object.assign({}, def);
      d.scale = (d.scale || 1) * (1 + a.eps);
      return F.steelTable(d);
    };
    let p = prob, NI = a.NI;
    if (a.kind === 'ni') NI = a.NI * (1 + a.eps);
    else if (a.kind === 'all') {
      const tables = prob.steelDefs.map(bump);
      p = Object.assign({}, prob, { mats: Object.assign({}, prob.mats, { tables, steel: tables[0] }) });
    } else if (a.kind === 'body') {
      const cm = Int8Array.from(prob.cellMat), cb = prob.G.cellBody;
      let n = 0;
      for (let c = 0; c < cm.length; c++) if (cb[c] === a.body && F.isSteelCode(cm[c])) { cm[c] = F.M_STEEL_P; n++; }
      if (!n) return { kind: a.kind, body: a.body, stats: null, converged: true };
      const def = prob.steelDefs[prob.steelMat[a.body] || 0];
      p = Object.assign({}, prob, { cellMat: cm, mats: Object.assign({}, prob.mats, { steelP: bump(def) }) });
    } else throw new Error('Unknown sensitivity kind ' + a.kind);
    const sol = F.solveNI(p, NI, base);
    return { kind: a.kind, body: a.body, stats: F.gapFieldStats(p, sol), converged: sol.converged };
  }

  return { load, solve, sens };
}

function ferraWorkerBoot(self) {
  'use strict';
  const E = ferraEngine(self.FerraSolver);
  self.onmessage = ev => {
    const { id, cmd, args } = ev.data;
    let msg;
    try { msg = { id, ok: true, r: E[cmd](args) }; } catch (e) { msg = { id, ok: false, err: String((e && e.stack) || e) }; }
    self.postMessage(msg);
  };
}

/** Main-thread client. call(cmd, args) -> Promise. Falls back to inline execution if the worker fails. */
function ferraCompute(F) {
  'use strict';
  let worker = null, engine = null, seq = 0, mode = 'inline', lastLoad = null, alive = false;
  const pending = new Map();

  function goInline(reason) {
    if (worker) { try { worker.terminate(); } catch (e) { /* already dead */ } }
    worker = null;
    engine = ferraEngine(F);
    mode = 'inline' + (reason ? ' (' + reason + ')' : '');
    if (lastLoad) engine.load(lastLoad);
    const items = Array.from(pending.values());
    pending.clear();
    items.forEach(p => call(p.cmd, p.args).then(p.res, p.rej));
  }

  try {
    if (typeof Worker === 'undefined' || typeof ferraSolverModule !== 'function') throw new Error('no worker support');
    const src = ferraSolverModule.toString() + '\nferraSolverModule(self);\n' + ferraEngine.toString() +
      '\n(' + ferraWorkerBoot.toString() + ')(self);\n';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    worker = new Worker(url);
    mode = 'worker';
    worker.onmessage = ev => {
      alive = true;
      const { id, ok, r, err } = ev.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.res(r); else p.rej(new Error(err));
    };
    worker.onerror = ev => {
      if (ev && ev.preventDefault) ev.preventDefault();
      goInline(alive ? 'worker crashed' : 'worker blocked');
    };
  } catch (e) {
    goInline();
  }

  function call(cmd, args) {
    if (cmd === 'load') lastLoad = args;
    if (worker) {
      return new Promise((res, rej) => {
        const id = ++seq;
        pending.set(id, { res, rej, cmd, args });
        worker.postMessage({ id, cmd, args });
      });
    }
    return new Promise((res, rej) => setTimeout(() => {
      try { res(engine[cmd](args)); } catch (e) { rej(e); }
    }, 0));
  }

  return { call, get mode() { return mode; } };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { ferraEngine, ferraCompute };
