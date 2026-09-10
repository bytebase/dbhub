/**
 * Configuration types for TOML-based multi-database setup
 */

/**
 * SSH tunnel configuration (inline per-source)
 */
export interface SSHConfig {
  ssh_host?: string;
  ssh_port?: number;
  ssh_user?: string;
  ssh_password?: string;
  ssh_key?: string;
  ssh_passphrase?: string;
  /**
   * ProxyJump configuration for multi-hop SSH connections.
   * Comma-separated list of jump hosts: "jump1.example.com,user@jump2.example.com:2222"
   */
  ssh_proxy_jump?: string;
  /** Interval in seconds between keepalive packets (default: 0 = disabled) */
  ssh_keepalive_interval?: number;
  /** Maximum number of missed keepalive responses before disconnecting (default: 3) */
  ssh_keepalive_count_max?: number;
  /**
   * SSH host key verification mode (MITM defense; CWE-295):
   * "strict" (default) | "accept-new" | "off". Also accepts OpenSSH synonyms
   * "yes"/"no". Omit to use the secure default ("strict").
   */
  ssh_host_key_check?: string;
  /**
   * known_hosts file path(s) used for host key verification (and appended to
   * under accept-new). A single path or a list. When omitted, OpenSSH defaults
   * (~/.ssh/known_hosts, ~/.ssh/known_hosts2) are used.
   */
  ssh_known_hosts?: string | string[];
  /**
   * Pinned SSH host key fingerprint ("SHA256:...") for the target server. When
   * set, it is the sole trust anchor for the target host, ahead of known_hosts.
   */
  ssh_host_fingerprint?: string;
}

/**
 * Database connection parameters (alternative to DSN)
 */
export interface ConnectionParams {
  type: "postgres" | "mysql" | "mariadb" | "sqlserver" | "sqlite";
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  aws_iam_auth?: boolean; // Enable AWS IAM auth token generation for RDS
  aws_region?: string; // AWS region required when aws_iam_auth is enabled
  aws_profile?: string; // Named AWS shared-config profile for RDS IAM auth
  instanceName?: string; // SQL Server named instance support
  sslmode?: "disable" | "require" | "verify-ca" | "verify-full"; // SSL mode for network databases (not applicable to SQLite, verify-* only applicable for PostgreSQL)
  sslrootcert?: string; // CA certificate path (requires verify-ca or verify-full)
  // SQL Server authentication options
  authentication?: "ntlm" | "azure-active-directory-access-token";
  domain?: string; // Required for NTLM authentication
}

/**
 * Source configuration from [[sources]] array in TOML
 */
export interface SourceConfig extends ConnectionParams, SSHConfig {
  id: string;
  description?: string; // Human-readable description of this data source
  dsn?: string;
  connection_timeout?: number; // Connection timeout in seconds
  query_timeout?: number; // Query timeout in seconds (PostgreSQL, MySQL, MariaDB, SQL Server)
  init_script?: string; // Optional SQL script to run on connection (for demo mode or initialization)
  lazy?: boolean; // Defer connection until first query (default: false)
  search_path?: string; // Comma-separated list of schemas for PostgreSQL search_path (e.g., "myschema,public")
  timezone?: string; // MySQL/MariaDB: how the driver interprets DATETIME values. "Z" (UTC), "local", or "±HH:MM" (e.g., "+09:00")
  charset?: string; // MySQL/MariaDB: connection character set (e.g., "utf8mb4"). May be combined with collation; when both are set, collation takes precedence (it implies its character set).
  collation?: string; // MySQL/MariaDB: connection collation (e.g., "utf8mb4_0900_ai_ci"). Takes precedence over charset when both are set.
}

/**
 * Custom tool parameter configuration
 */
export interface ParameterConfig {
  name: string;
  type: "string" | "integer" | "float" | "boolean" | "array";
  description: string;
  required?: boolean; // Defaults to true
  default?: any; // Makes parameter optional if set
  allowed_values?: any[]; // Enum constraint
}

/**
 * Built-in tool configuration for execute_sql
 */
export interface ExecuteSqlToolConfig {
  name: "execute_sql"; // Must match BUILTIN_TOOL_EXECUTE_SQL from builtin-tools.ts
  source: string;
  readonly?: boolean;
  max_rows?: number;
}

/**
 * Built-in tool configuration for search_objects
 */
export interface SearchObjectsToolConfig {
  name: "search_objects"; // Must match BUILTIN_TOOL_SEARCH_OBJECTS from builtin-tools.ts
  source: string;
}

/**
 * Built-in tool configuration for explain_sql
 */
export interface ExplainSqlToolConfig {
  name: "explain_sql"; // Must match BUILTIN_TOOL_EXPLAIN_SQL from builtin-tools.ts
  source: string;
}

/**
 * Built-in tool configuration for health_check
 */
export interface HealthCheckToolConfig {
  name: "health_check"; // Must match BUILTIN_TOOL_HEALTH_CHECK from builtin-tools.ts
  source: string;
}

/**
 * Custom tool configuration
 */
export interface CustomToolConfig {
  name: string; // Must not be "execute_sql" or "search_objects"
  source: string;
  description: string;
  statement: string;
  parameters?: ParameterConfig[];
  readonly?: boolean;
  max_rows?: number;
}

/**
 * Unified tool configuration (discriminated union)
 */
export type ToolConfig =
  | ExecuteSqlToolConfig
  | SearchObjectsToolConfig
  | ExplainSqlToolConfig
  | HealthCheckToolConfig
  | CustomToolConfig;

/**
 * Complete TOML configuration file structure
 */
export interface TomlConfig {
  sources: SourceConfig[];
  tools?: ToolConfig[];
}
