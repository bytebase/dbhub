import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Order of the PostgreSQL `options` startup string.
 *
 * The server applies `-c name=value` options left to right, so a later option
 * overrides an earlier one. Connection-level readonly (`ConnectorConfig.readonly`)
 * must therefore be appended after `[sources.session]`, or a conflicting
 * `default_transaction_read_only = false` in the session table would switch the
 * enforced read-only default back off.
 */

const pgPoolCtor = vi.fn();

vi.mock("pg", () => ({
  default: {
    Pool: function (this: any, ...args: any[]) {
      return pgPoolCtor(...args);
    },
    types: { builtins: {}, getTypeParser: () => (value: string) => value },
  },
}));

const { PostgresConnector } = await import("../postgres/index.js");

function fakePool() {
  return {
    on: vi.fn(),
    connect: vi.fn(async () => ({
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      release: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
    })),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

/** `-c name=value` options in the order they were sent, with the leading space trimmed. */
function sentOptions(): string[] {
  expect(pgPoolCtor).toHaveBeenCalledTimes(1);
  const options: string = pgPoolCtor.mock.calls[0][0].options ?? "";
  return options.trim().split(/ (?=-c )/);
}

describe("PostgreSQL startup options order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pgPoolCtor.mockImplementation(() => fakePool());
  });

  it("appends the enforced readonly option after the session settings", async () => {
    const connector = new PostgresConnector();
    await connector.connect("postgres://u:p@localhost:5432/db", undefined, {
      readonly: true,
      searchPath: "app",
      sessionSettings: { default_transaction_read_only: false, lock_timeout: "5s" },
    });

    expect(sentOptions()).toEqual([
      '-c search_path="app"',
      "-c default_transaction_read_only=off",
      "-c lock_timeout=5s",
      "-c default_transaction_read_only=on",
    ]);
  });

  it("sends only the session settings when readonly is not enforced", async () => {
    const connector = new PostgresConnector();
    await connector.connect("postgres://u:p@localhost:5432/db", undefined, {
      sessionSettings: { lock_timeout: "5s" },
    });

    expect(sentOptions()).toEqual(["-c lock_timeout=5s"]);
  });
});
