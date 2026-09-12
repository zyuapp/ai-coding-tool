import { computerOfWorkspace } from "../application/computers.js";
import type { ComputerQuery } from "../contracts/computers.js";
import type { AvailableCommand } from "../contracts/ipc.js";
import type { AgentEngine } from "../domain/agent-engine.js";
import { answerComputerQuery } from "./computer-queries.js";
import type { ComputerLinks } from "./computers/computer-links.mjs" with { "resolution-mode": "import" };
import type { WorkspaceHooks } from "./mobile/mobile-server.mjs" with { "resolution-mode": "import" };
import type { WorkspaceService } from "./workspace/workspace-service.mjs" with { "resolution-mode": "import" };
import type { WorkspaceRuntimeHost } from "./workspace-runtime-host.js";

export type ComputerBridgeHost = {
  runtime: WorkspaceRuntimeHost;
  workspaces: () => WorkspaceService;
  commands: (workspaceId: string, engine: AgentEngine) => Promise<AvailableCommand[]>;
  /** The lines to the paired computers, once they are up. */
  links: () => ComputerLinks | null;
};

/** Both ends of the computer-to-computer line: what a paired computer is handed here, and where one of its checkouts is read from. */
export function createComputerBridge(host: ComputerBridgeHost) {
  const { publisher } = host.runtime;
  /** What a paired computer is handed: this workspace whole, driven in the window's own inputs. */
  const hooks: WorkspaceHooks = {
    snapshot: () => publisher.snapshot(),
    subscribe: (listener) => publisher.subscribe(listener),
    input: async (inputs) => {
      let result = { ok: true as const, revision: publisher.revision };
      for (const input of inputs) {
        const answered = await publisher.request(input);
        if (!answered.ok) return answered;
        result = { ...result, ...answered, ok: true };
      }
      return result;
    },
    query: (query) => answerComputerQuery(query, {
      workspaces: host.workspaces,
      commands: async (workspaceId, engine) => {
        try {
          return { status: "available", commands: await host.commands(workspaceId, engine) };
        } catch (error) {
          return { status: "error", message: error instanceof Error ? error.message : String(error) };
        }
      },
    }),
  };
  /** Where a checkout on a paired computer is read from: that computer, over its line. */
  function elsewhere(workspaceId: string): ((query: ComputerQuery) => Promise<unknown>) | null {
    const computer = computerOfWorkspace(host.runtime.runtime.getState(), workspaceId);
    const links = host.links();
    return computer && links ? (query) => links.query(computer.id, query) : null;
  }
  return { hooks, elsewhere };
}
