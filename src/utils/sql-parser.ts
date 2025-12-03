/**
 * SQL parsing utilities for safely analyzing SQL statements.
 * These functions help avoid false positives when detecting SQL patterns
 * by stripping comments and string literals first.
 */

/**
 * Strip SQL comments and string literals to avoid false positives when detecting patterns.
 * This prevents matching keywords, parameters, etc. inside comments or quoted strings.
 *
 * Handles:
 * - Single-line comments (--)
 * - Multi-line comments (slash-star ... star-slash)
 * - Single-quoted strings ('string') with escaped quotes ('')
 * - Double-quoted identifiers/strings ("identifier") with escaped quotes ("")
 *
 * @param sql The SQL statement to clean
 * @returns The SQL with comments and strings replaced by spaces (preserving structure)
 */
export function stripCommentsAndStrings(sql: string): string {
  let result = "";
  let i = 0;

  while (i < sql.length) {
    // Check for single-line comment (--)
    if (sql[i] === "-" && sql[i + 1] === "-") {
      // Skip until end of line
      while (i < sql.length && sql[i] !== "\n") {
        i++;
      }
      result += " ";
      continue;
    }

    // Check for multi-line comment (/* */)
    if (sql[i] === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
        i++;
      }
      i += 2; // Skip closing */
      result += " ";
      continue;
    }

    // Check for single-quoted string
    if (sql[i] === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          // Escaped single quote
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      result += " ";
      continue;
    }

    // Check for double-quoted identifier (standard SQL) or string (MySQL with ANSI_QUOTES off)
    if (sql[i] === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          // Escaped double quote
          i += 2;
        } else if (sql[i] === '"') {
          i++;
          break;
        } else {
          i++;
        }
      }
      result += " ";
      continue;
    }

    result += sql[i];
    i++;
  }

  return result;
}
