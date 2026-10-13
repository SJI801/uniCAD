/**
 * Bottom command line + status bar.
 *
 * The command line accepts the same aliases as the ribbon buttons, plus
 * numeric coordinate entry (`100,50`, `@50,0`, `100<45`) which is forwarded to
 * the active tool.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor } from '../state/editorStore';
import { ALIAS_TO_TOOL } from '../tools/registry';
import { fmt, SNAP_KIND_LABEL, type ConstraintMode } from '../core/types';
import { describeConstraint } from '../core/constraints';
import { allEntities } from '../core/doc';

export default function StatusBar(): React.ReactElement {
  const prompt = useEditor((s) => s.prompt);
  const log = useEditor((s) => s.log);
  const cursor = useEditor((s) => s.cursor);
  const doc = useEditor((s) => s.doc);
  const view = useEditor((s) => s.view);
  const kernelStatus = useEditor((s) => s.kernelStatus);
  const history = useEditor((s) => s.history);
  const selection = useEditor((s) => s.selection);
  const setTool = useEditor((s) => s.setTool);
  const pushLog = useEditor((s) => s.pushLog);
  const setConstraint = useEditor((s) => s.setConstraint);
  const toggleOsnap = useEditor((s) => s.toggleOsnap);
  const updateSettings = useEditor((s) => s.updateSettings);
  const clearSelection = useEditor((s) => s.clearSelection);

  const [input, setInput] = useState('');
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [recall, setRecall] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);

  const submit = useCallback((): void => {
    const text = input.trim();
    if (text.length === 0) {
      // Bare Enter = "accept" (finish the current tool).
      window.dispatchEvent(new CustomEvent('unicad:enter'));
      inputRef.current?.focus();
      return;
    }

    setRecall((r) => [...r, text]);
    setHistoryIndex(-1);

    // 1) Coordinate / polar entry goes straight to the tool.
    if (/^[@]?-?[\d.]/.test(text) || text.startsWith('@')) {
      window.dispatchEvent(new CustomEvent('unicad:text', { detail: text }));
      setInput('');
      return;
    }

    const key = text.toUpperCase();

    // 2) Simple view / edit commands.
    const state = useEditor.getState();
    switch (key) {
      case 'Z':
      case 'ZOOM':
        state.zoomToFit();
        setInput('');
        return;
      case 'U':
        state.undo();
        setInput('');
        return;
      case 'REDO':
        state.redo();
        setInput('');
        return;
      case 'DIM':
      case 'DIMS':
        state.toggleDims();
        setInput('');
        return;
      case 'DEL':
      case 'ERASE':
      case 'E':
        state.deleteSelection();
        setInput('');
        return;
      case 'ESC':
        clearSelection();
        setInput('');
        return;
      case 'EX':
      case 'EXPLODE':
      case 'SPLIT':
        state.splitAtIntersections();
        setInput('');
        return;
    }

    // 3) Tool aliases.
    const toolId = ALIAS_TO_TOOL.get(key);
    if (toolId) {
      setTool(toolId);
      const label = key === toolId.toUpperCase() ? key : `${key}`;
      pushLog(`命令: ${label}`);
      setInput('');
      return;
    }

    // 4) Otherwise let the tool interpret it.
    window.dispatchEvent(new CustomEvent('unicad:text', { detail: text }));
    pushLog(`未知命令 "${text}" —— 输入 L/C/PL/REC/A/EL/DI 或使用工具栏`);
    setInput('');
  }, [clearSelection, input, pushLog, setTool]);

  const onKeyDown = useCallback(
    (ev: React.KeyboardEvent<HTMLInputElement>): void => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        submit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        setInput('');
        (ev.target as HTMLInputElement).blur();
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        const next = historyIndex < 0 ? recall.length - 1 : historyIndex - 1;
        if (next >= 0 && next < recall.length) {
          setHistoryIndex(next);
          setInput(recall[next] ?? '');
        }
      } else if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        if (historyIndex < 0) return;
        const next = historyIndex + 1;
        if (next >= recall.length) {
          setHistoryIndex(-1);
          setInput('');
        } else {
          setHistoryIndex(next);
          setInput(recall[next] ?? '');
        }
      }
    },
    [historyIndex, recall, submit],
  );

  const snapLabel = cursor.snap
    ? `${SNAP_KIND_LABEL[cursor.snap.kind]}`
    : '无捕捉';

  return (
    <div className="status-area">
      <div className="cmd-log" ref={logRef}>
        {log.slice(-40).map((line, i) => (
          <div key={i} className={`log-line ${line.startsWith('✗') ? 'err' : line.startsWith('⚠') ? 'warn' : ''}`}>
            {line}
          </div>
        ))}
      </div>

      <div className="cmd-line">
        <span className="cmd-prompt">{prompt}</span>
        <input
          ref={inputRef}
          className="cmd-input"
          value={input}
          placeholder="输入命令或坐标 (如 L / 100,50 / @50,0 / 100<45)"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
        />
      </div>

      <div className="status-bar">
        <button
          className="status-chip"
          onClick={() => setConstraint(nextConstraint(doc.settings.constraint))}
          title="切换正交 / 极轴 / 栅格捕捉"
        >
          {constraintLabel(doc.settings.constraint)}
        </button>

        <button
          className="status-chip"
          onClick={() => toggleOsnap('endpoint')}
          title="切换端点捕捉"
        >
          捕捉: {snapLabel}
        </button>

        <span className="status-chip mono">
          X {fmt(cursor.effective.x, 3)} &nbsp; Y {fmt(cursor.effective.y, 3)}
        </span>

        <span className="status-chip mono dim">
          Δ? &nbsp; 缩放 1:{fmt(1 / view.scale, 2)}
        </span>

        <span className="status-chip mono dim">栅格 {fmt(doc.settings.gridSpacing)}</span>

        <span className="status-chip mono dim">
          单位
          <select
            className="inline-select"
            value={doc.settings.units}
            onChange={(e) => updateSettings({ units: e.target.value as typeof doc.settings.units })}
          >
            <option value="mm">mm</option>
            <option value="cm">cm</option>
            <option value="m">m</option>
            <option value="in">in</option>
          </select>
        </span>

        <span className="status-chip mono dim">图元 {allEntities(doc).length}</span>
        {selection.size > 0 && <span className="status-chip accent">已选 {selection.size}</span>}

        <SketchStatusChip />
        <FeatureStatusChip />

        <span className="status-spacer" />

        <span className="status-chip mono dim">历史 {history.depth}</span>
        <span className={`status-chip mono ${kernelStatus.startsWith('WASM') ? 'ok' : 'warn'}`}>
          {kernelStatus}
        </span>
      </div>
    </div>
  );
}

/**
 * 草图状态 chip（ROADMAP 0.3）：欠约束 / 完全定义 / 过约束。
 *
 * 三态而不是一个数字，因为用户要回答的是不同的问题：
 * 「还差多少」→ 数字；「是不是定死了」→ 完全定义；「为什么形状不听话」→ 冲突项。
 * `report === null` 时**不画**这个 chip（内核没就绪 / 还没约束）——显示 0 会被读成
 * 「完全定义」，那是撒谎。
 *
 * 点一下把完整详情写进日志：悬停 tooltip 放不下几条冲突，日志区能。
 */
function SketchStatusChip(): React.ReactElement | null {
  const report = useEditor((s) => s.constraintReport);
  const doc = useEditor((s) => s.doc);
  const pushLog = useEditor((s) => s.pushLog);
  if (!report) return null;

  const conflicts = report.conflicting;
  const bad = conflicts.length > 0;
  const unconstrained = report.constraintCount === 0;
  const text = bad
    ? `过约束 · 冲突 ${conflicts.length}`
    : unconstrained
      ? `无约束 · ${report.dof} 自由度`
      : report.dof === 0
        ? report.redundant > 0
          ? `完全定义 · 多余 ${report.redundant}`
          : '完全定义'
        : `欠约束 ${report.dof}`;

  const tooltip = [
    `草图状态（活动基准面）：${report.entityCount} 个图元 / ${report.constraintCount} 条约束`,
    unconstrained
      ? `还没加任何约束：${report.dof} 个自由度全都在（每条线的两端点各 2 个）。`
      : report.dof > 0
        ? `欠约束：还剩 ${report.dof} 个自由度。想把这个数字压到 0，先给草图接地：「固定」（约束菜单最后一项）会把该图元的每个具名点钉在当前位置，整张图的刚体平移（和转动）自由度只有它能消掉。`
        : '完全定义：没有剩余自由度。',
    report.redundant > 0
      ? `多余约束 ${report.redundant} 条：与别的约束等价，删掉不会改变形状（不是错误）。`
      : '',
    bad
      ? `冲突 ${conflicts.length} 条（无法同时成立）：\n${conflicts
          .map((c) => `  · ${describeConstraint(c, doc)}`)
          .join('\n')}`
      : '',
    report.dof > 0
      ? '选中图元会在画布上画出它还能动的方向：十字箭头 = 可平移，「转」= 还能转，「尺寸」= 尺寸未定（跟「约束标记」开关一起显隐）。'
      : '',
    '「状态配色」开关打开后，还缺尺寸或方位约束的图元画成蓝色（只是位置没定的不染——用「固定」把点钉住即可）。',
    '点击把详情写进下方日志。',
  ]
    .filter((s) => s !== '')
    .join('\n');

  return (
    <button
      className={`status-chip mono ${bad ? 'err' : unconstrained ? 'dim' : report.dof === 0 ? 'ok' : 'dim'}`}
      title={tooltip}
      onClick={() => {
        pushLog(
          `草图: ${
            bad
              ? `过约束（冲突 ${conflicts.length} 条）`
              : unconstrained
                ? `无约束（${report.dof} 个自由度）`
                : report.dof === 0
                  ? '完全定义'
                  : `欠约束 ${report.dof}`
          }` + `${report.redundant > 0 ? ` · 多余 ${report.redundant}` : ''}`,
        );
        for (const c of conflicts) pushLog(`⚠ 冲突: ${describeConstraint(c, doc)}`);
        if (bad) pushLog('  冲突 = 这些约束不能同时成立；删掉其中一条（右栏约束列表）即可。');
      }}
    >
      {text}
    </button>
  );
}

/**
 * 特征树错误 chip（阶段 1 · 1.2）：几个特征求值失败。
 *
 * 求值器把错误当**值**返回（轮廓被删、草图被删、类型尚未实现），这个 chip
 * 是它们唯一的界面出口——树面板（1.4）还没来，但不能因此让用户对着一根
 * 不出现的拉伸猜原因。`errorCount === 0` 时不画：没有错误就不占位置。
 *
 * 点一下把每条失败的原因写进日志，和草图状态 chip 同一理由：tooltip 放不下。
 */
function FeatureStatusChip(): React.ReactElement | null {
  const featureEval = useEditor((s) => s.featureEval);
  const pushLog = useEditor((s) => s.pushLog);
  if (featureEval.errorCount === 0) return null;

  const failed = featureEval.items.filter((i) => i.status === 'error');
  const suppressed = featureEval.items.filter((i) => i.status === 'suppressed').length;
  const tooltip = [
    `${featureEval.errorCount} 个特征求值失败：`,
    ...failed.map((i) => `  · ${i.error ?? i.feature.name}`),
    suppressed > 0 ? `另有 ${suppressed} 个特征被抑制（不参与求值，也不画）。` : '',
    '点击把详情写进下方日志。',
  ]
    .filter((s) => s !== '')
    .join('\n');

  return (
    <button
      className="status-chip mono err"
      title={tooltip}
      onClick={() => {
        for (const i of failed) pushLog(`⚠ 特征: ${i.error ?? i.feature.name}`);
      }}
    >
      特征错误 {featureEval.errorCount}
    </button>
  );
}

function constraintLabel(mode: ConstraintMode): string {
  switch (mode) {
    case 'ortho':
      return '正交 开';
    case 'polar':
      return '极轴 开';
    case 'grid':
      return '捕捉 开';
    default:
      return '约束 关';
  }
}

function nextConstraint(mode: ConstraintMode): ConstraintMode {
  // Mirrors the F8 → F10 → F9 → off cycle AutoCAD users know.
  switch (mode) {
    case 'none':
      return 'ortho';
    case 'ortho':
      return 'polar';
    case 'polar':
      return 'grid';
    default:
      return 'none';
  }
}
