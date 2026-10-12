/**
 * WebGL2 renderer.
 *
 * Strategy
 * --------
 * CAD scenes are dominated by line work, so the renderer is a single batched
 * line pipeline rather than a scene graph:
 *
 * 1. The geometry kernel tessellates every entity into a flat `[x, y]` vertex
 *    stream plus per-entity strip ranges (`SceneBuffer.run`).
 * 2. We expand that stream into line segments once and upload it as one
 *    `ARRAY_BUFFER`. Attribute 0 is position; attribute 1 is a per-vertex
 *    colour packed as a `Uint32`.
 * 3. Selection / hover state is expressed by *rewriting the colour attribute
 *    only* — no geometry re-upload — so highlighting a 50k-entity scene costs
 *    a few kilobytes of upload instead of a full re-tessellation.
 *
 * Overlays (grid, axes, crosshair, selection rubber-band, snap markers) use
 * their own small dynamic buffers so they never disturb the main batch.
 */

import type { Aabb, Mat, Vec2 } from '../core/types';
import { clipMatrixOf } from './camera';

export interface RenderStyle {
  /** `#rrggbb` */
  color: string;
  /** Screen-space width in CSS pixels. */
  width: number;
  /** Dash pattern in screen pixels; `null` = solid. */
  dash: number[] | null;
}

export interface BatchEntry {
  /** Index of the first vertex in the entity's strip. */
  start: number;
  /** Vertex count (one more than the segment count). */
  count: number;
  style: RenderStyle;
}

/**
 * Point sprite vertex stage — snap markers, grips, vertex dots.
 *
 * `gl_PointSize` is measured in **device** pixels, so the CSS-pixel size has to
 * be multiplied by `u_dpr`. Forgetting that makes every marker a single device
 * pixel wide and effectively invisible on a HiDPI screen.
 *
 * The device-pixel diameter is forwarded to the fragment stage because the disc
 * edge is feathered by the same analytic rule as the line strokes.
 */
const POINT_VERT_SRC = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_pos;    // model space
layout(location = 1) in vec4 a_color;
layout(location = 2) in float a_size;  // diameter, CSS px

uniform mat3 u_view;      // model -> clip
uniform float u_dpr;      // device px per CSS px

out vec4 v_color;
out float v_sizeDev;      // diameter, device px

void main() {
  vec3 p = u_view * vec3(a_pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, p.z);
  float sizeDev = max(a_size * u_dpr, 1.0);
  gl_PointSize = sizeDev;
  v_sizeDev = sizeDev;
  v_color = a_color;
}
`;

/**
 * Circular point sprite with an analytic edge.
 *
 * `gl.POINTS` rasterises a square; grips and snap markers have to read as discs,
 * so the corners are faded out. Doing it analytically (rather than `discard` plus
 * MSAA) keeps markers the same size relative to the strokes they sit on, and
 * keeps their edges as smooth as the strokes'.
 */
const POINT_FRAG_SRC = `#version 300 es
precision highp float;

in vec4 v_color;
in float v_sizeDev;

out vec4 outColor;

void main() {
  // Distance from the sprite centre in device pixels.
  float r = length(gl_PointCoord - vec2(0.5)) * v_sizeDev;
  float alpha = clamp(v_sizeDev * 0.5 + 0.5 - r, 0.0, 1.0);
  if (alpha <= 0.0) discard;
  outColor = vec4(v_color.rgb, v_color.a * alpha);
}
`;

/**
 * Flat-shaded solid mesh stage.
 *
 * Consumes the kernel's interleaved [x, y, z, nx, ny, nz] stream plus a 4x4
 * view-projection. Flat shading is baked into the *vertices* — the kernel emits
 * a separate normal per face — so the fragment stage is a single Lambert term.
 * There is no per-pixel normal interpolation to get wrong, and a CAD solid reads
 * as faceted the way a machined part does.
 */
const MESH_VERT_SRC = `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_pos;   // model space, Z up
layout(location = 1) in vec3 a_nrm;

uniform mat4 u_mvp;

out vec3 v_nrm;

void main() {
  v_nrm = a_nrm;
  gl_Position = u_mvp * vec4(a_pos, 1.0);
}
`;

/**
 * One Lambert term against a fixed head-light, plus ambient.
 *
 * abs() rather than a clamp on the dot product: a face whose normal happens to
 * point away from the light would otherwise flash black, and Phase 1 draws both
 * sides of every wall.
 */
const MESH_FRAG_SRC = `#version 300 es
precision highp float;

in vec3 v_nrm;

uniform vec3 u_color;

out vec4 outColor;

void main() {
  vec3 n = normalize(v_nrm);
  float lambert = abs(dot(n, normalize(vec3(0.35, 0.45, 0.82))));
  float shade = 0.34 + 0.66 * lambert;
  outColor = vec4(u_color * shade, 1.0);
}
`;

/**
 * Unshaded 3D line stage — datum-plane borders and axis triads.
 *
 * Separate from the mesh stage because these lines are *annotation*: they carry
 * a flat colour and must not be lit. A lit axis would change brightness as you
 * orbit, and a reference that flickers reads as geometry rather than as a datum.
 */
const LINE3D_VERT_SRC = `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_pos;

uniform mat4 u_mvp;

void main() {
  gl_Position = u_mvp * vec4(a_pos, 1.0);
}
`;

const LINE3D_FRAG_SRC = `#version 300 es
precision highp float;

uniform vec3 u_color;

out vec4 outColor;

void main() {
  outColor = vec4(u_color, 1.0);
}
`;

/**
 * Screen-space-width line strokes with **analytic** anti-aliasing.
 *
 * Every segment is expanded into a quad in the *vertex* stage. The corners are
 * offset **after** the model→screen hop, which is what makes the stroke width
 * independent of the zoom level.
 *
 * The one thing that must never drift is which space each value lives in:
 *
 *   model --u_view--> clip --/w, viewport--> CSS px --+ normal*halfw--> CSS px --viewport--> clip
 *
 * A previous revision declared a second `u_viewRigid` matrix documented as
 * "model → CSS px" and then fed it the *clip* matrix. Nothing errored — GLSL
 * simply stripped the unused declaration, `getUniformLocation` returned `null`,
 * and every vertex collapsed into one corner of the canvas. Hence the single
 * source of truth below: one clip matrix, one CSS-pixel viewport, and the
 * px↔NDC round trip written out explicitly.
 *
 * Why the edges are feathered analytically instead of left to MSAA
 * -----------------------------------------------------------------
 * The stroke is only ~1.4 CSS px wide, so a quad edge lands almost exactly on
 * a pixel centre and the *entire* impression of thickness comes from the
 * partial-coverage value of one or two pixels. Leaving that to MSAA means the
 * result depends on where the multisample positions happen to fall: along a
 * tessellated curve the sub-pixel phase of the centreline advances with the
 * chord direction, so coverage oscillated between "one crisp pixel" and
 * "two ghost pixels" with a period locked to the subdivision — measured as a
 * 40 %+ variation in apparent stroke width around a single circle.
 *
 * Carrying the signed distance to the centreline down to the fragment stage
 * and turning it into coverage makes the ramp a property of the *geometry*,
 * not of the sample grid: the stroke then measures exactly `2 * halfwidth`
 * with a one-device-pixel feather, at every angle and every zoom.
 */
const LINE_VERT_SRC = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_pos;        // model space
layout(location = 1) in vec2 a_normal;     // screen-space (y-down) offset direction
layout(location = 2) in float a_side;      // -1 / +1
layout(location = 3) in vec4 a_color;
layout(location = 4) in float a_halfwidth; // CSS px, miter-compensated
layout(location = 5) in float a_arc;       // distance along the run, CSS px
layout(location = 6) in vec4 a_dash;       // (period, on0End, on1Start, on1End), CSS px

uniform mat3 u_view;      // model -> clip
uniform vec2 u_viewport;  // CSS px
uniform float u_aa;       // feather radius, CSS px (0.5 device px / dpr)

out vec4 v_color;
out float v_ext;          // |offset| at the outer edge of the quad
out float v_off;          // signed offset of this vertex from the centreline
out float v_arc;
out vec4 v_dash;

void main() {
  v_color = a_color;
  v_arc = a_arc;
  v_dash = a_dash;

  // The quad is grown by the feather radius so the coverage ramp has somewhere
  // to live; the geometric edge stays at a_halfwidth, which is where the ramp
  // reaches 0.5.
  float ext = a_halfwidth + u_aa;
  v_ext = ext;
  v_off = a_side * ext;

  vec3 clip = u_view * vec3(a_pos, 1.0);
  vec2 ndc = clip.xy / clip.z;

  // NDC -> CSS px. y flips: NDC grows upwards, CSS pixels grow downwards.
  vec2 px = vec2((ndc.x * 0.5 + 0.5) * u_viewport.x, (0.5 - ndc.y * 0.5) * u_viewport.y);
  px += a_normal * v_off;

  // Straight back to clip, undoing the flip.
  vec2 outNdc = vec2(px.x / u_viewport.x * 2.0 - 1.0, 1.0 - px.y / u_viewport.y * 2.0);
  gl_Position = vec4(outNdc, 0.0, 1.0);
}
`;

/**
 * Coverage from the interpolated distance to the centreline.
 *
 * `v_ext` is constant along a cross-section, so `v_ext - |v_off|` interpolates
 * to the true perpendicular distance from the centreline minus the edge
 * distance — 0 at the outer edge, `2 * u_aa` on the centreline. Dividing by the
 * ramp width turns it straight into coverage.
 *
 * This also means adjacent quads must share their joint edge exactly: with
 * alpha blending, any overlap would be composited twice and read as a dark
 * blob at every joint. That is `buildLineBatch`'s job (miter joins).
 *
 * Dashes
 * ------
 * Linetype patterns are **screen-space**, so they cannot be baked into the
 * geometry: the same polyline has to re-dash itself when the zoom changes, and
 * a batch built once per frame would have to be rebuilt on every wheel event
 * anyway. Instead each vertex carries its distance along the run (`a_arc`, in
 * CSS px) and the pattern for its entity (`a_dash`, see `packDash`); the
 * distance interpolates exactly, because arc length is an affine function of
 * position along a *straight* segment and each quad covers exactly one segment.
 *
 * That is also why dashing is not done by splitting the strip on the CPU: the
 * miter joints (below) are computed over the *undashed* vertex sequence, and
 * cutting the run up first would turn every joint inside a dash into a pair of
 * butt caps. Here the joins never see the pattern at all.
 */
const LINE_FRAG_SRC = `#version 300 es
precision highp float;

in vec4 v_color;
in float v_ext;
in float v_off;
in float v_arc;
in vec4 v_dash;

uniform float u_aa;

out vec4 outColor;

/**
 * Coverage of one "on" interval [s, e) at position p, feathering both ends
 * over 2 * aa.
 *
 * The feather is not cosmetic. A hard step here makes the ends of every dash
 * a per-fragment edge, and discard throws away all samples of a fragment at
 * once, so MSAA cannot smooth them — the dash ends would be visibly staircased
 * at every zoom. Treating the interval as a distance field puts them back on
 * the same footing as the stroke edges, which are feathered the same way.
 */
float intervalCoverage(float p, float s, float e, float aa) {
  if (e <= s) return 0.0;
  float d = min(p - s, e - p);
  return clamp(d / max(aa, 1e-6) * 0.5 + 0.5, 0.0, 1.0);
}

/**
 * Two "on" intervals per period cover every linetype we ship (see packDash).
 *
 * There is deliberately **no** "period too small, draw it solid" fallback here.
 * It looks like the obvious safety net — zoom out far enough and any pattern
 * becomes sub-pixel — but it cannot trigger: LINETYPE_DASHES is defined in
 * screen pixels and v_arc arrives already measured in screen pixels, so the
 * rendered period is constant at every zoom. Adding the branch would mean
 * shipping a code path no input can reach, and a comment justifying it with a
 * mechanism that does not exist.
 *
 * The pattern *does* get denser in the sense that a longer screen run holds more
 * periods — that is the intended reading of "screen-space pattern", not a
 * degradation. See verify:stroke --linestyle=dashed, which measures the period
 * at two different zooms and asserts it does not move.
 */
float dashCoverage(float arc, vec4 d, float aa) {
  float period = d.x;
  if (period <= 0.0) return 1.0;
  float p = arc - period * floor(arc / period);
  return max(
    intervalCoverage(p, 0.0, d.y, aa),
    intervalCoverage(p, d.z, d.w, aa)
  );
}

void main() {
  float d = v_ext - abs(v_off);
  float alpha = clamp(d / max(2.0 * u_aa, 1e-6), 0.0, 1.0);
  alpha *= dashCoverage(v_arc, v_dash, u_aa);
  if (alpha <= 0.0) discard;
  outColor = vec4(v_color.rgb, v_color.a * alpha);
}
`;

/**
 * Pack a linetype dash array into the `a_dash` vertex attribute.
 *
 * Input is the classic alternating `[on, off, on, off, ...]` list in CSS px
 * (`LINETYPE_DASHES`), starting **on**. Output is
 * `(period, on0End, on1Start, on1End)`; a pattern with a single on-run leaves
 * the second interval empty (`on1Start == on1End`), which `intervalCoverage`
 * reads as "contributes nothing".
 *
 * Two intervals is not a budget so much as a fact about the catalogue: the
 * longest pattern is `center` = `[18, 6, 4, 6]`, whose second on-run
 * (`[24, 28)`) is the dash-dot's dot. Anything with three runs would need a
 * third interval and a real lookup — at which point a 1D pattern texture wins
 * over more attributes. Until then, `verify:dash` asserts the packed form
 * reproduces the source pattern sampled per pixel, so a new linetype with three
 * on-runs cannot slip through silently.
 */
export function packDash(dash: readonly number[] | null | undefined): [number, number, number, number] {
  if (!dash || dash.length === 0) return [0, 0, 0, 0];
  let period = 0;
  for (const d of dash) period += d;
  if (!(period > 0)) return [0, 0, 0, 0];

  let t = 0;
  const on: Array<[number, number]> = [];
  for (let i = 0; i < dash.length; i += 2) {
    const s = t;
    const e = t + dash[i]!;
    if (e > s) on.push([s, Math.min(e, period)]);
    t = e + (i + 1 < dash.length ? dash[i + 1]! : 0);
  }
  const first = on[0];
  const second = on[1];
  return [
    period,
    first ? first[1] : 0,
    second ? second[0] : period,
    second ? second[1] : period,
  ];
}


/** 2D matrix as a 3x3 column-major array, ready for `uniformMatrix3fv`. */
function mat3FromAffine(m: Mat): Float32Array {
  // [a, b, c, d, e, f] row-major 2x3 → column-major 3x3
  // | a c e |
  // | b d f |
  // | 0 0 1 |
  return new Float32Array([m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1]);
}

/**
 * Longest a miter joint may extend, as a multiple of the stroke half-width.
 *
 * A joint between two segments meeting at angle θ needs the offset scaled by
 * `1 / cos(θ/2)`. That factor reaches 1 for a straight run and grows without
 * bound as the turn approaches 180° — a near-reversal (a "spike") would shoot a
 * vertex arbitrarily far from the path. Clamping keeps sharp-but-real corners
 * (a 90° corner needs 1.414) exact while bounding the damage on degenerate
 * geometry, where a bevel-like cap is the right answer anyway.
 */
const MITER_LIMIT = 4;

/**
 * Vertex layout of one segment's stroke quad.
 *
 * Two triangles have to share the **same** diagonal, otherwise the half of the
 * trapezoid on the far side of that diagonal is never rasterised. The corners:
 *
 *   A = the segment's start point, B = its end point, `-`/`+` = which side.
 *
 *   k : pos        side
 *   0 : A       -1        A-
 *   1 : B       +1        B+
 *   2 : B       -1        B-
 *   3 : A       +1        A+
 *   4 : B       +1        B+
 *   5 : A       -1        A-
 *
 * Triangles (0,1,2) = (A-, B+, B-) and (3,4,5) = (A+, B+, A-) are split along
 * A- ↔ B+ for both, and their union is the whole quad.
 *
 * This used to be written as `k % 3 === 0 ? A : B` for the position and
 * `k % 2 === 0 ? -1 : 1` for the side. Those two modular expressions disagree
 * about k = 5 (`k % 3` says A, `k % 2` says +1, but A must be -1), so the second
 * triangle degenerated to (A+, B+, B+) and the wedge between it and the first
 * triangle vanished — a wedge-shaped hole at the start of *every* segment. On a
 * straight run that is invisible; on a tessellated circle it turns the stroke
 * into a dashed line with a 10 px period, which is exactly how it was reported.
 */
const QUAD_AT_END = [false, true, true, false, true, false];
const QUAD_SIDE = [-1, 1, -1, 1, 1, -1];
const QUAD_VERTS = 6;

export function hexToRgba(hex: string, alpha = 1): [number, number, number, number] {
  let h = hex.trim();
  if (h.startsWith('#')) h = h.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return [1, 1, 1, alpha];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, alpha];
}

export class GlRenderer {
  readonly gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;

  private lineProgram: WebGLProgram;
  private pointProgram: WebGLProgram;
  private lineVao: WebGLVertexArrayObject;
  private pointVao: WebGLVertexArrayObject;

  private lineBuffer: WebGLBuffer;
  private lineNormalBuffer: WebGLBuffer;
  private lineSideBuffer: WebGLBuffer;
  private lineColorBuffer: WebGLBuffer;
  private lineWidthBuffer: WebGLBuffer;
  private lineArcBuffer: WebGLBuffer;
  private lineDashBuffer: WebGLBuffer;

  private pointBuffer: WebGLBuffer;
  private pointColorBuffer: WebGLBuffer;
  private pointSizeBuffer: WebGLBuffer;

  private uLineView: WebGLUniformLocation;
  private uLineViewport: WebGLUniformLocation;
  private uLineAa: WebGLUniformLocation;
  private uPointView: WebGLUniformLocation;
  private uPointDpr: WebGLUniformLocation;

  // --- 3D solid pass ------------------------------------------------------
  private meshProgram: WebGLProgram;
  private meshVao: WebGLVertexArrayObject;
  private meshBuffer: WebGLBuffer;
  private uMeshMvp: WebGLUniformLocation;
  private uMeshColor: WebGLUniformLocation;

  // --- 3D datum pass (planes, axis triads) --------------------------------
  private line3dProgram: WebGLProgram;
  private line3dVao: WebGLVertexArrayObject;
  private line3dBuffer: WebGLBuffer;
  private uLine3dMvp: WebGLUniformLocation;
  private uLine3dColor: WebGLUniformLocation;

  /**
   * Device pixels per CSS pixel, as last reported by `resize`.
   *
   * Needed by `drawPoints` because `gl_PointSize` is expressed in device pixels
   * while every size this renderer deals with is in CSS pixels.
   */
  private dpr = 1;

  /** Scratch arrays reused across frames to avoid per-frame allocation. */
  private posScratch = new Float32Array(0);
  private normScratch = new Float32Array(0);
  private sideScratch = new Float32Array(0);
  private colorScratch = new Uint8Array(0);
  private widthScratch = new Float32Array(0);
  /** `(period, on0End, on1Start, on1End)` per vertex — see `packDash`. */
  private dashScratch = new Float32Array(0);
  private lineVertexCount = 0;

  /**
   * Per-entity miter caches for the polyline currently being expanded.
   *
   * `segN` holds one unit normal per *segment*, `vNrm` one per *vertex* (the
   * bisector of its two neighbours) and `vMiter` the matching offset scale.
   * They live on the instance purely so a frame does not allocate.
   *
   * Note the indexing split: these three are **per entity** (they are private to
   * the expansion loop and sized by the longest entity), while the scratch
   * buffers backing uploaded attributes — including `arcScratch` — are addressed
   * by the **global** vertex index.
   */
  private segNScratch = new Float32Array(0);
  private vNrmScratch = new Float32Array(0);
  private vMiterScratch = new Float32Array(0);
  private arcScratch = new Float32Array(0);

  private ptPosScratch = new Float32Array(0);
  private ptColorScratch = new Uint8Array(0);
  private ptSizeScratch = new Float32Array(0);

  /**
   * Bytes currently allocated on the GPU for each buffer.
   *
   * Vertex buffers are grown in place and only reallocated when the incoming
   * batch no longer fits. Reallocating with `bufferData` on every frame is both
   * wasteful and fragile: when a driver refuses the allocation the buffer
   * silently keeps its previous, smaller size, and the `bufferSubData` that
   * follows then trips WebGL's own bounds check with
   * `INVALID_VALUE: bufferSubData: buffer overflow`.
   */
  private bufferBytes = new Map<WebGLBuffer, number>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      // A depth buffer has to be *requested at context creation* — it cannot be
      // added later. The 2D pass never enables DEPTH_TEST, so its strokes still
      // paint in submission order; the 3D mesh pass is the only thing that sorts
      // by depth.
      depth: true,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('uniCAD: WebGL2 is not available in this browser.');
    this.gl = gl;

    this.lineProgram = this.compile(LINE_VERT_SRC, LINE_FRAG_SRC);
    this.pointProgram = this.compile(POINT_VERT_SRC, POINT_FRAG_SRC);
    this.meshProgram = this.compile(MESH_VERT_SRC, MESH_FRAG_SRC);
    this.line3dProgram = this.compile(LINE3D_VERT_SRC, LINE3D_FRAG_SRC);

    this.uLineView = this.uniform(this.lineProgram, 'u_view');
    this.uLineViewport = this.uniform(this.lineProgram, 'u_viewport');
    this.uLineAa = this.uniform(this.lineProgram, 'u_aa');
    this.uPointView = this.uniform(this.pointProgram, 'u_view');
    this.uPointDpr = this.uniform(this.pointProgram, 'u_dpr');
    this.uMeshMvp = this.uniform(this.meshProgram, 'u_mvp');
    this.uMeshColor = this.uniform(this.meshProgram, 'u_color');
    this.uLine3dMvp = this.uniform(this.line3dProgram, 'u_mvp');
    this.uLine3dColor = this.uniform(this.line3dProgram, 'u_color');

    this.lineBuffer = this.makeBuffer();
    this.lineNormalBuffer = this.makeBuffer();
    this.lineSideBuffer = this.makeBuffer();
    this.lineColorBuffer = this.makeBuffer();
    this.lineWidthBuffer = this.makeBuffer();
    this.lineArcBuffer = this.makeBuffer();
    this.lineDashBuffer = this.makeBuffer();

    this.pointBuffer = this.makeBuffer();
    this.pointColorBuffer = this.makeBuffer();
    this.pointSizeBuffer = this.makeBuffer();

    this.meshBuffer = this.makeBuffer();
    this.line3dBuffer = this.makeBuffer();

    this.lineVao = this.makeLineVao();
    this.pointVao = this.makePointVao();
    this.meshVao = this.makeMeshVao();
    this.line3dVao = this.makeLine3dVao();

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0.09, 0.1, 0.12, 1);
  }

  // -------------------------------------------------------------------------
  // Setup helpers
  // -------------------------------------------------------------------------

  /**
   * Look up a uniform location, failing loudly if it is missing.
   *
   * GLSL deletes declarations the compiler can prove unused, and `gl.uniform*`
   * on a `null` location is *defined* to be a silent no-op. Together those two
   * facts let a shader edit turn the viewport blank while the console stays
   * clean. Resolving uniforms once, at construction, converts that whole class
   * of failure into an immediate, named exception.
   */
  private uniform(program: WebGLProgram, name: string): WebGLUniformLocation {
    const loc = this.gl.getUniformLocation(program, name);
    if (loc === null) {
      throw new Error(
        `uniCAD: 着色器 uniform「${name}」不存在——通常是被 GLSL 判定为未使用而优化掉了，请检查 main() 里是否真的读了它。`,
      );
    }
    return loc;
  }

  private compile(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const v = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(v, vs);
    gl.compileShader(v);
    if (!gl.getShaderParameter(v, gl.COMPILE_STATUS)) {
      throw new Error(`uniCAD vertex shader failed:\n${gl.getShaderInfoLog(v)}`);
    }
    const f = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(f, fs);
    gl.compileShader(f);
    if (!gl.getShaderParameter(f, gl.COMPILE_STATUS)) {
      throw new Error(`uniCAD fragment shader failed:\n${gl.getShaderInfoLog(f)}`);
    }
    const p = gl.createProgram()!;
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`uniCAD program link failed:\n${gl.getProgramInfoLog(p)}`);
    }
    gl.deleteShader(v);
    gl.deleteShader(f);
    return p;
  }

  private makeBuffer(): WebGLBuffer {
    const b = this.gl.createBuffer();
    if (!b) throw new Error('uniCAD: could not allocate a WebGL buffer.');
    return b;
  }

  /**
   * Interleaved mesh VAO — positions at location 0, normals at 1, 24-byte stride.
   *
   * One buffer read by two pointers: the kernel emits `x, y, z, nx, ny, nz` per
   * vertex, so the normal is the same buffer 12 bytes further in. No second
   * upload, and no way for the two to drift out of step.
   */
  private makeMeshVao(): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
    return vao;
  }

  /** Tightly-packed `x, y, z` — the datum pass has no normals to carry. */
  private makeLine3dVao(): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.line3dBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindVertexArray(null);
    return vao;
  }

  private makeLineVao(): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineNormalBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineSideBuffer);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineColorBuffer);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineWidthBuffer);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineArcBuffer);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 1, gl.FLOAT, false, 0, 0);

    // Dashes are carried per vertex rather than per draw call because the whole
    // frame — grid, entities, overlays — is a single `drawArrays`. A uniform
    // would apply one linetype to all of them. The cost is 4 floats per vertex
    // on top of the 6 the stroke already carries; the alternative (interning
    // patterns into a uniform table plus a per-vertex index) saves that but
    // adds a slot-management failure mode for a saving that only matters at
    // scene sizes this editor does not reach.
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineDashBuffer);
    gl.enableVertexAttribArray(6);
    gl.vertexAttribPointer(6, 4, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);
    return vao;
  }

  private makePointVao(): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointColorBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 0, 0);

    // Without this the per-point size is uploaded and then never read, and
    // every marker degenerates to a single pixel.
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointSizeBuffer);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);
    return vao;
  }

  // -------------------------------------------------------------------------
  // Frame lifecycle
  // -------------------------------------------------------------------------

  /**
   * Size the drawing surface.
   *
   * The backing store must be an integer number of *device* pixels that matches
   * the CSS box the element actually occupies. Setting `style.height` to a
   * fractional value while flooring the backing store leaves the browser to
   * rescale the whole canvas by ~0.2 % — which is an extra, invisible
   * resampling pass over every stroke, and it also puts `u_viewport` out of
   * step with the surface it describes.
   */
  resize(displayWidth: number, displayHeight: number, dpr: number): void {
    const ratio = dpr > 0 ? dpr : 1;
    const cssW = Math.max(1, Math.round(displayWidth));
    const cssH = Math.max(1, Math.round(displayHeight));
    const w = Math.max(1, Math.round(cssW * ratio));
    const h = Math.max(1, Math.round(cssH * ratio));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.dpr = ratio;
  }

  beginFrame(background = '#17191d'): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const [r, g, b, a] = hexToRgba(background, 1);
    gl.clearColor(r, g, b, a);
    // The depth bit is cleared even in 2D mode: leaving last frame's depths
    // around would make the first 3D frame after a mode switch sort against
    // stale values.
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  /**
   * Draw flat-shaded solids with depth sorting.
   *
   * One `drawArrays` per solid (there is no index buffer — the kernel emits
   * non-indexed triangles so each face can own its normal). Depth test and
   * blending are toggled *around* the pass and restored after, so the 2D strokes
   * drawn either side of it keep their submission-order, alpha-blended look.
   */
  drawMeshes(
    items: ReadonlyArray<{ verts: Float32Array; color: [number, number, number] }>,
    mvp: Float32Array,
  ): void {
    if (items.length === 0) return;
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    gl.useProgram(this.meshProgram);
    gl.uniformMatrix4fv(this.uMeshMvp, false, mvp);
    gl.bindVertexArray(this.meshVao);

    for (const it of items) {
      const floats = it.verts.length;
      if (floats < 18) continue;
      this.upload(this.meshBuffer, it.verts, floats, 4);
      gl.uniform3f(this.uMeshColor, it.color[0], it.color[1], it.color[2]);
      gl.drawArrays(gl.TRIANGLES, 0, floats / 6);
    }

    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
  }

  /**
   * Draw unshaded 3D line segments — datum-plane borders and axis triads.
   *
   * Depth-tested with `LEQUAL` rather than `LESS`: a plane's border and the
   * triad rising out of its own origin sit at the *same* depth where they meet,
   * and `LESS` would drop whichever was submitted second and leave a visible
   * notch at the corner.
   */
  drawLines3d(
    items: ReadonlyArray<{ verts: Float32Array; color: [number, number, number] }>,
    mvp: Float32Array,
  ): void {
    if (items.length === 0) return;
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    gl.useProgram(this.line3dProgram);
    gl.uniformMatrix4fv(this.uLine3dMvp, false, mvp);
    gl.bindVertexArray(this.line3dVao);

    for (const it of items) {
      const floats = it.verts.length;
      if (floats < 6) continue;
      this.upload(this.line3dBuffer, it.verts, floats, 4);
      gl.uniform3f(this.uLine3dColor, it.color[0], it.color[1], it.color[2]);
      gl.drawArrays(gl.LINES, 0, floats / 3);
    }

    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
  }

  /**
   * Begin a fresh line batch.
   *
   * Every frame must start with this. `buildLineBatch` **appends**, so a frame
   * that never resets silently keeps stacking geometry on top of the previous
   * frame's; conversely, a renderer that *replaced* on every call (the original
   * behaviour) let the grid batch erase every entity in the drawing — three
   * builds, two of which were thrown away before `drawLines` ever saw them.
   */
  beginLineBatch(): void {
    this.lineVertexCount = 0;
  }

  /**
   * Append tessellated geometry to the current line batch.
   *
   * `vertices` is the interleaved `[x, y]` stream from the kernel; `strips`
   * holds `[start, end]` vertex ranges per entity.
   *
   * Everything here stays in **model space** — mapping to the screen is the
   * vertex shader's job, so this method needs neither the view matrix nor the
   * viewport size.
   *
   * The one exception is `pxPerModel` (CSS pixels per model unit, i.e.
   * `1 / view.scale`). Linetype patterns are defined in screen pixels, so the
   * cumulative arc length that drives them has to be handed over already
   * converted. Passing the *scale* rather than a matrix keeps the dependency
   * narrow: this method still knows nothing about panning, or about where the
   * viewport is.
   *
   * Joins
   * -----
   * A polyline is expanded into one trapezoid per segment, and each vertex
   * carries the **bisector of its two neighbouring segment normals**, scaled by
   * `1 / cos(θ/2)` (see `MITER_LIMIT`). Two consequences, both required for the
   * stroke to look like one continuous band:
   *
   *   - neighbouring trapezoids share their joint edge *exactly*, so there is
   *     neither a wedge-shaped notch on the outside of the turn nor an overlap
   *     on the inside;
   *   - the perpendicular width stays `2 * halfW` even at a sharp corner,
   *     instead of pinching to `2 * halfW * cos(θ/2)`.
   *
   * The overlap half of that matters more than it looks: the fragment stage
   * feathers the edges with alpha, so any overlap is composited twice and shows
   * up as a dark bead at every joint — the exact artefact this replaced.
   */
  buildLineBatch(
    vertices: Float32Array,
    strips: Uint32Array,
    styles: ReadonlyArray<RenderStyle | null>,
    pxPerModel: number,
  ): void {
    const entityCount = Math.floor(strips.length / 2);
    if (entityCount === 0) return;

    // First pass: count segments (to size the vertex scratch buffers) and find
    // the longest entity (the miter caches are per entity).
    let segmentCount = 0;
    let maxVerts = 0;
    for (let i = 0; i < entityCount; i++) {
      const a = strips[i * 2]!;
      const b = strips[i * 2 + 1]!;
      const n = b - a;
      if (n >= 2 && styles[i]) {
        segmentCount += n - 1;
        if (n > maxVerts) maxVerts = n;
      }
    }
    if (segmentCount === 0) return;

    // Append point: where the previous batches in *this* frame ended.
    const base = this.lineVertexCount;

    // Each segment becomes a quad (2 triangles) expanded in the vertex shader.
    const vertsPerSegment = QUAD_VERTS;
    const total = base + segmentCount * vertsPerSegment;
    this.ensureLineCapacity(total);
    this.ensureMiterCapacity(maxVerts);

    const pos = this.posScratch;
    const nrm = this.normScratch;
    const side = this.sideScratch;
    const col = this.colorScratch;
    const wid = this.widthScratch;
    const dash = this.dashScratch;
    const arc = this.arcScratch;
    const segN = this.segNScratch;
    const vNrm = this.vNrmScratch;
    const vMiter = this.vMiterScratch;

    let vOut = base;

    for (let e = 0; e < entityCount; e++) {
      const style = styles[e];
      if (!style) continue;
      const a = strips[e * 2]!;
      const b = strips[e * 2 + 1]!;
      const count = b - a;
      if (count < 2) continue;

      const [cr, cg, cb, ca] = hexToRgba(style.color, 1);
      const r8 = Math.round(cr * 255);
      const g8 = Math.round(cg * 255);
      const b8 = Math.round(cb * 255);
      const a8 = Math.round(ca * 255);
      // Never let a stroke fall below one CSS pixel: below that the analytic
      // coverage ramp has no flat top and the line reads as a faint ghost.
      const halfW = Math.max(style.width, 1) * 0.5;

      // Constant for the whole entity, so it is unpacked once rather than per
      // segment — and it restarts at arc 0 for each entity, which is what makes
      // a dashed circle start its pattern at the first tessellation vertex.
      const [dPeriod, dOn0End, dOn1Start, dOn1End] = packDash(style.dash);

      // ---- one unit normal per segment (in model space) -------------------
      //
      // In the y-down screen orientation, rotating the segment direction by 90°
      // is `n = ((y1 - y0), (x1 - x0)) / len`.
      //
      // Only the *direction* is used and the endpoints are still in model
      // space, which is exact for any similarity view (pan + zoom, possibly
      // mirrored) — every view this editor can produce. A non-uniform scale
      // would shear the normal off perpendicular and require transforming it by
      // the view's linear part.
      let span = 0;
      // Arc length along the run, in CSS px.
      //
      // Indexed by the **global** vertex index, unlike the miter caches below
      // (which are per-entity because they are private to this loop). This array
      // gets uploaded, and `upload` addresses the source by its absolute offset,
      // so writing it entity-locally would make the upload read past the end of
      // the scratch — which is what happened first time round, reported by the
      // browser as `bufferSubData: srcOffset + length too large`.
      let runPx = 0;
      arc[a] = 0;
      for (let j = 0; j < count - 1; j++) {
        const x0 = vertices[(a + j) * 2]!;
        const y0 = vertices[(a + j) * 2 + 1]!;
        const x1 = vertices[(a + j + 1) * 2]!;
        const y1 = vertices[(a + j + 1) * 2 + 1]!;
        const dx = x1 - x0;
        const dy = y1 - y0;
        const len = Math.hypot(dx, dy);
        if (len > span) span = len;
        runPx += len * pxPerModel;
        arc[a + j + 1] = runPx;
        if (len < 1e-12) {
          // Degenerate: mark it so the emitter can skip the quad, while the
          // neighbouring vertices still get a usable bisector.
          segN[j * 2] = 0;
          segN[j * 2 + 1] = 0;
        } else {
          segN[j * 2] = dy / len;
          segN[j * 2 + 1] = dx / len;
        }
      }

      // A tessellated closed shape repeats its first vertex, so a strip whose
      // ends coincide is closed and the seam needs the same miter treatment as
      // any interior vertex.
      const ex = vertices[a * 2]! - vertices[(b - 1) * 2]!;
      const ey = vertices[a * 2 + 1]! - vertices[(b - 1) * 2 + 1]!;
      const closed = span > 0 && Math.hypot(ex, ey) <= 1e-6 * span;

      // ---- per-vertex bisector + miter compensation ------------------------
      for (let i = 0; i < count; i++) {
        const prev = i > 0 ? i - 1 : closed ? count - 2 : -1;
        const next = i < count - 1 ? i : closed ? 0 : -1;
        let nx = 0;
        let ny = 0;
        if (prev >= 0) {
          nx += segN[prev * 2]!;
          ny += segN[prev * 2 + 1]!;
        }
        if (next >= 0) {
          nx += segN[next * 2]!;
          ny += segN[next * 2 + 1]!;
        }
        const sum = Math.hypot(nx, ny);
        let scale = 1;
        if (sum < 1e-9) {
          // Both neighbours degenerate, or the path doubles back on itself.
          // Fall back to whichever side is well defined; a zero normal yields a
          // zero-area quad, which simply disappears.
          const j = prev >= 0 ? prev : next;
          nx = j >= 0 ? segN[j * 2]! : 0;
          ny = j >= 0 ? segN[j * 2 + 1]! : 0;
        } else {
          nx /= sum;
          ny /= sum;
          if (prev >= 0 && next >= 0) {
            // Two unit normals: |u1 + u2| = 2 cos(θ/2).
            const cosHalf = sum * 0.5;
            scale = cosHalf > 1e-6 ? Math.min(1 / cosHalf, MITER_LIMIT) : MITER_LIMIT;
          }
          // With a single neighbour (an open end) the bisector *is* that
          // segment's normal, and the perpendicular width is already correct —
          // applying the half-angle factor here would double the stroke.
        }
        vNrm[i * 2] = nx;
        vNrm[i * 2 + 1] = ny;
        vMiter[i] = scale;
      }

      // ---- one trapezoid per segment --------------------------------------
      for (let j = 0; j < count - 1; j++) {
        // A degenerate segment contributes no quad; its endpoints are still
        // covered by the neighbouring trapezoids' shared joint edges.
        if (Math.hypot(segN[j * 2]!, segN[j * 2 + 1]!) < 0.5) continue;

        const x0 = vertices[(a + j) * 2]!;
        const y0 = vertices[(a + j) * 2 + 1]!;
        const x1 = vertices[(a + j + 1) * 2]!;
        const y1 = vertices[(a + j + 1) * 2 + 1]!;

        // Two triangles forming the stroke quad, laid out as documented on
        // QUAD_AT_END: every vertex of one end carries *that end's* miter
        // normal and half-width, which is what makes the neighbouring quads
        // share their joint edge exactly.
        for (let k = 0; k < vertsPerSegment; k++) {
          const vi = vOut + k;
          const atStart = !QUAD_AT_END[k]!;
          const i = atStart ? j : j + 1;
          pos[vi * 2] = atStart ? x0 : x1;
          pos[vi * 2 + 1] = atStart ? y0 : y1;
          nrm[vi * 2] = vNrm[i * 2]!;
          nrm[vi * 2 + 1] = vNrm[i * 2 + 1]!;
          side[vi] = QUAD_SIDE[k]!;
          wid[vi] = halfW * vMiter[i]!;
          col[vi * 4] = r8;
          col[vi * 4 + 1] = g8;
          col[vi * 4 + 2] = b8;
          col[vi * 4 + 3] = a8;
          // Both ends of the segment carry that end's cumulative length, so the
          // fragment interpolates arc length exactly along the centreline.
          arc[vi] = arc[a + i]!;
          dash[vi * 4] = dPeriod;
          dash[vi * 4 + 1] = dOn0End;
          dash[vi * 4 + 2] = dOn1Start;
          dash[vi * 4 + 3] = dOn1End;
        }
        vOut += vertsPerSegment;
      }
    }

    this.lineVertexCount = vOut;

    // Upload only the slice this call appended, at the right byte offset — the
    // earlier batches in this frame are already on the GPU and must stay there.
    const added = vOut - base;
    const gl = this.gl;
    gl.bindVertexArray(this.lineVao);
    // (buffer, data, elementCount, bytesPerElement, dstElementOffset, srcElementOffset)
    this.upload(this.lineBuffer, pos, added * 2, 4, base * 2, base * 2);
    this.upload(this.lineNormalBuffer, nrm, added * 2, 4, base * 2, base * 2);
    this.upload(this.lineSideBuffer, side, added, 4, base, base);
    this.upload(this.lineColorBuffer, col, added * 4, 1, base * 4, base * 4);
    this.upload(this.lineWidthBuffer, wid, added, 4, base, base);
    this.upload(this.lineArcBuffer, arc, added, 4, base, base);
    this.upload(this.lineDashBuffer, dash, added * 4, 4, base * 4, base * 4);
    gl.bindVertexArray(null);
  }

  private ensureLineCapacity(totalVerts: number): void {
    if (this.posScratch.length >= totalVerts * 2) return;
    const n = Math.max(totalVerts, 4096);
    this.posScratch = new Float32Array(n * 2);
    this.normScratch = new Float32Array(n * 2);
    this.sideScratch = new Float32Array(n);
    this.widthScratch = new Float32Array(n);
    this.colorScratch = new Uint8Array(n * 4);
    this.dashScratch = new Float32Array(n * 4);
    // Global-indexed like the rest of the uploaded attributes — see the note in
    // `buildLineBatch`.
    this.arcScratch = new Float32Array(n);
  }

  /** Size the per-entity miter caches for an entity of `verts` vertices. */
  private ensureMiterCapacity(verts: number): void {
    if (this.vNrmScratch.length >= verts * 2) return;
    const n = Math.max(verts, 512);
    // `segN` needs one entry per segment, and the emitter reads `segN[i]` with
    // i up to `verts - 2`, so n * 2 covers it with room to spare.
    this.segNScratch = new Float32Array(n * 2);
    this.vNrmScratch = new Float32Array(n * 2);
    this.vMiterScratch = new Float32Array(n);
  }

  private ensurePointCapacity(count: number): void {
    if (this.ptPosScratch.length >= count * 2) return;
    const n = Math.max(count, 2048);
    this.ptPosScratch = new Float32Array(n * 2);
    this.ptColorScratch = new Uint8Array(n * 4);
    this.ptSizeScratch = new Float32Array(n);
  }

  /**
   * Upload `elementCount` elements of `data` into `buffer`.
   *
   * The allocation grows geometrically and is only redone when the batch stops
   * fitting, so a stable scene issues zero `bufferData` calls per frame.
   *
   * `bytesPerElement` is passed explicitly instead of being sniffed with
   * `instanceof`, so introducing a new buffer type cannot silently size the
   * allocation wrong — a mistake that shows up as a WebGL bounds violation
   * rather than a type error.
   *
   * `dstElementOffset` / `srcElementOffset` let a caller append to a batch that
   * earlier passes already filled, without re-uploading the whole thing.
   */
  private upload(
    buffer: WebGLBuffer,
    data: ArrayBufferView,
    elementCount: number,
    bytesPerElement: number,
    dstElementOffset = 0,
    srcElementOffset = 0,
  ): void {
    const gl = this.gl;
    const bytes = elementCount * bytesPerElement;
    if (!(bytes > 0)) return;

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);

    const needed = (dstElementOffset + elementCount) * bytesPerElement;
    const have = this.bufferBytes.get(buffer) ?? 0;
    if (needed > have) {
      const want = Math.max(needed, have * 2, 1024);
      gl.bufferData(gl.ARRAY_BUFFER, want, gl.DYNAMIC_DRAW);
      if (gl.getError() !== gl.NO_ERROR) {
        // The driver refused the allocation (out of GPU memory, or a size past
        // its limit). Drop the remembered capacity so the next frame retries,
        // and skip the write entirely rather than writing past the small
        // buffer we still hold.
        this.bufferBytes.delete(buffer);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        return;
      }
      this.bufferBytes.set(buffer, want);
    }

    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      dstElementOffset * bytesPerElement,
      data,
      srcElementOffset,
      elementCount,
    );
  }

  /** Draw every line batch accumulated this frame, then close the batch. */
  drawLines(view: Mat, viewportWidth: number, viewportHeight: number): void {
    if (this.lineVertexCount === 0) return;
    const gl = this.gl;
    gl.useProgram(this.lineProgram);
    gl.bindVertexArray(this.lineVao);

    // `u_view` is model → clip; `u_viewport` is the CSS-pixel viewport the
    // shader offsets the quad corners in. Both are required — see the note on
    // LINE_VERT_SRC.
    gl.uniformMatrix3fv(this.uLineView, false, mat3FromAffine(view));
    gl.uniform2f(this.uLineViewport, viewportWidth, viewportHeight);

    // Feather radius in CSS px. Aim for a one-*device*-pixel ramp: the whole
    // point of doing the anti-aliasing analytically is that the result must not
    // depend on the sample grid, and a ramp expressed in CSS pixels would get
    // twice as soft on a HiDPI screen.
    gl.uniform1f(this.uLineAa, 0.5 / this.dpr);

    gl.drawArrays(gl.TRIANGLES, 0, this.lineVertexCount);
    gl.bindVertexArray(null);

    // Closing the batch here means a frame that throws between `buildLineBatch`
    // and `drawLines` cannot leak geometry into the next frame.
    this.lineVertexCount = 0;
  }

  /**
   * Draw a set of screen-space points (snap markers, grips, vertices).
   *
   * `size` is a diameter in **CSS pixels**; the vertex stage multiplies by the
   * device pixel ratio because `gl_PointSize` is measured in device pixels.
   * The fragment stage carves a disc out of each sprite.
   *
   * `OverlayPoint.shape` is not honoured yet — every marker comes out round.
   */
  drawPoints(
    points: ReadonlyArray<{ x: number; y: number; color: string; size: number }>,
    view: Mat,
  ): void {
    if (points.length === 0) return;
    const gl = this.gl;
    this.ensurePointCapacity(points.length);

    const pos = this.ptPosScratch;
    const col = this.ptColorScratch;
    const size = this.ptSizeScratch;

    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      const [r, g, b, a] = hexToRgba(p.color, 1);
      pos[i * 2] = p.x;
      pos[i * 2 + 1] = p.y;
      col[i * 4] = Math.round(r * 255);
      col[i * 4 + 1] = Math.round(g * 255);
      col[i * 4 + 2] = Math.round(b * 255);
      col[i * 4 + 3] = Math.round(a * 255);
      size[i] = p.size;
    }

    gl.bindVertexArray(this.pointVao);
    // (buffer, data, elementCount, bytesPerElement)
    this.upload(this.pointBuffer, pos, points.length * 2, 4);
    this.upload(this.pointColorBuffer, col, points.length * 4, 1);
    this.upload(this.pointSizeBuffer, size, points.length, 4);

    gl.useProgram(this.pointProgram);
    gl.uniformMatrix3fv(this.uPointView, false, mat3FromAffine(view));
    gl.uniform1f(this.uPointDpr, this.dpr);
    gl.drawArrays(gl.POINTS, 0, points.length);
    gl.bindVertexArray(null);
  }

  /** Read the rendered canvas as a PNG data URL — used by "export image". */
  toDataURL(): string {
    return this.canvas.toDataURL('image/png');
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.lineProgram);
    gl.deleteProgram(this.pointProgram);
    gl.deleteBuffer(this.lineBuffer);
    gl.deleteBuffer(this.lineNormalBuffer);
    gl.deleteBuffer(this.lineSideBuffer);
    gl.deleteBuffer(this.lineColorBuffer);
    gl.deleteBuffer(this.lineWidthBuffer);
    gl.deleteBuffer(this.pointBuffer);
    gl.deleteBuffer(this.pointColorBuffer);
    gl.deleteBuffer(this.pointSizeBuffer);
    gl.deleteVertexArray(this.lineVao);
    gl.deleteVertexArray(this.pointVao);
    // The buffer names are gone; drop the capacity bookkeeping with them.
    this.bufferBytes.clear();
  }
}

/** Convenience: build the model→clip matrix from a camera-like state. */
export function makeViewMatrix(
  center: Vec2,
  scale: number,
  width: number,
  height: number,
): Mat {
  return clipMatrixOf({ center, scale, width, height });
}

export function boundsFromCorners(a: Vec2, b: Vec2): Aabb {
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  };
}
