/** A commit picker reads one page at a time, even for repositories with years of history. */
export const COMMIT_PAGE_SIZE = 100;
export const COMMIT_QUERY_LIMIT = 200;

export type CommitSummary = {
  sha: string;
  subject: string;
  author: string;
  committedAt: string;
};

export type CommitHistoryRequest = {
  query: string;
  /** Keep pagination on the same history if the agent commits while the picker is open. */
  head?: string;
  offset: number;
};

export type CommitHistoryResult =
  | { status: "available"; commits: CommitSummary[]; head: string | null; offset: number; hasMore: boolean }
  | { status: "error"; message: string };

export function isCommitQuery(value: unknown): value is string {
  return typeof value === "string" && value.length <= COMMIT_QUERY_LIMIT && !value.includes("\0");
}

export function isCommitHistoryRequest(value: unknown): value is CommitHistoryRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return isCommitQuery(request.query)
    && typeof request.offset === "number" && Number.isSafeInteger(request.offset) && request.offset >= 0 && request.offset <= 10_000_000
    && (request.head === undefined || (typeof request.head === "string" && /^[a-f\d]{40}$/i.test(request.head)))
    && (request.offset === 0 || request.head !== undefined);
}
