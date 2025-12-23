import { Link, useParams } from 'react-router-dom';
import * as Tooltip from '@radix-ui/react-tooltip';
import { cn } from '../../lib/utils';
import type { DataSource, DatabaseType } from '../../types/datasource';
import PostgresLogo from '../../assets/logos/postgres.svg';
import MySQLLogo from '../../assets/logos/mysql.svg';
import MariaDBLogo from '../../assets/logos/mariadb.svg';
import SQLServerLogo from '../../assets/logos/sqlserver.svg';
import SQLiteLogo from '../../assets/logos/sqlite.svg';

const DB_LOGOS: Record<DatabaseType, string> = {
  postgres: PostgresLogo,
  mysql: MySQLLogo,
  mariadb: MariaDBLogo,
  sqlserver: SQLServerLogo,
  sqlite: SQLiteLogo,
};

interface GutterSourceItemProps {
  source: DataSource;
}

export default function GutterSourceItem({ source }: GutterSourceItemProps) {
  const { sourceId } = useParams<{ sourceId: string }>();
  const isActive = sourceId === source.id;
  const truncatedId = source.id.length > 5 ? source.id.slice(0, 5) + '…' : source.id;

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <Link
          to={`/source/${source.id}`}
          aria-label={source.id}
          className={cn(
            'w-full h-12 rounded-l-lg p-2 mt-1 flex flex-col items-center justify-center transition-colors',
            isActive && 'bg-gray-100 dark:bg-zinc-700 shadow'
          )}
        >
          <img
            src={DB_LOGOS[source.type]}
            alt={`${source.type} logo`}
            className="w-6 h-6"
          />
          <span className={cn(
            'text-[10px] truncate w-full text-center mt-0.5',
            isActive ? 'text-foreground' : 'text-muted-foreground'
          )}>
            {truncatedId}
          </span>
        </Link>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="right"
          sideOffset={8}
          className="z-50 px-2 py-1 text-xs bg-popover text-popover-foreground rounded shadow-md"
        >
          {source.id}
          <Tooltip.Arrow className="fill-popover" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
