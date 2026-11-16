# Ferra Brake Analyzer — Development Plan

Two goals:
1. **CAD-driven optimisation:** read parameters from the Fusion model, sweep 1–2 of them over a chosen range (all other geometry fixed), and optimise for a chosen output (torque, flux density at points, flux utilisation, …).
2. **More robust analysis and better insight:** the steel-limited / ampere-turn-limited verdict must respond to the inputs, and the tool should explain *why* the brake is limited.

---

## 0. Why the verdict doesn't update (diagnosis)

There are three separate causes. One is real physics that the UI never explains; two are gaps in the model.

### 0.1 Packing factor and current limit don't change the ampere-turns (correct physics, but hidden)
When the coil is driven at a fixed voltage:

NI = N · V / R, and R = ρ · N · MLT / A_wire, so **NI = V · A_wire / (ρ · MLT)**.

The number of turns N cancels out. Checked with `coilElectrical` (window 400 mm², r_mean 30 mm, 24 V, SWG 27):

| pack | Ilim | Turns | I | **NI** | Power |
|---|---|---|---|---|---|
| 0.5 | 3 A | 899 | 1.10 A | **987** | 26.4 W |
| 0.65 | 3 A | 1169 | 0.84 A | **987** | 20.3 W |
| 0.8 | 10 A | 1438 | 0.69 A | **987** | 16.5 W |

Changing the packing factor only trades power for current. The current limit only matters once it drops below V/R (here 1.1 A). The field never changes, so the verdict never changes. The UI should say this explicitly.

### 0.2 "Steel saturation threshold" changes only the display
The B-H curve is hard-coded as `STEEL_BH` in `palette/solver.js`. `steelKnee` only sets the "% saturated" column and the colour map. The steel-limited test in `renderResults()` (`palette/ui.js`) uses each part's share of the ampere-turns (its MMF share), which doesn't depend on `steelKnee`. So the physics stays the same.

### 0.3 The verdict is a binary label with hard-coded thresholds
The thresholds are 12 %, 0.6 × gap MMF, 8 %, utilisation below 60 % and τ above 90 %. "Ampere-turn limited" is only the fallback when nothing else fires. It is judged at a single operating point.

---

## Part A — More robust analysis and better insight

### A1. Real material models (fixes 0.2)
- **Steel library:** 1010/1018, 12L14, EN8/C45, 416/430F stainless, cast iron, and FeCo (Hiperco). Each body gets its own B-H material, defaulting from its CAD material name.
- **"Saturation scale" per material:** it scales the B axis of the curve, so "what if the steel saturated at 1.8 T instead of 1.6 T" actually changes the field.
- **Custom B-H import** from CSV (datasheet or measured).
- **Saturation threshold derived from the material** (for example, B where μr drops below 100) instead of a separate input.
- A matching powder library with Js and μr per grade.

### A2. Replace the label with a limit breakdown based on sensitivities
After each operating-point solve, run a few cheap extra solves (≈0.3 s each, warm-started) and report **elasticities**, the % torque change per 1 % change in each input:
- **∂lnT/∂lnNI:** ampere-turn sensitivity (already exists as `elasticity`).
- **∂lnT/∂ln(steel B scale), per steel body:** re-solve with that body's B-H curve stretched by 5 %. This says exactly which part, if improved, buys the most torque. It's a defensible "steel-limited" test.
- **∂lnT/∂lnτsat and ∂lnT/∂(gap thickness):** powder-limited and gap-limited.

The verdict then becomes a ranked list, for example: "+10 % NI → +3 % T; +10 % steel in *Outer pole* → +7 % T; powder at 82 % of shear saturation." The binary label stays as a one-line summary on top.

Also add:
- **Electrical regime panel.** It says which limit applies (voltage, supply current, power/thermal, or current density) and which inputs actually move NI: V, wire cross-section, mean turn length (MLT), temperature. It explains outright that turns and packing don't change NI at fixed voltage.
- **Regime along the T(NI) curve.** Mark the knee, where steel MMF share overtakes gap MMF share, on the curve, and show where the operating point sits relative to it.
- **Probe points and probe lines.** Click points or draw a line in the section to log B, H and μr there, with a B-along-path plot. These also become optimisation targets in Part B.
- **Gap field uniformity:** min/mean/max B along each torque gap.

### A3. Engineering foundations
- **Explicit dependency graph.** The chain is geometry → grid → problem → field → post-processing → electrical. Each setting declares which stage it invalidates. This replaces the ad-hoc `REGRID / REDETECT / REPROBLEM` sets in `ui.js`, so every change reliably re-runs what it affects.
- **Move solves into a Web Worker.** The UI stays responsive, which Part B requires.
- **Model confidence badge:** converged, energy check, mesh-sensitivity check (one-click re-solve at half the mesh size).
- **Tests for invariants**, for example: stretching a steel body's B-H must lower its MMF share; changing pack at fixed V must leave NI unchanged.

---

## Part B — CAD parameter sweep and optimisation

### B1. Fusion side (`FerraBrakeAnalyzer.py`), new palette actions
- **`listParams`:** user parameters (name, expression, unit, comment, favourite). Model parameters are optional and shown with the feature/sketch that owns them. User parameters are the main path, so name the driving dimensions in your CAD.
- **`evalPoint {params}`:** sets the expressions, lets Fusion recompute, checks the health of every timeline feature (an error means an infeasible point, not a crash), re-runs the section cut, and returns the section plus each body's mass and volume.
- **`restoreParams`:** original expressions are saved before the study starts. They are restored in a `finally` block, on Abort, and when the palette closes.
- **`applyParams`:** writes the chosen optimum into the model on purpose.

### B2. Keeping the setup stable across regenerations
These are the hard parts.
- **Bodies:** match by component path + body name, with order as the fallback, so your Treat-as / Moves-with choices carry over to every variant.
- **Gaps:** these are re-detected at every point. Their Powder/Torque flags are matched by (body pair, direction, nearest location).
- **Coil window:** a picked (r, z) point can fall outside a moved window. Prefer marking a coil body. Otherwise re-pick relative to the neighbouring bodies and flag the point if that fails.

### B3. Study setup (new "Optimize" tab)
- **Parameters:** choose 1 or 2. Set min, max and steps, linear or log spacing, or a discrete list.
- **Electrical assumption while geometry changes.** This matters because the coil window changes with geometry:
  - (a) fixed V and gauge (the real product);
  - (b) best gauge per variant (cheap: analytical over a short T(NI) curve);
  - (c) fixed NI (pure magnetic comparison).
- **Objective, maximise or minimise:** torque at the operating point, torque at fixed NI, torque/mass, torque/W, flux utilisation, mean gap B, B at a probe point, hot torque (once the thermal model exists).
- **Constraints:** power, current density, B98 of a chosen body, mass, outer diameter, coil temperature.

### B4. Algorithms
- **Always start with a full grid sweep.** It gives you the plot and protects against local optima.
- **1 parameter:** Brent / golden-section refinement in the bracket around the best grid point.
- **2 parameters:** fit a quadratic surface to the best point's 3×3 neighbourhood, solve at its predicted optimum, then a short bounded Nelder–Mead from there.
- **Pitfall: mesh "staircase" noise.** Curved faces are stair-stepped onto the grid and cell counts change between variants, so the objective is slightly jagged. Mitigations: the surrogate fit smooths it, the refinement step has a floor at about the mesh size, and the result is reported with a tolerance.

### B5. Results
- **1D:** line plot of the objective, with infeasible regions shaded and secondary metrics overlaid.
- **2D:** heatmap/contour with infeasible cells hatched.
- Click any point to load its full field map and limit breakdown.
- CSV export, plus an "Apply to CAD" button.

### B6. Runtime estimate
Measured on the demo brake (10k cells): 0.25–0.35 s per nonlinear solve. Per point, that's roughly 0.5–2 s for Fusion to recompute and cut the section, plus about 1 s of solving. **A 10×10 grid takes about 2–4 minutes**, and refinement adds 10–20 points.

---

## Other features worth adding
1. **Thermal model.** Steady-state coil temperature from power, surface area and a user-set heat-transfer coefficient (h), iterated with R(T). This gives **hot torque**, which often differs from cold by 20–30 %, plus duty-cycle support.
2. **Inductance and response time.** L = N·Φ_link/I comes straight from the existing flux linkage; τ = L/R gives time to 90 % torque. (Eddy currents are still out of scope.)
3. **Mass and rotor inertia** from Fusion physical properties, for torque/mass and acceleration-limited designs.
4. **Automatic multi-angle sections.** Run 2–3 section angles and flag disagreement, for bolt holes and slots.
5. **Multi-point calibration.** Least-squares fit of τsat and Bs to several (current, force) measurements, instead of one point.
6. **Design snapshots and A/B comparison**, plus an exportable HTML/PDF report.
7. **More wire options:** AWG/metric, bobbin wall thickness, layer-wound vs random packing estimate.

---

## Status
- **Phase 0 — done (2026-11-14).** Dependency pipeline, Web Worker, electrical regime panel, sensitivity limit breakdown, steel knee scales the B-H curve.
- **Phase 1 — done (2026-11-14).** Per-body steel grades (library + custom B-H + per-grade scale), Materials tab, point/line probes with flux and B-along-line plot, lumped thermal model (steady temperature, hot torque, time to limit, max duty) with an option to solve hot, coil-temperature limit and probe objectives in studies.
- **Phase 2 — done (2026-11-14).** Fusion user-parameter list/set/restore, body/gap/coil carry-over, 1-D sweep + golden-section refinement, Optimize tab, preview, Apply to CAD, CSV. Not yet run inside Fusion.
- **Fusion check (2026-11-14), NewBrake_Small_Rev5.2.** Python actions run in Fusion: listParams (15 user params), extract (10 bodies, axis Y, 4.54 kg), extract in a fixed frame at 15–90° (≈0.07 s each), evalPoint on PowderGap 0.4 / 0.8 / −1 mm (0.5–0.8 s per point) and restoreParams (all expressions back, no timeline errors). Palette pipeline on those sections in Node: 12.3 N·m at 24 V / SWG 27, solves converge in 5–9 Newton steps, ≈0.6 s each. Fixes from it: coil window that leaks through a lead hole is closed at the reference outline; intersecting bodies mark a run as a CAD error; section-check body names include the component. The palette UI itself has not been driven inside Fusion: the running add-in predates Phase 2 and must be restarted.
- **Phase 4 — done (2026-11-14).** Wire standards (SWG/AWG/metric), layer/orthocyclic winding and bobbin wall; inductance (secant, incremental, unsaturated) and nonlinear switch-on/off times with a clamp voltage; rotor inertia and stopping time; multi-point calibration (τsat and Bs); section-angle check with flags and view; snapshots with A/B comparison and an HTML report. Not yet run inside Fusion. Still open from "Other features": rotor inertia from Fusion physical properties (the section estimate is used), PDF export (print the HTML report).
- **Phase 3 — done (2026-11-14).** Two-parameter grid, quadratic surrogate + bounded Nelder–Mead refinement, heatmap with limit hatching and click-to-inspect, two-parameter Apply/CSV. Constraints, Apply and CSV were already in Phase 2. Not yet run inside Fusion.

## Phasing
- **Phase 0 (fixes and foundation):** dependency graph, Web Worker, electrical-regime panel, sensitivity-based limit breakdown. This fixes the "doesn't update" issue.
- **Phase 1:** material library with B-H scaling, probe points/lines, thermal model.
- **Phase 2:** Fusion parameter read/set/restore, body/gap re-mapping, 1D sweep with refinement.
- **Phase 3:** 2D sweep, surrogate + Nelder–Mead, constraints, Apply-to-CAD, CSV.
- **Phase 4:** extras (inductance, multi-angle, calibration fit, reports).

## Decisions (2026-11-14)
- **Electrical assumption during geometry sweeps:** fixed supply voltage and wire gauge (the real product).
- **Parameter scope:** Fusion user parameters only.
