import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar/Sidebar';
import type { DataSource } from '../types/datasource';

interface LayoutProps {
  sources: DataSource[];
  isLoading: boolean;
}

export default function Layout({ sources, isLoading }: LayoutProps) {
  return (
    <div className="flex h-screen bg-background">
      <Sidebar sources={sources} isLoading={isLoading} />
      <main className="flex-1 overflow-auto" aria-label="Main content">
        <Outlet />
      </main>
    </div>
  );
}
