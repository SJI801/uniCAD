/**
 * 内核 distance 收敛性扫描：固定 a=(0,0)-(50,0)、value=50，
 * 把 b 的 start 放在以 a.end 为圆心、半径 R 的各个方向上，只放 b 求解。
 * 每个方向都应解回半径 50 的圆上（最近点）。
 */
import { readFileSync } from 'node:fs';
import init, { solve_constraints } from './src/wasm/pkg/unicad_kernel.js';

await init(readFileSync('./src/wasm/pkg/unicad_kernel_bg.wasm'));

const line = (ax, ay, bx, by) => [0, ax, ay, bx, by];

function solveOne(R, deg, value = 50) {
  const th = (deg * Math.PI) / 180;
  const p = { x: 50, y: 0 }; // a.end
  const q = { x: p.x + R * Math.cos(th), y: p.y + R * Math.sin(th) };
  const prims = [line(0, 0, 50, 0), line(q.x, q.y, q.x + 50, q.y)];
  const con = [9, 0, 2, 0, 1, 1, 0, value]; // distance, a=0.end, b=1.start
  const out = solve_constraints(
    Float64Array.from(prims.flat()),
    Uint32Array.from(prims.map((x) => x.length)),
    Float64Array.from(con),
    Uint8Array.from([0, 1]),
  );
  const got = { x: out[3 + 5 + 1], y: out[3 + 5 + 2] };
  const dist = Math.hypot(got.x - p.x, got.y - p.y);
  // 正解：从 q 沿 (q-p) 方向落到半径 value 的圆上
  const ux = (q.x - p.x) / R, uy = (q.y - p.y) / R;
  const want = { x: p.x + value * ux, y: p.y + value * uy };
  return {
    R, deg, ok: out[0], iters: out[1],
    resid: Number(out[2].toFixed(6)),
    finalDist: Number(dist.toFixed(6)),
    errVsNearest: Number(Math.hypot(got.x - want.x, got.y - want.y).toFixed(6)),
  };
}

console.log('value=50，a.end=(50,0) 固定，只放 b —— 期望 finalDist=50、errVsNearest≈0\n');
const R_EXACT = Math.hypot(80, 40); // = 89.44271909999159，即 store 里 b 被拖到 (130,40)
const angles = [];
for (let d = 0; d <= 40; d += 2) angles.push(d);
angles.push((Math.atan2(40, 80) * 180) / Math.PI); // 26.56505117707799
for (const deg of angles) {
  const r = solveOne(R_EXACT, deg);
  console.log(
    `  deg=${deg.toFixed(4).padStart(9)}  ok=${r.ok}  iters=${String(r.iters).padStart(2)}` +
      `  resid=${String(r.resid).padStart(12)}  finalDist=${String(r.finalDist).padStart(12)}`,
  );
}
console.log('');
for (const R of [60, 150]) {
  const rows = [];
  for (let deg = 0; deg < 360; deg += 30) rows.push(solveOne(R, deg));
  const bad = rows.filter((r) => r.ok === 0 || r.finalDist > 50.001);
  console.log(`R=${R}: 共 ${rows.length} 个方向，未收敛/没回到圆上的 ${bad.length} 个`);
  for (const r of rows) {
    console.log(
      `  deg=${String(r.deg).padStart(3)}  ok=${r.ok}  iters=${String(r.iters).padStart(2)}` +
        `  resid=${String(r.resid).padStart(10)}  finalDist=${String(r.finalDist).padStart(10)}` +
        `  errVsNearest=${String(r.errVsNearest).padStart(10)}`,
    );
  }
  console.log('');
}
