import { Link, useLocation } from 'react-router-dom';
import { Tooltip, TooltipTrigger, TooltipPopup } from '@/components/ui/tooltip';
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
    <Tooltip>
      <TooltipTrigger render={wrappedIcon} />
      <TooltipPopup side="right" sideOffset={8}>
        {tooltip}
      </TooltipPopup>
    </Tooltip>
  );
}
