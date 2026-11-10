import type { EngineCommand } from "../agent/engine-module.mjs";

export const codexBinary: EngineCommand = {
  command: "codex",
  packageName: "@openai/codex",
  install: "brew install --cask codex",
  isNative: (realPath) => realPath.includes("/packages/standalone/"),
};
