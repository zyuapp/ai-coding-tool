import type { EngineReadiness } from "../../domain/agent-engine.js";
import { isOlderThan } from "../../domain/engine-version.js";
import { installCommand, installedEngine } from "../agent/engine-binary.mjs";
import { versionReadiness } from "../agent/engine-readiness.mjs";
import { CODEX_PROTOCOL_VERSION } from "./protocol/version.js";

/**
 * Codex speaks the protocol its own version generated, and the app holds one generated copy of it, so
 * a command older than that copy is turned away rather than asked to answer messages it lacks.
 */
export async function readCodexReadiness(): Promise<EngineReadiness> {
  const installed = await installedEngine("codex");
  if (!installed) return { access: "missing", fix: installCommand("codex") };
  const version = versionReadiness("codex", installed, CODEX_PROTOCOL_VERSION);
  if (isOlderThan(installed.version, CODEX_PROTOCOL_VERSION)) return { access: "outdated", ...await version };
  const { readCodexAccess } = await import("./codex-account.mjs");
  const [access, known] = await Promise.all([readCodexAccess(), version]);
  return { access, ...known };
}
