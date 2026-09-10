import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fingerprintSha256 } from "../ssh-host-key.js";

/**
 * Regression for the SSH tunnel MITM advisory (CWE-295): ssh2's client accepts
 * any host key when no `hostVerifier` is supplied. These tests drive the real
 * SSHTunnel with a mocked ssh2 whose "server" presents an attacker-chosen host
 * key, and assert the tunnel now verifies it — rejecting an unknown/rogue key
 * under the default strict mode (the rogue-bastion scenario from the PoC),
 * while accepting a key that a trust anchor vouches for.
 */

// The host key the mocked SSH server presents. Well-formed enough for
// keyTypeFromBlob; the verifier works on the raw bytes.
function makeKeyBlob(seedByte: number): Buffer {
  const algo = Buffer.from("ssh-ed25519", "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(algo.length, 0);
  return Buffer.concat([len, algo, Buffer.alloc(32, seedByte)]);
}

const ROGUE_KEY = makeKeyBlob(0x99);
const ROGUE_KEY_B64 = ROGUE_KEY.toString("base64");
const ROGUE_FP = fingerprintSha256(ROGUE_KEY);

// Mock ssh2. The mocked client invokes the caller-supplied `hostVerifier` with
// ROGUE_KEY (mimicking the wire handshake). If verification passes it emits
// 'ready'; if it fails it emits 'error', exactly as ssh2 does on a rejected
// host key. forwardOut is unused during establish() for a single hop.
vi.mock("ssh2", () => {
  class MockClient {
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    on(event: string, cb: (...args: unknown[]) => void): this {
      const arr = this.listeners.get(event) ?? [];
      arr.push(cb);
      this.listeners.set(event, arr);
      return this;
    }
    removeListener(event: string, cb: (...args: unknown[]) => void): this {
      const arr = this.listeners.get(event) ?? [];
      this.listeners.set(event, arr.filter((fn) => fn !== cb));
      return this;
    }
    connect(config: Record<string, unknown>): void {
      const verifier = config.hostVerifier as ((key: Buffer) => boolean) | undefined;
      const accepted = verifier ? verifier(ROGUE_KEY) : true;
      queueMicrotask(() => {
        const event = accepted ? "ready" : "error";
        for (const cb of this.listeners.get(event) ?? []) {
          cb(accepted ? undefined : new Error("All configured authentication methods failed"));
        }
      });
    }
    forwardOut(
      _sh: string,
      _sp: number,
      _dh: string,
      _dp: number,
      cb: (err: Error | undefined, stream: unknown) => void
    ): void {
      cb(undefined, {});
    }
    destroy(): void {}
    end(): void {}
  }
  return { Client: MockClient };
});

// Import after the mock is registered.
const { SSHTunnel } = await import("../ssh-tunnel.js");
type SSHTunnelConfig = import("../../types/ssh.js").SSHTunnelConfig;

describe("SSHTunnel host key verification (MITM regression)", () => {
  let dir: string;
  let knownHosts: string;

  const baseConfig = (): SSHTunnelConfig => ({
    host: "bastion.example.com",
    port: 22,
    username: "dbhub",
    password: "s3cret",
  });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "dbhub-tunnel-hostkey-"));
    knownHosts = path.join(dir, "known_hosts");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("strict (default): rejects a rogue/unknown host key and reports why", async () => {
    const tunnel = new SSHTunnel();
    await expect(
      tunnel.establish(
        { ...baseConfig(), hostKeyCheck: "strict", knownHostsFiles: [knownHosts] },
        { targetHost: "127.0.0.1", targetPort: 5432 }
      )
    ).rejects.toThrow(/no entry in known_hosts/);
    expect(tunnel.getIsConnected()).toBe(false);
  });

  it("strict: accepts the key when known_hosts vouches for it", async () => {
    writeFileSync(knownHosts, `bastion.example.com ssh-ed25519 ${ROGUE_KEY_B64}\n`);
    const tunnel = new SSHTunnel();
    const info = await tunnel.establish(
      { ...baseConfig(), hostKeyCheck: "strict", knownHostsFiles: [knownHosts] },
      { targetHost: "127.0.0.1", targetPort: 5432 }
    );
    expect(info.localPort).toBeGreaterThan(0);
    await tunnel.close();
  });

  it("pinned fingerprint: accepts a matching key, rejects a mismatch", async () => {
    const tunnel = new SSHTunnel();
    const info = await tunnel.establish(
      { ...baseConfig(), hostKeyCheck: "strict", knownHostsFiles: [knownHosts], hostFingerprint: ROGUE_FP },
      { targetHost: "127.0.0.1", targetPort: 5432 }
    );
    expect(info.localPort).toBeGreaterThan(0);
    await tunnel.close();

    const tunnel2 = new SSHTunnel();
    await expect(
      tunnel2.establish(
        {
          ...baseConfig(),
          hostKeyCheck: "strict",
          knownHostsFiles: [knownHosts],
          hostFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
        { targetHost: "127.0.0.1", targetPort: 5432 }
      )
    ).rejects.toThrow(/does not match the pinned fingerprint/);
  });

  it("off: restores the old behavior and accepts any key (opt-out)", async () => {
    const tunnel = new SSHTunnel();
    const info = await tunnel.establish(
      { ...baseConfig(), hostKeyCheck: "off", knownHostsFiles: [knownHosts] },
      { targetHost: "127.0.0.1", targetPort: 5432 }
    );
    expect(info.localPort).toBeGreaterThan(0);
    await tunnel.close();
  });

  it("defaults to strict when no mode is configured (secure by default)", async () => {
    const tunnel = new SSHTunnel();
    await expect(
      tunnel.establish(
        { ...baseConfig(), knownHostsFiles: [knownHosts] },
        { targetHost: "127.0.0.1", targetPort: 5432 }
      )
    ).rejects.toThrow(/host key verification failed/);
  });
});
