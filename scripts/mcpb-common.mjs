// Shared constants for the MCP Bundle scripts (build-mcpb.mjs, smoke-test-mcpb.mjs).

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const root = join(import.meta.dirname, "..");

export const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

// The bundle version, overridable for CI re-releases
export const bundleVersion = process.env.MCPB_VERSION || rootPkg.version;

// Where build-mcpb.mjs writes the packed bundle and smoke-test-mcpb.mjs reads it
export const mcpbFile = join(root, "dist-mcpb", `dbhub-${bundleVersion}.mcpb`);

// Path to a locally installed package bin (cross-platform)
export function localBin(name) {
  return join(root, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
}
