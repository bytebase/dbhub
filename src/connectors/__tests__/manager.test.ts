import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("ConnectorManager SSH config resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should resolve SSH config from ~/.ssh/config for alias hosts", async () => {
    mocks.looksLikeSSHAlias.mockReturnValue(true);
    mocks.parseSSHConfig.mockReturnValue({
      host: "bastion.example.com",
      port: 2222,
      username: "ubuntu",
      privateKey: "/home/user/.ssh/id_rsa",
    });

    const manager = new ConnectorManager();
    const source: SourceConfig = {
      id: "test",
      type: "postgres",
      dsn: "postgres://user:pass@db.internal:5432/mydb",
      ssh_host: "mybastion",
    };

    // connectSource is private; connectWithSources calls it.
    // It will fail when trying to establish the actual SSH tunnel,
    // but only after the config resolution succeeds.
    await expect(manager.connectWithSources([source])).rejects.toThrow();

    expect(mocks.looksLikeSSHAlias).toHaveBeenCalledWith("mybastion");
    expect(mocks.parseSSHConfig).toHaveBeenCalledWith("mybastion", expect.stringContaining(".ssh/config"));
  });

  it("should let explicit TOML fields override SSH config values", async () => {
    mocks.looksLikeSSHAlias.mockReturnValue(true);
    mocks.parseSSHConfig.mockReturnValue({
      host: "bastion.example.com",
      port: 2222,
      username: "ubuntu",
      privateKey: "/home/user/.ssh/id_rsa",
    });

    const manager = new ConnectorManager();
    const source: SourceConfig = {
      id: "test",
      type: "postgres",
      dsn: "postgres://user:pass@db.internal:5432/mydb",
      ssh_host: "mybastion",
      ssh_user: "override-user",
      ssh_port: 3333,
      ssh_key: "/custom/key",
    };

    // Capture the merged SSH config at tunnel establishment
    const establishSpy = vi.spyOn(SSHTunnel.prototype, "establish");
    try {
      establishSpy.mockRejectedValue(new Error("SSH connection failed (expected in test)"));

      await expect(manager.connectWithSources([source])).rejects.toThrow();

      // Verify parseSSHConfig was still called (alias was resolved)
      expect(mocks.parseSSHConfig).toHaveBeenCalled();

      // Explicit TOML fields win over the resolved SSH config values;
      // the host still comes from the resolved alias.
      expect(establishSpy).toHaveBeenCalledTimes(1);
      const [sshConfig] = establishSpy.mock.calls[0];
      expect(sshConfig).toMatchObject({
        host: "bastion.example.com",
        username: "override-user",
        port: 3333,
        privateKey: "/custom/key",
      });
    } finally {
      establishSpy.mockRestore();
    }
  });

  it("should throw when SSH alias not found and no ssh_user provided", async () => {
    mocks.looksLikeSSHAlias.mockReturnValue(true);
    mocks.parseSSHConfig.mockReturnValue(null);

    const manager = new ConnectorManager();
    const source: SourceConfig = {
      id: "test",
      type: "postgres",
      dsn: "postgres://user:pass@db.internal:5432/mydb",
      ssh_host: "unknown-alias",
    };

    await expect(manager.connectWithSources([source])).rejects.toThrow(
      "SSH tunnel requires ssh_user (or a matching Host entry in ~/.ssh/config with User)"
    );
  });

  it("should throw when no auth method available after SSH config resolution", async () => {
    mocks.looksLikeSSHAlias.mockReturnValue(true);
    mocks.parseSSHConfig.mockReturnValue({
      host: "bastion.example.com",
      username: "ubuntu",
      // No privateKey, no password
    });

    const manager = new ConnectorManager();
    const source: SourceConfig = {
      id: "test",
      type: "postgres",
      dsn: "postgres://user:pass@db.internal:5432/mydb",
      ssh_host: "mybastion",
    };

    await expect(manager.connectWithSources([source])).rejects.toThrow(
      "SSH tunnel requires either ssh_password or ssh_key (or a matching Host entry in ~/.ssh/config with IdentityFile)"
    );
  });

  it("should skip SSH config resolution for direct hostnames", async () => {
    mocks.looksLikeSSHAlias.mockReturnValue(false);

    const manager = new ConnectorManager();
    const source: SourceConfig = {
      id: "test",
      type: "postgres",
      dsn: "postgres://user:pass@db.internal:5432/mydb",
      ssh_host: "bastion.example.com",
      ssh_user: "myuser",
      ssh_key: "/home/user/.ssh/id_rsa",
    };

    // Will fail at tunnel establishment, not at config resolution
    await expect(manager.connectWithSources([source])).rejects.toThrow();

    expect(mocks.looksLikeSSHAlias).toHaveBeenCalledWith("bastion.example.com");
    expect(mocks.parseSSHConfig).not.toHaveBeenCalled();
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

    const dsn = await (manager as any).buildConnectionDSN(source);

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
