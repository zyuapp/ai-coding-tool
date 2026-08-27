import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { BoundTool } from "../tools/tool-definition.mjs";

/** How Claude names a tool an MCP server offers. */
function mcpToolName(server: string, name: string) {
  return `mcp__${server}__${name}`;
}

/** The names Claude uses for a server's read-only tools, taken from the definitions so an allow list cannot drift from them. */
export function readOnlyToolNames(server: string, definitions: readonly { name: string; readOnly: boolean }[]) {
  return new Set(definitions.flatMap((definition) => definition.readOnly ? [mcpToolName(server, definition.name)] : []));
}

/** Serves the app's tools to Claude as an in-process MCP server. */
export function claudeMcpServer(name: string, tools: readonly BoundTool[]): McpServerConfig {
  return createSdkMcpServer({
    name,
    version: "1.0.0",
    alwaysLoad: true,
    tools: tools.map((bound) => tool(bound.name, bound.description, bound.input, (args) => bound.handler(args))),
  });
}
