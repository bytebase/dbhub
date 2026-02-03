import { Connector, ConnectorType, ConnectorRegistry, ExecuteOptions, ConnectorConfig } from "./interface.js";
import { SSHTunnel } from "../utils/ssh-tunnel.js";
import type { SSHTunnelConfig } from "../types/ssh.js";
import type { SourceConfig } from "../types/config.js";
import { buildDSNFromSource } from "../config/toml-loader.js";
import { getDatabaseTypeFromDSN, getDefaultPortForType } from "../utils/dsn-obfuscate.js";
import { redactDSN } from "../config/env.js";

// Singleton instance for global access
let managerInstance: ConnectorManager | null = null;

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

  // Lazy connection support
  private lazySources: Map<string, SourceConfig> = new Map(); // Sources pending lazy connection
  private pendingConnections: Map<string, Promise<void>> = new Map(); // Prevent race conditions

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
          `Source '${sourceId}' not found. Available sources: ${this.sourceIds.join(", ")}`
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
    // Build DSN from source config
    const dsn = buildDSNFromSource(source);
    console.error(`  - ${sourceId}: ${redactDSN(dsn)}`);

    // Setup SSH tunnel if needed
    let actualDSN = dsn;
    if (source.ssh_host) {
      // Validate required SSH fields
      if (!source.ssh_user) {
        throw new Error(
          `Source '${sourceId}': SSH tunnel requires ssh_user`
        );
      }

      const sshConfig: SSHTunnelConfig = {
        host: source.ssh_host,
        port: source.ssh_port || 22,
        username: source.ssh_user,
        password: source.ssh_password,
        privateKey: source.ssh_key,
        passphrase: source.ssh_passphrase,
        proxyJump: source.ssh_proxy_jump,
      };

      // Validate SSH auth
      if (!sshConfig.password && !sshConfig.privateKey) {
        throw new Error(
          `Source '${sourceId}': SSH tunnel requires either ssh_password or ssh_key`
        );
      }

      // Parse DSN to get target host and port
      const url = new URL(dsn);
      const targetHost = url.hostname;
      const targetPort = parseInt(url.port) || this.getDefaultPort(dsn);

      // Create and establish SSH tunnel
      const tunnel = new SSHTunnel();
      const tunnelInfo = await tunnel.establish(sshConfig, {
        targetHost,
        targetPort,
      });

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

    // Find connector prototype for this DSN
    const connectorPrototype = ConnectorRegistry.getConnectorForDSN(actualDSN);
    if (!connectorPrototype) {
      throw new Error(
        `Source '${sourceId}': No connector found for DSN: ${actualDSN}`
      );
    }

    // Create a new instance of the connector (clone) to avoid sharing state between sources
    // All connectors support cloning for multi-source configurations
    const connector = connectorPrototype.clone();

    // Attach source ID to connector instance for tool handlers
    (connector as any).sourceId = sourceId;

    // Build config for database-specific options
    const config: ConnectorConfig = {};
    if (source.connection_timeout !== undefined) {
      config.connectionTimeoutSeconds = source.connection_timeout;
    }
    // Query timeout is supported by PostgreSQL, MySQL, MariaDB, SQL Server (not SQLite)
    if (source.query_timeout !== undefined && connector.id !== 'sqlite') {
      config.queryTimeoutSeconds = source.query_timeout;
    }
    // Pass readonly flag for SDK-level enforcement (PostgreSQL, SQLite)
    if (source.readonly !== undefined) {
      config.readonly = source.readonly;
    }

    // Connect to the database with config and optional init script
    await connector.connect(actualDSN, source.init_script, config);

    // Store connector
    this.connectors.set(sourceId, connector);

    // Only add to sourceIds if not already present (lazy sources are pre-registered)
    if (!this.sourceIds.includes(sourceId)) {
      this.sourceIds.push(sourceId);
    }

    // Store source config (for API exposure)
    this.sourceConfigs.set(sourceId, source);
  }

  /**
   * Close all database connections
   */
  async disconnect(): Promise<void> {
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
    this.sourceIds = [];
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
          `Source '${sourceId}' not found. Available sources: ${this.sourceIds.join(", ")}`
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
}
