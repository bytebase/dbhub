import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ConnectorManager } from "../manager.js";
import { ConnectorRegistry, type Connector, type ConnectorConfig } from "../interface.js";
import { SSHTunnel } from "../../utils/ssh-tunnel.js";
import type { SourceConfig } from "../../types/config.js";
import { homedir } from "os";
import { join } from "path";

const mocks = vi.hoisted(() => ({
  generateRdsAuthToken: vi.fn(),
  parseSSHConfig: vi.fn(),
  looksLikeSSHAlias: vi.fn(),
  getDefaultSSHConfigPath: vi.fn(() => join(homedir(), '.ssh', 'config')),
}));

vi.mock("../../utils/aws-rds-signer.js", () => ({
  generateRdsAuthToken: mocks.generateRdsAuthToken,
}));

vi.mock("../../utils/ssh-config-parser.js", () => ({
  parseSSHConfig: mocks.parseSSHConfig,
  looksLikeSSHAlias: mocks.looksLikeSSHAlias,
  getDefaultSSHConfigPath: mocks.getDefaultSSHConfigPath,
}));

/** A postgres source behind an SSH host; override to vary the SSH fields. */
function sshSource(overrides: Partial<SourceConfig> = {}): SourceConfig {
  return {
    id: "test",
    type: "postgres",
    dsn: "postgres://user:pass@db.internal:5432/mydb",
    ssh_host: "mybastion",
    ...overrides,
  };
}

/** SSH fields for a bastion addressed directly (not an ~/.ssh/config alias), with password auth. */
const BASTION = { ssh_host: "bastion.example.com", ssh_user: "ubuntu", ssh_password: "secret" };

const AWS_IAM_TOKEN_REFRESH_MS = 14 * 60 * 1000;

/** A MySQL source that rotates its pool on the IAM refresh timer. */
function makeIamSource(dsn = "mysql://dbuser:ignored@mydb.abc123.eu-west-1.rds.amazonaws.com:3306/mydb"): SourceConfig {
  return { id: "mysql_iam", type: "mysql", dsn, aws_iam_auth: true, aws_region: "eu-west-1" };
}

/** Replace the registry with a prototype whose clones are recorded, one per connect attempt. */
function stubConnectorRegistry(id = "mysql") {
  const instances: Array<{ connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  const prototype = {
    id,
    clone: () => {
      const instance = {
        id,
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
      };
      instances.push(instance);
      return instance;
    },
  };
  vi.spyOn(ConnectorRegistry, "getConnectorForDSN").mockReturnValue(prototype as any);
  return instances;
}

/** A tunnel through a directly addressed bastion that opens on local port 55555 and closes cleanly. */
function stubSSHTunnel() {
  mocks.looksLikeSSHAlias.mockReturnValue(false);
  return {
    establishSpy: vi
      .spyOn(SSHTunnel.prototype, "establish")
      .mockResolvedValue({ localPort: 55555, targetHost: "db.internal", targetPort: 5432 }),
    closeSpy: vi.spyOn(SSHTunnel.prototype, "close").mockResolvedValue(undefined),
  };
}

describe("ConnectorManager SSH config resolution", () => {
  // Stop at tunnel establishment and capture the merged SSH config handed to it.
  let establishSpy: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    // An agent socket exported in the developer's shell would satisfy SSH auth
    vi.stubEnv("SSH_AUTH_SOCK", "");
    establishSpy = vi
      .spyOn(SSHTunnel.prototype, "establish")
      .mockRejectedValue(new Error("stop after config resolution"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("should resolve an alias from ~/.ssh/config and let explicit TOML fields override its values", async () => {
    mocks.looksLikeSSHAlias.mockReturnValue(true);
    mocks.parseSSHConfig.mockReturnValue({
      host: "bastion.example.com",
      port: 2222,
      username: "ubuntu",
      privateKey: "/home/user/.ssh/id_rsa",
    });

    const manager = new ConnectorManager();
    const source = sshSource({
      ssh_user: "override-user",
      ssh_port: 3333,
      ssh_key: "/custom/key",
    });

    await expect(manager.connectWithSources([source])).rejects.toThrow("stop after config resolution");

    expect(mocks.looksLikeSSHAlias).toHaveBeenCalledWith("mybastion");
    expect(mocks.parseSSHConfig).toHaveBeenCalledWith("mybastion", expect.stringContaining(".ssh/config"));

    // Explicit TOML fields win over the resolved SSH config values;
    // the host still comes from the resolved alias.
    expect(establishSpy).toHaveBeenCalledTimes(1);
    expect(establishSpy.mock.calls[0][0]).toMatchObject({
      host: "bastion.example.com",
      username: "override-user",
      port: 3333,
      privateKey: "/custom/key",
    });
  });

  it("should throw when SSH alias not found and no ssh_user provided", async () => {
    mocks.looksLikeSSHAlias.mockReturnValue(true);
    mocks.parseSSHConfig.mockReturnValue(null);

    await expect(
      new ConnectorManager().connectWithSources([sshSource({ ssh_host: "unknown-alias" })])
    ).rejects.toThrow(
      "SSH tunnel requires ssh_user (or a matching Host entry in ~/.ssh/config with User)"
    );
  });

  it.each([
    ["rejects", "", false],
    ["accepts", "/tmp/agent.sock", true],
  ])(
    "%s an alias with no key or password when SSH_AUTH_SOCK is %j",
    async (_verb, authSock, reachesTunnel) => {
      vi.stubEnv("SSH_AUTH_SOCK", authSock);
      mocks.looksLikeSSHAlias.mockReturnValue(true);
      mocks.parseSSHConfig.mockReturnValue({
        host: "bastion.example.com",
        username: "ubuntu",
        // No privateKey, no password
      });

      const attempt = new ConnectorManager().connectWithSources([sshSource()]);
      if (reachesTunnel) {
        await expect(attempt).rejects.toThrow("stop after config resolution");
        expect(establishSpy).toHaveBeenCalledTimes(1);
      } else {
        await expect(attempt).rejects.toThrow(
          "SSH tunnel requires either ssh_password or ssh_key (or a matching Host entry in ~/.ssh/config with IdentityFile, or an SSH agent via ssh_agent or SSH_AUTH_SOCK)"
        );
        expect(establishSpy).not.toHaveBeenCalled();
      }
    }
  );

  it("should mark a key resolved from ~/.ssh/config as discovered, but not an explicit ssh_key", async () => {
    mocks.looksLikeSSHAlias.mockReturnValue(true);
    mocks.parseSSHConfig.mockReturnValue({
      host: "bastion.example.com",
      username: "ubuntu",
      privateKey: "/home/user/.ssh/id_rsa",
      privateKeyDiscovered: true,
    });

    await expect(new ConnectorManager().connectWithSources([sshSource()])).rejects.toThrow();
    expect(establishSpy.mock.calls[0][0]).toMatchObject({
      privateKey: "/home/user/.ssh/id_rsa",
      privateKeyDiscovered: true,
    });

    await expect(
      new ConnectorManager().connectWithSources([sshSource({ ssh_key: "/custom/key" })])
    ).rejects.toThrow();
    expect(establishSpy.mock.calls[1][0]).toMatchObject({ privateKey: "/custom/key" });
    expect(establishSpy.mock.calls[1][0].privateKeyDiscovered).toBeFalsy();
  });

  it("should skip SSH config resolution for a direct hostname and pass ssh_agent as the only auth method", async () => {
    mocks.looksLikeSSHAlias.mockReturnValue(false);

    const source = sshSource({
      ssh_host: "bastion.example.com",
      ssh_user: "ubuntu",
      ssh_agent: "/tmp/configured.sock",
    });

    // Fails at tunnel establishment, not at config resolution
    await expect(new ConnectorManager().connectWithSources([source])).rejects.toThrow("stop after config resolution");
    expect(mocks.looksLikeSSHAlias).toHaveBeenCalledWith("bastion.example.com");
    expect(mocks.parseSSHConfig).not.toHaveBeenCalled();
    expect(establishSpy).toHaveBeenCalledTimes(1);
    expect(establishSpy.mock.calls[0][0]).toMatchObject({
      host: "bastion.example.com",
      username: "ubuntu",
      agent: "/tmp/configured.sock",
    });
  });
});

describe("ConnectorManager IAM DSN rewrite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should inject encoded IAM token, preserve query params, and force sslmode=require", async () => {
    mocks.generateRdsAuthToken.mockResolvedValue("token with spaces/+?=");

    const manager = new ConnectorManager();
    const source: SourceConfig = {
      id: "mysql_iam",
      type: "mysql",
      host: "mydb.abc123.eu-west-1.rds.amazonaws.com",
      port: 3306,
      database: "mydb",
      user: "dbuser@example.com",
      aws_iam_auth: true,
      aws_region: "eu-west-1",
      aws_profile: "ngqa",
      dsn: "mysql://dbuser%40example.com:ignored@mydb.abc123.eu-west-1.rds.amazonaws.com:3306/mydb?connectTimeout=5000&sslmode=disable",
    };

    const dsn = await (manager as any).buildConnectionDSN(source, {});

    expect(mocks.generateRdsAuthToken).toHaveBeenCalledWith({
      hostname: "mydb.abc123.eu-west-1.rds.amazonaws.com",
      port: 3306,
      username: "dbuser@example.com",
      region: "eu-west-1",
      profile: "ngqa",
    });
    expect(dsn).toContain("mysql://dbuser%40example.com:token%20with%20spaces%2F%2B%3F%3D@");
    expect(dsn).toContain("connectTimeout=5000");
    expect(dsn).toContain("sslmode=require");
    expect(dsn).not.toContain("sslmode=disable");
  });
});

describe("ConnectorManager PostgreSQL pool configuration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes pool_max_connections to the connector", async () => {
    const instances = stubConnectorRegistry("postgres");

    const manager = new ConnectorManager();
    await manager.connectWithSources([{
      id: "postgres",
      type: "postgres",
      dsn: "postgres://user:pass@localhost:5432/db",
      pool_max_connections: 5,
    }]);

    expect(instances[0].connect).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      expect.objectContaining({ poolMaxConnections: 5 })
    );
  });
});

describe("ConnectorManager IAM refresh recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("should stop refreshing a source whose IAM refresh failed and recover it once credentials are valid again", async () => {
    const instances = stubConnectorRegistry();
    mocks.generateRdsAuthToken.mockResolvedValueOnce("token-1");

    const manager = new ConnectorManager();
    await manager.connectWithSources([makeIamSource()]);
    expect(instances).toHaveLength(1);
    expect(manager.getConnector("mysql_iam")).toBe(instances[0]);

    // Refresh tick fires while the SSO session is expired: minting the token throws.
    mocks.generateRdsAuthToken.mockRejectedValueOnce(new Error("SSO session expired"));
    await vi.advanceTimersByTimeAsync(AWS_IAM_TOKEN_REFRESH_MS);
    expect(instances[0].disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.generateRdsAuthToken).toHaveBeenCalledTimes(2);

    // The timer must not be re-armed for a source that is no longer connected. (The
    // previous implementation re-armed here and then returned at the guard on every
    // later tick, so the token call count alone cannot tell the two apart.)
    expect(vi.getTimerCount()).toBe(0);
    // No further ticks: reconnection is driven by the next tool call.
    await vi.advanceTimersByTimeAsync(AWS_IAM_TOKEN_REFRESH_MS * 3);
    expect(mocks.generateRdsAuthToken).toHaveBeenCalledTimes(2);

    // The source stays known and is still listed as available, because a tool call
    // will retry the connection. Before the fix this threw "Source 'mysql_iam' not
    // found. Available sources: mysql_iam" and there was no way back.
    expect(manager.getSourceIds()).toEqual(["mysql_iam"]);

    // Still broken: the next tool call surfaces the real cause, not "not found".
    mocks.generateRdsAuthToken.mockRejectedValueOnce(new Error("SSO session expired"));
    await expect(manager.ensureConnected("mysql_iam")).rejects.toThrow("SSO session expired");

    // User re-authenticates: the next tool call reconnects transparently.
    mocks.generateRdsAuthToken.mockResolvedValueOnce("token-2");
    await manager.ensureConnected("mysql_iam");
    expect(instances).toHaveLength(2);
    expect(manager.getConnector("mysql_iam")).toBe(instances[1]);
    expect(instances[1].connect).toHaveBeenCalledWith(
      expect.stringContaining("token-2"),
      undefined,
      expect.any(Object)
    );

    // Refresh rotation resumes for the recovered connection.
    mocks.generateRdsAuthToken.mockResolvedValueOnce("token-3");
    await vi.advanceTimersByTimeAsync(AWS_IAM_TOKEN_REFRESH_MS);
    expect(instances).toHaveLength(3);
    expect(instances[1].disconnect).toHaveBeenCalledTimes(1);
    expect(manager.getConnector("mysql_iam")).toBe(instances[2]);

    await manager.disconnect();
  });

  it("should keep serving through a refresh when closing the old pool hangs", async () => {
    const instances = stubConnectorRegistry();
    mocks.generateRdsAuthToken.mockResolvedValue("token");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const manager = new ConnectorManager();
    await manager.connectWithSources([makeIamSource()]);
    // mysql2's pool.end() never settles while one of its connections is stuck.
    instances[0].disconnect.mockReturnValue(new Promise<void>(() => {}));

    await vi.advanceTimersByTimeAsync(AWS_IAM_TOKEN_REFRESH_MS);

    // The replacement is already serving; the stuck close does not hold the source.
    expect(instances).toHaveLength(2);
    expect(instances[0].disconnect).toHaveBeenCalledTimes(1);
    expect(manager.getConnector("mysql_iam")).toBe(instances[1]);

    // The close is abandoned after its time limit instead of being awaited forever.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(errorSpy).toHaveBeenCalledWith(
      "Error closing the replaced connection for source 'mysql_iam':",
      expect.objectContaining({ message: expect.stringContaining("timed out") })
    );

    // Rotation carries on from the replacement.
    await vi.advanceTimersByTimeAsync(AWS_IAM_TOKEN_REFRESH_MS);
    expect(instances).toHaveLength(3);
    expect(instances[0].disconnect).toHaveBeenCalledTimes(1);
    expect(instances[1].disconnect).toHaveBeenCalledTimes(1);
    expect(manager.getConnector("mysql_iam")).toBe(instances[2]);

    await manager.disconnect();
  });

  it("should not lose the source when closing the old pool throws", async () => {
    const instances = stubConnectorRegistry();
    mocks.generateRdsAuthToken.mockResolvedValue("token");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const manager = new ConnectorManager();
    await manager.connectWithSources([makeIamSource()]);
    instances[0].disconnect.mockRejectedValue(new Error("Connection lost: The server closed the connection."));

    await vi.advanceTimersByTimeAsync(AWS_IAM_TOKEN_REFRESH_MS);

    expect(instances).toHaveLength(2);
    expect(manager.getConnector("mysql_iam")).toBe(instances[1]);
    expect(errorSpy).toHaveBeenCalledWith(
      "Error closing the replaced connection for source 'mysql_iam':",
      expect.objectContaining({ message: expect.stringContaining("Connection lost") })
    );

    // Later refreshes rotate the live connector; the broken one is never closed again.
    await vi.advanceTimersByTimeAsync(AWS_IAM_TOKEN_REFRESH_MS);
    expect(instances).toHaveLength(3);
    expect(instances[0].disconnect).toHaveBeenCalledTimes(1);
    expect(manager.getConnector("mysql_iam")).toBe(instances[2]);

    await manager.disconnect();
  });

  it("should fall back to lazy reconnection when the refresh fails and the old pool will not close", async () => {
    const instances = stubConnectorRegistry();
    mocks.generateRdsAuthToken.mockResolvedValueOnce("token-1");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const manager = new ConnectorManager();
    await manager.connectWithSources([makeIamSource()]);
    instances[0].disconnect.mockReturnValue(new Promise<void>(() => {}));

    mocks.generateRdsAuthToken.mockRejectedValueOnce(new Error("SSO session expired"));
    await vi.advanceTimersByTimeAsync(AWS_IAM_TOKEN_REFRESH_MS);

    // The old pool is retired without waiting for it, so the next tool call can
    // reconnect straight away.
    expect(instances[0].disconnect).toHaveBeenCalledTimes(1);
    mocks.generateRdsAuthToken.mockResolvedValueOnce("token-2");
    await manager.ensureConnected("mysql_iam");
    expect(instances).toHaveLength(2);
    expect(manager.getConnector("mysql_iam")).toBe(instances[1]);

    await manager.disconnect();
  });

  it("should open the replacement SSH tunnel before closing the old one", async () => {
    const instances = stubConnectorRegistry();
    mocks.generateRdsAuthToken.mockResolvedValue("token");
    mocks.looksLikeSSHAlias.mockReturnValue(false);
    const tunnels: SSHTunnel[] = [];
    vi.spyOn(SSHTunnel.prototype, "establish").mockImplementation(async function (this: SSHTunnel) {
      tunnels.push(this);
      return { localPort: 55000 + tunnels.length, targetHost: "mydb", targetPort: 3306 };
    });
    const closed: SSHTunnel[] = [];
    vi.spyOn(SSHTunnel.prototype, "close").mockImplementation(async function (this: SSHTunnel) {
      closed.push(this);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const manager = new ConnectorManager();
    await manager.connectWithSources([{ ...makeIamSource(), ...BASTION }]);
    instances[0].disconnect.mockRejectedValue(new Error("Connection lost"));

    await vi.advanceTimersByTimeAsync(AWS_IAM_TOKEN_REFRESH_MS);

    // The new connector goes through the new tunnel; the old tunnel is closed even
    // though the old pool failed to close, and the new tunnel stays registered.
    expect(tunnels).toHaveLength(2);
    expect(instances[1].connect.mock.calls[0][0]).toContain("127.0.0.1:55002");
    expect(manager.getConnector("mysql_iam")).toBe(instances[1]);
    expect(closed).toEqual([tunnels[0]]);
    expect((manager as any).sshTunnels.get("mysql_iam")).toBe(tunnels[1]);

    // A failed refresh closes both its own tunnel and the one it was replacing.
    mocks.generateRdsAuthToken.mockRejectedValueOnce(new Error("SSO session expired"));
    await vi.advanceTimersByTimeAsync(AWS_IAM_TOKEN_REFRESH_MS);
    expect(closed).toEqual([tunnels[0], tunnels[1]]);
    expect((manager as any).sshTunnels.size).toBe(0);

    await manager.disconnect();
  });

  it("should close the SSH tunnel when the database connection fails so a retry does not leak it", async () => {
    const instances = stubConnectorRegistry();
    const { establishSpy, closeSpy } = stubSSHTunnel();
    const prototype = ConnectorRegistry.getConnectorForDSN("postgres://x") as any;
    const originalClone = prototype.clone;
    prototype.clone = () => {
      const instance = originalClone();
      instance.connect.mockRejectedValue(new Error("password authentication failed"));
      return instance;
    };

    const manager = new ConnectorManager();
    await manager.connectWithSources([sshSource({ id: "pg_ssh", ...BASTION, lazy: true })]);

    await expect(manager.ensureConnected("pg_ssh")).rejects.toThrow("password authentication failed");
    expect(establishSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect((manager as any).sshTunnels.size).toBe(0);

    // A retry opens exactly one new tunnel and, on failure, closes that one too.
    await expect(manager.ensureConnected("pg_ssh")).rejects.toThrow("password authentication failed");
    expect(establishSpy).toHaveBeenCalledTimes(2);
    expect(closeSpy).toHaveBeenCalledTimes(2);
    expect((manager as any).sshTunnels.size).toBe(0);
    expect(instances).toHaveLength(2);
  });

  it("should close the SSH tunnel when no connector accepts the DSN after the tunnel is up", async () => {
    const { establishSpy, closeSpy } = stubSSHTunnel();
    vi.spyOn(ConnectorRegistry, "getConnectorForDSN").mockReturnValue(null);

    const manager = new ConnectorManager();

    await expect(manager.addSource(sshSource({ id: "pg_ssh", ...BASTION }))).rejects.toThrow("No connector found");
    expect(establishSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect((manager as any).sshTunnels.size).toBe(0);
    expect(manager.getSourceIds()).toEqual([]);
  });

  it("should tunnel a DSN whose password has raw special characters, leaving it as written", async () => {
    // new URL() rejects this DSN ('#' starts a fragment, leaving an invalid
    // port), so it used to connect directly but fail once ssh_host was set.
    const instances = stubConnectorRegistry();
    const { establishSpy } = stubSSHTunnel();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const manager = new ConnectorManager();
    await manager.connectWithSources([
      sshSource({ id: "pg_ssh", dsn: "postgres://user:pa#ss@db.internal/mydb?sslmode=require", ...BASTION }),
    ]);

    expect(establishSpy.mock.calls[0][1]).toEqual({ targetHost: "db.internal", targetPort: 5432 });
    expect(instances[0].connect.mock.calls[0][0]).toBe(
      "postgres://user:pa#ss@127.0.0.1:55555/mydb?sslmode=require"
    );

    await manager.disconnect();
  });

  it("should not list a source as available when it can neither serve nor reconnect", () => {
    const manager = new ConnectorManager();
    (manager as any).sourceIds = ["alive", "dead"];
    (manager as any).connectors.set("alive", {});

    expect(() => manager.getConnector("dead")).toThrow(
      /^Source 'dead' not found\. Available sources: alive$/
    );
  });
});

describe("PostgreSQL IAM authentication on demand", () => {
  const source: SourceConfig = {
    id: "production", type: "postgres", host: "db.example.com", port: 5432,
    database: "db", user: "db_user", aws_iam_auth: true,
    aws_region: "us-east-1", aws_profile: "production", lazy: true,
  };
  let manager: ConnectorManager;
  let config: ConnectorConfig;
  let dsn: string;
  const disconnect = vi.fn();
  const connect = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.generateRdsAuthToken.mockReset().mockResolvedValue("token");
    connect.mockReset().mockImplementation(async (value: string, _init: string, options: ConnectorConfig) => {
      dsn = value;
      config = options;
      await options.password?.();
    });
    manager = new ConnectorManager();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(ConnectorRegistry, "getConnectorForDSN").mockReturnValue({
      clone: () => ({
        id: "postgres", disconnect, connect,
      }),
    } as unknown as Connector);
  });

  afterEach(async () => {
    await manager.disconnect();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("authenticates new connections, never refreshes an idle source on a timer", async () => {
    await manager.connectWithSources([source]);
    expect(mocks.generateRdsAuthToken).not.toHaveBeenCalled();
    await manager.ensureConnected(source.id);
    expect(config.password).toBeTypeOf("function");
    expect(dsn).not.toContain("token");
    expect(dsn).toContain("sslmode=require");
    expect(mocks.generateRdsAuthToken).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(disconnect).not.toHaveBeenCalled();
    expect(mocks.generateRdsAuthToken).toHaveBeenCalledTimes(1);

    // A pool opening several sockets shares only the in-flight token request.
    const password = config.password!;
    await Promise.all(Array.from({ length: 8 }, () => password()));
    expect(mocks.generateRdsAuthToken).toHaveBeenCalledTimes(2);
    mocks.generateRdsAuthToken.mockRejectedValueOnce(new Error("SSO session expired"));
    await expect(password()).rejects.toThrow("SSO session expired");
    await expect(password()).resolves.toBe("token");
    expect(manager.getConnector(source.id)).toBeDefined();
    expect(mocks.generateRdsAuthToken).toHaveBeenCalledTimes(4);
  });

  it("retries failed initial authentication only when another request arrives", async () => {
    mocks.generateRdsAuthToken.mockRejectedValueOnce(new Error("SSO session expired"));
    await manager.connectWithSources([source]);
    await expect(manager.ensureConnected(source.id)).rejects.toThrow("SSO session expired");
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(mocks.generateRdsAuthToken).toHaveBeenCalledTimes(1);
    await Promise.all(Array.from({ length: 8 }, () => manager.ensureConnected(source.id)));
    expect(mocks.generateRdsAuthToken).toHaveBeenCalledTimes(2);
    expect(manager.getSourceIds()).toEqual([source.id]);
    expect(manager.getConnector(source.id)).toBeDefined();
  });

  it("signs the original endpoint through SSH and cleans up a failed authentication", async () => {
    mocks.looksLikeSSHAlias.mockReturnValue(false);
    vi.spyOn(SSHTunnel.prototype, "establish").mockResolvedValue({
      localPort: 15432, localHost: "127.0.0.1",
    } as any);
    const close = vi.spyOn(SSHTunnel.prototype, "close").mockResolvedValue();
    mocks.generateRdsAuthToken.mockRejectedValueOnce(new Error("SSO session expired"));
    await manager.connectWithSources([{ ...source, sslmode: "verify-full",
      ssh_host: "bastion.example.com", ssh_user: "user", ssh_key: "/fake/key" }]);
    await expect(manager.ensureConnected(source.id)).rejects.toThrow("SSO session expired");
    expect(close).toHaveBeenCalledTimes(1);
    await manager.ensureConnected(source.id);
    expect(dsn).toContain("127.0.0.1:15432");
    expect(dsn).toContain("sslmode=verify-full");
    expect(mocks.generateRdsAuthToken).toHaveBeenLastCalledWith({
      hostname: "db.example.com", port: 5432, username: "db_user",
      region: "us-east-1", profile: "production",
    });
  });

  it("shares a still-running credential helper after an initial socket timeout", async () => {
    let finishLogin!: (token: string) => void;
    mocks.generateRdsAuthToken.mockReturnValueOnce(new Promise<string>(resolve => { finishLogin = resolve; }));
    connect.mockImplementationOnce(async (_dsn, _init, options: ConnectorConfig) => {
      void options.password!().catch(() => {});
      throw new Error("Connection timeout");
    });
    await manager.connectWithSources([source]);
    await expect(manager.ensureConnected(source.id)).rejects.toThrow("Connection timeout");
    const retry = manager.ensureConnected(source.id);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(mocks.generateRdsAuthToken).toHaveBeenCalledTimes(1);
    finishLogin("token");
    await retry;
    expect(manager.getConnector(source.id)).toBeDefined();
  });
});

describe("ConnectorManager per-source add/remove", () => {
  const srcA: SourceConfig = { id: "a", type: "postgres", dsn: "postgres://u:p@h/a" };
  const srcB: SourceConfig = { id: "b", type: "postgres", dsn: "postgres://u:p@h/b" };

  let instances: ReturnType<typeof stubConnectorRegistry>;
  let manager: ConnectorManager;

  beforeEach(() => {
    instances = stubConnectorRegistry("postgres");
    manager = new ConnectorManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds an eager source without touching the existing one", async () => {
    await manager.connectWithSources([srcA]);

    await manager.addSource(srcB);

    expect(instances).toHaveLength(2);
    expect(instances[0].disconnect).not.toHaveBeenCalled();
    expect(manager.getConnector("a")).toBe(instances[0]);
    expect(manager.getConnector("b")).toBe(instances[1]);
    expect(manager.getSourceIds()).toEqual(["a", "b"]);
    expect(manager.getAllSourceConfigs()).toEqual([srcA, srcB]);
  });

  it("registers a lazy source and connects it on first use", async () => {
    await manager.connectWithSources([srcA]);

    await manager.addSource({ ...srcB, lazy: true });
    expect(instances).toHaveLength(1);
    expect(manager.getSourceIds()).toEqual(["a", "b"]);

    await manager.ensureConnected("b");
    expect(instances).toHaveLength(2);
    expect(manager.getConnector("b")).toBe(instances[1]);
  });

  it("rejects a duplicate source id", async () => {
    await manager.connectWithSources([srcA]);

    await expect(manager.addSource(srcA)).rejects.toThrow("already exists");
  });

  it("removes one source and leaves the other connected", async () => {
    await manager.connectWithSources([srcA, srcB]);

    await manager.removeSource("a");

    expect(instances[0].disconnect).toHaveBeenCalledTimes(1);
    expect(instances[1].disconnect).not.toHaveBeenCalled();
    expect(manager.getSourceIds()).toEqual(["b"]);
    expect(manager.getConnector()).toBe(instances[1]);
    expect(() => manager.getConnector("a")).toThrow("Source 'a' not found");
  });

  it("removing an unknown source is a no-op", async () => {
    await manager.connectWithSources([srcA]);

    await expect(manager.removeSource("nope")).resolves.toBeUndefined();
    expect(manager.getSourceIds()).toEqual(["a"]);
  });

  it("reorders sources so the requested first id becomes the default", async () => {
    await manager.connectWithSources([srcA, srcB]);

    manager.reorderSources(["b", "unknown", "a"]);

    expect(manager.getSourceIds()).toEqual(["b", "a"]);
    expect(manager.getConnector()).toBe(instances[1]);
  });
});

describe("ConnectorManager IAM refresh racing with removeSource", () => {
  /**
   * Connector stubs; the second one's connect() blocks until the test releases it.
   * The second one is the refresh's replacement, so this parks the refresh mid-flight.
   */
  function stubSlowReconnectRegistry() {
    const instances: Array<{ connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; release: () => void }> = [];
    const prototype = {
      id: "mysql",
      clone: () => {
        let release: () => void = () => {};
        const connect = instances.length === 1
          ? vi.fn().mockImplementation(() => new Promise<void>(resolve => { release = resolve; }))
          : vi.fn().mockResolvedValue(undefined);
        const instance = {
          id: "mysql",
          connect,
          disconnect: vi.fn().mockResolvedValue(undefined),
          release: () => release(),
        };
        instances.push(instance);
        return instance;
      },
    };
    vi.spyOn(ConnectorRegistry, "getConnectorForDSN").mockReturnValue(prototype as any);
    return instances;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.generateRdsAuthToken.mockResolvedValue("token");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not resurrect a source removed while its IAM refresh was in flight", async () => {
    const instances = stubSlowReconnectRegistry();
    const manager = new ConnectorManager();
    await manager.connectWithSources([makeIamSource()]);

    // Refresh fires and blocks inside the replacement connector's connect(), with the
    // old connector still serving.
    await vi.advanceTimersByTimeAsync(AWS_IAM_TOKEN_REFRESH_MS);
    expect(instances).toHaveLength(2);
    expect(instances[1].connect).toHaveBeenCalledTimes(1);
    expect(instances[0].disconnect).not.toHaveBeenCalled();
    expect(manager.getConnector("mysql_iam")).toBe(instances[0]);

    // Config reload drops the source while the refresh is parked.
    const removal = manager.removeSource("mysql_iam");
    instances[1].release();
    await removal;
    await vi.advanceTimersByTimeAsync(0);

    // The refresh finished its swap, and removal then tore the new connector down too.
    expect(instances).toHaveLength(2);
    expect(instances[0].disconnect).toHaveBeenCalledTimes(1);
    expect(instances[1].disconnect).toHaveBeenCalledTimes(1);
    expect(manager.getSourceIds()).toEqual([]);
    expect(() => manager.getConnector("mysql_iam")).toThrow();

    // And no refresh timer was re-armed for the dead source.
    await vi.advanceTimersByTimeAsync(AWS_IAM_TOKEN_REFRESH_MS);
    expect(instances).toHaveLength(2);
  });

  it("does not clobber a same-id replacement added while the old refresh was in flight", async () => {
    const instances = stubSlowReconnectRegistry();
    const manager = new ConnectorManager();
    await manager.connectWithSources([makeIamSource()]);

    await vi.advanceTimersByTimeAsync(AWS_IAM_TOKEN_REFRESH_MS);
    expect(instances[1].connect).toHaveBeenCalledTimes(1);

    const replacement = makeIamSource("mysql://dbuser:ignored@other.abc123.eu-west-1.rds.amazonaws.com:3306/mydb");
    const swap = (async () => {
      await manager.removeSource("mysql_iam");
      await manager.addSource(replacement);
    })();
    instances[1].release();
    await swap;
    await vi.advanceTimersByTimeAsync(0);

    // instances[1] is the refresh's reconnect of the old config, torn down by removeSource;
    // instances[2] is the replacement and is what the manager serves.
    expect(instances).toHaveLength(3);
    expect(instances[0].disconnect).toHaveBeenCalledTimes(1);
    expect(instances[1].disconnect).toHaveBeenCalledTimes(1);
    expect(manager.getConnector("mysql_iam")).toBe(instances[2]);
    expect(manager.getSourceConfig("mysql_iam")).toBe(replacement);
    expect(instances[2].connect.mock.calls[0][0]).toContain("other.abc123");

    // The next refresh tick belongs to the replacement, not the removed config.
    await vi.advanceTimersByTimeAsync(AWS_IAM_TOKEN_REFRESH_MS);
    expect(instances).toHaveLength(4);
    expect(instances[3].connect.mock.calls[0][0]).toContain("other.abc123");
  });
});
