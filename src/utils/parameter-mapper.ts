/**
 * Parameter mapping utilities for custom tools
 * Maps tool parameters to connector-specific parameter syntax
 */

import { ConnectorType } from "../connectors/interface.js";
import { ParameterConfig } from "../types/config.js";
import { stripCommentsAndStrings } from "./sql-parser.js";

/**
 * Parameter placeholder styles for different database connectors
 */
export const PARAMETER_STYLES = {
  postgres: "numbered", // $1, $2, $3
  mysql: "positional", // ?, ?, ?
  mariadb: "positional", // ?, ?, ?
  sqlserver: "named", // @p1, @p2, @p3
  sqlite: "positional", // ?, ?, ?
  oracle: "colon", // :1, :2, :3
} as const;

/**
 * Detect the parameter style used in a SQL statement.
 * Strips comments and string literals first to avoid false positives.
 * @param statement SQL statement to analyze
 * @returns The detected parameter style
 */
export function detectParameterStyle(
  statement: string,
  connectorType?: ConnectorType
): "numbered" | "positional" | "named" | "colon" | "none" {
  // Strip comments and strings (with the dialect's quoting rules, e.g. Oracle
  // q'[...]' literals) to avoid matching parameters inside them
  const cleanedSQL = stripCommentsAndStrings(statement, connectorType);

  // Check for PostgreSQL-style numbered parameters ($1, $2, etc.)
  if (/\$\d+/.test(cleanedSQL)) {
    return "numbered";
  }

  // Check for SQL Server-style named parameters (@p1, @p2, etc.)
  if (/@p\d+/.test(cleanedSQL)) {
    return "named";
  }

  // Check for Oracle-style colon-numbered bind placeholders (:1, :2, etc.).
  // A PostgreSQL cast (`x::int`) never matches: the character after `::` is a
  // type name, not a digit.
  if (/(?<!:):\d+/.test(cleanedSQL)) {
    return "colon";
  }

  // Check for positional parameters (?)
  if (/\?/.test(cleanedSQL)) {
    return "positional";
  }

  return "none";
}

/**
 * Validate that the SQL statement's parameter style matches the connector type
 * @param statement SQL statement
 * @param connectorType Database connector type
 * @throws Error if parameter style doesn't match connector
 */
export function validateParameterStyle(
  statement: string,
  connectorType: ConnectorType
): void {
  const detectedStyle = detectParameterStyle(statement, connectorType);
  const expectedStyle = PARAMETER_STYLES[connectorType];

  if (detectedStyle === "none") {
    // No parameters in statement - this is valid
    return;
  }

  if (detectedStyle !== expectedStyle) {
    const examples = {
      numbered: "$1, $2, $3",
      positional: "?, ?, ?",
      named: "@p1, @p2, @p3",
      colon: ":1, :2, :3",
    };

    throw new Error(
      `Invalid parameter syntax for ${connectorType}. ` +
        `Expected ${expectedStyle} style (${examples[expectedStyle]}), ` +
        `but found ${detectedStyle} style in statement.`
    );
  }
}

/**
 * Count the number of parameters in a SQL statement and validate they are sequential.
 * Strips comments and string literals first to avoid false positives.
 * @param statement SQL statement
 * @returns Number of parameter placeholders required (highest index for numbered/named)
 * @throws Error if numbered/named parameters are not sequential starting from 1
 */
export function countParameters(statement: string, connectorType?: ConnectorType): number {
  const style = detectParameterStyle(statement, connectorType);
  // Strip comments and strings to avoid matching parameters inside them
  const cleanedSQL = stripCommentsAndStrings(statement, connectorType);

  switch (style) {
    case "numbered":
      return countIndexedParameters(cleanedSQL, /\$\d+/g, "$", "numbered");
    case "named":
      return countIndexedParameters(cleanedSQL, /@p\d+/g, "@p", "named");
    case "colon":
      return countIndexedParameters(cleanedSQL, /(?<!:):\d+/g, ":", "colon-numbered");
    case "positional":
      // Count question marks (positional parameters don't have this issue)
      return (cleanedSQL.match(/\?/g) || []).length;
    default:
      return 0;
  }
}

/**
 * Count `<sigil>N` placeholders and require them to be sequential from 1.
 * Returns the highest index (the number of parameter values required).
 */
function countIndexedParameters(
  cleanedSQL: string,
  pattern: RegExp,
  sigil: string,
  styleName: string
): number {
  const matches = cleanedSQL.match(pattern);
  if (!matches) return 0;
  const indices = new Set(matches.map((m) => parseInt(m.slice(sigil.length), 10)));
  const maxIndex = Math.max(...indices);
  for (let i = 1; i <= maxIndex; i++) {
    if (!indices.has(i)) {
      const found = Array.from(indices).sort((a, b) => a - b).map((n) => `${sigil}${n}`).join(", ");
      throw new Error(
        `Non-sequential ${styleName} parameters detected. Found placeholders: ${found}. ` +
        `Parameters must be sequential starting from ${sigil}1 (missing ${sigil}${i}).`
      );
    }
  }
  return maxIndex;
}

/**
 * Validate that parameter definitions match the SQL statement
 * @param statement SQL statement
 * @param parameters Parameter definitions
 * @param connectorType Database connector type
 * @throws Error if validation fails
 */
export function validateParameters(
  statement: string,
  parameters: ParameterConfig[] | undefined,
  connectorType: ConnectorType
): void {
  // Validate parameter style matches connector
  validateParameterStyle(statement, connectorType);

  const paramCount = countParameters(statement, connectorType);
  const definedCount = parameters?.length || 0;

  if (paramCount !== definedCount) {
    throw new Error(
      `Parameter count mismatch: SQL statement has ${paramCount} parameter(s), ` +
        `but ${definedCount} parameter(s) defined in tool configuration.`
    );
  }
}

/**
 * Map user-provided arguments to an array suitable for connector execution
 * Handles default values and validates required parameters
 * @param parameters Parameter definitions
 * @param args User-provided arguments
 * @returns Array of parameter values in order
 */
export function mapArgumentsToArray(
  parameters: ParameterConfig[] | undefined,
  args: Record<string, any>
): any[] {
  if (!parameters || parameters.length === 0) {
    return [];
  }

  return parameters.map((param) => {
    const value = args[param.name];

    // Use provided value if available
    if (value !== undefined) {
      return value;
    }

    // Use default value if parameter is optional
    if (param.default !== undefined) {
      return param.default;
    }

    // This should be caught by Zod validation, but add a safety check
    if (param.required !== false) {
      throw new Error(
        `Required parameter '${param.name}' is missing and has no default value.`
      );
    }

    // Optional parameter with no default
    return null;
  });
}
