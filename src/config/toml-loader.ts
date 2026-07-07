import fs from "fs";
import path from "path";
import { homedir } from "os";
import toml from "@iarna/toml";
import type { SourceConfig, TomlConfig, ToolConfig } from "../types/config.js";
import { parseCommandLineArgs } from "./env.js";
import { parseConnectionInfoFromDSN, getDefaultPortForType } from "../utils/dsn-obfuscate.js";
import { SafeURL } from "../utils/safe-url.js";
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
    const rawToml = toml.parse(fileContent) as unknown as TomlConfig;

    // Interpolate environment variables (e.g., ${DB_PASSWORD}) in all string values
    const parsedToml = interpolateEnvVars(rawToml) as TomlConfig;

    // Basic structure check before processing
    if (!Array.isArray(parsedToml.sources)) {
      throw new Error(
        `Configuration file ${configPath}: must contain a [[sources]] array. ` +
          `Use [[sources]] syntax for array of tables in TOML.`
      );
    }

    // Process first to populate fields from DSN (like type), then validate
    const sources = processSourceConfigs(parsedToml.sources, configPath);

    // Tools referencing a disabled source are inert - drop them here so they
    // don't fail "unknown source" validation or get registered. Only sources
    // that actually exist and were explicitly disabled are exempted; a tool
    // pointing at a source id that never existed (e.g. a typo) still hits the
    // normal "unknown source" validation error below.
    const disabledSourceIds = new Set(
      parsedToml.sources.filter((s) => s.enabled === false).map((s) => s.id)
    );
    const tools = parsedToml.tools?.filter((tool) => !disabledSourceIds.has(tool.source));

    validateTomlConfig({ ...parsedToml, sources, tools }, configPath);

    return {
      sources,
      tools,
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
export function resolveTomlConfigPath(): string | null {
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
 * Read a query parameter's value from a DSN's raw query string, distinguishing
 * "absent" (returns null) from "present but empty" (returns "").
 *
 * SafeURL drops params whose value is empty (e.g. `?sslmode=`), which would make
 * an empty-but-present param look absent — causing conflict checks to be skipped
 * and the merge step to append a duplicate param. Scanning the raw query string
 * here avoids that.
 */
function getRawDSNQueryParam(dsn: string, key: string): string | null {
  const queryStart = dsn.indexOf("?");
  if (queryStart === -1) {
    return null;
  }
  for (const pair of dsn.substring(queryStart + 1).split("&")) {
    if (pair === "") {
      continue;
    }
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.substring(0, eq);
    if (rawKey === key) {
      const rawValue = eq === -1 ? "" : pair.substring(eq + 1);
      try {
        return decodeURIComponent(rawValue);
      } catch {
        return rawValue;
      }
    }
  }
  return null;
}

/**
 * Reject standalone fields that contradict a DSN.
 *
 * A DSN already encodes the connection identity (type/host/port/database/user/
 * password) and may carry query parameters (sslmode/sslrootcert plus the SQL
 * Server instanceName/authentication/domain). When the user also sets one of
 * those as a standalone field with a different value, the DSN wins at connection
 * time (buildDSNFromSource returns the DSN), so the field would be silently
 * ignored — we fail fast here instead.
 *
 * A field left unset never trips this check: processSourceConfigs() copies a
 * subset of these (type/host/port/database/user + sslmode/sslrootcert) from the
 * DSN into the source when the field is unset, so they end up matching.
 */
function validateDSNFieldConflicts(source: SourceConfig, configPath: string): void {
  const conflict = (field: string, fieldValue: string, dsnValue: string): never => {
    throw new Error(
      `Configuration file ${configPath}: source '${source.id}' has conflicting ${field}: ` +
        `the DSN specifies '${dsnValue}' but the ${field} field is '${fieldValue}'. ` +
        `Set ${field} in only one place, or make the two values match.`
    );
  };

  const info = parseConnectionInfoFromDSN(source.dsn!);

  // Reject a type field that disagrees with the DSN protocol. Checked before the
  // SQLite short-circuit below, and keyed off the DSN's parsed type rather than
  // source.type, so a `type = "sqlite"` paired with a non-SQLite DSN (or the
  // reverse) is still caught instead of silently skipped.
  if (source.type && info?.type && source.type !== info.type) {
    conflict("type", source.type, info.type);
  }

  // A SQLite DSN only carries a database path — no host/credentials or
  // query-string fields to cross-check.
  if (info?.type === "sqlite") {
    return;
  }

  let url: SafeURL;
  try {
    url = new SafeURL(source.dsn!);
  } catch {
    // DSN parse failures are surfaced by the connector; skip the conflict check
    return;
  }

  // Identity fields embedded in the DSN
  if (info) {
    // Hostnames are case-insensitive, so compare them normalized
    if (source.host && info.host && source.host.toLowerCase() !== info.host.toLowerCase()) {
      conflict("host", source.host, info.host);
    }
    if (source.port !== undefined && info.port !== undefined && source.port !== info.port) {
      conflict("port", String(source.port), String(info.port));
    }
    if (source.database && info.database && source.database !== info.database) {
      conflict("database", source.database, info.database);
    }
    if (source.user && info.user && source.user !== info.user) {
      conflict("user", source.user, info.user);
    }
  }

  // Password is never introspected into a field (omitted from API responses),
  // so compare against the DSN directly. Never echo the values.
  if (source.password && source.password !== url.password) {
    if (!url.password) {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' has a 'password' field but the DSN has no password. ` +
          `The field is ignored at connection time — add the password to the DSN, or use individual connection parameters instead of a DSN.`
      );
    }
    throw new Error(
      `Configuration file ${configPath}: source '${source.id}' has a 'password' field that conflicts ` +
        `with the password in the DSN. Set the password in only one place.`
    );
  }

  // Dual-home query-string fields. Use the raw query string (not SafeURL, which
  // drops empty-valued params) so a present-but-empty param like `?sslmode=` is
  // still treated as present and a conflicting field is rejected.
  const dsnSslmode = getRawDSNQueryParam(source.dsn!, "sslmode");
  if (source.sslmode && dsnSslmode !== null && dsnSslmode !== source.sslmode) {
    conflict("sslmode", source.sslmode, dsnSslmode);
  }

  const dsnSslrootcert = getRawDSNQueryParam(source.dsn!, "sslrootcert");
  if (
    source.sslrootcert &&
    dsnSslrootcert !== null &&
    expandHomeDir(source.sslrootcert) !== expandHomeDir(dsnSslrootcert)
  ) {
    conflict("sslrootcert", expandHomeDir(source.sslrootcert), expandHomeDir(dsnSslrootcert));
  }

  const dsnInstanceName = getRawDSNQueryParam(source.dsn!, "instanceName");
  if (source.instanceName && dsnInstanceName !== null && dsnInstanceName !== source.instanceName) {
    conflict("instanceName", source.instanceName, dsnInstanceName);
  }

  const dsnAuthentication = getRawDSNQueryParam(source.dsn!, "authentication");
  if (source.authentication && dsnAuthentication !== null && dsnAuthentication !== source.authentication) {
    conflict("authentication", source.authentication, dsnAuthentication);
  }

  const dsnDomain = getRawDSNQueryParam(source.dsn!, "domain");
  if (source.domain && dsnDomain !== null && dsnDomain !== source.domain) {
    conflict("domain", source.domain, dsnDomain);
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

  // Validate enabled field. Only a strict boolean `false` is treated as
  // "disabled" by processSourceConfigs' filter, so a non-boolean value (e.g.
  // a stringified "false" from an env var, or a number) would otherwise be
  // silently kept enabled instead of surfacing the user's mistake.
  if (source.enabled !== undefined && typeof source.enabled !== "boolean") {
    throw new Error(
      `Configuration file ${configPath}: source '${source.id}' has invalid enabled. ` +
        `Must be a boolean (true or false).`
    );
  }

  // Validate AWS IAM auth fields
  if (
    source.aws_iam_auth !== undefined &&
    typeof source.aws_iam_auth !== "boolean"
  ) {
    throw new Error(
      `Configuration file ${configPath}: source '${source.id}' has invalid aws_iam_auth. ` +
        `Must be a boolean (true or false).`
    );
  }

  if (source.aws_region !== undefined) {
    if (
      typeof source.aws_region !== "string" ||
      source.aws_region.trim().length === 0
    ) {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' has invalid aws_region. ` +
          `Must be a non-empty string (e.g., "eu-west-1").`
      );
    }
  }

  if (source.aws_iam_auth === true) {
    const validIamTypes = ["postgres", "mysql", "mariadb"];
    if (!source.type || !validIamTypes.includes(source.type)) {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' has aws_iam_auth enabled, ` +
          `but this is only supported for postgres, mysql, and mariadb sources.`
      );
    }
    if (!source.aws_region) {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' has aws_iam_auth enabled ` +
          `but aws_region is not specified.`
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

    const validSslModes = ["disable", "require", "verify-ca", "verify-full"];
    if (!validSslModes.includes(source.sslmode)) {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' has invalid sslmode '${source.sslmode}'. ` +
          `Valid values: ${validSslModes.join(", ")}`
      );
    }

    if (
      (source.sslmode === "verify-ca" || source.sslmode === "verify-full") &&
      source.type !== "postgres"
    ) {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' has sslmode '${source.sslmode}' which is only supported for PostgreSQL. ` +
          `Valid values for ${source.type}: disable, require`
      );
    }
  }

  // Reject fields that contradict the DSN. A DSN already encodes the connection
  // identity (type/host/port/database/user/password) and may carry query params
  // (sslmode/sslrootcert/instanceName/authentication/domain). When the same value
  // is also set as a standalone field with a different value, the field is
  // silently ignored at connection time, so we fail fast instead.
  if (source.dsn) {
    validateDSNFieldConflicts(source, configPath);
  }

  // Validate sslrootcert if provided
  if (source.sslrootcert !== undefined) {
    if (source.sslmode !== "verify-ca" && source.sslmode !== "verify-full") {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' has sslrootcert but sslmode is '${source.sslmode ?? "not set"}'. ` +
          `sslrootcert requires sslmode 'verify-ca' or 'verify-full'`
      );
    }

    const expandedPath = expandHomeDir(source.sslrootcert);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(expandedPath);
    } catch {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' sslrootcert file not found or not accessible: '${expandedPath}'`
      );
    }
    if (!stats.isFile()) {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' sslrootcert path is not a regular file: '${expandedPath}'`
      );
    }
    try {
      fs.accessSync(expandedPath, fs.constants.R_OK);
    } catch {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' sslrootcert file is not readable: '${expandedPath}'`
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

  // Validate search_path (PostgreSQL only)
  if (source.search_path !== undefined) {
    if (source.type !== "postgres") {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' has 'search_path' but it is only supported for PostgreSQL sources.`
      );
    }
    if (typeof source.search_path !== "string" || source.search_path.trim().length === 0) {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' has invalid search_path. ` +
          `Must be a non-empty string of comma-separated schema names (e.g., "myschema,public").`
      );
    }

  }

  // Validate timezone (MySQL/MariaDB only)
  if (source.timezone !== undefined) {
    if (source.type !== "mysql" && source.type !== "mariadb") {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' has 'timezone' but it is only supported for MySQL and MariaDB sources.`
      );
    }
    // Accepted by mysql2/mariadb drivers: "local", "Z", or "±HH:MM" (e.g., "+09:00").
    // The typeof guard is required: TOML can yield non-strings (e.g. arrays), and
    // RegExp.test() would coerce a single-element array like ["local"] to a passing
    // string before it reaches the driver as a non-string value.
    if (
      typeof source.timezone !== "string" ||
      !/^(?:local|Z|[+-]\d\d:\d\d)$/.test(source.timezone)
    ) {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' has invalid timezone '${source.timezone}'. ` +
          `Must be "local", "Z" (UTC), or an offset like "+09:00".`
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
  return sources
    .filter((source) => source.enabled !== false)
    .map((source) => {
    const processed = { ...source };

    // Expand ~ in SSH key path
    if (processed.ssh_key) {
      processed.ssh_key = expandHomeDir(processed.ssh_key);
    }

    // Expand ~ in sslrootcert path
    if (processed.sslrootcert) {
      processed.sslrootcert = expandHomeDir(processed.sslrootcert);
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

      try {
        const url = new SafeURL(processed.dsn);
        const dsnSslmode = url.getSearchParam("sslmode");
        if (!processed.sslmode && dsnSslmode) {
          processed.sslmode = dsnSslmode as SourceConfig["sslmode"];
        }
        const dsnSslrootcert = url.getSearchParam("sslrootcert");
        if (!processed.sslrootcert && dsnSslrootcert) {
          processed.sslrootcert = dsnSslrootcert;
        }
      } catch {
        // DSN parsing for query params is best-effort; connector will handle errors
      }
    }

    return processed;
  });
}

/**
 * Interpolate environment variables in configuration values.
 * Supports ${VAR_NAME} syntax, resolved from process.env at load time.
 * Unresolved variables are left as-is (no error thrown).
 */
const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;
export function interpolateEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_VAR_PATTERN, (match, varName) => {
      const envValue = process.env[varName];
      return envValue !== undefined ? envValue : match;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateEnvVars(item));
  }
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = interpolateEnvVars(val);
    }
    return result;
  }
  return value;
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
 * Merge "dual-home" fields (those that can be expressed either as a TOML field
 * or as a DSN query parameter) into an existing DSN. Only appends a param when
 * the DSN does not already specify it; conflicting values are rejected earlier
 * by validateSourceConfig, so any param already present is guaranteed to match.
 *
 * This mirrors the query parameters built by the connection-params path of
 * buildDSNFromSource so both paths produce equivalent DSNs.
 */
function mergeSourceFieldsIntoDSN(dsn: string, source: SourceConfig): string {
  // SQLite DSNs never carry these parameters
  if (source.type === "sqlite") {
    return dsn;
  }

  try {
    // Parse only to validate the DSN; if it can't be parsed, leave it untouched
    // and let the connector surface the error.
    new SafeURL(dsn);
  } catch {
    return dsn;
  }

  // Use raw key presence (not SafeURL, which drops empty-valued params) so we
  // never append a duplicate of a param the DSN already specifies, even as
  // `?sslmode=`. Such empty-but-present params are rejected by validation when a
  // conflicting field is set.
  const hasParam = (key: string): boolean => getRawDSNQueryParam(dsn, key) !== null;

  const additions: string[] = [];

  // SQL Server query parameters
  if (source.type === "sqlserver") {
    if (source.instanceName && !hasParam("instanceName")) {
      additions.push(`instanceName=${encodeURIComponent(source.instanceName)}`);
    }
    if (source.authentication && !hasParam("authentication")) {
      additions.push(`authentication=${encodeURIComponent(source.authentication)}`);
    }
    if (source.domain && !hasParam("domain")) {
      additions.push(`domain=${encodeURIComponent(source.domain)}`);
    }
  }

  if (source.sslmode && !hasParam("sslmode")) {
    additions.push(`sslmode=${source.sslmode}`);
  }

  if (
    source.sslrootcert &&
    source.type === "postgres" &&
    (source.sslmode === "verify-ca" || source.sslmode === "verify-full") &&
    !hasParam("sslrootcert")
  ) {
    const expandedCertPath = expandHomeDir(source.sslrootcert);
    additions.push(`sslrootcert=${encodeURIComponent(expandedCertPath)}`);
  }

  if (additions.length === 0) {
    return dsn;
  }

  // Pick the right join character: "?" when no query string exists yet, nothing
  // when the DSN already ends with "?" or "&" (an empty/trailing query string),
  // otherwise "&".
  let separator: string;
  if (!dsn.includes("?")) {
    separator = "?";
  } else if (dsn.endsWith("?") || dsn.endsWith("&")) {
    separator = "";
  } else {
    separator = "&";
  }
  return `${dsn}${separator}${additions.join("&")}`;
}

/**
 * Build DSN from source connection parameters
 * Similar to buildDSNFromEnvParams in env.ts but for TOML sources
 */
export function buildDSNFromSource(source: SourceConfig): string {
  // If DSN is already provided, use it — but merge in dual-home fields
  // (sslmode/sslrootcert/instanceName/authentication/domain) so they actually
  // affect the connection. Conflicts between the DSN query string and these
  // fields are rejected at validation time, so any param already present in the
  // DSN is guaranteed to match.
  if (source.dsn) {
    return mergeSourceFieldsIntoDSN(source.dsn, source);
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
  // Password is optional for Azure AD access token authentication and AWS IAM auth
  const isAwsIamPasswordless =
    source.aws_iam_auth === true &&
    ["postgres", "mysql", "mariadb"].includes(source.type);
  const passwordRequired =
    source.authentication !== "azure-active-directory-access-token" &&
    !isAwsIamPasswordless;
  if (!source.host || !source.user || !source.database) {
    throw new Error(
      `Source '${source.id}': missing required connection parameters. ` +
        `Required: type, host, user, database`
    );
  }
  if (passwordRequired && !source.password) {
    throw new Error(
      `Source '${source.id}': password is required. ` +
        `(Password is optional for azure-active-directory-access-token authentication ` +
        `or when aws_iam_auth=true)`
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

  if (
    source.sslrootcert &&
    source.type === "postgres" &&
    (source.sslmode === "verify-ca" || source.sslmode === "verify-full")
  ) {
    const expandedCertPath = expandHomeDir(source.sslrootcert);
    queryParams.push(`sslrootcert=${encodeURIComponent(expandedCertPath)}`);
  }

  // Append query string if any params exist
  if (queryParams.length > 0) {
    dsn += `?${queryParams.join("&")}`;
  }

  return dsn;
}
