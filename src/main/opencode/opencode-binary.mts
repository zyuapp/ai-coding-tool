import type { EngineCommand } from "../agent/engine-module.mjs";

export const openCodeBinary: EngineCommand = {
  command: "opencode",
  packageName: "@opencode/cli",
  install: "curl -fsSL https://opencode.ai/v2/install | bash",
  isNative: (realPath) => realPath.includes("/.opencode/bin/"),
};
