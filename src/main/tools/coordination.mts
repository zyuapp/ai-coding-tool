import { z } from "zod";
import { COORDINATION_STATES, MAX_DECISION_CONTEXT, MAX_MEMORY_NOTE, MAX_OPTION_DESCRIPTION, MAX_OPTION_LABEL, MAX_OPTIONS, MAX_PROPOSAL_TITLE, MAX_PROPOSALS, MAX_PURPOSE, MAX_QUESTION, MAX_SUMMARY } from "../../domain/coordination.js";
import type { CoordinationRole } from "../../domain/coordination.js";
import type { CoordinationBridge } from "../agent/agent-provider.mjs";
import { bindTools, defineTool, type ToolDefinition } from "./tool-definition.mjs";
import { COORDINATOR_START_INPUT, newThreadFields } from "./threads.mjs";

export const COORDINATION_SERVER_NAME = "aicodingtool-coordination";

async function report(work: () => Promise<{ note: string }>, failure = "Coordination error: ") {
  try {
    return { content: [{ type: "text" as const, text: (await work()).note }] };
  } catch (error) {
    return { content: [{ type: "text" as const, text: `${failure}${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

/** A refused memory change or suggestion already says what to do instead, so it is answered in its own words. */
function answered(work: () => Promise<{ note: string }>) {
  return report(work, "");
}

const REPORT_STATUS = defineTool({
  name: "report_status",
  description: "Tell the coordinator this thread works under where your work stands. Call it when you are blocked, done, or failed; it hears the report when your turn ends. A done report names what you delivered: the pull request URL, the commits, or the report.",
  input: {
    state: z.enum(COORDINATION_STATES).describe("working, blocked, done, or failed."),
    summary: z.string().max(MAX_SUMMARY).describe("One or two sentences: the outcome, or what stops you."),
  },
  readOnly: false,
  run: (bridge: CoordinationBridge, args) => report(() => bridge.report(args.state, args.summary)),
});

const RAISE_DECISION = defineTool({
  name: "raise_decision",
  description: "Put a choice to the user that only they can make: one that changes scope, product behaviour, or anything destructive. It shows in the app at once; their answer arrives in this thread as a message. Offer the options you see with your recommendation, then end your turn if you cannot go on without the answer.",
  input: {
    question: z.string().max(MAX_QUESTION).describe("The decision, as one question."),
    context: z.string().max(MAX_DECISION_CONTEXT).optional().describe("What the user needs to know to decide, including the consequences either way."),
    options: z.array(z.object({
      label: z.string().max(MAX_OPTION_LABEL),
      description: z.string().max(MAX_OPTION_DESCRIPTION).optional(),
      recommended: z.boolean().optional(),
    })).max(MAX_OPTIONS).describe("The choices, each with a short label and what it means. Mark the one you recommend."),
  },
  readOnly: false,
  run: (bridge: CoordinationBridge, args) => report(() => bridge.decide({
    question: args.question,
    ...(args.context ? { context: args.context } : {}),
    options: args.options.map((option) => ({
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
      ...(option.recommended ? { recommended: true as const } : {}),
    })),
  })),
});

const REMEMBER = defineTool({
  name: "remember",
  description: "Save a note to your memory: something the user asked you to remember, or how they want you to work. You and every thread you start from now on read it.",
  input: {
    text: z.string().min(1).max(MAX_MEMORY_NOTE).describe("The note, in one or two sentences."),
  },
  readOnly: false,
  run: (bridge: CoordinationBridge, args) => answered(() => bridge.remember({ kind: "remember", text: args.text })),
});

const FORGET = defineTool({
  name: "forget",
  description: "Drop a note from your memory when the user asks you to forget it or it no longer holds.",
  input: {
    noteId: z.string().min(1).max(200).describe("The note's ID, such as n3."),
  },
  readOnly: false,
  run: (bridge: CoordinationBridge, args) => answered(() => bridge.remember({ kind: "forget", noteId: args.noteId })),
});

const SET_PURPOSE = defineTool({
  name: "set_purpose",
  description: "Set what this coordinator is for, in the user's words, when they say what its purpose or goal is. Pass null to clear it.",
  input: {
    purpose: z.string().max(MAX_PURPOSE).nullable().describe("One line, or null to clear it."),
  },
  readOnly: false,
  run: (bridge: CoordinationBridge, args) => answered(() => bridge.remember({ kind: "purpose", purpose: args.purpose })),
});

const PROPOSE_THREADS = defineTool({
  name: "propose_threads",
  description: "Suggest threads for the user to start, rather than starting them. Each takes what start_thread takes, brief included, and a short title. Nothing starts until the user starts it; you hear from each one they start once it ends a turn.",
  input: {
    threads: z.array(z.object({
      title: z.string().trim().min(1).max(MAX_PROPOSAL_TITLE).describe("A few words that label the suggestion for the user."),
      ...COORDINATOR_START_INPUT,
      /** A blank item is refused here, on its own field, rather than failing every suggestion in the call. */
      prompt: COORDINATOR_START_INPUT.prompt.trim().min(1),
    })).min(1).max(MAX_PROPOSALS).describe("The threads to suggest, one per piece of work."),
  },
  readOnly: false,
  run: (bridge: CoordinationBridge, args) => answered(() => bridge.propose(args.threads.map((thread) => ({
    title: thread.title,
    prompt: thread.prompt,
    ...newThreadFields(thread),
    ...(thread.computer ? { computer: thread.computer } : {}),
  })))),
});

/** A coordinator reports to no one, so it raises decisions, keeps its memory, and suggests threads. */
export function coordinationTools(bridge: CoordinationBridge, role: CoordinationRole) {
  const definitions: ToolDefinition<CoordinationBridge>[] = role === "member" ? [REPORT_STATUS, RAISE_DECISION] : [RAISE_DECISION, REMEMBER, FORGET, SET_PURPOSE, PROPOSE_THREADS];
  return bindTools(bridge, definitions);
}
