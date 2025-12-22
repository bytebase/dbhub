import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { homedir } from "os";
import type { SSHTunnelConfig } from "../types/ssh.js";
import { parseSSHConfig, looksLikeSSHAlias } from "../utils/ssh-config-parser.js";
import type { SourceConfig } from "../types/config.js";
import { loadTomlConfig } from "./toml-loader.js";
import { parseConnectionInfoFromDSN } from "../utils/dsn-obfuscate.js";
import { SafeURL } from "../utils/safe-url.js";

// Create __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse command line arguments
export function parseCommandLineArgs() {
  // Check if any args start with '--' (the way tsx passes them)
  const args = process.argv.slice(2);
  const parsedManually: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const parts = arg.substring(2).split("=");
      const key = parts[0];

      // Fail immediately on deprecated flags
      if (key === "readonly") {
        console.error("\nERROR: --readonly flag is no longer supported.");
        console.error("Use dbhub.toml with [[tools]] configuration instead:\n");
        console.error("  [[sources]]");
        console.error("  id = \"default\"");
        console.error("  dsn = \"...\"\n");
        console.error("  [[tools]]");
        console.error("  name = \"execute_sql\"");
        console.error("  source = \"default\"");
        console.error("  readonly = true\n");
        console.error("See https://dbhub.ai/tools/execute-sql#read-only-mode for details.\n");
        process.exit(1);
      }

      if (key === "max-rows") {
        console.error("\nERROR: --max-rows flag is no longer supported.");
        console.error("Use dbhub.toml with [[tools]] configuration instead:\n");
        console.error("  [[sources]]");
        console.error("  id = \"default\"");
        console.error("  dsn = \"...\"\n");
        console.error("  [[tools]]");
        console.error("  name = \"execute_sql\"");
        console.error("  source = \"default\"");
        console.error("  max_rows = 1000\n");
        console.error("See https://dbhub.ai/tools/execute-sql#row-limiting for details.\n");
        process.exit(1);
      }

      const value = parts.length > 1 ? parts.slice(1).join("=") : undefined;
      if (value) {
        // Handle --key=value format
        parsedManually[key] = value;
      } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        // Handle --key value format
        parsedManually[key] = args[i + 1];
        i++; // Skip the next argument as it's the value
      } else {
        // Handle --key format (boolean flag)
        parsedManually[key] = "true";
      }
    }
  }

  // Just use the manually parsed args - removed parseArgs dependency for Node.js <18.3.0 compatibility
  return parsedManually;
}

/**
 * Load environment files from various locations
 * Returns the name of the file that was loaded, or null if none was found
 */
export function loadEnvFiles(): string | null {
  // Determine if we're in development or production mode
  const isDevelopment = process.env.NODE_ENV === "development" || process.argv[1]?.includes("tsx");

  // Select environment file names based on environment
  const envFileNames = isDevelopment
    ? [".env.local", ".env"] // In development, try .env.local first, then .env
    : [".env"]; // In production, only look for .env

  // Build paths to check for environment files
  const envPaths = [];
  for (const fileName of envFileNames) {
    envPaths.push(
      fileName, // Current working directory
      path.join(__dirname, "..", "..", fileName), // Two levels up (src/config -> src -> root)
      path.join(process.cwd(), fileName) // Explicit current working directory
    );
  }

  // Try to load the first env file found from the prioritized locations
  for (const envPath of envPaths) {
    console.error(`Checking for env file: ${envPath}`);
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });

      // Check for deprecated environment variables
      if (process.env.READONLY !== undefined) {
        console.error("\nERROR: READONLY environment variable is no longer supported.");
        console.error("Use dbhub.toml with [[tools]] configuration instead:\n");
        console.error("  [[sources]]");
        console.error("  id = \"default\"");
        console.error("  dsn = \"...\"\n");
        console.error("  [[tools]]");
        console.error("  name = \"execute_sql\"");
        console.error("  source = \"default\"");
        console.error("  readonly = true\n");
        console.error("See https://dbhub.ai/tools/execute-sql#read-only-mode for details.\n");
        process.exit(1);
      }

      if (process.env.MAX_ROWS !== undefined) {
        console.error("\nERROR: MAX_ROWS environment variable is no longer supported.");
        console.error("Use dbhub.toml with [[tools]] configuration instead:\n");
        console.error("  [[sources]]");
        console.error("  id = \"default\"");
        console.error("  dsn = \"...\"\n");
        console.error("  [[tools]]");
        console.error("  name = \"execute_sql\"");
        console.error("  source = \"default\"");
        console.error("  max_rows = 1000\n");
        console.error("See https://dbhub.ai/tools/execute-sql#row-limiting for details.\n");
        process.exit(1);
      }

      // Return the name of the file that was loaded
      return path.basename(envPath);
    }
  }

  return null;
}

/**
 * Check if demo mode is enabled from command line args
 * Returns true if --demo flag is provided
 */
export function isDemoMode(): boolean {
  const args = parseCommandLineArgs();
  return args.demo === "true";
}


/**
 * Build DSN from individual environment variables
 * Returns the constructed DSN or null if required variables are missing
 */
export function buildDSNFromEnvParams(): { dsn: string; source: string } | null {
  // Check for required environment variables
  const dbType = process.env.DB_TYPE;
  const dbHost = process.env.DB_HOST;
  const dbUser = process.env.DB_USER;
  const dbPassword = process.env.DB_PASSWORD;
  const dbName = process.env.DB_NAME;
  const dbPort = process.env.DB_PORT;

  // For SQLite, only DB_TYPE and DB_NAME are required
  if (dbType?.toLowerCase() === 'sqlite') {
    if (!dbName) {
      return null;
    }
  } else {
    // For other databases, require all essential parameters
    if (!dbType || !dbHost || !dbUser || !dbPassword || !dbName) {
      return null;
    }
  }

  // Validate supported database types
  const supportedTypes = ['postgres', 'postgresql', 'mysql', 'mariadb', 'sqlserver', 'sqlite'];
  if (!supportedTypes.includes(dbType.toLowerCase())) {
    throw new Error(`Unsupported DB_TYPE: ${dbType}. Supported types: ${supportedTypes.join(', ')}`);
  }

  // Determine default port based on database type
  let port = dbPort;
  if (!port) {
    switch (dbType.toLowerCase()) {
      case 'postgres':
      case 'postgresql':
        port = '5432';
        break;
      case 'mysql':
      case 'mariadb':
        port = '3306';
        break;
      case 'sqlserver':
        port = '1433';
        break;
      case 'sqlite':
        // SQLite doesn't use host/port, handle differently
        return {
          dsn: `sqlite:///${dbName}`,
          source: 'individual environment variables'
        };
      default:
        throw new Error(`Unknown database type for port determination: ${dbType}`);
    }
  }

  // At this point, dbUser, dbPassword, and dbName are guaranteed to be non-null due to earlier checks.
  const user: string = dbUser as string;
  const password: string = dbPassword as string;
  const dbNameStr: string = dbName as string;
  const encodedUser = encodeURIComponent(user);
  const encodedPassword = encodeURIComponent(password);
  const encodedDbName = encodeURIComponent(dbNameStr);

  // Construct DSN
  const protocol = dbType.toLowerCase() === 'postgresql' ? 'postgres' : dbType.toLowerCase();
  const dsn = `${protocol}://${encodedUser}:${encodedPassword}@${dbHost}:${port}/${encodedDbName}`;

  return {
    dsn,
    source: 'individual environment variables'
  };
}

/**
 * Resolve DSN from command line args, environment variables, or .env files
 * Returns the DSN and its source, or null if not found
 */
export function resolveDSN(): { dsn: string; source: string; isDemo?: boolean } | null {
  // Get command line arguments
  const args = parseCommandLineArgs();

  // Check for demo mode first (highest priority)
  if (isDemoMode()) {
    // Will use in-memory SQLite with demo data
    return {
      dsn: "sqlite:///:memory:",
      source: "demo mode",
      isDemo: true,
    };
  }

  // 1. Check command line arguments
  if (args.dsn) {
    return { dsn: args.dsn, source: "command line argument" };
  }

  // 2. Check environment variables before loading .env
  if (process.env.DSN) {
    return { dsn: process.env.DSN, source: "environment variable" };
  }

  // 3. Check for individual DB parameters from environment
  const envParamsResult = buildDSNFromEnvParams();
  if (envParamsResult) {
    return envParamsResult;
  }

  // 4. Try loading from .env files
  const loadedEnvFile = loadEnvFiles();

  // 5. Check for DSN in .env file
  if (loadedEnvFile && process.env.DSN) {
    return { dsn: process.env.DSN, source: `${loadedEnvFile} file` };
  }

  // 6. Check for individual DB parameters from .env file
  if (loadedEnvFile) {
    const envFileParamsResult = buildDSNFromEnvParams();
    if (envFileParamsResult) {
      return {
        dsn: envFileParamsResult.dsn,
        source: `${loadedEnvFile} file (individual parameters)`
      };
    }
  }

  return null;
}

/**
 * Resolve transport type from command line args or environment variables
 * Returns 'stdio' or 'http' (streamable HTTP), with 'stdio' as the default
 */
export function resolveTransport(): { type: "stdio" | "http"; source: string } {
  // Get command line arguments
  const args = parseCommandLineArgs();

  // 1. Check command line arguments first (highest priority)
  if (args.transport) {
    const type = args.transport === "http" ? "http" : "stdio";
    return { type, source: "command line argument" };
  }

  // 2. Check environment variables
  if (process.env.TRANSPORT) {
    const type = process.env.TRANSPORT === "http" ? "http" : "stdio";
    return { type, source: "environment variable" };
  }

  // 3. Default to stdio
  return { type: "stdio", source: "default" };
}


/**
 * Resolve port from command line args or environment variables
 * Returns port number with 8080 as the default
 *
 * Note: The port option is only applicable when using --transport=http
 * as it controls the HTTP server port for streamable HTTP connections.
 */
export function resolvePort(): { port: number; source: string } {
  // Get command line arguments
  const args = parseCommandLineArgs();

  // 1. Check command line arguments first (highest priority)
  if (args.port) {
    const port = parseInt(args.port, 10);
    return { port, source: "command line argument" };
  }

  // 2. Check environment variables
  if (process.env.PORT) {
    const port = parseInt(process.env.PORT, 10);
    return { port, source: "environment variable" };
  }

  // 3. Default to 8080
  return { port: 8080, source: "default" };
}

/**
 * Redact sensitive information from a DSN string
 * Replaces the password with asterisks
 * @param dsn - The DSN string to redact
 * @returns The sanitized DSN string
 */
export function redactDSN(dsn: string): string {
  try {
    // Create a URL object to parse the DSN
    const url = new URL(dsn);

    // Replace the password with asterisks
    if (url.password) {
      url.password = "*******";
    }

    // Return the sanitized DSN
    return url.toString();
  } catch (error) {
    // If parsing fails, do basic redaction with regex
    return dsn.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@");
  }
}

/**
 * Resolve ID from command line args or environment variables
 * Returns ID or null if not provided
 */
export function resolveId(): { id: string; source: string } | null {
  // Get command line arguments
  const args = parseCommandLineArgs();

  // 1. Check command line arguments first (highest priority)
  if (args.id) {
    return { id: args.id, source: "command line argument" };
  }

  // 2. Check environment variables
  if (process.env.ID) {
    return { id: process.env.ID, source: "environment variable" };
  }

  return null;
}

/**
 * Resolve SSH tunnel configuration from command line args or environment variables
 * Returns SSH config or null if no SSH options are provided
 */
export function resolveSSHConfig(): { config: SSHTunnelConfig; source: string } | null {
  // Get command line arguments
  const args = parseCommandLineArgs();

  // Check if any SSH options are provided
  const hasSSHArgs = args["ssh-host"] || process.env.SSH_HOST;
  if (!hasSSHArgs) {
    return null;
  }

  // Build SSH config from command line and environment variables
  let config: Partial<SSHTunnelConfig> = {};
  let sources: string[] = [];
  let sshConfigHost: string | undefined;

  // SSH Host (required)
  if (args["ssh-host"]) {
    sshConfigHost = args["ssh-host"];
    config.host = args["ssh-host"];
    sources.push("ssh-host from command line");
  } else if (process.env.SSH_HOST) {
    sshConfigHost = process.env.SSH_HOST;
    config.host = process.env.SSH_HOST;
    sources.push("SSH_HOST from environment");
  }

  // Check if the host looks like an SSH config alias
  if (sshConfigHost && looksLikeSSHAlias(sshConfigHost)) {
    // Try to parse SSH config for this host, default to ~/.ssh/config
    const sshConfigPath = path.join(homedir(), '.ssh', 'config');
    console.error(`Attempting to parse SSH config for host '${sshConfigHost}' from: ${sshConfigPath}`);
    const sshConfigData = parseSSHConfig(sshConfigHost, sshConfigPath);
    if (sshConfigData) {
      // Use SSH config as base, but allow command line/env to override
      config = { ...sshConfigData };
      sources.push(`SSH config for host '${sshConfigHost}'`);
      
      // The host from SSH config has already been set, no need to override
    }
  }

  // SSH Port (optional, default: 22)
  if (args["ssh-port"]) {
    config.port = parseInt(args["ssh-port"], 10);
    sources.push("ssh-port from command line");
  } else if (process.env.SSH_PORT) {
    config.port = parseInt(process.env.SSH_PORT, 10);
    sources.push("SSH_PORT from environment");
  }

  // SSH User (required)
  if (args["ssh-user"]) {
    config.username = args["ssh-user"];
    sources.push("ssh-user from command line");
  } else if (process.env.SSH_USER) {
    config.username = process.env.SSH_USER;
    sources.push("SSH_USER from environment");
  }

  // SSH Password (optional)
  if (args["ssh-password"]) {
    config.password = args["ssh-password"];
    sources.push("ssh-password from command line");
  } else if (process.env.SSH_PASSWORD) {
    config.password = process.env.SSH_PASSWORD;
    sources.push("SSH_PASSWORD from environment");
  }

  // SSH Private Key (optional)
  if (args["ssh-key"]) {
    config.privateKey = args["ssh-key"];
    // Expand ~ to home directory
    if (config.privateKey.startsWith("~/")) {
      config.privateKey = path.join(process.env.HOME || "", config.privateKey.substring(2));
    }
    sources.push("ssh-key from command line");
  } else if (process.env.SSH_KEY) {
    config.privateKey = process.env.SSH_KEY;
    // Expand ~ to home directory
    if (config.privateKey.startsWith("~/")) {
      config.privateKey = path.join(process.env.HOME || "", config.privateKey.substring(2));
    }
    sources.push("SSH_KEY from environment");
  }

  // SSH Key Passphrase (optional)
  if (args["ssh-passphrase"]) {
    config.passphrase = args["ssh-passphrase"];
    sources.push("ssh-passphrase from command line");
  } else if (process.env.SSH_PASSPHRASE) {
    config.passphrase = process.env.SSH_PASSPHRASE;
    sources.push("SSH_PASSPHRASE from environment");
  }

  // SSH ProxyJump (optional) - for multi-hop SSH connections
  if (args["ssh-proxy-jump"]) {
    config.proxyJump = args["ssh-proxy-jump"];
    sources.push("ssh-proxy-jump from command line");
  } else if (process.env.SSH_PROXY_JUMP) {
    config.proxyJump = process.env.SSH_PROXY_JUMP;
    sources.push("SSH_PROXY_JUMP from environment");
  }

  // Validate required fields
  if (!config.host || !config.username) {
    throw new Error("SSH tunnel configuration requires at least --ssh-host and --ssh-user");
  }

  // Validate authentication method
  if (!config.password && !config.privateKey) {
    throw new Error("SSH tunnel configuration requires either --ssh-password or --ssh-key for authentication");
  }

  return {
    config: config as SSHTunnelConfig,
    source: sources.join(", ")
  };
}

/**
 * Resolve source configurations from TOML config or fallback to single DSN
 * Priority: TOML config (--config flag or ./dbhub.toml) > single DSN/env vars
 * Returns array of source configs and the source of the configuration
 */
export async function resolveSourceConfigs(): Promise<{ sources: SourceConfig[]; tools?: import("../types/config.js").ToolConfig[]; source: string } | null> {
  // 1. Try loading from TOML configuration file (skip if --demo flag is set)
  if (!isDemoMode()) {
    const tomlConfig = loadTomlConfig();
    if (tomlConfig) {
      // Validate that --id flag is not used with TOML config
      const idData = resolveId();
      if (idData) {
        throw new Error(
          "The --id flag cannot be used with TOML configuration. " +
          "TOML config defines source IDs directly. " +
          "Either remove the --id flag or use command-line DSN configuration instead."
        );
      }
      // Note: --readonly flag is deprecated but no longer blocks TOML usage
      // The warning is shown in isReadOnlyMode() function
      return tomlConfig;
    }
  }

  // 2. Fallback to single DSN configuration (including demo mode)
  const dsnResult = resolveDSN();
  if (dsnResult) {
    // Parse DSN to extract database type
    let dsnUrl: SafeURL;
    try {
      dsnUrl = new SafeURL(dsnResult.dsn);
    } catch (error) {
      throw new Error(
        `Invalid DSN format: ${dsnResult.dsn}. Expected format: protocol://[user[:password]@]host[:port]/database`
      );
    }

    const protocol = dsnUrl.protocol.replace(':', '');

    // Map protocol to database type
    let dbType: "postgres" | "mysql" | "mariadb" | "sqlserver" | "sqlite";
    if (protocol === 'postgresql' || protocol === 'postgres') {
      dbType = 'postgres';
    } else if (protocol === 'mysql') {
      dbType = 'mysql';
    } else if (protocol === 'mariadb') {
      dbType = 'mariadb';
    } else if (protocol === 'sqlserver') {
      dbType = 'sqlserver';
    } else if (protocol === 'sqlite') {
      dbType = 'sqlite';
    } else {
      throw new Error(`Unsupported database type in DSN: ${protocol}`);
    }

    // Get --id flag value (if specified) to use as source ID
    // If not specified, use "default" (which will result in no tool name suffix)
    const idData = resolveId();
    const sourceId = idData?.id || "default";

    // Create a single source config from the resolved DSN
    const source: SourceConfig = {
      id: sourceId,
      type: dbType,
      dsn: dsnResult.dsn,
    };

    // Parse DSN to populate connection info fields for API responses
    const connectionInfo = parseConnectionInfoFromDSN(dsnResult.dsn);
    if (connectionInfo) {
      if (connectionInfo.host) {
        source.host = connectionInfo.host;
      }
      if (connectionInfo.port !== undefined) {
        source.port = connectionInfo.port;
      }
      if (connectionInfo.database) {
        source.database = connectionInfo.database;
      }
      if (connectionInfo.user) {
        source.user = connectionInfo.user;
      }
    }

    // Add SSH config if available
    const sshResult = resolveSSHConfig();
    if (sshResult) {
      source.ssh_host = sshResult.config.host;
      source.ssh_port = sshResult.config.port;
      source.ssh_user = sshResult.config.username;
      source.ssh_password = sshResult.config.password;
      source.ssh_key = sshResult.config.privateKey;
      source.ssh_passphrase = sshResult.config.passphrase;
    }

    // Add init script for demo mode
    if (dsnResult.isDemo) {
      const { getSqliteInMemorySetupSql } = await import('./demo-loader.js');
      source.init_script = getSqliteInMemorySetupSql();
    }

    return {
      sources: [source],
      tools: [],
      source: dsnResult.isDemo ? "demo mode" : dsnResult.source,
    };
  }

  return null;
}
