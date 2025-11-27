import type { RequestsResponse } from '../types/request';
import { ApiError } from './errors';

const API_BASE = '/api';

export async function fetchRequests(sourceId?: string): Promise<RequestsResponse> {
  try {
    const url = sourceId
      ? `${API_BASE}/requests?source_id=${encodeURIComponent(sourceId)}`
      : `${API_BASE}/requests`;

    const response = await fetch(url);

    if (!response.ok) {
      const errorMessage = await response
        .json()
        .then((data) => data.error)
        .catch(() => response.statusText);
      throw new ApiError(`Failed to fetch requests: ${errorMessage}`, response.status, response.statusText);
    }

    return response.json();
  } catch (err) {
    if (err instanceof ApiError) {
      throw err;
    }
    throw new ApiError(err instanceof Error ? err.message : 'Network error', 0);
  }
}
