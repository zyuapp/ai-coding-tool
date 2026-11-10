import { z } from "zod";
import { MAX_ID_LENGTH, MAX_SEARCH_TEXT } from "../../contracts/ipc.js";
import type { TerminalRead, TerminalReadResult } from "../../contracts/threads.js";
import { describeTerminal, DEFAULT_TERMINAL_LINES, MAX_TERMINAL_LINES, type TerminalSnapshot } from "../../domain/terminal.js";
import { bindTools, defineTool, type ToolDefinition } from "./tool-definition.mjs";
import type { ToolServer } from "./tool-server.mjs";

export const TERMINAL_SERVER_NAME = "aicodingtool-terminal";

/** The terminal panel, which a run may only read: the shell is the user's, and a run has Bash of its own. */
export type TerminalBridge = {
  read(read: TerminalRead): Promise<TerminalReadResult>;
};

const terminalField = z.string().max(MAX_ID_LENGTH).optional().describe("Which terminal to read. Defaults to the one this thread opened, else the one on screen.");

function snapshotText(snapshot: TerminalSnapshot) {
  const state = snapshot.status === "running"
    ? "running"
    : snapshot.error ?? `exited${snapshot.exitCode === undefined ? "" : ` (${snapshot.exitCode})`}`;
  const filtered = snapshot.matched === undefined ? [] : [`${snapshot.matched} matching lines`];
  const omitted = snapshot.omitted > 0 ? [`${snapshot.omitted} earlier lines not shown`] : [];
  return [
    [`${snapshot.title} — ${snapshot.cwd}`, state, ...filtered, ...omitted].join(" · "),
    "",
    snapshot.lines.length ? snapshot.lines.join("\n") : "(this terminal has printed nothing)",
  ].join("\n");
}

function readText(result: TerminalReadResult) {
  if (result.kind === "snapshot") return snapshotText(result.snapshot);
  if (result.kind === "terminals") {
    return result.terminals.length ? result.terminals.map(describeTerminal).join("\n") : "The terminal panel has no terminal open.";
  }
  return "The terminal panel has no terminal open.";
}

async function report(work: () => Promise<string>) {
  try {
    return { content: [{ type: "text" as const, text: await work() }] };
  } catch (error) {
    return { content: [{ type: "text" as const, text: `Terminal error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export const TERMINAL_TOOLS: readonly ToolDefinition<TerminalBridge>[] = [
  defineTool({
    name: "terminal_list",
    description: "List the terminals the AICodingTool terminal panel has open, with the folder each runs in and whether its shell is still alive.",
    input: {},
    readOnly: true,
    run: (bridge) => report(async () => readText(await bridge.read({ op: "terminals" }))),
  }),
  defineTool({
    name: "terminal_read",
    description: [
      "Read what a terminal in the AICodingTool terminal panel has printed, as plain text with the escape sequences resolved.",
      "This is the user's own shell, not yours: you can read it but never type into it, so use Bash to run anything yourself.",
      "Prefer `match` over a large `lines` when hunting for an error — it filters before the output is returned.",
    ].join(" "),
    input: {
      terminalId: terminalField,
      lines: z.number().nonnegative().optional().describe(`How many of the newest lines to return. Defaults to ${DEFAULT_TERMINAL_LINES}, and never exceeds ${MAX_TERMINAL_LINES}.`),
      match: z.string().max(MAX_SEARCH_TEXT).optional().describe("Keep only lines containing this text, case-insensitively."),
    },
    readOnly: true,
    run: (bridge, args) => report(async () => readText(await bridge.read({
      op: "snapshot",
      ...(args.terminalId ? { terminalId: args.terminalId } : {}),
      ...(args.lines === undefined ? {} : { lines: args.lines }),
      ...(args.match ? { match: args.match } : {}),
    }))),
  }),
];

export function terminalTools(bridge: TerminalBridge) {
  return bindTools(bridge, TERMINAL_TOOLS);
}

const TERMINAL_INSTRUCTIONS = `Use terminal_list and terminal_read to see what the user's terminals in the AICodingTool terminal panel have printed. Those shells are the user's; run your own commands in your own.`;

export const TERMINAL_SERVER: ToolServer<{ terminal?: TerminalBridge }> = {
  name: TERMINAL_SERVER_NAME,
  definitions: TERMINAL_TOOLS,
  grants: "none",
  serve: (run) => run.terminal ? terminalTools(run.terminal) : undefined,
  brief: (offers) => offers() ? [TERMINAL_INSTRUCTIONS] : [],
};
