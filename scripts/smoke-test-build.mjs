#!/usr/bin/env node

// Post-build smoke test: verify that the bundled dist/ output can import
// each connector module without "Dynamic require of X is not supported"
// errors. This catches cases where tsup accidentally bundles CJS driver
// internals into ESM chunks.
//
// Run: node scripts/smoke-test-build.mjs

import { readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const distDir = join(import.meta.dirname, "..", "dist");

// Find connector chunk files (e.g. postgres-B7YSSZMH.js, mysql-I35IQ2GH.js)
const files = await readdir(distDir);
const connectorFiles = files.filter(
  (f) =>
    f.endsWith(".js") &&
    /^(postgres|mysql|mariadb|sqlite|sqlserver|demo-loader)-/.test(f)
);

if (connectorFiles.length === 0) {
  console.error("No connector chunks found in dist/ — was the build run?");
  process.exit(1);
}

let passed = 0;
let failed = 0;

for (const file of connectorFiles) {
  const url = pathToFileURL(join(distDir, file)).href;
  try {
    await import(url);
    console.log(`  OK  ${file}`);
    passed++;
  } catch (err) {
    if (err.message?.includes("Dynamic require")) {
      console.error(`  FAIL  ${file}: ${err.message.split("\n")[0]}`);
      failed++;
    } else if (err.code === "ERR_MODULE_NOT_FOUND") {
      // Driver package not installed — expected in CI/minimal installs
      console.log(`  SKIP  ${file} (driver not installed)`);
      passed++;
    } else {
      // Other errors (e.g. missing config) are fine — we only care about
      // bundling errors that happen at import time
      console.log(`  OK  ${file} (runtime error ignored: ${err.message?.split("\n")[0]})`);
      passed++;
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${connectorFiles.length} total`);
if (failed > 0) {
  process.exit(1);
}
