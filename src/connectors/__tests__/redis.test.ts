import { beforeEach, describe, expect, it, vi } from "vitest";

const redisMock = vi.hoisted(() => {
  const client = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
    quit: vi.fn(),
    sendCommand: vi.fn(),
  };
  const clusterNodeClientA = {
    sendCommand: vi.fn(),
  };
  const clusterNodeClientB = {
    sendCommand: vi.fn(),
  };
  const cluster = {
    close: vi.fn(),
    connect: vi.fn(),
    destroy: vi.fn(),
    masters: [{ id: "master-a" }, { id: "master-b" }],
    nodeClient: vi.fn(),
    on: vi.fn(),
    sendCommand: vi.fn(),
  };
  const sentinel = {
    close: vi.fn(),
    connect: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn(),
    sendCommand: vi.fn(),
  };
  return {
    client,
    cluster,
    clusterNodeClientA,
    clusterNodeClientB,
    sentinel,
    createClient: vi.fn(() => client),
    createCluster: vi.fn(() => cluster),
    createSentinel: vi.fn(() => sentinel),
  };
});

vi.mock("redis", () => ({
  createClient: redisMock.createClient,
  createCluster: redisMock.createCluster,
  createSentinel: redisMock.createSentinel,
}));

import { RedisConnector } from "../redis/index.js";

describe("RedisConnector", () => {
  let connector: RedisConnector;

  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.createClient.mockReturnValue(redisMock.client);
    redisMock.createCluster.mockReturnValue(redisMock.cluster);
    redisMock.createSentinel.mockReturnValue(redisMock.sentinel);
    redisMock.client.connect.mockResolvedValue(undefined);
    redisMock.client.quit.mockResolvedValue(undefined);
    redisMock.client.sendCommand.mockResolvedValue("OK");
    redisMock.cluster.connect.mockResolvedValue(undefined);
    redisMock.cluster.close.mockResolvedValue(undefined);
    redisMock.cluster.sendCommand.mockResolvedValue("OK");
    redisMock.cluster.nodeClient
      .mockResolvedValueOnce(redisMock.clusterNodeClientA)
      .mockResolvedValueOnce(redisMock.clusterNodeClientB);
    redisMock.clusterNodeClientA.sendCommand.mockResolvedValue(["0", ["user:1"]]);
    redisMock.clusterNodeClientB.sendCommand.mockResolvedValue(["0", ["session:1"]]);
    redisMock.sentinel.connect.mockResolvedValue(undefined);
    redisMock.sentinel.close.mockResolvedValue(undefined);
    redisMock.sentinel.sendCommand.mockResolvedValue("OK");
    connector = new RedisConnector();
  });

  it("parses redis and rediss DSNs", async () => {
    const parser = connector.dsnParser;

    await expect(parser.parse("redis://:secret@localhost:6379/2")).resolves.toMatchObject({
      url: "redis://:secret@localhost:6379",
      database: 2,
    });
    await expect(
      parser.parse("rediss://default:secret@cache.example.com/0")
    ).resolves.toMatchObject({
      url: "rediss://default:secret@cache.example.com:6379",
      database: 0,
    });
  });

  it("connects and selects the configured logical database", async () => {
    await connector.connect("redis://localhost:6380/3");

    expect(redisMock.createClient).toHaveBeenCalledWith({
      url: "redis://localhost:6380",
      socket: { connectTimeout: undefined },
    });
    expect(redisMock.client.connect).toHaveBeenCalled();
    expect(redisMock.client.sendCommand).toHaveBeenCalledWith(["SELECT", "3"]);
  });

  it("executes Redis commands and normalizes scan results", async () => {
    await connector.connect("redis://localhost:6379/0");
    redisMock.client.sendCommand.mockReset();
    redisMock.client.sendCommand
      .mockResolvedValueOnce("OK")
      .mockResolvedValueOnce(["0", ["alpha", "beta"]]);

    const result = await connector.executeSQL('SET alpha "hello world"; SCAN 0');

    expect(result.rowCount).toBe(2);
    expect(result.rows).toEqual([
      {
        command: "SET",
        arguments: ["alpha", "hello world"],
        result: "OK",
      },
      {
        command: "SCAN",
        arguments: ["0"],
        result: { cursor: "0", results: ["alpha", "beta"] },
      },
    ]);
  });

  it("rejects mutating commands in readonly mode", async () => {
    await connector.connect("redis://localhost:6379/0");
    redisMock.client.sendCommand.mockReset();

    await expect(connector.executeSQL("SET alpha beta", { readonly: true })).rejects.toThrow(
      "Read-only mode is enabled"
    );
    expect(redisMock.client.sendCommand).not.toHaveBeenCalled();
  });

  it("lists Redis keys as tables", async () => {
    await connector.connect("redis://localhost:6379/0");
    redisMock.client.sendCommand.mockReset();
    redisMock.client.sendCommand.mockResolvedValueOnce(["0", ["user:1", "session:1"]]);

    await expect(connector.getTables("0")).resolves.toEqual(["user:1", "session:1"]);
    expect(redisMock.client.sendCommand).toHaveBeenCalledWith(["SCAN", "0", "COUNT", "100"]);
  });

  it("uses Redis key cardinality as row count", async () => {
    await connector.connect("redis://localhost:6379/0");
    redisMock.client.sendCommand.mockReset();
    redisMock.client.sendCommand
      .mockResolvedValueOnce("hash")
      .mockResolvedValueOnce(-1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(128);

    await expect(connector.getTableRowCount("user:1", "0")).resolves.toBe(2);
  });

  it("connects to Redis Cluster root nodes", async () => {
    await connector.connect("redis://default:secret@localhost:7000/0", undefined, {
      redisMode: "cluster",
      redisNodes: ["redis://localhost:7000", "localhost:7001"],
      redisUsername: "default",
      redisPassword: "secret",
    });

    expect(redisMock.createCluster).toHaveBeenCalledWith(
      expect.objectContaining({
        rootNodes: [
          { url: "redis://default:secret@localhost:7000" },
          { url: "redis://default:secret@localhost:7001" },
        ],
        defaults: expect.objectContaining({
          username: "default",
          password: "secret",
        }),
      })
    );
    expect(redisMock.cluster.connect).toHaveBeenCalled();
    expect(redisMock.cluster.sendCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      ["SELECT", "0"]
    );
  });

  it("routes Redis Cluster commands with first key and readonly hint", async () => {
    await connector.connect("redis://localhost:7000/0", undefined, {
      redisMode: "cluster",
      redisNodes: ["localhost:7000"],
    });
    redisMock.cluster.sendCommand.mockReset();
    redisMock.cluster.sendCommand.mockResolvedValueOnce("value");

    const result = await connector.executeSQL("GET user:1");

    expect(result.rows[0].result).toBe("value");
    expect(redisMock.cluster.sendCommand).toHaveBeenCalledWith(
      "user:1",
      true,
      ["GET", "user:1"]
    );
  });

  it("rejects non-zero Redis Cluster databases", async () => {
    await expect(
      connector.connect("redis://localhost:7000/2", undefined, {
        redisMode: "cluster",
        redisNodes: ["localhost:7000"],
      })
    ).rejects.toThrow("Redis Cluster only supports logical database 0");
  });

  it("scans Redis Cluster keys across master nodes", async () => {
    await connector.connect("redis://localhost:7000/0", undefined, {
      redisMode: "cluster",
      redisNodes: ["localhost:7000"],
    });

    await expect(connector.getTables("0")).resolves.toEqual(["user:1", "session:1"]);
    expect(redisMock.cluster.nodeClient).toHaveBeenCalledTimes(2);
    expect(redisMock.clusterNodeClientA.sendCommand).toHaveBeenCalledWith([
      "SCAN",
      "0",
      "COUNT",
      "100",
    ]);
    expect(redisMock.clusterNodeClientB.sendCommand).toHaveBeenCalledWith([
      "SCAN",
      "0",
      "COUNT",
      "100",
    ]);
  });

  it("connects to Redis Sentinel and sends commands with readonly hint", async () => {
    await connector.connect("redis://default:secret@localhost:6379/1", undefined, {
      redisMode: "sentinel",
      redisSentinels: ["localhost:26379", "rediss://sentinel.example.com:26380"],
      redisSentinelMaster: "mymaster",
      redisSentinelUsername: "sentinel_user",
      redisSentinelPassword: "sentinel_secret",
      redisUsername: "default",
      redisPassword: "secret",
    });

    expect(redisMock.createSentinel).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "mymaster",
        sentinelRootNodes: [
          { host: "localhost", port: 26379 },
          { host: "sentinel.example.com", port: 26380 },
        ],
        nodeClientOptions: expect.objectContaining({
          username: "default",
          password: "secret",
        }),
        sentinelClientOptions: expect.objectContaining({
          username: "sentinel_user",
          password: "sentinel_secret",
          socket: expect.objectContaining({ tls: true }),
        }),
      })
    );
    expect(redisMock.sentinel.sendCommand).toHaveBeenCalledWith(false, ["SELECT", "1"]);

    redisMock.sentinel.sendCommand.mockReset();
    redisMock.sentinel.sendCommand.mockResolvedValueOnce("pong");
    await connector.executeSQL("PING");

    expect(redisMock.sentinel.sendCommand).toHaveBeenCalledWith(true, ["PING"]);
  });
});
