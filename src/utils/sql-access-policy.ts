/**
 * SQL access policy: the single pipeline behind every read-only decision.
 *
 * Two stages:
 *   1. Classification (mechanical, no config): every statement gets a
 *      StatementClass, derived from the same dialect-aware rules as
 *      isReadOnlySQL.
 *   2. Policy (configured): a map from class to verdict. Today the only
 *      author of a policy is the per-tool `readonly` boolean, compiled via
 *      policyFromReadonly(); the verdict set is designed to grow a
 *      "confirm" member without changing any call site.
 *
 * Everything user-visible — the execution gate, tool annotations
 * (readOnlyHint/destructiveHint), and the engine-level read-only backstop —
 * derives from this module instead of re-interpreting the boolean.
 */

import { ConnectorType } from "../connectors/interface.js";
import {
  isReadOnlySQL,
  hasEscapeHatchFunction,
  sqlServerDynamicSqlPattern,
} from "./allowed-keywords.js";
import { splitSQLStatements, stripCommentsAndStrings } from "./sql-parser.js";

/**
 * Statement classes, in increasing order of privilege:
 * - read: allowed by the read-only classifier (select/with/explain/show/...)
 * - dml: data modification (insert/update/delete/merge, REPLACE INTO)
 * - ddl: schema modification (create/alter/drop/truncate/rename)
 * - admin: privilege changes plus privilege-gated and server-side-effect
 *   escape hatches (grant/revoke; T-SQL EXEC/sp_executesql/xp_cmdshell and
 *   OPENQUERY & co.; MySQL/MariaDB LOAD_FILE and the GET_LOCK family;
 *   PostgreSQL pg_read_file & co.)
 * - unknown: not classifiable (vacuum, set, call, ...) — ranked above the
 *   named classes because an unclassifiable statement must be treated at
 *   least as cautiously as any known one
 */
export type StatementClass = "read" | "dml" | "ddl" | "admin" | "unknown";

/** Verdict for a class. "confirm" is the designed extension point. */
export type AccessVerdict = "allow" | "deny";

export type AccessPolicy = Record<StatementClass, AccessVerdict>;

const CLASS_SEVERITY: Record<StatementClass, number> = {
  read: 0,
  dml: 1,
  ddl: 2,
  admin: 3,
  unknown: 4,
};

const ddlPattern = /\b(?:create|alter|drop|truncate|rename)\b/i;
const dmlPattern = /\b(?:insert|update|delete|merge|replace\s+(?:(?:low_priority|delayed)\s+)?into)\b/i;
const grantRevokePattern = /\b(?:grant|revoke)\b/i;

function isAdminStatement(stripped: string, connectorType: ConnectorType): boolean {
  if (grantRevokePattern.test(stripped)) return true;
  // Call-position escape-hatch functions (SQL Server OPENQUERY & co., the
  // MySQL/MariaDB file/lock functions, PostgreSQL filesystem reads).
  if (hasEscapeHatchFunction(stripped, connectorType)) return true;
  // SQL Server dynamic-SQL primitives are statement-leading forms (not
  // call-position), so they need their own whole-word pattern.
  return connectorType === "sqlserver" && sqlServerDynamicSqlPattern.test(stripped);
}

/**
 * Compile the per-tool `readonly` boolean into a policy. This is the only
 * policy author today; richer authoring (per-class verdicts) can be added
 * without touching any consumer.
 */
export function policyFromReadonly(readonly: boolean | undefined): AccessPolicy {
  const write: AccessVerdict = readonly === true ? "deny" : "allow";
  return { read: "allow", dml: write, ddl: write, admin: write, unknown: write };
}

/** True when the policy permits nothing beyond read statements. */
export function isReadOnlyPolicy(policy: AccessPolicy): boolean {
  return (
    policy.dml === "deny" &&
    policy.ddl === "deny" &&
    policy.admin === "deny" &&
    policy.unknown === "deny"
  );
}

/**
 * Classify a single SQL statement. Reuses isReadOnlySQL for the read/non-read
 * boundary (the dialect-sensitive part), then names the non-read class from
 * the first matching keyword family.
 */
export function classifyStatement(sql: string, connectorType: ConnectorType): StatementClass {
  if (isReadOnlySQL(sql, connectorType)) {
    return "read";
  }
  const stripped = stripCommentsAndStrings(sql, connectorType);
  if (isAdminStatement(stripped, connectorType)) return "admin";
  if (ddlPattern.test(stripped)) return "ddl";
  if (dmlPattern.test(stripped)) return "dml";
  return "unknown";
}

/**
 * Classify a possibly multi-statement SQL string: the most privileged class
 * among its statements wins.
 */
export function classifySQL(sql: string, connectorType: ConnectorType): StatementClass {
  let strictest: StatementClass = "read";
  for (const statement of splitSQLStatements(sql, connectorType)) {
    const cls = classifyStatement(statement, connectorType);
    if (CLASS_SEVERITY[cls] > CLASS_SEVERITY[strictest]) {
      strictest = cls;
    }
  }
  return strictest;
}

/** The policy's verdict for a (possibly multi-statement) SQL string. */
export function sqlVerdict(
  policy: AccessPolicy,
  sql: string,
  connectorType: ConnectorType
): AccessVerdict {
  return policy[classifySQL(sql, connectorType)];
}
