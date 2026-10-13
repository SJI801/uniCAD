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

pub(crate) fn norm3(a: [f64; 3]) -> Option<[f64; 3]> {
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

/// Revolve a closed loop around an axis **lying in the same plane**, by
/// `angle` radians — the lathe operation. `None` when the loop is not a valid
/// solid of revolution (see below).
///
/// The axis arrives in the plane's own 2D coordinates, because that is the
/// only frame the front end has: the user drew a profile and a centreline in
/// one sketch. Working in those coordinates is also what keeps this function
/// the same shape as `extrude`.
///
/// **The change of coordinates is the whole algorithm.** Map each loop point
/// `p` to `(s, r)` — distance along the axis, signed distance from it:
/// `s = (p − a)·d`, `r = d × (p − a)`. In `(s, r)` the surface of revolution is
/// exactly an *extrusion along θ*: the point `(s, r)` at angle `θ` sits at
/// `a + s·d̂ + r·(cos θ·b̂ + sin θ·n̂)`, where `b̂` is the in-plane perpendicular
/// to the axis and `n̂` the plane normal. So the walls get the same winding rule
/// as `extrude` (loop normalised CCW, outward normal = edge direction rotated
/// −90°), the caps reuse `triangulate`, and only the vertex mapping differs.
///
/// `None` — a *modelling* error, not a crash — when the profile touches or
/// crosses the axis: a point at `r = 0` is on the axis, a sign change means the
/// profile straddles it, and either way the swept surface folds through itself.
/// Same posture as `closed_loop` returning `None` for half a curve: the front
/// end has a sentence for it.
///
/// **Signs.** The sweep is right-handed about `axis_dir`, so `(d, a)` and
/// `(−d, −a)` are the *same solid* — that equivalence plus the `r > 0`
/// normalisation below is what lets the whole function stay in one code path:
///
///   - the profile is reflected through the axis point when it sits entirely at
///     `r < 0` (with `angle` negated, which is exactly the equivalence above),
///     so `r > 0` always holds by the time geometry is built;
///   - a negative `angle` then only flips the *outward* direction, so it is
///     applied to the normals — not by flipping the axis, which the
///     normalisation would immediately undo.
pub fn revolve(
    loop_pts: &[Vec2],
    axis_point: Vec2,
    axis_dir: Vec2,
    angle: f64,
    tol: f64,
    max_seg: u32,
    frame: &Frame,
) -> Option<Mesh> {
    if loop_pts.len() < 3 {
        return None;
    }
    let mut d = axis_dir.normalized();
    if d.length() <= 1e-12 {
        return None;
    }
    let mut ang = angle;
    if !(ang.abs() > 1e-9) {
        return None;
    }

    // ---- into (s, r) -----------------------------------------------------
    let mut sr: Vec<Vec2> = loop_pts
        .iter()
        .map(|p| {
            let w = Vec2::new(p.x - axis_point.x, p.y - axis_point.y);
            Vec2::new(w.dot(d), d.cross(w))
        })
        .collect();

    // Entirely on one side of the axis, and not touching it. A mixed sign means
    // the profile crosses; `|r|` below the tolerance means it sits on the axis
    // and the sweep collapses there.
    if sr.iter().all(|q| q.y < 0.0) {
        // Reflect through the axis point: same solid, `r > 0` again, and the
        // angle negated to keep it the same solid (see the note above).
        d = Vec2::new(-d.x, -d.y);
        for q in sr.iter_mut() {
            *q = Vec2::new(-q.x, -q.y);
        }
        ang = -ang;
    }
    if sr.iter().any(|q| q.y <= 1e-9) {
        return None;
    }

    // CCW from here on, so "interior on the left of a→b" holds like extrude.
    if signed_area(&sr) < 0.0 {
        sr.reverse();
    }
    let n = sr.len();
    let r_max = sr.iter().fold(0.0f64, |m, q| m.max(q.y));

    // A negative sweep reverses every triangle's cross product, so the *winding*
    // is what flips. The wall normals do not: a wall's material is on the `r`
    // side of it whichever way the sweep runs, so the outward direction is the
    // same. The caps are the opposite — there the sweep's sign is exactly what
    // decides which side the material is on.
    let flip = ang < 0.0;

    // Angular resolution uses the kernel's one chord-tolerance rule, with `r_max`
    // in the role a circle radius plays everywhere else.
    let segs = arc_segment_count(ang, r_max, tol, max_seg);

    let mut mesh = Mesh::new(*frame);

    // The in-plane basis, in the frame's **local** space (x = plane u, y = v,
    // z = the plane normal). `tri` maps local → world, so everything below is
    // built local and never has to know which datum plane this is.
    let a3 = [d.x, d.y, 0.0];
    let b3 = [-d.y, d.x, 0.0];
    let n3 = [0.0, 0.0, 1.0];
    let rot = |v: [f64; 3], t: f64| -> [f64; 3] {
        // Rotate a direction around the axis: split it into (along-axis,
        // in-plane-perp, plane-normal) components, rotate the latter two as a
        // pair, map back to local xyz. Doing it in the (a3, b3, n3) basis is
        // what makes this a two-line rotation instead of a Rodrigues formula.
        let dot = |x: [f64; 3], y: [f64; 3]| x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
        let ca = dot(v, a3);
        let cb = dot(v, b3);
        let cn = dot(v, n3);
        let (c, s) = (t.cos(), t.sin());
        let rb = cb * c + cn * s;
        let rn = cn * c - cb * s;
        [
            ca * a3[0] + rb * b3[0] + rn * n3[0],
            ca * a3[1] + rb * b3[1] + rn * n3[1],
            ca * a3[2] + rb * b3[2] + rn * n3[2],
        ]
    };
    let at = |q: Vec2, t: f64| -> [f64; 3] {
        let (c, s) = (t.cos(), t.sin());
        [
            axis_point.x + q.x * a3[0] + q.y * (c * b3[0] + s * n3[0]),
            axis_point.y + q.x * a3[1] + q.y * (c * b3[1] + s * n3[1]),
            q.x * a3[2] + q.y * (c * b3[2] + s * n3[2]),
        ]
    };

    // ---- walls -----------------------------------------------------------
    for i in 0..n {
        let a = sr[i];
        let b = sr[(i + 1) % n];
        let e = Vec2::new(b.x - a.x, b.y - a.y);
        let len = e.length();
        if len <= 1e-12 {
            continue;
        }
        let (nx, ny) = (e.y / len, -e.x / len);
        for j in 0..segs {
            let t0 = ang * (j as f64) / (segs as f64);
            let t1 = ang * ((j + 1) as f64) / (segs as f64);
            // The wall between two angles is a ruled surface, not a plane, so a
            // single flat normal is an approximation by construction. Take it at
            // the mid-angle: the facet then sits symmetrically around its own
            // normal instead of leaning towards one end.
            let tm = 0.5 * (t0 + t1);
            let nn = {
                let (c, s) = (tm.cos(), tm.sin());
                [
                    nx * a3[0] + ny * (c * b3[0] + s * n3[0]),
                    nx * a3[1] + ny * (c * b3[1] + s * n3[1]),
                    nx * a3[2] + ny * (c * b3[2] + s * n3[2]),
                ]
            };
            if flip {
                mesh.tri(at(a, t0), at(b, t1), at(b, t0), nn);
                mesh.tri(at(a, t0), at(a, t1), at(b, t1), nn);
            } else {
                mesh.tri(at(a, t0), at(b, t0), at(b, t1), nn);
                mesh.tri(at(a, t0), at(b, t1), at(a, t1), nn);
            }
        }
    }

    // ---- caps ------------------------------------------------------------
    //
    // Only when the sweep does not close on itself: a full turn is already a
    // closed surface, and capping it would put two coincident sheets inside the
    // solid.
    let full = (ang.abs() - std::f64::consts::TAU).abs() < 1e-9;
    if !full {
        // A CCW loop in `(s, r)` maps to a CCW loop facing +n̂, so the θ = 0 cap
        // is the reversed one and the θ = angle cap keeps its winding — exactly
        // extrude's bottom/top pair, and both swap when the sweep does.
        let end_normal = rot(n3, ang);
        for t in triangulate(&sr) {
            let (a, b, c) = (sr[t[0]], sr[t[1]], sr[t[2]]);
            if flip {
                // Material spans `θ ∈ [ang, 0]`, so the start cap faces +n̂ and the
                // end cap faces *back* along the sweep.
                mesh.tri(at(a, 0.0), at(b, 0.0), at(c, 0.0), [0.0, 0.0, 1.0]);
                mesh.tri(
                    at(a, ang),
                    at(c, ang),
                    at(b, ang),
                    [-end_normal[0], -end_normal[1], -end_normal[2]],
                );
            } else {
                mesh.tri(at(a, 0.0), at(c, 0.0), at(b, 0.0), [0.0, 0.0, -1.0]);
                mesh.tri(at(a, ang), at(b, ang), at(c, ang), end_normal);
            }
        }
    }

    Some(mesh)
}

/// Signed volume of a flat-shaded triangle soup, via the divergence theorem.
/// Positive when the triangles wind outward. One number that checks geometry
/// *and* orientation — a mesh whose normals face inward comes back negative.
///
/// The `6`-float stride is the trap: a vertex is position **plus** normal, so
/// the three corners of a triangle sit at offsets 0, 6 and 12 — reading them at
/// 0/3/6 silently picks up normals as if they were positions (and returns 0 for
/// a box, which is how this was found).
///
/// Test-only, but deliberately outside the test module: `boolean.rs` needs the
/// same measure, and two copies would be two chances to get the stride wrong.
#[cfg(test)]
pub(crate) fn soup_volume(verts: &[f32]) -> f64 {
    let mut v = 0.0;
    let mut i = 0;
    while i + 17 < verts.len() {
        let p = |k: usize| {
            [verts[i + k] as f64, verts[i + k + 1] as f64, verts[i + k + 2] as f64]
        };
        let (a, b, c) = (p(0), p(6), p(12));
        v += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0]);
        i += 18;
    }
    v / 6.0
}

/// Nearest hit of a ray against a flat-shaded triangle soup.
///
/// Returns `(t, point, normal)`: the distance along `dir`, the hit point, and
/// the **stored** flat-shading normal of the face that was hit — the normal the
/// user actually sees, which is what a hole's axis has to follow.
///
/// Back faces count: a ray that starts inside a solid must still find the far
/// wall (that is what makes a second hole drilled into the first one's bore
/// land on the right surface). `dir` need not be normalised — `t` is in units
/// of `dir`.
///
/// Möller–Trumbore, with the barycentric test slackened by a small epsilon so a
/// hit exactly on a shared edge is not dropped by rounding.
pub fn pick_mesh(soup: &[f32], origin: [f64; 3], dir: [f64; 3]) -> Option<(f64, [f64; 3], [f64; 3])> {
    let eps = 1e-9;
    let mut best: Option<(f64, [f64; 3], [f64; 3])> = None;
    let mut i = 0;
    while i + 17 < soup.len() {
        let at = |k: usize| [soup[i + k] as f64, soup[i + k + 1] as f64, soup[i + k + 2] as f64];
        let (a, b, c) = (at(0), at(6), at(12));
        let e1 = sub3(b, a);
        let e2 = sub3(c, a);
        let pvec = cross3(dir, e2);
        let det = dot3(e1, pvec);
        if det.abs() > 1e-12 {
            let inv = 1.0 / det;
            let tvec = sub3(origin, a);
            let u = dot3(tvec, pvec) * inv;
            if u >= -eps && u <= 1.0 + eps {
                let qvec = cross3(tvec, e1);
                let v = dot3(dir, qvec) * inv;
                if v >= -eps && u + v <= 1.0 + eps {
                    let t = dot3(e2, qvec) * inv;
                    if t > eps && best.map_or(true, |(bt, _, _)| t < bt) {
                        let normal = [soup[i + 3] as f64, soup[i + 4] as f64, soup[i + 5] as f64];
                        let point = [
                            origin[0] + dir[0] * t,
                            origin[1] + dir[1] * t,
                            origin[2] + dir[2] * t,
                        ];
                        best = Some((t, point, normal));
                    }
                }
            }
        }
        i += 18;
    }
    best
}

fn sub3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot3(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// `(u, v)` completing a right-handed frame around `n`, which must be unit.
///
/// Crosses `n` with whichever world axis is *least* aligned with it: that choice
/// is what keeps the result well-conditioned for every direction, including the
/// ones where a naive `(1,0,0)` would be parallel.
pub fn perpendicular_basis(n: [f64; 3]) -> ([f64; 3], [f64; 3]) {
    let ax = n[0].abs();
    let ay = n[1].abs();
    let az = n[2].abs();
    let helper = if ax <= ay && ax <= az {
        [1.0, 0.0, 0.0]
    } else if ay <= az {
        [0.0, 1.0, 0.0]
    } else {
        [0.0, 0.0, 1.0]
    };
    let u = norm3(cross3(helper, n)).unwrap_or([0.0, 1.0, 0.0]);
    let v = norm3(cross3(n, u)).unwrap_or([0.0, 0.0, 1.0]);
    (u, v)
}

/// Loft: skin a sequence of closed sections into one solid (work package 3.4).
///
/// Each section is a 2D loop in **its own** plane — the sections come from
/// different sketches, which is the whole point of a loft: a shape that changes
/// from one cross-section to another, like a tapered pipe. Each loop is placed
/// in world space by its frame.
///
/// The sections are resampled to a **common point count by arc length**,
/// starting at each loop's own first vertex, and then connected index to index.
/// That is the simple, predictable correspondence: two circles drawn from angle
/// 0 line up, two rectangles drawn from the same corner line up. A smarter
/// matching (closest point, minimal twist) is a separate piece of work — how a
/// loft twists is a modelling decision, not something to guess at.
///
/// Returns an empty mesh when the sections cannot bound a solid: fewer than two
/// of them, or stacked so that a section's plane is parallel to the loft
/// direction (a loft cannot go sideways inside its own sections' planes).
pub fn loft(sections: &[(Vec<Vec2>, Frame)]) -> Mesh {
    let first_frame = sections.first().map(|(_, f)| *f).unwrap_or_else(Frame::xy);
    if sections.len() < 2 {
        return Mesh::new(first_frame);
    }

    // The loft direction: from the first section's centre to the last's. Every
    // section's placement is compared against it.
    let centroid = |pts: &[Vec2]| -> Vec2 {
        let mut x = 0.0;
        let mut y = 0.0;
        for p in pts {
            x += p.x;
            y += p.y;
        }
        let n = pts.len().max(1) as f64;
        Vec2::new(x / n, y / n)
    };
    let (first_pts, first_fr) = &sections[0];
    let (last_pts, last_fr) = &sections[sections.len() - 1];
    let a = first_fr.point([centroid(first_pts).x, centroid(first_pts).y, 0.0]);
    let b = last_fr.point([centroid(last_pts).x, centroid(last_pts).y, 0.0]);
    let Some(dir) = norm3(sub3(b, a)) else {
        return Mesh::new(first_frame);
    };

    // Resample every section to one point count, and orient each loop so that it
    // runs counter-clockwise seen along `dir` — that single rule is what lets the
    // walls use extrude's winding (interior on the left of a→b) instead of a
    // per-quad guess about which way is out.
    let n = sections
        .iter()
        .map(|(pts, _)| pts.len())
        .max()
        .unwrap_or(0)
        .clamp(3, 512);
    let mut rings: Vec<Vec<[f64; 3]>> = Vec::with_capacity(sections.len());
    for (pts, frame) in sections {
        // A section whose plane is parallel to the loft direction cannot bound a
        // solid with the others: there is no "above" to sweep to.
        if dot3(frame.n, dir).abs() <= 1e-9 {
            return Mesh::new(first_frame);
        }
        let mut loop_pts = resample_closed(pts, n);
        // `frame.n` and `dir` may disagree; flipping the loop flips its winding,
        // which is exactly what the wall rule needs.
        if dot3(frame.n, dir) < 0.0 {
            loop_pts.reverse();
        }
        rings.push(loop_pts.iter().map(|p| frame.point([p.x, p.y, 0.0])).collect());
    }

    let mut mesh = Mesh::new(first_frame);

    // ---- walls -----------------------------------------------------------
    for k in 0..rings.len() - 1 {
        let (low, high) = (&rings[k], &rings[k + 1]);
        for i in 0..n {
            let j = (i + 1) % n;
            let (aa, bb) = (low[i], low[j]);
            let (a_up, b_up) = (high[i], high[j]);
            // Per-triangle normals rather than one per quad: a loft's wall between
            // two sections is generally *not* planar, and pretending otherwise
            // would light half of it from the wrong side.
            for t in [[aa, bb, b_up], [aa, b_up, a_up]] {
                if let Some(nrm) = norm3(cross3(sub3(t[1], t[0]), sub3(t[2], t[0]))) {
                    mesh.tri(t[0], t[1], t[2], nrm);
                }
            }
        }
    }

    // ---- caps ------------------------------------------------------------
    //
    // The first section's triangles come out facing +dir (CCW in its plane), so
    // they are emitted reversed to face −dir — extrude's bottom-cap rule — and
    // the last section keeps its winding.
    let mut start = resample_closed(&sections[0].0, n);
    if dot3(sections[0].1.n, dir) < 0.0 {
        start.reverse();
    }
    let mut end = resample_closed(&sections[sections.len() - 1].0, n);
    if dot3(sections[sections.len() - 1].1.n, dir) < 0.0 {
        end.reverse();
    }
    let neg = [-dir[0], -dir[1], -dir[2]];
    let start_frame = sections[0].1;
    for t in triangulate(&start) {
        let (a, b, c) = (start[t[0]], start[t[1]], start[t[2]]);
        mesh.tri(
            start_frame.point([a.x, a.y, 0.0]),
            start_frame.point([c.x, c.y, 0.0]),
            start_frame.point([b.x, b.y, 0.0]),
            neg,
        );
    }
    let end_frame = sections[sections.len() - 1].1;
    for t in triangulate(&end) {
        let (a, b, c) = (end[t[0]], end[t[1]], end[t[2]]);
        mesh.tri(
            end_frame.point([a.x, a.y, 0.0]),
            end_frame.point([b.x, b.y, 0.0]),
            end_frame.point([c.x, c.y, 0.0]),
            dir,
        );
    }
    mesh
}

/// Resample a closed loop to exactly `n` points by **splitting its edges** —
/// never dropping a vertex. `n` must be at least the loop's vertex count, which
/// the caller guarantees by taking the maximum over all sections.
///
/// Splitting rather than re-spacing: the extra points land on the existing edges
/// and every original corner survives, so the loop stays *the same polygon* with
/// more vertices and its area is untouched. Re-spacing the loop evenly would cut
/// corners instead — a 4×6 rectangle sampled at 7 even steps loses about a unit
/// of area — and every section would quietly shrink as it was lofted.
fn resample_closed(pts: &[Vec2], n: usize) -> Vec<Vec2> {
    let m = pts.len();
    if m == 0 {
        return Vec::new();
    }
    if n <= m {
        return pts.to_vec();
    }
    let mut lens = Vec::with_capacity(m);
    let mut total = 0.0;
    for i in 0..m {
        let a = pts[i];
        let b = pts[(i + 1) % m];
        let l = Vec2::new(b.x - a.x, b.y - a.y).length();
        lens.push(l);
        total += l;
    }

    // Each edge is split into at least one piece; the remainder is shared out in
    // proportion to length, so a long edge takes more of the new points than a
    // short one and the spacing stays roughly even.
    let extra = n - m;
    let mut pieces = vec![1usize; m];
    if total > 1e-12 {
        let mut assigned = 0usize;
        for i in 0..m {
            let share = (extra as f64 * lens[i] / total).floor() as usize;
            pieces[i] += share;
            assigned += share;
        }
        let mut order: Vec<usize> = (0..m).collect();
        order.sort_by(|&a, &b| lens[b].partial_cmp(&lens[a]).unwrap_or(std::cmp::Ordering::Equal));
        let mut k = 0usize;
        while assigned < extra {
            pieces[order[k % m]] += 1;
            assigned += 1;
            k += 1;
        }
    } else {
        // A degenerate loop: everything at one point.
        pieces[0] += extra;
    }

    let mut out = Vec::with_capacity(n);
    for i in 0..m {
        let a = pts[i];
        let b = pts[(i + 1) % m];
        // The edge's own end vertex is the next edge's start, so only the
        // interior samples are emitted here.
        for s in 0..pieces[i] {
            let t = s as f64 / pieces[i] as f64;
            out.push(Vec2::new(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
        }
    }
    out
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
        // 10 × 10 × 5 = 500 — and positive, i.e. wound outward.
        let v = signed_volume(&m);
        assert!((v - 500.0).abs() < 1e-9, "box volume {v}, expected 500");
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

    /// A ring of `radius` in the plane `z = height` — what one sketch of a
    /// tapered pipe contributes.
    fn circle_at(radius: f64, height: f64) -> (Vec<Vec2>, Frame) {
        let prim = Prim::Circle(Circle::new(Vec2::zero(), radius));
        let pts = closed_loop(&prim, 0.05, 256).expect("circle is a closed loop");
        (pts, plane_at(height))
    }

    fn plane_at(height: f64) -> Frame {
        Frame {
            origin: [0.0, 0.0, height],
            u: [1.0, 0.0, 0.0],
            v: [0.0, 1.0, 0.0],
            n: [0.0, 0.0, 1.0],
        }
    }

    /// A rectangle centred on the plane's origin.
    fn rect_at(w: f64, h: f64, height: f64) -> (Vec<Vec2>, Frame) {
        let pts = vec![
            Vec2::new(-w / 2.0, -h / 2.0),
            Vec2::new(w / 2.0, -h / 2.0),
            Vec2::new(w / 2.0, h / 2.0),
            Vec2::new(-w / 2.0, h / 2.0),
        ];
        (pts, plane_at(height))
    }

    // -----------------------------------------------------------------------
    // Loft (work package 3.4)
    // -----------------------------------------------------------------------

    /// Two rectangles give a **prismatoid**, so the volume is exact:
    /// `h/6·(A₁ + A₂ + 4·A_mid)` with `A_mid` the average rectangle. A broken
    /// vertex correspondence or an inside-out wall shows up immediately.
    #[test]
    fn lofts_two_rectangles_into_an_exact_prismatoid() {
        let m = loft(&[rect_at(4.0, 4.0, 0.0), rect_at(8.0, 6.0, 10.0)]);
        let expect = 10.0 / 6.0 * (16.0 + 48.0 + 4.0 * 30.0);
        let v = soup_volume(&m.verts);
        assert!((v - expect).abs() < 1e-9, "loft volume {v}, expected {expect}");
        assert!(v > 0.0, "the loft is inside-out");
    }

    /// The acceptance case: a tapered pipe from two circles. Their tessellations
    /// have different side counts, so both are resampled to the common count —
    /// which is why this one is checked against the ideal frustum within a
    /// percent or so rather than exactly.
    #[test]
    fn lofts_two_circles_into_a_tapered_pipe() {
        let m = loft(&[circle_at(3.0, 0.0), circle_at(6.0, 10.0)]);
        let expect = std::f64::consts::PI * 10.0 * (3.0 * 3.0 + 3.0 * 6.0 + 6.0 * 6.0) / 3.0;
        let v = soup_volume(&m.verts);
        assert!(
            (v - expect).abs() < expect * 0.02,
            "tapered pipe volume {v}, expected about {expect}"
        );
        assert!(v > 0.0, "the pipe is inside-out");
    }

    /// Three sections: the walls chain end to end and only the two *ends* get
    /// caps — one extra section is one more frustum, not a new cap.
    #[test]
    fn lofts_a_chain_of_three_sections() {
        let m = loft(&[rect_at(4.0, 4.0, 0.0), rect_at(8.0, 8.0, 5.0), rect_at(4.0, 4.0, 10.0)]);
        let one = 5.0 / 6.0 * (16.0 + 64.0 + 4.0 * 36.0);
        let v = soup_volume(&m.verts);
        assert!((v - 2.0 * one).abs() < 1e-9, "chained loft volume {v}");
    }

    /// Fewer than two sections, or a section standing parallel to the loft
    /// direction, is not a solid: empty, not a crash.
    #[test]
    fn impossible_lofts_come_back_empty() {
        assert_eq!(loft(&[]).vertex_count(), 0);
        assert_eq!(loft(&[rect_at(4.0, 4.0, 0.0)]).vertex_count(), 0);
        // A section on its side: its plane contains the loft direction, so there
        // is no "above" for it to sweep to.
        let sideways = Frame {
            origin: [0.0, 0.0, 5.0],
            u: [0.0, 1.0, 0.0],
            v: [0.0, 0.0, 1.0],
            n: [1.0, 0.0, 0.0],
        };
        let pts = vec![
            Vec2::new(-2.0, -2.0),
            Vec2::new(2.0, -2.0),
            Vec2::new(2.0, 2.0),
            Vec2::new(-2.0, 2.0),
        ];
        assert_eq!(loft(&[rect_at(4.0, 4.0, 0.0), (pts, sideways)]).vertex_count(), 0);
    }

    /// Resampling keeps a polygon *as* that polygon: the new points land on the
    /// existing edges, every original corner survives, and the area is
    /// untouched. That is what makes the volumes above predictable at all.
    #[test]
    fn resampling_preserves_a_polygons_area() {
        let (pts, _) = rect_at(4.0, 6.0, 0.0);
        for n in [4usize, 7, 16, 100] {
            let out = resample_closed(&pts, n);
            assert_eq!(out.len(), n, "point count");
            assert!(
                (signed_area(&out).abs() - 24.0).abs() < 1e-9,
                "area changed at n = {n}: {}",
                signed_area(&out).abs()
            );
            // Every original corner is still on the loop.
            for corner in &pts {
                assert!(
                    out.iter().any(|p| (p.x - corner.x).abs() < 1e-12 && (p.y - corner.y).abs() < 1e-12),
                    "a corner was dropped at n = {n}"
                );
            }
        }
    }


    // -----------------------------------------------------------------------
    // Ray picking (work package 3.2 — clicking a face in the 3D view)
    // -----------------------------------------------------------------------

    /// A ray down the middle of a box hits the near face first, at the right
    /// point, carrying that face's own outward normal.
    #[test]
    fn a_ray_down_the_middle_of_a_box_hits_the_near_face() {
        let m = extrude(&square(), 5.0);
        let (t, p, n) = pick_mesh(&m.verts, [5.0, 5.0, 20.0], [0.0, 0.0, -1.0]).expect("must hit");
        assert!((t - 15.0).abs() < 1e-9, "t {t} — from z = 20 down to the top cap");
        assert!(
            (p[0] - 5.0).abs() < 1e-9 && (p[1] - 5.0).abs() < 1e-9 && (p[2] - 5.0).abs() < 1e-9,
            "hit point {p:?}"
        );
        assert!((n[2] - 1.0).abs() < 1e-9, "the top face's outward normal is +Z");
    }

    /// Missing returns nothing — not the nearest edge, not a default.
    #[test]
    fn a_ray_that_misses_returns_nothing() {
        let m = extrude(&square(), 5.0);
        assert!(pick_mesh(&m.verts, [50.0, 50.0, 20.0], [0.0, 0.0, -1.0]).is_none(), "beside the box");
        assert!(pick_mesh(&m.verts, [5.0, -50.0, 2.5], [1.0, 0.0, 0.0]).is_none(), "past the side");
    }

    /// Back faces are hits too: a ray from inside finds the far wall. A second
    /// hole drilled into the first one's bore depends on exactly this.
    #[test]
    fn a_ray_from_inside_finds_the_far_wall() {
        let m = extrude(&square(), 5.0);
        let (t, p, _) = pick_mesh(&m.verts, [5.0, 5.0, 2.5], [0.0, 0.0, -1.0]).expect("must hit");
        assert!((t - 2.5).abs() < 1e-9, "t {t}");
        assert!(p[2].abs() < 1e-9, "the bottom cap, at z = 0");
    }

    /// The perpendicular basis is orthogonal, unit and right-handed for every
    /// direction — including the three where a naive helper axis is parallel.
    #[test]
    fn perpendicular_basis_is_sound_in_every_direction() {
        let d = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        for raw in [
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.6, 0.8, 0.0],
            [0.58, 0.58, 0.58],
        ] {
            let n = norm3(raw).unwrap();
            let (u, v) = perpendicular_basis(n);
            assert!(d(u, n).abs() < 1e-12 && d(v, n).abs() < 1e-12, "not perpendicular for {raw:?}");
            assert!((d(u, u) - 1.0).abs() < 1e-12 && (d(v, v) - 1.0).abs() < 1e-12, "not unit");
            assert!(d(cross3(u, v), n) > 1e-9, "not right-handed for {raw:?}");
        }
    }

    // -----------------------------------------------------------------------
    // Revolve
    // -----------------------------------------------------------------------

    /// Signed volume of a closed mesh — see `soup_volume` above for why the
    /// stride matters.
    fn signed_volume(m: &Mesh) -> f64 {
        soup_volume(&m.verts)
    }

    /// A rectangle above the X axis, revolved about it: a tube, inner r 10,
    /// outer r 20, length 20. The axis is `+X` through the origin, so the plane
    /// coordinates double as `(s, r)` and the numbers below read directly.
    fn tube_section() -> Vec<Vec2> {
        vec![
            Vec2::new(0.0, 10.0),
            Vec2::new(20.0, 10.0),
            Vec2::new(20.0, 20.0),
            Vec2::new(0.0, 20.0),
        ]
    }

    fn revolve_about_x(pts: &[Vec2], angle: f64) -> Option<Mesh> {
        super::revolve(
            pts,
            Vec2::new(0.0, 0.0),
            Vec2::new(1.0, 0.0),
            angle,
            TOL,
            MAX_SEG,
            &Frame::xy(),
        )
    }

    const TOL: f64 = 0.05;
    const MAX_SEG: u32 = 256;

    /// Volume of the **tessellated** lathe of a `(s, r)` rectangle.
    ///
    /// The exact lathe volume is `Δθ·r̄·A` (Pappus), but the mesh's radial walls
    /// are chords between angular samples, not arcs — so the mesh is smaller by
    /// exactly `segs·sin(Δθ)` per wedge, which is what a correct mesh must hit.
    /// Asserting the exact value instead would call every correct mesh 0.3% wrong.
    fn lathe_volume(segs: u32, angle: f64, r_in: f64, r_out: f64, length: f64) -> f64 {
        let dtheta = angle.abs() / segs as f64;
        length * (r_out * r_out - r_in * r_in) / 2.0 * (segs as f64) * dtheta.sin()
    }

    /// A full turn is a closed surface: walls only, no caps.
    #[test]
    fn revolves_a_section_into_a_tube() {
        let m = revolve_about_x(&tube_section(), std::f64::consts::TAU).expect("a valid section");
        let segs = arc_segment_count(std::f64::consts::TAU, 20.0, TOL, MAX_SEG);
        // 4 profile edges × `segs` quads × 2 triangles, and no caps.
        assert_eq!(m.vertex_count(), 4 * segs as usize * 2 * 3, "tube triangle count");

        // 20 long, r 10→20: 6000π before tessellation, `segs·sin(Δθ)` of it after.
        let v = signed_volume(&m);
        let expect = lathe_volume(segs, std::f64::consts::TAU, 10.0, 20.0, 20.0);
        assert!(
            (v - expect).abs() < expect * 1e-4,
            "tube volume {v}, expected {expect}"
        );
        // Positive volume = outward normals.
        assert!(v > 0.0, "the tube is inside-out");
    }

    /// Less than a turn needs the two flat section caps, and the wall count
    /// scales with the angle. Caps that were missing (or wound the wrong way)
    /// show up as a volume short of the quarter-tube.
    #[test]
    fn a_partial_turn_gets_caps() {
        let quarter = std::f64::consts::FRAC_PI_2;
        let m = revolve_about_x(&tube_section(), quarter).expect("a valid section");
        let segs = arc_segment_count(quarter, 20.0, TOL, MAX_SEG);
        // Walls + 2 caps × 2 triangles (the ear clipper on a rectangle).
        assert_eq!(m.vertex_count(), (4 * segs as usize * 2 + 4) * 3, "walls + caps");

        let v = signed_volume(&m);
        let expect = lathe_volume(segs, quarter, 10.0, 20.0, 20.0);
        assert!(
            (v - expect).abs() < expect * 1e-4,
            "quarter-tube volume {v}, expected {expect}"
        );
        assert!(v > 0.0, "the quarter tube is inside-out");
    }

    /// A profile touching the axis folds the surface through itself; a profile
    /// straddling it is worse. Both are modelling errors, not crashes.
    #[test]
    fn profiles_on_or_across_the_axis_are_refused() {
        let touching = vec![
            Vec2::new(0.0, 0.0),
            Vec2::new(10.0, 0.0),
            Vec2::new(10.0, 5.0),
        ];
        assert!(revolve_about_x(&touching, 1.0).is_none(), "profile on the axis");

        let crossing = vec![
            Vec2::new(0.0, -5.0),
            Vec2::new(10.0, -5.0),
            Vec2::new(10.0, 5.0),
        ];
        assert!(revolve_about_x(&crossing, 1.0).is_none(), "profile across the axis");
    }

    /// A negative angle sweeps the other way: same solid, mirrored about the
    /// plane of the profile — and, being a solid, still outward-wound.
    #[test]
    fn a_negative_angle_revolves_the_other_way() {
        let half = std::f64::consts::PI;
        let fwd = revolve_about_x(&tube_section(), half).expect("valid");
        let back = revolve_about_x(&tube_section(), -half).expect("valid");
        assert_eq!(fwd.vertex_count(), back.vertex_count());
        let zmax = |m: &Mesh| {
            let mut t = f64::MIN;
            let mut i = 0;
            while i < m.verts.len() {
                t = t.max(m.verts[i + 2] as f64);
                i += 6;
            }
            t
        };
        assert!(zmax(&fwd) > 1.0 && zmax(&back) < 1e-9, "opposite hemispheres");
        assert!(signed_volume(&back) > 0.0, "the negative sweep is inside-out");
        let expect = lathe_volume(
            arc_segment_count(half, 20.0, TOL, MAX_SEG),
            half,
            10.0,
            20.0,
            20.0,
        );
        assert!(
            (signed_volume(&back) - expect).abs() < expect * 1e-4,
            "half-tube volume"
        );
    }

    /// A profile **below** the axis is the mirror image of one above it: the
    /// same volume, and still outward-wound. This is the case the `r > 0`
    /// normalisation exists for.
    #[test]
    fn a_profile_below_the_axis_still_sweeps_outward() {
        let below: Vec<Vec2> = tube_section()
            .into_iter()
            .map(|p| Vec2::new(p.x, -p.y))
            .collect();
        let m = revolve_about_x(&below, std::f64::consts::TAU).expect("valid");
        let segs = arc_segment_count(std::f64::consts::TAU, 20.0, TOL, MAX_SEG);
        let v = signed_volume(&m);
        let expect = lathe_volume(segs, std::f64::consts::TAU, 10.0, 20.0, 20.0);
        assert!((v - expect).abs() < expect * 1e-4, "mirrored tube volume {v}");
        assert!(v > 0.0, "the mirrored tube is inside-out");
    }

    /// Winding is normalised, exactly as it is for extrude.
    #[test]
    fn revolve_winding_does_not_change_the_solid() {
        let mut cw = tube_section();
        cw.reverse();
        let m = revolve_about_x(&cw, std::f64::consts::TAU).expect("valid");
        let ccw = revolve_about_x(&tube_section(), std::f64::consts::TAU).expect("valid");
        assert_eq!(m.vertex_count(), ccw.vertex_count());
        assert!((signed_volume(&m) - signed_volume(&ccw)).abs() < 1e-6);
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
