/**
 * Entity construction, cloning and attribute resolution.
 *
 * Centralising this keeps layer/colour/linetype inheritance in one place and
 * gives every tool a uniform way to mint entities with stable ids.
 */

import type {
  Aabb,
  ArcEntity,
  CadDocument,
  CircleEntity,
  ConstraintPointKind,
  Entity,
  EllipseEntity,
  Layer,
  LayerId,
  LineEntity,
  LineStyle,
  PolylineEntity,
  Vec2,
} from './types';

// ---------------------------------------------------------------------------
// Id generation
// ---------------------------------------------------------------------------

let counter = 0;

/** One monotonic id with a random suffix — collision-free within a session. */
function mintId(prefix: string): string {
  counter += 1;
  // Include a random suffix so ids remain unique when files are merged.
  const rnd = Math.floor(Math.random() * 0xffff).toString(36);
  return `${prefix}-${counter.toString(36)}-${rnd}`;
}

/** Monotonic, collision-free-within-a-session entity id. */
export function newEntityId(prefix = 'e'): string {
  return mintId(prefix);
}

/**
 * Sketch ids share the entity counter but not its prefix — a sketch is a tree
 * node, not geometry, and "which kind of thing is this id" should be readable
 * from the id itself (the tree panel and the patch layer both key on it).
 */
export function newSketchId(): string {
  return mintId('sketch');
}

/** Feature ids, same reasoning as sketches. */
export function newFeatureId(): string {
  return mintId('f');
}

export function newLayerId(name: string): LayerId {
  return `layer-${name.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Math.floor(Math.random() * 0xffff).toString(36)}`;
}

/** Reset the id counter — used by tests that assert on generated ids. */
export function resetIdCounter(): void {
  counter = 0;
}

// ---------------------------------------------------------------------------
// Attribute resolution
// ---------------------------------------------------------------------------

/** Resolved display attributes for an entity (layer inheritance applied). */
export interface ResolvedStyle {
  color: string;
  lineStyle: LineStyle;
  lineWeight: number;
  visible: boolean;
  locked: boolean;
  /** Effective lineweight in millimetres, 0 meaning hairline. */
  effectiveLineWeight: number;
}

export function findLayer(doc: CadDocument, id: LayerId): Layer | undefined {
  return doc.layers.find((l) => l.id === id);
}

export function resolveStyle(doc: CadDocument, e: Entity): ResolvedStyle {
  const layer = findLayer(doc, e.layer);
  const color = e.color ?? layer?.color ?? '#e8e8e8';
  const lineStyle = e.lineStyle ?? layer?.lineStyle ?? 'continuous';
  const lineWeight = e.lineWeight ?? layer?.lineWeight ?? 0.25;
  return {
    color,
    lineStyle,
    lineWeight,
    visible: layer?.visible ?? true,
    locked: layer?.locked ?? false,
    effectiveLineWeight: lineWeight,
  };
}

/** Whether an entity should participate in picking. */
export function isPickable(doc: CadDocument, e: Entity): boolean {
  const layer = findLayer(doc, e.layer);
  if (!layer) return true;
  return layer.visible && !layer.frozen && !layer.locked;
}

/** Whether an entity should be rendered. */
export function isVisible(doc: CadDocument, e: Entity): boolean {
  const layer = findLayer(doc, e.layer);
  if (!layer) return true;
  return layer.visible && !layer.frozen;
}

/** Whether an entity should generate snap candidates. */
export function isSnappable(doc: CadDocument, e: Entity): boolean {
  const layer = findLayer(doc, e.layer);
  if (!layer) return true;
  return layer.visible && !layer.frozen;
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/** Fields supplied by the active tool, with document defaults filled in. */
export interface EntityInit {
  layer: LayerId;
  color?: string | null;
  lineStyle?: LineStyle | null;
  lineWeight?: number | null;
  /**
   * No `plane` here: the hosting sketch owns the plane (stage 1 removed the
   * per-entity stamp). The sketch a new entity joins is decided where the
   * patch is built — `addEntity(sketch, e)` — not by the factory.
   */
  name?: string;
}

function base(init: EntityInit): {
  id: string;
  layer: LayerId;
  color: string | null;
  lineStyle: LineStyle | null;
  lineWeight: number | null;
  name?: string;
} {
  const out: {
    id: string;
    layer: LayerId;
    color: string | null;
    lineStyle: LineStyle | null;
    lineWeight: number | null;
    name?: string;
  } = {
    id: newEntityId(),
    layer: init.layer,
    color: init.color ?? null,
    lineStyle: init.lineStyle ?? null,
    lineWeight: init.lineWeight ?? null,
  };
  if (init.name !== undefined) out.name = init.name;
  return out;
}

export function makeLine(init: EntityInit, a: Vec2, b: Vec2): LineEntity {
  return { ...base(init), type: 'line', a: { ...a }, b: { ...b } };
}

export function makePolyline(init: EntityInit, points: Vec2[], closed = false): PolylineEntity {
  return { ...base(init), type: 'polyline', points: points.map((p) => ({ ...p })), closed };
}

export function makeCircle(init: EntityInit, center: Vec2, radius: number): CircleEntity {
  return { ...base(init), type: 'circle', center: { ...center }, radius: Math.abs(radius) };
}

export function makeArc(
  init: EntityInit,
  center: Vec2,
  radius: number,
  startAngle: number,
  endAngle: number,
): ArcEntity {
  return {
    ...base(init),
    type: 'arc',
    center: { ...center },
    radius: Math.abs(radius),
    startAngle,
    endAngle,
  };
}

export function makeEllipse(
  init: EntityInit,
  center: Vec2,
  rx: number,
  ry: number,
  rotation = 0,
): EllipseEntity {
  return {
    ...base(init),
    type: 'ellipse',
    center: { ...center },
    rx: Math.abs(rx),
    ry: Math.abs(ry),
    rotation,
  };
}

/** Build a rectangle as a closed 5-vertex polyline (so it stays an outline). */
export function makeRect(
  init: EntityInit,
  a: Vec2,
  b: Vec2,
  rotation = 0,
): PolylineEntity {
  const corners: Vec2[] = [
    { x: a.x, y: a.y },
    { x: b.x, y: a.y },
    { x: b.x, y: b.y },
    { x: a.x, y: b.y },
  ];
  if (rotation !== 0) {
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    for (const c of corners) {
      const dx = c.x - cx;
      const dy = c.y - cy;
      c.x = cx + dx * cos - dy * sin;
      c.y = cy + dx * sin + dy * cos;
    }
  }
  return makePolyline(init, corners, true);
}

// ---------------------------------------------------------------------------
// Cloning / equality
// ---------------------------------------------------------------------------

/** Deep-clone an entity, optionally with a fresh id. */
export function cloneEntity(e: Entity, freshId = true): Entity {
  const copy = structuredClone(e) as Entity;
  if (freshId) copy.id = newEntityId();
  return copy;
}

/** Structural equality, ignoring ids. Used to skip no-op undo entries. */
export function geometryEquals(a: Entity, b: Entity): boolean {
  if (a.type !== b.type) return false;
  const strip = (e: Entity): unknown => {
    const o = { ...(e as unknown as Record<string, unknown>) };
    delete o['id'];
    return o;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

/**
 * Keys that describe **how** an entity looks, not **where** it is.
 *
 * `geometryEquals` answers "is this record byte-identical apart from its id?",
 * which is the right question for skipping no-op undo entries. The 0.4 geometry
 * lock (see `refusesGeometryEdit` in `editorStore`) needs a narrower one:
 * recolouring a locked curve, or moving it to another layer, must stay allowed —
 * only its *shape* is frozen. The two functions differ by exactly this list.
 */
const APPEARANCE_KEYS = [
  'id',
  'layer',
  'color',
  'lineStyle',
  'lineWeight',
  'plane',
  'name',
] as const;

/**
 * Shape-and-position equality: everything `geometryEquals` compares except the
 * appearance keys above.
 */
export function shapeEquals(a: Entity, b: Entity): boolean {
  if (a.type !== b.type) return false;
  const strip = (e: Entity): string => {
    const o = { ...(e as unknown as Record<string, unknown>) };
    for (const k of APPEARANCE_KEYS) delete o[k];
    return JSON.stringify(o);
  };
  return strip(a) === strip(b);
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Conservative pure-TS bounding box, used before the kernel is ready and for
 * quick culling without crossing the FFI boundary.
 *
 * It deliberately over-estimates for arcs (full-circle bounds) — tile-level
 * culling only needs to be conservative, and the kernel provides the exact
 * bounds when precision matters.
 */
export function entityBoundsTS(e: Entity): Aabb {
  switch (e.type) {
    case 'line': {
      const l = e as LineEntity;
      return {
        minX: Math.min(l.a.x, l.b.x),
        minY: Math.min(l.a.y, l.b.y),
        maxX: Math.max(l.a.x, l.b.x),
        maxY: Math.max(l.a.y, l.b.y),
      };
    }
    case 'circle': {
      const c = e as CircleEntity;
      return {
        minX: c.center.x - c.radius,
        minY: c.center.y - c.radius,
        maxX: c.center.x + c.radius,
        maxY: c.center.y + c.radius,
      };
    }
    case 'arc': {
      const a = e as ArcEntity;
      // Tight bounds: include the axis extremes the sweep crosses.
      let minX = Math.min(
        a.center.x + a.radius * Math.cos(a.startAngle),
        a.center.x + a.radius * Math.cos(a.endAngle),
      );
      let maxX = Math.max(
        a.center.x + a.radius * Math.cos(a.startAngle),
        a.center.x + a.radius * Math.cos(a.endAngle),
      );
      let minY = Math.min(
        a.center.y + a.radius * Math.sin(a.startAngle),
        a.center.y + a.radius * Math.sin(a.endAngle),
      );
      let maxY = Math.max(
        a.center.y + a.radius * Math.sin(a.startAngle),
        a.center.y + a.radius * Math.sin(a.endAngle),
      );
      const sweep = normalizeSweep(a.startAngle, a.endAngle);
      for (const q of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
        if (angleInSweep(q, a.startAngle, sweep)) {
          const px = a.center.x + a.radius * Math.cos(q);
          const py = a.center.y + a.radius * Math.sin(q);
          minX = Math.min(minX, px);
          maxX = Math.max(maxX, px);
          minY = Math.min(minY, py);
          maxY = Math.max(maxY, py);
        }
      }
      return { minX, minY, maxX, maxY };
    }
    case 'ellipse': {
      const el = e as EllipseEntity;
      const c = Math.cos(el.rotation);
      const s = Math.sin(el.rotation);
      const hx = Math.hypot(el.rx * c, el.ry * s);
      const hy = Math.hypot(el.rx * s, el.ry * c);
      return {
        minX: el.center.x - hx,
        minY: el.center.y - hy,
        maxX: el.center.x + hx,
        maxY: el.center.y + hy,
      };
    }
    case 'polyline': {
      const p = e as PolylineEntity;
      if (p.points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const pt of p.points) {
        if (pt.x < minX) minX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y > maxY) maxY = pt.y;
      }
      return { minX, minY, maxX, maxY };
    }
  }
}

export function normalizeSweep(start: number, end: number): number {
  const TAU = Math.PI * 2;
  let s = (end - start) % TAU;
  if (s < 0) s += TAU;
  return s;
}

export function angleInSweep(angle: number, start: number, sweep: number): boolean {
  const TAU = Math.PI * 2;
  let rel = (angle - start) % TAU;
  if (rel < 0) rel += TAU;
  if (sweep <= 1e-12) return true;
  return rel <= sweep + 1e-9;
}

/** Merge two boxes. */
export function unionBounds(a: Aabb | null, b: Aabb | null): Aabb | null {
  if (!a) return b;
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/** Bounds of a whole entity list. */
export function sceneBounds(entities: readonly Entity[]): Aabb | null {
  let acc: Aabb | null = null;
  for (const e of entities) acc = unionBounds(acc, entityBoundsTS(e));
  return acc;
}

export function boundsCenter(b: Aabb): Vec2 {
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

export function boundsSize(b: Aabb): { width: number; height: number } {
  return { width: b.maxX - b.minX, height: b.maxY - b.minY };
}

// ---------------------------------------------------------------------------
// Named points
// ---------------------------------------------------------------------------

/**
 * A point on an arc's circle at `angle`.
 *
 * The single definition of "where does an arc actually start". It used to be
 * written out inline wherever it was needed (the grip layer, the constraint
 * layer), which is how a radius or a sign ends up corrected in one place only.
 */
export function arcPointAt(center: Vec2, radius: number, angle: number): Vec2 {
  return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
}

/**
 * The point a constraint target names, in model coordinates, or `null` when the
 * primitive has no such point (a circle has no "start" — it is not from here to
 * there).
 *
 * This list has to agree with `point_of` in `kernel/src/constraints.rs`. It is
 * what the menu uses to decide whether a constraint can apply; if the two ever
 * disagree, a constraint would be offered for a point the solver cannot find and
 * would then be silently dropped during validation.
 */
export function constraintPointAt(
  e: Entity,
  point: ConstraintPointKind,
  index = 0,
): Vec2 | null {
  switch (e.type) {
    case 'line':
      if (point === 'start') return e.a;
      if (point === 'end') return e.b;
      return null;
    case 'arc':
      if (point === 'center') return e.center;
      // An arc's start/end are its *endpoints*, not its centre.
      if (point === 'start') return arcPointAt(e.center, e.radius, e.startAngle);
      if (point === 'end') return arcPointAt(e.center, e.radius, e.endAngle);
      return null;
    case 'circle':
    case 'ellipse':
      return point === 'center' ? e.center : null;
    case 'polyline':
      return point === 'vertex' ? (e.points[index] ?? null) : null;
  }
}

/** Human-readable entity kind, used in panels, tooltips and constraint labels. */
/**
 * 把命名点搬回 `at`——距离类约束的「圆心钉扎」用：拖动圆心所在实体时，
 * 被钉点必须留在原位（曲线绕它拉伸/转动），圆心永不移动。
 *
 * 返回 `null` 表示该命名点不是直接存储的坐标（弧的端点由圆心+角度导出），
 * 无法直接钉，调用方跳过。
 */
export function pinNamedPoint(
  e: Entity,
  point: ConstraintPointKind,
  index: number,
  at: Vec2,
): Entity | null {
  switch (e.type) {
    case 'line':
      if (point === 'start') return { ...e, a: at };
      if (point === 'end') return { ...e, b: at };
      return null;
    case 'circle':
      return point === 'center' ? { ...e, center: at } : null;
    case 'ellipse':
      return point === 'center' ? { ...e, center: at } : null;
    case 'polyline':
      if (point === 'vertex' && e.points[index]) {
        const points = e.points.slice();
        points[index] = at;
        return { ...e, points };
      }
      return null;
    default:
      return null;
  }
}

export function describeEntity(e: Entity): string {
  switch (e.type) {
    case 'line':
      return '直线';
    case 'polyline':
      return e.closed ? `闭合多段线 (${e.points.length} 顶点)` : `多段线 (${e.points.length} 顶点)`;
    case 'circle':
      return '圆';
    case 'arc':
      return '圆弧';
    case 'ellipse':
      return '椭圆';
  }
}
