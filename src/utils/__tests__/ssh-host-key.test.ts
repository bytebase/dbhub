import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  parseHostKeyCheckMode,
  isHostKeyCheckMode,
  fingerprintSha256,
  normalizeFingerprint,
  parseKnownHosts,
  lookupHostKey,
  keyTypeFromBlob,
  formatKnownHostsLine,
  decideHostKey,
  type HostKeyVerifierOptions,
} from "../ssh-host-key.js";

// A deterministic fake host-key blob. decideHostKey/known_hosts matching work on
// the raw bytes (base64 + SHA256), so a well-formed SSH blob is enough — it need
// not be a real key. Prefix it with a length-delimited "ssh-ed25519" algo name so
// keyTypeFromBlob returns something realistic.
function makeKeyBlob(seedByte: number): Buffer {
  const algo = Buffer.from("ssh-ed25519", "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(algo.length, 0);
  const body = Buffer.alloc(32, seedByte);
  return Buffer.concat([len, algo, body]);
}

const KEY = makeKeyBlob(0x11);
const OTHER_KEY = makeKeyBlob(0x22);
const KEY_B64 = KEY.toString("base64");
const KEY_FP = fingerprintSha256(KEY);

describe("parseHostKeyCheckMode", () => {
  it("accepts the three canonical modes", () => {
    expect(parseHostKeyCheckMode("strict")).toBe("strict");
    expect(parseHostKeyCheckMode("accept-new")).toBe("accept-new");
    expect(parseHostKeyCheckMode("off")).toBe("off");
  });

  it("accepts OpenSSH synonyms and is case-insensitive", () => {
    expect(parseHostKeyCheckMode("YES")).toBe("strict");
    expect(parseHostKeyCheckMode("No")).toBe("off");
    expect(parseHostKeyCheckMode("  Accept-New  ")).toBe("accept-new");
  });

  it("throws on an unrecognized value rather than weakening silently", () => {
    expect(() => parseHostKeyCheckMode("relaxed")).toThrow(/Invalid SSH host key check mode/);
  });

  it("isHostKeyCheckMode guards the type", () => {
    expect(isHostKeyCheckMode("strict")).toBe(true);
    expect(isHostKeyCheckMode("nope")).toBe(false);
  });
});

describe("fingerprintSha256 / normalizeFingerprint", () => {
  it("produces a SHA256:-prefixed, unpadded fingerprint", () => {
    expect(KEY_FP).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(KEY_FP.endsWith("=")).toBe(false);
  });

  it("normalizes label and padding so equivalent forms compare equal", () => {
    const bare = KEY_FP.replace(/^SHA256:/, "");
    expect(normalizeFingerprint(KEY_FP)).toBe(normalizeFingerprint(bare));
    expect(normalizeFingerprint(`sha256:${bare}==`)).toBe(normalizeFingerprint(bare));
  });
});

describe("keyTypeFromBlob", () => {
  it("reads the algorithm name from a well-formed blob", () => {
    expect(keyTypeFromBlob(KEY)).toBe("ssh-ed25519");
  });

  it("returns ssh-unknown for a truncated or bogus blob", () => {
    expect(keyTypeFromBlob(Buffer.from([0, 0]))).toBe("ssh-unknown");
    const bogus = Buffer.alloc(8);
    bogus.writeUInt32BE(9999, 0);
    expect(keyTypeFromBlob(bogus)).toBe("ssh-unknown");
  });
});

describe("parseKnownHosts", () => {
  it("parses plain entries and skips comments/blanks/malformed lines", () => {
    const contents = [
      "# a comment",
      "",
      `bastion.example.com ssh-ed25519 ${KEY_B64}`,
      "malformed-line-without-key",
      `@revoked evil.example.com ssh-ed25519 ${OTHER_KEY.toString("base64")}`,
    ].join("\n");
    const entries = parseKnownHosts(contents);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ hostField: "bastion.example.com" });
    expect(entries[1]).toMatchObject({ marker: "@revoked", hostField: "evil.example.com" });
  });
});

describe("lookupHostKey", () => {
  it("matches a plain host on the default port", () => {
    const entries = parseKnownHosts(`bastion ssh-ed25519 ${KEY_B64}`);
    expect(lookupHostKey(entries, "bastion", 22, KEY_B64).status).toBe("match");
  });

  it("matches a non-default port via the [host]:port form", () => {
    const entries = parseKnownHosts(`[bastion]:2222 ssh-ed25519 ${KEY_B64}`);
    expect(lookupHostKey(entries, "bastion", 2222, KEY_B64).status).toBe("match");
    // Same host on a different port is not the same entry.
    expect(lookupHostKey(entries, "bastion", 22, KEY_B64).status).toBe("unknown");
  });

  it("reports mismatch when the host is known but the key differs (changed key)", () => {
    const entries = parseKnownHosts(`bastion ssh-ed25519 ${KEY_B64}`);
    expect(lookupHostKey(entries, "bastion", 22, OTHER_KEY.toString("base64")).status).toBe("mismatch");
  });

  it("reports unknown when the host is absent", () => {
    const entries = parseKnownHosts(`other ssh-ed25519 ${KEY_B64}`);
    expect(lookupHostKey(entries, "bastion", 22, KEY_B64).status).toBe("unknown");
  });

  it("reports revoked for a matching @revoked entry", () => {
    const entries = parseKnownHosts(`@revoked bastion ssh-ed25519 ${KEY_B64}`);
    expect(lookupHostKey(entries, "bastion", 22, KEY_B64).status).toBe("revoked");
  });

  it("matches hashed (|1|salt|hash) host entries", () => {
    const salt = Buffer.from("0123456789abcdef0123", "utf8"); // 20 bytes
    const hash = createHmac("sha1", salt).update("bastion").digest("base64");
    const line = `|1|${salt.toString("base64")}|${hash} ssh-ed25519 ${KEY_B64}`;
    const entries = parseKnownHosts(line);
    expect(lookupHostKey(entries, "bastion", 22, KEY_B64).status).toBe("match");
    expect(lookupHostKey(entries, "other-host", 22, KEY_B64).status).toBe("unknown");
  });

  it("honors a negated pattern to exclude a host", () => {
    const entries = parseKnownHosts(`*,!bastion ssh-ed25519 ${KEY_B64}`);
    expect(lookupHostKey(entries, "bastion", 22, KEY_B64).status).toBe("unknown");
  });
});

describe("decideHostKey", () => {
  let dir: string;
  let knownHosts: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "dbhub-knownhosts-"));
    knownHosts = path.join(dir, "known_hosts");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const opts = (over: Partial<HostKeyVerifierOptions>): HostKeyVerifierOptions => ({
    mode: "strict",
    knownHostsFiles: [knownHosts],
    ...over,
  });

  it("strict: rejects an unknown host key (fail closed) — the core MITM defense", () => {
    // No known_hosts entry, no pin: this is exactly the rogue-bastion scenario.
    const decision = decideHostKey(opts({ mode: "strict" }), "bastion", 22, KEY);
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toMatch(/no entry in known_hosts/);
  });

  it("strict: accepts a key present in known_hosts", () => {
    writeFileSync(knownHosts, `bastion ssh-ed25519 ${KEY_B64}\n`);
    expect(decideHostKey(opts({ mode: "strict" }), "bastion", 22, KEY).accepted).toBe(true);
  });

  it("strict: rejects a changed key for a known host", () => {
    writeFileSync(knownHosts, `bastion ssh-ed25519 ${KEY_B64}\n`);
    const decision = decideHostKey(opts({ mode: "strict" }), "bastion", 22, OTHER_KEY);
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toMatch(/REMOTE HOST KEY HAS CHANGED/);
  });

  it("pinned fingerprint accepts the matching key and rejects any other", () => {
    const withPin = opts({ mode: "strict", pinnedFingerprint: KEY_FP });
    expect(decideHostKey(withPin, "bastion", 22, KEY).accepted).toBe(true);
    const bad = decideHostKey(withPin, "bastion", 22, OTHER_KEY);
    expect(bad.accepted).toBe(false);
    expect(bad.reason).toMatch(/does not match the pinned fingerprint/);
  });

  it("accept-new: trusts an unknown host on first use and records it", () => {
    const decision = decideHostKey(opts({ mode: "accept-new" }), "bastion", 22, KEY);
    expect(decision.accepted).toBe(true);
    expect(decision.remembered).toBe(true);
    // The key is now persisted, so a subsequent strict check passes.
    expect(readFileSync(knownHosts, "utf8")).toContain(KEY_B64);
    expect(decideHostKey(opts({ mode: "strict" }), "bastion", 22, KEY).accepted).toBe(true);
  });

  it("accept-new: still rejects a changed key for a host it already knows", () => {
    writeFileSync(knownHosts, `bastion ssh-ed25519 ${KEY_B64}\n`);
    const decision = decideHostKey(opts({ mode: "accept-new" }), "bastion", 22, OTHER_KEY);
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toMatch(/REMOTE HOST KEY HAS CHANGED/);
  });

  it("off: accepts any key without verification (documented insecure opt-out)", () => {
    const decision = decideHostKey(opts({ mode: "off" }), "bastion", 22, KEY);
    expect(decision.accepted).toBe(true);
    expect(decision.reason).toMatch(/disabled/);
  });
});

describe("formatKnownHostsLine", () => {
  it("uses the bare host on port 22 and [host]:port otherwise", () => {
    expect(formatKnownHostsLine("bastion", 22, "ssh-ed25519", KEY_B64)).toBe(
      `bastion ssh-ed25519 ${KEY_B64}`
    );
    expect(formatKnownHostsLine("bastion", 2222, "ssh-ed25519", KEY_B64)).toBe(
      `[bastion]:2222 ssh-ed25519 ${KEY_B64}`
    );
  });
});
