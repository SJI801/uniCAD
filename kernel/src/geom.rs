//! Geometric primitives and their discretisation into polyline vertices.
//!
//! The front-end stores little more than type tags and numbers; every piece of
//! real geometry work (bounds, tessellation, hit-testing, snapping, boolean
//! predicates) happens here so the WebGL renderer only ever consumes a flat
//! `Float32Array` of vertices.

use crate::math::{angle_in_ccw_sweep, normalize_angle, Aabb, Vec2};

/// Adaptive tessellation: pick a segment count from a sagitta (chord height)
/// tolerance so a circle of radius `r` never deviates more than `tol` from the
/// true arc, while never exceeding `max_seg` segments.
#[inline]
pub fn arc_segment_count(sweep: f64, radius: f64, tol: f64, max_seg: u32) -> u32 {
    let sweep = sweep.abs();
    if sweep <= 1e-9 {
        return 2;
    }
    if radius <= 1e-9 || tol <= 1e-12 {
        return max_seg.max(2);
    }
    // For a chord subtending angle `t`, sagitta = r * (1 - cos(t/2)).
    // Solve for the largest t with sagitta <= tol, then n = ceil(sweep / t).
    let ratio = (1.0 - (tol / radius).min(1.0)).clamp(-1.0, 1.0);
    let half = ratio.acos();
    if half <= 1e-9 {
        return max_seg.max(2);
    }
    let step = half * 2.0;
    let n = (sweep / step).ceil();
    (n as u32).clamp(2, max_seg.max(2))
}

/// A straight segment.
#[derive(Clone, Copy, Debug)]
pub struct LineSeg {
    pub a: Vec2,
    pub b: Vec2,
}

impl LineSeg {
    #[inline]
    pub fn new(a: Vec2, b: Vec2) -> Self {
        Self { a, b }
    }

    #[inline]
    pub fn length(&self) -> f64 {
        (self.b - self.a).length()
    }

    #[inline]
    pub fn dir(&self) -> Vec2 {
        (self.b - self.a).normalized()
    }

    #[inline]
    pub fn point_at(&self, t: f64) -> Vec2 {
        self.a.lerp(self.b, t)
    }

    #[inline]
    pub fn midpoint(&self) -> Vec2 {
        self.a.lerp(self.b, 0.5)
    }

    #[inline]
    pub fn bounds(&self) -> Aabb {
        let mut b = Aabb::empty();
        b.extend(self.a);
        b.extend(self.b);
        b
    }

    /// Closest point on the (infinite) supporting line: returns `(point, t)`.
    #[inline]
    pub fn closest_on_line(&self, p: Vec2) -> (Vec2, f64) {
        let ab = self.b - self.a;
        let len_sq = ab.length_sq();
        if len_sq <= 1e-18 {
            return (self.a, 0.0);
        }
        let t = (p - self.a).dot(ab) / len_sq;
        (self.a + ab * t, t)
    }

    /// Closest point on the clamped segment.
    pub fn closest_point(&self, p: Vec2) -> Vec2 {
        let (pt, t) = self.closest_on_line(p);
        if t < 0.0 {
            self.a
        } else if t > 1.0 {
            self.b
        } else {
            pt
        }
    }

    pub fn distance_to(&self, p: Vec2) -> f64 {
        self.closest_point(p).distance_to(p)
    }

    /// Segment/segment intersection. Returns the parametric values on both
    /// segments when they properly cross (`0 <= t <= 1 && 0 <= u <= 1`).
    pub fn intersect(&self, o: &LineSeg) -> Option<(f64, f64, Vec2)> {
        let r = self.b - self.a;
        let s = o.b - o.a;
        let denom = r.cross(s);
        if denom.abs() < 1e-14 {
            return None; // parallel or collinear
        }
        let qp = o.a - self.a;
        let t = qp.cross(s) / denom;
        let u = qp.cross(r) / denom;
        if (-1e-9..=1.0 + 1e-9).contains(&t) && (-1e-9..=1.0 + 1e-9).contains(&u) {
            Some((t, u, self.a + r * t))
        } else {
            None
        }
    }
}

/// A circle.
#[derive(Clone, Copy, Debug)]
pub struct Circle {
    pub center: Vec2,
    pub radius: f64,
}

impl Circle {
    #[inline]
    pub fn new(center: Vec2, radius: f64) -> Self {
        Self { center, radius: radius.abs() }
    }

    #[inline]
    pub fn point_at(&self, angle: f64) -> Vec2 {
        self.center + Vec2::new(angle.cos(), angle.sin()) * self.radius
    }

    #[inline]
    pub fn bounds(&self) -> Aabb {
        Aabb::new(
            self.center.x - self.radius,
            self.center.y - self.radius,
            self.center.x + self.radius,
            self.center.y + self.radius,
        )
    }

    /// Radial distance from the circle curve: negative inside.
    #[inline]
    pub fn signed_distance(&self, p: Vec2) -> f64 {
        p.distance_to(self.center) - self.radius
    }

    #[inline]
    pub fn distance_to(&self, p: Vec2) -> f64 {
        self.signed_distance(p).abs()
    }

    /// Tangent angle at the point nearest to `p`.
    #[inline]
    pub fn tangent_at_point(&self, p: Vec2) -> f64 {
        let radial = (p - self.center).angle();
        radial + core::f64::consts::FRAC_PI_2
    }

    /// Circle/circle intersections (0, 1 or 2 points).
    pub fn intersect_circle(&self, o: &Circle, out: &mut Vec<Vec2>) {
        let d = self.center.distance_to(o.center);
        if d < 1e-12 {
            return; // concentric
        }
        if d > self.radius + o.radius + 1e-12 || d < (self.radius - o.radius).abs() - 1e-12 {
            return;
        }
        let a = (self.radius * self.radius - o.radius * o.radius + d * d) / (2.0 * d);
        let h_sq = self.radius * self.radius - a * a;
        let h = if h_sq > 0.0 { h_sq.sqrt() } else { 0.0 };
        let dir = (o.center - self.center) / d;
        let base = self.center + dir * a;
        let off = dir.perp() * h;
        out.push(base + off);
        if h > 1e-12 {
            out.push(base - off);
        }
    }

    /// Circle/segment intersections.
    pub fn intersect_segment(&self, s: &LineSeg, out: &mut Vec<Vec2>) {
        let d = s.b - s.a;
        let f = s.a - self.center;
        let a = d.dot(d);
        if a < 1e-18 {
            return;
        }
        let b = 2.0 * f.dot(d);
        let c = f.dot(f) - self.radius * self.radius;
        let disc = b * b - 4.0 * a * c;
        if disc < 0.0 {
            return;
        }
        let sq = disc.sqrt();
        for t in [(-b - sq) / (2.0 * a), (-b + sq) / (2.0 * a)] {
            if (-1e-9..=1.0 + 1e-9).contains(&t) {
                out.push(s.a + d * t);
            }
        }
    }
}

/// An arc: a circle restricted to a CCW sweep from `start_angle` to `end_angle`.
#[derive(Clone, Copy, Debug)]
pub struct Arc {
    pub center: Vec2,
    pub radius: f64,
    pub start_angle: f64,
    pub end_angle: f64,
}

impl Arc {
    #[inline]
    pub fn new(center: Vec2, radius: f64, start_angle: f64, end_angle: f64) -> Self {
        Self { center, radius: radius.abs(), start_angle, end_angle }
    }

    #[inline]
    pub fn sweep(&self) -> f64 {
        crate::math::ccw_sweep(self.start_angle, self.end_angle)
    }

    /// Build an arc from three points (start, a point on the arc, end).
    pub fn from_3_points(p1: Vec2, p2: Vec2, p3: Vec2) -> Option<Arc> {
        // Circumcentre via perpendicular bisectors.
        let d = 2.0 * (p1.x * (p2.y - p3.y) + p2.x * (p3.y - p1.y) + p3.x * (p1.y - p2.y));
        if d.abs() < 1e-12 {
            return None;
        }
        let p1s = p1.length_sq();
        let p2s = p2.length_sq();
        let p3s = p3.length_sq();
        let cx = (p1s * (p2.y - p3.y) + p2s * (p3.y - p1.y) + p3s * (p1.y - p2.y)) / d;
        let cy = (p1s * (p3.x - p2.x) + p2s * (p1.x - p3.x) + p3s * (p2.x - p1.x)) / d;
        let center = Vec2::new(cx, cy);
        let radius = center.distance_to(p1);
        let a1 = normalize_angle((p1 - center).angle());
        let a2 = normalize_angle((p2 - center).angle());
        let a3 = normalize_angle((p3 - center).angle());
        // Choose the orientation that actually passes through p2.
        if angle_in_ccw_sweep(a2, a1, a3) {
            Some(Arc::new(center, radius, a1, a3))
        } else {
            Some(Arc::new(center, radius, a3, a1))
        }
    }

    #[inline]
    pub fn start_point(&self) -> Vec2 {
        self.center + Vec2::new(self.start_angle.cos(), self.start_angle.sin()) * self.radius
    }

    #[inline]
    pub fn end_point(&self) -> Vec2 {
        self.center + Vec2::new(self.end_angle.cos(), self.end_angle.sin()) * self.radius
    }

    #[inline]
    pub fn midpoint(&self) -> Vec2 {
        let mid = self.start_angle + self.sweep() * 0.5;
        self.center + Vec2::new(mid.cos(), mid.sin()) * self.radius
    }

    #[inline]
    pub fn bounds(&self) -> Aabb {
        let mut b = Aabb::empty();
        b.extend(self.start_point());
        b.extend(self.end_point());
        // Include each axis extreme the sweep actually crosses.
        for (i, a) in [0.0, core::f64::consts::FRAC_PI_2, core::f64::consts::PI, 4.712388980384690]
            .into_iter()
            .enumerate()
        {
            let _ = i;
            if angle_in_ccw_sweep(a, self.start_angle, self.end_angle) {
                b.extend(self.center + Vec2::new(a.cos(), a.sin()) * self.radius);
            }
        }
        b
    }

    pub fn distance_to(&self, p: Vec2) -> f64 {
        let v = p - self.center;
        let rr = v.length();
        if rr < 1e-12 {
            return self.radius;
        }
        let ang = v.angle();
        if angle_in_ccw_sweep(ang, self.start_angle, self.end_angle) {
            (rr - self.radius).abs()
        } else {
            // Outside the sweep: nearest of the two endpoints.
            self.start_point().distance_to(p).min(self.end_point().distance_to(p))
        }
    }

    pub fn closest_point(&self, p: Vec2) -> Vec2 {
        let v = p - self.center;
        let rr = v.length();
        let ang = if rr < 1e-12 { self.start_angle } else { v.angle() };
        if angle_in_ccw_sweep(ang, self.start_angle, self.end_angle) {
            self.center + Vec2::new(ang.cos(), ang.sin()) * self.radius
        } else {
            let s = self.start_point();
            let e = self.end_point();
            if s.distance_to(p) <= e.distance_to(p) {
                s
            } else {
                e
            }
        }
    }
}

/// An axis-aligned ellipse. `rotation` is the CCW angle of the major axis.
#[derive(Clone, Copy, Debug)]
pub struct Ellipse {
    pub center: Vec2,
    pub rx: f64,
    pub ry: f64,
    pub rotation: f64,
}

impl Ellipse {
    #[inline]
    pub fn new(center: Vec2, rx: f64, ry: f64, rotation: f64) -> Self {
        Self { center, rx: rx.abs(), ry: ry.abs(), rotation }
    }

    #[inline]
    pub fn point_at(&self, param: f64) -> Vec2 {
        let p = Vec2::new(self.rx * param.cos(), self.ry * param.sin());
        self.center + p.rotated(self.rotation)
    }

    #[inline]
    pub fn bounds(&self) -> Aabb {
        // Extremes of a rotated ellipse, in closed form.
        let (s, c) = self.rotation.sin_cos();
        let hx = (self.rx * c).hypot(self.ry * s);
        let hy = (self.rx * s).hypot(self.ry * c);
        Aabb::new(self.center.x - hx, self.center.y - hy, self.center.x + hx, self.center.y + hy)
    }

    /// Distance from `p` to the ellipse curve, approximated by dense sampling
    /// plus a local refinement — accurate enough for picking and snapping.
    pub fn distance_to(&self, p: Vec2) -> f64 {
        self.closest_point(p).distance_to(p)
    }

    pub fn closest_point(&self, p: Vec2) -> Vec2 {
        const N: u32 = 96;
        let local = (p - self.center).rotated(-self.rotation);
        let mut best = f64::INFINITY;
        let mut best_t = 0.0;
        for i in 0..N {
            let t = i as f64 / N as f64 * core::f64::consts::TAU;
            // Cheap Newton-free approximation: sample on a warped parameter so
            // points spread more evenly in space.
            let pt = Vec2::new(self.rx * t.cos(), self.ry * t.sin());
            let d = pt.distance_to(local);
            if d < best {
                best = d;
                best_t = t;
            }
        }
        let step = core::f64::consts::TAU / N as f64;
        let mut lo = best_t - step;
        let mut hi = best_t + step;
        // Golden-section-ish refinement.
        for _ in 0..40 {
            let m1 = lo + (hi - lo) * 0.382;
            let m2 = lo + (hi - lo) * 0.618;
            let p1 = Vec2::new(self.rx * m1.cos(), self.ry * m1.sin());
            let p2 = Vec2::new(self.rx * m2.cos(), self.ry * m2.sin());
            if p1.distance_to(local) < p2.distance_to(local) {
                hi = m2;
            } else {
                lo = m1;
            }
        }
        let t = (lo + hi) * 0.5;
        let pt = Vec2::new(self.rx * t.cos(), self.ry * t.sin());
        self.center + pt.rotated(self.rotation)
    }
}

/// A polyline: an ordered list of vertices with an optional closing segment.
#[derive(Clone, Debug)]
pub struct Polyline {
    pub points: Vec<Vec2>,
    pub closed: bool,
}

impl Polyline {
    pub fn new(points: Vec<Vec2>, closed: bool) -> Self {
        Self { points, closed }
    }

    #[inline]
    pub fn segment_count(&self) -> usize {
        if self.points.len() < 2 {
            0
        } else if self.closed {
            self.points.len()
        } else {
            self.points.len() - 1
        }
    }

    pub fn segment(&self, i: usize) -> Option<LineSeg> {
        let n = self.points.len();
        if n < 2 || i >= self.segment_count() {
            return None;
        }
        let a = self.points[i];
        let b = self.points[(i + 1) % n];
        Some(LineSeg::new(a, b))
    }

    pub fn bounds(&self) -> Aabb {
        let mut b = Aabb::empty();
        for p in &self.points {
            b.extend(*p);
        }
        b
    }

    pub fn total_length(&self) -> f64 {
        let mut sum = 0.0;
        for i in 0..self.segment_count() {
            if let Some(s) = self.segment(i) {
                sum += s.length();
            }
        }
        sum
    }

    pub fn distance_to(&self, p: Vec2) -> f64 {
        let mut best = f64::INFINITY;
        for i in 0..self.segment_count() {
            if let Some(s) = self.segment(i) {
                best = best.min(s.distance_to(p));
            }
        }
        best
    }

    pub fn area(&self) -> f64 {
        if self.points.len() < 3 {
            return 0.0;
        }
        let mut a = 0.0;
        let n = self.points.len();
        for i in 0..n {
            let p = self.points[i];
            let q = self.points[(i + 1) % n];
            a += p.cross(q);
        }
        (a * 0.5).abs()
    }

    /// Append tessellation output. `tol` is the maximum chord deviation.
    pub fn tessellate(&self, tol: f64, out: &mut Vec<f32>) {
        if self.points.len() < 2 {
            return;
        }
        for p in &self.points {
            out.push(p.x as f32);
            out.push(p.y as f32);
        }
        if self.closed {
            out.push(self.points[0].x as f32);
            out.push(self.points[0].y as f32);
        }
        let _ = tol;
    }
}

/// A generic primitive wrapper — mirrors the discriminated union kept on the
/// TypeScript side.
#[derive(Clone, Debug)]
pub enum Prim {
    Line(LineSeg),
    Circle(Circle),
    Arc(Arc),
    Ellipse(Ellipse),
    Polyline(Polyline),
}

impl Prim {
    pub fn bounds(&self) -> Aabb {
        match self {
            Prim::Line(l) => l.bounds(),
            Prim::Circle(c) => c.bounds(),
            Prim::Arc(a) => a.bounds(),
            Prim::Ellipse(e) => e.bounds(),
            Prim::Polyline(p) => p.bounds(),
        }
    }

    pub fn distance_to(&self, p: Vec2) -> f64 {
        match self {
            Prim::Line(l) => l.distance_to(p),
            Prim::Circle(c) => c.distance_to(p),
            Prim::Arc(a) => a.distance_to(p),
            Prim::Ellipse(e) => e.distance_to(p),
            Prim::Polyline(pl) => pl.distance_to(p),
        }
    }

    /// Append the flattened polyline representation of this primitive.
    pub fn tessellate(&self, tol: f64, max_seg: u32, out: &mut Vec<f32>) {
        match self {
            Prim::Line(l) => {
                out.push(l.a.x as f32);
                out.push(l.a.y as f32);
                out.push(l.b.x as f32);
                out.push(l.b.y as f32);
            }
            Prim::Circle(c) => {
                let n = arc_segment_count(core::f64::consts::TAU, c.radius, tol, max_seg);
                for i in 0..=n {
                    let a = i as f64 / n as f64 * core::f64::consts::TAU;
                    let p = c.point_at(a);
                    out.push(p.x as f32);
                    out.push(p.y as f32);
                }
            }
            Prim::Arc(a) => {
                let sweep = a.sweep();
                let n = arc_segment_count(sweep, a.radius, tol, max_seg);
                for i in 0..=n {
                    let ang = a.start_angle + sweep * (i as f64 / n as f64);
                    let p = a.center + Vec2::new(ang.cos(), ang.sin()) * a.radius;
                    out.push(p.x as f32);
                    out.push(p.y as f32);
                }
            }
            Prim::Ellipse(e) => {
                let rmax = e.rx.max(e.ry);
                let n = arc_segment_count(core::f64::consts::TAU, rmax, tol, max_seg);
                for i in 0..=n {
                    let t = i as f64 / n as f64 * core::f64::consts::TAU;
                    let p = e.point_at(t);
                    out.push(p.x as f32);
                    out.push(p.y as f32);
                }
            }
            Prim::Polyline(p) => p.tessellate(tol, out),
        }
    }

    /// Flatten into `Vec<LineSeg>` — the common currency for intersections,
    /// snapping and area computation.
    pub fn to_segments(&self, tol: f64, max_seg: u32) -> Vec<LineSeg> {
        match self {
            Prim::Line(l) => vec![*l],
            Prim::Polyline(p) => {
                let mut v = Vec::with_capacity(p.segment_count());
                for i in 0..p.segment_count() {
                    if let Some(s) = p.segment(i) {
                        v.push(s);
                    }
                }
                v
            }
            other => {
                let mut flat = Vec::new();
                other.tessellate(tol, max_seg, &mut flat);
                let mut segs = Vec::with_capacity(flat.len() / 2);
                for i in (0..flat.len().saturating_sub(2)).step_by(2) {
                    segs.push(LineSeg::new(
                        Vec2::new(flat[i] as f64, flat[i + 1] as f64),
                        Vec2::new(flat[i + 2] as f64, flat[i + 3] as f64),
                    ));
                }
                segs
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segment_distance_and_closest() {
        let s = LineSeg::new(Vec2::new(0.0, 0.0), Vec2::new(10.0, 0.0));
        assert!((s.distance_to(Vec2::new(5.0, 3.0)) - 3.0).abs() < 1e-12);
        assert_eq!(s.closest_point(Vec2::new(-5.0, 1.0)), Vec2::new(0.0, 0.0));
        assert_eq!(s.closest_point(Vec2::new(15.0, 1.0)), Vec2::new(10.0, 0.0));
    }

    #[test]
    fn segment_intersection() {
        let a = LineSeg::new(Vec2::new(-1.0, 0.0), Vec2::new(1.0, 0.0));
        let b = LineSeg::new(Vec2::new(0.0, -1.0), Vec2::new(0.0, 1.0));
        let (t, u, p) = a.intersect(&b).unwrap();
        assert!((t - 0.5).abs() < 1e-12 && (u - 0.5).abs() < 1e-12);
        assert!(p.x.abs() < 1e-12 && p.y.abs() < 1e-12);
    }

    #[test]
    fn circle_circle_intersection() {
        let a = Circle::new(Vec2::new(0.0, 0.0), 5.0);
        let b = Circle::new(Vec2::new(8.0, 0.0), 5.0);
        let mut out = Vec::new();
        a.intersect_circle(&b, &mut out);
        assert_eq!(out.len(), 2);
        for p in out {
            assert!((p.x - 4.0).abs() < 1e-9);
        }
    }

    #[test]
    fn arc_from_three_points_orients_correctly() {
        let a = Arc::from_3_points(
            Vec2::new(1.0, 0.0),
            Vec2::new(0.0, 1.0),
            Vec2::new(-1.0, 0.0),
        )
        .unwrap();
        assert!((a.radius - 1.0).abs() < 1e-9);
        // Should sweep CCW through the top: start at 0 rad, end at π rad.
        assert!((a.sweep() - core::f64::consts::PI).abs() < 1e-9);
        let mid = a.midpoint();
        assert!((mid.x).abs() < 1e-9 && (mid.y - 1.0).abs() < 1e-9);
    }

    #[test]
    fn arc_bounds_include_axis_extremes() {
        // Quarter arc from 0° to 90° of a unit circle at the origin.
        let a = Arc::new(Vec2::new(0.0, 0.0), 1.0, 0.0, core::f64::consts::FRAC_PI_2);
        let b = a.bounds();
        assert!((b.min_x - 0.0).abs() < 1e-9);
        assert!((b.min_y - 0.0).abs() < 1e-9);
        assert!((b.max_x - 1.0).abs() < 1e-9);
        assert!((b.max_y - 1.0).abs() < 1e-9);
    }

    #[test]
    fn ellipse_bounds_with_rotation() {
        let e = Ellipse::new(Vec2::new(0.0, 0.0), 10.0, 4.0, core::f64::consts::FRAC_PI_2);
        let b = e.bounds();
        // Rotated 90°, the 10-unit axis now runs along Y.
        assert!((b.max_y - 10.0).abs() < 1e-9);
        assert!((b.max_x - 4.0).abs() < 1e-9);
    }

    #[test]
    fn tessellation_adapts_to_radius() {
        let small = arc_segment_count(core::f64::consts::TAU, 1.0, 0.02, 512);
        let big = arc_segment_count(core::f64::consts::TAU, 1000.0, 0.02, 512);
        assert!(big > small);
        assert!(big <= 512);
    }

    #[test]
    fn polyline_area_of_square() {
        let pl = Polyline::new(
            vec![
                Vec2::new(0.0, 0.0),
                Vec2::new(10.0, 0.0),
                Vec2::new(10.0, 10.0),
                Vec2::new(0.0, 10.0),
            ],
            true,
        );
        assert!((pl.area() - 100.0).abs() < 1e-9);
        assert!((pl.total_length() - 40.0).abs() < 1e-9);
    }
}
