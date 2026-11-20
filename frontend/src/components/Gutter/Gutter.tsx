import { useId } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Button } from '../ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import GutterIcon from './GutterIcon';
import GutterSourceItem from './GutterSourceItem';
import ActivityIcon from '../icons/ActivityIcon';
import HelpIcon from '../icons/HelpIcon';
import type { DataSource } from '../../types/datasource';

interface GutterProps {
  sources: DataSource[];
  hasSidebar?: boolean;
  expanded?: boolean;
  onToggleExpanded?: () => void;
}

export default function Gutter({ sources, hasSidebar = false, expanded = false, onToggleExpanded }: GutterProps) {
  const sourceNavigationId = useId();
  const toggleLabel = expanded ? 'Collapse navigation' : 'Expand navigation';

  return (
    <TooltipProvider delay={300}>
      <aside
        className={cn(
          'shrink-0 min-h-0 flex flex-col bg-sidebar border-e-[length:var(--border-hairline)]',
          hasSidebar ? 'border-border-subtle' : 'border-border',
          expanded ? 'w-56' : 'w-20'
        )}
        aria-label="Main navigation"
      >
        {onToggleExpanded && (
          <div className={cn('flex h-16 shrink-0 items-center border-b-[length:var(--border-hairline)] border-border-subtle px-2', expanded ? 'justify-end' : 'justify-center')}>
            <Button variant="ghost" size="icon" className="size-9 pointer-coarse:size-11"
              aria-label={toggleLabel} title={toggleLabel} aria-expanded={expanded}
              aria-controls={sourceNavigationId} onClick={onToggleExpanded}>
              {expanded ? <PanelLeftClose aria-hidden="true" /> : <PanelLeftOpen aria-hidden="true" />}
            </Button>
          </div>
        )}
        <nav id={sourceNavigationId} aria-label="Data sources" className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
          {sources.map((source) => (
            <GutterSourceItem key={source.id} source={source} expanded={expanded} />
          ))}
        </nav>
        <div className="flex shrink-0 flex-col gap-1 border-t-[length:var(--border-hairline)] border-border-subtle p-2">
          <GutterIcon icon={<ActivityIcon />} to="/requests" tooltip="Requests" expanded={expanded} />
          <GutterIcon icon={<HelpIcon />} href="https://dbhub.ai" tooltip="Help" expanded={expanded} />
        </div>
      </aside>
    </TooltipProvider>
  );
}
