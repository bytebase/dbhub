import { useEffect, useRef } from 'react';
import { PlayIcon } from 'lucide-react';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';

interface RunButtonProps {
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
}

export function RunButton({ onClick, disabled = false, loading = false }: RunButtonProps) {
  const onClickRef = useRef(onClick);
  const disabledRef = useRef(disabled);
  const loadingRef = useRef(loading);

  // Keep refs updated
  useEffect(() => {
    onClickRef.current = onClick;
    disabledRef.current = disabled;
    loadingRef.current = loading;
  }, [onClick, disabled, loading]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check for Cmd+Enter (Mac) or Ctrl+Enter (Windows/Linux)
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        // Check if the event originated from CodeMirror editor
        const target = event.target as HTMLElement;
        const isInCodeMirror = target.closest('.cm-editor') !== null;

        // Only handle if NOT in CodeMirror (let SqlEditor handle it when focused)
        if (!isInCodeMirror && !disabledRef.current && !loadingRef.current) {
          event.preventDefault();
          onClickRef.current();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []); // Empty deps - listener is set up once

  // Detect OS for shortcut display
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
  const shortcutKey = isMac ? '⌘' : 'Ctrl';

  return (
    <Button onClick={onClick} disabled={disabled || loading}>
      {loading ? (
        <>
          <Spinner className="size-4" />
          Running...
        </>
      ) : (
        <>
          <PlayIcon className="size-4" />
          Run
          <span className="ml-2 text-xs text-muted-foreground">
            {shortcutKey}+Enter
          </span>
        </>
      )}
    </Button>
  );
}
