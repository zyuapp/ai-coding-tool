import type { EngineCommand } from "../agent/engine-module.mjs";

export const claudeBinary: EngineCommand = {
  command: "claude",
  packageName: "@anthropic-ai/claude-code",
  install: "curl -fsSL https://claude.ai/install.sh | bash",
  isNative: (realPath) => realPath.endsWith("/.local/bin/claude") || realPath.includes("/.local/share/claude/"),
};
