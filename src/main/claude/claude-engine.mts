import type { EngineModule } from "../agent/engine-module.mjs";
import { claudeBinary } from "./claude-binary.mjs";

export const claudeEngine: EngineModule = {
  binary: claudeBinary,
  services: {
    commands: async ({ workspaceRoot, projectless }) => (await import("./claude-agent-provider.mjs")).discoverClaudeCommands(workspaceRoot, projectless),
    suggestTitle: async (text, images) => (await import("./claude-title-writer.mjs")).suggestTaskTitle(text, images),
    planUsage: async () => (await import("./claude-plan-usage.mjs")).readPlanUsage(),
    readiness: async () => (await import("./claude-readiness.mjs")).readClaudeReadiness(),
    update: async () => (await import("../agent/engine-binary.mjs")).upgradeEngine(claudeBinary),
    subagentMetadata: async (id, sessionId) => (await import("./claude-subagent-metadata.mjs")).readClaudeSubagentMetadata(id, sessionId),
  },
  createProvider: async ({ pool }) => new (await import("./claude-agent-provider.mjs")).ClaudeAgentProvider({ pool }),
};
