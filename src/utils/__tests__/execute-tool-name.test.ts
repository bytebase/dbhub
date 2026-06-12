import { describe, expect, it } from "vitest";
import { getExecuteToolPublicName } from "../execute-tool-name.js";

describe("getExecuteToolPublicName", () => {
  it("keeps SQL connectors on execute_sql", () => {
    expect(getExecuteToolPublicName("postgres", "prod-pg", true)).toBe("execute_sql");
    expect(getExecuteToolPublicName("postgres", "prod-pg", false)).toBe("execute_sql_prod_pg");
  });

  it("exposes Redis connectors as execute_redis", () => {
    expect(getExecuteToolPublicName("redis", "cache", true)).toBe("execute_redis");
    expect(getExecuteToolPublicName("redis", "TEST-epoch-universe-store", false)).toBe(
      "execute_redis_TEST_epoch_universe_store"
    );
  });
});
