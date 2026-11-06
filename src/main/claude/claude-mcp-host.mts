import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { BoundTool } from "../tools/tool-definition.mjs";

/** Serves the app's tools to Claude as an in-process MCP server. */
export function claudeMcpServer(name: string, tools: readonly BoundTool[]): McpServerConfig {
  return createSdkMcpServer({
    name,
    version: "1.0.0",
    alwaysLoad: true,
    tools: tools.map((bound) => tool(bound.name, bound.description, bound.input, (args) => bound.handler(args))),
  });
}
