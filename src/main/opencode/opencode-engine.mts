import type { EngineModule } from "../agent/engines.mjs";

let loaded: Promise<typeof import("./opencode-services.mjs")> | undefined;
const services = () => loaded ??= import("./opencode-services.mjs");

export const openCodeEngine: EngineModule = {
  binary: {
    command: "opencode",
    packageName: "@opencode/cli",
    install: "curl -fsSL https://opencode.ai/v2/install | bash",
    isNative: (realPath) => realPath.includes("/.opencode/bin/"),
  },
  services: {
    commands: async ({ workspaceRoot }) => (await services()).openCodeServices().commands(workspaceRoot),
    suggestTitle: async (text, _images, model) => (await services()).openCodeServices().title(text, model),
    planUsage: async () => (await services()).openCodeServices().planUsage(),
    readiness: async () => (await services()).readOpenCodeReadiness(),
    update: async () => (await import("../agent/engine-binary.mjs")).upgradeEngine("opencode"),
    /** Closing never loads the services, so it never starts a server. */
    close: async () => { if (loaded) await (await loaded).closeOpenCodeServices(); },
  },
  createProvider: async ({ host, pool }) => new (await import("./opencode-agent-provider.mjs")).OpenCodeAgentProvider({ host, pool }),
};
