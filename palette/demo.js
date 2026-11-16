/* Demo geometry (mm) for running the palette outside Fusion. Simple drum-rotor powder brake.
 * FERRA_DEMO_CAD mimics the Fusion user parameters so the Optimize tab can run in a plain browser. */
(function (root) {
  function rect(r0, r1, z0, z1) { return [[r0, z0, r1, z0, r1, z1, r0, z1, r0, z0]]; }

  const PARAMS = [
    { name: 'plate_t', value: 6, unit: 'mm', comment: 'Back/front plate thickness' },
    { name: 'lip_t', value: 5, unit: 'mm', comment: 'Pole lip radial thickness' },
    { name: 'gap', value: 0.5, unit: 'mm', comment: 'Radial working gap' },
    { name: 'ring_t', value: 7, unit: 'mm', comment: 'Outer ring radial thickness' }
  ];
  const DENSITY = { 'Aluminum 6061': 2.70, Steel: 7.85, 'Stainless Steel 316': 8.0, Copper: 8.9 * 0.75 }; // g/cm^3

  // Four axial M4 bolt holes through the plates and outer ring, centred at 45, 135, 225 and 315 degrees.
  const BOLT_D = 4.5, BOLT_HALF_ANGLE = 6;
  const inBolt = ang => { const a = ((ang % 90) + 90) % 90; return Math.abs(a - 45) <= BOLT_HALF_ANGLE; };
  /** rect minus the radial band [h0, h1] (a hole the section plane cuts through) */
  function cut(r0, r1, z0, z1, h0, h1) {
    const out = [];
    if (h0 > r0) out.push(rect(r0, Math.min(h0, r1), z0, z1)[0]);
    if (h1 < r1) out.push(rect(Math.max(h1, r0), r1, z0, z1)[0]);
    return out;
  }

  /** Returns {ok, feasible, errors, geometry, massKg} like the Fusion evalPoint action. angle: section angle (deg). */
  function build(v, angle) {
    const p = Object.assign({}, ...PARAMS.map(q => ({ [q.name]: q.value })), v || {});
    const L = 40, lipR0 = 30, Ro = 55;
    const lipR1 = lipR0 + p.lip_t, ringR0 = Ro - p.ring_t;
    const coilR0 = lipR1 + 0.5, coilR1 = ringR0 - 0.5;
    const errors = [];
    if (!(p.plate_t > 0.5 && p.plate_t < 16)) errors.push('Extrude "Plates": plate_t out of range');
    if (!(p.gap > 0.05 && p.gap < 10)) errors.push('Extrude "Drum": gap out of range');
    if (!(p.lip_t > 0.5) || !(p.ring_t > 0.5)) errors.push('Extrude "Pole": thickness must be positive');
    if (!(coilR1 - coilR0 > 1)) errors.push('Extrude "Coil": no room for the coil');
    if (errors.length) return { ok: true, feasible: false, errors };
    const bodies = [
      { name: 'Shaft', material: 'Aluminum 6061', polys: rect(0, 8, -10, 50) },
      { name: 'Rotor hub', material: 'Aluminum 6061', polys: rect(8, 15, 8, 32) },
      { name: 'Rotor drum', material: 'Steel', polys: rect(15, lipR0 - p.gap, 8, 32) },
      { name: 'Back plate', material: 'Steel', polys: rect(12, Ro, 0, p.plate_t) },
      { name: 'Back pole lip', material: 'Steel', polys: rect(lipR0, lipR1, p.plate_t, 18) },
      { name: 'Separator', material: 'Stainless Steel 316', polys: rect(lipR0, lipR1, 18, 22) },
      { name: 'Front pole lip', material: 'Steel', polys: rect(lipR0, lipR1, 22, L - p.plate_t) },
      { name: 'Front plate', material: 'Steel', polys: rect(12, Ro, L - p.plate_t, L) },
      { name: 'Outer ring', material: 'Steel', polys: rect(ringR0, Ro, p.plate_t, L - p.plate_t) },
      { name: 'Coil', material: 'Copper', polys: rect(coilR0, coilR1, p.plate_t + 1, L - p.plate_t - 1) }
    ];
    let mass = 0;
    for (const b of bodies) {
      const pl = b.polys[0], r0 = pl[0], r1 = pl[2], z0 = pl[1], z1 = pl[5];
      mass += Math.PI * (r1 * r1 - r0 * r0) * (z1 - z0) * 1e-3 * (DENSITY[b.material] || 7.85) * 1e-3; // mm^3 -> cm^3, g -> kg
    }
    if (inBolt(angle || 0)) { // the section plane passes through a bolt hole
      const rh = Ro - p.ring_t / 2, h0 = rh - BOLT_D / 2, h1 = rh + BOLT_D / 2;
      for (const b of bodies) if (/plate|Outer ring/.test(b.name)) {
        const pl = b.polys[0];
        b.polys = cut(pl[0], pl[2], pl[1], pl[5], h0, h1);
      }
    }
    bodies.forEach((b, i) => { b.id = i; b.component = 'Demo brake'; b.path = 'Demo brake'; });
    return { ok: true, feasible: true, errors: [], massKg: mass,
      geometry: { ok: true, source: 'Built-in demo brake', axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, bodies, warnings: [] } };
  }

  const demo = build().geometry;
  /** Section at an angle with the current parameter values (mimics the Fusion extract action). */
  const cad = { PARAMS, build, values: {}, section: angle => build(cad.values, angle).geometry };
  if (typeof module !== 'undefined' && module.exports) { module.exports = demo; module.exports.cad = cad; }
  else { root.FERRA_DEMO = demo; root.FERRA_DEMO_CAD = cad; }
})(this);
