/**
 * What a coordinator hears of one of its threads. Wherever the thread is, what it did comes in as
 * member facts, from its own events here or from what a paired computer says it holds, and is heard
 * here the same way: the notes its coordinator wakes to and what the user is told.
 */
import type { WorkspaceEffect, WorkspaceTransition } from "./workspace-reducer/types.js";
import { coordinationNote, decisionHeadline, decisionNote, reportHeadline, reportNote, turnNote } from "./coordination.js";
import { announced, waitingHeadline } from "./notices.js";
import { settledHeadline, type RunSurfacing } from "./run-testimony.js";
import type { TurnStatus } from "./run-settlement.js";
import { updateThread } from "./thread-run-state.js";
import type { WorkspaceState } from "./workspace-state.js";
import { withCoordinationNote, type CoordinationNote, type CoordinationReport, type Decision } from "../domain/coordination.js";
import type { Thread } from "../domain/thread.js";

/**
 * One thing a coordinator's thread did. `runId` is the run it happened in, whose end it is heard
 * with. What a thread here tells the user itself, of what it found, what it waits on and how its
 * turn ended, comes as a fact only from a thread whose own computer keeps it to itself.
 */
export type MemberFact =
  /** It showed up on the paired computer `computer`, which is heard quietly. */
  | { kind: "arrived"; computer: string }
  | { kind: "raised"; decision: Decision; runId?: string | undefined }
  | { kind: "reported"; report: CoordinationReport; runId?: string | undefined }
  | { kind: "found"; headline: string }
  | { kind: "waiting"; on: { toolName: string } | { question: string } }
  /** Its turn ended. `tell` is how the user is told, as a run here says it: why it surfaces and the failure it ended with. */
  | { kind: "ended"; status: TurnStatus; quiet: boolean; tell?: { surfacing: RunSurfacing | null; failure?: string | undefined } };

export type HeardFacts = { notes: CoordinationNote[]; effects: WorkspaceEffect[] };

/**
 * What a coordinator hears of `member`'s facts, in order. Progress is not news: only a thread that is
 * blocked, done or failed leaves a note, and only one that cannot go on is the user's to hear about
 * at once. A decision is the user's to hear about at once, under the coordinator.
 */
export function heardFacts(state: WorkspaceState, lead: Thread, member: Thread, facts: readonly MemberFact[], at: number): HeardFacts {
  const heard: HeardFacts = { notes: [], effects: [] };
  for (const fact of facts) {
    switch (fact.kind) {
      case "arrived":
        heard.notes.push(coordinationNote(member.id, `"${member.title}" started on ${fact.computer}.`, at, { quiet: true }));
        break;
      case "raised":
        heard.notes.push(decisionNote(member, fact.decision, at, fact.runId));
        heard.effects.push(...announced(state, lead, decisionHeadline(fact.decision), "decision"));
        break;
      case "reported":
        if (fact.report.state === "working") break;
        heard.notes.push(reportNote(member, fact.report, at, fact.runId));
        if (fact.report.state !== "done") heard.effects.push(...announced(state, member, reportHeadline(fact.report), "blocked"));
        break;
      case "found":
        heard.effects.push(...announced(state, member, fact.headline, "finding"));
        break;
      case "waiting":
        heard.effects.push(...announced(state, member, waitingHeadline(fact.on), "waiting"));
        break;
      case "ended": {
        heard.notes.push(turnNote(member, fact.status, at, { quiet: fact.quiet }));
        const headline = fact.tell ? settledHeadline(fact.tell.surfacing, fact.tell.failure) : null;
        if (headline) heard.effects.push(...announced(state, member, headline, fact.tell!.surfacing === "failed" ? "failed" : "finished"));
        break;
      }
    }
  }
  return heard;
}

/** Its coordinator here hearing `member`'s facts: each note kept for its next wake, and what the user is told. */
export function withFactsHeard(state: WorkspaceState, lead: Thread, member: Thread, facts: readonly MemberFact[], at: number): WorkspaceTransition {
  const { notes, effects } = heardFacts(state, lead, member, facts, at);
  const next = notes.length ? updateThread(state, lead.id, (item) => notes.reduce(withCoordinationNote, item)) : state;
  return { state: next, effects };
}
