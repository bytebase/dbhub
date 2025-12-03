import type { SourceConfig } from "../types/config.js";

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
  // If DSN is provided, parse it
  if (source.dsn) {
    try {
      const url = new URL(source.dsn);
      const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
      const database = url.pathname.replace(/^\//, "") || "";
      return { host, database };
    } catch {
      return { host: "unknown", database: "" };
    }
  }

  // Otherwise use individual connection params
  const host = source.host
    ? source.port
      ? `${source.host}:${source.port}`
      : source.host
    : "localhost";
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
    ...sources.map((s) => {
      const hostDb = s.database ? `${s.host}/${s.database}` : s.host;
      return hostDb.length;
    })
  );
  const modeWidth = 10;

  // Total width: 2 for borders + content + 2 spaces padding per column + 2 separators
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
      source.database ? `${source.host}/${source.database}` : source.host,
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
