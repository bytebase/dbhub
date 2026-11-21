import { loadModule, parseSync, SqlError, type Node, type ExplainStmt } from "libpg-query";
import type { StatementClass } from "./sql-access-policy.js";
import { splitSQLStatements } from "./sql-parser.js";

// Keep initialization failures operational: they must not become an SQL verdict.
await loadModule();

const severity: Record<StatementClass, number> = { read: 0, dml: 1, ddl: 2, admin: 3, unknown: 4 };
const restrictedFunctions = new Set([
  "pg_read_file",
  "pg_read_binary_file",
  "pg_ls_dir",
  "set_config",
]);
const ddlNodes = new Set([
  "CreateStmt",
  "CreateTableAsStmt",
  "CreateSchemaStmt",
  "CreateFunctionStmt",
  "CreateSeqStmt",
  "CreateExtensionStmt",
  "CreateTrigStmt",
  "CreateDomainStmt",
  "CreateEnumStmt",
  "CreateRangeStmt",
  "CompositeTypeStmt",
  "IndexStmt",
  "ViewStmt",
  "AlterTableStmt",
  "AlterObjectSchemaStmt",
  "AlterOwnerStmt",
  "AlterFunctionStmt",
  "AlterSeqStmt",
  "AlterEnumStmt",
  "AlterDomainStmt",
  "AlterExtensionStmt",
  "DropStmt",
  "TruncateStmt",
  "RenameStmt",
  "CommentStmt",
]);

export const postgresExplainOptions = new Set([
  "verbose",
  "costs",
  "settings",
  "generic_plan",
  "buffers",
  "serialize",
  "wal",
  "timing",
  "summary",
  "memory",
  "format",
]);

function strictest(a: StatementClass, b: StatementClass): StatementClass {
  return severity[a] >= severity[b] ? a : b;
}

export function parsePostgresSQL(sql: string) {
  if (!sql.trim()) return null;
  try {
    return parseSync(sql);
  } catch (error) {
    if (error instanceof SqlError) return null;
    throw error;
  }
}

function explainExecutes(stmt: ExplainStmt): boolean {
  let analyze = false;
  for (const option of stmt.options ?? []) {
    const def = "DefElem" in option ? option.DefElem : undefined;
    if (!def) return true;
    if (def.defname === "analyze") {
      const value = def.arg;
      analyze =
        value && "String" in value
          ? !["false", "off", "0"].includes(value.String.sval?.toLowerCase() ?? "")
          : value && "Integer" in value
            ? value.Integer.ival !== 0
            : value && "Boolean" in value
              ? value.Boolean.boolval === true
              : true;
    } else if (!postgresExplainOptions.has(def.defname ?? "")) {
      return true;
    }
  }
  return analyze;
}

// Walk expression containers, but classify nested statements as statements.
// Literals and identifiers never become keywords or executable SQL here.
function classifyChildren(value: unknown): StatementClass {
  if (!value || typeof value !== "object") return "read";
  if (Array.isArray(value))
    return value.reduce<StatementClass>(
      (result, child) => strictest(result, classifyChildren(child)),
      "read"
    );
  const object = value as Record<string, unknown>;
  const node = value as Node;
  if ("FuncCall" in node) {
    const last = node.FuncCall.funcname?.slice(-1)[0];
    const name = last && "String" in last ? last.String.sval : undefined;
    if (name && restrictedFunctions.has(name)) return "admin";
  }
  if (Object.keys(object).some((key) => key.endsWith("Stmt") && key[0] === key[0].toUpperCase()))
    return classifyNode(node);
  return Object.values(object).reduce<StatementClass>(
    (result, child) => strictest(result, classifyChildren(child)),
    "read"
  );
}

function classifyNode(node: Node): StatementClass {
  if ("ExplainStmt" in node) {
    return explainExecutes(node.ExplainStmt)
      ? node.ExplainStmt.query
        ? classifyNode(node.ExplainStmt.query)
        : "unknown"
      : "read";
  }
  if ("SelectStmt" in node) {
    const { larg, rarg, ...select } = node.SelectStmt;
    let result = strictest(select.intoClause ? "ddl" : "read", classifyChildren(select));
    // Set-operation branches are unwrapped SelectStmt objects in PostgreSQL's AST.
    for (const branch of [larg, rarg]) {
      if (branch) result = strictest(result, classifyNode({ SelectStmt: branch }));
    }
    return result;
  }
  if ("VariableShowStmt" in node) return "read";
  if ("InsertStmt" in node || "UpdateStmt" in node || "DeleteStmt" in node || "MergeStmt" in node) {
    return strictest("dml", classifyChildren(Object.values(node)));
  }
  if ("GrantStmt" in node || "GrantRoleStmt" in node) return "admin";
  if (Object.keys(node).some((key) => ddlNodes.has(key))) return "ddl";
  return "unknown";
}

/**
 * The strictest class among the statements the parser reads in `sql`: null
 * when it reads none (a comment), "unknown" when it cannot read the text.
 */
function classifyText(sql: string): StatementClass | null {
  const parsed = parsePostgresSQL(sql);
  if (!parsed) return "unknown";
  if (!parsed.stmts?.length) return null;
  return parsed.stmts.reduce<StatementClass>(
    (result, raw) => strictest(result, raw.stmt ? classifyNode(raw.stmt) : "unknown"),
    "read"
  );
}

/**
 * Classify SQL as the connector will run it. PostgresConnector.executeSQL sends
 * each piece splitSQLStatements produces as its own query, so every piece is
 * classified as well as the whole text: a piece the parser reads differently
 * from the whole (the two disagreeing on where a statement ends) is a
 * statement the whole-text parse never saw. A piece holding no statement runs
 * nothing.
 */
export function classifyPostgresSQL(sql: string): StatementClass {
  const whole = classifyText(sql);
  if (whole === null) return "unknown";
  return splitSQLStatements(sql, "postgres").reduce<StatementClass>(
    (result, piece) => strictest(result, classifyText(piece) ?? "read"),
    whole
  );
}

export function isPostgresSelect(sql: string): boolean {
  const parsed = parsePostgresSQL(sql);
  const node = parsed?.stmts?.length === 1 ? parsed.stmts[0].stmt : undefined;
  return !!node && "SelectStmt" in node && classifyNode(node) === "read";
}

/** Validate the exact EXPLAIN text that the tool will send to PostgreSQL. */
export function validatePostgresExplain(sql: string): string | null {
  const input = parsePostgresSQL(sql);
  if (input?.stmts?.some((raw) => raw.stmt && "ExplainStmt" in raw.stmt)) {
    return "explain_sql input must not itself start with EXPLAIN";
  }
  const explain = `EXPLAIN ${sql}`;
  const parsed = parsePostgresSQL(explain);
  if (!parsed) return "explain_sql requires valid PostgreSQL EXPLAIN syntax";
  // The connector runs each piece splitSQLStatements produces, so it must see
  // the one statement the parser does.
  if (parsed.stmts?.length !== 1 || splitSQLStatements(explain, "postgres").length !== 1) {
    return "explain_sql only supports a single SQL statement";
  }
  const node = parsed.stmts[0].stmt;
  if (!node || !("ExplainStmt" in node)) return "explain_sql requires an EXPLAIN statement";
  for (const option of node.ExplainStmt.options ?? []) {
    const name = "DefElem" in option ? option.DefElem.defname : undefined;
    if (name === "analyze")
      return "explain_sql does not support ANALYZE (it must never execute the statement)";
    if (!name || !postgresExplainOptions.has(name)) {
      return (
        "explain_sql only accepts these EXPLAIN options: " + [...postgresExplainOptions].join(", ")
      );
    }
  }
  return null;
}
