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
 */

import type {
  CadDocument,
  Constraint,
  DocFrame,
  DocPlane,
  Entity,
  EntityId,
  Layer,
  LayerId,
  PlaneId,
  Solid,
} from './types';

// ---------------------------------------------------------------------------
// Patches
// ---------------------------------------------------------------------------

export type Patch =
  | { op: 'add'; entity: Entity }
  | { op: 'remove'; entity: Entity; index: number }
  | { op: 'update'; before: Entity; after: Entity }
  | { op: 'layerUpdate'; before: Layer; after: Layer }
  | { op: 'layerAdd'; layer: Layer }
  | { op: 'layerRemove'; layer: Layer; index: number }
  | { op: 'setCurrentLayer'; before: LayerId; after: LayerId }
  | { op: 'constraintAdd'; constraint: Constraint }
  | { op: 'constraintRemove'; constraint: Constraint; index: number }
  /** 尺寸改值：同一约束换目标值；撤销换回 before。 */
  | { op: 'constraintUpdate'; before: Constraint; after: Constraint }
  | { op: 'solidAdd'; solid: Solid }
  | { op: 'solidRemove'; solid: Solid; index: number }
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
    case 'add':
      doc.entities.push(structuredClone(p.entity));
      break;
    case 'remove': {
      const i = doc.entities.findIndex((e) => e.id === p.entity.id);
      if (i >= 0) doc.entities.splice(i, 1);
      break;
    }
    case 'update': {
      const i = doc.entities.findIndex((e) => e.id === p.after.id);
      if (i >= 0) doc.entities[i] = structuredClone(p.after);
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
    case 'solidAdd':
      doc.solids.push(structuredClone(p.solid));
      break;
    case 'solidRemove': {
      const i = doc.solids.findIndex((s) => s.id === p.solid.id);
      if (i >= 0) doc.solids.splice(i, 1);
      break;
    }
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
      const i = doc.entities.findIndex((e) => e.id === p.entity.id);
      if (i >= 0) doc.entities.splice(i, 1);
      break;
    }
    case 'remove':
      // Re-insert at the original index so z-order is preserved.
      doc.entities.splice(Math.min(p.index, doc.entities.length), 0, structuredClone(p.entity));
      break;
    case 'update': {
      const i = doc.entities.findIndex((e) => e.id === p.before.id);
      if (i >= 0) doc.entities[i] = structuredClone(p.before);
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
    case 'solidAdd': {
      const i = doc.solids.findIndex((s) => s.id === p.solid.id);
      if (i >= 0) doc.solids.splice(i, 1);
      break;
    }
    case 'solidRemove':
      doc.solids.splice(Math.min(p.index, doc.solids.length), 0, structuredClone(p.solid));
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

export function addEntity(e: Entity): Patch {
  return { op: 'add', entity: structuredClone(e) };
}

export function removeEntity(doc: CadDocument, id: EntityId): Patch | null {
  const index = doc.entities.findIndex((e) => e.id === id);
  if (index < 0) return null;
  return { op: 'remove', entity: structuredClone(doc.entities[index]!), index };
}

export function updateEntity(before: Entity, after: Entity): Patch {
  return { op: 'update', before: structuredClone(before), after: structuredClone(after) };
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

export function addSolid(s: Solid): Patch {
  return { op: 'solidAdd', solid: structuredClone(s) };
}

export function removeSolid(doc: CadDocument, id: string): Patch | null {
  const index = doc.solids.findIndex((s) => s.id === id);
  if (index < 0) return null;
  return { op: 'solidRemove', solid: structuredClone(doc.solids[index]!), index };
}

/**
 * Removal patches for every solid whose *source sketch* is being deleted.
 *
 * A solid is derived from its sketch, so once the sketch is gone the solid has
 * no profile to extrude and would render as nothing while still occupying a row
 * in any list. Deleting it alongside is the same rule constraints follow. Sorted
 * by descending index so the reverse re-insert stays valid.
 */
export function danglingSolids(doc: CadDocument, ids: Iterable<EntityId>): Patch[] {
  const gone = new Set(ids);
  const doomed: Array<{ s: Solid; i: number }> = [];
  doc.solids.forEach((s, i) => {
    if (gone.has(s.source)) doomed.push({ s, i });
  });
  doomed.sort((a, b) => b.i - a.i);
  return doomed.map(({ s, i }) => ({
    op: 'solidRemove' as const,
    solid: structuredClone(s),
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
 * paste, array and DXF import.
 */
export function addManyCommand(label: string, entities: readonly Entity[]): Command {
  return command(label, ...entities.map(addEntity));
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
  // Remove from the end backwards so indices stay valid while splicing.
  patches.sort((a, b) => {
    const ai = a.op === 'remove' ? a.index : 0;
    const bi = b.op === 'remove' ? b.index : 0;
    return bi - ai;
  });
  // Deleting a curve must take its constraints with it — see
  // `danglingConstraints`. Folded into the same command so one undo brings both
  // the geometry and its relationships back.
  patches.push(...danglingConstraints(doc, ids));
  // …and a sketch's solids go with it too (a solid has no profile without one).
  patches.push(...danglingSolids(doc, ids));
  return command(label, ...patches);
}
