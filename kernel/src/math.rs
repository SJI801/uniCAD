//! Core 2D math: vectors and 2x3 affine transforms.

use core::ops::{Add, Div, Mul, Neg, Sub};

/// A 2D point / vector in *model space* (world coordinates, doubles).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

impl Vec2 {
    #[inline]
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    #[inline]
    pub const fn zero() -> Self {
        Self { x: 0.0, y: 0.0 }
    }

    #[inline]
    pub fn length(self) -> f64 {
        self.length_sq().sqrt()
    }

    #[inline]
    pub fn length_sq(self) -> f64 {
        self.x * self.x + self.y * self.y
    }

    #[inline]
    pub fn dot(self, o: Vec2) -> f64 {
        self.x * o.x + self.y * o.y
    }

    /// 2D scalar cross product (z component of the 3D cross).
    #[inline]
    pub fn cross(self, o: Vec2) -> f64 {
        self.x * o.y - self.y * o.x
    }

    #[inline]
    pub fn normalized(self) -> Vec2 {
        let l = self.length();
        if l <= f64::EPSILON {
            Vec2::zero()
        } else {
            Vec2::new(self.x / l, self.y / l)
        }
    }

    /// Left-hand perpendicular: rotate 90° counter-clockwise.
    #[inline]
    pub fn perp(self) -> Vec2 {
        Vec2::new(-self.y, self.x)
    }

    /// Rotate around the origin by `angle` radians.
    #[inline]
    pub fn rotated(self, angle: f64) -> Vec2 {
        let (s, c) = angle.sin_cos();
        Vec2::new(self.x * c - self.y * s, self.x * s + self.y * c)
    }

    #[inline]
    pub fn angle(self) -> f64 {
        self.y.atan2(self.x)
    }

    #[inline]
    pub fn distance_to(self, o: Vec2) -> f64 {
        (self - o).length()
    }

    #[inline]
    pub fn lerp(self, o: Vec2, t: f64) -> Vec2 {
        Vec2::new(self.x + (o.x - self.x) * t, self.y + (o.y - self.y) * t)
    }
}

impl Add for Vec2 {
    type Output = Vec2;
    #[inline]
    fn add(self, o: Vec2) -> Vec2 {
        Vec2::new(self.x + o.x, self.y + o.y)
    }
}

impl Sub for Vec2 {
    type Output = Vec2;
    #[inline]
    fn sub(self, o: Vec2) -> Vec2 {
        Vec2::new(self.x - o.x, self.y - o.y)
    }
}

impl Neg for Vec2 {
    type Output = Vec2;
    #[inline]
    fn neg(self) -> Vec2 {
        Vec2::new(-self.x, -self.y)
    }
}

impl Mul<f64> for Vec2 {
    type Output = Vec2;
    #[inline]
    fn mul(self, s: f64) -> Vec2 {
        Vec2::new(self.x * s, self.y * s)
    }
}

impl Div<f64> for Vec2 {
    type Output = Vec2;
    #[inline]
    fn div(self, s: f64) -> Vec2 {
        Vec2::new(self.x / s, self.y / s)
    }
}

/// Axis-aligned bounding box in model space.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Aabb {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl Aabb {
    #[inline]
    pub const fn new(min_x: f64, min_y: f64, max_x: f64, max_y: f64) -> Self {
        Self { min_x, min_y, max_x, max_y }
    }

    /// An "empty" box that absorbs any point through [`Aabb::extend`].
    #[inline]
    pub const fn empty() -> Self {
        Self {
            min_x: f64::INFINITY,
            min_y: f64::INFINITY,
            max_x: f64::NEG_INFINITY,
            max_y: f64::NEG_INFINITY,
        }
    }

    #[inline]
    pub fn extend(&mut self, p: Vec2) {
        if p.x < self.min_x {
            self.min_x = p.x;
        }
        if p.y < self.min_y {
            self.min_y = p.y;
        }
        if p.x > self.max_x {
            self.max_x = p.x;
        }
        if p.y > self.max_y {
            self.max_y = p.y;
        }
    }

    #[inline]
    pub fn merge(&mut self, o: Aabb) {
        if o.min_x < self.min_x {
            self.min_x = o.min_x;
        }
        if o.min_y < self.min_y {
            self.min_y = o.min_y;
        }
        if o.max_x > self.max_x {
            self.max_x = o.max_x;
        }
        if o.max_y > self.max_y {
            self.max_y = o.max_y;
        }
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.min_x > self.max_x || self.min_y > self.max_y
    }

    #[inline]
    pub fn contains(&self, p: Vec2) -> bool {
        p.x >= self.min_x && p.x <= self.max_x && p.y >= self.min_y && p.y <= self.max_y
    }

    /// Grow the box by `d` on every side (negative shrinks).
    #[inline]
    pub fn expanded(&self, d: f64) -> Aabb {
        Aabb::new(self.min_x - d, self.min_y - d, self.max_x + d, self.max_y + d)
    }

    #[inline]
    pub fn intersects(&self, o: &Aabb) -> bool {
        self.min_x <= o.max_x && self.max_x >= o.min_x && self.min_y <= o.max_y && self.max_y >= o.min_y
    }

    #[inline]
    pub fn center(&self) -> Vec2 {
        Vec2::new((self.min_x + self.max_x) * 0.5, (self.min_y + self.max_y) * 0.5)
    }
}

/// 2x3 affine transform stored row-major as `[a, b, c, d, e, f]`:
///
/// ```text
/// | a  c  e |
/// | b  d  f |
/// | 0  0  1 |
/// ```
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mat3 {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub e: f64,
    pub f: f64,
}

impl Default for Mat3 {
    fn default() -> Self {
        Self::identity()
    }
}

impl Mat3 {
    #[inline]
    pub const fn new(a: f64, b: f64, c: f64, d: f64, e: f64, f: f64) -> Self {
        Self { a, b, c, d, e, f }
    }

    #[inline]
    pub const fn identity() -> Self {
        Self::new(1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    }

    #[inline]
    pub const fn translation(t: Vec2) -> Self {
        Self::new(1.0, 0.0, 0.0, 1.0, t.x, t.y)
    }

    #[inline]
    pub fn scaling(s: Vec2) -> Self {
        Self::new(s.x, 0.0, 0.0, s.y, 0.0, 0.0)
    }

    #[inline]
    pub fn rotation(angle: f64) -> Self {
        let (s, c) = angle.sin_cos();
        Self::new(c, s, -s, c, 0.0, 0.0)
    }

    /// Rotation about an arbitrary pivot.
    #[inline]
    pub fn rotation_about(angle: f64, pivot: Vec2) -> Self {
        Mat3::translation(pivot)
            .mul(&Mat3::rotation(angle))
            .mul(&Mat3::translation(-pivot))
    }

    /// `self * other` — apply `other` first, then `self`.
    #[inline]
    pub fn mul(&self, o: &Mat3) -> Mat3 {
        Mat3::new(
            self.a * o.a + self.c * o.b,
            self.b * o.a + self.d * o.b,
            self.a * o.c + self.c * o.d,
            self.b * o.c + self.d * o.d,
            self.a * o.e + self.c * o.f + self.e,
            self.b * o.e + self.d * o.f + self.f,
        )
    }

    #[inline]
    pub fn apply(&self, p: Vec2) -> Vec2 {
        Vec2::new(self.a * p.x + self.c * p.y + self.e, self.b * p.x + self.d * p.y + self.f)
    }

    /// Transform a direction vector (ignores translation).
    #[inline]
    pub fn apply_vector(&self, v: Vec2) -> Vec2 {
        Vec2::new(self.a * v.x + self.c * v.y, self.b * v.x + self.d * v.y)
    }

    #[inline]
    pub fn determinant(&self) -> f64 {
        self.a * self.d - self.b * self.c
    }

    pub fn inverse(&self) -> Option<Mat3> {
        let det = self.determinant();
        if det.abs() < 1e-12 {
            return None;
        }
        let inv = 1.0 / det;
        Some(Mat3::new(
            self.d * inv,
            -self.b * inv,
            -self.c * inv,
            self.a * inv,
            (self.c * self.f - self.d * self.e) * inv,
            (self.b * self.e - self.a * self.f) * inv,
        ))
    }

    /// Uniform scale factor implied by this transform (average of |column| lengths).
    pub fn approx_scale(&self) -> f64 {
        let cx = (self.a * self.a + self.b * self.b).sqrt();
        let cy = (self.c * self.c + self.d * self.d).sqrt();
        (cx + cy) * 0.5
    }
}

/// Normalise an angle into `[0, 2π)`.
#[inline]
pub fn normalize_angle(a: f64) -> f64 {
    let two_pi = core::f64::consts::TAU;
    let mut r = a % two_pi;
    if r < 0.0 {
        r += two_pi;
    }
    r
}

/// Sweep from `start` to `end` travelling counter-clockwise, in `[0, 2π]`.
#[inline]
pub fn ccw_sweep(start: f64, end: f64) -> f64 {
    normalize_angle(end - start)
}

/// Whether `angle` lies on the CCW arc from `start` to `end`.
///
/// The `ANG_EPS` slack on **both** boundaries matters more than it looks. When a
/// line meets an arc exactly at one of the arc's endpoints — the ordinary "trim
/// a line back to the arc's foot" case — the intersection point and the arc's
/// own `start_angle` name the same direction to within a rounding error. If the
/// recomputed point lands a hair *below* `start`, `normalize_angle` wraps the
/// difference to just under `2π`, and a naive `rel <= sweep` rejects it: the cut
/// point silently vanishes and the trim misses a whole segment. The end side is
/// already covered by `+ ANG_EPS`; the start side needs the wrap-aware test.
#[inline]
pub fn angle_in_ccw_sweep(angle: f64, start: f64, end: f64) -> bool {
    const ANG_EPS: f64 = 1e-9;
    let two_pi = core::f64::consts::TAU;
    let sweep = ccw_sweep(start, end);
    let rel = normalize_angle(angle - start);
    // A full circle is encoded by a sweep of ~0 that actually means 2π.
    if sweep <= 1e-12 {
        return true;
    }
    rel <= sweep + ANG_EPS || rel >= two_pi - ANG_EPS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vec_basics() {
        let a = Vec2::new(3.0, 4.0);
        assert!((a.length() - 5.0).abs() < 1e-12);
        assert!((a.normalized().length() - 1.0).abs() < 1e-12);
        assert_eq!(a.perp(), Vec2::new(-4.0, 3.0));
        assert!((Vec2::new(1.0, 0.0).cross(Vec2::new(0.0, 1.0)) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn rotation_about_pivot_keeps_pivot() {
        let p = Vec2::new(5.0, -2.0);
        let m = Mat3::rotation_about(core::f64::consts::FRAC_PI_2, p);
        let out = m.apply(p);
        assert!((out.x - p.x).abs() < 1e-9 && (out.y - p.y).abs() < 1e-9);
    }

    #[test]
    fn inverse_roundtrip() {
        let m = Mat3::translation(Vec2::new(3.0, 7.0))
            .mul(&Mat3::rotation(0.7))
            .mul(&Mat3::scaling(Vec2::new(2.0, 3.0)));
        let inv = m.inverse().unwrap();
        let p = Vec2::new(1.25, -8.5);
        let back = inv.apply(m.apply(p));
        assert!((back.x - p.x).abs() < 1e-9 && (back.y - p.y).abs() < 1e-9);
    }

    #[test]
    fn aabb_ops() {
        let mut b = Aabb::empty();
        b.extend(Vec2::new(1.0, 2.0));
        b.extend(Vec2::new(-3.0, 5.0));
        assert_eq!(b.min_x, -3.0);
        assert_eq!(b.max_y, 5.0);
        assert!(b.contains(Vec2::new(0.0, 3.0)));
        assert!(!b.contains(Vec2::new(9.0, 3.0)));
        assert!(b.intersects(&Aabb::new(0.0, 0.0, 10.0, 10.0)));
    }

    #[test]
    fn sweep_helpers() {
        assert!((ccw_sweep(0.0, core::f64::consts::FRAC_PI_2) - core::f64::consts::FRAC_PI_2).abs() < 1e-12);
        assert!((ccw_sweep(core::f64::consts::FRAC_PI_2, 0.0) - 4.712388980384690).abs() < 1e-9);
        assert!(angle_in_ccw_sweep(0.5, 0.0, core::f64::consts::FRAC_PI_2));
        assert!(!angle_in_ccw_sweep(5.0, 0.0, core::f64::consts::FRAC_PI_2));
    }
}
