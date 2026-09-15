import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorManager } from "../manager.js";
import { ConnectorRegistry } from "../interface.js";
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

describe("ConnectorManager IAM refresh recovery", () => {
  const AWS_IAM_TOKEN_REFRESH_MS = 14 * 60 * 1000;

  function makeIamSource(): SourceConfig {
    return {
      id: "mysql_iam",
      type: "mysql",
      dsn: "mysql://dbuser:ignored@mydb.abc123.eu-west-1.rds.amazonaws.com:3306/mydb",
      aws_iam_auth: true,
      aws_region: "eu-west-1",
    };
  }

  function stubConnectorRegistry() {
    const instances: Array<{ connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
    const prototype = {
      id: "mysql",
      clone: () => {
        const instance = {
          id: "mysql",
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

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("should recover a source whose IAM refresh failed once credentials are valid again", async () => {
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

  it("should stop re-arming the refresh timer for a source that is no longer connected", async () => {
    stubConnectorRegistry();
    mocks.generateRdsAuthToken.mockResolvedValueOnce("token-1");

    const manager = new ConnectorManager();
    await manager.connectWithSources([makeIamSource()]);

    mocks.generateRdsAuthToken.mockRejectedValueOnce(new Error("SSO session expired"));
    await vi.advanceTimersByTimeAsync(AWS_IAM_TOKEN_REFRESH_MS);
    expect(mocks.generateRdsAuthToken).toHaveBeenCalledTimes(2);

    // The timer must not be re-armed for a source that is no longer connected. (The
    // previous implementation re-armed here and then returned at the guard on every
    // later tick, so the token call count alone cannot tell the two apart.)
    expect(vi.getTimerCount()).toBe(0);

    // No further ticks: reconnection is driven by the next tool call.
    await vi.advanceTimersByTimeAsync(AWS_IAM_TOKEN_REFRESH_MS * 3);
    expect(mocks.generateRdsAuthToken).toHaveBeenCalledTimes(2);

    await manager.disconnect();
  });

  it("should close the SSH tunnel when the database connection fails so a retry does not leak it", async () => {
    const instances = stubConnectorRegistry();
    mocks.looksLikeSSHAlias.mockReturnValue(false);
    const establishSpy = vi
      .spyOn(SSHTunnel.prototype, "establish")
      .mockResolvedValue({ localPort: 55555, targetHost: "db.internal", targetPort: 5432 });
    const closeSpy = vi.spyOn(SSHTunnel.prototype, "close").mockResolvedValue(undefined);
    const prototype = ConnectorRegistry.getConnectorForDSN("postgres://x") as any;
    const originalClone = prototype.clone;
    prototype.clone = () => {
      const instance = originalClone();
      instance.connect.mockRejectedValue(new Error("password authentication failed"));
      return instance;
    };

    const manager = new ConnectorManager();
    const source: SourceConfig = {
      id: "pg_ssh",
      type: "postgres",
      dsn: "postgres://user:pass@db.internal:5432/mydb",
      ssh_host: "bastion.example.com",
      ssh_user: "ubuntu",
      ssh_password: "secret",
      lazy: true,
    };
    await manager.connectWithSources([source]);

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

  it("should not list a source as available when it can neither serve nor reconnect", () => {
    const manager = new ConnectorManager();
    (manager as any).sourceIds = ["alive", "dead"];
    (manager as any).connectors.set("alive", {});

    expect(() => manager.getConnector("dead")).toThrow(
      /^Source 'dead' not found\. Available sources: alive$/
    );
  });
});
