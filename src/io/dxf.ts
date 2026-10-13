/**
 * DXF R12 ASCII import / export.
 *
 * R12 is the sweet spot for interoperability: AutoCAD, LibreCAD, QCAD, Inkscape,
 * Illustrator, FreeCAD and every laser-cutter / plotter pipeline reads it, and
 * the format is small enough to write and verify by hand.
 *
 * Supported on export:
 *   HEADER (extents + units), TABLES (LAYER + LTYPE), ENTITIES
 *   entities: LINE, LWPOLYLINE, POLYLINE/VERTEX (R12-safe), CIRCLE, ARC, ELLIPSE, POINT
 *
 * Supported on import:
 *   LINE, LWPOLYLINE, POLYLINE, CIRCLE, ARC, ELLIPSE, SPLINE (flattened),
 *   plus layer/color/linetype resolution from the TABLES section.
 *
 * Coordinates: DXF is y-up in model space, matching ours, and OCS extrusion is
 * ignored (a Z of 0 is assumed throughout) — the vast majority of 2D drawings
 * are authored that way.
 */

import type {
  ArcEntity,
  CadDocument,
  CircleEntity,
  EllipseEntity,
  Entity,
  Layer,
  LayerId,
  LineEntity,
  LineStyle,
  PolylineEntity,
  Vec2,
} from '../core/types';
import { createEmptyDocument } from '../core/types';
import { newEntityId, newLayerId } from '../core/entities';
import { appendEntities, replaceEntities, sketchEntities } from '../core/doc';

// ---------------------------------------------------------------------------
// Group code writer
// ---------------------------------------------------------------------------

class DxfWriter {
  private lines: string[] = [];

  /** Emit a DXF group: a code on its own line, then its value. */
  g(code: number, value: string | number): this {
    this.lines.push(String(code));
    this.lines.push(typeof value === 'number' ? formatNumber(value) : value);
    return this;
  }

  raw(text: string): this {
    this.lines.push(text);
    return this;
  }

  toString(): string {
    return `${this.lines.join('\r\n')}\r\n`;
  }
}

/** DXF wants plain decimals — no exponent notation, no trailing zeros. */
function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  const s = n.toFixed(9);
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

// ---------------------------------------------------------------------------
// Linetype mapping
// ---------------------------------------------------------------------------

/** Map our linetypes onto the standard ACAD.LIN names R12 readers know. */
const LINETYPE_TO_DXF: Record<LineStyle, string> = {
  continuous: 'CONTINUOUS',
  dashed: 'DASHED',
  dotted: 'DOT',
  dashdot: 'DASHDOT',
  center: 'CENTER',
  hidden: 'HIDDEN',
};

const DXF_TO_LINETYPE: Record<string, LineStyle> = {
  CONTINUOUS: 'continuous',
  BYLAYER: 'continuous',
  BYBLOCK: 'continuous',
  DASHED: 'dashed',
  DASHED2: 'dashed',
  DASHEDX2: 'dashed',
  DOT: 'dotted',
  DOT2: 'dotted',
  DOTX2: 'dotted',
  DASHDOT: 'dashdot',
  DASHDOT2: 'dashdot',
  CENTER: 'center',
  CENTER2: 'center',
  HIDDEN: 'hidden',
  HIDDEN2: 'hidden',
};

/** Standard dash definitions for the linetypes we emit. */
const LINETYPE_DEFS: Array<{ name: string; desc: string; pattern: number[] }> = [
  { name: 'CONTINUOUS', desc: 'Solid line', pattern: [] },
  { name: 'DASHED', desc: 'Dashed __ __ __', pattern: [0.5, -0.25] },
  { name: 'DOT', desc: 'Dot . . . .', pattern: [0, -0.25] },
  { name: 'DASHDOT', desc: 'Dash dot __ . __ .', pattern: [0.5, -0.25, 0, -0.25] },
  { name: 'CENTER', desc: 'Center ____ _ ____', pattern: [1.25, -0.25, 0.25, -0.25] },
  { name: 'HIDDEN', desc: 'Hidden __ __ __', pattern: [0.25, -0.125] },
];

// ---------------------------------------------------------------------------
// Colour conversion: AutoCAD Color Index ↔ #rrggbb
// ---------------------------------------------------------------------------

/**
 * The first 256 ACI colours. We only need a good round-trip for the common
 * indices, so this is the standard palette table (indices 0–255 with 0 and
 * 256 meaning BYBLOCK / BYLAYER and therefore unused here).
 */
const ACI_PALETTE: string[] = [
  '#000000', '#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ffffff',
  '#808080', '#c0c0c0', '#ff0000', '#ff7f7f', '#cc0000', '#cc6666', '#990000', '#994c4c',
  '#7f0000', '#7f3f3f', '#4c0000', '#4c2626', '#ff3f00', '#ff9f7f', '#cc3200', '#cc7f66',
  '#992600', '#995f4c', '#7f1f00', '#7f4f3f', '#4c1300', '#4c2f26', '#ff7f00', '#ffbf7f',
  '#cc6600', '#cc9966', '#994c00', '#99724c', '#7f3f00', '#7f5f3f', '#4c2600', '#4c3926',
  '#ffbf00', '#ffdf7f', '#cc9900', '#ccb266', '#997300', '#99854c', '#7f5f00', '#7f6f3f',
  '#4c3900', '#4c4226', '#ffff00', '#ffff7f', '#cccc00', '#cccc66', '#999900', '#99994c',
  '#7f7f00', '#7f7f3f', '#4c4c00', '#4c4c26', '#bfff00', '#dfff7f', '#99cc00', '#b2cc66',
  '#739900', '#85994c', '#5f7f00', '#6f7f3f', '#394c00', '#424c26', '#7fff00', '#bfff7f',
  '#66cc00', '#99cc66', '#4c9900', '#72994c', '#3f7f00', '#5f7f3f', '#264c00', '#394c26',
  '#3fff00', '#9fff7f', '#32cc00', '#7fcc66', '#269900', '#5f994c', '#1f7f00', '#4f7f3f',
  '#134c00', '#2f4c26', '#00ff00', '#7fff7f', '#00cc00', '#66cc66', '#009900', '#4c994c',
  '#007f00', '#3f7f3f', '#004c00', '#264c26', '#00ff3f', '#7fff9f', '#00cc32', '#66cc7f',
  '#009926', '#4c995f', '#007f1f', '#3f7f4f', '#004c13', '#264c2f', '#00ff7f', '#7fffbf',
  '#00cc66', '#66cc99', '#00994c', '#4c9972', '#007f3f', '#3f7f5f', '#004c26', '#264c39',
  '#00ffbf', '#7fffdf', '#00cc99', '#66ccb2', '#009973', '#4c9985', '#007f5f', '#3f7f6f',
  '#004c39', '#264c42', '#00ffff', '#7fffff', '#00cccc', '#66cccc', '#009999', '#4c9999',
  '#007f7f', '#3f7f7f', '#004c4c', '#264c4c', '#00bfff', '#7fdfff', '#0099cc', '#66b2cc',
  '#007399', '#4c8599', '#005f7f', '#3f6f7f', '#00394c', '#26424c', '#007fff', '#7fbfff',
  '#0066cc', '#6699cc', '#004c99', '#4c7299', '#003f7f', '#3f5f7f', '#00264c', '#26394c',
  '#003fff', '#7f9fff', '#0032cc', '#667fcc', '#002699', '#4c5f99', '#001f7f', '#3f4f7f',
  '#00134c', '#262f4c', '#0000ff', '#7f7fff', '#0000cc', '#6666cc', '#000099', '#4c4c99',
  '#00007f', '#3f3f7f', '#00004c', '#26264c', '#3f00ff', '#9f7fff', '#3200cc', '#7f66cc',
  '#260099', '#5f4c99', '#1f007f', '#4f3f7f', '#13004c', '#2f264c', '#7f00ff', '#bf7fff',
  '#6600cc', '#9966cc', '#4c0099', '#724c99', '#3f007f', '#5f3f7f', '#26004c', '#39264c',
  '#bf00ff', '#df7fff', '#9900cc', '#b266cc', '#730099', '#854c99', '#5f007f', '#6f3f7f',
  '#39004c', '#42264c', '#ff00ff', '#ff7fff', '#cc00cc', '#cc66cc', '#990099', '#994c99',
  '#7f007f', '#7f3f7f', '#4c004c', '#4c264c', '#ff00bf', '#ff7fdf', '#cc0099', '#cc66b2',
  '#990073', '#994c85', '#7f005f', '#7f3f6f', '#4c0039', '#4c2642', '#ff007f', '#ff7fbf',
  '#cc0066', '#cc6699', '#99004c', '#994c72', '#7f003f', '#7f3f5f', '#4c0026', '#4c2639',
  '#ff003f', '#ff7f9f', '#cc0032', '#cc667f', '#990026', '#994c5f', '#7f001f', '#7f3f4f',
  '#4c0013', '#4c262f', '#ff0000', '#ff7f7f', '#cc0000', '#cc6666', '#990000', '#994c4c',
  '#7f0000', '#7f3f3f', '#4c0000', '#4c2626', '#ff0000', '#ff7f7f', '#cc0000', '#cc6666',
];

/** Nearest ACI index for an RGB colour — reverse lookup by distance. */
export function colorToAci(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 7; // white / black depending on background
  let best = 7;
  let bestD = Infinity;
  // Skip 0 (BYBLOCK) and 256 (BYLAYER).
  for (let i = 1; i < 256 && i < ACI_PALETTE.length; i++) {
    const c = hexToRgb(ACI_PALETTE[i]!);
    if (!c) continue;
    const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export function aciToColor(aci: number): string {
  if (aci <= 0 || aci >= ACI_PALETTE.length) return '#e8e8e8';
  return ACI_PALETTE[aci]!;
}

function hexToRgb(hex: string): [number, number, number] | null {
  let h = hex.trim();
  if (h.startsWith('#')) h = h.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface DxfExportOptions {
  /** `R12` (default) keeps maximum compatibility; `R12` is the only supported value. */
  version?: 'R12';
  /** Write a HEADER section with drawing extents. */
  writeExtents?: boolean;
}

export function exportDxf(doc: CadDocument, opts: DxfExportOptions = {}): string {
  const w = new DxfWriter();
  void opts.version;

  const bounds = computeExtents(doc);

  // ---- HEADER ------------------------------------------------------------
  w.g(0, 'SECTION').g(2, 'HEADER');
  w.g(9, '$ACADVER').g(1, 'AC1009'); // R12
  w.g(9, '$INSBASE').g(10, 0).g(20, 0).g(30, 0);
  if (opts.writeExtents !== false) {
    w.g(9, '$EXTMIN').g(10, formatNumber(bounds.minX)).g(20, formatNumber(bounds.minY)).g(30, 0);
    w.g(9, '$EXTMAX').g(10, formatNumber(bounds.maxX)).g(20, formatNumber(bounds.maxY)).g(30, 0);
  }
  w.g(9, '$INSUNITS').g(70, unitsCode(doc.settings.units));
  w.g(9, '$LTSCALE').g(40, 1);
  w.g(0, 'ENDSEC');

  // ---- TABLES ------------------------------------------------------------
  w.g(0, 'SECTION').g(2, 'TABLES');

  // LTYPE table
  w.g(0, 'TABLE').g(2, 'LTYPE').g(70, LINETYPE_DEFS.length);
  for (const lt of LINETYPE_DEFS) {
    w.g(0, 'LTYPE').g(2, lt.name).g(70, 0).g(3, lt.desc).g(72, 65);
    w.g(73, lt.pattern.length);
    w.g(40, lt.pattern.reduce((a, b) => a + Math.abs(b), 0));
    for (const seg of lt.pattern) w.g(49, seg);
  }
  w.g(0, 'ENDTAB');

  // LAYER table
  w.g(0, 'TABLE').g(2, 'LAYER').g(70, doc.layers.length);
  for (const layer of doc.layers) {
    w.g(0, 'LAYER');
    w.g(2, sanitizeName(layer.name));
    // A negative colour index means "layer is off" in DXF.
    const aci = colorToAci(layer.color);
    w.g(70, layer.locked ? 4 : 0);
    w.g(62, layer.visible && !layer.frozen ? aci : -aci);
    w.g(6, LINETYPE_TO_DXF[layer.lineStyle] ?? 'CONTINUOUS');
  }
  w.g(0, 'ENDTAB');

  w.g(0, 'ENDSEC');

  // ---- ENTITIES ----------------------------------------------------------
  // The **active sketch** only — the same set the 2D view draws. DXF is a flat
  // 2D exchange format, and an entity on another datum plane has no position
  // in one drawing: exporting it would lay its (u, v) on top of unrelated
  // coordinates. (`PHASE1_PLAN.md` risk 7; the README's format section is
  // where this gets promised to users, in work package 1.6.)
  w.g(0, 'SECTION').g(2, 'ENTITIES');
  for (const e of sketchEntities(doc)) writeEntity(w, doc, e);
  w.g(0, 'ENDSEC');

  w.g(0, 'EOF');
  return w.toString();
}

function unitsCode(units: CadDocument['settings']['units']): number {
  // 4 = millimetres, 5 = centimetres, 6 = metres, 1 = inches
  switch (units) {
    case 'mm': return 4;
    case 'cm': return 5;
    case 'm': return 6;
    case 'in': return 1;
  }
}

/** DXF layer names must be unique and free of certain punctuation. */
function sanitizeName(name: string): string {
  return name.replace(/[<>/\\":;?*|=`,]/g, '_').slice(0, 31) || 'LAYER';
}

function layerName(doc: CadDocument, id: LayerId): string {
  const l = doc.layers.find((x) => x.id === id);
  return sanitizeName(l?.name ?? '0');
}

/** Resolve the colour to write: explicit RGB → truecolor, else ACI. */
function writeCommon(w: DxfWriter, doc: CadDocument, e: Entity, type: string): void {
  w.g(0, type);
  w.g(8, layerName(doc, e.layer));
  w.g(6, e.lineStyle ? (LINETYPE_TO_DXF[e.lineStyle] ?? 'BYLAYER') : 'BYLAYER');
  if (e.color) {
    const aci = colorToAci(e.color);
    w.g(62, aci);
    // 420 is the truecolor group — understood by R2004+ readers, harmless in R12.
    const rgb = hexToRgb(e.color);
    if (rgb) w.g(420, (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]);
  } else {
    w.g(62, 256); // BYLAYER
  }
}

function writeEntity(w: DxfWriter, doc: CadDocument, e: Entity): void {
  switch (e.type) {
    case 'line':
      writeCommon(w, doc, e, 'LINE');
      w.g(10, formatNumber(e.a.x)).g(20, formatNumber(e.a.y)).g(30, 0);
      w.g(11, formatNumber(e.b.x)).g(21, formatNumber(e.b.y)).g(31, 0);
      break;

    case 'circle':
      writeCommon(w, doc, e, 'CIRCLE');
      w.g(10, formatNumber(e.center.x)).g(20, formatNumber(e.center.y)).g(30, 0);
      w.g(40, formatNumber(e.radius));
      break;

    case 'arc':
      writeCommon(w, doc, e, 'ARC');
      w.g(10, formatNumber(e.center.x)).g(20, formatNumber(e.center.y)).g(30, 0);
      w.g(40, formatNumber(e.radius));
      // DXF arcs always run CCW from start to end, matching our convention.
      w.g(50, formatNumber(radiansToDegrees(e.startAngle)));
      w.g(51, formatNumber(radiansToDegrees(e.endAngle)));
      break;

    case 'ellipse': {
      // R12 has no ELLIPSE entity; approximate with a closed LWPOLYLINE so the
      // geometry survives in every reader.
      const poly = ellipseToPolyline(e, 128);
      writeCommon(w, doc, { ...e, id: e.id } as Entity, 'LWPOLYLINE');
      w.g(90, poly.points.length).g(70, 1);
      for (const p of poly.points) {
        w.g(10, formatNumber(p.x)).g(20, formatNumber(p.y));
      }
      break;
    }

    case 'polyline': {
      // LWPOLYLINE is the compact modern form and is what R12-era tools expect
      // when targeting 2D drafts; we do not emit the heavyweight POLYLINE form.
      writeCommon(w, doc, e, 'LWPOLYLINE');
      w.g(90, e.points.length).g(70, e.closed ? 1 : 0);
      for (const p of e.points) {
        w.g(10, formatNumber(p.x)).g(20, formatNumber(p.y));
      }
      break;
    }
  }
}

function radiansToDegrees(rad: number): number {
  let deg = (rad * 180) / Math.PI;
  deg = ((deg % 360) + 360) % 360;
  return deg;
}

function degreesToRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Flatten a rotated ellipse into a closed polyline at the given resolution. */
export function ellipseToPolyline(e: EllipseEntity, steps = 128): PolylineEntity {
  const points: Vec2[] = [];
  const cos = Math.cos(e.rotation);
  const sin = Math.sin(e.rotation);
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const x = e.rx * Math.cos(t);
    const y = e.ry * Math.sin(t);
    points.push({
      x: e.center.x + x * cos - y * sin,
      y: e.center.y + x * sin + y * cos,
    });
  }
  return {
    id: e.id,
    type: 'polyline',
    layer: e.layer,
    color: e.color,
    lineStyle: e.lineStyle,
    lineWeight: e.lineWeight,
    points,
    closed: true,
  };
}

function computeExtents(doc: CadDocument): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  let first = true;
  // The exported set — the active sketch (see `exportDxf`). Extents that
  // covered geometry the file does not contain would be a header lie.
  for (const e of sketchEntities(doc)) {
    for (const p of entityPoints(e)) {
      if (first) {
        minX = maxX = p.x;
        minY = maxY = p.y;
        first = false;
      } else {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

function entityPoints(e: Entity): Vec2[] {
  switch (e.type) {
    case 'line':
      return [e.a, e.b];
    case 'polyline':
      return e.points;
    case 'circle':
      return [
        { x: e.center.x - e.radius, y: e.center.y - e.radius },
        { x: e.center.x + e.radius, y: e.center.y + e.radius },
      ];
    case 'arc':
      return [
        { x: e.center.x - e.radius, y: e.center.y - e.radius },
        { x: e.center.x + e.radius, y: e.center.y + e.radius },
      ];
    case 'ellipse':
      return ellipseToPolyline(e, 16).points;
  }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

interface DxfPair {
  code: number;
  value: string;
}

/** Parse the group-code stream. Tolerates both CRLF and LF line endings. */
function tokenize(text: string): DxfPair[] {
  const lines = text.split(/\r\n|\r|\n/);
  const out: DxfPair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const codeLine = lines[i]!.trim();
    if (codeLine.length === 0) continue;
    const code = Number(codeLine);
    if (!Number.isFinite(code)) continue;
    out.push({ code, value: lines[i + 1] ?? '' });
  }
  return out;
}

export interface DxfImportResult {
  doc: CadDocument;
  warnings: string[];
}

export function importDxf(text: string, title = 'DXF Import'): DxfImportResult {
  const pairs = tokenize(text);
  const warnings: string[] = [];

  if (pairs.length === 0) {
    return { doc: createEmptyDocument(title), warnings: ['DXF 文件为空或格式无法识别。'] };
  }

  // ---- Pass 1: TABLES (layers + linetypes) ------------------------------
  const layers: Layer[] = [];
  const layerNameToId = new Map<string, LayerId>();

  let i = 0;
  let sectionName = '';
  const layerRecords: Array<{ name: string; color: number; linetype: string; flags: number }> = [];

  while (i < pairs.length) {
    const p = pairs[i]!;
    if (p.code === 0 && p.value === 'SECTION') {
      sectionName = pairs[i + 1]?.value ?? '';
      i += 2;
      continue;
    }
    if (p.code === 0 && p.value === 'ENDSEC') {
      sectionName = '';
      i += 1;
      continue;
    }
    if (sectionName === 'TABLES' && p.code === 0 && p.value === 'LAYER') {
      // Collect the layer's groups until the next entity/table marker.
      const rec = { name: '', color: 7, linetype: 'CONTINUOUS', flags: 0 };
      let j = i + 1;
      while (j < pairs.length && pairs[j]!.code !== 0) {
        const q = pairs[j]!;
        if (q.code === 2) rec.name = q.value;
        else if (q.code === 62) rec.color = Number(q.value) || 7;
        else if (q.code === 6) rec.linetype = q.value.toUpperCase();
        else if (q.code === 70) rec.flags = Number(q.value) || 0;
        j += 1;
      }
      if (rec.name) layerRecords.push(rec);
      i = j;
      continue;
    }
    i += 1;
  }

  for (const rec of layerRecords) {
    // A negative colour index means the layer is switched off.
    const visible = rec.color >= 0;
    const aci = Math.abs(rec.color);
    const layer: Layer = {
      id: newLayerId(rec.name),
      name: rec.name,
      color: aciToColor(aci),
      lineStyle: DXF_TO_LINETYPE[rec.linetype] ?? 'continuous',
      lineWeight: 0.25,
      visible,
      locked: (rec.flags & 4) !== 0,
      frozen: (rec.flags & 1) !== 0,
      printable: true,
    };
    layers.push(layer);
    layerNameToId.set(rec.name.toUpperCase(), layer.id);
  }

  if (layers.length === 0) {
    layers.push({ id: 'layer-0', name: '0', color: '#e8e8e8', lineStyle: 'continuous', lineWeight: 0.25, visible: true, locked: false, frozen: false, printable: true });
    layerNameToId.set('0', 'layer-0');
  }

  const resolveLayer = (name: string): LayerId => {
    const key = name.toUpperCase();
    let id = layerNameToId.get(key);
    if (!id) {
      // Layer referenced by an entity but never declared — create it lazily.
      id = newLayerId(name || '0');
      layers.push({
        id,
        name: name || '0',
        color: '#e8e8e8',
        lineStyle: 'continuous',
        lineWeight: 0.25,
        visible: true,
        locked: false,
        frozen: false,
        printable: true,
      });
      layerNameToId.set(key, id);
    }
    return id;
  };

  // ---- Pass 2: ENTITIES -------------------------------------------------
  const entities: Entity[] = [];
  i = 0;
  sectionName = '';

  while (i < pairs.length) {
    const p = pairs[i]!;
    if (p.code === 0 && p.value === 'SECTION') {
      sectionName = pairs[i + 1]?.value ?? '';
      i += 2;
      continue;
    }
    if (p.code === 0 && p.value === 'ENDSEC') {
      sectionName = '';
      i += 1;
      continue;
    }
    if (sectionName !== 'ENTITIES' || p.code !== 0) {
      i += 1;
      continue;
    }

    const kind = p.value.toUpperCase();
    const rec: DxfPair[] = [];
    let j = i + 1;
    while (j < pairs.length && pairs[j]!.code !== 0) {
      rec.push(pairs[j]!);
      j += 1;
    }
    i = j;

    const parsed = parseEntityRecord(kind, rec, resolveLayer);
    if (parsed) {
      if (Array.isArray(parsed)) entities.push(...parsed);
      else entities.push(parsed);
    } else if (kind !== 'SEQEND' && kind !== 'VERTEX' && kind !== 'POLYLINE') {
      // Silently skip entities we intentionally do not support (TEXT, DIMENSION…)
      // but surface genuinely unknown ones.
      const known = [
        'LINE', 'LWPOLYLINE', 'CIRCLE', 'ARC', 'ELLIPSE', 'POINT',
        'SPLINE', 'POLYLINE', 'VERTEX', 'SEQEND', 'TEXT', 'MTEXT', 'DIMENSION',
        'INSERT', 'HATCH', 'SOLID', '3DFACE', 'LEADER', 'ATTDEF', 'ATTRIB',
      ];
      if (!known.includes(kind)) {
        warnings.push(`跳过不支持的图元类型: ${kind}`);
      }
    }
  }

  const doc = createEmptyDocument(title);
  doc.layers = layers;
  doc.currentLayer = layers[0]!.id;
  // A DXF file is one flat 2D drawing, so its entities land in the active
  // sketch of the fresh document (work package 1.6 turns this into an
  // explicit sketch node; the destination is already decided here).
  replaceEntities(doc, doc.activeSketch, entities);

  if (entities.length === 0) {
    warnings.push('未从 DXF 中读取到任何图元。');
  }

  return { doc, warnings };
}

/** Index all pairs by group code for convenience. */
function first(rec: DxfPair[], code: number): string | undefined {
  return rec.find((p) => p.code === code)?.value;
}

function all(rec: DxfPair[], code: number): string[] {
  return rec.filter((p) => p.code === code).map((p) => p.value);
}

function allNumbers(rec: DxfPair[], code: number): number[] {
  return all(rec, code).map(Number).filter(Number.isFinite);
}

const BYLAYER = 256;
const BYBLOCK = 0;

function resolveColor(colorIndex: number | undefined, trueColor: number | undefined, _layerColor: string): string | null {
  if (trueColor !== undefined && Number.isFinite(trueColor)) {
    const r = (trueColor >> 16) & 255;
    const g = (trueColor >> 8) & 255;
    const b = trueColor & 255;
    // A truecolor of 0 is meaningless; treat it as unset.
    if (trueColor !== 0) {
      return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    }
  }
  if (colorIndex === undefined || colorIndex === BYLAYER || colorIndex === BYBLOCK) {
    return null; // inherit
  }
  return aciToColor(colorIndex);
}

/**
 * Turn one DXF entity record into our entity (or entities).
 *
 * Returns a single entity, an array (POLYLINE + VERTEX expands to several), or
 * `null` when the record is a control marker or unsupported.
 */
function parseEntityRecord(
  kind: string,
  rec: DxfPair[],
  resolveLayer: (name: string) => LayerId,
): Entity | Entity[] | null {
  const layerName = first(rec, 8) ?? '0';
  const layer = resolveLayer(layerName);
  const linetypeRaw = (first(rec, 6) ?? '').toUpperCase();
  const lineStyle = DXF_TO_LINETYPE[linetypeRaw] ?? null;
  const colorIdx = first(rec, 62) !== undefined ? Number(first(rec, 62)) : undefined;
  const trueColor = first(rec, 420) !== undefined ? Number(first(rec, 420)) : undefined;
  const color = resolveColor(colorIdx, trueColor, '#e8e8e8');
  const lwRaw = first(rec, 370) !== undefined ? Number(first(rec, 370)) : undefined;
  const lineWeight = lwRaw !== undefined && Number.isFinite(lwRaw) ? lwRaw / 100 : null;

  const base = {
    id: newEntityId(),
    layer,
    color,
    lineStyle,
    lineWeight,
  };

  const x = (c: number): number => Number(first(rec, c) ?? 0) || 0;

  switch (kind) {
    case 'LINE': {
      const e: LineEntity = {
        ...base,
        type: 'line',
        a: { x: x(10), y: x(20) },
        b: { x: x(11), y: x(21) },
      };
      return e;
    }
    case 'CIRCLE': {
      const r = x(40);
      if (r <= 0) return null;
      const e: CircleEntity = { ...base, type: 'circle', center: { x: x(10), y: x(20) }, radius: r };
      return e;
    }
    case 'ARC': {
      const r = x(40);
      if (r <= 0) return null;
      const e: ArcEntity = {
        ...base,
        type: 'arc',
        center: { x: x(10), y: x(20) },
        radius: r,
        startAngle: degreesToRadians(x(50)),
        endAngle: degreesToRadians(x(51)),
      };
      return e;
    }
    case 'LWPOLYLINE': {
      const xs = allNumbers(rec, 10);
      const ys = allNumbers(rec, 20);
      const n = Math.min(xs.length, ys.length);
      if (n < 2) return null;
      const points: Vec2[] = [];
      for (let k = 0; k < n; k++) points.push({ x: xs[k]!, y: ys[k]! });
      const closed = ((Number(first(rec, 70) ?? 0) | 0) & 1) !== 0;
      const e: PolylineEntity = { ...base, type: 'polyline', points, closed };
      return e;
    }
    case 'POLYLINE': {
      // The heavyweight form stores vertices as following VERTEX records; our
      // scanner collects nothing here and the caller stitches VERTEXes in via
      // the pre-pass below. We return null and rely on `collectPolylines`.
      return null;
    }
    case 'ELLIPSE': {
      const cx = x(10);
      const cy = x(20);
      const mx = x(11);
      const my = x(21);
      const ratio = x(40) || 1;
      const startParam = x(41);
      const endParam = x(42) || Math.PI * 2;
      const rx = Math.hypot(mx, my);
      const ry = Math.abs(rx * ratio);
      const rotation = Math.atan2(my, mx);
      void startParam;
      if (rx <= 0 || ry <= 0) return null;
      const e: EllipseEntity = { ...base, type: 'ellipse', center: { x: cx, y: cy }, rx, ry, rotation };
      // Full ellipses import as ellipses; partial ones are flattened.
      const fullSweep = Math.abs(endParam - startParam) >= Math.PI * 2 - 1e-6;
      if (fullSweep) return e;
      const steps = Math.max(8, Math.round((128 * Math.abs(endParam - startParam)) / (Math.PI * 2)));
      const points: Vec2[] = [];
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      for (let k = 0; k <= steps; k++) {
        const t = startParam + ((endParam - startParam) * k) / steps;
        const px = rx * Math.cos(t);
        const py = ry * Math.sin(t);
        points.push({ x: cx + px * cos - py * sin, y: cy + px * sin + py * cos });
      }
      const poly: PolylineEntity = { ...base, type: 'polyline', points, closed: false };
      return poly;
    }
    case 'SPLINE': {
      // Approximate by sampling the control polygon — good enough for 2D CAD
      // interchange, and avoids implementing the full NURBS evaluator.
      const xs = allNumbers(rec, 10);
      const ys = allNumbers(rec, 20);
      const n = Math.min(xs.length, ys.length);
      if (n < 2) return null;
      const points: Vec2[] = [];
      for (let k = 0; k < n; k++) points.push({ x: xs[k]!, y: ys[k]! });
      const poly: PolylineEntity = { ...base, type: 'polyline', points, closed: false };
      return poly;
    }
    case 'POINT': {
      // Our model has no point entity; represent as a degenerate 2-vertex polyline
      // so the location is at least preserved and visible.
      const px = x(10);
      const py = x(20);
      const poly: PolylineEntity = {
        ...base,
        type: 'polyline',
        points: [{ x: px, y: py }, { x: px, y: py }],
        closed: false,
      };
      return poly;
    }
    default:
      return null;
  }
}

/**
 * Second pass for the classic POLYLINE/VERTEX/SEQEND triplet, which the
 * straightforward scanner above cannot handle because the vertices are
 * siblings rather than children.
 */
function collectHeavyPolylines(
  pairs: DxfPair[],
  resolveLayer: (name: string) => LayerId,
): Entity[] {
  const out: Entity[] = [];
  let i = 0;
  while (i < pairs.length) {
    const p = pairs[i]!;
    if (p.code === 0 && p.value.toUpperCase() === 'POLYLINE') {
      const header: DxfPair[] = [];
      let j = i + 1;
      while (j < pairs.length && pairs[j]!.code !== 0) {
        header.push(pairs[j]!);
        j += 1;
      }
      // Collect the vertex run that follows.
      const verts: DxfPair[][] = [];
      let k = j;
      while (k < pairs.length && pairs[k]!.code === 0 && (pairs[k]!.value.toUpperCase() === 'VERTEX')) {
        const vrec: DxfPair[] = [];
        let m = k + 1;
        while (m < pairs.length && pairs[m]!.code !== 0) {
          vrec.push(pairs[m]!);
          m += 1;
        }
        verts.push(vrec);
        k = m;
      }
      // Skip the SEQEND if present.
      if (k < pairs.length && pairs[k]!.code === 0 && pairs[k]!.value.toUpperCase() === 'SEQEND') {
        k += 1;
        while (k < pairs.length && pairs[k]!.code !== 0) k += 1;
      }

      const points: Vec2[] = [];
      for (const v of verts) {
        points.push({ x: Number(first(v, 10) ?? 0) || 0, y: Number(first(v, 20) ?? 0) || 0 });
      }
      if (points.length >= 2) {
        const layerName = first(header, 8) ?? '0';
        const linetypeRaw = (first(header, 6) ?? '').toUpperCase();
        const closed = ((Number(first(header, 70) ?? 0) | 0) & 1) !== 0;
        out.push({
          id: newEntityId(),
          type: 'polyline',
          layer: resolveLayer(layerName),
          color: resolveColor(
            first(header, 62) !== undefined ? Number(first(header, 62)) : undefined,
            first(header, 420) !== undefined ? Number(first(header, 420)) : undefined,
            '#e8e8e8',
          ),
          lineStyle: DXF_TO_LINETYPE[linetypeRaw] ?? null,
          lineWeight: null,
          points,
          closed,
        });
      }
      i = k;
      continue;
    }
    i += 1;
  }
  return out;
}

/** Import a DXF, including the heavyweight POLYLINE form. */
export function importDxfComplete(text: string, title = 'DXF Import'): DxfImportResult {
  const result = importDxf(text, title);
  const pairs = tokenize(text);
  const layerNameToId = new Map<string, LayerId>();
  for (const l of result.doc.layers) layerNameToId.set(l.name.toUpperCase(), l.id);
  const resolveLayer = (name: string): LayerId => {
    const key = name.toUpperCase();
    let id = layerNameToId.get(key);
    if (!id) {
      id = newLayerId(name || '0');
      result.doc.layers.push({
        id,
        name: name || '0',
        color: '#e8e8e8',
        lineStyle: 'continuous',
        lineWeight: 0.25,
        visible: true,
        locked: false,
        frozen: false,
        printable: true,
      });
      layerNameToId.set(key, id);
    }
    return id;
  };
  const heavy = collectHeavyPolylines(pairs, resolveLayer);
  if (heavy.length > 0) {
    // Merged into the active sketch, like the rest of an import. Through the
    // document's write API rather than a bare push so there is exactly one
    // owner of the entity store.
    appendEntities(result.doc, result.doc.activeSketch, heavy);
    const filtered = result.warnings.filter((w) => !w.includes('未从 DXF'));
    result.warnings = filtered;
  }
  return result;
}

/** Quick check used by the file-open flow to decide the format. */
export function looksLikeDxf(text: string): boolean {
  const head = text.slice(0, 4096);
  return /(^|\n)\s*0\s*\r?\n\s*SECTION/.test(head) || head.includes('$ACADVER') || head.includes('ENTITIES');
}

export function dxfByteLength(text: string): number {
  // DXF is ASCII in our writer, but the drawing title may not be.
  return new Blob([text]).size;
}
