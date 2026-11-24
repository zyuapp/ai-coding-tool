/**
 * Puts text on the system clipboard, with an HTML form beside it for apps that paste rich text.
 * Reports whether it landed, so a caller can stay quiet if not.
 */
export async function copyText(text: string, html?: string): Promise<boolean> {
  try {
    if (html === undefined) await navigator.clipboard.writeText(text);
    else {
      await navigator.clipboard.write([new ClipboardItem({
        "text/plain": new Blob([text], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      })]);
    }
    return true;
  } catch {
    return false;
  }
}
