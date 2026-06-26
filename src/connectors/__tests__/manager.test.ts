import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorManager } from "../manager.js";
import type { SourceConfig } from "../../types/config.js";
import { homedir } from "os";
import { join } from "path";

const mocks = vi.hoisted(() => ({
  generateRdsAuthToken: vi.fn(),
  parseSSHConfig: vi.fn(),
  looksLikeSSHAlias: vi.fn(),
  getDefaultSSHConfigPath: vi.fn(() => join(homedir(), '.ssh', 'config')),
  nativeEstablish: vi.fn(),
  ssh2Establish: vi.fn(),
}));

vi.mock("../../utils/aws-rds-signer.js", () => ({
  generateRdsAuthToken: mocks.generateRdsAuthToken,
}));

vi.mock("../../utils/ssh-config-parser.js", () => ({
  parseSSHConfig: mocks.parseSSHConfig,
  looksLikeSSHAlias: mocks.looksLikeSSHAlias,
  getDefaultSSHConfigPath: mocks.getDefaultSSHConfigPath,
  resolveSymlink: vi.fn((p: string) => p),
  parseJumpHosts: vi.fn(),
  parseJumpHost: vi.fn(),
}));

vi.mock("../../utils/native-ssh-tunnel.js", () => ({
  NativeSSHTunnel: class MockNativeSSHTunnel {
    establish(...args: unknown[]) {
      return mocks.nativeEstablish(...args);
    }
    close = vi.fn();
    getMode() {
      return "native" as const;
    }
    getTunnelInfo = vi.fn();
    getIsConnected = vi.fn();
  },
}));

vi.mock("../../utils/ssh-tunnel.js", () => ({
  SSHTunnel: class MockSSHTunnel {
    establish(...args: unknown[]) {
      return mocks.ssh2Establish(...args);
    }
    close = vi.fn();
    getMode() {
      return "ssh2" as const;
    }
    getTunnelInfo = vi.fn();
    getIsConnected = vi.fn();
  },
}));

describe("ConnectorManager SSH tunnel routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.nativeEstablish.mockRejectedValue(new Error('native tunnel failed (expected in test)'));
    mocks.ssh2Establish.mockRejectedValue(new Error('ssh2 tunnel failed (expected in test)'));
  });

  it("should use native SSH when alias is found in SSH config", async () => {
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

    await expect(manager.connectWithSources([source])).rejects.toThrow('native tunnel failed');

    expect(mocks.nativeEstablish).toHaveBeenCalledTimes(1);
    expect(mocks.ssh2Establish).not.toHaveBeenCalled();
    expect(mocks.nativeEstablish).toHaveBeenCalledWith(
      expect.objectContaining({
        hostAlias: "mybastion",
        targetHost: "db.internal",
        targetPort: 5432,
      })
    );
  });

  it("should use ssh2 when ssh_password is set", async () => {
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
      ssh_password: "secret",
      ssh_user: "ubuntu",
    };

    await expect(manager.connectWithSources([source])).rejects.toThrow('ssh2 tunnel failed');

    expect(mocks.ssh2Establish).toHaveBeenCalledTimes(1);
    expect(mocks.nativeEstablish).not.toHaveBeenCalled();
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

    expect(mocks.ssh2Establish).not.toHaveBeenCalled();
    expect(mocks.nativeEstablish).not.toHaveBeenCalled();
  });

  it("should use ssh2 for direct hostnames", async () => {
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

    await expect(manager.connectWithSources([source])).rejects.toThrow('ssh2 tunnel failed');

    expect(mocks.looksLikeSSHAlias).toHaveBeenCalledWith("bastion.example.com");
    expect(mocks.parseSSHConfig).not.toHaveBeenCalled();
    expect(mocks.ssh2Establish).toHaveBeenCalledTimes(1);
    expect(mocks.nativeEstablish).not.toHaveBeenCalled();
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
      dsn: "mysql://dbuser%40example.com:ignored@mydb.abc123.eu-west-1.rds.amazonaws.com:3306/mydb?connectTimeout=5000&sslmode=disable",
    };

    const dsn = await (manager as any).buildConnectionDSN(source);

    expect(mocks.generateRdsAuthToken).toHaveBeenCalledWith({
      hostname: "mydb.abc123.eu-west-1.rds.amazonaws.com",
      port: 3306,
      username: "dbuser@example.com",
      region: "eu-west-1",
    });
    expect(dsn).toContain("mysql://dbuser%40example.com:token%20with%20spaces%2F%2B%3F%3D@");
    expect(dsn).toContain("connectTimeout=5000");
    expect(dsn).toContain("sslmode=require");
    expect(dsn).not.toContain("sslmode=disable");
  });
});
