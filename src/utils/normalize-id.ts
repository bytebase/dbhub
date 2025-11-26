/**
 * Normalize a source ID to create a valid tool name suffix
 * Converts all non-alphanumeric characters to underscores
 *
 * Examples:
 *   "prod_db" -> "prod_db"
 *   "staging-db" -> "staging_db"
 *   "dev.db" -> "dev_db"
 *   "my@db#123" -> "my_db_123"
 *
 * @param id - The source ID to normalize
 * @returns The normalized ID safe for use in tool names
 */
export function normalizeSourceId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '_');
}
