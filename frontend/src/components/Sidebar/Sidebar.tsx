import { Link, useLocation } from 'react-router-dom';
import Logo from './Logo';
import SourceList from './SourceList';
import HelpIcon from '../icons/HelpIcon';
import HomeIcon from '../icons/HomeIcon';
import { cn } from '../../lib/utils';
import type { DataSource } from '../../types/datasource';

interface SidebarProps {
  sources: DataSource[];
  isLoading: boolean;
}

export default function Sidebar({ sources, isLoading }: SidebarProps) {
  const location = useLocation();
  const isHomeActive = location.pathname === '/';

  return (
    <aside className="w-[200px] sm:w-[220px] md:w-[240px] lg:w-[280px] border-r border-border bg-card flex flex-col" aria-label="Navigation sidebar">
      <Logo />
      <nav className="flex-1 flex flex-col overflow-hidden" aria-label="Sidebar navigation">
        <Link
          to="/"
          className={cn(
            'flex items-center gap-3 px-6 py-3 text-sm font-medium transition-colors',
            'hover:bg-accent hover:text-accent-foreground',
            isHomeActive && 'bg-accent text-accent-foreground'
          )}
        >
          <HomeIcon />
          <span>Home</span>
        </Link>
        <SourceList sources={sources} isLoading={isLoading} />
      </nav>
      <div className="border-t border-border px-4 py-2">
        <a
          href="https://dbhub.ai"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 px-2 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
        >
          <HelpIcon />
          <span>Help</span>
        </a>
      </div>
    </aside>
  );
}
