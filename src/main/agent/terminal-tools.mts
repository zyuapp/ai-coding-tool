import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { TerminalReadResult } from "../../contracts/threads.js";
import { describeTerminal, DEFAULT_TERMINAL_LINES, MAX_TERMINAL_LINES, type TerminalSnapshot } from "../../domain/terminal.js";
import type { TerminalBridge } from "./agent-provider.mjs";

export const TERMINAL_SERVER_NAME = "claudex-terminal";

const terminalField = z.string().optional().describe("Which terminal to read. Defaults to the one this thread opened, else the one on screen.");

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

export function terminalServer(bridge: TerminalBridge): McpServerConfig {
  return createSdkMcpServer({
    name: TERMINAL_SERVER_NAME,
    version: "1.0.0",
    alwaysLoad: true,
    tools: terminalTools(bridge),
  });
}

export function terminalTools(bridge: TerminalBridge) {
  return [
    tool(
      "terminal_list",
      "List the terminals the Claudex terminal panel has open, with the folder each runs in and whether its shell is still alive.",
      {},
      async () => report(async () => readText(await bridge.read({ op: "terminals" }))),
    ),
    tool(
      "terminal_read",
      [
        "Read what a terminal in the Claudex terminal panel has printed, as plain text with the escape sequences resolved.",
        "This is the user's own shell, not yours: you can read it but never type into it, so use Bash to run anything yourself.",
        "Prefer `match` over a large `lines` when hunting for an error — it filters before the output is returned.",
      ].join(" "),
      {
        terminalId: terminalField,
        lines: z.number().optional().describe(`How many of the newest lines to return. Defaults to ${DEFAULT_TERMINAL_LINES}, and never exceeds ${MAX_TERMINAL_LINES}.`),
        match: z.string().optional().describe("Keep only lines containing this text, case-insensitively."),
      },
      async (args) => report(async () => readText(await bridge.read({
        op: "snapshot",
        ...(args.terminalId ? { terminalId: args.terminalId } : {}),
        ...(args.lines === undefined ? {} : { lines: args.lines }),
        ...(args.match ? { match: args.match } : {}),
      }))),
    ),
  ];
}
