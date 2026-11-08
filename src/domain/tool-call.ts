/**
 * What a tool call did, in one line. A call is stored as its tool name and the JSON it was given,
 * so a run of fifteen shell commands reads as fifteen rows of "Bash". The argument is the only part
 * that tells one call from the next, so the view leads with it and the name becomes a glyph.
 */

import { isAgentEngine, type AgentEngine, type EngineId } from "./agent-engine.js";

export type ToolFamily = "shell" | "read" | "write" | "search" | "web" | "agent" | "thread" | "automation" | "other";

export type ToolCall = {
  family: ToolFamily;
  /** What the row calls the tool: a plain verb for the app's own tools, the tool's own name otherwise. */
  label: string;
  /** The label says what the call did, so a row shows it even where a run of one tool would drop the name. */
  verb?: true;
  /** Marks the argument as what it is, where a bare string would not read as one: `$` for a command. */
  sigil?: string;
  /** Empty when the call carried nothing worth naming; the view falls back to the label. */
  argument: string;
  /** The thread the call is about, as the call named it: an ID, a prefix of one, or a title. */
  thread?: string;
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
    },
    namingKeys: ["command", "path", "query"],
  },
  opencode: {
    families: {
      shell: "shell",
      read: "read",
      write: "write", edit: "write", apply_patch: "write", patch: "write", multiedit: "write",
      glob: "search", grep: "search", list: "search",
      webfetch: "web", websearch: "web",
      subagent: "agent", task: "agent", skill: "agent",
    },
    namingKeys: ["command", "filePath", "pattern", "url", "query", "path", "description", "prompt", "name"],
  },
};

/**
 * How a thread on an engine only a newer build on a paired computer knows is read here: no tool is of
 * a family this build can tell, and a call is named by whichever common argument it carries.
 */
const GENERIC_NAMING: ToolNaming = { families: {}, namingKeys: ["command", "file_path", "path", "pattern", "url", "query"] };

function namingOf(engine: EngineId): ToolNaming {
  return isAgentEngine(engine) ? NAMING[engine] : GENERIC_NAMING;
}

/** Longer than any row can show, and short enough that a heredoc cannot bloat the transcript. */
const ARGUMENT_LIMIT = 240;

type Input = Record<string, unknown>;

/** How one of the app's own tools reads: a verb, and the input that says what it acted on. */
type OwnTool = { family: ToolFamily; label: string; argument?: (input: Input) => string | undefined; thread?: true };

const text = (key: string) => (input: Input) => {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value : undefined;
};

/**
 * The app's own tools carry the same names whichever engine calls them: Claude files them under an
 * `aicodingtool-*` server, Codex and OpenCode by their bare name.
 */
const OWN_TOOLS: Record<string, OwnTool> = {
  list_threads: { family: "thread", label: "List threads", argument: text("search") },
  read_thread: { family: "thread", label: "Read thread", thread: true },
  wait_for_thread: { family: "thread", label: "Wait for thread", thread: true },
  start_thread: { family: "thread", label: "Start thread", argument: (input) => text("title")(input) ?? text("prompt")(input) },
  message_thread: { family: "thread", label: "Message thread", thread: true, argument: text("text") },
  set_thread_role: { family: "thread", label: "Set role", thread: true, argument: (input) => text("role")(input) ?? "No role" },
  archive_thread: { family: "thread", label: "Archive thread", thread: true },
  stop_thread: { family: "thread", label: "Stop thread", thread: true },
  move_to_worktree: { family: "thread", label: "Move to worktree", thread: true, argument: (input) => input.worktreeId === "new" ? "New worktree" : text("worktreeId")(input) ?? "Project checkout" },
  delete_worktree: { family: "thread", label: "Delete worktree", argument: text("worktreeId") },
  report_status: { family: "thread", label: "Report status", argument: (input) => [text("state")(input), text("summary")(input)].filter(Boolean).join(" · ") },
  raise_decision: { family: "thread", label: "Ask for a decision", argument: text("question") },
  remember: { family: "thread", label: "Remember", argument: text("text") },
  forget: { family: "thread", label: "Forget", argument: text("noteId") },
  set_purpose: { family: "thread", label: "Set purpose", argument: text("purpose") },
  propose_threads: { family: "thread", label: "Propose threads", argument: (input) => Array.isArray(input.threads) ? input.threads.map((thread: unknown) => thread && typeof thread === "object" ? text("title")(thread as Input) : undefined).filter(Boolean).join(", ") : undefined },
  notify: { family: "automation", label: "Notify", argument: text("headline") },
  nothing_to_report: { family: "automation", label: "Nothing to report", argument: text("checked") },
  schedule: { family: "automation", label: "Schedule", argument: text("schedule") },
  status: { family: "automation", label: "Automation status" },
  update: { family: "automation", label: "Update automation" },
  stop: { family: "automation", label: "Stop automation" },
  list_all: { family: "automation", label: "List automations" },
  terminal_list: { family: "read", label: "List terminals" },
  terminal_read: { family: "read", label: "Read terminal", argument: text("match") },
  browser_open: { family: "web", label: "Open page", argument: text("url") },
  browser_search: { family: "web", label: "Search", argument: text("query") },
  browser_read: { family: "web", label: "Read page" },
  browser_screenshot: { family: "web", label: "Screenshot" },
  browser_console: { family: "web", label: "Console" },
  browser_network: { family: "web", label: "Network" },
  browser_wait: { family: "web", label: "Wait", argument: text("value") },
  browser_click: { family: "web", label: "Click" },
  browser_type: { family: "web", label: "Type", argument: text("text") },
  browser_back: { family: "web", label: "Back" },
  browser_tabs: { family: "web", label: "List tabs" },
  browser_close_tab: { family: "web", label: "Close tab" },
  simulator_open: { family: "other", label: "Open simulator", argument: text("device") },
  simulator_read: { family: "read", label: "Read simulator" },
  simulator_tap: { family: "other", label: "Tap", argument: text("ref") },
  simulator_swipe: { family: "other", label: "Swipe" },
  simulator_type: { family: "other", label: "Type", argument: text("text") },
  simulator_button: { family: "other", label: "Press button", argument: text("button") },
  simulator_rotate: { family: "other", label: "Rotate", argument: text("orientation") },
  request_setup: { family: "other", label: "Set up computer use" },
};

const MCP_NAME = /^mcp__(.+?)__(.+)$/;
const OWN_SERVER = /^aicodingtool(-|$)/;

/** The app's own tool a name refers to, prefixed by its server or bare. */
function ownTool(name: string): OwnTool | undefined {
  const mcp = MCP_NAME.exec(name);
  if (mcp && !OWN_SERVER.test(mcp[1]!)) return undefined;
  return Object.hasOwn(OWN_TOOLS, mcp?.[2] ?? name) ? OWN_TOOLS[mcp?.[2] ?? name] : undefined;
}

/** What a person reads a tool as: its verb when it is the app's own, `server · tool` for another MCP server's. */
export function toolLabel(name: string): string {
  const own = ownTool(name);
  if (own) return own.label;
  const mcp = MCP_NAME.exec(name);
  return mcp ? `${mcp[1]} · ${mcp[2]!.replace(/_/g, " ")}` : name;
}

export function toolFamily(engine: EngineId, name: string): ToolFamily {
  return namingOf(engine).families[name] ?? ownTool(name)?.family ?? (name.startsWith("browser_") ? "web" : "other");
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

export function describeToolCall(engine: EngineId, name: string, detail?: string): ToolCall {
  const input = parseInput(detail);
  const own = ownTool(name);
  if (own) return describeOwnCall(own, input ?? {});
  const family = toolFamily(engine, name);
  const label = toolLabel(name);
  const naming = input && namingValue(namingOf(engine).namingKeys, input);
  if (!naming) return { family, label, argument: "" };
  const isPath = naming.key.toLowerCase().endsWith("path");
  const argument = oneLine(isPath ? shortPath(naming.value) : naming.value);
  /** A search says what it looked for and where, which two rows of the same pattern cannot. */
  const scope = family === "search" && typeof input.path === "string" && input.path.trim() ? ` in ${shortPath(input.path.trim())}` : "";
  return { family, label, ...(family === "shell" ? { sigil: "$" } : {}), argument: `${argument}${scope}` };
}

function describeOwnCall(own: OwnTool, input: Input): ToolCall {
  const argument = own.argument?.(input);
  const thread = own.thread ? text("threadId")(input)?.trim() : undefined;
  return { family: own.family, label: own.label, verb: true, argument: argument ? oneLine(argument) : "", ...(thread ? { thread } : {}) };
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
