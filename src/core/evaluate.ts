/**
 * Feature evaluation — turn the tree into triangles (work package 1.2 of
 * `PHASE1_PLAN.md`).
 *
 * The rule this file exists to enforce: **derived geometry is computed, never
 * stored**. A feature is intent — which sketch, which profile, what height —
 * and the mesh is re-derived here from that intent on every document change,
 * so editing the sketch changes the solid with nothing baked and nothing to
 * go stale.
 *
 * Full recompute, no dependency graph: for the feature counts this app deals
 * with, "evaluate every feature on every change" is not a measurable cost,
 * and it is the only strategy that cannot be *wrong* about what changed. The
 * store calls this once per real command; the render loop then consumes the
 * result without recomputing anything, and the result's identity is the cache
 * key (`EvalResult.id`) — which is what makes "evaluated but not drawn"
 * impossible, the failure the old per-frame mesh cache had.
 *
 * Errors are **values, not exceptions**: a feature whose profile was deleted,
 * whose sketch is gone, or whose kind has no evaluator yet comes back as an
 * error item carrying the reason. The alternative — a silently empty mesh —
 * is a lie the user cannot act on.
 */

import type {
  BooleanFeature,
  CadDocument,
  ExtrudeFeature,
  Feature,
  FeatureId,
  HoleFeature,
  PatternFeature,
  RevolveFeature,
} from './types';
import { findEntity, findFeature, findSketch, sketchOfEntity } from './doc';
import { booleanMesh, extrudeMesh, holeMesh, isKernelReady, revolveMesh } from './kernel';
import { findPlane, planeFrame } from './types';

export type FeatureStatus = 'ok' | 'consumed' | 'suppressed' | 'error';

export interface FeatureEval {
  feature: Feature;
  status: FeatureStatus;
  /** Present exactly when `status === 'error'` — the reason, user-facing. */
  error?: string;
  /** Flat-shaded triangles. Empty unless `status === 'ok'` and it drew. */
  verts: Float32Array;
}

export interface EvalResult {
  /**
   * Identity of this evaluation, monotonic. The render loop keys mesh reuse
   * on this — never on geometry equality, which is both slower than an
   * identity check and wrong about intent (two different sketches can
   * legitimately produce the same triangles).
   */
  readonly id: number;
  readonly items: readonly FeatureEval[];
  /** How many features are in error — the status chip reads this. */
  readonly errorCount: number;
}

/** One shared empty array: "nothing to draw" must not be a fresh allocation. */
const EMPTY_VERTS = new Float32Array(0);

let evalSeq = 0;

/** Evaluate every feature in the document, in tree order. */
export function evaluate(doc: CadDocument): EvalResult {
  evalSeq += 1;
  const items: FeatureEval[] = [];
  // Meshes produced so far, by feature id — how a boolean finds its operands.
  // Tree order *is* the evaluation order, so an operand is always already here
  // by the time a dependent feature is reached; the reverse would be a cycle
  // wearing a feature's clothes, and `evalBoolean` refuses it.
  const meshes = new Map<FeatureId, Float32Array>();
  for (const node of doc.nodes) {
    if (node.kind !== 'feature') continue;
    const ev = evalFeature(doc, node.feature, meshes);
    if (ev.status === 'ok' && ev.verts.length > 0) meshes.set(ev.feature.id, ev.verts);
    items.push(ev);
  }

  // A boolean **consumes** its operands: their surfaces are part of the result
  // now, and drawing them as well would show a shell sitting inside a shell.
  // Marked in one pass after the fact, because the consuming boolean can appear
  // anywhere later in the tree. Note this only demotes operands of a boolean
  // that *succeeded* — an errored boolean must leave its operands visible, or
  // the user would lose sight of the very geometry that failed.
  const consumed = new Set<FeatureId>();
  for (const it of items) {
    if (it.feature.kind === 'boolean' && it.status === 'ok') {
      consumed.add(it.feature.a);
      consumed.add(it.feature.b);
    }
    // A hole consumes the solid it was drilled into: the drilled body *is* the
    // result, and drawing the undrilled one underneath would show the hole
    // filled in again.
    if (it.feature.kind === 'hole' && it.status === 'ok') {
      consumed.add(it.feature.solid);
    }
    // A pattern consumes its source the same way: the row *is* the source
    // repeated, so drawing the lone original as well would put a duplicate
    // where the first instance already is.
    if (it.feature.kind === 'pattern' && it.status === 'ok') {
      consumed.add(it.feature.source);
    }
  }
  const finalItems = items.map((it) =>
    consumed.has(it.feature.id) && it.status === 'ok' ? { ...it, status: 'consumed' as const } : it,
  );
  let errorCount = 0;
  for (const it of finalItems) if (it.status === 'error') errorCount += 1;
  return { id: evalSeq, items: finalItems, errorCount };
}

function evalFeature(
  doc: CadDocument,
  f: Feature,
  meshes: ReadonlyMap<FeatureId, Float32Array>,
): FeatureEval {
  // Suppressed = skip evaluation, keep the node. Not an error: the user asked
  // for this one to be quiet.
  if (f.suppressed) return { feature: f, status: 'suppressed', verts: EMPTY_VERTS };

  switch (f.kind) {
    case 'extrude':
      return evalExtrude(doc, f);
    case 'revolve':
      return evalRevolve(doc, f);
    case 'boolean':
      return evalBoolean(f, meshes);
    case 'hole':
      return evalHole(f, meshes);
    case 'pattern':
      return evalPattern(doc, f, meshes);
  }
}

function evalExtrude(doc: CadDocument, f: ExtrudeFeature): FeatureEval {
  const fail = (why: string): FeatureEval => ({
    feature: f,
    status: 'error',
    error: `${f.name}: ${why}`,
    verts: EMPTY_VERTS,
  });

  // `profile: null` means "every closed region of the sketch" — reserved by
  // the type, produced by no tool yet. Say so instead of quietly extruding
  // nothing.
  if (f.profile === null) return fail('整幅草图拉伸尚未实现（请指定单个封闭轮廓）');

  const src = findEntity(doc, f.profile);
  if (!src) return fail('轮廓已被删除');

  const sketch = findSketch(doc, f.sketch);
  if (!sketch) return fail('草图已被删除');
  const plane = findPlane(doc, sketch.plane);
  if (!plane) return fail('基准面已被删除');

  // Kernel still loading (or it failed): the *feature* is fine, the mesh just
  // is not computable yet. The store re-evaluates on `setKernelReady`, so
  // this is a transient empty, not an error to report.
  if (!isKernelReady()) return { feature: f, status: 'ok', verts: EMPTY_VERTS };

  const verts = extrudeMesh(src, f.height, planeFrame(plane));
  // `null` = the kernel refused the profile: not closed, or a kind it cannot
  // extrude. That is exactly the case that must not render as "nothing
  // happened".
  if (!verts) return fail('无法拉伸：轮廓不封闭或类型不支持');
  return { feature: f, status: 'ok', verts };
}

function evalRevolve(doc: CadDocument, f: RevolveFeature): FeatureEval {
  const fail = (why: string): FeatureEval => ({
    feature: f,
    status: 'error',
    error: `${f.name}: ${why}`,
    verts: EMPTY_VERTS,
  });

  if (f.profile === null) return fail('整幅草图旋转尚未实现（请指定单个封闭轮廓）');

  const src = findEntity(doc, f.profile);
  if (!src) return fail('轮廓已被删除');

  const axis = findEntity(doc, f.axis);
  if (!axis) return fail('旋转轴已被删除');
  // The axis is a *line* in the sketch — a centreline the user drew. Anything
  // else has no direction to revolve about.
  if (axis.type !== 'line') return fail('旋转轴不是直线');

  // Both curves are read in their sketch's 2D coordinates, so they have to be
  // the same sketch's coordinates. Cross-sketch would silently revolve about a
  // different plane's axis.
  if (sketchOfEntity(doc, f.axis)?.id !== f.sketch || sketchOfEntity(doc, f.profile)?.id !== f.sketch) {
    return fail('轮廓与旋转轴不在同一张草图');
  }

  const sketch = findSketch(doc, f.sketch);
  if (!sketch) return fail('草图已被删除');
  const plane = findPlane(doc, sketch.plane);
  if (!plane) return fail('基准面已被删除');

  const dir = { x: axis.b.x - axis.a.x, y: axis.b.y - axis.a.y };
  if (Math.hypot(dir.x, dir.y) <= 1e-12) return fail('旋转轴退化成一点');

  if (!isKernelReady()) return { feature: f, status: 'ok', verts: EMPTY_VERTS };

  const verts = revolveMesh(src, axis.a, dir, f.angle, planeFrame(plane));
  // Same rule as extrude: the kernel's refusal is a modelling error with a
  // sentence, not an empty mesh.
  if (!verts) return fail('无法旋转：轮廓不封闭，或轮廓穿过/贴在旋转轴上');
  return { feature: f, status: 'ok', verts };
}

function evalBoolean(
  f: BooleanFeature,
  meshes: ReadonlyMap<FeatureId, Float32Array>,
): FeatureEval {
  const fail = (why: string): FeatureEval => ({
    feature: f,
    status: 'error',
    error: `${f.name}: ${why}`,
    verts: EMPTY_VERTS,
  });

  if (f.a === f.b) return fail('不能用同一个特征和自己做布尔运算');

  const a = meshes.get(f.a);
  const b = meshes.get(f.b);
  // Operands must come *before* this node. The message says both possibilities
  // because the user cannot see the difference from the outside: a later
  // operand and a failed one look the same from here, and both mean "fix the
  // tree, not the boolean".
  if (!a) return fail('找不到 A 的网格（它在这一项之后，或它求值失败）');
  if (!b) return fail('找不到 B 的网格（它在这一项之后，或它求值失败）');

  if (!isKernelReady()) return { feature: f, status: 'ok', verts: EMPTY_VERTS };

  const verts = booleanMesh(a, b, f.op);
  // `null` = the result has no surface. Legitimate for all three operations,
  // but never drawn as "nothing happened" — and each one has its own reason,
  // because "empty" alone does not tell the user what to change.
  if (!verts) return fail(EMPTY_RESULT_REASON[f.op]);
  return { feature: f, status: 'ok', verts };
}

/** Why a boolean can come back with no surface, per operation. */
const EMPTY_RESULT_REASON: Record<BooleanFeature['op'], string> = {
  subtract: '相减后没有剩余实体（B 把 A 整个盖住了）',
  union: '并集为空（两个实体都没有体积）',
  intersect: '交集为空（两个实体没有重叠的部分）',
};

function evalPattern(
  doc: CadDocument,
  f: PatternFeature,
  meshes: ReadonlyMap<FeatureId, Float32Array>,
): FeatureEval {
  const fail = (why: string): FeatureEval => ({
    feature: f,
    status: 'error',
    error: `${f.name}: ${why}`,
    verts: EMPTY_VERTS,
  });

  const base = meshes.get(f.source);
  if (!base) return fail('找不到要阵列的特征（它在前面吗？它求值成功了吗？）');

  // The instances are *derived*: the source's own parameters are re-read here,
  // so editing the source hole moves and resizes every copy. Only a hole can be
  // repeated today, and saying so beats repeating whatever else silently.
  const source = findFeature(doc, f.source);
  if (!source) return fail('找不到源特征');
  if (source.kind !== 'hole') return fail('目前只有孔能被阵列');

  const count = Math.round(f.count);
  const countV = Math.round(f.countV);
  if (!(count >= 1) || !(countV >= 1)) return fail('阵列数量至少是 1（含源孔本身）');
  if (count * countV > 1024) return fail(`阵列数量上限 1024（现在是 ${count} × ${countV}）`);

  if (!isKernelReady()) return { feature: f, status: 'ok', verts: EMPTY_VERTS };

  const verts = holeMesh(
    base,
    source.at,
    source.normal,
    source.diameter,
    source.depth,
    count,
    f.spacing,
    countV,
    f.spacingV,
  );
  if (!verts) return fail('阵列后没有剩余实体');
  return { feature: f, status: 'ok', verts };
}

function evalHole(f: HoleFeature, meshes: ReadonlyMap<FeatureId, Float32Array>): FeatureEval {
  const fail = (why: string): FeatureEval => ({
    feature: f,
    status: 'error',
    error: `${f.name}: ${why}`,
    verts: EMPTY_VERTS,
  });

  // The two parameters the user can type are checked here rather than trusted:
  // a diameter of zero is a knife edge, and the kernel would answer it with a
  // silent no-op.
  if (!(f.diameter > 0)) return fail('直径必须大于 0');
  if (!Number.isFinite(f.depth) || f.depth < 0) return fail('深度不能是负数（0 = 通孔）');

  const solid = meshes.get(f.solid);
  // Same rule as a boolean's operands: the base must already have evaluated.
  // A hole into nothing is a tree to fix, not a hole to draw.
  if (!solid) return fail('找不到要打孔的实体（它在前面吗？它求值成功了吗？）');

  if (!isKernelReady()) return { feature: f, status: 'ok', verts: EMPTY_VERTS };

  const verts = holeMesh(solid, f.at, f.normal, f.diameter, f.depth);
  if (!verts) return fail('打孔后没有剩余实体');
  return { feature: f, status: 'ok', verts };
}
