//! Split: break primitives apart at their intersection points.
//!
//! Where [`crate::trim`] cuts a target and throws one piece away, this module
//! cuts a target at **every** crossing and keeps **all** of the pieces. It is the
//! "break at intersection" operation — the thing you want after importing a
//! drawing whose lines run straight through each other and cannot be grabbed
//! separately.
//!
//! # Why it is not a second parameterisation
//!
//! Trimming already reduces a primitive to a scalar `u ∈ [0, 1]` and partitions
//! it at its intersections. Decomposition wants exactly the same cut points and
//! exactly the same sub-primitives, differing only in what happens to the
//! intervals. So it reuses `trim::cut_params` and `trim::slice` rather than
//! growing a parallel implementation that would drift from the one users already
//! exercise with the trim tool.
//!
//! # Coincident geometry is not an intersection
//!
//! Two entities lying exactly on top of each other intersect in infinitely many
//! points. Cutting there would produce an unbounded number of slivers, so the
//! cut set is the *distinct* intersection points and two of them closer than
//! `PARAM_EPS` collapse into one — which is what stops a circle crossing another
//! circle at two nearly-equal angles from becoming four near-degenerate arcs.
//!
//! # Same ellipse limitation as trim
//!
//! A partial ellipse is not a primitive this kernel has. Decomposing an ellipse
//! would have to degrade it into a polyline, changing its type underneath the
//! user, so it is reported as `Unsupported` instead.

use crate::geom::Prim;
use crate::math::Vec2;
use crate::trim;

/// Result of decomposing one primitive.
pub enum SplitOutcome {
    /// The pieces, in order along the original. Always at least two when
    /// returned — a "split" that produced one piece is not a split.
    Pieces(Vec<Prim>),
    /// Nothing crosses this primitive.
    NoCuts,
    /// See the module comment.
    Unsupported,
}

/// Decompose `target` at every one of `points` that lies on it.
///
/// The caller supplies the crossing points rather than the other primitives on
/// purpose: a scene-level pass finds each *pair* of intersections once, whereas
/// asking each target to re-derive its own crossings would run every
/// intersection twice and blow up quadratically on top of that. Points that miss
/// the target are ignored, so passing a scene-wide list is safe.
pub fn split_at_points(target: &Prim, points: &[Vec2]) -> SplitOutcome {
    if matches!(target, Prim::Ellipse(_)) {
        return SplitOutcome::Unsupported;
    }
    // `cut_params` does the sorting, the endpoint insertion and the collapsing
    // of coincident parameters. Duplicating that here is how two cuts of the
    // same curve end up agreeing on one and disagreeing on the other.
    let params = trim::cut_params_from_points(target, points);
    if params.len() <= 2 {
        return SplitOutcome::NoCuts;
    }
    let mut pieces = Vec::with_capacity(params.len() - 1);
    for i in 0..params.len() - 1 {
        if let Some(p) = trim::slice(target, params[i], params[i + 1]) {
            pieces.push(p);
        }
    }
    // Every interval collapsed to nothing (a target that only touches its
    // cutters at its own endpoints). Reporting that as a split would replace an
    // entity with a single copy of itself and look like the button did nothing
    // while still spending an undo step.
    if pieces.len() < 2 {
        return SplitOutcome::NoCuts;
    }
    SplitOutcome::Pieces(pieces)
}
