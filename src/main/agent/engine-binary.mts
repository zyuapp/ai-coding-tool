import { execFile } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentEngine } from "../../domain/agent-engine.js";
import { readVersion } from "../../domain/engine-version.js";

const run = promisify(execFile);

/** Long enough for a cold binary to answer, short enough that the model menu is not held open on one. */
const VERSION_TIMEOUT_MS = 10_000;

/** How the user got the command, which decides the command that upgrades it. */
type InstallSource = "homebrew" | "npm" | "native" | "unknown";

/** The command each engine is installed as, and how to put it there or bring it up to date. */
const ENGINE_COMMANDS: Record<AgentEngine, { command: string; install: string; upgrade: Record<InstallSource, string> }> = {
  claude: {
    command: "claude",
    install: "curl -fsSL https://claude.ai/install.sh | bash",
    upgrade: {
      homebrew: "brew update && brew upgrade --cask claude-code",
      npm: "npm install -g @anthropic-ai/claude-code@latest",
      native: "claude update",
      unknown: "claude update",
    },
  },
  codex: {
    command: "codex",
    install: "brew install --cask codex",
    upgrade: {
      homebrew: "brew update && brew upgrade --cask codex",
      npm: "npm install -g @openai/codex@latest",
      native: "brew update && brew upgrade --cask codex",
      unknown: "npm install -g @openai/codex@latest",
    },
  },
};

function isExecutable(candidate: string) {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where an engine's command sits, or nothing when the user has not installed it. `adoptLoginShellPath`
 * has already given this process the search path the user's own shell has, so this finds what they
 * would get by typing the name.
 */
export function engineBinaryPath(engine: AgentEngine): string | undefined {
  const { command } = ENGINE_COMMANDS[engine];
  for (const folder of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!folder) continue;
    const candidate = path.join(folder, command);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/** Read through the launcher symlink, since only the real file says how the command was installed. */
function installSource(binaryPath: string): InstallSource {
  let resolved = binaryPath;
  try {
    resolved = realpathSync(binaryPath);
  } catch {}
  if (resolved.includes("/Caskroom/") || resolved.includes("/Cellar/")) return "homebrew";
  if (resolved.includes("/node_modules/")) return "npm";
  if (resolved.includes("/.local/")) return "native";
  return "unknown";
}

export type InstalledEngine = {
  path: string;
  /** What `--version` printed, or nothing when the command would not answer. */
  version: string | null;
  /** The command that brings this install up to date. */
  upgrade: string;
};

/** What the app would run for an engine, with the version it reports. */
export async function installedEngine(engine: AgentEngine): Promise<InstalledEngine | undefined> {
  const binaryPath = engineBinaryPath(engine);
  if (!binaryPath) return undefined;
  const version = await run(binaryPath, ["--version"], { timeout: VERSION_TIMEOUT_MS })
    .then(({ stdout }) => readVersion(stdout))
    .catch(() => null);
  return { path: binaryPath, version, upgrade: ENGINE_COMMANDS[engine].upgrade[installSource(binaryPath)] };
}

/** What to tell a user who has no such command at all. */
export function installCommand(engine: AgentEngine): string {
  return ENGINE_COMMANDS[engine].install;
}
