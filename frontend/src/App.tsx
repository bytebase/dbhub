import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import SourceDetailView from './components/views/SourceDetailView';
import NotFoundView from './components/views/NotFoundView';
import Toast from './components/Toast';
import ErrorBoundary from './components/ErrorBoundary';
import { fetchSources } from './api/sources';
import { ApiError } from './api/errors';
import type { DataSource } from './types/datasource';

function RedirectToFirstSource({ sources, isLoading }: { sources: DataSource[]; isLoading: boolean }) {
  if (isLoading) {
    return (
      <div className="container mx-auto px-8 py-12">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (sources.length === 0) {
    // This should never happen as backend validates at least one source
    return (
      <div className="container mx-auto px-8 py-12">
        <div className="text-destructive">No data sources configured</div>
      </div>
    );
  }

  return <Navigate to={`/source/${sources[0].id}`} replace />;
}

function App() {
  const [sources, setSources] = useState<DataSource[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchSources()
      .then((data) => {
        setSources(data);
        setIsLoading(false);
      })
      .catch((err) => {
        console.error('Failed to fetch sources:', err);
        const message = err instanceof ApiError ? err.message : 'Failed to load data sources';
        setError(message);
        setIsLoading(false);
      });
  }, []);

  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Layout sources={sources} isLoading={isLoading} />}>
            <Route index element={<RedirectToFirstSource sources={sources} isLoading={isLoading} />} />
            <Route path="source/:sourceId" element={<SourceDetailView />} />
            <Route path="*" element={<NotFoundView />} />
          </Route>
        </Routes>
        {error && <Toast message={error} type="error" onClose={() => setError(null)} />}
      </BrowserRouter>
    </ErrorBoundary>
  );
}

export default App
