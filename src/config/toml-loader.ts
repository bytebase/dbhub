import fs from "fs";
import path from "path";
import { homedir } from "os";
import toml from "@iarna/toml";
import type { SourceConfig, TomlConfig } from "../types/config.js";
import { parseCommandLineArgs } from "./env.js";

/**
 * Load and parse TOML configuration file
 * Returns the parsed sources array and the source of the config file
 */
export function loadTomlConfig(): { sources: SourceConfig[]; source: string } | null {
  const configPath = resolveTomlConfigPath();
  if (!configPath) {
    return null;
  }

  try {
    const fileContent = fs.readFileSync(configPath, "utf-8");
    const parsedToml = toml.parse(fileContent) as unknown as TomlConfig;

    // Validate and process the configuration
    validateTomlConfig(parsedToml, configPath);
    const sources = processSourceConfigs(parsedToml.sources, configPath);

    return {
      sources,
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

  // Check if sources is an array
  if (!Array.isArray(config.sources)) {
    throw new Error(
      `Configuration file ${configPath}: 'sources' must be an array. ` +
        `Use [[sources]] syntax for array of tables in TOML.`
    );
  }

  // Check if sources array is not empty
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
          `Example: [[sources]]\\nid = "my_db"`
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

  // Validate max_rows if provided
  if (source.max_rows !== undefined) {
    if (typeof source.max_rows !== "number" || source.max_rows <= 0) {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' has invalid max_rows. ` +
          `Must be a positive integer.`
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
}

/**
 * Process source configurations (expand paths, etc.)
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

  // For other databases, require host, user, password, database
  if (!source.host || !source.user || !source.password || !source.database) {
    throw new Error(
      `Source '${source.id}': missing required connection parameters. ` +
        `Required: type, host, user, password, database`
    );
  }

  // Determine default port if not specified
  const port =
    source.port ||
    (source.type === "postgres"
      ? 5432
      : source.type === "mysql" || source.type === "mariadb"
        ? 3306
        : source.type === "sqlserver"
          ? 1433
          : undefined);

  if (!port) {
    throw new Error(`Source '${source.id}': unable to determine port`);
  }

  // Encode credentials
  const encodedUser = encodeURIComponent(source.user);
  const encodedPassword = encodeURIComponent(source.password);
  const encodedDatabase = encodeURIComponent(source.database);

  // Build DSN
  const dsn = `${source.type}://${encodedUser}:${encodedPassword}@${source.host}:${port}/${encodedDatabase}`;
  return dsn;
}
