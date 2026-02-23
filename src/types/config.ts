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
  instanceName?: string; // SQL Server named instance support
  sslmode?: "disable" | "require"; // SSL mode for network databases (not applicable to SQLite)
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
export type ToolConfig = ExecuteSqlToolConfig | SearchObjectsToolConfig | CustomToolConfig;

/**
 * Complete TOML configuration file structure
 */
export interface TomlConfig {
  sources: SourceConfig[];
  tools?: ToolConfig[];
}
