/* Ferra Brake Analyzer - material library (no DOM; runs in Node for tests).
 *
 * Steel grades are derived from the measured 1010-class curve in solver.js (STEEL_BH):
 *   J(H) = B(H) - mu0 H   (polarisation of 1010)
 *   grade:  B'(H') = scale * kB * J(H) + mu0 H',   H' = kH * H
 * kB sets the saturation polarisation relative to 1010 (Js ~ 2.0 T); kH > 1 means the grade needs more field for
 * the same polarisation (lower permeability). The values are typical, rounded figures for annealed material; use
 * a supplier curve (Custom B-H) when absolute accuracy matters. `scale` is the user's per-grade adjustment.
 *
 * Custom grades carry their own H/B table: B'(H) = scale * (B - mu0 H) + mu0 H.
 */
function ferraMaterialsModule(root) {
  'use strict';

  const STEELS = [
    { id: '1010', name: 'Low-carbon steel 1008/1010', kB: 1.0, kH: 1.0,
      match: /\b10(0[5-8]|10|12|15)\b|mild|\bms\b|en\s?3\b|s2[37]5|\bcrs\b|\bdc0\d|^steel$/ },
    { id: '1018', name: '1018 / 1020 / EN3B', kB: 0.99, kH: 1.25, match: /\b10(18|20|22)\b|en\s?3b|\bc22\b/ },
    { id: '12L14', name: '12L14 / 11SMnPb30 (free-machining)', kB: 0.97, kH: 1.7, match: /12l14|\b1215\b|11smn|free.?mach|leaded/ },
    { id: 'C45', name: 'EN8 / C45 / 1045 (medium carbon)', kB: 0.97, kH: 2.0, match: /en\s?[89]\b|\bc4[05]\b|\b104[05]\b|ck45|s45c/ },
    { id: 'pureFe', name: 'Pure iron (ARMCO / DT4)', kB: 1.075, kH: 0.45, match: /armco|pure.?iron|\bdt4|electrical iron/ },
    { id: 'FeCo', name: '49Co-2V iron-cobalt (Hiperco 50 / Vacoflux 50)', kB: 1.17, kH: 0.6, match: /hiperco|vacoflux|permendur|\bfeco|cobalt/ },
    { id: '416', name: '410/416 stainless (annealed)', kB: 0.75, kH: 1.3, match: /\b41[06]\b|\b420\b/ },
    { id: '430', name: '430 / 430F stainless (ferritic)', kB: 0.72, kH: 0.7, match: /\b430|\b434\b|\b409\b|\b440/ },
    { id: 'ductile', name: 'Ductile (SG) iron', kB: 0.82, kH: 2.0, match: /ductile|nodular|sg.?iron|\bggg/ },
    { id: 'grey', name: 'Grey cast iron', kB: 0.68, kH: 4.0, match: /grey|gray|cast.?iron|iron\W{0,3}cast|\bgg\s?\d|fc\s?2\d0/ }
  ];
  const DEFAULT_STEEL = '1010';

  /** Steel grade id from a CAD material name ('' -> 1010). */
  function defaultGrade(material) {
    const m = String(material || '').toLowerCase().trim();
    for (const s of STEELS) if (s.id !== '1010' && s.match.test(m)) return s.id;
    return DEFAULT_STEEL;
  }

  /**
   * Parse pasted "H, B" rows (A/m, T); any separator, header lines ignored.
   * Returns {H, B} starting at (0, 0), or {error}.
   */
  function parseBH(text) {
    const H = [], B = [];
    for (const line of String(text).split(/\r?\n/)) {
      const nums = line.trim().split(/[\s,;\t]+/).map(Number).filter(x => isFinite(x));
      if (nums.length < 2) continue;
      H.push(nums[0]); B.push(nums[1]);
    }
    if (H.length < 4) return { error: 'Need at least 4 rows of H (A/m), B (T).' };
    if (H[0] !== 0 || B[0] !== 0) { H.unshift(0); B.unshift(0); }
    for (let k = 1; k < H.length; k++) {
      if (!(H[k] > H[k - 1])) return { error: `H must increase (row ${k}).` };
      if (!(B[k] > B[k - 1])) return { error: `B must increase (row ${k}).` };
    }
    if (B[B.length - 1] > 3.5) return { error: 'B above 3.5 T: is the B column in tesla?' };
    if (H[H.length - 1] < 1000) return { error: 'The curve stops below 1 kA/m; is the H column in A/m?' };
    return { H, B };
  }

  /**
   * Solver material definitions for every library grade plus custom grades.
   * scales: {id: number}; custom: [{id, name, H, B}].  Returns {defs, index: {id: i}, grades: [{id, name, custom}]}.
   */
  function makeDefs(scales, custom) {
    scales = scales || {};
    const defs = [], index = {}, grades = [];
    for (const s of STEELS) {
      index[s.id] = defs.length;
      defs.push({ id: s.id, kB: s.kB, kH: s.kH, scale: scales[s.id] || 1 });
      grades.push({ id: s.id, name: s.name, custom: false });
    }
    for (const c of custom || []) {
      index[c.id] = defs.length;
      defs.push({ id: c.id, H: c.H, B: c.B, scale: scales[c.id] || 1 });
      grades.push({ id: c.id, name: c.name, custom: true });
    }
    return { defs, index, grades };
  }

  // ---------------------------------------------------------------- thermal properties
  // density kg/m^3, specific heat J/(kg K)
  const THERMAL = {
    steel: { rho: 7850, c: 460 },
    aluminium: { rho: 2700, c: 900 },
    stainless: { rho: 8000, c: 500 },
    brass: { rho: 8500, c: 380 },
    copper: { rho: 8900, c: 385 },
    plastic: { rho: 1200, c: 1500 },
    powder: { rho: 3500, c: 500 }
  };

  /** Thermal properties of a body from its class and CAD material name. */
  function thermalOf(cls, material) {
    const m = String(material || '').toLowerCase();
    if (cls === 'steel') return THERMAL.steel;
    if (cls === 'powder') return THERMAL.powder;
    if (cls === 'coil') return THERMAL.copper;
    if (/alumin/.test(m)) return THERMAL.aluminium;
    if (/stainless|inox|\b3\d\d\b/.test(m)) return THERMAL.stainless;
    if (/brass|bronze/.test(m)) return THERMAL.brass;
    if (/copper/.test(m)) return THERMAL.copper;
    if (/nylon|pom|delrin|acetal|abs|pla|petg|ptfe|plastic|rubber|polymer|resin|peek/.test(m)) return THERMAL.plastic;
    return THERMAL.steel;
  }

  const api = { STEELS, DEFAULT_STEEL, defaultGrade, parseBH, makeDefs, THERMAL, thermalOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FerraMaterials = api;
  return api;
}
ferraMaterialsModule(typeof self !== 'undefined' ? self : this);
