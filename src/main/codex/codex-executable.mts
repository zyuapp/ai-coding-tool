import { engineBinaryPath } from "../agent/engine-binary.mjs";
import { codexBinary } from "./codex-binary.mjs";

/**
 * The Codex the user installed. The app carries no copy of its own, so a machine without the command
 * cannot run Codex; `EngineAccessHost` reports that before a run is ever started.
 */
export function codexExecutable() {
  const executable = engineBinaryPath(codexBinary);
  if (!executable) throw new Error("Codex is not installed.");
  return executable;
}
