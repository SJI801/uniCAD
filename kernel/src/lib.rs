//! uniCAD geometry kernel.
//!
//! Everything in this crate is written so that it can run either
//! natively (for unit tests via `cargo test`) or compiled to
//! `wasm32-unknown-unknown` and driven from the TypeScript front-end.
//!
//! Layout:
//! - [`math`]        — 2D vector / 2x3 affine transform primitives
//! - [`geom`]        — primitive types, discretisation (tessellation)
//! - [`query`]       — hit-testing, distance, nearest-point, intersections
//! - [`snap`]        — object snap candidate generation
//! - [`trim`]        — cutting a target back to its cutting edges
//! - [`split`]       — breaking primitives apart at their intersection points
//! - [`constraints`] — parametric constraint solving
//! - [`ffi`]         — the `#[wasm_bindgen]` surface consumed by the front-end

pub mod constraints;
pub mod ffi;
pub mod geom;
pub mod math;
pub mod mesh;
pub mod query;
pub mod snap;
pub mod split;
pub mod trim;

pub use geom::{Arc, Circle, Ellipse, LineSeg, Polyline, Prim};
pub use math::{Mat3, Vec2};
