import { engineBinaryPath } from "../agent/engine-binary.mjs";

/**
 * The Codex the user installed. The app carries no copy of its own, so a machine without the command
 * cannot run Codex; `EngineAccessHost` reports that before a run is ever started.
 */
export function codexExecutable() {
  const executable = engineBinaryPath("codex");
  if (!executable) throw new Error("Codex is not installed.");
  return executable;
}
