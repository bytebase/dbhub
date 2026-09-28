import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgresConnector } from '../postgres/index.js';

/**
 * End-to-end coverage for PostgreSQL client certificate authentication
 * (`sslcert` / `sslkey`): the server is configured with `hostssl ... cert` in
 * pg_hba.conf, so a connection is only accepted when the client presents a
 * certificate whose CN matches the database user.
 *
 * Certificates are generated with the `openssl` CLI; the suite is skipped
 * when it is not installed.
 */

const DB_USER = 'testuser';
const DB_NAME = 'testdb';
const DB_PASSWORD = 'testpass';

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Generate a throwaway CA plus CA-signed server and client certificates. */
function generateCerts(dir: string): void {
  const openssl = (args: string[]): void => {
    execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  };
  openssl([
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=dbhub-test-ca', '-keyout', 'ca.key', '-out', 'ca.crt',
  ]);
  for (const [name, cn] of [['server', 'localhost'], ['client', DB_USER]]) {
    openssl([
      'req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${cn}`,
      '-keyout', `${name}.key`, '-out', `${name}.csr`,
    ]);
    openssl([
      'x509', '-req', '-days', '1', '-in', `${name}.csr`,
      '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.crt`,
    ]);
  }
}

// Runs as the postgres user during first-boot initialisation. PostgreSQL
// refuses a server key it cannot own with restrictive permissions, and files
// copied into the container are root-owned, so copy them into a
// postgres-owned directory first. The rewritten pg_hba.conf only admits TCP
// clients that present a valid certificate; the local socket stays open for
// the entrypoint and health check.
const INIT_SCRIPT = `#!/bin/sh
set -e
SSL_DIR=/var/lib/postgresql/ssl
mkdir -p "$SSL_DIR"
cp /certs/server.crt /certs/server.key /certs/ca.crt "$SSL_DIR/"
chmod 0600 "$SSL_DIR/server.key"
cat > "$PGDATA/pg_hba.conf" <<EOF
local all all trust
hostssl all all all cert
hostnossl all all all reject
EOF
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOF
ALTER SYSTEM SET ssl = on;
ALTER SYSTEM SET ssl_cert_file = '$SSL_DIR/server.crt';
ALTER SYSTEM SET ssl_key_file = '$SSL_DIR/server.key';
ALTER SYSTEM SET ssl_ca_file = '$SSL_DIR/ca.crt';
EOF
`;

describe.skipIf(!hasOpenssl())('PostgreSQL client certificate authentication', () => {
  let container: StartedPostgreSqlContainer;
  let certDir: string;
  let baseUri: string;

  const sslParams = (files: Record<string, string>): string =>
    Object.entries(files)
      .map(([key, file]) => `${key}=${encodeURIComponent(path.join(certDir, file))}`)
      .join('&');

  beforeAll(async () => {
    certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbhub-pg-clientcert-'));
    generateCerts(certDir);

    const readCert = (file: string): string => fs.readFileSync(path.join(certDir, file), 'utf-8');
    container = await new PostgreSqlContainer('postgres:15-alpine')
      .withDatabase(DB_NAME)
      .withUsername(DB_USER)
      .withPassword(DB_PASSWORD)
      .withCopyContentToContainer([
        { content: readCert('server.crt'), target: '/certs/server.crt', mode: 0o644 },
        { content: readCert('server.key'), target: '/certs/server.key', mode: 0o644 },
        { content: readCert('ca.crt'), target: '/certs/ca.crt', mode: 0o644 },
        { content: INIT_SCRIPT, target: '/docker-entrypoint-initdb.d/01-ssl.sh', mode: 0o755 },
      ])
      .start();
    baseUri = container.getConnectionUri();
  }, 180_000);

  afterAll(async () => {
    await container?.stop();
    if (certDir) {
      fs.rmSync(certDir, { recursive: true, force: true });
    }
  });

  it('should authenticate with sslcert/sslkey and verify the server against sslrootcert', async () => {
    const dsn = `${baseUri}?sslmode=verify-ca&${sslParams({
      sslrootcert: 'ca.crt',
      sslcert: 'client.crt',
      sslkey: 'client.key',
    })}`;
    const connector = new PostgresConnector();
    try {
      await connector.connect(dsn);
      const result = await connector.executeSQL(
        'SELECT ssl, client_dn FROM pg_stat_ssl WHERE pid = pg_backend_pid()',
        {}
      );
      expect(result.resultSets[0].rows[0].ssl).toBe(true);
      expect(String(result.resultSets[0].rows[0].client_dn)).toContain(`CN=${DB_USER}`);
    } finally {
      await connector.disconnect();
    }
  });

  it('should authenticate with sslcert/sslkey under sslmode=require without a CA', async () => {
    const dsn = `${baseUri}?sslmode=require&${sslParams({ sslcert: 'client.crt', sslkey: 'client.key' })}`;
    const connector = new PostgresConnector();
    try {
      await connector.connect(dsn);
      const result = await connector.executeSQL('SELECT current_user', {});
      expect(result.resultSets[0].rows[0].current_user).toBe(DB_USER);
    } finally {
      await connector.disconnect();
    }
  });

  it('should be rejected by the server without a client certificate', async () => {
    const connector = new PostgresConnector();
    try {
      await expect(connector.connect(`${baseUri}?sslmode=require`)).rejects.toThrow(
        /client certificate/i
      );
    } finally {
      await connector.disconnect();
    }
  });
});
