import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * The Claude Code plugin (plugin/) is source-distributed — marketplaces read
 * it straight from git, so no build step can stamp versions or copy shared
 * assets the way scripts/build-mcpb.mjs does for the MCPB bundle. These tests
 * enforce by CI what stamping enforces by construction.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readJson(relPath: string): any {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relPath), "utf-8"));
}

function tomlBody(relPath: string): string {
  return fs
    .readFileSync(path.join(repoRoot, relPath), "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .join("\n");
}

describe("Claude Code plugin consistency", () => {
  const pkg = readJson("package.json");
  const manifest = readJson("plugin/.claude-plugin/plugin.json");
  const mcp = readJson("plugin/.mcp.json");

  it("plugin version matches package.json", () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it(".mcp.json pins the npm package at the plugin version", () => {
    expect(mcp.mcpServers.dbhub.args).toContain(`@bytebase/dbhub@${pkg.version}`);
  });

  it("plugin dbhub.toml policy matches the MCPB bundle's", () => {
    expect(tomlBody("plugin/dbhub.toml")).toBe(tomlBody("mcpb/dbhub.toml"));
  });

  it("DSN prompt text matches the MCPB manifest's", () => {
    const mcpbManifest = readJson("mcpb/manifest.json");
    expect(manifest.userConfig.dsn.description).toBe(mcpbManifest.user_config.dsn.description);
  });
});
