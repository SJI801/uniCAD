/**
 * Shared domain types for uniCAD.
 *
 * These mirror the Rust kernel's wire format exactly (see `kernel/src/ffi.rs`).
 * Keeping the numeric layout in sync is what lets us hand entity data across
 * the WASM boundary as a plain `Float64Array` with no serialisation.
 */

/** A point or vector in model space. */
export interface Vec2 {
  x: number;
  y: number;
}

/** Axis-aligned bounding box. */
export interface Aabb {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A 2x3 affine transform, stored as `[a, b, c, d, e, f]`. */
export type Mat = [number, number, number, number, number, number];

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export type EntityId = string;
export type LayerId = string;

export type LineStyle = 'continuous' | 'dashed' | 'dotted' | 'dashdot' | 'center' | 'hidden';

/** Common fields every entity carries. */
export interface EntityBase {
  id: EntityId;
  layer: LayerId;
  /** Explicit colour override (`#rrggbb`). `null` inherits the layer colour. */
  color: string | null;
  /** Explicit linetype override. `null` inherits the layer's. */
  lineStyle: LineStyle | null;
  /** Explicit lineweight in millimetres. `null` inherits the layer's. */
  lineWeight: number | null;
  /**
   * Which datum plane this entity is on is **not** stored here: the sketch
   * that hosts the entity owns the plane (see `Sketch`). Stage 1 removed the
   * per-entity `plane` field rather than keep two spellings of one fact —
   * "the sketch says XY while the entity says YZ" was a bug waiting for a
   * plane switch to expose it.
   */
  /** Display name, shown in the properties panel. */
  name?: string;
}

export interface LineEntity extends EntityBase {
  type: 'line';
  a: Vec2;
  b: Vec2;
}

export interface PolylineEntity extends EntityBase {
  type: 'polyline';
  points: Vec2[];
  closed: boolean;
}

export interface CircleEntity extends EntityBase {
  type: 'circle';
  center: Vec2;
  radius: number;
}

export interface ArcEntity extends EntityBase {
  type: 'arc';
  center: Vec2;
  radius: number;
  startAngle: number;
  endAngle: number;
}

export interface EllipseEntity extends EntityBase {
  type: 'ellipse';
  center: Vec2;
  rx: number;
  ry: number;
  rotation: number;
}

export type Entity =
  | LineEntity
  | PolylineEntity
  | CircleEntity
  | ArcEntity
  | EllipseEntity;

export type EntityType = Entity['type'];

/** Numeric tag used by the kernel's flat encoding. */
export const PRIM_TAG = {
  line: 0,
  circle: 1,
  arc: 2,
  ellipse: 3,
  polyline: 4,
} as const;

// ---------------------------------------------------------------------------
// Parametric constraints
// ---------------------------------------------------------------------------

/**
 * A *persistent* relationship between curves, stored with the document.
 *
 * Not to be confused with `ConstraintMode` further down, which constrains the
 * **cursor** while drawing (正交 / 极轴 / 栅格). That one is a drawing aid and
 * leaves nothing behind; these survive edits and are re-solved by the kernel.
 */
export type ConstraintKind =
  | 'coincident'
  | 'pointOnCurve'
  | 'tangent'
  | 'perpendicular'
  | 'parallel'
  | 'concentric'
  | 'equalRadius'
  | 'horizontal'
  | 'vertical'
  | 'distance'
  | 'angle'
  | 'radius'
  | 'diameter'
  | 'distanceX'
  | 'distanceY'
  /**
   * 锚点：把具名点的 **x** 坐标钉在 `value` 上。`fixedY` 同理钉 y。
   *
   * 内核里一条约束只能带一个标量，而钉住一个点要两个数，所以「固定」在线上
   * 是**成对**的两条（见 `buildConstraints`）。有了它，自由度才第一次能到 0，
   * ROADMAP 0.4 的「完全定义」开关才有意义 —— 没有锚点时整张图永远留着刚体
   * 平移/转动自由度。
   */
  | 'fixedX'
  | 'fixedY';

/** Which point of a curve a constraint refers to. `none` = the whole curve. */
export type ConstraintPointKind = 'none' | 'start' | 'end' | 'center' | 'vertex';

export interface ConstraintTarget {
  entity: EntityId;
  point: ConstraintPointKind;
  /** Only for `point === 'vertex'`: the polyline vertex index. */
  index?: number;
}

export interface Constraint {
  id: string;
  kind: ConstraintKind;
  a: ConstraintTarget;
  /** Absent for the kinds that only involve one curve (`horizontal` / `vertical`). */
  b?: ConstraintTarget;
  /**
   * Target value for the dimensional kinds, in model units — model length for
   * distance / radius / diameter, **radians** for angle. `undefined` (and
   * ignored) for the purely geometric kinds.
   *
   * The stored number is the *intent*; the solver treats the gap between it
   * and reality as one more residual. A dimension re-derived from the geometry
   * after every edit could never disagree with it — which is exactly the
   * 「尺寸只显示、不驱动」 failure this stage exists to kill.
   */
  value?: number;
}

/**
 * Geometric-constraint wire tags — must stay in step with
 * `ConstraintKind::from_tag` in `kernel/src/constraints.rs`.
 *
 * Named `CONSTRAINT_KIND_TAG`, not `CONSTRAINT_TAG`: the latter has been there
 * since the cursor-constraint feature and means "ConstraintMode → kernel
 * `mode` argument". Two unrelated meanings under one name is how the wrong table
 * ends up indexed by the wrong enum — and TypeScript caught exactly that here.
 */
export const CONSTRAINT_KIND_TAG: Record<ConstraintKind, number> = {
  coincident: 0,
  pointOnCurve: 1,
  tangent: 2,
  perpendicular: 3,
  parallel: 4,
  concentric: 5,
  equalRadius: 6,
  horizontal: 7,
  vertical: 8,
  distance: 9,
  angle: 10,
  radius: 11,
  diameter: 12,
  distanceX: 13,
  distanceY: 14,
  // 15/16 = 锚点对，与 `ConstraintKind::from_tag` 一一对应。
  fixedX: 15,
  fixedY: 16,
};

/** Kernel wire tags for `ConstraintTarget.point`. */
export const CONSTRAINT_POINT_TAG: Record<ConstraintPointKind, number> = {
  none: 0,
  start: 1,
  end: 2,
  center: 3,
  vertex: 4,
};

/**
 * How many scalars one constraint occupies in the flat kernel array —
 * `[kind, aE, aP, aI, bE, bP, bI, value]`. The trailing `value` carries the
 * target for the dimensional kinds and `0` for the geometric ones.
 */
export const CONSTRAINT_STRIDE = 8;

/**
 * Constraint kinds that only need one curve. Radius / diameter pin a single
 * circle or arc; horizontal / vertical pin a single line; fixedX / fixedY pin a
 * single named point on *any* kind of curve (a line's endpoint, a circle's
 * centre, a polyline's vertex).
 */
export const UNARY_CONSTRAINTS: ReadonlySet<ConstraintKind> = new Set<ConstraintKind>([
  'horizontal',
  'vertical',
  'radius',
  'diameter',
  'fixedX',
  'fixedY',
]);

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

export interface Layer {
  id: LayerId;
  name: string;
  color: string;
  lineStyle: LineStyle;
  /** Lineweight in millimetres; `0` means "by device default" (hairline). */
  lineWeight: number;
  visible: boolean;
  /** Locked layers still render but cannot be selected. */
  locked: boolean;
  /** Frozen layers are skipped entirely, including snap. */
  frozen: boolean;
  /** Objects on non-plotting layers are drawn but excluded from DXF plot. */
  printable: boolean;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export interface DocumentMeta {
  title: string;
  author: string;
  createdAt: string;
  modifiedAt: string;
  /** Schema version, bumped when the on-disk shape changes. */
  version: number;
}

/** Model-space settings that affect drawing behaviour. */
export interface DrawingSettings {
  /** Base snap grid spacing in model units. */
  gridSpacing: number;
  /** Minor grid subdivisions drawn between major lines. */
  gridSubdivisions: number;
  /** Object snap aperture, in *screen* pixels — converted to model units at use. */
  snapAperturePx: number;
  /** Picking aperture, in screen pixels. */
  pickAperturePx: number;
  /** Enabled object snap kinds. */
  osnapModes: OsnapMode[];
  /** Constraint mode for cursor movement. */
  constraint: ConstraintMode;
  /** Polar tracking increment, in degrees. */
  polarIncrement: number;
  /** Whether the polar constraint snaps to the increment. */
  polarTracking: boolean;
  /** Units label for the status bar. */
  units: 'mm' | 'cm' | 'm' | 'in';
  /** Current dimension scale factor for annotation (used by future tools). */
  annotationScale: number;
}

export type OsnapMode =
  | 'endpoint'
  | 'midpoint'
  | 'center'
  | 'quadrant'
  | 'perpendicular'
  | 'nearest'
  | 'intersection'
  | 'tangent'
  | 'grid';

export type ConstraintMode = 'none' | 'grid' | 'ortho' | 'polar';

/** Kernel snap-kind tags, in the same order as `SnapKind` in Rust. */
export const SNAP_KIND_TAG: Record<OsnapMode, number> = {
  endpoint: 0,
  midpoint: 1,
  center: 2,
  quadrant: 3,
  perpendicular: 4,
  nearest: 5,
  intersection: 6,
  tangent: 7,
  grid: 8,
};

export const SNAP_KIND_LABEL: Record<OsnapMode, string> = {
  endpoint: '端点',
  midpoint: '中点',
  center: '圆心',
  quadrant: '象限点',
  perpendicular: '垂足',
  nearest: '最近点',
  intersection: '交点',
  tangent: '切点',
  grid: '栅格',
};

/** Pack an osnap-mode list into the bitfield the kernel expects. */
export function packOsnapMask(modes: readonly OsnapMode[]): number {
  let mask = 0;
  for (const m of modes) mask |= 1 << SNAP_KIND_TAG[m];
  return mask >>> 0;
}

/** Constraint mode → kernel `mode` argument. */
export const CONSTRAINT_TAG: Record<ConstraintMode, number> = {
  none: 0,
  grid: 1,
  ortho: 2,
  polar: 3,
};

// ---------------------------------------------------------------------------
// Datum planes and reference coordinate systems
// ---------------------------------------------------------------------------

export type PlaneId = string;

/** The plane every sketch is on unless it says otherwise. */
export const XY_PLANE: PlaneId = 'xy';

/**
 * A named datum plane — a 2D frame embedded in the 3D model.
 *
 * The three base planes (XY / YZ / ZX) come with every document and cannot be
 * deleted: "which way is up" needs an answer before anything is drawn. `u` and
 * `v` are the plane's local axes in **world** space, so a sketch's 2D `(x, y)`
 * lands at `origin + u·x + v·y`, and the extrusion runs along `u × v`. Storing
 * the frame explicitly rather than deriving it from the id is what will let a
 * derived (offset / angled) plane reuse every code path here without a special
 * case.
 */
export interface DocPlane {
  id: PlaneId;
  name: string;
  /** Origin of the plane's local frame, world space. */
  origin: [number, number, number];
  /** Unit vector of the plane's local +x, world space. */
  u: [number, number, number];
  /** Unit vector of the plane's local +y, world space. */
  v: [number, number, number];
  visible: boolean;
}

/**
 * A reference coordinate system: an origin plus two axis directions. The third
 * axis is their cross product, so an inconsistent right-handed frame cannot be
 * written down in the first place.
 */
export interface DocFrame {
  id: string;
  name: string;
  origin: [number, number, number];
  xAxis: [number, number, number];
  yAxis: [number, number, number];
  visible: boolean;
}

/** The three base planes, in the order the panel lists them. */
export function defaultPlanes(): DocPlane[] {
  return [
    { id: 'xy', name: 'XY 基准面', origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], visible: true },
    { id: 'yz', name: 'YZ 基准面', origin: [0, 0, 0], u: [0, 1, 0], v: [0, 0, 1], visible: true },
    { id: 'zx', name: 'ZX 基准面', origin: [0, 0, 0], u: [0, 0, 1], v: [1, 0, 0], visible: true },
  ];
}

/** The world coordinate system. User-made frames are appended after it. */
export function defaultFrames(): DocFrame[] {
  return [
    {
      id: 'world',
      name: '世界坐标系',
      origin: [0, 0, 0],
      xAxis: [1, 0, 0],
      yAxis: [0, 1, 0],
      visible: true,
    },
  ];
}

/** The plane an entity sits on, defaulting to XY. */
export function findPlane(doc: CadDocument, id: PlaneId): DocPlane | undefined {
  return doc.planes.find((p) => p.id === id);
}

/** The plane's unit normal, `u × v`. */
export function planeNormal(p: DocPlane): [number, number, number] {
  const [ux, uy, uz] = p.u;
  const [vx, vy, vz] = p.v;
  const n: [number, number, number] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}

/** Flatten a plane into the kernel's `origin, u, v` frame (9 numbers). */
export function planeFrame(p: DocPlane): Float64Array {
  return Float64Array.from([...p.origin, ...p.u, ...p.v]);
}

// ---------------------------------------------------------------------------
// Feature tree (stage 1)
// ---------------------------------------------------------------------------

export type SketchId = string;
export type FeatureId = string;

/**
 * A sketch — the entities living on one datum plane, and their **only** host.
 *
 * "One plane = one sketch" is not a new rule: the constraint solver and the 2D
 * renderer already grouped by `planeOf(e) === doc.activePlane` before stage 1.
 * What changed in step 3 is that the grouping is now *stored*: a sketch is a
 * document object with its own id and name, and the plane lives here rather
 * than on each entity.
 */
export interface Sketch {
  id: SketchId;
  name: string;
  plane: PlaneId;
  entities: Entity[];
}

/** Fields every feature carries. `suppressed` skips evaluation, keeps the node. */
export interface FeatureBase {
  id: FeatureId;
  name: string;
  suppressed?: boolean;
}

/**
 * An extrusion — a closed 2D curve pulled along its sketch plane's normal.
 *
 * What the old `Solid` side-table entry becomes, and it inherits that type's
 * two load-bearing properties: it is **not** a member of the `Entity` union
 * (`Entity` *is* the 2D sketch — what `packScene` encodes, what the picker
 * hit-tests, what the properties panel edits, what DXF round-trips; a feature
 * is none of those), and it is *parametric*: `profile` + `height` are the
 * intent, the triangle mesh is re-derived by the kernel on demand, so editing
 * the sketch or the height changes the solid with nothing baked.
 *
 * `profile` split out of the old `source` because a feature has its own place
 * in the tree: it can no longer be found by "look in the active sketch".
 */
export interface ExtrudeFeature extends FeatureBase {
  kind: 'extrude';
  sketch: SketchId;
  /** Only this one closed curve; `null` = every closed region of the sketch. */
  profile: EntityId | null;
  height: number;
  layer: LayerId;
}

/**
 * A pattern — one feature repeated (work package 3.6).
 *
 * The instances are **derived, not copied**: the node stores "this source, this
 * many, this far apart", and the evaluator re-reads the source's *own*
 * parameters on every evaluation. Change the source hole's diameter and every
 * instance changes at once — which is the entire reason to pattern at feature
 * level rather than duplicating geometry.
 *
 * A row along the source's own in-plane axes today (which way those axes point is
 * the kernel's business — `perpendicular_basis` — not a second convention the
 * front end invents). A circular pattern is more fields on this same node, not a
 * new kind.
 */
export interface PatternFeature extends FeatureBase {
  kind: 'pattern';
  /** The feature being repeated. Only a hole can be patterned today. */
  source: FeatureId;
  /** Instances along the source's in-plane `u` axis, the source included. */
  count: number;
  /** Centre-to-centre distance along `u`, model units. */
  spacing: number;
  /**
   * Instances along the perpendicular in-plane axis, the source's own row
   * included — `1` keeps a single row, `2` makes a grid. Both axes together are
   * `count × countV` holes.
   */
  countV: number;
  /** Centre-to-centre distance along that second axis. */
  spacingV: number;
  layer: LayerId;
}

/**
 * The feature kinds. Extrude and revolve read a sketch, boolean reads two
 * features, a hole generates its own cutter from a face, and a pattern reads
 * another feature's *parameters* and repeats them.
 */
export type Feature =
  | ExtrudeFeature
  | RevolveFeature
  | BooleanFeature
  | HoleFeature
  | PatternFeature;

/**
 * A lathe: a profile revolved around an axis by `angle` radians.
 *
 * The axis is an **entity id**, not a stored point+direction: the centreline is
 * drawn in the sketch like the profile is, so moving that line changes the
 * solid, deleting it turns the feature into an error node, and neither is a
 * second copy of a fact the sketch already holds. Same reasoning as `profile`
 * — and the same reason this lives in the tree rather than in a side table.
 */
export interface RevolveFeature extends FeatureBase {
  kind: 'revolve';
  sketch: SketchId;
  /** The closed curve to lathe; `null` = every closed region of the sketch. */
  profile: EntityId | null;
  /** The line entity in the same sketch to revolve around. */
  axis: EntityId;
  /** Sweep angle in radians; negative sweeps the other way. */
  angle: number;
  layer: LayerId;
}

/**
 * Stage 3 placeholder — a boolean of two features. Same contract as
 * `RevolveFeature`: in the union, reported as unimplemented, never created.
 */
export interface BooleanFeature extends FeatureBase {
  kind: 'boolean';
  op: 'union' | 'subtract' | 'intersect';
  a: FeatureId;
  b: FeatureId;
  layer: LayerId;
}

/**
 * A drilled hole (work package 3.2) — a boolean whose cutter is **generated**
 * rather than being a second feature.
 *
 * The cutter is a cylinder built from what the user actually clicked: a point
 * on a face and that face's outward normal. Storing those two things, instead
 * of expanding the operation into a generated sketch + extrude + boolean, is
 * what keeps a hole parametric *and* readable: change the diameter and the cut
 * is rebuilt, with no extra nodes in the tree to keep in step.
 *
 * `depth === 0` means **through** — sized by the kernel from the solid's own
 * extent, because "far enough to exit" is not a number the user should have to
 * guess.
 */
export interface HoleFeature extends FeatureBase {
  kind: 'hole';
  /** The solid being drilled — must appear before this node in the tree. */
  solid: FeatureId;
  /** Entry point on that solid's surface, in world coordinates. */
  at: [number, number, number];
  /** The face's outward normal there; the hole runs the other way. */
  normal: [number, number, number];
  /** Hole diameter, model units. */
  diameter: number;
  /** Depth into the material; `0` = through. */
  depth: number;
  /**
   * Counterbore: a wider, shallower recess at the entry, for a socket-head
   * screw to sit in. `0` = none. A *conical* countersink (flat-head screw) is a
   * different cutter and a separate piece of work.
   */
  boreDiameter: number;
  /** How deep that recess goes; ignored when `boreDiameter` is 0. */
  boreDepth: number;
  layer: LayerId;
}

/**
 * One row of the feature tree. The list is ordered = evaluation order = display
 * order, and a sketch node always precedes the features that consume it.
 */
export type TreeNode =
  | { kind: 'sketch'; sketch: Sketch }
  | { kind: 'feature'; feature: Feature };

export interface CadDocument {
  meta: DocumentMeta;
  settings: DrawingSettings;
  layers: Layer[];
  currentLayer: LayerId;
  /**
   * The feature tree: sketches and features in one ordered list. Entities live
   * **only** inside sketch nodes — there is no flat entity array any more, so
   * "which entities" is always a question about the tree (`core/doc.ts`), and
   * adding a feature kind never means touching the 2D pipeline.
   */
  nodes: TreeNode[];
  /**
   * The sketch being edited. The 2D view, picker, snap, constraint analysis
   * and DXF all look at exactly this sketch's entities.
   */
  activeSketch: SketchId;
  /** Datum planes. The three base planes always come first and cannot be removed. */
  planes: DocPlane[];
  /** Reference coordinate systems — the world frame, plus any user-made ones. */
  frames: DocFrame[];
  /**
   * The plane new geometry is associated with. Kept in step with
   * `activeSketch`'s plane by every path that changes either — a divergence
   * would be the status bar naming one plane while the canvas draws another.
   */
  activePlane: PlaneId;
  /**
   * Parametric relationships between entities.
   *
   * Kept as a flat document-level list rather than a field on each entity
   * because a constraint belongs to *two* curves — storing it on either one
   * would make deleting the other leave a dangling half. See
   * `constraintsForEntity` for the lookup both directions need. A constraint
   * is only ever *solved* within one sketch (the active one), but it is stored
   * document-wide so deleting a curve takes its relationships with it.
   */
  constraints: Constraint[];
}

// ---------------------------------------------------------------------------
// Snap results
// ---------------------------------------------------------------------------

export interface SnapHit {
  point: Vec2;
  kind: OsnapMode;
  entityIndex: number;
  distance: number;
}

/** Raw snap payload exactly as the kernel emits it. */
export interface RawSnap {
  x: number;
  y: number;
  kind: number;
  entity: number;
  distance: number;
  found: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_OSNAP_MODES: OsnapMode[] = [
  'endpoint',
  'midpoint',
  'center',
  'quadrant',
  'perpendicular',
  'intersection',
];

export const DEFAULT_LAYER: Layer = {
  id: 'layer-0',
  name: '0',
  color: '#e8e8e8',
  lineStyle: 'continuous',
  lineWeight: 0.25,
  visible: true,
  locked: false,
  frozen: false,
  printable: true,
};

export const DEFAULT_SETTINGS: DrawingSettings = {
  gridSpacing: 10,
  gridSubdivisions: 5,
  snapAperturePx: 14,
  pickAperturePx: 8,
  osnapModes: [...DEFAULT_OSNAP_MODES],
  constraint: 'none',
  polarIncrement: 30,
  polarTracking: false,
  units: 'mm',
  annotationScale: 1,
};

export function createEmptyDocument(title = 'Drawing1'): CadDocument {
  const now = new Date().toISOString();
  // One empty sketch on XY — the host new entities need and the one the 2D
  // view edits. Its id is deterministic on purpose: runtime-created sketches
  // get generated ids (`newSketchId`), and nothing in the app ever merges two
  // empty documents, so a fixed first id cannot collide.
  const sketch: Sketch = { id: 'sketch-1', name: '草图1', plane: XY_PLANE, entities: [] };
  return {
    meta: {
      title,
      author: '',
      createdAt: now,
      modifiedAt: now,
      // Kept in step with `FILE_VERSION` in `io/json.ts` — a fresh document is
      // born at the current schema version.
      version: 2,
    },
    settings: { ...DEFAULT_SETTINGS, osnapModes: [...DEFAULT_OSNAP_MODES] },
    layers: [{ ...DEFAULT_LAYER }],
    currentLayer: DEFAULT_LAYER.id,
    nodes: [{ kind: 'sketch', sketch }],
    activeSketch: sketch.id,
    planes: defaultPlanes(),
    frames: defaultFrames(),
    activePlane: XY_PLANE,
    constraints: [],
  };
}

// ---------------------------------------------------------------------------
// Small helpers used all over the UI
// ---------------------------------------------------------------------------

export const v = (x: number, y: number): Vec2 => ({ x, y });

export const vAdd = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const vSub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const vScale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const vLen = (a: Vec2): number => Math.hypot(a.x, a.y);
export const vDist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const vDot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const vCross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const vLerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
export const vAngle = (a: Vec2): number => Math.atan2(a.y, a.x);

export function vNorm(a: Vec2): Vec2 {
  const l = Math.hypot(a.x, a.y);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

export function vRot(a: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}

/** Round to a sensible number of decimals for display. */
export function fmt(n: number, digits = 3): string {
  if (!Number.isFinite(n)) return '—';
  const s = n.toFixed(digits);
  // Trim trailing zeros but always keep at least one decimal place.
  return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0');
}

export function fmtAngle(radians: number, digits = 2): string {
  let deg = (radians * 180) / Math.PI;
  deg = ((deg % 360) + 360) % 360;
  return `${deg.toFixed(digits)}°`;
}
