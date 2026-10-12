/**
 * Interaction overlays: crosshair, rubber band, selection window, snap markers
 * and grips.
 *
 * Overlays are pure geometry generators — they return model-space segments and
 * points which the view composites through the same GPU pipelines as entities.
 * Keeping them separate from the entity batch means highlighting never forces a
 * re-tessellation.
 *
 * Dimension annotation (leader lines + the numbers beside them) lives in
 * `dims.ts`, because it is the one overlay that also emits *text* — and text
 * goes to the DOM rather than the GPU.
 */

import type { Vec2 } from '../core/types';
import { UI_COLORS } from './style';

export interface OverlaySegment {
  a: Vec2;
  b: Vec2;
  color: string;
  width: number;
  dash: number[] | null;
}

export interface OverlayPoint {
  x: number;
  y: number;
  color: string;
  /**
   * Marker diameter in **CSS pixels**.
   *
   * Screen-space, not model units: markers exist to be legible to the user, so
   * they must not shrink when the drawing is zoomed out. (They used to be
   * handed to the renderer in model units, which silently divided them by the
   * view scale — a 7 px grip came out as 1.6 px at 1:4.3, and would have grown
   * without bound when zoomed out.)
   */
  size: number;
  /**
   * Intended glyph. Only informational today — `GlRenderer.drawPoints` rasterises
   * a disc for every marker, so squares/crosses/triangles are not distinguished
   * yet.
   */
  shape: 'square' | 'circle' | 'cross' | 'triangle' | 'x';
}

/** Full-screen crosshair that spans the viewport at the cursor position. */
export function crosshair(
  cursorScreen: Vec2,
  viewWidth: number,
  viewHeight: number,
  screenToWorld: (p: Vec2) => Vec2,
  full = true,
): OverlaySegment[] {
  const { x, y } = cursorScreen;
  // Short crosshair (~12 px arms) when object snap is active, full otherwise.
  const armLen = full ? Math.max(viewWidth, viewHeight) : 14;
  const pick = (sx: number, sy: number): Vec2 => screenToWorld({ x: sx, y: sy });
  return [
    { a: pick(x - armLen, y), b: pick(x + armLen, y), color: UI_COLORS.crosshair, width: 1, dash: null },
    { a: pick(x, y - armLen), b: pick(x, y + armLen), color: UI_COLORS.crosshair, width: 1, dash: null },
  ];
}

/** The "rubber band" from the last committed point to the live cursor. */
export function rubberBand(
  from: Vec2,
  to: Vec2,
  color = UI_COLORS.rubberBand,
  dash: number[] | null = [6, 4],
): OverlaySegment[] {
  return [{ a: from, b: to, color, width: 1.2, dash }];
}

/** The rubber-band selection rectangle. */
export function selectionWindow(a: Vec2, b: Vec2, crossing: boolean): OverlaySegment[] {
  const color = crossing ? UI_COLORS.selectionCrossing : UI_COLORS.selectionWindow;
  const dash = crossing ? [6, 4] : null;
  const corners: Vec2[] = [
    { x: a.x, y: a.y },
    { x: b.x, y: a.y },
    { x: b.x, y: b.y },
    { x: a.x, y: b.y },
  ];
  const out: OverlaySegment[] = [];
  for (let i = 0; i < 4; i++) {
    out.push({ a: corners[i]!, b: corners[(i + 1) % 4]!, color, width: 1.2, dash });
  }
  return out;
}

/**
 * Snap marker geometry for a given snap kind.
 *
 * `sizePx` is a diameter in **CSS pixels** — see `OverlayPoint.size`.
 */
export function snapMarker(point: Vec2, kind: string, sizePx: number): OverlayPoint[] {
  switch (kind) {
    case 'endpoint':
      return [{ x: point.x, y: point.y, color: UI_COLORS.snapMarker, size: sizePx, shape: 'square' }];
    case 'midpoint':
      return [{ x: point.x, y: point.y, color: UI_COLORS.snapMarker, size: sizePx, shape: 'triangle' }];
    case 'center':
      return [{ x: point.x, y: point.y, color: UI_COLORS.snapMarker, size: sizePx, shape: 'circle' }];
    case 'quadrant':
      return [
        { x: point.x, y: point.y, color: UI_COLORS.snapMarker, size: sizePx, shape: 'square' },
      ];
    case 'intersection':
      return [{ x: point.x, y: point.y, color: UI_COLORS.snapMarker, size: sizePx, shape: 'x' }];
    case 'perpendicular':
      return [{ x: point.x, y: point.y, color: UI_COLORS.snapMarkerAlt, size: sizePx, shape: 'cross' }];
    case 'tangent':
      return [{ x: point.x, y: point.y, color: UI_COLORS.snapMarkerAlt, size: sizePx, shape: 'circle' }];
    case 'nearest':
      return [{ x: point.x, y: point.y, color: UI_COLORS.snapMarkerAlt, size: sizePx, shape: 'cross' }];
    default:
      return [{ x: point.x, y: point.y, color: UI_COLORS.snapMarker, size: sizePx, shape: 'square' }];
  }
}

/** Grip handles at an entity's defining points, when it is selected. */
export function entityGrips(_type: string, points: readonly Vec2[], sizePx: number): OverlayPoint[] {
  return points.map((p) => ({
    x: p.x,
    y: p.y,
    color: UI_COLORS.grip,
    size: sizePx,
    shape: 'square' as const,
  }));
}

/** Axis indicator (the classic AutoCAD UCS icon in the lower-left corner). */
export function axisIndicator(
  originScreen: Vec2,
  sizePx: number,
  screenToWorld: (p: Vec2) => Vec2,
): OverlaySegment[] {
  const o = screenToWorld(originScreen);
  const xEnd = screenToWorld({ x: originScreen.x + sizePx, y: originScreen.y });
  const yEnd = screenToWorld({ x: originScreen.x, y: originScreen.y - sizePx });
  return [
    { a: o, b: xEnd, color: '#e05252', width: 2, dash: null },
    { a: o, b: yEnd, color: '#52c46a', width: 2, dash: null },
  ];
}

/** Convert overlay segments into the interleaved vertex layout. */
export function segmentsToVertices(segs: readonly OverlaySegment[]): {
  positions: Float32Array;
  colors: Float32Array;
  widths: Float32Array;
  dashes: Array<number[] | null>;
} {
  const positions = new Float32Array(segs.length * 4);
  const colors = new Float32Array(segs.length * 8);
  const widths = new Float32Array(segs.length * 2);
  const dashes: Array<number[] | null> = new Array(segs.length);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    positions[i * 4] = s.a.x;
    positions[i * 4 + 1] = s.a.y;
    positions[i * 4 + 2] = s.b.x;
    positions[i * 4 + 3] = s.b.y;
    widths[i * 2] = s.width;
    widths[i * 2 + 1] = s.width;
    dashes[i] = s.dash;
  }
  return { positions, colors, widths, dashes };
}
