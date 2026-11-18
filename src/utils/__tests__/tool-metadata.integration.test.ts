import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ConnectorManager } from "../../connectors/manager.js";
import { setupManagerWithFixture, FIXTURES, loadFixtureConfig } from "../../__fixtures__/helpers.js";
import {
  getExecuteSqlMetadata,
  getExplainSqlMetadata,
  getHealthCheckMetadata,
  getSearchObjectsMetadata,
} from "../tool-metadata.js";
import { initializeToolRegistry } from "../../tools/registry.js";

// Import SQLite connector to ensure it's registered
import "../../connectors/sqlite/index.js";

describe("tool-metadata description propagation", () => {
  let manager: ConnectorManager;

  beforeAll(async () => {
    // readonly-maxrows fixture has three sources:
    //   readonly_limited: description = "Read-only database for safe queries", readonly + max_rows
    //   writable_limited: no description, writable + max_rows
    //   writable_unlimited: no description, writable + no limits
    manager = await setupManagerWithFixture(FIXTURES.READONLY_MAXROWS);
    const { sources, tools } = loadFixtureConfig(FIXTURES.READONLY_MAXROWS);
    initializeToolRegistry({ sources, tools: tools || [] });
  }, 30000);

  afterAll(async () => {
    if (manager) {
      await manager.disconnect();
    }
  });

  describe.each([
    // [tool, metadata builder, how its technical template opens]
    ["execute_sql", getExecuteSqlMetadata, "Execute SQL queries on the"],
    ["search_objects", getSearchObjectsMetadata, "Search and list database objects on the"],
    ["explain_sql", getExplainSqlMetadata, "Show the execution plan for a SQL statement on the"],
    ["health_check", getHealthCheckMetadata, "Report connection pool and buffer cache health metrics for the"],
  ])("%s", (_tool, getMetadata, template) => {
    // The technical template names the source and its type
    const templateFor = (sourceId: string) => `${template} '${sourceId}' sqlite database`;

    it("prepends user description from source config when present", () => {
      // User description comes first, technical template follows
      expect(
        getMetadata("readonly_limited").description.startsWith(
          `Read-only database for safe queries. ${templateFor("readonly_limited")}`
        )
      ).toBe(true);
    });

    it("omits the prefix entirely when source has no description", () => {
      // No extra prefix — description starts with the template
      expect(getMetadata("writable_limited").description.startsWith(templateFor("writable_limited"))).toBe(true);
    });
  });

  it("notes read-only mode in the execute_sql description", () => {
    expect(getExecuteSqlMetadata("readonly_limited").description).toContain("[READ-ONLY MODE]");
    expect(getExecuteSqlMetadata("writable_limited").description).not.toContain("[READ-ONLY MODE]");
  });
});
