import { Client } from "@elastic/elasticsearch";
import { Connector, ConnectorConfig, DSNParser, ExecuteOptions, ESSearchResult, ConnectorRegistry } from "../interface.js";

/**
 * Elasticsearch DSN Parser
 * Format: elasticsearch://[username:password@][host][:port][?index_pattern=pattern]
 * Examples:
 *   elasticsearch://localhost:9200
 *   elasticsearch://user:password@localhost:9200?index_pattern=logs-*
 *   elasticsearch://elasticsearch.example.com:9200
 */
export class ElasticsearchDSNParser implements DSNParser {
  parse(dsn: string): any {
    try {
      const url = new URL(dsn);
      if (url.protocol !== "elasticsearch:") {
        throw new Error("Invalid Elasticsearch DSN protocol");
      }

      const host = url.hostname || "localhost";
      const port = url.port ? parseInt(url.port, 10) : 9200;
      const username = url.username || undefined;
      const password = url.password || undefined;
      const indexPattern = url.searchParams.get("index_pattern") || "*";

      return {
        host,
        port,
        username,
        password,
        indexPattern,
        tls: url.protocol === "elasticsearch:" && url.hostname?.includes("cloud"),
      };
    } catch (error) {
      throw new Error(`Failed to parse Elasticsearch DSN: ${error}`);
    }
  }

  getSampleDSN(): string {
    return "elasticsearch://localhost:9200?index_pattern=logs-*";
  }

  isValidDSN(dsn: string): boolean {
    try {
      const url = new URL(dsn);
      return url.protocol === "elasticsearch:";
    } catch {
      return false;
    }
  }
}

/**
 * Elasticsearch Connector Implementation
 * Supports search queries, aggregations, and index management
 */
export class ElasticsearchConnector implements Connector {
  id = "elasticsearch" as const;
  name = "Elasticsearch";
  dsnParser = new ElasticsearchDSNParser();
  private client: Client | null = null;
  private sourceId: string = "default";
  private indexPattern: string = "*";

  getId(): string {
    return this.sourceId;
  }

  clone(): Connector {
    return new ElasticsearchConnector();
  }

  async connect(dsn: string, _initScript?: string, config?: ConnectorConfig): Promise<void> {
    try {
      const options = this.dsnParser.parse(dsn);
      this.indexPattern = options.indexPattern;

      this.client = new Client({
        node: `http://${options.host}:${options.port}`,
        ...(options.username && {
          auth: {
            username: options.username,
            password: options.password || "",
          },
        }),
        requestTimeout: (config?.queryTimeoutSeconds || 30) * 1000,
      });

      // Test connection
      const health = await this.client.cluster.health();
      console.error(
        `Connected to Elasticsearch (status: ${health.status}, cluster: ${health.cluster_name})`
      );
    } catch (error) {
      throw new Error(`Failed to connect to Elasticsearch: ${error}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }

  // SQL-like methods return metadata for Elasticsearch
  async getSchemas(): Promise<string[]> {
    if (!this.client) throw new Error("Elasticsearch not connected");
    // Return index patterns as "schemas"
    const indices = await this.client.indices.get({ index: this.indexPattern });
    return Object.keys(indices).slice(0, 100);
  }

  async getTables(): Promise<string[]> {
    // In Elasticsearch context, indexes are tables
    return this.getSchemas();
  }

  async getTableSchema(indexName: string): Promise<any[]> {
    if (!this.client) throw new Error("Elasticsearch not connected");

    try {
      const mapping = await this.client.indices.getMapping({ index: indexName });
      const properties = mapping[indexName]?.mappings?.properties || {};

      return Object.entries(properties).map(([name, prop]: [string, any]) => ({
        column_name: name,
        data_type: prop.type || "text",
        is_nullable: "yes",
        column_default: null,
      }));
    } catch (error) {
      throw new Error(`Failed to get mapping for index ${indexName}: ${error}`);
    }
  }

  async tableExists(indexName: string): Promise<boolean> {
    if (!this.client) throw new Error("Elasticsearch not connected");
    return this.client.indices.exists({ index: indexName });
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
    throw new Error(
      "Elasticsearch does not support SQL. Use executeCommand instead (JSON query DSL)."
    );
  }

  /**
   * Execute an Elasticsearch query or aggregation
   * Pass a JSON query DSL object or a simplified query string
   *
   * Examples:
   *   {"index": "logs", "query": {"match_all": {}}}
   *   {"index": "logs", "query": {"term": {"status": "error"}}, "size": 10}
   *   {"index": "logs", "aggs": {"status_counts": {"terms": {"field": "status"}}}}
   */
  async executeCommand(query: string, options?: ExecuteOptions): Promise<ESSearchResult> {
    if (!this.client) throw new Error("Elasticsearch not connected");

    try {
      let parsedQuery: any;

      // Try to parse as JSON first
      try {
        parsedQuery = JSON.parse(query);
      } catch {
        // If not JSON, try to parse as simplified syntax
        parsedQuery = this.parseSimplifiedQuery(query);
      }

      const index = parsedQuery.index || this.indexPattern;
      const esQuery = {
        index,
        body: {
          query: parsedQuery.query || { match_all: {} },
          aggs: parsedQuery.aggs,
          size: options?.maxRows || parsedQuery.size || 10,
          track_total_hits: true,
        },
      };

      // Remove undefined fields
      if (!esQuery.body.aggs) delete esQuery.body.aggs;

      const response = await this.client.search(esQuery as any);

      return {
        hits: {
          total: typeof response.hits.total === "number" 
            ? response.hits.total 
            : response.hits.total?.value || 0,
          documents: response.hits.hits.map((hit) => ({
            _id: hit._id,
            _score: hit._score,
            ...hit._source,
          })),
        },
        aggregations: response.aggregations,
      };
    } catch (error) {
      throw new Error(`Elasticsearch query failed: ${error}`);
    }
  }

  /**
   * Parse simplified query syntax
   * Examples:
   *   index:logs status:error
   *   index:logs agg:status_counts field:status
   */
  private parseSimplifiedQuery(query: string): any {
    const parts = query.split(/\s+/);
    const parsed: any = {};

    for (const part of parts) {
      if (part.includes(":")) {
        const [key, value] = part.split(":", 2);
        if (key === "index") {
          parsed.index = value;
        } else if (key === "agg") {
          parsed.aggs = {
            aggregation: {
              terms: { field: value },
            },
          };
        } else if (key === "field") {
          if (!parsed.query) {
            parsed.query = { match_all: {} };
          }
        } else {
          // Assume it's a term filter
          if (!parsed.query) {
            parsed.query = { bool: { must: [] } };
          } else if (!parsed.query.bool) {
            parsed.query = { bool: { must: [parsed.query] } };
          }
          parsed.query.bool.must.push({
            term: { [key]: value },
          });
        }
      }
    }

    return parsed;
  }

  /**
   * Search across indices with a simple text query
   */
  async searchSimple(
    text: string,
    indexPattern: string = this.indexPattern,
    options?: ExecuteOptions
  ): Promise<ESSearchResult> {
    if (!this.client) throw new Error("Elasticsearch not connected");

    const response = await this.client.search({
      index: indexPattern,
      body: {
        query: {
          multi_match: {
            query: text,
            fields: ["*"],
          },
        },
        size: options?.maxRows || 10,
        track_total_hits: true,
      },
    } as any);

    return {
      hits: {
        total: typeof response.hits.total === "number" 
          ? response.hits.total 
          : response.hits.total?.value || 0,
        documents: response.hits.hits.map((hit) => ({
          _id: hit._id,
          _score: hit._score,
          ...hit._source,
        })),
      },
    };
  }

  setSourceId(sourceId: string): void {
    this.sourceId = sourceId;
  }
}

export function createElasticsearchConnector(): Connector {
  return new ElasticsearchConnector();
}

// Register the Elasticsearch connector
const elasticsearchConnector = createElasticsearchConnector();
ConnectorRegistry.register(elasticsearchConnector);
