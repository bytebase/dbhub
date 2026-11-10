import { useState } from 'react';
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
    <TooltipProvider>
      <aside
        className={cn(
          'shrink-0 h-screen flex flex-col items-center bg-card pl-2 py-4 pt-6',
          expanded ? 'w-56' : 'w-16'
        )}
        aria-label="Main navigation"
      >
        <Tooltip>
          <TooltipTrigger render={
            <Button
              variant="ghost"
              size="icon-lg"
              className="hidden md:inline-flex self-start mb-2"
              aria-label={toggleLabel}
              aria-expanded={expanded}
              aria-controls="source-navigation"
              onClick={toggleExpanded}
            >
              {expanded ? <PanelLeftClose /> : <PanelLeftOpen />}
            </Button>
          } />
          <TooltipPopup side="right" sideOffset={8}>{toggleLabel}</TooltipPopup>
        </Tooltip>
        <div id="source-navigation" className="w-full min-h-0 flex-1 flex flex-col justify-start items-start overflow-auto">
          {sources.map((source) => (
            <GutterSourceItem key={source.id} source={source} expanded={expanded} />
          ))}
        </div>
        <div className={cn(
          'w-full flex flex-col',
          expanded ? 'mt-2 border-t border-border divide-y divide-border' : 'gap-2 items-center'
        )}>
          <GutterIcon icon={<ActivityIcon />} to="/requests" tooltip="Requests" expanded={expanded} />
          <GutterIcon icon={<HelpIcon />} href="https://dbhub.ai" tooltip="Help" expanded={expanded} />
        </div>
      </aside>
    </TooltipProvider>
  );
}
