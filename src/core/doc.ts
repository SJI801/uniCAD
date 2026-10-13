/**
 * Document selectors — the one place that answers "which entities?".
 *
 * Stage 1, step 3 of `PHASE1_PLAN.md`: the document *is* a feature tree now.
 * `nodes` is the ordered list (evaluation order = display order), sketch nodes
 * are the only host of entities, and this module is the single reader of that
 * shape — the 2D pipeline, the solver bridge, IO and the panels all ask here
 * instead of walking `nodes` themselves. That is what lets stage 2's evaluator
 * and stage 1.4's tree panel change what "the document" means without touching
 * their call sites.
 *
 * Everything here is a pure function of the document — no store, no DOM, no
 * logging — so the probes can call them directly.
 */

import type {
  CadDocument,
  DocPlane,
  Entity,
  EntityId,
  Feature,
  FeatureId,
  LayerId,
  PlaneId,
  Sketch,
  SketchId,
  TreeNode,
} from './types';
import { XY_PLANE } from './types';
import { newSketchId } from './entities';

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/** The sketch node of one id, or `undefined`. */
export function findSketch(doc: CadDocument, sketchId: SketchId): Sketch | undefined {
  for (const n of doc.nodes) {
    if (n.kind === 'sketch' && n.sketch.id === sketchId) return n.sketch;
  }
  return undefined;
}

/**
 * The sketch on one plane. "One plane = one sketch" is the stage-1 rule — the
 * grouping the solver and renderer already applied before the tree existed.
 */
export function sketchOfPlane(doc: CadDocument, plane: PlaneId): Sketch | undefined {
  for (const n of doc.nodes) {
    if (n.kind === 'sketch' && n.sketch.plane === plane) return n.sketch;
  }
  return undefined;
}

/**
 * The sketch being edited. Falls back to the first sketch node if the stored
 * id names nothing — every document has at least one sketch (an empty one at
 * worst), so this never returns `undefined`.
 */
export function activeSketch(doc: CadDocument): Sketch {
  return findSketch(doc, doc.activeSketch) ?? sketchesOf(doc)[0]!;
}

/** The active sketch's entities — the single entry point for the 2D pipeline. */
export function sketchEntities(doc: CadDocument): Entity[] {
  return activeSketch(doc).entities;
}

/** Look up one entity by id across all sketches (constraints, patches, selection). */
export function findEntity(doc: CadDocument, id: EntityId): Entity | undefined {
  for (const n of doc.nodes) {
    if (n.kind !== 'sketch') continue;
    const hit = n.sketch.entities.find((e) => e.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/** The sketch an entity belongs to, or `undefined` for an unknown id. */
export function sketchOfEntity(doc: CadDocument, id: EntityId): Sketch | undefined {
  for (const n of doc.nodes) {
    if (n.kind !== 'sketch') continue;
    if (n.sketch.entities.some((e) => e.id === id)) return n.sketch;
  }
  return undefined;
}

/** Every entity of one sketch — a copy. The live array is `sketchSlots`. */
export function entitiesOfSketch(doc: CadDocument, sketchId: SketchId): Entity[] {
  const s = findSketch(doc, sketchId);
  return s ? [...s.entities] : [];
}

/**
 * The sketch a feature consumes **directly**, or `undefined`.
 *
 * Extrude and revolve name one; a boolean names two *features* and a hole names
 * a *solid*, so their tie to a sketch is transitive. Callers that guard a sketch
 * against deletion want exactly this: a direct reference is one that would break
 * the moment the sketch went away.
 */
export function sketchRefOf(f: Feature): SketchId | undefined {
  return f.kind === 'extrude' || f.kind === 'revolve' ? f.sketch : undefined;
}

/** Every sketch in the document, in tree order. */
export function sketchesOf(doc: CadDocument): Sketch[] {
  const out: Sketch[] = [];
  for (const n of doc.nodes) if (n.kind === 'sketch') out.push(n.sketch);
  return out;
}

/** The whole tree, in evaluation order. */
export function treeNodes(doc: CadDocument): TreeNode[] {
  return doc.nodes;
}

/** Every feature in the document, in tree order. */
export function featuresOf(doc: CadDocument): Feature[] {
  const out: Feature[] = [];
  for (const n of doc.nodes) if (n.kind === 'feature') out.push(n.feature);
  return out;
}

/** One feature by id, or `undefined`. */
export function findFeature(doc: CadDocument, id: FeatureId): Feature | undefined {
  for (const n of doc.nodes) {
    if (n.kind === 'feature' && n.feature.id === id) return n.feature;
  }
  return undefined;
}

/** Every entity in the document, sketch by sketch in tree order. */
export function allEntities(doc: CadDocument): Entity[] {
  const out: Entity[] = [];
  for (const n of doc.nodes) {
    if (n.kind !== 'sketch') continue;
    for (const e of n.sketch.entities) out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writers — the patch layer and the importers, nobody else
// ---------------------------------------------------------------------------

/**
 * The live entity array of one sketch, **by reference** — the patch layer's
 * write handle (`applyPatch` / `revertPatch`). `undefined` when the id names
 * no sketch: callers no-op, the same way a missing entity id always was.
 */
export function sketchSlots(doc: CadDocument, sketchId: SketchId): Entity[] | undefined {
  return findSketch(doc, sketchId)?.entities;
}

/** Append entities to one sketch — the import route. */
export function appendEntities(doc: CadDocument, sketchId: SketchId, list: readonly Entity[]): void {
  const slots = sketchSlots(doc, sketchId);
  if (!slots) return;
  for (const e of list) slots.push(e);
}

/**
 * Replace one sketch's entities **in place** (array identity preserved).
 *
 * For imports and `seedDemo`, which build a fresh document and fill its one
 * sketch. In-place rather than assignment so anything holding the array
 * reference keeps seeing the same list.
 */
export function replaceEntities(doc: CadDocument, sketchId: SketchId, list: readonly Entity[]): void {
  const slots = sketchSlots(doc, sketchId);
  if (!slots) return;
  slots.length = 0;
  for (const e of list) slots.push(e);
}

/**
 * Where a feature created from `sketchId` belongs in `nodes`: immediately
 * after that sketch. The sketch always precedes the features that consume it,
 * and in the common case — a sketch followed by its features — this reads
 * exactly as "after the sketch, before its first feature".
 */
export function featureInsertIndex(doc: CadDocument, sketchId: SketchId): number {
  const i = doc.nodes.findIndex((n) => n.kind === 'sketch' && n.sketch.id === sketchId);
  return i >= 0 ? i + 1 : doc.nodes.length;
}

// ---------------------------------------------------------------------------
// v1 → v2 (work package 1.6)
// ---------------------------------------------------------------------------

/** A v1 entity as decoded from disk: the entity plus the plane it was stamped with. */
export interface LegacyEntity {
  entity: Entity;
  plane: PlaneId;
}

/** The v1 side-table solid, as decoded from disk. */
export interface LegacySolid {
  id: string;
  source: EntityId;
  height: number;
  layer: LayerId;
}

/**
 * Group a v1 document's flat entity list + solids into the v2 tree.
 *
 * The one implementation of the migration's grouping rules, shared by
 * `migrate()` in `io/json.ts` (reading a v1 file) and `ensureV2` below (a
 * hand-built or legacy document reaching the store) — two implementations of
 * "which sketch does this entity belong to" is exactly how they would drift.
 *
 * Rules (`PHASE1_PLAN.md` 1.6):
 *   1. one sketch per plane, XY first, the rest by first appearance;
 *   2. an empty entity list still yields one empty XY sketch — new entities
 *      need a host;
 *   3. solids become extrude features, in their original order, after the
 *      sketches, each pointing at the sketch that holds its profile;
 *   4. the XY sketch is the active one (and `activePlane` follows it), so the
 *      migrated document opens on the plane the rule puts first.
 */
export function treeFromLegacy(
  entities: readonly LegacyEntity[],
  solids: readonly LegacySolid[],
  planes: readonly DocPlane[],
): { nodes: TreeNode[]; activeSketch: SketchId; activePlane: PlaneId } {
  const planeName = (id: PlaneId): string => planes.find((p) => p.id === id)?.name ?? id;

  // Rule 1: distinct planes in order of first appearance, XY hoisted.
  const order: PlaneId[] = [];
  for (const { plane } of entities) if (!order.includes(plane)) order.push(plane);
  const xy = order.indexOf(XY_PLANE);
  if (xy > 0) {
    order.splice(xy, 1);
    order.unshift(XY_PLANE);
  }
  // Rule 2: nothing at all still gets the XY sketch.
  if (order.length === 0) order.push(XY_PLANE);

  const sketchByPlane = new Map<PlaneId, Sketch>();
  const nodes: TreeNode[] = [];
  for (const plane of order) {
    const sketch: Sketch = {
      id: newSketchId(),
      name: planeName(plane),
      plane,
      entities: [],
    };
    sketchByPlane.set(plane, sketch);
    nodes.push({ kind: 'sketch', sketch });
  }
  for (const { entity, plane } of entities) sketchByPlane.get(plane)?.entities.push(entity);

  // Rule 3: features after the sketches, in the solids' original order. A
  // solid whose profile is missing (the loader keeps those) falls back to the
  // XY sketch — the evaluator (stage 2) is what reports it as an error, not
  // the migration.
  solids.forEach((s, i) => {
    const profile = entities.find((le) => le.entity.id === s.source);
    const plane = profile ? profile.plane : XY_PLANE;
    const sketch = sketchByPlane.get(plane) ?? sketchByPlane.get(XY_PLANE)!;
    nodes.push({
      kind: 'feature',
      feature: {
        kind: 'extrude',
        id: s.id,
        name: `拉伸 ${i + 1}`,
        sketch: sketch.id,
        profile: s.source,
        height: s.height,
        layer: s.layer,
      },
    });
  });

  // Rule 4: XY is the editing context after a migration.
  const active = sketchByPlane.get(XY_PLANE)!;
  return { nodes, activeSketch: active.id, activePlane: active.plane };
}

/**
 * Normalise a document into the tree shape — the store's entry invariant.
 *
 * A document that still carries a flat `entities` array (a v1 file decoded by
 * an older path, or a hand-built object) is rebuilt here with the rules above;
 * one that already has `nodes` passes through untouched, which makes this
 * idempotent — a v2 document read twice does not grow a second sketch.
 */
export function ensureV2(doc: CadDocument): CadDocument {
  const legacy = doc as unknown as { entities?: unknown; solids?: unknown };
  if (!Array.isArray(legacy.entities)) return doc;
  const entities = legacy.entities as Entity[];
  const solids = Array.isArray(legacy.solids) ? (legacy.solids as LegacySolid[]) : [];
  // The rebuilt entities keep whatever plane they were stamped with; entities
  // with no stamp are XY, which is what the v1 format always meant.
  const legacyEntities: LegacyEntity[] = entities.map((e) => ({
    entity: e,
    plane: ((e as unknown as { plane?: PlaneId }).plane ?? XY_PLANE) as PlaneId,
  }));
  const { nodes, activeSketch, activePlane } = treeFromLegacy(legacyEntities, solids, doc.planes);
  return { ...doc, nodes, activeSketch, activePlane, constraints: doc.constraints };
}

/** One empty sketch — for documents (and planes) that have never been drawn on. */
export function emptySketch(plane: PlaneId, name: string): Sketch {
  return { id: newSketchId(), name, plane, entities: [] };
}

/** 人类可读的特征种类名，用于默认特征名与树面板。 */
export const FEATURE_LABEL: Record<Feature['kind'], string> = {
  extrude: '拉伸',
  revolve: '旋转',
  boolean: '布尔',
  hole: '孔',
  pattern: '阵列',
  loft: '放样',
};

/**
 * The next default name for a feature of `kind` — counted **per kind**, so a
 * revolve added after an extrude is `旋转 1`, not `旋转 2`. Names are labels;
 * two features can share one without breaking anything, but a count that
 * skipped a number would look like the tree lost a node.
 */
export function nextFeatureName(doc: CadDocument, kind: Feature['kind']): string {
  const n = featuresOf(doc).filter((f) => f.kind === kind).length + 1;
  return `${FEATURE_LABEL[kind]} ${n}`;
}

/** `草图 N` for the next sketch, counting what the tree already holds. */
export function nextSketchName(doc: CadDocument): string {
  return `草图 ${sketchesOf(doc).length + 1}`;
}
