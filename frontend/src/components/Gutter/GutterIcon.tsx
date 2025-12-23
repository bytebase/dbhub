import { Link, useLocation } from 'react-router-dom';
import * as Tooltip from '@radix-ui/react-tooltip';
import { cn } from '../../lib/utils';

interface GutterIconProps {
  icon: React.ReactNode;
  tooltip: string;
  to?: string;
  href?: string;
}

export default function GutterIcon({ icon, tooltip, to, href }: GutterIconProps) {
  const location = useLocation();
  const isActive = to ? location.pathname === to : false;

  const iconButton = (
    <div
      className={cn(
        'w-full h-10 rounded-l-lg p-2 flex items-center justify-center transition-colors',
        isActive && 'bg-accent shadow'
      )}
    >
      {icon}
    </div>
  );

  const wrappedIcon = to ? (
    <Link to={to} aria-label={tooltip}>
      {iconButton}
    </Link>
  ) : href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" aria-label={tooltip}>
      {iconButton}
    </a>
  ) : (
    iconButton
  );

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        {wrappedIcon}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="right"
          sideOffset={8}
          className="z-50 px-2 py-1 text-xs bg-popover text-popover-foreground rounded shadow-md"
        >
          {tooltip}
          <Tooltip.Arrow className="fill-popover" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
