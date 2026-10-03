import type { ComputerReads } from "./computer-queries.js";

/** Retain the holder's original once, for both previews and the full-size viewer. */
export async function messageImageResponse(source: string, reads: Pick<ComputerReads, "read">): Promise<Response> {
  try {
    const params = new URL(source).searchParams;
    const query = { kind: "message-image", path: params.get("path") ?? "", root: params.get("root") ?? "", message: params.get("message") ?? "", thumbnail: params.get("thumbnail") === "1" } as const;
    const { bytes, contentType } = await reads.read(query, { thread: params.get("taskId") ?? undefined });
    return new Response(bytes, { headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch {
    return new Response("Image unavailable", { status: 404 });
  }
}
