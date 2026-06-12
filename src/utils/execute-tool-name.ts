import type { ConnectorType } from "../connectors/interface.js";
import { normalizeSourceId } from "./normalize-id.js";

export const PUBLIC_TOOL_EXECUTE_SQL = "execute_sql";
export const PUBLIC_TOOL_EXECUTE_REDIS = "execute_redis";

/**
 * Return the externally exposed execute tool name for a source.
 *
 * The internal built-in config name remains "execute_sql" for compatibility,
 * but Redis should not be exposed to clients as an SQL tool.
 */
export function getExecuteToolPublicName(
  connectorType: ConnectorType | undefined,
  sourceId: string,
  isSingleSource: boolean
): string {
  const baseName = connectorType === "redis"
    ? PUBLIC_TOOL_EXECUTE_REDIS
    : PUBLIC_TOOL_EXECUTE_SQL;

  return isSingleSource ? baseName : `${baseName}_${normalizeSourceId(sourceId)}`;
}
