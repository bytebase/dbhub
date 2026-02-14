import { createClient } from "redis";
import type { RedisClientType } from "redis";
import { Connector, ConnectorConfig, DSNParser, ExecuteOptions, RedisCommandResult, ConnectorRegistry } from "../interface.js";

/**
 * Redis DSN Parser
 * Format: redis://[username:password@][host][:port][/db]
 * Examples:
 *   redis://localhost:6379/0
 *   redis://user:password@localhost:6379
 *   redis://myredis.example.com:6380
 */
export class RedisDSNParser implements DSNParser {
  parse(dsn: string): any {
    try {
      const url = new URL(dsn);
      if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
        throw new Error("Invalid Redis DSN protocol");
      }

      const host = url.hostname || "localhost";
      const port = url.port ? parseInt(url.port, 10) : 6379;
      const db = url.pathname ? parseInt(url.pathname.slice(1), 10) : 0;
      const username = url.username || undefined;
      const password = url.password || undefined;

      return {
        host,
        port,
        db,
        username,
        password,
        tls: url.protocol === "rediss:",
      };
    } catch (error) {
      throw new Error(`Failed to parse Redis DSN: ${error}`);
    }
  }

  getSampleDSN(): string {
    return "redis://localhost:6379/0";
  }

  isValidDSN(dsn: string): boolean {
    try {
      const url = new URL(dsn);
      return url.protocol === "redis:" || url.protocol === "rediss:";
    } catch {
      return false;
    }
  }
}

/**
 * Redis Connector Implementation
 * Supports all Redis data structures:
 * - Strings
 * - Hashes
 * - Lists
 * - Sets
 * - Sorted Sets
 * - Streams
 */
export class RedisConnector implements Connector {
  id = "redis" as const;
  name = "Redis";
  dsnParser = new RedisDSNParser();
  private client: RedisClientType | null = null;
  private sourceId: string = "default";

  getId(): string {
    return this.sourceId;
  }

  clone(): Connector {
    return new RedisConnector();
  }

  async connect(dsn: string, _initScript?: string, config?: ConnectorConfig): Promise<void> {
    try {
      const options = this.dsnParser.parse(dsn);

      this.client = createClient({
        host: options.host,
        port: options.port,
        username: options.username,
        password: options.password,
        db: options.db,
        tls: options.tls ? {} : undefined,
        socket: {
          connectTimeout: (config?.connectionTimeoutSeconds || 10) * 1000,
        },
      });

      this.client.on("error", (err) =>
        console.error("Redis Client Error:", err)
      );

      await this.client.connect();
      console.error(
        `Connected to Redis at ${options.host}:${options.port} (db: ${options.db})`
      );
    } catch (error) {
      throw new Error(`Failed to connect to Redis: ${error}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
    }
  }

  // SQL-like methods return empty arrays for Redis
  async getSchemas(): Promise<string[]> {
    return [];
  }

  async getTables(): Promise<string[]> {
    if (!this.client) throw new Error("Redis not connected");
    // Return list of all keys grouped conceptually
    return [];
  }

  async getTableSchema(): Promise<any[]> {
    return [];
  }

  async tableExists(): Promise<boolean> {
    return false;
  }

  async getTableIndexes(): Promise<any[]> {
    return [];
  }

  async getStoredProcedures(): Promise<string[]> {
    return [];
  }

  async getStoredProcedureDetail(): Promise<any> {
    return null;
  }

  async executeSQL(): Promise<any> {
    throw new Error("Redis does not support SQL. Use executeCommand instead.");
  }

  /**
   * Execute a Redis command
   * Examples:
   *   GET mykey
   *   SET mykey value
   *   HGETALL myhash
   *   LPUSH mylist value
   *   SADD myset member
   *   ZADD myzset 1 member
   */
  async executeCommand(command: string, options?: ExecuteOptions): Promise<RedisCommandResult> {
    if (!this.client) throw new Error("Redis not connected");

    try {
      const parts = command.trim().split(/\s+/);
      const cmd = parts[0].toUpperCase();
      const args = parts.slice(1);

      let value: any;
      let type: RedisCommandResult["type"] = "nil";

      // Execute the appropriate Redis command
      switch (cmd) {
        // String commands
        case "GET":
          value = await this.client.get(args[0]);
          type = value ? "string" : "nil";
          break;
        case "SET": {
          const key = args[0];
          const val = args.slice(1).join(" ");
          await this.client.set(key, val);
          value = "OK";
          type = "string";
          break;
        }
        case "APPEND":
          value = await this.client.append(args[0], args.slice(1).join(" "));
          type = "string";
          break;
        case "STRLEN":
          value = await this.client.strLen(args[0]);
          type = "string";
          break;
        case "INCR":
          value = await this.client.incr(args[0]);
          type = "string";
          break;
        case "DECR":
          value = await this.client.decr(args[0]);
          type = "string";
          break;

        // Hash commands
        case "HGET":
          value = await this.client.hGet(args[0], args[1]);
          type = value ? "hash" : "nil";
          break;
        case "HGETALL":
          value = await this.client.hGetAll(args[0]);
          type = "hash";
          break;
        case "HKEYS":
          value = await this.client.hKeys(args[0]);
          type = "hash";
          break;
        case "HVALS":
          value = await this.client.hVals(args[0]);
          type = "hash";
          break;
        case "HSET": {
          const key = args[0];
          const field = args[1];
          const val = args.slice(2).join(" ");
          value = await this.client.hSet(key, field, val);
          type = "hash";
          break;
        }
        case "HDEL":
          value = await this.client.hDel(args[0], args.slice(1));
          type = "hash";
          break;
        case "HEXISTS":
          value = await this.client.hExists(args[0], args[1]);
          type = "hash";
          break;
        case "HLEN":
          value = await this.client.hLen(args[0]);
          type = "hash";
          break;

        // List commands
        case "LPUSH":
          value = await this.client.lPush(args[0], args.slice(1));
          type = "list";
          break;
        case "RPUSH":
          value = await this.client.rPush(args[0], args.slice(1));
          type = "list";
          break;
        case "LPOP":
          value = await this.client.lPop(args[0]);
          type = value ? "list" : "nil";
          break;
        case "RPOP":
          value = await this.client.rPop(args[0]);
          type = value ? "list" : "nil";
          break;
        case "LRANGE": {
          const key = args[0];
          const start = parseInt(args[1], 10);
          const stop = parseInt(args[2], 10);
          value = await this.client.lRange(key, start, stop);
          type = "list";
          break;
        }
        case "LLEN":
          value = await this.client.lLen(args[0]);
          type = "list";
          break;
        case "LINDEX": {
          const key = args[0];
          const index = parseInt(args[1], 10);
          value = await this.client.lIndex(key, index);
          type = value ? "list" : "nil";
          break;
        }

        // Set commands
        case "SADD":
          value = await this.client.sAdd(args[0], args.slice(1));
          type = "set";
          break;
        case "SREM":
          value = await this.client.sRem(args[0], args.slice(1));
          type = "set";
          break;
        case "SMEMBERS":
          value = await this.client.sMembers(args[0]);
          type = "set";
          break;
        case "SISMEMBER":
          value = await this.client.sIsMember(args[0], args[1]);
          type = "set";
          break;
        case "SCARD":
          value = await this.client.sCard(args[0]);
          type = "set";
          break;

        // Sorted Set commands
        case "ZADD": {
          const key = args[0];
          const score = parseFloat(args[1]);
          const member = args.slice(2).join(" ");
          value = await this.client.zAdd(key, { score, value: member });
          type = "zset";
          break;
        }
        case "ZRANGE": {
          const key = args[0];
          const start = parseInt(args[1], 10);
          const stop = parseInt(args[2], 10);
          value = await this.client.zRange(key, start, stop);
          type = "zset";
          break;
        }
        case "ZREM":
          value = await this.client.zRem(args[0], args.slice(1));
          type = "zset";
          break;
        case "ZCARD":
          value = await this.client.zCard(args[0]);
          type = "zset";
          break;
        case "ZSCORE":
          value = await this.client.zScore(args[0], args[1]);
          type = "zset";
          break;

        // Generic commands
        case "DEL":
          value = await this.client.del(args);
          type = "string";
          break;
        case "EXISTS":
          value = await this.client.exists(args);
          type = "string";
          break;
        case "KEYS": {
          const pattern = args[0] || "*";
          value = await this.client.keys(pattern);
          if (options?.maxRows && value.length > options.maxRows) {
            value = value.slice(0, options.maxRows);
          }
          type = "string";
          break;
        }
        case "SCAN": {
          const cursor = parseInt(args[0], 10) || 0;
          const result = await this.client.scan(cursor);
          value = result;
          type = "string";
          break;
        }
        case "TYPE":
          value = await this.client.type(args[0]);
          type = "string";
          break;
        case "TTL":
          value = await this.client.ttl(args[0]);
          type = "string";
          break;
        case "EXPIRE": {
          const key = args[0];
          const seconds = parseInt(args[1], 10);
          value = await this.client.expire(key, seconds);
          type = "string";
          break;
        }
        case "DBSIZE":
          value = await this.client.dbSize();
          type = "string";
          break;
        case "FLUSHDB":
          await this.client.flushDb();
          value = "OK";
          type = "string";
          break;
        case "INFO": {
          const section = args[0] || "default";
          value = await this.client.info(section);
          type = "string";
          break;
        }

        default:
          throw new Error(`Unknown Redis command: ${cmd}`);
      }

      return { value, type };
    } catch (error) {
      throw new Error(`Redis command failed: ${error}`);
    }
  }

  setSourceId(sourceId: string): void {
    this.sourceId = sourceId;
  }
}

export function createRedisConnector(): Connector {
  return new RedisConnector();
}

// Register the Redis connector
const redisConnector = createRedisConnector();
ConnectorRegistry.register(redisConnector);
