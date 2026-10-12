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
import type { OverlaySegment } from './overlay';
import { UI_COLORS } from './style';

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

const GUIDE_ARC_SEGMENTS = 48;
/** 轴向解空间虚线画多长（模型单位，以可动点为中心对称）。 */
const GUIDE_REACH = 150;

/**
 * 解空间引导：选中挂着距离类约束的图元时，把「被钉住的范围」画出来。
 *
 * * `distance`（对齐）：以冻结端为圆心、目标值为半径的虚线圆——另一端被钉在
 *   这个圆上，拖动只能沿圆滑。「距离不变但方向变了」的失效感由此消除。
 * * `distanceX` / `distanceY`：过可动端的一条竖直/水平虚线——那个轴被锁死，
 *   另一个轴自由。
 *
 * 基准端**永远是 a 端**（第一个曲线的被钉点）——「以第一个曲线终点为圆心」
 * 是方向性语义，不随拖动对象切换；配合 `withConstraintRepair` 的圆心钉扎，
 * 拖 a 端实体时圆心也不动（曲线绕它拉伸/转动）。跟随「约束标记」开关一起显隐。
 */
export function constraintGuides(
  doc: CadDocument,
  selected: ReadonlySet<EntityId>,
  visible: readonly Entity[],
): OverlaySegment[] {
  if (selected.size === 0) return [];
  const onVisibleLayer = new Set(visible.map((e) => e.id));
  const segs: OverlaySegment[] = [];

  for (const c of doc.constraints) {
    if (c.kind !== 'distance' && c.kind !== 'distanceX' && c.kind !== 'distanceY') continue;
    if (!c.b) continue;
    const aSel = selected.has(c.a.entity);
    const bSel = selected.has(c.b.entity);
    if (!aSel && !bSel) continue;

    // Property narrowing on `c.b` does not survive into an arrow-function
    // callback, so hoist it before the `find` calls below.
    const bTarget = c.b;
    const ea = doc.entities.find((x) => x.id === c.a.entity);
    const eb = doc.entities.find((x) => x.id === bTarget.entity);
    if (!ea || !eb) continue;
    if (!onVisibleLayer.has(ea.id) || !onVisibleLayer.has(eb.id)) continue;

    const value = c.value ?? 0;
    if (!(value > 0)) continue;

    // 圆心永远 = a 端（第一个曲线的被钉点）；b 端是被钉在圆上滑的那个。
    const anchorT = c.a;
    const anchorE = ea;
    const mobileT = c.b;
    const mobileE = eb;
    const anchor = constraintPointAt(anchorE, anchorT.point, anchorT.index ?? 0);
    const mobile = constraintPointAt(mobileE, mobileT.point, mobileT.index ?? 0);
    if (!anchor || !mobile) continue;

    if (c.kind === 'distance') {
      for (let i = 0; i < GUIDE_ARC_SEGMENTS; i++) {
        const a1 = (i / GUIDE_ARC_SEGMENTS) * Math.PI * 2;
        const a2 = ((i + 1) / GUIDE_ARC_SEGMENTS) * Math.PI * 2;
        segs.push({
          a: { x: anchor.x + value * Math.cos(a1), y: anchor.y + value * Math.sin(a1) },
          b: { x: anchor.x + value * Math.cos(a2), y: anchor.y + value * Math.sin(a2) },
          color: UI_COLORS.preview,
          width: 1,
          dash: [6, 4],
        });
      }
    } else if (c.kind === 'distanceX') {
      segs.push({
        a: { x: mobile.x, y: mobile.y - GUIDE_REACH },
        b: { x: mobile.x, y: mobile.y + GUIDE_REACH },
        color: UI_COLORS.preview,
        width: 1,
        dash: [6, 4],
      });
    } else {
      segs.push({
        a: { x: mobile.x - GUIDE_REACH, y: mobile.y },
        b: { x: mobile.x + GUIDE_REACH, y: mobile.y },
        color: UI_COLORS.preview,
        width: 1,
        dash: [6, 4],
      });
    }
  }
  return segs;
}
