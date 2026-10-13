/**
 * TypeScript bridge to the Rust/WASM geometry kernel.
 *
 * Responsibilities
 * ----------------
 * 1. Load and initialise the wasm module exactly once.
 * 2. Encode entities into the kernel's flat `Float64Array` wire format.
 * 3. Expose a typed, allocation-aware facade over the raw wasm exports.
 * 4. Provide a pure-TypeScript fallback so the app still renders (with
 *    degraded picking/snapping) if the wasm module fails to load.
 *
 * Why a flat encoding rather than JS objects: the encoder below runs once per
 * document mutation, and the kernel consumes it without ever allocating a
 * `JsValue` per entity. For a 100k-entity drawing that is the difference
 * between a 2 ms and a 200 ms frame.
 */

import type {
  Aabb,
  ArcEntity,
  BooleanFeature,
  CircleEntity,
  EllipseEntity,
  Entity,
  LineEntity,
  Mat,
  OsnapMode,
  PolylineEntity,
  RawSnap,
  Vec2,
} from './types';
import { PRIM_TAG } from './types';
import { newEntityId } from './entities';

// ---------------------------------------------------------------------------
// Module surface mirrored from `kernel/src/ffi.rs`
// ---------------------------------------------------------------------------

/**
 * Growable f32 buffer owned by the kernel.
 *
 * Note there is deliberately no `ptr`: wasm-bindgen's `web` target does not
 * export the linear-memory object, so JS cannot build a view over a raw
 * pointer. Read the contents back with `to_f32_array()`, which wasm-bindgen
 * satisfies with a single bulk copy.
 */
interface WasmVertexBuffer {
  readonly len: number;
  readonly is_empty: boolean;
  clear(): void;
  reserve(extra: number): void;
  to_f32_array(): Float32Array;
  free(): void;
}

/** Growable f64 buffer owned by the kernel. See `WasmVertexBuffer`. */
interface WasmPointBuffer {
  readonly len: number;
  readonly is_empty: boolean;
  clear(): void;
  reserve(extra: number): void;
  to_f64_array(): Float64Array;
  free(): void;
}

interface WasmSnapResult {
  readonly x: number;
  readonly y: number;
  readonly kind: number;
  readonly entity: number;
  readonly distance: number;
  readonly has_value: boolean;
  free(): void;
}

interface WasmSceneTessellator {
  readonly vertex_ptr: number;
  readonly vertex_len: number;
  readonly strips: Uint32Array;
  set_tolerance(tol: number, maxSeg: number): void;
  tessellate(encoded: Float64Array, counts: Uint32Array): void;
  vertex_array(): Float32Array;
  free(): void;
}

export interface KernelModule {
  version(): string;
  VertexBuffer: new () => WasmVertexBuffer;
  PointBuffer: new () => WasmPointBuffer;
  SceneTessellator: new (tol: number, maxSeg: number) => WasmSceneTessellator;

  arc_segments(sweep: number, radius: number, tol: number, maxSeg: number): number;
  arc_through_points(
    p1x: number, p1y: number,
    p2x: number, p2y: number,
    p3x: number, p3y: number,
  ): Float64Array;
  circle_through_points(
    p1x: number, p1y: number,
    p2x: number, p2y: number,
    p3x: number, p3y: number,
  ): Float64Array;
  measure(encoded: Float64Array): Float64Array;
  tessellate_polyline(coords: Float64Array, closed: boolean, tol: number, out: WasmVertexBuffer): void;

  pick(
    encoded: Float64Array, counts: Uint32Array,
    px: number, py: number, tol: number, maxSeg: number,
  ): number;
  pick_all(
    encoded: Float64Array, counts: Uint32Array,
    px: number, py: number, tol: number, maxSeg: number,
  ): Float64Array;
  select_in_rect(
    encoded: Float64Array, counts: Uint32Array,
    minX: number, minY: number, maxX: number, maxY: number, crossing: boolean,
  ): Uint32Array;
  all_intersections(
    encoded: Float64Array, counts: Uint32Array, tol: number, maxSeg: number,
  ): Float64Array;

  snap_query(
    encoded: Float64Array, counts: Uint32Array,
    cursorX: number, cursorY: number, tol: number, kindMask: number,
    hasFrom: boolean, fromX: number, fromY: number, maxSeg: number,
  ): WasmSnapResult;
  snap_candidates(
    encoded: Float64Array, counts: Uint32Array,
    cursorX: number, cursorY: number, tol: number, kindMask: number,
    hasFrom: boolean, fromX: number, fromY: number, out: WasmPointBuffer,
  ): void;
  apply_constraints(
    cursorX: number, cursorY: number, mode: number, gridStep: number,
    hasFrom: boolean, fromX: number, fromY: number, polarTol: number,
  ): Float64Array;
  snap_kind_values(): Uint8Array;

  transform_prim(encoded: Float64Array, m: Float64Array): Float64Array;
  transform_scene(encoded: Float64Array, counts: Uint32Array, m: Float64Array): Float64Array;
  offset_prim(encoded: Float64Array, distance: number, tol: number, maxSeg: number): Float64Array;

  /**
   * Pull a closed sketch along a datum plane's normal into flat-shaded triangles.
   *
   * `frame` is the plane's `origin, u, v` (nine floats); the normal is `u × v`.
   * Returns `[vertexCount, (x, y, z, nx, ny, nz) × vertexCount]` — non-indexed,
   * three vertices per triangle, so each face carries its own normal without an
   * index buffer. `vertexCount === 0` means the primitive has no closed interior
   * (a lone line or arc has none).
   */
  extrude_mesh(
    encoded: Float64Array, counts: Uint32Array,
    height: number, frame: Float64Array, tol: number, maxSeg: number,
  ): Float32Array;
  /**
   * Lathe a closed profile about an axis **in its own plane**.
   *
   * `axis` is `[px, py, dx, dy]` in the sketch's 2D coordinates. Same wire
   * format and same `vertexCount === 0` meaning as `extrude_mesh`: here zero
   * means "not a valid solid of revolution" (the profile touches or crosses the
   * axis), which the caller reports as a modelling error.
   */
  revolve_mesh(
    encoded: Float64Array, counts: Uint32Array,
    axis: Float64Array, angle: number,
    frame: Float64Array, tol: number, maxSeg: number,
  ): Float32Array;
  /**
   * Boolean of two flat-shaded meshes, both in world space. `op` is one of the
   * codes in `BOOL_OP`; an unknown code comes back empty rather than panicking.
   *
   * Returns the same wire format; `vertexCount === 0` means the result has no
   * surface, which the caller reports in words rather than drawing nothing.
   */
  boolean_mesh(a: Float32Array, b: Float32Array, op: number): Float32Array;
  /**
   * Nearest hit of an eye ray against one mesh. Empty when the ray misses;
   * otherwise `[t, x, y, z, nx, ny, nz]` — the stored (visible) face normal,
   * which is what a hole's axis must follow.
   */
  pick_mesh(mesh: Float32Array, origin: Float64Array, dir: Float64Array): Float64Array;
  /** Drill one hole, a row, or a grid — see `subtract_hole_grid` in the kernel. */
  hole_mesh(
    solid: Float32Array, point: Float64Array, normal: Float64Array,
    diameter: number, depth: number,
    countU: number, spacingU: number, countV: number, spacingV: number,
    boreDiameter: number, boreDepth: number,
    tol: number, maxSeg: number,
  ): Float32Array;
  /**
   * Skin closed sections into one solid (work package 3.4). `frames` is nine
   * floats per section — that section's plane — because the sections come from
   * different sketches.
   */
  loft_mesh(
    encoded: Float64Array, counts: Uint32Array, frames: Float64Array,
    tol: number, maxSeg: number,
  ): Float32Array;
  fillet(
    ax: number, ay: number, bx: number, by: number,
    cx: number, cy: number, dx: number, dy: number, radius: number,
  ): Float64Array;

  encode(encoded: Float64Array): Float64Array;
  encoding_size(encoded: Float64Array): number;
  bounds_of(encoded: Float64Array): Float64Array;
  distance_to(encoded: Float64Array, px: number, py: number): number;
  closest_point(encoded: Float64Array, px: number, py: number): Float64Array;

  /**
   * Re-solve the parametric constraints and hand back the repaired scene.
   *
   * Returns `[ok, iterations, max_residual, ...geometry]`, or an **empty** array
   * when there is nothing to do or a primitive failed to decode — see the Rust
   * doc comment for why "empty" must be treated as "keep what you have" rather
   * than as a scene of zero entities.
   */
  solve_constraints(
    encoded: Float64Array, counts: Uint32Array,
    constraints: Float64Array, moving: Uint8Array,
  ): Float64Array;

  /**
   * 草图自由度报告 —— 欠约束 / 完全定义 / 多余 / 冲突（ROADMAP 0.3）。
   *
   * `[dof, rank, rows, redundant, maxResidual, solved, conflictCount,
   * ...conflictIndices]`，索引指向**传入的**约束数组。与 `solve_constraints`
   * 不同，它**没有 `moving`**：「还剩多少自由度」是草图的属性，与哪次拖动无关。
   * 空数组表示场景没解出来——此时前端什么都不显示，而不是显示一个 0。
   */
  analyze_constraints(
    encoded: Float64Array, counts: Uint32Array, constraints: Float64Array,
  ): Float64Array;

  /**
   * Cut `target_index` back to its cutting edges at `(px, py)`.
   *
   * Returns `[tag, count, ...pieces]` where each piece is a wire-format
   * primitive. `tag` is 0 pieces / 1 no-cuts / 2 off-target / 3 unsupported.
   * `tag === 0` with `count === 0` is a real delete, not a failure.
   */
  trim_target(
    encoded: Float64Array, counts: Uint32Array,
    targetIndex: number, cutters: Uint32Array,
    px: number, py: number, tol: number, maxSeg: number, aperture: number,
  ): Float64Array;

  /** Vertices of the piece a click would remove; empty when there is none. */
  trim_preview(
    encoded: Float64Array, counts: Uint32Array,
    targetIndex: number, cutters: Uint32Array,
    px: number, py: number, tol: number, maxSeg: number, aperture: number,
  ): Float32Array;

  /**
   * Break every primitive in the scene at its intersection points.
   *
   * Returns `[groups, (entityIndex, count, ...prims) × groups]`. Entities that
   * nothing crosses are **absent** from the reply rather than reported with a
   * count of one, so an empty array means "no crossings at all" — which is a
   * real answer, not a failure.
   */
  split_scene(
    encoded: Float64Array, counts: Uint32Array, tol: number, maxSeg: number,
  ): Float64Array;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

let mod: KernelModule | null = null;
let loadError: Error | null = null;
let loading: Promise<KernelModule> | null = null;

/**
 * Initialise the kernel.
 *
 * The glue is built with wasm-bindgen's `web` target, which exports a default
 * `init({ module_or_path })`. Vite 6 no longer understands the `bundler`
 * target's bare `import x from './x.wasm'`, so we resolve the binary through
 * `?url` and hand the URL to `init()` ourselves — no extra plugin required.
 *
 * The single in-flight promise matters: React StrictMode mounts effects twice,
 * and several components call this on mount. Without it the module would be
 * fetched and instantiated once per caller, and whichever finished last would
 * win `mod` while the others leaked their wasm instances.
 */
export async function initKernel(): Promise<KernelModule> {
  if (mod) return mod;
  if (loadError) throw loadError;
  if (loading) return loading;

  loading = (async () => {
    try {
      // Generated by scripts/build-wasm.mjs into src/wasm/pkg. A hand-written
      // ambient declaration in src/vite-env.d.ts keeps `tsc` happy on a clean
      // checkout that has not run `npm run wasm` yet.
      const [pkg, wasmUrl] = await Promise.all([
        import('@wasm/pkg/unicad_kernel.js'),
        import('@wasm/pkg/unicad_kernel_bg.wasm?url'),
      ]);
      // wasm-bindgen ≥0.2.93 takes a single object; the bare-positional form
      // still works but logs a deprecation warning on every call.
      await pkg.default({ module_or_path: wasmUrl.default });
      mod = pkg as unknown as KernelModule;
      return mod;
    } catch (e) {
      loadError = e instanceof Error ? e : new Error(String(e));
      throw loadError;
    } finally {
      loading = null;
    }
  })();

  return loading;
}

export function isKernelReady(): boolean {
  return mod !== null;
}

export function kernelLoadError(): Error | null {
  return loadError;
}

/** Throws if the kernel has not been initialised. */
export function kernel(): KernelModule {
  if (!mod) {
    throw new Error(
      'uniCAD: geometry kernel not initialised. Call initKernel() before drawing.',
    );
  }
  return mod;
}

/**
 * The kernel module, or `null` while `initKernel()` is still in flight (or if
 * it failed outright).
 *
 * `initKernel()` is asynchronous — the first paint always happens before the
 * wasm instance is live. Everything on the *render* path must therefore be
 * written against this rather than `kernel()`, otherwise the very first frames
 * throw inside `requestAnimationFrame` and the canvas stays blank even though
 * the module arrives a few milliseconds later.
 */
export function kernelOrNull(): KernelModule | null {
  return mod;
}

export function kernelVersion(): string {
  try {
    return kernel().version();
  } catch {
    return 'unavailable';
  }
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** Number of f64 slots an entity occupies in the wire format. */
export function encodedSize(e: Entity): number {
  switch (e.type) {
    case 'line': return 5;
    case 'circle': return 4;
    case 'arc': return 6;
    case 'ellipse': return 6;
    // Wire layout `[tag, closed, vertexCount, x, y, …]` — the explicit vertex
    // count is what lets a reader of a flat run skip the polyline exactly.
    case 'polyline': return 3 + e.points.length * 2;
  }
}

/** Write one entity into `out` at `offset`; returns the next offset. */
function writeEntity(e: Entity, out: Float64Array, offset: number): number {
  switch (e.type) {
    case 'line': {
      const l = e as LineEntity;
      out[offset] = PRIM_TAG.line;
      out[offset + 1] = l.a.x;
      out[offset + 2] = l.a.y;
      out[offset + 3] = l.b.x;
      out[offset + 4] = l.b.y;
      return offset + 5;
    }
    case 'circle': {
      const c = e as CircleEntity;
      out[offset] = PRIM_TAG.circle;
      out[offset + 1] = c.center.x;
      out[offset + 2] = c.center.y;
      out[offset + 3] = c.radius;
      return offset + 4;
    }
    case 'arc': {
      const a = e as ArcEntity;
      out[offset] = PRIM_TAG.arc;
      out[offset + 1] = a.center.x;
      out[offset + 2] = a.center.y;
      out[offset + 3] = a.radius;
      out[offset + 4] = a.startAngle;
      out[offset + 5] = a.endAngle;
      return offset + 6;
    }
    case 'ellipse': {
      const el = e as EllipseEntity;
      out[offset] = PRIM_TAG.ellipse;
      out[offset + 1] = el.center.x;
      out[offset + 2] = el.center.y;
      out[offset + 3] = el.rx;
      out[offset + 4] = el.ry;
      out[offset + 5] = el.rotation;
      return offset + 6;
    }
    case 'polyline': {
      const p = e as PolylineEntity;
      out[offset] = PRIM_TAG.polyline;
      out[offset + 1] = p.closed ? 1 : 0;
      out[offset + 2] = p.points.length;
      let o = offset + 3;
      for (const pt of p.points) {
        out[o] = pt.x;
        o += 1;
        out[o] = pt.y;
        o += 1;
      }
      return o;
    }
  }
}

/** A scene packed for a batch kernel call. */
export interface PackedScene {
  encoded: Float64Array;
  counts: Uint32Array;
  /** Entity index → id, for mapping kernel results back to entities. */
  ids: string[];
  /** Entity index → whether it is currently pickable (visible, unlocked, on). */
  pickable: boolean[];
}

/**
 * Pack a list of entities for a batch kernel call.
 *
 * `pickable` marks entities that may be hit-tested; when supplied, non-pickable
 * entities are still included in the geometry stream (so the renderer can draw
 * them) but flagged so `pickMasked` can skip them.
 */
export function packScene(entities: readonly Entity[], pickable?: (e: Entity) => boolean): PackedScene {
  let total = 0;
  const counts = new Uint32Array(entities.length);
  const ids: string[] = new Array(entities.length);
  const flags: boolean[] = new Array(entities.length);

  for (let i = 0; i < entities.length; i++) {
    const e = entities[i]!;
    const n = encodedSize(e);
    counts[i] = n;
    total += n;
    ids[i] = e.id;
    flags[i] = pickable ? pickable(e) : true;
  }

  const encoded = new Float64Array(total);
  let offset = 0;
  for (const e of entities) offset = writeEntity(e, encoded, offset);

  return { encoded, counts, ids, pickable: flags };
}

/** Pack a single entity. */
export function packOne(e: Entity): Float64Array {
  const out = new Float64Array(encodedSize(e));
  writeEntity(e, out, 0);
  return out;
}

/** Read the fields of a flat-encoded primitive back into an entity-ish shape. */
export function decodePrimitive(buf: Float64Array): {
  type: 'line' | 'circle' | 'arc' | 'ellipse' | 'polyline';
  values: number[];
} | null {
  if (buf.length === 0) return null;
  const tag = buf[0];
  switch (tag) {
    case PRIM_TAG.line:
      return { type: 'line', values: [buf[1]!, buf[2]!, buf[3]!, buf[4]!] };
    case PRIM_TAG.circle:
      return { type: 'circle', values: [buf[1]!, buf[2]!, buf[3]!] };
    case PRIM_TAG.arc:
      return { type: 'arc', values: [buf[1]!, buf[2]!, buf[3]!, buf[4]!, buf[5]!] };
    case PRIM_TAG.ellipse:
      return { type: 'ellipse', values: [buf[1]!, buf[2]!, buf[3]!, buf[4]!, buf[5]!] };
    case PRIM_TAG.polyline:
      // `[tag, closed, vertexCount, x, y, …]` → expose `[closed, x, y, …]`
      // (the vertex count is implied by the slice and skipped here) so the
      // existing `const [closed, ...coords]` consumers stay unchanged.
      return { type: 'polyline', values: [buf[1]!, ...Array.from(buf.subarray(3))] };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Typed facade
// ---------------------------------------------------------------------------

const SNAP_KIND_ORDER: OsnapMode[] = [
  'endpoint',
  'midpoint',
  'center',
  'quadrant',
  'perpendicular',
  'nearest',
  'intersection',
  'tangent',
  'grid',
];

/** Map a kernel snap-kind tag back to the UI mode name. */
export function snapKindFromTag(tag: number): OsnapMode | null {
  return SNAP_KIND_ORDER[tag] ?? null;
}

export interface TessellatedScene {
  /** Interleaved `[x, y]` pairs in model space. */
  vertices: Float32Array;
  /** `[startVertex, endVertex]` pairs, one per entity, in entity order. */
  strips: Uint32Array;
}

/**
 * Pure-TypeScript tessellator, used only until the wasm kernel is live.
 *
 * It walks the *same* flat `encoded`/`counts` stream the kernel consumes, so
 * there is exactly one wire format and the fallback cannot drift out of sync
 * with the Rust side. Curves are flattened by the identical sagitta rule —
 * `segments = ceil(acos(1 - tol / r) * 2)` — which keeps the first frames
 * visually indistinguishable from the wasm ones.
 *
 * `maxSeg` caps the subdivision count so a runaway radius cannot stall the
 * very first paint.
 */
function tessellateTS(scene: PackedScene, tol: number, maxSeg: number): TessellatedScene {
  const { encoded, counts } = scene;
  const n = counts.length;

  // A line needs 2 vertices, a circle can need up to maxSeg + 1. Two passes
  // (count then fill) let us allocate the output exactly once.
  //
  // `counts[i]` is authoritative for how many f64 slots each primitive takes;
  // the wire format does not store a point count for polylines (it is implied
  // by the slice length), so we always advance by `counts[i]` rather than
  // trying to recompute it.
  const vertexCounts = new Int32Array(n);
  const segCounts = new Int32Array(n);
  let totalVerts = 0;

  let off = 0;
  for (let i = 0; i < n; i++) {
    const cnt = counts[i]!;
    const tag = encoded[off];
    let verts: number;
    let segs: number;
    switch (tag) {
      case PRIM_TAG.line:
        verts = 2;
        segs = 0;
        break;
      case PRIM_TAG.circle: {
        const r = Math.abs(encoded[off + 3]!);
        segs = arcSegments(r, 2 * Math.PI, tol, maxSeg);
        verts = segs + 1;
        break;
      }
      case PRIM_TAG.arc: {
        // Wire layout: [tag, cx, cy, r, startAngle, endAngle].
        const r = Math.abs(encoded[off + 3]!);
        let sweep = encoded[off + 5]! - encoded[off + 4]!;
        if (sweep < 0) sweep += 2 * Math.PI;
        segs = arcSegments(r, sweep, tol, maxSeg);
        verts = segs + 1;
        break;
      }
      case PRIM_TAG.ellipse: {
        const rx = Math.abs(encoded[off + 3]!);
        const ry = Math.abs(encoded[off + 4]!);
        segs = arcSegments(Math.max(rx, ry), 2 * Math.PI, tol, maxSeg);
        verts = segs + 1;
        break;
      }
      case PRIM_TAG.polyline: {
        // [tag, closed, vertexCount, x0, y0, ...] — vertex count explicit.
        const closed = encoded[off + 1]!;
        const pts = Math.max(0, Math.floor((cnt - 3) / 2));
        verts = pts < 2 ? 0 : pts + (closed !== 0 ? 1 : 0);
        segs = 0;
        break;
      }
      default:
        // Unknown tag: skip defensively rather than corrupting the stream.
        verts = 0;
        segs = 0;
        break;
    }
    vertexCounts[i] = verts;
    segCounts[i] = segs;
    totalVerts += verts;
    off += cnt;
  }

  const vertices = new Float32Array(totalVerts * 2);
  // The GL batch builder expects vertex *indices* delimiting each strip, so a
  // primitive with V vertices occupies V index slots (a single GL_LINE_STRIP).
  const strips = new Uint32Array(n * 2);

  let vo = 0; // global vertex write cursor
  off = 0;
  for (let i = 0; i < n; i++) {
    const cnt = counts[i]!;
    const tag = encoded[off];
    const vStart = vo;
    switch (tag) {
      case PRIM_TAG.line:
        vertices[vo * 2] = encoded[off + 1]!;
        vertices[vo * 2 + 1] = encoded[off + 2]!;
        vertices[vo * 2 + 2] = encoded[off + 3]!;
        vertices[vo * 2 + 3] = encoded[off + 4]!;
        vo += 2;
        break;
      case PRIM_TAG.circle: {
        const cx = encoded[off + 1]!;
        const cy = encoded[off + 2]!;
        const r = Math.abs(encoded[off + 3]!);
        const segs = segCounts[i]!;
        for (let s = 0; s <= segs; s++) {
          const a = (s / segs) * 2 * Math.PI;
          vertices[vo * 2] = cx + r * Math.cos(a);
          vertices[vo * 2 + 1] = cy + r * Math.sin(a);
          vo++;
        }
        break;
      }
      case PRIM_TAG.arc: {
        const cx = encoded[off + 1]!;
        const cy = encoded[off + 2]!;
        const r = Math.abs(encoded[off + 3]!);
        const a0 = encoded[off + 4]!;
        let sweep = encoded[off + 5]! - a0;
        if (sweep < 0) sweep += 2 * Math.PI;
        const segs = segCounts[i]!;
        for (let s = 0; s <= segs; s++) {
          const a = a0 + (s / segs) * sweep;
          vertices[vo * 2] = cx + r * Math.cos(a);
          vertices[vo * 2 + 1] = cy + r * Math.sin(a);
          vo++;
        }
        break;
      }
      case PRIM_TAG.ellipse: {
        const cx = encoded[off + 1]!;
        const cy = encoded[off + 2]!;
        const rx = encoded[off + 3]!;
        const ry = encoded[off + 4]!;
        const rot = encoded[off + 5]!;
        const cs = Math.cos(rot);
        const sn = Math.sin(rot);
        const segs = segCounts[i]!;
        for (let s = 0; s <= segs; s++) {
          const p = (s / segs) * 2 * Math.PI;
          const ex = rx * Math.cos(p);
          const ey = ry * Math.sin(p);
          vertices[vo * 2] = cx + ex * cs - ey * sn;
          vertices[vo * 2 + 1] = cy + ex * sn + ey * cs;
          vo++;
        }
        break;
      }
      case PRIM_TAG.polyline: {
        if (vertexCounts[i]! === 0) break;
        const closed = encoded[off + 1]!;
        const pts = Math.floor((cnt - 3) / 2);
        const base = off + 3;
        for (let p = 0; p < pts; p++) {
          vertices[vo * 2] = encoded[base + p * 2]!;
          vertices[vo * 2 + 1] = encoded[base + p * 2 + 1]!;
          vo++;
        }
        if (closed !== 0) {
          vertices[vo * 2] = encoded[base]!;
          vertices[vo * 2 + 1] = encoded[base + 1]!;
          vo++;
        }
        break;
      }
      default:
        break;
    }
    // `vo` is already a *global* vertex cursor, so the strip bounds are just
    // where this primitive started and ended — no extra base offset.
    strips[i * 2] = vStart;
    strips[i * 2 + 1] = vo;
    off += cnt;
  }

  return { vertices, strips };
}

/**
 * Sagitta-driven segment count.
 *
 * Mirrors `arc_segment_count` in kernel/src/geom.rs branch-for-branch so the TS
 * fallback and the wasm path agree on every input, including the degenerate
 * ones (zero radius / zero sweep), where the two would otherwise pick
 * different subdivision counts and make the first frame visibly "pop".
 */
function arcSegments(radius: number, sweep: number, tol: number, maxSeg: number): number {
  const sw = Math.abs(sweep);
  const cap = Math.max(maxSeg, 2);
  if (sw <= 1e-9) return 2;
  if (radius <= 1e-9 || tol <= 1e-12) return cap;
  const ratio = Math.max(-1, Math.min(1, 1 - Math.min(tol / radius, 1)));
  const half = Math.acos(ratio);
  if (half <= 1e-9) return cap;
  const n = Math.ceil(sw / (half * 2));
  return Math.max(2, Math.min(cap, n));
}

/** Reusable tessellator handle so we do not reallocate wasm buffers per frame. */
export class SceneBuffer {
  private tess: WasmSceneTessellator | null = null;
  /** Set once, so a persistent failure logs a single line instead of 60/s. */
  private warned = false;

  /**
   * `tol` is expressed in model units and is only a starting value — the render
   * loop overwrites it via `setScreenTolerance` before the first `run()`, since
   * the correct tolerance depends on the zoom level.
   */
  constructor(tol = 0.05, maxSeg = 512) {
    this.tol = tol;
    this.maxSeg = maxSeg;
  }

  tol: number;
  maxSeg: number;

  setTolerance(tol: number, maxSeg: number): void {
    // Idempotent so the render loop can call this every frame without paying for
    // a wasm round trip when the zoom has not moved.
    if (tol === this.tol && maxSeg === this.maxSeg) return;
    this.tol = tol;
    this.maxSeg = maxSeg;
    this.tess?.set_tolerance(tol, maxSeg);
  }

  /**
   * Set the tolerance from a **screen-space** deviation, in CSS pixels.
   *
   * The kernel works in model units, so the tolerance has to be re-derived
   * whenever the zoom changes. A fixed model-space tolerance cannot be right at
   * every zoom: `0.05` looks reasonable on a 1:1 drawing but is 0.012 px at
   * 1:4, which tessellates a circle into 512 sub-pixel segments that rasterise
   * as a bead necklace instead of an arc.
   *
   * `scale` is model units per CSS pixel (the same convention as the pick
   * aperture).
   */
  setScreenTolerance(px: number, scale: number, maxSeg = 512): void {
    this.setTolerance(px * scale, maxSeg);
  }

  /**
   * Tessellate a packed scene, reusing the underlying wasm buffers.
   *
   * Falls back to the TypeScript path while the kernel is still loading, so the
   * first frames of a fresh page load draw real geometry instead of throwing
   * out of `requestAnimationFrame`.
   */
  run(scene: PackedScene): TessellatedScene {
    const k = kernelOrNull();
    if (!k) return tessellateTS(scene, this.tol, this.maxSeg);

    if (!this.tess) this.tess = new k.SceneTessellator(this.tol, this.maxSeg);
    // `dispose()` may have run between the null check above and here if a React
    // effect re-ran mid-frame; re-check and fall back rather than dereferencing
    // a freed wasm pointer (which traps as "memory access out of bounds").
    const t = this.tess;
    if (!t) return tessellateTS(scene, this.tol, this.maxSeg);

    try {
      t.tessellate(scene.encoded, scene.counts);
      // One bulk copy out of wasm memory. The kernel reuses its buffer on the
      // next call, so the returned view must be independent of it.
      const vertices = t.vertex_array();
      const strips = t.strips;
      return { vertices, strips };
    } catch (err) {
      // A wasm trap poisons the instance's allocator state; reusing the same
      // handle would trap on every subsequent frame (which is exactly the
      // "249 identical exceptions" failure mode). Drop it and rebuild the TS
      // geometry for this frame so the canvas keeps painting.
      this.tess = null;
      try {
        t.free();
      } catch {
        /* the handle is already dead */
      }
      if (!this.warned) {
        this.warned = true;
        console.warn('uniCAD: 镶嵌器异常，本帧回退到 TS 路径。', err);
      }
      return tessellateTS(scene, this.tol, this.maxSeg);
    }
  }

  dispose(): void {
    // Idempotent: a double-mount (StrictMode) calls this twice.
    const t = this.tess;
    this.tess = null;
    t?.free();
  }
}

/** Hit-test the scene; returns the entity index or `-1`. */
export function pickScene(
  scene: PackedScene,
  p: Vec2,
  tolerance: number,
  maxSeg = 512,
): number {
  const k = kernel();
  const idx = k.pick(scene.encoded, scene.counts, p.x, p.y, tolerance, maxSeg);
  if (idx < 0) return -1;
  // Respect the pickable flag (locked / frozen layers).
  return scene.pickable[idx] ? idx : -1;
}

/** Every entity hit within tolerance, nearest first. */
export function pickAll(
  scene: PackedScene,
  p: Vec2,
  tolerance: number,
  maxSeg = 512,
): Array<{ index: number; distance: number }> {
  const raw = kernel().pick_all(scene.encoded, scene.counts, p.x, p.y, tolerance, maxSeg);
  const out: Array<{ index: number; distance: number }> = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const index = raw[i]!;
    if (!scene.pickable[index]) continue;
    out.push({ index, distance: raw[i + 1]! });
  }
  return out;
}

/** Window / crossing selection. */
export function selectInRect(
  scene: PackedScene,
  a: Vec2,
  b: Vec2,
  crossing: boolean,
): number[] {
  const idx = kernel().select_in_rect(
    scene.encoded,
    scene.counts,
    a.x,
    a.y,
    b.x,
    b.y,
    crossing,
  );
  return Array.from(idx).filter((i) => scene.pickable[i]);
}

/** Nearest snap under the cursor. */
export function snapQuery(
  scene: PackedScene,
  cursor: Vec2,
  tolerance: number,
  kindMask: number,
  from: Vec2 | null,
  maxSeg = 512,
): RawSnap {
  const k = kernel();
  const r = k.snap_query(
    scene.encoded,
    scene.counts,
    cursor.x,
    cursor.y,
    tolerance,
    kindMask >>> 0,
    from !== null,
    from?.x ?? 0,
    from?.y ?? 0,
    maxSeg,
  );
  const out: RawSnap = {
    x: r.x,
    y: r.y,
    kind: r.kind,
    entity: r.entity,
    distance: r.distance,
    found: r.has_value,
  };
  r.free();
  return out;
}

/** Every snap candidate in the aperture, for drawing all markers. */
export function snapCandidates(
  scene: PackedScene,
  cursor: Vec2,
  tolerance: number,
  kindMask: number,
  from: Vec2 | null,
  out: WasmPointBuffer,
): void {
  kernel().snap_candidates(
    scene.encoded,
    scene.counts,
    cursor.x,
    cursor.y,
    tolerance,
    kindMask >>> 0,
    from !== null,
    from?.x ?? 0,
    from?.y ?? 0,
    out,
  );
}

/** Apply grid / ortho / polar constraints to a cursor position. */
export function applyConstraints(
  cursor: Vec2,
  mode: number,
  gridStep: number,
  from: Vec2 | null,
  polarTolerance = 0.0873, // ~5°
): Vec2 {
  const out = kernel().apply_constraints(
    cursor.x,
    cursor.y,
    mode,
    gridStep,
    from !== null,
    from?.x ?? 0,
    from?.y ?? 0,
    polarTolerance,
  );
  return { x: out[0]!, y: out[1]! };
}

/** Bounding box of a single entity, via the kernel. */
export function entityBounds(e: Entity): Aabb {
  const b = kernel().bounds_of(packOne(e));
  return { minX: b[0]!, minY: b[1]!, maxX: b[2]!, maxY: b[3]! };
}

/** Distance from a point to an entity. */
export function distanceToEntity(e: Entity, p: Vec2): number {
  return kernel().distance_to(packOne(e), p.x, p.y);
}

/** Closest point on an entity. */
export function closestPointOnEntity(e: Entity, p: Vec2): Vec2 {
  const c = kernel().closest_point(packOne(e), p.x, p.y);
  return { x: c[0] ?? p.x, y: c[1] ?? p.y };
}

/** Measure an entity: area, perimeter, and bounds. */
export interface Measurement {
  area: number;
  perimeter: number;
  bounds: Aabb;
}

export function measureEntity(e: Entity): Measurement {
  const m = kernel().measure(packOne(e));
  return {
    area: m[0]!,
    perimeter: m[1]!,
    bounds: { minX: m[2]!, minY: m[3]!, maxX: m[4]!, maxY: m[5]! },
  };
}

/** Intersections across the whole scene: pairs of entity indices + points. */
export function allIntersections(scene: PackedScene, tol: number, maxSeg = 512): Array<{
  a: number;
  b: number;
  point: Vec2;
}> {
  const raw = kernel().all_intersections(scene.encoded, scene.counts, tol, maxSeg);
  const out: Array<{ a: number; b: number; point: Vec2 }> = [];
  for (let i = 0; i + 3 < raw.length; i += 4) {
    out.push({ a: raw[i]!, b: raw[i + 1]!, point: { x: raw[i + 2]!, y: raw[i + 3]! } });
  }
  return out;
}

/** Arc through three points; `null` when collinear. */
export function arcThroughPoints(p1: Vec2, p2: Vec2, p3: Vec2): {
  center: Vec2;
  radius: number;
  startAngle: number;
  endAngle: number;
} | null {
  const r = kernel().arc_through_points(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
  if (r.length < 5) return null;
  return {
    center: { x: r[0]!, y: r[1]! },
    radius: r[2]!,
    startAngle: r[3]!,
    endAngle: r[4]!,
  };
}

/** Circle through three points; `null` when collinear. */
export function circleThroughPoints(p1: Vec2, p2: Vec2, p3: Vec2): {
  center: Vec2;
  radius: number;
} | null {
  const r = kernel().circle_through_points(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
  if (r.length < 3) return null;
  return { center: { x: r[0]!, y: r[1]! }, radius: r[2]! };
}

/** Apply an affine transform to an entity via the kernel. */
export function transformEntity(e: Entity, m: Mat): Entity | null {
  const out = kernel().transform_prim(packOne(e), new Float64Array(m));
  const decoded = decodePrimitive(out);
  if (!decoded) return null;
  switch (decoded.type) {
    case 'line':
      return { ...(e as LineEntity), a: { x: decoded.values[0]!, y: decoded.values[1]! }, b: { x: decoded.values[2]!, y: decoded.values[3]! } };
    case 'circle':
      return { ...(e as CircleEntity), center: { x: decoded.values[0]!, y: decoded.values[1]! }, radius: decoded.values[2]! };
    case 'arc':
      return {
        ...(e as ArcEntity),
        center: { x: decoded.values[0]!, y: decoded.values[1]! },
        radius: decoded.values[2]!,
        startAngle: decoded.values[3]!,
        endAngle: decoded.values[4]!,
      };
    case 'ellipse':
      return {
        ...(e as EllipseEntity),
        center: { x: decoded.values[0]!, y: decoded.values[1]! },
        rx: decoded.values[2]!,
        ry: decoded.values[3]!,
        rotation: decoded.values[4]!,
      };
    case 'polyline': {
      const [closed, ...coords] = decoded.values;
      const points: Vec2[] = [];
      for (let i = 0; i + 1 < coords.length; i += 2) {
        points.push({ x: coords[i]!, y: coords[i + 1]! });
      }
      return { ...(e as PolylineEntity), points, closed: closed !== 0 };
    }
  }
}

/**
 * Extrude a closed sketch along a datum plane's normal into flat-shaded
 * triangles, ready for the 3D pass.
 *
 * `frame` is the plane's `origin, u, v` — see `planeFrame` in `types.ts`.
 * Returns the interleaved vertex buffer (`x, y, z, nx, ny, nz` per vertex, in
 * **world** space) or `null` when the entity is not a closed region. The caller
 * caches the result: it only changes when the sketch, the height, or the plane
 * does.
 */
export function extrudeMesh(
  profile: Entity,
  height: number,
  frame: Float64Array,
  tol = 0.05,
  maxSeg = 256,
): Float32Array | null {
  const out = kernel().extrude_mesh(
    packOne(profile),
    new Uint32Array([encodedSize(profile)]),
    height,
    frame,
    tol,
    maxSeg,
  );
  const n = out.length > 0 ? out[0]! | 0 : 0;
  if (n <= 0) return null;
  return out.subarray(1, 1 + n * 6);
}

/**
 * Lathe a closed profile around an axis **in its own plane** (work package 3.1).
 *
 * `axisPoint`/`axisDir` are in the sketch's own 2D coordinates — that is where
 * both the profile and the centreline were drawn, and it is the only frame the
 * caller has. Returns `null` when the kernel refuses the profile: not closed,
 * or touching/crossing the axis so the sweep would fold through itself. That
 * `null` is a modelling error the evaluator turns into a visible one — never an
 * empty mesh passed off as a success.
 */
export function revolveMesh(
  profile: Entity,
  axisPoint: Vec2,
  axisDir: Vec2,
  angle: number,
  frame: Float64Array,
  tol = 0.05,
  maxSeg = 256,
): Float32Array | null {
  const axis = Float64Array.from([axisPoint.x, axisPoint.y, axisDir.x, axisDir.y]);
  const out = kernel().revolve_mesh(
    packOne(profile),
    new Uint32Array([encodedSize(profile)]),
    axis,
    angle,
    frame,
    tol,
    maxSeg,
  );
  const n = out.length > 0 ? out[0]! | 0 : 0;
  if (n <= 0) return null;
  return out.subarray(1, 1 + n * 6);
}

/**
 * Boolean operation codes — mirrors `OP_*` in `kernel/src/boolean.rs`, the same
 * way `TRIM_TAG` mirrors the trim codes in `ffi.rs`. Two sides of an FFI need
 * one shared vocabulary, and a name here beats a bare `2` at the call site.
 */
export const BOOL_OP: Record<BooleanFeature['op'], number> = {
  subtract: 0,
  union: 1,
  intersect: 2,
};

/**
 * Boolean of two flat-shaded meshes (work packages 2.1 / 2.2).
 *
 * Both operands are world-space triangle soups — the evaluator hands over two
 * features' meshes — and the result comes back in the same format, ready to
 * draw or to feed into another boolean.
 *
 * `null` means the result has **no surface**: an operand was empty, the cutter
 * swallowed the target, or (for an intersection) the two never touch. All three
 * are legitimate outcomes of legal operations, and the evaluator says which one
 * it was in words rather than drawing nothing.
 */
export function booleanMesh(
  a: Float32Array,
  b: Float32Array,
  op: BooleanFeature['op'],
): Float32Array | null {
  const out = kernel().boolean_mesh(a, b, BOOL_OP[op]);
  const n = out.length > 0 ? out[0]! | 0 : 0;
  if (n <= 0) return null;
  return out.subarray(1, 1 + n * 6);
}

/** One face hit by an eye ray (work package 3.2). */
export interface MeshHit {
  /** Distance along the ray direction. */
  t: number;
  /** Hit point, world space. */
  point: [number, number, number];
  /** The face's outward normal — the stored flat-shading normal, i.e. what is drawn. */
  normal: [number, number, number];
}

/**
 * Nearest face of `mesh` along an eye ray, or `null`.
 *
 * The ray itself comes from `screenRay` in the render layer — building it from
 * the camera basis is a camera concern. The intersection is *geometry*, so it
 * lives in the kernel next to the 2D picker, for the same reason that one does.
 */
export function pickMesh(
  mesh: Float32Array,
  origin: readonly [number, number, number],
  dir: readonly [number, number, number],
): MeshHit | null {
  const out = kernel().pick_mesh(mesh, Float64Array.from(origin), Float64Array.from(dir));
  if (out.length < 7) return null;
  return {
    t: out[0]!,
    point: [out[1]!, out[2]!, out[3]!],
    normal: [out[4]!, out[5]!, out[6]!],
  };
}

/**
 * Drill a hole into `solid`: the kernel builds the cylindrical cutter from the
 * face and subtracts it, so no part of "which way does the axis point" has to
 * be agreed on twice.
 *
 * `depth === 0` means through. `countU × countV` drills a **grid** on the face's
 * own in-plane axes, `spacingU`/`spacingV` apart, the first at `point` — one
 * cutter soup, one boolean pass, however many instances. `boreDiameter`/
 * `boreDepth` add a wider recess at each entry (`0` = none).
 *
 * `null` means the cut left no solid at all.
 */
export function holeMesh(
  solid: Float32Array,
  point: readonly [number, number, number],
  normal: readonly [number, number, number],
  diameter: number,
  depth: number,
  countU = 1,
  spacingU = 0,
  countV = 1,
  spacingV = 0,
  boreDiameter = 0,
  boreDepth = 0,
  tol = 0.05,
  maxSeg = 256,
): Float32Array | null {
  const out = kernel().hole_mesh(
    solid,
    Float64Array.from(point),
    Float64Array.from(normal),
    diameter,
    depth,
    countU,
    spacingU,
    countV,
    spacingV,
    boreDiameter,
    boreDepth,
    tol,
    maxSeg,
  );
  const n = out.length > 0 ? out[0]! | 0 : 0;
  if (n <= 0) return null;
  return out.subarray(1, 1 + n * 6);
}

/**
 * Loft closed sections into one solid (work package 3.4).
 *
 * Each section carries its **own plane** (`frame`, the same nine-float
 * `origin, u, v` layout the extrude call takes) because the sections come from
 * different sketches — that is the whole difference between a loft and an
 * extrude, and the reason this call takes a list.
 *
 * `null` means the sections cannot bound a solid: fewer than two, one lying
 * parallel to the loft direction, or one with no closed interior.
 */
export function loftMesh(
  sections: ReadonlyArray<{ profile: Entity; frame: Float64Array }>,
  tol = 0.05,
  maxSeg = 256,
): Float32Array | null {
  if (sections.length < 2) return null;
  const encoded: number[] = [];
  const counts: number[] = [];
  const frames: number[] = [];
  for (const s of sections) {
    const one = packOne(s.profile);
    for (const v of one) encoded.push(v);
    counts.push(encodedSize(s.profile));
    for (const v of s.frame) frames.push(v);
  }
  const out = kernel().loft_mesh(
    Float64Array.from(encoded),
    Uint32Array.from(counts),
    Float64Array.from(frames),
    tol,
    maxSeg,
  );
  const n = out.length > 0 ? out[0]! | 0 : 0;
  if (n <= 0) return null;
  return out.subarray(1, 1 + n * 6);
}

/** Offset (parallel-curve) an entity by a **signed** distance.
 *
 * The offset is a *new* entity, so it is handed a fresh id — `rebuildFromDecoded`
 * copies the source's id as its template, and reusing it would put two entities
 * with the same id in the document (the second one unreachable by pick/undo).
 *
 * Returns `null` only when the kernel produced something undecodable.
 */
export function offsetEntity(e: Entity, distance: number, tol = 0.02, maxSeg = 512): Entity | null {
  const out = kernel().offset_prim(packOne(e), distance, tol, maxSeg);
  const decoded = decodePrimitive(out);
  if (!decoded) return null;
  const built = rebuildFromDecoded(e, decoded);
  return built ? { ...built, id: newEntityId() } : null;
}

function rebuildFromDecoded(
  template: Entity,
  decoded: { type: string; values: number[] },
): Entity | null {
  switch (decoded.type) {
    case 'line':
      return { ...(template as LineEntity), a: { x: decoded.values[0]!, y: decoded.values[1]! }, b: { x: decoded.values[2]!, y: decoded.values[3]! } };
    case 'circle':
      return { ...(template as CircleEntity), center: { x: decoded.values[0]!, y: decoded.values[1]! }, radius: decoded.values[2]! };
    case 'arc':
      return {
        ...(template as ArcEntity),
        center: { x: decoded.values[0]!, y: decoded.values[1]! },
        radius: decoded.values[2]!,
        startAngle: decoded.values[3]!,
        endAngle: decoded.values[4]!,
      };
    case 'ellipse':
      return {
        ...(template as EllipseEntity),
        center: { x: decoded.values[0]!, y: decoded.values[1]! },
        rx: decoded.values[2]!,
        ry: decoded.values[3]!,
        rotation: decoded.values[4]!,
      };
    case 'polyline': {
      const [closed, ...coords] = decoded.values;
      const points: Vec2[] = [];
      for (let i = 0; i + 1 < coords.length; i += 2) {
        points.push({ x: coords[i]!, y: coords[i + 1]! });
      }
      return { ...(template as PolylineEntity), points, closed: closed !== 0 };
    }
    default:
      return null;
  }
}

/** Fillet result between two segments. */
export interface FilletResult {
  center: Vec2;
  radius: number;
  tangent1: Vec2;
  tangent2: Vec2;
}

export function filletSegments(
  s1a: Vec2, s1b: Vec2,
  s2a: Vec2, s2b: Vec2,
  radius: number,
): FilletResult | null {
  const r = kernel().fillet(s1a.x, s1a.y, s1b.x, s1b.y, s2a.x, s2a.y, s2b.x, s2b.y, radius);
  if (r.length < 7) return null;
  return {
    center: { x: r[0]!, y: r[1]! },
    radius: r[2]!,
    tangent1: { x: r[3]!, y: r[4]! },
    tangent2: { x: r[5]!, y: r[6]! },
  };
}

/** Adaptive tessellation count for an arc of the given geometry. */
export function arcSegmentCount(sweep: number, radius: number, tol: number, maxSeg = 512): number {
  return kernel().arc_segments(sweep, radius, tol, maxSeg);
}

// ---------------------------------------------------------------------------
// Buffer helpers
// ---------------------------------------------------------------------------

/** Create a kernel-side growable buffer for point lists. */
export function createPointBuffer(): WasmPointBuffer {
  return new (kernel().PointBuffer)();
}

/**
 * Read a point buffer out as structured records.
 *
 * The kernel writes fixed-size records of 5 f64 (`x, y, kind, entity,
 * distance`).
 */
export function readPointBuffer(
  buf: WasmPointBuffer,
  recordSize: number,
): number[][] {
  // `to_f64_array()` performs one bulk copy out of wasm; wrapping a raw pointer
  // is not possible because the `web` target hides the memory object.
  const flat = buf.to_f64_array();
  const records: number[][] = [];
  for (let i = 0; i + recordSize <= flat.length; i += recordSize) {
    records.push(Array.from(flat.subarray(i, i + recordSize)));
  }
  return records;
}

export type { WasmPointBuffer, WasmVertexBuffer };
