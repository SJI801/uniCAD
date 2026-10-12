//! Spatial queries: hit-testing, distance measurement and intersections.
//!
//! These are the hot paths the front-end leans on for picking and for the
//! live "distance / angle" readout in the status bar, so they are all written
//! against model-space doubles and never allocate in the inner loop.

use crate::geom::{Arc, Circle, Ellipse, LineSeg, Polyline, Prim};
use crate::math::{Aabb, Vec2};

/// A picking hit against an entity.
#[derive(Clone, Copy, Debug)]
pub struct Hit {
    pub id: u32,
    /// Distance in model units from the probe point to the entity.
    pub distance: f64,
    /// The closest point on the entity.
    pub point: Vec2,
}

/// Test whether a entity lies within `tol` of the probe point, first culling
/// with the bounding box (which is stored/cached on the front-end).
pub fn hit_test(prim: &Prim, bounds: &Aabb, p: Vec2, tol: f64) -> Option<Hit> {
    if !bounds.expanded(tol).contains(p) {
        return None;
    }
    let d = prim.distance_to(p);
    if d <= tol {
        let point = match prim {
            Prim::Line(l) => l.closest_point(p),
            Prim::Circle(c) => {
                let v = (p - c.center).normalized();
                c.center + v * c.radius
            }
            Prim::Arc(_) | Prim::Ellipse(_) | Prim::Polyline(_) => prim.closest_point_of(p),
        };
        Some(Hit { id: 0, distance: d, point })
    } else {
        None
    }
}

impl Prim {
    /// Closest point on this primitive, dispatching to the right formula.
    pub fn closest_point_of(&self, p: Vec2) -> Vec2 {
        match self {
            Prim::Line(l) => l.closest_point(p),
            Prim::Circle(c) => {
                let v = (p - c.center).normalized();
                if v.length_sq() < 1e-18 {
                    c.center + Vec2::new(c.radius, 0.0)
                } else {
                    c.center + v * c.radius
                }
            }
            Prim::Arc(a) => a.closest_point(p),
            Prim::Ellipse(e) => e.closest_point(p),
            Prim::Polyline(pl) => {
                let mut best = pl.points.first().copied().unwrap_or(Vec2::zero());
                let mut best_d = f64::INFINITY;
                for i in 0..pl.segment_count() {
                    if let Some(s) = pl.segment(i) {
                        let c = s.closest_point(p);
                        let d = c.distance_to(p);
                        if d < best_d {
                            best_d = d;
                            best = c;
                        }
                    }
                }
                best
            }
        }
    }
}

/// Minimum distance between two primitives (approximated by segment distance
/// after tessellation — robust and fast enough for drawing feedback).
pub fn distance_between(a: &Prim, b: &Prim, tol: f64, max_seg: u32) -> f64 {
    let sa = a.to_segments(tol, max_seg);
    let sb = b.to_segments(tol, max_seg);
    let mut best = f64::INFINITY;
    for x in &sa {
        for y in &sb {
            best = best.min(segment_segment_distance(x, y));
        }
    }
    best
}

/// Closest distance between two finite segments.
pub fn segment_segment_distance(a: &LineSeg, b: &LineSeg) -> f64 {
    if a.intersect(b).is_some() {
        return 0.0;
    }
    let d1 = a.distance_to(b.a).min(a.distance_to(b.b));
    let d2 = b.distance_to(a.a).min(b.distance_to(a.b));
    d1.min(d2)
}

/// Collect every intersection point between two primitives.
///
/// Exact, closed-form solutions are used where they exist (line/line,
/// circle/line, circle/circle); everything else falls back to segment
/// intersection on the tessellated form, deduplicating coincident results.
pub fn intersect(a: &Prim, b: &Prim, tol: f64, max_seg: u32) -> Vec<Vec2> {
    let mut out: Vec<Vec2> = Vec::new();

    match (a, b) {
        (Prim::Line(la), Prim::Line(lb)) => {
            if let Some((_, _, p)) = la.intersect(lb) {
                out.push(p);
            }
        }
        (Prim::Line(l), Prim::Circle(c)) | (Prim::Circle(c), Prim::Line(l)) => {
            c.intersect_segment(l, &mut out);
        }
        (Prim::Circle(ca), Prim::Circle(cb)) => {
            ca.intersect_circle(cb, &mut out);
        }
        (Prim::Line(l), Prim::Arc(arc)) | (Prim::Arc(arc), Prim::Line(l)) => {
            let mut hits = Vec::new();
            arc.circle().intersect_segment(l, &mut hits);
            for p in hits {
                if arc.contains_angle_of(p) {
                    out.push(p);
                }
            }
        }
        _ => {
            let sa = a.to_segments(tol, max_seg);
            let sb = b.to_segments(tol, max_seg);
            for x in &sa {
                for y in &sb {
                    if let Some((_, _, p)) = x.intersect(y) {
                        out.push(p);
                    }
                }
            }
        }
    }

    dedupe_points(&mut out, 1e-7);
    out
}

/// Intersect a list of primitives against a single primitive, returning
/// `(entity_index, point)` pairs — the workhorse behind snap-intersection.
pub fn intersect_many(prims: &[Prim], probe: &Prim, tol: f64, max_seg: u32) -> Vec<(usize, Vec2)> {
    let mut out = Vec::new();
    let pb = probe.bounds();
    for (i, p) in prims.iter().enumerate() {
        if !pb.expanded(tol).intersects(&p.bounds()) {
            continue;
        }
        for pt in intersect(p, probe, tol, max_seg) {
            out.push((i, pt));
        }
    }
    out
}

fn dedupe_points(pts: &mut Vec<Vec2>, eps: f64) {
    let eps_sq = eps * eps;
    let mut i = 0;
    while i < pts.len() {
        let mut j = i + 1;
        while j < pts.len() {
            if (pts[i] - pts[j]).length_sq() <= eps_sq {
                pts.swap_remove(j);
            } else {
                j += 1;
            }
        }
        i += 1;
    }
}

impl Arc {
    /// The full circle this arc is a subset of.
    #[inline]
    pub fn circle(&self) -> Circle {
        Circle::new(self.center, self.radius)
    }

    /// Whether the radial direction of `p` falls inside this arc's sweep.
    #[inline]
    pub fn contains_angle_of(&self, p: Vec2) -> bool {
        let v = p - self.center;
        if v.length_sq() < 1e-18 {
            return false;
        }
        crate::math::angle_in_ccw_sweep(v.angle(), self.start_angle, self.end_angle)
    }
}

/// Distance from a point to a polyline, plus the parametric location of the
/// closest segment — used to place "insert vertex" handles.
pub fn polyline_closest(pl: &Polyline, p: Vec2) -> (Vec2, usize, f64) {
    let mut best = Vec2::zero();
    let mut best_seg = 0usize;
    let mut best_t = 0.0;
    let mut best_d = f64::INFINITY;
    for i in 0..pl.segment_count() {
        if let Some(s) = pl.segment(i) {
            let (_, t) = s.closest_on_line(p);
            let tc = t.clamp(0.0, 1.0);
            let cp = s.a.lerp(s.b, tc);
            let d = cp.distance_to(p);
            if d < best_d {
                best_d = d;
                best = cp;
                best_seg = i;
                best_t = t;
            }
        }
    }
    (best, best_seg, best_t)
}

/// Signed area of a closed polygon (CCW positive) — used by area readout and
/// the hatch/trim routines.
pub fn signed_area(pts: &[Vec2]) -> f64 {
    if pts.len() < 3 {
        return 0.0;
    }
    let mut a = 0.0;
    let n = pts.len();
    for i in 0..n {
        a += pts[i].cross(pts[(i + 1) % n]);
    }
    a * 0.5
}

/// Whether a point is inside a closed polygon (ray casting).
pub fn point_in_polygon(pts: &[Vec2], p: Vec2) -> bool {
    let n = pts.len();
    if n < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let a = pts[i];
        let b = pts[j];
        if (a.y > p.y) != (b.y > p.y) {
            let x = (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x;
            if p.x < x {
                inside = !inside;
            }
        }
        j = i;
    }
    inside
}

/// Whether an ellipse lies fully inside an axis-aligned selection rectangle.
pub fn ellipse_in_rect(e: &Ellipse, min: Vec2, max: Vec2) -> bool {
    let b = e.bounds();
    b.min_x >= min.x && b.min_y >= min.y && b.max_x <= max.x && b.max_y <= max.y
}

/// Whether a circle lies fully inside an axis-aligned selection rectangle.
pub fn circle_in_rect(c: &Circle, min: Vec2, max: Vec2) -> bool {
    let b = c.bounds();
    b.min_x >= min.x && b.min_y >= min.y && b.max_x <= max.x && b.max_y <= max.y
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_line_intersection_through_wrapper() {
        let a = Prim::Line(LineSeg::new(Vec2::new(0.0, 0.0), Vec2::new(10.0, 10.0)));
        let b = Prim::Line(LineSeg::new(Vec2::new(0.0, 10.0), Vec2::new(10.0, 0.0)));
        let pts = intersect(&a, &b, 0.01, 64);
        assert_eq!(pts.len(), 1);
        assert!((pts[0].x - 5.0).abs() < 1e-9 && (pts[0].y - 5.0).abs() < 1e-9);
    }

    #[test]
    fn parallel_lines_do_not_intersect() {
        let a = Prim::Line(LineSeg::new(Vec2::new(0.0, 0.0), Vec2::new(10.0, 0.0)));
        let b = Prim::Line(LineSeg::new(Vec2::new(0.0, 5.0), Vec2::new(10.0, 5.0)));
        assert!(intersect(&a, &b, 0.01, 64).is_empty());
        assert!((distance_between(&a, &b, 0.01, 64) - 5.0).abs() < 1e-9);
    }

    #[test]
    fn line_circle_intersection() {
        let l = Prim::Line(LineSeg::new(Vec2::new(-10.0, 0.0), Vec2::new(10.0, 0.0)));
        let c = Prim::Circle(Circle::new(Vec2::new(0.0, 0.0), 4.0));
        let pts = intersect(&l, &c, 0.01, 128);
        assert_eq!(pts.len(), 2);
        for p in &pts {
            assert!((p.x.abs() - 4.0).abs() < 1e-9);
        }
    }

    #[test]
    fn arc_line_intersection_respects_sweep() {
        // Upper half circle (0..PI) crossed by the X axis. Both endpoints of the
        // arc — (5,0) and (-5,0) — are genuine intersections, so expect two.
        let arc = Prim::Arc(Arc::new(Vec2::new(0.0, 0.0), 5.0, 0.0, core::f64::consts::PI));
        let l = Prim::Line(LineSeg::new(Vec2::new(-10.0, 0.0), Vec2::new(10.0, 0.0)));
        let mut pts = intersect(&arc, &l, 0.01, 128);
        assert_eq!(pts.len(), 2);
        pts.sort_by(|p, q| p.x.partial_cmp(&q.x).unwrap());
        assert!((pts[0].x + 5.0).abs() < 1e-9, "x0 = {}", pts[0].x);
        assert!((pts[1].x - 5.0).abs() < 1e-9, "x1 = {}", pts[1].x);
    }

    #[test]
    fn arc_line_intersection_ignores_out_of_sweep_hit() {
        // Upper half circle crossed by a vertical line at x = 2. The circle has
        // hits at (2, ±sqrt(21)); only the +Y one lies on the sweep.
        let arc = Prim::Arc(Arc::new(Vec2::new(0.0, 0.0), 5.0, 0.0, core::f64::consts::PI));
        let l = Prim::Line(LineSeg::new(Vec2::new(2.0, -10.0), Vec2::new(2.0, 10.0)));
        let pts = intersect(&arc, &l, 0.01, 128);
        assert_eq!(pts.len(), 1);
        assert!((pts[0].y - 21f64.sqrt()).abs() < 1e-9, "y = {}", pts[0].y);
    }

    /// A line meeting an arc exactly at its two feet (the demo drawing's top edge
    /// against its semicircle) is the everyday trim case. Both feet are cut
    /// points; the one at the arc's *start* endpoint used to be dropped because
    /// its recomputed angle lands a rounding error below `start_angle` and wraps
    /// to ~2π in the sweep test — so the trim silently lost a segment.
    #[test]
    fn line_meeting_arc_at_both_feet_finds_both() {
        // Exactly `solveArcTS({40,80},{60,96},{80,80})`.
        let arc = Prim::Arc(Arc::new(
            Vec2::new(60.0, 75.5),
            20.5,
            0.22131444234779174,
            2.9202782112420014,
        ));
        let l = Prim::Line(LineSeg::new(Vec2::new(0.0, 80.0), Vec2::new(120.0, 80.0)));
        let mut pts = intersect(&l, &arc, 1e-9, 64);
        pts.sort_by(|p, q| p.x.partial_cmp(&q.x).unwrap());
        assert_eq!(pts.len(), 2, "both arc feet are intersections: {pts:?}");
        assert!((pts[0].x - 40.0).abs() < 1e-6, "x0 = {}", pts[0].x);
        assert!((pts[1].x - 80.0).abs() < 1e-6, "x1 = {}", pts[1].x);
    }

    #[test]
    fn hit_test_respects_tolerance() {
        let l = Prim::Line(LineSeg::new(Vec2::new(0.0, 0.0), Vec2::new(10.0, 0.0)));
        let b = l.bounds();
        assert!(hit_test(&l, &b, Vec2::new(5.0, 0.4), 0.5).is_some());
        assert!(hit_test(&l, &b, Vec2::new(5.0, 0.9), 0.5).is_none());
    }

    #[test]
    fn polygon_containment() {
        let square = vec![
            Vec2::new(0.0, 0.0),
            Vec2::new(10.0, 0.0),
            Vec2::new(10.0, 10.0),
            Vec2::new(0.0, 10.0),
        ];
        assert!(point_in_polygon(&square, Vec2::new(5.0, 5.0)));
        assert!(!point_in_polygon(&square, Vec2::new(15.0, 5.0)));
        assert!((signed_area(&square) - 100.0).abs() < 1e-9);
    }

    #[test]
    fn vector_polyline_snap_helpers() {
        let pl = Polyline::new(
            vec![Vec2::new(0.0, 0.0), Vec2::new(10.0, 0.0), Vec2::new(10.0, 10.0)],
            false,
        );
        let (pt, seg, t) = polyline_closest(&pl, Vec2::new(5.0, 2.0));
        assert!((pt.x - 5.0).abs() < 1e-9 && pt.y.abs() < 1e-9);
        assert_eq!(seg, 0);
        assert!((t - 0.5).abs() < 1e-9);
    }
}
