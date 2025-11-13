import type { DataSource } from '../types/datasource';

const API_BASE = '/api';

export async function fetchSources(): Promise<DataSource[]> {
  const response = await fetch(`${API_BASE}/sources`);

  if (!response.ok) {
    throw new Error(`Failed to fetch sources: ${response.statusText}`);
  }

  return response.json();
}

export async function fetchSource(sourceId: string): Promise<DataSource> {
  const response = await fetch(`${API_BASE}/sources/${sourceId}`);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Source not found: ${sourceId}`);
    }
    throw new Error(`Failed to fetch source: ${response.statusText}`);
  }

  return response.json();
}
