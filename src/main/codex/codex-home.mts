import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Only Codex children adopt this home; the app, Claude, and user terminals keep their environment. */
export const PRIVATE_CODEX_HOME_ENV = "AICODINGTOOL_CODEX_HOME";

/** Inputs shared with the user's Codex install. Never link runtime directories or databases. */
const SHARED_INPUTS = [
  "config.toml", "auth.json", ".env", "AGENTS.md", "AGENTS.override.md",
  "rules", "skills", "agents", "hooks", "hooks.json", "requirements.toml", "managed_config.toml",
  "plugins/cache", ".tmp/marketplaces", "mcp-oauth-locks",
];
const WRITABLE_DIRECTORIES = new Set(["plugins/cache", ".tmp/marketplaces", "mcp-oauth-locks"]);
const preparing = new Map<string, Promise<string>>();

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function share(source: string, destination: string, adoptDirectory = false) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  try {
    // A dangling link is intentional: sign-in or a later config edit creates the shared target.
    await symlink(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const target = await readlink(destination).catch(() => null);
    if (target === null && adoptDirectory && (await lstat(destination)).isDirectory()) {
      // Older launches may have created a cache. Retain it locally; the source home owns installs.
      await rename(destination, `${destination}.before-sharing-${randomUUID()}`);
      await symlink(source, destination);
      return;
    }
    if (target === null || path.resolve(path.dirname(destination), target) !== source) {
      throw new Error(`Cannot share Codex settings: ${destination} already exists and is not a link to ${source}.`);
    }
  }
}

/** MCP's file backend refuses symlinks. A hard link preserves its regular-file and shared-write
 * semantics; shared refresh locks coordinate both homes. Recheck inodes after logout/replacement. */
async function shareMcpCredentials(source: string, destination: string) {
  const original = path.join(source, ".credentials.json");
  const target = path.join(destination, ".credentials.json");
  const marker = path.join(destination, ".aicodingtool-mcp-credentials.json");
  if (!(await lstat(original).catch((error: unknown) => { if (missing(error)) return null; throw error; }))) {
    const empty = path.join(source, `.credentials-${randomUUID()}.tmp`);
    try {
      await writeFile(empty, "{}", { flag: "wx", mode: 0o600 });
      await link(empty, original).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    } finally { await unlink(empty).catch(() => {}); }
  }
  const canonical = await realpath(original);
  const sourceStat = await stat(canonical);
  const targetStat = await lstat(target).catch((error: unknown) => { if (missing(error)) return null; throw error; });
  const remember = () => writeFile(marker, JSON.stringify({ dev: sourceStat.dev, ino: sourceStat.ino }), { mode: 0o600 });
  if (targetStat?.isFile() && targetStat.dev === sourceStat.dev && targetStat.ino === sourceStat.ino) { await remember(); return; }
  if (targetStat?.isSymbolicLink() && await readlink(target) !== original) throw new Error(`Unexpected Codex credentials link: ${target}`);
  if (targetStat && !targetStat.isSymbolicLink()) {
    // Only replace a hard link from an earlier launch. An independently created credential file
    // belongs to its writer and must not be discarded during migration.
    const previous = await readFile(marker, "utf8").then((text) => JSON.parse(text) as { dev: number; ino: number }).catch(() => null);
    if (targetStat.dev !== previous?.dev || targetStat.ino !== previous?.ino) throw new Error(`Cannot share Codex MCP credentials: ${target} contains independent credentials.`);
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await link(canonical, temporary);
    await rename(temporary, target);
    await remember();
  } finally { await unlink(temporary).catch(() => {}); }
}

/** A link left by an earlier relocation is followed, and recreated if its target was removed. */
async function privateDirectory(privateHome: string) {
  const target = await readlink(privateHome).catch(() => null);
  await mkdir(target === null ? privateHome : path.resolve(path.dirname(privateHome), target), { recursive: true, mode: 0o700 });
  return realpath(privateHome);
}

/** Storage an ephemeral title run writes: databases indexing no conversation, and their logs. */
const EPHEMERAL_STORAGE = /^[a-z]+_\d+\.sqlite(-wal|-shm)?$/;

/** A home that never started Codex holds only links to shared inputs and what title runs left, so
 * nothing is lost moving it. Any session, credential, or retained cache keeps it in place. */
async function disposable(directory: string, top = true): Promise<boolean> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (top && (entry.name === "log" || EPHEMERAL_STORAGE.test(entry.name)))) continue;
    if (!entry.isDirectory() || !(await disposable(path.join(directory, entry.name), false))) return false;
  }
  return true;
}

/** Hard links cannot cross filesystems, so the private home moves into the shared home's
 * filesystem. The app data path becomes a link to it and keeps naming the same home later. Thread
 * history then lives in the shared home, so its folder says what it holds. */
async function relocate(privateHome: string, home: string, source: string) {
  const credentials = await realpath(path.join(source, ".credentials.json"));
  const unrelocatable = (from: string) => new Error(`Codex MCP sign-ins can only be shared when ${from} is on the same filesystem as ${credentials}.`);
  if ((await lstat(privateHome)).isSymbolicLink() || !(await disposable(privateHome))) throw unrelocatable(home);
  const destination = path.join(source, "aicodingtool-threads", createHash("sha256").update(path.resolve(privateHome)).digest("hex").slice(0, 16));
  await mkdir(destination, { recursive: true, mode: 0o700 });
  // Share before moving: credentials linked from a third filesystem would fail here too.
  await shareMcpCredentials(source, destination).catch((error: NodeJS.ErrnoException) => { throw error.code === "EXDEV" ? unrelocatable(destination) : error; });
  await rm(privateHome, { recursive: true });
  await symlink(destination, privateHome);
  return realpath(privateHome);
}

/** Recheck before each launch, including after logout removed a link or a profile was added. */
export async function preparePrivateCodexHome(privateHome: string, sourceHome: string): Promise<string> {
  const key = path.resolve(privateHome);
  const previous = preparing.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => prepare(privateHome, sourceHome));
  preparing.set(key, next);
  try { return await next; } finally { if (preparing.get(key) === next) preparing.delete(key); }
}

async function prepare(privateHome: string, sourceHome: string) {
  await mkdir(sourceHome, { recursive: true, mode: 0o700 });
  const home = await privateDirectory(privateHome);
  const source = await realpath(sourceHome).catch((error: unknown) => {
    if (missing(error)) return path.resolve(sourceHome);
    throw error;
  });
  if (source === home) throw new Error("Private Codex storage must be separate from the shared Codex home.");
  const destination = await shareMcpCredentials(source, home).then(() => home, (error: NodeJS.ErrnoException) => {
    if (error.code !== "EXDEV") throw error;
    return relocate(privateHome, home, source);
  });
  const entries = await readdir(source).catch((error: unknown) => {
    if (missing(error)) return [];
    throw error;
  });
  const names = [...SHARED_INPUTS, ...entries.filter((name) => name.endsWith(".config.toml"))];
  await Promise.all(names.map(async (name) => {
    const writable = WRITABLE_DIRECTORIES.has(name);
    if (writable) await mkdir(path.join(source, name), { recursive: true, mode: 0o700 });
    await share(path.join(source, name), path.join(destination, name), writable);
  }));
  return destination;
}

/** Where Codex children keep their state, prepared for launch, or undefined when they use the user's home. */
export async function privateCodexHome(environment: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const privateHome = environment[PRIVATE_CODEX_HOME_ENV];
  return privateHome ? preparePrivateCodexHome(privateHome, sharedCodexHome(environment)) : undefined;
}

export async function codexChildEnvironment(environment: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const home = await privateCodexHome(environment);
  return home ? { ...environment, CODEX_HOME: home, CODEX_SQLITE_HOME: home } : environment;
}

export function sharedCodexHome(environment: NodeJS.ProcessEnv = process.env) {
  return environment.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
}
