/**
 * Keyboard shortcut layer.
 *
 * Single-letter aliases mirror AutoCAD (`L`, `C`, `PL`, …) but a single keypress
 * is ambiguous between typing a command and issuing a shortcut, so we only fire
 * a shortcut when the focus is not inside a text field.
 */

import { useEffect } from 'react';
import { useEditor } from '../state/editorStore';
import { ALIAS_TO_TOOL } from '../tools/registry';

export function useShortcuts(): void {
  useEffect(() => {
    const isTextField = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName.toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
    };

    const onKeyDown = (ev: KeyboardEvent): void => {
      const state = useEditor.getState();

      // ---- modifier combinations (work everywhere) ----
      if (ev.ctrlKey || ev.metaKey) {
        switch (ev.key.toLowerCase()) {
          case 'z':
            ev.preventDefault();
            if (ev.shiftKey) state.redo();
            else state.undo();
            return;
          case 'y':
            ev.preventDefault();
            state.redo();
            return;
          case 'a':
            if (isTextField(ev.target)) return;
            ev.preventDefault();
            state.selectAll();
            return;
          case 's':
            ev.preventDefault();
            window.dispatchEvent(new CustomEvent('unicad:save'));
            return;
          case 'o':
            ev.preventDefault();
            window.dispatchEvent(new CustomEvent('unicad:open'));
            return;
          case 'n':
            ev.preventDefault();
            window.dispatchEvent(new CustomEvent('unicad:new'));
            return;
          case 'd':
            if (isTextField(ev.target)) return;
            ev.preventDefault();
            state.duplicateSelection({ x: 10, y: 10 });
            return;
          case 'f1':
            // Office's ribbon-collapse chord, adopted here so muscle memory
            // carries over. Bare F1 is left alone — it belongs to the browser.
            if (isTextField(ev.target)) return;
            ev.preventDefault();
            state.toggleRibbon();
            return;
          default:
            return;
        }
      }

      // ---- function keys: drafting toggles ----
      switch (ev.key) {
        case 'F7':
          ev.preventDefault();
          state.toggleGrid();
          return;
        case 'F8':
          ev.preventDefault();
          state.setConstraint(state.doc.settings.constraint === 'ortho' ? 'none' : 'ortho');
          return;
        case 'F9':
          ev.preventDefault();
          state.setConstraint(state.doc.settings.constraint === 'grid' ? 'none' : 'grid');
          return;
        case 'F10':
          ev.preventDefault();
          state.setConstraint(state.doc.settings.constraint === 'polar' ? 'none' : 'polar');
          return;
        case 'F3':
          ev.preventDefault();
          state.toggleOsnap('endpoint');
          return;
        case 'Delete':
          if (isTextField(ev.target)) return;
          ev.preventDefault();
          state.deleteSelection();
          return;
        case 'Escape': {
          if (isTextField(ev.target)) return;
          ev.preventDefault();
          // Cancel the active tool first; a second Escape clears the selection.
          window.dispatchEvent(new CustomEvent('unicad:escape'));
          if (state.activeTool !== 'select') state.setTool('select');
          else state.clearSelection();
          return;
        }
        case 'Enter':
          if (isTextField(ev.target)) return;
          ev.preventDefault();
          window.dispatchEvent(new CustomEvent('unicad:enter'));
          return;
      }

      if (isTextField(ev.target)) return;
      if (ev.altKey) return;

      // ---- single-letter tool aliases ----
      // Only fire for unambiguous one-character keys so multi-letter commands
      // such as `PL` remain typeable in the command line.
      const key = ev.key.toUpperCase();
      if (key.length === 1 && /[A-Z]/.test(key)) {
        const single = ALIAS_TO_TOOL.get(key);
        if (single) {
          ev.preventDefault();
          state.setTool(single);
          state.pushLog(`命令: ${key}`);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
