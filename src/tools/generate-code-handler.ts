/**
 * Code Generation Tool Handler for MCP
 */

import { CallToolRequest } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  generateCodeSchema,
  generateCode,
  GenerateCodeRequest,
  GeneratedCodeResponse,
} from "./generate-code.js";

/**
 * Create the tool handler for code generation
 */
export function createGenerateCodeToolHandler() {
  return async (args: any, extra: any) => {
    try {
      // Validate input
      const params = generateCodeSchema.parse(args);

      // Generate code
      const result = generateCode(params);

      return {
        content: [
          {
            type: "text",
            text: formatCodeResponse(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error generating code: ${error}`,
          },
        ],
        isError: true,
      };
    }
  };
}

/**
 * Format the code response for display
 */
function formatCodeResponse(response: GeneratedCodeResponse): string {
  let output = `# Generated Code Conversion\n\n`;
  output += `**Query Type:** ${response.query_type}\n`;
  output += `**Database:** ${response.database_type}\n\n`;

  if (response.csharp) {
    output += `## C# Implementation\n\n`;

    if (response.csharp.ef_core) {
      output += `### Entity Framework Core\n\`\`\`csharp\n`;
      output += response.csharp.ef_core;
      output += `\n\`\`\`\n\n`;
    }

    if (response.csharp.dapper) {
      output += `### Dapper\n\`\`\`csharp\n`;
      output += response.csharp.dapper;
      output += `\n\`\`\`\n\n`;
    }

    output += `**Notes:** ${response.csharp.explanation}\n\n`;
  }

  if (response.typescript) {
    output += `## TypeScript Implementation\n\n`;

    if (response.typescript.prisma) {
      output += `### Prisma ORM / Client\n\`\`\`typescript\n`;
      output += response.typescript.prisma;
      output += `\n\`\`\`\n\n`;
    }

    if (response.typescript.raw_client) {
      output += `### Raw Client\n\`\`\`typescript\n`;
      output += response.typescript.raw_client;
      output += `\n\`\`\`\n\n`;
    }

    output += `**Notes:** ${response.typescript.explanation}\n\n`;
  }

  if (response.notes && response.notes.length > 0) {
    output += `## Important Notes\n\n`;
    response.notes.forEach((note) => {
      output += `- ${note}\n`;
    });
  }

  return output;
}
