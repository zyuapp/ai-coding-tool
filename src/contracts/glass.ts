/** Where one pane of the platform's glass goes, in the page's own pixels from its top left, and how round its corners are. */
export type GlassRegion = { x: number; y: number; width: number; height: number; radius: number };

/** How many panes of glass one window may ask for. */
const MAX_GLASS_REGIONS = 32;

export function isGlassRegions(value: unknown): value is GlassRegion[] {
  return Array.isArray(value) && value.length <= MAX_GLASS_REGIONS && value.every((region: unknown) => {
    if (!region || typeof region !== "object") return false;
    const { x, y, width, height, radius } = region as Record<string, unknown>;
    return [x, y, width, height, radius].every((field) => typeof field === "number" && Number.isFinite(field)) && (width as number) >= 0 && (height as number) >= 0 && (radius as number) >= 0;
  });
}
