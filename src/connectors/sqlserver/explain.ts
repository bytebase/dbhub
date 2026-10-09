import sql from "mssql";
import { ExecuteOptions, SQLResult } from "../interface.js";
import { stripCommentsAndStrings } from "../../utils/sql-parser.js";
import { assertNoReadOnlyEscapes, bindParameters } from "./request-helpers.js";

/**
 * EXPLAIN emulation for SQL Server, which has no native EXPLAIN statement.
 *
 * `EXPLAIN <stmt>` maps to SET SHOWPLAN_XML (compiles without executing, so it
 * is read-only safe); `EXPLAIN ANALYZE <stmt>` keeps Postgres semantics and
 * maps to SET STATISTICS XML (the statement really runs, rolled back in
 * read-only mode). Both session toggles are run on a dedicated
 * single-connection pool so they can never leak onto the shared pool. The
 * connector's executeSQL (index.ts) detects the leading EXPLAIN and dispatches
 * here via parseExplainPrefix.
 */

/** Boolean spellings PostgreSQL accepts for an EXPLAIN option. */
const EXPLAIN_ON = /^(?:true|on|1)$/i;
const EXPLAIN_OFF = /^(?:false|off|0)$/i;

/**
 * One option inside `EXPLAIN (...)`: a name, then optionally a value written
 * either space-separated as PostgreSQL spells it (`ANALYZE false`) or with an
 * equals sign, which the read-only classifier also accepts (`ANALYZE = 0`).
 */
const EXPLAIN_OPTION = /^([A-Za-z_]+)(?:(?:\s*=\s*|\s+)(\S+))?$/;

/** A disabling boolean directly after a bare `EXPLAIN ANALYZE`. */
const EXPLAIN_BARE_DISABLED = /^(?:=\s*)?(?:false|off|0)\b/i;

/**
 * Return the estimated execution plan for a query using SHOWPLAN_XML.
 *
 * SHOWPLAN_XML compiles the statement and returns its plan without executing
 * it, but it has two constraints: `SET SHOWPLAN_XML ON` must be the only
 * statement in its batch, and the setting is session scoped. The shared pool
 * hands out a fresh connection per request() and an open transaction
 * suppresses SHOWPLAN, so neither can carry the setting to a follow-up query.
 *
 * We therefore run the SET / query pair on a short-lived, single-connection
 * pool built from the same config. The dedicated session keeps SHOWPLAN state
 * off the shared pool, so a concurrent query can never land on a connection
 * with SHOWPLAN enabled (which would return a plan instead of its results).
 */
export async function explainQuery(
  config: sql.config,
  innerQuery: string,
  readonly?: boolean,
  parameters?: any[]
): Promise<SQLResult> {
  // Validate against comment/string-stripped SQL so comment-only input counts
  // as empty and a SET SHOWPLAN can't hide behind comments.
  const cleaned = stripCommentsAndStrings(innerQuery, "sqlserver").trim();
  if (!cleaned) {
    throw new Error("EXPLAIN requires a statement to analyze");
  }

  // EXPLAIN is routed here before the read-only branch in executeSQL (index.ts), so it
  // opens no rolling-back transaction. SHOWPLAN_XML compiles without
  // executing, but that single session toggle would otherwise be the whole
  // guarantee — apply the same escape checks as executeReadOnly. Skipped
  // outside read-only mode, where explaining an EXEC is legitimate.
  if (readonly) {
    assertNoReadOnlyEscapes(innerQuery);
  }

  // Defense in depth: the SET SHOWPLAN session toggle is what makes EXPLAIN
  // non-executing, so the explained statement must not disable it. SQL Server
  // already rejects `SET SHOWPLAN_* OFF` alongside other statements in a
  // batch, but enforcing it here keeps the read-only guarantee self-contained.
  if (/\bset\s+showplan/i.test(cleaned)) {
    throw new Error("EXPLAIN does not support SET SHOWPLAN statements");
  }

  const explainPool = new sql.ConnectionPool({
    ...config,
    pool: { ...config.pool, max: 1, min: 1 },
  });

  try {
    await explainPool.connect();
    // max:1 + sequential awaits guarantee both batches hit the same session.
    await explainPool.request().batch("SET SHOWPLAN_XML ON");

    // The parameters belong on the statement being explained, not on the
    // toggle. node-mssql turns them into DECLARE/SET, which SHOWPLAN compiles
    // without executing — so the plan is the one for a parameterized query,
    // estimated from density rather than from the literal values.
    const planRequest = explainPool.request();
    bindParameters(planRequest, parameters);
    const planResult = await planRequest.batch(innerQuery);

    // The plan is returned as the single column of the first row.
    const planRow = planResult.recordset?.[0];
    const planXml = planRow ? Object.values(planRow)[0] : null;
    return {
      resultSets: [
        {
          rows: planXml != null ? [{ plan: planXml }] : [],
          rowCount: planXml != null ? 1 : 0,
        },
      ],
    };
  } catch (error) {
    throw new Error(`Failed to explain query: ${(error as Error).message}`);
  } finally {
    await explainPool.close();
  }
}

/**
 * Splits the modifiers between EXPLAIN and its statement, covering the same
 * forms the read-only classifier recognises (see utils/allowed-keywords.ts):
 * `ANALYZE`, `ANALYZE VERBOSE`, `(ANALYZE)`, `(ANALYZE, BUFFERS)`,
 * `(ANALYZE false)`.
 *
 * Only ANALYZE carries a meaning here — it selects STATISTICS XML over
 * SHOWPLAN_XML. The rest are PostgreSQL planner knobs with no SQL Server
 * counterpart, so they are refused by name: silently dropping an option would
 * quietly hand back something other than what was asked for.
 */
export function parseExplainPrefix(afterExplain: string): { analyze: boolean; query: string } {
  // Parenthesized list: (ANALYZE, ...) <statement>
  if (afterExplain.startsWith("(")) {
    const close = afterExplain.indexOf(")");
    if (close < 0) {
      throw new Error("EXPLAIN option list is missing its closing ')'");
    }

    let analyze = false;
    for (const part of afterExplain.slice(1, close).split(",")) {
      const token = part.trim();
      if (!token) continue;

      const parsed = EXPLAIN_OPTION.exec(token);
      if (!parsed) {
        throw new Error(
          `EXPLAIN option '${token}' is not supported on SQL Server — only ANALYZE is.`
        );
      }

      const name = parsed[1];
      if (!/^analyze$/i.test(name)) {
        throw new Error(
          `EXPLAIN option '${name}' is not supported on SQL Server — only ANALYZE is.`
        );
      }

      const value = parsed[2];
      if (value === undefined || EXPLAIN_ON.test(value)) {
        analyze = true;
      } else if (EXPLAIN_OFF.test(value)) {
        analyze = false;
      } else {
        throw new Error(`EXPLAIN option 'ANALYZE' expects a boolean, got '${value}'.`);
      }
    }

    return { analyze, query: afterExplain.slice(close + 1).trim() };
  }

  // Bare form: [ANALYZE [VERBOSE]] <statement>
  const analyzeKeyword = /^analyze\b/i.exec(afterExplain);
  if (!analyzeKeyword) {
    return { analyze: false, query: afterExplain };
  }

  const rest = afterExplain.slice(analyzeKeyword[0].length).trim();

  // PostgreSQL only takes a boolean in the parenthesized form, but the
  // read-only classifier reads a disabling value here too — `ANALYZE false`,
  // `ANALYZE = 0` — as a plain EXPLAIN. Left unhandled, the two layers
  // disagree in the dangerous direction: the classifier waives the DML check
  // for what it believes is a non-executing statement, while this path routes
  // to the one that executes.
  const disabled = EXPLAIN_BARE_DISABLED.exec(rest);
  if (disabled) {
    return { analyze: false, query: rest.slice(disabled[0].length).trim() };
  }

  const trailing = /^([A-Za-z_]+)\b/.exec(rest);
  if (trailing && /^verbose$/i.test(trailing[1])) {
    throw new Error(
      "EXPLAIN option 'VERBOSE' is not supported on SQL Server — only ANALYZE is."
    );
  }

  return { analyze: true, query: rest };
}

/**
 * Run a statement under SET STATISTICS XML and return its *actual* execution
 * plan — the Postgres `EXPLAIN ANALYZE` contract.
 *
 * SHOWPLAN_XML (plain EXPLAIN) compiles without executing, so its plan carries
 * only estimates. STATISTICS XML runs the statement, so the plan reports real
 * row counts and execution counts. The flip side is that this path is *not*
 * inherently read-only the way explainQuery is, so under `options.readonly` the
 * statement runs inside a transaction that always rolls back.
 *
 * The dedicated single-connection pool serves the same purpose as in
 * explainQuery: the STATISTICS XML session toggle must never leak onto a
 * shared pool connection, where a concurrent query would inherit it.
 */
export async function explainAnalyzeQuery(
  config: sql.config,
  innerQuery: string,
  options: ExecuteOptions,
  parameters?: any[]
): Promise<SQLResult> {
  // Validate against comment/string-stripped SQL so comment-only input counts
  // as empty and a SET STATISTICS can't hide behind comments.
  const cleaned = stripCommentsAndStrings(innerQuery, "sqlserver").trim();
  if (!cleaned) {
    throw new Error("EXPLAIN ANALYZE requires a statement to analyze");
  }

  // Defense in depth: the SET STATISTICS XML toggle is what yields the plan,
  // so the analyzed statement must not disable it or swap in SHOWPLAN — the
  // latter would suppress execution, and the actual counts with it.
  if (/\bset\s+statistics\b/i.test(cleaned)) {
    throw new Error("EXPLAIN ANALYZE does not support SET STATISTICS statements");
  }
  if (/\bset\s+showplan\b/i.test(cleaned)) {
    throw new Error("EXPLAIN ANALYZE does not support SET SHOWPLAN statements");
  }

  // Unlike plain EXPLAIN, this path executes, and its only read-only guard is
  // the application-level rollback below — so the escapes matter more here,
  // not less. transactionControl is set because that rollback is a real
  // transaction a COMMIT could close, which is not true of explainQuery.
  if (options.readonly) {
    assertNoReadOnlyEscapes(innerQuery, { transactionControl: true });
  }

  const explainPool = new sql.ConnectionPool({
    ...config,
    pool: { ...config.pool, max: 1, min: 1 },
  });

  try {
    await explainPool.connect();
    // max:1 + sequential awaits guarantee every batch hits the same session.
    await explainPool.request().batch("SET STATISTICS XML ON");

    let planResult: sql.IResult<any>;
    if (options.readonly) {
      planResult = await batchRolledBack(
        explainPool,
        innerQuery,
        parameters
      );
    } else {
      const planRequest = explainPool.request();
      bindParameters(planRequest, parameters);
      planResult = await planRequest.batch(innerQuery);
    }

    const planXml = extractPlanXml(planResult);
    return {
      resultSets: [
        {
          rows: planXml != null ? [{ plan: planXml }] : [],
          rowCount: planXml != null ? 1 : 0,
        },
      ],
    };
  } catch (error) {
    // Named apart from the plain EXPLAIN path: this one ran the statement, so
    // a failure here can mean the statement itself failed mid-execution.
    throw new Error(`Failed to explain analyze query: ${(error as Error).message}`);
  } finally {
    await explainPool.close();
  }
}

/**
 * Run a batch inside a transaction that is always rolled back, so EXPLAIN
 * ANALYZE can report a real plan without letting the statement's writes stick.
 */
async function batchRolledBack(
  pool: sql.ConnectionPool,
  innerQuery: string,
  parameters?: any[]
): Promise<sql.IResult<any>> {
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  let queryFailed = false;
  try {
    const request = new sql.Request(transaction);
    bindParameters(request, parameters);
    return await request.batch(innerQuery);
  } catch (error) {
    queryFailed = true;
    throw error;
  } finally {
    try {
      await transaction.rollback();
    } catch (rollbackError) {
      // A failed query already aborted the transaction, so a rollback error
      // there is expected noise. After a *successful* query it means the
      // writes may still be live — that must surface.
      if (!queryFailed) {
        throw new Error(
          `Read-only rollback failed — data may have been modified: ${(rollbackError as Error).message}`
        );
      }
    }
  }
}

/**
 * Pull the ShowPlanXML document out of a STATISTICS XML result.
 *
 * STATISTICS XML interleaves each statement's plan with that statement's own
 * result sets, so the plan sits at no fixed index — and `recordset` (singular)
 * would hand back the statement's data instead. Scan from the end for the
 * first single-column row holding a plan document.
 */
function extractPlanXml(result: sql.IResult<any>): string | null {
  const recordsets = (result.recordsets ?? []) as unknown as any[][];

  for (let i = recordsets.length - 1; i >= 0; i--) {
    const firstRow = recordsets[i]?.[0];
    if (!firstRow) continue;

    const values = Object.values(firstRow);
    if (values.length !== 1) continue;

    const value = values[0];
    if (typeof value === "string" && value.includes("<ShowPlanXML")) {
      return value;
    }
  }

  return null;
}
