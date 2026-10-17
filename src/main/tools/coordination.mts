import { z } from "zod";
import { COORDINATION_STATES, MAX_DECISION_CONTEXT, MAX_MEMORY_NOTE, MAX_OPTION_DESCRIPTION, MAX_OPTION_LABEL, MAX_OPTIONS, MAX_PURPOSE, MAX_QUESTION, MAX_SUMMARY } from "../../domain/coordination.js";
import type { CoordinationRole } from "../../domain/coordination.js";
import type { CoordinationBridge } from "../agent/agent-provider.mjs";
import { bindTools, defineTool, type ToolDefinition } from "./tool-definition.mjs";

export const COORDINATION_SERVER_NAME = "aicodingtool-coordination";

async function report(work: () => Promise<{ note: string }>, failure = "Coordination error: ") {
  try {
    return { content: [{ type: "text" as const, text: (await work()).note }] };
  } catch (error) {
    return { content: [{ type: "text" as const, text: `${failure}${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

/** A refused memory change already says what to do instead, so it is answered in its own words. */
function remember(work: () => Promise<{ note: string }>) {
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
  run: (bridge: CoordinationBridge, args) => remember(() => bridge.remember({ kind: "remember", text: args.text })),
});

const FORGET = defineTool({
  name: "forget",
  description: "Drop a note from your memory when the user asks you to forget it or it no longer holds.",
  input: {
    noteId: z.string().min(1).max(200).describe("The note's ID, such as n3."),
  },
  readOnly: false,
  run: (bridge: CoordinationBridge, args) => remember(() => bridge.remember({ kind: "forget", noteId: args.noteId })),
});

const SET_PURPOSE = defineTool({
  name: "set_purpose",
  description: "Set what this coordinator is for, in the user's words, when they say what its purpose or goal is. Pass null to clear it.",
  input: {
    purpose: z.string().max(MAX_PURPOSE).nullable().describe("One line, or null to clear it."),
  },
  readOnly: false,
  run: (bridge: CoordinationBridge, args) => remember(() => bridge.remember({ kind: "purpose", purpose: args.purpose })),
});

/** A coordinator reports to no one, so it raises decisions and keeps its memory. */
export function coordinationTools(bridge: CoordinationBridge, role: CoordinationRole) {
  const definitions: ToolDefinition<CoordinationBridge>[] = role === "member" ? [REPORT_STATUS, RAISE_DECISION] : [RAISE_DECISION, REMEMBER, FORGET, SET_PURPOSE];
  return bindTools(bridge, definitions);
}
