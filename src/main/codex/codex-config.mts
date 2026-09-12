import { grantsTool } from "../agent/approval-grant.mjs";
import type { ProviderRunInput } from "../agent/agent-provider.mjs";
import type { ServedTools } from "../tools/mcp-http-host.mjs";

/** The name Codex files the app's own tools under. */
export const APP_SERVER_NAME = "aicodingtool";
/** Where the app server finds the bearer token for the app's tool service. */
export const TOOL_TOKEN_ENV = "AICODINGTOOL_MCP_TOKEN";
export const COMPUTER_USE_SERVER_NAME = "cua-driver";

type TomlTable = Readonly<{ [key: string]: TomlValue }>;
type TomlValue = string | boolean | number | readonly TomlValue[] | TomlTable;

/** These bundled plugins target Codex's desktop surfaces. User plugins retain their own settings. */
const APP_SURFACE_PLUGINS = ["browser", "chrome", "computer-use", "unified-computer-use", "codex-app-tools"];

const ESCAPED: Record<string, string> = { "\\": "\\\\", "\"": "\\\"", "\n": "\\n", "\r": "\\r", "\t": "\\t" };

function tomlString(value: string) {
  return `"${value.replace(/[\\"\u0000-\u001f\u007f]/g, (char) => ESCAPED[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
}

/** One TOML value, as `-c key=value` takes it. */
export function toml(value: TomlValue): string {
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${(value as readonly TomlValue[]).map(toml).join(", ")}]`;
  const entries = Object.entries(value as TomlTable).map(([key, entry]) => `${tomlString(key)} = ${toml(entry)}`);
  return entries.length ? `{ ${entries.join(", ")} }` : "{}";
}

export const APP_FEATURES = ["--enable", "fast_mode", "--enable", "goals", "--enable", "default_mode_request_user_input",
  "-c", `plugins=${toml(Object.fromEntries(APP_SURFACE_PLUGINS.map((name) => [`${name}@openai-bundled`, { enabled: false }])) )}`,
];

export type ConfigSources = Pick<ProviderRunInput, "channel" | "policy" | "computerUse">;

/**
 * The config overrides a Codex app server is spawned with. The app's own tools are served by the
 * app and pre-approved: they reach nothing but the app's own bridges. Bundled computer use prompts
 * like any other MCP server, except where the run's policy grants it unasked.
 */
export function codexConfig(input: ConfigSources, served: ServedTools | undefined): string[] {
  const config: Record<string, TomlValue> = {};
  if (served) {
    config[`mcp_servers.${APP_SERVER_NAME}.url`] = served.url;
    config[`mcp_servers.${APP_SERVER_NAME}.bearer_token_env_var`] = TOOL_TOKEN_ENV;
    config[`mcp_servers.${APP_SERVER_NAME}.default_tools_approval_mode`] = "approve";
  }
  if (input.computerUse.status === "available") {
    const { command, args, env } = input.computerUse.mcp;
    config[`mcp_servers.${COMPUTER_USE_SERVER_NAME}.command`] = command;
    config[`mcp_servers.${COMPUTER_USE_SERVER_NAME}.args`] = args;
    config[`mcp_servers.${COMPUTER_USE_SERVER_NAME}.env`] = env;
    if (grantsTool("computer-use", input)) config[`mcp_servers.${COMPUTER_USE_SERVER_NAME}.default_tools_approval_mode`] = "approve";
  }
  return [...APP_FEATURES, ...Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${toml(value)}`])];
}
