import { useEffect, useState } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { fetchSource } from '../../api/sources';
import { ApiError } from '../../api/errors';
import type { Tool } from '../../types/datasource';

export default function ToolDetailView() {
  const { sourceId, toolName } = useParams<{ sourceId: string; toolName: string }>();
  const [tool, setTool] = useState<Tool | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!sourceId || !toolName) return;

    setIsLoading(true);
    setError(null);

    fetchSource(sourceId)
      .then((source) => {
        const foundTool = source.tools.find((t) => t.name === toolName);
        setTool(foundTool || null);
        setIsLoading(false);
      })
      .catch((err: ApiError) => {
        setError(err);
        setIsLoading(false);
      });
  }, [sourceId, toolName]);

  if (!sourceId || !toolName) {
    return <Navigate to="/" replace />;
  }

  if (isLoading) {
    return (
      <div className="container mx-auto px-8 py-12">
        <div className="text-muted-foreground">Loading tool details...</div>
      </div>
    );
  }

  if (error) {
    if (error.status === 404) {
      return <Navigate to="/404" replace />;
    }

    return (
      <div className="container mx-auto px-8 py-12">
        <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-destructive mb-2">Error</h2>
          <p className="text-destructive/90">{error.message}</p>
        </div>
      </div>
    );
  }

  if (!tool) {
    return <Navigate to="/404" replace />;
  }

  return (
    <div className="container mx-auto px-8 py-12 max-w-4xl">
      <div className="space-y-4">
        <h1 className="text-3xl font-bold text-foreground font-mono">
          {tool.name}
        </h1>
        <p className="text-muted-foreground leading-relaxed">
          {tool.description}
        </p>
      </div>
    </div>
  );
}
