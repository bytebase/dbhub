// Propagates package.json's version into the files that can't be stamped at
// build/install time: the Claude Code / Codex plugin (source-distributed —
// read straight from git, no build step) and server.json (its own version field
// is what triggers the MCP Registry publish workflow on push).
//
// mcpb/manifest.json is NOT included here — scripts/build-mcpb.mjs stamps it
// from package.json at build time, so it never needs hand-editing.
//
// Usage: node scripts/sync-version.mjs
// Wired as the "version" lifecycle script, so `pnpm version <bump>` runs this
// automatically and includes the results in the same commit.

import fs from "fs";
import path from "path";

const repoRoot = path.join(import.meta.dirname, "..");
const readJson = (relPath) => JSON.parse(fs.readFileSync(path.join(repoRoot, relPath), "utf-8"));

const version = readJson("package.json").version;

function writeJsonIfChanged(relPath, mutate) {
  const filePath = path.join(repoRoot, relPath);
  const original = fs.readFileSync(filePath, "utf-8");
  const data = JSON.parse(original);
  mutate(data);
  // Preserve trailing newline; JSON.stringify with 2-space indent matches
  // this repo's existing JSON formatting.
  const updated = JSON.stringify(data, null, 2) + "\n";
  if (updated !== original) {
    fs.writeFileSync(filePath, updated);
    console.log(`Synced version ${version} into ${relPath}`);
  }
}

// plugin/ is one directory serving two hosts: Claude Code reads
// .claude-plugin/plugin.json + .mcp.json, Codex reads .codex-plugin/plugin.json
// + mcp.codex.json.
for (const manifestPath of ["plugin/.claude-plugin/plugin.json", "plugin/.codex-plugin/plugin.json"]) {
  writeJsonIfChanged(manifestPath, (manifest) => {
    manifest.version = version;
  });
}

for (const mcpPath of ["plugin/.mcp.json", "plugin/mcp.codex.json"]) {
  writeJsonIfChanged(mcpPath, (mcp) => {
    const args = mcp.mcpServers.dbhub.args;
    const i = args.findIndex((a) => a.startsWith("@bytebase/dbhub@"));
    if (i === -1) throw new Error(`${mcpPath}: could not find '@bytebase/dbhub@<version>' in args`);
    args[i] = `@bytebase/dbhub@${version}`;
  });
}

writeJsonIfChanged("server.json", (server) => {
  server.version = version;
  const npmPackage = server.packages.find((pkg) => pkg.identifier === "@bytebase/dbhub");
  if (!npmPackage) throw new Error("server.json: could not find the '@bytebase/dbhub' package entry");
  npmPackage.version = version;
});
