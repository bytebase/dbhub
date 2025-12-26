import { Outlet, useLocation } from 'react-router-dom';
import Gutter from './Gutter';
import Sidebar from './Sidebar/Sidebar';
import type { DataSource } from '../types/datasource';

interface LayoutProps {
  sources: DataSource[];
  isLoading: boolean;
}

export default function Layout({ sources, isLoading }: LayoutProps) {
  const location = useLocation();
  const showSidebar = location.pathname.startsWith('/source/');

  return (
    <div className="flex h-screen bg-background">
      <Gutter sources={sources} />
      {showSidebar && <Sidebar sources={sources} isLoading={isLoading} />}
      <main className="flex-1 overflow-auto" aria-label="Main content">
        <Outlet />
      </main>
    </div>
  );
}
