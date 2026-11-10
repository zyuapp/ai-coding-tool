import type { BriefDialect } from "../tools/tool-server.mjs";
import { TOOL_SERVERS } from "../tools/tool-servers.mjs";
import type { ProviderRunInput } from "./agent-provider.mjs";
import { runTools, type ServedToolSet, type ToolSources } from "./run-tools.mjs";
import { SIDE_CHAT_INSTRUCTIONS } from "./side-chat-instructions.mjs";

export type BriefSources = ToolSources & Pick<ProviderRunInput, "workspaceRoot" | "projectRoot" | "projectless">;

/** What every engine tells a run beyond its prompt, the tools it offers, and what a warm session must agree on. */
export type RunBrief = {
  instructions: string[];
  tools: ServedToolSet[];
  /** A run whose identity differs from a warm session's needs a session of its own. */
  identity: unknown[];
};

const linkInstructions = `Only Markdown links are clickable in your output. Link web pages as [label](https://example.com), workspace files as [label](/absolute/path:line), pushed commits as [short hash](https://github.com/owner/repo/commit/<hash>) with their repository's real host and path, and other threads as [title](aicodingtool://thread/<id>). Omit the line when it is unavailable.`;
const computerUseInstructions = `When a requested outcome lives in another application's interface, use the provided computer-use MCP tools. Never invoke a separately installed cua-driver through Bash. Observe the exact target before every action and verify the result afterward. Prefer accessibility targets, then screenshot coordinates, and use foreground delivery only after background delivery fails.`;
const workflowInstructions = `For ordinary AICodingTool operations, prefer the AICodingTool tools. They are defaults, not restrictions on the user's workflow: follow the user's explicitly requested target and method, and verify the result in the requested target before reporting success.`;

function offers(tools: readonly ServedToolSet[], server: string) {
  const set = tools.find((candidate) => candidate.server === server);
  return (name?: string) => set !== undefined && (name === undefined || set.tools.some((tool) => tool.name === name));
}

/** The brief every engine gives a run: the same words, gated on the same tools, whichever engine reads it. */
export function runBrief(input: BriefSources, dialect: BriefDialect): RunBrief {
  const tools = runTools(input);
  const instructions = [
    ...(input.computerUse.status === "unavailable" ? [] : [computerUseInstructions]),
    linkInstructions,
    ...TOOL_SERVERS.flatMap((server) => server.brief?.(offers(tools, server.name), dialect, input) ?? []),
    ...(tools.length ? [workflowInstructions] : []),
    ...(input.channel === "side" ? [SIDE_CHAT_INSTRUCTIONS] : []),
  ];
  const identity = [
    input.channel,
    input.workspaceRoot,
    input.projectless,
    input.computerUse.status === "available" ? input.computerUse.mcp : input.computerUse.status,
    input.coordinationRole ?? null,
    instructions,
    tools.map(({ server, tools: served }) => [server, served.map((tool) => tool.name)]),
  ];
  return { instructions, tools, identity };
}
