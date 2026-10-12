/**
 * The workbench: wires the ribbon, panels, canvas, command line and the
 * tool-event pump together.
 */

import { useCallback, useEffect, useRef } from 'react';
import CanvasView from './CanvasView';
import Ribbon from './Ribbon';
import LeftPanel from './LeftPanel';
import RightPanel from './RightPanel';
import StatusBar from './StatusBar';
import { useShortcuts } from './shortcuts';
import { useEditor, commandRewritesGeometry, refusesGeometryEdit } from '../state/editorStore';
import { TOOL_SPECS } from '../tools/registry';
import type { Tool, ToolContext, PreviewGeometry } from '../tools/tools';
import {
  ArcTool,
  CircleTool,
  EllipseTool,
  ExtrudeTool,
  LineTool,
  MeasureTool,
  OffsetTool,
  PolylineTool,
  RectTool,
  SelectTool,
  TrimTool,
  parsePoint,
  parsePolar,
} from '../tools/tools';
import { arcThroughPoints, initKernel, isKernelReady, packScene, pickAll } from '../core/kernel';
import { isPickable } from '../core/entities';
import { downloadText, pickTextFile, downloadBlob } from '../io/json';
import { exportDxf, importDxfComplete, looksLikeDxf } from '../io/dxf';
import { createEmptyDocument, fmt, planeOf, type Entity, type Vec2 } from '../core/types';

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

function createTools(): Map<string, Tool> {
  const tools: Tool[] = [
    new SelectTool(),
    new LineTool(),
    new PolylineTool(),
    new RectTool(),
    new CircleTool(),
    new ArcTool((p1, p2, p3) => {
      if (isKernelReady()) {
        const r = arcThroughPoints(p1, p2, p3);
        if (r) return r;
      }
      // Pure-TS fallback: identical formula, kept so the tool still works
      // before the kernel finishes loading.
      return solveArcTS(p1, p2, p3);
    }),
    new EllipseTool(),
    new TrimTool(),
    new OffsetTool(),
    new ExtrudeTool(),
    new MeasureTool(),
  ];
  return new Map(tools.map((t) => [t.id, t]));
}

/**
 * The pickable entity nearest `point`, or `null`.
 *
 * The same kernel query the canvas uses for clicks, wrapped for the tool
 * context. Kept here rather than in `core/kernel.ts` because "pickable" needs
 * the document's layers (visible, on, not frozen) and those are a store
 * concern, not a kernel one.
 */
function pickEntityAt(point: Vec2): string | null {
  const state = useEditor.getState();
  if (!isKernelReady()) return null;
  // Only the active plane's sketches are pickable. Another plane's entity has no
  // position in this 2D view, so hit-testing it would be testing a coordinate
  // that is not on screen — and would let, say, extrude grab a sketch the user
  // cannot even see.
  const pickable = state.doc.entities.filter(
    (e) => isPickable(state.doc, e) && planeOf(e) === state.doc.activePlane,
  );
  if (pickable.length === 0) return null;
  const scene = packScene(pickable);
  const tol = state.doc.settings.pickAperturePx * state.view.scale;
  const hits = pickAll(scene, point, tol, 512);
  if (hits.length === 0) return null;
  return pickable[hits[0]!.index]?.id ?? null;
}

/**
 * Resolve a command-line entry to a world point, or `null` when it is not one.
 *
 * Accepts the three entries the command line advertises — absolute `x,y`,
 * relative `@dx,dy` and polar `d<angle` (the latter two anchored on the last
 * placed point). Returning `null` lets the caller fall through to the tool's own
 * text handling, so a bare radius or a `c`/`闭合` token is not mistaken for a
 * coordinate. This is also what finally makes `parsePoint`/`parsePolar`
 * reachable — they used to be imported and re-exported but never called, so
 * typing a coordinate did nothing.
 */
function resolvePointEntry(text: string, last: Vec2 | null): Vec2 | null {
  return parsePoint(text, last) ?? parsePolar(text, last);
}

/** TS mirror of the kernel's circumcircle solver, used as a fallback. */
function solveArcTS(
  p1: Vec2,
  p2: Vec2,
  p3: Vec2,
): { center: Vec2; radius: number; startAngle: number; endAngle: number } | null {
  const d =
    2 * (p1.x * (p2.y - p3.y) + p2.x * (p3.y - p1.y) + p3.x * (p1.y - p2.y));
  if (Math.abs(d) < 1e-12) return null;
  const p1s = p1.x * p1.x + p1.y * p1.y;
  const p2s = p2.x * p2.x + p2.y * p2.y;
  const p3s = p3.x * p3.x + p3.y * p3.y;
  const cx = (p1s * (p2.y - p3.y) + p2s * (p3.y - p1.y) + p3s * (p1.y - p2.y)) / d;
  const cy = (p1s * (p3.x - p2.x) + p2s * (p1.x - p3.x) + p3s * (p2.x - p1.x)) / d;
  const center = { x: cx, y: cy };
  const radius = Math.hypot(p1.x - cx, p1.y - cy);
  const norm = (a: number): number => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const a1 = norm(Math.atan2(p1.y - cy, p1.x - cx));
  const a2 = norm(Math.atan2(p2.y - cy, p2.x - cx));
  const a3 = norm(Math.atan2(p3.y - cy, p3.x - cx));
  const sweep = norm(a3 - a1);
  const rel = norm(a2 - a1);
  if (rel <= sweep) {
    return { center, radius, startAngle: a1, endAngle: a3 };
  }
  return { center, radius, startAngle: a3, endAngle: a1 };
}

// ---------------------------------------------------------------------------
// Workbench
// ---------------------------------------------------------------------------

export default function Workbench(): React.ReactElement {
  const toolsRef = useRef<Map<string, Tool>>(createTools());
  const lastToolIdRef = useRef<string>('select');
  const fileNameRef = useRef<string>('drawing.unicad.json');

  const activeTool = useEditor((s) => s.activeTool);
  const setPrompt = useEditor((s) => s.setPrompt);
  const pushLog = useEditor((s) => s.pushLog);
  const replaceDocument = useEditor((s) => s.replaceDocument);
  const markSaved = useEditor((s) => s.markSaved);
  const doc = useEditor((s) => s.doc);

  useShortcuts();

  // -------------------------------------------------------------------------
  // Tool context — rebuilt per event so it always sees fresh state.
  // -------------------------------------------------------------------------

  const makeContext = useCallback((): ToolContext => {
    const state = useEditor.getState();
    return {
      doc: state.doc,
      currentLayer: () => useEditor.getState().doc.currentLayer,
      activePlane: () => useEditor.getState().doc.activePlane,
      // 完全定义（ROADMAP 0.4）的几何锁也管工具：改写已有图元的命令（修剪、圆角
      // 这类）是几何修改，拒绝；只新建或只删除的命令（直线、圆、矩形、Delete）
      // 不动已有几何，保持可用。判据在 `commandRewritesGeometry` 里，与 store
      // 侧同一条界线：锁的是形状，不是整张图。
      commit: (cmd) => {
        const state = useEditor.getState();
        if (commandRewritesGeometry(cmd) && refusesGeometryEdit(state, `「${cmd.label}」`)) return;
        useEditor.getState().run(cmd);
      },
      setPrompt: (text) => useEditor.getState().setPrompt(text),
      requestClose: () => false,
      pick: (p) => pickEntityAt(p),
      viewScale: () => useEditor.getState().view.scale,
    };
  }, []);

  /** Publish the tool's preview + anchor to the window so the canvas can read them. */
  const publish = useCallback((preview: PreviewGeometry, anchor: Vec2 | null): void => {
    (window as unknown as { __unicadPreview?: PreviewGeometry }).__unicadPreview = preview;
    (window as unknown as { __unicadToolAnchor?: Vec2 | null }).__unicadToolAnchor = anchor;
  }, []);

  // -------------------------------------------------------------------------
  // Activate / deactivate tools
  // -------------------------------------------------------------------------

  useEffect(() => {
    const tool = toolsRef.current.get(activeTool);
    if (!tool) return;
    const ctx = makeContext();
    tool.activate(ctx);
    if (tool.initialPrompt) setPrompt(tool.initialPrompt);
    publish({ segments: [], points: [] }, null);
    lastToolIdRef.current = activeTool;
  }, [activeTool, makeContext, publish, setPrompt]);

  // -------------------------------------------------------------------------
  // Event pump: canvas + keyboard dispatch into the active tool
  // -------------------------------------------------------------------------

  useEffect(() => {
    const handle = (ev: Parameters<Tool['handle']>[0]): void => {
      const state = useEditor.getState();
      const tool = toolsRef.current.get(state.activeTool);
      if (!tool) return;
      const ctx = makeContext();
      const result = tool.handle(ev, ctx);

      publish(result.preview, tool.anchor());
      if (result.prompt !== undefined) useEditor.getState().setPrompt(result.prompt);

      if (result.done) {
        // Continuous tools keep running; everything else reverts to select.
        if (!tool.continuous) {
          toolsRef.current.get('select')?.activate(ctx);
          useEditor.getState().setTool('select');
          useEditor.getState().setPrompt(tool.initialPrompt);
        }
      }
    };

    const onClick = (e: Event): void => {
      const detail = (e as CustomEvent<{ world: Vec2; screen: Vec2; shift: boolean; ctrl: boolean }>).detail;
      const eff = (window as unknown as { __unicadCursor?: Vec2 }).__unicadCursor ?? detail.world;
      const state = useEditor.getState();
      // The select tool is driven entirely by the canvas; do not consume the click.
      if (state.activeTool === 'select' || state.activeTool === 'measure') {
        if (state.activeTool === 'measure') {
          handle({ kind: 'click', point: eff, button: 'left', shift: detail.shift, ctrl: detail.ctrl });
          e.preventDefault();
        }
        return;
      }
      handle({ kind: 'click', point: eff, button: 'left', shift: detail.shift, ctrl: detail.ctrl });
      e.preventDefault();
    };

    const onRight = (e: Event): void => {
      const detail = (e as CustomEvent<Vec2>).detail;
      const eff = (window as unknown as { __unicadCursor?: Vec2 }).__unicadCursor ?? detail;
      const state = useEditor.getState();
      const tool = toolsRef.current.get(state.activeTool);
      if (!tool || state.activeTool === 'select') return;
      handle({ kind: 'click', point: eff, button: 'right', shift: false, ctrl: false });
    };

    const onEnter = (): void => {
      handle({ kind: 'enter' });
    };

    const onEscape = (): void => {
      handle({ kind: 'escape' });
    };

    const onText = (e: Event): void => {
      const text = (e as CustomEvent<string>).detail;
      const state = useEditor.getState();
      const tool = toolsRef.current.get(state.activeTool);
      if (tool && state.activeTool !== 'select') {
        // A bare coordinate is the precise counterpart of a click: `x,y`,
        // `@dx,dy` (relative to the last placed point) or `d<angle` (polar).
        // Resolving it here gives *every* drawing tool exact input for free,
        // instead of each re-deriving the same parse — and it keeps the tools
        // from having to know the command line exists at all.
        const p = resolvePointEntry(text, tool.anchor());
        if (p) {
          handle({ kind: 'click', point: p, button: 'left', shift: false, ctrl: false });
          state.pushLog(`坐标 ${fmt(p.x)}, ${fmt(p.y)}`);
          return;
        }
        // Not a point (a bare radius, `c` to close, …): let the tool read it.
        handle({ kind: 'text', value: text });
        return;
      }
      // With no active tool, a coordinate entry should route to a fresh tool —
      // the AutoCAD "click first, type later" behaviour would need a rework of
      // the state machine, so we simply prompt the user instead.
      useEditor.getState().pushLog(`请在激活的绘图命令下输入坐标（例如先按 L，再输入 ${text}）`);
    };

    const onPointerMove = (e: Event): void => {
      const detail = (e as CustomEvent<{ point: Vec2; raw: Vec2 }>).detail;
      onMoveRef.current?.(detail);
    };
    void onPointerMove;

    window.addEventListener('unicad:click', onClick);
    window.addEventListener('unicad:right-click', onRight);
    window.addEventListener('unicad:enter', onEnter);
    window.addEventListener('unicad:escape', onEscape);
    window.addEventListener('unicad:text', onText);

    // The canvas pushes moves through a shared object rather than an event per
    // frame, to avoid a second CustomEvent allocation on the hot path.
    const moveTick = (): void => {
      const eff = (window as unknown as { __unicadCursor?: Vec2 }).__unicadCursor;
      if (!eff) return;
      handle({ kind: 'move', point: eff, raw: eff, ortho: false });
    };
    const interval = window.setInterval(moveTick, 16);

    return () => {
      window.removeEventListener('unicad:click', onClick);
      window.removeEventListener('unicad:right-click', onRight);
      window.removeEventListener('unicad:enter', onEnter);
      window.removeEventListener('unicad:escape', onEscape);
      window.removeEventListener('unicad:text', onText);
      window.clearInterval(interval);
    };
  }, [makeContext, publish]);

  const onMoveRef = useRef<((p: { point: Vec2; raw: Vec2 }) => void) | null>(null);

  // -------------------------------------------------------------------------
  // File operations
  // -------------------------------------------------------------------------

  const doNew = useCallback((): void => {
    if (useEditor.getState().dirty) {
      const ok = window.confirm('当前图纸尚未保存，确定要新建吗？');
      if (!ok) return;
    }
    replaceDocument(createEmptyDocument());
    pushLog('已新建空白图纸');
    setPrompt('就绪');
  }, [pushLog, replaceDocument, setPrompt]);

  const doSave = useCallback((): void => {
    const json = useEditor.getState().exportJson();
    downloadText(fileNameRef.current, json);
    markSaved();
    pushLog(`已保存到 ${fileNameRef.current}`);
  }, [markSaved, pushLog]);

  const doOpen = useCallback(async (): Promise<void> => {
    const picked = await pickTextFile('.json,.unicad,application/json');
    if (!picked) return;
    fileNameRef.current = picked.name.endsWith('.json') ? picked.name : `${picked.name}.json`;

    if (looksLikeDxf(picked.text) && !picked.text.trimStart().startsWith('{')) {
      const result = importDxfComplete(picked.text, picked.name.replace(/\.[^.]+$/, ''));
      replaceDocument(result.doc);
      pushLog(`已从 DXF 导入 ${result.doc.entities.length} 个图元`);
      for (const w of result.warnings) pushLog(`⚠ ${w}`);
      return;
    }

    const result = useEditor.getState().loadFromJson(picked.text);
    if ('error' in result) {
      window.alert(`打开失败: ${result.error}`);
      return;
    }
    for (const w of result.warnings) pushLog(`⚠ ${w}`);
  }, [pushLog, replaceDocument]);

  const doExportDxf = useCallback((): void => {
    const state = useEditor.getState();
    const dxf = exportDxf(state.doc, { writeExtents: true });
    const name = fileNameRef.current.replace(/\.json$/i, '').replace(/\.unicad$/i, '');
    downloadText(`${name || 'drawing'}.dxf`, dxf, 'application/dxf');
    pushLog(`已导出 DXF R12 (${state.doc.entities.length} 个图元)`);
  }, [pushLog]);

  const doImportDxf = useCallback(async (): Promise<void> => {
    const picked = await pickTextFile('.dxf,text/plain');
    if (!picked) return;
    const result = importDxfComplete(picked.text, picked.name.replace(/\.[^.]+$/, ''));
    replaceDocument(result.doc);
    pushLog(`已导入 DXF "${picked.name}": ${result.doc.entities.length} 个图元, ${result.doc.layers.length} 个图层`);
    for (const w of result.warnings) pushLog(`⚠ ${w}`);
    useEditor.getState().zoomToFit();
  }, [pushLog, replaceDocument]);

  const doExportPng = useCallback((): void => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.canvas-gl');
    if (!canvas) {
      pushLog('✗ 未找到画布');
      return;
    }
    canvas.toBlob((blob) => {
      if (!blob) {
        pushLog('✗ 导出 PNG 失败');
        return;
      }
      const name = fileNameRef.current.replace(/\.json$/i, '').replace(/\.unicad$/i, '');
      downloadBlob(`${name || 'drawing'}.png`, blob);
      pushLog('已导出 PNG 图片');
    }, 'image/png');
  }, [pushLog]);

  // Wire the window-level file events the shortcuts emit.
  useEffect(() => {
    const onSave = (): void => doSave();
    const onOpen = (): void => {
      void doOpen();
    };
    const onNew = (): void => doNew();
    window.addEventListener('unicad:save', onSave);
    window.addEventListener('unicad:open', onOpen);
    window.addEventListener('unicad:new', onNew);
    return () => {
      window.removeEventListener('unicad:save', onSave);
      window.removeEventListener('unicad:open', onOpen);
      window.removeEventListener('unicad:new', onNew);
    };
  }, [doNew, doOpen, doSave]);

  // -------------------------------------------------------------------------
  // First-run: warm up the kernel, seed a demo drawing, frame the view
  // -------------------------------------------------------------------------

  useEffect(() => {
    // Kick the module download off as early as possible. CanvasView owns the
    // visible status and the user-facing log line, so this stays silent —
    // otherwise every load logs the same two lines twice.
    void initKernel().catch(() => {
      /* CanvasView reports the failure and flips the fallback flag. */
    });
  }, []);

  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    if (doc.entities.length > 0) return;
    seededRef.current = true;
    const seeded = seedDemo();
    replaceDocument(seeded.doc);
    pushLog(`已创建示例图纸: "${seeded.doc.meta.title}"`);
    pushLog('提示: 滚轮缩放 · 按住 Alt/中键平移 · 输入 L 开始画线');
    // Frame it after the viewport has measured itself.
    window.setTimeout(() => useEditor.getState().zoomToFit(), 120);
  }, [doc.entities.length, pushLog, replaceDocument]);

  return (
    <div className="workbench">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">◈</span>
          <span className="brand-name">uniCAD</span>
          <span className="brand-sub">浏览器端 2D 绘图 · TypeScript + WebGL2 + Rust/WASM</span>
        </div>
        <div className="header-meta">
          <span className="header-chip">{doc.meta.title}</span>
          <span className="header-chip dim">
            {doc.entities.length} 图元 / {doc.layers.length} 图层
          </span>
        </div>
      </header>

      <Ribbon
        onNew={doNew}
        onOpen={() => {
          void doOpen();
        }}
        onSave={doSave}
        onExportDxf={doExportDxf}
        onImportDxf={() => {
          void doImportDxf();
        }}
        onExportPng={doExportPng}
      />

      <div className="app-body">
        <LeftPanel />
        <main className="canvas-column">
          <CanvasView />
          <StatusBar />
        </main>
        <RightPanel />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Demo drawing — gives first-time users something to manipulate immediately.
// ---------------------------------------------------------------------------

function seedDemo(): { doc: ReturnType<typeof createEmptyDocument> } {
  const doc = createEmptyDocument('示例图纸');
  const layerId = doc.layers[0]!.id;
  const init = { layer: layerId };

  // A simple mechanical-ish bracket so the geometry tools have something to grab.
  doc.entities.push(
    mkLine(init, { x: 0, y: 0 }, { x: 120, y: 0 }),
    mkLine(init, { x: 120, y: 0 }, { x: 120, y: 80 }),
    mkLine(init, { x: 120, y: 80 }, { x: 0, y: 80 }),
    mkLine(init, { x: 0, y: 80 }, { x: 0, y: 0 }),
  );

  doc.entities.push(mkCircle(init, { x: 30, y: 40 }, 14));
  doc.entities.push(mkCircle(init, { x: 90, y: 40 }, 9));

  // A 3-point arc across the top.
  const arc = solveArcTS({ x: 40, y: 80 }, { x: 60, y: 96 }, { x: 80, y: 80 });
  if (arc) {
    doc.entities.push({
      id: `e-demo-arc`,
      type: 'arc',
      layer: layerId,
      color: null,
      lineStyle: null,
      lineWeight: null,
      center: arc.center,
      radius: arc.radius,
      startAngle: arc.startAngle,
      endAngle: arc.endAngle,
    });
  }

  // Baseline dimension-ish polyline.
  doc.entities.push({
    id: 'e-demo-pl',
    type: 'polyline',
    layer: layerId,
    color: null,
    lineStyle: 'dashed',
    lineWeight: null,
    points: [
      { x: 0, y: -20 },
      { x: 120, y: -20 },
    ],
    closed: false,
  });

  return { doc };
}

function mkLine(init: { layer: string }, a: Vec2, b: Vec2): Entity {
  return {
    id: `e-demo-${Math.random().toString(36).slice(2, 8)}`,
    type: 'line',
    layer: init.layer,
    color: null,
    lineStyle: null,
    lineWeight: null,
    a,
    b,
  };
}

function mkCircle(init: { layer: string }, center: Vec2, radius: number): Entity {
  return {
    id: `e-demo-${Math.random().toString(36).slice(2, 8)}`,
    type: 'circle',
    layer: init.layer,
    color: null,
    lineStyle: null,
    lineWeight: null,
    center,
    radius,
  };
}

export { fmt, TOOL_SPECS, parsePoint, parsePolar };
