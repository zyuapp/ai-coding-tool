import { z } from "zod";
import { CREW_STATES, MAX_DECISION_CONTEXT, MAX_OPTION_DESCRIPTION, MAX_OPTION_LABEL, MAX_OPTIONS, MAX_QUESTION, MAX_SUMMARY } from "../../domain/crew.js";
import type { CrewRole } from "../../domain/crew.js";
import type { CrewBridge } from "../agent/agent-provider.mjs";
import { bindTools, defineTool, type ToolDefinition } from "./tool-definition.mjs";

export const CREW_SERVER_NAME = "aicodingtool-crew";

async function report(work: () => Promise<{ note: string }>) {
  try {
    return { content: [{ type: "text" as const, text: (await work()).note }] };
  } catch (error) {
    return { content: [{ type: "text" as const, text: `Crew error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

const REPORT_STATUS = defineTool({
  name: "report_status",
  description: "Tell the coordinator this thread works under where your work stands. Call it when you are blocked, done, or failed; it hears the report when your turn ends. A done report names what you delivered: the pull request URL, the commits, or the report.",
  input: {
    state: z.enum(CREW_STATES).describe("working, blocked, done, or failed."),
    summary: z.string().max(MAX_SUMMARY).describe("One or two sentences: the outcome, or what stops you."),
  },
  readOnly: false,
  run: (bridge: CrewBridge, args) => report(() => bridge.report(args.state, args.summary)),
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
  run: (bridge: CrewBridge, args) => report(() => bridge.decide({
    question: args.question,
    ...(args.context ? { context: args.context } : {}),
    options: args.options.map((option) => ({
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
      ...(option.recommended ? { recommended: true as const } : {}),
    })),
  })),
});

/** A coordinator reports to no one, so it only raises decisions. */
export function crewTools(bridge: CrewBridge, role: CrewRole) {
  const definitions: ToolDefinition<CrewBridge>[] = role === "member" ? [REPORT_STATUS, RAISE_DECISION] : [RAISE_DECISION];
  return bindTools(bridge, definitions);
}
