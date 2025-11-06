import { Connector, ConnectorType, ConnectorRegistry, ExecuteOptions } from "./interface.js";
import { SSHTunnel } from "../utils/ssh-tunnel.js";
import { resolveSSHConfig, resolveMaxRows } from "../config/env.js";
import type { SSHTunnelConfig } from "../types/ssh.js";
import type { SourceConfig } from "../types/config.js";
import { buildDSNFromSource } from "../config/toml-loader.js";

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
  private executeOptions: Map<string, ExecuteOptions> = new Map();
  private sourceIds: string[] = []; // Ordered list of source IDs (first is default)

  // Legacy single-connector support (for backward compatibility)
  private activeConnector: Connector | null = null;
  private connected = false;
  private sshTunnel: SSHTunnel | null = null;
  private originalDSN: string | null = null;
  private maxRows: number | null = null;

  constructor() {
    if (!managerInstance) {
      managerInstance = this;
    }
    
    // Initialize maxRows from command line arguments
    const maxRowsData = resolveMaxRows();
    if (maxRowsData) {
      this.maxRows = maxRowsData.maxRows;
      console.error(`Max rows limit: ${this.maxRows} (from ${maxRowsData.source})`);
    }
  }

  /**
   * Initialize and connect to the database using a DSN
   */
  async connectWithDSN(dsn: string, initScript?: string): Promise<void> {
    // Store original DSN for reference
    this.originalDSN = dsn;
    
    // Check if SSH tunnel is needed
    const sshConfig = resolveSSHConfig();
    let actualDSN = dsn;
    
    if (sshConfig) {
      console.error(`SSH tunnel configuration loaded from ${sshConfig.source}`);
      
      // Parse DSN to get database host and port
      const url = new URL(dsn);
      const targetHost = url.hostname;
      const targetPort = parseInt(url.port) || this.getDefaultPort(dsn);
      
      // Create and establish SSH tunnel
      this.sshTunnel = new SSHTunnel();
      const tunnelInfo = await this.sshTunnel.establish(sshConfig.config, {
        targetHost,
        targetPort,
      });
      
      // Update DSN to use local tunnel endpoint
      url.hostname = '127.0.0.1';
      url.port = tunnelInfo.localPort.toString();
      actualDSN = url.toString();
      
      console.error(`Database connection will use SSH tunnel through localhost:${tunnelInfo.localPort}`);
    }

    // First try to find a connector that can handle this DSN
    let connector = ConnectorRegistry.getConnectorForDSN(actualDSN);

    if (!connector) {
      throw new Error(`No connector found that can handle the DSN: ${actualDSN}`);
    }

    this.activeConnector = connector;

    // Connect to the database through tunnel if applicable
    await this.activeConnector.connect(actualDSN, initScript);
    this.connected = true;
  }

  /**
   * Initialize and connect to the database using a specific connector type
   */
  async connectWithType(connectorType: ConnectorType, dsn?: string): Promise<void> {
    // Get the connector from the registry
    const connector = ConnectorRegistry.getConnector(connectorType);

    if (!connector) {
      throw new Error(`Connector "${connectorType}" not found`);
    }

    this.activeConnector = connector;

    // Use provided DSN or get sample DSN
    const connectionString = dsn || connector.dsnParser.getSampleDSN();

    // Connect to the database
    await this.activeConnector.connect(connectionString);
    this.connected = true;
  }

  /**
   * Initialize and connect to multiple databases using source configurations
   * This is the new multi-source connection method
   */
  async connectWithSources(sources: SourceConfig[]): Promise<void> {
    if (sources.length === 0) {
      throw new Error("No sources provided");
    }

    // Connect to each source
    for (const source of sources) {
      await this.connectSource(source);
    }

    console.error(`Successfully connected to ${sources.length} database source(s)`);
  }

  /**
   * Connect to a single source (helper for connectWithSources)
   */
  private async connectSource(source: SourceConfig): Promise<void> {
    const sourceId = source.id;
    console.error(`Connecting to source '${sourceId || "(default)"}' ...`);

    // Build DSN from source config
    const dsn = buildDSNFromSource(source);

    // Setup SSH tunnel if needed
    let actualDSN = dsn;
    if (source.ssh_host) {
      const sshConfig: SSHTunnelConfig = {
        host: source.ssh_host,
        port: source.ssh_port || 22,
        username: source.ssh_user!,
        password: source.ssh_password,
        privateKey: source.ssh_key,
        passphrase: source.ssh_passphrase,
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

    // Find connector for this DSN
    const connector = ConnectorRegistry.getConnectorForDSN(actualDSN);
    if (!connector) {
      throw new Error(
        `Source '${sourceId}': No connector found for DSN: ${actualDSN}`
      );
    }

    // Connect to the database
    await connector.connect(actualDSN);

    // Store connector
    this.connectors.set(sourceId, connector);
    this.sourceIds.push(sourceId);

    // Store execute options
    const options: ExecuteOptions = {};
    if (source.max_rows !== undefined) {
      options.maxRows = source.max_rows;
    }
    if (source.readonly !== undefined) {
      options.readonly = source.readonly;
    }
    this.executeOptions.set(sourceId, options);

    console.error(`  Connected successfully`);
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
    this.executeOptions.clear();
    this.sourceIds = [];

    // Disconnect legacy single connector
    if (this.activeConnector && this.connected) {
      await this.activeConnector.disconnect();
      this.connected = false;
    }

    // Close legacy SSH tunnel if it exists
    if (this.sshTunnel) {
      await this.sshTunnel.close();
      this.sshTunnel = null;
    }

    this.originalDSN = null;
  }

  /**
   * Get a connector by source ID
   * If sourceId is not provided, returns the default (first) connector
   */
  getConnector(sourceId?: string): Connector {
    // Multi-source mode
    if (this.connectors.size > 0) {
      const id = sourceId || this.sourceIds[0];
      const connector = this.connectors.get(id);

      if (!connector) {
        if (sourceId) {
          throw new Error(
            `Source '${sourceId}' not found. Available sources: ${this.sourceIds.join(", ")}`
          );
        } else {
          throw new Error("No default source found");
        }
      }

      return connector;
    }

    // Legacy single-connector mode
    if (!this.activeConnector) {
      throw new Error("No active connector. Call connectWithDSN() or connectWithType() first.");
    }
    return this.activeConnector;
  }

  /**
   * Check if there's an active connection
   */
  isConnected(): boolean {
    return this.connected;
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
   * Get execute options for SQL execution
   * @param sourceId - Optional source ID. If not provided, returns default options
   */
  getExecuteOptions(sourceId?: string): ExecuteOptions {
    // Multi-source mode
    if (this.connectors.size > 0) {
      const id = sourceId || this.sourceIds[0];
      return this.executeOptions.get(id) || {};
    }

    // Legacy single-connector mode
    const options: ExecuteOptions = {};
    if (this.maxRows !== null) {
      options.maxRows = this.maxRows;
    }
    return options;
  }

  /**
   * Get the current execute options
   * This is used by tool handlers
   * @param sourceId - Optional source ID. If not provided, returns default options
   */
  static getCurrentExecuteOptions(sourceId?: string): ExecuteOptions {
    if (!managerInstance) {
      throw new Error("ConnectorManager not initialized");
    }
    return managerInstance.getExecuteOptions(sourceId);
  }

  /**
   * Get all available source IDs
   */
  getSourceIds(): string[] {
    return [...this.sourceIds];
  }

  /**
   * Public static accessor to retrieve all available source IDs from the singleton ConnectorManager instance.
   * Use this method to list available databases when you do not have an instance of ConnectorManager.
   * Throws an error if the ConnectorManager has not been initialized.
   */
  static getAvailableSourceIds(): string[] {
    if (!managerInstance) {
      throw new Error("ConnectorManager not initialized");
    }
    return managerInstance.getSourceIds();
  }
  
  /**
   * Get default port for a database based on DSN protocol
   */
  private getDefaultPort(dsn: string): number {
    if (dsn.startsWith('postgres://') || dsn.startsWith('postgresql://')) {
      return 5432;
    } else if (dsn.startsWith('mysql://')) {
      return 3306;
    } else if (dsn.startsWith('mariadb://')) {
      return 3306;
    } else if (dsn.startsWith('sqlserver://')) {
      return 1433;
    }
    // SQLite doesn't use ports
    return 0;
  }
}
