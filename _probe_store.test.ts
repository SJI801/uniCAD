/**
 * 距离约束「第二个曲线跳出圆」嫌疑 —— 真实 store + 真实 wasm 在进程内跑一遍。
 * 运行：npx vitest run --config _vitest.probe.config.mjs
 *
 * 这里用的是**源码里的真函数**：editorStore 的 addConstraintAction /
 * transformSelection（含 withConstraintRepair 的钉扎与 solveAfterEdit），
 * 内核是 src/wasm/pkg 里的真 wasm。
 */
import { describe, expect, it, vi } from 'vitest';

// kernel.ts 用 `?url` 取 wasm；Node 里那个字符串不能被 WebAssembly.instantiate
// 接受，所以把该模块换成编译好的 WebAssembly.Module（glue 直接吃 Module）。
vi.mock('@wasm/pkg/unicad_kernel_bg.wasm?url', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = fileURLToPath(new URL('./src/wasm/pkg/unicad_kernel_bg.wasm', import.meta.url));
  return { default: await WebAssembly.compile(readFileSync(path)) };
});

// editorStore 在模块作用域读 window.innerWidth / localStorage。
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

type Pt = { x: number; y: number };
const line = (id: string, x1: number, y1: number, x2: number, y2: number, layer: string) => ({
  id,
  type: 'line' as const,
  layer,
  color: null,
  lineStyle: null,
  lineWeight: null,
  a: { x: x1, y: y1 },
  b: { x: x2, y: y2 },
});
const circ = (id: string, x: number, y: number, r: number, layer: string) => ({
  id,
  type: 'circle' as const,
  layer,
  color: null,
  lineStyle: null,
  lineWeight: null,
  center: { x, y },
  radius: r,
});

const S = () => useEditor.getState();

function install(entities: unknown[]): void {
  const base = S().doc;
  S().replaceDocument({ ...base, entities: entities as never, constraints: [], solids: [] });
}

function translate(e: { type: string } & Record<string, unknown>, dx: number, dy: number) {
  if (e.type === 'line') {
    const l = e as unknown as { a: Pt; b: Pt };
    return { ...e, a: { x: l.a.x + dx, y: l.a.y + dy }, b: { x: l.b.x + dx, y: l.b.y + dy } };
  }
  if (e.type === 'circle' || e.type === 'ellipse') {
    const c = e as unknown as { center: Pt };
    return { ...e, center: { x: c.center.x + dx, y: c.center.y + dy } };
  }
  return e;
}

function report(tag: string) {
  const c = S().doc.constraints[0]!;
  const ea = S().doc.entities.find((e) => e.id === c.a.entity)!;
  const eb = S().doc.entities.find((e) => e.id === c.b.entity)!;
  const pt = (e: typeof ea, t: { point: string; index?: number }): Pt => {
    if (t.point === 'start') return (e as never as { a: Pt }).a;
    if (t.point === 'end') return (e as never as { b: Pt }).b;
    if (t.point === 'center') return (e as never as { center: Pt }).center;
    return (e as never as { points: Pt[] }).points[t.index ?? 0]!;
  };
  const pa = pt(ea, c.a);
  const pb = pt(eb, c.b);
  const measured = Math.hypot(pa.x - pb.x, pa.y - pb.y);
  const geo = (e: typeof ea) =>
    e.type === 'line'
      ? `(${fmt((e as never as { a: Pt }).a)}, ${fmt((e as never as { b: Pt }).b)})`
      : e.type === 'circle'
        ? `c${fmt((e as never as { center: Pt }).center)} r${(e as never as { radius: number }).radius}`
        : e.type;
  return {
    tag,
    value: c.value,
    anchor: `${c.a.entity}.${c.a.point}`,
    slider: `${c.b.entity}.${c.b.point}`,
    anchorPt: fmt(pa),
    sliderPt: fmt(pb),
    measured: Number(measured.toFixed(6)),
    offCircle: Number(Math.abs(measured - c.value!).toFixed(6)),
    A: geo(ea),
    B: geo(eb),
  };
}
const fmt = (p: Pt) => `(${p.x.toFixed(2)},${p.y.toFixed(2)})`;

describe('距离约束：拖动时第二个曲线会不会离开圆', () => {
  it('两条直线 / 两个圆 / 逐帧拖动 / 谁是圆心', () => {
    const layer = S().doc.currentLayer;
    const out: unknown[] = [];

    // --- 两条直线（文档序 a, b） ---
    install([line('a', 0, 0, 50, 0, layer), line('b', 100, 0, 150, 0, layer)]);
    S().select(['a', 'b']);
    S().addConstraintAction('distance');
    out.push(report('L0 建约束'));

    S().select(['b']);
    S().transformSelection((e) => translate(e as never, 30, 40) as never, 'probe move');
    out.push(report('L1 拖 b（滑块）+30+40'));

    S().select(['a']);
    S().transformSelection((e) => translate(e as never, 30, 40) as never, 'probe move');
    out.push(report('L2 拖 a（圆心）+30+40'));

    // --- 两个圆 ---
    install([circ('c1', 0, 0, 10, layer), circ('c2', 50, 0, 10, layer)]);
    S().select(['c1', 'c2']);
    S().addConstraintAction('distance');
    out.push(report('C0 建约束'));
    S().select(['c2']);
    S().transformSelection((e) => translate(e as never, 30, 40) as never, 'probe move');
    out.push(report('C1 拖 c2 +30+40'));
    S().select(['c1']);
    S().transformSelection((e) => translate(e as never, 30, 40) as never, 'probe move');
    out.push(report('C2 拖 c1 +30+40'));

    // --- 逐帧拖动 b（模拟真实拖动 20 帧） ---
    install([line('a', 0, 0, 50, 0, layer), line('b', 100, 0, 150, 0, layer)]);
    S().select(['a', 'b']);
    S().addConstraintAction('distance');
    const orig = structuredClone(S().doc.entities.find((e) => e.id === 'b')!);
    S().select(['b']);
    for (let k = 1; k <= 20; k++) {
      S().transformSelection(() => translate(orig as never, k * 5, k * 2) as never, '__live_move');
    }
    out.push(report('V1 逐帧拖 b 20 帧（+100,+40）'));

    // --- 点击顺序 vs 文档顺序：谁当圆心 ---
    install([line('b', 100, 0, 150, 0, layer), line('a', 0, 0, 50, 0, layer)]);
    S().select(['a', 'b']); // 先点 a，但文档里 b 在前
    S().addConstraintAction('distance');
    out.push(report('D0 文档序 b,a；点击序 a,b'));

    console.log(JSON.stringify(out, null, 1));
    expect(out.length).toBe(8);
  });
});
