/**
 * Output format configuration.
 *
 * Supports "json" (default) and "gcf" (Graph Compact Format).
 * GCF encodes structured tool responses with 50-60% fewer tokens
 * while maintaining full LLM comprehension.
 *
 * Configuration priority: --output-format flag > OUTPUT_FORMAT env var > default ("json")
 *
 * When set to "gcf", requires @blackwell-systems/gcf as a dependency.
 * If the package is not installed, falls back to JSON silently.
 */

import { parseCommandLineArgs } from "./env.js";

export type OutputFormat = "json" | "gcf";

let cachedFormat: OutputFormat | null = null;

/**
 * Resolve the output format from CLI args or environment.
 * Result is cached after first resolution.
 */
export function getOutputFormat(): OutputFormat {
  if (cachedFormat !== null) {
    return cachedFormat;
  }

  const args = parseCommandLineArgs();

  // 1. CLI flag (highest priority)
  if (args["output-format"] === "gcf") {
    cachedFormat = "gcf";
    return cachedFormat;
  }

  // 2. Environment variable
  if (process.env.OUTPUT_FORMAT?.toLowerCase() === "gcf") {
    cachedFormat = "gcf";
    return cachedFormat;
  }

  // 3. Default
  cachedFormat = "json";
  return cachedFormat;
}

/**
 * Reset cached format (for testing)
 */
export function resetOutputFormat(): void {
  cachedFormat = null;
}
