import { describe, expect, it } from "vitest";
import {
  areRedisCommandsReadOnly,
  parseRedisCommand,
  parseRedisStatements,
  splitRedisStatements,
} from "../redis-command-parser.js";

describe("redis command parser", () => {
  it("splits commands on semicolons and newlines outside quotes", () => {
    expect(splitRedisStatements('SET key "a;b"\nGET key; HGETALL hash')).toEqual([
      'SET key "a;b"',
      "GET key",
      "HGETALL hash",
    ]);
  });

  it("parses quoted arguments and escapes", () => {
    expect(parseRedisCommand('SET greeting "hello world"')).toEqual([
      "SET",
      "greeting",
      "hello world",
    ]);
    expect(parseRedisCommand("SET path foo\\ bar")).toEqual(["SET", "path", "foo bar"]);
  });

  it("parses multiple statements into argument arrays", () => {
    expect(parseRedisStatements("GET a\nMGET a b")).toEqual([
      ["GET", "a"],
      ["MGET", "a", "b"],
    ]);
  });

  it("detects readonly Redis command batches", () => {
    expect(areRedisCommandsReadOnly("GET a\nHGETALL user:1")).toBe(true);
    expect(areRedisCommandsReadOnly("GET a\nSET a b")).toBe(false);
    expect(areRedisCommandsReadOnly("GETDEL a")).toBe(false);
  });

  it("throws on unterminated quotes", () => {
    expect(() => parseRedisCommand('GET "unfinished')).toThrow("Unterminated quoted");
  });
});
