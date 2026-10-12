//! Trim: cut a target primitive back to its intersection with a set of
//! "cutting edges".
//!
//! The interaction is the familiar one — pick the cutting edges, then click on
//! the piece of the target you want gone. This module is the whole of it.
//!
//! # How a primitive is cut
//!
//! Every target is reduced to a **scalar parameter** `u ∈ [0, 1]` running along
//! it (a line's `t`, an arc's normalised sweep angle, a polyline's cumulative
//! arc length). An intersection with a cutting edge is a point, and every point
//! on a curve has exactly one `u`. Collect those, sort them, and they partition
//! the target into intervals. The interval containing the click is the one the
//! user is pointing at; it is dropped and **all the others are kept**.
//!
//! Splitting on intervals rather than "delete from A to B" is what makes the
//! repeated-click case work: trimming a line that three boundaries cross keeps
//! the far pieces instead of silently deleting everything between the two
//! nearest ones.
//!
//! # Deliberate limitation: ellipses
//!
//! A trimmed ellipse would be an *elliptical arc*, and this kernel has no such
//! primitive — a partial ellipse cannot be represented as an `Ellipse` without
//! lying about its extent. Rather than silently emitting a polyline
//! approximation (which changes the entity's type underneath the user, breaks
//! its properties panel, and cannot be exported back as an ellipse), trim
//! reports `Unsupported` and the front-end says so.
//!
//! # A kept piece keeps the target's direction
//!
//! The piece that wraps through `u = 0` (a circle trimmed at one point) is
//! returned with correct start/end angles and the direction intact. Reversing
//! it would flip the arc's own sweep, which is a different thing entirely.

use crate::geom::{Arc, LineSeg, Polyline, Prim};
use crate::math::Vec2;
use crate::query;

const TAU: f64 = core::f64::consts::TAU;

/// Two `u` values closer than this are the same cut point.
const PARAM_EPS: f64 = 1e-9;

/// A piece shorter than this (in model units) is dropped rather than becoming a
/// degenerate entity that renders as a speck and cannot be picked again.
const MIN_PIECE: f64 = 1e-9;

pub enum TrimOutcome {
    /// The pieces that survive. May legitimately be empty (the clicked interval
    /// was the whole target), and may hold more than one piece.
    Pieces(Vec<Prim>),
    /// No cutting edge crosses the target — there is nothing to cut against.
    NoCuts,
    /// The click is further than `aperture` from the target.
    OffTarget,
    /// See the module comment.
    Unsupported,
}

/// Where the click landed, in target-parameter space.
pub struct TrimHit {
    /// `u` of the click along the target, clamped to `[0, 1]`.
    pub param: f64,
    /// Distance from the click to the curve.
    pub distance: f64,
}

// ---------------------------------------------------------------------------
// Parameterisation
// ---------------------------------------------------------------------------

/// Cumulative arc length at each polyline vertex, plus the total.
fn polyline_lengths(pl: &Polyline) -> (Vec<f64>, f64) {
    let mut cum = vec![0.0f64];
    let mut total = 0.0;
    for i in 0..pl.segment_count() {
        if let Some(s) = pl.segment(i) {
            total += s.length();
        }
        cum.push(total);
    }
    (cum, total)
}

/// The point at parameter `u ∈ [0, 1]`.
fn point_at(prim: &Prim, u: f64) -> Vec2 {
    let u = u.clamp(0.0, 1.0);
    match prim {
        Prim::Line(l) => l.a.lerp(l.b, u),
        Prim::Arc(a) => {
            let ang = a.start_angle + a.sweep() * u;
            a.center + Vec2::new(ang.cos(), ang.sin()) * a.radius
        }
        Prim::Circle(c) => c.center + Vec2::new((TAU * u).cos(), (TAU * u).sin()) * c.radius,
        Prim::Polyline(pl) => {
            let (_, total) = polyline_lengths(pl);
            polyline_point_at(pl, u * total)
        }
        Prim::Ellipse(e) => e.point_at(TAU * u),
    }
}

/// The point a polyline reaches at arc length `d` from its first vertex.
fn polyline_point_at(pl: &Polyline, d: f64) -> Vec2 {
    let (cum, total) = polyline_lengths(pl);
    if total <= MIN_PIECE {
        return pl.points[0];
    }
    let d = d.clamp(0.0, total);
    for i in 0..pl.segment_count() {
        let len = cum[i + 1] - cum[i];
        if d <= cum[i + 1] || i == pl.segment_count() - 1 {
            let t = if len <= MIN_PIECE {
                0.0
            } else {
                ((d - cum[i]) / len).clamp(0.0, 1.0)
            };
            return pl.points[i].lerp(pl.points[(i + 1) % pl.points.len()], t);
        }
    }
    pl.points[0]
}

/// Where `p` sits on `prim`, and how far it is from the curve.
pub fn locate(prim: &Prim, p: Vec2) -> Option<TrimHit> {
    match prim {
        Prim::Line(l) => {
            if l.length() <= MIN_PIECE {
                return None;
            }
            let (_, t) = l.closest_on_line(p);
            Some(TrimHit { param: t.clamp(0.0, 1.0), distance: l.distance_to(p) })
        }

        Prim::Arc(a) => {
            if a.radius <= MIN_PIECE || a.sweep() <= 1e-12 {
                return None;
            }
            let v = p - a.center;
            let len = v.length();
            if len <= 1e-18 {
                return Some(TrimHit { param: 0.0, distance: a.radius });
            }
            let rel = crate::math::normalize_angle(v.angle() - a.start_angle);
            let sweep = a.sweep();
            // Outside the sweep: clamp to whichever end is nearer, so a click
            // just past the arc's end still trims that end rather than snapping
            // to the far one.
            let u = if rel <= sweep {
                rel / sweep
            } else {
                let over_end = TAU - rel;
                if over_end <= rel - sweep {
                    1.0
                } else {
                    0.0
                }
            };
            Some(TrimHit { param: u, distance: (len - a.radius).abs() })
        }

        Prim::Circle(c) => {
            if c.radius <= MIN_PIECE {
                return None;
            }
            let v = p - c.center;
            let len = v.length();
            if len <= 1e-18 {
                return Some(TrimHit { param: 0.0, distance: c.radius });
            }
            Some(TrimHit {
                param: crate::math::normalize_angle(v.angle()) / TAU,
                distance: (len - c.radius).abs(),
            })
        }

        Prim::Polyline(pl) => {
            let (cum, total) = polyline_lengths(pl);
            if pl.points.len() < 2 || total <= MIN_PIECE {
                return None;
            }
            let (cp, seg, dist) = query::polyline_closest(pl, p);
            // The offset **within** the segment, not just the segment's start.
            // Two cutting edges can both cross one segment, which makes that
            // segment span several intervals — reporting only `cum[seg]` would
            // put every click on it in the interval *before* the first cut, so
            // clicking the middle of the segment would trim the wrong piece.
            let within = (cp - pl.points[seg]).length();
            Some(TrimHit {
                param: ((cum[seg] + within) / total).clamp(0.0, 1.0),
                distance: dist,
            })
        }

        // See the module comment.
        Prim::Ellipse(_) => None,
    }
}

// ---------------------------------------------------------------------------
// Slicing
// ---------------------------------------------------------------------------

/// The sub-primitive between `u0` and `u1`, or `None` if degenerate.
///
/// Assumes `u0 < u1`. A span covering a whole `Circle` returns `None`: the front
/// end has no "ellipse arc" primitive either, and an `Arc` with a zero sweep
/// would render as a speck that cannot be picked again.
// `slice` and `cut_params` are shared with [`crate::split`], which cuts a target
// at the *same* parameters and keeps **all** the resulting pieces instead of
// dropping one. Having one parameterisation for both operations is the whole
// reason they cannot drift apart.
pub(crate) fn slice(prim: &Prim, u0: f64, u1: f64) -> Option<Prim> {
    let span = u1 - u0;
    if !(span > PARAM_EPS) {
        return None;
    }
    match prim {
        Prim::Line(l) => {
            // Interpolate the endpoints directly rather than going through
            // `point_at`: on a line those are the same two numbers, and reading
            // them off `l` says so instead of making the reader wonder why the
            // bound line went unused.
            let a = l.a.lerp(l.b, u0);
            let b = l.a.lerp(l.b, u1);
            if (b - a).length() <= MIN_PIECE {
                return None;
            }
            Some(Prim::Line(LineSeg::new(a, b)))
        }
        Prim::Arc(a) => {
            let s0 = a.start_angle + a.sweep() * u0;
            let s1 = a.start_angle + a.sweep() * u1;
            if a.radius * (s1 - s0) <= MIN_PIECE {
                return None;
            }
            Some(Prim::Arc(Arc::new(a.center, a.radius, s0, s1)))
        }
        Prim::Circle(c) => {
            let sweep = TAU * span;
            if c.radius * sweep <= MIN_PIECE {
                return None;
            }
            // No full-turn guard is needed, and that is worth spelling out: an
            // interval spanning the whole circle would need `[0, 1]`, which
            // requires the cut set to contain nothing at all — and `trim`
            // returns `NoCuts` before it ever gets here. So a `Circle` slice is
            // always a genuine arc, never a circle wearing an arc's clothes.
            let a0 = TAU * u0;
            Some(Prim::Arc(Arc::new(c.center, c.radius, a0, a0 + sweep)))
        }
        Prim::Polyline(pl) => {
            let pts = polyline_slice(pl, u0, u1);
            if pts.len() < 2 {
                return None;
            }
            Some(Prim::Polyline(Polyline::new(pts, false)))
        }
        Prim::Ellipse(_) => None,
    }
}

/// Vertex list of the polyline between `u0` and `u1`, cut points included.
fn polyline_slice(pl: &Polyline, u0: f64, u1: f64) -> Vec<Vec2> {
    let (cum, total) = polyline_lengths(pl);
    if total <= MIN_PIECE || pl.points.len() < 2 {
        return Vec::new();
    }
    let d0 = u0.clamp(0.0, 1.0) * total;
    let d1 = u1.clamp(0.0, 1.0) * total;
    let prim = Prim::Polyline(pl.clone());

    let mut pts = vec![point_at(&prim, u0)];
    for i in 0..pl.segment_count() {
        // A vertex belongs to the slice only when its *own* arc-length
        // `cum[i+1]` is strictly inside `(d0, d1)` — that is the vertex being
        // pushed, so it is the one that must be tested. Testing `cum[i]` (the
        // segment's start) instead let a vertex that sits past `d1` slip in
        // whenever its segment started before `d1`, so a slice of the first half
        // of a two-vertex polyline came back as `[start, farEnd, cutPoint]` — a
        // polyline that runs out to the far end and doubles back. `MIN_PIECE`
        // rather than an exact compare so a vertex that *is* the cut point does
        // not get duplicated into the slice (its `point_at(u1)` is appended
        // separately below).
        if cum[i + 1] > d0 + MIN_PIECE && cum[i + 1] < d1 - MIN_PIECE {
            pts.push(pl.points[(i + 1) % pl.points.len()]);
        }
    }
    pts.push(point_at(&prim, u1));
    pts
}

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

/// Every parameter at which `target` meets any cutting edge, sorted, endpoints
/// included, coincident values collapsed.
pub(crate) fn cut_params(target: &Prim, cutters: &[Prim], tol: f64, max_seg: u32) -> Vec<f64> {
    let points: Vec<Vec2> = cutters
        .iter()
        .flat_map(|c| query::intersect(target, c, tol, max_seg))
        .collect();
    cut_params_from_points(target, &points)
}

/// The same partition, from intersection points the caller already has.
///
/// Splitting exists so a scene-level pass can find each *pair* of intersections
/// once and hand both entities their cut points, instead of each target
/// re-deriving its own crossings and doing every intersection twice.
pub(crate) fn cut_params_from_points(target: &Prim, points: &[Vec2]) -> Vec<f64> {
    let mut params = vec![0.0, 1.0];
    for pt in points {
        if let Some(h) = locate(target, *pt) {
            params.push(h.param);
        }
    }
    params.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
    let mut out: Vec<f64> = Vec::with_capacity(params.len());
    for p in params {
        if out.last().map_or(true, |last: &f64| (p - last).abs() > PARAM_EPS) {
            out.push(p);
        }
    }
    out
}

/// Index of the interval containing `click`.
///
/// The intervals are `[params[i], params[i+1]]`. A click exactly on a cut point
/// belongs to the interval *after* it, so repeatedly trimming at the same spot
/// eats the drawing away steadily instead of alternating between two answers.
fn victim_index(params: &[f64], click: f64) -> usize {
    for i in 0..params.len() - 1 {
        let (a, b) = (params[i], params[i + 1]);
        if click >= a - PARAM_EPS && click < b - PARAM_EPS {
            return i;
        }
    }
    params.len() - 2
}

/// Trim `target` at `click`, keeping every piece except the one under it.
pub fn trim(
    target: &Prim,
    cutters: &[Prim],
    click: Vec2,
    tol: f64,
    max_seg: u32,
    aperture: f64,
) -> TrimOutcome {
    if matches!(target, Prim::Ellipse(_)) {
        return TrimOutcome::Unsupported;
    }
    let hit = match locate(target, click) {
        Some(h) if h.distance <= aperture => h,
        Some(_) => return TrimOutcome::OffTarget,
        // Not reachable for an ellipse (checked above) — this arm is the
        // degenerate cases: a zero-length line, a one-point polyline. There is
        // no parameter to cut along, so there is nothing to say but "no".
        None => return TrimOutcome::NoCuts,
    };

    let params = cut_params(target, cutters, tol, max_seg);
    // Only the two endpoints: nothing crosses this target.
    if params.len() <= 2 {
        return TrimOutcome::NoCuts;
    }

    let victim = victim_index(&params, hit.param);
    let mut pieces = Vec::with_capacity(params.len() - 1);
    for i in 0..params.len() - 1 {
        if i == victim {
            continue;
        }
        if let Some(p) = slice(target, params[i], params[i + 1]) {
            pieces.push(p);
        }
    }
    TrimOutcome::Pieces(pieces)
}

/// Which interval a click would remove, as `u` bounds — for the hover preview.
///
/// Returns `None` when the preview cannot be drawn (unsupported target, click
/// off the curve, or no cutting edge crosses it), which the front end treats as
/// "do not highlight anything" rather than as an error.
pub fn preview_span(
    target: &Prim,
    cutters: &[Prim],
    click: Vec2,
    tol: f64,
    max_seg: u32,
    aperture: f64,
) -> Option<(f64, f64)> {
    if matches!(target, Prim::Ellipse(_)) {
        return None;
    }
    let hit = locate(target, click)?;
    if hit.distance > aperture {
        return None;
    }
    let params = cut_params(target, cutters, tol, max_seg);
    if params.len() <= 2 {
        return None;
    }
    let i = victim_index(&params, hit.param);
    Some((params[i], params[i + 1]))
}

/// The piece that would be removed, tessellated — so the front end can draw the
/// preview through the same overlay batch as everything else instead of
/// re-implementing slicing in TypeScript.
///
/// Returns a flat `[x, y, x, y, …]` list, or an empty one when there is nothing
/// to preview.
pub fn preview_points(
    target: &Prim,
    cutters: &[Prim],
    click: Vec2,
    tol: f64,
    max_seg: u32,
    aperture: f64,
) -> Vec<f32> {
    let (a, b) = match preview_span(target, cutters, click, tol, max_seg, aperture) {
        Some(v) => v,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    match target {
        // Polygonal targets, vertex-exact: sampling them would only add points
        // that are not on the curve.
        Prim::Line(l) => {
            let p0 = l.a.lerp(l.b, a);
            let p1 = l.a.lerp(l.b, b);
            out.push(p0.x as f32);
            out.push(p0.y as f32);
            out.push(p1.x as f32);
            out.push(p1.y as f32);
        }
        Prim::Polyline(pl) => {
            for p in polyline_slice(pl, a, b) {
                out.push(p.x as f32);
                out.push(p.y as f32);
            }
        }
        // Arcs and circle slices: sample by the same sagitta rule the renderer
        // uses, so the preview hugs the curve it is about to cut.
        Prim::Arc(arc) => {
            let sweep = arc.sweep() * (b - a);
            let n = crate::geom::arc_segment_count(sweep, arc.radius, tol, max_seg).max(1);
            for i in 0..=n {
                let ang = arc.start_angle + sweep * (i as f64 / n as f64);
                let p = arc.center + Vec2::new(ang.cos(), ang.sin()) * arc.radius;
                out.push(p.x as f32);
                out.push(p.y as f32);
            }
        }
        Prim::Circle(c) => {
            let sweep = TAU * (b - a);
            let n = crate::geom::arc_segment_count(sweep, c.radius, tol, max_seg).max(1);
            for i in 0..=n {
                let ang = TAU * a + sweep * (i as f64 / n as f64);
                let p = c.center + Vec2::new(ang.cos(), ang.sin()) * c.radius;
                out.push(p.x as f32);
                out.push(p.y as f32);
            }
        }
        Prim::Ellipse(_) => {}
    }
    out
}

// ---------------------------------------------------------------------------
// Tests — the kernel half of "what is drawn red is what gets cut"
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::{LineSeg, Prim};
    use crate::math::Vec2;

    /// Horizontal target `(0,0) → (10,0)`; a vertical cutter at `x` splits it.
    fn line_target() -> Prim {
        Prim::Line(LineSeg::new(Vec2::new(0.0, 0.0), Vec2::new(10.0, 0.0)))
    }
    fn vertical_cutter(x: f64) -> Prim {
        Prim::Line(LineSeg::new(Vec2::new(x, -5.0), Vec2::new(x, 5.0)))
    }

    /// Parameter interval a kept `LineSeg` piece covers, for the `(0,0)→(10,0)` target.
    fn line_param(prim: &Prim) -> (f64, f64) {
        match prim {
            Prim::Line(l) => (l.a.x / 10.0, l.b.x / 10.0),
            _ => panic!("expected a line piece"),
        }
    }

    /// The preview must highlight exactly the interval the trim removes. This is
    /// the kernel guarantee behind the destructive-tool rule "preview == action":
    /// if `preview_span` and `trim` ever disagree, the red highlight lies about
    /// what the click will delete.
    #[test]
    fn preview_interval_is_the_removed_interval() {
        let target = line_target();
        let cutter = vertical_cutter(5.0);
        let (tol, max_seg, ap) = (1e-9, 64u32, 1.0);

        // Click the LEFT half → preview [0, 0.5], trim keeps [0.5, 1].
        let click = Vec2::new(2.5, 0.0);
        let span = preview_span(&target, &[cutter.clone()], click, tol, max_seg, ap)
            .expect("preview should resolve");
        let TrimOutcome::Pieces(pieces) = trim(&target, &[cutter.clone()], click, tol, max_seg, ap)
        else {
            panic!("trim should produce pieces");
        };
        assert!((span.0 - 0.0).abs() < 1e-9 && (span.1 - 0.5).abs() < 1e-9, "left preview = {span:?}");
        assert_eq!(pieces.len(), 1, "left click keeps one piece");
        let p = line_param(&pieces[0]);
        assert!((p.0 - 0.5).abs() < 1e-9 && (p.1 - 1.0).abs() < 1e-9, "kept piece = {p:?}");

        // Click the RIGHT half → preview [0.5, 1], trim keeps [0, 0.5].
        let click = Vec2::new(7.5, 0.0);
        let span = preview_span(&target, &[cutter.clone()], click, tol, max_seg, ap)
            .expect("preview should resolve");
        let TrimOutcome::Pieces(pieces) = trim(&target, &[cutter.clone()], click, tol, max_seg, ap)
        else {
            panic!("trim should produce pieces");
        };
        assert!((span.0 - 0.5).abs() < 1e-9 && (span.1 - 1.0).abs() < 1e-9, "right preview = {span:?}");
        assert_eq!(pieces.len(), 1);
        let p = line_param(&pieces[0]);
        assert!((p.0 - 0.0).abs() < 1e-9 && (p.1 - 0.5).abs() < 1e-9, "kept piece = {p:?}");
    }

    /// Three cutters at x = 2, 5, 8 → four intervals. Clicking the 2nd keeps the
    /// other three; the preview must be exactly the 2nd interval that was removed.
    #[test]
    fn preview_matches_cut_with_three_cutters() {
        let target = line_target();
        let cutters = [vertical_cutter(2.0), vertical_cutter(5.0), vertical_cutter(8.0)];
        let (tol, max_seg, ap) = (1e-9, 64u32, 1.0);

        let click = Vec2::new(3.0, 0.0); // inside [0.2, 0.5]
        let span = preview_span(&target, &cutters, click, tol, max_seg, ap).expect("preview");
        let TrimOutcome::Pieces(pieces) = trim(&target, &cutters, click, tol, max_seg, ap) else {
            panic!("trim should produce pieces");
        };
        // The removed interval is the 2nd: [0.2, 0.5].
        assert!((span.0 - 0.2).abs() < 1e-9 && (span.1 - 0.5).abs() < 1e-9, "preview = {span:?}");
        // Kept pieces cover [0,0.2] ∪ [0.5,0.8] ∪ [0.8,1].
        let mut ps: Vec<(f64, f64)> = pieces.iter().map(line_param).collect();
        ps.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        assert_eq!(ps.len(), 3, "three pieces kept");
        assert!((ps[0].0 - 0.0).abs() < 1e-9 && (ps[0].1 - 0.2).abs() < 1e-9);
        assert!((ps[1].0 - 0.5).abs() < 1e-9 && (ps[1].1 - 0.8).abs() < 1e-9);
        assert!((ps[2].0 - 0.8).abs() < 1e-9 && (ps[2].1 - 1.0).abs() < 1e-9);
    }

    /// A polyline slice must contain *only* the vertices strictly between the
    /// two cut parameters. It used to test the segment's start (`cum[i]`) rather
    /// than the vertex's own position (`cum[i+1]`), so a vertex past the end of
    /// the slice slipped in and the "first half" of a two-vertex polyline came
    /// back as `[start, farEnd, cut]` — geometry that runs to the far end and
    /// doubles back.
    #[test]
    fn polyline_slice_keeps_only_interior_vertices() {
        let pl = Polyline::new(
            vec![Vec2::new(0.0, 0.0), Vec2::new(4.0, 0.0), Vec2::new(8.0, 0.0)],
            false,
        );
        // [2, 6] along the arc → the middle vertex (x=4) is the only interior one.
        let pts = polyline_slice(&pl, 0.25, 0.75);
        assert_eq!(pts.len(), 3, "one interior vertex: {pts:?}");
        assert!((pts[0].x - 2.0).abs() < 1e-9);
        assert!((pts[1].x - 4.0).abs() < 1e-9);
        assert!((pts[2].x - 6.0).abs() < 1e-9);

        // A vertex that *is* the cut point must not be duplicated into the slice.
        let pts = polyline_slice(&pl, 0.0, 0.5);
        assert_eq!(pts.len(), 2, "boundary vertex not duplicated: {pts:?}");
        assert!((pts[0].x - 0.0).abs() < 1e-9 && (pts[1].x - 4.0).abs() < 1e-9);
    }

    #[test]
    fn polyline_slice_of_first_half_does_not_run_to_far_end() {
        let pl = Polyline::new(vec![Vec2::new(0.0, 0.0), Vec2::new(10.0, 0.0)], false);
        let pts = polyline_slice(&pl, 0.0, 0.3);
        assert_eq!(pts.len(), 2, "start→cut only, not start→farEnd→cut: {pts:?}");
        assert!((pts[0].x - 0.0).abs() < 1e-9 && (pts[1].x - 3.0).abs() < 1e-9);
    }

    /// The end-to-end polyline case: a target polyline crossed by two cutters is
    /// trimmed into two clean sub-polylines (this is the shape the front end
    /// decodes, and the shape that was broken for anything but a line).
    #[test]
    fn trim_polyline_between_two_cutters_keeps_two_clean_pieces() {
        let target = Prim::Polyline(Polyline::new(
            vec![Vec2::new(0.0, 0.0), Vec2::new(10.0, 0.0)],
            false,
        ));
        let cutters = [vertical_cutter(3.0), vertical_cutter(7.0)];
        let (tol, max_seg, ap) = (1e-9, 64u32, 1.0);
        let TrimOutcome::Pieces(pieces) =
            trim(&target, &cutters, Vec2::new(5.0, 0.0), tol, max_seg, ap)
        else {
            panic!("trim should produce pieces");
        };
        assert_eq!(pieces.len(), 2, "two pieces kept");
        let mut spans: Vec<(f64, f64)> = pieces
            .iter()
            .map(|p| match p {
                Prim::Polyline(pl) => (pl.points[0].x, pl.points[pl.points.len() - 1].x),
                _ => panic!("expected polyline pieces"),
            })
            .collect();
        spans.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        assert!((spans[0].0 - 0.0).abs() < 1e-9 && (spans[0].1 - 3.0).abs() < 1e-9, "left {spans:?}");
        assert!((spans[1].0 - 7.0).abs() < 1e-9 && (spans[1].1 - 10.0).abs() < 1e-9, "right {spans:?}");
    }
}