import { runBrief, type BriefDialect, type BriefSources } from "../agent/run-brief.mjs";

const CODEX_DIALECT: BriefDialect = {
  nativeWork: "Codex sessions or subagents",
  /** A coordinator's sandbox is read-only, and the app refuses every escalation out of it. */
  coordinatorReads: "Your shell is read-only: use it to read and search, and never ask to run a command outside its sandbox.",
};

/** What a Codex thread is told beyond its prompt, and the app tools it is served. */
export function codexBrief(input: BriefSources) {
  return runBrief(input, CODEX_DIALECT);
}
