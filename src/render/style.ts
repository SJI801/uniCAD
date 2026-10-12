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
} as const;

/**
 * Resolve an entity's final render style, applying the interaction-state
 * overrides on top of the layer-resolved appearance.
 */
export function resolveRenderStyle(
  doc: CadDocument,
  e: Entity,
  state: { selected?: boolean; hovered?: boolean; preview?: boolean } = {},
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
  if (state.hovered && !state.selected) {
    out = { ...out, color: UI_COLORS.hover, width: UI_COLORS.hoverWidth, dash: null };
  }
  if (state.selected) {
    out = { ...out, color: UI_COLORS.selected, width: UI_COLORS.selectedWidth, dash: null };
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
