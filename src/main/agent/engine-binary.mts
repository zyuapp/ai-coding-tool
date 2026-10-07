import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentEngine } from "../../domain/agent-engine.js";
import { readVersion } from "../../domain/engine-version.js";

const run = promisify(execFile);

/** Long enough for a cold binary to answer, short enough that the model menu is not held open on one. */
const VERSION_TIMEOUT_MS = 10_000;

/** Long enough for a package manager to download and replace a release. */
const UPGRADE_TIMEOUT_MS = 10 * 60_000;

/** Releases come out daily at most, so an hour old answer about the newest one is fresh enough. */
const LATEST_TTL_MS = 60 * 60_000;
const LATEST_TIMEOUT_MS = 4_000;
const HOMEBREW_INFO_TIMEOUT_MS = 10_000;

/** The command each engine is installed as, the npm package it is published as, and how to install it. */
const ENGINE_COMMANDS: Record<AgentEngine, { command: string; packageName: string; install: string; isNative: (realPath: string) => boolean }> = {
  claude: {
    command: "claude",
    packageName: "@anthropic-ai/claude-code",
    install: "curl -fsSL https://claude.ai/install.sh | bash",
    isNative: (realPath) => realPath.endsWith("/.local/bin/claude") || realPath.includes("/.local/share/claude/"),
  },
  codex: {
    command: "codex",
    packageName: "@openai/codex",
    install: "brew install --cask codex",
    isNative: (realPath) => realPath.includes("/packages/standalone/"),
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

/** How an install is brought up to date: what the user would type, and the program and arguments the app runs. */
export type EngineUpdater = { command: string; file: string; args: string[] };

type HomebrewKeg = { kind: "formula" | "cask"; name: string; prefix: string };

/** `<prefix>/Cellar/<name>/<version>/…` or `<prefix>/Caskroom/<name>/<version>/…`. */
const HOMEBREW_KEG = /^(.*)\/(cellar|caskroom)\/([^/]+)\/[^/]+\//i;

function homebrewKeg(realPath: string): HomebrewKeg | null {
  const match = HOMEBREW_KEG.exec(realPath);
  if (!match) return null;
  return { kind: match[2]!.toLowerCase() === "cellar" ? "formula" : "cask", name: match[3]!, prefix: match[1]! };
}

/**
 * The npm prefix a global install of the package sits under. A package nested in another one's
 * `node_modules` belongs to a project, and one inside a mise tool other than Node is mise's.
 */
function npmPrefix(realPath: string, packageName: string): string | null {
  const index = realPath.lastIndexOf(`/lib/node_modules/${packageName}/`);
  if (index < 0 || realPath.slice(0, index).includes("/node_modules/")) return null;
  const miseTool = /\/mise\/installs\/([^/]+)\/[^/]+$/.exec(realPath.slice(0, index))?.[1];
  if (miseTool && miseTool !== "node") return null;
  return index === 0 ? "/" : realPath.slice(0, index);
}

const isMise = (filePath: string) => filePath.includes("/mise/installs/") || filePath.includes("/mise/shims/");

/** A launcher is a few lines; anything bigger is the engine itself and is not read. */
const MAX_LAUNCHER_BYTES = 16 * 1024;

/** A launcher script that runs the engine through mise (`exec mise x codex -- codex`), which mise keeps. */
function isMiseLauncher(filePath: string) {
  try {
    if (statSync(filePath).size > MAX_LAUNCHER_BYTES) return false;
    const script = readFileSync(filePath, "utf8");
    return script.startsWith("#!") && /\bmise\s+(?:x|exec)\b/.test(script);
  } catch {
    return false;
  }
}

/** The tool beside an install, which belongs to it, or the one on the search path when there is none. */
function besideOrOnPath(prefix: string, tool: string) {
  const beside = path.join(prefix, "bin", tool);
  return isExecutable(beside) ? beside : tool;
}

/**
 * How this install is brought up to date, or null when the app cannot tell and leaves it to the user.
 * Each package manager is only used on an install the path proves it made, so the app never upgrades
 * a copy it did not find. The engine's own updater covers its native install, and any other the path
 * does not place inside a package manager or a version manager.
 */
function updaterFor(engine: AgentEngine, binaryPath: string, realPath: string): EngineUpdater | null {
  const { command, packageName, isNative } = ENGINE_COMMANDS[engine];
  const native = { command: `${command} update`, file: binaryPath, args: ["update"] };
  /** A mise launcher can sit where the native install would, so it is ruled out first. */
  if (isMiseLauncher(realPath)) return null;
  const prefix = npmPrefix(realPath, packageName);
  if (prefix) {
    /** npm 12 skips install scripts unless allowed, and Claude Code's finishes its install. Older npm warns and goes on. */
    return { command: `npm install -g ${packageName}@latest`, file: besideOrOnPath(prefix, "npm"), args: ["install", "-g", "--prefix", prefix, `--allow-scripts=${packageName}`, `${packageName}@latest`] };
  }
  if (isMise(realPath) || isMise(binaryPath)) return null;
  if (isNative(realPath) || isNative(binaryPath)) return native;
  const keg = homebrewKeg(realPath);
  if (keg) {
    const args = keg.kind === "cask" ? ["upgrade", "--cask", keg.name] : ["upgrade", keg.name];
    return { command: ["brew", ...args].join(" "), file: besideOrOnPath(keg.prefix, "brew"), args };
  }
  return realPath.includes("/node_modules/") ? null : native;
}

export type InstalledEngine = {
  path: string;
  /** What `--version` printed, or nothing when the command would not answer. */
  version: string | null;
  /** How to bring this install up to date, or null when only the user can. */
  update: EngineUpdater | null;
  /** Where its newest release is read from: the Homebrew keg it sits in, or npm. */
  keg: HomebrewKeg | null;
};

/** What the app would run for an engine, with the version it reports. */
export async function installedEngine(engine: AgentEngine): Promise<InstalledEngine | undefined> {
  const binaryPath = engineBinaryPath(engine);
  if (!binaryPath) return undefined;
  let realPath = binaryPath;
  try {
    realPath = realpathSync(binaryPath);
  } catch {}
  const version = await run(binaryPath, ["--version"], { timeout: VERSION_TIMEOUT_MS })
    .then(({ stdout }) => readVersion(stdout))
    .catch(() => null);
  return { path: binaryPath, version, update: updaterFor(engine, binaryPath, realPath), keg: homebrewKeg(realPath) };
}

/** What to tell a user who has no such command at all. */
export function installCommand(engine: AgentEngine): string {
  return ENGINE_COMMANDS[engine].install;
}

const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
const latestReads = new Map<string, { expires: number; version: Promise<string | null> }>();

/** Asked once an hour per source, failures included, so a machine offline at launch does not ask on every read. */
function cachedLatest(key: string, read: () => Promise<string | null>): Promise<string | null> {
  const cached = latestReads.get(key);
  if (cached && cached.expires > Date.now()) return cached.version;
  const version = read().catch(() => null);
  latestReads.set(key, { expires: Date.now() + LATEST_TTL_MS, version });
  return version;
}

async function npmLatest(packageName: string): Promise<string | null> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(LATEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const { version } = await response.json() as { version?: unknown };
  return typeof version === "string" && STABLE_VERSION.test(version) ? version : null;
}

/** A cask's version can carry a build after a comma (`1.2.3,456`). */
async function homebrewLatest(keg: HomebrewKeg): Promise<string | null> {
  const { stdout } = await run(besideOrOnPath(keg.prefix, "brew"), ["info", "--json=v2", keg.name], { timeout: HOMEBREW_INFO_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  const info = JSON.parse(stdout) as { formulae?: Array<{ versions?: { stable?: string } }>; casks?: Array<{ version?: string }> };
  const version = keg.kind === "formula" ? info.formulae?.[0]?.versions?.stable : info.casks?.[0]?.version?.split(",", 1)[0];
  return version && STABLE_VERSION.test(version) ? version : null;
}

/**
 * The newest release this install could move to, or null when it cannot be read. Homebrew lags npm
 * by hours, so a Homebrew install is compared with what `brew upgrade` can deliver.
 */
export function latestEngineVersion(engine: AgentEngine, installed: InstalledEngine): Promise<string | null> {
  const { keg } = installed;
  if (keg) return cachedLatest(`brew:${keg.name}`, () => homebrewLatest(keg));
  const { packageName } = ENGINE_COMMANDS[engine];
  return cachedLatest(`npm:${packageName}`, () => npmLatest(packageName));
}

/**
 * Brings an installed engine up to date the way the user installed it. Throws with what the command
 * said when it fails, and the command to run by hand; the caller names the engine.
 */
export async function upgradeEngine(engine: AgentEngine): Promise<void> {
  const installed = await installedEngine(engine);
  if (!installed) throw new Error(`${ENGINE_COMMANDS[engine].command} is not installed.`);
  if (!installed.update) throw new Error("The app cannot tell how it was installed. Update it the way you installed it.");
  try {
    await run(installed.update.file, installed.update.args, { timeout: UPGRADE_TIMEOUT_MS });
  } catch (error) {
    /** Package managers sign off with where their log went, so the line naming the error says more than the last one. */
    const lines = ((error as { stderr?: string }).stderr ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
    const output = lines.find((line) => /error/i.test(line)) ?? lines.at(-1);
    throw new Error(`${output ? `${output.replace(/[.\s]+$/, "")}. ` : ""}Run \`${installed.update.command}\` in your terminal.`);
  }
}
