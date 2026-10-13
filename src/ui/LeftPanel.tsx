/**
 * Left-hand panel: layer table + object properties.
 *
 * The properties side is *generated* from `core/props.ts` rather than written
 * out per entity type. See that file for why — the short version is that the
 * read-only geometry block was not a decision, it was an omission, and a table
 * of descriptors with an `applyTo` on every row is what makes that omission
 * impossible to repeat.
 */

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useEditor, selectedEntities } from '../state/editorStore';
import DatumPanel from './DatumPanel';
import type { CadDocument, Entity, Layer, LineStyle, Vec2 } from '../core/types';
import { describeEntity } from '../core/entities';
import { CONSTRAINT_GLYPH } from '../core/constraints';
import { allEntities } from '../core/doc';
import {
  describeCommonProps,
  describeEntityProps,
  formatValue,
  type PropField,
} from '../core/props';
// The draft/commit field pair lives in `fields.tsx`: the feature tree needs the
// same contract, and two copies of "one edit = one undo" would drift.
import { NumberInput, TextInput } from './fields';
import FeatureTree from './FeatureTree';

const LINESTYLE_LABEL: Record<LineStyle, string> = {
  continuous: '实线',
  dashed: '虚线',
  dotted: '点线',
  dashdot: '点划线',
  center: '中心线',
  hidden: '隐藏线',
};

/** Sentinel option value for "the selected objects disagree". */
const MIXED = '\u0000mixed';

export default function LeftPanel(): React.ReactElement {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const setCurrentLayerAction = useEditor((s) => s.setCurrentLayerAction);
  const updateLayerAction = useEditor((s) => s.updateLayerAction);
  const removeLayerAction = useEditor((s) => s.removeLayerAction);
  const addLayerAction = useEditor((s) => s.addLayerAction);
  const updateEntityById = useEditor((s) => s.updateEntityById);
  const setDimensionAction = useEditor((s) => s.setDimensionAction);
  const transformSelection = useEditor((s) => s.transformSelection);
  const select = useEditor((s) => s.select);

  const [tab, setTab] = useState<'layers' | 'properties' | 'datum' | 'tree'>('layers');

  // 饼菜单的「属性」扇区（以及将来任何命令）能把这一页掀开：走既有的 unicad:* 事件
  // 通道，免得把「当前标签页」这种局部 UI 状态提升进 store。
  useEffect(() => {
    const onPanel = (e: Event): void => {
      const want = (e as CustomEvent<string>).detail;
      if (want === 'properties' || want === 'layers' || want === 'datum' || want === 'tree') {
        setTab(want);
      }
    };
    window.addEventListener('unicad:panel', onPanel);
    return () => window.removeEventListener('unicad:panel', onPanel);
  }, []);

  const selectionList = useMemo(() => selectedEntities(useEditor.getState()), [selection, doc]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    // Every entity in the document, not just the active sketch: a layer's
    // usage count is a document-level fact, and a layer still holding
    // entities on another plane must not look deletable.
    for (const e of allEntities(doc)) m.set(e.layer, (m.get(e.layer) ?? 0) + 1);
    return m;
    // Keyed on `doc` — a fresh object on every store write. The old flat-list
    // key never fired after an edit (the patch layer mutates the arrays in
    // place), so layer counts silently went stale; this is the same fix as
    // the Ribbon's selection memo.
  }, [doc]);

  return (
    <aside className="side-panel left">
      <div className="panel-tabs">
        <button
          className={`panel-tab ${tab === 'layers' ? 'active' : ''}`}
          onClick={() => setTab('layers')}
        >
          图层
        </button>
        <button
          className={`panel-tab ${tab === 'properties' ? 'active' : ''}`}
          onClick={() => setTab('properties')}
        >
          属性{selection.size > 0 ? ` (${selection.size})` : ''}
        </button>
        <button
          className={`panel-tab ${tab === 'datum' ? 'active' : ''}`}
          onClick={() => setTab('datum')}
          title="基准面与参考坐标系"
        >
          基准
        </button>
        <button
          className={`panel-tab ${tab === 'tree' ? 'active' : ''}`}
          onClick={() => setTab('tree')}
          title="特征树：草图与其上的特征，点草图切过去编辑"
        >
          特征
        </button>
      </div>

      {tab === 'layers' ? (
        <LayerTable
          layers={doc.layers}
          currentLayer={doc.currentLayer}
          counts={counts}
          onActivate={setCurrentLayerAction}
          onUpdate={updateLayerAction}
          onRemove={removeLayerAction}
          onAdd={() => addLayerAction()}
          onSelectLayerEntities={(id) => {
            // "Select everything on this layer" is a document-level action —
            // an entity on another plane is still on the layer, and the
            // selection set is ids, so this stays cross-sketch.
            const ids = allEntities(doc).filter((e) => e.layer === id).map((e) => e.id);
            select(ids);
          }}
        />
      ) : tab === 'properties' ? (
        <PropertyTable
          entities={selectionList}
          doc={doc}
          onApply={(id, fn, label) => updateEntityById(id, fn, label)}
          onDimension={(id, field, raw) => {
            const dim = field.dimension!;
            // 显示值 → 约束目标值（周长/面积/弧长反解成半径），几何用那一行
            // 自己的 applyTo 落，两者分开传是刻意的：一个进约束，一个进几何。
            setDimensionAction(
              id,
              dim.kind,
              dim.toValue(raw),
              (e) => field.applyTo!(e, raw),
              `改尺寸: ${field.label} = ${raw}`,
            );
          }}
          onApplyAll={(fn, label) => transformSelection(fn, label)}
          onFocus={(id) => select([id])}
        />
      ) : tab === 'datum' ? (
        <DatumPanel />
      ) : (
        <FeatureTree />
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

interface LayerTableProps {
  layers: Layer[];
  currentLayer: string;
  counts: Map<string, number>;
  onActivate: (id: string) => void;
  onUpdate: (id: string, patch: Partial<Layer>) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
  onSelectLayerEntities: (id: string) => void;
}

function LayerTable(props: LayerTableProps): React.ReactElement {
  return (
    <div className="panel-body">
      <div className="layer-header">
        <button className="mini-btn" onClick={props.onAdd} title="新建图层">
          + 新建图层
        </button>
      </div>

      <table className="layer-table">
        <thead>
          <tr>
            <th title="当前图层">当前</th>
            <th className="w-toggle" title="可见">显</th>
            <th className="w-toggle" title="锁定">锁</th>
            <th>名称</th>
            <th className="w-color" title="颜色">颜色</th>
            <th className="w-num" title="对象数">数量</th>
            <th className="w-line">线型</th>
            <th className="w-del" />
          </tr>
        </thead>
        <tbody>
          {props.layers.map((l) => {
            const isCurrent = l.id === props.currentLayer;
            return (
              <tr
                key={l.id}
                className={isCurrent ? 'current' : ''}
                onDoubleClick={() => props.onActivate(l.id)}
              >
                <td className="center">
                  <button
                    className={`dot-btn ${isCurrent ? 'on' : ''}`}
                    onClick={() => props.onActivate(l.id)}
                    title={isCurrent ? '当前图层' : '设为当前图层'}
                  />
                </td>
                <td className="center">
                  <input
                    type="checkbox"
                    checked={l.visible}
                    onChange={(e) => props.onUpdate(l.id, { visible: e.target.checked })}
                    title="显示/隐藏"
                  />
                </td>
                <td className="center">
                  <input
                    type="checkbox"
                    checked={l.locked}
                    onChange={(e) => props.onUpdate(l.id, { locked: e.target.checked })}
                    title="锁定/解锁"
                  />
                </td>
                <td>
                  <input
                    className="cell-input"
                    value={l.name}
                    onChange={(e) => props.onUpdate(l.id, { name: e.target.value })}
                    onDoubleClick={(e) => e.stopPropagation()}
                  />
                </td>
                <td className="center">
                  <input
                    type="color"
                    className="color-input"
                    value={l.color}
                    onChange={(e) => props.onUpdate(l.id, { color: e.target.value })}
                    title="图层颜色"
                  />
                </td>
                <td className="center">
                  <button
                    className="count-btn"
                    onClick={() => props.onSelectLayerEntities(l.id)}
                    title="选中该图层全部对象"
                  >
                    {props.counts.get(l.id) ?? 0}
                  </button>
                </td>
                <td>
                  <select
                    className="cell-select"
                    value={l.lineStyle}
                    onChange={(e) => props.onUpdate(l.id, { lineStyle: e.target.value as LineStyle })}
                  >
                    {Object.entries(LINESTYLE_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="center">
                  <button
                    className="icon-btn danger"
                    onClick={() => props.onRemove(l.id)}
                    title="删除图层（需为空）"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="panel-hint">
        双击图层名可设为当前图层；锁定图层上的对象不会被选中，但仍会显示。
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

interface PropertyTableProps {
  entities: Entity[];
  doc: CadDocument;
  onApply: (id: string, fn: (e: Entity) => Entity, label: string) => void;
  /**
   * 尺寸行（`field.dimension` 有值）的提交口：走约束，不走普通几何编辑。
   * `raw` 是输入框里的数（显示单位）。
   */
  onDimension?: (id: string, field: PropField, raw: number) => void;
  onApplyAll: (fn: (e: Entity) => Entity, label: string) => void;
  onFocus: (id: string) => void;
}

function PropertyTable(props: PropertyTableProps): React.ReactElement {
  if (props.entities.length === 0) {
    return (
      <div className="panel-body">
        <p className="panel-hint">未选中任何对象。</p>
        <p className="panel-hint">
          使用左侧“选择”工具，或直接框选/单击图元。按住 Shift 可多选。
        </p>
        <p className="panel-hint">
          选中后这里会列出该对象的**全部**参数，每一项都可以直接修改：改完按 Enter 或
          点开别处即生效，Esc 撤销这次输入。
        </p>
      </div>
    );
  }

  if (props.entities.length > 1) return <MultiProps {...props} />;
  return <SingleProps {...props} entity={props.entities[0]!} />;
}

function SingleProps({
  entity,
  doc,
  onApply,
  onDimension,
}: PropertyTableProps & { entity: Entity }): React.ReactElement {
  const sections = describeEntityProps(entity, doc);
  return (
    <div className="panel-body">
      <div className="prop-title">
        <span className="badge">{describeEntity(entity)}</span>
        <span className="mono dim">{shortId(entity.id)}</span>
      </div>

      {sections.map((section) => (
        <Fragment key={section.title}>
          <h4 className="prop-section">{section.title}</h4>
          <div className="prop-grid">
            {section.fields.map((f) => (
              // Keying on the entity id as well as the field means a change of
              // selection remounts the rows, so a half-typed draft from the
              // previous entity cannot land in the new one.
              <PropRow
                key={`${entity.id}:${f.key}`}
                field={f}
                onApply={(fn, label) => onApply(entity.id, fn, label)}
                onDimension={
                  onDimension ? (field, raw) => onDimension(entity.id, field, raw) : undefined
                }
              />
            ))}
          </div>
        </Fragment>
      ))}

      <p className="panel-hint">
        带 · 的参数是派生量（由其它参数算出），改它等于反向解出真正的那一项；
        悬停可看到具体规则。带 <span className="constraint-glyph">↔</span>
        <span className="constraint-glyph">R</span> 这类记号的参数是<b>尺寸</b>：
        改它会写成一条持久约束（右下「几何约束」列表里可见、可删），
        之后它会一直守住这个值，与它相关的图元跟着动。
        <b>画布上那条尺寸标注也能双击就地改值</b>（直线长度 / 圆与弧的半径）。
        所有修改都进撤销栈。
      </p>
    </div>
  );
}

function MultiProps({
  entities,
  doc,
  onApplyAll,
  onFocus,
}: PropertyTableProps): React.ReactElement {
  const perEntity = entities.map((e) => describeCommonProps(e, doc));
  const base = perEntity[0]!;

  // Fields are compared on their *effective* value, so two objects that inherit
  // the same colour from different layers read as equal — which is right, since
  // leaving them alone preserves both.
  const rows = base.map((f, i) => {
    // A name is per-object by definition; offering a batch rename would be a lie.
    if (f.key === 'name') return null;
    const mixed = perEntity.some((fs) => fs[i]!.value !== f.value);
    if (!mixed) return f;
    if (f.kind === 'enum') {
      return {
        ...f,
        value: MIXED,
        mixed: true,
        options: [{ value: MIXED, label: '（多个值）' }, ...(f.options ?? [])],
      };
    }
    if (f.kind === 'number') return { ...f, value: Number.NaN, mixed: true };
    return { ...f, mixed: true };
  }).filter((f): f is PropField => f !== null);

  return (
    <div className="panel-body">
      <p className="panel-hint">
        已选中 <b>{entities.length}</b> 个对象 —— 下面的修改会<b>同时应用</b>到全部所选。
      </p>

      <h4 className="prop-section">通用</h4>
      <div className="prop-grid">
        {rows.map((f) => (
          <PropRow
            key={`multi:${f.key}`}
            field={f}
            onApply={(fn, label) => onApplyAll(fn, label)}
          />
        ))}
      </div>

      <h4 className="prop-section">对象</h4>
      <ul className="multi-list">
        {entities.slice(0, 60).map((e) => (
          <li key={e.id} onClick={() => onFocus(e.id)} title="单击后只看这一个对象">
            <span className="mono">{shortId(e.id)}</span>
            <span>{describeEntity(e)}</span>
          </li>
        ))}
      </ul>
      {entities.length > 60 && <p className="panel-hint">… 其余 {entities.length - 60} 个已省略</p>}
      <p className="panel-hint">
        单击列表中的一项可切到单个对象的完整参数（含几何尺寸）。
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------

interface PropRowProps {
  field: PropField;
  onApply: (fn: (e: Entity) => Entity, label: string) => void;
  /** 尺寸行的提交口；缺省时尺寸行也退回普通几何编辑（多选视图即如此）。 */
  onDimension?: (field: PropField, raw: number) => void;
}

function PropRow({ field, onApply, onDimension }: PropRowProps): React.ReactElement {
  // 尺寸行的 tooltip 要说清「这条值会留下一条约束」，否则用户改完半径发现
  // 右栏凭空多了一条约束会以为是 bug。
  const title = field.dimension
    ? `${field.hint ?? ''}\n\n尺寸：改这一项会写入「${
        field.dimension.kind === 'radius'
          ? '半径'
          : field.dimension.kind === 'diameter'
            ? '直径'
            : '距离'
      }」约束，可在右下「几何约束」里删除。`.trim()
    : field.hint;
  const wrap = (fn: (base: Entity) => Entity): void => onApply(fn, `修改${field.label}`);

  return (
    <>
      <label className={`prop-label ${field.derived ? 'derived' : ''}`} title={title}>
        {field.label}
        {field.derived && <span className="derived-mark">·</span>}
        {field.dimension && (
          <span className="constraint-glyph" aria-hidden>
            {CONSTRAINT_GLYPH[field.dimension.kind]}
          </span>
        )}
      </label>
      {renderControl(field, title, wrap, onDimension)}
    </>
  );
}

function renderControl(
  field: PropField,
  title: string | undefined,
  wrap: (fn: (base: Entity) => Entity) => void,
  onDimension?: (field: PropField, raw: number) => void,
): React.ReactElement {
  switch (field.kind) {
    case 'info':
      return (
        <span className="readonly mono" title={title} data-param={field.key} data-readonly="1">
          {formatValue(field)}
        </span>
      );

    case 'vec2': {
      const v = field.value as Vec2;
      return (
        <span className="vec2-row">
          <NumberInput
            param={`${field.key}.x`}
            title={title}
            unit={field.unit}
            value={v.x}
            step={field.step}
            min={field.min}
            max={field.max}
            onCommit={(n) => wrap((base) => field.applyTo!(base, n, 0))}
          />
          <NumberInput
            param={`${field.key}.y`}
            title={title}
            unit={field.unit}
            value={v.y}
            step={field.step}
            min={field.min}
            max={field.max}
            onCommit={(n) => wrap((base) => field.applyTo!(base, n, 1))}
          />
        </span>
      );
    }

    case 'number':
      return (
        <span className="num-row">
          <NumberInput
            param={field.key}
            title={title}
            value={field.value as number}
            step={field.step}
            min={field.min}
            max={field.max}
            unit={field.unit}
            placeholder={field.mixed ? '多值' : undefined}
            onCommit={(n) => {
              // 尺寸 → 写成约束（改值即驱动）；其余照旧直接改几何。
              if (field.dimension && onDimension) {
                onDimension(field, n);
                return;
              }
              wrap((base) => field.applyTo!(base, n));
            }}
          />
          {field.inheritFrom && <InheritButton field={field} wrap={wrap} />}
        </span>
      );

    case 'bool':
      return (
        <span className="bool-row">
          <input
            type="checkbox"
            data-param={field.key}
            title={title}
            checked={Boolean(field.value)}
            onChange={(ev) => wrap((base) => field.applyValueTo!(base, ev.target.checked))}
          />
        </span>
      );

    case 'text':
      return (
        <TextInput
          param={field.key}
          title={title}
          value={String(field.value ?? '')}
          placeholder={field.mixed ? '多值' : '（无）'}
          onCommit={(v) => wrap((base) => field.applyValueTo!(base, v))}
        />
      );

    case 'color':
      return (
        <span className="num-row">
          <input
            type="color"
            className={`color-input ${field.mixed ? 'mixed' : ''}`}
            data-param={field.key}
            title={
              field.mixed
                ? '所选对象颜色不一致 —— 选一个颜色会统一应用到全部'
                : title
            }
            value={typeof field.value === 'string' ? field.value : '#808080'}
            onChange={(ev) => wrap((base) => field.applyValueTo!(base, ev.target.value))}
          />
          {field.inheritFrom && <InheritButton field={field} wrap={wrap} />}
        </span>
      );

    case 'enum':
      return (
        <span className="num-row">
          <select
            className="cell-select"
            data-param={field.key}
            title={title}
            value={String(field.value ?? '')}
            onChange={(ev) => {
              const v = ev.target.value;
              if (v === MIXED) return;
              wrap((base) => field.applyValueTo!(base, v));
            }}
          >
            {(field.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {field.inheritFrom && <InheritButton field={field} wrap={wrap} />}
        </span>
      );
  }
}

/** 「随层」 — clear an override so the layer's value applies again. */
function InheritButton({
  field,
  wrap,
}: {
  field: PropField;
  wrap: (fn: (base: Entity) => Entity) => void;
}): React.ReactElement | null {
  if (field.inherited) return <span className="inherit-on">随层</span>;
  return (
    <button
      className="inherit-btn"
      data-param={`${field.key}.inherit`}
      title="清除对象自身的设置，改回跟随图层"
      onClick={() => wrap((base) => field.inheritFrom!(base))}
    >
      随层
    </button>
  );
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 10)}…` : id;
}
