import { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Tooltip, TooltipTrigger, TooltipPopup, TooltipProvider } from '@/components/ui/tooltip';
import { fetchRequests } from '../../api/requests';
import { fetchSources } from '../../api/sources';
import { ApiError } from '../../api/errors';
import { DB_LOGOS } from '../../lib/db-logos';
import { PageLoading, PageLoadError } from '../WorkbenchState';
import { Button } from '../ui/button';
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
        className="whitespace-pre-wrap [overflow-wrap:anywhere] max-w-md text-caption"
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
        className="whitespace-pre-wrap [overflow-wrap:anywhere] max-w-md text-caption"
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
      <span className="inline-flex items-center justify-center w-4 h-4 text-success-foreground">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </span>
    );
  }

  const errorIcon = (
    <span className="inline-flex items-center justify-center w-4 h-4 text-destructive-foreground cursor-help">
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
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setError(null);
    Promise.all([fetchRequests(), fetchSources()])
      .then(([requestsData, sourcesData]) => {
        if (!active) return;
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
        if (!active) return;
        console.error('Failed to fetch data:', err);
        const message = err instanceof ApiError ? err.message : 'Failed to load data';
        setError(message);
        setIsLoading(false);
      });
    return () => { active = false; };
  }, [loadAttempt]);

  // Get unique source IDs from requests
  const sourceIds = [...new Set(requests.map((r) => r.sourceId))].sort();

  // Filter requests based on selected source
  const filteredRequests = selectedSource
    ? requests.filter((r) => r.sourceId === selectedSource)
    : requests;

  if (isLoading) return <PageLoading label="Loading recent requests…" layout="table" />;

  if (error) return <PageLoadError title="Could not load recent requests" message={error} onRetry={() => setLoadAttempt(attempt => attempt + 1)} />;

  return (
    <TooltipProvider>
    <div className="container mx-auto px-4 py-6 sm:px-8 sm:py-10 max-w-6xl">
      <div className="space-y-6">
        <div>
          <h1 className="text-page text-foreground mb-2">Recent Requests</h1>
          <p className="text-muted-foreground text-body max-w-prose text-pretty">
            Up to 100 requests per source
          </p>
        </div>

        {requests.length > 0 && (
          <>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setSelectedSource(null)}
                className={`px-3 py-1 text-label tabular-nums whitespace-nowrap rounded-md transition-colors ${
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
                    className={`px-3 py-1 text-label tabular-nums whitespace-nowrap rounded-md transition-colors flex items-center gap-1.5 ${
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
            <div className="overflow-x-auto rounded-xl border border-border bg-card">
              <table className="w-full">
              <thead>
                <tr className="border-b-[length:var(--border-hairline)] border-border bg-muted">
                  <th className="px-4 py-3 text-start text-label text-muted-foreground whitespace-nowrap">
                    Time
                  </th>
                  <th className="px-4 py-3 text-start text-label text-muted-foreground whitespace-nowrap">
                    Tool
                  </th>
                  <th className="px-4 py-3 text-start text-label text-muted-foreground w-full">
                    SQL
                  </th>
                  <th className="px-4 py-3 text-start text-label text-muted-foreground whitespace-nowrap">
                    Result
                  </th>
                  <th className="px-4 py-3 text-start text-label text-muted-foreground whitespace-nowrap">
                    Client
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y-[length:var(--border-hairline)] divide-border">
                {filteredRequests.map((request) => (
                  <tr key={request.id} className="hover:bg-muted transition-colors">
                    <td className="px-4 py-2 text-caption tabular-nums text-muted-foreground whitespace-nowrap">
                      {formatDate(request.timestamp)} {formatTime(request.timestamp)}
                    </td>
                    <td className="px-4 py-2 text-sm whitespace-nowrap">
                      <Link
                        to={`/source/${request.sourceId}`}
                        className="font-mono text-caption text-primary hover:underline underline-offset-4 decoration-from-font inline-flex items-center gap-1"
                      >
                        {request.toolName}
                        {toolReadonly[request.toolName] && (
                          <LockIcon className="w-3 h-3 text-muted-foreground" />
                        )}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-code font-mono text-foreground max-w-0">
                      <SqlTooltip sql={request.sql}>
                        <span className="block overflow-hidden text-ellipsis whitespace-nowrap cursor-help">
                          {request.sql}
                        </span>
                      </SqlTooltip>
                    </td>
                    <td className="px-4 py-2 text-sm">
                      <div className="flex items-center gap-2">
                        <StatusBadge success={request.success} error={request.error} />
                        <span className="text-caption tabular-nums whitespace-nowrap text-muted-foreground">{request.durationMs}&nbsp;ms</span>
                      </div>
                    </td>
                    <td title={request.client} className="px-4 py-2 text-caption text-muted-foreground whitespace-nowrap">
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
          <div className="space-y-3 rounded-xl border border-border bg-card p-6 sm:p-8">
            <History aria-hidden="true" className="size-5 text-brand-accent" />
            <h2 className="text-label">No requests yet</h2>
            <p className="text-sm text-muted-foreground max-w-prose text-pretty">
              Run a tool in the workbench or through your MCP client. Its request will appear here when you return.
            </p>
            <Button variant="outline" className="min-h-11" render={<Link to="/" />}>Open workbench</Button>
          </div>
        )}
      </div>
    </div>
    </TooltipProvider>
  );
}
