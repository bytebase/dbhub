import type { ConnectorType } from "../connectors/interface.js";

const enum TokenType {
  Plain,
  Comment,
  QuotedBlock,
}

interface SQLToken {
  type: TokenType;
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

function scanMultiLineComment(sql: string, i: number): SQLToken | null {
  if (sql[i] !== "/" || sql[i + 1] !== "*") { return null; }
  let j = i + 2;
  while (j < sql.length && !(sql[j] === "*" && sql[j + 1] === "/")) { j++; }
  if (j < sql.length) { j += 2; }
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
    ?? scanMultiLineComment(sql, i)
    ?? scanSingleQuotedString(sql, i)
    ?? scanDoubleQuotedString(sql, i)
    ?? scanDollarQuotedBlock(sql, i)
    ?? plainToken(i);
}

function scanTokenMySQL(sql: string, i: number): SQLToken {
  return scanSingleLineComment(sql, i)
    ?? scanMultiLineComment(sql, i)
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
 * Replace comments, string literals, and dialect-specific quoted blocks with spaces.
 * When no dialect is specified, only ANSI SQL syntax is recognized.
 */
export function stripCommentsAndStrings(sql: string, dialect?: ConnectorType): string {
  const scanToken = getScanner(dialect);
  let result = "";
  let i = 0;

  while (i < sql.length) {
    const token = scanToken(sql, i);

    if (token.type === TokenType.Plain) { result += sql[i]; }
    else { result += " "; }

    i = token.end;
  }

  return result;
}

/**
 * Split SQL into individual statements, handling semicolons inside quoted contexts.
 * When no dialect is specified, only ANSI SQL syntax is recognized.
 */
export function splitSQLStatements(sql: string, dialect?: ConnectorType): string[] {
  const scanToken = getScanner(dialect);
  const statements: string[] = [];
  let current = "";
  let i = 0;

  while (i < sql.length) {
    if (sql[i] === ";") {
      const trimmed = current.trim();
      if (trimmed.length > 0) { statements.push(trimmed); }
      current = "";
      i++;
      continue;
    }

    const token = scanToken(sql, i);
    current += sql.substring(i, token.end);
    i = token.end;
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) { statements.push(trimmed); }

  return statements;
}
