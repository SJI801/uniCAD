/**
 * Right-hand panel: measurement readout, selection statistics, and the
 * shortcut cheatsheet.
 */

import { useMemo, useState } from 'react';
import { useEditor, selectedEntities } from '../state/editorStore';
import { fmt, fmtAngle, type Constraint } from '../core/types';
import { measureEntity, isKernelReady } from '../core/kernel';
import { describeEntity } from '../core/entities';
import {
  CONSTRAINT_GLYPH,
  describeConstraint,
  DIMENSIONAL_CONSTRAINTS,
  ZERO_VALUE_DIMENSIONS,
} from '../core/constraints';

export default function RightPanel(): React.ReactElement {
  const selection = useEditor((s) => s.selection);
  const doc = useEditor((s) => s.doc);
  const cursor = useEditor((s) => s.cursor);
  const gridVisible = useEditor((s) => s.gridVisible);
  // Reactive mirror of the kernel load state — `isKernelReady()` alone would
  // never re-render this panel once the WASM module finishes loading.
  const kernelReady = useEditor((s) => s.kernelReady);
  const removeConstraintAction = useEditor((s) => s.removeConstraintAction);
  const setConstraintValueAction = useEditor((s) => s.setConstraintValueAction);
  const removeConstraintsForSelection = useEditor((s) => s.removeConstraintsForSelection);

  const list = useMemo(() => selectedEntities(useEditor.getState()), [selection, doc]);

  const stats = useMemo(() => {
    let totalLength = 0;
    let totalArea = 0;
    let closedCount = 0;
    for (const e of list) {
      if (kernelReady) {
        const m = measureEntity(e);
        totalLength += m.perimeter;
        totalArea += m.area;
      }
      if (e.type === 'circle' || e.type === 'ellipse' || (e.type === 'polyline' && e.closed)) {
        closedCount += 1;
      }
    }
    return { totalLength, totalArea, closedCount };
  }, [list, kernelReady]);

  // Constraints touching the selection, in document order. Filtered by hand
  // rather than via `constraintsForEntity` per entity: that helper is per-id, and
  // looping it would report a two-sided constraint twice.
  const selectedConstraints = useMemo(
    () =>
      doc.constraints.filter(
        (c) => selection.has(c.a.entity) || (c.b !== undefined && selection.has(c.b.entity)),
      ),
    [doc.constraints, selection],
  );

  return (
    <aside className="side-panel right">
      <section className="panel-section">
        <h3>状态</h3>
        <div className="kv-grid">
          <span>光标 (捕捉后)</span>
          <span className="mono">
            {fmt(cursor.effective.x, 3)}, {fmt(cursor.effective.y, 3)}
          </span>
          <span>光标 (原始)</span>
          <span className="mono dim">
            {fmt(cursor.world.x, 3)}, {fmt(cursor.world.y, 3)}
          </span>
          <span>捕捉状态</span>
          <span>{cursor.snap ? `✓ ${cursor.snap.kind}` : '—'}</span>
          <span>约束</span>
          <span>{cursor.locked ? '已锁定' : '自由'}</span>
          <span>栅格</span>
          <span>{gridVisible ? '显示' : '隐藏'}</span>
          <span>内核</span>
          <span>{kernelReady ? 'Rust/WASM 已启用' : 'TS 降级'}</span>
        </div>
      </section>

      <section className="panel-section">
        <h3>选择统计</h3>
        {list.length === 0 ? (
          <p className="panel-hint">未选中对象。</p>
        ) : (
          <>
            <div className="kv-grid">
              <span>对象数</span>
              <span className="mono">{list.length}</span>
              <span>闭合图元</span>
              <span className="mono">{stats.closedCount}</span>
              <span>总周长 / 长度</span>
              <span className="mono">{fmt(stats.totalLength)}</span>
              <span>总面积</span>
              <span className="mono">{fmt(stats.totalArea)}</span>
            </div>

            <div className="type-breakdown">
              {summarise(list).map(([label, n]) => (
                <span key={label} className="type-chip">
                  {label} <b>{n}</b>
                </span>
              ))}
            </div>

            <h4 className="prop-section">逐个对象</h4>
            <ul className="entity-list">
              {list.slice(0, 40).map((e) => {
                const m = isKernelReady() ? measureEntity(e) : null;
                return (
                  <li key={e.id}>
                    <span className="entity-kind">{describeEntity(e)}</span>
                    <span className="mono dim">
                      {m ? `L ${fmt(m.perimeter)}${m.area > 1e-9 ? ` · A ${fmt(m.area)}` : ''}` : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
            {list.length > 40 && <p className="panel-hint">… 其余 {list.length - 40} 个已省略</p>}
          </>
        )}
      </section>

      <section className="panel-section">
        <h3>几何约束</h3>
        {list.length === 0 ? (
          <p className="panel-hint">选中图元后可在工具栏「约束 ▾」里添加关系。</p>
        ) : selectedConstraints.length === 0 ? (
          <p className="panel-hint">所选图元上还没有约束。</p>
        ) : (
          <>
            <ul className="entity-list">
              {selectedConstraints.map((c) => (
                <li key={c.id}>
                  <span className="entity-kind">
                    <span className="constraint-glyph" aria-hidden>
                      {CONSTRAINT_GLYPH[c.kind]}
                    </span>
                    {describeConstraint(c, doc)}
                  </span>
                  {DIMENSIONAL_CONSTRAINTS.has(c.kind) && (
                    <DimValueInput
                      constraint={c}
                      onCommit={(v) => setConstraintValueAction(c.id, v)}
                    />
                  )}
                  <button
                    className="link-btn"
                    title="删除这条约束"
                    onClick={() => removeConstraintAction(c.id)}
                  >
                    删除
                  </button>
                </li>
              ))}
            </ul>
            {selectedConstraints.length > 1 && (
              <button
                className="wide-btn"
                onClick={removeConstraintsForSelection}
                title="删除所选图元涉及的全部约束"
              >
                全部删除（{selectedConstraints.length}）
              </button>
            )}
          </>
        )}
      </section>

      <section className="panel-section">
        <h3>快捷键</h3>
        <table className="shortcut-table">
          <tbody>
            <tr><td className="mono">L</td><td>直线</td><td className="mono">C</td><td>圆</td></tr>
            <tr><td className="mono">PL</td><td>多段线</td><td className="mono">REC</td><td>矩形</td></tr>
            <tr><td className="mono">A</td><td>圆弧</td><td className="mono">EL</td><td>椭圆</td></tr>
            <tr><td className="mono">DI</td><td>测量</td><td className="mono">TR</td><td>修剪</td></tr>
            <tr><td className="mono">F7</td><td>栅格</td><td className="mono">F8</td><td>正交</td></tr>
            <tr><td className="mono">F9</td><td>栅格捕捉</td><td className="mono">F10</td><td>极轴</td></tr>
            <tr><td className="mono">F3</td><td>对象捕捉</td><td className="mono">Del</td><td>删除</td></tr>
            <tr><td className="mono">Ctrl+Z</td><td>撤销</td><td className="mono">Ctrl+Y</td><td>重做</td></tr>
            <tr><td className="mono">Ctrl+A</td><td>全选</td><td className="mono">Ctrl+D</td><td>复制</td></tr>
            <tr><td className="mono">Ctrl+S</td><td>保存</td><td className="mono">Ctrl+O</td><td>打开</td></tr>
          </tbody>
        </table>
      </section>

      <section className="panel-section">
        <h3>坐标输入</h3>
        <ul className="hint-list">
          <li><span className="mono">100,50</span> 绝对坐标</li>
          <li><span className="mono">@50,0</span> 相对上一点</li>
          <li><span className="mono">100&lt;45</span> 极坐标（长度&lt;角度）</li>
          <li><span className="mono">C</span> 闭合多段线</li>
        </ul>
        <p className="panel-hint">
          在绘图命令中直接键入数字后回车即可输入坐标。滚轮缩放，按住 Alt 或中键平移。
        </p>
      </section>

      <section className="panel-section">
        <h3>角度提示</h3>
        <div className="kv-grid">
          <span>当前极轴增量</span>
          <span className="mono">{fmtAngle((doc.settings.polarIncrement * Math.PI) / 180, 0)}</span>
          <span>捕捉口径</span>
          <span className="mono">{doc.settings.snapAperturePx} px</span>
          <span>拾取口径</span>
          <span className="mono">{doc.settings.pickAperturePx} px</span>
        </div>
      </section>
    </aside>
  );
}

/**
 * 尺寸约束的行内数值框：草稿 + blur/Enter 提交（与属性面板同一惯例）。
 * 角度按度输入、存弧度；非法/非正输入直接丢弃草稿不改值。
 */
function DimValueInput({
  constraint,
  onCommit,
}: {
  constraint: Constraint;
  onCommit: (v: number) => void;
}) {
  const isAngle = constraint.kind === 'angle';
  // 距离三兄弟的 0 是「重合 / 对齐」，允许输入；半径/角度仍是严格正数。
  const mayBeZero = ZERO_VALUE_DIMENSIONS.has(constraint.kind);
  const current = constraint.value ?? 0;
  const display = isAngle
    ? String(Number(((current * 180) / Math.PI).toFixed(1)))
    : String(Number(current.toFixed(3)));
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const raw = draft.trim();
    setDraft(null);
    if (raw === '') return;
    const n = Number(raw);
    if (!Number.isFinite(n) || (mayBeZero ? n < 0 : n <= 0)) return;
    onCommit(isAngle ? (n * Math.PI) / 180 : n);
  };
  return (
    <input
      className="dim-input"
      type="text"
      inputMode="decimal"
      value={draft ?? display}
      title="尺寸目标值（回车或失焦提交，角度按度）"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
          setDraft(null);
          (e.target as HTMLInputElement).blur();
        }
      }}
      onClick={(e) => e.stopPropagation()}
      style={{ width: 76 }}
    />
  );
}

function summarise(entities: ReadonlyArray<{ type: string }>): Array<[string, number]> {
  const m = new Map<string, number>();
  const label: Record<string, string> = {
    line: '直线',
    polyline: '多段线',
    circle: '圆',
    arc: '圆弧',
    ellipse: '椭圆',
  };
  for (const e of entities) {
    const k = label[e.type] ?? e.type;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()];
}
