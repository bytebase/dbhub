import { PlayIcon } from 'lucide-react';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';

interface RunButtonProps {
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
}

export function RunButton({ onClick, disabled = false, loading = false }: RunButtonProps) {
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
        </>
      )}
    </Button>
  );
}
