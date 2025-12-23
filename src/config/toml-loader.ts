import fs from "fs";
import path from "path";
import { homedir } from "os";
import toml from "@iarna/toml";
import type { SourceConfig, TomlConfig, ToolConfig } from "../types/config.js";
import { parseCommandLineArgs } from "./env.js";
import { parseConnectionInfoFromDSN, getDefaultPortForType } from "../utils/dsn-obfuscate.js";
import { BUILTIN_TOOLS, BUILTIN_TOOL_EXECUTE_SQL, BUILTIN_TOOL_SEARCH_OBJECTS } from "../tools/builtin-tools.js";

/**
 * Load and parse TOML configuration file
 * Returns the parsed sources array, tools array, and the source of the config file
 */
export function loadTomlConfig(): { sources: SourceConfig[]; tools?: TomlConfig['tools']; source: string } | null {
  const configPath = resolveTomlConfigPath();
  if (!configPath) {
    return null;
  }

  try {
    const fileContent = fs.readFileSync(configPath, "utf-8");
    const parsedToml = toml.parse(fileContent) as unknown as TomlConfig;

    // Basic structure check before processing
    if (!Array.isArray(parsedToml.sources)) {
      throw new Error(
        `Configuration file ${configPath}: must contain a [[sources]] array. ` +
          `Use [[sources]] syntax for array of tables in TOML.`
      );
    }

    // Process first to populate fields from DSN (like type), then validate
    const sources = processSourceConfigs(parsedToml.sources, configPath);
    validateTomlConfig({ ...parsedToml, sources }, configPath);

    return {
      sources,
      tools: parsedToml.tools,
      source: path.basename(configPath),
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(
        `Failed to load TOML configuration from ${configPath}: ${error.message}`
      );
    }
    throw error;
  }
}

/**
 * Resolve the path to the TOML configuration file
 * Priority: --config flag > ./dbhub.toml
 */
function resolveTomlConfigPath(): string | null {
  const args = parseCommandLineArgs();

  // 1. Check for --config flag (highest priority)
  if (args.config) {
    const configPath = expandHomeDir(args.config);
    if (!fs.existsSync(configPath)) {
      throw new Error(
        `Configuration file specified by --config flag not found: ${configPath}`
      );
    }
    return configPath;
  }

  // 2. Check for dbhub.toml in current directory
  const defaultConfigPath = path.join(process.cwd(), "dbhub.toml");
  if (fs.existsSync(defaultConfigPath)) {
    return defaultConfigPath;
  }

  return null;
}

/**
 * Validate the structure of the parsed TOML configuration
 */
function validateTomlConfig(config: TomlConfig, configPath: string): void {
  // Check if sources array exists
  if (!config.sources) {
    throw new Error(
      `Configuration file ${configPath} must contain a [[sources]] array. ` +
        `Example:\n\n[[sources]]\nid = "my_db"\ndsn = "postgres://..."`
    );
  }

  // Check if sources array is not empty
  // Note: Array check is done in loadTomlConfig before processing
  if (config.sources.length === 0) {
    throw new Error(
      `Configuration file ${configPath}: sources array cannot be empty. ` +
        `Please define at least one source with [[sources]].`
    );
  }

  // Check for duplicate IDs
  const ids = new Set<string>();
  const duplicates: string[] = [];

  for (const source of config.sources) {
    if (!source.id) {
      throw new Error(
        `Configuration file ${configPath}: each source must have an 'id' field. ` +
          `Example: [[sources]]\nid = "my_db"`
      );
    }

    if (ids.has(source.id)) {
      duplicates.push(source.id);
    } else {
      ids.add(source.id);
    }
  }

  if (duplicates.length > 0) {
    throw new Error(
      `Configuration file ${configPath}: duplicate source IDs found: ${duplicates.join(", ")}. ` +
        `Each source must have a unique 'id' field.`
    );
  }

  // Validate each source has either DSN or sufficient connection parameters
  for (const source of config.sources) {
    validateSourceConfig(source, configPath);
  }

  // Validate tools configuration
  if (config.tools) {
    validateToolsConfig(config.tools, config.sources, configPath);
  }
}

/**
 * Validate tools configuration
 */
function validateToolsConfig(
  tools: ToolConfig[],
  sources: SourceConfig[],
  configPath: string
): void {
  // Check for duplicate tool+source combinations
  const toolSourcePairs = new Set<string>();

  for (const tool of tools) {
    if (!tool.name) {
      throw new Error(
        `Configuration file ${configPath}: all tools must have a 'name' field`
      );
    }

    if (!tool.source) {
      throw new Error(
        `Configuration file ${configPath}: tool '${tool.name}' must have a 'source' field`
      );
    }

    // Check for duplicate tool+source combination
    const pairKey = `${tool.name}:${tool.source}`;
    if (toolSourcePairs.has(pairKey)) {
      throw new Error(
        `Configuration file ${configPath}: duplicate tool configuration found for '${tool.name}' on source '${tool.source}'`
      );
    }
    toolSourcePairs.add(pairKey);

    // Validate source reference exists
    if (!sources.some((s) => s.id === tool.source)) {
      throw new Error(
        `Configuration file ${configPath}: tool '${tool.name}' references unknown source '${tool.source}'`
      );
    }

    // Validate based on tool type (built-in vs custom)
    const isBuiltin = (BUILTIN_TOOLS as readonly string[]).includes(tool.name);
    const isExecuteSql = tool.name === BUILTIN_TOOL_EXECUTE_SQL;

    if (isBuiltin) {
      // Built-in tools should NOT have custom tool fields
      if (tool.description || tool.statement || tool.parameters) {
        throw new Error(
          `Configuration file ${configPath}: built-in tool '${tool.name}' cannot have description, statement, or parameters fields`
        );
      }

      // Only execute_sql can have readonly and max_rows
      if (!isExecuteSql && (tool.readonly !== undefined || tool.max_rows !== undefined)) {
        throw new Error(
          `Configuration file ${configPath}: tool '${tool.name}' cannot have readonly or max_rows fields ` +
            `(these are only valid for ${BUILTIN_TOOL_EXECUTE_SQL} tool)`
        );
      }
    } else {
      // Custom tools MUST have description and statement
      if (!tool.description || !tool.statement) {
        throw new Error(
          `Configuration file ${configPath}: custom tool '${tool.name}' must have 'description' and 'statement' fields`
        );
      }
    }

    // Validate max_rows if provided
    if (tool.max_rows !== undefined) {
      if (typeof tool.max_rows !== "number" || tool.max_rows <= 0) {
        throw new Error(
          `Configuration file ${configPath}: tool '${tool.name}' has invalid max_rows. Must be a positive integer.`
        );
      }
    }

    // Validate readonly if provided
    if (tool.readonly !== undefined && typeof tool.readonly !== "boolean") {
      throw new Error(
        `Configuration file ${configPath}: tool '${tool.name}' has invalid readonly. Must be a boolean (true or false).`
      );
    }
  }
}

/**
 * Validate a single source configuration
 */
function validateSourceConfig(source: SourceConfig, configPath: string): void {
  const hasConnectionParams =
    source.type && (source.type === "sqlite" ? source.database : source.host);

  if (!source.dsn && !hasConnectionParams) {
    throw new Error(
      `Configuration file ${configPath}: source '${source.id}' must have either:\n` +
        `  - 'dsn' field (e.g., dsn = "postgres://user:pass@host:5432/dbname")\n` +
        `  - OR connection parameters (type, host, database, user, password)\n` +
        `  - For SQLite: type = "sqlite" and database path`
    );
  }

  // Validate type if provided
  if (source.type) {
    const validTypes = ["postgres", "mysql", "mariadb", "sqlserver", "sqlite"];
    if (!validTypes.includes(source.type)) {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' has invalid type '${source.type}'. ` +
          `Valid types: ${validTypes.join(", ")}`
      );
    }
  }

  // Validate connection_timeout if provided
  if (source.connection_timeout !== undefined) {
    if (typeof source.connection_timeout !== "number" || source.connection_timeout <= 0) {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' has invalid connection_timeout. ` +
          `Must be a positive number (in seconds).`
      );
    }
  }

  // Validate query_timeout if provided
  if (source.query_timeout !== undefined) {
    if (typeof source.query_timeout !== "number" || source.query_timeout <= 0) {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' has invalid query_timeout. ` +
          `Must be a positive number (in seconds).`
      );
    }
  }

  // Validate SSH port if provided
  if (source.ssh_port !== undefined) {
    if (
      typeof source.ssh_port !== "number" ||
      source.ssh_port <= 0 ||
      source.ssh_port > 65535
    ) {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' has invalid ssh_port. ` +
          `Must be between 1 and 65535.`
      );
    }
  }

  // Validate sslmode if provided
  if (source.sslmode !== undefined) {
    // SQLite doesn't support SSL (local file-based database)
    if (source.type === "sqlite") {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' has sslmode but SQLite does not support SSL. ` +
          `Remove the sslmode field for SQLite sources.`
      );
    }

    const validSslModes = ["disable", "require"];
    if (!validSslModes.includes(source.sslmode)) {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' has invalid sslmode '${source.sslmode}'. ` +
          `Valid values: ${validSslModes.join(", ")}`
      );
    }
  }

  // Validate SQL Server authentication options
  // Note: source.type is already populated from DSN by processSourceConfigs
  if (source.authentication !== undefined) {
    // authentication is only valid for SQL Server
    if (source.type !== "sqlserver") {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' has authentication but it is only supported for SQL Server.`
      );
    }

    const validAuthMethods = ["ntlm", "azure-active-directory-access-token"];
    if (!validAuthMethods.includes(source.authentication)) {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' has invalid authentication '${source.authentication}'. ` +
          `Valid values: ${validAuthMethods.join(", ")}`
      );
    }

    // NTLM requires domain
    if (source.authentication === "ntlm" && !source.domain) {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' uses NTLM authentication but 'domain' is not specified.`
      );
    }
  }

  // Validate domain field
  if (source.domain !== undefined) {
    // domain is only valid for SQL Server
    if (source.type !== "sqlserver") {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' has domain but it is only supported for SQL Server.`
      );
    }

    // domain requires authentication=ntlm
    if (source.authentication === undefined) {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' has domain but authentication is not set. ` +
          `Add authentication = "ntlm" to use Windows domain authentication.`
      );
    }
    if (source.authentication !== "ntlm") {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' has domain but authentication is set to '${source.authentication}'. ` +
          `Domain is only valid with authentication = "ntlm".`
      );
    }
  }

  // Reject readonly and max_rows at source level (they should be set on tools instead)
  if ((source as any).readonly !== undefined) {
    throw new Error(
      `Configuration file ${configPath}: source '${source.id}' has 'readonly' field, but readonly must be configured per-tool, not per-source. ` +
        `Move 'readonly' to [[tools]] configuration instead.`
    );
  }
  if ((source as any).max_rows !== undefined) {
    throw new Error(
      `Configuration file ${configPath}: source '${source.id}' has 'max_rows' field, but max_rows must be configured per-tool, not per-source. ` +
        `Move 'max_rows' to [[tools]] configuration instead.`
    );
  }
}

/**
 * Process source configurations (expand paths, populate fields from DSN)
 */
function processSourceConfigs(
  sources: SourceConfig[],
  configPath: string
): SourceConfig[] {
  return sources.map((source) => {
    const processed = { ...source };

    // Expand ~ in SSH key path
    if (processed.ssh_key) {
      processed.ssh_key = expandHomeDir(processed.ssh_key);
    }

    // Expand ~ in SQLite database path (if relative)
    if (processed.type === "sqlite" && processed.database) {
      processed.database = expandHomeDir(processed.database);
    }

    // Expand ~ in DSN for SQLite
    if (processed.dsn && processed.dsn.startsWith("sqlite:///~")) {
      processed.dsn = `sqlite:///${expandHomeDir(processed.dsn.substring(11))}`;
    }

    // Parse DSN to populate connection info fields (if not already set)
    // This ensures API responses include host/port/database/user even when DSN is used
    if (processed.dsn) {
      const connectionInfo = parseConnectionInfoFromDSN(processed.dsn);
      if (connectionInfo) {
        // Only set fields that aren't already explicitly configured
        if (!processed.type && connectionInfo.type) {
          processed.type = connectionInfo.type;
        }
        if (!processed.host && connectionInfo.host) {
          processed.host = connectionInfo.host;
        }
        if (processed.port === undefined && connectionInfo.port !== undefined) {
          processed.port = connectionInfo.port;
        }
        if (!processed.database && connectionInfo.database) {
          processed.database = connectionInfo.database;
        }
        if (!processed.user && connectionInfo.user) {
          processed.user = connectionInfo.user;
        }
      }
    }

    return processed;
  });
}

/**
 * Expand ~ to home directory in paths
 */
function expandHomeDir(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return path.join(homedir(), filePath.substring(2));
  }
  return filePath;
}

/**
 * Build DSN from source connection parameters
 * Similar to buildDSNFromEnvParams in env.ts but for TOML sources
 */
export function buildDSNFromSource(source: SourceConfig): string {
  // If DSN is already provided, use it
  if (source.dsn) {
    return source.dsn;
  }

  // Validate required fields
  if (!source.type) {
    throw new Error(
      `Source '${source.id}': 'type' field is required when 'dsn' is not provided`
    );
  }

  // Handle SQLite
  if (source.type === "sqlite") {
    if (!source.database) {
      throw new Error(
        `Source '${source.id}': 'database' field is required for SQLite`
      );
    }
    return `sqlite:///${source.database}`;
  }

  // For other databases, require host, user, database
  // Password is optional for Azure AD access token authentication
  const passwordRequired = source.authentication !== "azure-active-directory-access-token";
  if (!source.host || !source.user || !source.database) {
    throw new Error(
      `Source '${source.id}': missing required connection parameters. ` +
        `Required: type, host, user, database`
    );
  }
  if (passwordRequired && !source.password) {
    throw new Error(
      `Source '${source.id}': password is required. ` +
        `(Password is optional only for azure-active-directory-access-token authentication)`
    );
  }

  // Determine default port if not specified
  const port = source.port || getDefaultPortForType(source.type);

  if (!port) {
    throw new Error(`Source '${source.id}': unable to determine port`);
  }

  // Encode credentials
  const encodedUser = encodeURIComponent(source.user);
  const encodedPassword = source.password ? encodeURIComponent(source.password) : "";
  const encodedDatabase = encodeURIComponent(source.database);

  // Build base DSN
  let dsn = `${source.type}://${encodedUser}:${encodedPassword}@${source.host}:${port}/${encodedDatabase}`;

  // Collect query parameters
  const queryParams: string[] = [];

  // Add SQL Server specific parameters
  if (source.type === "sqlserver") {
    if (source.instanceName) {
      queryParams.push(`instanceName=${encodeURIComponent(source.instanceName)}`);
    }
    if (source.authentication) {
      queryParams.push(`authentication=${encodeURIComponent(source.authentication)}`);
    }
    if (source.domain) {
      queryParams.push(`domain=${encodeURIComponent(source.domain)}`);
    }
  }

  // Add sslmode for network databases (not sqlite)
  if (source.sslmode && source.type !== "sqlite") {
    queryParams.push(`sslmode=${source.sslmode}`);
  }

  // Append query string if any params exist
  if (queryParams.length > 0) {
    dsn += `?${queryParams.join("&")}`;
  }

  return dsn;
}
