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

        <span className="status-chip mono dim">图元 {doc.entities.length}</span>
        {selection.size > 0 && <span className="status-chip accent">已选 {selection.size}</span>}

        <span className="status-spacer" />

        <span className="status-chip mono dim">历史 {history.depth}</span>
        <span className={`status-chip mono ${kernelStatus.startsWith('WASM') ? 'ok' : 'warn'}`}>
          {kernelStatus}
        </span>
      </div>
    </div>
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
