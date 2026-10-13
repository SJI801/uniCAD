/**
 * The feature tree (work package 1.4) — the panel that makes the document's
 * structure visible and editable.
 *
 * What it shows: the document's `nodes` in order, sketches and features alike,
 * because that order *is* evaluation order — a feature is only meaningful in
 * relation to the sketch it consumes, and drawing them interleaved is what
 * makes "which sketch feeds what" readable at a glance.
 *
 * Rows carry the three states a user has to tell apart: the **active** sketch
 * (where new geometry goes), a **suppressed** feature (greyed; no mesh), and a
 * **failed** one (red dot, reason on hover) — the last is the tree's whole
 * reason for existing before any second feature kind does.
 *
 * Every edit goes through `run()`, so one edit is one undo step: rename
 * (double-click the name), extrude height (double-click the height),
 * suppress/un-suppress, delete. Deleting a sketch is refused *by the store*
 * when anything would be lost — the row stays and the reason lands in the log,
 * the same posture as deleting a datum plane that still has geometry.
 */

import { useState } from 'react';
import { useEditor } from '../state/editorStore';
import { treeNodes } from '../core/doc';
import { NumberInput, TextInput } from './fields';
import type { BooleanFeature, Feature, FeatureId, SketchId, TreeNode } from '../core/types';

/** Which row is mid-edit, and which of its editable fields. */
type Editing = { id: string; field: 'name' | ParamSlot } | null;

/** A row can show several numbers (a hole has two, a pattern four). */
type ParamSlot = 'param' | 'param2' | 'param3' | 'param4';

/** One editable number on a row. */
interface ParamSpec {
  /** Which editing slot this is — the row can have four. */
  slot: ParamSlot;
  value: number;
  key: string;
  unit: string;
  label: string;
  set: (v: number) => void;
}

/** Row glyphs, shared with the ribbon's tool buttons where there is one. */
const FEATURE_GLYPH: Record<Feature['kind'], string> = {
  extrude: '⬒',
  revolve: '◑',
  boolean: '⊖',
  hole: '⊚',
  pattern: '▦',
  loft: '◭',
};

/** A boolean's glyph says *which* boolean — the row is the only place that shows it. */
const BOOL_GLYPH: Record<BooleanFeature['op'], string> = {
  subtract: '⊖',
  union: '∪',
  intersect: '∩',
};

const BOOL_LABEL: Record<BooleanFeature['op'], string> = {
  subtract: '差',
  union: '并',
  intersect: '交',
};

const FEATURE_TITLE: Record<Feature['kind'], string> = {
  extrude: '拉伸',
  revolve: '旋转',
  boolean: '布尔',
  hole: '孔',
  pattern: '阵列',
  loft: '放样',
};

export default function FeatureTree(): React.ReactElement {
  const doc = useEditor((s) => s.doc);
  const featureEval = useEditor((s) => s.featureEval);
  const selectedFeature = useEditor((s) => s.selectedFeature);
  const setActiveSketch = useEditor((s) => s.setActiveSketch);
  const selectFeature = useEditor((s) => s.selectFeature);
  const setView3d = useEditor((s) => s.setView3d);
  const updateSketchById = useEditor((s) => s.updateSketchById);
  const updateFeatureById = useEditor((s) => s.updateFeatureById);
  const deleteSketch = useEditor((s) => s.deleteSketch);
  const deleteFeature = useEditor((s) => s.deleteFeature);
  const booleanSubtract = useEditor((s) => s.booleanSubtract);
  const patternFeature = useEditor((s) => s.patternFeature);
  const pushLog = useEditor((s) => s.pushLog);

  const [editing, setEditing] = useState<Editing>(null);

  const nodes = treeNodes(doc);

  return (
    <div className="panel-body">
      <section className="panel-section">
        <h3>特征树</h3>
        <ul className="tree-list">
          {nodes.map((node) => (
            <TreeNodeRow
              key={node.kind === 'sketch' ? node.sketch.id : node.feature.id}
              node={node}
              activeSketch={doc.activeSketch}
              selectedFeature={selectedFeature}
              status={node.kind === 'feature' ? featureEval.items.find((i) => i.feature.id === node.feature.id)?.status : undefined}
              error={node.kind === 'feature' ? featureEval.items.find((i) => i.feature.id === node.feature.id)?.error : undefined}
              editing={editing}
              setEditing={setEditing}
              onActivateSketch={(id) => {
                setActiveSketch(id);
                // Back to the sketch's own view: the entity is only drawn in 2D,
                // and "I clicked a sketch" means "I want to draw on it".
                setView3d(false);
              }}
              onSelectFeature={(id) => {
                selectFeature(id);
                // The highlight only exists in 3D, so show the view where it can
                // be seen — the same "click means go look at it" rule as the
                // sketch row above.
                setView3d(true);
              }}
              onRenameSketch={(id, name) => updateSketchById(id, (s) => ({ ...s, name }), `重命名草图: ${name}`)}
              onRenameFeature={(id, name) => updateFeatureById(id, (f) => ({ ...f, name }), `重命名特征: ${name}`)}
              onHeight={(id, height) => updateFeatureById(id, (f) => (f.kind === 'extrude' ? { ...f, height } : f), `改拉伸高度: ${height}`)}
              onAngle={(id, angle) => updateFeatureById(id, (f) => (f.kind === 'revolve' ? { ...f, angle } : f), `改旋转角度: ${((angle * 180) / Math.PI).toFixed(2)}°`)}
              onSuppress={(id, on) => updateFeatureById(id, (f) => ({ ...f, suppressed: on }), on ? '抑制特征' : '取消抑制')}
              onOp={(id, op) => updateFeatureById(id, (f) => (f.kind === 'boolean' ? { ...f, op } : f), `布尔运算: ${BOOL_LABEL[op]}`)}
              onHole={(id, patch) =>
                updateFeatureById(
                  id,
                  (f) => (f.kind === 'hole' ? { ...f, ...patch } : f),
                  `改孔参数: ${Object.entries(patch)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(' ')}`,
                )
              }
              onPatternParam={(id, patch) =>
                updateFeatureById(
                  id,
                  (f) => (f.kind === 'pattern' ? { ...f, ...patch } : f),
                  `阵列: ${Object.entries(patch)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(' ')}`,
                )
              }
              onPattern={patternFeature}
              onSubtract={(bId) => {
                // The action lives on the row of the *cutter*; the base solid is
                // the row you selected first. Two clicks, no modal.
                if (!selectedFeature || selectedFeature === bId) {
                  pushLog('布尔差：先在树上点选「被减」的那个特征（A），再点另一行上的 ⊖。');
                  return;
                }
                booleanSubtract(selectedFeature, bId);
              }}
              onDeleteSketch={deleteSketch}
              onDeleteFeature={deleteFeature}
            />
          ))}
        </ul>
        <p className="panel-hint">
          顺序即求值顺序：草图在前，吃它的特征在后。点草图切过去编辑（回 2D），点特征在 3D 里高亮它。
          双击名字改名，双击数值（高度 / 角度）改参数。红点 = 该特征求值失败，悬停看原因。
          布尔：先点选「被减」的特征，再点另一行的 ⊖ 建一个差集；建好后行内的下拉可改成 并 / 交，
          算子会变灰（已消耗 —— 它们的面已经成为结果的一部分）。
          打孔：按 H（或点工具栏「⊚ 打孔」）后在 3D 视图里点一个实体的表面；这一行有四个数
          —— 孔径 / 深度（0 = 通孔）/ 沉孔直径 / 沉孔深度，都双击改（沉孔直径填 0 就是不沉孔）。
          阵列：点孔那一行的 ▦ —— 默认一排 3 个；把第二方向的**数量**改成 2 就是一片孔阵。
          实例是**算出来的**：改源孔的 ⌀ 或深度，整片孔一起变。
          放样：按 LOFT，点第一个截面 → 切到另一个基准面的草图 → 点第二个截面（两者必须在不同平面）。
        </p>
      </section>
    </div>
  );
}

interface RowProps {
  node: TreeNode;
  activeSketch: SketchId;
  selectedFeature: FeatureId | null;
  status: string | undefined;
  error: string | undefined;
  editing: Editing;
  setEditing: (e: Editing) => void;
  onActivateSketch: (id: SketchId) => void;
  onSelectFeature: (id: FeatureId) => void;
  onRenameSketch: (id: SketchId, name: string) => void;
  onRenameFeature: (id: FeatureId, name: string) => void;
  onHeight: (id: FeatureId, height: number) => void;
  onAngle: (id: FeatureId, angle: number) => void;
  onSuppress: (id: FeatureId, on: boolean) => void;
  /** Change a boolean's operation (差 / 并 / 交) in place. */
  onOp: (id: FeatureId, op: BooleanFeature['op']) => void;
  /** Change a hole's diameter, depth, and/or counterbore. */
  onHole: (
    id: FeatureId,
    patch: { diameter?: number; depth?: number; boreDiameter?: number; boreDepth?: number },
  ) => void;
  /** Change a pattern's instance counts and/or their spacings. */
  onPatternParam: (
    id: FeatureId,
    patch: { count?: number; spacing?: number; countV?: number; spacingV?: number },
  ) => void;
  /** Make a pattern whose source is this row's feature. */
  onPattern: (sourceId: FeatureId) => void;
  /** Boolean difference: the row's feature is the cutter, the selected one is the base. */
  onSubtract: (bId: FeatureId) => void;
  onDeleteSketch: (id: SketchId) => void;
  onDeleteFeature: (id: FeatureId) => void;
}

/** One row. Split out so the sketch and feature branches stay readable. */
function TreeNodeRow(props: RowProps): React.ReactElement {
  const { node, editing, setEditing } = props;
  if (node.kind === 'sketch') {
    const sketch = node.sketch;
    const renaming = editing?.id === sketch.id && editing.field === 'name';
    return (
      <li className={`tree-row ${sketch.id === props.activeSketch ? 'active' : ''}`}>
        <span className="tree-icon" title="草图">▱</span>
        {renaming ? (
          <TextInput
            value={sketch.name}
            param="sketch.name"
            autoFocus
            onCommit={(v) => {
              setEditing(null);
              // An empty name would render a nameless row — keep the old one
              // instead of inventing a label the user did not type.
              const name = v.trim();
              if (name !== '' && name !== sketch.name) props.onRenameSketch(sketch.id, name);
            }}
          />
        ) : (
          <span
            className="tree-name"
            title="点击切到这张草图；双击改名"
            onClick={() => props.onActivateSketch(sketch.id)}
            onDoubleClick={() => setEditing({ id: sketch.id, field: 'name' })}
          >
            {sketch.name}
          </span>
        )}
        <span className="tree-meta">{sketch.entities.length} 图元</span>
        <button
          className="tree-act"
          title="重命名"
          onClick={() => setEditing({ id: sketch.id, field: 'name' })}
        >
          ✎
        </button>
        <button className="tree-act danger" title="删除草图" onClick={() => props.onDeleteSketch(sketch.id)}>
          ×
        </button>
      </li>
    );
  }

  const feature = node.feature;
  const renaming = editing?.id === feature.id && editing.field === 'name';
  const bad = props.status === 'error';
  const off = feature.suppressed === true;
  // A consumed operand is *not drawn* any more — its surfaces are part of the
  // boolean's result. Same dimming as a suppressed feature, different tag: one
  // the user asked for, the other the tree did.
  //
  // The numbers that *define* this feature, per kind — the one thing the tree
  // edits in place. Which fields those are belongs with the kind, not with the
  // row.
  const params: ParamSpec[] = [];
  if (feature.kind === 'extrude') {
    params.push({
      slot: 'param',
      value: feature.height,
      key: 'feature.height',
      unit: ' mm',
      label: '拉伸高度',
      set: (v) => props.onHeight(feature.id, v),
    });
  } else if (feature.kind === 'revolve') {
    params.push({
      slot: 'param',
      // Degrees on screen, radians in the document — the unit the user reads
      // off a protractor versus the one the kernel sweeps.
      value: (feature.angle * 180) / Math.PI,
      key: 'feature.angle',
      unit: '°',
      label: '旋转角度',
      set: (v) => props.onAngle(feature.id, (v * Math.PI) / 180),
    });
  } else if (feature.kind === 'hole') {
    params.push({
      slot: 'param',
      value: feature.diameter,
      key: 'feature.diameter',
      unit: ' ⌀',
      label: '孔径',
      set: (v) => props.onHole(feature.id, { diameter: v }),
    });
    params.push({
      slot: 'param2',
      value: feature.depth,
      key: 'feature.depth',
      unit: ' mm',
      label: '深度（0 = 通孔）',
      set: (v) => props.onHole(feature.id, { depth: Math.max(0, v) }),
    });
    params.push({
      slot: 'param3',
      value: feature.boreDiameter,
      key: 'feature.boreDiameter',
      unit: ' ⌀',
      label: '沉孔直径（0 = 不沉孔）',
      set: (v) => props.onHole(feature.id, { boreDiameter: v }),
    });
    params.push({
      slot: 'param4',
      value: feature.boreDepth,
      key: 'feature.boreDepth',
      unit: ' mm',
      label: '沉孔深度',
      set: (v) => props.onHole(feature.id, { boreDepth: Math.max(0, v) }),
    });
  } else if (feature.kind === 'pattern') {
    params.push({
      slot: 'param',
      value: feature.count,
      key: 'feature.count',
      unit: ' 个',
      label: '第一方向数量（含源孔）',
      set: (v) => props.onPatternParam(feature.id, { count: Math.max(1, Math.round(v)) }),
    });
    params.push({
      slot: 'param2',
      value: feature.spacing,
      key: 'feature.spacing',
      unit: ' mm',
      label: '第一方向间距',
      set: (v) => props.onPatternParam(feature.id, { spacing: v }),
    });
    params.push({
      slot: 'param3',
      value: feature.countV,
      key: 'feature.countV',
      unit: ' 个',
      label: '第二方向数量（1 = 只是一排）',
      set: (v) => props.onPatternParam(feature.id, { countV: Math.max(1, Math.round(v)) }),
    });
    params.push({
      slot: 'param4',
      value: feature.spacingV,
      key: 'feature.spacingV',
      unit: ' mm',
      label: '第二方向间距',
      set: (v) => props.onPatternParam(feature.id, { spacingV: v }),
    });
  }
  return (
    <li
      className={`tree-row ${bad ? 'bad' : ''} ${off || props.status === 'consumed' ? 'off' : ''} ${
        feature.id === props.selectedFeature ? 'selected' : ''
      }`}
    >
      <span className="tree-icon" title={FEATURE_TITLE[feature.kind]}>
        {/* The same glyphs the ribbon uses, so a row and its tool read as one thing. */}
        {feature.kind === 'boolean' ? BOOL_GLYPH[feature.op] : FEATURE_GLYPH[feature.kind]}
      </span>
      {renaming ? (
        <TextInput
          value={feature.name}
          param="feature.name"
          autoFocus
          onCommit={(v) => {
            setEditing(null);
            const name = v.trim();
            if (name !== '' && name !== feature.name) props.onRenameFeature(feature.id, name);
          }}
        />
      ) : (
        <span
          className="tree-name"
          title="点击在 3D 里高亮；双击改名"
          onClick={() => props.onSelectFeature(feature.id)}
          onDoubleClick={() => setEditing({ id: feature.id, field: 'name' })}
        >
          {feature.name}
        </span>
      )}
      {feature.kind === 'boolean' && (
        // The operation *is* this feature's parameter, so it is edited in place
        // like a height or an angle — one change, one undo step.
        <select
          className="tree-select"
          value={feature.op}
          title="布尔运算：差 = 从 A 挖掉 B；并 = 合并成一个；交 = 只留重叠部分"
          onClick={(ev) => ev.stopPropagation()}
          onChange={(ev) => props.onOp(feature.id, ev.target.value as BooleanFeature['op'])}
        >
          {(['subtract', 'union', 'intersect'] as const).map((op) => (
            <option key={op} value={op}>
              {BOOL_LABEL[op]}
            </option>
          ))}
        </select>
      )}
      {params.map((p) =>
        editing?.id === feature.id && editing.field === p.slot ? (
          <NumberInput
            key={p.slot}
            value={p.value}
            param={p.key}
            autoFocus
            onCommit={(v) => {
              setEditing(null);
              p.set(v);
            }}
          />
        ) : (
          <span
            key={p.slot}
            className="tree-meta mono"
            title={`${p.label}，双击修改`}
            onDoubleClick={() => setEditing({ id: feature.id, field: p.slot })}
          >
            {Number(p.value.toFixed(2))}
            {p.unit}
          </span>
        ),
      )}
      {feature.kind === 'loft' && (
        // A loft's parameters are *references* to sections, not numbers, so the
        // row says how many rather than offering an input for each.
        <span className="tree-meta" title="截面（按顺序蒙皮）">
          {feature.sections.length} 个截面
        </span>
      )}
      {bad && <span className="tree-dot" title={props.error ?? '求值失败'} />}
      {off && <span className="tree-tag">已抑制</span>}
      {props.status === 'consumed' && <span className="tree-tag">已消耗</span>}
      {feature.kind === 'hole' && (
        // Patterning is offered on the row it can act on, rather than as another
        // ribbon button that has to explain why it is disabled.
        <button
          className="tree-act"
          title="以这个孔为源做阵列（默认 3 个 · 间距 10，参数建好后在这一行改）"
          onClick={() => props.onPattern(feature.id)}
        >
          ▦
        </button>
      )}
      <button
        className="tree-act"
        title="布尔差：从已选特征（A）里减去这一项"
        onClick={() => props.onSubtract(feature.id)}
      >
        ⊖
      </button>
      <button
        className="tree-act"
        title={off ? '取消抑制（恢复求值）' : '抑制（跳过求值，网格消失）'}
        onClick={() => props.onSuppress(feature.id, !off)}
      >
        {off ? '◉' : '⊘'}
      </button>
      <button className="tree-act danger" title="删除特征" onClick={() => props.onDeleteFeature(feature.id)}>
        ×
      </button>
    </li>
  );
}
