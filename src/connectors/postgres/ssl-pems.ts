import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { FailedToReadCertificate } from "./failed-to-read-certificate.js";

/**
 * PEM handling behind the PostgreSQL `sslrootcert` / `sslcert` / `sslkey` DSN
 * parameters: reading the files (once at parse time, and again on every new
 * pool connection so a rotated certificate is picked up without a restart),
 * rejecting encrypted client keys, and the pg.Client subclass that does the
 * per-connection reload.
 */

/** SSL modes in which a client certificate is presented to the server. */
export const CLIENT_CERT_SSL_MODES = ["require", "verify-ca", "verify-full"];

/** SSL modes the DSN parser maps to a node-postgres `ssl` setting. */
export const SUPPORTED_SSL_MODES = ["disable", ...CLIENT_CERT_SSL_MODES];

export const SSL_ROOT_CERT_LABEL = "SSL root certificate";
export const SSL_CLIENT_CERT_LABEL = "SSL client certificate";
export const SSL_CLIENT_KEY_LABEL = "SSL client key";

/** Paths of the PEM files behind a pool's `ssl` setting. */
export interface PemPaths {
  sslrootcert?: string;
  sslcert?: string;
  sslkey?: string;
}

/** PEM contents keyed by the node-postgres `ssl` property they populate. */
export interface PemContents {
  ca?: string;
  cert?: string;
  key?: string;
}

/** Expand a leading `~/` in a PEM path referenced by an SSL DSN parameter. */
function resolvePemPath(filePath: string): string {
  return filePath.startsWith("~/") ? path.join(os.homedir(), filePath.slice(2)) : filePath;
}

function failedToRead(label: string, resolved: string, err: unknown): FailedToReadCertificate {
  return new FailedToReadCertificate(
    `Failed to read ${label} at '${resolved}': ${err instanceof Error ? err.message : String(err)}`
  );
}

/**
 * Read a PEM file referenced by an SSL DSN parameter, expanding a leading `~/`.
 * Wraps any read failure in FailedToReadCertificate so callers can tell a
 * misconfigured cert path apart from a malformed DSN.
 */
export async function readPemFile(filePath: string, label: string): Promise<string> {
  const resolved = resolvePemPath(filePath);
  try {
    return await fs.promises.readFile(resolved, "utf-8");
  } catch (err) {
    throw failedToRead(label, resolved, err);
  }
}

/** Synchronous variant of readPemFile for the per-connection reload. */
function readPemFileSync(filePath: string, label: string): string {
  const resolved = resolvePemPath(filePath);
  try {
    return fs.readFileSync(resolved, "utf-8");
  } catch (err) {
    throw failedToRead(label, resolved, err);
  }
}

/**
 * Node's TLS layer needs a passphrase to open an encrypted PEM key and fails
 * with an opaque decoder error otherwise. Detect the common PEM markers and
 * fail with a clear message instead (sslpassword is not supported yet).
 */
export function isEncryptedPemKey(pem: string): boolean {
  return pem.includes("ENCRYPTED PRIVATE KEY") || pem.includes("Proc-Type: 4,ENCRYPTED");
}

export function encryptedKeyMessage(keyPath: string): string {
  return (
    `SSL client key at '${keyPath}' is encrypted; encrypted private keys are not supported. ` +
    `Decrypt it first, e.g. 'openssl pkey -in client.key -out client-plain.key'`
  );
}

/**
 * Read every configured PEM file. The client key is rejected when encrypted.
 * Throws FailedToReadCertificate naming the file on any problem, so nothing is
 * returned unless the whole set is readable. The files are read back to back
 * rather than as an atomic snapshot: a rotation that renames cert and key
 * separately can, in the microseconds between the two reads, yield one file
 * from each generation. libpq has the same window. TLS then rejects that one
 * connection attempt with a key mismatch error and the next attempt re-reads.
 */
function loadPems(paths: PemPaths): PemContents {
  const pems: PemContents = {};
  if (paths.sslrootcert !== undefined) {
    pems.ca = readPemFileSync(paths.sslrootcert, SSL_ROOT_CERT_LABEL);
  }
  if (paths.sslcert !== undefined && paths.sslkey !== undefined) {
    const key = readPemFileSync(paths.sslkey, SSL_CLIENT_KEY_LABEL);
    if (isEncryptedPemKey(key)) {
      throw new FailedToReadCertificate(encryptedKeyMessage(paths.sslkey));
    }
    pems.key = key;
    pems.cert = readPemFileSync(paths.sslcert, SSL_CLIENT_CERT_LABEL);
  }
  return pems;
}

/**
 * A pg.Client that re-reads the configured PEM files every time it connects, so
 * a certificate rotated on disk reaches new pool connections without a restart.
 * libpq likewise opens sslrootcert/sslcert/sslkey per connection, and like
 * libpq the connection fails, with the file named, when a file cannot be read.
 *
 * pg-pool constructs one of these per physical connection and passes it the
 * pool config, so `this.ssl` is the very object the pool config holds and the
 * one the Connection copies into the TLS options once the socket is open.
 * Writing the fresh contents onto it before connecting is enough; reading all
 * files up front, before any socket is opened, means a failure surfaces as an
 * ordinary connection error from `pool.connect()` rather than from inside the
 * TLS handshake.
 */
export function rotatingPemClient(paths: PemPaths): typeof pg.Client {
  return class RotatingPemClient extends pg.Client {
    connect(): Promise<void>;
    connect(callback: (err: Error) => void): void;
    connect(callback?: (err: Error) => void): Promise<void> | void {
      let pems: PemContents;
      try {
        pems = loadPems(paths);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (callback) {
          callback(error);
          return;
        }
        return Promise.reject(error);
      }
      // ssl is always an object when PEM paths are configured (see parse()).
      Object.assign(this.ssl as unknown as object, pems);
      return callback ? super.connect(callback) : super.connect();
    }
  };
}
