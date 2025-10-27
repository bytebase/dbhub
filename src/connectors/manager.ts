import { Connector, ConnectorType, ConnectorRegistry, ExecuteOptions, DatabaseConnection } from "./interface.js";
import { SSHTunnel } from "../utils/ssh-tunnel.js";
import { resolveSSHConfig, resolveMaxRows } from "../config/env.js";
import type { SSHTunnelConfig } from "../types/ssh.js";

// Singleton instance for global access
let managerInstance: ConnectorManager | null = null;

/**
 * Manages multiple database connectors and provides a unified interface to work with them
 */
export class ConnectorManager {
  private connections: Map<string, DatabaseConnection> = new Map();
  private activeConnectionId: string = "default";
  private sshTunnels: Map<string, SSHTunnel> = new Map();
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
   * Initialize and connect to a database using a DSN with a specific ID
   */
  async connectWithDSN(dsn: string, id: string = "default", initScript?: string): Promise<void> {
    // Check if SSH tunnel is needed
    const sshConfig = resolveSSHConfig();
    let actualDSN = dsn;
    let sshTunnel: SSHTunnel | null = null;

    if (sshConfig) {
      console.error(`SSH tunnel configuration loaded from ${sshConfig.source}`);

      // Parse DSN to get database host and port
      const url = new URL(dsn);
      const targetHost = url.hostname;
      const targetPort = parseInt(url.port) || this.getDefaultPort(dsn);

      // Create and establish SSH tunnel
      sshTunnel = new SSHTunnel();
      const tunnelInfo = await sshTunnel.establish(sshConfig.config, {
        targetHost,
        targetPort,
      });

      // Update DSN to use local tunnel endpoint
      url.hostname = '127.0.0.1';
      url.port = tunnelInfo.localPort.toString();
      actualDSN = url.toString();

      console.error(`Database connection will use SSH tunnel through localhost:${tunnelInfo.localPort}`);

      // Store SSH tunnel for this connection
      this.sshTunnels.set(id, sshTunnel);
    }

    // First try to find a connector that can handle this DSN
    const connectorType = ConnectorRegistry.getConnectorForDSN(actualDSN)?.id;

    if (!connectorType) {
      throw new Error(`No connector found that can handle the DSN: ${actualDSN}`);
    }

    // Create a new connector instance for this connection
    // This ensures each database connection has its own isolated connector
    const connector = await this.createConnectorInstance(connectorType);

    // Connect to the database through tunnel if applicable
    await connector.connect(actualDSN, initScript);

    // Store the connection
    const connection: DatabaseConnection = {
      id,
      connector,
      dsn: dsn,
      source: "programmatic",
      sshConfig: sshConfig?.config
    };

    this.connections.set(id, connection);

    // Set as active if this is the first connection
    if (this.connections.size === 1) {
      this.activeConnectionId = id;
    }
  }

  /**
   * Initialize and connect to the database using a specific connector type
   */
  async connectWithType(connectorType: ConnectorType, dsn?: string, id: string = "default"): Promise<void> {
    // Create a new connector instance for this connection
    const connector = await this.createConnectorInstance(connectorType);

    // Use provided DSN or get sample DSN
    const connectionString = dsn || connector.dsnParser.getSampleDSN();

    // Connect to the database
    await connector.connect(connectionString);

    // Store the connection
    const connection: DatabaseConnection = {
      id,
      connector,
      dsn: connectionString,
      source: "programmatic"
    };

    this.connections.set(id, connection);

    // Set as active if this is the first connection
    if (this.connections.size === 1) {
      this.activeConnectionId = id;
    }
  }

  /**
   * Close all database connections
   */
  async disconnect(): Promise<void> {
    // Close all database connections
    for (const [, connection] of this.connections) {
      await connection.connector.disconnect();
    }
    this.connections.clear();

    // Close all SSH tunnels
    for (const [, sshTunnel] of this.sshTunnels) {
      await sshTunnel.close();
    }
    this.sshTunnels.clear();

    this.activeConnectionId = "default";
  }

  /**
   * Close a specific database connection
   */
  async disconnectConnection(id: string): Promise<void> {
    const connection = this.connections.get(id);
    if (connection) {
      await connection.connector.disconnect();
      this.connections.delete(id);
    }

    // Close SSH tunnel for this connection if it exists
    const sshTunnel = this.sshTunnels.get(id);
    if (sshTunnel) {
      await sshTunnel.close();
      this.sshTunnels.delete(id);
    }

    // Update active connection if needed
    if (this.activeConnectionId === id && this.connections.size > 0) {
      this.activeConnectionId = Array.from(this.connections.keys())[0];
    } else if (this.connections.size === 0) {
      this.activeConnectionId = "default";
    }
  }

  /**
   * Get a connector by ID
   */
  getConnector(id?: string): Connector {
    const connectionId = id || this.activeConnectionId;
    const connection = this.connections.get(connectionId);

    if (!connection) {
      throw new Error(`No database connection found for ID: ${connectionId}. Available connections: ${Array.from(this.connections.keys()).join(', ')}`);
    }

    return connection.connector;
  }

  /**
   * Switch to a different database connection
   */
  switchConnection(id: string): void {
    if (!this.connections.has(id)) {
      throw new Error(`Database connection not found: ${id}. Available connections: ${Array.from(this.connections.keys()).join(', ')}`);
    }
    this.activeConnectionId = id;
  }

  /**
   * Get the active connection ID
   */
  getActiveConnectionId(): string {
    return this.activeConnectionId;
  }

  /**
   * Get all available connection IDs
   */
  getAvailableConnections(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * Check if a specific connection exists
   */
  hasConnection(id: string): boolean {
    return this.connections.has(id);
  }

  /**
   * Check if there's any active connection
   */
  isConnected(): boolean {
    return this.connections.size > 0;
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
   * Get a connector by ID
   * This is used by resource and tool handlers
   */
  static getConnector(id?: string): Connector {
    // Try global instance first (for HTTP transport)
    const globalInstance = (global as any).__dbhubConnectorManager;
    if (globalInstance) {
      return globalInstance.getConnector(id);
    }

    // Fall back to singleton instance
    if (!managerInstance) {
      throw new Error("ConnectorManager not initialized");
    }
    return managerInstance.getConnector(id);
  }

  /**
   * Get the active connector instance (for backward compatibility)
   * This is used by resource and tool handlers that don't specify a database ID
   */
  static getCurrentConnector(): Connector {
    if (!managerInstance) {
      throw new Error("ConnectorManager not initialized");
    }
    return managerInstance.getConnector();
  }

  /**
   * Get execute options for SQL execution
   */
  getExecuteOptions(): ExecuteOptions {
    const options: ExecuteOptions = {};
    if (this.maxRows !== null) {
      options.maxRows = this.maxRows;
    }
    return options;
  }

  /**
   * Get the current execute options
   * This is used by tool handlers
   */
  static getCurrentExecuteOptions(): ExecuteOptions {
    if (!managerInstance) {
      throw new Error("ConnectorManager not initialized");
    }
    return managerInstance.getExecuteOptions();
  }

  /**
   * Get all available connection IDs
   */
  static getAvailableConnections(): string[] {
    if (!managerInstance) {
      throw new Error("ConnectorManager not initialized");
    }
    return managerInstance.getAvailableConnections();
  }

  /**
   * Get the active connection ID
   */
  static getActiveConnectionId(): string {
    if (!managerInstance) {
      throw new Error("ConnectorManager not initialized");
    }
    return managerInstance.getActiveConnectionId();
  }

  /**
   * Switch to a different database connection
   */
  static switchConnection(id: string): void {
    if (!managerInstance) {
      throw new Error("ConnectorManager not initialized");
    }
    managerInstance.switchConnection(id);
  }
  
  /**
   * Create a new connector instance for a specific connector type
   * This ensures each database connection has its own isolated connector instance
   */
  private async createConnectorInstance(connectorType: ConnectorType): Promise<Connector> {
    // Import the connector modules dynamically to avoid circular dependencies
    switch (connectorType) {
      case "postgres":
        const { PostgresConnector } = await import("./postgres/index.js");
        return new PostgresConnector();
      case "mysql":
        const { MySQLConnector } = await import("./mysql/index.js");
        return new MySQLConnector();
      case "mariadb":
        const { MariaDBConnector } = await import("./mariadb/index.js");
        return new MariaDBConnector();
      case "sqlserver":
        const { SQLServerConnector } = await import("./sqlserver/index.js");
        return new SQLServerConnector();
      case "sqlite":
        const { SQLiteConnector } = await import("./sqlite/index.js");
        return new SQLiteConnector();
      default:
        throw new Error(`Unsupported connector type: ${connectorType}`);
    }
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
