import { Connector, ConnectorType, ConnectorRegistry, ExecuteOptions, ConnectorConfig } from "./interface.js";
import { SSHTunnel } from "../utils/ssh-tunnel.js";
import type { SSHTunnelConfig, SSHTunnelInfo } from "../types/ssh.js";
import type { SourceConfig } from "../types/config.js";
import { buildDSNFromSource } from "../config/toml-loader.js";
import { getDatabaseTypeFromDSN, getDefaultPortForType } from "../utils/dsn-obfuscate.js";
import { redactDSN } from "../config/env.js";
import { SafeURL } from "../utils/safe-url.js";
import { generateRdsAuthToken } from "../utils/aws-rds-signer.js";
import { parseSSHConfig, looksLikeSSHAlias, getDefaultSSHConfigPath, resolveJumpHosts } from "../utils/ssh-config-parser.js";
import { TUNNEL_ERROR_MARKER } from "../utils/error-classifier.js";

// Singleton instance for global access
let managerInstance: ConnectorManager | null = null;
const AWS_IAM_TOKEN_REFRESH_MS = 14 * 60 * 1000; // refresh before 15-minute token expiry

/**
 * Manages database connectors and provides a unified interface to work with them
 * Now supports multiple database connections with unique IDs
 */
export class ConnectorManager {
  // Maps for multi-source support
  private connectors: Map<string, Connector> = new Map();
  private sshTunnels: Map<string, SSHTunnel> = new Map();
  private sourceConfigs: Map<string, SourceConfig> = new Map(); // Store original source configs
  private sourceIds: string[] = []; // Ordered list of source IDs (first is default)
  private iamRefreshTimers: Map<string, NodeJS.Timeout> = new Map();
  private pendingIamRefreshes: Map<string, Promise<void>> = new Map(); // In-flight refresh per source
  private isDisconnecting = false;

  // Lazy connection support
  private lazySources: Map<string, SourceConfig> = new Map(); // Sources pending lazy connection
  private pendingConnections: Map<string, Promise<void>> = new Map(); // Prevent race conditions
  // A socket timeout does not cancel a credential helper. Share its in-flight
  // attempt across retries of the same config, but never across changed profiles.
  private pendingIamTokens = new WeakMap<SourceConfig, Promise<string>>();

  constructor() {
    if (!managerInstance) {
      managerInstance = this;
    }
  }

  /**
   * Initialize and connect to multiple databases using source configurations
   * This is the new multi-source connection method
   */
  async connectWithSources(sources: SourceConfig[]): Promise<void> {
    if (sources.length === 0) {
      throw new Error("No sources provided");
    }

    const eagerSources = sources.filter(s => !s.lazy);
    const lazySources = sources.filter(s => s.lazy);

    if (eagerSources.length > 0) {
      console.error(`Connecting to ${eagerSources.length} database source(s)...`);
    }

    // Connect to eager sources immediately
    for (const source of eagerSources) {
      await this.connectSource(source);
    }

    // Register lazy sources without connecting
    for (const source of lazySources) {
      this.registerLazySource(source);
    }
  }

  /**
   * Register a lazy source without establishing connection
   * Connection will be established on first use via ensureConnected()
   */
  private registerLazySource(source: SourceConfig): void {
    const sourceId = source.id;
    const dsn = buildDSNFromSource(source);

    console.error(`  - ${sourceId}: ${redactDSN(dsn)} (lazy, will connect on first use)`);

    // Store config for later connection
    this.lazySources.set(sourceId, source);
    this.sourceConfigs.set(sourceId, source);
    this.sourceIds.push(sourceId);
  }

  /**
   * Ensure a source is connected (handles lazy connection on demand)
   * Safe to call multiple times - uses promise-based deduplication so concurrent calls share the same connection attempt
   */
  async ensureConnected(sourceId?: string): Promise<void> {
    const id = sourceId || this.sourceIds[0];

    // Already connected
    if (this.connectors.has(id)) {
      return;
    }

    // Not a lazy source - must be an error
    const lazySource = this.lazySources.get(id);
    if (!lazySource) {
      if (sourceId) {
        throw new Error(
          `Source '${sourceId}' not found. Available sources: ${this.getAvailableSourceIds().join(", ")}`
        );
      } else {
        throw new Error("No sources configured. Call connectWithSources() first.");
      }
    }

    // Check if connection is already in progress (race condition prevention)
    const pending = this.pendingConnections.get(id);
    if (pending) {
      return pending;
    }

    // Start connection and track the promise
    const connectionPromise = (async () => {
      try {
        console.error(`Lazy connecting to source '${id}'...`);
        await this.connectSource(lazySource);
        // Remove from lazy sources after successful connection
        this.lazySources.delete(id);
      } finally {
        // Clean up pending connection tracker
        this.pendingConnections.delete(id);
      }
    })();

    this.pendingConnections.set(id, connectionPromise);
    return connectionPromise;
  }

  /**
   * Static method to ensure a source is connected (for tool handlers)
   */
  static async ensureConnected(sourceId?: string): Promise<void> {
    if (!managerInstance) {
      throw new Error("ConnectorManager not initialized");
    }
    return managerInstance.ensureConnected(sourceId);
  }

  /**
   * Connect to a single source (helper for connectWithSources)
   */
  private async connectSource(source: SourceConfig): Promise<void> {
    const sourceId = source.id;
    const config: ConnectorConfig = {};
    // Build DSN from source config
    const dsn = await this.buildConnectionDSN(source, config);
    console.error(`  - ${sourceId}: ${redactDSN(dsn)}`);

    // Setup SSH tunnel if needed
    let actualDSN = dsn;
    let tunnel: SSHTunnel | undefined;
    if (source.ssh_host) {
      const sshConfigPath = getDefaultSSHConfigPath();
      // If ssh_host looks like an SSH config alias, resolve from ~/.ssh/config
      let resolvedSSHConfig: SSHTunnelConfig | null = null;
      if (looksLikeSSHAlias(source.ssh_host)) {
        console.error(`  Resolving SSH config for host '${source.ssh_host}' from: ${sshConfigPath}`);
        resolvedSSHConfig = parseSSHConfig(source.ssh_host, sshConfigPath);
      }

      // Build SSH config: explicit TOML fields override SSH config values
      const username = source.ssh_user || resolvedSSHConfig?.username;
      const proxyJump = source.ssh_proxy_jump || resolvedSSHConfig?.proxyJump;

      // Resolve the jump-host chain so alias hops (and nested ProxyJump) carry their own
      // host/user/port/key from ~/.ssh/config, matching `ssh`. This can throw (e.g. a
      // cyclic ProxyJump or invalid token); tag such failures as tunnel errors so they're
      // classified consistently with tunnel.establish() failures.
      let resolvedJumpHosts: SSHTunnelConfig["resolvedJumpHosts"];
      try {
        resolvedJumpHosts = proxyJump ? resolveJumpHosts(proxyJump, sshConfigPath) : undefined;
      } catch (error) {
        if (error && typeof error === "object") {
          (error as Record<string, unknown>)[TUNNEL_ERROR_MARKER] = true;
        }
        throw error;
      }

      const sshConfig: SSHTunnelConfig = {
        host: resolvedSSHConfig?.host || source.ssh_host,
        port: source.ssh_port || resolvedSSHConfig?.port || 22,
        username: username || '',
        password: source.ssh_password,
        privateKey: source.ssh_key || resolvedSSHConfig?.privateKey,
        privateKeyDiscovered: source.ssh_key
          ? source.ssh_key_discovered
          : resolvedSSHConfig?.privateKeyDiscovered,
        passphrase: source.ssh_passphrase,
        agent: source.ssh_agent,
        proxyJump,
        resolvedJumpHosts,
        keepaliveInterval: source.ssh_keepalive_interval,
        keepaliveCountMax: source.ssh_keepalive_count_max,
      };

      // Validate required SSH fields
      if (!username) {
        throw new Error(
          `Source '${sourceId}': SSH tunnel requires ssh_user (or a matching Host entry in ~/.ssh/config with User)`
        );
      }

      // Validate SSH auth
      if (!sshConfig.password && !sshConfig.privateKey && !sshConfig.agent && !process.env.SSH_AUTH_SOCK) {
        throw new Error(
          `Source '${sourceId}': SSH tunnel requires either ssh_password or ssh_key (or a matching Host entry in ~/.ssh/config with IdentityFile, or an SSH agent via ssh_agent or SSH_AUTH_SOCK)`
        );
      }

      // Parse DSN to get target host and port
      const url = new URL(dsn);
      const targetHost = url.hostname;
      const targetPort = parseInt(url.port) || this.getDefaultPort(dsn);

      // Create and establish SSH tunnel
      tunnel = new SSHTunnel();
      let tunnelInfo: SSHTunnelInfo;
      try {
        tunnelInfo = await tunnel.establish(sshConfig, {
          targetHost,
          targetPort,
        });
      } catch (error) {
        if (error && typeof error === "object") {
          (error as Record<string, unknown>)[TUNNEL_ERROR_MARKER] = true;
        }
        throw error;
      }

      // Update DSN to use local tunnel endpoint
      url.hostname = "127.0.0.1";
      url.port = tunnelInfo.localPort.toString();
      actualDSN = url.toString();

      // Store tunnel for later cleanup
      this.sshTunnels.set(sourceId, tunnel);

      console.error(
        `  SSH tunnel established through localhost:${tunnelInfo.localPort}`
      );
    }

    // Everything from here until the connector is stored can fail (no connector for
    // the DSN, connect rejected). If it does, close the tunnel established for this
    // attempt: the source may be retried (lazy connection, failed IAM refresh, next
    // config reload), and each retry would otherwise open a new tunnel and orphan this
    // one's SSH clients and local listener.
    let connector: Connector;
    try {
      // Find connector prototype for this DSN
      const connectorPrototype = ConnectorRegistry.getConnectorForDSN(actualDSN);
      if (!connectorPrototype) {
        throw new Error(
          `Source '${sourceId}': No connector found for DSN: ${actualDSN}`
        );
      }

      // Create a new instance of the connector (clone) to avoid sharing state between sources
      // All connectors support cloning for multi-source configurations
      connector = connectorPrototype.clone();

      // Attach source ID to connector instance for tool handlers
      (connector as any).sourceId = sourceId;

      // Build config for database-specific options
      if (source.connection_timeout !== undefined) {
        config.connectionTimeoutSeconds = source.connection_timeout;
      }
      // Query timeout is supported by PostgreSQL, MySQL, MariaDB, SQL Server (not SQLite)
      if (source.query_timeout !== undefined && connector.id !== 'sqlite') {
        config.queryTimeoutSeconds = source.query_timeout;
      }
      if (source.pool_max_connections !== undefined) {
        config.poolMaxConnections = source.pool_max_connections;
      }
      // Note: read-only enforcement is per-tool, not per-source. It is applied at
      // execution time via ExecuteOptions.readonly. Some connectors also add an
      // engine-level backstop in executeSQL (e.g. READ ONLY transactions or SQLite PRAGMA query_only),
      // because a single source connection may be shared by both read-only and
      // writable tools. ConnectorConfig.readonly (connection-level) remains supported
      // for direct connector use but is intentionally not wired from source config.
      // Pass search_path for PostgreSQL
      if (source.search_path) {
        config.searchPath = source.search_path;
      }
      // Pass timezone for MySQL/MariaDB
      if (source.timezone) {
        config.timezone = source.timezone;
      }
      // Pass charset / collation for MySQL/MariaDB (either, or both together)
      if (source.charset) {
        config.charset = source.charset;
      }
      if (source.collation) {
        config.collation = source.collation;
      }

      // Connect to the database with config and optional init script
      await connector.connect(actualDSN, source.init_script, config);
    } catch (error) {
      if (tunnel) {
        this.sshTunnels.delete(sourceId);
        try {
          await tunnel.close();
        } catch (closeError) {
          console.error(`Error closing SSH tunnel for source '${sourceId}':`, closeError);
        }
      }
      throw error;
    }

    // Store connector
    this.connectors.set(sourceId, connector);

    // Only add to sourceIds if not already present (lazy sources are pre-registered)
    if (!this.sourceIds.includes(sourceId)) {
      this.sourceIds.push(sourceId);
    }

    // Store source config (for API exposure)
    this.sourceConfigs.set(sourceId, source);

    // MySQL/MariaDB still rotate pools; PostgreSQL authenticates on demand.
    this.scheduleIamRefresh(source);
  }

  /**
   * Add a single source without touching the others. Eager sources connect now;
   * lazy ones are registered and connect on first use. Used by the TOML hot reload
   * to apply only the entries that changed.
   */
  async addSource(source: SourceConfig): Promise<void> {
    if (this.sourceIds.includes(source.id)) {
      throw new Error(`Source '${source.id}' already exists`);
    }
    if (source.lazy) {
      this.registerLazySource(source);
    } else {
      await this.connectSource(source);
    }
  }

  /**
   * Disconnect and forget a single source, leaving every other source's pool and
   * tunnel untouched. Resolves silently for an unknown id.
   */
  async removeSource(sourceId: string): Promise<void> {
    // Let an in-flight lazy connection or IAM refresh settle first, so the connector
    // and tunnel we tear down are the ones that end up registered, not a stale pair
    // that an outstanding reconnect would otherwise put back after we return.
    const pending = this.pendingConnections.get(sourceId);
    if (pending) {
      try { await pending; } catch { /* the failure already cleaned up after itself */ }
    }
    const refresh = this.pendingIamRefreshes.get(sourceId);
    if (refresh) {
      await refresh; // never rejects
    }

    const timer = this.iamRefreshTimers.get(sourceId);
    if (timer) {
      clearTimeout(timer);
      this.iamRefreshTimers.delete(sourceId);
    }

    const connector = this.connectors.get(sourceId);
    this.connectors.delete(sourceId);
    if (connector) {
      try {
        await connector.disconnect();
        console.error(`Disconnected from source '${sourceId}'`);
      } catch (error) {
        console.error(`Error disconnecting from source '${sourceId}':`, error);
      }
    }

    const tunnel = this.sshTunnels.get(sourceId);
    this.sshTunnels.delete(sourceId);
    if (tunnel) {
      try {
        await tunnel.close();
      } catch (error) {
        console.error(`Error closing SSH tunnel for source '${sourceId}':`, error);
      }
    }

    this.sourceConfigs.delete(sourceId);
    this.lazySources.delete(sourceId);
    this.pendingConnections.delete(sourceId);
    this.sourceIds = this.sourceIds.filter(id => id !== sourceId);
  }

  /**
   * Reorder known sources to match `orderedIds` (the first entry is the default
   * source). Unknown ids are ignored; known ids missing from the list keep their
   * relative order after the listed ones.
   */
  reorderSources(orderedIds: string[]): void {
    const known = new Set(this.sourceIds);
    const ordered = orderedIds.filter(id => known.has(id));
    const listed = new Set(ordered);
    this.sourceIds = [...ordered, ...this.sourceIds.filter(id => !listed.has(id))];
  }

  /**
   * Close all database connections
   */
  async disconnect(): Promise<void> {
    // Set shutdown flag first to prevent IAM refresh timers from firing during teardown
    this.isDisconnecting = true;

    // Stop all IAM refresh timers before disconnecting connectors
    for (const timer of this.iamRefreshTimers.values()) {
      clearTimeout(timer);
    }
    this.iamRefreshTimers.clear();

    // Disconnect multi-source connections
    for (const [sourceId, connector] of this.connectors.entries()) {
      try {
        await connector.disconnect();
        console.error(`Disconnected from source '${sourceId || "(default)"}'`);
      } catch (error) {
        console.error(`Error disconnecting from source '${sourceId}':`, error);
      }
    }

    // Close all SSH tunnels
    for (const [sourceId, tunnel] of this.sshTunnels.entries()) {
      try {
        await tunnel.close();
      } catch (error) {
        console.error(`Error closing SSH tunnel for source '${sourceId}':`, error);
      }
    }

    // Clear multi-source state
    this.connectors.clear();
    this.sshTunnels.clear();
    this.sourceConfigs.clear();
    this.lazySources.clear();
    this.pendingConnections.clear();
    this.pendingIamRefreshes.clear();
    this.sourceIds = [];
    this.isDisconnecting = false;
  }

  /**
   * Get a connector by source ID
   * If sourceId is not provided, returns the default (first) connector
   */
  getConnector(sourceId?: string): Connector {
    const id = sourceId || this.sourceIds[0];
    const connector = this.connectors.get(id);

    if (!connector) {
      if (sourceId) {
        throw new Error(
          `Source '${sourceId}' not found. Available sources: ${this.getAvailableSourceIds().join(", ")}`
        );
      } else {
        throw new Error("No sources connected. Call connectWithSources() first.");
      }
    }

    return connector;
  }

  /**
   * Get all available connector types
   */
  static getAvailableConnectors(): ConnectorType[] {
    return ConnectorRegistry.getAvailableConnectors();
  }

  /**
   * Get sample DSNs for all available connectors
   */
  static getAllSampleDSNs(): { [key in ConnectorType]?: string } {
    return ConnectorRegistry.getAllSampleDSNs();
  }

  /**
   * Get the current active connector instance
   * This is used by resource and tool handlers
   * @param sourceId - Optional source ID. If not provided, returns default (first) connector
   */
  static getCurrentConnector(sourceId?: string): Connector {
    if (!managerInstance) {
      throw new Error("ConnectorManager not initialized");
    }
    return managerInstance.getConnector(sourceId);
  }


  /**
   * Get all available source IDs
   */
  getSourceIds(): string[] {
    return [...this.sourceIds];
  }

  /**
   * Source IDs that can actually serve a request: connected, or registered for
   * lazy (re)connection on first use. Used for error messages so a source that
   * is neither is not reported as available.
   */
  private getAvailableSourceIds(): string[] {
    return this.sourceIds.filter(id => this.connectors.has(id) || this.lazySources.has(id));
  }

  /** Get all available source IDs */
  static getAvailableSourceIds(): string[] {
    if (!managerInstance) {
      throw new Error("ConnectorManager not initialized");
    }
    return managerInstance.getSourceIds();
  }

  /**
   * Get source configuration by ID
   * @param sourceId - Source ID. If not provided, returns default (first) source config
   */
  getSourceConfig(sourceId?: string): SourceConfig | null {
    if (this.sourceIds.length === 0) {
      return null;
    }
    const id = sourceId || this.sourceIds[0];
    return this.sourceConfigs.get(id) || null;
  }

  /**
   * Get all source configurations
   */
  getAllSourceConfigs(): SourceConfig[] {
    return this.sourceIds.map(id => this.sourceConfigs.get(id)!);
  }

  /**
   * Get source configuration by ID (static method for external access)
   */
  static getSourceConfig(sourceId?: string): SourceConfig | null {
    if (!managerInstance) {
      throw new Error("ConnectorManager not initialized");
    }
    return managerInstance.getSourceConfig(sourceId);
  }

  /**
   * Get all source configurations (static method for external access)
   */
  static getAllSourceConfigs(): SourceConfig[] {
    if (!managerInstance) {
      throw new Error("ConnectorManager not initialized");
    }
    return managerInstance.getAllSourceConfigs();
  }

  /**
   * Get default port for a database based on DSN protocol
   */
  private getDefaultPort(dsn: string): number {
    const type = getDatabaseTypeFromDSN(dsn);
    if (!type) {
      return 0;
    }
    return getDefaultPortForType(type) ?? 0;
  }

  private scheduleIamRefresh(source: SourceConfig): void {
    if (this.isDisconnecting) {
      return;
    }

    const sourceId = source.id;
    const existingTimer = this.iamRefreshTimers.get(sourceId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.iamRefreshTimers.delete(sourceId);
    }
    if (!source.aws_iam_auth || source.type === "postgres") {
      return;
    }

    const timer = setTimeout(() => {
      if (this.isDisconnecting) {
        return;
      }
      const run = (async () => {
        try {
          await this.refreshIamSourceConnection(source);
        } catch (error) {
          console.error(
            `Error refreshing AWS IAM auth token for source '${sourceId}':`,
            error
          );
        } finally {
          this.pendingIamRefreshes.delete(sourceId);
          // Continue rotating only while this exact source is still registered and
          // connected, and we are not shutting down. A source whose refresh failed has
          // been handed back to lazySources, and its next successful connectSource()
          // re-arms the timer. A source removed or replaced mid-refresh must not re-arm.
          if (!this.isDisconnecting && this.ownsSource(source) && this.connectors.has(sourceId)) {
            this.scheduleIamRefresh(source);
          }
        }
      })();
      // Exposed so removeSource() can wait for the refresh instead of racing it.
      this.pendingIamRefreshes.set(sourceId, run);
    }, AWS_IAM_TOKEN_REFRESH_MS);
    timer.unref?.();
    this.iamRefreshTimers.set(sourceId, timer);
  }

  private async refreshIamSourceConnection(source: SourceConfig): Promise<void> {
    const sourceId = source.id;
    if (this.isDisconnecting || !source.aws_iam_auth || !this.connectors.has(sourceId)) {
      return;
    }

    console.error(`Refreshing AWS IAM auth connection for source '${sourceId}'...`);

    const existingConnector = this.connectors.get(sourceId);
    if (existingConnector) {
      await existingConnector.disconnect();
      this.connectors.delete(sourceId);
    }

    const existingTunnel = this.sshTunnels.get(sourceId);
    if (existingTunnel) {
      await existingTunnel.close();
      this.sshTunnels.delete(sourceId);
    }

    // removeSource() may have run while we were awaiting above (e.g. a config reload
    // dropped or replaced this source). Reconnecting now would resurrect it, or clobber
    // its replacement, so stop here.
    if (this.isDisconnecting || !this.ownsSource(source)) {
      return;
    }

    try {
      await this.connectSource(source);
    } catch (error) {
      // The old connector is already gone. Register the source for lazy reconnection so
      // the next tool call retries (e.g. after the user re-authenticates) instead of
      // failing forever with "Source not found".
      if (!this.isDisconnecting && this.ownsSource(source)) {
        this.lazySources.set(sourceId, source);
      }
      throw error;
    }
  }

  /**
   * True while `source` is the config object registered under its id. Every
   * registration path stores the same object, so identity tells an in-flight
   * operation whether its source was removed or replaced underneath it.
   */
  private ownsSource(source: SourceConfig): boolean {
    return this.sourceConfigs.get(source.id) === source;
  }

  /**
   * Build a connection DSN, optionally replacing password with
   * an AWS RDS IAM auth token when aws_iam_auth is enabled.
   */
  private async buildConnectionDSN(source: SourceConfig, config: ConnectorConfig = {}): Promise<string> {
    const dsn = buildDSNFromSource(source);

    if (!source.aws_iam_auth) {
      return dsn;
    }

    const supportedIamTypes = ["postgres", "mysql", "mariadb"];
    if (!source.type || !supportedIamTypes.includes(source.type)) {
      throw new Error(
        `Source '${source.id}': aws_iam_auth is only supported for postgres, mysql, and mariadb`
      );
    }
    if (!source.aws_region) {
      throw new Error(
        `Source '${source.id}': aws_region is required when aws_iam_auth is enabled`
      );
    }

    const parsed = new SafeURL(dsn);
    const hostname = parsed.hostname;
    const username = source.user || parsed.username;
    const defaultPort = getDefaultPortForType(source.type);
    const port = parsed.port ? parseInt(parsed.port) : defaultPort;

    if (!hostname || !username || !port) {
      throw new Error(
        `Source '${source.id}': unable to resolve host, username, or port for AWS IAM authentication`
      );
    }

    // Share concurrent authentication attempts, never retain a failed promise or
    // cache a token's lifetime ourselves. The AWS provider owns credential refresh.
    const password = () => {
      let pending = this.pendingIamTokens.get(source);
      if (!pending) {
        pending = generateRdsAuthToken({
          hostname, port, username, region: source.aws_region!, profile: source.aws_profile,
        }).finally(() => { this.pendingIamTokens.delete(source); });
        this.pendingIamTokens.set(source, pending);
      }
      return pending;
    };
    if (source.type === "postgres") {
      config.password = password;
    }
    const token = source.type === "postgres" ? "" : await password();

    const queryParams = new Map(parsed.searchParams);
    const currentSslMode = queryParams.get("sslmode");
    if (currentSslMode !== "verify-ca" && currentSslMode !== "verify-full") {
      queryParams.set("sslmode", "require");
    }

    const protocol = parsed.protocol.endsWith(":")
      ? parsed.protocol.slice(0, -1)
      : parsed.protocol;
    const encodedUser = encodeURIComponent(username);
    const encodedToken = encodeURIComponent(token);
    const path = parsed.pathname || "/";
    const query = Array.from(queryParams.entries())
      .map(
        ([key, value]) =>
          `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
      )
      .join("&");

    return `${protocol}://${encodedUser}:${encodedToken}@${hostname}:${port}${path}${query ? `?${query}` : ""}`;
  }
}
