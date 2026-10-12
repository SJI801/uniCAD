#!/usr/bin/env node
/**
 * 把 Rust 几何内核编译为 WebAssembly，并把 JS 胶水层输出到 `src/wasm/pkg`，
 * 供前端 import 使用。
 *
 * 用法：
 *   node scripts/build-wasm.mjs           # release 构建
 *   node scripts/build-wasm.mjs --dev     # 更快的构建，体积更大
 *
 * 为什么不用 wasm-pack？wasm-pack 坚持下载并使用它自己指定版本的
 * `wasm-bindgen` 二进制，且自身依赖也需要 host C 工具链。本机既没有
 * Visual Studio 生成工具，也无法访问 static.rust-lang.org，所以这里直接
 * 驱动 `cargo --target wasm32-unknown-unknown`（该目标不需要 C 链接器），
 * 之后单独调用 `wasm-bindgen-cli`。
 *
 * 为什么用 `--target web` 而不是 `bundler`？`bundler` 目标会生成
 *   `import * as wasm from "./xxx_bg.wasm"`
 * 这种原生 ESM wasm 集成写法，而 Vite 6 已不再支持（会报
 * "ESM integration proposal for Wasm is not supported"）。`web` 目标改为
 * 暴露一个显式的 `init(module_or_path)`，前端配合 `?url` 导入即可，Vite 全程
 * 不需要额外插件。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const KERNEL_DIR = join(ROOT, 'kernel');
const OUT_DIR = join(ROOT, 'src', 'wasm', 'pkg');

const dev = process.argv.includes('--dev');
const profile = dev ? 'debug' : 'release';

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function run(cmd, args, opts = {}) {
  process.stdout.write(`\x1b[36m$ ${cmd} ${args.join(' ')}\x1b[0m\n`);
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  if (res.status !== 0) {
    process.stderr.write(`\x1b[31m✗ 命令失败，退出码 ${res.status}\x1b[0m\n`);
    process.exit(res.status ?? 1);
  }
}

function has(cmd, args = ['--version']) {
  const res = spawnSync(cmd, args, {
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  return res.status === 0;
}

/** 定位 wasm-bindgen-cli，优先 PATH，其次 cargo 的安装位置。 */
function findWasmBindgen() {
  if (has('wasm-bindgen')) return 'wasm-bindgen';

  const home = os.homedir();
  const candidates = [
    join(ROOT, 'tools', 'bin', 'wasm-bindgen'),
    join(home, '.cargo', 'bin', 'wasm-bindgen'),
    join(home, '.workbuddy', 'bin', 'wasm-bindgen'),
  ];
  for (const c of candidates) {
    const exe = process.platform === 'win32' ? `${c}.exe` : c;
    if (existsSync(exe)) return exe;
  }
  return null;
}

/**
 * 选取能真正链接 host build-script 的工具链。
 *
 * 本机的 MSVC host 工具链没有可用的链接器（未安装 VS C++ 生成工具，且 Git
 * Bash 自带的 GNU `link.exe` 会遮蔽 MSVC 链接器），因此只要存在 GNU 工具链就
 * 优先使用它。wasm 目标本身不受影响。
 */
function pickCargo() {
  const home = os.homedir();
  const gnuBin = join(home, '.rustup', 'toolchains', 'stable-x86_64-pc-windows-gnu', 'bin');
  const gnuCargo = join(gnuBin, process.platform === 'win32' ? 'cargo.exe' : 'cargo');
  if (existsSync(gnuCargo)) {
    // GNU host 需要一个真实的 C 链接器（MinGW）。把它前置到 PATH，否则
    // rustc 会找不到 gcc 而回退到那个坏掉的 link.exe。
    const mingw = 'C:/ProgramData/mingw64/mingw64/bin';
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    const merged = existsSync(mingw)
      ? `${mingw};${process.env[pathKey] ?? ''}`
      : process.env[pathKey] ?? '';
    return { cargo: gnuCargo, gnuBin, env: { [pathKey]: merged } };
  }
  return { cargo: 'cargo', gnuBin: null, env: {} };
}

// ---------------------------------------------------------------------------
// 构建
// ---------------------------------------------------------------------------

console.log('\x1b[1m◈ uniCAD kernel → WebAssembly\x1b[0m');
console.log(`  profile   : ${profile}`);
console.log(`  out dir   : ${OUT_DIR}\n`);

if (!existsSync(KERNEL_DIR)) {
  console.error(`\x1b[31m✗ 未找到 kernel 目录：${KERNEL_DIR}\x1b[0m`);
  process.exit(1);
}

const { cargo, gnuBin, env } = pickCargo();
if (gnuBin) {
  // `rustup run` 才能保证 rustc 也来自 GNU 工具链（GNU 工具链的 bin 里没有
  // rustc，它是通过 rustup shim 分发的）。
  console.log('  host 工具链 : stable-x86_64-pc-windows-gnu');
}

// 1. 确保 wasm 目标已安装。
const targetProbe = spawnSync('rustup', ['target', 'list', '--installed'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
  env: { ...process.env, ...env },
});
if (!String(targetProbe.stdout ?? '').includes('wasm32-unknown-unknown')) {
  console.log('  正在安装 wasm32-unknown-unknown 目标...');
  run('rustup', ['target', 'add', 'wasm32-unknown-unknown'], { env });
}

// 2. 编译 crate。用 `rustup run` 显式指定 GNU 工具链，确保 rustc 与 cargo 配对。
const cargoArgs = ['build', '--target', 'wasm32-unknown-unknown'];
if (!dev) cargoArgs.push('--release');

const cargoCmd = gnuBin
  ? { cmd: 'rustup', args: ['run', 'stable-x86_64-pc-windows-gnu', 'cargo', ...cargoArgs] }
  : { cmd: cargo, args: cargoArgs };

run(cargoCmd.cmd, cargoCmd.args, {
  cwd: KERNEL_DIR,
  env: {
    ...env,
    // 避免 cargo 跑到用户的全局 target 目录。
    CARGO_TARGET_DIR: join(KERNEL_DIR, 'target'),
  },
});

// 3. 定位产出的 .wasm。
const wasmPath = join(KERNEL_DIR, 'target', 'wasm32-unknown-unknown', profile, 'unicad_kernel.wasm');
if (!existsSync(wasmPath)) {
  console.error(`\x1b[31m✗ 未找到预期的 wasm 产物：${wasmPath}\x1b[0m`);
  const dir = join(KERNEL_DIR, 'target', 'wasm32-unknown-unknown', profile);
  if (existsSync(dir)) {
    console.error('  该目录内容：');
    for (const f of readdirSync(dir)) console.error(`    ${f}`);
  }
  process.exit(1);
}
const wasmBytes = statSync(wasmPath).size;
console.log(`\n  ✓ 编译完成 ${(wasmBytes / 1024).toFixed(1)} KB → ${wasmPath}`);

// 4. 运行 wasm-bindgen，输出 JS 胶水层 + 优化后的 wasm。
const bindgen = findWasmBindgen();
if (!bindgen) {
  console.error('\x1b[31m✗ 未找到 wasm-bindgen CLI。\x1b[0m');
  console.error('  安装方式：');
  console.error('    cargo install wasm-bindgen-cli --version 0.2.129');
  console.error('  或确认它在 PATH 上。\n');
  console.error(`  原始 wasm 仍然可用：\n    ${wasmPath}`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

run(bindgen, [
  '--target', 'web',
  '--out-dir', OUT_DIR,
  '--out-name', 'unicad_kernel',
  '--no-typescript',
  wasmPath,
]);

// 5. `web` 目标把 wasm 放在同目录，已经是我们要的位置；只做一次存在性校验。
const outWasm = join(OUT_DIR, 'unicad_kernel_bg.wasm');
if (!existsSync(outWasm)) {
  // 某些 wasm-bindgen 版本会把产物写到 cwd，兜底搬运一次。
  const stray = join(ROOT, 'unicad_kernel_bg.wasm');
  if (existsSync(stray)) copyFileSync(stray, outWasm);
}
if (!existsSync(outWasm)) {
  console.error(`\x1b[31m✗ wasm-bindgen 未生成 ${outWasm}\x1b[0m`);
  process.exit(1);
}

console.log(`\n\x1b[32m✓ 内核构建完成 → ${OUT_DIR}\x1b[0m`);
console.log(`  wasm 体积: ${(statSync(outWasm).size / 1024).toFixed(1)} KB`);
console.log('  前端从 "@/wasm/pkg/unicad_kernel.js" 导入\n');
