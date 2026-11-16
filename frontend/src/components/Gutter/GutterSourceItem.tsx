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
              'w-full min-h-11 rounded-md border-s-2 p-2 flex items-center touch-manipulation transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
              expanded ? 'gap-3 justify-start' : 'flex-col justify-center gap-1.5',
              isActive ? 'border-primary bg-selection text-selection-foreground' : 'border-transparent hover:bg-accent'
            )}
          >
            <img
              src={DB_LOGOS[source.type]}
              alt=""
              width={24}
              height={24}
              className="size-6 shrink-0"
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
