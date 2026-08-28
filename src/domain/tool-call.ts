/**
 * What a tool call did, in one line. A call is stored as its tool name and the JSON it was given,
 * so a run of fifteen shell commands reads as fifteen rows of "Bash". The argument is the only part
 * that tells one call from the next, so the view leads with it and the name becomes a glyph.
 */

import type { AgentEngine } from "./agent-engine.js";

export type ToolFamily = "shell" | "read" | "write" | "search" | "web" | "agent" | "other";

export type ToolCall = {
  family: ToolFamily;
  /** Marks the argument as what it is, where a bare string would not read as one: `$` for a command. */
  sigil?: string;
  /** Empty when the call carried nothing worth naming; the view falls back to the tool name. */
  argument: string;
};

/** How one engine names its tools: which name is which family, and which argument keys name a call. */
type ToolNaming = {
  families: Record<string, ToolFamily>;
  /** Argument keys in the order they identify a call, so the first one present is the one to show. */
  namingKeys: readonly string[];
};

const NAMING: Record<AgentEngine, ToolNaming> = {
  claude: {
    families: {
      Bash: "shell", BashOutput: "shell", KillShell: "shell",
      Read: "read", NotebookRead: "read",
      Write: "write", Edit: "write", MultiEdit: "write", NotebookEdit: "write",
      Grep: "search", Glob: "search", ToolSearch: "search",
      WebFetch: "web", WebSearch: "web",
      Agent: "agent", Task: "agent", Skill: "agent", Workflow: "agent", SendMessage: "agent",
    },
    namingKeys: ["command", "file_path", "notebook_path", "pattern", "query", "url", "path", "description", "prompt", "skill", "name"],
  },
  /** Codex reports item kinds rather than tool names; its session emits them in snake case. */
  codex: {
    families: {
      command_execution: "shell",
      file_change: "write",
      web_search: "web",
      mcp_tool_call: "other",
      todo_list: "other",
    },
    namingKeys: ["command", "path", "query"],
  },
};

/** Longer than any row can show, and short enough that a heredoc cannot bloat the transcript. */
const ARGUMENT_LIMIT = 240;

/** Our own MCP tools carry the same names whichever engine calls them. */
function ownToolFamily(name: string): ToolFamily | undefined {
  if (name.startsWith("browser_") || name.startsWith("mcp__aicodingtool-browser")) return "web";
  return undefined;
}

export function toolFamily(engine: AgentEngine, name: string): ToolFamily {
  const naming = NAMING[engine];
  return naming.families[name] ?? ownToolFamily(name) ?? "other";
}

/** Path segments beyond the last two say where a repo lives, not which file the call touched. */
function shortPath(value: string): string {
  const segments = value.split("/").filter(Boolean);
  if (!value.startsWith("/") || segments.length <= 2) return value;
  return `…/${segments.slice(-2).join("/")}`;
}

function oneLine(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > ARGUMENT_LIMIT ? `${flat.slice(0, ARGUMENT_LIMIT - 1)}…` : flat;
}

/** The first named key the input carries, else its only string value, else nothing. */
function namingValue(namingKeys: readonly string[], input: Record<string, unknown>): { key: string; value: string } | null {
  for (const key of namingKeys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return { key, value: value.trim() };
  }
  const strings = Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0);
  return strings.length === 1 ? { key: strings[0][0], value: strings[0][1].trim() } : null;
}

export function describeToolCall(engine: AgentEngine, name: string, detail?: string): ToolCall {
  const family = toolFamily(engine, name);
  const input = parseInput(detail);
  const naming = input && namingValue(NAMING[engine].namingKeys, input);
  if (!naming) return { family, argument: "" };
  const isPath = naming.key.endsWith("path") || naming.key === "file_path";
  const argument = oneLine(isPath ? shortPath(naming.value) : naming.value);
  /** A search says what it looked for and where, which two rows of the same pattern cannot. */
  const scope = family === "search" && typeof input.path === "string" && input.path.trim() ? ` in ${shortPath(input.path.trim())}` : "";
  return { family, ...(family === "shell" ? { sigil: "$" } : {}), argument: `${argument}${scope}` };
}

function parseInput(detail?: string): Record<string, unknown> | null {
  if (!detail) return null;
  try {
    const parsed: unknown = JSON.parse(detail);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
