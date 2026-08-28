import { bindTools, defineTool, type ToolDefinition } from "./tool-definition.mjs";

export const COMPUTER_USE_SETUP_SERVER_NAME = "aicodingtool-computer-use";

/** Opens the app's computer-use settings for the user; the run itself can do nothing more until they finish. */
export type ComputerUseSetupBridge = { requestSetup(): void };

/** The one tool a run gets in place of computer use while the user still has to enable it. */
export const COMPUTER_USE_SETUP_TOOLS: readonly ToolDefinition<ComputerUseSetupBridge>[] = [
  defineTool({
    name: "request_setup",
    description: "Use when a task requires operating another application's interface but computer use needs to be enabled in AICodingTool. Call this rather than telling the user to install or configure anything.",
    input: {},
    readOnly: true,
    run: async (bridge) => {
      bridge.requestSetup();
      return { content: [{ type: "text", text: "AICodingTool opened Settings → Computer use. Ask the user to complete the required permissions, then retry after AICodingTool restarts." }] };
    },
  }),
];

export function computerUseSetupTools(bridge: ComputerUseSetupBridge) {
  return bindTools(bridge, COMPUTER_USE_SETUP_TOOLS);
}
