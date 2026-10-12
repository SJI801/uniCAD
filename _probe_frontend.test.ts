/**
 * 距离约束前端侧探针（vitest）——用**真实源码**跑，不看也不猜。
 * 运行：npx vitest run _probe_frontend.test.ts
 */
import { describe, expect, it } from 'vitest';
import type { CadDocument, LineEntity, PolylineEntity } from './src/core/types';
import { createEmptyDocument } from './src/core/types';
import { buildConstraints, describeConstraint, canApply } from './src/core/constraints';
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
  it('竖直拉开的两条线 → 水平距离种子值（期望 > 0，实际？）', () => {
    const a = line('a', 0, 0, 50, 0);
    const b = line('b', 110, 40, 160, 40);
    const built = buildConstraints('distanceX', [a, b]);
    console.log('distanceX(110,40) =', JSON.stringify(built));
    expect(built.constraints?.[0]?.value).toBe(60);
  });

  it('两条竖直对齐的线 → 水平距离种子值 = 0', () => {
    const a = line('a', 0, 0, 50, 0);
    const b = line('b', 50, 20, 100, 20);
    const built = buildConstraints('distanceX', [a, b]);
    console.log('distanceX(对齐) =', JSON.stringify(built));
    expect(built.constraints?.[0]?.value).toBe(0);
  });

  it('首尾相接的两条线 → 对齐距离种子值 = 0', () => {
    const a = line('a', 0, 0, 50, 0);
    const b = line('b', 50, 0, 100, 0);
    const built = buildConstraints('distance', [a, b]);
    console.log('distance(相接) =', JSON.stringify(built));
    expect(built.constraints?.[0]?.value).toBe(0);
  });

  it('两个圆 → 距离；圆/椭圆只有圆心（这条 reason 是否可达）', () => {
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
    console.log('canApply(distance, [圆,圆]) =', JSON.stringify(canApply('distance', [c('c1', 0, 0, 5), c('c2', 30, 40, 5)])));
    const built = buildConstraints('distance', [c('c1', 0, 0, 5), c('c2', 30, 40, 5)]);
    console.log('distance(圆圆) =', JSON.stringify(built));
  });
});

describe('距离约束：存盘往返', () => {
  const roundTrip = (doc: CadDocument): CadDocument => {
    const text = toJsonString(doc);
    console.log('--- saved json ---\n' + text);
    const back = deserializeDocument(text);
    console.log('warnings =', JSON.stringify(back.warnings));
    console.log('reloaded constraints =', JSON.stringify(back.doc.constraints));
    return back.doc;
  };

  it('value > 0 的距离约束应能存回来（基线）', () => {
    const a = line('a', 0, 0, 50, 0);
    const b = line('b', 110, 40, 160, 40);
    const built = buildConstraints('distanceX', [a, b]);
    const doc: CadDocument = { ...createEmptyDocument(), entities: [a, b], constraints: built.constraints! };
    expect(roundTrip(doc).constraints).toHaveLength(1);
  });

  it('value == 0 的距离约束存盘再读回（期望 1 条，实际？）', () => {
    const a = line('a', 0, 0, 50, 0);
    const b = line('b', 50, 20, 100, 20);
    const built = buildConstraints('distanceX', [a, b]);
    const doc: CadDocument = { ...createEmptyDocument(), entities: [a, b], constraints: built.constraints! };
    console.log('describe =', built.constraints!.map((c) => describeConstraint(c, doc)));
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
    console.log('distance(polyline,line) =', JSON.stringify(built));
  });
});
