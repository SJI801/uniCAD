/**
 * Zustand-backed editor store.
 *
 * The store owns the document, the camera, the active tool, the selection and
 * all transient interaction state. Components subscribe to narrow slices so a
 * cursor move does not re-render the layer panel.
 *
 * Everything that mutates geometry goes through `history.execute`, which keeps
 * undo/redo correct by construction.
 */

import { create } from 'zustand';
import { DEFAULT_ORBIT, type OrbitState } from '../render/orbit';
import type {
  CadDocument,
  ConstraintKind,
  ConstraintMode,
  Entity,
  EntityId,
  Layer,
  LayerId,
  OsnapMode,
  Vec2,
} from '../core/types';
import {
  createEmptyDocument,
  DEFAULT_OSNAP_MODES,
  fmt,
  planeOf,
} from '../core/types';
import {
  CommandHistory,
  addConstraint,
  addEntity,
  addFrame,
  addPlane,
  command,
  removeConstraint,
  updateConstraint,
  removeFrame,
  removeManyCommand,
  removePlane,
  setActivePlanePatch,
  updateEntity,
  updateLayer,
  addLayer,
  removeLayer,
  setCurrentLayer,
  type Command,
  type Patch,
} from '../core/history';
import { XY_PLANE, planeNormal } from '../core/types';
import type { DocFrame, DocPlane, PlaneId } from '../core/types';
import { cloneEntity, geometryEquals, isPickable, newLayerId, constraintPointAt, pinNamedPoint, shapeEquals } from '../core/entities';
import { splitCommand, splitEntities, splitTargets } from '../core/split';
import {
  CONSTRAINT_LABEL,
  analyzeDocument,
  buildConstraints,
  buildEntityDimension,
  constraintsForEntity,
  isSelfDimension,
  solveConstraints,
  DIMENSIONAL_CONSTRAINTS,
  SIGNED_DIMENSIONS,
  ZERO_VALUE_DIMENSIONS,
  type ConstraintReport,
} from '../core/constraints';
import { deserializeDocument, serializeDocument, type LoadResult } from '../io/json';

// ---------------------------------------------------------------------------
// Interaction state
// ---------------------------------------------------------------------------

export type EditorMode = 'idle' | 'drawing' | 'selecting' | 'panning' | 'measure';

export interface CursorState {
  /** Raw model-space position under the pointer. */
  world: Vec2;
  /** Snapped / constrained position actually used by tools. */
  effective: Vec2;
  /** Screen position in CSS pixels. */
  screen: Vec2;
  /** Active snap, when one was found. */
  snap: { point: Vec2; kind: OsnapMode; entityIndex: number } | null;
  /** Live polar / ortho lock indicator. */
  locked: boolean;
}

export interface ViewState {
  /** Model units per CSS pixel. */
  scale: number;
  center: Vec2;
  width: number;
  height: number;
  dpr: number;
}

export interface HistoryInfo {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  depth: number;
}

export interface EditorState {
  doc: CadDocument;
  view: ViewState;
  /**
   * Whether the canvas shows the 3D solids (true) or the 2D sketch (false).
   *
   * A sibling of `view` rather than a field on it: the 2D camera (`view`) is
   * untouched by the mode switch, so flipping back to 2D always returns to
   * exactly the pan/zoom you left, with no round-tripping through 3D units.
   */
  view3d: boolean;
  /** Turntable camera for the 3D view. */
  orbit: OrbitState;
  mode: EditorMode;
  cursor: CursorState;
  selection: Set<EntityId>;
  hover: EntityId | null;
  /** Tool id currently active (`select` when idle). */
  activeTool: string;
  /** Prompt text shown in the command line. */
  prompt: string;
  /** Log lines shown in the command line history. */
  log: string[];
  history: HistoryInfo;
  /** Set whenever the document diverges from the last save. */
  dirty: boolean;
  /** Human-readable kernel status for the status bar. */
  kernelStatus: string;
  /**
   * Whether the Rust/WASM kernel finished loading. Mirrored from the kernel
   * module so React components re-render when it flips — `isKernelReady()` is a
   * plain function call and would not trigger an update on its own.
   */
  kernelReady: boolean;
  /** Whether the grid is switched on. */
  gridVisible: boolean;
  /**
   * Whether automatic dimensions are drawn on the canvas.
   *
   * Two things hang off this flag: the active tool's live readout (length,
   * radius, angle…) beside the cursor, and the dimension line + numbers for
   * every selected entity. Defaults to on — the numbers are the point of
   * drawing in CAD — but a box-select of 500 entities is exactly when you want
   * to switch them off, so it needs to be reachable.
   */
  dimsVisible: boolean;
  /**
   * Whether the on-canvas constraint badges (the little ⊙ ∈ ⊥ glyphs) are drawn.
   *
   * Separate from `dimsVisible` on purpose: the two answer different
   * questions. Dimensions are information about the geometry you just made;
   * constraint badges are metadata about relationships, and a dense drawing
   * wants one without the other.
   */
  constraintsVisible: boolean;
  /** 起点/终点标色小圆点（绿=起，红=终）。 */
  endpointsVisible: boolean;
  /**
   * 约束状态配色（ROADMAP 0.3 的「草图颜色提示」）：还缺**尺寸或方位**约束的图元画成
   * 欠定义蓝。默认关闭——绘图颜色在这套里属于图层/图元属性，未经允许覆盖它是越权。
   */
  sketchColors: boolean;
  /**
   * 「完全定义」模式：开启后，挂着约束的图元拒绝拖动——草图进入只读态，
   * 形状只能通过改尺寸驱动。默认关闭，不改变既有交互。
   */
  fullyConstrained: boolean;
  /**
   * 草图自由度报告（ROADMAP 0.3）：欠约束多少、是否完全定义、有没有冲突。
   * `null` = 还没算（内核未就绪 / 没有约束 / 该 wasm 不支持）——此时界面不显示，
   * 而不是显示 0（0 的含义是「完全定义」，不能拿来表示「不知道」）。
   */
  constraintReport: ConstraintReport | null;
  /**
   * Whether the top ribbon is folded down to a single compact row.
   *
   * In the store rather than in `Ribbon`'s local state for two reasons: the
   * keyboard layer has to flip it too, and it is persisted — a toolbar that
   * springs back open on every reload is worse than having no control at all.
   */
  ribbonCollapsed: boolean;

  // --- actions ------------------------------------------------------------
  replaceDocument(doc: CadDocument, options?: { resetHistory?: boolean }): void;
  loadFromJson(text: string): { warnings: string[] } | { error: string };
  exportJson(): string;

  run(cmd: Command): void;
  undo(): void;
  redo(): void;

  addEntities(entities: Entity[], label?: string): void;
  deleteSelection(): void;
  duplicateSelection(offset: Vec2): void;
  transformSelection(fn: (e: Entity) => Entity, label: string): void;
  updateEntityById(id: EntityId, fn: (e: Entity) => Entity, label: string): void;
  /**
   * 改值即驱动：面板上敲的一个**尺寸**（半径 / 直径 / 长度）写成持久约束。
   *
   * `fn` 把敲进去的数落成几何（就是那一行自己的 `applyTo`），`value` 是它对应
   * 的**约束目标值**——派生的周长 / 面积 / 弧长要换算成半径，所以两者分开传。
   * 几何、约束、以及被约束带着一起动的伙伴，全部合成**一条**命令，撤销一次全回来。
   */
  setDimensionAction(
    entityId: EntityId,
    kind: ConstraintKind,
    value: number,
    fn: (e: Entity) => Entity,
    label: string,
  ): void;

  /** Apply a relationship to the current selection. Validates and logs why not. */
  addConstraintAction(kind: ConstraintKind): void;
  /** 尺寸约束改目标值（几何约束忽略）：解算回写几何，进同一条撤销补丁。 */
  setConstraintValueAction(id: string, value: number): void;
  removeConstraintAction(id: string): void;
  /** Drop every constraint that touches the selection. */
  removeConstraintsForSelection(): void;
  /** Break the selection (or the whole drawing) apart at intersection points. */
  splitAtIntersections(): void;

  select(ids: Iterable<EntityId>, additive?: boolean): void;
  toggleSelect(id: EntityId): void;
  clearSelection(): void;
  selectAll(): void;
  setHover(id: EntityId | null): void;

  setTool(id: string): void;
  setMode(mode: EditorMode): void;
  setPrompt(text: string): void;
  pushLog(text: string): void;
  clearLog(): void;

  setCursorWorld(p: Vec2): void;
  setCursorScreen(p: Vec2): void;
  setCursorEffective(p: Vec2): void;
  setSnap(s: CursorState['snap']): void;
  setLocked(locked: boolean): void;

  setView(v: Partial<ViewState>): void;
  /** Flip between the 2D sketch and the 3D solids. */
  setView3d(on: boolean): void;
  /** Nudge the 3D turntable camera. */
  setOrbit(o: Partial<OrbitState>): void;
  panBy(dx: number, dy: number): void;
  zoomAt(screenAnchor: Vec2, factor: number): void;
  zoomToFit(): void;

  addLayerAction(name?: string): LayerId;
  updateLayerAction(id: LayerId, patch: Partial<Layer>): void;
  removeLayerAction(id: LayerId): void;
  setCurrentLayerAction(id: LayerId): void;

  updateSettings(patch: Partial<CadDocument['settings']>): void;
  toggleOsnap(mode: OsnapMode): void;
  setConstraint(mode: ConstraintMode): void;
  toggleGrid(): void;
  setDimsVisible(visible: boolean): void;
  toggleDims(): void;
  setConstraintsVisible(visible: boolean): void;
  toggleConstraints(): void;
  setEndpointsVisible(visible: boolean): void;
  toggleEndpoints(): void;
  setSketchColors(on: boolean): void;
  toggleSketchColors(): void;
  setFullyConstrained(visible: boolean): void;
  toggleFullyConstrained(): void;
  setRibbonCollapsed(collapsed: boolean): void;
  toggleRibbon(): void;

  /** Show/hide a datum plane, or a coordinate system's triad. */
  setPlaneVisible(id: PlaneId, visible: boolean): void;
  setFrameVisible(id: string, visible: boolean): void;
  /** Make `id` the plane new sketches are drawn on (undoable). */
  setActivePlane(id: PlaneId): void;
  /** Add a coordinate system sitting on the active plane. Returns its id. */
  addFrameOnActivePlane(): string | null;
  /** Delete a user frame. The world frame cannot be removed. */
  deleteFrame(id: string): void;
  /**
   * Create a datum plane by offsetting one of the three base planes along its
   * own normal. Returns the new plane's id.
   */
  addOffsetPlane(baseId: PlaneId, offset: number): string | null;
  /**
   * Delete a user-made plane. Refused while sketches still sit on it — they
   * would have nowhere to be drawn.
   */
  deletePlane(id: PlaneId): void;
  /**
   * Which plane the「新建基准面」flow is basing on.
   *
   * Lives in the store rather than in the panel's local state because the 3D
   * viewport sets it too: clicking a plane there is another way to say "base the
   * new plane on this one", and both surfaces have to agree.
   */
  datumBase: PlaneId;
  setDatumBase(id: PlaneId): void;

  setKernelStatus(text: string): void;
  /**
   * Explicit readiness flag.
   *
   * Deliberately a separate action rather than a side effect of
   * `setKernelStatus`: the status string is display copy that gets reworded,
   * and deriving a behavioural flag from it means a copy edit can silently
   * disable picking, snapping and measurement.
   */
  setKernelReady(ready: boolean): void;
  markSaved(): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function historyInfo(h: CommandHistory): HistoryInfo {
  const st = h.state;
  return {
    canUndo: st.canUndo,
    canRedo: st.canRedo,
    undoLabel: st.undoLabels[st.undoLabels.length - 1] ?? null,
    redoLabel: st.redoLabels[st.redoLabels.length - 1] ?? null,
    depth: st.undoLabels.length,
  };
}

const MAX_LOG = 200;

/**
 * localStorage key for the ribbon's folded/unfolded preference.
 *
 * Only UI chrome lives under this prefix — nothing here is document state, so a
 * wiped browser profile costs the user a re-click, never data.
 */
const RIBBON_COLLAPSED_KEY = 'unicad.ui.ribbonCollapsed';
const CONSTRAINTS_VISIBLE_KEY = 'unicad.ui.constraintsVisible';
const ENDPOINTS_VISIBLE_KEY = 'unicad.ui.endpointsVisible';
const SKETCH_COLORS_KEY = 'unicad.ui.sketchColors';
const FULLY_CONSTRAINED_KEY = 'unicad.ui.fullyConstrained';

/**
 * Viewport width below which a first-time visitor gets the folded ribbon.
 *
 * The expanded bar is ≈1911 px of controls (14 文字按钮 + 8 绘图工具 + 11 开关).
 * Below that it does not fit, and the honest options are "scroll a toolbar" or
 * "fold it" — for a toolbar the answer is fold. Only consulted when nothing has
 * been stored, so an explicit Ctrl+F1 or click always wins and is remembered.
 *
 * 加控件就要跟着调这个数 —— 它必须 ≥ 展开态的实际内容宽，否则会出现
 * 「默认展开、但根本放不下」。加了「约束」分组(2140)、「修剪」工具(2210)与
 * 「交点分解」按钮(2280)后三次上调。
 */
const RIBBON_AUTO_COLLAPSE_BELOW = 2280;

/**
 * Read a stickily-saved UI flag.
 *
 * Guarded because `localStorage` does not merely return null where it is
 * unavailable — it *throws* in Safari's private mode and wherever a policy
 * disables storage. A layout preference is never worth taking the whole
 * workbench down for, so any failure just falls back to the default.
 */
function readUiFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

function writeUiFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* best-effort: the session still works, it just will not be remembered */
  }
}

/** The single source of truth for undo history — deliberately outside the store. */
let history = new CommandHistory();

export function getHistory(): CommandHistory {
  return history;
}

function defaultCursor(): CursorState {
  return {
    world: { x: 0, y: 0 },
    effective: { x: 0, y: 0 },
    screen: { x: 0, y: 0 },
    snap: null,
    locked: false,
  };
}

/**
 * 「完全定义」= 几何锁 —— ROADMAP 0.4。
 *
 * 打开之后**只有尺寸能改几何**。返回 true 表示这次修改必须被丢掉，并且已经写了
 * 一条人话日志解释为什么。
 *
 * 关卡为什么在 store 而不是画布上：0.4 的验收句是「只允许改尺寸」，而能改几何的
 * 入口不止拖动一个 —— 属性面板的数字框、旋转/缩放/对齐、修剪分割，每一个都直接
 * 写几何。只拦拖动的话，用户在属性面板里照样能把刚锁住的线改走，那这句话就是空
 * 的。这些入口共用 store 的少数几个方法，把关卡放在那里才是「只允许」。
 *
 * 两种例外：
 *
 * * **尺寸路径**（`setDimensionAction` / `setConstraintValueAction` / 尺寸约束）
 *   一律放行 —— 它们就是这句话里允许的那一半。
 * * **预览与回滚**（标签以 `__` 开头）一律放行：那是拖动的中间态，拦下来会让
 *   画布永远停在预览位置。
 */
const LIVE_LABEL_PREFIX = '__';

export function refusesGeometryEdit(state: EditorState, what: string, label?: string): boolean {
  if (label !== undefined && label.startsWith(LIVE_LABEL_PREFIX)) return false;
  if (!state.fullyConstrained) return false;
  state.pushLog(`完全定义：${what}会改几何，已锁定 —— 请用尺寸驱动`);
  return true;
}

/**
 * 工具提交的命令会不会**改写已有几何**？—— 0.4 的锁要能管住绘图工具。
 *
 * 两种形状算改写：
 *
 * * `update` 且 `shapeEquals` 说形状真的变了（圆角、拉伸这类改图元）；
 * * **同时**删掉旧图元又新建图元 —— 修剪就是「删掉原曲线 + 加回两段」，补丁形状
 *   上看是删除 + 新建，但它显然改了已有几何。只看 `update` 会漏掉它。
 *
 * 只新建（直线/圆/矩形/偏置）或只删除（Delete 键）都不动已有几何，放行：
 * 锁的是**形状**，不是整张图 —— 锁上之后连画都画不了，用户会以为程序坏了。
 */
export function commandRewritesGeometry(cmd: { patches: readonly Patch[] }): boolean {
  let removed = false;
  let added = false;
  for (const p of cmd.patches) {
    if (p.op === 'update' && !shapeEquals(p.before, p.after)) return true;
    if (p.op === 'remove') removed = true;
    if (p.op === 'add') added = true;
  }
  return removed && added;
}

export const useEditor = create<EditorState>((set, get) => ({
  doc: createEmptyDocument(),
  view: { scale: 1, center: { x: 0, y: 0 }, width: 800, height: 600, dpr: 1 },
  view3d: false,
  orbit: { ...DEFAULT_ORBIT },
  datumBase: XY_PLANE,
  mode: 'idle',
  cursor: defaultCursor(),
  selection: new Set<EntityId>(),
  hover: null,
  activeTool: 'select',
  prompt: '就绪',
  log: [],
  history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null, depth: 0 },
  dirty: false,
  kernelStatus: '未加载',
  kernelReady: false,
  gridVisible: true,
  dimsVisible: true,
  constraintsVisible: readUiFlag(CONSTRAINTS_VISIBLE_KEY, true),
  endpointsVisible: readUiFlag(ENDPOINTS_VISIBLE_KEY, true),
  // 默认关：它覆盖图层颜色，得由用户显式打开（见字段注释）。
  sketchColors: readUiFlag(SKETCH_COLORS_KEY, false),
  fullyConstrained: readUiFlag(FULLY_CONSTRAINED_KEY, false),
  constraintReport: null,
  ribbonCollapsed: readUiFlag(
    RIBBON_COLLAPSED_KEY,
    window.innerWidth < RIBBON_AUTO_COLLAPSE_BELOW,
  ),

  // -------------------------------------------------------------------------
  // Document
  // -------------------------------------------------------------------------

  replaceDocument(doc, options) {
    if (options?.resetHistory !== false) {
      history = new CommandHistory();
    }
    set({
      doc,
      selection: new Set(),
      hover: null,
      dirty: false,
      history: historyInfo(history),
      constraintReport: analyzeDocument(doc),
    });
  },

  loadFromJson(text) {
    try {
      const result: LoadResult = deserializeDocument(text);
      get().replaceDocument(result.doc);
      get().pushLog(`已载入 "${result.doc.meta.title}" (${result.doc.entities.length} 个图元)`);
      for (const w of result.warnings) get().pushLog(`⚠ ${w}`);
      return { warnings: result.warnings };
    } catch (e) {
      const msg = (e as Error).message;
      get().pushLog(`✗ 载入失败: ${msg}`);
      return { error: msg };
    }
  },

  exportJson() {
    return JSON.stringify(serializeDocument(get().doc), null, 2);
  },

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  run(cmd) {
    const doc = get().doc;
    history.execute(doc, cmd);
    set({
      doc: { ...doc },
      history: historyInfo(history),
      dirty: true,
      // 命令边界重算自由度报告。`__` 是实时预览（拖动每帧一次），那份开销不值得：
      // 松手时那条真命令会算。报告因此可能在拖动中落后一帧——松手即准。
      constraintReport: cmd.label.startsWith('__') ? get().constraintReport : analyzeDocument(doc),
    });
    const { selection, hover } = get();
    if (selection.size > 0 || hover) {
      const alive = new Set(doc.entities.map((e) => e.id));
      const nextSel = new Set([...selection].filter((id) => alive.has(id)));
      const nextHover = hover && alive.has(hover) ? hover : null;
      if (nextSel.size !== selection.size || nextHover !== hover) {
        set({ selection: nextSel, hover: nextHover });
      }
    }
  },

  undo() {
    const doc = get().doc;
    const cmd = history.undo(doc);
    if (!cmd) {
      get().pushLog('没有可撤销的操作');
      return;
    }
    const alive = new Set(doc.entities.map((e) => e.id));
    set({
      doc: { ...doc },
      history: historyInfo(history),
      dirty: true,
      selection: new Set([...get().selection].filter((id) => alive.has(id))),
      hover: get().hover && alive.has(get().hover!) ? get().hover : null,
      constraintReport: analyzeDocument(doc),
    });
    get().pushLog(`已撤销: ${cmd.label}`);
  },

  redo() {
    const doc = get().doc;
    const cmd = history.redo(doc);
    if (!cmd) {
      get().pushLog('没有可重做的操作');
      return;
    }
    set({
      doc: { ...doc },
      history: historyInfo(history),
      dirty: true,
      constraintReport: analyzeDocument(doc),
    });
    get().pushLog(`已重做: ${cmd.label}`);
  },

  // -------------------------------------------------------------------------
  // Entity mutations
  // -------------------------------------------------------------------------

  addEntities(entities, label = '添加图元') {
    if (entities.length === 0) return;
    const cmd = command(label, ...entities.map(addEntity));
    get().run(cmd);
    set({ selection: new Set(entities.map((e) => e.id)) });
  },

  deleteSelection() {
    const { selection, doc } = get();
    if (selection.size === 0) return;
    // Skip locked entities rather than silently deleting them.
    const deletable = [...selection].filter((id) => {
      const e = doc.entities.find((x) => x.id === id);
      return e ? isPickable(doc, e) : false;
    });
    if (deletable.length === 0) {
      get().pushLog('所选对象位于锁定图层，无法删除');
      return;
    }
    const cmd = removeManyCommand(`删除 ${deletable.length} 个对象`, doc, deletable);
    get().run(cmd);
    set({ selection: new Set(), hover: null });
    get().pushLog(`已删除 ${deletable.length} 个对象`);
  },

  duplicateSelection(offset) {
    const { selection, doc } = get();
    if (selection.size === 0) return;
    const copies: Entity[] = [];
    for (const e of doc.entities) {
      if (!selection.has(e.id)) continue;
      const c = cloneEntity(e);
      translateEntity(c, offset);
      copies.push(c);
    }
    if (copies.length === 0) return;
    get().addEntities(copies, `复制 ${copies.length} 个对象`);
    get().pushLog(`已复制 ${copies.length} 个对象`);
  },

  transformSelection(fn, label) {
    const { selection, doc } = get();
    if (selection.size === 0) return;
    const edits: Entity[] = [];
    for (const e of doc.entities) {
      if (!selection.has(e.id) || !isPickable(doc, e)) continue;
      edits.push(fn(e));
    }
    if (edits.length === 0) {
      get().pushLog('所选对象位于锁定图层，无法修改');
      return;
    }
    // 完全定义：先算出来再判「这次变换到底动不动几何」。只比几何（`shapeEquals`），
    // 所以锁住之后改颜色、换图层仍然照做——锁的是形状，不是整条记录。
    const moved = edits.some((after) => {
      const before = doc.entities.find((e) => e.id === after.id);
      return before !== undefined && !shapeEquals(before, after);
    });
    if (moved && refusesGeometryEdit(get(), '变换', label)) return;
    // 被拖动/变换的对象就是可以动的对象：约束靠调整**它们**来维持，
    // 伙伴留在原地。这样拖一条相切的直线时，圆的圆心不会跟着跑。
    const patches = withConstraintRepair(doc, edits, [...selection], label);
    if (patches.length === 0) return;
    get().run(command(label, ...patches));
  },

  updateEntityById(id, fn, label) {
    const { doc } = get();
    const before = doc.entities.find((e) => e.id === id);
    if (!before) return;
    const after = fn(before);

    // 完全定义：属性面板里改几何（坐标、半径、顶点…）要拦，改外观（图层、颜色、
    // 线型、名称）不拦。同一个入口，两种修改，所以按「几何是否真的变了」判。
    if (!shapeEquals(before, after) && refusesGeometryEdit(get(), '改几何', label)) return;

    // 改属性时**只放开伙伴**。把被编辑对象也放开，求解器会用「把半径改回去」
    // 来满足相切 —— 用户刚做的修改当场被撤销，看起来像输入框不生效。
    // 同理不要钉扎 a 端命名点：那也会把用户刚敲的长度/角度还原（见 withConstraintRepair）。
    const moving = new Set<EntityId>();
    for (const c of constraintsForEntity(doc, id)) {
      moving.add(c.a.entity);
      if (c.b) moving.add(c.b.entity);
    }
    moving.delete(id);

    const patches = withConstraintRepair(doc, [after], [...moving], label, false);
    if (patches.length === 0) return;
    get().run(command(label, ...patches));
  },

  /**
   * 改值即驱动 —— ROADMAP 0.2。
   *
   * 「改圆半径，与它相切的线保持相切」这句话拆开就是这里的三步：
   *
   * 1. 先把敲进去的数落成**几何**（`fn`）。尺寸是意图，几何得先跟上，
   *    否则约束一进去就是违约状态。
   * 2. 同一个数写成**约束**（没有就加、有就改），于是这个值从此有了身份：
   *    它会一直守住，改别的尺寸、拖别的图元都不会把它带走。
   * 3. 只放开**伙伴**解算。被编辑对象自己不许动 —— 与 `updateEntityById` 同一条
   *    理由：放开它，求解器会拿「把半径改回 20」去凑相切，用户刚敲的 30 当场
   *    被撤销。伙伴（那条切线）动，圆不动，才是「半径是驱动量」。
   *
   * 三步合成一条 Command：一次撤销同时撤回几何、伙伴和约束本身。
   */
  setDimensionAction(entityId, kind, value, fn, label) {
    const { doc } = get();
    const before = doc.entities.find((e) => e.id === entityId);
    if (!before) return;

    // 半径 / 直径 / 长度都没有 0 的意义（0 长度的线、0 半径的圆不是图形）。
    if (!Number.isFinite(value) || !(value > 0)) {
      get().pushLog('尺寸必须大于 0');
      return;
    }

    const made = buildEntityDimension(before, kind, value);
    if (!made) {
      // 这一类没有对应的尺寸约束（如直线的角度、椭圆半轴）：退回普通几何编辑，
      // 至少不要让输入框看起来不生效。
      get().updateEntityById(entityId, fn, label);
      return;
    }

    const edited = fn(before);

    // 同一条尺寸（同 kind、同目标点）已存在就改它的值，不再堆第二条。
    const existing = doc.constraints.find((c) => sameConstraint(c, made));
    if (existing && Math.abs((existing.value ?? 0) - value) < 1e-9) return;

    const shadow: CadDocument = {
      ...doc,
      constraints: existing
        ? doc.constraints.map((c) => (c === existing ? made : c))
        : [...doc.constraints, made],
    };

    const moving = new Set<EntityId>();
    for (const c of constraintsForEntity(doc, entityId)) {
      moving.add(c.a.entity);
      if (c.b) moving.add(c.b.entity);
    }
    moving.delete(entityId);

    const patches: Patch[] = [updateEntity(before, edited)];
    patches.push(existing ? updateConstraint(existing, made) : addConstraint(made));
    for (const solved of solveAfterEdit(shadow, [edited], [...moving])) {
      const was = doc.entities.find((e) => e.id === solved.id);
      if (was && !geometryEquals(was, solved)) patches.push(updateEntity(was, solved));
    }

    get().run(command(label, ...patches));
    get().pushLog(
      `${existing ? '已改写' : '已写入'}「${CONSTRAINT_LABEL[kind]}」尺寸约束 = ${fmt(value)}` +
        `（右栏约束列表里可删除）`,
    );
  },

  addConstraintAction(kind) {
    const { doc, selection } = get();
    // 完全定义：尺寸约束（含「固定」——它只是把现状钉住，不移动任何东西）照样能
    // 加，因为 0.4 允许的正是尺寸；**几何关系**（相切/平行/水平…）会通过求解移动
    // 几何，那就越过了这把锁。想加就先关掉「完全定义」。
    const isDimension = DIMENSIONAL_CONSTRAINTS.has(kind);
    if (!isDimension && refusesGeometryEdit(get(), `「${CONSTRAINT_LABEL[kind]}」约束`)) return;
    const entities = doc.entities.filter((e) => selection.has(e.id));
    const built = buildConstraints(kind, entities);
    if (!built.constraints || built.constraints.length === 0) {
      get().pushLog(`无法添加「${CONSTRAINT_LABEL[kind]}」：${built.reason ?? '所选对象不适用'}`);
      return;
    }

    // 已经存在的同款约束不再重复添加。重复并不「错」，但会让求解器带着
    // 冗余方程跑，日志里也会看着像点了几下就加了几条。
    const fresh = built.constraints.filter(
      (c) => !doc.constraints.some((existing) => sameConstraint(existing, c)),
    );
    if (fresh.length === 0) {
      get().pushLog(`「${CONSTRAINT_LABEL[kind]}」已经存在`);
      return;
    }

    const shadow: CadDocument = { ...doc, constraints: [...doc.constraints, ...fresh] };
    const moving: EntityId[] = [];
    for (const c of fresh) {
      moving.push(c.a.entity);
      if (c.b) moving.push(c.b.entity);
    }

    const patches: Patch[] = fresh.map(addConstraint);
    for (const solved of solveConstraints(shadow, moving)) {
      const before = doc.entities.find((e) => e.id === solved.id);
      if (before && !geometryEquals(before, solved)) patches.push(updateEntity(before, solved));
    }

    get().run(command(`添加约束: ${CONSTRAINT_LABEL[kind]}`, ...patches));
    get().pushLog(`已添加 ${fresh.length} 条「${CONSTRAINT_LABEL[kind]}」约束`);
  },

  setConstraintValueAction(id, value) {
    const { doc } = get();
    const target = doc.constraints.find((c) => c.id === id);
    // 只有尺寸约束有「值」可改；几何关系（相切/平行…）直接忽略。
    if (!target || !DIMENSIONAL_CONSTRAINTS.has(target.kind)) return;
    // 距离三兄弟的 0 是「重合 / 对齐」，是合法目标值；锚点钉的是世界坐标，负半边
    // 世界也合法；半径/角度才必须为正。
    const mayBeZero = ZERO_VALUE_DIMENSIONS.has(target.kind);
    const signed = SIGNED_DIMENSIONS.has(target.kind);
    if (!Number.isFinite(value) || (!signed && (mayBeZero ? value < 0 : value <= 0))) {
      get().pushLog(signed ? '坐标必须是有限数' : mayBeZero ? '尺寸不能为负数' : '尺寸必须大于 0');
      return;
    }
    if (Math.abs((target.value ?? 0) - value) < 1e-9) return;

    const after = { ...target, value };
    // 尺寸改值时**值是新的真相**：放开这条约束涉及的全部实体，让求解器把
    // 几何搬到目标值上。与 addConstraintAction 同一手法——先在 shadow 文档
    // 上解算，补丁合成一条命令，一次撤销连值带几何一起回来。
    const shadow: CadDocument = {
      ...doc,
      constraints: doc.constraints.map((c) => (c.id === id ? after : c)),
    };
    // 只放开滑动端（b 端）：a 端是圆心，方向性语义下圆心钉死不动——半径
    // 的变化全部由 b 端吸收。半径/直径无 b 端，放开圆自身。
    const moving: EntityId[] = target.b ? [target.b.entity] : [target.a.entity];

    const patches: Patch[] = [updateConstraint(target, after)];
    for (const solved of solveConstraints(shadow, moving)) {
      const before = doc.entities.find((e) => e.id === solved.id);
      if (before && !geometryEquals(before, solved)) patches.push(updateEntity(before, solved));
    }

    const shown =
      target.kind === 'angle' ? `${((value * 180) / Math.PI).toFixed(1)}°` : `${Number(value.toFixed(3))}`;
    get().run(command(`改尺寸: ${CONSTRAINT_LABEL[target.kind]} = ${shown}`, ...patches));
    get().pushLog(`「${CONSTRAINT_LABEL[target.kind]}」已改为 ${shown}`);
  },

  removeConstraintAction(id) {
    const { doc } = get();
    const patch = removeConstraint(doc, id);
    if (!patch) return;
    const target = doc.constraints.find((c) => c.id === id);
    const label = target ? CONSTRAINT_LABEL[target.kind] : '约束';
    get().run(command(`删除约束: ${label}`, patch));
    get().pushLog(`已删除「${label}」约束`);
  },

  removeConstraintsForSelection() {
    const { doc, selection } = get();
    const doomed = doc.constraints.filter(
      (c) => selection.has(c.a.entity) || (c.b ? selection.has(c.b.entity) : false),
    );
    if (doomed.length === 0) {
      get().pushLog('所选对象上没有约束');
      return;
    }
    // 降序删除：撤销时补丁按反序回放，索引才是对的。
    const patches = doomed
      .map((c) => removeConstraint(doc, c.id))
      .filter((p): p is Patch => p !== null)
      .sort((a, b) => {
        const ai = a.op === 'constraintRemove' ? a.index : 0;
        const bi = b.op === 'constraintRemove' ? b.index : 0;
        return bi - ai;
      });
    get().run(command(`删除 ${doomed.length} 条约束`, ...patches));
    get().pushLog(`已删除 ${doomed.length} 条约束`);
  },

  splitAtIntersections() {
    const { doc, selection } = get();
    // 分解把一条曲线换成两段：几何的**身份**变了（约束会被撤掉、端点重排），
    // 属于「改几何」，完全定义下拒绝。删除/新建/复制不在这里拦——它们不动已有
    // 几何，锁的是形状而不是整张图。
    if (refusesGeometryEdit(get(), '交点分解')) return;
    const targets = splitTargets(doc, selection);
    if (targets.length === 0) {
      get().pushLog('没有可分解的对象（所选对象位于隐藏或锁定图层）');
      return;
    }
    const res = splitEntities(doc, targets);
    if (!res.ok) {
      if (res.reason === 'noKernel') {
        get().pushLog('内核未就绪，交点分解不可用');
      } else if (targets.length === 1 && targets[0]!.type === 'ellipse') {
        // Said plainly rather than as a generic "nothing to split": the user
        // pressed the button on an ellipse and deserves to know why.
        get().pushLog('椭圆不支持交点分解：切开后的「椭圆弧」不是本项目的图元');
      } else {
        get().pushLog('所选对象之间没有交点，无需分解');
      }
      return;
    }

    get().run(splitCommand(doc, res.groups));
    const pieces = res.groups.reduce((n, g) => n + g.pieces.length, 0);
    // Re-select the pieces: they replace the originals, so leaving the old ids
    // selected would point at nothing.
    set({ selection: new Set(res.groups.flatMap((g) => g.pieces.map((p) => p.id))), hover: null });
    get().pushLog(
      selection.size > 0
        ? `已分解 ${res.groups.length} 个对象为 ${pieces} 段`
        : `已分解全图 ${res.groups.length} 个对象为 ${pieces} 段`,
    );
  },

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  select(ids, additive = false) {
    const next = additive ? new Set(get().selection) : new Set<EntityId>();
    for (const id of ids) next.add(id);
    set({ selection: next });
  },

  toggleSelect(id) {
    const next = new Set(get().selection);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ selection: next });
  },

  clearSelection() {
    set({ selection: new Set(), hover: null });
  },

  selectAll() {
    const { doc } = get();
    // Only the active plane's sketches: selecting an entity this view cannot
    // even draw would put handles on nothing.
    const ids = doc.entities
      .filter((e) => isPickable(doc, e) && planeOf(e) === doc.activePlane)
      .map((e) => e.id);
    set({ selection: new Set(ids) });
    get().pushLog(`已选择 ${ids.length} 个对象`);
  },

  setHover(id) {
    if (get().hover === id) return;
    set({ hover: id });
  },

  // -------------------------------------------------------------------------
  // Tools & messaging
  // -------------------------------------------------------------------------

  setTool(id) {
    if (get().activeTool === id) return;
    set({ activeTool: id, mode: id === 'select' ? 'idle' : 'drawing' });
  },

  setMode(mode) {
    set({ mode });
  },

  setPrompt(text) {
    set({ prompt: text });
  },

  pushLog(text) {
    const log = [...get().log, text];
    set({ log: log.length > MAX_LOG ? log.slice(log.length - MAX_LOG) : log });
  },

  clearLog() {
    set({ log: [] });
  },

  // -------------------------------------------------------------------------
  // Cursor
  // -------------------------------------------------------------------------

  setCursorWorld(p) {
    set({ cursor: { ...get().cursor, world: p } });
  },

  setCursorScreen(p) {
    set({ cursor: { ...get().cursor, screen: p } });
  },

  setCursorEffective(p) {
    set({ cursor: { ...get().cursor, effective: p } });
  },

  setSnap(s) {
    set({ cursor: { ...get().cursor, snap: s } });
  },

  setLocked(locked) {
    set({ cursor: { ...get().cursor, locked } });
  },

  // -------------------------------------------------------------------------
  // View
  // -------------------------------------------------------------------------

  setView(v) {
    set({ view: { ...get().view, ...v } });
  },

  setView3d(on) {
    set({ view3d: on });
  },

  setOrbit(o) {
    set({ orbit: { ...get().orbit, ...o } });
  },

  setDatumBase(id) {
    if (get().datumBase === id) return;
    set({ datumBase: id });
  },

  panBy(dx, dy) {
    const view = get().view;
    set({
      view: {
        ...view,
        center: {
          x: view.center.x - dx * view.scale,
          y: view.center.y + dy * view.scale,
        },
      },
    });
  },

  zoomAt(screenAnchor, factor) {
    const view = get().view;
    const before = screenToWorld(screenAnchor, view);
    const scale = clamp(view.scale / factor, 1e-4, 1e5);
    const after = screenToWorld(screenAnchor, { ...view, scale });
    set({
      view: {
        ...view,
        scale,
        center: {
          x: view.center.x + (before.x - after.x),
          y: view.center.y + (before.y - after.y),
        },
      },
    });
  },

  zoomToFit() {
    const { doc, view } = get();
    const bounds = docBounds(doc);
    if (!bounds) {
      set({ view: { ...view, center: { x: 0, y: 0 }, scale: 1 } });
      return;
    }
    const w = Math.max(bounds.maxX - bounds.minX, 1e-6);
    const h = Math.max(bounds.maxY - bounds.minY, 1e-6);
    const scale = clamp(
      Math.max(w / (view.width * 0.84), h / (view.height * 0.84)),
      1e-4,
      1e5,
    );
    set({
      view: {
        ...view,
        scale,
        center: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 },
      },
    });
    get().pushLog('视图已缩放到图形范围');
  },

  // -------------------------------------------------------------------------
  // Layers
  // -------------------------------------------------------------------------

  addLayerAction(name) {
    const doc = get().doc;
    const index = doc.layers.length;
    const layerName = name ?? `图层${index}`;
    const palette = ['#f2637f', '#5ac8fa', '#ffd166', '#9d7cff', '#4ec9b0', '#ff9f43', '#e8e8e8'];
    const layer: Layer = {
      id: newLayerId(layerName),
      name: layerName,
      color: palette[index % palette.length]!,
      lineStyle: 'continuous',
      lineWeight: 0.25,
      visible: true,
      locked: false,
      frozen: false,
      printable: true,
    };
    get().run(command(`新建图层 "${layerName}"`, addLayer(layer)));
    get().pushLog(`已新建图层 "${layerName}"`);
    return layer.id;
  },

  updateLayerAction(id, patch) {
    const doc = get().doc;
    const before = doc.layers.find((l) => l.id === id);
    if (!before) return;
    const after: Layer = { ...before, ...patch };
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    get().run(command(`修改图层 "${before.name}"`, updateLayer(before, after)));
  },

  removeLayerAction(id) {
    const doc = get().doc;
    if (doc.layers.length <= 1) {
      get().pushLog('至少需要保留一个图层');
      return;
    }
    const layer = doc.layers.find((l) => l.id === id);
    if (!layer) return;
    const inUse = doc.entities.filter((e) => e.layer === id).length;
    if (inUse > 0) {
      get().pushLog(`图层 "${layer.name}" 上还有 ${inUse} 个对象，无法删除`);
      return;
    }
    if (doc.currentLayer === id) {
      const other = doc.layers.find((l) => l.id !== id);
      if (other) get().run(command('切换当前图层', setCurrentLayer(id, other.id)));
    }
    const patch = removeLayer(doc, id);
    if (patch) get().run(command(`删除图层 "${layer.name}"`, patch));
    get().pushLog(`已删除图层 "${layer.name}"`);
  },

  setCurrentLayerAction(id) {
    const doc = get().doc;
    if (doc.currentLayer === id) return;
    get().run(command('切换当前图层', setCurrentLayer(doc.currentLayer, id)));
  },

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  updateSettings(patch) {
    const doc = get().doc;
    doc.settings = { ...doc.settings, ...patch };
    set({ doc: { ...doc }, dirty: true });
  },

  toggleOsnap(mode) {
    const modes = get().doc.settings.osnapModes;
    const next = modes.includes(mode) ? modes.filter((m) => m !== mode) : [...modes, mode];
    get().updateSettings({ osnapModes: next });
  },

  setConstraint(mode) {
    get().updateSettings({ constraint: mode });
    const labels: Record<ConstraintMode, string> = {
      none: '正交/极轴追踪: 关闭',
      grid: '栅格捕捉: 开启',
      ortho: '正交模式: 开启',
      polar: `极轴追踪: ${get().doc.settings.polarIncrement}°`,
    };
    get().pushLog(labels[mode]);
  },

  toggleGrid() {
    set({ gridVisible: !get().gridVisible });
  },

  setDimsVisible(visible) {
    set({ dimsVisible: visible });
  },

  toggleDims() {
    const visible = !get().dimsVisible;
    set({ dimsVisible: visible });
    get().pushLog(visible ? '自动尺寸: 开启' : '自动尺寸: 关闭');
  },

  setConstraintsVisible(visible) {
    writeUiFlag(CONSTRAINTS_VISIBLE_KEY, visible);
    set({ constraintsVisible: visible });
  },

  toggleConstraints() {
    const visible = !get().constraintsVisible;
    get().setConstraintsVisible(visible);
    get().pushLog(visible ? '约束标记: 显示' : '约束标记: 隐藏');
  },

  setEndpointsVisible(visible) {
    writeUiFlag(ENDPOINTS_VISIBLE_KEY, visible);
    set({ endpointsVisible: visible });
  },

  toggleEndpoints() {
    const visible = !get().endpointsVisible;
    get().setEndpointsVisible(visible);
    get().pushLog(visible ? '端点标色: 显示' : '端点标色: 隐藏');
  },

  setSketchColors(on) {
    writeUiFlag(SKETCH_COLORS_KEY, on);
    set({ sketchColors: on });
  },

  toggleSketchColors() {
    const on = !get().sketchColors;
    get().setSketchColors(on);
    get().pushLog(
      on
        ? '约束状态配色: 开（蓝色 = 还缺尺寸或方位约束；只是位置没定的不染——用「固定」钉住即可）'
        : '约束状态配色: 关',
    );
  },

  setFullyConstrained(visible) {
    writeUiFlag(FULLY_CONSTRAINED_KEY, visible);
    set({ fullyConstrained: visible });
  },

  toggleFullyConstrained() {
    const visible = !get().fullyConstrained;
    get().setFullyConstrained(visible);
    if (!visible) {
      get().pushLog('完全定义: 关（几何恢复可编辑）');
      return;
    }
    // 锁是手动的开关，跟自由度无关：草图真到没到 0 由状态芯片说。但一句「开」
    // 不足以让人知道改不动东西是**故意的**，所以把剩下多少自由度、怎么改也一起说。
    const report = get().constraintReport;
    const dof = report?.dof ?? null;
    get().pushLog(
      '完全定义: 开（几何已锁定，只能通过尺寸约束驱动）' +
        (dof === null
          ? ''
          : dof > 0
            ? ` · 注意草图还有 ${dof} 个自由度，锁只是禁止拖动，不会把它变少`
            : ' · 草图自由度已为 0'),
    );
  },

  setRibbonCollapsed(collapsed) {
    writeUiFlag(RIBBON_COLLAPSED_KEY, collapsed);
    set({ ribbonCollapsed: collapsed });
  },

  toggleRibbon() {
    get().setRibbonCollapsed(!get().ribbonCollapsed);
  },

  setPlaneVisible(id, visible) {
    const doc = get().doc;
    const planes = doc.planes.map((p) => (p.id === id ? { ...p, visible } : p));
    set({ doc: { ...doc, planes }, dirty: true });
  },

  setFrameVisible(id, visible) {
    const doc = get().doc;
    const frames = doc.frames.map((f) => (f.id === id ? { ...f, visible } : f));
    set({ doc: { ...doc, frames }, dirty: true });
  },

  setActivePlane(id) {
    const doc = get().doc;
    if (doc.activePlane === id) return;
    const plane = doc.planes.find((p) => p.id === id);
    if (!plane) return;
    // Undoable: which plane new geometry lands on is a document fact, not a view
    // preference — the same reason `setCurrentLayer` goes through history.
    get().run(command('切换基准面', setActivePlanePatch(doc.activePlane, id)));
    get().pushLog(`活动草图面: ${plane.name}`);
  },

  addFrameOnActivePlane() {
    const doc = get().doc;
    const plane = doc.planes.find((p) => p.id === doc.activePlane);
    if (!plane) return null;
    const id = `frame-${Math.random().toString(36).slice(2, 8)}`;
    const frame: DocFrame = {
      id,
      name: `坐标系 ${doc.frames.length}`,
      origin: [plane.origin[0], plane.origin[1], plane.origin[2]],
      xAxis: [plane.u[0], plane.u[1], plane.u[2]],
      yAxis: [plane.v[0], plane.v[1], plane.v[2]],
      visible: true,
    };
    get().run(command('新建坐标系', addFrame(frame)));
    get().pushLog(`已按活动基准面新建「${frame.name}」`);
    return id;
  },

  deleteFrame(id) {
    const doc = get().doc;
    // The world frame is the fallback everything else assumes; it stays.
    if (doc.frames.length <= 1) return;
    const p = removeFrame(doc, id);
    if (p) get().run(command('删除坐标系', p));
  },

  addOffsetPlane(baseId, offset) {
    const doc = get().doc;
    const base = doc.planes.find((p) => p.id === baseId);
    if (!base) return null;
    if (!Number.isFinite(offset)) return null;
    const n = planeNormal(base);
    const id = `plane-${Math.random().toString(36).slice(2, 8)}`;
    const plane: DocPlane = {
      id,
      name: `${base.name} 偏移 ${fmt(offset)}`,
      origin: [
        base.origin[0] + n[0] * offset,
        base.origin[1] + n[1] * offset,
        base.origin[2] + n[2] * offset,
      ],
      // Same in-plane axes as the base: a parallel plane, just lifted.
      u: [base.u[0], base.u[1], base.u[2]],
      v: [base.v[0], base.v[1], base.v[2]],
      visible: true,
    };
    get().run(command('新建基准面', addPlane(plane)));
    get().pushLog(`已按 ${base.name} 新建「${plane.name}」`);
    return id;
  },

  deletePlane(id) {
    const doc = get().doc;
    // The three base planes are what "which way is up" means; they stay.
    if (id === 'xy' || id === 'yz' || id === 'zx') return;
    const plane = doc.planes.find((p) => p.id === id);
    if (!plane) return;
    const count = doc.entities.filter((e) => planeOf(e) === id).length;
    if (count > 0) {
      get().pushLog(`「${plane.name}」上还有 ${count} 个图元，先移走或删除再删面。`);
      return;
    }
    const patches: Patch[] = [];
    if (doc.activePlane === id) {
      // Switching away is folded into the same command, so one undo brings the
      // plane back *and* restores what was active.
      patches.push(setActivePlanePatch(doc.activePlane, XY_PLANE));
    }
    const p = removePlane(doc, id);
    if (p) patches.push(p);
    if (patches.length > 0) get().run(command('删除基准面', ...patches));
  },

  setKernelStatus(text) {
    set({ kernelStatus: text });
  },
  setKernelReady(ready) {
    // 内核刚就绪时补算一次：文档可能在内核到位之前就建好了（示例图纸就是这样），
    // 否则状态栏会一直空着等到用户下一次动文档。
    set({ kernelReady: ready, constraintReport: analyzeDocument(get().doc) });
  },

  markSaved() {
    set({ dirty: false });
  },
}));

// ---------------------------------------------------------------------------
// Local helpers (kept out of the store body for readability)
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function screenToWorld(p: Vec2, view: ViewState): Vec2 {
  return {
    x: (p.x - view.width / 2) * view.scale + view.center.x,
    y: (view.height / 2 - p.y) * view.scale + view.center.y,
  };
}

function worldToScreen(p: Vec2, view: ViewState): Vec2 {
  return {
    x: (p.x - view.center.x) / view.scale + view.width / 2,
    y: view.height / 2 - (p.y - view.center.y) / view.scale,
  };
}

export function docBounds(doc: CadDocument): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (x: number, y: number): void => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const e of doc.entities) {
    switch (e.type) {
      case 'line':
        visit(e.a.x, e.a.y);
        visit(e.b.x, e.b.y);
        break;
      case 'polyline':
        for (const p of e.points) visit(p.x, p.y);
        break;
      case 'circle':
      case 'arc':
        visit(e.center.x - e.radius, e.center.y - e.radius);
        visit(e.center.x + e.radius, e.center.y + e.radius);
        break;
      case 'ellipse': {
        const c = Math.cos(e.rotation);
        const s = Math.sin(e.rotation);
        const hx = Math.hypot(e.rx * c, e.ry * s);
        const hy = Math.hypot(e.rx * s, e.ry * c);
        visit(e.center.x - hx, e.center.y - hy);
        visit(e.center.x + hx, e.center.y + hy);
        break;
      }
    }
  }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY };
}

/** In-place translation, shared by duplicate / paste / move. */
export function translateEntity(e: Entity, d: Vec2): void {
  switch (e.type) {
    case 'line':
      e.a = { x: e.a.x + d.x, y: e.a.y + d.y };
      e.b = { x: e.b.x + d.x, y: e.b.y + d.y };
      break;
    case 'polyline':
      e.points = e.points.map((p) => ({ x: p.x + d.x, y: p.y + d.y }));
      break;
    case 'circle':
    case 'arc':
    case 'ellipse':
      e.center = { x: e.center.x + d.x, y: e.center.y + d.y };
      break;
  }
}

export { screenToWorld, worldToScreen };

// ---------------------------------------------------------------------------
// Constraint repairs
// ---------------------------------------------------------------------------

/**
 * Are these two the same statement? Used to refuse adding a constraint twice.
 *
 * Compared structurally rather than by id, because ids are per-session and two
 * constraints added separately never share one.
 */
function sameConstraint(
  a: { kind: ConstraintKind; a: { entity: EntityId; point: string; index?: number }; b?: { entity: EntityId; point: string; index?: number } },
  b: { kind: ConstraintKind; a: { entity: EntityId; point: string; index?: number }; b?: { entity: EntityId; point: string; index?: number } },
): boolean {
  const sameEnd = (
    x: { entity: EntityId; point: string; index?: number } | undefined,
    y: { entity: EntityId; point: string; index?: number } | undefined,
  ): boolean => {
    if (!x || !y) return !x && !y;
    return x.entity === y.entity && x.point === y.point && (x.index ?? 0) === (y.index ?? 0);
  };
  return a.kind === b.kind && sameEnd(a.a, b.a) && sameEnd(a.b, b.b);
}

/**
 * Run the solver over the *post-edit* geometry, without touching the document.
 *
 * Only the entities that constraints actually mention are handed to the solver,
 * with the caller's edits substituted in. Two reasons for the restriction:
 *
 * * **Cost.** Cloning and packing the whole drawing on every property keystroke
 *   would make editing a large file crawl. The constrained set is tiny.
 * * **Correctness.** The rest of the document is irrelevant to the residuals, so
 *   including it could only introduce noise.
 */
function solveAfterEdit(
  doc: CadDocument,
  edits: readonly Entity[],
  moving: readonly EntityId[],
): Entity[] {
  if (doc.constraints.length === 0) return [];
  const movingSet = new Set(moving);
  if (movingSet.size === 0) return [];

  const involvedIds = new Set<EntityId>();
  for (const c of doc.constraints) {
    involvedIds.add(c.a.entity);
    if (c.b) involvedIds.add(c.b.entity);
  }

  const overrides = new Map<EntityId, Entity>();
  for (const e of edits) overrides.set(e.id, e);

  const involved = doc.entities
    .filter((e) => involvedIds.has(e.id))
    .map((e) => overrides.get(e.id) ?? e);

  if (!involved.some((e) => movingSet.has(e.id))) return [];
  return solveConstraints({ ...doc, entities: involved }, movingSet);
}

/**
 * Turn "the user's edits plus whatever the constraints demand" into **one** patch
 * list, so a single undo takes back both.
 *
 * `edits` are the post-edit entities; anything the solver also changed is merged
 * on top of them rather than emitted as a second patch for the same object — the
 * solver ran against a scene that already contained the edit, so its output *is*
 * the final geometry.
 *
 * Labels starting with `__` are live previews (see `CanvasView`'s drag handling:
 * `__live_move` / `__revert_live_move`), which run once per frame. `__live_move`
 * **is solved** — that is what makes the constraint follow the cursor during a
 * drag instead of snapping only on release (the systems here are tiny, so an LM
 * solve per frame is cheap). `__revert_live_move` and tool previews skip the
 * repair: reverting restores the pre-drag geometry and previews must not touch
 * the document at all.
 */
function withConstraintRepair(
  doc: CadDocument,
  edits: readonly Entity[],
  moving: readonly EntityId[],
  label: string,
  pinAnchor = true,
): Patch[] {
  // 距离类约束的 a 端是圆心：拖动圆心所在实体时，把被钉点按回原位——
  // 「以第一个曲线终点为圆心」意味着圆心永不移动，曲线绕它拉伸/转动。
  // （弧的端点由圆心+角度导出，无法直接钉，暂不处理。）
  //
  // 两个例外，都是「钉扎会把用户自己的编辑吃掉」的情形：
  //
  // * **圆 / 椭圆**：圆心是它们**唯一**的命名点，把它钉回去等于整条曲线原地
  //   不动（残差本来就已满足，求解器也不会再动它）——用户看到的是「这个圆
  //   拖不动」。这两种交给求解器把它拉回圆上，仍然满足距离。
  // * **属性面板改值**（`pinAnchor = false`）：`updateEntityById` 走的是同一条
  //   路，改「长度/角度」时若该图元是 a 端且被钉点是终点，钉扎会把刚改的值静默
  //   还原，输入框看起来不生效。
  const adjusted: Entity[] = edits.map((e) => {
    if (!pinAnchor) return e;
    if (e.type === 'circle' || e.type === 'ellipse') return e;
    for (const c of doc.constraints) {
      if (c.a.entity !== e.id) continue;
      if (c.kind !== 'distance' && c.kind !== 'distanceX' && c.kind !== 'distanceY') continue;
      if (!c.b) continue;
      // 直线自己的「长度」尺寸（两端点都在它身上）不是圆心语义：钉住起点会
      // 让拖动变成拉伸。长度约束对平移完全无感，本来就该整条线跟着走。
      if (isSelfDimension(c)) continue;
      const owner = doc.entities.find((x) => x.id === c.a.entity);
      if (!owner) continue;
      const at = constraintPointAt(owner, c.a.point, c.a.index ?? 0);
      if (!at) continue;
      const pinnedEntity = pinNamedPoint(e, c.a.point, c.a.index ?? 0, at);
      if (pinnedEntity) return pinnedEntity;
      break;
    }
    return e;
  });

  const finalById = new Map<EntityId, Entity>();
  for (const e of adjusted) finalById.set(e.id, e);

  // 实时拖动（__live_move）也解算：约束在拖动中就贴住几何，松手不再弹跳。
  // 其余 __ 前缀（revert、工具预览）维持跳过——预览阶段不动文档几何。
  if (label === '__live_move' || !label.startsWith('__')) {
    for (const solved of solveAfterEdit(doc, adjusted, moving)) finalById.set(solved.id, solved);
  }

  const patches: Patch[] = [];
  for (const before of doc.entities) {
    const after = finalById.get(before.id);
    if (after && !geometryEquals(before, after)) patches.push(updateEntity(before, after));
  }
  return patches;
}

/** Convenience selector: the currently selected entities. */
export function selectedEntities(state: EditorState): Entity[] {
  if (state.selection.size === 0) return [];
  return state.doc.entities.filter((e) => state.selection.has(e.id));
}

/** Convenience selector: the active layer object. */
export function currentLayer(state: EditorState): Layer | undefined {
  return state.doc.layers.find((l) => l.id === state.doc.currentLayer);
}

export { DEFAULT_OSNAP_MODES, fmt };

/**
 * Test handle: the whole editor state, reachable from a page-level script.
 *
 * The property panel is the one part of the UI whose correctness cannot be
 * checked from the DOM alone — a control can happily show `10` while the entity
 * still holds `5`, and every screenshot would agree that it looks right. So
 * `verify:props` reads the document through this handle and compares it against
 * what the control claims, which is the only way the assertion can fail when the
 * wiring is wrong.
 *
 * Assigned at module scope rather than in an effect because it has no
 * lifecycle: it is the store itself, and it must be there before the first
 * component mounts. Same spirit as `window.__unicadView` (exposed by
 * `CanvasView`) — a stable name for tests, not a public API.
 */
(window as unknown as { __unicadStore?: unknown }).__unicadStore = useEditor;

