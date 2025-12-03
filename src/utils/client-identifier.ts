/**
 * Client Identifier Utility
 * Extracts client information from MCP request context
 */

/**
 * Extract client identifier from request context
 * Returns User-Agent for HTTP transport, "stdio" for STDIO transport
 *
 * @param extra - The extra context passed by MCP SDK to tool handlers
 * @returns Client identifier string (User-Agent or "stdio")
 */
export function getClientIdentifier(extra: any): string {
  // MCP SDK 1.23+ passes requestInfo in extra.requestInfo for HTTP transport
  const userAgent = extra?.requestInfo?.headers?.["user-agent"];
  if (userAgent) {
    return userAgent;
  }

  // Default for STDIO mode
  return "stdio";
}
