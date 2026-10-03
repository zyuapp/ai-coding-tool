/** How a pull request stands. A draft is an open one nobody has been asked to read yet. */
export type PullRequestState = "draft" | "open" | "merged" | "closed";

/**
 * The pull request a checkout's work belongs to, in the little a row can say about it: which one it
 * is, what it is called, where it lives, and how it stands.
 */
export type PullRequestRef = {
  number: number;
  title: string;
  url: string;
  state: PullRequestState;
};

/**
 * What a checkout has to say about its pull request: the one its work belongs to, that it has none,
 * or that `gh` is not installed and so nothing could be asked at all.
 */
export type PullRequestAnswer =
  | { status: "found"; pullRequest: PullRequestRef }
  | { status: "none" }
  | { status: "gh-missing" };

/**
 * An answer and what it answers: the checkout and branch it was read for, and which ask it belongs
 * to, so an answer a newer ask has overtaken can be dropped whenever it arrives.
 */
export type PullRequestRead = {
  workspaceId: string;
  branch: string | null;
  read: number;
  answer: PullRequestAnswer;
  /** The threads whose work the answer is about, which a found pull request is recorded on. */
  threadIds?: string[];
};

/** The pull request a thread's work was last seen on, kept so a search can find the thread by it. */
export type PullRequestLink = { number: number; url: string };

export function isPullRequestLink(value: unknown): value is PullRequestLink {
  if (!value || typeof value !== "object") return false;
  const link = value as Record<string, unknown>;
  return typeof link.number === "number" && Number.isInteger(link.number) && link.number > 0 && typeof link.url === "string" && link.url.length > 0;
}

/** A search for a pull request: its number, and the repository too when the search is a link. */
export type PullRequestQuery = { number: number; repository: string | null };

const NUMBER_QUERY = /^#?(\d+)$/;
const LINK = /^(?:https?:\/\/)?([^/\s]+\/[^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#]\S*)?$/i;

/** What a search names when it names a pull request: `12`, `#12`, or a link to one. */
export function pullRequestQuery(query: string): PullRequestQuery | null {
  const wanted = query.trim();
  const link = LINK.exec(wanted);
  const number = Number(link ? link[2] : NUMBER_QUERY.exec(wanted)?.[1]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { number, repository: link ? link[1]!.toLowerCase() : null };
}

/** Whether a thread's pull request is the one a search names. */
export function linksPullRequest(link: PullRequestLink, query: PullRequestQuery) {
  if (link.number !== query.number) return false;
  return query.repository === null || LINK.exec(link.url)?.[1]?.toLowerCase() === query.repository;
}

const STATES: readonly string[] = ["draft", "open", "merged", "closed"];

/**
 * `gh pr list --json number,title,url,state,isDraft`, which answers with an array of at most one and
 * keeps draft beside the state rather than in it.
 */
export function pullRequestFromList(value: unknown): PullRequestRef | null {
  const found = firstRecord(value);
  if (!found) return null;
  const state = lowercase(found.state);
  return pullRequest(found.number, found.title, found.url, found.isDraft === true && state === "open" ? "draft" : state);
}

/**
 * `gh api repos/{owner}/{repo}/commits/{sha}/pulls`, which is REST: it knows only open and closed,
 * and leaves merged to be read off the date it happened.
 */
export function pullRequestFromCommit(value: unknown): PullRequestRef | null {
  const found = firstRecord(value);
  if (!found) return null;
  const state = found.merged_at ? "merged" : found.draft === true ? "draft" : lowercase(found.state);
  return pullRequest(found.number, found.title, found.html_url, state);
}

function firstRecord(value: unknown) {
  const first = Array.isArray(value) ? value[0] : null;
  return first && typeof first === "object" && !Array.isArray(first) ? (first as Record<string, unknown>) : null;
}

function lowercase(value: unknown) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

/** Every field a row draws has to be there and be itself, or there is no pull request to show. */
function pullRequest(number: unknown, title: unknown, url: unknown, state: string): PullRequestRef | null {
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) return null;
  if (typeof title !== "string" || typeof url !== "string" || !url) return null;
  if (!STATES.includes(state)) return null;
  return { number, title, url, state: state as PullRequestState };
}

/**
 * How often an unsettled pull request is asked about again. A merge happens on GitHub and leaves no
 * trace on this machine, so nothing local can announce it and only asking finds out.
 */
export const PULL_REQUEST_POLL_MS = 60_000;

/** Nothing to show: the answer a checkout that has not been asked about yet stands at. */
export const NO_PULL_REQUEST: PullRequestAnswer = { status: "none" };

const SETTLED: readonly PullRequestState[] = ["merged", "closed"];

/** True once nothing local or remote will move the pull request again, past which asking is only cost. */
export function pullRequestSettled(answer: PullRequestAnswer) {
  return answer.status === "found" && SETTLED.includes(answer.pullRequest.state);
}

/** Whether two answers say the same thing, so an unchanged one never rewrites the row. */
export function samePullRequest(left: PullRequestAnswer, right: PullRequestAnswer) {
  if (left.status !== right.status) return false;
  if (left.status !== "found" || right.status !== "found") return true;
  return left.pullRequest.number === right.pullRequest.number
    && left.pullRequest.title === right.pullRequest.title
    && left.pullRequest.url === right.pullRequest.url
    && left.pullRequest.state === right.pullRequest.state;
}
