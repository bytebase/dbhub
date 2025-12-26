import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Tooltip, TooltipTrigger, TooltipPopup, TooltipProvider } from '@/components/ui/tooltip';
import { fetchRequests } from '../../api/requests';
import { fetchSources } from '../../api/sources';
import { ApiError } from '../../api/errors';
import { DB_LOGOS } from '../../lib/db-logos';
import LockIcon from '../icons/LockIcon';
import type { Request } from '../../types/request';
import type { DatabaseType } from '../../types/datasource';

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDate(timestamp: string): string {
  const date = new Date(timestamp);
  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();

  if (isToday) {
    return 'Today';
  }

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function parseUserAgent(ua: string): string {
  // Check for common browsers in order of specificity
  // Edge (Chromium-based)
  const edgeMatch = ua.match(/Edg(?:e|A|iOS)?\/(\d+)/);
  if (edgeMatch) return `Edge ${edgeMatch[1]}`;

  // Opera
  const operaMatch = ua.match(/(?:OPR|Opera)\/(\d+)/);
  if (operaMatch) return `Opera ${operaMatch[1]}`;

  // Chrome (must check after Edge/Opera since they include Chrome in UA)
  const chromeMatch = ua.match(/Chrome\/(\d+)/);
  if (chromeMatch && !ua.includes('Edg') && !ua.includes('OPR')) {
    return `Chrome ${chromeMatch[1]}`;
  }

  // Safari (must check after Chrome since Chrome includes Safari in UA)
  const safariMatch = ua.match(/Version\/(\d+(?:\.\d+)?)\s+Safari/);
  if (safariMatch) return `Safari ${safariMatch[1]}`;

  // Firefox
  const firefoxMatch = ua.match(/Firefox\/(\d+)/);
  if (firefoxMatch) return `Firefox ${firefoxMatch[1]}`;

  // Claude Desktop / Electron apps
  if (ua.includes('Claude')) return 'Claude Desktop';
  if (ua.includes('Electron')) return 'Electron App';

  // Cursor
  if (ua.includes('Cursor')) return 'Cursor';

  // Generic fallback - try to extract something useful
  const genericMatch = ua.match(/^(\w+)\/[\d.]+/);
  if (genericMatch) return genericMatch[1];

  return ua.length > 20 ? ua.substring(0, 20) + '...' : ua;
}

function SqlTooltip({ sql, children }: { sql: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup
        className="whitespace-pre-wrap break-all max-w-md"
        sideOffset={5}
      >
        {sql}
      </TooltipPopup>
    </Tooltip>
  );
}

function ErrorTooltip({ error, children }: { error: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup
        className="whitespace-pre-wrap break-all max-w-md"
        sideOffset={5}
        side="top"
        align="end"
      >
        {error}
      </TooltipPopup>
    </Tooltip>
  );
}

function StatusBadge({ success, error }: { success: boolean; error?: string }) {
  if (success) {
    return (
      <span className="inline-flex items-center justify-center w-4 h-4 text-green-600 dark:text-green-400">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </span>
    );
  }

  const errorIcon = (
    <span className="inline-flex items-center justify-center w-4 h-4 text-red-600 dark:text-red-400 cursor-help">
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
      </svg>
    </span>
  );

  if (error) {
    return <ErrorTooltip error={error}>{errorIcon}</ErrorTooltip>;
  }

  return errorIcon;
}

export default function RequestView() {
  const [requests, setRequests] = useState<Request[]>([]);
  const [sourceTypes, setSourceTypes] = useState<Record<string, DatabaseType>>({});
  const [toolReadonly, setToolReadonly] = useState<Record<string, boolean>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchRequests(), fetchSources()])
      .then(([requestsData, sourcesData]) => {
        setRequests(requestsData.requests);
        const typeMap: Record<string, DatabaseType> = {};
        const readonlyMap: Record<string, boolean> = {};
        for (const source of sourcesData) {
          typeMap[source.id] = source.type;
          for (const tool of source.tools) {
            if (tool.readonly) {
              readonlyMap[tool.name] = true;
            }
          }
        }
        setSourceTypes(typeMap);
        setToolReadonly(readonlyMap);
        setIsLoading(false);
      })
      .catch((err) => {
        console.error('Failed to fetch data:', err);
        const message = err instanceof ApiError ? err.message : 'Failed to load data';
        setError(message);
        setIsLoading(false);
      });
  }, []);

  // Get unique source IDs from requests
  const sourceIds = [...new Set(requests.map((r) => r.sourceId))].sort();

  // Filter requests based on selected source
  const filteredRequests = selectedSource
    ? requests.filter((r) => r.sourceId === selectedSource)
    : requests;

  if (isLoading) {
    return (
      <div className="container mx-auto px-8 py-12">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto px-8 py-12">
        <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-destructive mb-2">Error</h2>
          <p className="text-destructive/90">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider>
    <div className="container mx-auto px-8 py-12 max-w-6xl">
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-foreground mb-2">Recent Requests</h1>
          <p className="text-muted-foreground text-sm">
            Up to 100 requests per source
          </p>
        </div>

        {requests.length > 0 && (
          <>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setSelectedSource(null)}
                className={`px-3 py-1 text-sm font-medium rounded-full transition-colors ${
                  selectedSource === null
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                }`}
              >
                All ({requests.length})
              </button>
              {sourceIds.map((sourceId) => {
                const count = requests.filter((r) => r.sourceId === sourceId).length;
                const dbType = sourceTypes[sourceId];
                return (
                  <button
                    key={sourceId}
                    onClick={() => setSelectedSource(sourceId)}
                    className={`px-3 py-1 text-sm font-medium rounded-full transition-colors flex items-center gap-1.5 ${
                      selectedSource === sourceId
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                    }`}
                  >
                    {dbType && (
                      <img
                        src={DB_LOGOS[dbType]}
                        alt={`${dbType} logo`}
                        className="w-4 h-4"
                      />
                    )}
                    {sourceId} ({count})
                  </button>
                );
              })}
            </div>
            <div className="bg-card border border-border rounded-lg overflow-x-auto">
              <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                    Time
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                    Tool
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider w-full">
                    SQL
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                    Result
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                    Client
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredRequests.map((request) => (
                  <tr key={request.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-2 text-sm text-muted-foreground whitespace-nowrap">
                      {formatDate(request.timestamp)} {formatTime(request.timestamp)}
                    </td>
                    <td className="px-4 py-2 text-sm whitespace-nowrap">
                      <Link
                        to={`/source/${request.sourceId}`}
                        className="text-primary hover:underline inline-flex items-center gap-1"
                      >
                        {request.toolName}
                        {toolReadonly[request.toolName] && (
                          <LockIcon className="w-3 h-3 text-muted-foreground" />
                        )}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-sm font-mono text-foreground max-w-0">
                      <SqlTooltip sql={request.sql}>
                        <span className="block overflow-hidden text-ellipsis whitespace-nowrap cursor-help">
                          {request.sql}
                        </span>
                      </SqlTooltip>
                    </td>
                    <td className="px-4 py-2 text-sm">
                      <div className="flex items-center gap-2">
                        <StatusBadge success={request.success} error={request.error} />
                        <span className="text-muted-foreground">{request.durationMs}ms</span>
                      </div>
                    </td>
                    <td className="px-4 py-2 text-sm text-muted-foreground whitespace-nowrap">
                      {parseUserAgent(request.client)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </>
        )}

        {requests.length === 0 && (
          <div className="bg-card border border-border rounded-lg p-12 text-center">
            <p className="text-muted-foreground">
              No requests have been made yet. Execute some SQL queries via the MCP endpoint to see them here.
            </p>
          </div>
        )}
      </div>
    </div>
    </TooltipProvider>
  );
}
