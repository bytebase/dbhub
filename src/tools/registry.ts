/**
 * Tool Registry
 * Manages tool enablement and configuration across multiple database sources
 */

import type { TomlConfig, ToolConfig, ExecuteSqlToolConfig, SearchObjectsToolConfig, ParameterConfig } from "../types/config.js";
import { BUILTIN_TOOLS } from "./builtin-tools.js";
import { ConnectorManager } from "../connectors/manager.js";
import { validateParameters } from "../utils/parameter-mapper.js";

/**
 * Registry for managing tools across multiple database sources
 * Handles both built-in tools (execute_sql, search_objects) and custom tools
 */
export class ToolRegistry {
  private toolsBySource: Map<string, ToolConfig[]>;

  constructor(config: TomlConfig) {
    this.toolsBySource = this.buildRegistry(config);
  }

  /**
   * Check if a tool name is a built-in tool
   */
  private isBuiltinTool(toolName: string): boolean {
    return BUILTIN_TOOLS.includes(toolName);
  }

  /**
   * Validate a custom tool parameter definition
   */
  private validateParameter(toolName: string, param: ParameterConfig): void {
    if (!param.name || param.name.trim() === "") {
      throw new Error(`Tool '${toolName}' has parameter missing 'name' field`);
    }

    if (!param.type) {
      throw new Error(
        `Tool '${toolName}', parameter '${param.name}' missing 'type' field`
      );
    }

    const validTypes = ["string", "integer", "float", "boolean", "array"];
    if (!validTypes.includes(param.type)) {
      throw new Error(
        `Tool '${toolName}', parameter '${param.name}' has invalid type '${param.type}'. ` +
          `Valid types: ${validTypes.join(", ")}`
      );
    }

    if (!param.description || param.description.trim() === "") {
      throw new Error(
        `Tool '${toolName}', parameter '${param.name}' missing 'description' field`
      );
    }

    // Validate allowed_values if present
    if (param.allowed_values) {
      if (!Array.isArray(param.allowed_values)) {
        throw new Error(
          `Tool '${toolName}', parameter '${param.name}': allowed_values must be an array`
        );
      }

      if (param.allowed_values.length === 0) {
        throw new Error(
          `Tool '${toolName}', parameter '${param.name}': allowed_values cannot be empty`
        );
      }
    }

    // Validate that default value is compatible with allowed_values if both present
    if (param.default !== undefined && param.allowed_values) {
      if (!param.allowed_values.includes(param.default)) {
        throw new Error(
          `Tool '${toolName}', parameter '${param.name}': default value '${param.default}' ` +
            `is not in allowed_values: ${param.allowed_values.join(", ")}`
        );
      }
    }
  }

  /**
   * Validate a custom tool configuration
   */
  private validateCustomTool(toolConfig: ToolConfig, availableSources: string[]): void {
    // 1. Validate required fields
    if (!toolConfig.name || toolConfig.name.trim() === "") {
      throw new Error("Tool definition missing required field: name");
    }

    if (!toolConfig.description || toolConfig.description.trim() === "") {
      throw new Error(
        `Tool '${toolConfig.name}' missing required field: description`
      );
    }

    if (!toolConfig.source || toolConfig.source.trim() === "") {
      throw new Error(
        `Tool '${toolConfig.name}' missing required field: source`
      );
    }

    if (!toolConfig.statement || toolConfig.statement.trim() === "") {
      throw new Error(
        `Tool '${toolConfig.name}' missing required field: statement`
      );
    }

    // 2. Validate source exists
    if (!availableSources.includes(toolConfig.source)) {
      throw new Error(
        `Tool '${toolConfig.name}' references unknown source '${toolConfig.source}'. ` +
          `Available sources: ${availableSources.join(", ")}`
      );
    }

    // 3. Validate tool name doesn't conflict with built-in tools
    for (const builtinName of BUILTIN_TOOLS) {
      if (
        toolConfig.name === builtinName ||
        toolConfig.name.startsWith(`${builtinName}_`)
      ) {
        throw new Error(
          `Tool name '${toolConfig.name}' conflicts with built-in tool naming pattern. ` +
            `Custom tools cannot use names starting with: ${BUILTIN_TOOLS.join(", ")}`
        );
      }
    }

    // 4. Validate parameters match SQL statement
    const sourceConfig = ConnectorManager.getSourceConfig(toolConfig.source)!;
    const connectorType = sourceConfig.type;

    try {
      validateParameters(
        toolConfig.statement,
        toolConfig.parameters,
        connectorType
      );
    } catch (error) {
      throw new Error(
        `Tool '${toolConfig.name}' validation failed: ${(error as Error).message}`
      );
    }

    // 5. Validate parameter definitions
    if (toolConfig.parameters) {
      for (const param of toolConfig.parameters) {
        this.validateParameter(toolConfig.name, param);
      }
    }
  }

  /**
   * Build the internal registry mapping sources to their enabled tools
   */
  private buildRegistry(config: TomlConfig): Map<string, ToolConfig[]> {
    const registry = new Map<string, ToolConfig[]>();
    const availableSources = config.sources.map((s) => s.id);
    const customToolNames = new Set<string>();

    // Group tools by source and validate
    for (const tool of config.tools || []) {
      // Validate custom tools (built-in tools don't need validation)
      if (!this.isBuiltinTool(tool.name)) {
        this.validateCustomTool(tool, availableSources);

        // Check for duplicate custom tool names
        if (customToolNames.has(tool.name)) {
          throw new Error(
            `Duplicate tool name '${tool.name}'. Tool names must be unique.`
          );
        }
        customToolNames.add(tool.name);
      }

      const existing = registry.get(tool.source) || [];
      existing.push(tool);
      registry.set(tool.source, existing);
    }

    // Backward compatibility: sources without tools get default built-ins
    for (const source of config.sources) {
      if (!registry.has(source.id)) {
        const defaultTools: ToolConfig[] = BUILTIN_TOOLS.map((name) => {
          // Create properly typed tool configs based on the tool name
          if (name === 'execute_sql') {
            return { name: 'execute_sql', source: source.id } satisfies ExecuteSqlToolConfig;
          } else {
            return { name: 'search_objects', source: source.id } satisfies SearchObjectsToolConfig;
          }
        });
        registry.set(source.id, defaultTools);
      }
    }

    return registry;
  }

  /**
   * Get all enabled tool configs for a specific source
   */
  getEnabledToolConfigs(sourceId: string): ToolConfig[] {
    return this.toolsBySource.get(sourceId) || [];
  }

  /**
   * Get built-in tool configuration for a specific source
   * Returns undefined if tool is not enabled or not a built-in
   */
  getBuiltinToolConfig(
    toolName: string,
    sourceId: string
  ): ToolConfig | undefined {
    if (!this.isBuiltinTool(toolName)) {
      return undefined;
    }
    const tools = this.getEnabledToolConfigs(sourceId);
    return tools.find((t) => t.name === toolName);
  }

  /**
   * Get all unique tools across all sources (for tools/list response)
   * Returns the union of all enabled tools
   */
  getAllTools(): ToolConfig[] {
    const seen = new Set<string>();
    const result: ToolConfig[] = [];

    for (const tools of this.toolsBySource.values()) {
      for (const tool of tools) {
        if (!seen.has(tool.name)) {
          seen.add(tool.name);
          result.push(tool);
        }
      }
    }

    return result;
  }

  /**
   * Get all custom tools (non-builtin) across all sources
   */
  getCustomTools(): ToolConfig[] {
    return this.getAllTools().filter((tool) => !this.isBuiltinTool(tool.name));
  }

  /**
   * Get all built-in tool names that are enabled across any source
   */
  getEnabledBuiltinToolNames(): string[] {
    const enabledBuiltins = new Set<string>();

    for (const tools of this.toolsBySource.values()) {
      for (const tool of tools) {
        if (this.isBuiltinTool(tool.name)) {
          enabledBuiltins.add(tool.name);
        }
      }
    }

    return Array.from(enabledBuiltins);
  }
}

// Global singleton instance
let globalRegistry: ToolRegistry | null = null;

/**
 * Initialize the global tool registry
 */
export function initializeToolRegistry(config: TomlConfig): void {
  globalRegistry = new ToolRegistry(config);
}

/**
 * Get the global tool registry instance
 * Throws if registry has not been initialized
 */
export function getToolRegistry(): ToolRegistry {
  if (!globalRegistry) {
    throw new Error(
      "Tool registry not initialized. Call initializeToolRegistry first."
    );
  }
  return globalRegistry;
}
