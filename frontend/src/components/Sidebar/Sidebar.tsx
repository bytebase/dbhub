import { Link, useParams } from 'react-router-dom';
import { PanelsTopLeft } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { DataSource } from '../../types/datasource';
import LockIcon from '../icons/LockIcon';
import Identifier from '../Identifier';

interface SidebarProps {
  sources: DataSource[];
  isLoading: boolean;
}

const itemClassName = 'flex min-h-9 items-center gap-2 rounded-md px-3 py-1.5 pointer-coarse:min-h-11 text-sm touch-manipulation transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';

export default function Sidebar({ sources, isLoading }: SidebarProps) {
  const { sourceId, toolName } = useParams<{ sourceId: string; toolName: string }>();
  const currentSource = sources.find((s) => s.id === sourceId);
  const tools = currentSource?.tools.filter((tool) => tool.name !== 'search_objects') ?? [];

  return (
    <aside
      className="flex min-h-0 min-w-0 flex-1 flex-col border-e-[length:var(--border-hairline)] border-border bg-sidebar md:w-64 md:flex-none"
      aria-label="Tools sidebar"
    >
      <div className="flex h-16 shrink-0 flex-col justify-center border-b-[length:var(--border-hairline)] border-border-subtle px-6">
        {isLoading ? <div className="h-5 w-3/4 rounded-sm bg-selection/50" aria-hidden="true" /> : currentSource ? <>
          <p className="truncate text-label" title={currentSource.id}>{currentSource.id}</p>
          <p className="text-caption text-muted-foreground">{currentSource.type}</p>
        </> : <p className="text-label">Sources</p>}
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-3" aria-label="Source and tools">
        {isLoading ? (
          <div className="space-y-3 py-4" role="status" aria-label="Loading tools">
            <div className="h-9 rounded-md bg-selection/50 pointer-coarse:h-11" />
            <div className="h-9 rounded-md bg-selection/50 pointer-coarse:h-11" />
          </div>
        ) : currentSource ? (
          <>
            <Link
              to={`/source/${currentSource.id}`}
              aria-current={!toolName ? 'page' : undefined}
              className={cn(
                itemClassName,
                !toolName
                  ? 'bg-selection text-selection-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-selection/50'
              )}
            >
              <PanelsTopLeft className="size-4 shrink-0" aria-hidden="true" />
              Overview
            </Link>
            <div className="mb-2 mt-4 flex items-center justify-between px-3">
              <h2 className="text-caption font-medium text-muted-foreground">Tools</h2>
              <span className="text-caption tabular-nums text-muted-foreground">{tools.length}</span>
            </div>
            <div className="space-y-1">
              {tools.map((tool) => (
                <Link
                  key={tool.name}
                  to={`/source/${currentSource.id}/tool/${tool.name}`}
                  aria-label={`${tool.name}${tool.readonly ? ' (read-only)' : ''}`}
                  aria-current={toolName === tool.name ? 'page' : undefined}
                  className={cn(
                    itemClassName,
                    toolName === tool.name
                      ? 'bg-selection text-selection-foreground'
                      : 'text-muted-foreground hover:text-foreground hover:bg-selection/50'
                  )}
                >
                  <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
                    {tool.readonly && <LockIcon className="size-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1 font-mono text-sm [overflow-wrap:anywhere]"><Identifier>{tool.name}</Identifier></span>
                </Link>
              ))}
              {tools.length === 0 && (
                <p className="px-3 text-caption text-muted-foreground text-pretty">No tools configured for this source.</p>
              )}
            </div>
          </>
        ) : (
          <p className="px-3 py-4 text-sm text-muted-foreground text-pretty">Select a source to browse its tools.</p>
        )}
      </nav>
    </aside>
  );
}
