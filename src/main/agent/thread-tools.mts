import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { MAX_THREAD_WAIT_MS } from "../../contracts/ipc.js";
import type { ThreadSummary, ThreadTranscript } from "../../contracts/threads.js";
import type { ThreadBridge } from "./agent-provider.mjs";

export const THREAD_SERVER_NAME = "claudex-threads";

const MINUTE = 60_000;
const DEFAULT_WAIT_MS = 5 * MINUTE;

const threadIdField = z.string().describe("The ID of the thread, as list_threads reports it.");

const projectField = z.string().optional().describe(
  "\"current\" (the default) for the project this thread belongs to, \"all\" for every project, or a project folder path.",
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
    thread.projectRoot ?? "no project",
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

export function threadServer(bridge: ThreadBridge): McpServerConfig {
  return createSdkMcpServer({
    name: THREAD_SERVER_NAME,
    version: "1.0.0",
    alwaysLoad: true,
    tools: threadTools(bridge),
  });
}

export function threadTools(bridge: ThreadBridge, now: () => number = Date.now) {
  return [
    tool(
      "list_threads",
      "List the other Claudex threads, newest activity first. Use when the user asks what else is going on, points at recent or related work, or describes threads by age rather than by name. When you name one in an answer, link it as [title](claudex://thread/<id>) so the user can open it.",
      {
        project: projectField,
        archived: z.boolean().optional().describe("List archived threads instead of active ones."),
        idleMinutes: z.number().optional().describe("Only threads that have done nothing for at least this many minutes."),
        search: z.string().optional().describe("Only threads whose title or messages contain this text."),
        hasImages: z.boolean().optional().describe("Only threads where a message carries an image."),
        limit: z.number().optional().describe("How many threads to return. Defaults to 20."),
      },
      async (args) => report(async () => {
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
    ),
    tool(
      "read_thread",
      "Read another thread's transcript. Use after list_threads to see how something was done there, rather than guessing from its title.",
      {
        threadId: threadIdField,
        limit: z.number().optional().describe("How many of the newest messages to read. Defaults to 30."),
      },
      async (args) => report(async () => transcriptText(await bridge.read(args.threadId, args.limit), now())),
    ),
    tool(
      "wait_for_thread",
      "Wait until a thread stops working and report what it last said. Use after start_thread or message_thread when the user is waiting on that work; polling read_thread instead just burns turns. A wait that runs out says so, and calling it again keeps waiting.",
      {
        threadId: threadIdField,
        timeoutSeconds: z.number().optional().describe("How long to wait before reporting back regardless. Defaults to 300, and cannot exceed 900."),
      },
      async (args) => report(async () => {
        const timeoutMs = Math.min(args.timeoutSeconds === undefined ? DEFAULT_WAIT_MS : Math.max(0, args.timeoutSeconds) * 1_000, MAX_THREAD_WAIT_MS);
        const { thread, timedOut, reply } = await bridge.wait(args.threadId, timeoutMs);
        const heading = timedOut ? `Still working after ${Math.round(timeoutMs / 1_000)}s` : "Finished";
        return [`${heading}: ${describe(thread, now())}`, ...(reply ? ["", reply] : [])].join("\n");
      }),
    ),
    tool(
      "start_thread",
      "Start a new Claudex thread on its own prompt and run it. Use when the user asks for separate pieces of work to run side by side. The new thread runs with the permission policy the app is set to, so write a prompt that stands on its own. Pass worktree to give it an isolated checkout, which is what you want when it edits the same files as this thread.",
      {
        prompt: z.string().describe("The first message of the new thread. It has none of this conversation's context, so say everything it needs."),
        projectId: z.string().optional().describe("Which project the thread belongs to. Defaults to this thread's project."),
        worktree: z.boolean().optional().describe("Run the new thread in its own git worktree, detached at whatever the project has checked out, so its edits never touch the project checkout."),
      },
      async (args) => report(async () => {
        const { thread } = await bridge.command({ type: "task.send", text: args.prompt, ...(args.projectId ? { projectId: args.projectId } : {}), ...(args.worktree ? { worktree: true } : {}) });
        return thread ? `Started ${describe(thread, now())}` : "The thread did not start.";
      }),
    ),
    tool(
      "message_thread",
      "Send a message to another thread. It waits for that thread's current run to finish unless steer is true, which pushes it into the run already going.",
      {
        threadId: threadIdField,
        text: z.string().describe("The message to send."),
        steer: z.boolean().optional().describe("Interrupt the run already going instead of queueing behind it."),
      },
      async (args) => report(async () => {
        const { thread } = await bridge.command({ type: "task.send", taskId: args.threadId, text: args.text, ...(args.steer ? { steer: true } : {}) });
        return thread ? `Sent to ${describe(thread, now())}` : "The message was not delivered.";
      }),
    ),
    tool(
      "archive_thread",
      "Archive a thread, which also cancels a run it still has going and retires its automation. Archived threads stay recoverable for five days.",
      { threadId: threadIdField },
      async (args) => report(async () => {
        const { thread } = await bridge.command({ type: "task.archive", taskId: args.threadId });
        return thread ? `Archived ${describe(thread, now())}` : "The thread was not archived.";
      }),
    ),
    tool(
      "stop_thread",
      "Stop the run a thread has going, leaving the thread itself alone.",
      { threadId: threadIdField },
      async (args) => report(async () => {
        const { thread } = await bridge.command({ type: "run.cancel", taskId: args.threadId });
        return thread ? `Asked this thread to stop: ${describe(thread, now())}` : "The thread was not stopped.";
      }),
    ),
  ];
}
