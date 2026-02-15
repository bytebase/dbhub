import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer } from 'testcontainers';
import { ElasticsearchConnector } from '../elasticsearch/index.js';
import type { Connector } from '../interface.js';

class ElasticsearchIntegrationTest {
  private container: any;
  private connector!: ElasticsearchConnector;
  private connectionUri!: string;

  async setup(): Promise<void> {
    console.log('Starting Elasticsearch container...');
    
    this.container = await new GenericContainer('docker.elastic.co/elasticsearch/elasticsearch:8.11.3')
      .withEnvironment('discovery.type', 'single-node')
      .withEnvironment('xpack.security.enabled', 'false')
      .withExposedPorts(9200)
      .start();
    
    console.log('Container started, establishing connection...');
    
    const host = this.container.getHost();
    const port = this.container.getMappedPort(9200);
    this.connectionUri = `elasticsearch://${host}:${port}?index_pattern=test-*`;
    
    // Wait for ES to be ready by retrying connection
    let retries = 0;
    while (retries < 30) {
      try {
        this.connector = new ElasticsearchConnector();
        await this.connector.connect(this.connectionUri);
        console.log('Connected to Elasticsearch');
        break;
      } catch (error) {
        retries++;
        if (retries < 30) {
          console.log(`Waiting for Elasticsearch... (attempt ${retries}/30)`);
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
          throw new Error(`Failed to connect to Elasticsearch after 30 attempts: ${error}`);
        }
      }
    }
    
    await this.setupTestData();
    console.log('Test data setup complete');
  }

  async cleanup(): Promise<void> {
    if (this.connector) {
      await this.connector.disconnect();
    }
    if (this.container) {
      await this.container.stop();
    }
  }

  private async setupTestData(): Promise<void> {
    // Create a test index with documents
    const testIndex = 'test-logs';
    
    try {
      // Index some test documents
      const documents = [
        { timestamp: '2024-01-01', level: 'error', message: 'Database connection failed', service: 'api' },
        { timestamp: '2024-01-02', level: 'warn', message: 'High memory usage detected', service: 'worker' },
        { timestamp: '2024-01-03', level: 'info', message: 'User logged in successfully', service: 'auth' },
        { timestamp: '2024-01-04', level: 'error', message: 'Timeout exceeded', service: 'api' },
        { timestamp: '2024-01-05', level: 'debug', message: 'Cache hit rate: 95%', service: 'cache' },
      ];

      for (const doc of documents) {
        await this.connector.executeCommand(
          JSON.stringify({
            index: testIndex,
            body: doc
          })
        );
      }

      // Give ES time to index documents
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.error('Failed to setup test data:', error);
      throw error;
    }
  }

  runTests(): void {
    describe('Elasticsearch Connector Integration Tests', () => {
      beforeAll(async () => {
        await this.setup();
      }, 300000);

      afterAll(async () => {
        await this.cleanup();
      });

      describe('Connection', () => {
        it('should connect successfully to Elasticsearch container', async () => {
          expect(this.connector).toBeDefined();
          expect(this.connectionUri).toContain('elasticsearch://');
        });

        it('should parse DSN correctly', async () => {
          const sampleDSN = this.connector.dsnParser.getSampleDSN();
          expect(sampleDSN).toContain('elasticsearch://');
          expect(this.connector.dsnParser.isValidDSN(sampleDSN)).toBe(true);
        });

        it('should validate DSN format', () => {
          const sampleDSN = this.connector.dsnParser.getSampleDSN();
          expect(this.connector.dsnParser.isValidDSN(sampleDSN)).toBe(true);
          expect(this.connector.dsnParser.isValidDSN('invalid-dsn')).toBe(false);
          expect(this.connector.dsnParser.isValidDSN('http://localhost:9200')).toBe(false);
        });
      });

      describe('Index Operations', () => {
        it('should list indexes/schemas', async () => {
          const schemas = await this.connector.getSchemas();
          expect(schemas).toBeDefined();
          expect(Array.isArray(schemas)).toBe(true);
        });

        it('should get tables (indexes)', async () => {
          const tables = await this.connector.getTables();
          expect(tables).toBeDefined();
          expect(Array.isArray(tables)).toBe(true);
        });

        it('should check if index exists', async () => {
          const exists = await this.connector.tableExists('test-logs');
          expect(typeof exists).toBe('boolean');
        });

        it('should get index mapping (schema)', async () => {
          const schema = await this.connector.getTableSchema('test-logs');
          expect(schema).toBeDefined();
          expect(Array.isArray(schema)).toBe(true);
          
          // Verify properties returned
          const propertyNames = schema.map((col: any) => col.column_name);
          expect(propertyNames).toContain('level');
          expect(propertyNames).toContain('message');
          expect(propertyNames).toContain('service');
        });
      });

      describe('Query Execution', () => {
        it('should execute a match_all query', async () => {
          const result = await this.connector.executeCommand(
            JSON.stringify({
              index: 'test-logs',
              query: { match_all: {} },
              size: 10
            })
          );

          expect(result).toBeDefined();
          expect(result.hits).toBeDefined();
          expect(result.hits.documents).toBeDefined();
          expect(result.hits.documents.length).toBeGreaterThan(0);
        });

        it('should execute a term query', async () => {
          const result = await this.connector.executeCommand(
            JSON.stringify({
              index: 'test-logs',
              query: { term: { level: 'error' } },
              size: 10
            })
          );

          expect(result).toBeDefined();
          expect(result.hits).toBeDefined();
          expect(result.hits.documents).toBeDefined();
          expect(result.hits.documents.length).toBeGreaterThan(0);
          expect(result.hits.documents.every((doc: any) => doc.level === 'error')).toBe(true);
        });

        it('should execute a multi_match query', async () => {
          const result = await this.connector.executeCommand(
            JSON.stringify({
              index: 'test-logs',
              query: { 
                multi_match: {
                  query: 'error',
                  fields: ['message', 'level']
                }
              },
              size: 10
            })
          );

          expect(result).toBeDefined();
          expect(result.hits).toBeDefined();
          expect(result.hits.documents).toBeDefined();
          expect(result.hits.documents.length).toBeGreaterThan(0);
        });

        it('should execute aggregation query', async () => {
          const result = await this.connector.executeCommand(
            JSON.stringify({
              index: 'test-logs',
              aggs: {
                level_counts: {
                  terms: { field: 'level' }
                }
              },
              size: 0
            })
          );

          expect(result).toBeDefined();
          expect(result.aggregations).toBeDefined();
          expect(result.aggregations.level_counts).toBeDefined();
        });

        it('should respect maxRows limit', async () => {
          const result = await this.connector.executeCommand(
            JSON.stringify({
              index: 'test-logs',
              query: { match_all: {} }
            }),
            { maxRows: 2 }
          );

          expect(result).toBeDefined();
          expect(result.hits.documents).toBeDefined();
          expect(result.hits.documents.length).toBeLessThanOrEqual(2);
        });

        it('should search using simple search method', async () => {
          const result = await this.connector.searchSimple('error', 'test-logs');

          expect(result).toBeDefined();
          expect(result.hits).toBeDefined();
          expect(result.hits.documents).toBeDefined();
          expect(result.hits.documents.length).toBeGreaterThan(0);
        });
      });

      describe('Error Handling', () => {
        it('should throw error for invalid query JSON', async () => {
          await expect(
            this.connector.executeCommand('{ invalid json }')
          ).rejects.toThrow();
        });

        it('should throw error for non-existent index', async () => {
          await expect(
            this.connector.executeCommand(
              JSON.stringify({
                index: 'non-existent-index',
                query: { match_all: {} }
              })
            )
          ).rejects.toThrow();
        });

        it('should throw error when not connected', async () => {
          const disconnectedConnector = new ElasticsearchConnector();
          
          await expect(
            disconnectedConnector.executeCommand(
              JSON.stringify({ query: { match_all: {} } })
            )
          ).rejects.toThrow('Elasticsearch not connected');
        });

        it('should throw error when using executeSQL instead of executeCommand', async () => {
          await expect(
            this.connector.executeSQL('SELECT * FROM test-logs', {})
          ).rejects.toThrow('does not support SQL');
        });
      });

      describe('DSN Parser', () => {
        it('should parse Elasticsearch DSN with default port', () => {
          const dsn = 'elasticsearch://localhost:9200';
          const parsed = this.connector.dsnParser.parse(dsn);
          
          expect(parsed.host).toBe('localhost');
          expect(parsed.port).toBe(9200);
        });

        it('should parse Elasticsearch DSN with username and password', () => {
          const dsn = 'elasticsearch://user:password@localhost:9200';
          const parsed = this.connector.dsnParser.parse(dsn);
          
          expect(parsed.host).toBe('localhost');
          expect(parsed.port).toBe(9200);
          expect(parsed.username).toBe('user');
          expect(parsed.password).toBe('password');
        });

        it('should parse Elasticsearch DSN with custom port', () => {
          const dsn = 'elasticsearch://localhost:9300';
          const parsed = this.connector.dsnParser.parse(dsn);
          
          expect(parsed.port).toBe(9300);
        });

        it('should parse index pattern from DSN', () => {
          const dsn = 'elasticsearch://localhost:9200?index_pattern=custom-*';
          const parsed = this.connector.dsnParser.parse(dsn);
          
          expect(parsed.indexPattern).toBe('custom-*');
        });

        it('should reject invalid protocol', () => {
          expect(() => {
            this.connector.dsnParser.parse('http://localhost:9200');
          }).toThrow();
        });
      });

      describe('Connector Methods', () => {
        it('should return empty array for getStoredProcedures()', async () => {
          const procs = await this.connector.getStoredProcedures();
          expect(Array.isArray(procs)).toBe(true);
          expect(procs.length).toBe(0);
        });

        it('should return empty array for getTableIndexes()', async () => {
          const indexes = await this.connector.getTableIndexes('test-logs');
          expect(Array.isArray(indexes)).toBe(true);
        });

        it('should return null for getStoredProcedureDetail()', async () => {
          const detail = await this.connector.getStoredProcedureDetail();
          expect(detail).toBeNull();
        });

        it('should get connector id', () => {
          expect(this.connector.getId()).toBe('default');
        });

        it('should clone connector', () => {
          const clone = this.connector.clone();
          expect(clone).toBeInstanceOf(ElasticsearchConnector);
          expect(clone).not.toBe(this.connector);
        });
      });
    });
  }
}

// Run the tests
const test = new ElasticsearchIntegrationTest();
test.runTests();
