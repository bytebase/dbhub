import { Link, useLocation } from 'react-router-dom';
import { Tooltip, TooltipTrigger, TooltipPopup } from '@/components/ui/tooltip';
import { cn } from '../../lib/utils';

interface GutterIconProps {
  icon: React.ReactNode;
  tooltip: string;
  to?: string;
  href?: string;
  expanded: boolean;
}

export default function GutterIcon({ icon, tooltip, to, href, expanded }: GutterIconProps) {
  const location = useLocation();
  const isActive = to ? location.pathname === to : false;
  const className = cn(
    'flex min-h-11 w-full items-center rounded-md p-2 touch-manipulation transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
    expanded ? 'justify-start gap-3' : 'justify-center',
    isActive ? 'bg-selection text-selection-foreground' : href ? 'text-brand-accent hover:bg-accent hover:underline underline-offset-4' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
  );
  const content = <>
    <span aria-hidden="true">{icon}</span>
    {expanded && <span className="text-sm">{tooltip}</span>}
  </>;

  return (
    <Tooltip>
      <TooltipTrigger render={to ? (
        <Link to={to} aria-label={tooltip} aria-current={isActive ? 'page' : undefined} className={className}>
          {content}
        </Link>
      ) : (
        <a href={href} target="_blank" rel="noopener noreferrer" aria-label={tooltip} className={className}>
          {content}
        </a>
      )} />
      <TooltipPopup side="right" sideOffset={8}>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
