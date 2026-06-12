import { createClient, createCluster, createSentinel } from "redis";
import {
  Connector,
  ConnectorType,
  ConnectorRegistry,
  DSNParser,
  SQLResult,
  TableColumn,
  TableIndex,
  StoredProcedure,
  ExecuteOptions,
  ConnectorConfig,
} from "../interface.js";
import { SafeURL } from "../../utils/safe-url.js";
import { obfuscateDSNPassword } from "../../utils/dsn-obfuscate.js";
import { isReadOnlyRedisCommand, parseRedisStatements } from "../../utils/redis-command-parser.js";

const DEFAULT_REDIS_PORT = 6379;
const DEFAULT_REDIS_DATABASE = 0;
const KEY_SCAN_COUNT = 100;
const KEY_SCAN_LIMIT = 1000;

type RedisMode = "single" | "cluster" | "sentinel";

interface RedisEndpoint {
  host: string;
  port: number;
  url: string;
  username?: string;
  password?: string;
  tls: boolean;
}

interface RedisConnectionConfig {
  mode: RedisMode;
  url: string;
  database: number;
  nodes: RedisEndpoint[];
  sentinels: RedisEndpoint[];
  sentinelMaster?: string;
  username?: string;
  password?: string;
  sentinelUsername?: string;
  sentinelPassword?: string;
  useTLS: boolean;
  connectionTimeoutMs?: number;
  queryTimeoutMs?: number;
}

class RedisDSNParser implements DSNParser {
  async parse(dsn: string, config?: ConnectorConfig): Promise<RedisConnectionConfig> {
    if (!this.isValidDSN(dsn)) {
      const obfuscatedDSN = obfuscateDSNPassword(dsn);
      const expectedFormat = this.getSampleDSN();
      throw new Error(
        `Invalid Redis DSN format.\nProvided: ${obfuscatedDSN}\nExpected: ${expectedFormat}`
      );
    }

    try {
      const baseEndpoint = parseRedisEndpoint(dsn);
      const url = new SafeURL(dsn);
      const rawDatabase =
        url.pathname && url.pathname !== "/" ? decodeURIComponent(url.pathname.substring(1)) : "";
      const dsnDatabase = rawDatabase ? Number(rawDatabase) : DEFAULT_REDIS_DATABASE;
      if (!Number.isInteger(dsnDatabase) || dsnDatabase < 0) {
        throw new Error(`invalid Redis database '${rawDatabase}'`);
      }

      const mode = config?.redisMode ?? "single";
      if (!["single", "cluster", "sentinel"].includes(mode)) {
        throw new Error(`invalid Redis mode '${mode}'`);
      }

      const database = config?.redisDatabase ?? dsnDatabase;
      if (!Number.isInteger(database) || database < 0) {
        throw new Error(`invalid Redis database '${database}'`);
      }
      if (mode === "cluster" && database !== DEFAULT_REDIS_DATABASE) {
        throw new Error("Redis Cluster only supports logical database 0");
      }

      const username = config?.redisUsername ?? baseEndpoint.username;
      const password = config?.redisPassword ?? baseEndpoint.password;
      const useTLS = config?.redisUseTLS ?? baseEndpoint.tls;
      const endpointDefaults = {
        username,
        password,
        useTLS,
      };

      const nodes =
        mode === "cluster"
          ? parseRedisEndpointList(config?.redisNodes, endpointDefaults, "cluster node")
          : [baseEndpoint];
      const sentinels =
        mode === "sentinel"
          ? parseRedisEndpointList(config?.redisSentinels, endpointDefaults, "sentinel node")
          : [];

      if (mode === "cluster" && nodes.length === 0) {
        throw new Error("Redis Cluster requires at least one root node");
      }
      if (mode === "sentinel") {
        if (sentinels.length === 0) {
          throw new Error("Redis Sentinel requires at least one sentinel node");
        }
        if (!config?.redisSentinelMaster?.trim()) {
          throw new Error("Redis Sentinel requires sentinel_master");
        }
      }

      return {
        mode,
        url: formatRedisEndpointUrl({ ...baseEndpoint, username, password, tls: useTLS }),
        database,
        nodes,
        sentinels,
        sentinelMaster: config?.redisSentinelMaster,
        username,
        password,
        sentinelUsername: config?.redisSentinelUsername,
        sentinelPassword: config?.redisSentinelPassword,
        useTLS,
        connectionTimeoutMs:
          config?.connectionTimeoutSeconds !== undefined
            ? config.connectionTimeoutSeconds * 1000
            : undefined,
        queryTimeoutMs:
          config?.queryTimeoutSeconds !== undefined ? config.queryTimeoutSeconds * 1000 : undefined,
      };
    } catch (error) {
      throw new Error(
        `Failed to parse Redis DSN: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getSampleDSN(): string {
    return "redis://default:password@localhost:6379/0";
  }

  isValidDSN(dsn: string): boolean {
    try {
      return dsn.startsWith("redis://") || dsn.startsWith("rediss://");
    } catch {
      return false;
    }
  }
}

export class RedisConnector implements Connector {
  id: ConnectorType = "redis";
  name = "Redis";
  dsnParser = new RedisDSNParser();

  private client: any = null;
  private connectionConfig: RedisConnectionConfig | null = null;
  private selectedDatabase = DEFAULT_REDIS_DATABASE;
  private sourceId = "default";
  private mode: RedisMode = "single";

  getId(): string {
    return this.sourceId;
  }

  clone(): Connector {
    return new RedisConnector();
  }

  async connect(dsn: string, initScript?: string, config?: ConnectorConfig): Promise<void> {
    try {
      const connectionConfig = await this.dsnParser.parse(dsn, config);
      this.connectionConfig = connectionConfig;
      this.mode = connectionConfig.mode;
      this.selectedDatabase = connectionConfig.database;
      this.client = this.createRedisClient(connectionConfig);

      this.client.on?.("error", (err: Error) => {
        console.error("Redis client error:", err);
      });

      await this.client.connect();
      await this.selectDatabase(connectionConfig.database);

      if (initScript) {
        await this.executeSQL(initScript, {});
      }
    } catch (err) {
      console.error("Failed to connect to Redis:", err);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      if (typeof this.client.quit === "function") {
        await this.client.quit();
      } else if (typeof this.client.close === "function") {
        await this.client.close();
      }
    } catch {
      if (typeof this.client.disconnect === "function") {
        await this.client.disconnect();
      } else if (typeof this.client.destroy === "function") {
        await this.client.destroy();
      }
    } finally {
      this.client = null;
      this.connectionConfig = null;
      this.mode = "single";
    }
  }

  async getSchemas(): Promise<string[]> {
    if (this.mode === "cluster") {
      return [String(DEFAULT_REDIS_DATABASE)];
    }

    const configuredDatabases = await this.getConfiguredDatabaseCount();
    if (!configuredDatabases) {
      return [String(this.selectedDatabase)];
    }
    return Array.from({ length: configuredDatabases }, (_, index) => String(index));
  }

  async getDefaultSchema(): Promise<string | null> {
    return String(this.selectedDatabase);
  }

  async getTables(schema?: string): Promise<string[]> {
    const database = this.parseDatabase(schema);
    return this.withDatabase(database, async () => {
      if (this.mode === "cluster") {
        return this.scanClusterKeys();
      }
      return this.scanKeysWithClient(this.ensureClient());
    });
  }

  async getViews(): Promise<string[]> {
    return [];
  }

  async getTableSchema(tableName: string, schema?: string): Promise<TableColumn[]> {
    const database = this.parseDatabase(schema);
    const info = await this.withDatabase(database, () => this.getKeyInfo(tableName));

    return [
      {
        column_name: "key",
        data_type: "redis-key",
        is_nullable: "NO",
        column_default: null,
        description: "Redis key name",
      },
      {
        column_name: "type",
        data_type: info.type,
        is_nullable: "NO",
        column_default: null,
        description: "Redis value type",
      },
      {
        column_name: "ttl_seconds",
        data_type: "integer",
        is_nullable: "YES",
        column_default: null,
        description: "TTL in seconds (-1 means no expiry, -2 means key does not exist)",
      },
      {
        column_name: "length",
        data_type: "integer",
        is_nullable: "YES",
        column_default: null,
        description: "Type-specific length or cardinality",
      },
      {
        column_name: "memory_usage_bytes",
        data_type: "integer",
        is_nullable: "YES",
        column_default: null,
        description: "Approximate memory usage when Redis exposes it",
      },
    ];
  }

  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    const database = this.parseDatabase(schema);
    return this.withDatabase(database, async () => {
      const type = await this.sendCommand(["TYPE", tableName]);
      return String(type) !== "none";
    });
  }

  async getTableIndexes(): Promise<TableIndex[]> {
    return [];
  }

  async getStoredProcedures(): Promise<string[]> {
    return [];
  }

  async getStoredProcedureDetail(procedureName: string): Promise<StoredProcedure> {
    throw new Error(`Redis does not support stored procedure/function metadata: ${procedureName}`);
  }

  async getTableRowCount(tableName: string, schema?: string): Promise<number | null> {
    const database = this.parseDatabase(schema);
    const info = await this.withDatabase(database, () => this.getKeyInfo(tableName));
    return info.length;
  }

  async getTableComment(tableName: string, schema?: string): Promise<string | null> {
    const database = this.parseDatabase(schema);
    const info = await this.withDatabase(database, () => this.getKeyInfo(tableName));
    const ttl = info.ttlSeconds === -1 ? "no expiry" : `${info.ttlSeconds}s TTL`;
    return `Redis ${info.type} key, ${ttl}`;
  }

  async executeSQL(
    sql: string,
    options: ExecuteOptions = {},
    parameters?: any[]
  ): Promise<SQLResult> {
    const commands = parseRedisStatements(sql);
    if (commands.length === 0) {
      return { rows: [], rowCount: 0 };
    }

    const commandsWithParameters = this.applyParameters(commands, parameters);

    if (options.readonly && !commandsWithParameters.every(isReadOnlyRedisCommand)) {
      throw new Error(
        "Read-only mode is enabled. Redis command is not in the read-only allow-list."
      );
    }

    const rows = [];
    for (const command of commandsWithParameters) {
      const commandName = command[0].toLowerCase();

      if (commandName === "select" && this.mode === "cluster") {
        const selected = Number(command[1]);
        if (selected !== DEFAULT_REDIS_DATABASE) {
          throw new Error("Redis Cluster only supports logical database 0");
        }
        this.selectedDatabase = DEFAULT_REDIS_DATABASE;
        rows.push({
          command: command[0].toUpperCase(),
          arguments: command.slice(1),
          result: "OK",
        });
        continue;
      }

      const result = await this.sendCommand(command);
      if (commandName === "select") {
        const selected = Number(command[1]);
        if (Number.isInteger(selected) && selected >= 0) {
          this.selectedDatabase = selected;
        }
      }
      rows.push({
        command: command[0].toUpperCase(),
        arguments: command.slice(1),
        result: this.normalizeCommandResult(command[0], result),
      });
    }

    return { rows, rowCount: rows.length };
  }

  private createRedisClient(config: RedisConnectionConfig): any {
    switch (config.mode) {
      case "cluster": {
        const defaults: Record<string, any> = {};
        if (config.username) {
          defaults.username = config.username;
        }
        if (config.password) {
          defaults.password = config.password;
        }
        const socket = buildRedisSocketOptions(config.connectionTimeoutMs, config.useTLS);
        if (socket) {
          defaults.socket = socket;
        }

        const clusterOptions: Record<string, any> = {
          rootNodes: config.nodes.map((node) => ({ url: node.url })),
        };
        if (Object.keys(defaults).length > 0) {
          clusterOptions.defaults = defaults;
        }
        return createCluster(clusterOptions as any);
      }
      case "sentinel": {
        const nodeClientOptions: Record<string, any> = {};
        if (config.username) {
          nodeClientOptions.username = config.username;
        }
        if (config.password) {
          nodeClientOptions.password = config.password;
        }
        const nodeSocket = buildRedisSocketOptions(config.connectionTimeoutMs, config.useTLS);
        if (nodeSocket) {
          nodeClientOptions.socket = nodeSocket;
        }

        const sentinelClientOptions: Record<string, any> = {};
        if (config.sentinelUsername) {
          sentinelClientOptions.username = config.sentinelUsername;
        }
        if (config.sentinelPassword) {
          sentinelClientOptions.password = config.sentinelPassword;
        }
        const sentinelSocket = buildRedisSocketOptions(
          config.connectionTimeoutMs,
          config.sentinels.some((sentinel) => sentinel.tls) || config.useTLS
        );
        if (sentinelSocket) {
          sentinelClientOptions.socket = sentinelSocket;
        }

        const sentinelOptions: Record<string, any> = {
          name: config.sentinelMaster,
          sentinelRootNodes: config.sentinels.map((sentinel) => ({
            host: sentinel.host,
            port: sentinel.port,
          })),
        };
        if (Object.keys(nodeClientOptions).length > 0) {
          sentinelOptions.nodeClientOptions = nodeClientOptions;
        }
        if (Object.keys(sentinelClientOptions).length > 0) {
          sentinelOptions.sentinelClientOptions = sentinelClientOptions;
        }
        return createSentinel(sentinelOptions as any);
      }
      case "single":
      default:
        return createClient({
          url: config.url,
          socket: {
            connectTimeout: config.connectionTimeoutMs,
          },
        });
    }
  }

  private ensureClient(): any {
    if (!this.client) {
      throw new Error("Redis connector is not connected");
    }
    return this.client;
  }

  private async sendCommand(args: string[]): Promise<any> {
    const client = this.ensureClient();
    return this.runWithTimeout(this.sendCommandWithClient(client, args));
  }

  private sendCommandWithClient(client: any, args: string[]): Promise<any> {
    if (this.mode === "cluster" && client === this.client) {
      return client.sendCommand(
        getRedisCommandFirstKey(args),
        isReadOnlyRedisCommand(args),
        args
      );
    }
    if (this.mode === "sentinel") {
      return client.sendCommand(isReadOnlyRedisCommand(args), args);
    }
    return client.sendCommand(args);
  }

  private async runWithTimeout<T>(operation: Promise<T>): Promise<T> {
    const timeoutMs = this.connectionConfig?.queryTimeoutMs;
    if (!timeoutMs) {
      return operation;
    }

    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Redis command timed out after ${timeoutMs}ms`)),
            timeoutMs
          );
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async selectDatabase(database: number): Promise<void> {
    if (this.mode === "cluster") {
      if (database !== DEFAULT_REDIS_DATABASE) {
        throw new Error("Redis Cluster only supports logical database 0");
      }
      this.selectedDatabase = DEFAULT_REDIS_DATABASE;
      return;
    }

    await this.sendCommand(["SELECT", String(database)]);
    this.selectedDatabase = database;
  }

  private parseDatabase(schema?: string): number {
    if (!schema) {
      return this.selectedDatabase;
    }
    const database = Number(schema);
    if (!Number.isInteger(database) || database < 0) {
      throw new Error(`Invalid Redis database '${schema}'`);
    }
    if (this.mode === "cluster" && database !== DEFAULT_REDIS_DATABASE) {
      throw new Error("Redis Cluster only supports logical database 0");
    }
    return database;
  }

  private async withDatabase<T>(database: number, fn: () => Promise<T>): Promise<T> {
    if (this.mode === "cluster") {
      if (database !== DEFAULT_REDIS_DATABASE) {
        throw new Error("Redis Cluster only supports logical database 0");
      }
      return fn();
    }

    const previousDatabase = this.selectedDatabase;
    if (database !== previousDatabase) {
      await this.selectDatabase(database);
    }

    try {
      return await fn();
    } finally {
      if (database !== previousDatabase) {
        try {
          await this.selectDatabase(previousDatabase);
        } catch {
          // Keep the original operation result/error; the next operation can reconnect or reselect.
        }
      }
    }
  }

  private async getConfiguredDatabaseCount(): Promise<number | null> {
    try {
      const result = await this.sendCommand(["CONFIG", "GET", "databases"]);
      const normalized = normalizeRedisValue(result);

      if (Array.isArray(normalized)) {
        const index = normalized.findIndex((value) => String(value).toLowerCase() === "databases");
        const rawValue = index >= 0 ? normalized[index + 1] : undefined;
        const count = Number(rawValue);
        return Number.isInteger(count) && count > 0 ? count : null;
      }

      if (normalized && typeof normalized === "object" && "databases" in normalized) {
        const count = Number((normalized as Record<string, unknown>).databases);
        return Number.isInteger(count) && count > 0 ? count : null;
      }
    } catch {
      return null;
    }

    return null;
  }

  private async scanKeysWithClient(client: any): Promise<string[]> {
    const keys: string[] = [];
    let cursor = "0";

    do {
      const response = await this.runWithTimeout(
        client === this.client
          ? this.sendCommandWithClient(client, ["SCAN", cursor, "COUNT", String(KEY_SCAN_COUNT)])
          : client.sendCommand(["SCAN", cursor, "COUNT", String(KEY_SCAN_COUNT)])
      );
      const scanResult = this.normalizeScanResult(response);
      cursor = scanResult.cursor;
      keys.push(...scanResult.results.map(String));
    } while (cursor !== "0" && keys.length < KEY_SCAN_LIMIT);

    return keys.slice(0, KEY_SCAN_LIMIT);
  }

  private async scanClusterKeys(): Promise<string[]> {
    const client = this.ensureClient();
    const masters = Array.isArray(client.masters) ? client.masters : [];
    if (masters.length === 0 || typeof client.nodeClient !== "function") {
      return this.scanKeysWithClient(client);
    }

    const keys = new Set<string>();
    for (const master of masters) {
      const nodeClient = await client.nodeClient(master);
      const nodeKeys = await this.scanKeysWithClient(nodeClient);
      for (const key of nodeKeys) {
        keys.add(key);
        if (keys.size >= KEY_SCAN_LIMIT) {
          return Array.from(keys);
        }
      }
    }
    return Array.from(keys);
  }

  private normalizeScanResult(result: any): { cursor: string; results: any[] } {
    const normalized = normalizeRedisValue(result);
    if (Array.isArray(normalized)) {
      return {
        cursor: String(normalized[0] ?? "0"),
        results: Array.isArray(normalized[1]) ? normalized[1] : [],
      };
    }
    if (normalized && typeof normalized === "object") {
      const objectResult = normalized as Record<string, unknown>;
      return {
        cursor: String(objectResult.cursor ?? "0"),
        results: Array.isArray(objectResult.keys)
          ? objectResult.keys
          : Array.isArray(objectResult.results)
            ? objectResult.results
            : [],
      };
    }
    return { cursor: "0", results: [] };
  }

  private async getKeyInfo(key: string): Promise<{
    type: string;
    ttlSeconds: number;
    length: number | null;
    memoryUsageBytes: number | null;
  }> {
    const type = String(await this.sendCommand(["TYPE", key]));
    const ttlSeconds = Number(await this.sendCommand(["TTL", key]));
    const [length, memoryUsageBytes] = await Promise.all([
      this.getKeyLength(key, type),
      this.getMemoryUsage(key),
    ]);
    return { type, ttlSeconds, length, memoryUsageBytes };
  }

  private async getKeyLength(key: string, type: string): Promise<number | null> {
    const commandByType: Record<string, string> = {
      string: "STRLEN",
      hash: "HLEN",
      list: "LLEN",
      set: "SCARD",
      zset: "ZCARD",
      stream: "XLEN",
    };
    const command = commandByType[type];
    if (!command) {
      return type === "none" ? 0 : null;
    }
    const result = await this.sendCommand([command, key]);
    return Number(result);
  }

  private async getMemoryUsage(key: string): Promise<number | null> {
    try {
      const result = await this.sendCommand(["MEMORY", "USAGE", key]);
      return result === null || result === undefined ? null : Number(result);
    } catch {
      return null;
    }
  }

  private applyParameters(commands: string[][], parameters?: any[]): string[][] {
    if (!parameters || parameters.length === 0) {
      return commands;
    }

    let parameterIndex = 0;
    const replaced = commands.map((args) =>
      args.map((arg) => {
        if (arg !== "?") {
          return arg;
        }
        if (parameterIndex >= parameters.length) {
          throw new Error("Not enough parameters supplied for Redis command placeholders");
        }
        const value = parameters[parameterIndex++];
        return value === null || value === undefined ? "" : String(value);
      })
    );

    if (parameterIndex !== parameters.length) {
      throw new Error("Too many parameters supplied for Redis command placeholders");
    }

    return replaced;
  }

  private normalizeCommandResult(command: string, result: any): any {
    const normalized = normalizeRedisValue(result);
    const commandName = command.toLowerCase();

    if (["scan", "sscan", "hscan", "zscan"].includes(commandName)) {
      return this.normalizeScanResult(normalized);
    }

    if (commandName === "hgetall" && Array.isArray(normalized)) {
      return arrayPairsToObject(normalized);
    }

    return normalized;
  }
}

function parseRedisEndpointList(
  endpoints: string[] | undefined,
  defaults: { username?: string; password?: string; useTLS: boolean },
  label: string
): RedisEndpoint[] {
  if (!endpoints || endpoints.length === 0) {
    return [];
  }
  return endpoints.map((endpoint) => parseRedisEndpoint(endpoint, defaults, label));
}

function parseRedisEndpoint(
  endpoint: string,
  defaults?: { username?: string; password?: string; useTLS: boolean },
  label = "endpoint"
): RedisEndpoint {
  const trimmedEndpoint = endpoint.trim();
  if (!trimmedEndpoint) {
    throw new Error(`Redis ${label} cannot be empty`);
  }

  const endpointWithProtocol = trimmedEndpoint.includes("://")
    ? trimmedEndpoint
    : `${defaults?.useTLS ? "rediss" : "redis"}://${trimmedEndpoint}`;
  const url = new SafeURL(endpointWithProtocol);
  const protocol = url.protocol.replace(":", "");
  if (protocol !== "redis" && protocol !== "rediss") {
    throw new Error(`Redis ${label} must use redis:// or rediss://`);
  }

  const port = url.port ? Number(url.port) : DEFAULT_REDIS_PORT;
  if (!url.hostname) {
    throw new Error(`Redis ${label} host is required`);
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid Redis ${label} port '${url.port}'`);
  }

  const username = url.username || defaults?.username;
  const password = url.password || defaults?.password;
  const tls = protocol === "rediss" || defaults?.useTLS === true;

  return {
    host: url.hostname,
    port,
    username,
    password,
    tls,
    url: formatRedisEndpointUrl({
      host: url.hostname,
      port,
      username,
      password,
      tls,
    }),
  };
}

function formatRedisEndpointUrl(endpoint: {
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls: boolean;
}): string {
  const protocol = endpoint.tls ? "rediss" : "redis";
  const username = endpoint.username ? encodeURIComponent(endpoint.username) : "";
  const password = endpoint.password ? encodeURIComponent(endpoint.password) : "";
  const auth = username || password ? `${username}${password ? `:${password}` : ""}@` : "";
  return `${protocol}://${auth}${endpoint.host}:${endpoint.port}`;
}

function buildRedisSocketOptions(connectTimeout?: number, tls?: boolean): Record<string, any> | undefined {
  const socket: Record<string, any> = {};
  if (connectTimeout !== undefined) {
    socket.connectTimeout = connectTimeout;
  }
  if (tls) {
    socket.tls = true;
  }
  return Object.keys(socket).length > 0 ? socket : undefined;
}

const NO_KEY_REDIS_COMMANDS = new Set([
  "auth",
  "client",
  "command",
  "config",
  "dbsize",
  "echo",
  "flushall",
  "flushdb",
  "info",
  "lastsave",
  "memory",
  "ping",
  "randomkey",
  "role",
  "scan",
  "select",
  "time",
]);

function getRedisCommandFirstKey(args: string[]): string | undefined {
  const command = args[0]?.toLowerCase();
  if (!command || NO_KEY_REDIS_COMMANDS.has(command)) {
    if (command === "memory" && args[1]?.toLowerCase() === "usage") {
      return args[2];
    }
    return undefined;
  }

  if ((command === "eval" || command === "evalsha") && args.length >= 4) {
    const keyCount = Number(args[2]);
    return Number.isInteger(keyCount) && keyCount > 0 ? args[3] : undefined;
  }
  if (command === "bitop") {
    return args[2];
  }
  if (command === "xread" || command === "xreadgroup") {
    const streamsIndex = args.findIndex((arg) => arg.toLowerCase() === "streams");
    return streamsIndex >= 0 ? args[streamsIndex + 1] : undefined;
  }
  if (command === "object") {
    return args[2];
  }

  return args[1];
}

function normalizeRedisValue(value: any): any {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  if (Array.isArray(value)) {
    return value.map(normalizeRedisValue);
  }
  if (value instanceof Map) {
    return Object.fromEntries(
      Array.from(value.entries()).map(([key, nestedValue]) => [
        String(key),
        normalizeRedisValue(nestedValue),
      ])
    );
  }
  if (value instanceof Set) {
    return Array.from(value.values()).map(normalizeRedisValue);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, normalizeRedisValue(nestedValue)])
    );
  }
  return value;
}

function arrayPairsToObject(values: any[]): Record<string, any> {
  const result: Record<string, any> = {};
  for (let i = 0; i < values.length; i += 2) {
    result[String(values[i])] = normalizeRedisValue(values[i + 1]);
  }
  return result;
}

const redisConnector = new RedisConnector();
ConnectorRegistry.register(redisConnector);
