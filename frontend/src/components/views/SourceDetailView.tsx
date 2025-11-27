import { useEffect, useState } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { fetchSource } from '../../api/sources';
import { ApiError } from '../../api/errors';
import type { DataSource, DatabaseType } from '../../types/datasource';
import LockIcon from '../icons/LockIcon';

const DB_TYPE_DISPLAY_NAMES: Record<DatabaseType, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  sqlserver: 'SQL Server',
  sqlite: 'SQLite',
};

export default function SourceDetailView() {
  const { sourceId } = useParams<{ sourceId: string }>();
  const [source, setSource] = useState<DataSource | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!sourceId) return;

    setIsLoading(true);
    setError(null);

    fetchSource(sourceId)
      .then((data) => {
        setSource(data);
        setIsLoading(false);
      })
      .catch((err: ApiError) => {
        setError(err);
        setIsLoading(false);
      });
  }, [sourceId]);

  if (!sourceId) {
    return <Navigate to="/" replace />;
  }

  if (isLoading) {
    return (
      <div className="container mx-auto px-8 py-12">
        <div className="text-muted-foreground">Loading source details...</div>
      </div>
    );
  }

  if (error) {
    // If source not found, redirect to 404 page
    if (error.status === 404) {
      return <Navigate to="/404" replace />;
    }

    // For other errors, show error message
    return (
      <div className="container mx-auto px-8 py-12">
        <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-destructive mb-2">Error</h2>
          <p className="text-destructive/90">{error.message}</p>
        </div>
      </div>
    );
  }

  if (!source) {
    return (
      <div className="container mx-auto px-8 py-12">
        <div className="text-muted-foreground">Source not found</div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-8 py-12 max-w-4xl">
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-foreground mb-2">
            {source.id}
          </h1>
          <p className="text-muted-foreground">
            {DB_TYPE_DISPLAY_NAMES[source.type]} Database
          </p>
        </div>

        <div className="bg-card border border-border rounded-lg p-6">
          <h2 className="text-xl font-semibold text-foreground mb-4">
            Connection Details
          </h2>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Database Type</dt>
              <dd className="mt-1 text-sm text-foreground font-mono">{source.type}</dd>
            </div>

            {source.host && (
              <div>
                <dt className="text-sm font-medium text-muted-foreground">Host</dt>
                <dd className="mt-1 text-sm text-foreground font-mono">{source.host}</dd>
              </div>
            )}

            {source.port && (
              <div>
                <dt className="text-sm font-medium text-muted-foreground">Port</dt>
                <dd className="mt-1 text-sm text-foreground font-mono">{source.port}</dd>
              </div>
            )}

            {source.database && (
              <div>
                <dt className="text-sm font-medium text-muted-foreground">Database</dt>
                <dd className="mt-1 text-sm text-foreground font-mono">{source.database}</dd>
              </div>
            )}

            {source.user && (
              <div>
                <dt className="text-sm font-medium text-muted-foreground">User</dt>
                <dd className="mt-1 text-sm text-foreground font-mono">{source.user}</dd>
              </div>
            )}

            <div>
              <dt className="text-sm font-medium text-muted-foreground">Default Source</dt>
              <dd className="mt-1 text-sm text-foreground">
                {source.is_default ? (
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary">
                    Yes
                  </span>
                ) : (
                  <span className="text-muted-foreground">No</span>
                )}
              </dd>
            </div>
          </dl>
        </div>

        <div className="bg-card border border-border rounded-lg p-6">
          <h2 className="text-xl font-semibold text-foreground mb-4">
            Configuration
          </h2>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Read-Only Mode</dt>
              <dd className="mt-1 text-sm text-foreground">
                {source.readonly ? (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">
                    <LockIcon className="w-3 h-3" />
                    Enabled
                  </span>
                ) : (
                  <span className="text-muted-foreground">Disabled</span>
                )}
              </dd>
            </div>

            <div>
              <dt className="text-sm font-medium text-muted-foreground">Max Rows</dt>
              <dd className="mt-1 text-sm text-foreground font-mono">
                {source.max_rows ?? 'Unlimited'}
              </dd>
            </div>
          </dl>
        </div>

        {source.ssh_tunnel?.enabled && (
          <div className="bg-card border border-border rounded-lg p-6">
            <h2 className="text-xl font-semibold text-foreground mb-4">
              SSH Tunnel
            </h2>
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-sm font-medium text-muted-foreground">Status</dt>
                <dd className="mt-1 text-sm text-foreground">
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-500/10 text-green-600 dark:text-green-400">
                    Enabled
                  </span>
                </dd>
              </div>

              {source.ssh_tunnel.ssh_host && (
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">SSH Host</dt>
                  <dd className="mt-1 text-sm text-foreground font-mono">
                    {source.ssh_tunnel.ssh_host}
                  </dd>
                </div>
              )}

              {source.ssh_tunnel.ssh_port && (
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">SSH Port</dt>
                  <dd className="mt-1 text-sm text-foreground font-mono">
                    {source.ssh_tunnel.ssh_port}
                  </dd>
                </div>
              )}

              {source.ssh_tunnel.ssh_user && (
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">SSH User</dt>
                  <dd className="mt-1 text-sm text-foreground font-mono">
                    {source.ssh_tunnel.ssh_user}
                  </dd>
                </div>
              )}
            </dl>
          </div>
        )}

        <div className="bg-card border border-border rounded-lg p-6">
          <h2 className="text-xl font-semibold text-foreground mb-4">
            Available Tools
          </h2>
          {source.tools.length > 0 ? (
            <div className="space-y-6">
              {source.tools.map((tool) => (
                <div key={tool.name} className="space-y-3">
                  <div>
                    <div className="text-sm font-medium text-foreground font-mono">
                      {tool.name}
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      {tool.description}
                    </div>
                  </div>

                  {tool.parameters.length > 0 && (
                    <div>
                      <div className="text-sm font-medium text-muted-foreground mb-2">
                        Parameters:
                      </div>
                      <ul className="space-y-2">
                        {tool.parameters.map((param) => (
                          <li key={param.name} className="text-sm">
                            <span className="font-mono text-foreground">
                              {param.name}
                            </span>
                            <span className="text-muted-foreground">
                              {' '}({param.type}
                              {param.required && ', required'})
                            </span>
                            {param.description && (
                              <div className="mt-1 text-muted-foreground ml-4">
                                {param.description}
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
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
