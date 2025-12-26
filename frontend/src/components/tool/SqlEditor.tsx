import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view';
import { sql } from '@codemirror/lang-sql';
import { defaultKeymap } from '@codemirror/commands';
import { basicSetup } from 'codemirror';

export interface SqlEditorHandle {
  getSelectedSql: () => string;
}

interface SqlEditorProps {
  value: string;
  onChange?: (value: string) => void;
  onRunShortcut?: () => void;
  disabled?: boolean;
  readOnly?: boolean;
  placeholder?: string;
}

export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor({
  value,
  onChange,
  onRunShortcut,
  disabled = false,
  readOnly = false,
  placeholder = 'Enter SQL statement...',
}, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onRunShortcutRef = useRef(onRunShortcut);
  const disabledRef = useRef(disabled);

  // Keep refs updated without causing re-renders
  useEffect(() => {
    onRunShortcutRef.current = onRunShortcut;
    disabledRef.current = disabled;
  }, [onRunShortcut, disabled]);

  // Expose method to get selected SQL (or full content if no selection)
  useImperativeHandle(ref, () => ({
    getSelectedSql: () => {
      const view = viewRef.current;
      if (!view) return '';
      const { from, to } = view.state.selection.main;
      return from !== to
        ? view.state.sliceDoc(from, to)
        : view.state.doc.toString();
    },
  }), []);

  useEffect(() => {
    if (!containerRef.current) return;

    // Custom keymap for Cmd+Enter / Ctrl+Enter
    // Wrap with Prec.highest() to ensure it runs before any other keymaps
    const runShortcutKeymap = Prec.highest(
      keymap.of([
        {
          key: 'Mod-Enter',
          run: () => {
            if (!disabledRef.current && onRunShortcutRef.current) {
              onRunShortcutRef.current();
            }
            return true; // Prevent default behavior and newline insertion
          },
        },
      ])
    );

    const extensions = [
      basicSetup,
      sql(),
      keymap.of(defaultKeymap),
      placeholderExt(placeholder),
      runShortcutKeymap, // Add at the end with highest precedence
      EditorView.theme({
        '&': {
          fontSize: '14px',
          fontFamily: 'ui-monospace, monospace',
        },
        '.cm-content': {
          padding: '12px',
          minHeight: '120px',
        },
        '.cm-focused': {
          outline: 'none',
        },
        '.cm-scroller': {
          overflow: 'auto',
        },
      }),
    ];

    if (readOnly) {
      extensions.push(EditorState.readOnly.of(true));
      extensions.push(EditorView.editable.of(false));
    } else if (onChange) {
      extensions.push(
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChange(update.state.doc.toString());
          }
        })
      );
    }

    const state = EditorState.create({
      doc: value,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [readOnly, placeholder, onChange]);

  // Update content when value prop changes externally
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const currentValue = view.state.doc.toString();
    if (currentValue !== value) {
      view.dispatch({
        changes: {
          from: 0,
          to: currentValue.length,
          insert: value,
        },
      });
    }
  }, [value]);

  return (
    <div
      ref={containerRef}
      className="border border-border rounded-lg bg-background overflow-hidden"
    />
  );
});
