import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer } from 'testcontainers';
import { RedisConnector } from '../redis/index.js';
import type { Connector } from '../interface.js';

class RedisIntegrationTest {
  private container: any;
  private connector!: RedisConnector;
  private connectionUri!: string;

  async setup(): Promise<void> {
    console.log('Starting Redis container...');
    
    this.container = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .start();
    
    console.log('Container started, establishing connection...');
    
    const host = this.container.getHost();
    const port = this.container.getMappedPort(6379);
    this.connectionUri = `redis://${host}:${port}/0`;
    
    // Wait for Redis to be ready by retrying connection
    let retries = 0;
    while (retries < 30) {
      try {
        this.connector = new RedisConnector();
        await this.connector.connect(this.connectionUri);
        console.log('Connected to Redis');
        break;
      } catch (error) {
        retries++;
        if (retries < 30) {
          console.log(`Waiting for Redis... (attempt ${retries}/30)`);
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
          throw new Error(`Failed to connect to Redis after 30 attempts: ${error}`);
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
    // String operations
    await this.connector.executeCommand('SET user:1:name Alice');
    await this.connector.executeCommand('SET user:1:email alice@example.com');
    await this.connector.executeCommand('SET user:1:age 30');
    await this.connector.executeCommand('SET counter 100');

    // Hash operations
    await this.connector.executeCommand('HSET user:2 name Bob');
    await this.connector.executeCommand('HSET user:2 email bob@example.com');
    await this.connector.executeCommand('HSET user:2 age 25');

    // List operations
    await this.connector.executeCommand('RPUSH tasks task1');
    await this.connector.executeCommand('RPUSH tasks task2');
    await this.connector.executeCommand('RPUSH tasks task3');

    // Set operations
    await this.connector.executeCommand('SADD tags python');
    await this.connector.executeCommand('SADD tags javascript');
    await this.connector.executeCommand('SADD tags typescript');

    // Sorted Set operations
    await this.connector.executeCommand('ZADD leaderboard 100 player1');
    await this.connector.executeCommand('ZADD leaderboard 150 player2');
    await this.connector.executeCommand('ZADD leaderboard 200 player3');
  }

  runTests(): void {
    describe('Redis Connector Integration Tests', () => {
      beforeAll(async () => {
        await this.setup();
      }, 120000);

      afterAll(async () => {
        await this.cleanup();
      });

      describe('Connection', () => {
        it('should connect successfully to Redis container', async () => {
          expect(this.connector).toBeDefined();
          expect(this.connectionUri).toContain('redis://');
        });

        it('should parse DSN correctly', async () => {
          const sampleDSN = this.connector.dsnParser.getSampleDSN();
          expect(sampleDSN).toContain('redis://');
          expect(this.connector.dsnParser.isValidDSN(sampleDSN)).toBe(true);
        });

        it('should validate DSN format', () => {
          const sampleDSN = this.connector.dsnParser.getSampleDSN();
          expect(this.connector.dsnParser.isValidDSN(sampleDSN)).toBe(true);
          expect(this.connector.dsnParser.isValidDSN('invalid-dsn')).toBe(false);
          expect(this.connector.dsnParser.isValidDSN('http://localhost:6379')).toBe(false);
        });

        it('should accept both redis:// and rediss:// protocols', () => {
          expect(this.connector.dsnParser.isValidDSN('redis://localhost:6379')).toBe(true);
          expect(this.connector.dsnParser.isValidDSN('rediss://localhost:6379')).toBe(true);
        });
      });

      describe('String Operations', () => {
        it('should GET a string value', async () => {
          const result = await this.connector.executeCommand('GET user:1:name');
          expect(result).toBeDefined();
          expect(result.value).toBe('Alice');
          expect(result.type).toBe('string');
        });

        it('should SET a string value', async () => {
          const result = await this.connector.executeCommand('SET test_key test_value');
          expect(result.value).toBe('OK');
          expect(result.type).toBe('string');

          // Verify it was set
          const getResult = await this.connector.executeCommand('GET test_key');
          expect(getResult.value).toBe('test_value');
        });

        it('should handle non-existent keys', async () => {
          const result = await this.connector.executeCommand('GET nonexistent_key');
          expect(result.type).toBe('nil');
          expect(result.value).toBeNull();
        });

        it('should APPEND to a string value', async () => {
          await this.connector.executeCommand('SET mystring hello');
          const result = await this.connector.executeCommand('APPEND mystring world');
          expect(result.type).toBe('string');
          expect(result.value).toBe(10); // "helloworld" is 10 chars

          const getValue = await this.connector.executeCommand('GET mystring');
          expect(getValue.value).toBe('helloworld');
        });

        it('should get string length with STRLEN', async () => {
          const result = await this.connector.executeCommand('STRLEN user:1:name');
          expect(result.type).toBe('string');
          expect(result.value).toBe(5); // "Alice" is 5 chars
        });

        it('should INCR a numeric value', async () => {
          const result = await this.connector.executeCommand('INCR counter');
          expect(result.type).toBe('string');
          expect(result.value).toBe(101);

          const verify = await this.connector.executeCommand('GET counter');
          expect(verify.value).toBe('101');
        });

        it('should DECR a numeric value', async () => {
          const result = await this.connector.executeCommand('DECR counter');
          expect(result.type).toBe('string');
          expect(result.value).toBe(100);
        });
      });

      describe('Hash Operations', () => {
        it('should HSET a hash field', async () => {
          const result = await this.connector.executeCommand('HSET user:3 name Charlie');
          expect(result.type).toBe('hash');
        });

        it('should HGET a hash field', async () => {
          const result = await this.connector.executeCommand('HGET user:2 name');
          expect(result.type).toBe('hash');
          expect(result.value).toBe('Bob');
        });

        it('should HGETALL hash fields', async () => {
          const result = await this.connector.executeCommand('HGETALL user:2');
          expect(result.type).toBe('hash');
          expect(result.value).toBeDefined();
          expect(typeof result.value).toBe('object');
          expect(result.value.name).toBe('Bob');
          expect(result.value.email).toBe('bob@example.com');
          expect(result.value.age).toBe('25');
        });

        it('should HKEYS a hash', async () => {
          const result = await this.connector.executeCommand('HKEYS user:2');
          expect(result.type).toBe('hash');
          expect(Array.isArray(result.value)).toBe(true);
          expect(result.value).toContain('name');
          expect(result.value).toContain('email');
          expect(result.value).toContain('age');
        });

        it('should HVALS a hash', async () => {
          const result = await this.connector.executeCommand('HVALS user:2');
          expect(result.type).toBe('hash');
          expect(Array.isArray(result.value)).toBe(true);
          expect(result.value).toContain('Bob');
          expect(result.value).toContain('bob@example.com');
          expect(result.value).toContain('25');
        });

        it('should HLEN a hash', async () => {
          const result = await this.connector.executeCommand('HLEN user:2');
          expect(result.type).toBe('hash');
          expect(result.value).toBeGreaterThanOrEqual(3);
        });

        it('should HEXISTS check if field exists', async () => {
          const result = await this.connector.executeCommand('HEXISTS user:2 name');
          expect(result.type).toBe('hash');
          expect(result.value).toBe(true);

          const notExists = await this.connector.executeCommand('HEXISTS user:2 nonexistent');
          expect(notExists.value).toBe(false);
        });

        it('should HDEL remove hash fields', async () => {
          await this.connector.executeCommand('HSET user:4 field1 value1');
          const result = await this.connector.executeCommand('HDEL user:4 field1');
          expect(result.type).toBe('hash');
          expect(result.value).toBe(1);
        });
      });

      describe('List Operations', () => {
        it('should LPUSH to a list', async () => {
          const result = await this.connector.executeCommand('LPUSH mylist first');
          expect(result.type).toBe('list');
          expect(result.value).toBeGreaterThan(0);
        });

        it('should RPUSH to a list', async () => {
          const result = await this.connector.executeCommand('RPUSH anotherlist item');
          expect(result.type).toBe('list');
          expect(result.value).toBeGreaterThan(0);
        });

        it('should LRANGE get list range', async () => {
          const result = await this.connector.executeCommand('LRANGE tasks 0 -1');
          expect(result.type).toBe('list');
          expect(Array.isArray(result.value)).toBe(true);
          expect(result.value).toContain('task1');
          expect(result.value).toContain('task2');
          expect(result.value).toContain('task3');
        });

        it('should LLEN get list length', async () => {
          const result = await this.connector.executeCommand('LLEN tasks');
          expect(result.type).toBe('list');
          expect(result.value).toBe(3);
        });

        it('should LINDEX get list element by index', async () => {
          const result = await this.connector.executeCommand('LINDEX tasks 0');
          expect(result.type).toBe('list');
          expect(result.value).toBe('task1');
        });

        it('should LPOP pop from left', async () => {
          await this.connector.executeCommand('LPUSH poplist a');
          const result = await this.connector.executeCommand('LPOP poplist');
          expect(result.type).toBe('list');
          expect(result.value).toBe('a');
        });

        it('should RPOP pop from right', async () => {
          await this.connector.executeCommand('RPUSH poplist2 x');
          const result = await this.connector.executeCommand('RPOP poplist2');
          expect(result.type).toBe('list');
          expect(result.value).toBe('x');
        });
      });

      describe('Set Operations', () => {
        it('should SADD members to set', async () => {
          const result = await this.connector.executeCommand('SADD colors red');
          expect(result.type).toBe('set');
        });

        it('should SMEMBERS get all set members', async () => {
          const result = await this.connector.executeCommand('SMEMBERS tags');
          expect(result.type).toBe('set');
          expect(Array.isArray(result.value)).toBe(true);
          expect(result.value).toContain('python');
          expect(result.value).toContain('javascript');
          expect(result.value).toContain('typescript');
        });

        it('should SCARD get set cardinality', async () => {
          const result = await this.connector.executeCommand('SCARD tags');
          expect(result.type).toBe('set');
          expect(result.value).toBe(3);
        });

        it('should SISMEMBER check membership', async () => {
          const result = await this.connector.executeCommand('SISMEMBER tags python');
          expect(result.type).toBe('set');
          expect(result.value).toBe(true);

          const notMember = await this.connector.executeCommand('SISMEMBER tags rust');
          expect(notMember.value).toBe(false);
        });

        it('should SREM remove members', async () => {
          await this.connector.executeCommand('SADD tempset member1');
          const result = await this.connector.executeCommand('SREM tempset member1');
          expect(result.type).toBe('set');
          expect(result.value).toBe(1);
        });
      });

      describe('Sorted Set Operations', () => {
        it('should ZADD members to sorted set', async () => {
          const result = await this.connector.executeCommand('ZADD scores 500 alice');
          expect(result.type).toBe('zset');
        });

        it('should ZRANGE get sorted set range', async () => {
          const result = await this.connector.executeCommand('ZRANGE leaderboard 0 -1');
          expect(result.type).toBe('zset');
          expect(Array.isArray(result.value)).toBe(true);
          expect(result.value).toContain('player1');
          expect(result.value).toContain('player2');
          expect(result.value).toContain('player3');
        });

        it('should ZCARD get sorted set cardinality', async () => {
          const result = await this.connector.executeCommand('ZCARD leaderboard');
          expect(result.type).toBe('zset');
          expect(result.value).toBe(3);
        });

        it('should ZSCORE get member score', async () => {
          const result = await this.connector.executeCommand('ZSCORE leaderboard player1');
          expect(result.type).toBe('zset');
          expect(result.value).toBe(100);
        });

        it('should ZREM remove members', async () => {
          await this.connector.executeCommand('ZADD tempzset 1 member');
          const result = await this.connector.executeCommand('ZREM tempzset member');
          expect(result.type).toBe('zset');
          expect(result.value).toBe(1);
        });
      });

      describe('Generic Commands', () => {
        it('should DEL delete keys', async () => {
          await this.connector.executeCommand('SET delkey value');
          const result = await this.connector.executeCommand('DEL delkey');
          expect(result.type).toBe('string');
          expect(result.value).toBe(1);
        });

        it('should EXISTS check key existence', async () => {
          const result = await this.connector.executeCommand('EXISTS user:1:name');
          expect(result.type).toBe('string');
          expect(result.value).toBeGreaterThan(0);

          const notExists = await this.connector.executeCommand('EXISTS nonexistent');
          expect(notExists.value).toBe(0);
        });

        it('should TYPE get key type', async () => {
          const stringResult = await this.connector.executeCommand('TYPE user:1:name');
          expect(stringResult.type).toBe('string');
          expect(stringResult.value).toBe('string');

          const hashResult = await this.connector.executeCommand('TYPE user:2');
          expect(hashResult.value).toBe('hash');

          const listResult = await this.connector.executeCommand('TYPE tasks');
          expect(listResult.value).toBe('list');

          const setResult = await this.connector.executeCommand('TYPE tags');
          expect(setResult.value).toBe('set');

          const zsetResult = await this.connector.executeCommand('TYPE leaderboard');
          expect(zsetResult.value).toBe('zset');
        });

        it('should KEYS pattern match', async () => {
          const result = await this.connector.executeCommand('KEYS user:*');
          expect(result.type).toBe('string');
          expect(Array.isArray(result.value)).toBe(true);
          expect(result.value.length).toBeGreaterThan(0);
        });

        it('should respect maxRows limit for KEYS', async () => {
          const result = await this.connector.executeCommand('KEYS *', { maxRows: 2 });
          expect(result.type).toBe('string');
          expect(Array.isArray(result.value)).toBe(true);
          expect(result.value.length).toBeLessThanOrEqual(2);
        });

        it('should SCAN iterate keys', async () => {
          const result = await this.connector.executeCommand('SCAN 0');
          expect(result.type).toBe('string');
          expect(result.value).toBeDefined();
          expect(result.value.cursor).toBeDefined();
          expect(Array.isArray(result.value.keys)).toBe(true);
        });

        it('should DBSIZE get database size', async () => {
          const result = await this.connector.executeCommand('DBSIZE');
          expect(result.type).toBe('string');
          expect(Number(result.value)).toBeGreaterThan(0);
        });

        it('should TTL get time to live', async () => {
          await this.connector.executeCommand('SET ttlkey value');
          const result = await this.connector.executeCommand('TTL ttlkey');
          expect(result.type).toBe('string');
          expect(result.value).toBe(-1); // No expiration
        });

        it('should EXPIRE set expiration', async () => {
          await this.connector.executeCommand('SET expirekey value');
          const result = await this.connector.executeCommand('EXPIRE expirekey 60');
          expect(result.type).toBe('string');
          expect(result.value).toBe(1);
        });

        it('should INFO get server information', async () => {
          const result = await this.connector.executeCommand('INFO');
          expect(result.type).toBe('string');
          expect(typeof result.value).toBe('string');
          expect(result.value.length).toBeGreaterThan(0);
        });
      });

      describe('Error Handling', () => {
        it('should throw error for unknown command', async () => {
          await expect(
            this.connector.executeCommand('UNKNOWNCMD param')
          ).rejects.toThrow();
        });

        it('should throw error when not connected', async () => {
          const disconnected = new RedisConnector();
          await expect(
            disconnected.executeCommand('PING')
          ).rejects.toThrow();
        });

        it('should throw error when using executeSQL instead of executeCommand', async () => {
          await expect(
            this.connector.executeSQL('SELECT * FROM keys', {})
          ).rejects.toThrow('does not support SQL');
        });
      });

      describe('DSN Parser', () => {
        it('should parse Redis DSN with defaults', () => {
          const dsn = 'redis://localhost:6379/0';
          const parsed = this.connector.dsnParser.parse(dsn);
          
          expect(parsed.host).toBe('localhost');
          expect(parsed.port).toBe(6379);
          expect(parsed.db).toBe(0);
        });

        it('should parse Redis DSN with different database', () => {
          const dsn = 'redis://localhost:6379/5';
          const parsed = this.connector.dsnParser.parse(dsn);
          
          expect(parsed.db).toBe(5);
        });

        it('should parse Redis DSN with credentials', () => {
          const dsn = 'redis://user:password@localhost:6379/0';
          const parsed = this.connector.dsnParser.parse(dsn);
          
          expect(parsed.username).toBe('user');
          expect(parsed.password).toBe('password');
        });

        it('should parse rediss:// (TLS) protocol', () => {
          const dsn = 'rediss://localhost:6380/0';
          const parsed = this.connector.dsnParser.parse(dsn);
          
          expect(parsed.tls).toBe(true);
        });

        it('should reject invalid protocol', () => {
          expect(() => {
            this.connector.dsnParser.parse('http://localhost:6379');
          }).toThrow();
        });
      });

      describe('Connector Methods', () => {
        it('should return empty array for getSchemas()', async () => {
          const schemas = await this.connector.getSchemas();
          expect(Array.isArray(schemas)).toBe(true);
          expect(schemas.length).toBe(0);
        });

        it('should return empty array for getTables()', async () => {
          const tables = await this.connector.getTables();
          expect(Array.isArray(tables)).toBe(true);
        });

        it('should return empty array for getTableSchema()', async () => {
          const schema = await this.connector.getTableSchema('anykey');
          expect(Array.isArray(schema)).toBe(true);
          expect(schema.length).toBe(0);
        });

        it('should return false for tableExists()', async () => {
          const exists = await this.connector.tableExists('anykey');
          expect(exists).toBe(false);
        });

        it('should return empty array for getTableIndexes()', async () => {
          const indexes = await this.connector.getTableIndexes('anykey');
          expect(Array.isArray(indexes)).toBe(true);
        });

        it('should return empty array for getStoredProcedures()', async () => {
          const procs = await this.connector.getStoredProcedures();
          expect(Array.isArray(procs)).toBe(true);
          expect(procs.length).toBe(0);
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
          expect(clone).toBeInstanceOf(RedisConnector);
          expect(clone).not.toBe(this.connector);
        });
      });
    });
  }
}

// Run the tests
const test = new RedisIntegrationTest();
test.runTests();
