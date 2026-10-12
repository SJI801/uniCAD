/**
 * Left-hand panel: layer table + object properties.
 *
 * The properties side is *generated* from `core/props.ts` rather than written
 * out per entity type. See that file for why — the short version is that the
 * read-only geometry block was not a decision, it was an omission, and a table
 * of descriptors with an `applyTo` on every row is what makes that omission
 * impossible to repeat.
 */

import { Fragment, useMemo, useState } from 'react';
import { useEditor, selectedEntities } from '../state/editorStore';
import DatumPanel from './DatumPanel';
import type { CadDocument, Entity, Layer, LineStyle, Vec2 } from '../core/types';
import { describeEntity } from '../core/entities';
import {
  describeCommonProps,
  describeEntityProps,
  formatValue,
  type PropField,
} from '../core/props';

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
  const transformSelection = useEditor((s) => s.transformSelection);
  const select = useEditor((s) => s.select);

  const [tab, setTab] = useState<'layers' | 'properties' | 'datum'>('layers');

  const selectionList = useMemo(() => selectedEntities(useEditor.getState()), [selection, doc]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of doc.entities) m.set(e.layer, (m.get(e.layer) ?? 0) + 1);
    return m;
  }, [doc.entities]);

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
            const ids = doc.entities.filter((e) => e.layer === id).map((e) => e.id);
            select(ids);
          }}
        />
      ) : tab === 'properties' ? (
        <PropertyTable
          entities={selectionList}
          doc={doc}
          onApply={(id, fn, label) => updateEntityById(id, fn, label)}
          onApplyAll={(fn, label) => transformSelection(fn, label)}
          onFocus={(id) => select([id])}
        />
      ) : (
        <DatumPanel />
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
              />
            ))}
          </div>
        </Fragment>
      ))}

      <p className="panel-hint">
        带 · 的参数是派生量（由其它参数算出），改它等于反向解出真正的那一项；
        悬停可看到具体规则。所有修改都进撤销栈。
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
}

function PropRow({ field, onApply }: PropRowProps): React.ReactElement {
  const title = field.hint;
  const wrap = (fn: (base: Entity) => Entity): void => onApply(fn, `修改${field.label}`);

  return (
    <>
      <label className={`prop-label ${field.derived ? 'derived' : ''}`} title={title}>
        {field.label}
        {field.derived && <span className="derived-mark">·</span>}
      </label>
      {renderControl(field, title, wrap)}
    </>
  );
}

function renderControl(
  field: PropField,
  title: string | undefined,
  wrap: (fn: (base: Entity) => Entity) => void,
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
            onCommit={(n) => wrap((base) => field.applyTo!(base, n))}
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

/**
 * A number input that commits on blur or Enter and reverts on Escape.
 *
 * Two deliberate choices:
 *
 *   - **`type="text"`, not `type="number"`.** With a number input the browser
 *     reports `''` for a value it considers invalid (a lone `-`, or `1e`), so a
 *     controlled component cannot tell "the user is halfway through typing a
 *     negative number" from "the user cleared the field" — and the parsed value
 *     silently becomes NaN. It also turns the scroll wheel into a value
 *     changer, which in a scrolling panel is a trap.
 *   - **A local draft.** Committing on every keystroke would push one undo step
 *     per character *and* make the field fight the geometry: typing `100` into
 *     a radius would briefly set 1, then 10. The draft also means the displayed
 *     text is exactly what the user typed until they leave the field, so no
 *     reformatting happens mid-edit.
 */
function NumberInput({
  value,
  param,
  title,
  step,
  min,
  max,
  unit,
  placeholder,
  onCommit,
}: {
  value: number;
  param: string;
  title?: string;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  placeholder?: string;
  onCommit: (n: number) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState<string | null>(null);

  const clamp = (n: number): number => {
    let v = n;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    return v;
  };

  const finite = Number.isFinite(value);
  const shown = draft ?? (finite ? String(value) : '');

  const commit = (): void => {
    if (draft === null) return;
    setDraft(null);
    const raw = draft.trim();
    // An empty or unparseable field is a reversal, not a write: leaving the
    // value alone is the only answer that does not invent a number.
    if (raw === '') return;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    const next = clamp(round6(parsed));
    if (finite && next === round6(value)) return;
    onCommit(next);
  };

  return (
    <span className="num-wrap">
      <input
        type="text"
        inputMode="decimal"
        className="cell-input mono num-input"
        data-param={param}
        title={title}
        value={shown}
        placeholder={placeholder}
        onChange={(ev) => setDraft(ev.target.value)}
        onBlur={commit}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            commit();
          } else if (ev.key === 'Escape') {
            // Swallow it: the global shortcut layer reads Escape as "cancel the
            // active tool", and cancelling the field is the narrower intent.
            ev.stopPropagation();
            setDraft(null);
          } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
            ev.preventDefault();
            const cur = Number(shown);
            if (!Number.isFinite(cur)) return;
            const delta = (step ?? 1) * (ev.key === 'ArrowUp' ? 1 : -1);
            setDraft(null);
            onCommit(clamp(round6(cur + delta)));
          }
        }}
      />
      {unit && <span className="num-unit">{unit}</span>}
    </span>
  );
}

/** Keep step arithmetic from producing 0.30000000000000004. */
function round6(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 1e6) / 1e6;
}

/**
 * A text field with the same draft/commit contract as `NumberInput`.
 *
 * Committing per keystroke would push one undo step per character and clone the
 * whole document each time — so typing a ten-character name would take ten
 * undos to take back. Blur/Enter keeps one edit equal to one undo, which is the
 * only grouping the user can predict.
 */
function TextInput({
  value,
  param,
  title,
  placeholder,
  onCommit,
}: {
  value: string;
  param: string;
  title?: string;
  placeholder?: string;
  onCommit: (v: string) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;

  const commit = (): void => {
    if (draft === null) return;
    setDraft(null);
    if (draft === value) return;
    onCommit(draft);
  };

  return (
    <input
      type="text"
      className="cell-input"
      data-param={param}
      title={title}
      value={shown}
      placeholder={placeholder}
      onChange={(ev) => setDraft(ev.target.value)}
      onBlur={commit}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          commit();
        } else if (ev.key === 'Escape') {
          ev.stopPropagation();
          setDraft(null);
        }
      }}
    />
  );
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 10)}…` : id;
}
