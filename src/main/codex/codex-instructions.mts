import { runBrief, type BriefDialect, type BriefSources } from "../agent/run-brief.mjs";

const CODEX_DIALECT: BriefDialect = { nativeWork: "Codex sessions or subagents" };

/** What a Codex thread is told beyond its prompt, and the app tools it is served. */
export function codexBrief(input: BriefSources) {
  return runBrief(input, CODEX_DIALECT);
}
