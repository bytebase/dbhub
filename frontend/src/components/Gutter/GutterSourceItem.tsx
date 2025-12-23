import { Link, useParams } from 'react-router-dom';
import { Tooltip, TooltipTrigger, TooltipPopup } from '@/components/ui/tooltip';
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

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            to={`/source/${source.id}`}
            aria-label={source.id}
            className={cn(
              'w-full rounded-l-lg p-2 mt-1 flex flex-col items-center justify-center transition-colors',
              isActive && 'bg-gray-100 dark:bg-zinc-700 shadow'
            )}
          >
            <img
              src={DB_LOGOS[source.type]}
              alt={`${source.type} logo`}
              className="w-7 h-7"
            />
            <span className={cn(
              'text-[10px] w-full text-center mt-1 leading-tight break-words line-clamp-2',
              isActive ? 'text-foreground' : 'text-muted-foreground'
            )}>
              {source.id}
            </span>
          </Link>
        }
      />
      <TooltipPopup side="right" sideOffset={8}>
        {source.id}
      </TooltipPopup>
    </Tooltip>
  );
}
