import { Link, useParams } from 'react-router-dom';
import { cn } from '../../lib/utils';
import type { DataSource, DatabaseType } from '../../types/datasource';

interface SourceListProps {
  sources: DataSource[];
  isLoading: boolean;
}

const DB_COLORS: Record<DatabaseType, string> = {
  postgres: '#336791',
  mysql: '#4479A1',
  mariadb: '#003545',
  sqlserver: '#CC2927',
  sqlite: '#003B57',
};

const DB_ABBREVIATIONS: Record<DatabaseType, string> = {
  postgres: 'PG',
  mysql: 'MY',
  mariadb: 'MB',
  sqlserver: 'MS',
  sqlite: 'SL',
};

function DatabaseIcon({ type }: { type: DatabaseType }) {
  return (
    <div
      className="w-5 h-5 rounded-full flex items-center justify-center text-white text-xs font-bold"
      style={{ backgroundColor: DB_COLORS[type] }}
    >
      {DB_ABBREVIATIONS[type]}
    </div>
  );
}

export default function SourceList({ sources, isLoading }: SourceListProps) {
  const { sourceId } = useParams<{ sourceId: string }>();

  if (isLoading) {
    return (
      <div className="px-6 py-3 text-sm text-muted-foreground">
        Loading sources...
      </div>
    );
  }

  if (sources.length === 0) {
    return (
      <div className="px-6 py-3 text-sm text-muted-foreground">
        No sources configured
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="px-6 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        Data Sources
      </div>
      {sources.map((source) => {
        const isActive = sourceId === source.id;
        return (
          <Link
            key={source.id}
            to={`/source/${source.id}`}
            className={cn(
              'flex items-center gap-3 px-6 py-3 text-sm font-medium transition-colors',
              'hover:bg-accent hover:text-accent-foreground',
              isActive && 'bg-accent text-accent-foreground'
            )}
          >
            <DatabaseIcon type={source.type} />
            <span className="flex-1 truncate">{source.id}</span>
            {source.is_default && (
              <span className="text-xs text-muted-foreground">default</span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
