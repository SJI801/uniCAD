/**
 * 「直线无法与圆相切」——真实 store + 真实 wasm 复现。
 * 运行：npx vitest run --config _vitest.probe.config.mjs _probe_tangent.test.ts
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
const { canApply } = await import('./src/core/constraints');

import type { CircleEntity, Entity, LineEntity, PolylineEntity } from './src/core/types';

const S = () => useEditor.getState();

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
const rect = (id: string, layer: string): PolylineEntity => ({
  id,
  type: 'polyline',
  layer,
  color: null,
  lineStyle: null,
  lineWeight: null,
  points: [
    { x: 30, y: -10 },
    { x: 60, y: -10 },
    { x: 60, y: 10 },
    { x: 30, y: 10 },
  ],
  closed: true,
});

function install(entities: Entity[]): void {
  S().replaceDocument({ ...S().doc, entities, constraints: [], solids: [] });
}
const ent = (id: string): Entity => S().doc.entities.find((e) => e.id === id)!;

/** 圆心到直线支撑线的垂距（带符号）。 */
function signedDist(l: LineEntity, p: { x: number; y: number }): number {
  const dx = l.b.x - l.a.x;
  const dy = l.b.y - l.a.y;
  const len = Math.hypot(dx, dy) || 1;
  return ((p.x - l.a.x) * dy - (p.y - l.a.y) * dx) / len;
}

function report(tag: string) {
  const c = ent('c') as CircleEntity;
  const l = ent('l') as LineEntity;
  const d = Math.abs(signedDist(l, c.center));
  const out = {
    tag,
    r: Number(c.radius.toFixed(6)),
    center: `(${c.center.x.toFixed(3)},${c.center.y.toFixed(3)})`,
    line: `(${l.a.x.toFixed(3)},${l.a.y.toFixed(3)})→(${l.b.x.toFixed(3)},${l.b.y.toFixed(3)})`,
    dist: Number(d.toFixed(6)),
    tangent: Math.abs(d - c.radius) < 1e-6,
    constraints: S().doc.constraints.map((x) => x.kind),
  };
  console.log(JSON.stringify(out));
  return out;
}

describe('相切：各种初始位形', () => {
  it('穿过圆心 / 完全在外 / 相割 / 竖直线 / 顺序颠倒', () => {
    const layer = S().doc.currentLayer;
    const cases: Array<[string, Entity[]]> = [
      ['A 横线穿过圆心 y=0', [circle('c', 0, 0, 20, layer), line('l', -50, 0, 50, 0, layer)]],
      ['B 横线在外 y=30', [circle('c', 0, 0, 20, layer), line('l', -50, 30, 50, 30, layer)]],
      ['C 横线相割 y=10', [circle('c', 0, 0, 20, layer), line('l', -50, 10, 50, 10, layer)]],
      ['D 竖线在外 x=30', [circle('c', 0, 0, 20, layer), line('l', 30, -50, 30, 50, layer)]],
      ['E 文档序：线在前', [line('l', -50, 10, 50, 10, layer), circle('c', 0, 0, 20, layer)]],
      ['F 斜线在外', [circle('c', 0, 0, 20, layer), line('l', -40, -40, 40, 40, layer)]],
    ];
    const results = [];
    for (const [tag, entities] of cases) {
      install(entities);
      S().select(['c', 'l']);
      S().addConstraintAction('tangent');
      results.push(report(tag));
    }
    expect(results.every((r) => r.tangent)).toBe(true);
    // 关键：加相切**不许改半径**（修复前穿过圆心的那种会 20 → 12）。
    expect(results.every((r) => Math.abs(r.r - 20) < 1e-9)).toBe(true);
  });

  it('加完相切后改半径，相切仍然成立（0.2 的验收路径）', () => {
    const layer = S().doc.currentLayer;
    install([circle('c', 0, 0, 20, layer), line('l', -50, 30, 50, 30, layer)]);
    S().select(['c', 'l']);
    S().addConstraintAction('tangent');
    const before = report('加相切后');

    S().select(['c']);
    S().setDimensionAction('c', 'radius', 35, (e) => ({ ...e, radius: 35 }) as Entity, 'probe r35');
    const after = report('改半径 35 后');

    expect(after.tangent).toBe(true);
    expect(after.r).toBeCloseTo(35, 9);
    // 加关系时半径不动；改尺寸时半径才动，且只有它动（伙伴那条线跟过来）
    expect(before.r).toBeCloseTo(20, 9);
    expect(after.center).toBe(before.center);
  });

  it('多段线（矩形）与圆：canApply 会拒绝并给出原因', () => {
    const layer = S().doc.currentLayer;
    install([circle('c', 0, 0, 20, layer), rect('l', layer)]);
    const verdict = canApply('tangent', [ent('c'), ent('l')]);
    console.log('canApply(tangent, [圆, 矩形多段线]) =', JSON.stringify(verdict));
    expect(verdict.ok).toBe(false);
  });
});
