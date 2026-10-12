/**
 * The canvas view: owns the renderer, the pointer/keyboard event loop, and the
 * per-frame compositing of entities + overlays.
 *
 * This is the only component that talks to WebGL. Everything else publishes
 * state into the store and this component reacts.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { GlRenderer, hexToRgba, type RenderStyle } from '../render/gl';
import { clampPitch, hitPlane, pickPlane, viewProj } from '../render/orbit';
import { buildGrid } from '../render/grid';
import { resolveRenderStyle, UI_COLORS } from '../render/style';
import {
  crosshair,
  selectionWindow,
  segmentsToVertices,
  snapMarker,
  endpointMarkers,
  type OverlaySegment,
} from '../render/overlay';
import {
  liveDimension,
  selectedDimensions,
  type DimContext,
  type DimLabel,
} from '../render/dims';
import { constraintBadges, constraintGuides } from '../render/constraintMarks';
import { dofMarkers } from '../render/dofMarks';
import { isUnderDefined } from '../core/constraints';
import PieMenu from './PieMenuView';
import { buildPieMenu, runPieAction } from './pieMenu';
import { useEditor } from '../state/editorStore';
import {
  SceneBuffer,
  entityBounds,
  extrudeMesh,
  isKernelReady,
  packScene,
  pickAll,
  selectInRect,
  snapQuery,
  snapKindFromTag,
  applyConstraints,
  initKernel,
} from '../core/kernel';
import {
  findPlane,
  packOsnapMask,
  planeFrame,
  planeOf,
  CONSTRAINT_TAG,
} from '../core/types';
import type { DocPlane, Entity, EntityId, Mat, Vec2 } from '../core/types';
import { propField } from '../core/props';
import { isPickable, isSnappable, isVisible, entityBoundsTS, resolveStyle, arcPointAt } from '../core/entities';
import { adaptiveGridSpacing, clipMatrixOf } from '../render/camera';

// ---------------------------------------------------------------------------
// Interaction types
// ---------------------------------------------------------------------------

type DragKind = 'none' | 'pan' | 'window' | 'move' | 'orbit';

/**
 * Datum plane extent in model units — big enough to read as a plane in space.
 *
 * Lives at module scope because both the pointer handlers (which hit-test the
 * tile) and the render loop (which draws it) need the same number; a copy in
 * each would drift the moment one is tuned.
 */
const DATUM_SIZE = 150;

interface DragState {
  kind: DragKind;
  /** Screen-space anchor where the drag began. */
  startScreen: Vec2;
  /** Model-space anchor where the drag began. */
  startWorld: Vec2;
  /** For `move`: the pre-drag copies of the selected entities. */
  originals: Entity[];
  lastWorld: Vec2;
  additive: boolean;
}

const EMPTY_DRAG: DragState = {
  kind: 'none',
  startScreen: { x: 0, y: 0 },
  startWorld: { x: 0, y: 0 },
  originals: [],
  lastWorld: { x: 0, y: 0 },
  additive: false,
};

export default function CanvasView(): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<GlRenderer | null>(null);
  const sceneBufferRef = useRef<SceneBuffer | null>(null);
  const dragRef = useRef<DragState>({ ...EMPTY_DRAG });
  const rafRef = useRef<number>(0);
  const dirtyRef = useRef(true);
  /**
   * Where the mouse meets the **active datum plane**, in world space.
   *
   * The 3D view has no 2D cursor: the mouse is a ray, and the point that matters
   * is where that ray crosses the plane you would sketch on. `null` when the ray
   * misses (edge-on, or behind the eye) — the crosshair simply is not drawn.
   */
  const cursor3dRef = useRef<[number, number, number] | null>(null);
  /**
   * The datum plane under the mouse, for highlighting and click-select.
   *
   * Kept in a ref rather than state: it changes on every mouse move and only the
   * render loop reads it, so React should not be told each time.
   */
  const hoverPlaneRef = useRef<DocPlane | null>(null);
  /** The plane under the pointer when a 3D drag began — a click, not a drag. */
  const clickPlaneRef = useRef<{ plane: DocPlane; screen: Vec2 } | null>(null);
  /**
   * The DOM layer the dimension pills are written into.
   *
   * Written **directly**, not through React state: the live readout has to track
   * the cursor, i.e. it changes every single frame, and re-rendering this 800-line
   * component 60 times a second to move one `<span>` is a lot of reconciliation
   * for nothing. The node pool below keeps it to a `textContent` + a CSS variable
   * per label per frame.
   */
  const dimLayerRef = useRef<HTMLDivElement | null>(null);
  /** Log a render-frame failure once, not once per frame. */
  const frameErrorRef = useRef(false);

  /**
   * 画布上正在就地编辑的尺寸（ROADMAP 0.2 的「尺寸标签改值」）。
   *
   * 放在 React state 而不是那个每帧重建的标注池里：编辑期间**不能**被渲染循环
   * 覆写。池子照旧每帧更新（标注还在原位、只是被输入框盖住），输入框自己独立
   * 渲染在它上面——两条路互不干扰，也不需要让渲染循环知道「有人在打字」。
   */
  const [dimDraft, setDimDraft] = useState<{
    entity: EntityId;
    fieldKey: string;
    label: string;
    x: number;
    y: number;
    text: string;
  } | null>(null);
  /** Esc 取消：blur 也会触发提交，所以取消要留个标记。 */
  const dimCancelRef = useRef(false);

  /**
   * 右键饼菜单的落点（画布内 CSS 像素 + 模型坐标）。`null` = 没开。
   *
   * 放 React state 而不是 imperative DOM：它一帧里最多变一次，且要在文档/选择变化时
   * 跟着重算内容（扇区的可用性就是选择的函数）。
   */
  const [pie, setPie] = useState<{ x: number; y: number; world: Vec2 } | null>(null);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scaleBar, setScaleBar] = useState('');

  // --- store ---------------------------------------------------------------
  const doc = useEditor((s) => s.doc);
  const view = useEditor((s) => s.view);
  const selection = useEditor((s) => s.selection);
  // 饼菜单的内容是「选择 + 工具 + 视图状态」的函数，所以这三项要订阅着。
  const activeTool = useEditor((s) => s.activeTool);
  const view3d = useEditor((s) => s.view3d);
  const constraintReport = useEditor((s) => s.constraintReport);
  // Reactive kernel state, so the HUD badge disappears the moment the module
  // finishes loading instead of being frozen at its first-render value.
  const kernelReady = useEditor((s) => s.kernelReady);

  const setView = useEditor((s) => s.setView);
  const panBy = useEditor((s) => s.panBy);
  const zoomAt = useEditor((s) => s.zoomAt);
  const setCursorWorld = useEditor((s) => s.setCursorWorld);
  const setDatumBase = useEditor((s) => s.setDatumBase);
  const setCursorScreen = useEditor((s) => s.setCursorScreen);
  const setCursorEffective = useEditor((s) => s.setCursorEffective);
  const setSnap = useEditor((s) => s.setSnap);
  const setLocked = useEditor((s) => s.setLocked);
  const setHover = useEditor((s) => s.setHover);
  const select = useEditor((s) => s.select);
  const toggleSelect = useEditor((s) => s.toggleSelect);
  const clearSelection = useEditor((s) => s.clearSelection);
  const setMode = useEditor((s) => s.setMode);
  const transformSelection = useEditor((s) => s.transformSelection);
  const pushLog = useEditor((s) => s.pushLog);
  const setKernelStatus = useEditor((s) => s.setKernelStatus);
  const setKernelReady = useEditor((s) => s.setKernelReady);

  // -------------------------------------------------------------------------
  // Renderer bootstrap
  // -------------------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const r = new GlRenderer(canvas);
      rendererRef.current = r;
      sceneBufferRef.current = new SceneBuffer(0.05, 512);
      setReady(true);
    } catch (e) {
      setError((e as Error).message);
    }
    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
      sceneBufferRef.current?.dispose();
      sceneBufferRef.current = null;
    };
  }, []);

  // -------------------------------------------------------------------------
  // Kernel bootstrap
  // -------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    initKernel()
      .then((k) => {
        if (cancelled) return;
        setKernelReady(true);
        setKernelStatus(`WASM 内核 v${k.version()}`);
        pushLog(`几何内核已就绪 (Rust → WebAssembly v${k.version()})`);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setKernelReady(false);
        setKernelStatus('内核加载失败');
        pushLog(`✗ WASM 内核加载失败: ${e.message}`);
        pushLog('已切换到 TS 降级模式（捕捉与精确拾取精度下降）');
      });
    return () => {
      cancelled = true;
    };
  }, [pushLog, setKernelReady, setKernelStatus]);

  // -------------------------------------------------------------------------
  // Viewport sizing
  // -------------------------------------------------------------------------

  useEffect(() => {
    const container = containerRef.current;
    const renderer = rendererRef.current;
    if (!container || !renderer) return;

    const apply = (): void => {
      const rect = container.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      renderer.resize(rect.width, rect.height, dpr);
      setView({ width: rect.width, height: rect.height, dpr });
      dirtyRef.current = true;
    };

    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(container);
    window.addEventListener('resize', apply);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', apply);
    };
  }, [setView, ready]);

  // -------------------------------------------------------------------------
  // Coordinate helpers (use the live view from the store)
  // -------------------------------------------------------------------------

  const viewRef = useRef(view);
  viewRef.current = view;

  /**
   * Publish the model → screen mapping for the verification scripts.
   *
   * 硬编码屏幕坐标是个地雷：画布尺寸一变（工具栏收拢让出 28px 就够），
   * `zoomToFit` 的取景跟着变，量到的已经不是同一个圆了 —— 而错误会**伪装成
   * 描边断续**，看上去像是渲染坏了。暴露 view 之后，脚本就能用模型坐标
   * （「大圆圆心 30,40 半径 14」）描述要测的图元，与画布尺寸解耦。
   */
  useEffect(() => {
    (window as unknown as { __unicadView?: typeof view }).__unicadView = view;
  }, [view]);

  const toWorld = useCallback((screen: Vec2): Vec2 => {
    const v = viewRef.current;
    return {
      x: (screen.x - v.width / 2) * v.scale + v.center.x,
      y: (v.height / 2 - screen.y) * v.scale + v.center.y,
    };
  }, []);

  const localScreen = useCallback((ev: { clientX: number; clientY: number }): Vec2 => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }, []);

  // -------------------------------------------------------------------------
  // Snapping
  // -------------------------------------------------------------------------

  const computeSnap = useCallback(
    (rawWorld: Vec2, screen: Vec2, anchor: Vec2 | null): { point: Vec2; kind: ReturnType<typeof snapKindFromTag>; entityIndex: number } | null => {
      if (!isKernelReady()) return null;
      const v = viewRef.current;
      const settings = doc.settings;
      const snappable = doc.entities.filter(
        (e) => isSnappable(doc, e) && planeOf(e) === doc.activePlane,
      );
      if (snappable.length === 0) return null;

      const scene = packScene(snappable, () => true);
      const aperture = settings.snapAperturePx * v.scale;
      const mask = packOsnapMask(settings.osnapModes);
      const hit = snapQuery(scene, rawWorld, aperture, mask, anchor, 512);
      void screen;
      if (!hit.found) return null;
      const kind = snapKindFromTag(hit.kind);
      if (!kind) return null;
      // Map the kernel's index (into the filtered list) back to the entity array.
      const entity = snappable[hit.entity];
      const entityIndex = entity ? doc.entities.findIndex((e) => e.id === entity.id) : -1;
      return { point: { x: hit.x, y: hit.y }, kind, entityIndex };
    },
    [doc],
  );

  const anchorPoint = useCallback((): Vec2 | null => {
    // The tool's last placed point is the base for perpendicular/tangent snaps
    // and for the ortho/polar constraint.
    const t = (window as unknown as { __unicadToolAnchor?: Vec2 | null }).__unicadToolAnchor;
    return t ?? null;
  }, []);

  // -------------------------------------------------------------------------
  // Pointer handling
  // -------------------------------------------------------------------------

  const onPointerMove = useCallback(
    (ev: React.PointerEvent<HTMLDivElement>): void => {
      const screen = localScreen(ev);
      const rawWorld = toWorld(screen);
      setCursorScreen(screen);
      setCursorWorld(rawWorld);

      // ---- 3D: a drag orbits; no picking, snapping or tool events happen ----
      if (useEditor.getState().view3d) {
        const st = useEditor.getState();
        const drag = dragRef.current;
        if (drag.kind === 'orbit') {
          const dx = screen.x - drag.startScreen.x;
          const dy = screen.y - drag.startScreen.y;
          dragRef.current = { ...drag, startScreen: screen };
          const o = st.orbit;
          st.setOrbit({
            yaw: o.yaw - dx * 0.008,
            pitch: clampPitch(o.pitch + dy * 0.008),
          });
        }
        // The 3D counterpart of the 2D crosshair: where the mouse ray meets the
        // plane a sketch would go on. The status readout then reports that point
        // in the plane's own coordinates — the numbers a sketch here would use.
        const aspect = st.view.width / Math.max(1, st.view.height);
        const ndcX = (screen.x / Math.max(1, st.view.width)) * 2 - 1;
        const ndcY = 1 - (screen.y / Math.max(1, st.view.height)) * 2;
        // Which plane tile the mouse is over — the hover highlight, and the
        // target a click will offer as the base of a new datum plane.
        hoverPlaneRef.current = pickPlane(
          st.orbit, aspect, ndcX, ndcY, st.doc.planes, DATUM_SIZE / 2,
        );
        const plane = findPlane(st.doc, st.doc.activePlane);
        if (plane) {
          const hit = hitPlane(st.orbit, aspect, ndcX, ndcY, plane);
          cursor3dRef.current = hit;
          if (hit) {
            const along = (a: [number, number, number]): number =>
              (hit[0] - plane.origin[0]) * a[0] +
              (hit[1] - plane.origin[1]) * a[1] +
              (hit[2] - plane.origin[2]) * a[2];
            setCursorWorld({ x: along(plane.u), y: along(plane.v) });
          }
        } else {
          cursor3dRef.current = null;
        }
        dirtyRef.current = true;
        return;
      }

      const anchor = anchorPoint();
      const snap = computeSnap(rawWorld, screen, anchor);
      let effective = snap ? snap.point : rawWorld;

      // Apply grid / ortho / polar on top of the snap, but never override a
      // vertex snap — the user's explicit pick wins.
      const settings = doc.settings;
      const mode = CONSTRAINT_TAG[settings.constraint];
      if (settings.constraint !== 'none' && !snap && isKernelReady()) {
        effective = applyConstraints(effective, mode, settings.gridSpacing, anchor, 0.15);
      }

      setCursorEffective(effective);
      setSnap(
        snap && snap.kind
          ? { point: snap.point, kind: snap.kind, entityIndex: snap.entityIndex }
          : null,
      );
      setLocked(Boolean(anchor && settings.constraint !== 'none' && !snap));

      // --- drag handling ---
      const drag = dragRef.current;
      if (drag.kind === 'pan') {
        panBy(screen.x - drag.startScreen.x, screen.y - drag.startScreen.y);
        dragRef.current = { ...drag, startScreen: screen };
      } else if (drag.kind === 'move') {
        const delta: Vec2 = {
          x: effective.x - drag.startWorld.x,
          y: effective.y - drag.startWorld.y,
        };
        // Live-move: apply the delta from the pre-drag originals each frame so
        // the transform never accumulates rounding error.
        transformSelection((e) => {
          const original = drag.originals.find((o) => o.id === e.id);
          return original ? translateCopy(original, delta) : e;
        }, '__live_move');
        dragRef.current = { ...drag, lastWorld: effective };
        dirtyRef.current = true;
      } else if (drag.kind === 'window') {
        setMode('selecting');
        dirtyRef.current = true;
      } else {
        // Idle hover highlighting.
        highlightUnderCursor(screen, ev.ctrlKey || ev.shiftKey);
        dirtyRef.current = true;
      }

      // Publish the anchor for tools.
      (window as unknown as { __unicadCursor?: Vec2 }).__unicadCursor = effective;
      dirtyRef.current = true;
    },
    [
      computeSnap,
      doc,
      localScreen,
      panBy,
      setCursorEffective,
      setCursorScreen,
      setCursorWorld,
      setLocked,
      setMode,
      setSnap,
      toWorld,
      transformSelection,
      anchorPoint,
    ],
  );

  const highlightUnderCursor = useCallback(
    (screen: Vec2, additive: boolean): void => {
      void additive;
      // Nothing to highlight until the kernel is live; `pickAll` needs it.
      if (!isKernelReady()) return;
      const v = viewRef.current;
      const world = toWorld(screen);
      const pickable = doc.entities.filter(
        (e) => isPickable(doc, e) && planeOf(e) === doc.activePlane,
      );
      if (pickable.length === 0) {
        setHover(null);
        return;
      }
      const scene = packScene(pickable, () => true);
      const tol = doc.settings.pickAperturePx * v.scale;
      const hits = pickAll(scene, world, tol, 512);
      if (hits.length === 0) {
        setHover(null);
        return;
      }
      const best = pickable[hits[0]!.index];
      setHover(best?.id ?? null);
    },
    [doc, setHover, toWorld],
  );

  const onPointerDown = useCallback(
    (ev: React.PointerEvent<HTMLDivElement>): void => {
      const screen = localScreen(ev);
      const world = toWorld(screen);
      (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);

      // In 3D the canvas has no tools: a drag anywhere turntables the camera.
      // Nothing is picked, so the whole 2D branch below is skipped rather than
      // guarded piecemeal.
      if (useEditor.getState().view3d) {
        const st = useEditor.getState();
        const aspect = st.view.width / Math.max(1, st.view.height);
        const ndcX = (screen.x / Math.max(1, st.view.width)) * 2 - 1;
        const ndcY = 1 - (screen.y / Math.max(1, st.view.height)) * 2;
        // Remember what was under the pointer: if this turns out to be a click
        // rather than a drag, it becomes "base the new plane on this one".
        const hovered = pickPlane(st.orbit, aspect, ndcX, ndcY, st.doc.planes, DATUM_SIZE / 2);
        clickPlaneRef.current = hovered ? { plane: hovered, screen: { x: screen.x, y: screen.y } } : null;
        dragRef.current = { ...EMPTY_DRAG, kind: 'orbit', startScreen: screen, startWorld: world };
        setMode('panning');
        return;
      }

      const activeTool = useEditor.getState().activeTool;

      // Middle button always pans, regardless of the active tool.
      if (ev.button === 1 || (ev.button === 0 && ev.altKey)) {
        dragRef.current = { ...EMPTY_DRAG, kind: 'pan', startScreen: screen, startWorld: world };
        setMode('panning');
        return;
      }

      if (ev.button === 2) {
        // 右键现在是饼菜单的手势（见 onContextMenu）：「结束/取消」在饼里，
        // 走的是同一个 `unicad:right-click` 事件，所以工具那边的语义不用改。
        return;
      }

      if (ev.button !== 0) return;

      // Let the active tool consume the click first.
      const consumed = window.dispatchEvent(
        new CustomEvent('unicad:click', {
          detail: { world, screen, shift: ev.shiftKey, ctrl: ev.ctrlKey },
          cancelable: true,
        }),
      );
      // `dispatchEvent` returns false when a listener called preventDefault().
      if (!consumed) return;

      if (activeTool !== 'select') return;
      // `pickAll` runs in the kernel; skip silently if it is not up yet.
      if (!isKernelReady()) return;

      // ---- selection tool behaviour ----
      const pickable = doc.entities.filter(
        (e) => isPickable(doc, e) && planeOf(e) === doc.activePlane,
      );
      const scene = packScene(pickable, () => true);
      const tol = doc.settings.pickAperturePx * viewRef.current.scale;
      const hits = pickAll(scene, world, tol, 512);

      if (hits.length > 0) {
        const hitEntity = pickable[hits[0]!.index];
        if (!hitEntity) return;
        const additive = ev.shiftKey || ev.ctrlKey;
        if (additive) {
          toggleSelect(hitEntity.id);
        } else if (!selection.has(hitEntity.id)) {
          select([hitEntity.id]);
        }
        // Begin a move drag on the current selection set.
        const current = useEditor.getState();
        // 完全定义模式：整张草图进入只读态——ROADMAP 0.4 的语义是「开启后
        // 拖不动」，不挑图元（受不受约束都锁）。选中仍然允许（查看 + 改尺寸）。
        if (current.fullyConstrained) {
          pushLog('完全定义模式：拖动已锁定，请通过尺寸修改驱动');
          return;
        }
        const originals = current.doc.entities
          .filter((e) => current.selection.has(e.id))
          .map((e) => structuredClone(e));
        dragRef.current = {
          ...EMPTY_DRAG,
          kind: 'move',
          startScreen: screen,
          startWorld: world,
          lastWorld: world,
          originals,
        };
        setMode('selecting');
        return;
      }

      // Empty space → start a rubber-band window selection.
      if (!ev.shiftKey && !ev.ctrlKey) clearSelection();
      dragRef.current = {
        ...EMPTY_DRAG,
        kind: 'window',
        startScreen: screen,
        startWorld: world,
        lastWorld: world,
        additive: ev.shiftKey || ev.ctrlKey,
      };
      setMode('selecting');
    },
    [clearSelection, doc, localScreen, select, selection, setMode, toWorld, toggleSelect],
  );

  const onPointerUp = useCallback(
    (ev: React.PointerEvent<HTMLDivElement>): void => {
      const screen = localScreen(ev);
      const world = toWorld(screen);
      const drag = dragRef.current;

      if (drag.kind === 'pan') {
        dragRef.current = { ...EMPTY_DRAG };
        setMode('idle');
        return;
      }

      if (drag.kind === 'move') {
        const delta: Vec2 = { x: world.x - drag.startWorld.x, y: world.y - drag.startWorld.y };
        // Roll the live preview back, then commit a single clean command.
        transformSelection((e) => {
          const original = drag.originals.find((o) => o.id === e.id);
          return original ? structuredClone(original) : e;
        }, '__revert_live_move');

        const moved = Math.hypot(delta.x, delta.y) > 1e-9;
        if (moved) {
          transformSelection((e) => translateCopy(e, delta), `移动 ${drag.originals.length} 个对象`);
          pushLog(`已移动 ${drag.originals.length} 个对象 (Δ ${delta.x.toFixed(2)}, ${delta.y.toFixed(2)})`);
        }
        dragRef.current = { ...EMPTY_DRAG };
        setMode('idle');
        dirtyRef.current = true;
        return;
      }

      if (drag.kind === 'window') {
        const movedEnough =
          Math.abs(screen.x - drag.startScreen.x) > 3 || Math.abs(screen.y - drag.startScreen.y) > 3;
        if (movedEnough && isKernelReady()) {
          const crossing = world.x < drag.startWorld.x; // AutoCAD: right-to-left = crossing
          const pickable = doc.entities.filter(
        (e) => isPickable(doc, e) && planeOf(e) === doc.activePlane,
      );
          const scene = packScene(pickable, () => true);
          const indices = selectInRect(scene, drag.startWorld, world, crossing);
          const ids = indices.map((i) => pickable[i]?.id).filter((x): x is string => Boolean(x));
          if (ids.length > 0) {
            select(ids, drag.additive);
            pushLog(`选择了 ${ids.length} 个对象${crossing ? '（交叉窗口）' : '（窗口）'}`);
          }
        }
        dragRef.current = { ...EMPTY_DRAG };
        setMode('idle');
        dirtyRef.current = true;
        return;
      }

      if (drag.kind === 'orbit') {
        const moved =
          Math.abs(screen.x - drag.startScreen.x) > 3 || Math.abs(screen.y - drag.startScreen.y) > 3;
        const clicked = clickPlaneRef.current;
        // A click rather than a drag: offer that plane as the base of a new
        // datum plane. Dragging still orbits and offers nothing.
        if (!moved && clicked) {
          setDatumBase(clicked.plane.id);
          pushLog(`已选中 ${clicked.plane.name} 作为新基准面的基准`);
        }
        clickPlaneRef.current = null;
        dragRef.current = { ...EMPTY_DRAG };
        setMode('idle');
        dirtyRef.current = true;
        return;
      }

      dragRef.current = { ...EMPTY_DRAG };
    },
    [doc, localScreen, pushLog, select, setDatumBase, setMode, toWorld, transformSelection],
  );

  const onWheel = useCallback(
    (ev: React.WheelEvent<HTMLDivElement>): void => {
      const screen = localScreen(ev);
      if (useEditor.getState().view3d) {
        // In 3D the wheel dollies the eye rather than the 2D zoom factor:
        // scaling the perspective camera's distance is what "zoom" means there.
        const o = useEditor.getState().orbit;
        const next = Math.max(5, Math.min(40000, o.distance * Math.pow(0.999, -ev.deltaY)));
        useEditor.getState().setOrbit({ distance: next });
        dirtyRef.current = true;
        return;
      }
      // Ctrl+wheel and plain wheel both zoom — CAD users expect either.
      const factor = Math.pow(0.999, ev.deltaY);
      zoomAt(screen, factor);
      dirtyRef.current = true;
    },
    [localScreen, zoomAt],
  );

  const onDoubleClick = useCallback(
    (ev: React.MouseEvent<HTMLDivElement>): void => {
      const screen = localScreen(ev);
      const world = toWorld(screen);
      window.dispatchEvent(new CustomEvent('unicad:dblclick', { detail: { world, screen } }));
    },
    [localScreen, toWorld],
  );

  const onContextMenu = useCallback((ev: React.MouseEvent): void => {
    ev.preventDefault();
    // 饼菜单的手势入口。拖动中不弹（正在画/正在移的时候右键只可能是误触）。
    if (dragRef.current.kind !== 'none') return;
    // **窗口坐标**：饼渲染在 body 的 portal 里、用 position: fixed 定位，从此不受
    // 画布宿主 `overflow: hidden` 的裁剪，也不必跟着画布的缩放平移换算。
    setPie({ x: ev.clientX, y: ev.clientY, world: toWorld(localScreen(ev)) });
  }, [localScreen, toWorld]);

  /**
   * 双击一条**可改值**的尺寸标注 → 就地编辑（0.2）。
   *
   * 标注池里的每个节点带着 `dataset.entity` / `dataset.field`（见 `syncDimLayer`），
   * 所以这里只认「哪条曲线的哪一行」，值怎么显示、怎么落成几何、写成哪种约束，
   * 全都去 `props.ts` 那张表里查（`propField`）——和左栏属性面板**同一份规则**。
   */
  const onDimDoubleClick = useCallback((ev: React.MouseEvent<HTMLDivElement>): void => {
    const node = (ev.target as HTMLElement).closest('.dim-label') as HTMLElement | null;
    const entityId = node?.dataset['entity'];
    const fieldKey = node?.dataset['field'];
    if (!node || !entityId || !fieldKey) return;
    // 画布自己也听双击（工具用它收尾）：落在标注上的一次双击只属于标注。
    ev.stopPropagation();
    ev.preventDefault();

    const state = useEditor.getState();
    const entity = state.doc.entities.find((e) => e.id === entityId);
    if (!entity) return;
    const field = propField(entity, state.doc, fieldKey);
    if (!field || typeof field.value !== 'number') return;

    const x = Number.parseFloat(node.style.getPropertyValue('--dx')) || 0;
    const y = Number.parseFloat(node.style.getPropertyValue('--dy')) || 0;
    setDimDraft({
      entity: entityId,
      fieldKey,
      label: field.label,
      x,
      y,
      text: String(field.value),
    });
  }, []);

  /** 提交草稿：与左栏属性面板走**同一个**动作（写约束 → 解算 → 一条命令回写）。 */
  const commitDimDraft = useCallback((): void => {
    const draft = dimDraft;
    setDimDraft(null);
    if (!draft) return;
    if (dimCancelRef.current) {
      dimCancelRef.current = false;
      return;
    }
    const raw = Number(draft.text.trim());
    if (!Number.isFinite(raw) || !(raw > 0)) {
      pushLog('尺寸必须大于 0');
      return;
    }
    const state = useEditor.getState();
    const entity = state.doc.entities.find((e) => e.id === draft.entity);
    const field = entity ? propField(entity, state.doc, draft.fieldKey) : undefined;
    const dim = field?.dimension;
    if (!field || !dim || !field.applyTo) return;
    state.setDimensionAction(
      draft.entity,
      dim.kind,
      dim.toValue(raw),
      (e) => field.applyTo!(e, raw),
      `改尺寸: ${field.label} = ${raw}`,
    );
  }, [dimDraft, pushLog]);

  // -------------------------------------------------------------------------
  // Render loop
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!ready) return;
    let running = true;

    /**
     * Mesh cache, keyed by solid.
     *
     * A solid's triangles depend on exactly three things: the sketch it points
     * at, its height, and the plane that sketch sits on. All three are held **by
     * reference** — a document edit replaces the entity, and a plane edit
     * replaces the plane — so identity checks notice every change and no
     * per-frame `JSON.stringify` ever has to run.
     */
    const meshCache = new Map<
      string,
      { src: Entity | undefined; height: number; plane: DocPlane | undefined; verts: Float32Array }
    >();

    /** Build (or reuse) each solid's triangles and hand them to the 3D pass. */
    const drawSolids = (
      renderer: GlRenderer,
      state: ReturnType<typeof useEditor.getState>,
    ): void => {
      const { doc, orbit, view } = state;
      const items: Array<{ verts: Float32Array; color: [number, number, number] }> = [];
      const live = new Set<string>();
      for (const solid of doc.solids) {
        live.add(solid.id);
        const src = doc.entities.find((e) => e.id === solid.source);
        // The solid inherits its plane from the sketch, so there is nothing to
        // store on the solid itself — move the sketch to another plane and the
        // solid moves with it.
        const plane = src ? findPlane(doc, planeOf(src)) : undefined;
        let entry = meshCache.get(solid.id);
        if (
          !entry ||
          entry.src !== src ||
          entry.height !== solid.height ||
          entry.plane !== plane
        ) {
          const verts =
            src && plane ? extrudeMesh(src, solid.height, planeFrame(plane)) : null;
          entry = {
            src,
            height: solid.height,
            plane,
            verts: verts ?? new Float32Array(0),
          };
          meshCache.set(solid.id, entry);
        }
        if (!src || entry.verts.length === 0) continue;
        const layer = doc.layers.find((l) => l.id === solid.layer);
        const [r, g, b] = hexToRgba(layer?.color ?? '#c9ced8', 1);
        items.push({ verts: entry.verts, color: [r, g, b] });
      }
      // Forget solids that were deleted, so a long session cannot leak meshes.
      for (const id of [...meshCache.keys()]) if (!live.has(id)) meshCache.delete(id);

      renderer.drawMeshes(items, viewProj(orbit, view.width / Math.max(1, view.height)));
    };

    /** X red, Y green, Z blue — the universal convention, not a house style. */
    const AXIS_COLORS: Array<[number, number, number]> = [
      [0.94, 0.35, 0.35],
      [0.32, 0.84, 0.45],
      [0.36, 0.6, 1.0],
    ];
    const DATUM_COLOR: [number, number, number] = [0.42, 0.48, 0.58];
    /** The plane the「新建基准面」flow is basing on, drawn brighter than the rest. */
    const BASE_COLOR: [number, number, number] = [0.19, 0.45, 0.72];
    /** Crosshair size on the plane, model units. */
    const CURSOR_SIZE = 14;
    const CURSOR_COLOR: [number, number, number] = [0.31, 0.64, 1];

    /**
     * Draw the datum planes and coordinate triads.
     *
     * Planes are drawn as an outline plus the two in-plane axes through the
     * origin, not as a filled quad: a fill would fight the solids for the same
     * pixels and, being translucent, would sort badly against itself where two
     * planes cross. The outline says exactly as much and never occludes.
     */
    const drawDatums = (
      renderer: GlRenderer,
      state: ReturnType<typeof useEditor.getState>,
    ): void => {
      const { doc } = state;
      const items: Array<{ verts: Float32Array; color: [number, number, number] }> = [];
      const half = DATUM_SIZE / 2;

      const hoverId = hoverPlaneRef.current?.id ?? null;
      const baseId = state.datumBase;
      for (const p of doc.planes) {
        if (!p.visible) continue;
        const corner = (su: number, sv: number): [number, number, number] => [
          p.origin[0] + p.u[0] * su * half + p.v[0] * sv * half,
          p.origin[1] + p.u[1] * su * half + p.v[1] * sv * half,
          p.origin[2] + p.u[2] * su * half + p.v[2] * sv * half,
        ];
        const c = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
        const verts: number[] = [];
        for (let i = 0; i < 4; i++) verts.push(...c[i]!, ...c[(i + 1) % 4]!);
        // The plane's own two axes, so its orientation is readable, not just its
        // extent.
        verts.push(...corner(-1, 0), ...corner(1, 0));
        verts.push(...corner(0, -1), ...corner(0, 1));
        // Hover wins over the selected base: the cursor is the most immediate
        // promise the picture makes, and it must never be ambiguous.
        const color: [number, number, number] =
          p.id === hoverId ? CURSOR_COLOR : p.id === baseId ? BASE_COLOR : DATUM_COLOR;
        items.push({ verts: Float32Array.from(verts), color });
      }

      // Triads: the world frame plus any user-made ones.
      for (const f of doc.frames) {
        if (!f.visible) continue;
        const z: [number, number, number] = [
          f.xAxis[1] * f.yAxis[2] - f.xAxis[2] * f.yAxis[1],
          f.xAxis[2] * f.yAxis[0] - f.xAxis[0] * f.yAxis[2],
          f.xAxis[0] * f.yAxis[1] - f.xAxis[1] * f.yAxis[0],
        ];
        const axes: Array<[number, number, number]> = [f.xAxis, f.yAxis, z];
        for (let i = 0; i < 3; i++) {
          const a = axes[i]!;
          items.push({
            verts: Float32Array.from([
              f.origin[0],
              f.origin[1],
              f.origin[2],
              f.origin[0] + a[0] * AXIS_LEN,
              f.origin[1] + a[1] * AXIS_LEN,
              f.origin[2] + a[2] * AXIS_LEN,
            ]),
            color: AXIS_COLORS[i]!,
          });
        }
      }

      renderer.drawLines3d(
        items,
        viewProj(state.orbit, state.view.width / Math.max(1, state.view.height)),
      );
    };

    /** Grid extent in model units — generous, since the camera dollies freely. */
    const GRID_EXTENT = 900;
    /** Cap the line count: a zoomed-out view would otherwise emit thousands. */
    const GRID_MAX_LINES = 150;
    /** Axis triad arm length, model units. */
    const AXIS_LEN = 48;

    /**
     * The 2D grid, drawn on the **active datum plane**.
     *
     * Spacing coarsens by doubling until the pass stays bounded — the same idea
     * as the 2D grid's adaptive spacing, driven by a line count instead of a
     * pixel width, because in 3D the zoom level is a distance.
     */
    const drawGrid3d = (renderer: GlRenderer, state: ReturnType<typeof useEditor.getState>): void => {
      const plane = findPlane(state.doc, state.doc.activePlane);
      if (!plane || !plane.visible) return;
      let spacing = state.doc.settings.gridSpacing;
      if (!(spacing > 1e-6)) return;
      while (GRID_EXTENT / spacing > GRID_MAX_LINES) spacing *= 2;

      const at = (du: number, dv: number): [number, number, number] => [
        plane.origin[0] + plane.u[0] * du + plane.v[0] * dv,
        plane.origin[1] + plane.u[1] * du + plane.v[1] * dv,
        plane.origin[2] + plane.u[2] * du + plane.v[2] * dv,
      ];
      const minor: number[] = [];
      const major: number[] = [];
      const n = Math.ceil(GRID_EXTENT / spacing);
      for (let i = -n; i <= n; i++) {
        const o = i * spacing;
        const sink = i % 5 === 0 ? major : minor;
        sink.push(...at(o, -GRID_EXTENT), ...at(o, GRID_EXTENT));
        sink.push(...at(-GRID_EXTENT, o), ...at(GRID_EXTENT, o));
      }
      const items = [
        { verts: Float32Array.from(minor), color: [0.13, 0.15, 0.19] as [number, number, number] },
        { verts: Float32Array.from(major), color: [0.21, 0.24, 0.3] as [number, number, number] },
      ];
      renderer.drawLines3d(
        items,
        viewProj(state.orbit, state.view.width / Math.max(1, state.view.height)),
      );
    };

    /**
     * The mouse, drawn where it actually is: a crosshair on the active plane at
     * the point the mouse ray hits. Accent-coloured rather than shaded, so it
     * reads as a cursor and never as geometry.
     */
    const drawCursor3d = (
      renderer: GlRenderer,
      state: ReturnType<typeof useEditor.getState>,
      hit: [number, number, number],
    ): void => {
      const plane = findPlane(state.doc, state.doc.activePlane);
      if (!plane) return;
      const along = (a: [number, number, number]): number =>
        (hit[0] - plane.origin[0]) * a[0] +
        (hit[1] - plane.origin[1]) * a[1] +
        (hit[2] - plane.origin[2]) * a[2];
      const hu = along(plane.u);
      const hv = along(plane.v);
      const at = (du: number, dv: number): [number, number, number] => [
        plane.origin[0] + plane.u[0] * (hu + du) + plane.v[0] * (hv + dv),
        plane.origin[1] + plane.u[1] * (hu + du) + plane.v[1] * (hv + dv),
        plane.origin[2] + plane.u[2] * (hu + du) + plane.v[2] * (hv + dv),
      ];
      const items = [
        {
          verts: Float32Array.from([
            ...at(-CURSOR_SIZE, 0),
            ...at(CURSOR_SIZE, 0),
            ...at(0, -CURSOR_SIZE),
            ...at(0, CURSOR_SIZE),
          ]),
          color: CURSOR_COLOR,
        },
      ];
      renderer.drawLines3d(
        items,
        viewProj(state.orbit, state.view.width / Math.max(1, state.view.height)),
      );
    };

    /**
     * One draw pass. Kept as a separate closure so `frame` can wrap it in a
     * try/catch — a geometry trap must not kill the animation loop.
     */
    const drawFrame = (renderer: GlRenderer, sb: SceneBuffer): void => {
      const state = useEditor.getState();
      const v = state.view;
      const d = state.doc;

      renderer.beginFrame('#14161a');

      // ---- 3D solids ------------------------------------------------------
      // Its own pass, and the 2D batch is skipped while it runs: the two live in
      // different spaces (clip NDC vs. a perspective MVP) and the 2D stroke
      // shader carries no depth to sort with. Toggling back to 2D leaves `view`
      // untouched, so the drawing is framed exactly as it was left.
      if (state.view3d) {
        drawGrid3d(renderer, state);
        drawDatums(renderer, state);
        drawSolids(renderer, state);
        const cur = cursor3dRef.current;
        if (cur) drawCursor3d(renderer, state, cur);
        return;
      }

      // One batch for the whole frame. `buildLineBatch` appends, so the order of
      // the calls below *is* the paint order: grid first (bottom), entities in
      // the middle, interactive overlays on top.
      renderer.beginLineBatch();

      // 线型图案以屏幕像素定义，所以交出去的弧长必须先换算。`view.scale` 是
      // 「一个 CSS 像素等于多少模型单位」，取倒数即得 px/单位。
      const pxPerModel = 1 / v.scale;

      // 模型 → 裁剪空间。这里刻意不内联公式：曾经有三份各自抄写的副本，
      // 其中唯一被真正使用的那份把 y 的符号写反，于是整幅场景相对光标垂直镜像，
      // 而控制台一句错都不报。
      const viewArr: Mat = clipMatrixOf(v);

      // ---- grid ----
      const gridLines = buildGrid(
        {
          visibleBounds: () => ({
            minX: v.center.x - (v.width / 2) * v.scale,
            minY: v.center.y - (v.height / 2) * v.scale,
            maxX: v.center.x + (v.width / 2) * v.scale,
            maxY: v.center.y + (v.height / 2) * v.scale,
          }),
        } as unknown as Parameters<typeof buildGrid>[0],
        {
          visible: state.gridVisible,
          spacing: d.settings.gridSpacing,
          subdivisions: d.settings.gridSubdivisions,
          majorColor: '#2c313a',
          minorColor: '#1e2228',
          axisXColor: '#5a3a3a',
          axisYColor: '#3a5a3a',
        },
      );

      if (gridLines.length > 0) {
        const gp: Float32Array = new Float32Array(gridLines.length * 4);
        for (let i = 0; i < gridLines.length; i++) {
          const l = gridLines[i]!;
          gp[i * 4] = l.a.x;
          gp[i * 4 + 1] = l.a.y;
          gp[i * 4 + 2] = l.b.x;
          gp[i * 4 + 3] = l.b.y;
        }
        const gstrips = new Uint32Array(gridLines.length * 2);
        for (let i = 0; i < gridLines.length; i++) {
          gstrips[i * 2] = i * 2;
          gstrips[i * 2 + 1] = i * 2 + 2;
        }
        const gstyles = gridLines.map((l) => ({
          color: l.color,
          width: l.width,
          dash: null,
        }));
        renderer.buildLineBatch(gp, gstrips, gstyles, pxPerModel);
      }

      // ---- entities ----
      // 镶嵌容差必须按屏幕像素给：固定的模型单位容差在高缩放下会切出大量不足
      // 一像素的小段，圆弧会渲染成串珠。
      //
      // 0.25 px 是「肉眼看不出折线」与「别为一条圆切出几百段」的平衡点。它同时
      // 决定了接缝的夹角：弦长 ≈ 2·√(2·r·tol)，容差越小接缝越密、每个接缝越平，
      // 斜接法线也就越接近公共法线。
      sb.setScreenTolerance(0.25, v.scale);

      // Only the active plane's sketches are drawn. An entity on another plane
      // has no position in this 2D view at all — drawing it would put its `(u, v)`
      // on top of unrelated coordinates, so switching planes is a clean slate
      // rather than an overlay of things that are not really there.
      const visible = d.entities.filter(
        (e) => isVisible(d, e) && planeOf(e) === d.activePlane,
      );
      const scene = packScene(visible, (e) => isSnappable(d, e));
      const tess = visible.length > 0 ? sb.run(scene) : { vertices: new Float32Array(0), strips: new Uint32Array(0) };

      const styles: Array<RenderStyle | null> = visible.map((e: Entity) => {
        const st = state.selection.has(e.id);
        const hv = state.hover === e.id;
        const report = state.constraintReport;
        return resolveRenderStyle(d, e, {
          selected: st,
          hovered: hv,
          // 冲突图元画警示红（0.3）：约束互相矛盾时，先让人看见是哪几条曲线。
          conflicting: report?.conflictingEntities.has(e.id) ?? false,
          // 约束状态配色（0.3）：还缺尺寸/方位的图元画欠定义蓝——默认关，见 store 字段注释。
          underDefined: state.sketchColors && isUnderDefined(report?.freeModes.get(e.id)),
        });
      });

      renderer.buildLineBatch(tess.vertices, tess.strips, styles, pxPerModel);

      // ---- overlays ----
      const overlayPoints: Array<{ x: number; y: number; color: string; size: number }> = [];
      const overlaySegs: OverlaySegment[] = [];
      // 标记尺寸统一用 CSS 像素：它们是给眼睛看的，不该随缩放变小。
      const markerPx = 7;

      // 起点/终点标色：绿=起、红=终，帮用户看清方向与命名点位置。
      if (state.endpointsVisible) {
        overlayPoints.push(...endpointMarkers(visible, markerPx * 0.85));
      }

      // Selection grips.
      for (const e of d.entities) {
        if (!state.selection.has(e.id)) continue;
        for (const p of gripPoints(e)) {
          overlayPoints.push(...snapMarker(p, 'endpoint', markerPx));
        }
      }

      // Hover / snap marker.
      if (state.cursor.snap) {
        const s = state.cursor.snap;
        overlayPoints.push(...snapMarker(s.point, s.kind, markerPx * 1.15));
      }

      // Rubber band + measurement from the active tool.
      const anchor = (window as unknown as { __unicadToolAnchor?: Vec2 | null }).__unicadToolAnchor ?? null;
      const toolPreview = (window as unknown as { __unicadPreview?: {
        segments: Array<{ a: Vec2; b: Vec2; color?: string }>;
        points: Array<{ p: Vec2; kind: string }>;
        /** 工具的实时读数（长度/半径/角度…），见 `PreviewGeometry.readout`。 */
        readout?: string;
      } | null }).__unicadPreview;
      if (toolPreview) {
        for (const s of toolPreview.segments) {
          overlaySegs.push({
            a: s.a,
            b: s.b,
            color: s.color ?? UI_COLORS.preview,
            width: 1.6,
            dash: null,
          });
        }
        for (const p of toolPreview.points) {
          overlayPoints.push({ x: p.p.x, y: p.p.y, color: UI_COLORS.hover, size: markerPx });
        }
      }

      if (dragRef.current.kind === 'window') {
        overlaySegs.push(
          ...selectionWindow(dragRef.current.startWorld, state.cursor.effective, state.cursor.world.x < dragRef.current.startWorld.x),
        );
      }

      // ---- 自动尺寸 ----
      //
      // 两条来源共用一个 DOM 覆盖层：工具算好的实时读数（绘制中），以及每个
      // 选中图元自己的尺寸。几何并进上面的 overlay 批次，文字交给 dim layer。
      const dimLabels: DimLabel[] = [];
      // 模型 → 屏幕。和 toWorld 严格互逆，系数取自同一份 view。
      // 标注与约束标记共用这一个换算器，所以它必须**无条件**建出来 ——
      // 以前它被塞在 `if (dimsVisible)` 里面，约束标记就会在「尺寸关掉」时
      // 跟着一起消失，而这两件事用户明明是分开开关的。
      const dimCtx: DimContext = {
        scale: v.scale,
        viewWidth: v.width,
        viewHeight: v.height,
        screenOf: (p: Vec2) => ({
          x: (p.x - v.center.x) / v.scale + v.width / 2,
          y: v.height / 2 - (p.y - v.center.y) / v.scale,
        }),
      };

      if (state.dimsVisible) {
        const readout = toolPreview?.readout;
        if (anchor && readout) {
          const live = liveDimension(anchor, state.cursor.effective, readout, dimCtx);
          overlaySegs.push(...live.segments);
          dimLabels.push(...live.labels);
        }

        // 只标注**可见**的图元：隐藏图层上的对象没有画出来，给它标尺寸只会
        // 让人找不到那条尺寸线指的是谁。
        const sel = selectedDimensions(visible, state.selection, dimCtx);
        overlaySegs.push(...sel.segments);
        dimLabels.push(...sel.labels);
      }

      if (state.constraintsVisible) {
        // 距离类约束的解空间引导：选中时画出点被钉住的圆/轴线。
        overlaySegs.push(...constraintGuides(d, state.selection, visible));
        dimLabels.push(...constraintBadges(d, state.selection, visible, dimCtx));
        // 欠约束方向（0.3）：选中图元还能往哪动——十字箭头=可平移，⟳=可转，
        // ⤢=尺寸未定。与徽章同一规矩：只画选中的、可见的。
        if (state.constraintReport) {
          const marks = dofMarkers(
            visible,
            state.selection,
            state.constraintReport.freeModes,
            visible,
            dimCtx,
          );
          overlaySegs.push(...marks.segments);
          dimLabels.push(...marks.labels);
        }
      }
      syncDimLayer(dimLayerRef.current, dimLabels);

      // Crosshair.
      if (state.mode === 'drawing' || state.mode === 'idle') {
        const short = Boolean(state.cursor.snap);
        overlaySegs.push(...crosshair(state.cursor.screen, v.width, v.height, toWorld, !short));
      }

      if (overlaySegs.length > 0) {
        const { positions, widths } = segmentsToVertices(overlaySegs);
        const strips = new Uint32Array(overlaySegs.length * 2);
        for (let i = 0; i < overlaySegs.length; i++) {
          strips[i * 2] = i * 2;
          strips[i * 2 + 1] = i * 2 + 2;
        }
        void widths;
        const styles2 = overlaySegs.map((s) => ({
          color: s.color,
          width: s.width,
          dash: s.dash,
        }));
        renderer.buildLineBatch(positions, strips, styles2, pxPerModel);
      }

      // ---- one submission for grid + entities + overlays ----
      renderer.drawLines(viewArr, v.width, v.height);

      if (overlayPoints.length > 0) {
        renderer.drawPoints(overlayPoints, viewArr);
      }

      // Scale bar.
      if (rafRef.current % 30 === 0) {
        const major = adaptiveGridSpacing(d.settings.gridSpacing, v.scale);
        setScaleBar(`栅格 ${major.toPrecision(3)} ${d.settings.units}`);
      }

      dirtyRef.current = false;
    };

    const frame = (): void => {
      if (!running) return;
      // Schedule the next frame *first* so a throw below cannot silently kill
      // the render loop and leave the canvas frozen.
      rafRef.current = requestAnimationFrame(frame);
      const renderer = rendererRef.current;
      const sb = sceneBufferRef.current;
      if (!renderer || !sb) return;

      try {
        drawFrame(renderer, sb);
      } catch (err) {
        // Geometry problems must not take the whole viewport down. Report once
        // per session and keep animating (the next frame usually recovers).
        if (!frameErrorRef.current) {
          frameErrorRef.current = true;
          console.error('uniCAD: 渲染帧异常', err);
        }
      }
    };

    rafRef.current = requestAnimationFrame(frame);
    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [ready, toWorld]);

  // -------------------------------------------------------------------------
  // Cursor style
  // -------------------------------------------------------------------------

  const cursorStyle = useMemo((): string => {
    const mode = useEditor.getState().mode;
    if (mode === 'panning') return 'grabbing';
    return 'none';
  }, []);

  if (error) {
    return (
      <div className="canvas-error">
        <h2>无法初始化 WebGL2</h2>
        <p>{error}</p>
        <p className="hint">请使用较新版本的 Chrome / Edge / Firefox，并确认已启用硬件加速。</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="canvas-host"
      style={{ cursor: cursorStyle }}
      onPointerMove={onPointerMove}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setHover(null)}
      onWheel={onWheel}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <canvas ref={canvasRef} className="canvas-gl" />
      <div className="dim-layer" ref={dimLayerRef} onDoubleClick={onDimDoubleClick} aria-hidden />
      {pie &&
        createPortal(
          <>
            {/* 背板：饼开着时吞掉落在任何地方的点击（否则等于"点哪儿画哪儿"）。 */}
            <div className="pie-backdrop" onPointerDown={() => setPie(null)} />
            <PieMenu
              at={{ x: pie.x, y: pie.y }}
              sectors={buildPieMenu({
                doc,
                selected: doc.entities.filter((e) => selection.has(e.id)),
                activeTool,
                view3d,
                report: constraintReport,
              })}
              onRun={(action) => {
                runPieAction(action, useEditor.getState(), pie.world);
                setPie(null);
              }}
              onClose={() => setPie(null)}
            />
          </>,
          document.body,
        )}
      {dimDraft && (
        <input
          className="dim-edit"
          autoFocus
          value={dimDraft.text}
          title={`改${dimDraft.label}（Enter 提交 · Esc 取消）`}
          style={{
            ['--dx' as string]: `${Math.round(dimDraft.x)}px`,
            ['--dy' as string]: `${Math.round(dimDraft.y)}px`,
          }}
          onChange={(ev) => setDimDraft({ ...dimDraft, text: ev.target.value })}
          onBlur={commitDimDraft}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') {
              ev.preventDefault();
              ev.currentTarget.blur();
            } else if (ev.key === 'Escape') {
              ev.preventDefault();
              dimCancelRef.current = true;
              ev.currentTarget.blur();
            }
          }}
          // 输入框上的指针 / 滚轮 / 双击都不该漏给画布（否则会顺手开始框选或缩放）。
          onPointerDown={(ev) => ev.stopPropagation()}
          onPointerUp={(ev) => ev.stopPropagation()}
          onWheel={(ev) => ev.stopPropagation()}
          onDoubleClick={(ev) => ev.stopPropagation()}
        />
      )}
      <div className="canvas-hud">
        <span className="hud-item">{scaleBar}</span>
        {!kernelReady && <span className="hud-item warn">TS 降级模式</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mirror the dimension labels into the DOM layer, reusing nodes.
 *
 * Deliberately imperative: this runs **every frame** (the live readout follows
 * the cursor), and it runs from inside the rAF loop where no React render is in
 * flight. Doing it with state would mean a full component re-render per frame;
 * doing it with a naive `innerHTML = ...` would rebuild every node per frame and
 * make the labels flicker as the browser re-parses them.
 *
 * So: a pool of `<span>`s. Grow to fit, hide the surplus, and only touch
 * `textContent` / the CSS variables when they actually changed — the pooled
 * nodes persist across frames, which is what keeps the browser from
 * re-parsing (and flickering) the text 60 times a second.
 *
 * Position goes through CSS variables rather than a composed `transform`
 * string so the `translate(-50%, -50%)` centring stays in the stylesheet.
 */
function syncDimLayer(layer: HTMLDivElement | null, labels: readonly DimLabel[]): void {
  if (!layer) return;
  const pool = layer.children;

  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]!;
    let node = pool[i] as HTMLElement | undefined;
    if (!node) {
      node = document.createElement('span');
      layer.appendChild(node);
    }
    // 可改值的标注多一个修饰类：它要接收指针事件（双击进编辑），
    // 而 `.dim-layer` 整层是 `pointer-events: none`。
    const cls = `dim-label ${l.kind}${l.edit ? ' editable' : ''}`;
    if (node.className !== cls) node.className = cls;
    if (node.textContent !== l.text) node.textContent = l.text;
    // `title` is only present on constraint badges and editable dimensions;
    // clearing it on the others matters because the pool reuses nodes across
    // frames — a stale tooltip would outlive the thing that put it there.
    const title = l.title ?? '';
    if (node.title !== title) node.title = title;
    // 双击处理器靠 dataset 认出「哪条曲线的哪一行」——池子里的节点每帧可能换身份，
    // 所以两个字段都要跟着更新与清除。
    const entity = l.edit?.entity ?? '';
    const field = l.edit?.fieldKey ?? '';
    if (node.dataset['entity'] !== entity) {
      if (entity === '') delete node.dataset['entity'];
      else node.dataset['entity'] = entity;
    }
    if (node.dataset['field'] !== field) {
      if (field === '') delete node.dataset['field'];
      else node.dataset['field'] = field;
    }
    // 取整到整数像素：亚像素位移会让文字每帧重新光栅化，糊成一团。
    const dx = `${Math.round(l.x)}px`;
    const dy = `${Math.round(l.y)}px`;
    if (node.style.getPropertyValue('--dx') !== dx) node.style.setProperty('--dx', dx);
    if (node.style.getPropertyValue('--dy') !== dy) node.style.setProperty('--dy', dy);
    if (node.style.display === 'none') node.style.display = '';
  }

  for (let i = labels.length; i < pool.length; i++) {
    const node = pool[i] as HTMLElement;
    if (node.style.display !== 'none') node.style.display = 'none';
  }
}

function translateCopy(e: Entity, d: Vec2): Entity {
  const c = structuredClone(e);
  switch (c.type) {
    case 'line':
      c.a = { x: c.a.x + d.x, y: c.a.y + d.y };
      c.b = { x: c.b.x + d.x, y: c.b.y + d.y };
      break;
    case 'polyline':
      c.points = c.points.map((p) => ({ x: p.x + d.x, y: p.y + d.y }));
      break;
    case 'circle':
    case 'arc':
    case 'ellipse':
      c.center = { x: c.center.x + d.x, y: c.center.y + d.y };
      break;
  }
  return c;
}

/** Defining points shown as grips when an entity is selected. */
function gripPoints(e: Entity): Vec2[] {
  switch (e.type) {
    case 'line':
      return [e.a, e.b, { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 }];
    case 'polyline':
      return [...e.points];
    case 'circle':
      return [
        e.center,
        { x: e.center.x + e.radius, y: e.center.y },
        { x: e.center.x - e.radius, y: e.center.y },
        { x: e.center.x, y: e.center.y + e.radius },
        { x: e.center.x, y: e.center.y - e.radius },
      ];
    case 'arc':
      return [
        e.center,
        arcPointAt(e.center, e.radius, e.startAngle),
        arcPointAt(e.center, e.radius, e.endAngle),
      ];
    case 'ellipse':
      return [e.center];
  }
}

/** Re-exported for the tool controller. */
export { entityBounds, entityBoundsTS, resolveStyle };
