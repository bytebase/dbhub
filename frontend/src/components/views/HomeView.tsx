import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchRequests } from '../../api/requests';
import { ApiError } from '../../api/errors';
import type { Request } from '../../types/request';

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

function truncateSql(sql: string, maxLength: number = 60): string {
  const normalized = sql.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return normalized.substring(0, maxLength) + '...';
}

function Tooltip({ content, children, position = 'top' }: { content: string; children: React.ReactNode; position?: 'top' | 'top-right' }) {
  const positionClasses = position === 'top-right'
    ? 'bottom-full right-0 mb-2'
    : 'bottom-full left-0 mb-2';

  const arrowClasses = position === 'top-right'
    ? 'absolute top-full right-4 border-4 border-transparent border-t-popover'
    : 'absolute top-full left-4 border-4 border-transparent border-t-popover';

  return (
    <div className="relative group inline-flex">
      {children}
      <div className={`absolute z-[100] invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-opacity duration-200 w-max max-w-md ${positionClasses}`}>
        <div className="bg-popover text-popover-foreground text-xs rounded-md shadow-lg border border-border px-3 py-2 whitespace-pre-wrap break-all">
          {content}
        </div>
        <div className={arrowClasses}></div>
      </div>
    </div>
  );
}

function StatusBadge({ success, error }: { success: boolean; error?: string }) {
  if (success) {
    return (
      <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-500/10 text-green-600 dark:text-green-400">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </span>
    );
  }

  const errorIcon = (
    <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-red-500/10 text-red-600 dark:text-red-400 cursor-help">
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
      </svg>
    </span>
  );

  if (error) {
    return <Tooltip content={error} position="top-right">{errorIcon}</Tooltip>;
  }

  return errorIcon;
}

export default function HomeView() {
  const [requests, setRequests] = useState<Request[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchRequests()
      .then((data) => {
        setRequests(data.requests);
        setIsLoading(false);
      })
      .catch((err) => {
        console.error('Failed to fetch requests:', err);
        const message = err instanceof ApiError ? err.message : 'Failed to load requests';
        setError(message);
        setIsLoading(false);
      });
  }, []);

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
    <div className="container mx-auto px-8 py-12 max-w-6xl">
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-foreground mb-2">Recent Requests</h1>
          <p className="text-muted-foreground">
            {requests.length === 0
              ? 'No requests yet'
              : `${requests.length} request${requests.length === 1 ? '' : 's'}`}
          </p>
        </div>

        {requests.length > 0 && (
          <div className="bg-card border border-border rounded-lg overflow-visible">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Time
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Source
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    SQL
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Duration
                  </th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {requests.map((request) => (
                  <tr key={request.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 text-sm text-muted-foreground whitespace-nowrap">
                      <div>{formatTime(request.timestamp)}</div>
                      <div className="text-xs">{formatDate(request.timestamp)}</div>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <Link
                        to={`/source/${request.sourceId}`}
                        className="text-primary hover:underline font-medium"
                      >
                        {request.sourceId}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-sm font-mono text-foreground">
                      <Tooltip content={request.sql}>
                        <span className="cursor-help">
                          {truncateSql(request.sql)}
                        </span>
                      </Tooltip>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground whitespace-nowrap">
                      {request.durationMs}ms
                    </td>
                    <td className="px-4 py-3 text-center">
                      <StatusBadge success={request.success} error={request.error} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
  );
}
