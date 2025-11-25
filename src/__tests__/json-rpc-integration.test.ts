import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('JSON RPC Integration Tests', () => {
  let serverProcess: ChildProcess | null = null;
  let testDbPath: string;
  let baseUrl: string;
  const testPort = 3001;

  beforeAll(async () => {
    // Create a temporary SQLite database file
    const tempDir = os.tmpdir();
    testDbPath = path.join(tempDir, `json_rpc_test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.db`);
    
    baseUrl = `http://localhost:${testPort}`;
    
    // Start the server as a child process
    serverProcess = spawn('pnpm', ['dev'], {
      env: {
        ...process.env,
        DSN: `sqlite://${testDbPath}`,
        TRANSPORT: 'http',
        PORT: testPort.toString(),
        NODE_ENV: 'test'
      },
      stdio: 'pipe'
    });

    // Handle server output
    serverProcess.stdout?.on('data', (data) => {
      console.log(`Server stdout: ${data}`);
    });

    serverProcess.stderr?.on('data', (data) => {
      console.error(`Server stderr: ${data}`);
    });

    // Wait for server to start up
    let serverReady = false;
    for (let i = 0; i < 20; i++) {
      try {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const response = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream'
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'health-check',
            method: 'notifications/initialized'
          })
        });
        if (response.status < 500) {
          serverReady = true;
          break;
        }
      } catch (e) {
        // Server not ready yet, continue waiting
      }
    }
    
    if (!serverReady) {
      throw new Error('Server did not start within expected time');
    }
    
    // Create test tables and data via HTTP request
    await makeJsonRpcCall('execute_sql', {
      sql: `
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          age INTEGER
        );
        
        CREATE TABLE IF NOT EXISTS orders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER REFERENCES users(id),
          total DECIMAL(10,2),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        
        INSERT INTO users (name, email, age) VALUES 
        ('John Doe', 'john@example.com', 30),
        ('Jane Smith', 'jane@example.com', 25),
        ('Bob Johnson', 'bob@example.com', 35);
        
        INSERT INTO orders (user_id, total) VALUES 
        (1, 99.99),
        (1, 149.50),
        (2, 75.25);
      `
    });
  }, 30000);

  afterAll(async () => {
    // Kill the server process if it's still running
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      
      // Wait for process to exit
      await new Promise((resolve) => {
        if (serverProcess) {
          serverProcess.on('exit', resolve);
          setTimeout(() => {
            if (serverProcess && !serverProcess.killed) {
              serverProcess.kill('SIGKILL');
            }
            resolve(void 0);
          }, 5000);
        } else {
          resolve(void 0);
        }
      });
    }
    
    // Clean up the test database file
    if (testDbPath && fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  async function makeJsonRpcCall(method: string, params: any): Promise<any> {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Math.random().toString(36).substr(2, 9),
        method: 'tools/call',
        params: {
          name: method,
          arguments: params
        }
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Server uses JSON responses in stateless mode (no SSE)
    return await response.json();
  }

  describe('execute_sql JSON RPC calls', () => {
    it('should execute a simple SELECT query successfully', async () => {
      const response = await makeJsonRpcCall('execute_sql', {
        sql: 'SELECT * FROM users WHERE age > 25 ORDER BY age'
      });
      
      expect(response).toHaveProperty('result');
      expect(response.result).toHaveProperty('content');
      expect(Array.isArray(response.result.content)).toBe(true);
      
      const content = JSON.parse(response.result.content[0].text);
      expect(content.success).toBe(true);
      expect(content.data).toHaveProperty('rows');
      expect(content.data).toHaveProperty('count');
      expect(content.data.rows).toHaveLength(2);
      expect(content.data.rows[0].name).toBe('John Doe');
      expect(content.data.rows[1].name).toBe('Bob Johnson');
    });

    it('should execute a JOIN query successfully', async () => {
      const response = await makeJsonRpcCall('execute_sql', {
        sql: `
          SELECT u.name, u.email, o.total 
          FROM users u 
          JOIN orders o ON u.id = o.user_id 
          WHERE u.age >= 30
          ORDER BY o.total DESC
        `
      });
      
      expect(response).toHaveProperty('result');
      const content = JSON.parse(response.result.content[0].text);
      expect(content.success).toBe(true);
      expect(content.data.rows).toHaveLength(2);
      expect(content.data.rows[0].total).toBe(149.50);
      expect(content.data.rows[1].total).toBe(99.99);
    });

    it('should execute aggregate queries successfully', async () => {
      const response = await makeJsonRpcCall('execute_sql', {
        sql: `
          SELECT 
            COUNT(*) as user_count,
            AVG(age) as avg_age,
            MIN(age) as min_age,
            MAX(age) as max_age
          FROM users
        `
      });
      
      expect(response).toHaveProperty('result');
      const content = JSON.parse(response.result.content[0].text);
      expect(content.success).toBe(true);
      expect(content.data.rows).toHaveLength(1);
      expect(content.data.rows[0].user_count).toBe(3);
      expect(content.data.rows[0].avg_age).toBe(30);
      expect(content.data.rows[0].min_age).toBe(25);
      expect(content.data.rows[0].max_age).toBe(35);
    });

    it('should handle multiple statements in a single call', async () => {
      const response = await makeJsonRpcCall('execute_sql', {
        sql: `
          INSERT INTO users (name, email, age) VALUES ('Test User', 'test@example.com', 28);
          SELECT COUNT(*) as total_users FROM users;
        `
      });
      
      expect(response).toHaveProperty('result');
      const content = JSON.parse(response.result.content[0].text);
      expect(content.success).toBe(true);
      expect(content.data.rows).toHaveLength(1);
      expect(content.data.rows[0].total_users).toBe(4);
    });

    it('should handle SQLite-specific functions', async () => {
      const response = await makeJsonRpcCall('execute_sql', {
        sql: `
          SELECT 
            sqlite_version() as version,
            datetime('now') as current_time,
            upper('hello world') as uppercase,
            length('test string') as str_length
        `
      });
      
      expect(response).toHaveProperty('result');
      const content = JSON.parse(response.result.content[0].text);
      expect(content.success).toBe(true);
      expect(content.data.rows).toHaveLength(1);
      expect(content.data.rows[0].version).toBeDefined();
      expect(content.data.rows[0].uppercase).toBe('HELLO WORLD');
      expect(content.data.rows[0].str_length).toBe(11);
    });

    it('should return error for invalid SQL', async () => {
      const response = await makeJsonRpcCall('execute_sql', {
        sql: 'SELECT * FROM non_existent_table'
      });
      
      expect(response).toHaveProperty('result');
      const content = JSON.parse(response.result.content[0].text);
      expect(content.success).toBe(false);
      expect(content.error).toContain('no such table');
      expect(content.code).toBe('EXECUTION_ERROR');
    });

    it('should handle empty result sets', async () => {
      const response = await makeJsonRpcCall('execute_sql', {
        sql: 'SELECT * FROM users WHERE age > 100'
      });
      
      expect(response).toHaveProperty('result');
      const content = JSON.parse(response.result.content[0].text);
      expect(content.success).toBe(true);
      expect(content.data.rows).toHaveLength(0);
      expect(content.data.count).toBe(0);
    });

    it('should work with SQLite transactions', async () => {
      const response = await makeJsonRpcCall('execute_sql', {
        sql: `
          BEGIN TRANSACTION;
          INSERT INTO users (name, email, age) VALUES ('Transaction User', 'transaction@example.com', 40);
          COMMIT;
          SELECT * FROM users WHERE email = 'transaction@example.com';
        `
      });
      
      expect(response).toHaveProperty('result');
      const content = JSON.parse(response.result.content[0].text);
      expect(content.success).toBe(true);
      expect(content.data.rows).toHaveLength(1);
      expect(content.data.rows[0].name).toBe('Transaction User');
      expect(content.data.rows[0].age).toBe(40);
    });

    it('should handle PRAGMA statements', async () => {
      const response = await makeJsonRpcCall('execute_sql', {
        sql: 'PRAGMA table_info(users)'
      });
      
      expect(response).toHaveProperty('result');
      const content = JSON.parse(response.result.content[0].text);
      expect(content.success).toBe(true);
      expect(content.data.rows.length).toBeGreaterThan(0);
      expect(content.data.rows.some((row: any) => row.name === 'id')).toBe(true);
      expect(content.data.rows.some((row: any) => row.name === 'name')).toBe(true);
    });
  });

  describe('JSON RPC protocol compliance', () => {
    it('should return proper JSON RPC response structure', async () => {
      const requestId = Math.random().toString(36).substr(2, 9);
      const response = await makeJsonRpcCall('execute_sql', {
        sql: 'SELECT 1 as test'
      });
      
      expect(response).toHaveProperty('jsonrpc', '2.0');
      expect(response).toHaveProperty('id');
      expect(response).toHaveProperty('result');
      expect(response.result).toHaveProperty('content');
    });

    it('should handle malformed requests gracefully', async () => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          // Missing required jsonrpc field
          id: 'test',
          method: 'tools/call',
          params: {
            name: 'execute_sql',
            arguments: { sql: 'SELECT 1' }
          }
        })
      });

      // The server should still respond, but with an error
      expect(response.status).toBeLessThan(500);
    });
  });
});