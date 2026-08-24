/**
 * How wide the sidebar and the right panel are drawn. Each is stored as the width the user dragged
 * it to; what fits is worked out here, against the window and against each other. Storing the ask
 * rather than the fit is what lets a panel sized while the sidebar was away keep that width when
 * the sidebar comes back, instead of being clipped to whatever fitted at the time.
 */

/** The room the transcript keeps for itself between the sidebar and the right panel. */
export const TRANSCRIPT_ROOM = 320;

export const SIDEBAR_MIN = 220;
export const DOCK_MIN = 320;

/** Under this the window cannot hold the sidebar open beside the workspace, so the sidebar floats. */
export const FLOATING_WINDOW = 900;

/** Under this the sidebar opens narrower, since a wide one would leave the conversation too little. */
const NARROW_WINDOW = 1100;

/** What the user has dragged, and the shape the window is in. A null width means the app's own. */
export type PanelRoom = {
  windowWidth: number;
  sidebarOpen: boolean;
  dockExpanded: boolean;
  sidebarWidth: number | null;
  dockWidth: number | null;
};

/**
 * The two widths to draw, in px, whether the sidebar lies over the workspace, and the widest the
 * panel may be dragged to — which leaves the conversation its room, where being drawn only has to
 * stay inside the window.
 */
export type PanelLayout = { sidebar: number; dock: number; floating: boolean; dockLimit: number };

export function defaultSidebarWidth(windowWidth: number): number {
  return windowWidth < NARROW_WINDOW ? 240 : 280;
}

export function defaultDockWidth(windowWidth: number): number {
  return Math.min(620, Math.max(380, Math.round(windowWidth * 0.4)));
}

/** The sidebar never takes more than half the window, whatever it was dragged to. */
export function fittedSidebarWidth(windowWidth: number, width: number): number {
  return Math.round(Math.min(Math.max(width, SIDEBAR_MIN), Math.max(SIDEBAR_MIN, windowWidth / 2)));
}

/** An expanded panel owns the window, so the sidebar lies over it instead of taking its room. */
export function sidebarFloats(windowWidth: number, dockExpanded: boolean): boolean {
  return dockExpanded || windowWidth < FLOATING_WINDOW;
}

/** A width to store: rounded, never under the panel's own minimum, and refused if it is not a number. */
export function storedWidth(min: number, value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(min, Math.round(value));
}

/**
 * The panel is drawn at the width it was dragged to, and gives up only what will not fit beside the
 * sidebar. Holding it to the room beside the sidebar is what stops it being pushed off the right
 * edge, with its own contents, when the sidebar opens. Dragging keeps the tighter limit of the two,
 * so a panel is never dragged over the conversation's own room in the first place.
 */
export function panelLayout(room: PanelRoom): PanelLayout {
  const floating = sidebarFloats(room.windowWidth, room.dockExpanded);
  const sidebar = fittedSidebarWidth(room.windowWidth, room.sidebarWidth ?? defaultSidebarWidth(room.windowWidth));
  const beside = room.windowWidth - (room.sidebarOpen && !floating ? sidebar : 0);
  const asked = Math.round(room.dockWidth ?? defaultDockWidth(room.windowWidth));
  return {
    sidebar,
    dock: Math.min(asked, beside),
    floating,
    dockLimit: Math.round(Math.min(Math.max(DOCK_MIN, beside - TRANSCRIPT_ROOM), beside)),
  };
}
