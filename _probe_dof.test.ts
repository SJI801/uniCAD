/**
 * ROADMAP 0.3 自由度统计 —— 真实 store + 真实 wasm 进程内验收。
 * 运行：npx vitest run --config _vitest.probe.config.mjs
 *
 * 验收原句：**欠约束数显示正确；过约束时标红并说明冲突项**。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@wasm/pkg/unicad_kernel_bg.wasm?url', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = fileURLToPath(new URL('./src/wasm/pkg/unicad_kernel_bg.wasm', import.meta.url));
  return { default: await WebAssembly.compile(readFileSync(path)) };
});

const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  innerWidth: 1600,
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
};

const { initKernel } = await import('./src/core/kernel');
await initKernel();
const { useEditor } = await import('./src/state/editorStore');
const { describeConstraint } = await import('./src/core/constraints');

import type { CircleEntity, Entity, LineEntity } from './src/core/types';

const S = () => useEditor.getState();
const report = () => S().constraintReport;

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

/** 与 props.ts「长度」那一行同款 applyTo。 */
function setLength(e: Entity, v: number): Entity {
  const l = e as LineEntity;
  const ex = l.b.x - l.a.x;
  const ey = l.b.y - l.a.y;
  const cur = Math.hypot(ex, ey);
  const ux = cur < 1e-12 ? 1 : ex / cur;
  const uy = cur < 1e-12 ? 0 : ey / cur;
  return { ...l, b: { x: l.a.x + ux * v, y: l.a.y + uy * v } };
}

describe('0.3 自由度统计', () => {
  it('没有约束也出报告（刚画的图元要能显示还能怎么动），但不是 0 自由度', () => {
    const layer = S().doc.currentLayer;
    install([line('l', 0, 0, 50, 0, layer)]);
    const r = report()!;
    expect(r).not.toBeNull();
    expect(r.constraintCount).toBe(0);
    expect(r.dof).toBe(4);
    expect(r.solved).toBe(true);
    // 刚画的直线：平移 / 转动 / 改长度都能动
    expect(r.freeModes.get('l')).toBe(1 | 2 | 4 | 8);
  });

  it('欠约束数字：单线 4 → +水平 3 → +长度 2', () => {
    const layer = S().doc.currentLayer;
    install([line('l', 0, 0, 50, 0, layer)]);

    S().select(['l']);
    S().addConstraintAction('horizontal');
    expect(report()?.dof).toBe(3);
    expect(report()?.solved).toBe(true);
    expect(report()?.conflicting).toHaveLength(0);

    S().setDimensionAction('l', 'distance', 80, (e) => setLength(e, 80), 'probe len');
    expect(report()?.dof).toBe(2);
    expect(report()?.redundant).toBe(0);
    expect(report()?.solved).toBe(true);
  });

  it('草图级而不是选择级：一条受限 + 一条自由 = 3 + 4', () => {
    const layer = S().doc.currentLayer;
    install([line('l', 0, 0, 50, 0, layer), line('m', 100, 0, 150, 0, layer)]);
    S().select(['l']);
    S().addConstraintAction('horizontal');
    expect(report()?.dof).toBe(7);
    expect(report()?.entityCount).toBe(2);
    expect(report()?.constraintCount).toBe(1);
  });

  it('一致但多余的尺寸：dof 不变、redundant +1、不算冲突', () => {
    const layer = S().doc.currentLayer;
    install([circle('c', 0, 0, 20, layer)]);
    S().setDimensionAction('c', 'radius', 20, (e) => ({ ...e, radius: 20 }) as Entity, 'r20');
    expect(report()?.dof).toBe(2);
    expect(report()?.redundant).toBe(0);

    // 直径 40 与半径 20 是同一件事：多余，但不冲突
    S().setDimensionAction('c', 'diameter', 40, (e) => ({ ...e, radius: 20 }) as Entity, 'd40');
    const r = report()!;
    expect([r.dof, r.redundant, r.solved, r.conflicting.length]).toEqual([2, 1, true, 0]);
    expect(r.conflictingEntities.size).toBe(0);
  });

  it('真冲突：半径 20 + 直径 10 → 标红两条并点名', () => {
    const layer = S().doc.currentLayer;
    install([circle('c', 0, 0, 20, layer)]);
    S().setDimensionAction('c', 'radius', 20, (e) => ({ ...e, radius: 20 }) as Entity, 'r20');
    S().setDimensionAction('c', 'diameter', 10, (e) => ({ ...e, radius: 5 }) as Entity, 'd10');

    const r = report()!;
    expect(r.solved).toBe(false);
    expect(r.conflicting).toHaveLength(2);
    // 冲突项要能说清是谁：文案就是右栏那一行
    const names = r.conflicting.map((c) => describeConstraint(c, S().doc));
    expect(names.some((n) => n.includes('半径'))).toBe(true);
    expect(names.some((n) => n.includes('直径'))).toBe(true);
    // 标红的就是这个圆（画布配色用这张表）
    expect([...r.conflictingEntities]).toEqual(['c']);
    // 矛盾不会增加自由度：3 个参数、秩 1
    expect(r.dof).toBe(2);
  });

  it('撤销/重做后报告跟着回滚', () => {
    const layer = S().doc.currentLayer;
    install([circle('c', 0, 0, 20, layer)]);
    S().setDimensionAction('c', 'radius', 20, (e) => ({ ...e, radius: 20 }) as Entity, 'r20');
    expect(report()?.dof).toBe(2);

    S().undo();
    // 约束被撤掉 → 回到「还没加约束」的状态：报告还在，但约束数归零
    expect(report()?.constraintCount).toBe(0);
    expect(report()?.dof).toBe(3);
    S().redo();
    expect(report()?.dof).toBe(2);
  });

  it('相切（半径已冻结）不算冲突', () => {
    const layer = S().doc.currentLayer;
    install([circle('c', 0, 0, 20, layer), line('l', 30, -50, 30, 50, layer)]);
    S().select(['c', 'l']);
    S().addConstraintAction('tangent');
    const r = report()!;
    expect(r.solved).toBe(true);
    expect(r.conflicting).toHaveLength(0);
    // 圆 3 + 直线 4 = 7 参数，1 条残差
    expect(r.dof).toBe(6);
  });

  it('冲突图元解析成警示红，且压过选中色（否则一框选就把问题盖掉）', async () => {
    const { resolveRenderStyle, UI_COLORS } = await import('./src/render/style');
    const layer = S().doc.currentLayer;
    install([circle('c', 0, 0, 20, layer)]);
    const c = S().doc.entities[0]!;

    expect(resolveRenderStyle(S().doc, c, { conflicting: true }).color).toBe(UI_COLORS.conflict);
    expect(resolveRenderStyle(S().doc, c, { selected: true, conflicting: true }).color).toBe(
      UI_COLORS.conflict,
    );
    // 不冲突时不改色（跟随图层）
    expect(resolveRenderStyle(S().doc, c, {}).color).not.toBe(UI_COLORS.conflict);
  });
});

describe('0.3 草图颜色提示（欠定义蓝）', () => {
  it('判定只认「缺尺寸 / 缺方位」——只剩平移不算（本版本没有锚点约束）', async () => {
    const { isUnderDefined } = await import('./src/core/constraints');
    const layer = S().doc.currentLayer;

    // 刚画的圆：半径未定（size 自由）→ 欠定义
    install([circle('c', 0, 0, 20, layer)]);
    expect(isUnderDefined(report()!.freeModes.get('c'))).toBe(true);

    // 写了半径尺寸：只剩平移 → **不再**染蓝（钉不掉位置是锚点的事，不是"没定义"）
    S().setDimensionAction('c', 'radius', 20, (e) => ({ ...e, radius: 20 }) as Entity, 'r20');
    expect(report()!.freeModes.get('c')).toBe(1 | 2);
    expect(isUnderDefined(report()!.freeModes.get('c'))).toBe(false);

    // 直线 + 水平：尺寸还没定 → 欠定义；再加长度 → 只差平移 → 不染
    install([line('l', 0, 0, 50, 0, layer)]);
    S().select(['l']);
    S().addConstraintAction('horizontal');
    expect(isUnderDefined(report()!.freeModes.get('l'))).toBe(true);
    S().setDimensionAction('l', 'distance', 80, (e) => setLength(e, 80), 'len');
    expect(isUnderDefined(report()!.freeModes.get('l'))).toBe(false);

    // 没进报告的图元（undefined）不染
    expect(isUnderDefined(undefined)).toBe(false);
  });

  it('颜色优先级：冲突 > 选中 > 悬停 > 欠定义 > 图层色', async () => {
    const { resolveRenderStyle, UI_COLORS } = await import('./src/render/style');
    const layer = S().doc.currentLayer;
    install([circle('c', 0, 0, 20, layer)]);
    const c = S().doc.entities[0]!;
    const color = (st: Parameters<typeof resolveRenderStyle>[2]) =>
      resolveRenderStyle(S().doc, c, st).color;

    expect(color({ underDefined: true })).toBe(UI_COLORS.underDefined);
    // 悬停 / 选中要盖住底色（用户此刻在指这一根）
    expect(color({ underDefined: true, hovered: true })).toBe(UI_COLORS.hover);
    expect(color({ underDefined: true, selected: true })).toBe(UI_COLORS.selected);
    // 冲突仍然最显眼
    expect(color({ underDefined: true, selected: true, conflicting: true })).toBe(UI_COLORS.conflict);
    // 预览（未落盘的临时几何）不参与
    expect(color({ underDefined: true, preview: true })).toBe(UI_COLORS.preview);
    // 关掉开关时渲染层拿到的就是 false，颜色回到图层色
    expect(color({ underDefined: false })).not.toBe(UI_COLORS.underDefined);
  });

  it('开关存在且默认关（不擅自覆盖图层颜色）', () => {
    expect(S().sketchColors).toBe(false);
    S().toggleSketchColors();
    expect(S().sketchColors).toBe(true);
    S().toggleSketchColors();
    expect(S().sketchColors).toBe(false);
  });
});

describe('0.3 方向：欠约束的动作标记', () => {
  const ctx = {
    scale: 2,
    viewWidth: 800,
    viewHeight: 600,
    screenOf: (p: { x: number; y: number }) => ({ x: p.x * 2, y: p.y * 2 }),
  };

  it('刚画的直线：十字 + 转 + 尺寸；加「水平」后「转」消失', async () => {
    const { dofMarkers } = await import('./src/render/dofMarks');
    const layer = S().doc.currentLayer;
    install([line('l', 0, 0, 50, 0, layer)]);
    S().select(['l']);

    // 还没有任何约束：四个动作全自由
    expect(report()?.freeModes.get('l')).toBe(1 | 2 | 4 | 8);
    const visible = S().doc.entities;
    let marks = dofMarkers(visible, S().selection, report()!.freeModes, visible, ctx);
    expect(marks.segments).toHaveLength(10); // tx + ty 各一根杆 + 4 根箭羽
    expect(marks.labels.map((l) => l.text)).toEqual(['转', '尺寸']);

    // 锚点是直线中点 (25,0)；箭头按**屏幕 24px** 给 → 模型长度 24×scale = 48
    const xs = marks.segments.flatMap((s) => [s.a.x, s.b.x]);
    expect(Math.min(...xs)).toBeCloseTo(25 - 48, 6);
    expect(Math.max(...xs)).toBeCloseTo(25 + 48, 6);

    // 换个缩放，屏幕上仍然是 24px（模型长度翻倍）——标记属于交互层，不该随缩放变
    const zoomed = {
      ...ctx,
      scale: 4,
      screenOf: (p: { x: number; y: number }) => ({ x: p.x * 4, y: p.y * 4 }),
    };
    const marks2 = dofMarkers(visible, S().selection, report()!.freeModes, visible, zoomed);
    const xs2 = marks2.segments.flatMap((s) => [s.a.x, s.b.x]);
    expect(Math.min(...xs2)).toBeCloseTo(25 - 96, 6);

    // 加「水平」：转动被钉住 → 「转」不再画（约束起了作用，不是 bug）
    S().addConstraintAction('horizontal');
    expect(report()?.freeModes.get('l')).toBe(1 | 2 | 8);
    marks = dofMarkers(visible, S().selection, report()!.freeModes, visible, ctx);
    expect(marks.labels.map((l) => l.text)).toEqual(['尺寸']);
  });

  it('尺寸定了就没有 ⤢；只平移时两根箭头都画', async () => {
    const { dofMarkers } = await import('./src/render/dofMarks');
    const layer = S().doc.currentLayer;
    install([line('l', 0, 0, 50, 0, layer)]);
    S().select(['l']);
    S().addConstraintAction('horizontal');
    S().setDimensionAction('l', 'distance', 80, (e) => setLength(e, 80), 'len');

    expect(report()?.freeModes.get('l')).toBe(1 | 2);
    const visible = S().doc.entities;
    const marks = dofMarkers(visible, S().selection, report()!.freeModes, visible, ctx);
    expect(marks.labels).toHaveLength(0);
    expect(marks.segments).toHaveLength(10); // 两个轴都在
  });

  it('没选中 / 没有剩余动作时不画', async () => {
    const { dofMarkers } = await import('./src/render/dofMarks');
    const layer = S().doc.currentLayer;
    install([circle('c', 0, 0, 20, layer)]);
    S().setDimensionAction('c', 'radius', 20, (e) => ({ ...e, radius: 20 }) as Entity, 'r20');
    const visible = S().doc.entities;

    S().clearSelection();
    expect(dofMarkers(visible, S().selection, report()!.freeModes, visible, ctx).segments).toHaveLength(0);

    // 圆 + 半径：只剩平移（没有 ⟳，圆没有自己的转动；也没有 ⤢）
    S().select(['c']);
    const marks = dofMarkers(visible, S().selection, report()!.freeModes, visible, ctx);
    expect(marks.labels).toHaveLength(0);
    expect(marks.segments).toHaveLength(10);
  });
});
