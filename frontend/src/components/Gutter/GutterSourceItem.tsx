import { Link, useParams } from 'react-router-dom';
import { Tooltip, TooltipTrigger, TooltipPopup } from '@/components/ui/tooltip';
import { cn } from '../../lib/utils';
import { DB_LOGOS } from '../../lib/db-logos';
import type { DataSource } from '../../types/datasource';

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
              isActive && 'bg-accent shadow'
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
