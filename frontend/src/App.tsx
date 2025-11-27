import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import HomeView from './components/views/HomeView';
import SourceDetailView from './components/views/SourceDetailView';
import NotFoundView from './components/views/NotFoundView';
import Toast from './components/Toast';
import ErrorBoundary from './components/ErrorBoundary';
import { fetchSources } from './api/sources';
import { ApiError } from './api/errors';
import type { DataSource } from './types/datasource';

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
            <Route index element={<HomeView />} />
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
