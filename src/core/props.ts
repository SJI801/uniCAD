/**
 * Property descriptors for the 属性 panel.
 *
 * Why a descriptor table instead of five hand-written JSX blocks
 * -----------------------------------------------------------------
 * The panel has to expose *every* parameter of an entity, and an entity's
 * geometry differs per type. Written as markup, the read path and the write path
 * live in different places: the value comes from `{fmt(e.a.x)}` while the edit
 * has to reconstruct the whole entity by hand. Every parameter is then two edits
 * in two places, and a parameter silently stays read-only whenever someone
 * forgets the second one — which is exactly how the entire geometry section
 * ended up read-only in the first place.
 *
 * Here each row carries its own `applyTo`, so "is this editable?" is answered by
 * "does this row have an apply?". A row without one must say so explicitly
 * (`kind: 'info'`), and `verify:props` asserts that every non-info row is
 * editable — adding a parameter as read-only is then a loud failure instead of
 * an omission.
 *
 * The applies take the *base* entity as their first argument rather than
 * capturing it. That matters for correctness, not style: the panel renders from
 * one snapshot and commits against another (the store reads the entity fresh
 * when it builds the undo patch), so a closure over the rendered entity would
 * write back a stale copy and quietly revert whatever changed in between.
 *
 * Derived parameters
 * ------------------
 * Several rows are *not* independent degrees of freedom: a circle's diameter,
 * circumference and area all determine its radius; a line's length and angle
 * move an endpoint. They are still editable — 「任何参数都能修改」 — but the
 * mapping back onto the real DOF has to be stated, because it is a choice
 * rather than a definition. That statement lives in `hint` and is rendered as
 * the control's tooltip, e.g. 「固定起点，沿当前方向移动终点」.
 *
 * Two rules keep those choices predictable:
 *
 *   - **Hold everything you were not asked about.** Editing a length keeps the
 *     direction; editing an angle keeps the length; editing an arc's sweep keeps
 *     its radius.
 *   - **Leave the anchor alone.** Length and angle move the *end* point; a
 *     polyline's total length scales about its centroid.
 *
 * Angles are radians everywhere else in the codebase and **degrees** here. The
 * conversion is confined to this file, so no caller has to remember which is
 * which — the panel input and the store never meet.
 */

import type { CadDocument, Entity, LayerId, LineStyle, Vec2 } from './types';
import { normalizeSweep } from './entities';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const TAU = Math.PI * 2;

/** Radians → the number shown in a degree input, normalised to [0, 360). */
export function toDeg(radians: number): number {
  const d = (((radians * DEG) % 360) + 360) % 360;
  // Snap values a hair below 360 (e.g. 359.99999999999994) to 0, so the input
  // never shows a number the user did not type.
  return d > 360 - 1e-9 ? 0 : d;
}

const fromDeg = (deg: number): number => deg * RAD;

/**
 * Display precision for an editable number.
 *
 * Rounding on *display* is what stops a value that came out of a calculation
 * from showing up as 21.350000000000001 and then being written back verbatim.
 * The user sees 21.35, and unless they edit it, 21.35 is what stays.
 */
function round(n: number, digits = 6): number {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export const LINE_STYLE_OPTIONS: ReadonlyArray<{ value: LineStyle; label: string }> = [
  { value: 'continuous', label: '实线' },
  { value: 'dashed', label: '虚线' },
  { value: 'dotted', label: '点线' },
  { value: 'dashdot', label: '点划线' },
  { value: 'center', label: '中心线' },
  { value: 'hidden', label: '隐藏线' },
];

export type PropKind = 'number' | 'vec2' | 'bool' | 'text' | 'color' | 'enum' | 'info';

export interface PropField {
  /** Stable key. Published as `data-param` so scripts can address a control. */
  key: string;
  label: string;
  kind: PropKind;
  /**
   * Current value in **display** units (angles in degrees, lengths in model
   * units). `vec2` rows carry a plain `Vec2`.
   */
  value: number | boolean | string | null | Vec2;
  /** Computed from the real degrees of freedom rather than stored. */
  derived?: boolean;
  /** The entity holds `null` here and inherits from its layer. */
  inherited?: boolean;
  /**
   * Multi-selection only: the selected objects disagree about this parameter.
   *
   * Not a third state of the value — `value` is still shown, as a placeholder or
   * a "多个值" option, so the control remains usable and picking something
   * simply makes them agree.
   */
  mixed?: boolean;
  /** Tooltip. Mandatory on `derived` rows — states how an edit is applied. */
  hint?: string;
  step?: number;
  min?: number;
  max?: number;
  /** Unit suffix shown inside the input. */
  unit?: string;
  options?: ReadonlyArray<{ value: string; label: string }>;
  /** Apply a scalar: number rows, and one axis of a `vec2` row. */
  applyTo?(base: Entity, v: number, axis?: 0 | 1): Entity;
  /** Apply a non-numeric value: bool / text / color / enum rows. */
  applyValueTo?(base: Entity, v: string | boolean): Entity;
  /** Clear the override so the value comes from the layer again. */
  inheritFrom?(base: Entity): Entity;
}

export interface PropSection {
  title: string;
  fields: PropField[];
}

/** Cap on the per-vertex editors a polyline contributes. */
export const MAX_VERTEX_ROWS = 64;

/**
 * A row that is genuinely informational — no edit is possible in principle.
 *
 * Kept as an explicit kind rather than "a field that happens to have no
 * `applyTo`", so a test can tell the two apart: a missing `applyTo` on a real
 * parameter is a bug, while `kind: 'info'` is a deliberate statement.
 */
function infoField(key: string, label: string, text: string, hint: string): PropField {
  return { key, label, kind: 'info', value: text, hint };
}

/**
 * The 「常规」 section: everything an entity shares with every other entity.
 *
 * These are the *only* fields a multi-selection can edit at once, so the
 * multi-select view reuses exactly this list (see the panel).
 */
export function describeCommonProps(entity: Entity, doc: CadDocument): PropField[] {
  const layer = doc.layers.find((l) => l.id === entity.layer);
  return [
    {
      key: 'layer',
      label: '图层',
      kind: 'enum',
      value: entity.layer,
      options: doc.layers.map((l) => ({ value: l.id, label: l.name })),
      hint: '把对象移到另一个图层。图层决定「随层」的颜色、线型与线宽。',
      applyValueTo: (base, v) => ({ ...base, layer: v as LayerId }),
    },
    {
      key: 'color',
      label: '颜色',
      kind: 'color',
      // The swatch shows the colour actually in effect, not a placeholder grey —
      // 「随层」 tells you *where* it comes from, and the value tells you what
      // that currently resolves to. Same treatment as linetype and lineweight.
      value: entity.color ?? layer?.color ?? '#e8e8e8',
      inherited: entity.color === null,
      hint:
        entity.color === null
          ? `随层：当前取图层「${layer?.name ?? '—'}」的颜色（${layer?.color ?? '—'}）`
          : '对象自身的颜色，覆盖图层颜色。点「随层」恢复继承。',
      applyValueTo: (base, v) => ({ ...base, color: String(v) }),
      inheritFrom: (base) => ({ ...base, color: null }),
    },
    {
      key: 'lineStyle',
      label: '线型',
      kind: 'enum',
      // 'continuous' rather than null when inherited, so the select shows the
      // value actually in effect instead of an empty box.
      value: entity.lineStyle ?? layer?.lineStyle ?? 'continuous',
      inherited: entity.lineStyle === null,
      options: LINE_STYLE_OPTIONS,
      hint:
        entity.lineStyle === null
          ? `随层：当前取图层「${layer?.name ?? '—'}」的线型`
          : '对象自身的线型，覆盖图层线型。点「随层」恢复继承。',
      applyValueTo: (base, v) => ({ ...base, lineStyle: v as LineStyle }),
      inheritFrom: (base) => ({ ...base, lineStyle: null }),
    },
    {
      key: 'lineWeight',
      label: '线宽',
      kind: 'number',
      value: round(entity.lineWeight ?? layer?.lineWeight ?? 0.25, 4),
      inherited: entity.lineWeight === null,
      hint:
        entity.lineWeight === null
          ? `随层：当前取图层「${layer?.name ?? '—'}」的线宽（mm）`
          : '对象自身的线宽（mm），覆盖图层线宽。点「随层」恢复继承。',
      step: 0.05,
      min: 0,
      unit: 'mm',
      applyTo: (base, v) => ({ ...base, lineWeight: v }),
      inheritFrom: (base) => ({ ...base, lineWeight: null }),
    },
    {
      key: 'name',
      label: '名称',
      kind: 'text',
      value: entity.name ?? '',
      hint: '便于识别的备注名。留空即清除。',
      applyValueTo: (base, v) => {
        const text = String(v).trim();
        return text === '' ? { ...base, name: undefined } : { ...base, name: text };
      },
    },
  ];
}

/**
 * Every parameter the panel shows for one entity, grouped into sections.
 *
 * Rows come out in a fixed order, and every one of them is editable unless its
 * `kind` is `'info'`.
 */
export function describeEntityProps(entity: Entity, doc: CadDocument): PropSection[] {
  return [
    { title: '常规', fields: describeCommonProps(entity, doc) },
    { title: '几何', fields: geometryFields(entity) },
  ];
}

function geometryFields(e: Entity): PropField[] {
  switch (e.type) {
    case 'line':
      return lineFields(e);
    case 'circle':
      return circleFields(e);
    case 'arc':
      return arcFields(e);
    case 'ellipse':
      return ellipseFields(e);
    case 'polyline':
      return polylineFields(e);
  }
}

// ---------------------------------------------------------------------------
// Line
// ---------------------------------------------------------------------------

function lineFields(e: Extract<Entity, { type: 'line' }>): PropField[] {
  const dx = e.b.x - e.a.x;
  const dy = e.b.y - e.a.y;
  const length = Math.hypot(dx, dy);

  return [
    pointField('a', '起点', e.a, (base, axis, v) => {
      const line = base as Extract<Entity, { type: 'line' }>;
      return {
        ...line,
        a: axis === 0 ? { x: v, y: line.a.y } : { x: line.a.x, y: v },
      };
    }),
    pointField('b', '终点', e.b, (base, axis, v) => {
      const line = base as Extract<Entity, { type: 'line' }>;
      return {
        ...line,
        b: axis === 0 ? { x: v, y: line.b.y } : { x: line.b.x, y: v },
      };
    }),
    {
      key: 'length',
      label: '长度',
      kind: 'number',
      value: round(length),
      derived: true,
      min: 0,
      step: 1,
      hint: '固定起点，沿当前方向移动终点。方向未定义（长度为零）时按 +X 处理。',
      applyTo: (base, v) => {
        const line = base as Extract<Entity, { type: 'line' }>;
        const ex = line.b.x - line.a.x;
        const ey = line.b.y - line.a.y;
        const cur = Math.hypot(ex, ey);
        // A zero-length line has no direction; +X is the conventional fallback
        // and matches what the LINE tool does for its own first segment.
        const ux = cur < 1e-12 ? 1 : ex / cur;
        const uy = cur < 1e-12 ? 0 : ey / cur;
        const want = Math.max(0, v);
        return { ...line, b: { x: line.a.x + ux * want, y: line.a.y + uy * want } };
      },
    },
    {
      key: 'angle',
      label: '角度',
      kind: 'number',
      value: round(toDeg(Math.atan2(dy, dx)), 4),
      derived: true,
      step: 5,
      unit: '°',
      hint: '固定起点，绕起点把终点转到该角度（长度不变）。',
      applyTo: (base, v) => {
        const line = base as Extract<Entity, { type: 'line' }>;
        const cur = Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y);
        const rad = fromDeg(v);
        return {
          ...line,
          b: { x: line.a.x + Math.cos(rad) * cur, y: line.a.y + Math.sin(rad) * cur },
        };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Circle
// ---------------------------------------------------------------------------

function circleFields(e: Extract<Entity, { type: 'circle' }>): PropField[] {
  const r = e.radius;
  return [
    pointField('center', '圆心', e.center, (base, axis, v) => {
      const c = base as Extract<Entity, { type: 'circle' }>;
      return {
        ...c,
        center: axis === 0 ? { x: v, y: c.center.y } : { x: c.center.x, y: v },
      };
    }),
    {
      key: 'radius',
      label: '半径',
      kind: 'number',
      value: round(r),
      min: 0,
      step: 1,
      hint: '圆的半径，是圆唯一的尺寸自由度。',
      applyTo: (base, v) => ({ ...base, radius: Math.max(0, v) } as Entity),
    },
    {
      key: 'diameter',
      label: '直径',
      kind: 'number',
      value: round(2 * r),
      derived: true,
      min: 0,
      step: 1,
      hint: '派生：半径 = 直径 ÷ 2。',
      applyTo: (base, v) => ({ ...base, radius: Math.max(0, v) / 2 } as Entity),
    },
    {
      key: 'circumference',
      label: '周长',
      kind: 'number',
      value: round(TAU * r),
      derived: true,
      min: 0,
      step: 1,
      hint: '派生：半径 = 周长 ÷ 2π。',
      applyTo: (base, v) => ({ ...base, radius: Math.max(0, v) / TAU } as Entity),
    },
    {
      key: 'area',
      label: '面积',
      kind: 'number',
      value: round(Math.PI * r * r),
      derived: true,
      min: 0,
      step: 1,
      hint: '派生：半径 = √(面积 ÷ π)。',
      applyTo: (base, v) => ({ ...base, radius: Math.sqrt(Math.max(0, v) / Math.PI) } as Entity),
    },
  ];
}

// ---------------------------------------------------------------------------
// Arc
// ---------------------------------------------------------------------------

function arcFields(e: Extract<Entity, { type: 'arc' }>): PropField[] {
  const sweep = normalizeSweep(e.startAngle, e.endAngle);
  return [
    pointField('center', '圆心', e.center, (base, axis, v) => {
      const a = base as Extract<Entity, { type: 'arc' }>;
      return {
        ...a,
        center: axis === 0 ? { x: v, y: a.center.y } : { x: a.center.x, y: v },
      };
    }),
    {
      key: 'radius',
      label: '半径',
      kind: 'number',
      value: round(e.radius),
      min: 0,
      step: 1,
      hint: '圆弧半径。',
      applyTo: (base, v) => ({ ...base, radius: Math.max(0, v) } as Entity),
    },
    {
      key: 'startAngle',
      label: '起始角',
      kind: 'number',
      value: round(toDeg(e.startAngle), 4),
      step: 5,
      unit: '°',
      hint: '起点相对圆心的角度（逆时针为正，X 轴为 0°）。',
      applyTo: (base, v) => ({ ...base, startAngle: fromDeg(v) } as Entity),
    },
    {
      key: 'endAngle',
      label: '终止角',
      kind: 'number',
      value: round(toDeg(e.endAngle), 4),
      step: 5,
      unit: '°',
      hint: '终点相对圆心的角度。圆弧始终从起始角逆时针扫到终止角。',
      applyTo: (base, v) => ({ ...base, endAngle: fromDeg(v) } as Entity),
    },
    {
      key: 'sweep',
      label: '扫掠角',
      kind: 'number',
      value: round(toDeg(sweep), 4),
      derived: true,
      // Held strictly inside (0, 360): both ends are degenerate, and a sweep of
      // exactly 0 would be silently "normalised" away by `normalizeSweep`, so a
      // typed 360 would look as if the arc had vanished.
      min: 0.001,
      max: 359.999,
      step: 5,
      unit: '°',
      hint: '派生：固定起始角，终止角 = 起始角 + 扫掠角（逆时针）。限 (0°, 360°)，避免退化成空圆弧。',
      applyTo: (base, v) => {
        const a = base as Extract<Entity, { type: 'arc' }>;
        const clamped = Math.min(359.999, Math.max(0.001, v));
        return { ...a, endAngle: a.startAngle + fromDeg(clamped) };
      },
    },
    {
      key: 'arcLength',
      label: '弧长',
      kind: 'number',
      value: round(e.radius * sweep),
      derived: true,
      min: 0,
      step: 1,
      hint: '派生：固定圆心角，半径 = 弧长 ÷ 扫掠角。',
      applyTo: (base, v) => {
        const a = base as Extract<Entity, { type: 'arc' }>;
        const s = normalizeSweep(a.startAngle, a.endAngle);
        if (s < 1e-9) return a;
        return { ...a, radius: Math.max(0, v) / s };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Ellipse
// ---------------------------------------------------------------------------

function ellipseFields(e: Extract<Entity, { type: 'ellipse' }>): PropField[] {
  return [
    pointField('center', '中心', e.center, (base, axis, v) => {
      const el = base as Extract<Entity, { type: 'ellipse' }>;
      return {
        ...el,
        center: axis === 0 ? { x: v, y: el.center.y } : { x: el.center.x, y: v },
      };
    }),
    {
      key: 'rx',
      label: '长半轴',
      kind: 'number',
      value: round(e.rx),
      min: 0,
      step: 1,
      hint: '沿旋转方向的半轴。',
      applyTo: (base, v) => ({ ...base, rx: Math.max(0, v) } as Entity),
    },
    {
      key: 'ry',
      label: '短半轴',
      kind: 'number',
      value: round(e.ry),
      min: 0,
      step: 1,
      hint: '垂直于旋转方向的半轴。',
      applyTo: (base, v) => ({ ...base, ry: Math.max(0, v) } as Entity),
    },
    {
      key: 'rotation',
      label: '旋转角',
      kind: 'number',
      value: round(toDeg(e.rotation), 4),
      step: 5,
      unit: '°',
      hint: '长半轴相对 X 轴的角度（逆时针为正）。',
      applyTo: (base, v) => ({ ...base, rotation: fromDeg(v) } as Entity),
    },
    {
      key: 'area',
      label: '面积',
      kind: 'number',
      value: round(Math.PI * e.rx * e.ry),
      derived: true,
      min: 0,
      step: 1,
      hint: '派生：等比例缩放两条半轴，使 π·rx·ry 等于该值（长短轴之比与旋转角不变）。',
      applyTo: (base, v) => {
        const el = base as Extract<Entity, { type: 'ellipse' }>;
        const current = Math.PI * el.rx * el.ry;
        if (current < 1e-12) return el;
        const k = Math.sqrt(Math.max(0, v) / current);
        return { ...el, rx: el.rx * k, ry: el.ry * k };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Polyline
// ---------------------------------------------------------------------------

function polylineFields(e: Extract<Entity, { type: 'polyline' }>): PropField[] {
  const fields: PropField[] = [];
  const shown = Math.min(e.points.length, MAX_VERTEX_ROWS);

  for (let i = 0; i < shown; i++) {
    fields.push(
      pointField(`v${i}`, `顶点 ${i + 1}`, e.points[i]!, (base, axis, v) => {
        const pl = base as Extract<Entity, { type: 'polyline' }>;
        // Guard the index: a concurrent edit (or an undo) may have shortened the
        // list since this row was rendered.
        if (i >= pl.points.length) return pl;
        const points = pl.points.map((p) => ({ ...p }));
        const target = points[i]!;
        if (axis === 0) target.x = v;
        else target.y = v;
        return { ...pl, points };
      }),
    );
  }

  if (e.points.length > shown) {
    fields.push(
      infoField(
        'vRest',
        '其余顶点',
        `… ${e.points.length - shown} 个未列出`,
        `本面板最多列 ${MAX_VERTEX_ROWS} 个顶点（其余顶点没有被隐藏）。用「顶点数」把它们减到可编辑范围内，或直接用夹点编辑。`,
      ),
    );
  }

  fields.push({
    key: 'count',
    label: '顶点数',
    kind: 'number',
    value: e.points.length,
    // Structural, yet genuinely editable: growing appends a copy of the last
    // vertex, shrinking drops the tail. Both are things the user can then fix up
    // with the vertex rows above — a lot more useful than a dead read-only count.
    min: 2,
    step: 1,
    hint: '结构性参数：增加会在末端追加一个与末点重合的顶点，减少则丢弃末端顶点（最少 2 个）。',
    applyTo: (base, v) => {
      const pl = base as Extract<Entity, { type: 'polyline' }>;
      const want = Math.max(2, Math.round(v));
      const points = pl.points.map((p) => ({ ...p }));
      while (points.length > want && points.length > 2) points.pop();
      while (points.length < want) points.push({ ...points[points.length - 1]! });
      return { ...pl, points };
    },
  });

  fields.push({
    key: 'closed',
    label: '闭合',
    kind: 'bool',
    value: e.closed,
    hint: '闭合时首尾之间多出一条边，总长度随之改变。',
    applyValueTo: (base, v) => ({ ...base, closed: Boolean(v) } as Entity),
  });

  fields.push({
    key: 'length',
    label: '总长度',
    kind: 'number',
    value: round(polylineLength(e.points, e.closed)),
    derived: true,
    min: 0,
    step: 1,
    hint: '派生：以顶点质心为中心等比缩放所有顶点，不改变形状。',
    applyTo: (base, v) => {
      const pl = base as Extract<Entity, { type: 'polyline' }>;
      const current = polylineLength(pl.points, pl.closed);
      if (current < 1e-12) return pl;
      const k = Math.max(0, v) / current;
      let cx = 0;
      let cy = 0;
      for (const p of pl.points) {
        cx += p.x;
        cy += p.y;
      }
      cx /= pl.points.length;
      cy /= pl.points.length;
      return {
        ...pl,
        points: pl.points.map((p) => ({ x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k })),
      };
    },
  });

  return fields;
}

export function polylineLength(points: ReadonlyArray<Vec2>, closed: boolean): number {
  let sum = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    sum += Math.hypot(points[i + 1]!.x - points[i]!.x, points[i + 1]!.y - points[i]!.y);
  }
  if (closed && points.length > 2) {
    const a = points[points.length - 1]!;
    const b = points[0]!;
    sum += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A coordinate pair rendered as two inputs on one row.
 *
 * `axis` is 0 for x and 1 for y — the only thing distinguishing the two halves
 * of the edit. Keeping them in a single field (rather than two scalar rows) is
 * what lets the label read 「起点」 once instead of 「起点 X」 / 「起点 Y」.
 */
function pointField(
  key: string,
  label: string,
  value: Vec2,
  apply: (base: Entity, axis: 0 | 1, v: number) => Entity,
): PropField {
  return {
    key,
    label,
    kind: 'vec2',
    value: { x: round(value.x), y: round(value.y) },
    step: 1,
    hint: '模型坐标，单位与文档一致。',
    applyTo: (base, v, axis = 0) => apply(base, axis, v),
  };
}

/** Describe a field's current value as text, for info rows. */
export function formatValue(f: PropField): string {
  const v = f.value;
  if (v === null) return '(随层)';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (typeof v === 'string') {
    if (f.kind === 'enum') {
      const opt = f.options?.find((o) => o.value === v);
      return opt ? opt.label : v;
    }
    return v === '' ? '—' : v;
  }
  if (typeof v === 'object') return `${v.x}, ${v.y}`;
  return String(v);
}
