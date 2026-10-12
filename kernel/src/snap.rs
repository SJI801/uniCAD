//! Object snap (OSNAP) candidate generation.
//!
//! Given a cursor position and the entities currently inside the picking
//! aperture, produce a ranked list of snap candidates: endpoints, midpoints,
//! centres, quadrants, perpendicular feet, nearest-on-curve, plus grid and
//! intersection snaps.

use crate::geom::Prim;
use crate::math::Vec2;
use crate::query;

/// Snap kinds, mirrored 1:1 by the TypeScript `SnapKind` union.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SnapKind {
    Endpoint = 0,
    Midpoint = 1,
    Center = 2,
    Quadrant = 3,
    Perpendicular = 4,
    Nearest = 5,
    Intersection = 6,
    Tangent = 7,
    Grid = 8,
}

impl SnapKind {
    /// Priority — lower wins when several candidates are within tolerance.
    pub fn priority(self) -> u8 {
        match self {
            SnapKind::Endpoint => 0,
            SnapKind::Intersection => 1,
            SnapKind::Midpoint => 2,
            SnapKind::Center => 3,
            SnapKind::Quadrant => 4,
            SnapKind::Perpendicular => 5,
            SnapKind::Tangent => 6,
            SnapKind::Nearest => 8,
            SnapKind::Grid => 9,
        }
    }

    pub fn from_u8(v: u8) -> SnapKind {
        match v {
            0 => SnapKind::Endpoint,
            1 => SnapKind::Midpoint,
            2 => SnapKind::Center,
            3 => SnapKind::Quadrant,
            4 => SnapKind::Perpendicular,
            5 => SnapKind::Nearest,
            6 => SnapKind::Intersection,
            7 => SnapKind::Tangent,
            _ => SnapKind::Grid,
        }
    }
}

/// One candidate produced by the snap engine.
#[derive(Clone, Copy, Debug)]
pub struct SnapCandidate {
    pub point: Vec2,
    pub kind: SnapKind,
    /// Which entity produced it (ignored for grid snaps).
    pub entity: u32,
    /// Distance from the cursor.
    pub distance: f64,
}

/// Mask of enabled snap kinds, packed as a bitfield by the front-end so the
/// whole configuration crosses the FFI as a single `u32`.
pub struct SnapMask(pub u32);

impl SnapMask {
    #[inline]
    pub fn has(&self, k: SnapKind) -> bool {
        self.0 & (1 << (k as u8)) != 0
    }
}

/// Context needed to compute perpendicular / tangent snaps.
#[derive(Clone, Copy, Debug, Default)]
pub struct SnapContext {
    /// The last committed point — the base for perpendicular and tangent snaps.
    pub from: Option<Vec2>,
}

/// Generate every snap candidate for `cursor` against `prims`.
///
/// `entities[i]` is the stable entity id of `prims[i]` (used by the UI to
/// highlight the source entity while a snap marker is shown).
pub fn collect(
    prims: &[Prim],
    entities: &[u32],
    cursor: Vec2,
    tol: f64,
    mask: &SnapMask,
    ctx: &SnapContext,
) -> Vec<SnapCandidate> {
    let mut out: Vec<SnapCandidate> = Vec::new();

    for (i, prim) in prims.iter().enumerate() {
        let id = entities.get(i).copied().unwrap_or(0);
        // Cheap rejection against the cached geometry bounds.
        if !prim.bounds().expanded(tol).contains(cursor) {
            // Perpendicular/tangent snaps can land outside the bbox of the
            // entity itself, so still allow those through when a base point
            // exists and the bbox is "near enough".
            if ctx.from.is_none() {
                continue;
            }
        }

        let push = |point: Vec2, kind: SnapKind, out: &mut Vec<SnapCandidate>| {
            let d = point.distance_to(cursor);
            if d <= tol {
                out.push(SnapCandidate { point, kind, entity: id, distance: d });
            }
        };

        match prim {
            Prim::Line(l) => {
                if mask.has(SnapKind::Endpoint) {
                    push(l.a, SnapKind::Endpoint, &mut out);
                    push(l.b, SnapKind::Endpoint, &mut out);
                }
                if mask.has(SnapKind::Midpoint) {
                    push(l.midpoint(), SnapKind::Midpoint, &mut out);
                }
                if mask.has(SnapKind::Perpendicular) {
                    if let Some(from) = ctx.from {
                        let (foot, t) = l.closest_on_line(from);
                        if (0.0..=1.0).contains(&t) {
                            push(foot, SnapKind::Perpendicular, &mut out);
                        }
                    }
                }
                if mask.has(SnapKind::Nearest) {
                    push(l.closest_point(cursor), SnapKind::Nearest, &mut out);
                }
            }
            Prim::Circle(c) => {
                if mask.has(SnapKind::Center) {
                    push(c.center, SnapKind::Center, &mut out);
                }
                if mask.has(SnapKind::Quadrant) {
                    for a in [0.0, core::f64::consts::FRAC_PI_2, core::f64::consts::PI, 4.712388980384690] {
                        push(c.center + Vec2::new(a.cos(), a.sin()) * c.radius, SnapKind::Quadrant, &mut out);
                    }
                }
                if mask.has(SnapKind::Perpendicular) {
                    if let Some(from) = ctx.from {
                        // Feet of perpendiculars from `from` onto the circle: the
                        // near point and the far point along the centre line.
                        let v = from - c.center;
                        let l = v.length();
                        if l > 1e-12 {
                            let u = v.normalized();
                            push(c.center + u * c.radius, SnapKind::Perpendicular, &mut out);
                            push(c.center - u * c.radius, SnapKind::Perpendicular, &mut out);
                        }
                    }
                }
                if mask.has(SnapKind::Tangent) {
                    if let Some(from) = ctx.from {
                        let d = from.distance_to(c.center);
                        if d > c.radius + 1e-9 {
                            // A tangent point T on the circle satisfies T·(T - from) = 0
                            // (the radius is perpendicular to the tangent line). Writing
                            // `base` as the direction from the circle centre towards the
                            // external point, the two tangent points sit at
                            // `base ± alpha` with `alpha = acos(r / d)`.
                            let alpha = (c.radius / d).clamp(-1.0, 1.0).acos();
                            let base = (from - c.center).angle();
                            for a in [base + alpha, base - alpha] {
                                let t = c.center + Vec2::new(a.cos(), a.sin()) * c.radius;
                                push(t, SnapKind::Tangent, &mut out);
                            }
                        }
                    }
                }
                if mask.has(SnapKind::Nearest) {
                    let v = (cursor - c.center).normalized();
                    push(c.center + v * c.radius, SnapKind::Nearest, &mut out);
                }
            }
            Prim::Arc(a) => {
                if mask.has(SnapKind::Endpoint) {
                    push(a.start_point(), SnapKind::Endpoint, &mut out);
                    push(a.end_point(), SnapKind::Endpoint, &mut out);
                }
                if mask.has(SnapKind::Midpoint) {
                    push(a.midpoint(), SnapKind::Midpoint, &mut out);
                }
                if mask.has(SnapKind::Center) {
                    push(a.center, SnapKind::Center, &mut out);
                }
                if mask.has(SnapKind::Quadrant) {
                    for q in [0.0, core::f64::consts::FRAC_PI_2, core::f64::consts::PI, 4.712388980384690] {
                        if crate::math::angle_in_ccw_sweep(q, a.start_angle, a.end_angle) {
                            push(a.center + Vec2::new(q.cos(), q.sin()) * a.radius, SnapKind::Quadrant, &mut out);
                        }
                    }
                }
                if mask.has(SnapKind::Perpendicular) {
                    if let Some(from) = ctx.from {
                        let v = from - a.center;
                        if v.length_sq() > 1e-18 {
                            let p = a.center + v.normalized() * a.radius;
                            if a.contains_angle_of(p) {
                                push(p, SnapKind::Perpendicular, &mut out);
                            }
                        }
                    }
                }
                if mask.has(SnapKind::Nearest) {
                    push(a.closest_point(cursor), SnapKind::Nearest, &mut out);
                }
            }
            Prim::Ellipse(e) => {
                if mask.has(SnapKind::Center) {
                    push(e.center, SnapKind::Center, &mut out);
                }
                if mask.has(SnapKind::Quadrant) {
                    for t in [0.0, core::f64::consts::FRAC_PI_2, core::f64::consts::PI, 4.712388980384690] {
                        push(e.point_at(t), SnapKind::Quadrant, &mut out);
                    }
                }
                if mask.has(SnapKind::Nearest) {
                    push(e.closest_point(cursor), SnapKind::Nearest, &mut out);
                }
            }
            Prim::Polyline(pl) => {
                let n = pl.points.len();
                if n == 0 {
                    continue;
                }
                if mask.has(SnapKind::Endpoint) {
                    push(pl.points[0], SnapKind::Endpoint, &mut out);
                    push(pl.points[n - 1], SnapKind::Endpoint, &mut out);
                }
                if mask.has(SnapKind::Midpoint) {
                    for i in 0..pl.segment_count() {
                        if let Some(s) = pl.segment(i) {
                            push(s.midpoint(), SnapKind::Midpoint, &mut out);
                        }
                    }
                }
                if mask.has(SnapKind::Perpendicular) {
                    if let Some(from) = ctx.from {
                        for i in 0..pl.segment_count() {
                            if let Some(s) = pl.segment(i) {
                                let (foot, t) = s.closest_on_line(from);
                                if (0.0..=1.0).contains(&t) {
                                    push(foot, SnapKind::Perpendicular, &mut out);
                                }
                            }
                        }
                    }
                }
                if mask.has(SnapKind::Nearest) {
                    let (pt, _, _) = query::polyline_closest(pl, cursor);
                    push(pt, SnapKind::Nearest, &mut out);
                }
            }
        }
    }

    // Intersection snaps require pairwise work, so do them once over the
    // entities actually inside the aperture.
    if mask.has(SnapKind::Intersection) {
        let near: Vec<(usize, &Prim)> = prims
            .iter()
            .enumerate()
            .filter(|(_, p)| p.bounds().expanded(tol).contains(cursor))
            .collect();
        for i in 0..near.len() {
            for j in (i + 1)..near.len() {
                for pt in query::intersect(near[i].1, near[j].1, tol * 0.5, 128) {
                    let d = pt.distance_to(cursor);
                    if d <= tol {
                        out.push(SnapCandidate {
                            point: pt,
                            kind: SnapKind::Intersection,
                            entity: entities.get(near[i].0).copied().unwrap_or(0),
                            distance: d,
                        });
                    }
                }
            }
        }
    }

    out
}

/// Grid snap: round `cursor` to the nearest multiple of `step`.
#[inline]
pub fn snap_to_grid(cursor: Vec2, step: f64) -> Vec2 {
    if step <= 1e-12 {
        return cursor;
    }
    Vec2::new((cursor.x / step).round() * step, (cursor.y / step).round() * step)
}

/// Orthogonal / polar constraint from `from` towards `to`.
///
/// `polar_angles` is a list of allowed directions in radians; ortho is simply
/// `[0, π/2, π, 3π/2]`. Returns the constrained point, keeping the projected
/// length along the chosen direction.
pub fn constrain_polar(from: Vec2, to: Vec2, polar_angles: &[f64], tol: f64) -> Vec2 {
    let v = to - from;
    let dist = v.length();
    if dist < 1e-12 || polar_angles.is_empty() {
        return to;
    }
    let a = v.angle();
    let mut best = polar_angles[0];
    let mut best_d = f64::INFINITY;
    for &pa in polar_angles {
        // Angular distance on the circle.
        let mut d = (a - pa) % core::f64::consts::TAU;
        if d > core::f64::consts::PI {
            d -= core::f64::consts::TAU;
        }
        if d < -core::f64::consts::PI {
            d += core::f64::consts::TAU;
        }
        let d = d.abs();
        if d < best_d {
            best_d = d;
            best = pa;
        }
    }
    if best_d > tol {
        return to;
    }
    // Project the vector onto the chosen ray, preserving its direction sign.
    let dir = Vec2::new(best.cos(), best.sin());
    let proj = v.dot(dir);
    from + dir * proj
}

/// Best candidate, applying priority ordering and cursor distance.
pub fn best_candidate(cands: &[SnapCandidate]) -> Option<SnapCandidate> {
    let mut best: Option<SnapCandidate> = None;
    for c in cands {
        match best {
            None => best = Some(*c),
            Some(b) => {
                let bp = b.kind.priority();
                let cp = c.kind.priority();
                if cp < bp || (cp == bp && c.distance < b.distance) {
                    best = Some(*c);
                }
            }
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::{Arc, Circle, LineSeg};
    use crate::math::{Mat3, Vec2};

    fn mask_all() -> SnapMask {
        SnapMask(0xFFFF)
    }

    #[test]
    fn endpoint_snap_wins_over_nearest() {
        let line = LineSeg::new(Vec2::new(0.0, 0.0), Vec2::new(100.0, 0.0));
        let prims = vec![Prim::Line(line)];
        let ids = vec![7u32];
        let cands = collect(
            &prims,
            &ids,
            Vec2::new(0.3, 0.2),
            1.0,
            &mask_all(),
            &SnapContext::default(),
        );
        let best = best_candidate(&cands).unwrap();
        assert_eq!(best.kind, SnapKind::Endpoint);
        assert_eq!(best.entity, 7);
        assert!(best.point.x.abs() < 1e-9);
    }

    #[test]
    fn circle_center_and_quadrant_snaps() {
        let prims = vec![Prim::Circle(Circle::new(Vec2::new(10.0, 10.0), 5.0))];
        let ids = vec![1u32];
        let cands = collect(&prims, &ids, Vec2::new(10.2, 10.1), 1.0, &mask_all(), &SnapContext::default());
        let best = best_candidate(&cands).unwrap();
        assert_eq!(best.kind, SnapKind::Center);

        let cands = collect(&prims, &ids, Vec2::new(15.1, 10.05), 1.0, &mask_all(), &SnapContext::default());
        let best = best_candidate(&cands).unwrap();
        assert_eq!(best.kind, SnapKind::Quadrant);
        assert!((best.point.x - 15.0).abs() < 1e-9);
    }

    #[test]
    fn perpendicular_snap_on_line() {
        let prims = vec![Prim::Line(LineSeg::new(Vec2::new(0.0, 0.0), Vec2::new(100.0, 0.0)))];
        let ids = vec![3u32];
        let ctx = SnapContext { from: Some(Vec2::new(30.0, 40.0)) };
        // Cursor near the foot of the perpendicular (30, 0) — deliberately far
        // from the midpoint (50, 0) so the mid-point snap cannot outrank it.
        let cands = collect(&prims, &ids, Vec2::new(30.1, 0.2), 1.0, &mask_all(), &ctx);
        let best = best_candidate(&cands).unwrap();
        assert_eq!(best.kind, SnapKind::Perpendicular);
        assert!((best.point.x - 30.0).abs() < 1e-9, "x = {}", best.point.x);
        assert!((best.point.y).abs() < 1e-9);
    }

    #[test]
    fn intersection_snap_between_two_lines() {
        let prims = vec![
            Prim::Line(LineSeg::new(Vec2::new(0.0, 0.0), Vec2::new(10.0, 10.0))),
            Prim::Line(LineSeg::new(Vec2::new(0.0, 10.0), Vec2::new(10.0, 0.0))),
        ];
        let ids = vec![1u32, 2u32];
        let cands = collect(&prims, &ids, Vec2::new(5.2, 4.9), 1.0, &mask_all(), &SnapContext::default());
        let best = best_candidate(&cands).unwrap();
        assert_eq!(best.kind, SnapKind::Intersection);
        assert!((best.point.x - 5.0).abs() < 1e-9 && (best.point.y - 5.0).abs() < 1e-9);
    }

    #[test]
    fn disabled_kinds_are_skipped() {
        // Only endpoint enabled.
        let mask = SnapMask(1 << (SnapKind::Endpoint as u8));
        let prims = vec![Prim::Circle(Circle::new(Vec2::new(0.0, 0.0), 10.0))];
        let ids = vec![1u32];
        let cands = collect(&prims, &ids, Vec2::new(0.1, 0.1), 1.0, &mask, &SnapContext::default());
        assert!(cands.is_empty());
    }

    #[test]
    fn grid_snap_rounds_correctly() {
        let p = snap_to_grid(Vec2::new(4.4, -6.6), 5.0);
        assert!((p.x - 5.0).abs() < 1e-9);
        assert!((p.y + 5.0).abs() < 1e-9);
    }

    #[test]
    fn polar_constraint_locks_to_ortho() {
        let ortho = [0.0, core::f64::consts::FRAC_PI_2, core::f64::consts::PI, 4.712388980384690];
        // Nearly horizontal → should snap flat and keep the X distance.
        let p = constrain_polar(Vec2::new(0.0, 0.0), Vec2::new(10.0, 0.3), &ortho, 0.1);
        assert!((p.y).abs() < 1e-9);
        assert!((p.x - 10.0).abs() < 1e-6);

        // Nearly vertical → snap to the Y axis.
        let p = constrain_polar(Vec2::new(0.0, 0.0), Vec2::new(0.3, 10.0), &ortho, 0.1);
        assert!((p.x).abs() < 1e-9);
        assert!((p.y - 10.0).abs() < 1e-6);

        // Free direction is left untouched.
        let raw = Vec2::new(7.0, 7.0);
        let p = constrain_polar(Vec2::new(0.0, 0.0), raw, &ortho, 0.1);
        assert_eq!(p, raw);
    }

    #[test]
    fn arc_quadrant_only_inside_sweep() {
        // Quarter arc 0..90°, so only the (r,0) and (0,r) quadrants exist.
        let prims = vec![Prim::Arc(Arc::new(
            Vec2::new(0.0, 0.0),
            10.0,
            0.0,
            core::f64::consts::FRAC_PI_2,
        ))];
        let ids = vec![1u32];
        let cands = collect(&prims, &ids, Vec2::new(-10.05, 0.05), 1.0, &mask_all(), &SnapContext::default());
        // The (-10, 0) quadrant is outside the sweep, so no quadrant snap there.
        assert!(!cands.iter().any(|c| c.kind == SnapKind::Quadrant));
    }

    #[test]
    fn tangent_snap_from_external_point() {
        let circ = Circle::new(Vec2::new(0.0, 0.0), 5.0);
        let from = Vec2::new(20.0, 0.0);
        let prims = vec![Prim::Circle(circ)];
        let ids = vec![1u32];
        let ctx = SnapContext { from: Some(from) };
        // Tangent point for r = 5 seen from (20, 0): alpha = acos(5/20), so the
        // upper tangent point is 5 * (cos alpha, sin alpha) = (1.25, sqrt(23.4375)).
        let alpha = (5.0f64 / 20.0).acos();
        let expected = Vec2::new(5.0 * alpha.cos(), 5.0 * alpha.sin());
        let cands = collect(&prims, &ids, expected, 0.5, &mask_all(), &ctx);
        let best = best_candidate(&cands).unwrap();
        assert_eq!(best.kind, SnapKind::Tangent);
        assert!((best.point.x - expected.x).abs() < 1e-6, "x = {}", best.point.x);
        assert!((best.point.y - expected.y).abs() < 1e-6, "y = {}", best.point.y);
        // Sanity: the tangent point really is on the circle.
        assert!((best.point.length() - 5.0).abs() < 1e-9);
    }
}
