import type { ComputerReads } from "./computer-queries.js";

/** Resolve from the addressed thread, so selecting another thread cannot change an open image. */
export async function attachmentResponse(source: string, reads: Pick<ComputerReads, "read">): Promise<Response> {
  try {
    const url = new URL(source);
    const name = decodeURIComponent(url.pathname.slice(1));
    const bytes = await reads.read({ kind: "attachment", name }, { thread: url.searchParams.get("taskId") ?? undefined });
    return new Response(bytes, { headers: { "Content-Type": "image/png" } });
  } catch {
    return new Response("Attachment is unavailable", { status: 404 });
  }
}
