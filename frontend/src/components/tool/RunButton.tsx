import { useEffect, useRef } from 'react';
import { PlayIcon } from 'lucide-react';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';

interface RunButtonProps {
  onShortcut: () => void;
  disabled?: boolean;
  loading?: boolean;
}

export function RunButton({ onShortcut, disabled = false, loading = false }: RunButtonProps) {
  const onShortcutRef = useRef(onShortcut);
  const disabledRef = useRef(disabled);
  const loadingRef = useRef(loading);

  useEffect(() => {
    onShortcutRef.current = onShortcut;
    disabledRef.current = disabled;
    loadingRef.current = loading;
  }, [onShortcut, disabled, loading]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && (event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        const target = event.target as HTMLElement;
        const isInEditorOrDialog = target.closest('.cm-editor, [role=dialog]') !== null;

        if (!isInEditorOrDialog && !disabledRef.current && !loadingRef.current) {
          event.preventDefault();
          onShortcutRef.current();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
  const shortcutKey = isMac ? '⌘' : 'Ctrl';

  return (
    <Button type="submit" disabled={disabled || loading} aria-busy={loading} className="min-h-11 min-w-40" title={`Run (${shortcutKey}+Enter)`}>
      {loading ? (
        <>
          <Spinner className="size-4" />
          Running...
        </>
      ) : (
        <>
          <PlayIcon className="size-4" />
          Run
          <span className="ml-2 text-xs opacity-80">
            {shortcutKey}+Enter
          </span>
        </>
      )}
    </Button>
  );
}
