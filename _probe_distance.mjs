/**
 * 距离约束端到端探针 —— 用**真实 wasm 二进制**跑真实 FFI 调用，自己解码。
 * （沿用 2026-10-12 日志里被证明有效的验证手法：不做单测，直接过 wasm。）
 *
 * 运行：node _probe_distance.mjs
 */
import { readFileSync } from 'node:fs';
import init, { solve_constraints, version } from './src/wasm/pkg/unicad_kernel.js';

const bytes = readFileSync('./src/wasm/pkg/unicad_kernel_bg.wasm');
await init(bytes);

const PT = { none: 0, start: 1, end: 2, center: 3, vertex: 4 };
const KIND = { distance: 9, distanceX: 13, distanceY: 14 };

const line = (ax, ay, bx, by) => [0, ax, ay, bx, by];
const poly = (pts, closed = false) => [4, closed ? 1 : 0, pts.length, ...pts.flat()];

/** 前端 constraints.ts 的 applySolved —— 逐字照抄（已修版），用来核对解码。 */
function applySolved(type, buf) {
  switch (type) {
    case 'line':
      if (buf.length < 5) return null;
      return { a: { x: buf[1], y: buf[2] }, b: { x: buf[3], y: buf[4] } };
    case 'polyline': {
      const declared = Number.isFinite(buf[2]) ? Math.floor(buf[2]) : 0;
      const available = Math.floor((buf.length - 3) / 2);
      const count = Math.min(declared, available);
      if (count < 2) return null;
      const points = [];
      for (let i = 0; i < count; i++) points.push({ x: buf[3 + i * 2], y: buf[4 + i * 2] });
      return { points, closed: buf[1] !== 0 };
    }
    default:
      return null;
  }
}

/** 修复前的错版，保留作对照（顶点数被当成第一个坐标）。 */
function applySolvedBroken(type, buf) {
  if (type !== 'polyline') return applySolved(type, buf);
  const count = Math.floor((buf.length - 2) / 2);
  if (count < 2) return null;
  const points = [];
  for (let i = 0; i < count; i++) points.push({ x: buf[2 + i * 2], y: buf[3 + i * 2] });
  return { points, closed: buf[1] !== 0 };
}

/** 一条约束压成内核的 8 数块。 */
const con = (kind, aE, aP, aI, bE, bP, bI, value) => [kind, aE, aP, aI, bE, bP, bI, value];

function run(title, prims, kinds, constraints, moving) {
  const encoded = Float64Array.from(prims.flat());
  const counts = Uint32Array.from(prims.map((p) => p.length));
  const out = solve_constraints(encoded, counts, Float64Array.from(constraints.flat()), Uint8Array.from(moving));
  console.log(`\n=== ${title} ===`);
  if (!out || out.length < 3) {
    console.log('  内核返回空 → 前端会「保持现有几何」（等于约束无效）');
    return null;
  }
  console.log(`  ok=${out[0]} iters=${out[1]} maxResidual=${out[2]}`);
  let cursor = 3;
  prims.forEach((p, i) => {
    const slice = out.slice(cursor, cursor + p.length);
    cursor += p.length;
    const dec = applySolved(kinds[i], slice);
    console.log(`  [${i}] ${kinds[i]} wire=${JSON.stringify(Array.from(slice))}`);
    console.log(`      现码→ ${JSON.stringify(dec)}`);
    if (kinds[i] === 'polyline') {
      console.log(`      修前→ ${JSON.stringify(applySolvedBroken(kinds[i], slice))}`);
    }
  });
  return out;
}

console.log('kernel version =', version());

// ---------------------------------------------------------------------------
// 1. 点-点距离：两线，改值 50→80（ROADMAP 0.1 的验收路径）
// ---------------------------------------------------------------------------
const L0 = line(0, 0, 50, 0);
const L1 = line(60, 0, 90, 0);
run(
  '1. distance 点-点 value=80（a=线0终点, b=线1起点）, 只放线1',
  [L0, L1],
  ['line', 'line'],
  [con(KIND.distance, 0, PT.end, 0, 1, PT.start, 0, 80)],
  [0, 1],
);

// ---------------------------------------------------------------------------
// 2. distanceX：竖直拖开后 x 间距是否被拉回、y 是否自由
// ---------------------------------------------------------------------------
run(
  '2. distanceX value=80，线1 被拖到 (100,40)',
  [line(0, 0, 50, 0), line(100, 40, 150, 40)],
  ['line', 'line'],
  [con(KIND.distanceX, 0, PT.end, 0, 1, PT.start, 0, 80)],
  [0, 1],
);

// ---------------------------------------------------------------------------
// 3. distanceX 跨越基准：d=+1 与 d=-1 各解一次（看是否跳变）
// ---------------------------------------------------------------------------
run(
  '3a. distanceX value=80，线1 起点在基准右侧 1 单位 (x=51)',
  [line(0, 0, 50, 0), line(51, 40, 101, 40)],
  ['line', 'line'],
  [con(KIND.distanceX, 0, PT.end, 0, 1, PT.start, 0, 80)],
  [0, 1],
);
run(
  '3b. distanceX value=80，线1 起点在基准左侧 1 单位 (x=49)',
  [line(0, 0, 50, 0), line(49, 40, 99, 40)],
  ['line', 'line'],
  [con(KIND.distanceX, 0, PT.end, 0, 1, PT.start, 0, 80)],
  [0, 1],
);

// ---------------------------------------------------------------------------
// 4. distanceY：同理
// ---------------------------------------------------------------------------
run(
  '4. distanceY value=60，线1 被拖到 (0,100) 上方',
  [line(0, 0, 50, 0), line(0, 100, 50, 100)],
  ['line', 'line'],
  [con(KIND.distanceY, 0, PT.end, 0, 1, PT.start, 0, 60)],
  [0, 1],
);

// ---------------------------------------------------------------------------
// 5b. 新增的「圆心钉扎」（withConstraintRepair 的 adjusted + pinNamedPoint）
//     模拟：距离类约束 a 端图元被拖动时会发生什么
// ---------------------------------------------------------------------------
const circle = (x, y, r) => [1, x, y, r];

function pinSim(title, prims, kinds, constraints, moving, draggedIndex, delta) {
  // 1) 用户拖动后的几何（edit）
  const edited = prims.map((p, i) => {
    if (i !== draggedIndex) return p.slice();
    return kinds[i] === 'circle'
      ? [1, p[1] + delta[0], p[2] + delta[1], p[3]]
      : [0, p[1] + delta[0], p[2] + delta[1], p[3] + delta[0], p[4] + delta[1]];
  });
  // 2) withConstraintRepair 的 adjusted：把 a 端命名点按回原位（此处只模拟 circle center / line end）
  const pinned = edited.map((p, i) => {
    const c = constraints.find((k) => k[0] !== undefined && k[1] === i);
    if (!c) return p;
    const pre = prims[i];
    if (kinds[i] === 'circle') return [1, pre[1], pre[2], p[3]]; // center := 原圆心
    if (kinds[i] === 'line') return [0, p[1], p[2], pre[3], pre[4]]; // end := 原终点（a=end）
    return p;
  });
  const out = solve_constraints(
    Float64Array.from(pinned.flat()),
    Uint32Array.from(pinned.map((p) => p.length)),
    Float64Array.from(constraints.flat()),
    Uint8Array.from(moving),
  );
  console.log(`\n=== ${title} ===`);
  console.log(`  拖动 Δ=(${delta})，钉扎后交内核`);
  console.log(`  结果: ok=${out[0]} iters=${out[1]} maxResid=${out[2]}`);
  prims.forEach((p, i) => {
    const n = p.length;
    const before = p.slice();
    const after = out.slice(3 + prims.slice(0, i).reduce((s, q) => s + q.length, 0), 3 + prims.slice(0, i).reduce((s, q) => s + q.length, 0) + n);
    console.log(`  [${i}] ${kinds[i]} 原=${JSON.stringify(before)} 拖后=${JSON.stringify(edited[i])} 最终=${JSON.stringify(Array.from(after))}`);
  });
}

// 两圆：a=圆0 圆心(0,0) r5，b=圆1 圆心(30,40) r5，距离 = 50（当前值）
const C0 = circle(0, 0, 5);
const C1 = circle(30, 40, 5);
const circleDist = [con(KIND.distance, 0, PT.center, 0, 1, PT.center, 0, 50)];
pinSim('5b-1. 拖 **a 端**圆（有心钉扎）', [C0, C1], ['circle', 'circle'], circleDist, [1, 0], 0, [10, 10]);
pinSim('5b-2. 拖 **b 端**圆（无钉扎）', [C0, C1], ['circle', 'circle'], circleDist, [0, 1], 1, [10, 10]);
// 两线：a=线0 终点(50,0)，b=线1 起点(100,0)，距离 = 50（对齐距离）
const LA = line(0, 0, 50, 0);
const LB = line(100, 0, 150, 0);
const lineDist = [con(KIND.distance, 0, PT.end, 0, 1, PT.start, 0, 50)];
pinSim('5b-3. 拖 **a 端**线（终点被钉）', [LA, LB], ['line', 'line'], lineDist, [1, 0], 0, [10, 10]);

// ---------------------------------------------------------------------------
// 7. store 探针里出现「解不回去」的那个精确场景：a=(0,0)-(50,0) 固定，
//    b 被拖到 (130,40)-(180,40)，distance a.end↔b.start value=50
// ---------------------------------------------------------------------------
run(
  '7. distance value=50，b 拖到 (130,40)-(180,40)，只放 b',
  [line(0, 0, 50, 0), line(130, 40, 180, 40)],
  ['line', 'line'],
  [con(KIND.distance, 0, PT.end, 0, 1, PT.start, 0, 50)],
  [0, 1],
);

// ---------------------------------------------------------------------------
// 6. 多段线 + 线 的距离约束：暴露 applySolved 的 polyline 解码偏移
// ---------------------------------------------------------------------------
run(
  '6. distance 点-点（多段线顶点 ↔ 线起点）value=50，只放多段线',
  [poly([[0, 0], [10, 0], [20, 0]]), line(100, 0, 200, 0)],
  ['polyline', 'line'],
  [con(KIND.distance, 0, PT.vertex, 2, 1, PT.start, 0, 50)],
  [1, 0],
);
