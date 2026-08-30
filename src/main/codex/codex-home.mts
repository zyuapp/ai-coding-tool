import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Passed through the app's processes; Codex itself only receives CODEX_HOME. */
export const PRIVATE_CODEX_HOME_ENV = "AICODINGTOOL_CODEX_HOME";

function isConfigFile(name: string) {
  return name === "config.toml" || name.endsWith(".config.toml");
}

async function configFiles(directory: string) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && isConfigFile(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Gives this app a persistent Codex state root. Durable user settings are refreshed from the
 * normal Codex home on every launch, while auth, sessions, logs, and indexes remain app-private.
 */
export async function preparePrivateCodexHome(userData: string, sourceHome = path.join(homedir(), ".codex")) {
  const privateHome = path.join(userData, "codex");
  await mkdir(privateHome, { recursive: true });
  const [sourceConfigs, privateConfigs] = await Promise.all([configFiles(sourceHome), configFiles(privateHome)]);
  const sourceNames = new Set(sourceConfigs);
  await Promise.all([
    ...sourceConfigs.map((name) => copyFile(path.join(sourceHome, name), path.join(privateHome, name))),
    ...privateConfigs.filter((name) => !sourceNames.has(name)).map((name) => rm(path.join(privateHome, name))),
  ]);
  return privateHome;
}

/** Keeps CODEX_HOME out of the app and its terminal, adding it only to Codex child processes. */
export function codexChildEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const privateHome = environment[PRIVATE_CODEX_HOME_ENV];
  return privateHome
    ? { ...environment, CODEX_HOME: privateHome, CODEX_SQLITE_HOME: privateHome }
    : environment;
}
