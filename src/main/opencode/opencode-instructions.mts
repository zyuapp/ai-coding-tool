import { runBrief, type BriefDialect, type BriefSources } from "../agent/run-brief.mjs";

const OPENCODE_DIALECT: BriefDialect = {
  nativeWork: "OpenCode sessions or subagents",
  coordinatorReads: "Your own tools read and search; none edits files or runs shell commands.",
};

/** What an OpenCode session is told beyond its prompt, and the app tools it is served. */
export function openCodeBrief(input: BriefSources) {
  return runBrief(input, OPENCODE_DIALECT);
}
