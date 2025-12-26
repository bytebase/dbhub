import { useMemo } from 'react';
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
}: ResultsTabsProps) {
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId),
    [tabs, activeTabId]
  );

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
      <div className="flex items-center gap-1 border-b border-border overflow-x-auto">
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
