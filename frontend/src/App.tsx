import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import HomeView from './components/views/HomeView';
import SourceDetailView from './components/views/SourceDetailView';
import Toast from './components/Toast';
import { fetchSources } from './api/sources';
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
      .catch((error) => {
        console.error('Failed to fetch sources:', error);
        setError(error instanceof Error ? error.message : 'Failed to load data sources');
        setIsLoading(false);
      });
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout sources={sources} isLoading={isLoading} />}>
          <Route index element={<HomeView />} />
          <Route path="source/:sourceId" element={<SourceDetailView />} />
        </Route>
      </Routes>
      {error && <Toast message={error} type="error" onClose={() => setError(null)} />}
    </BrowserRouter>
  );
}

export default App
