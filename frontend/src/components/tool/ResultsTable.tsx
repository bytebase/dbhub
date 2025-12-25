import { useRef, useState, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { QueryResult } from '../../api/tools';

interface ResultsTableProps {
  result: QueryResult | null;
  error: string | null;
  isLoading?: boolean;
  executedSql?: string;
  executionTimeMs?: number;
}

const ROW_HEIGHT = 36;

function formatExecutionTime(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  return `${(ms / 1000).toFixed(2)} s`;
}

function highlightText(text: string, searchTerm: string): React.ReactNode {
  if (!searchTerm.trim()) {
    return text;
  }

  const lowerText = text.toLowerCase();
  const lowerSearchTerm = searchTerm.toLowerCase();
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  let index = lowerText.indexOf(lowerSearchTerm);
  while (index !== -1) {
    // Add text before match
    if (index > lastIndex) {
      parts.push(text.substring(lastIndex, index));
    }
    // Add highlighted match
    parts.push(
      <mark key={index} className="bg-amber-200/50 text-foreground">
        {text.substring(index, index + lowerSearchTerm.length)}
      </mark>
    );
    lastIndex = index + lowerSearchTerm.length;
    index = lowerText.indexOf(lowerSearchTerm, lastIndex);
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }

  return parts;
}

export function ResultsTable({ result, error, isLoading, executedSql, executionTimeMs }: ResultsTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [searchTerm, setSearchTerm] = useState('');

  // Filter rows based on search term
  const filteredRows = useMemo(() => {
    if (!result || !searchTerm.trim()) {
      return result?.rows ?? [];
    }

    const lowerSearchTerm = searchTerm.toLowerCase();
    return result.rows.filter((row) =>
      row.some((cell) => {
        if (cell === null) return false;
        return String(cell).toLowerCase().includes(lowerSearchTerm);
      })
    );
  }, [result, searchTerm]);

  const rowVirtualizer = useVirtualizer({
    count: filteredRows.length,
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

  // No rows returned - could be empty SELECT or successful INSERT/UPDATE/DELETE
  if (result.rows.length === 0) {
    return (
      <div className="border border-border rounded-lg bg-card p-8 text-center">
        <p className="text-muted-foreground text-sm">
          {result.rowCount > 0
            ? `${result.rowCount} row${result.rowCount !== 1 ? 's' : ''} affected`
            : 'No results returned'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <input
          type="text"
          placeholder="Filter results..."
          aria-label="Filter table results"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="text-sm px-3 py-1 border border-border rounded bg-card text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring w-64"
        />
        <div className="text-sm text-muted-foreground">
          {searchTerm.trim() && filteredRows.length !== result.rowCount
            ? `${filteredRows.length} of ${result.rowCount} row${result.rowCount !== 1 ? 's' : ''}`
            : `${result.rowCount} row${result.rowCount !== 1 ? 's' : ''}`}
        </div>
      </div>
      <div className="border border-border rounded-lg overflow-hidden">
        {/* Header */}
        <div className="flex bg-muted/50 border-b border-border">
          <div className="w-16 px-3 py-2 text-sm font-medium text-foreground flex-shrink-0">
          </div>
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
              const row = filteredRows[virtualRow.index];
              return (
                <div
                  key={virtualRow.index}
                  className="flex absolute w-full border-b border-border/50 last:border-b-0"
                  style={{
                    height: `${ROW_HEIGHT}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <div className="w-16 px-3 py-2 text-sm text-muted-foreground flex-shrink-0">
                    {virtualRow.index + 1}
                  </div>
                  {row.map((cell, cellIndex) => (
                    <div
                      key={cellIndex}
                      className="flex-1 min-w-[120px] px-3 py-2 text-sm text-foreground truncate font-mono"
                      title={String(cell ?? '')}
                    >
                      {cell === null ? (
                        <span className="text-muted-foreground italic">NULL</span>
                      ) : (
                        highlightText(String(cell), searchTerm)
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {executedSql && executionTimeMs !== undefined && (
        <div className="flex justify-between items-center text-sm text-muted-foreground">
          <span>{executedSql}</span>
          <span>Executed in {formatExecutionTime(executionTimeMs)}</span>
        </div>
      )}
    </div>
  );
}
