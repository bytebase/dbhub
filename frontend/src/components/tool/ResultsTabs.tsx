import { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { AlertCircle, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import { ResultsTable } from './ResultsTable';
import type { ResultTab } from './types';
import { Spinner } from '../ui/spinner';
import XIcon from '../icons/XIcon';

interface ResultsTabsProps {
  tabs: ResultTab[];
  activeTabId: string | null;
  onTabSelect: (id: string) => void;
  onTabClose: (id: string) => void;
  isLoading?: boolean;
  onEditQuery: () => void;
}

function formatTimestamp(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatTabLabel(tab: ResultTab): string {
  const time = formatTimestamp(tab.timestamp);
  if (tab.statementTotal && tab.statementTotal > 1) {
    return `${time} (${tab.statementIndex}/${tab.statementTotal})`;
  }
  return time;
}

export function ResultsTabs({
  tabs,
  activeTabId,
  onTabSelect,
  onTabClose,
  isLoading,
  onEditQuery,
}: ResultsTabsProps) {
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId),
    [tabs, activeTabId]
  );

  const updateScrollButtons = useCallback(() => {
    const container = tabsContainerRef.current;
    if (!container) return;

    const { scrollLeft, scrollWidth, clientWidth } = container;
    setCanScrollLeft(scrollLeft > 0);
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1);
  }, []);

  useEffect(() => {
    updateScrollButtons();
    window.addEventListener('resize', updateScrollButtons);
    return () => window.removeEventListener('resize', updateScrollButtons);
  }, [updateScrollButtons, tabs]);

  const scroll = (direction: 'left' | 'right') => {
    const container = tabsContainerRef.current;
    if (!container) return;

    const scrollAmount = 150;
    container.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth',
    });
  };

  const progress = (
    <div role="status" className={cn("flex items-center gap-3 rounded-xl bg-card shadow-sm", tabs.length ? "p-4" : "min-h-32 p-6")}>
      <Spinner aria-hidden="true" role="presentation" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-label">Running query…</p>
        <p className="text-caption text-muted-foreground">
          {tabs.length ? 'Previous results remain available below.' : 'Waiting for the database to respond.'}
        </p>
      </div>
    </div>
  );

  if (tabs.length === 0) {
    return isLoading ? progress : (
      <div className="flex min-h-32 flex-col justify-center gap-2 rounded-xl bg-card p-6 shadow-sm">
        <h2 className="text-label">Results appear here</h2>
        <p className="max-w-prose text-sm text-muted-foreground">Enter a SQL statement or fill in the tool parameters, then select Run.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {isLoading && progress}
      {/* Tab bar */}
      <div className="relative flex items-center border-b border-border">
        {/* Left scroll button */}
        {canScrollLeft && (
          <button
            type="button"
            onClick={() => scroll('left')}
            className="absolute left-0 z-10 flex items-center justify-center w-6 h-full bg-background hover:bg-muted cursor-pointer"
            aria-label="Scroll tabs left"
          >
            <ChevronLeftIcon className="w-4 h-4 text-muted-foreground" />
          </button>
        )}

        {/* Tabs container */}
        <div
          ref={tabsContainerRef}
          onScroll={updateScrollButtons}
          className={cn(
            "flex items-center gap-1 overflow-hidden",
            canScrollLeft && "pl-6",
            canScrollRight && "pr-6"
          )}
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabSelect(tab.id)}
              className={cn(
                'group flex items-center gap-1.5 px-3 py-1.5 text-caption tabular-nums whitespace-nowrap',
                'border-b-2 -mb-px transition-colors cursor-pointer',
                tab.id === activeTabId
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              <span>{formatTabLabel(tab)}</span>
              {tab.error && (
                <><AlertCircle className="size-3.5 text-destructive-foreground" aria-hidden="true" /><span className="sr-only">Failed</span></>
              )}
              <span
                role="button"
                tabIndex={0}
                aria-label="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  onTabClose(tab.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.stopPropagation();
                    onTabClose(tab.id);
                  }
                }}
                className="opacity-0 group-hover:opacity-100 hover:bg-muted rounded p-0.5 transition-opacity"
              >
                <XIcon className="w-3 h-3" />
              </span>
            </button>
          ))}
        </div>

        {/* Right scroll button */}
        {canScrollRight && (
          <button
            type="button"
            onClick={() => scroll('right')}
            className="absolute right-0 z-10 flex items-center justify-center w-6 h-full bg-background hover:bg-muted cursor-pointer"
            aria-label="Scroll tabs right"
          >
            <ChevronRightIcon className="w-4 h-4 text-muted-foreground" />
          </button>
        )}
      </div>

      {/* Active tab content */}
      {activeTab && (
        <ResultsTable
          key={activeTab.id}
          result={activeTab.result}
          error={activeTab.error}
          onEditQuery={onEditQuery}
          executedSql={activeTab.executedSql}
          executionTimeMs={activeTab.executionTimeMs}
        />
      )}
    </div>
  );
}
