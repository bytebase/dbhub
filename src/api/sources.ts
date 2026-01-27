import { Request, Response } from "express";
import { ConnectorManager } from "../connectors/manager.js";
import { getDatabaseTypeFromDSN } from "../utils/dsn-obfuscate.js";
import { getToolsForSource } from "../utils/tool-metadata.js";
import type { SourceConfig } from "../types/config.js";
import type { components } from "./openapi.js";

type DataSource = components["schemas"]["DataSource"];
type SSHTunnel = components["schemas"]["SSHTunnel"];
type ErrorResponse = components["schemas"]["Error"];

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
