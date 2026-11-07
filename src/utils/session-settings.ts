/**
 * Per-source session settings (`[sources.session]` in TOML).
 *
 * Each entry is a server setting name and a scalar value, applied once to
 * every new physical connection so it becomes that connection's default:
 * - MySQL: one `SET SESSION a = 1, b = 'x'` statement in the pool's
 *   'connection' hook, queued ahead of the first caller's statement.
 * - PostgreSQL: `-c name=value` startup options, the same path search_path uses.
 *
 * Validation is deliberately minimal. Names must look like identifiers and
 * values must be scalars, so nothing but a value assignment reaches the server;
 * whether a setting exists and accepts the value is left to the server, which
 * rejects it when the connection opens. Settings DBHub already manages through
 * a dedicated option are rejected so the two cannot disagree.
 */

// TOML integers beyond Number.MAX_SAFE_INTEGER are parsed as bigint.
export type SessionSettingValue = string | number | bigint | boolean;
export type SessionSettings = Record<string, SessionSettingValue>;

export type SessionSettingsEngine = "mysql" | "postgres";

const MYSQL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// PostgreSQL also accepts extension settings such as `pg_stat_statements.track`.
const POSTGRES_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/** Settings DBHub sets itself, keyed by lower-cased name, with the option to use instead. */
const MANAGED_SETTINGS: Record<SessionSettingsEngine, Record<string, string>> = {
  mysql: {
    max_execution_time: "query_timeout",
  },
  postgres: {
    statement_timeout: "query_timeout",
    search_path: "search_path",
  },
};

/**
 * Check a `[sources.session]` table. Returns an error message describing the
 * first problem found, or undefined when the table is valid.
 */
export function validateSessionSettings(
  settings: unknown,
  engine: SessionSettingsEngine
): string | undefined {
  // Only a plain table will do. The TOML parser returns a Date for a datetime
  // value, which is an object with no enumerable entries and would otherwise
  // pass as an empty table.
  if (
    typeof settings !== "object" ||
    settings === null ||
    Array.isArray(settings) ||
    settings instanceof Date
  ) {
    return "must be a table of setting names and values (e.g. [sources.session] followed by lock_timeout = \"5s\")";
  }

  const namePattern = engine === "mysql" ? MYSQL_NAME : POSTGRES_NAME;
  for (const [name, value] of Object.entries(settings)) {
    if (!namePattern.test(name)) {
      return `has invalid setting name '${name}'. Names must be identifiers (letters, digits and underscores${
        engine === "postgres" ? ", optionally prefixed like 'ext.name'" : ""
      }).`;
    }
    const managedBy = MANAGED_SETTINGS[engine][name.toLowerCase()];
    if (managedBy !== undefined) {
      return `sets '${name}', which DBHub manages through the '${managedBy}' source option. Use '${managedBy}' instead.`;
    }
    const isScalar =
      typeof value === "string" ||
      typeof value === "boolean" ||
      typeof value === "bigint" ||
      (typeof value === "number" && Number.isFinite(value));
    if (!isScalar) {
      return `has invalid value for '${name}'. Values must be a string, a number or a boolean.`;
    }
    if (typeof value === "string") {
      // A NUL would end the value early in PostgreSQL's startup packet. On MySQL,
      // whether a backslash escapes depends on the server's NO_BACKSLASH_ESCAPES
      // mode, so a value with one is refused rather than quoted for one mode.
      if (value.includes("\0") || (engine === "mysql" && value.includes("\\"))) {
        return `has invalid value for '${name}'. String values must not contain ${
          engine === "mysql" ? "backslashes or " : ""
        }NUL characters.`;
      }
    }
  }
  return undefined;
}

/**
 * Build the single statement that applies the settings to a MySQL connection,
 * or undefined when there is nothing to apply. Names are validated identifiers;
 * strings are quoted by doubling single quotes, which means the same in every
 * sql_mode because validation refuses backslashes.
 */
export function buildMySQLSessionStatement(settings: SessionSettings): string | undefined {
  const assignments = Object.entries(settings).map(([name, value]) => {
    const literal =
      typeof value === "boolean"
        ? value ? "TRUE" : "FALSE"
        : typeof value === "number" || typeof value === "bigint"
          ? String(value)
          : `'${value.replace(/'/g, "''")}'`;
    return `${name} = ${literal}`;
  });
  return assignments.length > 0 ? `SET SESSION ${assignments.join(", ")}` : undefined;
}

/**
 * Build the `-c name=value` startup options that apply the settings to a
 * PostgreSQL connection (empty string when there is nothing to apply).
 * Backslashes and whitespace are escaped for the server's options parser, which
 * splits on whitespace, so a value cannot add another option.
 */
export function buildPostgresSessionOptions(settings: SessionSettings): string {
  return Object.entries(settings)
    .map(([name, value]) => {
      const text = typeof value === "boolean" ? (value ? "on" : "off") : String(value);
      return ` -c ${name}=${text.replace(/\\/g, "\\\\").replace(/(\s)/g, "\\$1")}`;
    })
    .join("");
}
