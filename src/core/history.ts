/**
 * Transactional command system with undo / redo.
 *
 * Every mutation goes through a `Command`, which records the minimal inverse
 * patch needed to roll it back. This gives us AutoCAD-style unlimited undo
 * while keeping memory bounded — we store *what changed*, not full document
 * snapshots.
 *
 * Patch model
 * -----------
 * A command produces a list of `Patch` records. Each patch is one of:
 *   - `{ op: 'add', entity }`         — undo removes, redo re-adds
 *   - `{ op: 'remove', entity, index }` — undo re-inserts at `index`
 *   - `{ op: 'update', before, after }` — undo restores `before`
 *
 * Applying the same patch list forwards performs the command; reversing it
 * performs the undo. This makes undo/redo symmetric and testable.
 *
 * Entity patches (`add` / `remove` / `update`) carry an explicit **sketch id**
 * and write through `sketchSlots` from `core/doc.ts`. The id is mandatory, not
 * inferred from the active sketch: "switch sketches, then undo" must put the
 * entity back where it came from, not where the user is standing now
 * (`PHASE1_PLAN.md` risk 5). Tree nodes get their own ops — `sketchAdd` /
 * `sketchRemove` / `featureAdd` / `featureRemove` — with the insert index
 * recorded, because node order *is* evaluation order.
 */

import type {
  CadDocument,
  Constraint,
  DocFrame,
  DocPlane,
  Entity,
  EntityId,
  Feature,
  FeatureId,
  Layer,
  LayerId,
  PlaneId,
  Sketch,
  SketchId,
} from './types';
import { sketchOfEntity, sketchSlots } from './doc';

// ---------------------------------------------------------------------------
// Patches
// ---------------------------------------------------------------------------

export type Patch =
  | { op: 'add'; sketch: SketchId; entity: Entity }
  | { op: 'remove'; sketch: SketchId; entity: Entity; index: number }
  | { op: 'update'; sketch: SketchId; before: Entity; after: Entity }
  | { op: 'layerUpdate'; before: Layer; after: Layer }
  | { op: 'layerAdd'; layer: Layer }
  | { op: 'layerRemove'; layer: Layer; index: number }
  | { op: 'setCurrentLayer'; before: LayerId; after: LayerId }
  | { op: 'constraintAdd'; constraint: Constraint }
  | { op: 'constraintRemove'; constraint: Constraint; index: number }
  /** 尺寸改值：同一约束换目标值；撤销换回 before。 */
  | { op: 'constraintUpdate'; before: Constraint; after: Constraint }
  /** Tree nodes. `index` is where the node sits — order is evaluation order. */
  | { op: 'sketchAdd'; sketch: Sketch; index: number }
  | { op: 'sketchRemove'; sketch: Sketch; index: number }
  /** Rename. The node keeps its place; only the payload changes. */
  | { op: 'sketchUpdate'; before: Sketch; after: Sketch }
  | { op: 'featureAdd'; feature: Feature; index: number }
  | { op: 'featureRemove'; feature: Feature; index: number }
  /** Rename / height / suppress — everything the tree panel edits in place. */
  | { op: 'featureUpdate'; before: Feature; after: Feature }
  | { op: 'setActiveSketch'; before: SketchId; after: SketchId }
  | { op: 'planeAdd'; plane: DocPlane }
  | { op: 'planeRemove'; plane: DocPlane; index: number }
  | { op: 'planeUpdate'; before: DocPlane; after: DocPlane }
  | { op: 'frameAdd'; frame: DocFrame }
  | { op: 'frameRemove'; frame: DocFrame; index: number }
  | { op: 'frameUpdate'; before: DocFrame; after: DocFrame }
  | { op: 'setActivePlane'; before: PlaneId; after: PlaneId };


export interface Command {
  /** Human-readable label shown in the undo history panel. */
  label: string;
  patches: Patch[];
  /** Timestamp, used for grouping rapid successive edits. */
  at: number;
}

// ---------------------------------------------------------------------------
// Applying patches
// ---------------------------------------------------------------------------

function applyPatch(doc: CadDocument, p: Patch): void {
  switch (p.op) {
    case 'add': {
      // The patch names its sketch — never "wherever the user is now".
      const slots = sketchSlots(doc, p.sketch);
      if (slots) slots.push(structuredClone(p.entity));
      break;
    }
    case 'remove': {
      const slots = sketchSlots(doc, p.sketch);
      if (slots) {
        const i = slots.findIndex((e) => e.id === p.entity.id);
        if (i >= 0) slots.splice(i, 1);
      }
      break;
    }
    case 'update': {
      const slots = sketchSlots(doc, p.sketch);
      if (slots) {
        const i = slots.findIndex((e) => e.id === p.after.id);
        if (i >= 0) slots[i] = structuredClone(p.after);
      }
      break;
    }
    case 'layerAdd':
      doc.layers.push(structuredClone(p.layer));
      break;
    case 'layerRemove': {
      const i = doc.layers.findIndex((l) => l.id === p.layer.id);
      if (i >= 0) doc.layers.splice(i, 1);
      break;
    }
    case 'layerUpdate': {
      const i = doc.layers.findIndex((l) => l.id === p.after.id);
      if (i >= 0) doc.layers[i] = structuredClone(p.after);
      break;
    }
    case 'setCurrentLayer':
      doc.currentLayer = p.after;
      break;
    case 'constraintAdd':
      doc.constraints.push(structuredClone(p.constraint));
      break;
    case 'constraintRemove': {
      const i = doc.constraints.findIndex((c) => c.id === p.constraint.id);
      if (i >= 0) doc.constraints.splice(i, 1);
      break;
    }
    case 'constraintUpdate': {
      const i = doc.constraints.findIndex((c) => c.id === p.after.id);
      if (i >= 0) doc.constraints[i] = structuredClone(p.after);
      break;
    }
    case 'sketchAdd':
      doc.nodes.splice(Math.min(p.index, doc.nodes.length), 0, {
        kind: 'sketch',
        sketch: structuredClone(p.sketch),
      });
      break;
    case 'sketchRemove': {
      const i = doc.nodes.findIndex((n) => n.kind === 'sketch' && n.sketch.id === p.sketch.id);
      if (i >= 0) doc.nodes.splice(i, 1);
      break;
    }
    case 'sketchUpdate': {
      const i = doc.nodes.findIndex((n) => n.kind === 'sketch' && n.sketch.id === p.after.id);
      if (i >= 0) doc.nodes[i] = { kind: 'sketch', sketch: structuredClone(p.after) };
      break;
    }
    case 'featureAdd':
      doc.nodes.splice(Math.min(p.index, doc.nodes.length), 0, {
        kind: 'feature',
        feature: structuredClone(p.feature),
      });
      break;
    case 'featureRemove': {
      const i = doc.nodes.findIndex((n) => n.kind === 'feature' && n.feature.id === p.feature.id);
      if (i >= 0) doc.nodes.splice(i, 1);
      break;
    }
    case 'featureUpdate': {
      const i = doc.nodes.findIndex((n) => n.kind === 'feature' && n.feature.id === p.after.id);
      if (i >= 0) doc.nodes[i] = { kind: 'feature', feature: structuredClone(p.after) };
      break;
    }
    case 'setActiveSketch':
      doc.activeSketch = p.after;
      break;
    case 'planeAdd':
      doc.planes.push(structuredClone(p.plane));
      break;
    case 'planeRemove': {
      const i = doc.planes.findIndex((x) => x.id === p.plane.id);
      if (i >= 0) doc.planes.splice(i, 1);
      break;
    }
    case 'planeUpdate': {
      const i = doc.planes.findIndex((x) => x.id === p.after.id);
      if (i >= 0) doc.planes[i] = structuredClone(p.after);
      break;
    }
    case 'frameAdd':
      doc.frames.push(structuredClone(p.frame));
      break;
    case 'frameRemove': {
      const i = doc.frames.findIndex((x) => x.id === p.frame.id);
      if (i >= 0) doc.frames.splice(i, 1);
      break;
    }
    case 'frameUpdate': {
      const i = doc.frames.findIndex((x) => x.id === p.after.id);
      if (i >= 0) doc.frames[i] = structuredClone(p.after);
      break;
    }
    case 'setActivePlane':
      doc.activePlane = p.after;
      break;
  }
}

function revertPatch(doc: CadDocument, p: Patch): void {
  switch (p.op) {
    case 'add': {
      const slots = sketchSlots(doc, p.sketch);
      if (slots) {
        const i = slots.findIndex((e) => e.id === p.entity.id);
        if (i >= 0) slots.splice(i, 1);
      }
      break;
    }
    case 'remove': {
      // Re-insert at the original index so z-order is preserved.
      const slots = sketchSlots(doc, p.sketch);
      if (slots) slots.splice(Math.min(p.index, slots.length), 0, structuredClone(p.entity));
      break;
    }
    case 'update': {
      const slots = sketchSlots(doc, p.sketch);
      if (slots) {
        const i = slots.findIndex((e) => e.id === p.before.id);
        if (i >= 0) slots[i] = structuredClone(p.before);
      }
      break;
    }
    case 'layerAdd': {
      const i = doc.layers.findIndex((l) => l.id === p.layer.id);
      if (i >= 0) doc.layers.splice(i, 1);
      break;
    }
    case 'layerRemove':
      doc.layers.splice(Math.min(p.index, doc.layers.length), 0, structuredClone(p.layer));
      break;
    case 'layerUpdate': {
      const i = doc.layers.findIndex((l) => l.id === p.before.id);
      if (i >= 0) doc.layers[i] = structuredClone(p.before);
      break;
    }
    case 'setCurrentLayer':
      doc.currentLayer = p.before;
      break;
    case 'constraintAdd': {
      const i = doc.constraints.findIndex((c) => c.id === p.constraint.id);
      if (i >= 0) doc.constraints.splice(i, 1);
      break;
    }
    case 'constraintRemove':
      // Same as entity removal: re-insert at the recorded index rather than
      // appending, so the stored order (and therefore the panel listing) is
      // identical after undo/redo.
      doc.constraints.splice(Math.min(p.index, doc.constraints.length), 0, structuredClone(p.constraint));
      break;
    case 'constraintUpdate': {
      const i = doc.constraints.findIndex((c) => c.id === p.before.id);
      if (i >= 0) doc.constraints[i] = structuredClone(p.before);
      break;
    }
    case 'sketchAdd': {
      const i = doc.nodes.findIndex((n) => n.kind === 'sketch' && n.sketch.id === p.sketch.id);
      if (i >= 0) doc.nodes.splice(i, 1);
      break;
    }
    case 'sketchRemove':
      doc.nodes.splice(Math.min(p.index, doc.nodes.length), 0, {
        kind: 'sketch',
        sketch: structuredClone(p.sketch),
      });
      break;
    case 'sketchUpdate': {
      const i = doc.nodes.findIndex((n) => n.kind === 'sketch' && n.sketch.id === p.before.id);
      if (i >= 0) doc.nodes[i] = { kind: 'sketch', sketch: structuredClone(p.before) };
      break;
    }
    case 'featureAdd': {
      const i = doc.nodes.findIndex((n) => n.kind === 'feature' && n.feature.id === p.feature.id);
      if (i >= 0) doc.nodes.splice(i, 1);
      break;
    }
    case 'featureRemove':
      doc.nodes.splice(Math.min(p.index, doc.nodes.length), 0, {
        kind: 'feature',
        feature: structuredClone(p.feature),
      });
      break;
    case 'featureUpdate': {
      const i = doc.nodes.findIndex((n) => n.kind === 'feature' && n.feature.id === p.before.id);
      if (i >= 0) doc.nodes[i] = { kind: 'feature', feature: structuredClone(p.before) };
      break;
    }
    case 'setActiveSketch':
      doc.activeSketch = p.before;
      break;
    case 'planeAdd': {
      const i = doc.planes.findIndex((x) => x.id === p.plane.id);
      if (i >= 0) doc.planes.splice(i, 1);
      break;
    }
    case 'planeRemove':
      doc.planes.splice(Math.min(p.index, doc.planes.length), 0, structuredClone(p.plane));
      break;
    case 'planeUpdate': {
      const i = doc.planes.findIndex((x) => x.id === p.before.id);
      if (i >= 0) doc.planes[i] = structuredClone(p.before);
      break;
    }
    case 'frameAdd': {
      const i = doc.frames.findIndex((x) => x.id === p.frame.id);
      if (i >= 0) doc.frames.splice(i, 1);
      break;
    }
    case 'frameRemove':
      doc.frames.splice(Math.min(p.index, doc.frames.length), 0, structuredClone(p.frame));
      break;
    case 'frameUpdate': {
      const i = doc.frames.findIndex((x) => x.id === p.before.id);
      if (i >= 0) doc.frames[i] = structuredClone(p.before);
      break;
    }
    case 'setActivePlane':
      doc.activePlane = p.before;
      break;
  }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface HistoryState {
  /** Labels of undoable commands, oldest first. */
  undoLabels: string[];
  /** Labels of redoable commands, oldest first. */
  redoLabels: string[];
  canUndo: boolean;
  canRedo: boolean;
}

const MAX_HISTORY = 500;

export class CommandHistory {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];

  /** Number of commands recorded — useful for the "unsaved changes" flag. */
  get depth(): number {
    return this.undoStack.length;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get state(): HistoryState {
    return {
      undoLabels: this.undoStack.map((c) => c.label),
      redoLabels: this.redoStack.map((c) => c.label),
      canUndo: this.canUndo,
      canRedo: this.canRedo,
    };
  }

  /** Execute a command against the document and push it onto the undo stack. */
  execute(doc: CadDocument, cmd: Command): void {
    for (const p of cmd.patches) applyPatch(doc, p);
    this.undoStack.push(cmd);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    // Any new action invalidates the redo branch.
    this.redoStack.length = 0;
  }

  /**
   * Execute a command *without* recording it — for transient state (e.g.
   * panning, preview geometry) that must never be undoable.
   */
  executeEphemeral(doc: CadDocument, cmd: Command): void {
    for (const p of cmd.patches) applyPatch(doc, p);
  }

  undo(doc: CadDocument): Command | null {
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    for (let i = cmd.patches.length - 1; i >= 0; i--) revertPatch(doc, cmd.patches[i]!);
    this.redoStack.push(cmd);
    return cmd;
  }

  redo(doc: CadDocument): Command | null {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    for (const p of cmd.patches) applyPatch(doc, p);
    this.undoStack.push(cmd);
    return cmd;
  }

  /** Discard all history, e.g. after loading a file. */
  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Patch builders — the ergonomic layer tools actually use
// ---------------------------------------------------------------------------

export function addEntity(sketch: SketchId, e: Entity): Patch {
  return { op: 'add', sketch, entity: structuredClone(e) };
}

export function removeEntity(doc: CadDocument, id: EntityId): Patch | null {
  const sketch = sketchOfEntity(doc, id);
  if (!sketch) return null;
  const index = sketch.entities.findIndex((e) => e.id === id);
  if (index < 0) return null;
  return { op: 'remove', sketch: sketch.id, entity: structuredClone(sketch.entities[index]!), index };
}

export function updateEntity(sketch: SketchId, before: Entity, after: Entity): Patch {
  return { op: 'update', sketch, before: structuredClone(before), after: structuredClone(after) };
}

export function addLayer(layer: Layer): Patch {
  return { op: 'layerAdd', layer: structuredClone(layer) };
}

export function removeLayer(doc: CadDocument, id: LayerId): Patch | null {
  const index = doc.layers.findIndex((l) => l.id === id);
  if (index < 0) return null;
  return { op: 'layerRemove', layer: structuredClone(doc.layers[index]!), index };
}

export function updateLayer(before: Layer, after: Layer): Patch {
  return { op: 'layerUpdate', before: structuredClone(before), after: structuredClone(after) };
}

export function setCurrentLayer(before: LayerId, after: LayerId): Patch {
  return { op: 'setCurrentLayer', before, after };
}

export function addConstraint(c: Constraint): Patch {
  return { op: 'constraintAdd', constraint: structuredClone(c) };
}

/** 换掉一条约束（当前只用于尺寸改值）；before/after 成对进同一条补丁，撤销即还原。 */
export function updateConstraint(before: Constraint, after: Constraint): Patch {
  return {
    op: 'constraintUpdate',
    before: structuredClone(before),
    after: structuredClone(after),
  };
}

export function removeConstraint(doc: CadDocument, id: string): Patch | null {
  const index = doc.constraints.findIndex((c) => c.id === id);
  if (index < 0) return null;
  return { op: 'constraintRemove', constraint: structuredClone(doc.constraints[index]!), index };
}

// ---------------------------------------------------------------------------
// Tree-node patches
// ---------------------------------------------------------------------------

export function addSketch(sketch: Sketch, index: number): Patch {
  return { op: 'sketchAdd', sketch: structuredClone(sketch), index };
}

export function removeSketch(doc: CadDocument, id: SketchId): Patch | null {
  const i = doc.nodes.findIndex((n) => n.kind === 'sketch' && n.sketch.id === id);
  if (i < 0) return null;
  const node = doc.nodes[i]!;
  if (node.kind !== 'sketch') return null;
  return { op: 'sketchRemove', sketch: structuredClone(node.sketch), index: i };
}

export function addFeature(feature: Feature, index: number): Patch {
  return { op: 'featureAdd', feature: structuredClone(feature), index };
}

export function removeFeature(doc: CadDocument, id: FeatureId): Patch | null {
  const i = doc.nodes.findIndex((n) => n.kind === 'feature' && n.feature.id === id);
  if (i < 0) return null;
  const node = doc.nodes[i]!;
  if (node.kind !== 'feature') return null;
  return { op: 'featureRemove', feature: structuredClone(node.feature), index: i };
}

/** Rename a sketch. The node keeps its index — order is evaluation order. */
export function updateSketch(before: Sketch, after: Sketch): Patch {
  return { op: 'sketchUpdate', before: structuredClone(before), after: structuredClone(after) };
}

/**
 * Edit a feature in place — rename, height, suppress. One op for all three
 * because the patch layer's job is "the node now says this"; which field moved
 * is the caller's business, and before/after makes undo exact either way.
 */
export function updateFeature(before: Feature, after: Feature): Patch {
  return { op: 'featureUpdate', before: structuredClone(before), after: structuredClone(after) };
}

export function setActiveSketchPatch(before: SketchId, after: SketchId): Patch {
  return { op: 'setActiveSketch', before, after };
}

/**
 * Switching the editing sketch moves the active plane with it — one command,
 * one undo. Both sides are passed in explicitly (rather than looked up) so
 * this also works for a sketch that exists only inside the same command, like
 * the empty one a fresh plane gets on activation.
 */
export function activateSketchPatches(
  before: { sketch: SketchId; plane: PlaneId },
  after: { sketch: SketchId; plane: PlaneId },
): Patch[] {
  const out: Patch[] = [setActiveSketchPatch(before.sketch, after.sketch)];
  if (before.plane !== after.plane) out.push(setActivePlanePatch(before.plane, after.plane));
  return out;
}

/**
 * Removal patches for every feature whose *profile* is being deleted.
 *
 * A feature is derived from its profile curve, so once the curve is gone the
 * feature has nothing to extrude and would sit in the tree as a permanent
 * error node. Deleting it alongside is the rule constraints follow. Sorted by
 * descending node index so the reverse re-insert stays valid.
 */
export function danglingFeatures(doc: CadDocument, ids: Iterable<EntityId>): Patch[] {
  const gone = new Set(ids);
  const doomed: Array<{ f: Feature; i: number }> = [];
  doc.nodes.forEach((n, i) => {
    if (n.kind !== 'feature') return;
    if (n.feature.kind === 'extrude' && n.feature.profile && gone.has(n.feature.profile)) {
      doomed.push({ f: n.feature, i });
    }
  });
  doomed.sort((a, b) => b.i - a.i);
  return doomed.map(({ f, i }) => ({
    op: 'featureRemove' as const,
    feature: structuredClone(f),
    index: i,
  }));
}

export function addPlane(p: DocPlane): Patch {
  return { op: 'planeAdd', plane: structuredClone(p) };
}

export function removePlane(doc: CadDocument, id: PlaneId): Patch | null {
  const index = doc.planes.findIndex((x) => x.id === id);
  if (index < 0) return null;
  return { op: 'planeRemove', plane: structuredClone(doc.planes[index]!), index };
}

export function updatePlane(before: DocPlane, after: DocPlane): Patch {
  return { op: 'planeUpdate', before: structuredClone(before), after: structuredClone(after) };
}

export function addFrame(f: DocFrame): Patch {
  return { op: 'frameAdd', frame: structuredClone(f) };
}

export function removeFrame(doc: CadDocument, id: string): Patch | null {
  const index = doc.frames.findIndex((x) => x.id === id);
  if (index < 0) return null;
  return { op: 'frameRemove', frame: structuredClone(doc.frames[index]!), index };
}

export function updateFrame(before: DocFrame, after: DocFrame): Patch {
  return { op: 'frameUpdate', before: structuredClone(before), after: structuredClone(after) };
}

/** Switching the sketch plane is an undoable document change, like any other. */
export function setActivePlanePatch(before: PlaneId, after: PlaneId): Patch {
  return { op: 'setActivePlane', before, after };
}

/**
 * Removal patches for every constraint that mentions a deleted entity.
 *
 * A constraint is a statement about *two* curves, so deleting either party
 * leaves the other holding a reference to nothing. Left in place it would make
 * every later solve skip over a broken row — and worse, the panel would list a
 * relationship against an object the user can no longer point at.
 *
 * Sorted by descending index, matching `removeManyCommand`, because undo
 * re-inserts at the recorded index in reverse order.
 */
export function danglingConstraints(doc: CadDocument, ids: Iterable<EntityId>): Patch[] {
  const gone = new Set(ids);
  const doomed: Array<{ c: Constraint; i: number }> = [];
  doc.constraints.forEach((c, i) => {
    if (gone.has(c.a.entity) || (c.b ? gone.has(c.b.entity) : false)) doomed.push({ c, i });
  });
  doomed.sort((a, b) => b.i - a.i);
  return doomed.map(({ c, i }) => ({
    op: 'constraintRemove' as const,
    constraint: structuredClone(c),
    index: i,
  }));
}

/** Convenience: build a single-patch command. */
export function command(label: string, ...patches: Patch[]): Command {
  return { label, patches, at: Date.now() };
}

/**
 * Build a command that adds many entities at once — the common case for
 * paste, array and DXF import. The sketch is explicit: a batch that lands in
 * "whatever is active" would put pasted geometry on the wrong plane if the
 * user switched sketches between copy and paste.
 */
export function addManyCommand(sketch: SketchId, label: string, entities: readonly Entity[]): Command {
  return command(label, ...entities.map((e) => addEntity(sketch, e)));
}

/**
 * Build a command that removes many entities at once.
 */
export function removeManyCommand(
  label: string,
  doc: CadDocument,
  ids: readonly EntityId[],
): Command {
  const patches: Patch[] = [];
  for (const id of ids) {
    const p = removeEntity(doc, id);
    if (p) patches.push(p);
  }
  // Remove from the end backwards so indices stay valid while splicing. The
  // indices are per-sketch now; a global descending sort still leaves every
  // sketch's own removals in reverse order, which is all the invariant needs.
  patches.sort((a, b) => {
    const ai = a.op === 'remove' ? a.index : 0;
    const bi = b.op === 'remove' ? b.index : 0;
    return bi - ai;
  });
  // Deleting a curve must take its constraints with it — see
  // `danglingConstraints`. Folded into the same command so one undo brings both
  // the geometry and its relationships back.
  patches.push(...danglingConstraints(doc, ids));
  // …and the features whose profile is gone go with it (a feature has no
  // profile without one).
  patches.push(...danglingFeatures(doc, ids));
  return command(label, ...patches);
}
