import * as Tooltip from '@radix-ui/react-tooltip';
import GutterIcon from './GutterIcon';
import HomeIcon from '../icons/HomeIcon';
import HelpIcon from '../icons/HelpIcon';

export default function Gutter() {
  return (
    <Tooltip.Provider delayDuration={300}>
      <aside
        className="w-12 h-screen flex flex-col items-center border-r border-border bg-background"
        aria-label="Main navigation"
      >
        <div className="flex-1 pt-3">
          <GutterIcon icon={<HomeIcon />} to="/" tooltip="Home" />
        </div>
        <div className="pb-3">
          <GutterIcon icon={<HelpIcon />} href="https://dbhub.ai" tooltip="Help" />
        </div>
      </aside>
    </Tooltip.Provider>
  );
}
