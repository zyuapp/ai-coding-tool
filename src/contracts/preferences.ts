/** Presentation choices the window remembers between launches. */
export type ViewPreferences = {
  sessionPanelOpen: boolean;
  /** The pages the browser panel reopens, and the origins a run may reach without asking again. */
  browserTabs?: string[];
  browserOrigins?: string[];
};
