/**
 * Built-in tool constants
 * Central location for built-in tool names used throughout the codebase
 */

export const BUILTIN_TOOL_EXECUTE_SQL = "execute_sql";
export const BUILTIN_TOOL_SEARCH_OBJECTS = "search_objects";
export const BUILTIN_TOOL_GENERATE_CODE = "generate_code";
export const BUILTIN_TOOL_REDIS_COMMAND = "redis_command";
export const BUILTIN_TOOL_ELASTICSEARCH_SEARCH = "elasticsearch_search";

export const BUILTIN_TOOLS = [
  BUILTIN_TOOL_EXECUTE_SQL,
  BUILTIN_TOOL_SEARCH_OBJECTS,
  BUILTIN_TOOL_GENERATE_CODE,
  BUILTIN_TOOL_REDIS_COMMAND,
  BUILTIN_TOOL_ELASTICSEARCH_SEARCH,
] as const;
