import { AUTOMATION_SERVER_NAME } from "../tools/automation.mjs";
import { BROWSER_SERVER_NAME } from "../tools/browser.mjs";
import { TERMINAL_SERVER_NAME } from "../tools/terminal.mjs";
import { THREAD_SERVER_NAME } from "../tools/threads.mjs";
import type { ProviderRunInput } from "./agent-provider.mjs";
import { coordinationInstructions } from "./coordination-instructions.mjs";
import { runTools, type ServedToolSet, type ToolSources } from "./run-tools.mjs";
import { SIDE_CHAT_INSTRUCTIONS } from "./side-chat-instructions.mjs";

export type BriefSources = ToolSources & Pick<ProviderRunInput, "workspaceRoot" | "projectless">;

/** The few words an engine needs said its own way. */
export type BriefDialect = {
  /** The engine's own sessions and helpers, which an app thread ID never names. */
  nativeWork: string;
};

/** What every engine tells a run beyond its prompt, the tools it offers, and what a warm session must agree on. */
export type RunBrief = {
  instructions: string[];
  tools: ServedToolSet[];
  /** A run whose identity differs from a warm session's needs a session of its own. */
  identity: unknown[];
};

const linkInstructions = `Only Markdown links are clickable in your output. Link web pages as [label](https://example.com), workspace files as [label](/absolute/path:line), and other threads as [title](aicodingtool://thread/<id>). Omit the line when it is unavailable.`;
const computerUseInstructions = `When a requested outcome lives in another application's interface, use the provided computer-use MCP tools. Never invoke a separately installed cua-driver through Bash. Observe the exact target before every action and verify the result afterward. Prefer accessibility targets, then screenshot coordinates, and use foreground delivery only after background delivery fails.`;
const automationInstructions = `This task can schedule itself. When the user asks to repeat, babysit, poll, or watch something on a cadence, use the schedule tool instead of looping yourself or reaching for cron.`;
const threadInstructions = (dialect: BriefDialect) => `Use the AICodingTool thread tools, such as start_thread, list_threads and read_thread, when the user's request requires creating, fetching or acting on another AICodingTool thread. App task IDs identify AICodingTool threads, not ${dialect.nativeWork}. Conversation history and app-supplied thread context are already available evidence; answering from them does not require a tool call.`;
const browserInstructions = `The AICodingTool browser panel is a real browser sharing one session with the user, so every site they have signed into is signed in for you: use the browser panel tools, such as browser_open, browser_read and browser_screenshot, rather than curl or Bash for anything behind a login, and rather than guessing at a page you can read.`;
const terminalInstructions = `Use terminal_list and terminal_read to see what the user's terminals in the AICodingTool terminal panel have printed. Those shells are the user's; run your own commands in your own.`;
const workflowInstructions = `For ordinary AICodingTool operations, prefer the AICodingTool tools. They are defaults, not restrictions on the user's workflow: follow the user's explicitly requested target and method, and verify the result in the requested target before reporting success.`;

function offers(tools: readonly ServedToolSet[], server: string, name?: string) {
  const set = tools.find((candidate) => candidate.server === server);
  return set !== undefined && (name === undefined || set.tools.some((tool) => tool.name === name));
}

/** The brief every engine gives a run: the same words, gated on the same tools, whichever engine reads it. */
export function runBrief(input: BriefSources, dialect: BriefDialect): RunBrief {
  const tools = runTools(input);
  const instructions = [
    ...(input.computerUse.status === "unavailable" ? [] : [computerUseInstructions]),
    linkInstructions,
    ...(offers(tools, AUTOMATION_SERVER_NAME, "schedule") ? [automationInstructions] : []),
    ...(offers(tools, THREAD_SERVER_NAME) ? [threadInstructions(dialect)] : []),
    ...coordinationInstructions(input.coordinationRole),
    ...(offers(tools, BROWSER_SERVER_NAME) ? [browserInstructions] : []),
    ...(offers(tools, TERMINAL_SERVER_NAME) ? [terminalInstructions] : []),
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
