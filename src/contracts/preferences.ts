/** Presentation choices the window remembers between launches. */
export type ViewPreferences = {
  sessionPanelOpen: boolean;
  /** The pages each thread's dock reopens, keyed by thread id, and the origins a run may reach without asking again. */
  browserTabs?: Record<string, string[]>;
  browserOrigins?: string[];
};
