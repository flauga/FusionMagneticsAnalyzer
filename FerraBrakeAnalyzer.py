"""Ferra Brake Analyzer - Fusion 360 add-in.

Python side does only geometry: it finds the brake axis, cuts every visible solid body with a plane
that contains the axis, and sends the (r, z) section polylines plus body names/materials to the
palette. All magnetics (nonlinear axisymmetric FEM), coil/wire maths and the UI run in the palette
(palette/solver.js, palette/ui.js), so sliders respond without round-trips to Fusion.
"""
import adsk.core
import adsk.fusion
import traceback
import json
import math
import os

CMD_ID = 'ferraBrakeAnalyzerCmd'
CMD_NAME = 'Brake Analyzer'
CMD_TIP = 'Estimate magnetic powder brake torque, flux bottlenecks and coil sizing from the open design.'
PALETTE_ID = 'ferraBrakeAnalyzerPalette'
PANEL_ID = 'SolidScriptsAddinsPanel'
HERE = os.path.dirname(os.path.realpath(__file__))

_app = None
_ui = None
_handlers = []
_bodies = []  # BRepBody proxies from the last extraction, index = body id in the palette
_study_originals = {}  # user parameter name -> expression before a study changed it (restored afterwards)
_study_baseline_errors = set()  # timeline errors that already existed when the study started


# ----------------------------------------------------------------------------- vector helpers
def _v(x, y, z):
    return adsk.core.Vector3D.create(x, y, z)


def _unit(v):
    v = v.copy()
    v.normalize()
    return v


def _canon_axis(a):
    """Flip sign so the largest component is positive (axis direction is unsigned)."""
    comps = [a.x, a.y, a.z]
    m = max(range(3), key=lambda i: abs(comps[i]))
    if comps[m] < 0:
        a = a.copy()
        a.scaleBy(-1)
    return a


def _perp(a):
    """Any unit vector perpendicular to a."""
    basis = [_v(1, 0, 0), _v(0, 1, 0), _v(0, 0, 1)]
    least = min(basis, key=lambda b: abs(b.dotProduct(a)))
    p = a.crossProduct(least)
    p.normalize()
    return p


def _rotate_about(v, a, ang):
    """Rodrigues rotation of v about unit axis a (v perpendicular to a)."""
    c, s = math.cos(ang), math.sin(ang)
    axv = a.crossProduct(v)
    return _v(v.x * c + axv.x * s, v.y * c + axv.y * s, v.z * c + axv.z * s)


# ----------------------------------------------------------------------------- geometry
SKIP_DEFAULT = ('screw', 'bolt', 'nut', 'washer', 'circlip', 'pin', 'key')


def _collect_bodies(design, include_hidden):
    root = design.rootComponent
    out = []
    for b in root.bRepBodies:
        out.append((b, root.name))
    for occ in root.allOccurrences:
        for b in occ.bRepBodies:  # proxies in root context
            out.append((b, occ.fullPathName))
    res = []
    for b, path in out:
        if not b.isSolid:
            continue
        if not include_hidden and not b.isVisible:
            continue
        res.append((b, path))
    return res


def _detect_axis(bodies):
    """Dominant cylinder axis weighted by cylindrical face area; origin = area-weighted foot point."""
    bins = {}
    for b, _ in bodies:
        for f in b.faces:
            g = f.geometry
            if not isinstance(g, adsk.core.Cylinder):
                continue
            a = _canon_axis(_unit(g.axis))
            key = (round(a.x, 3), round(a.y, 3), round(a.z, 3))
            bins.setdefault(key, []).append((f.area, a, g.origin))
    if not bins:
        return None
    key = max(bins, key=lambda k: sum(e[0] for e in bins[k]))
    items = bins[key]
    a = _unit(items[0][1])
    # project origins onto the plane perpendicular to the axis, cluster by 0.1 mm, keep the heaviest line
    clusters = []
    for area, _, o in items:
        d = _v(o.x, o.y, o.z)
        t = d.dotProduct(a)
        foot = (o.x - a.x * t, o.y - a.y * t, o.z - a.z * t)
        for c in clusters:
            if math.dist(c['p'], foot) < 0.01:  # cm
                c['w'] += area
                c['acc'] = [c['acc'][i] + foot[i] * area for i in range(3)]
                break
        else:
            clusters.append({'p': foot, 'w': area, 'acc': [foot[i] * area for i in range(3)]})
    best = max(clusters, key=lambda c: c['w'])
    o = [best['acc'][i] / best['w'] for i in range(3)]
    total = sum(c['w'] for c in clusters)
    return {'origin': adsk.core.Point3D.create(*o), 'axis': a, 'coaxialShare': best['w'] / total}


def _section(bodies, origin, a, angle_deg):
    u = _rotate_about(_perp(a), a, math.radians(angle_deg))
    n = a.crossProduct(u)
    n.normalize()
    plane = adsk.core.Plane.create(origin, n)
    tbm = adsk.fusion.TemporaryBRepManager.get()
    out, warnings = [], []
    _bodies.clear()
    for b, path in bodies:
        try:
            wire = tbm.planeIntersection(tbm.copy(b), plane)
        except Exception:
            wire = None
        if wire is None or wire.edges.count == 0:
            continue
        polys = []
        for e in wire.edges:
            ev = e.evaluator
            ok, t0, t1 = ev.getParameterExtents()
            if not ok:
                continue
            ok, pts = ev.getStrokes(t0, t1, 0.001)  # 0.01 mm chord tolerance
            if not ok or len(pts) < 2:
                continue
            flat = []
            for p in pts:
                dx, dy, dz = p.x - origin.x, p.y - origin.y, p.z - origin.z
                r = (dx * u.x + dy * u.y + dz * u.z) * 10.0  # cm -> mm
                z = (dx * a.x + dy * a.y + dz * a.z) * 10.0
                flat.extend([round(r, 4), round(z, 4)])
            if max(flat[0::2]) < -1e-3:
                continue  # entirely on the r<0 half
            polys.append(flat)
        if not polys:
            continue
        try:
            mat = b.material.name if b.material else ''
        except Exception:
            mat = ''
        comp = b.parentComponent.name if b.parentComponent else ''
        _bodies.append(b)
        out.append({
            'id': len(_bodies) - 1,
            'name': b.name,
            'component': comp,
            'path': path,
            'material': mat,
            'volumeCm3': round(b.volume, 4),
            'polys': polys,
        })
    if not out:
        warnings.append('No body intersects the section plane. Check the axis setting.')
    return out, warnings, u


def extract(opts):
    design = adsk.fusion.Design.cast(_app.activeProduct)
    if not design:
        return {'ok': False, 'error': 'Open a Fusion design (Design workspace) first.'}
    bodies = _collect_bodies(design, bool(opts.get('includeHidden')))
    if not bodies:
        return {'ok': False, 'error': 'No visible solid bodies in the active design.'}
    warnings = []
    axis_mode = opts.get('axis', 'auto')
    frame = opts.get('frame')
    if frame:
        # Fixed section frame (parameter studies): keeps (r, z) comparable between design variants.
        o, d = frame['origin'], frame['dir']
        origin = adsk.core.Point3D.create(o[0] / 10.0, o[1] / 10.0, o[2] / 10.0)
        a = _unit(_v(d[0], d[1], d[2]))
    elif axis_mode == 'auto':
        ax = _detect_axis(bodies)
        if ax is None:
            return {'ok': False, 'error': 'No cylindrical faces found to detect the axis. Pick X, Y or Z.'}
        if ax['coaxialShare'] < 0.8:
            warnings.append('Only %.0f%% of cylindrical area is coaxial with the detected axis; '
                            'off-axis parts (bolts, offsets) are ignored by the section.' % (100 * ax['coaxialShare']))
        origin, a = ax['origin'], ax['axis']
    else:
        origin = adsk.core.Point3D.create(0, 0, 0)
        a = {'x': _v(1, 0, 0), 'y': _v(0, 1, 0), 'z': _v(0, 0, 1)}[axis_mode]
    sec, w2, u = _section(bodies, origin, a, float(opts.get('angle', 0)))
    warnings.extend(w2)
    mass = None
    if opts.get('mass'):
        mass = 0.0
        for b, _ in bodies:
            try:
                mass += b.physicalProperties.mass  # kg
            except Exception:
                pass
    # Per-body CAD mass (kg) so the palette can total the steel mass of each design variant.
    for entry in sec:
        try:
            entry['massKg'] = round(_bodies[entry['id']].physicalProperties.mass, 6)
        except Exception:
            pass
    return {
        'massKg': mass,
        'ok': True,
        'source': _app.activeDocument.name if _app.activeDocument else design.rootComponent.name,
        'axis': {'origin': [origin.x * 10, origin.y * 10, origin.z * 10], 'dir': [a.x, a.y, a.z],
                 'radial': [u.x, u.y, u.z]},
        'bodies': sec,
        'warnings': warnings,
    }


# ----------------------------------------------------------------------------- parameter studies
def _unit_scale(um, unit):
    """Internal value of one `unit` (e.g. 0.1 for mm, since lengths are stored in cm)."""
    if not unit:
        return 1.0
    try:
        k = um.evaluateExpression('1 ' + unit, unit)
        return k if k else 1.0
    except Exception:
        return 1.0


def list_params():
    design = adsk.fusion.Design.cast(_app.activeProduct)
    if not design:
        return {'ok': False, 'error': 'Open a Fusion design (Design workspace) first.'}
    um = design.unitsManager
    out = []
    for p in design.userParameters:
        unit = p.unit or ''
        try:
            driven = p.dependencyParameters.count > 0
        except Exception:
            driven = False
        out.append({
            'name': p.name, 'expression': p.expression, 'unit': unit, 'comment': p.comment,
            'value': p.value / _unit_scale(um, unit), 'isFavorite': bool(p.isFavorite), 'driven': driven,
        })
    parametric = design.designType == adsk.fusion.DesignTypes.ParametricDesignType
    return {'ok': True, 'params': out, 'parametric': parametric,
            'studyActive': bool(_study_originals)}


def _timeline_errors(design):
    errs = []
    if design.designType != adsk.fusion.DesignTypes.ParametricDesignType:
        return errs
    tl = design.timeline
    for i in range(tl.count):
        it = tl.item(i)
        try:
            if it.isSuppressed or it.isRolledBack:
                continue
            if it.healthState == adsk.fusion.FeatureHealthStates.ErrorFeatureHealthState:
                errs.append('%s: %s' % (it.name, it.errorOrWarningMessage))
        except Exception:
            pass
    return errs


def _set_exprs(design, exprs, remember):
    failed = []
    um = design.unitsManager
    for name, expr in exprs.items():
        p = design.userParameters.itemByName(name)
        if p is None:
            failed.append('%s: no such user parameter' % name)
            continue
        if not um.isValidExpression(expr, p.unit or ''):
            failed.append('%s = %s: invalid expression' % (name, expr))
            continue
        if remember and name not in _study_originals:
            _study_originals[name] = p.expression
        try:
            p.expression = expr
        except Exception as e:
            failed.append('%s = %s: %s' % (name, expr, e))
    return failed


def eval_point(data):
    """Set user parameters, let Fusion recompute, check the timeline, re-cut the section."""
    global _study_baseline_errors
    design = adsk.fusion.Design.cast(_app.activeProduct)
    if not design:
        return {'ok': False, 'error': 'Open a Fusion design (Design workspace) first.'}
    if not _study_originals:
        _study_baseline_errors = set(_timeline_errors(design))
    failed = _set_exprs(design, data.get('set', {}), True)
    errs = [e for e in _timeline_errors(design) if e not in _study_baseline_errors]
    if failed or errs:
        return {'ok': True, 'feasible': False, 'errors': failed + errs}
    opts = dict(data.get('extract', {}))
    opts['mass'] = True
    geo = extract(opts)
    if not geo.get('ok'):
        return {'ok': True, 'feasible': False, 'errors': [geo.get('error', 'Section failed')]}
    return {'ok': True, 'feasible': True, 'errors': [], 'geometry': geo, 'massKg': geo.get('massKg')}


def restore_params():
    """Put every parameter a study touched back to its original expression."""
    design = adsk.fusion.Design.cast(_app.activeProduct)
    if not _study_originals:
        return {'ok': True, 'restored': [], 'errors': []}
    if not design:
        return {'ok': False, 'error': 'The design that ran the study is no longer active.'}
    orig = dict(_study_originals)
    failed = _set_exprs(design, orig, False)
    _study_originals.clear()
    return {'ok': not failed, 'restored': sorted(orig), 'errors': failed}


def set_params(data):
    """Deliberate change (Apply to CAD). Not recorded for restore."""
    design = adsk.fusion.Design.cast(_app.activeProduct)
    if not design:
        return {'ok': False, 'error': 'Open a Fusion design (Design workspace) first.'}
    failed = _set_exprs(design, data.get('set', {}), False)
    errs = _timeline_errors(design)
    return {'ok': not failed, 'errors': failed, 'timelineErrors': errs}


# ----------------------------------------------------------------------------- palette I/O
class HTMLHandler(adsk.core.HTMLEventHandler):
    def notify(self, args):
        html_args = adsk.core.HTMLEventArgs.cast(args)
        try:
            data = json.loads(html_args.data) if html_args.data else {}
        except Exception:
            data = {}
        try:
            action = html_args.action
            if action == 'extract':
                html_args.returnData = json.dumps(extract(data))
            elif action == 'listParams':
                html_args.returnData = json.dumps(list_params())
            elif action == 'evalPoint':
                html_args.returnData = json.dumps(eval_point(data))
            elif action == 'restoreParams':
                html_args.returnData = json.dumps(restore_params())
            elif action == 'setParams':
                html_args.returnData = json.dumps(set_params(data))
            elif action == 'select':
                idx = int(data.get('id', -1))
                _ui.activeSelections.clear()
                if 0 <= idx < len(_bodies):
                    _ui.activeSelections.add(_bodies[idx])
                html_args.returnData = 'OK'
            elif action == 'saveJSON':
                dlg = _ui.createFileDialog()
                dlg.title = 'Save brake analysis'
                dlg.filter = data.get('filter', 'JSON (*.json)')
                dlg.initialFilename = data.get('filename', 'brake.json')
                if dlg.showSave() == adsk.core.DialogResults.DialogOK:
                    with open(dlg.filename, 'w') as fh:
                        fh.write(data.get('content', ''))
                    html_args.returnData = json.dumps({'ok': True, 'path': dlg.filename})
                else:
                    html_args.returnData = json.dumps({'ok': False})
            elif action == 'openJSON':
                dlg = _ui.createFileDialog()
                dlg.title = 'Open brake geometry'
                dlg.filter = 'JSON (*.json)'
                if dlg.showOpen() == adsk.core.DialogResults.DialogOK:
                    with open(dlg.filename) as fh:
                        html_args.returnData = fh.read()
                else:
                    html_args.returnData = ''
            else:
                html_args.returnData = ''
        except Exception:
            html_args.returnData = json.dumps({'ok': False, 'error': traceback.format_exc()})


class CloseHandler(adsk.core.UserInterfaceGeneralEventHandler):
    def notify(self, args):
        try:
            restore_params()  # palette closed mid-study: never leave the design at a sweep value
        except Exception:
            pass


def _show_palette():
    pal = _ui.palettes.itemById(PALETTE_ID)
    if not pal:
        html = os.path.join(HERE, 'palette', 'index.html').replace('\\', '/')
        pal = _ui.palettes.add(PALETTE_ID, 'Ferra Brake Analyzer', html, True, True, True, 1180, 820, True)
        pal.dockingState = adsk.core.PaletteDockingStates.PaletteDockStateFloating
        h = HTMLHandler()
        pal.incomingFromHTML.add(h)
        _handlers.append(h)
        c = CloseHandler()
        pal.closed.add(c)
        _handlers.append(c)
    pal.isVisible = True


class CommandExecuteHandler(adsk.core.CommandEventHandler):
    def notify(self, args):
        try:
            _show_palette()
        except Exception:
            _ui.messageBox('Brake Analyzer failed:\n' + traceback.format_exc())


class CommandCreatedHandler(adsk.core.CommandCreatedEventHandler):
    def notify(self, args):
        cmd = adsk.core.CommandCreatedEventArgs.cast(args).command
        h = CommandExecuteHandler()
        cmd.execute.add(h)
        _handlers.append(h)


def run(context):
    global _app, _ui
    try:
        _app = adsk.core.Application.get()
        _ui = _app.userInterface
        cmd_def = _ui.commandDefinitions.itemById(CMD_ID)
        if not cmd_def:
            res = os.path.join(HERE, 'resources')
            cmd_def = _ui.commandDefinitions.addButtonDefinition(
                CMD_ID, CMD_NAME, CMD_TIP, res if os.path.isdir(res) else '')
        h = CommandCreatedHandler()
        cmd_def.commandCreated.add(h)
        _handlers.append(h)
        panel = _ui.allToolbarPanels.itemById(PANEL_ID)
        if panel and not panel.controls.itemById(CMD_ID):
            ctrl = panel.controls.addCommand(cmd_def)
            ctrl.isPromoted = True
    except Exception:
        if _ui:
            _ui.messageBox('Brake Analyzer start failed:\n' + traceback.format_exc())


def stop(context):
    try:
        try:
            restore_params()
        except Exception:
            pass
        pal = _ui.palettes.itemById(PALETTE_ID)
        if pal:
            pal.deleteMe()
        panel = _ui.allToolbarPanels.itemById(PANEL_ID)
        if panel:
            ctrl = panel.controls.itemById(CMD_ID)
            if ctrl:
                ctrl.deleteMe()
        cmd_def = _ui.commandDefinitions.itemById(CMD_ID)
        if cmd_def:
            cmd_def.deleteMe()
        _handlers.clear()
        _bodies.clear()
    except Exception:
        if _ui:
            _ui.messageBox('Brake Analyzer stop failed:\n' + traceback.format_exc())
