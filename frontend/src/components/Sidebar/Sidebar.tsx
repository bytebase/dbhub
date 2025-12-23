import { Link, useParams } from 'react-router-dom';
import Logo from './Logo';
import { cn } from '../../lib/utils';
import type { DataSource } from '../../types/datasource';

interface SidebarProps {
  sources: DataSource[];
  isLoading: boolean;
}

export default function Sidebar({ sources, isLoading }: SidebarProps) {
  const { sourceId } = useParams<{ sourceId: string }>();
  const currentSource = sources.find((s) => s.id === sourceId);

  return (
    <aside
      className="w-[200px] sm:w-[220px] md:w-[240px] lg:w-[280px] border-r border-border bg-gray-100 dark:bg-zinc-700 flex flex-col"
      aria-label="Data sources sidebar"
    >
      <Logo />
      <nav className="flex-1 flex flex-col overflow-hidden" aria-label="Source navigation">
        {isLoading ? (
          <div className="px-4 py-3 text-sm text-muted-foreground">
            Loading...
          </div>
        ) : currentSource ? (
          <div className="flex flex-col overflow-hidden">
            <Link
              to={`/source/${currentSource.id}`}
              className={cn(
                'flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors',
                'bg-accent text-accent-foreground'
              )}
            >
              <span className="truncate">{currentSource.id}</span>
            </Link>
            <div className="flex-1 overflow-auto">
              {currentSource.tools.map((tool) => (
                <Link
                  key={tool.name}
                  to={`/source/${currentSource.id}`}
                  className="flex items-center px-6 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
                >
                  <span className="truncate font-mono text-xs">{tool.name}</span>
                </Link>
              ))}
            </div>
          </div>
        ) : (
          <div className="px-4 py-3 text-sm text-muted-foreground">
            Select a data source
          </div>
        )}
      </nav>
    </aside>
  );
}
