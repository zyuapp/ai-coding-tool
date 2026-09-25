import type { ChangedFilesResult } from "../contracts/ipc.js";
import { NO_PULL_REQUEST, type PullRequestAnswer, type PullRequestRead } from "../domain/pull-request.js";

/** The branch a checkout sits on, or null while Git has not said or could not. */
export function branchOf(environment: ChangedFilesResult | null) {
  return environment?.status === "available" ? environment.branch : null;
}

/** The answer held for a checkout, kept only while that checkout and branch are the ones on screen. */
export function pullRequestFor(held: PullRequestRead | null, workspaceId: string | undefined, environment: ChangedFilesResult | null): PullRequestAnswer {
  if (!held || held.workspaceId !== workspaceId || held.branch !== branchOf(environment)) return NO_PULL_REQUEST;
  return held.answer;
}
