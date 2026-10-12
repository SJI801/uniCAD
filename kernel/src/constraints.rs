//! Parametric geometric constraints and a small solver.
//!
//! What this is
//! ------------
//! A constraint is a *persistent* relationship between two curves — 相切、垂直、
//! 同心、等半径、点在曲线上 … — stored with the document. When the user edits a
//! curve, the solver nudges the geometry back until every relationship holds
//! again. That is the difference between a constraint and object snap: snap
//! tells you where a point *would* land while you draw; a constraint keeps
//! holding afterwards, and survives moving either party.
//!
//! Why the solver is here and not in the front-end
//! -----------------------------------------------
//! Same reason as everything else in this crate: the project's rule is that the
//! front-end owns zero geometry. The solver is also the one place where an
//! implementation detail (residual formulation, damping, variable ordering)
//! could quietly produce geometry that "looks about right" — keeping it next to
//! the primitives it manipulates is what makes it reviewable in one sitting.
//!
//! How it works
//! ------------
//! 1. Variable vector `x` holds every parameter of the primitives that are
//!    allowed to move (a line is 4 numbers, an arc 5, a polyline 2N). Primitives
//!    that are *not* allowed to move keep their parameters as constants — they
//!    are not in `x` at all.
//! 2. Each constraint contributes residuals **normalised to length units**, so a
//!    tangent error in millimetres and a parallelism error (dimensionless) still
//!    have comparable magnitude. Without that the normal equations are badly
//!    scaled and LM either crawls or diverges.
//! 3. Levenberg-Marquardt iterations with a **damped** normal-equation solve
//!    `(JᵀJ + λ·diag(JᵀJ)) dx = -Jᵀr`. The damping is what makes an
//!    under-constrained system behave: with λ small the step approaches the
//!    minimum-norm solution, so all the freedom the user did not touch stays
//!    exactly where it was. That is why dragging one curve does not drag the
//!    rest of the drawing along with it.
//! 4. The Jacobian comes from **central finite differences**, not hand-derived
//!    derivatives. Hand-deriving nine residual families is nine chances to get a
//!    sign wrong in a way that still converges *most* of the time — the worst
//!    possible failure mode. The systems here are tiny (a handful of variables,
//!    hundreds at the very most) and edits are user-paced, so the extra
//!    evaluations cost nothing measurable.
//!
//! Branch selection
//! ----------------
//! Several constraints are two-valued: a circle can be tangent to a line from
//! either side, and two circles can touch externally or internally. The residual
//! uses an absolute value, which is not differentiable at zero, so the branch is
//! chosen **once from the initial configuration** and then held for the whole
//! solve. Re-deciding it per evaluation would make the residual jump by `2r`
//! whenever a centre crossed a line, and the finite-difference Jacobian would
//! then report a gigantic slope for a variable that barely moved.
//!
//! Over-constrained input is not an error
//! -------------------------------------
//! If the constraints cannot all hold, LM settles at the least-squares
//! compromise instead of failing: the geometry ends up as close as possible and
//! [`Outcome::converged`] is false, which the caller surfaces to the user. A
//! solver that refused to move would be worse — the drawing would appear frozen
//! with no explanation.

use crate::geom::{LineSeg, Prim};
use crate::math::{Aabb, Vec2};

// ---------------------------------------------------------------------------
// Constraint description
// ---------------------------------------------------------------------------

/// Which point of a primitive a constraint refers to.
pub const PT_NONE: u8 = 0;
pub const PT_START: u8 = 1;
pub const PT_END: u8 = 2;
pub const PT_CENTER: u8 = 3;
pub const PT_VERTEX: u8 = 4;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ConstraintKind {
    /// Two referenced points occupy the same position.
    Coincident,
    /// The point of `a` lies on the curve of `b`.
    PointOnCurve,
    /// A line touches a circle/arc, or two circles touch.
    Tangent,
    /// Two lines meet at a right angle.
    Perpendicular,
    /// Two lines share a direction.
    Parallel,
    /// Two curves share a centre.
    Concentric,
    /// Two circles/arcs share a radius.
    EqualRadius,
    /// A line is parallel to the X axis.
    Horizontal,
    /// A line is parallel to the Y axis.
    Vertical,
    /// The distance between two named points (or a point and a line) equals a
    /// target value. This is the first *dimensional* constraint: instead of
    /// "keep these related", it says "keep this at 50" — see [`Constraint::value`].
    Distance,
    /// The angle between two lines, in radians, equals a target value.
    Angle,
    /// A circle/arc has exactly the target radius.
    Radius,
    /// A circle/arc has exactly the target diameter.
    Diameter,
    /// Horizontal distance: |p.x − q.x| equals the target, with the left/right
    /// relationship frozen from the initial configuration. y is free — this is
    /// the AutoCAD "horizontal dimension" semantics the point-to-point
    /// Distance kind deliberately lacks.
    DistanceX,
    /// Vertical distance: |p.y − q.y| equals the target, x free.
    DistanceY,
}

impl ConstraintKind {
    /// Wire tag → kind. Returns `None` for anything unknown, so a newer
    /// front-end cannot make an older kernel panic.
    pub fn from_tag(tag: f64) -> Option<Self> {
        match tag as i32 {
            0 => Some(ConstraintKind::Coincident),
            1 => Some(ConstraintKind::PointOnCurve),
            2 => Some(ConstraintKind::Tangent),
            3 => Some(ConstraintKind::Perpendicular),
            4 => Some(ConstraintKind::Parallel),
            5 => Some(ConstraintKind::Concentric),
            6 => Some(ConstraintKind::EqualRadius),
            7 => Some(ConstraintKind::Horizontal),
            8 => Some(ConstraintKind::Vertical),
            9 => Some(ConstraintKind::Distance),
            10 => Some(ConstraintKind::Angle),
            11 => Some(ConstraintKind::Radius),
            12 => Some(ConstraintKind::Diameter),
            13 => Some(ConstraintKind::DistanceX),
            14 => Some(ConstraintKind::DistanceY),
            _ => None,
        }
    }

    /// How many scalar residuals this kind contributes. Constant for a given
    /// constraint, which the LM loop relies on.
    pub fn arity(self) -> usize {
        match self {
            ConstraintKind::Coincident | ConstraintKind::Concentric => 2,
            _ => 1,
        }
    }

    /// Whether this kind carries a target value in [`Constraint::value`].
    pub fn is_dimensional(self) -> bool {
        matches!(
            self,
            ConstraintKind::Distance
                | ConstraintKind::Angle
                | ConstraintKind::Radius
                | ConstraintKind::Diameter
                | ConstraintKind::DistanceX
                | ConstraintKind::DistanceY
        )
    }
}

/// A reference to an entity, optionally to a named point on it.
#[derive(Clone, Copy, Debug)]
pub struct Target {
    pub entity: usize,
    pub point_kind: u8,
    pub point_index: usize,
}

impl Target {
    pub fn whole(entity: usize) -> Self {
        Target { entity, point_kind: PT_NONE, point_index: 0 }
    }

    pub fn has_point(&self) -> bool {
        self.point_kind != PT_NONE
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Constraint {
    pub kind: ConstraintKind,
    pub a: Target,
    /// `None` for the single-entity kinds (horizontal / vertical / radius /
    /// diameter).
    pub b: Option<Target>,
    /// Target value for the dimensional kinds, in model units (radians for
    /// [`ConstraintKind::Angle`]). Ignored — kept at `0.0` — by the purely
    /// geometric kinds, so a constraint stays one copyable scalar block.
    ///
    /// The value lives on the constraint, not on the geometry, and that is the
    /// whole point of ROADMAP 0.1: the stored number is the *intent*, and the
    /// solver treats the gap between intent and reality as one more residual.
    /// A dimension re-derived from the geometry after every edit could never
    /// disagree with it — which is exactly the 「尺寸只显示、不驱动」 failure
    /// this stage exists to kill.
    pub value: f64,
}

/// Result of a solve.
pub struct Outcome {
    pub prims: Vec<Prim>,
    /// LM iterations actually performed.
    pub iterations: u32,
    /// Largest absolute residual afterwards, in model units.
    pub max_residual: f64,
    /// `false` when the constraints could not all hold (over-constrained), in
    /// which case `prims` holds the closest achievable configuration.
    pub converged: bool,
}

// ---------------------------------------------------------------------------
// Solver tuning
// ---------------------------------------------------------------------------

/// Stop once every residual is below this, in model units.
const TOL: f64 = 1e-9;
const MAX_ITER: u32 = 80;
/// A step that fails to reduce the residual is retried with more damping; after
/// this many consecutive failures we accept that the current point is as good as
/// it gets.
const MAX_BACKTRACK: u32 = 16;
const LAMBDA_INIT: f64 = 1e-6;
const LAMBDA_MIN: f64 = 1e-12;
const LAMBDA_MAX: f64 = 1e14;
/// Floor for a radius/axis length, so the solver never asks for a negative
/// radius and the geometry never degenerates to a point.
const MIN_SIZE: f64 = 1e-9;

// ---------------------------------------------------------------------------
// Parameter layout
// ---------------------------------------------------------------------------

/// Number of scalars each primitive contributes to the variable vector.
fn param_count(p: &Prim) -> usize {
    match p {
        Prim::Line(_) => 4,
        Prim::Circle(_) => 3,
        Prim::Arc(_) => 5,
        Prim::Ellipse(_) => 5,
        Prim::Polyline(pl) => pl.points.len() * 2,
    }
}

/// Which slots of a primitive's block are **defining sizes** rather than position
/// or orientation — a circle's / arc's radius, an ellipse's semi-axes.
///
/// Offsets are relative to the primitive's own block and must match
/// [`write_params`]. The distinction matters to the solver: a relationship may
/// move and turn a curve, but it must not resize it — see `size_driven` in
/// [`solve`].
fn size_slots(p: &Prim) -> &'static [usize] {
    match p {
        Prim::Circle(_) => &[2],
        Prim::Arc(_) => &[2],
        Prim::Ellipse(_) => &[2, 3],
        Prim::Line(_) | Prim::Polyline(_) => &[],
    }
}

/// `p` → scalars, in the fixed order documented on [`param_count`].
fn write_params(p: &Prim, out: &mut [f64]) {
    match p {
        Prim::Line(l) => {
            out[0] = l.a.x;
            out[1] = l.a.y;
            out[2] = l.b.x;
            out[3] = l.b.y;
        }
        Prim::Circle(c) => {
            out[0] = c.center.x;
            out[1] = c.center.y;
            out[2] = c.radius;
        }
        Prim::Arc(a) => {
            out[0] = a.center.x;
            out[1] = a.center.y;
            out[2] = a.radius;
            out[3] = a.start_angle;
            out[4] = a.end_angle;
        }
        Prim::Ellipse(e) => {
            out[0] = e.center.x;
            out[1] = e.center.y;
            out[2] = e.rx;
            out[3] = e.ry;
            out[4] = e.rotation;
        }
        Prim::Polyline(pl) => {
            for (i, pt) in pl.points.iter().enumerate() {
                out[i * 2] = pt.x;
                out[i * 2 + 1] = pt.y;
            }
        }
    }
}

/// Scalars → `p`. Sizes are floored so the solver cannot invert a curve.
fn read_params(p: &mut Prim, x: &[f64]) {
    match p {
        Prim::Line(l) => {
            l.a = Vec2::new(x[0], x[1]);
            l.b = Vec2::new(x[2], x[3]);
        }
        Prim::Circle(c) => {
            c.center = Vec2::new(x[0], x[1]);
            c.radius = x[2].max(MIN_SIZE);
        }
        Prim::Arc(a) => {
            a.center = Vec2::new(x[0], x[1]);
            a.radius = x[2].max(MIN_SIZE);
            a.start_angle = x[3];
            a.end_angle = x[4];
        }
        Prim::Ellipse(e) => {
            e.center = Vec2::new(x[0], x[1]);
            e.rx = x[2].max(MIN_SIZE);
            e.ry = x[3].max(MIN_SIZE);
            e.rotation = x[4];
        }
        Prim::Polyline(pl) => {
            for (i, pt) in pl.points.iter_mut().enumerate() {
                pt.x = x[i * 2];
                pt.y = x[i * 2 + 1];
            }
        }
    }
}

/// Start offset and length of each primitive inside the variable vector.
///
/// The length is derived from the next offset (or `total` at the end) rather
/// than stored, so the offsets stay the single source of truth.
struct Layout {
    base: Vec<usize>,
    total: usize,
}

impl Layout {
    fn new(prims: &[Prim]) -> Self {
        let mut base = Vec::with_capacity(prims.len());
        let mut total = 0;
        for p in prims {
            base.push(total);
            total += param_count(p);
        }
        Layout { base, total }
    }

    fn block(&self, i: usize) -> core::ops::Range<usize> {
        let start = self.base[i];
        let end = if i + 1 < self.base.len() { self.base[i + 1] } else { self.total };
        start..end
    }

    fn pack(&self, prims: &[Prim]) -> Vec<f64> {
        let mut x = vec![0.0; self.total];
        for (i, p) in prims.iter().enumerate() {
            let r = self.block(i);
            write_params(p, &mut x[r]);
        }
        x
    }

    /// Rebuild the primitive list from `x`, writing into `buf` so a solve does
    /// not allocate a fresh `Vec<Prim>` on every function evaluation.
    fn unpack_into(&self, template: &[Prim], x: &[f64], buf: &mut Vec<Prim>) {
        buf.clear();
        buf.extend_from_slice(template);
        for i in 0..buf.len() {
            let r = self.block(i);
            read_params(&mut buf[i], &x[r]);
        }
    }
}

// ---------------------------------------------------------------------------
// Geometry accessors
// ---------------------------------------------------------------------------

/// The point a [`Target`] names, if that primitive has such a point.
fn point_of(p: &Prim, t: Target) -> Option<Vec2> {
    match (p, t.point_kind) {
        (Prim::Line(l), PT_START) => Some(l.a),
        (Prim::Line(l), PT_END) => Some(l.b),
        // An arc's start/end are its *endpoints*, not its centre — that is what
        // makes 「端点重合」 work on arcs.
        (Prim::Arc(a), PT_START) => Some(a.start_point()),
        (Prim::Arc(a), PT_END) => Some(a.end_point()),
        (Prim::Circle(c), PT_CENTER) => Some(c.center),
        (Prim::Arc(a), PT_CENTER) => Some(a.center),
        (Prim::Ellipse(e), PT_CENTER) => Some(e.center),
        (Prim::Polyline(pl), PT_VERTEX) => pl.points.get(t.point_index).copied(),
        _ => None,
    }
}

/// The supporting infinite line of a primitive, when it has one.
fn line_of(p: &Prim) -> Option<LineSeg> {
    match p {
        Prim::Line(l) => Some(*l),
        _ => None,
    }
}

/// `(centre, radius)` for the "circle-like" curves — the only primitives a
/// tangency, concentricity or equal-radius constraint can involve.
fn circle_like(p: &Prim) -> Option<(Vec2, f64)> {
    match p {
        Prim::Circle(c) => Some((c.center, c.radius)),
        Prim::Arc(a) => Some((a.center, a.radius)),
        _ => None,
    }
}

/// Signed perpendicular offset of `q` from the curve, **in length units**;
/// zero means "on the curve".
///
/// The ellipse is the odd one out: its implicit function
/// `(x/rx)² + (y/ry)² - 1` is dimensionless, so it is multiplied by the smaller
/// semi-axis to bring it back to roughly millimetres. Without that, a point far
/// outside a very eccentric ellipse contributes an enormous residual compared to
/// every other constraint and LM spends all of its effort there.
fn offset_to_curve(p: &Prim, q: Vec2) -> f64 {
    match p {
        Prim::Line(l) => l.dir().cross(q - l.a),
        Prim::Circle(c) => (q - c.center).length() - c.radius,
        Prim::Arc(a) => (q - a.center).length() - a.radius,
        Prim::Ellipse(e) => {
            let local = (q - e.center).rotated(-e.rotation);
            let rx = e.rx.max(MIN_SIZE);
            let ry = e.ry.max(MIN_SIZE);
            let f = (local.x / rx).powi(2) + (local.y / ry).powi(2) - 1.0;
            f * rx.min(ry)
        }
        Prim::Polyline(pl) => {
            // Nearest supporting line of any segment. The choice is made per
            // evaluation, so the residual is only piecewise smooth — acceptable
            // because the switch happens where two candidates are equal, i.e.
            // where the derivative does not jump.
            let mut best = f64::INFINITY;
            let mut res = 0.0;
            for i in 0..pl.segment_count() {
                if let Some(s) = pl.segment(i) {
                    let v = s.dir().cross(q - s.a);
                    if v.abs() < best {
                        best = v.abs();
                        res = v;
                    }
                }
            }
            if best.is_finite() {
                res
            } else {
                0.0
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Branch selection
// ---------------------------------------------------------------------------

/// The discrete choices a constraint had to make, frozen for the whole solve.
#[derive(Clone, Copy)]
struct Branch {
    /// Which side of the line the centre sits on: `+1` / `-1`.
    tangent_side: f64,
    /// Two circles touching internally rather than externally.
    tangent_internal: bool,
    /// Which side of the line a point-to-line distance measures: `+1` / `-1`.
    /// Same reasoning as `tangent_side` — the *signed* offset is smooth, an
    /// absolute value is not.
    distance_side: f64,
    /// Which way the angle is measured: `+1` drives the signed angle from `a`
    /// to `b` toward `+value`, `-1` toward `-value`. Two lines enclose two
    /// supplementary angles; re-deciding per evaluation would make the
    /// residual jump by `2·value` whenever a direction flipped.
    angle_sign: f64,
    /// Left/right (or above/below) relationship for the axis-aligned
    /// distances: `+1` keeps `p` on the positive side of `q`, `-1` the
    /// negative. Froze the same way as `tangent_side`.
    axis_sign: f64,
}

fn plan_branch(prims: &[Prim], c: &Constraint) -> Branch {
    let mut br = Branch {
        tangent_side: 1.0,
        tangent_internal: false,
        distance_side: 1.0,
        angle_sign: 1.0,
        axis_sign: 1.0,
    };
    let b = match c.b {
        Some(b) => b,
        // Radius / diameter have no branch to freeze; the residual is linear
        // in the radius.
        None => return br,
    };
    if c.a.entity >= prims.len() || b.entity >= prims.len() {
        return br;
    }
    let pa = &prims[c.a.entity];
    let pb = &prims[b.entity];

    match c.kind {
        ConstraintKind::Tangent => {
            if let (Some(l), Some((cen, _))) = (line_of(pa), circle_like(pb)) {
                br.tangent_side = if l.dir().cross(cen - l.a) < 0.0 { -1.0 } else { 1.0 };
            } else if let (Some((cen, _)), Some(l)) = (circle_like(pa), line_of(pb)) {
                br.tangent_side = if l.dir().cross(cen - l.a) < 0.0 { -1.0 } else { 1.0 };
            } else if let (Some((ca, ra)), Some((cb, rb))) = (circle_like(pa), circle_like(pb)) {
                let d = (cb - ca).length();
                // Whichever tangency the current configuration is already closer to.
                br.tangent_internal = (d - (ra - rb).abs()).abs() < (d - (ra + rb)).abs();
            }
        }
        ConstraintKind::Distance => {
            // Point ↔ line: freeze which side of the line the point is on, so
            // the residual stays the *signed* offset minus `side·value`.
            if b.point_kind == PT_NONE {
                if let (Some(pt), Some(l)) = (point_of(pa, c.a), line_of(pb)) {
                    if l.dir().cross(pt - l.a) < 0.0 {
                        br.distance_side = -1.0;
                    }
                }
            }
        }
        ConstraintKind::DistanceX | ConstraintKind::DistanceY => {
            // Freeze which side of q the point p starts on, so the residual
            // stays the *signed* axis gap minus `sign·value` — smooth, same
            // shape as the point-line distance.
            if let (Some(p), Some(q)) = (point_of(pa, c.a), point_of(pb, b)) {
                let d = if c.kind == ConstraintKind::DistanceX {
                    p.x - q.x
                } else {
                    p.y - q.y
                };
                if d < 0.0 {
                    br.axis_sign = -1.0;
                }
            }
        }
        ConstraintKind::Angle => {
            if let (Some(la), Some(lb)) = (line_of(pa), line_of(pb)) {
                let (da, db) = (la.dir(), lb.dir());
                // `atan2` is in (−π, π]; the branch is whichever hemisphere the
                // drawing currently sits in.
                if da.cross(db) < 0.0 {
                    br.angle_sign = -1.0;
                }
            }
        }
        _ => {}
    }
    br
}

// ---------------------------------------------------------------------------
// Residuals
// ---------------------------------------------------------------------------

/// Whether a constraint can be evaluated at all against this geometry.
///
/// Filtering **once, up front** (rather than pushing zeros for a bad target on
/// every evaluation) keeps the residual count constant across the whole solve,
/// which the LM loop and the Jacobian layout both rely on.
fn is_valid(prims: &[Prim], c: &Constraint) -> bool {
    if c.a.entity >= prims.len() {
        return false;
    }
    let pa = &prims[c.a.entity];
    let b = match c.b {
        Some(b) => b,
        None => {
            // The single-entity kinds are the only ones allowed to omit `b`.
            return (matches!(c.kind, ConstraintKind::Horizontal | ConstraintKind::Vertical)
                && line_of(pa).is_some())
                || (matches!(c.kind, ConstraintKind::Radius | ConstraintKind::Diameter)
                    && circle_like(pa).is_some());
        }
    };
    if b.entity >= prims.len() {
        return false;
    }
    let pb = &prims[b.entity];

    match c.kind {
        ConstraintKind::Horizontal | ConstraintKind::Vertical => line_of(pa).is_some(),
        ConstraintKind::Coincident => {
            point_of(pa, c.a).is_some() && point_of(pb, b).is_some()
        }
        ConstraintKind::PointOnCurve => point_of(pa, c.a).is_some() && !b.has_point(),
        ConstraintKind::Tangent => {
            (line_of(pa).is_some() && circle_like(pb).is_some())
                || (circle_like(pa).is_some() && line_of(pb).is_some())
                || (circle_like(pa).is_some() && circle_like(pb).is_some())
        }
        ConstraintKind::Perpendicular | ConstraintKind::Parallel => {
            line_of(pa).is_some() && line_of(pb).is_some()
        }
        ConstraintKind::Concentric | ConstraintKind::EqualRadius => {
            circle_like(pa).is_some() && circle_like(pb).is_some()
        }
        // Two named points, or a named point and a line. Two whole lines are
        // deliberately *not* a distance: for crossing lines "the distance" is
        // zero everywhere and for skew ones it is ambiguous — the front end
        // pins the dimension to a concrete pair of points instead.
        ConstraintKind::Distance => {
            if b.has_point() {
                point_of(pa, c.a).is_some() && point_of(pb, b).is_some()
            } else {
                point_of(pa, c.a).is_some() && line_of(pb).is_some()
            }
        }
        ConstraintKind::Angle => line_of(pa).is_some() && line_of(pb).is_some(),
        ConstraintKind::DistanceX | ConstraintKind::DistanceY => {
            point_of(pa, c.a).is_some() && point_of(pb, b).is_some()
        }
        // Unreachable: handled in the `b: None` arm above, but the match must
        // stay exhaustive.
        ConstraintKind::Radius | ConstraintKind::Diameter => false,
    }
}

/// Push this constraint's residuals. Exactly `arity()` scalars are appended.
fn residuals_of(prims: &[Prim], c: &Constraint, br: Branch, out: &mut Vec<f64>) {
    let pa = &prims[c.a.entity];
    let pb = c.b.map(|b| &prims[b.entity]);

    match c.kind {
        ConstraintKind::Coincident => {
            // Both sides were validated, so the fallback arm is unreachable in
            // practice; pushing zeros there keeps the arity promise instead of
            // panicking inside a solve loop.
            match (
                point_of(pa, c.a),
                c.b.zip(pb).and_then(|(bt, p)| point_of(p, bt)),
            ) {
                (Some(p), Some(q)) => {
                    out.push(p.x - q.x);
                    out.push(p.y - q.y);
                }
                _ => {
                    out.push(0.0);
                    out.push(0.0);
                }
            }
        }

        ConstraintKind::PointOnCurve => {
            match (point_of(pa, c.a), pb) {
                (Some(pt), Some(curve)) => out.push(offset_to_curve(curve, pt)),
                _ => out.push(0.0),
            }
        }

        ConstraintKind::Tangent => {
            let qb = match pb {
                Some(q) => q,
                None => {
                    out.push(0.0);
                    return;
                }
            };
            // line ↔ circle: the *signed* offset of the centre from the
            // supporting line minus the radius — smooth everywhere, unlike an
            // absolute distance.
            if let (Some(l), Some((cen, r))) = (line_of(pa), circle_like(qb)) {
                out.push(l.dir().cross(cen - l.a) - br.tangent_side * r);
            } else if let (Some((cen, r)), Some(l)) = (circle_like(pa), line_of(qb)) {
                out.push(l.dir().cross(cen - l.a) - br.tangent_side * r);
            } else if let (Some((ca, ra)), Some((cb, rb))) = (circle_like(pa), circle_like(qb)) {
                let d = (cb - ca).length();
                out.push(if br.tangent_internal {
                    d - (ra - rb).abs()
                } else {
                    d - (ra + rb)
                });
            } else {
                out.push(0.0);
            }
        }

        ConstraintKind::Perpendicular | ConstraintKind::Parallel => {
            let qb = match pb {
                Some(q) => q,
                None => {
                    out.push(0.0);
                    return;
                }
            };
            match (line_of(pa), line_of(qb)) {
                (Some(la), Some(lb)) => {
                    let da = la.dir();
                    let db = lb.dir();
                    // Scaled to length units so this carries the same weight as,
                    // say, a tangency error in millimetres.
                    let scale = 0.5 * (la.length() + lb.length());
                    out.push(if c.kind == ConstraintKind::Perpendicular {
                        da.dot(db) * scale
                    } else {
                        da.cross(db) * scale
                    });
                }
                _ => out.push(0.0),
            }
        }

        ConstraintKind::Concentric => {
            match (circle_like(pa), pb.and_then(circle_like)) {
                (Some((ca, _)), Some((cb, _))) => {
                    out.push(ca.x - cb.x);
                    out.push(ca.y - cb.y);
                }
                _ => {
                    out.push(0.0);
                    out.push(0.0);
                }
            }
        }

        ConstraintKind::EqualRadius => {
            match (circle_like(pa), pb.and_then(circle_like)) {
                (Some((_, ra)), Some((_, rb))) => out.push(ra - rb),
                _ => out.push(0.0),
            }
        }

        // Already linear and already in length units: the coordinate difference
        // *is* the error.
        ConstraintKind::Horizontal => match line_of(pa) {
            Some(l) => out.push(l.b.y - l.a.y),
            None => out.push(0.0),
        },
        ConstraintKind::Vertical => match line_of(pa) {
            Some(l) => out.push(l.b.x - l.a.x),
            None => out.push(0.0),
        },

        // ------------------------------------------------------------------
        // The dimensional kinds. The stored `value` is the intent; the
        // residual is "how far reality is from it", in length units like
        // everything else so the normal equations stay balanced.
        // ------------------------------------------------------------------

        ConstraintKind::Distance => {
            match (point_of(pa, c.a), pb) {
                (Some(p), Some(q)) => {
                    let b_point =
                        c.b.and_then(|bt| if bt.has_point() { point_of(q, bt) } else { None });
                    if let Some(qp) = b_point {
                        // Point ↔ point. `length()` is not differentiable at
                        // zero, but a zero distance is what 重合 already
                        // expresses, so a dimensional distance never starts
                        // there in practice.
                        out.push((p - qp).length() - c.value);
                    } else if let Some(l) = line_of(q) {
                        // Point ↔ line: the *signed* offset frozen at plan
                        // time, minus `side·value` — smooth everywhere, the
                        // same shape as the line-circle tangency residual.
                        out.push(l.dir().cross(p - l.a) - br.distance_side * c.value);
                    } else {
                        out.push(0.0);
                    }
                }
                _ => out.push(0.0),
            }
        }

        ConstraintKind::Angle => {
            let qb = match pb {
                Some(q) => q,
                None => {
                    out.push(0.0);
                    return;
                }
            };
            match (line_of(pa), line_of(qb)) {
                (Some(la), Some(lb)) => {
                    let (da, db) = (la.dir(), lb.dir());
                    // Signed angle from `da` to `db`, in (-π, π]. The target
                    // is kept strictly inside (0, π) so the residual can never
                    // sit on the atan2 branch cut at ±π, where a tiny nudge
                    // would swing the angle by a full 2π.
                    let target = c.value.clamp(1e-6, core::f64::consts::PI - 1e-6);
                    let signed = da.cross(db).atan2(da.dot(db));
                    // Same length-unit scaling as 垂直 / 平行: an angle error
                    // in radians means nothing to a millimetre.
                    let scale = 0.5 * (la.length() + lb.length());
                    out.push((signed - br.angle_sign * target) * scale);
                }
                _ => out.push(0.0),
            }
        }

        ConstraintKind::DistanceX | ConstraintKind::DistanceY => {
            match (point_of(pa, c.a), pb) {
                (Some(p), Some(q)) => {
                    let b_point =
                        c.b.and_then(|bt| if bt.has_point() { point_of(q, bt) } else { None });
                    if let Some(qp) = b_point {
                        // Signed axis gap minus the frozen-side target. The
                        // residual is *linear* in the coordinates — no `length`
                        // singularity, and the free axis (y for DistanceX) has
                        // zero gradient, which is exactly the "that axis is
                        // unconstrained" semantics.
                        let d = if c.kind == ConstraintKind::DistanceX {
                            p.x - qp.x
                        } else {
                            p.y - qp.y
                        };
                        out.push(d - br.axis_sign * c.value);
                    } else {
                        out.push(0.0);
                    }
                }
                _ => out.push(0.0),
            }
        }

        ConstraintKind::Radius => match circle_like(pa) {
            // `.max(MIN_SIZE)` only guards a nonsensical target from the wire;
            // the front end refuses non-positive dimensions before they get
            // this far.
            Some((_, r)) => out.push(r - c.value.max(MIN_SIZE)),
            None => out.push(0.0),
        },
        ConstraintKind::Diameter => match circle_like(pa) {
            Some((_, r)) => out.push(2.0 * r - c.value.max(MIN_SIZE)),
            None => out.push(0.0),
        },
    }
}

fn residuals(prims: &[Prim], cs: &[Constraint], brs: &[Branch]) -> Vec<f64> {
    let mut out = Vec::with_capacity(cs.iter().map(|c| c.kind.arity()).sum());
    for (i, c) in cs.iter().enumerate() {
        residuals_of(prims, c, brs[i], &mut out);
    }
    out
}

/// Central-difference Jacobian at `x`: `m` rows (one per residual) × `free.len()`
/// columns (the variable slots named by `free`).
///
/// The step is relative to each variable's own magnitude, so a coordinate near
/// 1e5 and an angle near 0 both get a useful difference. Hand-derived
/// derivatives would be nine chances to get a sign wrong in a way that still
/// converges most of the time; the systems here are tiny, so the extra
/// evaluations cost nothing measurable.
///
/// Shared by the solver and by [`analyze`]: the two must agree on what the
/// Jacobian is, or the degrees-of-freedom report would describe a different
/// system than the one being solved. `x` is restored before returning.
fn jacobian_at(
    layout: &Layout,
    prims: &[Prim],
    cs: &[Constraint],
    brs: &[Branch],
    x: &mut [f64],
    free: &[usize],
    m: usize,
    scratch: &mut Vec<Prim>,
) -> Vec<f64> {
    let nf = free.len();
    let mut j = vec![0.0; m * nf];
    for (col, &vi) in free.iter().enumerate() {
        let h = 1e-6 * x[vi].abs().max(1.0);
        let saved = x[vi];

        x[vi] = saved + h;
        layout.unpack_into(prims, x, scratch);
        let rp = residuals(&scratch[..], cs, brs);
        x[vi] = saved - h;
        layout.unpack_into(prims, x, scratch);
        let rm = residuals(&scratch[..], cs, brs);
        x[vi] = saved;

        let inv = 1.0 / (2.0 * h);
        for row in 0..m {
            j[row * nf + col] = (rp[row] - rm[row]) * inv;
        }
    }
    j
}

/// Rank of a row-major `rows × cols` matrix, by Gaussian elimination with
/// partial pivoting. `tol` is absolute — pass it scaled to the matrix (see the
/// caller), because "is this pivot non-zero" is a question about significance,
/// not about exact zeros.
fn matrix_rank(a: &[f64], rows: usize, cols: usize, tol: f64) -> usize {
    let mut m = a.to_vec();
    let mut rank = 0usize;
    for col in 0..cols {
        if rank >= rows {
            break;
        }
        let mut pivot_row = rank;
        for r in (rank + 1)..rows {
            if m[r * cols + col].abs() > m[pivot_row * cols + col].abs() {
                pivot_row = r;
            }
        }
        if m[pivot_row * cols + col].abs() <= tol {
            continue;
        }
        if pivot_row != rank {
            for c in 0..cols {
                m.swap(rank * cols + c, pivot_row * cols + c);
            }
        }
        let pivot = m[rank * cols + col];
        for r in (rank + 1)..rows {
            let f = m[r * cols + col] / pivot;
            if f == 0.0 {
                continue;
            }
            for c in col..cols {
                m[r * cols + c] -= f * m[rank * cols + c];
            }
        }
        rank += 1;
    }
    rank
}

// ---------------------------------------------------------------------------
// Degrees-of-freedom report (ROADMAP 0.3)
// ---------------------------------------------------------------------------

/// 图元「还剩下的可读动作」位掩码（ROADMAP 0.3 的方向可视化）。
///
/// 一个动作是自由的，当且仅当它落在雅可比的**零空间**里（`J·m ≈ 0`）——这正是
/// 「这个动作不会破坏任何一条已加的约束」的线性化说法。用固定的一组**人能读懂的
/// 动作**去测，而不是把零空间基向量直接画出来：基是一组（随求解器任意选取的）
/// 组合，画出来既不可读也不稳定；「能不能平移 / 转动 / 改尺寸」才是用户的问题。
pub const MODE_TX: u8 = 1;
pub const MODE_TY: u8 = 2;
pub const MODE_ROT: u8 = 4;
pub const MODE_SIZE: u8 = 8;

/// 与 `write_params` 同序的参数方向：`(掩码, 向量)`。
///
/// 转动给三种可能的支点（质心 / 每个命名点）——两个首尾相接的直线，绕**接点**转
/// 是允许的，绕各自质心转不是；只测质心会漏报真实自由度。任一为自由即置位。
/// 圆没有自己的转动（绕圆心转不改变它），所以不报 ROT；圆弧的「转」= 摆动（两个
/// 端点角同增），那是它真实的一个自由度。
fn mode_vectors(p: &Prim) -> Vec<(u8, Vec<f64>)> {
    match p {
        Prim::Line(l) => {
            let len = l.length();
            let dir = l.dir();
            let perp = Vec2::new(-dir.y, dir.x); // 单位法向
            let mut v = Vec::with_capacity(6);
            v.push((MODE_TX, vec![1.0, 0.0, 1.0, 0.0]));
            v.push((MODE_TY, vec![0.0, 1.0, 0.0, 1.0]));
            // 绕质心：两端反向
            v.push((MODE_ROT, vec![-perp.x * len / 2.0, -perp.y * len / 2.0, perp.x * len / 2.0, perp.y * len / 2.0]));
            // 绕两个端点
            v.push((MODE_ROT, vec![0.0, 0.0, -perp.x * len, -perp.y * len]));
            v.push((MODE_ROT, vec![perp.x * len, perp.y * len, 0.0, 0.0]));
            // 定质心缩放 = 改长度
            v.push((MODE_SIZE, vec![-dir.x * len / 2.0, -dir.y * len / 2.0, dir.x * len / 2.0, dir.y * len / 2.0]));
            v
        }
        Prim::Circle(_) => vec![
            (MODE_TX, vec![1.0, 0.0, 0.0]),
            (MODE_TY, vec![0.0, 1.0, 0.0]),
            (MODE_SIZE, vec![0.0, 0.0, 1.0]),
        ],
        Prim::Arc(_) => vec![
            (MODE_TX, vec![1.0, 0.0, 0.0, 0.0, 0.0]),
            (MODE_TY, vec![0.0, 1.0, 0.0, 0.0, 0.0]),
            (MODE_SIZE, vec![0.0, 0.0, 1.0, 0.0, 0.0]),
            // 摆动：两个端点角同增
            (MODE_ROT, vec![0.0, 0.0, 0.0, 1.0, 1.0]),
        ],
        Prim::Ellipse(_) => vec![
            (MODE_TX, vec![1.0, 0.0, 0.0, 0.0, 0.0]),
            (MODE_TY, vec![0.0, 1.0, 0.0, 0.0, 0.0]),
            (MODE_SIZE, vec![0.0, 0.0, 1.0, 1.0, 0.0]),
            (MODE_ROT, vec![0.0, 0.0, 0.0, 0.0, 1.0]),
        ],
        Prim::Polyline(pl) => {
            let n = pl.points.len();
            let c = if n == 0 {
                Vec2::new(0.0, 0.0)
            } else {
                let sum = pl.points.iter().fold(Vec2::new(0.0, 0.0), |a, p| a + *p);
                Vec2::new(sum.x / n as f64, sum.y / n as f64)
            };
            let mut tx = vec![0.0; n * 2];
            let mut ty = vec![0.0; n * 2];
            let mut rot = vec![0.0; n * 2];
            let mut size = vec![0.0; n * 2];
            for (i, pt) in pl.points.iter().enumerate() {
                let d = *pt - c;
                tx[i * 2] = 1.0;
                ty[i * 2 + 1] = 1.0;
                rot[i * 2] = -d.y;
                rot[i * 2 + 1] = d.x;
                size[i * 2] = d.x;
                size[i * 2 + 1] = d.y;
            }
            vec![
                (MODE_TX, tx),
                (MODE_TY, ty),
                (MODE_ROT, rot),
                (MODE_SIZE, size),
            ]
        }
    }
}

/// How much freedom a sketch still has, and what cannot be satisfied.
pub struct Report {
    /// Remaining degrees of freedom — the null-space dimension of the Jacobian.
    /// `0` means 完全定义. Note that nothing in this kernel is *grounded*, so
    /// every sketch keeps at least its rigid-body freedom (two translations, and
    /// a rotation unless 水平/竖直 pins it).
    pub dof: usize,
    /// Rank of the Jacobian.
    pub rank: usize,
    /// Scalar residual rows (`Σ arity`).
    pub rows: usize,
    /// `rows - rank`: constraints that add nothing new. Consistent ones are
    /// merely **redundant** (a hint), unlike [`Report::conflicts`].
    pub redundant: usize,
    /// Indices into the **input** constraint list of the ones that cannot hold
    /// at the same time — the honest answer to 「冲突项是谁」. Indices refer to
    /// `raw` as passed in (constraints this kernel cannot evaluate are skipped,
    /// but they do not shift the numbering the caller sees).
    pub conflicts: Vec<usize>,
    /// Largest absolute residual left, in model units.
    pub max_residual: f64,
    /// Whether every constraint ended up satisfied.
    pub solved: bool,
    /// 每个图元剩下的**可读动作**，与传入的 `prims` 同序（位掩码见 `MODE_*`）。
    /// 这是「方向」那一半：dof 告诉你还差几个，这里告诉你还能往哪动。
    pub modes: Vec<u8>,
}

/// A residual bigger than this counts as "cannot be satisfied". Scaled by the
/// drawing's extent so the same number means the same thing in millimetres and
/// in metres.
fn report_tol(prims: &[Prim]) -> f64 {
    let mut b = Aabb::empty();
    for p in prims {
        b.merge(p.bounds());
    }
    let extent = if b.is_empty() {
        1.0
    } else {
        (b.max_x - b.min_x).abs().max((b.max_y - b.min_y).abs()).max(1.0)
    };
    1e-7 * extent
}

/// Analyze a sketch: solve it, then count what is left over.
///
/// Two things this deliberately does *not* reuse from [`solve`]:
///
/// * **Every primitive is movable.** 「这条草图还剩多少自由度」 is a property of
///   the sketch, not of whichever drag happened to call the solver.
/// * **Every parameter is a column**, including a radius that no dimension
///   drives. [`solve`] freezes those (a relationship must not resize a curve —
///   see `size_driven`), but an undimensioned radius is still an *unsolved*
///   degree of freedom, and hiding it would make the count lie.
pub fn analyze(prims: &[Prim], raw: &[Constraint]) -> Report {
    // 过滤掉这个内核算不了的约束，但**记住它们在原始列表里的位置**：调用方要拿
    // 序号回指自己那份 `doc.constraints`，跳过的条目不能让后面的序号移位。
    let mut filtered: Vec<Constraint> = Vec::new();
    let mut origin: Vec<usize> = Vec::new();
    for (i, c) in raw.iter().enumerate() {
        if is_valid(prims, c) {
            filtered.push(*c);
            origin.push(i);
        }
    }
    let layout = Layout::new(prims);
    let branches: Vec<Branch> = filtered.iter().map(|c| plan_branch(prims, c)).collect();
    let rows: usize = filtered.iter().map(|c| c.kind.arity()).sum();

    // Solve first: a residual has to be measured at the configuration the solver
    // can actually reach, otherwise a perfectly satisfiable constraint looks
    // like a conflict merely because it started far away.
    let out = solve(prims, &vec![true; prims.len()], &filtered);

    let free: Vec<usize> = (0..prims.len()).flat_map(|i| layout.block(i)).collect();
    let mut x = layout.pack(&out.prims);
    let mut scratch = Vec::with_capacity(prims.len());
    let j = jacobian_at(&layout, &out.prims, &filtered, &branches, &mut x, &free, rows, &mut scratch);

    let biggest = j.iter().fold(0.0_f64, |a, v| a.max(v.abs())).max(1.0);
    let rank = if rows == 0 || free.is_empty() {
        0
    } else {
        matrix_rank(&j, rows, free.len(), 1e-9 * biggest * (rows.max(free.len()) as f64))
    };

    let r = residuals(&out.prims, &filtered, &branches);
    let tol = report_tol(prims);
    let mut conflicts = Vec::new();
    let mut cursor = 0usize;
    for (i, c) in filtered.iter().enumerate() {
        let n = c.kind.arity();
        let worst = r[cursor..cursor + n].iter().fold(0.0_f64, |a, v| a.max(v.abs()));
        cursor += n;
        if worst > tol {
            conflicts.push(origin[i]);
        }
    }

    // ---- 哪个方向还能动（ROADMAP 0.3 的方向可视化）----------------------
    //
    // 逐个图元、逐个「人能读懂的动作」测它是否落在零空间里：
    // `‖J·m‖ ≤ tol · ‖J‖ · ‖m‖`。写成比值形式是刻意的——只看绝对量会把
    // 「大图元的小动作」误判成自由，看比值等价于问「m 与行空间夹角是否为零」。
    let mut modes = Vec::with_capacity(prims.len());
    let nf = free.len();
    for (i, p) in prims.iter().enumerate() {
        let block = layout.block(i);
        let mut flags = 0u8;
        for (flag, mv) in mode_vectors(p) {
            let norm_m = mv.iter().map(|v| v * v).sum::<f64>().sqrt();
            if norm_m <= 0.0 {
                continue;
            }
            // J·m：只用到这个图元的列，其余系数是 0。
            let mut jm = vec![0.0_f64; rows];
            for (k, v) in mv.iter().enumerate() {
                if *v == 0.0 {
                    continue;
                }
                if let Some(col) = free.iter().position(|c| *c == block.start + k) {
                    for (row, slot) in jm.iter_mut().enumerate() {
                        *slot += j[row * nf + col] * v;
                    }
                }
            }
            let norm_jm = jm.iter().map(|v| v * v).sum::<f64>().sqrt();
            if rows == 0 || norm_jm <= 1e-6 * biggest * norm_m {
                flags |= flag;
            }
        }
        modes.push(flags);
    }

    Report {
        dof: free.len().saturating_sub(rank),
        rank,
        rows,
        redundant: rows.saturating_sub(rank),
        conflicts,
        max_residual: max_abs(&r),
        solved: out.converged,
        modes,
    }
}

// ---------------------------------------------------------------------------
// Dense linear algebra (no external crates)
// ---------------------------------------------------------------------------

/// Solve `A x = b` for symmetric positive-definite `A` (row-major `n × n`) by
/// Cholesky decomposition, in place. Returns `false` when `A` turns out not to
/// be positive definite, which the caller answers by increasing the damping.
fn cholesky_solve(a: &mut [f64], b: &mut [f64], n: usize) -> bool {
    for i in 0..n {
        for j in 0..=i {
            let mut sum = a[i * n + j];
            for k in 0..j {
                sum -= a[i * n + k] * a[j * n + k];
            }
            if i == j {
                if !(sum > 0.0) {
                    return false;
                }
                a[i * n + j] = sum.sqrt();
            } else {
                a[i * n + j] = sum / a[j * n + j];
            }
        }
    }
    // Forward substitution: L y = b.
    for i in 0..n {
        let mut sum = b[i];
        for k in 0..i {
            sum -= a[i * n + k] * b[k];
        }
        b[i] = sum / a[i * n + i];
    }
    // Back substitution: Lᵀ x = y. Only the lower triangle was ever written, so
    // reading a[k * n + i] with k > i is reading Lᵀ.
    for i in (0..n).rev() {
        let mut sum = b[i];
        for k in (i + 1)..n {
            sum -= a[k * n + i] * b[k];
        }
        b[i] = sum / a[i * n + i];
    }
    true
}

// ---------------------------------------------------------------------------
// The solver
// ---------------------------------------------------------------------------

fn norm2(r: &[f64]) -> f64 {
    r.iter().map(|v| v * v).sum()
}

fn max_abs(r: &[f64]) -> f64 {
    r.iter().fold(0.0_f64, |m, v| m.max(v.abs()))
}

/// Solve `moving`'s parameters so that every constraint holds.
///
/// Only the primitives flagged in `moving` may change; everything else is a
/// constant. Callers therefore decide the *scope* of a repair, which is the
/// whole reason this is a parameter instead of "solve everything":
///
/// * dragging / moving / rotating a selection → free the selection;
/// * editing a property (radius, angle …) → free the entities that share a
///   constraint with the edited one. Freeing the edited entity too would let the
///   solver undo the very change the user just made.
pub fn solve(prims: &[Prim], moving: &[bool], raw: &[Constraint]) -> Outcome {
    let unchanged = |iters: u32| Outcome {
        prims: prims.to_vec(),
        iterations: iters,
        max_residual: 0.0,
        converged: true,
    };

    let filtered: Vec<Constraint> = raw.iter().copied().filter(|c| is_valid(prims, c)).collect();
    let touches_moving = |c: &Constraint| {
        moving.get(c.a.entity).copied().unwrap_or(false)
            || c.b.map(|b| moving.get(b.entity).copied().unwrap_or(false)).unwrap_or(false)
    };
    // A constraint that no movable primitive participates in is purely
    // informative for this call: leave the geometry alone.
    if !filtered.iter().any(touches_moving) {
        return unchanged(0);
    }

    let layout = Layout::new(prims);

    // 半径 / 半轴这类**定义尺寸**只由尺寸约束驱动，绝不被关系约束顺手改掉。
    //
    // 相切残差里同时出现圆心、直线和半径（`cross(u, cen-a) - side*r`），所以
    // 只要半径是自由变量，min-norm 步就会把它和位置**平摊**：圆心 (0,0) r=20 的
    // 圆、右侧 x=30 的竖直线，点一次「相切」会解成 r=24 / 圆心 (4,0) / 线 x=28
    // —— 数学上相切了，用户看到的是「圆被改了大小还挪了位置，线根本没过来」。
    // 穿过圆心那种更夸张：r 直接 20 → 12。
    //
    // 这也不是「最小位移」该给的东西：模块文档承诺「没碰过的自由度原地不动」，
    // 而用户点相切时没碰过半径。位置与朝向该动（关系就是关于它们的），尺寸不该动
    // —— 想改尺寸就写尺寸约束（ROADMAP 0.1/0.2：尺寸是唯一能驱动尺寸参数的东西）。
    let size_driven: Vec<bool> = (0..prims.len())
        .map(|i| {
            filtered.iter().any(|c| {
                matches!(
                    c.kind,
                    ConstraintKind::Radius | ConstraintKind::Diameter | ConstraintKind::EqualRadius
                ) && (c.a.entity == i || c.b.map_or(false, |b| b.entity == i))
            })
        })
        .collect();

    let free: Vec<usize> = {
        let mut v = Vec::new();
        for (i, m) in moving.iter().enumerate() {
            if i >= prims.len() || !*m {
                continue;
            }
            let block = layout.block(i);
            let sizes = size_slots(&prims[i]);
            for (offset, vi) in block.enumerate() {
                if sizes.contains(&offset) && !size_driven[i] {
                    continue;
                }
                v.push(vi);
            }
        }
        v
    };
    if free.is_empty() {
        return unchanged(0);
    }

    let branches: Vec<Branch> = filtered.iter().map(|c| plan_branch(prims, c)).collect();
    let m = filtered.iter().map(|c| c.kind.arity()).sum::<usize>();
    let nf = free.len();

    let mut x = layout.pack(prims);
    let mut work: Vec<Prim> = Vec::with_capacity(prims.len());
    let mut pert: Vec<Prim> = Vec::with_capacity(prims.len());

    // The closure takes its scratch buffers as arguments so it does not hold a
    // mutable borrow of `work` for the whole solve.
    let eval = |x: &[f64], scratch: &mut Vec<Prim>| -> Vec<f64> {
        layout.unpack_into(prims, x, scratch);
        residuals(&scratch[..], &filtered, &branches)
    };

    let mut r = eval(&x, &mut work);
    let mut f = norm2(&r);
    let mut iterations = 0;
    if max_abs(&r) < TOL {
        return Outcome {
            prims: work,
            iterations: 0,
            max_residual: max_abs(&r),
            converged: true,
        };
    }

    // Cap a single step to something proportional to the drawing, so a
    // near-singular system cannot teleport geometry across the plane.
    let max_step = {
        let mut b = Aabb::empty();
        for p in prims {
            b.merge(p.bounds());
        }
        if b.is_empty() {
            1.0
        } else {
            (b.max_x - b.min_x).abs().max((b.max_y - b.min_y).abs()).max(1.0)
        }
    };

    let mut h = vec![0.0; nf * nf];
    let mut g = vec![0.0; nf];
    let mut dx = vec![0.0; nf];
    let mut lambda = LAMBDA_INIT;
    let mut done = false;

    while iterations < MAX_ITER && !done {
        if max_abs(&r) < TOL {
            break;
        }
        iterations += 1;

        // ---- Jacobian by central differences ------------------------------
        let j = jacobian_at(&layout, prims, &filtered, &branches, &mut x, &free, m, &mut pert);

        // ---- g = Jᵀr, H = JᵀJ ---------------------------------------------
        for a in 0..nf {
            let mut s = 0.0;
            for row in 0..m {
                s += j[row * nf + a] * r[row];
            }
            g[a] = s;
            for b in a..nf {
                let mut s2 = 0.0;
                for row in 0..m {
                    s2 += j[row * nf + a] * j[row * nf + b];
                }
                h[a * nf + b] = s2;
                h[b * nf + a] = s2;
            }
        }

        // ---- one damped step, backtracking on failure ---------------------
        let mut accepted = false;
        for _ in 0..MAX_BACKTRACK {
            let mut a_mat = h.clone();
            for i in 0..nf {
                // **Levenberg damping: `JᵀJ + λI`** — deliberately *not*
                // Marquardt's `JᵀJ + λ·diag(JᵀJ)`.
                //
                // The Jacobian here is routinely rank-deficient: one residual
                // against four free variables is the normal case (a distance
                // pins one point of a line; that line's other three parameters,
                // and the *tangential* slide along the constraint, are all null
                // directions). `diag(JᵀJ)` scaling is not isotropic, so the
                // null-space component of the step works out to
                // `−((D·u)·v)/((D·v)·v) · α` — **independent of λ**. It does not
                // vanish as λ→0. The solver therefore slid geometry *along* the
                // constraint instead of taking the shortest step: dragging one
                // line of a `距离` pair by ~90 units threw its pinned point 35
                // units sideways around the solution circle, the trial
                // frequently failed to reduce the residual, λ was driven up by
                // backtracking, and the solve either crawled for all 80
                // iterations or gave up with the constraint violated.
                //
                // `λI` *is* isotropic, so the null-space right-hand side `g·v`
                // is exactly zero: the step is the minimum-norm one and the
                // freedom the user did not touch stays where it was — the
                // contract the module doc claims. The old `.max(1e-9)` floor
                // existed only to keep a zero curvature from making the matrix
                // singular; λ itself now does that.
                a_mat[i * nf + i] += lambda;
            }
            for i in 0..nf {
                dx[i] = -g[i];
            }
            if !cholesky_solve(&mut a_mat, &mut dx, nf) {
                lambda = (lambda * 10.0).min(LAMBDA_MAX);
                if lambda >= LAMBDA_MAX {
                    done = true;
                    break;
                }
                continue;
            }

            let step = dx.iter().map(|v| v * v).sum::<f64>().sqrt();
            if !step.is_finite() {
                done = true;
                break;
            }
            if step > max_step {
                let k = max_step / step;
                for v in dx.iter_mut() {
                    *v *= k;
                }
            }

            let mut trial = x.clone();
            for (col, &vi) in free.iter().enumerate() {
                trial[vi] += dx[col];
            }
            let r_try = eval(&trial, &mut pert);
            let f_try = norm2(&r_try);

            if f_try.is_finite() && f_try < f {
                x = trial;
                r = r_try;
                f = f_try;
                lambda = (lambda / 3.0).max(LAMBDA_MIN);
                accepted = true;
                break;
            }
            lambda = (lambda * 5.0).min(LAMBDA_MAX);
            if lambda >= LAMBDA_MAX {
                done = true;
                break;
            }
        }

        if !accepted {
            // No damping value could reduce the residual: this is as close as
            // the constraints can get, which is the normal outcome for
            // over-constrained input.
            break;
        }
    }

    layout.unpack_into(prims, &x, &mut work);
    let residual = max_abs(&r);
    Outcome {
        prims: work,
        iterations,
        max_residual: residual,
        converged: residual < TOL,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::{Circle, LineSeg};

    fn target(e: usize) -> Target {
        Target { entity: e, point_kind: PT_NONE, point_index: 0 }
    }

    /// 验收路径：两点的距离尺寸 10 → 改 80 → 几何跟着变，且不动的线不动。
    #[test]
    fn distance_between_points_drives_geometry() {
        let a = LineSeg::new(Vec2::new(0.0, 0.0), Vec2::new(50.0, 0.0));
        let b = LineSeg::new(Vec2::new(60.0, 0.0), Vec2::new(90.0, 0.0));
        let c = Constraint {
            kind: ConstraintKind::Distance,
            a: Target { entity: 0, point_kind: PT_END, point_index: 0 },
            b: Some(Target { entity: 1, point_kind: PT_START, point_index: 0 }),
            value: 80.0,
        };
        let out = solve(&[Prim::Line(a), Prim::Line(b)], &[false, true], &[c]);
        assert!(out.converged, "max residual = {}", out.max_residual);
        let rb = match &out.prims[1] {
            Prim::Line(lb) => lb,
            _ => panic!("line"),
        };
        let d = (rb.a - Vec2::new(50.0, 0.0)).length();
        assert!((d - 80.0).abs() < 1e-6, "distance = {d}");
        // The frozen line did not move.
        match &out.prims[0] {
            Prim::Line(la) => assert_eq!(la.a, Vec2::new(0.0, 0.0)),
            _ => panic!("line"),
        }
    }

    #[test]
    fn radius_targets_the_circle() {
        let c = Constraint {
            kind: ConstraintKind::Radius,
            a: target(0),
            b: None,
            value: 30.0,
        };
        let out = solve(&[Prim::Circle(Circle::new(Vec2::new(0.0, 0.0), 10.0))], &[true], &[c]);
        assert!(out.converged, "max residual = {}", out.max_residual);
        match &out.prims[0] {
            Prim::Circle(cc) => assert!((cc.radius - 30.0).abs() < 1e-6, "r = {}", cc.radius),
            _ => panic!("circle"),
        }
    }

    /// 直径 = 半径的两倍：改直径，圆的半径跟着走。
    #[test]
    fn diameter_sets_twice_the_radius() {
        let c = Constraint {
            kind: ConstraintKind::Diameter,
            a: target(0),
            b: None,
            value: 40.0,
        };
        let out = solve(&[Prim::Circle(Circle::new(Vec2::new(5.0, 5.0), 7.0))], &[true], &[c]);
        assert!(out.converged, "max residual = {}", out.max_residual);
        match &out.prims[0] {
            Prim::Circle(cc) => assert!((cc.radius - 20.0).abs() < 1e-6, "r = {}", cc.radius),
            _ => panic!("circle"),
        }
    }

    /// 45° 的两条线，尺寸问 60° → 只动第二条线，夹角跟着变。
    #[test]
    fn angle_between_lines_holds_target() {
        let a = LineSeg::new(Vec2::new(0.0, 0.0), Vec2::new(100.0, 0.0));
        let b = LineSeg::new(Vec2::new(0.0, 0.0), Vec2::new(50.0, 50.0));
        let c = Constraint {
            kind: ConstraintKind::Angle,
            a: target(0),
            b: Some(target(1)),
            value: 60.0f64.to_radians(),
        };
        let out = solve(&[Prim::Line(a), Prim::Line(b)], &[false, true], &[c]);
        assert!(out.converged, "max residual = {}", out.max_residual);
        match &out.prims[1] {
            Prim::Line(lb) => {
                let ang = lb.dir().y.atan2(lb.dir().x).abs();
                assert!(
                    (ang - 60.0f64.to_radians()).abs() < 1e-6,
                    "angle = {}°",
                    ang.to_degrees()
                );
            }
            _ => panic!("line"),
        }
        // The frozen line did not move.
        match &out.prims[0] {
            Prim::Line(la) => assert_eq!(la.a, Vec2::new(0.0, 0.0)),
            _ => panic!("line"),
        }
    }

    /// 水平距离：竖直拖走 B（y 任意），x 间距仍被拉回目标值——
    /// 这正是点-点直线距离管不到的语义。
    #[test]
    fn distance_x_pulls_only_the_axis_gap() {
        let a = LineSeg::new(Vec2::new(0.0, 0.0), Vec2::new(50.0, 0.0));
        // B 被拖到右上方：x 间距 60，y 错开 40。
        let b = LineSeg::new(Vec2::new(110.0, 40.0), Vec2::new(160.0, 40.0));
        let c = Constraint {
            kind: ConstraintKind::DistanceX,
            a: Target { entity: 0, point_kind: PT_END, point_index: 0 },
            b: Some(Target { entity: 1, point_kind: PT_START, point_index: 0 }),
            value: 80.0,
        };
        let out = solve(&[Prim::Line(a), Prim::Line(b)], &[false, true], &[c]);
        assert!(out.converged, "max residual = {}", out.max_residual);
        match &out.prims[1] {
            Prim::Line(lb) => {
                let dx = lb.a.x - 50.0;
                assert!((dx - 80.0).abs() < 1e-6, "dx = {dx}");
                // y 完全自由：保持在拖到的位置。
                assert!((lb.a.y - 40.0).abs() < 1e-6, "y = {}", lb.a.y);
            }
            _ => panic!("line"),
        }
    }

    /// 拖远之后必须解回圆上，而且必须落在**圆周上离被拖点最近的那一点**
    /// （最小位移）——修复前这里约半数方向解不回去：
    /// LM 的 `diag(JᵀJ)` 各向异性阻尼让步长的零空间分量与 λ 无关，
    /// 点会被沿约束切向甩出 20~35 个单位，试步降不下残差 → 80 次迭代爬不完。
    #[test]
    fn distance_recovers_from_a_far_drag_in_every_direction() {
        let r0 = (80.0f64 * 80.0 + 40.0 * 40.0).sqrt();
        for k in 0..72 {
            let deg = k as f64 * 5.0;
            let th = deg.to_radians();
            let anchor = Vec2::new(50.0, 0.0);
            let q = Vec2::new(anchor.x + r0 * th.cos(), r0 * th.sin());
            let a = LineSeg::new(Vec2::new(0.0, 0.0), anchor);
            let b = LineSeg::new(q, q + Vec2::new(50.0, 0.0));
            let c = Constraint {
                kind: ConstraintKind::Distance,
                a: Target { entity: 0, point_kind: PT_END, point_index: 0 },
                b: Some(Target { entity: 1, point_kind: PT_START, point_index: 0 }),
                value: 50.0,
            };
            let out = solve(&[Prim::Line(a), Prim::Line(b)], &[false, true], &[c]);
            let got = match &out.prims[1] {
                Prim::Line(l) => l.a,
                _ => panic!("line"),
            };
            let d = (got - anchor).length();
            assert!(
                out.converged && (d - 50.0).abs() < 1e-6,
                "deg={deg}: dist={d} resid={} iters={}",
                out.max_residual,
                out.iterations
            );
            // 最小位移：落点 = 圆心 + 50·(被拖方向单位向量)，不许沿圆滑走。
            let u = (q - anchor) / r0;
            let want = anchor + u * 50.0;
            let slid = (got - want).length();
            assert!(slid < 1e-6, "deg={deg}: slid {slid} along the circle");
        }
    }

    /// 相切**不许改半径**：关系约束只能挪位置/转向，尺寸参数只由尺寸约束驱动。
    /// 修复前这条会解成 r=24 / 圆心 (4,0) / 线 x=28（数学上相切，用户看到圆被改坏）。
    #[test]
    fn tangent_never_resizes_the_circle() {
        for line_at in [30.0, 24.0, 21.0, 5.0, -30.0] {
            let c = Circle::new(Vec2::new(0.0, 0.0), 20.0);
            let l = LineSeg::new(Vec2::new(line_at, -50.0), Vec2::new(line_at, 50.0));
            let con = Constraint {
                kind: ConstraintKind::Tangent,
                a: Target::whole(1),
                b: Some(Target::whole(0)),
                value: 0.0,
            };
            let out = solve(&[Prim::Circle(c), Prim::Line(l)], &[true, true], &[con]);
            assert!(out.converged, "line at x={line_at}: resid={}", out.max_residual);
            let (got_c, got_l) = match (&out.prims[0], &out.prims[1]) {
                (Prim::Circle(cc), Prim::Line(ll)) => (*cc, *ll),
                _ => panic!("circle + line"),
            };
            println!(
                "line_at={line_at:>6} -> r={:.6} center.x={:.6} line.x={:.6} tangent={:.3e}",
                got_c.radius,
                got_c.center.x,
                got_l.a.x,
                got_l.dir().cross(got_c.center - got_l.a) - got_c.radius
            );
            // 半径绝不参与：位置怎么平摊是 min-norm 的事，尺寸不是。
            assert!(
                (got_c.radius - 20.0).abs() < 1e-9,
                "line at x={line_at}: radius drifted to {}",
                got_c.radius
            );
            // 相切 = 圆心到直线的垂距等于半径（哪一侧由初始位形冻结，见 plan_branch）。
            let off = got_l.dir().cross(got_c.center - got_l.a);
            assert!(
                (off.abs() - 20.0).abs() < 1e-6,
                "line at x={line_at}: |off|={} (resid {})",
                off.abs(),
                out.max_residual
            );
        }
    }

    /// 但**尺寸约束**照样能改半径：等半径是个关于尺寸的约束，必须放它动。
    #[test]
    fn equal_radius_still_drives_the_radius() {
        let a = Constraint {
            kind: ConstraintKind::EqualRadius,
            a: Target::whole(0),
            b: Some(Target::whole(1)),
            value: 0.0,
        };
        let out = solve(
            &[
                Prim::Circle(Circle::new(Vec2::new(0.0, 0.0), 10.0)),
                Prim::Circle(Circle::new(Vec2::new(100.0, 0.0), 30.0)),
            ],
            &[true, true],
            &[a],
        );
        assert!(out.converged, "max residual = {}", out.max_residual);
        let (ra, rb) = match (&out.prims[0], &out.prims[1]) {
            (Prim::Circle(x), Prim::Circle(y)) => (x.radius, y.radius),
            _ => panic!("circles"),
        };
        // 各让一半：20 和 20（而不是原地不动）
        assert!((ra - 20.0).abs() < 1e-6 && (rb - 20.0).abs() < 1e-6, "ra={ra} rb={rb}");
    }

    /// 0.3 自由度统计：这些数字会直接显示给用户，必须精确。
    #[test]
    fn analyze_counts_degrees_of_freedom() {
        let line = || LineSeg::new(Vec2::new(0.0, 0.0), Vec2::new(50.0, 0.0));
        let circle = || Circle::new(Vec2::new(0.0, 0.0), 20.0);
        let horiz = Constraint {
            kind: ConstraintKind::Horizontal,
            a: Target::whole(0),
            b: None,
            value: 0.0,
        };
        let length = Constraint {
            kind: ConstraintKind::Distance,
            a: Target { entity: 0, point_kind: PT_START, point_index: 0 },
            b: Some(Target { entity: 0, point_kind: PT_END, point_index: 0 }),
            value: 80.0,
        };
        let radius = Constraint {
            kind: ConstraintKind::Radius,
            a: Target::whole(0),
            b: None,
            value: 20.0,
        };

        // 空草图：0 自由度、0 行，且「已解」（没有约束要违反）。
        let r = analyze(&[], &[]);
        assert_eq!((r.dof, r.rank, r.rows, r.redundant), (0, 0, 0, 0));
        assert!(r.solved && r.conflicts.is_empty());

        // 一条直线 = 4（两端点各 2）。
        let r = analyze(&[Prim::Line(line())], &[]);
        assert_eq!(r.dof, 4, "lone line");

        // + 水平 = 3（旋转被钉住）。
        let r = analyze(&[Prim::Line(line())], &[horiz]);
        assert_eq!((r.dof, r.redundant), (3, 0));

        // + 长度 = 2（只剩平移）。长度是「两端点距离」，同一个图元上。
        let r = analyze(&[Prim::Line(line())], &[horiz, length]);
        assert_eq!(r.dof, 2);
        assert!(r.solved && r.conflicts.is_empty() && r.redundant == 0);

        // 「长度」单独存在时半径式地不参与：直线仍是 3（4 − 1）。
        let r = analyze(&[Prim::Line(line())], &[length]);
        assert_eq!(r.dof, 3);

        // 圆 = 3；+ 半径尺寸 = 2（圆心仍自由）。
        let r = analyze(&[Prim::Circle(circle())], &[radius]);
        assert_eq!(r.dof, 2);

        // 半径 20 + 直径 40：一致但**多余**——不是冲突。
        let same = Constraint {
            kind: ConstraintKind::Diameter,
            a: Target::whole(0),
            b: None,
            value: 40.0,
        };
        let r = analyze(&[Prim::Circle(circle())], &[radius, same]);
        assert!(r.solved, "consistent pair must not report a conflict");
        assert_eq!((r.dof, r.rank, r.rows, r.redundant), (2, 1, 2, 1));
        assert!(r.conflicts.is_empty());

        // 半径 20 + 直径 10：真冲突——两条都点出来，dof 不变。
        let bad = Constraint {
            kind: ConstraintKind::Diameter,
            a: Target::whole(0),
            b: None,
            value: 10.0,
        };
        let r = analyze(&[Prim::Circle(circle())], &[radius, bad]);
        assert!(!r.solved);
        assert_eq!(r.conflicts, vec![0, 1]);
        assert_eq!(r.dof, 2, "a contradiction does not remove freedom");

        // 内核算不了的约束（拿整条直线当尺寸）被跳过，但**不能让后面的序号移位**。
        let nonsense = Constraint {
            kind: ConstraintKind::Distance,
            a: Target::whole(0),
            b: Some(Target::whole(0)),
            value: 10.0,
        };
        let r = analyze(&[Prim::Circle(circle())], &[nonsense, radius, bad]);
        assert_eq!(r.conflicts, vec![1, 2], "indices must map back onto the input list");
    }

    /// 相切：半径已冻结，但靠平移完全能满足 → 不许报成冲突。
    #[test]
    fn analyze_does_not_call_tangent_a_conflict() {
        let c = Prim::Circle(Circle::new(Vec2::new(0.0, 0.0), 20.0));
        let l = Prim::Line(LineSeg::new(Vec2::new(30.0, -50.0), Vec2::new(30.0, 50.0)));
        let con = Constraint {
            kind: ConstraintKind::Tangent,
            a: Target::whole(1),
            b: Some(Target::whole(0)),
            value: 0.0,
        };
        let r = analyze(&[c, l], &[con]);
        assert!(r.solved && r.conflicts.is_empty(), "resid={}", r.max_residual);
        // 圆 3 + 直线 4 = 7 个参数，1 条残差 → 6 个自由度。
        assert_eq!((r.dof, r.rank, r.rows, r.redundant), (6, 1, 1, 0));
    }

    /// 0.3 方向可视化：每个图元还剩哪些**人能读懂的动作**。
    #[test]
    fn analyze_reports_which_motions_are_still_free() {
        let line = || LineSeg::new(Vec2::new(0.0, 0.0), Vec2::new(50.0, 0.0));
        let horiz = Constraint {
            kind: ConstraintKind::Horizontal,
            a: Target::whole(0),
            b: None,
            value: 0.0,
        };
        let length = Constraint {
            kind: ConstraintKind::Distance,
            a: Target { entity: 0, point_kind: PT_START, point_index: 0 },
            b: Some(Target { entity: 0, point_kind: PT_END, point_index: 0 }),
            value: 80.0,
        };

        // 自由直线：平移 / 转动 / 改长度都能动。
        let r = analyze(&[Prim::Line(line())], &[]);
        assert_eq!(r.modes, vec![MODE_TX | MODE_TY | MODE_ROT | MODE_SIZE]);

        // 加了水平：转动被钉住，平移与长度还在。
        let r = analyze(&[Prim::Line(line())], &[horiz]);
        assert_eq!(r.modes, vec![MODE_TX | MODE_TY | MODE_SIZE], "horizontal kills rotation");
        assert_eq!(r.dof, 3);

        // 水平 + 长度：只剩平移（长度也不能改了）。
        let r = analyze(&[Prim::Line(line())], &[horiz, length]);
        assert_eq!(r.modes, vec![MODE_TX | MODE_TY]);
        assert_eq!(r.dof, 2);

        // 圆：没有自己的转动；半径没写尺寸 → 可伸缩。
        let r = analyze(&[Prim::Circle(Circle::new(Vec2::new(0.0, 0.0), 20.0))], &[]);
        assert_eq!(r.modes, vec![MODE_TX | MODE_TY | MODE_SIZE]);

        // 圆 + 半径尺寸：尺寸被定住，圆心仍可平移。
        let rad = Constraint {
            kind: ConstraintKind::Radius,
            a: Target::whole(0),
            b: None,
            value: 20.0,
        };
        let r = analyze(&[Prim::Circle(Circle::new(Vec2::new(0.0, 0.0), 20.0))], &[rad]);
        assert_eq!(r.modes, vec![MODE_TX | MODE_TY]);
    }

    /// 端点重合的两条线：绕**接点**转是自由的（绕各自质心不是）——只测质心会漏报。
    #[test]
    fn analyze_sees_rotation_about_a_shared_endpoint() {
        let a = Prim::Line(LineSeg::new(Vec2::new(0.0, 0.0), Vec2::new(50.0, 0.0)));
        let b = Prim::Line(LineSeg::new(Vec2::new(50.0, 0.0), Vec2::new(50.0, 40.0)));
        let join = Constraint {
            kind: ConstraintKind::Coincident,
            a: Target { entity: 0, point_kind: PT_END, point_index: 0 },
            b: Some(Target { entity: 1, point_kind: PT_START, point_index: 0 }),
            value: 0.0,
        };
        let r = analyze(&[a, b], &[join]);
        assert!(r.solved && r.conflicts.is_empty());
        assert_eq!(r.modes[0] & MODE_ROT, MODE_ROT, "line A can swing about the joint");
        assert_eq!(r.modes[1] & MODE_ROT, MODE_ROT, "line B can swing about the joint");
        // 8 个参数、2 条残差 → 6 个自由度
        assert_eq!(r.dof, 6);
    }

    /// 过约束退化：一个圆同时被半径 35 和直径 20（即 r=10）钉住，必须收敛到
    /// 最小二乘折衷，不能死循环，也不能产出 NaN。
    #[test]
    fn contradictory_dimensions_degrade_gracefully() {
        let r35 = Constraint { kind: ConstraintKind::Radius, a: target(0), b: None, value: 35.0 };
        let d20 = Constraint { kind: ConstraintKind::Diameter, a: target(0), b: None, value: 20.0 };
        let out = solve(
            &[Prim::Circle(Circle::new(Vec2::new(0.0, 0.0), 20.0))],
            &[true],
            &[r35, d20],
        );
        assert!(!out.converged, "over-constrained input must not report success");
        match &out.prims[0] {
            Prim::Circle(cc) => assert!(cc.radius.is_finite(), "radius went non-finite"),
            _ => panic!("circle"),
        }
    }
}
