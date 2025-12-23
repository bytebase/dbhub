import * as Tooltip from '@radix-ui/react-tooltip';
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
    <Tooltip.Provider delayDuration={300}>
      <aside
        className="w-12 h-screen flex flex-col items-center bg-muted"
        aria-label="Main navigation"
      >
        <div className="flex-1 pt-2 flex flex-col gap-1 overflow-auto">
          {sources.map((source) => (
            <GutterSourceItem key={source.id} source={source} />
          ))}
        </div>
        <div className="pb-3 flex flex-col gap-2">
          <GutterIcon icon={<ActivityIcon />} to="/requests" tooltip="Requests" />
          <GutterIcon icon={<HelpIcon />} href="https://dbhub.ai" tooltip="Help" />
        </div>
      </aside>
    </Tooltip.Provider>
  );
}
