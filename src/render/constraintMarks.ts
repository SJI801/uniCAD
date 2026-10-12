/**
 * On-canvas constraint badges — the little ⊙ ∈ ⊥ marks that say "these two are
 * related, and the solver keeps them that way".
 *
 * Like the automatic dimensions, this is a DOM overlay rather than geometry:
 * text at 11 px is far crisper (and cheaper) through the browser's own
 * rasteriser, and the badges are *chrome* — they are not part of the drawing and
 * must not scale with zoom.
 *
 * Two rules decided the placement:
 *
 * 1. **Only constraints that touch the selection are drawn.** A drawing with
 *    three hundred constraints should not turn into three hundred badges. The
 *    ones the user is working on are exactly the ones they can see the effect of.
 * 2. **The badge sits at a named point, not at the entities' midpoint.** For
 *    "coincident" the midpoint of two coincident points *is* the point, which is
 *    fine, but for "perpendicular" the midpoint of two crossing lines is their
 *    intersection — also fine — while for "parallel" the midpoint is nowhere
 *    near either line. Anchoring to a real anchor point keeps the badge attached
 *    to something the eye can follow.
 */

import type { CadDocument, Constraint, Entity, EntityId, Vec2 } from '../core/types';
import { constraintPointAt, entityBoundsTS } from '../core/entities';
import { CONSTRAINT_GLYPH, describeConstraint } from '../core/constraints';
import type { DimContext, DimLabel } from './dims';

/**
 * How far the badge floats off its anchor, in screen pixels.
 *
 * Straight on top of the anchor would cover the very feature it describes — the
 * `⊥` would sit inside the right angle it marks.
 */
const BADGE_OFFSET = 11;

/** Badges drawn per frame. Past this the layer is soup; see rule 1 above. */
const MAX_BADGES = 40;

/**
 * Where a constraint's badge hangs.
 *
 * Prefers the *second* target's point, because that is the side the user most
 * often just clicked and therefore the one they are looking at. Falls back to
 * the first target for unary constraints, and to the nearest bounds corner when
 * the targets name no point at all (parallel / perpendicular / concentric all
 * store `point: 'none'`).
 */
function anchorFor(c: Constraint, doc: CadDocument): Vec2 | null {
  const at = (t: { entity: EntityId; point: string; index?: number }): Vec2 | null => {
    const e = doc.entities.find((x) => x.id === t.entity);
    if (!e) return null;
    return constraintPointAt(e, t.point as never, t.index ?? 0);
  };

  if (c.b) {
    const pb = at(c.b);
    if (pb) return pb;
    const pa = at(c.a);
    if (pa) return pa;
  } else {
    const pa = at(c.a);
    if (pa) return pa;
  }

  // No point on either side — put it on the first entity's corner so the badge
  // is at least attached to *something* that was drawn.
  const e = doc.entities.find((x) => x.id === c.a.entity);
  if (!e) return null;
  const b = entityBoundsTS(e);
  return { x: b.maxX, y: b.maxY };
}

/**
 * Badges for every constraint touching the current selection.
 *
 * Returns screen-space labels only — a constraint has no geometry of its own to
 * draw, so this never contributes to the GPU batch.
 */
export function constraintBadges(
  doc: CadDocument,
  selected: ReadonlySet<EntityId>,
  visible: readonly Entity[],
  ctx: DimContext,
): DimLabel[] {
  if (selected.size === 0) return [];
  const onVisibleLayer = new Set(visible.map((e) => e.id));
  const labels: DimLabel[] = [];

  for (const c of doc.constraints) {
    if (labels.length >= MAX_BADGES) break;
    const touches = selected.has(c.a.entity) || (c.b !== undefined && selected.has(c.b.entity));
    if (!touches) continue;
    // A badge pointing at something hidden is worse than no badge: the user
    // cannot see what it is talking about.
    if (!onVisibleLayer.has(c.a.entity)) continue;
    if (c.b && !onVisibleLayer.has(c.b.entity)) continue;

    const world = anchorFor(c, doc);
    if (!world) continue;

    const s = ctx.screenOf(world);
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
    // Cheap offscreen reject: a clamped badge at the edge reads as if it
    // belonged to whatever happens to be drawn there.
    if (s.x < -40 || s.y < -40 || s.x > ctx.viewWidth + 40 || s.y > ctx.viewHeight + 40) continue;

    labels.push({
      x: s.x + BADGE_OFFSET,
      y: s.y - BADGE_OFFSET,
      // 尺寸徽章直接带值（↔ 80 / ∠ 60.0°），关系徽章只有字符。
      text: badgeText(c),
      kind: 'constraint',
      // Carried through so the DOM layer can offer the full sentence on hover.
      title: describeConstraint(c, doc),
    });
  }
  return labels;
}

/** 尺寸约束的徽章带值；几何关系只有字符。 */
function badgeText(c: Constraint): string {
  if (c.value === undefined) return CONSTRAINT_GLYPH[c.kind];
  return c.kind === 'angle'
    ? `${CONSTRAINT_GLYPH[c.kind]} ${((c.value * 180) / Math.PI).toFixed(1)}°`
    : `${CONSTRAINT_GLYPH[c.kind]} ${Number(c.value.toFixed(2))}`;
}
