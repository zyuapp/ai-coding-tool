import { automationTools, AUTOMATION_SERVER_NAME, findingTools } from "../tools/automation.mjs";
import { browserTools, BROWSER_SERVER_NAME } from "../tools/browser.mjs";
import { computerUseSetupTools, COMPUTER_USE_SETUP_SERVER_NAME } from "../tools/computer-use.mjs";
import { terminalTools, TERMINAL_SERVER_NAME } from "../tools/terminal.mjs";
import { threadTools, THREAD_SERVER_NAME } from "../tools/threads.mjs";
import { coordinationTools, COORDINATION_SERVER_NAME } from "../tools/coordination.mjs";
import type { BoundTool } from "../tools/tool-definition.mjs";
import type { ProviderRunInput } from "./agent-provider.mjs";
import { offeredOn } from "./channel-tools.mjs";

export type ToolSources = Pick<ProviderRunInput, "channel" | "computerUse" | "operation" | "automations" | "findings" | "threads" | "coordinationRole" | "coordination" | "browser" | "terminal" | "emit">;

export type ServedToolSet = { server: string; tools: BoundTool[] };

/**
 * Every app tool a run reaches, grouped by the server it is filed under and already short of what
 * the channel withholds. An engine that serves this list flat offers the same tools Claude sees.
 */
export function runTools(input: ToolSources): ServedToolSet[] {
  const sets: ServedToolSet[] = [];
  if (input.computerUse.status === "setup-required") {
    sets.push({ server: COMPUTER_USE_SETUP_SERVER_NAME, tools: computerUseSetupTools({ requestSetup: () => input.emit({ type: "computer-use.setup-required" }) }) });
  }
  if (input.automations) {
    sets.push({ server: AUTOMATION_SERVER_NAME, tools: [...automationTools(input.automations), ...(input.findings ? findingTools(input.findings) : [])] });
  }
  /** A native review is already isolated in its own Codex thread. App thread tools would create sidebar tasks instead. */
  if (input.threads && input.operation?.type !== "review") {
    /** A coordinator is woken with its threads' news, so it never holds its turn open waiting on one. */
    const tools = threadTools(input.threads);
    sets.push({ server: THREAD_SERVER_NAME, tools: input.coordinationRole === "coordinator" ? tools.filter((tool) => tool.name !== "wait_for_thread") : tools });
  }
  if (input.coordination && input.coordinationRole && input.operation?.type !== "review") sets.push({ server: COORDINATION_SERVER_NAME, tools: coordinationTools(input.coordination, input.coordinationRole) });
  if (input.browser) sets.push({ server: BROWSER_SERVER_NAME, tools: browserTools(input.browser) });
  if (input.terminal) sets.push({ server: TERMINAL_SERVER_NAME, tools: terminalTools(input.terminal) });
  return sets.map(({ server, tools }) => ({ server, tools: offeredOn(input.channel, server, tools) }));
}
