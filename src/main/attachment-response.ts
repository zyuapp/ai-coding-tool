import path from "node:path";
import { pathToFileURL } from "node:url";
import { computerOfThread } from "../application/computers.js";
import type { WorkspaceState } from "../application/workspace-state.js";
import type { ComputerQuery } from "../contracts/computers.js";
import { MAX_ATTACHMENT_ENCODED_BYTES } from "../domain/conversation.js";
import { attachmentsDirectory, isSavedAttachmentName } from "./attachment-store.js";

type AttachmentResponseHost = {
  state: () => WorkspaceState;
  query: (id: string, query: ComputerQuery) => Promise<unknown>;
  fetch: (url: string) => Promise<Response>;
};

/** Resolve from the addressed thread, so selecting another thread cannot change an open image. */
export async function attachmentResponse(source: string, host: AttachmentResponseHost): Promise<Response> {
  try {
    const url = new URL(source);
    const name = decodeURIComponent(url.pathname.slice(1));
    if (!isSavedAttachmentName(name)) return new Response("Not found", { status: 404 });
    const computer = computerOfThread(host.state(), url.searchParams.get("taskId") ?? undefined);
    if (!computer) return await host.fetch(pathToFileURL(path.join(attachmentsDirectory(), name)).toString());
    const data = await host.query(computer.id, { kind: "attachment", name });
    if (typeof data !== "string" || data.length === 0 || data.length > MAX_ATTACHMENT_ENCODED_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error("Invalid attachment bytes.");
    return new Response(Buffer.from(data, "base64"), { headers: { "Content-Type": "image/png" } });
  } catch {
    return new Response("Attachment is unavailable", { status: 404 });
  }
}
