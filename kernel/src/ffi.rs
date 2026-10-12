//! The `#[wasm_bindgen]` surface consumed by the TypeScript front-end.
//!
//! Design notes
//! ------------
//! * Anything that returns a *list* of numbers writes into a caller-provided
//!   growable buffer, so the front-end can amortise allocation across frames
//!   (`VertexBuffer`, `PointBuffer`).
//! * Entity geometry crosses the boundary using a flat, self-describing
//!   encoding (see [`encode_prim`]) rather than a JS object graph — this keeps
//!   the hot path free of `JsValue` churn.
//! * The encoding is:
//!   `[kind, p0, p1, ...]`
//!   `kind` 0 = line (4 numbers), 1 = circle (3), 2 = arc (5),
//!   3 = ellipse (5), 4 = polyline (`closed` flag then 2N numbers).

use wasm_bindgen::prelude::*;

use crate::geom::{Arc, Circle, Ellipse, LineSeg, Polyline, Prim};
use crate::math::{Aabb, Mat3, Vec2};
use crate::query;
use crate::snap::{self, SnapContext, SnapKind, SnapMask};
use crate::split;
use crate::trim;

// ---------------------------------------------------------------------------
// Buffers
// ---------------------------------------------------------------------------

/// A reusable `f32` buffer handed to JS as a view over wasm linear memory.
///
/// The front-end keeps one of these alive and re-fills it each frame; call
/// [`VertexBuffer::as_ptr`] / [`VertexBuffer::len`] to wrap the memory in a
/// `Float32Array` without copying.
#[wasm_bindgen]
pub struct VertexBuffer {
    inner: Vec<f32>,
}

#[wasm_bindgen]
impl VertexBuffer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> VertexBuffer {
        VertexBuffer { inner: Vec::with_capacity(4096) }
    }

    #[wasm_bindgen(getter)]
    pub fn len(&self) -> usize {
        self.inner.len()
    }

    #[wasm_bindgen(getter)]
    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }

    #[wasm_bindgen(getter)]
    pub fn ptr(&self) -> *const f32 {
        self.inner.as_ptr()
    }

    pub fn clear(&mut self) {
        self.inner.clear();
    }

    /// Reserve capacity up-front so a frame never triggers a reallocation
    /// while JS holds a view into the buffer.
    pub fn reserve(&mut self, extra: usize) {
        self.inner.reserve(extra);
    }

    /// Hand the contents back as a fresh `Float32Array`.
    ///
    /// wasm-bindgen's `web` target does not export the linear-memory object, so
    /// JS cannot wrap `ptr()` in a view itself. Returning a `Vec<f32>` makes
    /// wasm-bindgen perform a single bulk copy into a JS-owned array, which is
    /// both correct and much faster than an element-by-element loop.
    pub fn to_f32_array(&self) -> Vec<f32> {
        self.inner.clone()
    }
}

impl Default for VertexBuffer {
    fn default() -> Self {
        Self::new()
    }
}

/// A reusable `f64` buffer, used for point lists (snaps, intersections).
#[wasm_bindgen]
pub struct PointBuffer {
    inner: Vec<f64>,
}

#[wasm_bindgen]
impl PointBuffer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> PointBuffer {
        PointBuffer { inner: Vec::with_capacity(1024) }
    }

    #[wasm_bindgen(getter)]
    pub fn len(&self) -> usize {
        self.inner.len()
    }

    #[wasm_bindgen(getter)]
    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }

    #[wasm_bindgen(getter)]
    pub fn ptr(&self) -> *const f64 {
        self.inner.as_ptr()
    }

    pub fn clear(&mut self) {
        self.inner.clear();
    }

    pub fn reserve(&mut self, extra: usize) {
        self.inner.reserve(extra);
    }

    /// Hand the contents back as a fresh `Float64Array`.
    ///
    /// See [`VertexBuffer::to_f32_array`] for why we copy rather than expose a
    /// pointer: the `web` target does not give JS access to the memory object.
    pub fn to_f64_array(&self) -> Vec<f64> {
        self.inner.clone()
    }
}

impl Default for PointBuffer {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Free-function geometry API
// ---------------------------------------------------------------------------

/// Kernel build identifier, surfaced in the UI status bar.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Tessellate a raw point list into a flat `[x, y, ...]` f32 buffer.
///
/// `closed` appends a segment back to the first vertex.
#[wasm_bindgen]
pub fn tessellate_polyline(coords: &[f64], closed: bool, tol: f64, out: &mut VertexBuffer) {
    let pts: Vec<Vec2> = coords.chunks_exact(2).map(|c| Vec2::new(c[0], c[1])).collect();
    let pl = Polyline::new(pts, closed);
    out.inner.clear();
    pl.tessellate(tol, &mut out.inner);
}

/// Adaptive segment count for an arc, exposed so the UI can show the
/// tessellation density it is about to use.
#[wasm_bindgen]
pub fn arc_segments(sweep: f64, radius: f64, tol: f64, max_seg: u32) -> u32 {
    crate::geom::arc_segment_count(sweep, radius, tol, max_seg)
}

/// Build an arc through three points; returns `[cx, cy, r, start, end]` or an
/// empty vector when the points are collinear.
#[wasm_bindgen]
pub fn arc_through_points(p1x: f64, p1y: f64, p2x: f64, p2y: f64, p3x: f64, p3y: f64) -> Vec<f64> {
    match Arc::from_3_points(Vec2::new(p1x, p1y), Vec2::new(p2x, p2y), Vec2::new(p3x, p3y)) {
        Some(a) => vec![a.center.x, a.center.y, a.radius, a.start_angle, a.end_angle],
        None => Vec::new(),
    }
}

/// Circle through three points; returns `[cx, cy, r]` or empty.
#[wasm_bindgen]
pub fn circle_through_points(p1x: f64, p1y: f64, p2x: f64, p2y: f64, p3x: f64, p3y: f64) -> Vec<f64> {
    match Arc::from_3_points(Vec2::new(p1x, p1y), Vec2::new(p2x, p2y), Vec2::new(p3x, p3y)) {
        Some(a) => vec![a.center.x, a.center.y, a.radius],
        None => Vec::new(),
    }
}

/// Area, perimeter and bounds of an encoded primitive, in one call:
/// `[area, perimeter, min_x, min_y, max_x, max_y]`.
#[wasm_bindgen]
pub fn measure(encoded: &[f64]) -> Vec<f64> {
    let prim = match decode_prim(encoded) {
        Some(p) => p,
        None => return vec![0.0; 6],
    };
    let b = prim.bounds();
    let (area, perim) = match &prim {
        Prim::Circle(c) => (core::f64::consts::PI * c.radius * c.radius, core::f64::consts::TAU * c.radius),
        Prim::Ellipse(e) => (core::f64::consts::PI * e.rx * e.ry, ellipse_perimeter(e.rx, e.ry)),
        Prim::Polyline(p) => {
            let pts = if p.closed && p.points.len() >= 3 {
                p.points.clone()
            } else {
                p.points.clone()
            };
            (pl_area(&pts, p.closed), p.total_length())
        }
        Prim::Arc(a) => (0.0, a.radius * a.sweep()),
        Prim::Line(l) => (0.0, l.length()),
    };
    vec![area, perim, b.min_x, b.min_y, b.max_x, b.max_y]
}

fn pl_area(pts: &[Vec2], closed: bool) -> f64 {
    if !closed || pts.len() < 3 {
        return 0.0;
    }
    query::signed_area(pts).abs()
}

/// Ramanujan's second approximation for an ellipse perimeter.
fn ellipse_perimeter(a: f64, b: f64) -> f64 {
    let h = ((a - b) / (a + b)).powi(2);
    core::f64::consts::PI * (a + b) * (1.0 + 3.0 * h / (10.0 + (4.0 - 3.0 * h).sqrt()))
}

// ---------------------------------------------------------------------------
// Entity-level batch API
// ---------------------------------------------------------------------------

/// Tessellate a whole scene in one call.
///
/// Input: a flat array of encoded primitives concatenated one after another
/// (the front-end builds this once per frame from its entity list).
/// Output: a `VertexBuffer` of `[x, y]` pairs, plus a `Vec<u32>` "strip index"
/// array (returned separately) telling the renderer where each entity begins
/// and ends inside the vertex stream.
#[wasm_bindgen]
pub struct SceneTessellator {
    verts: Vec<f32>,
    strips: Vec<u32>,
    tol: f64,
    max_seg: u32,
}

#[wasm_bindgen]
impl SceneTessellator {
    #[wasm_bindgen(constructor)]
    pub fn new(tol: f64, max_seg: u32) -> SceneTessellator {
        SceneTessellator {
            verts: Vec::with_capacity(1 << 16),
            strips: Vec::with_capacity(4096),
            tol,
            max_seg,
        }
    }

    pub fn set_tolerance(&mut self, tol: f64, max_seg: u32) {
        self.tol = tol;
        self.max_seg = max_seg;
    }

    /// `counts[i]` is how many numbers make up encoded primitive `i`.
    pub fn tessellate(&mut self, encoded: &[f64], counts: &[u32]) {
        self.verts.clear();
        self.strips.clear();
        let mut cursor = 0usize;
        for &cnt in counts {
            let end = cursor + cnt as usize;
            if end > encoded.len() {
                break;
            }
            let start_v = self.verts.len() as u32 / 2;
            if let Some(prim) = decode_prim(&encoded[cursor..end]) {
                prim.tessellate(self.tol, self.max_seg, &mut self.verts);
            }
            let end_v = self.verts.len() as u32 / 2;
            self.strips.push(start_v);
            self.strips.push(end_v);
            cursor = end;
        }
    }

    #[wasm_bindgen(getter)]
    pub fn vertex_ptr(&self) -> *const f32 {
        self.verts.as_ptr()
    }

    #[wasm_bindgen(getter)]
    pub fn vertex_len(&self) -> usize {
        self.verts.len()
    }

    /// The tessellated vertex stream as a fresh `Float32Array`.
    ///
    /// Preferred over `vertex_ptr()`: the wasm-bindgen `web` target does not
    /// hand JS the linear-memory object, so a bare pointer is unusable there.
    /// wasm-bindgen copies a returned `Vec<f32>` into a JS-owned array in one
    /// bulk memcpy.
    pub fn vertex_array(&self) -> Vec<f32> {
        self.verts.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn strips(&self) -> Vec<u32> {
        self.strips.clone()
    }
}

/// Hit-test a scene against a probe point.
///
/// Returns the index of the nearest entity within `tol`, or `-1`.
#[wasm_bindgen]
pub fn pick(encoded: &[f64], counts: &[u32], px: f64, py: f64, tol: f64, _max_seg: u32) -> i32 {
    let p = Vec2::new(px, py);
    let mut best_d = f64::INFINITY;
    let mut best_idx: i32 = -1;
    let mut cursor = 0usize;
    for (i, &cnt) in counts.iter().enumerate() {
        let end = cursor + cnt as usize;
        if end > encoded.len() {
            break;
        }
        if let Some(prim) = decode_prim(&encoded[cursor..end]) {
            if prim.bounds().expanded(tol).contains(p) {
                let d = prim.distance_to(p);
                if d <= tol && d < best_d {
                    best_d = d;
                    best_idx = i as i32;
                }
            }
        }
        cursor = end;
    }
    best_idx
}

/// Hit-test every entity and write `(index, distance)` pairs into a buffer.
#[wasm_bindgen]
pub fn pick_all(encoded: &[f64], counts: &[u32], px: f64, py: f64, tol: f64, _max_seg: u32) -> Vec<f64> {
    let p = Vec2::new(px, py);
    let mut hits: Vec<(usize, f64)> = Vec::new();
    let mut cursor = 0usize;
    for (i, &cnt) in counts.iter().enumerate() {
        let end = cursor + cnt as usize;
        if end > encoded.len() {
            break;
        }
        if let Some(prim) = decode_prim(&encoded[cursor..end]) {
            if prim.bounds().expanded(tol).contains(p) {
                let d = prim.distance_to(p);
                if d <= tol {
                    hits.push((i, d));
                }
            }
        }
        cursor = end;
    }
    hits.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(core::cmp::Ordering::Equal));
    hits.into_iter().flat_map(|(i, d)| [i as f64, d]).collect()
}

/// Everything inside an axis-aligned window (crossing/window selection).
///
/// Returns the indices of the entities whose bounds are fully contained
/// (`crossing = false`) or at least touched (`crossing = true`).
#[wasm_bindgen]
pub fn select_in_rect(
    encoded: &[f64],
    counts: &[u32],
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
    crossing: bool,
) -> Vec<u32> {
    let win = Aabb::new(min_x.min(max_x), min_y.min(max_y), min_x.max(max_x), min_y.max(max_y));
    let mut out = Vec::new();
    let mut cursor = 0usize;
    for (i, &cnt) in counts.iter().enumerate() {
        let end = cursor + cnt as usize;
        if end > encoded.len() {
            break;
        }
        if let Some(prim) = decode_prim(&encoded[cursor..end]) {
            let b = prim.bounds();
            let touched = crossing
                && b.intersects(&win)
                && !(b.max_x < win.min_x
                    || b.min_x > win.max_x
                    || b.max_y < win.min_y
                    || b.min_y > win.max_y);
            let contained = b.min_x >= win.min_x
                && b.min_y >= win.min_y
                && b.max_x <= win.max_x
                && b.max_y <= win.max_y;
            if (crossing && touched) || (!crossing && contained) {
                out.push(i as u32);
            }
        }
        cursor = end;
    }
    out
}

/// Intersections between every pair of entities in the scene.
///
/// Output is a flat `[entity_a, entity_b, x, y, ...]` array — used by the
/// "intersection" snap layer and by the future trim/extend tools.
#[wasm_bindgen]
pub fn all_intersections(encoded: &[f64], counts: &[u32], tol: f64, max_seg: u32) -> Vec<f64> {
    let prims = decode_all(encoded, counts);
    let mut out = Vec::new();
    for i in 0..prims.len() {
        for j in (i + 1)..prims.len() {
            if !prims[i].bounds().expanded(tol).intersects(&prims[j].bounds()) {
                continue;
            }
            for p in query::intersect(&prims[i], &prims[j], tol, max_seg) {
                out.extend_from_slice(&[i as f64, j as f64, p.x, p.y]);
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------

/// One snap candidate as exported to JS.
#[wasm_bindgen]
pub struct SnapResult {
    pub x: f64,
    pub y: f64,
    pub kind: u8,
    pub entity: u32,
    pub distance: f64,
}

#[wasm_bindgen]
impl SnapResult {
    #[wasm_bindgen(getter)]
    pub fn has_value(&self) -> bool {
        self.kind != 255
    }
}

/// Full snap query. Returns the single best candidate (or a sentinel with
/// `kind == 255` when nothing was found).
///
/// `kind_mask` is a bitfield mirroring [`SnapKind`]; `has_from`/`from_x`/`from_y`
/// supply the base point for perpendicular and tangent snaps.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn snap_query(
    encoded: &[f64],
    counts: &[u32],
    cursor_x: f64,
    cursor_y: f64,
    tol: f64,
    kind_mask: u32,
    has_from: bool,
    from_x: f64,
    from_y: f64,
    _max_seg: u32,
) -> SnapResult {
    let prims = decode_all(encoded, counts);
    let ids: Vec<u32> = (0..prims.len() as u32).collect();
    let ctx = SnapContext { from: if has_from { Some(Vec2::new(from_x, from_y)) } else { None } };
    let cands = snap::collect(
        &prims,
        &ids,
        Vec2::new(cursor_x, cursor_y),
        tol,
        &SnapMask(kind_mask),
        &ctx,
    );
    match snap::best_candidate(&cands) {
        Some(c) => SnapResult {
            x: c.point.x,
            y: c.point.y,
            kind: c.kind as u8,
            entity: c.entity,
            distance: c.distance,
        },
        None => SnapResult { x: cursor_x, y: cursor_y, kind: 255, entity: u32::MAX, distance: f64::INFINITY },
    }
}

/// Every snap candidate within tolerance, written into a `PointBuffer` as
/// `[x, y, kind, entity, ...]` quintuples. Used to draw all markers, not just
/// the winner.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn snap_candidates(
    encoded: &[f64],
    counts: &[u32],
    cursor_x: f64,
    cursor_y: f64,
    tol: f64,
    kind_mask: u32,
    has_from: bool,
    from_x: f64,
    from_y: f64,
    out: &mut PointBuffer,
) {
    let prims = decode_all(encoded, counts);
    let ids: Vec<u32> = (0..prims.len() as u32).collect();
    let ctx = SnapContext { from: if has_from { Some(Vec2::new(from_x, from_y)) } else { None } };
    let cands = snap::collect(
        &prims,
        &ids,
        Vec2::new(cursor_x, cursor_y),
        tol,
        &SnapMask(kind_mask),
        &ctx,
    );
    out.inner.clear();
    for c in cands {
        out.inner.push(c.point.x);
        out.inner.push(c.point.y);
        out.inner.push(c.kind as u8 as f64);
        out.inner.push(c.entity as f64);
        out.inner.push(c.distance);
    }
}

/// Apply a grid + polar constraint to a raw cursor position.
///
/// `mode` 0 = off, 1 = grid only, 2 = ortho (90°), 3 = polar (30° increments).
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn apply_constraints(
    cursor_x: f64,
    cursor_y: f64,
    mode: u32,
    grid_step: f64,
    has_from: bool,
    from_x: f64,
    from_y: f64,
    polar_tol: f64,
) -> Vec<f64> {
    let mut p = Vec2::new(cursor_x, cursor_y);
    if mode == 1 && grid_step > 1e-12 {
        p = snap::snap_to_grid(p, grid_step);
    }
    if mode >= 2 {
        if let Some(from) = if has_from { Some(Vec2::new(from_x, from_y)) } else { None } {
            let angles: Vec<f64> = if mode == 2 {
                vec![0.0, core::f64::consts::FRAC_PI_2, core::f64::consts::PI, 4.712388980384690]
            } else {
                (0..12).map(|i| i as f64 * core::f64::consts::PI / 6.0).collect()
            };
            p = snap::constrain_polar(from, p, &angles, polar_tol);
        }
    }
    vec![p.x, p.y]
}

/// Snap-kind values re-exported so TypeScript never hardcodes the mapping.
#[wasm_bindgen]
pub fn snap_kind_values() -> Vec<u8> {
    vec![
        SnapKind::Endpoint as u8,
        SnapKind::Midpoint as u8,
        SnapKind::Center as u8,
        SnapKind::Quadrant as u8,
        SnapKind::Perpendicular as u8,
        SnapKind::Nearest as u8,
        SnapKind::Intersection as u8,
        SnapKind::Tangent as u8,
        SnapKind::Grid as u8,
    ]
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

/// Apply an affine transform (given as `[a, b, c, d, e, f]`) to an encoded
/// primitive, returning the transformed encoding.
///
/// Circular and elliptical primitives would need a full conic re-fit after a
/// non-uniform transform; the front-end only ever applies rigid (translate /
/// rotate) or uniform-scale transforms to them, so we handle the axis-aligned
/// and uniform cases exactly and fall back to a similarity approximation
/// otherwise.
#[wasm_bindgen]
pub fn transform_prim(encoded: &[f64], m: &[f64]) -> Vec<f64> {
    if m.len() < 6 {
        return encoded.to_vec();
    }
    let mat = Mat3::new(m[0], m[1], m[2], m[3], m[4], m[5]);
    let Some(prim) = decode_prim(encoded) else {
        return encoded.to_vec();
    };
    encode_prim(&map_prim(&prim, &mat))
}

/// Apply a transform to a whole scene at once.
#[wasm_bindgen]
pub fn transform_scene(encoded: &[f64], counts: &[u32], m: &[f64]) -> Vec<f64> {
    if m.len() < 6 {
        return encoded.to_vec();
    }
    let mat = Mat3::new(m[0], m[1], m[2], m[3], m[4], m[5]);
    let mut out = Vec::with_capacity(encoded.len());
    let mut cursor = 0usize;
    for &cnt in counts {
        let end = cursor + cnt as usize;
        if end > encoded.len() {
            break;
        }
        match decode_prim(&encoded[cursor..end]) {
            Some(p) => out.extend_from_slice(&encode_prim(&map_prim(&p, &mat))),
            None => {}
        }
        cursor = end;
    }
    out
}

fn map_prim(p: &Prim, m: &Mat3) -> Prim {
    match p {
        Prim::Line(l) => Prim::Line(LineSeg::new(m.apply(l.a), m.apply(l.b))),
        Prim::Polyline(pl) => Prim::Polyline(Polyline::new(
            pl.points.iter().map(|p| m.apply(*p)).collect(),
            pl.closed,
        )),
        Prim::Circle(c) => {
            let center = m.apply(c.center);
            let radius = c.radius * m.approx_scale();
            Prim::Circle(Circle::new(center, radius))
        }
        Prim::Arc(a) => {
            let center = m.apply(a.center);
            let radius = a.radius * m.approx_scale();
            // Rotate the start/end angles by the transform's rotation component.
            let rot = m.b.atan2(m.a);
            Prim::Arc(Arc::new(center, radius, a.start_angle + rot, a.end_angle + rot))
        }
        Prim::Ellipse(e) => {
            let center = m.apply(e.center);
            let rot = m.b.atan2(m.a);
            let sx = (m.a * m.a + m.b * m.b).sqrt();
            let sy = (m.c * m.c + m.d * m.d).sqrt();
            Prim::Ellipse(Ellipse::new(center, e.rx * sx, e.ry * sy, e.rotation + rot))
        }
    }
}

/// Offset a primitive by a signed distance, using the tessellated normal
/// approximation — the basis of the future OFFSET command.
#[wasm_bindgen]
pub fn offset_prim(encoded: &[f64], distance: f64, tol: f64, max_seg: u32) -> Vec<f64> {
    let Some(prim) = decode_prim(encoded) else {
        return encoded.to_vec();
    };
    match &prim {
        Prim::Circle(c) => encode_prim(&Prim::Circle(Circle::new(c.center, (c.radius + distance).max(1e-9)))),
        Prim::Arc(a) => {
            let r = (a.radius + distance).max(1e-9);
            encode_prim(&Prim::Arc(Arc::new(a.center, r, a.start_angle, a.end_angle)))
        }
        Prim::Line(l) => {
            let n = l.dir().perp() * distance;
            encode_prim(&Prim::Line(LineSeg::new(l.a + n, l.b + n)))
        }
        other => {
            let segs = other.to_segments(tol, max_seg);
            let mut pts: Vec<Vec2> = Vec::with_capacity(segs.len() + 1);
            if let Some(first) = segs.first() {
                pts.push(first.a);
            }
            // Miter-join the offset segments.
            for w in segs.windows(2) {
                let n1 = w[0].dir().perp();
                let n2 = w[1].dir().perp();
                let p1 = w[0].b + n1 * distance;
                let p2 = w[0].b + n2 * distance;
                // Intersect the two offset lines to find the miter point.
                let o1 = LineSeg::new(w[0].a + n1 * distance, w[0].b + n1 * distance);
                let o2 = LineSeg::new(w[1].a + n2 * distance, w[1].b + n2 * distance);
                let miter = o1
                    .intersect(&o2)
                    .map(|(_, _, p)| p)
                    .unwrap_or(p1.lerp(p2, 0.5));
                pts.push(miter);
            }
            if let Some(last) = segs.last() {
                let n = last.dir().perp();
                pts.push(last.b + n * distance);
            }
            encode_prim(&Prim::Polyline(Polyline::new(pts, matches!(other, Prim::Polyline(p) if p.closed))))
        }
    }
}

/// Closed-form fillet between two segments: returns `[cx, cy, r, t1, t2]`
/// where `t1`/`t2` are the tangent points, or empty when the segments are
/// parallel. Radius is clamped to whatever the corner can actually host.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn fillet(
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
    cx: f64,
    cy: f64,
    dx: f64,
    dy: f64,
    radius: f64,
) -> Vec<f64> {
    let s1 = LineSeg::new(Vec2::new(ax, ay), Vec2::new(bx, by));
    let s2 = LineSeg::new(Vec2::new(cx, cy), Vec2::new(dx, dy));
    let v1 = s1.dir();
    let v2 = s2.dir();
    let cross = v1.cross(v2);
    if cross.abs() < 1e-12 {
        return Vec::new();
    }
    // Corner is where the two supporting lines meet.
    let ext1 = LineSeg::new(s1.a, s1.a + v1 * 1e6);
    let ext2 = LineSeg::new(s2.a, s2.a + v2 * 1e6);
    let corner = match ext1.intersect(&ext2) {
        Some((_, _, p)) => p,
        None => return Vec::new(),
    };

    // Unit direction along each *line* pointing away from the corner (i.e.
    // towards the segment the user actually drew). We pick whichever of the
    // two segment endpoints is farther from the corner and aim at it.
    let far1 = if s1.a.distance_to(corner) >= s1.b.distance_to(corner) { s1.a } else { s1.b };
    let far2 = if s2.a.distance_to(corner) >= s2.b.distance_to(corner) { s2.a } else { s2.b };
    let d1 = (far1 - corner).normalized();
    let d2 = (far2 - corner).normalized();

    // Interior half-angle between the two outward rays.
    let cos_theta = d1.dot(d2).clamp(-1.0, 1.0);
    let theta = cos_theta.acos();
    let half = (theta * 0.5).clamp(1e-6, core::f64::consts::FRAC_PI_2 - 1e-6);

    // Tangent points sit `radius / tan(half)` back along each ray.
    let tan_len = radius / half.tan();
    let t1 = corner + d1 * tan_len;
    let t2 = corner + d2 * tan_len;

    // Centre lies on the angle bisector at `radius / sin(half)` from the corner.
    let bisector = (d1 + d2).normalized();
    let dist_to_center = radius / half.sin();
    let center = corner + bisector * dist_to_center;

    vec![center.x, center.y, radius, t1.x, t1.y, t2.x, t2.y]
}

// ---------------------------------------------------------------------------
// Trim
// ---------------------------------------------------------------------------

/// Outcome tags for [`trim_target`], shared with `src/core/trim.ts`.
pub const TRIM_PIECES: f64 = 0.0;
pub const TRIM_NO_CUTS: f64 = 1.0;
pub const TRIM_OFF_TARGET: f64 = 2.0;
pub const TRIM_UNSUPPORTED: f64 = 3.0;

/// Cut `target_index` in `scene` back to its cutting edges at the click point.
///
/// `cutters` holds scene indices. They must exclude the target itself: passing a
/// target as its own cutting edge makes it intersect itself everywhere, which
/// would shred it into a pile of slivers. Such entries are dropped here rather
/// than trusted to the caller, because the one place this is reachable is a
/// click handler and a mistake there is not obvious.
///
/// Returns `[tag, count, ...geometry]` where `count` primitives follow,
/// concatenated in the usual wire format. The front end replaces the target
/// entity with them. An empty geometry list with `TRIM_PIECES` means "the
/// clicked piece was all of it" — a legitimate delete.
#[wasm_bindgen]
pub fn trim_target(
    encoded: &[f64],
    counts: &[u32],
    target_index: u32,
    cutters: &[u32],
    px: f64,
    py: f64,
    tol: f64,
    max_seg: u32,
    aperture: f64,
) -> Vec<f64> {
    let scene = decode_all(encoded, counts);
    let target = match scene.get(target_index as usize) {
        Some(p) => p,
        None => return vec![TRIM_OFF_TARGET],
    };
    let cutter_prims: Vec<Prim> = cutters
        .iter()
        .map(|i| *i as usize)
        .filter(|i| *i != target_index as usize)
        .filter_map(|i| scene.get(i).cloned())
        .collect();

    match trim::trim(target, &cutter_prims, Vec2::new(px, py), tol, max_seg, aperture) {
        trim::TrimOutcome::Pieces(pieces) => {
            let mut out = vec![TRIM_PIECES, pieces.len() as f64];
            for p in &pieces {
                out.extend_from_slice(&encode_prim(p));
            }
            out
        }
        trim::TrimOutcome::NoCuts => vec![TRIM_NO_CUTS],
        trim::TrimOutcome::OffTarget => vec![TRIM_OFF_TARGET],
        trim::TrimOutcome::Unsupported => vec![TRIM_UNSUPPORTED],
    }
}

/// The vertices of the piece that a click would remove, for the hover preview.
///
/// Returns a flat `[x, y, …]` list; empty means "nothing to highlight", which is
/// not an error — the cursor may simply not be over anything trimmable.
#[wasm_bindgen]
pub fn trim_preview(
    encoded: &[f64],
    counts: &[u32],
    target_index: u32,
    cutters: &[u32],
    px: f64,
    py: f64,
    tol: f64,
    max_seg: u32,
    aperture: f64,
) -> Vec<f32> {
    let scene = decode_all(encoded, counts);
    let target = match scene.get(target_index as usize) {
        Some(p) => p,
        None => return Vec::new(),
    };
    let cutter_prims: Vec<Prim> = cutters
        .iter()
        .map(|i| *i as usize)
        .filter(|i| *i != target_index as usize)
        .filter_map(|i| scene.get(i).cloned())
        .collect();
    trim::preview_points(
        target,
        &cutter_prims,
        Vec2::new(px, py),
        tol,
        max_seg,
        aperture,
    )
}

// ---------------------------------------------------------------------------
// Split
// ---------------------------------------------------------------------------

/// Break every primitive in `scene` at its intersection points.
///
/// Each unordered pair of primitives is intersected **once** and the resulting
/// point is handed to both sides, so an N-entity scene costs one intersection
/// test per pair rather than one per (target, cutter) combination.
///
/// Returns `[groups, (index, count, ...prims) × groups]`. Only entities that
/// actually came apart appear: an entity nothing crosses is simply absent, which
/// is what lets the front end tell "nothing to split" (an empty array) from
/// "split into pieces" without a second call.
#[wasm_bindgen]
pub fn split_scene(encoded: &[f64], counts: &[u32], tol: f64, max_seg: u32) -> Vec<f64> {
    let prims = decode_all(encoded, counts);
    let n = prims.len();

    // Crossings per entity, filled by the pairwise pass below.
    let mut crossings: Vec<Vec<Vec2>> = vec![Vec::new(); n];
    for i in 0..n {
        let bi = prims[i].bounds();
        for j in (i + 1)..n {
            // Cheap reject first: `intersect` falls back to tessellating both
            // operands for the mixed cases, which is not something to do for
            // every pair in a large drawing.
            if !bi.expanded(tol).intersects(&prims[j].bounds()) {
                continue;
            }
            for p in query::intersect(&prims[i], &prims[j], tol, max_seg) {
                crossings[i].push(p);
                crossings[j].push(p);
            }
        }
    }

    // `[entityIndex, pieceCount, ...wire prims]` per entity that split.
    let mut groups: Vec<Vec<f64>> = Vec::new();
    for i in 0..n {
        if let split::SplitOutcome::Pieces(pieces) = split::split_at_points(&prims[i], &crossings[i]) {
            let mut g = vec![i as f64, pieces.len() as f64];
            for p in &pieces {
                g.extend_from_slice(&encode_prim(p));
            }
            groups.push(g);
        }
    }

    let total: usize = groups.iter().map(|g| g.len()).sum();
    let mut out = Vec::with_capacity(1 + total);
    out.push(groups.len() as f64);
    for g in groups {
        out.extend_from_slice(&g);
    }
    out
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/// Encode a primitive into the flat wire format documented at the top of this
/// module. Exposed directly so TypeScript can validate its own encoder.
#[wasm_bindgen]
pub fn encode(encoded_in: &[f64]) -> Vec<f64> {
    match decode_prim(encoded_in) {
        Some(p) => encode_prim(&p),
        None => Vec::new(),
    }
}

pub fn encode_prim(p: &Prim) -> Vec<f64> {
    match p {
        Prim::Line(l) => vec![0.0, l.a.x, l.a.y, l.b.x, l.b.y],
        Prim::Circle(c) => vec![1.0, c.center.x, c.center.y, c.radius],
        Prim::Arc(a) => vec![2.0, a.center.x, a.center.y, a.radius, a.start_angle, a.end_angle],
        Prim::Ellipse(e) => vec![3.0, e.center.x, e.center.y, e.rx, e.ry, e.rotation],
        Prim::Polyline(pl) => {
            // `[4, closed, vertexCount, x, y, …]`.
            //
            // The vertex count is not decoration: a flat reply such as
            // `trim_target`'s `[tag, pieceCount, …pieces]` concatenates whole
            // primitives with no side channel for their lengths, so a polyline
            // that does not state its own size can only be delimited by "read
            // to the end of the buffer" — which silently swallows every piece
            // after the first. Stating the count makes a polyline
            // self-delimiting and lets a reader of any flat run advance past it
            // correctly. (The packaged *input* scene keeps a parallel `counts`
            // array and so never needed this, which is exactly how the output
            // side drifted.)
            let mut v = Vec::with_capacity(3 + pl.points.len() * 2);
            v.push(4.0);
            v.push(if pl.closed { 1.0 } else { 0.0 });
            v.push(pl.points.len() as f64);
            for pt in &pl.points {
                v.push(pt.x);
                v.push(pt.y);
            }
            v
        }
    }
}

pub fn decode_prim(buf: &[f64]) -> Option<Prim> {
    if buf.is_empty() {
        return None;
    }
    match buf[0] as i32 {
        0 if buf.len() >= 5 => Some(Prim::Line(LineSeg::new(
            Vec2::new(buf[1], buf[2]),
            Vec2::new(buf[3], buf[4]),
        ))),
        1 if buf.len() >= 4 => Some(Prim::Circle(Circle::new(Vec2::new(buf[1], buf[2]), buf[3]))),
        2 if buf.len() >= 6 => Some(Prim::Arc(Arc::new(
            Vec2::new(buf[1], buf[2]),
            buf[3],
            buf[4],
            buf[5],
        ))),
        3 if buf.len() >= 6 => Some(Prim::Ellipse(Ellipse::new(
            Vec2::new(buf[1], buf[2]),
            buf[3],
            buf[4],
            buf[5],
        ))),
        4 if buf.len() >= 3 => {
            let closed = buf[1] != 0.0;
            // `buf[2]` is the vertex count (see `encode_prim`). Clamp it to what
            // the slice actually holds so a truncated/hostile buffer degrades to
            // fewer points rather than reading past the end.
            let n = (buf[2].max(0.0) as usize).min(buf.len().saturating_sub(3) / 2);
            let pts: Vec<Vec2> = (0..n)
                .map(|i| Vec2::new(buf[3 + i * 2], buf[4 + i * 2]))
                .collect();
            Some(Prim::Polyline(Polyline::new(pts, closed)))
        }
        _ => None,
    }
}

pub fn decode_all(encoded: &[f64], counts: &[u32]) -> Vec<Prim> {
    let mut out = Vec::with_capacity(counts.len());
    let mut cursor = 0usize;
    for &cnt in counts {
        let end = cursor + cnt as usize;
        if end > encoded.len() {
            break;
        }
        if let Some(p) = decode_prim(&encoded[cursor..end]) {
            out.push(p);
        }
        cursor = end;
    }
    out
}

/// How many numbers a given primitive kind needs in its encoding — lets the
/// TypeScript side pre-size its arrays.
#[wasm_bindgen]
pub fn encoding_size(encoded: &[f64]) -> u32 {
    if encoded.is_empty() {
        return 0;
    }
    match encoded[0] as i32 {
        0 => 5,
        1 => 4,
        2 => 6,
        3 => 6,
        4 => encoded.len() as u32,
        _ => 0,
    }
}

/// Geometric extent of an encoded primitive: `[min_x, min_y, max_x, max_y]`.
#[wasm_bindgen]
pub fn bounds_of(encoded: &[f64]) -> Vec<f64> {
    match decode_prim(encoded) {
        Some(p) => {
            let b = p.bounds();
            vec![b.min_x, b.min_y, b.max_x, b.max_y]
        }
        None => vec![0.0, 0.0, 0.0, 0.0],
    }
}

/// Distance from a point to an encoded primitive.
#[wasm_bindgen]
pub fn distance_to(encoded: &[f64], px: f64, py: f64) -> f64 {
    match decode_prim(encoded) {
        Some(p) => p.distance_to(Vec2::new(px, py)),
        None => f64::INFINITY,
    }
}

/// Closest point on an encoded primitive: `[x, y]`.
#[wasm_bindgen]
pub fn closest_point(encoded: &[f64], px: f64, py: f64) -> Vec<f64> {
    match decode_prim(encoded) {
        Some(p) => {
            let c = p.closest_point_of(Vec2::new(px, py));
            vec![c.x, c.y]
        }
        None => vec![],
    }
}

// ---------------------------------------------------------------------------
// Parametric constraints
// ---------------------------------------------------------------------------

/// Decode the flat constraint list.
///
/// Layout, **eight** numbers per constraint:
/// `[kind, aEntity, aPointKind, aPointIndex, bEntity, bPointKind, bPointIndex, value]`
///
/// `bEntity < 0` means "no second entity" (the single-entity kinds). `value` is
/// the target for the dimensional kinds (distance / angle / radius / diameter)
/// and is ignored by the purely geometric ones. Unknown `kind` values are
/// skipped rather than rejected, so a front-end that knows a constraint this
/// kernel does not yet implement simply gets it ignored instead of losing the
/// whole solve.
fn decode_constraints(buf: &[f64]) -> Vec<crate::constraints::Constraint> {
    use crate::constraints::{Constraint, ConstraintKind, Target};

    let mut out = Vec::with_capacity(buf.len() / 8);
    for chunk in buf.chunks_exact(8) {
        let kind = match ConstraintKind::from_tag(chunk[0]) {
            Some(k) => k,
            None => continue,
        };
        // A NaN/∞ target would poison every later evaluation through the
        // finite-difference Jacobian; dropping the constraint is the honest
        // reading of "this dimension does not mean anything".
        if !chunk[7].is_finite() {
            continue;
        }
        let a = Target {
            entity: chunk[1].max(0.0) as usize,
            point_kind: chunk[2].max(0.0) as u8,
            point_index: chunk[3].max(0.0) as usize,
        };
        let b = if chunk[4] < 0.0 {
            None
        } else {
            Some(Target {
                entity: chunk[4] as usize,
                point_kind: chunk[5].max(0.0) as u8,
                point_index: chunk[6].max(0.0) as usize,
            })
        };
        out.push(Constraint { kind, a, b, value: chunk[7] });
    }
    out
}

/// Re-solve the parametric constraints and return the repaired geometry.
///
/// Input
/// -----
/// * `encoded` / `counts` — the scene, in exactly the encoding [`decode_all`]
///   expects (the same one the renderer already builds every frame), so the
///   front-end never has to maintain a second geometry representation.
/// * `constraints` — flat list, **eight** numbers each; see [`decode_constraints`].
/// * `moving` — one flag per primitive: may the solver move it? Primitives
///   without a flag, or flagged `0`, are constants. This is how a caller scopes
///   a repair to the curves the user actually touched.
///
/// Output
/// ------
/// `[ok, iterations, max_residual, ...geometry]` — a three-number header
/// followed by the same concatenated encoding that came in (the `counts` are
/// unchanged, so the caller can slice it back with the layout it already has).
///
/// An **empty** return means "do not use this": either a primitive failed to
/// decode, or nothing was worth solving. The caller keeps its current geometry
/// in that case, which is the only safe reading — a partially decoded scene
/// would silently shift every entity after the failure.
#[wasm_bindgen]
pub fn solve_constraints(
    encoded: &[f64],
    counts: &[u32],
    constraints: &[f64],
    moving: &[u8],
) -> Vec<f64> {
    let prims = decode_all(encoded, counts);
    if prims.len() != counts.len() {
        return Vec::new();
    }
    let cs = decode_constraints(constraints);
    if cs.is_empty() {
        return Vec::new();
    }

    let flags: Vec<bool> = (0..prims.len())
        .map(|i| moving.get(i).copied().unwrap_or(0) != 0)
        .collect();

    let out = crate::constraints::solve(&prims, &flags, &cs);

    let mut result = Vec::with_capacity(encoded.len() + 3);
    result.push(if out.converged { 1.0 } else { 0.0 });
    result.push(out.iterations as f64);
    result.push(out.max_residual);
    for p in &out.prims {
        result.extend_from_slice(&encode_prim(p));
    }
    result
}

// ---------------------------------------------------------------------------
// Extrusion (3D)
// ---------------------------------------------------------------------------

/// Pull a closed 2D sketch along a datum plane's normal into flat-shaded
/// triangles.
///
/// `frame` is the plane's `origin, u, v` (nine floats); the normal is their
/// cross product, so the front end never has to ship one. An absent or
/// degenerate frame falls back to the XY plane, which is what every caller
/// wanted before datum planes existed.
///
/// Wire: `[vertexCount, (x, y, z, nx, ny, nz) × vertexCount]`. **Non-indexed** —
/// three vertices per triangle, so each face can carry its own normal without
/// an index buffer. A `vertexCount` of `0` means "not a closed region" (a lone
/// line or arc has no interior), which the front end reports as such rather
/// than as a failure.
#[wasm_bindgen]
pub fn extrude_mesh(
    encoded: &[f64],
    counts: &[u32],
    height: f64,
    frame: &[f64],
    tol: f64,
    max_seg: u32,
) -> Vec<f32> {
    let prims = decode_all(encoded, counts);
    let fr = crate::mesh::Frame::from_slice(frame).unwrap_or_else(crate::mesh::Frame::xy);
    let mut m = crate::mesh::Mesh::new(fr);
    if let Some(first) = prims.first() {
        if let Some(loop_pts) = crate::mesh::closed_loop(first, tol, max_seg) {
            m = crate::mesh::extrude(&loop_pts, height, &fr);
        }
    }
    let mut out: Vec<f32> = Vec::with_capacity(1 + m.verts.len());
    out.push(m.vertex_count() as f32);
    out.extend_from_slice(&m.verts);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line_enc() -> Vec<f64> {
        encode_prim(&Prim::Line(LineSeg::new(Vec2::new(0.0, 0.0), Vec2::new(10.0, 0.0))))
    }

    #[test]
    fn encode_decode_roundtrip_line() {
        let e = line_enc();
        assert_eq!(e, vec![0.0, 0.0, 0.0, 10.0, 0.0]);
        match decode_prim(&e).unwrap() {
            Prim::Line(l) => assert_eq!(l.b, Vec2::new(10.0, 0.0)),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn encode_decode_roundtrip_polyline() {
        let pl = Polyline::new(vec![Vec2::new(0.0, 0.0), Vec2::new(1.0, 2.0)], true);
        let e = encode_prim(&Prim::Polyline(pl));
        // `[tag, closed, vertexCount, x, y, …]`.
        assert_eq!(e[0], 4.0);
        assert_eq!(e[1], 1.0);
        assert_eq!(e[2], 2.0, "vertex count must be stated");
        assert_eq!(e.len(), 3 + 2 * 2);
        match decode_prim(&e).unwrap() {
            Prim::Polyline(p) => {
                assert!(p.closed);
                assert_eq!(p.points.len(), 2);
                assert_eq!(p.points[1], Vec2::new(1.0, 2.0));
            }
            _ => panic!("wrong variant"),
        }
    }

    /// A flat run needs no side channel of lengths: each polyline states its own
    /// size, so several decode independently. Before the count was in the wire
    /// format, a reader had to consume to the end of the buffer — which made the
    /// first polyline swallow every later piece, so a trimmed/split polyline
    /// came back as a single (wrong) entity instead of three.
    #[test]
    fn decode_flat_run_of_two_polylines() {
        let a = encode_prim(&Prim::Polyline(Polyline::new(
            vec![Vec2::new(0.0, 0.0), Vec2::new(1.0, 0.0)],
            false,
        )));
        let b = encode_prim(&Prim::Polyline(Polyline::new(
            vec![Vec2::new(2.0, 0.0), Vec2::new(3.0, 0.0), Vec2::new(4.0, 1.0)],
            false,
        )));
        let mut run = a.clone();
        run.extend_from_slice(&b);

        // Decoding the *whole* flat buffer must still yield only the first
        // polyline — the second is not mistaken for extra vertices.
        match decode_prim(&run).unwrap() {
            Prim::Polyline(p) => assert_eq!(p.points.len(), 2, "must stop at its own count"),
            _ => panic!("expected a polyline"),
        }
        // Stepping over the first by its own size lands exactly on the second.
        match decode_prim(&run[a.len()..]).unwrap() {
            Prim::Polyline(p) => {
                assert_eq!(p.points.len(), 3);
                assert_eq!(p.points[2], Vec2::new(4.0, 1.0));
            }
            _ => panic!("expected a polyline"),
        }
        assert_eq!(a.len(), 3 + 2 * 2);
        assert_eq!(b.len(), 3 + 2 * 3);
    }

    #[test]
    fn pick_finds_entity_within_tolerance() {
        let enc = line_enc();
        let counts = vec![encoding_size(&enc)];
        assert_eq!(pick(&enc, &counts, 5.0, 0.2, 0.5, 128), 0);
        assert_eq!(pick(&enc, &counts, 5.0, 5.0, 0.5, 128), -1);
    }

    #[test]
    fn transform_translates_and_rotates_lines() {
        let enc = line_enc();
        // Translate by (5, 3).
        let moved = transform_prim(&enc, &[1.0, 0.0, 0.0, 1.0, 5.0, 3.0]);
        match decode_prim(&moved).unwrap() {
            Prim::Line(l) => {
                assert!((l.a.x - 5.0).abs() < 1e-9 && (l.a.y - 3.0).abs() < 1e-9);
                assert!((l.b.x - 15.0).abs() < 1e-9);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn transform_preserves_circle_radius_under_rigid_motion() {
        let c = encode_prim(&Prim::Circle(Circle::new(Vec2::new(0.0, 0.0), 7.0)));
        // `mul` applies the right-hand matrix first, so this translates (3, 4)
        // and *then* rotates by 0.9 rad about the origin.
        let m = Mat3::rotation(0.9).mul(&Mat3::translation(Vec2::new(3.0, 4.0)));
        let out = transform_prim(&c, &[m.a, m.b, m.c, m.d, m.e, m.f]);
        let expect = Mat3::rotation(0.9).apply(Vec2::new(3.0, 4.0));
        match decode_prim(&out).unwrap() {
            Prim::Circle(cc) => {
                assert!((cc.radius - 7.0).abs() < 1e-9, "radius drifted: {}", cc.radius);
                assert!((cc.center.x - expect.x).abs() < 1e-9, "cx = {}", cc.center.x);
                assert!((cc.center.y - expect.y).abs() < 1e-9, "cy = {}", cc.center.y);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn select_window_vs_crossing() {
        let enc: Vec<f64> = line_enc();
        let counts = vec![encoding_size(&enc)];
        // Window fully containing the line.
        let inside = select_in_rect(&enc, &counts, -1.0, -1.0, 11.0, 1.0, false);
        assert_eq!(inside, vec![0]);
        // Window touching but not containing → only crossing picks it up.
        let win = (-5.0, -1.0, 2.0, 1.0);
        assert!(select_in_rect(&enc, &counts, win.0, win.1, win.2, win.3, false).is_empty());
        assert_eq!(select_in_rect(&enc, &counts, win.0, win.1, win.2, win.3, true), vec![0]);
    }

    #[test]
    fn offset_circle_grows_radius() {
        let c = encode_prim(&Prim::Circle(Circle::new(Vec2::new(0.0, 0.0), 5.0)));
        let out = offset_prim(&c, 2.0, 0.01, 128);
        match decode_prim(&out).unwrap() {
            Prim::Circle(cc) => assert!((cc.radius - 7.0).abs() < 1e-9),
            _ => panic!(),
        }
    }

    #[test]
    fn offset_line_shifts_perpendicularly() {
        let enc = line_enc();
        // Positive offset should move along +Y for a left-to-right line
        // (perp of (1,0) is (0,1)).
        let out = offset_prim(&enc, 3.0, 0.01, 128);
        match decode_prim(&out).unwrap() {
            Prim::Line(l) => {
                assert!((l.a.y - 3.0).abs() < 1e-9);
                assert!((l.b.y - 3.0).abs() < 1e-9);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn measure_returns_sane_values() {
        let c = encode_prim(&Prim::Circle(Circle::new(Vec2::new(0.0, 0.0), 2.0)));
        let m = measure(&c);
        assert!((m[0] - core::f64::consts::PI * 4.0).abs() < 1e-9);
        assert!((m[1] - core::f64::consts::PI * 4.0).abs() < 1e-9);
        assert!((m[4] - 2.0).abs() < 1e-9);
    }

    #[test]
    fn scene_tessellator_emits_strips() {
        let enc = line_enc();
        let circle = encode_prim(&Prim::Circle(Circle::new(Vec2::new(50.0, 50.0), 10.0)));
        let mut combined = enc.clone();
        combined.extend_from_slice(&circle);
        let counts = vec![encoding_size(&enc), encoding_size(&circle)];
        let mut t = SceneTessellator::new(0.05, 256);
        t.tessellate(&combined, &counts);
        // Line = 2 verts; circle = n+1 verts where n >= 2.
        assert!(t.verts.len() >= 4 + 6);
        assert_eq!(t.strips.len(), 4);
        assert_eq!(t.strips[0], 0);
        assert_eq!(t.strips[1], 2);
    }

    #[test]
    fn pick_all_orders_by_distance() {
        let a = encode_prim(&Prim::Line(LineSeg::new(Vec2::new(0.0, 0.0), Vec2::new(10.0, 0.0))));
        let b = encode_prim(&Prim::Line(LineSeg::new(Vec2::new(0.0, 0.3), Vec2::new(10.0, 0.3))));
        let mut combined = a.clone();
        combined.extend_from_slice(&b);
        let counts = vec![encoding_size(&a), encoding_size(&b)];
        let hits = pick_all(&combined, &counts, 5.0, 0.05, 1.0, 128);
        assert_eq!(hits.len(), 4);
        assert_eq!(hits[0], 0.0); // entity 0 is closer
        assert_eq!(hits[2], 1.0);
    }

    #[test]
    fn all_intersections_reports_pairs() {
        let a = encode_prim(&Prim::Line(LineSeg::new(Vec2::new(0.0, 0.0), Vec2::new(10.0, 10.0))));
        let b = encode_prim(&Prim::Line(LineSeg::new(Vec2::new(0.0, 10.0), Vec2::new(10.0, 0.0))));
        let mut combined = a.clone();
        combined.extend_from_slice(&b);
        let counts = vec![encoding_size(&a), encoding_size(&b)];
        let out = all_intersections(&combined, &counts, 0.01, 64);
        assert_eq!(out.len(), 4);
        assert!((out[2] - 5.0).abs() < 1e-9 && (out[3] - 5.0).abs() < 1e-9);
    }

    #[test]
    fn snap_query_returns_endpoint() {
        let enc = line_enc();
        let counts = vec![encoding_size(&enc)];
        let r = snap_query(&enc, &counts, 0.1, 0.1, 1.0, 0xFFFF, false, 0.0, 0.0, 128);
        assert!(r.has_value());
        assert_eq!(r.kind, SnapKind::Endpoint as u8);
        assert!(r.x.abs() < 1e-9 && r.y.abs() < 1e-9);
    }

    #[test]
    fn snap_query_sentinel_when_nothing_near() {
        let enc = line_enc();
        let counts = vec![encoding_size(&enc)];
        let r = snap_query(&enc, &counts, 500.0, 500.0, 1.0, 0xFFFF, false, 0.0, 0.0, 128);
        assert!(!r.has_value());
        assert_eq!(r.kind, 255);
    }

    #[test]
    fn constraints_grid_then_ortho() {
        let out = apply_constraints(4.4, 9.6, 1, 5.0, false, 0.0, 0.0, 0.1);
        assert!((out[0] - 5.0).abs() < 1e-9);
        assert!((out[1] - 10.0).abs() < 1e-9);
    }

    #[test]
    fn bounds_of_arc_is_tight() {
        let a = encode_prim(&Prim::Arc(Arc::new(Vec2::new(0.0, 0.0), 5.0, 0.0, core::f64::consts::PI)));
        let b = bounds_of(&a);
        assert!((b[0] + 5.0).abs() < 1e-9);
        assert!((b[2] - 5.0).abs() < 1e-9);
    }

    #[test]
    fn encoding_size_matches_encoder() {
        let e = line_enc();
        assert_eq!(encoding_size(&e), e.len() as u32);
        let c = encode_prim(&Prim::Circle(Circle::new(Vec2::new(0.0, 0.0), 1.0)));
        assert_eq!(encoding_size(&c), 4);
    }

    #[test]
    fn fillet_between_perpendicular_lines() {
        // Two segments meeting at the origin: one along +X, one along +Y.
        let r = fillet(10.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 10.0, 2.0);
        assert_eq!(r.len(), 7);
        let (cx, cy, radius) = (r[0], r[1], r[2]);
        assert!((radius - 2.0).abs() < 1e-9);
        // Centre should sit on the bisector at (2, 2).
        assert!((cx - 2.0).abs() < 1e-6, "cx = {}", cx);
        assert!((cy - 2.0).abs() < 1e-6, "cy = {}", cy);
    }

    #[test]
    fn fillet_rejects_parallel() {
        let r = fillet(0.0, 0.0, 10.0, 0.0, 0.0, 5.0, 10.0, 5.0, 2.0);
        assert!(r.is_empty());
    }
}
