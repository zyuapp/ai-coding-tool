import type { EngineModule } from "../agent/engines.mjs";

export const codexEngine: EngineModule = {
  binary: {
    command: "codex",
    packageName: "@openai/codex",
    install: "brew install --cask codex",
    isNative: (realPath) => realPath.includes("/packages/standalone/"),
  },
  services: {
    commands: async (workspace) => {
      const { discoverCodexCommands } = await import("./codex-skills.mjs");
      return [
        { name: "goal", description: "Set a goal — keep working until the condition is met", argumentHint: "condition" },
        ...await discoverCodexCommands(workspace.workspaceRoot),
      ];
    },
    suggestTitle: async (text, images) => (await import("./codex-title-writer.mjs")).suggestCodexTitle(text, images),
    planUsage: async () => (await import("./codex-plan-usage.mjs")).readCodexPlanUsage(),
    readiness: async () => (await import("./codex-readiness.mjs")).readCodexReadiness(),
    update: async () => (await import("../agent/engine-binary.mjs")).upgradeEngine("codex"),
    signIn: async (openUrl) => (await import("./codex-account.mjs")).signInToCodex(openUrl),
    subagentMetadata: async (id) => (await import("./codex-subagent-metadata.mjs")).readCodexSubagentMetadata(id),
  },
  createProvider: async ({ host, pool, generatedImages }) => {
    const [{ CodexAgentProvider }, { codexImageOutput }] = await Promise.all([import("./codex-agent-provider.mjs"), import("./codex-images.mjs")]);
    return new CodexAgentProvider({ host, pool, imageOutput: (item, root) => codexImageOutput(item, root, generatedImages) });
  },
};
