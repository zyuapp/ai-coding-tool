/**
 * Where one pane of real glass goes, in the window's own points from its top left, and how round
 * its corners are. A clear pane shows what is behind it almost as it is; the others frost it, which
 * is what a list of words needs.
 */
export type GlassRegion = { x: number; y: number; width: number; height: number; radius: number; clear: boolean };

/** How many panes of glass one window may ask for. */
const MAX_GLASS_REGIONS = 32;

export function isGlassRegions(value: unknown): value is GlassRegion[] {
  return Array.isArray(value) && value.length <= MAX_GLASS_REGIONS && value.every((region: unknown) => {
    if (!region || typeof region !== "object") return false;
    const { x, y, width, height, radius, clear } = region as Record<string, unknown>;
    return typeof clear === "boolean" && [x, y, width, height, radius].every((field) => typeof field === "number" && Number.isFinite(field)) && (width as number) >= 0 && (height as number) >= 0 && (radius as number) >= 0;
  });
}
