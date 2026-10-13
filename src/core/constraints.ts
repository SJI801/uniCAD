/**
 * Parametric constraints — the front-end half.
 *
 * What lives here and what does not
 * ---------------------------------
 * The **solver is in the Rust kernel**; this module never computes geometry. It
 * owns the three things the kernel cannot know about:
 *
 * 1. **Which constraint the user meant.** Applying 「相切」 to a two-curve
 *    selection has to decide who is the line and who is the circle, and
 *    「重合」 has to decide *which two points*. That is intent, not geometry.
 * 2. **Whether the selection can carry that constraint at all** — with a
 *    human-readable reason when it cannot, because a disabled button with no
 *    explanation is the most expensive kind of UI.
 * 3. **The bridge**: pack the involved entities + the flat constraint list,
 *    hand them to `solve_constraints`, and turn the repaired geometry back into
 *    entity objects the store can fold into one command.
 *
 * Naming warning: this file is about *persistent* relationships between curves.
 * `DrawingSettings.constraint` (grid / ortho / polar) is a completely different
 * feature that constrains the **cursor** while drawing. See the note on
 * `ConstraintKind` in `core/types.ts`.
 */

import type {
  CadDocument,
  Constraint,
  ConstraintKind,
  ConstraintPointKind,
  ConstraintTarget,
  Entity,
  EntityId,
  Vec2,
} from './types';
import {
  CONSTRAINT_KIND_TAG,
  CONSTRAINT_POINT_TAG,
  UNARY_CONSTRAINTS,
  fmt,
  fmtAngle,
} from './types';
import { allEntities, findEntity, sketchEntities } from './doc';
import { constraintPointAt, describeEntity } from './entities';
import { kernelOrNull, packOne, packScene } from './kernel';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

let counter = 0;

/**
 * A fresh constraint id.
 *
 * Ids are per-session only — the saved file stores the relationship, not the
 * name of it — so a simple counter is enough and keeps ids short and readable in
 * the panel and in console output.
 */
export function nextConstraintId(): string {
  counter += 1;
  return `ct${counter}`;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export const CONSTRAINT_LABEL: Record<ConstraintKind, string> = {
  coincident: '重合',
  pointOnCurve: '点在曲线上',
  tangent: '相切',
  perpendicular: '垂直',
  parallel: '平行',
  concentric: '同心',
  equalRadius: '等半径',
  horizontal: '水平',
  vertical: '竖直',
  distance: '距离',
  angle: '角度',
  radius: '半径',
  diameter: '直径',
  distanceX: '水平距离',
  distanceY: '竖直距离',
  // 「固定」是**动作**名：菜单里点它 = 把该图元的每个具名点都钉在当前位置
  // （见 `buildConstraints`）。落盘之后它拆成一堆只钉 x 的 `fixedX` 和只钉 y 的
  // `fixedY`，因为内核一条约束只能带一个标量。列表里 x 行读作「固定 = 10」、
  // y 行读作「固定Y = 0」，成对出现正好读成「固定 x=10, y=0」。
  fixedX: '固定',
  fixedY: '固定Y',
};

/**
 * One-character marks drawn next to the constrained curves.
 *
 * Deliberately typographic rather than icon-font glyphs: they have to render in
 * the same monospace stack the rest of the readouts use, at 10–11 px, without a
 * second font download. `∈` for "lies on" and `◎` for concentric read the same
 * way a CAD drafter expects a small badge to read.
 */
export const CONSTRAINT_GLYPH: Record<ConstraintKind, string> = {
  coincident: '⊙',
  pointOnCurve: '∈',
  tangent: 'T',
  perpendicular: '⊥',
  parallel: '∥',
  concentric: '◎',
  equalRadius: '=',
  horizontal: '—',
  vertical: '¦',
  distance: '↔',
  angle: '∠',
  radius: 'R',
  diameter: 'Ø',
  distanceX: 'H',
  distanceY: 'V',
  // 锚点徽章不用单个字符：一个「固定」会落下 4 条约束，逐条画会在一根线上糊出
  // 四个 X/Y 角标。`constraintBadges` 把同一个具名点上的一对合并成一枚
  // 「锁定」徽章，这两个字符只作为兜底（例如只有 x 被钉住时）。
  fixedX: 'X',
  fixedY: 'Y',
};

/** Menu order: the ones people reach for first. */
export const CONSTRAINT_ORDER: readonly ConstraintKind[] = [
  'coincident',
  'pointOnCurve',
  'tangent',
  'perpendicular',
  'parallel',
  'concentric',
  'equalRadius',
  'horizontal',
  'vertical',
  'distance',
  'angle',
  'radius',
  'diameter',
  'distanceX',
  'distanceY',
  // 「固定」排在最后：它不改变曲线之间的关系，而是给整张草图**接地**——
  // 用户通常是先画完、标完尺寸，最后才发现还差几个自由度（0.3 的状态芯片），
  // 这时才会来找它。它是 `UNARY_CONSTRAINTS` 里唯一一个能作用于任意图元的。
  'fixedX',
];

/**
 * Kinds that carry a target value (see `Constraint.value`) instead of a pure
 * relationship. The panel renders an editable number for these; the solver
 * treats the stored value as the intent.
 */
export const DIMENSIONAL_CONSTRAINTS: ReadonlySet<ConstraintKind> = new Set<ConstraintKind>([
  'distance',
  'angle',
  'radius',
  'diameter',
  'distanceX',
  'distanceY',
  'fixedX',
  'fixedY',
]);

/**
 * Dimensional kinds whose target **may legitimately be zero**.
 *
 * `distance` = 0 is 重合, `distanceX` / `distanceY` = 0 is 对齐 on that axis —
 * all three are things a drafter asks for on purpose, and `buildConstraints`
 * seeds exactly those values when the two picked points already share a
 * coordinate. A radius or an angle of 0 is not geometry at all, so those stay
 * strictly positive.
 *
 * This set exists because three separate layers were rejecting the value:
 * the JSON reader (dropped the whole constraint on load), the panel's inline
 * number box, and `setConstraintValueAction`. Keeping the policy in one place
 * is what stops them drifting apart again.
 */
export const ZERO_VALUE_DIMENSIONS: ReadonlySet<ConstraintKind> = new Set<ConstraintKind>([
  'distance',
  'distanceX',
  'distanceY',
  // 锚点钉的是**坐标**，x = 0 / y = 0 是最常见的一种（钉在世界原点上）。
  'fixedX',
  'fixedY',
]);

/**
 * Dimensional kinds whose target **may be negative**.
 *
 * Only the anchors: every other dimension is a magnitude (a length, a radius,
 * an angle) or a signed *gap* whose sign is carried by the frozen branch rather
 * than by the stored number — `distanceX` between two points always stores a
 * positive gap. An anchor stores a raw world coordinate, and half the world is
 * on the negative side of zero, so `x = −30` has to survive the JSON reader, the
 * panel's number box and `setConstraintValueAction`.
 */
export const SIGNED_DIMENSIONS: ReadonlySet<ConstraintKind> = new Set<ConstraintKind>([
  'fixedX',
  'fixedY',
]);

export const POINT_LABEL: Record<ConstraintPointKind, string> = {
  none: '',
  start: '起点',
  end: '终点',
  center: '圆心',
  vertex: '顶点',
};

/** Short, stable description of one side of a constraint. */
function targetLabel(doc: CadDocument, t: ConstraintTarget): string {
  const e = findEntity(doc, t.entity);
  const kind = e ? describeEntity(e) : '已删除对象';
  if (t.point === 'none') return kind;
  const pt = POINT_LABEL[t.point];
  return t.point === 'vertex' ? `${kind}·顶点${(t.index ?? 0) + 1}` : `${kind}·${pt}`;
}

export function describeConstraint(c: Constraint, doc: CadDocument): string {
  const rel = CONSTRAINT_LABEL[c.kind];
  const a = targetLabel(doc, c.a);
  const suffix = dimensionSuffix(c);
  if (!c.b) return `${a} ${rel}${suffix}`;
  return `${a} ${rel} ${targetLabel(doc, c.b)}${suffix}`;
}

/** 「 = 50」/「 = 60.0°」for the dimensional kinds, '' otherwise. */
function dimensionSuffix(c: Constraint): string {
  if (c.value === undefined) return '';
  return c.kind === 'angle' ? ` = ${fmtAngle(c.value, 1)}` : ` = ${fmt(c.value)}`;
}

/** Every constraint that mentions `id`, in either slot. */
export function constraintsForEntity(doc: CadDocument, id: EntityId): Constraint[] {
  return doc.constraints.filter((c) => c.a.entity === id || c.b?.entity === id);
}

// ---------------------------------------------------------------------------
// Applicability
// ---------------------------------------------------------------------------

const isLinear = (e: Entity): boolean => e.type === 'line';
const isCircular = (e: Entity): boolean =>
  e.type === 'circle' || e.type === 'arc';

export interface Applicability {
  ok: boolean;
  /** Why not, in the user's language. Always set when `ok` is false. */
  reason?: string;
}

/**
 * Can these entities carry this constraint?
 *
 * Kept separate from `buildConstraints` so the menu can grey out the entries
 * that cannot apply *and say why*, instead of letting the user click and then
 * wonder why nothing happened.
 */
export function canApply(kind: ConstraintKind, entities: readonly Entity[]): Applicability {
  const n = entities.length;
  if (n === 0) return { ok: false, reason: '先选中对象' };

  // 半径 / 直径钉住单个圆或圆弧。它们在 `UNARY_CONSTRAINTS` 里（单实体、无
  // `b`），但适用性是圆而不是线，所以要在只认直线的 unary 分支**之前**作答。
  if (kind === 'radius' || kind === 'diameter') {
    if (n !== 1) {
      return { ok: false, reason: `${CONSTRAINT_LABEL[kind]}需要正好选中 1 个圆或圆弧（当前 ${n} 个）` };
    }
    if (!isCircular(entities[0]!)) {
      return { ok: false, reason: `${CONSTRAINT_LABEL[kind]}只能作用于圆或圆弧（当前选中含${describeEntity(entities[0]!)}）` };
    }
    return { ok: true };
  }

  // 固定（锚点）：作用于**任意**单个图元——它钉的是具名点的坐标，所以直线、
  // 圆/弧、椭圆、多段线都有资格。必须排在只认直线的 unary 分支**之前**，否则
  // 圆和多段线会被判成「只能作用于直线」。
  if (kind === 'fixedX' || kind === 'fixedY') {
    if (n !== 1) {
      return { ok: false, reason: `${CONSTRAINT_LABEL[kind]}需要正好选中 1 个对象（当前 ${n} 个）` };
    }
    return { ok: true };
  }

  if (UNARY_CONSTRAINTS.has(kind)) {
    const notLine = entities.find((e) => !isLinear(e));
    if (notLine) {
      return { ok: false, reason: `${CONSTRAINT_LABEL[kind]}只能作用于直线（当前选中含${describeEntity(notLine)}）` };
    }
    return { ok: true };
  }

  if (n !== 2) {
    return { ok: false, reason: `${CONSTRAINT_LABEL[kind]}需要正好选中 2 个对象（当前 ${n} 个）` };
  }
  const [a, b] = entities as [Entity, Entity];

  switch (kind) {
    case 'coincident': {
      const pa = firstNamedPoint(a);
      const pb = firstNamedPoint(b);
      if (!pa || !pb) return { ok: false, reason: '这两个对象上没有可用的点（圆与椭圆只有圆心）' };
      return { ok: true };
    }
    case 'pointOnCurve': {
      if (isCircular(a) && isCircular(b)) {
        return { ok: false, reason: '两个圆/弧之间没有「点在曲线上」可言，改用「同心」或「相切」' };
      }
      if (!firstNamedPoint(a) || !firstNamedPoint(b)) {
        return { ok: false, reason: '这两个对象上没有可用的点' };
      }
      return { ok: true };
    }
    case 'tangent': {
      const pair = (isLinear(a) && isCircular(b)) || (isCircular(a) && isLinear(b));
      const bothCircle = isCircular(a) && isCircular(b);
      if (!pair && !bothCircle) {
        return { ok: false, reason: '相切需要「直线 + 圆/弧」或「两个圆/弧」' };
      }
      return { ok: true };
    }
    case 'perpendicular':
    case 'parallel': {
      if (!isLinear(a) || !isLinear(b)) {
        return { ok: false, reason: `${CONSTRAINT_LABEL[kind]}需要两条直线` };
      }
      return { ok: true };
    }
    case 'concentric':
    case 'equalRadius': {
      if (!isCircular(a) || !isCircular(b)) {
        return { ok: false, reason: `${CONSTRAINT_LABEL[kind]}需要两个圆或圆弧` };
      }
      return { ok: true };
    }
    case 'distance':
    case 'distanceX':
    case 'distanceY': {
      if (!firstNamedPoint(a) || !firstNamedPoint(b)) {
        return { ok: false, reason: '距离约束需要两个可命名点的对象（圆/椭圆只有圆心）' };
      }
      return { ok: true };
    }
    case 'angle': {
      if (!isLinear(a) || !isLinear(b)) {
        return { ok: false, reason: '角度需要两条直线' };
      }
      return { ok: true };
    }
    case 'horizontal':
    case 'vertical':
      return { ok: true };
  }
}

/** The entity's named points, in the kernel's vocabulary. */
export function namedPointsOf(e: Entity): Array<{ point: ConstraintPointKind; index?: number; at: Vec2 }> {
  switch (e.type) {
    case 'line':
      return [
        { point: 'start', at: e.a },
        { point: 'end', at: e.b },
      ];
    case 'arc':
      return [
        { point: 'start', at: constraintPointAt(e, 'start')! },
        { point: 'end', at: constraintPointAt(e, 'end')! },
        { point: 'center', at: e.center },
      ];
    case 'circle':
    case 'ellipse':
      // No endpoints: a circle is not "from here to there", so 重合 on a circle
      // can only mean its centre.
      return [{ point: 'center', at: e.center }];
    case 'polyline':
      return e.points.map((p, i) => ({ point: 'vertex' as const, index: i, at: p }));
  }
}

function firstNamedPoint(e: Entity): { point: ConstraintPointKind; index?: number } | null {
  const pts = namedPointsOf(e);
  return pts.length > 0 ? pts[0]! : null;
}

/** The closest pair of named points between two entities, if both have any. */
function closestPair(
  a: Entity,
  b: Entity,
): {
  pa: { point: ConstraintPointKind; index?: number };
  pb: { point: ConstraintPointKind; index?: number };
  distance: number;
  midpoint: Vec2;
} | null {
  const pa = namedPointsOf(a);
  const pb = namedPointsOf(b);
  if (pa.length === 0 || pb.length === 0) return null;

  let best: ReturnType<typeof closestPair> = null;
  for (const x of pa) {
    for (const y of pb) {
      const d = Math.hypot(x.at.x - y.at.x, x.at.y - y.at.y);
      if (!best || d < best.distance) {
        best = {
          pa: { point: x.point, index: x.index },
          pb: { point: y.point, index: y.index },
          distance: d,
          midpoint: { x: (x.at.x + y.at.x) / 2, y: (x.at.y + y.at.y) / 2 },
        };
      }
    }
  }
  return best;
}

function target(entity: EntityId, p: { point: ConstraintPointKind; index?: number }): ConstraintTarget {
  const t: ConstraintTarget = { entity, point: p.point };
  if (p.point === 'vertex') t.index = p.index ?? 0;
  return t;
}

// ---------------------------------------------------------------------------
// Building the constraint the user asked for
// ---------------------------------------------------------------------------

export interface BuildResult {
  constraints?: Constraint[];
  reason?: string;
}

/**
 * Turn "apply `kind` to this selection" into concrete constraints.
 *
 * The decisions here are the reason this lives on the front-end. Two of them are
 * worth spelling out because they are choices, not deductions:
 *
 * * **重合 picks the closest pair of named points.** Two lines almost touching
 *   end-to-end is the overwhelmingly common case, and "closest" is the only
 *   rule that never surprises: the pair the user can see nearly meeting is the
 *   pair that gets bound.
 * * **点在曲线上 gives the point to the linear curve.** Asking for a point on a
 *   curve is nearly always "this endpoint should sit on that circle". When both
 *   sides are linear the first one in document order supplies the point — and
 *   since both entities are movable for the solve, either choice converges to
 *   the same geometry, so the tie-break costs nothing.
 *
 * Unary kinds return **one constraint per selected line**, which is what
 * "select three lines, click 水平" should obviously do.
 */
export function buildConstraints(kind: ConstraintKind, entities: readonly Entity[]): BuildResult {
  const verdict = canApply(kind, entities);
  if (!verdict.ok) return { reason: verdict.reason };

  // 半径 / 直径：目标值 = 当前半径。建约束即「锁定现状」，改值才驱动——
  // 和所有尺寸约束一样，值存在约束上而不是几何上。
  if (kind === 'radius' || kind === 'diameter') {
    const e = entities[0]!;
    if (e.type !== 'circle' && e.type !== 'arc') return { reason: '半径/直径只能作用于圆或圆弧' };
    return {
      constraints: [
        {
          id: nextConstraintId(),
          kind,
          a: { entity: e.id, point: 'none' },
          value: kind === 'radius' ? e.radius : 2 * e.radius,
        },
      ],
    };
  }

  // 固定（锚点）：把该图元的**每一个具名点**都钉在当前位置。
  //
  // 「固定一条线」在用户心里就是「这根线别动了」，所以它必须一次钉住两端：只钉
  // 起点的话，线还能绕起点转，自由度不为 0，0.4 的「完全定义」就还是个空话。
  // 一条线段 ⇒ 4 条约束（两端点各 x/y），多段线 ⇒ 每个顶点 2 条，圆/椭圆 ⇒
  // 圆心 2 条（半径是**尺寸**，得另外用半径/直径约束驱动 —— 锚点永远不碰尺寸，
  // 这是内核 `size_driven` 的规矩）。
  if (kind === 'fixedX' || kind === 'fixedY') {
    const e = entities[0]!;
    const pts = namedPointsOf(e);
    if (pts.length === 0) return { reason: '这个对象上没有可命名的点' };
    const out: Constraint[] = [];
    for (const p of pts) {
      out.push({ id: nextConstraintId(), kind: 'fixedX', a: target(e.id, p), value: p.at.x });
      out.push({ id: nextConstraintId(), kind: 'fixedY', a: target(e.id, p), value: p.at.y });
    }
    return { constraints: out };
  }

  if (UNARY_CONSTRAINTS.has(kind)) {
    return {
      constraints: entities.map((e) => ({
        id: nextConstraintId(),
        kind,
        a: { entity: e.id, point: 'none' },
      })),
    };
  }

  const [a, b] = entities as [Entity, Entity, ...Entity[]];

  if (kind === 'coincident') {
    const pair = closestPair(a, b);
    if (!pair) return { reason: '这两个对象上没有可用的点' };
    return {
      constraints: [
        { id: nextConstraintId(), kind, a: target(a.id, pair.pa), b: target(b.id, pair.pb) },
      ],
    };
  }

  if (kind === 'pointOnCurve') {
    // Circular side hosts the point; if both are linear, `a` does.
    const linearIsA = !isCircular(a) || isCircular(b);
    const pointOwner = linearIsA ? a : b;
    const curve = linearIsA ? b : a;
    const pts = namedPointsOf(pointOwner);
    const other = namedPointsOf(curve);
    if (pts.length === 0 || other.length === 0) return { reason: '这两个对象上没有可用的点' };

    // Which of the owner's points? The one nearest the host curve.
    let best = pts[0]!;
    let bestD = Infinity;
    for (const p of pts) {
      for (const q of other) {
        const d = Math.hypot(p.at.x - q.at.x, p.at.y - q.at.y);
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
    }
    return {
      constraints: [
        {
          id: nextConstraintId(),
          kind,
          a: target(pointOwner.id, { point: best.point, index: best.index }),
          b: { entity: curve.id, point: 'none' },
        },
      ],
    };
  }

  // 距离：两点尺寸，值 = 当前最近点对距离。内核只认「点到点」和「点到线」，
  // 两条整线之间「距离」无定义（相交处处为零、错开又歧义），所以前端把
  // 尺寸钉在具体的一对点上。
  // 距离三兄弟：直线距离 / 水平距离（锁 x）/ 竖直距离（锁 y）。种子值取
  // 当前几何的对应量——建约束即「锁定现状」，改值才驱动。
  if (kind === 'distance' || kind === 'distanceX' || kind === 'distanceY') {
    const pair = closestPair(a, b);
    if (!pair) return { reason: '这两个对象上没有可用的点' };
    const p = constraintPointAt(a, pair.pa.point, pair.pa.index ?? 0);
    const q = constraintPointAt(b, pair.pb.point, pair.pb.index ?? 0);
    if (!p || !q) return { reason: '这两个对象上没有可用的点' };
    const value =
      kind === 'distance'
        ? pair.distance
        : kind === 'distanceX'
          ? Math.abs(p.x - q.x)
          : Math.abs(p.y - q.y);
    return {
      constraints: [
        {
          id: nextConstraintId(),
          kind,
          a: target(a.id, pair.pa),
          b: target(b.id, pair.pb),
          value,
        },
      ],
    };
  }

  // 角度：值 = 两线方向夹角（弧度，[0, π]）。内核按冻结符号侧求解，建约束
  // 时取当前夹角即「锁定现状」。
  if (kind === 'angle') {
    if (a.type !== 'line' || b.type !== 'line') return { reason: '角度需要两条直线' };
    const va = { x: a.b.x - a.a.x, y: a.b.y - a.a.y };
    const vb = { x: b.b.x - b.a.x, y: b.b.y - b.a.y };
    const la = Math.hypot(va.x, va.y);
    const lb = Math.hypot(vb.x, vb.y);
    const dot = la > 0 && lb > 0 ? (va.x * vb.x + va.y * vb.y) / (la * lb) : 1;
    return {
      constraints: [
        {
          id: nextConstraintId(),
          kind,
          a: { entity: a.id, point: 'none' },
          b: { entity: b.id, point: 'none' },
          value: Math.acos(Math.min(1, Math.max(-1, dot))),
        },
      ],
    };
  }

  // Everything else constrains the two curves as wholes; the order only has to
  // be stable so the label reads the same way twice.
  return {
    constraints: [
      {
        id: nextConstraintId(),
        kind,
        a: { entity: a.id, point: 'none' },
        b: { entity: b.id, point: 'none' },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// One entity's own dimension — 改值即驱动
// ---------------------------------------------------------------------------

/**
 * The constraint that expresses **one entity's own dimension**.
 *
 * This is what makes 「改值即驱动」 work: a radius typed into the panel (or into
 * a dimension label) is not applied to the geometry and then forgotten — it is
 * written onto a constraint, so the value survives the next edit and keeps
 * driving the geometry from then on.
 *
 * Two shapes, both already expressible by the kernel:
 *
 * * **`radius` / `diameter`** pin the curve itself (unary: `b` absent), exactly
 *   like the 半径 / 直径 buttons in the Ribbon.
 * * **`distance` between a line's own two endpoints** is its **length**. The
 *   kernel only ever wanted two *named points* for a distance — nothing requires
 *   them to live on different entities, so a self-referencing distance is a
 *   length dimension with no new residual kind and no wire-format change. (Two
 *   whole curves still have no distance, which is why that stays the front end's
 *   job; see `buildConstraints`.)
 *
 * Returns `null` for a combination that has no dimension — e.g. a line's angle
 * (the `angle` kind needs *two* lines) or an ellipse's semi-axes (no such kind
 * yet). The caller keeps the plain geometry edit in that case.
 */
export function buildEntityDimension(
  e: Entity,
  kind: ConstraintKind,
  value: number,
): Constraint | null {
  if (kind === 'radius' || kind === 'diameter') {
    if (e.type !== 'circle' && e.type !== 'arc') return null;
    return { id: nextConstraintId(), kind, a: { entity: e.id, point: 'none' }, value };
  }
  if (kind === 'distance') {
    if (e.type !== 'line') return null;
    return {
      id: nextConstraintId(),
      kind,
      a: { entity: e.id, point: 'start' },
      b: { entity: e.id, point: 'end' },
      value,
    };
  }
  return null;
}

/** Whether a constraint is a single entity's own dimension (`a` and `b` on it). */
export function isSelfDimension(c: Constraint): boolean {
  return c.b !== undefined && c.b.entity === c.a.entity;
}

// ---------------------------------------------------------------------------
// Degrees-of-freedom report (ROADMAP 0.3)
// ---------------------------------------------------------------------------

/** 「这条草图现在是什么状态」—— 状态栏与画布配色都用它。 */
export interface ConstraintReport {
  /** Remaining degrees of freedom; `0` means 完全定义. */
  dof: number;
  /** Constraints that add nothing new (consistent, just redundant). */
  redundant: number;
  /** Every constraint satisfied? */
  solved: boolean;
  /** 无法同时成立的约束（原对象），用于点名。 */
  conflicting: Constraint[];
  /** 冲突涉及的图元 —— 画成警示红。 */
  conflictingEntities: Set<EntityId>;
  /**
   * 图元 id → 它**还能往哪动**的位掩码（`DOF_MODE`）。
   *
   * 这是「方向」那一半：`dof` 说还差几个，这里说差在哪。内核拿已经算出来的
   * 雅可比逐图元测「平移 / 转动 / 改尺寸」是否落在零空间里——落在里面就等于
   * 「这个动作不会破坏任何一条已加的约束」。
   */
  freeModes: Map<EntityId, number>;
  /** 参与统计的图元数（活动基准面上的），用于文案。 */
  entityCount: number;
  /** 真正送进统计的约束条数。 */
  constraintCount: number;
}

/** 内核 `MODE_*` 的镜像：一个图元还能做的**可读动作**。 */
export const DOF_MODE = {
  /** 可沿 +X/−X 平移。 */
  tx: 1,
  /** 可沿 +Y/−Y 平移。 */
  ty: 2,
  /** 可绕某个命名点/质心转动。 */
  rot: 4,
  /** 尺寸未定（半径 / 长度 / 半轴还能变）。 */
  size: 8,
} as const;

/**
 * 这个图元**还缺东西**吗（ROADMAP 0.3 的「草图颜色提示」用）。
 *
 * 判定刻意只认**尺寸与方位**（`size` / `rot`）：那才是「还能再加一条约束把它定住」的
 * 自由度。**只差平移不算** —— 本版本没有锚点/固定约束（内核里一个都没有），位置本来
 * 就钉不掉；把它算进来，整张图会永远显示"欠定义"，提示随之失去意义。等 `fixed`
 * 锚点落地后，这里再收紧成「modes === 0 才算定完」。
 */
export function isUnderDefined(modes: number | undefined): boolean {
  return modes !== undefined && (modes & (DOF_MODE.rot | DOF_MODE.size)) !== 0;
}

/**
 * Analyze the **active sketch**: the entities on the active datum plane, against
 * every constraint that references them.
 *
 * Scope choices, all deliberate:
 *
 * * **Active plane only.** A constraint is a relationship inside one sketch; the
 *   status bar reports the sketch you are drawing on, not a sum over all planes.
 * * **Document-wide, not selection-wide.** 「还剩多少自由度」 is a property of the
 *   sketch, so an unconstrained line on the same plane still contributes its four
 *   degrees of freedom. (AutoCAD reports the selection; SolidWorks reports the
 *   sketch. This is the sketch number.)
 * * **`null` only when there is genuinely nothing to say** — no kernel yet, an
 *   older wasm without the export, or an empty plane. A sketch with **zero**
 *   constraints is still a valid report (`constraintCount === 0`, every motion
 *   free): that is exactly the state a freshly drawn curve is in, and the canvas
 *   markers have to be able to say "this line can still do anything". The status
 *   bar words that state as 无约束 rather than as a bare number.
 *
 * Cost: one extra kernel call per document change (not per frame — callers skip
 * live previews). The kernel only ranks a Jacobian whose rows are the residuals
 * and whose columns are the sketch's parameters, which is cheap for the sketch
 * sizes this app deals with; with no constraints at all the Jacobian is empty
 * and the whole thing short-circuits.
 */
export function analyzeDocument(doc: CadDocument): ConstraintReport | null {
  const kernel = kernelOrNull();
  if (!kernel) return null;
  // A wasm build from before the report existed has no such export.
  if (typeof kernel.analyze_constraints !== 'function') return null;

  // The active sketch, and only it: a constraint is a relationship inside one
  // sketch, so the status bar reports the sketch you are drawing on, not a sum
  // over all planes. `sketchEntities` is that filter, spelled once.
  const scene = sketchEntities(doc);
  if (scene.length === 0) return null;

  const { flat, sent } = constraintInputs(doc, scene);
  if (flat.length === 0 && doc.constraints.length > 0) {
    // 有约束，但没有一条落在活动基准面上（都在别的面 / 对象已删）：说不清，
    // 不假装「没有约束」。
    return null;
  }

  const packed = packScene(scene);
  const out = kernel.analyze_constraints(packed.encoded, packed.counts, Float64Array.from(flat));
  if (!out || out.length < 7) return null;

  const conflicting: Constraint[] = [];
  for (let i = 7; i < 7 + out[6]!; i++) {
    const c = sent[out[i]!];
    if (c) conflicting.push(c);
  }
  const conflictingEntities = new Set<EntityId>();
  for (const c of conflicting) {
    conflictingEntities.add(c.a.entity);
    if (c.b) conflictingEntities.add(c.b.entity);
  }

  // 尾部：`modeCount` + 每个图元一个位掩码，与传入的 `scene` 同序。
  const freeModes = new Map<EntityId, number>();
  const modeStart = 7 + out[6]! + 1;
  const modeCount = out[7 + out[6]!] ?? 0;
  for (let i = 0; i < modeCount; i++) {
    const e = scene[i];
    const flags = out[modeStart + i];
    if (e && flags !== undefined) freeModes.set(e.id, flags);
  }

  return {
    dof: out[0]!,
    redundant: out[3]!,
    solved: out[5]! !== 0,
    conflicting,
    conflictingEntities,
    freeModes,
    entityCount: scene.length,
    constraintCount: sent.length,
  };
}

// ---------------------------------------------------------------------------
// The solver bridge
// ---------------------------------------------------------------------------

/**
 * Re-solve the constraints touched by `movingIds` and return the entities that
 * need to change.
 *
 * Contract, and why it is shaped this way:
 *
 * * **Only the entities named in `movingIds` may move.** That is what makes
 *   dragging feel right — pulling one curve makes its partner stay put and the
 *   *relationship* hold, instead of the whole drawing sliding around. Callers
 *   choose the scope; see the call sites in `editorStore`.
 * * **Returns only what changed**, so the caller can append the repairs to the
 *   same `Command` as the user's own edit and get a single undo step.
 * * **Returns `[]` for every failure mode** — no constraints, no kernel yet, a
 *   decode failure, nothing movable. The caller then keeps the naive geometry,
 *   which is exactly the pre-feature behaviour rather than a corrupted document.
 */
/**
 * 把「一批图元 + 文档里的约束」压成内核要的形状。
 *
 * 解算与自由度分析共用这一份装配，理由很实际：两边对「约束怎么编号、哪个槽位
 * 是目标值」必须**逐位一致**，否则冲突序号会指到别的约束上。
 *
 * `sent` 与 `flat` 一一对应（每 8 个数一条），保留的是**原对象**——内核回话里的
 * 冲突序号指向 `flat` 的顺序，前端要靠它回指到 `doc.constraints` 里的那一条。
 */
interface ConstraintInputs {
  flat: number[];
  sent: Constraint[];
}

function constraintInputs(doc: CadDocument, scene: readonly Entity[]): ConstraintInputs {
  const index = new Map<EntityId, number>();
  scene.forEach((e, i) => index.set(e.id, i));

  const flat: number[] = [];
  const sent: Constraint[] = [];
  for (const c of doc.constraints) {
    const ia = index.get(c.a.entity);
    if (ia === undefined) continue;
    let ib = -1;
    let bKind = 0;
    let bIndex = 0;
    if (c.b) {
      const j = index.get(c.b.entity);
      // A constraint whose partner is gone is skipped, not repaired: there is
      // nothing to guess from.
      if (j === undefined) continue;
      ib = j;
      bKind = CONSTRAINT_POINT_TAG[c.b.point];
      bIndex = c.b.index ?? 0;
    } else if (!UNARY_CONSTRAINTS.has(c.kind)) {
      continue;
    }
    flat.push(
      CONSTRAINT_KIND_TAG[c.kind],
      ia,
      CONSTRAINT_POINT_TAG[c.a.point],
      c.a.index ?? 0,
      ib,
      bKind,
      bIndex,
      // 第 8 个数 = 尺寸目标值；几何约束恒为 0，内核侧同样忽略。
      c.value ?? 0,
    );
    sent.push(c);
  }
  return { flat, sent };
}

export function solveConstraints(doc: CadDocument, movingIds: Iterable<EntityId>): Entity[] {
  const kernel = kernelOrNull();
  if (!kernel || doc.constraints.length === 0) return [];

  const moving = new Set(movingIds);
  const involvedIds = new Set<EntityId>();
  for (const c of doc.constraints) {
    involvedIds.add(c.a.entity);
    if (c.b) involvedIds.add(c.b.entity);
  }

  // Cross-sketch by id on purpose: constraints are stored document-wide, and a
  // solve that silently dropped the ones naming entities on other planes would
  // be a constraint that "exists but does nothing".
  const involved = allEntities(doc).filter((e) => involvedIds.has(e.id));
  // Nothing to do unless something that participates is allowed to move.
  if (!involved.some((e) => moving.has(e.id))) return [];

  const { flat } = constraintInputs(doc, involved);
  if (flat.length === 0) return [];

  const scene = packScene(involved);
  const flags = new Uint8Array(involved.length);
  involved.forEach((e, i) => {
    flags[i] = moving.has(e.id) ? 1 : 0;
  });

  // A wasm build from before the constraint solver existed has no such export.
  // Calling it would throw a TypeError from inside an undo command, which is a
  // far worse failure than "the constraint is stored but nothing moved yet".
  if (typeof kernel.solve_constraints !== 'function') return [];

  const out = kernel.solve_constraints(
    scene.encoded,
    scene.counts,
    Float64Array.from(flat),
    flags,
  );
  // Header of three numbers, then the geometry. An empty (or truncated) reply
  // means "keep what you have".
  if (!out || out.length < 3) return [];

  const changed: Entity[] = [];
  let cursor = 3;
  for (let i = 0; i < involved.length; i++) {
    const n = scene.counts[i]!;
    const next = applySolved(involved[i]!, out.subarray(cursor, cursor + n));
    cursor += n;
    if (next && !sameGeometry(involved[i]!, next)) changed.push(next);
  }
  return changed;
}

/** Turn a returned wire slice back into an entity, or `null` if unusable. */
function applySolved(e: Entity, buf: Float64Array): Entity | null {
  if (buf.length < 2) return null;
  // A wild solve must never reach the document: NaN propagates into bounds,
  // tessellation and the file, and the drawing becomes unrecoverable by undo
  // because every later command inherits it.
  for (let i = 1; i < buf.length; i++) {
    if (!Number.isFinite(buf[i]!)) return null;
  }

  switch (e.type) {
    case 'line':
      if (buf.length < 5) return null;
      return { ...e, a: { x: buf[1]!, y: buf[2]! }, b: { x: buf[3]!, y: buf[4]! } };
    case 'circle':
      if (buf.length < 4) return null;
      return { ...e, center: { x: buf[1]!, y: buf[2]! }, radius: buf[3]! };
    case 'arc':
      if (buf.length < 6) return null;
      return {
        ...e,
        center: { x: buf[1]!, y: buf[2]! },
        radius: buf[3]!,
        startAngle: buf[4]!,
        endAngle: buf[5]!,
      };
    case 'ellipse':
      if (buf.length < 6) return null;
      return {
        ...e,
        center: { x: buf[1]!, y: buf[2]! },
        rx: buf[3]!,
        ry: buf[4]!,
        rotation: buf[5]!,
      };
    case 'polyline': {
      // Wire layout is `[tag, closed, vertexCount, x, y, …]` — the vertex count
      // at `buf[2]` is a *slot*, not a coordinate. Reading the points from
      // `buf[2]` shifted every coordinate by one number (the count became the
      // first x, and the last y was dropped), so any solve that moved a
      // polyline wrote nonsense geometry back into the document. Same layout as
      // `decodePrimitive` and the kernel's `decode_prim`.
      const declared = Number.isFinite(buf[2]) ? Math.floor(buf[2]!) : 0;
      const available = Math.floor((buf.length - 3) / 2);
      const count = Math.min(declared, available);
      if (count < 2) return null;
      const points: Vec2[] = [];
      for (let i = 0; i < count; i++) {
        points.push({ x: buf[3 + i * 2]!, y: buf[4 + i * 2]! });
      }
      return { ...e, points, closed: buf[1] !== 0 };
    }
  }
}

/**
 * Did the solve actually change the geometry?
 *
 * Compared on the encoded parameters with a tolerance rather than by deep
 * equality: a solve that leaves a satisfied constraint alone returns the same
 * doubles, but a marginally-violated one produces differences around 1e-16, and
 * turning those into undo entries would make every drag push a command that
 * changed nothing the user can see.
 */
function sameGeometry(a: Entity, b: Entity, tol = 1e-9): boolean {
  if (a.type !== b.type) return false;
  const pa = packOne(a);
  const pb = packOne(b);
  if (pa.length !== pb.length) return false;
  for (let i = 0; i < pa.length; i++) {
    if (Math.abs(pa[i]! - pb[i]!) > tol) return false;
  }
  return true;
}
