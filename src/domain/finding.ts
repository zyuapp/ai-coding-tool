/**
 * Something a run said it found, on purpose. A verdict belongs to one run and is cleared by the next;
 * a finding outlives every run after it, so a tick at 3am is still there when the user wakes up.
 */
export type AutomationFinding = {
  id: string;
  headline: string;
  detail?: string;
  /** What the finding is about, stable across runs, so the same one is not raised twice. */
  key?: string;
  at: number;
  read?: true;
};

/** How many findings a thread keeps. Past this the oldest is dropped. */
export const MAX_FINDINGS = 10;

/** Handled issues held per thread. Far more than a schedule reports at once, and still bounded. */
export const MAX_HANDLED_ISSUES = 50;
/** What one may carry: a line for the sidebar, a body for the thread, and a name to match it on. */
export const MAX_HEADLINE = 200;
export const MAX_DETAIL = 10_000;
export const MAX_FINDING_KEY = 200;

/** What scheduled runs on a thread found, and what of it the user has filed away. */
export type FindingsThread = {
  /** What runs on this thread found, newest last. Cleared by a dismissal, never by the next run. */
  findings?: AutomationFinding[];
  /**
   * Keys of findings the user has filed away. A dismissal means the issue is handled, so the same one
   * is held back while the runs keep reporting it, and only surfaces again once a run stops finding it.
   */
  handledIssues?: string[];
  /** When a run on this thread last found something. A dismissal files the findings away, not this. */
  lastFindingAt?: number;
  /** What the last scheduled run to say it found nothing looked at, which is a silent schedule's proof of life. */
  lastChecked?: { at: number; note: string };
};
