/**
 * Automatic dimensions — the numbers that follow the drawing.
 *
 * Two sources feed one DOM overlay:
 *
 *   绘制中 — the active tool already computes a live `readout` ("R = 21.350",
 *           "距离 45.0  角度 26.57°"). It was computed on every cursor move and
 *           then thrown away — nothing ever rendered it. Here it gets a leader
 *           line and a pill next to the cursor.
 *   选中时 — every selected entity gets its own dimension, derived from its own
 *           geometry (length + angle, radius + diameter, sweep + arc length…).
 *
 * Geometry is emitted in **model space** so it rides the same GPU batch as the
 * entities and never forces a re-tessellation. Text is emitted in **screen
 * pixels** because crisp text is far cheaper with the browser's own rasteriser
 * than with a glyph atlas, and because annotation must not shrink when the
 * drawing is zoomed out.
 *
 * Labels are deliberately *not* document state: they describe the current
 * interaction, so they take no part in undo, saving, or DXF export.
 */

import { fmt, fmtAngle, type Entity, type Vec2 } from '../core/types';
import { boundsCenter, entityBoundsTS, unionBounds } from '../core/entities';
import type { OverlaySegment } from './overlay';
import { UI_COLORS } from './style';

/** 一条要画在画布上的尺寸文字。坐标是**屏幕 CSS 像素**，原点在画布左上角。 */
export interface DimLabel {
  x: number;
  y: number;
  text: string;
  /**
   * `live` = 绘制中的实时读数；`selected` = 选中图元的尺寸；`constraint` = 约束标记；
   * `dof` = 欠约束方向标记（⟳ / ⤢，见 `dofMarks.ts`）。
   */
  kind: 'live' | 'selected' | 'constraint' | 'dof';
  /**
   * Hover text. Only constraint badges set it — a dimension's text *is* its
   * meaning, but a one-character badge needs the full sentence spelled out or it
   * is just decoration.
   */
  title?: string;
}

export interface DimensionDraw {
  /** 模型坐标，直接并进 overlay 批次。 */
  segments: OverlaySegment[];
  labels: DimLabel[];
}

/** 调用方提供的换算上下文。 */
export interface DimContext {
  /** 模型 → 屏幕（画布 CSS 像素）。 */
  screenOf: (p: Vec2) => Vec2;
  /** 模型单位 → 屏幕像素的比值（`view.scale`）。 */
  scale: number;
  viewWidth: number;
  viewHeight: number;
}

/**
 * 标注在屏幕上量出来的固定长度。
 *
 * 全部按**屏幕像素**给，再乘 `scale` 换算成模型单位：标注是给眼睛看的，
 * 它离图元的距离、自己的刻度长度、文字大小在任何缩放下都必须一样。
 */
const SEG = {
  /** 尺寸线离被标注对象多远。 */
  offset: 18,
  /** 文字离尺寸线多远。 */
  gap: 11,
  /** 端点刻度半长。 */
  tick: 5,
  /** 标签夹进视口时留的边距。 */
  clampX: 58,
  clampY: 12,
} as const;

/**
 * 同时画出来的选中标注上限。
 *
 * 框选几百个图元时，逐条尺寸线加起来比图形本身还密，反而什么都读不出来。
 * 截断比「画出来再糊屏」诚实。
 */
const MAX_SELECTED_LABELS = 40;

const EMPTY_DRAW: DimensionDraw = { segments: [], labels: [] };

/**
 * 尺寸线该往哪一侧偏。
 *
 * 单看一个图元判断不出「外侧」—— 一条直线的两侧完全对称。但把**整批选中对象**
 * 的包围盒当成「这个图形」，答案就有了：法向朝着包围盒外面的那一侧。于是闭合
 * 轮廓的每条边都标在外面，而不是横穿内部、压在别的图元上。
 *
 * 只选中一个对象时包围盒中心就落在它自己身上（一条直线的包围盒中心就是它的中
 * 点），点积为 0 → 保持原方向，与逐条独立标注的结果一致。方向仍然可预测：
 * 反转直线方向会翻转标注侧。
 */
function outwardSign(mid: Vec2, nx: number, ny: number, center: Vec2 | null): number {
  if (!center) return 1;
  const dot = (mid.x - center.x) * nx + (mid.y - center.y) * ny;
  return dot >= 0 ? 1 : -1;
}

/**
 * 一段尺寸线（主线 + 端点刻度）以及它的文字锚点。
 *
 * 偏移与刻度都按屏幕像素给，再乘 scale 换成模型单位。
 */
function leader(
  from: Vec2,
  to: Vec2,
  ctx: DimContext,
  offsetPx: number,
  color: string,
  center: Vec2 | null,
): { segments: OverlaySegment[]; anchor: Vec2 } | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-9) || !Number.isFinite(ctx.scale) || ctx.scale <= 0) return null;

  let nx = -dy / len;
  let ny = dx / len;
  if (outwardSign({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, nx, ny, center) < 0) {
    nx = -nx;
    ny = -ny;
  }
  const off = offsetPx * ctx.scale;
  const tick = SEG.tick * ctx.scale;
  const a = { x: from.x + nx * off, y: from.y + ny * off };
  const b = { x: to.x + nx * off, y: to.y + ny * off };
  const seg = (p: Vec2, q: Vec2): OverlaySegment => ({ a: p, b: q, color, width: 1, dash: null });
  const at = (p: Vec2, s: number): Vec2 => ({ x: p.x + nx * s * tick, y: p.y + ny * s * tick });

  const segments: OverlaySegment[] = [seg(a, b)];
  // 半径 / 半轴这类贴在图元上的标注（offsetPx = 0）不画起点刻度 —— 它会正好
  // 落在圆心或中心上，糊成一个小星芒，看不出是刻度。
  if (offsetPx > 0) segments.push(seg(at(a, -1), at(a, 1)));
  segments.push(seg(at(b, -1), at(b, 1)));

  // 模型法向 → 屏幕方向只翻 y（模型 y 朝上、屏幕 y 朝下，且两个轴等比），
  // 所以文字锚点直接沿 (nx, -ny) 再往外推一段即可。
  const mid = ctx.screenOf({
    x: (from.x + to.x) / 2 + nx * off,
    y: (from.y + to.y) / 2 + ny * off,
  });
  return {
    segments,
    anchor: clampToView({ x: mid.x + nx * SEG.gap, y: mid.y - ny * SEG.gap }, ctx),
  };
}

/**
 * 把标签夹进画布内。
 *
 * 不做的话，标到视口边缘的图元会被 `.dim-layer` 的 `overflow: hidden` 裁掉
 * 半个数字 —— 而「差一点就能看见」比干脆不显示更让人抓狂。
 */
function clampToView(p: Vec2, ctx: DimContext): Vec2 {
  const x = Math.min(Math.max(p.x, SEG.clampX), Math.max(SEG.clampX, ctx.viewWidth - SEG.clampX));
  const y = Math.min(Math.max(p.y, SEG.clampY), Math.max(SEG.clampY, ctx.viewHeight - SEG.clampY));
  return { x, y };
}

/** 绘制中的实时尺寸：一条尺寸线 + 工具给出的读数。 */
export function liveDimension(
  from: Vec2,
  to: Vec2,
  text: string,
  ctx: DimContext,
): DimensionDraw {
  // center 传 null：绘制中只有一个对象，没有「图形内部」可言，保持法向原方向。
  const l = leader(from, to, ctx, SEG.offset, UI_COLORS.crosshair, null);
  if (!l) return EMPTY_DRAW;
  return {
    segments: l.segments,
    labels: [{ x: l.anchor.x, y: l.anchor.y, text, kind: 'live' }],
  };
}

/** 选中图元的尺寸：每个选中对象一条标注。 */
export function selectedDimensions(
  entities: readonly Entity[],
  selected: ReadonlySet<string>,
  ctx: DimContext,
): DimensionDraw {
  const segments: OverlaySegment[] = [];
  const labels: DimLabel[] = [];

  // 整批选中对象的公共包围盒中心 —— 「这个图形」的中枢，用来决定标注朝外还是
  // 朝内。超过上限被截断的那些也要算进来，否则截断会改变整体朝向。
  let bounds = unionBounds(null, null);
  for (const e of entities) {
    if (selected.has(e.id)) bounds = unionBounds(bounds, entityBoundsTS(e));
  }
  const center = bounds ? boundsCenter(bounds) : null;

  for (const e of entities) {
    if (labels.length >= MAX_SELECTED_LABELS) break;
    if (!selected.has(e.id)) continue;
    const spec = dimensionSpec(e);
    if (!spec) continue;
    const l = leader(spec.from, spec.to, ctx, spec.offsetPx, UI_COLORS.selected, center);
    if (!l) continue;
    segments.push(...l.segments);
    labels.push({ x: l.anchor.x, y: l.anchor.y, text: spec.text, kind: 'selected' });
  }
  return { segments, labels };
}

interface DimSpec {
  from: Vec2;
  to: Vec2;
  text: string;
  /** 尺寸线离图元多远（屏幕像素）。0 = 就贴在图元上（半径 / 半轴）。 */
  offsetPx: number;
}

/**
 * 每种图元该标什么、标在哪里。
 *
 * 规则是「一眼能读出这个对象有多大的那个量」，而不是把能算的都列上：
 * 直线给长度 + 方位角，圆给半径 + 直径，圆弧额外给圆心角与弧长，
 * 多段线给总长（逐段标会在每个拐角堆出一个数字）。
 */
function dimensionSpec(e: Entity): DimSpec | null {
  switch (e.type) {
    case 'line': {
      const dx = e.b.x - e.a.x;
      const dy = e.b.y - e.a.y;
      const len = Math.hypot(dx, dy);
      if (!(len > 1e-9)) return null;
      return {
        from: e.a,
        to: e.b,
        offsetPx: SEG.offset,
        text: `${fmt(len)}  ∠${fmtAngle(Math.atan2(dy, dx))}`,
      };
    }

    case 'polyline': {
      const pts = e.points;
      if (pts.length < 2) return null;
      const edgeCount = e.closed ? pts.length : pts.length - 1;
      let total = 0;
      let longest = -1;
      let from = pts[0]!;
      let to = pts[1]!;
      for (let i = 0; i < edgeCount; i++) {
        const p = pts[i]!;
        const q = pts[(i + 1) % pts.length]!;
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        total += d;
        // 标在最长的边上：它最不容易被别的图元压住，也最不容易短到放不下文字。
        if (d > longest) {
          longest = d;
          from = p;
          to = q;
        }
      }
      if (!(total > 1e-9)) return null;
      return {
        from,
        to,
        offsetPx: SEG.offset,
        text: e.closed ? `Σ ${fmt(total)} (闭合)` : `Σ ${fmt(total)}`,
      };
    }

    case 'circle': {
      if (!(e.radius > 1e-9)) return null;
      return {
        // 半径线：圆心 → 右象限点。半径是最直观的「这个圆多大」。
        from: e.center,
        to: { x: e.center.x + e.radius, y: e.center.y },
        offsetPx: 0,
        text: `R ${fmt(e.radius)}  ⌀ ${fmt(e.radius * 2)}`,
      };
    }

    case 'arc': {
      if (!(e.radius > 1e-9)) return null;
      const sweep = arcSweep(e.startAngle, e.endAngle);
      return {
        from: e.center,
        to: {
          x: e.center.x + e.radius * Math.cos(e.startAngle),
          y: e.center.y + e.radius * Math.sin(e.startAngle),
        },
        offsetPx: 0,
        text: `R ${fmt(e.radius)}  ${fmtAngle(sweep)}  弧长 ${fmt(e.radius * sweep)}`,
      };
    }

    case 'ellipse': {
      if (!(e.rx > 1e-9) || !(e.ry > 1e-9)) return null;
      const c = Math.cos(e.rotation);
      const s = Math.sin(e.rotation);
      return {
        from: e.center,
        to: { x: e.center.x + e.rx * c, y: e.center.y + e.rx * s },
        offsetPx: 0,
        text: `半轴 ${fmt(e.rx)} × ${fmt(e.ry)}`,
      };
    }
  }
}

/** 圆心角，归一化到 (0, 2π]。三点圆弧允许 start > end（跨 0°）。 */
function arcSweep(start: number, end: number): number {
  const TAU = Math.PI * 2;
  const s = (((end - start) % TAU) + TAU) % TAU;
  return s === 0 ? TAU : s;
}
