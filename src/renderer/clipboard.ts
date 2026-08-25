/** Puts text on the system clipboard. Reports whether it landed, so a caller can stay quiet if not. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
