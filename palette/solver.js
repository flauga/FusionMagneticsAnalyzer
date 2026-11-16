/* Ferra Brake Analyzer - axisymmetric nonlinear magnetostatic solver.
 *
 * Formulation: flux function psi = r*A_phi on a non-uniform tensor grid in the (r,z) half-plane.
 *   -d/dr( nu/r dpsi/dr ) - d/dz( nu/r dpsi/dz ) = J_phi
 *   Bz = (1/r) dpsi/dr,  Br = -(1/r) dpsi/dz,  flux inside radius r = 2*pi*psi
 * Finite-volume 5-point stencil (SPD), MIC(0)-preconditioned CG, Picard iteration on nu(B)
 * with log-space relaxation. Boundary: psi = 0 on the axis and on the padded outer boundary.
 * Lengths inside the solver are metres; geometry input is mm.
 */
// Named so compute.js can rebuild this module inside a Web Worker from its source text.
function ferraSolverModule(root) {
  'use strict';
  const MU0 = 4e-7 * Math.PI;
  const TWO_PI = 2 * Math.PI;

  // ---------------------------------------------------------------- materials
  // Low-carbon steel (1010/1018 class) B-H curve, FEMM-style data.
  const STEEL_BH = {
    H: [0, 238.7, 318.3, 358.1, 437.7, 477.5, 636.6, 795.8, 1114.1, 1273.2, 1591.5, 2228.2, 3183.1,
      4774.6, 6366.2, 7957.7, 15915.5, 31831, 47746.5, 63662, 79577.5, 159155, 318310],
    B: [0, 0.2003, 0.3204, 0.40045, 0.50055, 0.5606, 0.7908, 0.931, 1.1014, 1.2016, 1.302, 1.4028, 1.524,
      1.626, 1.698, 1.73, 1.87, 1.99, 2.04, 2.07, 2.095, 2.2, 2.4]
  };

  function makeTable(H, B) {
    const W = new Float64Array(H.length); // stored energy density integral of H dB
    for (let k = 1; k < H.length; k++) W[k] = W[k - 1] + 0.5 * (H[k] + H[k - 1]) * (B[k] - B[k - 1]);
    return { H: Float64Array.from(H), B: Float64Array.from(B), W, nu0: H[1] / B[1], n: H.length };
  }

  // Powder: B = mu0 H + Js * tanh((mur-1) mu0 H / Js)  (linear mur at low field, saturates to Js)
  function powderTable(mur, Js) {
    const H = [0], B = [0];
    for (let k = 0; k <= 160; k++) {
      const h = Math.pow(10, -1 + k * 7 / 160); // 0.1 .. 1e6 A/m
      H.push(h);
      B.push(MU0 * h + Js * Math.tanh((mur - 1) * MU0 * h / Js));
    }
    const t = makeTable(H, B);
    t.nu0 = 1 / (MU0 * mur);
    return t;
  }

  // nu(B) = H(B)/B from a monotonic table, mu0 slope beyond the table
  function nuOf(t, b) {
    if (b < 1e-6) return t.nu0;
    const Bt = t.B, Ht = t.H, n = t.n;
    if (b >= Bt[n - 1]) return (Ht[n - 1] + (b - Bt[n - 1]) / MU0) / b;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (Bt[m] > b) hi = m; else lo = m; }
    return (Ht[lo] + (Ht[hi] - Ht[lo]) * (b - Bt[lo]) / (Bt[hi] - Bt[lo])) / b;
  }

  // differential reluctivity dH/dB (used for the quasi-Newton tangent)
  function nudOf(t, b) {
    const Bt = t.B, Ht = t.H, n = t.n;
    if (b < 1e-6) return t.nu0;
    if (b >= Bt[n - 1]) return 1 / MU0;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (Bt[m] > b) hi = m; else lo = m; }
    return (Ht[hi] - Ht[lo]) / (Bt[hi] - Bt[lo]);
  }

  // Cell material codes. Steel cells use M_STEEL_BASE + index into the problem's steel definitions
  // (M_STEEL = definition 0). M_STEEL_P: steel of one body re-coded for a sensitivity solve (mats.steelP).
  const M_AIR = 0, M_STEEL = 1, M_POWDER = 2, M_STEEL_P = 3, M_STEEL_BASE = 16;
  const STEEL_KNEE_REF = 1.6; // knee of STEEL_BH
  const isSteelCode = c => c === M_STEEL || c >= M_STEEL_BASE;

  /**
   * Steel B-H table from a definition (see materials.js):
   *   {kB, kH, scale}  derived from STEEL_BH: B' = scale*kB*(B - mu0 H) + mu0 kH H at H' = kH H
   *   {H, B, scale}    custom curve: B' = scale*(B - mu0 H) + mu0 H
   * A bare number k means {kB: 1, kH: 1, scale: k}.
   */
  function steelTable(def) {
    if (def == null || typeof def === 'number') def = { kB: 1, kH: 1, scale: def || 1 };
    const sc = def.scale || 1;
    if (def.H) return makeTable(def.H, def.H.map((h, i) => sc * (def.B[i] - MU0 * h) + MU0 * h));
    const kB = def.kB || 1, kH = def.kH || 1;
    const H = STEEL_BH.H.map(h => h * kH);
    return makeTable(H, STEEL_BH.H.map((h, i) => sc * kB * (STEEL_BH.B[i] - MU0 * h) + MU0 * H[i]));
  }

  /** Knee: B where the differential relative permeability first falls below 50 (about 1.6 T for 1010). */
  function kneeOf(t) {
    for (let k = 1; k < t.n; k++) {
      const mud = (t.B[k] - t.B[k - 1]) / (t.H[k] - t.H[k - 1]) / MU0;
      if (mud < 50) return t.B[k - 1];
    }
    return t.B[t.n - 1];
  }

  /** p.steelDefs: steel definitions (default: one 1010 curve scaled by p.steelScale). */
  function makeMaterials(p) {
    const defs = p.steelDefs && p.steelDefs.length ? p.steelDefs : [p.steelScale || 1];
    const tables = defs.map(steelTable);
    return { tables, steel: tables[0], powder: powderTable(p.powderMur, p.powderJs), nuAir: 1 / MU0 };
  }

  function tableOf(mats, code) {
    if (code >= M_STEEL_BASE) return mats.tables[code - M_STEEL_BASE];
    return code === M_STEEL ? mats.tables[0] : code === M_POWDER ? mats.powder : code === M_STEEL_P ? mats.steelP : null;
  }

  function nuCell(mats, code, b) {
    const t = tableOf(mats, code);
    return t ? nuOf(t, b) : mats.nuAir;
  }

  function nudCell(mats, code, b) {
    const t = tableOf(mats, code);
    return t ? nudOf(t, b) : mats.nuAir;
  }

  // ---------------------------------------------------------------- grid
  function uniqSorted(vals, tol) {
    vals.sort((a, b) => a - b);
    const out = [];
    for (const v of vals) if (!out.length || v - out[out.length - 1] > tol) out.push(v);
    return out;
  }

  // Split each breakpoint interval to <= hmax; intervals 0.2..3 mm (gaps, lips) get >= 3 cells.
  function subdivide(bps, hmax) {
    const out = [bps[0]];
    for (let k = 1; k < bps.length; k++) {
      const a = bps[k - 1], L = bps[k] - a;
      let n = Math.max(1, Math.ceil(L / hmax - 1e-9));
      if (L <= 3 && L >= 0.2) n = Math.max(n, 3);
      for (let s = 1; s <= n; s++) out.push(a + L * s / n);
    }
    return out;
  }

  function padOut(lines, toMin, toMax, h0, growth) {
    const pre = [], post = [];
    let x = lines[0], h = h0;
    while (x > toMin + 1e-9) { h *= growth; x = Math.max(toMin, x - h); pre.unshift(x); }
    x = lines[lines.length - 1]; h = h0;
    while (x < toMax - 1e-9) { h *= growth; x = Math.min(toMax, x + h); post.push(x); }
    return pre.concat(lines, post);
  }

  /**
   * bodies: [{polys:[[r,z,r,z,...],...]}] in mm (full section; r<0 half is ignored by the ray test)
   * Grid lines are placed on every r=const / z=const face so thin gaps are resolved exactly.
   */
  function buildGrid(bodies, opt) {
    const hmax = (opt && opt.hmax) || 0.75;
    let rmax = 0, zmin = Infinity, zmax = -Infinity;
    const rb = [0], zb = [];
    const bb = bodies.map(() => ({ r0: Infinity, r1: -Infinity, z0: Infinity, z1: -Infinity }));
    bodies.forEach((body, bi) => {
      const B = bb[bi];
      for (const pl of body.polys) {
        for (let k = 0; k + 1 < pl.length; k += 2) {
          const r = pl[k], z = pl[k + 1];
          if (r < -1e-6) continue;
          rmax = Math.max(rmax, r); zmin = Math.min(zmin, z); zmax = Math.max(zmax, z);
          B.r0 = Math.min(B.r0, r); B.r1 = Math.max(B.r1, r); B.z0 = Math.min(B.z0, z); B.z1 = Math.max(B.z1, z);
        }
        for (let k = 0; k + 3 < pl.length; k += 2) {
          const r0 = pl[k], z0 = pl[k + 1], r1 = pl[k + 2], z1 = pl[k + 3];
          if (Math.max(r0, r1) < 0) continue;
          if (Math.abs(r1 - r0) < 1e-4 && r0 >= 0) rb.push(r0);
          if (Math.abs(z1 - z0) < 1e-4) zb.push(z0);
        }
      }
    });
    if (!isFinite(zmin)) throw new Error('No section geometry on the positive-r side of the axis.');
    rb.push(rmax); zb.push(zmin, zmax);
    let rs = subdivide(uniqSorted(rb, 0.01), hmax);
    let zs = subdivide(uniqSorted(zb, 0.01), hmax);
    const pad = Math.max(10, 0.6 * Math.max(rmax, zmax - zmin));
    rs = padOut(rs, 0, rmax + pad, hmax, 1.35);
    zs = padOut(zs, zmin - pad, zmax + pad, hmax, 1.35);
    const nr = rs.length - 1, nz = zs.length - 1;
    const cellBody = new Int32Array(nr * nz).fill(-1);
    const rc = new Float64Array(nr), zc = new Float64Array(nz);
    for (let i = 0; i < nr; i++) rc[i] = 0.5 * (rs[i] + rs[i + 1]);
    for (let j = 0; j < nz; j++) zc[j] = 0.5 * (zs[j] + zs[j + 1]);
    const bArea = bb.map(B => (B.r1 - B.r0) * (B.z1 - B.z0));
    const owner = new Float64Array(nr * nz).fill(Infinity); // overlap: smaller body wins
    const overlap = {}; // "a|b" (a < b) -> overlapping section area, mm^2
    for (let j = 0; j < nz; j++) {
      const z = zc[j];
      for (let bi = 0; bi < bodies.length; bi++) {
        const B = bb[bi];
        if (z < B.z0 || z > B.z1) continue;
        const xs = [];
        for (const pl of bodies[bi].polys) {
          for (let k = 0; k + 3 < pl.length; k += 2) {
            const r0 = pl[k], z0 = pl[k + 1], r1 = pl[k + 2], z1 = pl[k + 3];
            if ((z0 > z) !== (z1 > z)) xs.push(r0 + (z - z0) * (r1 - r0) / (z1 - z0));
          }
        }
        if (xs.length < 2) continue;
        xs.sort((a, b) => a - b);
        let p = 0;
        for (let i = 0; i < nr; i++) {
          const r = rc[i];
          if (r > B.r1) break;
          while (p < xs.length && xs[p] <= r) p++;
          if (((xs.length - p) & 1) === 1) {
            const c = j * nr + i;
            if (owner[c] !== Infinity && cellBody[c] !== bi) {
              const a = Math.min(cellBody[c], bi), b = Math.max(cellBody[c], bi), k = a + '|' + b;
              overlap[k] = (overlap[k] || 0) + (rs[i + 1] - rs[i]) * (zs[j + 1] - zs[j]);
            }
            if (bArea[bi] < owner[c]) { owner[c] = bArea[bi]; cellBody[c] = bi; }
          }
        }
      }
    }
    return { rs: Float64Array.from(rs), zs: Float64Array.from(zs), nr, nz, rc, zc, cellBody, bounds: { rmax, zmin, zmax },
      overlaps: Object.keys(overlap).map(k => { const [a, b] = k.split('|').map(Number); return { a, b, areaMM2: overlap[k] }; }) };
  }

  // ---------------------------------------------------------------- gaps
  /**
   * Working gaps = runs of empty/powder cells between steel of a rotor body and steel of a stator body.
   * Radial scan -> cylindrical shear surface, axial scan -> face shear surface.
   * cls[bi] in {'steel','nonmag','powder','coil','ignore'}, role[bi] in {'rotor','stator'}
   */
  function detectGaps(G, cls, role, gmaxDetect) {
    const { nr, nz, rs, zs, cellBody } = G;
    const isSteel = c => c >= 0 && cls[c] === 'steel';
    const isOpen = c => c < 0 || cls[c] === 'powder';
    const segs = [];
    for (let j = 0; j < nz; j++) {
      let i = 0;
      while (i < nr - 1) {
        const a = cellBody[j * nr + i];
        if (isSteel(a) && isOpen(cellBody[j * nr + i + 1])) {
          let k = i + 1;
          while (k < nr && isOpen(cellBody[j * nr + k])) k++;
          if (k < nr) {
            const b = cellBody[j * nr + k], t = rs[k] - rs[i + 1];
            if (isSteel(b) && role[a] !== role[b] && t <= gmaxDetect) segs.push({ dir: 'r', j, i0: i + 1, i1: k - 1, a, b, t });
          }
          i = k;
        } else i++;
      }
    }
    for (let i = 0; i < nr; i++) {
      let j = 0;
      while (j < nz - 1) {
        const a = cellBody[j * nr + i];
        if (isSteel(a) && isOpen(cellBody[(j + 1) * nr + i])) {
          let k = j + 1;
          while (k < nz && isOpen(cellBody[k * nr + i])) k++;
          if (k < nz) {
            const b = cellBody[k * nr + i], t = zs[k] - zs[j + 1];
            if (isSteel(b) && role[a] !== role[b] && t <= gmaxDetect) segs.push({ dir: 'z', i, j0: j + 1, j1: k - 1, a, b, t });
          }
          j = k;
        } else j++;
      }
    }
    const groups = [], open = {};
    segs.sort((p, q) => (p.dir === q.dir ? (p.dir === 'r' ? p.j - q.j : p.i - q.i) : (p.dir < q.dir ? -1 : 1)));
    for (const s of segs) {
      const key = s.dir + ':' + Math.min(s.a, s.b) + ':' + Math.max(s.a, s.b);
      const lst = open[key] || (open[key] = []);
      let g = null;
      for (const cand of lst) {
        const L = cand.segs[cand.segs.length - 1];
        if (s.dir === 'r' && L.j === s.j - 1 && s.i0 <= L.i1 + 1 && s.i1 >= L.i0 - 1) { g = cand; break; }
        if (s.dir === 'z' && L.i === s.i - 1 && s.j0 <= L.j1 + 1 && s.j1 >= L.j0 - 1) { g = cand; break; }
      }
      if (!g) { g = { dir: s.dir, a: s.a, b: s.b, segs: [] }; lst.push(g); groups.push(g); }
      g.segs.push(s);
    }
    groups.forEach((g, n) => {
      let tw = 0, w = 0, area = 0, r0 = Infinity, r1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const s of g.segs) {
        let len, rm;
        if (g.dir === 'r') {
          len = zs[s.j + 1] - zs[s.j]; rm = 0.5 * (rs[s.i0] + rs[s.i1 + 1]);
          r0 = Math.min(r0, rs[s.i0]); r1 = Math.max(r1, rs[s.i1 + 1]); z0 = Math.min(z0, zs[s.j]); z1 = Math.max(z1, zs[s.j + 1]);
        } else {
          len = rs[s.i + 1] - rs[s.i]; rm = 0.5 * (rs[s.i] + rs[s.i + 1]);
          r0 = Math.min(r0, rs[s.i]); r1 = Math.max(r1, rs[s.i + 1]); z0 = Math.min(z0, zs[s.j0]); z1 = Math.max(z1, zs[s.j1 + 1]);
        }
        tw += s.t * len; w += len; area += TWO_PI * rm * len;
      }
      g.id = n + 1; g.thickness = tw / w; g.length = w; g.areaMM2 = area; g.box = { r0, r1, z0, z1 };
    });
    return groups;
  }

  // ---------------------------------------------------------------- saturation bridges
  /** Per steel cell: length of the same-body run through it along r (tr) and along z (tz), mm. */
  function steelRuns(G, isSteel) {
    const { nr, nz, rs, zs, cellBody } = G;
    const tr = new Float64Array(nr * nz), tz = new Float64Array(nr * nz);
    for (let j = 0; j < nz; j++) {
      let i = 0;
      while (i < nr) {
        const b = cellBody[j * nr + i];
        if (!isSteel(b)) { i++; continue; }
        let k = i;
        while (k < nr && cellBody[j * nr + k] === b) k++;
        for (let q = i; q < k; q++) tr[j * nr + q] = rs[k] - rs[i];
        i = k;
      }
    }
    for (let i = 0; i < nr; i++) {
      let j = 0;
      while (j < nz) {
        const b = cellBody[j * nr + i];
        if (!isSteel(b)) { j++; continue; }
        let k = j;
        while (k < nz && cellBody[k * nr + i] === b) k++;
        for (let q = j; q < k; q++) tz[q * nr + i] = zs[k] - zs[j];
        j = k;
      }
    }
    return { tr, tz };
  }

  /**
   * Saturation bridges: thin necks inside one steel body (a notch that leaves a thin web holding two halves of a
   * ring together). They saturate by design and short a little flux; thickening them would add bypass flux, so
   * they must not be read as the steel bottleneck.
   * Auto: connected cells whose local thickness (shorter of the r and z runs through the body) is <= opt.bridgeMax
   * mm, and whose removal splits the body into at least two pieces each >= 4x the neck's section area.
   * opt.bridgePicks [[r, z]]: manual bridges (the thin region around the clicked cell). opt.bridgeOff [[r, z]]:
   * auto bridges within 1.5 mm of these points are reported but not ignored.
   * Returns [{body, cells, areaMM2, volMM3, r, z, thickness, auto, ignore, key}].
   */
  function detectBridges(G, cls, opt) {
    opt = opt || {};
    const { nr, nz, rs, zs, cellBody } = G, nc = nr * nz;
    const tmax = opt.bridgeMax > 0 ? opt.bridgeMax : 0, picks = opt.bridgePicks || [], off = opt.bridgeOff || [];
    const out = [];
    if (!tmax && !picks.length) return out;
    const isSteel = b => b >= 0 && cls[b] === 'steel';
    const { tr, tz } = steelRuns(G, isSteel);
    const thick = c => Math.min(tr[c], tz[c]);
    const area = c => (rs[(c % nr) + 1] - rs[c % nr]) * (zs[((c / nr) | 0) + 1] - zs[(c / nr) | 0]);
    const nbrs = (c, f) => {
      const i = c % nr, j = (c / nr) | 0;
      if (i > 0) f(c - 1);
      if (i < nr - 1) f(c + 1);
      if (j > 0) f(c - nr);
      if (j < nz - 1) f(c + nr);
    };
    const taken = new Uint8Array(nc); // cell belongs to a bridge already
    const grow = (seed, ok, seen) => {
      const b = cellBody[seed], cells = [seed], st = [seed];
      seen[seed] = 1;
      while (st.length) {
        const c = st.pop();
        nbrs(c, n => { if (!seen[n] && cellBody[n] === b && ok(n)) { seen[n] = 1; cells.push(n); st.push(n); } });
      }
      return cells;
    };
    const make = (cells, auto) => {
      let A = 0, V = 0, ra = 0, za = 0, ta = 0;
      for (const c of cells) {
        const a = area(c), r = 0.5 * (rs[c % nr] + rs[(c % nr) + 1]), z = 0.5 * (zs[(c / nr) | 0] + zs[((c / nr) | 0) + 1]);
        A += a; V += TWO_PI * r * a; ra += r * a; za += z * a; ta += thick(c) * a;
        taken[c] = 1;
      }
      const r = ra / A, z = za / A;
      const ignore = !(auto && off.some(([pr, pz]) => Math.hypot(pr - r, pz - z) < 1.5));
      return { body: cellBody[cells[0]], cells, areaMM2: A, volMM3: V, r, z, thickness: ta / A, auto, ignore,
        key: r.toFixed(1) + ',' + z.toFixed(1) };
    };
    // removing `cells` leaves >= 2 pieces of the body each >= minA (mm^2)?
    const splits = (cells, minA) => {
      const b = cellBody[cells[0]], inK = new Uint8Array(nc), seen = new Uint8Array(nc);
      for (const c of cells) inK[c] = 1;
      let big = 0;
      for (const c of cells) {
        nbrs(c, n => {
          if (big >= 2 || inK[n] || seen[n] || cellBody[n] !== b) return;
          let A = 0;
          for (const q of grow(n, q => !inK[q], seen)) A += area(q);
          if (A >= minA) big++;
        });
        if (big >= 2) return true;
      }
      return false;
    };
    if (tmax) {
      const seen = new Uint8Array(nc), thin = c => thick(c) <= tmax + 1e-9;
      for (let c = 0; c < nc; c++) {
        if (seen[c] || !isSteel(cellBody[c]) || !thin(c)) continue;
        const cells = grow(c, thin, seen);
        let A = 0;
        for (const q of cells) A += area(q);
        if (splits(cells, 4 * A)) out.push(make(cells, true));
      }
    }
    const loc = (xs, x) => { if (x < xs[0] || x > xs[xs.length - 1]) return -1; let k = 0; while (k < xs.length - 2 && xs[k + 1] < x) k++; return k; };
    for (const [r, z] of picks) {
      const i = loc(rs, r), j = loc(zs, z);
      if (i < 0 || j < 0) continue;
      const c = j * nr + i;
      if (!isSteel(cellBody[c]) || taken[c]) continue;
      const t0 = thick(c) * 1.25 + 0.05, seen = new Uint8Array(nc);
      out.push(make(grow(c, q => !taken[q] && thick(q) <= t0, seen), false));
    }
    return out;
  }

  // ---------------------------------------------------------------- discretisation
  // Each grid cell is split into two right triangles (P1 FEM):
  //   T1 = (00,10,11)   T2 = (00,11,01)
  // On axis-aligned right triangles the isotropic stiffness has no diagonal coupling, so the
  // isotropic operator is a 5-point stencil (used for the MIC(0) preconditioner). The Newton
  // Jacobian adds an anisotropic (dH/dB - H/B) term along B, applied matrix-free.
  // Energy functional (per radian):  Pi(psi) = sum_e A_e r_e W(B_e) - f.psi,   B_e = |grad psi|/r_e
  function makeSystem(G) {
    const NR = G.nr + 1, NZ = G.nz + 1, N = NR * NZ, nc = G.nr * G.nz;
    const r = new Float64Array(NR), z = new Float64Array(NZ), dr = new Float64Array(G.nr), dz = new Float64Array(G.nz);
    for (let i = 0; i < NR; i++) r[i] = G.rs[i] * 1e-3;
    for (let j = 0; j < NZ; j++) z[j] = G.zs[j] * 1e-3;
    for (let i = 0; i < G.nr; i++) dr[i] = r[i + 1] - r[i];
    for (let j = 0; j < G.nz; j++) dz[j] = z[j + 1] - z[j];
    const free = new Uint8Array(N);
    for (let j = 1; j < NZ - 1; j++) for (let i = 1; i < NR - 1; i++) free[j * NR + i] = 1;
    return { NR, NZ, N, nc, r, z, dr, dz, nr: G.nr, nz: G.nz, free,
      cE: new Float64Array(N), cN: new Float64Array(N), D: new Float64Array(N), dt: new Float64Array(N),
      // per-element state (2 per cell)
      ea: new Float64Array(2 * nc), ec: new Float64Array(2 * nc), egx: new Float64Array(2 * nc), egy: new Float64Array(2 * nc),
      eB: new Float64Array(2 * nc), eH: new Float64Array(2 * nc) };
  }

  // Element gradients of psi -> B, nu, nud. Returns energy Pi (without source term).
  function evalElements(S, psi, cellMat, mats) {
    const { NR, nr, nz, r, dr, dz, ea, ec, egx, egy, eB, eH } = S;
    let E = 0;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nr; i++) {
      const c = j * nr + i, k = j * NR + i, h = dr[i], kz = dz[j], A = 0.5 * h * kz;
      const p00 = psi[k], p10 = psi[k + 1], p01 = psi[k + NR], p11 = psi[k + NR + 1];
      const code = cellMat[c];
      for (let t = 0; t < 2; t++) {
        const e = 2 * c + t;
        const gx = t === 0 ? (p10 - p00) / h : (p11 - p01) / h;
        const gy = t === 0 ? (p11 - p10) / kz : (p01 - p00) / kz;
        const re = r[i] + (t === 0 ? 2 : 1) * h / 3;
        const g = Math.hypot(gx, gy), B = g / re;
        const nu = nuCell(mats, code, B), nud = nudCell(mats, code, B);
        ea[e] = nu * A / re;
        ec[e] = (nud - nu) * A / re;
        egx[e] = g > 0 ? gx / g : 0; egy[e] = g > 0 ? gy / g : 0;
        eB[e] = B; eH[e] = nu * B;
        E += A * re * coenergy(mats, code, B);
      }
    }
    return E;
  }

  function coenergy(mats, code, B) {
    const t = tableOf(mats, code);
    if (!t) return B * B * mats.nuAir * 0.5;
    const Bt = t.B, Ht = t.H, n = t.n, W = t.W;
    if (B >= Bt[n - 1]) { const d = B - Bt[n - 1]; return W[n - 1] + Ht[n - 1] * d + d * d / (2 * MU0); }
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (Bt[m] > B) hi = m; else lo = m; }
    const s = (Ht[hi] - Ht[lo]) / (Bt[hi] - Bt[lo]), d = B - Bt[lo];
    return W[lo] + Ht[lo] * d + 0.5 * s * d * d;
  }

  // y = K(nu) x  (isotropic part) ; with jac=true adds the anisotropic Newton term
  function applyOp(S, x, y, jac) {
    const { NR, nr, nz, dr, dz, ea, ec, egx, egy, free } = S;
    y.fill(0);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nr; i++) {
      const c = j * nr + i, k = j * NR + i, h = dr[i], kz = dz[j];
      const p00 = x[k], p10 = x[k + 1], p01 = x[k + NR], p11 = x[k + NR + 1];
      // T1
      let e = 2 * c, gx = (p10 - p00) / h, gy = (p11 - p10) / kz;
      let vx = ea[e] * gx, vy = ea[e] * gy;
      if (jac) { const s = ec[e] * (egx[e] * gx + egy[e] * gy); vx += s * egx[e]; vy += s * egy[e]; }
      y[k] -= vx / h; y[k + 1] += vx / h - vy / kz; y[k + NR + 1] += vy / kz;
      // T2
      e++; gx = (p11 - p01) / h; gy = (p01 - p00) / kz;
      vx = ea[e] * gx; vy = ea[e] * gy;
      if (jac) { const s = ec[e] * (egx[e] * gx + egy[e] * gy); vx += s * egx[e]; vy += s * egy[e]; }
      y[k] -= vy / kz; y[k + NR + 1] += vx / h; y[k + NR] += vy / kz - vx / h;
    }
    for (let q = 0; q < y.length; q++) if (!free[q]) y[q] = 0;
  }

  // 5-point isotropic preconditioner from element coefficients (geometric mean of nu and nud)
  function buildPrecond(S) {
    const { NR, NZ, nr, nz, dr, dz, ea, ec, cE, cN, D, dt } = S;
    cE.fill(0); cN.fill(0);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nr; i++) {
      const c = j * nr + i, k = j * NR + i, h = dr[i], kz = dz[j];
      const a1 = Math.sqrt(ea[2 * c] * (ea[2 * c] + ec[2 * c]));
      const a2 = Math.sqrt(ea[2 * c + 1] * (ea[2 * c + 1] + ec[2 * c + 1]));
      cE[k] += a1 / (h * h); cN[k + 1] += a1 / (kz * kz);
      cE[k + NR] += a2 / (h * h); cN[k] += a2 / (kz * kz);
    }
    for (let j = 1; j < NZ - 1; j++) for (let i = 1; i < NR - 1; i++) {
      const k = j * NR + i;
      D[k] = cE[k] + cE[k - 1] + cN[k] + cN[k - NR];
    }
    const om = 0.95;
    for (let j = 1; j < NZ - 1; j++) for (let i = 1; i < NR - 1; i++) {
      const k = j * NR + i;
      let d = D[k];
      if (i > 1) { const w = cE[k - 1], dw = dt[k - 1]; d -= w * w / dw; if (j < NZ - 2) d -= om * w * cN[k - 1] / dw; }
      if (j > 1) { const s = cN[k - NR], ds = dt[k - NR]; d -= s * s / ds; if (i < NR - 2) d -= om * s * cE[k - NR] / ds; }
      dt[k] = d > 1e-3 * D[k] ? d : D[k];
    }
  }

  function precond(S, rr, zz, y) {
    const { NR, NZ, cE, cN, dt } = S;
    for (let j = 1; j < NZ - 1; j++) for (let i = 1; i < NR - 1; i++) {
      const k = j * NR + i;
      y[k] = (rr[k] + cE[k - 1] * y[k - 1] + cN[k - NR] * y[k - NR]) / dt[k];
    }
    for (let j = NZ - 2; j >= 1; j--) for (let i = NR - 2; i >= 1; i--) {
      const k = j * NR + i;
      zz[k] = y[k] + (cE[k] * zz[k + 1] + cN[k] * zz[k + NR]) / dt[k];
    }
  }

  function dot(a, b) { let s = 0; for (let k = 0; k < a.length; k++) s += a[k] * b[k]; return s; }

  function pcg(S, b, x, tol, maxit) {
    const N = S.N;
    const r = new Float64Array(N), z = new Float64Array(N), p = new Float64Array(N), q = new Float64Array(N), y = new Float64Array(N);
    applyOp(S, x, q, true);
    for (let k = 0; k < N; k++) r[k] = S.free[k] ? b[k] - q[k] : 0;
    const bn = Math.sqrt(dot(b, b)) || 1;
    precond(S, r, z, y);
    p.set(z);
    let rz = dot(r, z), it = 0, res = Math.sqrt(dot(r, r)) / bn;
    while (it < maxit && res > tol) {
      applyOp(S, p, q, true);
      const alpha = rz / dot(p, q);
      for (let k = 0; k < N; k++) { x[k] += alpha * p[k]; r[k] -= alpha * q[k]; }
      precond(S, r, z, y);
      const rz2 = dot(r, z), beta = rz2 / rz; rz = rz2;
      for (let k = 0; k < N; k++) p[k] = z[k] + beta * p[k];
      res = Math.sqrt(dot(r, r)) / bn; it++;
    }
    return { it, res };
  }

  /**
   * Nonlinear solve at ampere-turns NI: Newton-Raphson on the convex magnetic energy functional,
   * matrix-free anisotropic Jacobian, MIC(0)-PCG inner solve, Armijo backtracking on energy.
   */
  function solveNI(prob, NI, warm, opt) {
    opt = opt || {};
    const { S, cellMat, coilMask, coilAreaM2, mats } = prob;
    const { NR, nr, nz, N, nc, r, dr, dz, free } = S;
    const psi = warm && warm.psi ? Float64Array.from(warm.psi) : new Float64Array(N);
    if (warm && warm.psi && warm.NI > 0) { const s = NI / warm.NI; for (let k = 0; k < N; k++) psi[k] *= s; }
    const f = new Float64Array(N);
    const J = coilAreaM2 > 0 ? NI / coilAreaM2 : 0;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nr; i++) {
      const c = j * nr + i; if (!coilMask[c]) continue;
      const q = J * dr[i] * dz[j] / 6, k = j * NR + i; // each triangle gives J*A/3 to its 3 nodes
      f[k] += 2 * q; f[k + 1] += q; f[k + NR] += q; f[k + NR + 1] += 2 * q;
    }
    for (let k = 0; k < N; k++) if (!free[k]) f[k] = 0;
    const fn = Math.sqrt(dot(f, f)) || 1;
    const Kx = new Float64Array(N), R = new Float64Array(N), trial = new Float64Array(N);
    const energy = x => evalElements(S, x, cellMat, mats) - dot(f, x);
    let Pi = energy(psi), res = 1, it = 0, cgIt = 0;
    const tol = opt.tol || 1e-6, maxIt = opt.maxNewton || 50;
    for (it = 0; it < maxIt; it++) {
      applyOp(S, psi, Kx, false);
      for (let k = 0; k < N; k++) R[k] = free[k] ? f[k] - Kx[k] : 0;
      res = Math.sqrt(dot(R, R)) / fn;
      if (res < tol) break;
      buildPrecond(S);
      const d = new Float64Array(N);
      cgIt += pcg(S, R, d, Math.min(1e-3, Math.max(1e-9, 0.05 * res)), 4000).it;
      const slope = dot(R, d);
      let lam = 1, Pt = Pi, ok = false;
      for (let ls = 0; ls < 30; ls++) {
        for (let k = 0; k < N; k++) trial[k] = psi[k] + lam * d[k];
        Pt = energy(trial);
        if (Pt <= Pi - 1e-4 * lam * slope) { ok = true; break; }
        lam *= 0.5;
      }
      // Near convergence the energy decrease drops below float round-off: accept the full Newton step.
      if (!ok && res < 1e-4) { for (let k = 0; k < N; k++) psi[k] += d[k]; Pi = energy(psi); }
      else { psi.set(trial); Pi = Pt; }
      if (!ok && res < 1e-4) { it++; break; }
    }
    evalElements(S, psi, cellMat, mats);
    // cell-level fields (average of the two triangles)
    const Br = new Float32Array(nc), Bz = new Float32Array(nc), Bm = new Float64Array(nc), HB = new Float64Array(nc);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nr; i++) {
      const c = j * nr + i;
      let br = 0, bz = 0, bm = 0, hb = 0;
      for (let t = 0; t < 2; t++) {
        const e = 2 * c + t, B = S.eB[e];
        bz += 0.5 * S.egx[e] * B; br -= 0.5 * S.egy[e] * B; bm += 0.5 * B; hb += 0.5 * S.eH[e] * B;
      }
      Br[c] = br; Bz[c] = bz; Bm[c] = bm; HB[c] = hb;
    }
    return { NI, psi, Br, Bz, Bm, HB, newton: it, cgIt, residual: res, converged: res < 1e-4 };
  }

  // ---------------------------------------------------------------- post-processing
  function tau(B, tp) { return tp.tauSat * Math.tanh(B / tp.Bs); }

  /** Per-gap segment field averages (independent of shear-model parameters). */
  function gapFieldStats(prob, sol) {
    const { G, S } = prob;
    const { nr, rs } = G;
    return prob.gaps.map(g => {
      const seg = [];
      let flux = 0, bsum = 0, wsum = 0;
      for (const s of g.segs) {
        let Bs = 0, Fs = 0, A = 0, rm, len;
        if (g.dir === 'r') {
          for (let i = s.i0; i <= s.i1; i++) { const c = s.j * nr + i, w = S.dr[i]; Bs += sol.Bm[c] * w; Fs += Math.abs(sol.Br[c]) * w; A += w; }
          rm = 0.5 * (rs[s.i0] + rs[s.i1 + 1]) * 1e-3; len = S.dz[s.j];
        } else {
          for (let j = s.j0; j <= s.j1; j++) { const c = j * nr + s.i, w = S.dz[j]; Bs += sol.Bm[c] * w; Fs += Math.abs(sol.Bz[c]) * w; A += w; }
          rm = 0.5 * (rs[s.i] + rs[s.i + 1]) * 1e-3; len = S.dr[s.i];
        }
        const Bavg = Bs / A;
        seg.push([Bavg, rm, len]);
        flux += (Fs / A) * TWO_PI * rm * len;
        bsum += Bavg * len; wsum += len;
      }
      return { seg, flux, Bavg: wsum ? bsum / wsum : 0 };
    });
  }

  /** Torque = sum over shear-surface strips of tau(B) * 2*pi*r^2 * strip length. */
  function torqueFromStats(prob, stats, tp) {
    let total = 0;
    const per = stats.map((st, n) => {
      if (!prob.gaps[n].torque) return 0;
      let T = 0;
      for (const [B, rm, len] of st.seg) T += tau(B, tp) * TWO_PI * rm * rm * len;
      total += T;
      return T;
    });
    return { total, per };
  }

  function percentile(pairs, totalW, q) {
    let acc = 0;
    for (const [b, w] of pairs) { acc += w; if (acc >= q * totalW) return b; }
    return pairs.length ? pairs[pairs.length - 1][0] : 0;
  }

  /**
   * Per-body saturation and the energy-weighted MMF budget.
   * Identity: sum over all cells of H.B dV = NI * Phi_link, with Phi_link = 2*pi*<psi>_coil.
   * So (H.B dV summed over a region) / Phi_link = ampere-turns consumed by that region.
   */
  /** steelKnee: saturation threshold, a number for all bodies or omitted to use each body's grade knee. */
  function analyse(prob, sol, nBodies, steelKnee) {
    const kneeOfBody = b => (typeof steelKnee === 'number' ? steelKnee : (prob.bodyKnee && prob.bodyKnee[b]) || STEEL_KNEE_REF);
    const { G, S, coilMask, gapCell } = prob;
    const { nr, nz } = G;
    const NR = S.NR;
    const bodies = [];
    for (let b = 0; b < nBodies; b++) bodies.push({ W: 0, V: 0, BV: 0, sat: 0, pairs: [], max: 0, hr: 0, hz: 0, hotV: 0 });
    const gapsW = new Float64Array(prob.gaps.length + 1);
    // ignored saturation bridges: kept out of their body's saturation stats, MMF reported on its own
    const brs = prob.bridges || [], bc = prob.bridgeCell;
    const brO = brs.map(() => ({ W: 0, V: 0, BV: 0, max: 0, sat: 0 }));
    const satCell = new Uint8Array(nr * nz);
    let airW = 0, totW = 0, psiCoil = 0, coilA = 0, psiMax = 0;
    for (let k = 0; k < sol.psi.length; k++) psiMax = Math.max(psiMax, Math.abs(sol.psi[k]));
    for (let j = 0; j < nz; j++) for (let i = 0; i < nr; i++) {
      const c = j * nr + i, k = j * NR + i;
      const rcm = 0.5 * (S.r[i] + S.r[i + 1]), zcm = 0.5 * (S.z[j] + S.z[j + 1]);
      const dV = TWO_PI * rcm * S.dr[i] * S.dz[j];
      const B = sol.Bm[c], w = sol.HB[c] * dV;
      totW += w;
      if (coilMask[c]) {
        const a = S.dr[i] * S.dz[j];
        psiCoil += 0.25 * (sol.psi[k] + sol.psi[k + 1] + sol.psi[k + NR] + sol.psi[k + NR + 1]) * a; coilA += a;
      }
      const gid = gapCell[c], bi = G.cellBody[c];
      const bn = bc ? bc[c] : 0;
      if (gid > 0) gapsW[gid] += w;
      else if (bn > 0 && brs[bn - 1].ignore) {
        const o = brO[bn - 1];
        o.W += w; o.V += dV; o.BV += B * dV;
        if (B > o.max) o.max = B;
        if (B > kneeOfBody(bi)) o.sat += dV;
      } else if (bi >= 0) {
        const o = bodies[bi];
        o.W += w; o.V += dV; o.BV += B * dV; o.pairs.push([B, dV]);
        if (B > kneeOfBody(bi)) { o.sat += dV; satCell[c] = 1; }
        if (B > o.max) o.max = B;
      } else airW += w;
    }
    // hot spot: centroid of the largest connected saturated region of each body (a centroid over all saturated
    // cells falls between regions, e.g. on the notch between two saturated halves of a ring)
    const seen = new Uint8Array(nr * nz);
    for (let c0 = 0; c0 < nr * nz; c0++) {
      if (!satCell[c0] || seen[c0]) continue;
      const bi = G.cellBody[c0], st = [c0];
      let V = 0, hr = 0, hz = 0;
      seen[c0] = 1;
      while (st.length) {
        const c = st.pop(), i = c % nr, j = (c / nr) | 0;
        const rcm = 0.5 * (S.r[i] + S.r[i + 1]), dV = TWO_PI * rcm * S.dr[i] * S.dz[j];
        V += dV; hr += rcm * dV; hz += 0.5 * (S.z[j] + S.z[j + 1]) * dV;
        const nb = [i > 0 ? c - 1 : -1, i < nr - 1 ? c + 1 : -1, j > 0 ? c - nr : -1, j < nz - 1 ? c + nr : -1];
        for (const n of nb) if (n >= 0 && satCell[n] && !seen[n] && G.cellBody[n] === bi) { seen[n] = 1; st.push(n); }
      }
      const o = bodies[bi];
      if (V > o.hotV) { o.hotV = V; o.hr = hr / V; o.hz = hz / V; }
    }
    const phiLink = coilA > 0 ? TWO_PI * psiCoil / coilA : 0;
    const NI = sol.NI || 1;
    const mmf = w => (phiLink > 0 ? w / phiLink : 0);
    return {
      bodies: bodies.map((o, bi) => {
        o.pairs.sort((p, q) => p[0] - q[0]);
        return {
          id: bi, Bmean: o.V ? o.BV / o.V : 0, Bp50: percentile(o.pairs, o.V, 0.5), Bp98: percentile(o.pairs, o.V, 0.98),
          Bmax: o.max, satFrac: o.V ? o.sat / o.V : 0, mmf: mmf(o.W), mmfPct: 100 * mmf(o.W) / NI,
          hot: o.hotV > 0 ? [o.hr * 1e3, o.hz * 1e3] : null
        };
      }),
      gaps: prob.gaps.map((g, n) => ({ id: g.id, mmf: mmf(gapsW[n + 1]), mmfPct: 100 * mmf(gapsW[n + 1]) / NI })),
      bridges: brO.map((o, n) => ({ id: n, ignored: brs[n].ignore, Bmean: o.V ? o.BV / o.V : null, Bmax: brs[n].ignore ? o.max : null,
        satFrac: o.V ? o.sat / o.V : null, mmfPct: brs[n].ignore ? 100 * mmf(o.W) / NI : null })),
      airMMFpct: 100 * mmf(airW) / NI,
      phiTotal: TWO_PI * psiMax, phiLink,
      energyCheck: phiLink > 0 ? totW / (NI * phiLink) : 0
    };
  }

  /**
   * Flux linked per turn (Wb): 2*pi*psi averaged over the coil window by area (uniformly distributed turns).
   * Flux linkage = N * fluxPerTurn; inductance L = N^2 * fluxPerTurn / NI.
   */
  function fluxPerTurn(prob, sol) {
    const { G, S, coilMask } = prob, NR = S.NR;
    let ps = 0, A = 0;
    for (let j = 0; j < G.nz; j++) for (let i = 0; i < G.nr; i++) if (coilMask[j * G.nr + i]) {
      const k = j * NR + i, a = S.dr[i] * S.dz[j];
      ps += 0.25 * (sol.psi[k] + sol.psi[k + 1] + sol.psi[k + NR] + sol.psi[k + NR + 1]) * a; A += a;
    }
    return A > 0 ? TWO_PI * ps / A : 0;
  }

  // ---------------------------------------------------------------- problem setup
  /**
   * cfg: {cls[], role[], gmaxDetect, torqueGapMax, coilExtra (mask|null), coilRmin (mm), powderMur, powderJs}
   * gapsIn: reuse a gap list (keeps user's per-gap powder/torque flags)
   */
  function buildProblem(G, cfg, gapsIn) {
    const { nr, nz, cellBody } = G;
    const nc = nr * nz;
    const gaps = gapsIn || detectGaps(G, cfg.cls, cfg.role, cfg.gmaxDetect);
    if (!gapsIn) gaps.forEach(g => { g.powder = true; g.torque = g.thickness <= cfg.torqueGapMax; });
    const cellMat = new Int8Array(nc), coilMask = new Uint8Array(nc), gapCell = new Int32Array(nc);
    for (let c = 0; c < nc; c++) {
      const b = cellBody[c];
      if (b < 0) continue;
      const k = cfg.cls[b];
      if (k === 'steel') cellMat[c] = M_STEEL_BASE + (cfg.steelMat ? cfg.steelMat[b] || 0 : 0);
      else if (k === 'powder') cellMat[c] = M_POWDER;
      else if (k === 'coil') coilMask[c] = 1;
    }
    if (cfg.coilExtra) for (let c = 0; c < nc; c++) if (cfg.coilExtra[c] && cellBody[c] < 0) coilMask[c] = 1;
    if (cfg.coilRmin > 0) for (let j = 0; j < nz; j++) for (let i = 0; i < nr; i++) if (G.rc[i] < cfg.coilRmin) coilMask[j * nr + i] = 0;
    gaps.forEach((g, n) => {
      for (const s of g.segs) {
        if (g.dir === 'r') for (let i = s.i0; i <= s.i1; i++) { const c = s.j * nr + i; gapCell[c] = n + 1; if (g.powder) cellMat[c] = M_POWDER; }
        else for (let j = s.j0; j <= s.j1; j++) { const c = j * nr + s.i; gapCell[c] = n + 1; if (g.powder) cellMat[c] = M_POWDER; }
      }
    });
    for (let c = 0; c < nc; c++) if (gapCell[c]) coilMask[c] = 0; // a picked window must not swallow a working gap
    const S = makeSystem(G);
    let coilAreaM2 = 0, rA = 0, cr0 = Infinity, cr1 = -Infinity, cz0 = Infinity, cz1 = -Infinity;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nr; i++) if (coilMask[j * nr + i]) {
      const a = S.dr[i] * S.dz[j]; coilAreaM2 += a; rA += a * 0.5 * (S.r[i] + S.r[i + 1]);
      cr0 = Math.min(cr0, G.rs[i]); cr1 = Math.max(cr1, G.rs[i + 1]); cz0 = Math.min(cz0, G.zs[j]); cz1 = Math.max(cz1, G.zs[j + 1]);
    }
    const coilBox = coilAreaM2 > 0 ? { r0: cr0, r1: cr1, z0: cz0, z1: cz1 } : null; // mm
    const mats = makeMaterials(cfg);
    const steelDefs = cfg.steelDefs && cfg.steelDefs.length ? cfg.steelDefs : [cfg.steelScale || 1];
    const knees = mats.tables.map(kneeOf);
    const steelMat = cfg.cls.map((k, b) => (cfg.steelMat ? cfg.steelMat[b] || 0 : 0));
    const bodyKnee = cfg.cls.map((k, b) => (k === 'steel' ? knees[steelMat[b]] : null));
    const bridges = detectBridges(G, cfg.cls, cfg);
    const bridgeCell = new Int32Array(nc); // 1-based bridge index
    bridges.forEach((br, n) => { for (const c of br.cells) bridgeCell[c] = n + 1; });
    return { G, S, gaps, cellMat, coilMask, gapCell, coilAreaM2, coilRmean: coilAreaM2 ? rA / coilAreaM2 : 0, coilBox, mats,
      steelDefs, steelMat, knees, bodyKnee, bridges, bridgeCell };
  }

  /**
   * Flood-fill empty cells from (i,j). Returns a mask, or null when the region leaks to the domain boundary.
   * box {r0, r1, z0, z1} (mm, optional): cells whose centre lies outside it count as walls.
   */
  function floodEmpty(G, i0, j0, box) {
    const { nr, nz, cellBody } = G;
    if (cellBody[j0 * nr + i0] >= 0) return null;
    const inBox = box ? c => { const r = G.rc[c % nr], z = G.zc[(c / nr) | 0]; return r >= box.r0 && r <= box.r1 && z >= box.z0 && z <= box.z1; } : () => true;
    if (!inBox(j0 * nr + i0)) return null;
    const mask = new Uint8Array(nr * nz), st = [j0 * nr + i0];
    mask[st[0]] = 1;
    let open = false;
    while (st.length) {
      const c = st.pop(), i = c % nr, j = (c / nr) | 0;
      if (i === nr - 1 || j === 0 || j === nz - 1) open = true;
      const nb = [];
      if (i > 0) nb.push(c - 1);
      if (i < nr - 1) nb.push(c + 1);
      if (j > 0) nb.push(c - nr);
      if (j < nz - 1) nb.push(c + nr);
      for (const n of nb) if (!mask[n] && cellBody[n] < 0 && inBox(n)) { mask[n] = 1; st.push(n); }
    }
    return open ? null : mask;
  }

  /**
   * Coil window from picked points. A pick whose region leaks (a lead-wire hole, a slot at this section angle) is
   * retried inside refBox, the window the picks enclosed on the reference geometry, grown by 10 % (at least 1 mm).
   * Returns {mask, hits, clipped} (mask null when no pick worked).
   */
  function coilFromPicks(G, picks, refBox) {
    const mask = new Uint8Array(G.nr * G.nz);
    let hits = 0, clipped = 0;
    const box = refBox ? (() => {
      const mr = Math.max(1, 0.1 * (refBox.r1 - refBox.r0)), mz = Math.max(1, 0.1 * (refBox.z1 - refBox.z0));
      return { r0: refBox.r0 - mr, r1: refBox.r1 + mr, z0: refBox.z0 - mz, z1: refBox.z1 + mz };
    })() : null;
    const loc = (xs, x) => { if (x < xs[0] || x > xs[xs.length - 1]) return -1; let k = 0; while (k < xs.length - 2 && xs[k + 1] < x) k++; return k; };
    for (const [r, z] of picks || []) {
      const i = loc(G.rs, r), j = loc(G.zs, z);
      if (i < 0 || j < 0) continue;
      let m = floodEmpty(G, i, j);
      if (!m && box) { m = floodEmpty(G, i, j, box); if (m) clipped++; }
      if (m) { hits++; for (let c = 0; c < m.length; c++) if (m[c]) mask[c] = 1; }
    }
    return { mask: hits ? mask : null, hits, clipped };
  }

  // ---------------------------------------------------------------- coil / wire
  const SWG = { 18: 1.219, 19: 1.016, 20: 0.914, 21: 0.813, 22: 0.711, 23: 0.610, 24: 0.559, 25: 0.508, 26: 0.457,
    27: 0.4166, 28: 0.3759, 29: 0.3454, 30: 0.3150, 31: 0.2946, 32: 0.2743, 33: 0.2540, 34: 0.2337, 35: 0.2134,
    36: 0.1930, 37: 0.1727, 38: 0.1524 };
  // Grade-2 enamel overall diameter, fit to IEC 60317 maxima (0.2 mm +0.035, 0.4 mm +0.054, 1.0 mm +0.093)
  const insulated = d => d + 0.093 * Math.pow(d, 0.6);

  // AWG: d = 0.127 mm * 92^((36 - n) / 39). Metric: IEC 60317 R20 nominal bare diameters.
  const AWG = {};
  for (let n = 14; n <= 40; n++) AWG[n] = +(0.127 * Math.pow(92, (36 - n) / 39)).toFixed(4);
  const METRIC = [1.6, 1.4, 1.25, 1.12, 1.0, 0.9, 0.8, 0.71, 0.63, 0.56, 0.5, 0.45, 0.4, 0.355, 0.315, 0.28, 0.25, 0.224, 0.2,
    0.18, 0.16, 0.14, 0.125, 0.112, 0.1];
  const WIRES = {
    SWG: { label: 'SWG', keys: Object.keys(SWG).map(Number).sort((a, b) => a - b), dia: k => SWG[k], name: k => 'SWG ' + k },
    AWG: { label: 'AWG', keys: Object.keys(AWG).map(Number).sort((a, b) => a - b), dia: k => AWG[k], name: k => 'AWG ' + k },
    metric: { label: 'Metric (mm)', keys: METRIC.slice(), dia: k => (METRIC.indexOf(+k) >= 0 ? +k : undefined), name: k => (+k).toFixed(k < 0.2 ? 3 : 2) + ' mm' }
  };
  /** Wire keys of a standard, thickest first: [{key, d, name}]. */
  function wireList(std) {
    const w = WIRES[std] || WIRES.SWG;
    return w.keys.map(k => ({ key: k, d: w.dia(k), name: w.name(k) }));
  }
  function wireDia(std, key) { return (WIRES[std] || WIRES.SWG).dia(key); }
  /** Key of the wire in `std` closest in diameter to d (mm). */
  function nearestWire(std, d) {
    let best = null;
    for (const o of wireList(std)) if (!best || Math.abs(Math.log(o.d / d)) < Math.abs(Math.log(best.d / d))) best = o;
    return best.key;
  }

  /**
   * Turns that fit. win: {areaMM2, wMM (axial), hMM (radial)}; p.winding 'random' (pack x area / di^2), 'layer'
   * (square stacking, about pi/4 copper fill) or 'ortho' (orthocyclic, hexagonal). p.bobbin = wall thickness (mm):
   * one inner tube plus two end flanges. Non-rectangular windows scale the layer counts by area / (w * h).
   */
  function windTurns(win, di, p) {
    const wall = Math.max(0, p.bobbin || 0), mode = p.winding || 'random';
    let area = win.areaMM2;
    const w = win.wMM, h = win.hMM;
    if (w > 0 && h > 0) {
      const fill = Math.min(1, area / (w * h));
      const we = Math.max(0, w - 2 * wall), he = Math.max(0, h - wall);
      if (mode === 'layer') return Math.max(0, Math.floor(Math.floor(we / di) * Math.floor(he / di) * fill));
      if (mode === 'ortho') {
        const per = Math.floor(we / di), layers = he >= di ? 1 + Math.floor((he - di) / (di * Math.sqrt(3) / 2)) : 0;
        const fewer = per * di + di / 2 > we ? Math.floor(layers / 2) : 0; // shifted layers lose a turn if no room
        return Math.max(0, Math.floor((per * layers - fewer) * fill));
      }
      area *= (we * he) / (w * h);
    }
    return Math.max(0, Math.floor(p.pack * area / (di * di)));
  }

  /** Coil window from a problem: {areaMM2, rmeanMM, wMM, hMM}. */
  function coilWindow(prob) {
    if (!prob || !prob.coilAreaM2) return { areaMM2: 0, rmeanMM: 0, wMM: 0, hMM: 0 };
    const b = prob.coilBox;
    return { areaMM2: prob.coilAreaM2 * 1e6, rmeanMM: prob.coilRmean * 1e3, wMM: b ? b.z1 - b.z0 : 0, hMM: b ? b.r1 - b.r0 : 0 };
  }

  /** win: {areaMM2, rmeanMM, wMM?, hMM?}; p: {V, swg (wire key), wire ('SWG'|'AWG'|'metric'), pack, winding, bobbin, Ilim, tempC, turnsOverride} */
  function coilElectrical(win, p) {
    const d = wireDia(p.wire || 'SWG', p.swg);
    if (!(d > 0)) throw new Error(`Unknown wire ${p.swg} in ${p.wire || 'SWG'}`);
    const di = insulated(d);
    const Abare = Math.PI / 4 * d * d; // mm^2
    const Nfit = win.areaMM2 > 0 ? windTurns(win, di, p) : 0;
    const N = p.turnsOverride > 0 ? p.turnsOverride : Nfit;
    const MLT = TWO_PI * win.rmeanMM * 1e-3;
    const R20 = 1.724e-8 * N * MLT / (Abare * 1e-6);
    const R = R20 * (1 + 0.00393 * (p.tempC - 20));
    const Iv = R > 0 ? p.V / R : 0;
    const I = Math.min(Iv, p.Ilim);
    return { d, di, Abare, Nfit, N, MLT, R20, R, I, limitedBy: Iv > p.Ilim ? 'supply limit' : 'coil resistance',
      NI: N * I, P: I * I * R, Jw: Abare > 0 ? I / Abare : 0, lengthM: N * MLT, overfill: p.turnsOverride > Nfit,
      fill: win.areaMM2 > 0 ? N * Abare / win.areaMM2 : 0 };
  }

  const api = { MU0, STEEL_BH, STEEL_KNEE_REF, steelTable, kneeOf, isSteelCode, makeMaterials, nuOf, buildGrid, detectGaps, detectBridges, buildProblem, solveNI, gapFieldStats,
    torqueFromStats, analyse, floodEmpty, coilFromPicks, coilElectrical, SWG, AWG, METRIC, WIRES, wireList, wireDia, nearestWire, windTurns, coilWindow,
    fluxPerTurn, insulated, tau, M_AIR, M_STEEL, M_POWDER, M_STEEL_P, M_STEEL_BASE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FerraSolver = api;
  return api;
}
ferraSolverModule(typeof self !== 'undefined' ? self : this);
