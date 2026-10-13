/**
 * Tool system.
 *
 * A tool is a small state machine that consumes pointer/keyboard events and
 * emits *preview* geometry (drawn as an overlay) plus, on completion, a
 * `Command` to be committed to history.
 *
 * Tools never touch the document directly. That separation is what makes
 * preview rendering trivial (it is just local state) and makes every edit
 * automatically undoable.
 */

import type { CadDocument, Entity, EntityId, ExtrudeFeature, LayerId, LoftFeature, PlaneId, RevolveFeature, Vec2 } from '../core/types';
import type { Command } from '../core/history';
import { command, addEntity, addFeature } from '../core/history';
import { featureInsertIndex, findEntity, nextFeatureName, sketchOfEntity } from '../core/doc';
import {
  makeArc,
  makeCircle,
  makeEllipse,
  makeLine,
  makePolyline,
  makeRect,
  newFeatureId,
} from '../core/entities';
import { vDist, vSub, vAngle, vNorm } from '../core/types';
import { cuttingEdgeIds, trimCommand, trimEntity, trimPreview } from '../core/trim';
import { distanceToEntity, offsetEntity } from '../core/kernel';

// ---------------------------------------------------------------------------
// Tool context
// ---------------------------------------------------------------------------

/** Everything a tool needs from the application, injected by the editor. */
export interface ToolContext {
  /** The live document (mutated only through committed commands). */
  doc: CadDocument;
  /** Layer new geometry should land on. */
  currentLayer(): LayerId;
  /**
   * The datum plane new sketches are drawn on.
   *
   * Injected for the same reason as `currentLayer`: the plane lives in the
   * document, and a tool that reached for it directly would bind itself to the
   * store. Every factory call is stamped with it, so an entity always knows
   * which plane its 2D coordinates are measured on.
   */
  activePlane(): PlaneId;
  /** Commit a command to history. */
  commit(cmd: Command): void;
  /** Push a transient status prompt to the command line. */
  setPrompt(text: string): void;
  /** Whether the user has asked for a "close" (right-click / Enter / C). */
  requestClose(): boolean;
  /**
   * The pickable entity under `point`, or `null`.
   *
   * Injected rather than imported because picking needs the live document *and*
   * the kernel, and a tool reaching into `packScene`/`pickAll` itself would
   * repack the whole scene once per tool. The editor does it once.
   */
  pick(point: Vec2): EntityId | null;
  /** The view's model→pixel scale, for converting pixel apertures. */
  viewScale(): number;
}

export type ToolEvent =
  | { kind: 'move'; point: Vec2; raw: Vec2; ortho: boolean }
  | { kind: 'click'; point: Vec2; button: 'left' | 'right'; shift: boolean; ctrl: boolean }
  | { kind: 'dblclick'; point: Vec2 }
  | { kind: 'enter' }
  | { kind: 'escape' }
  | { kind: 'text'; value: string }
  | { kind: 'undo-point' };

/** A tool's response to an event. */
export interface ToolResult {
  /** Preview geometry to draw; empty when nothing is in progress. */
  preview: PreviewGeometry;
  /** Whether the tool finished (so the editor can clear it). */
  done: boolean;
  /** Prompt text to display, if changed. */
  prompt?: string;
}

export interface PreviewGeometry {
  /**
   * `color` is honoured when set. Most tools leave it off and everything draws
   * in the neutral preview colour — but a *destructive* preview (the piece trim
   * is about to remove) has to read as different from geometry about to be
   * added, or the two are indistinguishable at a glance.
   */
  segments: Array<{ a: Vec2; b: Vec2; color?: string }>;
  points: Array<{ p: Vec2; kind: 'vertex' | 'center' | 'handle' }>;
  /** Optional live radius/angle readout for the status bar. */
  readout?: string;
}

export const EMPTY_PREVIEW: PreviewGeometry = { segments: [], points: [] };

// ---------------------------------------------------------------------------
// Tool interface
// ---------------------------------------------------------------------------

export interface Tool {
  /** Stable identifier, also used for keyboard shortcuts. */
  readonly id: string;
  /** Localised display name. */
  readonly name: string;
  /** Single-character command alias, e.g. `L` for LINE. */
  readonly alias: string;
  /** Prompt shown when the tool becomes active. */
  readonly initialPrompt: string;
  /** Whether the tool keeps running after producing geometry. */
  readonly continuous: boolean;

  activate(ctx: ToolContext): void;
  handle(ev: ToolEvent, ctx: ToolContext): ToolResult;
  preview(): PreviewGeometry;
  /** Abort and reset, discarding in-progress points. */
  cancel(ctx: ToolContext): void;
  /** Points already committed, used by the editor for snap "from" context. */
  anchor(): Vec2 | null;
}

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

export abstract class BaseTool implements Tool {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly alias: string;
  abstract readonly initialPrompt: string;
  readonly continuous: boolean = false;

  protected points: Vec2[] = [];
  protected cursor: Vec2 | null = null;

  activate(): void {
    this.points = [];
    this.cursor = null;
  }

  anchor(): Vec2 | null {
    return this.points.length > 0 ? this.points[this.points.length - 1]! : null;
  }

  preview(): PreviewGeometry {
    return EMPTY_PREVIEW;
  }

  cancel(): void {
    this.points = [];
    this.cursor = null;
  }

  /** Track the cursor for every tool so previews stay live. */
  protected trackCursor(ev: ToolEvent): void {
    if (ev.kind === 'move') this.cursor = ev.point;
  }

  abstract handle(ev: ToolEvent, ctx: ToolContext): ToolResult;

  /** Helper: build the default "click to place" behaviour. */
  protected placePoint(
    point: Vec2,
    _ctx: ToolContext,
    nextPrompt: string,
    finished = false,
  ): ToolResult {
    this.points.push({ ...point });
    return { preview: this.preview(), done: finished, prompt: nextPrompt };
  }

  protected entityInit(ctx: ToolContext): Parameters<typeof makeLine>[0] {
    // Which *sketch* a new entity lands in is not stamped here — the patch
    // carries the active sketch's id (see `addEntity`). Stamping it on the
    // entity as well would be the same fact written twice, which is how
    // "sketch says XY, entity says YZ" bugs start.
    return { layer: ctx.currentLayer() };
  }

  protected reset(): void {
    this.points = [];
    this.cursor = null;
  }
}

// ---------------------------------------------------------------------------
// Selection tool (the "no tool" default)
// ---------------------------------------------------------------------------

export class SelectTool extends BaseTool {
  readonly id = 'select';
  readonly name = '选择';
  readonly alias = 'ESC';
  readonly initialPrompt = '选择对象 或 输入命令';

  handle(): ToolResult {
    return { preview: EMPTY_PREVIEW, done: false };
  }
}

// ---------------------------------------------------------------------------
// LINE
// ---------------------------------------------------------------------------

export class LineTool extends BaseTool {
  readonly id = 'line';
  readonly name = '直线';
  readonly alias = 'L';
  readonly initialPrompt = 'LINE 指定第一点:';
  override readonly continuous = true;

  /**
   * 连续绘制：**每落下一点就立即提交一条线段**。
   *
   * 这里曾经把整条折线先缓存起来、只在回车时一次性提交，但那条提交路径
   * （`commitRun`）没有任何调用者 —— 于是这个工具看着能点、提示也在走，
   * 图元却一个都不会产生。逐段提交同时带来一个好处：用户点下第二点就能
   * 看到线，而不必先知道要按回车。
   */
  private static readonly NEXT = 'LINE 指定下一点 [闭合(C)/放弃(U)]:';

  override activate(): void {
    this.reset();
  }

  override preview(): PreviewGeometry {
    const out: PreviewGeometry = { segments: [], points: [] };
    if (this.points.length === 0) return out;
    const from = this.points[this.points.length - 1]!;
    out.points.push({ p: from, kind: 'vertex' });
    if (this.cursor) {
      out.segments.push({ a: from, b: this.cursor });
      out.readout = `${vDist(from, this.cursor).toFixed(3)}`;
    }
    return out;
  }

  handle(ev: ToolEvent, ctx: ToolContext): ToolResult {
    if (ev.kind === 'escape') {
      this.reset();
      return { preview: EMPTY_PREVIEW, done: true, prompt: this.initialPrompt };
    }
    if (ev.kind === 'text' && (ev.value.toLowerCase() === 'c' || ev.value === '闭合')) {
      const closed = this.closeRun(ctx);
      return {
        preview: EMPTY_PREVIEW,
        done: true,
        prompt: closed ? '已闭合折线' : this.initialPrompt,
      };
    }
    if (ev.kind === 'enter' || (ev.kind === 'click' && ev.button === 'right')) {
      this.reset();
      return { preview: EMPTY_PREVIEW, done: true, prompt: this.initialPrompt };
    }
    if (ev.kind === 'move') {
      this.cursor = ev.point;
      return { preview: this.preview(), done: false };
    }
    if (ev.kind !== 'click' || ev.button !== 'left') {
      return { preview: this.preview(), done: false };
    }

    // 第一个点只定起点，不产生线段。
    if (this.points.length === 0) {
      this.points.push({ ...ev.point });
      return { preview: this.preview(), done: false, prompt: LineTool.NEXT };
    }

    const from = this.points[this.points.length - 1]!;
    if (vDist(from, ev.point) < 1e-9) {
      // 原地重复点击：忽略，而不是落一条零长线段。
      return { preview: this.preview(), done: false };
    }

      ctx.commit(
        command('绘制直线', addEntity(ctx.doc.activeSketch, makeLine(this.entityInit(ctx), from, ev.point))),
      );
    this.points.push({ ...ev.point });
    return { preview: this.preview(), done: false, prompt: LineTool.NEXT };
  }

  /** 收口：从当前端点补一条回到起点的线段。 */
  private closeRun(ctx: ToolContext): boolean {
    if (this.points.length < 2) {
      this.reset();
      return false;
    }
    const first = this.points[0]!;
    const last = this.points[this.points.length - 1]!;
    this.reset();
    if (vDist(first, last) < 1e-9) return false;
    ctx.commit(command('绘制直线', addEntity(ctx.doc.activeSketch, makeLine(this.entityInit(ctx), last, first))));
    return true;
  }
}

// ---------------------------------------------------------------------------
// POLYLINE
// ---------------------------------------------------------------------------

export class PolylineTool extends BaseTool {
  readonly id = 'polyline';
  readonly name = '多段线';
  readonly alias = 'PL';
  readonly initialPrompt = 'PLINE 指定起点:';
  override readonly continuous = false;

  override preview(): PreviewGeometry {
    const out: PreviewGeometry = { segments: [], points: [] };
    if (this.points.length === 0) return out;
    for (let i = 0; i + 1 < this.points.length; i++) {
      out.segments.push({ a: this.points[i]!, b: this.points[i + 1]! });
    }
    for (const p of this.points) out.points.push({ p, kind: 'vertex' });
    if (this.cursor) {
      out.segments.push({ a: this.points[this.points.length - 1]!, b: this.cursor });
      const total = polylineLength([...this.points, this.cursor]);
      out.readout = `长度 ${total.toFixed(3)}`;
    }
    return out;
  }

  handle(ev: ToolEvent, ctx: ToolContext): ToolResult {
    if (ev.kind === 'escape') {
      this.finish(ctx, false);
      return { preview: EMPTY_PREVIEW, done: true };
    }
    if (ev.kind === 'text' && (ev.value.toLowerCase() === 'c' || ev.value === '闭合')) {
      const done = this.finish(ctx, true);
      return { preview: EMPTY_PREVIEW, done, prompt: '已闭合多段线' };
    }
    if (ev.kind === 'enter' || (ev.kind === 'click' && ev.button === 'right')) {
      const done = this.finish(ctx, false);
      return { preview: EMPTY_PREVIEW, done, prompt: '已结束多段线' };
    }
    if (ev.kind === 'move') {
      this.cursor = ev.point;
      return { preview: this.preview(), done: false };
    }
    if (ev.kind === 'click' && ev.button === 'left') {
      // Clicking the first vertex again closes the polyline.
      if (this.points.length >= 3 && vDist(this.points[0]!, ev.point) < 1e-9) {
        this.finish(ctx, true);
        return { preview: EMPTY_PREVIEW, done: true, prompt: '已闭合多段线' };
      }
      this.points.push({ ...ev.point });
      return {
        preview: this.preview(),
        done: false,
        prompt: 'PLINE 指定下一点 [闭合(C)/放弃(U)]:',
      };
    }
    return { preview: this.preview(), done: false };
  }

  private finish(ctx: ToolContext, close: boolean): boolean {
    if (this.points.length >= 2) {
      const e = makePolyline(this.entityInit(ctx), this.points, close);
      ctx.commit(command('绘制多段线', addEntity(ctx.doc.activeSketch, e)));
      this.reset();
      return true;
    }
    this.reset();
    return false;
  }
}

function polylineLength(pts: readonly Vec2[]): number {
  let sum = 0;
  for (let i = 0; i + 1 < pts.length; i++) sum += vDist(pts[i]!, pts[i + 1]!);
  return sum;
}

// ---------------------------------------------------------------------------
// RECTANGLE
// ---------------------------------------------------------------------------

export class RectTool extends BaseTool {
  readonly id = 'rect';
  readonly name = '矩形';
  readonly alias = 'REC';
  readonly initialPrompt = 'RECTANG 指定第一个角点:';

  override preview(): PreviewGeometry {
    const out: PreviewGeometry = { segments: [], points: [] };
    if (this.points.length === 0 || !this.cursor) {
      if (this.points.length > 0) out.points.push({ p: this.points[0]!, kind: 'vertex' });
      return out;
    }
    const a = this.points[0]!;
    const b = this.cursor;
    const corners: Vec2[] = [
      { x: a.x, y: a.y },
      { x: b.x, y: a.y },
      { x: b.x, y: b.y },
      { x: a.x, y: b.y },
    ];
    for (let i = 0; i < 4; i++) out.segments.push({ a: corners[i]!, b: corners[(i + 1) % 4]! });
    out.points.push({ p: a, kind: 'vertex' });
    out.readout = `${Math.abs(b.x - a.x).toFixed(3)} × ${Math.abs(b.y - a.y).toFixed(3)}`;
    return out;
  }

  handle(ev: ToolEvent, ctx: ToolContext): ToolResult {
    if (ev.kind === 'escape') {
      this.reset();
      return { preview: EMPTY_PREVIEW, done: true };
    }
    if (ev.kind === 'move') {
      this.cursor = ev.point;
      return { preview: this.preview(), done: false };
    }
    if (ev.kind === 'click' && ev.button === 'left') {
      if (this.points.length === 0) {
        this.points.push({ ...ev.point });
        return { preview: this.preview(), done: false, prompt: 'RECTANG 指定另一个角点:' };
      }
      const a = this.points[0]!;
      if (Math.abs(a.x - ev.point.x) < 1e-9 || Math.abs(a.y - ev.point.y) < 1e-9) {
        return { preview: this.preview(), done: false, prompt: '矩形尺寸为零，请重新指定角点:' };
      }
      const e = makeRect(this.entityInit(ctx), a, ev.point);
      ctx.commit(command('绘制矩形', addEntity(ctx.doc.activeSketch, e)));
      this.reset();
      return { preview: EMPTY_PREVIEW, done: true, prompt: 'RECTANG 指定第一个角点:' };
    }
    return { preview: this.preview(), done: false };
  }
}

// ---------------------------------------------------------------------------
// CIRCLE
// ---------------------------------------------------------------------------

export class CircleTool extends BaseTool {
  readonly id = 'circle';
  readonly name = '圆';
  readonly alias = 'C';
  readonly initialPrompt = 'CIRCLE 指定圆心:';

  override preview(): PreviewGeometry {
    const out: PreviewGeometry = { segments: [], points: [] };
    if (this.points.length === 0) return out;
    const center = this.points[0]!;
    out.points.push({ p: center, kind: 'center' });
    if (!this.cursor) return out;
    const r = vDist(center, this.cursor);
    if (r < 1e-9) return out;
    out.segments.push(...circleSegments(center, r, 96));
    out.readout = `R = ${r.toFixed(3)}`;
    return out;
  }

  handle(ev: ToolEvent, ctx: ToolContext): ToolResult {
    if (ev.kind === 'escape') {
      this.reset();
      return { preview: EMPTY_PREVIEW, done: true };
    }
    if (ev.kind === 'move') {
      this.cursor = ev.point;
      return { preview: this.preview(), done: false };
    }
    if (ev.kind === 'click' && ev.button === 'left') {
      if (this.points.length === 0) {
        this.points.push({ ...ev.point });
        return { preview: this.preview(), done: false, prompt: 'CIRCLE 指定半径:' };
      }
      const center = this.points[0]!;
      const r = vDist(center, ev.point);
      if (r < 1e-9) {
        return { preview: this.preview(), done: false, prompt: '半径为零，请重新指定:' };
      }
      const e = makeCircle(this.entityInit(ctx), center, r);
      ctx.commit(command('绘制圆', addEntity(ctx.doc.activeSketch, e)));
      this.reset();
      return { preview: EMPTY_PREVIEW, done: true, prompt: 'CIRCLE 指定圆心:' };
    }
    if (ev.kind === 'text') {
      const nums = parseNumbers(ev.value);
      if (this.points.length === 1 && nums.length >= 1) {
        const e = makeCircle(this.entityInit(ctx), this.points[0]!, nums[0]!);
        ctx.commit(command('绘制圆', addEntity(ctx.doc.activeSketch, e)));
        this.reset();
        return { preview: EMPTY_PREVIEW, done: true, prompt: 'CIRCLE 指定圆心:' };
      }
    }
    return { preview: this.preview(), done: false };
  }
}

// ---------------------------------------------------------------------------
// ARC (three-point)
// ---------------------------------------------------------------------------

export interface ArcSolver {
  (
    p1: Vec2,
    p2: Vec2,
    p3: Vec2,
  ): { center: Vec2; radius: number; startAngle: number; endAngle: number } | null;
}

export class ArcTool extends BaseTool {
  readonly id = 'arc';
  readonly name = '圆弧';
  readonly alias = 'A';
  readonly initialPrompt = 'ARC 指定起点:';

  /** Injected by the editor: the kernel's 3-point solver. */
  constructor(private solve: ArcSolver) {
    super();
  }

  override preview(): PreviewGeometry {
    const out: PreviewGeometry = { segments: [], points: [] };
    for (const p of this.points) out.points.push({ p, kind: 'vertex' });
    if (this.points.length === 0 || !this.cursor) return out;

    if (this.points.length === 1) {
      // Only two points so far → show a straight chord as a hint.
      out.segments.push({ a: this.points[0]!, b: this.cursor });
      out.readout = `弦长 ${vDist(this.points[0]!, this.cursor).toFixed(3)}`;
      return out;
    }

    const arc = this.solve(this.points[0]!, this.points[1]!, this.cursor);
    if (!arc) {
      out.segments.push({ a: this.points[0]!, b: this.points[1]! });
      out.segments.push({ a: this.points[1]!, b: this.cursor });
      return out;
    }
    out.segments.push(...arcSegments(arc, 96));
    out.points.push({ p: arc.center, kind: 'center' });
    out.readout = `R = ${arc.radius.toFixed(3)}`;
    return out;
  }

  handle(ev: ToolEvent, ctx: ToolContext): ToolResult {
    if (ev.kind === 'escape') {
      this.reset();
      return { preview: EMPTY_PREVIEW, done: true };
    }
    if (ev.kind === 'move') {
      this.cursor = ev.point;
      return { preview: this.preview(), done: false };
    }
    if (ev.kind !== 'click' || ev.button !== 'left') {
      return { preview: this.preview(), done: false };
    }

    this.points.push({ ...ev.point });
    if (this.points.length === 1) {
      return { preview: this.preview(), done: false, prompt: 'ARC 指定第二点(弧上一点):' };
    }
    if (this.points.length === 2) {
      return { preview: this.preview(), done: false, prompt: 'ARC 指定端点:' };
    }

    const arc = this.solve(this.points[0]!, this.points[1]!, this.points[2]!);
    if (!arc) {
      this.points = [];
      return { preview: EMPTY_PREVIEW, done: false, prompt: '三点共线，无法生成圆弧，请重新指定起点:' };
    }
    const e = makeArc(
      this.entityInit(ctx),
      arc.center,
      arc.radius,
      arc.startAngle,
      arc.endAngle,
    );
    ctx.commit(command('绘制圆弧', addEntity(ctx.doc.activeSketch, e)));
    this.reset();
    return { preview: EMPTY_PREVIEW, done: true, prompt: 'ARC 指定起点:' };
  }
}

// ---------------------------------------------------------------------------
// ELLIPSE (centre + two axis radii)
// ---------------------------------------------------------------------------

export class EllipseTool extends BaseTool {
  readonly id = 'ellipse';
  readonly name = '椭圆';
  readonly alias = 'EL';
  readonly initialPrompt = 'ELLIPSE 指定中心点:';

  private rx = 0;
  private ry = 0;
  private stage = 0;

  override activate(): void {
    super.activate();
    this.rx = 0;
    this.ry = 0;
    this.stage = 0;
  }

  override preview(): PreviewGeometry {
    const out: PreviewGeometry = { segments: [], points: [] };
    if (this.points.length === 0) return out;
    const c = this.points[0]!;
    out.points.push({ p: c, kind: 'center' });
    if (!this.cursor) return out;

    let rx = this.rx;
    let ry = this.ry;
    if (this.stage === 0) {
      rx = Math.abs(this.cursor.x - c.x);
      ry = Math.abs(this.cursor.y - c.y);
      out.readout = `长半轴 ${rx.toFixed(3)}  短半轴 ${ry.toFixed(3)}`;
    } else {
      // Second stage: lock the major axis, drag the minor axis with the cursor.
      const d = vDist(c, this.cursor);
      ry = Math.abs(d - rx) > 1e-9 ? d : ry;
      out.readout = `${rx.toFixed(3)} × ${ry.toFixed(3)}`;
    }
    if (rx < 1e-9 || ry < 1e-9) return out;
    out.segments.push(...ellipseSegments(c, rx, ry, 0, 128));
    return out;
  }

  handle(ev: ToolEvent, ctx: ToolContext): ToolResult {
    if (ev.kind === 'escape') {
      this.reset();
      this.stage = 0;
      return { preview: EMPTY_PREVIEW, done: true };
    }
    if (ev.kind === 'move') {
      this.cursor = ev.point;
      return { preview: this.preview(), done: false };
    }
    if (ev.kind !== 'click' || ev.button !== 'left') {
      return { preview: this.preview(), done: false };
    }

    if (this.points.length === 0) {
      this.points.push({ ...ev.point });
      this.stage = 0;
      return { preview: this.preview(), done: false, prompt: 'ELLIPSE 指定轴端点:' };
    }

    const c = this.points[0]!;
    if (this.stage === 0) {
      this.rx = Math.abs(ev.point.x - c.x);
      this.ry = Math.abs(ev.point.y - c.y);
      if (this.rx < 1e-9 || this.ry < 1e-9) {
        return { preview: this.preview(), done: false, prompt: '轴长为零，请重新指定:' };
      }
      // Done in one drag — matches the "corner drag" idiom users expect.
      const e = makeEllipse(this.entityInit(ctx), c, this.rx, this.ry, 0);
      ctx.commit(command('绘制椭圆', addEntity(ctx.doc.activeSketch, e)));
      this.reset();
      this.stage = 0;
      return { preview: EMPTY_PREVIEW, done: true, prompt: 'ELLIPSE 指定中心点:' };
    }
    return { preview: this.preview(), done: false };
  }
}

// ---------------------------------------------------------------------------
// POINT / MEASURE (distance readout only)
// ---------------------------------------------------------------------------

export class MeasureTool extends BaseTool {
  readonly id = 'measure';
  readonly name = '测量';
  readonly alias = 'DI';
  readonly initialPrompt = 'DIST 指定第一点:';

  override preview(): PreviewGeometry {
    const out: PreviewGeometry = { segments: [], points: [] };
    if (this.points.length === 0) return out;
    const a = this.points[0]!;
    out.points.push({ p: a, kind: 'vertex' });
    if (this.cursor) {
      out.segments.push({ a, b: this.cursor });
      const d = vDist(a, this.cursor);
      const ang = vAngle(vSub(this.cursor, a));
      const deg = ((ang * 180) / Math.PI + 360) % 360;
      out.readout = `距离 ${d.toFixed(3)}  角度 ${deg.toFixed(2)}°`;
    }
    return out;
  }

  handle(ev: ToolEvent): ToolResult {
    if (ev.kind === 'escape') {
      this.reset();
      return { preview: EMPTY_PREVIEW, done: true };
    }
    if (ev.kind === 'move') {
      this.cursor = ev.point;
      return { preview: this.preview(), done: false };
    }
    if (ev.kind === 'click' && ev.button === 'left') {
      if (this.points.length === 0) {
        this.points.push({ ...ev.point });
        return { preview: this.preview(), done: false, prompt: 'DIST 指定第二点:' };
      }
      this.points.push({ ...ev.point });
      const a = this.points[0]!;
      const b = this.points[1]!;
      const readout = `距离 ${vDist(a, b).toFixed(3)}`;
      this.reset();
      return { preview: EMPTY_PREVIEW, done: true, prompt: readout };
    }
    return { preview: this.preview(), done: false };
  }
}

// ---------------------------------------------------------------------------
// TRIM
// ---------------------------------------------------------------------------

/**
 * The colour of the piece trim is about to remove.
 *
 * Spelled out here rather than imported from `render/style`: `describeEntity`
 * was moved *out* of that module precisely because tools reaching into the
 * renderer is a dependency pointing the wrong way. It also matches
 * `UI_COLORS.gripHot`, which is the other "this will go away / grab me here"
 * affordance.
 */
const TRIM_CUT_COLOR = '#ff5d5d';

/**
 * Model-space equality at a tolerance well below anything the eye or a pick can
 * resolve — 1e-9 model units is far under a millionth of a pixel at any sane
 * zoom, so "the cursor did not move" is not an approximation here.
 */
function samePoint(a: Vec2, b: Vec2): boolean {
  return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
}

/**
 * Trim: click the piece of a curve you want gone.
 *
 * Unlike every other tool here, this one **picks its own target** instead of
 * using coordinates the pointer gave it. The click point is only a *hint* —
 * what the user means is "the bit of that line under the crosshair", and the
 * crosshair is snapped, so the raw point can be a hair off the curve.
 *
 * It also stays alive after each cut. Trimming is iterative by nature: you click
 * three times to shape one edge, and being kicked back to the select tool after
 * the first click would make that three tool activations. Escape / right-click
 * ends it.
 *
 * The preview is the piece that would be removed, drawn in the cut colour —
 * without it the user is asking to delete something with no idea what it is.
 */
export class TrimTool extends BaseTool {
  readonly id = 'trim';
  readonly name = '修剪';
  readonly alias = 'TR';
  readonly initialPrompt = 'TRIM 点击要剪掉的那一段:';

  /**
   * Not `continuous`, despite staying alive across clicks. The flag only decides
   * what happens when the tool reports `done`, and the clicks here report
   * `done: false` themselves — so leaving it false means Escape still hands back
   * to the select tool, which is how you get out.
   */

  /** The piece the cursor is currently over, tessellated by the kernel. */
  private hoverPieces: Array<{ x: number; y: number }> = [];
  /**
   * The entity `hoverPieces` belongs to — i.e. the one the red preview is
   * actually describing.
   *
   * This is remembered rather than re-picked on click because at a crossing both
   * entities sit inside the pick aperture and `pick` answers "nearest to the
   * cursor", which can differ between the hover and the click by a fraction of a
   * pixel. Re-picking made the tool trim something other than what it had just
   * drawn in red — the preview and the action disagreed, which is the worst
   * possible failure for a destructive tool.
   */
  private hoverTarget: EntityId | null = null;
  /** Whether the last click did something, so the prompt can report it. */
  private lastNote: string | null = null;
  /** Last point the hover was recomputed for — see `refreshHover`. */
  private hoverAt: Vec2 | null = null;

  override activate(): void {
    super.activate();
    this.hoverPieces = [];
    this.hoverTarget = null;
    this.lastNote = null;
    this.hoverAt = null;
  }

  override cancel(): void {
    this.reset();
    this.hoverPieces = [];
    this.hoverTarget = null;
    this.lastNote = null;
    this.hoverAt = null;
  }

  override anchor(): Vec2 | null {
    // No "from" point: a trim's click is a pick, not a placement.
    return null;
  }

  override preview(): PreviewGeometry {
    const out: PreviewGeometry = { segments: [], points: [] };
    for (let i = 0; i + 1 < this.hoverPieces.length; i++) {
      const a = this.hoverPieces[i]!;
      const b = this.hoverPieces[i + 1]!;
      out.segments.push({
        a: { x: a.x, y: a.y },
        b: { x: b.x, y: b.y },
        color: TRIM_CUT_COLOR,
      });
    }
    return out;
  }

  override handle(ev: ToolEvent, ctx: ToolContext): ToolResult {
    if (ev.kind === 'escape' || (ev.kind === 'click' && ev.button === 'right')) {
      this.reset();
      this.hoverPieces = [];
      this.hoverTarget = null;
      this.lastNote = null;
      this.hoverAt = null;
      return { preview: EMPTY_PREVIEW, done: true };
    }

    if (ev.kind === 'move') {
      this.cursor = ev.point;
      this.refreshHover(ev.point, ctx);
      return { preview: this.preview(), done: false, prompt: this.prompt() };
    }

    if (ev.kind === 'click' && ev.button === 'left') {
      this.lastNote = this.cut(ev.point, ctx);
      // Force: the document just changed, so the piece under the cursor is a
      // different piece now (or gone) even though the cursor has not moved.
      this.refreshHover(ev.point, ctx, true);
      return { preview: this.preview(), done: false, prompt: this.prompt() };
    }

    return { preview: this.preview(), done: false };
  }

  private prompt(): string {
    if (this.lastNote) return `TRIM ${this.lastNote}`;
    return 'TRIM 点击要剪掉的那一段:';
  }

  /**
   * Recompute the preview, but only when it could have changed.
   *
   * The move event arrives on a 16 ms tick for as long as the tool is active,
   * and each recompute is a scene pack plus a kernel round trip — at 60 Hz that
   * is a pack of the whole drawing per frame, for a preview that usually looks
   * identical to the last one. Re-picking when the cursor has not moved is free
   * to skip and removes almost all of that cost.
   */
  private refreshHover(point: Vec2, ctx: ToolContext, force = false): void {
    if (!force && this.hoverAt && samePoint(this.hoverAt, point)) return;
    this.hoverAt = { ...point };

    const id = ctx.pick(point);
    if (!id) {
      this.hoverPieces = [];
      this.hoverTarget = null;
      return;
    }
    this.hoverTarget = id;
    this.hoverPieces = trimPreview(
      ctx.doc,
      id,
      cuttingEdgeIds(ctx.doc, id),
      point,
      ctx.doc.settings.pickAperturePx * ctx.viewScale(),
    );
  }

  private cut(point: Vec2, ctx: ToolContext): string | null {
    // Trim exactly what the preview showed — the same entity *and* the same
    // location. `hoverAt` is where the red piece was computed; the click point
    // can land a few pixels away (the move tick is throttled, so the last hover
    // predates the click), and on either side of an intersection that picks a
    // different interval in the kernel. The preview is the contract: cut where
    // it was drawn. Falling back to a fresh pick covers the case where the
    // stored target is gone (an undo, or a document reload between hover and
    // click) — but the fallback must not be the *normal* path, or the preview
    // and the edit drift apart exactly where it matters most.
    let id = this.hoverTarget;
    let at = this.hoverAt;
    if (!id || findEntity(ctx.doc, id) === undefined) {
      id = ctx.pick(point);
      at = null;
    }
    if (!id) return '没点到任何对象';
    const res = trimEntity(
      ctx.doc,
      id,
      cuttingEdgeIds(ctx.doc, id),
      at ?? point,
      ctx.doc.settings.pickAperturePx * ctx.viewScale(),
    );
    if (!res.ok) {
      if (res.reason === 'unsupported') {
        return '椭圆暂不支持修剪（需要「椭圆弧」这种图元，本项目还没有）';
      }
      if (res.reason === 'noCuts') return '没有别的图元与它相交，无从剪起';
      if (res.reason === 'noKernel') return '内核未就绪，修剪不可用';
      return '请点在图元上';
    }
    ctx.commit(trimCommand(ctx.doc, id, res.pieces));
    if (res.pieces.length === 0) return '已整条删除';
    return `已剪掉一段，剩 ${res.pieces.length} 段`;
  }
}

// ---------------------------------------------------------------------------
// OFFSET — a parallel curve at a fixed (or cursor-set) distance
// ---------------------------------------------------------------------------

/**
 * Offset: pick a curve, then pick the side; get a parallel copy.
 *
 * The distance is either typed on the command line (the precise route, and it
 * then sticks for every following offset in the same run) or, if none has been
 * set, read from how far the cursor is from the curve (the quick "just drag it
 * out" route). The *side* is decided by which of the two offsets, `+d` and `−d`,
 * the cursor sits nearer — so the tool never hard-codes the kernel's sign
 * convention. That convention is genuinely per-primitive: a line's `+` side is
 * its left, a circle's is *outward*, an arc's is outward too. Comparing the two
 * candidates sidesteps keeping that table in two places.
 *
 * Ellipses offset to a polyline (the kernel tessellates them): an ellipse offset
 * is not an ellipse, so there is no honest ellipse to return.
 */
export class OffsetTool extends BaseTool {
  readonly id = 'offset';
  readonly name = '偏置';
  readonly alias = 'O';
  readonly initialPrompt = 'OFFSET 选择要偏置的对象:';
  override readonly continuous = true;

  private targetId: EntityId | null = null;
  /** A typed distance; `null` means "take it from the cursor". Survives runs. */
  private distance: number | null = null;
  private previewEntity: Entity | null = null;
  private lastAt: Vec2 | null = null;
  /** The distance the current ghost was built at, for the live readout. */
  private used = 0;

  override activate(): void {
    super.activate();
    this.targetId = null;
    this.previewEntity = null;
    this.lastAt = null;
  }

  override cancel(): void {
    this.reset();
    this.targetId = null;
    this.previewEntity = null;
    this.lastAt = null;
  }

  override anchor(): Vec2 | null {
    // No "from" point: the pick is a selection, not a placement.
    return null;
  }

  override preview(): PreviewGeometry {
    const out: PreviewGeometry = { segments: [], points: [] };
    const e = this.previewEntity;
    if (!e) return out;
    switch (e.type) {
      case 'line':
        out.segments.push({ a: e.a, b: e.b });
        break;
      case 'circle':
        out.segments.push(...circleSegments(e.center, e.radius, 96));
        break;
      case 'arc':
        out.segments.push(...arcSegments(e, 96));
        break;
      case 'ellipse':
        out.segments.push(...ellipseSegments(e.center, e.rx, e.ry, e.rotation, 128));
        break;
      case 'polyline':
        for (let i = 0; i + 1 < e.points.length; i++) {
          out.segments.push({ a: e.points[i]!, b: e.points[i + 1]! });
        }
        if (e.closed && e.points.length > 2) {
          out.segments.push({ a: e.points[e.points.length - 1]!, b: e.points[0]! });
        }
        break;
    }
    out.readout = `偏置 ${this.used.toFixed(3)}`;
    return out;
  }

  private promptText(): string {
    if (!this.targetId) return this.initialPrompt;
    return this.distance === null
      ? 'OFFSET 移到要偏置的一侧（也可输入确切距离）后点击:'
      : `OFFSET 移到要偏置的一侧（距离 ${this.distance}）后点击:`;
  }

  handle(ev: ToolEvent, ctx: ToolContext): ToolResult {
    if (ev.kind === 'escape' || (ev.kind === 'click' && ev.button === 'right')) {
      this.reset();
      this.targetId = null;
      this.previewEntity = null;
      this.lastAt = null;
      return { preview: EMPTY_PREVIEW, done: true, prompt: this.initialPrompt };
    }

    if (ev.kind === 'text') {
      // A bare number is a precise distance; anything else is ignored here (a
      // coordinate was already turned into a click by the event pump).
      const nums = parseNumbers(ev.value);
      if (nums.length >= 1 && Number.isFinite(nums[0])) {
        this.distance = Math.abs(nums[0]!);
        this.refresh(ctx);
      }
      return { preview: this.preview(), done: false, prompt: this.promptText() };
    }

    if (ev.kind === 'move') {
      this.cursor = ev.point;
      // Throttle: the tick fires every 16 ms, and a refresh is several kernel
      // round trips. Re-computing for an unmoved cursor is pure waste.
      if (!this.lastAt || !samePoint(this.lastAt, ev.point)) {
        this.lastAt = { ...ev.point };
        this.refresh(ctx);
      }
      return { preview: this.preview(), done: false, prompt: this.promptText() };
    }

    if (ev.kind === 'enter') {
      this.reset();
      this.targetId = null;
      this.previewEntity = null;
      this.lastAt = null;
      return { preview: EMPTY_PREVIEW, done: true, prompt: this.initialPrompt };
    }

    if (ev.kind !== 'click' || ev.button !== 'left') {
      return { preview: this.preview(), done: false, prompt: this.promptText() };
    }

    if (!this.targetId) {
      const id = ctx.pick(ev.point);
      if (!id) {
        return { preview: this.preview(), done: false, prompt: '没点到对象，请点在一个图元上:' };
      }
      this.targetId = id;
      this.cursor = ev.point;
      this.lastAt = { ...ev.point };
      this.refresh(ctx);
      return { preview: this.preview(), done: false, prompt: this.promptText() };
    }

    const off = this.previewEntity;
    if (!off) {
      return { preview: this.preview(), done: false, prompt: this.promptText() };
    }
    // The offset belongs to the target's sketch, like a trim's pieces — the
    // patch records it rather than assuming the active sketch at undo time.
    const sketchId = sketchOfEntity(ctx.doc, this.targetId!)?.id ?? ctx.doc.activeSketch;
    ctx.commit(command('偏置', addEntity(sketchId, off)));
    // Stay armed at the same distance so a run of curves offsets together.
    this.targetId = null;
    this.previewEntity = null;
    return { preview: EMPTY_PREVIEW, done: false, prompt: this.promptText() };
  }

  /** Recompute the ghost offset for the current target + cursor. */
  private refresh(ctx: ToolContext): void {
    this.previewEntity = null;
    const id = this.targetId;
    const cursor = this.cursor;
    if (!id || !cursor) return;
    const target = findEntity(ctx.doc, id);
    if (!target) {
      this.targetId = null;
      return;
    }
    const d = this.distance ?? distanceToEntity(target, cursor);
    if (!Number.isFinite(d) || d < 1e-9) return;
    this.used = d;
    const pos = offsetEntity(target, d);
    const neg = offsetEntity(target, -d);
    const dp = pos ? distanceToEntity(pos, cursor) : Number.POSITIVE_INFINITY;
    const dn = neg ? distanceToEntity(neg, cursor) : Number.POSITIVE_INFINITY;
    this.previewEntity = dp <= dn ? pos : neg;
  }
}

// ---------------------------------------------------------------------------
// EXTRUDE — pull a closed sketch into a solid
// ---------------------------------------------------------------------------

/**
 * Extrude: pick a closed profile, type a height, get a solid.
 *
 * The height comes from the command line rather than a drag. A drag can only be
 * as precise as the pixel it lands on, and the whole point of sketching first is
 * that the sketch states exactly what the part is; a 3D drag-preview is a Phase 2
 * nicety.
 *
 * The tool commits an `ExtrudeFeature` *record* (which sketch, which profile,
 * what height) — never a triangle. The mesh is re-derived by the kernel on the
 * render path, so editing the sketch, or the height, changes the solid with
 * nothing baked. The feature is inserted into the tree right after the sketch
 * it belongs to; order there is evaluation order.
 */
export class ExtrudeTool extends BaseTool {
  readonly id = 'extrude';
  readonly name = '拉伸';
  readonly alias = 'X';
  readonly initialPrompt = 'EXTRUDE 选择要拉伸的封闭轮廓（矩形/圆/闭合多段线）:';

  private targetId: EntityId | null = null;

  override activate(): void {
    super.activate();
    this.targetId = null;
  }

  override cancel(): void {
    super.cancel();
    this.targetId = null;
  }

  override anchor(): Vec2 | null {
    // No "from" point: the pick names an object, it is not a placement.
    return null;
  }

  override preview(): PreviewGeometry {
    // Nothing to overlay: the solid does not exist until a height is known, and
    // once it does it is drawn by the 3D pass, not as 2D preview geometry.
    return EMPTY_PREVIEW;
  }

  handle(ev: ToolEvent, ctx: ToolContext): ToolResult {
    if (
      ev.kind === 'escape' ||
      ev.kind === 'enter' ||
      (ev.kind === 'click' && ev.button === 'right')
    ) {
      this.reset();
      this.targetId = null;
      return { preview: EMPTY_PREVIEW, done: true, prompt: this.initialPrompt };
    }

    if (ev.kind === 'text') {
      if (!this.targetId) {
        return { preview: EMPTY_PREVIEW, done: false, prompt: this.initialPrompt };
      }
      const nums = parseNumbers(ev.value);
      const height = nums.length >= 1 ? nums[0]! : NaN;
      if (!Number.isFinite(height) || Math.abs(height) <= 1e-9) {
        return { preview: EMPTY_PREVIEW, done: false, prompt: '请输入一个非零的拉伸高度:' };
      }
      // The feature points at the sketch that owns the profile — not at "the
      // active sketch", which a plane switch between pick and commit could
      // make a different one.
      const sketchId = sketchOfEntity(ctx.doc, this.targetId)?.id ?? ctx.doc.activeSketch;
      const feature: ExtrudeFeature = {
        kind: 'extrude',
        id: newFeatureId(),
        name: nextFeatureName(ctx.doc, 'extrude'),
        sketch: sketchId,
        profile: this.targetId,
        height,
        layer: ctx.currentLayer(),
      };
      ctx.commit(command('拉伸', addFeature(feature, featureInsertIndex(ctx.doc, sketchId))));
      this.targetId = null;
      return { preview: EMPTY_PREVIEW, done: true, prompt: this.initialPrompt };
    }

    if (ev.kind === 'click' && ev.button === 'left') {
      const id = ctx.pick(ev.point);
      if (!id) {
        return { preview: EMPTY_PREVIEW, done: false, prompt: '没点到对象，请点在一个封闭轮廓上:' };
      }
      this.targetId = id;
      return { preview: EMPTY_PREVIEW, done: false, prompt: 'EXTRUDE 输入拉伸高度后回车:' };
    }

    return { preview: EMPTY_PREVIEW, done: false, prompt: this.promptNow() };
  }

  private promptNow(): string {
    return this.targetId ? 'EXTRUDE 输入拉伸高度后回车:' : this.initialPrompt;
  }
}

// ---------------------------------------------------------------------------
// REVOLVE — lathe a closed profile about a line in the same sketch
// ---------------------------------------------------------------------------

/**
 * Revolve: pick a closed profile, pick the centreline to spin it about, type an
 * angle in degrees.
 *
 * **Two picks, because the axis is geometry rather than a setting.** In a CAD
 * sketch the centreline *is* a curve, and the feature references that line by
 * id — so moving the line re-lathes the solid, and deleting it turns the feature
 * into an error node instead of silently spinning about wherever the axis used
 * to be.
 *
 * The angle is typed in degrees (what a user reads off a protractor) and stored
 * in radians (what the kernel sweeps). A negative angle sweeps the other way;
 * `core/evaluate.ts` and the kernel share that convention — see `mesh::revolve`.
 */
export class RevolveTool extends BaseTool {
  readonly id = 'revolve';
  readonly name = '旋转';
  readonly alias = 'REV';
  readonly initialPrompt = 'REVOLVE 选择要旋转的封闭轮廓（矩形/圆/闭合多段线）:';

  private targetId: EntityId | null = null;
  private axisId: EntityId | null = null;

  override activate(): void {
    super.activate();
    this.targetId = null;
    this.axisId = null;
  }

  override cancel(): void {
    super.cancel();
    this.targetId = null;
    this.axisId = null;
  }

  override anchor(): Vec2 | null {
    // No "from" point: both picks name objects; neither is a placement.
    return null;
  }

  override preview(): PreviewGeometry {
    // Like extrude: nothing exists until the angle is known, and once it does it
    // is drawn by the 3D pass rather than as 2D preview geometry.
    return EMPTY_PREVIEW;
  }

  handle(ev: ToolEvent, ctx: ToolContext): ToolResult {
    if (
      ev.kind === 'escape' ||
      ev.kind === 'enter' ||
      (ev.kind === 'click' && ev.button === 'right')
    ) {
      this.reset();
      this.targetId = null;
      this.axisId = null;
      return { preview: EMPTY_PREVIEW, done: true, prompt: this.initialPrompt };
    }

    if (ev.kind === 'text') {
      if (!this.targetId || !this.axisId) {
        return { preview: EMPTY_PREVIEW, done: false, prompt: this.promptNow() };
      }
      const nums = parseNumbers(ev.value);
      const deg = nums.length >= 1 ? nums[0]! : NaN;
      if (!Number.isFinite(deg) || Math.abs(deg) <= 1e-9) {
        return { preview: EMPTY_PREVIEW, done: false, prompt: '请输入一个非零的角度（度）:' };
      }
      // Beyond a full turn the kernel would sweep over itself; refuse instead of
      // producing a self-intersecting solid.
      if (Math.abs(deg) > 360 + 1e-9) {
        return { preview: EMPTY_PREVIEW, done: false, prompt: '角度请填 -360 到 360 之间:' };
      }
      // The feature belongs to the sketch that owns the profile — recorded on
      // the node, never "whatever is active at commit time".
      const sketchId = sketchOfEntity(ctx.doc, this.targetId)?.id ?? ctx.doc.activeSketch;
      const feature: RevolveFeature = {
        kind: 'revolve',
        id: newFeatureId(),
        name: nextFeatureName(ctx.doc, 'revolve'),
        sketch: sketchId,
        profile: this.targetId,
        axis: this.axisId,
        angle: (deg * Math.PI) / 180,
        layer: ctx.currentLayer(),
      };
      ctx.commit(command('旋转', addFeature(feature, featureInsertIndex(ctx.doc, sketchId))));
      this.targetId = null;
      this.axisId = null;
      return { preview: EMPTY_PREVIEW, done: true, prompt: this.initialPrompt };
    }

    if (ev.kind === 'click' && ev.button === 'left') {
      const id = ctx.pick(ev.point);
      if (!id) {
        return {
          preview: EMPTY_PREVIEW,
          done: false,
          prompt: this.targetId ? '没点到对象，请点在一根直线上作为旋转轴:' : '没点到对象，请点在一个封闭轮廓上:',
        };
      }
      if (!this.targetId) {
        this.targetId = id;
        return { preview: EMPTY_PREVIEW, done: false, prompt: 'REVOLVE 选择旋转轴（点一根直线）:' };
      }
      // The axis has to be a line with length — the same rule the evaluator
      // enforces, applied here while the user is still inside the command so the
      // mistake is a sentence rather than a red node later.
      const axis = findEntity(ctx.doc, id);
      if (
        !axis ||
        axis.type !== 'line' ||
        Math.hypot(axis.b.x - axis.a.x, axis.b.y - axis.a.y) <= 1e-12
      ) {
        return { preview: EMPTY_PREVIEW, done: false, prompt: '旋转轴必须是一根有长度的直线，请重新点:' };
      }
      if (id === this.targetId) {
        return { preview: EMPTY_PREVIEW, done: false, prompt: '旋转轴不能就是轮廓本身，请点一根直线:' };
      }
      this.axisId = id;
      return { preview: EMPTY_PREVIEW, done: false, prompt: 'REVOLVE 输入旋转角度（度）后回车:' };
    }

    return { preview: EMPTY_PREVIEW, done: false, prompt: this.promptNow() };
  }

  private promptNow(): string {
    if (!this.targetId) return this.initialPrompt;
    if (!this.axisId) return 'REVOLVE 选择旋转轴（点一根直线）:';
    return 'REVOLVE 输入旋转角度（度）后回车:';
  }
}

// ---------------------------------------------------------------------------
// HOLE — drill a face, from the 3D view (work package 3.2)
// ---------------------------------------------------------------------------

/**
 * Hole: activate it, then click a solid's face in the 3D view.
 *
 * The tool itself does nothing on a 2D click, and that is deliberate: a hole
 * needs a *face*, and faces only exist in the 3D view. The click is handled
 * where the 3D view dispatches its own clicks (`CanvasView`'s orbit-drag end),
 * next to the datum-plane pick it resembles — rather than by teaching this
 * state machine about rays, which would put a second, worse camera in the tool
 * layer.
 *
 * So this class exists to own the command: the ribbon button, the `H` alias,
 * the prompt, and Escape.
 */
export class HoleTool extends BaseTool {
  readonly id = 'hole';
  readonly name = '打孔';
  readonly alias = 'H';
  readonly initialPrompt = 'HOLE 在 3D 视图里点一个实体的表面（参数建好后在特征树上改）:';

  override anchor(): Vec2 | null {
    return null;
  }

  override preview(): PreviewGeometry {
    return EMPTY_PREVIEW;
  }

  handle(ev: ToolEvent, _ctx: ToolContext): ToolResult {
    if (ev.kind === 'escape' || ev.kind === 'enter' || (ev.kind === 'click' && ev.button === 'right')) {
      this.reset();
      return { preview: EMPTY_PREVIEW, done: true, prompt: this.initialPrompt };
    }
    // A 2D click is not a mistake to report — the user may simply be looking at
    // the 2D view. The prompt already says where the click has to land.
    return { preview: EMPTY_PREVIEW, done: false, prompt: this.initialPrompt };
  }
}

// ---------------------------------------------------------------------------
// LOFT — skin two sections into a solid (work package 3.4)
// ---------------------------------------------------------------------------

/**
 * Loft: pick one closed section, switch to the other's sketch, pick the second.
 *
 * **Two picks in two sketches, and that is the feature.** A loft is what turns
 * "a small circle here, a big circle up there" into a tapered pipe, so the two
 * sections live on different planes by construction — which is also why this is
 * the first tool that expects the user to *switch sketches in the middle*: the
 * first pick is kept while the second is made somewhere else. Editing either
 * sketch afterwards re-skins the whole solid.
 *
 * Two sections is the common case; the document model already takes a list, so
 * a chain of sections is a UI question rather than a kernel one.
 */
export class LoftTool extends BaseTool {
  readonly id = 'loft';
  readonly name = '放样';
  readonly alias = 'LOFT';
  readonly initialPrompt = 'LOFT 点第一个封闭截面（第二个截面的草图要在另一个基准面上）:';

  private firstId: EntityId | null = null;

  override activate(): void {
    super.activate();
    this.firstId = null;
  }

  override cancel(): void {
    super.cancel();
    this.firstId = null;
  }

  override anchor(): Vec2 | null {
    // Picks name objects; neither is a placement.
    return null;
  }

  override preview(): PreviewGeometry {
    return EMPTY_PREVIEW;
  }

  handle(ev: ToolEvent, ctx: ToolContext): ToolResult {
    if (
      ev.kind === 'escape' ||
      ev.kind === 'enter' ||
      (ev.kind === 'click' && ev.button === 'right')
    ) {
      this.reset();
      this.firstId = null;
      return { preview: EMPTY_PREVIEW, done: true, prompt: this.initialPrompt };
    }

    if (ev.kind === 'click' && ev.button === 'left') {
      const id = ctx.pick(ev.point);
      if (!id) {
        return { preview: EMPTY_PREVIEW, done: false, prompt: '没点到对象，请点在一个封闭轮廓上:' };
      }
      if (!this.firstId) {
        this.firstId = id;
        return {
          preview: EMPTY_PREVIEW,
          done: false,
          prompt: 'LOFT 已选第一个截面 —— 切到另一个基准面的草图，点第二个截面:',
        };
      }
      if (id === this.firstId) {
        return { preview: EMPTY_PREVIEW, done: false, prompt: '第二个截面不能就是第一个，请点另一个轮廓:' };
      }
      const a = sketchOfEntity(ctx.doc, this.firstId);
      const b = sketchOfEntity(ctx.doc, id);
      if (!a || !b) {
        return { preview: EMPTY_PREVIEW, done: false, prompt: '轮廓必须属于某张草图，请重新点:' };
      }
      // Two sections on one plane cannot bound a solid — the loft would have to
      // go sideways inside its own sections. Caught here, while the user is
      // still in the command, rather than as a red node afterwards.
      if (a.plane === b.plane) {
        return {
          preview: EMPTY_PREVIEW,
          done: false,
          prompt: '两个截面在同一平面上 —— 先切到别的基准面（或新建一个偏移基准面）再画第二个截面:',
        };
      }
      const sections = [this.firstId, id];
      const feature: LoftFeature = {
        kind: 'loft',
        id: newFeatureId(),
        name: nextFeatureName(ctx.doc, 'loft'),
        sections,
        layer: ctx.currentLayer(),
      };
      // Inserted right after the last section's sketch: both sections are
      // sketches, and the tree reads "these two, then what was skinned between
      // them".
      ctx.commit(command('放样', addFeature(feature, featureInsertIndex(ctx.doc, b.id))));
      this.firstId = null;
      return { preview: EMPTY_PREVIEW, done: true, prompt: this.initialPrompt };
    }

    return {
      preview: EMPTY_PREVIEW,
      done: false,
      prompt: this.firstId
        ? 'LOFT 已选第一个截面 —— 切到另一个基准面的草图，点第二个截面:'
        : this.initialPrompt,
    };
  }
}

// ---------------------------------------------------------------------------
// Shared geometry generators (previews)
// ---------------------------------------------------------------------------

export function circleSegments(center: Vec2, radius: number, steps = 96): Array<{ a: Vec2; b: Vec2 }> {
  const out: Array<{ a: Vec2; b: Vec2 }> = [];
  for (let i = 0; i < steps; i++) {
    const t0 = (i / steps) * Math.PI * 2;
    const t1 = ((i + 1) / steps) * Math.PI * 2;
    out.push({
      a: { x: center.x + radius * Math.cos(t0), y: center.y + radius * Math.sin(t0) },
      b: { x: center.x + radius * Math.cos(t1), y: center.y + radius * Math.sin(t1) },
    });
  }
  return out;
}

export function arcSegments(
  arc: { center: Vec2; radius: number; startAngle: number; endAngle: number },
  steps = 96,
): Array<{ a: Vec2; b: Vec2 }> {
  const out: Array<{ a: Vec2; b: Vec2 }> = [];
  let sweep = (arc.endAngle - arc.startAngle) % (Math.PI * 2);
  if (sweep < 0) sweep += Math.PI * 2;
  if (sweep < 1e-9) sweep = Math.PI * 2;
  const n = Math.max(2, Math.round((steps * sweep) / (Math.PI * 2)));
  for (let i = 0; i < n; i++) {
    const t0 = arc.startAngle + (sweep * i) / n;
    const t1 = arc.startAngle + (sweep * (i + 1)) / n;
    out.push({
      a: { x: arc.center.x + arc.radius * Math.cos(t0), y: arc.center.y + arc.radius * Math.sin(t0) },
      b: { x: arc.center.x + arc.radius * Math.cos(t1), y: arc.center.y + arc.radius * Math.sin(t1) },
    });
  }
  return out;
}

export function ellipseSegments(
  center: Vec2,
  rx: number,
  ry: number,
  rotation: number,
  steps = 128,
): Array<{ a: Vec2; b: Vec2 }> {
  const out: Array<{ a: Vec2; b: Vec2 }> = [];
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const at = (t: number): Vec2 => {
    const x = rx * Math.cos(t);
    const y = ry * Math.sin(t);
    return { x: center.x + x * cos - y * sin, y: center.y + x * sin + y * cos };
  };
  for (let i = 0; i < steps; i++) {
    const t0 = (i / steps) * Math.PI * 2;
    const t1 = ((i + 1) / steps) * Math.PI * 2;
    out.push({ a: at(t0), b: at(t1) });
  }
  return out;
}

/** Parse whitespace/comma-separated numbers from a command-line entry. */
export function parseNumbers(text: string): number[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
}

/**
 * Parse a single point entry, accepting `x,y` or `x y` (and `@dx,dy` for
 * relative-to-last-point, the AutoCAD convention).
 */
export function parsePoint(text: string, last: Vec2 | null): Vec2 | null {
  const trimmed = text.trim();
  const relative = trimmed.startsWith('@');
  const body = relative ? trimmed.slice(1) : trimmed;
  const parts = body.split(/[\s,]+/).filter((s) => s.length > 0);
  if (parts.length < 2) return null;
  let x: number;
  let y: number;
  if (parts.length >= 4) {
    // "10,20,30,40" style is not meaningful in 2D — take the first pair.
    x = Number(parts[0]);
    y = Number(parts[1]);
  } else {
    x = Number(parts[0]);
    y = Number(parts[1]);
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (relative) {
    if (!last) return null;
    return { x: last.x + x, y: last.y + y };
  }
  return { x, y };
}

/**
 * Parse a polar entry: `距离<角度` (e.g. `100<45`). A leading `@` is accepted
 * too — `@100<45` is what the command line documents, and the distance is
 * always measured from the last point regardless, so the marker is optional.
 */
export function parsePolar(text: string, last: Vec2 | null): Vec2 | null {
  const body = text.trim().replace(/^@/, '');
  const m = body.match(/^([0-9.+\-eE]+)\s*<\s*([0-9.+\-eE]+)$/);
  if (!m || !last) return null;
  const dist = Number(m[1]);
  const deg = Number(m[2]);
  if (!Number.isFinite(dist) || !Number.isFinite(deg)) return null;
  const rad = (deg * Math.PI) / 180;
  return { x: last.x + dist * Math.cos(rad), y: last.y + dist * Math.sin(rad) };
}

/** Distance from a point to a segment — used by the polyline vertex grab. */
export function pointSegDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = vSub(b, a);
  const len2 = ab.x * ab.x + ab.y * ab.y;
  if (len2 < 1e-18) return vDist(p, a);
  let t = ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / len2;
  t = Math.max(0, Math.min(1, t));
  return vDist(p, { x: a.x + ab.x * t, y: a.y + ab.y * t });
}

/** Normalised direction, exposed for the polyline tool's arc segments later. */
export { vNorm };
