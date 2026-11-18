import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * The Claude Code / Codex plugin (plugin/) is source-distributed — marketplaces read
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

  it("server.json description fits the MCP Registry's 100-character limit", () => {
    // The registry rejects the publish (HTTP 422) when the description is
    // longer than 100 characters, which is only discovered post-merge when
    // the release workflow runs.
    const server = readJson("server.json");
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it("server.json version matches package.json", () => {
    const server = readJson("server.json");
    expect(server.version).toBe(pkg.version);
    const npmPackage = server.packages.find((p: any) => p.identifier === "@bytebase/dbhub");
    expect(npmPackage.version).toBe(pkg.version);
  });

  it("plugin dbhub.toml policy matches the MCPB bundle's", () => {
    expect(tomlBody("plugin/dbhub.toml")).toBe(tomlBody("mcpb/dbhub.toml"));
  });

  it("DSN prompt text matches the MCPB manifest's", () => {
    const mcpbManifest = readJson("mcpb/manifest.json");
    expect(manifest.userConfig.dsn.description).toBe(mcpbManifest.user_config.dsn.description);
  });
});

/**
 * plugin/ also serves Codex: .codex-plugin/plugin.json is its manifest and
 * mcp.codex.json its server definition (Codex has no install-time prompt, so
 * the DSN is forwarded from the DBHUB_DSN environment variable instead).
 */
describe("Codex plugin consistency", () => {
  const pkg = readJson("package.json");
  const claudeManifest = readJson("plugin/.claude-plugin/plugin.json");
  const manifest = readJson("plugin/.codex-plugin/plugin.json");
  const pluginRoot = path.join(repoRoot, "plugin");

  it("plugin version matches package.json", () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it("shares name and description with the Claude Code manifest", () => {
    expect(manifest.name).toBe(claudeManifest.name);
    expect(manifest.description).toBe(claudeManifest.description);
  });

  it("manifest paths resolve inside the plugin", () => {
    for (const relPath of [manifest.skills, manifest.mcpServers, manifest.interface.logo]) {
      expect(relPath.startsWith("./")).toBe(true);
      expect(fs.existsSync(path.join(pluginRoot, relPath))).toBe(true);
    }
  });

  it("MCP server pins the npm package and loads the bundled read-only config", () => {
    const server = readJson(path.join("plugin", manifest.mcpServers)).mcpServers.dbhub;
    expect(server.args).toContain(`@bytebase/dbhub@${pkg.version}`);
    // Relative to cwd, which Codex resolves against the installed plugin root.
    expect(server.cwd).toBe(".");
    const configPath = server.args[server.args.indexOf("--config") + 1];
    expect(fs.existsSync(path.join(pluginRoot, configPath))).toBe(true);
    expect(server.env_vars).toEqual(["DBHUB_DSN"]);
  });

  it("logo matches the MCPB bundle icon", () => {
    const logo = fs.readFileSync(path.join(pluginRoot, manifest.interface.logo));
    expect(logo.equals(fs.readFileSync(path.join(repoRoot, "mcpb/icon.png")))).toBe(true);
  });

  it("version hook stages every file sync-version rewrites", () => {
    // `pnpm version` only commits what the hook `git add`s; a synced file
    // missing here would be left out of the release commit and tag.
    const staged = pkg.scripts.version.split("git add ")[1].split(" ");
    const synced = fs
      .readFileSync(path.join(repoRoot, "scripts/sync-version.mjs"), "utf-8")
      .match(/"(?:plugin\/[^"]+|server)\.json"/g)!
      .map((quoted) => quoted.slice(1, -1));
    expect(synced).toContain("plugin/mcp.codex.json");
    expect([...staged].sort()).toEqual([...new Set(synced)].sort());
  });

  it("Codex and Claude Code marketplaces list the same plugin", () => {
    const codex = readJson(".agents/plugins/marketplace.json");
    const claude = readJson(".claude-plugin/marketplace.json");
    expect(codex.name).toBe(claude.name);
    expect(codex.plugins.map((p: any) => [p.name, p.source.path])).toEqual(
      claude.plugins.map((p: any) => [p.name, p.source])
    );
  });
});
