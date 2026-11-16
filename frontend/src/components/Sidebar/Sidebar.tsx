import { Link, useParams } from 'react-router-dom';
import { LayoutDashboard } from 'lucide-react';
import Logo from './Logo';
import { cn } from '../../lib/utils';
import type { DataSource } from '../../types/datasource';
import LockIcon from '../icons/LockIcon';
import Identifier from '../Identifier';

interface SidebarProps {
  sources: DataSource[];
  isLoading: boolean;
}

const itemClassName = 'flex min-h-11 items-center gap-2 rounded-md border-s-2 px-3 py-2 text-sm touch-manipulation transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';

export default function Sidebar({ sources, isLoading }: SidebarProps) {
  const { sourceId, toolName } = useParams<{ sourceId: string; toolName: string }>();
  const currentSource = sources.find((s) => s.id === sourceId);
  const tools = currentSource?.tools.filter((tool) => tool.name !== 'search_objects') ?? [];

  return (
    <aside
      className="flex min-h-0 min-w-0 flex-1 flex-col border-e border-border bg-sidebar md:w-64 md:flex-none"
      aria-label="Tools sidebar"
    >
      <Logo />
      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-4" aria-label="Source and tools">
        {isLoading ? (
          <div className="space-y-3 py-4" role="status" aria-label="Loading tools">
            <div className="h-5 w-3/4 rounded bg-muted" />
            <div className="h-11 rounded bg-muted" />
            <div className="h-11 rounded bg-muted" />
          </div>
        ) : currentSource ? (
          <>
            <div className="px-3 pb-3 pt-4">
              <p className="text-label [overflow-wrap:anywhere]"><Identifier>{currentSource.id}</Identifier></p>
              <p className="mt-1 text-caption text-muted-foreground">{currentSource.type}</p>
            </div>
            <Link
              to={`/source/${currentSource.id}`}
              aria-current={!toolName ? 'page' : undefined}
              className={cn(
                itemClassName,
                !toolName
                  ? 'border-primary bg-selection text-selection-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-accent'
              )}
            >
              <LayoutDashboard className="size-4 shrink-0" aria-hidden="true" />
              Overview
            </Link>
            <div className="mb-2 mt-6 flex items-center justify-between px-3">
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
                      ? 'border-primary bg-selection text-selection-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-accent'
                  )}
                >
                  <span className="min-w-0 flex-1 font-mono text-caption [overflow-wrap:anywhere]"><Identifier>{tool.name}</Identifier></span>
                  {tool.readonly && (
                    <span aria-hidden="true" className="shrink-0">
                      <LockIcon className="size-3.5 shrink-0" />
                    </span>
                  )}
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
