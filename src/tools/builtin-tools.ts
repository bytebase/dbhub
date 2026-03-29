/**
 * Built-in tool constants
 * Central location for built-in tool names used throughout the codebase
 */

export const BUILTIN_TOOL_LIST_SOURCES = "list_sources"; // meta-tool, not per-source
export const BUILTIN_TOOL_EXECUTE_SQL = "execute_sql";
export const BUILTIN_TOOL_SEARCH_OBJECTS = "search_objects";

export const BUILTIN_TOOLS = [
  BUILTIN_TOOL_EXECUTE_SQL,
  BUILTIN_TOOL_SEARCH_OBJECTS,
] as const;

// Includes meta-tools (list_sources) that are not per-source
export const BUILTIN_AND_META_TOOLS = [
  BUILTIN_TOOL_LIST_SOURCES,
  ...BUILTIN_TOOLS,
] as const;
