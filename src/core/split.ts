/**
 * Split — break entities apart at their intersection points.
 *
 * The geometry lives in `kernel/src/split.rs`, which reuses `trim.rs`'s
 * parameterisation: a primitive reduces to a scalar `u ∈ [0, 1]`, crossings
 * partition it, and each interval becomes a sub-primitive. Trim drops one
 * interval; split keeps them all. What is left here is choosing *which*
 * entities take part, turning the kernel's reply into real entities, and putting
 * the whole thing in one undoable command.
 *
 * # Scope: the selection, or the whole drawing
 *
 * With a selection, only those entities are broken — but they are cut against
 * **every** visible entity, not just against each other, because the useful case
 * is "this line runs through that wall and I want to grab the piece inside the
 * room". With an empty selection the command applies to the entire visible
 * drawing, which is what makes it a one-click clean-up after an import or a DXF
 * round trip.
 *
 * # Why it is one undo step
 *
 * A busy drawing can turn five entities into thirty. Committing that as thirty
 * commands would mean thirty Ctrl+Z presses to get back, and a half-undone
 * decomposition is a drawing full of overlapping duplicates — visually identical
 * to the state before, which is the worst kind of broken.
 */

import type { CadDocument, Entity, EntityId } from './types';
import { command, addEntity, danglingConstraints, removeEntity, type Command, type Patch } from './history';
import { kernelOrNull, packScene } from './kernel';
import { decodePieceRun } from './trim';

/** One entity's worth of result: which entity, and what it became. */
export interface SplitGroup {
  /** The entity that was broken up. */
  source: Entity;
  /** Its pieces, in order along the original. */
  pieces: Entity[];
}

export type SplitResult =
  | { ok: true; groups: SplitGroup[] }
  | { ok: false; reason: 'noCuts' | 'noKernel' };

/** The tessellation segment cap, matching the renderer's own. */
const MAX_SEG = 64;

/**
 * Tessellation tolerance in model units.
 *
 * Same reasoning as trim's: this runs on a button press, not per frame, so
 * there is no screen aperture to convert, and a fraction of the document grid
 * step is the only scale the document itself offers.
 */
function splitTolerance(doc: CadDocument): number {
  return Math.max(doc.settings.gridSpacing / 64, 1e-9);
}

/**
 * The entities a split may act on: the selection if there is one, otherwise
 * every visible entity.
 *
 * Hidden and frozen layers are excluded because they are not what the user is
 * looking at, and splitting geometry they cannot see — or cannot then select —
 * is how a drawing ends up in a state the UI gives no way back out of.
 */
export function splitTargets(doc: CadDocument, selection: ReadonlySet<EntityId>): Entity[] {
  const targets: Entity[] = [];
  for (const e of doc.entities) {
    const layer = doc.layers.find((l) => l.id === e.layer);
    if (layer && (!layer.visible || layer.frozen)) continue;
    if (selection.size > 0 && !selection.has(e.id)) continue;
    targets.push(e);
  }
  return targets;
}

/**
 * Break `targets` at every intersection with any visible entity.
 *
 * The scene handed to the kernel is the whole visible drawing, not just the
 * targets: a target has to be cut by things that are *not* being split.
 */
export function splitEntities(
  doc: CadDocument,
  targets: readonly Entity[],
): SplitResult {
  const kernel = kernelOrNull();
  if (!kernel || typeof kernel.split_scene !== 'function') {
    return { ok: false, reason: 'noKernel' };
  }
  if (targets.length === 0) return { ok: false, reason: 'noCuts' };

  // Every visible entity, so a selected line is cut by the walls it crosses
  // even though the walls are not part of this operation.
  const scene: Entity[] = [];
  for (const e of doc.entities) {
    const layer = doc.layers.find((l) => l.id === e.layer);
    if (layer && (!layer.visible || layer.frozen)) continue;
    scene.push(e);
  }

  const packed = packScene(scene);
  const raw = kernel.split_scene(packed.encoded, packed.counts, splitTolerance(doc), MAX_SEG);
  if (raw.length < 1) return { ok: false, reason: 'noCuts' };

  const groupCount = raw[0]! | 0;
  const targetIds = new Set(targets.map((e) => e.id));
  const groups: SplitGroup[] = [];
  let cursor = 1;
  for (let g = 0; g < groupCount; g++) {
    if (cursor + 1 >= raw.length) break;
    const index = raw[cursor]! | 0;
    const count = raw[cursor + 1]! | 0;
    cursor += 2;
    const source = scene[index];
    if (!source) break;
    // The decoder reports where the run ended: polyline pieces are
    // variable-length, so the cursor cannot be advanced by arithmetic here.
    const run = decodePieceRun(raw, cursor, count, source);
    cursor = run.next;
    // A group for something outside this operation is a kernel/encoding
    // disagreement. Skipping it beats splitting an entity the caller never
    // asked about.
    if (!targetIds.has(source.id)) continue;
    if (run.pieces.length >= 2) groups.push({ source, pieces: run.pieces });
  }

  if (groups.length === 0) return { ok: false, reason: 'noCuts' };
  return { ok: true, groups };
}

/**
 * One undoable command for a whole decomposition.
 *
 * Every removal, every piece and every cascaded constraint deletion goes into a
 * single `Command`, for the reason in the file header. Removals come first so
 * the pieces end up on top in document order rather than interleaved with the
 * originals they replaced.
 */
export function splitCommand(doc: CadDocument, groups: readonly SplitGroup[]): Command {
  const patches: Patch[] = [];
  const removed = groups.map((g) => g.source.id);

  // Reverse order, because each `remove` records the index it was found at and
  // removing from the back leaves the earlier indices valid. (Reversing is what
  // `revertPatch` does on undo, so the two directions stay symmetric.)
  for (const id of [...removed].reverse()) {
    const p = removeEntity(doc, id);
    if (p) patches.push(p);
  }
  // A decomposed entity no longer exists, so a constraint naming it would make
  // every later solve step work from a broken row. Same rule as trim.
  patches.push(...danglingConstraints(doc, removed));
  for (const g of groups) {
    for (const piece of g.pieces) patches.push(addEntity(piece));
  }

  const total = groups.reduce((n, g) => n + g.pieces.length, 0);
  return command(`交点分解 (${groups.length} → ${total})`, ...patches);
}
