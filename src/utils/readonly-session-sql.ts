import type { ConnectorType } from "../connectors/interface.js";
import { splitSQLStatements, stripCommentsAndStrings } from "./sql-parser.js";

/**
 * Per-source `readonly_session_sql`: session-setting statements re-run at the start of
 * every read-only execution, inside the read-only transaction the connector
 * already opens (START TRANSACTION READ ONLY).
 *
 * The pooled connection may be shared with writable tools on the same source,
 * which can change session settings, so re-running these statements per
 * execution puts the configured values back before every read-only statement.
 *
 * Only the dialect's session-setting form is accepted, so this field cannot
 * become a general SQL execution path. The check runs on comment- and
 * literal-stripped text: a quoted keyword or a leading comment cannot disguise
 * another statement. MySQL/MariaDB executable comments (`/*! ... *\/`) are kept
 * by the stripper, so their contents are checked too.
 */

/**
 * Accepted statement shape per dialect. Values are not inspected beyond the
 * assignment operator: string literals are blanked by the stripper, and the
 * server rejects a malformed value on the first execution.
 */
const sessionStatementPatterns: Partial<Record<ConnectorType, RegExp>> = {
  // One assignment per statement: a comma list could mix in another scope
  // (`SET SESSION a = 1, GLOBAL b = 2`). Commas inside string values are
  // blanked by the stripper, so `sql_mode = 'A,B'` still passes.
  mysql: /^SET\s+SESSION\s+([a-z_][a-z0-9_]*)\s*=[^,]*$/i,
  mariadb: /^SET\s+SESSION\s+([a-z_][a-z0-9_]*)\s*=[^,]*$/i,
};

/** Human-readable form of each pattern, for error messages. */
const sessionStatementForms: Partial<Record<ConnectorType, string>> = {
  mysql: "SET SESSION name = value",
  mariadb: "SET SESSION name = value",
};

/**
 * Settings that control the transaction the statements run in, rejected so a
 * source-level setting cannot undo tool-level `readonly = true` or break the
 * pooled connection: the read-only switches, and on MySQL/MariaDB `autocommit`
 * and `completion_type`, which change how the closing COMMIT behaves and stay
 * on the connection for whichever execution draws it next.
 */
const transactionControlSettings: Partial<Record<ConnectorType, readonly string[]>> = {
  mysql: ["transaction_read_only", "tx_read_only", "autocommit", "completion_type"],
  mariadb: ["transaction_read_only", "tx_read_only", "autocommit", "completion_type"],
};

/** Dialects that support `readonly_session_sql`. */
export const READONLY_SESSION_SQL_DIALECTS: readonly ConnectorType[] = Object.keys(
  sessionStatementPatterns
) as ConnectorType[];

/**
 * Split and validate a `readonly_session_sql` value.
 *
 * @returns The statements to run, in order, as written in the config.
 * @throws If the dialect is unsupported, or a statement is not the dialect's
 *   session-setting form or names a transaction-control setting.
 */
export function parseReadonlySessionSQL(sql: string, dialect: ConnectorType): string[] {
  const pattern = sessionStatementPatterns[dialect];
  if (!pattern) {
    throw new Error(
      `readonly_session_sql is not supported for ${dialect} sources ` +
        `(supported: ${READONLY_SESSION_SQL_DIALECTS.join(", ")}).`
    );
  }

  const statements = splitSQLStatements(sql, dialect);
  if (statements.length === 0) {
    throw new Error("readonly_session_sql is empty.");
  }

  for (const statement of statements) {
    const cleaned = stripCommentsAndStrings(statement, dialect).trim();
    const match = pattern.exec(cleaned);
    // A SET value can be a subquery on MySQL/MariaDB (`SET SESSION x = (SELECT ...)`);
    // reject it so the field stays limited to plain assignments.
    if (!match || /\bselect\b/i.test(cleaned)) {
      throw new Error(
        `readonly_session_sql only accepts statements of the form '${sessionStatementForms[dialect]}' for ${dialect}; ` +
          `got: ${statement}`
      );
    }
    const name = match[1].toLowerCase();
    if (transactionControlSettings[dialect]?.includes(name)) {
      throw new Error(
        `readonly_session_sql cannot set '${name}': it controls the transaction ` +
          `the statements run in.`
      );
    }
  }

  return statements;
}
