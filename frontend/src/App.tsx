import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import HomeView from './components/views/HomeView';
import SourceDetailView from './components/views/SourceDetailView';
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

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="max-w-md p-6 bg-card border border-border rounded-lg">
          <h2 className="text-lg font-semibold text-foreground mb-2">Error Loading Sources</h2>
          <p className="text-sm text-muted-foreground mb-4">{error}</p>
          <button
            onClick={() => {
              setError(null);
              setIsLoading(true);
              fetchSources()
                .then((data) => {
                  setSources(data);
                  setIsLoading(false);
                })
                .catch((err) => {
                  console.error('Failed to fetch sources:', err);
                  setError(err instanceof Error ? err.message : 'Failed to load data sources');
                  setIsLoading(false);
                });
            }}
            className="px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout sources={sources} isLoading={isLoading} />}>
          <Route index element={<HomeView />} />
          <Route path="source/:sourceId" element={<SourceDetailView />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App
