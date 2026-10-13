//! Mesh booleans — the difference, by BSP clipping (`ROADMAP` 2.1).
//!
//! ## Why BSP
//!
//! A mesh boolean is where "the kernel is the only place that does geometry"
//! meets "the input is a triangle soup with no topology": the two solids are
//! just triangles, and the job is the boundary of `A \ B`. The classic answer
//! (Naylor's, popularised by `csg.js`) is to build a BSP tree per solid, clip
//! each against the other, and re-combine — a few hundred lines, no exact
//! predicates, no manifold repair pass.
//!
//! What that buys: the case this work package exists for — a block with a hole
//! punched through it — at a cost a person can read in one sitting. What it
//! does not buy: coplanar faces survive only through the epsilon and can still
//! leave slivers, and the result is a soup rather than a manifold. That is fine
//! for drawing and for feeding another boolean; it is wrong for anything that
//! needs adjacency. `ROADMAP` 2.3 is where the degenerate cases get their own
//! pass — this file is the honest first version, not a promise of the last one.
//!
//! ## Conventions
//!
//! Input and output use the wire `mesh.rs` produces: flat-shaded, non-indexed,
//! **6 floats per vertex** (position + normal), world space. Clipping makes
//! n-gons, which are re-fanned into triangles on the way out with each
//! polygon's own plane normal — so the result stays flat-shaded and needs no
//! re-normalisation, and it can be fed straight back into `subtract`.

use std::mem;

use crate::geom::{Circle, Prim};
use crate::math::Vec2;

// ---------------------------------------------------------------------------
// Small vector helpers, in the `[f64; 3]` shape `mesh.rs` uses
// ---------------------------------------------------------------------------

type V3 = [f64; 3];

#[inline]
fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

#[inline]
fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

#[inline]
fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[inline]
fn length(a: V3) -> f64 {
    dot(a, a).sqrt()
}

#[inline]
fn scale(a: V3, s: f64) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}

#[inline]
fn lerp3(a: V3, b: V3, t: f64) -> V3 {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

// ---------------------------------------------------------------------------
// Plane and polygon
// ---------------------------------------------------------------------------

/// A plane as `n · p = w`, with `n` unit length.
#[derive(Clone, Copy)]
struct Plane {
    n: V3,
    w: f64,
}

impl Plane {
    /// The plane through three points, or `None` for a degenerate triangle.
    fn from_points(a: V3, b: V3, c: V3, eps: f64) -> Option<Plane> {
        let n = cross(sub(b, a), sub(c, a));
        let len = length(n);
        if !(len > eps) {
            return None;
        }
        let n = scale(n, 1.0 / len);
        Some(Plane { n, w: dot(n, a) })
    }

    /// Split `poly` against this plane, appending to the four outputs:
    /// coplanar-front, coplanar-back, front, back.
    ///
    /// Coplanar polygons are separated by their normal's agreement with the
    /// plane — that single rule is what keeps two touching faces from both
    /// surviving into the result.
    fn split(
        &self,
        poly: &Poly,
        eps: f64,
        co_front: &mut Vec<Poly>,
        co_back: &mut Vec<Poly>,
        front: &mut Vec<Poly>,
        back: &mut Vec<Poly>,
    ) {
        const COPLANAR: u8 = 0;
        const FRONT: u8 = 1;
        const BACK: u8 = 2;
        const SPANNING: u8 = 3;

        // A sliver is dropped rather than classified. Clipping near-tangent
        // geometry produces polygons of essentially zero area whose three points
        // are nearly collinear — their *plane* is numerical noise, and a noise
        // plane in the tree misclassifies everything that meets it later.
        // Dropping them at the door is the cheapest place to stop that.
        let sliver = eps * eps;
        let keep = |v: Vec<V3>| poly_area2(&v) > sliver;

        let mut poly_type = COPLANAR;
        let mut types: Vec<u8> = Vec::with_capacity(poly.verts.len());
        for v in &poly.verts {
            let t = dot(self.n, *v) - self.w;
            let ty = if t < -eps {
                BACK
            } else if t > eps {
                FRONT
            } else {
                COPLANAR
            };
            poly_type |= ty;
            types.push(ty);
        }

        match poly_type {
            COPLANAR => {
                if dot(self.n, poly.plane.n) > 0.0 {
                    co_front.push(poly.clone());
                } else {
                    co_back.push(poly.clone());
                }
            }
            FRONT => front.push(poly.clone()),
            BACK => back.push(poly.clone()),
            _ => {
                let mut f: Vec<V3> = Vec::new();
                let mut b: Vec<V3> = Vec::new();
                for i in 0..poly.verts.len() {
                    let j = (i + 1) % poly.verts.len();
                    let (ti, tj) = (types[i], types[j]);
                    let (vi, vj) = (poly.verts[i], poly.verts[j]);
                    // A vertex on the plane belongs to both halves; that is what
                    // keeps the two pieces closed along the cut.
                    if ti != BACK {
                        f.push(vi);
                    }
                    if ti != FRONT {
                        b.push(vi);
                    }
                    if (ti | tj) == SPANNING {
                        let denom = dot(self.n, sub(vj, vi));
                        if denom.abs() > 1e-15 {
                            let t = (self.w - dot(self.n, vi)) / denom;
                            let v = lerp3(vi, vj, t);
                            f.push(v);
                            b.push(v);
                        }
                    }
                }
                if f.len() >= 3 && keep(f.clone()) {
                    front.push(Poly::new(f, poly.plane));
                }
                if b.len() >= 3 && keep(b.clone()) {
                    back.push(Poly::new(b, poly.plane));
                }
            }
        }
    }
}

/// Twice the area of a polygon, via the Newell sum — orientation-independent,
/// and valid for the n-gons clipping produces.
fn poly_area2(v: &[V3]) -> f64 {
    let mut n = [0.0, 0.0, 0.0];
    for i in 0..v.len() {
        let a = v[i];
        let b = v[(i + 1) % v.len()];
        n[0] += a[1] * b[2] - a[2] * b[1];
        n[1] += a[2] * b[0] - a[0] * b[2];
        n[2] += a[0] * b[1] - a[1] * b[0];
    }
    (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt()
}

/// A convex polygon: its boundary in order, plus the plane it lies on.
///
/// Convex because clipping a convex polygon by a plane yields at most two convex
/// polygons, and the input is triangles — so fan triangulation at the end is
/// always valid.
#[derive(Clone)]
struct Poly {
    verts: Vec<V3>,
    plane: Plane,
}

impl Poly {
    fn new(verts: Vec<V3>, plane: Plane) -> Self {
        Poly { verts, plane }
    }

    /// The same polygon facing the other way — reversing the boundary reverses
    /// the plane normal too, which is the whole trick of `Node::invert`.
    fn flipped(&self) -> Poly {
        Poly {
            verts: self.verts.iter().rev().copied().collect(),
            plane: Plane { n: scale(self.plane.n, -1.0), w: -self.plane.w },
        }
    }
}

// ---------------------------------------------------------------------------
// BSP node
// ---------------------------------------------------------------------------

struct Node {
    plane: Option<Plane>,
    front: Option<Box<Node>>,
    back: Option<Box<Node>>,
    polygons: Vec<Poly>,
    /// Classification tolerance, shared by the whole operation (see `scale_eps`).
    eps: f64,
}

impl Node {
    fn new(polygons: Vec<Poly>, eps: f64) -> Box<Node> {
        let mut node = Box::new(Node { plane: None, front: None, back: None, polygons: Vec::new(), eps });
        node.build(polygons);
        node
    }

    /// Convert every polygon to face the other way and swap the subtrees — the
    /// "outside" and "inside" of this solid trade places.
    fn invert(&mut self) {
        for p in self.polygons.iter_mut() {
            *p = p.flipped();
        }
        if let Some(pl) = &mut self.plane {
            pl.n = scale(pl.n, -1.0);
            pl.w = -pl.w;
        }
        if let Some(f) = &mut self.front {
            f.invert();
        }
        if let Some(b) = &mut self.back {
            b.invert();
        }
        mem::swap(&mut self.front, &mut self.back);
    }

    /// Remove the parts of `polygons` that are inside this solid.
    fn clip_polygons(&self, polygons: Vec<Poly>) -> Vec<Poly> {
        let Some(plane) = self.plane else {
            return polygons;
        };
        let mut front = Vec::new();
        let mut back = Vec::new();
        let mut co_front = Vec::new();
        let mut co_back = Vec::new();
        for p in polygons {
            // Coplanar polygons follow their normal: those facing the same way
            // as this plane are "in front" (outside), the others are not.
            plane.split(&p, self.eps, &mut co_front, &mut co_back, &mut front, &mut back);
        }
        // Coplanar-front joins the front half, coplanar-back the back half —
        // that is the split csg.js makes, and the reason two touching faces do
        // not both survive.
        front.extend(co_front);
        back.extend(co_back);
        let mut front = match &self.front {
            Some(f) => f.clip_polygons(front),
            None => front,
        };
        // Polygons behind the plane are inside the solid: dropped unless there
        // is a back subtree that can still carve something out of them.
        let back = match &self.back {
            Some(b) => b.clip_polygons(back),
            None => Vec::new(),
        };
        front.extend(back);
        front
    }

    /// Remove everything of `self` that is inside `other`.
    fn clip_to(&mut self, other: &Node) {
        self.polygons = other.clip_polygons(mem::take(&mut self.polygons));
        if let Some(f) = &mut self.front {
            f.clip_to(other);
        }
        if let Some(b) = &mut self.back {
            b.clip_to(other);
        }
    }

    fn all_polygons(&self) -> Vec<Poly> {
        let mut out = self.polygons.clone();
        if let Some(f) = &self.front {
            out.extend(f.all_polygons());
        }
        if let Some(b) = &self.back {
            out.extend(b.all_polygons());
        }
        out
    }

    /// Insert polygons into the tree, splitting on this node's plane.
    fn build(&mut self, polygons: Vec<Poly>) {
        if polygons.is_empty() {
            return;
        }
        if self.plane.is_none() {
            self.plane = Some(polygons[0].plane);
        }
        let plane = self.plane.expect("plane set above");
        let mut front = Vec::new();
        let mut back = Vec::new();
        let mut co_front = Vec::new();
        let mut co_back = Vec::new();
        for p in polygons {
            plane.split(&p, self.eps, &mut co_front, &mut co_back, &mut front, &mut back);
        }
        // A polygon lying exactly in this plane is a boundary face of this solid;
        // it stays here rather than being pushed to a child that would have to
        // re-discover the same plane.
        self.polygons.extend(co_front);
        self.polygons.extend(co_back);
        if !front.is_empty() {
            match &mut self.front {
                Some(f) => f.build(front),
                None => self.front = Some(Node::new(front, self.eps)),
            }
        }
        if !back.is_empty() {
            match &mut self.back {
                Some(b) => b.build(back),
                None => self.back = Some(Node::new(back, self.eps)),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Operation codes for the FFI surface. Mirrored in the TypeScript bridge
/// (`src/core/kernel.ts`), the same way `TRIM_*` in `ffi.rs` is.
pub const OP_SUBTRACT: u32 = 0;
pub const OP_UNION: u32 = 1;
pub const OP_INTERSECT: u32 = 2;

/// Boolean of two solids, by `op` (see the `OP_*` codes above).
///
/// Both inputs are flat-shaded triangle soups in the same coordinate system
/// (the front end hands over world-space meshes, one per feature). Returns the
/// resulting soup in the same wire format; an empty vec means the result has no
/// surface — `a` was empty, the cutter swallowed it, or two operands do not
/// touch at all — which the caller reports in words rather than as a blank
/// screen.
///
/// An unknown `op` returns empty rather than panicking: the two sides share a
/// documented set of codes, and a mismatch is a bug in the caller, not a reason
/// to take the wasm instance down.
pub fn boolean(a: &[f32], b: &[f32], op: u32) -> Vec<f32> {
    let pa = to_polygons(a);
    let pb = to_polygons(b);
    // An empty operand is answered by set algebra, not by a special case per
    // call site: A − ∅ = A, A ∪ ∅ = A, A ∩ ∅ = ∅ (and the mirror image when it
    // is `a` that is empty). Handing `a` back untouched also avoids
    // round-tripping it through the BSP, which would re-split its faces for
    // nothing.
    if pa.is_empty() && pb.is_empty() {
        return Vec::new();
    }
    if pb.is_empty() {
        return if op == OP_INTERSECT { Vec::new() } else { a.to_vec() };
    }
    if pa.is_empty() {
        return if op == OP_UNION { b.to_vec() } else { Vec::new() };
    }

    let eps = scale_eps(a, b);
    let mut na = Node::new(pa, eps);
    let mut nb = Node::new(pb, eps);
    // The three operations differ only in when each tree gets inverted and
    // clipped — the classic BSP constructions (Naylor; the `csg.js` spelling).
    // Shared below so a reader can compare them side by side.
    match op {
        OP_UNION => {
            na.clip_to(&nb);
            nb.clip_to(&na);
            nb.invert();
            nb.clip_to(&na);
            nb.invert();
            na.build(nb.all_polygons());
        }
        OP_INTERSECT => {
            na.invert();
            nb.clip_to(&na);
            nb.invert();
            na.clip_to(&nb);
            nb.clip_to(&na);
            na.build(nb.all_polygons());
            na.invert();
        }
        OP_SUBTRACT => {
            na.invert();
            na.clip_to(&nb);
            nb.clip_to(&na);
            nb.invert();
            nb.clip_to(&na);
            nb.invert();
            na.build(nb.all_polygons());
            na.invert();
        }
        _ => return Vec::new(),
    }
    from_polygons(&na.all_polygons())
}

/// Difference: the solid `a` with the solid `b` removed — the useful one, and
/// the only one the tree's ⊖ button creates directly.
pub fn subtract(a: &[f32], b: &[f32]) -> Vec<f32> {
    boolean(a, b, OP_SUBTRACT)
}

/// Drill a cylindrical hole into `solid`, in one call.
///
/// Composing the cutter here rather than in the front end keeps the whole
/// operation inside the kernel: building the frame from the face normal, the
/// circle, its extrusion and the boolean are all geometry, and a front end that
/// assembled them itself would need its own copy of every convention — which
/// way the axis points, how far outside the surface the cutter has to start.
///
/// `point` is on the surface, `normal` is that face's **outward** normal (the
/// hole runs the other way), `depth` is how far the hole goes *into* the
/// material — zero or negative means **through**, sized from the solid's own
/// bounding box rather than from a magic number.
///
/// Returns `solid` unchanged when there is nothing sensible to cut with (a
/// zero diameter, a degenerate normal, an empty solid): the caller has already
/// argued about the parameters, and a no-op is a better answer here than an
/// error code that means "you passed garbage".
pub fn subtract_hole(
    solid: &[f32],
    point: [f64; 3],
    normal: [f64; 3],
    diameter: f64,
    depth: f64,
    tol: f64,
    max_seg: u32,
) -> Vec<f32> {
    subtract_hole_pattern(solid, point, normal, diameter, depth, 1, 0.0, tol, max_seg)
}

/// Drill a **grid** of cylindrical holes into `solid`, in one call.
///
/// `count_u × count_v` instances on the face's own in-plane axes, `spacing_u` /
/// `spacing_v` apart, with the `(0, 0)` instance at `point` itself. Which way
/// those axes point is derived from the face normal inside the kernel
/// (`perpendicular_basis`) rather than passed in: the front end has no business
/// inventing an in-plane axis, and a caller's choice would be a second
/// convention to keep in step with the normals.
///
/// Every cutter goes into **one** soup and is subtracted in **one** boolean
/// pass — a grid of N holes as N subtractions would re-run the BSP against an
/// ever-larger mesh and cost N times as much for the same answer.
///
/// `count_u = count_v = 1` is the single-hole case; the depth semantics are
/// `subtract_hole`'s (zero or negative = through).
#[allow(clippy::too_many_arguments)]
pub fn subtract_hole_grid(
    solid: &[f32],
    point: [f64; 3],
    normal: [f64; 3],
    diameter: f64,
    depth: f64,
    count_u: u32,
    spacing_u: f64,
    count_v: u32,
    spacing_v: f64,
    tol: f64,
    max_seg: u32,
) -> Vec<f32> {
    if !(diameter > 0.0) || solid.len() < 18 {
        return solid.to_vec();
    }
    let Some(unit) = crate::mesh::norm3(normal) else {
        return solid.to_vec();
    };
    let diag = diag_of(solid);
    if !(diag > 0.0) {
        return solid.to_vec();
    }

    let clearance = diag * 1e-3;
    let span = if depth > 0.0 { depth } else { diag * 2.0 };
    let inward = [-unit[0], -unit[1], -unit[2]];
    let (u, v) = crate::mesh::perpendicular_basis(inward);
    let base_origin = [
        point[0] + unit[0] * clearance,
        point[1] + unit[1] * clearance,
        point[2] + unit[2] * clearance,
    ];
    let circle = Prim::Circle(Circle::new(Vec2::zero(), diameter * 0.5));
    let Some(loop_pts) = crate::mesh::closed_loop(&circle, tol, max_seg) else {
        return solid.to_vec();
    };

    // Normalisations, both about not handing the boolean a degeneracy the user
    // never asked for:
    //
    //   - a spacing of (near) zero stacks that axis' instances on top of each
    //     other, and N coincident cutters are one cutter — the BSP handles
    //     coincident solids only through its epsilon, and there is nothing to
    //     gain by making it try;
    //   - the counts are clamped to something a person could have meant, and to
    //     a total a BSP pass can chew: zero or one is a single hole, and 1000×1000
    //     is a typo rather than a request.
    let mut nu = count_u.clamp(1, 256);
    let mut nv = count_v.clamp(1, 256);
    if spacing_u.abs() <= 1e-9 * diag {
        nu = 1;
    }
    if spacing_v.abs() <= 1e-9 * diag {
        nv = 1;
    }
    while nu as u64 * nv as u64 > 1024 {
        if nu >= nv {
            nu -= 1;
        } else {
            nv -= 1;
        }
    }

    let mut cutter: Vec<f32> = Vec::with_capacity(nu as usize * nv as usize * loop_pts.len() * 36);
    for j in 0..nv {
        for k in 0..nu {
            let du = spacing_u * k as f64;
            let dv = spacing_v * j as f64;
            let frame = crate::mesh::Frame {
                origin: [
                    base_origin[0] + u[0] * du + v[0] * dv,
                    base_origin[1] + u[1] * du + v[1] * dv,
                    base_origin[2] + u[2] * du + v[2] * dv,
                ],
                u,
                v,
                n: inward,
            };
            let cylinder = crate::mesh::extrude(&loop_pts, clearance + span, &frame);
            cutter.extend_from_slice(&cylinder.verts);
        }
    }
    boolean(solid, &cutter, OP_SUBTRACT)
}

/// The one-axis case, kept because most callers mean a row.
#[allow(clippy::too_many_arguments)]
pub fn subtract_hole_pattern(
    solid: &[f32],
    point: [f64; 3],
    normal: [f64; 3],
    diameter: f64,
    depth: f64,
    count: u32,
    spacing: f64,
    tol: f64,
    max_seg: u32,
) -> Vec<f32> {
    subtract_hole_grid(solid, point, normal, diameter, depth, count, spacing, 1, 0.0, tol, max_seg)
}

/// Bounding-box diagonal — the length scale used for tolerances and for
/// "through" depth, both of which have to mean something on a 0.1 mm part and a
/// 100 mm one alike.
fn diag_of(soup: &[f32]) -> f64 {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    let mut i = 0;
    while i + 2 < soup.len() {
        for k in 0..3 {
            let v = soup[i + k] as f64;
            if v < lo[k] {
                lo[k] = v;
            }
            if v > hi[k] {
                hi[k] = v;
            }
        }
        i += 6;
    }
    let d = ((hi[0] - lo[0]).powi(2) + (hi[1] - lo[1]).powi(2) + (hi[2] - lo[2]).powi(2)).sqrt();
    if d.is_finite() { d } else { 0.0 }
}

/// Classification tolerance, scaled to the input.
///
/// A fixed absolute epsilon is either too tight on a 100 mm part or too loose on
/// a 0.1 mm one; `1e-6` of the combined bounding diagonal sits in the useful
/// band on both.
fn scale_eps(a: &[f32], b: &[f32]) -> f64 {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for arr in [a, b] {
        let mut i = 0;
        while i + 2 < arr.len() {
            for k in 0..3 {
                let v = arr[i + k] as f64;
                if v < lo[k] {
                    lo[k] = v;
                }
                if v > hi[k] {
                    hi[k] = v;
                }
            }
            i += 6;
        }
    }
    let diag = ((hi[0] - lo[0]).powi(2) + (hi[1] - lo[1]).powi(2) + (hi[2] - lo[2]).powi(2)).sqrt();
    if !diag.is_finite() || diag <= 0.0 {
        return 1e-7;
    }
    (diag * 1e-6).clamp(1e-9, 1e-3)
}

fn to_polygons(soup: &[f32]) -> Vec<Poly> {
    let mut out = Vec::with_capacity(soup.len() / 18);
    let mut i = 0;
    while i + 17 < soup.len() {
        let v = |k: usize| -> V3 {
            [soup[i + k] as f64, soup[i + k + 1] as f64, soup[i + k + 2] as f64]
        };
        let (a, b, c) = (v(0), v(6), v(12));
        // The plane comes from the positions, not the stored normals: a caller
        // that got its normals wrong should not be able to corrupt the boolean.
        if let Some(plane) = Plane::from_points(a, b, c, 1e-12) {
            out.push(Poly::new(vec![a, b, c], plane));
        }
        i += 18;
    }
    out
}

/// Re-fan every polygon into triangles with its own plane normal.
///
/// Fan triangulation is valid because the polygons are convex by construction;
/// slivers (a clipped polygon that came back with a repeated vertex) are
/// dropped rather than emitted as zero-area triangles, which would break
/// normals and any later volume measure.
fn from_polygons(polys: &[Poly]) -> Vec<f32> {
    let mut out: Vec<f32> = Vec::new();
    for p in polys {
        if p.verts.len() < 3 {
            continue;
        }
        let n = p.plane.n;
        for i in 1..p.verts.len() - 1 {
            let (a, b, c) = (p.verts[0], p.verts[i], p.verts[i + 1]);
            if length(cross(sub(b, a), sub(c, a))) <= 1e-12 {
                continue;
            }
            for v in [a, b, c] {
                out.push(v[0] as f32);
                out.push(v[1] as f32);
                out.push(v[2] as f32);
                out.push(n[0] as f32);
                out.push(n[1] as f32);
                out.push(n[2] as f32);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::{extrude, Frame};
    use crate::geom::{Circle, Prim};
    use crate::math::Vec2;

    /// An axis-aligned box as a triangle soup, via the kernel's own extrude —
    /// so the boolean is tested against meshes the rest of the pipeline really
    /// produces, not hand-written triangles.
    fn box_soup(x0: f64, y0: f64, z_lo: f64, x1: f64, y1: f64, z_hi: f64) -> Vec<f32> {
        let rect = vec![
            Vec2::new(x0, y0),
            Vec2::new(x1, y0),
            Vec2::new(x1, y1),
            Vec2::new(x0, y1),
        ];
        let frame = Frame { origin: [0.0, 0.0, z_lo], u: [1.0, 0.0, 0.0], v: [0.0, 1.0, 0.0], n: [0.0, 0.0, 1.0] };
        extrude(&rect, z_hi - z_lo, &frame).verts
    }

    /// A cylinder along +Z as a triangle soup, through `closed_loop` + `extrude`.
    fn cylinder_z(cx: f64, cy: f64, radius: f64, z_lo: f64, z_hi: f64) -> (Vec<f32>, usize) {
        let prim = Prim::Circle(Circle::new(Vec2::new(cx, cy), radius));
        let pts = crate::mesh::closed_loop(&prim, 0.05, 256).expect("circle is a closed loop");
        let frame = Frame {
            origin: [0.0, 0.0, z_lo],
            u: [1.0, 0.0, 0.0],
            v: [0.0, 1.0, 0.0],
            n: [0.0, 0.0, 1.0],
        };
        let m = extrude(&pts, z_hi - z_lo, &frame);
        (m.verts, pts.len())
    }

    /// The same, along +X — a bore that crosses the other one. The frame's two
    /// in-plane axes are Y and Z, so the 2D profile's `(x, y)` are world
    /// `(y, z)` and the extrusion runs along X.
    fn cylinder_x(x_lo: f64, x_hi: f64, cy: f64, cz: f64, radius: f64) -> (Vec<f32>, usize) {
        let prim = Prim::Circle(Circle::new(Vec2::new(cy, cz), radius));
        let pts = crate::mesh::closed_loop(&prim, 0.05, 256).expect("circle is a closed loop");
        let frame = Frame {
            origin: [x_lo, 0.0, 0.0],
            u: [0.0, 1.0, 0.0],
            v: [0.0, 0.0, 1.0],
            n: [1.0, 0.0, 0.0],
        };
        let m = extrude(&pts, x_hi - x_lo, &frame);
        (m.verts, pts.len())
    }

    /// The acceptance case in `ROADMAP` 2.1: a block with a hole through it.
    ///
    /// The expected volume is exact for the *tessellated* parts: the outer block
    /// is a polyhedron the boolean must reproduce, and the hole is the inscribed
    /// prism through it — `(n/2)r²sin(2π/n)·h`.
    #[test]
    fn a_block_minus_a_cylinder_is_a_block_with_a_hole() {
        let block = box_soup(0.0, 0.0, 0.0, 10.0, 10.0, 10.0);
        let (cyl, n) = cylinder_z(5.0, 5.0, 3.0, -1.0, 11.0);
        let out = subtract(&block, &cyl);

        let hole = (n as f64 / 2.0) * 9.0 * (std::f64::consts::TAU / n as f64).sin() * 10.0;
        let expect = 1000.0 - hole;
        let v = crate::mesh::soup_volume(&out);
        assert!(
            (v - expect).abs() < expect * 1e-6,
            "block with a hole: volume {v}, expected {expect}"
        );
        // The result must be outward-wound, like every mesh this kernel emits.
        assert!(v > 0.0, "the result is inside-out");
    }

    /// Removing a piece that does not touch: the block comes back whole.
    #[test]
    fn subtracting_a_disjoint_solid_changes_nothing() {
        let block = box_soup(0.0, 0.0, 0.0, 10.0, 10.0, 10.0);
        let far = box_soup(20.0, 20.0, 20.0, 25.0, 25.0, 25.0);
        let out = subtract(&block, &far);
        let v = crate::mesh::soup_volume(&out);
        assert!((v - 1000.0).abs() < 1e-6, "volume {v}, expected 1000");
    }

    /// A corner notch — the cut opens up faces *and* touches the boundary.
    #[test]
    fn a_corner_notch_removes_exactly_its_volume() {
        let block = box_soup(0.0, 0.0, 0.0, 10.0, 10.0, 10.0);
        let notch = box_soup(6.0, 6.0, 6.0, 12.0, 12.0, 12.0);
        let out = subtract(&block, &notch);
        let v = crate::mesh::soup_volume(&out);
        // The overlap is the 4×4×4 corner = 64.
        assert!((v - 936.0).abs() < 1e-6, "notched block volume {v}, expected 936");
    }

    /// Coplanar faces — the case the epsilon exists for. `b` shares four of its
    /// faces with `a`, so half the surface is exactly on the other's planes.
    #[test]
    fn coplanar_faces_do_not_survive_the_cut() {
        let a = box_soup(0.0, 0.0, 0.0, 10.0, 10.0, 10.0);
        let b = box_soup(5.0, 0.0, 0.0, 10.0, 10.0, 10.0);
        let out = subtract(&a, &b);
        let v = crate::mesh::soup_volume(&out);
        // Half the block, and specifically *not* 500 + area(shared faces): a
        // boundary that survived in both directions would double-count.
        assert!((v - 500.0).abs() < 1e-6, "half block volume {v}, expected 500");
    }

    /// `b` swallowing `a` leaves nothing — an empty result, not a crash or a
    /// ghost shell.
    #[test]
    fn subtracting_a_larger_solid_leaves_nothing() {
        let small = box_soup(2.0, 2.0, 2.0, 8.0, 8.0, 8.0);
        let big = box_soup(0.0, 0.0, 0.0, 10.0, 10.0, 10.0);
        let out = subtract(&small, &big);
        assert!(out.is_empty(), "expected an empty result, got {} vertices", out.len() / 6);
    }

    /// Subtracting into an empty operand is a no-op, and subtracting *from* an
    /// empty one is empty — the two degenerate inputs, answered in words rather
    /// than by a panic.
    #[test]
    fn empty_operands_are_answered_not_crashed_on() {
        let block = box_soup(0.0, 0.0, 0.0, 10.0, 10.0, 10.0);
        let out = subtract(&block, &[]);
        assert_eq!(out.len(), block.len(), "an empty cutter must leave a untouched");
        assert!(subtract(&[], &block).is_empty());
    }

    /// Union of two overlapping blocks: neither volume counts twice.
    ///
    /// A = [0,10]³, B = [6,16]×[0,10]² — the overlap is 4×10×10 = 400, so the
    /// union is 1000 + 1000 − 400 = 1600. A union that failed to clip the
    /// interior faces would come out at 2000 and look "right" from outside.
    #[test]
    fn union_of_overlapping_blocks_counts_the_overlap_once() {
        let a = box_soup(0.0, 0.0, 0.0, 10.0, 10.0, 10.0);
        let b = box_soup(6.0, 0.0, 0.0, 16.0, 10.0, 10.0);
        let out = boolean(&a, &b, OP_UNION);
        let v = crate::mesh::soup_volume(&out);
        assert!((v - 1600.0).abs() < 1e-6, "union volume {v}, expected 1600");
        assert!(v > 0.0, "the union is inside-out");
    }

    /// Union of two blocks that share a whole face — coplanar input, the case
    /// the epsilon exists for. The shared face must vanish, not appear twice.
    #[test]
    fn union_of_touching_blocks_drops_the_shared_face() {
        let a = box_soup(0.0, 0.0, 0.0, 10.0, 10.0, 10.0);
        let b = box_soup(10.0, 0.0, 0.0, 20.0, 10.0, 10.0);
        let out = boolean(&a, &b, OP_UNION);
        let v = crate::mesh::soup_volume(&out);
        assert!((v - 2000.0).abs() < 1e-6, "joined volume {v}, expected 2000");
        // The seam is interior now, so no *face* may lie in the x = 10 plane.
        // (Vertices there are fine and expected — the outer faces of both
        // blocks meet along that line.)
        let mut on_seam = 0;
        let mut i = 0;
        while i + 17 < out.len() {
            let xs = [out[i] as f64, out[i + 6] as f64, out[i + 12] as f64];
            if xs.iter().all(|x| (x - 10.0).abs() < 1e-9) {
                on_seam += 1;
            }
            i += 18;
        }
        assert_eq!(on_seam, 0, "the shared face is still in the result");
    }

    /// Union of solids that do not touch: both come back, and the volume is
    /// simply the sum.
    #[test]
    fn union_of_disjoint_blocks_keeps_both() {
        let a = box_soup(0.0, 0.0, 0.0, 10.0, 10.0, 10.0);
        let b = box_soup(20.0, 20.0, 20.0, 25.0, 25.0, 25.0);
        let out = boolean(&a, &b, OP_UNION);
        let v = crate::mesh::soup_volume(&out);
        assert!((v - 1125.0).abs() < 1e-6, "union volume {v}, expected 1125");
    }

    /// Intersection is the overlap and nothing else — the complement of what
    /// the union test shows, on the same two blocks.
    #[test]
    fn intersection_is_exactly_the_overlap() {
        let a = box_soup(0.0, 0.0, 0.0, 10.0, 10.0, 10.0);
        let b = box_soup(6.0, 0.0, 0.0, 16.0, 10.0, 10.0);
        let out = boolean(&a, &b, OP_INTERSECT);
        let v = crate::mesh::soup_volume(&out);
        assert!((v - 400.0).abs() < 1e-6, "intersection volume {v}, expected 400");
        assert!(v > 0.0, "the intersection is inside-out");
    }

    /// Intersecting solids that never meet leaves nothing — and says so with an
    /// empty vec rather than a ghost sliver.
    #[test]
    fn intersection_of_disjoint_blocks_is_empty() {
        let a = box_soup(0.0, 0.0, 0.0, 10.0, 10.0, 10.0);
        let b = box_soup(20.0, 20.0, 20.0, 25.0, 25.0, 25.0);
        let out = boolean(&a, &b, OP_INTERSECT);
        assert!(out.is_empty(), "expected empty, got {} vertices", out.len() / 6);
    }

    /// The three operations agree about the same pair of solids — the inclusion
    /// identity `|A ∪ B| + |A ∩ B| = |A| + |B|`, and `|A − B| + |A ∩ B| = |A|`.
    /// One check that all three really are operating on the same geometry
    /// rather than each being right in isolation.
    #[test]
    fn the_three_operations_agree_on_the_same_pair() {
        let a = box_soup(0.0, 0.0, 0.0, 10.0, 10.0, 10.0);
        let b = box_soup(6.0, 0.0, 0.0, 16.0, 10.0, 10.0);
        let vol = |op| crate::mesh::soup_volume(&boolean(&a, &b, op));
        let (u, i, s) = (vol(OP_UNION), vol(OP_INTERSECT), vol(OP_SUBTRACT));
        assert!((u + i - 2000.0).abs() < 1e-6, "|A∪B| {u} + |A∩B| {i} != 2000");
        assert!((s + i - 1000.0).abs() < 1e-6, "|A−B| {s} + |A∩B| {i} != |A| 1000");
    }

    /// An unknown operation code is answered with an empty result, not a panic:
    /// the two sides share documented codes, and a mismatch is the caller's bug.
    #[test]
    fn an_unknown_operation_is_not_a_crash() {
        let a = box_soup(0.0, 0.0, 0.0, 10.0, 10.0, 10.0);
        let b = box_soup(2.0, 2.0, 2.0, 8.0, 8.0, 8.0);
        assert!(boolean(&a, &b, 99).is_empty());
    }

    /// The prism a tessellated circle sweeps — the exact volume a hole of that
    /// diameter and depth must remove.
    fn prism_volume(radius: f64, depth: f64) -> f64 {
        let pts = crate::mesh::closed_loop(
            &Prim::Circle(Circle::new(Vec2::zero(), radius)),
            0.05,
            256,
        )
        .expect("circle is a closed loop");
        let n = pts.len() as f64;
        (n / 2.0) * radius * radius * (std::f64::consts::TAU / n).sin() * depth
    }

    /// A through hole: the block loses exactly the prism the cutter sweeps.
    #[test]
    fn a_through_hole_removes_a_cylinders_worth() {
        let block = box_soup(0.0, 0.0, 0.0, 10.0, 10.0, 10.0);
        // Entry on the top face (z = 10), outward normal +Z, ⌀4, through.
        let out = subtract_hole(&block, [5.0, 5.0, 10.0], [0.0, 0.0, 1.0], 4.0, 0.0, 0.05, 256);
        let expect = 1000.0 - prism_volume(2.0, 10.0);
        let v = crate::mesh::soup_volume(&out);
        assert!((v - expect).abs() < expect * 1e-4, "holed block volume {v}, expected {expect}");
        assert!(v > 0.0, "the holed block is inside-out");
    }

    /// A blind hole stops at its depth — that parameter is the whole difference
    /// between a hole and a through hole.
    #[test]
    fn a_blind_hole_stops_at_its_depth() {
        let block = box_soup(0.0, 0.0, 0.0, 10.0, 10.0, 10.0);
        let out = subtract_hole(&block, [5.0, 5.0, 10.0], [0.0, 0.0, 1.0], 4.0, 3.0, 0.05, 256);
        let expect = 1000.0 - prism_volume(2.0, 3.0);
        let v = crate::mesh::soup_volume(&out);
        assert!((v - expect).abs() < expect * 1e-4, "blind hole volume {v}, expected {expect}");
    }

    /// The hole follows the face normal, not the world Z: the same ⌀4 through
    /// hole in a side face removes the same amount.
    #[test]
    fn a_hole_follows_the_face_normal() {
        let block = box_soup(0.0, 0.0, 0.0, 10.0, 10.0, 10.0);
        let out = subtract_hole(&block, [10.0, 5.0, 5.0], [1.0, 0.0, 0.0], 4.0, 0.0, 0.05, 256);
        let expect = 1000.0 - prism_volume(2.0, 10.0);
        let v = crate::mesh::soup_volume(&out);
        assert!((v - expect).abs() < expect * 1e-4, "side hole volume {v}, expected {expect}");
    }

    /// A hole drilled into a hole: the second one cuts the first one's result,
    /// which is the only way a bore and a counterbore can coexist.
    #[test]
    fn holes_chain_through_the_previous_result() {
        let block = box_soup(0.0, 0.0, 0.0, 20.0, 20.0, 20.0);
        let step1 = subtract_hole(&block, [10.0, 10.0, 20.0], [0.0, 0.0, 1.0], 4.0, 0.0, 0.05, 256);
        let v1 = crate::mesh::soup_volume(&step1);
        // A wider, shallower hole into the same face.
        let step2 = subtract_hole(&step1, [10.0, 10.0, 20.0], [0.0, 0.0, 1.0], 8.0, 4.0, 0.05, 256);
        let v2 = crate::mesh::soup_volume(&step2);
        // The counterbore removes its ring (⌀8 × 4 minus the ⌀4 core already gone).
        let ring = prism_volume(4.0, 4.0) - prism_volume(2.0, 4.0);
        assert!(
            (v2 - (v1 - ring)).abs() < v1 * 1e-3,
            "counterbored volume {v2}, expected {}",
            v1 - ring
        );
    }

    /// Degenerate arguments leave the solid alone: the caller has already
    /// argued about the parameters, and a no-op beats an error code here.
    #[test]
    fn degenerate_holes_change_nothing() {
        let block = box_soup(0.0, 0.0, 0.0, 10.0, 10.0, 10.0);
        let p = [5.0, 5.0, 10.0];
        let n = [0.0, 0.0, 1.0];
        for d in [0.0, -2.0] {
            let out = subtract_hole(&block, p, n, d, 3.0, 0.05, 256);
            assert_eq!(out.len(), block.len(), "diameter {d} must not cut anything");
        }
        let out = subtract_hole(&block, p, [0.0, 0.0, 0.0], 4.0, 3.0, 0.05, 256);
        assert_eq!(out.len(), block.len(), "a zero normal is not an axis");
        assert!(subtract_hole(&[], p, n, 4.0, 3.0, 0.05, 256).is_empty(), "no solid, no hole");
    }

    /// A row of holes: three instances remove three prisms.
    ///
    /// The row runs along an in-plane axis the *kernel* derives (for a +Z face
    /// that is +Y), so the block is wide enough that no instance has to hang
    /// over an edge: a cutter tangent to a face is a degenerate boolean input,
    /// and this test is about the pattern, not about `ROADMAP` 2.3.
    #[test]
    fn a_row_of_holes_removes_one_prism_each() {
        let block = box_soup(0.0, 0.0, 0.0, 40.0, 40.0, 20.0);
        let row = |c: u32| {
            subtract_hole_pattern(&block, [20.0, 8.0, 20.0], [0.0, 0.0, 1.0], 4.0, 0.0, c, 8.0, 0.05, 256)
        };
        let one = crate::mesh::soup_volume(&row(1));
        let three = crate::mesh::soup_volume(&row(3));
        // Holes at y = 8, 16, 24 — all inside the 40 mm span, ⌀4 so they clear
        // each other by 4 mm.
        let hole = prism_volume(2.0, 20.0);
        assert!((one - (32000.0 - hole)).abs() < 1e-3, "one hole {one}");
        assert!((three - (32000.0 - 3.0 * hole)).abs() < 1e-2, "three holes {three}");
        assert!(three < one, "three holes must remove more than one");
    }

    /// A count of zero (or one) is the single hole, not an empty or a wild
    /// pattern: the parameter arrives from a text field, and "1" is what the
    /// user meant far more often than "make nothing".
    #[test]
    fn a_degenerate_count_is_one_hole() {
        let block = box_soup(0.0, 0.0, 0.0, 20.0, 20.0, 20.0);
        let v = |c: u32| {
            crate::mesh::soup_volume(&subtract_hole_pattern(
                &block, [10.0, 10.0, 20.0], [0.0, 0.0, 1.0], 4.0, 0.0, c, 6.0, 0.05, 256,
            ))
        };
        assert!((v(0) - v(1)).abs() < 1e-6, "count 0 and count 1 must agree");
    }

    /// Spacing zero stacks every instance on the source: the result is one hole,
    /// because N coincident cutters are one cutter (and the boolean says so
    /// instead of producing N coincident walls).
    #[test]
    fn zero_spacing_stacks_into_one_hole() {
        let block = box_soup(0.0, 0.0, 0.0, 20.0, 20.0, 20.0);
        let v = |s: f64| {
            crate::mesh::soup_volume(&subtract_hole_pattern(
                &block, [10.0, 10.0, 20.0], [0.0, 0.0, 1.0], 4.0, 0.0, 4, s, 0.05, 256,
            ))
        };
        let one = crate::mesh::soup_volume(&subtract_hole(
            &block, [10.0, 10.0, 20.0], [0.0, 0.0, 1.0], 4.0, 0.0, 0.05, 256,
        ));
        assert!((v(0.0) - one).abs() < 1e-3, "stacked cutters are one hole");
        assert!(v(6.0) < v(0.0), "spacing must actually separate them");
    }

    /// The table-driven degenerate suite (`ROADMAP` 2.3).
    ///
    /// Every case is an exact volume, because every case is axis-aligned boxes
    /// (and, where a cylinder is involved, the tessellated prism's closed-form
    /// volume). Axis-aligned input is what makes "the answer is 936" checkable
    /// by hand — and the classes below are exactly where the BSP's
    /// epsilon-based classification is known to struggle: coplanar faces,
    /// tangency, containment, slivers, and scale.
    ///
    /// One test, one run, every failure listed: iterating one case at a time
    /// against a 40-second build is how a robustness pass turns into an
    /// afternoon.
    #[test]
    fn degenerate_inputs_all_land_on_their_exact_volumes() {
        struct Case {
            name: &'static str,
            a: Vec<f32>,
            b: Vec<f32>,
            op: u32,
            expect: f64,
            /// Relative tolerance — coplanar cases lose a little to the epsilon.
            tol: f64,
        }
        let b = |x0: f64, y0: f64, z0: f64, x1: f64, y1: f64, z1: f64| box_soup(x0, y0, z0, x1, y1, z1);
        let block = || b(0.0, 0.0, 0.0, 10.0, 10.0, 10.0);
        // A ⌀4 through-cylinder whose *polygon* is inscribed in the circle, so
        // its widest point is 2·cos(π/n) ≈ 1.956 mm from the centre — the
        // tessellated cylinder can never actually reach a tangent plane. These
        // two differ only in whether that edge lands a hair inside or outside
        // the block's x = 0 face, which is the configuration the epsilon has to
        // survive: the answer must be the same either way.
        let just_inside = cylinder_z(1.9560 - 1e-6, 5.0, 2.0, -1.0, 11.0).0;
        let just_outside = cylinder_z(1.9560 + 1e-6, 5.0, 2.0, -1.0, 11.0).0;

        let cases = vec![
            // ---- coplanar faces ------------------------------------------
            Case { name: "shared face, half block", a: block(), b: b(5.0, 0.0, 0.0, 10.0, 10.0, 10.0), op: OP_SUBTRACT, expect: 500.0, tol: 1e-6 },
            Case { name: "partial coplanar: B's ring flush, ends interior", a: block(), b: b(3.0, 0.0, 0.0, 7.0, 10.0, 10.0), op: OP_SUBTRACT, expect: 600.0, tol: 1e-6 },
            Case { name: "pocket flush with the top", a: block(), b: b(2.0, 2.0, 5.0, 8.0, 8.0, 10.0), op: OP_SUBTRACT, expect: 820.0, tol: 1e-6 },
            Case { name: "slab off the top", a: block(), b: b(0.0, 0.0, 5.0, 10.0, 10.0, 10.0), op: OP_SUBTRACT, expect: 500.0, tol: 1e-6 },
            Case { name: "union sharing a whole face", a: block(), b: b(10.0, 0.0, 0.0, 20.0, 10.0, 10.0), op: OP_UNION, expect: 2000.0, tol: 1e-6 },
            Case { name: "union sticking out of the top", a: block(), b: b(2.0, 2.0, 5.0, 8.0, 8.0, 15.0), op: OP_UNION, expect: 1180.0, tol: 1e-6 },
            Case { name: "intersection flush on four sides", a: block(), b: b(3.0, 0.0, 0.0, 7.0, 10.0, 10.0), op: OP_INTERSECT, expect: 400.0, tol: 1e-6 },
            // ---- identical operands --------------------------------------
            Case { name: "A − A", a: block(), b: block(), op: OP_SUBTRACT, expect: 0.0, tol: 0.0 },
            Case { name: "A ∪ A", a: block(), b: block(), op: OP_UNION, expect: 1000.0, tol: 1e-6 },
            Case { name: "A ∩ A", a: block(), b: block(), op: OP_INTERSECT, expect: 1000.0, tol: 1e-6 },
            // ---- tangency ------------------------------------------------
            Case { name: "box touching a face", a: block(), b: b(10.0, 2.0, 2.0, 20.0, 8.0, 8.0), op: OP_SUBTRACT, expect: 1000.0, tol: 1e-6 },
            Case { name: "box touching a face, union", a: block(), b: b(10.0, 2.0, 2.0, 20.0, 8.0, 8.0), op: OP_UNION, expect: 1000.0 + 10.0 * 6.0 * 6.0, tol: 1e-6 },
            Case { name: "box touching a face, intersection", a: block(), b: b(10.0, 2.0, 2.0, 20.0, 8.0, 8.0), op: OP_INTERSECT, expect: 0.0, tol: 0.0 },
            Case { name: "box touching an edge only", a: block(), b: b(10.0, 10.0, 4.0, 20.0, 20.0, 6.0), op: OP_SUBTRACT, expect: 1000.0, tol: 1e-6 },
            Case { name: "box touching a corner only", a: block(), b: b(10.0, 10.0, 10.0, 20.0, 20.0, 20.0), op: OP_SUBTRACT, expect: 1000.0, tol: 1e-6 },
            // ---- containment ---------------------------------------------
            Case { name: "B strictly inside", a: block(), b: b(4.0, 4.0, 4.0, 6.0, 6.0, 6.0), op: OP_SUBTRACT, expect: 992.0, tol: 1e-6 },
            Case { name: "B strictly inside, union", a: block(), b: b(4.0, 4.0, 4.0, 6.0, 6.0, 6.0), op: OP_UNION, expect: 1000.0, tol: 1e-6 },
            Case { name: "B strictly inside, intersection", a: block(), b: b(4.0, 4.0, 4.0, 6.0, 6.0, 6.0), op: OP_INTERSECT, expect: 8.0, tol: 1e-6 },
            // ---- slivers --------------------------------------------------
            Case { name: "slab 0.002 thick", a: block(), b: b(2.0, 0.0, 5.0 - 1e-3, 8.0, 10.0, 5.0 + 1e-3), op: OP_SUBTRACT, expect: 1000.0 - 36.0 * 0.002, tol: 1e-3 },
            // ---- the near-tangency pair that started this pass ------------
            Case { name: "hole edge a hair inside the face", a: block(), b: just_inside, op: OP_SUBTRACT, expect: 1000.0 - prism_volume(2.0, 10.0), tol: 5e-3 },
            Case { name: "hole edge a hair outside the face", a: block(), b: just_outside, op: OP_SUBTRACT, expect: 1000.0 - prism_volume(2.0, 10.0), tol: 5e-3 },
            // ---- scale ----------------------------------------------------
            Case { name: "a thousand times smaller, same answer", a: b(0.0, 0.0, 0.0, 0.01, 0.01, 0.01), b: b(0.002, 0.0, 0.0, 0.006, 0.01, 0.01), op: OP_SUBTRACT, expect: 1e-6 - 4e-7, tol: 1e-6 },
            Case { name: "a thousand times larger, same answer", a: b(0.0, 0.0, 0.0, 10000.0, 10000.0, 10000.0), b: b(2000.0, 0.0, 0.0, 6000.0, 10000.0, 10000.0), op: OP_SUBTRACT, expect: 1e12 - 4e11, tol: 1e-6 },
        ];

        let mut failures: Vec<String> = Vec::new();
        for c in &cases {
            let out = boolean(&c.a, &c.b, c.op);
            let got = crate::mesh::soup_volume(&out);
            let off = (got - c.expect).abs();
            let allowed = c.tol * c.expect.abs().max(1.0);
            if off > allowed {
                failures.push(format!(
                    "{}: volume {got:.6}, expected {:.6} (off by {:.3}%)",
                    c.name,
                    c.expect,
                    if c.expect.abs() > 0.0 { off / c.expect.abs() * 100.0 } else { 100.0 }
                ));
            }
            // Whatever the answer, it must be a *solid*: outward-wound or empty.
            if !out.is_empty() && got < 0.0 {
                failures.push(format!("{}: the result is inside-out", c.name));
            }
        }
        assert!(
            failures.is_empty(),
            "{} of {} degenerate cases failed:\n  {}",
            failures.len(),
            cases.len(),
            failures.join("\n  ")
        );
    }

    /// A grid: 2 × 3 instances remove six prisms, and the second axis genuinely
    /// multiplies the first (four corners of a plate, in the case a user
    /// actually has).
    #[test]
    fn a_grid_of_holes_removes_count_u_times_count_v_prisms() {
        let block = box_soup(0.0, 0.0, 0.0, 40.0, 40.0, 20.0);
        let grid = |cu: u32, cv: u32| {
            subtract_hole_grid(
                &block, [10.0, 10.0, 20.0], [0.0, 0.0, 1.0], 4.0, 0.0, cu, 12.0, cv, 12.0, 0.05, 256,
            )
        };
        let hole = prism_volume(2.0, 20.0);
        let one = crate::mesh::soup_volume(&grid(1, 1));
        let six = crate::mesh::soup_volume(&grid(2, 3));
        assert!((one - (32000.0 - hole)).abs() < 1e-2, "single hole {one}");
        assert!((six - (32000.0 - 6.0 * hole)).abs() < 5e-2, "2×3 grid {six}");
    }

    /// A count of one on either axis collapses that axis: with the point 10 mm
    /// into a 40 mm face and 12 mm spacing, both `3 × 1` and `1 × 3` fit three
    /// prisms entirely inside the block — so both axes must remove the same
    /// amount, whichever direction `perpendicular_basis` sent them.
    #[test]
    fn a_one_wide_grid_removes_one_row_worth() {
        let block = box_soup(0.0, 0.0, 0.0, 40.0, 40.0, 20.0);
        let vol = |cu: u32, cv: u32| {
            crate::mesh::soup_volume(&subtract_hole_grid(
                &block, [10.0, 10.0, 20.0], [0.0, 0.0, 1.0], 4.0, 0.0, cu, 12.0, cv, 12.0, 0.05, 256,
            ))
        };
        let hole = prism_volume(2.0, 20.0);
        assert!((vol(3, 1) - (32000.0 - 3.0 * hole)).abs() < 1e-2, "row along u");
        assert!((vol(1, 3) - (32000.0 - 3.0 * hole)).abs() < 1e-2, "row along v");
    }

    /// Boolean chained on a boolean — the `ROADMAP`'s nesting criterion in
    /// miniature. A block, a vertical bore, then a *crossing* horizontal bore:
    /// the second cut has to work on a mesh the first one produced.
    #[test]
    fn nested_subtractions_stay_stable() {
        let block = box_soup(0.0, 0.0, 0.0, 20.0, 20.0, 20.0);
        let (bore, _) = cylinder_z(10.0, 10.0, 4.0, -1.0, 21.0);
        let step1 = subtract(&block, &bore);
        let v1 = crate::mesh::soup_volume(&step1);
        assert!(v1 > 0.0 && v1 < 8000.0, "first cut volume {v1}");

        // A horizontal bore through the block at z = 12, crossing the vertical
        // one. Its own volume inside the block is ~500, so "smaller by a real
        // amount" is the assertion — a chain that silently did nothing would be
        // off by exactly that.
        let (cross_bore, _) = cylinder_x(-1.0, 21.0, 10.0, 12.0, 3.0);
        let step2 = subtract(&step1, &cross_bore);
        let v2 = crate::mesh::soup_volume(&step2);
        assert!(
            v2 < v1 - 300.0,
            "second cut volume {v2} must be well below the first {v1}"
        );
        assert!(v2 > 0.0, "the block still has material left");
    }
}
