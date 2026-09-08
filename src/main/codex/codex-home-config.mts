import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse, type TomlTable } from "smol-toml";
import { toml } from "./codex-config.mjs";

/** Read only user-owned config. Codex still validates and merges every config layer itself. */
export async function readHomeConfig(home: string): Promise<TomlTable> {
  try { return parse(await readFile(path.join(home, "config.toml"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function table(value: unknown): TomlTable {
  return value && typeof value === "object" && !Array.isArray(value) ? value as TomlTable : {};
}

/** Keep file references anchored to the config that declared them, including custom agent layers. */
export function privateHomeConfig(config: TomlTable, source: string, destination: string): string[] {
  const overrides: string[] = [];
  const set = (key: string, value: string | boolean) => overrides.push("-c", `${key}=${toml(value)}`);
  for (const key of ["model_instructions_file", "experimental_compact_prompt_file", "model_catalog_json"]) {
    const value = config[key];
    if (typeof value === "string" && value && !path.isAbsolute(value)) set(key, path.resolve(source, value));
  }
  const agents: Record<string, { config_file: string }> = {};
  for (const [name, agent] of Object.entries(table(config.agents))) {
    const file = table(agent).config_file;
    if (typeof file === "string" && file && !path.isAbsolute(file)) agents[name] = { config_file: path.resolve(source, file) };
  }
  if (Object.keys(agents).length) overrides.push("-c", `agents=${toml(agents)}`);
  // Trust hashes still refer to the exact same definition. Only the source-path part of the key
  // changes. Never invent a hash, approve a new hook, or write aliases into the user's config.
  const states: Record<string, Record<string, string | boolean>> = {};
  for (const [key, state] of Object.entries(table(table(config.hooks).state))) {
    if (!key.startsWith(`${source}${path.sep}`)) continue;
    const alias = `${destination}${key.slice(source.length)}`;
    for (const field of ["trusted_hash", "enabled"]) {
      const value = table(state)[field];
      if (typeof value === "string" || typeof value === "boolean") (states[alias] ??= {})[field] = value;
    }
  }
  // Codex splits the left side of -c on every dot, even inside quotes. Literal hook paths and
  // custom role names must therefore be keys in a TOML value, not dotted override paths.
  if (Object.keys(states).length) overrides.push("-c", `hooks.state=${toml(states)}`);
  return overrides;
}

export function usesSharedKeyring(config: TomlTable) {
  return config.cli_auth_credentials_store === "keyring" || config.cli_auth_credentials_store === "auto";
}

export function encryptedMcpCredentials(config: TomlTable) {
  return table(config.features).secret_auth_storage === true && config.mcp_oauth_credentials_store !== "file";
}
