/**
 * ROADMAP 0.4「全约束草图的 UI」的验收探针 —— 真 store + 真 wasm，在进程内跑。
 *
 * 运行：npx vitest run --config _vitest.probe.config.mjs _probe_fully_defined
 *
 * 0.4 的验收句是「开启后拖不动，改尺寸才动」。这句话有两个缺口，这一版各补一个：
 *
 * 1. 「拖不动」原来只拦画布拖动，属性面板 / 变换 / 分解照样能改几何 —— 那不是
 *    「只允许改尺寸」。现在关卡在 store 的几何入口上（`refusesGeometryEdit`）。
 * 2. 「完全定义」原来**不可能**达到：没有锚点约束，整张草图永远留着刚体平移
 *    （和转动）自由度。现在 `固定` 把具名点钉在当前位置，dof 能真的到 0。
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
const { useEditor, commandRewritesGeometry, refusesGeometryEdit } = await import(
  './src/state/editorStore'
);
const { command, addEntity, removeEntity } = await import('./src/core/history');
const { constraintBadges } = await import('./src/render/constraintMarks');
const { serializeDocument, deserializeDocument } = await import('./src/io/json');

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
  S().setFullyConstrained(false);
}

function entity(id: string): Record<string, unknown> {
  return S().doc.entities.find((e) => e.id === id) as unknown as Record<string, unknown>;
}

function dof(): number {
  const r = S().constraintReport;
  expect(r, 'constraintReport 必须已经算出来').not.toBeNull();
  return r!.dof;
}

function translate(e: unknown, dx: number, dy: number): unknown {
  const x = e as { type: string } & Record<string, unknown>;
  if (x.type === 'line') {
    const l = x as unknown as { a: Pt; b: Pt };
    return { ...x, a: { x: l.a.x + dx, y: l.a.y + dy }, b: { x: l.b.x + dx, y: l.b.y + dy } };
  }
  const c = x as unknown as { center: Pt };
  return { ...x, center: { x: c.center.x + dx, y: c.center.y + dy } };
}

/** 「上一次操作被拒绝了吗」：看日志里有没有那条锁的说明。 */
function lastLogSaysLocked(): boolean {
  return S().log.some((l) => l.includes('完全定义') && l.includes('锁定'));
}

function clearLog(): void {
  S().clearLog();
}

// ---------------------------------------------------------------------------
// ① 锚点：让「完全定义」到得了
// ---------------------------------------------------------------------------

describe('0.4-① 锚点约束（固定）让 dof 到 0', () => {
  it('固定一条直线 → 4 条锚点 → 自由度 0，且不在同一处的线拉得回来', () => {
    const layer = S().doc.currentLayer;
    install([line('L', 10, 20, 60, 20, layer)]);
    S().select(['L']);

    // 没见过锚点之前，一条自由直线是 4 个自由度 —— 这正是 0.3 那个数字的来源。
    expect(dof()).toBe(4);

    S().addConstraintAction('fixedX');

    const cs = S().doc.constraints;
    expect(cs).toHaveLength(4);
    expect(cs.map((c) => c.kind).sort()).toEqual(['fixedX', 'fixedX', 'fixedY', 'fixedY']);
    expect(cs.filter((c) => c.kind === 'fixedX').map((c) => c.value).sort((a, b) => a! - b!)).toEqual([
      10, 60,
    ]);
    expect(cs.every((c) => c.a.entity === 'L')).toBe(true);
    expect(dof()).toBe(0);

    // 「拖不动」在这个层面的含义：即使几何被挪走，求解也会把它拉回锚点。
    S().transformSelection((e) => translate(e, 33, 44), 'probe drag');
    const l = entity('L') as unknown as { a: Pt; b: Pt };
    expect(l.a.x).toBeCloseTo(10, 6);
    expect(l.a.y).toBeCloseTo(20, 6);
    expect(l.b.x).toBeCloseTo(60, 6);
    expect(l.b.y).toBeCloseTo(20, 6);
    expect(dof()).toBe(0);
  });

  it('固定圆 → 只钉圆心（半径仍是尺寸）→ 再标半径才到 0', () => {
    const layer = S().doc.currentLayer;
    install([circ('C', 7, -3, 20, layer)]);
    S().select(['C']);
    S().addConstraintAction('fixedX');
    expect(S().doc.constraints).toHaveLength(2);
    expect(dof()).toBe(1);

    S().addConstraintAction('radius'); // 种子值 = 当前半径
    expect(dof()).toBe(0);

    // 锁上之后改半径：圆心不动、半径变 —— 「改尺寸才动」。
    S().setFullyConstrained(true);
    const radiusId = S().doc.constraints.find((c) => c.kind === 'radius')!.id;
    S().setConstraintValueAction(radiusId, 35);
    const c = entity('C') as unknown as { center: Pt; radius: number };
    expect(c.radius).toBeCloseTo(35, 6);
    expect(c.center.x).toBeCloseTo(7, 6);
    expect(c.center.y).toBeCloseTo(-3, 6);
  });

  it('重复点「固定」只说已经存在，不再堆冗余约束', () => {
    const layer = S().doc.currentLayer;
    install([line('L', 0, 0, 40, 0, layer)]);
    S().select(['L']);
    S().addConstraintAction('fixedX');
    const n = S().doc.constraints.length;
    S().addConstraintAction('fixedX');
    expect(S().doc.constraints.length).toBe(n);
    expect(S().log.some((l) => l.includes('已经存在'))).toBe(true);
  });

  it('锚点值是坐标，可以是负数，并且能存盘读盘', () => {
    const layer = S().doc.currentLayer;
    install([line('L', -30, -12, 40, 8, layer)]);
    S().select(['L']);
    S().addConstraintAction('fixedX');
    const xs = S().doc.constraints.filter((c) => c.kind === 'fixedX').map((c) => c.value);
    expect(xs).toContain(-30);

    const text = serializeDocument(S().doc);
    const back = deserializeDocument(text);
    expect('error' in back).toBe(false);
    if ('error' in back) return;
    expect(back.doc.constraints).toHaveLength(4);
    expect(back.doc.constraints.filter((c) => c.kind === 'fixedX').map((c) => c.value)).toContain(-30);
  });
});

// ---------------------------------------------------------------------------
// ② 几何锁：只允许改尺寸
// ---------------------------------------------------------------------------

describe('0.4-② 完全定义锁住几何，但尺寸照常驱动', () => {
  it('属性面板改几何被拒；改外观仍然可以', () => {
    const layer = S().doc.currentLayer;
    install([line('L', 0, 0, 50, 0, layer), circ('C', 100, 0, 20, layer)]);
    // 让草图真的完全定义：线的两端点 + 圆的圆心 + 半径。
    S().select(['L']);
    S().addConstraintAction('fixedX');
    S().select(['C']);
    S().addConstraintAction('fixedX');
    S().addConstraintAction('radius');
    expect(dof()).toBe(0);

    S().setFullyConstrained(true);
    clearLog();
    const before = JSON.stringify(S().doc);

    // 几何：属性面板里把端点搬到别处 —— 必须被拒。
    S().updateEntityById('L', (e) => ({ ...e, a: { x: 999, y: 999 } }) as never, '改起点');
    expect(JSON.stringify(S().doc)).toBe(before);
    expect(lastLogSaysLocked()).toBe(true);

    // 外观：换图层 / 改颜色不碰几何 —— 必须放行，否则锁会把整张图变成只读。
    clearLog();
    S().updateEntityById('L', (e) => ({ ...e, color: '#ff00ff' }) as never, '改颜色');
    expect((entity('L') as { color: string | null }).color).toBe('#ff00ff');
    expect(lastLogSaysLocked()).toBe(false);

    // 解锁之后同一个编辑立即生效：`updateEntityById` 的既有契约是「**只放开
    // 伙伴**，被编辑对象自己不动」，所以这次改坐标会先落进文档。锚点没有消失，
    // 下一次任何解算都会把它拉回去 —— 断言这一条，才能说明「锁」和「锚点」是
    // 两件事：锁定的是**入口**，锚点锁的是**几何**。
    S().setFullyConstrained(false);
    S().updateEntityById('L', (e) => ({ ...e, a: { x: 999, y: 999 } }) as never, '改起点');
    expect((entity('L') as unknown as { a: Pt }).a.x).toBe(999);
    // 锚点没有被这次编辑弄丢：L 的 2 条 + 圆的 1 条（圆心）都还在。
    expect(
      S().doc.constraints.filter((c) => c.kind === 'fixedX' && c.a.entity === 'L'),
    ).toHaveLength(2);
    expect(
      S().doc.constraints.filter((c) => c.kind === 'fixedX' && c.a.entity === 'C'),
    ).toHaveLength(1);
    // 下一次解算（选中 L 后做一个原地变换触发）把它按回锚点。
    S().select(['L']);
    S().transformSelection((e) => e, '重新解算');
    expect((entity('L') as unknown as { a: Pt }).a.x).toBeCloseTo(0, 6);
    expect((entity('L') as unknown as { a: Pt }).a.y).toBeCloseTo(0, 6);
  });

  it('变换、分解、几何关系被拒；尺寸约束和固定放行', () => {
    const layer = S().doc.currentLayer;
    install([line('L', 0, 0, 50, 0, layer), line('M', 0, 30, 50, 30, layer)]);
    S().select(['L']);
    S().addConstraintAction('fixedX');
    S().setFullyConstrained(true);

    // 变换（拖动提交走的就是它）
    clearLog();
    const before = JSON.stringify(S().doc);
    S().transformSelection((e) => translate(e, 10, 10), '移动 1 个对象');
    expect(JSON.stringify(S().doc)).toBe(before);
    expect(lastLogSaysLocked()).toBe(true);

    // 交点分解
    clearLog();
    S().select(['L', 'M']);
    S().splitAtIntersections();
    expect(JSON.stringify(S().doc)).toBe(before);
    expect(lastLogSaysLocked()).toBe(true);

    // 几何关系（相切/平行…）会让几何移动 → 拒
    clearLog();
    S().select(['L', 'M']);
    S().addConstraintAction('parallel');
    expect(S().doc.constraints.some((c) => c.kind === 'parallel')).toBe(false);
    expect(lastLogSaysLocked()).toBe(true);

    // 尺寸驱动 → 放行（这就是「只允许改尺寸」里被允许的那一半）。
    // 注意「线的长度」走的是 `setDimensionAction`（0.2 的路径），不是
    // `addConstraintAction('distance')` —— 后者要选两条曲线才算距离。
    clearLog();
    S().setDimensionAction(
      'L',
      'distance',
      80,
      (e) => ({ ...e, b: { x: 80, y: (e as unknown as { a: Pt }).a.y } }) as never,
      '改长度',
    );
    expect(S().doc.constraints.some((c) => c.kind === 'distance')).toBe(true);
    expect(lastLogSaysLocked()).toBe(false);
    expect((entity('L') as unknown as { b: Pt }).b.x).toBeCloseTo(80, 6);

    // 固定自己（尺寸族）→ 放行。M 有 2 个具名点 ⇒ 4 条锚点，其中 fixedX 2 条。
    clearLog();
    S().select(['M']);
    S().addConstraintAction('fixedX');
    expect(S().doc.constraints.filter((c) => c.kind === 'fixedX')).toHaveLength(4);
    expect(S().doc.constraints.filter((c) => c.a.entity === 'M')).toHaveLength(4);
    expect(lastLogSaysLocked()).toBe(false);
  });

  it('拖动预览与回滚（__ 标签）永不被拦 —— 否则画布会卡在预览位置', () => {
    const layer = S().doc.currentLayer;
    install([line('L', 0, 0, 50, 0, layer)]);
    S().select(['L']);
    // 草图**没有**约束，所以求解不会把预览拉回来，能干净地只看「拦不拦」。
    // （有锚点时连预览都会被锚点拉回原位 —— 那是锚点该干的事，不是锁。）
    S().setFullyConstrained(true);

    const original = structuredClone(entity('L'));
    S().transformSelection((e) => translate(e, 12, 0), '__live_move');
    expect((entity('L') as unknown as { a: Pt }).a.x).toBeCloseTo(12, 6);

    S().transformSelection(() => structuredClone(original), '__revert_live_move');
    expect((entity('L') as unknown as { a: Pt }).a.x).toBeCloseTo(0, 6);
  });

  it('锁上时尺寸改值仍然驱动几何（锚点值也是尺寸）', () => {
    const layer = S().doc.currentLayer;
    install([line('L', 0, 0, 50, 0, layer)]);
    S().select(['L']);
    S().addConstraintAction('fixedX');
    S().setFullyConstrained(true);

    // 把「终点 x = 50」这条锚点改成 80：几何必须跟着走，这就是「改尺寸才动」。
    const endX = S().doc.constraints.find(
      (c) => c.kind === 'fixedX' && c.a.point === 'end',
    )!;
    S().setConstraintValueAction(endX.id, 80);
    expect((entity('L') as unknown as { b: Pt }).b.x).toBeCloseTo(80, 6);
    expect((entity('L') as unknown as { a: Pt }).a.x).toBeCloseTo(0, 6);
  });

  it('工具提交的命令：修剪（删+建）算改几何，绘制/删除/改色不算', () => {
    const layer = S().doc.currentLayer;
    install([line('L', 0, 0, 50, 0, layer), line('M', 10, -10, 10, 10, layer)]);
    const L = entity('L') as never;
    const M = entity('M') as never;
    const moved = (e: unknown) => translate(e, 5, 0) as never;

    // 修剪的形状：删掉原曲线 + 加回两段。
    expect(commandRewritesGeometry(command('修剪', removeEntity(S().doc, 'M')!, addEntity(L)))).toBe(
      true,
    );
    // 直线/圆/偏置：只新建。
    expect(commandRewritesGeometry(command('绘制直线', addEntity(L)))).toBe(false);
    // Delete 键：只删除。
    expect(commandRewritesGeometry(command('删除 1 个对象', removeEntity(S().doc, 'M')!))).toBe(
      false,
    );
    // 改颜色：update 但形状没变。
    expect(
      commandRewritesGeometry(
        command('改颜色', { op: 'update', before: L, after: { ...L, color: '#00ff00' } } as never),
      ),
    ).toBe(false);
    // 真几何改写：update 且形状变了。
    expect(
      commandRewritesGeometry(
        command('拉伸', { op: 'update', before: L, after: moved(L) } as never),
      ),
    ).toBe(true);

    // 而这条判据只在锁上时才有后果。
    S().setFullyConstrained(true);
    clearLog();
    const before = JSON.stringify(S().doc);
    // 走工具漏斗最内层的那两个函数（Workbench 的 commit 就是这一行）。
    const trim = command('修剪', removeEntity(S().doc, 'M')!, addEntity(L));
    if (commandRewritesGeometry(trim) && refusesGeometryEdit(S(), `「${trim.label}」`)) {
      /* 工具会在这里 return，什么都不提交 */
    }
    expect(JSON.stringify(S().doc)).toBe(before);
    expect(lastLogSaysLocked()).toBe(true);
    void M;
  });

  it('一条线的「固定」在画布上只画两枚「锁定」徽章，不是四个 X/Y', () => {
    const layer = S().doc.currentLayer;
    install([line('L', 10, 20, 60, 20, layer)]);
    S().select(['L']);
    S().addConstraintAction('fixedX');

    const ctx = {
      screenOf: (p: Pt) => ({ x: p.x * 2, y: p.y * 2 }),
      scale: 2,
      viewWidth: 1200,
      viewHeight: 800,
    };
    const badges = constraintBadges(S().doc, new Set(['L']), S().doc.entities, ctx);
    expect(badges.map((b) => b.text)).toEqual(['锁定', '锁定']);
    expect(badges[0]!.title).toContain('已固定');
    expect(badges[0]!.title).toContain('x =');
  });
});
