import { runBrief, type BriefDialect, type BriefSources } from "../agent/run-brief.mjs";

const CODEX_DIALECT: BriefDialect = {
  nativeWork: "Codex sessions or subagents",
  /** A coordinator's sandbox is read-only, and the app refuses every escalation out of it. */
  coordinatorReads: "Your shell is read-only: use it to read and search, and never ask to run a command outside its sandbox.",
  /**
   * A worktree keeps its git data in the project's `.git`, which its sandbox cannot write, and no set
   * of writable folders could open that much without letting a command plant what git runs outside
   * the sandbox. So a commit asks to run outside it, which the user or the reviewer decides.
   */
  ownCheckoutCommits: "Your sandbox cannot write the git data your checkout keeps in the main checkout's .git folder, so a git command that writes it, such as git add or git commit, must run outside the sandbox: ask to run it that way, and report blocked only if that is refused. That is your checkout's own history, not the user's files.",
};

/** What a Codex thread is told beyond its prompt, and the app tools it is served. */
export function codexBrief(input: BriefSources) {
  return runBrief(input, CODEX_DIALECT);
}
