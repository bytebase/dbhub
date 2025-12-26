import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import HomeRedirect from './components/views/HomeRedirect';
import RequestView from './components/views/RequestView';
import SourceDetailView from './components/views/SourceDetailView';
import ToolDetailView from './components/views/ToolDetailView';
import NotFoundView from './components/views/NotFoundView';
import { ToastProvider, toastManager } from './components/ui/toast';
import ErrorBoundary from './components/ErrorBoundary';
import { fetchSources } from './api/sources';
import { ApiError } from './api/errors';
import type { DataSource } from './types/datasource';

function App() {
  const [sources, setSources] = useState<DataSource[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetchSources()
      .then((data) => {
        setSources(data);
        setIsLoading(false);
      })
      .catch((err) => {
        console.error('Failed to fetch sources:', err);
        const message = err instanceof ApiError ? err.message : 'Failed to load data sources';
        toastManager.add({ title: message, type: 'error' });
        setIsLoading(false);
      });
  }, []);

  return (
    <ErrorBoundary>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Layout sources={sources} isLoading={isLoading} />}>
              <Route index element={<HomeRedirect />} />
              <Route path="requests" element={<RequestView />} />
              <Route path="source/:sourceId" element={<SourceDetailView />} />
              <Route path="source/:sourceId/tool/:toolName" element={<ToolDetailView />} />
              <Route path="*" element={<NotFoundView />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </ErrorBoundary>
  );
}

export default App
