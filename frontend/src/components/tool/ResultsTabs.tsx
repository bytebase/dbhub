import { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { cn } from '../../lib/utils';
import { ResultsTable } from './ResultsTable';
import type { ResultTab } from './types';
import XIcon from '../icons/XIcon';
import ChevronLeftIcon from '../icons/ChevronLeftIcon';
import ChevronRightIcon from '../icons/ChevronRightIcon';

interface ResultsTabsProps {
  tabs: ResultTab[];
  activeTabId: string | null;
  onTabSelect: (id: string) => void;
  onTabClose: (id: string) => void;
  isLoading?: boolean;
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
  return formatTimestamp(tab.timestamp);
}

const SCROLL_AMOUNT = 150;

export function ResultsTabs({
  tabs,
  activeTabId,
  onTabSelect,
  onTabClose,
  isLoading,
}: ResultsTabsProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId),
    [tabs, activeTabId]
  );

  const updateScrollButtons = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    setCanScrollLeft(container.scrollLeft > 0);
    setCanScrollRight(
      container.scrollLeft < container.scrollWidth - container.clientWidth - 1
    );
  }, []);

  useEffect(() => {
    updateScrollButtons();
    const container = scrollContainerRef.current;
    if (!container) return;

    container.addEventListener('scroll', updateScrollButtons);
    window.addEventListener('resize', updateScrollButtons);

    return () => {
      container.removeEventListener('scroll', updateScrollButtons);
      window.removeEventListener('resize', updateScrollButtons);
    };
  }, [updateScrollButtons, tabs]);

  const scrollLeft = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollBy({ left: -SCROLL_AMOUNT, behavior: 'smooth' });
  }, []);

  const scrollRight = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollBy({ left: SCROLL_AMOUNT, behavior: 'smooth' });
  }, []);

  // Loading state (no tabs yet)
  if (isLoading && tabs.length === 0) {
    return (
      <div className="border border-border rounded-lg bg-card p-8 text-center">
        <div className="text-muted-foreground">Running query...</div>
      </div>
    );
  }

  // Empty state
  if (tabs.length === 0) {
    return (
      <div className="border border-border rounded-lg bg-card p-8 text-center">
        <p className="text-muted-foreground text-sm">
          Run a query to see results
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Tab bar with scroll buttons */}
      <div className="relative flex items-center border-b border-border">
        {/* Left scroll button */}
        {canScrollLeft && (
          <button
            type="button"
            onClick={scrollLeft}
            className="absolute left-0 z-10 flex items-center justify-center w-6 h-full bg-gradient-to-r from-background via-background to-transparent pr-2 cursor-pointer"
            aria-label="Scroll tabs left"
          >
            <ChevronLeftIcon className="w-4 h-4 text-muted-foreground hover:text-foreground" />
          </button>
        )}

        {/* Scrollable tab container */}
        <div
          ref={scrollContainerRef}
          className={cn(
            'flex items-center gap-1 overflow-x-auto scrollbar-none',
            canScrollLeft && 'pl-6',
            canScrollRight && 'pr-6'
          )}
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabSelect(tab.id)}
              className={cn(
                'group flex items-center gap-1.5 px-3 py-1.5 text-sm whitespace-nowrap',
                'border-b-2 -mb-px transition-colors cursor-pointer',
                tab.id === activeTabId
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              <span>{formatTabLabel(tab)}</span>
              {tab.error && (
                <span className="w-1.5 h-1.5 rounded-full bg-destructive" aria-label="Error" />
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
            onClick={scrollRight}
            className="absolute right-0 z-10 flex items-center justify-center w-6 h-full bg-gradient-to-l from-background via-background to-transparent pl-2 cursor-pointer"
            aria-label="Scroll tabs right"
          >
            <ChevronRightIcon className="w-4 h-4 text-muted-foreground hover:text-foreground" />
          </button>
        )}
      </div>

      {/* Active tab content */}
      {activeTab && (
        <ResultsTable
          result={activeTab.result}
          error={activeTab.error}
          isLoading={isLoading}
          executionTimeMs={activeTab.executionTimeMs}
        />
      )}
    </div>
  );
}
