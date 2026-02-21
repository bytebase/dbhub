/**
 * Code Generator Tool
 * Converts SQL, Redis, and Elasticsearch queries to equivalent C# and TypeScript implementations
 */

import { z } from "zod";

export const generateCodeSchema = z.object({
  query_type: z.enum(["sql", "redis", "elasticsearch"]).describe("Type of query to convert"),
  query: z.string().describe("The original query string"),
  database_type: z
    .enum(["postgres", "mysql", "sqlserver", "sqlite", "redis", "elasticsearch"])
    .describe("Specific database type"),
  language: z
    .enum(["csharp", "typescript", "both"])
    .default("both")
    .describe("Target language(s)"),
  orm_preference: z
    .enum(["ef-core", "dapper", "prisma", "all"])
    .default("all")
    .describe("ORM preference for code generation"),
});

export type GenerateCodeRequest = z.infer<typeof generateCodeSchema>;

export interface GeneratedCodeResponse {
  query_type: string;
  database_type: string;
  csharp?: {
    ef_core?: string;
    dapper?: string;
    explanation: string;
  };
  typescript?: {
    prisma?: string;
    raw_client?: string;
    explanation: string;
  };
  notes: string[];
}

/**
 * Generate C# code for SQL queries using Entity Framework Core
 */
function generateCSharpEFCore(
  query: string,
  dbType: string
): string {
  // Parse simple SELECT statements
  const selectMatch = query.match(
    /SELECT\s+(.*?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.*?))?(?:\s+ORDER BY\s+(.*?))?(?:\s+LIMIT\s+(\d+))?$/i
  );

  if (!selectMatch) {
    return `// Complex query - may require raw SQL or stored procedure\nawait context.Database.SqlQuery<YourEntity>($"""${query}""").ToListAsync();`;
  }

  const [, columns, table, where, orderBy, limit] = selectMatch;
  const tableNamePascal = table.charAt(0).toUpperCase() + table.slice(1);
  const limitNum = limit ? parseInt(limit) : null;

  let code = `var result = context.${table}s`;

  if (where) {
    code += `\n  .Where(x => ${formatWhereClause(where)})`;
  }

  if (orderBy) {
    code += `\n  .OrderBy(x => ${formatOrderBy(orderBy)})`;
  }

  if (limitNum) {
    code += `\n  .Take(${limitNum})`;
  }

  code += `\n  .Select(x => new { ${formatSelectColumns(columns)} })`;
  code += `\n  .ToListAsync();`;

  return code;
}

/**
 * Generate C# code for SQL queries using Dapper
 */
function generateCSharpDapper(query: string, dbType: string): string {
  const connectionType = getConnectionType(dbType);

  let code = `using (var connection = new ${connectionType}(connectionString))\n{\n`;
  code += `  var result = await connection.QueryAsync<dynamic>(\n`;
  code += `    $"""${query}"""\n`;
  code += `  );\n`;
  code += `}`;

  return code;
}

/**
 * Generate TypeScript code for SQL queries using Prisma ORM
 */
function generateTypeScriptPrisma(query: string, dbType: string): string {
  // Parse simple SELECT
  const selectMatch = query.match(
    /SELECT\s+(.*?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.*?))?(?:\s+ORDER BY\s+(.*?))?(?:\s+LIMIT\s+(\d+))?$/i
  );

  if (!selectMatch) {
    return `const result = await prisma.$queryRaw\`${query}\`;`;
  }

  const [, columns, table, where] = selectMatch;

  let code = `const result = await prisma.${table}.findMany({\n`;

  if (where) {
    code += `  where: ${formatPrismaWhere(where)},\n`;
  }

  code += `  select: {\n`;
  const cols = columns
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c !== "*");
  if (cols.length > 0 && cols[0] !== "*") {
    code += cols.map((col) => `    ${col}: true,\n`).join("");
  } else {
    code += `    // all fields\n`;
  }

  code += `  },\n`;
  code += `});`;

  return code;
}

/**
 * Generate TypeScript code using raw client (node-postgres, mysql2, etc.)
 */
function generateTypeScriptRawClient(query: string, dbType: string): string {
  const client = getTypeScriptClient(dbType);

  let code = `const result = await ${client}.query(\n`;
  code += `  \`${query}\`,\n`;
  code += `  [/* parameters */]\n`;
  code += `);`;

  return code;
}

/**
 * Generate C# code for Redis commands
 */
function generateCSharpRedis(command: string): string {
  const parts = command.trim().split(/\s+/);
  const cmd = parts[0].toUpperCase();
  const args = parts.slice(1);

  let code = `using StackExchange.Redis;\n\n`;
  code += `var db = redis.GetDatabase();\n`;

  switch (cmd) {
    case "GET":
      code += `var value = await db.StringGetAsync("${args[0]}");\n`;
      code += `var result = value.ToString();`;
      break;
    case "SET":
      code += `await db.StringSetAsync("${args[0]}", "${args.slice(1).join(" ")}");\n`;
      code += `var result = "OK";`;
      break;
    case "HGETALL":
      code += `var hashValues = await db.HashGetAllAsync("${args[0]}");\n`;
      code += `var dict = hashValues.ToDictionary(x => x.Name.ToString(), x => x.Value.ToString());`;
      break;
    case "LPUSH":
      code += `await db.ListPushAsync("${args[0]}", new RedisValue[] { ${args.slice(1).map((a) => `"${a}"`).join(", ")} });\n`;
      code += `var result = "OK";`;
      break;
    case "SADD":
      code += `await db.SetAddAsync("${args[0]}", new RedisValue[] { ${args.slice(1).map((a) => `"${a}"`).join(", ")} });\n`;
      code += `var result = "OK";`;
      break;
    default:
      code += `// StackExchange.Redis equivalent:\n`;
      code += `var result = await db.ExecuteAsync("${cmd}", new object[] { ${args.map((a) => `"${a}"`).join(", ")} });`;
  }

  return code;
}

/**
 * Generate TypeScript code for Redis commands
 */
function generateTypeScriptRedis(command: string): string {
  const parts = command.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  let code = ``;

  switch (cmd) {
    case "get":
      code = `const value = await redis.get("${args[0]}");\nconst result = value;`;
      break;
    case "set":
      code = `await redis.set("${args[0]}", "${args.slice(1).join(" ")}");\nconst result = "OK";`;
      break;
    case "hgetall":
      code = `const hashValues = await redis.hGetAll("${args[0]}");\nconst result = hashValues;`;
      break;
    case "lpush":
      code = `await redis.lPush("${args[0]}", [${args.slice(1).map((a) => `"${a}"`).join(", ")}]);\nconst result = "OK";`;
      break;
    case "sadd":
      code = `await redis.sAdd("${args[0]}", [${args.slice(1).map((a) => `"${a}"`).join(", ")}]);\nconst result = "OK";`;
      break;
    default:
      code = `const result = await redis.sendCommand(["${cmd}", ${args.map((a) => `"${a}"`).join(", ")}]);`;
  }

  return code;
}

/**
 * Generate C# code for Elasticsearch queries
 */
function generateCSharpElasticsearch(query: string): string {
  let code = `using Elasticsearch.Net;\nusing Nest;\n\n`;
  code += `var client = new ElasticClient(settings);\n\n`;

  try {
    const parsed = JSON.parse(query);
    code += `var response = await client.SearchAsync<dynamic>(s => s\n`;
    code += `  .Index("${parsed.index || "*"}")\n`;
    if (parsed.query) {
      code += `  .Query(q => /* TODO: build query from DSL */)\n`;
    }
    code += `);`;
  } catch {
    code += `// Parse query string for search\n`;
    code += `var response = await client.SearchAsync<dynamic>(s => s\n`;
    code += `  .Query(q => q.Match(m => m\n`;
    code += `    .Field("*")\n`;
    code += `    .Query("${query}")\n`;
    code += `  ))\n`;
    code += `);`;
  }

  return code;
}

/**
 * Generate TypeScript code for Elasticsearch queries
 */
function generateTypeScriptElasticsearch(query: string): string {
  let code = `import { Client } from "@elastic/elasticsearch";\n\n`;
  code += `const client = new Client({ node: "http://localhost:9200" });\n\n`;

  try {
    const parsed = JSON.parse(query);
    code += `const response = await client.search({\n`;
    code += `  index: "${parsed.index || "*"}",\n`;
    code += `  body: ${JSON.stringify(parsed, null, 4)}\n`;
    code += `});`;
  } catch {
    code += `const response = await client.search({\n`;
    code += `  index: "*",\n`;
    code += `  body: {\n`;
    code += `    query: {\n`;
    code += `      multi_match: {\n`;
    code += `        query: "${query}",\n`;
    code += `        fields: ["*"]\n`;
    code += `      }\n`;
    code += `    }\n`;
    code += `  }\n`;
    code += `});`;
  }

  return code;
}

// Helper functions

function formatWhereClause(where: string): string {
  // Convert SQL WHERE to LINQ
  return where.replace(/(\w+)\s*=\s*'([^']*)'/g, `x.$1 == "$2"`).replace(/AND/gi, "&&");
}

function formatOrderBy(orderBy: string): string {
  const parts = orderBy.split(",").map((p) => p.trim());
  if (parts.length === 1) {
    const [col, dir] = parts[0].split(/\s+/);
    return `x.${col}`;
  }
  return `x => ${parts.map((p) => `x.${p.split(/\s+/)[0]}`).join(", ")}`;
}

function formatSelectColumns(columns: string): string {
  if (columns.trim() === "*") return "";
  return columns
    .split(",")
    .map((c) => {
      const trimmed = c.trim();
      return `${trimmed}`;
    })
    .join(", ");
}

function formatPrismaWhere(where: string): string {
  // Simplified WHERE to Prisma object
  if (where.includes("=")) {
    const [col, val] = where.split("=").map((s) => s.trim());
    return `{ ${col}: "${val.replace(/['"]/g, "")}" }`;
  }
  return "{}";
}

function getConnectionType(dbType: string): string {
  switch (dbType) {
    case "postgres":
      return "NpgsqlConnection";
    case "mysql":
      return "MySqlConnection";
    case "sqlserver":
      return "SqlConnection";
    case "sqlite":
      return "SqliteConnection";
    default:
      return "DbConnection";
  }
}

function getTypeScriptClient(dbType: string): string {
  switch (dbType) {
    case "postgres":
      return "pool";
    case "mysql":
      return "pool";
    case "sqlserver":
      return "pool";
    case "sqlite":
      return "db";
    default:
      return "client";
  }
}

/**
 * Main code generation function
 */
export function generateCode(request: GenerateCodeRequest): GeneratedCodeResponse {
  const { query_type, query, database_type, language, orm_preference } = request;

  const response: GeneratedCodeResponse = {
    query_type,
    database_type,
    notes: [],
  };

  if (language === "csharp" || language === "both") {
    response.csharp = {
      explanation: "",
    };

    if (query_type === "sql") {
      if (orm_preference === "ef-core" || orm_preference === "all") {
        response.csharp.ef_core = generateCSharpEFCore(query, database_type);
      }
      if (orm_preference === "dapper" || orm_preference === "all") {
        response.csharp.dapper = generateCSharpDapper(query, database_type);
      }
      response.csharp.explanation = `Generated C# code for ${database_type}. Remember to handle exceptions and use connection strings from configuration.`;
    } else if (query_type === "redis") {
      response.csharp.ef_core = generateCSharpRedis(query);
      response.csharp.explanation = `Install NuGet package: StackExchange.Redis. Initialize client: var redis = ConnectionMultiplexer.Connect(config);`;
    } else if (query_type === "elasticsearch") {
      response.csharp.ef_core = generateCSharpElasticsearch(query);
      response.csharp.explanation = `Install NuGet package: Elasticsearch.Net and NEST. Configure with your Elasticsearch node URL.`;
    }
  }

  if (language === "typescript" || language === "both") {
    response.typescript = {
      explanation: "",
    };

    if (query_type === "sql") {
      if (orm_preference === "prisma" || orm_preference === "all") {
        response.typescript.prisma = generateTypeScriptPrisma(query, database_type);
      }
      if (orm_preference === "dapper" || orm_preference === "all") {
        // Dapper is C#-specific, use raw client for TS
        response.typescript.raw_client = generateTypeScriptRawClient(query, database_type);
      }
      response.typescript.explanation = `Generated TypeScript code. Run 'npx prisma generate' after updating schema.`;
    } else if (query_type === "redis") {
      response.typescript.prisma = generateTypeScriptRedis(query);
      response.typescript.explanation = `Install package: npm install redis. Initialize: const redis = createClient();`;
    } else if (query_type === "elasticsearch") {
      response.typescript.prisma = generateTypeScriptElasticsearch(query);
      response.typescript.explanation = `Install package: npm install @elastic/elasticsearch. Configure with your Elasticsearch node.`;
    }
  }

  response.notes.push("Code is auto-generated and may need refinement for production use.");
  response.notes.push("Always validate generated queries match your data model and business logic.");
  response.notes.push("For complex queries, consider reviewing the generated code with team members.");

  return response;
}
