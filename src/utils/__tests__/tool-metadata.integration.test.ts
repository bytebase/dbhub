import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ConnectorManager } from "../../connectors/manager.js";
import { setupManagerWithFixture, FIXTURES, loadFixtureConfig } from "../../__fixtures__/helpers.js";
import { getExecuteSqlMetadata, getSearchObjectsMetadata } from "../tool-metadata.js";
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

  describe("getExecuteSqlMetadata", () => {
    it("prepends user description from source config when present", () => {
      const metadata = getExecuteSqlMetadata("readonly_limited");

      expect(metadata.description).toContain("Read-only database for safe queries");
      // Original technical context must still be preserved
      expect(metadata.description).toContain("readonly_limited");
      expect(metadata.description).toContain("sqlite");
      expect(metadata.description).toContain("[READ-ONLY MODE]");
      // User description comes first, technical template follows
      expect(metadata.description.indexOf("Read-only database for safe queries")).toBeLessThan(
        metadata.description.indexOf("Execute SQL queries")
      );
    });

    it("omits the prefix entirely when source has no description", () => {
      const metadata = getExecuteSqlMetadata("writable_limited");

      // No extra prefix — description starts with the template
      expect(metadata.description.startsWith("Execute SQL queries")).toBe(true);
      expect(metadata.description).toContain("writable_limited");
      expect(metadata.description).toContain("sqlite");
    });
  });

  describe("getSearchObjectsMetadata", () => {
    it("prepends user description from source config when present", () => {
      const metadata = getSearchObjectsMetadata("readonly_limited");

      expect(metadata.description).toContain("Read-only database for safe queries");
      expect(metadata.description).toContain("readonly_limited");
      expect(metadata.description).toContain("sqlite");
      expect(metadata.description.indexOf("Read-only database for safe queries")).toBeLessThan(
        metadata.description.indexOf("Search and list database objects")
      );
    });

    it("omits the prefix entirely when source has no description", () => {
      const metadata = getSearchObjectsMetadata("writable_unlimited");

      expect(metadata.description.startsWith("Search and list database objects")).toBe(true);
      expect(metadata.description).toContain("writable_unlimited");
      expect(metadata.description).toContain("sqlite");
    });
  });
});
