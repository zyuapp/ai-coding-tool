import { isReviewTarget, type ReviewTarget } from "../domain/review.js";
import { agentThread, boolean, literals, optionalText, text, type Declarations } from "./command-declaration.js";
import * as phone from "./phone-commands.js";

export type RunControlCommand =
  | { type: "run.cancel"; taskId?: string }
  /** Compacts an idle thread whose model compacts on request, without adding a user message to it. */
  | { type: "run.compact"; taskId?: string }
  | { type: "question.set-answer"; taskId: string; runId: string; requestId: string; questionId: string; text: string }
  | { type: "question.answer"; taskId: string; runId: string; requestId: string; questionId: string; text?: string }
  | { type: "run.decide"; allow: boolean; taskId: string; runId: string; approvalId: string }
  /** Kills one process the run left running, without ending the run. */
  | { type: "run.stop-process"; taskId?: string; processId: string }
  /** Picks a thread paused by its usage limit back up now. */
  | { type: "limit.resume"; taskId: string }
  /** Takes a thread paused by its usage limit out of line, so it stays where the limit left it. */
  | { type: "limit.cancel"; taskId: string };

/** The review picker of an engine that reviews natively, and the review turn it starts. */
export type ReviewCommand =
  | { type: "review.open"; taskId?: string }
  | { type: "review.close" }
  | { type: "review.set-step"; step: "targets" | "base" | "commit" | "custom" }
  | { type: "review.start"; taskId?: string; target: ReviewTarget };

const cancels: phone.PhoneRule = phone.named;

const decides: phone.PhoneRule = (command) => phone.isString(command.taskId) && phone.isString(command.runId) && phone.isString(command.approvalId) && typeof command.allow === "boolean";

const stopsProcess: phone.PhoneRule = (command) => phone.named(command) && phone.isString(command.processId);

const answers: phone.PhoneRule = (command) => phone.isString(command.taskId) && phone.isString(command.runId)
  && phone.isString(command.requestId) && phone.isString(command.questionId)
  && (command.text === undefined || phone.isString(command.text, phone.MAX_PROMPT_LENGTH)) && command.attachments === undefined;

export const runControlCommands = {
  "run.cancel": { fields: { taskId: optionalText }, at: "thread", agent: agentThread, phone: cancels },
  "run.compact": { fields: { taskId: optionalText }, at: "thread" },
  "question.set-answer": { fields: { taskId: text, runId: text, requestId: text, questionId: text, text }, at: "thread" },
  "question.answer": { fields: { taskId: text, runId: text, requestId: text, questionId: text, text: optionalText }, at: "thread", phone: answers },
  "run.decide": { fields: { allow: boolean, taskId: text, runId: text, approvalId: text }, at: "thread", phone: decides },
  "run.stop-process": { fields: { taskId: optionalText, processId: text }, at: "thread", phone: stopsProcess },
  "limit.resume": { fields: { taskId: text }, at: "thread", phone: phone.namesThread },
  "limit.cancel": { fields: { taskId: text }, at: "thread", phone: phone.namesThread },
} satisfies Declarations<RunControlCommand>;

export const reviewCommands = {
  "review.open": { fields: { taskId: optionalText }, at: "thread" },
  "review.close": { fields: {}, at: "thread" },
  "review.set-step": { fields: { step: literals("targets", "base", "commit", "custom") }, at: "thread" },
  "review.start": { fields: { taskId: optionalText, target: isReviewTarget }, at: "thread" },
} satisfies Declarations<ReviewCommand>;
