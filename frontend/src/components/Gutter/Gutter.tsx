import { useId, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipProvider, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import GutterIcon from './GutterIcon';
import GutterSourceItem from './GutterSourceItem';
import ActivityIcon from '../icons/ActivityIcon';
import HelpIcon from '../icons/HelpIcon';
import type { DataSource } from '../../types/datasource';

interface GutterProps {
  sources: DataSource[];
}

const EXPANDED_STORAGE_KEY = 'dbhub.navigation.expanded';

export default function Gutter({ sources }: GutterProps) {
  const sourceNavigationId = useId();
  const [preferExpanded, setPreferExpanded] = useState(() => {
    try {
      return window.localStorage.getItem(EXPANDED_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const isMobile = useIsMobile();
  const expanded = preferExpanded && !isMobile;
  const toggleLabel = expanded ? 'Collapse navigation' : 'Expand navigation';

  const toggleExpanded = () => {
    const next = !expanded;
    setPreferExpanded(next);
    try {
      window.localStorage.setItem(EXPANDED_STORAGE_KEY, String(next));
    } catch {
      // Keep the toggle usable when the browser blocks persistent storage.
    }
  };

  return (
    <TooltipProvider delay={300}>
      <aside
        className={cn(
          'shrink-0 min-h-0 flex flex-col bg-card border-e border-border',
          expanded ? 'w-56' : 'w-24'
        )}
        aria-label="Main navigation"
      >
        <div className="flex h-16 shrink-0 items-center justify-center border-b border-border px-2">
          <Tooltip>
            <TooltipTrigger render={
              <Button
                variant="ghost"
                size="icon-xl"
                className="hidden md:inline-flex touch-manipulation motion-reduce:transition-none"
                aria-label={toggleLabel}
                aria-expanded={expanded}
                aria-controls={sourceNavigationId}
                onClick={toggleExpanded}
              >
                {expanded ? <PanelLeftClose /> : <PanelLeftOpen />}
              </Button>
            } />
            <TooltipPopup side="right" sideOffset={8}>{toggleLabel}</TooltipPopup>
          </Tooltip>
          <span className="text-caption text-muted-foreground md:hidden">Sources</span>
        </div>
        <nav id={sourceNavigationId} aria-label="Data sources" className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
          {sources.map((source) => (
            <GutterSourceItem key={source.id} source={source} expanded={expanded} />
          ))}
        </nav>
        <div className="flex shrink-0 flex-col gap-1 border-t border-border p-2">
          <GutterIcon icon={<ActivityIcon />} to="/requests" tooltip="Requests" expanded={expanded} />
          <GutterIcon icon={<HelpIcon />} href="https://dbhub.ai" tooltip="Help" expanded={expanded} />
        </div>
      </aside>
    </TooltipProvider>
  );
}
