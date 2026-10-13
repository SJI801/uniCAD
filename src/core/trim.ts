/**
 * Trim — the front-end half of cutting a curve back to its cutting edges.
 *
 * The geometry all lives in `kernel/src/trim.rs`. What is left here is the
 * unglamorous work: decide *which* entities are cutting edges, hand the kernel a
 * scene, and turn the wire-format pieces it returns into real entities that
 * inherit the target's layer and style.
 *
 * # Why pieces must inherit the target's appearance
 *
 * The kernel returns bare geometry — it has no idea what a layer or a colour
 * is. If the pieces came back with document defaults, trimming a red line on a
 * locked-off layer would silently repaint it. The pieces are built through the
 * same factories the drawing tools use, seeded from the target's own style, so
 * a trimmed entity is visually indistinguishable from the part that survived.
 *
 * # Why a trim is one undo step
 *
 * A single click can delete the target and add several pieces. If that were
 * committed as separate commands, one Ctrl+Z would bring back half of it. The
 * caller builds one `Command` holding the removal and every addition — see
 * `trimCommand` below.
 */

import type { CadDocument, Entity, EntityId, Vec2 } from './types';
import { makeArc, makeEllipse, makeLine, makePolyline } from './entities';
import { command, addEntity, danglingConstraints, removeEntity, type Command } from './history';
import { activeSketch, findEntity, sketchOfEntity } from './doc';
import { kernelOrNull, packScene, type PackedScene } from './kernel';

/** Mirrors `TRIM_*` in `kernel/src/ffi.rs`. */
export const TRIM_TAG = {
  pieces: 0,
  noCuts: 1,
  offTarget: 2,
  unsupported: 3,
} as const;

/** Why a trim did not happen. `null` when it did. */
export type TrimFailure = 'noCuts' | 'offTarget' | 'unsupported' | 'noKernel';

export type TrimResult =
  | { ok: true; pieces: Entity[] }
  | { ok: false; reason: TrimFailure };

/**
 * The tessellation tolerance handed to the kernel, in model units.
 *
 * Derived from the *document* grid spacing rather than from the view: trim runs
 * on a click, not per frame, so there is no screen-pixel aperture to convert,
 * and picking a tolerance from something unrelated (the grid) would be arbitrary.
 * A fixed fraction of the grid step is coarse enough to keep the piece count
 * down and fine enough that a trimmed arc does not visibly go polygonal.
 */
function trimTolerance(doc: CadDocument): number {
  return Math.max(doc.settings.gridSpacing / 64, 1e-9);
}

/** The tessellation segment cap, matching the renderer's own. */
const MAX_SEG = 64;

/**
 * Pack only the entities trim cares about: the target and its cutting edges.
 *
 * The whole scene would also work and is one call either way, but packing a
 * thousand entities to cut one line means running every intersection against
 * every one of them. Two entities is not a measurable cost.
 */
function packPair(target: Entity, cutters: readonly Entity[]): PackedScene {
  return packScene([target, ...cutters]);
}

/**
 * Cut `targetId` at `click`, keeping everything except the piece under the
 * cursor.
 *
 * `cuttingIds` are the entities acting as boundaries. They must not include the
 * target — the kernel drops such entries defensively, because a target that
 * intersects itself has infinitely many cut points and would come back shredded.
 */
export function trimEntity(
  doc: CadDocument,
  targetId: EntityId,
  cuttingIds: readonly EntityId[],
  click: Vec2,
  aperture: number,
): TrimResult {
  const kernel = kernelOrNull();
  if (!kernel || typeof kernel.trim_target !== 'function') {
    return { ok: false, reason: 'noKernel' };
  }
  const target = findEntity(doc, targetId);
  if (!target) return { ok: false, reason: 'offTarget' };

  const cutters = cuttingIds
    .filter((id) => id !== targetId)
    .map((id) => findEntity(doc, id))
    .filter((e): e is Entity => e !== undefined);
  if (cutters.length === 0) return { ok: false, reason: 'noCuts' };

  const scene = packPair(target, cutters);
  const out = kernel.trim_target(
    scene.encoded,
    scene.counts,
    0,
    Uint32Array.from(cutters.map((_, i) => i + 1)),
    click.x,
    click.y,
    trimTolerance(doc),
    MAX_SEG,
    aperture,
  );
  if (out.length < 2) return { ok: false, reason: 'offTarget' };

  const tag = out[0]!;
  if (tag === TRIM_TAG.noCuts) return { ok: false, reason: 'noCuts' };
  if (tag === TRIM_TAG.offTarget) return { ok: false, reason: 'offTarget' };
  if (tag === TRIM_TAG.unsupported) return { ok: false, reason: 'unsupported' };

  const pieces = decodePieces(out, 2, out[1]! | 0, target);
  return { ok: true, pieces };
}

/**
 * Vertices of the piece a click would remove, for the hover preview.
 *
 * Empty means "nothing to highlight" — not an error. The cursor may be over
 * nothing, over a target no boundary crosses, or over an ellipse (which trim
 * refuses, and which the tool surfaces as a prompt instead).
 */
export function trimPreview(
  doc: CadDocument,
  targetId: EntityId,
  cuttingIds: readonly EntityId[],
  click: Vec2,
  aperture: number,
): Array<{ x: number; y: number }> {
  const kernel = kernelOrNull();
  if (!kernel || typeof kernel.trim_preview !== 'function') return [];
  const target = findEntity(doc, targetId);
  if (!target) return [];
  const cutters = cuttingIds
    .filter((id) => id !== targetId)
    .map((id) => findEntity(doc, id))
    .filter((e): e is Entity => e !== undefined);
  if (cutters.length === 0) return [];

  const scene = packPair(target, cutters);
  const pts = kernel.trim_preview(
    scene.encoded,
    scene.counts,
    0,
    Uint32Array.from(cutters.map((_, i) => i + 1)),
    click.x,
    click.y,
    trimTolerance(doc),
    MAX_SEG,
    aperture,
  );
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i + 1 < pts.length; i += 2) out.push({ x: pts[i]!, y: pts[i + 1]! });
  return out;
}

/**
 * Decode the kernel's `[tag, count, ...pieces]` reply into entities.
 *
 * The pieces carry no style, so each one is seeded from the target: same layer,
 * same explicit colour / line style / weight overrides. The **name** is
 * deliberately not inherited — it belongs to the entity the user named, and
 * two entities sharing a name is worse than the pieces being anonymous.
 *
 * Exported because decomposition decodes the very same wire primitives from a
 * differently-shaped reply; a second decoder here would be a second thing to
 * keep in step with `encode_prim`.
 */
export function decodePieces(
  buf: Float64Array,
  start: number,
  count: number,
  target: Entity,
): Entity[] {
  return decodePieceRun(buf, start, count, target).pieces;
}

/**
 * Same decoding, but also reporting where the run ended.
 *
 * The polyline wire format is variable-length — its point count is implied by
 * the rest of the slice rather than stored — so a caller reading *several*
 * independent runs out of one buffer (decomposition reads one run per entity)
 * cannot skip a run by arithmetic and must be told where the decoder stopped.
 * Returning the cursor is the only way to keep that caller from growing its own
 * second parser, which is how the two would drift apart.
 */
export function decodePieceRun(
  buf: Float64Array,
  start: number,
  count: number,
  target: Entity,
): { pieces: Entity[]; next: number } {
  const out: Entity[] = [];
  let cursor = start;
  for (let i = 0; i < count; i++) {
    if (cursor >= buf.length) break;
    const tag = buf[cursor]!;
    switch (tag) {
      case 0: {
        if (cursor + 5 > buf.length) return { pieces: out, next: buf.length };
        out.push(
          makeLine(styleOf(target), {
            x: buf[cursor + 1]!,
            y: buf[cursor + 2]!,
          }, {
            x: buf[cursor + 3]!,
            y: buf[cursor + 4]!,
          }),
        );
        cursor += 5;
        break;
      }
      case 1:
      case 2: {
        // A circle never survives a trim — every circle slice is an arc — but
        // decoding it defensively costs three lines and would turn a kernel
        // regression into silently missing geometry instead of a wrong shape.
        if (cursor + 6 > buf.length) return { pieces: out, next: buf.length };
        out.push(
          makeArc(
            styleOf(target),
            { x: buf[cursor + 1]!, y: buf[cursor + 2]! },
            buf[cursor + 3]!,
            buf[cursor + 4]!,
            buf[cursor + 5]!,
          ),
        );
        cursor += 6;
        break;
      }
      case 3: {
        if (cursor + 6 > buf.length) return { pieces: out, next: buf.length };
        out.push(
          makeEllipse(
            styleOf(target),
            { x: buf[cursor + 1]!, y: buf[cursor + 2]! },
            buf[cursor + 3]!,
            buf[cursor + 4]!,
            buf[cursor + 5]!,
          ),
        );
        cursor += 6;
        break;
      }
      case 4: {
        // `[tag, closed, vertexCount, x0, y0, …]`. The count is what makes a
        // polyline self-delimiting: without it, a multi-piece reply (a trimmed
        // polyline comes back as several polylines) could only be read by
        // consuming to the end of the buffer, so the first polyline swallowed
        // every later piece and the trim looked like it produced one segment
        // instead of three. Read exactly `vertexCount` points and stop.
        if (cursor + 3 > buf.length) return { pieces: out, next: buf.length };
        const closed = buf[cursor + 1] !== 0;
        const n = buf[cursor + 2]! | 0;
        const coordsAt = cursor + 3;
        if (n < 0 || coordsAt + n * 2 > buf.length) return { pieces: out, next: buf.length };
        const pts: Vec2[] = [];
        for (let k = 0; k < n; k++) {
          const x = buf[coordsAt + k * 2]!;
          const y = buf[coordsAt + k * 2 + 1]!;
          if (!Number.isFinite(x) || !Number.isFinite(y)) return { pieces: out, next: buf.length };
          pts.push({ x, y });
        }
        cursor = coordsAt + n * 2;
        // `closed` is always false for a slice (a slice never wraps), but decode
        // the flag rather than hard-coding it: a closed polyline that survives
        // a trim whole must not silently open up.
        out.push(makePolyline(styleOf(target), pts, closed));
        break;
      }
      default:
        // Unknown tag: the rest of the buffer cannot be located, so stop rather
        // than scan past it and produce nonsense.
        return { pieces: out, next: buf.length };
    }
  }
  return { pieces: out, next: cursor };
}

/** Style fields copied onto every piece of a trimmed entity. */
export function styleOf(target: Entity): Parameters<typeof makeLine>[0] {
  return {
    layer: target.layer,
    color: target.color,
    lineStyle: target.lineStyle,
    lineWeight: target.lineWeight,
  };
}

/**
 * One undoable command for a whole trim: remove the target, add what is left.
 *
 * Both halves must be in the *same* `Command`. Splitting them means one Ctrl+Z
 * restores the target but leaves its pieces lying next to it — the user would
 * have to undo twice for one click, and a drawing that had a line trimmed out of
 * it would come back with a duplicate.
 */
export function trimCommand(doc: CadDocument, targetId: EntityId, pieces: readonly Entity[]): Command {
  const removal = removeEntity(doc, targetId);
  const patches = removal ? [removal] : [];
  // The target is being replaced, so any constraint that mentioned it now
  // mentions a deleted entity. Cascading here keeps the rule in one place: the
  // user did not ask about constraints, but leaving a dangling one would make
  // every later solve step over a broken row.
  patches.push(...danglingConstraints(doc, [targetId]));
  // The pieces live in the target's sketch — the one the trimmed curve was on,
  // recorded on the patch so an undo after switching sketches still restores
  // them to the right place.
  const sketchId = sketchOfEntity(doc, targetId)?.id ?? doc.activeSketch;
  for (const p of pieces) patches.push(addEntity(sketchId, p));
  const label = pieces.length === 0 ? '修剪' : `修剪 (${pieces.length} 段)`;
  return command(label, ...patches);
}

/**
 * The entities acting as cutting edges while trimming `targetId`: every
 * **visible** entity in the target's own sketch, except the target.
 *
 * The sketch scope is the same rule the solver and the renderer already apply:
 * the 2D view only ever shows one plane, so an entity on another plane is not
 * a boundary the user can see — and its `(x, y)` means something else there,
 * which would put cut points nowhere near anything on screen.
 *
 * Visibility is filtered because an invisible boundary produces cut points the
 * user cannot see, and a frozen layer's entities are not pickable — treating
 * them as live edges would trim against geometry the drawing does not show.
 *
 * The target itself is never a boundary: it intersects itself everywhere, and
 * the kernel drops such entries defensively rather than shredding it.
 */
export function cuttingEdgeIds(doc: CadDocument, targetId: EntityId): EntityId[] {
  const sketch = sketchOfEntity(doc, targetId) ?? activeSketch(doc);
  const ids: EntityId[] = [];
  for (const e of sketch.entities) {
    if (e.id === targetId) continue;
    const layer = doc.layers.find((l) => l.id === e.layer);
    if (layer && (!layer.visible || layer.frozen)) continue;
    ids.push(e.id);
  }
  return ids;
}
