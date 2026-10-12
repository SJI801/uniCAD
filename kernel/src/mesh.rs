//! Extrusion: pull a closed 2D sketch into a flat-shaded triangle soup.
//!
//! Phase 1 stops deliberately at *one closed loop, extruded along +Z*. There are
//! no booleans, no non-planar profiles and no holes — each of those is its own
//! project. What it *does* give is a correct solid: outward-facing walls, both
//! caps triangulated by ear clipping (so a concave outline works, not only a
//! rectangle), and one flat normal per triangle, which is what makes a CAD solid
//! read as faceted rather than smeared.
//!
//! The output is **non-indexed**: three vertices per triangle, six floats each
//! (`x, y, z, nx, ny, nz`). Flat shading wants a distinct normal per face, so
//! sharing vertices would buy nothing but a normal-averaging bug.

use crate::geom::{arc_segment_count, Prim};
use crate::math::Vec2;

/// An orthonormal frame: a datum plane's origin plus its two in-plane axes.
///
/// The normal is *derived* (`u × v`) rather than accepted from the caller, so a
/// frame can never arrive with a normal that disagrees with its own axes.
#[derive(Clone, Copy)]
pub struct Frame {
    pub origin: [f64; 3],
    pub u: [f64; 3],
    pub v: [f64; 3],
    pub n: [f64; 3],
}

impl Frame {
    /// The plane XY at the origin — what every pre-datum caller wants, and the
    /// fallback when the front end sends no frame at all.
    pub const fn xy() -> Self {
        Frame {
            origin: [0.0, 0.0, 0.0],
            u: [1.0, 0.0, 0.0],
            v: [0.0, 1.0, 0.0],
            n: [0.0, 0.0, 1.0],
        }
    }

    /// Build from `origin, u, v` — nine floats, the layout the FFI ships.
    /// `None` when the input is short or the axes are parallel (no plane).
    pub fn from_slice(s: &[f64]) -> Option<Self> {
        if s.len() < 9 {
            return None;
        }
        let u = norm3([s[3], s[4], s[5]])?;
        let v = norm3([s[6], s[7], s[8]])?;
        let n = norm3(cross3(u, v))?;
        Some(Frame { origin: [s[0], s[1], s[2]], u, v, n })
    }

    /// Place a local point in world space.
    #[inline]
    fn point(&self, p: [f64; 3]) -> [f64; 3] {
        [
            self.origin[0] + self.u[0] * p[0] + self.v[0] * p[1] + self.n[0] * p[2],
            self.origin[1] + self.u[1] * p[0] + self.v[1] * p[1] + self.n[1] * p[2],
            self.origin[2] + self.u[2] * p[0] + self.v[2] * p[1] + self.n[2] * p[2],
        ]
    }

    /// Rotate a local direction into world space (no translation).
    #[inline]
    fn dir(&self, d: [f64; 3]) -> [f64; 3] {
        [
            self.u[0] * d[0] + self.v[0] * d[1] + self.n[0] * d[2],
            self.u[1] * d[0] + self.v[1] * d[1] + self.n[1] * d[2],
            self.u[2] * d[0] + self.v[2] * d[1] + self.n[2] * d[2],
        ]
    }
}

fn norm3(a: [f64; 3]) -> Option<[f64; 3]> {
    let l = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt();
    if !(l > 1e-12) {
        return None;
    }
    Some([a[0] / l, a[1] / l, a[2] / l])
}

fn cross3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// A flat-shaded triangle soup — `6` floats per vertex, three per triangle.
///
/// Triangle corners go in **local** to the frame and are mapped to world space on
/// the way out, so the extrusion below never has to know whether it is building
/// on XY or on some tilted datum plane.
pub struct Mesh {
    pub verts: Vec<f32>,
    frame: Frame,
}

impl Mesh {
    pub fn new(frame: Frame) -> Self {
        Mesh { verts: Vec::new(), frame }
    }

    /// Append one triangle: a local position per corner, one local flat normal.
    fn tri(&mut self, a: [f64; 3], b: [f64; 3], c: [f64; 3], n: [f64; 3]) {
        let wn = self.frame.dir(n);
        for p in [a, b, c] {
            let wp = self.frame.point(p);
            self.verts.push(wp[0] as f32);
            self.verts.push(wp[1] as f32);
            self.verts.push(wp[2] as f32);
            self.verts.push(wn[0] as f32);
            self.verts.push(wn[1] as f32);
            self.verts.push(wn[2] as f32);
        }
    }

    pub fn vertex_count(&self) -> usize {
        self.verts.len() / 6
    }
}

/// The closed boundary of `prim` as a polygon loop, or `None` when it has no
/// interior to pull (a lone line or arc is half a curve, not a region).
///
/// A `closed` polyline's last edge is implicit in the vertex list; an *open*
/// polyline with three or more points is also accepted and closed implicitly —
/// the user drew a boundary and simply did not tick "close".
pub fn closed_loop(prim: &Prim, tol: f64, max_seg: u32) -> Option<Vec<Vec2>> {
    match prim {
        Prim::Polyline(pl) => {
            if pl.points.len() < 3 {
                return None;
            }
            Some(pl.points.clone())
        }
        Prim::Circle(c) => {
            if c.radius <= 1e-12 {
                return None;
            }
            let full = core::f64::consts::TAU;
            let n = arc_segment_count(full, c.radius, tol, max_seg).max(3);
            Some((0..n as usize).map(|i| c.point_at(full * (i as f64) / (n as f64))).collect())
        }
        Prim::Ellipse(e) => {
            let r = e.rx.max(e.ry);
            if r <= 1e-12 {
                return None;
            }
            let full = core::f64::consts::TAU;
            let n = arc_segment_count(full, r, tol, max_seg).max(3);
            Some((0..n as usize).map(|i| e.point_at((i as f64) / (n as f64))).collect())
        }
        Prim::Line(_) | Prim::Arc(_) => None,
    }
}

/// Shoelace signed area: `> 0` counter-clockwise, `< 0` clockwise.
fn signed_area(loop_pts: &[Vec2]) -> f64 {
    let n = loop_pts.len();
    let mut a = 0.0;
    for i in 0..n {
        let p = loop_pts[i];
        let q = loop_pts[(i + 1) % n];
        a += p.x * q.y - q.x * p.y;
    }
    a * 0.5
}

/// Strictly inside `(a, b, c)` — a point on an edge does not count, so a
/// collinear vertex can never veto a legitimate ear.
fn point_in_tri(p: Vec2, a: Vec2, b: Vec2, c: Vec2) -> bool {
    let d1 = (b - a).cross(p - a);
    let d2 = (c - b).cross(p - b);
    let d3 = (a - c).cross(p - c);
    d1 > 1e-12 && d2 > 1e-12 && d3 > 1e-12
}

/// Ear-clip a simple polygon (assumed counter-clockwise) into triangles.
///
/// Ear clipping rather than a triangle fan: a fan is only correct for a convex
/// outline, and the moment someone extrudes an L or a star it would produce
/// triangles that spill outside the profile. The ear test is `O(n²)` overall,
/// which is nothing next to the tessellation that produced the loop.
fn triangulate(poly: &[Vec2]) -> Vec<[usize; 3]> {
    let n = poly.len();
    let mut out: Vec<[usize; 3]> = Vec::new();
    if n < 3 {
        return out;
    }
    let mut idx: Vec<usize> = (0..n).collect();
    // Each pass removes exactly one vertex, so `n` passes is already generous —
    // the larger cap only exists so a self-intersecting outline cannot spin.
    let mut guard = 0usize;
    let cap = n * n + 8;
    while idx.len() > 3 && guard < cap {
        guard += 1;
        let m = idx.len();
        let mut clipped = false;
        for i in 0..m {
            let ia = idx[(i + m - 1) % m];
            let ib = idx[i];
            let ic = idx[(i + 1) % m];
            let (a, b, c) = (poly[ia], poly[ib], poly[ic]);
            // Convex corner? (CCW polygon ⇒ a positive turn.)
            if (b - a).cross(c - a) <= 1e-12 {
                continue;
            }
            let mut clean = true;
            for &j in &idx {
                if j == ia || j == ib || j == ic {
                    continue;
                }
                if point_in_tri(poly[j], a, b, c) {
                    clean = false;
                    break;
                }
            }
            if !clean {
                continue;
            }
            out.push([ia, ib, ic]);
            idx.remove(i);
            clipped = true;
            break;
        }
        if !clipped {
            // Degenerate or self-intersecting input: fan what is left rather
            // than loop forever.
            break;
        }
    }
    for i in 1..idx.len().saturating_sub(1) {
        out.push([idx[0], idx[i], idx[i + 1]]);
    }
    out
}

/// Extrude a closed loop along `frame`'s normal by `height`.
///
/// The loop is normalised to counter-clockwise first, so the walls' outward
/// normals are one rule instead of a special case per winding. Build in the
/// frame's local space; `Mesh` maps the result into world space.
pub fn extrude(loop_pts: &[Vec2], height: f64, frame: &Frame) -> Mesh {
    let mut mesh = Mesh::new(*frame);
    if loop_pts.len() < 3 || height.abs() <= 1e-12 {
        return mesh;
    }
    let mut poly: Vec<Vec2> = loop_pts.to_vec();
    if signed_area(&poly) < 0.0 {
        poly.reverse();
    }
    let h = height;
    let n = poly.len();

    // ---- caps ------------------------------------------------------------
    for t in triangulate(&poly) {
        let (a, b, c) = (poly[t[0]], poly[t[1]], poly[t[2]]);
        // Top cap: the polygon's own CCW winding faces +Z.
        mesh.tri([a.x, a.y, h], [b.x, b.y, h], [c.x, c.y, h], [0.0, 0.0, 1.0]);
        // Bottom cap: reversed, so its normal faces −Z (out of the solid).
        mesh.tri([a.x, a.y, 0.0], [c.x, c.y, 0.0], [b.x, b.y, 0.0], [0.0, 0.0, -1.0]);
    }

    // ---- walls -----------------------------------------------------------
    for i in 0..n {
        let a = poly[i];
        let b = poly[(i + 1) % n];
        let e = b - a;
        let len = e.length();
        if len <= 1e-12 {
            continue;
        }
        // In a CCW loop the interior lies to the *left* of a→b, so the outward
        // normal points right: rotate the edge direction by −90°.
        let nx = e.y / len;
        let ny = -e.x / len;
        mesh.tri([a.x, a.y, 0.0], [b.x, b.y, 0.0], [b.x, b.y, h], [nx, ny, 0.0]);
        mesh.tri([a.x, a.y, 0.0], [b.x, b.y, h], [a.x, a.y, h], [nx, ny, 0.0]);
    }
    mesh
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::{Circle, Polyline};

    fn square() -> Vec<Vec2> {
        vec![
            Vec2::new(0.0, 0.0),
            Vec2::new(10.0, 0.0),
            Vec2::new(10.0, 10.0),
            Vec2::new(0.0, 10.0),
        ]
    }

    /// Extrude on the XY plane.
    ///
    /// Deliberately shadows the 3-arg `super::extrude` so the geometry tests
    /// below read as "extrude this shape" — the XY frame is the identity, so
    /// world coordinates are local ones and the assertions stay ordinary 2D.
    fn extrude(pts: &[Vec2], height: f64) -> Mesh {
        super::extrude(pts, height, &Frame::xy())
    }

    /// One triangle per cap + two per wall edge.
    #[test]
    fn extrudes_a_square_into_a_box() {
        let m = extrude(&square(), 5.0);
        // 2 caps × 2 tris + 4 walls × 2 tris = 12 tris = 36 verts.
        assert_eq!(m.vertex_count(), 36, "box triangle count");

        // Every wall normal must point *away* from the square's centre, i.e.
        // outward. A face normal that points inward means the winding flipped.
        let mut outward = 0;
        let mut i = 0;
        while i < m.verts.len() {
            let (x, y, z, nx, ny, nz) = (
                m.verts[i] as f64,
                m.verts[i + 1] as f64,
                m.verts[i + 2] as f64,
                m.verts[i + 3] as f64,
                m.verts[i + 4] as f64,
                m.verts[i + 5] as f64,
            );
            // Horizontal normal ⇒ a wall; it must agree with the direction from
            // the axis to the face, i.e. away from the middle of the box.
            if nx.abs() > 0.5 || ny.abs() > 0.5 {
                assert_eq!(nz, 0.0, "a wall normal is horizontal");
                let (cx, cy) = (5.0, 5.0);
                if (x - cx) * nx + (y - cy) * ny > 0.0 {
                    outward += 1;
                }
            } else {
                // The only non-wall faces are the caps, and their normal is ±Z.
                assert!((nz.abs() - 1.0).abs() < 1e-9, "cap normal is ±Z");
            }
            assert!(z >= -1e-9 && z <= 5.0 + 1e-9, "vertex z in range");
            i += 6;
        }
        assert_eq!(outward, 24, "every wall vertex has an outward normal");
    }

    /// Both caps and the walls survive; the caps are 2 tris each and the sides 6.
    #[test]
    fn extrudes_a_triangle_into_a_prism() {
        let tri = vec![
            Vec2::new(0.0, 0.0),
            Vec2::new(8.0, 0.0),
            Vec2::new(4.0, 6.0),
        ];
        let m = extrude(&tri, 3.0);
        // 2 caps × 1 tri + 3 walls × 2 tris = 8 tris.
        assert_eq!(m.vertex_count(), 24);
    }

    /// A clockwise loop must produce the same solid as a counter-clockwise one —
    /// the normalisation is what keeps the outward normals correct either way.
    #[test]
    fn winding_does_not_change_the_solid() {
        let mut cw = square();
        cw.reverse();
        let m = extrude(&cw, 5.0);
        assert_eq!(m.vertex_count(), 36);
        // The top-cap normals still face +Z.
        let mut top = 0;
        let mut i = 0;
        while i < m.verts.len() {
            if m.verts[i + 5] as f64 > 0.5 {
                top += 1;
            }
            i += 6;
        }
        assert!(top > 0, "a −Z cap must not be the only one");
    }

    #[test]
    fn a_circle_becomes_a_cylinder() {
        let prim = Prim::Circle(Circle::new(Vec2::new(0.0, 0.0), 5.0));
        let pts = closed_loop(&prim, 0.05, 256).expect("circle is a closed loop");
        assert!(pts.len() >= 8, "circle tessellated");
        let m = extrude(&pts, 4.0);
        // Caps: 2 × (n − 2) triangles. Walls: n edges × 2. So 4n − 4 triangles.
        assert_eq!(m.vertex_count(), 3 * (4 * pts.len() - 4));
    }

    #[test]
    fn half_a_curve_is_not_a_region() {
        use crate::geom::{Arc, LineSeg};
        let line = Prim::Line(LineSeg::new(Vec2::new(0.0, 0.0), Vec2::new(1.0, 0.0)));
        assert!(closed_loop(&line, 0.05, 64).is_none());
        let arc = Prim::Arc(Arc::new(Vec2::new(0.0, 0.0), 5.0, 0.0, 1.0));
        assert!(closed_loop(&arc, 0.05, 64).is_none());
    }

    #[test]
    fn a_concave_outline_stays_inside_itself() {
        // An L shape: the ear clipper must not bridge the notch.
        let l = vec![
            Vec2::new(0.0, 0.0),
            Vec2::new(6.0, 0.0),
            Vec2::new(6.0, 2.0),
            Vec2::new(2.0, 2.0),
            Vec2::new(2.0, 6.0),
            Vec2::new(0.0, 6.0),
        ];
        let tris = triangulate(&l);
        // A simple polygon of n vertices always triangulates to exactly n − 2.
        assert_eq!(tris.len(), 4, "L shape → 4 triangles");
        let m = extrude(&l, 1.0);
        assert_eq!(m.vertex_count(), 3 * (4 * 2 + 6 * 2));
        let _ = Polyline::new(l, true);
    }

    /// A frame really is applied: the same square extruded on YZ comes out
    /// standing on world Y/Z, running along +X, with its caps normal to ±X.
    #[test]
    fn extruding_on_the_yz_plane_stands_the_solid_up() {
        let f = Frame::from_slice(&[
            0.0, 0.0, 0.0, // origin
            0.0, 1.0, 0.0, // u = +Y
            0.0, 0.0, 1.0, // v = +Z
        ])
        .expect("a valid yz frame");
        let m = super::extrude(&square(), 5.0, &f);
        assert_eq!(m.vertex_count(), 36);
        let mut caps = 0;
        let mut i = 0;
        while i < m.verts.len() {
            let x = m.verts[i] as f64;
            let nx = m.verts[i + 3] as f64;
            assert!(x >= -1e-6 && x <= 5.0 + 1e-6, "extrusion runs along +X, x = {x}");
            if nx.abs() > 0.9 {
                caps += 1;
            }
            i += 6;
        }
        assert!(caps > 0, "the caps face ±X");
    }

    /// Degenerate frames are refused rather than producing silent garbage: two
    /// parallel axes name no plane.
    #[test]
    fn a_degenerate_frame_is_rejected() {
        assert!(Frame::from_slice(&[0.0; 9]).is_none(), "zero axes");
        assert!(
            Frame::from_slice(&[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 2.0, 0.0, 0.0]).is_none(),
            "parallel axes"
        );
        assert!(Frame::from_slice(&[0.0, 0.0, 0.0]).is_none(), "too short");
    }
}
