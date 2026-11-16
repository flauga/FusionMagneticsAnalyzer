# Ferra Brake Analyzer (Fusion 360 add-in)

Reads the open brake design, cuts it through the axis, and solves the nonlinear axisymmetric
magnetic field to report torque/force, per-part saturation, the flux bottleneck and coil sizing.
Voltage and wire gauge are live sliders.

## Install
1. Copy the `FerraBrakeAnalyzer` folder to the Fusion add-ins folder
   - Windows: `%appdata%\Autodesk\Autodesk Fusion 360\API\AddIns\`
   - macOS: `~/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/`
2. Fusion → Utilities → Add-Ins (Shift+S) → Add-Ins tab → FerraBrakeAnalyzer → Run.
3. Utilities → Add-ins panel → **Brake Analyzer**. The palette reads the active design on open.

`palette/index.html` also runs in any browser (Open JSON / Load demo brake) for testing without Fusion.

After updating `FerraBrakeAnalyzer.py`, stop and run the add-in again (Utilities → Scripts and Add-Ins → Add-Ins):
Fusion keeps the Python loaded at start-up, while the palette HTML/JS is re-read each time it opens.

## Workflow
1. **Read design from Fusion.** Axis auto-detects from coaxial cylindrical faces (override X/Y/Z).
   Change *Section angle* if bolt holes or slots sit on the cut plane.
2. **Bodies tab.** Check *Treat as* (Magnetic steel / Non-magnetic / Coil / Powder / Ignore),
   *Moves with* (Rotor / Stator) and, for steel, the *Steel grade* (picked from the CAD material name). Defaults come from CAD material and body names; CAD material
   errors (e.g. an O-ring "Separator" left as Steel) must be fixed here. Bearings/fasteners default to Ignore.
3. **Coil.** Mark the coil body as Coil, or click *Pick coil window* and click inside the empty
   winding space. *Coil starts at radius* trims the window (e.g. zip-tie space under a bobbinless coil).
   **Saturation bridges** (under the body table): a notch that leaves a thin steel web holding two halves of a ring
   together saturates by design. Necks up to *Saturation bridges: thin necks up to* (Model settings, default 1.5 mm,
   0 = off) whose removal splits the body in two are found automatically; *Mark a bridge* picks one by clicking it in
   the section. Ignored bridges (hatched blue) stay in the field solve but are left out of the body's saturation stats,
   the steel levers and the "add cross-section here" marker. Each bridge shows its own +10 % steel → torque: negative
   means it shunts flux past the gap; positive means it carries working flux and you are warned to untick *Ignore*.
4. **Working gaps tab.** Gaps = empty space between rotor steel and stator steel (≤ 3 mm).
   Per gap: *Powder* (magnetic fill vs air) and *Torque* (counts toward torque; default on ≤ 1.5 mm).
5. **Balance verdict** (top right). The headline answer: *Well balanced* (steel and ampere-turns limit torque about
   equally), *Not balanced: steel-limited* (with the part to thicken), *Not balanced: ampere-turn limited* (steel has
   headroom: trim it or add NI), *Powder-shear limited*, or *Torque does not respond*. The bar shows the steel vs
   ampere-turn share of the marginal torque gain; chips flag power, current-density, thermal and flux-bypass problems.
   Torque, force and steel mass sit under it. Everything else is folded away: *Why: lever breakdown*, *Field details*
   and *Torque vs ampere-turns* on the right; *More coil details*, *What moves the ampere-turns*, *Thermal*,
   *Response* and *Coil window* on the left (the coil and voltage/gauge readouts stay open). Folds remember their state.
6. Move the **voltage** and **gauge** sliders. Torque/force update instantly from a pre-solved
   T(NI) curve; the field map and bottleneck analysis re-solve ~0.4 s after the slider stops.
7. **Calibrate** the shear model in Model settings: paste one measurement per line (coil current A, force kgf). One
   current level fits τsat; two or more also fit Bs (the bend of the curve). The fit table shows each point's error
   before you click *Use these values*.
8. **Materials tab.** Library grades (1010, 1018, 12L14, C45, pure iron, FeCo, 416, 430, ductile and grey iron)
   with knee and B at 1/5/40 kA/m, a per-grade *Scale* on the polarisation, a B-H plot, and *Add a custom B-H curve*
   (paste H in A/m, B in T). Library curves are typical annealed values derived from the 1010 curve.
9. **Probes tab.** *Add point* / *Add line*, then click the section. Points report |B|, Br, Bz, H, μr; lines report
   mean/max |B| and the flux through the surface the line sweeps around the axis (2π·|ψ(end) − ψ(start)|), with a plot
   of |B| and its across/along components. Probes are saved with the JSON and stay at fixed (r, z) in studies.
10. **Thermal.** Model settings → Thermal: ambient, heat-transfer coefficient h, duty cycle, coil-to-case resistance,
   temperature limit, cooled area (default: outer envelope of the model). The sidebar shows the steady coil temperature,
   cold → hot power / ampere-turns / torque, time to the limit when always on, the longest duty under the limit and the
   thermal time constant. *Solve at steady-state coil temperature* makes the operating point (and studies) use the hot coil.
11. **Optimize tab.** Pick one or two Fusion *user parameters* (Modify → Change Parameters), a range and step count each, an
   objective (torque, brake force, force per kg of steel, steel mass, torque/W, torque/kg, flux utilisation, gap B, |B| at a point, steel B98, mass) and
   limits (coil power and current density from Model settings, optional steel B98 cap). *Run study* sets each value in
   the CAD model, re-cuts the section in the frame of the loaded design, carries your body classes / roles / gap
   flags / coil pick over (matched by component path + body name), and solves at the slider voltage and gauge
   (turns refitted to each coil window). A grid is followed by refinement around the best value: golden-section
   search for one parameter; for two, a quadratic fit through the neighbouring grid runs and a bounded Nelder–Mead
   search within one grid cell of the best grid point. Two-parameter results show as a heatmap (hatched = over a
   limit, grey × = CAD error, dots = refinement runs); click a cell, dot or table row to inspect that variant.
   Runs whose timeline features fail, or whose parts intersect in the section (Fusion rebuilds overlapping bodies
   without an error, e.g. a negative gap), are marked *CAD error*. If a variant's coil space opens to the outside
   (a lead-exit hole at that angle), it is closed at the outline of the original coil window and noted. The original expressions are restored when the study
   ends, is stopped, the palette closes or the add-in stops. Click a row to inspect that variant in the main view
   (CAD unchanged); *Apply to CAD* (click twice) writes the chosen value into the model. *Export CSV* saves every run.
   Outside Fusion the study runs on the demo brake's mock parameters.
12. **Design map tab** (multi-variable sweep). Pick two or three user parameters, each with a min, max and step count.
   Every combination (full factorial, up to 400 runs) is built in the CAD model, re-cut, solved at the slider voltage
   and gauge, and recorded with its brake force, torque, steel mass, total mass, force per kg of steel, current,
   power and steel B98. Steel mass is the CAD mass of the bodies treated as Magnetic steel (the revolved section at
   7850 kg/m³ if a body has no CAD mass). Plots: *Force map* (heat map over parameters 1 × 2 with force and steel mass
   in each cell; any metric can colour it), *Force vs steel mass* (every run, coloured by a parameter, with the
   frontier of the lightest design for each force), and *Force vs parameter 1* (one line per value of parameter 2).
   With three parameters, pick the slice of the third. Hover for values, click a cell, point or row to load that
   variant in the main view (CAD unchanged), *Export CSV* saves every run. Example: sweep outer diameter against axial
   length to compare a thin, large-diameter brake with a small, thick one. Outside Fusion it runs on the demo brake
   (`outer_d`, `length`, `plate_t`, `lip_t`, `gap`, `ring_t`).
13. **Wire and winding** (Model settings → Coil and supply): SWG, AWG or metric (IEC 60317) wire; random winding
   (packing factor), layer wound (square stacking) or orthocyclic; bobbin wall thickness (inner tube + two flanges).
   The gauge slider and Gauge sweep tab follow the chosen standard; the coil panel shows the copper fill.
14. **Response** (sidebar): inductance at the operating point (secant), incremental and unsaturated, L₀/R, time to 90 %
   torque after switch-on and to 10 % after switch-off into a clamp (*Turn-off clamp voltage*, 0.7 V = diode), the
   voltage the switch sees, rotor inertia from the section and the time to stop the rotor alone from *Speed*.
15. **Section check tab.** Re-cuts the design at other angles (relative to the current one), solves each at the current
   voltage and wire and flags angles whose torque or coil window differ by more than the tolerance, or whose body set
   changes. *View* loads that section (view only). Needs Fusion or the demo brake (bolt holes at 45°).
16. **Compare & report tab.** *Save snapshot* stores results, settings, geometry and a thumbnail; the table compares
   snapshots against the first column (*Ref* changes it, *Restore* reloads one). *Export report (HTML)* writes a
   standalone page: inputs, results and limit breakdown, field map, curves, coil/thermal/response, bodies, gaps,
   snapshots and the section check. Snapshots and calibration data are saved in the JSON.

## What is computed
| Output | Method |
|---|---|
| B field | P1 FEM on the (r,z) section, flux function ψ = r·A_φ, nonlinear steel B-H (1010-class) and powder B = μ0H + Js·tanh((μr−1)μ0H/Js). Newton–Raphson on the magnetic energy functional with Armijo line search; MIC(0)-PCG inner solve. |
| Torque | Σ over gap strips τ(B)·2π r²·dl, τ = τsat·tanh(B/Bs), B = strip-averaged gap field. |
| Force | T × ratio / force radius (Model settings). |
| Steel B-H | Per body grade. Grades derive from the measured 1010 curve: B' = scale·kB·(B − μ0H) + μ0·kH·H at H' = kH·H (kB = saturation, kH = field needed). Custom curves: B' = scale·(B − μ0H) + μ0H. Files with the old global steel knee load as a 1010 scale. |
| Saturation per part | Volume-weighted B50/B98, % volume above the knee of the body's grade (B where differential μr < 50; 1.63 T for 1010). |
| Probes | Cell field at points; along lines, |B|, normal/tangential B, and flux 2π·Δψ through the swept surface. |
| Thermal | Lumped: T = T_amb + duty·P(T)·(1/(h·A) + R_coil-case), R(T) iterated; runaway flagged above 1000 °C. τ = heat capacity × thermal resistance; heat capacity from body volumes (steel, aluminium, stainless, brass, plastic by CAD name; coil = copper/resin at the packing factor). |
| Bottleneck | MMF budget: ∫H·B dV over a part ÷ coil flux linkage = ampere-turns that part consumes. Exact identity (Σ parts = NI; "Energy check" ≈ 1.000). The steel part with the largest share is flagged and the centroid of its largest connected saturated region circled. |
| Saturation bridges | Local thickness = shorter of the r and z runs of the body through each cell; connected cells at or under the threshold are a bridge when removing them leaves ≥ 2 pieces of the body each ≥ 4× the neck's section area. Ignored bridges: own MMF bucket (identity still exact), excluded from B98 / saturated % / hot spot, held at their base B-H in the all-steel and per-body sensitivity solves; their own +5 % solve is reported. |
| Limit breakdown | Sensitivity solves around the operating point (+5 % each, warm-started): ampere-turns, all steel's flux capacity, and each steel body that spends ≥ 0.3 % of the MMF. Steel share = steel gain ÷ (steel + ampere-turn gain): > 60 % steel-limited, < 40 % ampere-turn limited, else balanced; powder-shear limited when both gains are small and the shear curve is flat. The body with the largest gain is circled. |
| Electrical regime | Voltage- or current-limited, with the NI / power / torque change for +10 % V, +10 % current limit, +0.05 packing, one gauge thicker and +20 °C. At fixed voltage NI = V·A_wire/(ρ·MLT): turns and packing do not change NI. |
| Knee | Marked on T(NI) where d lnT / d lnNI falls below 0.5. |
| Flux utilisation | Flux through the torque gap ÷ total coil flux (2π·ψmax). Low = steel short-circuit/bypass. |
| Coil | Turns = packing × window / d_enamel² (grade-2 enamel), R = ρ(T)·N·MLT/A, I = min(V/R, supply limit), P, J. Turns override for a known winding. |
| Gauge sweep | Every wire of the chosen standard (SWG 18–38, AWG 14–40, metric 0.1–1.6 mm) at the current voltage; best = most torque within power and current-density limits. |
| Winding | Random: pack × window / d_enamel². Layer: ⌊w/d⌋·⌊h/d⌋. Orthocyclic: hexagonal layers (pitch d·√3/2), shifted layers one turn short when there is no room. Window = bounding box of the coil cells less the bobbin wall; non-rectangular windows scaled by area / box. |
| Inductance | Flux per turn φ = 2π·⟨ψ⟩ over the coil window at each T(NI) sweep point. L = N²·φ/NI (secant), N²·dφ/dNI (incremental). |
| Switching | dλ/dt = v − R·i with λ = N·φ(NI) from the static curve, integrated exactly per linear segment. On: supply V with its current limit; off: freewheel into the clamp voltage. No eddy currents (solid steel slows both edges, often 2–5×), no remanence. |
| Rotor inertia | Σ ρ·r²·dV over rotor bodies of the section (axisymmetric, density from the CAD material). |
| Calibration | Torque is linear in τsat: for each Bs, τsat has a closed-form least-squares value (relative errors); Bs by grid + golden-section search on log Bs (0.05–2.5 T). |
| Section check | Same evaluation as a study run at each angle, in the frame of the loaded design; flags torque or coil-window change > tolerance and bodies missing from the cut. |

Validation (tools/): energy identity 1.000; mesh 1.5 → 0.35 mm changes torque < 0.6 %; Newton converges in 4–9 iterations across 200–4000 A-t.

## Limits
- Axisymmetric: off-plane features (bolts, slots, notches with angular extent) are seen only as cut at the section angle, as a groove all the way round. Use the Section check tab.
- Static field: no eddy currents/shorted turns, no remanence (off-state drag). Switching times are lower bounds.
- Thermal model is lumped (one temperature for the whole brake); coil hot-spot can be well above it. Use the
  coil-to-case resistance to account for that once measured.
- Powder τ(B) defaults (60 kPa, Bs 0.6 T) are uncalibrated; absolute torque is only as good as the calibration. Ratios between design variants are robust.
- Curved faces are rasterised (staircase) at the mesh size; refine *Mesh size* for chamfer-heavy gaps.
- Bridge detection measures thickness along r and z only: a web running diagonally in the section reads thicker than it
  is. Use *Mark a bridge* for those. A bridge made of a separate thin body is found only by *Mark a bridge*.

## Files
- `FerraBrakeAnalyzer.py` — Fusion side: axis detection, section via `TemporaryBRepManager.planeIntersection`, palette I/O, body selection.
- `palette/solver.js` — field solver, gap detection, torque, MMF budget, coil maths (no DOM; runs in Node).
- `palette/compute.js` — runs solves in a Web Worker built from the solver source (falls back to the main thread if workers are blocked).
- `palette/insight.js` — electrical levers, sensitivities, limit classification, knee (no DOM).
- `palette/materials.js` — steel grade library, CAD-name matching, custom B-H parsing, thermal properties (no DOM).
- `palette/extras.js` — inductance, switching transient, rotor inertia, shear-model fit, section comparison (no DOM).
- `palette/study.js` — parameter studies: setup carry-over, objectives/limits, steel mass, full-factorial design maps, force/steel-mass frontier, 1-D grid + golden section, 2-D grid + quadratic surrogate + Nelder–Mead (no DOM).
- `palette/ui.js`, `palette/index.html` — UI.
- `tools/fusion_section_check.js` — runs the palette pipeline in Node on section JSON exported from Fusion (default setup, largest enclosed space as coil).
- `tools/*.js` — Node validation scripts (`node tools/validate_solver.js`, `node tools/test_phase0.js`, `node tools/test_study.js`, `node tools/test_phase1.js`, `node tools/test_phase4.js`, `node tools/test_bridges.js`).
- `PLAN.md` — roadmap (parameter sweep / optimisation, materials, thermal).
