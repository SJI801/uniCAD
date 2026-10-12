/**
 * Grid rendering.
 *
 * The adaptive grid recomputes its spacing every frame from the camera zoom so
 * the on-screen pitch stays in a comfortable band. Only the lines actually
 * visible in the current viewport are emitted — at 1:1 zoom on a large drawing
 * that is the difference between 200 and 200 000 line segments.
 */

import type { Vec2 } from '../core/types';
import { adaptiveGridSpacing, type Camera } from './camera';

export interface GridOptions {
  visible: boolean;
  /** Base spacing in model units, from the document settings. */
  spacing: number;
  /** Minor subdivisions drawn between major lines. */
  subdivisions: number;
  majorColor: string;
  minorColor: string;
  axisXColor: string;
  axisYColor: string;
}

export interface GridLine {
  a: Vec2;
  b: Vec2;
  color: string;
  /** Screen-space width in CSS pixels. */
  width: number;
}

/**
 * Compute the grid lines for the current view.
 *
 * Returns an array of screen-space-ready model segments. The caller uploads
 * them through the same line pipeline as entity geometry.
 */
export function buildGrid(cam: Camera, opts: GridOptions): GridLine[] {
  if (!opts.visible) return [];
  const out: GridLine[] = [];
  const view = cam.visibleBounds();
  const major = adaptiveGridSpacing(opts.spacing, cam.scale);
  const minor = major / Math.max(1, opts.subdivisions);

  // Minor lines are suppressed when they would be denser than ~5 px, which
  // keeps the grid from turning into a grey wash when zoomed out.
  const minorPx = minor / cam.scale;
  const drawMinor = minorPx >= 5;

  const step = drawMinor ? minor : major;

  // Guard against pathological counts (e.g. a degenerate zoom).
  const maxLines = 4000;
  const cols = Math.floor((view.maxX - view.minX) / step);
  const rows = Math.floor((view.maxY - view.minY) / step);
  if (cols > maxLines || rows > maxLines) return [];

  const startX = Math.ceil(view.minX / step) * step;
  const startY = Math.ceil(view.minY / step) * step;

  const isMajor = (v: number): boolean => {
    const ratio = v / major;
    return Math.abs(ratio - Math.round(ratio)) < 1e-6;
  };

  for (let x = startX; x <= view.maxX + 1e-9; x += step) {
    const maj = isMajor(x);
    const isAxis = Math.abs(x) < 1e-9;
    out.push({
      a: { x, y: view.minY },
      b: { x, y: view.maxY },
      color: isAxis ? opts.axisYColor : maj ? opts.majorColor : opts.minorColor,
      width: isAxis ? 1.6 : maj ? 1.0 : 0.75,
    });
  }

  for (let y = startY; y <= view.maxY + 1e-9; y += step) {
    const maj = isMajor(y);
    const isAxis = Math.abs(y) < 1e-9;
    out.push({
      a: { x: view.minX, y },
      b: { x: view.maxX, y },
      color: isAxis ? opts.axisXColor : maj ? opts.majorColor : opts.minorColor,
      width: isAxis ? 1.6 : maj ? 1.0 : 0.75,
    });
  }

  return out;
}

/** Flatten grid lines into the interleaved vertex stream the renderer wants. */
export function gridToVertices(lines: readonly GridLine[]): Float32Array {
  const out = new Float32Array(lines.length * 4);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    out[i * 4] = l.a.x;
    out[i * 4 + 1] = l.a.y;
    out[i * 4 + 2] = l.b.x;
    out[i * 4 + 3] = l.b.y;
  }
  return out;
}

/** The on-screen pitch of the current grid, for the status bar. */
export function gridPitchLabel(cam: Camera, opts: GridOptions): string {
  const major = adaptiveGridSpacing(opts.spacing, cam.scale);
  return `${major.toPrecision(3)}`;
}
