import { useEffect, useState } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { fetchSource } from '../../api/sources';
import { ApiError } from '../../api/errors';
import type { DataSource } from '../../types/datasource';
import { PageLoading, PageLoadError } from '../WorkbenchState';
import { DB_LOGOS } from '../../lib/db-logos';

export default function SourceDetailView() {
  const { sourceId } = useParams<{ sourceId: string }>();
  const [source, setSource] = useState<DataSource | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!sourceId) return;

    let active = true;
    setIsLoading(true);
    setError(null);

    fetchSource(sourceId)
      .then((data) => {
        if (!active) return;
        setSource(data);
        setIsLoading(false);
      })
      .catch((err: ApiError) => {
        if (!active) return;
        setError(err);
        setIsLoading(false);
      });
    return () => { active = false; };
  }, [sourceId, loadAttempt]);

  if (!sourceId) {
    return <Navigate to="/" replace />;
  }

  if (isLoading) return <PageLoading label="Loading source details…" />;

  if (error) {
    if (error.status === 404) return <Navigate to="/404" replace />;
    return <PageLoadError title="Could not load this source" message={error.message} onRetry={() => setLoadAttempt(attempt => attempt + 1)} />;
  }

  if (!source) {
    return (
      <div className="container mx-auto px-4 py-6 sm:px-8 sm:py-10">
        <div className="text-muted-foreground">Source not found</div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 sm:px-8 sm:py-10 max-w-4xl">
      <div className="space-y-6">
        <h1 className="flex items-start gap-3 text-page text-foreground">
          <img
            src={DB_LOGOS[source.type]}
            alt={`${source.type} logo`}
            className="w-8 h-8 shrink-0"
          />
          <span className="min-w-0 [overflow-wrap:anywhere]">{source.id}</span>
        </h1>

        <div className="rounded-xl border border-border bg-card p-4 sm:p-6">
          <h2 className="text-section text-foreground mb-4">
            Connection Details
          </h2>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-label text-muted-foreground">Database Type</dt>
              <dd className="mt-1 text-code text-foreground font-mono [overflow-wrap:anywhere]">{source.type}</dd>
            </div>

            {source.host && (
              <div>
                <dt className="text-label text-muted-foreground">Host</dt>
                <dd className="mt-1 text-code text-foreground font-mono [overflow-wrap:anywhere]">{source.host}</dd>
              </div>
            )}

            {source.port && (
              <div>
                <dt className="text-label text-muted-foreground">Port</dt>
                <dd className="mt-1 text-code text-foreground font-mono [overflow-wrap:anywhere]">{source.port}</dd>
              </div>
            )}

            {source.database && (
              <div>
                <dt className="text-label text-muted-foreground">Database</dt>
                <dd className="mt-1 text-code text-foreground font-mono [overflow-wrap:anywhere]">{source.database}</dd>
              </div>
            )}

            {source.user && (
              <div>
                <dt className="text-label text-muted-foreground">User</dt>
                <dd className="mt-1 text-code text-foreground font-mono [overflow-wrap:anywhere]">{source.user}</dd>
              </div>
            )}
          </dl>
        </div>


        {source.ssh_tunnel?.enabled && (
          <div className="rounded-xl border border-border bg-card p-4 sm:p-6">
            <h2 className="text-section text-foreground mb-4">
              SSH Tunnel
            </h2>
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-label text-muted-foreground">Status</dt>
                <dd className="mt-1 text-sm text-foreground">
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full whitespace-nowrap text-xs font-medium bg-success/10 text-success-foreground">
                    Enabled
                  </span>
                </dd>
              </div>

              {source.ssh_tunnel.ssh_host && (
                <div>
                  <dt className="text-label text-muted-foreground">SSH Host</dt>
                  <dd className="mt-1 text-code text-foreground font-mono [overflow-wrap:anywhere]">
                    {source.ssh_tunnel.ssh_host}
                  </dd>
                </div>
              )}

              {source.ssh_tunnel.ssh_port && (
                <div>
                  <dt className="text-label text-muted-foreground">SSH Port</dt>
                  <dd className="mt-1 text-code text-foreground font-mono [overflow-wrap:anywhere]">
                    {source.ssh_tunnel.ssh_port}
                  </dd>
                </div>
              )}

              {source.ssh_tunnel.ssh_user && (
                <div>
                  <dt className="text-label text-muted-foreground">SSH User</dt>
                  <dd className="mt-1 text-code text-foreground font-mono [overflow-wrap:anywhere]">
                    {source.ssh_tunnel.ssh_user}
                  </dd>
                </div>
              )}
            </dl>
          </div>
        )}

        <div className="rounded-xl border border-border bg-card p-4 sm:p-6">
          <h2 className="text-section text-foreground mb-4">
            Available Tools
          </h2>
          {source.tools.length > 0 ? (
            <div className="divide-y-[length:var(--border-hairline)] divide-border">
              {source.tools.map((tool) => (
                <div key={tool.name} className="py-6 first:pt-0 last:pb-0">
                  <div className="space-y-4">
                    <div>
                      <div className="flex flex-wrap items-baseline gap-2">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <h3 className="text-label text-foreground font-mono [overflow-wrap:anywhere]">
                            {tool.name}
                          </h3>
                          {tool.readonly && (
                            <Lock className="w-3.5 h-3.5 shrink-0 text-muted-foreground" aria-label="Read-only" />
                          )}
                        </div>
                        <div className="text-caption text-muted-foreground">
                          ({tool.parameters.length} {tool.parameters.length === 1 ? 'parameter' : 'parameters'})
                        </div>
                      </div>
                      <div className="mt-1.5 text-body text-muted-foreground max-w-prose text-pretty [overflow-wrap:anywhere]">
                        {tool.description}
                      </div>
                    </div>

                    {tool.parameters.length > 0 && (
                      <div className="space-y-3">
                        <div className="text-label text-muted-foreground">
                          Parameters
                        </div>
                        <ul className="space-y-3">
                          {tool.parameters.map((param) => (
                            <li key={param.name} className="text-sm">
                              <div className="flex flex-wrap items-baseline gap-2">
                                <span className="font-mono text-foreground font-medium [overflow-wrap:anywhere]">
                                  {param.name}
                                </span>
                                <span className="text-caption font-mono text-muted-foreground">
                                  {param.type}
                                </span>
                                <span className="text-caption text-muted-foreground">
                                  {param.required ? 'required' : 'optional'}
                                </span>
                              </div>
                              {param.description && (
                                <div className="mt-2 text-caption text-muted-foreground max-w-prose text-pretty [overflow-wrap:anywhere]">
                                  {param.description}
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              No tools available for this source
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
