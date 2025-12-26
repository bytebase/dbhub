import { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import { ResultsTable } from './ResultsTable';
import type { ResultTab } from './types';
import XIcon from '../icons/XIcon';

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

export function ResultsTabs({
  tabs,
  activeTabId,
  onTabSelect,
  onTabClose,
  isLoading,
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
                'group flex items-center gap-1.5 px-3 py-1.5 text-sm whitespace-nowrap',
                'border-b-2 -mb-px transition-colors cursor-pointer',
                tab.id === activeTabId
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              <span>{formatTimestamp(tab.timestamp)}</span>
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
          result={activeTab.result}
          error={activeTab.error}
          isLoading={isLoading}
          executedSql={activeTab.executedSql}
          executionTimeMs={activeTab.executionTimeMs}
        />
      )}
    </div>
  );
}
