/**
 * Style resolution for the renderer: layer inheritance → concrete draw
 * attributes, plus the linetype dash tables.
 */

import type { CadDocument, Entity, LineStyle } from '../core/types';
import { findLayer } from '../core/entities';
import type { RenderStyle } from './gl';

/** Dash patterns in *screen* pixels, so they stay legible at any zoom. */
export const LINETYPE_DASHES: Record<LineStyle, number[] | null> = {
  continuous: null,
  dashed: [10, 6],
  dotted: [1.5, 4],
  dashdot: [12, 5, 2, 5],
  center: [18, 6, 4, 6],
  hidden: [7, 4],
};

/** Standard high-contrast colours used for interaction feedback. */
export const UI_COLORS = {
  hover: '#4ea3ff',
  hoverWidth: 2.4,
  selected: '#ffb020',
  selectedWidth: 2.6,
  grip: '#4ea3ff',
  gripHot: '#ff5d5d',
  snapMarker: '#43d17c',
  snapMarkerAlt: '#3fd0d8',
  endpointStart: '#4ade80',
  endpointEnd: '#f87171',
  rubberBand: '#ffffff',
  selectionWindow: '#4ea3ff',
  selectionCrossing: '#3fd07a',
  crosshair: '#7d8794',
  preview: '#8f9aa8',
  /** A destructive preview — trim's "this piece is about to be removed". */
  cut: '#ff5d5d',
  /** 冲突草图：约束无法同时成立的图元（ROADMAP 0.3）。比选中色更刺眼。 */
  conflict: '#ff3b30',
  conflictWidth: 3,
  /** 欠约束方向标记（0.3）：青色，与捕捉标记同族但不撞色。 */
  dof: '#3fd0d8',
  /**
   * 欠定义草图（0.3 的「草图颜色提示」）：还缺尺寸或方位约束的图元。
   * 刻意比 hover 的亮蓝暗一档——它是一片区域的底色，不是"我正在指它"。
   */
  underDefined: '#3f7fd4',
} as const;

/**
 * Resolve an entity's final render style, applying the interaction-state
 * overrides on top of the layer-resolved appearance.
 *
 * Priority, and why: `conflicting` > `selected` > `hovered` > `underDefined` >
 * 图层色。
 *
 * * 冲突永远最显眼——被选中也不改色，否则一框选就把问题盖掉了。
 * * 欠定义（`underDefined`）**排在交互态之后**：它是一整片草图的底色，一旦鼠标移到
 *   某个图元上、或选中了它，用户的注意力在那一根上，此时让它说"欠定义"是抢话。
 * * 它也不进 `preview` 那条分支：预览是临时的、未落盘的几何，没有约束状态可言。
 */
export function resolveRenderStyle(
  doc: CadDocument,
  e: Entity,
  state: {
    selected?: boolean;
    hovered?: boolean;
    preview?: boolean;
    conflicting?: boolean;
    underDefined?: boolean;
  } = {},
): RenderStyle {
  const layer = findLayer(doc, e.layer);
  const color = e.color ?? layer?.color ?? '#e8e8e8';
  const lineStyle = e.lineStyle ?? layer?.lineStyle ?? 'continuous';
  const weight = e.lineWeight ?? layer?.lineWeight ?? 0.25;

  let out: RenderStyle = {
    color,
    width: weightToPixels(weight),
    dash: LINETYPE_DASHES[lineStyle] ?? null,
  };

  if (state.preview) {
    out = { ...out, color: UI_COLORS.preview, dash: [8, 5], width: Math.max(out.width, 1.6) };
  }
  // 底色先铺：欠定义是"这片草图还没定完"，交互态（hover/选中）要盖在它上面。
  if (state.underDefined && !state.preview) {
    out = { ...out, color: UI_COLORS.underDefined };
  }
  if (state.hovered && !state.selected) {
    out = { ...out, color: UI_COLORS.hover, width: UI_COLORS.hoverWidth, dash: null };
  }
  if (state.selected) {
    out = { ...out, color: UI_COLORS.selected, width: UI_COLORS.selectedWidth, dash: null };
  }
  if (state.conflicting) {
    out = { ...out, color: UI_COLORS.conflict, width: UI_COLORS.conflictWidth, dash: null };
  }
  return out;
}

/**
 * Lineweight (millimetres) → screen pixels.
 *
 * Real CAD maps lineweight to *printed* width, but on screen we want a
 * legible range; `0` means "hairline" and clamps to 1 px.
 */
export function weightToPixels(mm: number): number {
  if (mm <= 0) return 1;
  // 0.25 mm (the ISO default) should land on ~1.4 px.
  return Math.max(1, Math.min(6, mm * 5.6));
}

/**
 * Expand a dashed pattern for a polyline run, returning alternating on/off
 * lengths. Used by the overlay path renderer, which cannot rely on the GPU
 * batch (it needs per-dash picking).
 */
export function dashPattern(style: LineStyle, scale = 1): number[] {
  const base = LINETYPE_DASHES[style] ?? [1e9];
  return base.map((v) => v * scale);
}
