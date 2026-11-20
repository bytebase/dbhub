import { useRef, useState, useMemo, useCallback, useId, useLayoutEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';
import type { QueryResult } from '../../api/tools';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Dialog, DialogTrigger, DialogPopup, DialogTitle, DialogDescription, DialogClose } from '../ui/dialog';

interface ResultsTableProps {
  result: QueryResult | null;
  error: string | null;
  onEditQuery: () => void;
  executedSql?: string;
  executionTimeMs?: number;
}

const ROW_HEIGHT = 44;

function formatExecutionTime(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function formatValue(value: unknown, pretty = false): string {
  if (value === null) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value, null, pretty ? 2 : undefined);
  return String(value);
}

function highlightText(text: string, searchTerm: string): React.ReactNode {
  if (!searchTerm) return text;
  const lowerText = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let index = lowerText.indexOf(searchTerm);
  while (index !== -1) {
    if (index > lastIndex) parts.push(text.substring(lastIndex, index));
    parts.push(
      <mark key={index} className="bg-selection text-selection-foreground">
        {text.substring(index, index + searchTerm.length)}
      </mark>
    );
    lastIndex = index + searchTerm.length;
    index = lowerText.indexOf(searchTerm, lastIndex);
  }
  if (lastIndex < text.length) parts.push(text.substring(lastIndex));
  return parts;
}

export function ResultsTable({ result, error, onEditQuery, executedSql, executionTimeMs }: ResultsTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLTableSectionElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const filterId = useId();
  const hintId = useId();
  const [headerHeight, setHeaderHeight] = useState(ROW_HEIGHT + 1);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCell, setSelectedCell] = useState<{ column: string; row: number; value: unknown } | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const query = searchTerm.trim().toLowerCase();

  const columns = useMemo(() => result?.columns.map((name, index) => {
    const values = result.rows.map((row) => row[index]).filter((value) => value !== null && value !== undefined);
    return {
      name,
      numeric: values.length > 0 && values.every((value) => typeof value === 'number'),
      width: Math.min(32, Math.max(12, name.length + 4, ...values.slice(0, 100).map((value) => formatValue(value).length + 4))),
    };
  }) ?? [], [result]);

  const filteredRows = useMemo(() => result?.rows
    .map((values, index) => ({ values, index }))
    .filter(({ values }) => !query || values.some((cell) => formatValue(cell).toLowerCase().includes(query))) ?? [], [result, query]);

  const getItemKey = useCallback((index: number) => filteredRows[index].index, [filteredRows]);

  const rowVirtualizer = useVirtualizer({
    count: filteredRows.length,
    getScrollElement: () => parentRef.current,
    getItemKey,
    estimateSize: () => ROW_HEIGHT + 1,
    measureElement: (element) => element.getBoundingClientRect().height,
    scrollMargin: headerHeight,
    overscan: 10,
  });

  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const observer = new ResizeObserver(() => setHeaderHeight(header.getBoundingClientRect().height));
    observer.observe(header);
    return () => observer.disconnect();
  }, [result, error]);

  const clearFilter = () => {
    setSearchTerm('');
    parentRef.current?.scrollTo({ top: 0, left: 0 });
    filterRef.current?.focus();
  };

  const copyValue = async () => {
    if (!selectedCell) return;
    try {
      await navigator.clipboard.writeText(formatValue(selectedCell.value, true));
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  };

  if (!result && !error) return null;

  if (error || !result || result.rows.length === 0) {
    return (
      <div className="space-y-3">
        <div className="space-y-4 rounded-xl bg-card p-4 sm:p-6">
          <div role={error ? 'alert' : 'status'} className="flex items-start gap-3">
            {error ? <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive-foreground" aria-hidden="true" />
              : <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-query-complete" aria-hidden="true" />}
            <div className="min-w-0 space-y-2">
              <h3 className="text-label">{error ? 'Query failed' : 'Query completed'}</h3>
              <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
                {error || (result && result.rowCount > 0
                  ? `${result.rowCount} row${result.rowCount === 1 ? '' : 's'} affected.`
                  : 'No rows returned.')}
              </p>
              {error && <p className="text-caption text-muted-foreground">Review the statement and parameters before running it again.</p>}
              {executionTimeMs !== undefined && <p className="text-caption tabular-nums text-muted-foreground">{formatExecutionTime(executionTimeMs)}</p>}
            </div>
          </div>
          {error && <Button variant="outline" className="min-h-11" onClick={onEditQuery}>Edit query</Button>}
        </div>
        <ExecutedSql sql={executedSql} />
      </div>
    );
  }

  const gridTemplateColumns = `3.5rem ${columns.map((column) => `minmax(${column.width}ch, 1fr)`).join(' ')}`;
  const minWidth = `calc(3.5rem + ${columns.reduce((sum, column) => sum + column.width, 0)}ch)`;

  return (
    <Dialog onOpenChange={() => setCopyState('idle')}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="w-full space-y-1.5 sm:w-64">
            <label htmlFor={filterId} className="text-label">Filter results</label>
            <input
              ref={filterRef}
              id={filterId}
              type="search"
              placeholder="Search all columns…"
              value={searchTerm}
              onChange={(event) => {
                setSearchTerm(event.target.value);
                parentRef.current?.scrollTo({ top: 0, left: 0 });
              }}
              className="min-h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:text-sm"
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pb-2 text-caption tabular-nums text-muted-foreground">
            <span role="status">{query ? `${filteredRows.length} of ${result.rowCount}` : result.rowCount} {result.rowCount === 1 ? 'row' : 'rows'}</span>
            {executionTimeMs !== undefined && <span className="whitespace-nowrap">{formatExecutionTime(executionTimeMs)}</span>}
          </div>
        </div>

        <div ref={parentRef} role="region" aria-label="Query results" tabIndex={0} aria-describedby={hintId}
          className="isolate max-h-[min(28rem,60dvh)] overflow-auto rounded-lg border border-border bg-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          <table aria-label="Query result data" aria-rowcount={filteredRows.length + 1} aria-colcount={columns.length + 1}
            className="grid w-full border-separate border-spacing-0 font-mono text-code" style={{ minWidth }}>
            <thead ref={headerRef} className="sticky top-0 z-20 grid bg-muted">
              <tr className="grid border-b border-border" style={{ gridTemplateColumns }}>
                <th scope="col" className="sticky start-0 z-10 flex min-h-11 items-center justify-end border-e border-border bg-muted px-3 text-caption font-normal text-muted-foreground"><span aria-hidden="true">#</span><span className="sr-only">Row</span></th>
                {columns.map((column, index) => (
                  <th key={index} scope="col" title={column.name}
                    className={cn('flex min-h-11 min-w-0 items-center border-e border-border-subtle px-3 py-2 text-label last:border-e-0', column.numeric ? 'justify-end text-end' : 'text-start')}>
                    <span className="truncate">{column.name}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="relative grid" style={{ height: rowVirtualizer.getTotalSize() }}>
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const row = filteredRows[virtualRow.index];
                return (
                  <tr key={virtualRow.key} data-index={virtualRow.index} aria-rowindex={virtualRow.index + 2} ref={rowVirtualizer.measureElement}
                    className="group absolute grid w-full border-b border-border-subtle hover:bg-muted last:border-b-0"
                    style={{ gridTemplateColumns, transform: `translateY(${virtualRow.start - headerHeight}px)` }}>
                    <th scope="row" className="sticky start-0 z-10 flex min-h-11 items-center justify-end border-e border-border bg-card px-3 text-caption font-normal tabular-nums text-muted-foreground group-hover:bg-muted">{row.index + 1}</th>
                    {columns.map((column, cellIndex) => {
                      const cell = row.values[cellIndex];
                      const text = formatValue(cell);
                      return (
                        <td key={cellIndex} className="min-w-0 border-e border-border-subtle last:border-e-0">
                          <DialogTrigger
                            render={<button type="button" />}
                            onClick={() => setSelectedCell({ column: column.name, row: row.index + 1, value: cell })}
                            title={`View ${column.name}, row ${row.index + 1}`}
                            className={cn('block min-h-11 w-full cursor-pointer truncate px-3 py-2 touch-manipulation hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring', column.numeric ? 'text-end tabular-nums' : 'text-start', (cell === null || cell === '') && 'text-muted-foreground')}>
                            {cell === '' ? <span className="text-caption">Empty string</span> : highlightText(text, query)}
                          </DialogTrigger>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filteredRows.length === 0 && (
            <div className="space-y-2 p-6 text-center">
              <p className="text-label">No matching rows</p>
              <p className="text-sm text-muted-foreground">Try a different search or clear the filter.</p>
              <Button variant="outline" className="min-h-11" onClick={clearFilter}>Clear filter</Button>
            </div>
          )}
        </div>
        <p id={hintId} className="text-caption text-muted-foreground">Select a cell to view and copy its full value.</p>
        <ExecutedSql sql={executedSql} />
      </div>
      <DialogPopup showCloseButton={false} bottomStickOnMobile={false} className="max-w-2xl motion-reduce:transition-none">
        <div className="flex items-start justify-between gap-4 border-b-[length:var(--border-hairline)] border-border p-4">
          <div className="min-w-0 space-y-1">
            <DialogTitle className="text-section">Cell value</DialogTitle>
            <DialogDescription className="font-mono text-caption [overflow-wrap:anywhere]">Row {selectedCell?.row} · {selectedCell?.column}</DialogDescription>
          </div>
          <DialogClose render={<Button variant="ghost" size="icon-xl" className="min-h-11 min-w-11" aria-label="Close cell value" />}><X aria-hidden="true" /></DialogClose>
        </div>
        <div tabIndex={0} role="region" aria-label="Full cell value" className="max-h-[50dvh] overflow-auto p-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
          <pre className="font-mono text-code whitespace-pre-wrap [overflow-wrap:anywhere]">{selectedCell?.value === '' ? 'Empty string (0 characters)' : selectedCell && formatValue(selectedCell.value, true)}</pre>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t-[length:var(--border-hairline)] border-border p-4">
          <span role="status" className="text-caption text-muted-foreground">{copyState === 'copied' ? 'Copied to clipboard' : copyState === 'error' ? 'Could not copy. Select the value and copy it manually.' : ''}</span>
          <Button variant="outline" className="min-h-11" onClick={copyValue}>Copy value</Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function ExecutedSql({ sql }: { sql?: string }) {
  if (!sql) return null;
  return (
    <details className="text-caption text-muted-foreground">
      <summary className="w-fit cursor-pointer rounded-sm py-2 touch-manipulation focus-visible:outline-2 focus-visible:outline-ring">Executed SQL</summary>
      <pre className="mt-1 max-h-40 overflow-auto rounded-md border border-border bg-muted p-3 font-mono text-code whitespace-pre-wrap [overflow-wrap:anywhere]">{sql}</pre>
    </details>
  );
}
