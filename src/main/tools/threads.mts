import { z } from "zod";
import { MAX_THREAD_WAIT_MS } from "../../contracts/ipc.js";
import type { ThreadSummary, ThreadTranscript } from "../../contracts/threads.js";
import type { ThreadBridge } from "../agent/agent-provider.mjs";
import { bindTools, defineTool, type ToolDefinition } from "./tool-definition.mjs";

export const THREAD_SERVER_NAME = "aicodingtool-threads";

/** The workspace bridge with the clock idle times are measured against. */
export type ThreadToolContext = { bridge: ThreadBridge; now: () => number };

const MINUTE = 60_000;
const DEFAULT_WAIT_MS = 5 * MINUTE;

const threadIdField = z.string().describe("The thread, named by the ID list_threads reports, an unambiguous prefix of it, or its exact title.");

const projectField = z.string().optional().describe(
  "\"current\" (the default) for the project this thread belongs to, \"all\" for every project, or a project named by its folder name or its path.",
);

function elapsed(ms: number) {
  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}` : `${Math.floor(hours / 24)}d`;
}

function describe(thread: ThreadSummary, at: number) {
  const parts = [
    `${thread.title} [${thread.id}]`,
    thread.worktreeRoot ?? thread.projectRoot ?? "no project",
    ...(thread.worktreeId ? [`worktree ${thread.worktreeId}`] : []),
    thread.status,
    `${thread.messageCount} messages`,
    ...(thread.attachmentCount ? [`${thread.attachmentCount} with images`] : []),
    `idle ${elapsed(Math.max(0, at - thread.lastActivityAt))}`,
    ...(thread.archived ? ["archived"] : []),
  ];
  return parts.join(" · ");
}

function transcriptText(transcript: ThreadTranscript, at: number) {
  const lines = [
    describe(transcript.thread, at),
    ...(transcript.omitted ? [`(${transcript.omitted} earlier messages not shown)`] : []),
    "",
    ...transcript.messages.map((message) => `[${message.kind}] ${message.text}`),
  ];
  return lines.join("\n");
}

async function report(work: () => Promise<string>) {
  try {
    return { content: [{ type: "text" as const, text: await work() }] };
  } catch (error) {
    return { content: [{ type: "text" as const, text: `Thread error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export const THREAD_TOOLS: readonly ToolDefinition<ThreadToolContext>[] = [
  defineTool({
    name: "list_threads",
    description: "List the other AICodingTool threads, newest activity first. Use when the user asks what else is going on, points at recent or related work, or describes threads by age rather than by name.",
    input: {
      project: projectField,
      archived: z.boolean().optional().describe("List archived threads instead of active ones."),
      idleMinutes: z.number().optional().describe("Only threads that have done nothing for at least this many minutes."),
      search: z.string().optional().describe("Only threads whose title or messages contain this text."),
      hasImages: z.boolean().optional().describe("Only threads where a message carries an image."),
      limit: z.number().optional().describe("How many threads to return. Defaults to 20."),
    },
    readOnly: true,
    run: ({ bridge, now }, args) => report(async () => {
      const at = now();
      const threads = await bridge.list({
        ...(args.project === undefined ? {} : { project: args.project }),
        ...(args.archived === undefined ? {} : { archived: args.archived }),
        ...(args.idleMinutes === undefined ? {} : { idleForMs: args.idleMinutes * MINUTE }),
        ...(args.search === undefined ? {} : { search: args.search }),
        ...(args.hasImages === undefined ? {} : { attachments: args.hasImages }),
        limit: args.limit ?? 20,
      });
      return threads.length ? threads.map((thread) => describe(thread, at)).join("\n") : "No thread matches.";
    }),
  }),
  defineTool({
    name: "read_thread",
    description: "Read another thread's transcript. Use after list_threads to see how something was done there, rather than guessing from its title. A message that links a thread as aicodingtool://thread/<id> is naming it for you, so read it by that id rather than searching for it.",
    input: {
      threadId: threadIdField,
      limit: z.number().optional().describe("How many of the newest messages to read. Defaults to 30."),
    },
    readOnly: true,
    run: ({ bridge, now }, args) => report(async () => transcriptText(await bridge.read(args.threadId, args.limit), now())),
  }),
  defineTool({
    name: "wait_for_thread",
    description: "Wait until a thread stops working and report what it last said. Use after start_thread or message_thread when the user is waiting on that work; polling read_thread instead just burns turns. A wait that runs out says so, and calling it again keeps waiting.",
    input: {
      threadId: threadIdField,
      timeoutSeconds: z.number().optional().describe("How long to wait before reporting back regardless. Defaults to 300, and cannot exceed 900."),
    },
    readOnly: true,
    run: ({ bridge, now }, args) => report(async () => {
      const timeoutMs = Math.min(args.timeoutSeconds === undefined ? DEFAULT_WAIT_MS : Math.max(0, args.timeoutSeconds) * 1_000, MAX_THREAD_WAIT_MS);
      const { thread, timedOut, reply } = await bridge.wait(args.threadId, timeoutMs);
      const heading = timedOut ? `Still working after ${Math.round(timeoutMs / 1_000)}s` : "Finished";
      return [`${heading}: ${describe(thread, now())}`, ...(reply ? ["", reply] : [])].join("\n");
    }),
  }),
  defineTool({
    name: "start_thread",
    description: "Start a new AICodingTool thread on its own prompt and run it. Use when the user asks for separate pieces of work to run side by side, one thread per piece. The new thread runs with the permission policy the app is set to, so write a prompt that stands on its own. Pass worktree to give it an isolated checkout, which is what you want when it edits the same files as this thread.",
    input: {
      prompt: z.string().describe("The first message of the new thread. It has none of this conversation's context, so say everything it needs."),
      project: z.string().optional().describe("Which project to start it in: its folder name, its path, or its id. Defaults to this thread's project."),
      worktree: z.boolean().optional().describe("Run the new thread in its own git worktree, detached at whatever the project has checked out, so its edits never touch the project checkout."),
      worktreeId: z.string().optional().describe("Start the thread in a worktree that already exists, as list_threads reports it, so it works alongside the threads already in there. Takes precedence over worktree."),
    },
    readOnly: false,
    run: ({ bridge, now }, args) => report(async () => {
      const { thread } = await bridge.command({ type: "task.send", text: args.prompt, ...(args.project ? { project: args.project } : {}), ...(args.worktreeId ? { worktreeId: args.worktreeId } : args.worktree ? { worktree: true } : {}) });
      return thread ? `Started ${describe(thread, now())}` : "The thread did not start.";
    }),
  }),
  defineTool({
    name: "message_thread",
    description: "Send a message to another thread. It waits for that thread's current run to finish unless steer is true, which pushes it into the run already going.",
    input: {
      threadId: threadIdField,
      text: z.string().describe("The message to send."),
      steer: z.boolean().optional().describe("Interrupt the run already going instead of queueing behind it."),
    },
    readOnly: false,
    run: ({ bridge, now }, args) => report(async () => {
      const { thread } = await bridge.command({ type: "task.send", taskId: args.threadId, text: args.text, ...(args.steer ? { steer: true } : {}) });
      return thread ? `Sent to ${describe(thread, now())}` : "The message was not delivered.";
    }),
  }),
  defineTool({
    name: "archive_thread",
    description: "Archive a thread, which also cancels a run it still has going and retires its automation. Archived threads stay recoverable for five days. This throws away work in progress, so only archive when the user asked for it.",
    input: { threadId: threadIdField },
    readOnly: false,
    run: ({ bridge, now }, args) => report(async () => {
      const { thread } = await bridge.command({ type: "task.archive", taskId: args.threadId });
      return thread ? `Archived ${describe(thread, now())}` : "The thread was not archived.";
    }),
  }),
  defineTool({
    name: "stop_thread",
    description: "Stop the run a thread has going, leaving the thread itself alone. This throws away work in progress, so only stop a run when the user asked for it.",
    input: { threadId: threadIdField },
    readOnly: false,
    run: ({ bridge, now }, args) => report(async () => {
      const { thread } = await bridge.command({ type: "run.cancel", taskId: args.threadId });
      return thread ? `Asked this thread to stop: ${describe(thread, now())}` : "The thread was not stopped.";
    }),
  }),
];

export function threadTools(bridge: ThreadBridge, now: () => number = Date.now) {
  return bindTools({ bridge, now }, THREAD_TOOLS);
}
