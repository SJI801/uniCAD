/**
 * 距离约束前端侧探针（vitest）——用**真实源码**跑，不看也不猜。
 * 运行：npx vitest run --config _vitest.probe.config.mjs
 */
import { describe, expect, it } from 'vitest';
import type { CadDocument, LineEntity, PolylineEntity } from './src/core/types';
import { createEmptyDocument } from './src/core/types';
import {
  buildConstraints,
  buildEntityDimension,
  canApply,
  describeConstraint,
  isSelfDimension,
} from './src/core/constraints';
import { deserializeDocument, toJsonString } from './src/io/json';

const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({
  id,
  type: 'line',
  layer: '0',
  color: null,
  lineStyle: null,
  lineWeight: null,
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
});

describe('距离约束：种子值', () => {
  it('竖直拉开的两条线 → 水平距离种子值（期望 > 0）', () => {
    const a = line('a', 0, 0, 50, 0);
    const b = line('b', 110, 40, 160, 40);
    const built = buildConstraints('distanceX', [a, b]);
    expect(built.constraints?.[0]?.value).toBe(60);
  });

  it('两条竖直对齐的线 → 水平距离种子值 = 0', () => {
    const a = line('a', 0, 0, 50, 0);
    const b = line('b', 50, 20, 100, 20);
    const built = buildConstraints('distanceX', [a, b]);
    expect(built.constraints?.[0]?.value).toBe(0);
  });

  it('首尾相接的两条线 → 对齐距离种子值 = 0', () => {
    const a = line('a', 0, 0, 50, 0);
    const b = line('b', 50, 0, 100, 0);
    const built = buildConstraints('distance', [a, b]);
    expect(built.constraints?.[0]?.value).toBe(0);
  });

  it('两个圆的距离 = 圆心距', () => {
    const c = (id: string, x: number, y: number, r: number) => ({
      id,
      type: 'circle' as const,
      layer: '0',
      color: null,
      lineStyle: null,
      lineWeight: null,
      center: { x, y },
      radius: r,
    });
    expect(canApply('distance', [c('c1', 0, 0, 5), c('c2', 30, 40, 5)])).toMatchObject({ ok: true });
    const built = buildConstraints('distance', [c('c1', 0, 0, 5), c('c2', 30, 40, 5)]);
    expect(built.constraints?.[0]?.value).toBe(50);
  });
});

describe('距离约束：存盘往返', () => {
  const roundTrip = (doc: CadDocument): CadDocument => deserializeDocument(toJsonString(doc)).doc;

  it('value > 0 的距离约束存回来（基线）', () => {
    const a = line('a', 0, 0, 50, 0);
    const b = line('b', 110, 40, 160, 40);
    const built = buildConstraints('distanceX', [a, b]);
    const doc: CadDocument = { ...createEmptyDocument(), entities: [a, b], constraints: built.constraints! };
    expect(roundTrip(doc).constraints).toHaveLength(1);
  });

  it('value == 0 的距离约束存回来（0 = 重合 / 对齐，是合法值）', () => {
    const a = line('a', 0, 0, 50, 0);
    const b = line('b', 50, 20, 100, 20);
    const built = buildConstraints('distanceX', [a, b]);
    const doc: CadDocument = { ...createEmptyDocument(), entities: [a, b], constraints: built.constraints! };
    expect(built.constraints!.map((c) => describeConstraint(c, doc))).toHaveLength(1);
    expect(roundTrip(doc).constraints).toHaveLength(1);
  });
});

describe('多段线参与的距离约束', () => {
  it('多段线顶点可以当距离目标', () => {
    const pl: PolylineEntity = {
      id: 'p',
      type: 'polyline',
      layer: '0',
      color: null,
      lineStyle: null,
      lineWeight: null,
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 },
      ],
      closed: false,
    };
    const l = line('l', 100, 0, 200, 0);
    const built = buildConstraints('distance', [pl, l]);
    expect(built.constraints?.[0]).toMatchObject({
      kind: 'distance',
      a: { entity: 'p', point: 'vertex', index: 2 },
      b: { entity: 'l', point: 'start' },
    });
  });
});

describe('0.2 单实体尺寸（同一条线两端点之间的距离 = 长度）', () => {
  it('buildEntityDimension：半径 / 直径 / 长度；角度这类没有 → null', () => {
    const c = {
      id: 'c',
      type: 'circle' as const,
      layer: '0',
      color: null,
      lineStyle: null,
      lineWeight: null,
      center: { x: 0, y: 0 },
      radius: 20,
    };
    const l = line('l', 0, 0, 50, 0);
    expect(buildEntityDimension(c, 'radius', 30)).toMatchObject({
      kind: 'radius',
      value: 30,
      a: { entity: 'c', point: 'none' },
    });
    expect(buildEntityDimension(c, 'diameter', 60)).toMatchObject({ kind: 'diameter', value: 60 });
    expect(buildEntityDimension(l, 'distance', 80)).toMatchObject({
      kind: 'distance',
      value: 80,
      a: { entity: 'l', point: 'start' },
      b: { entity: 'l', point: 'end' },
    });
    // 没有对应种类的组合返回 null，调用方退回普通几何编辑
    expect(buildEntityDimension(l, 'angle', 90)).toBeNull();
    expect(buildEntityDimension(c, 'distance', 10)).toBeNull();
    expect(isSelfDimension(buildEntityDimension(l, 'distance', 80)!)).toBe(true);
  });

  it('同一条线两端点的距离约束能存盘读回（a、b 指向同一个图元）', () => {
    const l = line('l', 0, 0, 50, 0);
    const dim = buildEntityDimension(l, 'distance', 80)!;
    const doc: CadDocument = { ...createEmptyDocument(), entities: [l], constraints: [dim] };
    const back = deserializeDocument(toJsonString(doc));
    expect(back.warnings.filter((w) => w.includes('约束'))).toHaveLength(0);
    expect(back.doc.constraints).toHaveLength(1);
    expect(back.doc.constraints[0]).toMatchObject({
      kind: 'distance',
      value: 80,
      a: { entity: 'l', point: 'start' },
      b: { entity: 'l', point: 'end' },
    });
  });
});
