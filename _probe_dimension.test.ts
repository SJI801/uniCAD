/**
 * ROADMAP 0.2「改值即驱动」验收 —— 真实 store + 真实 wasm，进程内跑。
 * 运行：npx vitest run --config _vitest.probe.config.mjs
 *
 * 验收原句：**改圆半径，与它相切的线保持相切**。
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

import type { Entity, LineEntity, CircleEntity } from './src/core/types';

const S = () => useEditor.getState();

const line = (
  id: string,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  layer: string,
): LineEntity => ({
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
const ent = (id: string): Entity => S().doc.entities.find((e) => e.id === id)!;
const constraintOfKind = (kind: string) => S().doc.constraints.find((c) => c.kind === kind);

/** 点到支撑直线的垂距（本探针里切线都是竖直线，直接取 |x| 也行，但仍按通用式算）。 */
function lineDistance(l: LineEntity, p: { x: number; y: number }): number {
  const dx = l.b.x - l.a.x;
  const dy = l.b.y - l.a.y;
  const len = Math.hypot(dx, dy) || 1;
  return ((p.x - l.a.x) * dy - (p.y - l.a.y) * dx) / len;
}

/** 与 props.ts 的「长度」那一行同款 applyTo：固定起点、沿当前方向移动终点。 */
function setLength(e: Entity, v: number): Entity {
  const l = e as LineEntity;
  const ex = l.b.x - l.a.x;
  const ey = l.b.y - l.a.y;
  const cur = Math.hypot(ex, ey);
  const ux = cur < 1e-12 ? 1 : ex / cur;
  const uy = cur < 1e-12 ? 0 : ey / cur;
  return { ...l, b: { x: l.a.x + ux * v, y: l.a.y + uy * v } };
}

describe('0.2 改值即驱动', () => {
  it('改圆半径 → 相切的线跟着走；约束留下来；一次撤销全回去', () => {
    const layer = S().doc.currentLayer;
    install([circle('c', 0, 0, 20, layer), line('l', 20, -30, 20, 30, layer)]);

    // 先建「相切」关系（走真实入口）
    S().select(['c', 'l']);
    S().addConstraintAction('tangent');
    expect(S().doc.constraints).toHaveLength(1);
    expect(Math.abs(lineDistance(ent('l') as LineEntity, { x: 0, y: 0 }))).toBeCloseTo(20, 9);

    // 改半径 20 → 30：写入「半径」尺寸约束，求解器只动那条切线
    S().select(['c']);
    S().setDimensionAction('c', 'radius', 30, (e) => ({ ...e, radius: 30 }) as Entity, 'probe radius');

    expect((ent('c') as CircleEntity).radius).toBeCloseTo(30, 9);
    expect(Math.abs(lineDistance(ent('l') as LineEntity, { x: 0, y: 0 }))).toBeCloseTo(30, 9);
    const radiusDim = constraintOfKind('radius');
    expect(radiusDim?.value).toBeCloseTo(30, 9);
    // 圆自己在约束里（单实体尺寸），切线那条「相切」还在
    expect(S().doc.constraints.filter((c) => c.kind === 'tangent')).toHaveLength(1);
    // 切线确实动了：x 从 20 到 30
    const moved = ent('l') as LineEntity;
    expect(moved.a.x).toBeCloseTo(30, 6);
    expect(moved.b.x).toBeCloseTo(30, 6);
    expect(moved.a.y).toBeCloseTo(-30, 6); // 只平移，长度/方向不变

    // 再改成 45：改的是同一条约束，不新增
    S().setDimensionAction('c', 'radius', 45, (e) => ({ ...e, radius: 45 }) as Entity, 'probe radius 2');
    expect(S().doc.constraints.filter((c) => c.kind === 'radius')).toHaveLength(1);
    expect((ent('c') as CircleEntity).radius).toBeCloseTo(45, 9);
    expect(Math.abs(lineDistance(ent('l') as LineEntity, { x: 0, y: 0 }))).toBeCloseTo(45, 9);

    // 一次撤销：几何 + 伙伴 + 约束一起回到改值前（此时半径应为 30）
    S().undo();
    expect(constraintOfKind('radius')?.value).toBeCloseTo(30, 9);
    expect((ent('c') as CircleEntity).radius).toBeCloseTo(30, 9);
    expect(Math.abs(lineDistance(ent('l') as LineEntity, { x: 0, y: 0 }))).toBeCloseTo(30, 9);

    // 再撤两次：连「半径」约束本身都撤掉（第二次撤回到 20，第三次撤掉约束）
    S().undo();
    expect((ent('c') as CircleEntity).radius).toBeCloseTo(20, 9);
    expect(Math.abs(lineDistance(ent('l') as LineEntity, { x: 0, y: 0 }))).toBeCloseTo(20, 9);
    S().undo();
    expect(S().doc.constraints.filter((c) => c.kind === 'radius')).toHaveLength(0);
  });

  it('改直线长度 → 长度成为驱动量，且拖动仍然是平移不是拉伸', () => {
    const layer = S().doc.currentLayer;
    install([line('l', 0, 0, 50, 0, layer)]);
    S().select(['l']);

    S().setDimensionAction('l', 'distance', 80, (e) => setLength(e, 80), 'probe length');
    let l = ent('l') as LineEntity;
    expect(Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y)).toBeCloseTo(80, 9);
    const dim = constraintOfKind('distance');
    expect(dim?.value).toBeCloseTo(80, 9);
    // 长度是「同一条线两端点」的距离，不是两条线之间
    expect(dim?.a.entity).toBe('l');
    expect(dim?.b?.entity).toBe('l');

    // 拖动整条线：长度约束对平移无感 → 平移（若被钉扎会变成拉伸）
    S().transformSelection(
      (e) => ({ ...(e as LineEntity), a: { x: (e as LineEntity).a.x + 10, y: (e as LineEntity).a.y + 5 }, b: { x: (e as LineEntity).b.x + 10, y: (e as LineEntity).b.y + 5 } }) as Entity,
      '移动 1 个对象',
    );
    l = ent('l') as LineEntity;
    expect(Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y)).toBeCloseTo(80, 9);
    expect(l.a.x).toBeCloseTo(10, 6);
    expect(l.b.x).toBeCloseTo(90, 6);
  });

  it('半径填 0 / 负数被拒，不写约束也不改几何', () => {
    const layer = S().doc.currentLayer;
    install([circle('c', 0, 0, 20, layer)]);
    S().setDimensionAction('c', 'radius', 0, (e) => ({ ...e, radius: 0 }) as Entity, 'probe bad');
    expect((ent('c') as CircleEntity).radius).toBeCloseTo(20, 9);
    expect(S().doc.constraints).toHaveLength(0);
  });

  it('没有对应尺寸约束的行（直线的角度）退回普通几何编辑，输入仍然生效', () => {
    const layer = S().doc.currentLayer;
    install([line('l', 0, 0, 50, 0, layer)]);
    // 「角度」没有单实体尺寸种类：buildEntityDimension 返回 null，动作退回
    // updateEntityById，几何照改、约束不写。
    S().setDimensionAction(
      'l',
      'angle',
      90,
      (e) => ({ ...(e as LineEntity), b: { x: 0, y: 50 } }) as Entity,
      'probe angle',
    );
    const l = ent('l') as LineEntity;
    expect(l.b.x).toBeCloseTo(0, 9);
    expect(l.b.y).toBeCloseTo(50, 9);
    expect(S().doc.constraints).toHaveLength(0);
  });
});
