import { createHash, createHmac } from "crypto";
import { readFileSync, appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import path from "path";

/**
 * SSH host key verification for the SSH tunnel (GHSA / CWE-295).
 *
 * ssh2's `Client.connect()` accepts the server host key unconditionally when no
 * `hostVerifier` is supplied — it never consults `known_hosts` and never pins a
 * fingerprint, so an on-path attacker can impersonate the bastion, capture the
 * SSH/DB credentials DBHub presents, and read/modify all tunnelled traffic
 * (a MITM). This module builds the `hostVerifier` callback that closes that gap
 * by validating the presented key against an explicit trust anchor and
 * **failing closed** when it cannot.
 *
 * Trust anchors, in priority order:
 *   1. A pinned fingerprint (`SHA256:...`) configured for the connection.
 *   2. An entry for the host in the known_hosts file(s) (OpenSSH format,
 *      including hashed `|1|salt|hash` hostnames).
 *
 * Modes mirror OpenSSH's `StrictHostKeyChecking`:
 *   - `strict`     (default): only a matching trust anchor is accepted;
 *                  anything else — mismatch, revoked, or no anchor at all — is
 *                  rejected. This is the secure default.
 *   - `accept-new`: a host with no known entry is accepted on first use (TOFU)
 *                  and remembered by appending to the known_hosts file; a host
 *                  that IS known must still match (a changed key is rejected).
 *   - `off`        (opt-out): accept any key, restoring the old insecure
 *                  behavior for operators who knowingly accept the risk. Loudly
 *                  logged.
 */

export type HostKeyCheckMode = "strict" | "accept-new" | "off";

export const DEFAULT_HOST_KEY_CHECK_MODE: HostKeyCheckMode = "strict";

/** Valid values for the `ssh_host_key_check` / `--ssh-host-key-check` setting. */
export const HOST_KEY_CHECK_MODES: readonly HostKeyCheckMode[] = [
  "strict",
  "accept-new",
  "off",
];

export function isHostKeyCheckMode(value: string): value is HostKeyCheckMode {
  return (HOST_KEY_CHECK_MODES as readonly string[]).includes(value);
}

/**
 * Parse and normalize a host-key-check mode string (case-insensitive), also
 * accepting the OpenSSH synonyms `yes`/`no`. Throws on an unrecognized value so
 * a typo fails loudly rather than silently weakening verification.
 */
export function parseHostKeyCheckMode(value: string): HostKeyCheckMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "yes") return "strict";
  if (normalized === "no") return "off";
  if (isHostKeyCheckMode(normalized)) return normalized;
  throw new Error(
    `Invalid SSH host key check mode "${value}". Expected one of: ${HOST_KEY_CHECK_MODES.join(", ")}.`
  );
}

/** Default known_hosts locations, mirroring OpenSSH. */
export function getDefaultKnownHostsFiles(): string[] {
  const home = homedir();
  return [
    path.join(home, ".ssh", "known_hosts"),
    path.join(home, ".ssh", "known_hosts2"),
  ];
}

/**
 * Compute the OpenSSH-style SHA256 fingerprint of a raw host-key blob (the
 * base64-decoded key that ssh2 hands the verifier). Format:
 * `SHA256:<base64(sha256(key)) without padding>`.
 */
export function fingerprintSha256(key: Buffer): string {
  const digest = createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
  return `SHA256:${digest}`;
}

/**
 * Normalize a fingerprint string for comparison: trim, drop a leading
 * `SHA256:` label (case-insensitive), and strip base64 padding. Returns the
 * bare base64 digest so pinned values written with or without the label — and
 * with or without trailing `=` — compare equal.
 */
export function normalizeFingerprint(fp: string): string {
  return fp.trim().replace(/^sha256:/i, "").replace(/=+$/, "");
}

interface KnownHostsEntry {
  /** Marker line prefix: `@revoked` or `@cert-authority`, if present. */
  marker?: "@revoked" | "@cert-authority";
  /** Raw host patterns field (comma-separated), verbatim from the line. */
  hostField: string;
  /** Base64 key blob (third field), padding stripped for comparison. */
  keyBase64: string;
}

/**
 * Parse the contents of a known_hosts file into entries. Blank lines and
 * comments (`#`) are skipped. Malformed lines are skipped rather than throwing,
 * matching OpenSSH's lenient parsing.
 */
export function parseKnownHosts(contents: string): KnownHostsEntry[] {
  const entries: KnownHostsEntry[] = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    let fields = line.split(/\s+/);
    let marker: KnownHostsEntry["marker"];
    if (fields[0] === "@revoked" || fields[0] === "@cert-authority") {
      marker = fields[0];
      fields = fields.slice(1);
    }

    // Expect at least: hosts, keytype, keyblob
    if (fields.length < 3) continue;
    const [hostField, , keyBase64] = fields;
    if (!hostField || !keyBase64) continue;

    entries.push({ marker, hostField, keyBase64: keyBase64.replace(/=+$/, "") });
  }
  return entries;
}

/**
 * The set of host-pattern tokens to look for in a known_hosts line for a given
 * host/port. OpenSSH stores a non-default port as `[host]:port`, and the
 * default port 22 as the bare host.
 */
function hostTokens(host: string, port: number): string[] {
  const lower = host.toLowerCase();
  const tokens = new Set<string>();
  if (port === 22) {
    tokens.add(lower);
  }
  // Always also accept the bracketed form; some tools write `[host]:22`.
  tokens.add(`[${lower}]:${port}`);
  return [...tokens];
}

/** Match a hashed known_hosts host pattern (`|1|<b64 salt>|<b64 hash>`). */
function matchesHashedHost(pattern: string, candidate: string): boolean {
  if (!pattern.startsWith("|1|")) return false;
  const parts = pattern.split("|");
  // parts = ["", "1", saltB64, hashB64]
  if (parts.length !== 4) return false;
  const salt = Buffer.from(parts[2], "base64");
  const expected = parts[3].replace(/=+$/, "");
  if (salt.length === 0) return false;
  const actual = createHmac("sha1", salt)
    .update(candidate)
    .digest("base64")
    .replace(/=+$/, "");
  return timingSafeStringEqual(actual, expected);
}

/**
 * Whether a known_hosts host field (which may list several comma-separated
 * patterns, plain or hashed) matches the host/port being connected to.
 * Negations (`!pattern`) are honored: a matching negation excludes the entry.
 */
function hostFieldMatches(hostField: string, host: string, port: number): boolean {
  const tokens = hostTokens(host, port);
  let matched = false;
  for (const rawPattern of hostField.split(",")) {
    const pattern = rawPattern.trim();
    if (!pattern) continue;
    const negated = pattern.startsWith("!");
    const bare = negated ? pattern.slice(1) : pattern;

    let hit = false;
    if (bare.startsWith("|1|")) {
      // Hashed patterns hash the exact stored form: bare host for the default
      // port, `[host]:port` otherwise.
      hit = tokens.some((t) => matchesHashedHost(bare, t));
    } else {
      const lowerBare = bare.toLowerCase();
      hit = tokens.includes(lowerBare);
    }

    if (hit) {
      if (negated) return false; // explicit exclusion wins
      matched = true;
    }
  }
  return matched;
}

/** Constant-time-ish string comparison to avoid leaking match position. */
function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export type HostKeyLookup =
  | { status: "match" }
  | { status: "revoked" }
  | { status: "mismatch" } // host is known but no listed key matches
  | { status: "unknown" }; // host not present in any known_hosts file

/**
 * Look up a presented key for host/port across the given known_hosts contents.
 *
 * - `revoked` if any matching `@revoked` line carries this key.
 * - `match` if a non-revoked, non-CA line for this host lists this key.
 * - `mismatch` if the host appears but with different key(s) only.
 * - `unknown` if the host does not appear at all.
 *
 * `@cert-authority` lines are treated as non-matching (CA validation is out of
 * scope), but still mark the host as "seen" so a CA-only host is a mismatch
 * rather than silently unknown under strict mode.
 */
export function lookupHostKey(
  entries: KnownHostsEntry[],
  host: string,
  port: number,
  keyBase64: string
): HostKeyLookup {
  const normalizedKey = keyBase64.replace(/=+$/, "");
  let hostSeen = false;
  for (const entry of entries) {
    if (!hostFieldMatches(entry.hostField, host, port)) continue;
    hostSeen = true;
    const keyEqual = timingSafeStringEqual(entry.keyBase64, normalizedKey);
    if (entry.marker === "@revoked") {
      if (keyEqual) return { status: "revoked" };
      continue;
    }
    if (entry.marker === "@cert-authority") {
      continue; // cannot validate a CA-signed key here
    }
    if (keyEqual) return { status: "match" };
  }
  return { status: hostSeen ? "mismatch" : "unknown" };
}

/** Read and concatenate the parsed entries of every readable known_hosts file. */
export function loadKnownHosts(files: string[]): KnownHostsEntry[] {
  const entries: KnownHostsEntry[] = [];
  for (const file of files) {
    let contents: string;
    try {
      contents = readFileSync(file, "utf8");
    } catch {
      continue; // missing/unreadable file is fine; just contributes nothing
    }
    entries.push(...parseKnownHosts(contents));
  }
  return entries;
}

/**
 * Derive the SSH key type (e.g. `ssh-ed25519`, `ssh-rsa`) from a raw host-key
 * blob. An SSH public key blob begins with a uint32 length followed by that
 * many bytes of the algorithm name. Returns `"ssh-unknown"` if the blob is too
 * short or the length is implausible.
 */
export function keyTypeFromBlob(key: Buffer): string {
  if (key.length < 4) return "ssh-unknown";
  const len = key.readUInt32BE(0);
  if (len <= 0 || len > 64 || key.length < 4 + len) return "ssh-unknown";
  return key.toString("ascii", 4, 4 + len);
}

/**
 * Format a known_hosts line for a newly accepted host (accept-new mode).
 * Uses the bare host for the default port and `[host]:port` otherwise, matching
 * OpenSSH.
 */
export function formatKnownHostsLine(
  host: string,
  port: number,
  keyType: string,
  keyBase64: string
): string {
  const hostToken = port === 22 ? host.toLowerCase() : `[${host.toLowerCase()}]:${port}`;
  return `${hostToken} ${keyType} ${keyBase64}`;
}

export interface HostKeyVerifierOptions {
  mode: HostKeyCheckMode;
  /** known_hosts files consulted (and, in accept-new mode, appended to). */
  knownHostsFiles: string[];
  /**
   * Optional pinned `SHA256:...` fingerprint. When set it is the sole trust
   * anchor for the host it is attached to (the SSH server / final target),
   * taking priority over known_hosts.
   */
  pinnedFingerprint?: string;
}

export interface HostKeyDecision {
  accepted: boolean;
  /** Human-readable reason, used for the rejection error or an info log. */
  reason: string;
  /** True when accept-new persisted a new entry to known_hosts. */
  remembered?: boolean;
}

/**
 * Decide whether to accept a presented host key for a given host/port under the
 * configured policy. Pure with respect to inputs except for the accept-new
 * write-back, which appends to the first known_hosts file.
 *
 * This is the single decision point behind the ssh2 `hostVerifier`; the tunnel
 * turns `accepted: false` into a fail-closed connection error carrying `reason`.
 */
export function decideHostKey(
  options: HostKeyVerifierOptions,
  host: string,
  port: number,
  key: Buffer
): HostKeyDecision {
  const target = `${host}:${port}`;
  const presentedFp = fingerprintSha256(key);

  if (options.mode === "off") {
    return {
      accepted: true,
      reason: `host key verification disabled (ssh_host_key_check=off) for ${target}; key ${presentedFp} accepted without verification`,
    };
  }

  // 1. Pinned fingerprint is the strongest anchor when configured.
  if (options.pinnedFingerprint) {
    const pinned = normalizeFingerprint(options.pinnedFingerprint);
    const presented = normalizeFingerprint(presentedFp);
    if (timingSafeStringEqual(pinned, presented)) {
      return { accepted: true, reason: `host key ${presentedFp} matches pinned fingerprint for ${target}` };
    }
    return {
      accepted: false,
      reason:
        `host key verification failed for ${target}: presented key ${presentedFp} ` +
        `does not match the pinned fingerprint ${options.pinnedFingerprint}`,
    };
  }

  // 2. known_hosts lookup.
  const keyBase64 = key.toString("base64");
  const entries = loadKnownHosts(options.knownHostsFiles);
  const lookup = lookupHostKey(entries, host, port, keyBase64);

  switch (lookup.status) {
    case "match":
      return { accepted: true, reason: `host key ${presentedFp} matches a known_hosts entry for ${target}` };
    case "revoked":
      return {
        accepted: false,
        reason: `host key verification failed for ${target}: key ${presentedFp} is marked @revoked in known_hosts`,
      };
    case "mismatch":
      return {
        accepted: false,
        reason:
          `host key verification failed for ${target}: REMOTE HOST KEY HAS CHANGED. ` +
          `The presented key ${presentedFp} does not match the key(s) recorded in known_hosts. ` +
          `This may indicate a man-in-the-middle attack, or a legitimate key rotation — ` +
          `verify the key out of band and update known_hosts if it is genuine.`,
      };
    case "unknown":
      if (options.mode === "accept-new") {
        const remembered = appendKnownHost(options.knownHostsFiles, host, port, key);
        return {
          accepted: true,
          remembered,
          reason:
            `host ${target} was not in known_hosts; accepting key ${presentedFp} on first use ` +
            `(ssh_host_key_check=accept-new)` +
            (remembered ? " and recording it" : " (could not persist to known_hosts)"),
        };
      }
      return {
        accepted: false,
        reason:
          `host key verification failed for ${target}: no entry in known_hosts and no pinned ` +
          `fingerprint configured. Presented key ${presentedFp}. Add the host to known_hosts ` +
          `(e.g. ssh-keyscan), set ssh_host_fingerprint to pin it, or use ` +
          `ssh_host_key_check=accept-new to trust on first use. Set ssh_host_key_check=off to ` +
          `disable verification (insecure).`,
      };
  }
}

/**
 * Append a newly accepted host key to the first writable known_hosts file.
 * Best-effort: returns false if no file could be written (the connection still
 * proceeds under accept-new, but the key is not remembered for next time).
 */
function appendKnownHost(files: string[], host: string, port: number, key: Buffer): boolean {
  if (files.length === 0) return false;
  const line = formatKnownHostsLine(host, port, keyTypeFromBlob(key), key.toString("base64"));
  const target = files[0];
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    appendFileSync(target, `${line}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

