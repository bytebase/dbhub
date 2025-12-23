import Logo from './Logo';
import SourceList from './SourceList';
import type { DataSource } from '../../types/datasource';

interface SidebarProps {
  sources: DataSource[];
  isLoading: boolean;
}

export default function Sidebar({ sources, isLoading }: SidebarProps) {
  return (
    <aside
      className="w-[200px] sm:w-[220px] md:w-[240px] lg:w-[280px] border-r border-border bg-card flex flex-col"
      aria-label="Data sources sidebar"
    >
      <Logo />
      <nav className="flex-1 flex flex-col overflow-hidden" aria-label="Data sources navigation">
        <SourceList sources={sources} isLoading={isLoading} />
      </nav>
    </aside>
  );
}
