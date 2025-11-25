/**
 * Demo data loader for SQLite in-memory database
 *
 * This module loads the sample employee database into the SQLite in-memory database
 * when the --demo flag is specified.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Create __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to sample data files - will be bundled with the package
// Try different paths to find the SQL files in development or production
let DEMO_DATA_DIR: string;
const projectRootPath = path.join(__dirname, "..", "..", "..");
const projectResourcesPath = path.join(projectRootPath, "demo", "employee-sqlite");
const distPath = path.join(__dirname, "demo", "employee-sqlite");

// First try the project root resources directory (for development)
if (fs.existsSync(projectResourcesPath)) {
  DEMO_DATA_DIR = projectResourcesPath;
}
// Then try dist directory (for production)
else if (fs.existsSync(distPath)) {
  DEMO_DATA_DIR = distPath;
}
// Fallback to a relative path from the current directory
else {
  DEMO_DATA_DIR = path.join(process.cwd(), "demo", "employee-sqlite");
  if (!fs.existsSync(DEMO_DATA_DIR)) {
    throw new Error(`Could not find employee-sqlite resources in any of the expected locations: 
      - ${projectResourcesPath}
      - ${distPath}
      - ${DEMO_DATA_DIR}`);
  }
}

/**
 * Load SQL file contents
 */
export function loadSqlFile(fileName: string): string {
  const filePath = path.join(DEMO_DATA_DIR, fileName);
  return fs.readFileSync(filePath, "utf8");
}

/**
 * Get SQLite DSN for in-memory database
 */
export function getInMemorySqliteDSN(): string {
  return "sqlite:///:memory:";
}

/**
 * Load SQL files sequentially
 */
export function getSqliteInMemorySetupSql(): string {
  // First, load the schema
  let sql = loadSqlFile("employee.sql");

  // Replace .read directives with the actual file contents
  // This is necessary because in-memory SQLite can't use .read
  const readRegex = /\.read\s+([a-zA-Z0-9_]+\.sql)/g;
  let match;

  while ((match = readRegex.exec(sql)) !== null) {
    const includePath = match[1];
    const includeContent = loadSqlFile(includePath);

    // Replace the .read line with the file contents
    sql = sql.replace(match[0], includeContent);
  }

  return sql;
}