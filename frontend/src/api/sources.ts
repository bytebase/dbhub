import type { DataSource } from '../types/datasource';
import { ApiError } from './errors';

const API_BASE = '/api';

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return response.json();
  }
  // Fallback to text if not JSON
  const text = await response.text();
  throw new ApiError(text || response.statusText, response.status, response.statusText);
}

export async function fetchSources(): Promise<DataSource[]> {
  try {
    const response = await fetch(`${API_BASE}/sources`);

    if (!response.ok) {
      const errorMessage = await parseJsonResponse<{ error: string }>(response)
        .then((data) => data.error)
        .catch(() => response.statusText);
      throw new ApiError(`Failed to fetch sources: ${errorMessage}`, response.status, response.statusText);
    }

    return response.json();
  } catch (err) {
    // Ensure all errors are ApiError instances
    if (err instanceof ApiError) {
      throw err;
    }
    // Network errors, timeout, etc.
    throw new ApiError(err instanceof Error ? err.message : 'Network error', 0);
  }
}

export async function fetchSource(sourceId: string): Promise<DataSource> {
  try {
    // Validate sourceId to prevent path traversal attacks
    if (!sourceId || sourceId.trim() === '') {
      throw new ApiError('Source ID cannot be empty', 400);
    }
    if (sourceId.includes('/') || sourceId.includes('..')) {
      throw new ApiError('Invalid source ID format', 400);
    }

    const response = await fetch(`${API_BASE}/sources/${encodeURIComponent(sourceId)}`);

    if (!response.ok) {
      const errorMessage = await parseJsonResponse<{ error: string }>(response)
        .then((data) => data.error)
        .catch(() => response.statusText);

      throw new ApiError(
        response.status === 404 ? `Source not found: ${sourceId}` : `Failed to fetch source: ${errorMessage}`,
        response.status,
        response.statusText
      );
    }

    return response.json();
  } catch (err) {
    // Ensure all errors are ApiError instances
    if (err instanceof ApiError) {
      throw err;
    }
    // Network errors, timeout, etc.
    throw new ApiError(err instanceof Error ? err.message : 'Network error', 0);
  }
}
