import type { SourceConfig } from "../types/config.js";
import { parseConnectionInfoFromDSN, getDefaultPortForType } from "./dsn-obfuscate.js";

/**
 * Information about a source and its tools for display
 */
export interface SourceDisplayInfo {
  id: string;
  type: string;
  host: string;
  database: string;
  readonly: boolean;
  isDemo: boolean;
  tools: string[];
}

/**
 * Unicode box drawing characters
 */
const BOX = {
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  horizontal: "─",
  vertical: "│",
  leftT: "├",
  rightT: "┤",
  bullet: "•",
};

/**
 * Parse host and database from source config
 */
function parseHostAndDatabase(source: SourceConfig): { host: string; database: string } {
  // If DSN is provided, use the proper DSN parser
  if (source.dsn) {
    const parsed = parseConnectionInfoFromDSN(source.dsn);
    if (parsed) {
      // For SQLite, there's no host - just show the database path
      if (parsed.type === "sqlite") {
        return { host: "", database: parsed.database || ":memory:" };
      }
      // For other databases, construct host:port string
      if (!parsed.host) {
        return { host: "", database: parsed.database || "" };
      }
      const port = parsed.port ?? getDefaultPortForType(parsed.type!);
      const host = port ? `${parsed.host}:${port}` : parsed.host;
      return { host, database: parsed.database || "" };
    }
    return { host: "unknown", database: "" };
  }

  // Otherwise use individual connection params
  const host = source.host
    ? source.port
      ? `${source.host}:${source.port}`
      : source.host
    : "";
  const database = source.database || "";

  return { host, database };
}

/**
 * Generate a horizontal line of specified width
 */
function horizontalLine(width: number, left: string, right: string): string {
  return left + BOX.horizontal.repeat(width - 2) + right;
}

/**
 * Pad or truncate a string to fit a specific width
 */
function fitString(str: string, width: number): string {
  if (str.length > width) {
    return str.slice(0, width - 1) + "…";
  }
  return str.padEnd(width);
}

/**
 * Format host and database into a single string
 */
export function formatHostDatabase(host: string, database: string): string {
  return host
    ? database ? `${host}/${database}` : host
    : database || "";
}

/**
 * Generate the startup table showing sources and their tools
 */
export function generateStartupTable(sources: SourceDisplayInfo[]): string {
  if (sources.length === 0) {
    return "";
  }

  // Calculate column widths based on content
  const idTypeWidth = Math.max(
    20,
    ...sources.map((s) => `${s.id} (${s.type})`.length)
  );
  const hostDbWidth = Math.max(
    24,
    ...sources.map((s) => formatHostDatabase(s.host, s.database).length)
  );
  const modeWidth = Math.max(
    10,
    ...sources.map((s) => {
      const modes: string[] = [];
      if (s.isDemo) modes.push("DEMO");
      if (s.readonly) modes.push("READ-ONLY");
      return modes.join(" ").length;
    })
  );

  // Total width: left border (1) + space + idTypeWidth + space + separator (1) + space + hostDbWidth + space + separator (1) + space + modeWidth + space + right border (1)
  // = idTypeWidth + hostDbWidth + modeWidth + 10
  const totalWidth = 2 + idTypeWidth + 3 + hostDbWidth + 3 + modeWidth + 2;

  const lines: string[] = [];

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const isFirst = i === 0;
    const isLast = i === sources.length - 1;

    // Top border (only for first source)
    if (isFirst) {
      lines.push(horizontalLine(totalWidth, BOX.topLeft, BOX.topRight));
    }

    // Source header row
    const idType = fitString(`${source.id} (${source.type})`, idTypeWidth);
    const hostDb = fitString(
      formatHostDatabase(source.host, source.database),
      hostDbWidth
    );

    // Mode indicators
    const modes: string[] = [];
    if (source.isDemo) modes.push("DEMO");
    if (source.readonly) modes.push("READ-ONLY");
    const modeStr = fitString(modes.join(" "), modeWidth);

    lines.push(
      `${BOX.vertical} ${idType} ${BOX.vertical} ${hostDb} ${BOX.vertical} ${modeStr} ${BOX.vertical}`
    );

    // Separator after header
    lines.push(horizontalLine(totalWidth, BOX.leftT, BOX.rightT));

    // Tool rows
    for (const tool of source.tools) {
      const toolLine = `  ${BOX.bullet} ${tool}`;
      lines.push(
        `${BOX.vertical} ${fitString(toolLine, totalWidth - 4)} ${BOX.vertical}`
      );
    }

    // Bottom border or separator
    if (isLast) {
      lines.push(horizontalLine(totalWidth, BOX.bottomLeft, BOX.bottomRight));
    } else {
      lines.push(horizontalLine(totalWidth, BOX.leftT, BOX.rightT));
    }
  }

  return lines.join("\n");
}

/**
 * Build SourceDisplayInfo from source configs and tool names
 */
export function buildSourceDisplayInfo(
  sourceConfigs: SourceConfig[],
  getToolsForSource: (sourceId: string) => string[],
  isDemo: boolean
): SourceDisplayInfo[] {
  return sourceConfigs.map((source) => {
    const { host, database } = parseHostAndDatabase(source);

    return {
      id: source.id,
      type: source.type || "sqlite",
      host,
      database,
      readonly: source.readonly || false,
      isDemo,
      tools: getToolsForSource(source.id),
    };
  });
}
