import { isNameableFont } from "../domain/typography";

/** What Chromium reports for one installed face, of which only the family interests the picker. */
type LocalFont = { family: string };

type FontHost = { queryLocalFonts?: () => Promise<LocalFont[]> };

export function canReadInstalledFonts(): boolean {
  return typeof (window as FontHost).queryLocalFonts === "function";
}

/**
 * The families installed on this machine, one entry per family rather than per face. Reading them
 * needs both a gesture and the user's consent, so a refusal is answered with an empty list and the
 * picker simply keeps offering the families the app bundles.
 */
export async function readInstalledFonts(): Promise<string[]> {
  const query = (window as FontHost).queryLocalFonts;
  if (!query) return [];
  try {
    const faces = await query();
    const families = new Set(faces.map((face) => face.family).filter(isNameableFont));
    return [...families].sort((first, second) => first.localeCompare(second));
  } catch {
    return [];
  }
}
