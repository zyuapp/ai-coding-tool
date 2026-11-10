/** Which thread the window is on, and how it got there. */
export type NavigationState = {
  lastFolder: string | null;
  currentId: string | null;
  /** Threads the user has landed on this session, oldest first, with a cursor for back and forward. */
  history: string[];
  historyIndex: number;
};

export function initialNavigationState(): NavigationState {
  return { lastFolder: null, currentId: null, history: [], historyIndex: -1 };
}
