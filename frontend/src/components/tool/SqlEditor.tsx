import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view';
import { sql } from '@codemirror/lang-sql';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { defaultKeymap } from '@codemirror/commands';
import { basicSetup } from 'codemirror';

const sqlHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--syntax-keyword)' },
  { tag: tags.string, color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syntax-number)' },
  { tag: tags.comment, color: 'var(--muted-foreground)' },
  { tag: tags.invalid, color: 'var(--destructive-foreground)' },
]);

export interface SqlEditorHandle {
  getSelectedSql: () => string;
  focus: () => void;
}

interface SqlEditorProps {
  value: string;
  onChange?: (value: string) => void;
  onRunShortcut?: () => void;
  disabled?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  ariaLabelledBy?: string;
  error?: string;
}

export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor({
  value,
  onChange,
  onRunShortcut,
  disabled = false,
  readOnly = false,
  placeholder = 'Enter SQL statement...',
  ariaLabelledBy,
  error,
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
    focus: () => viewRef.current?.focus(),
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
      EditorView.contentAttributes.of({
        'aria-labelledby': ariaLabelledBy || '',
        'aria-readonly': String(readOnly),
        ...(readOnly ? { tabindex: '0' } : {}),
      }),
      sql(),
      syntaxHighlighting(sqlHighlightStyle),
      keymap.of(defaultKeymap),
      placeholderExt(placeholder),
      runShortcutKeymap, // Add at the end with highest precedence
      EditorView.theme({
        '&': {
          fontSize: 'inherit',
          fontFamily: 'var(--font-mono)',
          color: 'var(--foreground)',
          backgroundColor: 'var(--background)',
        },
        '.cm-content': {
          padding: '12px',
          minHeight: '120px',
        },
        '&.cm-focused': {
          outline: 'none',
        },
        '.cm-gutters': {
          backgroundColor: 'var(--background)',
          color: 'var(--muted-foreground)',
          borderColor: 'var(--border-subtle)',
        },
        '.cm-activeLine': {
          backgroundColor: 'var(--muted)',
        },
        '.cm-activeLineGutter': {
          backgroundColor: 'var(--muted)',
          color: 'var(--foreground)',
        },
        '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
          backgroundColor: 'var(--selection)',
        },
        '.cm-cursor, .cm-dropCursor': {
          borderLeftColor: 'var(--foreground)',
        },
        '.cm-placeholder': {
          color: 'var(--muted-foreground)',
        },
        '.cm-scroller': {
          overflow: 'auto',
          fontFamily: 'inherit',
          lineHeight: 'var(--text-code--line-height)',
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
  }, [readOnly, placeholder, onChange, ariaLabelledBy]);

  useEffect(() => {
    const content = viewRef.current?.contentDOM;
    if (!content) return;
    content.setAttribute('aria-invalid', String(Boolean(error)));
    if (error) content.setAttribute('aria-describedby', 'sql-statement-error');
    else content.removeAttribute('aria-describedby');
  }, [error, readOnly, placeholder, onChange, ariaLabelledBy]);

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
      className="border border-input rounded-lg bg-background overflow-hidden text-base focus-within:border-ring focus-within:outline-1 focus-within:outline-offset-0 focus-within:outline-ring sm:text-code"
    />
  );
});
