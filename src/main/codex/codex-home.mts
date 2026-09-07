import { mkdir, readdir, readlink, realpath, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Only Codex children adopt this home; the app, Claude, and user terminals keep their environment. */
export const PRIVATE_CODEX_HOME_ENV = "AICODINGTOOL_CODEX_HOME";

/** Inputs shared with the user's Codex install. Never link runtime directories or databases. */
const SHARED_INPUTS = [
  "config.toml", "auth.json", ".credentials.json", "AGENTS.md", "AGENTS.override.md",
  "rules", "skills", "agents", "hooks.json", "requirements.toml", "managed_config.toml",
];

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function share(source: string, destination: string) {
  try {
    // A dangling link is intentional: sign-in or a later config edit creates the shared target.
    await symlink(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const target = await readlink(destination).catch(() => null);
    if (target === null || path.resolve(path.dirname(destination), target) !== source) {
      throw new Error(`Cannot share Codex settings: ${destination} already exists and is not a link to ${source}.`);
    }
  }
}

/** Recheck before each launch, including after logout removed a link or a profile was added. */
export async function preparePrivateCodexHome(privateHome: string, sourceHome: string) {
  await mkdir(privateHome, { recursive: true, mode: 0o700 });
  const destination = await realpath(privateHome);
  const source = await realpath(sourceHome).catch((error: unknown) => {
    if (missing(error)) return path.resolve(sourceHome);
    throw error;
  });
  if (source === destination) throw new Error("Private Codex storage must be separate from the shared Codex home.");
  const entries = await readdir(source).catch((error: unknown) => {
    if (missing(error)) return [];
    throw error;
  });
  const names = [...SHARED_INPUTS, ...entries.filter((name) => name.endsWith(".config.toml"))];
  await Promise.all(names.map((name) => share(path.join(source, name), path.join(destination, name))));
  return destination;
}

export async function codexChildEnvironment(environment: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const privateHome = environment[PRIVATE_CODEX_HOME_ENV];
  if (!privateHome) return environment;
  const source = environment.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
  const home = await preparePrivateCodexHome(privateHome, source);
  return { ...environment, CODEX_HOME: home, CODEX_SQLITE_HOME: home };
}
