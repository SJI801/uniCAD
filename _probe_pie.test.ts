/**
 * 右键饼菜单 —— 内容模型与分发（真实 store + 真实 wasm，进程内）。
 * 运行：npx vitest run --config _vitest.probe.config.mjs
 *
 * 组件那一层（扇形几何 / 悬停展开）只能肉眼看；**「哪些项可用、点了会发生什么」
 * 全部在这里断死**——它本来就是选择与命令状态的函数。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@wasm/pkg/unicad_kernel_bg.wasm?url', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = fileURLToPath(new URL('./src/wasm/pkg/unicad_kernel_bg.wasm', import.meta.url));
  return { default: await WebAssembly.compile(readFileSync(path)) };
});

/** 记下所有走事件通道的副作用（工具收尾 / 打开属性页）。 */
const dispatched: Array<{ type: string; detail: unknown }> = [];
const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  innerWidth: 1600,
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
  dispatchEvent: (e: Event) => {
    dispatched.push({ type: e.type, detail: (e as CustomEvent).detail });
    return true;
  },
};

const { initKernel } = await import('./src/core/kernel');
await initKernel();
const { useEditor } = await import('./src/state/editorStore');
const { allEntities, findEntity, sketchEntities } = await import('./src/core/doc');
const {
  buildPieMenu,
  runPieAction,
  pieOrigin,
  pieScale,
  ringBounds,
  ringMid,
  wedgePath,
  PIE_HALF,
  PIE_MIN_SCALE,
  PIE_RING,
} = await import('./src/ui/pieMenu');

import type { CircleEntity, Entity, LineEntity, Vec2 } from './src/core/types';

const S = () => useEditor.getState();

const line = (id: string, ax: number, ay: number, bx: number, by: number, layer: string): LineEntity => ({
  id,
  type: 'line',
  layer,
  color: null,
  lineStyle: null,
  lineWeight: null,
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
});
const circle = (id: string, x: number, y: number, r: number, layer: string): CircleEntity => ({
  id,
  type: 'circle',
  layer,
  color: null,
  lineStyle: null,
  lineWeight: null,
  center: { x, y },
  radius: r,
});

function install(entities: Entity[]): void {
  S().replaceDocument({ ...S().doc, entities, constraints: [], solids: [] });
}
const ent = (id: string): Entity => findEntity(S().doc, id)!;

/** 与 CanvasView 里那段 JSX 同形的输入。 */
function menu() {
  return buildPieMenu({
    doc: S().doc,
    selected: sketchEntities(S().doc).filter((e) => S().selection.has(e.id)),
    activeTool: S().activeTool,
    view3d: S().view3d,
    report: S().constraintReport,
  });
}
const sector = (id: string) => menu().find((s) => s.id === id)!;
const leafAt = (sid: string, lid: string) => sector(sid).children!.find((l) => l.id === lid)!;

describe('饼菜单：内容与可用性', () => {
  it('无选择无命令：7 格；约束类逐条给出置灰原因', () => {
    const layer = S().doc.currentLayer;
    install([line('l', 0, 0, 50, 0, layer)]);
    S().clearSelection();
    S().setTool('select');

    const sectors = menu();
    expect(sectors.map((s) => s.id)).toEqual([
      'toolDone',
      'draw',
      'tools',
      'constraints',
      'dimensions',
      'edit',
      'view',
    ]);
    // 「结束/取消」永远在，但没有命令时点不动——用户要的就是它在饼里
    const done = sector('toolDone');
    expect(done.enabled).toBe(false);
    expect(done.action).toEqual({ kind: 'toolDone' });
    expect(done.reason).toContain('没有正在执行');

    // 绘图：6 个工具都可用
    expect(sector('draw').children!.map((l) => l.label)).toEqual([
      '直线',
      '多段线',
      '矩形',
      '圆',
      '圆弧',
      '椭圆',
    ]);
    expect(sector('draw').children!.every((l) => l.enabled)).toBe(true);

    // 约束 / 尺寸：一律置灰，且原因是人话（来自 canApply）
    expect(sector('constraints').children!.every((l) => !l.enabled)).toBe(true);
    expect(leafAt('constraints', 'constraint:tangent').reason).toContain('先选中');
    expect(sector('dimensions').children!.every((l) => !l.enabled)).toBe(true);
    // 编辑里只有「属性」不依赖选择
    expect(leafAt('edit', 'edit:property').enabled).toBe(true);
    expect(leafAt('edit', 'edit:delete').enabled).toBe(false);
  });

  it('选中圆 + 线：相切可用、同心置灰并给理由；尺寸按 canApply 分流', () => {
    const layer = S().doc.currentLayer;
    install([circle('c', 0, 0, 20, layer), line('l', 30, -50, 30, 50, layer)]);
    S().select(['c', 'l']);

    expect(leafAt('constraints', 'constraint:tangent').enabled).toBe(true);
    const concentric = leafAt('constraints', 'constraint:concentric');
    expect(concentric.enabled).toBe(false);
    expect(concentric.reason).toContain('圆');
    // 半径要正好 1 个圆 → 两个对象时不可用；距离（两对象）可用
    expect(leafAt('dimensions', 'constraint:radius').enabled).toBe(false);
    expect(leafAt('dimensions', 'constraint:distance').enabled).toBe(true);
  });

  it('有命令在跑：「结束/取消」变可用，并带上当前工具自己的说法', () => {
    const layer = S().doc.currentLayer;
    install([line('l', 0, 0, 50, 0, layer)]);
    S().setTool('polyline');

    const done = sector('toolDone');
    expect(done.enabled).toBe(true);
    expect(done.label).toBe('结束/取消');
    expect(done.hint).toContain('右键');
    expect(done.reason).toBeUndefined();
  });

  it('3D 视图：草图命令一律置灰并说明原因，视图里给「回 2D」', () => {
    const layer = S().doc.currentLayer;
    install([circle('c', 0, 0, 20, layer)]);
    S().select(['c']);
    S().setView3d(true);

    expect(sector('draw').enabled).toBe(false);
    expect(sector('draw').reason).toContain('3D');
    expect(sector('constraints').enabled).toBe(false);
    expect(leafAt('constraints', 'constraint:tangent').reason).toContain('3D');
    expect(leafAt('edit', 'edit:delete').reason).toContain('3D');
    const back = leafAt('view', 'view:3d');
    expect(back.label).toBe('回 2D');
    expect(back.action).toEqual({ kind: 'view3d', on: false });
    S().setView3d(false);
  });
});

describe('饼菜单：动作真的落到 store 上', () => {
  it('点「相切」= 走 Ribbon 那条链路（几何真的相切了）', () => {
    const layer = S().doc.currentLayer;
    install([circle('c', 0, 0, 20, layer), line('l', 30, -50, 30, 50, layer)]);
    S().select(['c', 'l']);

    runPieAction({ kind: 'constraint', value: 'tangent' }, S());
    expect(S().doc.constraints.map((c) => c.kind)).toEqual(['tangent']);
    const l = ent('l') as LineEntity;
    const c = ent('c') as CircleEntity;
    const dist = Math.abs((l.a.x - c.center.x) * (l.b.y - l.a.y) - (l.a.y - c.center.y) * (l.b.x - l.a.x)) /
      Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y);
    expect(dist).toBeCloseTo(c.radius, 6);
    // 半径没被动（关系不许改尺寸那条规则照旧）
    expect(c.radius).toBeCloseTo(20, 9);

    S().undo();
    expect(S().doc.constraints).toHaveLength(0);
  });

  it('点「尺寸▸半径」= 锁定现状（种子值 = 当前半径）', () => {
    const layer = S().doc.currentLayer;
    install([circle('c', 0, 0, 20, layer)]);
    S().select(['c']);
    runPieAction({ kind: 'constraint', value: 'radius' }, S());
    expect(S().doc.constraints[0]).toMatchObject({ kind: 'radius', value: 20 });
  });

  it('点「工具▸直线」切工具；点「结束/取消」重放右键事件（工具语义一字不改）', () => {
    dispatched.length = 0;
    runPieAction({ kind: 'tool', id: 'line' }, S());
    expect(S().activeTool).toBe('line');

    const world: Vec2 = { x: 12, y: 34 };
    runPieAction({ kind: 'toolDone' }, S(), world);
    expect(dispatched).toEqual([{ type: 'unicad:right-click', detail: world }]);
  });

  it('点「编辑▸属性」掀开左栏属性页（走事件通道）', () => {
    dispatched.length = 0;
    runPieAction({ kind: 'property' }, S());
    expect(dispatched).toEqual([{ type: 'unicad:panel', detail: 'properties' }]);
  });

  it('点「编辑▸删除」真的删掉所选', () => {
    const layer = S().doc.currentLayer;
    install([line('l', 0, 0, 50, 0, layer), line('m', 60, 0, 90, 0, layer)]);
    S().select(['l']);
    runPieAction({ kind: 'delete' }, S());
    expect(allEntities(S().doc).map((e) => e.id)).toEqual(['m']);
  });

  it('视图开关与缩放到范围都能点（栅格/标注/约束标记/端点）', () => {
    const before = {
      grid: S().gridVisible,
      dims: S().dimsVisible,
      constraints: S().constraintsVisible,
      endpoints: S().endpointsVisible,
    };
    for (const v of ['grid', 'dims', 'constraints', 'endpoints'] as const) {
      runPieAction({ kind: 'toggle', value: v }, S());
    }
    expect(S().gridVisible).toBe(!before.grid);
    expect(S().dimsVisible).toBe(!before.dims);
    expect(S().constraintsVisible).toBe(!before.constraints);
    expect(S().endpointsVisible).toBe(!before.endpoints);
    runPieAction({ kind: 'zoomFit' }, S());
  });
});

describe('饼菜单：摆位（中心在光标，贴边只缩小不挪位）', () => {
  it('中心 == 落点：四角 / 四边 / 中心，含贴边时', () => {
    const W = 1227;
    const H = 653;
    const pts: Array<[number, number]> = [
      [0, 0],
      [W, 0],
      [0, H],
      [W, H],
      [W / 2, 0],
      [0, H / 2],
      [W, H / 2],
      [W / 2, H],
      [W / 2, H / 2],
      [W - 4, 424],
      [W - 140, 300],
    ];
    for (const [x, y] of pts) {
      const k = pieScale({ x, y }, W, H);
      const half = PIE_HALF * k;
      const o = pieOrigin({ x, y }, half);
      // 左上角 + 半边长 == 落点：无论缩没缩，中心都分毫不差地落在右键处
      expect(o.x + half).toBeCloseTo(x, 9);
      expect(o.y + half).toBeCloseTo(y, 9);
    }
  });

  it('中间不缩；贴边小于 1；且只要没触底就一定装得下', () => {
    const W = 1227;
    const H = 653;
    expect(pieScale({ x: W / 2, y: H / 2 }, W, H)).toBe(1);

    for (const [x, y] of [
      [W - 4, 424],
      [4, 424],
      [600, 4],
      [600, H - 4],
      [W - 130, 300],
    ] as const) {
      const k = pieScale({ x, y }, W, H);
      expect(k).toBeLessThan(1);
      expect(k).toBeGreaterThanOrEqual(PIE_MIN_SCALE);
      if (k > PIE_MIN_SCALE) {
        // 没触底 → 方框必须完全落在窗口内（这就是「贴边不再缺一块」）
        const half = PIE_HALF * k;
        expect(x - half).toBeGreaterThanOrEqual(-1e-9);
        expect(x + half).toBeLessThanOrEqual(W + 1e-9);
        expect(y - half).toBeGreaterThanOrEqual(-1e-9);
        expect(y + half).toBeLessThanOrEqual(H + 1e-9);
      }
    }
  });

  it('真·角落触底后允许探出去（不自欺：这是刻意的下限）', () => {
    const k = pieScale({ x: 2, y: 2 }, 1227, 653);
    expect(k).toBe(PIE_MIN_SCALE);
  });

  it('任何烂输入都不许把比例算成 NaN —— 那会让饼落到视口外，表现成"右键唤不出"', () => {
    const bads: Array<[number, number, number, number]> = [
      [Number.NaN, Number.NaN, 1227, 653],
      [10, 10, Number.NaN, Number.NaN],
      [10, 10, 0, 0],
      [10, 10, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
      [-5, -5, 1227, 653],
      [10, 715, 200, 180],
    ];
    for (const [x, y, w, h] of bads) {
      const k = pieScale({ x, y }, w, h);
      expect(Number.isFinite(k)).toBe(true);
      expect(k).toBeGreaterThan(0);
      expect(k).toBeLessThanOrEqual(1);
      expect(Number.isFinite(PIE_HALF * k)).toBe(true);
      // 窗口尺寸烂掉时，只要落点是正常数，方框原点就必须是正常数
      if (Number.isFinite(x) && Number.isFinite(y)) {
        const o = pieOrigin({ x, y }, PIE_HALF * k);
        expect(Number.isFinite(o.x) && Number.isFinite(o.y)).toBe(true);
      }
    }
  });

  it('外圈最外沿 + 文字都在方框内（方框半边长 ≥ 外圈半径 + 文字半宽）', () => {
    // 与 PieMenuView 里的 R 常量对齐：外圈 100–120，标签 9px、最多 5 个汉字
    const outerOut = PIE_RING.outerOut;
    const labelHalfWidth = (5 * 9) / 2;
    expect(outerOut + labelHalfWidth).toBeLessThanOrEqual(PIE_HALF);
  });

  it('几何一律画在**以饼心为原点**的内部坐标系里 —— 这条就是「整张饼错位」那个 bug 的锁', () => {
    // 曾经的 bug：把窗口坐标 at.x/at.y 当圆心喂进 viewBox 内部坐标系，圆心飞出 viewBox，
    // 整张饼错位。现在几何函数拿不到绝对坐标：路径里除了半径本身，任何数字都不许超过外半径。
    for (const count of [7, 8, 9]) {
      for (let i = 0; i < count; i++) {
        const [a0, a1] = ringBounds(i, count);
        const d = wedgePath(PIE_RING.inner, PIE_RING.innerOut, a0, a1);
        const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
        expect(nums.length).toBeGreaterThan(0);
        for (const n of nums) {
          expect(Math.abs(n)).toBeLessThanOrEqual(PIE_RING.innerOut + 1e-6);
        }
        // 中点也必须落在环上（半径正确、方向随扇区走）
        const m = ringMid(a0, a1, 66);
        expect(Math.hypot(m.x, m.y)).toBeCloseTo(66, 6);
      }
    }
    // 顶点起顺时针：第一格**起点**在正上方，所以它的中心落在右上象限
    const first = ringMid(...ringBounds(0, 7), 66);
    expect(first.y).toBeLessThan(0);
    expect(first.x).toBeGreaterThan(0);
    expect(Math.atan2(first.y, first.x)).toBeCloseTo(-Math.PI / 2 + Math.PI / 7, 6);
  });
});

describe('饼菜单：冲突扇区（把 0.3 接进来）', () => {
  it('有冲突才多出第 8 格；点它点名冲突项并选中涉及的图元', () => {
    const layer = S().doc.currentLayer;
    install([circle('c', 0, 0, 20, layer)]);
    expect(menu().map((s) => s.id)).not.toContain('conflicts');

    // 半径 20 与直径 10 不能同时成立
    S().setDimensionAction('c', 'radius', 20, (e) => ({ ...e, radius: 20 }) as Entity, 'r20');
    S().setDimensionAction('c', 'diameter', 10, (e) => ({ ...e, radius: 5 }) as Entity, 'd10');

    const s = sector('conflicts');
    expect(s.danger).toBe(true);
    expect(s.label).toBe('冲突 2');
    const action = s.action!;
    expect(action.kind).toBe('conflicts');
    if (action.kind !== 'conflicts') throw new Error('wrong action');
    expect(action.lines).toHaveLength(2);
    expect(action.lines.join(' ')).toContain('半径');
    expect(action.entities).toEqual(['c']);

    S().clearSelection();
    runPieAction(action, S());
    expect([...S().selection]).toEqual(['c']);
  });
});
