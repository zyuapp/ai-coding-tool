import type { EngineModule } from "../agent/engines.mjs";

export const claudeEngine: EngineModule = {
  binary: {
    command: "claude",
    packageName: "@anthropic-ai/claude-code",
    install: "curl -fsSL https://claude.ai/install.sh | bash",
    isNative: (realPath) => realPath.endsWith("/.local/bin/claude") || realPath.includes("/.local/share/claude/"),
  },
  services: {
    commands: async ({ workspaceRoot, projectless }) => (await import("./claude-agent-provider.mjs")).discoverClaudeCommands(workspaceRoot, projectless),
    suggestTitle: async (text, images) => (await import("./claude-title-writer.mjs")).suggestTaskTitle(text, images),
    planUsage: async () => (await import("./claude-plan-usage.mjs")).readPlanUsage(),
    readiness: async () => (await import("./claude-readiness.mjs")).readClaudeReadiness(),
    update: async () => (await import("../agent/engine-binary.mjs")).upgradeEngine("claude"),
    subagentMetadata: async (id, sessionId) => (await import("./claude-subagent-metadata.mjs")).readClaudeSubagentMetadata(id, sessionId),
  },
  createProvider: async ({ pool }) => new (await import("./claude-agent-provider.mjs")).ClaudeAgentProvider({ pool }),
};
