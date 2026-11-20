import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import Gutter from './Gutter';
import Sidebar from './Sidebar/Sidebar';
import { Button } from './ui/button';
import { Sheet, SheetTrigger, SheetPopup, SheetTitle, SheetClose } from './ui/sheet';
import { useIsMobile } from '../hooks/use-mobile';
import type { DataSource } from '../types/datasource';

interface LayoutProps {
  sources: DataSource[];
  isLoading: boolean;
}

export default function Layout({ sources, isLoading }: LayoutProps) {
  const location = useLocation();
  const showSidebar = location.pathname.startsWith('/source/');
  const [navigationOpen, setNavigationOpen] = useState(false);
  const isMobile = useIsMobile();

  useEffect(() => {
    setNavigationOpen(false);
  }, [location.pathname, isMobile]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-canvas md:flex-row">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:p-3 focus:outline-2 focus:outline-ring">
        Skip to content
      </a>
      <div className="hidden min-h-0 md:flex">
        <Gutter sources={sources} />
        {showSidebar && <Sidebar sources={sources} isLoading={isLoading} />}
      </div>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b-[length:var(--border-hairline)] border-border bg-sidebar px-3 md:hidden">
        <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}>
          <SheetTrigger render={<Button variant="ghost" size="icon-xl" aria-label="Open navigation" className="touch-manipulation" />}>
            <Menu aria-hidden="true" />
          </SheetTrigger>
          <SheetPopup side="left" showCloseButton={false} className="w-[min(24rem,100%)] motion-reduce:transition-none">
            <div className="flex h-14 shrink-0 items-center justify-between border-b-[length:var(--border-hairline)] border-border px-3">
              <SheetTitle className="text-label">Navigation</SheetTitle>
              <SheetClose render={<Button variant="ghost" size="icon-xl" aria-label="Close navigation" className="touch-manipulation" />}>
                <X aria-hidden="true" />
              </SheetClose>
            </div>
            <div className="flex min-h-0 flex-1" onClick={(event) => {
              if ((event.target as HTMLElement).closest('a[href]')) setNavigationOpen(false);
            }}>
              <Gutter sources={sources} />
              <Sidebar sources={sources} isLoading={isLoading} />
            </div>
          </SheetPopup>
        </Sheet>
        <span className="text-label">DBHub Workbench</span>
      </header>
      <main id="main-content" tabIndex={-1} className="min-h-0 min-w-0 flex-1 overflow-auto [scrollbar-gutter:stable] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring" aria-label="Main content">
        <Outlet />
      </main>
    </div>
  );
}
