import type { BoundTool } from "../tools/tool-definition.mjs";
import { TOOL_SERVERS, type ToolServerRun } from "../tools/tool-servers.mjs";
import type { ProviderRunInput } from "./agent-provider.mjs";
import { offeredOn } from "./channel-tools.mjs";

export type ToolSources = Pick<ProviderRunInput, "channel" | "computerUse"> & ToolServerRun;

export type ServedToolSet = { server: string; tools: BoundTool[] };

/**
 * Every app tool a run reaches, grouped by the server it is filed under and already short of what
 * the channel withholds. An engine that serves this list flat offers the same tools Claude sees.
 */
export function runTools(input: ToolSources): ServedToolSet[] {
  return TOOL_SERVERS.flatMap((server) => {
    const tools = server.serve(input);
    return tools ? [{ server: server.name, tools: offeredOn(input.channel, server.name, tools) }] : [];
  });
}
