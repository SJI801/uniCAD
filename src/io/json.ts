/**
 * Native document format (`.unicad.json`).
 *
 * The on-disk shape is deliberately close to the in-memory model: a small
 * header, the layer table, settings, and a flat entity array. Reading is
 * defensive — unknown fields are ignored and missing optional fields fall back
 * to defaults, so files written by older or newer builds still open.
 */

import type {
  ArcEntity,
  CadDocument,
  CircleEntity,
  Constraint,
  ConstraintKind,
  ConstraintPointKind,
  ConstraintTarget,
  DocFrame,
  DocPlane,
  DocumentMeta,
  DrawingSettings,
  EllipseEntity,
  Entity,
  EntityType,
  Layer,
  LineEntity,
  LineStyle,
  PolylineEntity,
  Solid,
  Vec2,
} from '../core/types';
import {
  CONSTRAINT_POINT_TAG,
  CONSTRAINT_KIND_TAG,
  createEmptyDocument,
  DEFAULT_LAYER,
  DEFAULT_SETTINGS,
  DEFAULT_OSNAP_MODES,
  defaultFrames,
  defaultPlanes,
  UNARY_CONSTRAINTS,
  XY_PLANE,
} from '../core/types';
import { nextConstraintId, DIMENSIONAL_CONSTRAINTS } from '../core/constraints';

export const FILE_MAGIC = 'unicad';
export const FILE_VERSION = 1;

export interface CadFile {
  magic: typeof FILE_MAGIC;
  version: number;
  meta: DocumentMeta;
  settings: DrawingSettings;
  layers: Layer[];
  currentLayer: string;
  entities: unknown[];
  /**
   * Parametric constraints. Optional on read: files written before the feature
   * existed simply have no array, and fall back to "no constraints".
   */
  constraints?: unknown[];
  /**
   * Extruded 3D solids. Optional on read for the same reason as constraints —
   * a file saved before 3D existed simply has none.
   */
  solids?: unknown[];
  /**
   * Datum planes and reference coordinate systems. Optional on read. The three
   * base planes are reconstructed from scratch when absent, so a file saved
   * before either feature existed still opens with a usable frame.
   */
  planes?: unknown[];
  frames?: unknown[];
  activePlane?: unknown;
}

// ---------------------------------------------------------------------------
// Serialise
// ---------------------------------------------------------------------------

/** Compact entity encoding: short keys, no nulls, numbers unrounded. */
function encodeEntity(e: Entity): Record<string, unknown> {
  // Only emit attribute overrides when they are actually set — keeps files
  // small and makes diffs readable.
  const attrs: Record<string, unknown> = { layer: e.layer };
  if (e.color !== null) attrs['color'] = e.color;
  if (e.lineStyle !== null) attrs['lineStyle'] = e.lineStyle;
  if (e.lineWeight !== null) attrs['lineWeight'] = e.lineWeight;
  // Written only when the sketch is off the XY plane, so a 2D drawing file keeps
  // looking exactly as it always did.
  if (e.plane !== undefined) attrs['plane'] = e.plane;
  if (e.name) attrs['name'] = e.name;

  switch (e.type) {
    case 'line':
      return { t: 'L', h: e.id, ...attrs, p: [e.a.x, e.a.y, e.b.x, e.b.y] };
    case 'polyline':
      return { t: 'PL', h: e.id, ...attrs, c: e.closed ? 1 : 0, p: flatten(e.points) };
    case 'circle':
      return { t: 'C', h: e.id, ...attrs, p: [e.center.x, e.center.y, e.radius] };
    case 'arc':
      return { t: 'A', h: e.id, ...attrs, p: [e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle] };
    case 'ellipse':
      return { t: 'E', h: e.id, ...attrs, p: [e.center.x, e.center.y, e.rx, e.ry, e.rotation] };
  }
}

function flatten(points: readonly Vec2[]): number[] {
  const out: number[] = new Array(points.length * 2);
  for (let i = 0; i < points.length; i++) {
    out[i * 2] = points[i]!.x;
    out[i * 2 + 1] = points[i]!.y;
  }
  return out;
}

export function serializeDocument(doc: CadDocument): CadFile {
  return {
    magic: FILE_MAGIC,
    version: FILE_VERSION,
    meta: {
      ...doc.meta,
      modifiedAt: new Date().toISOString(),
    },
    settings: { ...doc.settings, osnapModes: [...doc.settings.osnapModes] },
    layers: doc.layers.map((l) => ({ ...l })),
    currentLayer: doc.currentLayer,
    entities: doc.entities.map(encodeEntity),
    constraints: doc.constraints.map(encodeConstraint),
    solids: doc.solids.map((s) => ({ ...s })),
    planes: doc.planes.map((p) => ({ ...p })),
    frames: doc.frames.map((f) => ({ ...f })),
    activePlane: doc.activePlane,
  };
}

/**
 * Constraints are written with the same terse key style as entities: `k` for the
 * kind, `a`/`b` for the two targets, each target `{ e, p, i }`.
 *
 * `i` (the vertex index) is only emitted for `p: 'vertex'`, so a file reads as
 * what it means rather than as a mostly-zero struct.
 */
function encodeConstraint(c: Constraint): Record<string, unknown> {
  const target = (t: ConstraintTarget): Record<string, unknown> => {
    const out: Record<string, unknown> = { e: t.entity, p: t.point };
    if (t.point === 'vertex') out['i'] = t.index ?? 0;
    return out;
  };
  const out: Record<string, unknown> = { k: c.kind, a: target(c.a) };
  if (c.b) out['b'] = target(c.b);
  // 尺寸目标值只在尺寸约束上写；几何约束没有该字段。
  if (c.value !== undefined) out['v'] = c.value;
  return out;
}

export function toJsonString(doc: CadDocument, pretty = true): string {
  return JSON.stringify(serializeDocument(doc), null, pretty ? 2 : 0);
}

// ---------------------------------------------------------------------------
// Deserialise
// ---------------------------------------------------------------------------

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

const VALID_LINESTYLES: LineStyle[] = ['continuous', 'dashed', 'dotted', 'dashdot', 'center', 'hidden'];

function lineStyle(v: unknown, fallback: LineStyle): LineStyle {
  return typeof v === 'string' && (VALID_LINESTYLES as string[]).includes(v)
    ? (v as LineStyle)
    : fallback;
}

const VALID_CONSTRAINT_KINDS = Object.keys(CONSTRAINT_KIND_TAG) as ConstraintKind[];
const VALID_CONSTRAINT_POINTS = Object.keys(CONSTRAINT_POINT_TAG) as ConstraintPointKind[];

/**
 * Read one constraint, or `null` if it cannot mean anything.
 *
 * `existing` is the set of entity ids actually present: a target pointing
 * outside it is dropped rather than repaired, because there is no sensible way
 * to guess which curve the author meant.
 */
function decodeConstraint(raw: unknown, existing: ReadonlySet<string>): Constraint | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;

  const kind = str(o['k']);
  if (!(VALID_CONSTRAINT_KINDS as string[]).includes(kind)) return null;

  const target = (v: unknown): ConstraintTarget | null => {
    if (typeof v !== 'object' || v === null) return null;
    const t = v as Record<string, unknown>;
    const entity = str(t['e']);
    if (!entity || !existing.has(entity)) return null;
    const point = str(t['p'], 'none');
    if (!(VALID_CONSTRAINT_POINTS as string[]).includes(point)) return null;
    const p = point as ConstraintPointKind;
    const out: ConstraintTarget = { entity, point: p };
    if (p === 'vertex') out.index = Math.max(0, Math.round(num(t['i'])));
    return out;
  };

  const a = target(o['a']);
  if (!a) return null;
  const b = o['b'] === undefined ? null : target(o['b']);

  // Unary kinds must *not* carry a partner, binary kinds must — accepting a
  // half-formed pair here would push the inconsistency into the solver, where
  // it would show up as a constraint that silently never applies.
  //
  // 尺寸目标值只在尺寸约束上读，且必须是正的有限数（非正尺寸没有几何意义）；
  // 几何约束即使带着 v 键也忽略——宽容读入旧文件/手写文件。
  let value: number | undefined;
  if (DIMENSIONAL_CONSTRAINTS.has(kind as ConstraintKind)) {
    const raw = o['v'];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
    value = raw;
  }
  if (UNARY_CONSTRAINTS.has(kind as ConstraintKind)) {
    if (b) return null;
    return value === undefined
      ? { id: nextConstraintId(), kind: kind as ConstraintKind, a }
      : { id: nextConstraintId(), kind: kind as ConstraintKind, a, value };
  }
  if (!b) return null;
  return value === undefined
    ? { id: nextConstraintId(), kind: kind as ConstraintKind, a, b }
    : { id: nextConstraintId(), kind: kind as ConstraintKind, a, b, value };
}

function decodeEntity(raw: unknown, fallbackLayer: string): Entity | null {  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const t = str(o['t']);
  const id = str(o['h']) || `e-${Math.random().toString(36).slice(2)}`;
  const layer = str(o['layer']) || fallbackLayer;
  const color = typeof o['color'] === 'string' ? o['color'] : null;
  const ls = o['lineStyle'];
  const lineStyleValue = ls === null || ls === undefined ? null : lineStyle(ls, 'continuous');
  const lw = typeof o['lineWeight'] === 'number' ? o['lineWeight'] : null;
  const name = typeof o['name'] === 'string' ? o['name'] : undefined;
  // Absent ⇒ the XY plane (see `EntityBase.plane`); only carry it when present.
  const plane = typeof o['plane'] === 'string' ? o['plane'] : undefined;

  const p = Array.isArray(o['p']) ? (o['p'] as unknown[]) : [];

  const common = {
    id,
    layer,
    color,
    lineStyle: lineStyleValue,
    lineWeight: lw,
    ...(plane !== undefined ? { plane } : {}),
    ...(name !== undefined ? { name } : {}),
  };

  switch (t) {
    case 'L':
      if (p.length < 4) return null;
      return {
        ...common,
        type: 'line',
        a: { x: num(p[0]), y: num(p[1]) },
        b: { x: num(p[2]), y: num(p[3]) },
      } satisfies LineEntity;
    case 'PL': {
      if (p.length < 4) return null;
      const points: Vec2[] = [];
      for (let i = 0; i + 1 < p.length; i += 2) {
        points.push({ x: num(p[i]), y: num(p[i + 1]) });
      }
      return { ...common, type: 'polyline', points, closed: num(o['c']) !== 0 } satisfies PolylineEntity;
    }
    case 'C':
      if (p.length < 3) return null;
      return {
        ...common,
        type: 'circle',
        center: { x: num(p[0]), y: num(p[1]) },
        radius: Math.abs(num(p[2])),
      } satisfies CircleEntity;
    case 'A':
      if (p.length < 5) return null;
      return {
        ...common,
        type: 'arc',
        center: { x: num(p[0]), y: num(p[1]) },
        radius: Math.abs(num(p[2])),
        startAngle: num(p[3]),
        endAngle: num(p[4]),
      } satisfies ArcEntity;
    case 'E':
      if (p.length < 5) return null;
      return {
        ...common,
        type: 'ellipse',
        center: { x: num(p[0]), y: num(p[1]) },
        rx: Math.abs(num(p[2])),
        ry: Math.abs(num(p[3])),
        rotation: num(p[4]),
      } satisfies EllipseEntity;
    default:
      return null;
  }
}

function decodeLayer(raw: unknown, index: number): Layer {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_LAYER };
  const o = raw as Record<string, unknown>;
  return {
    id: str(o['id']) || `layer-${index}`,
    name: str(o['name']) || `Layer${index}`,
    color: str(o['color']) || '#e8e8e8',
    lineStyle: lineStyle(o['lineStyle'], 'continuous'),
    lineWeight: num(o['lineWeight'], 0.25),
    visible: o['visible'] !== false,
    locked: o['locked'] === true,
    frozen: o['frozen'] === true,
    printable: o['printable'] !== false,
  };
}

function decodeSettings(raw: unknown): DrawingSettings {
  if (typeof raw !== 'object' || raw === null) {
    return { ...DEFAULT_SETTINGS, osnapModes: [...DEFAULT_OSNAP_MODES] };
  }
  const o = raw as Record<string, unknown>;
  const modes = Array.isArray(o['osnapModes'])
    ? (o['osnapModes'] as unknown[]).filter((m): m is string => typeof m === 'string')
    : DEFAULT_OSNAP_MODES;
  const constraint = o['constraint'];
  return {
    gridSpacing: num(o['gridSpacing'], DEFAULT_SETTINGS.gridSpacing),
    gridSubdivisions: num(o['gridSubdivisions'], DEFAULT_SETTINGS.gridSubdivisions),
    snapAperturePx: num(o['snapAperturePx'], DEFAULT_SETTINGS.snapAperturePx),
    pickAperturePx: num(o['pickAperturePx'], DEFAULT_SETTINGS.pickAperturePx),
    osnapModes: modes.length > 0 ? (modes as DrawingSettings['osnapModes']) : [...DEFAULT_OSNAP_MODES],
    constraint:
      constraint === 'grid' || constraint === 'ortho' || constraint === 'polar'
        ? constraint
        : 'none',
    polarIncrement: num(o['polarIncrement'], DEFAULT_SETTINGS.polarIncrement),
    polarTracking: o['polarTracking'] === true,
    units: (['mm', 'cm', 'm', 'in'] as const).includes(o['units'] as never)
      ? (o['units'] as DrawingSettings['units'])
      : 'mm',
    annotationScale: num(o['annotationScale'], 1),
  };
}

export interface LoadResult {
  doc: CadDocument;
  warnings: string[];
}

/** Parse a native document. Throws on structurally invalid input. */
export function deserializeDocument(input: string | unknown): LoadResult {
  const warnings: string[] = [];
  let root: unknown = input;
  if (typeof input === 'string') {
    try {
      root = JSON.parse(input);
    } catch (e) {
      throw new Error(`无法解析 JSON: ${(e as Error).message}`);
    }
  }
  if (typeof root !== 'object' || root === null) {
    throw new Error('文件内容不是有效的对象。');
  }
  const o = root as Record<string, unknown>;

  if (o['magic'] !== FILE_MAGIC) {
    warnings.push('文件缺少 uniCAD 标识，尝试按兼容模式读取。');
  }
  const version = num(o['version'], FILE_VERSION);
  if (version > FILE_VERSION) {
    warnings.push(`文件由更新版本 (v${version}) 创建，部分功能可能不可用。`);
  }

  const layersRaw = Array.isArray(o['layers']) ? (o['layers'] as unknown[]) : [];
  const layers = layersRaw.length > 0 ? layersRaw.map(decodeLayer) : [{ ...DEFAULT_LAYER }];
  if (layers.length === 0) layers.push({ ...DEFAULT_LAYER });

  const layerIds = new Set(layers.map((l) => l.id));
  const fallbackLayer = layers[0]!.id;

  const entitiesRaw = Array.isArray(o['entities']) ? (o['entities'] as unknown[]) : [];
  const entities: Entity[] = [];
  let droppedCount = 0;
  for (const raw of entitiesRaw) {
    const e = decodeEntity(raw, fallbackLayer);
    if (!e) {
      droppedCount += 1;
      continue;
    }
    if (!layerIds.has(e.layer)) {
      // Preserve the reference but make it resolvable.
      e.layer = fallbackLayer;
      warnings.push(`图元引用了不存在的图层，已重置到 "${layers[0]!.name}"。`);
    }
    entities.push(e);
  }
  if (droppedCount > 0) {
    warnings.push(`跳过 ${droppedCount} 个无法识别的图元。`);
  }

  const metaRaw = (o['meta'] ?? {}) as Record<string, unknown>;
  const now = new Date().toISOString();

  // ---- constraints ---------------------------------------------------------
  //
  // Read *after* the entities, because the only sensible validation is
  // referential: a constraint pointing at a curve that is not in the file is
  // not a relationship, and keeping it would make every later solve skip a
  // broken row. Same defensive posture as entities — a bad entry is dropped
  // with a warning rather than failing the whole load.
  const entityIds = new Set(entities.map((e) => e.id));
  const constraintsRaw = Array.isArray(o['constraints']) ? (o['constraints'] as unknown[]) : [];
  const constraints: Constraint[] = [];
  let droppedConstraints = 0;
  for (const raw of constraintsRaw) {
    const c = decodeConstraint(raw, entityIds);
    if (c) constraints.push(c);
    else droppedConstraints += 1;
  }
  if (droppedConstraints > 0) {
    warnings.push(`跳过 ${droppedConstraints} 个无法识别的约束。`);
  }

  const planes = decodePlanes(o['planes']);
  const frames = decodeFrames(o['frames']);
  // The active plane has to name a plane that actually exists — otherwise every
  // new sketch would have nowhere to go.
  const wanted = str(o['activePlane']);
  const activePlane = planes.some((p) => p.id === wanted) ? wanted : (planes[0]?.id ?? XY_PLANE);

  const doc: CadDocument = {
    meta: {
      title: str(metaRaw['title'], 'Drawing1'),
      author: str(metaRaw['author'], ''),
      createdAt: str(metaRaw['createdAt'], now),
      modifiedAt: str(metaRaw['modifiedAt'], now),
      version: FILE_VERSION,
    },
    settings: decodeSettings(o['settings']),
    layers,
    currentLayer: layerIds.has(str(o['currentLayer'])) ? str(o['currentLayer']) : fallbackLayer,
    entities,
    constraints,
    solids: decodeSolids(o['solids']),
    planes,
    frames,
    activePlane,
  };

  return { doc, warnings };
}

/**
 * Read the solids array, dropping anything malformed.
 *
 * There is nothing to normalise — a solid is four scalars — so this only guards
 * the shape. A solid whose sketch is missing is *kept*: the sketch may simply be
 * on a layer the loader skipped, and the render pass already treats a solid with
 * no source as "nothing to draw" rather than as a crash.
 */
function decodeSolids(raw: unknown): Solid[] {
  if (!Array.isArray(raw)) return [];
  const out: Solid[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = typeof o['id'] === 'string' ? o['id'] : null;
    const source = typeof o['source'] === 'string' ? o['source'] : null;
    const layer = typeof o['layer'] === 'string' ? o['layer'] : null;
    const height = typeof o['height'] === 'number' ? o['height'] : NaN;
    if (!id || !source || !layer || !Number.isFinite(height)) continue;
    out.push({ id, source, height, layer });
  }
  return out;
}

function vec3(raw: unknown): [number, number, number] | null {
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const x = num(raw[0], NaN);
  const y = num(raw[1], NaN);
  const z = num(raw[2], NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

function decodePlane(raw: unknown): DocPlane | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o['id'] === 'string' ? o['id'] : null;
  const origin = vec3(o['origin']);
  const u = vec3(o['u']);
  const v = vec3(o['v']);
  if (!id || !origin || !u || !v) return null;
  return { id, name: str(o['name']) || id, origin, u, v, visible: o['visible'] !== false };
}

/**
 * Read the datum planes, and guarantee the three base ones.
 *
 * A sketch names its plane, and a sketch whose plane is missing has nowhere to
 * be drawn — so `xy` / `yz` / `zx` are prepended whenever the file does not
 * provide them, rather than trusting the file to be complete.
 */
function decodePlanes(raw: unknown): DocPlane[] {
  const out: DocPlane[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const p = decodePlane(item);
      if (p && !seen.has(p.id)) {
        seen.add(p.id);
        out.push(p);
      }
    }
  }
  for (const base of defaultPlanes()) {
    if (!seen.has(base.id)) out.unshift(base);
  }
  return out;
}

/** Frames: the world frame is guaranteed, same rule as the base planes. */
function decodeFrames(raw: unknown): DocFrame[] {
  const out: DocFrame[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const id = typeof o['id'] === 'string' ? o['id'] : null;
      const origin = vec3(o['origin']);
      const xAxis = vec3(o['xAxis']);
      const yAxis = vec3(o['yAxis']);
      if (!id || !origin || !xAxis || !yAxis || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        name: str(o['name']) || id,
        origin,
        xAxis,
        yAxis,
        visible: o['visible'] !== false,
      });
    }
  }
  if (!seen.has('world')) out.unshift(defaultFrames()[0]!);
  return out;
}

/**
 * Produce a document from arbitrary JSON, filling in anything missing.
 * Used by the "open" flow so a partially-corrupt file still yields something.
 */
export function deserializeLoose(input: string): LoadResult {
  try {
    return deserializeDocument(input);
  } catch {
    const doc = createEmptyDocument();
    return { doc, warnings: ['文件无法解析，已创建空白图纸。'] };
  }
}

/** Validate that an entity type string is one we understand. */
export function isKnownEntityType(t: string): t is EntityType {
  return t === 'line' || t === 'polyline' || t === 'circle' || t === 'arc' || t === 'ellipse';
}

// ---------------------------------------------------------------------------
// Browser file helpers
// ---------------------------------------------------------------------------

export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Prompt for a file and return its text contents. */
export function pickTextFile(accept: string): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        input.remove();
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        resolve({ name: file.name, text: String(reader.result ?? '') });
        input.remove();
      };
      reader.onerror = () => {
        resolve(null);
        input.remove();
      };
      reader.readAsText(file);
    });
    // Some browsers never fire 'change' if the user cancels; the element is
    // garbage-collected, so we simply never resolve in that case.
    document.body.appendChild(input);
    input.click();
  });
}
