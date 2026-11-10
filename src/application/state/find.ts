import type { FindResults, FindTarget } from "../../domain/find.js";

/**
 * What the find bar is looking for, and where. Only the query and the match the user stepped to live
 * here: what a query matches is derived, so a thread that is still streaming keeps finding what it
 * has just printed.
 */
export type FindState = {
  target: FindTarget;
  query: string;
  /** Which match the user stepped to, counting from zero. */
  index: number;
  /** Bumped whenever find is asked for again, which is all the bar needs to take the caret back. */
  focus: number;
};

/**
 * The jump panel: the name being searched for, and the row the user moved to. Which threads that
 * name matches is derived, so a thread renamed while the panel is open moves with the query.
 */
export type JumpState = { query: string; index: number };

export type FindBarState = {
  /** The find bar, and what a page or a shell reported after searching itself. */
  find: FindState | null;
  findResults: FindResults | null;
  /** The jump panel, open on the name the user is searching for, and whether zen mode leaves only the thread on screen. */
  jump: JumpState | null; zen: boolean;
};

export function initialFindBarState(): FindBarState {
  return { find: null, findResults: null, jump: null, zen: false };
}
