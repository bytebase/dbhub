import type { ExplainStmt, Node, ParseResult, SqlError } from "libpg-query";
import type { StatementClass } from "./sql-access-policy.js";
import { splitSQLStatements } from "./sql-parser.js";

// Loaded at import so that classification can stay synchronous. A failure is
// kept and raised the first time PostgreSQL SQL is parsed: it must not become
// an SQL verdict, and it must not stop a server that has no PostgreSQL source.
let parser: typeof import("libpg-query") | undefined;
let parserLoadError: unknown;
try {
  const loaded = await import("libpg-query");
  await loaded.loadModule();
  parser = loaded;
} catch (error) {
  parserLoadError = error;
}

function loadedParser(): typeof import("libpg-query") {
  if (!parser) {
    const reason =
      parserLoadError instanceof Error ? parserLoadError.message : String(parserLoadError);
    throw new Error(`The PostgreSQL SQL parser (libpg-query) failed to load: ${reason}`, {
      cause: parserLoadError,
    });
  }
  return parser;
}

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

/** The parse of `sql`, or the parser's own error when it cannot read it. */
function parseOrError(sql: string): { parsed: ParseResult } | { error: SqlError } {
  const pg = loadedParser();
  try {
    return { parsed: pg.parseSync(sql) };
  } catch (error) {
    if (error instanceof pg.SqlError) return { error };
    throw error;
  }
}

export function parsePostgresSQL(sql: string): ParseResult | null {
  if (!sql.trim()) return null;
  const outcome = parseOrError(sql);
  return "parsed" in outcome ? outcome.parsed : null;
}

/**
 * Why the parser cannot read `sql` as the connector will run it, or null when
 * it can: the parser's message for the whole text (with the 1-based character
 * position PostgreSQL itself would report), else for the first piece
 * splitSQLStatements produces that it cannot read.
 */
export function postgresSyntaxError(sql: string): string | null {
  if (!sql.trim()) return null;
  const whole = parseOrError(sql);
  if ("error" in whole) {
    const position = whole.error.sqlDetails?.cursorPosition ?? 0;
    return position > 0 ? `${whole.error.message} (position ${position + 1})` : whole.error.message;
  }
  for (const piece of splitSQLStatements(sql, "postgres")) {
    const outcome = parseOrError(piece);
    if ("error" in outcome) return outcome.error.message;
  }
  return null;
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

function isRestrictedName(name: Node | undefined): boolean {
  return !!name && "String" in name && restrictedFunctions.has(name.String.sval ?? "");
}

/**
 * Whether the node calls a restricted function, in either notation PostgreSQL
 * accepts: `name(args)`, or `(arg).name` for a function of one argument, which
 * the parser reads as a field selection rather than a call.
 */
function callsRestrictedFunction(node: Node): boolean {
  if ("FuncCall" in node) return isRestrictedName(node.FuncCall.funcname?.slice(-1)[0]);
  if ("A_Indirection" in node) return !!node.A_Indirection.indirection?.some(isRestrictedName);
  return false;
}

// Walk expression containers, but classify nested statements as statements.
// Literals and identifiers never become keywords or executable SQL here.
// `restrictFunctions` is off only for the row limiter, which asks what the
// statement is rather than whether a read-only tool may run it.
function classifyChildren(value: unknown, restrictFunctions: boolean): StatementClass {
  if (!value || typeof value !== "object") return "read";
  if (Array.isArray(value))
    return value.reduce<StatementClass>(
      (result, child) => strictest(result, classifyChildren(child, restrictFunctions)),
      "read"
    );
  const object = value as Record<string, unknown>;
  const node = value as Node;
  if (restrictFunctions && callsRestrictedFunction(node)) return "admin";
  if (Object.keys(object).some((key) => key.endsWith("Stmt") && key[0] === key[0].toUpperCase()))
    return classifyNode(node, restrictFunctions);
  return Object.values(object).reduce<StatementClass>(
    (result, child) => strictest(result, classifyChildren(child, restrictFunctions)),
    "read"
  );
}

function classifyNode(node: Node, restrictFunctions = true): StatementClass {
  if ("ExplainStmt" in node) {
    return explainExecutes(node.ExplainStmt)
      ? node.ExplainStmt.query
        ? classifyNode(node.ExplainStmt.query, restrictFunctions)
        : "unknown"
      : "read";
  }
  if ("SelectStmt" in node) {
    const { larg, rarg, ...select } = node.SelectStmt;
    let result = strictest(
      select.intoClause ? "ddl" : "read",
      classifyChildren(select, restrictFunctions)
    );
    // Set-operation branches are unwrapped SelectStmt objects in PostgreSQL's AST.
    for (const branch of [larg, rarg]) {
      if (branch) result = strictest(result, classifyNode({ SelectStmt: branch }, restrictFunctions));
    }
    return result;
  }
  if ("VariableShowStmt" in node) return "read";
  if ("InsertStmt" in node || "UpdateStmt" in node || "DeleteStmt" in node || "MergeStmt" in node) {
    return strictest("dml", classifyChildren(Object.values(node), restrictFunctions));
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

/**
 * Whether `sql` is one row-returning query whose rows a LIMIT can cap: a
 * SELECT (VALUES and TABLE included) that writes nothing, so neither SELECT
 * INTO nor a data-modifying CTE. This is about the statement's shape, not
 * about what a read-only tool allows: a restricted function call does not make
 * a SELECT any less row-returning. Null when the parser cannot read the text.
 */
export function isPostgresSelect(sql: string): boolean | null {
  if (!sql.trim()) return false;
  const outcome = parseOrError(sql);
  if ("error" in outcome) return null;
  const { stmts } = outcome.parsed;
  const node = stmts?.length === 1 ? stmts[0].stmt : undefined;
  return !!node && "SelectStmt" in node && classifyNode(node, false) === "read";
}

/** Validate the exact EXPLAIN text that the tool will send to PostgreSQL. */
export function validatePostgresExplain(sql: string): string | null {
  const input = parsePostgresSQL(sql);
  if (input?.stmts?.some((raw) => raw.stmt && "ExplainStmt" in raw.stmt)) {
    return "explain_sql input must not itself start with EXPLAIN";
  }
  const explain = `EXPLAIN ${sql}`;
  const outcome = parseOrError(explain);
  if ("error" in outcome) {
    return `explain_sql requires valid PostgreSQL EXPLAIN syntax: ${outcome.error.message}`;
  }
  const { parsed } = outcome;
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
