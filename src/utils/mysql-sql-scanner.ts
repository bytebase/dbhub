export type MySQLExecutableTokenKind =
  | "identifier"
  | "quoted_identifier"
  | "number"
  | "string"
  | "placeholder"
  | "symbol";

export type MySQLExecutableTokenSource = "sql" | "executable_comment";

export interface MySQLExecutableToken {
  readonly kind: MySQLExecutableTokenKind;
  readonly text: string;
  readonly normalizedValue?: string;
  readonly sourceSpan: { readonly start: number; readonly end: number };
  readonly depth: number;
  readonly source: MySQLExecutableTokenSource;
  readonly quotedIdentifier: boolean;
  readonly parameterOrdinal?: number;
}

export interface MySQLStatementPlan {
  readonly statementIndex: number;
  readonly sourceSpan: { readonly start: number; readonly end: number };
  readonly executionKind: "executable" | "comment_only";
  readonly executableTokens: readonly MySQLExecutableToken[];
  readonly parameterStart: number;
  readonly parameterEnd: number;
  readonly driverParameterOrdinals: readonly number[];
  readonly executableParameterOrdinals: readonly number[];
}

export type MySQLStatementPlanErrorCategory =
  | "statement_plan_unsupported"
  | "statement_plan_invariant_failed";

export class MySQLStatementPlanError extends Error {
  readonly category: MySQLStatementPlanErrorCategory;

  constructor(category: MySQLStatementPlanErrorCategory) {
    super("MySQL statement plan could not be constructed safely.");
    this.name = "MySQLStatementPlanError";
    this.category = category;
  }
}

interface RawSegment {
  statementIndex: number;
  start: number;
  end: number;
}

interface ScanContext {
  sql: string;
  driverOrdinalByOffset: Map<number, number>;
}

export interface MySQLStatementPlannerOptions {
  /**
   * mysql2 custom queryFormat callbacks can redefine placeholder consumption,
   * so the default SqlString-format plan is no longer authoritative.
   */
  hasCustomQueryFormat?: boolean;
}

function unsupported(): never {
  throw new MySQLStatementPlanError("statement_plan_unsupported");
}

function invariantFailed(): never {
  throw new MySQLStatementPlanError("statement_plan_invariant_failed");
}

function isMySQLDashCommentStart(sql: string, offset: number): boolean {
  if (sql[offset] !== "-" || sql[offset + 1] !== "-") {
    return false;
  }
  const next = sql[offset + 2];
  return next === undefined || next.charCodeAt(0) <= 0x20 || next.charCodeAt(0) === 0x7f;
}

function scanLineCommentEnd(sql: string, offset: number): number {
  let cursor = offset;
  while (cursor < sql.length && sql[cursor] !== "\n" && sql[cursor] !== "\r") {
    cursor++;
  }
  return cursor;
}

function scanBlockCommentEnd(sql: string, offset: number): number {
  const close = sql.indexOf("*/", offset + 2);
  if (close === -1) {
    unsupported();
  }
  return close + 2;
}

function scanQuotedEnd(sql: string, offset: number, quote: "'" | "\"" | "`"): number {
  let cursor = offset + 1;
  while (cursor < sql.length) {
    if (quote !== "`" && sql[cursor] === "\\") {
      if (cursor + 1 >= sql.length) {
        unsupported();
      }
      cursor += 2;
      continue;
    }
    if (sql[cursor] === quote && sql[cursor + 1] === quote) {
      cursor += 2;
      continue;
    }
    if (sql[cursor] === quote) {
      return cursor + 1;
    }
    cursor++;
  }
  unsupported();
}

function splitRawSegments(sql: string): RawSegment[] {
  const segments: RawSegment[] = [];
  let segmentStart = 0;
  let statementIndex = 0;
  let cursor = 0;

  while (cursor < sql.length) {
    const char = sql[cursor];
    if (char === "'" || char === "\"" || char === "`") {
      cursor = scanQuotedEnd(sql, cursor, char);
      continue;
    }
    if (isMySQLDashCommentStart(sql, cursor) || char === "#") {
      cursor = scanLineCommentEnd(sql, cursor);
      continue;
    }
    if (char === "/" && sql[cursor + 1] === "*") {
      cursor = scanBlockCommentEnd(sql, cursor);
      continue;
    }
    if (char === ";") {
      segments.push({ statementIndex, start: segmentStart, end: cursor });
      statementIndex++;
      segmentStart = cursor + 1;
    }
    cursor++;
  }

  segments.push({ statementIndex, start: segmentStart, end: sql.length });
  return segments;
}

function collectDriverOrdinals(sql: string): Map<number, number> {
  const ordinalByOffset = new Map<number, number>();
  let ordinal = 0;
  let cursor = 0;

  while (cursor < sql.length) {
    if (sql[cursor] !== "?") {
      cursor++;
      continue;
    }
    let end = cursor + 1;
    while (sql[end] === "?") {
      end++;
    }
    const length = end - cursor;
    if (length > 2) {
      unsupported();
    }
    ordinalByOffset.set(cursor, ordinal);
    ordinal++;
    cursor = end;
  }

  return ordinalByOffset;
}

function isIdentifierStart(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    char === "_" ||
    char === "$" ||
    code >= 0x80
  );
}

function isIdentifierPart(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return isIdentifierStart(char) || (code >= 48 && code <= 57);
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

function normalizeQuotedIdentifier(text: string): string {
  return text.slice(1, -1).replace(/``/g, "`").toUpperCase();
}

function pushToken(
  tokens: MySQLExecutableToken[],
  kind: MySQLExecutableTokenKind,
  sql: string,
  start: number,
  end: number,
  depth: number,
  source: MySQLExecutableTokenSource,
  parameterOrdinal?: number
): void {
  const text = sql.slice(start, end);
  const quotedIdentifier = kind === "quoted_identifier";
  tokens.push({
    kind,
    text,
    ...(kind === "identifier"
      ? { normalizedValue: text.toUpperCase() }
      : quotedIdentifier
        ? { normalizedValue: normalizeQuotedIdentifier(text) }
        : {}),
    sourceSpan: { start, end },
    depth,
    source,
    quotedIdentifier,
    ...(parameterOrdinal === undefined ? {} : { parameterOrdinal }),
  });
}

function scanExecutableRange(
  context: ScanContext,
  start: number,
  end: number,
  source: MySQLExecutableTokenSource,
  initialDepth = 0
): MySQLExecutableToken[] {
  const { sql, driverOrdinalByOffset } = context;
  const tokens: MySQLExecutableToken[] = [];
  let depth = initialDepth;
  let cursor = start;

  while (cursor < end) {
    const char = sql[cursor];
    if (/\s/u.test(char)) {
      cursor++;
      continue;
    }
    if (isMySQLDashCommentStart(sql, cursor) || char === "#") {
      cursor = Math.min(scanLineCommentEnd(sql, cursor), end);
      continue;
    }
    if (char === "/" && sql[cursor + 1] === "*") {
      const commentEnd = scanBlockCommentEnd(sql, cursor);
      if (commentEnd > end) {
        unsupported();
      }
      const isExecutable = sql[cursor + 2] === "!";
      const isMariaDB = sql[cursor + 2] === "M" && sql[cursor + 3] === "!";
      if (isExecutable && !isMariaDB) {
        let bodyStart = cursor + 3;
        while (isDigit(sql[bodyStart])) {
          bodyStart++;
        }
        tokens.push(
          ...scanExecutableRange(
            context,
            bodyStart,
            commentEnd - 2,
            "executable_comment",
            depth
          )
        );
      }
      cursor = commentEnd;
      continue;
    }
    if (char === "'" || char === "\"") {
      const tokenEnd = scanQuotedEnd(sql, cursor, char);
      if (tokenEnd > end) unsupported();
      pushToken(tokens, "string", sql, cursor, tokenEnd, depth, source);
      cursor = tokenEnd;
      continue;
    }
    if (char === "`") {
      const tokenEnd = scanQuotedEnd(sql, cursor, "`");
      if (tokenEnd > end) unsupported();
      pushToken(tokens, "quoted_identifier", sql, cursor, tokenEnd, depth, source);
      cursor = tokenEnd;
      continue;
    }
    if (char === "?") {
      const ordinal = driverOrdinalByOffset.get(cursor);
      if (ordinal === undefined) invariantFailed();
      const tokenEnd = sql[cursor + 1] === "?" ? cursor + 2 : cursor + 1;
      pushToken(tokens, "placeholder", sql, cursor, tokenEnd, depth, source, ordinal);
      cursor = tokenEnd;
      continue;
    }
    if (char === ":" && isIdentifierStart(sql[cursor + 1])) {
      unsupported();
    }
    if (isIdentifierStart(char)) {
      let tokenEnd = cursor + 1;
      while (tokenEnd < end && isIdentifierPart(sql[tokenEnd])) {
        tokenEnd++;
      }
      pushToken(tokens, "identifier", sql, cursor, tokenEnd, depth, source);
      cursor = tokenEnd;
      continue;
    }
    if (isDigit(char)) {
      let tokenEnd = cursor + 1;
      while (
        tokenEnd < end &&
        (isIdentifierPart(sql[tokenEnd]) || sql[tokenEnd] === ".")
      ) {
        tokenEnd++;
      }
      pushToken(tokens, "number", sql, cursor, tokenEnd, depth, source);
      cursor = tokenEnd;
      continue;
    }
    if (char === "(") {
      pushToken(tokens, "symbol", sql, cursor, cursor + 1, depth, source);
      depth++;
      cursor++;
      continue;
    }
    if (char === ")") {
      depth--;
      if (depth < initialDepth) {
        unsupported();
      }
      pushToken(tokens, "symbol", sql, cursor, cursor + 1, depth, source);
      cursor++;
      continue;
    }
    pushToken(tokens, "symbol", sql, cursor, cursor + 1, depth, source);
    cursor++;
  }

  if (depth !== initialDepth) {
    unsupported();
  }
  return tokens;
}

export function validateMySQLStatementPlans(
  plans: readonly MySQLStatementPlan[],
  parameterCount: number,
  sqlLength?: number
): void {
  if (
    !Number.isInteger(parameterCount) ||
    parameterCount < 0 ||
    (sqlLength !== undefined && (!Number.isInteger(sqlLength) || sqlLength < 0))
  ) {
    invariantFailed();
  }

  let previousStatementIndex = -1;
  let previousSpanEnd = 0;
  let expectedParameterStart = 0;

  for (const plan of plans) {
    if (
      !Number.isInteger(plan.statementIndex) ||
      plan.statementIndex < 0 ||
      plan.statementIndex <= previousStatementIndex ||
      !Number.isInteger(plan.sourceSpan.start) ||
      !Number.isInteger(plan.sourceSpan.end) ||
      plan.sourceSpan.start < 0 ||
      plan.sourceSpan.start < previousSpanEnd ||
      plan.sourceSpan.start > plan.sourceSpan.end ||
      (sqlLength !== undefined && plan.sourceSpan.end > sqlLength) ||
      (plan.executionKind !== "executable" && plan.executionKind !== "comment_only") ||
      !Number.isInteger(plan.parameterStart) ||
      !Number.isInteger(plan.parameterEnd) ||
      plan.parameterStart !== expectedParameterStart ||
      plan.parameterEnd < plan.parameterStart
    ) {
      invariantFailed();
    }
    if (
      plan.driverParameterOrdinals.length !== plan.parameterEnd - plan.parameterStart ||
      plan.driverParameterOrdinals.some(
        (ordinal, index) => ordinal !== plan.parameterStart + index
      )
    ) {
      invariantFailed();
    }
    const driverOrdinals = new Set(plan.driverParameterOrdinals);
    const tokenParameterOrdinals: number[] = [];
    let previousTokenEnd = plan.sourceSpan.start;
    for (const token of plan.executableTokens) {
      if (
        !Number.isInteger(token.sourceSpan.start) ||
        !Number.isInteger(token.sourceSpan.end) ||
        token.sourceSpan.start < previousTokenEnd ||
        token.sourceSpan.start >= token.sourceSpan.end ||
        token.sourceSpan.start < plan.sourceSpan.start ||
        token.sourceSpan.end > plan.sourceSpan.end ||
        !Number.isInteger(token.depth) ||
        token.depth < 0 ||
        (token.source !== "sql" && token.source !== "executable_comment") ||
        token.quotedIdentifier !== (token.kind === "quoted_identifier")
      ) {
        invariantFailed();
      }
      if (token.kind === "placeholder") {
        const parameterOrdinal = token.parameterOrdinal;
        if (
          parameterOrdinal === undefined ||
          !Number.isInteger(parameterOrdinal) ||
          !driverOrdinals.has(parameterOrdinal)
        ) {
          invariantFailed();
        }
        tokenParameterOrdinals.push(parameterOrdinal);
      } else if (token.parameterOrdinal !== undefined) {
        invariantFailed();
      }
      previousTokenEnd = token.sourceSpan.end;
    }
    if (
      plan.executableParameterOrdinals.some((ordinal) => !driverOrdinals.has(ordinal)) ||
      plan.executableParameterOrdinals.length !== tokenParameterOrdinals.length ||
      plan.executableParameterOrdinals.some(
        (ordinal, index) => ordinal !== tokenParameterOrdinals[index]
      ) ||
      (plan.executionKind === "comment_only" &&
        (plan.executableTokens.length > 0 || plan.executableParameterOrdinals.length > 0)) ||
      (plan.executionKind === "executable" && plan.executableTokens.length === 0)
    ) {
      invariantFailed();
    }
    previousStatementIndex = plan.statementIndex;
    previousSpanEnd = plan.sourceSpan.end;
    expectedParameterStart = plan.parameterEnd;
  }

  if (expectedParameterStart !== parameterCount) {
    invariantFailed();
  }
}

function freezeStatementPlan(plan: MySQLStatementPlan): MySQLStatementPlan {
  for (const token of plan.executableTokens) {
    Object.freeze(token.sourceSpan);
    Object.freeze(token);
  }
  Object.freeze(plan.sourceSpan);
  Object.freeze(plan.executableTokens);
  Object.freeze(plan.driverParameterOrdinals);
  Object.freeze(plan.executableParameterOrdinals);
  return Object.freeze(plan);
}

export function planMySQLStatements(
  sql: string,
  parameters: readonly unknown[] = [],
  options: MySQLStatementPlannerOptions = {}
): readonly MySQLStatementPlan[] {
  if (options.hasCustomQueryFormat === true) {
    unsupported();
  }
  const rawSegments = splitRawSegments(sql);
  const driverOrdinalByOffset = collectDriverOrdinals(sql);
  if (driverOrdinalByOffset.size !== parameters.length) {
    unsupported();
  }

  const context: ScanContext = { sql, driverOrdinalByOffset };
  const plans: MySQLStatementPlan[] = [];
  let parameterCursor = 0;

  for (const segment of rawSegments) {
    const raw = sql.slice(segment.start, segment.end);
    if (raw.trim().length === 0) {
      continue;
    }

    const driverParameterOrdinals = [...driverOrdinalByOffset.entries()]
      .filter(([offset]) => offset >= segment.start && offset < segment.end)
      .map(([, ordinal]) => ordinal);
    const executableTokens = scanExecutableRange(
      context,
      segment.start,
      segment.end,
      "sql"
    );
    const executableParameterOrdinals = executableTokens.flatMap((token) =>
      token.kind === "placeholder" && token.parameterOrdinal !== undefined
        ? [token.parameterOrdinal]
        : []
    );
    const executionKind = executableTokens.length > 0 ? "executable" : "comment_only";
    const parameterStart = parameterCursor;
    const parameterEnd = parameterStart + driverParameterOrdinals.length;

    plans.push(freezeStatementPlan({
      statementIndex: segment.statementIndex,
      sourceSpan: { start: segment.start, end: segment.end },
      executionKind,
      executableTokens: executionKind === "executable" ? executableTokens : [],
      parameterStart,
      parameterEnd,
      driverParameterOrdinals,
      executableParameterOrdinals:
        executionKind === "executable" ? executableParameterOrdinals : [],
    }));
    parameterCursor = parameterEnd;
  }

  validateMySQLStatementPlans(plans, parameters.length, sql.length);
  return Object.freeze(plans);
}

export function buildExecutableMySQLBatch(
  sql: string,
  parameters: readonly unknown[],
  plans: readonly MySQLStatementPlan[]
): { sql: string; parameters: unknown[] } {
  const executablePlans = plans.filter((plan) => plan.executionKind === "executable");
  return {
    sql: executablePlans
      .map((plan) => sql.slice(plan.sourceSpan.start, plan.sourceSpan.end))
      .join("; "),
    parameters: executablePlans.flatMap((plan) =>
      parameters.slice(plan.parameterStart, plan.parameterEnd)
    ),
  };
}
