import { Link, useParams } from 'react-router-dom';
import { Tooltip, TooltipTrigger, TooltipPopup } from '@/components/ui/tooltip';
import { cn } from '../../lib/utils';
import { DB_LOGOS } from '../../lib/db-logos';
import type { DataSource } from '../../types/datasource';
import Identifier from '../Identifier';

interface GutterSourceItemProps {
  source: DataSource;
  expanded: boolean;
}

export default function GutterSourceItem({ source, expanded }: GutterSourceItemProps) {
  const { sourceId } = useParams<{ sourceId: string }>();
  const isActive = sourceId === source.id;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            to={`/source/${source.id}`}
            aria-label={source.id}
            aria-current={isActive ? 'location' : undefined}
            className={cn(
              'w-full rounded-md flex items-center touch-manipulation transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
              expanded ? 'min-h-9 gap-3 justify-start px-2 py-1.5 pointer-coarse:min-h-11' : 'min-h-11 flex-col justify-center gap-1.5 p-2',
              isActive ? 'bg-selection text-selection-foreground' : 'hover:bg-selection/50'
            )}
          >
            <img
              src={DB_LOGOS[source.type]}
              alt=""
              width={24}
              height={24}
              className={cn('shrink-0', expanded ? 'size-5' : 'size-6')}
            />
            <span className={cn(
              expanded
                ? 'min-w-0 text-sm text-start [overflow-wrap:anywhere]'
                : 'text-xs w-full text-center line-clamp-2 [overflow-wrap:anywhere]',
              isActive ? 'text-foreground' : 'text-muted-foreground'
            )}>
              <Identifier>{source.id}</Identifier>
            </span>
          </Link>
        }
      />
      <TooltipPopup side="right" sideOffset={8} className="max-w-64 text-caption [overflow-wrap:anywhere]">
        {source.id}
      </TooltipPopup>
    </Tooltip>
  );
}
