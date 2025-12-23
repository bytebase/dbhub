import { TooltipProvider } from '@/components/ui/tooltip';
import GutterIcon from './GutterIcon';
import GutterSourceItem from './GutterSourceItem';
import ActivityIcon from '../icons/ActivityIcon';
import HelpIcon from '../icons/HelpIcon';
import type { DataSource } from '../../types/datasource';

interface GutterProps {
  sources: DataSource[];
}

export default function Gutter({ sources }: GutterProps) {
  return (
    <TooltipProvider>
      <aside
        className="w-16 h-screen flex flex-col items-center bg-card pl-2 py-4 pt-6"
        aria-label="Main navigation"
      >
        <div className="w-full flex-1 flex flex-col justify-start items-start overflow-auto">
          {sources.map((source) => (
            <GutterSourceItem key={source.id} source={source} />
          ))}
        </div>
        <div className="w-full flex flex-col gap-2 items-center">
          <GutterIcon icon={<ActivityIcon />} to="/requests" tooltip="Requests" />
          <GutterIcon icon={<HelpIcon />} href="https://dbhub.ai" tooltip="Help" />
        </div>
      </aside>
    </TooltipProvider>
  );
}
