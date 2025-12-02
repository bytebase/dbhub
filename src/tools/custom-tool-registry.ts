/**
 * Custom Tool Registry
 * Loads, validates, and provides access to custom tool definitions from TOML config
 */

import { ToolConfig } from "../types/config.js";
import { ConnectorManager } from "../connectors/manager.js";
import { validateParameters } from "../utils/parameter-mapper.js";

/**
 * Global registry of custom tools loaded from TOML configuration
 */
class CustomToolRegistry {
  private tools: ToolConfig[] = [];
  private initialized = false;

  /**
   * Initialize the registry with tool definitions from TOML
   * @param toolConfigs Tool definitions from TOML config
   * @throws Error if validation fails
   */
  public initialize(toolConfigs: ToolConfig[] | undefined): void {
    if (this.initialized) {
      throw new Error("CustomToolRegistry already initialized");
    }

    this.tools = [];

    if (!toolConfigs || toolConfigs.length === 0) {
      this.initialized = true;
      return;
    }

    // Validate and register each tool
    for (const toolConfig of toolConfigs) {
      this.validateAndRegister(toolConfig);
    }

    this.initialized = true;
  }

  /**
   * Validate a tool configuration and add it to the registry
   * @param toolConfig Tool configuration to validate
   * @throws Error if validation fails
   */
  private validateAndRegister(toolConfig: ToolConfig): void {
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
    const availableSources = ConnectorManager.getAvailableSourceIds();
    if (!availableSources.includes(toolConfig.source)) {
      throw new Error(
        `Tool '${toolConfig.name}' references unknown source '${toolConfig.source}'. ` +
          `Available sources: ${availableSources.join(", ")}`
      );
    }

    // 3. Validate tool name doesn't conflict with built-in tools
    const builtInToolPrefixes = ["execute_sql", "search_objects"];
    for (const prefix of builtInToolPrefixes) {
      if (
        toolConfig.name === prefix ||
        toolConfig.name.startsWith(`${prefix}_`)
      ) {
        throw new Error(
          `Tool name '${toolConfig.name}' conflicts with built-in tool naming pattern. ` +
            `Custom tools cannot use names starting with: ${builtInToolPrefixes.join(", ")}`
        );
      }
    }

    // 4. Validate tool name is unique
    if (this.tools.some((t) => t.name === toolConfig.name)) {
      throw new Error(
        `Duplicate tool name '${toolConfig.name}'. Tool names must be unique.`
      );
    }

    // 5. Validate parameters match SQL statement
    const sourceConfig = ConnectorManager.getSourceConfig(toolConfig.source);
    const connectorType = sourceConfig?.type || "postgres"; // Default to postgres if type not specified

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

    // 6. Validate parameter definitions
    if (toolConfig.parameters) {
      for (const param of toolConfig.parameters) {
        this.validateParameter(toolConfig.name, param);
      }
    }

    // All validations passed - add to registry
    this.tools.push(toolConfig);
  }

  /**
   * Validate a parameter definition
   * @param toolName Name of the tool (for error messages)
   * @param param Parameter configuration to validate
   * @throws Error if validation fails
   */
  private validateParameter(toolName: string, param: any): void {
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
   * Get all registered custom tools
   * @returns Array of tool configurations
   */
  public getTools(): ToolConfig[] {
    return [...this.tools];
  }

  /**
   * Get a specific tool by name
   * @param name Tool name
   * @returns Tool configuration or undefined if not found
   */
  public getTool(name: string): ToolConfig | undefined {
    return this.tools.find((t) => t.name === name);
  }

  /**
   * Check if the registry has been initialized
   * @returns True if initialized
   */
  public isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Reset the registry (primarily for testing)
   */
  public reset(): void {
    this.tools = [];
    this.initialized = false;
  }
}

// Export singleton instance
export const customToolRegistry = new CustomToolRegistry();
