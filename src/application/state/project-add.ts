/** The add dialog belongs to this window even when it is asking another host to open a folder. */
export type ProjectAddState = {
  request: number;
  computerId: string;
  root: string;
  suggestions: string[];
  selected: number;
  saving: boolean;
  error: string | null;
  /** Asked for to start a thread in, which opens a draft there instead of only listing the folder. */
  start: boolean;
};
export type ProjectAddWorkspaceState = { projectAdd: ProjectAddState | null; projectAddSequence: number };
export const NO_PROJECT_ADD: ProjectAddWorkspaceState = { projectAdd: null, projectAddSequence: 0 };
