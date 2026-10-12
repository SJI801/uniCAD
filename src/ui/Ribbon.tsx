/**
 * Ribbon toolbar: drawing tools, edit commands, snap toggles, file operations.
 *
 * The bar has two states, toggled by the chevron pinned to its right end (or
 * Ctrl+F1):
 *
 *   expanded  — 62 px, seven captioned groups (文件 / 交换 / 绘图 / 几何约束 /
 *               修改 / 视图 / 捕捉与追踪).
 *   collapsed — 34 px, one row. Every caption goes away, the drawing tools
 *               become glyph-only squares, and 文件 + 交换 fold into a single
 *               dropdown so nothing falls off the edge. The drafting toggles
 *               keep their words: 正交 / 极轴 / 捕捉 are not guessable from a
 *               glyph, and mis-clicking one silently ruins the next dimension.
 *
 * The flag lives in the store and sticks to localStorage rather than sitting in
 * component state: `useShortcuts` has to flip it too, and a toolbar that springs
 * back open on every reload is worse than no toolbar control at all.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '../state/editorStore';
import { packOsnapMask, SNAP_KIND_LABEL, type ConstraintKind, type OsnapMode } from '../core/types';
import { canApply, CONSTRAINT_GLYPH, CONSTRAINT_LABEL, CONSTRAINT_ORDER } from '../core/constraints';
import { TOOL_SPECS } from '../tools/registry';

const OSNAP_ORDER: OsnapMode[] = [
  'endpoint',
  'midpoint',
  'center',
  'quadrant',
  'perpendicular',
  'intersection',
  'tangent',
  'nearest',
];

export interface RibbonProps {
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onExportDxf: () => void;
  onImportDxf: () => void;
  onExportPng: () => void;
}

/** One row of the collapsed-mode 文件 dropdown. */
interface MenuEntry {
  label: string;
  /** Accelerator, right-aligned. Empty for entries that have no shortcut. */
  key: string;
  run: () => void;
  /** Draw a hairline above this entry. */
  sepBefore?: boolean;
}

export default function Ribbon(props: RibbonProps): React.ReactElement {
  const activeTool = useEditor((s) => s.activeTool);
  const setTool = useEditor((s) => s.setTool);
  const doc = useEditor((s) => s.doc);
  const toggleOsnap = useEditor((s) => s.toggleOsnap);
  const setConstraint = useEditor((s) => s.setConstraint);
  const gridVisible = useEditor((s) => s.gridVisible);
  const toggleGrid = useEditor((s) => s.toggleGrid);
  const dimsVisible = useEditor((s) => s.dimsVisible);
  const toggleDims = useEditor((s) => s.toggleDims);
  const view3d = useEditor((s) => s.view3d);
  const setView3d = useEditor((s) => s.setView3d);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const history = useEditor((s) => s.history);
  const deleteSelection = useEditor((s) => s.deleteSelection);
  const duplicateSelection = useEditor((s) => s.duplicateSelection);
  const splitAtIntersections = useEditor((s) => s.splitAtIntersections);
  const selectAll = useEditor((s) => s.selectAll);
  const zoomToFit = useEditor((s) => s.zoomToFit);
  const selection = useEditor((s) => s.selection);
  const collapsed = useEditor((s) => s.ribbonCollapsed);
  const toggleRibbon = useEditor((s) => s.toggleRibbon);
  const addConstraintAction = useEditor((s) => s.addConstraintAction);
  const removeConstraintsForSelection = useEditor((s) => s.removeConstraintsForSelection);
  const constraintsVisible = useEditor((s) => s.constraintsVisible);
  const toggleConstraints = useEditor((s) => s.toggleConstraints);
  const toggleEndpoints = useEditor((s) => s.toggleEndpoints);
  const endpointsVisible = useEditor((s) => s.endpointsVisible);

  const activeOsnapMask = packOsnapMask(doc.settings.osnapModes);

  const handleDup = useCallback(() => {
    duplicateSelection({ x: 10, y: 10 });
  }, [duplicateSelection]);

  // -------------------------------------------------------------------------
  // Dropdowns (collapsed-mode 文件 + 约束, and the expanded-mode 约束 button)
  // -------------------------------------------------------------------------
  // The menu is rendered as a *sibling* of the bar and positioned `fixed`, not
  // as an absolutely positioned child: `.ribbon` is an `overflow-x: auto`
  // scroller, and a dropdown living inside it would be clipped to the 34 px row.
  //
  // Two owners share one popover. Keying it rather than keeping two independent
  // states means opening one menu closes the other for free, and the outside
  // click / Escape handling below is written once.

  type MenuOwner = 'file' | 'geom';

  const [menu, setMenu] = useState<{ owner: MenuOwner; left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const fileBtnRef = useRef<HTMLButtonElement | null>(null);
  const geomBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!menu) return;

    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node | null;
      if (target && (menuRef.current?.contains(target) || fileBtnRef.current?.contains(target))) {
        return;
      }
      setMenu(null);
    };

    // Escape must swallow the event: the global shortcut layer reads the same
    // key as "cancel the active tool / clear the selection".
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setMenu(null);
    };

    // `scroll` does not bubble, but a capturing listener on document still sees
    // it — that is what keeps the menu glued to the bar when the ribbon scrolls
    // horizontally (or the window does).
    const onScroll = (): void => setMenu(null);

    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [menu]);

  const toggleMenu = useCallback((owner: MenuOwner, el: HTMLButtonElement): void => {
    setMenu((open) => {
      if (open && open.owner === owner) return null;
      const r = el.getBoundingClientRect();
      return { owner, left: r.left, top: r.bottom + 4 };
    });
  }, []);

  const fileEntries: MenuEntry[] = [
    { label: '新建', key: 'Ctrl+N', run: props.onNew },
    { label: '打开…', key: 'Ctrl+O', run: props.onOpen },
    { label: '保存', key: 'Ctrl+S', run: props.onSave },
    { label: '导入 DXF…', key: '', run: props.onImportDxf, sepBefore: true },
    { label: '导出 DXF', key: '', run: props.onExportDxf },
    { label: '导出 PNG', key: '', run: props.onExportPng },
  ];

  // -------------------------------------------------------------------------
  // Geometric-constraint menu
  // -------------------------------------------------------------------------
  //
  // Applicability is decided here, against the *current* selection, so an
  // option the selection cannot satisfy is visibly dead with the reason in its
  // row — rather than silently doing nothing when clicked. `addConstraintAction`
  // re-checks and logs, but a log line the user has to go hunting for is a
  // worse answer than a menu that already said no.

  const selectedEntities = useMemo(
    () => doc.entities.filter((e) => selection.has(e.id)),
    [doc.entities, selection],
  );
  const selectedConstraintCount = useMemo(
    () =>
      doc.constraints.filter(
        (c) => selection.has(c.a.entity) || (c.b !== undefined && selection.has(c.b.entity)),
      ).length,
    [doc.constraints, selection],
  );

  const constraintRows = CONSTRAINT_ORDER.map((kind) => {
    const ok = canApply(kind, selectedEntities);
    return { kind, ok };
  });

  const runConstraint = (kind: ConstraintKind): void => {
    setMenu(null);
    addConstraintAction(kind);
  };

  // -------------------------------------------------------------------------
  // Shared pieces (both states render the same controls, just differently)
  // -------------------------------------------------------------------------

  const renderConstraint = (
    mode: 'ortho' | 'polar' | 'grid',
    label: string,
    title: string,
  ): React.ReactElement => (
    <button
      key={mode}
      className={`tool-btn compact ${doc.settings.constraint === mode ? 'active' : ''}`}
      onClick={() => setConstraint(doc.settings.constraint === mode ? 'none' : mode)}
      title={title}
    >
      {label}
    </button>
  );

  const renderOsnaps = (): React.ReactElement[] =>
    OSNAP_ORDER.map((mode) => {
      const on = (activeOsnapMask & (1 << osnapTag(mode))) !== 0;
      return (
        <button
          key={mode}
          className={`tool-btn compact ${on ? 'active' : ''}`}
          onClick={() => toggleOsnap(mode)}
          title={`对象捕捉: ${SNAP_KIND_LABEL[mode]}`}
        >
          {SNAP_KIND_LABEL[mode]}
        </button>
      );
    });

  const ribbonToggle = (
    <button
      className="ribbon-toggle"
      onClick={toggleRibbon}
      title={collapsed ? '展开工具栏 (Ctrl+F1)' : '收拢工具栏 (Ctrl+F1)'}
      aria-label={collapsed ? '展开工具栏' : '收拢工具栏'}
      aria-expanded={!collapsed}
    >
      <span aria-hidden>{collapsed ? '▾' : '▴'}</span>
    </button>
  );

  /**
   * The single popover, shared by whichever button owns it.
   *
   * It is a *sibling* of the bar rather than a positioned child: `.ribbon` is an
   * `overflow-x: auto` scroller, and anything inside it gets clipped to the row
   * height. Hence `position: fixed` plus viewport coordinates from
   * `getBoundingClientRect`.
   */
  const popover = menu ? (
    <div
      ref={menuRef}
      className={`ribbon-menu${menu.owner === 'geom' ? ' wide' : ''}`}
      style={{ left: menu.left, top: menu.top }}
      role="menu"
    >
      {menu.owner === 'file'
        ? fileEntries.map((it) => (
            <Fragment key={it.label}>
              {it.sepBefore ? <span className="ribbon-menu-sep" /> : null}
              <button
                className="ribbon-menu-item"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  it.run();
                }}
              >
                <span>{it.label}</span>
                {it.key ? <span className="ribbon-menu-key">{it.key}</span> : null}
              </button>
            </Fragment>
          ))
        : constraintRows.map(({ kind, ok }) => (
            <button
              key={kind}
              className="ribbon-menu-item"
              role="menuitem"
              disabled={!ok.ok}
              title={ok.ok ? CONSTRAINT_LABEL[kind] : ok.reason}
              onClick={() => runConstraint(kind)}
            >
              <span className="ribbon-menu-glyph" aria-hidden>
                {CONSTRAINT_GLYPH[kind]}
              </span>
              <span className="ribbon-menu-label">{CONSTRAINT_LABEL[kind]}</span>
              {!ok.ok ? <span className="ribbon-menu-key">{ok.reason}</span> : null}
            </button>
          ))}
      {menu.owner === 'geom' ? (
        <>
          <span className="ribbon-menu-sep" />
          <button
            className="ribbon-menu-item"
            role="menuitem"
            disabled={selectedConstraintCount === 0}
            title={
              selectedConstraintCount === 0
                ? '所选图元上没有约束'
                : `删除所选图元涉及的 ${selectedConstraintCount} 条约束`
            }
            onClick={() => {
              setMenu(null);
              removeConstraintsForSelection();
            }}
          >
            <span className="ribbon-menu-glyph" aria-hidden>
              ✕
            </span>
            <span className="ribbon-menu-label">删除所选约束</span>
            <span className="ribbon-menu-key">{selectedConstraintCount}</span>
          </button>
          <button
            className="ribbon-menu-item"
            role="menuitemcheckbox"
            aria-checked={constraintsVisible}
            onClick={() => {
              toggleConstraints();
              // stays open: this is a persistent view toggle, not a command
            }}
          >
            <span className="ribbon-menu-glyph" aria-hidden>
              {constraintsVisible ? '☑' : '☐'}
            </span>
            <span className="ribbon-menu-label">显示约束标记</span>
          </button>
        </>
      ) : null}
    </div>
  ) : null;

  // -------------------------------------------------------------------------
  // Collapsed: one row, nothing captioned
  // -------------------------------------------------------------------------

  if (collapsed) {
    return (
      <>
        <div className="ribbon collapsed">
          <button
            ref={fileBtnRef}
            className={`tool-btn compact ${menu?.owner === 'file' ? 'active' : ''}`}
            onClick={(e) => toggleMenu('file', e.currentTarget)}
            title="文件与交换"
            aria-haspopup="menu"
            aria-expanded={menu?.owner === 'file'}
          >
            文件 ▾
          </button>

          <button
            ref={geomBtnRef}
            className={`tool-btn compact ${menu?.owner === 'geom' ? 'active' : ''}`}
            onClick={(e) => toggleMenu('geom', e.currentTarget)}
            title="几何约束：让选中图元保持相切/垂直/同心等关系"
            aria-haspopup="menu"
            aria-expanded={menu?.owner === 'geom'}
          >
            约束 ▾
          </button>

          <span className="ribbon-sep" />

          {TOOL_SPECS.map((t) => (
            <button
              key={t.id}
              className={`tool-btn icon ${activeTool === t.id ? 'active' : ''}`}
              onClick={() => setTool(t.id)}
              title={`${t.name} (${t.alias})`}
            >
              <span className="tool-glyph" aria-hidden>
                {t.glyph}
              </span>
            </button>
          ))}

          <span className="ribbon-sep" />

          <button
            className="tool-btn icon"
            onClick={undo}
            disabled={!history.canUndo}
            title={history.canUndo ? `撤销: ${history.undoLabel}` : '无可撤销操作'}
          >
            <span aria-hidden>↶</span>
          </button>
          <button
            className="tool-btn icon"
            onClick={redo}
            disabled={!history.canRedo}
            title={history.canRedo ? `重做: ${history.redoLabel}` : '无可重做操作'}
          >
            <span aria-hidden>↷</span>
          </button>
          <button
            className="tool-btn icon danger"
            onClick={deleteSelection}
            disabled={selection.size === 0}
            title="删除所选 (Delete)"
          >
            <span aria-hidden>✕</span>
          </button>

          <span className="ribbon-sep" />

          {renderConstraint('ortho', '正交', '正交模式 (F8)')}
          {renderConstraint('polar', '极轴', `极轴追踪 ${doc.settings.polarIncrement}° (F10)`)}
          {renderConstraint('grid', '捕捉', '栅格捕捉 (F9)')}
          <button
            className={`tool-btn compact ${gridVisible ? 'active' : ''}`}
            onClick={toggleGrid}
            title="显示/隐藏栅格 (F7)"
          >
            栅格
          </button>
          <button
            className={`tool-btn compact ${dimsVisible ? 'active' : ''}`}
            onClick={toggleDims}
            title="显示/隐藏自动尺寸（绘制中的实时读数 + 选中图元的尺寸）"
          >
            尺寸
          </button>
          <button
            className={`tool-btn compact ${view3d ? 'active' : ''}`}
            onClick={() => setView3d(!view3d)}
            title="在 2D 草图与 3D 实体之间切换（3D 下拖动旋转、滚轮推拉）"
          >
            {view3d ? '2D' : '3D'}
          </button>

          <span className="ribbon-sep" />

          {renderOsnaps()}

          <span className="ribbon-spacer" />

          <button
            className="tool-btn compact"
            onClick={zoomToFit}
            title="缩放到范围 (Z / 双击中键)"
          >
            缩放范围
          </button>

          {ribbonToggle}
        </div>

        {popover}
      </>
    );
  }

  // -------------------------------------------------------------------------
  // Expanded: the full seven-group ribbon
  // -------------------------------------------------------------------------

  return (
    <>
    <div className="ribbon">
      <div className="ribbon-group">
        <div className="ribbon-group-body">
          <button className="tool-btn wide" onClick={props.onNew} title="新建图纸 (Ctrl+N)">
            新建
          </button>
          <button className="tool-btn wide" onClick={props.onOpen} title="打开 .unicad.json (Ctrl+O)">
            打开
          </button>
          <button className="tool-btn wide" onClick={props.onSave} title="保存 (Ctrl+S)">
            保存
          </button>
        </div>
        <div className="ribbon-group-label">文件</div>
      </div>

      <div className="ribbon-sep" />

      <div className="ribbon-group">
        <div className="ribbon-group-body">
          <button className="tool-btn wide" onClick={props.onImportDxf} title="导入 DXF">
            导入 DXF
          </button>
          <button className="tool-btn wide" onClick={props.onExportDxf} title="导出 DXF R12">
            导出 DXF
          </button>
          <button className="tool-btn wide" onClick={props.onExportPng} title="导出 PNG 图片">
            导出 PNG
          </button>
        </div>
        <div className="ribbon-group-label">交换</div>
      </div>

      <div className="ribbon-sep" />

      <div className="ribbon-group">
        <div className="ribbon-group-body">
          {TOOL_SPECS.map((t) => (
            <button
              key={t.id}
              className={`tool-btn ${activeTool === t.id ? 'active' : ''}`}
              onClick={() => setTool(t.id)}
              title={`${t.name} (${t.alias})`}
            >
              <span className="tool-glyph" aria-hidden>
                {t.glyph}
              </span>
              <span className="tool-name">{t.name}</span>
            </button>
          ))}
        </div>
        <div className="ribbon-group-label">绘图</div>
      </div>

      <div className="ribbon-sep" />

      <div className="ribbon-group">
        <div className="ribbon-group-body">
          {/* One button, nine relationships. They only make sense as a set with
              the current selection, so spreading nine enabled-looking buttons
              across the bar would be nine ways to click and get nothing. */}
          <button
            ref={geomBtnRef}
            className={`tool-btn wide ${menu?.owner === 'geom' ? 'active' : ''}`}
            onClick={(e) => toggleMenu('geom', e.currentTarget)}
            title="几何约束：让图元保持相切/垂直/平行/同心等关系"
            aria-haspopup="menu"
            aria-expanded={menu?.owner === 'geom'}
          >
            约束 ▾
          </button>
          <button
            className={`tool-btn wide ${constraintsVisible ? 'active' : ''}`}
            onClick={toggleConstraints}
            title="显示/隐藏画布上的约束标记"
          >
            约束标记
          </button>
          <button
            className={`tool-btn wide ${endpointsVisible ? 'active' : ''}`}
            onClick={toggleEndpoints}
            title="起点绿点 / 终点红点：显示图元方向"
          >
            端点标色
          </button>
        </div>
        <div className="ribbon-group-label">几何约束</div>
      </div>

      <div className="ribbon-sep" />

      <div className="ribbon-group">
        <div className="ribbon-group-body">
          <button
            className="tool-btn wide"
            onClick={undo}
            disabled={!history.canUndo}
            title={history.canUndo ? `撤销: ${history.undoLabel}` : '无可撤销操作'}
          >
            撤销
          </button>
          <button
            className="tool-btn wide"
            onClick={redo}
            disabled={!history.canRedo}
            title={history.canRedo ? `重做: ${history.redoLabel}` : '无可重做操作'}
          >
            重做
          </button>
          <button
            className="tool-btn wide danger"
            onClick={deleteSelection}
            disabled={selection.size === 0}
            title="删除所选 (Delete)"
          >
            删除
          </button>
          <button
            className="tool-btn wide"
            onClick={handleDup}
            disabled={selection.size === 0}
            title="复制所选 (Ctrl+D)"
          >
            复制
          </button>
          {/* One button for both scopes: with a selection it breaks those
              entities, without one it breaks the whole drawing. Two buttons
              for two scopes would be two ways to read the same rule. */}
          <button
            className="tool-btn wide"
            onClick={splitAtIntersections}
            title="在交点处自动分解图元（EX）：有选中就分解所选，没有就分解整幅可见图元"
          >
            交点分解
          </button>
        </div>
        <div className="ribbon-group-label">修改</div>
      </div>

      <div className="ribbon-sep" />

      <div className="ribbon-group">
        <div className="ribbon-group-body">
          <button className="tool-btn wide" onClick={selectAll} title="全选 (Ctrl+A)">
            全选
          </button>
          <button className="tool-btn wide" onClick={zoomToFit} title="缩放到范围 (Z / 双击中键)">
            缩放范围
          </button>
          <button
            className={`tool-btn wide ${gridVisible ? 'active' : ''}`}
            onClick={toggleGrid}
            title="显示/隐藏栅格 (F7)"
          >
            栅格
          </button>
          <button
            className={`tool-btn wide ${dimsVisible ? 'active' : ''}`}
            onClick={toggleDims}
            title="显示/隐藏自动尺寸（绘制中的实时读数 + 选中图元的尺寸）"
          >
            尺寸
          </button>
          {/* The one control that leaves the drawing plane. Kept beside the other
              view toggles rather than in a "3D" group of its own: with a single
              mode button there is nothing for a group to hold. */}
          <button
            className={`tool-btn wide ${view3d ? 'active' : ''}`}
            onClick={() => setView3d(!view3d)}
            title="在 2D 草图与 3D 实体之间切换（3D 下拖动旋转、滚轮推拉）"
          >
            {view3d ? '回 2D' : '看 3D'}
          </button>
        </div>
        <div className="ribbon-group-label">视图</div>
      </div>

      <div className="ribbon-sep" />

      <div className="ribbon-group grow">
        <div className="ribbon-group-body osnap-row">
          {renderConstraint('ortho', '正交', '正交模式 (F8)')}
          {renderConstraint('polar', '极轴', `极轴追踪 ${doc.settings.polarIncrement}° (F10)`)}
          {renderConstraint('grid', '捕捉', '栅格捕捉 (F9)')}
          <span className="osnap-divider" />
          {renderOsnaps()}
        </div>
        <div className="ribbon-group-label">捕捉与追踪</div>
      </div>

      {ribbonToggle}
    </div>

    {popover}
    </>
  );
}

function osnapTag(mode: OsnapMode): number {
  const order: OsnapMode[] = [
    'endpoint',
    'midpoint',
    'center',
    'quadrant',
    'perpendicular',
    'nearest',
    'intersection',
    'tangent',
    'grid',
  ];
  return order.indexOf(mode);
}
