/**
 * Built-in tool constants
 * Central location for built-in tool names used throughout the codebase
 */

export const BUILTIN_TOOL_EXECUTE_SQL = "execute_sql";
export const BUILTIN_TOOL_SEARCH_OBJECTS = "search_objects";
export const BUILTIN_TOOL_EXPLAIN_SQL = "explain_sql";
export const BUILTIN_TOOL_HEALTH_CHECK = "health_check";

// The default pair every source gets when it has no [[tools]] entries of its
// own. explain_sql and health_check are intentionally excluded — they're
// opt-in only.
export const BUILTIN_TOOLS = [
  BUILTIN_TOOL_EXECUTE_SQL,
  BUILTIN_TOOL_SEARCH_OBJECTS,
] as const;

// All recognized built-in tool names, including opt-in ones. Used wherever a
// tool name needs to be identified as "built-in" (skip custom-tool
// validation, reserve the naming pattern) without affecting the default set.
export const ALL_BUILTIN_TOOL_NAMES = [
  ...BUILTIN_TOOLS,
  BUILTIN_TOOL_EXPLAIN_SQL,
  BUILTIN_TOOL_HEALTH_CHECK,
] as const;
