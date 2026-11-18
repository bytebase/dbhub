/**
 * Shared arrangement for the tool handler unit tests. Every file using it must
 * `vi.mock('../../connectors/manager.js')` itself (vi.mock is per test file).
 */
import { describe, it, expect, vi } from 'vitest';
import { ConnectorManager } from '../../connectors/manager.js';
import { requestStore } from '../../requests/index.js';
import type { Connector, ConnectorType } from '../../connectors/interface.js';

/**
 * A connector whose required methods are bare vi.fn()s. The optional ones
 * (getHealthCheck, getTableRowCount, ...) stay absent unless passed in `extra`.
 */
export const createMockConnector = (
  id: ConnectorType = 'sqlite',
  sourceId: string = 'default',
  extra: Partial<Connector> = {}
): Connector => ({
  id,
  name: 'Mock Connector',
  getId: () => sourceId,
  dsnParser: {} as any,
  connect: vi.fn(),
  disconnect: vi.fn(),
  clone: vi.fn(),
  getSchemas: vi.fn(),
  getTables: vi.fn(),
  getViews: vi.fn(),
  getTableSchema: vi.fn(),
  getTableIndexes: vi.fn(),
  getStoredProcedures: vi.fn(),
  getStoredProcedureDetail: vi.fn(),
  executeSQL: vi.fn(),
  ...extra,
});

/** The JSON envelope a tool handler returned */
export const parseToolResponse = (response: any) => JSON.parse(response.content[0].text);

/**
 * Registers the request-tracking tests of a built-in tool: the trace must
 * carry the name the tool was registered under, which is not derivable from a
 * plain `sourceId === "default"` check (see resolveTrackedToolName). Each
 * built-in passes its own base name to that helper, so each is checked.
 *
 * @param callTool arranges a successful call and invokes the handler bound to `sourceId`
 */
export function describeRequestTracking(
  baseName: string,
  callTool: (sourceId: string) => Promise<unknown>
): void {
  describe('request tracking', () => {
    it.each([
      ['the bare tool name for a single source configured with --id (not "default")', ['prod'], 'prod', baseName],
      [
        'the normalized, suffixed tool name for a multi-source id with special characters',
        ['prod-pg', 'staging'],
        'prod-pg',
        `${baseName}_prod_pg`,
      ],
    ])('tracks %s', async (_, sourceIds, sourceId, toolName) => {
      vi.mocked(ConnectorManager.getAvailableSourceIds).mockReturnValue(sourceIds);
      const addSpy = vi.spyOn(requestStore, 'add').mockClear();

      await callTool(sourceId);

      expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({ toolName }));
    });
  });
}
