import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { QueryResult } from '../../api/tools';

interface ResultsTableProps {
  result: QueryResult | null;
  error: string | null;
  isLoading?: boolean;
}

const ROW_HEIGHT = 36;

export function ResultsTable({ result, error, isLoading }: ResultsTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: result?.rows.length ?? 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  // Loading state
  if (isLoading) {
    return (
      <div className="border border-border rounded-lg bg-card p-8 text-center">
        <div className="text-muted-foreground">Running query...</div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="border border-destructive/20 rounded-lg bg-destructive/10 p-4">
        <p className="text-destructive text-sm">{error}</p>
      </div>
    );
  }

  // No query run yet
  if (!result) {
    return (
      <div className="border border-border rounded-lg bg-card p-8 text-center">
        <p className="text-muted-foreground text-sm">
          Run a query to see results
        </p>
      </div>
    );
  }

  // No results
  if (result.rows.length === 0) {
    return (
      <div className="border border-border rounded-lg bg-card p-8 text-center">
        <p className="text-muted-foreground text-sm">No results returned</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-sm text-muted-foreground">
        {result.rowCount} row{result.rowCount !== 1 ? 's' : ''}
      </div>
      <div className="border border-border rounded-lg overflow-hidden">
        {/* Header */}
        <div className="flex bg-muted/50 border-b border-border">
          {result.columns.map((col) => (
            <div
              key={col}
              className="flex-1 min-w-[120px] px-3 py-2 text-sm font-medium text-foreground truncate"
            >
              {col}
            </div>
          ))}
        </div>

        {/* Virtualized body */}
        <div
          ref={parentRef}
          className="max-h-[400px] overflow-auto bg-card"
        >
          <div
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = result.rows[virtualRow.index];
              return (
                <div
                  key={virtualRow.index}
                  className="flex absolute w-full border-b border-border/50 last:border-b-0"
                  style={{
                    height: `${ROW_HEIGHT}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {row.map((cell, cellIndex) => (
                    <div
                      key={cellIndex}
                      className="flex-1 min-w-[120px] px-3 py-2 text-sm text-foreground truncate font-mono"
                      title={String(cell ?? '')}
                    >
                      {cell === null ? (
                        <span className="text-muted-foreground italic">NULL</span>
                      ) : (
                        String(cell)
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
