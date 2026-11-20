import { useMemo, useRef, useState, useLayoutEffect, useCallback, useId, type KeyboardEvent } from 'react';
import { AlertCircle, Table2, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
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
    return `${time} · ${tab.statementIndex} of ${tab.statementTotal}`;
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
  const id = useId();
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<string | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId),
    [tabs, activeTabId]
  );

  const updateScrollButtons = useCallback(() => {
    const container = tabsContainerRef.current;
    if (!container) return;
    setCanScrollLeft(container.scrollLeft > 1);
    setCanScrollRight(container.scrollLeft + container.clientWidth < container.scrollWidth - 1);
  }, []);

  const revealTab = useCallback((tabId: string) => {
    const container = tabsContainerRef.current;
    const item = tabRefs.current.get(tabId)?.parentElement;
    if (!container || !item) return;
    const bounds = container.getBoundingClientRect();
    const tabBounds = item.getBoundingClientRect();
    const offset = tabBounds.left < bounds.left ? tabBounds.left - bounds.left
      : tabBounds.right > bounds.right ? tabBounds.right - bounds.right : 0;
    if (offset) container.scrollLeft += offset;
  }, []);

  useLayoutEffect(() => {
    const container = tabsContainerRef.current;
    if (!container) return;
    if (pendingFocus.current) {
      tabRefs.current.get(pendingFocus.current)?.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
    const update = () => {
      if (activeTabId) revealTab(activeTabId);
      updateScrollButtons();
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [activeTabId, tabs, revealTab, updateScrollButtons]);

  const closeTab = (tabId: string) => {
    const index = tabs.findIndex(tab => tab.id === tabId);
    const remaining = tabs.filter(tab => tab.id !== tabId);
    pendingFocus.current = tabId === activeTabId
      ? remaining[Math.min(index, remaining.length - 1)]?.id ?? null
      : activeTabId;
    onTabClose(tabId);
    if (!remaining.length) onEditQuery();
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowRight': nextIndex = (index + 1) % tabs.length; break;
      case 'ArrowLeft': nextIndex = (index - 1 + tabs.length) % tabs.length; break;
      case 'Home': nextIndex = 0; break;
      case 'End': nextIndex = tabs.length - 1; break;
      case 'Delete':
        event.preventDefault();
        closeTab(tabs[index].id);
        return;
      default: return;
    }
    event.preventDefault();
    const nextTab = tabs[nextIndex];
    tabRefs.current.get(nextTab.id)?.focus({ preventScroll: true });
    revealTab(nextTab.id);
    onTabSelect(nextTab.id);
  };

  const scroll = (direction: 'left' | 'right') => {
    const container = tabsContainerRef.current;
    if (!container) return;
    container.scrollBy({
      left: (direction === 'left' ? -1 : 1) * container.clientWidth * 0.75,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  };

  const progress = (
    <div role="status" className={cn("flex items-center gap-3 rounded-xl bg-card", tabs.length ? "p-4" : "min-h-32 p-6")}>
      <Spinner aria-hidden="true" role="presentation" className="mt-0.5 size-4 shrink-0 text-brand-accent" />
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
      <div className="flex min-h-32 flex-col justify-center gap-2 rounded-xl bg-card p-6">
        <Table2 aria-hidden="true" className="mb-1 size-5 text-brand-accent" />
        <h2 className="text-label">Results appear here</h2>
        <p className="max-w-prose text-sm text-muted-foreground">Enter a SQL statement or fill in the tool parameters, then select Run.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {isLoading && progress}
      <div className="flex min-w-0 items-start border-b border-border">
        {(canScrollLeft || canScrollRight) && (
          <button type="button" onClick={() => scroll('left')} disabled={!canScrollLeft}
            className="hidden min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:text-disabled-foreground disabled:cursor-default sm:flex touch-manipulation"
            aria-label="Scroll result tabs left" aria-controls={`${id}-list`}>
            <ChevronLeftIcon className="size-4" aria-hidden="true" />
          </button>
        )}
        <div ref={tabsContainerRef} id={`${id}-list`} role="tablist" aria-label="Query results"
          onScroll={updateScrollButtons}
          className="flex min-w-0 flex-1 items-stretch overflow-x-auto overscroll-x-contain [scrollbar-width:thin]">
          {tabs.map((tab, index) => {
            const selected = tab.id === activeTabId;
            const label = `Result at ${formatTimestamp(tab.timestamp)}${tab.statementTotal && tab.statementTotal > 1 ? `, statement ${tab.statementIndex} of ${tab.statementTotal}` : ''}${tab.error ? ', failed' : ''}`;
            return (
              <div key={tab.id} role="presentation" className={cn('flex shrink-0 items-stretch border-b-2', selected ? 'border-primary bg-selection/50' : 'border-transparent')}>
                <button type="button" role="tab" id={`${id}-tab-${tab.id}`} aria-controls={`${id}-panel-${tab.id}`}
                  aria-selected={selected} aria-label={label} title={label} tabIndex={selected ? 0 : -1}
                  ref={node => { if (node) tabRefs.current.set(tab.id, node); else tabRefs.current.delete(tab.id); }}
                  onClick={() => onTabSelect(tab.id)} onKeyDown={event => handleTabKeyDown(event, index)}
                  onFocus={() => revealTab(tab.id)}
                  className={cn('flex min-h-11 min-w-11 items-center gap-2 whitespace-nowrap px-3 text-caption tabular-nums touch-manipulation hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring', selected ? 'text-foreground' : 'text-muted-foreground')}>
                  <span>{formatTabLabel(tab)}</span>
                  {tab.error && <span className="flex items-center gap-1 text-destructive-foreground"><AlertCircle className="size-3.5" aria-hidden="true" />Failed</span>}
                </button>
                <button type="button" tabIndex={selected ? 0 : -1} onClick={() => closeTab(tab.id)}
                  aria-label={`Close ${label.toLowerCase()}`} title="Close result (Delete when tab is focused)"
                  className="flex min-h-11 min-w-11 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring touch-manipulation">
                  <XIcon className="size-3.5" aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
        {(canScrollLeft || canScrollRight) && (
          <button type="button" onClick={() => scroll('right')} disabled={!canScrollRight}
            className="hidden min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:text-disabled-foreground disabled:cursor-default sm:flex touch-manipulation"
            aria-label="Scroll result tabs right" aria-controls={`${id}-list`}>
            <ChevronRightIcon className="size-4" aria-hidden="true" />
          </button>
        )}
      </div>
      {tabs.map(tab => (
        <div key={tab.id} role="tabpanel" id={`${id}-panel-${tab.id}`} aria-labelledby={`${id}-tab-${tab.id}`}
          hidden={tab.id !== activeTabId} tabIndex={0}
          className="min-w-0 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          {tab.id === activeTabId && activeTab && (
            <ResultsTable result={activeTab.result} error={activeTab.error} onEditQuery={onEditQuery}
              executedSql={activeTab.executedSql} executionTimeMs={activeTab.executionTimeMs} />
          )}
        </div>
      ))}
    </div>
  );
}
