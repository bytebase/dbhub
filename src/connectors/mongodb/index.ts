import { MongoClient, Db, Document } from "mongodb";
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
import { obfuscateDSNPassword } from "../../utils/dsn-obfuscate.js";

/**
 * MongoDB DSN Parser
 * Handles DSN strings like:
 * - mongodb://user:password@localhost:27017/dbname
 * - mongodb+srv://user:password@cluster.example.com/dbname
 */
class MongoDBDSNParser implements DSNParser {
  async parse(
    dsn: string,
    config?: ConnectorConfig
  ): Promise<{ uri: string; options: Record<string, unknown> }> {
    if (!this.isValidDSN(dsn)) {
      const obfuscated = obfuscateDSNPassword(dsn);
      throw new Error(
        `Invalid MongoDB DSN format.\nProvided: ${obfuscated}\nExpected: ${this.getSampleDSN()}`
      );
    }

    const options: Record<string, unknown> = {};

    if (config?.connectionTimeoutSeconds !== undefined) {
      options.connectTimeoutMS = config.connectionTimeoutSeconds * 1000;
      options.serverSelectionTimeoutMS = config.connectionTimeoutSeconds * 1000;
    }

    if (config?.queryTimeoutSeconds !== undefined) {
      options.socketTimeoutMS = config.queryTimeoutSeconds * 1000;
    }

    return { uri: dsn, options };
  }

  getSampleDSN(): string {
    return "mongodb://user:password@localhost:27017/dbname";
  }

  isValidDSN(dsn: string): boolean {
    return dsn.startsWith("mongodb://") || dsn.startsWith("mongodb+srv://");
  }
}

/**
 * Infer a BSON/JS type name from a value
 */
function inferType(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "double";
  if (typeof value === "string") return "string";
  if (typeof value === "bigint") return "long";
  if (value instanceof Date) return "date";
  if (Buffer.isBuffer(value)) return "binData";
  if (Array.isArray(value)) return "array";
  // BSON types surfaced by the driver
  const ctor = (value as any)?.constructor?.name;
  if (ctor) return ctor;
  return "object";
}

/**
 * Extract the database name from a MongoDB connection string.
 * Returns "test" if no database path is present (MongoDB default).
 */
function extractDbName(dsn: string): string {
  try {
    // Strip mongodb+srv scheme to a form URL can parse
    const normalized = dsn.replace(/^mongodb\+srv:\/\//, "https://");
    const url = new URL(normalized);
    const dbName = url.pathname.replace(/^\//, "").split("?")[0];
    return dbName || "test";
  } catch {
    return "test";
  }
}

export class MongoDBConnector implements Connector {
  id: ConnectorType = "mongodb";
  name = "MongoDB";
  dsnParser = new MongoDBDSNParser();

  private client: MongoClient | null = null;
  private db: Db | null = null;
  private dbName: string = "test";

  // Set by ConnectorManager after clone()
  private sourceId: string = "default";

  getId(): string {
    return this.sourceId;
  }

  clone(): Connector {
    return new MongoDBConnector();
  }

  async connect(dsn: string, _initScript?: string, config?: ConnectorConfig): Promise<void> {
    const { uri, options } = await this.dsnParser.parse(dsn, config);
    this.dbName = extractDbName(dsn);

    try {
      console.log(`### Connecting to MongoDB at ${uri} with options: ${JSON.stringify(options)}`);
      this.client = new MongoClient(uri, options as any);
      await this.client.connect();
      this.db = this.client.db(this.dbName);
    } catch (error) {
      console.error("Failed to connect to MongoDB:", error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch (error) {
        console.error("Error during MongoDB disconnect:", error);
      } finally {
        this.client = null;
        this.db = null;
      }
    }
  }

  async getSchemas(): Promise<string[]> {
    if (!this.db) throw new Error("Not connected to MongoDB");
    // Return the current database name as the single "schema"
    // Listing all databases requires admin privileges — not safe as default
    return [this.dbName];
  }

  async getTables(schema?: string): Promise<string[]> {
    if (!this.db) throw new Error("Not connected to MongoDB");
    const collections = await this.db.listCollections({}, { nameOnly: true }).toArray();
    return collections.map((c) => c.name).sort();
  }

  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    if (!this.db) throw new Error("Not connected to MongoDB");
    const collections = await this.db.listCollections({ name: tableName }, { nameOnly: true }).toArray();
    return collections.length > 0;
  }

  async getTableSchema(tableName: string, schema?: string): Promise<TableColumn[]> {
    if (!this.db) throw new Error("Not connected to MongoDB");

    // Sample up to 100 documents to infer field types (MongoDB is schemaless)
    const docs = await this.db.collection(tableName).find({}).limit(100).toArray();

    if (docs.length === 0) {
      // Return _id column at minimum even for empty collections
      return [
        {
          column_name: "_id",
          data_type: "ObjectId",
          is_nullable: "NO",
          column_default: null,
          description: null,
        },
      ];
    }

    // Collect all field names and their inferred types across sampled docs
    const fieldTypes = new Map<string, Set<string>>();

    for (const doc of docs) {
      for (const [key, value] of Object.entries(doc)) {
        if (!fieldTypes.has(key)) {
          fieldTypes.set(key, new Set());
        }
        fieldTypes.get(key)!.add(inferType(value));
      }
    }

    const columns: TableColumn[] = [];
    for (const [fieldName, types] of fieldTypes) {
      const typeList = [...types].join(" | ");
      columns.push({
        column_name: fieldName,
        data_type: typeList,
        is_nullable: fieldName === "_id" ? "NO" : "YES",
        column_default: null,
        description: null,
      });
    }

    return columns;
  }

  async getTableIndexes(tableName: string, schema?: string): Promise<TableIndex[]> {
    if (!this.db) throw new Error("Not connected to MongoDB");

    const rawIndexes = await this.db.collection(tableName).indexes();
    return rawIndexes.map((idx) => {
      const columnNames = Object.keys(idx.key ?? {});
      return {
        index_name: idx.name ?? "unknown",
        column_names: columnNames,
        is_unique: idx.unique === true,
        is_primary: idx.name === "_id_",
      };
    });
  }

  async getTableRowCount(tableName: string, schema?: string): Promise<number | null> {
    if (!this.db) throw new Error("Not connected to MongoDB");
    return this.db.collection(tableName).estimatedDocumentCount();
  }

  async getStoredProcedures(
    schema?: string,
    routineType?: "procedure" | "function"
  ): Promise<string[]> {
    return [];
  }

  async getStoredProcedureDetail(
    procedureName: string,
    schema?: string
  ): Promise<StoredProcedure> {
    throw new Error("MongoDB does not support stored procedures.");
  }

  /**
   * Execute a MongoDB command specified as a JSON object.
   *
   * The `sql` parameter must be a JSON string whose first key is a MongoDB
   * command name, e.g.:
   *   {"find": "users", "filter": {"age": {"$gt": 18}}}
   *   {"aggregate": "orders", "pipeline": [{"$match": {"status": "open"}}]}
   *
   * For `find` and `aggregate` commands, `options.maxRows` is applied as a
   * server-side limit to prevent oversized result sets.
   */
  async executeSQL(
    sql: string,
    options: ExecuteOptions,
    _parameters?: any[]
  ): Promise<SQLResult> {
    if (!this.db) throw new Error("Not connected to MongoDB");

    let cmd: Document;
    try {
      cmd = JSON.parse(sql.trim());
    } catch (err) {
      throw new Error(
        `MongoDB command must be a valid JSON object. Parse error: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (typeof cmd !== "object" || cmd === null || Array.isArray(cmd)) {
      throw new Error("MongoDB command must be a JSON object, e.g. {\"find\": \"collectionName\", \"filter\": {}}");
    }

    const commandName = Object.keys(cmd)[0]?.toLowerCase();
    const maxRows = options.maxRows;

    // Apply maxRows as a server-side limit for cursor-producing commands
    if (commandName === "find") {
      if (maxRows !== undefined) {
        cmd.limit = cmd.limit !== undefined ? Math.min(cmd.limit, maxRows) : maxRows;
      }
      const result = await this.db.command(cmd);
      const rows: Document[] = result?.cursor?.firstBatch ?? [];
      return { rows, rowCount: rows.length };
    }

    if (commandName === "aggregate") {
      if (maxRows !== undefined) {
        const pipeline: Document[] = cmd.pipeline ?? [];
        // Inject $limit only if not already present or tighter
        const existingLimit = pipeline.findIndex((s: Document) => "$limit" in s);
        if (existingLimit >= 0) {
          pipeline[existingLimit] = { $limit: Math.min(pipeline[existingLimit]["$limit"], maxRows) };
        } else {
          pipeline.push({ $limit: maxRows });
        }
        cmd.pipeline = pipeline;
      }
      const result = await this.db.command(cmd);
      const rows: Document[] = result?.cursor?.firstBatch ?? [];
      return { rows, rowCount: rows.length };
    }

    // Generic command — return raw result wrapped as a single row
    const result = await this.db.command(cmd);
    return { rows: [result], rowCount: 1 };
  }
}

const mongoDBConnector = new MongoDBConnector();
ConnectorRegistry.register(mongoDBConnector);
