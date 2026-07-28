import type { MySQLStatementPlan } from "./mysql-sql-scanner.js";

export type MySQLReadonlyClassification =
  | { allowed: true }
  | {
      allowed: false;
      category: "dangerous_function" | "unsupported_sql_mode";
    };

export const MYSQL_DANGEROUS_READONLY_FUNCTIONS = new Set([
  "SLEEP",
  "BENCHMARK",
  "GET_LOCK",
  "RELEASE_LOCK",
  "RELEASE_ALL_LOCKS",
  "LOAD_FILE",
  "SYS_EXEC",
  "SYS_EVAL",
]);

const UNSUPPORTED_SQL_MODES = new Set(["NO_BACKSLASH_ESCAPES", "ANSI_QUOTES"]);

export function parseMySQLSqlMode(sqlMode: unknown): Set<string> {
  if (typeof sqlMode !== "string") {
    throw new TypeError("sql_mode must be a string");
  }
  return new Set(
    sqlMode
      .split(",")
      .map((mode) => mode.trim().toUpperCase())
      .filter(Boolean)
  );
}

export function classifyMySQLReadonlyQuery(
  plans: readonly MySQLStatementPlan[],
  sqlMode: unknown,
  parameters: readonly unknown[] = []
): MySQLReadonlyClassification {
  const modes = parseMySQLSqlMode(sqlMode);
  for (const mode of UNSUPPORTED_SQL_MODES) {
    if (modes.has(mode)) {
      return { allowed: false, category: "unsupported_sql_mode" };
    }
  }

  for (const plan of plans) {
    for (let index = 0; index < plan.executableTokens.length; index++) {
      const token = plan.executableTokens[index];
      const next = plan.executableTokens[index + 1];
      if (next?.kind !== "symbol" || next.text !== "(") {
        continue;
      }

      const normalizedFunctionName =
        token.kind === "identifier" || token.kind === "quoted_identifier"
          ? token.normalizedValue
          : token.kind === "placeholder" &&
              token.text === "??" &&
              token.parameterOrdinal !== undefined
            ? normalizeTrailingIdentifier(parameters[token.parameterOrdinal])
            : undefined;

      if (
        normalizedFunctionName &&
        MYSQL_DANGEROUS_READONLY_FUNCTIONS.has(normalizedFunctionName)
      ) {
        return { allowed: false, category: "dangerous_function" };
      }
    }
  }

  return { allowed: true };
}

/**
 * mysql2 formats `??` with SqlString.escapeId(). Qualified identifiers are
 * split on dots, arrays are joined with commas, and only the final emitted
 * identifier can be immediately followed by the raw `(` token.
 */
function normalizeTrailingIdentifier(value: unknown): string | undefined {
  let trailing = value;
  while (Array.isArray(trailing)) {
    if (trailing.length === 0) {
      return undefined;
    }
    trailing = trailing[trailing.length - 1];
  }

  const parts = String(trailing).split(".");
  return parts[parts.length - 1]?.toUpperCase();
}
