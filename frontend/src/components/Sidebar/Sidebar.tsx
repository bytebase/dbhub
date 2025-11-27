import { Link, useLocation } from 'react-router-dom';
import Logo from './Logo';
import SourceList from './SourceList';
import { cn } from '../../lib/utils';
import type { DataSource } from '../../types/datasource';

interface SidebarProps {
  sources: DataSource[];
  isLoading: boolean;
}

function HomeIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
    </svg>
  );
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
    </aside>
  );
}
