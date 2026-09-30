import { Request, Response } from "express";
import { ConnectorManager } from "../connectors/manager.js";
import { ConnectorRegistry } from "../connectors/interface.js";
import { validateRuntimeSourceConfig } from "../config/toml-loader.js";
import { redactDSN } from "../config/env.js";
import { getToolRegistry } from "../tools/registry.js";
import { getDatabaseTypeFromDSN } from "../utils/dsn-obfuscate.js";
import { getToolsForSource } from "../utils/tool-metadata.js";
import { isFileSource, withSourceLock } from "../utils/source-mutation.js";
import type { ExecuteSqlToolConfig, SearchObjectsToolConfig, SourceConfig, ToolConfig } from "../types/config.js";
import type { components } from "./openapi.js";

type DataSource = components["schemas"]["DataSource"];
type SSHTunnel = components["schemas"]["SSHTunnel"];
type ErrorResponse = components["schemas"]["Error"];
type SourceUpsert = components["schemas"]["SourceUpsert"];

// Source ids double as tool-name suffixes, so they stay in the safe MCP tool-name alphabet.
const SOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface SourceMutationOptions {
  /** Runtime source changes are only allowed when the HTTP transport requires a bearer token. */
  mutable: boolean;
}

/**
 * Transform a SourceConfig into an API DataSource response
 * Excludes sensitive fields like passwords and SSH credentials
 */
function transformSourceConfig(source: SourceConfig): DataSource {
  // Determine type from explicit config or infer from DSN
  if (!source.type && source.dsn) {
    const inferredType = getDatabaseTypeFromDSN(source.dsn);
    if (inferredType) {
      source.type = inferredType;
    }
  }

  if (!source.type) {
    throw new Error(`Source ${source.id} is missing required type field`);
  }

  const dataSource: DataSource = {
    id: source.id,
    type: source.type,
    tools: [],
  };

  // Add description if present
  if (source.description) {
    dataSource.description = source.description;
  }

  // Add connection details (excluding password)
  if (source.host) {
    dataSource.host = source.host;
  }
  if (source.port !== undefined) {
    dataSource.port = source.port;
  }
  if (source.database) {
    dataSource.database = source.database;
  }
  if (source.user) {
    dataSource.user = source.user;
  }

  // Add SSH tunnel configuration (excluding credentials)
  if (source.ssh_host) {
    const sshTunnel: SSHTunnel = {
      enabled: true,
      ssh_host: source.ssh_host,
    };

    if (source.ssh_port !== undefined) {
      sshTunnel.ssh_port = source.ssh_port;
    }
    if (source.ssh_user) {
      sshTunnel.ssh_user = source.ssh_user;
    }

    dataSource.ssh_tunnel = sshTunnel;
  }

  // Add tools for this source
  dataSource.tools = getToolsForSource(source.id);

  return dataSource;
}

/**
 * GET /api/sources
 * List all data sources
 */
export function listSources(req: Request, res: Response): void {
  try {
    const sourceConfigs = ConnectorManager.getAllSourceConfigs();

    // Transform configs to API response format
    const sources: DataSource[] = sourceConfigs.map((config) => {
      return transformSourceConfig(config);
    });

    res.json(sources);
  } catch (error) {
    console.error("Error listing sources:", error);
    const errorResponse: ErrorResponse = {
      error: error instanceof Error ? error.message : "Internal server error",
    };
    res.status(500).json(errorResponse);
  }
}

/**
 * GET /api/sources/:sourceId
 * Get a specific data source by ID
 */
export function getSource(req: Request, res: Response): void {
  try {
    const sourceId = req.params.sourceId;

    // Get source config - will be null if source doesn't exist
    const sourceConfig = ConnectorManager.getSourceConfig(sourceId);
    if (!sourceConfig) {
      const errorResponse: ErrorResponse = {
        error: "Source not found",
        source_id: sourceId,
      };
      res.status(404).json(errorResponse);
      return;
    }

    // Transform and return
    const dataSource = transformSourceConfig(sourceConfig);
    res.json(dataSource);
  } catch (error) {
    console.error(`Error getting source ${req.params.sourceId}:`, error);
    const errorResponse: ErrorResponse = {
      error: error instanceof Error ? error.message : "Internal server error",
    };
    res.status(500).json(errorResponse);
  }
}

/**
 * PUT /api/sources/:sourceId and DELETE /api/sources/:sourceId
 * Add, replace, or remove one source at runtime without touching the others.
 * Sources defined by the startup configuration are immutable here (409).
 */
export function createSourceMutationHandlers(options: SourceMutationOptions): {
  putSource: (req: Request, res: Response) => Promise<void>;
  deleteSource: (req: Request, res: Response) => Promise<void>;
} {
  const guard = (sourceId: string, res: Response): boolean => {
    if (!options.mutable) {
      res.status(403).json({
        error: "Runtime source changes require a bearer token (--auth-token / DBHUB_AUTH_TOKEN)",
        source_id: sourceId,
      } satisfies ErrorResponse);
      return false;
    }
    if (!SOURCE_ID_PATTERN.test(sourceId)) {
      res.status(400).json({
        error: "Source id must match [A-Za-z0-9_-]{1,64}",
        source_id: sourceId,
      } satisfies ErrorResponse);
      return false;
    }
    if (isFileSource(sourceId)) {
      res.status(409).json({
        error: "Source is defined by the startup configuration and cannot be changed over the API",
        source_id: sourceId,
      } satisfies ErrorResponse);
      return false;
    }
    return true;
  };

  const putSource = async (req: Request, res: Response): Promise<void> => {
    const sourceId = req.params.sourceId;
    if (!guard(sourceId, res)) {
      return;
    }

    let source: SourceConfig;
    let tools: ToolConfig[];
    try {
      ({ source, tools } = buildRuntimeSource(sourceId, req.body));
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : "Invalid source",
        source_id: sourceId,
      } satisfies ErrorResponse);
      return;
    }

    try {
      await withSourceLock(async () => {
        await ConnectorManager.addSource(source);
        getToolRegistry().setSourceTools(sourceId, tools);
      });
    } catch (error) {
      // A failed add leaves no source behind; a failed replace already removed the old one.
      getToolRegistry().removeSource(sourceId);
      const message = error instanceof Error ? error.message : "Failed to add source";
      res.status(502).json({
        error: message.split(source.dsn!).join(redactDSN(source.dsn!)),
        source_id: sourceId,
      } satisfies ErrorResponse);
      return;
    }

    console.error(`Source '${sourceId}' ${source.lazy ? "registered" : "connected"} via API`);
    res.json(transformSourceConfig(ConnectorManager.getSourceConfig(sourceId)!));
  };

  const deleteSource = async (req: Request, res: Response): Promise<void> => {
    const sourceId = req.params.sourceId;
    if (!guard(sourceId, res)) {
      return;
    }

    const removed = await withSourceLock(async () => {
      const found = await ConnectorManager.removeSource(sourceId);
      if (found) {
        getToolRegistry().removeSource(sourceId);
      }
      return found;
    });
    if (!removed) {
      res.status(404).json({ error: "Source not found", source_id: sourceId } satisfies ErrorResponse);
      return;
    }

    console.error(`Source '${sourceId}' removed via API`);
    res.status(204).end();
  };

  return { putSource, deleteSource };
}

/**
 * Turn a PUT body into a validated SourceConfig plus its two built-in tools.
 * Throws with a message safe to return to the caller (never echoes the DSN).
 */
function buildRuntimeSource(sourceId: string, body: unknown): { source: SourceConfig; tools: ToolConfig[] } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body must be a JSON object");
  }
  const input = body as Partial<SourceUpsert>;

  if (typeof input.dsn !== "string" || input.dsn.trim() === "") {
    throw new Error("'dsn' is required");
  }
  const dsn = input.dsn.trim();
  const type = getDatabaseTypeFromDSN(dsn);
  if (!type || !ConnectorRegistry.getConnectorForDSN(dsn)) {
    throw new Error("'dsn' scheme is not supported");
  }

  const optionalString = (key: "description"): string | undefined => {
    const value = input[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw new Error(`'${key}' must be a string`);
    return value;
  };
  const optionalBoolean = (key: "lazy" | "readonly", fallback: boolean): boolean => {
    const value = input[key];
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "boolean") throw new Error(`'${key}' must be a boolean`);
    return value;
  };
  const optionalPositiveInt = (key: "max_rows" | "query_timeout" | "connection_timeout"): number | undefined => {
    const value = input[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new Error(`'${key}' must be a positive integer`);
    }
    return value;
  };

  const source: SourceConfig = {
    id: sourceId,
    dsn,
    type,
    description: optionalString("description"),
    lazy: optionalBoolean("lazy", true),
    query_timeout: optionalPositiveInt("query_timeout"),
    connection_timeout: optionalPositiveInt("connection_timeout"),
  };
  validateRuntimeSourceConfig(source);

  const executeSql: ExecuteSqlToolConfig = {
    name: "execute_sql",
    source: sourceId,
    readonly: optionalBoolean("readonly", true),
    max_rows: optionalPositiveInt("max_rows"),
  };
  const searchObjects: SearchObjectsToolConfig = { name: "search_objects", source: sourceId };
  return { source, tools: [executeSql, searchObjects] };
}
