import type { RuntimePublisher } from "../host/runtime-publisher.js";
import type { ComputerReads } from "./computer-queries.js";
import type { WorkspaceHooks } from "./mobile/mobile-server.mjs" with { "resolution-mode": "import" };

export type ComputerBridgeHost = {
  publisher: RuntimePublisher;
  reads: ComputerReads;
  /** What this computer calls itself to the computers it hands the workspace to. */
  name: () => string;
};

/** What a paired computer is handed here: this workspace whole, driven in the window's own inputs, and read the way the window reads it. */
export function createComputerBridge(host: ComputerBridgeHost): WorkspaceHooks {
  const { publisher } = host;
  return {
    name: host.name,
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
    query: (query) => host.reads.answer(query),
  };
}
