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
            'flex flex-col items-center gap-0.5 py-2 px-1 rounded-lg transition-colors',
            'hover:bg-accent hover:text-accent-foreground',
            isActive && 'bg-accent text-accent-foreground'
          )}
        >
          <img
            src={DB_LOGOS[source.type]}
            alt={`${source.type} logo`}
            className="w-5 h-5"
          />
          <span className="text-[10px] text-muted-foreground truncate w-full text-center">
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
