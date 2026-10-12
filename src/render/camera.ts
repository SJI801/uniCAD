/**
 * Camera: the window ↔ model transform plus viewport bookkeeping.
 *
 * Screen space is CSS pixels with the origin at the top-left, y pointing down.
 * Model space is y-up, like every CAD system. The camera owns the flip, so no
 * other module has to think about it.
 */

import type { Aabb, Mat, Vec2 } from '../core/types';

export interface Viewport {
  width: number;
  height: number;
  /** Device pixel ratio actually in use (already clamped). */
  dpr: number;
}

export class Camera {
  /** Model-space point displayed at the viewport centre. */
  center: Vec2 = { x: 0, y: 0 };
  /** Model units per CSS pixel. Smaller = zoomed in. */
  scale = 1;
  viewport: Viewport = { width: 800, height: 600, dpr: 1 };

  readonly minScale = 1e-4;
  readonly maxScale = 1e5;

  resize(width: number, height: number, dpr = 1): void {
    this.viewport = { width: Math.max(1, width), height: Math.max(1, height), dpr };
  }

  /** Model → screen (CSS pixels). */
  worldToScreen(p: Vec2): Vec2 {
    const { width, height } = this.viewport;
    return {
      x: (p.x - this.center.x) / this.scale + width / 2,
      y: height / 2 - (p.y - this.center.y) / this.scale,
    };
  }

  /** Screen (CSS pixels) → model. */
  screenToWorld(p: Vec2): Vec2 {
    const { width, height } = this.viewport;
    return {
      x: (p.x - width / 2) * this.scale + this.center.x,
      y: (height / 2 - p.y) * this.scale + this.center.y,
    };
  }

  /** Zoom by a factor about a fixed screen anchor (usually the cursor). */
  zoomAt(screenAnchor: Vec2, factor: number): void {
    const before = this.screenToWorld(screenAnchor);
    this.scale = clamp(this.scale / factor, this.minScale, this.maxScale);
    const after = this.screenToWorld(screenAnchor);
    // Shift the centre so the model point under the cursor stays put.
    this.center.x += before.x - after.x;
    this.center.y += before.y - after.y;
  }

  /** Pan by a screen-space delta in CSS pixels. */
  panByScreen(dx: number, dy: number): void {
    this.center.x -= dx * this.scale;
    this.center.y += dy * this.scale;
  }

  /** The model-space rectangle currently visible. */
  visibleBounds(): Aabb {
    const { width, height } = this.viewport;
    const halfW = (width / 2) * this.scale;
    const halfH = (height / 2) * this.scale;
    return {
      minX: this.center.x - halfW,
      minY: this.center.y - halfH,
      maxX: this.center.x + halfW,
      maxY: this.center.y + halfH,
    };
  }

  /** Convert a pixel tolerance into model units at the current zoom. */
  pxToModel(px: number): number {
    return px * this.scale;
  }

  /** Fit a model-space bounding box into the viewport with a margin fraction. */
  fit(bounds: Aabb | null, marginFraction = 0.08): void {
    const { width, height } = this.viewport;
    if (!bounds || bounds.minX === Infinity) {
      this.center = { x: 0, y: 0 };
      this.scale = 1;
      return;
    }
    const w = Math.max(bounds.maxX - bounds.minX, 1e-6);
    const h = Math.max(bounds.maxY - bounds.minY, 1e-6);
    this.center = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
    const sx = w / (width * (1 - marginFraction * 2));
    const sy = h / (height * (1 - marginFraction * 2));
    this.scale = clamp(Math.max(sx, sy), this.minScale, this.maxScale);
  }

  /** The affine transform mapping model → clip space, for the GPU. */
  clipMatrix(): Mat {
    return clipMatrixOf({
      center: this.center,
      scale: this.scale,
      width: this.viewport.width,
      height: this.viewport.height,
    });
  }

  /** Serialise / restore, used for view bookmarks. */
  snapshot(): { center: Vec2; scale: number } {
    return { center: { ...this.center }, scale: this.scale };
  }

  restore(s: { center: Vec2; scale: number }): void {
    this.center = { ...s.center };
    this.scale = clamp(s.scale, this.minScale, this.maxScale);
  }
}

/**
 * Model → clip matrix, the single source of truth for the GPU transform.
 *
 * It is derived from — and must agree sign-for-sign with — `worldToScreen`:
 *
 *   screenX = (x - cx) / s + w/2      CSS px, origin top-left
 *   screenY = h/2 - (y - cy) / s      model y is **up**, so the flip lives here
 *   ndcX    = 2 * screenX / w - 1
 *   ndcY    = 1 - 2 * screenY / h
 *
 * which composes to `ndcY = +2 * (y - cy) / (s * h)`. The **plus** sign is the
 * whole point: reading `screenY` as though model y already pointed downwards
 * flips it to a minus and mirrors the entire scene vertically. Nothing errors
 * when that happens — every entity still rasterises, every buffer still
 * validates — the geometry just lands opposite the cursor. Duplicating this
 * formula is how it drifted once already, so there is exactly one copy now.
 */
export function clipMatrixOf(view: {
  center: Vec2;
  scale: number;
  width: number;
  height: number;
}): Mat {
  const a = 2 / (view.width * view.scale);
  const d = 2 / (view.height * view.scale);
  return [a, 0, 0, d, -a * view.center.x, -d * view.center.y];
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Choose a "nice" grid spacing so grid lines stay legible at any zoom.
 *
 * Returns the model-space spacing plus how many minor divisions to draw
 * between major lines.
 */
export function adaptiveGridSpacing(baseSpacing: number, scale: number, targetPx = 12): number {
  const baseModel = baseSpacing;
  const px = baseModel / scale;
  if (px >= targetPx) return baseModel;
  // Multiply by a 1-2-5-10 series until the spacing is at least targetPx wide.
  const steps = [1, 2, 5, 10];
  let mult = 1;
  let guard = 0;
  while ((baseModel * mult) / scale < targetPx && guard < 64) {
    const decade = Math.floor(Math.log10(mult));
    const mantissa = mult / 10 ** decade;
    const idx = steps.findIndex((s) => s > mantissa + 1e-9);
    if (idx === -1) {
      mult = 10 ** (decade + 1);
    } else {
      mult = steps[idx]! * 10 ** decade;
    }
    guard += 1;
  }
  return baseModel * mult;
}
