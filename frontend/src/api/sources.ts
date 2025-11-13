import type { DataSource } from '../types/datasource';

const API_BASE = '/api';

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return response.json();
  }
  // Fallback to text if not JSON
  const text = await response.text();
  throw new Error(text || response.statusText);
}

export async function fetchSources(): Promise<DataSource[]> {
  const response = await fetch(`${API_BASE}/sources`);

  if (!response.ok) {
    const errorMessage = await parseJsonResponse<{ error: string }>(response)
      .then((data) => data.error)
      .catch(() => response.statusText);
    throw new Error(`Failed to fetch sources: ${errorMessage}`);
  }

  return response.json();
}

export async function fetchSource(sourceId: string): Promise<DataSource> {
  // Validate sourceId to prevent path traversal attacks
  if (!sourceId || sourceId.trim() === '') {
    throw new Error('Source ID cannot be empty');
  }
  if (sourceId.includes('/') || sourceId.includes('..')) {
    throw new Error('Invalid source ID format');
  }

  const response = await fetch(`${API_BASE}/sources/${encodeURIComponent(sourceId)}`);

  if (!response.ok) {
    const errorMessage = await parseJsonResponse<{ error: string }>(response)
      .then((data) => data.error)
      .catch(() => response.statusText);

    if (response.status === 404) {
      throw new Error(`Source not found: ${sourceId}`);
    }
    throw new Error(`Failed to fetch source: ${errorMessage}`);
  }

  return response.json();
}
