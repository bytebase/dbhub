import Logo from './Logo';
import NavItem from './NavItem';
import SourceList from './SourceList';
import type { DataSource } from '../../types/datasource';

interface SidebarProps {
  sources: DataSource[];
  isLoading: boolean;
}

function HomeIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

export default function Sidebar({ sources, isLoading }: SidebarProps) {
  return (
    <aside className="w-[200px] sm:w-[220px] md:w-[240px] lg:w-[280px] border-r border-border bg-card flex flex-col" aria-label="Navigation sidebar">
      <Logo />
      <nav className="flex-1 flex flex-col overflow-hidden" aria-label="Sidebar navigation">
        <NavItem to="/" icon={<HomeIcon />} label="Home" />
        <SourceList sources={sources} isLoading={isLoading} />
      </nav>
    </aside>
  );
}
