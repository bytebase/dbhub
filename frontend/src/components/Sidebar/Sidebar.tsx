import { Link, useParams } from 'react-router-dom';
import Logo from './Logo';
import { cn } from '../../lib/utils';
import type { DataSource } from '../../types/datasource';
import LockIcon from '../icons/LockIcon';

interface SidebarProps {
  sources: DataSource[];
  isLoading: boolean;
}

export default function Sidebar({ sources, isLoading }: SidebarProps) {
  const { sourceId, toolName } = useParams<{ sourceId: string; toolName: string }>();
  const currentSource = sources.find((s) => s.id === sourceId);

  return (
    <aside
      className="w-[200px] sm:w-[220px] md:w-[240px] lg:w-[280px] border-r border-border bg-gray-100 dark:bg-zinc-700 flex flex-col"
      aria-label="Data sources sidebar"
    >
      <Logo />
      <nav className="flex-1 flex flex-col overflow-hidden" aria-label="Data sources navigation">
        {isLoading ? (
          <div className="px-4 py-3 text-sm text-muted-foreground">
            Loading...
          </div>
        ) : currentSource ? (
          <div className="flex flex-col overflow-hidden px-2 pt-2">
            <Link
              to={`/source/${currentSource.id}`}
              className={cn(
                'flex items-center gap-2 px-2 py-2 text-sm font-medium transition-colors rounded-md',
                toolName
                  ? 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                  : 'bg-accent text-accent-foreground'
              )}
            >
              <span className="truncate">{currentSource.id}</span>
            </Link>
            <div className="flex-1 overflow-auto">
              {currentSource.tools
                .filter((tool) => tool.name !== 'search_objects')
                .map((tool) => (
                  <Link
                    key={tool.name}
                    to={`/source/${currentSource.id}/tool/${tool.name}`}
                    className={cn(
                      'flex items-center gap-2 px-4 py-2 text-sm transition-colors rounded-md',
                      toolName === tool.name
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                    )}
                  >
                    <span className="truncate font-mono text-xs">{tool.name}</span>
                    {tool.readonly && (
                      <LockIcon className="w-3 h-3 ml-auto flex-shrink-0" />
                    )}
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
