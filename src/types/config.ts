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
}

/**
 * Database connection parameters (alternative to DSN)
 */
export interface ConnectionParams {
  type?: "postgres" | "mysql" | "mariadb" | "sqlserver" | "sqlite";
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  instanceName?: string; // SQL Server named instance support
}

/**
 * Execution options per source
 */
export interface ExecutionOptions {
  readonly?: boolean;
  max_rows?: number;
}

/**
 * Source configuration from [[sources]] array in TOML
 */
export interface SourceConfig
  extends ConnectionParams,
    SSHConfig,
    ExecutionOptions {
  id: string;
  dsn?: string;
  connection_timeout?: number; // Connection timeout in seconds
  request_timeout?: number; // Request/query timeout in seconds (SQL Server only)
  init_script?: string; // Optional SQL script to run on connection (for demo mode or initialization)
}

/**
 * Complete TOML configuration file structure
 */
export interface TomlConfig {
  sources: SourceConfig[];
  tools?: unknown[]; // Reserved for future custom tools
}
