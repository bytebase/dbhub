import { AlertCircle } from 'lucide-react';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { Skeleton } from './ui/skeleton';

export function PageLoading({ label, layout = 'details' }: { label: string; layout?: 'details' | 'table' }) {
  return (
    <div className={cn("container mx-auto space-y-6 px-4 py-6 sm:px-8 sm:py-10", layout === 'table' ? "max-w-6xl" : "max-w-4xl")} role="status" aria-label={label}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="space-y-3">
        <Skeleton className="h-7 w-48 max-w-full" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div aria-hidden="true" className="space-y-6 rounded-xl bg-card p-4 shadow-sm sm:p-6">
        {layout === 'table' ? (
          <div className="space-y-5">
            {Array.from({ length: 7 }, (_, row) => (
              <div key={row} className="grid grid-cols-[1fr_2fr_1fr] gap-4">
                {Array.from({ length: 3 }, (_, column) => <Skeleton key={column} className="h-4 w-full" />)}
              </div>
            ))}
          </div>
        ) : (
          <>
            <Skeleton className="h-5 w-32" />
            <div className="grid gap-6 sm:grid-cols-2">
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index} className="space-y-3">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-5 w-full" />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function PageLoadError({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return (
    <div className="container mx-auto max-w-4xl px-4 py-6 sm:px-8 sm:py-10">
      <div className="space-y-4 rounded-xl bg-card p-4 shadow-sm sm:p-6">
        <div role="alert" className="flex items-start gap-3">
          <AlertCircle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-destructive-foreground" />
          <div className="min-w-0 space-y-2">
            <h1 className="text-section">{title}</h1>
            <p className="max-w-prose text-sm text-muted-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">{message}</p>
          </div>
        </div>
        <Button variant="outline" className="min-h-11" onClick={event => { event.currentTarget.closest('main')?.focus(); onRetry(); }}>Try again</Button>
      </div>
    </div>
  );
}
