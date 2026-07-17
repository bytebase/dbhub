import type { ConnectorType } from "../connectors/interface.js";

const TokenType = { Plain: 0, Comment: 1, QuotedBlock: 2 } as const;

interface SQLToken {
  type: number;
  /** Position just past the end of this token (the next unprocessed character) */
  end: number;
}

function plainToken(i: number): SQLToken {
  return { type: TokenType.Plain, end: i + 1 };
}

function scanSingleLineComment(sql: string, i: number): SQLToken | null {
  if (sql[i] !== "-" || sql[i + 1] !== "-") { return null; }
  let j = i;
  while (j < sql.length && sql[j] !== "\n") { j++; }
  return { type: TokenType.Comment, end: j };
}

/**
 * MySQL/MariaDB single-line comment scanner. Unlike ANSI SQL, MySQL and MariaDB
 * only begin a `--` comment when the two dashes are followed by whitespace, a
 * control character, or end of input. Otherwise the dashes are two minus
 * operators and the rest of the line is ordinary SQL (e.g. `SELECT 1--1` is
 * `SELECT 1 - (-1)`). Treating `--x` as a comment here would let a statement
 * hidden after it (`SELECT 1--1;DROP TABLE t`) pass the read-only classifier
 * while the engine still executes the DROP.
 */
function scanSingleLineCommentMySQL(sql: string, i: number): SQLToken | null {
  if (sql[i] !== "-" || sql[i + 1] !== "-") { return null; }
  const next = sql[i + 2];
  // Comment trigger = whitespace, control char, or EOL. MySQL's lexer uses
  // my_isspace() || my_iscntrl(), so besides bytes <= 0x20 this also includes
  // ASCII DEL (0x7F). Anything else means the dashes are minus operators.
  if (next !== undefined && next.charCodeAt(0) > 0x20 && next.charCodeAt(0) !== 0x7f) {
    return null;
  }
  let j = i;
  while (j < sql.length && sql[j] !== "\n") { j++; }
  return { type: TokenType.Comment, end: j };
}

function scanMultiLineComment(sql: string, i: number): SQLToken | null {
  if (sql[i] !== "/" || sql[i + 1] !== "*") { return null; }
  let j = i + 2;
  while (j < sql.length && !(sql[j] === "*" && sql[j + 1] === "/")) { j++; }
  if (j < sql.length) { j += 2; }
  return { type: TokenType.Comment, end: j };
}

/**
 * MySQL/MariaDB-specific multi-line comment scanner that preserves conditional comments.
 * MySQL conditional comments (`/*!nnnnn ... *\/`) and MariaDB-specific comments
 * (`/*M! ... *\/`) are executable. Stripping them would let malicious SQL bypass
 * read-only checks, so we return null to let them pass through as plain text.
 */
function scanMultiLineCommentMySQL(sql: string, i: number): SQLToken | null {
  if (sql[i] !== "/" || sql[i + 1] !== "*") { return null; }
  const next = sql[i + 2];
  const nextNext = sql[i + 3];
  if (next === "!" || (next === "M" && nextNext === "!")) { return null; }
  return scanMultiLineComment(sql, i);
}

function scanNestedMultiLineComment(sql: string, i: number): SQLToken | null {
  if (sql[i] !== "/" || sql[i + 1] !== "*") { return null; }
  let j = i + 2;
  let depth = 1;
  while (j < sql.length && depth > 0) {
    if (sql[j] === "/" && sql[j + 1] === "*") { depth++; j += 2; }
    else if (sql[j] === "*" && sql[j + 1] === "/") { depth--; j += 2; }
    else { j++; }
  }
  return { type: TokenType.Comment, end: j };
}

function scanSingleQuotedString(sql: string, i: number): SQLToken | null {
  if (sql[i] !== "'") { return null; }
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; }
    else if (sql[j] === "'") { j++; break; }
    else { j++; }
  }
  return { type: TokenType.QuotedBlock, end: j };
}

function scanDoubleQuotedString(sql: string, i: number): SQLToken | null {
  if (sql[i] !== '"') { return null; }
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] === '"' && sql[j + 1] === '"') { j += 2; }
    else if (sql[j] === '"') { j++; break; }
    else { j++; }
  }
  return { type: TokenType.QuotedBlock, end: j };
}

// Matches $$ or $tag$ where tag is [a-zA-Z_]\w* (digits after $ do NOT start a tag, so $1 is safe)
const dollarQuoteOpenRegex = /^\$([a-zA-Z_]\w*)?\$/;

function scanDollarQuotedBlock(sql: string, i: number): SQLToken | null {
  if (sql[i] !== "$") { return null; }
  // $N where N is a digit is a positional parameter, not a dollar-quote
  const next = sql[i + 1];
  if (next >= "0" && next <= "9") { return null; }
  const remaining = sql.substring(i);
  const m = dollarQuoteOpenRegex.exec(remaining);
  if (!m) { return null; }
  const tag = m[0];
  const bodyStart = i + tag.length;
  const closeIdx = sql.indexOf(tag, bodyStart);
  const end = closeIdx !== -1 ? closeIdx + tag.length : sql.length;
  return { type: TokenType.QuotedBlock, end };
}

function scanBacktickQuotedIdentifier(sql: string, i: number): SQLToken | null {
  if (sql[i] !== "`") { return null; }
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] === "`" && sql[j + 1] === "`") { j += 2; }
    else if (sql[j] === "`") { j++; break; }
    else { j++; }
  }
  return { type: TokenType.QuotedBlock, end: j };
}

function scanBracketQuotedIdentifier(sql: string, i: number): SQLToken | null {
  if (sql[i] !== "[") { return null; }
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] === "]" && sql[j + 1] === "]") { j += 2; }
    else if (sql[j] === "]") { j++; break; }
    else { j++; }
  }
  return { type: TokenType.QuotedBlock, end: j };
}

function scanTokenAnsi(sql: string, i: number): SQLToken {
  return scanSingleLineComment(sql, i)
    ?? scanMultiLineComment(sql, i)
    ?? scanSingleQuotedString(sql, i)
    ?? scanDoubleQuotedString(sql, i)
    ?? plainToken(i);
}

function scanTokenPostgres(sql: string, i: number): SQLToken {
  return scanSingleLineComment(sql, i)
    ?? scanNestedMultiLineComment(sql, i)
    ?? scanSingleQuotedString(sql, i)
    ?? scanDoubleQuotedString(sql, i)
    ?? scanDollarQuotedBlock(sql, i)
    ?? plainToken(i);
}

function scanTokenMySQL(sql: string, i: number): SQLToken {
  return scanSingleLineCommentMySQL(sql, i)
    ?? scanMultiLineCommentMySQL(sql, i)
    ?? scanSingleQuotedString(sql, i)
    ?? scanDoubleQuotedString(sql, i)
    ?? scanBacktickQuotedIdentifier(sql, i)
    ?? plainToken(i);
}

function scanTokenSQLite(sql: string, i: number): SQLToken {
  return scanSingleLineComment(sql, i)
    ?? scanMultiLineComment(sql, i)
    ?? scanSingleQuotedString(sql, i)
    ?? scanDoubleQuotedString(sql, i)
    ?? scanBacktickQuotedIdentifier(sql, i)
    ?? scanBracketQuotedIdentifier(sql, i)
    ?? plainToken(i);
}

function scanTokenSQLServer(sql: string, i: number): SQLToken {
  return scanSingleLineComment(sql, i)
    ?? scanMultiLineComment(sql, i)
    ?? scanSingleQuotedString(sql, i)
    ?? scanDoubleQuotedString(sql, i)
    ?? scanBracketQuotedIdentifier(sql, i)
    ?? plainToken(i);
}

type TokenScanner = (sql: string, i: number) => SQLToken;

const dialectScanners: Record<ConnectorType, TokenScanner> = {
  postgres: scanTokenPostgres,
  mysql: scanTokenMySQL,
  mariadb: scanTokenMySQL,
  sqlite: scanTokenSQLite,
  sqlserver: scanTokenSQLServer,
};

function getScanner(dialect?: ConnectorType): TokenScanner {
  return dialect ? (dialectScanners[dialect] ?? scanTokenAnsi) : scanTokenAnsi;
}

/**
 * Replace comments, string literals, and dialect-specific quoted blocks with a single space each.
 * When no dialect is specified, only ANSI SQL syntax is recognized.
 */
export function stripCommentsAndStrings(sql: string, dialect?: ConnectorType): string {
  const scanToken = getScanner(dialect);
  const parts: string[] = [];
  let plainStart = -1;
  let i = 0;

  while (i < sql.length) {
    const token = scanToken(sql, i);

    if (token.type === TokenType.Plain) {
      if (plainStart === -1) { plainStart = i; }
    } else {
      if (plainStart !== -1) {
        parts.push(sql.substring(plainStart, i));
        plainStart = -1;
      }
      parts.push(" ");
    }

    i = token.end;
  }

  if (plainStart !== -1) {
    parts.push(sql.substring(plainStart));
  }

  return parts.join("");
}

/**
 * Split SQL into individual statements, handling semicolons inside quoted contexts.
 * When no dialect is specified, only ANSI SQL syntax is recognized.
 */
export function splitSQLStatements(sql: string, dialect?: ConnectorType): string[] {
  const scanToken = getScanner(dialect);
  const statements: string[] = [];
  let stmtStart = 0;
  let i = 0;

  while (i < sql.length) {
    if (sql[i] === ";") {
      const trimmed = sql.substring(stmtStart, i).trim();
      if (trimmed.length > 0) { statements.push(trimmed); }
      stmtStart = i + 1;
      i++;
      continue;
    }

    const token = scanToken(sql, i);
    i = token.end;
  }

  const trimmed = sql.substring(stmtStart).trim();
  if (trimmed.length > 0) { statements.push(trimmed); }

  return statements;
}

/** One T-SQL batch, as cut from a script by the `GO` separator. */
export interface SQLServerBatch {
  /** Batch text, with the terminating `GO` line removed. */
  sql: string;
  /** Repeat count from `GO <n>`; 1 when the separator carried no count. */
  count: number;
}

/**
 * A line separates batches when it holds nothing but `GO`, an optional repeat
 * count, and an optional trailing line comment. `GOTO label` therefore stays a
 * statement, and so does `GO 0`, which SSMS rejects rather than running zero
 * times — letting it through as a separator would silently drop a batch.
 */
const GO_SEPARATOR_LINE = /^[^\S\n]*go(?:[^\S\n]+([1-9]\d*))?[^\S\n]*(?:--[^\n]*)?$/i;

/**
 * Split T-SQL on the `GO` batch separator the way SSMS and sqlcmd do.
 *
 * `GO` is a client directive, not T-SQL — the server never sees it. A caller
 * that needs CREATE PROCEDURE (which must be alone in its batch), or a
 * parse-time SET such as PARSEONLY to apply to statements rather than to
 * itself, has to cut the script here and send each batch separately.
 *
 * Only a `GO` alone on its own line separates, so `GOTO`, `SELECT 'GO'` and a
 * `GO` inside a comment are left alone. Returns one batch for a script with no
 * separator at all, which lets the caller keep using its single-batch path.
 */
export function splitSQLServerBatches(sql: string): SQLServerBatch[] {
  const scanToken = getScanner("sqlserver");
  const batches: SQLServerBatch[] = [];
  let batchStart = 0;
  let lineStart = 0;
  let i = 0;

  const separatorCount = (lineEnd: number): number | null => {
    const match = GO_SEPARATOR_LINE.exec(sql.substring(lineStart, lineEnd));
    if (!match) { return null; }
    return match[1] ? Number(match[1]) : 1;
  };

  const pushBatch = (end: number, count: number) => {
    const text = sql.substring(batchStart, end);
    if (text.trim().length > 0) { batches.push({ sql: text, count }); }
  };

  while (i < sql.length) {
    const token = scanToken(sql, i);

    // Only a newline the scanner calls plain ends a line: newlines inside a
    // block comment or a string literal belong to that token, so a `GO` sitting
    // on its own line *within* them must not separate anything.
    if (token.type === TokenType.Plain && sql[i] === "\n") {
      const count = separatorCount(i);
      if (count !== null) {
        pushBatch(lineStart, count);
        batchStart = i + 1;
      }
      lineStart = i + 1;
    }

    i = token.end;
  }

  // A trailing `GO` needs no newline after it to close the batch it follows.
  const trailingCount = separatorCount(sql.length);
  if (trailingCount !== null) {
    pushBatch(lineStart, trailingCount);
    batchStart = sql.length;
  }

  pushBatch(sql.length, 1);
  return batches;
}
