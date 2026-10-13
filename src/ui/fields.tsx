/**
 * The panel toolkit: text and number fields with one shared commit contract.
 *
 * Extracted from `LeftPanel` when the feature tree (work package 1.4) needed
 * the same behaviour — a second copy of this contract would be a second place
 * to get "one edit = one undo" wrong, and importing it from `LeftPanel` would
 * make the two panels import each other.
 *
 * The contract, applied by both: **draft locally, commit on blur or Enter,
 * revert on Escape.** Committing per keystroke would push one undo step per
 * character and make the field fight the geometry it edits (typing `100` into
 * a radius would briefly set 1, then 10).
 */

import { useState } from 'react';

/** Keep step arithmetic from producing 0.30000000000000004. */
export function round6(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 1e6) / 1e6;
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
export function NumberInput({
  value,
  param,
  title,
  step,
  min,
  max,
  unit,
  placeholder,
  autoFocus,
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
  /**
   * Focus on mount. For fields that appear on demand (the tree's double-click
   * to edit) — without it the field mounts unfocused and the double-click
   * reads as "nothing happened".
   */
  autoFocus?: boolean;
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
        autoFocus={autoFocus}
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

/**
 * A text field with the same draft/commit contract as `NumberInput`.
 *
 * Committing per keystroke would push one undo step per character and clone the
 * whole document each time — so typing a ten-character name would take ten
 * undos to take back. Blur/Enter keeps one edit equal to one undo, which is the
 * only grouping the user can predict.
 */
export function TextInput({
  value,
  param,
  title,
  placeholder,
  autoFocus,
  onCommit,
}: {
  value: string;
  param: string;
  title?: string;
  placeholder?: string;
  /** See `NumberInput` — same reason, same on-demand mount. */
  autoFocus?: boolean;
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
      autoFocus={autoFocus}
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
