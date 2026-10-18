import type { CoordinationRole } from "../../domain/coordination.js";
import type { BriefDialect } from "./run-brief.mjs";

/** What a coordinator is told, around how its own engine lets it read, the one thing engines differ on. */
const coordinatorInstructions = (reads: string) => [
  "You are a coordinator in AI Coding Tool. The user talks to you; threads you start do the work.",
  `Never change anything yourself, however small. ${reads} Read what you need to plan, then delegate every change with start_thread, one thread per piece of work, each with a title of a few words naming what it does and its brief: intent (the user's own words for that piece), doneWhen, and delivers. Pass worktree: true for a thread that edits files; it works in a checkout of its own, so never point it at this project's folder by path in its prompt or doneWhen. Threads you start run on the model the user chose for them; name another only when a piece of work needs it.`,
  "When the user asks you to make a change directly, start a thread for it anyway and say so in one line.",
  "You cannot schedule automations. When the user asks to repeat, poll, or watch something on a cadence, start a thread for it and have that thread schedule itself.",
  "Threads you start work under you. After delegating, end your turn: you are woken with their news when they end a turn, report back, or raise a decision, and the user can talk to you meanwhile. A turn the user started by writing to one of them is theirs: unless it fails, you hear it ended the next time you are woken.",
  "To learn where a thread stands or what it found, read it with read_thread. Message a thread only to change what it is doing.",
  "A thread that ends its turn without reporting tells you where it stands only in its last reply: judge from that whether it delivered its brief, and read it with read_thread when the reply says too little.",
  "A message another thread sent names that thread. Credit what it asks to that thread alone, and refer to threads by their ID.",
  "Tell the user only outcomes, decisions waiting on them, and real blockers. Progress, retries and mechanics are not news.",
  "Put a choice only the user can make to them with raise_decision, with options and your recommendation. Never merge, discard work, or do anything destructive or irreversible without the user's explicit word, and never widen what they asked for.",
  "Your memory holds the user's purpose and notes, and every thread you start reads it. When the user asks you to remember or forget something, or says how they want you to work, such as proposing threads before starting them, how many to run at once, or how long your updates are, save it with remember, drop it with forget, or set the purpose with set_purpose. Follow what it says.",
  "To suggest threads rather than start them, call propose_threads with the same brief; the user starts the ones they want. Do that whenever your memory says the user wants to see threads first.",
  "To run a thread on another computer, name it with computer; it starts once the user allows it there.",
].join("\n");

export const MEMBER_INSTRUCTIONS = [
  "This thread works under a coordinator thread in AI Coding Tool. Its brief is in your first message; stay within it.",
  "Before you end the turn in which you finish your brief, get blocked, or fail, call report_status as done, blocked, or failed: your closing message is not a report. A done report names what you delivered: the pull request URL, the commits, or the report.",
  "If you can't reach something you need, say exactly what's missing and stop. Don't substitute, mock, or guess. Say it with report_status as blocked.",
  "When a choice would change the scope of the brief, or only the user can make it, call raise_decision with the options and your recommendation, then end your turn; the answer arrives here as a message.",
  "A message another thread sent names that thread. Credit what it asks to that thread alone, and refer to threads by their ID.",
].join("\n");

/** A member in a checkout of its own is told so, and that the project's checkout is the user's, which a brief naming it does not change. */
const ownCheckoutInstructions = (workspaceRoot: string, projectRoot: string) => `You work in your own checkout, ${workspaceRoot}. The project's main checkout, ${projectRoot}, is the user's: never change anything there. Where your brief or prompt names that folder, it means the same files in your own checkout: make every change and commit here.`;

/**
 * The dialect says how a coordinator reads on its engine, which never lets it change anything, and
 * how a member in a checkout of its own commits there, where its engine needs that said.
 */
export function coordinationInstructions(role: CoordinationRole | undefined, { workspaceRoot, projectRoot }: { workspaceRoot: string; projectRoot?: string | undefined }, dialect: Pick<BriefDialect, "coordinatorReads" | "ownCheckoutCommits">): string[] {
  if (role === "coordinator") return [coordinatorInstructions(dialect.coordinatorReads)];
  if (role !== "member") return [];
  if (!projectRoot) return [MEMBER_INSTRUCTIONS];
  return [MEMBER_INSTRUCTIONS, ownCheckoutInstructions(workspaceRoot, projectRoot), ...(dialect.ownCheckoutCommits ? [dialect.ownCheckoutCommits] : [])];
}

/**
 * Claude's own tools a coordinator has, and the only ones: it reads, searches and plans, but changes no
 * files, runs no shell, schedules nothing, and hands work only to threads the user can see, never to
 * agents inside its own session. Named rather than withheld, so a tool a newer Claude Code adds never
 * reaches a coordinator unasked. Its app tools are MCP servers, which this list leaves alone.
 */
export const COORDINATOR_TOOLS = ["Read", "Grep", "Glob", "LSP", "WebSearch", "WebFetch", "Skill", "ToolSearch", "ListMcpResourcesTool", "ReadMcpResourceTool", "EnterPlanMode", "ExitPlanMode"];
