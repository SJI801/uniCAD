/// <reference types="vite/client" />

// CSS 侧载声明 —— Vite 会把 `import './x.css'` 处理成注入样式表。
declare module '*.css' {
  const css: string;
  export default css;
}

declare module '*.svg' {
  const src: string;
  export default src;
}

declare module '*.png' {
  const src: string;
  export default src;
}

// ---------------------------------------------------------------------------
// WASM 内核胶水层
// ---------------------------------------------------------------------------
// `src/wasm/pkg/` 由 `npm run wasm`（scripts/build-wasm.mjs → wasm-bindgen）
// 生成，不在版本库里，因此这里补一份最小声明，让 `tsc --noEmit` 在没有产物
// 的干净检出上也能通过。真实类型由 src/core/kernel.ts 的 KernelModule 接口
// 在运行时校验。
declare module '@wasm/pkg/unicad_kernel.js' {
  export interface VertexBuffer {
    len(): number;
    is_empty(): boolean;
    clear(): void;
    reserve(cap: number): void;
    to_f32_array(): Float32Array;
    free(): void;
  }

  export interface PointBuffer {
    len(): number;
    is_empty(): boolean;
    clear(): void;
    reserve(cap: number): void;
    to_f64_array(): Float64Array;
    free(): void;
  }

  export interface SnapResult {
    x: number;
    y: number;
    kind: number;
    entity: number;
    distance: number;
    has_value: boolean;
    free(): void;
  }

  export class SceneTessellator {
    constructor(tol: number, maxSeg: number);
    vertex_len(): number;
    strips(): Uint32Array;
    set_tolerance(tol: number, maxSeg: number): void;
    tessellate(encoded: Float64Array, counts: Uint32Array): void;
    vertex_array(): Float32Array;
    free(): void;
  }

  export function version(): string;
  export function snap_kind_values(): Uint8Array;
  export function encoding_size(encoded: Float64Array): number;

  /** wasm-bindgen `web` 目标的初始化入口：传入 wasm 的 URL 或模块。 */
  export default function init(
    module_or_path?: string | URL | ArrayBuffer | WebAssembly.Module | Response | Promise<Response>,
  ): Promise<unknown>;
}

declare module '@wasm/pkg/unicad_kernel_bg.wasm?url' {
  const url: string;
  export default url;
}
